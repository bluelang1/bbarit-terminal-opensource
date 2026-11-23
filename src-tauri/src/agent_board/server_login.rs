//! Board server sign-in: device login (RFC 8628), the token file and the Settings commands
//! (`board_server_*`; part 2's Settings screen calls them). Plain Tauri commands, not `agent.*`
//! UI commands, so agents cannot reach them through `bbarit-ctl`; they are not on the remote
//! secretary allowlist either.
//!
//! The token lives in `~/.config/octo/board-server[.dev].token` (0600, written atomically, never
//! through a symbolic link): the app has no OS secure-store dependency in use. What holds: it is
//! never part of a command result (the webview sees only its prefix), a log line, an environment
//! variable (no PTY or child tab gets it) or config.json. What does not: a tab runs as the same
//! user and could read the file, and `bbarit-ctl js` (full control of the main window, like every
//! local bridge in this app) can call these sign-in and sign-out commands. Moving the token into
//! the macOS Keychain is a later hardening step. The device code is a secret too: it stays in
//! this process.

use super::remote::{self, check_server_url, clean_line, diag, failure_text, read_private, request, safe_to_open, write_private, Failure, Remote, Session, Token};
use super::*;
use reqwest::{Method, Url};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

pub const TOKEN_FILE: &str = if cfg!(debug_assertions) { "board-server.dev.token" } else { "board-server.token" };
pub const LEASES_FILE: &str = if cfg!(debug_assertions) { "board-server-leases.dev.json" } else { "board-server-leases.json" };
/// RFC 8628 section 3.4.
pub const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Added to the interval on `slow_down` (RFC 8628 section 3.5).
pub const SLOW_DOWN_STEP: u64 = 5;
/// Longest a sign-in may wait and longest between two polls, whatever the server says.
pub const MAX_EXPIRES_IN: u64 = 1800;
pub const MAX_INTERVAL: u64 = 60;
/// Network failures in a row while polling before the sign-in gives up.
pub const MAX_POLL_ERRORS: u32 = 5;

pub fn token_path() -> Result<std::path::PathBuf, String> {
    Ok(config_dir()?.join(TOKEN_FILE))
}

pub fn leases_path() -> Result<std::path::PathBuf, String> {
    Ok(config_dir()?.join(LEASES_FILE))
}

// ── Token file ───────────────────────────────────────────────────────────

/// The saved sign-in (None when there is none or it is unreadable as a sign-in).
pub fn load_session(path: &Path) -> Result<Option<Session>, String> {
    let Some(text) = read_private(path)? else { return Ok(None) };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let s = |p: &str| v.pointer(p).and_then(Value::as_str).unwrap_or("").to_string();
    let token = s("/token");
    if token.is_empty() || s("/server").is_empty() {
        return Ok(None);
    }
    Ok(Some(Session {
        server: s("/server"),
        token: Token::new(token),
        token_prefix: v.get("tokenPrefix").and_then(Value::as_str).map(clean_line),
        account_uid: s("/account/uid"),
        nickname: clean_line(&s("/account/nickname")),
        runner_uid: s("/runner/uid"),
        runner_name: clean_line(&s("/runner/name")),
    }))
}

pub fn save_session(path: &Path, s: &Session) -> Result<(), String> {
    let body = json!({
        "server": s.server,
        "token": s.token.expose(),
        "tokenPrefix": s.token_prefix,
        "account": { "uid": s.account_uid, "nickname": s.nickname },
        "runner": { "uid": s.runner_uid, "name": s.runner_name },
        "savedAt": now_ms(),
    });
    write_private(path, &serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?)
}

/// Remove the token file; Ok(false) when there was none. A symbolic link is refused.
pub fn remove_session(path: &Path) -> Result<bool, String> {
    remote::refuse_symlink(path)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot remove the sign-in file: {e}")),
    }
}

// ── Device login ─────────────────────────────────────────────────────────

/// A sign-in waiting for approval in the browser. The device code never leaves this process.
#[derive(Clone)]
pub struct Pending {
    /// Which sign-in this is (a cancel or a new start makes an in-flight poll stale).
    pub generation: u64,
    pub server: String,
    device_code: Token,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub interval: u64,
    pub expires_in: u64,
    pub expires_at: Instant,
    pub next_poll: Instant,
    pub errors: u32,
}

impl Pending {
    /// What the webview may see (no device code).
    pub fn public(&self, opened: bool) -> Value {
        json!({
            "server": self.server,
            "userCode": self.user_code,
            "verificationUri": self.verification_uri,
            "verificationUriComplete": self.verification_uri_complete,
            "expiresIn": self.expires_in,
            "interval": self.interval,
            "opened": opened,
        })
    }

    /// The link to open in a browser: only http(s) on the server's own origin, else None (the
    /// person reads it from the screen instead).
    pub fn link_to_open(&self) -> Option<String> {
        let link = self.verification_uri_complete.clone().unwrap_or_else(|| self.verification_uri.clone());
        safe_to_open(&link, &self.server).then_some(link)
    }
}

fn endpoint(server: &str, path: &str) -> Result<Url, String> {
    Url::parse(server).and_then(|u| u.join(path)).map_err(|_| "invalid board server address".to_string())
}

/// Ask the server for a device code (`server`: an origin from `check_server_url`).
pub async fn start(http: &reqwest::Client, server: &str, computer: &str) -> Result<Pending, String> {
    let body = json!({ "runner_name": computer, "client_name": "bbarit-terminal", "client_version": APP_VERSION });
    let v = request(http, Method::POST, endpoint(server, "/auth/device/code")?, None, Some(&body), false)
        .await
        .map_err(|f| format!("the board server did not start a sign-in: {}", failure_text(&f, false)))?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(clean_line).filter(|s| !s.is_empty()).ok_or_else(|| format!("the board server's answer has no {k}"));
    let device_code = v.get("device_code").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| "the board server's answer has no device_code".to_string())?;
    let expires_in = v.get("expires_in").and_then(Value::as_u64).unwrap_or(600).clamp(1, MAX_EXPIRES_IN);
    let interval = v.get("interval").and_then(Value::as_u64).unwrap_or(5).clamp(1, MAX_INTERVAL);
    let now = Instant::now();
    Ok(Pending {
        server: server.to_string(),
        device_code: Token::new(device_code),
        user_code: field("user_code")?,
        verification_uri: field("verification_uri")?,
        verification_uri_complete: v.get("verification_uri_complete").and_then(Value::as_str).map(clean_line),
        interval,
        expires_in,
        expires_at: now + Duration::from_secs(expires_in),
        next_poll: now + Duration::from_secs(interval),
        errors: 0,
        generation: NEXT_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
    })
}

#[derive(Debug)]
pub enum Poll {
    /// Not approved yet: ask again after this long.
    Wait(Duration),
    SignedIn(Session),
    Denied,
    Expired,
    Failed(String),
}

/// One poll, honouring the interval (a call before `next_poll` only says how long to wait).
pub async fn poll(http: &reqwest::Client, p: &mut Pending) -> Poll {
    let now = Instant::now();
    if now >= p.expires_at {
        return Poll::Expired;
    }
    if now < p.next_poll {
        return Poll::Wait(p.next_poll - now);
    }
    let url = match endpoint(&p.server, "/auth/device/token") {
        Ok(u) => u,
        Err(e) => return Poll::Failed(e),
    };
    let body = json!({ "device_code": p.device_code.expose(), "grant_type": GRANT_TYPE });
    let res = request(http, Method::POST, url, None, Some(&body), false).await;
    let wait = |p: &mut Pending| {
        p.next_poll = Instant::now() + Duration::from_secs(p.interval);
        Poll::Wait(Duration::from_secs(p.interval))
    };
    match res {
        Ok(v) => {
            p.errors = 0;
            let token = v.get("access_token").and_then(Value::as_str).unwrap_or("");
            if token.is_empty() {
                return Poll::Failed("the board server's answer has no access_token".into());
            }
            let s = |ptr: &str| v.pointer(ptr).and_then(Value::as_str).map(clean_line).unwrap_or_default();
            Poll::SignedIn(Session {
                server: p.server.clone(),
                token: Token::new(token),
                token_prefix: v.get("token_prefix").and_then(Value::as_str).map(clean_line),
                account_uid: s("/account/uid"),
                nickname: s("/account/nickname"),
                runner_uid: s("/runner/uid"),
                runner_name: s("/runner/name"),
            })
        }
        Err(Failure::Status { code, retry_after, .. }) => match code.as_str() {
            "authorization_pending" => wait(p),
            "slow_down" => {
                p.interval = p.interval.saturating_add(SLOW_DOWN_STEP).max(retry_after.unwrap_or(0)).min(MAX_INTERVAL);
                wait(p)
            }
            "access_denied" => Poll::Denied,
            "expired_token" => Poll::Expired,
            other => Poll::Failed(format!("the sign-in failed: {}", if other.is_empty() { "unexpected answer" } else { other })),
        },
        Err(f @ (Failure::Timeout | Failure::Network(_))) => {
            p.errors += 1;
            if p.errors >= MAX_POLL_ERRORS {
                return Poll::Failed(format!("{} ({} times in a row)", failure_text(&f, false), p.errors));
            }
            wait(p)
        }
        Err(f) => Poll::Failed(failure_text(&f, false)),
    }
}

static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The waiting sign-in (at most one).
pub type Slot = tokio::sync::Mutex<Option<Pending>>;

/// One poll of the sign-in in `slot`. The lock is not held during the request; when the sign-in
/// was cancelled (or started again) meanwhile, cancel wins: a token the poll got is revoked and
/// never stored. A sign-in to another server than the saved one revokes the old computer first
/// (best effort) and drops that server's lease entries (`replaced` in the answer).
pub async fn poll_slot(http: &reqwest::Client, slot: &Slot, token_file: &Path, leases_file: &Path) -> Result<Value, String> {
    let mut work = match slot.lock().await.as_ref() {
        Some(p) => p.clone(),
        None => return Ok(json!({ "state": "idle" })),
    };
    let r = poll(http, &mut work).await;
    let current = {
        let mut g = slot.lock().await;
        let current = g.as_ref().is_some_and(|p| p.generation == work.generation);
        if current {
            *g = if matches!(r, Poll::Wait(_)) { Some(work) } else { None };
        }
        current
    };
    if !current {
        if let Poll::SignedIn(s) = r {
            let secret = s.token.expose().to_string();
            if let Ok(c) = Remote::new(s, remote::LeaseBook::new(leases_file.to_path_buf())) {
                if let Err(e) = c.revoke_self().await {
                    diag(&format!("a cancelled sign-in's token could not be revoked: {e}"), &[&secret]);
                }
            }
        }
        return Ok(json!({ "state": "cancelled", "message": "the sign-in was cancelled" }));
    }
    let Poll::SignedIn(s) = &r else { return Ok(poll_value(&r)) };
    let replaced = replace_other_server(s, token_file, leases_file).await;
    save_session(token_file, s)?;
    diag(&format!("signed in to {} as {} on computer {}", s.server, s.nickname, s.runner_name), &[s.token.expose()]);
    let mut out = poll_value(&r);
    if let Some(v) = replaced {
        out["replaced"] = v;
    }
    Ok(out)
}

/// A saved sign-in for another server than `new`: revoke it there (best effort) and drop that
/// server's lease entries. `{server, revoked}` or None.
async fn replace_other_server(new: &Session, token_file: &Path, leases_file: &Path) -> Option<Value> {
    let old = load_session(token_file).ok().flatten().filter(|o| o.server != new.server)?;
    let server = old.server.clone();
    let book = remote::LeaseBook::new(leases_file.to_path_buf());
    let revoked = match Remote::new(old, remote::LeaseBook::new(leases_file.to_path_buf())) {
        Ok(c) => c.revoke_self().await.unwrap_or(false),
        Err(_) => false,
    };
    let _ = book.remove_server(&server);
    Some(json!({ "server": server, "revoked": revoked }))
}

fn pending() -> &'static Slot {
    static P: std::sync::OnceLock<tokio::sync::Mutex<Option<Pending>>> = std::sync::OnceLock::new();
    P.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Open `url` in the default browser (no shell).
fn open_in_browser(url: &str) -> bool {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok()
}

// ── Status ───────────────────────────────────────────────────────────────

/// What Settings shows: never the token, only its prefix. `refresh`: ask the server (`/v1/me`)
/// for the role and suspension.
pub async fn status_value(mode: &str, configured: &str, token_file: &Path, leases_file: &Path, refresh: bool) -> Value {
    let checked = check_server_url(configured);
    let mut out = json!({
        "mode": mode,
        "server": checked.as_ref().ok().cloned().unwrap_or_else(|| clean_line(configured)),
        "serverError": checked.as_ref().err(),
        "signedIn": false,
    });
    let session = match load_session(token_file) {
        Ok(Some(s)) => s,
        Ok(None) => return out,
        Err(e) => {
            out["error"] = json!(e);
            return out;
        }
    };
    out["signedIn"] = json!(true);
    out["signedInServer"] = json!(session.server);
    out["serverMatches"] = json!(checked.as_deref().ok() == Some(session.server.as_str()));
    out["nickname"] = json!(session.nickname);
    out["accountUid"] = json!(session.account_uid);
    out["computer"] = json!(session.runner_name);
    out["tokenPrefix"] = json!(session.token_prefix);
    out["role"] = Value::Null;
    out["suspended"] = json!(false);
    out["suspendedUntil"] = Value::Null;
    out["heldTasks"] = json!(remote::LeaseBook::new(leases_file.to_path_buf()).entries(&session.server).len());
    out["leaseBookProblem"] = json!(remote::book_problem().map(|(at, e)| json!({ "at": at, "error": e })));
    if !refresh {
        return out;
    }
    let secret = session.token.expose().to_string();
    let client = match Remote::new(session, remote::LeaseBook::new(leases_file.to_path_buf())) {
        Ok(c) => c,
        Err(e) => {
            out["error"] = json!(e);
            return out;
        }
    };
    match client.me().await {
        Ok(me) => {
            let until = me.pointer("/account/suspendedUntil").and_then(Value::as_str).map(str::to_string);
            let suspended = until.as_deref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).is_some_and(|t| t.timestamp_millis() > now_ms());
            out["nickname"] = me.pointer("/account/nickname").cloned().unwrap_or(out["nickname"].clone());
            out["role"] = me.pointer("/account/role").cloned().unwrap_or(Value::Null);
            out["computer"] = me.pointer("/runner/name").cloned().unwrap_or(out["computer"].clone());
            out["suspended"] = json!(suspended);
            out["suspendedUntil"] = json!(until.filter(|_| suspended));
        }
        Err(Failure::Status { status: 403, code, suspended_until, .. }) if code == "account suspended" => {
            out["suspended"] = json!(true);
            out["suspendedUntil"] = json!(suspended_until);
        }
        Err(f) => out["error"] = json!(config::redact(&failure_text(&f, false), &[&secret])),
    }
    out
}

/// The webview's view of the poll result.
pub fn poll_value(p: &Poll) -> Value {
    match p {
        Poll::Wait(d) => json!({ "state": "pending", "retryInMs": d.as_millis() as u64 }),
        Poll::SignedIn(s) => json!({ "state": "signed_in", "server": s.server, "nickname": s.nickname, "computer": s.runner_name, "tokenPrefix": s.token_prefix }),
        Poll::Denied => json!({ "state": "denied", "message": "the sign-in was denied in the browser" }),
        Poll::Expired => json!({ "state": "expired", "message": "the sign-in code expired before it was approved: start again" }),
        Poll::Failed(m) => json!({ "state": "error", "message": m }),
    }
}

// ── Commands ─────────────────────────────────────────────────────────────

/// `{mode, server, serverError, signedIn, signedInServer, serverMatches, nickname, accountUid,
/// computer, tokenPrefix, role, suspended, suspendedUntil, heldTasks, error?, signInPending}`.
#[tauri::command(async)]
pub async fn board_server_status() -> Result<Value, String> {
    let sel = read_selection();
    let mut v = status_value(sel.mode.mode.as_str(), &sel.server_url, &token_path()?, &leases_path()?, true).await;
    v["signInPending"] = json!(pending().lock().await.is_some());
    Ok(v)
}

/// Start a sign-in: `server` (the address Settings shows; else config.json) and the computer's
/// name (else this machine's board name). Opens the approval page when it is on the server's own
/// origin. Returns `{server, userCode, verificationUri, verificationUriComplete, expiresIn,
/// interval, opened}`.
#[tauri::command(async)]
pub async fn board_server_sign_in_start(server: Option<String>, computer_name: Option<String>) -> Result<Value, String> {
    let raw = server.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| read_selection().server_url);
    let origin = check_server_url(&raw)?;
    let computer = clean_label(computer_name.as_deref(), 64).unwrap_or_else(board_host);
    let p = start(&remote::http_client()?, &origin, &computer).await?;
    let opened = p.link_to_open().is_some_and(|l| open_in_browser(&l));
    let out = p.public(opened);
    *pending().lock().await = Some(p);
    Ok(out)
}

/// One poll of the waiting sign-in: `{state: pending (retryInMs) | signed_in (server, nickname,
/// computer, tokenPrefix, replaced?) | denied | expired | error (message) | cancelled | idle}`.
/// On success the token is saved; it is never part of the answer.
#[tauri::command(async)]
pub async fn board_server_sign_in_poll() -> Result<Value, String> {
    poll_slot(&remote::http_client()?, pending(), &token_path()?, &leases_path()?).await
}

/// Open the waiting sign-in's approval page again (Settings' "Open approval page"): the link is
/// the one the server gave, opened only when it is http(s) on the server's own origin; the
/// webview never sends a URL. `{opened}`.
#[tauri::command(async)]
pub async fn board_server_open_sign_in_link() -> Result<Value, String> {
    let p = pending().lock().await.clone();
    open_pending_link(p.as_ref(), open_in_browser)
}

/// `board_server_open_sign_in_link` with the opener injected (tests).
pub fn open_pending_link(p: Option<&Pending>, open: impl Fn(&str) -> bool) -> Result<Value, String> {
    let p = p.ok_or_else(|| "no sign-in is waiting: press Sign in first".to_string())?;
    let link = p
        .link_to_open()
        .ok_or_else(|| "the approval page is not on the board server's own address: open it yourself".to_string())?;
    Ok(json!({ "opened": open(&link) }))
}

#[tauri::command(async)]
pub async fn board_server_sign_in_cancel() -> Result<Value, String> {
    Ok(json!({ "cancelled": pending().lock().await.take().is_some() }))
}

/// Sign out: revoke this computer on the server, then forget the token (and the leases kept for
/// that server). When the server cannot be asked, nothing is removed unless `localOnly`.
/// Returns `{server, revoked, removed}`.
#[tauri::command(async)]
pub async fn board_server_sign_out(local_only: Option<bool>) -> Result<Value, String> {
    sign_out(&token_path()?, &leases_path()?, local_only.unwrap_or(false)).await
}

pub async fn sign_out(token_file: &Path, leases_file: &Path, local_only: bool) -> Result<Value, String> {
    let Some(session) = load_session(token_file)? else {
        return Ok(json!({ "server": Value::Null, "revoked": false, "removed": false }));
    };
    let server = session.server.clone();
    let book = remote::LeaseBook::new(leases_file.to_path_buf());
    let mut revoked = false;
    if !local_only {
        let client = Remote::new(session, remote::LeaseBook::new(leases_file.to_path_buf()))?;
        revoked = client
            .revoke_self()
            .await
            .map_err(|e| format!("{e} (nothing removed; sign out on this computer only to forget the sign-in anyway)"))?;
    }
    let removed = remove_session(token_file)?;
    let _ = book.remove_server(&server);
    Ok(json!({ "server": server, "revoked": revoked, "removed": removed }))
}
