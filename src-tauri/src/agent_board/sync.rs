//! Stage 3b: the `sync` usage type — the local SQLite file stays the board every command reads
//! and writes (so everything works offline), and a host worker exchanges rows with a shared
//! PostgreSQL. Each team has one home machine (the one that created it); only the home writes
//! its rows, every other machine keeps a read-only copy (a "mirror"; the UI says "other
//! machines' teams"). Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md,
//! "Usage types and sync".
//!
//! - Push: `changes` after `pushed_seq` (≤ 500 rows, distinct), rows of teams homed here, one
//!   server transaction (parents before children, upsert guarded by `row_version`), then
//!   `pushed_seq` moves and the covered change rows go. Idempotent: a crash before the local
//!   step only re-sends rows the guard ignores. First enable, re-enable and a backlog over
//!   50 000 rows send a full snapshot of the home teams instead (in batches).
//! - Pull: rows of teams homed elsewhere with `pulled_seq < server_seq ≤ watermark`, checked
//!   like local input (bad rows are skipped and counted), written without `log_change`, posts
//!   get a local read position. The watermark is read under the server_seq lock taken
//!   exclusively, while every writer (pushes and direct `postgres`-mode writes) holds it shared
//!   from drawing a number until commit (pg.rs `v3_sql`), so a row that commits late with a
//!   lower number is never skipped.
//! - Machine identity: `board_meta.instance_id` (UUID) of the local file, registered in the
//!   server's `hosts` on the first sync; a name held by another instance pauses sync.
//!
//! All SQL lives in sqlite.rs / pg.rs (sections "Sync"); this file holds the rules, the round,
//! the worker and the Settings commands (not `agent.*` commands).

use super::config::BoardMode;
use super::copy::{self, Cell, Cols, Kind};
use super::model::*;
use super::pg::PgStore;
use super::sqlite::SqliteStore;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

/// Rows per push batch / per table per pull round.
pub const SYNC_BATCH: i64 = 500;
/// Batches per round at most (the next round continues).
const MAX_BATCHES: usize = 40;
/// At most this many teams from other machines are kept; the least recently active go.
pub const MAX_MIRROR_TEAMS: i64 = 200;
/// Regular round interval; a local write asks for a round this much later.
pub const SYNC_INTERVAL_MS: i64 = 30_000;
pub const WRITE_DELAY_MS: i64 = 2_000;

/// Posts as sync exchanges them: `arrival` is each board's own read order, never sent.
pub const POSTS_SYNC: Cols = &[
    ("id", Kind::Text), ("team_uid", Kind::Text), ("seq", Kind::Int), ("ts", Kind::Int), ("author_id", Kind::Text),
    ("author_name", Kind::Text), ("author_cli", Kind::Text), ("author_host", Kind::Text), ("kind", Kind::Text),
    ("text", Kind::Text), ("task_id", Kind::Text), ("origin_host", Kind::Text), ("updated_at", Kind::Int),
    ("row_version", Kind::Int), ("deleted_at", Kind::Int),
];

/// Synced tables, parents before children.
pub const SYNC_TABLES: [(&str, Cols); 5] =
    [("teams", copy::TEAMS), ("tasks", copy::TASKS), ("posts", POSTS_SYNC), ("task_deps", copy::DEPS), ("task_events", copy::EVENTS)];

/// The local file's sync facts at the start of a round.
#[derive(Debug, Clone, Default)]
pub struct LocalState {
    pub instance: String,
    pub full_push: bool,
    pub waiting: i64,
    pub pulled_seq: i64,
    pub skipped: i64,
    /// Sync must wait for a person: (code, message).
    pub pause: Option<(&'static str, String)>,
    /// `name_changed`: the name this file's teams carry.
    pub old_name: Option<String>,
}

/// What one pull batch did locally.
#[derive(Debug, Clone, Default)]
pub struct PullApplied {
    pub written: usize,
    pub skipped: usize,
    pub dropped: usize,
    /// Root tab ids of the teams that changed (views refresh them).
    pub teams: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RoundReport {
    pub pushed: u64,
    pub refused: u64,
    pub pulled: usize,
    pub skipped: usize,
    pub teams: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    /// The server cannot be reached or failed (retried with backoff).
    Offline(String),
    /// Writers held the server_seq lock for 3 s; the pull is tried again soon.
    Busy,
    /// Needs a person: (code, message). Codes: name_taken, name_changed, no_tables,
    /// server_newer, server_older, local, settings.
    Paused(&'static str, String),
}

impl SyncError {
    pub fn message(&self) -> &str {
        match self {
            SyncError::Offline(m) | SyncError::Paused(_, m) => m,
            SyncError::Busy => "the server is busy with other writes; trying again shortly",
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            SyncError::Offline(_) => "offline",
            SyncError::Busy => "busy",
            SyncError::Paused(c, _) => c,
        }
    }
}

// ── Rules (pure) ─────────────────────────────────────────────────────────

pub fn collision_message(host: &str) -> String {
    format!("another computer uses the name {host}; set this computer's name in Settings")
}

/// Why sync must wait for the server's tables (None: they match this app).
pub fn schema_pause(stored: Option<i64>, code: i64) -> Option<(&'static str, String)> {
    match stored {
        None => Some(("no_tables", "the server has no board tables yet: press Create / upgrade tables in Settings".to_string())),
        Some(v) if v > code => {
            Some(("server_newer", format!("the server's board tables are from a newer app version ({v}, this app knows {code}): update the app")))
        }
        Some(v) if v < code => Some((
            "server_older",
            format!("the server's board tables are at version {v}, this app needs {code}: press Create / upgrade tables in Settings"),
        )),
        Some(_) => None,
    }
}

/// Delay before the next round: the interval after a success, 5 s doubling to 5 min after
/// failures.
pub fn backoff_ms(failures: u32) -> i64 {
    if failures == 0 {
        return SYNC_INTERVAL_MS;
    }
    let exp = (failures - 1).min(10);
    (5_000i64 << exp).min(300_000)
}

/// Where the pull cursor may move after one batch read up to `upto`: below the last row of any
/// table that hit the batch limit (its next rows are still to come), else `upto`.
pub fn next_pull_cursor(upto: i64, stats: &[(usize, Option<i64>)], limit: usize) -> i64 {
    stats.iter().filter(|(n, _)| *n >= limit).filter_map(|(_, last)| *last).fold(upto, i64::min)
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// A one-line value exactly as local input would store it (`clean_label` leaves it unchanged:
/// no control or format characters, single spaces, trimmed) and at most `max` characters.
fn is_label(s: &str, max: usize) -> bool {
    s.chars().count() <= max && clean_label(Some(s), usize::MAX).as_deref() == Some(s)
}

/// Multi-line text exactly as `clean_multiline` would store it (limits included).
fn is_block(s: &str, max_chars: usize, max_lines: usize) -> bool {
    clean_multiline(s, "text", max_chars, max_lines).as_deref() == Ok(s)
}

/// Byte caps on the JSON columns (local input stays far below them).
pub const MAX_LABELS_BYTES: usize = 2 * 1024;
pub const MAX_META_BYTES: usize = 16 * 1024;
pub const MAX_ARTIFACTS_BYTES: usize = 32 * 1024;
pub const MAX_EVENT_DATA_BYTES: usize = 16 * 1024;

fn labels_ok(raw: &str) -> bool {
    if raw.len() > MAX_LABELS_BYTES {
        return false;
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else { return false };
    let mut seen = std::collections::HashSet::new();
    items.len() <= MAX_LABELS
        && items.iter().all(|v| v.as_str().is_some_and(|l| is_label(l, MAX_LABEL_CHARS) && seen.insert(l.to_string())))
}

fn artifacts_ok(raw: &str) -> bool {
    if raw.len() > MAX_ARTIFACTS_BYTES {
        return false;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(m)) => {
            m.len() <= MAX_ARTIFACTS
                && m.iter().all(|(k, v)| is_label(k, MAX_ARTIFACT_KEY_CHARS) && v.as_str().is_some_and(|v| v.chars().count() <= MAX_ARTIFACT_VALUE_CHARS && !v.chars().any(|c| c.is_control() || is_format_char(c))))
        }
        Ok(Value::Array(a)) => a.is_empty(),
        _ => false,
    }
}

fn json_ok(raw: &str, max_bytes: usize, want: fn(&Value) -> bool) -> bool {
    raw.len() <= max_bytes && serde_json::from_str::<Value>(raw).is_ok_and(|v| want(&v))
}

/// A pulled row checked like local input: shapes, ids, state names, the same text rules and
/// limits as the commands (`clean_label` / `clean_multiline` leave the value unchanged), JSON
/// shapes and byte caps. Rows that fail are skipped and counted, never written.
pub fn validate_row(table: &str, cols: Cols, row: &[Cell]) -> Result<(), &'static str> {
    if row.len() != cols.len() {
        return Err("wrong number of columns");
    }
    for (cell, (_, kind)) in row.iter().zip(cols.iter()) {
        if matches!((cell, kind), (Cell::Int(_), Kind::Text) | (Cell::Text(_), Kind::Int)) {
            return Err("wrong column type");
        }
    }
    let get = |n: &str| &row[copy::col_index(cols, n)];
    let text = |n: &str| get(n).text();
    let int = |n: &str| get(n).int();
    let id = |n: &str| text(n).is_some_and(is_uuid);
    let opt_id = |n: &str| text(n).is_none_or(is_uuid);
    let line = |n: &str, max: usize| text(n).is_none_or(|s| is_label(s, max));
    let block = |n: &str, max: usize, lines: usize| text(n).is_none_or(|s| is_block(s, max, lines));
    if int("row_version").is_none_or(|v| v < 1) || int("updated_at").is_none_or(|v| v < 0) || int("deleted_at").is_some_and(|v| v < 0) {
        return Err("bad version or time");
    }
    if !line("origin_host", 120) {
        return Err("bad origin host");
    }
    // Ids of tabs and actors: one line of at most 256 characters (Actor::from_input).
    const ID: usize = 256;
    let ok = match table {
        "teams" => {
            id("uid")
                && text("team").is_some_and(|t| check_team(t).is_ok())
                && line("name", MAX_NAME_CHARS)
                && text("home_host").is_some_and(|h| is_label(h, 120))
                && line("home_instance", ID)
                && int("last_post_seq").is_some_and(|v| v >= 0)
                && int("last_task_seq").is_some_and(|v| v >= 0)
        }
        "posts" => {
            id("id")
                && id("team_uid")
                && opt_id("task_id")
                && int("seq").is_some_and(|v| v >= 1)
                && text("kind").is_some_and(|k| POST_KINDS.contains(&k))
                && text("text").is_some_and(|t| is_block(t, MAX_TEXT_CHARS, MAX_TEXT_LINES))
                && line("author_id", ID)
                && line("author_name", MAX_NAME_CHARS)
                && line("author_cli", 40)
                && line("author_host", 120)
        }
        "tasks" => {
            id("id")
                && id("team_uid")
                && opt_id("parent_id")
                && int("seq").is_some_and(|v| v >= 1)
                && text("title").is_some_and(|t| is_label(t, MAX_TITLE_CHARS))
                && block("body", MAX_BODY_CHARS, MAX_BODY_LINES)
                && text("state").is_some_and(|s| TASK_STATES.contains(&s))
                && int("priority").is_some_and(|p| (0..=MAX_PRIORITY).contains(&p))
                && int("needs_review").is_some_and(|v| v == 0 || v == 1)
                && int("attempt").is_some_and(|v| v >= 0)
                && int("max_attempts").is_some_and(|v| (0..=MAX_MAX_ATTEMPTS).contains(&v))
                && text("result_checks").is_none_or(|c| CHECKS.contains(&c))
                // Reasons may carry a short prefix ("rejected: …").
                && block("blocked_reason", MAX_REASON_CHARS + 20, MAX_TEXT_LINES)
                && block("last_error", MAX_REASON_CHARS + 20, MAX_TEXT_LINES)
                && line("result_summary", MAX_SUMMARY_CHARS)
                && block("result_body", MAX_BODY_CHARS, MAX_BODY_LINES)
                && line("result_branch", MAX_BRANCH_CHARS)
                && line("result_commit", MAX_COMMIT_CHARS)
                && line("result_worktree", MAX_WORKTREE_CHARS)
                && ["created_by_id", "owner_id", "owner_instance"].iter().all(|n| line(n, ID))
                && ["created_by_name", "owner_name"].iter().all(|n| line(n, MAX_NAME_CHARS))
                && ["created_by_host", "owner_host"].iter().all(|n| line(n, 120))
                && text("labels").is_some_and(labels_ok)
                && text("meta").is_some_and(|m| json_ok(m, MAX_META_BYTES, Value::is_object))
                && text("result_artifacts").is_none_or(artifacts_ok)
        }
        "task_deps" => id("task_id") && id("depends_on_id") && id("team_uid") && text("task_id") != text("depends_on_id"),
        "task_events" => {
            id("id")
                && id("task_id")
                && id("team_uid")
                && int("seq").is_some_and(|v| v >= 0)
                && text("action").is_some_and(|a| !a.is_empty() && a.len() <= 32 && a.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
                && text("from_state").is_none_or(|s| TASK_STATES.contains(&s))
                && text("to_state").is_none_or(|s| TASK_STATES.contains(&s))
                && block("note", MAX_BODY_CHARS, MAX_BODY_LINES)
                && line("actor_id", ID)
                && line("actor_name", MAX_NAME_CHARS)
                && line("actor_host", 120)
                && text("data").is_none_or(|d| json_ok(d, MAX_EVENT_DATA_BYTES, |v| v.is_object() || v.is_null()))
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err("invalid row")
    }
}

// ── One round ────────────────────────────────────────────────────────────

/// One sync round between the local file and the server, as machine `host`: check the server's
/// tables and this machine's name, push (full snapshot when due), then pull up to the
/// watermark. Never touches rows of teams homed here on the pull side.
pub async fn sync_round(
    local: &SqliteStore,
    server: &PgStore,
    server_id: &str,
    host: &str,
    machine: Option<&str>,
    now: i64,
) -> Result<RoundReport, SyncError> {
    let local_err = |e: String| SyncError::Paused("local", format!("the board file on this computer: {e}"));
    let (sid, h0, m0) = (server_id.to_string(), host.to_string(), machine.map(str::to_string));
    let st = local.run(move |c, l| super::sqlite::sync_prepare(c, l, &sid, &h0, m0.as_deref(), now)).await.map_err(local_err)?;
    if let Some((code, msg)) = st.pause.clone() {
        return Err(SyncError::Paused(code, msg));
    }
    let stored = server.stored_schema_version().await.map_err(SyncError::Offline)?;
    if let Some((code, m)) = schema_pause(stored, super::pg::SCHEMA_VERSION) {
        return Err(SyncError::Paused(code, m));
    }
    if server.sync_register(host, &st.instance, now).await.map_err(SyncError::Offline)?.is_some() {
        return Err(SyncError::Paused("name_taken", collision_message(host)));
    }
    let mut report = RoundReport::default();
    let mut full_done = !st.full_push;
    if st.full_push {
        for _ in 0..MAX_BATCHES {
            let h = host.to_string();
            let (next, rows) = local.run(move |c, _| super::sqlite::sync_full_batch(c, &h, SYNC_BATCH)).await.map_err(local_err)?;
            let o = server.sync_push(host, &st.instance, &rows, now).await.map_err(SyncError::Offline)?;
            note_refused(local, &mut report, o).await.map_err(local_err)?;
            let n = next.clone();
            local.run(move |c, _| super::sqlite::sync_full_done(c, n.as_deref())).await.map_err(local_err)?;
            if next.is_none() {
                full_done = true;
                break;
            }
        }
    }
    if full_done {
        for _ in 0..MAX_BATCHES {
            let h = host.to_string();
            let Some((upto, rows)) = local.run(move |c, _| super::sqlite::sync_push_batch(c, &h, SYNC_BATCH)).await.map_err(local_err)? else {
                break;
            };
            let o = server.sync_push(host, &st.instance, &rows, now).await.map_err(SyncError::Offline)?;
            note_refused(local, &mut report, o).await.map_err(local_err)?;
            local.run(move |c, _| super::sqlite::sync_push_done(c, upto)).await.map_err(local_err)?;
        }
        local.run(move |c, _| super::sqlite::sync_mark_caught_up(c, now)).await.map_err(local_err)?;
    }
    note(|s| s.last_push_at = Some(now));
    let upto = server.sync_watermark().await.map_err(SyncError::Offline)?.ok_or(SyncError::Busy)?;
    let mut after = st.pulled_seq;
    for _ in 0..MAX_BATCHES {
        if after >= upto {
            break;
        }
        let (rows, stats) = server.sync_pull(host, after, upto, SYNC_BATCH).await.map_err(SyncError::Offline)?;
        let cursor = next_pull_cursor(upto, &stats, SYNC_BATCH as usize);
        let h = host.to_string();
        let applied = local.run(move |c, l| super::sqlite::sync_apply_pull(c, l, &h, &rows, cursor, now)).await.map_err(local_err)?;
        report.pulled += applied.written;
        report.skipped += applied.skipped;
        report.teams.extend(applied.teams);
        if cursor <= after {
            break;
        }
        after = cursor;
    }
    note(|s| s.last_pull_at = Some(now));
    report.teams.sort();
    report.teams.dedup();
    Ok(report)
}

async fn note_refused(local: &SqliteStore, report: &mut RoundReport, o: super::pg::PushOutcome) -> Result<(), String> {
    report.pushed += o.written;
    report.refused += o.refused;
    if o.refused > 0 {
        let (n, reason) = (o.refused, o.reason);
        local.run(move |c, _| super::sqlite::sync_note_refused(c, n, reason.as_deref())).await?;
    }
    Ok(())
}

/// A hash of this computer's OS machine id (macOS IOPlatformUUID, Linux /etc/machine-id,
/// Windows MachineGuid), read once off the main thread; None when it cannot be read (then a
/// copied board file is not detected, as before).
pub fn machine_hash() -> Option<String> {
    static ID: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let raw = os_machine_id()?;
        let digest = Sha256::digest(format!("bbarit-board:{}", raw.trim()).as_bytes());
        Some(digest.iter().take(16).map(|b| format!("{b:02x}")).collect())
    })
    .clone()
}

fn os_machine_id() -> Option<String> {
    let run = |cmd: &str, args: &[&str]| -> Option<String> {
        let out = std::process::Command::new(cmd).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    let id = if cfg!(target_os = "macos") {
        let text = run("/usr/sbin/ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
        text.lines().find(|l| l.contains("IOPlatformUUID")).and_then(|l| l.split('"').nth(3)).map(str::to_string)
    } else if cfg!(windows) {
        let text = run("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])?;
        text.lines().find(|l| l.contains("MachineGuid")).and_then(|l| l.split_whitespace().last()).map(str::to_string)
    } else {
        std::fs::read_to_string("/etc/machine-id").or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id")).ok()
    };
    id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

// ── Status, worker, commands ─────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct Status {
    /// off | starting | on | paused | offline
    state: &'static str,
    last_push_at: Option<i64>,
    last_pull_at: Option<i64>,
    last_error: Option<String>,
    last_error_code: Option<&'static str>,
    last_error_at: Option<i64>,
    last_round_at: Option<i64>,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    state: "off",
    last_push_at: None,
    last_pull_at: None,
    last_error: None,
    last_error_code: None,
    last_error_at: None,
    last_round_at: None,
});

fn note(f: impl FnOnce(&mut Status)) {
    f(&mut STATUS.lock().unwrap_or_else(|e| e.into_inner()));
}

/// When a write-triggered round is due (ms; 0: none).
static DUE: AtomicI64 = AtomicI64::new(0);
/// One round at a time (worker and "Sync now").
static ROUND: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The server store sync uses, kept while its selection is unchanged.
static SERVER: Mutex<Option<(String, Arc<PgStore>)>> = Mutex::new(None);

/// A board command wrote to the local file: ask for a round 2 s later (the first write since
/// the last round sets the time; later ones do not push it out).
pub fn note_local_write() {
    let _ = DUE.compare_exchange(0, now_ms() + WRITE_DELAY_MS, Ordering::SeqCst, Ordering::SeqCst);
}

/// The server connection for the current settings: `server_id` (`label|schema`, stored in the
/// board file) names the server; the cache key also covers the password and the environment
/// URL (hashed), so a corrected password takes effect on the next round.
fn server_for(sel: &super::Selection) -> Result<(String, Arc<PgStore>), String> {
    let target = sel.pg_target()?;
    let server_id = format!("{}|{}", target.label, target.schema);
    let key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&sel.env_url, sel.password.as_ref().map(|p| (&p.password, &p.label))).hash(&mut h);
        format!("{server_id}|{:x}", h.finish())
    };
    let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((k, s)) = guard.as_ref() {
        if *k == key {
            return Ok((server_id, s.clone()));
        }
    }
    let store = Arc::new(PgStore::new(target));
    let old = guard.replace((key.clone(), store.clone()));
    drop(guard);
    if let Some((_, old)) = old {
        tauri::async_runtime::spawn(async move { old.close().await });
    }
    Ok((server_id, store))
}

async fn stop_server() {
    let old = SERVER.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((_, s)) = old {
        s.close().await;
    }
}

/// Run one round now with the current settings (no overlap with the worker).
async fn run_round(sel: &super::Selection) -> Result<RoundReport, SyncError> {
    let _one = ROUND.lock().await;
    let now = now_ms();
    let (server_id, server) =
        server_for(sel).map_err(|e| SyncError::Paused("settings", e.trim_start_matches("team board unavailable: ").to_string()))?;
    let store = super::current_store().map_err(|e| SyncError::Paused("local", e))?;
    let super::BoardStore::Sqlite(local) = &*store else {
        return Err(SyncError::Paused("local", "sync needs the board file on this computer".into()));
    };
    let machine = tauri::async_runtime::spawn_blocking(machine_hash).await.ok().flatten();
    note(|s| {
        if s.state == "off" {
            s.state = "starting";
        }
    });
    let host = super::board_host();
    let res = sync_round(local, &server, &server_id, &host, machine.as_deref(), now).await;
    note(|s| {
        s.last_round_at = Some(now);
        match &res {
            Ok(_) => {
                s.state = "on";
                s.last_error = None;
                s.last_error_code = None;
            }
            Err(e) => {
                s.state = match e {
                    SyncError::Paused(..) => "paused",
                    SyncError::Busy => "busy",
                    SyncError::Offline(_) => "offline",
                };
                s.last_error = Some(clean_message(e.message()));
                s.last_error_code = Some(e.code());
                s.last_error_at = Some(now);
            }
        }
    });
    res
}

/// Status and error text never carry a password or a URL (the store already redacts; this also
/// drops the generic prefix).
fn clean_message(m: &str) -> String {
    let m = m.trim_start_matches("team board unavailable: ");
    let sel = super::read_selection();
    let secrets: Vec<&str> = sel.password.as_ref().map(|p| p.password.as_str()).into_iter().chain(sel.env_url.as_deref()).collect();
    super::config::redact(m, &secrets)
}

/// Sync was turned off: release the change log for this file (mirrors stay).
async fn release_local() {
    let Ok(path) = super::db_path() else { return };
    if !path.exists() {
        return;
    }
    let store = SqliteStore::new(path);
    let _ = store.run(|c, _| super::sqlite::sync_release(c)).await;
}

/// The sync worker (app setup): a host task, never in the webview. Active only while the usage
/// type is `sync`: a round on start, every 30 s and 2 s after a local write; failures back off
/// 5 s → 5 min and never affect board commands. Stops on app exit; leaving `sync` closes the
/// server connection and releases the change log. Emits `octo-agent-board` for teams of other
/// machines that changed, so open views refresh.
pub fn start_sync_worker(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        let mut next_at = 0i64;
        // True at start: a file left in sync by an earlier run is released when sync is off now.
        let mut was_sync = true;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if super::exiting() {
                stop_server().await;
                break;
            }
            let now = now_ms();
            let due = DUE.load(Ordering::SeqCst);
            let write_due = due != 0 && due <= now && failures == 0;
            if now < next_at && !write_due {
                continue;
            }
            DUE.store(0, Ordering::SeqCst);
            let sel = super::read_selection();
            if sel.mode.mode != BoardMode::Sync {
                if was_sync {
                    stop_server().await;
                    release_local().await;
                    was_sync = false;
                }
                note(|s| s.state = "off");
                failures = 0;
                next_at = now + WRITE_DELAY_MS;
                continue;
            }
            was_sync = true;
            match run_round(&sel).await {
                Ok(r) => {
                    failures = 0;
                    for team in &r.teams {
                        let _ = app.emit("octo-agent-board", json!({ "team": team, "action": "sync" }));
                    }
                }
                Err(_) => failures = failures.saturating_add(1),
            }
            next_at = now_ms() + backoff_ms(failures);
        }
    });
}

/// Settings / Team status: the sync state of this Mac.
#[tauri::command]
pub async fn agent_board_sync_status() -> Result<Value, String> {
    let sel = super::read_selection();
    let st = STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mode = sel.mode.mode;
    let mut out = json!({
        "mode": mode.as_str(),
        "host": super::board_host(),
        "hostSource": super::host_source(),
        "state": if mode == BoardMode::Sync { if st.state == "off" { "starting" } else { st.state } } else { "off" },
        "lastPushAt": st.last_push_at,
        "lastPullAt": st.last_pull_at,
        "lastError": st.last_error,
        "lastErrorCode": st.last_error_code,
        "lastErrorAt": st.last_error_at,
        "lastRoundAt": st.last_round_at,
        "waiting": 0,
        "skipped": 0,
        "refused": 0,
        "refusedReason": null,
        "fullPush": false,
        "machines": [],
    });
    let path = super::db_path()?;
    if !sel.uses_postgres() && path.exists() {
        let local = SqliteStore::new(path).run(|c, _| super::sqlite::sync_status_local(c)).await?;
        for k in ["waiting", "skipped", "refused", "refusedReason", "fullPush", "machines"] {
            out[k] = local[k].clone();
        }
    }
    Ok(out)
}

/// Settings → "Sync now": one round right away; the result is the new status.
#[tauri::command]
pub async fn agent_board_sync_now() -> Result<Value, String> {
    let sel = super::read_selection();
    if sel.mode.mode != BoardMode::Sync {
        return Err("sync is off: choose \"Both (sync)\" first".into());
    }
    let res = run_round(&sel).await;
    let mut status = agent_board_sync_status().await?;
    status["ok"] = json!(res.is_ok());
    if let Ok(r) = res {
        status["pushed"] = json!(r.pushed);
        status["pulled"] = json!(r.pulled);
        status["refusedNow"] = json!(r.refused);
    }
    Ok(status)
}

/// Settings → "Remove other machines' teams": only the copies in this Mac's file go; the server
/// and the other machines keep them.
#[tauri::command]
pub async fn agent_board_remove_mirrors() -> Result<Value, String> {
    if super::read_selection().mode.mode == BoardMode::Sync {
        return Err(refusal("sync_on", json!({}), "turn sync off first (usage type \"SQLite only\"); while syncing, other computers' teams are kept up to date"));
    }
    let path = super::db_path()?;
    if !path.exists() {
        return Ok(json!({ "removed": 0 }));
    }
    let _one = ROUND.lock().await;
    let removed = match &*super::current_store()? {
        super::BoardStore::Sqlite(s) => s.run(|c, _| super::sqlite::sync_remove_mirrors(c)).await?,
        super::BoardStore::Pg(_) => SqliteStore::new(path).run(|c, _| super::sqlite::sync_remove_mirrors(c)).await?,
    };
    Ok(json!({ "removed": removed }))
}

/// Settings → "Machine name": may this Mac take `name`? Refused while `BBARIT_BOARD_HOST`
/// decides the name, and while live teams carry the current name as their home (they would be
/// left without one). The Settings page saves `agents.board.hostName` only after this said yes.
#[tauri::command]
pub async fn agent_board_check_host_name(name: String) -> Result<Value, String> {
    let wanted = name.trim();
    if super::env_host().is_some() {
        return Err(refusal("env_set", json!({}), "BBARIT_BOARD_HOST is set: it decides this computer's name"));
    }
    let clean = if wanted.is_empty() { None } else { clean_label(Some(wanted), 120) };
    if !wanted.is_empty() && (clean.as_deref() != Some(wanted) || wanted.chars().count() > 120) {
        return Err(refusal("invalid", json!({}), "use one line of at most 120 characters for the computer's name"));
    }
    let current = super::board_host();
    let next = clean.clone().unwrap_or_else(|| super::system_host());
    if next == current {
        return Ok(json!({ "ok": true, "host": next }));
    }
    let path = super::db_path()?;
    if path.exists() {
        let host = current.clone();
        let live = SqliteStore::new(path).run(move |c, _| super::sqlite::live_home_teams(c, &host)).await?;
        if live > 0 {
            return Err(refusal(
                "live_teams",
                json!({ "n": live, "name": current }),
                &format!("{live} team(s) on this computer are named for {current}; the name can change once they are gone (30 days without activity)"),
            ));
        }
    }
    Ok(json!({ "ok": true, "host": next }))
}

/// A refusal the Settings page translates: JSON `{ code, vars, message }` (message in English
/// for logs and other callers).
fn refusal(code: &str, vars: Value, message: &str) -> String {
    json!({ "code": code, "vars": vars, "message": message }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_from_five_seconds_to_five_minutes() {
        assert_eq!(backoff_ms(0), 30_000);
        assert_eq!(backoff_ms(1), 5_000);
        assert_eq!(backoff_ms(2), 10_000);
        assert_eq!(backoff_ms(7), 300_000);
        assert_eq!(backoff_ms(60), 300_000);
    }

    #[test]
    fn pull_cursor_stops_below_a_table_that_hit_the_limit() {
        assert_eq!(next_pull_cursor(100, &[(3, Some(40)), (0, None)], 500), 100);
        assert_eq!(next_pull_cursor(100, &[(500, Some(40)), (2, Some(90)), (500, Some(70))], 500), 40);
        assert_eq!(next_pull_cursor(100, &[], 500), 100);
    }

    #[test]
    fn schema_versions_pause_with_what_to_do() {
        assert!(schema_pause(None, 3).unwrap().1.contains("Create / upgrade tables"));
        assert_eq!(schema_pause(Some(4), 3).unwrap().0, "server_newer");
        assert!(schema_pause(Some(2), 3).unwrap().1.contains("version 2, this app needs 3"));
        assert_eq!(schema_pause(Some(3), 3), None);
        assert_eq!(collision_message("mac-a"), "another computer uses the name mac-a; set this computer's name in Settings");
        assert_eq!(read_only_message("mac-a"), "this team lives on mac-a; it is read-only here");
    }

    fn team_row(uid: &str, team: &str, home: &str) -> Vec<Cell> {
        let mut row = vec![Cell::Null; copy::TEAMS.len()];
        let set = |row: &mut Vec<Cell>, n: &str, c: Cell| row[copy::col_index(copy::TEAMS, n)] = c;
        set(&mut row, "uid", Cell::Text(uid.into()));
        set(&mut row, "team", Cell::Text(team.into()));
        set(&mut row, "home_host", Cell::Text(home.into()));
        for n in ["created_at", "last_post_seq", "last_task_seq", "last_activity_at", "updated_at"] {
            set(&mut row, n, Cell::Int(0));
        }
        set(&mut row, "row_version", Cell::Int(1));
        row
    }

    #[test]
    fn pulled_rows_are_checked_like_local_input() {
        let uid = "01900000-0000-7000-8000-000000000001";
        assert!(validate_row("teams", copy::TEAMS, &team_row(uid, "t1", "mac-a")).is_ok());
        assert!(validate_row("teams", copy::TEAMS, &team_row("not-a-uuid", "t1", "mac-a")).is_err());
        assert!(validate_row("teams", copy::TEAMS, &team_row(uid, "bad team id!", "mac-a")).is_err());
        assert!(validate_row("teams", copy::TEAMS, &team_row(uid, "t1", "")).is_err());
        assert!(validate_row("teams", copy::TEAMS, &team_row(uid, "t1", "mac\u{202E}a")).is_err());
        let mut wrong_type = team_row(uid, "t1", "mac-a");
        wrong_type[copy::col_index(copy::TEAMS, "row_version")] = Cell::Text("1".into());
        assert!(validate_row("teams", copy::TEAMS, &wrong_type).is_err());
        assert!(validate_row("teams", copy::TEAMS, &team_row(uid, "t1", "mac-a")[1..]).is_err());

        let mut post = vec![Cell::Null; POSTS_SYNC.len()];
        let set = |row: &mut Vec<Cell>, n: &str, c: Cell| row[copy::col_index(POSTS_SYNC, n)] = c;
        set(&mut post, "id", Cell::Text("01900000-0000-7000-8000-000000000002".into()));
        set(&mut post, "team_uid", Cell::Text(uid.into()));
        for n in ["seq", "ts", "updated_at", "row_version"] {
            set(&mut post, n, Cell::Int(1));
        }
        set(&mut post, "kind", Cell::Text("note".into()));
        set(&mut post, "text", Cell::Text("line one\nline two".into()));
        assert!(validate_row("posts", POSTS_SYNC, &post).is_ok());
        let mut bad = post.clone();
        set(&mut bad, "kind", Cell::Text("shout".into()));
        assert!(validate_row("posts", POSTS_SYNC, &bad).is_err());
        let mut bad = post.clone();
        set(&mut bad, "text", Cell::Text("x".repeat(MAX_BODY_CHARS + 1)));
        assert!(validate_row("posts", POSTS_SYNC, &bad).is_err());
        let mut bad = post.clone();
        set(&mut bad, "text", Cell::Text("bell\u{7}".into()));
        assert!(validate_row("posts", POSTS_SYNC, &bad).is_err());
    }
}
