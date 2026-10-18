//! SurrealDB embedded database shared by KV store, skills, learning, and scrum state.
//!
//! Uses RocksDB backend for file-based persistence at ~/.config/octo/bbarit.db
//! (legacy stores named orchestra.db are migrated automatically on startup).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use surrealdb::engine::local::{Db, RocksDb};
use surrealdb::Surreal;
use tokio::sync::OnceCell;

static DB: OnceCell<Arc<Surreal<Db>>> = OnceCell::const_new();

// Dev (debug) and the installed (release) build must NOT share one orchestra DB directory:
// SurrealDB takes an exclusive LOCK on it, so a `tauri:dev` launch would steal the lock from
// a running installed app (or vice-versa) and crash it. Split the data dir by build profile —
// same split as the mcp-bridge dev/installed port (debug_assertions). Dev gets fresh state.
#[cfg(debug_assertions)]
const APP_DATA_DIR: &str = "octo-dev";
#[cfg(not(debug_assertions))]
const APP_DATA_DIR: &str = "octo";

// Orchestra 기능 제거(2026-07) 후에도 이 저장소는 KV/스킬/학습/스크럼 상태의 원본이다.
// 디렉토리명만 bbarit.db로 바꾸고, 저장소 내부 namespace/db 이름("octo"/"orchestra")은
// 데이터 호환을 위해 그대로 둔다 — 바꾸면 기존 레코드가 전부 고아가 된다.
const DB_FILE_NAME: &str = "bbarit.db";
const LEGACY_DB_FILE_NAME: &str = "orchestra.db";

/// 같은 디렉토리의 구버전 orchestra.db를 bbarit.db로 자동 이관 (동일 볼륨 rename = 원자적).
/// 새 경로가 이미 있으면 절대 건드리지 않는다.
fn migrate_legacy_db(db_path: &Path) {
    if db_path.exists() {
        return;
    }
    let Some(parent) = db_path.parent() else {
        return;
    };
    let legacy = parent.join(LEGACY_DB_FILE_NAME);
    if !legacy.exists() {
        return;
    }
    match std::fs::rename(&legacy, db_path) {
        Ok(()) => safe_eprintln!(
            "[db] migrated legacy store {} -> {}",
            legacy.display(),
            db_path.display()
        ),
        Err(e) => safe_eprintln!(
            "[db] legacy store migration failed ({} -> {}): {e}",
            legacy.display(),
            db_path.display()
        ),
    }
}

fn candidate_db_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut paths = Vec::new();

        if let Ok(base) = std::env::var("LOCALAPPDATA") {
            if !base.trim().is_empty() {
                paths.push(PathBuf::from(base).join(APP_DATA_DIR).join(DB_FILE_NAME));
            }
        }
        if let Ok(base) = std::env::var("APPDATA") {
            if !base.trim().is_empty() {
                paths.push(PathBuf::from(base).join(APP_DATA_DIR).join(DB_FILE_NAME));
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            if !home.trim().is_empty() {
                paths.push(
                    PathBuf::from(home)
                        .join(".config")
                        .join(APP_DATA_DIR)
                        .join(DB_FILE_NAME),
                );
            }
        }

        if paths.is_empty() {
            if let Some(home) = dirs::home_dir() {
                paths.push(home.join(".config").join(APP_DATA_DIR).join(DB_FILE_NAME));
            }
        }
        return paths;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        vec![PathBuf::from(home)
            .join(".config")
            .join(APP_DATA_DIR)
            .join(DB_FILE_NAME)]
    }
}

fn prepare_db_path(db_path: &Path) -> Result<(), String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config dir {}: {e}", parent.display()))?;
    }

    // RocksDB expects a directory path. If a regular file exists at the target
    // path (for example from an older/broken install), move it aside so startup
    // can continue instead of crashing during first open.
    if let Ok(meta) = std::fs::metadata(db_path) {
        if meta.is_file() {
            let backup = db_path.with_extension("db.bak");
            let _ = std::fs::remove_file(&backup);
            std::fs::rename(db_path, &backup).map_err(|e| {
                format!(
                    "Failed to move conflicting DB file {} to {}: {e}",
                    db_path.display(),
                    backup.display()
                )
            })?;
        }
    }

    Ok(())
}

// A corrupt RocksDB store (e.g. MANIFEST references a missing SST after a hard crash or
// force-quit) cannot be opened or repaired in place. Moving it aside lets startup recreate a
// fresh store instead of leaving the app permanently stuck on "Database is unavailable".
//
// D8(2026-07-04): the backup name is timestamped. The old fixed ".corrupt.bak" name meant a
// SECOND corrupt reset ran remove_dir_all on the FIRST backup — destroying the only surviving
// copy of the user's data (the fresh post-reset store is the one that corrupts next, so the
// first backup is exactly the one that matters). Old backups are pruned, keeping the newest 3.
fn corrupt_backup_path(db_path: &Path) -> PathBuf {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut backup = db_path.as_os_str().to_owned();
    backup.push(format!(".corrupt-{ts}.bak"));
    PathBuf::from(backup)
}

// Keep only the newest `keep` corrupt backups for this store (epoch-stamped names sort
// lexically). Never touches anything but `<db>.corrupt-*.bak` siblings.
fn prune_corrupt_backups(db_path: &Path, keep: usize) {
    let (Some(parent), Some(name)) = (db_path.parent(), db_path.file_name()) else {
        return;
    };
    let prefix = format!("{}.corrupt-", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy();
                    n.starts_with(&prefix) && n.ends_with(".bak")
                })
                .unwrap_or(false)
        })
        .collect();
    backups.sort();
    while backups.len() > keep {
        let oldest = backups.remove(0);
        safe_eprintln!("[db] pruning old corrupt backup: {}", oldest.display());
        let _ = std::fs::remove_dir_all(&oldest);
    }
}

fn dir_size_bytes(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += dir_size_bytes(&p);
        } else if let Ok(m) = entry.metadata() {
            total += m.len();
        }
    }
    total
}

// D11(2026-07-05): DB 아티팩트 자동 청소 — "너무 크면 올드 DB 지우기".
// init 성공 직후 별도 스레드에서 호출된다(부팅 크리티컬 패스 밖). 규칙:
// 1) corrupt 백업 총량 2GB 초과 시 오래된 것부터 삭제. 단 **최신 1개는 절대
//    보존** — 백업이 리셋 전 데이터의 유일한 원본이던 사고 전례(de0cc51) 때문.
// 2) legacy(orchestra.db)는 같은 폴더의 현 DB가 방금 정상 오픈됐고, 30일 이상
//    미변경 + 100MB 초과일 때만 삭제. (구버전 설치본이 아직 live로 쓰는
//    orchestra.db는 mtime이 최신이라 절대 걸리지 않는다.)
// 3) RocksDB 진단 로그(LOG.old.*)는 최신 2개만 유지.
fn auto_prune_db_artifacts(db_path: &Path) {
    // 1) corrupt 백업 총량 캡
    const BACKUP_TOTAL_CAP: u64 = 2 * 1024 * 1024 * 1024;
    if let (Some(parent), Some(name)) = (db_path.parent(), db_path.file_name()) {
        let prefix = format!("{}.corrupt-", name.to_string_lossy());
        if let Ok(entries) = std::fs::read_dir(parent) {
            let mut backups: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| {
                            let n = n.to_string_lossy();
                            n.starts_with(&prefix) && n.ends_with(".bak")
                        })
                        .unwrap_or(false)
                })
                .collect();
            backups.sort(); // epoch 이름이라 사전순 = 시간순
            let mut total: u64 = backups.iter().map(|p| dir_size_bytes(p)).sum();
            while total > BACKUP_TOTAL_CAP && backups.len() > 1 {
                let oldest = backups.remove(0);
                let sz = dir_size_bytes(&oldest);
                safe_eprintln!(
                    "[db] backups over cap ({:.1}GB), pruning oldest: {}",
                    total as f64 / 1e9,
                    oldest.display()
                );
                let _ = std::fs::remove_dir_all(&oldest);
                total = total.saturating_sub(sz);
            }
        }
    }

    // 2) 오래되고 큰 legacy DB 삭제 (현 DB가 정상 오픈된 폴더에 한정)
    const LEGACY_SIZE_MIN: u64 = 100 * 1024 * 1024;
    const LEGACY_AGE_MIN: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
    if let Some(parent) = db_path.parent() {
        let legacy = parent.join(LEGACY_DB_FILE_NAME);
        if legacy.exists() && legacy != db_path {
            let old_enough = std::fs::metadata(&legacy)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|age| age > LEGACY_AGE_MIN)
                .unwrap_or(false);
            let size = dir_size_bytes(&legacy);
            if old_enough && size > LEGACY_SIZE_MIN {
                safe_eprintln!(
                    "[db] deleting stale legacy DB ({:.0}MB, 30d+ untouched): {}",
                    size as f64 / 1e6,
                    legacy.display()
                );
                let _ = std::fs::remove_dir_all(&legacy);
                let _ = std::fs::remove_file(&legacy);
            }
        }
    }

    // 3) RocksDB LOG.old.* 최신 2개만 유지
    if let Ok(entries) = std::fs::read_dir(db_path) {
        let mut old_logs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("LOG.old."))
                    .unwrap_or(false)
            })
            .collect();
        old_logs.sort();
        while old_logs.len() > 2 {
            let oldest = old_logs.remove(0);
            let _ = std::fs::remove_file(&oldest);
        }
    }
}

// D12(2026-07-05): 중요도 기반 DB 자동관리 — "디비 중요도를 따져서".
// 등급(테이블 인벤토리 전수 실측 기준):
//   Tier 0 불가침 — kv_store(설정·프로젝트 전체), skills_my(사용자 스킬),
//     learning_skill/learning_memory(증류된 학습 자산), session/signal/scrum_state
//     (용도 불명확 → 보수적으로 보존). 어떤 경우에도 자동삭제하지 않는다.
//   Tier 1 누적 이력 — learning_trajectory/learning_session(원시 궤적),
//     scrum_history. 90일 이전 것만 삭제 (created_at = epoch ms).
//   Tier 2 캐시/잔재 — skills_gallery/skills_pack(외부 재크롤 가능),
//     convoy/squid/mail/hook/tracked_task(octotown 모듈 삭제로 접근 코드가 없는
//     죽은 데이터, 전수 grep 확인). 통삭제 허용.
// 트리거: DB 디렉토리 크기가 캡(기본 1GB, BBARIT_DB_SIZE_CAP_MB로 조절)을 넘을
// 때만. Tier 2 → Tier 1 순서로 낮은 중요도부터 지운다. RocksDB 특성상 디스크
// 회수는 이후 컴팩션 때 일어난다. 탈출구: BBARIT_DB_SIZE_CAP_MB=0 이면 비활성.
async fn prune_by_importance(db: &Surreal<Db>, db_path: &Path) {
    let cap_mb: u64 = std::env::var("BBARIT_DB_SIZE_CAP_MB")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(1024);
    if cap_mb == 0 {
        return;
    }
    let size = dir_size_bytes(db_path);
    if size <= cap_mb * 1024 * 1024 {
        return;
    }
    safe_eprintln!(
        "[db] store {:.0}MB > cap {}MB — importance-tiered prune (Tier2 cache → Tier1 history)",
        size as f64 / 1e6,
        cap_mb
    );
    // Tier 2: 재생성 가능한 캐시 + 죽은 잔재 테이블 통삭제
    for table in ["skills_gallery", "skills_pack", "convoy", "squid", "mail", "hook", "tracked_task"] {
        match db.query(format!("DELETE `{table}`;")).await {
            Ok(_) => safe_eprintln!("[db] pruned tier-2 table: {table}"),
            Err(e) => safe_eprintln!("[db] tier-2 prune failed for {table}: {e}"),
        }
    }
    // Tier 1: 90일 이전 원시 이력만 (created_at = epoch ms; 필드가 없으면 0건 매칭)
    let cutoff_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        - 90 * 24 * 3600 * 1000;
    for table in ["learning_trajectory", "learning_session", "scrum_history"] {
        match db
            .query(format!("DELETE `{table}` WHERE created_at < {cutoff_ms};"))
            .await
        {
            Ok(_) => safe_eprintln!("[db] pruned tier-1 history >90d: {table}"),
            Err(e) => safe_eprintln!("[db] tier-1 prune failed for {table}: {e}"),
        }
    }
}

async fn open_db_at_path(db_path: &Path) -> Result<Surreal<Db>, String> {
    migrate_legacy_db(db_path);
    prepare_db_path(db_path)?;

    match Surreal::new::<RocksDb>(db_path).await {
        Ok(db) => Ok(db),
        Err(e) => {
            let err_msg = format!("{e}");
            if err_msg.contains("LOCK")
                || err_msg.contains("Resource temporarily unavailable")
                || err_msg.contains("lock hold by current process")
            {
                // D10(2026-07-05): LOCK 에러의 대부분은 "이전 인스턴스가 아직 죽는 중"인
                // 재시작 겹침이다(dev 워처 재시작 실측). 이때 LOCK을 즉시 지우면
                // ①살아있는 프로세스와 이중 쓰기(진짜 손상 위험) ②재열기도 어차피
                // 파일 핸들 점유로 실패한다. 그래서 먼저 기다리며 재시도하고,
                // 지속 실패(=죽은 프로세스가 남긴 stale LOCK)일 때만 삭제한다.
                for attempt in 1..=10u32 {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    match Surreal::new::<RocksDb>(db_path).await {
                        Ok(db) => {
                            safe_eprintln!("[db] DB lock released, opened on retry #{attempt}");
                            return Ok(db);
                        }
                        Err(e2) => {
                            let m = format!("{e2}");
                            if !(m.contains("LOCK")
                                || m.contains("Resource temporarily unavailable")
                                || m.contains("lock hold by current process"))
                            {
                                return Err(format!("SurrealDB init failed during lock retry: {e2}"));
                            }
                        }
                    }
                }
                // 10초간 계속 잠김 = 보유자가 없는 stale LOCK으로 판단 (기존 탈출구 유지).
                let lock_path = db_path.join("LOCK");
                safe_eprintln!(
                    "[db] DB still locked after retries, removing stale LOCK file: {}",
                    lock_path.display()
                );
                let _ = std::fs::remove_file(&lock_path);
                Surreal::new::<RocksDb>(db_path)
                    .await
                    .map_err(|e2| format!("SurrealDB init failed after LOCK removal: {e2}"))
            } else if err_msg.contains("Corruption") || err_msg.contains("corrupted") {
                // Store is corrupt and unrecoverable in place — move it aside and start
                // fresh. NOTE: this is a silent full reset from the user's point of view
                // (localStorage was emptied by the KV migration long ago, so nothing
                // re-migrates); the timestamped backup is the only surviving copy.
                let backup = corrupt_backup_path(db_path);
                safe_eprintln!(
                    "[db] DB corrupt, moving aside to {} and recreating: {}",
                    backup.display(),
                    err_msg
                );
                std::fs::rename(db_path, &backup).map_err(|e2| {
                    format!(
                        "Failed to move corrupt DB {} to {}: {e2}",
                        db_path.display(),
                        backup.display()
                    )
                })?;
                prune_corrupt_backups(db_path, 3);
                prepare_db_path(db_path)?;
                Surreal::new::<RocksDb>(db_path)
                    .await
                    .map_err(|e2| format!("SurrealDB init failed after corrupt reset: {e2}"))
            } else {
                Err(format!("SurrealDB init failed: {e}"))
            }
        }
    }
}

/// Initialize the embedded SurrealDB instance.
/// Called once during Tauri setup.
/// If the LOCK file is stale (held by a dead process), it is removed and retried.
pub async fn init_db() -> Result<Arc<Surreal<Db>>, String> {
    if let Some(existing) = DB.get() {
        return Ok(existing.clone());
    }

    // D10: 동시 초기화 직렬화 — auto-init(부팅)과 lazy init(skills_db 등)이 겹치면
    // 둘 다 RocksDB를 열려고 해 한쪽이 LOCK 에러를 맞는다. 한 번에 하나만 연다.
    static INIT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = INIT_LOCK.lock().await;
    if let Some(existing) = DB.get() {
        return Ok(existing.clone());
    }

    let candidates = candidate_db_paths();
    let mut last_err: Option<String> = None;
    let mut opened_at: Option<PathBuf> = None;
    let mut db_opt: Option<Surreal<Db>> = None;

    for db_path in &candidates {
        match open_db_at_path(db_path).await {
            Ok(db) => {
                opened_at = Some(db_path.clone());
                db_opt = Some(db);
                break;
            }
            Err(e) => {
                safe_eprintln!("[db] DB open failed at {}: {}", db_path.display(), e);
                last_err = Some(format!("{}: {}", db_path.display(), e));
            }
        }
    }

    let db = db_opt.ok_or_else(|| {
        last_err
            .unwrap_or_else(|| "SurrealDB init failed: no candidate DB path succeeded".to_string())
    })?;

    db.use_ns("octo")
        .use_db("orchestra")
        .await
        .map_err(|e| format!("SurrealDB namespace setup failed: {e}"))?;

    // Define schema
    setup_schema(&db).await?;

    let arc = Arc::new(db);
    let _ = DB.set(arc.clone());

    if let Some(path) = opened_at {
        safe_eprintln!("[db] SurrealDB initialized at {}", path.display());
        // D11: 파일 수준 하우스키핑(백업 총량 캡·legacy 청소·로그 정리) — 별도 스레드.
        let housekeeping_path = path.clone();
        std::thread::spawn(move || auto_prune_db_artifacts(&housekeeping_path));
        // D12: 데이터 수준 중요도 프루닝 — 캡 초과 시 Tier2→Tier1 순서로.
        let prune_db = arc.clone();
        tokio::spawn(async move {
            prune_by_importance(&prune_db, &path).await;
        });
    }
    Ok(arc)
}

/// Get a reference to the global DB instance.
pub fn get_db() -> Result<Arc<Surreal<Db>>, String> {
    DB.get()
        .cloned()
        .ok_or_else(|| "SurrealDB not initialized".to_string())
}

/// Wait (bounded) for the global DB instance to finish initializing.
///
/// D7(2026-07-04): init_db runs in a background task at app setup, so early
/// invocations (the frontend reads `octo-terminal-projects` right at boot) used
/// to get an instant "not initialized" error. The frontend then fell back to
/// localStorage — which the KV migration had already emptied — so a cold boot
/// rendered blank settings and the next autosave overwrote the real DB data
/// ("설치하면 설정이 다 날아가요"). Callers that can tolerate boot latency
/// should wait here instead of failing fast. Trade-off: if init failed
/// permanently, each caller burns up to `max_ms` before erroring (the frontend
/// timeout still bounds user-visible latency). Rollback: call get_db() directly.
pub async fn wait_db(max_ms: u64) -> Result<Arc<Surreal<Db>>, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(max_ms);
    loop {
        if let Some(db) = DB.get() {
            return Ok(db.clone());
        }
        if std::time::Instant::now() >= deadline {
            return Err("SurrealDB not initialized".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

async fn setup_schema(db: &Surreal<Db>) -> Result<(), String> {
    db.query(
        r#"
        -- Agent (squid/octopus)
        DEFINE TABLE IF NOT EXISTS squid SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS name ON squid TYPE string;
        DEFINE FIELD IF NOT EXISTS rig ON squid TYPE string;
        DEFINE FIELD IF NOT EXISTS state ON squid TYPE string;
        DEFINE FIELD IF NOT EXISTS terminal_id ON squid TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS assigned_task ON squid TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS cli_type ON squid TYPE string;
        DEFINE FIELD IF NOT EXISTS created_at ON squid TYPE string;
        DEFINE INDEX IF NOT EXISTS idx_squid_name ON squid FIELDS name UNIQUE;

        -- Convoy (task bundle)
        DEFINE TABLE IF NOT EXISTS convoy SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS title ON convoy TYPE string;
        DEFINE FIELD IF NOT EXISTS status ON convoy TYPE string;
        DEFINE FIELD IF NOT EXISTS owner ON convoy TYPE string;
        DEFINE FIELD IF NOT EXISTS created_at ON convoy TYPE string;
        DEFINE FIELD IF NOT EXISTS closed_at ON convoy TYPE option<string>;

        -- Tracked task (within a convoy)
        DEFINE TABLE IF NOT EXISTS tracked_task SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS convoy_id ON tracked_task TYPE string;
        DEFINE FIELD IF NOT EXISTS task_id ON tracked_task TYPE string;
        DEFINE FIELD IF NOT EXISTS title ON tracked_task TYPE string;
        DEFINE FIELD IF NOT EXISTS status ON tracked_task TYPE string;
        DEFINE FIELD IF NOT EXISTS assignee ON tracked_task TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS objective ON tracked_task TYPE string;
        DEFINE FIELD IF NOT EXISTS deliverable ON tracked_task TYPE string;

        -- Mail message
        DEFINE TABLE IF NOT EXISTS mail SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS from_agent ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS to_agent ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS subject ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS body ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS msg_type ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS priority ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS timestamp ON mail TYPE string;
        DEFINE FIELD IF NOT EXISTS read ON mail TYPE bool;

        -- Hook (task assignment)
        DEFINE TABLE IF NOT EXISTS hook SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS task_id ON hook TYPE string;
        DEFINE FIELD IF NOT EXISTS assignee ON hook TYPE string;
        DEFINE FIELD IF NOT EXISTS status ON hook TYPE string;
        DEFINE FIELD IF NOT EXISTS hooked_at ON hook TYPE string;

        -- Signal
        DEFINE TABLE IF NOT EXISTS signal SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS target ON signal TYPE string;
        DEFINE FIELD IF NOT EXISTS signal_type ON signal TYPE string;
        DEFINE FIELD IF NOT EXISTS payload ON signal TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS created_at ON signal TYPE string;
        DEFINE FIELD IF NOT EXISTS consumed ON signal TYPE bool;

        -- Session (for restore after restart)
        DEFINE TABLE IF NOT EXISTS session SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS convoy_id ON session TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS phase ON session TYPE string;
        DEFINE FIELD IF NOT EXISTS squid_setups ON session TYPE string;
        DEFINE FIELD IF NOT EXISTS started_at ON session TYPE string;

        -- Scrum history
        DEFINE TABLE IF NOT EXISTS scrum_history SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS project_id ON scrum_history TYPE string;
        DEFINE FIELD IF NOT EXISTS project_name ON scrum_history TYPE string;
        DEFINE FIELD IF NOT EXISTS sprint_goal ON scrum_history TYPE string;
        DEFINE FIELD IF NOT EXISTS mode ON scrum_history TYPE string;
        DEFINE FIELD IF NOT EXISTS created_at ON scrum_history TYPE string;
        DEFINE FIELD IF NOT EXISTS plan_json ON scrum_history TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS run_log ON scrum_history TYPE option<string>;

        -- Scrum per-project state
        DEFINE TABLE IF NOT EXISTS scrum_state SCHEMAFULL;
        DEFINE FIELD IF NOT EXISTS project_id ON scrum_state TYPE string;
        DEFINE FIELD IF NOT EXISTS state_json ON scrum_state TYPE string;
        DEFINE FIELD IF NOT EXISTS updated_at ON scrum_state TYPE string;
        DEFINE INDEX IF NOT EXISTS idx_scrum_state_project ON scrum_state FIELDS project_id UNIQUE;
        "#,
    )
    .await
    .map_err(|e| format!("Schema setup failed: {e}"))?;

    Ok(())
}

/// Shared ISO 8601 timestamp helper (no chrono dependency).
pub fn now_iso8601() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0) {
            366
        } else {
            365
        };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
    let days_in_months: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m = 0usize;
    for (i, &dm) in days_in_months.iter().enumerate() {
        if remaining_days < dm {
            m = i;
            break;
        }
        remaining_days -= dm;
    }
    let d = remaining_days + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m + 1,
        d,
        hours,
        minutes,
        seconds
    )
}
