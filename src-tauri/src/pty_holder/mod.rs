//! PTY holder daemon (docs/PTY_HOLDER_DAEMON.md 3.1-3.4, phase 2a).
//!
//! The same exe runs as `--mode pty-holder --socket <path>`: a small process that
//! owns the tab PTYs so they survive the app going away. The app talks to it over
//! a same-uid unix socket through `client::HolderBackend`, a `PtyBackend`.
//!
//! - `proto`: frame format and JSON payloads (version 1).
//! - `server`: the holder itself (spawn, pump, reap, tail ring, mode tracking).
//! - `spawn`: how the app starts a detached holder (setsid; launchd/systemd is phase 3).
//! - `client`: `HolderBackend`, the app side.
//!
//! Unix only. Windows keeps `InProcessBackend` (phase 4).

pub mod client;
pub mod proto;
pub mod server;
pub mod spawn;

#[cfg(test)]
mod integration_tests;

use std::path::{Path, PathBuf};

/// `sun_path` is 104 bytes on macOS (108 on Linux); stay well under both.
pub const MAX_SOCKET_PATH: usize = 100;

/// File name prefix for holder files in the run dir. Dev and installed builds use
/// different names so a `tauri dev` app never attaches to the installed app's holder.
pub fn file_prefix() -> &'static str {
    if cfg!(debug_assertions) {
        "pty-holder.dev"
    } else {
        "pty-holder"
    }
}

/// `~/.config/octo/run` (Linux: `$XDG_RUNTIME_DIR/bbarit` when set). Created 0700.
pub fn run_dir() -> Result<PathBuf, String> {
    let dir = default_run_dir()?;
    ensure_private_dir(&dir)?;
    Ok(dir)
}

fn default_run_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        let xdg = PathBuf::from(xdg);
        if xdg.is_dir() {
            return Ok(xdg.join("bbarit"));
        }
    }
    let home = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".config/octo/run"))
}

/// Create `dir` (and parents) and force it to 0700: tails and SPAWN envs pass through here.
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod {}: {e}", dir.display()))
}

/// Refuse socket paths `bind`/`connect` would truncate.
pub fn check_socket_path(path: &Path) -> Result<(), String> {
    let len = path.as_os_str().len();
    if len > MAX_SOCKET_PATH {
        return Err(format!(
            "socket path is {len} bytes (max {MAX_SOCKET_PATH}): {}",
            path.display()
        ));
    }
    Ok(())
}

/// `<run>/<prefix>.<instance>.sock` → `<run>/<prefix>.<instance>.json`.
pub fn info_path_for(socket: &Path) -> PathBuf {
    socket.with_extension("json")
}

/// Short random instance id (keeps the socket path short).
pub fn new_instance_id() -> String {
    format!("{:08x}", rand::random::<u32>())
}

/// Process exists (signal 0). EPERM still means "exists".
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: kill(2) with signal 0 only probes for existence.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_socket_paths_are_rejected() {
        let ok = PathBuf::from(format!("/tmp/{}", "a".repeat(MAX_SOCKET_PATH - 5)));
        assert_eq!(ok.as_os_str().len(), MAX_SOCKET_PATH);
        assert!(check_socket_path(&ok).is_ok());
        let long = PathBuf::from(format!("/tmp/{}", "a".repeat(MAX_SOCKET_PATH - 4)));
        assert!(check_socket_path(&long).unwrap_err().contains("max 100"));
    }

    #[test]
    fn dev_and_release_use_different_names() {
        // Tests build with debug_assertions.
        assert_eq!(file_prefix(), "pty-holder.dev");
        assert_eq!(
            info_path_for(Path::new("/r/pty-holder.dev.abcd1234.sock")),
            PathBuf::from("/r/pty-holder.dev.abcd1234.json")
        );
    }

    #[test]
    fn private_dir_is_0700() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("bbarit-rd-{}", new_instance_id()));
        let dir = base.join("run");
        ensure_private_dir(&dir).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let _ = std::fs::remove_dir_all(&base);
    }
}
