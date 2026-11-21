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

use super::common::*;
use super::copy;
use super::model::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SCHEMA_VERSION: i64 = 4;

/// Version 4 (stage 3c, local only): notes this computer sent to a team whose home is another
/// computer. `state`: `pending` (not on the server yet) → `sent` (in the server outbox) →
/// `delivered` (the home numbered it; the row goes when the post arrives by pull) or `refused`
/// (`reason` is a stable code; the person dismisses it).
const SCHEMA_4: &str = "CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  team_uid TEXT NOT NULL,
  team TEXT NOT NULL,
  home_host TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  author_cli TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_team_state ON outbox(team_uid, state);";

/// Version 3 (stage 3b, local only): teams copied from other machines by sync. Such a team is
/// read-only here; its rows are never logged in `changes` nor pushed.
/// `mirror_ignored`: teams of other computers dropped by the mirror cap; a pull never brings
/// them back in part (cleared when the pull starts over).
const SCHEMA_3: &str = "CREATE TABLE IF NOT EXISTS mirror_teams (
  team_uid TEXT PRIMARY KEY NOT NULL,
  home_host TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mirror_ignored (
  team_uid TEXT PRIMARY KEY NOT NULL,
  at INTEGER NOT NULL
);";

/// Names this machine (`*_host`, `home_host`) when the file is migrated or data is imported;
/// called only then. The app passes its `board_host` (Settings name, environment, host name);
/// there is no default, so no store can ignore the Settings name.
pub type HostFn = Arc<dyn Fn() -> String + Send + Sync>;

pub struct SqliteStore {
    path: PathBuf,
    conn: Arc<Mutex<Option<Connection>>>,
    limits: Limits,
    host: HostFn,
    /// Recorded as `created_by_app_version` when the file is created.
    app_version: Arc<str>,
}

impl SqliteStore {
    /// A store on the board file at `path`; `host` names this machine, `app_version` is the
    /// version of the program using it (both recorded in the file).
    pub fn new(path: PathBuf, host: HostFn, app_version: &str) -> Self {
        Self::with_limits(path, Limits::default(), host, app_version)
    }

    /// This machine's host id as the store records it.
    pub fn host(&self) -> String {
        (self.host)()
    }

    /// The board file this store opens.
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn with_limits(path: PathBuf, limits: Limits, host: HostFn, app_version: &str) -> Self {
        SqliteStore { path, conn: Arc::new(Mutex::new(None)), limits, host, app_version: Arc::from(app_version) }
    }

    /// Run `f` on the (lazily opened) connection on the blocking pool. Needs a Tokio runtime
    /// (it uses `tokio::task::spawn_blocking`): call it from a task on one, or inside
    /// `Runtime::block_on`.
    pub async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Connection, Limits) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let conn = self.conn.clone();
        let path = self.path.clone();
        let limits = self.limits;
        let host = self.host.clone();
        let app_version = self.app_version.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_none() {
                *guard = Some(open_db(&path, &host(), &app_version)?);
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
fn migrate(conn: &mut Connection, now: i64, host: &str, app_version: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version = stored_version(&tx)?;
    if version < 2 {
        migrate_to_2(&tx, now, host)?;
    }
    if version < 3 {
        tx.execute_batch(SCHEMA_3)?;
    }
    if version < 4 {
        tx.execute_batch(SCHEMA_4)?;
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
            params![app_version],
        )?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    tx.commit()
}

/// Open (creating when missing) and migrate the board database at `path`; `host` names this
/// machine in a migration (the home of teams the file already had), `app_version` is recorded
/// as `created_by_app_version` in a new file.
pub fn open_db(path: &Path, host: &str, app_version: &str) -> Result<Connection, String> {
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
        migrate(&mut conn, now_ms(), host, app_version).map_err(unavailable)?;
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
    /// Home machine of a team copied here by sync (read-only here); None for this machine's.
    mirror: Option<String>,
}

/// The live team row this machine uses for root tab `team`: the one homed on `host`, else any
/// live one (most recently active first; a synced team from another machine).
fn find_team(c: &Connection, team: &str, host: Option<&str>) -> Result<Option<TeamRef>, String> {
    c.query_row(
        "SELECT t.uid, t.name, t.last_post_seq, m.home_host FROM teams t LEFT JOIN mirror_teams m ON m.team_uid = t.uid
         WHERE t.team = ?1 AND t.deleted_at IS NULL
         ORDER BY (m.team_uid IS NULL) DESC, (t.home_host IS ?2) DESC, t.last_activity_at DESC LIMIT 1",
        params![team, host],
        |r| Ok(TeamRef { uid: r.get(0)?, name: r.get(1)?, last_post_seq: r.get(2)?, mirror: r.get(3)? }),
    )
    .optional()
    .db()
}

/// Every write on a team that another machine owns is refused (stage 3b home rule).
fn refuse_mirror(c: &Connection, team: &str, host: Option<&str>) -> Result<(), String> {
    match find_team(c, team, host)? {
        Some(TeamRef { mirror: Some(home), .. }) => Err(read_only_message(&home)),
        _ => Ok(()),
    }
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
    /// A given id (a remote note keeps its outbox id); None: a new one.
    id: Option<&'a str>,
    /// The computer the author typed it on, when not this one (a remote note).
    author_host: Option<&'a str>,
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
    let id = p.id.map(str::to_string).unwrap_or_else(new_id);
    let arrival = log_change(tx, "posts", &id, now)?;
    tx.execute(
        "INSERT INTO posts(id, team_uid, seq, ts, author_id, author_name, author_cli, author_host, kind, text, task_id, arrival, origin_host, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?4)",
        params![id, p.team_uid, seq, now, p.author_id, p.author_name, p.author_cli, p.author_host.or(ctx.host.as_deref()), p.kind, p.text, p.task_id, arrival, ctx.host],
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
    let PostSpec { kind, text, author_id, author_name, author_cli, team_name } = PostSpec::check(team, input)?;
    let tx = immediate(conn)?;
    refuse_mirror(&tx, team, ctx.host.as_deref())?;
    let uid = ensure_team(&tx, team, team_name.as_deref(), ctx)?;
    let task_id = match input.task {
        Some(seq) => Some(task_id_of(&tx, &uid, team, seq)?),
        None => None,
    };
    let (id, _) = insert_post(
        &tx,
        limits,
        &NewPost {
            id: None,
            author_host: None,
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
    let spec = ReadSpec::check(team, q)?;
    let ReadSpec { limit, kind, author, exclude, cursor_tab, pinned, since, seq_after, .. } = &spec;
    let (limit, pinned, since, seq_after) = (*limit, *pinned, *since, *seq_after);
    let exclude_kind: Option<&str> = if pinned { Some("announce") } else { None };
    let tx = conn
        .transaction_with_behavior(if cursor_tab.is_some() {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })
        .db()?;
    let Some(t) = find_team(&tx, team, host)? else {
        return Ok(spec.empty(team));
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
    let pattern = spec.pattern.as_deref();
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
                    t.last_task_seq, t.home_host, t.uid,
                    (SELECT m.synced_at FROM mirror_teams m WHERE m.team_uid = t.uid)
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
            if let Some(at) = r.get::<_, Option<i64>>(12)? {
                v["mirror"] = Value::Bool(true);
                v["syncedAt"] = json!(at);
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
    if let Some(home) = &t.mirror {
        return Err(read_only_message(home));
    }
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
                 WHERE t.deleted_at IS NULL AND t.uid NOT IN (SELECT team_uid FROM mirror_teams)
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
    let purge_before = now - TOMBSTONE_RETENTION_MS;
    let synced = state_get(&tx, "server")?.is_some();
    if consumer == 0 && !synced {
        for table in ["posts", "task_events", "task_deps", "tasks", "teams"] {
            tx.execute(&format!("DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?1"), params![purge_before])
                .db()?;
        }
    } else {
        // This file has synced with a server (whatever the usage type is now): a tombstone of
        // this computer's team goes only once the server has it — it changed before the last
        // time every change was on the server (`caught_up`). Other computers' tombstones go
        // any time.
        let caught_up = state_int(&tx, "caught_up")?;
        for (table, team_col) in [("posts", "team_uid"), ("task_events", "team_uid"), ("task_deps", "team_uid"), ("tasks", "team_uid"), ("teams", "uid")] {
            tx.execute(
                &format!(
                    "DELETE FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < ?1
                       AND ({team_col} IN (SELECT team_uid FROM mirror_teams) OR updated_at < ?2)"
                ),
                params![purge_before, caught_up],
            )
            .db()?;
        }
        tx.execute("DELETE FROM mirror_teams WHERE team_uid NOT IN (SELECT uid FROM teams)", []).db()?;
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

fn task_from_row(r: &rusqlite::Row) -> rusqlite::Result<TaskRow> {
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

fn load_task(tx: &Connection, team_uid: &str, team: &str, seq: i64) -> Result<TaskRow, String> {
    tx.query_row(
        &format!("SELECT {TASK_COLS} FROM tasks t WHERE t.team_uid = ?1 AND t.seq = ?2 AND t.deleted_at IS NULL"),
        params![team_uid, seq],
        task_from_row,
    )
    .optional()
    .db()?
    .ok_or_else(|| format!("no task #{seq} in team {team}"))
}

fn load_task_by_id(tx: &Connection, id: &str) -> Result<Option<TaskRow>, String> {
    tx.query_row(&format!("SELECT {TASK_COLS} FROM tasks t WHERE t.id = ?1 AND t.deleted_at IS NULL"), params![id], task_from_row)
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
                   AND (?2 IS NULL OR t.team_uid = ?2) AND (?3 IS NULL OR t.id <> ?3)
                   AND t.team_uid NOT IN (SELECT team_uid FROM mirror_teams)"
            ))
            .db()?;
        let it = stmt.query_map(params![now, team_uid, except], task_from_row).db()?;
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

/// Add one task (state open) with its dependencies, in one IMMEDIATE transaction.
fn add_task(conn: &mut Connection, limits: Limits, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, String> {
    let spec = AddSpec::check(op)?;
    let (after, priority) = (&spec.after, spec.priority);
    let now = ctx.now;
    let tx = immediate(conn)?;
    refuse_mirror(&tx, team, ctx.host.as_deref())?;
    let uid = ensure_team(&tx, team, spec.team_name.as_deref(), ctx)?;
    let parent_id = match op.parent {
        Some(seq) => Some(task_id_of(&tx, &uid, team, seq)?),
        None => None,
    };
    let id = new_id();
    let mut dep_ids = Vec::new();
    for seq in after {
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
            spec.title,
            spec.body,
            priority,
            spec.review,
            actor.id,
            actor.name,
            actor.host,
            spec.max_attempts,
            spec.labels_json(),
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
        Some(json!({ "parent": op.parent, "after": after, "priority": priority, "review": spec.review })),
        ctx.host.as_deref(),
    )?;
    prune_team(&tx, &uid, limits, 0, now)?;
    let task = task_out(&tx, &row, now, DEFAULT_STALE_MS)?;
    finish(tx, limits)?;
    Ok(json!({ "action": "add", "from": Value::Null, "to": "open", "task": task, "expired": [] }))
}

/// `claim --next --label`: the task carries one of the labels in JSON array `?2` (`[]` = any task).
const LABEL_MATCH: &str = "(?2 = '[]' OR EXISTS (SELECT 1 FROM json_each(t.labels) l WHERE l.value IN (SELECT value FROM json_each(?2))))";

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
    let WriteSpec { action, reason, result, claim_next, next_labels, lease } = WriteSpec::check(name, op)?;
    // claim --next --label: only tasks carrying one of these labels ('[]' = any).
    let label_filter = serde_json::to_string(&next_labels).unwrap_or_else(|_| "[]".into());
    let now = ctx.now;
    let host = ctx.host.as_deref();
    let tx = immediate(conn)?;
    let Some(team_ref) = find_team(&tx, team, host)? else {
        if claim_next {
            return Ok(json!({ "action": "claim", "task": Value::Null, "open": 0, "waiting": 0, "expired": [], "none": "no open task to claim" }));
        }
        return Err(format!("no task #{} in team {team}", op.task.unwrap_or(0)));
    };
    if let Some(home) = &team_ref.mirror {
        return Err(read_only_message(home));
    }
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
                         AND {LABEL_MATCH}
                         ORDER BY t.priority DESC, t.seq LIMIT 1"
                    ),
                    params![uid, label_filter],
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
                                 WHERE t.team_uid = ?1 AND t.deleted_at IS NULL AND t.state = 'open' AND {LABEL_MATCH}"
                            ),
                            params![uid, label_filter],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .db()?;
                    finish(tx, limits)?;
                    return Ok(none_ready(open, waiting, expired));
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
            let EditSpec { title, body, labels, fields } = EditSpec::check(op)?;
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
                id: None,
                author_host: None,
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
    let now = ctx.now;
    let ListSpec { stale, stored, want_waiting, want_ready, want_stale, state_filter, pattern, mine, limit } = ListSpec::check(team, q)?;
    let mut counts = ListSpec::zero_counts();
    let Some(team_ref) = find_team(conn, team, ctx.host.as_deref())? else {
        return Ok(json!({ "team": team, "tasks": [], "matched": 0, "more": 0, "counts": counts, "expired": [] }));
    };
    let uid = team_ref.uid.clone();
    // Leases are evaluated only at home: a team copied from another machine shows what it got.
    let expired = if team_ref.mirror.is_some() { Vec::new() } else { expire_if_needed(conn, limits, &uid, now, ctx.host.as_deref())? };
    let stored_json = serde_json::to_string(&stored).unwrap_or_else(|_| "[]".into());
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
                task_from_row,
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
    let expired = if team_ref.mirror.is_some() { Vec::new() } else { expire_if_needed(conn, limits, uid, now, ctx.host.as_deref())? };
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

/// The newest task events of every task of a team (the viewer's activity feed), oldest first,
/// each with its task's `#seq`; `more` counts matching events not returned. Read only (no
/// lease expiry: the viewer's task list does that).
pub fn team_events(conn: &mut Connection, team: &str, q: &EventsQuery, host: Option<&str>) -> Result<Value, String> {
    check_team(team)?;
    let (limit, since) = q.check();
    let Some(team_ref) = find_team(conn, team, host)? else {
        return Ok(json!({ "team": team, "events": [], "more": 0 }));
    };
    let tx = conn.transaction().db()?;
    let from = "FROM task_events e JOIN tasks x ON x.id = e.task_id
                WHERE e.team_uid = ?1 AND e.deleted_at IS NULL AND x.deleted_at IS NULL AND e.ts > ?2";
    let matched: i64 = tx.query_row(&format!("SELECT count(*) {from}"), params![team_ref.uid, since], |r| r.get(0)).db()?;
    let mut events = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT e.seq, e.ts, e.actor_id, e.actor_name, e.actor_host, e.action, e.from_state, e.to_state, e.attempt,
                        e.note, e.id, x.seq {from} ORDER BY e.ts DESC, e.id DESC LIMIT ?3"
            ))
            .db()?;
        let it = stmt
            .query_map(params![team_ref.uid, since, limit], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(10)?,
                    "task": r.get::<_, i64>(11)?,
                    "seq": r.get::<_, i64>(0)?,
                    "ts": r.get::<_, i64>(1)?,
                    "actor": party(&r.get(2)?, &r.get(3)?, &r.get(4)?),
                    "action": r.get::<_, String>(5)?,
                    "from": r.get::<_, Option<String>>(6)?,
                    "to": r.get::<_, Option<String>>(7)?,
                    "attempt": r.get::<_, Option<i64>>(8)?,
                    "note": r.get::<_, Option<String>>(9)?,
                }))
            })
            .db()?;
        it.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    drop(tx);
    events.reverse();
    let more = (matched - events.len() as i64).max(0);
    Ok(json!({ "team": team, "events": events, "more": more }))
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
                 WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_id = ?1 AND t.owner_instance = ?2
                   AND t.team_uid NOT IN (SELECT team_uid FROM mirror_teams)"
            ))
            .db()?;
        let it = stmt.query_map(params![owner_id, instance], task_from_row).db()?;
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
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_host = ?1
               AND t.team_uid NOT IN (SELECT team_uid FROM mirror_teams) ORDER BY tm.team, t.seq",
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
             WHERE id = ?1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = ?5
               AND team_uid NOT IN (SELECT team_uid FROM mirror_teams)",
            params![a.id, instance, now + lease_ms(Some(lease)), now, a.instance],
            now,
        )?;
    }
    let mut rows = Vec::new();
    let mirrors: HashSet<String> = {
        let mut stmt = tx.prepare("SELECT team_uid FROM mirror_teams").db()?;
        let rows = stmt.query_map([], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<HashSet<_>>>().db()?
    };
    for r in release {
        if let Some(row) = load_task_by_id(&tx, &r.id)? {
            if is_held(&row.state) && row.owner_instance.as_deref() == Some(r.instance.as_str()) && !mirrors.contains(&row.team_uid) {
                rows.push(row);
            }
        }
    }
    let released = release_rows(&tx, rows, now, host, "owner tab did not come back after the app restarted")?;
    finish(tx, limits)?;
    Ok(json!({ "adopted": adopted, "released": released }))
}

// ── Sync (stage 3b; orchestration in sync.rs) ────────────────────────────
//
// Local side of syncing with a shared PostgreSQL: `sync_state` keys `consumer` (sync is on, so
// `changes` is trimmed only below `pushed_seq`), `pushed_seq`, `pulled_seq`, `full_push`
// (+ `full_pos`), `skipped`; `board_meta.instance_id` is this file's machine identity.

fn state_get(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT value FROM sync_state WHERE key = ?1", params![key], |r| r.get(0)).optional().db().map(Option::flatten)
}

fn state_int(c: &Connection, key: &str) -> Result<i64, String> {
    Ok(state_get(c, key)?.and_then(|v| v.trim().parse().ok()).unwrap_or(0))
}

fn state_set(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO sync_state(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .db()?;
    Ok(())
}

fn state_del(c: &Connection, key: &str) -> Result<(), String> {
    c.execute("DELETE FROM sync_state WHERE key = ?1", params![key]).db()?;
    Ok(())
}

/// Live teams this machine owns: not copied from elsewhere, homed on `host`.
const HOME_UIDS: &str = "SELECT uid FROM teams WHERE home_host = ?1 AND uid NOT IN (SELECT team_uid FROM mirror_teams)";

/// Every team whose home is another computer and that is not marked yet becomes read-only
/// here (copied in from PostgreSQL, or left by an earlier name).
fn register_mirrors(tx: &Transaction, host: &str, now: i64) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO mirror_teams(team_uid, home_host, synced_at)
         SELECT uid, home_host, ?2 FROM teams WHERE home_host IS NOT NULL AND home_host <> ?1",
        params![host, now],
    )
    .db()?;
    Ok(())
}

fn meta_get(c: &Connection, key: &str) -> Result<Option<String>, String> {
    c.query_row("SELECT value FROM board_meta WHERE key = ?1", params![key], |r| r.get::<_, Option<String>>(0)).optional().db().map(Option::flatten)
}

fn meta_set(c: &Connection, key: &str, value: &str) -> Result<(), String> {
    c.execute(
        "INSERT INTO board_meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .db()?;
    Ok(())
}

/// Start of a sync round, as computer `host` on server `server` (`label|schema`):
/// - `machine` (a hash of the OS machine id, when readable) differs from the stored one → the
///   board file was copied to another computer: it gets a new `instance_id`, so the server's
///   `hosts` sees a name clash instead of two computers writing as one;
/// - the name this file's teams are homed under (`board_meta.home_name`) differs from `host`
///   while live teams or unsent changes carry it → pause (`name_changed`) instead of orphaning
///   them; otherwise the new name is taken;
/// - teams homed elsewhere are marked read-only; sync is marked on (first time, after sync was
///   off, or a new server: everything is sent again as a full snapshot); a backlog over
///   `limits.changes` becomes a full push.
pub fn sync_prepare(
    conn: &mut Connection,
    limits: Limits,
    server: &str,
    host: &str,
    machine: Option<&str>,
    now: i64,
) -> Result<super::sync_core::LocalState, String> {
    let tx = immediate(conn)?;
    let mut instance = meta_get(&tx, "instance_id")?;
    if let Some(m) = machine {
        match meta_get(&tx, "machine")? {
            Some(stored) if stored != m => {
                instance = None;
                meta_set(&tx, "machine", m)?;
            }
            None => meta_set(&tx, "machine", m)?,
            Some(_) => {}
        }
    }
    let instance = match instance {
        Some(v) => v,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            meta_set(&tx, "instance_id", &id)?;
            id
        }
    };
    let pushed = state_int(&tx, "pushed_seq")?;
    match meta_get(&tx, "home_name")? {
        None => meta_set(&tx, "home_name", host)?,
        Some(old) if old != host => {
            let live: i64 = tx
                .query_row(
                    "SELECT count(*) FROM teams WHERE deleted_at IS NULL AND home_host = ?1 AND uid NOT IN (SELECT team_uid FROM mirror_teams)",
                    params![old],
                    |r| r.get(0),
                )
                .db()?;
            let waiting: i64 = if state_get(&tx, "consumer")?.is_some() {
                tx.query_row("SELECT count(*) FROM changes WHERE local_seq > ?1", params![pushed], |r| r.get(0)).db()?
            } else {
                0
            };
            if live > 0 || waiting > 0 {
                let mut out = sync_local_state(&tx, instance)?;
                out.pause = Some((
                    "name_changed",
                    format!(
                        "this computer's name changed from {old} to {host}; change it back, or wait until the teams named for {old} are gone"
                    ),
                ));
                out.old_name = Some(old);
                tx.commit().db()?;
                return Ok(out);
            }
            meta_set(&tx, "home_name", host)?;
        }
        Some(_) => {}
    }
    register_mirrors(&tx, host, now)?;
    // Another server (or schema) than last time: its numbers mean nothing here, start over.
    if state_get(&tx, "server")?.as_deref() != Some(server) {
        state_set(&tx, "server", server)?;
        state_del(&tx, "pulled_seq")?;
        state_del(&tx, "consumer")?;
        state_del(&tx, "caught_up")?;
        state_del(&tx, "server_uid")?;
        tx.execute("DELETE FROM mirror_ignored", []).db()?;
    }
    if state_get(&tx, "consumer")?.is_none() {
        state_set(&tx, "consumer", &now.to_string())?;
        state_set(&tx, "full_push", "1")?;
        state_del(&tx, "full_pos")?;
    }
    let max: i64 = tx.query_row("SELECT coalesce(max(local_seq), 0) FROM changes", [], |r| r.get(0)).db()?;
    if max - pushed > limits.changes && state_get(&tx, "full_push")?.is_none() {
        tx.execute("DELETE FROM changes", []).db()?;
        state_set(&tx, "full_push", "1")?;
        state_del(&tx, "full_pos")?;
    }
    let out = sync_local_state(&tx, instance)?;
    tx.commit().db()?;
    Ok(out)
}

fn sync_local_state(c: &Connection, instance: String) -> Result<super::sync_core::LocalState, String> {
    let pushed = state_int(c, "pushed_seq")?;
    let waiting: i64 = c.query_row("SELECT count(*) FROM changes WHERE local_seq > ?1", params![pushed], |r| r.get(0)).db()?;
    Ok(super::sync_core::LocalState {
        instance,
        full_push: state_get(c, "full_push")?.is_some(),
        waiting,
        pulled_seq: state_int(c, "pulled_seq")?,
        skipped: state_int(c, "skipped")?,
        pause: None,
        old_name: None,
    })
}

/// The server this file syncs with, by identity (`server_uid`) and position: a different uid
/// (or a uid on a server this file synced with before it had one, while cursors are non-zero)
/// is `server_replaced`; the same uid with `board_server_seq` below `pulled_seq` is
/// `server_restored` (from a backup). Either resets this file's side: the pull starts at 0, a
/// full push of this computer's teams is due, the mirror-cap ignore list is cleared; notes on
/// their way are sent again (`sent` → `pending`; `delivered` whose post is not here →
/// `pending`, so the home delivers it again or, if its post exists there, reports it
/// delivered; a delivered one whose post is here goes). Copies of other computers' teams stay
/// as they are. The event is stored once (`server_event`, `server_event_at`) for the status.
/// Returns the event code, if any.
pub fn sync_check_server(conn: &mut Connection, uid: &str, server_last: i64, now: i64) -> Result<Option<&'static str>, String> {
    let tx = immediate(conn)?;
    let stored = state_get(&tx, "server_uid")?;
    let pulled = state_int(&tx, "pulled_seq")?;
    let pushed = state_int(&tx, "pushed_seq")?;
    let event = match stored.as_deref() {
        _ if uid.is_empty() => None,
        Some(s) if s != uid => Some("server_replaced"),
        None if pulled > 0 || pushed > 0 => Some("server_replaced"),
        _ if server_last < pulled => Some("server_restored"),
        _ => None,
    };
    if !uid.is_empty() {
        state_set(&tx, "server_uid", uid)?;
    }
    if let Some(code) = event {
        state_set(&tx, "pulled_seq", "0")?;
        state_set(&tx, "full_push", "1")?;
        state_del(&tx, "full_pos")?;
        state_del(&tx, "caught_up")?;
        tx.execute("DELETE FROM mirror_ignored", []).db()?;
        tx.execute("UPDATE outbox SET state = 'pending', sent_at = NULL WHERE state = 'sent'", []).db()?;
        tx.execute("DELETE FROM outbox WHERE state = 'delivered' AND id IN (SELECT id FROM posts)", []).db()?;
        tx.execute("UPDATE outbox SET state = 'pending', sent_at = NULL WHERE state = 'delivered'", []).db()?;
        state_set(&tx, "server_event", code)?;
        state_set(&tx, "server_event_at", &now.to_string())?;
    }
    tx.commit().db()?;
    Ok(event)
}

/// The local sync facts as they are now (after `sync_check_server` reset them).
pub fn sync_state_now(conn: &mut Connection) -> Result<super::sync_core::LocalState, String> {
    let instance = meta_get(conn, "instance_id")?.unwrap_or_default();
    sync_local_state(conn, instance)
}

/// Every change up to now is on the server (no change waits, no full push pending): tombstones
/// last changed before `now` may be purged later (`prune_stale`).
pub fn sync_mark_caught_up(conn: &mut Connection, now: i64) -> Result<(), String> {
    let tx = immediate(conn)?;
    let pushed = state_int(&tx, "pushed_seq")?;
    let waiting: i64 = tx.query_row("SELECT count(*) FROM changes WHERE local_seq > ?1", params![pushed], |r| r.get(0)).db()?;
    if waiting == 0 && state_get(&tx, "full_push")?.is_none() {
        state_set(&tx, "caught_up", &now.to_string())?;
    }
    tx.commit().db()
}

/// Rows the server refused (a clash with its unique rules, or it holds a newer version): counted
/// with the first reason, shown in the status.
pub fn sync_note_refused(conn: &mut Connection, n: u64, reason: Option<&str>) -> Result<(), String> {
    if n == 0 {
        return Ok(());
    }
    let tx = immediate(conn)?;
    let total = state_int(&tx, "refused")? + n as i64;
    state_set(&tx, "refused", &total.to_string())?;
    if let Some(r) = reason {
        if state_get(&tx, "refused_reason")?.is_none() {
            state_set(&tx, "refused_reason", r)?;
        }
    }
    tx.commit().db()
}

/// Sync was turned off: stop holding the change log for it; the next time sync is turned on
/// this computer's teams are pushed again in full. Mirrors stay, and so does `server`, so
/// tombstones not on the server yet are kept until a later sync sends them.
pub fn sync_release(conn: &mut Connection) -> Result<(), String> {
    let tx = immediate(conn)?;
    if state_get(&tx, "consumer")?.is_some() {
        state_del(&tx, "consumer")?;
        state_set(&tx, "full_push", "1")?;
        state_del(&tx, "full_pos")?;
    }
    tx.commit().db()
}

/// What the status shows: waiting rows, skipped and refused rows, teams per other computer.
pub fn sync_status_local(conn: &mut Connection) -> Result<Value, String> {
    let instance = meta_get(conn, "instance_id")?;
    let st = sync_local_state(conn, instance.clone().unwrap_or_default())?;
    let mut stmt = conn
        .prepare(
            "SELECT m.home_host, count(*), max(m.synced_at) FROM mirror_teams m JOIN teams t ON t.uid = m.team_uid
             WHERE t.deleted_at IS NULL GROUP BY m.home_host ORDER BY m.home_host",
        )
        .db()?;
    let machines = stmt
        .query_map([], |r| Ok(json!({ "host": r.get::<_, String>(0)?, "teams": r.get::<_, i64>(1)?, "syncedAt": r.get::<_, i64>(2)? })))
        .db()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .db()?;
    let (outbox_waiting, outbox_refused): (i64, i64) = conn
        .query_row(
            "SELECT count(*) FILTER (WHERE state IN ('pending','sent','delivered')), count(*) FILTER (WHERE state = 'refused') FROM outbox",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .db()?;
    Ok(json!({
        "instanceId": instance,
        "outboxWaiting": outbox_waiting,
        "outboxRefused": outbox_refused,
        "keptRows": state_int(conn, "kept_rows")?,
        "serverEvent": state_get(conn, "server_event")?,
        "serverEventAt": state_get(conn, "server_event_at")?.and_then(|v| v.parse::<i64>().ok()),
        "keptFile": state_get(conn, "kept_file")?,
        "waiting": st.waiting,
        "fullPush": st.full_push,
        "skipped": st.skipped,
        "refused": state_int(conn, "refused")?,
        "refusedReason": state_get(conn, "refused_reason")?,
        "machines": machines,
    }))
}

/// Live teams homed on `host` (renaming the machine is refused while there are any).
pub fn live_home_teams(conn: &mut Connection, host: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(*) FROM teams WHERE deleted_at IS NULL AND home_host = ?1 AND uid NOT IN (SELECT team_uid FROM mirror_teams)",
        params![host],
        |r| r.get(0),
    )
    .db()
}

/// Rows as cells in `cols` order; `with_key`: the statement selects one more text column (the
/// keyset position), appended as a last cell.
fn read_cells(stmt: &mut rusqlite::Statement, cols: copy::Cols, args: &[&dyn rusqlite::ToSql], with_key: bool) -> Result<Vec<Vec<copy::Cell>>, String> {
    let rows = stmt
        .query_map(args, |r| {
            let mut cells = Vec::with_capacity(cols.len() + 1);

            for (i, (_, kind)) in cols.iter().enumerate() {
                cells.push(match kind {
                    copy::Kind::Int => r.get::<_, Option<i64>>(i)?.map_or(copy::Cell::Null, copy::Cell::Int),
                    copy::Kind::Text => r.get::<_, Option<String>>(i)?.map_or(copy::Cell::Null, copy::Cell::Text),
                });
            }
            if with_key {
                cells.push(r.get::<_, Option<String>>(cols.len())?.map_or(copy::Cell::Null, copy::Cell::Text));
            }
            Ok(cells)
        })
        .db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// Row key column (SQL) of a synced table, as `changes.row_id` stores it.
fn key_sql(table: &str) -> &'static str {
    match table {
        "teams" => "uid",
        "task_deps" => "task_id || '/' || depends_on_id",
        _ => "id",
    }
}

fn team_col(table: &str) -> &'static str {
    if table == "teams" {
        "uid"
    } else {
        "team_uid"
    }
}

/// The next push batch: changes after `pushed_seq` (at most `max`), collapsed to distinct rows,
/// loaded as they are now (tombstones included), only rows of teams homed on `host`.
/// Returns (last change position covered, rows) or None when nothing waits.
pub fn sync_push_batch(conn: &mut Connection, host: &str, max: i64) -> Result<Option<(i64, copy::Dump)>, String> {
    let tx = conn.transaction().db()?;
    let pushed = state_int(&tx, "pushed_seq")?;
    let changes: Vec<(i64, String, String)> = {
        let mut stmt = tx.prepare("SELECT local_seq, tbl, row_id FROM changes WHERE local_seq > ?1 ORDER BY local_seq LIMIT ?2").db()?;
        let rows = stmt.query_map(params![pushed, max], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    let Some(upto) = changes.last().map(|c| c.0) else { return Ok(None) };
    let mut seen = HashSet::new();
    let mut dump = copy::Dump::default();
    for (table, cols) in super::sync_core::SYNC_TABLES {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {} FROM {table} WHERE {} = ?1 AND {} IN ({HOME_UIDS_Q})",
                copy::col_list(cols),
                key_sql(table),
                team_col(table),
                HOME_UIDS_Q = HOME_UIDS.replace("?1", "?2"),
            ))
            .db()?;
        for (_, tbl, id) in &changes {
            if tbl != table || !seen.insert((tbl.clone(), id.clone())) {
                continue;
            }
            dump.rows_mut(table).extend(read_cells(&mut stmt, cols, &[id, &host], false)?);
        }
    }
    Ok(Some((upto, dump)))
}

/// The next full-push batch (one table at a time, keyset order, tombstones included) of the
/// teams homed on `host`. Returns (position after this batch or None when it was the last,
/// rows). A full push starting marks every change so far as covered by the snapshot.
pub fn sync_full_batch(conn: &mut Connection, host: &str, max: i64) -> Result<(Option<String>, copy::Dump), String> {
    let tx = immediate(conn)?;
    let pos = match state_get(&tx, "full_pos")? {
        Some(p) => p,
        None => {
            let top: i64 = tx.query_row("SELECT coalesce(max(local_seq), 0) FROM changes", [], |r| r.get(0)).db()?;
            state_set(&tx, "full_from", &top.to_string())?;
            "0|".to_string()
        }
    };
    tx.commit().db()?;
    let (idx, last) = pos.split_once('|').map(|(i, l)| (i.parse::<usize>().unwrap_or(0), l.to_string())).unwrap_or((0, String::new()));
    let mut dump = copy::Dump::default();
    let Some((table, cols)) = super::sync_core::SYNC_TABLES.get(idx).copied() else { return Ok((None, dump)) };
    let key = key_sql(table);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {}, {key} FROM {table} WHERE {key} > ?1 AND {} IN ({}) ORDER BY {key} LIMIT ?3",
            copy::col_list(cols),
            team_col(table),
            HOME_UIDS.replace("?1", "?2"),
        ))
        .db()?;
    let mut rows = read_cells(&mut stmt, cols, &[&last, &host, &max], true)?;
    let next_key = rows.last().and_then(|r| r.last()).and_then(|c| c.text()).map(str::to_string);
    for r in rows.iter_mut() {
        r.pop();
    }
    let n = rows.len() as i64;
    *dump.rows_mut(table) = rows;
    let next = if n >= max {
        Some(format!("{idx}|{}", next_key.unwrap_or_default()))
    } else if idx + 1 < super::sync_core::SYNC_TABLES.len() {
        Some(format!("{}|", idx + 1))
    } else {
        None
    };
    Ok((next, dump))
}

/// A push batch is on the server: remember it and drop the change rows it covered.
pub fn sync_push_done(conn: &mut Connection, upto: i64) -> Result<(), String> {
    let tx = immediate(conn)?;
    let pushed = state_int(&tx, "pushed_seq")?.max(upto);
    state_set(&tx, "pushed_seq", &pushed.to_string())?;
    tx.execute("DELETE FROM changes WHERE local_seq <= ?1", params![pushed]).db()?;
    tx.commit().db()
}

/// A full-push batch is on the server: move on, or finish (the changes the snapshot covered
/// count as pushed; later ones go by the normal push).
pub fn sync_full_done(conn: &mut Connection, next: Option<&str>) -> Result<(), String> {
    let tx = immediate(conn)?;
    match next {
        Some(p) => state_set(&tx, "full_pos", p)?,
        None => {
            let from = state_int(&tx, "full_from")?;
            let pushed = state_int(&tx, "pushed_seq")?.max(from);
            state_set(&tx, "pushed_seq", &pushed.to_string())?;
            tx.execute("DELETE FROM changes WHERE local_seq <= ?1", params![pushed]).db()?;
            for k in ["full_push", "full_pos", "full_from"] {
                state_del(&tx, k)?;
            }
        }
    }
    tx.commit().db()
}

/// A local read position for a pulled post: the next change-log position, taken without adding
/// a change row (pulled rows are never pushed back).
fn next_arrival(tx: &Transaction) -> Result<i64, String> {
    tx.execute("INSERT INTO sqlite_sequence(name, seq) SELECT 'changes', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'changes')", [])
        .db()?;
    tx.query_row("UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'changes' RETURNING seq", [], |r| r.get(0)).db()
}

fn to_value(c: &copy::Cell) -> rusqlite::types::Value {
    match c {
        copy::Cell::Null => rusqlite::types::Value::Null,
        copy::Cell::Int(n) => rusqlite::types::Value::Integer(*n),
        copy::Cell::Text(s) => rusqlite::types::Value::Text(s.clone()),
    }
}

/// Apply pulled rows (teams homed elsewhere) in one transaction, never through `log_change`:
/// each row is checked like local input (a bad one is skipped and counted, never written),
/// rows of teams this machine owns and team rows naming this machine as home are ignored, an
/// existing row is replaced only by a higher `row_version` of the same team, a new post gets a
/// local read position. Then the per-team caps and the mirror-team cap are applied locally
/// (dropped rows are deleted, not tombstoned). `pulled_seq` moves to `cursor` in the same
/// transaction.
pub fn sync_apply_pull(
    conn: &mut Connection,
    limits: Limits,
    host: &str,
    rows: &copy::Dump,
    cursor: i64,
    now: i64,
) -> Result<super::sync_core::PullApplied, String> {
    let tx = immediate(conn)?;
    let mut out = super::sync_core::PullApplied::default();
    let mut touched: HashSet<String> = HashSet::new();
    let is_home = |tx: &Transaction, uid: &str| -> Result<bool, String> {
        tx.query_row(
            "SELECT count(*) FROM teams WHERE uid = ?1 AND uid NOT IN (SELECT team_uid FROM mirror_teams)",
            params![uid],
            |r| r.get::<_, i64>(0),
        )
        .db()
        .map(|n| n > 0)
    };
    for (table, cols) in super::sync_core::SYNC_TABLES {
        let at = |name: &str| copy::col_index(cols, name);
        let pk: Vec<&str> = match table {
            "teams" => vec!["uid"],
            "task_deps" => vec!["task_id", "depends_on_id"],
            _ => vec!["id"],
        };
        let where_pk = pk.iter().enumerate().map(|(i, k)| format!("{k} = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
        let names = copy::col_list(cols);
        let set = cols
            .iter()
            .enumerate()
            .filter(|(_, (c, _))| !pk.contains(c))
            .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let insert_cols = if table == "posts" { format!("{names}, arrival") } else { names.clone() };
        let ph = (1..=cols.len() + usize::from(table == "posts")).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        for row in rows.rows(table) {
            if let Err(_why) = super::sync_core::validate_row(table, cols, row) {
                out.skipped += 1;
                continue;
            }
            let team_uid = row[at(team_col(table))].text().unwrap_or_default().to_string();
            if table == "teams" && row[at("home_host")].text() == Some(host) {
                continue;
            }
            // Dropped by the mirror cap: never brought back in part.
            let ignored: i64 = tx.query_row("SELECT count(*) FROM mirror_ignored WHERE team_uid = ?1", params![team_uid], |r| r.get(0)).db()?;
            if ignored > 0 {
                continue;
            }
            if is_home(&tx, &team_uid)? {
                continue;
            }
            if table != "teams" {
                let mirror: i64 = tx.query_row("SELECT count(*) FROM mirror_teams WHERE team_uid = ?1", params![team_uid], |r| r.get(0)).db()?;
                if mirror == 0 {
                    out.skipped += 1;
                    continue;
                }
            }
            let key: Vec<rusqlite::types::Value> = pk.iter().map(|k| to_value(&row[at(k)])).collect();
            let existing: Option<(i64, String)> = tx
                .query_row(
                    &format!("SELECT row_version, {} FROM {table} WHERE {where_pk}", team_col(table)),
                    rusqlite::params_from_iter(key.iter()),
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .db()?;
            let rv = row[at("row_version")].int().unwrap_or(0);
            let values: Vec<rusqlite::types::Value> = row.iter().map(to_value).collect();
            let res = match existing {
                Some((_, other_team)) if other_team != team_uid => {
                    out.skipped += 1;
                    continue;
                }
                Some((stored, _)) if stored >= rv => continue,
                Some(_) => tx.execute(
                    &format!("UPDATE {table} SET {set} WHERE {}", pk.iter().map(|k| format!("{k} = ?{}", at(k) + 1)).collect::<Vec<_>>().join(" AND ")),
                    rusqlite::params_from_iter(values.iter()),
                ),
                None => {
                    let mut values = values;
                    if table == "posts" {
                        values.push(rusqlite::types::Value::Integer(next_arrival(&tx)?));
                        // A note this computer sent arrived as the home's numbered post.
                        if let Some(id) = row[at("id")].text() {
                            tx.execute("DELETE FROM outbox WHERE id = ?1", params![id]).db()?;
                        }
                    }
                    tx.execute(&format!("INSERT INTO {table} ({insert_cols}) VALUES ({ph})"), rusqlite::params_from_iter(values.iter()))
                }
            };
            match res {
                Ok(_) => {
                    out.written += 1;
                    if table == "teams" {
                        let home = row[at("home_host")].text().unwrap_or_default();
                        tx.execute(
                            "INSERT INTO mirror_teams(team_uid, home_host, synced_at) VALUES (?1, ?2, ?3)
                             ON CONFLICT(team_uid) DO UPDATE SET home_host = excluded.home_host, synced_at = excluded.synced_at",
                            params![team_uid, home, now],
                        )
                        .db()?;
                    }
                    touched.insert(team_uid);
                }
                // A row that breaks a local constraint (e.g. a duplicate number) is not written.
                Err(_) => out.skipped += 1,
            }
        }
    }
    for uid in &touched {
        tx.execute("UPDATE mirror_teams SET synced_at = ?2 WHERE team_uid = ?1", params![uid, now]).db()?;
        // Per-team caps (the home enforces them too; this bounds a misbehaving server).
        tx.execute(
            "DELETE FROM posts WHERE id IN (SELECT id FROM posts WHERE team_uid = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT -1 OFFSET ?2)",
            params![uid, limits.posts],
        )
        .db()?;
        tx.execute(
            "DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE team_uid = ?1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT -1 OFFSET ?2)",
            params![uid, limits.tasks],
        )
        .db()?;
        tx.execute(
            "DELETE FROM task_events WHERE id IN (SELECT id FROM task_events WHERE team_uid = ?1 AND deleted_at IS NULL ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?2)",
            params![uid, limits.events],
        )
        .db()?;
        if let Some(team) = tx.query_row("SELECT team FROM teams WHERE uid = ?1", params![uid], |r| r.get::<_, String>(0)).optional().db()? {
            out.teams.push(team);
        }
    }
    // At most MAX_MIRROR_TEAMS teams from other machines: the least recently active go.
    let over: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT m.team_uid FROM mirror_teams m LEFT JOIN teams t ON t.uid = m.team_uid
                 ORDER BY coalesce(t.last_activity_at, 0) DESC, m.team_uid LIMIT -1 OFFSET ?1",
            )
            .db()?;
        let rows = stmt.query_map(params![super::sync_core::MAX_MIRROR_TEAMS], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    for uid in &over {
        drop_mirror(&tx, uid)?;
        tx.execute("INSERT OR IGNORE INTO mirror_ignored(team_uid, at) VALUES (?1, ?2)", params![uid, now]).db()?;
    }
    out.dropped = over.len();
    let skipped = state_int(&tx, "skipped")? + out.skipped as i64;
    state_set(&tx, "skipped", &skipped.to_string())?;
    let pulled = state_int(&tx, "pulled_seq")?.max(cursor);
    state_set(&tx, "pulled_seq", &pulled.to_string())?;
    tx.commit().db()?;
    out.teams.sort();
    out.teams.dedup();
    Ok(out)
}

/// Remove a team copied from another machine with all its rows (locally only; no tombstones).
fn drop_mirror(tx: &Transaction, uid: &str) -> Result<(), String> {
    for table in ["posts", "task_events", "task_deps", "tasks", "cursors"] {
        tx.execute(&format!("DELETE FROM {table} WHERE team_uid = ?1"), params![uid]).db()?;
    }
    tx.execute("DELETE FROM teams WHERE uid = ?1", params![uid]).db()?;
    tx.execute("DELETE FROM mirror_teams WHERE team_uid = ?1", params![uid]).db()?;
    // Notes queued for a copy that is gone go with it (the server still has the sent ones).
    tx.execute("DELETE FROM outbox WHERE team_uid = ?1", params![uid]).db()?;
    Ok(())
}

/// Settings → "Remove other computers' teams" (offered only while sync is off): every mirror
/// goes from this file (the server and the other computers keep theirs). The pull position and
/// the cap's ignore list start over, so turning sync on again brings whole teams back, never a
/// part of one.
pub fn sync_remove_mirrors(conn: &mut Connection) -> Result<usize, String> {
    let tx = immediate(conn)?;
    state_del(&tx, "pulled_seq")?;
    tx.execute("DELETE FROM mirror_ignored", []).db()?;
    let uids: Vec<String> = {
        let mut stmt = tx.prepare("SELECT team_uid FROM mirror_teams").db()?;
        let rows = stmt.query_map([], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    for uid in &uids {
        drop_mirror(&tx, uid)?;
    }
    tx.commit().db()?;
    Ok(uids.len())
}

// ── Stage 3c: remote notes, restore, take over (orchestration in sync.rs) ──

/// This file's sync identity (`board_meta.instance_id`), created when missing.
pub fn sync_instance(conn: &mut Connection) -> Result<String, String> {
    let tx = immediate(conn)?;
    let id = match meta_get(&tx, "instance_id")? {
        Some(v) => v,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            meta_set(&tx, "instance_id", &id)?;
            id
        }
    };
    tx.commit().db()?;
    Ok(id)
}

/// A post on root tab `team`. On a team copied from another computer (sync), a note is not
/// refused but queued for that team's home (stage 3c remote note): only `note`, no task link,
/// the same text rules and limits as a local post, at most `REMOTE_NOTES_PER_TEAM` waiting per
/// team and `REMOTE_NOTES_PER_COMPUTER` in all. Everything else is `post`.
pub fn post_or_queue(conn: &mut Connection, limits: Limits, team: &str, input: &PostInput, ctx: &Ctx) -> Result<Value, String> {
    {
        let spec = PostSpec::check(team, input)?;
        let tx = immediate(conn)?;
        if let Some(TeamRef { mirror: Some(home), uid, .. }) = find_team(&tx, team, ctx.host.as_deref())? {
            if spec.kind != "note" {
                return Err(format!("only notes can be sent to a team that lives on {home}"));
            }
            if input.task.is_some() {
                return Err(format!("a note for a team that lives on {home} cannot link a task"));
            }
            let (team_n, all_n): (i64, i64) = tx
                .query_row(
                    "SELECT count(*) FILTER (WHERE team_uid = ?1), count(*) FROM outbox WHERE state = 'pending'",
                    params![uid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .db()?;
            if team_n >= super::sync_core::REMOTE_NOTES_PER_TEAM {
                return Err(format!(
                    "{team_n} notes for this team are still waiting to be delivered to {home}; wait until it takes them"
                ));
            }
            if all_n >= super::sync_core::REMOTE_NOTES_PER_COMPUTER {
                return Err(format!("{all_n} notes from this computer are still waiting to be delivered; wait until their teams take them"));
            }
            let id = new_id();
            tx.execute(
                "INSERT INTO outbox(id, team_uid, team, home_host, author_id, author_name, author_cli, kind, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![id, uid, team, home, spec.author_id, spec.author_name, spec.author_cli, spec.kind, spec.text, ctx.now],
            )
            .db()?;
            tx.commit().db()?;
            let mut author = json!({ "id": spec.author_id });
            if let Some(n) = &spec.author_name {
                author["name"] = json!(n);
            }
            if let Some(h) = &ctx.host {
                author["host"] = json!(h);
            }
            return Ok(json!({
                "id": id, "team": team, "pending": true, "home": home, "state": "pending",
                "kind": spec.kind, "text": spec.text, "ts": ctx.now, "author": author,
            }));
        }
    }
    post(conn, limits, team, input, ctx)
}

/// Notes waiting to go to the server (oldest first), as this computer `host` sends them.
pub fn outbox_to_send(conn: &mut Connection, host: &str, max: i64) -> Result<Vec<super::sync_core::OutboxNote>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, team_uid, author_id, author_name, author_cli, kind, text, created_at FROM outbox
             WHERE state = 'pending' ORDER BY created_at, id LIMIT ?1",
        )
        .db()?;
    let rows = stmt
        .query_map(params![max], |r| {
            Ok(super::sync_core::OutboxNote {
                id: r.get(0)?,
                team_uid: r.get(1)?,
                from_host: host.to_string(),
                author_id: r.get(2)?,
                author_name: r.get(3)?,
                author_cli: r.get(4)?,
                kind: r.get(5)?,
                text: r.get(6)?,
                created_at: r.get(7)?,
                ..Default::default()
            })
        })
        .db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// The server took (None) or refused (a code) these notes.
pub fn outbox_after_send(conn: &mut Connection, results: &[(String, Option<&'static str>)], now: i64) -> Result<(), String> {
    let tx = immediate(conn)?;
    for (id, refusal) in results {
        match refusal {
            None => tx.execute("UPDATE outbox SET state = 'sent', sent_at = ?2 WHERE id = ?1 AND state = 'pending'", params![id, now]),
            Some(code) => tx.execute("UPDATE outbox SET state = 'refused', reason = ?2 WHERE id = ?1 AND state = 'pending'", params![id, code]),
        }
        .db()?;
    }
    tx.commit().db()
}

/// Notes on the server whose outcome is not known here yet: (id, sent_at).
pub fn outbox_sent(conn: &mut Connection) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = conn.prepare("SELECT id, coalesce(sent_at, created_at) FROM outbox WHERE state IN ('sent','delivered') ORDER BY created_at").db()?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// What the server says about sent notes: `delivered` waits for the post to arrive by pull,
/// `refused` / `withdrawn` become refused here (with the code), a note the server no longer
/// has goes back to `pending` (sent again; its id keeps it single) unless its post is here.
pub fn outbox_apply_states(conn: &mut Connection, states: &[(String, String, Option<String>)], asked: &[String]) -> Result<(), String> {
    let tx = immediate(conn)?;
    for (id, state, reason) in states {
        match state.as_str() {
            "delivered" => tx.execute("UPDATE outbox SET state = 'delivered' WHERE id = ?1 AND state = 'sent'", params![id]),
            "refused" | "withdrawn" => tx.execute(
                "UPDATE outbox SET state = 'refused', reason = ?2 WHERE id = ?1 AND state IN ('sent','delivered')",
                params![id, reason.as_deref().unwrap_or("refused")],
            ),
            _ => Ok(0),
        }
        .db()?;
    }
    for id in asked {
        // Its post is here already (pulled, restored or taken over): the entry is done.
        let have: i64 = tx.query_row("SELECT count(*) FROM posts WHERE id = ?1", params![id], |r| r.get(0)).db()?;
        if have > 0 {
            tx.execute("DELETE FROM outbox WHERE id = ?1", params![id]).db()?;
            continue;
        }
        if states.iter().any(|(s, _, _)| s == id) {
            continue;
        }
        {
            tx.execute("UPDATE outbox SET state = 'pending', sent_at = NULL WHERE id = ?1 AND state IN ('sent','delivered')", params![id]).db()?;
        }
    }
    tx.commit().db()
}

/// A note the poster gave up on (`expired`) or the server refused before sending.
pub fn outbox_mark_refused(conn: &mut Connection, id: &str, reason: &str) -> Result<(), String> {
    conn.execute("UPDATE outbox SET state = 'refused', reason = ?2 WHERE id = ?1 AND state <> 'refused'", params![id, reason]).db()?;
    Ok(())
}

/// This computer's notes for root tab `team` that are not numbered posts yet (oldest first).
pub fn outbox_list(conn: &mut Connection, team: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, team, home_host, author_id, author_name, kind, text, created_at, state, reason FROM outbox
             WHERE team = ?1 ORDER BY created_at, id",
        )
        .db()?;
    let rows = stmt
        .query_map(params![team], |r| {
            Ok(json!({
                "id": r.get::<_, String>(0)?, "team": r.get::<_, String>(1)?, "home": r.get::<_, String>(2)?,
                "author": { "id": r.get::<_, String>(3)?, "name": r.get::<_, Option<String>>(4)? },
                "kind": r.get::<_, String>(5)?, "text": r.get::<_, String>(6)?, "ts": r.get::<_, i64>(7)?,
                "state": r.get::<_, String>(8)?, "reason": r.get::<_, Option<String>>(9)?,
            }))
        })
        .db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// A person dismisses a refused note (only refused ones can go).
pub fn outbox_dismiss(conn: &mut Connection, id: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM outbox WHERE id = ?1 AND state = 'refused'", params![id]).db()
}

/// The home turns notes from the server outbox into numbered posts, one transaction each.
/// Exactly once: the outbox id becomes the post id, so a note whose post is already here (a
/// crash before the server heard back) is only reported delivered again. A note for a team
/// that is gone is refused (`team_gone`); one that fails the local post rules is refused
/// (`invalid`); one for a team that is not homed here (anymore) gets no verdict.
/// Returns (id, state, reason) for the server.
pub fn inbox_apply(
    conn: &mut Connection,
    limits: Limits,
    notes: &[super::sync_core::OutboxNote],
    ctx: &Ctx,
) -> Result<(Vec<(String, &'static str, Option<&'static str>)>, Vec<String>), String> {
    let mut out = Vec::new();
    let mut teams: Vec<String> = Vec::new();
    for n in notes {
        let tx = immediate(conn)?;
        let existing: Option<String> = tx.query_row("SELECT team_uid FROM posts WHERE id = ?1", params![n.id], |r| r.get(0)).optional().db()?;
        if let Some(team_uid) = existing {
            out.push((n.id.clone(), if team_uid == n.team_uid { "delivered" } else { "refused" }, (team_uid != n.team_uid).then_some("invalid")));
            tx.execute("DELETE FROM outbox WHERE id = ?1", params![n.id]).db()?;
            tx.commit().db()?;
            continue;
        }
        let team: Option<(String, Option<i64>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT t.team, t.deleted_at, t.home_host, m.home_host FROM teams t LEFT JOIN mirror_teams m ON m.team_uid = t.uid WHERE t.uid = ?1",
                params![n.team_uid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .db()?;
        // Not here (yet): a restore that registered the name but has not copied the rows, for
        // example. No verdict; the note waits.
        let Some((team, deleted, home, mirror)) = team else { continue };
        if mirror.is_some() || home.as_deref() != ctx.host.as_deref() {
            continue;
        }
        if deleted.is_some() || n.team_deleted {
            out.push((n.id.clone(), "refused", Some("team_gone")));
            continue;
        }
        // Only a registered computer under its own identity may send (stage 3c review R4).
        if !n.sender_known {
            out.push((n.id.clone(), "refused", Some("unknown_sender")));
            continue;
        }
        // At most REMOTE_NOTES_PER_SENDER_WINDOW notes per sending computer and team per
        // REMOTE_NOTE_WINDOW_MS, so a flood cannot push the team's older posts out.
        let recent: i64 = tx
            .query_row(
                "SELECT count(*) FROM posts WHERE team_uid = ?1 AND author_host = ?2 AND origin_host IS NOT author_host AND ts > ?3",
                params![n.team_uid, n.from_host, ctx.now - super::sync_core::REMOTE_NOTE_WINDOW_MS],
                |r| r.get(0),
            )
            .db()?;
        if recent >= super::sync_core::REMOTE_NOTES_PER_SENDER_WINDOW {
            out.push((n.id.clone(), "refused", Some("rate_limited")));
            continue;
        }
        let input = PostInput {
            team_name: None,
            author_id: n.author_id.clone(),
            author_name: n.author_name.clone(),
            author_cli: n.author_cli.clone(),
            kind: n.kind.clone(),
            text: n.text.clone(),
            task: None,
            root: false,
        };
        let valid = super::sync_core::is_uuid(&n.id)
            && n.kind == "note"
            && clean_label(Some(&n.from_host), 120).as_deref() == Some(n.from_host.as_str())
            && PostSpec::check(&team, &input).is_ok_and(|spec| {
                spec.text == n.text
                    && spec.author_id == n.author_id
                    && spec.author_name == n.author_name
                    && spec.author_cli == n.author_cli
            });
        if !valid {
            out.push((n.id.clone(), "refused", Some("invalid")));
            continue;
        }
        insert_post(
            &tx,
            limits,
            &NewPost {
                id: Some(&n.id),
                author_host: Some(&n.from_host),
                team_uid: &n.team_uid,
                author_id: &n.author_id,
                author_name: n.author_name.as_deref(),
                author_cli: n.author_cli.as_deref(),
                kind: "note",
                text: &n.text,
                task_id: None,
            },
            ctx,
        )?;
        // This computer's own note (it sent it before it became the home) is a post now.
        tx.execute("DELETE FROM outbox WHERE id = ?1", params![n.id]).db()?;
        finish(tx, limits)?;
        out.push((n.id.clone(), "delivered", None));
        if !teams.contains(&team) {
            teams.push(team);
        }
    }
    Ok((out, teams))
}

/// The key of a synced row (as `changes.row_id` stores it) over alias `x`.
fn key_sql_x(table: &str) -> &'static str {
    match table {
        "teams" => "x.uid",
        "task_deps" => "x.task_id || '/' || x.depends_on_id",
        _ => "x.id",
    }
}

/// Changes of the teams `uids` that were not sent to the server yet.
pub fn sync_unsent_for(conn: &mut Connection, uids: &[String]) -> Result<i64, String> {
    let pushed = state_int(conn, "pushed_seq")?;
    let list = serde_json::to_string(uids).unwrap_or_else(|_| "[]".into());
    let mut n = 0i64;
    for (table, _) in super::sync_core::SYNC_TABLES {
        let c: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(DISTINCT c.local_seq) FROM changes c JOIN {table} x ON {} = c.row_id
                     WHERE c.tbl = ?1 AND c.local_seq > ?2 AND x.{} IN (SELECT value FROM json_each(?3))",
                    key_sql_x(table),
                    team_col(table)
                ),
                params![table, pushed, list],
                |r| r.get(0),
            )
            .db()?;
        n += c;
    }
    Ok(n)
}

/// Rows of the teams `uids` as the server has them, without the change log (they are on the
/// server already): checked like pulled rows, a missing row inserted (a post gets a local read
/// position), an existing one replaced only by a higher `row_version` of the same team.
/// Returns (written, skipped, kept because the local row is newer).
fn upsert_server_rows(tx: &Transaction, rows: &copy::Dump, uids: &HashSet<String>) -> Result<(usize, usize, usize), String> {
    let (mut written, mut skipped, mut newer) = (0usize, 0usize, 0usize);
    for (table, cols) in super::sync_core::SYNC_TABLES {
        let at = |name: &str| copy::col_index(cols, name);
        let pk: Vec<&str> = match table {
            "teams" => vec!["uid"],
            "task_deps" => vec!["task_id", "depends_on_id"],
            _ => vec!["id"],
        };
        let where_pk = pk.iter().enumerate().map(|(i, k)| format!("{k} = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
        let names = copy::col_list(cols);
        let set = cols
            .iter()
            .enumerate()
            .filter(|(_, (c, _))| !pk.contains(c))
            .map(|(i, (c, _))| format!("{c} = ?{}", i + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let insert_cols = if table == "posts" { format!("{names}, arrival") } else { names.clone() };
        let ph = (1..=cols.len() + usize::from(table == "posts")).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        let update_where = pk.iter().map(|k| format!("{k} = ?{}", at(k) + 1)).collect::<Vec<_>>().join(" AND ");
        for row in rows.rows(table) {
            if super::sync_core::validate_row(table, cols, row).is_err() {
                skipped += 1;
                continue;
            }
            let team_uid = row[at(team_col(table))].text().unwrap_or_default().to_string();
            if !uids.contains(&team_uid) {
                continue;
            }
            let key: Vec<rusqlite::types::Value> = pk.iter().map(|k| to_value(&row[at(k)])).collect();
            let existing: Option<(i64, String)> = tx
                .query_row(
                    &format!("SELECT row_version, {} FROM {table} WHERE {where_pk}", team_col(table)),
                    rusqlite::params_from_iter(key.iter()),
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .db()?;
            let rv = row[at("row_version")].int().unwrap_or(0);
            let values: Vec<rusqlite::types::Value> = row.iter().map(to_value).collect();
            let res = match existing {
                Some((_, other)) if other != team_uid => {
                    skipped += 1;
                    continue;
                }
                Some((stored, _)) if stored > rv => {
                    newer += 1;
                    continue;
                }
                Some((stored, _)) if stored == rv => continue,
                Some(_) => tx.execute(&format!("UPDATE {table} SET {set} WHERE {update_where}"), rusqlite::params_from_iter(values.iter())),
                None => {
                    let mut values = values;
                    if table == "posts" {
                        values.push(rusqlite::types::Value::Integer(next_arrival(tx)?));
                    }
                    tx.execute(&format!("INSERT INTO {table} ({insert_cols}) VALUES ({ph})"), rusqlite::params_from_iter(values.iter()))
                }
            };
            match res {
                Ok(_) => written += 1,
                Err(_) => skipped += 1,
            }
        }
    }
    Ok((written, skipped, newer))
}

/// Claims held by agents of another installation: a claim without a lease gets one that ends
/// now, so the normal lazy expiry (and the lease worker) releases it; a claim with a lease
/// keeps it — only its own app instance could renew it, so it runs out within the lease.
fn orphan_claims_expire(tx: &Transaction, uid: &str, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE tasks SET lease_until = ?2 WHERE team_uid = ?1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND lease_until IS NULL",
        params![uid, now],
    )
    .db()?;
    Ok(())
}

/// Remove every local row of team `uid` (no tombstones, nothing logged).
fn purge_team_rows(tx: &Transaction, uid: &str) -> Result<(), String> {
    for table in copy::PURGE_TABLES {
        tx.execute(&format!("DELETE FROM {table} WHERE team_uid = ?1"), params![uid]).db()?;
    }
    tx.execute("DELETE FROM teams WHERE uid = ?1", params![uid]).db()?;
    Ok(())
}

/// "Restore my teams from the server": the rows of the teams homed on `host` (as the server
/// has them) become this computer's teams again. Refused while any of them has a change here
/// that was not sent. A local row with a higher `row_version` is kept. A team that clashes
/// with a live local team of the same tab is skipped (a retired local one is removed).
pub fn restore_apply(conn: &mut Connection, host: &str, dump: &copy::Dump, now: i64) -> Result<Value, String> {
    let at = |n: &str| copy::col_index(copy::TEAMS, n);
    let mut uids: HashSet<String> = HashSet::new();
    let mut clashes = 0usize;
    let all: Vec<String> = dump.rows("teams").iter().filter_map(|r| r[at("uid")].text().map(str::to_string)).collect();
    let unsent = sync_unsent_for(conn, &all)?;
    if unsent > 0 {
        return Err(format!("unsent:{unsent}"));
    }
    let tx = immediate(conn)?;
    for row in dump.rows("teams") {
        if super::sync_core::validate_row("teams", copy::TEAMS, row).is_err() || row[at("home_host")].text() != Some(host) {
            continue;
        }
        let (uid, team) = (row[at("uid")].text().unwrap_or_default().to_string(), row[at("team")].text().unwrap_or_default().to_string());
        let other: Option<(String, Option<i64>)> = tx
            .query_row(
                "SELECT uid, deleted_at FROM teams WHERE team = ?1 AND home_host = ?2 AND uid <> ?3",
                params![team, host, uid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .db()?;
        match other {
            Some((_, None)) => {
                clashes += 1;
                continue;
            }
            Some((old, Some(_))) => purge_team_rows(&tx, &old)?,
            None => {}
        }
        tx.execute("DELETE FROM mirror_teams WHERE team_uid = ?1", params![uid]).db()?;
        tx.execute("DELETE FROM mirror_ignored WHERE team_uid = ?1", params![uid]).db()?;
        tx.execute("DELETE FROM outbox WHERE team_uid = ?1 AND state <> 'pending'", params![uid]).db()?;
        uids.insert(uid);
    }
    let (written, skipped, newer) = upsert_server_rows(&tx, dump, &uids)?;
    for uid in &uids {
        orphan_claims_expire(&tx, uid, now)?;
    }
    let live = |table: &str| {
        let i = copy::col_index(super::sync_core::SYNC_TABLES.iter().find(|(t, _)| *t == table).map(|(_, c)| *c).unwrap_or(copy::TEAMS), "team_uid");
        let d = copy::col_index(super::sync_core::SYNC_TABLES.iter().find(|(t, _)| *t == table).map(|(_, c)| *c).unwrap_or(copy::TEAMS), "deleted_at");
        dump.rows(table).iter().filter(|r| r[i].text().is_some_and(|u| uids.contains(u)) && matches!(r[d], copy::Cell::Null)).count()
    };
    let out = json!({
        "teams": uids.len(), "tasks": live("tasks"), "notes": live("posts"),
        "written": written, "skipped": skipped, "keptNewer": newer, "clashes": clashes,
    });
    tx.commit().db()?;
    Ok(out)
}

/// After a successful takeover on the server: team `uid` is homed here now. Its rows are
/// brought to the server's state (they were a read-only copy), it stops being a copy, and
/// claims of the old home's agents run out through the normal lease expiry.
pub fn adopt_apply(conn: &mut Connection, uid: &str, host: &str, dump: &copy::Dump, now: i64) -> Result<Value, String> {
    let tx = immediate(conn)?;
    // A retired team of this computer for the same tab is in the way of (team, home_host):
    // removed for good, as the server does.
    let retired: Vec<String> = {
        let mut stmt = tx
            .prepare(
                "SELECT o.uid FROM teams o JOIN teams t ON t.uid = ?1
                 WHERE o.team = t.team AND o.home_host = ?2 AND o.uid <> ?1 AND o.deleted_at IS NOT NULL",
            )
            .db()?;
        let rows = stmt.query_map(params![uid, host], |r| r.get(0)).db()?;
        rows.collect::<rusqlite::Result<Vec<_>>>().db()?
    };
    for old in &retired {
        purge_team_rows(&tx, old)?;
    }
    tx.execute("DELETE FROM mirror_teams WHERE team_uid = ?1", params![uid]).db()?;
    tx.execute("DELETE FROM mirror_ignored WHERE team_uid = ?1", params![uid]).db()?;
    // Sent notes are posts on the server already (they come down with the rows) or wait in the
    // server outbox, where this computer, now the home, delivers them; queued ones stay queued.
    tx.execute("DELETE FROM outbox WHERE team_uid = ?1 AND state <> 'pending'", params![uid]).db()?;
    let set: HashSet<String> = [uid.to_string()].into_iter().collect();
    let (written, skipped, _) = upsert_server_rows(&tx, dump, &set)?;
    orphan_claims_expire(&tx, uid, now)?;
    let team: Option<(String, Option<String>)> =
        tx.query_row("SELECT team, name FROM teams WHERE uid = ?1", params![uid], |r| Ok((r.get(0)?, r.get(1)?))).optional().db()?;
    tx.commit().db()?;
    Ok(json!({ "team": team.as_ref().map(|t| t.0.clone()), "teamName": team.and_then(|t| t.1), "written": written, "skipped": skipped }))
}

/// Live teams this file owns (not copies), by uid: the round asks the server whether any of
/// them was taken over by another computer.
pub fn home_team_uids(conn: &mut Connection, host: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn.prepare(&format!("{HOME_UIDS} AND deleted_at IS NULL")).db()?;
    let rows = stmt.query_map(params![host], |r| r.get(0)).db()?;
    rows.collect::<rusqlite::Result<Vec<_>>>().db()
}

/// This computer's team `uid` was taken over by `home` while it was away: it becomes a
/// read-only copy equal to the server's rows. Changes made here that were not sent are
/// dropped from the change log and counted as refused (with the reason), never applied.
/// Returns how many were refused.
pub fn demote_team(conn: &mut Connection, uid: &str, home: &str, dump: &copy::Dump, now: i64, kept_dir: Option<&Path>) -> Result<i64, String> {
    let unsent = sync_unsent_for(conn, &[uid.to_string()])?;
    let tx = immediate(conn)?;
    let pushed = state_int(&tx, "pushed_seq")?;
    // Rows written here that never reached the server are kept in a file before they go.
    if unsent > 0 {
        if let Some(dir) = kept_dir {
            let (rows, file) = keep_unsent(&tx, uid, home, pushed, dir, now)?;
            state_set(&tx, "kept_rows", &(state_int(&tx, "kept_rows")? + rows).to_string())?;
            state_set(&tx, "kept_file", &file)?;
        }
    }
    for (table, _) in super::sync_core::SYNC_TABLES {
        tx.execute(
            &format!(
                "DELETE FROM changes WHERE local_seq > ?1 AND tbl = ?2 AND row_id IN (SELECT {} FROM {table} x WHERE x.{} = ?3)",
                key_sql_x(table),
                team_col(table)
            ),
            params![pushed, table, uid],
        )
        .db()?;
    }
    purge_team_rows(&tx, uid)?;
    tx.execute(
        "INSERT INTO mirror_teams(team_uid, home_host, synced_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(team_uid) DO UPDATE SET home_host = excluded.home_host, synced_at = excluded.synced_at",
        params![uid, home, now],
    )
    .db()?;
    let set: HashSet<String> = [uid.to_string()].into_iter().collect();
    upsert_server_rows(&tx, dump, &set)?;
    if unsent > 0 {
        let total = state_int(&tx, "refused")? + unsent;
        state_set(&tx, "refused", &total.to_string())?;
        if state_get(&tx, "refused_reason")?.is_none() {
            state_set(&tx, "refused_reason", &super::sync_core::moved_message(home))?;
        }
    }
    tx.commit().db()?;
    Ok(unsent)
}

/// At most this many kept-changes files (the oldest go) and this many bytes per file.
pub const KEPT_FILES_MAX: usize = 50;
pub const KEPT_FILE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// The unsent rows of team `uid` (as stored: every column, text unchanged) as one JSON file
/// `<dir>/<team>-<now>.json` (0600). Rows past `KEPT_FILE_MAX_BYTES` are left out and counted
/// (`leftOut`). Returns (rows kept, path).
fn keep_unsent(tx: &Transaction, uid: &str, home: &str, pushed: i64, dir: &Path, now: i64) -> Result<(i64, String), String> {
    let team: String = tx.query_row("SELECT team FROM teams WHERE uid = ?1", params![uid], |r| r.get(0)).db()?;
    let mut tables = serde_json::Map::new();
    let (mut kept, mut left_out, mut size) = (0i64, 0i64, 0usize);
    for (table, cols) in super::sync_core::SYNC_TABLES {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT {} FROM {table} x WHERE x.{} = ?1 AND {} IN (SELECT row_id FROM changes WHERE tbl = ?2 AND local_seq > ?3)",
                cols.iter().map(|(c, _)| format!("x.{c}")).collect::<Vec<_>>().join(", "),
                team_col(table),
                key_sql_x(table)
            ))
            .db()?;
        let rows = read_cells(&mut stmt, cols, &[&uid, &table, &pushed], false)?;
        let mut out = Vec::new();
        for r in rows {
            let obj: serde_json::Map<String, Value> = cols
                .iter()
                .zip(r.iter())
                .map(|((c, _), cell)| {
                    (c.to_string(), match cell {
                        copy::Cell::Null => Value::Null,
                        copy::Cell::Int(n) => json!(n),
                        copy::Cell::Text(s) => json!(s),
                    })
                })
                .collect();
            let v = Value::Object(obj);
            let n = v.to_string().len();
            if size + n > KEPT_FILE_MAX_BYTES {
                left_out += 1;
                continue;
            }
            size += n;
            kept += 1;
            out.push(v);
        }
        if !out.is_empty() {
            tables.insert(table.to_string(), Value::Array(out));
        }
    }
    let doc = json!({
        "team": team, "teamUid": uid, "takenOverBy": home, "keptAt": now,
        "note": "changes made on this computer after another computer took the team over; they were not sent",
        "rows": tables, "leftOut": left_out,
    });
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let safe: String = team.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(80).collect();
    let path = dir.join(format!("{safe}-{now}.json"));
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        f.write_all(serde_json::to_string_pretty(&doc).unwrap_or_default().as_bytes()).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    // Keep only the newest KEPT_FILES_MAX files.
    if let Ok(rd) = std::fs::read_dir(dir) {
        let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        files.sort();
        let over = files.len().saturating_sub(KEPT_FILES_MAX);
        for (_, p) in files.into_iter().take(over) {
            if p != path {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    Ok((kept, path.display().to_string()))
}

/// The copy of root tab `team` (another computer's): (uid, name, home, row_version).
pub fn mirror_of(conn: &mut Connection, team: &str) -> Result<Option<(String, Option<String>, String, i64)>, String> {
    conn.query_row(
        "SELECT t.uid, t.name, m.home_host, t.row_version FROM teams t JOIN mirror_teams m ON m.team_uid = t.uid
         WHERE t.team = ?1 AND t.deleted_at IS NULL ORDER BY t.last_activity_at DESC LIMIT 1",
        params![team],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .db()
}

/// Root tab id and name of team `uid`.
pub fn team_root_of(conn: &mut Connection, uid: &str) -> Result<Option<(String, Option<String>)>, String> {
    conn.query_row("SELECT team, name FROM teams WHERE uid = ?1", params![uid], |r| Ok((r.get(0)?, r.get(1)?))).optional().db()
}

/// A live or retired team of this computer for the same tab (a takeover would clash with it).
pub fn has_own_team(conn: &mut Connection, team: &str, host: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT count(*) FROM teams WHERE team = ?1 AND home_host = ?2 AND deleted_at IS NULL AND uid NOT IN (SELECT team_uid FROM mirror_teams)",
            params![team, host],
            |r| r.get(0),
        )
        .db()?;
    Ok(n > 0)
}

// ── Settings: counts, copy ───────────────────────────────────────────────

/// Live teams, posts and tasks (status line).
pub fn counts(conn: &mut Connection) -> Result<Value, String> {
    conn.query_row(
        "SELECT (SELECT count(*) FROM teams WHERE deleted_at IS NULL),
                (SELECT count(*) FROM posts WHERE deleted_at IS NULL),
                (SELECT count(*) FROM tasks WHERE deleted_at IS NULL)",
        [],
        |r| Ok(json!({ "teams": r.get::<_, i64>(0)?, "posts": r.get::<_, i64>(1)?, "tasks": r.get::<_, i64>(2)? })),
    )
    .db()
}

fn select_sql(table: &str, cols: copy::Cols) -> String {
    let list = copy::col_list(cols);
    let filter = match table {
        "teams" => "deleted_at IS NULL",
        "cursors" => "team_uid IN (SELECT uid FROM teams WHERE deleted_at IS NULL)",
        _ => "deleted_at IS NULL AND team_uid IN (SELECT uid FROM teams WHERE deleted_at IS NULL)",
    };
    // Posts in read order: the target gives them new arrival positions in this order and
    // converts read cursors through it, so any other order could move a cursor past an
    // unread post.
    let order = if table == "posts" { " ORDER BY team_uid, arrival, seq" } else { "" };
    format!("SELECT {list} FROM {table} WHERE {filter}{order}")
}

/// Every live row of every live team (Copy data), in one read transaction.
pub fn export_dump(conn: &mut Connection) -> Result<copy::Dump, String> {
    let tx = conn.transaction().db()?;
    let mut dump = copy::Dump::default();
    for (table, cols) in copy::TABLES {
        let mut stmt = tx.prepare(&select_sql(table, cols)).db()?;
        let rows = stmt
            .query_map([], |r| {
                let mut cells = Vec::with_capacity(cols.len());
                for (i, (_, kind)) in cols.iter().enumerate() {
                    cells.push(match kind {
                        copy::Kind::Int => r.get::<_, Option<i64>>(i)?.map_or(copy::Cell::Null, copy::Cell::Int),
                        copy::Kind::Text => r.get::<_, Option<String>>(i)?.map_or(copy::Cell::Null, copy::Cell::Text),
                    });
                }
                Ok(cells)
            })
            .db()?;
        *dump.rows_mut(table) = rows.collect::<rusqlite::Result<Vec<_>>>().db()?;
    }
    drop(tx);
    Ok(dump)
}

/// Insert a dump (Copy data) in one IMMEDIATE transaction: refused unless the board is empty
/// or `merge` is set; teams it already has are skipped. Every inserted synced row is logged
/// in the change log; posts get this file's arrival order and cursors are converted to it.
pub fn import_dump(conn: &mut Connection, limits: Limits, dump: copy::Dump, merge: bool, now: i64, host: &str) -> Result<Value, String> {
    let tx = immediate(conn)?;
    let mut existing = copy::Existing::default();
    {
        let mut stmt = tx.prepare("SELECT uid, team, home_host, deleted_at IS NOT NULL FROM teams").db()?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, bool>(3)?)))
            .db()?;
        for row in rows {
            let (uid, team, host, dead) = row.db()?;
            existing.add(uid, team, host, dead);
        }
    }
    let copy::Plan { dump: plan, skipped, purge } = copy::plan(dump, &existing, merge)?;
    // Tombstoned teams in the way of a copied one go for good (they were already deleted).
    for uid in &purge {
        for table in copy::PURGE_TABLES {
            tx.execute(&format!("DELETE FROM {table} WHERE team_uid = ?1"), params![uid]).db()?;
        }
        tx.execute("DELETE FROM teams WHERE uid = ?1", params![uid]).db()?;
    }
    let mut arrivals = copy::ArrivalMap::default();
    for (table, cols) in copy::TABLES {
        let names = copy::col_list(cols);
        let params: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
        let sql = format!("INSERT INTO {table} ({names}) VALUES ({})", params.join(", "));
        let to_sql = |c: &copy::Cell| match c {
            copy::Cell::Null => rusqlite::types::Value::Null,
            copy::Cell::Int(n) => rusqlite::types::Value::Integer(*n),
            copy::Cell::Text(s) => rusqlite::types::Value::Text(s.clone()),
        };
        let at = |name: &str| copy::col_index(cols, name);
        for row in plan.rows(table) {
            let mut values: Vec<rusqlite::types::Value> = row.iter().map(to_sql).collect();
            match table {
                "posts" => {
                    let id = row[at("id")].text().unwrap_or_default();
                    let team_uid = row[at("team_uid")].text().unwrap_or_default();
                    let arrival = log_change(&tx, "posts", id, now)?;
                    arrivals.add(team_uid, row[at("arrival")].int().unwrap_or(0), arrival);
                    values[at("arrival")] = rusqlite::types::Value::Integer(arrival);
                }
                "cursors" => {
                    let team_uid = row[at("team_uid")].text().unwrap_or_default();
                    let converted = arrivals.convert(team_uid, row[at("arrival")].int().unwrap_or(0));
                    values[at("arrival")] = rusqlite::types::Value::Integer(converted);
                }
                "task_deps" => {
                    let key = dep_key(row[at("task_id")].text().unwrap_or_default(), row[at("depends_on_id")].text().unwrap_or_default());
                    log_change(&tx, "task_deps", &key, now)?;
                }
                "teams" => {
                    log_change(&tx, "teams", row[at("uid")].text().unwrap_or_default(), now)?;
                }
                other => {
                    log_change(&tx, other, row[at("id")].text().unwrap_or_default(), now)?;
                }
            }
            tx.execute(&sql, rusqlite::params_from_iter(values)).db()?;
        }
    }
    // Teams another computer owns are read-only here (their home writes them).
    register_mirrors(&tx, host, now)?;
    finish(tx, limits)?;
    Ok(copy::summary(&plan, &skipped))
}
