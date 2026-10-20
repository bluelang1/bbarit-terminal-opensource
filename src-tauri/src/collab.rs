//! Team collaboration relay server.
//!
//! Architecture:
//!   Host starts an axum WebSocket server on a configurable port.
//!   Clients (host's own frontend + remote peers) connect via ws:// URL.
//!   Each connection joins a room identified by a short shared code.
//!   Server broadcasts JSON change messages to all other peers in the same room.
//!
//! Message protocol (JSON lines):
//!   C→S: {type:"join", room:"ABC123", name:"user1"}
//!   C→S: {type:"change", kind:"kanban"|"notes", payload:..., ts: <ms>}
//!   C→S: {type:"ping"}
//!   S→C: {type:"joined", room, you:<peerId>, peers:[{id,name},...]}
//!   S→C: {type:"change", kind, payload, ts, from:<peerId>}
//!   S→C: {type:"peer_joined", peer:{id,name}}
//!   S→C: {type:"peer_left", peerId}
//!   S→C: {type:"error", message}
//!   S→C: {type:"pong"}

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State as AxumState,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use tokio::sync::{broadcast, Mutex as TokioMutex, RwLock};

/// Broadcast channel capacity per room.
const ROOM_BROADCAST_CAPACITY: usize = 256;

/// Default bind port for the collab server.
///
/// 19990 is kept clear of the loopback bridges (19980/19981), the design
/// server (19985/19986) and LAN discovery (UDP 19982); it previously shared
/// 19981 with the dev bridge and the release design server. The CollabPanel
/// defaults (`src/collab/CollabPanel.tsx`) must match.
pub const DEFAULT_COLLAB_PORT: u16 = 19990;

// ── Types ──

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    Joined {
        room: String,
        you: String,
        peers: Vec<PeerInfo>,
    },
    Change {
        kind: String,
        payload: serde_json::Value,
        ts: i64,
        from: String,
    },
    PeerJoined {
        peer: PeerInfo,
    },
    PeerLeft {
        peer_id: String,
    },
    Error {
        message: String,
    },
    Pong,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    Join {
        room: String,
        #[serde(default)]
        name: Option<String>,
    },
    Change {
        kind: String,
        payload: serde_json::Value,
        #[serde(default)]
        ts: Option<i64>,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
}

/// One room of peers sharing a broadcast channel.
struct Room {
    peers: HashMap<String, PeerInfo>,
    tx: broadcast::Sender<BroadcastMsg>,
}

#[derive(Debug, Clone)]
struct BroadcastMsg {
    exclude_peer: Option<String>,
    payload: ServerMsg,
}

/// Global collab state — single active host server per process.
pub struct CollabState {
    rooms: RwLock<HashMap<String, Room>>,
    server_shutdown: TokioMutex<Option<tokio::sync::oneshot::Sender<()>>>,
    server_info: RwLock<Option<ServerInfo>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub port: u16,
    pub room_code: String,
}

impl CollabState {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
            server_shutdown: TokioMutex::new(None),
            server_info: RwLock::new(None),
        }
    }
}

// ── Room code generator ──

fn generate_room_code() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..6)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

// ── WebSocket handler ──

async fn ws_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<Arc<CollabState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<CollabState>) {
    let (mut sender, mut receiver) = socket.split();
    let peer_id = uuid::Uuid::new_v4().to_string();
    let mut joined_room: Option<String> = None;
    let mut rx: Option<broadcast::Receiver<BroadcastMsg>>;

    // Forwarding task from broadcast → socket
    let (fwd_tx, mut fwd_rx) = tokio::sync::mpsc::unbounded_channel::<ServerMsg>();
    let fwd_tx_for_task = fwd_tx.clone();

    let send_task = tokio::spawn(async move {
        while let Some(msg) = fwd_rx.recv().await {
            let text = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        let _ = sender.close().await;
    });

    // Spawn broadcast listener once joined
    let mut bc_task: Option<tokio::task::JoinHandle<()>> = None;

    while let Some(msg) = receiver.next().await {
        let Ok(msg) = msg else { break };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            Message::Ping(p) => {
                // axum handles pong automatically if we ignore ping
                drop(p);
                continue;
            }
            _ => continue,
        };

        let client_msg: ClientMsg = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(err) => {
                let _ = fwd_tx.send(ServerMsg::Error {
                    message: format!("invalid message: {}", err),
                });
                continue;
            }
        };

        match client_msg {
            ClientMsg::Join { room, name } => {
                if joined_room.is_some() {
                    let _ = fwd_tx.send(ServerMsg::Error {
                        message: "already joined".into(),
                    });
                    continue;
                }
                let room_code = room.to_uppercase();
                let peer_name = name.unwrap_or_else(|| format!("peer-{}", &peer_id[..6]));
                let peer_info = PeerInfo {
                    id: peer_id.clone(),
                    name: peer_name,
                };

                // Validate room code
                let active_room = {
                    let rooms = state.rooms.read().await;
                    rooms.contains_key(&room_code)
                };
                if !active_room {
                    let _ = fwd_tx.send(ServerMsg::Error {
                        message: format!("unknown room: {}", room_code),
                    });
                    continue;
                }

                let (tx, peers_snapshot) = {
                    let mut rooms = state.rooms.write().await;
                    let room_ref = rooms.get_mut(&room_code).unwrap();
                    room_ref.peers.insert(peer_id.clone(), peer_info.clone());
                    (
                        room_ref.tx.clone(),
                        room_ref.peers.values().cloned().collect::<Vec<_>>(),
                    )
                };
                rx = Some(tx.subscribe());
                joined_room = Some(room_code.clone());

                let _ = fwd_tx.send(ServerMsg::Joined {
                    room: room_code.clone(),
                    you: peer_id.clone(),
                    peers: peers_snapshot,
                });

                // Notify others
                let _ = tx.send(BroadcastMsg {
                    exclude_peer: Some(peer_id.clone()),
                    payload: ServerMsg::PeerJoined { peer: peer_info },
                });

                // Spawn broadcast listener for this peer
                let my_peer_id = peer_id.clone();
                let my_fwd = fwd_tx_for_task.clone();
                let mut my_rx = rx.take().unwrap();
                bc_task = Some(tokio::spawn(async move {
                    while let Ok(bc) = my_rx.recv().await {
                        if let Some(excl) = &bc.exclude_peer {
                            if excl == &my_peer_id {
                                continue;
                            }
                        }
                        if my_fwd.send(bc.payload).is_err() {
                            break;
                        }
                    }
                }));
            }
            ClientMsg::Change { kind, payload, ts } => {
                let Some(room_code) = joined_room.clone() else {
                    let _ = fwd_tx.send(ServerMsg::Error {
                        message: "not in a room".into(),
                    });
                    continue;
                };
                let ts = ts.unwrap_or_else(|| chrono_now_ms());
                let tx_opt = {
                    let rooms = state.rooms.read().await;
                    rooms.get(&room_code).map(|r| r.tx.clone())
                };
                if let Some(tx) = tx_opt {
                    let _ = tx.send(BroadcastMsg {
                        exclude_peer: Some(peer_id.clone()),
                        payload: ServerMsg::Change {
                            kind,
                            payload,
                            ts,
                            from: peer_id.clone(),
                        },
                    });
                }
            }
            ClientMsg::Ping => {
                let _ = fwd_tx.send(ServerMsg::Pong);
            }
        }
    }

    // Cleanup on disconnect
    if let Some(room_code) = joined_room.clone() {
        let tx_opt = {
            let mut rooms = state.rooms.write().await;
            if let Some(room_ref) = rooms.get_mut(&room_code) {
                room_ref.peers.remove(&peer_id);
                Some(room_ref.tx.clone())
            } else {
                None
            }
        };
        if let Some(tx) = tx_opt {
            let _ = tx.send(BroadcastMsg {
                exclude_peer: Some(peer_id.clone()),
                payload: ServerMsg::PeerLeft {
                    peer_id: peer_id.clone(),
                },
            });
        }
    }

    if let Some(task) = bc_task {
        task.abort();
    }
    drop(fwd_tx);
    let _ = send_task.await;
}

fn chrono_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Server lifecycle ──

pub async fn start_host_server(
    state: Arc<CollabState>,
    port: Option<u16>,
) -> Result<ServerInfo, String> {
    // Stop any existing server first
    stop_host_server(state.clone()).await?;

    let port = port.unwrap_or(DEFAULT_COLLAB_PORT);
    let addr: SocketAddr = format!("0.0.0.0:{}", port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    let room_code = generate_room_code();

    // Create room
    {
        let mut rooms = state.rooms.write().await;
        let (tx, _rx) = broadcast::channel(ROOM_BROADCAST_CAPACITY);
        rooms.insert(
            room_code.clone(),
            Room {
                peers: HashMap::new(),
                tx,
            },
        );
    }

    // Build router
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind failed: {}", e))?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    let info = ServerInfo {
        port,
        room_code: room_code.clone(),
    };
    *state.server_info.write().await = Some(info.clone());
    *state.server_shutdown.lock().await = Some(shutdown_tx);

    Ok(info)
}

pub async fn stop_host_server(state: Arc<CollabState>) -> Result<(), String> {
    if let Some(tx) = state.server_shutdown.lock().await.take() {
        let _ = tx.send(());
    }
    state.rooms.write().await.clear();
    *state.server_info.write().await = None;
    Ok(())
}

// ── Tauri commands ──

#[tauri::command]
pub async fn collab_start_host(
    state: tauri::State<'_, Arc<CollabState>>,
    port: Option<u16>,
) -> Result<ServerInfo, String> {
    start_host_server(state.inner().clone(), port).await
}

#[tauri::command]
pub async fn collab_stop_host(state: tauri::State<'_, Arc<CollabState>>) -> Result<(), String> {
    stop_host_server(state.inner().clone()).await
}

#[tauri::command]
pub async fn collab_get_status(
    state: tauri::State<'_, Arc<CollabState>>,
) -> Result<Option<ServerInfo>, String> {
    Ok(state.server_info.read().await.clone())
}

// ── Cloudflare Tunnel integration ──

use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

pub struct TunnelState {
    child: TokioMutex<Option<tokio::process::Child>>,
    url: RwLock<Option<String>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            child: TokioMutex::new(None),
            url: RwLock::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TunnelInfo {
    pub url: String,
}

#[tauri::command]
pub async fn collab_start_tunnel(
    tunnel: tauri::State<'_, Arc<TunnelState>>,
    app: tauri::AppHandle,
    port: u16,
) -> Result<(), String> {
    // Stop existing tunnel
    {
        let mut guard = tunnel.child.lock().await;
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
    }
    *tunnel.url.write().await = None;

    let mut cmd = crate::common::no_window_async_command("cloudflared");
    cmd.arg("tunnel")
        .arg("--url")
        .arg(format!("http://localhost:{}", port))
        .arg("--no-autoupdate")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "cloudflared 실행 실패 (설치 필요: brew install cloudflared): {}",
            e
        )
    })?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr pipe missing".to_string())?;
    let stdout = child.stdout.take();

    let state_clone = tunnel.inner().clone();
    let app_clone = app.clone();
    // Parse stderr for trycloudflare URL
    tokio::spawn(async move {
        use tauri::Emitter;
        let re = regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap();
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if let Some(m) = re.find(&line) {
                let url = m.as_str().to_string();
                *state_clone.url.write().await = Some(url.clone());
                let _ = app_clone.emit("collab-tunnel-url", TunnelInfo { url });
            }
        }
    });
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut reader = BufReader::new(out).lines();
            while let Ok(Some(_line)) = reader.next_line().await {}
        });
    }

    *tunnel.child.lock().await = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn collab_stop_tunnel(tunnel: tauri::State<'_, Arc<TunnelState>>) -> Result<(), String> {
    if let Some(mut child) = tunnel.child.lock().await.take() {
        let _ = child.kill().await;
    }
    *tunnel.url.write().await = None;
    Ok(())
}

#[tauri::command]
pub async fn collab_get_tunnel_url(
    tunnel: tauri::State<'_, Arc<TunnelState>>,
) -> Result<Option<String>, String> {
    Ok(tunnel.url.read().await.clone())
}
