//! `BoardStore`: the one interface every board operation goes through. Enum dispatch over
//! the engines (SQLite, PostgreSQL); every method is async. The SQLite variant moves its owned
//! arguments onto the blocking pool; the PostgreSQL variant (sqlx) is natively async.
//!
//! Contract for every implementation (the shared behavior suite in tests.rs checks it against
//! both):
//! - same JSON shapes (camelCase) and error texts;
//! - every task change is one transaction: guarded UPDATE (expected state / owner) + event;
//! - per-team counters (post seq, task seq) never repeat or go back;
//! - leases expire lazily inside reads and claims;
//! - rows carry UUIDv7 ids, row_version and deleted_at (tombstones); the SQLite file also
//!   appends every write of a synced row to its local change log in the same transaction,
//!   the PostgreSQL server stamps it with `server_seq` instead.

use super::copy::Dump;
use super::model::*;
use super::pg::PgStore;
use super::sqlite::SqliteStore;
use serde_json::Value;

pub enum BoardStore {
    Sqlite(SqliteStore),
    Pg(PgStore),
}

impl BoardStore {
    /// Short name for status lines and errors.
    pub fn backend(&self) -> &'static str {
        match self {
            BoardStore::Sqlite(_) => "sqlite",
            BoardStore::Pg(_) => "postgres",
        }
    }

    pub async fn post(&self, team: String, input: PostInput, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::post(c, l, &team, &input, &ctx)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.post(team, input, ctx)).await,
        }
    }

    pub async fn read(&self, team: String, query: ReadQuery, host: Option<String>) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::read(c, &team, &query, host.as_deref())).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.read(team, query, host)).await,
        }
    }

    pub async fn teams(&self) -> Result<Vec<Value>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(|c, _| super::sqlite::teams(c)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.teams()).await,
        }
    }

    /// Tombstones the team's posts.
    pub async fn clear(&self, team: String, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::clear(c, l, &team, &ctx)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.clear(team, ctx)).await,
        }
    }

    /// Retire (tombstone) teams idle for `max_age_ms` and purge old tombstones; returns how many
    /// teams. SQLite: at app start. PostgreSQL: only from the Settings "Clean up old teams" button.
    pub async fn prune_stale(&self, now: i64, max_age_ms: i64) -> Result<usize, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::prune_stale(c, l, now, max_age_ms)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.prune_stale(now, max_age_ms)).await,
        }
    }

    /// add, claim, block, unblock, release, done, submit, approve, reject, fail, retry,
    /// reopen, cancel, edit, dep_add, dep_remove (TaskOpInput.op).
    pub async fn task_write(&self, team: String, op: TaskOpInput, actor: Actor, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_write(c, l, &team, &op, &actor, &ctx)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.task_write(team, op, actor, ctx)).await,
        }
    }

    pub async fn task_list(&self, team: String, query: TaskListQuery, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_list(c, l, &team, &query, &ctx)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.task_list(team, query, ctx)).await,
        }
    }

    pub async fn task_show(&self, team: String, seq: i64, history: bool, stale_ms: Option<i64>, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_show(c, l, &team, seq, history, stale_ms, &ctx)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.task_show(team, seq, history, stale_ms, ctx)).await,
        }
    }

    /// The newest task events of a whole team (viewer activity feed), oldest first.
    pub async fn team_events(&self, team: String, query: EventsQuery, host: Option<String>) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::team_events(c, &team, &query, host.as_deref())).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.team_events(team, query, host)).await,
        }
    }

    /// Renew leases of this instance's tasks whose owner tab is in `alive`; returns
    /// `{ renewed, holders }` (owner tabs of this instance that still hold tasks).
    pub async fn lease_tick(&self, instance: String, alive: Vec<String>, now: i64, lease_ms: i64) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::lease_tick(c, l, &instance, &alive, now, lease_ms)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.lease_tick(instance, alive, now, lease_ms)).await,
        }
    }

    /// auto_release every task `owner_id` holds through `instance`.
    pub async fn release_owner(&self, instance: String, owner_id: String, now: i64, host: Option<String>, reason: String) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => {
                s.run(move |c, l| super::sqlite::release_owner(c, l, &instance, &owner_id, now, host.as_deref(), &reason)).await
            }
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.release_owner(instance, owner_id, now, host, reason)).await,
        }
    }

    pub async fn lease_holders(&self, instance: String) -> Result<Vec<String>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::lease_holders(c, &instance)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.lease_holders(instance)).await,
        }
    }

    /// Schema version the active backend's code reads and writes.
    pub fn schema_version(&self) -> i64 {
        match self {
            BoardStore::Sqlite(_) => super::sqlite::SCHEMA_VERSION,
            BoardStore::Pg(_) => super::pg::SCHEMA_VERSION,
        }
    }

    pub async fn held_on_host(&self, host: String) -> Result<Vec<Value>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::held_on_host(c, &host)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.held_on_host(host)).await,
        }
    }

    pub async fn lease_apply(
        &self,
        instance: String,
        adopt: Vec<LeaseItem>,
        release: Vec<LeaseItem>,
        now: i64,
        lease_ms: i64,
        host: Option<String>,
    ) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => {
                s.run(move |c, l| super::sqlite::lease_apply(c, l, &instance, &adopt, &release, now, lease_ms, host.as_deref())).await
            }
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.lease_apply(instance, adopt, release, now, lease_ms, host)).await,
        }
    }

    /// Live teams, posts and tasks (Settings status line).
    pub async fn counts(&self) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(|c, _| super::sqlite::counts(c)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.counts()).await,
        }
    }

    /// Every live row of every live team (Settings → Copy data).
    pub async fn export_dump(&self) -> Result<Dump, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(|c, _| super::sqlite::export_dump(c)).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.export_dump()).await,
        }
    }

    /// Insert a dump: the board must be empty unless `merge` (teams it has are skipped).
    pub async fn import_dump(&self, dump: Dump, merge: bool) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::import_dump(c, l, dump, merge, now_ms())).await,
            BoardStore::Pg(p) => super::pg::timed(super::pg::CALL_TIMEOUT, p.import_dump(dump, merge)).await,
        }
    }
}
