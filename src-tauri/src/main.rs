// Release Windows builds must stay GUI-subsystem. When this binary was changed
// to console-subsystem for the embedded agent path, installed builds could render
// the WebView but leave the Win32 owner thread unresponsive, so file opens and
// other Tauri IPC appeared stuck.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![recursion_limit = "256"]

/// Safe logging macro that never panics (unlike eprintln! which panics on broken stderr).
/// Tauri bundled apps may have invalid stderr, causing SIGABRT crashes.
#[macro_export]
macro_rules! safe_eprintln {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let msg = format!("{}\n", format_args!($($arg)*));
        let _ = std::io::stderr().write_all(msg.as_bytes());
    }};
}

mod agent_gateway;
mod browser_bridge;
mod chrome_import;
mod claude_design;
mod code_search;
mod collab;
mod common;
mod database;
mod design_http;
mod file_watcher;
mod fs_ops;
mod integrations;
mod lan_discovery;
mod learning_db;
mod note_ops;
mod db;
mod webview_browser;
// semble_rs에서 벤더링한 코드 검색 라이브러리 — graph/encoder/file_walker만 사용 중
#[allow(dead_code)]
mod semble;
mod skills_db;
mod video_edit;
mod web_terminal;

use futures::StreamExt;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::{
    collections::HashMap,
    io::{Cursor, Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// macOS: 메인 윈도우의 CGWindowNumber (setup 시 메인 스레드에서 저장)
static MAIN_WINDOW_NUMBER: AtomicI64 = AtomicI64::new(0);
use std::time::Duration;
use sysinfo::{Pid, System};
use tokio::sync::Mutex as AsyncMutex;

// Prevent unbounded memory growth when the frontend can't keep up with PTY output.
// 1024 queued chunks is enough for bursty CLIs while keeping multi-harness memory bounded.
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 1024;
// Limit how much we return per read to avoid huge allocations and renderer stalls
// on bursty long-running output.
const PTY_READ_MAX_BYTES: usize = 64 * 1024;
// Avoid freezing the UI by dumping huge API responses to the terminal.
const HTTP_BODY_MAX_BYTES: usize = 1024 * 1024;
// Maximum file size allowed for read_file/write_file (10 MB) to prevent memory spikes.
const FILE_SIZE_LIMIT: u64 = 10 * 1024 * 1024;
// Higher limit for read-only operations (30 MB) — needed for loading system fonts, etc.
const READ_FILE_SIZE_LIMIT: u64 = 30 * 1024 * 1024;
// Telegram long-polling timeout in seconds (reduces unnecessary HTTP round-trips).
const TELEGRAM_LONG_POLL_SECS: u64 = 25;
// One-shot harness commands should never retain unlimited stdout/stderr in memory.
const CLI_ONESHOT_OUTPUT_MAX_BYTES: usize = 1024 * 1024;

#[cfg(target_os = "windows")]
fn ensure_wsl_distribution_installed() -> Result<(), String> {
    let output = common::no_window_command("wsl.exe")
        .args(["-l", "-q"])
        .output()
        .map_err(|e| format!("Failed to check WSL distributions: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).replace('\0', "");
    let has_distro = stdout.lines().map(str::trim).any(|line| !line.is_empty());

    if has_distro {
        Ok(())
    } else {
        Err("WSL is installed, but no Linux distribution is installed. Run `wsl.exe --install <Distro>` first, or choose PowerShell/CMD/Git Bash.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn wsl_distribution_installed() -> bool {
    ensure_wsl_distribution_installed().is_ok()
}

// SSH commands should fail fast when a remote host is down so startup restore
// and file-tree refreshes don't stall the UI for a long time.
const SSH_CONNECT_TIMEOUT_SECS: u64 = 5;
const SSH_SERVER_ALIVE_INTERVAL_SECS: u64 = 15;
const SSH_SERVER_ALIVE_COUNT_MAX: u64 = 3;

const TELEGRAM_API_BASE_URL: &str = "https://api.telegram.org";
const OPENAI_BASE_URL_DEFAULT: &str = "https://api.openai.com/v1";

/// Global shared reqwest client -- reuses TCP connections across all HTTP/Telegram calls.
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_max_idle_per_host(4)
            .timeout(Duration::from_secs(60))
            .build()
            .expect("failed to build shared HTTP client")
    })
}

type FileEntry = common::FileEntry;

// per-terminal state
struct PtyInstance {
    writer: Box<dyn Write + Send>,
    output_rx: Receiver<String>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
    alive: Arc<AtomicBool>,
    /// Accumulated output buffer — keeps a copy of all PTY output for later retrieval.
    /// Used by orchestra plan to read output even though XTerminal consumes the channel.
    output_buffer: Arc<Mutex<String>>,
    /// Wall-clock time of the most recent PTY output. The broker uses idle-debounce
    /// ("no output for N ms") as a model-agnostic readiness / turn-complete signal,
    /// instead of fragile banner/prompt regex. Exposed via `pty_idle_ms`.
    last_output_at: Arc<Mutex<std::time::Instant>>,
}

struct AppState {
    ptys: Mutex<HashMap<String, PtyInstance>>,
    harness_jobs: Mutex<HashMap<String, HarnessJobRecord>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarnessJobSnapshot {
    id: String,
    label: String,
    command_preview: String,
    work_dir: Option<String>,
    status: String,
    output: String,
    error: Option<String>,
    created_at: i64,
    updated_at: i64,
    started_at: Option<i64>,
    completed_at: Option<i64>,
}

struct HarnessJobRecord {
    snapshot: HarnessJobSnapshot,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
struct SshPathSpec {
    username: String,
    host: String,
    port: u16,
    identity_file: Option<String>,
    /// `username@host:port(;key=...)` part (without `ssh://` prefix)
    meta: String,
    /// Absolute remote path on the SSH server.
    remote_path: String,
}

fn is_remote_ssh_path(path: &str) -> bool {
    path.trim_start().starts_with("ssh://")
}

fn sh_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', "'\\''"))
}

/// Refuse a user-supplied ref, remote, path, or URL that git would parse as an
/// option (`--upload-pack=…`, `-D`, …). Positional values never legitimately
/// start with `-`, so this closes argument injection through the git commands
/// below without changing what valid input does.
fn reject_option_like(value: &str, what: &str) -> Result<(), String> {
    if value.trim_start().starts_with('-') {
        return Err(format!("Invalid {what}: must not start with '-'"));
    }
    Ok(())
}

fn parse_ssh_path(path: &str) -> Result<Option<SshPathSpec>, String> {
    let raw = path.trim();
    if !raw.starts_with("ssh://") {
        return Ok(None);
    }

    // Format:
    // ssh://username@host:port::/remote/path
    // ssh://username@host:port;key=<base64url>::/remote/path
    let without_scheme = &raw["ssh://".len()..];
    let (meta, remote_raw) = without_scheme.split_once("::").ok_or_else(|| {
        "Invalid SSH path format. Expected ssh://user@host:port::/path".to_string()
    })?;

    let (base_meta, encoded_key_opt) = match meta.split_once(";key=") {
        Some((m, k)) if !k.trim().is_empty() => (m, Some(k.trim())),
        Some((m, _)) => (m, None),
        None => (meta, None),
    };

    let (username, host_port) = base_meta
        .split_once('@')
        .ok_or_else(|| "Invalid SSH path format: missing username@host".to_string())?;
    if username.trim().is_empty() {
        return Err("Invalid SSH path format: empty username".to_string());
    }
    if username.trim().starts_with('-') {
        return Err("Invalid SSH path format: username must not start with '-'".to_string());
    }

    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.trim().is_empty() => {
            let parsed = p
                .trim()
                .parse::<u16>()
                .map_err(|_| "Invalid SSH port".to_string())?;
            (h.trim().to_string(), parsed)
        }
        _ => (host_port.trim().to_string(), 22u16),
    };
    if host.trim().is_empty() {
        return Err("Invalid SSH path format: empty host".to_string());
    }
    if host.starts_with('-') {
        return Err("Invalid SSH path format: host must not start with '-'".to_string());
    }

    let identity_file = if let Some(encoded) = encoded_key_opt {
        use base64::Engine;
        let decoded_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(encoded))
            .map_err(|_| "Invalid SSH key encoding".to_string())?;
        let key = String::from_utf8(decoded_bytes)
            .map_err(|_| "Invalid SSH key path encoding".to_string())?;
        let trimmed = key.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else {
        None
    };

    let remote_trimmed = remote_raw.trim();
    if remote_trimmed.is_empty() {
        return Err("Invalid SSH path format: missing remote path".to_string());
    }

    let remote_path = if remote_trimmed.starts_with('/') {
        remote_trimmed.to_string()
    } else {
        format!("/{}", remote_trimmed)
    };
    if remote_path.trim().is_empty() {
        return Err("SSH base path must not be empty.".to_string());
    }

    Ok(Some(SshPathSpec {
        username: username.to_string(),
        host,
        port,
        identity_file,
        meta: meta.to_string(),
        remote_path,
    }))
}

fn ssh_virtual_path(spec: &SshPathSpec, remote_path: &str) -> String {
    let rp = if remote_path.starts_with('/') {
        remote_path.to_string()
    } else {
        format!("/{}", remote_path)
    };
    format!("ssh://{}::{}", spec.meta, rp)
}

fn ssh_join_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

/// Ensure SSH key file has correct permissions (600).
/// If the original file has wrong permissions and can't be chmod'd (e.g. external volume),
/// copy it to ~/.config/octo/ssh_keys/ with correct permissions.
fn ensure_ssh_key_permissions(key_path: &str) -> Result<String, String> {
    // Expand leading `~` / `~/` to the user's home directory. Rust's Path does not
    // expand tildes, so a path like `~/.ssh/key.pem` reads as a literal directory
    // name and fails `path.exists()`. The shell-quoted form downstream also does
    // not expand tildes inside single quotes, so the SSH command silently fails.
    let expanded: String = if key_path == "~" || key_path.starts_with("~/") {
        match resolve_home_dir() {
            Some(home) => {
                if key_path == "~" {
                    home
                } else {
                    format!("{}{}", home, &key_path[1..])
                }
            }
            None => key_path.to_string(),
        }
    } else {
        key_path.to_string()
    };

    let path = std::path::Path::new(&expanded);
    if !path.exists() {
        return Err(format!("SSH key file not found: {}", expanded));
    }

    // Try chmod 600 on the original file first
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta =
            std::fs::metadata(path).map_err(|e| format!("Cannot read SSH key metadata: {}", e))?;
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o600 && mode != 0o400 {
            // Try to fix permissions in place
            if std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).is_ok() {
                return Ok(expanded);
            }
            // Can't chmod (e.g. FAT32/exFAT volume) — copy to safe location
            let home = resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
            let safe_dir = format!("{}/.config/octo/ssh_keys", home);
            std::fs::create_dir_all(&safe_dir)
                .map_err(|e| format!("Failed to create SSH key dir: {}", e))?;
            let filename = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "id_key".to_string());
            let safe_path = format!("{}/{}", safe_dir, filename);
            std::fs::copy(path, &safe_path)
                .map_err(|e| format!("Failed to copy SSH key: {}", e))?;
            std::fs::set_permissions(&safe_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Failed to set SSH key permissions: {}", e))?;
            safe_eprintln!(
                "[SSH] Copied key to {} with mode 600 (original had mode {:o})",
                safe_path,
                mode
            );
            return Ok(safe_path);
        }
    }
    Ok(expanded)
}

#[cfg(target_os = "windows")]
fn windows_path_to_wsl_path(path: &std::path::Path) -> Option<String> {
    use std::path::Component;

    let mut components = path.components();
    let drive = match components.next()? {
        Component::Prefix(prefix) => {
            let raw = prefix.as_os_str().to_string_lossy();
            raw.chars().next()?.to_ascii_lowercase()
        }
        _ => return None,
    };

    let rest = components
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");

    Some(if rest.is_empty() {
        format!("/mnt/{}", drive)
    } else {
        format!("/mnt/{}/{}", drive, rest)
    })
}

#[cfg(target_os = "windows")]
fn configure_windows_pty_encoding(
    cmd: &mut CommandBuilder,
    shell_type: Option<&str>,
    is_ssh_pty: bool,
) {
    if is_ssh_pty {
        return;
    }

    cmd.env("LANG", "ko_KR.UTF-8");
    cmd.env("LC_ALL", "ko_KR.UTF-8");
    cmd.env("PYTHONIOENCODING", "UTF-8");

    match shell_type {
        Some("cmd") => {
            cmd.arg("/K");
            cmd.arg("chcp 65001>nul");
        }
        Some("gitbash") | Some("wsl") => {}
        _ => {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg("[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); chcp 65001 > $null");
        }
    }
}

/// Build an interactive `ssh` command to run directly inside a PTY (Windows).
///
/// On Windows the local PTY shell is PowerShell/cmd.exe, neither of which can parse
/// the POSIX single-quoted ssh command the frontend builds for macOS/Linux. So on
/// Windows we spawn `ssh` itself as the PTY process — each argument is passed
/// literally (no local-shell quoting), and the remote login shell runs server-side.
#[cfg(target_os = "windows")]
fn build_ssh_pty_command(work_dir: &str) -> Result<CommandBuilder, String> {
    let spec = parse_ssh_path(work_dir)?
        .ok_or_else(|| "Not an SSH work dir".to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    cmd.arg("-t"); // request a remote PTY for an interactive shell
    cmd.arg("-o");
    cmd.arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o");
    cmd.arg(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS));
    cmd.arg("-o");
    cmd.arg("ConnectionAttempts=1");
    cmd.arg("-o");
    cmd.arg(format!("ServerAliveInterval={}", SSH_SERVER_ALIVE_INTERVAL_SECS));
    cmd.arg("-o");
    cmd.arg(format!("ServerAliveCountMax={}", SSH_SERVER_ALIVE_COUNT_MAX));
    cmd.arg("-p");
    cmd.arg(spec.port.to_string());
    if let Some(key) = &spec.identity_file {
        let safe_key = ensure_ssh_key_permissions(key).unwrap_or_else(|_| key.clone());
        cmd.arg("-i");
        cmd.arg(safe_key);
    }
    cmd.arg(format!("{}@{}", spec.username, spec.host));

    // Remote (POSIX) shell script: cd into the project dir, then exec a login shell.
    // sh_quote handles the remote path; this whole string is one literal argv element.
    let remote_script = format!(
        "if [ -d {p} ]; then cd -- {p}; else echo '[octo] remote path not found: {rp}'; fi; exec ${{SHELL:-/bin/bash}} -l",
        p = sh_quote(&spec.remote_path),
        rp = spec.remote_path,
    );
    cmd.arg(remote_script);
    Ok(cmd)
}

fn ssh_command_base(spec: &SshPathSpec) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o")
        .arg(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS));
    cmd.arg("-o").arg("ConnectionAttempts=1");
    cmd.arg("-o").arg(format!(
        "ServerAliveInterval={}",
        SSH_SERVER_ALIVE_INTERVAL_SECS
    ));
    cmd.arg("-o").arg(format!(
        "ServerAliveCountMax={}",
        SSH_SERVER_ALIVE_COUNT_MAX
    ));
    cmd.arg("-o").arg("NumberOfPasswordPrompts=0");
    cmd.arg("-p").arg(spec.port.to_string());
    if let Some(key) = &spec.identity_file {
        let k = key.trim();
        if !k.is_empty() {
            // Ensure key has correct permissions (600), copy if needed
            match ensure_ssh_key_permissions(k) {
                Ok(safe_key) => {
                    cmd.arg("-i").arg(safe_key);
                }
                Err(e) => {
                    safe_eprintln!("[SSH] Key permission warning: {}", e);
                    cmd.arg("-i").arg(k);
                }
            }
        }
    }
    cmd.arg(format!("{}@{}", spec.username, spec.host));
    cmd
}

fn run_ssh_command(spec: &SshPathSpec, remote_script: &str) -> Result<Vec<u8>, String> {
    let mut cmd = ssh_command_base(spec);
    cmd.arg(format!("sh -lc {}", sh_quote(remote_script)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .map_err(|e| format!("SSH command failed to start: {e}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = stderr.trim();
        if msg.is_empty() {
            Err(format!("SSH command failed: {}", stdout.trim()))
        } else {
            Err(format!("SSH command failed: {}", msg))
        }
    }
}

/// Async version of run_ssh_command — prevents UI thread blocking for Tauri async commands.
async fn run_ssh_command_async(spec: &SshPathSpec, remote_script: &str) -> Result<Vec<u8>, String> {
    let mut cmd = common::no_window_async_command("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg(format!("ConnectTimeout={}", SSH_CONNECT_TIMEOUT_SECS))
        .arg("-o")
        .arg("ConnectionAttempts=1")
        .arg("-o")
        .arg(format!(
            "ServerAliveInterval={}",
            SSH_SERVER_ALIVE_INTERVAL_SECS
        ))
        .arg("-o")
        .arg(format!(
            "ServerAliveCountMax={}",
            SSH_SERVER_ALIVE_COUNT_MAX
        ))
        .arg("-o")
        .arg("NumberOfPasswordPrompts=0")
        .arg("-p")
        .arg(spec.port.to_string());
    if let Some(key) = &spec.identity_file {
        let k = key.trim();
        if !k.is_empty() {
            match ensure_ssh_key_permissions(k) {
                Ok(safe_key) => {
                    cmd.arg("-i").arg(safe_key);
                }
                Err(e) => {
                    safe_eprintln!("[SSH] Key permission warning: {}", e);
                    cmd.arg("-i").arg(k);
                }
            }
        }
    }
    cmd.arg(format!("{}@{}", spec.username, spec.host))
        .arg(format!("sh -lc {}", sh_quote(remote_script)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("SSH command failed to start: {e}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = stderr.trim();
        if msg.is_empty() {
            Err(format!("SSH command failed: {}", stdout.trim()))
        } else {
            Err(format!("SSH command failed: {}", msg))
        }
    }
}

fn run_ssh_command_with_stdin(
    spec: &SshPathSpec,
    remote_script: &str,
    stdin_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let mut cmd = ssh_command_base(spec);
    cmd.arg(format!("sh -lc {}", sh_quote(remote_script)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("SSH command failed to start: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_bytes)
            .map_err(|e| format!("SSH stdin write failed: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("SSH command wait failed: {e}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = stderr.trim();
        if msg.is_empty() {
            Err(format!("SSH command failed: {}", stdout.trim()))
        } else {
            Err(format!("SSH command failed: {}", msg))
        }
    }
}

fn resolve_shell_work_dir(work_dir: &str) -> String {
    if is_remote_ssh_path(work_dir) {
        // SSH paths are virtual; use the user's home directory for the local PTY.
        // Fall back to /tmp instead of "/" to avoid accidentally starting in the root directory.
        return resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
    }
    // 프로젝트 폴더가 외부에서 삭제/이동된 경우: 유령 폴더를 재생성하지 않고 홈으로 fallback.
    if !std::path::Path::new(work_dir).is_dir() {
        return resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
    }
    work_dir.to_string()
}

fn resolve_home_dir() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(home);
        }
    }

    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return Some(home);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Best-effort: derive /Users/<username> even if HOME is missing.
        let username = common::no_window_command("id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if let Some(u) = username {
            return Some(format!("/Users/{}", u));
        }
    }

    None
}

fn read_octo_env() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let Some(home) = resolve_home_dir() else {
        return map;
    };

    let env_path = format!("{}/.config/octo/.env", home);
    let Ok(content) = std::fs::read_to_string(&env_path) else {
        return map;
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq_pos) = line.find('=') else {
            continue;
        };

        let key = line[..eq_pos].trim();
        let mut value = line[eq_pos + 1..].trim();

        // Strip surrounding quotes.
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = &value[1..value.len().saturating_sub(1)];
        }

        if !key.is_empty() {
            map.insert(key.to_string(), value.to_string());
        }
    }

    map
}

pub(crate) fn get_env_value(key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.trim().is_empty() {
            return Some(v);
        }
    }

    read_octo_env()
        .get(key)
        .cloned()
        .filter(|v| !v.trim().is_empty())
}

fn format_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("HTTP {}", status.as_u16())
    } else if trimmed.len() > 2000 {
        format!("HTTP {}: {}…", status.as_u16(), &trimmed[..2000])
    } else {
        format!("HTTP {}: {}", status.as_u16(), trimmed)
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiAudioTranscriptionResponse {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<OpenAiError>,
}

fn guess_audio_filename(mime_type: &str) -> &'static str {
    let mt = mime_type.to_lowercase();
    if mt.contains("webm") {
        "audio.webm"
    } else if mt.contains("mp4") {
        "audio.mp4"
    } else if mt.contains("mpeg") || mt.contains("mp3") {
        "audio.mp3"
    } else if mt.contains("ogg") {
        "audio.ogg"
    } else if mt.contains("wav") {
        "audio.wav"
    } else {
        "audio.bin"
    }
}

#[tauri::command]
async fn openai_transcribe_audio_with_key(
    api_key: String,
    audio_base64: String,
    mime_type: Option<String>,
    language: Option<String>,
    model: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    // NOTE: Do not log secrets. This only logs safe metadata to help debugging.
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("OpenAI API key is empty".to_string());
    }

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim().as_bytes())
        .map_err(|e| format!("Invalid audio_base64: {}", e))?;

    if bytes.is_empty() {
        return Ok("".to_string());
    }

    let mt = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let filename = guess_audio_filename(&mt).to_string();

    let url = format!(
        "{}/audio/transcriptions",
        OPENAI_BASE_URL_DEFAULT.trim_end_matches('/')
    );
    let model = model
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gpt-4o-transcribe".to_string());

    safe_eprintln!(
        "[stt] request: model={} lang={} mime={} bytes={} prompt_len={}",
        model,
        language.clone().unwrap_or_default().trim(),
        mt,
        bytes.len(),
        prompt.clone().unwrap_or_default().trim().len()
    );

    // Some servers behave better when the file part has the correct mime type.
    // `mime_str()` consumes the Part, so we build it in one shot and fall back if parsing fails.
    // Note: this clones `bytes` only for the "with-mime" attempt (small audio blobs are expected).
    let part = reqwest::multipart::Part::bytes(bytes.clone())
        .file_name(filename.clone())
        .mime_str(&mt)
        .unwrap_or_else(|_| reqwest::multipart::Part::bytes(bytes).file_name(filename));
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model)
        .text("temperature", "0");

    if let Some(lang) = language {
        let lang = lang.trim().to_string();
        if !lang.is_empty() {
            form = form.text("language", lang);
        }
    }

    if let Some(p) = prompt {
        let p = p.trim().to_string();
        if !p.is_empty() {
            // Keep prompt small to avoid accidental huge requests.
            let clipped = if p.len() > 400 {
                p[..400].to_string()
            } else {
                p
            };
            form = form.text("prompt", clipped);
        }
    }

    let client = shared_http_client();
    let res = client
        .post(url)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        safe_eprintln!(
            "[stt] response: status={} body_len={}",
            status.as_u16(),
            body.len()
        );
        return Err(format!(
            "OpenAI STT request failed: {}",
            format_http_error(status, &body)
        ));
    }

    let parsed: OpenAiAudioTranscriptionResponse = res.json().await.map_err(|e| e.to_string())?;
    if let Some(msg) = parsed.error.and_then(|e| e.message) {
        if !msg.trim().is_empty() {
            safe_eprintln!("[stt] response: error={}", msg.trim());
            return Err(msg);
        }
    }

    let out = parsed.text.unwrap_or_default().trim().to_string();
    safe_eprintln!("[stt] response: ok text_len={}", out.len());
    Ok(out)
}

// ─── Local Whisper (offline STT) ─────────────────────────────────────

/// Available local Whisper model presets with metadata.
#[derive(Debug, Clone, Serialize)]
struct WhisperModelPreset {
    value: String,
    label: String,
    size_mb: usize,
    url: String,
}

#[tauri::command]
fn list_local_whisper_models() -> Vec<WhisperModelPreset> {
    let base = common::LOCAL_WHISPER_MODEL_URL_BASE_DEFAULT.trim_end_matches('/');
    vec![
        WhisperModelPreset {
            value: "ggml-large-v3-turbo.bin".into(),
            label: "Large v3 Turbo (recommended, 1.6GB)".into(),
            size_mb: 1620,
            url: format!("{}/ggml-large-v3-turbo.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-large-v3-turbo-q5_0.bin".into(),
            label: "Large v3 Turbo Q5 (smaller, 574MB)".into(),
            size_mb: 574,
            url: format!("{}/ggml-large-v3-turbo-q5_0.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-large-v3.bin".into(),
            label: "Large v3 (best quality, 2.9GB)".into(),
            size_mb: 2900,
            url: format!("{}/ggml-large-v3.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-medium.bin".into(),
            label: "Medium (good, 1.5GB)".into(),
            size_mb: 1500,
            url: format!("{}/ggml-medium.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-small.bin".into(),
            label: "Small (fast, 466MB)".into(),
            size_mb: 466,
            url: format!("{}/ggml-small.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-base.bin".into(),
            label: "Base (light, 148MB)".into(),
            size_mb: 148,
            url: format!("{}/ggml-base.bin", base),
        },
        WhisperModelPreset {
            value: "ggml-tiny.bin".into(),
            label: "Tiny (fastest, 39MB)".into(),
            size_mb: 39,
            url: format!("{}/ggml-tiny.bin", base),
        },
    ]
}

/// Check whether a local Whisper model file is already downloaded.
#[tauri::command]
fn local_whisper_model_status(model_name: Option<String>) -> Result<serde_json::Value, String> {
    let filename = model_name
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(common::LOCAL_WHISPER_MODEL_DEFAULT);
    let home =
        common::resolve_home_dir().ok_or_else(|| "Could not resolve HOME dir".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".config")
        .join("octo")
        .join("whisper");
    let path = dir.join(filename);
    let exists = path.is_file();
    let size = if exists {
        std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    Ok(serde_json::json!({
        "model": filename,
        "exists": exists,
        "size": size,
        "path": path.to_string_lossy().to_string(),
    }))
}

async fn ensure_local_whisper_model_file(
    app: Option<&AppHandle>,
    model_name: Option<String>,
    allow_download: bool,
) -> Result<String, String> {
    let filename = model_name
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(common::LOCAL_WHISPER_MODEL_DEFAULT);

    let home =
        common::resolve_home_dir().ok_or_else(|| "Could not resolve HOME dir".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".config")
        .join("octo")
        .join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&filename);

    if path.is_file() {
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if meta.len() > 0 {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    // If the selected/default model is missing, prefer a model that already exists locally
    // instead of silently starting a multi-GB download during push-to-talk.
    let fallback_models = [
        common::LOCAL_WHISPER_MODEL_DEFAULT,
        "ggml-large-v3.bin",
        "ggml-large-v3-turbo-q5_0.bin",
        "ggml-medium.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-tiny.bin",
    ];
    for candidate in fallback_models {
        if candidate == filename {
            continue;
        }
        let candidate_path = dir.join(candidate);
        if let Ok(meta) = std::fs::metadata(&candidate_path) {
            if meta.is_file() && meta.len() > 0 {
                safe_eprintln!(
                    "[local-whisper] selected model '{}' is missing; using installed fallback '{}'",
                    filename,
                    candidate
                );
                return Ok(candidate_path.to_string_lossy().to_string());
            }
        }
    }

    // Voice model downloads are opt-in: never auto-download during transcription.
    // The user must explicitly trigger the download from Settings → Voice.
    if !allow_download {
        return Err(format!(
            "음성 모델 '{}'이(가) 다운로드되어 있지 않습니다. 설정 → 음성에서 모델을 먼저 내려받으세요.",
            filename
        ));
    }

    let url = common::get_env_value_or(
        "OCTO_LOCAL_WHISPER_MODEL_URL",
        &format!(
            "{}/{}",
            common::get_env_value_or(
                "OCTO_LOCAL_WHISPER_MODEL_URL_BASE",
                common::LOCAL_WHISPER_MODEL_URL_BASE_DEFAULT
            )
            .trim_end_matches('/'),
            filename
        ),
    );

    safe_eprintln!(
        "[local-whisper] downloading model: {} -> {}",
        url,
        path.display()
    );
    if let Some(app) = app {
        let _ = app.emit(
            "local-whisper-download-start",
            serde_json::json!({ "model": filename, "url": url }),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Local Whisper model download failed: {}",
            common::format_http_error(status, &body)
        ));
    }

    let total = res.content_length().unwrap_or(0);
    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut chunks: Vec<Vec<u8>> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let chunk_vec: Vec<u8> = chunk.to_vec();
        downloaded += chunk_vec.len() as u64;
        chunks.push(chunk_vec);
        if let Some(app) = app {
            if total > 0 {
                let pct = ((downloaded as f64 / total as f64) * 100.0).round() as u32;
                let _ = app.emit(
                    "local-whisper-download-progress",
                    serde_json::json!({
                        "model": filename,
                        "downloaded": downloaded,
                        "total": total,
                        "percent": pct,
                    }),
                );
            }
        }
    }

    let tmp = path.with_extension("download");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        for c in &chunks {
            f.write_all(c).map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;

    safe_eprintln!(
        "[local-whisper] model ready: {} ({} bytes)",
        path.display(),
        downloaded
    );
    if let Some(app) = app {
        let _ = app.emit(
            "local-whisper-download-done",
            serde_json::json!({ "model": filename, "size": downloaded }),
        );
    }

    Ok(path.to_string_lossy().to_string())
}

/// Explicitly download a local Whisper model (triggered from Settings → Voice).
/// Emits `local-whisper-download-{start,progress,done}` events for UI progress.
#[tauri::command]
async fn download_local_whisper_model(
    app: AppHandle,
    model_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = ensure_local_whisper_model_file(Some(&app), model_name.clone(), true).await?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "model": model_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| common::LOCAL_WHISPER_MODEL_DEFAULT.to_string()),
        "path": path,
        "size": size,
        "exists": true,
    }))
}

#[cfg(target_os = "macos")]
fn decode_wav_to_mono_f32(wav_bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let mut reader = hound::WavReader::new(Cursor::new(wav_bytes)).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let sample_rate = spec.sample_rate.max(1);

    let mut per_channel: Vec<Vec<f32>> = vec![Vec::new(); channels];

    match spec.sample_format {
        hound::SampleFormat::Float => {
            for (i, s) in reader.samples::<f32>().enumerate() {
                let v = s.map_err(|e| e.to_string())?;
                per_channel[i % channels].push(v);
            }
        }
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample.max(1) as i32;
            let denom = (1i64 << (bits - 1)) as f32;
            if bits <= 16 {
                for (i, s) in reader.samples::<i16>().enumerate() {
                    let v = s.map_err(|e| e.to_string())? as f32 / denom;
                    per_channel[i % channels].push(v);
                }
            } else {
                for (i, s) in reader.samples::<i32>().enumerate() {
                    let v = s.map_err(|e| e.to_string())? as f32 / denom;
                    per_channel[i % channels].push(v);
                }
            }
        }
    }

    let frames = per_channel.iter().map(|c| c.len()).min().unwrap_or(0);
    if frames == 0 {
        return Ok((Vec::new(), sample_rate));
    }

    let mut mono = Vec::with_capacity(frames);
    for i in 0..frames {
        let mut acc = 0.0f32;
        for ch in 0..channels {
            acc += per_channel[ch][i];
        }
        mono.push(acc / channels as f32);
    }

    Ok((mono, sample_rate))
}

#[cfg(target_os = "macos")]
fn resample_linear(samples: &[f32], from_sr: u32, to_sr: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if from_sr == to_sr {
        return samples.to_vec();
    }
    let ratio = to_sr as f64 / from_sr as f64;
    let out_len = ((samples.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = (i as f64) / ratio;
        let idx = src.floor() as usize;
        let frac = (src - (idx as f64)) as f32;
        let s0 = *samples.get(idx).unwrap_or(&0.0);
        let s1 = *samples.get(idx + 1).unwrap_or(&s0);
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

// Local Whisper (offline STT) is macOS-only — see Cargo.toml. On non-macOS the
// transcribe entry point returns a clear error instead of pulling in whisper.cpp.
#[cfg(not(target_os = "macos"))]
async fn local_whisper_transcribe_wav_base64(
    _app: Option<&AppHandle>,
    _wav_base64: String,
    _language: Option<String>,
    _model_name: Option<String>,
    _prompt: Option<String>,
) -> Result<String, String> {
    Err("로컬 음성 인식은 현재 macOS에서만 지원됩니다.".to_string())
}

#[cfg(target_os = "macos")]
static LOCAL_WHISPER_CONTEXT: OnceLock<
    std::sync::Mutex<HashMap<String, Result<whisper_rs::WhisperContext, String>>>,
> = OnceLock::new();

#[cfg(target_os = "macos")]
async fn local_whisper_transcribe_wav_base64(
    app: Option<&AppHandle>,
    wav_base64: String,
    language: Option<String>,
    model_name: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    use base64::Engine;

    let wav_bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.trim().as_bytes())
        .map_err(|e| format!("Invalid wav_base64: {}", e))?;

    if wav_bytes.is_empty() {
        return Ok("".to_string());
    }

    let (samples, sr) = decode_wav_to_mono_f32(&wav_bytes)?;
    let audio = resample_linear(&samples, sr, 16_000);

    // Never auto-download here: the model must be fetched explicitly from
    // Settings → Voice (download_local_whisper_model). Only use what's present.
    let model_path = ensure_local_whisper_model_file(app, model_name.clone(), false).await?;
    let model_key = std::path::Path::new(&model_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(common::LOCAL_WHISPER_MODEL_DEFAULT)
        .to_string();

    let ctx_map = LOCAL_WHISPER_CONTEXT.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut map = ctx_map
        .lock()
        .map_err(|_| "Whisper context map lock failed".to_string())?;

    if !map.contains_key(&model_key) {
        let mut ctx_params = whisper_rs::WhisperContextParameters::new();
        // Default to GPU on macOS for better performance; CPU elsewhere unless forced.
        #[cfg(target_os = "macos")]
        let use_gpu_default = true;
        #[cfg(not(target_os = "macos"))]
        let use_gpu_default = false;

        let use_gpu = common::get_env_value("OCTO_LOCAL_WHISPER_USE_GPU")
            .map(|v| v.to_lowercase())
            .map(|v| v == "1" || v == "true" || v == "yes" || v == "on")
            .unwrap_or(use_gpu_default);

        ctx_params.use_gpu(use_gpu);
        safe_eprintln!(
            "[local-whisper] loading model={} gpu={}",
            model_key,
            use_gpu
        );

        let ctx_res = match whisper_rs::WhisperContext::new_with_params(&model_path, ctx_params) {
            Ok(ctx) => Ok(ctx),
            Err(gpu_err) if use_gpu => {
                safe_eprintln!(
                    "[local-whisper] gpu load failed for {}; retrying on cpu: {}",
                    model_key,
                    gpu_err
                );
                let mut cpu_params = whisper_rs::WhisperContextParameters::new();
                cpu_params.use_gpu(false);
                whisper_rs::WhisperContext::new_with_params(&model_path, cpu_params).map_err(
                    |cpu_err| {
                        format!(
                            "Failed to load local Whisper model. GPU error: {}; CPU error: {}",
                            gpu_err, cpu_err
                        )
                    },
                )
            }
            Err(err) => Err(format!("Failed to load local Whisper model: {}", err)),
        };

        let ctx = ctx_res?;
        map.insert(model_key.clone(), Ok(ctx));
    }

    let ctx = map
        .get(&model_key)
        .ok_or("Whisper model not loaded".to_string())?
        .as_ref()
        .map_err(|e| e.clone())?;

    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Whisper create_state failed: {}", e))?;

    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::BeamSearch {
        beam_size: 5,
        patience: 1.0,
    });

    let lang = language
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let v = common::get_env_value_or("OCTO_LOCAL_WHISPER_LANGUAGE", "ko");
            if v.trim().is_empty() {
                None
            } else {
                Some(v)
            }
        });
    if let Some(l) = lang.as_deref() {
        params.set_language(Some(l));
    }

    params.set_translate(false);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(4);
    params.set_n_threads(threads);
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_single_segment(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_temperature(0.0);
    params.set_temperature_inc(0.0);
    params.set_print_progress(false);
    params.set_print_special(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    let prompt = prompt
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            "다음은 BBARIT Terminal(빠릿 터미널)에서 말한 한국어 받아쓰기입니다. 빠릿, 빠릿터미널, BBARIT, Codex, Claude, 터미널, 로컬 위스퍼 같은 제품명과 개발 용어를 정확히 적어주세요.".to_string()
        });
    params.set_initial_prompt(&prompt);

    state
        .full(params, &audio)
        .map_err(|e| format!("Whisper full() failed: {}", e))?;

    let n = state
        .full_n_segments()
        .map_err(|e| format!("Whisper full_n_segments failed: {}", e))?;
    let mut out = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            out.push_str(&seg);
        }
    }

    Ok(out.trim().to_string())
}

#[tauri::command]
async fn transcribe_audio_auto(
    app: AppHandle,
    wav_base64: String,
    language: Option<String>,
    _use_local: Option<bool>,
    local_model: Option<String>,
    prompt: Option<String>,
) -> Result<String, String> {
    local_whisper_transcribe_wav_base64(Some(&app), wav_base64, language, local_model, prompt).await
}

#[tauri::command]
fn debug_log(message: String) {
    let m = message.trim();
    if !m.is_empty() {
        safe_eprintln!("[debug] {}", m);
    }
}

#[tauri::command]
fn get_web_terminal_info(
    state: State<'_, Arc<web_terminal::WebTerminalState>>,
) -> Result<serde_json::Value, String> {
    // The web terminal is served on the REMOTE (tunnelable, auth-gated) port.
    Ok(serde_json::json!({
        "token": state.token(),
        "port": browser_bridge::REMOTE_PORT,
        "url": format!("http://127.0.0.1:{}/web", browser_bridge::REMOTE_PORT),
    }))
}

/// Resolve a pending editor-bridge request (see browser_bridge::handle_editor).
/// The frontend calls this after handling an `editor-bridge-request` event.
#[tauri::command]
fn editor_bridge_respond(request_id: String, result: serde_json::Value) -> Result<(), String> {
    if browser_bridge::editor_resolve(&request_id, result) {
        Ok(())
    } else {
        Err("unknown or already-resolved editor bridge request".into())
    }
}

/// External-facing gateway access info for the app UI (QR / share URL). Returns
/// only the EXTERNAL WS token — never the internal UI-bus token.
#[tauri::command]
fn gateway_info() -> serde_json::Value {
    // The chat page lives on the REMOTE (tunnelable, auth-gated) port.
    let port = browser_bridge::REMOTE_PORT;
    let token = agent_gateway::ws_token();
    serde_json::json!({
        "port": port,
        "wsToken": token,
        "localUrl": format!("http://127.0.0.1:{port}/gateway?token={token}"),
        "requiresPassword": configured_gateway_password().is_some(),
    })
}

/// Resolve a pending gateway UI command (see agent_gateway::handle_gateway_ui).
/// App.tsx calls this after handling a `gateway-ui-command` event.
#[tauri::command]
fn gateway_ui_respond(request_id: String, result: serde_json::Value) -> Result<(), String> {
    if agent_gateway::ui_resolve(&request_id, result) {
        Ok(())
    } else {
        Err("unknown or already-resolved gateway ui request".into())
    }
}

/// Run a cloudflared CLI command and return stdout.
#[tauri::command]
async fn cloudflared_command(args: Vec<String>) -> Result<serde_json::Value, String> {
    // Find cloudflared binary (cross-platform)
    let bin = {
        #[cfg(not(target_os = "windows"))]
        {
            [
                "/opt/homebrew/bin/cloudflared",
                "/usr/local/bin/cloudflared",
            ]
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                common::no_window_command("/bin/sh")
                    .args(["-lc", "which cloudflared"])
                    .output()
                    .ok()
                    .and_then(|o| {
                        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        if o.status.success() && !p.is_empty() {
                            Some(p)
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| "cloudflared".to_string())
            })
        }
        #[cfg(target_os = "windows")]
        {
            [
                r"C:\Program Files\cloudflared\cloudflared.exe",
                r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
                r"C:\ProgramData\chocolatey\bin\cloudflared.exe",
            ]
            .iter()
            .find(|p| std::path::Path::new(p).exists())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                if let Ok(home) = std::env::var("USERPROFILE") {
                    let scoop = format!(r"{}\scoop\shims\cloudflared.exe", home);
                    if std::path::Path::new(&scoop).exists() {
                        return scoop;
                    }
                }
                common::no_window_command("where.exe")
                    .arg("cloudflared")
                    .output()
                    .ok()
                    .and_then(|o| {
                        let p = String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if o.status.success() && !p.is_empty() {
                            Some(p)
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| "cloudflared".to_string())
            })
        }
    };

    let mut cmd = common::no_window_command(&bin);
    cmd.args(&args);
    // Enrich PATH for bundled macOS app (minimal PATH by default)
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| {
            std::env::var("USER")
                .map(|u| format!("/Users/{}", u))
                .unwrap_or_else(|_| "/tmp".to_string())
        });
        cmd.env("PATH", format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:{}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home
        ));
    }
    let output = cmd
        .output()
        .map_err(|e| format!("cloudflared not found or failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(serde_json::json!({
        "success": output.status.success(),
        "stdout": stdout,
        "stderr": stderr,
        "code": output.status.code(),
    }))
}

static TELEGRAM_GETUPDATES_LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn telegram_getupdates_lock() -> &'static AsyncMutex<()> {
    TELEGRAM_GETUPDATES_LOCK.get_or_init(|| AsyncMutex::new(()))
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpRequestInput {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct HttpResponseOutput {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
    truncated: bool,
}

#[tauri::command]
async fn http_request(input: HttpRequestInput) -> Result<HttpResponseOutput, String> {
    let method = input.method.trim().to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "Invalid HTTP method".to_string())?;

    let url = reqwest::Url::parse(input.url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("URL scheme must be http or https".to_string());
    }

    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(30_000).clamp(1_000, 600_000));
    let client = shared_http_client();

    let mut req = client.request(method, url).timeout(timeout);
    for (k, v) in input.headers.into_iter() {
        let name = reqwest::header::HeaderName::from_bytes(k.trim().as_bytes())
            .map_err(|_| format!("Invalid header name: {}", k))?;
        let value = reqwest::header::HeaderValue::from_str(v.trim())
            .map_err(|_| format!("Invalid header value for {}.", k))?;
        req = req.header(name, value);
    }

    if let Some(body) = input.body {
        req = req.body(body);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();

    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|vs| (k.as_str().to_string(), vs.to_string()))
        })
        .collect();

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let truncated = bytes.len() > HTTP_BODY_MAX_BYTES;
    let body_bytes = if truncated {
        bytes.slice(..HTTP_BODY_MAX_BYTES)
    } else {
        bytes
    };

    let body = String::from_utf8_lossy(&body_bytes).to_string();
    Ok(HttpResponseOutput {
        status: status.as_u16(),
        status_text,
        headers,
        body,
        truncated,
    })
}

// ── Streaming HTTP for AI chat (SSE / NDJSON) ──

#[tauri::command]
async fn http_stream_request(
    app: AppHandle,
    stream_id: String,
    input: HttpRequestInput,
) -> Result<(), String> {
    let method_str = input.method.trim().to_uppercase();
    let method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|_| "Invalid HTTP method".to_string())?;

    let url = reqwest::Url::parse(input.url.trim()).map_err(|e| format!("Invalid URL: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("URL scheme must be http or https".to_string());
    }

    let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(300_000).clamp(5_000, 600_000));
    let client = shared_http_client();
    let mut req = client.request(method, url).timeout(timeout);
    for (k, v) in input.headers.into_iter() {
        let name = reqwest::header::HeaderName::from_bytes(k.trim().as_bytes())
            .map_err(|_| format!("Invalid header name: {}", k))?;
        let value = reqwest::header::HeaderValue::from_str(v.trim())
            .map_err(|_| format!("Invalid header value for {}.", k))?;
        req = req.header(name, value);
    }
    if let Some(body) = input.body {
        req = req.body(body);
    }

    let app2 = app.clone();
    let sid = stream_id.clone();
    tokio::spawn(async move {
        match req.send().await {
            Ok(res) => {
                let status = res.status().as_u16();
                if status >= 400 {
                    let body = res.text().await.unwrap_or_default();
                    let _ = app2.emit(&format!("ai-stream-{}", sid), serde_json::json!({
                        "type": "error", "error": format!("HTTP {}: {}", status, &body[..body.len().min(500)])
                    }));
                    return;
                }
                use futures::StreamExt;
                let mut stream = res.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            let _ = app2.emit(
                                &format!("ai-stream-{}", sid),
                                serde_json::json!({
                                    "type": "chunk", "data": text
                                }),
                            );
                        }
                        Err(e) => {
                            let _ = app2.emit(
                                &format!("ai-stream-{}", sid),
                                serde_json::json!({
                                    "type": "error", "error": e.to_string()
                                }),
                            );
                            break;
                        }
                    }
                }
                let _ = app2.emit(
                    &format!("ai-stream-{}", sid),
                    serde_json::json!({
                        "type": "done"
                    }),
                );
            }
            Err(e) => {
                let _ = app2.emit(
                    &format!("ai-stream-{}", sid),
                    serde_json::json!({
                        "type": "error", "error": e.to_string()
                    }),
                );
            }
        }
    });
    Ok(())
}

fn get_telegram_bot_token() -> Option<String> {
    get_env_value("TELEGRAM_BOT_TOKEN").or_else(|| get_env_value("TELEGRAM_TOKEN"))
}

fn get_telegram_chat_id() -> Option<String> {
    get_env_value("TELEGRAM_CHAT_ID")
}

#[derive(Debug, Serialize)]
struct TelegramSendMessageRequest {
    chat_id: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_thread_id: Option<i64>,
    disable_web_page_preview: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_markup: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TelegramApiResponse<T> {
    ok: bool,
    #[serde(default)]
    result: Option<T>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TelegramGetMeResult {
    id: i64,
    #[serde(default)]
    username: Option<String>,
    first_name: String,
    #[serde(default)]
    is_bot: bool,
}

#[derive(Debug, Serialize)]
struct TelegramVerifyOutput {
    id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    first_name: String,
    is_bot: bool,
}

#[tauri::command]
async fn telegram_verify_bot_token_any(bot_token: String) -> Result<TelegramVerifyOutput, String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Telegram bot token is empty.".to_string());
    }

    let url = format!("{}/bot{}/getMe", TELEGRAM_API_BASE_URL, token);
    let client = shared_http_client();

    let res = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format_http_error(status, &body));
    }

    let parsed: TelegramApiResponse<TelegramGetMeResult> =
        serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if !parsed.ok {
        return Err(parsed
            .description
            .unwrap_or_else(|| "Telegram getMe failed".to_string()));
    }
    let me = parsed
        .result
        .ok_or_else(|| "Telegram getMe failed".to_string())?;
    Ok(TelegramVerifyOutput {
        id: me.id,
        username: me.username,
        first_name: me.first_name,
        is_bot: me.is_bot,
    })
}

// ── Discord ──

const DISCORD_API_BASE_URL: &str = "https://discord.com/api/v10";

#[derive(Debug, Serialize)]
struct DiscordIncoming {
    message_id: String,
    channel_id: String,
    author_id: String,
    author_username: String,
    author_is_bot: bool,
    content: String,
}

#[derive(Debug, Serialize)]
struct DiscordGetMessagesOutput {
    messages: Vec<DiscordIncoming>,
    last_message_id: String,
}

#[derive(Debug, Serialize)]
struct DiscordVerifyOutput {
    id: String,
    username: String,
}

#[tauri::command]
async fn discord_send_message(
    bot_token: String,
    channel_id: String,
    text: String,
) -> Result<(), String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Discord bot token is empty.".to_string());
    }
    let channel = channel_id.trim().to_string();
    if channel.is_empty() {
        return Err("Discord channel ID is empty.".to_string());
    }
    let trimmed = text.trim_end_matches('\n').to_string();
    if trimmed.is_empty() {
        return Ok(());
    }

    let client = shared_http_client();
    let chunks: Vec<String> = if trimmed.len() <= 2000 {
        vec![trimmed]
    } else {
        trimmed
            .chars()
            .collect::<Vec<char>>()
            .chunks(2000)
            .map(|c| c.iter().collect())
            .collect()
    };

    for chunk in chunks {
        let url = format!("{}/channels/{}/messages", DISCORD_API_BASE_URL, channel);
        let res = client
            .post(url)
            .header("Authorization", format!("Bot {}", token))
            .json(&serde_json::json!({ "content": chunk }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!(
                "Discord sendMessage failed: {}",
                format_http_error(status, &body)
            ));
        }
    }

    Ok(())
}

#[tauri::command]
async fn discord_get_messages(
    bot_token: String,
    channel_id: String,
    after_message_id: Option<String>,
) -> Result<DiscordGetMessagesOutput, String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Discord bot token is empty.".to_string());
    }
    let channel = channel_id.trim().to_string();
    if channel.is_empty() {
        return Err("Discord channel ID is empty.".to_string());
    }

    let client = shared_http_client();
    let mut url = reqwest::Url::parse(&format!(
        "{}/channels/{}/messages",
        DISCORD_API_BASE_URL, channel
    ))
    .map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("limit", "100");
        if let Some(ref after) = after_message_id {
            let a = after.trim();
            if !a.is_empty() {
                qp.append_pair("after", a);
            }
        }
    }

    let res = client
        .get(url)
        .header("Authorization", format!("Bot {}", token))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Discord getMessages failed: {}",
            format_http_error(status, &body)
        ));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let arr = body
        .as_array()
        .ok_or_else(|| "Discord: expected array response".to_string())?;

    let mut messages: Vec<DiscordIncoming> = Vec::new();
    let mut last_id = after_message_id.clone().unwrap_or_default();

    // Discord returns messages newest-first; reverse to process oldest-first
    for msg in arr.iter().rev() {
        let msg_id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let content = msg
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let author = msg.get("author");
        let author_id = author
            .and_then(|a| a.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let author_username = author
            .and_then(|a| a.get("username"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let author_is_bot = author
            .and_then(|a| a.get("bot"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let channel_id_val = msg
            .get("channel_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if !msg_id.is_empty() && msg_id > last_id {
            last_id = msg_id.clone();
        }

        if author_is_bot || content.is_empty() {
            continue;
        }

        messages.push(DiscordIncoming {
            message_id: msg_id,
            channel_id: channel_id_val,
            author_id,
            author_username,
            author_is_bot,
            content,
        });
    }

    Ok(DiscordGetMessagesOutput {
        messages,
        last_message_id: last_id,
    })
}

#[tauri::command]
async fn discord_verify_bot_token(bot_token: String) -> Result<DiscordVerifyOutput, String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Discord bot token is empty.".to_string());
    }

    let client = shared_http_client();
    let url = format!("{}/users/@me", DISCORD_API_BASE_URL);
    let res = client
        .get(url)
        .header("Authorization", format!("Bot {}", token))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format_http_error(status, &body));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(DiscordVerifyOutput { id, username })
}

// ── Slack ──

const SLACK_API_BASE_URL: &str = "https://slack.com/api";

#[derive(Debug, Serialize)]
struct SlackIncoming {
    ts: String,
    channel: String,
    user: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct SlackGetMessagesOutput {
    messages: Vec<SlackIncoming>,
    latest_ts: String,
}

#[derive(Debug, Serialize)]
struct SlackVerifyOutput {
    ok: bool,
    user_id: String,
    team: String,
}

#[tauri::command]
async fn slack_send_message(
    bot_token: String,
    channel: String,
    text: String,
) -> Result<(), String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Slack bot token is empty.".to_string());
    }
    let ch = channel.trim().to_string();
    if ch.is_empty() {
        return Err("Slack channel is empty.".to_string());
    }
    let trimmed = text.trim_end_matches('\n').to_string();
    if trimmed.is_empty() {
        return Ok(());
    }

    let client = shared_http_client();
    // Slack limits messages to ~40000 chars; chunk at 3900 for code blocks
    let chunks: Vec<String> = if trimmed.len() <= 3900 {
        vec![trimmed]
    } else {
        trimmed
            .chars()
            .collect::<Vec<char>>()
            .chunks(3900)
            .map(|c| c.iter().collect())
            .collect()
    };

    for chunk in chunks {
        let url = format!("{}/chat.postMessage", SLACK_API_BASE_URL);
        let res = client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Content-Type", "application/json; charset=utf-8")
            .json(&serde_json::json!({
                "channel": ch,
                "text": chunk,
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!(
                "Slack chat.postMessage failed: {}",
                format_http_error(status, &body)
            ));
        }

        let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let err = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            return Err(format!("Slack API error: {}", err));
        }
    }

    Ok(())
}

#[tauri::command]
async fn slack_get_messages(
    bot_token: String,
    channel: String,
    oldest_ts: Option<String>,
) -> Result<SlackGetMessagesOutput, String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Slack bot token is empty.".to_string());
    }
    let ch = channel.trim().to_string();
    if ch.is_empty() {
        return Err("Slack channel is empty.".to_string());
    }

    let client = shared_http_client();
    let mut url = reqwest::Url::parse(&format!("{}/conversations.history", SLACK_API_BASE_URL))
        .map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("channel", &ch);
        qp.append_pair("limit", "100");
        if let Some(ref ts) = oldest_ts {
            let t = ts.trim();
            if !t.is_empty() {
                qp.append_pair("oldest", t);
            }
        }
    }

    let res = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Slack conversations.history failed: {}",
            format_http_error(status, &body)
        ));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("Slack API error: {}", err));
    }

    let msgs = body.get("messages").and_then(|v| v.as_array());
    let mut messages: Vec<SlackIncoming> = Vec::new();
    let mut latest_ts = oldest_ts.clone().unwrap_or_default();

    if let Some(arr) = msgs {
        // Slack returns newest-first; reverse to process oldest-first
        for msg in arr.iter().rev() {
            let ts = msg
                .get("ts")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let user = msg
                .get("user")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let text = msg
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let subtype = msg.get("subtype").and_then(|v| v.as_str());

            // Skip bot messages and subtypes (join/leave etc)
            if subtype.is_some() || user.is_empty() || text.is_empty() {
                continue;
            }

            if ts > latest_ts {
                latest_ts = ts.clone();
            }

            messages.push(SlackIncoming {
                ts,
                channel: ch.clone(),
                user,
                text,
            });
        }
    }

    Ok(SlackGetMessagesOutput {
        messages,
        latest_ts,
    })
}

#[tauri::command]
async fn slack_verify_token(bot_token: String) -> Result<SlackVerifyOutput, String> {
    let token = bot_token.trim().to_string();
    if token.is_empty() {
        return Err("Slack bot token is empty.".to_string());
    }

    let client = shared_http_client();
    let url = format!("{}/auth.test", SLACK_API_BASE_URL);
    let res = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format_http_error(status, &body));
    }

    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let err = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("Slack auth.test error: {}", err));
    }

    let user_id = body
        .get("user_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let team = body
        .get("team")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(SlackVerifyOutput {
        ok: true,
        user_id,
        team,
    })
}

// ── Telegram (send/get/verify) ──

async fn telegram_send_message_internal(
    token: String,
    chat_id: String,
    text: String,
    reply_markup_json: Option<String>,
) -> Result<(), String> {
    let client = shared_http_client();

    // Telegram hard-limits messages to ~4096 chars. Keep some headroom.
    let chunks: Vec<String> = {
        let trimmed = text.trim_end_matches('\n').to_string();
        if trimmed.len() <= 4000 {
            vec![trimmed]
        } else {
            trimmed
                .chars()
                .collect::<Vec<char>>()
                .chunks(4000)
                .map(|c| c.iter().collect())
                .collect()
        }
    };

    let reply_markup: Option<serde_json::Value> = reply_markup_json.and_then(|s| {
        let trimmed = s.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            serde_json::from_str::<serde_json::Value>(&trimmed).ok()
        }
    });

    let mut first = true;
    for chunk in chunks {
        let url = format!("{}/bot{}/sendMessage", TELEGRAM_API_BASE_URL, token);
        let res = client
            .post(url)
            .json(&TelegramSendMessageRequest {
                chat_id: chat_id.clone(),
                text: chunk,
                message_thread_id: None,
                disable_web_page_preview: true,
                reply_markup: if first { reply_markup.clone() } else { None },
            })
            .send()
            .await
            .map_err(|e| e.to_string())?;
        first = false;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!(
                "Telegram sendMessage failed: {}",
                format_http_error(status, &body)
            ));
        }

        let parsed: TelegramApiResponse<serde_json::Value> =
            res.json().await.map_err(|e| e.to_string())?;
        if !parsed.ok {
            return Err(parsed
                .description
                .unwrap_or_else(|| "Telegram sendMessage failed".to_string()));
        }
    }

    Ok(())
}

#[tauri::command]
async fn telegram_send_message(
    text: String,
    reply_markup_json: Option<String>,
) -> Result<(), String> {
    let token = get_telegram_bot_token().ok_or_else(|| {
        "Telegram bot token is not set. Open Settings → Agent → Telegram → Bot Token.".to_string()
    })?;
    let chat_id = get_telegram_chat_id().ok_or_else(|| {
        "Telegram chat id is not set. Link a chat in the terminal (Telegram Link).".to_string()
    })?;

    telegram_send_message_internal(token, chat_id, text, reply_markup_json).await
}

#[tauri::command]
async fn telegram_send_message_with_token(
    bot_token: String,
    chat_id: String,
    text: String,
    reply_markup_json: Option<String>,
) -> Result<(), String> {
    let token = if bot_token.trim().is_empty() {
        get_telegram_bot_token().ok_or_else(|| {
            "Telegram bot token is empty. Open Settings → Agent → Telegram → Bot Token.".to_string()
        })?
    } else {
        bot_token.trim().to_string()
    };

    let chat = if chat_id.trim().is_empty() {
        get_telegram_chat_id().ok_or_else(|| {
            "Telegram chat id is empty. Link a chat in the terminal (Telegram Link).".to_string()
        })?
    } else {
        chat_id.trim().to_string()
    };

    telegram_send_message_internal(token, chat, text, reply_markup_json).await
}

#[derive(Debug, Deserialize)]
struct TelegramUpdateResponse {
    ok: bool,
    #[serde(default)]
    result: Vec<TelegramUpdate>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramApiOkResponse {
    ok: bool,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUpdate {
    update_id: i64,
    #[serde(default)]
    message: Option<TelegramMessage>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    #[serde(default)]
    text: Option<String>,
    chat: TelegramChat,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default, rename = "type")]
    chat_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct TelegramIncoming {
    update_id: i64,
    chat_id: i64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct TelegramGetUpdatesOutput {
    updates: Vec<TelegramIncoming>,
    next_offset: i64,
}

#[tauri::command]
async fn telegram_get_updates(offset: Option<i64>) -> Result<TelegramGetUpdatesOutput, String> {
    let _guard = telegram_getupdates_lock().lock().await;
    let token = get_telegram_bot_token().ok_or_else(|| {
        "Telegram bot token is not set. Open Settings → Agent → Telegram → Bot Token.".to_string()
    })?;

    let chat_id_filter = get_telegram_chat_id().and_then(|s| s.parse::<i64>().ok());
    let offset_val = offset.unwrap_or(0).max(0);

    let parsed = fetch_telegram_updates(&token, offset_val).await?;
    parse_telegram_updates(parsed, offset_val, chat_id_filter)
}

#[tauri::command]
async fn telegram_get_updates_any(
    bot_token: String,
    offset: Option<i64>,
) -> Result<TelegramGetUpdatesOutput, String> {
    let _guard = telegram_getupdates_lock().lock().await;
    let token = if bot_token.trim().is_empty() {
        get_telegram_bot_token().ok_or_else(|| {
            "Telegram bot token is not set. Open Settings → Agent → Telegram → Bot Token."
                .to_string()
        })?
    } else {
        bot_token.trim().to_string()
    };

    let offset_val = offset.unwrap_or(0).max(0);

    let parsed = fetch_telegram_updates(&token, offset_val).await?;
    parse_telegram_updates(parsed, offset_val, None)
}

/// Shared helper: fetch updates from Telegram API with long-polling.
async fn fetch_telegram_updates(
    token: &str,
    offset_val: i64,
) -> Result<TelegramUpdateResponse, String> {
    let client = shared_http_client();
    let timeout_str = TELEGRAM_LONG_POLL_SECS.to_string();

    let build_get_updates_url = || -> Result<reqwest::Url, String> {
        let mut url = reqwest::Url::parse(&format!(
            "{}/bot{}/getUpdates",
            TELEGRAM_API_BASE_URL, token
        ))
        .map_err(|e| e.to_string())?;
        {
            let mut qp = url.query_pairs_mut();
            qp.append_pair("timeout", &timeout_str);
            qp.append_pair("offset", &offset_val.to_string());
            qp.append_pair("limit", "50");
            qp.append_pair("allowed_updates", r#"["message"]"#);
        }
        Ok(url)
    };

    let mut res = {
        let url = build_get_updates_url()?;
        client
            .get(url)
            .timeout(Duration::from_secs(TELEGRAM_LONG_POLL_SECS + 10))
            .send()
            .await
            .map_err(|e| e.to_string())?
    };

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let lower = body.to_lowercase();

        // If webhook is active, getUpdates fails with HTTP 409.
        // Try to disable webhook once and retry polling.
        if status.as_u16() == 409 && lower.contains("webhook") {
            let _ = delete_telegram_webhook(token).await;
            res = {
                let url = build_get_updates_url()?;
                client
                    .get(url)
                    .timeout(Duration::from_secs(TELEGRAM_LONG_POLL_SECS + 10))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?
            };
            if !res.status().is_success() {
                let retry_status = res.status();
                let retry_body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Telegram getUpdates failed after deleteWebhook retry: {}",
                    format_http_error(retry_status, &retry_body)
                ));
            }
            return res.json().await.map_err(|e| e.to_string());
        }

        return Err(format!(
            "Telegram getUpdates failed: {}",
            format_http_error(status, &body)
        ));
    }

    res.json().await.map_err(|e| e.to_string())
}

async fn delete_telegram_webhook(token: &str) -> Result<(), String> {
    let client = shared_http_client();
    let mut url = reqwest::Url::parse(&format!(
        "{}/bot{}/deleteWebhook",
        TELEGRAM_API_BASE_URL, token
    ))
    .map_err(|e| e.to_string())?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("drop_pending_updates", "false");
    }

    let res = client
        .post(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Telegram deleteWebhook failed: {}",
            format_http_error(status, &body)
        ));
    }

    let parsed = res
        .json::<TelegramApiOkResponse>()
        .await
        .map_err(|e| e.to_string())?;
    if parsed.ok {
        Ok(())
    } else {
        Err(parsed
            .description
            .unwrap_or_else(|| "Telegram deleteWebhook failed".to_string()))
    }
}

/// Shared helper: parse Telegram update response into our output format.
fn parse_telegram_updates(
    parsed: TelegramUpdateResponse,
    offset_val: i64,
    chat_id_filter: Option<i64>,
) -> Result<TelegramGetUpdatesOutput, String> {
    if !parsed.ok {
        return Err(parsed
            .description
            .unwrap_or_else(|| "Telegram getUpdates failed".to_string()));
    }

    let mut updates: Vec<TelegramIncoming> = Vec::new();
    let mut max_update_id: i64 = offset_val.saturating_sub(1);

    for u in parsed.result.into_iter() {
        if u.update_id > max_update_id {
            max_update_id = u.update_id;
        }
        let Some(msg) = u.message else { continue };
        let Some(text) = msg.text else { continue };
        let chat_id = msg.chat.id;
        if let Some(allowed) = chat_id_filter {
            if chat_id != allowed {
                continue;
            }
        }

        let chat_title = msg.chat.title.clone().or_else(|| {
            let first = msg.chat.first_name.clone().unwrap_or_default();
            let last = msg.chat.last_name.clone().unwrap_or_default();
            let combined = format!("{} {}", first.trim(), last.trim())
                .trim()
                .to_string();
            if combined.is_empty() {
                None
            } else {
                Some(combined)
            }
        });

        updates.push(TelegramIncoming {
            update_id: u.update_id,
            chat_id,
            text,
            chat_title,
            chat_username: msg.chat.username.clone(),
            chat_type: msg.chat.chat_type.clone(),
        });
    }

    let next_offset = max_update_id.saturating_add(1).max(offset_val);
    Ok(TelegramGetUpdatesOutput {
        updates,
        next_offset,
    })
}

fn spawn_utf8_reader_thread(
    mut reader: Box<dyn Read + Send>,
    tx: SyncSender<String>,
    alive: Arc<AtomicBool>,
    output_buffer: Option<Arc<Mutex<String>>>,
    last_output_at: Option<Arc<Mutex<std::time::Instant>>>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();
        let mut dropped_output = false;
        // Cap buffer below 1 MB to prevent long-running terminals from retaining
        // too much historical output just for orchestra-side inspection.
        // When the buffer exceeds this limit, trim the front half so that
        // the most recent output (which usually contains the final JSON plan)
        // is always preserved.
        const OUTPUT_BUFFER_MAX: usize = 768 * 1024;

        let mut try_send = |data: String| {
            if data.is_empty() {
                return true;
            }

            // Idle-debounce readiness: stamp the time of the most recent output so the
            // broker can tell "settled / turn complete" from "still streaming".
            if let Some(ref ts) = last_output_at {
                if let Ok(mut t) = ts.lock() {
                    *t = std::time::Instant::now();
                }
            }

            // Also append to the output buffer if provided.
            if let Some(ref buf_arc) = output_buffer {
                if let Ok(mut buf) = buf_arc.lock() {
                    buf.push_str(&data);
                    // If buffer exceeds limit, trim the front half
                    if buf.len() > OUTPUT_BUFFER_MAX {
                        let trim_at = buf.len() / 2;
                        // Find a safe UTF-8 boundary
                        let safe_trim = buf.ceil_char_boundary(trim_at);
                        let trimmed = buf.split_off(safe_trim);
                        *buf = trimmed;
                    }
                }
            }

            // If we previously dropped output due to a full queue, try to emit a marker once we have space.
            if dropped_output {
                match tx.try_send("\r\n[output truncated]\r\n".to_string()) {
                    Ok(()) => dropped_output = false,
                    Err(TrySendError::Disconnected(_)) => return false,
                    Err(TrySendError::Full(_)) => {
                        // Still full, keep the dropped flag set.
                    }
                }
            }

            // Never block the reader thread for a full output queue. If the frontend
            // falls behind, keep the PTY draining and mark the visible output as truncated.
            match tx.try_send(data) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    dropped_output = true;
                    true
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);

                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !try_send(s.to_string()) {
                                    return;
                                }
                                pending.clear();
                                break;
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid = &pending[..valid_up_to];
                                    if !try_send(String::from_utf8_lossy(valid).to_string()) {
                                        return;
                                    }
                                }

                                if let Some(len) = e.error_len() {
                                    // Drop invalid byte(s) and keep trying to decode the rest.
                                    pending.drain(0..(valid_up_to + len));
                                    if pending.is_empty() {
                                        break;
                                    }
                                } else {
                                    // Incomplete UTF-8 sequence at the end; keep it for the next read.
                                    pending.drain(0..valid_up_to);
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }

        if !pending.is_empty() {
            let _ = try_send(String::from_utf8_lossy(&pending).to_string());
        }

        // Signal that the PTY process has exited
        alive.store(false, Ordering::Relaxed);
    });
}

/// Owner segment of a github.com remote URL (https, ssh or scp-style), if any.
#[cfg(not(target_os = "windows"))]
fn github_remote_owner(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();
    // Strip the scheme and userinfo so only an exact `github.com` host matches.
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    let path = rest.strip_prefix("github.com")?;
    let path = path
        .strip_prefix(':')
        .or_else(|| path.strip_prefix('/'))?
        .trim_start_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?.trim();
    if owner.is_empty() || parts.next().map_or(true, |r| r.is_empty()) {
        return None;
    }
    Some(owner.to_string())
}

/// gh login to use for a remote owner: an explicit `owners` entry in
/// ~/.config/octo/github-accounts.json wins, otherwise the owner name itself
/// (a personal repo owned by one of the logged-in gh accounts).
#[cfg(not(target_os = "windows"))]
fn github_login_candidates(owner: &str, mapping: Option<&serde_json::Value>) -> Vec<String> {
    let mut logins = Vec::new();
    if let Some(login) = mapping
        .and_then(|m| m.get("owners"))
        .and_then(|o| o.as_object())
        .and_then(|o| o.iter().find(|(k, _)| k.eq_ignore_ascii_case(owner)))
        .and_then(|(_, v)| v.as_str())
    {
        logins.push(login.to_string());
    }
    if !logins.iter().any(|l| l.eq_ignore_ascii_case(owner)) {
        logins.push(owner.to_string());
    }
    logins
}

/// Logged-in github.com accounts and the active one, parsed from gh's
/// hosts.yml (`github.com: users: <login>: ... user: <active>`). Older gh
/// versions without multi-account support only write `user:`, which then
/// counts as the single account.
#[cfg(not(target_os = "windows"))]
fn parse_gh_hosts_accounts(yaml: &str) -> (Vec<String>, Option<String>) {
    fn split_key(content: &str) -> (String, String) {
        let unquote = |s: &str| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
        match content.split_once(':') {
            Some((k, v)) => (unquote(k), unquote(v.split(" #").next().unwrap_or(""))),
            None => (unquote(content), String::new()),
        }
    }
    let mut accounts: Vec<String> = Vec::new();
    let mut active: Option<String> = None;
    let mut in_host = false;
    let mut key_indent: Option<usize> = None;
    let mut in_users = false;
    let mut user_indent: Option<usize> = None;
    for line in yaml.lines() {
        let content = line.trim();
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_host = split_key(content).0.eq_ignore_ascii_case("github.com");
            key_indent = None;
            in_users = false;
            continue;
        }
        if !in_host {
            continue;
        }
        let host_key_indent = *key_indent.get_or_insert(indent);
        if indent <= host_key_indent {
            let (key, value) = split_key(content);
            in_users = key == "users" && value.is_empty();
            user_indent = None;
            if key == "user" && !value.is_empty() {
                active = Some(value);
            }
        } else if in_users && indent == *user_indent.get_or_insert(indent) {
            let (login, _) = split_key(content);
            if !login.is_empty() && !accounts.iter().any(|a| a.eq_ignore_ascii_case(&login)) {
                accounts.push(login);
            }
        }
    }
    if accounts.is_empty() {
        if let Some(login) = &active {
            accounts.push(login.clone());
        }
    }
    (accounts, active)
}

/// gh's config directory (GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then ~/.config/gh).
#[cfg(not(target_os = "windows"))]
fn gh_config_dir(home: &str) -> String {
    if let Ok(dir) = std::env::var("GH_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return dir;
        }
    }
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if !dir.trim().is_empty() => format!("{}/gh", dir),
        _ => format!("{}/.config/gh", home),
    }
}

#[cfg(not(target_os = "windows"))]
fn gh_logged_in_accounts(home: &str) -> (Vec<String>, Option<String>) {
    std::fs::read_to_string(format!("{}/hosts.yml", gh_config_dir(home)))
        .map(|s| parse_gh_hosts_accounts(&s))
        .unwrap_or_default()
}

/// First account whose organization list contains `owner` (case-insensitive).
#[cfg(not(target_os = "windows"))]
fn account_for_org_owner(owner: &str, account_orgs: &[(String, Vec<String>)]) -> Option<String> {
    account_orgs
        .iter()
        .find(|(_, orgs)| orgs.iter().any(|o| o.eq_ignore_ascii_case(owner)))
        .map(|(login, _)| login.clone())
}

/// github-accounts.json with `owners[owner] = login` merged in, keeping every
/// other key. `None` when the existing file is not a JSON object (never clobber it).
#[cfg(not(target_os = "windows"))]
fn merge_owner_mapping(existing: Option<&str>, owner: &str, login: &str) -> Option<serde_json::Value> {
    let mut root = match existing.map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => serde_json::from_str::<serde_json::Value>(text).ok()?,
        None => serde_json::json!({}),
    };
    let root_obj = root.as_object_mut()?;
    let owners = root_obj
        .entry("owners")
        .or_insert_with(|| serde_json::json!({}));
    if !owners.is_object() {
        *owners = serde_json::json!({});
    }
    let owners = owners.as_object_mut()?;
    owners.retain(|k, _| !k.eq_ignore_ascii_case(owner));
    owners.insert(owner.to_string(), serde_json::Value::String(login.to_string()));
    Some(root)
}

#[cfg(not(target_os = "windows"))]
fn github_accounts_file(home: &str) -> String {
    format!("{}/.config/octo/github-accounts.json", home)
}

/// Remember a positively detected org owner so later tabs skip the network call.
/// Serialized in-process so concurrent lookups cannot drop each other's entries.
#[cfg(not(target_os = "windows"))]
fn cache_owner_mapping(home: &str, owner: &str, login: &str) {
    static WRITE_LOCK: Mutex<()> = Mutex::new(());
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = github_accounts_file(home);
    let existing = std::fs::read_to_string(&file).ok();
    let Some(merged) = merge_owner_mapping(existing.as_deref(), owner, login) else {
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(&merged) else {
        return;
    };
    let path = std::path::Path::new(&file);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = format!(
        "{}.tmp-{}-{}",
        file,
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    if std::fs::write(&tmp, format!("{}\n", text)).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Run a short git/gh helper with stdin closed and a hard timeout; trimmed
/// stdout on success. `token` is passed only through the child's environment.
#[cfg(not(target_os = "windows"))]
fn run_github_helper(
    program: &str,
    args: &[&str],
    work_dir: Option<&str>,
    path: Option<&str>,
    token: Option<&str>,
    timeout: std::time::Duration,
) -> Option<String> {
    let mut command = common::no_window_command(program);
    command.args(args);
    if let Some(dir) = work_dir {
        command.current_dir(dir);
    }
    if let Some(path) = path {
        command.env("PATH", path);
    }
    command.env_remove("GH_TOKEN").env_remove("GITHUB_TOKEN");
    if let Some(token) = token {
        command.env("GH_TOKEN", token);
    }
    command.env("GH_PROMPT_DISABLED", "1");
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

#[cfg(not(target_os = "windows"))]
fn gh_token_for(login: &str, path: Option<&str>) -> Option<String> {
    run_github_helper(
        "gh",
        &["auth", "token", "--hostname", "github.com", "--user", login],
        None,
        path,
        None,
        std::time::Duration::from_secs(2),
    )
}

/// Organizations of each account, fetched with that account's own token.
/// Successful lookups are memoized in-process for a few minutes (never on disk),
/// so a repo owned by nobody we know does not hit the network on every tab.
#[cfg(not(target_os = "windows"))]
fn gh_account_orgs(accounts: &[(String, String)], path: Option<&str>) -> Vec<(String, Vec<String>)> {
    type OrgCache = Mutex<HashMap<String, (std::time::Instant, Vec<String>)>>;
    static ORG_CACHE: OnceLock<OrgCache> = OnceLock::new();
    const TTL: std::time::Duration = std::time::Duration::from_secs(600);
    let cache = ORG_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    std::thread::scope(|scope| {
        let handles: Vec<_> = accounts
            .iter()
            .map(|(login, token)| {
                scope.spawn(move || {
                    if let Some((at, orgs)) = cache.lock().ok().and_then(|c| c.get(login).cloned()) {
                        if at.elapsed() < TTL {
                            return (login.clone(), orgs);
                        }
                    }
                    let fetched = run_github_helper(
                        "gh",
                        &["api", "user/orgs", "--paginate", "--jq", ".[].login"],
                        None,
                        path,
                        Some(token),
                        std::time::Duration::from_secs(6),
                    );
                    let orgs: Vec<String> = fetched
                        .as_deref()
                        .unwrap_or("")
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty())
                        .map(str::to_string)
                        .collect();
                    if fetched.is_some() {
                        if let Ok(mut c) = cache.lock() {
                            c.insert(login.clone(), (std::time::Instant::now(), orgs.clone()));
                        }
                    }
                    (login.clone(), orgs)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// State of the org-membership lookup for one remote owner (in-memory only).
#[cfg(not(target_os = "windows"))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum OrgLookup {
    InFlight(std::time::Instant),
    Miss(std::time::Instant),
}

/// Whether a background org lookup for an owner may start now: not while one
/// is running (unless it looks stuck), and not again within `ttl` of a miss.
#[cfg(not(target_os = "windows"))]
fn org_lookup_should_start(
    entry: Option<OrgLookup>,
    now: std::time::Instant,
    ttl: std::time::Duration,
) -> bool {
    const STUCK: std::time::Duration = std::time::Duration::from_secs(60);
    match entry {
        None => true,
        Some(OrgLookup::InFlight(at)) => now.saturating_duration_since(at) >= STUCK,
        Some(OrgLookup::Miss(at)) => now.saturating_duration_since(at) >= ttl,
    }
}

#[cfg(not(target_os = "windows"))]
const ORG_MISS_TTL: std::time::Duration = std::time::Duration::from_secs(600);

#[cfg(not(target_os = "windows"))]
fn org_lookups() -> &'static Mutex<HashMap<String, OrgLookup>> {
    static LOOKUPS: OnceLock<Mutex<HashMap<String, OrgLookup>>> = OnceLock::new();
    LOOKUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Network step of auto-detection: the logged-in account whose organizations
/// include `owner`. A hit is written to github-accounts.json; the outcome is
/// recorded in the in-memory lookup table (misses are never written to disk).
#[cfg(not(target_os = "windows"))]
fn detect_org_account(owner: &str, home: &str, path: Option<&str>) -> Option<(String, String)> {
    let key = owner.to_ascii_lowercase();
    let (logins, _) = gh_logged_in_accounts(home);
    let accounts: Vec<(String, String)> = logins
        .iter()
        .filter(|l| reject_option_like(l, "GitHub account").is_ok())
        .filter_map(|l| gh_token_for(l, path).map(|t| (l.clone(), t)))
        .collect();
    let found = if accounts.is_empty() {
        None
    } else {
        account_for_org_owner(owner, &gh_account_orgs(&accounts, path))
    };
    let result = found.and_then(|login| accounts.into_iter().find(|(l, _)| *l == login));
    if let Ok(mut lookups) = org_lookups().lock() {
        match &result {
            Some(_) => {
                lookups.remove(&key);
            }
            None => {
                lookups.insert(key, OrgLookup::Miss(std::time::Instant::now()));
            }
        }
    }
    if let Some((login, _)) = &result {
        cache_owner_mapping(home, owner, login);
    }
    result
}

/// Local (no network) part of auto-detection: the remote owner and, if the
/// owners mapping or the owner name itself names a logged-in gh account, that
/// (login, token). Owner is None for ssh:// or missing dirs, when
/// ~/.config/octo/.env sets GH_TOKEN, or when origin is not on github.com.
#[cfg(not(target_os = "windows"))]
fn resolve_github_login_local(
    work_dir: &str,
    home: &str,
    path: Option<&str>,
) -> (Option<String>, Option<(String, String)>) {
    if is_remote_ssh_path(work_dir) || !std::path::Path::new(work_dir).is_dir() {
        return (None, None);
    }
    if read_octo_env().contains_key("GH_TOKEN") {
        return (None, None);
    }
    let Some(owner) = run_github_helper(
        "git",
        &["remote", "get-url", "origin"],
        Some(work_dir),
        path,
        None,
        std::time::Duration::from_secs(2),
    )
    .as_deref()
    .and_then(github_remote_owner) else {
        return (None, None);
    };
    let mapping = std::fs::read_to_string(github_accounts_file(home))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let found = github_login_candidates(&owner, mapping.as_ref())
        .into_iter()
        .filter(|login| reject_option_like(login, "GitHub account").is_ok())
        .find_map(|login| gh_token_for(&login, path).map(|token| (login, token)));
    (Some(owner), found)
}

/// Full auto-detection for the project dialog (blocking; run off the main
/// thread): local resolution, then the org lookup unless it recently missed.
#[cfg(not(target_os = "windows"))]
fn resolve_github_login(work_dir: &str, home: &str, path: Option<&str>) -> Option<(String, String)> {
    let (owner, found) = resolve_github_login_local(work_dir, home, path);
    if found.is_some() {
        return found;
    }
    let owner = owner?;
    let recent_miss = org_lookups()
        .lock()
        .ok()
        .and_then(|l| l.get(&owner.to_ascii_lowercase()).copied())
        .is_some_and(|e| matches!(e, OrgLookup::Miss(at) if at.elapsed() < ORG_MISS_TTL));
    if recent_miss {
        return None;
    }
    detect_org_account(&owner, home, path)
}

/// Tab-spawn miss: look the owner up among the accounts' organizations in a
/// background thread so the PTY starts immediately; a hit is cached to disk
/// and picked up by the next tab.
#[cfg(not(target_os = "windows"))]
fn spawn_org_lookup(owner: String, home: String, path: Option<String>) {
    let key = owner.to_ascii_lowercase();
    {
        let Ok(mut lookups) = org_lookups().lock() else {
            return;
        };
        let now = std::time::Instant::now();
        if !org_lookup_should_start(lookups.get(&key).copied(), now, ORG_MISS_TTL) {
            return;
        }
        lookups.insert(key, OrgLookup::InFlight(now));
    }
    std::thread::spawn(move || {
        let _ = detect_org_account(&owner, &home, path.as_deref());
    });
}

/// Per-tab GitHub identity: env vars pinning gh/git in this PTY to one gh
/// account, so tabs for different accounts can run side by side without
/// `gh auth switch`. `choice` is the project's setting: None/"" = auto-detect
/// (local steps only; org detection runs in the background on a miss),
/// "__none__" = inject nothing (gh's active account), otherwise a gh login
/// (nothing is injected if gh has no token for it).
#[cfg(not(target_os = "windows"))]
fn github_account_env(
    work_dir: &str,
    home: &str,
    path: Option<&str>,
    choice: Option<&str>,
) -> Vec<(String, String)> {
    let choice = choice.map(str::trim).filter(|c| !c.is_empty());
    if choice == Some("__none__")
        || is_remote_ssh_path(work_dir)
        || !std::path::Path::new(work_dir).is_dir()
        || read_octo_env().contains_key("GH_TOKEN")
    {
        return Vec::new();
    }
    let resolved = match choice {
        Some(login) => {
            if reject_option_like(login, "GitHub account").is_err() {
                safe_eprintln!("[github] ignoring invalid project GitHub account {:?}", login);
                return Vec::new();
            }
            let token = gh_token_for(login, path);
            if token.is_none() {
                safe_eprintln!(
                    "[github] no gh token for project account {:?}; using gh's active account",
                    login
                );
            }
            token.map(|t| (login.to_string(), t))
        }
        None => {
            let (owner, found) = resolve_github_login_local(work_dir, home, path);
            if found.is_none() {
                if let Some(owner) = owner {
                    spawn_org_lookup(owner, home.to_string(), path.map(str::to_string));
                }
            }
            found
        }
    };
    match resolved {
        Some((login, token)) => vec![
            ("GH_TOKEN".to_string(), token),
            ("BBARIT_GITHUB_ACCOUNT".to_string(), login),
        ],
        None => Vec::new(),
    }
}

/// PATH for gh/git lookups from Tauri commands (GUI launches have a thin PATH).
#[cfg(not(target_os = "windows"))]
fn github_helper_path(home: &str) -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:{}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{}",
        home,
        std::env::var("PATH").unwrap_or_default()
    )
}

#[derive(Debug, Clone, Serialize)]
struct GithubAccountsInfo {
    accounts: Vec<String>,
    active: Option<String>,
}

/// gh accounts logged in on github.com (logins only, never tokens).
#[tauri::command]
fn list_github_accounts() -> GithubAccountsInfo {
    #[cfg(not(target_os = "windows"))]
    {
        let (accounts, active) = resolve_home_dir()
            .map(|home| gh_logged_in_accounts(&home))
            .unwrap_or_default();
        GithubAccountsInfo { accounts, active }
    }
    #[cfg(target_os = "windows")]
    {
        GithubAccountsInfo { accounts: Vec::new(), active: None }
    }
}

/// Login that auto-detection would pin for `work_dir` (None = gh active account).
/// The resolved token is dropped here and never leaves the backend.
#[tauri::command]
async fn detect_github_account(work_dir: String) -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let home = resolve_home_dir()?;
            let path = github_helper_path(&home);
            resolve_github_login(&work_dir, &home, Some(&path)).map(|(login, _token)| login)
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(target_os = "windows")]
    {
        let _ = work_dir;
        None
    }
}

// Create PTY and start shell. Runs on the async runtime (not the main thread)
// because it spawns git/gh helpers; it never awaits, so State use is unchanged.
#[tauri::command(async)]
fn create_shell(
    state: State<'_, AppState>,
    terminal_id: String,
    work_dir: String,
    rows: u16,
    cols: u16,
    shell_type: Option<String>,
    github_account: Option<String>,
) -> Result<(), String> {
    // shell_type is only consulted in the #[cfg(windows)] branches below;
    // keep the name (JS invoke arg `shellType`) and silence macOS unused warnings.
    #[cfg(not(target_os = "windows"))]
    let _ = &shell_type;
    // github_account (JS `githubAccount`) pins the per-tab gh identity on macOS/Linux.
    #[cfg(target_os = "windows")]
    let _ = &github_account;
    let pty_system = native_pty_system();

    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pty_pair.master.take_writer().map_err(|e| e.to_string())?;

    // Shell command setup
    #[cfg(target_os = "windows")]
    let is_ssh_pty = is_remote_ssh_path(&work_dir);

    // On Windows, an ssh:// work dir spawns `ssh` directly as the PTY (see
    // build_ssh_pty_command) instead of a local shell that would have to parse a
    // POSIX-quoted ssh command. macOS/Linux keep typing the command into zsh.
    #[cfg(target_os = "windows")]
    let effective_shell_type = if !is_ssh_pty
        && shell_type.as_deref() == Some("wsl")
        && !wsl_distribution_installed()
    {
        None
    } else {
        shell_type.as_deref()
    };

    #[cfg(target_os = "windows")]
    let mut cmd = if is_ssh_pty {
        build_ssh_pty_command(&work_dir)?
    } else {
        let shell_executable = match effective_shell_type {
            Some("cmd") => "cmd.exe",
            Some("gitbash") => "C:\\Program Files\\Git\\bin\\bash.exe",
            Some("wsl") => "wsl.exe",
            _ => "powershell.exe", // default
        };
        CommandBuilder::new(shell_executable)
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("/bin/zsh");

    #[cfg(not(target_os = "windows"))]
    cmd.arg("-l");

    let shell_work_dir = resolve_shell_work_dir(&work_dir);
    #[cfg(target_os = "windows")]
    configure_windows_pty_encoding(&mut cmd, effective_shell_type, is_ssh_pty);
    #[cfg(target_os = "windows")]
    if !is_ssh_pty && effective_shell_type == Some("wsl") {
        if let Some(wsl_dir) = windows_path_to_wsl_path(std::path::Path::new(&shell_work_dir)) {
            cmd.arg("--cd");
            cmd.arg(wsl_dir);
        }
    }
    cmd.cwd(&shell_work_dir);

    // Remove CLAUDECODE env to allow Claude Code sessions inside Octo Terminal
    cmd.env_remove("CLAUDECODE");
    // 색상 비활성 환경에서 앱이 실행돼도 CLI 색이 죽지 않도록 제거
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("COLOR");
    cmd.env_remove("FORCE_COLOR");

    // Disable interactive pagers/editors so commands the agent runs (git log/diff,
    // gh, etc.) never block waiting for input the broker can't dismiss. (Cline does
    // the same in StandaloneTerminalProcess.) Agents themselves use -m / their own
    // flow, so this only neutralises blocking child prompts.
    cmd.env("PAGER", "cat");
    cmd.env("GIT_PAGER", "cat");
    cmd.env("GH_PAGER", "cat");

    // ssh forwards TERM to the remote shell, so prefer a widely-supported value there.
    #[cfg(target_os = "windows")]
    cmd.env(
        "TERM",
        if is_ssh_pty || effective_shell_type == Some("wsl") {
            "xterm-256color"
        } else {
            "cygwin"
        },
    );

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "ko_KR.UTF-8");
        cmd.env("LC_ALL", "ko_KR.UTF-8");

        // Reliably get username and home directory in a GUI app
        // `id -un` works without environment variables
        let username = common::no_window_command("id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()));

        let home = format!("/Users/{}", username);

        cmd.env("HOME", &home);
        cmd.env("USER", &username);

        // Remove npm_config_prefix for nvm compatibility and set PATH directly
        cmd.env_remove("npm_config_prefix");

        // Auto-detect nvm node version
        let nvm_node_path = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .max() // use latest version
            })
            .map(|p| format!("{}/bin", p.display()))
            .unwrap_or_else(|| format!("{}/.nvm/versions/node/v20.19.6/bin", home));

        let path = format!(
            "{}:{}/.local/bin:{}/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            nvm_node_path, home, home
        );

        cmd.env("PATH", &path);
        cmd.env("SHELL", "/bin/zsh");
        cmd.env("NVM_DIR", format!("{}/.nvm", home));

        // Load API keys from ~/.config/octo/.env
        let env_path = format!("{}/.config/octo/.env", home);
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some(eq_pos) = line.find('=') {
                    let key = line[..eq_pos].trim();
                    let mut value = line[eq_pos + 1..].trim();
                    // strip quotes
                    if (value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\''))
                    {
                        value = &value[1..value.len() - 1];
                    }
                    cmd.env(key, value);
                }
            }
        }

        let github_env =
            github_account_env(&work_dir, &home, Some(&path), github_account.as_deref());
        if !github_env.is_empty() {
            // gh prefers GH_TOKEN, but drop a stale GITHUB_TOKEN so nothing else picks it up.
            cmd.env_remove("GITHUB_TOKEN");
        }
        for (key, value) in github_env {
            cmd.env(key, value);
        }
    }

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    // Thread to read output
    let (tx, rx) = mpsc::sync_channel::<String>(PTY_OUTPUT_QUEUE_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));
    let output_buffer = Arc::new(Mutex::new(String::new()));
    let last_output_at = Arc::new(Mutex::new(std::time::Instant::now()));

    spawn_utf8_reader_thread(
        reader,
        tx,
        Arc::clone(&alive),
        Some(Arc::clone(&output_buffer)),
        Some(Arc::clone(&last_output_at)),
    );

    let instance = PtyInstance {
        writer,
        output_rx: rx,
        master: pty_pair.master,
        child,
        alive,
        output_buffer,
        last_output_at,
    };

    state.ptys.lock().unwrap().insert(terminal_id, instance);

    Ok(())
}

// Write data to PTY
#[tauri::command]
fn write_to_pty(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    let mut ptys = state.ptys.lock().unwrap();
    if let Some(instance) = ptys.get_mut(&terminal_id) {
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        instance.writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("PTY not found".to_string())
    }
}

// Read data from PTY (non-blocking)
#[tauri::command]
fn read_from_pty(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<Option<String>, String> {
    let ptys = state.ptys.lock().unwrap();
    if let Some(instance) = ptys.get(&terminal_id) {
        // Non-blocking read from channel; drain as much as possible to reduce invocations/queue backlog.
        match instance.output_rx.try_recv() {
            Ok(first) => {
                let mut out = String::new();
                out.push_str(&first);

                while out.len() < PTY_READ_MAX_BYTES {
                    match instance.output_rx.try_recv() {
                        Ok(next) => out.push_str(&next),
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => break,
                    }
                }

                Ok(Some(out))
            }
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err("PTY disconnected".to_string()),
        }
    } else {
        Err("PTY not found".to_string())
    }
}

// Resize PTY
#[tauri::command]
fn resize_pty(
    state: State<'_, AppState>,
    terminal_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    if let Some(instance) = ptys.get(&terminal_id) {
        instance
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("PTY not found".to_string())
    }
}

// Reap an ENTIRE process subtree, not just the immediate PTY child. Agent CLIs (claude/codex/
// …) spawn long-running grandchildren — dev servers, wrangler, build watchers, broker verify
// servers — that otherwise ORPHAN and keep eating memory when a harness/terminal closes or the
// app exits (confirmed: stopped harnesses left node servers running). `taskkill /T` (Windows)
// and a process-group + parent sweep (Unix) take the whole tree down. Best-effort, never panics.
fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // `kill -- -pid` only reaps the group if `pid` is the group leader, and `pkill -P` only
        // catches DIRECT children — neither guarantees the whole subtree. So enumerate the entire
        // descendant tree via `pgrep -P` (BFS), then TERM everything, then KILL the stragglers.
        fn descendants(root: u32) -> Vec<u32> {
            let mut all: Vec<u32> = Vec::new();
            let mut stack = vec![root];
            let mut guard = 0;
            while let Some(p) = stack.pop() {
                guard += 1;
                if guard > 4096 {
                    break;
                }
                if let Ok(out) = std::process::Command::new("pgrep").args(["-P", &p.to_string()]).output() {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        if let Ok(child) = line.trim().parse::<u32>() {
                            if child != 0 && child != p {
                                all.push(child);
                                stack.push(child);
                            }
                        }
                    }
                }
            }
            all
        }
        let mut targets = descendants(pid);
        targets.push(pid);
        // Graceful TERM (process group if leader + every enumerated pid)...
        let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).output();
        for t in &targets {
            let _ = std::process::Command::new("kill").args(["-TERM", &t.to_string()]).output();
        }
        // ...then a forceful KILL sweep for anything that ignored TERM.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = std::process::Command::new("kill").args(["-KILL", &format!("-{pid}")]).output();
        for t in &targets {
            let _ = std::process::Command::new("kill").args(["-KILL", &t.to_string()]).output();
        }
    }
}

#[tauri::command]
fn close_pty(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    if let Some(mut instance) = state.ptys.lock().unwrap().remove(&terminal_id) {
        // Best-effort terminate the child process to prevent orphaned shells and memory leaks.
        // Do this on a background thread so the invoke call doesn't block the UI thread.
        let pid = instance.child.process_id();
        thread::spawn(move || {
            // Reap the whole subtree FIRST (grandchildren), then the immediate child.
            if let Some(pid) = pid {
                kill_process_tree(pid);
            }
            let _ = instance.child.kill();
            let _ = instance.child.wait();
        });
    }
    Ok(())
}

// Backward-compatible alias (older frontend calls `destroy_pty`)
#[tauri::command]
fn destroy_pty(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    close_pty(state, terminal_id)
}

// Resolve the executable the terminal should launch to run an internalized
// agent. The BBARIT agent is compiled INTO this app, so we return THIS app's own
// executable path — the frontend launches it with BBARIT_AGENT_MODE=1 so it runs
// the embedded agent TUI instead of the GUI. No separate agent binary exists.
#[tauri::command]
fn resolve_bundled_agent(name: String) -> Option<String> {
    if name != "bbarit" {
        return None;
    }
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

// Windows canonicalized paths carry the `\\?\` extended-length prefix — Tauri's
// resource_dir() canonicalizes, so the INSTALLED app produced `\\?\C:\...` here.
// Node.js cannot load a `\\?\` entry script (crashes with EISDIR lstat 'C:'),
// which broke the agent's `browser` tool in installed builds. Strip it back to
// a plain path before handing it to anything outside this process.
fn strip_extended_length_prefix(path: String) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path
    }
}

// Absolute path to the BBARIT Browser CLI (agent-browser-cli). The internalized
// agent's `browser` tool shells out to this so it drives our real-Chrome (CDP)
// browser instead of its own extension bridge. dev: repo layout relative to the
// exe (src-tauri/target/<profile>/octo-ui.exe). release bundling: TODO.
#[tauri::command]
fn resolve_browser_cli(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let rel = ["agent-browser-cli", "bin", "bbarit-browser-control.mjs"];
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    // 명시 env 우선 — 번들을 임시 경로(/tmp 등)에서 실행하면 exe 기준 탐색이
    // 빗나가 CLI를 못 찾고 에이전트가 확장 브릿지로 fallback한다(실측). 실행
    // 스크립트가 repo의 CLI 경로를 BBARIT_BROWSER_CLI로 넘기면 그걸 그대로 쓴다.
    if let Some(env_cli) = std::env::var_os("BBARIT_BROWSER_CLI") {
        candidates.push(std::path::PathBuf::from(env_cli));
    }
    // installed: bundled under the app's resource dir (see tauri.conf.json resources).
    // Tauri maps "../foo" resources under an "_up_" directory, preserving the rest
    // of the path — so the CLI lands at <resource>/_up_/agent-browser-cli/bin/...
    // and scripts/ sits beside it (which the CLI's own `../..` repoRoot relies on).
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            std::iter::once("_up_")
                .chain(rel.iter().copied())
                .fold(resource_dir.clone(), |p, s| p.join(s)),
        );
        candidates.push(rel.iter().fold(resource_dir, |p, s| p.join(s)));
    }
    if let Ok(exe) = std::env::current_exe() {
        // dev: exe is <repo>/src-tauri/target/<profile>/octo-ui.exe → 4 levels up = repo.
        if let Some(repo) = exe.ancestors().nth(4) {
            candidates.push(rel.iter().fold(repo.to_path_buf(), |p, s| p.join(s)));
        }
        // fallback: alongside the exe.
        if let Some(dir) = exe.parent() {
            candidates.push(rel.iter().fold(dir.to_path_buf(), |p, s| p.join(s)));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.exists())
        .map(|p| strip_extended_length_prefix(p.to_string_lossy().to_string()))
}

// mcp-bridge base port of THIS running app (dev 9323 / installed 9223). The agent
// gets this as TAURI_DEV_BASE_PORT so its browser CLI targets the app that
// launched it — matching the dev/installed split in the plugin config above.
#[tauri::command]
fn mcp_bridge_base_port() -> u16 {
    #[cfg(debug_assertions)]
    {
        9323
    }
    #[cfg(not(debug_assertions))]
    {
        9223
    }
}

/// Whether this process opens the tauri-plugin-mcp-bridge control WebSocket
/// (9223 release / 9323 debug). On by default: the vendored plugin refuses
/// browser-originated upgrades (see vendor/tauri-plugin-mcp-bridge
/// websocket.rs `upgrade_allowed`), so a web page cannot reach it.
/// `BBARIT_DISABLE_MCP_BRIDGE` turns it off in any build.
fn mcp_bridge_enabled() -> bool {
    std::env::var_os("BBARIT_DISABLE_MCP_BRIDGE").is_none()
}

fn personas_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors().skip(1).take(5) {
        for candidate in [
            ancestor.join("bbarit-agent").join("personas"),
            ancestor.join("_up_").join("bbarit-agent").join("personas"),
            ancestor
                .join("resources")
                .join("_up_")
                .join("bbarit-agent")
                .join("personas"),
        ] {
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

/// (name, emoji, description, body) — frontmatter 없으면 raw 전체가 body.
fn parse_persona_md(raw: &str) -> (String, String, String, String) {
    let (mut name, mut emoji, mut description) = (String::new(), String::new(), String::new());
    let mut body = raw.to_string();
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((k, v)) = line.split_once(':') {
                    match k.trim() {
                        "name" => name = v.trim().to_string(),
                        "emoji" => emoji = v.trim().to_string(),
                        "description" => description = v.trim().to_string(),
                        _ => {}
                    }
                }
            }
            body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
        }
    }
    (name, emoji, description, body)
}

/// List the persona library for terminal-level injection.
/// 메타데이터+문서 경로만 반환한다 — 297개 본문(~4MB)을 IPC로 넘기면 웹뷰가
/// 멈춘다. 주입은 md 경로를 알려주고 에이전트가 직접 읽게 한다
/// (빠릿 에이전트는 /persona <id>).
#[tauri::command]
fn agent_personas_list() -> Vec<serde_json::Value> {
    let Some(root) = personas_root() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(divisions) = std::fs::read_dir(&root) else {
        return out;
    };
    for division in divisions.flatten() {
        let dir = division.path();
        if !dir.is_dir() {
            continue;
        }
        let division_name = division.file_name().to_string_lossy().into_owned();
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            let (name, emoji, description, body) = parse_persona_md(&raw);
            if name.is_empty() || body.trim().is_empty() {
                continue;
            }
            // Deliberately NO `body` in the list payload: ~300 briefs are
            // several MB of JSON, which froze the picker UI on open. The
            // frontend injects the `path` as a "read this file" instruction,
            // or fetches one body on demand via `read_file`.
            out.push(serde_json::json!({
                "id": path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                "division": division_name,
                "name": name,
                "emoji": emoji,
                "description": description,
                "path": path.to_string_lossy(),
            }));
        }
    }
    // 개발(engineering) 그룹을 맨 위로, 나머지는 알파벳순.
    let rank = |d: &serde_json::Value| u8::from(d["division"].as_str() != Some("engineering"));
    out.sort_by(|a, b| {
        (rank(a), a["division"].as_str(), a["id"].as_str()).cmp(&(
            rank(b),
            b["division"].as_str(),
            b["id"].as_str(),
        ))
    });
    out
}

/// Run the embedded BBARIT agent once (print mode, no tools/session/extensions)
/// and return its final text. Powers the Model Roundtable's BBARIT Agent engine:
/// each participant is one `agent_oneshot` call with a per-participant model.
#[tauri::command]
async fn agent_oneshot(
    model: String,
    prompt: String,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    use tokio::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.env("BBARIT_AGENT_MODE", "1")
        .args([
            "-p",
            "--no-pick",
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let reference = model.trim();
    if let Some((provider, id)) = reference.split_once('/') {
        cmd.args(["--provider", provider, "--model", id]);
    } else if !reference.is_empty() {
        cmd.args(["--model", reference]);
    }
    cmd.arg(&prompt);
    let deadline = std::time::Duration::from_secs(timeout_secs.unwrap_or(180).clamp(10, 600));
    let output = tokio::time::timeout(deadline, cmd.output())
        .await
        .map_err(|_| format!("agent oneshot timed out after {}s", deadline.as_secs()))?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() && !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(stdout)
}

/// The embedded agent's model catalog + signed-in providers, fetched over a
/// short-lived RPC child (same data the harness settings drawer shows).
#[tauri::command]
async fn agent_models_list() -> Result<serde_json::Value, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::process::Command;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = Command::new(exe)
        .env("BBARIT_AGENT_MODE", "1")
        .args(["--mode", "rpc", "--no-pick"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin
        .write_all(b"{\"id\":1,\"type\":\"get_available_models\"}\n")
        .await
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = std::time::Duration::from_secs(15);
    let result = tokio::time::timeout(deadline, async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value["type"] == "response" && value["command"] == "get_available_models" {
                return Some(value["data"].clone());
            }
        }
        None
    })
    .await
    .map_err(|_| "agent models list timed out".to_string())?;
    let _ = child.kill().await;
    result.ok_or_else(|| "agent exited without a models response".to_string())
}

// ---- Agent RPC panel: run the embedded agent in JSON-RPC mode (no PTY) ----
// The Codex-style chat panel spawns THIS exe with BBARIT_AGENT_MODE=1 and
// `--mode rpc`, then talks newline-delimited JSON over stdin/stdout. Each
// stdout line is forwarded to the panel as an `agent-rpc-<panelId>` event.

struct AgentRpcProc {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    // First `{"type":"session",...}` line the child emitted, replayed on
    // panel remount so a reattaching hook unblocks without a fresh spawn.
    session_line: Option<String>,
    // Latest in-flight agent_start frame. Replayed after session on reattach so
    // a remounted UI cannot mistake a busy child for an idle one and bind the
    // previous turn's agent_end to a newly submitted job.
    active_run_line: Option<String>,
}

fn agent_rpc_procs() -> &'static std::sync::Mutex<std::collections::HashMap<String, AgentRpcProc>> {
    static PROCS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, AgentRpcProc>>,
    > = std::sync::OnceLock::new();
    PROCS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn agent_rpc_stop_inner(panel_id: &str) {
    if let Some(mut proc) = agent_rpc_procs().lock().unwrap().remove(panel_id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        drop(proc.stdin);
    }
}

// Reap EVERY RPC agent child (cowork/marketing/design panels) at app shutdown.
// Without this, quitting the app orphans `--mode rpc` children mid-turn and they
// keep burning CPU/tokens for up to MAX_AGENT_TOOL_TURNS (confirmed: orphaned
// RPC agents at 100% CPU after the parent app exited). Killing the whole
// process tree also reaps anything the agent itself spawned (bash jobs, node).
fn agent_rpc_stop_all() {
    let procs: Vec<(String, AgentRpcProc)> =
        agent_rpc_procs().lock().unwrap().drain().collect();
    for (panel_id, mut proc) in procs {
        safe_eprintln!("[agent-rpc] stopping '{panel_id}' at app shutdown");
        kill_process_tree(proc.child.id());
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        drop(proc.stdin);
    }
}

pub(crate) fn bbarit_language_prompt(language: Option<&str>) -> Option<&'static str> {
    match language.unwrap_or("ko").trim().to_ascii_lowercase().as_str() {
        "en" => Some("Response language policy: Always respond in English. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "ja" => Some("Response language policy: Always respond in Japanese. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "zh" => Some("Response language policy: Always respond in Chinese. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "fr" => Some("Response language policy: Always respond in French. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "de" => Some("Response language policy: Always respond in German. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "it" => Some("Response language policy: Always respond in Italian. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "es" => Some("Response language policy: Always respond in Spanish. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
        "auto" => None,
        _ => Some("Response language policy: Always respond in Korean. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them."),
    }
}

fn read_octo_config_json() -> Option<serde_json::Value> {
    let path = std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".config/octo/config.json"))?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()
}

/// Read the user's globally-configured response language from config.json.
/// Falls back to Korean when the file is missing or unset.
pub(crate) fn configured_language() -> String {
    read_octo_config_json()
        .and_then(|v| v.get("language").and_then(|l| l.as_str()).map(String::from))
        .unwrap_or_else(|| "ko".to_string())
}

/// The secretary gateway access password (config.gateway.password). When set
/// (non-empty), external chat clients must supply it in the `connect` frame in
/// addition to the token URL — so a leaked token URL alone can't reach the agent.
pub(crate) fn configured_gateway_password() -> Option<String> {
    read_octo_config_json()
        .and_then(|v| {
            v.get("gateway")
                .and_then(|g| g.get("password"))
                .and_then(|p| p.as_str())
                .map(str::trim)
                .map(String::from)
        })
        .filter(|p| !p.is_empty())
}

#[tauri::command]
fn agent_rpc_start(
    app: AppHandle,
    panel_id: String,
    work_dir: String,
    browser_label: Option<String>,
    bbarit_language: Option<String>,
) -> Result<(), String> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    // Panel remounts (tab switch, workspace close/open) must not kill a child
    // mid-turn — a fal video render runs for minutes. If the child is still
    // alive, reattach: replay the cached session frame so the fresh hook's
    // waitAlive() unblocks, and keep the process as-is.
    {
        let mut procs = agent_rpc_procs().lock().unwrap();
        if let Some(proc) = procs.get_mut(&panel_id) {
            if matches!(proc.child.try_wait(), Ok(None)) {
                if let Some(line) = proc.session_line.clone() {
                    let _ = app.emit(
                        &format!("agent-rpc-{panel_id}"),
                        serde_json::json!({ "kind": "line", "line": line }),
                    );
                }
                if let Some(line) = proc.active_run_line.clone() {
                    let _ = app.emit(
                        &format!("agent-rpc-{panel_id}"),
                        serde_json::json!({ "kind": "line", "line": line }),
                    );
                }
                return Ok(());
            }
            if let Some(mut dead) = procs.remove(&panel_id) {
                let _ = dead.child.wait();
            }
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    // --approve: 앱 패널에서 프로젝트를 열어 에이전트를 띄운 것 자체가 신뢰 결정이므로
    // trust 프롬프트 없이 바로 도구(browser/bash 등)를 쓸 수 있게 한다.
    cmd.env("BBARIT_AGENT_MODE", "1")
        .args(["--mode", "rpc", "--no-pick", "--approve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(prompt) = bbarit_language_prompt(bbarit_language.as_deref()) {
        cmd.args(["--append-system-prompt", prompt]);
    }
    if !work_dir.trim().is_empty() {
        cmd.current_dir(work_dir.trim());
    }
    // Same browser wiring the terminal launch does: the agent's `browser` tool
    // drives THIS app's BBARIT Browser.
    if let Some(cli) = resolve_browser_cli(app.clone()) {
        cmd.env("BBARIT_BROWSER_CLI", cli)
            .env("BBARIT_BRIDGE_ALLOW_RELEASE", "1")
            .env("TAURI_DEV_BASE_PORT", mcp_bridge_base_port().to_string());
        // 브라우저 창에서 스폰된 에이전트는 그 창을 직접 제어해야 한다. label을
        // 넘기지 않으면 CLI가 기본 'tool-browser-cli' 창을 따로 열어 사용자가 보는
        // 창과 무관한 별도 탭을 제어한다(=에이전트가 브라우저와 연동 안 됨).
        if let Some(label) = browser_label.filter(|l| !l.trim().is_empty()) {
            cmd.env("BBARIT_BROWSER_LABEL", label);
        }
    }
    // Editor bridge for the agent's `xlsx` tool — always THIS app's port, so
    // a dev-app agent never edits documents open in the installed app.
    cmd.env(
        "BBARIT_EDITOR_BRIDGE",
        format!("http://127.0.0.1:{}/editor", browser_bridge::BRIDGE_PORT),
    );
    // 설치본(.app)은 launchd의 최소 PATH(/usr/bin:/bin:/usr/sbin:/sbin)로 뜨므로
    // 에이전트가 직접 스폰하는 node(browser CLI·확장 훅)/LSP 등이 ENOENT로 죽는다.
    // PTY 스폰과 같은 방식으로 nvm·표준 설치 경로를 보강해 물려준다.
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let nvm_bin = std::fs::read_dir(format!("{home}/.nvm/versions/node"))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .max()
            })
            .map(|p| format!("{}/bin:", p.display()))
            .unwrap_or_default();
        let existing = std::env::var("PATH").unwrap_or_default();
        cmd.env(
            "PATH",
            format!(
                "{nvm_bin}{home}/.local/bin:{home}/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:{existing}"
            ),
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn agent rpc: {e}"))?;
    let stdin = child.stdin.take().ok_or("agent rpc: no stdin")?;
    let stdout = child.stdout.take().ok_or("agent rpc: no stdout")?;
    let stderr = child.stderr.take().ok_or("agent rpc: no stderr")?;
    let event = format!("agent-rpc-{panel_id}");
    // Register before the reader threads start so the session-frame capture
    // below never races a missing map entry.
    agent_rpc_procs().lock().unwrap().insert(
        panel_id.clone(),
        AgentRpcProc {
            child,
            stdin,
            session_line: None,
            active_run_line: None,
        },
    );
    {
        let app = app.clone();
        let event = event.clone();
        let panel_id = panel_id.clone();
        std::thread::spawn(move || {
            let mut session_seen = false;
            let mut reader = std::io::BufReader::new(stdout);
            let mut exit_reason = "stdout_eof".to_string();
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) => {
                        exit_reason = format!("stdout_read_error: {error}");
                        break;
                    }
                }
                let line = line.trim_end_matches(['\r', '\n']).to_string();
                if !session_seen && line.contains("\"type\":\"session\"") {
                    session_seen = true;
                    if let Some(proc) = agent_rpc_procs().lock().unwrap().get_mut(&panel_id) {
                        proc.session_line = Some(line.clone());
                    }
                }
                if let Ok(frame) = serde_json::from_str::<serde_json::Value>(&line) {
                    match frame.get("type").and_then(|value| value.as_str()) {
                        Some("agent_start") => {
                            if let Some(proc) = agent_rpc_procs().lock().unwrap().get_mut(&panel_id) {
                                proc.active_run_line = Some(line.clone());
                            }
                        }
                        Some("agent_end") => {
                            if let Some(proc) = agent_rpc_procs().lock().unwrap().get_mut(&panel_id) {
                                proc.active_run_line = None;
                            }
                        }
                        _ => {}
                    }
                }
                let _ = app.emit(&event, serde_json::json!({ "kind": "line", "line": line }));
            }
            let (code, success) = agent_rpc_procs()
                .lock()
                .unwrap()
                .remove(&panel_id)
                .and_then(|mut proc| {
                    let status = match proc.child.try_wait() {
                        Ok(Some(status)) => Some(status),
                        Ok(None) => {
                            let _ = proc.child.kill();
                            proc.child.wait().ok()
                        }
                        Err(_) => None,
                    };
                    status.map(|status| (status.code(), status.success()))
                })
                .unwrap_or((None, false));
            let _ = app.emit(
                &event,
                serde_json::json!({
                    "kind": "exit",
                    "reason": exit_reason,
                    "code": code,
                    "success": success,
                }),
            );
        });
    }
    {
        let app = app.clone();
        let event = event.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                let _ = app.emit(&event, serde_json::json!({ "kind": "stderr", "line": line }));
            }
        });
    }
    Ok(())
}

#[tauri::command]
fn agent_rpc_write(panel_id: String, line: String) -> Result<(), String> {
    use std::io::Write;
    let mut procs = agent_rpc_procs().lock().unwrap();
    let proc = procs
        .get_mut(&panel_id)
        .ok_or("agent rpc: not running (start the panel agent first)")?;
    let line = line.trim_end_matches(['\r', '\n']);
    writeln!(proc.stdin, "{line}").map_err(|e| e.to_string())?;
    proc.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn agent_rpc_status(panel_id: String) -> serde_json::Value {
    let mut procs = agent_rpc_procs().lock().unwrap();
    let Some(proc) = procs.get_mut(&panel_id) else {
        return serde_json::json!({ "alive": false, "running": false, "runId": null });
    };
    let alive = matches!(proc.child.try_wait(), Ok(None));
    let run_id = proc
        .active_run_line
        .as_deref()
        .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .and_then(|frame| frame.get("runId").cloned());
    serde_json::json!({
        "alive": alive,
        "running": alive && proc.active_run_line.is_some(),
        "runId": run_id,
    })
}

#[tauri::command]
fn agent_rpc_stop(panel_id: String) {
    agent_rpc_stop_inner(&panel_id);
}

// Create shell via CLI tool (Claude, Codex, etc.). Async runtime for the same
// reason as create_shell.
#[tauri::command(async)]
fn create_cli_shell(
    state: State<'_, AppState>,
    terminal_id: String,
    work_dir: String,
    cli_type: String,
    auto_accept: bool,
    prompt: Option<String>,
    rows: u16,
    cols: u16,
    shell_type: Option<String>,
    github_account: Option<String>,
) -> Result<(), String> {
    // shell_type is only consulted in the #[cfg(windows)] branches below;
    // keep the name (JS invoke arg `shellType`) and silence macOS unused warnings.
    #[cfg(not(target_os = "windows"))]
    let _ = &shell_type;
    // github_account (JS `githubAccount`) pins the per-tab gh identity on macOS/Linux.
    #[cfg(target_os = "windows")]
    let _ = &github_account;
    let pty_system = native_pty_system();

    let pty_pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pty_pair.master.take_writer().map_err(|e| e.to_string())?;

    // Build CLI command as shell command
    let cli_command = match cli_type.as_str() {
        "claude" => {
            let mut cmd_str = "claude".to_string();
            if auto_accept {
                cmd_str.push_str(" --dangerously-skip-permissions");
            }
            if let Some(p) = &prompt {
                cmd_str.push_str(&format!(" -p \"{}\"", p.replace("\"", "\\\"")));
            }
            Some(cmd_str)
        }
        "codex" => {
            // codex must run in a normal shell (None opens shell only)
            None
        }
        "cursor" => {
            let mut cmd_str = "cursor-agent".to_string();
            if auto_accept {
                cmd_str.push_str(" --force");
            }
            if let Some(p) = &prompt {
                cmd_str.push_str(&format!(" \"{}\"", p.replace("\"", "\\\"")));
            }
            Some(cmd_str)
        }
        "aider" => {
            let mut cmd_str = "aider".to_string();
            if auto_accept {
                cmd_str.push_str(" --yes");
            }
            Some(cmd_str)
        }
        "gemini" => None,
        "qwen" => {
            let mut cmd_str = "qwen".to_string();
            if auto_accept {
                cmd_str.push_str(" --approval-mode=yolo");
            }
            if let Some(p) = &prompt {
                cmd_str.push_str(&format!(" --prompt-interactive \"{}\"", p.replace("\"", "\\\"")));
            }
            Some(cmd_str)
        }
        "reasonix" => Some("reasonix code".to_string()),
        "octo" => {
            // start interactive mode via octo chat
            Some("octo chat".to_string())
        }
        _ => None,
    };

    // Always run via login shell (inherits PATH and other env vars)
    #[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
    #[cfg(target_os = "windows")]
    let effective_shell_type = if shell_type.as_deref() == Some("wsl") && !wsl_distribution_installed() {
        None
    } else {
        shell_type.as_deref()
    };

    #[cfg(target_os = "windows")]
    let shell_executable = match effective_shell_type {
        Some("cmd") => "cmd.exe",
        Some("gitbash") => "C:\\Program Files\\Git\\bin\\bash.exe",
        Some("wsl") => "wsl.exe",
        _ => "powershell.exe", // default
    };

    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new(shell_executable);

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("/bin/zsh");

    #[cfg(not(target_os = "windows"))]
    {
        cmd.arg("-l"); // login shell
        if let Some(cli_cmd) = cli_command {
            cmd.arg("-c");
            cmd.arg(cli_cmd);
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(cli_cmd) = cli_command.as_ref() {
        let flag = match effective_shell_type {
            Some("cmd") => "/c",
            Some("gitbash") | Some("wsl") => "-c",
            _ => "-Command",
        };
        cmd.arg(flag);
        cmd.arg(match effective_shell_type {
            Some("cmd") => format!("chcp 65001>nul && {}", cli_cmd),
            Some("gitbash") | Some("wsl") => cli_cmd.to_string(),
            _ => format!("[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false); chcp 65001 > $null; {}", cli_cmd),
        });
    }

    let shell_work_dir = resolve_shell_work_dir(&work_dir);
    cmd.cwd(&shell_work_dir);

    // Remove CLAUDECODE env to allow Claude Code sessions inside Octo Terminal
    cmd.env_remove("CLAUDECODE");
    // 색상 비활성 환경에서 앱이 실행돼도 CLI 색이 죽지 않도록 제거
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("COLOR");
    cmd.env_remove("FORCE_COLOR");

    // Disable interactive pagers/editors so commands the agent runs (git log/diff,
    // gh, etc.) never block waiting for input the broker can't dismiss. (Cline does
    // the same in StandaloneTerminalProcess.) Agents themselves use -m / their own
    // flow, so this only neutralises blocking child prompts.
    cmd.env("PAGER", "cat");
    cmd.env("GIT_PAGER", "cat");
    cmd.env("GH_PAGER", "cat");

    #[cfg(target_os = "windows")]
    if cli_command.is_none() {
        configure_windows_pty_encoding(&mut cmd, effective_shell_type, false);
    }

    #[cfg(target_os = "windows")]
    cmd.env("TERM", "cygwin");

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "ko_KR.UTF-8");
        cmd.env("LC_ALL", "ko_KR.UTF-8");

        // Reliably get username and home directory in a GUI app
        // `id -un` works without environment variables
        let username = common::no_window_command("id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()));

        let home = format!("/Users/{}", username);

        cmd.env("HOME", &home);
        cmd.env("USER", &username);

        // Remove npm_config_prefix for nvm compatibility and set PATH directly
        cmd.env_remove("npm_config_prefix");

        // Auto-detect nvm node version
        let nvm_node_path = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .max() // use latest version
            })
            .map(|p| format!("{}/bin", p.display()))
            .unwrap_or_else(|| format!("{}/.nvm/versions/node/v20.19.6/bin", home));

        let path = format!(
            "{}:{}/.local/bin:{}/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            nvm_node_path, home, home
        );
        cmd.env("PATH", &path);
        cmd.env("SHELL", "/bin/zsh");
        cmd.env("NVM_DIR", format!("{}/.nvm", home));

        // Load API keys from ~/.config/octo/.env
        let env_path = format!("{}/.config/octo/.env", home);
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if let Some(eq_pos) = line.find('=') {
                    let key = line[..eq_pos].trim();
                    let mut value = line[eq_pos + 1..].trim();
                    // strip quotes
                    if (value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\''))
                    {
                        value = &value[1..value.len() - 1];
                    }
                    cmd.env(key, value);
                }
            }
        }

        let github_env =
            github_account_env(&work_dir, &home, Some(&path), github_account.as_deref());
        if !github_env.is_empty() {
            // gh prefers GH_TOKEN, but drop a stale GITHUB_TOKEN so nothing else picks it up.
            cmd.env_remove("GITHUB_TOKEN");
        }
        for (key, value) in github_env {
            cmd.env(key, value);
        }
    }

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    // Thread to read output
    let (tx, rx) = mpsc::sync_channel::<String>(PTY_OUTPUT_QUEUE_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));
    let output_buffer = Arc::new(Mutex::new(String::new()));
    let last_output_at = Arc::new(Mutex::new(std::time::Instant::now()));

    spawn_utf8_reader_thread(
        reader,
        tx,
        Arc::clone(&alive),
        Some(Arc::clone(&output_buffer)),
        Some(Arc::clone(&last_output_at)),
    );

    let instance = PtyInstance {
        writer,
        output_rx: rx,
        master: pty_pair.master,
        child,
        alive,
        output_buffer,
        last_output_at,
    };

    state.ptys.lock().unwrap().insert(terminal_id, instance);

    Ok(())
}

// Search files by name and/or content
#[tauri::command]
fn search_files(
    root: String,
    query: String,
    search_content: bool,
    limit: Option<usize>,
) -> Result<Vec<fs_ops::SearchResult>, String> {
    fs_ops::search_files(root, query, search_content, limit)
}

#[tauri::command]
async fn code_search(
    root: String,
    query: String,
    limit: Option<usize>,
    mode: Option<String>,
    include_text_files: Option<bool>,
) -> Result<Vec<code_search::CodeSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        code_search::search(root, query, limit, mode, include_text_files)
    })
    .await
    .map_err(|e| format!("Failed to join code search task: {e}"))?
}

#[tauri::command]
async fn code_find_related(
    root: String,
    file_path: String,
    line: usize,
    limit: Option<usize>,
    include_text_files: Option<bool>,
) -> Result<Vec<code_search::CodeSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        code_search::find_related(root, file_path, line, limit, include_text_files)
    })
    .await
    .map_err(|e| format!("Failed to join related search task: {e}"))?
}

#[tauri::command]
async fn code_search_stats(
    root: String,
    include_text_files: Option<bool>,
) -> Result<code_search::CodeSearchStats, String> {
    tauri::async_runtime::spawn_blocking(move || code_search::stats(root, include_text_files))
        .await
        .map_err(|e| format!("Failed to join code search stats task: {e}"))?
}

#[tauri::command]
fn code_search_savings() -> Result<code_search::CodeSearchSavings, String> {
    code_search::savings()
}

#[tauri::command]
fn code_search_clear_cache(root: Option<String>) -> Result<(), String> {
    code_search::clear_cache(root)
}

// Walk a DependencyGraph from given entry files and emit an ASCII tree.
fn render_dep_tree_lines(
    graph: &semble::graph::DependencyGraph,
    entries: &[String],
    max_depth: usize,
    max_lines: usize,
) -> String {
    use std::collections::HashSet;

    let mut out = String::new();
    let mut lines_emitted = 0usize;

    fn walk(
        graph: &semble::graph::DependencyGraph,
        path: &str,
        prefix: &str,
        depth: usize,
        max_depth: usize,
        max_lines: usize,
        lines_emitted: &mut usize,
        visited: &mut HashSet<String>,
        out: &mut String,
    ) {
        if *lines_emitted >= max_lines {
            return;
        }
        if depth >= max_depth {
            return;
        }
        let deps = match graph.deps(path) {
            Some(node) => &node.depends_on,
            None => return,
        };
        let mut sorted_deps = deps.clone();
        sorted_deps.sort();
        let total = sorted_deps.len();
        for (i, dep) in sorted_deps.iter().enumerate() {
            if *lines_emitted >= max_lines {
                break;
            }
            let last = i + 1 == total;
            let connector = if last { "└── " } else { "├── " };
            let cycle = visited.contains(dep);
            let marker = if cycle { " ↺" } else { "" };
            out.push_str(&format!("{prefix}{connector}{dep}{marker}\n"));
            *lines_emitted += 1;
            if !cycle {
                visited.insert(dep.clone());
                let ext = if last { "    " } else { "│   " };
                walk(
                    graph,
                    dep,
                    &format!("{prefix}{ext}"),
                    depth + 1,
                    max_depth,
                    max_lines,
                    lines_emitted,
                    visited,
                    out,
                );
                visited.remove(dep);
            }
        }
    }

    for entry in entries {
        if lines_emitted >= max_lines {
            break;
        }
        out.push_str(entry);
        out.push('\n');
        lines_emitted += 1;
        let mut visited = HashSet::new();
        visited.insert(entry.clone());
        walk(
            graph,
            entry,
            "",
            0,
            max_depth,
            max_lines,
            &mut lines_emitted,
            &mut visited,
            &mut out,
        );
        out.push('\n');
    }

    if lines_emitted >= max_lines {
        out.push_str(&format!("… (truncated at {max_lines} lines)\n"));
    }
    out
}

#[tauri::command]
async fn semble_dependency_tree(
    root: String,
    max_depth: Option<usize>,
    max_entries: Option<usize>,
    max_lines: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        use crate::semble::file_walker::{filter_extensions, language_for_path, walk_files};
        use crate::semble::graph::DependencyGraph;
        use std::path::Path;

        const MAX_FILE_BYTES: u64 = 1_000_000;
        let depth_limit = max_depth.unwrap_or(5);
        let entry_limit = max_entries.unwrap_or(8);
        let line_limit = max_lines.unwrap_or(400);

        let root_path = Path::new(&root);
        if !root_path.is_dir() {
            return Err(format!("Not a directory: {root}"));
        }
        let exts = filter_extensions(None, false);
        let files = walk_files(root_path, &exts, None);

        let mut graph = DependencyGraph::new();
        for file_path in &files {
            let metadata = match file_path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let source = match std::fs::read_to_string(file_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if source.is_empty() {
                continue;
            }
            let display_path = file_path
                .strip_prefix(root_path)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();
            if let Some(lang) = language_for_path(file_path) {
                graph.add_file(&display_path, &source, lang);
            }
        }
        graph.resolve_dependencies();

        // Entries: no dependents but have outgoing deps, ranked by deps count desc.
        let mut entries: Vec<(String, usize)> = graph
            .all_files()
            .into_iter()
            .filter_map(|p| {
                let deps_count = graph.deps(&p).map(|n| n.depends_on.len()).unwrap_or(0);
                if deps_count == 0 {
                    return None;
                }
                if !graph.dependents(&p).is_empty() {
                    return None;
                }
                Some((p, deps_count))
            })
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        let chosen_entries: Vec<String> = entries
            .into_iter()
            .take(entry_limit)
            .map(|(p, _)| p)
            .collect();

        if chosen_entries.is_empty() {
            return Ok(format!(
                "{}: no entry points found ({} files in graph)\n",
                root,
                graph.file_count()
            ));
        }

        Ok(render_dep_tree_lines(
            &graph,
            &chosen_entries,
            depth_limit,
            line_limit,
        ))
    })
    .await
    .map_err(|e| format!("Failed to join semble task: {e}"))?
}

// ── semble (Tree-sitter dependency graph for the AI "프로젝트 구조 설명" button) ──
#[derive(serde::Serialize)]
struct SembleHubFile {
    path: String,
    dependents: usize,
    deps: usize,
}

#[derive(serde::Serialize)]
struct SembleProjectOverviewReport {
    root: String,
    file_count: usize,
    edge_count: usize,
    languages: Vec<(String, usize)>,
    top_hubs: Vec<SembleHubFile>,
    entry_candidates: Vec<String>,
    orphan_count: usize,
}

#[tauri::command]
async fn semble_project_overview(root: String) -> Result<SembleProjectOverviewReport, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SembleProjectOverviewReport, String> {
        use crate::semble::file_walker::{filter_extensions, language_for_path, walk_files};
        use crate::semble::graph::DependencyGraph;
        use std::collections::HashMap;
        use std::path::Path;

        const MAX_FILE_BYTES: u64 = 1_000_000;

        let root_path = Path::new(&root);
        if !root_path.is_dir() {
            return Err(format!("Not a directory: {root}"));
        }
        let exts = filter_extensions(None, false);
        let files = walk_files(root_path, &exts, None);

        let mut graph = DependencyGraph::new();
        let mut lang_counts: HashMap<String, usize> = HashMap::new();
        for file_path in &files {
            let metadata = match file_path.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            let source = match std::fs::read_to_string(file_path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if source.is_empty() {
                continue;
            }
            let display_path = file_path
                .strip_prefix(root_path)
                .unwrap_or(file_path)
                .to_string_lossy()
                .to_string();
            if let Some(lang) = language_for_path(file_path) {
                *lang_counts.entry(lang.to_string()).or_insert(0) += 1;
                graph.add_file(&display_path, &source, lang);
            }
        }
        graph.resolve_dependencies();

        let mut languages: Vec<(String, usize)> = lang_counts.into_iter().collect();
        languages.sort_by(|a, b| b.1.cmp(&a.1));

        let all_files = graph.all_files();
        let mut hubs: Vec<SembleHubFile> = all_files
            .iter()
            .map(|p| {
                let deps_count = graph.deps(p).map(|n| n.depends_on.len()).unwrap_or(0);
                let dependents = graph.dependents(p).len();
                SembleHubFile {
                    path: p.clone(),
                    dependents,
                    deps: deps_count,
                }
            })
            .filter(|h| h.dependents > 0 || h.deps > 0)
            .collect();
        hubs.sort_by(|a, b| b.dependents.cmp(&a.dependents));
        let top_hubs: Vec<SembleHubFile> = hubs.into_iter().take(15).collect();

        let entry_candidates: Vec<String> = all_files
            .iter()
            .filter(|p| {
                graph.dependents(p).is_empty()
                    && graph
                        .deps(p)
                        .map(|n| !n.depends_on.is_empty())
                        .unwrap_or(false)
            })
            .take(10)
            .cloned()
            .collect();

        let orphan_count = graph.orphans().len();
        let file_count = graph.file_count();
        let edge_count = graph.edge_count();

        Ok(SembleProjectOverviewReport {
            root,
            file_count,
            edge_count,
            languages,
            top_hubs,
            entry_candidates,
            orphan_count,
        })
    })
    .await
    .map_err(|e| format!("Failed to join semble task: {e}"))?
}

// Build a name-only file index for quick open
#[tauri::command]
async fn list_project_files(
    root: String,
    limit: Option<usize>,
) -> Result<Vec<fs_ops::SearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || fs_ops::list_project_files(root, limit))
        .await
        .map_err(|e| format!("Failed to join file index task: {e}"))?
}

/// 프로젝트 workDir 등 로컬 경로 존재 확인 (폴더가 외부에서 삭제된 경우 대비).
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// Read directory
#[tauri::command]
async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        safe_eprintln!(
            "[ssh-read-directory] input={} remote={}",
            path,
            spec.remote_path
        );
        let cmd = format!("cd -- {} && LC_ALL=C ls -1Ap", sh_quote(&spec.remote_path));
        let stdout = run_ssh_command_async(&spec, &cmd).await?;
        let text = String::from_utf8_lossy(&stdout);
        let mut result = Vec::new();
        for raw_line in text.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line == "." || line == ".." {
                continue;
            }
            let is_dir = line.ends_with('/');
            let name = if is_dir {
                line.trim_end_matches('/').to_string()
            } else {
                line.to_string()
            };
            // No exclusions — show all folders including node_modules, target, .git
            let remote_child_path = ssh_join_path(&spec.remote_path, &name);
            result.push(FileEntry {
                name,
                path: ssh_virtual_path(&spec, &remote_child_path),
                is_dir,
                size_bytes: None,
            });
        }
        result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        return Ok(result);
    }

    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // No exclusions — show all folders/files

        let file_path = entry.path();
        let size_bytes = if file_path.is_dir() {
            None
        } else {
            entry.metadata().ok().map(|meta| meta.len())
        };
        result.push(FileEntry {
            name: file_name,
            path: file_path.to_string_lossy().to_string(),
            is_dir: file_path.is_dir(),
            size_bytes,
        });
    }

    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
}

#[tauri::command]
async fn get_file_metadata(path: String) -> Result<crate::common::FileMetadata, String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; \
             if [ -d \"$p\" ]; then printf 'dir\\n'; \
             elif [ -f \"$p\" ]; then printf 'file\\n'; wc -c < \"$p\" 2>/dev/null | tr -d '[:space:]'; printf '\\n'; \
             else exit 2; fi",
            p = sh_quote(&spec.remote_path),
        );
        let stdout = run_ssh_command_async(&spec, &cmd).await?;
        let text = String::from_utf8_lossy(&stdout);
        let mut lines = text.lines();
        let kind = lines.next().unwrap_or("").trim();
        let is_dir = kind == "dir";
        let size_bytes = if is_dir {
            None
        } else {
            lines
                .next()
                .and_then(|line| line.trim().parse::<u64>().ok())
        };
        return Ok(crate::common::FileMetadata {
            path,
            is_dir,
            size_bytes,
        });
    }

    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let is_dir = meta.is_dir();
    Ok(crate::common::FileMetadata {
        path,
        is_dir,
        size_bytes: if is_dir { None } else { Some(meta.len()) },
    })
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; \
             if [ ! -f \"$p\" ]; then echo \"File does not exist\" >&2; exit 2; fi; \
             size=$(wc -c < \"$p\" 2>/dev/null || echo 0); \
             if [ \"$size\" -gt {limit} ]; then echo \"File too large ($size bytes)\" >&2; exit 3; fi; \
             cat -- \"$p\"",
            p = sh_quote(&spec.remote_path),
            limit = FILE_SIZE_LIMIT,
        );
        let stdout = run_ssh_command(&spec, &cmd)?;
        return Ok(crate::fs_ops::strip_utf8_bom(
            String::from_utf8_lossy(&stdout).to_string(),
        ));
    }

    // Guard against loading huge files into memory (e.g. binary blobs, logs).
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > FILE_SIZE_LIMIT {
            return Err(format!(
                "File too large ({:.1} MB). Maximum is {} MB.",
                meta.len() as f64 / (1024.0 * 1024.0),
                FILE_SIZE_LIMIT / (1024 * 1024)
            ));
        }
    }
    std::fs::read_to_string(&path)
        .map(crate::fs_ops::strip_utf8_bom)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    // Offload the (up to 30MB) read + base64 encode off the main thread so the
    // synchronous work never stalls the app event loop.
    tokio::task::spawn_blocking(move || read_file_base64_inner(path))
        .await
        .map_err(|e| e.to_string())?
}

fn read_file_base64_inner(path: String) -> Result<String, String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; \
             if [ ! -f \"$p\" ]; then echo \"File does not exist\" >&2; exit 2; fi; \
             size=$(wc -c < \"$p\" 2>/dev/null || echo 0); \
             if [ \"$size\" -gt {limit} ]; then echo \"File too large ($size bytes)\" >&2; exit 3; fi; \
             if command -v base64 >/dev/null 2>&1; then base64 < \"$p\" | tr -d '\\n'; \
             elif command -v openssl >/dev/null 2>&1; then openssl base64 -A -in \"$p\"; \
             else echo \"base64 command not available\" >&2; exit 4; fi",
            p = sh_quote(&spec.remote_path),
            limit = FILE_SIZE_LIMIT,
        );
        let stdout = run_ssh_command(&spec, &cmd)?;
        return Ok(String::from_utf8_lossy(&stdout).trim().to_string());
    }

    // Guard against loading huge files into memory — use higher limit for read-only.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > READ_FILE_SIZE_LIMIT {
            return Err(format!(
                "File too large ({:.1} MB). Maximum is {} MB.",
                meta.len() as f64 / (1024.0 * 1024.0),
                READ_FILE_SIZE_LIMIT / (1024 * 1024)
            ));
        }
    }

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// Atomic write: write to a temp file in the same directory, fsync, then rename.
// rename is atomic within a filesystem, so a crash/power loss/disk-full mid-write
// can never leave a truncated original — critical for Office (OOXML zip) files
// which become entirely unreadable if truncated.
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    let tmp_path = dir.join(format!(
        ".{}.tmp-{}-{}",
        file_name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let write_result: std::io::Result<()> = (|| {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    // fsync the parent directory so the rename itself survives a power loss —
    // the file bytes are already durable via sync_all above. Unix-only: you
    // can't open a directory as a File on Windows (NTFS journals the rename).
    #[cfg(unix)]
    if let Ok(dir_file) = std::fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        if content.len() as u64 > FILE_SIZE_LIMIT {
            return Err(format!(
                "Content too large ({:.1} MB). Maximum is {} MB.",
                content.len() as f64 / (1024.0 * 1024.0),
                FILE_SIZE_LIMIT / (1024 * 1024)
            ));
        }
        let cmd = format!(
            "p={p}; d=$(dirname -- \"$p\"); mkdir -p -- \"$d\" && cat > \"$p\"",
            p = sh_quote(&spec.remote_path),
        );
        run_ssh_command_with_stdin(&spec, &cmd, content.as_bytes())?;
        return Ok(());
    }

    // Guard against accidentally writing huge blobs via the editor.
    if content.len() as u64 > FILE_SIZE_LIMIT {
        return Err(format!(
            "Content too large ({:.1} MB). Maximum is {} MB.",
            content.len() as f64 / (1024.0 * 1024.0),
            FILE_SIZE_LIMIT / (1024 * 1024)
        ));
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        // Some files (like ~/.config/octo/.env) may not exist yet on a fresh install.
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(p, &crate::fs_ops::encode_text_file_content(p, &content))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file_base64(path: String, base64_data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Base64 decode error: {e}"))?;
    if bytes.len() as u64 > READ_FILE_SIZE_LIMIT {
        return Err(format!(
            "Data too large ({:.1} MB). Maximum is {} MB.",
            bytes.len() as f64 / (1024.0 * 1024.0),
            READ_FILE_SIZE_LIMIT / (1024 * 1024)
        ));
    }
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; d=$(dirname -- \"$p\"); mkdir -p -- \"$d\" && cat > \"$p\"",
            p = sh_quote(&spec.remote_path),
        );
        run_ssh_command_with_stdin(&spec, &cmd, &bytes)?;
        return Ok(());
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    atomic_write(p, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_file_dialog(
    app: AppHandle,
    default_name: String,
    filters: Vec<(String, Vec<String>)>,
) -> Result<Option<String>, String> {
    use std::sync::mpsc as std_mpsc;
    let (tx, rx) = std_mpsc::channel();

    let mut builder = app
        .dialog()
        .file()
        .set_title("Save As")
        .set_file_name(&default_name);
    for (name, exts) in &filters {
        let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(name, &ext_refs);
    }
    builder.save_file(move |file| {
        let _ = tx.send(file.map(|p| p.to_string()));
    });

    rx.recv()
        .map_err(|e| e.to_string())?
        .map(Some)
        .ok_or_else(|| "Cancelled".to_string())
        .or(Ok(None))
}

#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!("mkdir -p -- {}", sh_quote(&spec.remote_path));
        run_ssh_command(&spec, &cmd)?;
        return Ok(());
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_empty_file(path: String) -> Result<(), String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; \
             if [ -e \"$p\" ]; then echo \"File already exists\" >&2; exit 2; fi; \
             d=$(dirname -- \"$p\"); mkdir -p -- \"$d\" && : > \"$p\"",
            p = sh_quote(&spec.remote_path)
        );
        run_ssh_command(&spec, &cmd)?;
        return Ok(());
    }

    use std::path::Path;

    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if p.exists() {
        return Err("File already exists".to_string());
    }

    std::fs::File::create(p)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    if let Some(spec) = parse_ssh_path(&path)? {
        let cmd = format!(
            "p={p}; \
             if [ ! -e \"$p\" ]; then echo \"Path does not exist\" >&2; exit 2; fi; \
             rm -rf -- \"$p\"",
            p = sh_quote(&spec.remote_path)
        );
        run_ssh_command(&spec, &cmd)?;
        return Ok(());
    }

    use std::path::Path;

    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }

    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    let from_ssh = parse_ssh_path(&from)?;
    let to_ssh = parse_ssh_path(&to)?;
    if from_ssh.is_some() || to_ssh.is_some() {
        let from_spec =
            from_ssh.ok_or_else(|| "Cannot rename between local and SSH paths".to_string())?;
        let to_spec =
            to_ssh.ok_or_else(|| "Cannot rename between local and SSH paths".to_string())?;
        if from_spec.username != to_spec.username
            || from_spec.host != to_spec.host
            || from_spec.port != to_spec.port
            || from_spec.identity_file != to_spec.identity_file
        {
            return Err("Cannot rename across different SSH hosts".to_string());
        }
        let cmd = format!(
            "from={from}; to={to}; \
             if [ ! -e \"$from\" ]; then echo \"Source path does not exist\" >&2; exit 2; fi; \
             if [ -e \"$to\" ]; then echo \"Destination already exists\" >&2; exit 3; fi; \
             mkdir -p -- \"$(dirname -- \"$to\")\" && mv -- \"$from\" \"$to\"",
            from = sh_quote(&from_spec.remote_path),
            to = sh_quote(&to_spec.remote_path),
        );
        run_ssh_command(&from_spec, &cmd)?;
        return Ok(());
    }

    use std::path::Path;

    let from_p = Path::new(&from);
    if !from_p.exists() {
        return Err("Source path does not exist".to_string());
    }

    let to_p = Path::new(&to);
    if to_p.exists() {
        return Err("Destination already exists".to_string());
    }

    if let Some(parent) = to_p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    match std::fs::rename(from_p, to_p) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            // Cross-device link: copy then delete
            if from_p.is_dir() {
                cross_device_copy_dir(from_p, to_p)?;
            } else {
                std::fs::copy(from_p, to_p).map_err(|e| e.to_string())?;
            }
            if from_p.is_dir() {
                std::fs::remove_dir_all(from_p).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(from_p).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct SshConnectInput {
    host: String,
    port: u16,
    username: String,
    identity_file: Option<String>,
    base_path: String,
}

/// Fix SSH key permissions and return the usable path.
/// If the key is on a volume that doesn't support chmod (FAT32/exFAT),
/// copies it to ~/.config/octo/ssh_keys/ with mode 600.
#[tauri::command]
fn ssh_fix_key_permissions(key_path: String) -> Result<String, String> {
    ensure_ssh_key_permissions(&key_path)
}

#[tauri::command]
fn ssh_validate_base(input: SshConnectInput) -> Result<String, String> {
    let host = input.host.trim();
    let username = input.username.trim();
    let base_path = input.base_path.trim();
    if host.is_empty() || username.is_empty() {
        return Err("host, username은 필수입니다.".to_string());
    }
    let requested_base = if base_path.is_empty() { "~" } else { base_path };
    let spec = SshPathSpec {
        username: username.to_string(),
        host: host.to_string(),
        port: if input.port == 0 { 22 } else { input.port },
        identity_file: input.identity_file.and_then(|v| {
            let t = v.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }),
        meta: format!(
            "{}@{}:{}",
            username,
            host,
            if input.port == 0 { 22 } else { input.port }
        ),
        // Not used by ssh_validate_base itself.
        remote_path: "/".to_string(),
    };
    let cmd = format!(
        "raw={raw}; \
         home=\"\"; \
         if command -v getent >/dev/null 2>&1; then \
           home=$(getent passwd \"$USER\" | awk -F: '{{print $6}}' | head -n 1); \
         fi; \
         if [ -z \"$home\" ] || [ ! -d \"$home\" ]; then home=\"$HOME\"; fi; \
         if [ -z \"$home\" ] || [ ! -d \"$home\" ]; then home=$(cd ~ 2>/dev/null && pwd); fi; \
         if [ -z \"$home\" ] || [ ! -d \"$home\" ]; then home=$(pwd); fi; \
         case \"$raw\" in \
           \"\"|\"~\") p=\"$home\" ;; \
           \"~/\"*) p=\"$home/${{raw#~/}}\" ;; \
           /*) p=\"$raw\" ;; \
           .) p=\"$home\" ;; \
           ./*) p=\"$home/${{raw#./}}\" ;; \
           *) p=\"$home/$raw\" ;; \
         esac; \
         if [ ! -d \"$p\" ]; then echo \"Base path is not a directory: $p\" >&2; exit 2; fi; \
         cd -- \"$p\" && pwd -P",
        raw = sh_quote(requested_base),
    );
    let out = run_ssh_command(&spec, &cmd)?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn cross_device_copy_dir(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            cross_device_copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn copy_path(from: String, to: String) -> Result<(), String> {
    use std::path::Path;

    let from_p = Path::new(&from);
    if !from_p.exists() {
        return Err("Source path does not exist".to_string());
    }

    // Auto-rename if destination already exists: file.txt -> file (2).txt, dir -> dir (2)
    let mut dest = std::path::PathBuf::from(&to);
    if dest.exists() {
        let parent = dest.parent().unwrap_or(Path::new("/"));
        let stem = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let ext = dest
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s))
            .unwrap_or_default();
        for i in 2..100 {
            let candidate = if from_p.is_dir() {
                parent.join(format!("{} ({})", stem, i))
            } else {
                parent.join(format!("{} ({}){}", stem, i, ext))
            };
            if !candidate.exists() {
                dest = candidate;
                break;
            }
        }
        if dest.exists() {
            return Err("Could not find available name".to_string());
        }
    }

    if from_p.is_dir() {
        copy_dir_recursive(from_p, &dest).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(from_p, &dest)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// List monospace/coding-friendly system fonts for the font picker.
#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();
    let families = source
        .all_families()
        .map_err(|e| format!("Failed to enumerate fonts: {e}"))?;
    let mut names: Vec<String> = families
        .into_iter()
        .filter(|name| !name.starts_with('.')) // skip hidden/system fonts
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup();
    Ok(names)
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

// Ship the bundled SEO/GEO skills to EVERY user: on startup, copy them from the app's bundled
// resources into the user's ~/.claude/skills so the in-app coding agents (Claude/Codex/…) can use
// them on any installed copy — not just the dev machine. Idempotent: a skill that already exists
// is left untouched so the user's own edits/customizations are never clobbered.
fn install_bundled_skills(app: &AppHandle) {
    let src = match app
        .path()
        .resolve("resources/claude-skills", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) => p,
        Err(_) => return,
    };
    if !src.exists() {
        return;
    }
    let home = match app.path().home_dir() {
        Ok(h) => h,
        Err(_) => return,
    };
    let dest_root = home.join(".claude").join("skills");
    if std::fs::create_dir_all(&dest_root).is_err() {
        return;
    }
    let entries = match std::fs::read_dir(&src) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut installed = 0u32;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let target = dest_root.join(entry.file_name());
        if target.exists() {
            continue;
        }
        if copy_dir_all(&entry.path(), &target).is_ok() {
            installed += 1;
        }
    }
    if installed > 0 {
        safe_eprintln!("[skills] installed {} bundled SEO/GEO skills into ~/.claude/skills", installed);
    }
}

#[tauri::command]
fn get_home_dir(app: AppHandle) -> Result<String, String> {
    if let Ok(path) = app.path().home_dir() {
        if let Some(home) = path.to_str() {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }

    resolve_home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

// ── Config file commands ──────────────────────────────────────────

/// Returns the path to ~/.config/octo/config.json, creating parent dirs if needed.
fn config_file_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| format!("Cannot determine home dir: {e}"))?;
    let dir = std::path::Path::new(&home).join(".config").join("octo");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn get_config_path() -> Result<String, String> {
    config_file_path().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_config() -> Result<String, String> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))
}

#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    let path = config_file_path()?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| format!("Failed to write config: {e}"))
}

#[tauri::command]
fn get_documents_dir() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|e| e.to_string())?;
    let docs = std::path::PathBuf::from(&home).join("Documents");
    docs.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path encoding".to_string())
}

#[tauri::command]
fn path_join(base: String, parts: Vec<String>) -> Result<String, String> {
    let mut p = std::path::PathBuf::from(base);
    for part in parts {
        p.push(part);
    }
    p.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid path encoding".to_string())
}

// Reveal file/folder in system file explorer (Finder on macOS, Explorer on Windows)
#[tauri::command]
async fn reveal_in_explorer(path: String) -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err("Path does not exist".to_string());
    }
    let target_path = path_obj.to_path_buf();

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&target_path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 프론트엔드는 경로를 슬래시(/)로 정규화해서 넘기지만 explorer.exe 는
        // 백슬래시만 이해한다. 슬래시 경로를 그대로 주면 explorer 가 위치를 못 찾고
        // 기본 폴더(내 문서)를 열어 파일이 안 보인다. → 반드시 \ 로 변환한다.
        let win_path = target_path.display().to_string().replace('/', "\\");
        // std Command::arg 는 공백이 있는 인자를 통째로 따옴표로 감싸는데,
        // explorer 의 "/select,<path>" 는 그 형태를 인자로 인식하지 못한다.
        // raw_arg 로 우리가 직접 따옴표를 붙여 명령행을 구성한다.
        if target_path.is_dir() {
            Command::new("explorer.exe")
                .raw_arg(format!("\"{}\"", win_path))
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        } else {
            Command::new("explorer.exe")
                .raw_arg(format!("/select,\"{}\"", win_path))
                .spawn()
                .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open for the parent directory
        let parent = target_path.parent().unwrap_or(&target_path);
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

// Open a separate WSL terminal window for the current local project.
#[tauri::command]
async fn open_external_wsl_terminal(work_dir: Option<String>) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = work_dir;
        return Err("External WSL terminal is only available on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::path::Path;

        ensure_wsl_distribution_installed()?;

        let requested = work_dir.unwrap_or_default();
        let trimmed = requested.trim();
        let cwd =
            if !trimmed.is_empty() && !trimmed.starts_with("ssh://") && Path::new(trimmed).exists()
            {
                Some(trimmed.to_string())
            } else {
                None
            };

        let mut wt = Command::new("wt.exe");
        if let Some(dir) = &cwd {
            wt.arg("-d").arg(dir);
        }
        wt.arg("wsl.exe");
        if let Some(dir) = &cwd {
            wt.arg("--cd").arg(dir);
        }

        match wt.spawn() {
            Ok(_) => Ok(()),
            Err(wt_err) => {
                let mut wsl = Command::new("wsl.exe");
                if let Some(dir) = &cwd {
                    wsl.arg("--cd").arg(dir);
                }
                wsl.spawn().map(|_| ()).map_err(|wsl_err| {
                    format!(
                        "Failed to launch Windows Terminal ({}) or WSL ({}). Install WSL first, and install Windows Terminal for the best external terminal experience.",
                        wt_err, wsl_err
                    )
                })
            }
        }
    }
}

// Copy text to clipboard — MUST run on main thread (macOS NSPasteboard thread safety)
#[tauri::command]
async fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        use arboard::Clipboard;
        let result = Clipboard::new()
            .map_err(|e| format!("Failed to access clipboard: {}", e))
            .and_then(|mut cb| {
                cb.set_text(text)
                    .map_err(|e| format!("Failed to copy to clipboard: {}", e))
            });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;
    rx.await
        .map_err(|e| format!("Clipboard channel error: {}", e))?
}

// Read text from system clipboard — MUST run on main thread (macOS NSPasteboard thread safety)
#[tauri::command]
async fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        use arboard::Clipboard;
        let result = Clipboard::new()
            .map_err(|e| format!("Failed to access clipboard: {}", e))
            .and_then(|mut cb| {
                cb.get_text()
                    .map_err(|e| format!("Failed to read clipboard text: {}", e))
            });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;
    rx.await
        .map_err(|e| format!("Clipboard channel error: {}", e))?
}

// Read file paths from system clipboard (macOS: Finder copy, Windows: Explorer copy)
#[tauri::command]
async fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = common::no_window_command("swift")
            .arg("-e")
            .arg(r#"
import AppKit
let pb = NSPasteboard.general
if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
    for url in urls { print(url.path) }
}
"#)
            .output()
            .map_err(|e| format!("Failed to run swift: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let paths: Vec<String> = stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        Ok(paths)
    }
    #[cfg(target_os = "windows")]
    {
        // Windows: use PowerShell to read file drop list from clipboard
        let output = common::no_window_command("powershell")
            .args(&[
                "-NoProfile",
                "-Command",
                "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
            ])
            .output()
            .map_err(|e| format!("Failed to run powershell: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let paths: Vec<String> = stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();
        Ok(paths)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(vec![])
    }
}

#[tauri::command]
async fn open_folder_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use std::sync::mpsc as std_mpsc;
    let (tx, rx) = std_mpsc::channel();

    app.dialog()
        .file()
        .set_title("Select Project Folder")
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });

    rx.recv()
        .map_err(|e| e.to_string())?
        .map(Some)
        .ok_or_else(|| "Cancelled".to_string())
        .or(Ok(None))
}

#[tauri::command]
async fn open_file_dialog(
    app: AppHandle,
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use std::sync::mpsc as std_mpsc;
    let (tx, rx) = std_mpsc::channel();

    let mut builder = app
        .dialog()
        .file()
        .set_title(title.as_deref().unwrap_or("Select File"));

    if let Some(p) = default_path.as_deref() {
        let expanded = if let Some(stripped) = p.strip_prefix("~/") {
            if let Some(home) = resolve_home_dir() {
                format!("{}/{}", home, stripped)
            } else {
                p.to_string()
            }
        } else {
            p.to_string()
        };
        let path = std::path::PathBuf::from(&expanded);
        if path.exists() {
            builder = builder.set_directory(path);
        }
    }

    builder.pick_file(move |file| {
        let _ = tx.send(file.map(|p| p.to_string()));
    });

    rx.recv()
        .map_err(|e| e.to_string())?
        .map(Some)
        .ok_or_else(|| "Cancelled".to_string())
        .or(Ok(None))
}

#[tauri::command]
async fn open_files_dialog(app: AppHandle) -> Result<Vec<String>, String> {
    use std::sync::mpsc as std_mpsc;
    let (tx, rx) = std_mpsc::channel();

    app.dialog()
        .file()
        .set_title("파일 선택 (여러 개 가능)")
        .pick_files(move |files| {
            let paths: Vec<String> = files
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.to_string())
                .collect();
            let _ = tx.send(paths);
        });

    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_text_input(prompt: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"
            set dialogResult to display dialog "{}" default answer "" with title "Text Input" buttons {{"Cancel", "OK"}} default button "OK"
            if button returned of dialogResult is "OK" then
                return text returned of dialogResult
            else
                return ""
            end if
            "#,
            prompt.replace("\"", "\\\"")
        );

        let output = common::no_window_command("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if text.is_empty() {
                Ok(None)
            } else {
                Ok(Some(text))
            }
        } else {
            // User cancelled
            Ok(None)
        }
    }

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName Microsoft.VisualBasic
            $text = [Microsoft.VisualBasic.Interaction]::InputBox('{}', 'Text Input', '')
            [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
            "#,
            prompt.replace("'", "''")
        );

        let output = common::no_window_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            let encoded = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if encoded.is_empty() {
                return Ok(None);
            }

            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|e| e.to_string())?;
            let text = String::from_utf8(bytes)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string();
            if text.is_empty() {
                Ok(None)
            } else {
                Ok(Some(text))
            }
        } else {
            Ok(None)
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Native input not supported on this platform".to_string())
    }
}

#[tauri::command]
async fn capture_screenshot() -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    safe_eprintln!("[capture_screenshot] called");

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let home = resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
    let screenshots_dir = format!("{}/Pictures/Screenshots", home);
    std::fs::create_dir_all(&screenshots_dir).ok();

    let filename_png = format!("{}/screenshot_{}.png", screenshots_dir, timestamp);
    safe_eprintln!("[capture_screenshot] target: {}", filename_png);

    #[cfg(target_os = "macos")]
    {
        // screencapture -i: 영역 선택 UI
        let status = common::no_window_command("/usr/sbin/screencapture")
            .args(["-i", &filename_png])
            .status()
            .map_err(|e| {
                safe_eprintln!("[capture_screenshot] screencapture failed: {}", e);
                e.to_string()
            })?;

        if !status.success() || !std::path::Path::new(&filename_png).exists() {
            return Err("Screenshot cancelled".to_string());
        }

        // 빈 이미지 감지 (Screen Recording 권한 없으면 하얀 이미지 생성됨)
        // sips로 픽셀 크기 조회 후 파일 크기 대비 비정상적으로 작으면 권한 문제로 판단
        let file_size = std::fs::metadata(&filename_png)
            .map(|m| m.len())
            .unwrap_or(0);
        let (mut w, mut h): (u64, u64) = (0, 0);
        let sips_out = common::no_window_command("sips")
            .args(["-g", "pixelWidth", "-g", "pixelHeight", &filename_png])
            .output();
        if let Ok(out) = sips_out {
            let info = String::from_utf8_lossy(&out.stdout);
            let parse_val = |key: &str| -> u64 {
                info.lines()
                    .find(|l| l.contains(key))
                    .and_then(|l| l.split_whitespace().last())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0)
            };
            w = parse_val("pixelWidth");
            h = parse_val("pixelHeight");
            // 완전 흰색 PNG는 매우 작음 (1000x1000 흰색 ≈ 3KB, 실제 스크린샷 ≈ 수백KB)
            if w > 0 && h > 0 && file_size < (w * h / 200) {
                let _ = std::fs::remove_file(&filename_png);
                return Err("스크린샷이 비어 있습니다. Screen Recording 권한을 확인해주세요: 시스템 설정 → 개인정보 보호 및 보안 → 화면 기록".to_string());
            }
        }

        safe_eprintln!(
            "[capture_screenshot] captured: {} ({}bytes)",
            filename_png,
            file_size
        );

        // sips 후처리: Retina DPI 정규화 → JPEG 변환 + 리사이즈
        // Retina 디스플레이에서 144 DPI로 저장되어 뷰어/AI에서 좌표가 어긋나는 문제 방지
        let _ = common::no_window_command("sips")
            .args([
                "-s",
                "dpiWidth",
                "72.0",
                "-s",
                "dpiHeight",
                "72.0",
                &filename_png,
            ])
            .status();

        let filename_jpg = format!("{}/screenshot_{}_ai.jpg", screenshots_dir, timestamp);
        let quality = "80";

        // 리사이즈: 긴 변이 2000px 초과 시만 축소 (Retina 2x 원본 보존)
        let needs_resize = w > 2000 || h > 2000;

        let mut cmd = common::no_window_command("sips");
        if needs_resize {
            cmd.args(["-Z", "2000"]);
        }
        let status2 = cmd
            .args([
                "-s",
                "format",
                "jpeg",
                "-s",
                "formatOptions",
                quality,
                &filename_png,
                "--out",
                &filename_jpg,
            ])
            .status();

        if let Ok(st) = status2 {
            if st.success() && std::path::Path::new(&filename_jpg).exists() {
                let _ = std::fs::remove_file(&filename_png);
                return Ok(filename_jpg);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: open the modern region-select overlay (Snip & Sketch) and
        // poll the clipboard until the snip lands. We drive the overlay via the
        // `ms-screenclip:` URI instead of SendKeys({PRTSC}) because Windows 11's
        // "Use the Print screen key to open Snipping Tool" setting hijacks the
        // PrtSc key — so {PRTSC} no longer copies the screen to the clipboard and
        // the blind 500ms read found nothing. Polling for a *new* image also
        // removes the race where the read fired before the user finished snipping.
        safe_eprintln!("[capture_screenshot] Windows: launching ms-screenclip overlay");

        // Signature of any image already on the clipboard, so we only accept a
        // genuinely new capture (and never clobber the user's clipboard).
        fn clipboard_image_sig() -> Option<(usize, usize, usize)> {
            arboard::Clipboard::new()
                .ok()
                .and_then(|mut c| c.get_image().ok())
                .map(|img| (img.width, img.height, img.bytes.len()))
        }
        let before_sig = clipboard_image_sig();

        // Launch the snip overlay (returns immediately; the overlay runs async).
        common::no_window_command("explorer")
            .arg("ms-screenclip:")
            .status()
            .map_err(|e| {
                safe_eprintln!("[capture_screenshot] failed to launch ms-screenclip: {}", e);
                format!("Failed to launch snip overlay: {}", e)
            })?;

        // Wait for the user to finish snipping: poll until a new clipboard image
        // appears, or time out (treated as user cancellation).
        let mut captured: Option<arboard::ImageData> = None;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if let Ok(mut cb) = arboard::Clipboard::new() {
                if let Ok(img) = cb.get_image() {
                    let sig = (img.width, img.height, img.bytes.len());
                    if Some(sig) != before_sig {
                        captured = Some(img);
                        break;
                    }
                }
            }
        }

        let img_data = captured.ok_or_else(|| {
            "선택영역 캡처가 취소되었거나 클립보드에 이미지가 없습니다.".to_string()
        })?;

        // Convert RGBA bytes to PNG and save
        let width = img_data.width as u32;
        let height = img_data.height as u32;
        let rgba = img_data.bytes;

        let file = std::fs::File::create(&filename_png)
            .map_err(|e| format!("Failed to create file: {}", e))?;
        let ref mut w = std::io::BufWriter::new(file);
        let mut encoder = png::Encoder::new(w, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header error: {}", e))?;
        writer
            .write_image_data(&rgba)
            .map_err(|e| format!("PNG write error: {}", e))?;

        safe_eprintln!("[capture_screenshot] Windows: saved {}", filename_png);
        return Ok(filename_png);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        use screenshots::Screen;

        let screens = Screen::all().map_err(|e| format!("Failed to enumerate displays: {}", e))?;
        let screen = screens
            .first()
            .ok_or_else(|| "No display found".to_string())?;
        let image = screen
            .capture()
            .map_err(|e| format!("Failed to capture screen: {}", e))?;
        image
            .save(&filename_png)
            .map_err(|e| format!("Failed to save screenshot: {}", e))?;
        return Ok(filename_png);
    }

    Ok(filename_png)
}

// 인터랙티브 화면 녹화 — 사용자가 영역을 드래그하면 녹화가 시작되고 메뉴바의
// 정지 버튼으로 끝낸다. 녹화가 몇 분씩 걸릴 수 있으므로 async 런타임을 막지
// 않게 blocking 스레드에서 기다린다.
#[tauri::command]
async fn capture_screen_video(path: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let out_path = path.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            common::no_window_command("/usr/sbin/screencapture")
                .args(["-iv", &out_path])
                .status()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if !status.success() || !std::path::Path::new(&path).exists() {
            return Err("Recording cancelled".to_string());
        }
        Ok(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Screen recording is currently macOS-only. On Windows, use Win+Alt+R (Game Bar).".to_string())
    }
}

#[tauri::command]
async fn capture_screen_png_base64() -> Result<String, String> {
    use base64::Engine as _;
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let temp_dir = std::env::temp_dir().join("bbarit-browser-captures");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let filename = temp_dir.join(format!("screen_{timestamp}.png"));

    #[cfg(target_os = "macos")]
    {
        let filename_string = filename.to_string_lossy().to_string();
        let status = common::no_window_command("/usr/sbin/screencapture")
            .args(["-x", "-t", "png", filename_string.as_str()])
            .status()
            .map_err(|e| format!("screencapture failed: {e}"))?;
        if !status.success() || !filename.exists() {
            return Err("screencapture did not produce an image".to_string());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        use screenshots::Screen;
        let screens = Screen::all().map_err(|e| format!("Failed to enumerate displays: {e}"))?;
        let screen = screens.first().ok_or_else(|| "No display found".to_string())?;
        let image = screen.capture().map_err(|e| format!("Failed to capture screen: {e}"))?;
        image
            .save(&filename)
            .map_err(|e| format!("Failed to save screenshot: {e}"))?;
    }

    let bytes = std::fs::read(&filename).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&filename);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

// Save clipboard image
#[tauri::command]
async fn save_clipboard_image(base64_data: String, extension: String) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let home = resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
    let images_dir = format!("{}/Pictures/OctoCLI", home);
    std::fs::create_dir_all(&images_dir).ok();

    let filename = format!(
        "{}/clipboard_{}_{}.{}",
        images_dir,
        timestamp,
        rand::random::<u16>(),
        extension
    );

    // Base64 decode
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| e.to_string())?;

    // Save file
    std::fs::write(&filename, decoded).map_err(|e| e.to_string())?;

    Ok(filename)
}

// Save image from system clipboard directly (Windows-friendly fallback).
// On macOS, clipboard read MUST happen on main thread to avoid NSPasteboard race with WebKit.
#[tauri::command]
async fn save_clipboard_image_from_system_clipboard(
    app: tauri::AppHandle,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    // Read image from clipboard on the main thread
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = arboard::Clipboard::new()
            .map_err(|e| format!("Failed to access clipboard: {}. On Windows, ensure the app has clipboard permissions.", e))
            .and_then(|mut cb| {
                cb.get_image().map_err(|e| {
                    #[cfg(target_os = "windows")]
                    { format!("No image on clipboard: {}. Windows note: Some screenshot tools copy images in formats (DIB, BMP) that may not be readable. Try copying from Paint or another image editor.", e) }
                    #[cfg(not(target_os = "windows"))]
                    { format!("No image on clipboard: {}", e) }
                }).map(|img| (img.width, img.height, img.bytes.into_owned()))
            });
        let _ = tx.send(result);
    }).map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;

    let (width, height, rgba) = rx
        .await
        .map_err(|e| format!("Clipboard channel error: {}", e))??;
    let image_width = width;
    let image_height = height;

    if image_width == 0 || image_height == 0 {
        return Err("Clipboard image has zero dimensions".to_string());
    }

    // Verify we have actual pixel data
    let expected_bytes = image_width * image_height * 4; // RGBA = 4 bytes per pixel
    if rgba.len() < expected_bytes {
        return Err(format!(
            "Clipboard image data incomplete: got {} bytes, expected {} bytes ({}x{}x4)",
            rgba.len(),
            expected_bytes,
            image_width,
            image_height
        ));
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let home = resolve_home_dir().unwrap_or_else(|| "/tmp".to_string());
    let images_dir = format!("{}/Pictures/OctoCLI", home);
    std::fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images directory: {}", e))?;

    let filename = format!(
        "{}/clipboard_{}_{}.png",
        images_dir,
        timestamp,
        rand::random::<u16>()
    );

    let file =
        std::fs::File::create(&filename).map_err(|e| format!("Failed to create file: {}", e))?;
    let mut out = std::io::BufWriter::new(file);

    let mut encoder = png::Encoder::new(&mut out, image_width as u32, image_height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);

    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("Failed to write PNG header: {}", e))?;

    writer
        .write_image_data(&rgba)
        .map_err(|e| format!("Failed to write PNG data: {}", e))?;

    Ok(filename)
}

/// Model/CLI-agnostic check: does this terminal's shell currently have a running
/// child process?
///
/// Deciding whether an agent CLI (claude/codex/gemini/…) is up by scraping the
/// screen for banners or prompt shapes is brittle — every model and CLI prints
/// something different and the text keeps changing. The one OS-level truth that
/// holds for ALL of them is process occupancy: a bare shell at a prompt has no
/// children; the moment any CLI launches it runs as a descendant of that shell.
/// The broker uses this (instead of banner matching) to know when an agent is
/// running, so it never re-injects the start command into a live agent.
#[tauri::command]
fn pty_terminal_has_child(state: State<'_, AppState>, terminal_id: String) -> Result<bool, String> {
    let shell_pid = {
        let ptys = state.ptys.lock().unwrap();
        let Some(instance) = ptys.get(&terminal_id) else {
            return Err("PTY not found".to_string());
        };
        instance.child.process_id()
    };
    Ok(match shell_pid {
        Some(pid) => shell_has_descendant(pid),
        None => false, // shell already exited — nothing is running here
    })
}

/// True if any live process descends from `shell_pid` (direct child or deeper).
/// Bounded ancestor walk tolerates PID reuse / parent cycles.
fn shell_has_descendant(shell_pid: u32) -> bool {
    let target = Pid::from_u32(shell_pid);
    let mut sys = sysinfo_system().lock().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let procs = sys.processes();
    procs.keys().any(|&pid| {
        if pid == target {
            return false;
        }
        let mut cur = procs.get(&pid).and_then(|p| p.parent());
        let mut depth = 0;
        while let Some(parent) = cur {
            if parent == target {
                return true;
            }
            cur = procs.get(&parent).and_then(|p| p.parent());
            depth += 1;
            if depth > 64 {
                break;
            }
        }
        false
    })
}

#[tauri::command]
fn get_pty_cwd(state: State<'_, AppState>, terminal_id: String) -> Result<Option<String>, String> {
    let ptys = state.ptys.lock().unwrap();
    let Some(instance) = ptys.get(&terminal_id) else {
        return Ok(None);
    };

    let Some(pid) = instance.child.process_id() else {
        return Ok(None);
    };

    // On macOS, use lsof to query the CWD of the shell process.
    #[cfg(target_os = "macos")]
    {
        let output = common::no_window_command("lsof")
            .args(["-a", "-d", "cwd", "-Fn", "-p", &pid.to_string()])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            return Ok(None);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        // lsof -Fn output: lines starting with 'n' contain the path
        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix('n') {
                if !path.is_empty() && path.starts_with('/') {
                    return Ok(Some(path.to_string()));
                }
            }
        }
        Ok(None)
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

static SYSINFO: OnceLock<Mutex<System>> = OnceLock::new();

fn sysinfo_system() -> &'static Mutex<System> {
    SYSINFO.get_or_init(|| Mutex::new(System::new()))
}

// ─── Embedding-based agent-readiness classifier (minishlab/potion-code-16M) ───
// Instead of brittle regex/banner matching, embed the terminal tail and compare
// (cosine) to reference phrases for two classes: a raw shell prompt that still
// needs the CLI launched vs. an AI coding agent already running. Returns scores
// so the decision is tunable and verifiable.

fn strip_ansi_basic(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                chars.next();
            }
        } else if (c as u32) < 0x20 && c != '\n' && c != '\t' {
            // drop other control chars (\r, \x07, ...)
        } else {
            out.push(c);
        }
    }
    out
}

fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 1e-12 || nb <= 1e-12 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

struct AgentReadyClassifier {
    encoder: crate::semble::encoder::StaticEncoder,
    ready_refs: Vec<Vec<f32>>,
    shell_refs: Vec<Vec<f32>>,
}

// Reference phrases per class. Max-cosine over each class is the class score.
const READY_REFS: &[&str] = &[
    "Welcome to Claude Code, an interactive AI coding assistant is running and waiting for your instructions",
    "Claude Opus Sonnet bypass permissions on, cwd, accept edits, esc to interrupt, ? for shortcuts",
    "OpenAI Codex CLI agent, model, directory, approvals, working, ready for input",
    "an AI coding agent is running in this terminal and ready to receive a task prompt",
];
const SHELL_REFS: &[&str] = &[
    "PS C:\\Users\\user> Windows PowerShell command prompt waiting for a command",
    "C:\\Users\\user> empty windows command shell prompt, nothing is running",
    "user@host:~$ bash shell prompt, idle, no program running",
    "an empty interactive shell prompt with no program started yet",
];

impl AgentReadyClassifier {
    fn load() -> Result<Self, String> {
        let encoder = crate::semble::encoder::StaticEncoder::load(None).map_err(|e| e.to_string())?;
        let mut ready_refs = Vec::with_capacity(READY_REFS.len());
        for t in READY_REFS {
            ready_refs.push(encoder.encode_single(t).map_err(|e| e.to_string())?.to_vec());
        }
        let mut shell_refs = Vec::with_capacity(SHELL_REFS.len());
        for t in SHELL_REFS {
            shell_refs.push(encoder.encode_single(t).map_err(|e| e.to_string())?.to_vec());
        }
        Ok(Self { encoder, ready_refs, shell_refs })
    }

    fn classify(&self, text: &str) -> Result<(f32, f32), String> {
        let v = self.encoder.encode_single(text).map_err(|e| e.to_string())?.to_vec();
        let max_sim = |refs: &[Vec<f32>]| -> f32 {
            refs.iter().map(|r| cosine_sim(&v, r)).fold(f32::MIN, f32::max)
        };
        Ok((max_sim(&self.ready_refs), max_sim(&self.shell_refs)))
    }
}

static AGENT_READY_CLF: OnceLock<Mutex<Option<AgentReadyClassifier>>> = OnceLock::new();

/// Embedding-based readiness: returns whether the terminal text looks like an
/// already-running agent (ready=true → do NOT inject a start command) vs a raw
/// shell prompt, plus the raw class similarities for tuning.
#[tauri::command]
async fn classify_agent_ready(text: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cell = AGENT_READY_CLF.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().map_err(|e| e.to_string())?;
        if guard.is_none() {
            *guard = Some(AgentReadyClassifier::load()?);
        }
        let clf = guard.as_ref().unwrap();
        let clean = strip_ansi_basic(&text);
        let chars: Vec<char> = clean.chars().collect();
        let start = chars.len().saturating_sub(600);
        let tail: String = chars[start..].iter().collect();
        let (sim_ready, sim_shell) = clf.classify(&tail)?;
        Ok::<_, String>(serde_json::json!({
            "ready": sim_ready > sim_shell,
            "simReady": sim_ready,
            "simShell": sim_shell,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
struct ProcessStats {
    memory_mb: f64,
    cpu_percent: f32,
}

#[tauri::command]
fn get_process_stats() -> ProcessStats {
    let pid = Pid::from_u32(std::process::id());
    let mut sys = sysinfo_system().lock().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    if let Some(proc) = sys.process(pid) {
        ProcessStats {
            memory_mb: proc.memory() as f64 / (1024.0 * 1024.0),
            cpu_percent: proc.cpu_usage(),
        }
    } else {
        ProcessStats {
            memory_mb: 0.0,
            cpu_percent: 0.0,
        }
    }
}

// ─── PM2 Commands ────────────────────────────────────────────────────

/// Run `pm2 jlist` on remote (SSH) or local host, return raw JSON string.
#[tauri::command]
fn pm2_list(work_dir: String) -> Result<String, String> {
    let spec = parse_ssh_path(&work_dir)?;
    if let Some(spec) = spec {
        let out = run_ssh_command(&spec, "pm2 jlist 2>/dev/null")?;
        String::from_utf8(out).map_err(|e| format!("UTF-8 decode error: {e}"))
    } else {
        // Local
        let output = common::no_window_command("sh")
            .arg("-lc")
            .arg("pm2 jlist 2>/dev/null")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("pm2 jlist failed: {e}"))?;
        String::from_utf8(output.stdout).map_err(|e| format!("UTF-8 decode error: {e}"))
    }
}

/// Run pm2 action (restart/stop/start) on a named process.
#[tauri::command]
fn pm2_action(work_dir: String, action: String, app_name: String) -> Result<String, String> {
    // Whitelist allowed actions
    match action.as_str() {
        "restart" | "stop" | "start" | "reload" | "delete" => {}
        _ => return Err(format!("Invalid pm2 action: {action}")),
    }
    // `app_name` goes through `sh -lc` / a remote shell: quote it, and refuse
    // option-shaped names so it can't become a pm2 flag either.
    let app_name = app_name.trim();
    if app_name.is_empty() {
        return Err("pm2 app name is required".to_string());
    }
    reject_option_like(app_name, "pm2 app name")?;
    let cmd_str = format!("pm2 {} {} 2>&1", action, sh_quote(app_name));
    let spec = parse_ssh_path(&work_dir)?;
    if let Some(spec) = spec {
        let out = run_ssh_command(&spec, &cmd_str)?;
        String::from_utf8(out).map_err(|e| format!("UTF-8 decode error: {e}"))
    } else {
        let output = common::no_window_command("sh")
            .arg("-lc")
            .arg(&cmd_str)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("pm2 action failed: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(format!("{}{}", stdout, stderr))
    }
}

/// Read and parse ~/.ssh/config, returning JSON array of host entries.
#[tauri::command]
fn read_ssh_config() -> Result<String, String> {
    let home = resolve_home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let config_path = format!("{}/.ssh/config", home);
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_path, e))?;

    let mut hosts: Vec<serde_json::Value> = Vec::new();
    let mut current: Option<serde_json::Map<String, serde_json::Value>> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // Split on first whitespace or '='
        let (key, value) = if let Some(eq_idx) = trimmed.find('=') {
            (trimmed[..eq_idx].trim(), trimmed[eq_idx + 1..].trim())
        } else if let Some(sp_idx) = trimmed.find(char::is_whitespace) {
            (trimmed[..sp_idx].trim(), trimmed[sp_idx..].trim())
        } else {
            continue;
        };

        let key_lower = key.to_lowercase();
        if key_lower == "host" {
            // Save previous entry
            if let Some(prev) = current.take() {
                if prev
                    .get("host")
                    .and_then(|h| h.as_str())
                    .map(|h| !h.contains('*') && !h.contains('?'))
                    .unwrap_or(false)
                {
                    hosts.push(serde_json::Value::Object(prev));
                }
            }
            let mut entry = serde_json::Map::new();
            entry.insert(
                "host".to_string(),
                serde_json::Value::String(value.to_string()),
            );
            current = Some(entry);
        } else if let Some(ref mut entry) = current {
            match key_lower.as_str() {
                "hostname" => {
                    entry.insert(
                        "hostname".to_string(),
                        serde_json::Value::String(value.to_string()),
                    );
                }
                "user" => {
                    entry.insert(
                        "user".to_string(),
                        serde_json::Value::String(value.to_string()),
                    );
                }
                "port" => {
                    entry.insert(
                        "port".to_string(),
                        serde_json::Value::String(value.to_string()),
                    );
                }
                "identityfile" => {
                    entry.insert(
                        "identityFile".to_string(),
                        serde_json::Value::String(value.to_string()),
                    );
                }
                _ => {}
            }
        }
    }
    // Last entry
    if let Some(prev) = current {
        if prev
            .get("host")
            .and_then(|h| h.as_str())
            .map(|h| !h.contains('*') && !h.contains('?'))
            .unwrap_or(false)
        {
            hosts.push(serde_json::Value::Object(prev));
        }
    }

    serde_json::to_string(&hosts).map_err(|e| format!("JSON serialize error: {e}"))
}

/// Collect server stats (CPU, memory, disk, uptime, load) via SSH or locally.
#[tauri::command]
fn server_stats(work_dir: String) -> Result<String, String> {
    // One-liner that outputs JSON-like key=value pairs
    let script = r#"echo "CPU_CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"; echo "LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1,$2,$3}' || uptime | sed 's/.*load average[s]*: //' | awk -F'[, ]+' '{print $1,$2,$3}')"; echo "MEM=$(free -b 2>/dev/null | awk '/^Mem:/{print $2,$3,$4,$7}' || vm_stat 2>/dev/null | awk '/Pages (free|active|inactive|wired|speculative)/{gsub(/\./,"",$NF); s+=$NF} END{print s*4096}')"; echo "DISK=$(df -B1 / 2>/dev/null | awk 'NR==2{print $2,$3,$4,$5}' || df -k / | awk 'NR==2{print $2*1024,$3*1024,$4*1024,$5}')"; echo "UPTIME=$(cat /proc/uptime 2>/dev/null | awk '{print $1}' || sysctl -n kern.boottime 2>/dev/null | awk -F'[= ,}]+' '{print systime()-$4}')""#;
    let spec = parse_ssh_path(&work_dir)?;
    if let Some(spec) = spec {
        let out = run_ssh_command(&spec, script)?;
        String::from_utf8(out).map_err(|e| format!("UTF-8 decode error: {e}"))
    } else {
        let output = common::no_window_command("sh")
            .arg("-lc")
            .arg(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("server_stats failed: {e}"))?;
        String::from_utf8(output.stdout).map_err(|e| format!("UTF-8 decode error: {e}"))
    }
}

fn server_analysis_script(tool: &str) -> Result<&'static str, String> {
    match tool {
        "overview" => Ok(
            r#"echo "HOST=$(hostname 2>/dev/null || uname -n)"; echo "OS=$(cat /etc/os-release 2>/dev/null | awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2); print $2; exit}' || sw_vers -productName 2>/dev/null || uname -s)"; echo "KERNEL=$(uname -srmo 2>/dev/null || uname -a)"; echo "UPTIME=$(uptime -p 2>/dev/null || uptime)"; echo "TIME=$(date '+%Y-%m-%d %H:%M:%S %Z')"; echo "USERS=$(who 2>/dev/null | wc -l | tr -d ' ')"; echo "SHELL=$(printf '%s' "$SHELL")"; echo "PWD=$(pwd)""#,
        ),
        "health" => Ok(
            r#"echo "== LOAD =="; uptime; echo; echo "== MEMORY =="; free -h 2>/dev/null || vm_stat 2>/dev/null || echo "memory command unavailable"; echo; echo "== DISK =="; df -hT / 2>/dev/null || df -h /; echo; echo "== TOP CPU =="; ps -eo pid,ppid,pcpu,pmem,rss,comm,args --sort=-pcpu 2>/dev/null | head -n 12 || ps aux | head -n 12; echo; echo "== FAILED SERVICES =="; systemctl --failed --no-pager 2>/dev/null || echo "systemd unavailable""#,
        ),
        "processes" => Ok(
            r#"echo "== TOP CPU =="; ps -eo pid,ppid,pcpu,pmem,rss,comm,args --sort=-pcpu 2>/dev/null | head -n 20 || ps aux | head -n 20; echo; echo "== TOP MEMORY =="; ps -eo pid,ppid,pcpu,pmem,rss,comm,args --sort=-pmem 2>/dev/null | head -n 20 || ps aux | sort -nrk 4 | head -n 20"#,
        ),
        "ports" => Ok(
            r#"echo "== LISTENING PORTS =="; (ss -tulpen 2>/dev/null || ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null) | head -n 100; echo; echo "== CONNECTION SUMMARY =="; ss -s 2>/dev/null || netstat -an 2>/dev/null | awk '{print $6}' | sort | uniq -c | sort -nr | head"#,
        ),
        "disk" => Ok(
            r#"echo "== FILESYSTEMS =="; df -hT 2>/dev/null || df -h; echo; echo "== INODES =="; df -ih 2>/dev/null || echo "inode summary unavailable"; echo; echo "== LARGE STANDARD PATHS =="; du -sh /var/log /tmp "$PWD" 2>/dev/null | sort -hr"#,
        ),
        "services" => Ok(
            r#"echo "== FAILED UNITS =="; systemctl --failed --no-pager 2>/dev/null || echo "systemd unavailable"; echo; echo "== RUNNING SERVICES =="; systemctl list-units --type=service --state=running --no-pager 2>/dev/null | head -n 50 || service --status-all 2>/dev/null | head -n 50 || echo "service listing unavailable""#,
        ),
        "docker" => Ok(
            r#"if command -v docker >/dev/null 2>&1; then echo "== CONTAINERS =="; docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}' 2>/dev/null; echo; echo "== RESOURCE SNAPSHOT =="; docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}' 2>/dev/null; else echo "Docker unavailable"; fi"#,
        ),
        "logs" => Ok(
            r#"echo "== RECENT WARNINGS =="; journalctl -p warning..alert -n 80 --no-pager 2>/dev/null || tail -n 80 /var/log/syslog 2>/dev/null || tail -n 80 /var/log/system.log 2>/dev/null || echo "logs unavailable"; echo; echo "== KERNEL ERRORS =="; dmesg --level=err,warn 2>/dev/null | tail -n 40 || echo "kernel log unavailable""#,
        ),
        "security" => Ok(
            r#"echo "== LOGIN SESSIONS =="; who 2>/dev/null || true; echo; echo "== RECENT LOGINS =="; last -n 12 2>/dev/null || true; echo; echo "== SSH FAILURES =="; (grep -h "Failed password" /var/log/auth.log /var/log/secure 2>/dev/null || journalctl -u ssh -u sshd -n 80 --no-pager 2>/dev/null | grep -i "failed") | tail -n 30 || echo "no readable ssh failure log""#,
        ),
        "network" => Ok(
            r#"echo "== INTERFACES =="; ip -brief addr 2>/dev/null || ifconfig 2>/dev/null | head -n 80; echo; echo "== ROUTES =="; ip route 2>/dev/null || netstat -rn 2>/dev/null; echo; echo "== SOCKET SUMMARY =="; ss -s 2>/dev/null || netstat -an 2>/dev/null | awk '{print $6}' | sort | uniq -c | sort -nr | head"#,
        ),
        _ => Err(format!("Unknown server analysis tool: {tool}")),
    }
}

/// Run a read-only server analysis tool via SSH or locally.
#[tauri::command]
async fn server_analysis(work_dir: String, tool: String) -> Result<String, String> {
    let script = server_analysis_script(tool.trim())?;
    let spec = parse_ssh_path(&work_dir)?;
    let bytes = if let Some(spec) = spec {
        run_ssh_command_async(&spec, script).await?
    } else {
        let output = common::no_window_async_command("sh")
            .arg("-lc")
            .arg(script)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .map_err(|e| format!("server_analysis failed: {e}"))?;
        if output.status.success() {
            output.stdout
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let msg = stderr.trim();
            return Err(if msg.is_empty() {
                format!("server_analysis failed: {}", stdout.trim())
            } else {
                format!("server_analysis failed: {msg}")
            });
        }
    };
    String::from_utf8(bytes).map_err(|e| format!("UTF-8 decode error: {e}"))
}

/// Run a CLI command (claude, codex, gemini, etc.) in one-shot mode.
/// Spawns a login shell with `-c` to run the command, captures stdout+stderr,
/// and returns the output as a string. Default timeout: 120 seconds.
/// Pass `timeout_secs` to override (max 900s = 15min); pass 0 for no timeout.
///
/// `login` defaults to true (a login shell, so profile-set PATH/tool shims like
/// volta/fnm/pyenv resolve — needed when launching agent CLIs). Pass `login:false`
/// for cheap, frequently-repeated commands that only need tools already on PATH
/// (e.g. the broker's git probes): on Windows a Git-Bash login shell sources the
/// whole `/etc/profile` chain on EVERY call (~2.3s wasted/call measured), so the
/// broker's 6s relay loop spent most of its time re-initializing shells. A
/// non-login shell (`-c`) skips that. PATH/HOME/USER and ~/.config/octo/.env are
/// injected explicitly below either way, so git/node still resolve.
#[tauri::command]
async fn run_cli_oneshot(
    command: String,
    work_dir: Option<String>,
    timeout_secs: Option<u64>,
    login: Option<bool>,
) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::{AsyncRead, AsyncReadExt};
    let use_login = login.unwrap_or(true);

    async fn read_to_end_capped<R: AsyncRead + Unpin>(reader: &mut R, max_bytes: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(max_bytes.min(8192));
        let mut chunk = [0u8; 8192];
        let mut truncated = false;
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let remaining = max_bytes.saturating_sub(out.len());
                    if remaining > 0 {
                        let keep = remaining.min(n);
                        out.extend_from_slice(&chunk[..keep]);
                    }
                    if n > remaining {
                        truncated = true;
                    }
                }
            }
        }
        if truncated {
            out.extend_from_slice(b"\n[output truncated]\n");
        }
        out
    }

    let home = resolve_home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let cwd = work_dir.unwrap_or_else(|| home.clone());
    #[cfg(target_os = "windows")]
    let username = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
    #[cfg(not(target_os = "windows"))]
    let username = common::no_window_command("id")
        .arg("-un")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()));

    #[cfg(target_os = "windows")]
    let path = {
        let existing = std::env::var("PATH").unwrap_or_default();
        format!(
            "{};{}\\.local\\bin;{}\\AppData\\Roaming\\npm;{}\\.opencode\\bin",
            existing, home, home, home
        )
    };
    #[cfg(not(target_os = "windows"))]
    let path = {
        let nvm_node_path = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .max()
            })
            .map(|p| format!("{}/bin", p.display()))
            .unwrap_or_else(|| format!("{}/.nvm/versions/node/v20.19.6/bin", home));
        format!(
            "{}:{}/.local/bin:{}/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            nvm_node_path, home, home
        )
    };

    #[cfg(target_os = "windows")]
    let shell = if std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").exists() {
        "C:\\Program Files\\Git\\bin\\bash.exe"
    } else {
        "bash.exe"
    };
    #[cfg(not(target_os = "windows"))]
    let shell = "/bin/zsh";

    let mut cmd = common::no_window_async_command(shell);
    #[cfg(target_os = "windows")]
    {
        if use_login {
            cmd.arg("-lc");
        } else {
            cmd.arg("-c");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if use_login {
            cmd.arg("-l").arg("-c");
        } else {
            cmd.arg("-c");
        }
    }
    cmd.arg(&command)
        .current_dir(&cwd)
        .env("HOME", &home)
        .env("USER", &username)
        .env("PATH", &path)
        .env("TERM", "dumb")
        .env_remove("npm_config_prefix")
        .env_remove("CLAUDECODE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.env("SHELL", shell);
    #[cfg(not(target_os = "windows"))]
    cmd.env("SHELL", "/bin/zsh")
        .env("NVM_DIR", format!("{}/.nvm", home));

    // Load API keys from ~/.config/octo/.env
    let env_path = format!("{}/.config/octo/.env", home);
    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(eq_pos) = line.find('=') {
                let key = line[..eq_pos].trim();
                let mut value = line[eq_pos + 1..].trim();
                if (value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\''))
                {
                    value = &value[1..value.len() - 1];
                }
                cmd.env(key, value);
            }
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn '{}': {}",
            &command[..command.len().min(80)],
            e
        )
    })?;

    // Read stdout and stderr concurrently to avoid deadlock
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let wait_for_output = async {
        let stdout_fut = async {
            if let Some(mut r) = stdout_handle {
                read_to_end_capped(&mut r, CLI_ONESHOT_OUTPUT_MAX_BYTES).await
            } else {
                Vec::new()
            }
        };
        let stderr_fut = async {
            if let Some(mut r) = stderr_handle {
                read_to_end_capped(&mut r, CLI_ONESHOT_OUTPUT_MAX_BYTES).await
            } else {
                Vec::new()
            }
        };
        let (stdout_buf, stderr_buf) = tokio::join!(stdout_fut, stderr_fut);
        let status = child.wait().await;
        (stdout_buf, stderr_buf, status)
    };

    let secs = timeout_secs.unwrap_or(120).clamp(1, 900);
    let result = if matches!(timeout_secs, Some(0)) {
        Ok(wait_for_output.await)
    } else {
        tokio::time::timeout(tokio::time::Duration::from_secs(secs), wait_for_output).await
    };

    match result {
        Ok((stdout_buf, stderr_buf, status)) => {
            let out = String::from_utf8_lossy(&stdout_buf).to_string();
            let err = String::from_utf8_lossy(&stderr_buf).to_string();
            // If process exited with error and stdout is empty, return stderr as error
            let exit_ok = status.map(|s| s.success()).unwrap_or(false);
            if !exit_ok && out.trim().is_empty() {
                Err(format!(
                    "CLI failed: {}",
                    if err.is_empty() {
                        "unknown error"
                    } else {
                        err.trim()
                    }
                ))
            } else {
                Ok(out)
            }
        }
        Err(_) => {
            let _ = child.kill().await;
            Err(format!("CLI command timed out ({}s)", secs))
        }
    }
}

/// Stream CLI command output via Tauri events (non-blocking).
/// Emits `cli-stream-{stream_id}` events: { type: "chunk"|"done"|"error", data?, error? }
#[tauri::command]
async fn stream_cli_command(
    app: AppHandle,
    stream_id: String,
    command: String,
    work_dir: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};
    // Streamed agent CLIs may rely on profile-set tool shims, so keep the login shell.
    let use_login = true;

    let home = resolve_home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let cwd = work_dir.unwrap_or_else(|| home.clone());
    #[cfg(target_os = "windows")]
    let username = std::env::var("USERNAME").unwrap_or_else(|_| "unknown".to_string());
    #[cfg(not(target_os = "windows"))]
    let username = common::no_window_command("id")
        .arg("-un")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "unknown".to_string()));

    #[cfg(target_os = "windows")]
    let path = {
        let existing = std::env::var("PATH").unwrap_or_default();
        format!(
            "{};{}\\.local\\bin;{}\\AppData\\Roaming\\npm;{}\\.opencode\\bin",
            existing, home, home, home
        )
    };
    #[cfg(not(target_os = "windows"))]
    let path = {
        let nvm_node_path = std::fs::read_dir(format!("{}/.nvm/versions/node", home))
            .ok()
            .and_then(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .max()
            })
            .map(|p| format!("{}/bin", p.display()))
            .unwrap_or_else(|| format!("{}/.nvm/versions/node/v20.19.6/bin", home));
        format!(
            "{}:{}/.local/bin:{}/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            nvm_node_path, home, home
        )
    };

    #[cfg(target_os = "windows")]
    let shell = if std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").exists() {
        "C:\\Program Files\\Git\\bin\\bash.exe"
    } else {
        "bash.exe"
    };
    #[cfg(not(target_os = "windows"))]
    let shell = "/bin/zsh";

    let mut cmd = common::no_window_async_command(shell);
    #[cfg(target_os = "windows")]
    {
        if use_login {
            cmd.arg("-lc");
        } else {
            cmd.arg("-c");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if use_login {
            cmd.arg("-l").arg("-c");
        } else {
            cmd.arg("-c");
        }
    }
    cmd.arg(&command)
        .current_dir(&cwd)
        .env("HOME", &home)
        .env("USER", &username)
        .env("PATH", &path)
        .env("TERM", "dumb")
        .env_remove("npm_config_prefix")
        .env_remove("CLAUDECODE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.env("SHELL", shell);
    #[cfg(not(target_os = "windows"))]
    cmd.env("SHELL", "/bin/zsh")
        .env("NVM_DIR", format!("{}/.nvm", home));

    // Load API keys from ~/.config/octo/.env
    let env_path = format!("{}/.config/octo/.env", home);
    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(eq_pos) = line.find('=') {
                let key = line[..eq_pos].trim();
                let mut value = line[eq_pos + 1..].trim();
                if (value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\''))
                {
                    value = &value[1..value.len() - 1];
                }
                cmd.env(key, value);
            }
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let secs = timeout_secs.unwrap_or(300).clamp(1, 900);
    let sid = stream_id.clone();
    let app2 = app.clone();

    tokio::spawn(async move {
        let result = tokio::time::timeout(tokio::time::Duration::from_secs(secs), async {
            // Read stdout line by line and emit chunks
            if let Some(stdout) = stdout {
                let mut reader = BufReader::new(stdout);
                let mut line_buf = String::new();
                loop {
                    line_buf.clear();
                    match reader.read_line(&mut line_buf).await {
                        Ok(0) => break, // EOF
                        Ok(_) => {
                            let _ = app2.emit(
                                &format!("cli-stream-{}", sid),
                                serde_json::json!({"type": "chunk", "data": line_buf}),
                            );
                        }
                        Err(e) => {
                            let _ = app2.emit(
                                &format!("cli-stream-{}", sid),
                                serde_json::json!({"type": "error", "error": e.to_string()}),
                            );
                            return;
                        }
                    }
                }
            }

            // Read remaining stderr after stdout is done
            if let Some(mut stderr) = stderr {
                let mut err_buf = Vec::new();
                use tokio::io::AsyncReadExt;
                let _ = stderr.read_to_end(&mut err_buf).await;
                let err_text = String::from_utf8_lossy(&err_buf).to_string();
                if !err_text.trim().is_empty() {
                    let _ = app2.emit(
                        &format!("cli-stream-{}", sid),
                        serde_json::json!({"type": "chunk", "data": err_text}),
                    );
                }
            }

            let _ = child.wait().await;
            let _ = app2.emit(
                &format!("cli-stream-{}", sid),
                serde_json::json!({"type": "done"}),
            );
        })
        .await;

        if result.is_err() {
            let _ = child.kill().await;
            let _ = app2.emit(
                &format!("cli-stream-{}", sid),
                serde_json::json!({"type": "error", "error": format!("CLI timed out ({}s)", secs)}),
            );
        }
    });

    Ok(())
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn preview_command(command: &str) -> String {
    let compact = command.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() > 180 {
        format!("{}...", compact.chars().take(180).collect::<String>())
    } else {
        compact
    }
}

fn persist_harness_job_snapshot(snapshot: &HarnessJobSnapshot) {
    let Some(work_dir) = snapshot
        .work_dir
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    else {
        return;
    };
    let dir = std::path::Path::new(work_dir)
        .join(".bbarit")
        .join("harness")
        .join("jobs");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        safe_eprintln!("[harness] failed to create job dir: {err}");
        return;
    }
    let path = dir.join(format!("{}.json", snapshot.id));
    match serde_json::to_string_pretty(snapshot) {
        Ok(json) => {
            if let Err(err) = std::fs::write(path, json) {
                safe_eprintln!("[harness] failed to write job snapshot: {err}");
            }
        }
        Err(err) => safe_eprintln!("[harness] failed to serialize job snapshot: {err}"),
    }
}

fn update_harness_job<F>(app: &AppHandle, job_id: &str, update: F)
where
    F: FnOnce(&mut HarnessJobSnapshot),
{
    let state = app.state::<AppState>();
    let snapshot = {
        let mut jobs = state.harness_jobs.lock().unwrap();
        let Some(record) = jobs.get_mut(job_id) else {
            return;
        };
        update(&mut record.snapshot);
        record.snapshot.updated_at = now_millis();
        record.snapshot.clone()
    };
    persist_harness_job_snapshot(&snapshot);
    let _ = app.emit("harness-job-updated", snapshot);
}

/// Start a background Harness job and keep its status in the Tauri backend.
/// This survives the Harness panel being hidden/unmounted while the app process is alive.
#[tauri::command]
async fn start_harness_job(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    work_dir: Option<String>,
    timeout_secs: Option<u64>,
    label: Option<String>,
) -> Result<HarnessJobSnapshot, String> {
    let id = format!("job-{}", uuid::Uuid::new_v4());
    let now = now_millis();
    let snapshot = HarnessJobSnapshot {
        id: id.clone(),
        label: label.unwrap_or_else(|| "Harness job".to_string()),
        command_preview: preview_command(&command),
        work_dir: work_dir.clone(),
        status: "running".to_string(),
        output: String::new(),
        error: None,
        created_at: now,
        updated_at: now,
        started_at: Some(now),
        completed_at: None,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.harness_jobs.lock().unwrap();
        jobs.insert(
            id.clone(),
            HarnessJobRecord {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }
    persist_harness_job_snapshot(&snapshot);
    let _ = app.emit("harness-job-updated", snapshot.clone());

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_cli_oneshot(command, work_dir, timeout_secs, None).await;
        if cancel.load(Ordering::Relaxed) {
            update_harness_job(&app2, &id, |snapshot| {
                snapshot.status = "cancelled".to_string();
                snapshot.completed_at = Some(now_millis());
                snapshot.error = Some("작업이 중지되었습니다.".to_string());
            });
            return;
        }
        match result {
            Ok(output) => update_harness_job(&app2, &id, |snapshot| {
                snapshot.status = "completed".to_string();
                snapshot.output = output;
                snapshot.completed_at = Some(now_millis());
            }),
            Err(error) => update_harness_job(&app2, &id, |snapshot| {
                snapshot.status = "failed".to_string();
                snapshot.error = Some(error);
                snapshot.completed_at = Some(now_millis());
            }),
        }
    });

    Ok(snapshot)
}

#[tauri::command]
fn list_harness_jobs(state: State<'_, AppState>) -> Result<Vec<HarnessJobSnapshot>, String> {
    let mut jobs = state
        .harness_jobs
        .lock()
        .map_err(|_| "Harness job store is unavailable".to_string())?
        .values()
        .map(|record| record.snapshot.clone())
        .collect::<Vec<_>>();
    jobs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(jobs)
}

#[tauri::command]
fn get_harness_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<HarnessJobSnapshot>, String> {
    let jobs = state
        .harness_jobs
        .lock()
        .map_err(|_| "Harness job store is unavailable".to_string())?;
    Ok(jobs.get(&job_id).map(|record| record.snapshot.clone()))
}

#[tauri::command]
fn cancel_harness_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let cancel = {
        let jobs = state
            .harness_jobs
            .lock()
            .map_err(|_| "Harness job store is unavailable".to_string())?;
        jobs.get(&job_id).map(|record| record.cancel.clone())
    };
    let Some(cancel) = cancel else {
        return Err("Harness job not found".to_string());
    };
    cancel.store(true, Ordering::Relaxed);
    update_harness_job(&app, &job_id, |snapshot| {
        snapshot.status = "cancelled".to_string();
        snapshot.error = Some("작업 중지 요청을 보냈습니다.".to_string());
        snapshot.completed_at = Some(now_millis());
    });
    Ok(())
}

#[tauri::command]
fn clear_harness_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let mut jobs = state
        .harness_jobs
        .lock()
        .map_err(|_| "Harness job store is unavailable".to_string())?;
    jobs.remove(&job_id);
    Ok(())
}

// --- Git worktree commands (for Orchestra multi-agent isolation) ---

/// Milliseconds since this terminal's PTY last produced output. The broker uses
/// "idle for N ms" as a model/CLI-agnostic readiness & turn-complete signal: an
/// agent that's still thinking keeps repainting (resets the timer), a settled
/// prompt is quiet (timer grows). Far more robust than banner/prompt regex.
#[tauri::command]
fn pty_idle_ms(state: State<'_, AppState>, terminal_id: String) -> Result<u64, String> {
    let ptys = state.ptys.lock().unwrap();
    let Some(instance) = ptys.get(&terminal_id) else {
        return Err("PTY not found".to_string());
    };
    let last = *instance.last_output_at.lock().unwrap();
    Ok(last.elapsed().as_millis() as u64)
}

// Check if a PTY process is still alive (reader thread running)
#[tauri::command]
fn check_pty_alive(state: State<'_, AppState>, terminal_id: String) -> bool {
    let ptys = state.ptys.lock().unwrap();
    match ptys.get(&terminal_id) {
        Some(instance) => instance.alive.load(Ordering::Relaxed),
        None => false,
    }
}

/// Read the accumulated output buffer for a PTY.
/// This allows reading all output even when XTerminal is consuming the channel.
#[tauri::command]
fn read_pty_output_buffer(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<String, String> {
    let ptys = state.ptys.lock().unwrap();
    match ptys.get(&terminal_id) {
        Some(instance) => {
            let buf = instance.output_buffer.lock().unwrap();
            Ok(buf.clone())
        }
        None => Err("PTY not found".to_string()),
    }
}

#[tauri::command]
fn git_worktree_add(
    repo_dir: String,
    worktree_dir: String,
    branch_name: String,
) -> Result<String, String> {
    let branch = branch_name.trim();
    reject_option_like(branch, "branch name")?;
    reject_option_like(&worktree_dir, "worktree path")?;
    let _ = common::no_window_command("git")
        .args(["worktree", "prune"])
        .current_dir(&repo_dir)
        .output();

    let branch_exists = !branch.is_empty()
        && common::no_window_command("git")
            .args(["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
            .current_dir(&repo_dir)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);

    let mut command = common::no_window_command("git");
    command.current_dir(&repo_dir);
    command.args(["worktree", "add"]);
    if branch.is_empty() {
        command.arg("--detach").arg(&worktree_dir);
    } else if branch_exists {
        command.arg(&worktree_dir).arg(branch);
    } else {
        command.args(["-b", branch]).arg(&worktree_dir).arg("HEAD");
    }

    let output = command
        .output()
        .map_err(|e| format!("git worktree add failed: {e}"))?;

    if output.status.success() {
        Ok(worktree_dir)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree add error: {stderr}"))
    }
}

#[tauri::command]
fn git_worktree_head(worktree_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&worktree_dir)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Failed to get HEAD".to_string())
    }
}

#[tauri::command]
fn git_worktree_remove(worktree_dir: String) -> Result<(), String> {
    reject_option_like(&worktree_dir, "worktree path")?;
    // Force remove worktree
    let output = common::no_window_command("git")
        .args(["worktree", "remove", "--force", &worktree_dir])
        .output()
        .map_err(|e| format!("git worktree remove failed: {e}"))?;

    if !output.status.success() {
        // Fallback: just delete the directory
        let _ = std::fs::remove_dir_all(&worktree_dir);
    }
    // Prune stale worktrees
    let _ = common::no_window_command("git")
        .args(["worktree", "prune"])
        .output();
    Ok(())
}

#[tauri::command]
fn git_merge_branch(repo_dir: String, branch_name: String) -> Result<String, String> {
    reject_option_like(&branch_name, "branch name")?;
    // First, make sure we're on the main branch (or whatever was current before worktrees)
    // Get current branch
    let current = common::no_window_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    let current_branch = String::from_utf8_lossy(&current.stdout).trim().to_string();

    // Keep files on disk, but normalize the merge target index first. `git add -N`
    // or stale staged entries can make `git stash` fail with "not uptodate" before
    // the broker even reaches the merge. Broker worktrees under .octo-tmp are never
    // part of the merge target; user changes outside it are stashed below.
    let _ = common::no_window_command("git")
        .args(["reset", "-q", "--", ".octo-tmp"])
        .current_dir(&repo_dir)
        .output();
    let _ = common::no_window_command("git")
        .args(["reset", "-q", "--", ".", ":(exclude).octo-tmp/**"])
        .current_dir(&repo_dir)
        .output();

    let status = common::no_window_command("git")
        .args(["status", "--porcelain", "--", ".", ":(exclude).octo-tmp/**"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;
    let dirty = !String::from_utf8_lossy(&status.stdout).trim().is_empty();
    let mut auto_stashed = false;
    if dirty {
        let stash_message = format!("octo-broker-auto-merge-{branch_name}");
        // Stash the target's TRACKED local changes (staged + modified) so the merge has a
        // clean index/worktree, then restore them after. Deliberately NOT `-u`: with the
        // broker's gitignored `.octo-tmp` worktrees ALWAYS present, `git stash -u` aborts on
        // that ignored dir ("paths are ignored ... Use -f") AND leaves a phantom stash entry
        // behind — exactly the failure that blocked auto-merge. Untracked target files are
        // harmless to a merge unless it would overwrite one, and that surfaces below as a
        // clean, abortable merge error rather than a corrupt tree. The :(exclude).octo-tmp
        // pathspecs are belt-and-suspenders (nothing under the ignored dir is tracked anyway),
        // and advice.addIgnoredFile=false keeps the hint out of stderr.
        let stash = common::no_window_command("git")
            .args([
                "-c", "advice.addIgnoredFile=false",
                "stash", "push", "-m", &stash_message,
                "--", ".", ":(exclude).octo-tmp", ":(exclude).octo-tmp/**",
            ])
            .current_dir(&repo_dir)
            .output()
            .map_err(|e| format!("git stash before merge failed: {e}"))?;
        if !stash.status.success() {
            let stderr = String::from_utf8_lossy(&stash.stderr);
            return Err(format!(
                "merge preflight failed: target checkout has local changes and auto-stash failed: {stderr}"
            ));
        }
        // A stash can exit 0 having saved nothing ("No local changes to save" when only
        // untracked files were dirty). Only remember to restore when an entry was actually
        // created, so we never pop an unrelated stash.
        auto_stashed = !String::from_utf8_lossy(&stash.stdout).contains("No local changes to save");
    }

    // Merge the branch
    let output = common::no_window_command("git")
        .args(["merge", &branch_name, "--no-edit"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git merge failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        let mut restore_note = String::new();
        if auto_stashed {
            let pop = common::no_window_command("git")
                .args(["stash", "pop"])
                .current_dir(&repo_dir)
                .output()
                .map_err(|e| format!("git stash restore after merge failed: {e}"))?;
            if pop.status.success() {
                restore_note = " (target local changes restored)".to_string();
            } else {
                let stderr = String::from_utf8_lossy(&pop.stderr);
                restore_note = format!(" (merged, but target local changes remain stashed: {stderr})");
            }
        }
        return Ok(format!(
            "{branch_name} -> {current_branch}: {}{}",
            stdout.lines().last().unwrap_or("merged"),
            restore_note
        ));
    }

    let conflicts = common::no_window_command("git")
        .args(["diff", "--name-only", "--diff-filter=U"])
        .current_dir(&repo_dir)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    if auto_stashed {
        let _ = common::no_window_command("git")
            .args(["merge", "--abort"])
            .current_dir(&repo_dir)
            .output();
        let _ = common::no_window_command("git")
            .args(["stash", "pop"])
            .current_dir(&repo_dir)
            .output();
    }

    let _ = common::no_window_command("git")
        .args(["merge", "--abort"])
        .current_dir(&repo_dir)
        .output();
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let conflict_note = if conflicts.is_empty() {
        String::new()
    } else {
        format!("conflicting files:\n{conflicts}")
    };
    Err(format!(
        "merge conflict: {}{}{}",
        detail,
        if !detail.is_empty() && !conflict_note.is_empty() { "\n" } else { "" },
        conflict_note
    ))
}

#[tauri::command]
fn git_delete_branch(repo_dir: String, branch_name: String) -> Result<(), String> {
    reject_option_like(&branch_name, "branch name")?;
    let output = common::no_window_command("git")
        .args(["branch", "-D", &branch_name])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git branch -D failed: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git branch delete error: {stderr}"))
    }
}

// Check if a directory is a git repository
#[tauri::command]
fn git_is_repo(repo_dir: String) -> bool {
    common::no_window_command("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&repo_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Initialize a git repository and create an initial commit (needed for worktrees)
#[tauri::command]
fn git_init_repo(dir: String) -> Result<String, String> {
    // git init
    let init = common::no_window_command("git")
        .args(["init"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("git init failed: {e}"))?;
    if !init.status.success() {
        let stderr = String::from_utf8_lossy(&init.stderr);
        return Err(format!("git init failed: {stderr}"));
    }

    // git add -A
    let add = common::no_window_command("git")
        .args(["add", "-A"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr);
        return Err(format!("git add failed: {stderr}"));
    }

    // git commit (allow empty if no files)
    let commit = common::no_window_command("git")
        .args([
            "commit",
            "--allow-empty",
            "-m",
            "initial commit (octo-orchestra)",
        ])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&commit.stdout).to_string())
}

// Check if there are uncommitted changes (staged or unstaged)
#[tauri::command]
fn git_has_uncommitted(repo_dir: String) -> Result<bool, String> {
    let output = common::no_window_command("git")
        .args(["status", "--porcelain"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(!stdout.trim().is_empty())
}

// Auto-stash uncommitted changes
#[tauri::command]
fn git_stash_save(repo_dir: String, message: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["stash", "push", "-m", &message])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git stash save failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git stash save error: {stderr}"))
    }
}

// Pop the latest stash
#[tauri::command]
fn git_stash_pop(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["stash", "pop"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git stash pop failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        Ok(stdout.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git stash pop error: {stderr}"))
    }
}

// Get current branch name
#[tauri::command]
fn git_current_branch(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git current branch error: {stderr}"))
    }
}

// Count how many commits `branch` is ahead of `base`
#[tauri::command]
fn git_branch_ahead_count(repo_dir: String, branch: String, base: String) -> Result<u32, String> {
    reject_option_like(&branch, "branch")?;
    reject_option_like(&base, "base")?;
    let range = format!("{}..{}", base, branch);
    let output = common::no_window_command("git")
        .args(["rev-list", "--count", &range])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git rev-list failed: {e}"))?;
    if output.status.success() {
        let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
        count_str
            .parse::<u32>()
            .map_err(|e| format!("parse error: {e}"))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git ahead count error: {stderr}"))
    }
}

// Clean up stale orchestra worktrees from /tmp/octo-orch-*
#[tauri::command]
fn git_cleanup_orch_worktrees(repo_dir: String) -> Result<u32, String> {
    let mut cleaned = 0u32;
    // List existing worktrees
    let output = common::no_window_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree list failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if path.contains("/octo-orch-") {
                // Remove stale worktree
                let _ = common::no_window_command("git")
                    .args(["worktree", "remove", "--force", path])
                    .current_dir(&repo_dir)
                    .output();
                let _ = std::fs::remove_dir_all(path);
                cleaned += 1;
            }
        }
    }
    // Prune stale worktree references
    let _ = common::no_window_command("git")
        .args(["worktree", "prune"])
        .current_dir(&repo_dir)
        .output();
    Ok(cleaned)
}

// Sweep stale broker harness worktrees (.octo-tmp/broker-wt-* and broker-rev-*) that are
// NOT in `keep_dirs` (the worktree dirs of currently-active harnesses). Active harness
// worktrees are preserved so an in-progress or resumable session is never destroyed.
// On Windows a worktree whose shell is still CWD'd there is file-locked, so `git worktree
// remove --force` fails for it — a second built-in safety net beyond keep_dirs.
#[tauri::command]
fn git_cleanup_broker_worktrees(repo_dir: String, keep_dirs: Vec<String>) -> Result<u32, String> {
    fn norm(p: &str) -> String {
        p.replace('\\', "/").trim_end_matches('/').to_lowercase()
    }
    let keep: std::collections::HashSet<String> = keep_dirs.iter().map(|p| norm(p)).collect();
    let mut cleaned = 0u32;
    let output = common::no_window_command("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git worktree list failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            let is_broker = path.contains("broker-wt-") || path.contains("broker-rev-");
            if is_broker && !keep.contains(&norm(path)) {
                let _ = common::no_window_command("git")
                    .args(["worktree", "remove", "--force", path])
                    .current_dir(&repo_dir)
                    .output();
                // Only count + best-effort rmdir if the worktree dir is actually gone
                // (a live, file-locked active worktree survives the --force on Windows).
                if !std::path::Path::new(path).exists() {
                    cleaned += 1;
                } else {
                    let _ = std::fs::remove_dir_all(path);
                    if !std::path::Path::new(path).exists() {
                        cleaned += 1;
                    }
                }
            }
        }
    }
    let _ = common::no_window_command("git")
        .args(["worktree", "prune"])
        .current_dir(&repo_dir)
        .output();
    Ok(cleaned)
}

fn normalize_process_match_text(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

fn command_looks_like_project_dev_server(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    (command.contains("wrangler") && command.contains(" dev"))
        || (command.contains("vite") && command.contains("dev"))
        || command.contains("vite-dev.mjs")
        || command.contains("npm") && (command.contains(" run dev") || command.contains(" run dev:"))
        || command.contains("pnpm") && (command.contains(" dev") || command.contains(" run dev"))
        || command.contains("yarn") && command.contains(" dev")
        || command.contains("bun") && command.contains(" dev")
}

#[tauri::command]
fn cleanup_project_dev_processes(repo_dir: String) -> Result<u32, String> {
    let repo = normalize_process_match_text(&repo_dir);
    if repo.is_empty() {
        return Ok(0);
    }
    let self_pid = Pid::from_u32(std::process::id());
    let mut victims: Vec<u32> = Vec::new();
    {
        let mut sys = sysinfo_system().lock().unwrap();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        for (pid, process) in sys.processes() {
            if *pid == self_pid {
                continue;
            }
            let command = process
                .cmd()
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join(" ");
            if !command_looks_like_project_dev_server(&command) {
                continue;
            }
            let command_match = normalize_process_match_text(&command).contains(&repo);
            let cwd_match = process
                .cwd()
                .map(|cwd| {
                    let cwd = normalize_process_match_text(&cwd.to_string_lossy());
                    cwd == repo || cwd.starts_with(&format!("{repo}/"))
                })
                .unwrap_or(false);
            if command_match || cwd_match {
                victims.push(pid.as_u32());
            }
        }
    }
    victims.sort_unstable();
    victims.dedup();
    let mut killed = 0u32;
    for pid in victims {
        kill_process_tree(pid);
        killed += 1;
    }
    Ok(killed)
}

// --- Claude Project Scaffold ---

#[tauri::command]
fn claude_scaffold(project_dir: String, project_name: Option<String>) -> Result<String, String> {
    let base = std::path::Path::new(&project_dir);
    if !base.exists() {
        return Err(format!("Project directory not found: {}", project_dir));
    }

    let name = project_name.unwrap_or_else(|| {
        base.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "my-project".to_string())
    });

    let mut created = Vec::new();

    // Helper to write file if not exists
    let write_if_new =
        |path: &std::path::Path, content: &str, created: &mut Vec<String>| -> Result<(), String> {
            if !path.exists() {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
                }
                std::fs::write(path, content).map_err(|e| format!("write failed: {}", e))?;
                created.push(
                    path.strip_prefix(base)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string(),
                );
            }
            Ok(())
        };

    // ── CLAUDE.md (team instructions, committed) ──
    let claude_md = format!("# {}\n\n## Project Overview\n<!-- Describe what this project does -->\n\n## Tech Stack\n| Layer | Technology |\n|-------|------------|\n| Language | |\n| Framework | |\n| Database | |\n| Testing | |\n\n## Project Structure\n```\n{}/\n├── src/          # Source code\n├── tests/        # Test files\n└── docs/         # Documentation\n```\n\n## Development\n```bash\n# Install dependencies\n# Start development server\n# Run tests\n# Build for production\n```\n\n## Code Conventions\n- Follow existing patterns in the codebase\n- Write tests for new features\n- Keep functions small and focused\n- Use descriptive variable and function names\n\n## Important Notes\n- Do not modify generated files directly\n- Always run tests before committing\n", name, name);
    write_if_new(&base.join("CLAUDE.md"), &claude_md, &mut created)?;

    // ── CLAUDE.local.md (personal overrides, gitignored) ──
    write_if_new(&base.join("CLAUDE.local.md"),
      "# Local Overrides\n\n<!-- Personal preferences that override CLAUDE.md (gitignored) -->\n\n## My Preferences\n- Respond in Korean unless code/technical terms\n- Be concise, skip unnecessary explanations\n",
      &mut created)?;

    // ── .claude/settings.json (permissions + config, committed) ──
    write_if_new(
        &base.join(".claude/settings.json"),
        "{\n\
  \"permissions\": {\n\
    \"allow\": [\n\
      \"Bash(npm run *)\",\n\
      \"Bash(npx *)\",\n\
      \"Bash(git status)\",\n\
      \"Bash(git diff *)\",\n\
      \"Bash(git log *)\",\n\
      \"Bash(git add *)\",\n\
      \"Bash(git commit *)\",\n\
      \"Read\",\n\
      \"Edit\",\n\
      \"Write\",\n\
      \"Glob\",\n\
      \"Grep\",\n\
      \"WebFetch\",\n\
      \"WebSearch\"\n\
    ],\n\
    \"deny\": [\n\
      \"Bash(rm -rf *)\",\n\
      \"Bash(git push --force*)\",\n\
      \"Bash(git reset --hard*)\"\n\
    ]\n\
  }\n\
}\n",
        &mut created,
    )?;

    // ── .claude/settings.local.json (personal, gitignored) ──
    write_if_new(
        &base.join(".claude/settings.local.json"),
        "{\n\
  \"permissions\": {\n\
    \"allow\": [\n\
      \"Bash(git push *)\"\n\
    ]\n\
  }\n\
}\n",
        &mut created,
    )?;

    // ── .claude/commands/ (custom slash commands → /project:xxx) ──
    write_if_new(
        &base.join(".claude/commands/review.md"),
        "Review the current PR/branch changes with `git diff main...HEAD`.\n\n\
Focus areas:\n\
1. **Bugs**: Logic errors, edge cases, null checks\n\
2. **Security**: Injection, auth issues, data exposure\n\
3. **Performance**: N+1 queries, unnecessary re-renders, memory leaks\n\
4. **Style**: Naming, structure, consistency with existing code\n\n\
Be specific — cite file:line for each issue. Suggest fixes.\n",
        &mut created,
    )?;

    write_if_new(
        &base.join(".claude/commands/fix-issue.md"),
        "Fix the issue: $ARGUMENTS\n\n\
Steps:\n\
1. Read the issue carefully and understand the expected vs actual behavior\n\
2. Search the codebase to find the root cause\n\
3. Implement the minimal fix that solves the problem\n\
4. Verify the fix doesn't break existing tests\n\
5. Write a test that would have caught this bug\n",
        &mut created,
    )?;

    write_if_new(
        &base.join(".claude/commands/deploy.md"),
        "Prepare deployment checklist and execute:\n\n\
- [ ] All tests pass (`npm test`)\n\
- [ ] No TypeScript errors (`npx tsc --noEmit`)\n\
- [ ] No linting errors (`npm run lint`)\n\
- [ ] Version bumped in package.json\n\
- [ ] CHANGELOG updated\n\
- [ ] Build succeeds (`npm run build`)\n\
- [ ] Git working tree is clean\n\n\
After verification, commit and tag the release.\n",
        &mut created,
    )?;

    // ── .claude/rules/ (modular instruction files, always loaded) ──
    write_if_new(
        &base.join(".claude/rules/code-style.md"),
        "# Code Style\n\n\
- Match existing codebase patterns — don't introduce new conventions\n\
- Prefer explicit over clever code\n\
- Functions should do one thing and do it well\n\
- Name variables/functions by what they represent, not how they work\n\
- Only add comments for \"why\", not \"what\"\n\
- Don't add docstrings, type annotations, or error handling beyond what's asked\n\
- Three similar lines of code is better than a premature abstraction\n",
        &mut created,
    )?;

    write_if_new(
        &base.join(".claude/rules/testing.md"),
        "# Testing\n\n\
- Write tests for new features and bug fixes\n\
- Test behavior, not implementation details\n\
- Use descriptive test names: `should_reject_invalid_email_format`\n\
- Test edge cases: empty input, null, boundary values, concurrent access\n\
- Mock external services, not internal code\n\
- Each test should be independent and idempotent\n",
        &mut created,
    )?;

    write_if_new(
        &base.join(".claude/rules/api-conventions.md"),
        "# API Conventions\n\n\
- RESTful resource naming: plural nouns (`/users`, `/posts`)\n\
- Consistent error response: `{ \"error\": { \"code\": \"...\", \"message\": \"...\" } }`\n\
- Validate all external input at system boundaries\n\
- Use appropriate HTTP status codes (400 vs 422 vs 500)\n\
- Paginate list endpoints: `?page=1&limit=20`\n\
- Version APIs when breaking changes are needed\n",
        &mut created,
    )?;

    // ── .claude/skills/ (auto-invoked workflows) ──
    write_if_new(&base.join(".claude/skills/security-review/SKILL.md"),
"---\n\
description: Perform a comprehensive security audit of the codebase\n\
---\n\n\
Audit this codebase for security vulnerabilities:\n\n\
1. **OWASP Top 10**: Check for SQL injection, XSS, CSRF, broken auth, etc.\n\
2. **Dependencies**: Check for known CVEs in dependencies\n\
3. **Secrets**: Scan for hardcoded API keys, tokens, passwords\n\
4. **Auth/Authz**: Review authentication and authorization logic\n\
5. **Data exposure**: Check for sensitive data in logs, errors, responses\n\n\
For each finding, report: severity (critical/high/medium/low), location (file:line), description, and remediation.\n", &mut created)?;

    write_if_new(
        &base.join(".claude/skills/deploy/SKILL.md"),
        "---\n\
description: Automated deployment pipeline\n\
---\n\n\
Execute the deployment pipeline:\n\n\
1. Run the full test suite and ensure all tests pass\n\
2. Run linting and type checking\n\
3. Build the production bundle\n\
4. Create a git tag for the release version\n\
5. Report the deployment status\n\n\
Stop immediately if any step fails. Do not skip failing tests.\n",
        &mut created,
    )?;

    // ── .claude/agents/ (subagent personas) ──
    write_if_new(
        &base.join(".claude/agents/code-reviewer.md"),
        "---\n\
name: Code Reviewer\n\
description: Senior engineer who reviews code for quality, security, and best practices\n\
---\n\n\
You are a senior code reviewer with 10+ years of experience.\n\n\
Review guidelines:\n\
- Focus on correctness first, style second\n\
- Check for edge cases and error handling\n\
- Look for security vulnerabilities (OWASP Top 10)\n\
- Suggest performance improvements when obvious\n\
- Be constructive — explain *why* something should change\n\
- Approve if the code is good enough, don't nitpick\n",
        &mut created,
    )?;

    write_if_new(
        &base.join(".claude/agents/security-auditor.md"),
        "---\n\
name: Security Auditor\n\
description: Security specialist who audits code for vulnerabilities\n\
---\n\n\
You are a security auditor specializing in application security.\n\n\
Audit checklist:\n\
- Input validation and sanitization\n\
- Authentication and session management\n\
- Authorization and access control\n\
- Cryptographic practices\n\
- Error handling and information leakage\n\
- Dependency vulnerabilities (check lockfiles)\n\
- Sensitive data storage and transmission\n\n\
Rate each finding: Critical / High / Medium / Low / Informational\n",
        &mut created,
    )?;

    // .gitignore append
    let gitignore_path = base.join(".gitignore");
    let gitignore_entries =
        "\n# Claude Code local files\nCLAUDE.local.md\n.claude/settings.local.json\n";
    if gitignore_path.exists() {
        let content = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
        if !content.contains("CLAUDE.local.md") {
            std::fs::write(&gitignore_path, format!("{}{}", content, gitignore_entries))
                .map_err(|e| format!("gitignore update failed: {}", e))?;
            created.push(".gitignore (updated)".to_string());
        }
    } else {
        std::fs::write(&gitignore_path, gitignore_entries.trim_start())
            .map_err(|e| format!("gitignore create failed: {}", e))?;
        created.push(".gitignore".to_string());
    }

    if created.is_empty() {
        Ok("All Claude project files already exist.".to_string())
    } else {
        Ok(format!(
            "Created {} files:\n{}",
            created.len(),
            created.join("\n")
        ))
    }
}

// --- Git Panel commands ---

#[tauri::command]
fn git_status_full(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["status", "--porcelain=v2", "--branch"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git status failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_add(repo_dir: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git add failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_restore(repo_dir: String, paths: Vec<String>, staged: bool) -> Result<(), String> {
    let mut args = vec!["restore".to_string()];
    if staged {
        args.push("--staged".to_string());
    }
    args.push("--".to_string());
    args.extend(paths);
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git restore failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_commit_changes(repo_dir: String, message: String, amend: bool) -> Result<String, String> {
    let mut args = vec!["commit".to_string(), "-m".to_string(), message];
    if amend {
        args.push("--amend".to_string());
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git commit failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_diff(
    repo_dir: String,
    path: Option<String>,
    staged: bool,
    commit: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["diff".to_string()];
    if let Some(ref c) = commit {
        reject_option_like(c, "commit")?;
        args.push(format!("{c}^..{c}"));
    } else if staged {
        args.push("--cached".to_string());
    }
    if let Some(ref p) = path {
        args.push("--".to_string());
        args.push(p.clone());
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_diff_stat(repo_dir: String, commit: Option<String>) -> Result<String, String> {
    let mut args = vec!["diff".to_string(), "--stat".to_string()];
    if let Some(ref c) = commit {
        reject_option_like(c, "commit")?;
        args.clear();
        args.extend([
            "diff".to_string(),
            "--stat".to_string(),
            format!("{c}^..{c}"),
        ]);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git diff --stat failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_log(
    repo_dir: String,
    max_count: Option<u32>,
    skip: Option<u32>,
    path: Option<String>,
    author: Option<String>,
    grep: Option<String>,
) -> Result<String, String> {
    let mut args = vec![
        "log".to_string(),
        "--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b%n---GIT_LOG_SEP---".to_string(),
        "--all".to_string(),
    ];
    args.push(format!("-n{}", max_count.unwrap_or(50)));
    if let Some(s) = skip {
        args.push(format!("--skip={s}"));
    }
    if let Some(ref a) = author {
        args.push(format!("--author={a}"));
    }
    if let Some(ref g) = grep {
        args.push(format!("--grep={g}"));
    }
    if let Some(ref p) = path {
        args.push("--".to_string());
        args.push(p.clone());
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git log failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_show(repo_dir: String, commit: String) -> Result<String, String> {
    reject_option_like(&commit, "commit")?;
    let output = common::no_window_command("git")
        .args([
            "show",
            "--stat",
            &format!("--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b%n---GIT_SHOW_BODY---"),
            &commit,
        ])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git show failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_branch_list(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args([
            "branch",
            "-a",
            "--format=%(refname:short)\t%(objectname:short)\t%(upstream:short)\t%(HEAD)",
        ])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git branch list failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_branch_create(
    repo_dir: String,
    name: String,
    start_point: Option<String>,
) -> Result<String, String> {
    reject_option_like(&name, "branch name")?;
    let mut args = vec!["checkout".to_string(), "-b".to_string(), name];
    if let Some(sp) = start_point {
        reject_option_like(&sp, "start point")?;
        args.push(sp);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git branch create failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).to_string()) // git checkout -b outputs to stderr
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_checkout(repo_dir: String, target: String) -> Result<String, String> {
    // `git checkout -` (previous branch) is the one legitimate dash target.
    if target.trim() != "-" {
        reject_option_like(&target, "checkout target")?;
    }
    let output = common::no_window_command("git")
        .args(["checkout", &target])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git checkout failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_fetch(repo_dir: String, remote: Option<String>, prune: bool) -> Result<String, String> {
    let mut args = vec!["fetch".to_string()];
    if prune {
        args.push("--prune".to_string());
    }
    if let Some(r) = remote {
        reject_option_like(&r, "remote")?;
        args.push(r);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git fetch failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).to_string()) // fetch outputs to stderr
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_pull(
    repo_dir: String,
    remote: Option<String>,
    branch: Option<String>,
    rebase: bool,
) -> Result<String, String> {
    let mut args = vec!["pull".to_string()];
    if rebase {
        args.push("--rebase".to_string());
    }
    if let Some(r) = remote {
        reject_option_like(&r, "remote")?;
        args.push(r);
    }
    if let Some(b) = branch {
        reject_option_like(&b, "branch")?;
        args.push(b);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git pull failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_push(
    repo_dir: String,
    remote: Option<String>,
    branch: Option<String>,
    force: bool,
    set_upstream: bool,
) -> Result<String, String> {
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
    }
    if set_upstream {
        args.push("-u".to_string());
    }
    if let Some(r) = remote {
        reject_option_like(&r, "remote")?;
        args.push(r);
    }
    if let Some(b) = branch {
        reject_option_like(&b, "branch")?;
        args.push(b);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git push failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_remote_list(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["remote", "-v"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git remote list failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_stash_list(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["stash", "list", "--format=%gd\t%s\t%aI"])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git stash list failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_stash_drop(repo_dir: String, stash_ref: Option<String>) -> Result<String, String> {
    let mut args = vec!["stash".to_string(), "drop".to_string()];
    if let Some(r) = stash_ref {
        reject_option_like(&r, "stash ref")?;
        args.push(r);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git stash drop failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_tag_list(repo_dir: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args([
            "tag",
            "-l",
            "--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso)\t%(subject)",
        ])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git tag list failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_tag_create(
    repo_dir: String,
    name: String,
    message: Option<String>,
    commit: Option<String>,
) -> Result<String, String> {
    reject_option_like(&name, "tag name")?;
    if let Some(ref c) = commit {
        reject_option_like(c, "commit")?;
    }
    let mut args = vec!["tag".to_string()];
    if let Some(ref m) = message {
        args.push("-a".to_string());
        args.push(name);
        args.push("-m".to_string());
        args.push(m.clone());
    } else {
        args.push(name);
    }
    if let Some(c) = commit {
        args.push(c);
    }
    let output = common::no_window_command("git")
        .args(&args)
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git tag create failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_tag_delete(repo_dir: String, name: String) -> Result<(), String> {
    reject_option_like(&name, "tag name")?;
    let output = common::no_window_command("git")
        .args(["tag", "-d", &name])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git tag delete failed: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_blame(repo_dir: String, path: String) -> Result<String, String> {
    let output = common::no_window_command("git")
        .args(["blame", "--porcelain", "--", &path])
        .current_dir(&repo_dir)
        .output()
        .map_err(|e| format!("git blame failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn git_clone(url: String, dest: String) -> Result<String, String> {
    reject_option_like(&url, "clone URL")?;
    reject_option_like(&dest, "clone destination")?;
    let output = common::no_window_command("git")
        .args(["clone", "--", &url, &dest])
        .output()
        .map_err(|e| format!("git clone failed: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stderr).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// Internal browser commands. The command names keep the old `cef_*` API for
// BrowserPage compatibility, but the backend is now a Tauri child webview.

async fn webview_on_main<R: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(AppHandle) -> Result<R, String> + Send + 'static,
) -> Result<R, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let app_for_thread = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(app_for_thread));
    })
    .map_err(|e| format!("Failed to dispatch browser command to main thread: {e}"))?;
    rx.await
        .map_err(|e| format!("Browser command channel error: {e}"))?
}

#[tauri::command]
fn cef_available() -> bool {
    true
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_open(
    app: AppHandle,
    window_label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<u32, String> {
    webview_on_main(app, move |app| webview_browser::open(&app, &window_label, &url, x, y, w, h)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_set_bounds(
    app: AppHandle,
    window_label: String,
    id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::set_bounds(&app, id, x, y, w, h)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_navigate(app: AppHandle, id: u32, url: String) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::navigate(&app, id, &url)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_nav_action(app: AppHandle, id: u32, action: String) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::nav_action(&app, id, &action)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_set_visible(app: AppHandle, id: u32, visible: bool) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::set_visible(&app, id, visible)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_zoom(app: AppHandle, id: u32, action: String) -> Result<f64, String> {
    webview_on_main(app, move |app| webview_browser::zoom(&app, id, &action)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_find(app: AppHandle, id: u32, query: String, forward: bool, find_next: bool) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::find(&app, id, &query, forward, find_next)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_eval(app: AppHandle, id: u32, script: String) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::eval(&app, id, &script)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_set_download_dir(dir: String) -> Result<(), String> {
    webview_browser::set_download_dir(dir);
    Ok(())
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_devtools(
    app: AppHandle,
    window_label: String,
    id: u32,
    show: bool,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::devtools(&app, id, show)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_close(app: AppHandle, id: u32) -> Result<(), String> {
    webview_on_main(app, move |app| webview_browser::close(&app, id)).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_list(app: AppHandle) -> Result<Vec<(u32, String, String)>, String> {
    webview_on_main(app, move |app| Ok(webview_browser::list(&app))).await
}

#[allow(unused_variables)]
#[tauri::command]
async fn cef_set_cookies(
    app: AppHandle,
    id: u32,
    cookies: Vec<webview_browser::ImportCookie>,
) -> Result<(u32, u32), String> {
    webview_on_main(app, move |app| webview_browser::set_cookies(&app, id, cookies)).await
}

// ---------- SurrealDB-backed Scrum/Orchestra commands ----------

#[tauri::command]
async fn db_scrum_save_history(
    project_id: String,
    project_name: String,
    sprint_goal: String,
    mode: String,
    plan_json: Option<String>,
    run_log: Option<String>,
) -> Result<String, String> {
    let db = db::get_db()?;
    let created_at = db::now_iso8601();
    let result: Option<serde_json::Value> = db
        .create("scrum_history")
        .content(serde_json::json!({
            "project_id": project_id,
            "project_name": project_name,
            "sprint_goal": sprint_goal,
            "mode": mode,
            "created_at": created_at,
            "plan_json": plan_json,
            "run_log": run_log,
        }))
        .await
        .map_err(|e| format!("DB insert failed: {e}"))?;
    Ok(serde_json::to_string(&result).unwrap_or_default())
}

#[tauri::command]
async fn db_scrum_list_history(project_id: String) -> Result<Vec<serde_json::Value>, String> {
    let db = db::get_db()?;
    let mut result = db
        .query(
            "SELECT * FROM scrum_history WHERE project_id = $pid ORDER BY created_at DESC LIMIT 20",
        )
        .bind(("pid", project_id))
        .await
        .map_err(|e| format!("DB query failed: {e}"))?;
    let rows: Vec<serde_json::Value> =
        result.take(0).map_err(|e| format!("DB take failed: {e}"))?;
    Ok(rows)
}

#[tauri::command]
async fn db_scrum_save_state(project_id: String, state_json: String) -> Result<(), String> {
    let db = db::get_db()?;
    let updated_at = db::now_iso8601();
    // Upsert: delete existing + insert
    db.query("DELETE scrum_state WHERE project_id = $pid")
        .bind(("pid", project_id.clone()))
        .await
        .map_err(|e| format!("DB delete failed: {e}"))?;
    let _: Option<serde_json::Value> = db
        .create("scrum_state")
        .content(serde_json::json!({
            "project_id": project_id,
            "state_json": state_json,
            "updated_at": updated_at,
        }))
        .await
        .map_err(|e| format!("DB insert failed: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn db_scrum_load_state(project_id: String) -> Result<Option<String>, String> {
    let db = db::get_db()?;
    let mut result = db
        .query("SELECT state_json FROM scrum_state WHERE project_id = $pid LIMIT 1")
        .bind(("pid", project_id))
        .await
        .map_err(|e| format!("DB query failed: {e}"))?;
    let rows: Vec<serde_json::Value> =
        result.take(0).map_err(|e| format!("DB take failed: {e}"))?;
    if let Some(row) = rows.first() {
        Ok(row
            .get("state_json")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn db_save_session(
    convoy_id: Option<String>,
    phase: String,
    squid_setups: String,
) -> Result<(), String> {
    let db = db::get_db()?;
    let started_at = db::now_iso8601();
    // Clear previous sessions
    db.query("DELETE session")
        .await
        .map_err(|e| format!("DB delete failed: {e}"))?;
    let _: Option<serde_json::Value> = db
        .create("session")
        .content(serde_json::json!({
            "convoy_id": convoy_id,
            "phase": phase,
            "squid_setups": squid_setups,
            "started_at": started_at,
        }))
        .await
        .map_err(|e| format!("DB insert failed: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn db_load_session() -> Result<Option<serde_json::Value>, String> {
    let db = db::get_db()?;
    let mut result = db
        .query("SELECT * FROM session ORDER BY started_at DESC LIMIT 1")
        .await
        .map_err(|e| format!("DB query failed: {e}"))?;
    let rows: Vec<serde_json::Value> =
        result.take(0).map_err(|e| format!("DB take failed: {e}"))?;
    Ok(rows.into_iter().next())
}

#[tauri::command]
async fn db_skills_bootstrap(
    default_skills: Vec<skills_db::SkillPayload>,
    gallery_skills: Vec<skills_db::SkillPayload>,
    gallery_seed: String,
) -> Result<skills_db::SkillBootstrapResult, String> {
    skills_db::bootstrap(default_skills, gallery_skills, gallery_seed).await
}

#[tauri::command]
async fn db_skills_list_my() -> Result<Vec<skills_db::SkillPayload>, String> {
    skills_db::list_my().await
}

#[tauri::command]
async fn db_skills_list_gallery() -> Result<Vec<skills_db::SkillPayload>, String> {
    skills_db::list_gallery().await
}

#[tauri::command]
async fn db_skills_set_my(skills: Vec<skills_db::SkillPayload>) -> Result<usize, String> {
    skills_db::set_my(skills).await
}

#[tauri::command]
async fn db_skills_upsert_my(
    skill: skills_db::SkillPayload,
) -> Result<skills_db::SkillPayload, String> {
    skills_db::upsert_my(skill).await
}

#[tauri::command]
async fn db_skills_delete_my(skill_id: String) -> Result<bool, String> {
    skills_db::delete_my(skill_id).await
}

#[tauri::command]
async fn db_skills_stats() -> Result<skills_db::SkillDbStats, String> {
    skills_db::stats().await
}

#[tauri::command]
async fn db_skills_list_packs() -> Result<Vec<skills_db::SkillPackMeta>, String> {
    skills_db::list_packs().await
}

#[tauri::command]
async fn db_skills_install_pack(
    pack_name: String,
    pack_version: String,
    source_url: Option<String>,
    checksum_sha256: Option<String>,
    skills: Vec<skills_db::SkillPayload>,
    replace_existing: Option<bool>,
) -> Result<skills_db::SkillPackInstallResult, String> {
    skills_db::install_pack(
        pack_name,
        pack_version,
        source_url,
        checksum_sha256,
        skills,
        replace_existing,
    )
    .await
}

#[tauri::command]
async fn db_skills_remove_pack(
    pack_name: String,
) -> Result<skills_db::SkillPackRemoveResult, String> {
    skills_db::remove_pack(pack_name).await
}

#[tauri::command]
async fn db_learning_upsert_session(
    entry: learning_db::LearningSessionPayload,
) -> Result<(), String> {
    learning_db::upsert_session(entry).await
}

#[tauri::command]
async fn db_learning_list_sessions(
    work_dir: String,
) -> Result<Vec<learning_db::LearningSessionPayload>, String> {
    learning_db::list_sessions(work_dir).await
}

#[tauri::command]
async fn db_learning_search_sessions(
    params: learning_db::LearningSessionSearchParams,
) -> Result<Vec<learning_db::LearningSessionPayload>, String> {
    learning_db::search_sessions(params).await
}

#[tauri::command]
async fn db_learning_list_skills(
    work_dir: String,
) -> Result<Vec<learning_db::LearningSkillPayload>, String> {
    learning_db::list_skills(work_dir).await
}

#[tauri::command]
async fn db_learning_search_skills(
    params: learning_db::LearningSkillSearchParams,
) -> Result<Vec<learning_db::LearningSkillPayload>, String> {
    learning_db::search_skills(params).await
}

#[tauri::command]
async fn db_learning_list_memories(
    work_dir: String,
) -> Result<Vec<learning_db::LearningMemoryPayload>, String> {
    learning_db::list_memories(work_dir).await
}

#[tauri::command]
async fn db_learning_search_memories(
    params: learning_db::LearningMemorySearchParams,
) -> Result<Vec<learning_db::LearningMemoryPayload>, String> {
    learning_db::search_memories(params).await
}

#[tauri::command]
async fn db_learning_search_all(
    params: learning_db::LearningUnifiedSearchParams,
) -> Result<learning_db::LearningUnifiedSearchResult, String> {
    learning_db::search_all(params).await
}

#[tauri::command]
async fn db_learning_upsert_skills(
    skills: Vec<learning_db::LearningSkillPayload>,
) -> Result<Vec<learning_db::LearningSkillPayload>, String> {
    learning_db::upsert_skills(skills).await
}

#[tauri::command]
async fn db_learning_upsert_memories(
    memories: Vec<learning_db::LearningMemoryPayload>,
) -> Result<Vec<learning_db::LearningMemoryPayload>, String> {
    learning_db::upsert_memories(memories).await
}

#[tauri::command]
async fn db_learning_append_trajectory(
    entry: learning_db::LearningTrajectoryPayload,
) -> Result<(), String> {
    learning_db::append_trajectory(entry).await
}

#[tauri::command]
async fn db_learning_list_trajectories(
    work_dir: String,
) -> Result<Vec<learning_db::LearningTrajectoryPayload>, String> {
    learning_db::list_trajectories(work_dir).await
}

#[tauri::command]
async fn db_learning_search_trajectories(
    params: learning_db::LearningTrajectorySearchParams,
) -> Result<Vec<learning_db::LearningTrajectoryPayload>, String> {
    learning_db::search_trajectories(params).await
}

// ── KV Store (SurrealDB-backed localStorage replacement) ──

#[tauri::command]
async fn kv_ping() -> Result<bool, String> {
    db::get_db().map(|_| true)
}

async fn kv_ensure_schema(
) -> Result<std::sync::Arc<surrealdb::Surreal<surrealdb::engine::local::Db>>, String> {
    // D7: KV reads happen at frontend boot while SurrealDB is still opening in a
    // background task (a cold 18MB RocksDB store takes seconds). Failing fast here
    // made the frontend fall back to (already-migrated-away) localStorage, boot
    // blank, and clobber the DB on the next autosave. Wait for init instead.
    let db = db::wait_db(15_000)
        .await
        .map_err(|_| "SurrealDB not ready".to_string())?;
    db.query(
        r#"
        DEFINE TABLE IF NOT EXISTS `kv_store` SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS `key` ON `kv_store` TYPE string;
        DEFINE FIELD IF NOT EXISTS `value` ON `kv_store` TYPE string;
        DEFINE FIELD IF NOT EXISTS updated_at ON `kv_store` TYPE string;
        DEFINE INDEX IF NOT EXISTS idx_kv_key ON `kv_store` FIELDS `key` UNIQUE;
        "#,
    )
    .await
    .map_err(|e| format!("KV schema setup failed: {e}"))?;
    Ok(db)
}

#[tauri::command]
async fn kv_get(key: String) -> Result<Option<String>, String> {
    let db = kv_ensure_schema().await?;
    let mut result = db
        .query("SELECT `value` FROM `kv_store` WHERE `key` = $key LIMIT 1")
        .bind(("key", key))
        .await
        .map_err(|e| format!("KV get failed: {e}"))?;
    let rows: Vec<serde_json::Value> = result.take(0).map_err(|e| format!("KV get parse: {e}"))?;
    Ok(rows
        .into_iter()
        .next()
        .and_then(|r| r.get("value").cloned())
        .and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[tauri::command]
async fn kv_set(key: String, value: String) -> Result<(), String> {
    let db = kv_ensure_schema().await?;
    db.query("DELETE `kv_store` WHERE `key` = $key")
        .bind(("key", key.clone()))
        .await
        .map_err(|e| format!("KV set delete: {e}"))?;
    db.query("CREATE `kv_store` CONTENT { `key`: $key, `value`: $value, updated_at: time::now() }")
        .bind(("key", key))
        .bind(("value", value))
        .await
        .map_err(|e| format!("KV set insert: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn kv_delete(key: String) -> Result<bool, String> {
    let db = kv_ensure_schema().await?;
    db.query("DELETE `kv_store` WHERE `key` = $key")
        .bind(("key", key))
        .await
        .map_err(|e| format!("KV delete: {e}"))?;
    Ok(true)
}

#[tauri::command]
async fn kv_get_many(keys: Vec<String>) -> Result<HashMap<String, String>, String> {
    let db = kv_ensure_schema().await?;
    let mut out = HashMap::new();
    for key in keys {
        let mut result = db
            .query("SELECT `value` FROM `kv_store` WHERE `key` = $key LIMIT 1")
            .bind(("key", key.clone()))
            .await
            .map_err(|e| format!("KV get_many: {e}"))?;
        let rows: Vec<serde_json::Value> = result.take(0).map_err(|e| format!("KV parse: {e}"))?;
        if let Some(val) = rows
            .into_iter()
            .next()
            .and_then(|r| r.get("value").cloned())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
        {
            out.insert(key, val);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn kv_set_many(entries: HashMap<String, String>) -> Result<(), String> {
    let db = kv_ensure_schema().await?;
    for (key, value) in entries {
        db.query("DELETE `kv_store` WHERE `key` = $key")
            .bind(("key", key.clone()))
            .await
            .map_err(|e| format!("KV set_many delete: {e}"))?;
        db.query(
            "CREATE `kv_store` CONTENT { `key`: $key, `value`: $value, updated_at: time::now() }",
        )
        .bind(("key", key))
        .bind(("value", value))
        .await
        .map_err(|e| format!("KV set_many insert: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn kv_migrate_from_localstorage(entries: HashMap<String, String>) -> Result<usize, String> {
    let db = kv_ensure_schema().await?;
    let mut count = 0usize;
    for (key, value) in entries {
        // Only insert if key doesn't exist yet (don't overwrite DB data)
        let mut check = db
            .query("SELECT count() AS c FROM `kv_store` WHERE `key` = $key GROUP ALL")
            .bind(("key", key.clone()))
            .await
            .map_err(|e| format!("KV migrate check: {e}"))?;
        let rows: Vec<serde_json::Value> = check
            .take(0)
            .map_err(|e| format!("KV migrate parse: {e}"))?;
        let exists = rows
            .first()
            .and_then(|v| v.get("c"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            > 0;
        if !exists {
            db.query("CREATE `kv_store` CONTENT { `key`: $key, `value`: $value, updated_at: time::now() }")
                .bind(("key", key))
                .bind(("value", value))
                .await
                .map_err(|e| format!("KV migrate insert: {e}"))?;
            count += 1;
        }
    }
    Ok(count)
}

fn harness_sqlite_path() -> Result<std::path::PathBuf, String> {
    let home = resolve_home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;
    let dir = std::path::Path::new(&home).join(".config").join("octo");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create harness db dir: {e}"))?;
    Ok(dir.join("harness.sqlite3"))
}

fn harness_sqlite_open() -> Result<rusqlite::Connection, String> {
    let path = harness_sqlite_path()?;
    let conn =
        rusqlite::Connection::open(path).map_err(|e| format!("Harness SQLite open failed: {e}"))?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS harness_kv (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("Harness SQLite schema failed: {e}"))?;
    Ok(conn)
}

#[tauri::command]
async fn harness_db_get(key: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = harness_sqlite_open()?;
        let mut stmt = conn
            .prepare("SELECT value FROM harness_kv WHERE key = ?1 LIMIT 1")
            .map_err(|e| format!("Harness SQLite prepare failed: {e}"))?;
        let mut rows = stmt
            .query(rusqlite::params![key])
            .map_err(|e| format!("Harness SQLite query failed: {e}"))?;
        if let Some(row) = rows
            .next()
            .map_err(|e| format!("Harness SQLite row failed: {e}"))?
        {
            let value: String = row
                .get(0)
                .map_err(|e| format!("Harness SQLite value failed: {e}"))?;
            Ok(Some(value))
        } else {
            Ok(None)
        }
    })
    .await
    .map_err(|e| format!("Harness SQLite task failed: {e}"))?
}

#[tauri::command]
async fn harness_db_set(key: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let conn = harness_sqlite_open()?;
        conn.execute(
            r#"
            INSERT INTO harness_kv (key, value, updated_at)
            VALUES (?1, ?2, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
            "#,
            rusqlite::params![key, value],
        )
        .map_err(|e| format!("Harness SQLite set failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Harness SQLite task failed: {e}"))?
}

/// Load OCTO_WEB_TOKEN from ~/.config/octo/.env, or generate a random one.
fn load_or_generate_web_token() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| {
            common::no_window_command("id")
                .arg("-un")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|u| format!("/Users/{}", u.trim()))
                .ok_or(std::env::VarError::NotPresent)
        })
        .unwrap_or_else(|_| "/tmp".to_string());

    let env_path = format!("{}/.config/octo/.env", home);
    if let Ok(content) = std::fs::read_to_string(&env_path) {
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with("OCTO_WEB_TOKEN=") {
                let mut value = line["OCTO_WEB_TOKEN=".len()..].trim();
                if (value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\''))
                {
                    value = &value[1..value.len() - 1];
                }
                if !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }

    // Generate random token and append to .env
    use rand::Rng;
    let token: String = (0..32)
        .map(|_| {
            let idx = rand::thread_rng().gen_range(0..16);
            "0123456789abcdef".chars().nth(idx).unwrap()
        })
        .collect();

    let _ = std::fs::create_dir_all(format!("{}/.config/octo", home));
    let entry = format!("\nOCTO_WEB_TOKEN={}\n", token);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&env_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, entry.as_bytes()));

    safe_eprintln!("[web-terminal] Generated new token: {}", token);
    token
}

/// Redirect stderr to a log file so that `eprintln!` from any crate never
/// panics on an invalid stderr fd (common in bundled macOS .app bundles).
#[cfg(unix)]
fn redirect_stderr_to_log() {
    use std::os::unix::io::IntoRawFd;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let log_dir = format!("{}/.config/octo", home);
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = format!("{}/octo-terminal.log", log_dir);

    // Truncate log if over 1MB to prevent unbounded growth
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > 1_000_000 {
            let _ = std::fs::remove_file(&log_path);
        }
    }

    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let fd = file.into_raw_fd();
        unsafe {
            libc::dup2(fd, 2); // redirect stderr (fd 2) to the log file
            libc::close(fd);
        }
    }
}

#[cfg(target_os = "windows")]
fn redirect_stderr_to_log() {
    use std::os::windows::io::IntoRawHandle;

    unsafe extern "system" {
        fn SetStdHandle(nStdHandle: u32, hHandle: *mut std::ffi::c_void) -> i32;
    }

    const STD_ERROR_HANDLE: u32 = -12i32 as u32;

    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .or_else(|| std::env::var_os("TEMP"));
    let Some(base) = base else {
        return;
    };

    let log_dir = std::path::PathBuf::from(base).join("BBARIT Terminal");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("octo-terminal.log");

    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > 1_000_000 {
            let _ = std::fs::remove_file(&log_path);
        }
    }

    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let handle = file.into_raw_handle();
        unsafe {
            let _ = SetStdHandle(STD_ERROR_HANDLE, handle.cast());
        }
    }
}

#[cfg(target_os = "windows")]
fn hide_debug_console_window() {
    // Dev (debug) builds are console-subsystem (Cargo default); release builds are
    // GUI-subsystem (see the crate-top cfg_attr). The GUI itself doesn't want a
    // console window, so detach from it here. FreeConsole only detaches THIS
    // process — in dev it leaves the launching terminal alone (that console is
    // owned by the shell); if a console exists in release, this closes it.
    extern "system" {
        fn GetConsoleWindow() -> isize;
        fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        fn FreeConsole() -> i32;
    }
    const SW_HIDE: i32 = 0;
    unsafe {
        // Release only: hide our own console window first to minimize any flash.
        // (Never do this in dev — there we share the terminal's console window.)
        #[cfg(not(debug_assertions))]
        {
            let hwnd = GetConsoleWindow();
            if hwnd != 0 {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        let _ = FreeConsole();
    }
}

#[cfg(not(target_os = "windows"))]
fn hide_debug_console_window() {}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn attach_parent_console_for_agent() {
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(all(target_os = "windows", not(debug_assertions))))]
fn attach_parent_console_for_agent() {}

fn main() {
    // Internalized BBARIT agent: when launched with BBARIT_AGENT_MODE set, this
    // same binary runs the embedded coding-agent TUI in-process instead of the
    // GUI app — so the terminal launches *our own executable*, never a separate
    // bbarit.exe. The agent reads its flags from argv (e.g. `--no-pick`).
    if std::env::var_os("BBARIT_AGENT_MODE").is_some() {
        attach_parent_console_for_agent();
        // Dev builds are console-subsystem so the ConPTY pseudoconsole is already
        // attached; release builds are GUI-subsystem and attach to the launching
        // shell's console above. Because a GUI exe doesn't make PowerShell wait,
        // the terminal launcher must block until we exit (XTerminal.tsx D6 —
        // Diagnostics.Process + WaitForExit) or the shell and this TUI race for
        // keystrokes on the shared console. (Do NOT hide the console here.)
        let code = match bbarit::run() {
            Ok(()) => 0,
            Err(err) => {
                eprintln!("bbarit agent: {err:#}");
                1
            }
        };
        std::process::exit(code);
    }

    // Tauri dev builds are console-subsystem binaries so Cargo can run them, but
    // the app itself should not leave a black console window beside the GUI.
    hide_debug_console_window();

    // Redirect stderr to a log file so that eprintln! (from our code or any
    // dependency crate) never panics on broken stderr in bundled macOS apps.
    // Without this, any write to an invalid stderr fd causes SIGABRT.
    redirect_stderr_to_log();

    // D3(2026-07): 과거엔 GDI 캡처(Win+Shift+S)를 위해 --disable-gpu-compositing을 상시 적용했으나,
    // 이는 WebView2 전체를 소프트웨어 렌더링으로 강제해 렌더러가 CPU 코어 1.5개+를 상시 점유(실측),
    // 6코어 머신에서 시스템 전체 버벅임의 주원인이었다.
    // D5(2026-07-03): v1.0.49에서 GPU 합성을 기본값으로 배포하자 일부 PC에서 신규 설치 직후
    // 화면 전체가 검게 변하며 멈추는 문제가 보고됐다(WebView2 GPU 합성의 알려진 GPU/드라이버 편차).
    // 검은 화면은 사용자가 스스로 복구할 수 없으므로(설정 UI 접근 불가) 배포본(release)은
    // 안전한 소프트웨어 합성을 기본값으로 되돌린다. 비용: 렌더러 CPU 점유 증가(구동작).
    // 탈출구: BBARIT_GPU_COMPOSITING=1 로 GPU 합성 opt-in, dev(debug) 빌드는 GPU 합성 유지.
    // (BBARIT_SOFTWARE_COMPOSITING=1 은 하위호환으로 계속 지원 — 어느 빌드든 강제 소프트웨어 합성)
    #[cfg(target_os = "windows")]
    {
        let force_software = std::env::var_os("BBARIT_SOFTWARE_COMPOSITING").is_some();
        let default_software =
            cfg!(not(debug_assertions)) && std::env::var_os("BBARIT_GPU_COMPOSITING").is_none();
        let mut args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if args.is_empty() && (force_software || default_software) {
            args.push_str("--disable-gpu-compositing");
        }
        // WebView2 CDP on 127.0.0.1:9666. Chromium only accepts browser-originated
        // DevTools WebSocket upgrades when --remote-allow-origins is given, which
        // it is not, so web pages cannot attach; BBARIT_NO_CDP turns it off.
        if !args.contains("--remote-debugging-port") && std::env::var_os("BBARIT_NO_CDP").is_none()
        {
            if !args.is_empty() {
                args.push(' ');
            }
            args.push_str("--remote-debugging-port=9666");
        }
        if !args.is_empty() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &args);
        }
    }

    // D4(2026-07): dev(debug)와 설치본이 같은 식별자(com.octo.terminal)를 쓰면 WebView2
    // user-data-dir(EBWebView)를 공유해 두 앱의 렌더러/GPU 프로세스가 한 브라우저 트리에 섞인다.
    // dev 기동이 설치본의 WebGL 컨텍스트를 흔들고 프로세스 귀속 진단도 오염되므로,
    // mcp-bridge 포트(9323/9223) 분리와 같은 철학으로 debug 빌드는 전용 폴더를 쓴다.
    #[cfg(all(target_os = "windows", debug_assertions))]
    {
        if std::env::var("WEBVIEW2_USER_DATA_FOLDER").is_err() {
            if let Some(local) = dirs::data_local_dir() {
                let dev_dir = local.join("com.octo.terminal.dev");
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dev_dir);
            }
        }
    }

    // Release 빌드에서만 아래 single-instance 플러그인으로 재할당되므로 mut.
    // debug 빌드에선 그 블록이 cfg-out 되어 재할당이 없으니 unused_mut 를 억제한다.
    #[cfg_attr(debug_assertions, allow(unused_mut))]
    let mut builder = tauri::Builder::default();

    // Release 빌드에서만 single instance 제한 적용
    #[cfg(not(debug_assertions))]
    {
        if std::env::var_os("BBARIT_DISABLE_SINGLE_INSTANCE").is_none() {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_focus();
                }
            }));
        }
    }

    // mcp-bridge WebSocket 포트 분리: 개발 빌드는 dev 전용 9323, 릴리즈(설치본)는 기본 9223.
    // 같은 머신에서 개발 앱과 설치본이 동시에 떠 있어도 dev:screen이 개발 앱(9323)에만 붙도록 한다.
    // Bind the mcp-bridge WS to loopback only (H-A). The plugin default is
    // 0.0.0.0, which exposes an UNAUTHENTICATED control channel (execute_js →
    // RCE, config tamper, full palette) to anyone on the same LAN. It must never
    // leave this machine.
    #[cfg(debug_assertions)]
    let mcp_bridge = tauri_plugin_mcp_bridge::Builder::new()
        .base_port(9323)
        .bind_address("127.0.0.1")
        .build();
    #[cfg(not(debug_assertions))]
    let mcp_bridge = tauri_plugin_mcp_bridge::Builder::new()
        .bind_address("127.0.0.1")
        .build();

    let mut builder = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());

    if std::env::var_os("BBARIT_DISABLE_UPDATER_PLUGIN").is_none() {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    if std::env::var_os("BBARIT_DISABLE_DRAG_PLUGIN").is_none() {
        builder = builder.plugin(tauri_plugin_drag::init());
    }

    // The control WebSocket can run JS in the app webview. The vendored plugin
    // (vendor/tauri-plugin-mcp-bridge) refuses upgrades that carry a browser
    // `Origin` or a non-loopback `Host`, so a web page cannot reach it while
    // native local clients (browser CLI, bbarit-ctl, the agent) connect as before.
    if mcp_bridge_enabled() {
        builder = builder.plugin(mcp_bridge);
    } else {
        safe_eprintln!(
            "[mcp-bridge] control WebSocket (127.0.0.1:{}) is OFF (BBARIT_DISABLE_MCP_BRIDGE set); the browser CLI, agent `browser` tool and bbarit-ctl cannot reach this app.",
            mcp_bridge_base_port()
        );
    }

    builder
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            match event {
                WindowEvent::CloseRequested { .. } => {
                    safe_eprintln!("[window-event] CloseRequested on '{}'", window.label());
                    // When the MAIN window closes the app is quitting: reap every PTY's whole
                    // process subtree so agent-spawned dev servers / wranglers / build watchers
                    // don't orphan and keep eating memory after the app is gone.
                    if window.label() == "main" {
                        if cfg!(target_os = "macos") {
                            // macOS closes a window without quitting the application. Do not
                            // suppress the request here: the frontend is responsible only for
                            // warning about unsaved files, then lets this window close normally.
                            return;
                        }

                        let state = window.app_handle().state::<AppState>();
                        let pids: Vec<u32> = {
                            let ptys = state.ptys.lock().unwrap();
                            ptys.values().filter_map(|i| i.child.process_id()).collect()
                        };
                        let app_handle = window.app_handle().clone();
                        std::thread::spawn(move || {
                            for pid in pids {
                                kill_process_tree(pid);
                            }
                        });
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(250));
                            app_handle.exit(0);
                        });
                    }
                }
                WindowEvent::Destroyed => {
                    safe_eprintln!("[window-event] Destroyed: '{}'", window.label());
                }
                _ => {}
            }
        })
        .setup(|app| {
            // macOS: Edit 메뉴(표준 액셀러레이터)가 없으면 WKWebView가 Cmd+C/V/X/A를
            // 네이티브 단계에서 버려 keydown이 DOM까지 오지 않는다 — 터미널
            // 복사/붙여넣기가 통째로 죽는 원인. 메뉴의 predefined 항목이
            // 단축키를 받아 웹뷰 표준 편집 동작(copy/paste 이벤트)으로 넘겨준다.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, "BBARIT Terminal")
                    .quit()
                    .build()?;
                // Select All은 predefined 항목을 쓰면 안 된다: 메뉴가 Cmd+A를 받아
                // 네이티브 selectAll: 액션을 실행하는데, 이건 Monaco/xterm처럼 숨은
                // textarea로 입력받는 에디터의 보이는 선택을 못 바꾼다. 커스텀 항목으로
                // 받아 프론트에 이벤트를 보내고, 프론트가 포커스된 표면에 keydown을
                // 재전송해 각 에디터의 기존 Cmd+A 핸들러가 처리하게 한다.
                let select_all = MenuItemBuilder::with_id("edit-select-all", "Select All")
                    .accelerator("Cmd+A")
                    .build(app)?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .item(&select_all)
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "edit-select-all" {
                        let _ = app.emit("menu-select-all", ());
                    }
                });
            }
            if std::env::var_os("BBARIT_DISABLE_STARTUP_SERVICES").is_none() {
                if std::env::var_os("BBARIT_DISABLE_DB_INIT").is_none() {
                    // D10(2026-07-05): DB 자동 관리 — 성공할 때까지 백그라운드 재시도.
                    // 과거엔 BBARIT_ENABLE_DB_INIT(아무도 안 켬)에 가려 이 초기화가
                    // 죽은 코드였고, skills_db의 lazy init에 우연히 기대어 돌았다.
                    // 이제 부팅 시 항상 열고, LOCK 겹침/일시적 디스크 풀 같은 일과성
                    // 실패는 지수 백오프(1s→30s 상한)로 스스로 복구한다. 성공 시
                    // "db-ready" 이벤트로 프론트가 degraded 상태에서 벗어나게 알린다.
                    // 탈출구: BBARIT_DISABLE_DB_INIT=1.
                    let db_app = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let mut delay_ms: u64 = 1000;
                        loop {
                            match db::init_db().await {
                                Ok(_) => {
                                    safe_eprintln!("[db] SurrealDB ready (auto-init)");
                                    let _ = db_app.emit("db-ready", ());
                                    break;
                                }
                                Err(e) => {
                                    safe_eprintln!(
                                        "[db] SurrealDB init failed, retrying in {}ms: {e}",
                                        delay_ms
                                    );
                                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                                    delay_ms = (delay_ms * 2).min(30_000);
                                }
                            }
                        }
                    });
                }

                if std::env::var_os("BBARIT_DISABLE_BUNDLED_SKILLS_INSTALL").is_none() {
                    // Ship bundled SEO/GEO skills to this user's ~/.claude/skills (every installed copy).
                    let skills_handle = app.handle().clone();
                    std::thread::spawn(move || { install_bundled_skills(&skills_handle); });
                }

                if std::env::var_os("BBARIT_DISABLE_BROWSER_BRIDGE").is_none() {
                    // Start local HTTP bridge (MCP invoke + web terminal)
                    let web_state: Arc<web_terminal::WebTerminalState> = app
                        .state::<Arc<web_terminal::WebTerminalState>>()
                        .inner()
                        .clone();
                    let ngrok_state: Arc<web_terminal::NgrokState> =
                        app.state::<Arc<web_terminal::NgrokState>>().inner().clone();
                    let app_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        browser_bridge::start_browser_bridge(
                            app_handle,
                            web_state,
                            ngrok_state,
                        )
                        .await;
                    });
                }
            }

    // (design server is started on-demand via Tauri command, not in setup)

            // macOS: 메인 윈도우의 CGWindowNumber를 저장 (메인 스레드에서 실행)
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(ns_win) = window.ns_window() {
                        extern "C" {
                            fn objc_msgSend(
                                obj: *mut std::ffi::c_void,
                                sel: *mut std::ffi::c_void,
                            ) -> i64;
                            fn sel_registerName(
                                name: *const std::ffi::c_char,
                            ) -> *mut std::ffi::c_void;
                        }
                        let wid = unsafe {
                            let sel = sel_registerName(b"windowNumber\0".as_ptr() as *const _);
                            objc_msgSend(ns_win as *mut std::ffi::c_void, sel)
                        };
                        MAIN_WINDOW_NUMBER.store(wid, Ordering::Relaxed);
                        safe_eprintln!("[setup] Stored main window number: {}", wid);
                    }
                }
            }

            Ok(())
        })
        .manage(AppState {
            ptys: Mutex::new(HashMap::new()),
            harness_jobs: Mutex::new(HashMap::new()),
        })
        .manage(Arc::new(collab::CollabState::new()))
        .manage(Arc::new(collab::TunnelState::new()))
        .manage(Arc::new(lan_discovery::LanDiscoveryState::new()))
        .manage({
            // Load or generate web terminal access token
            let token = load_or_generate_web_token();
            Arc::new(web_terminal::WebTerminalState::new(token))
        })
        .manage(Arc::new(web_terminal::NgrokState::new()))
        .manage(database::DatabaseState::new())
        .manage(file_watcher::FileWatcherState::new())
        .manage(Arc::new(design_http::DesignServerState {
            running: AsyncMutex::new(false),
        }))
        .manage(integrations::McpState {
            mcp: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            claude_design::claude_design_generate,
            claude_design::claude_design_edit,
            claude_design::claude_design_save,
            claude_design::claude_design_list,
            claude_design::claude_design_load,
            claude_design::makeke_text_generate,
            design_http::start_design_server,
            design_http::is_design_server_running,
            chrome_import::chrome_list_profiles,
            chrome_import::chrome_import_data,
            create_shell,
            list_github_accounts,
            detect_github_account,
            resolve_bundled_agent,
            resolve_browser_cli,
            editor_bridge_respond,
            gateway_ui_respond,
            gateway_info,
            mcp_bridge_base_port,
            agent_personas_list,
            agent_oneshot,
            agent_models_list,
            agent_rpc_start,
            agent_rpc_write,
            agent_rpc_status,
            agent_rpc_stop,
            create_cli_shell,
            run_cli_oneshot,
            stream_cli_command,
            start_harness_job,
            list_harness_jobs,
            get_harness_job,
            cancel_harness_job,
            clear_harness_job,
            git_worktree_add,
            git_worktree_head,
            git_worktree_remove,
            git_merge_branch,
            git_delete_branch,
            git_is_repo,
            git_init_repo,
            git_has_uncommitted,
            git_stash_save,
            git_stash_pop,
            git_current_branch,
            git_branch_ahead_count,
            git_cleanup_orch_worktrees,
            git_cleanup_broker_worktrees,
            cleanup_project_dev_processes,
            git_status_full,
            git_add,
            git_restore,
            git_commit_changes,
            git_diff,
            git_diff_stat,
            git_log,
            git_show,
            git_branch_list,
            git_branch_create,
            git_checkout,
            git_fetch,
            git_pull,
            git_push,
            git_remote_list,
            git_stash_list,
            git_stash_drop,
            git_tag_list,
            git_tag_create,
            git_tag_delete,
            git_blame,
            git_clone,
            check_pty_alive,
            read_pty_output_buffer,
            write_to_pty,
            read_from_pty,
            resize_pty,
            close_pty,
            destroy_pty,
            debug_log,
            get_web_terminal_info,
            cloudflared_command,
            http_request,
            http_stream_request,
            openai_transcribe_audio_with_key,
            list_local_whisper_models,
            local_whisper_model_status,
            download_local_whisper_model,
            transcribe_audio_auto,
            telegram_send_message,
            telegram_send_message_with_token,
            telegram_get_updates,
            telegram_get_updates_any,
            telegram_verify_bot_token_any,
            discord_send_message,
            slack_send_message,
            slack_get_messages,
            slack_verify_token,
            discord_get_messages,
            discord_verify_bot_token,
            search_files,
            code_search,
            code_find_related,
            code_search_stats,
            code_search_savings,
            code_search_clear_cache,
            semble_project_overview,
            semble_dependency_tree,
            list_project_files,
            path_exists,
            read_directory,
            get_file_metadata,
            read_file,
            read_file_base64,
            video_edit::video_ffmpeg_check,
            video_edit::video_export_clips,
            write_file,
            write_file_base64,
            save_file_dialog,
            create_directory,
            create_empty_file,
            delete_path,
            rename_path,
            ssh_validate_base,
            ssh_fix_key_permissions,
            claude_scaffold,
            copy_path,
            get_home_dir,
            get_documents_dir,
            path_join,
            open_folder_dialog,
            open_file_dialog,
            open_files_dialog,
            capture_screenshot,
            capture_screen_video,
            capture_screen_png_base64,
            native_text_input,
            save_clipboard_image,
            save_clipboard_image_from_system_clipboard,
            get_process_stats,
            pm2_list,
            server_stats,
            server_analysis,
            read_ssh_config,
            pm2_action,
            get_pty_cwd,
            pty_terminal_has_child,
            pty_idle_ms,
            classify_agent_ready,
            reveal_in_explorer,
            open_external_wsl_terminal,
            list_system_fonts,
            copy_to_clipboard,
            read_clipboard_text,
            read_clipboard_file_paths,
            // Note operations
            note_ops::search_notes,
            note_ops::list_markdown_files,
            note_ops::file_metadata,
            note_ops::parse_frontmatter,
            // Internal WebView browser. Command names remain cef_* for API compatibility.
            cef_available,
            cef_open,
            cef_set_bounds,
            cef_navigate,
            cef_nav_action,
            cef_set_visible,
            cef_zoom,
            cef_find,
            cef_eval,
            cef_set_download_dir,
            cef_devtools,
            cef_close,
            cef_list,
            cef_set_cookies,
            // SurrealDB-backed commands
            db_scrum_save_history,
            db_scrum_list_history,
            db_scrum_save_state,
            db_scrum_load_state,
            db_save_session,
            db_load_session,
            db_skills_bootstrap,
            db_skills_list_my,
            db_skills_list_gallery,
            db_skills_set_my,
            db_skills_upsert_my,
            db_skills_delete_my,
            db_skills_stats,
            db_skills_list_packs,
            db_skills_install_pack,
            db_skills_remove_pack,
            db_learning_upsert_session,
            db_learning_list_sessions,
            db_learning_search_sessions,
            db_learning_list_skills,
            db_learning_search_skills,
            db_learning_list_memories,
            db_learning_search_memories,
            db_learning_search_all,
            db_learning_upsert_skills,
            db_learning_upsert_memories,
            db_learning_append_trajectory,
            db_learning_list_trajectories,
            db_learning_search_trajectories,
            // KV Store (DB-backed localStorage replacement)
            kv_ping,
            kv_get,
            kv_set,
            kv_delete,
            kv_get_many,
            kv_set_many,
            kv_migrate_from_localstorage,
            harness_db_get,
            harness_db_set,
            // Config file operations
            get_config_path,
            read_config,
            write_config,
            // MCP operations
            integrations::mcp_spawn,
            integrations::mcp_stop,
            integrations::mcp_tools_list,
            integrations::mcp_tools_call,
            integrations::pi_browser_spawn,
            // Database operations
            database::db_test_connection,
            database::db_connect,
            database::db_disconnect,
            database::db_list_databases,
            database::db_list_tables,
            database::db_describe_table,
            database::db_execute_query,
            // Video operations
            // File watcher
            file_watcher::watch_directory,
            file_watcher::unwatch_directory,
            file_watcher::unwatch_all,
            // Collab
            collab::collab_start_host,
            collab::collab_stop_host,
            collab::collab_get_status,
            collab::collab_start_tunnel,
            collab::collab_stop_tunnel,
            collab::collab_get_tunnel_url,
            // LAN peer discovery
            lan_discovery::lan_list_peers,
            lan_discovery::lan_set_ssh,
            lan_discovery::lan_stop_discovery,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| {
            // RunEvent::Exit fires on EVERY app exit path — including macOS Cmd+Q,
            // which never goes through CloseRequested (prevent_close) above. Reap
            // the RPC agent children here so no `--mode rpc` process outlives the app.
            if let tauri::RunEvent::Exit = event {
                agent_rpc_stop_all();
            }
        });
}

#[cfg(all(test, not(target_os = "windows")))]
mod github_account_tests {
    use super::{
        account_for_org_owner, github_login_candidates, github_remote_owner, merge_owner_mapping,
        org_lookup_should_start, parse_gh_hosts_accounts, OrgLookup,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn org_lookup_runs_once_and_backs_off_after_a_miss() {
        let ttl = Duration::from_secs(600);
        let now = Instant::now();
        assert!(org_lookup_should_start(None, now, ttl));
        assert!(!org_lookup_should_start(Some(OrgLookup::InFlight(now)), now, ttl));
        assert!(org_lookup_should_start(
            Some(OrgLookup::InFlight(now)),
            now + Duration::from_secs(61),
            ttl
        ));
        assert!(!org_lookup_should_start(Some(OrgLookup::Miss(now)), now + Duration::from_secs(10), ttl));
        assert!(org_lookup_should_start(Some(OrgLookup::Miss(now)), now + ttl, ttl));
    }

    #[test]
    fn owner_is_parsed_from_github_remotes() {
        assert_eq!(github_remote_owner("https://github.com/bluelang1/repo.git").as_deref(), Some("bluelang1"));
        assert_eq!(github_remote_owner("git@github.com:org/repo.git").as_deref(), Some("org"));
        assert_eq!(github_remote_owner("ssh://git@github.com/org/repo").as_deref(), Some("org"));
        assert_eq!(github_remote_owner("https://gitlab.com/org/repo.git"), None);
        assert_eq!(github_remote_owner("https://github.com/org"), None);
        assert_eq!(github_remote_owner("https://evil.example/github.com/me/x"), None);
        assert_eq!(github_remote_owner("https://github.com.evil.example/me/x"), None);
        assert_eq!(github_remote_owner("https://user@github.com/org/repo.git").as_deref(), Some("org"));
    }

    #[test]
    fn mapped_login_is_tried_before_owner_name() {
        let mapping = serde_json::json!({ "owners": { "acme-org": "me-work" } });
        assert_eq!(github_login_candidates("acme-org", Some(&mapping)), vec!["me-work", "acme-org"]);
        assert_eq!(github_login_candidates("me", Some(&mapping)), vec!["me"]);
        assert_eq!(github_login_candidates("me", None), vec!["me"]);
        assert_eq!(github_login_candidates("Acme-Org", Some(&mapping)), vec!["me-work", "Acme-Org"]);
    }

    #[test]
    fn hosts_yml_lists_all_github_accounts_and_active_one() {
        let yaml = "github.com:\n    users:\n        work-me:\n        bluelang1:\n            oauth_token: secret\n    git_protocol: https\n    user: work-me\nghe.example.com:\n    users:\n        other:\n    user: other\n";
        let (accounts, active) = parse_gh_hosts_accounts(yaml);
        assert_eq!(accounts, vec!["work-me", "bluelang1"]);
        assert_eq!(active.as_deref(), Some("work-me"));
    }

    #[test]
    fn hosts_yml_legacy_single_user_and_missing_host() {
        let legacy = "github.com:\n  oauth_token: secret\n  user: solo\n  git_protocol: ssh\n";
        assert_eq!(parse_gh_hosts_accounts(legacy), (vec!["solo".to_string()], Some("solo".to_string())));
        let other_host_only = "gitlab.com:\n  users:\n    x:\n  user: x\n";
        assert_eq!(parse_gh_hosts_accounts(other_host_only), (Vec::<String>::new(), None));
        assert_eq!(parse_gh_hosts_accounts(""), (Vec::<String>::new(), None));
        let quoted = "\"github.com\":\n  users:\n    \"me\":\n  user: \"me\"\n";
        assert_eq!(parse_gh_hosts_accounts(quoted), (vec!["me".to_string()], Some("me".to_string())));
    }

    #[test]
    fn org_owner_matches_account_case_insensitively() {
        let orgs = vec![
            ("personal".to_string(), vec![]),
            ("work".to_string(), vec!["ColosseumCoinCKR".to_string(), "other".to_string()]),
        ];
        assert_eq!(account_for_org_owner("colosseumcoinckr", &orgs).as_deref(), Some("work"));
        assert_eq!(account_for_org_owner("stranger", &orgs), None);
        assert_eq!(account_for_org_owner("x", &[]), None);
    }

    #[test]
    fn owner_mapping_merge_keeps_other_keys_and_replaces_case_variants() {
        let created = merge_owner_mapping(None, "acme", "me-work").unwrap();
        assert_eq!(created, serde_json::json!({ "owners": { "acme": "me-work" } }));

        let existing = r#"{"note": "keep", "owners": {"ACME": "old", "beta": "me"}}"#;
        let merged = merge_owner_mapping(Some(existing), "acme", "me-work").unwrap();
        assert_eq!(
            merged,
            serde_json::json!({ "note": "keep", "owners": { "acme": "me-work", "beta": "me" } })
        );

        let bad_owners = merge_owner_mapping(Some(r#"{"owners": 3}"#), "acme", "me").unwrap();
        assert_eq!(bad_owners, serde_json::json!({ "owners": { "acme": "me" } }));

        assert!(merge_owner_mapping(Some("not json"), "acme", "me").is_none());
        assert!(merge_owner_mapping(Some("[1]"), "acme", "me").is_none());
        assert!(merge_owner_mapping(Some("  "), "acme", "me").is_some());
    }
}

#[cfg(test)]
mod argument_hardening_tests {
    use super::{parse_ssh_path, reject_option_like, sh_quote};

    #[test]
    fn option_shaped_values_are_refused() {
        assert!(reject_option_like("--upload-pack=touch /tmp/pwned", "clone URL").is_err());
        assert!(reject_option_like("-D", "branch name").is_err());
        assert!(reject_option_like("  --force", "ref").is_err());
        assert!(reject_option_like("main", "branch").is_ok());
        assert!(reject_option_like("origin/main", "base").is_ok());
        assert!(reject_option_like("https://github.com/x/y.git", "clone URL").is_ok());
        assert!(reject_option_like("stash@{0}", "stash ref").is_ok());
        assert!(reject_option_like("", "ref").is_ok());
    }

    #[test]
    fn sh_quote_neutralises_shell_metacharacters() {
        assert_eq!(sh_quote("api"), "'api'");
        assert_eq!(sh_quote("x; rm -rf ~"), "'x; rm -rf ~'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$(id)"), "'$(id)'");
    }

    #[test]
    fn ssh_user_and_host_cannot_be_options() {
        assert!(parse_ssh_path("ssh://-oProxyCommand=evil@host::/srv").is_err());
        assert!(parse_ssh_path("ssh://user@-oProxyCommand=evil::/srv").is_err());
        let ok = parse_ssh_path("ssh://deploy@example.com:2222::/srv/app").unwrap().unwrap();
        assert_eq!(ok.port, 2222);
    }
}
