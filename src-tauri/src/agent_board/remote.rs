//! Board server mode (`agents.board.mode` = `"server"`): the board's commands go to a board
//! server over HTTPS instead of a database. The computer signs in once (device login,
//! server_login.rs) and gets its own token; the server decides who acts (account, computer),
//! so no caller identity (tab id, host, `root` / `human`) is ever sent. Child agents keep
//! going through the app's local bridge and never see the token.
//!
//! This file: the server address rule, the HTTP client (timeouts, no redirects, rustls through
//! the app's reqwest, a response size cap, no retries of writes), the error mapping to the texts
//! the board commands print, the lease book (the `leaseEpoch` and attempt id each claim returned,
//! per task, kept in a 0600 file so a restart keeps them) and every board operation the app uses.
//! Operations the server does not offer are refused with one message each (`refused`).
//!
//! What holds: the token and the Authorization header are never part of a command result, a
//! log line, an environment variable (no PTY or child tab gets it) or config.json, and requests
//! never go through a proxy. What does not: a tab runs as the same user and could read the
//! token file, and `bbarit-ctl js` (full control of the main window, like every local bridge
//! here) can call the sign-in and sign-out commands. Keeping the token in the macOS Keychain is
//! a later hardening step. Text from the server is stripped of control characters and its
//! `<bbarit` tags defused before it can reach a terminal (`clean_value`).
//! Design: docs/superpowers/specs/2026-11-22-agent-mesh-design.md; usage: docs/AGENT_RELAY.md.

use super::model::*;
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER, USER_AGENT};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
/// Largest answer read from the server; a bigger one is refused, not cut.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Worker operations: the server checks the claim's `leaseEpoch` on these.
pub const WORKER_OPS: [&str; 6] = ["block", "unblock", "release", "done", "submit", "fail"];
/// Task operations with a `/tasks/{seq}/{op}` route.
pub const TASK_OPS: [&str; 15] = [
    "claim", "block", "unblock", "release", "done", "submit", "approve", "reject", "fail", "retry", "reopen", "cancel", "edit", "dep-add",
    "dep-remove",
];

/// The one message for an operation a board server does not offer.
pub fn refused(what: &str) -> String {
    format!("{what} is not available on a board server")
}

// ── Text from the server ────────────────────────────────────────────────

/// One line for a terminal: every control character (C0, DEL, C1) and format character removed.
pub fn clean_line(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() && !is_format_char(*c)).collect()
}

/// Board text keeps newlines and tabs; every other control and format character is removed,
/// then `<bbarit` / `</bbarit` tags are defused as the app's write side does (agentBoard.ts
/// `stripBoardControls`), so text written elsewhere cannot pass for a relay note.
pub fn clean_text(s: &str) -> String {
    let kept: String = s.chars().filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !is_format_char(*c)).collect();
    defuse_relay_tags(&kept)
}

/// `<bbarit` → `‹bbarit`, `</bbarit` → `‹/bbarit` (ASCII case-insensitive).
pub fn defuse_relay_tags(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        let rest = &lower[i..];
        let tag = if rest.starts_with("<bbarit") {
            Some(1)
        } else if rest.starts_with("</bbarit") {
            Some(2)
        } else {
            None
        };
        match tag {
            Some(n) => {
                out.push('‹');
                out.push_str(&s[i + 1..i + n]);
                i += n;
            }
            None => {
                let c = s[i..].chars().next().unwrap_or(' ');
                out.push(c);
                i += c.len_utf8().max(1);
            }
        }
    }
    out
}

/// Every string (and key) of a server answer through `clean_text`.
pub fn clean_value(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(clean_text(&s)),
        Value::Array(a) => Value::Array(a.into_iter().map(clean_value).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (clean_line(&k), clean_value(v))).collect()),
        other => other,
    }
}

fn short(s: &str) -> String {
    clean_line(s).chars().take(80).collect()
}

// ── Server address ───────────────────────────────────────────────────────

fn loopback_host(url: &Url) -> bool {
    let Some(h) = url.host_str() else { return false };
    let h = h.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// The board server's origin (`https://host[:port]`, no trailing slash) from the configured
/// address: https, or http only to this computer; no user name, password, path, query or fragment.
pub fn check_server_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("the board server address is not set (Settings → Agent team board)".to_string());
    }
    let url = Url::parse(raw).map_err(|_| format!("invalid board server address: {}", short(raw)))?;
    match url.scheme() {
        "https" => {}
        "http" if loopback_host(&url) => {}
        "http" => return Err("the board server address must use https (http only to this computer)".to_string()),
        _ => return Err(format!("invalid board server address: {} (https://…)", short(raw))),
    }
    if url.host_str().map_or(true, str::is_empty) {
        return Err(format!("invalid board server address: {}", short(raw)));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the board server address must not contain a user name or password".to_string());
    }
    if !(url.path() == "/" || url.path().is_empty()) || url.query().is_some() || url.fragment().is_some() {
        return Err("the board server address is the server only (no path, query or fragment)".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

/// Whether a browser may be sent to `url`: http or https on exactly the server's origin.
pub fn safe_to_open(url: &str, server_origin: &str) -> bool {
    match Url::parse(url) {
        Ok(u) => matches!(u.scheme(), "http" | "https") && u.origin().ascii_serialization() == server_origin,
        Err(_) => false,
    }
}

/// A team id as the store accepts it (it goes into a request path).
fn check_team(team: &str) -> Result<(), String> {
    let ok = !team.is_empty() && team.len() <= 128 && team.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid team id: {}", short(team)))
    }
}

// ── Token and session ────────────────────────────────────────────────────

/// The computer's token. No Debug or Display shows it; only `expose` (for the header) does.
#[derive(Clone, PartialEq, Eq)]
pub struct Token(String);

impl Token {
    pub fn new(s: impl Into<String>) -> Token {
        Token(s.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(***)")
    }
}

/// A signed-in computer: the server it signed in to, its token and who the server says it is.
#[derive(Clone, Debug)]
pub struct Session {
    pub server: String,
    pub token: Token,
    pub token_prefix: Option<String>,
    pub account_uid: String,
    pub nickname: String,
    pub runner_uid: String,
    pub runner_name: String,
}

// ── Diagnostics (never the token) ────────────────────────────────────────

#[cfg(test)]
pub static TEST_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The only place this mode logs: stderr in the app, a buffer in tests. Every line is scrubbed
/// of the given secrets first.
pub fn diag(line: &str, secrets: &[&str]) {
    let line = super::config::redact(&clean_line(line), secrets);
    #[cfg(test)]
    TEST_LOG.lock().unwrap_or_else(|e| e.into_inner()).push(line);
    #[cfg(not(test))]
    eprintln!("[board-server] {line}");
}

// ── Private files ────────────────────────────────────────────────────────

/// Refuse a path that is a symbolic link (the token and lease files are never followed).
pub fn refuse_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(format!("{} is a symbolic link: refused", path.display())),
        _ => Ok(()),
    }
}

/// Read a private file without following a symbolic link; Ok(None) when it does not exist.
pub fn read_private(path: &Path) -> Result<Option<String>, String> {
    refuse_symlink(path)?;
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    match opts.open(path) {
        Ok(mut f) => {
            use std::io::Read;
            let mut s = String::new();
            f.read_to_string(&mut s).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
            Ok(Some(s))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Write owner-only (0600): a new temp file (random name, never an existing one) in the same
/// directory, then a rename over the target. A target that is a symbolic link is refused.
pub fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    refuse_symlink(path)?;
    let dir = path.parent().ok_or_else(|| "no directory for the file".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}-{:016x}.tmp", std::process::id(), rand::random::<u64>()));
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut f = opts.open(&tmp).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        f.write_all(body).and_then(|_| f.sync_all()).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("cannot write {}: {e}", path.display())
        })?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save {}: {e}", path.display())
    })
}

// ── Lease book ───────────────────────────────────────────────────────────

/// What one claim returned: the server checks `leaseEpoch` on every later worker write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseEntry {
    pub server: String,
    pub team: String,
    pub seq: i64,
    pub lease_epoch: i64,
    #[serde(default)]
    pub attempt_id: Option<i64>,
    /// The tab that claimed it (its PTY keeps the lease alive; never sent to the server).
    pub tab: String,
    pub at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct BookFile {
    #[serde(default)]
    entries: Vec<LeaseEntry>,
}

/// The lease book file. One process-wide lock serializes its read-modify-write.
pub struct LeaseBook {
    path: PathBuf,
}

static BOOK_LOCK: Mutex<()> = Mutex::new(());
static BOOK_PROBLEM: Mutex<Option<(i64, String)>> = Mutex::new(None);

fn note_book_problem(msg: String) {
    diag(&msg, &[]);
    *BOOK_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()) = Some((now_ms(), msg));
}

/// The last lease book problem (Settings status), if any.
pub fn book_problem() -> Option<(i64, String)> {
    BOOK_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

impl LeaseBook {
    pub fn new(path: PathBuf) -> LeaseBook {
        LeaseBook { path }
    }

    /// The entries; a file that does not parse is moved aside (`<name>.corrupt-<ms>`) and
    /// reported, never silently overwritten. Entries whose team or number could not go into a
    /// request path are left out.
    fn load(&self) -> Vec<LeaseEntry> {
        let text = match read_private(&self.path) {
            Ok(Some(text)) => text,
            Ok(None) => return Vec::new(),
            Err(e) => {
                note_book_problem(format!("the lease book could not be read: {e}"));
                return Vec::new();
            }
        };
        match serde_json::from_str::<BookFile>(&text) {
            Ok(b) => b.entries.into_iter().filter(|e| check_team(&e.team).is_ok() && e.seq > 0).collect(),
            Err(_) => {
                let name = self.path.file_name().and_then(|n| n.to_str()).unwrap_or("leases");
                let aside = self.path.with_file_name(format!("{name}.corrupt-{}", now_ms()));
                let msg = match std::fs::rename(&self.path, &aside) {
                    Ok(()) => format!("the lease book did not parse; moved aside to {} (claims it held renew no more and expire on the server)", aside.display()),
                    Err(e) => format!("the lease book did not parse and could not be moved aside: {e}"),
                };
                note_book_problem(msg);
                Vec::new()
            }
        }
    }

    fn change(&self, f: impl FnOnce(&mut Vec<LeaseEntry>)) -> Result<(), String> {
        let _g = BOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.load();
        let before = entries.clone();
        f(&mut entries);
        if entries == before {
            return Ok(());
        }
        let body = serde_json::to_vec_pretty(&BookFile { entries }).map_err(|e| e.to_string())?;
        write_private(&self.path, &body)
    }

    pub fn entries(&self, server: &str) -> Vec<LeaseEntry> {
        let _g = BOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.load().into_iter().filter(|e| e.server == server).collect()
    }

    pub fn get(&self, server: &str, team: &str, seq: i64) -> Option<LeaseEntry> {
        self.entries(server).into_iter().find(|e| e.team == team && e.seq == seq)
    }

    pub fn put(&self, entry: LeaseEntry) -> Result<(), String> {
        self.change(|v| {
            v.retain(|e| !(e.server == entry.server && e.team == entry.team && e.seq == entry.seq));
            v.push(entry);
        })
    }

    pub fn remove(&self, server: &str, team: &str, seq: i64) -> Result<(), String> {
        self.change(|v| v.retain(|e| !(e.server == server && e.team == team && e.seq == seq)))
    }

    pub fn remove_server(&self, server: &str) -> Result<(), String> {
        self.change(|v| v.retain(|e| e.server != server))
    }
}

// ── HTTP ─────────────────────────────────────────────────────────────────

/// A refusal or failure of one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The server answered with an error status: its code (`error`), message and Retry-After.
    Status { status: u16, code: String, message: String, retry_after: Option<u64>, suspended_until: Option<String> },
    /// No answer in time (the write may have been saved).
    Timeout,
    /// No connection, or the connection broke.
    Network(String),
    /// The answer was not what the API returns (too big, not JSON, a redirect).
    Bad(String),
}

/// The HTTP client every board server call uses: connect 5 s, total 15 s, redirects never
/// followed, rustls (the app's reqwest has no other TLS stack).
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // Never through a proxy from the environment: the token goes only to the server.
        .no_proxy()
        .use_rustls_tls()
        .build()
        .map_err(|e| unavailable(format!("cannot set up the board server client: {}", e.without_url())))
}

fn user_agent() -> HeaderValue {
    HeaderValue::from_str(&format!("BBARIT-Terminal/{}", super::APP_VERSION)).unwrap_or_else(|_| HeaderValue::from_static("BBARIT-Terminal"))
}

/// One request: JSON in, JSON out, answer capped at `MAX_RESPONSE_BYTES`. `bearer` is set as a
/// sensitive header. Reads (`retry_read`) are tried once more after a timeout or a network
/// error; writes never are (the server may have saved them).
pub async fn request(
    http: &reqwest::Client,
    method: Method,
    url: Url,
    bearer: Option<&Token>,
    body: Option<&Value>,
    retry_read: bool,
) -> Result<Value, Failure> {
    let mut tries = 0;
    loop {
        tries += 1;
        match request_once(http, method.clone(), url.clone(), bearer, body).await {
            Err(Failure::Timeout | Failure::Network(_)) if retry_read && tries < 2 => continue,
            other => return other,
        }
    }
}

async fn request_once(http: &reqwest::Client, method: Method, url: Url, bearer: Option<&Token>, body: Option<&Value>) -> Result<Value, Failure> {
    let mut req = http.request(method, url).header(ACCEPT, "application/json").header(USER_AGENT, user_agent());
    if let Some(t) = bearer {
        let mut v = HeaderValue::from_str(&format!("Bearer {}", t.expose())).map_err(|_| Failure::Bad("the saved token is not valid".into()))?;
        v.set_sensitive(true);
        req = req.header(AUTHORIZATION, v);
    }
    if let Some(b) = body {
        req = req.header(CONTENT_TYPE, "application/json").body(serde_json::to_vec(b).map_err(|e| Failure::Bad(e.to_string()))?);
    }
    let mut resp = req.send().await.map_err(net_failure)?;
    let status = resp.status();
    let retry_after = resp.headers().get(RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
    if resp.content_length().is_some_and(|n| n > MAX_RESPONSE_BYTES as u64) {
        return Err(Failure::Bad("the board server's answer is too large".into()));
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_failure)? {
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(Failure::Bad("the board server's answer is too large".into()));
        }
        buf.extend_from_slice(&chunk);
    }
    if status.is_redirection() {
        return Err(Failure::Bad(format!("the board server answered with a redirect ({}); redirects are not followed", status.as_u16())));
    }
    let parsed: Option<Value> = if buf.is_empty() { None } else { serde_json::from_slice(&buf).ok() };
    if status.is_success() {
        return match parsed {
            Some(v) => Ok(clean_value(v)),
            None if buf.is_empty() => Ok(json!({})),
            None => Err(Failure::Bad("the board server's answer is not JSON".into())),
        };
    }
    let v = parsed.unwrap_or(Value::Null);
    let code = v.get("error").and_then(Value::as_str).map(clean_line).unwrap_or_default();
    let message = v.get("message").and_then(Value::as_str).map(clean_line).unwrap_or_default();
    let suspended_until = v.get("suspendedUntil").and_then(Value::as_str).map(clean_line);
    Err(Failure::Status { status: status.as_u16(), code, message, retry_after, suspended_until })
}

fn net_failure(e: reqwest::Error) -> Failure {
    if e.is_timeout() {
        Failure::Timeout
    } else {
        // Without the URL (it holds no token, but keep messages short).
        Failure::Network(clean_line(&e.without_url().to_string()))
    }
}

/// The text a board command prints for a failure. Store refusals (not_found, conflict,
/// forbidden, invalid, lease_lost) keep the store's own message, so they read as in the other
/// modes; transport trouble starts with "team board unavailable" (Settings shows the last one).
pub fn failure_text(f: &Failure, write: bool) -> String {
    match f {
        Failure::Timeout if write => unavailable(
            "the board server did not answer in time; the change may or may not have been saved: read the board before trying again",
        ),
        Failure::Timeout => unavailable("the board server did not answer in time"),
        Failure::Network(e) => unavailable(format!("cannot reach the board server: {e}")),
        Failure::Bad(e) => unavailable(e),
        Failure::Status { status, code, message, retry_after, suspended_until } => {
            let msg = |fallback: &str| if message.is_empty() { fallback.to_string() } else { message.clone() };
            let wait = retry_after.map(|s| format!(" (try again in {s} s)")).unwrap_or_default();
            match (*status, code.as_str()) {
                (401, _) => unavailable(
                    "the board server no longer accepts this computer's sign-in (signed out, revoked or replaced): sign in again in Settings → Agent team board",
                ),
                (403, "account suspended") => unavailable(match suspended_until {
                    Some(t) => format!("your account on the board server is suspended until {t}"),
                    None => "your account on the board server is suspended".to_string(),
                }),
                (_, "not_found" | "conflict" | "forbidden" | "invalid") => msg(code),
                (_, "lease_lost") => msg("lease lost: the task was claimed again or its lease ran out"),
                (_, "outcome_unknown") => unavailable(
                    "the board server could not confirm the change; it may or may not have been saved: read the board before trying again",
                ),
                (_, "busy") => unavailable(format!("the board server is busy{wait}")),
                (_, "unavailable") => unavailable(format!("the board server's database is unavailable{wait}")),
                (_, "rate_limited") | (429, _) => unavailable(format!("too many requests to the board server{wait}")),
                (403, _) => msg("forbidden"),
                (404, _) => msg("not found on the board server (is the address right?)"),
                (s, _) if s >= 500 => unavailable(format!("the board server failed ({s}){}", if message.is_empty() { String::new() } else { format!(": {message}") })),
                (s, _) => {
                    let c = if code.is_empty() { String::new() } else { format!(" {code}") };
                    format!("the board server refused the request ({s}{c}){}", if message.is_empty() { String::new() } else { format!(": {message}") })
                }
            }
        }
    }
}

// ── The client ───────────────────────────────────────────────────────────

/// A signed-in board server: every board operation the app uses.
pub struct Remote {
    pub session: Session,
    http: reqwest::Client,
    base: Url,
    pub book: LeaseBook,
}

/// Who asks for a task write: the tab (the lease book's owner) and the local mode's flags
/// (`root`: the team's root tab; `human`: a person in the viewer). Never sent to the server.
#[derive(Clone, Copy, Debug)]
pub struct Caller<'a> {
    pub tab: &'a str,
    pub root: bool,
    pub human: bool,
}

/// `{team, seq}` pairs handed back by `release_tab` (shape of the store's `release_owner`).
pub type Released = Vec<Value>;

impl Remote {
    pub fn new(session: Session, book: LeaseBook) -> Result<Remote, String> {
        let base = Url::parse(&session.server).map_err(|_| unavailable("invalid board server address"))?;
        Ok(Remote { http: http_client()?, base, session, book })
    }

    fn url(&self, segments: &[&str], query: &[(&str, String)]) -> Url {
        let mut u = self.base.clone();
        if let Ok(mut p) = u.path_segments_mut() {
            p.clear().extend(segments);
        }
        if !query.is_empty() {
            let mut q = u.query_pairs_mut();
            for (k, v) in query {
                q.append_pair(k, v);
            }
        }
        u
    }

    async fn call(&self, method: Method, segments: &[&str], query: &[(&str, String)], body: Option<Value>) -> Result<Value, Failure> {
        let write = method != Method::GET;
        let r = request(&self.http, method, self.url(segments, query), Some(&self.session.token), body.as_ref(), !write).await;
        if let Err(f) = &r {
            diag(&format!("{} {} failed: {}", if write { "write" } else { "read" }, segments.join("/"), failure_text(f, write)), &[self.session.token.expose()]);
        }
        r
    }

    fn text(&self, f: &Failure, write: bool) -> String {
        super::config::redact(&failure_text(f, write), &[self.session.token.expose()])
    }

    /// `agent_board_info` in this mode.
    pub fn info(&self) -> Value {
        json!({
            "instance": self.session.runner_uid,
            "host": self.session.runner_name,
            "backend": "server",
            "mode": "server",
            "server": self.session.server,
            "schemaVersion": Value::Null,
        })
    }

    // ── Notes ──

    pub async fn post(&self, team: &str, input: &PostInput) -> Result<Value, String> {
        check_team(team)?;
        let mut b = Map::new();
        b.insert("kind".into(), json!(input.kind));
        b.insert("text".into(), json!(input.text));
        if let Some(t) = input.task {
            b.insert("task".into(), json!(t));
        }
        if let Some(n) = input.team_name.as_deref().filter(|n| !n.trim().is_empty()) {
            b.insert("teamName".into(), json!(n));
        }
        self.call(Method::POST, &["v1", "teams", team, "posts"], &[], Some(Value::Object(b))).await.map_err(|f| self.text(&f, true))
    }

    pub async fn read(&self, team: &str, q: &ReadQuery) -> Result<Value, String> {
        check_team(team)?;
        if q.cursor_tab.is_some() {
            return Err(format!("{}: read with --since <seq> instead", refused("the read cursor (agent board read --new)")));
        }
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = q.since {
            query.push(("since", v.to_string()));
        }
        if let Some(v) = q.limit {
            query.push(("limit", v.to_string()));
        }
        for (k, v) in [("kind", &q.kind), ("author", &q.author), ("search", &q.search), ("excludeAuthor", &q.exclude_author)] {
            if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
                query.push((k, v.to_string()));
            }
        }
        self.call(Method::GET, &["v1", "teams", team, "posts"], &query, None).await.map_err(|f| self.text(&f, false))
    }

    pub async fn teams(&self) -> Result<Vec<Value>, String> {
        let v = self.call(Method::GET, &["v1", "teams"], &[], None).await.map_err(|f| self.text(&f, false))?;
        Ok(match v {
            Value::Array(a) => a,
            Value::Object(mut o) => match o.remove("teams") {
                Some(Value::Array(a)) => a,
                _ => Vec::new(),
            },
            _ => Vec::new(),
        })
    }

    // ── Tasks ──

    /// One task write. `extra`: the raw request, for the server-only fields `type` and
    /// `decider`. `tab`: the tab that runs it (kept in the lease book after a claim).
    pub async fn task_write(&self, team: &str, op: &TaskOpInput, extra: &Value, tab: &str) -> Result<Value, String> {
        self.task_write_as(team, op, extra, Caller { tab, root: false, human: false }).await
    }

    /// `task_write` for a caller: the app-side rules of the local modes are checked before
    /// anything is sent (the server's own rules apply afterwards):
    /// - a worker operation (block, unblock, release, done, submit, fail) only from the tab that
    ///   holds the task in the lease book; a person never works on a task;
    /// - approve, reject, reopen, cancel of a task another account added, retry past the limit:
    ///   only the team's root tab or a person.
    pub async fn task_write_as(&self, team: &str, op: &TaskOpInput, extra: &Value, caller: Caller<'_>) -> Result<Value, String> {
        check_team(team)?;
        let tab = caller.tab;
        let name = op.op.trim().to_ascii_lowercase().replace('_', "-");
        let next = name == "claim" && op.next;
        let seq_text;
        let segments: Vec<&str> = if name == "add" {
            vec!["v1", "teams", team, "tasks"]
        } else if next {
            vec!["v1", "teams", team, "tasks", "claim-next"]
        } else if TASK_OPS.contains(&name.as_str()) {
            let seq = op.task.ok_or_else(|| format!("{name} needs a task number"))?;
            seq_text = seq.to_string();
            vec!["v1", "teams", team, "tasks", &seq_text, &name]
        } else {
            return Err(format!("unknown task operation: {}", short(&op.op)));
        };
        self.precheck(team, &name, op.task, caller).await?;
        let body = self.task_body(team, &name, next, op, extra);
        let res = self.call(Method::POST, &segments, &[], Some(Value::Object(body))).await;
        let seq = op.task.filter(|_| !next && name != "add");
        let v = match res {
            Ok(v) => v,
            Err(f) => {
                if matches!(&f, Failure::Status { code, .. } if code == "lease_lost") {
                    if let Some(seq) = seq {
                        let _ = self.book.remove(&self.session.server, team, seq);
                    }
                }
                return Err(self.text(&f, true));
            }
        };
        self.note_write(team, &name, seq, &v, tab);
        Ok(v)
    }

    async fn precheck(&self, team: &str, name: &str, seq: Option<i64>, caller: Caller<'_>) -> Result<(), String> {
        let privileged = caller.root || caller.human;
        let n = seq.unwrap_or(0);
        if caller.human && (name == "claim" || WORKER_OPS.contains(&name)) {
            return Err(format!("a person cannot {name} a task: agents claim and work on tasks"));
        }
        if WORKER_OPS.contains(&name) {
            let held = self.book.get(&self.session.server, team, n).is_some_and(|e| e.tab == caller.tab);
            if !held {
                let verb = if name == "done" { "finish" } else { name };
                return Err(format!("#{n} is not held by this tab: only its owner can {verb} it"));
            }
            return Ok(());
        }
        match name {
            "approve" | "reject" if !privileged => Err(format!("#{n}: only the root tab or a person can {name} it")),
            "reopen" if !privileged => Err(format!("#{n}: only the root tab or a person can reopen it")),
            "cancel" | "retry" if !privileged => {
                let s = n.to_string();
                let v = self.call(Method::GET, &["v1", "teams", team, "tasks", &s], &[], None).await.map_err(|f| self.text(&f, false))?;
                let t = v.get("task").unwrap_or(&v);
                if name == "cancel" {
                    let creator = t.pointer("/createdBy/id").and_then(Value::as_str).unwrap_or("");
                    if creator.is_empty() || creator != self.session.account_uid {
                        let who = t.pointer("/createdBy/name").and_then(Value::as_str).filter(|w| !w.is_empty()).unwrap_or("someone else");
                        return Err(format!("#{n} can be cancelled only by who added it ({who}), the root tab or a person"));
                    }
                } else {
                    let (attempt, max) = (t.get("attempt").and_then(Value::as_i64).unwrap_or(0), t.get("maxAttempts").and_then(Value::as_i64).unwrap_or(i64::MAX));
                    if attempt >= max {
                        return Err(format!("#{n} has used its retries (attempt {attempt} of {max}): only the root tab or a person can retry it again"));
                    }
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn task_body(&self, team: &str, name: &str, next: bool, op: &TaskOpInput, extra: &Value) -> Map<String, Value> {
        let mut b = Map::new();
        let mut put = |k: &str, v: Value| {
            if !v.is_null() {
                b.insert(k.to_string(), v);
            }
        };
        if next {
            put("labels", json!(op.labels));
            put("leaseMs", json!(op.lease_ms));
            put("type", extra.get("type").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null));
            return b;
        }
        put("teamName", json!(op.team_name.as_deref().filter(|n| !n.trim().is_empty())));
        put("title", json!(op.title));
        put("body", json!(op.body));
        put("parent", json!(op.parent));
        if !op.after.is_empty() {
            put("after", json!(op.after));
        }
        put("priority", json!(op.priority));
        put("review", json!(op.review));
        put("labels", json!(op.labels));
        put("maxAttempts", json!(op.max_attempts));
        put("reason", json!(op.reason));
        put("error", json!(op.error));
        if let Some(r) = &op.result {
            let mut m = Map::new();
            for (k, v) in [("summary", &r.summary), ("body", &r.body), ("branch", &r.branch), ("commit", &r.commit), ("worktree", &r.worktree), ("checks", &r.checks)] {
                if let Some(v) = v {
                    m.insert(k.into(), json!(v));
                }
            }
            if !r.artifacts.is_empty() {
                m.insert("artifacts".into(), json!(r.artifacts));
            }
            put("result", Value::Object(m));
        }
        put("on", json!(op.on));
        if name == "claim" {
            put("leaseMs", json!(op.lease_ms));
        }
        if name == "edit" {
            put("expectedVersion", json!(op.expected_version));
        }
        if name == "add" || name == "edit" {
            for k in ["type", "decider"] {
                put(k, extra.get(k).filter(|v| v.is_string()).cloned().unwrap_or(Value::Null));
            }
        }
        if WORKER_OPS.contains(&name) {
            if let Some(e) = op.task.and_then(|seq| self.book.get(&self.session.server, team, seq)) {
                put("leaseEpoch", json!(e.lease_epoch));
            }
        }
        b
    }

    /// After a write: a claim records its `leaseEpoch` and attempt id; a task that is no
    /// longer held (done, submitted, released, …) leaves the book.
    fn note_write(&self, team: &str, name: &str, seq: Option<i64>, v: &Value, tab: &str) {
        let task_seq = v.pointer("/task/seq").and_then(Value::as_i64).or(seq);
        let state = v.pointer("/task/state").and_then(Value::as_str).unwrap_or("");
        let server = &self.session.server;
        if name == "claim" {
            if let (Some(seq), Some(epoch)) = (task_seq, v.get("leaseEpoch").and_then(Value::as_i64)) {
                let entry = LeaseEntry {
                    server: server.clone(),
                    team: team.to_string(),
                    seq,
                    lease_epoch: epoch,
                    attempt_id: v.get("attemptId").and_then(Value::as_i64),
                    tab: tab.to_string(),
                    at: now_ms(),
                };
                if let Err(e) = self.book.put(entry) {
                    diag(&format!("cannot save the lease of task #{seq}: {e}"), &[]);
                }
            }
            return;
        }
        if let Some(seq) = task_seq {
            if !matches!(state, "claimed" | "blocked") && self.book.get(server, team, seq).is_some() {
                let _ = self.book.remove(server, team, seq);
            }
        }
    }

    pub async fn task_list(&self, team: &str, q: &TaskListQuery) -> Result<Value, String> {
        check_team(team)?;
        let mut query: Vec<(&str, String)> = Vec::new();
        if !q.states.is_empty() {
            query.push(("state", q.states.join(",")));
        }
        if q.all {
            query.push(("all", "true".into()));
        }
        if q.mine.as_deref().is_some_and(|m| !m.is_empty()) {
            // The server's "mine" is the caller's account (it decides who that is).
            query.push(("mine", "true".into()));
        }
        if q.ready {
            query.push(("ready", "true".into()));
        }
        if let Some(s) = q.search.as_deref().filter(|s| !s.is_empty()) {
            query.push(("search", s.to_string()));
        }
        if let Some(v) = q.limit {
            query.push(("limit", v.to_string()));
        }
        if let Some(v) = q.stale_ms {
            query.push(("staleMs", v.to_string()));
        }
        self.call(Method::GET, &["v1", "teams", team, "tasks"], &query, None).await.map_err(|f| self.text(&f, false))
    }

    pub async fn task_show(&self, team: &str, seq: i64, history: bool, stale_ms: Option<i64>) -> Result<Value, String> {
        check_team(team)?;
        let mut query: Vec<(&str, String)> = Vec::new();
        if history {
            query.push(("history", "true".into()));
        }
        if let Some(v) = stale_ms {
            query.push(("staleMs", v.to_string()));
        }
        let s = seq.to_string();
        self.call(Method::GET, &["v1", "teams", team, "tasks", &s], &query, None).await.map_err(|f| self.text(&f, false))
    }

    pub async fn team_events(&self, team: &str, q: &EventsQuery) -> Result<Value, String> {
        check_team(team)?;
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = q.limit {
            query.push(("limit", v.to_string()));
        }
        if let Some(v) = q.since {
            query.push(("since", v.to_string()));
        }
        self.call(Method::GET, &["v1", "teams", team, "events"], &query, None).await.map_err(|f| self.text(&f, false))
    }

    /// The attempt report of a task this computer holds (the claim's `leaseEpoch` is added).
    /// `report`: `{workerName?, product?, model?, started?, checkpoint?, tokens?, costUsdEstimate?,
    /// usageSource?, result?}` as the server takes it.
    /// No caller yet: the app records no token numbers or results per attempt (the board
    /// server's runners do); kept here so the client covers the route.
    #[allow(dead_code)]
    pub async fn attempt_report(&self, team: &str, seq: i64, tab: &str, report: &Value) -> Result<Value, String> {
        check_team(team)?;
        let entry = self
            .book
            .get(&self.session.server, team, seq)
            .filter(|e| e.tab == tab)
            .ok_or_else(|| format!("#{seq} is not held by this tab: only its owner can report on it"))?;
        let mut body = report.as_object().cloned().unwrap_or_default();
        body.insert("leaseEpoch".into(), json!(entry.lease_epoch));
        let s = seq.to_string();
        let r = self.call(Method::POST, &["v1", "teams", team, "tasks", &s, "attempt"], &[], Some(Value::Object(body))).await;
        r.map_err(|f| {
            if matches!(&f, Failure::Status { code, .. } if code == "lease_lost") {
                let _ = self.book.remove(&self.session.server, team, seq);
            }
            self.text(&f, true)
        })
    }

    // ── Leases ──

    /// Hand back every task `tab` holds through this computer (the store's `release_owner`).
    pub async fn release_tab(&self, tab: &str, reason: &str) -> Result<Released, String> {
        let mut released = Vec::new();
        let mut failed = None;
        for e in self.book.entries(&self.session.server).into_iter().filter(|e| e.tab == tab) {
            let s = e.seq.to_string();
            let body = json!({ "leaseEpoch": e.lease_epoch, "reason": reason });
            match self.call(Method::POST, &["v1", "teams", &e.team, "tasks", &s, "release"], &[], Some(body)).await {
                Ok(v) => {
                    let _ = self.book.remove(&self.session.server, &e.team, e.seq);
                    released.push(json!({ "team": e.team, "seq": e.seq, "from": v.get("from").cloned().unwrap_or(json!("claimed")), "ownerId": tab }));
                }
                // Nothing left to hand back: the lease is gone or the task moved on.
                Err(Failure::Status { code, .. }) if matches!(code.as_str(), "lease_lost" | "not_found" | "conflict") => {
                    let _ = self.book.remove(&self.session.server, &e.team, e.seq);
                }
                Err(f) => failed = Some(self.text(&f, true)),
            }
        }
        match failed {
            Some(e) if released.is_empty() => Err(e),
            _ => Ok(released),
        }
    }

    /// One lease tick: tasks whose tab's PTY is gone are handed back, the others renewed with
    /// their `leaseEpoch`; entries the server lists as `lost` leave the book. Returns what was
    /// released and whether anything is still held.
    pub async fn lease_tick(&self, lease_ms: i64, exiting: bool, ready: bool, alive: &(dyn Fn(&str) -> bool + Sync)) -> Result<(Released, bool), String> {
        let server = self.session.server.clone();
        let entries = self.book.entries(&server);
        if entries.is_empty() {
            return Ok((Vec::new(), false));
        }
        let mut tabs: Vec<String> = entries.iter().map(|e| e.tab.clone()).collect();
        tabs.sort();
        tabs.dedup();
        let plan = plan_lease_tick(&tabs, exiting, ready, alive);
        let mut released = Vec::new();
        let mut failed = None;
        for tab in &plan.release {
            match self.release_tab(tab, "owner tab is gone").await {
                Ok(r) => released.extend(r),
                Err(e) => failed = Some(e),
            }
        }
        let kept: Vec<&LeaseEntry> = entries.iter().filter(|e| plan.renew.contains(&e.tab)).collect();
        if !kept.is_empty() && self.session.account_uid.trim().is_empty() {
            failed = Some(unavailable("this sign-in has no account id: sign in to the board server again"));
        } else if !kept.is_empty() {
            let tasks: Vec<Value> = kept.iter().map(|e| json!({ "team": e.team, "seq": e.seq, "leaseEpoch": e.lease_epoch })).collect();
            let body = json!({ "alive": [self.session.account_uid], "leaseMs": lease_ms, "tasks": tasks });
            match self.call(Method::POST, &["v1", "leases", "tick"], &[], Some(body)).await {
                Ok(v) => {
                    for l in v.get("lost").and_then(Value::as_array).into_iter().flatten() {
                        if let (Some(team), Some(seq)) = (l.get("team").and_then(Value::as_str), l.get("seq").and_then(Value::as_i64)) {
                            let _ = self.book.remove(&server, team, seq);
                        }
                    }
                }
                Err(f) => failed = Some(self.text(&f, true)),
            }
        }
        let holding = !self.book.entries(&server).is_empty();
        match failed {
            Some(e) => Err(e),
            None => Ok((released, holding)),
        }
    }

    // ── Account ──

    /// `GET /v1/me`.
    pub async fn me(&self) -> Result<Value, Failure> {
        self.call(Method::GET, &["v1", "me"], &[], None).await
    }

    /// Revoke this computer on the server (`DELETE /v1/me/runners/{uid}`, the uid from `/v1/me`).
    /// Ok(false) when the server no longer accepted the token (nothing left to revoke).
    pub async fn revoke_self(&self) -> Result<bool, String> {
        let me = match self.me().await {
            Ok(v) => v,
            Err(Failure::Status { status: 401, .. }) => return Ok(false),
            Err(f) => return Err(self.text(&f, false)),
        };
        let uid = me
            .pointer("/runner/uid")
            .and_then(Value::as_str)
            .filter(|u| is_uuid(u))
            .ok_or_else(|| "the board server did not say which computer this token belongs to".to_string())?
            .to_string();
        match self.call(Method::DELETE, &["v1", "me", "runners", &uid], &[], None).await {
            Ok(_) => Ok(true),
            Err(Failure::Status { status: 401, .. }) => Ok(false),
            Err(f) => Err(self.text(&f, true)),
        }
    }
}

/// `8-4-4-4-12` hexadecimal digits (before a uid goes into a request path).
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

// ── The active client ────────────────────────────────────────────────────

/// The board server client when `agents.board.mode` is `server`: None in the other modes; an
/// error ("team board unavailable: …") when the address is not usable or this computer is not
/// signed in to that server. Cached until the address or the token changes.
pub fn active() -> Result<Option<Arc<Remote>>, String> {
    let sel = super::read_selection();
    if sel.mode.mode != super::config::BoardMode::Server {
        return Ok(None);
    }
    let session = resolve_session(&sel.server_url, &super::server_login::token_path()?)?;
    static CACHE: Mutex<Option<(String, Arc<Remote>)>> = Mutex::new(None);
    let key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&session.server, session.token.expose()).hash(&mut h);
        format!("{:x}", h.finish())
    };
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((k, r)) = guard.as_ref() {
        if *k == key {
            return Ok(Some(r.clone()));
        }
    }
    let r = Arc::new(Remote::new(session, LeaseBook::new(super::server_login::leases_path()?))?);
    *guard = Some((key, r.clone()));
    Ok(Some(r))
}

/// The saved sign-in for the configured address, or "team board unavailable: …" when the
/// address is unusable, nobody signed in, or the sign-in is for another server.
pub fn resolve_session(server_url: &str, token_file: &Path) -> Result<Session, String> {
    let server = check_server_url(server_url).map_err(unavailable)?;
    let session = super::server_login::load_session(token_file)
        .map_err(unavailable)?
        .ok_or_else(|| unavailable("this computer is not signed in to the board server (Settings → Agent team board)"))?;
    if session.server != server {
        return Err(unavailable(format!(
            "this computer is signed in to {}, but the board server address is {server}: sign in again",
            session.server
        )));
    }
    Ok(session)
}

/// Whether the configured mode is `server` (no file or network access).
pub fn server_mode() -> bool {
    super::read_selection().mode.mode == super::config::BoardMode::Server
}

/// Refuse `what` in server mode (Settings and app operations the server does not offer).
pub fn refuse_in_server_mode(what: &str) -> Result<(), String> {
    if server_mode() {
        Err(refused(what))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
