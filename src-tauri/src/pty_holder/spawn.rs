//! Finding or starting a holder (docs/PTY_HOLDER_DAEMON.md 3.1).
//!
//! The holder is this same exe run as `--mode pty-holder --socket <path>` with stdin/stdout
//! on /dev/null and stderr on `<run>/<prefix>.<instance>.log`. It is started, in order:
//! - macOS: as a one-shot launchd job (`launchctl bootstrap gui/<uid>`), so it gets its own
//!   coalition and is its own TCC responsible process instead of staying in the app's;
//! - Linux: as a transient `systemd-run --user` service (its own cgroup);
//! - otherwise, or when that fails: in its own session (`setsid`), the phase 2a path.
//!
//! The reason for a fallback is kept for `pty_backend_info` (`spawnFallbackReason`).
//! `BBARIT_PTY_HOLDER_SPAWN=setsid` skips launchd/systemd (debugging).

use super::proto::{self, HolderInfo};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Never below 2 s: the first run of a freshly built/updated exe takes ~1.7 s (signature check).
const SOCKET_WAIT: Duration = Duration::from_secs(5);
/// launchctl / systemd-run normally answer in milliseconds.
const TOOL_TIMEOUT: Duration = Duration::from_secs(5);
/// A launchd job (or its plist) younger than this may belong to a spawner that is still
/// inside its `SOCKET_WAIT` (another dev app, a test): the stale cleanup leaves it alone.
pub const STALE_MIN_AGE: Duration = Duration::from_secs(SOCKET_WAIT.as_secs() + 5);
/// `setsid` forces the phase 2a spawn (skips launchd/systemd).
pub const SPAWN_ENV: &str = "BBARIT_PTY_HOLDER_SPAWN";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnMethod {
    Launchd,
    Systemd,
    Setsid,
}

impl SpawnMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            SpawnMethod::Launchd => "launchd",
            SpawnMethod::Systemd => "systemd",
            SpawnMethod::Setsid => "setsid",
        }
    }
}

/// Why the holder at this socket was started with setsid instead of launchd/systemd.
static SPAWN_FALLBACK: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

/// How the holder at `socket` was started, for `pty_backend_info`:
/// `{spawnMethod, label?, unit?, spawnFallbackReason?}` (from its info file; null fields for
/// holders of 2a/2b, which did not record it).
pub fn describe(socket: &Path) -> serde_json::Value {
    let info = std::fs::read(super::info_path_for(socket))
        .ok()
        .and_then(|b| serde_json::from_slice::<HolderInfo>(&b).ok());
    let fallback = SPAWN_FALLBACK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(s, _)| s == socket)
        .map(|(_, why)| why.clone());
    let mut v = serde_json::json!({
        "spawnMethod": info.as_ref().and_then(|i| i.spawn_method.clone()),
        "spawnFallbackReason": fallback,
    });
    if let Some(label) = info.as_ref().and_then(|i| i.label.clone()) {
        v["label"] = label.into();
    }
    if let Some(unit) = info.as_ref().and_then(|i| i.unit.clone()) {
        v["unit"] = unit.into();
    }
    v
}

/// `<prefix>.<instance>.json` → parsed info, for our prefix only (dev never matches
/// release files and vice versa: the instance part must not contain a dot).
pub fn discover(run_dir: &Path) -> Vec<(PathBuf, HolderInfo)> {
    let prefix = format!("{}.", super::file_prefix());
    let Ok(entries) = std::fs::read_dir(run_dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(instance) = name
            .strip_prefix(&prefix)
            .and_then(|r| r.strip_suffix(".json"))
        else {
            continue;
        };
        if instance.is_empty() || instance.contains('.') {
            continue;
        }
        let path = entry.path();
        let Some(info) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<HolderInfo>(&b).ok())
        else {
            continue;
        };
        found.push((path, info));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

/// Socket of a live holder that speaks our protocol, or a freshly started one.
/// Files of dead holders are removed on the way.
pub fn find_or_spawn(run_dir: &Path) -> Result<PathBuf, String> {
    super::ensure_private_dir(run_dir)?;
    prune_old_logs(run_dir);
    let mut other_version: Option<u32> = None;
    for (info_path, info) in discover(run_dir) {
        let socket = PathBuf::from(&info.socket);
        // Only sockets inside our private run dir are trusted (or cleaned up).
        if socket.parent() != Some(run_dir) {
            continue;
        }
        let alive = super::pid_alive(info.pid);
        let probe = if alive {
            UnixStream::connect(&socket).map(|_| ())
        } else {
            Ok(())
        };
        match classify(alive, info.version, probe) {
            Candidate::Stale => {
                let _ = std::fs::remove_file(&info_path);
                let _ = std::fs::remove_file(&socket);
            }
            Candidate::Live => return Ok(socket),
            // Another version's holder keeps its terminals; DRAIN + a second holder is phase 3.
            Candidate::OtherVersion(v) => {
                other_version.get_or_insert(v);
            }
            Candidate::Unsure => {}
        }
    }
    // Until phase 3 (DRAIN + several holders) a second holder would strand the old one's
    // terminals unseen: run in-process instead and say why (pty_backend_info.fallbackReason).
    if let Some(v) = other_version {
        return Err(format!(
            "a PTY holder from another app version (protocol {v}, this app {}) is still running; terminals run inside the app until it exits",
            proto::PROTOCOL_VERSION
        ));
    }
    spawn_holder(run_dir)
}

#[derive(Debug, PartialEq, Eq)]
enum Candidate {
    /// Its process is gone, or nobody listens on its socket: remove the files.
    Stale,
    /// A holder of our protocol answers on the socket.
    Live,
    /// A holder of another protocol answers on the socket.
    OtherVersion(u32),
    /// Its process exists but the socket did not take the connection for another reason:
    /// leave it alone, but do not let it keep this app in-process either.
    Unsure,
}

/// What an info file stands for. The pid alone is not enough: a stale json whose pid was
/// reused by an unrelated process must not read as "another version is running" (which
/// keeps the app in-process), so a holder counts only if its socket accepts a connection.
fn classify(pid_alive: bool, version: u32, connect: std::io::Result<()>) -> Candidate {
    if !pid_alive {
        return Candidate::Stale;
    }
    match connect {
        Ok(()) if version == proto::PROTOCOL_VERSION => Candidate::Live,
        Ok(()) => Candidate::OtherVersion(version),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
            ) =>
        {
            Candidate::Stale
        }
        Err(_) => Candidate::Unsure,
    }
}

/// Logs of holders that are gone (no info file) and older than a week.
fn prune_old_logs(run_dir: &Path) {
    const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);
    let prefix = format!("{}.", super::file_prefix());
    let Ok(entries) = std::fs::read_dir(run_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let Some(instance) = name
            .to_str()
            .and_then(|n| n.strip_prefix(&prefix))
            .and_then(|r| r.strip_suffix(".log"))
        else {
            continue;
        };
        if instance.contains('.') || path.with_extension("json").exists() {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > KEEP);
        if old {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Start a detached holder and wait until its socket accepts connections.
pub fn spawn_holder(run_dir: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    spawn_holder_with(&exe, run_dir)
}

pub fn spawn_holder_with(exe: &Path, run_dir: &Path) -> Result<PathBuf, String> {
    super::ensure_private_dir(run_dir)?;
    let forced_setsid = std::env::var(SPAWN_ENV).is_ok_and(|v| v.trim() == "setsid");
    if forced_setsid {
        let (_, socket, log_path) = new_paths(run_dir)?;
        let log = open_log(&log_path)?;
        return spawn_setsid(exe, &socket, log, &log_path, Some(format!("{SPAWN_ENV}=setsid")));
    }
    spawn_service_or_setsid(exe, run_dir)
}

/// macOS: a one-shot launchd job, else setsid.
#[cfg(target_os = "macos")]
fn spawn_service_or_setsid(exe: &Path, run_dir: &Path) -> Result<PathBuf, String> {
    let (instance, socket, log_path) = new_paths(run_dir)?;
    open_log(&log_path)?; // created 0600 here; launchd appends to it (StandardErrorPath)
    let started = start_service(
        "launchd",
        || launchd::spawn(exe, run_dir, &instance, &socket, &log_path),
        || wait_for_socket(&socket, &log_path),
        // Started but never listened: do not leave a late holder behind.
        |label| launchd::bootout(label),
    );
    match started {
        Ok(socket) => {
            // Off the startup path: each launchctl call may take up to TOOL_TIMEOUT, and
            // the young-job rule waits STALE_MIN_AGE between its two looks.
            let dir = run_dir.to_path_buf();
            std::thread::spawn(move || launchd::cleanup_stale(&dir));
            Ok(socket)
        }
        Err(why) => setsid_fallback(exe, run_dir, why),
    }
}

/// Linux: a transient systemd user service, else setsid.
#[cfg(target_os = "linux")]
fn spawn_service_or_setsid(exe: &Path, run_dir: &Path) -> Result<PathBuf, String> {
    let (instance, socket, log_path) = new_paths(run_dir)?;
    open_log(&log_path)?;
    let started = start_service(
        "systemd",
        || systemd::spawn(exe, &instance, &socket, &log_path),
        || wait_for_socket(&socket, &log_path),
        |unit| systemd::stop(unit),
    );
    started.or_else(|why| setsid_fallback(exe, run_dir, why))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn spawn_service_or_setsid(exe: &Path, run_dir: &Path) -> Result<PathBuf, String> {
    let (_, socket, log_path) = new_paths(run_dir)?;
    let log = open_log(&log_path)?;
    spawn_setsid(exe, &socket, log, &log_path, None)
}

/// `(instance, <run>/<prefix>.<instance>.sock, ….log)` for a new holder.
fn new_paths(run_dir: &Path) -> Result<(String, PathBuf, PathBuf), String> {
    let instance = super::new_instance_id();
    let base = format!("{}.{instance}", super::file_prefix());
    let socket = run_dir.join(format!("{base}.sock"));
    super::check_socket_path(&socket)?;
    let log_path = run_dir.join(format!("{base}.log"));
    Ok((instance, socket, log_path))
}

fn open_log(log_path: &Path) -> Result<std::fs::File, String> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_path)
        .map_err(|e| format!("open {}: {e}", log_path.display()))
}

/// launchd/systemd failed (or its holder never listened): one setsid try under fresh
/// paths, with the reason kept for `spawnFallbackReason`.
#[allow(dead_code)] // macOS / Linux only
fn setsid_fallback(exe: &Path, run_dir: &Path, why: String) -> Result<PathBuf, String> {
    safe_eprintln!("[pty-holder] {why}; using setsid");
    let (_, socket, log_path) = new_paths(run_dir)?;
    let log = open_log(&log_path)?;
    spawn_setsid(exe, &socket, log, &log_path, Some(why))
}

/// Start a holder as a service job (`start`), then wait for its socket. A job that started
/// but never listened is stopped (`stop`) so no late holder is left behind. Err carries the
/// fallback reason ("launchd: …").
#[allow(dead_code)] // macOS / Linux only
fn start_service<J>(
    service: &str,
    start: impl FnOnce() -> Result<J, String>,
    wait: impl FnOnce() -> Result<PathBuf, String>,
    stop: impl FnOnce(&J),
) -> Result<PathBuf, String> {
    let job = start().map_err(|e| format!("{service}: {e}"))?;
    wait().map_err(|e| {
        stop(&job);
        format!("{service}: job started but {e}")
    })
}

/// The phase 2a spawn: same exe in its own session, reaped by a thread of this app.
fn spawn_setsid(
    exe: &Path,
    socket: &Path,
    log: std::fs::File,
    log_path: &Path,
    fallback: Option<String>,
) -> Result<PathBuf, String> {
    let mut cmd = Command::new(exe);
    cmd.args(["--mode", "pty-holder", "--socket"])
        .arg(socket)
        .args(["--spawn-method", SpawnMethod::Setsid.as_str()])
        // Never carry a tab's scope token (a sweep of that tab would kill every terminal),
        // and never fall into the embedded agent's mode gate.
        .env_remove(crate::SCOPE_ENV)
        .env_remove("BBARIT_AGENT_MODE")
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log));
    // SAFETY: setsid is async-signal-safe; nothing else runs between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn holder: {e}"))?;
    // Reap it whenever it ends so it never lingers as a zombie of the app.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    if let Some(why) = fallback {
        *SPAWN_FALLBACK.lock().unwrap_or_else(|p| p.into_inner()) = Some((socket.to_path_buf(), why));
    }
    wait_for_socket(socket, log_path)
}

/// The socket accepts as soon as it is bound; the info file is written right after.
fn wait_for_socket(socket: &Path, log_path: &Path) -> Result<PathBuf, String> {
    let info_path = super::info_path_for(socket);
    let deadline = Instant::now() + SOCKET_WAIT;
    while Instant::now() < deadline {
        if info_path.exists() && UnixStream::connect(socket).is_ok() {
            return Ok(socket.to_path_buf());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!(
        "holder did not open {} within {:?} (log: {})",
        socket.display(),
        SOCKET_WAIT,
        log_path.display()
    ))
}

/// Exit status and output of a helper tool, killed after `TOOL_TIMEOUT`.
#[allow(dead_code)] // only launchd/systemd use it
fn run_tool(cmd: &mut Command) -> Result<(std::process::ExitStatus, String, String), String> {
    use std::io::Read;
    let name = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{name}: {e}"))?;
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = read(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + TOOL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} did not answer within {TOOL_TIMEOUT:?}"));
            }
            Err(e) => return Err(format!("{name}: {e}")),
        }
    };
    Ok((status, out.join().unwrap_or_default(), err.join().unwrap_or_default()))
}

/// Environment for a holder started by launchd/systemd: only what the holder itself
/// reads. Terminals get their full environment from each SPAWN.
#[allow(dead_code)] // only launchd/systemd use it
fn holder_env() -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
        env.push(("HOME".to_string(), home.to_string_lossy().into_owned()));
    }
    env.push(("PATH".to_string(), "/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    if let Ok(v) = std::env::var(super::server::IDLE_EXIT_ENV) {
        env.push((super::server::IDLE_EXIT_ENV.to_string(), v));
    }
    env
}

/// One-shot launchd jobs (docs 3.1, 3단계 스파이크 E4).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) mod launchd {
    use super::{run_tool, SpawnMethod};
    use std::collections::HashSet;
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    /// `com.bbarit.terminal.<prefix>.`: dev and release jobs never touch each other.
    pub fn label_prefix() -> String {
        format!("com.bbarit.terminal.{}.", super::super::file_prefix())
    }

    pub fn label_for(instance: &str) -> String {
        format!("{}{instance}", label_prefix())
    }

    fn domain() -> String {
        // SAFETY: getuid never fails.
        format!("gui/{}", unsafe { libc::getuid() })
    }

    /// Our jobs in `launchctl list` output: `(pid, label)`, pid None for the `-` rows of
    /// finished jobs. Other labels (and our prefix with a dotted instance, i.e. the dev
    /// jobs seen from a release build) are ignored.
    pub fn our_jobs(list: &str, prefix: &str) -> Vec<(Option<u32>, String)> {
        list.lines()
            .filter_map(|line| {
                let mut cols = line.split_whitespace();
                let (pid, _status, label) = (cols.next()?, cols.next()?, cols.next()?);
                let instance = label.strip_prefix(prefix)?;
                if instance.is_empty() || instance.contains('.') || cols.next().is_some() {
                    return None;
                }
                let pid = match pid {
                    "-" => None,
                    n => Some(n.parse::<u32>().ok()?),
                };
                Some((pid, label.to_string()))
            })
            .collect()
    }

    /// One of our plist files in the run dir.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct PlistFile {
        pub label: String,
        pub path: std::path::PathBuf,
        /// Since its last modification (None: mtime unreadable, treated as young).
        pub age: Option<Duration>,
    }

    /// What the stale cleanup may touch, from two `launchctl list` looks taken at least
    /// `min_age` apart (`before`, `now`) and our plists:
    /// - boot out a label only if its job is finished (`-`) in both looks, and its plist,
    ///   when it is ours, is at least `min_age` old. Booting out a live holder SIGHUPs every
    ///   terminal in it; a job another spawner just bootstrapped shows `-` only until it
    ///   launches, or until that spawner's own `SOCKET_WAIT` bootout.
    /// - remove a plist only if it is at least `min_age` old and its job is not running.
    ///
    /// Labels are one namespace per uid while plists are per run dir, so a label with no
    /// plist here may belong to another run dir: the two looks are what make it safe.
    pub fn plan_cleanup(
        before: &[(Option<u32>, String)],
        now: &[(Option<u32>, String)],
        plists: &[PlistFile],
        min_age: Duration,
    ) -> (Vec<String>, Vec<std::path::PathBuf>) {
        let finished_before: HashSet<&str> =
            before.iter().filter(|j| j.0.is_none()).map(|j| j.1.as_str()).collect();
        let live: HashSet<&str> = now.iter().filter(|j| j.0.is_some()).map(|j| j.1.as_str()).collect();
        let old = |p: &PlistFile| p.age.is_some_and(|a| a >= min_age);
        let stale = now
            .iter()
            .filter(|(pid, label)| pid.is_none() && finished_before.contains(label.as_str()))
            .filter(|(_, label)| plists.iter().filter(|p| &p.label == label).all(old))
            .map(|(_, label)| label.clone())
            .collect();
        let remove = plists
            .iter()
            .filter(|p| old(p) && !live.contains(p.label.as_str()))
            .map(|p| p.path.clone())
            .collect();
        (stale, remove)
    }

    /// Our `<prefix>.<instance>.plist` files (dotted instances are another build's).
    pub fn plists_in(run_dir: &Path) -> Vec<PlistFile> {
        let prefix = format!("{}.", super::super::file_prefix());
        let Ok(entries) = std::fs::read_dir(run_dir) else {
            return Vec::new();
        };
        let mut found: Vec<PlistFile> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name();
                let instance = name.to_str()?.strip_prefix(&prefix)?.strip_suffix(".plist")?.to_string();
                if instance.is_empty() || instance.contains('.') {
                    return None;
                }
                let age = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
                Some(PlistFile { label: label_for(&instance), path: e.path(), age })
            })
            .collect();
        found.sort_by(|a, b| a.path.cmp(&b.path));
        found
    }

    fn list_our_jobs() -> Option<Vec<(Option<u32>, String)>> {
        match run_tool(Command::new("launchctl").arg("list")) {
            Ok((st, out, _)) if st.success() => Some(our_jobs(&out, &label_prefix())),
            Ok((st, _, err)) => {
                safe_eprintln!("[pty-holder] launchctl list: {st} {}", err.trim());
                None
            }
            Err(e) => {
                safe_eprintln!("[pty-holder] launchctl list: {e}");
                None
            }
        }
    }

    /// Boot out our finished jobs (they stay listed as `- 0 <label>` forever otherwise)
    /// and remove plists of jobs that are not running, leaving anything younger than
    /// `STALE_MIN_AGE` alone. Blocks for `STALE_MIN_AGE`: run it on a background thread.
    pub fn cleanup_stale(run_dir: &Path) {
        cleanup_stale_with(run_dir, super::STALE_MIN_AGE);
    }

    pub fn cleanup_stale_with(run_dir: &Path, min_age: Duration) {
        let Some(before) = list_our_jobs() else { return };
        if !min_age.is_zero() {
            std::thread::sleep(min_age);
        }
        let Some(now) = list_our_jobs() else { return };
        let (stale, remove) = plan_cleanup(&before, &now, &plists_in(run_dir), min_age);
        for label in stale {
            bootout(&label);
        }
        for path in remove {
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn bootout(label: &str) {
        let target = format!("{}/{label}", domain());
        match run_tool(Command::new("launchctl").args(["bootout", &target])) {
            Ok((st, _, _)) if st.success() => {}
            Ok((st, _, err)) => safe_eprintln!("[pty-holder] launchctl bootout {target}: {st} {}", err.trim()),
            Err(e) => safe_eprintln!("[pty-holder] launchctl bootout {target}: {e}"),
        }
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }

    /// The job plist: one-shot (RunAtLoad, no KeepAlive), its own process group left alone
    /// at exit (AbandonProcessGroup: the terminals are in their own sessions anyway),
    /// not throttled (Interactive).
    pub fn plist(label: &str, argv: &[String], log: &str, env: &[(String, String)]) -> String {
        let s = |v: &str| format!("<string>{}</string>", xml_escape(v));
        let args: String = argv.iter().map(|a| format!("\n\t\t{}", s(a))).collect();
        let env: String = env
            .iter()
            .map(|(k, v)| format!("\n\t\t<key>{}</key>{}", xml_escape(k), s(v)))
            .collect();
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>{label}
	<key>ProgramArguments</key>
	<array>{args}
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><false/>
	<key>AbandonProcessGroup</key><true/>
	<key>ProcessType</key><string>Interactive</string>
	<key>WorkingDirectory</key><string>/</string>
	<key>StandardInPath</key><string>/dev/null</string>
	<key>StandardOutPath</key><string>/dev/null</string>
	<key>StandardErrorPath</key>{log}
	<key>EnvironmentVariables</key>
	<dict>{env}
	</dict>
</dict>
</plist>
"#,
            label = s(label),
            log = s(log),
        )
    }

    /// Write the plist (0600) and `launchctl bootstrap` it. Returns the label.
    pub fn spawn(exe: &Path, run_dir: &Path, instance: &str, socket: &Path, log: &Path) -> Result<String, String> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let utf8 = |p: &Path| {
            p.to_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{} is not UTF-8", p.display()))
        };
        let label = label_for(instance);
        let argv = vec![
            utf8(exe)?,
            "--mode".into(),
            "pty-holder".into(),
            "--socket".into(),
            utf8(socket)?,
            "--spawn-method".into(),
            SpawnMethod::Launchd.as_str().into(),
            "--job".into(),
            label.clone(),
        ];
        let body = plist(&label, &argv, &utf8(log)?, &super::holder_env());
        let path = run_dir.join(format!("{}.{instance}.plist", super::super::file_prefix()));
        let mut f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        f.write_all(body.as_bytes())
            .map_err(|e| format!("write {}: {e}", path.display()))?;
        drop(f);
        let result = run_tool(Command::new("launchctl").arg("bootstrap").arg(domain()).arg(&path));
        match result {
            Ok((st, _, _)) if st.success() => Ok(label),
            other => {
                let _ = std::fs::remove_file(&path);
                Err(match other {
                    Ok((st, out, err)) => format!(
                        "launchctl bootstrap {label}: {st}: {}",
                        format!("{} {}", out.trim(), err.trim()).trim()
                    ),
                    Err(e) => e,
                })
            }
        }
    }
}

/// Transient `systemd-run --user` services (docs 3.1).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod systemd {
    use super::{run_tool, SpawnMethod};
    use std::ffi::OsString;
    use std::path::Path;
    use std::process::Command;

    /// `bbarit-pty-holder-<instance>` (dev: `bbarit-pty-holder-dev-<instance>`).
    pub fn unit_for(instance: &str) -> String {
        format!("bbarit-{}-{instance}", super::super::file_prefix().replace('.', "-"))
    }

    /// `systemd-run` arguments: a transient user service that is collected when it ends
    /// and whose stop only signals the holder itself (KillMode=process).
    pub fn argv(exe: &Path, socket: &Path, log: &Path, unit: &str, env: &[(String, String)]) -> Vec<OsString> {
        let mut a: Vec<OsString> = [
            "--user",
            "--collect",
            "--quiet",
            "--service-type=exec",
            "-p",
            "KillMode=process",
        ]
        .iter()
        .map(OsString::from)
        .collect();
        a.push("-p".into());
        let mut stderr = OsString::from("StandardError=append:");
        stderr.push(log);
        a.push(stderr);
        a.push("--unit".into());
        a.push(unit.into());
        for (k, v) in env {
            // HOME/PATH come from the user manager; only pass our own knobs.
            if k != "HOME" && k != "PATH" {
                a.push("-E".into());
                a.push(format!("{k}={v}").into());
            }
        }
        a.push("--".into());
        a.push(exe.into());
        for s in ["--mode", "pty-holder", "--socket"] {
            a.push(s.into());
        }
        a.push(socket.into());
        a.push("--spawn-method".into());
        a.push(SpawnMethod::Systemd.as_str().into());
        a.push("--job".into());
        a.push(unit.into());
        a
    }

    /// Best effort: a unit that started but whose holder never listened.
    pub fn stop(unit: &str) {
        match run_tool(Command::new("systemctl").args(["--user", "stop", unit])) {
            Ok((st, _, _)) if st.success() => {}
            Ok((st, _, err)) => safe_eprintln!("[pty-holder] systemctl --user stop {unit}: {st} {}", err.trim()),
            Err(e) => safe_eprintln!("[pty-holder] systemctl --user stop {unit}: {e}"),
        }
    }

    pub fn spawn(exe: &Path, instance: &str, socket: &Path, log: &Path) -> Result<String, String> {
        let unit = unit_for(instance);
        let args = argv(exe, socket, log, &unit, &super::holder_env());
        match run_tool(Command::new("systemd-run").args(&args))? {
            (st, _, _) if st.success() => Ok(unit),
            (st, out, err) => Err(format!(
                "systemd-run {unit}: {st}: {}",
                format!("{} {}", out.trim(), err.trim()).trim()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn a_holder_counts_only_when_its_socket_answers() {
        let ours = proto::PROTOCOL_VERSION;
        assert_eq!(classify(false, ours, Ok(())), Candidate::Stale);
        assert_eq!(classify(true, ours, Ok(())), Candidate::Live);
        assert_eq!(classify(true, ours + 1, Ok(())), Candidate::OtherVersion(ours + 1));
        // Reused pid from a stale json: nobody listens, so it is not "another version".
        let refused = || Err(Error::from(ErrorKind::ConnectionRefused));
        assert_eq!(classify(true, ours + 1, refused()), Candidate::Stale);
        assert_eq!(classify(true, ours, Err(Error::from(ErrorKind::NotFound))), Candidate::Stale);
        assert_eq!(classify(true, ours + 1, Err(Error::from(ErrorKind::TimedOut))), Candidate::Unsure);
    }

    #[test]
    fn a_socket_file_without_a_listener_is_refused_or_missing() {
        let dir = std::env::temp_dir().join(format!("bbarit-sp-{}", super::super::new_instance_id()));
        super::super::ensure_private_dir(&dir).unwrap();
        let sock = dir.join("x.sock");
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap()); // file stays, nobody listens
        // Tests fork in parallel: a child forked while the listener fd was open keeps a copy
        // of it until its exec (CLOEXEC), so a connect can briefly still succeed. Retry.
        let deadline = Instant::now() + Duration::from_secs(5);
        let probe = loop {
            let probe = UnixStream::connect(&sock).map(|_| ());
            if probe.is_err() || Instant::now() >= deadline {
                break probe;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(classify(true, proto::PROTOCOL_VERSION + 1, probe), Candidate::Stale);
        let missing = UnixStream::connect(dir.join("none.sock")).map(|_| ());
        assert_eq!(classify(true, proto::PROTOCOL_VERSION, missing), Candidate::Stale);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn launchctl_list_rows_are_split_into_live_and_finished_jobs() {
        let prefix = "com.bbarit.terminal.pty-holder.";
        let list = "PID\tStatus\tLabel\n\
                    -\t0\tcom.bbarit.terminal.pty-holder.0a1b2c3d\n\
                    4242\t0\tcom.bbarit.terminal.pty-holder.deadbeef\n\
                    -\t-15\tcom.bbarit.terminal.pty-holder.cafe0001\n\
                    -\t0\tcom.bbarit.terminal.pty-holder.dev.12345678\n\
                    777\t0\tcom.apple.Finder\n\
                    -\t0\tcom.bbarit.terminal.pty-holderX.1\n\
                    -\t0\tcom.bbarit.terminal.pty-holder.\n\
                    garbage\n";
        let jobs = launchd::our_jobs(list, prefix);
        assert_eq!(
            jobs,
            vec![
                (None, "com.bbarit.terminal.pty-holder.0a1b2c3d".to_string()),
                (Some(4242), "com.bbarit.terminal.pty-holder.deadbeef".to_string()),
                (None, "com.bbarit.terminal.pty-holder.cafe0001".to_string()),
            ]
        );
        // The dev build sees only its own jobs.
        let dev = launchd::our_jobs(list, "com.bbarit.terminal.pty-holder.dev.");
        assert_eq!(dev, vec![(None, "com.bbarit.terminal.pty-holder.dev.12345678".to_string())]);

        let old = Some(STALE_MIN_AGE + Duration::from_secs(1));
        let plist = |l: &str, path: &str, age: Option<Duration>| launchd::PlistFile {
            label: format!("com.bbarit.terminal.pty-holder.{l}"),
            path: PathBuf::from(format!("/r/{path}.plist")),
            age,
        };
        let plists = vec![
            plist("0a1b2c3d", "a", old), // finished
            plist("deadbeef", "b", old), // live: keep
            plist("99999999", "c", old), // not listed
        ];
        // Same rows in both looks: the old behavior.
        let (bootout, remove) = launchd::plan_cleanup(&jobs, &jobs, &plists, STALE_MIN_AGE);
        assert_eq!(
            bootout,
            vec![
                "com.bbarit.terminal.pty-holder.0a1b2c3d".to_string(),
                "com.bbarit.terminal.pty-holder.cafe0001".to_string()
            ],
            "only `-` rows; never the live 4242"
        );
        assert_eq!(remove, vec![PathBuf::from("/r/a.plist"), PathBuf::from("/r/c.plist")]);
    }

    #[test]
    fn the_stale_cleanup_leaves_young_jobs_and_plists_of_other_spawners_alone() {
        let label = |l: &str| format!("com.bbarit.terminal.pty-holder.{l}");
        let min = STALE_MIN_AGE;
        let old = Some(min + Duration::from_secs(1));
        let young = Some(Duration::from_millis(300));
        let plist = |l: &str, age: Option<Duration>| launchd::PlistFile {
            label: label(l),
            path: PathBuf::from(format!("/r/{l}.plist")),
            age,
        };
        // First look (STALE_MIN_AGE ago) and now.
        let before = vec![
            (None, label("finished")),     // `-` both times, old plist: stale
            (None, label("justbooted")),   // another spawner's job, not launched yet...
            (None, label("foreign")),      // `-` both times, plist in another run dir
            (None, label("youngplist")),   // `-` both times, but its plist is fresh
        ];
        let now = vec![
            (None, label("finished")),
            (Some(4242), label("justbooted")), // ...now running
            (None, label("foreign")),
            (None, label("youngplist")),
            (None, label("newcomer")),         // bootstrapped after the first look
        ];
        let plists = vec![
            plist("finished", old),
            plist("justbooted", young),
            plist("youngplist", young),
            plist("newcomer", young),
            plist("unlisted-old", old),     // job gone: plist removable
            plist("unlisted-young", young), // being written by a concurrent spawner
            plist("unknown-age", None),
        ];
        let (bootout, remove) = launchd::plan_cleanup(&before, &now, &plists, min);
        assert_eq!(bootout, vec![label("finished"), label("foreign")]);
        let removed: Vec<String> =
            remove.iter().map(|p| p.file_stem().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(removed, vec!["finished", "unlisted-old"]);
        // A zero age limit (manual cleanup in the live test) is the plain rule.
        let all_old: Vec<_> = plists.iter().cloned().map(|mut p| { p.age = Some(Duration::ZERO); p }).collect();
        let (bootout, _) = launchd::plan_cleanup(&now, &now, &all_old, Duration::ZERO);
        assert_eq!(bootout, vec![label("finished"), label("foreign"), label("youngplist"), label("newcomer")]);
    }

    #[test]
    fn plists_in_matches_only_our_instance_files() {
        let dir = std::env::temp_dir().join(format!("bbarit-pl-{}", super::super::new_instance_id()));
        super::super::ensure_private_dir(&dir).unwrap();
        for name in [
            "pty-holder.dev.abcd1234.plist", // ours (tests are debug builds)
            "pty-holder.dev.x.y.plist",      // dotted instance: not ours
            "pty-holder.dev..plist",         // empty instance
            "pty-holder.abcd1234.plist",     // the release build's
            "pty-holder.dev.abcd1234.json",
            "other.plist",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let found = launchd::plists_in(&dir);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].label, "com.bbarit.terminal.pty-holder.dev.abcd1234");
        assert_eq!(found[0].path, dir.join("pty-holder.dev.abcd1234.plist"));
        assert!(found[0].age.is_some_and(|a| a < Duration::from_secs(60)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_service_job_that_never_listens_is_stopped_and_reported() {
        use std::cell::RefCell;
        let stopped = RefCell::new(Vec::<String>::new());
        // Started, but the socket never opened: the job is stopped, the caller falls back.
        let r = start_service(
            "launchd",
            || Ok("job-1".to_string()),
            || Err("holder did not open /r/x.sock within 5s".to_string()),
            |j: &String| stopped.borrow_mut().push(j.clone()),
        );
        assert_eq!(r.unwrap_err(), "launchd: job started but holder did not open /r/x.sock within 5s");
        assert_eq!(*stopped.borrow(), vec!["job-1".to_string()]);
        // Could not start: nothing to stop.
        let r = start_service(
            "systemd",
            || Err::<String, _>("systemd-run: No such file or directory".to_string()),
            || unreachable!("no wait without a job"),
            |j: &String| stopped.borrow_mut().push(j.clone()),
        );
        assert_eq!(r.unwrap_err(), "systemd: systemd-run: No such file or directory");
        assert_eq!(stopped.borrow().len(), 1);
        // Listening: the job stays.
        let r = start_service(
            "launchd",
            || Ok("job-2".to_string()),
            || Ok(PathBuf::from("/r/y.sock")),
            |j: &String| stopped.borrow_mut().push(j.clone()),
        );
        assert_eq!(r.unwrap(), PathBuf::from("/r/y.sock"));
        assert_eq!(stopped.borrow().len(), 1);
    }

    #[test]
    fn launchd_plist_is_a_one_shot_interactive_job() {
        assert_eq!(launchd::label_for("abcd1234"), "com.bbarit.terminal.pty-holder.dev.abcd1234");
        let argv: Vec<String> = ["/A&B/octo-ui", "--mode", "pty-holder", "--socket", "/r/x.sock"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let env = vec![("HOME".to_string(), "/Users/me".to_string()), ("PATH".to_string(), "/usr/bin:/bin".to_string())];
        let body = launchd::plist("com.bbarit.terminal.pty-holder.x", &argv, "/r/x.log", &env);
        for needle in [
            "<key>Label</key><string>com.bbarit.terminal.pty-holder.x</string>",
            "<string>/A&amp;B/octo-ui</string>",
            "<key>RunAtLoad</key><true/>",
            "<key>KeepAlive</key><false/>",
            "<key>AbandonProcessGroup</key><true/>",
            "<key>ProcessType</key><string>Interactive</string>",
            "<key>WorkingDirectory</key><string>/</string>",
            "<key>StandardErrorPath</key><string>/r/x.log</string>",
            "<key>HOME</key><string>/Users/me</string>",
        ] {
            assert!(body.contains(needle), "{needle}\n{body}");
        }
        assert!(!body.contains("BBARIT_TERM_SCOPE") && !body.contains("BBARIT_AGENT_MODE"));
        // plutil validates the XML where it exists (macOS).
        if Path::new("/usr/bin/plutil").exists() {
            let dir = std::env::temp_dir().join(format!("bbarit-pl-{}", super::super::new_instance_id()));
            super::super::ensure_private_dir(&dir).unwrap();
            let f = dir.join("j.plist");
            std::fs::write(&f, &body).unwrap();
            let out = Command::new("/usr/bin/plutil").arg("-lint").arg(&f).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn holder_env_carries_only_what_the_holder_reads() {
        let env = holder_env();
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.iter().all(|k| ["HOME", "PATH", super::super::server::IDLE_EXIT_ENV].contains(k)), "{keys:?}");
        assert!(keys.contains(&"PATH"));
    }

    #[test]
    fn systemd_run_argv() {
        assert_eq!(systemd::unit_for("abcd1234"), "bbarit-pty-holder-dev-abcd1234");
        let env = vec![
            ("HOME".to_string(), "/home/me".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("BBARIT_PTY_HOLDER_IDLE_EXIT_MS".to_string(), "500".to_string()),
        ];
        let argv = systemd::argv(
            Path::new("/opt/bbarit/octo-ui"),
            Path::new("/run/user/1000/bbarit/pty-holder.abcd1234.sock"),
            Path::new("/run/user/1000/bbarit/pty-holder.abcd1234.log"),
            "bbarit-pty-holder-abcd1234",
            &env,
        );
        let argv: Vec<String> = argv.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(
            argv,
            [
                "--user",
                "--collect",
                "--quiet",
                "--service-type=exec",
                "-p",
                "KillMode=process",
                "-p",
                "StandardError=append:/run/user/1000/bbarit/pty-holder.abcd1234.log",
                "--unit",
                "bbarit-pty-holder-abcd1234",
                "-E",
                "BBARIT_PTY_HOLDER_IDLE_EXIT_MS=500",
                "--",
                "/opt/bbarit/octo-ui",
                "--mode",
                "pty-holder",
                "--socket",
                "/run/user/1000/bbarit/pty-holder.abcd1234.sock",
                "--spawn-method",
                "systemd",
                "--job",
                "bbarit-pty-holder-abcd1234",
            ]
        );
    }

    #[test]
    fn describe_reads_the_info_file_and_the_fallback_reason() {
        let dir = std::env::temp_dir().join(format!("bbarit-ds-{}", super::super::new_instance_id()));
        super::super::ensure_private_dir(&dir).unwrap();
        let socket = dir.join("pty-holder.dev.d1.sock");
        let write = |info: &HolderInfo| {
            std::fs::write(super::super::info_path_for(&socket), serde_json::to_vec(info).unwrap()).unwrap()
        };
        let mut info = HolderInfo {
            pid: 1,
            socket: socket.to_string_lossy().into_owned(),
            version: proto::PROTOCOL_VERSION,
            build: "x".into(),
            instance: "d1".into(),
            spawn_method: Some("launchd".into()),
            label: Some("com.bbarit.terminal.pty-holder.dev.d1".into()),
            unit: None,
        };
        write(&info);
        let v = describe(&socket);
        assert_eq!(v["spawnMethod"], "launchd");
        assert_eq!(v["label"], "com.bbarit.terminal.pty-holder.dev.d1");
        assert!(v["spawnFallbackReason"].is_null() && v.get("unit").is_none(), "{v}");

        info.spawn_method = Some("setsid".into());
        info.label = None;
        write(&info);
        *SPAWN_FALLBACK.lock().unwrap() = Some((socket.clone(), "launchd: bootstrap failed".into()));
        let v = describe(&socket);
        assert_eq!(v["spawnMethod"], "setsid");
        assert_eq!(v["spawnFallbackReason"], "launchd: bootstrap failed");
        assert!(describe(&dir.join("other.sock"))["spawnFallbackReason"].is_null());
        assert!(describe(&dir.join("other.sock"))["spawnMethod"].is_null());
        *SPAWN_FALLBACK.lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
