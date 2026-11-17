//! PostgreSQL implementation of the team board store: every SQL statement for this engine lives
//! here. Same tables, columns, numbers, JSON shapes and rules as the SQLite store (sqlite.rs);
//! the differences are confined to:
//! - placeholders (`$n`) and the schema: every table is qualified with the configured schema,
//!   validated as an identifier and quoted (`@@.` in the SQL text below);
//! - locking: a write takes the team row `FOR UPDATE` first (per-team counters, caps and the
//!   transition guards then behave as under SQLite's single writer, and lock order is always
//!   team → task, so writers never deadlock); a task being changed is loaded `FOR UPDATE`; lazy
//!   lease expiry and `claim --next` skip rows another writer holds (`SKIP LOCKED`); a `--new`
//!   read holds the team row `FOR SHARE` so no post can land between its read and its cursor
//!   update; plain reads run in one REPEATABLE READ snapshot;
//! - search is `ILIKE` (case-insensitive beyond ASCII);
//! - no local change log (`changes`, `sync_state` are SQLite-only); instead every insert or
//!   update of a synced row gets a new `server_seq` from `board_server_seq` (trigger), the
//!   column a later sync pulls by. `posts.arrival` comes from `board_arrival_seq`, taken under
//!   the team lock, so it follows commit order within a team.
//!
//! Tables are never created implicitly: `migrate` runs only from the Settings button. A
//! session never runs a statement longer than 5 s (`statement_timeout`), the pool holds at
//! most 5 connections and gives up connecting after 5 s. Errors are scrubbed of the password
//! and URL (`PgTarget::redact`). Deadlocks and serialization failures are retried up to 3 times.

use super::common::*;
use super::config::{quote_ident, PgTarget, CONNECT_TIMEOUT_SECS};
use super::copy::{self, Cell, Cols, Dump, Kind};
use super::model::*;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnection, PgPool, PgPoolOptions, PgRow};
use sqlx::{Connection, Row};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::OnceCell;

/// Schema version this code reads and writes (the same number as the SQLite store's).
pub const SCHEMA_VERSION: i64 = 2;

/// Longest a board command may wait on the server (a network drop mid-query must not stall
/// the lease worker or a command): "team board unavailable: …" after that.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Run one store call with a deadline; errors come out clean (see `clean_err`).
pub async fn timed<T>(limit: Duration, f: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    match tokio::time::timeout(limit, f).await {
        Ok(r) => r.map_err(clean_err),
        Err(_) => Err(unavailable(format!("the PostgreSQL server did not answer within {} s", limit.as_secs()))),
    }
}

/// A store error as shown to people: the internal retry marker becomes a plain
/// "team board unavailable: …" (for paths that do not retry).
pub fn clean_err(e: String) -> String {
    match e.strip_prefix(RETRY) {
        Some(m) => unavailable(m),
        None => e,
    }
}

/// Rows per INSERT when copying data in (42 columns × 300 stays far below the 65 535
/// bind-parameter limit).
const IMPORT_CHUNK: usize = 300;

/// Marks a database error worth one more try (deadlock, serialization failure).
const RETRY: &str = "\u{1}retry:";

pub struct PgStore {
    target: PgTarget,
    /// `"schema".`
    prefix: String,
    limits: Limits,
    pool: OnceCell<PgPool>,
    /// The schema version was checked (and matched) once.
    ready: AtomicBool,
}

// ── Migrations ───────────────────────────────────────────────────────────

/// One migration step as Settings shows it before running it.
#[derive(Debug, Clone)]
pub struct Step {
    pub version: i64,
    pub description: &'static str,
    pub sql: Vec<String>,
}

/// Versions to run to bring `stored` (None: no board tables) up to `code`; refused when the
/// database is newer than the code.
pub fn plan_versions(stored: Option<i64>, code: i64) -> Result<Vec<i64>, String> {
    let from = stored.unwrap_or(0);
    if from > code {
        return Err(newer_message(from, code));
    }
    // There was never a PostgreSQL version 1: version 2 is the first one.
    Ok(((from + 1).max(2)..=code).collect())
}

/// Everything the migration creates in the schema besides `board_meta`.
const BOARD_RELATIONS: [&str; 9] =
    ["teams", "posts", "cursors", "tasks", "task_deps", "task_events", "hosts", "board_server_seq", "board_arrival_seq"];

pub fn foreign_message(schema: &str, found: &[String]) -> String {
    format!("schema {schema} already contains tables named {} that the board did not create: choose an empty schema", found.join(", "))
}

pub fn newer_message(stored: i64, code: i64) -> String {
    format!("database is from a newer app version (schema {stored}, this app knows {code}): update the app")
}

/// May the store use this schema? (Used on the first command after the store is created.)
pub fn version_check(stored: Option<i64>, schema: &str, code: i64) -> Result<(), String> {
    match stored {
        None => Err(format!(
            "no board tables in PostgreSQL schema {schema} yet: Settings → Agent team board → Create / upgrade tables"
        )),
        Some(v) if v > code => Err(newer_message(v, code)),
        Some(v) if v < code => Err(format!(
            "the board tables in schema {schema} are at version {v}, this app needs {code}: Settings → Agent team board → Create / upgrade tables"
        )),
        Some(_) => Ok(()),
    }
}

const SYNCED: [&str; 5] = ["teams", "posts", "tasks", "task_deps", "task_events"];

/// Version 2: the same tables as the SQLite store (minus the local change log), plus
/// `server_seq` on every synced table (filled by a trigger from `board_server_seq`), the
/// `posts.arrival` sequence and the server-only `hosts` table for stage 3b.
fn v2_sql(schema: &str) -> Vec<String> {
    let q = quote_ident(schema);
    let mut out = vec![
        format!("CREATE SCHEMA IF NOT EXISTS {q}"),
        "CREATE SEQUENCE IF NOT EXISTS @@.board_server_seq".into(),
        "CREATE SEQUENCE IF NOT EXISTS @@.board_arrival_seq".into(),
        "CREATE TABLE IF NOT EXISTS @@.board_meta (key TEXT PRIMARY KEY, value TEXT)".into(),
        "CREATE TABLE IF NOT EXISTS @@.teams (
  uid TEXT PRIMARY KEY, team TEXT NOT NULL, name TEXT, home_host TEXT, home_instance TEXT,
  created_at BIGINT NOT NULL, last_post_seq BIGINT NOT NULL DEFAULT 0, last_task_seq BIGINT NOT NULL DEFAULT 0,
  last_activity_at BIGINT NOT NULL DEFAULT 0, origin_host TEXT, updated_at BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1, deleted_at BIGINT, server_seq BIGINT NOT NULL DEFAULT 0,
  UNIQUE (team, home_host))"
            .into(),
        "CREATE TABLE IF NOT EXISTS @@.posts (
  id TEXT PRIMARY KEY, team_uid TEXT NOT NULL, seq BIGINT NOT NULL, ts BIGINT NOT NULL,
  author_id TEXT, author_name TEXT, author_cli TEXT, author_host TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
  task_id TEXT, arrival BIGINT NOT NULL, origin_host TEXT, updated_at BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1, deleted_at BIGINT, server_seq BIGINT NOT NULL DEFAULT 0,
  UNIQUE (team_uid, seq))"
            .into(),
        "CREATE INDEX IF NOT EXISTS posts_team_kind_seq ON @@.posts (team_uid, kind, seq)".into(),
        "CREATE INDEX IF NOT EXISTS posts_team_ts ON @@.posts (team_uid, ts)".into(),
        "CREATE INDEX IF NOT EXISTS posts_team_arrival ON @@.posts (team_uid, arrival)".into(),
        "CREATE TABLE IF NOT EXISTS @@.cursors (
  team_uid TEXT NOT NULL, tab_id TEXT NOT NULL, arrival BIGINT NOT NULL, PRIMARY KEY (team_uid, tab_id))"
            .into(),
        "CREATE TABLE IF NOT EXISTS @@.tasks (
  id TEXT PRIMARY KEY, team_uid TEXT NOT NULL, seq BIGINT NOT NULL, parent_id TEXT, title TEXT NOT NULL, body TEXT,
  state TEXT NOT NULL, priority BIGINT NOT NULL DEFAULT 1, needs_review BIGINT NOT NULL DEFAULT 0,
  created_by_id TEXT, created_by_name TEXT, created_by_host TEXT,
  owner_id TEXT, owner_name TEXT, owner_host TEXT, owner_instance TEXT,
  attempt BIGINT NOT NULL DEFAULT 0, max_attempts BIGINT NOT NULL DEFAULT 3, blocked_reason TEXT, last_error TEXT,
  result_summary TEXT, result_body TEXT, result_branch TEXT, result_commit TEXT, result_worktree TEXT,
  result_checks TEXT, result_artifacts TEXT, labels TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, claimed_at BIGINT, started_at BIGINT,
  submitted_at BIGINT, finished_at BIGINT, lease_until BIGINT, heartbeat_at BIGINT, due_at BIGINT,
  version BIGINT NOT NULL DEFAULT 1, origin_host TEXT, row_version BIGINT NOT NULL DEFAULT 1, deleted_at BIGINT,
  server_seq BIGINT NOT NULL DEFAULT 0, UNIQUE (team_uid, seq))"
            .into(),
        "CREATE INDEX IF NOT EXISTS tasks_next ON @@.tasks (team_uid, state, priority DESC, seq)".into(),
        "CREATE INDEX IF NOT EXISTS tasks_owner ON @@.tasks (team_uid, owner_id, state)".into(),
        "CREATE INDEX IF NOT EXISTS tasks_parent ON @@.tasks (parent_id)".into(),
        "CREATE INDEX IF NOT EXISTS tasks_lease ON @@.tasks (state, lease_until)".into(),
        "CREATE TABLE IF NOT EXISTS @@.task_deps (
  task_id TEXT NOT NULL, depends_on_id TEXT NOT NULL, team_uid TEXT NOT NULL, origin_host TEXT,
  updated_at BIGINT NOT NULL, row_version BIGINT NOT NULL DEFAULT 1, deleted_at BIGINT,
  server_seq BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (task_id, depends_on_id))"
            .into(),
        "CREATE INDEX IF NOT EXISTS task_deps_on ON @@.task_deps (depends_on_id)".into(),
        "CREATE TABLE IF NOT EXISTS @@.task_events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, team_uid TEXT NOT NULL, seq BIGINT NOT NULL, ts BIGINT NOT NULL,
  actor_id TEXT, actor_name TEXT, actor_host TEXT, action TEXT NOT NULL, from_state TEXT, to_state TEXT,
  attempt BIGINT, note TEXT, data TEXT, origin_host TEXT, updated_at BIGINT NOT NULL,
  row_version BIGINT NOT NULL DEFAULT 1, deleted_at BIGINT, server_seq BIGINT NOT NULL DEFAULT 0)"
            .into(),
        "CREATE INDEX IF NOT EXISTS task_events_task ON @@.task_events (task_id, seq)".into(),
        "CREATE INDEX IF NOT EXISTS task_events_team_ts ON @@.task_events (team_uid, ts)".into(),
        "CREATE TABLE IF NOT EXISTS @@.hosts (
  host TEXT PRIMARY KEY, instance_id TEXT NOT NULL, first_seen BIGINT NOT NULL, last_seen BIGINT NOT NULL,
  app_version TEXT)"
            .into(),
        "CREATE OR REPLACE FUNCTION @@.board_set_server_seq() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.server_seq := nextval('@@.board_server_seq');
  RETURN NEW;
END
$fn$"
            .into(),
    ];
    for t in SYNCED {
        out.push(format!("CREATE INDEX IF NOT EXISTS {t}_server_seq ON @@.{t} (server_seq)"));
        out.push(format!("DROP TRIGGER IF EXISTS board_server_seq ON @@.{t}"));
        out.push(format!(
            "CREATE TRIGGER board_server_seq BEFORE INSERT OR UPDATE ON @@.{t} FOR EACH ROW EXECUTE FUNCTION @@.board_set_server_seq()"
        ));
    }
    out
}

/// The migration steps from `stored` to SCHEMA_VERSION, SQL as it will run.
pub fn migration_steps(schema: &str, stored: Option<i64>) -> Result<Vec<Step>, String> {
    let prefix = format!("{}.", quote_ident(schema));
    plan_versions(stored, SCHEMA_VERSION)?
        .into_iter()
        .map(|v| match v {
            2 => Ok(Step {
                version: 2,
                description: "create the board tables, indexes and sequences (teams, posts, cursors, tasks, task_deps, task_events, hosts, board_meta) and the server_seq trigger",
                sql: v2_sql(schema).into_iter().map(|s| s.replace("@@.", &prefix)).collect(),
            }),
            other => Err(format!("no PostgreSQL migration to version {other}")),
        })
        .collect()
}

// ── Column lists and row decoding ────────────────────────────────────────

const POST_COLS: &str = "p.seq, p.ts, p.author_id, p.author_name, p.author_cli, p.kind, p.text, p.author_host,
    (SELECT k.seq FROM @@.tasks k WHERE k.id = p.task_id AND k.deleted_at IS NULL), p.id";

const TASK_COLS: &str = "t.id, (SELECT tm.team FROM @@.teams tm WHERE tm.uid = t.team_uid), t.seq, t.parent_id,
    (SELECT p.seq FROM @@.tasks p WHERE p.id = t.parent_id AND p.deleted_at IS NULL),
    t.title, t.body, t.state, t.priority, t.needs_review,
    t.created_by_id, t.created_by_name, t.created_by_host,
    t.owner_id, t.owner_name, t.owner_host, t.owner_instance,
    t.attempt, t.max_attempts, t.blocked_reason, t.last_error,
    t.result_summary, t.result_body, t.result_branch, t.result_commit, t.result_worktree,
    t.result_checks, t.result_artifacts, t.labels, t.meta,
    t.created_at, t.updated_at, t.claimed_at, t.started_at, t.submitted_at, t.finished_at,
    t.lease_until, t.heartbeat_at, t.due_at, t.version, t.team_uid, t.row_version";

const UNMET: &str = "EXISTS (SELECT 1 FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
    WHERE d.task_id = t.id AND d.deleted_at IS NULL AND x.deleted_at IS NULL AND x.state NOT IN ('done','cancelled'))";

/// Finished live tasks that may be pruned: nothing live depends on them or is their child.
const PRUNABLE: &str = "t.team_uid = $1 AND t.deleted_at IS NULL AND t.state IN ('done','failed','cancelled')
    AND NOT EXISTS (SELECT 1 FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.task_id
                    WHERE d.depends_on_id = t.id AND d.deleted_at IS NULL AND x.deleted_at IS NULL
                      AND x.state IN ('open','claimed','blocked','review'))
    AND NOT EXISTS (SELECT 1 FROM @@.tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL
                    AND c.state IN ('open','claimed','blocked','review'))";

fn task_from_row(r: &PgRow) -> Result<TaskRow, sqlx::Error> {
    Ok(TaskRow {
        id: r.try_get(0)?,
        team: r.try_get::<Option<String>, _>(1)?.unwrap_or_default(),
        seq: r.try_get(2)?,
        parent_seq: r.try_get(4)?,
        title: r.try_get(5)?,
        body: r.try_get(6)?,
        state: r.try_get(7)?,
        priority: r.try_get(8)?,
        needs_review: r.try_get::<i64, _>(9)? != 0,
        created_by_id: r.try_get(10)?,
        created_by_name: r.try_get(11)?,
        created_by_host: r.try_get(12)?,
        owner_id: r.try_get(13)?,
        owner_name: r.try_get(14)?,
        owner_host: r.try_get(15)?,
        owner_instance: r.try_get(16)?,
        attempt: r.try_get(17)?,
        max_attempts: r.try_get(18)?,
        blocked_reason: r.try_get(19)?,
        last_error: r.try_get(20)?,
        result_summary: r.try_get(21)?,
        result_body: r.try_get(22)?,
        result_branch: r.try_get(23)?,
        result_commit: r.try_get(24)?,
        result_worktree: r.try_get(25)?,
        result_checks: r.try_get(26)?,
        result_artifacts: r.try_get(27)?,
        labels: r.try_get(28)?,
        meta: r.try_get(29)?,
        created_at: r.try_get(30)?,
        updated_at: r.try_get(31)?,
        claimed_at: r.try_get(32)?,
        started_at: r.try_get(33)?,
        submitted_at: r.try_get(34)?,
        finished_at: r.try_get(35)?,
        lease_until: r.try_get(36)?,
        heartbeat_at: r.try_get(37)?,
        due_at: r.try_get(38)?,
        version: r.try_get(39)?,
        team_uid: r.try_get(40)?,
        row_version: r.try_get(41)?,
    })
}

fn post_json(team: &str, r: &PgRow) -> Result<Value, sqlx::Error> {
    let mut author = serde_json::Map::new();
    for (key, idx) in [("id", 2), ("name", 3), ("cliType", 4), ("host", 7)] {
        if let Some(v) = r.try_get::<Option<String>, _>(idx)? {
            author.insert(key.into(), Value::String(v));
        }
    }
    let mut v = json!({
        "id": r.try_get::<String, _>(9)?,
        "seq": r.try_get::<i64, _>(0)?,
        "ts": r.try_get::<i64, _>(1)?,
        "team": team,
        "author": Value::Object(author),
        "kind": r.try_get::<String, _>(5)?,
        "text": r.try_get::<String, _>(6)?,
    });
    if let Some(t) = r.try_get::<Option<i64>, _>(8)? {
        v["task"] = json!(t);
    }
    Ok(v)
}

struct TeamRef {
    uid: String,
    name: Option<String>,
    last_post_seq: i64,
}

#[derive(Clone, Copy)]
enum Lock {
    None,
    Share,
    Update,
}

impl Lock {
    fn sql(self) -> &'static str {
        match self {
            Lock::None => "",
            Lock::Share => " FOR SHARE",
            Lock::Update => " FOR UPDATE",
        }
    }
}

macro_rules! retrying {
    ($self:ident, $call:expr) => {{
        let mut tries = 0u32;
        loop {
            match $call.await {
                Err(e) if e.starts_with(RETRY) && tries < 3 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(15 * u64::from(tries))).await;
                }
                Err(e) => break Err(match e.strip_prefix(RETRY) {
                    Some(m) => unavailable(m),
                    None => e,
                }),
                ok => break ok,
            }
        }
    }};
}

impl PgStore {
    pub fn new(target: PgTarget) -> Self {
        Self::with_limits(target, Limits::default())
    }

    pub fn with_limits(target: PgTarget, limits: Limits) -> Self {
        let prefix = format!("{}.", quote_ident(&target.schema));
        PgStore { target, prefix, limits, pool: OnceCell::new(), ready: AtomicBool::new(false) }
    }

    /// SQL text with every `@@.` replaced by the quoted schema.
    fn s(&self, sql: &str) -> String {
        sql.replace("@@.", &self.prefix)
    }

    fn err(&self, e: sqlx::Error) -> String {
        if matches!(e, sqlx::Error::PoolTimedOut) {
            return unavailable(format!("cannot reach the PostgreSQL server ({}) within {CONNECT_TIMEOUT_SECS} s", self.target.label));
        }
        let retry = matches!(&e, sqlx::Error::Database(d) if matches!(d.code().as_deref(), Some("40P01" | "40001")));
        let msg = self.target.redact(&e.to_string());
        if retry {
            format!("{RETRY}{msg}")
        } else {
            unavailable(msg)
        }
    }

    async fn pool(&self) -> Result<&PgPool, String> {
        self.pool
            .get_or_try_init(|| async {
                Ok::<_, String>(
                    PgPoolOptions::new()
                        .max_connections(5)
                        .acquire_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
                        .idle_timeout(Duration::from_secs(300))
                        .connect_lazy_with(self.target.opts.clone()),
                )
            })
            .await
    }

    /// The pool, after the schema version was checked once (never creates anything).
    async fn ready(&self) -> Result<&PgPool, String> {
        let pool = self.pool().await?;
        if !self.ready.load(Ordering::SeqCst) {
            let mut c = pool.acquire().await.map_err(|e| self.err(e))?;
            let stored = self.stored_version(&mut c).await?;
            version_check(stored, &self.target.schema, SCHEMA_VERSION).map_err(unavailable)?;
            self.ready.store(true, Ordering::SeqCst);
        }
        Ok(pool)
    }

    /// `board_meta.schema_version`, or None when the schema has no board tables.
    async fn stored_version(&self, c: &mut PgConnection) -> Result<Option<i64>, String> {
        let reg: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
            .bind(format!("{}board_meta", self.prefix))
            .fetch_one(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        if reg.is_none() {
            return Ok(None);
        }
        let v: Option<String> = sqlx::query_scalar(&self.s("SELECT value FROM @@.board_meta WHERE key = 'schema_version'"))
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?
            .flatten();
        Ok(Some(v.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0)))
    }

    /// Board table names that already exist in a schema without `board_meta` (someone else's
    /// tables): the migration must not attach indexes and triggers to them.
    async fn foreign_tables(&self, c: &mut PgConnection) -> Result<Vec<String>, String> {
        sqlx::query_scalar(
            "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = ANY($2) ORDER BY 1",
        )
        .bind(&self.target.schema)
        .bind(BOARD_RELATIONS.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    async fn refuse_foreign(&self, c: &mut PgConnection, stored: Option<i64>) -> Result<(), String> {
        if stored.is_some() {
            return Ok(());
        }
        let found = self.foreign_tables(c).await?;
        if found.is_empty() {
            Ok(())
        } else {
            Err(foreign_message(&self.target.schema, &found))
        }
    }

    /// Schema version stored in the database (None: no tables), for Settings.
    pub async fn stored_schema_version(&self) -> Result<Option<i64>, String> {
        let mut c = self.pool().await?.acquire().await.map_err(|e| self.err(e))?;
        self.stored_version(&mut c).await
    }

    /// Create / upgrade the tables (Settings button only). `apply` false: only report what
    /// would run. Refused when the database is newer than this app.
    pub async fn migrate(&self, apply: bool) -> Result<Value, String> {
        let pool = self.pool().await?;
        let mut c = pool.acquire().await.map_err(|e| self.err(e))?;
        let stored = self.stored_version(&mut c).await?;
        self.refuse_foreign(&mut c, stored).await?;
        let steps = migration_steps(&self.target.schema, stored)?;
        let describe = |steps: &[Step]| -> Vec<Value> {
            steps.iter().map(|s| json!({ "version": s.version, "description": s.description, "sql": s.sql })).collect()
        };
        let mut out = json!({
            "schema": self.target.schema,
            "from": stored,
            "to": SCHEMA_VERSION,
            "steps": describe(&steps),
            "upToDate": steps.is_empty(),
            "applied": false,
        });
        if !apply || steps.is_empty() {
            return Ok(out);
        }
        let mut tx = c.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("bbarit-board:{}", self.target.schema))
            .execute(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        // Re-read under the lock: another app may have migrated meanwhile.
        let stored = self.stored_version(&mut tx).await?;
        self.refuse_foreign(&mut tx, stored).await?;
        let steps = migration_steps(&self.target.schema, stored)?;
        for step in &steps {
            for sql in &step.sql {
                sqlx::query(sql).execute(&mut *tx).await.map_err(|e| self.err(e))?;
            }
        }
        if !steps.is_empty() {
            let now = now_ms();
            for (key, value, overwrite) in [
                ("schema_version", SCHEMA_VERSION.to_string(), true),
                ("created_at", now.to_string(), false),
                ("created_by_app_version", env!("CARGO_PKG_VERSION").to_string(), false),
            ] {
                let sql = if overwrite {
                    "INSERT INTO @@.board_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
                } else {
                    "INSERT INTO @@.board_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING"
                };
                sqlx::query(&self.s(sql)).bind(key).bind(value).execute(&mut *tx).await.map_err(|e| self.err(e))?;
            }
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        self.ready.store(false, Ordering::SeqCst);
        out["applied"] = json!(true);
        out["steps"] = Value::Array(describe(&steps));
        Ok(out)
    }

    /// Test connection for Settings: reachable, server version, TLS, schema and its version,
    /// privileges and what to do next. Never fails; problems are in `error` / `next`.
    pub async fn diagnose(target: &PgTarget) -> Value {
        let schema = target.schema.clone();
        let mut out = json!({ "reachable": false, "target": target.label, "schema": schema, "codeVersion": SCHEMA_VERSION });
        let conn = tokio::time::timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS), PgConnection::connect_with(&target.opts)).await;
        let mut c = match conn {
            Err(_) => {
                out["error"] = json!(format!("no answer from the server within {CONNECT_TIMEOUT_SECS} s"));
                out["next"] = json!("check host, port and that the server accepts connections from this machine");
                return out;
            }
            Ok(Err(e)) => {
                out["error"] = json!(target.redact(&e.to_string()));
                out["next"] = json!("check the connection fields, the password and the SSL mode");
                return out;
            }
            Ok(Ok(c)) => c,
        };
        out["reachable"] = json!(true);
        let store = PgStore::new(target.clone());
        let res: Result<(), String> = async {
            let e = |e: sqlx::Error| target.redact(&e.to_string());
            let version: String = sqlx::query_scalar("SHOW server_version").fetch_one(&mut c).await.map_err(e)?;
            out["serverVersion"] = json!(version);
            let tls: Option<bool> = sqlx::query_scalar("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
                .fetch_optional(&mut c)
                .await
                .map_err(e)?;
            out["tls"] = json!(tls.unwrap_or(false));
            let (user, db): (String, String) =
                sqlx::query_as("SELECT current_user::text, current_database()::text").fetch_one(&mut c).await.map_err(e)?;
            out["user"] = json!(user);
            out["database"] = json!(db);
            let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1)")
                .bind(&schema)
                .fetch_one(&mut c)
                .await
                .map_err(e)?;
            out["schemaExists"] = json!(exists);
            let can_create: bool = if exists {
                sqlx::query_scalar("SELECT has_schema_privilege($1, 'CREATE')").bind(&schema).fetch_one(&mut c).await.map_err(e)?
            } else {
                sqlx::query_scalar("SELECT has_database_privilege(current_database(), 'CREATE')").fetch_one(&mut c).await.map_err(e)?
            };
            out["canCreate"] = json!(can_create);
            let stored = store.stored_version(&mut c).await.map_err(clean_err)?;
            out["schemaVersion"] = json!(stored);
            let can_rw: Option<bool> = if stored.is_some() {
                let mut all = true;
                for t in ["teams", "posts", "cursors", "tasks", "task_deps", "task_events", "board_meta"] {
                    let ok: bool = sqlx::query_scalar("SELECT has_table_privilege($1, 'SELECT, INSERT, UPDATE, DELETE')")
                        .bind(format!("{}{t}", store.prefix))
                        .fetch_one(&mut c)
                        .await
                        .map_err(e)?;
                    all &= ok;
                }
                // Writes also draw from the two sequences and fire the server_seq trigger.
                for seq in ["board_server_seq", "board_arrival_seq"] {
                    let ok: bool = sqlx::query_scalar("SELECT has_sequence_privilege($1, 'USAGE')")
                        .bind(format!("{}{seq}", store.prefix))
                        .fetch_one(&mut c)
                        .await
                        .map_err(e)?;
                    all &= ok;
                }
                let ok: bool = sqlx::query_scalar("SELECT has_function_privilege($1, 'EXECUTE')")
                    .bind(format!("{}board_set_server_seq()", store.prefix))
                    .fetch_one(&mut c)
                    .await
                    .map_err(e)?;
                all &= ok;
                Some(all)
            } else {
                None
            };
            out["canReadWrite"] = json!(can_rw);
            let foreign = if stored.is_none() { store.foreign_tables(&mut c).await.map_err(clean_err)? } else { Vec::new() };
            out["foreignTables"] = json!(foreign);
            let next = match stored {
                Some(v) if v > SCHEMA_VERSION => "this database was set up by a newer app version: update the app".to_string(),
                None if !foreign.is_empty() => foreign_message(&schema, &foreign),
                None if can_create => "press Create / upgrade tables".to_string(),
                None => format!("this user cannot create tables here: ask the database owner to create schema {schema} or grant CREATE"),
                Some(v) if v < SCHEMA_VERSION => format!("press Create / upgrade tables (version {v} → {SCHEMA_VERSION})"),
                Some(_) if can_rw == Some(false) => {
                    "this user cannot write the board tables: ask for SELECT, INSERT, UPDATE and DELETE on them, USAGE on board_server_seq and board_arrival_seq, and EXECUTE on board_set_server_seq()".to_string()
                }
                Some(_) => "ready: choose \"PostgreSQL only\" as the usage type; to bring the boards of this computer, use Copy data from this computer (SQLite) to PostgreSQL first".to_string(),
            };
            out["next"] = json!(next);
            Ok(())
        }
        .await;
        if let Err(e) = res {
            out["error"] = json!(e);
        }
        let _ = c.close().await;
        out
    }

    // ── Teams ────────────────────────────────────────────────────────────

    /// The live team row this machine uses for root tab `team` (see sqlite::find_team).
    async fn find_team(&self, c: &mut PgConnection, team: &str, host: Option<&str>, lock: Lock) -> Result<Option<TeamRef>, String> {
        let sql = self.s(&format!(
            "SELECT uid, name, last_post_seq FROM @@.teams WHERE team = $1 AND deleted_at IS NULL
             ORDER BY (home_host IS NOT DISTINCT FROM $2) DESC, last_activity_at DESC LIMIT 1{}",
            lock.sql()
        ));
        let row = sqlx::query(&sql).bind(team).bind(host).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        row.map(|r| -> Result<TeamRef, sqlx::Error> {
            Ok(TeamRef { uid: r.try_get(0)?, name: r.try_get(1)?, last_post_seq: r.try_get(2)? })
        })
        .transpose()
        .map_err(|e| self.err(e))
    }

    /// The team homed on this machine for root tab `team`, created (or revived) when missing;
    /// its row stays locked until the transaction ends.
    async fn ensure_team(&self, c: &mut PgConnection, team: &str, name: Option<&str>, ctx: &Ctx) -> Result<String, String> {
        let now = ctx.now;
        for _ in 0..2 {
            let found = sqlx::query(&self.s(
                "SELECT uid, name, deleted_at FROM @@.teams WHERE team = $1 AND home_host IS NOT DISTINCT FROM $2 FOR UPDATE",
            ))
            .bind(team)
            .bind(&ctx.host)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
            if let Some(r) = found {
                let (uid, old_name, deleted): (String, Option<String>, Option<i64>) =
                    (r.try_get(0).map_err(|e| self.err(e))?, r.try_get(1).map_err(|e| self.err(e))?, r.try_get(2).map_err(|e| self.err(e))?);
                let rename = name.is_some() && name != old_name.as_deref();
                if deleted.is_some() || rename {
                    sqlx::query(&self.s(
                        "UPDATE @@.teams SET deleted_at = NULL, name = coalesce($2, name), updated_at = $3, row_version = row_version + 1
                         WHERE uid = $1",
                    ))
                    .bind(&uid)
                    .bind(name)
                    .bind(now)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?;
                }
                return Ok(uid);
            }
            let uid = new_id();
            let inserted = sqlx::query(&self.s(
                "INSERT INTO @@.teams (uid, team, name, home_host, home_instance, created_at, last_activity_at, origin_host, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $6, $4, $6) ON CONFLICT (team, home_host) DO NOTHING",
            ))
            .bind(&uid)
            .bind(team)
            .bind(name)
            .bind(&ctx.host)
            .bind(&ctx.instance)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?
            .rows_affected();
            if inserted > 0 {
                return Ok(uid);
            }
            // Another writer created it first: lock theirs.
        }
        Err(unavailable("could not create the team row"))
    }

    /// Next post / task number of a team (never repeats, never goes back); also marks activity.
    async fn next_seq(&self, c: &mut PgConnection, uid: &str, task: bool, now: i64) -> Result<i64, String> {
        let sql = if task {
            "UPDATE @@.teams SET last_task_seq = last_task_seq + 1, last_activity_at = $2, updated_at = $2, row_version = row_version + 1
             WHERE uid = $1 RETURNING last_task_seq"
        } else {
            "UPDATE @@.teams SET last_post_seq = last_post_seq + 1, last_activity_at = $2, updated_at = $2, row_version = row_version + 1
             WHERE uid = $1 RETURNING last_post_seq"
        };
        sqlx::query_scalar(&self.s(sql)).bind(uid).bind(now).fetch_one(&mut *c).await.map_err(|e| self.err(e))
    }

    async fn touch_team(&self, c: &mut PgConnection, uid: &str, now: i64) -> Result<(), String> {
        sqlx::query(&self.s("UPDATE @@.teams SET last_activity_at = $2, updated_at = $2, row_version = row_version + 1 WHERE uid = $1"))
            .bind(uid)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(())
    }

    async fn lock_team(&self, c: &mut PgConnection, uid: &str) -> Result<bool, String> {
        let row = sqlx::query(&self.s("SELECT uid FROM @@.teams WHERE uid = $1 FOR UPDATE"))
            .bind(uid)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(row.is_some())
    }

    async fn ids(&self, c: &mut PgConnection, sql: &str, arg: &str) -> Result<Vec<String>, String> {
        sqlx::query_scalar(&self.s(sql)).bind(arg).fetch_all(&mut *c).await.map_err(|e| self.err(e))
    }

    async fn count(&self, c: &mut PgConnection, sql: &str, arg: &str) -> Result<i64, String> {
        sqlx::query_scalar(&self.s(sql)).bind(arg).fetch_one(&mut *c).await.map_err(|e| self.err(e))
    }

    // ── Posts ────────────────────────────────────────────────────────────

    async fn tombstone_posts(&self, c: &mut PgConnection, ids: &[String], now: i64) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        sqlx::query(&self.s(
            "UPDATE @@.posts SET deleted_at = $2, updated_at = $2, row_version = row_version + 1 WHERE id = ANY($1) AND deleted_at IS NULL",
        ))
        .bind(ids)
        .bind(now)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        Ok(())
    }

    /// One post: the team's next seq, the row (arrival from the arrival sequence, under the
    /// team lock) and the per-team cap on live posts. Returns (id, seq).
    #[allow(clippy::too_many_arguments)]
    async fn insert_post(
        &self,
        c: &mut PgConnection,
        team_uid: &str,
        author_id: &str,
        author_name: Option<&str>,
        author_cli: Option<&str>,
        kind: &str,
        text: &str,
        task_id: Option<&str>,
        ctx: &Ctx,
    ) -> Result<(String, i64), String> {
        let now = ctx.now;
        let seq = self.next_seq(c, team_uid, false, now).await?;
        let id = new_id();
        sqlx::query(&self.s(
            "INSERT INTO @@.posts (id, team_uid, seq, ts, author_id, author_name, author_cli, author_host, kind, text, task_id, arrival, origin_host, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, nextval('@@.board_arrival_seq'), $8, $4)",
        ))
        .bind(&id)
        .bind(team_uid)
        .bind(seq)
        .bind(now)
        .bind(author_id)
        .bind(author_name)
        .bind(author_cli)
        .bind(&ctx.host)
        .bind(kind)
        .bind(text)
        .bind(task_id)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        let over: Vec<String> = sqlx::query_scalar(&self.s(
            "SELECT id FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL ORDER BY seq DESC OFFSET $2",
        ))
        .bind(team_uid)
        .bind(self.limits.posts)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        self.tombstone_posts(c, &over, now).await?;
        Ok((id, seq))
    }

    async fn task_id_of(&self, c: &mut PgConnection, team_uid: &str, team: &str, seq: i64) -> Result<String, String> {
        sqlx::query_scalar(&self.s("SELECT id FROM @@.tasks WHERE team_uid = $1 AND seq = $2 AND deleted_at IS NULL"))
            .bind(team_uid)
            .bind(seq)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?
            .ok_or_else(|| format!("no task #{seq} in team {team}"))
    }

    pub async fn post(&self, team: String, input: PostInput, ctx: Ctx) -> Result<Value, String> {
        retrying!(self, self.post_once(&team, &input, &ctx))
    }

    async fn post_once(&self, team: &str, input: &PostInput, ctx: &Ctx) -> Result<Value, String> {
        let spec = PostSpec::check(team, input)?;
        let mut tx = self.ready().await?.begin().await.map_err(|e| self.err(e))?;
        let uid = self.ensure_team(&mut tx, team, spec.team_name.as_deref(), ctx).await?;
        let task_id = match input.task {
            Some(seq) => Some(self.task_id_of(&mut tx, &uid, team, seq).await?),
            None => None,
        };
        let (id, _) = self
            .insert_post(
                &mut tx,
                &uid,
                &spec.author_id,
                spec.author_name.as_deref(),
                spec.author_cli.as_deref(),
                &spec.kind,
                &spec.text,
                task_id.as_deref(),
                ctx,
            )
            .await?;
        let row = sqlx::query(&self.s(&format!("SELECT {POST_COLS} FROM @@.posts p WHERE p.id = $1")))
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let out = post_json(team, &row).map_err(|e| self.err(e))?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(out)
    }

    /// See sqlite::read. A `--new` read holds the team row FOR SHARE, so no post lands between
    /// the rows it returns and the cursor it stores.
    pub async fn read(&self, team: String, q: ReadQuery, host: Option<String>) -> Result<Value, String> {
        retrying!(self, self.read_once(&team, &q, host.as_deref()))
    }

    async fn read_once(&self, team: &str, q: &ReadQuery, host: Option<&str>) -> Result<Value, String> {
        let spec = ReadSpec::check(team, q)?;
        let exclude_kind: Option<&str> = if spec.pinned { Some("announce") } else { None };
        let mut tx = self.ready().await?.begin().await.map_err(|e| self.err(e))?;
        let cursor_read = spec.cursor_tab.is_some();
        if !cursor_read {
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        }
        let Some(t) = self.find_team(&mut tx, team, host, if cursor_read { Lock::Share } else { Lock::None }).await? else {
            return Ok(spec.empty(team));
        };
        let uid = t.uid.as_str();
        let cursor: i64 = match &spec.cursor_tab {
            Some(tab) => sqlx::query_scalar(&self.s("SELECT arrival FROM @@.cursors WHERE team_uid = $1 AND tab_id = $2"))
                .bind(uid)
                .bind(tab)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| self.err(e))?
                .unwrap_or(0),
            None => 0,
        };
        let total = self.count(&mut tx, "SELECT count(*) FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
        const FILTER: &str = "p.team_uid = $1 AND p.deleted_at IS NULL AND p.seq > $2 AND p.arrival > $3
            AND ($4::text IS NULL OR p.kind = $4)
            AND ($5::text IS NULL OR p.author_id = $5 OR lower(p.author_name) = lower($5))
            AND ($6::text IS NULL OR p.text ILIKE $6 ESCAPE E'\\\\')
            AND ($7::text IS NULL OR p.author_id IS DISTINCT FROM $7)
            AND ($8::text IS NULL OR p.kind <> $8)";
        let matched: i64 = sqlx::query_scalar(&self.s(&format!("SELECT count(*) FROM @@.posts p WHERE {FILTER}")))
            .bind(uid)
            .bind(spec.seq_after)
            .bind(cursor)
            .bind(&spec.kind)
            .bind(&spec.author)
            .bind(&spec.pattern)
            .bind(&spec.exclude)
            .bind(exclude_kind)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let rows = sqlx::query(&self.s(&format!(
            "SELECT {POST_COLS}, p.arrival FROM @@.posts p WHERE {FILTER} ORDER BY {} LIMIT $9",
            if cursor_read { "p.arrival ASC" } else { "p.seq DESC" }
        )))
        .bind(uid)
        .bind(spec.seq_after)
        .bind(cursor)
        .bind(&spec.kind)
        .bind(&spec.author)
        .bind(&spec.pattern)
        .bind(&spec.exclude)
        .bind(exclude_kind)
        .bind(spec.limit)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        let mut pairs = Vec::with_capacity(rows.len());
        for r in &rows {
            pairs.push((post_json(team, r).map_err(|e| self.err(e))?, r.try_get::<i64, _>(10).map_err(|e| self.err(e))?));
        }
        if !cursor_read {
            pairs.reverse();
        }
        let last_arrival = pairs.last().map(|(_, a)| *a);
        let posts: Vec<Value> = pairs.into_iter().map(|(p, _)| p).collect();
        let announcements: Vec<Value> = if spec.pinned {
            let rows = sqlx::query(&self.s(&format!(
                "SELECT {POST_COLS} FROM @@.posts p WHERE p.team_uid = $1 AND p.deleted_at IS NULL AND p.kind = 'announce'
                 ORDER BY p.seq DESC LIMIT $2"
            )))
            .bind(uid)
            .bind(PINNED_ANNOUNCEMENTS)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
            let mut v = rows.iter().map(|r| post_json(team, r)).collect::<Result<Vec<_>, _>>().map_err(|e| self.err(e))?;
            v.reverse();
            v
        } else {
            Vec::new()
        };
        let more = (matched - posts.len() as i64).max(0);
        let mut new_cursor = None;
        if let Some(tab) = &spec.cursor_tab {
            let newest = self.count(&mut tx, "SELECT coalesce(max(arrival), 0) FROM @@.posts WHERE team_uid = $1", uid).await?;
            let target = if more > 0 { last_arrival.unwrap_or(cursor) } else { newest.max(cursor) };
            sqlx::query(&self.s(
                "INSERT INTO @@.cursors AS c (team_uid, tab_id, arrival) VALUES ($1, $2, $3)
                 ON CONFLICT (team_uid, tab_id) DO UPDATE SET arrival = GREATEST(c.arrival, excluded.arrival)",
            ))
            .bind(uid)
            .bind(tab)
            .bind(target)
            .execute(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
            new_cursor = Some(target);
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        let mut out = json!({
            "team": team,
            "posts": posts,
            "lastSeq": t.last_post_seq,
            "total": total,
            "matched": matched,
            "more": more,
            "since": spec.since,
        });
        if spec.pinned {
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

    pub async fn teams(&self) -> Result<Vec<Value>, String> {
        let pool = self.ready().await?;
        let rows = sqlx::query(&self.s(
            "SELECT t.team, t.name, t.last_post_seq, t.last_activity_at,
                    count(p.id), count(DISTINCT p.author_id), min(p.ts), max(p.ts),
                    (SELECT count(*) FROM @@.tasks k WHERE k.team_uid = t.uid AND k.deleted_at IS NULL
                       AND k.state IN ('open','claimed','blocked','review')),
                    t.last_task_seq, t.home_host, t.uid
             FROM @@.teams t LEFT JOIN @@.posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid
             ORDER BY t.last_activity_at DESC, coalesce(max(p.ts), 0) DESC
             LIMIT $1",
        ))
        .bind(MAX_TEAMS_LISTED)
        .fetch_all(pool)
        .await
        .map_err(|e| self.err(e))?;
        rows.iter()
            .map(|r| -> Result<Value, sqlx::Error> {
                let mut v = json!({
                    "team": r.try_get::<String, _>(0)?,
                    "lastSeq": r.try_get::<i64, _>(2)?,
                    "updatedTs": r.try_get::<i64, _>(3)?,
                    "posts": r.try_get::<i64, _>(4)?,
                    "members": r.try_get::<i64, _>(5)?,
                    "firstTs": r.try_get::<Option<i64>, _>(6)?,
                    "lastTs": r.try_get::<Option<i64>, _>(7)?,
                    "liveTasks": r.try_get::<i64, _>(8)?,
                    "lastTaskSeq": r.try_get::<i64, _>(9)?,
                    "uid": r.try_get::<String, _>(11)?,
                });
                if let Some(name) = r.try_get::<Option<String>, _>(1)? {
                    v["teamName"] = Value::String(name);
                }
                if let Some(host) = r.try_get::<Option<String>, _>(10)? {
                    v["homeHost"] = Value::String(host);
                }
                Ok(v)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.err(e))
    }

    pub async fn clear(&self, team: String, ctx: Ctx) -> Result<Value, String> {
        retrying!(self, self.clear_once(&team, &ctx))
    }

    async fn clear_once(&self, team: &str, ctx: &Ctx) -> Result<Value, String> {
        check_team(team)?;
        let mut tx = self.ready().await?.begin().await.map_err(|e| self.err(e))?;
        let Some(t) = self.find_team(&mut tx, team, ctx.host.as_deref(), Lock::Update).await? else {
            return Ok(json!({ "team": team, "removed": 0, "lastSeq": 0 }));
        };
        let ids = self.ids(&mut tx, "SELECT id FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", &t.uid).await?;
        self.tombstone_posts(&mut tx, &ids, ctx.now).await?;
        self.touch_team(&mut tx, &t.uid, ctx.now).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(json!({ "team": team, "removed": ids.len(), "lastSeq": t.last_post_seq }))
    }

    /// "Clean up old teams" (Settings; never automatic on a shared server): tombstone every
    /// team idle for `max_age_ms` with its posts, tasks, dependencies and events (cursors go),
    /// then remove tombstones older than TOMBSTONE_RETENTION_MS. One transaction per team.
    /// How many teams "Clean up old teams" would retire now (nothing is changed).
    pub async fn stale_count(&self, now: i64, max_age_ms: i64) -> Result<i64, String> {
        sqlx::query_scalar(&self.s(
            "SELECT count(*) FROM (SELECT t.uid FROM @@.teams t LEFT JOIN @@.posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid HAVING greatest(t.last_activity_at, coalesce(max(p.ts), 0)) < $1) x",
        ))
        .bind(now - max_age_ms)
        .fetch_one(self.ready().await?)
        .await
        .map_err(|e| self.err(e))
    }

    pub async fn prune_stale(&self, now: i64, max_age_ms: i64) -> Result<usize, String> {
        let cutoff = now - max_age_ms;
        let pool = self.ready().await?;
        let candidates: Vec<String> = sqlx::query_scalar(&self.s(
            "SELECT t.uid FROM @@.teams t LEFT JOIN @@.posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid HAVING greatest(t.last_activity_at, coalesce(max(p.ts), 0)) < $1",
        ))
        .bind(cutoff)
        .fetch_all(pool)
        .await
        .map_err(|e| self.err(e))?;
        let mut retired = 0usize;
        for uid in &candidates {
            let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
            // Re-check under the team lock: it may have become active meanwhile.
            let last: Option<i64> = sqlx::query_scalar(&self.s(
                "SELECT greatest(t.last_activity_at,
                        coalesce((SELECT max(p.ts) FROM @@.posts p WHERE p.team_uid = t.uid AND p.deleted_at IS NULL), 0))
                 FROM @@.teams t WHERE t.uid = $1 AND t.deleted_at IS NULL FOR UPDATE",
            ))
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| self.err(e))?
            .flatten();
            if !last.is_some_and(|l| l < cutoff) {
                continue;
            }
            let posts = self.ids(&mut tx, "SELECT id FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
            self.tombstone_posts(&mut tx, &posts, now).await?;
            let tasks = self.ids(&mut tx, "SELECT id FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
            self.tombstone_tasks(&mut tx, &tasks, now).await?;
            sqlx::query(&self.s("DELETE FROM @@.cursors WHERE team_uid = $1")).bind(uid).execute(&mut *tx).await.map_err(|e| self.err(e))?;
            sqlx::query(&self.s("UPDATE @@.teams SET deleted_at = $2, updated_at = $2, row_version = row_version + 1 WHERE uid = $1"))
                .bind(uid)
                .bind(now)
                .execute(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            tx.commit().await.map_err(|e| self.err(e))?;
            retired += 1;
        }
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let purge_before = now - TOMBSTONE_RETENTION_MS;
        for table in ["posts", "task_events", "task_deps", "tasks", "teams"] {
            sqlx::query(&self.s(&format!("DELETE FROM @@.{table} WHERE deleted_at IS NOT NULL AND deleted_at < $1")))
                .bind(purge_before)
                .execute(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
        }
        sqlx::query(&self.s("DELETE FROM @@.cursors WHERE team_uid NOT IN (SELECT uid FROM @@.teams)"))
            .execute(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(retired)
    }

    // ── Tasks ────────────────────────────────────────────────────────────

    async fn load_task(&self, c: &mut PgConnection, team_uid: &str, team: &str, seq: i64, lock: bool) -> Result<TaskRow, String> {
        let sql = self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t WHERE t.team_uid = $1 AND t.seq = $2 AND t.deleted_at IS NULL{}",
            if lock { " FOR UPDATE OF t" } else { "" }
        ));
        let row = sqlx::query(&sql).bind(team_uid).bind(seq).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        match row {
            Some(r) => task_from_row(&r).map_err(|e| self.err(e)),
            None => Err(format!("no task #{seq} in team {team}")),
        }
    }

    async fn load_task_by_id(&self, c: &mut PgConnection, id: &str, lock: bool) -> Result<Option<TaskRow>, String> {
        let sql = self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t WHERE t.id = $1 AND t.deleted_at IS NULL{}",
            if lock { " FOR UPDATE OF t" } else { "" }
        ));
        let row = sqlx::query(&sql).bind(id).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        row.map(|r| task_from_row(&r)).transpose().map_err(|e| self.err(e))
    }

    async fn deps_of(&self, c: &mut PgConnection, task_id: &str) -> Result<Vec<(i64, String)>, String> {
        sqlx::query_as(&self.s(
            "SELECT x.seq, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
             WHERE d.task_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        ))
        .bind(task_id)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    async fn task_out(&self, c: &mut PgConnection, row: &TaskRow, now: i64, stale_ms: i64) -> Result<Value, String> {
        Ok(task_json(row, &self.deps_of(c, &row.id).await?, now, stale_ms))
    }

    #[allow(clippy::too_many_arguments)]
    async fn add_event(
        &self,
        c: &mut PgConnection,
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
        let seq = self.count(c, "SELECT coalesce(max(seq), 0) + 1 FROM @@.task_events WHERE task_id = $1", &task.id).await?;
        sqlx::query(&self.s(
            "INSERT INTO @@.task_events (id, task_id, team_uid, seq, ts, actor_id, actor_name, actor_host, action, from_state, to_state,
               attempt, note, data, origin_host, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $5)",
        ))
        .bind(new_id())
        .bind(&task.id)
        .bind(&task.team_uid)
        .bind(seq)
        .bind(now)
        .bind(&actor.id)
        .bind(&actor.name)
        .bind(&actor.host)
        .bind(action)
        .bind(from)
        .bind(to)
        .bind(attempt)
        .bind(note)
        .bind(data.map(|d| d.to_string()))
        .bind(origin_host)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        Ok(())
    }

    /// Release claimed/blocked tasks whose lease ran out (see sqlite::expire_leases); rows
    /// another writer holds right now are skipped (the next reader gets them).
    async fn expire_leases(&self, c: &mut PgConnection, team_uid: Option<&str>, now: i64, except: Option<&str>, host: Option<&str>) -> Result<Vec<Value>, String> {
        let rows = sqlx::query(&self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.lease_until IS NOT NULL AND t.lease_until < $1
               AND ($2::text IS NULL OR t.team_uid = $2) AND ($3::text IS NULL OR t.id <> $3)
             FOR UPDATE OF t SKIP LOCKED"
        )))
        .bind(now)
        .bind(team_uid)
        .bind(except)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        let rows = rows.iter().map(task_from_row).collect::<Result<Vec<_>, _>>().map_err(|e| self.err(e))?;
        let app = Actor::app(host);
        let mut out = Vec::new();
        for row in rows {
            let n = sqlx::query(&self.s(
                "UPDATE @@.tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL,
                   owner_instance = NULL, lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL,
                   updated_at = $2, version = version + 1, row_version = row_version + 1
                 WHERE id = $1 AND state = $3 AND deleted_at IS NULL",
            ))
            .bind(&row.id)
            .bind(now)
            .bind(&row.state)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?
            .rows_affected();
            if n == 0 {
                continue;
            }
            self.add_event(
                c,
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
            )
            .await?;
            out.push(json!({ "team": row.team, "seq": row.seq, "ownerId": row.owner_id, "from": row.state }));
        }
        Ok(out)
    }

    /// Tombstone tasks with their events and dependency rows.
    async fn tombstone_tasks(&self, c: &mut PgConnection, ids: &[String], now: i64) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        for sql in [
            "UPDATE @@.tasks SET deleted_at = $2, updated_at = $2, row_version = row_version + 1 WHERE id = ANY($1) AND deleted_at IS NULL",
            "UPDATE @@.task_events SET deleted_at = $2, updated_at = $2, row_version = row_version + 1 WHERE task_id = ANY($1) AND deleted_at IS NULL",
            "UPDATE @@.task_deps SET deleted_at = $2, updated_at = $2, row_version = row_version + 1
             WHERE (task_id = ANY($1) OR depends_on_id = ANY($1)) AND deleted_at IS NULL",
        ] {
            sqlx::query(&self.s(sql)).bind(ids).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?;
        }
        Ok(())
    }

    async fn tombstone_dep(&self, c: &mut PgConnection, task_id: &str, depends_on_id: &str, now: i64) -> Result<u64, String> {
        Ok(sqlx::query(&self.s(
            "UPDATE @@.task_deps SET deleted_at = $3, updated_at = $3, row_version = row_version + 1
             WHERE task_id = $1 AND depends_on_id = $2 AND deleted_at IS NULL",
        ))
        .bind(task_id)
        .bind(depends_on_id)
        .bind(now)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?
        .rows_affected())
    }

    async fn insert_dep(&self, c: &mut PgConnection, task_id: &str, depends_on_id: &str, team_uid: &str, ctx: &Ctx) -> Result<(), String> {
        sqlx::query(&self.s(
            "INSERT INTO @@.task_deps AS d (task_id, depends_on_id, team_uid, origin_host, updated_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (task_id, depends_on_id) DO UPDATE SET deleted_at = NULL, updated_at = excluded.updated_at,
               origin_host = excluded.origin_host, row_version = d.row_version + 1",
        ))
        .bind(task_id)
        .bind(depends_on_id)
        .bind(team_uid)
        .bind(&ctx.host)
        .bind(ctx.now)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        Ok(())
    }

    /// Keep a team within its caps on live rows (see sqlite::prune_team).
    async fn prune_team(&self, c: &mut PgConnection, team_uid: &str, room: i64, now: i64) -> Result<usize, String> {
        let limits = self.limits;
        let mut removed = 0usize;
        let count = self.count(c, "SELECT count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL", team_uid).await?;
        let target = (limits.tasks - room).max(0);
        if count > target {
            let ids: Vec<String> = sqlx::query_scalar(&self.s(&format!(
                "SELECT t.id FROM @@.tasks t WHERE {PRUNABLE} ORDER BY coalesce(t.finished_at, t.updated_at), t.seq LIMIT $2"
            )))
            .bind(team_uid)
            .bind(count - target)
            .fetch_all(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
            self.tombstone_tasks(c, &ids, now).await?;
            removed += ids.len();
        }
        let events = self.count(c, "SELECT count(*) FROM @@.task_events WHERE team_uid = $1 AND deleted_at IS NULL", team_uid).await?;
        if events > limits.events {
            let mut need = events - limits.events;
            let candidates: Vec<(String, i64)> = sqlx::query_as(&self.s(&format!(
                "SELECT t.id, (SELECT count(*) FROM @@.task_events e WHERE e.task_id = t.id AND e.deleted_at IS NULL) FROM @@.tasks t
                 WHERE {PRUNABLE} ORDER BY coalesce(t.finished_at, t.updated_at), t.seq"
            )))
            .bind(team_uid)
            .fetch_all(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
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
                self.tombstone_tasks(c, &ids, now).await?;
                removed += ids.len();
            }
        }
        Ok(removed)
    }

    /// Does `from` (transitively) depend on `target`? Bounded by MAX_DEP_DEPTH levels.
    async fn depends_transitively(&self, c: &mut PgConnection, from: &str, target: &str) -> Result<bool, String> {
        let mut frontier = vec![from.to_string()];
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::from([from.to_string()]);
        let sql = self.s("SELECT depends_on_id FROM @@.task_deps WHERE task_id = ANY($1) AND deleted_at IS NULL");
        for _ in 0..MAX_DEP_DEPTH {
            if frontier.is_empty() {
                return Ok(false);
            }
            let deps: Vec<String> = sqlx::query_scalar(&sql).bind(&frontier).fetch_all(&mut *c).await.map_err(|e| self.err(e))?;
            let mut next = Vec::new();
            for dep in deps {
                if dep == target {
                    return Ok(true);
                }
                if seen.insert(dep.clone()) {
                    next.push(dep);
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

    async fn add_task(&self, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, String> {
        let spec = AddSpec::check(op)?;
        let now = ctx.now;
        let mut tx = self.ready().await?.begin().await.map_err(|e| self.err(e))?;
        let uid = self.ensure_team(&mut tx, team, spec.team_name.as_deref(), ctx).await?;
        let parent_id = match op.parent {
            Some(seq) => Some(self.task_id_of(&mut tx, &uid, team, seq).await?),
            None => None,
        };
        let id = new_id();
        let mut dep_ids = Vec::new();
        for seq in &spec.after {
            let dep = self.load_task(&mut tx, &uid, team, *seq, false).await?;
            if dep.state == "cancelled" {
                return Err(format!("#{seq} is cancelled: it cannot be a dependency"));
            }
            self.depends_transitively(&mut tx, &dep.id, &id).await?;
            dep_ids.push(dep.id);
        }
        self.prune_team(&mut tx, &uid, 1, now).await?;
        let count = self.count(&mut tx, "SELECT count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL", &uid).await?;
        if count >= self.limits.tasks {
            return Err(format!(
                "task limit reached: team {team} has {count} tasks that cannot be pruned (max {}); finish or cancel some first",
                self.limits.tasks
            ));
        }
        let seq = self.next_seq(&mut tx, &uid, true, now).await?;
        sqlx::query(&self.s(
            "INSERT INTO @@.tasks (id, team_uid, seq, parent_id, title, body, state, priority, needs_review,
               created_by_id, created_by_name, created_by_host, max_attempts, labels, created_at, updated_at, origin_host)
             VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11, $12, $13, $14, $14, $15)",
        ))
        .bind(&id)
        .bind(&uid)
        .bind(seq)
        .bind(&parent_id)
        .bind(&spec.title)
        .bind(&spec.body)
        .bind(spec.priority)
        .bind(i64::from(spec.review))
        .bind(&actor.id)
        .bind(&actor.name)
        .bind(&actor.host)
        .bind(spec.max_attempts)
        .bind(spec.labels_json())
        .bind(now)
        .bind(&ctx.host)
        .execute(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        for dep in &dep_ids {
            self.insert_dep(&mut tx, &id, dep, &uid, ctx).await?;
        }
        let row = self.load_task(&mut tx, &uid, team, seq, false).await?;
        self.add_event(
            &mut tx,
            &row,
            now,
            actor,
            "add",
            None,
            Some("open"),
            0,
            None,
            Some(json!({ "parent": op.parent, "after": spec.after, "priority": spec.priority, "review": spec.review })),
            ctx.host.as_deref(),
        )
        .await?;
        self.prune_team(&mut tx, &uid, 0, now).await?;
        let task = self.task_out(&mut tx, &row, now, DEFAULT_STALE_MS).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(json!({ "action": "add", "from": Value::Null, "to": "open", "task": task, "expired": [] }))
    }

    pub async fn task_write(&self, team: String, op: TaskOpInput, actor: Actor, ctx: Ctx) -> Result<Value, String> {
        retrying!(self, self.task_write_once(&team, &op, &actor, &ctx))
    }

    /// One task write (see sqlite::task_write): the team row locked first, lazy lease expiry,
    /// the rule check, a guarded UPDATE and the event, all in one transaction.
    async fn task_write_once(&self, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, String> {
        check_team(team)?;
        let name = op.op.trim();
        if name == "add" {
            return self.add_task(team, op, actor, ctx).await;
        }
        let WriteSpec { action, reason, result, claim_next, lease } = WriteSpec::check(name, op)?;
        let now = ctx.now;
        let host = ctx.host.as_deref();
        let mut tx = self.ready().await?.begin().await.map_err(|e| self.err(e))?;
        let Some(team_ref) = self.find_team(&mut tx, team, host, Lock::Update).await? else {
            if claim_next {
                return Ok(none_ready(0, 0, Vec::new()));
            }
            return Err(format!("no task #{} in team {team}", op.task.unwrap_or(0)));
        };
        let uid = team_ref.uid.as_str();
        let target: Option<TaskRow> = match op.task {
            Some(seq) => Some(self.load_task(&mut tx, uid, team, seq, true).await?),
            None => None,
        };
        let except = target.as_ref().filter(|t| t.owner_id.as_deref() == Some(actor.id.as_str())).map(|t| t.id.clone());
        let expired = self.expire_leases(&mut tx, Some(uid), now, except.as_deref(), host).await?;
        let row = match target {
            Some(t) => self.load_task(&mut tx, uid, team, t.seq, false).await?,
            None => {
                let next: Option<i64> = sqlx::query_scalar(&self.s(&format!(
                    "SELECT t.seq FROM @@.tasks t WHERE t.team_uid = $1 AND t.deleted_at IS NULL AND t.state = 'open' AND NOT {UNMET}
                     ORDER BY t.priority DESC, t.seq LIMIT 1 FOR UPDATE OF t SKIP LOCKED"
                )))
                .bind(uid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
                match next {
                    Some(seq) => self.load_task(&mut tx, uid, team, seq, false).await?,
                    None => {
                        let (open, waiting): (i64, i64) = sqlx::query_as(&self.s(&format!(
                            "SELECT count(*), count(*) FILTER (WHERE {UNMET}) FROM @@.tasks t
                             WHERE t.team_uid = $1 AND t.deleted_at IS NULL AND t.state = 'open'"
                        )))
                        .bind(uid)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(|e| self.err(e))?;
                        tx.commit().await.map_err(|e| self.err(e))?;
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
        let c: &mut PgConnection = &mut tx;
        let n: u64 = match action {
            Action::Claim => {
                let deps = self.deps_of(c, id).await?;
                let unmet: Vec<String> = deps.iter().filter(|(_, s)| !dep_met(s)).map(|(n, s)| format!("#{n} ({s})")).collect();
                if !unmet.is_empty() {
                    return Err(format!("#{seq} is waiting for {}: claim a ready task (agent task list --ready)", unmet.join(", ")));
                }
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'claimed', owner_id = $2, owner_name = $3, owner_host = $4, owner_instance = $5,
                       claimed_at = $6, started_at = coalesce(started_at, $6), lease_until = $7, heartbeat_at = $6,
                       blocked_reason = NULL, updated_at = $6, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = 'open' AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(owner)
                    .bind(&actor.name)
                    .bind(&actor.host)
                    .bind(&ctx.instance)
                    .bind(now)
                    .bind(now + lease)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Block => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'blocked', blocked_reason = $3, lease_until = $4, heartbeat_at = $5,
                       owner_instance = $6, updated_at = $5, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = 'claimed' AND owner_id = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(owner)
                    .bind(&reason)
                    .bind(now + lease)
                    .bind(now)
                    .bind(&ctx.instance)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Unblock => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'claimed', blocked_reason = NULL, lease_until = $3, heartbeat_at = $4,
                       owner_instance = $5, updated_at = $4, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = 'blocked' AND owner_id = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(owner)
                    .bind(now + lease)
                    .bind(now)
                    .bind(&ctx.instance)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Release => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL, owner_instance = NULL,
                       lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL, updated_at = $4, version = version + 1,
                       row_version = row_version + 1
                     WHERE id = $1 AND state = $3 AND owner_id = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql).bind(id).bind(owner).bind(&from).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
            Action::Done | Action::Submit => {
                let r = result.clone().unwrap_or_default();
                note = Some(r.summary.clone());
                data = Some(json!({ "branch": r.branch, "commit": r.commit, "checks": r.checks }));
                let sql = self.s(
                    "UPDATE @@.tasks SET state = $3, result_summary = $4, result_body = $5, result_branch = $6, result_commit = $7,
                       result_worktree = $8, result_checks = $9, result_artifacts = $10,
                       submitted_at = CASE WHEN $3 = 'review' THEN $11 ELSE submitted_at END,
                       finished_at = CASE WHEN $3 = 'done' THEN $11 ELSE finished_at END,
                       lease_until = NULL, heartbeat_at = $11, blocked_reason = NULL, updated_at = $11, version = version + 1,
                       row_version = row_version + 1
                     WHERE id = $1 AND state = 'claimed' AND owner_id = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(owner)
                    .bind(to)
                    .bind(&r.summary)
                    .bind(&r.body)
                    .bind(&r.branch)
                    .bind(&r.commit)
                    .bind(&r.worktree)
                    .bind(&r.checks)
                    .bind(&r.artifacts)
                    .bind(now)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Approve => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'done', finished_at = $2, updated_at = $2, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = 'review' AND deleted_at IS NULL",
                );
                sqlx::query(&sql).bind(id).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
            Action::Reject => {
                attempt_after = row.attempt + 1;
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'open', attempt = attempt + 1, last_error = $2, owner_id = NULL, owner_name = NULL,
                       owner_host = NULL, owner_instance = NULL, submitted_at = NULL, lease_until = NULL, heartbeat_at = NULL,
                       updated_at = $3, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = 'review' AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(reason.as_ref().map(|r| format!("rejected: {r}")))
                    .bind(now)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Fail => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'failed', last_error = $4, finished_at = $5, lease_until = NULL, owner_instance = NULL,
                       blocked_reason = NULL, updated_at = $5, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = $3 AND owner_id = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(owner)
                    .bind(&from)
                    .bind(&reason)
                    .bind(now)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::Retry | Action::Reopen => {
                attempt_after = row.attempt + 1;
                if action == Action::Retry {
                    data = Some(json!({ "previousError": row.last_error }));
                }
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'open', attempt = attempt + 1, owner_id = NULL, owner_name = NULL, owner_host = NULL,
                       owner_instance = NULL, finished_at = NULL, submitted_at = NULL, lease_until = NULL, heartbeat_at = NULL,
                       updated_at = $3, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql).bind(id).bind(&from).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
            Action::Cancel => {
                let sql = self.s(
                    "UPDATE @@.tasks SET state = 'cancelled', finished_at = $3, lease_until = NULL, owner_instance = NULL,
                       updated_at = $3, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND state = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql).bind(id).bind(&from).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
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
                let sql = self.s(
                    "UPDATE @@.tasks SET title = coalesce($3, title),
                       body = CASE WHEN $4 THEN $5 ELSE body END,
                       priority = coalesce($6, priority), labels = coalesce($7, labels),
                       needs_review = coalesce($8, needs_review),
                       updated_at = $9, version = version + 1, row_version = row_version + 1
                     WHERE id = $1 AND version = $2 AND deleted_at IS NULL",
                );
                sqlx::query(&sql)
                    .bind(id)
                    .bind(row.version)
                    .bind(&title)
                    .bind(body.is_some())
                    .bind(body.clone().flatten())
                    .bind(op.priority)
                    .bind(&labels)
                    .bind(op.review.map(i64::from))
                    .bind(now)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?
                    .rows_affected()
            }
            Action::DepAdd | Action::DepRemove => {
                let on_seq = op.on.ok_or_else(|| "dependency required: agent task dep add|rm <#task> <#depends-on>".to_string())?;
                let on = self.load_task(c, uid, team, on_seq, false).await?;
                if on.id == row.id {
                    return Err(format!("#{seq} cannot depend on itself"));
                }
                data = Some(json!({ "on": on_seq }));
                if action == Action::DepAdd && on.state == "cancelled" {
                    return Err(format!("#{on_seq} is cancelled: it cannot be a dependency"));
                }
                if action == Action::DepAdd {
                    let exists: i64 = sqlx::query_scalar(&self.s(
                        "SELECT count(*) FROM @@.task_deps WHERE task_id = $1 AND depends_on_id = $2 AND deleted_at IS NULL",
                    ))
                    .bind(id)
                    .bind(&on.id)
                    .fetch_one(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?;
                    if exists > 0 {
                        return Err(format!("#{seq} already depends on #{on_seq}"));
                    }
                    let count = self.count(c, "SELECT count(*) FROM @@.task_deps WHERE task_id = $1 AND deleted_at IS NULL", id).await?;
                    if count as usize >= MAX_DEPS_PER_TASK {
                        return Err(format!("#{seq} already has {MAX_DEPS_PER_TASK} dependencies (max)"));
                    }
                    if self.depends_transitively(c, &on.id, id).await? {
                        return Err(format!("#{on_seq} already depends on #{seq} (directly or through other tasks): that would be a cycle"));
                    }
                    self.insert_dep(c, id, &on.id, uid, ctx).await?;
                } else if self.tombstone_dep(c, id, &on.id, now).await? == 0 {
                    return Err(format!("#{seq} does not depend on #{on_seq}"));
                }
                let sql = self.s("UPDATE @@.tasks SET updated_at = $2, version = version + 1, row_version = row_version + 1 WHERE id = $1");
                sqlx::query(&sql).bind(id).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
        };
        if n == 0 {
            return Err(match self.load_task(c, uid, team, seq, false).await {
                Ok(cur) => format!("#{seq} changed meanwhile: it is now {}", describe_state(&cur.facts())),
                Err(e) => e,
            });
        }
        let updated = self.load_task(c, uid, team, seq, false).await?;
        self.add_event(c, &updated, now, actor, action.event(), Some(&from), Some(to), attempt_after, note.as_deref(), data, host).await?;
        let mut post_seq = None;
        if to == "done" && from != "done" {
            let summary = updated.result_summary.clone().unwrap_or_default();
            let text = done_post_text(&updated, &summary, (action == Action::Approve).then_some(actor));
            let (_, s) = self
                .insert_post(c, uid, &actor.id, actor.name.as_deref(), actor.cli.as_deref(), "done", &text, Some(id), ctx)
                .await?;
            post_seq = Some(s);
        }
        self.prune_team(c, uid, 0, now).await?;
        self.touch_team(c, uid, now).await?;
        let task = self.task_out(c, &updated, now, DEFAULT_STALE_MS).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        let mut out = json!({ "action": action.event(), "from": from, "to": to, "task": task, "expired": expired });
        if let Some(p) = post_seq {
            out["post"] = json!(p);
        }
        Ok(out)
    }

    /// Expire leases of one team in its own short write transaction, only when some ran out.
    async fn expire_if_needed(&self, pool: &PgPool, uid: &str, now: i64, host: Option<&str>) -> Result<Vec<Value>, String> {
        let n: i64 = sqlx::query_scalar(&self.s(
            "SELECT count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND lease_until < $2",
        ))
        .bind(uid)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(|e| self.err(e))?;
        if n == 0 {
            return Ok(Vec::new());
        }
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        if !self.lock_team(&mut tx, uid).await? {
            return Ok(Vec::new());
        }
        let out = self.expire_leases(&mut tx, Some(uid), now, None, host).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(out)
    }

    pub async fn task_list(&self, team: String, q: TaskListQuery, ctx: Ctx) -> Result<Value, String> {
        retrying!(self, self.task_list_once(&team, &q, &ctx))
    }

    async fn task_list_once(&self, team: &str, q: &TaskListQuery, ctx: &Ctx) -> Result<Value, String> {
        let now = ctx.now;
        let ListSpec { stale, stored, want_waiting, want_ready, want_stale, state_filter, pattern, mine, limit } = ListSpec::check(team, q)?;
        let mut counts = ListSpec::zero_counts();
        let pool = self.ready().await?;
        let mut c = pool.acquire().await.map_err(|e| self.err(e))?;
        let Some(team_ref) = self.find_team(&mut c, team, ctx.host.as_deref(), Lock::None).await? else {
            return Ok(json!({ "team": team, "tasks": [], "matched": 0, "more": 0, "counts": counts, "expired": [] }));
        };
        drop(c);
        let uid = team_ref.uid.clone();
        let expired = self.expire_if_needed(pool, &uid, now, ctx.host.as_deref()).await?;
        let filter = format!(
            "t.team_uid = $1 AND t.deleted_at IS NULL
             AND (NOT $2 OR t.state = ANY($3)
                  OR ($4 AND t.state = 'open' AND {UNMET})
                  OR ($5 AND t.state = 'open' AND NOT {UNMET})
                  OR ($6 AND t.state IN ('claimed','blocked') AND t.updated_at < $7))
             AND ($8::text IS NULL OR t.owner_id = $8)
             AND ($9::text IS NULL OR t.title ILIKE $9 ESCAPE E'\\\\' OR t.body ILIKE $9 ESCAPE E'\\\\')"
        );
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let stale_before = now - stale;
        let matched: i64 = sqlx::query_scalar(&self.s(&format!("SELECT count(*) FROM @@.tasks t WHERE {filter}")))
            .bind(&uid)
            .bind(state_filter)
            .bind(&stored)
            .bind(want_waiting)
            .bind(want_ready)
            .bind(want_stale)
            .bind(stale_before)
            .bind(&mine)
            .bind(&pattern)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let rows = sqlx::query(&self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t WHERE {filter}
             ORDER BY CASE t.state WHEN 'claimed' THEN 0 WHEN 'blocked' THEN 1 WHEN 'review' THEN 2 WHEN 'open' THEN 3
                                   WHEN 'failed' THEN 4 WHEN 'done' THEN 5 ELSE 6 END, t.priority DESC, t.seq
             LIMIT $10"
        )))
        .bind(&uid)
        .bind(state_filter)
        .bind(&stored)
        .bind(want_waiting)
        .bind(want_ready)
        .bind(want_stale)
        .bind(stale_before)
        .bind(&mine)
        .bind(&pattern)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        let rows = rows.iter().map(task_from_row).collect::<Result<Vec<_>, _>>().map_err(|e| self.err(e))?;
        let mut deps: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        let dep_rows: Vec<(String, i64, String)> = sqlx::query_as(&self.s(
            "SELECT d.task_id, x.seq, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
             WHERE d.team_uid = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        ))
        .bind(&uid)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        for (task, seq, state) in dep_rows {
            deps.entry(task).or_default().push((seq, state));
        }
        let by_state: Vec<(String, i64)> = sqlx::query_as(&self.s(
            "SELECT state, count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL GROUP BY state",
        ))
        .bind(&uid)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        for (s, n) in by_state {
            counts.insert(s, json!(n));
        }
        let (waiting, stale_n): (i64, i64) = sqlx::query_as(&self.s(&format!(
            "SELECT count(*) FILTER (WHERE t.state = 'open' AND {UNMET}),
                    count(*) FILTER (WHERE t.state IN ('claimed','blocked') AND t.updated_at < $2)
             FROM @@.tasks t WHERE t.team_uid = $1 AND t.deleted_at IS NULL"
        )))
        .bind(&uid)
        .bind(stale_before)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        counts.insert("waiting".into(), json!(waiting));
        counts.insert("stale".into(), json!(stale_n));
        tx.commit().await.map_err(|e| self.err(e))?;
        let tasks: Vec<Value> = rows.iter().map(|r| task_json(r, deps.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), now, stale)).collect();
        let more = (matched - tasks.len() as i64).max(0);
        let mut out = json!({ "team": team, "tasks": tasks, "matched": matched, "more": more, "counts": counts, "expired": expired });
        if let Some(n) = team_ref.name {
            out["teamName"] = json!(n);
        }
        Ok(out)
    }

    async fn brief_list(&self, c: &mut PgConnection, sql: &str, id: &str) -> Result<Vec<Value>, String> {
        let rows: Vec<(i64, String, String)> = sqlx::query_as(&self.s(sql)).bind(id).fetch_all(&mut *c).await.map_err(|e| self.err(e))?;
        Ok(rows.into_iter().map(|(seq, title, state)| json!({ "seq": seq, "title": title, "state": state })).collect())
    }

    pub async fn task_show(&self, team: String, seq: i64, history: bool, stale: Option<i64>, ctx: Ctx) -> Result<Value, String> {
        retrying!(self, self.task_show_once(&team, seq, history, stale, &ctx))
    }

    async fn task_show_once(&self, team: &str, seq: i64, history: bool, stale: Option<i64>, ctx: &Ctx) -> Result<Value, String> {
        check_team(team)?;
        let now = ctx.now;
        let pool = self.ready().await?;
        let team_ref = {
            let mut c = pool.acquire().await.map_err(|e| self.err(e))?;
            self.find_team(&mut c, team, ctx.host.as_deref(), Lock::None).await?.ok_or_else(|| format!("no task #{seq} in team {team}"))?
        };
        let uid = team_ref.uid.as_str();
        let expired = self.expire_if_needed(pool, uid, now, ctx.host.as_deref()).await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let row = self.load_task(&mut tx, uid, team, seq, false).await?;
        let task = self.task_out(&mut tx, &row, now, stale_ms(stale)).await?;
        let deps = self
            .brief_list(
                &mut tx,
                "SELECT x.seq, x.title, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
                 WHERE d.task_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let dependents = self
            .brief_list(
                &mut tx,
                "SELECT x.seq, x.title, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.task_id
                 WHERE d.depends_on_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let children = self
            .brief_list(
                &mut tx,
                "SELECT x.seq, x.title, x.state FROM @@.tasks x WHERE x.parent_id = $1 AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let parent = match row.parent_seq {
            Some(p) => {
                let pr = self.load_task(&mut tx, uid, team, p, false).await?;
                json!({ "seq": pr.seq, "title": pr.title, "state": pr.state })
            }
            None => Value::Null,
        };
        let mut out = json!({ "team": team, "task": task, "deps": deps, "dependents": dependents, "children": children, "parentTask": parent, "expired": expired });
        if history {
            let rows = sqlx::query(&self.s(
                "SELECT seq, ts, actor_id, actor_name, actor_host, action, from_state, to_state, attempt, note, data, id
                 FROM @@.task_events WHERE task_id = $1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT $2",
            ))
            .bind(&row.id)
            .bind(MAX_HISTORY)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
            let mut events = rows
                .iter()
                .map(|r| -> Result<Value, sqlx::Error> {
                    let data: Option<String> = r.try_get(10)?;
                    Ok(json!({
                        "id": r.try_get::<String, _>(11)?,
                        "seq": r.try_get::<i64, _>(0)?,
                        "ts": r.try_get::<i64, _>(1)?,
                        "actor": party(&r.try_get(2)?, &r.try_get(3)?, &r.try_get(4)?),
                        "action": r.try_get::<String, _>(5)?,
                        "from": r.try_get::<Option<String>, _>(6)?,
                        "to": r.try_get::<Option<String>, _>(7)?,
                        "attempt": r.try_get::<Option<i64>, _>(8)?,
                        "note": r.try_get::<Option<String>, _>(9)?,
                        "data": data.as_deref().map(|d| parse_json(d, Value::Null)).unwrap_or(Value::Null),
                    }))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.err(e))?;
            events.reverse();
            out["events"] = Value::Array(events);
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(out)
    }

    /// See sqlite::team_events (one REPEATABLE READ READ ONLY snapshot).
    pub async fn team_events(&self, team: String, q: EventsQuery, host: Option<String>) -> Result<Value, String> {
        retrying!(self, self.team_events_once(&team, &q, host.as_deref()))
    }

    async fn team_events_once(&self, team: &str, q: &EventsQuery, host: Option<&str>) -> Result<Value, String> {
        check_team(team)?;
        let (limit, since) = q.check();
        let pool = self.ready().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let Some(team_ref) = self.find_team(&mut tx, team, host, Lock::None).await? else {
            tx.commit().await.map_err(|e| self.err(e))?;
            return Ok(json!({ "team": team, "events": [], "more": 0 }));
        };
        let from = "FROM @@.task_events e JOIN @@.tasks x ON x.id = e.task_id
                    WHERE e.team_uid = $1 AND e.deleted_at IS NULL AND x.deleted_at IS NULL AND e.ts > $2";
        let matched: i64 = sqlx::query_scalar(&self.s(&format!("SELECT count(*) {from}")))
            .bind(&team_ref.uid)
            .bind(since)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let rows = sqlx::query(&self.s(&format!(
            "SELECT e.seq, e.ts, e.actor_id, e.actor_name, e.actor_host, e.action, e.from_state, e.to_state, e.attempt,
                    e.note, e.id, x.seq {from} ORDER BY e.ts DESC, e.id DESC LIMIT $3"
        )))
        .bind(&team_ref.uid)
        .bind(since)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        tx.commit().await.map_err(|e| self.err(e))?;
        let mut events = rows
            .iter()
            .map(|r| -> Result<Value, sqlx::Error> {
                Ok(json!({
                    "id": r.try_get::<String, _>(10)?,
                    "task": r.try_get::<i64, _>(11)?,
                    "seq": r.try_get::<i64, _>(0)?,
                    "ts": r.try_get::<i64, _>(1)?,
                    "actor": party(&r.try_get(2)?, &r.try_get(3)?, &r.try_get(4)?),
                    "action": r.try_get::<String, _>(5)?,
                    "from": r.try_get::<Option<String>, _>(6)?,
                    "to": r.try_get::<Option<String>, _>(7)?,
                    "attempt": r.try_get::<Option<i64>, _>(8)?,
                    "note": r.try_get::<Option<String>, _>(9)?,
                }))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.err(e))?;
        events.reverse();
        let more = (matched - events.len() as i64).max(0);
        Ok(json!({ "team": team, "events": events, "more": more }))
    }

    // ── Leases ───────────────────────────────────────────────────────────

    /// See sqlite::lease_tick (only the lease columns change; no team lock needed).
    pub async fn lease_tick(&self, instance: String, alive: Vec<String>, now: i64, lease: i64) -> Result<Value, String> {
        let pool = self.ready().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let renewed: Vec<String> = sqlx::query_scalar(&self.s(
            "UPDATE @@.tasks SET lease_until = $1, heartbeat_at = $2, row_version = row_version + 1
             WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $3 AND owner_id = ANY($4)
             RETURNING id",
        ))
        .bind(now + lease_ms(Some(lease)))
        .bind(now)
        .bind(&instance)
        .bind(&alive)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        let holders = self.holders(&mut tx, &instance).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(json!({ "renewed": renewed.len(), "holders": holders }))
    }

    async fn holders(&self, c: &mut PgConnection, instance: &str) -> Result<Vec<String>, String> {
        self.ids(
            c,
            "SELECT DISTINCT owner_id FROM @@.tasks
             WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $1 AND owner_id IS NOT NULL",
            instance,
        )
        .await
    }

    /// Release one held task (auto_release) in its own transaction, team row first, only while
    /// it is still held through `instance` (and by `owner` when given).
    async fn release_one(&self, id: &str, owner: Option<&str>, instance: &str, now: i64, host: Option<&str>, reason: &str) -> Result<Option<Value>, String> {
        let pool = self.ready().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let Some(seen) = self.load_task_by_id(&mut tx, id, false).await? else { return Ok(None) };
        self.lock_team(&mut tx, &seen.team_uid).await?;
        let Some(row) = self.load_task_by_id(&mut tx, id, true).await? else { return Ok(None) };
        if !is_held(&row.state) || row.owner_instance.as_deref() != Some(instance) || owner.is_some_and(|o| row.owner_id.as_deref() != Some(o)) {
            return Ok(None);
        }
        let n = sqlx::query(&self.s(
            "UPDATE @@.tasks SET state = 'open', owner_id = NULL, owner_name = NULL, owner_host = NULL, owner_instance = NULL,
               lease_until = NULL, heartbeat_at = NULL, blocked_reason = NULL, updated_at = $3, version = version + 1,
               row_version = row_version + 1
             WHERE id = $1 AND state = $2 AND deleted_at IS NULL",
        ))
        .bind(&row.id)
        .bind(&row.state)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(|e| self.err(e))?
        .rows_affected();
        if n == 0 {
            return Ok(None);
        }
        let app = Actor::app(host);
        self.add_event(
            &mut tx,
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
        )
        .await?;
        self.touch_team(&mut tx, &row.team_uid, now).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(Some(json!({ "team": row.team, "seq": row.seq, "title": row.title, "ownerId": row.owner_id, "from": row.state })))
    }

    pub async fn release_owner(&self, instance: String, owner_id: String, now: i64, host: Option<String>, reason: String) -> Result<Value, String> {
        let pool = self.ready().await?;
        let ids: Vec<String> = sqlx::query_scalar(&self.s(
            "SELECT id FROM @@.tasks WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_id = $1 AND owner_instance = $2",
        ))
        .bind(&owner_id)
        .bind(&instance)
        .fetch_all(pool)
        .await
        .map_err(|e| self.err(e))?;
        let mut released = Vec::new();
        for id in ids {
            if let Some(v) = retrying!(self, self.release_one(&id, Some(&owner_id), &instance, now, host.as_deref(), &reason))? {
                released.push(v);
            }
        }
        Ok(json!({ "released": released }))
    }

    pub async fn lease_holders(&self, instance: String) -> Result<Vec<String>, String> {
        let mut c = self.ready().await?.acquire().await.map_err(|e| self.err(e))?;
        self.holders(&mut c, &instance).await
    }

    pub async fn held_on_host(&self, host: String) -> Result<Vec<Value>, String> {
        let rows = sqlx::query(&self.s(
            "SELECT t.id, tm.team, t.seq, t.state, t.owner_id, t.owner_name, t.owner_instance, t.lease_until, t.heartbeat_at
             FROM @@.tasks t JOIN @@.teams tm ON tm.uid = t.team_uid
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_host = $1 ORDER BY tm.team, t.seq",
        ))
        .bind(&host)
        .fetch_all(self.ready().await?)
        .await
        .map_err(|e| self.err(e))?;
        rows.iter()
            .map(|r| -> Result<Value, sqlx::Error> {
                Ok(json!({
                    "id": r.try_get::<String, _>(0)?,
                    "team": r.try_get::<String, _>(1)?,
                    "seq": r.try_get::<i64, _>(2)?,
                    "state": r.try_get::<String, _>(3)?,
                    "ownerId": r.try_get::<Option<String>, _>(4)?,
                    "ownerName": r.try_get::<Option<String>, _>(5)?,
                    "ownerInstance": r.try_get::<Option<String>, _>(6)?,
                    "leaseUntil": r.try_get::<Option<i64>, _>(7)?,
                    "heartbeatAt": r.try_get::<Option<i64>, _>(8)?,
                }))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.err(e))
    }

    /// See sqlite::lease_apply. Adoptions are single guarded UPDATEs; each release is its own
    /// transaction (team row first).
    pub async fn lease_apply(
        &self,
        instance: String,
        adopt: Vec<LeaseItem>,
        release: Vec<LeaseItem>,
        now: i64,
        lease: i64,
        host: Option<String>,
    ) -> Result<Value, String> {
        let pool = self.ready().await?;
        let mut adopted = 0u64;
        for a in &adopt {
            adopted += sqlx::query(&self.s(
                "UPDATE @@.tasks SET owner_instance = $2, lease_until = $3, heartbeat_at = $4, row_version = row_version + 1
                 WHERE id = $1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $5",
            ))
            .bind(&a.id)
            .bind(&instance)
            .bind(now + lease_ms(Some(lease)))
            .bind(now)
            .bind(&a.instance)
            .execute(pool)
            .await
            .map_err(|e| self.err(e))?
            .rows_affected();
        }
        let mut released = Vec::new();
        for r in &release {
            let reason = "owner tab did not come back after the app restarted";
            if let Some(v) = retrying!(self, self.release_one(&r.id, None, &r.instance, now, host.as_deref(), reason))? {
                released.push(v);
            }
        }
        Ok(json!({ "adopted": adopted, "released": released }))
    }

    // ── Settings: counts, copy ───────────────────────────────────────────

    /// Live teams, posts and tasks (status line).
    pub async fn counts(&self) -> Result<Value, String> {
        let (teams, posts, tasks): (i64, i64, i64) = sqlx::query_as(&self.s(
            "SELECT (SELECT count(*) FROM @@.teams WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM @@.posts WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM @@.tasks WHERE deleted_at IS NULL)",
        ))
        .fetch_one(self.ready().await?)
        .await
        .map_err(|e| self.err(e))?;
        Ok(json!({ "teams": teams, "posts": posts, "tasks": tasks }))
    }

    fn select_sql(&self, table: &str, cols: Cols) -> String {
        let list = copy::col_list(cols);
        let filter = match table {
            "teams" => "deleted_at IS NULL",
            "cursors" => "team_uid IN (SELECT uid FROM @@.teams WHERE deleted_at IS NULL)",
            _ => "deleted_at IS NULL AND team_uid IN (SELECT uid FROM @@.teams WHERE deleted_at IS NULL)",
        };
        // Posts in read order (see sqlite::select_sql).
        let order = if table == "posts" { " ORDER BY team_uid, arrival, seq" } else { "" };
        self.s(&format!("SELECT {list} FROM @@.{table} WHERE {filter}{order}"))
    }

    /// Every live row of every live team (Copy data).
    pub async fn export_dump(&self) -> Result<Dump, String> {
        let pool = self.ready().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let mut dump = Dump::default();
        for (table, cols) in copy::TABLES {
            let rows = sqlx::query(&self.select_sql(table, cols)).fetch_all(&mut *tx).await.map_err(|e| self.err(e))?;
            let out = dump.rows_mut(table);
            for r in &rows {
                let mut cells = Vec::with_capacity(cols.len());
                for (i, (_, kind)) in cols.iter().enumerate() {
                    cells.push(match kind {
                        Kind::Int => r.try_get::<Option<i64>, _>(i).map_err(|e| self.err(e))?.map_or(Cell::Null, Cell::Int),
                        Kind::Text => r.try_get::<Option<String>, _>(i).map_err(|e| self.err(e))?.map_or(Cell::Null, Cell::Text),
                    });
                }
                out.push(cells);
            }
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(dump)
    }

    /// Insert a dump (Copy data): refused unless the board has no live team or `merge` is set;
    /// teams it already has are skipped, tombstoned teams in the way are removed for good.
    /// One transaction; rows go in multi-row INSERTs of up to IMPORT_CHUNK rows.
    pub async fn import_dump(&self, dump: Dump, merge: bool) -> Result<Value, String> {
        let pool = self.ready().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("bbarit-board-copy:{}", self.target.schema))
            .execute(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let mut existing = copy::Existing::default();
        let rows: Vec<(String, String, Option<String>, bool)> =
            sqlx::query_as(&self.s("SELECT uid, team, home_host, deleted_at IS NOT NULL FROM @@.teams"))
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
        for (uid, team, host, dead) in rows {
            existing.add(uid, team, host, dead);
        }
        let copy::Plan { dump: plan, skipped, purge } = copy::plan(dump, &existing, merge)?;
        if !purge.is_empty() {
            for table in copy::PURGE_TABLES {
                sqlx::query(&self.s(&format!("DELETE FROM @@.{table} WHERE team_uid = ANY($1)")))
                    .bind(&purge)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| self.err(e))?;
            }
            sqlx::query(&self.s("DELETE FROM @@.teams WHERE uid = ANY($1)")).bind(&purge).execute(&mut *tx).await.map_err(|e| self.err(e))?;
        }
        let mut arrivals = copy::ArrivalMap::default();
        for (table, cols) in copy::TABLES {
            let mut rows: Vec<Vec<Cell>> = plan.rows(table).clone();
            if rows.is_empty() {
                continue;
            }
            match table {
                "posts" => {
                    // New read positions from this server's sequence, handed out in the
                    // export's read order (the values of one call sort in allocation order).
                    let mut fresh: Vec<i64> = sqlx::query_scalar(&self.s("SELECT nextval('@@.board_arrival_seq') FROM generate_series(1, $1)"))
                        .bind(rows.len() as i64)
                        .fetch_all(&mut *tx)
                        .await
                        .map_err(|e| self.err(e))?;
                    fresh.sort_unstable();
                    let (team_i, arrival_i) = (copy::col_index(cols, "team_uid"), copy::col_index(cols, "arrival"));
                    for (row, dst) in rows.iter_mut().zip(fresh) {
                        let team_uid = row[team_i].text().unwrap_or_default().to_string();
                        arrivals.add(&team_uid, row[arrival_i].int().unwrap_or(0), dst);
                        row[arrival_i] = Cell::Int(dst);
                    }
                }
                "cursors" => {
                    let (team_i, arrival_i) = (copy::col_index(cols, "team_uid"), copy::col_index(cols, "arrival"));
                    for row in rows.iter_mut() {
                        let team_uid = row[team_i].text().unwrap_or_default().to_string();
                        row[arrival_i] = Cell::Int(arrivals.convert(&team_uid, row[arrival_i].int().unwrap_or(0)));
                    }
                }
                _ => {}
            }
            let names = copy::col_list(cols);
            for chunk in rows.chunks(IMPORT_CHUNK) {
                let mut values = Vec::with_capacity(chunk.len());
                let mut n = 0usize;
                for _ in chunk {
                    let ps: Vec<String> = (0..cols.len()).map(|_| {
                        n += 1;
                        format!("${n}")
                    }).collect();
                    values.push(format!("({})", ps.join(", ")));
                }
                let sql = self.s(&format!("INSERT INTO @@.{table} ({names}) VALUES {}", values.join(", ")));
                let mut q = sqlx::query(&sql);
                for row in chunk {
                    for (cell, (_, kind)) in row.iter().zip(cols.iter()) {
                        q = match (cell, kind) {
                            (Cell::Int(v), _) => q.bind(*v),
                            (Cell::Text(v), _) => q.bind(v.clone()),
                            (Cell::Null, Kind::Int) => q.bind(None::<i64>),
                            (Cell::Null, Kind::Text) => q.bind(None::<String>),
                        };
                    }
                }
                q.execute(&mut *tx).await.map_err(|e| self.err(e))?;
            }
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(copy::summary(&plan, &skipped))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_run_in_order_and_a_newer_database_is_refused() {
        assert_eq!(plan_versions(None, 2).unwrap(), vec![2], "no tables: version 2 is the first one");
        assert_eq!(plan_versions(Some(2), 2).unwrap(), Vec::<i64>::new());
        assert_eq!(plan_versions(Some(1), 3).unwrap(), vec![2, 3]);
        assert_eq!(plan_versions(Some(3), 2).unwrap_err(), "database is from a newer app version (schema 3, this app knows 2): update the app");
        assert!(version_check(None, "s", 2).unwrap_err().contains("Create / upgrade tables"));
        assert!(version_check(Some(1), "s", 2).unwrap_err().contains("version 1, this app needs 2"));
        assert!(version_check(Some(3), "s", 2).unwrap_err().starts_with("database is from a newer app version"));
        assert!(version_check(Some(2), "s", 2).is_ok());
        assert!(migration_steps("s", Some(SCHEMA_VERSION + 1)).is_err());
        assert!(migration_steps("s", Some(SCHEMA_VERSION)).unwrap().is_empty());
    }

    #[test]
    fn migration_sql_names_only_the_quoted_schema() {
        let steps = migration_steps("team_board", None).unwrap();
        assert_eq!(steps.len(), 1);
        let sql = &steps[0].sql;
        assert_eq!(sql[0], "CREATE SCHEMA IF NOT EXISTS \"team_board\"");
        for s in sql {
            assert!(!s.contains("@@"), "{s}");
            assert!(!s.contains("bbarit_board"), "{s}");
        }
        for t in ["teams", "posts", "cursors", "tasks", "task_deps", "task_events", "hosts", "board_meta"] {
            assert!(sql.iter().any(|s| s.starts_with(&format!("CREATE TABLE IF NOT EXISTS \"team_board\".{t} "))), "{t}");
        }
        // Every synced table gets server_seq and its trigger.
        for t in SYNCED {
            assert!(sql.iter().any(|s| s.contains(&format!("ON \"team_board\".{t} FOR EACH ROW"))), "{t}");
        }
        assert!(sql.iter().any(|s| s.contains("nextval('\"team_board\".board_server_seq')")));
    }
}
