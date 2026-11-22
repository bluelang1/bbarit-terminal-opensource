//! Settings → "Agent team board" commands: status, PostgreSQL connection test, create /
//! upgrade tables, copy data between the engines, clean up old teams on the server, and the
//! write-only password. These are plain Tauri commands for the Settings page: they are not
//! `agent.*` UI commands, so agents cannot reach them through `bbarit-ctl` (switch the
//! backend, read connection settings or create tables). The webview never gets the password
//! back: it can only ask whether one is saved. All are async (network and file work must not
//! run on the main thread).
//!
//! The PostgreSQL commands take the connection fields the page currently shows (`postgres`,
//! shaped like `agents.board.postgres`), so a test does not wait for the debounced config
//! save; without them they read config.json. The password always comes from the secret file
//! (or `BBARIT_BOARD_DATABASE_URL`, which replaces the connection fields).

use super::config::{self, PgSettings, PgTarget};
use super::pg::PgStore;
use super::store::BoardStore;
use super::*;
use serde_json::{json, Value};

/// The connection fields from the page (when given) or from config.json.
fn settings_from(postgres: Option<Value>) -> PgSettings {
    match postgres {
        Some(pg) => PgSettings::from_board(Some(&json!({ "postgres": pg }))),
        None => read_selection().settings,
    }
}

/// The connection fields from the page (when given) or from config.json, plus the
/// environment override and the saved password (used only for the server it was saved for).
fn target_from(postgres: Option<Value>) -> Result<PgTarget, String> {
    let mut sel = read_selection();
    sel.settings = settings_from(postgres);
    sel.pg_target()
}

/// Usage type, where the board is, schema version, counts, password saved, last error.
#[tauri::command]
pub async fn agent_board_settings_status() -> Result<Value, String> {
    let sel = read_selection();
    let mut out = json!({
        "mode": sel.mode.mode.as_str(),
        "modeWarning": sel.mode.warning,
        "backend": if sel.uses_postgres() { "postgres" } else { "sqlite" },
        "envOverride": sel.env_url.is_some(),
        "passwordSaved": sel.password.is_some(),
        // Which server the saved password is for (`user@host:port/database`; never the password).
        "passwordFor": sel.password.as_ref().and_then(|p| p.label.clone()),
        "host": board_host(),
        "lastError": last_error().map(|(at, e)| json!({ "at": at, "error": e })),
    });
    if sel.uses_postgres() {
        out["codeVersion"] = json!(super::pg::SCHEMA_VERSION);
        match sel.pg_target() {
            Ok(t) => {
                out["target"] = json!(t.label);
                out["schema"] = json!(t.schema);
                // The store commands use (its pool), so the status shows what they see.
                let store = current_store()?;
                if let BoardStore::Pg(p) = &*store {
                    match super::pg::timed(super::pg::CALL_TIMEOUT, p.stored_schema_version()).await {
                        Ok(v) => out["schemaVersion"] = json!(v),
                        Err(e) => out["error"] = json!(e),
                    }
                }
                if out.get("error").is_none() {
                    match store.counts().await {
                        Ok(c) => out["counts"] = c,
                        Err(e) => out["error"] = json!(e),
                    }
                }
            }
            Err(e) => out["error"] = json!(unavailable(e)),
        }
    } else {
        out["codeVersion"] = json!(super::sqlite::SCHEMA_VERSION);
        let path = db_path()?;
        out["file"] = json!(path.display().to_string());
        if path.exists() {
            match current_store() {
                Ok(store) => match store.counts().await {
                    Ok(c) => {
                        out["counts"] = c;
                        out["schemaVersion"] = json!(super::sqlite::SCHEMA_VERSION);
                    }
                    Err(e) => out["error"] = json!(e),
                },
                Err(e) => out["error"] = json!(e),
            }
        } else {
            out["counts"] = json!({ "teams": 0, "posts": 0, "tasks": 0 });
        }
    }
    Ok(out)
}

/// Test connection: reachable, server version, TLS, schema present and its version,
/// privileges and the next step. Never changes anything.
#[tauri::command]
pub async fn agent_board_pg_test(postgres: Option<Value>) -> Result<Value, String> {
    let target = target_from(postgres)?;
    let mut out = PgStore::diagnose(&target, super::APP_VERSION).await;
    out["envOverride"] = json!(target.from_env);
    out["passwordSaved"] = json!(read_selection().password.is_some());
    // Plain text to a server on another machine: the password and every note cross the network.
    out["tlsWarning"] = json!(out["reachable"] == true && out["tls"] == false && !config::is_loopback(&target.host));
    Ok(out)
}

/// Create / upgrade the board tables in the configured schema. `apply` false: only report
/// the statements that would run (Settings shows them first). Refused when the schema
/// belongs to a newer app version.
#[tauri::command]
pub async fn agent_board_pg_migrate(postgres: Option<Value>, apply: Option<bool>) -> Result<Value, String> {
    let target = target_from(postgres)?;
    super::pg::timed(std::time::Duration::from_secs(120), super::pg_store(target).migrate(apply.unwrap_or(false))).await
}

/// Copy teams, posts, tasks, dependencies, events and read cursors from one engine into the
/// other (`from`: "sqlite" or "postgres"). The target must be empty unless `merge` (then only
/// teams it does not have are copied). The source is never changed; nothing is deleted.
#[tauri::command]
pub async fn agent_board_copy(from: String, merge: Option<bool>, postgres: Option<Value>) -> Result<Value, String> {
    let pg = BoardStore::Pg(super::pg_store(target_from(postgres)?));
    let path = db_path()?;
    let (source, target, to) = match from.trim() {
        "sqlite" => {
            if !path.exists() {
                return Err("there is no local board file to copy yet".to_string());
            }
            (BoardStore::Sqlite(super::local_store(path)), pg, "postgres")
        }
        "postgres" => (pg, BoardStore::Sqlite(super::local_store(path)), "sqlite"),
        other => return Err(format!("unknown source: {other} (sqlite|postgres)")),
    };
    copy_between(&source, &target, merge.unwrap_or(false)).await.map(|mut v| {
        v["from"] = json!(from.trim());
        v["to"] = json!(to);
        v
    })
}

/// Export from `source`, import into `target` (Copy data; lives in the board-store crate).
pub use super::store::copy_between;

/// "Clean up old teams" on the PostgreSQL board (never automatic on a shared server): teams
/// with no activity for 30 days are retired (hidden; removed for good 30 days later together
/// with older tombstones). `apply` false: only count the teams it would retire.
#[tauri::command]
pub async fn agent_board_pg_cleanup(postgres: Option<Value>, apply: Option<bool>) -> Result<Value, String> {
    let store = super::pg_store(target_from(postgres)?);
    if !apply.unwrap_or(false) {
        let n = super::pg::timed(super::pg::CALL_TIMEOUT, store.stale_count(now_ms(), STALE_AFTER_MS)).await?;
        return Ok(json!({ "wouldRetire": n, "applied": false }));
    }
    let retired = super::pg::timed(std::time::Duration::from_secs(300), store.prune_stale(now_ms(), STALE_AFTER_MS)).await?;
    Ok(json!({ "retired": retired, "applied": true }))
}

/// Save the PostgreSQL password for the server in `postgres` (the page's fields, else
/// config.json) — write-only; 0600 file, never in config.json. It is used only while the
/// connection fields still name that server.
#[tauri::command]
pub async fn agent_board_secret_save(password: String, postgres: Option<Value>) -> Result<Value, String> {
    let settings = settings_from(postgres);
    settings.check()?;
    let label = settings.label();
    let path = secret_path()?;
    let for_label = label.clone();
    tauri::async_runtime::spawn_blocking(move || config::write_secret(&path, &password, &for_label))
        .await
        .map_err(|e| e.to_string())??;
    Ok(json!({ "saved": true, "passwordFor": label }))
}

#[tauri::command]
pub async fn agent_board_secret_clear() -> Result<Value, String> {
    let path = secret_path()?;
    let removed = tauri::async_runtime::spawn_blocking(move || config::clear_secret(&path)).await.map_err(|e| e.to_string())??;
    Ok(json!({ "saved": false, "removed": removed }))
}
