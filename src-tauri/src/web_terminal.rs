//! Web-based terminal access via WebSocket + REST API.
//!
//! Serves a standalone web UI at `/web` that connects via WebSocket to a PTY session.
//! Accessible from any browser, including remote access via ngrok tunnel.
//!
//! Architecture:
//!   Browser → GET /web (static HTML with xterm.js)
//!   Browser → POST /api/terminal (create PTY) → terminal_id
//!   Browser → WS /ws/terminal/{id}?token=xxx ↔ PTY I/O
//!   Optional: ngrok tunnel for external access

use axum::{
    extract::{ws, Path, Query, State as AxumState},
    http::{header, StatusCode},
    response::{Html, IntoResponse},
    Json,
};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};
use tokio::sync::{broadcast, Mutex as TokioMutex};

// ── Constants ──

const WEB_PTY_BROADCAST_CAPACITY: usize = 2048;
const WEB_PTY_MAX_TERMINALS: usize = 10;

// ── Types ──

pub struct WebPtyInstance {
    writer: std::sync::Mutex<Box<dyn Write + Send>>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    output_tx: broadcast::Sender<String>,
    alive: Arc<AtomicBool>,
    work_dir: String,
    cli_type: String,
}

pub struct WebTerminalState {
    ptys: TokioMutex<HashMap<String, WebPtyInstance>>,
    auth_token: String,
}

impl WebTerminalState {
    pub fn new(token: String) -> Self {
        Self {
            ptys: TokioMutex::new(HashMap::new()),
            auth_token: token,
        }
    }

    pub fn token(&self) -> &str {
        &self.auth_token
    }
}

// ── Request/Response types ──

#[derive(Debug, Deserialize)]
pub struct CreateTerminalReq {
    #[serde(default = "default_work_dir")]
    work_dir: String,
    #[serde(default = "default_rows")]
    rows: u16,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default)]
    cli_type: Option<String>,
}

fn default_work_dir() -> String {
    dirs_home().unwrap_or_else(|| "/tmp".to_string())
}
fn default_rows() -> u16 {
    24
}
fn default_cols() -> u16 {
    80
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| {
        crate::common::no_window_command("id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|u| format!("/Users/{}", u.trim()))
    })
}

#[derive(Debug, Serialize)]
pub struct TerminalInfo {
    terminal_id: String,
    work_dir: String,
    alive: bool,
    cli_type: String,
}

#[derive(Debug, Deserialize)]
pub struct ResizeReq {
    rows: u16,
    cols: u16,
}

#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse<T: Serialize> {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn ok_response<T: Serialize>(data: T) -> Json<ApiResponse<T>> {
    Json(ApiResponse {
        success: true,
        data: Some(data),
        error: None,
    })
}

pub fn err_response<T: Serialize>(msg: &str) -> (StatusCode, Json<ApiResponse<T>>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiResponse {
            success: false,
            data: None,
            error: Some(msg.to_string()),
        }),
    )
}

// ── Auth helper ──

pub fn check_auth(
    state: &WebTerminalState,
    query: &TokenQuery,
    headers: &axum::http::HeaderMap,
) -> Result<(), (StatusCode, Json<ApiResponse<()>>)> {
    let token = query.token.as_deref().or_else(|| {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
    });

    match token {
        // Constant-time compare (M-1) — no early return on first mismatch.
        Some(t) if crate::agent_gateway::ct_eq(t, &state.auth_token) => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse {
                success: false,
                data: None,
                error: Some("Invalid or missing token".to_string()),
            }),
        )),
    }
}

// ── PTY spawn (similar to main.rs create_shell but uses broadcast channel) ──

fn spawn_web_pty(
    work_dir: &str,
    rows: u16,
    cols: u16,
    cli_type: &str,
) -> Result<WebPtyInstance, String> {
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

    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new("powershell.exe");

    #[cfg(not(target_os = "windows"))]
    let mut cmd = match cli_type {
        "claude" => {
            let c = CommandBuilder::new("claude");
            c
        }
        "codex" => {
            let c = CommandBuilder::new("codex");
            c
        }
        "cursor" => CommandBuilder::new("cursor-agent"),
        "kimi" => {
            let c = CommandBuilder::new("kimi");
            c
        }
        "ollama" => {
            let mut c = CommandBuilder::new("ollama");
            c.arg("run");
            c.arg("llama3");
            c
        }
        "qwen" => CommandBuilder::new("qwen"),
        "reasonix" => {
            let mut c = CommandBuilder::new("reasonix");
            c.arg("code");
            c
        }
        // The embedded BBARIT agent: launch THIS exe with BBARIT_AGENT_MODE=1
        // (set below) so it runs the agent TUI instead of the GUI. No separate
        // agent binary exists. Falls back to a shell if the exe path is unknown.
        "bbarit" => match std::env::current_exe() {
            Ok(exe) => CommandBuilder::new(exe),
            Err(_) => {
                let mut c = CommandBuilder::new("/bin/zsh");
                c.arg("-l");
                c
            }
        },
        _ => {
            let mut c = CommandBuilder::new("/bin/zsh");
            c.arg("-l");
            c
        }
    };

    let resolved_dir = if std::path::Path::new(work_dir).exists() {
        work_dir.to_string()
    } else {
        dirs_home().unwrap_or_else(|| "/tmp".to_string())
    };
    let _ = std::fs::create_dir_all(&resolved_dir);
    cmd.cwd(&resolved_dir);

    cmd.env_remove("CLAUDECODE");

    // Embedded BBARIT agent: THIS exe reads BBARIT_AGENT_MODE to run the agent
    // TUI instead of the GUI. Only set for the bbarit cli_type.
    if cli_type == "bbarit" {
        cmd.env("BBARIT_AGENT_MODE", "1");
    }

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "ko_KR.UTF-8");
        cmd.env("LC_ALL", "ko_KR.UTF-8");

        let username = crate::common::no_window_command("id")
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
    }

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let (output_tx, _) = broadcast::channel::<String>(WEB_PTY_BROADCAST_CAPACITY);
    let alive = Arc::new(AtomicBool::new(true));

    // Spawn reader thread that publishes to broadcast channel
    let tx_clone = output_tx.clone();
    let alive_clone = Arc::clone(&alive);
    spawn_web_reader_thread(reader, tx_clone, alive_clone);

    Ok(WebPtyInstance {
        writer: std::sync::Mutex::new(writer),
        _master: pty_pair.master,
        _child: child,
        output_tx,
        alive,
        work_dir: resolved_dir,
        cli_type: cli_type.to_string(),
    })
}

fn spawn_web_reader_thread(
    mut reader: Box<dyn Read + Send>,
    tx: broadcast::Sender<String>,
    alive: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending: Vec<u8> = Vec::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);

                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                let _ = tx.send(s.to_string());
                                pending.clear();
                                break;
                            }
                            Err(e) => {
                                let valid_up_to = e.valid_up_to();
                                if valid_up_to > 0 {
                                    let valid = String::from_utf8_lossy(&pending[..valid_up_to])
                                        .to_string();
                                    let _ = tx.send(valid);
                                }
                                if let Some(len) = e.error_len() {
                                    pending.drain(0..(valid_up_to + len));
                                    if pending.is_empty() {
                                        break;
                                    }
                                } else {
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
            let _ = tx.send(String::from_utf8_lossy(&pending).to_string());
        }
        alive.store(false, Ordering::Relaxed);
    });
}

// ── Route handlers ──

pub async fn handle_create_terminal(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    Json(req): Json<CreateTerminalReq>,
) -> Result<Json<ApiResponse<TerminalInfo>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let ptys = state.ptys.lock().await;
    if ptys.len() >= WEB_PTY_MAX_TERMINALS {
        return Err(err_response("Max terminals reached (10)"));
    }
    drop(ptys);

    let terminal_id = uuid::Uuid::new_v4().to_string();

    let cli_type = req.cli_type.as_deref().unwrap_or("shell");
    match spawn_web_pty(&req.work_dir, req.rows, req.cols, cli_type) {
        Ok(instance) => {
            let info = TerminalInfo {
                terminal_id: terminal_id.clone(),
                work_dir: instance.work_dir.clone(),
                alive: true,
                cli_type: instance.cli_type.clone(),
            };
            state.ptys.lock().await.insert(terminal_id, instance);
            Ok(ok_response(info))
        }
        Err(e) => Err(err_response(&format!("Failed to create terminal: {e}"))),
    }
}

pub async fn handle_list_terminals(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<Vec<TerminalInfo>>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let ptys = state.ptys.lock().await;
    let list: Vec<TerminalInfo> = ptys
        .iter()
        .map(|(id, inst)| TerminalInfo {
            terminal_id: id.clone(),
            work_dir: inst.work_dir.clone(),
            alive: inst.alive.load(Ordering::Relaxed),
            cli_type: inst.cli_type.clone(),
        })
        .collect();

    Ok(ok_response(list))
}

pub async fn handle_close_terminal(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Path(terminal_id): Path<String>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let mut ptys = state.ptys.lock().await;
    if ptys.remove(&terminal_id).is_some() {
        Ok(ok_response("Terminal closed".to_string()))
    } else {
        Err(err_response("Terminal not found"))
    }
}

pub async fn handle_resize_terminal(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Path(terminal_id): Path<String>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ResizeReq>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let ptys = state.ptys.lock().await;
    if let Some(inst) = ptys.get(&terminal_id) {
        match inst._master.resize(PtySize {
            rows: req.rows,
            cols: req.cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(_) => Ok(ok_response("Resized".to_string())),
            Err(e) => Err(err_response(&format!("Resize failed: {e}"))),
        }
    } else {
        Err(err_response("Terminal not found"))
    }
}

// ── WebSocket handler ──

#[derive(Debug, Deserialize)]
pub struct WsMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cols: Option<u16>,
}

pub async fn handle_ws_terminal(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Path(terminal_id): Path<String>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    ws_upgrade: ws::WebSocketUpgrade,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiResponse<()>>)> {
    // Reject cross-site WebSocket connections (H-3) before auth.
    if !crate::agent_gateway::origin_ok(&headers) {
        return Err(err_response::<()>("cross-site origin rejected"));
    }
    check_auth(&state, &q, &headers)?;

    // Verify terminal exists and get broadcast receiver
    let ptys = state.ptys.lock().await;
    let inst = ptys
        .get(&terminal_id)
        .ok_or_else(|| err_response::<()>("Terminal not found"))?;
    let output_rx = inst.output_tx.subscribe();
    drop(ptys);

    let state_clone = Arc::clone(&state);
    let tid = terminal_id.clone();

    Ok(ws_upgrade
        .on_upgrade(move |socket| handle_ws_connection(socket, state_clone, tid, output_rx)))
}

async fn handle_ws_connection(
    socket: ws::WebSocket,
    state: Arc<WebTerminalState>,
    terminal_id: String,
    mut output_rx: broadcast::Receiver<String>,
) {
    use futures::sink::SinkExt;
    use futures::stream::StreamExt;

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Task 1: PTY output → WebSocket
    let tid_read = terminal_id.clone();
    let read_task = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Ok(data) => {
                    if ws_tx.send(ws::Message::Text(data.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    let msg = format!("\r\n[{n} messages dropped]\r\n");
                    if ws_tx.send(ws::Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    let _ = ws_tx
                        .send(ws::Message::Text("\r\n[Terminal exited]\r\n".into()))
                        .await;
                    break;
                }
            }
        }
        let _ = tid_read;
    });

    // Task 2: WebSocket → PTY input
    let state_write = Arc::clone(&state);
    let tid_write = terminal_id.clone();
    let write_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_rx.next().await {
            match msg {
                ws::Message::Text(text) => {
                    if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                        let ptys = state_write.ptys.lock().await;
                        if let Some(inst) = ptys.get(&tid_write) {
                            match ws_msg.msg_type.as_str() {
                                "input" => {
                                    if let Some(data) = &ws_msg.data {
                                        if let Ok(mut w) = inst.writer.lock() {
                                            let _ = w.write_all(data.as_bytes());
                                            let _ = w.flush();
                                        }
                                    }
                                }
                                "resize" => {
                                    if let (Some(rows), Some(cols)) = (ws_msg.rows, ws_msg.cols) {
                                        let _ = inst._master.resize(PtySize {
                                            rows,
                                            cols,
                                            pixel_width: 0,
                                            pixel_height: 0,
                                        });
                                    }
                                }
                                "ping" => {} // keepalive, no-op
                                _ => {}
                            }
                        }
                    }
                }
                ws::Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Wait for either task to finish, then abort the other
    tokio::select! {
        _ = read_task => {}
        _ = write_task => {}
    }
}

// ── File system API handlers ──

#[derive(Debug, Deserialize)]
pub struct FileQuery {
    path: String,
    token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileEntryWeb {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// Resolve a path for the credential-confinement check. Canonicalize the target
/// when it exists (resolving symlinks / `..`); for a not-yet-created file, fall
/// back to canonicalizing the parent and re-joining the name so a symlinked
/// parent can't smuggle a write past the deny-list.
fn canonical_for_check(path: &std::path::Path) -> std::path::PathBuf {
    if let Ok(c) = path.canonicalize() {
        return c;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(pc) = parent.canonicalize() {
            return pc.join(name);
        }
    }
    path.to_path_buf()
}

/// Deny access to well-known credential / secret paths (C-2). The web file API
/// is tunnelable (auth-gated only), so even an authenticated client must never
/// read or overwrite SSH keys, .env tokens, cloud creds, or the app's own
/// config (which holds the web-terminal token itself).
fn path_is_forbidden(path: &std::path::Path) -> bool {
    let canon = canonical_for_check(path);
    let s = canon.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    const DENY: &[&str] = &[
        // Credentials / secret stores
        "/.ssh/",
        "/.gnupg/",
        "/.aws/",
        "/.kube/",
        "/.docker/",
        "/.config/octo",
        "/.config/gh",
        "/.netrc",
        "/.npmrc",
        "/.pgpass",
        "/.git-credentials",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
        "authorized_keys",
        ".env",
        // Shell startup files — writing these = code execution on next shell (H-B)
        "/.zshrc",
        "/.zshenv",
        "/.zprofile",
        "/.bashrc",
        "/.bash_profile",
        "/.profile",
        // Auto-run on login (H-B)
        "/library/launchagents/",
        "/library/launchdaemons/",
    ];
    DENY.iter().any(|needle| s.contains(needle))
}

pub async fn handle_list_files(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<FileQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<Vec<FileEntryWeb>>>, (StatusCode, Json<ApiResponse<()>>)> {
    let tq = TokenQuery {
        token: q.token.clone(),
    };
    check_auth(&state, &tq, &headers)?;

    let dir_path = std::path::Path::new(&q.path);
    if path_is_forbidden(dir_path) {
        return Err(err_response("Access to this path is not allowed"));
    }
    if !dir_path.exists() || !dir_path.is_dir() {
        return Err(err_response("Directory not found"));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(dir_path)
        .map_err(|e| err_response::<()>(&format!("Cannot read directory: {e}")))?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files starting with .
        if name.starts_with('.') {
            continue;
        }
        // Skip common large/unimportant directories
        if name == "node_modules" || name == "target" || name == ".git" || name == "dist" {
            continue;
        }
        let path = entry.path().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        entries.push(FileEntryWeb {
            name,
            path,
            is_dir,
            size,
        });
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ok_response(entries))
}

#[derive(Debug, Deserialize)]
pub struct ReadFileQuery {
    path: String,
    token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileContent {
    path: String,
    content: String,
    size: u64,
}

const WEB_FILE_READ_LIMIT: u64 = 2 * 1024 * 1024; // 2MB

pub async fn handle_read_file(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<ReadFileQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<FileContent>>, (StatusCode, Json<ApiResponse<()>>)> {
    let tq = TokenQuery {
        token: q.token.clone(),
    };
    check_auth(&state, &tq, &headers)?;

    let file_path = std::path::Path::new(&q.path);
    if path_is_forbidden(file_path) {
        return Err(err_response("Access to this path is not allowed"));
    }
    if !file_path.exists() || !file_path.is_file() {
        return Err(err_response("File not found"));
    }

    let meta = std::fs::metadata(file_path)
        .map_err(|e| err_response::<()>(&format!("Cannot read metadata: {e}")))?;

    if meta.len() > WEB_FILE_READ_LIMIT {
        return Err(err_response("File too large (max 2MB)"));
    }

    let content = std::fs::read_to_string(file_path)
        .map(crate::fs_ops::strip_utf8_bom)
        .map_err(|e| err_response::<()>(&format!("Cannot read file: {e}")))?;

    Ok(ok_response(FileContent {
        path: q.path,
        content,
        size: meta.len(),
    }))
}

// ── File write API ──

#[derive(Debug, Deserialize)]
pub struct WriteFileReq {
    path: String,
    content: String,
}

pub async fn handle_write_file(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    Json(req): Json<WriteFileReq>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let file_path = std::path::Path::new(&req.path);
    if path_is_forbidden(file_path) {
        return Err(err_response("Access to this path is not allowed"));
    }
    if !file_path.exists() {
        // Allow creating new files only if parent dir exists
        if let Some(parent) = file_path.parent() {
            if !parent.exists() {
                return Err(err_response("Parent directory not found"));
            }
        }
    }

    std::fs::write(
        file_path,
        crate::fs_ops::encode_text_file_content(file_path, &req.content),
    )
        .map_err(|e| err_response::<()>(&format!("Cannot write file: {e}")))?;

    Ok(ok_response("Saved".to_string()))
}

// ── KV Store API (read projects from SurrealDB) ──

#[derive(Debug, Deserialize)]
pub struct KvQuery {
    key: String,
    token: Option<String>,
}

pub async fn handle_kv_get(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    Query(q): Query<KvQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<()>>)> {
    let tq = TokenQuery {
        token: q.token.clone(),
    };
    check_auth(&state, &tq, &headers)?;

    let db =
        crate::db::get_db().map_err(|_| err_response::<()>("SurrealDB not ready"))?;

    let mut result = db
        .query("SELECT `value` FROM `kv_store` WHERE `key` = $key LIMIT 1")
        .bind(("key", q.key))
        .await
        .map_err(|e| err_response::<()>(&format!("KV get failed: {e}")))?;

    let rows: Vec<serde_json::Value> = result
        .take(0)
        .map_err(|e| err_response::<()>(&format!("KV parse: {e}")))?;

    let value = rows
        .into_iter()
        .next()
        .and_then(|r| r.get("value").cloned())
        .unwrap_or(serde_json::Value::Null);

    Ok(ok_response(value))
}

// ── Static HTML page ──

pub async fn serve_web_page() -> impl IntoResponse {
    // Never let the browser cache the page — otherwise phones keep showing a stale
    // build after we ship a fix, which makes mobile debugging unreliable.
    (
        [(header::CACHE_CONTROL, "no-store, must-revalidate")],
        Html(include_str!("../static/web-terminal.html")),
    )
}

// ── Ngrok tunnel management ──

pub struct NgrokState {
    pub process: TokioMutex<Option<tokio::process::Child>>,
    pub public_url: TokioMutex<Option<String>>,
}

impl NgrokState {
    pub fn new() -> Self {
        Self {
            process: TokioMutex::new(None),
            public_url: TokioMutex::new(None),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NgrokInfo {
    pub active: bool,
    pub url: Option<String>,
}

pub async fn handle_ngrok_start(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    ngrok: axum::Extension<Arc<NgrokState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<NgrokInfo>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let mut proc = ngrok.process.lock().await;
    if proc.is_some() {
        let url = ngrok.public_url.lock().await.clone();
        return Ok(ok_response(NgrokInfo { active: true, url }));
    }

    // Try cloudflared first, fallback to ngrok. Tunnel the REMOTE port only —
    // it carries the auth-gated routes; the unauthenticated local bridge is
    // never exposed (C3).
    let port = crate::browser_bridge::REMOTE_PORT;
    let find_bin = |name: &str| -> String {
        #[cfg(not(target_os = "windows"))]
        {
            // 1) well-known paths (macOS/Linux)
            for dir in &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
                let p = format!("{}/{}", dir, name);
                if std::path::Path::new(&p).exists() {
                    return p;
                }
            }
            // 2) login shell which
            if let Ok(o) = crate::common::no_window_command("/bin/sh")
                .args(["-lc", &format!("which {}", name)])
                .output()
            {
                let path = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if o.status.success() && !path.is_empty() {
                    return path;
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            // 1) well-known paths (Windows)
            let exe = format!("{}.exe", name);
            for dir in &[
                r"C:\Program Files\cloudflared",
                r"C:\Program Files (x86)\cloudflared",
                r"C:\ProgramData\chocolatey\bin",
            ] {
                let p = format!("{}\\{}", dir, exe);
                if std::path::Path::new(&p).exists() {
                    return p;
                }
            }
            // 2) scoop path
            if let Ok(home) = std::env::var("USERPROFILE") {
                let p = format!("{}\\scoop\\shims\\{}", home, exe);
                if std::path::Path::new(&p).exists() {
                    return p;
                }
            }
            // 3) winget (Links shim, then scan Packages) — works even if PATH is stale
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let link = format!("{}\\Microsoft\\WinGet\\Links\\{}", local, exe);
                if std::path::Path::new(&link).exists() {
                    return link;
                }
                let pkgs = format!("{}\\Microsoft\\WinGet\\Packages", local);
                if let Ok(rd) = std::fs::read_dir(&pkgs) {
                    for ent in rd.flatten() {
                        if ent.file_name().to_string_lossy().to_lowercase().contains(name) {
                            let p = ent.path().join(&exe);
                            if p.exists() {
                                return p.to_string_lossy().to_string();
                            }
                        }
                    }
                }
            }
            // 4) where.exe
            if let Ok(o) = crate::common::no_window_command("where.exe").arg(name).output() {
                let path = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if o.status.success() && !path.is_empty() {
                    return path;
                }
            }
        }
        name.to_string()
    };
    let cloudflared_bin = find_bin("cloudflared");
    let ngrok_bin = find_bin("ngrok");

    // Build enriched PATH for bundled app (macOS bundles have minimal PATH)
    #[cfg(not(target_os = "windows"))]
    let enriched_path = {
        let home = std::env::var("HOME").unwrap_or_else(|_| {
            let user = std::env::var("USER").unwrap_or_else(|_| "unknown".to_string());
            format!("/Users/{}", user)
        });
        format!(
            "/opt/homebrew/bin:/opt/homebrew/sbin:{}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            home
        )
    };

    // cloudflared --config wants a real null device: /dev/null on unix, NUL on Windows.
    let null_cfg = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };
    let (mut child, is_cloudflared) = {
        let mut cmd = crate::common::no_window_async_command(&cloudflared_bin);
        cmd.args([
            "tunnel",
            "--config",
            null_cfg,
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
        #[cfg(not(target_os = "windows"))]
        cmd.env("PATH", &enriched_path);
        safe_eprintln!("[tunnel] trying cloudflared: {}", cloudflared_bin);
        if let Ok(c) = cmd.spawn() {
            (c, true)
        } else {
            let mut cmd = crate::common::no_window_async_command(&ngrok_bin);
            cmd.args(["http", &format!("{port}")])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            #[cfg(not(target_os = "windows"))]
            cmd.env("PATH", &enriched_path);
            safe_eprintln!("[tunnel] trying ngrok: {}", ngrok_bin);
            if let Ok(c) = cmd.spawn() {
                (c, false)
            } else {
                return Err(err_response(
                    "Neither cloudflared nor ngrok found. Install one: brew install cloudflared",
                ));
            }
        }
    };

    // Extract stderr before moving child into state, so we can parse URL from it
    let url = if is_cloudflared {
        let stderr = child.stderr.take();
        *proc = Some(child);
        drop(proc);
        safe_eprintln!("[tunnel] cloudflared started, detecting URL from stderr...");
        // Parse URL directly from cloudflared stderr (more reliable than port polling)
        let mut detected = None;
        if let Some(stderr) = stderr {
            detected = parse_cloudflared_url_from_stderr(stderr).await;
            safe_eprintln!("[tunnel] stderr parse result: {:?}", detected);
        }
        if detected.is_none() {
            safe_eprintln!("[tunnel] stderr parse failed, trying port polling...");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            detected = fetch_cloudflared_url().await;
            safe_eprintln!("[tunnel] port polling result: {:?}", detected);
        }
        detected
    } else {
        *proc = Some(child);
        drop(proc);
        safe_eprintln!("[tunnel] ngrok started, detecting URL...");
        // ngrok needs a moment to start its local API
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let mut url = None;
        for i in 0..5 {
            url = fetch_ngrok_url().await;
            if url.is_some() {
                break;
            }
            safe_eprintln!("[tunnel] ngrok URL attempt {} failed, retrying...", i + 1);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        safe_eprintln!("[tunnel] ngrok URL result: {:?}", url);
        url
    };

    // Only store valid URLs (not empty strings)
    let url = url.filter(|u| !u.is_empty() && u.starts_with("https://"));
    *ngrok.public_url.lock().await = url.clone();
    safe_eprintln!("[tunnel] final URL: {:?}", url);
    Ok(ok_response(NgrokInfo { active: true, url }))
}

pub async fn handle_ngrok_stop(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    ngrok: axum::Extension<Arc<NgrokState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let mut proc = ngrok.process.lock().await;
    if let Some(ref mut child) = *proc {
        let _ = child.kill().await;
    }
    *proc = None;
    *ngrok.public_url.lock().await = None;

    Ok(ok_response("Ngrok stopped".to_string()))
}

pub async fn handle_ngrok_status(
    AxumState(state): AxumState<Arc<WebTerminalState>>,
    ngrok: axum::Extension<Arc<NgrokState>>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<ApiResponse<NgrokInfo>>, (StatusCode, Json<ApiResponse<()>>)> {
    check_auth(&state, &q, &headers)?;

    let proc = ngrok.process.lock().await;
    let active = proc.is_some();
    let url = if active {
        let cached = ngrok.public_url.lock().await.clone();
        if cached.is_some() {
            cached
        } else {
            // Try both ngrok and cloudflared URL detection
            let fresh = fetch_ngrok_url().await.or(fetch_cloudflared_url().await);
            if fresh.is_some() {
                *ngrok.public_url.lock().await = fresh.clone();
            }
            fresh
        }
    } else {
        None
    };

    Ok(ok_response(NgrokInfo { active, url }))
}

async fn fetch_cloudflared_url() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;

    for port in 20000..20300 {
        if let Ok(resp) = client
            .get(&format!("http://127.0.0.1:{port}/ready"))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(resp2) = client
                    .get(&format!("http://127.0.0.1:{port}/quicktunnel"))
                    .send()
                    .await
                {
                    if let Ok(json) = resp2.json::<serde_json::Value>().await {
                        if let Some(hostname) = json["hostname"].as_str() {
                            if !hostname.is_empty() {
                                safe_eprintln!(
                                    "[tunnel] cloudflared quicktunnel hostname: {}",
                                    hostname
                                );
                                return Some(format!("https://{hostname}"));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

/// Parse the tunnel URL directly from cloudflared's stderr output.
/// cloudflared prints a line like: "... https://xxx-yyy.trycloudflare.com ..."
/// IMPORTANT: After finding the URL, stderr must continue to be drained in a
/// background task. Dropping the stderr pipe causes SIGPIPE → cloudflared dies.
async fn parse_cloudflared_url_from_stderr(stderr: tokio::process::ChildStderr) -> Option<String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);

    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(1), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                safe_eprintln!("[tunnel] cloudflared stderr: {}", line);
                if let Some(start) = line.find("https://") {
                    let url_part = &line[start..];
                    let end = url_part
                        .find(|c: char| c.is_whitespace() || c == '|' || c == ')')
                        .unwrap_or(url_part.len());
                    let url = &url_part[..end];
                    if url.contains(".trycloudflare.com") {
                        safe_eprintln!("[tunnel] detected URL from stderr: {}", url);
                        let found = url.to_string();
                        // Keep draining stderr in background so cloudflared doesn't get SIGPIPE
                        tokio::spawn(
                            async move { while let Ok(Some(_)) = lines.next_line().await {} },
                        );
                        return Some(found);
                    }
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }
    // Not found — still drain stderr to keep process alive
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    None
}

async fn fetch_ngrok_url() -> Option<String> {
    // ngrok exposes a local API at http://127.0.0.1:4040/api/tunnels
    let client = reqwest::Client::new();
    for _ in 0..5 {
        if let Ok(resp) = client.get("http://127.0.0.1:4040/api/tunnels").send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(tunnels) = json["tunnels"].as_array() {
                    for t in tunnels {
                        if let Some(url) = t["public_url"].as_str() {
                            if url.starts_with("https://") {
                                return Some(url.to_string());
                            }
                        }
                    }
                    // fallback: return any URL
                    if let Some(t) = tunnels.first() {
                        if let Some(url) = t["public_url"].as_str() {
                            return Some(url.to_string());
                        }
                    }
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    None
}
// rebuild trigger 2
