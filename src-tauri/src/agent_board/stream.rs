//! Board server mode: the server's change stream (`GET /v1/stream`, Server-Sent Events) turned
//! into the app's `octo-agent-board` event, so open Team status views refresh through their
//! own loader without waiting for the next poll.
//!
//! One subscriber for the whole app (a tokio task started at app setup). It runs only while
//! `remote::active()` gives a client (usage type `server`, an address and a sign-in for it) and
//! the agent team switch is on. That is checked every `Timing::check` (3 s) off the async threads
//! (config.json and the token file are read with `spawn_blocking`), so signing out, another
//! address or another usage type ends the connection within about 3 s. It resumes with
//! `Last-Event-ID` (the last `id` seen, also from heartbeats), backs off exponentially with jitter
//! up to 60 s, on 429/503 waits the longer of `Retry-After` (at most 10 min) and the back-off
//! (at least 1 s), and on 401 stops until the sign-in changes. A connection counts as healthy
//! (the back-off starts over) only when it stayed open `Timing::healthy` or delivered an event id.
//! Each changed team is announced at most once per `Timing::debounce` (the first change at once,
//! later ones together at the end of the window); a `reset` event, or more than
//! `MAX_TEAMS_PER_WINDOW` teams in one window, announces every team (`team: ""`). Events carry no
//! board text and the app only reads `team` from them; the token is only an Authorization header.

use super::remote::{self, diag, Token};
use reqwest::header::{HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER, USER_AGENT};
use reqwest::Url;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

/// Longest SSE line or event the app keeps; a longer one ends the connection (resumed by id).
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// Longest `Retry-After` honoured (a server asking for more is asked again after this).
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(600);
/// Shortest wait after a 429/503.
pub const MIN_BUSY_WAIT: Duration = Duration::from_secs(1);
/// Distinct teams announced one by one in one debounce window; past this, one "every team".
pub const MAX_TEAMS_PER_WINDOW: usize = 64;

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// First back-off step; doubles per failure in a row.
    pub base: Duration,
    /// Longest back-off.
    pub cap: Duration,
    /// How often the wanted connection (mode, address, sign-in) is checked again (file reads).
    pub check: Duration,
    /// How often waiting announcements are flushed and the exit flag is looked at (no I/O).
    pub tick: Duration,
    /// At most one announcement per team per this long.
    pub debounce: Duration,
    /// No byte for this long (the server sends a heartbeat about every 20 s): reconnect.
    pub idle: Duration,
    /// Time to the response headers.
    pub connect: Duration,
    /// A connection open this long (or one that delivered an event id) was healthy.
    pub healthy: Duration,
    /// After a 403 (account suspended) the stream is tried again after this long.
    pub suspended: Duration,
}

pub const TIMING: Timing = Timing {
    base: Duration::from_secs(1),
    cap: Duration::from_secs(60),
    check: Duration::from_secs(3),
    tick: Duration::from_millis(100),
    debounce: Duration::from_millis(500),
    idle: Duration::from_secs(65),
    connect: Duration::from_secs(15),
    healthy: Duration::from_secs(30),
    suspended: Duration::from_secs(600),
};

/// Where to connect: the signed-in server and its token.
#[derive(Clone)]
pub struct Target {
    pub server: String,
    pub token: Token,
}

impl Target {
    /// Changes when the server or the sign-in changes (the token itself is never kept as text).
    fn key(&self) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&self.server, self.token.expose()).hash(&mut h);
        format!("{}#{:x}", self.server, h.finish())
    }
}

// ── SSE parsing ──────────────────────────────────────────────────────────

/// One dispatched SSE block (fields as the spec defines them; comments dropped).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
    pub retry: Option<u64>,
}

/// Incremental parser: bytes in, frames out (lines end in LF, CRLF or CR).
#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    cur: Frame,
    has_field: bool,
    last_cr: bool,
}

impl SseParser {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, String> {
        let mut out = Vec::new();
        for &b in bytes {
            if self.last_cr {
                self.last_cr = false;
                if b == b'\n' {
                    continue;
                }
            }
            match b {
                b'\n' | b'\r' => {
                    self.last_cr = b == b'\r';
                    let line = std::mem::take(&mut self.line);
                    if let Some(f) = self.line_done(&line) {
                        out.push(f);
                    }
                }
                _ => {
                    if self.line.len() >= MAX_LINE_BYTES {
                        return Err("a stream line is too long".into());
                    }
                    self.line.push(b);
                }
            }
        }
        Ok(out)
    }

    fn line_done(&mut self, line: &[u8]) -> Option<Frame> {
        if line.is_empty() {
            let has = std::mem::take(&mut self.has_field);
            let f = std::mem::take(&mut self.cur);
            return has.then_some(f);
        }
        if line[0] == b':' {
            return None;
        }
        let text = String::from_utf8_lossy(line);
        let (name, value) = match text.find(':') {
            Some(i) => (&text[..i], text[i + 1..].strip_prefix(' ').unwrap_or(&text[i + 1..])),
            None => (&text[..], ""),
        };
        match name {
            "id" if !value.contains('\0') => {
                self.cur.id = Some(value.to_string());
                self.has_field = true;
            }
            "event" => {
                self.cur.event = Some(value.to_string());
                self.has_field = true;
            }
            "data" => {
                if self.cur.data.len() + value.len() < MAX_LINE_BYTES {
                    if self.has_field && !self.cur.data.is_empty() {
                        self.cur.data.push('\n');
                    }
                    self.cur.data.push_str(value);
                }
                self.has_field = true;
            }
            "retry" => {
                if let Ok(ms) = value.parse::<u64>() {
                    self.cur.retry = Some(ms);
                    self.has_field = true;
                }
            }
            _ => {}
        }
        None
    }
}

/// A resume id the app sends back: digits only (the server's ids are numbers).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

/// The team a change event names (`data.team`), when it is a valid team id.
pub fn team_of(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    let team = v.get("team")?.as_str()?;
    let ok = !team.is_empty() && team.len() <= 128 && team.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| team.to_string())
}

// ── Debounce ─────────────────────────────────────────────────────────────

/// At most one announcement per team per `window`: the first change at once, the rest of the
/// window's changes as one announcement when it ends. More than `cap` distinct teams in a window
/// (or a `reset`) become one "every team" (`""`); until that window ends no team is tracked, and
/// a change meanwhile gives one more "every team" when it ends. Memory stays below `cap` teams.
pub struct Debounce {
    window: Duration,
    cap: usize,
    last: HashMap<String, Instant>,
    pending: BTreeSet<String>,
    all_until: Option<Instant>,
    all_pending: bool,
}

impl Debounce {
    pub fn new(window: Duration) -> Debounce {
        Debounce::with_cap(window, MAX_TEAMS_PER_WINDOW)
    }

    pub fn with_cap(window: Duration, cap: usize) -> Debounce {
        Debounce { window, cap: cap.max(1), last: HashMap::new(), pending: BTreeSet::new(), all_until: None, all_pending: false }
    }

    fn saturate(&mut self, now: Instant) {
        self.last.clear();
        self.pending.clear();
        self.all_until = Some(now + self.window);
        self.all_pending = false;
    }

    /// A change of `team` at `now`: Some(team) to announce now (`""` = every team), None when it waits.
    pub fn mark(&mut self, team: &str, now: Instant) -> Option<String> {
        if let Some(until) = self.all_until {
            if now < until {
                self.all_pending = true;
                return None;
            }
        }
        if let Some(at) = self.last.get(team) {
            if now.duration_since(*at) < self.window {
                self.pending.insert(team.to_string());
                return None;
            }
        }
        let window = self.window;
        let pending = &self.pending;
        self.last.retain(|t, at| now.duration_since(*at) < window || pending.contains(t));
        if !self.last.contains_key(team) && self.last.len() >= self.cap {
            self.saturate(now);
            return Some(String::new());
        }
        self.last.insert(team.to_string(), now);
        Some(team.to_string())
    }

    /// Announcements due at `now` (`""` = every team).
    pub fn due(&mut self, now: Instant) -> Vec<String> {
        if let Some(until) = self.all_until {
            if now < until {
                return Vec::new();
            }
            self.all_until = None;
            if self.all_pending {
                self.saturate(now);
                return vec![String::new()];
            }
        }
        let window = self.window;
        let ready: Vec<String> = self
            .pending
            .iter()
            .filter(|t| self.last.get(*t).map_or(true, |at| now.duration_since(*at) >= window))
            .cloned()
            .collect();
        for t in &ready {
            self.pending.remove(t);
            self.last.insert(t.clone(), now);
        }
        self.last.retain(|t, at| now.duration_since(*at) < window || self.pending.contains(t));
        ready
    }

    /// Everything is announced at once (`reset`): nothing waits any more.
    pub fn all(&mut self, now: Instant) {
        self.saturate(now);
    }

    /// Teams tracked now (bounded by the cap).
    pub fn tracked(&self) -> usize {
        self.last.len()
    }
}

// ── Back-off ─────────────────────────────────────────────────────────────

/// Wait before the next try after `failures` failures in a row: base·2^(n-1), capped, with up to
/// ±20 % jitter (`jitter` in 0..1) so many computers do not reconnect together.
pub fn backoff(failures: u32, t: &Timing, jitter: f64) -> Duration {
    let n = failures.max(1).min(16) - 1;
    let raw = t.base.saturating_mul(1u32 << n).min(t.cap);
    let f = 0.8 + 0.4 * jitter.clamp(0.0, 1.0);
    raw.mul_f64(f).min(t.cap)
}

/// `Retry-After` in seconds (an HTTP date is not used by the server).
fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let s = resp.headers().get(RETRY_AFTER)?.to_str().ok()?.trim().parse::<u64>().ok()?;
    Some(Duration::from_secs(s))
}

/// Wait after a 429/503: the longer of `Retry-After` (at most `MAX_RETRY_AFTER`) and the
/// back-off, never below `MIN_BUSY_WAIT`.
pub fn busy_wait(retry_after: Option<Duration>, failures: u32, t: &Timing, jitter: f64) -> Duration {
    let b = backoff(failures, t, jitter);
    retry_after.map_or(b, |ra| ra.min(MAX_RETRY_AFTER).max(b)).max(MIN_BUSY_WAIT)
}

// ── The subscriber ───────────────────────────────────────────────────────

/// The stream client: connect 5 s, no total timeout (a stream stays open), no redirects, no
/// proxy from the environment, rustls.
pub fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(remote::CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .use_rustls_tls()
        .build()
        .map_err(|e| format!("cannot set up the board server stream client: {}", e.without_url()))
}

enum End {
    /// The wanted connection changed (signed out, other address or usage type, app exit).
    Stopped,
    /// 401: the sign-in is no longer accepted; wait for a new one.
    Unauthorized,
    /// 429/503 (with the server's Retry-After, if any).
    Busy(Option<Duration>),
    /// 403 (account suspended).
    Suspended,
    /// Could not connect, a bad answer or no byte for `idle`.
    Failed,
    /// The server ended the stream; `healthy`: it stayed open `Timing::healthy` or sent an id.
    Closed { healthy: bool },
}

/// What the subscriber needs from the app (injected so tests run it against a mock server).
pub struct Deps<W, E, S>
where
    W: Fn() -> Option<Target> + Clone + Send + 'static,
    E: Fn(&str),
    S: Fn() -> bool,
{
    /// The connection wanted now (None: none). May read files: always run with `spawn_blocking`.
    pub want: W,
    /// Announce a changed team ("" = every team).
    pub emit: E,
    /// The app is exiting.
    pub stop: S,
    pub timing: Timing,
}

struct Run<'a, W, E, S>
where
    W: Fn() -> Option<Target> + Clone + Send + 'static,
    E: Fn(&str),
    S: Fn() -> bool,
{
    d: &'a Deps<W, E, S>,
    http: reqwest::Client,
    last_id: Option<String>,
    retry_hint: Option<Duration>,
    debounce: Debounce,
    /// The connection wanted at the last check, and when that was.
    wanted: Option<Target>,
    checked: Option<Instant>,
    /// The current connection delivered an event id.
    got_id: bool,
}

impl<W, E, S> Run<'_, W, E, S>
where
    W: Fn() -> Option<Target> + Clone + Send + 'static,
    E: Fn(&str),
    S: Fn() -> bool,
{
    /// The wanted connection, read again (off the async threads) once `Timing::check` passed.
    async fn wanted(&mut self) -> Option<Target> {
        if self.checked.map_or(true, |at| at.elapsed() >= self.d.timing.check) {
            let want = self.d.want.clone();
            self.wanted = tokio::task::spawn_blocking(want).await.ok().flatten();
            self.checked = Some(Instant::now());
        }
        self.wanted.clone()
    }

    async fn still(&mut self, key: &str) -> bool {
        !(self.d.stop)() && self.wanted().await.is_some_and(|t| t.key() == key)
    }

    fn flush(&mut self) {
        for team in self.debounce.due(Instant::now()) {
            (self.d.emit)(&team);
        }
    }

    /// Sleep `total`, waking every `check` to flush announcements; false when the wanted
    /// connection changed meanwhile.
    async fn wait(&mut self, total: Duration, key: &str) -> bool {
        let until = Instant::now() + total;
        loop {
            self.flush();
            if !self.still(key).await {
                return false;
            }
            let now = Instant::now();
            if now >= until {
                return true;
            }
            tokio::time::sleep((until - now).min(self.d.timing.tick)).await;
        }
    }

    fn handle(&mut self, f: Frame) {
        if let Some(ms) = f.retry {
            self.retry_hint = Some(Duration::from_millis(ms).min(self.d.timing.cap));
        }
        if f.event.as_deref() == Some("reset") {
            // The cursor is outside what the server keeps: every team is re-read, and without
            // a new id the next connection starts at the head.
            self.debounce.all(Instant::now());
            (self.d.emit)("");
            if !f.id.as_deref().is_some_and(valid_id) {
                self.last_id = None;
            }
        } else if !f.data.is_empty() {
            if let Some(team) = team_of(&f.data) {
                if let Some(t) = self.debounce.mark(&team, Instant::now()) {
                    (self.d.emit)(&t);
                }
            }
        }
        if let Some(id) = f.id.filter(|i| valid_id(i)) {
            self.last_id = Some(id);
            self.got_id = true;
        }
    }

    async fn session(&mut self, target: &Target, key: &str) -> End {
        let url = match Url::parse(&target.server).and_then(|u| u.join("/v1/stream")) {
            Ok(u) => u,
            Err(_) => return End::Failed,
        };
        let mut auth = match HeaderValue::from_str(&format!("Bearer {}", target.token.expose())) {
            Ok(v) => v,
            Err(_) => return End::Unauthorized,
        };
        auth.set_sensitive(true);
        let ua = HeaderValue::from_str(&format!("BBARIT-Terminal/{}", super::APP_VERSION)).unwrap_or_else(|_| HeaderValue::from_static("BBARIT-Terminal"));
        let mut req = self.http.get(url).header(ACCEPT, "text/event-stream").header(USER_AGENT, ua).header(AUTHORIZATION, auth);
        if let Some(id) = &self.last_id {
            req = req.header("Last-Event-ID", id.as_str());
        }
        let mut resp = match tokio::time::timeout(self.d.timing.connect, req.send()).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                diag(&format!("stream: cannot connect: {}", e.without_url()), &[target.token.expose()]);
                return End::Failed;
            }
            Err(_) => return End::Failed,
        };
        let status = resp.status().as_u16();
        match status {
            200 => {}
            401 => return End::Unauthorized,
            403 => return End::Suspended,
            429 | 503 => return End::Busy(retry_after(&resp)),
            _ => {
                diag(&format!("stream: the board server answered {status}"), &[target.token.expose()]);
                return End::Failed;
            }
        }
        let is_sse = resp.headers().get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.to_ascii_lowercase().starts_with("text/event-stream"));
        if !is_sse {
            return End::Failed;
        }
        let mut parser = SseParser::default();
        let opened = Instant::now();
        self.got_id = false;
        let healthy = |r: &Self| r.got_id || opened.elapsed() >= r.d.timing.healthy;
        let mut tick = tokio::time::interval(self.d.timing.tick);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last_byte = Instant::now();
        loop {
            tokio::select! {
                chunk = resp.chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        last_byte = Instant::now();
                        match parser.feed(&bytes) {
                            Ok(frames) => frames.into_iter().for_each(|f| self.handle(f)),
                            Err(_) => return End::Closed { healthy: healthy(self) },
                        }
                    }
                    Ok(None) | Err(_) => return End::Closed { healthy: healthy(self) },
                },
                _ = tick.tick() => {
                    self.flush();
                    if !self.still(key).await {
                        return End::Stopped;
                    }
                    if last_byte.elapsed() >= self.d.timing.idle {
                        return End::Closed { healthy: healthy(self) };
                    }
                }
            }
        }
    }
}

/// The subscriber loop; returns when `stop` says the app exits.
pub async fn run<W, E, S>(d: Deps<W, E, S>)
where
    W: Fn() -> Option<Target> + Clone + Send + 'static,
    E: Fn(&str),
    S: Fn() -> bool,
{
    let http = match stream_client() {
        Ok(h) => h,
        Err(e) => {
            diag(&e, &[]);
            return;
        }
    };
    let mut r = Run { d: &d, http, last_id: None, retry_hint: None, debounce: Debounce::new(d.timing.debounce), wanted: None, checked: None, got_id: false };
    let mut server: Option<String> = None;
    let mut blocked: Option<String> = None;
    let mut failures = 0u32;
    let mut connected_before = false;
    loop {
        if (r.d.stop)() {
            return;
        }
        r.flush();
        let Some(target) = r.wanted().await else {
            blocked = None;
            tokio::time::sleep(r.d.timing.tick).await;
            continue;
        };
        let key = target.key();
        if blocked.as_deref() == Some(key.as_str()) {
            tokio::time::sleep(r.d.timing.tick).await;
            continue;
        }
        blocked = None;
        if server.as_deref() != Some(target.server.as_str()) {
            // Ids and the retry hint belong to one server.
            server = Some(target.server.clone());
            r.last_id = None;
            r.retry_hint = None;
            connected_before = false;
            failures = 0;
        }
        // A reconnect without an id to resume from starts at the head: changes in between were
        // missed, so every open view reads again once.
        if connected_before && r.last_id.is_none() {
            (r.d.emit)("");
        }
        let end = r.session(&target, &key).await;
        match end {
            End::Stopped => continue,
            End::Unauthorized => {
                diag("stream: the board server no longer accepts this sign-in; waiting for a new one", &[target.token.expose()]);
                blocked = Some(key);
            }
            End::Busy(ra) => {
                failures = failures.saturating_add(1);
                let d = busy_wait(ra, failures, &r.d.timing, rand::random());
                r.wait(d, &key).await;
            }
            End::Suspended => {
                failures = failures.saturating_add(1);
                let d = r.d.timing.suspended;
                r.wait(d, &key).await;
            }
            End::Failed => {
                failures = failures.saturating_add(1);
                let d = backoff(failures, &r.d.timing, rand::random());
                r.wait(d, &key).await;
            }
            End::Closed { healthy } => {
                connected_before = true;
                // A connection that sends a byte and closes must not reconnect at full speed.
                failures = if healthy { 1 } else { failures.saturating_add(1) };
                let d = backoff(failures, &r.d.timing, rand::random()).max(r.retry_hint.unwrap_or_default());
                r.wait(d, &key).await;
            }
        }
    }
}

/// Start the subscriber (app setup). Idle unless the usage type is `server`, this computer is
/// signed in for the configured address and the agent team switch is on.
pub fn start_stream_worker(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        run(Deps {
            want: || {
                if !super::agents_enabled() {
                    return None;
                }
                remote::active().ok().flatten().map(|c| Target { server: c.session.server.clone(), token: c.session.token.clone() })
            },
            emit: |team: &str| {
                let _ = app.emit("octo-agent-board", serde_json::json!({ "team": team, "action": "server" }));
            },
            stop: super::exiting,
            timing: TIMING,
        })
        .await;
    });
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
