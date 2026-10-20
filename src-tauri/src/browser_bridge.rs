//! Local HTTP server for the BBARIT MCP invoke API and the embedded web terminal.
//!
//! Routes:
//!   - GET  /health          — liveness probe
//!   - POST /api/invoke      — generic command dispatch for MCP clients
//!   - GET  /api/commands    — list available commands
//!   - GET  /web             — embedded xterm.js web terminal UI
//!   - WS   /ws/terminal/{id} — PTY I/O
//!   - POST /api/ngrok/*     — ngrok tunnel control

use axum::{
    body::Body,
    extract::State as AxumState,
    http::{
        header::{HOST, ORIGIN},
        HeaderMap, Request, StatusCode,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::web_terminal::{self, NgrokState, WebTerminalState};

/// Port for the local bridge HTTP server.
///
/// Debug builds use a separate port so a dev app does not collide with an
/// installed release app that is already holding 19980 (mirrors the mcp-bridge
/// 9323/9223 dev/release split).
///
/// Local port map (release/debug, loopback unless noted):
/// - 19980/19981 this bridge (`/api/invoke`, `/editor`, `/gateway/ui`)
/// - 19970/19971 `REMOTE_PORT` (token-authenticated; the only tunnelled port)
/// - 19982 LAN discovery beacons (UDP, broadcast)
/// - 19985/19986 design server (`design_http.rs`)
/// - 19990 collab host (`collab.rs`, also the CollabPanel default)
/// - 9223/9323 tauri-plugin-mcp-bridge WebSocket (release: opt-in via
///   browser Origins are refused by the vendored plugin)
/// - 9666 WebView2 CDP, Windows only (off with `BBARIT_NO_CDP`)
/// Keep new listeners off these numbers.
#[cfg(debug_assertions)]
pub const BRIDGE_PORT: u16 = 19981;
#[cfg(not(debug_assertions))]
pub const BRIDGE_PORT: u16 = 19980;

/// Port for the EXTERNAL-facing server (web terminal + gateway chat/WS). Every
/// route here is token-authenticated. This is the ONLY port a tunnel
/// (ngrok/cloudflared) is ever pointed at, so the unauthenticated local routes
/// on BRIDGE_PORT (/api/invoke, /editor, /gateway/ui) are never reachable from
/// the internet — the C3 fix from the gateway security audit.
#[cfg(debug_assertions)]
pub const REMOTE_PORT: u16 = 19971;
#[cfg(not(debug_assertions))]
pub const REMOTE_PORT: u16 = 19970;

// ── Axum server ──

#[derive(Clone)]
struct BridgeCtx {
    app_handle: AppHandle,
}

pub async fn start_browser_bridge(
    app_handle: AppHandle,
    web_state: Arc<WebTerminalState>,
    ngrok_state: Arc<NgrokState>,
) {
    let bridge_ctx = BridgeCtx { app_handle };

    let gateway_ctx = crate::agent_gateway::GatewayCtx {
        app_handle: bridge_ctx.app_handle.clone(),
    };

    // ── LOCAL server (BRIDGE_PORT): unauthenticated, trusted-local routes. ──
    // NEVER exposed through a tunnel. Loopback alone is not enough, though: a
    // web page in the user's normal browser can POST here too, so the router is
    // wrapped in `with_local_guard` (Host must be loopback, Origin must be one
    // of this app's own webview origins, CORS limited to the same).
    let local_app = Router::new()
        .route("/health", get(handle_health))
        .route("/api/invoke", post(handle_invoke))
        .route("/api/commands", get(handle_list_commands))
        .route("/editor", post(handle_editor))
        .with_state(bridge_ctx.clone())
        // POST /gateway/ui — the agent's app_control tool drives the app UI. It
        // authenticates with the internal UI token, and lives on the LOCAL port
        // so it is never tunneled. (The agent runs locally and reaches it here.)
        .merge(
            Router::new()
                .route("/gateway/ui", post(crate::agent_gateway::handle_gateway_ui))
                .with_state(gateway_ctx.clone()),
        );
    let local_app = with_local_guard(local_app, BRIDGE_PORT);

    // ── REMOTE server (REMOTE_PORT): every route token-authenticated. ──
    // This is the ONLY server a tunnel points at. No permissive CORS layer:
    // browsers reach it same-origin (the served pages) and WS auth checks Origin.
    let web_routes = Router::new()
        .route("/web", get(web_terminal::serve_web_page))
        .route(
            "/api/terminal",
            get(web_terminal::handle_list_terminals).post(web_terminal::handle_create_terminal),
        )
        .route(
            "/api/terminal/{id}",
            delete(web_terminal::handle_close_terminal),
        )
        .route(
            "/api/terminal/{id}/resize",
            post(web_terminal::handle_resize_terminal),
        )
        .route("/ws/terminal/{id}", get(web_terminal::handle_ws_terminal))
        .route("/api/ngrok/start", post(web_terminal::handle_ngrok_start))
        .route("/api/ngrok/stop", post(web_terminal::handle_ngrok_stop))
        .route("/api/ngrok/status", get(web_terminal::handle_ngrok_status))
        .route("/api/files", get(web_terminal::handle_list_files))
        .route(
            "/api/file",
            get(web_terminal::handle_read_file).post(web_terminal::handle_write_file),
        )
        .route("/api/kv", get(web_terminal::handle_kv_get))
        .layer(axum::Extension(ngrok_state))
        .with_state(web_state.clone());
    let gateway_public = Router::new()
        .route("/gateway", get(crate::agent_gateway::serve_gateway_chat))
        .route("/gateway/avatar", get(crate::agent_gateway::serve_gateway_avatar))
        .route("/gateway/ws", get(crate::agent_gateway::handle_gateway_ws))
        .route("/gateway/appstate", get(crate::agent_gateway::handle_gateway_appstate))
        .with_state(gateway_ctx);
    let remote_app = Router::new()
        .route("/health", get(handle_health))
        .merge(web_routes)
        .merge(gateway_public);

    let local_addr = format!("127.0.0.1:{BRIDGE_PORT}");
    let remote_addr = format!("127.0.0.1:{REMOTE_PORT}");
    safe_eprintln!("[browser-bridge] local (trusted) on {local_addr}");
    safe_eprintln!("[browser-bridge] remote (auth, tunnelable) on {remote_addr}");
    safe_eprintln!("[web-terminal] access at http://{remote_addr}/web");
    safe_eprintln!("[gateway] secretary chat at http://{remote_addr}/gateway");
    safe_eprintln!("[web-terminal] token: {}", web_state.token());

    // Run both servers concurrently; if either fails to bind, log and continue
    // with whichever bound (the remote one is what tunnels use).
    let remote = async move {
        if let Some(listener) = bind_with_retry(&remote_addr, "remote").await {
            if let Err(e) = axum::serve(listener, remote_app).await {
                safe_eprintln!("[browser-bridge] remote server error: {e}");
            }
        }
    };
    let local = async move {
        if let Some(listener) = bind_with_retry(&local_addr, "local").await {
            if let Err(e) = axum::serve(listener, local_app).await {
                safe_eprintln!("[browser-bridge] local server error: {e}");
            }
        }
    };
    tokio::join!(remote, local);
}

/// Bind a loopback listener with a short retry (a briefly-lingering socket after
/// an unclean shutdown), and mark it non-inheritable so a later PTY/WebView2
/// child can't keep the port open as a zombie LISTENING socket.
async fn bind_with_retry(addr: &str, label: &str) -> Option<tokio::net::TcpListener> {
    let mut attempt = 0;
    let listener = loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => break l,
            Err(e) if attempt < 5 => {
                attempt += 1;
                safe_eprintln!(
                    "[browser-bridge] bind {addr} ({label}) failed (attempt {attempt}/5): {e} — retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            }
            Err(e) => {
                safe_eprintln!(
                    "[browser-bridge] bind {addr} ({label}) failed after retries: {e}. \
                     The {label} bridge is DISABLED this session."
                );
                return None;
            }
        }
    };
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        let raw = listener.as_raw_socket();
        // SAFETY: `raw` is a valid socket handle owned by `listener` for its
        // lifetime; clearing the inherit flag is a benign, idempotent op.
        unsafe {
            SetHandleInformation(raw as _, HANDLE_FLAG_INHERIT, 0);
        }
    }
    Some(listener)
}

async fn handle_health() -> &'static str {
    "ok"
}

// ── Loopback request guard ──
//
// The LOCAL server is unauthenticated by design: native CLIs, the embedded
// agent, and MCP servers on this machine call it without a token. The only
// thing between a malicious web page and `run_cli_oneshot` is therefore the
// browser itself, and two header checks make that hold:
//   * `Host` must name loopback for this port. Blocks DNS rebinding, where
//     attacker.example resolves to 127.0.0.1 so the page is "same-origin".
//   * `Origin`, when present, must be one of this app's own webview origins.
//     Browsers attach Origin to every cross-origin request and to all POSTs,
//     so a page on any other site is refused before the handler runs. Native
//     HTTP clients send no Origin and pass through.
// CORS is restricted to the same origins so preflights from other sites fail.

/// Vite dev server origin (`npm run dev` / `tauri:dev`); only a dev build loads
/// its UI from there.
#[cfg(debug_assertions)]
const DEV_UI_PORT: u16 = 5175;

pub(crate) fn local_origin_allowed(origin: &str, port: u16) -> bool {
    let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    if matches!(
        origin.as_str(),
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    let mut ports = vec![port];
    #[cfg(debug_assertions)]
    ports.push(DEV_UI_PORT);
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        for p in &ports {
            if origin == format!("http://{host}:{p}") {
                return true;
            }
        }
    }
    false
}

pub(crate) fn loopback_host_allowed(host: &str, port: u16) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let (name, port_part): (String, Option<&str>) = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((ip, tail)) => (format!("[{ip}]"), tail.strip_prefix(':')),
            None => return false,
        }
    } else {
        match host.rsplit_once(':') {
            Some((name, p)) => (name.to_string(), Some(p)),
            None => (host.clone(), None),
        }
    };
    if !matches!(name.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return false;
    }
    match port_part {
        None => true,
        Some(p) => p.parse::<u16>().ok() == Some(port),
    }
}

pub(crate) fn local_request_allowed(headers: &HeaderMap, port: u16) -> Result<(), &'static str> {
    // Every real client (browsers, reqwest, Node fetch, curl) sends Host on
    // HTTP/1.1, so requiring it costs nothing and makes the rebinding check
    // unconditional.
    let host = headers.get(HOST).ok_or("missing Host header")?;
    let host = host.to_str().map_err(|_| "unreadable Host header")?;
    if !loopback_host_allowed(host, port) {
        return Err("Host is not loopback");
    }
    if let Some(origin) = headers.get(ORIGIN) {
        let origin = origin.to_str().map_err(|_| "unreadable Origin header")?;
        if !local_origin_allowed(origin, port) {
            return Err("Origin is not this app");
        }
    }
    Ok(())
}

async fn local_guard(
    AxumState(port): AxumState<u16>,
    req: Request<Body>,
    next: Next,
) -> Response {
    match local_request_allowed(req.headers(), port) {
        Ok(()) => next.run(req).await,
        Err(reason) => {
            safe_eprintln!(
                "[browser-bridge] refused {} {} on :{port}: {reason}",
                req.method(),
                req.uri().path()
            );
            (StatusCode::FORBIDDEN, format!("forbidden: {reason}")).into_response()
        }
    }
}

fn local_cors(port: u16) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .map(|o| local_origin_allowed(o, port))
                .unwrap_or(false)
        }))
        .allow_methods(Any)
        .allow_headers(Any)
}

/// Wrap a loopback-only router (the LOCAL bridge, the design server) with the
/// Host/Origin guard and the matching CORS policy. The guard is the outer
/// layer, so a refused preflight never reaches CORS either.
pub(crate) fn with_local_guard(router: Router, port: u16) -> Router {
    router
        .layer(local_cors(port))
        .layer(middleware::from_fn_with_state(port, local_guard))
}

#[cfg(test)]
mod local_guard_tests {
    use super::*;
    use axum::http::HeaderValue;

    const PORT: u16 = 19980;

    #[test]
    fn app_webview_origins_pass() {
        assert!(local_origin_allowed("tauri://localhost", PORT));
        assert!(local_origin_allowed("http://tauri.localhost", PORT));
        assert!(local_origin_allowed("HTTP://TAURI.LOCALHOST/", PORT));
        assert!(local_origin_allowed("http://127.0.0.1:19980", PORT));
        assert!(local_origin_allowed("http://localhost:19980", PORT));
    }

    #[test]
    fn foreign_origins_fail() {
        assert!(!local_origin_allowed("https://evil.example", PORT));
        assert!(!local_origin_allowed("http://127.0.0.1:19981", PORT));
        assert!(!local_origin_allowed("null", PORT));
        assert!(!local_origin_allowed("", PORT));
        assert!(!local_origin_allowed("http://127.0.0.1.evil.example:19980", PORT));
    }

    #[test]
    fn host_must_be_loopback_for_this_port() {
        assert!(loopback_host_allowed("127.0.0.1:19980", PORT));
        assert!(loopback_host_allowed("localhost:19980", PORT));
        assert!(loopback_host_allowed("[::1]:19980", PORT));
        assert!(loopback_host_allowed("127.0.0.1", PORT));
        assert!(!loopback_host_allowed("127.0.0.1:19981", PORT));
        assert!(!loopback_host_allowed("rebind.evil.example:19980", PORT));
        assert!(!loopback_host_allowed("127.0.0.1.evil.example:19980", PORT));
        assert!(!loopback_host_allowed("[::1", PORT));
    }

    #[test]
    fn native_client_without_origin_passes() {
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("127.0.0.1:19980"));
        assert!(local_request_allowed(&h, PORT).is_ok());
        assert_eq!(
            local_request_allowed(&HeaderMap::new(), PORT),
            Err("missing Host header")
        );
    }

    #[test]
    fn browser_page_on_other_site_is_refused() {
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("127.0.0.1:19980"));
        h.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        assert_eq!(local_request_allowed(&h, PORT), Err("Origin is not this app"));
    }

    #[test]
    fn dns_rebinding_is_refused() {
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("rebind.evil.example:19980"));
        assert_eq!(local_request_allowed(&h, PORT), Err("Host is not loopback"));
    }

    #[test]
    fn app_webview_request_passes() {
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("localhost:19980"));
        h.insert(ORIGIN, HeaderValue::from_static("tauri://localhost"));
        assert!(local_request_allowed(&h, PORT).is_ok());
    }
}

// ── Editor control bridge ──
//
// Mirrors the browser-bridge trust model: a local HTTP POST is turned into a
// Tauri event that the frontend answers via the `editor_bridge_respond`
// command. Each request parks a oneshot sender in EDITOR_PENDING keyed by a
// unique id; the frontend hands that id back so we can resolve the right one.

static EDITOR_PENDING: Lazy<Mutex<HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static EDITOR_SEQ: AtomicU64 = AtomicU64::new(0);

/// Resolve a pending editor-bridge request with the frontend's result.
/// Returns false when the id is unknown (already resolved or timed out).
pub fn editor_resolve(request_id: &str, result: serde_json::Value) -> bool {
    let sender = EDITOR_PENDING.lock().unwrap().remove(request_id);
    match sender {
        Some(tx) => tx.send(result).is_ok(),
        None => false,
    }
}

async fn handle_editor(
    AxumState(ctx): AxumState<BridgeCtx>,
    Json(req): Json<serde_json::Value>,
) -> (StatusCode, Json<InvokeResponse>) {
    let seq = EDITOR_SEQ.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let request_id = format!("editor-{now}-{seq}");

    let (tx, rx) = tokio::sync::oneshot::channel();
    EDITOR_PENDING
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    let payload = serde_json::json!({ "requestId": request_id, "request": req });
    if let Err(e) = ctx.app_handle.emit("editor-bridge-request", &payload) {
        EDITOR_PENDING.lock().unwrap().remove(&request_id);
        return err_json(format!("failed to emit editor-bridge-request: {e}"));
    }

    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(value)) => ok_json(value),
        Ok(Err(_)) => {
            EDITOR_PENDING.lock().unwrap().remove(&request_id);
            err_json("editor bridge channel closed before responding".into())
        }
        Err(_) => {
            EDITOR_PENDING.lock().unwrap().remove(&request_id);
            err_json(
                "editor bridge timed out (30s) — is BBARIT Terminal running with an editor visible?"
                    .into(),
            )
        }
    }
}

// ── Generic invoke proxy for MCP tools ──

#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct InvokeResponse {
    pub success: bool,
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn ok_json(data: serde_json::Value) -> (StatusCode, Json<InvokeResponse>) {
    (
        StatusCode::OK,
        Json(InvokeResponse {
            success: true,
            data,
            error: None,
        }),
    )
}

fn err_json(msg: String) -> (StatusCode, Json<InvokeResponse>) {
    (
        StatusCode::OK,
        Json(InvokeResponse {
            success: false,
            data: serde_json::Value::Null,
            error: Some(msg),
        }),
    )
}

macro_rules! arg_str {
    ($args:expr, $key:expr) => {
        $args
            .get($key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
}

macro_rules! arg_str_opt {
    ($args:expr, $key:expr) => {
        $args
            .get($key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
}

fn arg_str_any(args: &serde_json::Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

fn arg_bool_any(args: &serde_json::Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(|v| v.as_bool()))
}


async fn handle_invoke(
    AxumState(ctx): AxumState<BridgeCtx>,
    Json(req): Json<InvokeRequest>,
) -> (StatusCode, Json<InvokeResponse>) {
    let args = &req.args;
    let app = &ctx.app_handle;

    match req.command.as_str() {
        // ── File Operations ──
        "read_directory" => {
            let path = arg_str!(args, "path");
            match crate::read_directory(path).await {
                Ok(entries) => ok_json(serde_json::to_value(entries).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "read_file" => {
            let path = arg_str!(args, "path");
            match crate::read_file(path) {
                Ok(content) => ok_json(serde_json::Value::String(content)),
                Err(e) => err_json(e),
            }
        }
        "write_file" => {
            let path = arg_str!(args, "path");
            let content = arg_str!(args, "content");
            match crate::write_file(path, content) {
                Ok(()) => ok_json(serde_json::json!({"written": true})),
                Err(e) => err_json(e),
            }
        }
        "create_directory" => {
            let path = arg_str!(args, "path");
            match crate::create_directory(path) {
                Ok(()) => ok_json(serde_json::json!({"created": true})),
                Err(e) => err_json(e),
            }
        }
        "create_empty_file" => {
            let path = arg_str!(args, "path");
            match crate::create_empty_file(path) {
                Ok(()) => ok_json(serde_json::json!({"created": true})),
                Err(e) => err_json(e),
            }
        }
        "delete_path" => {
            let path = arg_str!(args, "path");
            match crate::delete_path(path) {
                Ok(()) => ok_json(serde_json::json!({"deleted": true})),
                Err(e) => err_json(e),
            }
        }
        "rename_path" => {
            let from = arg_str!(args, "from");
            let to = arg_str!(args, "to");
            match crate::rename_path(from, to) {
                Ok(()) => ok_json(serde_json::json!({"renamed": true})),
                Err(e) => err_json(e),
            }
        }
        "copy_path" => {
            let from = arg_str!(args, "from");
            let to = arg_str!(args, "to");
            match crate::copy_path(from, to) {
                Ok(()) => ok_json(serde_json::json!({"copied": true})),
                Err(e) => err_json(e),
            }
        }
        "search_files" => {
            let root = arg_str!(args, "root");
            let query = arg_str!(args, "query");
            let search_content =
                arg_bool_any(args, &["search_content", "searchContent"]).unwrap_or(false);
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            match crate::search_files(root, query, search_content, limit) {
                Ok(results) => ok_json(serde_json::to_value(results).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "code_search" => {
            let root = arg_str!(args, "root");
            let query = arg_str!(args, "query");
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let mode = args.get("mode").and_then(|v| v.as_str()).map(|s| s.to_string());
            let include_text_files = arg_bool_any(args, &["include_text_files", "includeTextFiles"]);
            match crate::code_search::search(root, query, limit, mode, include_text_files) {
                Ok(results) => ok_json(serde_json::to_value(results).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "code_find_related" => {
            let root = arg_str!(args, "root");
            let file_path = arg_str_any(args, &["file_path", "filePath"]);
            let line = args.get("line").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            let include_text_files = arg_bool_any(args, &["include_text_files", "includeTextFiles"]);
            match crate::code_search::find_related(root, file_path, line, limit, include_text_files) {
                Ok(results) => ok_json(serde_json::to_value(results).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "code_search_stats" => {
            let root = arg_str!(args, "root");
            let include_text_files = arg_bool_any(args, &["include_text_files", "includeTextFiles"]);
            match crate::code_search::stats(root, include_text_files) {
                Ok(stats) => ok_json(serde_json::to_value(stats).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "code_search_savings" => {
            match crate::code_search::savings() {
                Ok(stats) => ok_json(serde_json::to_value(stats).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "code_search_clear_cache" => {
            let root = arg_str_opt!(args, "root");
            match crate::code_search::clear_cache(root) {
                Ok(()) => ok_json(serde_json::json!({"cleared": true})),
                Err(e) => err_json(e),
            }
        }
        "list_project_files" => {
            let root = arg_str!(args, "root");
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
            match crate::fs_ops::list_project_files(root, limit) {
                Ok(results) => ok_json(serde_json::to_value(results).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "read_file_base64" => {
            let path = arg_str!(args, "path");
            match crate::read_file_base64(path).await {
                Ok(b64) => ok_json(serde_json::Value::String(b64)),
                Err(e) => err_json(e),
            }
        }
        "write_file_base64" => {
            let path = arg_str!(args, "path");
            let base64_data = arg_str!(args, "base64_data");
            match crate::write_file_base64(path, base64_data) {
                Ok(()) => ok_json(serde_json::json!({"written": true})),
                Err(e) => err_json(e),
            }
        }

        // ── Path Utilities ──
        "get_home_dir" => {
            match crate::get_home_dir(app.clone()) {
                Ok(dir) => ok_json(serde_json::Value::String(dir)),
                Err(e) => err_json(e),
            }
        }
        "get_config_path" => {
            match crate::get_config_path() {
                Ok(p) => ok_json(serde_json::Value::String(p)),
                Err(e) => err_json(e),
            }
        }
        "get_documents_dir" => {
            match crate::get_documents_dir() {
                Ok(p) => ok_json(serde_json::Value::String(p)),
                Err(e) => err_json(e),
            }
        }
        "path_join" => {
            let base = arg_str!(args, "base");
            let parts: Vec<String> = args.get("parts")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            match crate::path_join(base, parts) {
                Ok(p) => ok_json(serde_json::Value::String(p)),
                Err(e) => err_json(e),
            }
        }

        // ── Terminal / PTY ──
        // PTY commands require Tauri State which cannot be easily passed from axum.
        // Use run_cli_oneshot for command execution instead.
        // These PTY commands are available through the web terminal WebSocket API at /ws/terminal/{id}.
        "create_shell" | "write_to_pty" | "read_from_pty" | "resize_pty"
        | "close_pty" | "destroy_pty" | "check_pty_alive" | "read_pty_output_buffer" | "get_pty_cwd" => {
            err_json("PTY commands are not available via HTTP invoke. Use the WebSocket API at /ws/terminal/{id} or run_cli_oneshot instead.".into())
        }

        // ── CLI Oneshot ──
        "run_cli_oneshot" => {
            let command = arg_str!(args, "command");
            let work_dir = arg_str_opt!(args, "work_dir");
            let timeout_secs = args.get("timeout_secs").and_then(|v| v.as_u64());
            let login = args.get("login").and_then(|v| v.as_bool());
            match crate::run_cli_oneshot(command, work_dir, timeout_secs, login).await {
                Ok(output) => ok_json(serde_json::Value::String(output)),
                Err(e) => err_json(e),
            }
        }

        // ── Config ──
        "read_config" => {
            match crate::read_config() {
                Ok(c) => ok_json(serde_json::from_str(&c).unwrap_or(serde_json::Value::String(c))),
                Err(e) => err_json(e),
            }
        }
        "write_config" => {
            let json = arg_str!(args, "json");
            match crate::write_config(json) {
                Ok(()) => ok_json(serde_json::json!({"written": true})),
                Err(e) => err_json(e),
            }
        }

        // ── KV Store ──
        "kv_get" => {
            let key = arg_str!(args, "key");
            match crate::kv_get(key).await {
                Ok(val) => ok_json(serde_json::to_value(val).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "kv_set" => {
            let key = arg_str!(args, "key");
            let value = arg_str!(args, "value");
            match crate::kv_set(key, value).await {
                Ok(()) => ok_json(serde_json::json!({"set": true})),
                Err(e) => err_json(e),
            }
        }
        "kv_delete" => {
            let key = arg_str!(args, "key");
            match crate::kv_delete(key).await {
                Ok(deleted) => ok_json(serde_json::json!({"deleted": deleted})),
                Err(e) => err_json(e),
            }
        }
        "kv_get_many" => {
            let keys: Vec<String> = args.get("keys")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            match crate::kv_get_many(keys).await {
                Ok(map) => ok_json(serde_json::to_value(map).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }
        "kv_set_many" => {
            let entries: HashMap<String, String> = args.get("entries")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            match crate::kv_set_many(entries).await {
                Ok(()) => ok_json(serde_json::json!({"set": true})),
                Err(e) => err_json(e),
            }
        }

        // ── HTTP Proxy ──
        "http_request" => {
            match serde_json::from_value::<crate::HttpRequestInput>(args.clone()) {
                Ok(input) => match crate::http_request(input).await {
                    Ok(resp) => ok_json(serde_json::to_value(resp).unwrap_or_default()),
                    Err(e) => err_json(e),
                },
                Err(e) => err_json(format!("Invalid args: {e}")),
            }
        }

        // ── Git ──
        "git_is_repo" => {
            let dir = arg_str!(args, "dir");
            ok_json(serde_json::json!({"is_repo": crate::git_is_repo(dir)}))
        }
        "git_init_repo" => {
            let dir = arg_str!(args, "dir");
            match crate::git_init_repo(dir) {
                Ok(msg) => ok_json(serde_json::Value::String(msg)),
                Err(e) => err_json(e),
            }
        }
        "git_current_branch" => {
            let repo_dir = arg_str!(args, "repo_dir");
            match crate::git_current_branch(repo_dir) {
                Ok(b) => ok_json(serde_json::Value::String(b)),
                Err(e) => err_json(e),
            }
        }
        "git_has_uncommitted" => {
            let repo_dir = arg_str!(args, "repo_dir");
            match crate::git_has_uncommitted(repo_dir) {
                Ok(v) => ok_json(serde_json::json!({"has_uncommitted": v})),
                Err(e) => err_json(e),
            }
        }
        "git_stash_save" => {
            let repo_dir = arg_str!(args, "repo_dir");
            let message = arg_str!(args, "message");
            match crate::git_stash_save(repo_dir, message) {
                Ok(msg) => ok_json(serde_json::Value::String(msg)),
                Err(e) => err_json(e),
            }
        }
        "git_stash_pop" => {
            let repo_dir = arg_str!(args, "repo_dir");
            match crate::git_stash_pop(repo_dir) {
                Ok(msg) => ok_json(serde_json::Value::String(msg)),
                Err(e) => err_json(e),
            }
        }
        "git_worktree_add" => {
            let repo_dir = arg_str!(args, "repo_dir");
            let worktree_dir = arg_str!(args, "worktree_dir");
            let branch_name = arg_str!(args, "branch_name");
            match crate::git_worktree_add(repo_dir, worktree_dir, branch_name) {
                Ok(msg) => ok_json(serde_json::Value::String(msg)),
                Err(e) => err_json(e),
            }
        }
        "git_merge_branch" => {
            let repo_dir = arg_str!(args, "repo_dir");
            let branch_name = arg_str!(args, "branch_name");
            match crate::git_merge_branch(repo_dir, branch_name) {
                Ok(msg) => ok_json(serde_json::Value::String(msg)),
                Err(e) => err_json(e),
            }
        }
        "git_delete_branch" => {
            let repo_dir = arg_str!(args, "repo_dir");
            let branch_name = arg_str!(args, "branch_name");
            match crate::git_delete_branch(repo_dir, branch_name) {
                Ok(()) => ok_json(serde_json::json!({"deleted": true})),
                Err(e) => err_json(e),
            }
        }

        // ── SSH ──
        "read_ssh_config" => {
            match crate::read_ssh_config() {
                Ok(c) => ok_json(serde_json::Value::String(c)),
                Err(e) => err_json(e),
            }
        }

        // ── Process ──
        "get_process_stats" => {
            let stats = crate::get_process_stats();
            ok_json(serde_json::to_value(stats).unwrap_or_default())
        }

        // ── PM2 ──
        "pm2_list" => {
            let work_dir = arg_str!(args, "work_dir");
            match crate::pm2_list(work_dir) {
                Ok(list) => ok_json(serde_json::from_str(&list).unwrap_or(serde_json::Value::String(list))),
                Err(e) => err_json(e),
            }
        }
        "pm2_action" => {
            let work_dir = arg_str!(args, "work_dir");
            let action = arg_str!(args, "action");
            let app_name = arg_str!(args, "app_name");
            match crate::pm2_action(work_dir, action, app_name) {
                Ok(r) => ok_json(serde_json::Value::String(r)),
                Err(e) => err_json(e),
            }
        }

        // ── Telegram ──
        "telegram_send_message" => {
            let text = arg_str!(args, "text");
            let reply_markup_json = arg_str_opt!(args, "reply_markup_json");
            match crate::telegram_send_message(text, reply_markup_json).await {
                Ok(()) => ok_json(serde_json::json!({"sent": true})),
                Err(e) => err_json(e),
            }
        }
        "telegram_get_updates" => {
            let offset = args.get("offset").and_then(|v| v.as_i64());
            match crate::telegram_get_updates(offset).await {
                Ok(updates) => ok_json(serde_json::to_value(updates).unwrap_or_default()),
                Err(e) => err_json(e),
            }
        }

        // ── Discord ──
        "discord_send_message" => {
            let bot_token = arg_str!(args, "bot_token");
            let channel_id = arg_str!(args, "channel_id");
            let text = arg_str!(args, "text");
            match crate::discord_send_message(bot_token, channel_id, text).await {
                Ok(()) => ok_json(serde_json::json!({"sent": true})),
                Err(e) => err_json(e),
            }
        }

        // ── Slack ──
        "slack_send_message" => {
            let bot_token = arg_str!(args, "bot_token");
            let channel = arg_str!(args, "channel");
            let text = arg_str!(args, "text");
            match crate::slack_send_message(bot_token, channel, text).await {
                Ok(()) => ok_json(serde_json::json!({"sent": true})),
                Err(e) => err_json(e),
            }
        }

        // ── Server Stats ──
        "server_stats" => {
            let work_dir = arg_str!(args, "work_dir");
            match crate::server_stats(work_dir) {
                Ok(s) => ok_json(serde_json::from_str(&s).unwrap_or(serde_json::Value::String(s))),
                Err(e) => err_json(e),
            }
        }

        // ── Debug ──
        "debug_log" => {
            let message = arg_str!(args, "message");
            crate::debug_log(message);
            ok_json(serde_json::json!({"logged": true}))
        }

        // ── Claude Design (makeke port) ──
        "claude_design_generate" => {
            let request_val = args.get("request").cloned().unwrap_or(serde_json::Value::Null);
            let request: crate::claude_design::ClaudeDesignGenerateRequest =
                match serde_json::from_value(request_val) {
                    Ok(r) => r,
                    Err(e) => return err_json(format!("invalid request: {}", e)),
                };
            let key = args
                .get("geminiApiKey")
                .or_else(|| args.get("gemini_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match crate::claude_design::claude_design_generate(request, key).await {
                Ok(resp) => ok_json(serde_json::json!(resp)),
                Err(e) => err_json(e),
            }
        }
        "claude_design_edit" => {
            let request_val = args.get("request").cloned().unwrap_or(serde_json::Value::Null);
            let request: crate::claude_design::ClaudeDesignEditRequest =
                match serde_json::from_value(request_val) {
                    Ok(r) => r,
                    Err(e) => return err_json(format!("invalid request: {}", e)),
                };
            let key = args
                .get("geminiApiKey")
                .or_else(|| args.get("gemini_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match crate::claude_design::claude_design_edit(request, key).await {
                Ok(resp) => ok_json(serde_json::json!(resp)),
                Err(e) => err_json(e),
            }
        }
        "claude_design_save" => {
            let request_val = args.get("request").cloned().unwrap_or(serde_json::Value::Null);
            let request: crate::claude_design::ClaudeDesignSaveRequest =
                match serde_json::from_value(request_val) {
                    Ok(r) => r,
                    Err(e) => return err_json(format!("invalid request: {}", e)),
                };
            match crate::claude_design::claude_design_save(request).await {
                Ok(resp) => ok_json(serde_json::json!(resp)),
                Err(e) => err_json(e),
            }
        }
        "claude_design_list" => {
            match crate::claude_design::claude_design_list().await {
                Ok(resp) => ok_json(serde_json::json!(resp)),
                Err(e) => err_json(e),
            }
        }
        "claude_design_load" => {
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            match crate::claude_design::claude_design_load(id).await {
                Ok(html) => ok_json(serde_json::json!({ "html": html })),
                Err(e) => err_json(e),
            }
        }
        "makeke_text_generate" => {
            let request_val = args.get("request").cloned().unwrap_or(serde_json::Value::Null);
            let request: crate::claude_design::MakekeTextRequest =
                match serde_json::from_value(request_val) {
                    Ok(r) => r,
                    Err(e) => return err_json(format!("invalid request: {}", e)),
                };
            let key = args
                .get("geminiApiKey")
                .or_else(|| args.get("gemini_api_key"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match crate::claude_design::makeke_text_generate(request, key).await {
                Ok(resp) => ok_json(serde_json::json!(resp)),
                Err(e) => err_json(e),
            }
        }

        _ => err_json(format!("Unknown command: {}", req.command)),
    }
}

/// List all available MCP-invokable commands.
async fn handle_list_commands() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "commands": [
            // File
            {"name": "read_directory", "args": ["path"], "desc": "List directory entries"},
            {"name": "read_file", "args": ["path"], "desc": "Read file as text"},
            {"name": "write_file", "args": ["path", "content"], "desc": "Write text file"},
            {"name": "create_directory", "args": ["path"], "desc": "Create directory"},
            {"name": "create_empty_file", "args": ["path"], "desc": "Create empty file"},
            {"name": "delete_path", "args": ["path"], "desc": "Delete file or directory"},
            {"name": "rename_path", "args": ["from", "to"], "desc": "Rename/move path"},
            {"name": "copy_path", "args": ["from", "to"], "desc": "Copy file or directory"},
            {"name": "search_files", "args": ["root", "query", "search_content?", "limit?"], "desc": "Search files by name or content"},
            {"name": "code_search", "args": ["root", "query", "limit?", "mode?", "include_text_files?"], "desc": "Semble-style Rust code search over relevant chunks"},
            {"name": "code_find_related", "args": ["root", "file_path", "line", "limit?", "include_text_files?"], "desc": "Find chunks related to a known code location"},
            {"name": "code_search_stats", "args": ["root", "include_text_files?"], "desc": "Build or inspect the Rust code-search index"},
            {"name": "code_search_savings", "args": [], "desc": "Show Rust code-search token savings"},
            {"name": "code_search_clear_cache", "args": ["root?"], "desc": "Clear cached Rust code-search indexes"},
            {"name": "read_file_base64", "args": ["path"], "desc": "Read file as base64"},
            {"name": "write_file_base64", "args": ["path", "base64_data"], "desc": "Write file from base64"},
            // Path
            {"name": "get_home_dir", "args": [], "desc": "Get user home directory"},
            {"name": "get_config_path", "args": [], "desc": "Get Octo config path"},
            {"name": "get_documents_dir", "args": [], "desc": "Get Documents directory"},
            {"name": "path_join", "args": ["base", "parts"], "desc": "Join path segments"},
            // Terminal
            {"name": "create_shell", "args": ["terminal_id", "work_dir", "rows?", "cols?", "shell_type?"], "desc": "Create PTY shell"},
            {"name": "write_to_pty", "args": ["terminal_id", "data"], "desc": "Write to PTY"},
            {"name": "read_from_pty", "args": ["terminal_id"], "desc": "Read PTY output"},
            {"name": "resize_pty", "args": ["terminal_id", "rows", "cols"], "desc": "Resize PTY"},
            {"name": "close_pty", "args": ["terminal_id"], "desc": "Close PTY"},
            {"name": "destroy_pty", "args": ["terminal_id"], "desc": "Destroy PTY"},
            {"name": "check_pty_alive", "args": ["terminal_id"], "desc": "Check if PTY is alive"},
            {"name": "read_pty_output_buffer", "args": ["terminal_id"], "desc": "Read accumulated PTY output"},
            {"name": "get_pty_cwd", "args": ["terminal_id"], "desc": "Get PTY working directory"},
            {"name": "run_cli_oneshot", "args": ["command", "work_dir?", "timeout_secs?"], "desc": "Run shell command and get output"},
            // Config
            {"name": "read_config", "args": [], "desc": "Read Octo config"},
            {"name": "write_config", "args": ["json"], "desc": "Write Octo config"},
            // KV
            {"name": "kv_get", "args": ["key"], "desc": "Get KV value"},
            {"name": "kv_set", "args": ["key", "value"], "desc": "Set KV value"},
            {"name": "kv_delete", "args": ["key"], "desc": "Delete KV key"},
            {"name": "kv_get_many", "args": ["keys"], "desc": "Get multiple KV values"},
            {"name": "kv_set_many", "args": ["entries"], "desc": "Set multiple KV values"},
            // HTTP
            {"name": "http_request", "args": ["url", "method?", "headers?", "body?"], "desc": "HTTP proxy request"},
            // Git
            {"name": "git_is_repo", "args": ["dir"], "desc": "Check if directory is git repo"},
            {"name": "git_init_repo", "args": ["dir"], "desc": "Initialize git repo"},
            {"name": "git_current_branch", "args": ["repo_dir"], "desc": "Get current branch"},
            {"name": "git_has_uncommitted", "args": ["repo_dir"], "desc": "Check for uncommitted changes"},
            {"name": "git_stash_save", "args": ["repo_dir", "message"], "desc": "Git stash save"},
            {"name": "git_stash_pop", "args": ["repo_dir"], "desc": "Git stash pop"},
            {"name": "git_worktree_add", "args": ["repo_dir", "worktree_dir", "branch_name"], "desc": "Add git worktree"},
            {"name": "git_merge_branch", "args": ["repo_dir", "branch_name"], "desc": "Merge branch"},
            {"name": "git_delete_branch", "args": ["repo_dir", "branch_name"], "desc": "Delete branch"},
            // SSH
            {"name": "read_ssh_config", "args": [], "desc": "Read SSH config"},
            // Process
            {"name": "get_process_stats", "args": [], "desc": "Get process stats (CPU, memory)"},
            // PM2
            {"name": "pm2_list", "args": ["work_dir"], "desc": "List PM2 processes"},
            {"name": "pm2_action", "args": ["work_dir", "action", "app_name"], "desc": "PM2 start/stop/restart/delete"},
            // Messaging
            {"name": "telegram_send_message", "args": ["text", "reply_markup_json?"], "desc": "Send Telegram message"},
            {"name": "telegram_get_updates", "args": ["offset?"], "desc": "Get Telegram updates"},
            {"name": "discord_send_message", "args": ["bot_token", "channel_id", "text"], "desc": "Send Discord message"},
            {"name": "slack_send_message", "args": ["bot_token", "channel", "text"], "desc": "Send Slack message"},
            // Server
            {"name": "server_stats", "args": ["work_dir"], "desc": "Get server stats"},
            {"name": "server_analysis", "args": ["work_dir", "tool"], "desc": "Run SSH/local server analysis tool"},
            // Debug
            {"name": "debug_log", "args": ["message"], "desc": "Write debug log"},
        ]
    }))
}
