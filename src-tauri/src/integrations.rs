//! External integrations: MCP client.

use crate::get_env_value;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri::{AppHandle, State};

// ── MCP Client ──

pub struct McpClient {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    pending: std::sync::Arc<
        Mutex<HashMap<u64, std::sync::mpsc::Sender<Result<serde_json::Value, String>>>>,
    >,
    next_id: std::sync::atomic::AtomicU64,
}

impl McpClient {
    pub fn start(
        command: String,
        args: Vec<String>,
        env: Option<HashMap<String, String>>,
        cwd: Option<String>,
    ) -> Result<Self, String> {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;

        let mut cmd = crate::common::no_window_command(command);
        cmd.args(args);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::null());
        if let Some(dir) = cwd {
            if !dir.trim().is_empty() {
                cmd.current_dir(dir);
            }
        }
        if let Some(map) = env {
            for (k, v) in map {
                cmd.env(k, v);
            }
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open MCP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to open MCP stdout".to_string())?;

        let pending: std::sync::Arc<
            Mutex<HashMap<u64, std::sync::mpsc::Sender<Result<serde_json::Value, String>>>>,
        > = std::sync::Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                let v: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let id = v.get("id").and_then(|x| x.as_u64());
                if let Some(id) = id {
                    let tx = pending_for_reader.lock().unwrap().remove(&id);
                    if let Some(tx) = tx {
                        if let Some(err) = v.get("error") {
                            let msg = err
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("MCP error")
                                .to_string();
                            let _ = tx.send(Err(msg));
                        } else {
                            let result =
                                v.get("result").cloned().unwrap_or(serde_json::Value::Null);
                            let _ = tx.send(Ok(result));
                        }
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            pending,
            next_id: std::sync::atomic::AtomicU64::new(1),
        })
    }

    pub fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        use std::io::Write;
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let s = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(s.as_bytes())
            .map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;

        match rx.recv_timeout(std::time::Duration::from_secs(90)) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("MCP request timeout".to_string()),
        }
    }

    pub fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), String> {
        use std::io::Write;
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let s = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        self.stdin
            .write_all(s.as_bytes())
            .map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub struct McpState {
    pub mcp: Mutex<HashMap<String, McpClient>>,
}

fn resolve_pi_browser_dir(app: &AppHandle) -> Result<String, String> {
    if let Ok(dir) = app
        .path()
        .resolve("resources/pi-browser", BaseDirectory::Resource)
    {
        if dir.exists() {
            return Ok(dir.to_string_lossy().to_string());
        }
    }

    if let Some(v) = get_env_value("PI_BROWSER_DIR") {
        let s = v.trim().to_string();
        if !s.is_empty() {
            return Ok(s);
        }
    }

    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(format!("{}/pi-browser", home.trim_end_matches('/')))
}

fn resolve_bundled_node(app: &AppHandle) -> Option<String> {
    let candidates = [
        app.path()
            .resolve(
                "resources/bin/node-aarch64-apple-darwin",
                BaseDirectory::Resource,
            )
            .ok(),
        app.path()
            .resolve("resources/bin/node", BaseDirectory::Resource)
            .ok(),
        app.path().resolve("bin/node", BaseDirectory::Resource).ok(),
        app.path().resolve("node", BaseDirectory::Resource).ok(),
    ];
    for c in candidates.into_iter().flatten() {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

fn mcp_spawn_in_dir(
    state: &McpState,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut map = state.mcp.lock().unwrap();
    if map.contains_key(&name) {
        return Ok(());
    }
    let client = McpClient::start(command, args, env, cwd)?;
    let mut_client = map.entry(name).or_insert(client);
    mut_client.notify("notifications/initialized", serde_json::json!({}))?;
    mut_client.request(
        "initialize",
        serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "octo-ide", "version": "1.0.0" }
        }),
    )?;
    Ok(())
}

#[tauri::command]
pub fn mcp_spawn(
    state: State<'_, McpState>,
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    mcp_spawn_in_dir(&state, name, command, args, env, None)
}

#[tauri::command]
pub fn pi_browser_spawn(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
) -> Result<(), String> {
    let dir = resolve_pi_browser_dir(&app)?;
    // Bundled node first (installed app), then known install prefixes / nvm,
    // and only then the bare name — a Finder-launched app's PATH usually omits
    // node so `Command::new("node")` would fail.
    let node = resolve_bundled_node(&app)
        .or_else(|| {
            let nvm = crate::common::nvm_node_bin_dir().into_iter().collect::<Vec<_>>();
            crate::common::resolve_tool_path("node", &nvm).map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "node".to_string());

    let entry = format!("{}/index.js", dir);
    if !std::path::Path::new(&entry).exists() {
        return Err(format!("pi-browser entry not found: {}", entry));
    }

    mcp_spawn_in_dir(&state, name, node, vec![entry], None, Some(dir))
}

#[tauri::command]
pub fn mcp_stop(state: State<'_, McpState>, name: String) -> Result<(), String> {
    let mut map = state.mcp.lock().unwrap();
    if let Some(mut client) = map.remove(&name) {
        let _ = client.child.kill();
        let _ = client.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_tools_list(
    state: State<'_, McpState>,
    name: String,
) -> Result<serde_json::Value, String> {
    let mut map = state.mcp.lock().unwrap();
    let client = map
        .get_mut(&name)
        .ok_or_else(|| format!("MCP client '{}' not found", name))?;
    client.request("tools/list", serde_json::json!({}))
}

#[tauri::command]
pub fn mcp_tools_call(
    state: State<'_, McpState>,
    name: String,
    tool_name: String,
    arguments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut map = state.mcp.lock().unwrap();
    let client = map
        .get_mut(&name)
        .ok_or_else(|| format!("MCP client '{}' not found", name))?;
    client.request(
        "tools/call",
        serde_json::json!({
            "name": tool_name,
            "arguments": arguments.unwrap_or(serde_json::json!({})),
        }),
    )
}
