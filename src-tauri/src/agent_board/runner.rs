//! The runner for a board server: a separate command-line program the person installs, signs in
//! and configures themselves. Settings (Agent team board → Board server → Runner) shows its state
//! and starts or stops it through the `board_runner_*` commands below.
//!
//! What holds:
//! - The program's path is read from config.json (`agents.board.server.runnerPath`) by each
//!   command itself; no command that runs the program takes a path (or anything else) from the
//!   webview. `board_runner_check_path` only checks a path before Settings saves it and runs
//!   nothing.
//! - Every run is an argument vector (no shell) with a timeout and a cap on captured output, the
//!   board server address of the current usage type passed as `--server`.
//! - Whatever the program prints is untrusted: it is parsed as JSON, then only known fields are
//!   kept, as cleaned text of a capped length, before the webview sees it.
//! - `runner run` is started in its own session (setsid, reaped by a thread of this app, the way
//!   the PTY holder's fallback starts), without `BBARIT_TERM_SCOPE`, so neither quitting the app
//!   nor closing a tab stops it. Its output is appended to `~/.config/octo/run/board-runner[.dev].log`
//!   (0600; moved to `….log.1` at a start once it passes 5 MiB). Other runs (status, stop,
//!   version) get their own process group, killed as a whole on a timeout.
//!
//! Plain Tauri commands, not `agent.*` UI commands, so agents cannot reach them through
//! `bbarit-ctl`; they are not on the remote secretary allowlist either. macOS and Linux only:
//! elsewhere every command answers `unsupported`.

use super::model::is_format_char;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `runner status --json`.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
/// `runner stop` (the answer; the stop itself is confirmed with status afterwards).
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
/// How long Start and Stop wait for status to confirm the change.
pub const CONFIRM_WAIT: Duration = Duration::from_secs(10);
pub const CONFIRM_POLL: Duration = Duration::from_millis(500);
/// Captured standard output (more is an error) and standard error (more is cut).
pub const OUTPUT_CAP: usize = 1024 * 1024;
pub const STDERR_CAP: usize = 64 * 1024;
/// Longest error detail the webview gets.
pub const DETAIL_CAP: usize = 2000;
pub const PATH_MAX_CHARS: usize = 4096;
pub const LOG_FILE: &str = if cfg!(debug_assertions) { "board-runner.dev.log" } else { "board-runner.log" };
/// A log larger than this is moved to `<name>.1` when a start begins (one older copy is kept).
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// After the program exits, how long its output may still take to close (something it left
/// behind can hold the pipes open; it is stopped then).
pub const OUTPUT_GRACE: Duration = Duration::from_millis(500);
/// `agents.board.server.<PATH_KEY>` in config.json.
pub const PATH_KEY: &str = "runnerPath";

// Caps for the fields kept from `runner status --json`.
const MAX_ITEMS: usize = 64;
const MAX_LIMITED: usize = 16;
const MAX_PROFILE_ITEMS: usize = 32;

/// What the webview gets when a command fails: a stable `kind` it translates and the details
/// (cleaned, capped text; for `failed` the program's own standard error).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunnerError {
    pub kind: &'static str,
    pub detail: String,
}

impl RunnerError {
    pub fn new(kind: &'static str, detail: impl AsRef<str>) -> Self {
        Self { kind, detail: cap_text(detail.as_ref(), DETAIL_CAP) }
    }
}

impl std::fmt::Display for RunnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            write!(f, "{}", self.kind)
        } else {
            write!(f, "{}: {}", self.kind, self.detail)
        }
    }
}

/// Keep newlines and tabs, drop every other control and format character, trim, and cut to `max`
/// characters (an ellipsis marks a cut).
pub fn cap_text(s: &str, max: usize) -> String {
    let kept: String = s.chars().filter(|c| (*c == '\n' || *c == '\t' || !c.is_control()) && !is_format_char(*c)).collect();
    let kept = kept.trim();
    if kept.chars().count() <= max {
        return kept.to_string();
    }
    let mut out: String = kept.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// One line: no control or format characters at all, cut to `max` characters.
pub fn cap_line(s: &str, max: usize) -> String {
    let line: String = s.chars().map(|c| if c == '\n' || c == '\t' { ' ' } else { c }).collect();
    cap_text(&line, max)
}

// ── Configuration ────────────────────────────────────────────────────────

/// `agents.board.server.runnerPath` as saved (trimmed; empty when missing).
pub fn runner_path_from_config(cfg: Option<&Value>) -> String {
    cfg.and_then(|c| c.get("agents"))
        .and_then(|a| a.get("board"))
        .and_then(|b| b.get("server"))
        .and_then(|s| s.get(PATH_KEY))
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The program at `raw` when it is an absolute path to an existing, executable regular file.
pub fn check_program_path(raw: &str) -> Result<PathBuf, RunnerError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(RunnerError::new("no_path", ""));
    }
    if s.chars().count() > PATH_MAX_CHARS || s.chars().any(|c| c.is_control() || is_format_char(c)) {
        return Err(RunnerError::new("bad_path", "the path has control characters or is too long"));
    }
    let path = PathBuf::from(s);
    if !path.is_absolute() {
        return Err(RunnerError::new("not_absolute", s));
    }
    // A symbolic link (a package manager's usual install) is followed to the file it names.
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RunnerError::new("not_found", s)),
        Err(e) => return Err(RunnerError::new("io", format!("{s}: {e}"))),
    };
    if !meta.is_file() {
        return Err(RunnerError::new("not_file", s));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err(RunnerError::new("not_executable", s));
        }
    }
    Ok(path)
}

/// The program and the board server address a command runs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub program: PathBuf,
    pub server: String,
}

/// Everything from config.json (`cfg`): the usage type must be `server` with a usable address
/// (`need_server`), and the saved program path must pass `check_program_path`.
pub fn target_from_config(cfg: Option<&Value>, need_server: bool) -> Result<Target, RunnerError> {
    if !cfg!(unix) {
        return Err(RunnerError::new("unsupported", ""));
    }
    let board = cfg.and_then(|c| c.get("agents")).and_then(|a| a.get("board"));
    let mut server = String::new();
    if need_server {
        if super::config::parse_mode(board).mode != super::config::BoardMode::Server {
            return Err(RunnerError::new("not_server_mode", ""));
        }
        server = super::remote::check_server_url(&super::config::server_url_from_board(board)).map_err(|e| RunnerError::new("bad_server", e))?;
    }
    let program = check_program_path(&runner_path_from_config(cfg))?;
    Ok(Target { program, server })
}

/// What the commands run with: config.json as it is now (never anything from the webview).
fn current_target(need_server: bool) -> Result<Target, RunnerError> {
    target_from_config(crate::read_octo_config_json().as_ref(), need_server)
}

// ── Arguments and the command ────────────────────────────────────────────

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

pub fn status_args(server: &str) -> Vec<String> {
    args(&["runner", "status", "--json", "--server", server])
}

pub fn run_args(server: &str) -> Vec<String> {
    args(&["runner", "run", "--server", server])
}

pub fn stop_args(server: &str) -> Vec<String> {
    args(&["runner", "stop", "--server", server])
}

pub fn version_args() -> Vec<String> {
    args(&["version"])
}

/// PATH for the program: the usual user install folders first (an installed app starts with
/// launchd's minimal PATH), then the app's own.
pub fn search_path(home: &str, existing: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !home.is_empty() {
        parts.push(format!("{home}/.local/bin"));
        parts.push(format!("{home}/.cargo/bin"));
    }
    parts.push("/opt/homebrew/bin".into());
    parts.push("/usr/local/bin".into());
    if !existing.is_empty() {
        parts.push(existing.to_string());
    }
    parts.join(":")
}

/// `program args…` with no shell, standard input closed, working folder home, and without a
/// tab's scope token (the sweep of that tab would stop it) or the embedded agent's mode gate.
pub fn base_command(program: &Path, argv: &[String]) -> std::process::Command {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut cmd = crate::common::no_window_command(program);
    cmd.args(argv)
        .env_remove(crate::SCOPE_ENV)
        .env_remove("BBARIT_AGENT_MODE")
        .env("PATH", search_path(&home, &std::env::var("PATH").unwrap_or_default()))
        .current_dir(if home.is_empty() || !Path::new(&home).is_dir() { "/".to_string() } else { home })
        .stdin(std::process::Stdio::null());
    cmd
}

// ── Running it ───────────────────────────────────────────────────────────

/// What a finished run printed (each stream capped).
#[derive(Debug)]
pub struct Captured {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    /// Standard output was longer than the cap (what is kept is the start).
    pub stdout_over: bool,
    pub stderr: Vec<u8>,
}

/// What a reader kept so far: at most its cap, and whether there was more.
#[derive(Default)]
struct Sink {
    buf: Vec<u8>,
    over: bool,
}

type SharedSink = std::sync::Arc<std::sync::Mutex<Sink>>;

/// Read to the end into `sink`, keeping at most `cap` bytes (the rest is read and dropped, so the
/// program never blocks on a full pipe). What was read stays in `sink` if the reader is aborted.
async fn read_capped<R: tokio::io::AsyncRead + Unpin>(reader: Option<R>, cap: usize, sink: SharedSink) {
    use tokio::io::AsyncReadExt;
    let Some(mut r) = reader else { return };
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut s = sink.lock().unwrap_or_else(|p| p.into_inner());
                let room = cap.saturating_sub(s.buf.len());
                if n > room {
                    s.over = true;
                }
                s.buf.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
    }
}

fn take_sink(sink: &SharedSink) -> (Vec<u8>, bool) {
    let mut s = sink.lock().unwrap_or_else(|p| p.into_inner());
    (std::mem::take(&mut s.buf), s.over)
}

/// The process group a run was started in (its pid): killed on a timeout, when output outlives
/// the program, or when the call is dropped before it finished.
struct Group(Option<u32>);

impl Group {
    fn kill(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.take().and_then(|p| i32::try_from(p).ok()).filter(|p| *p > 1) {
            // SAFETY: plain signal to the group this run created (process_group(0) below).
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        self.0 = None;
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

fn seconds(d: Duration) -> String {
    let ms = d.as_millis();
    if ms % 1000 == 0 {
        format!("{} s", ms / 1000)
    } else {
        format!("{ms} ms")
    }
}

fn spawn_error(program: &Path, e: &std::io::Error) -> RunnerError {
    let shown = program.display().to_string();
    match e.kind() {
        std::io::ErrorKind::NotFound => RunnerError::new("not_found", shown),
        std::io::ErrorKind::PermissionDenied => RunnerError::new("not_executable", shown),
        _ => RunnerError::new("spawn", format!("{shown}: {e}")),
    }
}

/// Run `cmd` to the end in its own process group: the whole group is killed after `timeout`
/// (`timeout`); standard output is capped at `cap`. Once the program exits its output gets
/// `OUTPUT_GRACE` to close; whatever it left holding the pipes after that is killed with the group.
pub async fn capture(mut cmd: std::process::Command, timeout: Duration, cap: usize) -> Result<Captured, RunnerError> {
    use std::process::Stdio;
    let program = PathBuf::from(cmd.get_program());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut cmd = tokio::process::Command::from(cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| spawn_error(&program, &e))?;
    let mut group = Group(child.id());
    let (out_sink, err_sink) = (SharedSink::default(), SharedSink::default());
    let out_task = tokio::spawn(read_capped(child.stdout.take(), cap, out_sink.clone()));
    let err_task = tokio::spawn(read_capped(child.stderr.take(), STDERR_CAP, err_sink.clone()));
    let (out_abort, err_abort) = (out_task.abort_handle(), err_task.abort_handle());
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(st) => st,
        Err(_) => {
            group.kill();
            let _ = child.kill().await;
            out_abort.abort();
            err_abort.abort();
            return Err(RunnerError::new("timeout", format!("no answer within {}", seconds(timeout))));
        }
    };
    let readers = async {
        let _ = out_task.await;
        let _ = err_task.await;
    };
    if tokio::time::timeout(OUTPUT_GRACE, readers).await.is_err() {
        group.kill();
        out_abort.abort();
        err_abort.abort();
    } else {
        group.disarm();
    }
    let status = status.map_err(|e| RunnerError::new("spawn", e.to_string()))?;
    let (stdout, stdout_over) = take_sink(&out_sink);
    let (stderr, _) = take_sink(&err_sink);
    Ok(Captured { success: status.success(), code: status.code(), stdout, stdout_over, stderr })
}

/// A run that must succeed: a non-zero exit is `failed` with the program's standard error (or the
/// exit code when it printed nothing there).
fn require_success(c: &Captured) -> Result<(), RunnerError> {
    if c.success {
        return Ok(());
    }
    let text = cap_text(&String::from_utf8_lossy(&c.stderr), DETAIL_CAP);
    let detail = if text.is_empty() {
        match c.code {
            Some(code) => format!("exit code {code}"),
            None => "ended by a signal".to_string(),
        }
    } else {
        text
    };
    Err(RunnerError::new("failed", detail))
}

// ── `runner status --json` ───────────────────────────────────────────────

fn text_field(v: Option<&Value>, max: usize) -> Value {
    match v {
        Some(Value::String(s)) => json!(cap_line(s, max)),
        _ => Value::Null,
    }
}

fn num_field(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => Value::Number(n.clone()),
        _ => Value::Null,
    }
}

/// A time as the program gives it: text (kept short) or a number.
fn time_field(v: Option<&Value>) -> Value {
    match v {
        Some(Value::String(s)) => json!(cap_line(s, 64)),
        n @ Some(Value::Number(_)) => num_field(n),
        _ => Value::Null,
    }
}

fn text_list(v: Option<&Value>, max_items: usize, max: usize) -> Value {
    let Some(Value::Array(items)) = v else { return json!([]) };
    Value::Array(
        items
            .iter()
            .filter_map(|i| match i {
                Value::String(s) => Some(json!(cap_line(s, max))),
                Value::Number(n) => Some(json!(n.to_string())),
                _ => None,
            })
            .take(max_items)
            .collect(),
    )
}

/// A field whose shape is not fixed: a number, a flag, short text or a short list of text.
fn loose_field(v: Option<&Value>) -> Value {
    match v {
        Some(Value::Bool(b)) => json!(b),
        n @ Some(Value::Number(_)) => num_field(n),
        Some(Value::String(s)) => json!(cap_line(s, 200)),
        a @ Some(Value::Array(_)) => text_list(a, MAX_PROFILE_ITEMS, 200),
        _ => Value::Null,
    }
}

fn norm_pool(v: Option<&Value>) -> Value {
    let Some(Value::Object(p)) = v else { return Value::Null };
    let limited: Vec<Value> = match p.get("limited") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .take(MAX_LIMITED)
            .map(|l| json!({ "product": text_field(l.get("product"), 80), "until": time_field(l.get("until")), "untilUnix": num_field(l.get("untilUnix")) }))
            .collect(),
        _ => Vec::new(),
    };
    json!({
        "min": num_field(p.get("min")),
        "max": num_field(p.get("max")),
        "idle": num_field(p.get("idle")),
        "busy": num_field(p.get("busy")),
        "suggestedMax": num_field(p.get("suggestedMax")),
        "suggestion": text_field(p.get("suggestion"), 300),
        "limited": limited,
    })
}

fn norm_profile(v: Option<&Value>) -> Value {
    let Some(Value::Object(p)) = v else { return Value::Null };
    json!({ "shell": loose_field(p.get("shell")), "commands": loose_field(p.get("commands")), "domains": loose_field(p.get("domains")) })
}

fn norm_worker(w: &Map<String, Value>) -> Value {
    json!({
        "id": text_field(w.get("id"), 80),
        "state": text_field(w.get("state"), 32),
        "task": text_field(w.get("task"), 120),
        "since": time_field(w.get("since")),
        "product": text_field(w.get("product"), 80),
        "branch": text_field(w.get("branch"), 200),
        "worktree": text_field(w.get("worktree"), 400),
        "profile": norm_profile(w.get("profile")),
        "refused": loose_field(w.get("refused")),
        "allowed": loose_field(w.get("allowed")),
    })
}

/// `runner status --json`'s standard output → the fields Settings shows, cleaned and capped.
/// `bad_output` when it is not UTF-8, not one JSON object, or has no `running` flag.
pub fn parse_status(stdout: &[u8]) -> Result<Value, RunnerError> {
    let text = std::str::from_utf8(stdout).map_err(|_| RunnerError::new("bad_output", "the output is not UTF-8 text"))?;
    let v: Value = serde_json::from_str(text.trim()).map_err(|_| RunnerError::new("bad_output", format!("not one JSON object: {}", cap_line(text, 200))))?;
    let Value::Object(o) = v else { return Err(RunnerError::new("bad_output", "the output is not a JSON object")) };
    let Some(running) = o.get("running").and_then(Value::as_bool) else {
        return Err(RunnerError::new("bad_output", "the output has no running flag"));
    };
    if !running {
        return Ok(json!({ "running": false, "server": text_field(o.get("server"), 300) }));
    }
    let workers: Vec<Value> = match o.get("workers") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).take(MAX_ITEMS).map(norm_worker).collect(),
        _ => Vec::new(),
    };
    let cursor = match o.get("cursor") {
        Some(Value::String(s)) => json!(cap_line(s, 120)),
        n @ Some(Value::Number(_)) => num_field(n),
        _ => Value::Null,
    };
    Ok(json!({
        "running": true,
        "pid": num_field(o.get("pid")),
        "server": text_field(o.get("server"), 300),
        "runner": text_field(o.get("runner"), 120),
        "account": text_field(o.get("account"), 120),
        "startedAt": time_field(o.get("startedAt")),
        "mode": text_field(o.get("mode"), 32),
        "cursor": cursor,
        "teams": text_list(o.get("teams"), MAX_ITEMS, 120),
        "wouldTake": text_list(o.get("wouldTake"), MAX_ITEMS, 120),
        "lastChangeAt": time_field(o.get("lastChangeAt")),
        "presenceAt": time_field(o.get("presenceAt")),
        "pool": norm_pool(o.get("pool")),
        "workers": workers,
    }))
}

/// `runner status --json --server <server>`, parsed.
pub async fn status(program: &Path, server: &str, timeout: Duration) -> Result<Value, RunnerError> {
    let c = capture(base_command(program, &status_args(server)), timeout, OUTPUT_CAP).await?;
    require_success(&c)?;
    if c.stdout_over {
        return Err(RunnerError::new("too_large", format!("more than {} KiB of output", OUTPUT_CAP / 1024)));
    }
    parse_status(&c.stdout)
}

fn is_running(v: &Value) -> bool {
    v.get("running").and_then(Value::as_bool) == Some(true)
}

/// `version`: its first non-empty line.
pub async fn version(program: &Path) -> Result<Value, RunnerError> {
    let c = capture(base_command(program, &version_args()), VERSION_TIMEOUT, OUTPUT_CAP).await?;
    require_success(&c)?;
    let text = String::from_utf8_lossy(&c.stdout);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    Ok(json!({ "version": cap_line(line, 200) }))
}

// ── Start and stop ───────────────────────────────────────────────────────

/// `~/.config/octo/run/board-runner[.dev].log` (the folder 0700).
#[cfg(unix)]
pub fn log_path() -> Result<PathBuf, RunnerError> {
    let dir = super::config_dir().map_err(|e| RunnerError::new("io", e))?.join("run");
    crate::pty_holder::ensure_private_dir(&dir).map_err(|e| RunnerError::new("io", e))?;
    Ok(dir.join(LOG_FILE))
}

/// The log, for appending: 0600, never through a symbolic link.
#[cfg(unix)]
pub fn open_log(path: &Path) -> Result<std::fs::File, RunnerError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    super::remote::refuse_symlink(path).map_err(|e| RunnerError::new("io", e))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| RunnerError::new("io", format!("cannot open {}: {e}", path.display())))?;
    // A log made earlier with other permissions is made private.
    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    Ok(file)
}

/// `<log>.1` next to `log`.
pub fn rotated_path(log: &Path) -> PathBuf {
    let mut name = log.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".1");
    log.with_file_name(name)
}

/// A log larger than `max` bytes is moved to `<log>.1` (replacing an older one) and made 0600;
/// a symbolic link at either name is refused. Ok(true) when it was moved.
#[cfg(unix)]
pub fn rotate_log(log: &Path, max: u64) -> Result<bool, RunnerError> {
    use std::os::unix::fs::PermissionsExt;
    let io = |e: String| RunnerError::new("io", e);
    super::remote::refuse_symlink(log).map_err(io)?;
    let len = match std::fs::symlink_metadata(log) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(io(format!("cannot read {}: {e}", log.display()))),
    };
    if len <= max {
        return Ok(false);
    }
    let old = rotated_path(log);
    super::remote::refuse_symlink(&old).map_err(io)?;
    std::fs::rename(log, &old).map_err(|e| io(format!("cannot move {} aside: {e}", log.display())))?;
    let _ = std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o600));
    Ok(true)
}

/// The last part of what the run wrote to its log after `offset` (for a failed start).
pub fn log_tail(path: &Path, offset: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = offset.max(len.saturating_sub(8 * 1024));
    if f.seek(SeekFrom::Start(from)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.take(8 * 1024).read_to_end(&mut buf);
    let text = cap_text(&String::from_utf8_lossy(&buf), usize::MAX);
    // Keep the end: the reason is usually the last thing printed.
    let chars: Vec<char> = text.chars().collect();
    let keep = DETAIL_CAP.saturating_sub(1);
    if chars.len() <= DETAIL_CAP {
        text
    } else {
        format!("…{}", chars[chars.len() - keep..].iter().collect::<String>())
    }
}

/// Start `runner run` in its own session with standard output and error appended to `log`.
/// The returned slot gets its exit code and a description once it ends (a thread of this app
/// reaps it).
#[cfg(unix)]
fn spawn_detached(program: &Path, server: &str, log: std::fs::File) -> Result<std::sync::Arc<std::sync::Mutex<Option<(Option<i32>, String)>>>, RunnerError> {
    use std::os::unix::process::CommandExt;
    let err_log = log.try_clone().map_err(|e| RunnerError::new("io", e.to_string()))?;
    let mut cmd = base_command(program, &run_args(server));
    cmd.stdout(std::process::Stdio::from(log)).stderr(std::process::Stdio::from(err_log));
    // SAFETY: setsid is async-signal-safe; nothing else runs between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| spawn_error(program, &e))?;
    let exited = std::sync::Arc::new(std::sync::Mutex::new(None));
    let slot = exited.clone();
    std::thread::spawn(move || {
        let ended = match child.wait() {
            Ok(st) => match st.code() {
                Some(code) => (Some(code), format!("the runner ended with exit code {code}")),
                None => (None, "the runner was ended by a signal".to_string()),
            },
            Err(e) => (None, format!("the runner could not be watched: {e}")),
        };
        *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(ended);
    });
    Ok(exited)
}

/// Start: never a second runner (status first); then `runner run` detached, and success only once
/// status says it runs (up to `wait`). The answer is that status plus `logPath`.
#[cfg(unix)]
pub async fn start(program: &Path, server: &str, log: &Path, wait: Duration, every: Duration) -> Result<Value, RunnerError> {
    let now = status(program, server, STATUS_TIMEOUT).await?;
    if is_running(&now) {
        let who = now.get("runner").and_then(Value::as_str).unwrap_or("");
        return Err(RunnerError::new("already_running", who));
    }
    rotate_log(log, LOG_ROTATE_BYTES)?;
    let file = open_log(log)?;
    let offset = file.metadata().map(|m| m.len()).unwrap_or(0);
    {
        use std::io::Write;
        let mut f = &file;
        let _ = writeln!(f, "--- {} starting the runner for {server}", chrono::Utc::now().to_rfc3339());
    }
    let offset = offset.max(file.metadata().map(|m| m.len()).unwrap_or(offset));
    let exited = spawn_detached(program, server, file)?;
    let deadline = tokio::time::Instant::now() + wait;
    let mut last_error: Option<RunnerError>;
    let started = |mut v: Value| {
        v["logPath"] = json!(log.display().to_string());
        v
    };
    loop {
        tokio::time::sleep(every).await;
        let ended = exited.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some((code, why)) = ended {
            // A program that put itself in the background exits 0: ask once more before failing.
            if code == Some(0) {
                if let Ok(v) = status(program, server, STATUS_TIMEOUT).await {
                    if is_running(&v) {
                        return Ok(started(v));
                    }
                }
            }
            let tail = log_tail(log, offset);
            return Err(RunnerError::new("start_failed", if tail.is_empty() { why } else { format!("{why}\n{tail}") }));
        }
        match status(program, server, STATUS_TIMEOUT).await {
            Ok(v) if is_running(&v) => return Ok(started(v)),
            Ok(_) => last_error = None,
            Err(e) => last_error = Some(e),
        }
        if tokio::time::Instant::now() >= deadline {
            let mut detail = format!("it did not report running within {}; it may still be starting (log: {})", seconds(wait), log.display());
            if let Some(e) = last_error {
                detail.push_str(&format!("\nlast status: {e}"));
            }
            return Err(RunnerError::new("start_timeout", detail));
        }
    }
}

/// Stop: `runner stop`, then wait (up to `wait`) for status to say it no longer runs.
pub async fn stop(program: &Path, server: &str, wait: Duration, every: Duration) -> Result<Value, RunnerError> {
    let c = capture(base_command(program, &stop_args(server)), STOP_TIMEOUT, OUTPUT_CAP).await?;
    require_success(&c)?;
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let last = status(program, server, STATUS_TIMEOUT).await;
        if let Ok(v) = &last {
            if !is_running(v) {
                return Ok(v.clone());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let mut detail = format!("it still reports running after {}", seconds(wait));
            if let Err(e) = last {
                detail = format!("its state could not be read after {}: {e}", seconds(wait));
            }
            return Err(RunnerError::new("stop_timeout", detail));
        }
        tokio::time::sleep(every).await;
    }
}

/// Start and Stop one at a time (a second click cannot start two runners).
fn op_lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ── Commands ─────────────────────────────────────────────────────────────
// None of the commands that run the program takes an argument: the program and the server come
// from config.json (runner_tests.rs checks these signatures).

/// `{running:false, server}` or `{running:true, pid, server, runner, account, startedAt, mode,
/// cursor, teams, wouldTake, lastChangeAt, presenceAt, pool, workers}`; errors `{kind, detail}`.
#[tauri::command(async)]
pub async fn board_runner_status() -> Result<Value, RunnerError> {
    let t = current_target(true)?;
    status(&t.program, &t.server, STATUS_TIMEOUT).await
}

/// Start the runner (see `start`).
#[tauri::command(async)]
pub async fn board_runner_start() -> Result<Value, RunnerError> {
    #[cfg(unix)]
    {
        let _one = op_lock().lock().await;
        let t = current_target(true)?;
        let log = log_path()?;
        start(&t.program, &t.server, &log, CONFIRM_WAIT, CONFIRM_POLL).await
    }
    #[cfg(not(unix))]
    {
        Err(RunnerError::new("unsupported", ""))
    }
}

/// Stop the runner and confirm it with status (see `stop`).
#[tauri::command(async)]
pub async fn board_runner_stop() -> Result<Value, RunnerError> {
    let _one = op_lock().lock().await;
    let t = current_target(true)?;
    stop(&t.program, &t.server, CONFIRM_WAIT, CONFIRM_POLL).await
}

/// `{version}`: the program's version line (needs no board server).
#[tauri::command(async)]
pub async fn board_runner_version() -> Result<Value, RunnerError> {
    let t = current_target(false)?;
    version(&t.program).await
}

/// Check a path before Settings saves it as `agents.board.server.runnerPath`: `{path}` (trimmed;
/// empty turns the runner block off). Runs nothing.
#[tauri::command(async)]
pub async fn board_runner_check_path(path: String) -> Result<Value, RunnerError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(json!({ "path": "" }));
    }
    if !cfg!(unix) {
        return Err(RunnerError::new("unsupported", ""));
    }
    let p = check_program_path(trimmed)?;
    Ok(json!({ "path": p.display().to_string() }))
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
