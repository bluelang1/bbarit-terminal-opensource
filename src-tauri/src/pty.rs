//! PTY management: shell creation, reading, writing, resizing, closing.
//! PTY output is pushed to the frontend via Tauri events (no polling).

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

/// Prevent unbounded memory growth when the frontend can't keep up with PTY output.
/// 2048: CLI tools like Claude can produce bursts of output; 256 was too small and
/// caused silent data drops, making the terminal appear frozen.
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 2048;
/// Limit how much we batch per event to avoid huge payloads.
const PTY_READ_MAX_BYTES: usize = 64 * 1024;
/// Minimum interval between emits — lets the frontend batch at ~60fps.
const PTY_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(8);
/// Static truncation notice to avoid repeated heap allocation.
const PTY_TRUNCATION_NOTICE: &str = "\r\n[output truncated]\r\n";

pub struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyState {
    pub ptys: Mutex<HashMap<String, PtyInstance>>,
}

fn spawn_utf8_reader_thread(mut reader: Box<dyn Read + Send>, tx: SyncSender<String>) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Pre-allocate pending buffer to avoid repeated small allocations.
        // Capacity 4096 matches the read buffer; it grows only for multi-byte
        // sequences that straddle read boundaries.
        let mut pending: Vec<u8> = Vec::with_capacity(4096);
        let mut dropped_output = false;
        // Reusable String buffer for sending valid UTF-8 segments.
        let mut send_buf = String::with_capacity(4096);

        let mut try_send_str = |s: &str| -> bool {
            if s.is_empty() {
                return true;
            }

            if dropped_output {
                match tx.try_send(PTY_TRUNCATION_NOTICE.to_owned()) {
                    Ok(()) => dropped_output = false,
                    Err(TrySendError::Disconnected(_)) => return false,
                    Err(TrySendError::Full(_)) => {}
                }
            }

            match tx.try_send(s.to_owned()) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    // Channel full — block briefly to let the emitter drain, instead of
                    // silently dropping data which makes the terminal appear frozen.
                    match tx.send(s.to_owned()) {
                        Ok(()) => true,
                        Err(_) => false, // disconnected
                    }
                }
                Err(TrySendError::Disconnected(_)) => false,
            }
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Fast path: if no pending bytes, try to decode directly
                    // from the read buffer to avoid copying into `pending`.
                    if pending.is_empty() {
                        match std::str::from_utf8(&buf[..n]) {
                            Ok(s) => {
                                if !try_send_str(s) {
                                    return;
                                }
                                continue;
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                if valid_up_to > 0 {
                                    // Safety: from_utf8 confirmed these bytes are valid UTF-8.
                                    let valid = unsafe {
                                        std::str::from_utf8_unchecked(&buf[..valid_up_to])
                                    };
                                    if !try_send_str(valid) {
                                        return;
                                    }
                                }
                                if let Some(len) = e.error_len() {
                                    // Invalid sequence: skip it and keep remaining as pending
                                    let rest_start = valid_up_to + len;
                                    if rest_start < n {
                                        pending.extend_from_slice(&buf[rest_start..n]);
                                    }
                                } else {
                                    // Incomplete sequence at the end: save for next read
                                    pending.extend_from_slice(&buf[valid_up_to..n]);
                                }
                                continue;
                            }
                        }
                    }

                    // Slow path: there are pending bytes from a previous read
                    pending.extend_from_slice(&buf[..n]);

                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                if !try_send_str(s) {
                                    return;
                                }
                                pending.clear();
                                break;
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                if valid_up_to > 0 {
                                    // These bytes were already validated by from_utf8.
                                    send_buf.clear();
                                    send_buf.push_str(unsafe {
                                        std::str::from_utf8_unchecked(&pending[..valid_up_to])
                                    });
                                    if !try_send_str(&send_buf) {
                                        return;
                                    }
                                }

                                if let Some(len) = e.error_len() {
                                    // Use copy_within + truncate instead of drain to avoid
                                    // shifting through the allocator on every error.
                                    let skip = valid_up_to + len;
                                    let remaining = pending.len() - skip;
                                    if remaining > 0 {
                                        pending.copy_within(skip.., 0);
                                        pending.truncate(remaining);
                                    } else {
                                        pending.clear();
                                        break;
                                    }
                                } else {
                                    if valid_up_to > 0 {
                                        let remaining = pending.len() - valid_up_to;
                                        pending.copy_within(valid_up_to.., 0);
                                        pending.truncate(remaining);
                                    }
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
            let _ = try_send_str(&String::from_utf8_lossy(&pending));
        }
    });
}

/// Set up the shell environment common to both create_shell and create_cli_shell.
#[cfg(not(target_os = "windows"))]
fn configure_shell_env(cmd: &mut CommandBuilder, work_dir: &str) {
    cmd.arg("-l");
    cmd.cwd(work_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "ko_KR.UTF-8");
    cmd.env("LC_ALL", "ko_KR.UTF-8");

    let username = std::process::Command::new("id")
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
    cmd.env_remove("npm_config_prefix");

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

    let path = format!(
        "{}:{}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        nvm_node_path, home
    );

    cmd.env("PATH", &path);
    cmd.env("SHELL", "/bin/zsh");
    cmd.env("NVM_DIR", format!("{}/.nvm", home));

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
}

fn spawn_pty(
    state: &PtyState,
    app: AppHandle,
    terminal_id: String,
    mut cmd: CommandBuilder,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    // 앱을 색상 비활성 환경(예: 에이전트가 NO_COLOR=1로 dev 앱을 실행)에서 띄우면
    // PTY 자식들이 이를 상속해 CLI 색이 전부 죽는다 — 항상 제거.
    cmd.env_remove("NO_COLOR");
    cmd.env_remove("COLOR");
    cmd.env_remove("FORCE_COLOR");
    // 이미 동일 terminal_id로 PTY가 존재하면 생성 건너뜀 (중복 호출 방지)
    // AgentTerminalPage 등 별도 WebviewWindow에서 XTerminal이 다시 create_shell을
    // 호출할 때, 기존 CLI 프로세스가 파괴되는 것을 방지
    {
        let ptys = state.ptys.lock().unwrap();
        if ptys.contains_key(&terminal_id) {
            safe_eprintln!("[pty] terminal_id '{}' already exists, skipping spawn", terminal_id);
            return Ok(());
        }
    }

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

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::sync_channel::<String>(PTY_OUTPUT_QUEUE_CAPACITY);
    spawn_utf8_reader_thread(reader, tx);

    // Event emitter thread: reads from channel and pushes to frontend via Tauri events.
    // Batches aggressively and enforces a minimum interval between emits so the
    // frontend never receives more than ~120 events/sec even under heavy output.
    let event_name = format!("pty-data-{}", terminal_id);
    let exit_event_id = terminal_id.clone();
    thread::spawn(move || {
        let mut last_emit = Instant::now() - PTY_EMIT_MIN_INTERVAL;
        // Pre-allocate a reusable buffer to batch channel messages,
        // avoiding a new String allocation per event cycle.
        let mut out = String::with_capacity(PTY_READ_MAX_BYTES);
        loop {
            match rx.recv() {
                Ok(first) => {
                    out.clear();
                    out.push_str(&first);
                    // If we're within the min-interval window, sleep the remainder
                    // so more data accumulates in the channel.
                    let elapsed = last_emit.elapsed();
                    if elapsed < PTY_EMIT_MIN_INTERVAL {
                        thread::sleep(PTY_EMIT_MIN_INTERVAL - elapsed);
                    }
                    // Drain everything available after the sleep
                    while out.len() < PTY_READ_MAX_BYTES {
                        match rx.try_recv() {
                            Ok(next) => out.push_str(&next),
                            Err(_) => break,
                        }
                    }
                    last_emit = Instant::now();
                    if app.emit(&event_name, &out).is_err() {
                        break;
                    }
                }
                Err(_) => break, // Channel disconnected (PTY closed)
            }
        }
        // Notify frontend that this PTY process has exited
        let _ = app.emit("pty-exit", &exit_event_id);
    });

    let instance = PtyInstance {
        writer,
        master: pty_pair.master,
        child,
    };

    state.ptys.lock().unwrap().insert(terminal_id, instance);

    Ok(())
}

#[tauri::command]
pub fn create_shell(
    state: State<'_, PtyState>,
    app: AppHandle,
    terminal_id: String,
    work_dir: String,
    rows: u16,
    cols: u16,
    shell_type: Option<String>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let shell_executable = match shell_type.as_deref() {
            Some("cmd") => "cmd.exe",
            Some("gitbash") => "C:\\Program Files\\Git\\bin\\bash.exe",
            Some("wsl") => "wsl.exe",
            _ => "powershell.exe",
        };
        CommandBuilder::new(shell_executable)
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("/bin/zsh");

    #[cfg(not(target_os = "windows"))]
    configure_shell_env(&mut cmd, &work_dir);

    #[cfg(target_os = "windows")]
    {
        cmd.cwd(&work_dir);
        cmd.env("TERM", "cygwin");
    }

    spawn_pty(&state, app, terminal_id, cmd, rows, cols)
}

#[tauri::command]
pub fn write_to_pty(
    state: State<'_, PtyState>,
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

#[tauri::command]
pub fn resize_pty(
    state: State<'_, PtyState>,
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

#[tauri::command]
pub fn close_pty(state: State<'_, PtyState>, terminal_id: String) -> Result<(), String> {
    if let Some(instance) = state.ptys.lock().unwrap().remove(&terminal_id) {
        // Destructure to control drop order explicitly.
        let PtyInstance {
            writer,
            master,
            mut child,
        } = instance;
        thread::spawn(move || {
            // 1. Drop writer first — signals EOF to the child process,
            //    giving it a chance to exit gracefully.
            drop(writer);
            // 2. Drop master — closes the PTY fd, which also terminates
            //    the reader thread (read returns 0/error).
            drop(master);
            // 3. Kill + wait to ensure the child process is fully reaped.
            let _ = child.kill();
            let _ = child.wait();
        });
    }
    Ok(())
}

#[tauri::command]
pub fn destroy_pty(state: State<'_, PtyState>, terminal_id: String) -> Result<(), String> {
    close_pty(state, terminal_id)
}

#[tauri::command]
pub fn create_cli_shell(
    state: State<'_, PtyState>,
    app: AppHandle,
    terminal_id: String,
    work_dir: String,
    cli_type: String,
    auto_accept: bool,
    prompt: Option<String>,
    rows: u16,
    cols: u16,
    shell_type: Option<String>,
) -> Result<(), String> {
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
        "codex" => None,
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
        "gemini" => Some("octo chat -e gemini".to_string()),
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
        "octo" => Some("octo chat".to_string()),
        _ => None,
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let shell_executable = match shell_type.as_deref() {
            Some("cmd") => "cmd.exe",
            Some("gitbash") => "C:\\Program Files\\Git\\bin\\bash.exe",
            Some("wsl") => "wsl.exe",
            _ => "powershell.exe",
        };
        CommandBuilder::new(shell_executable)
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("/bin/zsh");

    #[cfg(not(target_os = "windows"))]
    {
        configure_shell_env(&mut cmd, &work_dir);
        if let Some(cli_cmd) = cli_command {
            cmd.arg("-c");
            cmd.arg(cli_cmd);
        }
    }

    #[cfg(target_os = "windows")]
    {
        cmd.cwd(&work_dir);
        cmd.env("TERM", "cygwin");
        if let Some(cli_cmd) = cli_command {
            // cmd.exe uses /c, others use -Command or -c
            let flag = match shell_type.as_deref() {
                Some("cmd") => "/c",
                Some("gitbash") | Some("wsl") => "-c",
                _ => "-Command",
            };
            cmd.arg(flag);
            cmd.arg(cli_cmd);
        }
    }

    spawn_pty(&state, app, terminal_id, cmd, rows, cols)
}
