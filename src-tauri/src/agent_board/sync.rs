//! Stage 3b: the `sync` usage type, app side — the worker that runs rounds with the current
//! Settings, its status line and the Settings / viewer commands. The rules, the round, restore
//! and team takeover live in the board-store crate (`board_store::sync_core`, re-exported here),
//! so a board server can share them. Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md,
//! "Usage types and sync".

pub use board_store::sync_core::*;

use super::config::BoardMode;
use super::model::*;
use super::pg::PgStore;
use super::sqlite::SqliteStore;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

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
    hosts: Vec<(String, i64, i64)>,
    hosts_at: Option<i64>,
    server_schema: Option<i64>,
}

static STATUS: Mutex<Status> = Mutex::new(Status {
    state: "off",
    last_push_at: None,
    last_pull_at: None,
    last_error: None,
    last_error_code: None,
    last_error_at: None,
    last_round_at: None,
    hosts: Vec::new(),
    hosts_at: None,
    server_schema: None,
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
    let store = Arc::new(super::pg_store(target));
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
    let on_step = |step: RoundStep| {
        note(|s| match step {
            RoundStep::Pushed => s.last_push_at = Some(now),
            RoundStep::Pulled => s.last_pull_at = Some(now),
        })
    };
    let res = sync_round(local, &server, &server_id, &host, super::instance_id(), machine.as_deref(), now, &on_step).await;
    note(|s| {
        s.last_round_at = Some(now);
        match &res {
            Ok(r) => {
                s.hosts = r.hosts.clone();
                s.hosts_at = Some(now);
                s.server_schema = Some(r.server_schema);
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
    let store = super::local_store(path);
    let _ = store.run(|c, _| super::sqlite::sync_release(c)).await;
}

/// What one worker tick does: nothing while the agent team is turned off (Settings → "Agent team
/// in tabs"; the change log, mirrors and settings stay as they are, so turning it back on carries
/// on where it stopped), release when the usage type left `sync`, else a round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkerStep {
    Paused,
    Off,
    Round,
}

pub fn worker_step(agents_enabled: bool, mode: BoardMode) -> WorkerStep {
    if !agents_enabled {
        WorkerStep::Paused
    } else if mode != BoardMode::Sync {
        WorkerStep::Off
    } else {
        WorkerStep::Round
    }
}

/// The status line while the agent team is turned off.
pub const AGENTS_DISABLED_MESSAGE: &str = "agent team in tabs is turned off in Settings; sync resumes when it is turned on";

/// The sync worker (app setup): a host task, never in the webview. Active only while the usage
/// type is `sync` and the agent team is on: a round on start, every 30 s and 2 s after a local write; failures back off
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
            let step = worker_step(super::agents_enabled(), sel.mode.mode);
            if step == WorkerStep::Paused {
                // Paused, not released: nothing is pushed, pulled or cleaned up. A local write
                // while paused stays in the change log for the next round.
                if sel.mode.mode == BoardMode::Sync {
                    note(|s| {
                        s.state = "paused";
                        s.last_error = Some(AGENTS_DISABLED_MESSAGE.into());
                        s.last_error_code = Some("agents_disabled");
                    });
                }
                failures = 0;
                next_at = now + WRITE_DELAY_MS;
                continue;
            }
            if step == WorkerStep::Off {
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
                    // `sync`, never `post`: views refresh, nothing notifies or types into a tab.
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
        "outboxWaiting": 0,
        "outboxRefused": 0,
        "serverSchema": st.server_schema,
        "codeSchema": super::pg::SCHEMA_VERSION,
        // `ageMs` is by the server's clock at `hostsAt` (this computer's clock), so the view
        // never compares two computers' clocks.
        "hosts": st.hosts.iter().map(|(h, seen, age)| json!({ "host": h, "lastSeen": seen, "ageMs": age })).collect::<Vec<_>>(),
        "hostsAt": st.hosts_at,
        "adoptAfterMs": adopt_after_ms(),
    });
    let path = super::db_path()?;
    if !sel.uses_postgres() && path.exists() {
        let local = super::local_store(path).run(|c, _| super::sqlite::sync_status_local(c)).await?;
        for k in ["waiting", "skipped", "refused", "refusedReason", "fullPush", "machines", "outboxWaiting", "outboxRefused", "keptRows", "keptFile", "serverEvent", "serverEventAt"] {
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
    if !super::agents_enabled() {
        return Err(AGENTS_DISABLED_MESSAGE.into());
    }
    let res = run_round(&sel).await;
    let mut status = agent_board_sync_status().await?;
    status["ok"] = json!(res.is_ok());
    if let Ok(r) = res {
        status["pushed"] = json!(r.pushed);
        status["pulled"] = json!(r.pulled);
        status["refusedNow"] = json!(r.refused);
        status["delivered"] = json!(r.delivered);
        status["moved"] = json!(r.moved);
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
        super::BoardStore::Pg(_) => super::local_store(path).run(|c, _| super::sqlite::sync_remove_mirrors(c)).await?,
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
        let live = super::local_store(path).run(move |c, _| super::sqlite::live_home_teams(c, &host)).await?;
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


// ── Stage 3c: restore, take over a team, remote notes (Settings / viewer only) ──

/// `agents.board.adoptAfterHours` (1–720, default 24) in ms: how long a team's home must have
/// been silent before another computer may take the team over. Protected from agents
/// (`config.patch` refuses it, like `hostName`).
pub fn adopt_after_ms() -> i64 {
    let hours = crate::read_octo_config_json()
        .and_then(|c| c.get("agents")?.get("board")?.get("adoptAfterHours")?.as_f64())
        .map(|h| h.round() as i64)
        .unwrap_or(ADOPT_AFTER_HOURS_DEFAULT);
    hours.clamp(1, 720) * 3_600_000
}

/// The parts the 3c commands need: the sync server and the local file (sync mode only).
fn parts3c(sel: &super::Selection) -> Result<(Arc<PgStore>, Arc<super::BoardStore>), String> {
    if sel.mode.mode != BoardMode::Sync {
        return Err(refusal("sync_off", json!({}), "sync is off: choose \"Both (sync)\" first"));
    }
    let (_, server) = server_for(sel).map_err(|e| refusal("settings", json!({}), &clean_message(&e)))?;
    let store = super::current_store()?;
    if !matches!(&*store, super::BoardStore::Sqlite(_)) {
        return Err(refusal("local", json!({}), "sync needs the board file on this computer"));
    }
    Ok((server, store))
}

fn lite(store: &super::BoardStore) -> &SqliteStore {
    match store {
        super::BoardStore::Sqlite(s) => s,
        super::BoardStore::Pg(_) => unreachable!("parts3c checked the engine"),
    }
}

/// A refusal passes as it is; any other error (server, file) has secrets removed.
fn clean_err3c(e: String) -> String {
    if e.starts_with('{') {
        e
    } else {
        refusal("error", json!({}), &clean_message(&e))
    }
}

/// Settings → "Restore my teams from the server": the preview (nothing changes).
#[tauri::command]
pub async fn agent_board_restore_preview() -> Result<Value, String> {
    let sel = super::read_selection();
    let (server, store) = parts3c(&sel)?;
    let _one = ROUND.lock().await;
    restore_preview(lite(&store), &server, &super::board_host(), now_ms()).await.map_err(clean_err3c)
}

/// Settings → "Restore my teams from the server", after the person confirmed the preview.
#[tauri::command]
pub async fn agent_board_restore(takeover: bool) -> Result<Value, String> {
    let sel = super::read_selection();
    let (server, store) = parts3c(&sel)?;
    let _one = ROUND.lock().await;
    let out = restore_teams(lite(&store), &server, &super::board_host(), takeover, now_ms()).await.map_err(clean_err3c)?;
    note_local_write();
    Ok(out)
}

/// Team status → "Take over this team": the preview for a copy (nothing changes).
#[tauri::command]
pub async fn agent_board_adopt_preview(team: String) -> Result<Value, String> {
    let sel = super::read_selection();
    let (server, store) = parts3c(&sel)?;
    let _one = ROUND.lock().await;
    adopt_preview(lite(&store), &server, team.trim(), &super::board_host(), now_ms(), adopt_after_ms()).await.map_err(clean_err3c)
}

/// Team status → "Take over this team", with the team, home and version the person confirmed.
#[tauri::command]
pub async fn agent_board_adopt(team: String, uid: String, home: String, version: i64) -> Result<Value, String> {
    let sel = super::read_selection();
    let (server, store) = parts3c(&sel)?;
    let _one = ROUND.lock().await;
    let out = adopt_team(lite(&store), &server, &super::board_host(), super::instance_id(), team.trim(), &uid, &home, version, now_ms(), adopt_after_ms())
        .await
        .map_err(clean_err3c)?;
    note_local_write();
    Ok(out)
}

/// Team status: this computer's notes for a team on another computer that are not posts yet
/// (waiting to be delivered, or refused with a code). Local only; never creates the file.
#[tauri::command]
pub async fn agent_board_outbox(team: String) -> Result<Vec<Value>, String> {
    let path = super::db_path()?;
    if super::read_selection().uses_postgres() || !path.exists() {
        return Ok(Vec::new());
    }
    let t = team.trim().to_string();
    super::local_store(path).run(move |c, _| super::sqlite::outbox_list(c, &t)).await
}

/// Team status: a person dismisses a refused note.
#[tauri::command]
pub async fn agent_board_outbox_dismiss(id: String) -> Result<Value, String> {
    let path = super::db_path()?;
    if !path.exists() {
        return Ok(json!({ "removed": 0 }));
    }
    let n = super::local_store(path).run(move |c, _| super::sqlite::outbox_dismiss(c, &id)).await?;
    Ok(json!({ "removed": n }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_does_not_run_while_the_agent_team_is_off() {
        for mode in [BoardMode::Sync, BoardMode::Sqlite, BoardMode::Postgres] {
            assert_eq!(worker_step(false, mode), WorkerStep::Paused);
        }
        assert_eq!(worker_step(true, BoardMode::Sync), WorkerStep::Round);
        assert_eq!(worker_step(true, BoardMode::Sqlite), WorkerStep::Off);
        assert_eq!(worker_step(true, BoardMode::Postgres), WorkerStep::Off);
    }

    #[test]
    fn agents_enabled_reads_only_an_explicit_false_as_off() {
        use super::super::agents_enabled_in;
        assert!(agents_enabled_in(None));
        assert!(agents_enabled_in(Some(&json!({}))));
        assert!(agents_enabled_in(Some(&json!({ "agents": { "maxChildren": 3 } }))));
        assert!(agents_enabled_in(Some(&json!({ "agents": { "enabled": true } }))));
        assert!(agents_enabled_in(Some(&json!({ "agents": { "enabled": "false" } }))));
        assert!(!agents_enabled_in(Some(&json!({ "agents": { "enabled": false } }))));
    }

    #[test]
    fn lead_phrases_for_the_prompt_hook() {
        use super::super::{lead_hook_phrases, lead_phrase_in, normalize_lead_phrase, DEFAULT_LEAD_PHRASE};
        assert_eq!(lead_hook_phrases(None), vec![DEFAULT_LEAD_PHRASE.to_string(), "proceed as the lead agent".to_string()]);
        assert!(lead_hook_phrases(Some(&json!({ "agents": { "enabled": false } }))).is_empty());
        let cfg = json!({ "agents": { "leadPhrase": "  Run   as \"LEAD\"  " } });
        assert_eq!(lead_phrase_in(Some(&cfg)), "Run as \"LEAD\"");
        assert_eq!(lead_hook_phrases(Some(&cfg))[0], "run as \\\"lead\\\"");
        // Invalid saved values fall back to the default.
        let long = "y".repeat(61);
        for bad in ["x", "a\nb", "zero\u{200b}width", long.as_str()] {
            assert_eq!(normalize_lead_phrase(bad), None, "{bad:?}");
            assert_eq!(lead_phrase_in(Some(&json!({ "agents": { "leadPhrase": bad } }))), DEFAULT_LEAD_PHRASE);
        }
        // The English default only once when it is also the configured phrase.
        assert_eq!(lead_hook_phrases(Some(&json!({ "agents": { "leadPhrase": "Proceed as the lead agent" } }))).len(), 1);
    }
}
