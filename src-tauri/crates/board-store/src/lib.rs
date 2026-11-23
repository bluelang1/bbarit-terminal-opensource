//! Agent team board store, shared by the desktop app (src-tauri/src/agent_board) and, later,
//! the board server. No Tauri, no app config readers, no process-wide app state: the machine
//! name (`sqlite::HostFn`, `Ctx.host`) and the app instance id (`Ctx.instance`, sync
//! `instance`) come in as parameters; async work runs on the caller's Tokio runtime.
//!
//! - `model`: limits, text cleaning, request types, actors and the task state machine
//!   (engine independent); `common`: the task row, its JSON and the input checks both
//!   engines share;
//! - `store`: `BoardStore`, the one async interface every operation goes through;
//! - `sqlite`: the SQLite engine (all SQL for it); `pg`: the PostgreSQL engine;
//! - `config`: usage type, connection settings, password file, redaction; `copy`: "Copy
//!   data" between the engines; `sync_core`: the sync rules, round, restore and takeover.
//!
//! Features: `sqlite` (bundled SQLite) and `pg` (sqlx PostgreSQL), both on by default; the
//! sync round, restore and takeover in `sync_core` need both (its rules and row checks do not).
//!
//! # Embedding the store in a server
//!
//! A server that embeds the store (PostgreSQL engine) handles each request in ONE transaction
//! of its own:
//!
//! - **One transaction per request.** `pg::PgOps` (from `PgOps::new(schema)` or
//!   `PgStore::ops()`) has every board operation as a method on `&mut PgConnection`; none of
//!   them begins or commits. Begin, call any number of them, write your own rows, commit once.
//!   On ANY error from one of them, roll back the transaction or to a savepoint taken before
//!   the call: a refusal can come after the operation already wrote (a new team row, expired
//!   leases). `board_store::atomically!(&mut *tx, |c| ops.post(c, ...))` wraps one call that
//!   way (`pg::savepoint` + `pg::settle` by hand). On `StoreError::Busy` (deadlock,
//!   serialization failure) roll back and run the whole transaction again. Keep transactions
//!   that write board rows short: each write holds a shared advisory lock until commit, and a
//!   sync pull tries the exclusive side for only 3 s. Do not make it READ ONLY (list and show expire ran-out leases); start
//!   it REPEATABLE READ for counts and rows from one snapshot. Time comes from `Ctx.now`; to
//!   use the database's clock, read `pg::db_now_ms` on the same connection first.
//! - **One pool.** `PgStore::from_pool(pool, schema, limits, app_version)` uses the server's
//!   own pool (no second pool, `close` leaves it open) for the commands that are a transaction
//!   on their own; `PgStore::new` keeps the desktop's private pool (5 connections, 5 s). Give
//!   that pool `statement_timeout` (the store's own uses 5 s) and an `application_name`, and
//!   pass the password and URL to `with_secrets` so error text is scrubbed.
//! - **Typed errors.** The `PgOps` methods return `StoreError` (`NotFound`, `Conflict`,
//!   `LeaseLost`, `Forbidden`, `Invalid`, `Busy`, `Unavailable`, `Internal`): map
//!   `kind()` to a status, show `to_string()` (the same text the app shows). `PgStore` and
//!   `BoardStore` keep returning that text as a `String`.
//! - **Migration steps.** `pg::steps_in_schema(schema, stored)` lists the steps (version and
//!   SQL) without `CREATE SCHEMA`; `pg::migrate_on(conn, schema, app_version)` runs them in
//!   the caller's transaction (a role that owns only that schema can), `pg::schema_version_on`
//!   reports the version, and `pg::OWNED_TABLES` / `OWNED_SEQUENCES` / `OWNED_FUNCTIONS` name
//!   what the store owns there. The desktop's `PgStore::migrate` still creates the schema
//!   first.
//!
//! The sync methods of `PgStore` (stage 3b/3c) are not part of this: they use the store's pool.

#[cfg(not(any(feature = "sqlite", feature = "pg")))]
compile_error!("board-store needs at least one engine: the `sqlite` or the `pg` feature");

pub mod common;
pub mod config;
pub mod copy;
pub mod error;
pub mod model;
#[cfg(feature = "pg")]
pub mod pg;
#[cfg(feature = "sqlite")]
pub mod sqlite;
pub mod store;
pub mod sync_core;
#[cfg(all(test, feature = "sqlite", feature = "pg"))]
mod tests;

pub use error::StoreError;
pub use model::*;
pub use store::BoardStore;
