//! Agent team board: a shared, pull-only board per relay team — notes (`agent board
//! post|read|teams|clear`) and tasks (`agent task …`: add, claim, block, done, review,
//! retry, dependencies, history). A team is the root tab of a relay chain plus all its
//! descendants; the team id is the root tab id (resolved by the frontend,
//! src/terminal/agentBoard.ts, which also decides who the caller is and whether it is the
//! team's root tab). Nothing here ever types into a tab.
//!
//! Layout:
//! - `model`: limits, text cleaning, request types, actors and the task state machine
//!   (engine independent); `common`: the task row, its JSON and the input checks both
//!   engines share;
//! - `store`: `BoardStore`, the one async interface every operation goes through;
//! - `sqlite`: the SQLite engine (all SQL for it), file `~/.config/octo/agent-board[.dev].db`;
//! - `pg`: the PostgreSQL engine (all SQL for it), tables in a configured schema;
//! - `config`: usage type (`agents.board.mode`), connection settings, password file,
//!   redaction; `copy`: "Copy data" between the engines; `admin`: the Settings commands.
//!
//! This file holds the board's Tauri commands (no SQL here), the store selection (re-read
//! from config.json, the environment and the password file on every command, so a change in
//! Settings takes effect for the next command) and the per-process facts every write records:
//! this machine's host name and this app instance's id (random per start; leases and
//! auto-release are scoped by it).
//! Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md

pub mod admin;
pub mod common;
pub mod config;
pub mod copy;
pub mod model;
pub mod pg;
pub mod sqlite;
pub mod store;
pub mod sync;
#[cfg(test)]
mod tests;

pub use model::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
pub use store::BoardStore;

pub const DB_FILE: &str = if cfg!(debug_assertions) { "agent-board.dev.db" } else { "agent-board.db" };

/// `~/.config/octo` (directory of `config_file_path()`).
fn config_dir() -> Result<PathBuf, String> {
    let config = crate::config_file_path().map_err(unavailable)?;
    Ok(config.parent().ok_or_else(|| unavailable("no config directory"))?.to_path_buf())
}

/// `~/.config/octo/agent-board[.dev].db`.
fn db_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DB_FILE))
}

/// `~/.config/octo/agent-board[.dev].secret` (the PostgreSQL password, 0600).
fn secret_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(config::SECRET_FILE))
}

/// This app instance: random per start, kept in memory only.
pub fn instance_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("i{}-{:08x}", now_ms(), rand::random::<u32>()))
}

/// This machine's stable host id (`*_host`, `origin_host`, `home_host`): `BBARIT_BOARD_HOST`
/// when set, else the machine name from Settings (`agents.board.hostName`, stage 3b), else the
/// host name (model::host_id). The setting is re-read at most every 2 s.
pub fn board_host() -> String {
    if let Some(env) = env_host() {
        return host_id(Some(&env), &raw_host_name_cached());
    }
    static CACHE: Mutex<Option<(std::time::Instant, Option<String>)>> = Mutex::new(None);
    let setting = {
        let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some((at, v)) if at.elapsed() < std::time::Duration::from_secs(2) => v.clone(),
            _ => {
                let v = setting_host();
                *guard = Some((std::time::Instant::now(), v.clone()));
                v
            }
        }
    };
    host_id(setting.as_deref(), &raw_host_name_cached())
}

/// `BBARIT_BOARD_HOST`, when set.
pub fn env_host() -> Option<String> {
    std::env::var("BBARIT_BOARD_HOST").ok().filter(|v| !v.trim().is_empty())
}

/// `agents.enabled` (Settings → "Agent team in tabs", src/terminal/agentTeamSwitch.ts): only an
/// explicit `false` is off; missing or any other value is on (old config files).
pub fn agents_enabled_in(cfg: Option<&Value>) -> bool {
    cfg.and_then(|c| c.get("agents")).and_then(|a| a.get("enabled")).and_then(Value::as_bool) != Some(false)
}

/// `agents.enabled` from config.json, re-read on every call (the switch takes effect at once).
pub fn agents_enabled() -> bool {
    agents_enabled_in(crate::read_octo_config_json().as_ref())
}

/// Default `agents.leadPhrase` (Settings → "Lead agent phrase", src/terminal/agentTeamSwitch.ts).
pub const DEFAULT_LEAD_PHRASE: &str = "리드 에이전트로 진행해줘";
/// Always accepted next to the configured phrase (English default).
pub const ENGLISH_LEAD_PHRASE: &str = "proceed as the lead agent";

/// Trim and collapse whitespace; `None` unless one line of 2–60 characters without control or
/// format characters (the same rule as `normalizeLeadPhrase` in agentTeamSwitch.ts).
pub fn normalize_lead_phrase(raw: &str) -> Option<String> {
    if raw.chars().any(|c| c.is_control() || is_format_char(c)) {
        return None;
    }
    let v = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (2..=60).contains(&v.chars().count()).then_some(v)
}

/// `agents.leadPhrase`, or the default when missing or invalid.
pub fn lead_phrase_in(cfg: Option<&Value>) -> String {
    cfg.and_then(|c| c.get("agents"))
        .and_then(|a| a.get("leadPhrase"))
        .and_then(Value::as_str)
        .and_then(normalize_lead_phrase)
        .unwrap_or_else(|| DEFAULT_LEAD_PHRASE.to_string())
}

/// What `GET /api/agent-lead` answers for the UserPromptSubmit hook: nothing while the agent
/// team is off, else the configured and the English phrase, one per line, in the form the hook
/// compares against the raw JSON prompt: whitespace collapsed, ASCII lower-cased, `\` and `"`
/// JSON-escaped.
pub fn lead_hook_phrases(cfg: Option<&Value>) -> Vec<String> {
    if !agents_enabled_in(cfg) {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for p in [lead_phrase_in(cfg), ENGLISH_LEAD_PHRASE.to_string()] {
        let v = p.to_ascii_lowercase().replace('\\', "\\\\").replace('"', "\\\"");
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

/// `agents.board.hostName` from config.json, when set.
fn setting_host() -> Option<String> {
    let cfg = crate::read_octo_config_json()?;
    let v = cfg.get("agents")?.get("board")?.get("hostName")?.as_str()?.trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// The name this machine would have without an override or setting.
pub fn system_host() -> String {
    host_id(None, &raw_host_name_cached())
}

/// Where the machine name comes from: env | setting | system.
pub fn host_source() -> &'static str {
    if env_host().is_some() {
        "env"
    } else if setting_host().is_some() {
        "setting"
    } else {
        "system"
    }
}

fn raw_host_name_cached() -> String {
    static RAW: OnceLock<String> = OnceLock::new();
    RAW.get_or_init(raw_host_name).clone()
}

#[cfg(unix)]
fn raw_host_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: gethostname writes at most buf.len() bytes into the buffer we own.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(not(unix))]
fn raw_host_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

fn ctx() -> Ctx {
    Ctx { now: now_ms(), host: Some(board_host()), instance: instance_id().to_string() }
}

/// What config.json (`agents.board`), the environment and the password file say right now.
pub struct Selection {
    pub mode: config::ModeChoice,
    pub settings: config::PgSettings,
    pub env_url: Option<String>,
    pub password: Option<config::Secret>,
}

pub fn read_selection() -> Selection {
    let cfg = crate::read_octo_config_json();
    let board = cfg.as_ref().and_then(|c| c.get("agents")).and_then(|a| a.get("board"));
    Selection {
        mode: config::parse_mode(board),
        settings: config::PgSettings::from_board(board),
        env_url: crate::get_env_value(config::URL_ENV).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        password: secret_path().ok().and_then(|p| config::read_secret(&p)),
    }
}

impl Selection {
    /// The engine commands use: PostgreSQL only in `postgres` mode (`sync` reads and writes the
    /// local file; the sync worker exchanges it with the server, sync.rs).
    pub fn uses_postgres(&self) -> bool {
        self.mode.mode == config::BoardMode::Postgres
    }

    pub fn pg_target(&self) -> Result<config::PgTarget, String> {
        config::pg_target(&self.settings, self.env_url.as_deref(), self.password.as_ref())
    }

    /// Identifies the store this selection needs (never shown; secrets only as a hash).
    fn key(&self) -> Result<String, String> {
        if !self.uses_postgres() {
            return Ok(format!("sqlite:{}", db_path()?.display()));
        }
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&self.env_url, self.password.as_ref().map(|p| (&p.password, &p.label))).hash(&mut h);
        Ok(format!("pg:{}:{:x}", serde_json::to_string(&self.settings).unwrap_or_default(), h.finish()))
    }
}

/// The selected store, created on first use and replaced when the selection changes (the
/// SQLite file is opened lazily; the PostgreSQL pool connects on first use). When PostgreSQL
/// is selected but not configured, board commands fail with "team board unavailable: …";
/// there is never a silent fallback to SQLite.
pub fn current_store() -> Result<Arc<BoardStore>, String> {
    static STORE: Mutex<Option<(String, Arc<BoardStore>)>> = Mutex::new(None);
    let sel = read_selection();
    let key = sel.key()?;
    let mut guard = STORE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((k, s)) = guard.as_ref() {
        if *k == key {
            return Ok(s.clone());
        }
    }
    let store = if sel.uses_postgres() {
        Arc::new(BoardStore::Pg(pg::PgStore::new(sel.pg_target().map_err(unavailable)?)))
    } else {
        Arc::new(BoardStore::Sqlite(sqlite::SqliteStore::new(db_path()?)))
    };
    *guard = Some((key, store.clone()));
    Ok(store)
}

/// The last "team board unavailable" error a board command returned (Settings status line).
static LAST_ERROR: Mutex<Option<(i64, String)>> = Mutex::new(None);

pub fn last_error() -> Option<(i64, String)> {
    LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn track<T>(r: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &r {
        if e.starts_with("team board unavailable") {
            *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms(), e.clone()));
        }
    }
    r
}

/// App start: drop teams idle for 30 days — on the local SQLite file only (a shared
/// PostgreSQL board is cleaned only from Settings). Never creates the database.
pub fn prune_on_start() {
    if read_selection().uses_postgres() {
        return;
    }
    let Ok(path) = db_path() else { return };
    if !path.exists() {
        return;
    }
    if let Ok(store) = current_store() {
        let _ = tauri::async_runtime::block_on(store.prune_stale(now_ms(), STALE_AFTER_MS));
    }
}

// ── Commands (notes) ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn agent_board_post(team: String, post: PostInput) -> Result<Value, String> {
    let sync_mode = read_selection().mode.mode == config::BoardMode::Sync;
    let res = track(
        async {
            let store = current_store()?;
            match &*store {
                // Stage 3c: in sync mode a note for another computer's team is queued for its
                // home (a remote note) instead of refused.
                BoardStore::Sqlite(s) if sync_mode => {
                    let (team, c) = (team.trim().to_string(), ctx());
                    s.run(move |conn, l| sqlite::post_or_queue(conn, l, &team, &post, &c)).await
                }
                _ => store.post(team.trim().to_string(), post, ctx()).await,
            }
        }
        .await,
    )?;
    sync::note_local_write();
    Ok(res)
}

#[tauri::command]
pub async fn agent_board_read(team: String, query: Option<ReadQuery>) -> Result<Value, String> {
    track(async { current_store()?.read(team.trim().to_string(), query.unwrap_or_default(), Some(board_host().to_string())).await }.await)
}

/// Never creates the SQLite file: with no board file there are no teams (the Team status view
/// and its badges list teams before anything else, and must not leave a file behind).
#[tauri::command]
pub async fn agent_board_teams() -> Result<Vec<Value>, String> {
    if !read_selection().uses_postgres() && !db_path()?.exists() {
        return Ok(Vec::new());
    }
    track(async { current_store()?.teams().await }.await)
}

#[tauri::command]
pub async fn agent_board_clear(team: String) -> Result<Value, String> {
    let res = track(async { current_store()?.clear(team.trim().to_string(), ctx()).await }.await)?;
    sync::note_local_write();
    Ok(res)
}

/// This instance id, host name and backend (the App plans leases with them).
#[tauri::command]
pub async fn agent_board_info() -> Result<Value, String> {
    let store = track(current_store())?;
    Ok(json!({
        "instance": instance_id(),
        "host": board_host(),
        "backend": store.backend(),
        "mode": read_selection().mode.mode.as_str(),
        "schemaVersion": store.schema_version(),
    }))
}

// ── Lease worker (runs in the host, not the webview) ────────────────────

/// Set once a claim/unblock/adopt went through this instance; the worker touches the
/// database only while it is set (idle otherwise) and clears it when nothing is held.
static HOLDING: AtomicBool = AtomicBool::new(false);
/// The app is exiting (quit, update handover): the worker stops before PTYs look dead.
static EXITING: AtomicBool = AtomicBool::new(false);
static PTY: OnceLock<Arc<dyn crate::pty_backend::PtyBackend>> = OnceLock::new();
static PTY_READY: OnceLock<Box<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();

pub fn note_holding() {
    HOLDING.store(true, Ordering::SeqCst);
}

/// Called first thing on RunEvent::Exit and on the update relaunch.
pub fn mark_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

pub fn exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

fn pty_ready() -> bool {
    PTY_READY.get().is_some_and(|f| f())
}

fn pty_alive(id: &str) -> bool {
    PTY.get().is_some_and(|p| p.alive(id))
}

/// Relay audit-log lines for tasks the app handed back (`owner`, no caller).
fn audit_released(released: &Value, event: &str, reason: &str) {
    for r in released.get("released").and_then(Value::as_array).into_iter().flatten() {
        crate::agent_relay_log::agent_relay_log_append(json!({
            "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "event": event,
            "team": r.get("team"),
            "task": r.get("seq"),
            "from": r.get("from"),
            "to": "open",
            "owner": r.get("ownerId"),
            "reason": reason,
            "by": "app",
        }));
    }
}

/// One worker tick: renew the leases of this instance's tasks whose owner tab has a live
/// PTY (the PTY backend in this process knows that, also while the webview is reloading,
/// hidden or occluded), release those whose PTY is gone. A failed release keeps the holder
/// listed, so the next tick tries again and never renews it.
async fn lease_worker_tick(lease_ms: i64) -> Result<(), String> {
    let store = current_store()?;
    let instance = instance_id().to_string();
    let holders = store.lease_holders(instance.clone()).await?;
    if holders.is_empty() {
        HOLDING.store(false, Ordering::SeqCst);
        return Ok(());
    }
    let plan = plan_lease_tick(&holders, EXITING.load(Ordering::SeqCst), pty_ready(), pty_alive);
    if !plan.renew.is_empty() {
        store.lease_tick(instance.clone(), plan.renew, now_ms(), lease_ms).await?;
    }
    let mut failed = None;
    for owner in plan.release {
        if EXITING.load(Ordering::SeqCst) {
            break;
        }
        let reason = "owner tab is gone".to_string();
        match store.release_owner(instance.clone(), owner, now_ms(), Some(board_host().to_string()), reason.clone()).await {
            Ok(v) => audit_released(&v, "task_auto_release", &reason),
            Err(e) => failed = Some(e),
        }
    }
    failed.map_or(Ok(()), Err)
}

/// Start the lease worker (app setup). `ready`: the PTY backend has been chosen. Timing comes
/// from `agents.board` in config.json on every tick. No overlap (one loop), backs off on
/// failure below half the lease, stops when the app exits.
pub fn start_lease_worker(
    pty: Arc<dyn crate::pty_backend::PtyBackend>,
    ready: Box<dyn Fn() -> bool + Send + Sync>,
    timing: fn() -> (i64, i64),
) {
    let _ = PTY.set(pty);
    let _ = PTY_READY.set(ready);
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            let (lease, renew) = timing();
            tokio::time::sleep(std::time::Duration::from_millis(next_tick_delay(renew, lease, failures) as u64)).await;
            if EXITING.load(Ordering::SeqCst) {
                break;
            }
            if !HOLDING.load(Ordering::SeqCst) {
                failures = 0;
                continue;
            }
            match lease_worker_tick(lease).await {
                Ok(()) => failures = 0,
                Err(_) => failures = failures.saturating_add(1),
            }
        }
    });
}

// ── Commands (tasks) ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn agent_task_write(team: String, actor: ActorInput, op: TaskOpInput) -> Result<Value, String> {
    let c = ctx();
    let actor = Actor::from_input(&actor, c.host.as_deref())?;
    let res = track(async { current_store()?.task_write(team.trim().to_string(), op, actor, c).await }.await)?;
    if matches!(res["task"]["state"].as_str(), Some("claimed" | "blocked")) {
        note_holding();
    }
    sync::note_local_write();
    Ok(res)
}

#[tauri::command]
pub async fn agent_task_list(team: String, query: Option<TaskListQuery>) -> Result<Value, String> {
    track(async { current_store()?.task_list(team.trim().to_string(), query.unwrap_or_default(), ctx()).await }.await)
}

#[tauri::command]
pub async fn agent_task_show(team: String, task: i64, history: Option<bool>, stale_ms: Option<i64>) -> Result<Value, String> {
    track(async { current_store()?.task_show(team.trim().to_string(), task, history.unwrap_or(false), stale_ms, ctx()).await }.await)
}

/// Team status view (a person in the app): the newest task events of every task of a team.
/// A viewer command, not an `agent.*` UI command, so `bbarit-ctl` cannot reach it.
#[tauri::command]
pub async fn agent_board_team_events(team: String, query: Option<EventsQuery>) -> Result<Value, String> {
    track(async { current_store()?.team_events(team.trim().to_string(), query.unwrap_or_default(), Some(board_host().to_string())).await }.await)
}

/// A tab closed: hand back what it holds through this instance — only when its PTY is really
/// gone (a still-running PTY is left to the lease worker) and never while the app exits.
#[tauri::command]
pub async fn agent_task_release_owner(owner_id: String, reason: Option<String>) -> Result<Value, String> {
    if !HOLDING.load(Ordering::SeqCst) || EXITING.load(Ordering::SeqCst) || !pty_ready() || pty_alive(&owner_id) {
        return Ok(json!({ "released": [] }));
    }
    let reason = clean_label(reason.as_deref(), 200).unwrap_or_else(|| "owner tab closed".to_string());
    let res = track(
        async {
            current_store()?
                .release_owner(instance_id().to_string(), owner_id, now_ms(), Some(board_host().to_string()), reason.clone())
                .await
        }
        .await,
    )?;
    audit_released(&res, "task_auto_release", &reason);
    Ok(res)
}

/// Tasks held by tabs on this machine (any instance), for the startup decision. Never
/// creates the database (an app start must not leave a board file behind).
#[tauri::command]
pub async fn agent_task_held_on_host() -> Result<Vec<Value>, String> {
    if !read_selection().uses_postgres() && !db_path()?.exists() {
        return Ok(Vec::new());
    }
    track(async { current_store()?.held_on_host(board_host().to_string()).await }.await)
}

#[tauri::command]
pub async fn agent_task_lease_apply(adopt: Vec<LeaseItem>, release: Vec<LeaseItem>, lease_ms: Option<i64>) -> Result<Value, String> {
    let res = track(
        async {
            current_store()?
        .lease_apply(
            instance_id().to_string(),
            adopt,
            release,
            now_ms(),
            model::lease_ms(lease_ms),
            Some(board_host().to_string()),
        )
        .await
        }
        .await,
    )?;
    if res["adopted"].as_u64().unwrap_or(0) > 0 {
        note_holding();
    }
    audit_released(&res, "task_auto_release", "owner tab did not come back after the app restarted");
    Ok(res)
}
