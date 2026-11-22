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

#[cfg(not(any(feature = "sqlite", feature = "pg")))]
compile_error!("board-store needs at least one engine: the `sqlite` or the `pg` feature");

pub mod common;
pub mod config;
pub mod copy;
pub mod model;
#[cfg(feature = "pg")]
pub mod pg;
#[cfg(feature = "sqlite")]
pub mod sqlite;
pub mod store;
pub mod sync_core;
#[cfg(all(test, feature = "sqlite", feature = "pg"))]
mod tests;

pub use model::*;
pub use store::BoardStore;
