//! `BoardStore`: the one interface every board operation goes through. Enum dispatch over
//! the engines (only SQLite today); every method is async, so the PostgreSQL store of stage 3
//! (sqlx, natively async) slots in as another variant without touching the command layer.
//! Methods take owned arguments: the SQLite variant moves them onto the blocking pool.
//!
//! Contract for every implementation (the shared behavior suite in tests.rs checks it):
//! - same JSON shapes (camelCase) and error texts;
//! - every task change is one transaction: guarded UPDATE (expected state / owner) + event;
//! - per-team counters (post seq, task seq) never repeat or go back;
//! - leases expire lazily inside reads and claims;
//! - rows carry UUIDv7 ids, row_version, deleted_at (tombstones) and every write of a synced
//!   row appends to the local change log in the same transaction.

use super::model::*;
use super::sqlite::SqliteStore;
use serde_json::Value;

pub enum BoardStore {
    Sqlite(SqliteStore),
}

impl BoardStore {
    /// Short name for status lines and errors.
    pub fn backend(&self) -> &'static str {
        match self {
            BoardStore::Sqlite(_) => "sqlite",
        }
    }

    pub async fn post(&self, team: String, input: PostInput, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::post(c, l, &team, &input, &ctx)).await,
        }
    }

    pub async fn read(&self, team: String, query: ReadQuery, host: Option<String>) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::read(c, &team, &query, host.as_deref())).await,
        }
    }

    pub async fn teams(&self) -> Result<Vec<Value>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(|c, _| super::sqlite::teams(c)).await,
        }
    }

    /// Tombstones the team's posts.
    pub async fn clear(&self, team: String, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::clear(c, l, &team, &ctx)).await,
        }
    }

    /// Retire (tombstone) teams idle for `max_age_ms` and purge old tombstones; returns how many teams.
    pub async fn prune_stale(&self, now: i64, max_age_ms: i64) -> Result<usize, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::prune_stale(c, l, now, max_age_ms)).await,
        }
    }

    /// add, claim, block, unblock, release, done, submit, approve, reject, fail, retry,
    /// reopen, cancel, edit, dep_add, dep_remove (TaskOpInput.op).
    pub async fn task_write(&self, team: String, op: TaskOpInput, actor: Actor, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_write(c, l, &team, &op, &actor, &ctx)).await,
        }
    }

    pub async fn task_list(&self, team: String, query: TaskListQuery, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_list(c, l, &team, &query, &ctx)).await,
        }
    }

    pub async fn task_show(&self, team: String, seq: i64, history: bool, stale_ms: Option<i64>, ctx: Ctx) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::task_show(c, l, &team, seq, history, stale_ms, &ctx)).await,
        }
    }

    /// Renew leases of this instance's tasks whose owner tab is in `alive`; returns
    /// `{ renewed, holders }` (owner tabs of this instance that still hold tasks).
    pub async fn lease_tick(&self, instance: String, alive: Vec<String>, now: i64, lease_ms: i64) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, l| super::sqlite::lease_tick(c, l, &instance, &alive, now, lease_ms)).await,
        }
    }

    /// auto_release every task `owner_id` holds through `instance`.
    pub async fn release_owner(&self, instance: String, owner_id: String, now: i64, host: Option<String>, reason: String) -> Result<Value, String> {
        match self {
            BoardStore::Sqlite(s) => {
                s.run(move |c, l| super::sqlite::release_owner(c, l, &instance, &owner_id, now, host.as_deref(), &reason)).await
            }
        }
    }

    pub async fn lease_holders(&self, instance: String) -> Result<Vec<String>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::lease_holders(c, &instance)).await,
        }
    }

    /// Schema version the active backend is at.
    pub fn schema_version(&self) -> i64 {
        match self {
            BoardStore::Sqlite(_) => super::sqlite::SCHEMA_VERSION,
        }
    }

    pub async fn held_on_host(&self, host: String) -> Result<Vec<Value>, String> {
        match self {
            BoardStore::Sqlite(s) => s.run(move |c, _| super::sqlite::held_on_host(c, &host)).await,
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
        }
    }
}
