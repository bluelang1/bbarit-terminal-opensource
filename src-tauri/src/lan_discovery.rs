//! LAN peer discovery for BBARIT Terminal.
//!
//! Each running instance periodically broadcasts a small JSON beacon over UDP to
//! 255.255.255.255:<DISCOVERY_PORT> and listens for beacons from other instances
//! on the same network. A discovered peer carries exactly what the frontend needs
//! to open an SSH session to that machine (hostname / ip / ssh user / ssh port),
//! which is fed into the existing SSH connect flow (`buildSshVirtualPath`).
//!
//! Discovery is started lazily the first time `lan_list_peers` is called, so the
//! sockets only come up once the user opens the network panel.

use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket as StdUdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tokio::sync::Mutex as TokioMutex;

/// UDP port used for discovery beacons. Distinct from collab (19981) and the
/// browser bridge (19980).
pub const DISCOVERY_PORT: u16 = 19982;
/// How often each instance broadcasts its presence.
const BEACON_INTERVAL_SECS: u64 = 3;
/// A peer not heard from within this window is considered gone.
const PEER_TTL_SECS: i64 = 15;
/// Marker so we ignore unrelated UDP traffic on the port.
const APP_TAG: &str = "bbarit-terminal";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Best-effort outbound IPv4 of this machine. Opens (but never sends on) a UDP
/// socket toward a public address to let the OS pick the routable interface.
fn local_ipv4() -> String {
    let pick = || -> std::io::Result<String> {
        let s = StdUdpSocket::bind("0.0.0.0:0")?;
        s.connect("8.8.8.8:80")?;
        Ok(s.local_addr()?.ip().to_string())
    };
    pick().unwrap_or_else(|_| "0.0.0.0".to_string())
}

fn hostname() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "unknown".to_string())
}

fn current_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn os_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// Wire format broadcast on the network.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Beacon {
    app: String,
    peer_id: String,
    hostname: String,
    ip: String,
    ssh_port: u16,
    ssh_user: String,
    os: String,
    version: String,
}

/// A peer surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LanPeer {
    pub peer_id: String,
    pub hostname: String,
    pub ip: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub os: String,
    pub version: String,
    pub last_seen_ms: i64,
}

pub struct LanDiscoveryState {
    self_id: String,
    /// Advertised SSH credentials hint (user, port). Defaults to the OS user / 22,
    /// overridable from the frontend via `lan_set_ssh`.
    ssh_advert: Mutex<(String, u16)>,
    peers: Arc<TokioMutex<HashMap<String, LanPeer>>>,
    started: AtomicBool,
    running: Arc<AtomicBool>,
}

impl LanDiscoveryState {
    pub fn new() -> Self {
        // 8 hex chars is plenty to disambiguate instances on one LAN.
        let mut rng = rand::thread_rng();
        let self_id: String = (0..8)
            .map(|_| {
                let n: u8 = rand::Rng::gen_range(&mut rng, 0..16);
                std::char::from_digit(n as u32, 16).unwrap_or('0')
            })
            .collect();
        LanDiscoveryState {
            self_id,
            ssh_advert: Mutex::new((current_user(), 22)),
            peers: Arc::new(TokioMutex::new(HashMap::new())),
            started: AtomicBool::new(false),
            running: Arc::new(AtomicBool::new(true)),
        }
    }

    fn beacon_bytes(&self) -> Vec<u8> {
        let (ssh_user, ssh_port) = self
            .ssh_advert
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| (current_user(), 22));
        let beacon = Beacon {
            app: APP_TAG.to_string(),
            peer_id: self.self_id.clone(),
            hostname: hostname(),
            ip: local_ipv4(),
            ssh_port,
            ssh_user,
            os: os_label().to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        serde_json::to_vec(&beacon).unwrap_or_default()
    }

    /// Idempotently bring discovery up. Safe to call on every `lan_list_peers`.
    fn ensure_started(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.running.store(true, Ordering::SeqCst);
        let tx = self.clone();
        tokio::spawn(async move { tx.beacon_loop().await });
        let rx = self.clone();
        tokio::spawn(async move { rx.listen_loop().await });
    }

    async fn beacon_loop(self: Arc<Self>) {
        let sock = match UdpSocket::bind("0.0.0.0:0").await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[lan] beacon bind failed: {e}");
                return;
            }
        };
        if let Err(e) = sock.set_broadcast(true) {
            eprintln!("[lan] set_broadcast failed: {e}");
            return;
        }
        let dest = format!("255.255.255.255:{DISCOVERY_PORT}");
        while self.running.load(Ordering::SeqCst) {
            let bytes = self.beacon_bytes();
            if !bytes.is_empty() {
                let _ = sock.send_to(&bytes, &dest).await;
            }
            tokio::time::sleep(Duration::from_secs(BEACON_INTERVAL_SECS)).await;
        }
    }

    async fn listen_loop(self: Arc<Self>) {
        let sock = match bind_reuse_udp(DISCOVERY_PORT).and_then(UdpSocket::from_std) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[lan] listen bind failed: {e}");
                return;
            }
        };
        let mut buf = vec![0u8; 2048];
        while self.running.load(Ordering::SeqCst) {
            let (n, _from) = match sock.recv_from(&mut buf).await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let beacon: Beacon = match serde_json::from_slice(&buf[..n]) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if beacon.app != APP_TAG || beacon.peer_id == self.self_id {
                continue;
            }
            let peer = LanPeer {
                peer_id: beacon.peer_id.clone(),
                hostname: beacon.hostname,
                ip: beacon.ip,
                ssh_port: beacon.ssh_port,
                ssh_user: beacon.ssh_user,
                os: beacon.os,
                version: beacon.version,
                last_seen_ms: now_ms(),
            };
            self.peers.lock().await.insert(beacon.peer_id, peer);
        }
    }
}

/// Bind a UDP socket with SO_REUSEADDR (+ SO_REUSEPORT on unix) so a dev build and
/// an installed build can both listen on the same machine without conflict.
fn bind_reuse_udp(port: u16) -> std::io::Result<StdUdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    #[cfg(unix)]
    sock.set_reuse_port(true)?;
    let addr: SocketAddr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into();
    sock.bind(&addr.into())?;
    sock.set_nonblocking(true)?;
    Ok(sock.into())
}

// ── Tauri commands ──

#[tauri::command]
pub async fn lan_list_peers(
    state: tauri::State<'_, Arc<LanDiscoveryState>>,
) -> Result<Vec<LanPeer>, String> {
    let inner = state.inner().clone();
    inner.ensure_started();
    let cutoff = now_ms() - PEER_TTL_SECS * 1000;
    let mut peers = inner.peers.lock().await;
    peers.retain(|_, p| p.last_seen_ms >= cutoff);
    let mut list: Vec<LanPeer> = peers.values().cloned().collect();
    list.sort_by(|a, b| a.hostname.cmp(&b.hostname));
    Ok(list)
}

/// Update the SSH user/port this instance advertises to peers.
#[tauri::command]
pub async fn lan_set_ssh(
    state: tauri::State<'_, Arc<LanDiscoveryState>>,
    ssh_user: Option<String>,
    ssh_port: Option<u16>,
) -> Result<(), String> {
    if let Ok(mut g) = state.ssh_advert.lock() {
        if let Some(u) = ssh_user {
            if !u.trim().is_empty() {
                g.0 = u;
            }
        }
        if let Some(p) = ssh_port {
            if p != 0 {
                g.1 = p;
            }
        }
    }
    Ok(())
}

/// Stop broadcasting and listening (e.g. user disabled the feature).
#[tauri::command]
pub async fn lan_stop_discovery(
    state: tauri::State<'_, Arc<LanDiscoveryState>>,
) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);
    state.started.store(false, Ordering::SeqCst);
    state.peers.lock().await.clear();
    Ok(())
}
