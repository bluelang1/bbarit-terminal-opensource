//! Finding or starting a holder (docs/PTY_HOLDER_DAEMON.md 3.1).
//!
//! Phase 2a only has the `setsid` fallback: the holder is this same exe run as
//! `--mode pty-holder --socket <path>` in its own session, with stdin/stdout on
//! /dev/null and stderr on `<run>/<prefix>.<instance>.log`. launchd/systemd
//! registration (so the holder leaves the app's coalition/cgroup) is phase 3.

use super::proto::{self, HolderInfo};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const SOCKET_WAIT: Duration = Duration::from_secs(5);

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
        if !super::pid_alive(info.pid) {
            let _ = std::fs::remove_file(&info_path);
            let _ = std::fs::remove_file(&socket);
            continue;
        }
        // Another version's holder keeps its terminals; DRAIN + a second holder is phase 3.
        if info.version != proto::PROTOCOL_VERSION {
            other_version.get_or_insert(info.version);
            continue;
        }
        if UnixStream::connect(&socket).is_ok() {
            return Ok(socket);
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
    let base = format!("{}.{}", super::file_prefix(), super::new_instance_id());
    let socket = run_dir.join(format!("{base}.sock"));
    super::check_socket_path(&socket)?;
    let log_path = run_dir.join(format!("{base}.log"));
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&log_path)
        .map_err(|e| format!("open {}: {e}", log_path.display()))?;
    let mut cmd = Command::new(exe);
    cmd.args(["--mode", "pty-holder", "--socket"])
        .arg(&socket)
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
    // The socket accepts as soon as it is bound; the info file is written right after.
    let info_path = super::info_path_for(&socket);
    let deadline = Instant::now() + SOCKET_WAIT;
    while Instant::now() < deadline {
        if info_path.exists() && UnixStream::connect(&socket).is_ok() {
            return Ok(socket);
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
