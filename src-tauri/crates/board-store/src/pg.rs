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
//!
//! Every board operation lives on `PgOps` and runs on a connection it is given, inside the
//! caller's transaction (typed `StoreError`s); `PgStore`'s methods wrap each one in the store's
//! own pool and transaction (and keep the `String` errors the app shows). A server that embeds
//! the store uses `PgOps` directly, or `PgStore::from_pool` on its own pool; `steps_in_schema`
//! and `migrate_on` create the tables in a schema its role owns (see the crate docs).

use super::common::*;
use super::config::{check_schema_name, quote_ident, redact, PgTarget, CONNECT_TIMEOUT_SECS};
use super::copy::{self, Cell, Cols, Dump, Kind};
use super::error::StoreError;
use super::model::*;
use serde_json::{json, Value};
use sqlx::pool::PoolConnection;
pub use sqlx::postgres::PgConnection;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Connection, Postgres, Row, Transaction};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::OnceCell;

/// Schema version this code reads and writes (the same number as the SQLite store's).
pub const SCHEMA_VERSION: i64 = 4;
/// The oldest server tables this app still works with: version 3 lacks only the remote-note
/// outbox (stage 3c), so `postgres` mode and 3b sync keep working until "Create / upgrade
/// tables" moves it to 4; remote notes and "Take over this team" wait for that.
pub const MIN_SCHEMA_VERSION: i64 = 3;
/// The server's clock in ms. Every `hosts.last_seen` write and every "silent for" guard uses
/// it, so computers with different clocks compare like with like (stage 3c review R1).
pub const SERVER_NOW_MS: &str = "(extract(epoch from clock_timestamp()) * 1000)::bigint";
/// Remote-note outbox rows that are finished (delivered, refused, withdrawn) are removed by
/// "Clean up" after this long.
pub const OUTBOX_RETENTION_MS: i64 = 30 * 24 * 3_600_000;

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
    /// The operations, with this store's schema, limits and redaction.
    ops: PgOps,
    pool: OnceCell<PgPool>,
    /// false: the caller's pool (`from_pool`); `close` leaves it open.
    owns_pool: bool,
    /// The schema version was checked (and matched) once.
    ready: AtomicBool,
    /// The version of the program using this store (`created_by_app_version`, `hosts.app_version`).
    app_version: String,
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
pub const BOARD_RELATIONS: [&str; 10] =
    ["teams", "posts", "cursors", "tasks", "task_deps", "task_events", "hosts", "outbox", "board_server_seq", "board_arrival_seq"];

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
        Some(v) if v < code && !(MIN_SCHEMA_VERSION..code).contains(&v) => Err(format!(
            "the board tables in schema {schema} are at version {v}, this app needs {code}: Settings → Agent team board → Create / upgrade tables"
        )),
        Some(_) => Ok(()),
    }
}

const SYNCED: [&str; 5] = ["teams", "posts", "tasks", "task_deps", "task_events"];

/// Version 2: the same tables as the SQLite store (minus the local change log), plus
/// `server_seq` on every synced table (filled by a trigger from `board_server_seq`), the
/// `posts.arrival` sequence and the server-only `hosts` table for stage 3b.
fn v2_sql(schema: &str, create_schema: bool) -> Vec<String> {
    let q = quote_ident(schema);
    let mut out: Vec<String> = Vec::new();
    if create_schema {
        out.push(format!("CREATE SCHEMA IF NOT EXISTS {q}"));
    }
    out.extend([
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
    ]);
    for t in SYNCED {
        out.push(format!("CREATE INDEX IF NOT EXISTS {t}_server_seq ON @@.{t} (server_seq)"));
        out.push(format!("DROP TRIGGER IF EXISTS board_server_seq ON @@.{t}"));
        out.push(format!(
            "CREATE TRIGGER board_server_seq BEFORE INSERT OR UPDATE ON @@.{t} FOR EACH ROW EXECUTE FUNCTION @@.board_set_server_seq()"
        ));
    }
    out
}

/// Version 3 (stage 3b): the server_seq trigger first takes a shared transaction-level advisory
/// lock (`seq_lock_key`), so every writer (sync pushes and direct `postgres`-mode writes alike)
/// holds it from the moment it draws a number until it commits. A pull reads its upper bound
/// (`sync_watermark`) under the same lock taken exclusively: once granted, every transaction
/// that drew a number at or below the sequence's current value has ended, so the pull cursor
/// can never pass a row that commits later with a lower number.
fn v3_sql() -> Vec<String> {
    vec!["CREATE OR REPLACE FUNCTION @@.board_set_server_seq() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('bbarit-board-seq:' || TG_TABLE_SCHEMA));
  NEW.server_seq := nextval('@@.board_server_seq');
  RETURN NEW;
END
$fn$"
        .into()]
}

/// Version 4 (stage 3c): the remote-note outbox. A computer that holds only a copy of a team
/// inserts a note here (its UUID is the idempotency key and becomes the post id); the team's
/// home turns it into a numbered post on its next round and marks it `delivered` or `refused`
/// (`reason` is a stable code). The poster may withdraw a note still `pending`. No
/// `server_seq`: rows are found by state, never by a pull cursor.
fn v4_sql() -> Vec<String> {
    vec![
        "CREATE TABLE IF NOT EXISTS @@.outbox (
  id TEXT PRIMARY KEY, team_uid TEXT NOT NULL, from_host TEXT NOT NULL, from_instance TEXT NOT NULL,
  author_id TEXT NOT NULL, author_name TEXT, author_cli TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
  created_at BIGINT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', reason TEXT, handled_at BIGINT)"
            .into(),
        "CREATE INDEX IF NOT EXISTS outbox_team_state ON @@.outbox (team_uid, state)".into(),
        "CREATE INDEX IF NOT EXISTS outbox_from_state ON @@.outbox (from_instance, state)".into(),
        // The installation a restore replaced (it is told so instead of "name taken").
        "ALTER TABLE @@.hosts ADD COLUMN IF NOT EXISTS replaced_instance TEXT".into(),
    ]
}

/// Text hashed into the server_seq lock key (`hashtext(...)`; the trigger builds the same text
/// from `TG_TABLE_SCHEMA`).
pub fn seq_lock_key(schema: &str) -> String {
    format!("bbarit-board-seq:{schema}")
}

/// The migration steps from `stored` to SCHEMA_VERSION, SQL as it will run (`migrate`: the
/// first step starts with `CREATE SCHEMA IF NOT EXISTS`; see `steps_in_schema` for none).
pub fn migration_steps(schema: &str, stored: Option<i64>) -> Result<Vec<Step>, String> {
    steps_for(schema, stored, true)
}

fn steps_for(schema: &str, stored: Option<i64>, create_schema: bool) -> Result<Vec<Step>, String> {
    let prefix = format!("{}.", quote_ident(schema));
    plan_versions(stored, SCHEMA_VERSION)?
        .into_iter()
        .map(|v| match v {
            2 => Ok(Step {
                version: 2,
                description: "create the board tables, indexes and sequences (teams, posts, cursors, tasks, task_deps, task_events, hosts, board_meta) and the server_seq trigger",
                sql: v2_sql(schema, create_schema).into_iter().map(|s| s.replace("@@.", &prefix)).collect(),
            }),
            3 => Ok(Step {
                version: 3,
                description: "server_seq numbers are drawn under a shared lock, so syncing machines never miss a row that commits late",
                sql: v3_sql().into_iter().map(|s| s.replace("@@.", &prefix)).collect(),
            }),
            4 => Ok(Step {
                version: 4,
                description: "add the outbox for notes sent to a team whose home is another computer",
                sql: v4_sql().into_iter().map(|s| s.replace("@@.", &prefix)).collect(),
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
    /// Home of a team another computer keeps in sync mode (read-only for direct writers).
    sync_home: Option<String>,
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

/// Run a `StoreError` transaction again on a deadlock or serialization failure (`Busy`), up to 3
/// more times; the last error comes back as it is ("team board unavailable: …").
macro_rules! retrying {
    ($call:expr) => {{
        let mut tries = 0u32;
        loop {
            match $call.await {
                Err(e) if e.is_retryable() && tries < 3 => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(15 * u64::from(tries))).await;
                }
                other => break other,
            }
        }
    }};
}

/// `claim --next --label`: the task carries one of the labels in text[] `$2` (empty = any task).
const PG_LABEL_MATCH: &str = "(cardinality($2::text[]) = 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.labels::jsonb) l(v) WHERE l.v = ANY($2::text[])))";
// ── Operations on a caller's connection ──────────────────────────────────

/// The board operations of the PostgreSQL engine on a connection the caller provides, for a
/// server that embeds the store and needs several store operations, plus its own rows, in
/// ONE transaction (see the crate docs, "Embedding the store in a server").
///
/// Every public method takes `&mut PgConnection` (a `Transaction` or a pooled connection
/// derefs to one) and never begins, commits or rolls back: the caller opens the transaction,
/// calls any number of operations, writes its own rows and commits once. They take the same
/// inputs, return the same JSON and refuse with the same message texts as `PgStore` (whose
/// methods are thin wrappers: a connection from the pool, begin, the operation, commit), but
/// as a typed `StoreError`.
///
/// Rules for the caller:
/// - Run them inside a transaction (`BEGIN`, or `conn.begin()`): in autocommit mode each
///   statement commits alone and a failure leaves half of an operation behind.
/// - On ANY `Err` from a `PgOps` method, roll back: the whole transaction, or to a SAVEPOINT
///   taken just before the call. A refusal can come after writes (`task add` creates the team
///   and prunes before "task limit reached"; a task write expires leases before its rule
///   check), so committing after an error would keep half of the operation. The
///   `board_store::atomically!` macro (or `savepoint` + `settle`) does exactly this around one
///   call; then the caller may go on and commit its own rows.
/// - On `StoreError::Busy` (deadlock, serialization failure) roll back and retry the WHOLE
///   transaction; `PgStore` retries its own transaction up to 3 times. Nothing else is
///   retried for you.
/// - Keep transactions that write board rows short: every board write takes a shared
///   advisory lock (the `server_seq` trigger) and holds it until commit, and a sync pull only
///   tries the exclusive side of that lock for 3 s before it gives up for that round.
/// - Writes lock the team row first, then the task (`FOR UPDATE`), so one operation never
///   deadlocks against another; several writes to different teams in one transaction can, and
///   come back as `Busy`.
/// - Do not set the transaction READ ONLY: besides the writes, `task_list` and `task_show`
///   expire ran-out leases (a write), as every read path of the store does. For counts and rows
///   from one snapshot (what `PgStore` does for plain reads, lists and exports with REPEATABLE
///   READ READ ONLY), start the transaction REPEATABLE READ.
/// - Clock: no operation reads the database clock. The time comes from `Ctx.now` or the `now`
///   argument (ms since the epoch). A caller that wants the database's clock reads `db_now_ms`
///   on the same connection first and builds its `Ctx` from that value.
/// - The schema version is not checked here (`PgStore` checks it once per store): check it
///   with `schema_version_on` / `version_check`, or run `migrate_on`, before serving.
/// - Every operation can run in a caller's transaction; none needs its own. Only the sync
///   methods of `PgStore` (stage 3b/3c) stay on the store's pool.
#[derive(Clone)]
pub struct PgOps {
    schema: String,
    /// `"schema".`
    prefix: String,
    limits: Limits,
    /// Scrubbed from database error text besides the shape-based redaction (password, URL).
    secrets: Vec<String>,
    /// `user@host:port/database`, for "cannot reach" messages.
    label: String,
    /// How long a connection is awaited from the pool, for the same messages.
    acquire_secs: u64,
}

impl std::fmt::Debug for PgOps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgOps").field("schema", &self.schema).field("limits", &self.limits).finish()
    }
}

/// The kind of a database error (see `StoreError`).
fn db_error_kind(e: &sqlx::Error) -> fn(String) -> StoreError {
    match e {
        sqlx::Error::Database(d) => match d.code().as_deref().unwrap_or("") {
            // Serialization failure, deadlock: the transaction may simply be run again.
            "40001" | "40P01" => StoreError::Busy,
            // A duplicate key, an exclusion constraint (other integrity errors are bugs).
            "23505" | "23P01" => StoreError::Conflict,
            // Connection, authentication, missing database / schema / board tables / columns /
            // functions, missing privileges, locks not available, resources, operator
            // intervention (statement_timeout included), system errors.
            "42501" | "42P01" | "42703" | "42883" => StoreError::Unavailable,
            c if ["08", "28", "3D", "3F", "53", "55", "57", "58"].iter().any(|p| c.starts_with(p)) => StoreError::Unavailable,
            _ => StoreError::Internal,
        },
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed
        | sqlx::Error::Configuration(_) => StoreError::Unavailable,
        _ => StoreError::Internal,
    }
}

impl PgOps {
    /// Operations on the board tables in `schema` (default limits). The schema name is checked
    /// (`config::check_schema_name`) and quoted into every statement.
    pub fn new(schema: &str) -> Result<PgOps, StoreError> {
        check_schema_name(schema).map_err(StoreError::Invalid)?;
        Ok(PgOps {
            schema: schema.to_string(),
            prefix: format!("{}.", quote_ident(schema)),
            limits: Limits::default(),
            secrets: Vec::new(),
            label: "PostgreSQL".to_string(),
            acquire_secs: CONNECT_TIMEOUT_SECS,
        })
    }

    /// The same with other per-team caps (tests use small ones).
    pub fn with_limits(mut self, limits: Limits) -> PgOps {
        self.limits = limits;
        self
    }

    /// Values (password, connection URL) to scrub from database error text, besides the
    /// shape-based redaction of URL user info and `password=` pairs that always applies.
    pub fn with_secrets(mut self, secrets: Vec<String>) -> PgOps {
        self.secrets = secrets;
        self
    }

    fn for_target(target: &PgTarget, limits: Limits) -> PgOps {
        PgOps {
            schema: target.schema.clone(),
            prefix: format!("{}.", quote_ident(&target.schema)),
            limits,
            secrets: target.secrets.clone(),
            label: target.label.clone(),
            acquire_secs: CONNECT_TIMEOUT_SECS,
        }
    }

    pub fn schema(&self) -> &str {
        &self.schema
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// SQL text with every `@@.` replaced by the quoted schema.
    fn s(&self, sql: &str) -> String {
        sql.replace("@@.", &self.prefix)
    }

    /// A database error as a `StoreError`: the text people see ("team board unavailable: …",
    /// password and URL scrubbed) with its kind.
    fn err(&self, e: sqlx::Error) -> StoreError {
        if matches!(e, sqlx::Error::PoolTimedOut) {
            return StoreError::Unavailable(unavailable(format!(
                "cannot reach the PostgreSQL server ({}) within {} s",
                self.label, self.acquire_secs
            )));
        }
        let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        db_error_kind(&e)(unavailable(redact(&e.to_string(), &secrets)))
    }

    /// `board_meta.schema_version`, or None when the schema has no board tables.
    pub async fn schema_version(&self, c: &mut PgConnection) -> Result<Option<i64>, StoreError> {
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
    pub async fn foreign_tables(&self, c: &mut PgConnection) -> Result<Vec<String>, StoreError> {
        sqlx::query_scalar(
            "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = ANY($2) ORDER BY 1",
        )
        .bind(&self.schema)
        .bind(BOARD_RELATIONS.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    /// Refuse a schema without board tables that holds tables with the board's names.
    async fn refuse_foreign(&self, c: &mut PgConnection, stored: Option<i64>) -> Result<(), StoreError> {
        if stored.is_some() {
            return Ok(());
        }
        let found = self.foreign_tables(c).await?;
        if found.is_empty() {
            Ok(())
        } else {
            Err(StoreError::Conflict(foreign_message(&self.schema, &found)))
        }
    }

    /// The migration under the per-schema advisory lock, in the caller's transaction: re-read
    /// the version, refuse foreign tables, run the steps from it (with `CREATE SCHEMA IF NOT
    /// EXISTS` only when `create_schema`) and record the version. Returns (from, steps run).
    async fn migrate_locked(&self, c: &mut PgConnection, app_version: &str, create_schema: bool) -> Result<(Option<i64>, Vec<Step>), StoreError> {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("bbarit-board:{}", self.schema))
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        // Re-read under the lock: another app may have migrated meanwhile.
        let stored = self.schema_version(c).await?;
        self.refuse_foreign(c, stored).await?;
        let steps = steps_for(&self.schema, stored, create_schema).map_err(StoreError::Unavailable)?;
        for step in &steps {
            for sql in &step.sql {
                sqlx::query(sql).execute(&mut *c).await.map_err(|e| self.err(e))?;
            }
        }
        if !steps.is_empty() {
            let now = now_ms();
            for (key, value, overwrite) in [
                ("schema_version", SCHEMA_VERSION.to_string(), true),
                // This server's identity: a rebuilt server at the same address gets a new one.
                ("server_uid", uuid::Uuid::new_v4().to_string(), false),
                ("created_at", now.to_string(), false),
                ("created_by_app_version", app_version.to_string(), false),
            ] {
                let sql = if overwrite {
                    "INSERT INTO @@.board_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
                } else {
                    "INSERT INTO @@.board_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING"
                };
                sqlx::query(&self.s(sql)).bind(key).bind(value).execute(&mut *c).await.map_err(|e| self.err(e))?;
            }
        }
        Ok((stored, steps))
    }
}

/// What `migrate_on` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migrated {
    /// The version before (None: no board tables).
    pub from: Option<i64>,
    /// SCHEMA_VERSION.
    pub to: i64,
    /// The versions whose steps ran, oldest first (empty: already up to date).
    pub applied: Vec<i64>,
}

/// Every table the board creates in its schema; a caller checking a schema for foreign tables
/// compares against these (plus `OWNED_SEQUENCES` and `OWNED_FUNCTIONS`).
pub const OWNED_TABLES: [&str; 9] = ["board_meta", "teams", "posts", "cursors", "tasks", "task_deps", "task_events", "hosts", "outbox"];
/// The sequences the board creates in its schema.
pub const OWNED_SEQUENCES: [&str; 2] = ["board_server_seq", "board_arrival_seq"];
/// The functions the board creates in its schema (the `server_seq` trigger function).
pub const OWNED_FUNCTIONS: [&str; 1] = ["board_set_server_seq"];

/// The store's migration for `schema` as ordered steps from `stored` (None: no board tables;
/// all steps) to SCHEMA_VERSION, WITHOUT `CREATE SCHEMA`: the schema must exist, so a role
/// that owns only that schema (no CREATE on the database) can run them. Refused when the
/// database is newer than this code. The SQL is exactly what `migrate_on` runs.
pub fn steps_in_schema(schema: &str, stored: Option<i64>) -> Result<Vec<Step>, StoreError> {
    check_schema_name(schema).map_err(StoreError::Invalid)?;
    steps_for(schema, stored, false).map_err(StoreError::Unavailable)
}

/// The board's schema version on the caller's connection (None: no board tables in `schema`).
pub async fn schema_version_on(c: &mut PgConnection, schema: &str) -> Result<Option<i64>, StoreError> {
    PgOps::new(schema)?.schema_version(c).await
}

/// Create or upgrade the board tables in an existing `schema` on the caller's connection, in
/// the caller's transaction (run it inside one: the steps and the version record must commit
/// together; the per-schema advisory lock is held until that transaction ends). Never runs
/// `CREATE SCHEMA`. Refuses a schema that holds foreign tables with the board's names
/// (`Conflict`) and a database newer than this code (`Unavailable`). Running it again is a
/// no-op (`applied` empty). `app_version` is recorded as `created_by_app_version`.
pub async fn migrate_on(c: &mut PgConnection, schema: &str, app_version: &str) -> Result<Migrated, StoreError> {
    let ops = PgOps::new(schema)?;
    let (from, steps) = ops.migrate_locked(c, app_version, false).await?;
    if steps.is_empty() {
        sqlx::query(&ops.s("INSERT INTO @@.board_meta (key, value) VALUES ('server_uid', $1) ON CONFLICT (key) DO NOTHING"))
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&mut *c)
            .await
            .map_err(|e| ops.err(e))?;
    }
    Ok(Migrated { from, to: SCHEMA_VERSION, applied: steps.iter().map(|s| s.version).collect() })
}

/// The savepoint `savepoint` / `settle` / `atomically!` use.
const OP_SAVEPOINT: &str = "bbarit_board_op";

/// Take a savepoint before one `PgOps` call (pair it with `settle`; `atomically!` does both).
/// Needs an open transaction on `c`.
pub async fn savepoint(c: &mut PgConnection) -> Result<(), StoreError> {
    sqlx::query(&format!("SAVEPOINT {OP_SAVEPOINT}"))
        .execute(&mut *c)
        .await
        .map(|_| ())
        .map_err(|e| db_error_kind(&e)(unavailable(redact(&e.to_string(), &[]))))
}

/// End the savepoint `savepoint` took, by the call's result: Ok releases it (the writes stay
/// in the transaction), Err rolls back to it (nothing of the call remains; the transaction is
/// usable again) and releases it. Returns the result unchanged. Should the rollback itself
/// fail, the transaction is aborted or the connection gone, so a later COMMIT cannot keep the
/// partial writes either.
pub async fn settle<T>(c: &mut PgConnection, result: Result<T, StoreError>) -> Result<T, StoreError> {
    match result {
        Ok(v) => {
            sqlx::query(&format!("RELEASE SAVEPOINT {OP_SAVEPOINT}"))
                .execute(&mut *c)
                .await
                .map_err(|e| db_error_kind(&e)(unavailable(redact(&e.to_string(), &[]))))?;
            Ok(v)
        }
        Err(e) => {
            if sqlx::query(&format!("ROLLBACK TO SAVEPOINT {OP_SAVEPOINT}")).execute(&mut *c).await.is_ok() {
                let _ = sqlx::query(&format!("RELEASE SAVEPOINT {OP_SAVEPOINT}")).execute(&mut *c).await;
            }
            Err(e)
        }
    }
}

/// Run one `PgOps` call all-or-nothing inside the caller's transaction: a savepoint before
/// it, released on `Ok`, rolled back to on `Err` (see `pg::settle`). Evaluates to a future of
/// the call's result.
///
/// ```ignore
/// let mut tx = conn.begin().await?;
/// let ops = board_store::pg::PgOps::new("bbarit_board")?;
/// match board_store::atomically!(&mut *tx, |c| ops.task_write(c, "lead", &op, &actor, &ctx)).await {
///     Ok(v) => { /* the task changed */ }
///     Err(e) => { /* nothing of it remains; record the refusal */ }
/// }
/// sqlx::query("INSERT INTO audit ...").execute(&mut *tx).await?;
/// tx.commit().await?;
/// ```
#[macro_export]
macro_rules! atomically {
    ($conn:expr, |$c:ident| $call:expr) => {
        async {
            let $c: &mut $crate::pg::PgConnection = $conn;
            match $crate::pg::savepoint(&mut *$c).await {
                Err(e) => Err(e),
                Ok(()) => {
                    let result = $call.await;
                    $crate::pg::settle(&mut *$c, result).await
                }
            }
        }
    };
}

/// The database server's clock in ms since the epoch (`clock_timestamp()`), for a caller that
/// builds `Ctx.now` from the database rather than from its own clock.
pub async fn db_now_ms(c: &mut PgConnection) -> Result<i64, StoreError> {
    sqlx::query_scalar(&format!("SELECT {SERVER_NOW_MS}"))
        .fetch_one(&mut *c)
        .await
        .map_err(|e| db_error_kind(&e)(unavailable(redact(&e.to_string(), &[]))))
}

impl PgOps {
    // ── Teams ────────────────────────────────────────────────────────────

    /// The live team row this machine uses for root tab `team` (see sqlite::find_team).
    async fn find_team(&self, c: &mut PgConnection, team: &str, host: Option<&str>, lock: Lock) -> Result<Option<TeamRef>, StoreError> {
        let sql = self.s(&format!(
            "SELECT uid, name, last_post_seq, home_host, EXISTS (SELECT 1 FROM @@.hosts h WHERE h.host = teams.home_host)
             FROM @@.teams WHERE team = $1 AND deleted_at IS NULL
             ORDER BY (home_host IS NOT DISTINCT FROM $2) DESC, last_activity_at DESC LIMIT 1{}",
            lock.sql()
        ));
        let row = sqlx::query(&sql).bind(team).bind(host).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        row.map(|r| -> Result<TeamRef, sqlx::Error> {
            let home: Option<String> = r.try_get(3)?;
            let synced: bool = r.try_get(4)?;
            // A team homed on a computer that syncs (registered in `hosts`) is written only by
            // that computer; a direct write here would bump row_version past its next push.
            let sync_home = if synced && home.as_deref() != host { home } else { None };
            Ok(TeamRef { uid: r.try_get(0)?, name: r.try_get(1)?, last_post_seq: r.try_get(2)?, sync_home })
        })
        .transpose()
        .map_err(|e| self.err(e))
    }

    /// The team homed on this machine for root tab `team`, created (or revived) when missing;
    /// its row stays locked until the transaction ends.
    async fn ensure_team(&self, c: &mut PgConnection, team: &str, name: Option<&str>, ctx: &Ctx) -> Result<String, StoreError> {
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
        Err(StoreError::Unavailable(unavailable("could not create the team row")))
    }

    /// Next post / task number of a team (never repeats, never goes back); also marks activity.
    async fn next_seq(&self, c: &mut PgConnection, uid: &str, task: bool, now: i64) -> Result<i64, StoreError> {
        let sql = if task {
            "UPDATE @@.teams SET last_task_seq = last_task_seq + 1, last_activity_at = $2, updated_at = $2, row_version = row_version + 1
             WHERE uid = $1 RETURNING last_task_seq"
        } else {
            "UPDATE @@.teams SET last_post_seq = last_post_seq + 1, last_activity_at = $2, updated_at = $2, row_version = row_version + 1
             WHERE uid = $1 RETURNING last_post_seq"
        };
        sqlx::query_scalar(&self.s(sql)).bind(uid).bind(now).fetch_one(&mut *c).await.map_err(|e| self.err(e))
    }

    async fn touch_team(&self, c: &mut PgConnection, uid: &str, now: i64) -> Result<(), StoreError> {
        sqlx::query(&self.s("UPDATE @@.teams SET last_activity_at = $2, updated_at = $2, row_version = row_version + 1 WHERE uid = $1"))
            .bind(uid)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(())
    }

    async fn lock_team(&self, c: &mut PgConnection, uid: &str) -> Result<bool, StoreError> {
        let row = sqlx::query(&self.s("SELECT uid FROM @@.teams WHERE uid = $1 FOR UPDATE"))
            .bind(uid)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(row.is_some())
    }

    async fn ids(&self, c: &mut PgConnection, sql: &str, arg: &str) -> Result<Vec<String>, StoreError> {
        sqlx::query_scalar(&self.s(sql)).bind(arg).fetch_all(&mut *c).await.map_err(|e| self.err(e))
    }

    async fn count(&self, c: &mut PgConnection, sql: &str, arg: &str) -> Result<i64, StoreError> {
        sqlx::query_scalar(&self.s(sql)).bind(arg).fetch_one(&mut *c).await.map_err(|e| self.err(e))
    }

    // ── Posts ────────────────────────────────────────────────────────────

    async fn tombstone_posts(&self, c: &mut PgConnection, ids: &[String], now: i64) -> Result<(), StoreError> {
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
    ) -> Result<(String, i64), StoreError> {
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

    async fn task_id_of(&self, c: &mut PgConnection, team_uid: &str, team: &str, seq: i64) -> Result<String, StoreError> {
        sqlx::query_scalar(&self.s("SELECT id FROM @@.tasks WHERE team_uid = $1 AND seq = $2 AND deleted_at IS NULL"))
            .bind(team_uid)
            .bind(seq)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| self.err(e))?
            .ok_or_else(|| StoreError::NotFound(format!("no task #{seq} in team {team}")))
    }

    // ── Tasks ────────────────────────────────────────────────────────────

    async fn load_task(&self, c: &mut PgConnection, team_uid: &str, team: &str, seq: i64, lock: bool) -> Result<TaskRow, StoreError> {
        let sql = self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t WHERE t.team_uid = $1 AND t.seq = $2 AND t.deleted_at IS NULL{}",
            if lock { " FOR UPDATE OF t" } else { "" }
        ));
        let row = sqlx::query(&sql).bind(team_uid).bind(seq).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        match row {
            Some(r) => task_from_row(&r).map_err(|e| self.err(e)),
            None => Err(StoreError::NotFound(format!("no task #{seq} in team {team}"))),
        }
    }

    async fn load_task_by_id(&self, c: &mut PgConnection, id: &str, lock: bool) -> Result<Option<TaskRow>, StoreError> {
        let sql = self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t WHERE t.id = $1 AND t.deleted_at IS NULL{}",
            if lock { " FOR UPDATE OF t" } else { "" }
        ));
        let row = sqlx::query(&sql).bind(id).fetch_optional(&mut *c).await.map_err(|e| self.err(e))?;
        row.map(|r| task_from_row(&r)).transpose().map_err(|e| self.err(e))
    }

    async fn deps_of(&self, c: &mut PgConnection, task_id: &str) -> Result<Vec<(i64, String)>, StoreError> {
        sqlx::query_as(&self.s(
            "SELECT x.seq, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
             WHERE d.task_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        ))
        .bind(task_id)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    async fn task_out(&self, c: &mut PgConnection, row: &TaskRow, now: i64, stale_ms: i64) -> Result<Value, StoreError> {
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
    ) -> Result<(), StoreError> {
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
    async fn expire_leases(&self, c: &mut PgConnection, team_uid: Option<&str>, now: i64, except: Option<&str>, host: Option<&str>) -> Result<Vec<Value>, StoreError> {
        let rows = sqlx::query(&self.s(&format!(
            "SELECT {TASK_COLS} FROM @@.tasks t
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.lease_until IS NOT NULL AND t.lease_until < $1
               AND ($2::text IS NULL OR t.team_uid = $2) AND ($3::text IS NULL OR t.id <> $3)
               AND t.team_uid NOT IN (SELECT tm.uid FROM @@.teams tm JOIN @@.hosts h ON h.host = tm.home_host)
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
    async fn tombstone_tasks(&self, c: &mut PgConnection, ids: &[String], now: i64) -> Result<(), StoreError> {
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

    async fn tombstone_dep(&self, c: &mut PgConnection, task_id: &str, depends_on_id: &str, now: i64) -> Result<u64, StoreError> {
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

    async fn insert_dep(&self, c: &mut PgConnection, task_id: &str, depends_on_id: &str, team_uid: &str, ctx: &Ctx) -> Result<(), StoreError> {
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
    async fn prune_team(&self, c: &mut PgConnection, team_uid: &str, room: i64, now: i64) -> Result<usize, StoreError> {
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
    async fn depends_transitively(&self, c: &mut PgConnection, from: &str, target: &str) -> Result<bool, StoreError> {
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
            Err(StoreError::Conflict(format!("dependency chain deeper than {MAX_DEP_DEPTH} levels: refused")))
        }
    }

    async fn brief_list(&self, c: &mut PgConnection, sql: &str, id: &str) -> Result<Vec<Value>, StoreError> {
        let rows: Vec<(i64, String, String)> = sqlx::query_as(&self.s(sql)).bind(id).fetch_all(&mut *c).await.map_err(|e| self.err(e))?;
        Ok(rows.into_iter().map(|(seq, title, state)| json!({ "seq": seq, "title": title, "state": state })).collect())
    }

    async fn holders(&self, c: &mut PgConnection, instance: &str) -> Result<Vec<String>, StoreError> {
        self.ids(
            c,
            "SELECT DISTINCT owner_id FROM @@.tasks
             WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $1 AND owner_id IS NOT NULL",
            instance,
        )
        .await
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

    // ── Operations (public: the caller's transaction) ─────────────────────

    /// One post (see sqlite::post): the team row (created when missing) locked first, the post
    /// and the per-team cap, all in the caller's transaction.
    pub async fn post(&self, c: &mut PgConnection, team: &str, input: &PostInput, ctx: &Ctx) -> Result<Value, StoreError> {
        let spec = PostSpec::check(team, input)?;
        let uid = self.ensure_team(c, team, spec.team_name.as_deref(), ctx).await?;
        let task_id = match input.task {
            Some(seq) => Some(self.task_id_of(c, &uid, team, seq).await?),
            None => None,
        };
        let (id, _) = self
            .insert_post(
                c,
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
            .fetch_one(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        let out = post_json(team, &row).map_err(|e| self.err(e))?;
        Ok(out)
    }

    /// See sqlite::read. A `--new` read holds the team row FOR SHARE, so no post lands between
    /// the rows it returns and the cursor it stores (and writes that cursor). `PgStore` runs a
    /// plain read as one REPEATABLE READ READ ONLY snapshot; in a caller's READ COMMITTED
    /// transaction the totals and rows come from separate statements.
    pub async fn read(&self, c: &mut PgConnection, team: &str, q: &ReadQuery, host: Option<&str>) -> Result<Value, StoreError> {
        let spec = ReadSpec::check(team, q)?;
        let exclude_kind: Option<&str> = if spec.pinned { Some("announce") } else { None };
        let cursor_read = spec.cursor_tab.is_some();
        let Some(t) = self.find_team(c, team, host, if cursor_read { Lock::Share } else { Lock::None }).await? else {
            return Ok(spec.empty(team));
        };
        let uid = t.uid.as_str();
        let cursor: i64 = match &spec.cursor_tab {
            Some(tab) => sqlx::query_scalar(&self.s("SELECT arrival FROM @@.cursors WHERE team_uid = $1 AND tab_id = $2"))
                .bind(uid)
                .bind(tab)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| self.err(e))?
                .unwrap_or(0),
            None => 0,
        };
        let total = self.count(c, "SELECT count(*) FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
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
            .fetch_one(&mut *c)
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
        .fetch_all(&mut *c)
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
            .fetch_all(&mut *c)
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
            let newest = self.count(c, "SELECT coalesce(max(arrival), 0) FROM @@.posts WHERE team_uid = $1", uid).await?;
            let target = if more > 0 { last_arrival.unwrap_or(cursor) } else { newest.max(cursor) };
            sqlx::query(&self.s(
                "INSERT INTO @@.cursors AS c (team_uid, tab_id, arrival) VALUES ($1, $2, $3)
                 ON CONFLICT (team_uid, tab_id) DO UPDATE SET arrival = GREATEST(c.arrival, excluded.arrival)",
            ))
            .bind(uid)
            .bind(tab)
            .bind(target)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
            new_cursor = Some(target);
        }
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

    pub async fn teams(&self, c: &mut PgConnection) -> Result<Vec<Value>, StoreError> {
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
        .fetch_all(&mut *c)
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

    /// Tombstone the team's posts (team row locked first).
    pub async fn clear(&self, c: &mut PgConnection, team: &str, ctx: &Ctx) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let Some(t) = self.find_team(c, team, ctx.host.as_deref(), Lock::Update).await? else {
            return Ok(json!({ "team": team, "removed": 0, "lastSeq": 0 }));
        };
        if let Some(home) = &t.sync_home {
            return Err(StoreError::Forbidden(read_only_message(home)));
        }
        let ids = self.ids(c, "SELECT id FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", &t.uid).await?;
        self.tombstone_posts(c, &ids, ctx.now).await?;
        self.touch_team(c, &t.uid, ctx.now).await?;
        Ok(json!({ "team": team, "removed": ids.len(), "lastSeq": t.last_post_seq }))
    }

    /// How many teams "Clean up old teams" would retire now (nothing is changed).
    pub async fn stale_count(&self, c: &mut PgConnection, now: i64, max_age_ms: i64) -> Result<i64, StoreError> {
        sqlx::query_scalar(&self.s(
            "SELECT count(*) FROM (SELECT t.uid FROM @@.teams t LEFT JOIN @@.posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid HAVING greatest(t.last_activity_at, coalesce(max(p.ts), 0)) < $1) x",
        ))
        .bind(now - max_age_ms)
        .fetch_one(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    /// Teams idle since before `cutoff` (no lock; `retire_team` re-checks under the team lock).
    async fn stale_candidates(&self, c: &mut PgConnection, cutoff: i64) -> Result<Vec<String>, StoreError> {
        sqlx::query_scalar(&self.s(
            "SELECT t.uid FROM @@.teams t LEFT JOIN @@.posts p ON p.team_uid = t.uid AND p.deleted_at IS NULL
             WHERE t.deleted_at IS NULL
             GROUP BY t.uid HAVING greatest(t.last_activity_at, coalesce(max(p.ts), 0)) < $1",
        ))
        .bind(cutoff)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    /// Tombstone one idle team with its posts, tasks, dependencies and events (cursors go);
    /// false when it became active meanwhile (checked under its row lock).
    async fn retire_team(&self, c: &mut PgConnection, uid: &str, cutoff: i64, now: i64) -> Result<bool, StoreError> {
        // Re-check under the team lock: it may have become active meanwhile.
        let last: Option<i64> = sqlx::query_scalar(&self.s(
            "SELECT greatest(t.last_activity_at,
                    coalesce((SELECT max(p.ts) FROM @@.posts p WHERE p.team_uid = t.uid AND p.deleted_at IS NULL), 0))
             FROM @@.teams t WHERE t.uid = $1 AND t.deleted_at IS NULL FOR UPDATE",
        ))
        .bind(uid)
        .fetch_optional(&mut *c)
        .await
        .map_err(|e| self.err(e))?
        .flatten();
        if !last.is_some_and(|l| l < cutoff) {
            return Ok(false);
        }
        let posts = self.ids(c, "SELECT id FROM @@.posts WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
        self.tombstone_posts(c, &posts, now).await?;
        let tasks = self.ids(c, "SELECT id FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL", uid).await?;
        self.tombstone_tasks(c, &tasks, now).await?;
        sqlx::query(&self.s("DELETE FROM @@.cursors WHERE team_uid = $1")).bind(uid).execute(&mut *c).await.map_err(|e| self.err(e))?;
        sqlx::query(&self.s("UPDATE @@.teams SET deleted_at = $2, updated_at = $2, row_version = row_version + 1 WHERE uid = $1"))
            .bind(uid)
            .bind(now)
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(true)
    }

    /// Remove tombstones older than TOMBSTONE_RETENTION_MS, finished outbox notes older than
    /// OUTBOX_RETENTION_MS (where the table exists) and cursors of removed teams.
    async fn purge_tombstones(&self, c: &mut PgConnection, now: i64) -> Result<(), StoreError> {
        let purge_before = now - TOMBSTONE_RETENTION_MS;
        for table in ["posts", "task_events", "task_deps", "tasks", "teams"] {
            sqlx::query(&self.s(&format!("DELETE FROM @@.{table} WHERE deleted_at IS NOT NULL AND deleted_at < $1")))
                .bind(purge_before)
                .execute(&mut *c)
                .await
                .map_err(|e| self.err(e))?;
        }
        // Finished remote notes (stage 3c) after OUTBOX_RETENTION_MS; only where the table exists.
        let has_outbox: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("{}outbox", self.prefix))
            .fetch_one(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        if has_outbox {
            sqlx::query(&self.s("DELETE FROM @@.outbox WHERE state <> 'pending' AND coalesce(handled_at, created_at) < $1"))
                .bind(now - OUTBOX_RETENTION_MS)
                .execute(&mut *c)
                .await
                .map_err(|e| self.err(e))?;
        }
        sqlx::query(&self.s("DELETE FROM @@.cursors WHERE team_uid NOT IN (SELECT uid FROM @@.teams)"))
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        Ok(())
    }

    /// "Clean up old teams" in the caller's transaction: every idle team and the purge at once
    /// (`PgStore::prune_stale` gives each team its own transaction instead). Locks each retired
    /// team's row, in candidate order.
    pub async fn prune_stale(&self, c: &mut PgConnection, now: i64, max_age_ms: i64) -> Result<usize, StoreError> {
        let cutoff = now - max_age_ms;
        let mut retired = 0usize;
        for uid in &self.stale_candidates(c, cutoff).await? {
            if self.retire_team(c, uid, cutoff, now).await? {
                retired += 1;
            }
        }
        self.purge_tombstones(c, now).await?;
        Ok(retired)
    }

    /// `task add` (see `task_write`): team row first, dependencies checked, the per-team caps.
    async fn add_task(&self, c: &mut PgConnection, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, StoreError> {
        let spec = AddSpec::check(op)?;
        let now = ctx.now;
        let uid = self.ensure_team(c, team, spec.team_name.as_deref(), ctx).await?;
        let parent_id = match op.parent {
            Some(seq) => Some(self.task_id_of(c, &uid, team, seq).await?),
            None => None,
        };
        let id = new_id();
        let mut dep_ids = Vec::new();
        for seq in &spec.after {
            let dep = self.load_task(c, &uid, team, *seq, false).await?;
            if dep.state == "cancelled" {
                return Err(StoreError::Conflict(format!("#{seq} is cancelled: it cannot be a dependency")));
            }
            self.depends_transitively(c, &dep.id, &id).await?;
            dep_ids.push(dep.id);
        }
        self.prune_team(c, &uid, 1, now).await?;
        let count = self.count(c, "SELECT count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL", &uid).await?;
        if count >= self.limits.tasks {
            return Err(StoreError::Conflict(format!(
                "task limit reached: team {team} has {count} tasks that cannot be pruned (max {}); finish or cancel some first",
                self.limits.tasks
            )));
        }
        let seq = self.next_seq(c, &uid, true, now).await?;
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
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        for dep in &dep_ids {
            self.insert_dep(c, &id, dep, &uid, ctx).await?;
        }
        let row = self.load_task(c, &uid, team, seq, false).await?;
        self.add_event(
            c,
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
        self.prune_team(c, &uid, 0, now).await?;
        let task = self.task_out(c, &row, now, DEFAULT_STALE_MS).await?;
        Ok(json!({ "action": "add", "from": Value::Null, "to": "open", "task": task, "expired": [] }))
    }

    /// One task write (see sqlite::task_write, every op including `add`): the team row locked
    /// first, lazy lease expiry, the rule check, a guarded UPDATE and the event. A refused
    /// owner-only transition is `LeaseLost` when the actor's lease ran out and the task was
    /// taken from them.
    pub async fn task_write(&self, c: &mut PgConnection, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let name = op.op.trim();
        if name == "add" {
            return self.add_task(c, team, op, actor, ctx).await;
        }
        let WriteSpec { action, reason, result, claim_next, next_labels, lease } = WriteSpec::check(name, op)?;
        let now = ctx.now;
        let host = ctx.host.as_deref();
        let Some(team_ref) = self.find_team(c, team, host, Lock::Update).await? else {
            if claim_next {
                return Ok(none_ready(0, 0, Vec::new()));
            }
            return Err(StoreError::NotFound(format!("no task #{} in team {team}", op.task.unwrap_or(0))));
        };
        if let Some(home) = &team_ref.sync_home {
            return Err(StoreError::Forbidden(read_only_message(home)));
        }
        let uid = team_ref.uid.as_str();
        let target: Option<TaskRow> = match op.task {
            Some(seq) => Some(self.load_task(c, uid, team, seq, true).await?),
            None => None,
        };
        let except = target.as_ref().filter(|t| t.owner_id.as_deref() == Some(actor.id.as_str())).map(|t| t.id.clone());
        let expired = self.expire_leases(c, Some(uid), now, except.as_deref(), host).await?;
        let row = match target {
            Some(t) => self.load_task(c, uid, team, t.seq, false).await?,
            None => {
                let next: Option<i64> = sqlx::query_scalar(&self.s(&format!(
                    "SELECT t.seq FROM @@.tasks t WHERE t.team_uid = $1 AND t.deleted_at IS NULL AND t.state = 'open' AND NOT {UNMET}
                     AND {PG_LABEL_MATCH}
                     ORDER BY t.priority DESC, t.seq LIMIT 1 FOR UPDATE OF t SKIP LOCKED"
                )))
                .bind(uid)
                .bind(&next_labels)
                .fetch_optional(&mut *c)
                .await
                .map_err(|e| self.err(e))?;
                match next {
                    Some(seq) => self.load_task(c, uid, team, seq, false).await?,
                    None => {
                        let (open, waiting): (i64, i64) = sqlx::query_as(&self.s(&format!(
                            "SELECT count(*), count(*) FILTER (WHERE {UNMET}) FROM @@.tasks t
                             WHERE t.team_uid = $1 AND t.deleted_at IS NULL AND t.state = 'open' AND {PG_LABEL_MATCH}"
                        )))
                        .bind(uid)
                        .bind(&next_labels)
                        .fetch_one(&mut *c)
                        .await
                        .map_err(|e| self.err(e))?;
                        return Ok(none_ready(open, waiting, expired));
                    }
                }
            }
        };
        let from = row.state.clone();
        let to = match check_transition_typed(action, &row.facts(), actor) {
            Ok(to) => to,
            Err(e) => return Err(self.lease_lost_or(&mut *c, &row, action, actor, e).await),
        };
        let owner = actor.id.as_str();
        let seq = row.seq;
        let id = row.id.as_str();
        let mut note: Option<String> = reason.clone();
        let mut data: Option<Value> = None;
        let mut attempt_after = row.attempt;
        let n: u64 = match action {
            Action::Claim => {
                let deps = self.deps_of(c, id).await?;
                let unmet: Vec<String> = deps.iter().filter(|(_, s)| !dep_met(s)).map(|(n, s)| format!("#{n} ({s})")).collect();
                if !unmet.is_empty() {
                    return Err(StoreError::Conflict(format!("#{seq} is waiting for {}: claim a ready task (agent task list --ready)", unmet.join(", "))));
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
                    check_edit_typed(&row.facts(), actor, true)?;
                }
                if let Some(v) = op.expected_version {
                    if v != row.version {
                        return Err(StoreError::Conflict(format!("#{seq} changed since you loaded it (version {v}, now {}): load it again", row.version)));
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
                let on_seq = op.on.ok_or_else(|| StoreError::Invalid("dependency required: agent task dep add|rm <#task> <#depends-on>".to_string()))?;
                let on = self.load_task(c, uid, team, on_seq, false).await?;
                if on.id == row.id {
                    return Err(StoreError::Invalid(format!("#{seq} cannot depend on itself")));
                }
                data = Some(json!({ "on": on_seq }));
                if action == Action::DepAdd && on.state == "cancelled" {
                    return Err(StoreError::Conflict(format!("#{on_seq} is cancelled: it cannot be a dependency")));
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
                        return Err(StoreError::Conflict(format!("#{seq} already depends on #{on_seq}")));
                    }
                    let count = self.count(c, "SELECT count(*) FROM @@.task_deps WHERE task_id = $1 AND deleted_at IS NULL", id).await?;
                    if count as usize >= MAX_DEPS_PER_TASK {
                        return Err(StoreError::Conflict(format!("#{seq} already has {MAX_DEPS_PER_TASK} dependencies (max)")));
                    }
                    if self.depends_transitively(c, &on.id, id).await? {
                        return Err(StoreError::Conflict(format!("#{on_seq} already depends on #{seq} (directly or through other tasks): that would be a cycle")));
                    }
                    self.insert_dep(c, id, &on.id, uid, ctx).await?;
                } else if self.tombstone_dep(c, id, &on.id, now).await? == 0 {
                    return Err(StoreError::NotFound(format!("#{seq} does not depend on #{on_seq}")));
                }
                let sql = self.s("UPDATE @@.tasks SET updated_at = $2, version = version + 1, row_version = row_version + 1 WHERE id = $1");
                sqlx::query(&sql).bind(id).bind(now).execute(&mut *c).await.map_err(|e| self.err(e))?.rows_affected()
            }
        };
        if n == 0 {
            return Err(match self.load_task(c, uid, team, seq, false).await {
                Ok(cur) => StoreError::Conflict(format!("#{seq} changed meanwhile: it is now {}", describe_state(&cur.facts()))),
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
        let mut out = json!({ "action": action.event(), "from": from, "to": to, "task": task, "expired": expired });
        if let Some(p) = post_seq {
            out["post"] = json!(p);
        }
        Ok(out)
    }

    /// Expire leases of one team in its own short write transaction, only when some ran out.
    /// A refused owner-only transition (block, unblock, release, done, submit, fail) becomes
    /// `LeaseLost` when the actor held this task and lost it: its newest `lease_expired` or
    /// `auto_release` event names the actor as owner and comes after the actor's own newest
    /// event on the task. Any other refusal (or a failing lookup) is returned unchanged.
    async fn lease_lost_or(&self, c: &mut PgConnection, row: &TaskRow, action: Action, actor: &Actor, refused: StoreError) -> StoreError {
        let owner_action = matches!(action, Action::Block | Action::Unblock | Action::Release | Action::Done | Action::Submit | Action::Fail);
        if !owner_action || actor.human || actor.id.is_empty() || row.owner_id.as_deref() == Some(actor.id.as_str()) {
            return refused;
        }
        // Under a savepoint: a failing lookup must not leave the caller's transaction aborted.
        // (Refused outside a transaction block, where a failure aborts nothing.)
        let saved = sqlx::query("SAVEPOINT bbarit_board_lookup").execute(&mut *c).await.is_ok();
        let lost: Result<bool, sqlx::Error> = sqlx::query_scalar(&self.s(
            "SELECT EXISTS (SELECT 1 FROM @@.task_events e
               WHERE e.task_id = $1 AND e.deleted_at IS NULL AND e.action IN ('lease_expired', 'auto_release')
                 AND e.data IS NOT NULL AND (e.data::jsonb ->> 'ownerId') = $2
                 AND e.seq > coalesce((SELECT max(m.seq) FROM @@.task_events m
                                        WHERE m.task_id = $1 AND m.deleted_at IS NULL AND m.actor_id = $2), 0))",
        ))
        .bind(&row.id)
        .bind(&actor.id)
        .fetch_one(&mut *c)
        .await;
        if saved {
            if lost.is_err() {
                let _ = sqlx::query("ROLLBACK TO SAVEPOINT bbarit_board_lookup").execute(&mut *c).await;
            }
            let _ = sqlx::query("RELEASE SAVEPOINT bbarit_board_lookup").execute(&mut *c).await;
        }
        match lost {
            Ok(true) => StoreError::LeaseLost(refused.into_message()),
            _ => refused,
        }
    }
    /// How many leases of one team ran out (claimed or blocked past `lease_until`).
    async fn expired_count(&self, c: &mut PgConnection, uid: &str, now: i64) -> Result<i64, StoreError> {
        sqlx::query_scalar(&self.s(
            "SELECT count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND lease_until < $2",
        ))
        .bind(uid)
        .bind(now)
        .fetch_one(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    /// Expire leases of one team, its row locked first (nothing when the team row is gone).
    async fn expire_locked(&self, c: &mut PgConnection, uid: &str, now: i64, host: Option<&str>) -> Result<Vec<Value>, StoreError> {
        if !self.lock_team(c, uid).await? {
            return Ok(Vec::new());
        }
        self.expire_leases(c, Some(uid), now, None, host).await
    }

    /// Expire leases of one team only when some ran out (the store's own path does this in a
    /// separate short write transaction before a list or show).
    async fn expire_if_needed(&self, c: &mut PgConnection, uid: &str, now: i64, host: Option<&str>) -> Result<Vec<Value>, StoreError> {
        if self.expired_count(c, uid, now).await? == 0 {
            return Ok(Vec::new());
        }
        self.expire_locked(c, uid, now, host).await
    }
    /// See sqlite::task_list. In the caller's transaction: find the team, expire its ran-out
    /// leases (a write: the transaction must not be READ ONLY), then list. The store's own path
    /// runs those as three steps (lookup, a short write transaction, one REPEATABLE READ READ
    /// ONLY snapshot); a caller wanting the counts and rows from one snapshot starts its
    /// transaction REPEATABLE READ.
    pub async fn task_list(&self, c: &mut PgConnection, team: &str, q: &TaskListQuery, ctx: &Ctx) -> Result<Value, StoreError> {
        let spec = ListSpec::check(team, q)?;
        let Some(team_ref) = self.find_team(c, team, ctx.host.as_deref(), Lock::None).await? else {
            return Ok(Self::no_tasks(team));
        };
        let expired = self.expire_if_needed(c, &team_ref.uid, ctx.now, ctx.host.as_deref()).await?;
        self.task_list_rows(c, team, spec, team_ref, expired, ctx.now).await
    }

    fn no_tasks(team: &str) -> Value {
        json!({ "team": team, "tasks": [], "matched": 0, "more": 0, "counts": ListSpec::zero_counts(), "expired": [] })
    }

    /// The list itself (after the lookup and the lease expiry).
    async fn task_list_rows(&self, c: &mut PgConnection, team: &str, spec: ListSpec, team_ref: TeamRef, expired: Vec<Value>, now: i64) -> Result<Value, StoreError> {
        let ListSpec { stale, stored, want_waiting, want_ready, want_stale, state_filter, pattern, mine, limit } = spec;
        let mut counts = ListSpec::zero_counts();
        let uid = team_ref.uid.clone();
        let filter = format!(
            "t.team_uid = $1 AND t.deleted_at IS NULL
             AND (NOT $2 OR t.state = ANY($3)
                  OR ($4 AND t.state = 'open' AND {UNMET})
                  OR ($5 AND t.state = 'open' AND NOT {UNMET})
                  OR ($6 AND t.state IN ('claimed','blocked') AND t.updated_at < $7))
             AND ($8::text IS NULL OR t.owner_id = $8)
             AND ($9::text IS NULL OR t.title ILIKE $9 ESCAPE E'\\\\' OR t.body ILIKE $9 ESCAPE E'\\\\')"
        );
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
            .fetch_one(&mut *c)
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
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        let rows = rows.iter().map(task_from_row).collect::<Result<Vec<_>, _>>().map_err(|e| self.err(e))?;
        let mut deps: HashMap<String, Vec<(i64, String)>> = HashMap::new();
        let dep_rows: Vec<(String, i64, String)> = sqlx::query_as(&self.s(
            "SELECT d.task_id, x.seq, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
             WHERE d.team_uid = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
        ))
        .bind(&uid)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        for (task, seq, state) in dep_rows {
            deps.entry(task).or_default().push((seq, state));
        }
        let by_state: Vec<(String, i64)> = sqlx::query_as(&self.s(
            "SELECT state, count(*) FROM @@.tasks WHERE team_uid = $1 AND deleted_at IS NULL GROUP BY state",
        ))
        .bind(&uid)
        .fetch_all(&mut *c)
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
        .fetch_one(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        counts.insert("waiting".into(), json!(waiting));
        counts.insert("stale".into(), json!(stale_n));
        let tasks: Vec<Value> = rows.iter().map(|r| task_json(r, deps.get(&r.id).map(Vec::as_slice).unwrap_or(&[]), now, stale)).collect();
        let more = (matched - tasks.len() as i64).max(0);
        let mut out = json!({ "team": team, "tasks": tasks, "matched": matched, "more": more, "counts": counts, "expired": expired });
        if let Some(n) = team_ref.name {
            out["teamName"] = json!(n);
        }
        Ok(out)
    }

    /// See sqlite::task_show. In the caller's transaction: find the team, expire its ran-out
    /// leases (a write), then read the task (the store's own path: lookup, a short write
    /// transaction, then one REPEATABLE READ READ ONLY snapshot).
    pub async fn task_show(&self, c: &mut PgConnection, team: &str, seq: i64, history: bool, stale: Option<i64>, ctx: &Ctx) -> Result<Value, StoreError> {
        let team_ref = self.show_team(c, team, seq, ctx).await?;
        let expired = self.expire_if_needed(c, &team_ref.uid, ctx.now, ctx.host.as_deref()).await?;
        self.task_show_rows(c, team, &team_ref.uid, seq, history, stale, expired, ctx.now).await
    }

    async fn show_team(&self, c: &mut PgConnection, team: &str, seq: i64, ctx: &Ctx) -> Result<TeamRef, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        self.find_team(c, team, ctx.host.as_deref(), Lock::None)
            .await?
            .ok_or_else(|| StoreError::NotFound(format!("no task #{seq} in team {team}")))
    }

    #[allow(clippy::too_many_arguments)]
    async fn task_show_rows(
        &self,
        c: &mut PgConnection,
        team: &str,
        uid: &str,
        seq: i64,
        history: bool,
        stale: Option<i64>,
        expired: Vec<Value>,
        now: i64,
    ) -> Result<Value, StoreError> {
        let row = self.load_task(c, uid, team, seq, false).await?;
        let task = self.task_out(c, &row, now, stale_ms(stale)).await?;
        let deps = self
            .brief_list(
                c,
                "SELECT x.seq, x.title, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.depends_on_id
                 WHERE d.task_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let dependents = self
            .brief_list(
                c,
                "SELECT x.seq, x.title, x.state FROM @@.task_deps d JOIN @@.tasks x ON x.id = d.task_id
                 WHERE d.depends_on_id = $1 AND d.deleted_at IS NULL AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let children = self
            .brief_list(
                c,
                "SELECT x.seq, x.title, x.state FROM @@.tasks x WHERE x.parent_id = $1 AND x.deleted_at IS NULL ORDER BY x.seq",
                &row.id,
            )
            .await?;
        let parent = match row.parent_seq {
            Some(p) => {
                let pr = self.load_task(c, uid, team, p, false).await?;
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
            .fetch_all(&mut *c)
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
        Ok(out)
    }

    /// See sqlite::team_events (one REPEATABLE READ READ ONLY snapshot).
    pub async fn team_events(&self, c: &mut PgConnection, team: &str, q: &EventsQuery, host: Option<&str>) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let (limit, since) = q.check();
        let Some(team_ref) = self.find_team(c, team, host, Lock::None).await? else {
            return Ok(json!({ "team": team, "events": [], "more": 0 }));
        };
        let from = "FROM @@.task_events e JOIN @@.tasks x ON x.id = e.task_id
                    WHERE e.team_uid = $1 AND e.deleted_at IS NULL AND x.deleted_at IS NULL AND e.ts > $2";
        let matched: i64 = sqlx::query_scalar(&self.s(&format!("SELECT count(*) {from}")))
            .bind(&team_ref.uid)
            .bind(since)
            .fetch_one(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        let rows = sqlx::query(&self.s(&format!(
            "SELECT e.seq, e.ts, e.actor_id, e.actor_name, e.actor_host, e.action, e.from_state, e.to_state, e.attempt,
                    e.note, e.id, x.seq {from} ORDER BY e.ts DESC, e.id DESC LIMIT $3"
        )))
        .bind(&team_ref.uid)
        .bind(since)
        .bind(limit)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
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
    pub async fn lease_tick(&self, c: &mut PgConnection, instance: &str, alive: &[String], now: i64, lease: i64) -> Result<Value, StoreError> {
        let renewed: Vec<String> = sqlx::query_scalar(&self.s(
            "UPDATE @@.tasks SET lease_until = $1, heartbeat_at = $2, row_version = row_version + 1
             WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $3 AND owner_id = ANY($4)
             RETURNING id",
        ))
        .bind(now + lease_ms(Some(lease)))
        .bind(now)
        .bind(instance)
        .bind(alive)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        let holders = self.holders(c, instance).await?;
        Ok(json!({ "renewed": renewed.len(), "holders": holders }))
    }

    /// Release one held task (auto_release), team row first, only while it is still held
    /// through `instance` (and by `owner` when given). None: nothing to release (no write).
    async fn release_one(&self, c: &mut PgConnection, id: &str, owner: Option<&str>, instance: &str, now: i64, host: Option<&str>, reason: &str) -> Result<Option<Value>, StoreError> {
        let Some(seen) = self.load_task_by_id(c, id, false).await? else { return Ok(None) };
        self.lock_team(c, &seen.team_uid).await?;
        let Some(row) = self.load_task_by_id(c, id, true).await? else { return Ok(None) };
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
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?
        .rows_affected();
        if n == 0 {
            return Ok(None);
        }
        let app = Actor::app(host);
        self.add_event(
            c,
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
        self.touch_team(c, &row.team_uid, now).await?;
        Ok(Some(json!({ "team": row.team, "seq": row.seq, "title": row.title, "ownerId": row.owner_id, "from": row.state })))
    }

    /// Ids of the tasks `owner_id` holds through `instance`.
    async fn held_ids(&self, c: &mut PgConnection, instance: &str, owner_id: &str) -> Result<Vec<String>, StoreError> {
        sqlx::query_scalar(&self.s(
            "SELECT id FROM @@.tasks WHERE deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_id = $1 AND owner_instance = $2",
        ))
        .bind(owner_id)
        .bind(instance)
        .fetch_all(&mut *c)
        .await
        .map_err(|e| self.err(e))
    }

    /// auto_release every task `owner_id` holds through `instance`, all in the caller's
    /// transaction (the store's own path gives each task its own transaction and retries it).
    /// Each release locks its task's team row, then the task, in the order the tasks are found;
    /// a deadlock with another writer is `Busy`: retry the whole transaction.
    pub async fn release_owner(&self, c: &mut PgConnection, instance: &str, owner_id: &str, now: i64, host: Option<&str>, reason: &str) -> Result<Value, StoreError> {
        let mut released = Vec::new();
        for id in self.held_ids(c, instance, owner_id).await? {
            if let Some(v) = self.release_one(c, &id, Some(owner_id), instance, now, host, reason).await? {
                released.push(v);
            }
        }
        Ok(json!({ "released": released }))
    }
    /// Owner tabs of `instance` that still hold tasks.
    pub async fn lease_holders(&self, c: &mut PgConnection, instance: &str) -> Result<Vec<String>, StoreError> {
        self.holders(c, instance).await
    }

    /// Tasks held (claimed or blocked) by tabs on `host`, by team and number.
    pub async fn held_on_host(&self, c: &mut PgConnection, host: &str) -> Result<Vec<Value>, StoreError> {
        let rows = sqlx::query(&self.s(
            "SELECT t.id, tm.team, t.seq, t.state, t.owner_id, t.owner_name, t.owner_instance, t.lease_until, t.heartbeat_at
             FROM @@.tasks t JOIN @@.teams tm ON tm.uid = t.team_uid
             WHERE t.deleted_at IS NULL AND t.state IN ('claimed','blocked') AND t.owner_host = $1 ORDER BY tm.team, t.seq",
        ))
        .bind(host)
        .fetch_all(&mut *c)
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

    /// Adopt one held task for `instance` (a single guarded UPDATE); 1 when it was adopted.
    async fn adopt_one(&self, c: &mut PgConnection, instance: &str, a: &LeaseItem, now: i64, lease: i64) -> Result<u64, StoreError> {
        Ok(sqlx::query(&self.s(
            "UPDATE @@.tasks SET owner_instance = $2, lease_until = $3, heartbeat_at = $4, row_version = row_version + 1
             WHERE id = $1 AND deleted_at IS NULL AND state IN ('claimed','blocked') AND owner_instance = $5",
        ))
        .bind(&a.id)
        .bind(instance)
        .bind(now + lease_ms(Some(lease)))
        .bind(now)
        .bind(&a.instance)
        .execute(&mut *c)
        .await
        .map_err(|e| self.err(e))?
        .rows_affected())
    }

    /// The reason recorded on a task released because its owner tab did not come back.
    const NOT_BACK: &'static str = "owner tab did not come back after the app restarted";

    /// See sqlite::lease_apply, all in the caller's transaction (the store's own path runs each
    /// adoption as its own statement and each release in its own transaction). Releases lock
    /// team row, then task, in list order; a deadlock is `Busy`: retry the whole transaction.
    #[allow(clippy::too_many_arguments)]
    pub async fn lease_apply(
        &self,
        c: &mut PgConnection,
        instance: &str,
        adopt: &[LeaseItem],
        release: &[LeaseItem],
        now: i64,
        lease: i64,
        host: Option<&str>,
    ) -> Result<Value, StoreError> {
        let mut adopted = 0u64;
        for a in adopt {
            adopted += self.adopt_one(c, instance, a, now, lease).await?;
        }
        let mut released = Vec::new();
        for r in release {
            if let Some(v) = self.release_one(c, &r.id, None, &r.instance, now, host, Self::NOT_BACK).await? {
                released.push(v);
            }
        }
        Ok(json!({ "adopted": adopted, "released": released }))
    }

    // ── Settings: counts, copy ───────────────────────────────────────────

    /// Live teams, posts and tasks (status line).
    pub async fn counts(&self, c: &mut PgConnection) -> Result<Value, StoreError> {
        let (teams, posts, tasks): (i64, i64, i64) = sqlx::query_as(&self.s(
            "SELECT (SELECT count(*) FROM @@.teams WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM @@.posts WHERE deleted_at IS NULL),
                    (SELECT count(*) FROM @@.tasks WHERE deleted_at IS NULL)",
        ))
        .fetch_one(&mut *c)
        .await
        .map_err(|e| self.err(e))?;
        Ok(json!({ "teams": teams, "posts": posts, "tasks": tasks }))
    }

    /// Every live row of every live team (Copy data). `PgStore` reads it in one REPEATABLE READ
    /// READ ONLY snapshot; a caller wanting one snapshot starts its transaction so.
    pub async fn export_dump(&self, c: &mut PgConnection) -> Result<Dump, StoreError> {
        let mut dump = Dump::default();
        for (table, cols) in copy::TABLES {
            let rows = sqlx::query(&self.select_sql(table, cols)).fetch_all(&mut *c).await.map_err(|e| self.err(e))?;
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
        Ok(dump)
    }

    /// Insert a dump (Copy data): refused unless the board has no live team or `merge` is set;
    /// teams it already has are skipped, tombstoned teams in the way are removed for good.
    /// One transaction; rows go in multi-row INSERTs of up to IMPORT_CHUNK rows.
    pub async fn import_dump(&self, c: &mut PgConnection, dump: Dump, merge: bool) -> Result<Value, StoreError> {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("bbarit-board-copy:{}", self.schema))
            .execute(&mut *c)
            .await
            .map_err(|e| self.err(e))?;
        let mut existing = copy::Existing::default();
        let rows: Vec<(String, String, Option<String>, bool)> =
            sqlx::query_as(&self.s("SELECT uid, team, home_host, deleted_at IS NOT NULL FROM @@.teams"))
                .fetch_all(&mut *c)
                .await
                .map_err(|e| self.err(e))?;
        for (uid, team, host, dead) in rows {
            existing.add(uid, team, host, dead);
        }
        let copy::Plan { dump: plan, skipped, purge } = copy::plan(dump, &existing, merge).map_err(StoreError::Conflict)?;
        if !purge.is_empty() {
            for table in copy::PURGE_TABLES {
                sqlx::query(&self.s(&format!("DELETE FROM @@.{table} WHERE team_uid = ANY($1)")))
                    .bind(&purge)
                    .execute(&mut *c)
                    .await
                    .map_err(|e| self.err(e))?;
            }
            sqlx::query(&self.s("DELETE FROM @@.teams WHERE uid = ANY($1)")).bind(&purge).execute(&mut *c).await.map_err(|e| self.err(e))?;
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
                        .fetch_all(&mut *c)
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
                q.execute(&mut *c).await.map_err(|e| self.err(e))?;
            }
        }
        Ok(copy::summary(&plan, &skipped))
    }
}

impl PgStore {
    /// A store on `target` with its own pool (at most 5 connections, 5 s to connect);
    /// `app_version` is the version of the program using it (recorded on the server).
    pub fn new(target: PgTarget, app_version: &str) -> Self {
        Self::with_limits(target, Limits::default(), app_version)
    }

    pub fn with_limits(target: PgTarget, limits: Limits, app_version: &str) -> Self {
        let prefix = format!("{}.", quote_ident(&target.schema));
        let ops = PgOps::for_target(&target, limits);
        PgStore {
            target,
            prefix,
            ops,
            pool: OnceCell::new(),
            owns_pool: true,
            ready: AtomicBool::new(false),
            app_version: app_version.to_string(),
        }
    }

    /// A store on the caller's pool (a server sharing one pool between the store and its own
    /// work): no second pool is created, the pool's own limits and timeouts apply, and `close`
    /// leaves it open. The schema version is checked on the first command, as with `new`.
    /// The store's own pool sets `statement_timeout` (5 s) and `application_name`
    /// (`bbarit-board`) on every session; give the caller's pool the same (its
    /// `PgConnectOptions::options` / `application_name`), or a stuck statement holds the team
    /// lock and the shared `server_seq` lock without limit. Pass the password and URL to
    /// `with_secrets` so error text is scrubbed as with the store's own pool.
    pub fn from_pool(pool: PgPool, schema: &str, limits: Limits, app_version: &str) -> Result<Self, StoreError> {
        check_schema_name(schema).map_err(StoreError::Invalid)?;
        let opts = pool.connect_options();
        let label = format!(
            "{}@{}:{}/{}",
            opts.get_username(),
            opts.get_host(),
            opts.get_port(),
            opts.get_database().unwrap_or(opts.get_username())
        );
        let target = PgTarget {
            opts: (*opts).clone(),
            schema: schema.to_string(),
            label,
            from_env: false,
            secrets: Vec::new(),
            host: opts.get_host().to_string(),
        };
        let mut store = Self::with_limits(target, limits, app_version);
        store.ops.acquire_secs = pool.options().get_acquire_timeout().as_secs();
        store.pool = OnceCell::new_with(Some(pool));
        store.owns_pool = false;
        Ok(store)
    }

    /// Values (password, connection URL) to scrub from error text (see `PgOps::with_secrets`);
    /// for a store made with `from_pool`.
    pub fn with_secrets(mut self, secrets: Vec<String>) -> Self {
        self.target.secrets = secrets.clone();
        self.ops.secrets = secrets;
        self
    }

    /// The operations on a caller's connection, with this store's schema and limits.
    pub fn ops(&self) -> &PgOps {
        &self.ops
    }

    /// The pool this store uses, once it exists (always for `from_pool`).
    pub fn pool_handle(&self) -> Option<&PgPool> {
        self.pool.get()
    }

    /// SQL text with every `@@.` replaced by the quoted schema.
    fn s(&self, sql: &str) -> String {
        sql.replace("@@.", &self.prefix)
    }

    fn err(&self, e: sqlx::Error) -> String {
        if matches!(e, sqlx::Error::PoolTimedOut) {
            return unavailable(format!("cannot reach the PostgreSQL server ({}) within {} s", self.target.label, self.ops.acquire_secs));
        }
        let retry = matches!(&e, sqlx::Error::Database(d) if matches!(d.code().as_deref(), Some("40P01" | "40001")));
        let msg = self.target.redact(&e.to_string());
        if retry {
            format!("{RETRY}{msg}")
        } else {
            unavailable(msg)
        }
    }

    async fn pool(&self) -> Result<&PgPool, StoreError> {
        self.pool
            .get_or_try_init(|| async {
                Ok::<_, StoreError>(
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
    async fn ready(&self) -> Result<&PgPool, StoreError> {
        let pool = self.pool().await?;
        if !self.ready.load(Ordering::SeqCst) {
            let mut c = pool.acquire().await.map_err(|e| self.ops.err(e))?;
            let stored = self.ops.schema_version(&mut c).await?;
            version_check(stored, &self.target.schema, SCHEMA_VERSION).map_err(|m| StoreError::Unavailable(unavailable(m)))?;
            self.ready.store(true, Ordering::SeqCst);
        }
        Ok(pool)
    }

    /// A pooled connection (autocommit), after the version check.
    async fn conn(&self) -> Result<PoolConnection<Postgres>, StoreError> {
        self.ready().await?.acquire().await.map_err(|e| self.ops.err(e))
    }

    /// A transaction on the pool, after the version check.
    async fn begin(&self) -> Result<Transaction<'static, Postgres>, StoreError> {
        self.ready().await?.begin().await.map_err(|e| self.ops.err(e))
    }

    /// A REPEATABLE READ READ ONLY transaction (one snapshot for counts and rows).
    async fn snapshot(&self) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut tx = self.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.ops.err(e))?;
        Ok(tx)
    }

    async fn commit(&self, tx: Transaction<'static, Postgres>) -> Result<(), StoreError> {
        tx.commit().await.map_err(|e| self.ops.err(e))
    }

    /// `board_meta.schema_version`, or None when the schema has no board tables.
    async fn stored_version(&self, c: &mut PgConnection) -> Result<Option<i64>, String> {
        self.ops.schema_version(c).await.map_err(String::from)
    }

    /// Board table names that already exist in a schema without `board_meta` (someone else's
    /// tables): the migration must not attach indexes and triggers to them.
    async fn foreign_tables(&self, c: &mut PgConnection) -> Result<Vec<String>, String> {
        self.ops.foreign_tables(c).await.map_err(String::from)
    }

    async fn refuse_foreign(&self, c: &mut PgConnection, stored: Option<i64>) -> Result<(), String> {
        self.ops.refuse_foreign(c, stored).await.map_err(String::from)
    }

    /// Schema version stored in the database (None: no tables), for Settings.
    pub async fn stored_schema_version(&self) -> Result<Option<i64>, String> {
        let mut c = self.pool().await?.acquire().await.map_err(|e| self.err(e))?;
        self.stored_version(&mut c).await
    }

    /// Create / upgrade the tables (Settings button only). `apply` false: only report what
    /// would run. Refused when the database is newer than this app. Runs `CREATE SCHEMA IF NOT
    /// EXISTS` first; a role that may not create schemas uses `migrate_on` on a schema it owns.
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
        if apply && steps.is_empty() {
            sqlx::query(&self.s("INSERT INTO @@.board_meta (key, value) VALUES ('server_uid', $1) ON CONFLICT (key) DO NOTHING"))
                .bind(uuid::Uuid::new_v4().to_string())
                .execute(&mut *c)
                .await
                .map_err(|e| self.err(e))?;
        }
        if !apply || steps.is_empty() {
            return Ok(out);
        }
        let mut tx = c.begin().await.map_err(|e| self.err(e))?;
        let (_, steps) = self.ops.migrate_locked(&mut tx, &self.app_version, true).await?;
        tx.commit().await.map_err(|e| self.err(e))?;
        self.ready.store(false, Ordering::SeqCst);
        out["applied"] = json!(true);
        out["steps"] = Value::Array(describe(&steps));
        Ok(out)
    }

    /// Test connection for Settings: reachable, server version, TLS, schema and its version,
    /// privileges and what to do next. Never fails; problems are in `error` / `next`.
    pub async fn diagnose(target: &PgTarget, app_version: &str) -> Value {
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
        let store = PgStore::new(target.clone(), app_version);
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
                let outbox: &[&str] = if stored.is_some_and(|v| v >= 4) { &["outbox"] } else { &[] };
                for t in ["teams", "posts", "cursors", "tasks", "task_deps", "task_events", "board_meta", "hosts"].iter().chain(outbox) {
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
                    "this user cannot write the board tables: ask for SELECT, INSERT, UPDATE and DELETE on them (hosts and outbox included), USAGE on board_server_seq and board_arrival_seq, and EXECUTE on board_set_server_seq()".to_string()
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
}

// ── The store's own transactions (thin wrappers over `PgOps`) ────────────
//
// Each command: the pure input checks first (as before), then a connection or transaction from
// the store's pool, the `PgOps` operation, commit. Deadlocks and serialization failures retry
// the whole transaction up to 3 times. Errors keep their texts (`StoreError` → `String`).

impl PgStore {
    pub async fn post(&self, team: String, input: PostInput, ctx: Ctx) -> Result<Value, String> {
        retrying!(self.post_tx(&team, &input, &ctx)).map_err(String::from)
    }

    async fn post_tx(&self, team: &str, input: &PostInput, ctx: &Ctx) -> Result<Value, StoreError> {
        PostSpec::check(team, input)?;
        let mut tx = self.begin().await?;
        let out = self.ops.post(&mut tx, team, input, ctx).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// See sqlite::read. A `--new` read holds the team row FOR SHARE, so no post lands between
    /// the rows it returns and the cursor it stores; a plain read is one REPEATABLE READ READ
    /// ONLY snapshot.
    pub async fn read(&self, team: String, q: ReadQuery, host: Option<String>) -> Result<Value, String> {
        retrying!(self.read_tx(&team, &q, host.as_deref())).map_err(String::from)
    }

    async fn read_tx(&self, team: &str, q: &ReadQuery, host: Option<&str>) -> Result<Value, StoreError> {
        let spec = ReadSpec::check(team, q)?;
        let mut tx = if spec.cursor_tab.is_some() { self.begin().await? } else { self.snapshot().await? };
        let out = self.ops.read(&mut tx, team, q, host).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    pub async fn teams(&self) -> Result<Vec<Value>, String> {
        let mut c = self.conn().await?;
        Ok(self.ops.teams(&mut c).await?)
    }

    pub async fn clear(&self, team: String, ctx: Ctx) -> Result<Value, String> {
        retrying!(self.clear_tx(&team, &ctx)).map_err(String::from)
    }

    async fn clear_tx(&self, team: &str, ctx: &Ctx) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let mut tx = self.begin().await?;
        let out = self.ops.clear(&mut tx, team, ctx).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// How many teams "Clean up old teams" would retire now (nothing is changed).
    pub async fn stale_count(&self, now: i64, max_age_ms: i64) -> Result<i64, String> {
        let mut c = self.conn().await?;
        Ok(self.ops.stale_count(&mut c, now, max_age_ms).await?)
    }

    /// "Clean up old teams" (Settings; never automatic on a shared server): tombstone every
    /// team idle for `max_age_ms` with its posts, tasks, dependencies and events (cursors go),
    /// then remove tombstones older than TOMBSTONE_RETENTION_MS. One transaction per team.
    pub async fn prune_stale(&self, now: i64, max_age_ms: i64) -> Result<usize, String> {
        Ok(self.prune_stale_tx(now, max_age_ms).await?)
    }

    async fn prune_stale_tx(&self, now: i64, max_age_ms: i64) -> Result<usize, StoreError> {
        let cutoff = now - max_age_ms;
        let candidates = {
            let mut c = self.conn().await?;
            self.ops.stale_candidates(&mut c, cutoff).await?
        };
        let mut retired = 0usize;
        for uid in &candidates {
            let mut tx = self.begin().await?;
            if !self.ops.retire_team(&mut tx, uid, cutoff, now).await? {
                continue;
            }
            self.commit(tx).await?;
            retired += 1;
        }
        let mut tx = self.begin().await?;
        self.ops.purge_tombstones(&mut tx, now).await?;
        self.commit(tx).await?;
        Ok(retired)
    }

    pub async fn task_write(&self, team: String, op: TaskOpInput, actor: Actor, ctx: Ctx) -> Result<Value, String> {
        retrying!(self.task_write_tx(&team, &op, &actor, &ctx)).map_err(String::from)
    }

    /// One task write (see sqlite::task_write): the team row locked first, lazy lease expiry,
    /// the rule check, a guarded UPDATE and the event, all in one transaction.
    async fn task_write_tx(&self, team: &str, op: &TaskOpInput, actor: &Actor, ctx: &Ctx) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let name = op.op.trim();
        if name == "add" {
            AddSpec::check(op)?;
        } else {
            WriteSpec::check(name, op)?;
        }
        let mut tx = self.begin().await?;
        let out = self.ops.task_write(&mut tx, team, op, actor, ctx).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// Expire leases of one team in its own short write transaction, only when some ran out.
    async fn expire_if_needed_tx(&self, uid: &str, now: i64, host: Option<&str>) -> Result<Vec<Value>, StoreError> {
        let n = {
            let mut c = self.conn().await?;
            self.ops.expired_count(&mut c, uid, now).await?
        };
        if n == 0 {
            return Ok(Vec::new());
        }
        let mut tx = self.begin().await?;
        let out = self.ops.expire_locked(&mut tx, uid, now, host).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    pub async fn task_list(&self, team: String, q: TaskListQuery, ctx: Ctx) -> Result<Value, String> {
        retrying!(self.task_list_tx(&team, &q, &ctx)).map_err(String::from)
    }

    async fn task_list_tx(&self, team: &str, q: &TaskListQuery, ctx: &Ctx) -> Result<Value, StoreError> {
        let spec = ListSpec::check(team, q)?;
        let team_ref = {
            let mut c = self.conn().await?;
            match self.ops.find_team(&mut c, team, ctx.host.as_deref(), Lock::None).await? {
                Some(t) => t,
                None => return Ok(PgOps::no_tasks(team)),
            }
        };
        let expired = self.expire_if_needed_tx(&team_ref.uid, ctx.now, ctx.host.as_deref()).await?;
        let mut tx = self.snapshot().await?;
        let out = self.ops.task_list_rows(&mut tx, team, spec, team_ref, expired, ctx.now).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    pub async fn task_show(&self, team: String, seq: i64, history: bool, stale: Option<i64>, ctx: Ctx) -> Result<Value, String> {
        retrying!(self.task_show_tx(&team, seq, history, stale, &ctx)).map_err(String::from)
    }

    async fn task_show_tx(&self, team: &str, seq: i64, history: bool, stale: Option<i64>, ctx: &Ctx) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let team_ref = {
            let mut c = self.conn().await?;
            self.ops.show_team(&mut c, team, seq, ctx).await?
        };
        let expired = self.expire_if_needed_tx(&team_ref.uid, ctx.now, ctx.host.as_deref()).await?;
        let mut tx = self.snapshot().await?;
        let out = self.ops.task_show_rows(&mut tx, team, &team_ref.uid, seq, history, stale, expired, ctx.now).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// See sqlite::team_events (one REPEATABLE READ READ ONLY snapshot).
    pub async fn team_events(&self, team: String, q: EventsQuery, host: Option<String>) -> Result<Value, String> {
        retrying!(self.team_events_tx(&team, &q, host.as_deref())).map_err(String::from)
    }

    async fn team_events_tx(&self, team: &str, q: &EventsQuery, host: Option<&str>) -> Result<Value, StoreError> {
        check_team(team).map_err(StoreError::Invalid)?;
        let mut tx = self.snapshot().await?;
        let out = self.ops.team_events(&mut tx, team, q, host).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// See sqlite::lease_tick (only the lease columns change; no team lock needed).
    pub async fn lease_tick(&self, instance: String, alive: Vec<String>, now: i64, lease: i64) -> Result<Value, String> {
        Ok(self.lease_tick_tx(&instance, &alive, now, lease).await?)
    }

    async fn lease_tick_tx(&self, instance: &str, alive: &[String], now: i64, lease: i64) -> Result<Value, StoreError> {
        let mut tx = self.begin().await?;
        let out = self.ops.lease_tick(&mut tx, instance, alive, now, lease).await?;
        self.commit(tx).await?;
        Ok(out)
    }

    /// Release one held task (auto_release) in its own transaction, team row first, only while
    /// it is still held through `instance` (and by `owner` when given).
    async fn release_one_tx(&self, id: &str, owner: Option<&str>, instance: &str, now: i64, host: Option<&str>, reason: &str) -> Result<Option<Value>, StoreError> {
        let mut tx = self.begin().await?;
        let out = self.ops.release_one(&mut tx, id, owner, instance, now, host, reason).await?;
        if out.is_some() {
            self.commit(tx).await?;
        }
        Ok(out)
    }

    pub async fn release_owner(&self, instance: String, owner_id: String, now: i64, host: Option<String>, reason: String) -> Result<Value, String> {
        Ok(self.release_owner_tx(&instance, &owner_id, now, host.as_deref(), &reason).await?)
    }

    async fn release_owner_tx(&self, instance: &str, owner_id: &str, now: i64, host: Option<&str>, reason: &str) -> Result<Value, StoreError> {
        let ids = {
            let mut c = self.conn().await?;
            self.ops.held_ids(&mut c, instance, owner_id).await?
        };
        let mut released = Vec::new();
        for id in ids {
            if let Some(v) = retrying!(self.release_one_tx(&id, Some(owner_id), instance, now, host, reason))? {
                released.push(v);
            }
        }
        Ok(json!({ "released": released }))
    }

    pub async fn lease_holders(&self, instance: String) -> Result<Vec<String>, String> {
        let mut c = self.conn().await?;
        Ok(self.ops.lease_holders(&mut c, &instance).await?)
    }

    pub async fn held_on_host(&self, host: String) -> Result<Vec<Value>, String> {
        let mut c = self.conn().await?;
        Ok(self.ops.held_on_host(&mut c, &host).await?)
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
        Ok(self.lease_apply_tx(&instance, &adopt, &release, now, lease, host.as_deref()).await?)
    }

    async fn lease_apply_tx(
        &self,
        instance: &str,
        adopt: &[LeaseItem],
        release: &[LeaseItem],
        now: i64,
        lease: i64,
        host: Option<&str>,
    ) -> Result<Value, StoreError> {
        let pool = self.ready().await?;
        let mut adopted = 0u64;
        for a in adopt {
            let mut c = pool.acquire().await.map_err(|e| self.ops.err(e))?;
            adopted += self.ops.adopt_one(&mut c, instance, a, now, lease).await?;
        }
        let mut released = Vec::new();
        for r in release {
            if let Some(v) = retrying!(self.release_one_tx(&r.id, None, &r.instance, now, host, PgOps::NOT_BACK))? {
                released.push(v);
            }
        }
        Ok(json!({ "adopted": adopted, "released": released }))
    }

    /// Live teams, posts and tasks (status line).
    pub async fn counts(&self) -> Result<Value, String> {
        let mut c = self.conn().await?;
        Ok(self.ops.counts(&mut c).await?)
    }

    /// Every live row of every live team (Copy data), from one snapshot.
    pub async fn export_dump(&self) -> Result<Dump, String> {
        Ok(self.export_dump_tx().await?)
    }

    async fn export_dump_tx(&self) -> Result<Dump, StoreError> {
        let mut tx = self.snapshot().await?;
        let dump = self.ops.export_dump(&mut tx).await?;
        self.commit(tx).await?;
        Ok(dump)
    }

    /// Insert a dump (Copy data): refused unless the board has no live team or `merge` is set;
    /// teams it already has are skipped, tombstoned teams in the way are removed for good.
    /// One transaction; rows go in multi-row INSERTs of up to IMPORT_CHUNK rows.
    pub async fn import_dump(&self, dump: Dump, merge: bool) -> Result<Value, String> {
        Ok(self.import_dump_tx(dump, merge).await?)
    }

    async fn import_dump_tx(&self, dump: Dump, merge: bool) -> Result<Value, StoreError> {
        let mut tx = self.begin().await?;
        let out = self.ops.import_dump(&mut tx, dump, merge).await?;
        self.commit(tx).await?;
        Ok(out)
    }
}


// ── Sync (stage 3b; the orchestration lives in sync.rs) ─────────────────

/// What one push batch did on the server.
#[derive(Debug, Default, Clone)]
pub struct PushOutcome {
    pub written: u64,
    pub refused: u64,
    pub reason: Option<String>,
    /// Teams in the batch whose home on the server is now another computer (taken over):
    /// (uid, new home). Their rows were not written and are counted in `refused`.
    pub moved: Vec<(String, String)>,
    /// This installation no longer holds its name on the server: nothing was written.
    pub replaced: bool,
}

/// Primary key columns of a synced table.
fn sync_pk(table: &str) -> &'static [&'static str] {
    match table {
        "teams" => &["uid"],
        "task_deps" => &["task_id", "depends_on_id"],
        _ => &["id"],
    }
}

fn bind_cells<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    row: &[Cell],
    cols: Cols,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for (cell, (_, kind)) in row.iter().zip(cols.iter()) {
        q = match (cell, kind) {
            (Cell::Int(v), _) => q.bind(*v),
            (Cell::Text(v), _) => q.bind(v.clone()),
            (Cell::Null, Kind::Int) => q.bind(None::<i64>),
            (Cell::Null, Kind::Text) => q.bind(None::<String>),
        };
    }
    q
}

impl PgStore {
    /// Close the pool (sync stopped or its server changed); a caller's pool (`from_pool`) stays open.
    pub async fn close(&self) {
        if !self.owns_pool {
            return;
        }
        if let Some(p) = self.pool.get() {
            p.close().await;
        }
    }

    fn cells(&self, r: &PgRow, cols: Cols) -> Result<Vec<Cell>, String> {
        let mut cells = Vec::with_capacity(cols.len());
        for (i, (_, kind)) in cols.iter().enumerate() {
            cells.push(match kind {
                Kind::Int => r.try_get::<Option<i64>, _>(i).map_err(|e| self.err(e))?.map_or(Cell::Null, Cell::Int),
                Kind::Text => r.try_get::<Option<String>, _>(i).map_err(|e| self.err(e))?.map_or(Cell::Null, Cell::Text),
            });
        }
        Ok(cells)
    }

    /// Register this machine in `hosts` (first sync) or find who holds its name. Returns the
    /// other instance id when the name belongs to another machine.
    pub async fn sync_register(&self, host: &str, instance: &str) -> Result<Option<String>, String> {
        let pool = self.pool().await?;
        sqlx::query(&self.s(&format!(
            "INSERT INTO @@.hosts (host, instance_id, first_seen, last_seen, app_version) VALUES ($1, $2, {SERVER_NOW_MS}, {SERVER_NOW_MS}, $3)
             ON CONFLICT (host) DO NOTHING",
        )))
        .bind(host)
        .bind(instance)
        .bind(&self.app_version)
        .execute(pool)
        .await
        .map_err(|e| self.err(e))?;
        let owner: String = sqlx::query_scalar(&self.s("SELECT instance_id FROM @@.hosts WHERE host = $1"))
            .bind(host)
            .fetch_one(pool)
            .await
            .map_err(|e| self.err(e))?;
        if owner != instance {
            return Ok(Some(owner));
        }
        // Every round says this computer is alive (takeover guards read last_seen).
        sqlx::query(&self.s(&format!("UPDATE @@.hosts SET last_seen = {SERVER_NOW_MS}, app_version = $3 WHERE host = $1 AND instance_id = $2")))
            .bind(host)
            .bind(instance)
            .bind(&self.app_version)
            .execute(pool)
            .await
            .map_err(|e| self.err(e))?;
        Ok(None)
    }

    /// Push one batch of this computer's rows in one transaction, parents before children. Each
    /// row is an upsert that only replaces an older `row_version` of the same team (so a batch
    /// sent twice changes nothing); new posts get this server's read order. The server_seq
    /// trigger takes the shared writer lock (see `v3_sql`). A chunk that fails is retried row by
    /// row, each under a savepoint: a row the server still refuses (a clash with a unique rule)
    /// is counted and the batch goes on. Rows the server ignored because it holds a newer
    /// version (or the id belongs to another team) are counted as refused too.
    pub async fn sync_push(&self, host: &str, instance: &str, rows: &Dump, now: i64) -> Result<PushOutcome, String> {
        let pool = self.pool().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let mut out = PushOutcome::default();
        // Stage 3c: this installation must still hold its name (a restore elsewhere may have
        // replaced it). The row is held FOR SHARE until commit, so a takeover waits for an
        // in-flight push, and a push after the takeover writes nothing.
        let holds: Option<i32> = sqlx::query_scalar(&self.s("SELECT 1 FROM @@.hosts WHERE host = $1 AND instance_id = $2 FOR SHARE"))
            .bind(host)
            .bind(instance)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        if holds.is_none() {
            let _ = tx.rollback().await;
            out.replaced = true;
            return Ok(out);
        }
        // Stage 3c: a team whose home on the server is now another computer (it was taken over
        // while this one was away) gets nothing from here. The team rows are read FOR SHARE, so
        // a takeover committing meanwhile is either seen here or waits for this push.
        let batch_uids: Vec<String> = {
            let mut v: Vec<String> = Vec::new();
            for (table, cols) in super::sync_core::SYNC_TABLES {
                let i = copy::col_index(cols, if table == "teams" { "uid" } else { "team_uid" });
                for r in rows.rows(table) {
                    if let Some(u) = r[i].text() {
                        if !v.iter().any(|x| x == u) {
                            v.push(u.to_string());
                        }
                    }
                }
            }
            v
        };
        let homes: Vec<(String, Option<String>)> = sqlx::query_as(&self.s("SELECT uid, home_host FROM @@.teams WHERE uid = ANY($1) FOR SHARE"))
            .bind(&batch_uids)
            .fetch_all(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        let moved: std::collections::HashMap<String, String> =
            homes.into_iter().filter(|(_, h)| h.as_deref() != Some(host)).map(|(u, h)| (u, h.unwrap_or_default())).collect();
        out.moved = moved.iter().map(|(u, h)| (u.clone(), h.clone())).collect();
        out.moved.sort();
        let filtered: Dump;
        let rows = if moved.is_empty() {
            rows
        } else {
            let mut d = Dump::default();
            for (table, cols) in super::sync_core::SYNC_TABLES {
                let i = copy::col_index(cols, if table == "teams" { "uid" } else { "team_uid" });
                for r in rows.rows(table) {
                    match r[i].text().and_then(|u| moved.get(u)) {
                        Some(home) => {
                            out.refused += 1;
                            if out.reason.is_none() {
                                out.reason = Some(super::sync_core::moved_message(home));
                            }
                        }
                        None => d.rows_mut(table).push(r.clone()),
                    }
                }
            }
            filtered = d;
            &filtered
        };
        for (table, cols) in super::sync_core::SYNC_TABLES {
            let rows = rows.rows(table);
            if rows.is_empty() {
                continue;
            }
            if table == "teams" {
                // This computer's own retired team with the same root id (purged here after it was
                // sent) is in the way of the new one: removed for good, as Copy data does.
                for row in rows {
                    let (uid, team, home) = (
                        row[copy::col_index(cols, "uid")].text().unwrap_or_default(),
                        row[copy::col_index(cols, "team")].text().unwrap_or_default(),
                        row[copy::col_index(cols, "home_host")].text(),
                    );
                    let old: Vec<String> = sqlx::query_scalar(&self.s(
                        "SELECT uid FROM @@.teams WHERE team = $1 AND home_host IS NOT DISTINCT FROM $2 AND uid <> $3 AND deleted_at IS NOT NULL",
                    ))
                    .bind(team)
                    .bind(home)
                    .bind(uid)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(|e| self.err(e))?;
                    if old.is_empty() {
                        continue;
                    }
                    for t in copy::PURGE_TABLES {
                        sqlx::query(&self.s(&format!("DELETE FROM @@.{t} WHERE team_uid = ANY($1)")))
                            .bind(&old)
                            .execute(&mut *tx)
                            .await
                            .map_err(|e| self.err(e))?;
                    }
                    sqlx::query(&self.s("DELETE FROM @@.teams WHERE uid = ANY($1)")).bind(&old).execute(&mut *tx).await.map_err(|e| self.err(e))?;
                }
            }
            let pk = sync_pk(table);
            let names = copy::col_list(cols);
            let set = cols
                .iter()
                .filter(|(c, _)| !pk.contains(c))
                .map(|(c, _)| format!("{c} = excluded.{c}"))
                .collect::<Vec<_>>()
                .join(", ");
            let same_team =
                if table == "teams" { "t.home_host IS NOT DISTINCT FROM excluded.home_host" } else { "t.team_uid = excluded.team_uid" };
            let posts = table == "posts";
            let sql_for = |n_rows: usize| {
                let mut n = 0usize;
                let values: Vec<String> = (0..n_rows)
                    .map(|_| {
                        let mut ps: Vec<String> = (0..cols.len())
                            .map(|_| {
                                n += 1;
                                format!("${n}")
                            })
                            .collect();
                        if posts {
                            ps.push("nextval('@@.board_arrival_seq')".into());
                        }
                        format!("({})", ps.join(", "))
                    })
                    .collect();
                self.s(&format!(
                    "INSERT INTO @@.{table} AS t ({names}{}) VALUES {} ON CONFLICT ({}) DO UPDATE SET {set}
                     WHERE t.row_version < excluded.row_version AND {same_team}",
                    if posts { ", arrival" } else { "" },
                    values.join(", "),
                    pk.join(", ")
                ))
            };
            for chunk in rows.chunks(IMPORT_CHUNK) {
                sqlx::query("SAVEPOINT push_chunk").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                let chunk_sql = sql_for(chunk.len());
                let mut q = sqlx::query(&chunk_sql);
                for row in chunk {
                    q = bind_cells(q, row, cols);
                }
                match q.execute(&mut *tx).await {
                    Ok(r) => {
                        sqlx::query("RELEASE SAVEPOINT push_chunk").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                        out.written += r.rows_affected();
                        if (r.rows_affected() as usize) < chunk.len() {
                            self.count_ignored(&mut tx, table, cols, chunk, &mut out).await?;
                        }
                    }
                    Err(_) => {
                        sqlx::query("ROLLBACK TO SAVEPOINT push_chunk").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                        let one = sql_for(1);
                        for row in chunk {
                            sqlx::query("SAVEPOINT push_row").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                            match bind_cells(sqlx::query(&one), row, cols).execute(&mut *tx).await {
                                Ok(r) => {
                                    sqlx::query("RELEASE SAVEPOINT push_row").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                                    out.written += r.rows_affected();
                                    if r.rows_affected() == 0 {
                                        self.count_ignored(&mut tx, table, cols, std::slice::from_ref(row), &mut out).await?;
                                    }
                                }
                                Err(e) => {
                                    // A connection-level failure is not the row's fault: give up.
                                    if !matches!(e, sqlx::Error::Database(_)) {
                                        return Err(self.err(e));
                                    }
                                    sqlx::query("ROLLBACK TO SAVEPOINT push_row").execute(&mut *tx).await.map_err(|e| self.err(e))?;
                                    out.refused += 1;
                                    if out.reason.is_none() {
                                        out.reason = Some(clean_err(self.err(e)).trim_start_matches("team board unavailable: ").to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        let _ = now;
        sqlx::query(&self.s(&format!("UPDATE @@.hosts SET last_seen = {SERVER_NOW_MS}, app_version = $2 WHERE host = $1 AND instance_id = $3")))
            .bind(host)
            .bind(&self.app_version)
            .bind(instance)
            .execute(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(out)
    }

    /// Rows of `chunk` the upsert left alone: the same version again is fine (a batch sent
    /// twice); a newer version on the server, or the id held by another team, is refused.
    async fn count_ignored(&self, c: &mut PgConnection, table: &str, cols: Cols, chunk: &[Vec<Cell>], out: &mut PushOutcome) -> Result<(), String> {
        let pk = sync_pk(table);
        let team = if table == "teams" { "home_host" } else { "team_uid" };
        let where_pk = pk.iter().enumerate().map(|(i, k)| format!("{k} = ${}", i + 1)).collect::<Vec<_>>().join(" AND ");
        let sql = self.s(&format!("SELECT row_version, {team} FROM @@.{table} WHERE {where_pk}"));
        for row in chunk {
            let mut q = sqlx::query_as::<_, (i64, Option<String>)>(&sql);
            for k in pk {
                q = q.bind(row[copy::col_index(cols, k)].text().unwrap_or_default().to_string());
            }
            let Some((stored, owner)) = q.fetch_optional(&mut *c).await.map_err(|e| self.err(e))? else { continue };
            let sent = row[copy::col_index(cols, "row_version")].int().unwrap_or(0);
            let mine = row[copy::col_index(cols, team)].text().map(str::to_string);
            if stored > sent || owner != mine {
                out.refused += 1;
                if out.reason.is_none() {
                    out.reason = Some(if owner != mine {
                        format!("a {table} row with the same id belongs to another team on the server")
                    } else {
                        format!("the server has a newer version of a {table} row (it was changed there directly)")
                    });
                }
            }
        }
        Ok(())
    }

    /// The highest server_seq a pull may read: taken under the exclusive server_seq lock, so
    /// every transaction that drew a number up to it has ended (committed or rolled back). The
    /// lock is only tried (writers never queue behind a waiting pull): None when writers kept it
    /// for 3 s ("busy"). `pg_sequence_last_value` needs only USAGE on the sequence.
    pub async fn sync_watermark(&self) -> Result<Option<i64>, String> {
        let pool = self.pool().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let got: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
                .bind(seq_lock_key(&self.target.schema))
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            if got {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = tx.rollback().await;
                return Ok(None);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let last: Option<i64> = sqlx::query_scalar("SELECT pg_sequence_last_value($1::regclass)")
            .bind(format!("{}board_server_seq", self.prefix))
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(Some(last.unwrap_or(0)))
    }

    /// Rows of teams homed on other machines with `after < server_seq <= upto`, per table in
    /// server_seq order, at most `limit` per table, in one snapshot. Also the team rows that a
    /// returned child references but the batch lacks. Returns the rows and, per table in
    /// `SYNC_TABLES` order, (rows returned, last server_seq).
    pub async fn sync_pull(&self, host: &str, after: i64, upto: i64, limit: i64) -> Result<(Dump, Vec<(usize, Option<i64>)>), String> {
        let pool = self.pool().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let mut dump = Dump::default();
        let mut stats = Vec::new();
        for (table, cols) in super::sync_core::SYNC_TABLES {
            let list = cols.iter().map(|(n, _)| format!("x.{n}")).collect::<Vec<_>>().join(", ");
            let elsewhere = if table == "teams" {
                "x.home_host IS DISTINCT FROM $3".to_string()
            } else {
                "EXISTS (SELECT 1 FROM @@.teams tm WHERE tm.uid = x.team_uid AND tm.home_host IS DISTINCT FROM $3)".to_string()
            };
            let sql = self.s(&format!(
                "SELECT {list}, x.server_seq FROM @@.{table} x WHERE x.server_seq > $1 AND x.server_seq <= $2 AND {elsewhere}
                 ORDER BY x.server_seq LIMIT $4"
            ));
            let rows = sqlx::query(&sql).bind(after).bind(upto).bind(host).bind(limit).fetch_all(&mut *tx).await.map_err(|e| self.err(e))?;
            let mut last = None;
            let out = dump.rows_mut(table);
            for r in &rows {
                out.push(self.cells(r, cols)?);
                last = Some(r.try_get::<i64, _>(cols.len()).map_err(|e| self.err(e))?);
            }
            stats.push((rows.len(), last));
        }
        let have: std::collections::HashSet<String> =
            dump.teams.iter().filter_map(|r| r.first().and_then(|c| c.text()).map(str::to_string)).collect();
        let mut missing: Vec<String> = Vec::new();
        for (table, cols) in super::sync_core::SYNC_TABLES.iter().skip(1) {
            let i = copy::col_index(cols, "team_uid");
            for r in dump.rows(table) {
                if let Some(uid) = r[i].text() {
                    if !have.contains(uid) && !missing.iter().any(|m| m == uid) {
                        missing.push(uid.to_string());
                    }
                }
            }
        }
        if !missing.is_empty() {
            let list = copy::col_list(copy::TEAMS);
            let rows = sqlx::query(&self.s(&format!("SELECT {list} FROM @@.teams WHERE uid = ANY($1) AND home_host IS DISTINCT FROM $2")))
                .bind(&missing)
                .bind(host)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            for r in &rows {
                dump.teams.push(self.cells(r, copy::TEAMS)?);
            }
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok((dump, stats))
    }
}

// ── Stage 3c: restore, take over a team, remote notes (orchestration in sync_core.rs) ──

/// The outbox row both engines exchange (defined with the sync rules).
pub use super::sync_core::OutboxNote;

/// Why a takeover was refused on the server: (stable code, English message).
pub type Refused = (&'static str, String);

impl PgStore {
    /// This server's identity and the last value of its `board_server_seq`. The uid is
    /// `board_meta.server_uid`: written when the tables are created (and by "Create / upgrade
    /// tables"); a server made before it existed gets one here, on the first round, with
    /// `INSERT … ON CONFLICT DO NOTHING` (no table change; `board_meta` INSERT is already part
    /// of the privilege check), and two computers doing it at once read the same winner.
    pub async fn sync_identity(&self) -> Result<(String, i64), String> {
        let pool = self.pool().await?;
        sqlx::query(&self.s("INSERT INTO @@.board_meta (key, value) VALUES ('server_uid', $1) ON CONFLICT (key) DO NOTHING"))
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(pool)
            .await
            .map_err(|e| self.err(e))?;
        let uid: Option<String> = sqlx::query_scalar(&self.s("SELECT value FROM @@.board_meta WHERE key = 'server_uid'"))
            .fetch_one(pool)
            .await
            .map_err(|e| self.err(e))?;
        let last: Option<i64> = sqlx::query_scalar("SELECT pg_sequence_last_value($1::regclass)")
            .bind(format!("{}board_server_seq", self.prefix))
            .fetch_one(pool)
            .await
            .map_err(|e| self.err(e))?;
        Ok((uid.unwrap_or_default(), last.unwrap_or(0)))
    }

    /// Every registered computer: (host, instance_id, last_seen, age by the server's clock).
    pub async fn sync_hosts(&self) -> Result<Vec<(String, String, i64, i64)>, String> {
        let pool = self.pool().await?;
        sqlx::query_as(&self.s(&format!("SELECT host, instance_id, last_seen, {SERVER_NOW_MS} - last_seen FROM @@.hosts ORDER BY host")))
            .fetch_all(pool)
            .await
            .map_err(|e| self.err(e))
    }

    /// Was `instance` replaced on name `host` by a restore (version-4 tables only)?
    pub async fn replaced_by_restore(&self, host: &str, instance: &str) -> Result<bool, String> {
        let pool = self.pool().await?;
        let r: Option<Option<String>> = sqlx::query_scalar(&self.s("SELECT replaced_instance FROM @@.hosts WHERE host = $1"))
            .bind(host)
            .fetch_optional(pool)
            .await
            .map_err(|e| self.err(e))?;
        Ok(r.flatten().as_deref() == Some(instance))
    }

    /// The server's home and row_version of the teams `uids` (missing ones are left out).
    /// Also: how long ago (server clock) the home was last heard of — the largest of its
    /// `hosts.last_seen`, the team's `last_activity_at` and `updated_at` — and `last_seen`.
    #[allow(clippy::type_complexity)]
    pub async fn team_homes(&self, uids: &[String]) -> Result<Vec<(String, Option<String>, i64, Option<i64>, i64, Option<i64>)>, String> {
        let pool = self.pool().await?;
        sqlx::query_as(&self.s(&format!(
            "SELECT t.uid, t.home_host, t.row_version, t.deleted_at,
                    {SERVER_NOW_MS} - greatest(coalesce(h.last_seen, 0), t.last_activity_at, t.updated_at), h.last_seen
             FROM @@.teams t LEFT JOIN @@.hosts h ON h.host = t.home_host WHERE t.uid = ANY($1)"
        )))
            .bind(uids)
            .fetch_all(pool)
            .await
            .map_err(|e| self.err(e))
    }

    /// Live teams homed on `host` (uids).
    pub async fn teams_homed_on(&self, host: &str) -> Result<Vec<String>, String> {
        let pool = self.pool().await?;
        sqlx::query_scalar(&self.s("SELECT uid FROM @@.teams WHERE home_host = $1 AND deleted_at IS NULL")).bind(host).fetch_all(pool).await.map_err(|e| self.err(e))
    }

    /// Live teams homed on `host`, with their live tasks and notes (the restore preview).
    pub async fn restore_counts(&self, host: &str) -> Result<(i64, i64, i64), String> {
        let pool = self.pool().await?;
        sqlx::query_as(&self.s(
            "SELECT (SELECT count(*) FROM @@.teams WHERE home_host = $1 AND deleted_at IS NULL),
                    (SELECT count(*) FROM @@.tasks x JOIN @@.teams t ON t.uid = x.team_uid
                      WHERE t.home_host = $1 AND t.deleted_at IS NULL AND x.deleted_at IS NULL),
                    (SELECT count(*) FROM @@.posts x JOIN @@.teams t ON t.uid = x.team_uid
                      WHERE t.home_host = $1 AND t.deleted_at IS NULL AND x.deleted_at IS NULL)",
        ))
        .bind(host)
        .fetch_one(pool)
        .await
        .map_err(|e| self.err(e))
    }

    /// Every row (tombstones included) of the live teams homed on `home`, or of the teams
    /// `uids`, in one snapshot; posts in the server's read order.
    pub async fn sync_fetch_teams(&self, home: Option<&str>, uids: &[String]) -> Result<Dump, String> {
        let pool = self.pool().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await.map_err(|e| self.err(e))?;
        let team_uids: Vec<String> = match home {
            Some(h) => sqlx::query_scalar(&self.s("SELECT uid FROM @@.teams WHERE home_host = $1 AND deleted_at IS NULL"))
                .bind(h)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| self.err(e))?,
            None => uids.to_vec(),
        };
        let mut dump = Dump::default();
        for (table, cols) in super::sync_core::SYNC_TABLES {
            let key = if table == "teams" { "uid" } else { "team_uid" };
            let order = if table == "posts" { "arrival" } else { "server_seq" };
            let sql = self.s(&format!("SELECT {} FROM @@.{table} WHERE {key} = ANY($1) ORDER BY {order}", copy::col_list(cols)));
            let rows = sqlx::query(&sql).bind(&team_uids).fetch_all(&mut *tx).await.map_err(|e| self.err(e))?;
            for r in &rows {
                dump.rows_mut(table).push(self.cells(r, cols)?);
            }
        }
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(dump)
    }

    /// Restore on a new installation: the name `host` moves from instance `old` to `new`, only
    /// while `old` still holds it and was last seen at least `min_age_ms` ago (a computer that
    /// is still syncing is never impersonated). False when either guard failed.
    pub async fn take_over_host(&self, host: &str, old: &str, new: &str, min_age_ms: i64, v4: bool) -> Result<bool, String> {
        let pool = self.pool().await?;
        let mark = if v4 { ", replaced_instance = $2" } else { "" };
        let r = sqlx::query(&self.s(&format!(
            "UPDATE @@.hosts SET instance_id = $3, last_seen = {SERVER_NOW_MS}, app_version = $5{mark}
             WHERE host = $1 AND instance_id = $2 AND last_seen <= {SERVER_NOW_MS} - $4",
        )))
        .bind(host)
        .bind(old)
        .bind(new)
        .bind(min_age_ms)
        .bind(&self.app_version)
        .execute(pool)
        .await
        .map_err(|e| self.err(e))?;
        Ok(r.rows_affected() == 1)
    }

    /// "Take over this team": one transaction that moves team `uid` to (`host`, `instance`)
    /// only while its home is still `expect_home` at `expect_version` (the values the person
    /// confirmed) and that home was last seen at least `min_age_ms` ago. The team row is
    /// locked FOR UPDATE, so of two computers adopting at once exactly one succeeds; the
    /// row_version bump draws a server_seq under the shared writer lock (trigger), so the old
    /// home and every copy pull the change. Returns the new row_version, or a refusal.
    #[allow(clippy::too_many_arguments)]
    pub async fn adopt_team(
        &self,
        uid: &str,
        expect_home: &str,
        expect_version: i64,
        host: &str,
        instance: &str,
        min_age_ms: i64,
    ) -> Result<Result<i64, Refused>, String> {
        let pool = self.pool().await?;
        let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
        let row: Option<(String, Option<String>, i64, Option<i64>, i64)> = sqlx::query_as(&self.s(
            "SELECT team, home_host, row_version, deleted_at, greatest(last_activity_at, updated_at) FROM @@.teams WHERE uid = $1 FOR UPDATE",
        ))
        .bind(uid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        let Some((team, home, version, deleted, activity)) = row else {
            return Ok(Err(("team_gone", "the team is no longer on the server".into())));
        };
        if deleted.is_some() {
            return Ok(Err(("team_gone", "the team is no longer on the server".into())));
        }
        let home = home.unwrap_or_default();
        if home == host {
            return Ok(Err(("already_home", "this team already lives on this computer".into())));
        }
        if home != expect_home || version != expect_version {
            return Ok(Err(("changed", format!("the team changed on the server (it now lives on {home}); look again before taking it over"))));
        }
        // Server clock; the latest sign of life is the home's last sync or the team's own last
        // change, whichever is later (a team still changing is never taken).
        let (seen, server_now): (Option<i64>, i64) =
            sqlx::query_as(&self.s(&format!("SELECT (SELECT last_seen FROM @@.hosts WHERE host = $1), {SERVER_NOW_MS}")))
                .bind(&home)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
        let seen = seen.unwrap_or(0).max(activity);
        if server_now - seen < min_age_ms {
            return Ok(Err(("home_alive", format!("{home} was seen less than {} hours ago; it may still be working on this team", min_age_ms / 3_600_000))));
        }
        let clash: Option<Option<i64>> = sqlx::query_scalar(&self.s("SELECT deleted_at FROM @@.teams WHERE team = $1 AND home_host = $2 AND uid <> $3"))
            .bind(&team)
            .bind(host)
            .bind(uid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| self.err(e))?;
        match clash {
            Some(None) => return Ok(Err(("same_team_here", "this computer already has a live team for the same tab".into()))),
            Some(Some(_)) => {
                // This computer's own retired team with the same root id: removed for good (as a push does).
                let old: Vec<String> = sqlx::query_scalar(&self.s("SELECT uid FROM @@.teams WHERE team = $1 AND home_host = $2 AND uid <> $3"))
                    .bind(&team)
                    .bind(host)
                    .bind(uid)
                    .fetch_all(&mut *tx)
                    .await
                    .map_err(|e| self.err(e))?;
                for t in copy::PURGE_TABLES {
                    sqlx::query(&self.s(&format!("DELETE FROM @@.{t} WHERE team_uid = ANY($1)"))).bind(&old).execute(&mut *tx).await.map_err(|e| self.err(e))?;
                }
                sqlx::query(&self.s("DELETE FROM @@.teams WHERE uid = ANY($1)")).bind(&old).execute(&mut *tx).await.map_err(|e| self.err(e))?;
            }
            None => {}
        }
        let next: Option<i64> = sqlx::query_scalar(&self.s(
            "UPDATE @@.teams SET home_host = $2, home_instance = $3, origin_host = $2, updated_at = $4, row_version = row_version + 1
             WHERE uid = $1 AND home_host = $5 AND row_version = $6 RETURNING row_version",
        ))
        .bind(uid)
        .bind(host)
        .bind(instance)
        .bind(server_now)
        .bind(&home)
        .bind(version)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| self.err(e))?;
        let Some(next) = next else {
            return Ok(Err(("changed", "the team changed on the server; look again before taking it over".into())));
        };
        tx.commit().await.map_err(|e| self.err(e))?;
        Ok(Ok(next))
    }

    /// Send notes to the outbox. Idempotent by id: a note already there is reported as stored.
    /// Each note is checked under a per-team lock: the team must be live with another home than
    /// the sender, and the pending caps per team and per sending computer must have room.
    /// Returns per note None (stored) or a refusal code.
    pub async fn outbox_send(&self, instance: &str, notes: &[OutboxNote], per_team: i64, per_computer: i64) -> Result<Vec<(String, Option<&'static str>)>, String> {
        let pool = self.pool().await?;
        let mut out = Vec::new();
        for n in notes {
            let mut tx = pool.begin().await.map_err(|e| self.err(e))?;
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("bbarit-board-outbox:{}:{}", self.target.schema, n.team_uid))
                .execute(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            let there: bool = sqlx::query_scalar(&self.s("SELECT EXISTS (SELECT 1 FROM @@.outbox WHERE id = $1)"))
                .bind(&n.id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            if there {
                tx.commit().await.map_err(|e| self.err(e))?;
                out.push((n.id.clone(), None));
                continue;
            }
            // A note for the sender's own team (it took the team over after queuing it) is
            // stored too: the sender, now the home, delivers it like any other.
            let home: Option<(Option<String>, Option<i64>)> = sqlx::query_as(&self.s("SELECT home_host, deleted_at FROM @@.teams WHERE uid = $1"))
                .bind(&n.team_uid)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            let refusal = match home {
                None | Some((_, Some(_))) => Some("team_gone"),
                _ => {
                    let (team_n, mine_n): (i64, i64) = sqlx::query_as(&self.s(
                        "SELECT (SELECT count(*) FROM @@.outbox WHERE team_uid = $1 AND state = 'pending'),
                                (SELECT count(*) FROM @@.outbox WHERE from_instance = $2 AND state = 'pending')",
                    ))
                    .bind(&n.team_uid)
                    .bind(instance)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|e| self.err(e))?;
                    if team_n >= per_team {
                        Some("team_full")
                    } else if mine_n >= per_computer {
                        Some("computer_full")
                    } else {
                        None
                    }
                }
            };
            if refusal.is_none() {
                sqlx::query(&self.s(
                    "INSERT INTO @@.outbox (id, team_uid, from_host, from_instance, author_id, author_name, author_cli, kind, text, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING",
                ))
                .bind(&n.id)
                .bind(&n.team_uid)
                .bind(&n.from_host)
                .bind(instance)
                .bind(&n.author_id)
                .bind(&n.author_name)
                .bind(&n.author_cli)
                .bind(&n.kind)
                .bind(&n.text)
                .bind(n.created_at)
                .execute(&mut *tx)
                .await
                .map_err(|e| self.err(e))?;
            }
            tx.commit().await.map_err(|e| self.err(e))?;
            out.push((n.id.clone(), refusal));
        }
        Ok(out)
    }

    /// The server's state of sent notes: (id, state, reason); ids the server does not have are
    /// left out.
    pub async fn outbox_states(&self, ids: &[String]) -> Result<Vec<(String, String, Option<String>)>, String> {
        let pool = self.pool().await?;
        sqlx::query_as(&self.s("SELECT id, state, reason FROM @@.outbox WHERE id = ANY($1)")).bind(ids).fetch_all(pool).await.map_err(|e| self.err(e))
    }

    /// The poster gives up on a note the home has not taken yet. False: the home already took it.
    pub async fn outbox_withdraw(&self, id: &str, now: i64) -> Result<bool, String> {
        let pool = self.pool().await?;
        let r = sqlx::query(&self.s("UPDATE @@.outbox SET state = 'withdrawn', reason = 'expired', handled_at = $2 WHERE id = $1 AND state = 'pending'"))
            .bind(id)
            .bind(now)
            .execute(pool)
            .await
            .map_err(|e| self.err(e))?;
        Ok(r.rows_affected() == 1)
    }

    /// Notes waiting for teams homed on `host` (oldest first).
    pub async fn inbox_pending(&self, host: &str, limit: i64) -> Result<Vec<OutboxNote>, String> {
        let pool = self.pool().await?;
        #[allow(clippy::type_complexity)]
        let rows: Vec<(String, String, String, String, Option<String>, Option<String>, String, String, i64, bool, bool)> = sqlx::query_as(&self.s(
            "SELECT o.id, o.team_uid, o.from_host, o.author_id, o.author_name, o.author_cli, o.kind, o.text, o.created_at,
                    t.deleted_at IS NOT NULL,
                    EXISTS (SELECT 1 FROM @@.hosts h WHERE h.host = o.from_host AND h.instance_id = o.from_instance)
             FROM @@.outbox o JOIN @@.teams t ON t.uid = o.team_uid
             WHERE o.state = 'pending' AND t.home_host = $1 ORDER BY o.created_at, o.id LIMIT $2",
        ))
        .bind(host)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| self.err(e))?;
        Ok(rows
            .into_iter()
            .map(|(id, team_uid, from_host, author_id, author_name, author_cli, kind, text, created_at, team_deleted, sender_known)| OutboxNote {
                team_deleted,
                sender_known,
                id,
                team_uid,
                from_host,
                author_id,
                author_name,
                author_cli,
                kind,
                text,
                created_at,
            })
            .collect())
    }

    /// The home's verdicts: (id, `delivered`|`refused`, reason code). Only a note still pending
    /// changes (a withdrawn one stays withdrawn).
    pub async fn inbox_mark(&self, results: &[(String, &'static str, Option<&'static str>)], now: i64) -> Result<(), String> {
        let pool = self.pool().await?;
        for (id, state, reason) in results {
            sqlx::query(&self.s("UPDATE @@.outbox SET state = $2, reason = $3, handled_at = $4 WHERE id = $1 AND state = 'pending'"))
                .bind(id)
                .bind(*state)
                .bind(*reason)
                .bind(now)
                .execute(pool)
                .await
                .map_err(|e| self.err(e))?;
        }
        Ok(())
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
        assert_eq!(steps.len(), 3, "version 2 creates, version 3 adds the late-commit lock, version 4 the outbox");
        assert!(steps[2].sql[0].starts_with("CREATE TABLE IF NOT EXISTS \"team_board\".outbox "));
        assert!(steps[1].sql[0].contains("pg_advisory_xact_lock_shared(hashtext('bbarit-board-seq:' || TG_TABLE_SCHEMA))"));
        assert!(steps[1].sql[0].contains("nextval('\"team_board\".board_server_seq')"));
        assert_eq!(migration_steps("team_board", Some(2)).unwrap().iter().map(|s| s.version).collect::<Vec<_>>(), vec![3, 4]);
        // A version-3 server still serves `postgres` mode; version 2 must be upgraded.
        assert!(version_check(Some(3), "s", 4).is_ok());
        assert!(version_check(Some(2), "s", 4).unwrap_err().contains("version 2, this app needs 4"));
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
