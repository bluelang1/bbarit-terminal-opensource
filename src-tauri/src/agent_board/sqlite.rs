//! SQLite implementation of the team board store: every SQL statement for this engine lives
//! here. One connection behind a mutex, opened lazily; blocking work runs on the async
//! runtime's blocking pool, so async Tauri commands never stall the runtime.
//!
//! File `~/.config/octo/agent-board[.dev].db`, mode 0600 (db, -wal, -shm), WAL journal,
//! busy_timeout 5 s, every write in `BEGIN IMMEDIATE` (one statement claims a task; per-team
//! counters cannot repeat). Schema version lives in `board_meta` (and is mirrored to
//! `PRAGMA user_version` so a stage-1 app refuses a v2 file instead of failing on it).
//!
//! Sync groundwork (no sync worker yet): rows that a later sync would exchange (teams, posts,
//! tasks, task_deps, task_events) have UUIDv7 text ids, `origin_host`, `updated_at`,
//! `row_version` (+1 on every update) and a `deleted_at` tombstone — clear and pruning set it
//! instead of deleting, reads skip tombstones, and tombstones older than 30 days are removed
//! at app start. Every insert/update/tombstone of such a row appends to the local `changes`
//! log in the same transaction (`log_change`; every write ends in `finish`, which also keeps
//! the log bounded while nothing consumes it). A team is identified by `teams.uid`; its root
//! tab id (`team`) is unique together with `home_host`, the machine whose app owns the
//! team's numbers. `--new` cursors use local arrival order (`posts.arrival` = the local
//! change position of the post's insert), so rows that arrive later by sync are not skipped.
//! Schema reference: docs/AGENT_RELAY.md.

use super::model::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SCHEMA_VERSION: i64 = 2;

pub struct SqliteStore {
    path: PathBuf,
    conn: Arc<Mutex<Option<Connection>>>,
    limits: Limits,
}

impl SqliteStore {
    pub fn new(path: PathBuf) -> Self {
        Self::with_limits(path, Limits::default())
    }

    pub fn with_limits(path: PathBuf, limits: Limits) -> Self {
        SqliteStore { path, conn: Arc::new(Mutex::new(None)), limits }
    }

    /// Run `f` on the (lazily opened) connection on the blocking pool.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection, Limits) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let conn = self.conn.clone();
        let path = self.path.clone();
        let limits = self.limits;
        tauri::async_runtime::spawn_blocking(move || {
            let mut guard = conn.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(open_db(&path)?);
            }
            match guard.as_mut() {
                Some(c) => f(c, limits),
                None => Err(unavailable("not open")),
            }
        })
        .await
        .map_err(unavailable)?
    }
}

// ── Open / migrate ───────────────────────────────────────────────────────

/// Create the database file owner-only before SQLite opens it (SQLite gives its -wal/-shm
/// files the database's mode); tighten an existing wider file.
#[cfg(unix)]
fn prepare_db_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    match std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::metadata(path)?;
    if meta.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn prepare_db_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn tighten_sidecars(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    for suffix in ["-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        let p = PathBuf::from(p);
        if let Ok(meta) = std::fs::metadata(&p) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

#[cfg(not(unix))]
fn tighten_sidecars(_path: &Path) {}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |r| r.get(0))?;
    Ok(n > 0)
}

/// The schema version: the larger of `board_meta.schema_version` and `PRAGMA user_version`
/// (stage 1 kept it only in user_version).
fn stored_version(conn: &Connection) -> rusqlite::Result<i64> {
    let user: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let meta = if table_exists(conn, "board_meta")? {
        conn.query_row("SELECT value FROM board_meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(user.max(meta))
}

/// Schema 2. States and kinds are plain text checked in code (no CHECK constraints).
const SCHEMA_2: &str = r#"
CREATE TABLE IF NOT EXISTS board_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
CREATE TABLE IF NOT EXISTS teams (
  uid TEXT PRIMARY KEY NOT NULL,
  team TEXT NOT NULL,
  name TEXT,
  home_host TEXT,
  home_instance TEXT,
  created_at INTEGER NOT NULL,
  last_post_seq INTEGER NOT NULL DEFAULT 0,
  last_task_seq INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  origin_host TEXT,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  UNIQUE(team, home_host)
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY NOT NULL,
  team_uid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  author_id TEXT,
  author_name TEXT,
  author_cli TEXT,
  author_host TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  task_id TEXT,
  arrival INTEGER NOT NULL,
  origin_host TEXT,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  UNIQUE(team_uid, seq)
);
CREATE INDEX IF NOT EXISTS posts_team_kind_seq ON posts(team_uid, kind, seq);
CREATE INDEX IF NOT EXISTS posts_team_ts ON posts(team_uid, ts);
CREATE INDEX IF NOT EXISTS posts_team_arrival ON posts(team_uid, arrival);
CREATE TABLE IF NOT EXISTS cursors (
  team_uid TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  arrival INTEGER NOT NULL,
  PRIMARY KEY(team_uid, tab_id)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  team_uid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_by_id TEXT,
  created_by_name TEXT,
  created_by_host TEXT,
  owner_id TEXT,
  owner_name TEXT,
  owner_host TEXT,
  owner_instance TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  blocked_reason TEXT,
  last_error TEXT,
  result_summary TEXT,
  result_body TEXT,
  result_branch TEXT,
  result_commit TEXT,
  result_worktree TEXT,
  result_checks TEXT,
  result_artifacts TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  started_at INTEGER,
  submitted_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  heartbeat_at INTEGER,
  due_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  origin_host TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  UNIQUE(team_uid, seq)
);
CREATE INDEX IF NOT EXISTS tasks_next ON tasks(team_uid, state, priority DESC, seq);
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(team_uid, owner_id, state);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS tasks_lease ON tasks(state, lease_until);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  team_uid TEXT NOT NULL,
  origin_host TEXT,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER,
  PRIMARY KEY(task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS task_deps_on ON task_deps(depends_on_id);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  team_uid TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_host TEXT,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  attempt INTEGER,
  note TEXT,
  data TEXT,
  origin_host TEXT,
  updated_at INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS task_events_team_ts ON task_events(team_uid, ts);
CREATE TABLE IF NOT EXISTS changes (
  local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
"#;

/// UUIDv7 text for a row created at `ms` (migrated rows keep their original order).
fn id_at(ctx: &uuid::ContextV7, ms: i64) -> String {
    let ms = ms.max(0) as u64;
    uuid::Uuid::new_v7(uuid::Timestamp::from_unix(ctx, ms / 1000, ((ms % 1000) * 1_000_000) as u32)).to_string()
}

/// Version 2 from nothing (fresh file) or from the stage-1 tables (integer ids, `teams.team`
/// key, cursors by seq): the old tables are renamed, the new ones created, every row copied
/// with a UUIDv7 id from its own time, this machine as the teams' home, cursors converted to
/// arrival positions, then the old tables dropped. Every copied row is logged in `changes`.
fn migrate_to_2(tx: &Transaction, now: i64, host: &str) -> rusqlite::Result<()> {
    let stage1 = table_exists(tx, "posts")? && !table_exists(tx, "tasks")?;
    if stage1 {
        tx.execute_batch(
            "DROP INDEX IF EXISTS posts_team_ts;
             ALTER TABLE posts RENAME TO posts_v1;
             ALTER TABLE teams RENAME TO teams_v1;
             ALTER TABLE cursors RENAME TO cursors_v1;",
        )?;
    }
    tx.execute_batch(SCHEMA_2)?;
    if !stage1 {
        return Ok(());
    }
    let ctx = uuid::ContextV7::new();
    let mut teams: Vec<(String, Option<String>, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT t.team, t.name, t.last_seq, t.updated_ts FROM teams_v1 t
             UNION ALL
             SELECT p.team, NULL, max(p.seq), max(p.ts) FROM posts_v1 p
             WHERE p.team NOT IN (SELECT team FROM teams_v1) GROUP BY p.team",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    teams.sort_by_key(|t| t.3);
    let mut uid_of: HashMap<String, String> = HashMap::new();
    for (team, name, last_seq, updated) in &teams {
        let created: i64 = tx
            .query_row("SELECT min(ts) FROM posts_v1 WHERE team = ?1", [team], |r| r.get::<_, Option<i64>>(0))?
            .unwrap_or(*updated);
        let uid = id_at(&ctx, created);
        tx.execute(
            "INSERT INTO teams(uid, team, name, home_host, created_at, last_post_seq, last_task_seq, last_activity_at, origin_host, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?4, ?7)",
            params![uid, team, name, host, created, last_seq, updated],
        )?;
        tx.execute("INSERT INTO changes(tbl, row_id, at) VALUES ('teams', ?1, ?2)", params![uid, now])?;
        uid_of.insert(team.clone(), uid);
    }
    #[allow(clippy::type_complexity)]
    let posts: Vec<(String, i64, i64, Option<String>, Option<String>, Option<String>, String, String)> = {
        let mut stmt =
            tx.prepare("SELECT team, seq, ts, author_id, author_name, author_cli, kind, text FROM posts_v1 ORDER BY ts, team, seq")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (team, seq, ts, author_id, author_name, author_cli, kind, text) in posts {
        let Some(uid) = uid_of.get(&team) else { continue };
        let id = id_at(&ctx, ts);
        tx.execute("INSERT INTO changes(tbl, row_id, at) VALUES ('posts', ?1, ?2)", params![id, now])?;
        let arrival = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO posts(id, team_uid, seq, ts, author_id, author_name, author_cli, kind, text, arrival, origin_host, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?4)",
            params![id, uid, seq, ts, author_id, author_name, author_cli, kind, text, arrival, host],
        )?;
    }
    // A stage-1 cursor at seq N becomes the arrival of the team's newest post with seq <= N.
    tx.execute(
        "INSERT INTO cursors(team_uid, tab_id, arrival)
         SELECT tm.uid, c.tab_id, coalesce((SELECT max(p.arrival) FROM posts p WHERE p.team_uid = tm.uid AND p.seq <= c.seq), 0)
         FROM cursors_v1 c JOIN teams tm ON tm.team = c.team AND tm.home_host IS ?1",
        params![host],
    )?;
    tx.execute_batch("DROP TABLE posts_v1; DROP TABLE teams_v1; DROP TABLE cursors_v1;")?;
    Ok(())
}

/// Bring the schema up to SCHEMA_VERSION. Only called when the stored version is older, so a
/// normal open takes no write lock; the version is re-read under the lock.
fn migrate(conn: &mut Connection, now: i64, host: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version = stored_version(&tx)?;
    if version < 2 {
        migrate_to_2(&tx, now, host)?;
    }
    if version < SCHEMA_VERSION {
        tx.execute(
            "INSERT INTO board_meta(key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )?;
        tx.execute("INSERT OR IGNORE INTO board_meta(key, value) VALUES ('created_at', ?1)", params![now.to_string()])?;
        tx.execute(
            "INSERT OR IGNORE INTO board_meta(key, value) VALUES ('created_by_app_version', ?1)",
            params![env!("CARGO_PKG_VERSION")],
        )?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    tx.commit()
}

/// Open (creating when missing) and migrate the board database at `path`.
pub fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(unavailable)?;
    }
    prepare_db_file(path).map_err(unavailable)?;
    let mut conn = Connection::open(path).map_err(unavailable)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(unavailable)?;
    let version = stored_version(&conn).map_err(unavailable)?;
    if version > SCHEMA_VERSION {
        return Err(unavailable(format!(
            "database is from a newer app version (schema {version}, this app knows {SCHEMA_VERSION})"
        )));
    }
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).map_err(unavailable)?;
    if !mode.eq_ignore_ascii_case("wal") {
        let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0)).map_err(unavailable)?;
    }
    if version < SCHEMA_VERSION {
        migrate(&mut conn, now_ms(), super::board_host()).map_err(unavailable)?;
    }
    tighten_sidecars(path);
    Ok(conn)
}

fn immediate(conn: &mut Connection) -> Result<Transaction<'_>, String> {
    conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(unavailable)
}

trait Db<T> {
    fn db(self) -> Result<T, String>;
}

impl<T> Db<T> for rusqlite::Result<T> {
    fn db(self) -> Result<T, String> {
        self.map_err(unavailable)
    }
}

// ── Change log ───────────────────────────────────────────────────────────

/// Record that a synced row (`tbl` teams | posts | tasks | task_deps | task_events) was
/// inserted, updated or tombstoned; returns its local position. task_deps rows are keyed
/// `<task_id>/<depends_on_id>`. Every write of such a row goes through a helper that calls
/// this in the same transaction.
fn log_change(tx: &Connection, tbl: &str, row_id: &str, now: i64) -> Result<i64, String> {
    tx.execute("INSERT INTO changes(tbl, row_id, at) VALUES (?1, ?2, ?3)", params![tbl, row_id, now]).db()?;
    Ok(tx.last_insert_rowid())
}

/// Commit a write. While nothing consumes the change log (no `consumer` in sync_state) it is
/// trimmed to the newest `limits.changes` rows first.
fn finish(tx: Transaction, limits: Limits) -> Result<(), String> {
    tx.execute(
        "DELETE FROM changes WHERE local_seq <= (SELECT max(local_seq) FROM changes) - ?1
           AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'consumer')",
        params![limits.changes],
    )
    .db()?;
    tx.commit().db()
}

fn dep_key(task_id: &str, depends_on_id: &str) -> String {
    format!("{task_id}/{depends_on_id}")
}

fn collect_ids(tx: &Connection, sql: &str, arg: &str) -> Result<Vec<String>, String> {
    let mut stmt = tx.prepare(sql).db()?;
    let rows = stmt.query_map(params![arg], |r| r.get(0)).db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

// ── Teams ────────────────────────────────────────────────────────────────

struct TeamRef {
    uid: String,
    name: Option<String>,
    last_post_seq: i64,
}

/// The live team row this machine uses for root tab `team`: the one homed on `host`, else any
/// live one (most recently active first; a synced team from another machine).
fn find_team(c: &Connection, team: &str, host: Option<&str>) -> Result<Option<TeamRef>, String> {
    c.query_row(
        "SELECT uid, name, last_post_seq FROM teams WHERE team = ?1 AND deleted_at IS NULL
         ORDER BY (home_host IS ?2) DESC, last_activity_at DESC LIMIT 1",
        params![team, host],
        |r| Ok(TeamRef { uid: r.get(0)?, name: r.get(1)?, last_post_seq: r.get(2)? }),
    )
    .optional()
    .db()
}

/// The team homed on this machine for root tab `team`, created (or revived from its
/// tombstone, counters kept) when missing. Its name is updated when a new one is given.
fn ensure_team(tx: &Transaction, team: &str, name: Option<&str>, ctx: &Ctx) -> Result<String, String> {
    let now = ctx.now;
    let found: Option<(String, Option<String>, Option<i64>)> = tx
        .query_row(
            "SELECT uid, name, deleted_at FROM teams WHERE team = ?1 AND home_host IS ?2",
            params![team, ctx.host],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .db()?;
    match found {
        Some((uid, old_name, deleted)) => {
            let rename = name.is_some() && name != old_name.as_deref();
            if deleted.is_some() || rename {
                tx.execute(
                    "UPDATE teams SET deleted_at = NULL, name = coalesce(?2, name), updated_at = ?3, row_version = row_version + 1
                     WHERE uid = ?1",
                    params![uid, name, now],
                )
                .db()?;
                log_change(tx, "teams", &uid, now)?;
            }
            Ok(uid)
        }
        None => {
            let uid = new_id();
            tx.execute(
                "INSERT INTO teams(uid, team, name, home_host, home_instance, created_at, last_activity_at, origin_host, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?4, ?6)",
                params![uid, team, name, ctx.host, ctx.instance, now],
            )
            .db()?;
            log_change(tx, "teams", &uid, now)?;
            Ok(uid)
        }
    }
}

/// Next post / task number of a team (never repeats, never goes back); also marks activity.
fn next_seq(tx: &Transaction, uid: &str, task: bool, now: i64) -> Result<i64, String> {
    let sql = if task {
        "UPDATE teams SET last_task_seq = last_task_seq + 1, last_activity_at = ?2, updated_at = ?2, row_version = row_version + 1
         WHERE uid = ?1 RETURNING last_task_seq"
    } else {
        "UPDATE teams SET last_post_seq = last_post_seq + 1, last_activity_at = ?2, updated_at = ?2, row_version = row_version + 1
         WHERE uid = ?1 RETURNING last_post_seq"
    };
    let seq: i64 = tx.query_row(sql, params![uid, now], |r| r.get(0)).db()?;
    log_change(tx, "teams", uid, now)?;
    Ok(seq)
}

fn touch_team(tx: &Transaction, uid: &str, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE teams SET last_activity_at = ?2, updated_at = ?2, row_version = row_version + 1 WHERE uid = ?1",
        params![uid, now],
    )
    .db()?;
    log_change(tx, "teams", uid, now)?;
    Ok(())
}

// ── Posts ────────────────────────────────────────────────────────────────

const POST_COLS: &str = "p.seq, p.ts, p.author_id, p.author_name, p.author_cli, p.kind, p.text, p.author_host,
    (SELECT k.seq FROM tasks k WHERE k.id = p.task_id AND k.deleted_at IS NULL), p.id";

fn post_from_row(team: &str, r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut author = serde_json::Map::new();
    for (key, idx) in [("id", 2), ("name", 3), ("cliType", 4), ("host", 7)] {
        if let Some(v) = r.get::<_, Option<String>>(idx)? {
            author.insert(key.into(), Value::String(v));
        }
    }
    let mut v = json!({
        "id": r.get::<_, String>(9)?,
        "seq": r.get::<_, i64>(0)?,
        "ts": r.get::<_, i64>(1)?,
        "team": team,
        "author": Value::Object(author),
        "kind": r.get::<_, String>(5)?,
        "text": r.get::<_, String>(6)?,
    });
    if let Some(t) = r.get::<_, Option<i64>>(8)? {
        v["task"] = json!(t);
    }
    Ok(v)
}

struct NewPost<'a> {
    team_uid: &'a str,
    author_id: &'a str,
    author_name: Option<&'a str>,
    author_cli: Option<&'a str>,
    kind: &'a str,
    text: &'a str,
    task_id: Option<&'a str>,
}

/// One post: the team's next seq, the row (arrival = its change-log position), and the
/// per-team cap on live posts (the oldest are tombstoned). Returns (id, seq).
fn insert_post(tx: &Transaction, limits: Limits, p: &NewPost, ctx: &Ctx) -> Result<(String, i64), String> {
    let now = ctx.now;
    let seq = next_seq(tx, p.team_uid, false, now)?;
    let id = new_id();
    let arrival = log_change(tx, "posts", &id, now)?;
    tx.execute(
        "INSERT INTO posts(id, team_uid, seq, ts, author_id, author_name, author_cli, author_host, kind, text, task_id, arrival, origin_host, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?8, ?4)",
        params![id, p.team_uid, seq, now, p.author_id, p.author_name, p.author_cli, ctx.host, p.kind, p.text, p.task_id, arrival],
    )
    .db()?;
    let over: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM posts WHERE team_uid = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT -1 OFFSET ?2")
            .db()?;
        let rows = stmt.query_map(params![p.team_uid, limits.posts], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    tombstone_posts(tx, &over, now)?;
    Ok((id, seq))
}

fn tombstone_posts(tx: &Transaction, ids: &[String], now: i64) -> Result<(), String> {
    for id in ids {
        let n = tx
            .execute(
                "UPDATE posts SET deleted_at = ?2, updated_at = ?2, row_version = row_version + 1 WHERE id = ?1 AND deleted_at IS NULL",
                params![id, now],
            )
            .db()?;
        if n > 0 {
            log_change(tx, "posts", id, now)?;
        }
    }
    Ok(())
}

fn task_id_of(tx: &Connection, team_uid: &str, team: &str, seq: i64) -> Result<String, String> {
    tx.query_row(
        "SELECT id FROM tasks WHERE team_uid = ?1 AND seq = ?2 AND deleted_at IS NULL",
        params![team_uid, seq],
        |r| r.get(0),
    )
    .optional()
    .db()?
    .ok_or_else(|| format!("no task #{seq} in team {team}"))
}

/// Store one post in one IMMEDIATE transaction.
pub fn post(conn: &mut Connection, limits: Limits, team: &str, input: &PostInput, ctx: &Ctx) -> Result<Value, String> {
    check_team(team)?;
    let kind = input.kind.trim().to_ascii_lowercase();
    if !POST_KINDS.contains(&kind.as_str()) {
        return Err(format!("invalid kind: {} ({})", input.kind, POST_KINDS.join("|")));
    }
    if kind == "announce" && !input.root {
        return Err("only the team's root tab can post an announcement (--kind announce)".to_string());
    }
    let text = clean_text(&input.text)?;
    let author_id = clean_label(Some(&input.author_id), 256).ok_or_else(|| "author required".to_string())?;
    let author_name = clean_label(input.author_name.as_deref(), MAX_NAME_CHARS);
    let author_cli = clean_label(input.author_cli.as_deref(), 40);
    let team_name = clean_label(input.team_name.as_deref(), MAX_NAME_CHARS);
    let tx = immediate(conn)?;
    let uid = ensure_team(&tx, team, team_name.as_deref(), ctx)?;
    let task_id = match input.task {
        Some(seq) => Some(task_id_of(&tx, &uid, team, seq)?),
        None => None,
    };
    let (id, _) = insert_post(
        &tx,
        limits,
        &NewPost {
            team_uid: &uid,
            author_id: &author_id,
            author_name: author_name.as_deref(),
            author_cli: author_cli.as_deref(),
            kind: &kind,
            text: &text,
            task_id: task_id.as_deref(),
        },
        ctx,
    )?;
    let out = tx.query_row(&format!("SELECT {POST_COLS} FROM posts p WHERE p.id = ?1"), params![id], |r| post_from_row(team, r)).db()?;
    finish(tx, limits)?;
    Ok(out)
}

/// Posts of one team that match the query (oldest first) plus the board's totals; `more` is
/// how many matching posts were not returned. Tombstoned posts never show.
/// - Plain read: the newest `limit` matching posts by seq. Without a kind/author/search filter
///   the newest announcements are returned apart (`announcements`) and left out of `posts`.
/// - `cursor_tab` (`--new`): no filters allowed; the `limit` unread posts that arrived here
///   first after that tab's cursor (local arrival order, without `exclude_author`). The cursor
///   moves to the last returned arrival while unread posts remain (`more` > 0), or to the
///   team's newest arrival once none remain — so no unread teammate post is ever skipped.
pub fn read(conn: &mut Connection, team: &str, q: &ReadQuery, host: Option<&str>) -> Result<Value, String> {
    check_team(team)?;
    let limit = q.limit.unwrap_or(DEFAULT_READ_LIMIT).clamp(1, MAX_READ_LIMIT);
    let kind = non_empty(&q.kind).map(|k| k.to_ascii_lowercase());
    if let Some(k) = &kind {
        if !POST_KINDS.contains(&k.as_str()) {
            return Err(format!("invalid kind: {k} ({})", POST_KINDS.join("|")));
        }
    }
    let author = non_empty(&q.author);
    let search = non_empty(&q.search);
    if let Some(s) = &search {
        if s.chars().count() > MAX_SEARCH_CHARS {
            return Err(format!("search text too long (max {MAX_SEARCH_CHARS} characters)"));
        }
    }
    let exclude = non_empty(&q.exclude_author);
    let cursor_tab = non_empty(&q.cursor_tab);
    if cursor_tab.as_deref().is_some_and(|t| !valid_team_id(t)) {
        return Err("invalid read cursor tab id (expected 1-128 characters of A-Z a-z 0-9 _ -)".to_string());
    }
    if cursor_tab.is_some() && (kind.is_some() || author.is_some() || search.is_some() || q.since.is_some()) {
        return Err(NEW_WITH_FILTER_ERROR.to_string());
    }
    let pinned = cursor_tab.is_none() && kind.is_none() && author.is_none() && search.is_none();
    let exclude_kind: Option<&str> = if pinned { Some("announce") } else { None };
    let tx = conn
        .transaction_with_behavior(if cursor_tab.is_some() {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })
        .db()?;
    let Some(t) = find_team(&tx, team, host)? else {
        let mut out = json!({ "team": team, "posts": [], "lastSeq": 0, "total": 0, "matched": 0, "more": 0, "since": q.since.unwrap_or(0) });
        if pinned {
            out["announcements"] = json!([]);
        }
        if cursor_tab.is_some() {
            out["cursor"] = json!(0);
            out["nextCursor"] = json!(0);
        }
        return Ok(out);
    };
    let uid = t.uid.as_str();
    let cursor: i64 = match &cursor_tab {
        Some(tab) => tx
            .query_row("SELECT arrival FROM cursors WHERE team_uid = ?1 AND tab_id = ?2", params![uid, tab], |r| r.get(0))
            .optional()
            .db()?
            .unwrap_or(0),
        None => 0,
    };
    let since = q.since.unwrap_or(0).max(0);
    // Lower bound on seq: none unless --since (a synced row can carry any number).
    let seq_after = q.since.map(|n| n.max(0)).unwrap_or(i64::MIN);
    let total: i64 = tx
        .query_row("SELECT count(*) FROM posts WHERE team_uid = ?1 AND deleted_at IS NULL", params![uid], |r| r.get(0))
        .db()?;
    // Optional filters are bound as NULL when unused; the SQL text never changes.
    const FILTER: &str = "p.team_uid = ?1 AND p.deleted_at IS NULL AND p.seq > ?2 AND p.arrival > ?3
        AND (?4 IS NULL OR p.kind = ?4)
        AND (?5 IS NULL OR p.author_id = ?5 OR p.author_name = ?5 COLLATE NOCASE)
        AND (?6 IS NULL OR p.text LIKE ?6 ESCAPE '\\')
        AND (?7 IS NULL OR p.author_id IS NOT ?7)
        AND (?8 IS NULL OR p.kind <> ?8)";
    let pattern = search.as_deref().map(like_pattern);
    let matched: i64 = tx
        .query_row(
            &format!("SELECT count(*) FROM posts p WHERE {FILTER}"),
            params![uid, seq_after, cursor, kind, author, pattern, exclude, exclude_kind],
            |r| r.get(0),
        )
        .db()?;
    let (posts, last_arrival): (Vec<Value>, Option<i64>) = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {POST_COLS}, p.arrival FROM posts p WHERE {FILTER} ORDER BY {} LIMIT ?9",
                if cursor_tab.is_some() { "p.arrival ASC" } else { "p.seq DESC" }
            ))
            .db()?;
        let rows = stmt
            .query_map(params![uid, seq_after, cursor, kind, author, pattern, exclude, exclude_kind, limit], |r| {
                Ok((post_from_row(team, r)?, r.get::<_, i64>(10)?))
            })
            .db()?;
        let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>().db()?;
        if cursor_tab.is_none() {
            rows.reverse();
        }
        let last = rows.last().map(|(_, a)| *a);
        (rows.into_iter().map(|(p, _)| p).collect(), last)
    };
    let announcements: Vec<Value> = if pinned {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {POST_COLS} FROM posts p WHERE p.team_uid = ?1 AND p.deleted_at IS NULL AND p.kind = 'announce'
                 ORDER BY p.seq DESC LIMIT ?2"
            ))
            .db()?;
        let rows = stmt.query_map(params![uid, PINNED_ANNOUNCEMENTS], |r| post_from_row(team, r)).db()?;
        let mut v = rows.collect::<rusqlite::Result<Vec<_>>>().db()?;
        v.reverse();
        v
    } else {
        Vec::new()
    };
    let more = (matched - posts.len() as i64).max(0);
    let mut new_cursor = None;
    if let Some(tab) = &cursor_tab {
        let newest: i64 = tx
            .query_row("SELECT coalesce(max(arrival), 0) FROM posts WHERE team_uid = ?1", params![uid], |r| r.get(0))
            .db()?;
        let target = if more > 0 { last_arrival.unwrap_or(cursor) } else { newest.max(cursor) };
        tx.execute(
            "INSERT INTO cursors(team_uid, tab_id, arrival) VALUES (?1, ?2, ?3)
             ON CONFLICT(team_uid, tab_id) DO UPDATE SET arrival = max(arrival, excluded.arrival)",
            params![uid, tab, target],
        )
        .db()?;
        new_cursor = Some(target);
    }
    tx.commit().db()?;
    let mut out = json!({
        "team": team,
        "posts": posts,
        "lastSeq": t.last_post_seq,
        "total": total,
        "matched": matched,
        "more": more,
        "since": since,
    });
    if pinned {
        out["announcements"] = Value::Array(announcements);
    }
    if let Some(name) = t.name {
        out["teamName"] = Value::String(name);
    }
    if let Some(next) = new_cursor {
        out["cursor"] = json!(cursor);
        out["nextCursor"] = json!(next);
    }
    Ok(out)
}

/// Every live team: root tab id, name, live post count, distinct authors, last seq, first and
/// last live post time (unix ms; null when cleared), live task count; newest activity first.
pub fn teams(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.team, t.name, t.last_post_seq, t.last_activity_at,
                    count(p.id), count(DISTINCT p.author_id), min(p.ts), max(p.ts),
                    (SELECT count(*) FROM tasks k WHERE k.team_uid = t.uid AND k.deleted_at IS NULL
                       AND k.state IN ('open','claimed','blocked','review')),
                    t.last_task_seq, t.home_host, t.uid
             FROM teams t LEFT JOIN posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid
             ORDER BY t.last_activity_at DESC, coalesce(max(p.ts), 0) DESC
             LIMIT ?1",
        )
        .db()?;
    let rows = stmt
        .query_map(params![MAX_TEAMS_LISTED], |r| {
            let mut v = json!({
                "team": r.get::<_, String>(0)?,
                "lastSeq": r.get::<_, i64>(2)?,
                "updatedTs": r.get::<_, i64>(3)?,
                "posts": r.get::<_, i64>(4)?,
                "members": r.get::<_, i64>(5)?,
                "firstTs": r.get::<_, Option<i64>>(6)?,
                "lastTs": r.get::<_, Option<i64>>(7)?,
                "liveTasks": r.get::<_, i64>(8)?,
                "lastTaskSeq": r.get::<_, i64>(9)?,
                "uid": r.get::<_, String>(11)?,
            });
            if let Some(name) = r.get::<_, Option<String>>(1)? {
                v["teamName"] = Value::String(name);
            }
            if let Some(host) = r.get::<_, Option<String>>(10)? {
                v["homeHost"] = Value::String(host);
            }
            Ok(v)
        })
        .db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// Tombstone a team's posts (its seq counter, read cursors and tasks stay).
pub fn clear(conn: &mut Connection, limits: Limits, team: &str, ctx: &Ctx) -> Result<Value, String> {
    check_team(team)?;
    let tx = immediate(conn)?;
    let Some(t) = find_team(&tx, team, ctx.host.as_deref())? else {
        return Ok(json!({ "team": team, "removed": 0, "lastSeq": 0 }));
    };
    let ids = collect_ids(&tx, "SELECT id FROM posts WHERE team_uid = ?1 AND deleted_at IS NULL", &t.uid)?;
    tombstone_posts(&tx, &ids, ctx.now)?;
    touch_team(&tx, &t.uid, ctx.now)?;
    finish(tx, limits)?;
    Ok(json!({ "team": team, "removed": ids.len(), "lastSeq": t.last_post_seq }))
}

/// App start: tombstone every team with no activity for `max_age_ms` together with its posts,
/// tasks, dependencies and events (cursors go), then remove tombstones older than
/// TOMBSTONE_RETENTION_MS for good. Returns the number of teams retired.
pub fn prune_stale(conn: &mut Connection, limits: Limits, now: i64, max_age_ms: i64) -> Result<usize, String> {
    let cutoff = now - max_age_ms;
    let tx = immediate(conn)?;
    let stale: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT t.uid FROM teams t LEFT JOIN posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
                 WHERE t.deleted_at IS NULL
                 GROUP BY t.uid HAVING max(t.last_activity_at, coalesce(max(p.ts), 0)) < ?1",
            )
            .db()?;
        let rows = stmt.query_map(params![cutoff], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    for uid in &stale {
        let posts = collect_ids(&tx, "SELECT id FROM posts WHERE team_uid = ?1 AND deleted_at IS NULL", uid)?;
        tombstone_posts(&tx, &posts, now)?;
        let tasks = collect_ids(&tx, "SELECT id FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL", uid)?;
        tombstone_tasks(&tx, &tasks, now)?;
        tx.execute("DELETE FROM cursors WHERE team_uid = ?1", params![uid]).db()?;
        tx.execute(
            "UPDATE teams SET deleted_at = ?2, updated_at = ?2, row_version = row_version + 1 WHERE uid = ?1",
            params![uid, now],
        )
        .db()?;
        log_change(&tx, "teams", uid, now)?;
    }
    // Tombstones go for good only while no sync consumer may still need to see them (the
    // same guard as the change-log trim in `finish`).
    let consumer: i64 = tx.query_row("SELECT count(*) FROM sync_state WHERE key = 'consumer'", [], |r| r.get(0)).db()?;
    if consumer == 0 {
        let purge_before = now - TOMBSTONE_RETENTION_MS;
        for table in ["posts", "task_events", "task_deps", "tasks", "teams"] {
            tx.execute(&format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?1"), params![purge_before])
                .db()?;
        }
    }
    tx.execute("DELETE FROM cursors WHERE team_uid NOT IN (SELECT uid FROM teams)", []).db()?;
    finish(tx, limits)?;
    Ok(stale.len())
}

// ── Tasks ────────────────────────────────────────────────────────────────

const TASK_COLS: &str = "t.id, (SELECT tm.team FROM teams tm WHERE tm.uid = t.team_uid), t.seq, t.parent_id,
    (SELECT p.seq FROM tasks p WHERE p.id = t.parent_id AND p.deleted_at IS NULL),
    t.title, t.body, t.state, t.priority, t.needs_review,
    t.created_by_id, t.created_by_name, t.created_by_host,
    t.owner_id, t.owner_name, t.owner_host, t.owner_instance,
    t.attempt, t.max_attempts, t.blocked_reason, t.last_error,
    t.result_summary, t.result_body, t.result_branch, t.result_commit, t.result_worktree,
    t.result_checks, t.result_artifacts, t.labels, t.meta,
    t.created_at, t.updated_at, t.claimed_at, t.started_at, t.submitted_at, t.finished_at,
    t.lease_until, t.heartbeat_at, t.due_at, t.version, t.team_uid, t.row_version";

#[derive(Debug, Clone)]
struct TaskRow {
    id: String,
    team: String,
    seq: i64,
    parent_seq: Option<i64>,
    title: String,
    body: Option<String>,
    state: String,
    priority: i64,
    needs_review: bool,
    created_by_id: Option<String>,
    created_by_name: Option<String>,
    created_by_host: Option<String>,
    owner_id: Option<String>,
    owner_name: Option<String>,
    owner_host: Option<String>,
    owner_instance: Option<String>,
    attempt: i64,
    max_attempts: i64,
    blocked_reason: Option<String>,
    last_error: Option<String>,
    result_summary: Option<String>,
    result_body: Option<String>,
    result_branch: Option<String>,
    result_commit: Option<String>,
    result_worktree: Option<String>,
    result_checks: Option<String>,
    result_artifacts: Option<String>,
    labels: String,
    meta: String,
    created_at: i64,
    updated_at: i64,
    claimed_at: Option<i64>,
    started_at: Option<i64>,
    submitted_at: Option<i64>,
    finished_at: Option<i64>,
    lease_until: Option<i64>,
    heartbeat_at: Option<i64>,
    due_at: Option<i64>,
    version: i64,
    team_uid: String,
    row_version: i64,
}

impl TaskRow {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
        Ok(TaskRow {
            id: r.get(0)?,
            team: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            seq: r.get(2)?,
            parent_seq: r.get(4)?,
            title: r.get(5)?,
            body: r.get(6)?,
            state: r.get(7)?,
            priority: r.get(8)?,
            needs_review: r.get(9)?,
            created_by_id: r.get(10)?,
            created_by_name: r.get(11)?,
            created_by_host: r.get(12)?,
            owner_id: r.get(13)?,
            owner_name: r.get(14)?,
            owner_host: r.get(15)?,
            owner_instance: r.get(16)?,
            attempt: r.get(17)?,
            max_attempts: r.get(18)?,
            blocked_reason: r.get(19)?,
            last_error: r.get(20)?,
            result_summary: r.get(21)?,
            result_body: r.get(22)?,
            result_branch: r.get(23)?,
            result_commit: r.get(24)?,
            result_worktree: r.get(25)?,
            result_checks: r.get(26)?,
            result_artifacts: r.get(27)?,
            labels: r.get(28)?,
            meta: r.get(29)?,
            created_at: r.get(30)?,
            updated_at: r.get(31)?,
            claimed_at: r.get(32)?,
            started_at: r.get(33)?,
            submitted_at: r.get(34)?,
            finished_at: r.get(35)?,
            lease_until: r.get(36)?,
            heartbeat_at: r.get(37)?,
            due_at: r.get(38)?,
            version: r.get(39)?,
            team_uid: r.get(40)?,
            row_version: r.get(41)?,
        })
    }

    fn facts(&self) -> TaskFacts<'_> {
        TaskFacts {
            seq: self.seq,
            state: &self.state,
            owner_id: self.owner_id.as_deref(),
            owner_name: self.owner_name.as_deref(),
            created_by_id: self.created_by_id.as_deref(),
            needs_review: self.needs_review,
            attempt: self.attempt,
            max_attempts: self.max_attempts,
        }
    }
}

fn parse_json(raw: &str, fallback: Value) -> Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn party(id: &Option<String>, name: &Option<String>, host: &Option<String>) -> Value {
    let mut m = serde_json::Map::new();
    if let Some(v) = id {
        m.insert("id".into(), json!(v));
    }
    if let Some(v) = name {
        m.insert("name".into(), json!(v));
    }
    if let Some(v) = host {
        m.insert("host".into(), json!(v));
    }
    Value::Object(m)
}

/// A task as JSON (camelCase). `waiting` and `stale` are derived, never stored.
fn task_json(t: &TaskRow, deps: &[(i64, String)], now: i64, stale_ms: i64) -> Value {
    // A cancelled dependency counts as met (flagged); a failed one still blocks.
    let waiting_on: Vec<i64> = deps.iter().filter(|(_, s)| !dep_met(s)).map(|(n, _)| *n).collect();
    let cancelled_deps: Vec<i64> = deps.iter().filter(|(_, s)| s == "cancelled").map(|(n, _)| *n).collect();
    let waiting = t.state == "open" && !waiting_on.is_empty();
    let stale = is_held(&t.state) && t.updated_at < now - stale_ms;
    let owner = if t.owner_id.is_some() {
        let mut o = party(&t.owner_id, &t.owner_name, &t.owner_host);
        if let Some(i) = &t.owner_instance {
            o["instance"] = json!(i);
        }
        o
    } else {
        Value::Null
    };
    let result = match &t.result_summary {
        Some(summary) => json!({
            "summary": summary,
            "body": t.result_body,
            "branch": t.result_branch,
            "commit": t.result_commit,
            "worktree": t.result_worktree,
            "checks": t.result_checks,
            "artifacts": t.result_artifacts.as_deref().map(|a| parse_json(a, json!({}))).unwrap_or(json!({})),
        }),
        None => Value::Null,
    };
    json!({
        "id": t.id,
        "team": t.team,
        "teamUid": t.team_uid,
        "seq": t.seq,
        "parent": t.parent_seq,
        "title": t.title,
        "body": t.body,
        "state": t.state,
        "priority": t.priority,
        "needsReview": t.needs_review,
        "createdBy": party(&t.created_by_id, &t.created_by_name, &t.created_by_host),
        "owner": owner,
        "attempt": t.attempt,
        "maxAttempts": t.max_attempts,
        "blockedReason": t.blocked_reason,
        "lastError": t.last_error,
        "result": result,
        "labels": parse_json(&t.labels, json!([])),
        "meta": parse_json(&t.meta, json!({})),
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
        "claimedAt": t.claimed_at,
        "startedAt": t.started_at,
        "submittedAt": t.submitted_at,
        "finishedAt": t.finished_at,
        "leaseUntil": t.lease_until,
        "heartbeatAt": t.heartbeat_at,
        "dueAt": t.due_at,
        "version": t.version,
        "rowVersion": t.row_version,
        "deps": deps.iter().map(|(n, s)| json!({ "seq": n, "state": s })).collect::<Vec<_>>(),
        "waiting": waiting,
        "waitingOn": waiting_on,
        "cancelledDeps": cancelled_deps,
        "stale": stale,
    })
}

/// A dependency in this state no longer holds its dependent back.
fn dep_met(state: &str) -> bool {
    state == "done" || state == "cancelled"
}

fn load_task(tx: &Connection, team_uid: &str, team: &str, seq: i64) -> Result<TaskRow, String> {
    tx.query_row(
        &format!("SELECT {TASK_COLS} FROM tasks t WHERE t.team_uid = ?1 AND t.seq = ?2 AND t.deleted_at IS NULL"),
        params![team_uid, seq],
        TaskRow::from_row,
    )
    .optional()
    .db()?
    .ok_or_else(|| format!("no task #{seq} in team {team}"))
}

fn load_task_by_id(tx: &Connection, id: &str) -> Result<Option<TaskRow>, String> {
    tx.query_row(&format!("SELECT {TASK_COLS} FROM tasks t WHERE t.id = ?1 AND t.deleted_at IS NULL"), params![id], TaskRow::from_row)
        .optional()
        .db()
}

fn deps_of(tx: &Connection, task_id: &str) -> Result<Vec<(i64, String)>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT x.seq, x.state FROM task_deps d JOIN tasks x ON x.id = d.depends_on_id
             WHERE d.task_id = ?1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        )
        .db()?;
    let rows = stmt.query_map(params![task_id], |r| Ok((r.get(0)?, r.get(1)?))).db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

fn task_out(tx: &Connection, row: &TaskRow, now: i64, stale_ms: i64) -> Result<Value, String> {
    Ok(task_json(row, &deps_of(tx, &row.id)?, now, stale_ms))
}

/// Append a history row (per-task seq) for a change.
#[allow(clippy::too_many_arguments)]
fn add_event(
    tx: &Transaction,
    task: &TaskRow,
    now: i64,
    actor: &Actor,
    action: &str,
    from: Option<&str>,
    to: Option<&str>,
    attempt: i64,
    note: Option<&str>,
    data: Option<Value>,
    origin_host: Option<&str>,
) -> Result<(), String> {
    let seq: i64 = tx
        .query_row("SELECT coalesce(max(seq), 0) + 1 FROM task_events WHERE task_id = ?1", params![task.id], |r| r.get(0))
        .db()?;
    let id = new_id();
    tx.execute(
        "INSERT INTO task_events(id, task_id, team_uid, seq, ts, actor_id, actor_name, actor_host, action, from_state, to_state,
           attempt, note, data, origin_host, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?5)",
        params![
            id,
            task.id,
            task.team_uid,
            seq,
            now,
            actor.id,
            actor.name,
            actor.host,
            action,
            from,
            to,
            attempt,
            note,
            data.map(|d| d.to_string()),
            origin_host
        ],
    )
    .db()?;
    log_change(tx, "task_events", &id, now)?;
    Ok(())
}

/// Run one guarded UPDATE of a task (`sql` must bump `row_version` and bind the id as ?1) and
/// log it when it changed the row. Returns the number of rows changed (0: the guard failed).
fn update_task(tx: &Transaction, id: &str, sql: &str, params: &[&dyn rusqlite::ToSql], now: i64) -> Result<usize, String> {
    debug_assert!(sql.contains("row_version = row_version + 1"));
    let n = tx.execute(sql, params).db()?;
    if n > 0 {
        log_change(tx, "tasks", id, now)?;
    }
    Ok(n)
}

/// Release claimed/blocked tasks whose lease ran out (another machine or a crashed app),
/// with a `lease_expired` event each. `team_uid` None: every team. `except`: a task its own
/// owner is acting on right now (the owner proves it is alive; its write renews the lease).
fn expire_leases(tx: &Transaction, team_uid: Option<&str>, now: i64, except: Option<&str>, host: Option<&str>) -> Result<Vec<Value>, String> {
    let rows: Vec<TaskRow> = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {TASK_COLS} FROM tasks t
                 WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.lease_until IS NOT NULL AND t.lease_until < ?1
                   AND (?2 IS NULL OR t.team_uid = ?2) AND (?3 IS NULL OR t.id <> ?3)"
            ))
            .db()?;
        let it = stmt.query_map(params![now, team_uid, except], TaskRow::from_row).db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    let app = Actor::app(host);
    let mut out = Vec::new();
    for row in rows {
        let n = update_task(
            tx,
            &row.id,
            "UPDATE tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL,
               owner_instance = NULL, lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL,
               updated_at = ?2, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = ?3 AND deleted_at IS NULL",
            params![row.id, now, row.state],
            now,
        )?;
        if n == 0 {
            continue;
        }
        add_event(
            tx,
            &row,
            now,
            &app,
            "lease_expired",
            Some(&row.state),
            Some("open"),
            row.attempt,
            None,
            Some(json!({ "ownerId": row.owner_id, "leaseUntil": row.lease_until })),
            host,
        )?;
        out.push(json!({ "team": row.team, "seq": row.seq, "ownerId": row.owner_id, "from": row.state }));
    }
    Ok(out)
}

/// Finished live tasks that may be pruned: nothing live depends on them or is their child.
const PRUNABLE: &str = "t.team_uid = ?1 AND t.deleted_at IS NULL AND t.state IN ('done','failed','cancelled')
    AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks x ON x.id = d.task_id
                    WHERE d.depends_on_id = t.id AND d.deleted_at IS NULL AND x.deleted_at IS NULL
                      AND x.state IN ('open','claimed','blocked','review'))
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL
                    AND c.state IN ('open','claimed','blocked','review'))";

/// Tombstone tasks with their events and dependency rows (each logged).
fn tombstone_tasks(tx: &Transaction, ids: &[String], now: i64) -> Result<(), String> {
    for id in ids {
        update_task(
            tx,
            id,
            "UPDATE tasks SET deleted_at = ?2, updated_at = ?2, row_version = row_version + 1 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
            now,
        )?;
        for ev in collect_ids(tx, "SELECT id FROM task_events WHERE task_id = ?1 AND deleted_at IS NULL", id)? {
            tx.execute(
                "UPDATE task_events SET deleted_at = ?2, updated_at = ?2, row_version = row_version + 1 WHERE id = ?1",
                params![ev, now],
            )
            .db()?;
            log_change(tx, "task_events", &ev, now)?;
        }
        let deps: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare("SELECT task_id, depends_on_id FROM task_deps WHERE (task_id = ?1 OR depends_on_id = ?1) AND deleted_at IS NULL")
                .db()?;
            let rows = stmt.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).db()?;
            rows.collect::<rusqlite::Result<Vec<_>>>().db()?
        };
        for (a, b) in deps {
            tombstone_dep(tx, &a, &b, now)?;
        }
    }
    Ok(())
}

fn tombstone_dep(tx: &Transaction, task_id: &str, depends_on_id: &str, now: i64) -> Result<usize, String> {
    let n = tx
        .execute(
            "UPDATE task_deps SET deleted_at = ?3, updated_at = ?3, row_version = row_version + 1
             WHERE task_id = ?1 AND depends_on_id = ?2 AND deleted_at IS NULL",
            params![task_id, depends_on_id, now],
        )
        .db()?;
    if n > 0 {
        log_change(tx, "task_deps", &dep_key(task_id, depends_on_id), now)?;
    }
    Ok(n)
}

/// Add a dependency row (or revive its tombstone).
fn insert_dep(tx: &Transaction, task_id: &str, depends_on_id: &str, team_uid: &str, ctx: &Ctx) -> Result<(), String> {
    tx.execute(
        "INSERT INTO task_deps(task_id, depends_on_id, team_uid, origin_host, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(task_id, depends_on_id) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at,
           origin_host = excluded.origin_host, row_version = row_version + 1",
        params![task_id, depends_on_id, team_uid, ctx.host, ctx.now],
    )
    .db()?;
    log_change(tx, "task_deps", &dep_key(task_id, depends_on_id), ctx.now)?;
    Ok(())
}

/// Keep a team within its caps on live rows: at most `limits.tasks - room` tasks and
/// `limits.events` events, tombstoning the oldest finished tasks (with their events) first.
/// Live tasks and finished tasks a live task still depends on or descends from are never
/// pruned. Returns the number of tasks pruned.
fn prune_team(tx: &Transaction, team_uid: &str, limits: Limits, room: i64, now: i64) -> Result<usize, String> {
    let mut removed = 0usize;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL", params![team_uid], |r| r.get(0))
        .db()?;
    let target = (limits.tasks - room).max(0);
    if count > target {
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare(&format!(
                    "SELECT t.id FROM tasks t WHERE {PRUNABLE} ORDER BY coalesce(t.finished_at, t.updated_at), t.seq LIMIT ?2"
                ))
                .db()?;
            let rows = stmt.query_map(params![team_uid, count - target], |r| r.get(0)).db()?;
            rows.collect::<rusqlite::Result<Vec<_>>>().db()?
        };
        tombstone_tasks(tx, &ids, now)?;
        removed += ids.len();
    }
    let events: i64 = tx
        .query_row("SELECT count(*) FROM task_events WHERE team_uid = ?1 AND deleted_at IS NULL", params![team_uid], |r| r.get(0))
        .db()?;
    if events > limits.events {
        let mut need = events - limits.events;
        let candidates: Vec<(String, i64)> = {
            let mut stmt = tx
                .prepare(&format!(
                    "SELECT t.id, (SELECT count(*) FROM task_events e WHERE e.task_id = t.id AND e.deleted_at IS NULL) FROM tasks t
                     WHERE {PRUNABLE} ORDER BY coalesce(t.finished_at, t.updated_at), t.seq"
                ))
                .db()?;
            let rows = stmt.query_map(params![team_uid], |r| Ok((r.get(0)?, r.get(1)?))).db()?;
            rows.collect::<rusqlite::Result<Vec<_>>>().db()?
        };
        // When the prunable tasks cannot cover the excess (live tasks' history alone is over
        // the cap), prune nothing rather than wiping every finished task on each write.
        let available: i64 = candidates.iter().map(|(_, n)| n).sum();
        if available >= need {
            let mut ids = Vec::new();
            for (id, n) in candidates {
                if need <= 0 {
                    break;
                }
                ids.push(id);
                need -= n;
            }
            tombstone_tasks(tx, &ids, now)?;
            removed += ids.len();
        }
    }
    Ok(removed)
}

/// Does `from` (transitively) depend on `target`? Bounded by MAX_DEP_DEPTH levels.
fn depends_transitively(tx: &Transaction, from: &str, target: &str) -> Result<bool, String> {
    let mut frontier = vec![from.to_string()];
    let mut seen: HashSet<String> = HashSet::from([from.to_string()]);
    for _ in 0..MAX_DEP_DEPTH {
        if frontier.is_empty() {
            return Ok(false);
        }
        let mut next = Vec::new();
        for id in &frontier {
            let mut stmt = tx.prepare_cached("SELECT depends_on_id FROM task_deps WHERE task_id = ?1 AND deleted_at IS NULL").db()?;
            let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0)).db()?;
            for dep in rows {
                let dep = dep.db()?;
                if dep == target {
                    return Ok(true);
                }
                if seen.insert(dep.clone()) {
                    next.push(dep);
                }
            }
        }
        frontier = next;
    }
    if frontier.is_empty() {
        Ok(false)
    } else {
        Err(format!("dependency chain deeper than {MAX_DEP_DEPTH} levels: refused"))
    }
}

fn done_post_text(row: &TaskRow, summary: &str, approved_by: Option<&Actor>) -> String {
    let mut lines = vec![match approved_by {
        Some(a) => format!("#{} done (approved by {}): {}", row.seq, a.name.as_deref().unwrap_or(&a.id), row.title),
        None => format!("#{} done: {}", row.seq, row.title),
    }];
    lines.push(summary.to_string());
    let mut where_ = Vec::new();
    if let Some(b) = &row.result_branch {
        where_.push(format!("branch {b}"));
    }
    if let Some(c) = &row.result_commit {
        where_.push(format!("commit {c}"));
    }
    if let Some(c) = &row.result_checks {
        where_.push(format!("checks {c}"));
    }
    if !where_.is_empty() {
        lines.push(where_.join(", "));
    }
    let text = lines.join("\n");
    clean_text(&text).unwrap_or_else(|_| text.chars().take(MAX_TEXT_CHARS).collect())
}

fn require_text(raw: &Option<String>, field: &str, flag: &str) -> Result<String, String> {
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => clean_multiline(v, field, MAX_REASON_CHARS, MAX_TEXT_LINES),
        None => Err(format!("{field} required ({flag} \"<text>\")")),
    }
}

/// Add one task (state open) with its dependencies, in one IMMEDIATE transaction.
fn add_task(conn: &mut Connection, limits: Limits, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, String> {
    let title = clean_line(op.title.as_deref().unwrap_or(""), "title", MAX_TITLE_CHARS)?;
    let body = match op.body.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => Some(clean_multiline(b, "body", MAX_BODY_CHARS, MAX_BODY_LINES)?),
        None => None,
    };
    let priority = op.priority.unwrap_or(DEFAULT_PRIORITY);
    if !(0..=MAX_PRIORITY).contains(&priority) {
        return Err(format!("priority must be 0-{MAX_PRIORITY} (higher is claimed first)"));
    }
    let max_attempts = op.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
    if !(1..=MAX_MAX_ATTEMPTS).contains(&max_attempts) {
        return Err(format!("max attempts must be 1-{MAX_MAX_ATTEMPTS}"));
    }
    let labels = clean_labels(op.labels.as_deref().unwrap_or(&[]))?;
    let mut after: Vec<i64> = Vec::new();
    for n in &op.after {
        if !after.contains(n) {
            after.push(*n);
        }
    }
    if after.len() > MAX_DEPS_PER_TASK {
        return Err(format!("too many dependencies (max {MAX_DEPS_PER_TASK})"));
    }
    let team_name = clean_label(op.team_name.as_deref(), MAX_NAME_CHARS);
    let now = ctx.now;
    let tx = immediate(conn)?;
    let uid = ensure_team(&tx, team, team_name.as_deref(), ctx)?;
    let parent_id = match op.parent {
        Some(seq) => Some(task_id_of(&tx, &uid, team, seq)?),
        None => None,
    };
    let id = new_id();
    let mut dep_ids = Vec::new();
    for seq in &after {
        let dep = load_task(&tx, &uid, team, *seq)?;
        if dep.state == "cancelled" {
            return Err(format!("#{seq} is cancelled: it cannot be a dependency"));
        }
        // Same bounded walk as `dep add` (a new task has no dependents, so only depth matters).
        depends_transitively(&tx, &dep.id, &id)?;
        dep_ids.push(dep.id);
    }
    prune_team(&tx, &uid, limits, 1, now)?;
    let count: i64 = tx
        .query_row("SELECT count(*) FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL", params![uid], |r| r.get(0))
        .db()?;
    if count >= limits.tasks {
        return Err(format!(
            "task limit reached: team {team} has {count} tasks that cannot be pruned (max {}); finish or cancel some first",
            limits.tasks
        ));
    }
    let seq = next_seq(&tx, &uid, true, now)?;
    tx.execute(
        "INSERT INTO tasks(id, team_uid, seq, parent_id, title, body, state, priority, needs_review,
           created_by_id, created_by_name, created_by_host, max_attempts, labels, created_at, updated_at, origin_host)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14, ?15)",
        params![
            id,
            uid,
            seq,
            parent_id,
            title,
            body,
            priority,
            op.review.unwrap_or(false),
            actor.id,
            actor.name,
            actor.host,
            max_attempts,
            serde_json::to_string(&labels).unwrap_or_else(|_| "[]".into()),
            now,
            ctx.host
        ],
    )
    .db()?;
    log_change(&tx, "tasks", &id, now)?;
    for dep in &dep_ids {
        insert_dep(&tx, &id, dep, &uid, ctx)?;
    }
    let row = load_task(&tx, &uid, team, seq)?;
    add_event(
        &tx,
        &row,
        now,
        actor,
        "add",
        None,
        Some("open"),
        0,
        None,
        Some(json!({ "parent": op.parent, "after": after, "priority": priority, "review": op.review.unwrap_or(false) })),
        ctx.host.as_deref(),
    )?;
    prune_team(&tx, &uid, limits, 0, now)?;
    let task = task_out(&tx, &row, now, DEFAULT_STALE_MS)?;
    finish(tx, limits)?;
    Ok(json!({ "action": "add", "from": Value::Null, "to": "open", "task": task, "expired": [] }))
}

/// One task write (`TaskOpInput.op`): add, or a transition / edit / dependency change. Each
/// is one IMMEDIATE transaction: lazy lease expiry for the team, the rule check
/// (model::check_transition), a guarded UPDATE (expected state, and owner where it matters)
/// and the event row; reaching `done` also writes a linked `done` post.
pub fn task_write(conn: &mut Connection, limits: Limits, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, String> {
    check_team(team)?;
    let name = op.op.trim();
    if name == "add" {
        return add_task(conn, limits, team, op, actor, ctx);
    }
    let action = Action::parse(name).ok_or_else(|| format!("unknown task operation: {name}"))?;
    let now = ctx.now;
    let host = ctx.host.as_deref();
    let lease = lease_ms(op.lease_ms);
    let reason = match action {
        Action::Block => Some(require_text(&op.reason, "reason", "--reason")?),
        Action::Reject => Some(require_text(&op.reason, "reason", "--reason")?),
        Action::Fail => Some(require_text(&op.error, "error", "--error")?),
        Action::Reopen | Action::Cancel | Action::Approve => match op.reason.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(r) => Some(clean_multiline(r, "reason", MAX_REASON_CHARS, MAX_TEXT_LINES)?),
            None => None,
        },
        _ => None,
    };
    let result = match action {
        Action::Done | Action::Submit => Some(TaskResult::check(op.result.as_ref().unwrap_or(&ResultInput::default()))?),
        _ => None,
    };
    let claim_next = action == Action::Claim && op.next && op.task.is_none();
    if op.task.is_none() && !claim_next {
        return Err(format!("task number required (agent task {name} <#>)"));
    }
    let tx = immediate(conn)?;
    let Some(team_ref) = find_team(&tx, team, host)? else {
        if claim_next {
            return Ok(json!({ "action": "claim", "task": Value::Null, "open": 0, "waiting": 0, "expired": [], "none": "no open task to claim" }));
        }
        return Err(format!("no task #{} in team {team}", op.task.unwrap_or(0)));
    };
    let uid = team_ref.uid.as_str();
    let target: Option<TaskRow> = match op.task {
        Some(seq) => Some(load_task(&tx, uid, team, seq)?),
        None => None,
    };
    let except = target.as_ref().filter(|t| t.owner_id.as_deref() == Some(actor.id.as_str())).map(|t| t.id.clone());
    let expired = expire_leases(&tx, Some(uid), now, except.as_deref(), host)?;
    let row = match target {
        Some(t) => load_task(&tx, uid, team, t.seq)?,
        None => {
            let next: Option<i64> = tx
                .query_row(
                    &format!(
                        "SELECT t.seq FROM tasks t WHERE t.team_uid = ?1 AND t.deleted_at IS NULL AND t.state = 'open' AND NOT {UNMET}
                         ORDER BY t.priority DESC, t.seq LIMIT 1"
                    ),
                    params![uid],
                    |r| r.get(0),
                )
                .optional()
                .db()?;
            match next {
                Some(seq) => load_task(&tx, uid, team, seq)?,
                None => {
                    let (open, waiting): (i64, i64) = tx
                        .query_row(
                            &format!(
                                "SELECT count(*), coalesce(sum({UNMET}), 0) FROM tasks t
                                 WHERE t.team_uid = ?1 AND t.deleted_at IS NULL AND t.state = 'open'"
                            ),
                            params![uid],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .db()?;
                    let none = if open == 0 {
                        "no open task to claim".to_string()
                    } else {
                        format!("no open task is ready: {waiting} wait for dependencies")
                    };
                    finish(tx, limits)?;
                    return Ok(json!({ "action": "claim", "task": Value::Null, "open": open, "waiting": waiting, "expired": expired, "none": none }));
                }
            }
        }
    };
    let from = row.state.clone();
    let to = check_transition(action, &row.facts(), actor)?;
    let owner = actor.id.as_str();
    let seq = row.seq;
    let id = row.id.as_str();
    let mut note: Option<String> = reason.clone();
    let mut data: Option<Value> = None;
    let mut attempt_after = row.attempt;
    let n = match action {
        Action::Claim => {
            let deps = deps_of(&tx, id)?;
            let unmet: Vec<String> = deps.iter().filter(|(_, s)| !dep_met(s)).map(|(n, s)| format!("#{n} ({s})")).collect();
            if !unmet.is_empty() {
                return Err(format!("#{seq} is waiting for {}: claim a ready task (agent task list --ready)", unmet.join(", ")));
            }
            update_task(
                &tx,
                id,
                "UPDATE tasks SET state = 'claimed', owner_id = ?2, owner_name = ?3, owner_host = ?4, owner_instance = ?5,
                   claimed_at = ?6, started_at = coalesce(started_at, ?6), lease_until = ?7, heartbeat_at = ?6,
                   blocked_reason = NULL, updated_at = ?6, version = version + 1, row_version = row_version + 1
                 WHERE id = ?1 AND state = 'open' AND deleted_at IS NULL",
                params![id, owner, actor.name, actor.host, ctx.instance, now, now + lease],
                now,
            )?
        }
        Action::Block => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'blocked', blocked_reason = ?3, lease_until = ?4, heartbeat_at = ?5,
               owner_instance = ?6, updated_at = ?5, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = 'claimed' AND owner_id = ?2 AND deleted_at IS NULL",
            params![id, owner, reason, now + lease, now, ctx.instance],
            now,
        )?,
        Action::Unblock => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'claimed', blocked_reason = NULL, lease_until = ?3, heartbeat_at = ?4,
               owner_instance = ?5, updated_at = ?4, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = 'blocked' AND owner_id = ?2 AND deleted_at IS NULL",
            params![id, owner, now + lease, now, ctx.instance],
            now,
        )?,
        Action::Release => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL, owner_instance = NULL,
               lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL, updated_at = ?4, version = version + 1,
               row_version = row_version + 1
             WHERE id = ?1 AND state = ?3 AND owner_id = ?2 AND deleted_at IS NULL",
            params![id, owner, from, now],
            now,
        )?,
        Action::Done | Action::Submit => {
            let r = result.clone().unwrap_or_default();
            note = Some(r.summary.clone());
            data = Some(json!({ "branch": r.branch, "commit": r.commit, "checks": r.checks }));
            update_task(
                &tx,
                id,
                "UPDATE tasks SET state = ?3, result_summary = ?4, result_body = ?5, result_branch = ?6, result_commit = ?7,
                   result_worktree = ?8, result_checks = ?9, result_artifacts = ?10,
                   submitted_at = CASE WHEN ?3 = 'review' THEN ?11 ELSE submitted_at END,
                   finished_at = CASE WHEN ?3 = 'done' THEN ?11 ELSE finished_at END,
                   lease_until = NULL, heartbeat_at = ?11, blocked_reason = NULL, updated_at = ?11, version = version + 1,
                   row_version = row_version + 1
                 WHERE id = ?1 AND state = 'claimed' AND owner_id = ?2 AND deleted_at IS NULL",
                params![id, owner, to, r.summary, r.body, r.branch, r.commit, r.worktree, r.checks, r.artifacts, now],
                now,
            )?
        }
        Action::Approve => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'done', finished_at = ?2, updated_at = ?2, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = 'review' AND deleted_at IS NULL",
            params![id, now],
            now,
        )?,
        Action::Reject => {
            attempt_after = row.attempt + 1;
            update_task(
                &tx,
                id,
                "UPDATE tasks SET state = 'open', attempt = attempt + 1, last_error = ?2, owner_id = NULL, owner_name = NULL,
                   owner_host = NULL, owner_instance = NULL, submitted_at = NULL, lease_until = NULL, heartbeat_at = NULL,
                   updated_at = ?3, version = version + 1, row_version = row_version + 1
                 WHERE id = ?1 AND state = 'review' AND deleted_at IS NULL",
                params![id, reason.as_ref().map(|r| format!("rejected: {r}")), now],
                now,
            )?
        }
        Action::Fail => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'failed', last_error = ?4, finished_at = ?5, lease_until = NULL, owner_instance = NULL,
               blocked_reason = NULL, updated_at = ?5, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = ?3 AND owner_id = ?2 AND deleted_at IS NULL",
            params![id, owner, from, reason, now],
            now,
        )?,
        Action::Retry | Action::Reopen => {
            attempt_after = row.attempt + 1;
            if action == Action::Retry {
                data = Some(json!({ "previousError": row.last_error }));
            }
            update_task(
                &tx,
                id,
                "UPDATE tasks SET state = 'open', attempt = attempt + 1, owner_id = NULL, owner_name = NULL, owner_host = NULL,
                   owner_instance = NULL, finished_at = NULL, submitted_at = NULL, lease_until = NULL, heartbeat_at = NULL,
                   updated_at = ?3, version = version + 1, row_version = row_version + 1
                 WHERE id = ?1 AND state = ?2 AND deleted_at IS NULL",
                params![id, from, now],
                now,
            )?
        }
        Action::Cancel => update_task(
            &tx,
            id,
            "UPDATE tasks SET state = 'cancelled', finished_at = ?3, lease_until = NULL, owner_instance = NULL,
               updated_at = ?3, version = version + 1, row_version = row_version + 1
             WHERE id = ?1 AND state = ?2 AND deleted_at IS NULL",
            params![id, from, now],
            now,
        )?,
        Action::Edit => {
            if op.review.is_some() {
                check_edit(&row.facts(), actor, true)?;
            }
            if let Some(v) = op.expected_version {
                if v != row.version {
                    return Err(format!("#{seq} changed since you loaded it (version {v}, now {}): load it again", row.version));
                }
            }
            let title = match &op.title {
                Some(t) => Some(clean_line(t, "title", MAX_TITLE_CHARS)?),
                None => None,
            };
            let body = match &op.body {
                Some(b) if b.trim().is_empty() => Some(None),
                Some(b) => Some(Some(clean_multiline(b, "body", MAX_BODY_CHARS, MAX_BODY_LINES)?)),
                None => None,
            };
            if let Some(p) = op.priority {
                if !(0..=MAX_PRIORITY).contains(&p) {
                    return Err(format!("priority must be 0-{MAX_PRIORITY}"));
                }
            }
            let labels = match &op.labels {
                Some(l) => Some(serde_json::to_string(&clean_labels(l)?).unwrap_or_else(|_| "[]".into())),
                None => None,
            };
            let mut fields = Vec::new();
            if title.is_some() {
                fields.push("title");
            }
            if body.is_some() {
                fields.push("body");
            }
            if op.priority.is_some() {
                fields.push("priority");
            }
            if labels.is_some() {
                fields.push("labels");
            }
            if op.review.is_some() {
                fields.push("review");
            }
            if fields.is_empty() {
                return Err("nothing to edit (--title, --body, --priority, --label)".to_string());
            }
            data = Some(json!({ "fields": fields }));
            update_task(
                &tx,
                id,
                "UPDATE tasks SET title = coalesce(?3, title),
                   body = CASE WHEN ?4 = 1 THEN ?5 ELSE body END,
                   priority = coalesce(?6, priority), labels = coalesce(?7, labels),
                   needs_review = coalesce(?8, needs_review),
                   updated_at = ?9, version = version + 1, row_version = row_version + 1
                 WHERE id = ?1 AND version = ?2 AND deleted_at IS NULL",
                params![id, row.version, title, body.is_some(), body.clone().flatten(), op.priority, labels, op.review, now],
                now,
            )?
        }
        Action::DepAdd | Action::DepRemove => {
            let on_seq = op.on.ok_or_else(|| "dependency required: agent task dep add|rm <#task> <#depends-on>".to_string())?;
            let on = load_task(&tx, uid, team, on_seq)?;
            if on.id == row.id {
                return Err(format!("#{seq} cannot depend on itself"));
            }
            data = Some(json!({ "on": on_seq }));
            if action == Action::DepAdd && on.state == "cancelled" {
                return Err(format!("#{on_seq} is cancelled: it cannot be a dependency"));
            }
            if action == Action::DepAdd {
                let exists: i64 = tx
                    .query_row(
                        "SELECT count(*) FROM task_deps WHERE task_id = ?1 AND depends_on_id = ?2 AND deleted_at IS NULL",
                        params![id, on.id],
                        |r| r.get(0),
                    )
                    .db()?;
                if exists > 0 {
                    return Err(format!("#{seq} already depends on #{on_seq}"));
                }
                let count: i64 = tx
                    .query_row("SELECT count(*) FROM task_deps WHERE task_id = ?1 AND deleted_at IS NULL", params![id], |r| r.get(0))
                    .db()?;
                if count as usize >= MAX_DEPS_PER_TASK {
                    return Err(format!("#{seq} already has {MAX_DEPS_PER_TASK} dependencies (max)"));
                }
                if depends_transitively(&tx, &on.id, id)? {
                    return Err(format!("#{on_seq} already depends on #{seq} (directly or through other tasks): that would be a cycle"));
                }
                insert_dep(&tx, id, &on.id, uid, ctx)?;
            } else if tombstone_dep(&tx, id, &on.id, now)? == 0 {
                return Err(format!("#{seq} does not depend on #{on_seq}"));
            }
            update_task(
                &tx,
                id,
                "UPDATE tasks SET updated_at = ?2, version = version + 1, row_version = row_version + 1 WHERE id = ?1",
                params![id, now],
                now,
            )?
        }
    };
    if n == 0 {
        return Err(match load_task(&tx, uid, team, seq) {
            Ok(cur) => format!("#{seq} changed meanwhile: it is now {}", describe_state(&cur.facts())),
            Err(e) => e,
        });
    }
    let updated = load_task(&tx, uid, team, seq)?;
    add_event(&tx, &updated, now, actor, action.event(), Some(&from), Some(to), attempt_after, note.as_deref(), data, host)?;
    let mut post_seq = None;
    if to == "done" && from != "done" {
        let summary = updated.result_summary.clone().unwrap_or_default();
        let text = done_post_text(&updated, &summary, (action == Action::Approve).then_some(actor));
        let (_, s) = insert_post(
            &tx,
            limits,
            &NewPost {
                team_uid: uid,
                author_id: &actor.id,
                author_name: actor.name.as_deref(),
                author_cli: actor.cli.as_deref(),
                kind: "done",
                text: &text,
                task_id: Some(id),
            },
            ctx,
        )?;
        post_seq = Some(s);
    }
    prune_team(&tx, uid, limits, 0, now)?;
    touch_team(&tx, uid, now)?;
    let task = task_out(&tx, &updated, now, DEFAULT_STALE_MS)?;
    finish(tx, limits)?;
    let mut out = json!({ "action": action.event(), "from": from, "to": to, "task": task, "expired": expired });
    if let Some(p) = post_seq {
        out["post"] = json!(p);
    }
    Ok(out)
}

const UNMET: &str = "EXISTS (SELECT 1 FROM task_deps d JOIN tasks x ON x.id = d.depends_on_id
    WHERE d.task_id = t.id AND d.deleted_at IS NULL AND x.deleted_at IS NULL AND x.state NOT IN ('done','cancelled'))";

/// Expire leases of one team in its own short write transaction, only when some ran out.
fn expire_if_needed(conn: &mut Connection, limits: Limits, uid: &str, now: i64, host: Option<&str>) -> Result<Vec<Value>, String> {
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND lease_until < ?2",
            params![uid, now],
            |r| r.get(0),
        )
        .db()?;
    if n == 0 {
        return Ok(Vec::new());
    }
    let tx = immediate(conn)?;
    let out = expire_leases(&tx, Some(uid), now, None, host)?;
    finish(tx, limits)?;
    Ok(out)
}

/// Tasks of a team (filters: stored states and the derived waiting/ready/stale, owner,
/// search), claimed first, then blocked, review, open, failed, done, cancelled; higher
/// priority first, then by number. Also counts per state and the derived counts.
pub fn task_list(conn: &mut Connection, limits: Limits, team: &str, q: &TaskListQuery, ctx: &Ctx) -> Result<Value, String> {
    check_team(team)?;
    let now = ctx.now;
    let stale = stale_ms(q.stale_ms);
    let mut stored: Vec<String> = Vec::new();
    let (mut want_waiting, mut want_ready, mut want_stale) = (false, q.ready, false);
    for s in &q.states {
        let s = s.trim().to_ascii_lowercase();
        match s.as_str() {
            "" => {}
            "waiting" => want_waiting = true,
            "ready" => want_ready = true,
            "stale" => want_stale = true,
            s if TASK_STATES.contains(&s) => stored.push(s.to_string()),
            other => return Err(format!("invalid state: {other} ({}|waiting|ready|stale)", TASK_STATES.join("|"))),
        }
    }
    let search = non_empty(&q.search);
    if let Some(s) = &search {
        if s.chars().count() > MAX_SEARCH_CHARS {
            return Err(format!("search text too long (max {MAX_SEARCH_CHARS} characters)"));
        }
    }
    let mut counts = serde_json::Map::new();
    for s in TASK_STATES {
        counts.insert(s.into(), json!(0));
    }
    counts.insert("waiting".into(), json!(0));
    counts.insert("stale".into(), json!(0));
    let Some(team_ref) = find_team(conn, team, ctx.host.as_deref())? else {
        return Ok(json!({ "team": team, "tasks": [], "matched": 0, "more": 0, "counts": counts, "expired": [] }));
    };
    let uid = team_ref.uid.clone();
    let expired = expire_if_needed(conn, limits, &uid, now, ctx.host.as_deref())?;
    let any_filter = !stored.is_empty() || want_waiting || want_ready || want_stale;
    if !any_filter && !q.all {
        stored = ["open", "claimed", "blocked", "review", "failed"].iter().map(|s| s.to_string()).collect();
    }
    let state_filter = !stored.is_empty() || want_waiting || want_ready || want_stale;
    let stored_json = serde_json::to_string(&stored).unwrap_or_else(|_| "[]".into());
    let pattern = search.as_deref().map(like_pattern);
    let mine = non_empty(&q.mine);
    let limit = q.limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let filter = format!(
        "t.team_uid = ?1 AND t.deleted_at IS NULL
         AND (?2 = 0 OR t.state IN (SELECT value FROM json_each(?3))
              OR (?4 = 1 AND t.state = 'open' AND {UNMET})
              OR (?5 = 1 AND t.state = 'open' AND NOT {UNMET})
              OR (?6 = 1 AND t.state IN ('claimed','blocked') AND t.updated_at < ?7))
         AND (?8 IS NULL OR t.owner_id = ?8)
         AND (?9 IS NULL OR t.title LIKE ?9 ESCAPE '\\' OR t.body LIKE ?9 ESCAPE '\\')"
    );
    let tx = conn.transaction().db()?;
    let stale_before = now - stale;
    let matched: i64 = tx
        .query_row(
            &format!("SELECT count(*) FROM tasks t WHERE {filter}"),
            params![uid, state_filter, stored_json, want_waiting, want_ready, want_stale, stale_before, mine, pattern],
            |r| r.get(0),
        )
        .db()?;
    let rows: Vec<TaskRow> = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {TASK_COLS} FROM tasks t WHERE {filter}
                 ORDER BY CASE t.state WHEN 'claimed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 WHEN 'open' THEN 3
                                       WHEN 'failed' THEN 4 WHEN 'done' THEN 5 ELSE 6 END, t.priority DESC, t.seq
                 LIMIT ?10"
            ))
            .db()?;
        let it = stmt
            .query_map(
                params![uid, state_filter, stored_json, want_waiting, want_ready, want_stale, stale_before, mine, pattern, limit],
                TaskRow::from_row,
            )
            .db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    let mut deps: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    {
        let mut stmt = tx
            .prepare(
                "SELECT d.task_id, x.seq, x.state FROM task_deps d JOIN tasks x ON x.id = d.depends_on_id
                 WHERE d.team_uid = ?1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
            )
            .db()?;
        let it = stmt
            .query_map(params![uid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))
            .db()?;
        for row in it {
            let (task, seq, state) = row.db()?;
            deps.entry(task).or_default().push((seq, state));
        }
    }
    {
        let mut stmt = tx.prepare("SELECT state, count(*) FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL GROUP BY state").db()?;
        let it = stmt.query_map(params![uid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).db()?;
        for row in it {
            let (s, n) = row.db()?;
            counts.insert(s, json!(n));
        }
    }
    let (waiting, stale_n): (i64, i64) = tx
        .query_row(
            &format!(
                "SELECT coalesce(sum(t.state = 'open' AND {UNMET}), 0),
                        coalesce(sum(t.state IN ('claimed','blocked') AND t.updated_at < ?2), 0)
                 FROM tasks t WHERE t.team_uid = ?1 AND t.deleted_at IS NULL"
            ),
            params![uid, stale_before],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .db()?;
    counts.insert("waiting".into(), json!(waiting));
    counts.insert("stale".into(), json!(stale_n));
    tx.commit().db()?;
    let tasks: Vec<Value> = rows
        .iter()
        .map(|r| task_json(r, deps.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), now, stale))
        .collect();
    let more = (matched - tasks.len() as i64).max(0);
    let mut out = json!({ "team": team, "tasks": tasks, "matched": matched, "more": more, "counts": counts, "expired": expired });
    if let Some(n) = team_ref.name {
        out["teamName"] = json!(n);
    }
    Ok(out)
}

fn brief_list(tx: &Connection, sql: &str, id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = tx.prepare(sql).db()?;
    let it = stmt
        .query_map(params![id], |r| {
            Ok(json!({ "seq": r.get::<_, i64>(0)?, "title": r.get::<_, String>(1)?, "state": r.get::<_, String>(2)? }))
        })
        .db()?;
    it.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// One task with its dependencies, dependents, parent and children; with `history` its
/// events (oldest first, at most the newest 500).
pub fn task_show(conn: &mut Connection, limits: Limits, team: &str, seq: i64, history: bool, stale: Option<i64>, ctx: &Ctx) -> Result<Value, String> {
    check_team(team)?;
    let now = ctx.now;
    let team_ref = find_team(conn, team, ctx.host.as_deref())?.ok_or_else(|| format!("no task #{seq} in team {team}"))?;
    let uid = team_ref.uid.as_str();
    let expired = expire_if_needed(conn, limits, uid, now, ctx.host.as_deref())?;
    let tx = conn.transaction().db()?;
    let row = load_task(&tx, uid, team, seq)?;
    let task = task_out(&tx, &row, now, stale_ms(stale))?;
    let deps = brief_list(
        &tx,
        "SELECT x.seq, x.title, x.state FROM task_deps d JOIN tasks x ON x.id = d.depends_on_id
         WHERE d.task_id = ?1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        &row.id,
    )?;
    let dependents = brief_list(
        &tx,
        "SELECT x.seq, x.title, x.state FROM task_deps d JOIN tasks x ON x.id = d.task_id
         WHERE d.depends_on_id = ?1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        &row.id,
    )?;
    let children = brief_list(
        &tx,
        "SELECT x.seq, x.title, x.state FROM tasks x WHERE x.parent_id = ?1 AND x.deleted_at IS NULL ORDER BY x.seq",
        &row.id,
    )?;
    let parent = match row.parent_seq {
        Some(p) => {
            let pr = load_task(&tx, uid, team, p)?;
            json!({ "seq": pr.seq, "title": pr.title, "state": pr.state })
        }
        None => Value::Null,
    };
    let mut out = json!({ "team": team, "task": task, "deps": deps, "dependents": dependents, "children": children, "parentTask": parent, "expired": expired });
    if history {
        let mut stmt = tx
            .prepare(
                "SELECT seq, ts, actor_id, actor_name, actor_host, action, from_state, to_state, attempt, note, data, id
                 FROM task_events WHERE task_id = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT ?2",
            )
            .db()?;
        let it = stmt
            .query_map(params![row.id, MAX_HISTORY], |r| {
                let data: Option<String> = r.get(10)?;
                Ok(json!({
                    "id": r.get::<_, String>(11)?,
                    "seq": r.get::<_, i64>(0)?,
                    "ts": r.get::<_, i64>(1)?,
                    "actor": party(&r.get(2)?, &r.get(3)?, &r.get(4)?),
                    "action": r.get::<_, String>(5)?,
                    "from": r.get::<_, Option<String>>(6)?,
                    "to": r.get::<_, Option<String>>(7)?,
                    "attempt": r.get::<_, Option<i64>>(8)?,
                    "note": r.get::<_, Option<String>>(9)?,
                    "data": data.as_deref().map(|d| parse_json(d, Value::Null)).unwrap_or(Value::Null),
                }))
            })
            .db()?;
        let mut events = it.collect::<rusqlite::Result<Vec<_>>>().db()?;
        events.reverse();
        out["events"] = Value::Array(events);
    }
    drop(tx);
    Ok(out)
}

// ── Leases ───────────────────────────────────────────────────────────────

/// Renew (one UPDATE) the lease of every claimed/blocked task of this instance whose owner
/// tab is alive, then report which owner tabs of this instance still hold tasks. A renewal
/// is a row update (row_version, change log) but not a content change (`updated_at` and
/// `version` stay, so "stale" still means no progress).
pub fn lease_tick(conn: &mut Connection, limits: Limits, instance: &str, alive: &[String], now: i64, lease: i64) -> Result<Value, String> {
    let alive_json = serde_json::to_string(alive).unwrap_or_else(|_| "[]".into());
    let tx = immediate(conn)?;
    let renewed: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "UPDATE tasks SET lease_until = ?1, heartbeat_at = ?2, row_version = row_version + 1
                 WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = ?3
                   AND owner_id IN (SELECT value FROM json_each(?4))
                 RETURNING id",
            )
            .db()?;
        let it = stmt.query_map(params![now + lease_ms(Some(lease)), now, instance, alive_json], |r| r.get(0)).db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    for id in &renewed {
        log_change(&tx, "tasks", id, now)?;
    }
    let holders: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT DISTINCT owner_id FROM tasks
                 WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = ?1 AND owner_id IS NOT NULL",
            )
            .db()?;
        let it = stmt.query_map(params![instance], |r| r.get(0)).db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    finish(tx, limits)?;
    Ok(json!({ "renewed": renewed.len(), "holders": holders }))
}

fn release_rows(tx: &Transaction, rows: Vec<TaskRow>, now: i64, host: Option<&str>, reason: &str) -> Result<Vec<Value>, String> {
    let app = Actor::app(host);
    let mut out = Vec::new();
    for row in rows {
        let n = update_task(
            tx,
            &row.id,
            "UPDATE tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL, owner_instance = NULL,
               lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL, updated_at = ?3, version = version + 1,
               row_version = row_version + 1
             WHERE id = ?1 AND state = ?2 AND deleted_at IS NULL",
            params![row.id, row.state, now],
            now,
        )?;
        if n == 0 {
            continue;
        }
        add_event(
            tx,
            &row,
            now,
            &app,
            "auto_release",
            Some(&row.state),
            Some("open"),
            row.attempt,
            Some(reason),
            Some(json!({ "ownerId": row.owner_id, "ownerInstance": row.owner_instance })),
            host,
        )?;
        touch_team(tx, &row.team_uid, now)?;
        out.push(json!({ "team": row.team, "seq": row.seq, "title": row.title, "ownerId": row.owner_id, "from": row.state }));
    }
    Ok(out)
}

/// The owner tab is gone (closed, exited): hand its claimed/blocked tasks back (auto_release).
#[allow(clippy::too_many_arguments)]
pub fn release_owner(
    conn: &mut Connection,
    limits: Limits,
    instance: &str,
    owner_id: &str,
    now: i64,
    host: Option<&str>,
    reason: &str,
) -> Result<Value, String> {
    let tx = immediate(conn)?;
    let rows: Vec<TaskRow> = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {TASK_COLS} FROM tasks t
                 WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_id = ?1 AND t.owner_instance = ?2"
            ))
            .db()?;
        let it = stmt.query_map(params![owner_id, instance], TaskRow::from_row).db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    let released = release_rows(&tx, rows, now, host, reason)?;
    finish(tx, limits)?;
    Ok(json!({ "released": released }))
}

/// Claimed/blocked tasks owned through any instance on `host` (for the startup decision).
pub fn held_on_host(conn: &mut Connection, host: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, tm.team, t.seq, t.state, t.owner_id, t.owner_name, t.owner_instance, t.lease_until, t.heartbeat_at
             FROM tasks t JOIN teams tm ON tm.uid = t.team_uid
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_host = ?1 ORDER BY tm.team, t.seq",
        )
        .db()?;
    let it = stmt
        .query_map(params![host], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?,
                "team": r.get::<_, String>(1)?,
                "seq": r.get::<_, i64>(2)?,
                "state": r.get::<_, String>(3)?,
                "ownerId": r.get::<_, Option<String>>(4)?,
                "ownerName": r.get::<_, Option<String>>(5)?,
                "ownerInstance": r.get::<_, Option<String>>(6)?,
                "leaseUntil": r.get::<_, Option<i64>>(7)?,
                "heartbeatAt": r.get::<_, Option<i64>>(8)?,
            }))
        })
        .db()?;
    it.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// Owner tabs that hold claimed/blocked tasks through this instance (the lease worker's input).
pub fn lease_holders(conn: &mut Connection, instance: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT owner_id FROM tasks
             WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = ?1 AND owner_id IS NOT NULL",
        )
        .db()?;
    let it = stmt.query_map(params![instance], |r| r.get(0)).db()?;
    it.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// App start: re-adopt (instance id updated, lease renewed) the tasks whose tab came back
/// through the PTY holder and release the rest — each only while still held by the instance
/// the caller saw.
#[allow(clippy::too_many_arguments)]
pub fn lease_apply(
    conn: &mut Connection,
    limits: Limits,
    instance: &str,
    adopt: &[LeaseItem],
    release: &[LeaseItem],
    now: i64,
    lease: i64,
    host: Option<&str>,
) -> Result<Value, String> {
    let tx = immediate(conn)?;
    let mut adopted = 0usize;
    for a in adopt {
        adopted += update_task(
            &tx,
            &a.id,
            "UPDATE tasks SET owner_instance = ?2, lease_until = ?3, heartbeat_at = ?4, row_version = row_version + 1
             WHERE id = ?1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = ?5",
            params![a.id, instance, now + lease_ms(Some(lease)), now, a.instance],
            now,
        )?;
    }
    let mut rows = Vec::new();
    for r in release {
        if let Some(row) = load_task_by_id(&tx, &r.id)? {
            if is_held(&row.state) && row.owner_instance.as_deref() == Some(r.instance.as_str()) {
                rows.push(row);
            }
        }
    }
    let released = release_rows(&tx, rows, now, host, "owner tab did not come back after the app restarted")?;
    finish(tx, limits)?;
    Ok(json!({ "adopted": adopted, "released": released }))
}
