//! `HolderSet`: the app's holders after an update (docs/PTY_HOLDER_DAEMON.md 3.6).
//!
//! An update keeps the old holder binary running. When its protocol `version` is the one
//! this app speaks, nothing changes: the set is just the primary `HolderBackend` and every
//! call goes straight to it. When a live holder speaks an older protocol, the app:
//! - still attaches to it (HELLO in its version) so its terminals are recovered: list,
//!   attach, write, resize, close all work; SPAWN is never sent to it;
//! - sends it DRAIN, so it exits once its last terminal is released;
//! - starts (or attaches to) a holder of its own version for every new terminal.
//!
//! Each terminal id is routed to the holder that owns it (`routes`: id → older holder;
//! anything else is the primary's).

use super::client::HolderBackend;
use super::proto::{self, TerminalEntry};
use crate::pty_backend::{PtyBackend, SpawnRequest, TerminalInfo, PTY_ALIVE_IN_HOLDER};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub struct HolderSet {
    primary: HolderBackend,
    /// Holders of an older protocol found when the app attached (draining).
    older: Vec<HolderBackend>,
    /// Terminal id → index in `older`. Ids not listed belong to the primary.
    routes: Mutex<HashMap<String, usize>>,
}

impl HolderSet {
    /// Attach to (or start) a holder of our protocol in `run_dir`, then recover and DRAIN
    /// every live holder of an older protocol there.
    pub fn attach_or_spawn(run_dir: &Path) -> Result<Self, String> {
        let ours = proto::protocol_version();
        let mut found = super::spawn::scan(run_dir, ours)?;
        let older = std::mem::take(&mut found.older);
        let socket = super::spawn::pick_or_spawn(run_dir, found, ours)?;
        let primary = HolderBackend::attach_primary(socket, run_dir, ours)?;
        Ok(Self::with_older(primary, older))
    }

    /// `primary` plus the older holders at `older` (`(socket, version)`), each attached in
    /// its own version and sent DRAIN. One that cannot be reached is skipped (logged).
    pub fn with_older(primary: HolderBackend, older: Vec<(PathBuf, u32)>) -> Self {
        let mut attached = Vec::new();
        for (socket, version) in older {
            match HolderBackend::connect_version(&socket, version) {
                Ok(backend) => {
                    let terminals = backend.recovered().len();
                    match backend.drain() {
                        Ok(()) => safe_eprintln!(
                            "[pty-holder] older holder (protocol {version}) at {}: {terminals} terminal(s) recovered, DRAIN sent",
                            socket.display()
                        ),
                        Err(e) => safe_eprintln!("[pty-holder] DRAIN {}: {e}", socket.display()),
                    }
                    attached.push(backend);
                }
                Err(e) => safe_eprintln!(
                    "[pty-holder] older holder (protocol {version}) at {} not attached: {e}",
                    socket.display()
                ),
            }
        }
        let mine: Vec<String> = primary.recovered().into_iter().map(|e| e.id).collect();
        let mut routes = HashMap::new();
        for (i, backend) in attached.iter().enumerate() {
            for id in backend.terminal_ids() {
                // The primary keeps an id both know (never expected: ids are unique per app).
                if !mine.contains(&id) {
                    routes.entry(id).or_insert(i);
                }
            }
        }
        HolderSet {
            primary,
            older: attached,
            routes: Mutex::new(routes),
        }
    }

    fn routes(&self) -> MutexGuard<'_, HashMap<String, usize>> {
        self.routes.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn older_of(&self, id: &str) -> Option<usize> {
        self.routes().get(id).copied()
    }

    /// The backend that owns `id`.
    fn route(&self, id: &str) -> &HolderBackend {
        match self.older_of(id) {
            Some(i) => &self.older[i],
            None => &self.primary,
        }
    }

    /// Primary socket (`pty_backend_info.socket`).
    pub fn socket(&self) -> PathBuf {
        self.primary.socket()
    }

    /// Terminals found in the holders when the app attached (first WELCOMEs).
    pub fn recovered(&self) -> Vec<TerminalEntry> {
        let mut all = self.primary.recovered();
        for backend in &self.older {
            all.extend(backend.recovered());
        }
        all
    }

    /// `pty_list_recovered` over every holder.
    pub fn recovered_now(&self) -> Vec<TerminalEntry> {
        let routes = self.routes();
        let mut all = self.primary.recovered_now();
        for (i, backend) in self.older.iter().enumerate() {
            all.extend(
                backend
                    .recovered_now()
                    .into_iter()
                    .filter(|e| routes.get(&e.id) == Some(&i)),
            );
        }
        all.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        all
    }

    /// The primary connection is gone (reason), if so.
    pub fn lost_reason(&self) -> Option<String> {
        self.primary.lost_reason()
    }

    /// GOODBYE to every holder (older ones first; `kill_all` ends their terminals too, and
    /// reaches an older holder that still owns terminals even after its link was closed).
    pub fn goodbye(&self, reason: &str) {
        let routes = self.routes();
        for (i, backend) in self.older.iter().enumerate() {
            let owns_terminals = routes.values().any(|&j| j == i);
            if backend.is_connected() || (reason == "kill_all" && owns_terminals) {
                backend.goodbye(reason);
            }
        }
        drop(routes);
        self.primary.goodbye(reason);
    }

    /// `pty_backend_info.holders`: the primary first, then each older holder that is still
    /// connected or still has terminals:
    /// `{socket, version, spawnMethod, label?, unit?, draining, drainAcked, terminals, primary}`.
    pub fn holders_info(&self) -> Vec<serde_json::Value> {
        let routes = self.routes();
        let mut out = vec![describe(&self.primary, true, self.primary.recovered_now().len())];
        for (i, backend) in self.older.iter().enumerate() {
            let terminals = backend
                .recovered_now()
                .iter()
                .filter(|e| routes.get(&e.id) == Some(&i))
                .count();
            if backend.is_connected() || terminals > 0 {
                out.push(describe(backend, false, terminals));
            }
        }
        out
    }

    /// Test hook: which older holder owns `id`.
    #[cfg(test)]
    pub fn older_index_of(&self, id: &str) -> Option<usize> {
        self.older_of(id)
    }
}

fn describe(backend: &HolderBackend, primary: bool, terminals: usize) -> serde_json::Value {
    let socket = backend.socket();
    let (draining, acked) = backend.drain_state();
    let mut v = serde_json::json!({
        "socket": socket.to_string_lossy(),
        "version": backend.version(),
        "primary": primary,
        "draining": draining,
        "drainAcked": acked,
        "terminals": terminals,
        "connected": backend.is_connected(),
    });
    if let (Some(obj), serde_json::Value::Object(spawn)) =
        (v.as_object_mut(), super::spawn::describe(&socket))
    {
        obj.extend(spawn);
    }
    v
}

impl PtyBackend for HolderSet {
    /// Always on the primary. An id an older holder still runs is refused (the frontend
    /// attaches to it) unless `replace`; an ended one is released there first.
    fn spawn(&self, req: SpawnRequest) -> Result<(), String> {
        if let Some(i) = self.older_of(&req.terminal_id) {
            let older = &self.older[i];
            if older.alive(&req.terminal_id) && !req.replace {
                return Err(PTY_ALIVE_IN_HOLDER.to_string());
            }
            self.close(&req.terminal_id)?;
        }
        self.primary.spawn(req)
    }

    fn read(&self, id: &str) -> Result<Option<String>, String> {
        self.route(id).read(id)
    }

    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        self.route(id).write(id, data)
    }

    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.route(id).resize(id, rows, cols)
    }

    /// RELEASE in the owning holder. When an older holder has nothing left, the app says
    /// GOODBYE to it: it is exiting (drained) and must not be reconnected to.
    fn close(&self, id: &str) -> Result<(), String> {
        let Some(i) = self.older_of(id) else {
            return self.primary.close(id);
        };
        let older = &self.older[i];
        older.close(id)?;
        let mut routes = self.routes();
        routes.remove(id);
        if !routes.values().any(|&j| j == i) && older.is_connected() {
            drop(routes);
            older.goodbye("quit");
        }
        Ok(())
    }

    fn alive(&self, id: &str) -> bool {
        self.route(id).alive(id)
    }

    fn tail(&self, id: &str) -> Result<String, String> {
        self.route(id).tail(id)
    }

    fn attach_snapshot(&self, id: &str) -> Result<String, String> {
        self.route(id).attach_snapshot(id)
    }

    fn idle_ms(&self, id: &str) -> Result<u64, String> {
        self.route(id).idle_ms(id)
    }

    fn pid(&self, id: &str) -> Result<Option<u32>, String> {
        self.route(id).pid(id)
    }

    fn list(&self) -> Vec<TerminalInfo> {
        let routes = self.routes();
        let mut all = self.primary.list();
        for (i, backend) in self.older.iter().enumerate() {
            all.extend(
                backend
                    .list()
                    .into_iter()
                    .filter(|t| routes.get(&t.id) == Some(&i)),
            );
        }
        all
    }
}
