//! Agent gateway — external control of the BBARIT "secretary" agent.
//!
//! Two surfaces, both served off the local bridge (browser_bridge.rs):
//!
//!   WS  /gateway/ws   — external clients (mobile web chat, tunneled via
//!                       ngrok/cloudflared) drive a secretary agent session.
//!                       Handshake `connect` → `hello-ok`, then `req`/`res` and
//!                       server-pushed `event` frames (RPC-over-WS, mirroring
//!                       the OpenClaw gateway shape). The gateway is a thin pipe:
//!                       it spawns THIS exe in `--mode rpc` with the secretary
//!                       persona, forwards client frames to the agent's stdin,
//!                       and streams every agent stdout line back as an `event`.
//!
//!   POST /gateway/ui  — the agent's `app_control` tool calls back in here to
//!                       drive the app UI (open panels, create projects, change
//!                       settings). App.tsx answers via `gateway_ui_respond`.
//!
//! ## Security model (security-first)
//!
//! This surface can be exposed to the internet via a tunnel, so it is hardened:
//!   - **Dedicated tokens.** The external WS token and the internal UI-bus token
//!     are separate secrets, distinct from the web-terminal token. The UI token
//!     is NEVER sent to external clients — only injected into the agent process.
//!   - **Constant-time token compare** to avoid timing oracles.
//!   - **WS Origin check** blocks cross-site WebSocket hijacking / DNS rebinding.
//!   - **No RCE.** The secretary session runs with a strict tool allowlist:
//!     bash / write / edit / patch / append / job are DENIED. It can only drive
//!     the app (app_control), office editors, the browser, and read/search.
//!   - **Session cap** bounds concurrent agent processes (fork-bomb / cost DoS).
//!   - **Sandboxed cwd** so any file tool that survives runs under a scratch dir.

use axum::{
    extract::{ws, Query, State as AxumState},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::browser_bridge::BRIDGE_PORT;

/// Max concurrent secretary sessions. Each is a full LLM agent process; this
/// bounds a fork-bomb / cost-DoS from an attacker who has the WS token.
const MAX_SESSIONS: usize = 6;

/// Tools the external secretary session is allowed to use. This is an ALLOWLIST
/// (default-deny): anything not listed — notably `bash`, `write`, `edit`,
/// `patch`, `append`, `job` — is unavailable, so a compromised session cannot
/// run arbitrary code or scribble the filesystem. The secretary drives the app
/// through `app_control`, edits documents through the office editors, browses
/// with `browser`, and reads/searches — no raw shell.
const SECRETARY_TOOLS: &str =
    "app_control,xlsx,pptx,docx,editor,browser,read,read_many,ls,grep,find,tree,web_search,web_fetch";

// ── Dedicated gateway secrets ──

fn gen_token() -> String {
    // 128 bits of randomness, hex. rand is already a dependency (see main.rs).
    let hi: u64 = rand::random();
    let lo: u64 = rand::random();
    format!("{hi:016x}{lo:016x}")
}

/// External WS token — external clients (mobile web chat) present this. Shown to
/// the user via `gateway_info` (QR / URL); distinct from the web-terminal token.
pub fn ws_token() -> &'static str {
    static T: OnceLock<String> = OnceLock::new();
    T.get_or_init(gen_token)
}

/// Internal UI-bus token — injected into the secretary process only. Guards
/// POST /gateway/ui so a malicious web page (CORS is permissive on the bridge)
/// cannot drive the app UI without knowing this never-exported secret.
pub fn ui_token() -> &'static str {
    static T: OnceLock<String> = OnceLock::new();
    T.get_or_init(gen_token)
}

/// Constant-time string compare — no early return on first mismatch.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn bearer<'a>(headers: &'a axum::http::HeaderMap, query: Option<&'a str>) -> Option<&'a str> {
    query.or_else(|| {
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
    })
}

/// Reject cross-site WebSocket connections. A browser always sends `Origin`; we
/// require it to match this host (the chat page is served same-origin) or be a
/// loopback origin. Native clients (no browser) send no Origin and are allowed —
/// they still need the token.
pub(crate) fn origin_ok(headers: &axum::http::HeaderMap) -> bool {
    let origin = match headers.get(axum::http::header::ORIGIN).and_then(|v| v.to_str().ok()) {
        None => return true, // non-browser client
        Some(o) => o,
    };
    // Strip scheme, keep host[:port].
    let ohost = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin);
    if ohost.starts_with("127.0.0.1") || ohost.starts_with("localhost") || ohost.starts_with("[::1]")
    {
        return true;
    }
    match headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok()) {
        Some(host) => ohost == host,
        None => false,
    }
}

#[derive(Clone)]
pub struct GatewayCtx {
    pub app_handle: AppHandle,
}

#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    token: Option<String>,
}

// ── Mobile web chat page ──

pub async fn serve_gateway_chat() -> impl IntoResponse {
    (
        [(axum::http::header::CACHE_CONTROL, "no-store, must-revalidate")],
        axum::response::Html(include_str!("../static/gateway-chat.html")),
    )
}

/// The secretary's avatar image, so the chat header shows a real face (not just
/// an emoji). Embedded in the binary; served on the remote port same-origin.
pub async fn serve_gateway_avatar() -> impl IntoResponse {
    (
        [
            (axum::http::header::CONTENT_TYPE, "image/png"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        include_bytes!("../../public/persona-avatars/icons/individual/bbarit-secretary.png")
            .as_slice(),
    )
}

// ── WS: external client → secretary agent session ──

pub async fn handle_gateway_ws(
    AxumState(ctx): AxumState<GatewayCtx>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
    ws_upgrade: ws::WebSocketUpgrade,
) -> impl IntoResponse {
    if !origin_ok(&headers) {
        return (StatusCode::FORBIDDEN, "cross-site origin rejected").into_response();
    }
    match bearer(&headers, q.token.as_deref()) {
        Some(t) if ct_eq(t, ws_token()) => {}
        _ => return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response(),
    }
    // Enforce the concurrent-session cap up front (prune dead ones first).
    prune_dead_children();
    if GATEWAY_CHILDREN.lock().unwrap().len() >= MAX_SESSIONS {
        return (StatusCode::SERVICE_UNAVAILABLE, "too many active sessions").into_response();
    }
    ws_upgrade.on_upgrade(move |socket| handle_gateway_connection(socket, ctx))
}

/// True when the client's `connect` frame carries the correct password.
fn auth_frame_ok(text: &str, password: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|f| {
            f.get("password")
                .and_then(|p| p.as_str())
                .map(|got| ct_eq(got, password))
        })
        .unwrap_or(false)
}

async fn handle_gateway_connection(socket: ws::WebSocket, ctx: GatewayCtx) {
    use futures::sink::SinkExt;
    use futures::stream::StreamExt;

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Password gate (before spawning an agent — reject cheaply). When a gateway
    // password is set, the FIRST frame must be a `connect` carrying the correct
    // password; a leaked token URL alone is not enough to reach the agent.
    if let Some(pw) = crate::configured_gateway_password() {
        let authed = match ws_rx.next().await {
            Some(Ok(ws::Message::Text(t))) => auth_frame_ok(&t, &pw),
            _ => false,
        };
        if !authed {
            let _ = ws_tx
                .send(ws::Message::Text(
                    serde_json::json!({
                        "type": "auth-fail",
                        "reason": "password required"
                    })
                    .to_string()
                    .into(),
                ))
                .await;
            return;
        }
    }

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let spawn = spawn_secretary_agent(&ctx.app_handle, line_tx.clone());
    let (child_id, mut stdin) = match spawn {
        Ok((child, stdin)) => {
            let id = NEXT_CHILD_ID.fetch_add(1, Ordering::Relaxed);
            GATEWAY_CHILDREN
                .lock()
                .unwrap()
                .push(ChildEntry { id, child });
            (id, stdin)
        }
        Err(e) => {
            let _ = ws_tx
                .send(ws::Message::Text(
                    serde_json::json!({"type":"res","ok":false,"error":format!("spawn failed: {e}")})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    let hello = serde_json::json!({
        "type": "hello-ok",
        "server": { "app": "bbarit-terminal-gateway", "protocol": 1 },
        "features": {
            "methods": ["prompt", "abort", "get_state", "new_session"],
            "events": ["agent"]
        }
    });
    let _ = ws_tx.send(ws::Message::Text(hello.to_string().into())).await;

    // Task: agent stdout lines → WS events.
    let out_task = tokio::spawn(async move {
        while let Some(line) = line_rx.recv().await {
            let frame = serde_json::json!({
                "type": "event",
                "event": "agent",
                "payload": serde_json::from_str::<serde_json::Value>(&line)
                    .unwrap_or_else(|_| serde_json::json!({ "raw": line })),
            });
            if ws_tx.send(ws::Message::Text(frame.to_string().into())).await.is_err() {
                break;
            }
        }
    });

    // Task: WS frames → agent stdin.
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            ws::Message::Text(text) => {
                let _ = route_client_frame(&mut stdin, &text);
            }
            ws::Message::Close(_) => break,
            _ => {}
        }
    }
    out_task.abort();
    reap_child(child_id);
}

/// Translate an inbound client frame into an agent-RPC stdin write.
fn route_client_frame(stdin: &mut std::process::ChildStdin, text: &str) -> Result<(), String> {
    use std::io::Write;
    let frame: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("bad frame: {e}"))?;
    match frame.get("type").and_then(|v| v.as_str()) {
        Some("connect") => Ok(()),
        Some("req") => {
            let method = frame
                .get("method")
                .and_then(|v| v.as_str())
                .ok_or("req missing method")?;
            // Only the advertised methods may reach the agent.
            if !matches!(method, "prompt" | "abort" | "get_state" | "new_session") {
                return Err(format!("method not allowed: {method}"));
            }
            let mut rpc = frame
                .get("params")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            rpc["type"] = serde_json::json!(method);
            if let Some(id) = frame.get("id") {
                rpc["id"] = id.clone();
            }
            let line = serde_json::to_string(&rpc).map_err(|e| e.to_string())?;
            writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
            Ok(())
        }
        other => Err(format!("unknown frame type: {other:?}")),
    }
}

// ── Session registry (bounded, actually reaped) ──

struct ChildEntry {
    id: u64,
    child: std::process::Child,
}
static GATEWAY_CHILDREN: Lazy<Mutex<Vec<ChildEntry>>> = Lazy::new(|| Mutex::new(Vec::new()));
static NEXT_CHILD_ID: AtomicU64 = AtomicU64::new(1);

fn reap_child(id: u64) {
    let mut list = GATEWAY_CHILDREN.lock().unwrap();
    if let Some(pos) = list.iter().position(|c| c.id == id) {
        let mut entry = list.remove(pos);
        let _ = entry.child.kill();
        let _ = entry.child.wait();
    }
}

/// Drop entries whose process has already exited (best-effort, non-blocking).
fn prune_dead_children() {
    let mut list = GATEWAY_CHILDREN.lock().unwrap();
    list.retain_mut(|c| !matches!(c.child.try_wait(), Ok(Some(_))));
}

/// Spawn THIS exe in agent RPC mode as the secretary, with a STRICT tool
/// allowlist (no bash/write/edit — see SECRETARY_TOOLS) and the app-control /
/// browser / editor bridges wired to this app. The UI-bus token is injected so
/// the agent's app_control tool can authenticate to POST /gateway/ui.
fn spawn_secretary_agent(
    app: &AppHandle,
    line_tx: tokio::sync::mpsc::UnboundedSender<String>,
) -> Result<(std::process::Child, std::process::ChildStdin), String> {
    use std::io::BufRead;
    use std::process::{Command, Stdio};

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    // --approve keeps the unattended session from blocking on trust prompts;
    // the tool allowlist (--tools) is what actually contains it — bash and the
    // filesystem-mutating tools are simply not present, so "approved" only
    // grants the safe app-driving tools.
    cmd.env("BBARIT_AGENT_MODE", "1")
        .args([
            "--mode", "rpc",
            "--no-pick",
            "--approve",
            "--persona", "bbarit-secretary",
            "--tools", SECRETARY_TOOLS,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Respond in the user's globally-configured language (config.language).
    let lang = crate::configured_language();
    if let Some(policy) = crate::bbarit_language_prompt(Some(&lang)) {
        cmd.args(["--append-system-prompt", policy]);
    }

    // Sandbox cwd: any surviving file/read tool resolves under a scratch dir,
    // never the app bundle root (which is `/` for an installed .app).
    if let Some(dir) = secretary_scratch_dir() {
        cmd.current_dir(dir);
    }

    if let Some(cli) = crate::resolve_browser_cli(app.clone()) {
        cmd.env("BBARIT_BROWSER_CLI", cli)
            .env("BBARIT_BRIDGE_ALLOW_RELEASE", "1")
            .env("TAURI_DEV_BASE_PORT", crate::mcp_bridge_base_port().to_string());
    }
    cmd.env(
        "BBARIT_EDITOR_BRIDGE",
        format!("http://127.0.0.1:{BRIDGE_PORT}/editor"),
    );
    // app_control → this app's gateway UI bus, authenticated with the UI token.
    cmd.env(
        "BBARIT_GATEWAY_BRIDGE",
        format!("http://127.0.0.1:{BRIDGE_PORT}/gateway/ui"),
    )
    .env("BBARIT_GATEWAY_UI_TOKEN", ui_token());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("spawn secretary: {e}"))?;
    let stdin = child.stdin.take().ok_or("secretary: no stdin")?;
    let stdout = child.stdout.take().ok_or("secretary: no stdout")?;
    let stderr = child.stderr.take().ok_or("secretary: no stderr")?;

    {
        let tx = line_tx.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }
    // stderr: keep it OUT of the external stream (it can leak internal paths /
    // env). Only forward to the app log, not to the WS client.
    {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                crate::safe_eprintln!("[gateway-secretary] {line}");
            }
        });
    }
    Ok((child, stdin))
}

/// Per-run scratch dir for the secretary's file tools.
fn secretary_scratch_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var("HOME")
        .ok()
        .map(std::path::PathBuf::from)
        .map(|h| h.join(".config/octo/secretary-scratch"))
        .unwrap_or_else(|| std::env::temp_dir().join("bbarit-secretary-scratch"));
    std::fs::create_dir_all(&base).ok()?;
    Some(base)
}

// ── POST /gateway/ui: agent app_control tool → App.tsx UI command bus ──

static UI_PENDING: Lazy<
    Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>,
> = Lazy::new(|| Mutex::new(HashMap::new()));
static UI_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn ui_resolve(request_id: &str, result: serde_json::Value) -> bool {
    let sender = UI_PENDING.lock().unwrap().remove(request_id);
    match sender {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
}

/// Emit a UI command to App.tsx and await its answer over the oneshot bus.
/// Shared by the agent's app_control (/gateway/ui) and the chat's app-state poll.
async fn ui_dispatch(app: &AppHandle, req: serde_json::Value) -> serde_json::Value {
    let seq = UI_SEQ.fetch_add(1, Ordering::Relaxed);
    let request_id = format!("gw-ui-{seq}");
    let (tx, rx) = tokio::sync::oneshot::channel();
    UI_PENDING.lock().unwrap().insert(request_id.clone(), tx);

    let payload = serde_json::json!({ "requestId": request_id, "request": req });
    if let Err(e) = app.emit("gateway-ui-command", &payload) {
        UI_PENDING.lock().unwrap().remove(&request_id);
        return serde_json::json!({ "ok": false, "error": format!("emit failed: {e}") });
    }
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => {
            UI_PENDING.lock().unwrap().remove(&request_id);
            serde_json::json!({ "ok": false, "error": "ui bus channel closed" })
        }
        Err(_) => {
            UI_PENDING.lock().unwrap().remove(&request_id);
            serde_json::json!({
                "ok": false,
                "error": "gateway UI bus timed out (30s) — is BBARIT Terminal window open?"
            })
        }
    }
}

pub async fn handle_gateway_ui(
    AxumState(ctx): AxumState<GatewayCtx>,
    headers: axum::http::HeaderMap,
    Json(req): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Authenticate: only the secretary process (which holds the UI token) may
    // drive the app UI. Blocks a malicious web page hitting this loopback route.
    match bearer(&headers, None) {
        Some(t) if ct_eq(t, ui_token()) => {}
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "ok": false, "error": "unauthorized" })),
            )
        }
    }
    let cmd = req.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    if cmd.is_empty() {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "ok": false, "error": "cmd is required" })),
        );
    }
    // Command allowlist for the REMOTE secretary (default-deny). The tool
    // allowlist blocks `bash`, but app_control could otherwise reach the app's
    // real shell via terminal.write, or mutate config via config.patch, or run
    // any palette action — re-opening the RCE the tool allowlist was meant to
    // close. So we gate at the UI-bus level: the external secretary may observe
    // and drive safe panels/editors, but NOT execute shell input, create/close
    // terminals, patch settings, run arbitrary palette actions, or create
    // projects. (This route is the secretary's only path; the local bbarit-ctl
    // uses the mcp-bridge, not this.)
    if !SECRETARY_ALLOWED_CMDS.contains(&cmd) {
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("command '{cmd}' is not permitted for the remote secretary")
            })),
        );
    }
    (StatusCode::OK, Json(ui_dispatch(&ctx.app_handle, req).await))
}

/// UI-bus commands the external secretary (app_control) may invoke. Read/observe
/// + safe in-app navigation only. Explicitly EXCLUDES: terminal.write/create/
/// close/activate (shell exec), config.patch (settings tamper), palette.run/list
/// (arbitrary actions), project.create/switch, persona.set, sidebar/layout set.
const SECRETARY_ALLOWED_CMDS: &[&str] = &[
    "status",
    "commands.list",
    "project.list",
    "config.get",
    "view.set",
    "panel.open",
    "editor.open",
    "editor.list",
    "editor.close",
    "image.generate",
    "design.open",
    "cowork.open",
    "marketing.open",
    "terminal.list",
    "terminal.read",
    "persona.list",
    "clipboard.copy",
    "notify",
    // Kanban: in-app task board only — no shell / filesystem reach.
    "kanban.list",
    "kanban.add",
    "kanban.move",
    "kanban.update",
    "kanban.delete",
    // Scheduler: schedule.add/run/toggle are DEFERRED terminal input (the job
    // types its command into a terminal), i.e. the same power as the blocked
    // terminal.write. Permitted deliberately: scheduling-by-chat is a core
    // secretary feature the owner asked for, and this surface is token- AND
    // password-gated. Revisit if the gateway is ever exposed without a password.
    "schedule.list",
    "schedule.add",
    "schedule.delete",
    "schedule.toggle",
    "schedule.run",
    "schedule.panel",
];

/// App-state poll for the chat header (current project / view). Authenticated
/// with the external WS token — the chat page fetches this same-origin.
pub async fn handle_gateway_appstate(
    AxumState(ctx): AxumState<GatewayCtx>,
    Query(q): Query<TokenQuery>,
    headers: axum::http::HeaderMap,
) -> (StatusCode, Json<serde_json::Value>) {
    match bearer(&headers, q.token.as_deref()) {
        Some(t) if ct_eq(t, ws_token()) => {}
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "ok": false, "error": "unauthorized" })),
            )
        }
    }
    let mut state = ui_dispatch(&ctx.app_handle, serde_json::json!({ "cmd": "status" })).await;
    // Strip absolute paths (info leak, M-A): the chat header only needs project
    // names, not the on-disk workDir. A leaked WS token must not reveal the
    // filesystem layout.
    if let Some(projects) = state.get_mut("projects").and_then(|p| p.as_array_mut()) {
        for p in projects.iter_mut() {
            if let Some(obj) = p.as_object_mut() {
                obj.remove("workDir");
            }
        }
    }
    if let Some(obj) = state.as_object_mut() {
        obj.remove("openFiles");
    }
    (StatusCode::OK, Json(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_only_equal() {
        assert!(ct_eq("abc123", "abc123"));
        assert!(!ct_eq("abc123", "abc124"));
        assert!(!ct_eq("abc", "abcd")); // length mismatch
    }

    #[test]
    fn ws_and_ui_tokens_are_distinct_and_stable() {
        assert_ne!(ws_token(), ui_token());
        assert_eq!(ws_token(), ws_token()); // stable across calls
        assert_eq!(32, ws_token().len()); // 128-bit hex = 32 chars
    }

    #[test]
    fn secretary_tools_deny_shell_and_writes() {
        for banned in ["bash", "write", "edit", "patch", "append", "job"] {
            assert!(
                !SECRETARY_TOOLS.split(',').any(|t| t == banned),
                "{banned} must not be in the secretary allowlist"
            );
        }
        assert!(SECRETARY_TOOLS.split(',').any(|t| t == "app_control"));
    }

    #[test]
    fn secretary_allowed_commands_cover_safe_agent_panels() {
        for allowed in [
            "image.generate",
            "design.open",
            "cowork.open",
            "marketing.open",
            "panel.open",
            "persona.list",
        ] {
            assert!(
                SECRETARY_ALLOWED_CMDS.contains(&allowed),
                "{allowed} should be available to the secretary"
            );
        }
    }

    #[test]
    fn origin_ok_blocks_cross_site() {
        use axum::http::header::{HeaderMap, HeaderValue, HOST, ORIGIN};
        // No origin (native client) → allowed.
        assert!(origin_ok(&HeaderMap::new()));
        // Loopback origin → allowed.
        let mut h = HeaderMap::new();
        h.insert(ORIGIN, HeaderValue::from_static("http://127.0.0.1:19980"));
        assert!(origin_ok(&h));
        // Same-origin as Host → allowed.
        let mut h = HeaderMap::new();
        h.insert(ORIGIN, HeaderValue::from_static("https://x.ngrok.app"));
        h.insert(HOST, HeaderValue::from_static("x.ngrok.app"));
        assert!(origin_ok(&h));
        // Cross-site → blocked.
        let mut h = HeaderMap::new();
        h.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        h.insert(HOST, HeaderValue::from_static("x.ngrok.app"));
        assert!(!origin_ok(&h));
    }
}
