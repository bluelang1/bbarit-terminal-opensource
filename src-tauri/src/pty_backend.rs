//! Who owns the tab PTYs (docs/PTY_HOLDER_DAEMON.md 3.4).
//!
//! Phase 1 is a pure refactor: the Tauri PTY commands in main.rs forward to a
//! `PtyBackend`, and `InProcessBackend` is the code that used to live inline in
//! main.rs (same channel capacity, buffer cap, truncation marker and UTF-8
//! reassembly). A later `HolderBackend` can take its place without touching the
//! command names, arguments or error strings the frontend relies on.
//!
//! `build_shell_command` is the shell/env half of the old `create_shell`, with
//! everything AppHandle-bound or non-deterministic injected via `ShellEnvDeps`,
//! so the resulting argv/cwd/env can be snapshot-tested.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

// Prevent unbounded memory growth when the frontend can't keep up with PTY output.
// 1024 queued chunks is enough for bursty CLIs while keeping multi-harness memory bounded.
const PTY_OUTPUT_QUEUE_CAPACITY: usize = 1024;
// Limit how much we return per read to avoid huge allocations and renderer stalls
// on bursty long-running output.
const PTY_READ_MAX_BYTES: usize = 64 * 1024;

pub(crate) const PTY_NOT_FOUND: &str = "PTY not found";
pub(crate) const PTY_DISCONNECTED: &str = "PTY disconnected";
/// `create_shell` for an id whose program is still running in the PTY holder (the
/// frontend missed the recovery list): it must attach to it, not replace it.
pub(crate) const PTY_ALIVE_IN_HOLDER: &str = "PTY alive in holder";

/// A fully built command plus the PTY it should run in.
pub struct SpawnRequest {
    pub terminal_id: String,
    pub cmd: CommandBuilder,
    pub rows: u16,
    pub cols: u16,
    /// `BBARIT_TERM_SCOPE` value already planted in `cmd`; swept on close.
    pub scope_token: String,
    /// The caller means to end a still-running terminal under this id. Without it the
    /// holder backend refuses a live id (`PTY_ALIVE_IN_HOLDER`); in-process ignores it.
    pub replace: bool,
}

/// One live terminal as seen by app-wide sweeps (exit, window close).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalInfo {
    // Read by the phase-2b reattach path; unused by today's callers.
    #[allow(dead_code)]
    pub id: String,
    pub pid: Option<u32>,
    pub scope_token: String,
}

/// Every operation the PTY Tauri commands need. Error strings are part of the
/// frontend contract ("PTY not found", "PTY disconnected").
pub trait PtyBackend: Send + Sync {
    fn spawn(&self, req: SpawnRequest) -> Result<(), String>;
    /// Non-blocking pull: Ok(None) when nothing is queued, Err("PTY disconnected")
    /// once the reader is gone and the queue is drained.
    fn read(&self, id: &str) -> Result<Option<String>, String>;
    fn write(&self, id: &str, data: &str) -> Result<(), String>;
    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String>;
    /// Forget the terminal and reap its process tree + scope in the background.
    /// Unknown ids are a no-op.
    fn close(&self, id: &str) -> Result<(), String>;
    /// True while the reader thread is still running.
    fn alive(&self, id: &str) -> bool;
    /// Accumulated output (front-trimmed), for inspection. Leaves the read queue alone.
    fn tail(&self, id: &str) -> Result<String, String>;
    /// The reattach/replay copy: the accumulated output, with the read queue drained under
    /// the same lock, so `read()` afterwards returns only output produced after this copy
    /// (nothing renders twice). Only the frontend's replay path calls it.
    fn attach_snapshot(&self, id: &str) -> Result<String, String>;
    fn idle_ms(&self, id: &str) -> Result<u64, String>;
    /// Shell pid; Err("PTY not found") for an unknown id, Ok(None) if the OS gave none.
    fn pid(&self, id: &str) -> Result<Option<u32>, String>;
    fn list(&self) -> Vec<TerminalInfo>;
}

// ─── Backend selection (config `terminal.ptyHolder`) ───

/// The backend chosen once per app run. Resolution is lazy (first PTY spawn, the
/// `pty_backend_info` command, or the background resolve started in `setup`), so a
/// second app instance that the single-instance plugin is about to end never attaches
/// to the holder and pushes the real app off it (newest HELLO wins).
pub struct PtySelection {
    want_holder: bool,
    /// Tests point the holder lookup somewhere else; None = `pty_holder::run_dir()`.
    #[cfg(unix)]
    run_dir: Option<std::path::PathBuf>,
    chosen: std::sync::OnceLock<Chosen>,
}

struct Chosen {
    backend: Arc<dyn PtyBackend>,
    #[cfg(unix)]
    holder: Option<Arc<crate::pty_holder::multi::HolderSet>>,
    /// Why the holder was wanted but not used.
    fallback_reason: Option<String>,
}

impl PtySelection {
    /// `setting` is `terminal.ptyHolder`: "on" wants the holder, anything else
    /// (default "off") keeps the PTYs in this process.
    pub fn new(setting: Option<&str>) -> Self {
        PtySelection {
            want_holder: setting == Some("on"),
            #[cfg(unix)]
            run_dir: None,
            chosen: std::sync::OnceLock::new(),
        }
    }

    /// Choose now if not yet chosen. Holder failures fall back to in-process.
    pub fn resolve(&self) -> &Arc<dyn PtyBackend> {
        &self.chosen.get_or_init(|| self.choose()).backend
    }

    fn resolved(&self) -> Option<&Arc<dyn PtyBackend>> {
        self.chosen.get().map(|c| &c.backend)
    }

    fn choose(&self) -> Chosen {
        let in_process = |fallback_reason: Option<String>| Chosen {
            backend: Arc::new(InProcessBackend::default()),
            #[cfg(unix)]
            holder: None,
            fallback_reason,
        };
        if !self.want_holder {
            return in_process(None);
        }
        #[cfg(unix)]
        {
            use crate::pty_holder::multi::HolderSet;
            let dir = match &self.run_dir {
                Some(dir) => Ok(dir.clone()),
                None => crate::pty_holder::run_dir(),
            };
            match dir.and_then(|dir| HolderSet::attach_or_spawn(&dir)) {
                Ok(holder) => {
                    let holder = Arc::new(holder);
                    safe_eprintln!("[pty] terminals live in the pty holder at {}", holder.socket().display());
                    Chosen { backend: holder.clone(), holder: Some(holder), fallback_reason: None }
                }
                Err(e) => {
                    safe_eprintln!("[pty] pty holder unavailable, using in-process PTYs: {e}");
                    in_process(Some(e))
                }
            }
        }
        #[cfg(not(unix))]
        in_process(Some("the PTY holder is not available on Windows yet".to_string()))
    }

    /// `pty_backend_info` payload: `{kind, socket?, recovered, fallbackReason?, lost?}`, plus
    /// for the holder how it was started: `spawnMethod` ("launchd" | "systemd" | "setsid"),
    /// `label` (launchd) / `unit` (systemd), `spawnFallbackReason` (why not launchd/systemd),
    /// and `holders` (every holder in use: the primary first, then older-protocol ones being
    /// drained). `socket`/`spawnMethod`/… describe the primary.
    pub fn info(&self) -> serde_json::Value {
        let chosen = self.chosen.get_or_init(|| self.choose());
        #[cfg(unix)]
        if let Some(holder) = &chosen.holder {
            let socket = holder.socket();
            let mut info = serde_json::json!({
                "kind": "holder",
                "socket": socket.to_string_lossy(),
                "recovered": holder.recovered(),
                "lost": holder.lost_reason(),
                "holders": holder.holders_info(),
            });
            if let (Some(obj), serde_json::Value::Object(spawn)) =
                (info.as_object_mut(), crate::pty_holder::spawn::describe(&socket))
            {
                obj.extend(spawn);
            }
            return info;
        }
        serde_json::json!({
            "kind": "in-process",
            "recovered": [],
            "fallbackReason": chosen.fallback_reason,
        })
    }

    /// `pty_list_recovered` payload: terminals to attach to instead of creating (holder
    /// only; the in-process backend never outlives the app, so it has none).
    pub fn recovered_list(&self) -> serde_json::Value {
        let chosen = self.chosen.get_or_init(|| self.choose());
        #[cfg(unix)]
        if let Some(holder) = &chosen.holder {
            return serde_json::to_value(holder.recovered_now()).unwrap_or_else(|_| serde_json::json!([]));
        }
        let _ = chosen;
        serde_json::json!([])
    }

    /// True once the PTYs live in the holder (resolved and attached).
    pub fn uses_holder(&self) -> bool {
        #[cfg(unix)]
        {
            self.chosen.get().is_some_and(|c| c.holder.is_some())
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// App exit with the GOODBYE `reason` from `exit_goodbye_reason`. True when the
    /// backend took care of every terminal itself (holder: `kill_all` kills + sweeps
    /// there, `quit`/`handover` keep them running); false means the caller sweeps.
    pub fn on_app_exit(&self, reason: ExitReason) -> bool {
        #[cfg(unix)]
        if let Some(holder) = self.chosen.get().and_then(|c| c.holder.as_ref()) {
            holder.goodbye(reason.as_str());
            return true;
        }
        let _ = reason;
        false
    }
}

/// GOODBYE reason on app exit (docs/PTY_HOLDER_DAEMON.md 3.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// App only; the holder keeps every terminal.
    Quit,
    /// Update relaunch; the next app attaches to the same holder.
    Handover,
    /// End every terminal (holder releases, sweeps and exits).
    KillAll,
}

impl ExitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ExitReason::Quit => "quit",
            ExitReason::Handover => "handover",
            ExitReason::KillAll => "kill_all",
        }
    }
}

/// The menu's "quit and end all terminals" wins; an update relaunch hands over;
/// otherwise `terminal.keepRunningOnQuit` decides.
pub fn exit_goodbye_reason(keep_running_on_quit: bool, kill_all_requested: bool, handover: bool) -> ExitReason {
    if kill_all_requested {
        ExitReason::KillAll
    } else if handover {
        ExitReason::Handover
    } else if keep_running_on_quit {
        ExitReason::Quit
    } else {
        ExitReason::KillAll
    }
}

/// `terminal.keepRunningOnQuit`: default true, but a debug build keeps it only when
/// the setting is explicitly true (dev rebuilds replace the holder binary; decision 9).
pub fn keep_running_on_quit(setting: Option<bool>, debug_build: bool) -> bool {
    if debug_build {
        setting == Some(true)
    } else {
        setting.unwrap_or(true)
    }
}

/// Spawning resolves the selection; every other call on an unresolved selection
/// behaves like an empty in-process backend (no holder is started just to say "not found").
impl PtyBackend for PtySelection {
    fn spawn(&self, req: SpawnRequest) -> Result<(), String> {
        self.resolve().spawn(req)
    }
    fn read(&self, id: &str) -> Result<Option<String>, String> {
        self.resolved().ok_or_else(not_found)?.read(id)
    }
    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        self.resolved().ok_or_else(not_found)?.write(id, data)
    }
    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        self.resolved().ok_or_else(not_found)?.resize(id, rows, cols)
    }
    fn close(&self, id: &str) -> Result<(), String> {
        self.resolved().map_or(Ok(()), |b| b.close(id))
    }
    fn alive(&self, id: &str) -> bool {
        self.resolved().is_some_and(|b| b.alive(id))
    }
    fn tail(&self, id: &str) -> Result<String, String> {
        self.resolved().ok_or_else(not_found)?.tail(id)
    }
    fn attach_snapshot(&self, id: &str) -> Result<String, String> {
        self.resolved().ok_or_else(not_found)?.attach_snapshot(id)
    }
    fn idle_ms(&self, id: &str) -> Result<u64, String> {
        self.resolved().ok_or_else(not_found)?.idle_ms(id)
    }
    fn pid(&self, id: &str) -> Result<Option<u32>, String> {
        self.resolved().ok_or_else(not_found)?.pid(id)
    }
    fn list(&self) -> Vec<TerminalInfo> {
        self.resolved().map_or_else(Vec::new, |b| b.list())
    }
}

fn not_found() -> String {
    PTY_NOT_FOUND.to_string()
}

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
    /// `BBARIT_TERM_SCOPE` value planted in this PTY's env. Processes that inherited it
    /// (even ones that escaped the process tree via setsid/nohup) are swept on close.
    /// docs/TERMINAL_SCOPE_SWEEP.md
    scope_token: String,
}

/// PTYs owned by the app process itself (today's behavior; the only backend in phase 1).
#[derive(Default)]
pub struct InProcessBackend {
    ptys: Mutex<HashMap<String, PtyInstance>>,
}

impl PtyBackend for InProcessBackend {
    fn spawn(&self, req: SpawnRequest) -> Result<(), String> {
        let SpawnRequest { terminal_id, cmd, rows, cols, scope_token, .. } = req;
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

        // Thread to read output
        let (queue, rx) = new_output_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let output_buffer = Arc::new(Mutex::new(String::new()));
        let last_output_at = Arc::new(Mutex::new(std::time::Instant::now()));

        spawn_utf8_reader_thread(
            reader,
            queue,
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
            scope_token,
        };

        self.ptys.lock().unwrap().insert(terminal_id, instance);

        Ok(())
    }

    fn read(&self, id: &str) -> Result<Option<String>, String> {
        let ptys = self.ptys.lock().unwrap();
        if let Some(instance) = ptys.get(id) {
            drain_output(&instance.output_rx)
        } else {
            Err(PTY_NOT_FOUND.to_string())
        }
    }

    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut ptys = self.ptys.lock().unwrap();
        if let Some(instance) = ptys.get_mut(id) {
            instance
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            instance.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err(PTY_NOT_FOUND.to_string())
        }
    }

    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let ptys = self.ptys.lock().unwrap();
        if let Some(instance) = ptys.get(id) {
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
            Err(PTY_NOT_FOUND.to_string())
        }
    }

    fn close(&self, id: &str) -> Result<(), String> {
        if let Some(mut instance) = self.ptys.lock().unwrap().remove(id) {
            // Best-effort terminate the child process to prevent orphaned shells and memory leaks.
            // Do this on a background thread so the invoke call doesn't block the UI thread.
            let pid = instance.child.process_id();
            thread::spawn(move || {
                // Reap the whole subtree FIRST (grandchildren), then the immediate child.
                if let Some(pid) = pid {
                    crate::kill_process_tree(pid);
                }
                let _ = instance.child.kill();
                let _ = instance.child.wait();
                // Safety net for processes that left the tree (setsid/nohup/disown, reparented
                // to launchd/init) but still carry this terminal's scope token.
                crate::sweep_scope(&instance.scope_token, &[]);
            });
        }
        Ok(())
    }

    fn alive(&self, id: &str) -> bool {
        let ptys = self.ptys.lock().unwrap();
        match ptys.get(id) {
            Some(instance) => instance.alive.load(Ordering::Relaxed),
            None => false,
        }
    }

    fn tail(&self, id: &str) -> Result<String, String> {
        let ptys = self.ptys.lock().unwrap();
        match ptys.get(id) {
            Some(instance) => {
                let buf = instance.output_buffer.lock().unwrap();
                Ok(buf.clone())
            }
            None => Err(PTY_NOT_FOUND.to_string()),
        }
    }

    fn attach_snapshot(&self, id: &str) -> Result<String, String> {
        let ptys = self.ptys.lock().unwrap();
        let Some(instance) = ptys.get(id) else {
            return Err(PTY_NOT_FOUND.to_string());
        };
        // The reader appends and queues under this lock, so every chunk is either in the
        // copy (and drained here) or arrives through read() afterwards.
        let buf = instance.output_buffer.lock().unwrap();
        while instance.output_rx.try_recv().is_ok() {}
        Ok(buf.clone())
    }

    fn idle_ms(&self, id: &str) -> Result<u64, String> {
        let ptys = self.ptys.lock().unwrap();
        let Some(instance) = ptys.get(id) else {
            return Err(PTY_NOT_FOUND.to_string());
        };
        let last = *instance.last_output_at.lock().unwrap();
        Ok(last.elapsed().as_millis() as u64)
    }

    fn pid(&self, id: &str) -> Result<Option<u32>, String> {
        let ptys = self.ptys.lock().unwrap();
        let Some(instance) = ptys.get(id) else {
            return Err(PTY_NOT_FOUND.to_string());
        };
        Ok(instance.child.process_id())
    }

    /// Empty on a poisoned lock (the exit sweep already treated poison as "nothing to do").
    fn list(&self) -> Vec<TerminalInfo> {
        match self.ptys.lock() {
            Ok(ptys) => ptys
                .iter()
                .map(|(id, p)| TerminalInfo {
                    id: id.clone(),
                    pid: p.child.process_id(),
                    scope_token: p.scope_token.clone(),
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// `output_buffer` cap (below 1 MB): long-running terminals don't retain too much
/// history just for orchestra-side inspection. Shared with the holder client's tail copy.
pub(crate) const OUTPUT_BUFFER_MAX: usize = 768 * 1024;

/// Append to an output buffer; past `OUTPUT_BUFFER_MAX`, trim the front half (at a
/// char boundary) so the most recent output (usually the final JSON plan) is kept.
pub(crate) fn append_output_buffer(buf: &mut String, data: &str) {
    buf.push_str(data);
    if buf.len() > OUTPUT_BUFFER_MAX {
        let trim_at = buf.len() / 2;
        // Find a safe UTF-8 boundary
        let safe_trim = buf.ceil_char_boundary(trim_at);
        let trimmed = buf.split_off(safe_trim);
        *buf = trimmed;
    }
}

/// Turns a byte stream into UTF-8 strings: an incomplete trailing sequence waits for
/// the next push, invalid bytes are dropped. One per terminal.
#[derive(Default)]
pub(crate) struct Utf8Reassembler {
    pending: Vec<u8>,
}

impl Utf8Reassembler {
    /// Feed bytes and emit every decodable piece. Returns false as soon as `emit` does.
    pub(crate) fn push(&mut self, bytes: &[u8], emit: &mut impl FnMut(String) -> bool) -> bool {
        let pending = &mut self.pending;
        pending.extend_from_slice(bytes);

        loop {
            match std::str::from_utf8(pending) {
                Ok(s) => {
                    if !emit(s.to_string()) {
                        return false;
                    }
                    pending.clear();
                    break;
                }
                Err(e) => {
                    let valid_up_to = e.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = &pending[..valid_up_to];
                        if !emit(String::from_utf8_lossy(valid).to_string()) {
                            return false;
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
        true
    }

    /// Whatever is left at end of stream, decoded lossily.
    pub(crate) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let rest = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        Some(rest)
    }
}

/// The per-terminal queue `read()` drains. Never blocks the producer: when the
/// frontend falls behind, chunks are dropped and a truncation marker is emitted
/// once there is room again.
pub(crate) struct OutputQueue {
    tx: SyncSender<String>,
    dropped_output: bool,
}

impl OutputQueue {
    pub(crate) fn new(tx: SyncSender<String>) -> Self {
        OutputQueue { tx, dropped_output: false }
    }

    /// False once the receiving side is gone.
    pub(crate) fn send(&mut self, data: String) -> bool {
        if data.is_empty() {
            return true;
        }
        // If we previously dropped output due to a full queue, try to emit a marker once we have space.
        if self.dropped_output {
            match self.tx.try_send("\r\n[output truncated]\r\n".to_string()) {
                Ok(()) => self.dropped_output = false,
                Err(TrySendError::Disconnected(_)) => return false,
                Err(TrySendError::Full(_)) => {
                    // Still full, keep the dropped flag set.
                }
            }
        }

        // Never block the reader thread for a full output queue. If the frontend
        // falls behind, keep the PTY draining and mark the visible output as truncated.
        match self.tx.try_send(data) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.dropped_output = true;
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    /// Output was lost upstream (bytes that fell out of the holder's tail while
    /// detached): show the same marker before the next chunk.
    #[cfg(unix)]
    pub(crate) fn mark_truncated(&mut self) {
        self.dropped_output = true;
    }

    /// The receiver was emptied on purpose (its bytes were delivered another way).
    #[cfg(unix)]
    pub(crate) fn clear_truncated(&mut self) {
        self.dropped_output = false;
    }
}

pub(crate) fn new_output_channel() -> (OutputQueue, Receiver<String>) {
    let (tx, rx) = mpsc::sync_channel::<String>(PTY_OUTPUT_QUEUE_CAPACITY);
    (OutputQueue::new(tx), rx)
}

/// Non-blocking drain of up to `PTY_READ_MAX_BYTES` (the `read_from_pty` contract).
pub(crate) fn drain_output(rx: &Receiver<String>) -> Result<Option<String>, String> {
    // Non-blocking read from channel; drain as much as possible to reduce invocations/queue backlog.
    match rx.try_recv() {
        Ok(first) => {
            let mut out = String::new();
            out.push_str(&first);

            while out.len() < PTY_READ_MAX_BYTES {
                match rx.try_recv() {
                    Ok(next) => out.push_str(&next),
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => break,
                }
            }

            Ok(Some(out))
        }
        Err(mpsc::TryRecvError::Empty) => Ok(None),
        Err(mpsc::TryRecvError::Disconnected) => Err(PTY_DISCONNECTED.to_string()),
    }
}

fn spawn_utf8_reader_thread(
    mut reader: Box<dyn Read + Send>,
    mut queue: OutputQueue,
    alive: Arc<AtomicBool>,
    output_buffer: Option<Arc<Mutex<String>>>,
    last_output_at: Option<Arc<Mutex<std::time::Instant>>>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut decoder = Utf8Reassembler::default();

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

            // Also append to the output buffer if provided. Queue under the same lock so
            // attach_snapshot never sees a chunk in the buffer that is still on its way.
            if let Some(ref buf_arc) = output_buffer {
                if let Ok(mut buf) = buf_arc.lock() {
                    append_output_buffer(&mut buf, &data);
                    return queue.send(data);
                }
            }

            queue.send(data)
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !decoder.push(&buf[..n], &mut try_send) {
                        return;
                    }
                }
                Err(_) => break,
            }
        }

        if let Some(rest) = decoder.finish() {
            let _ = try_send(rest);
        }

        // Signal that the PTY process has exited
        alive.store(false, Ordering::Relaxed);
    });
}

// ─── Shell command construction (was inline in create_shell) ───

/// What the frontend asked for.
pub struct ShellSpawnSpec {
    pub terminal_id: String,
    /// As sent by the frontend (may be `ssh://…`); the PTY cwd is `ShellEnvDeps::shell_work_dir`.
    /// Only the Windows branches read it (ssh:// spawns `ssh` directly there).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub work_dir: String,
    /// Windows shell choice (`cmd`/`gitbash`/`wsl`/default PowerShell); ignored on macOS/Linux.
    pub shell_type: Option<String>,
    pub scope_token: String,
}

/// Everything the builder would otherwise read from the AppHandle, filesystem,
/// subprocesses or the network. create_shell collects these; tests pass literals.
pub struct ShellEnvDeps {
    /// `resolve_shell_work_dir(work_dir)` (home for ssh:// or a vanished folder).
    pub shell_work_dir: String,
    /// Bundled `session-start.sh` path, if the resource exists.
    pub claude_hook: Option<String>,
    /// Bundled `bbarit-ctl.mjs` path, if resolved.
    pub ctl_path: Option<String>,
    /// `id -un` (falling back to $USER, then "unknown").
    #[cfg(not(target_os = "windows"))]
    pub username: String,
    /// `/Users/<username>` (what create_shell has always used).
    #[cfg(not(target_os = "windows"))]
    pub home: String,
    /// Latest `~/.nvm/versions/node/*/bin`, or the v20.19.6 default.
    #[cfg(not(target_os = "windows"))]
    pub nvm_node_bin: String,
    /// Contents of `<home>/.config/octo/.env`, if readable.
    #[cfg(not(target_os = "windows"))]
    pub env_file: Option<String>,
    /// `github_account_env(...)` result (GH_TOKEN, BBARIT_GITHUB_ACCOUNT) or empty.
    #[cfg(not(target_os = "windows"))]
    pub github_env: Vec<(String, String)>,
}

/// PATH every macOS/Linux tab starts with. Also the PATH the GitHub token lookup uses.
#[cfg(not(target_os = "windows"))]
pub fn shell_path(nvm_node_bin: &str, home: &str) -> String {
    format!(
        "{}:{}/.local/bin:{}/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        nvm_node_bin, home, home
    )
}

/// The tab shell: program, args, cwd and env. The env is the app's own env
/// (CommandBuilder inherits it) with the removals and overrides below, applied
/// in this order — later steps (the ~/.config/octo/.env file, the GitHub
/// account) can override earlier ones. Errs only for a malformed Windows ssh:// dir.
pub fn build_shell_command(
    spec: &ShellSpawnSpec,
    deps: &ShellEnvDeps,
) -> Result<CommandBuilder, String> {
    // Shell command setup
    #[cfg(target_os = "windows")]
    let is_ssh_pty = crate::is_remote_ssh_path(&spec.work_dir);

    // On Windows, an ssh:// work dir spawns `ssh` directly as the PTY (see
    // build_ssh_pty_command) instead of a local shell that would have to parse a
    // POSIX-quoted ssh command. macOS/Linux keep typing the command into zsh.
    #[cfg(target_os = "windows")]
    let effective_shell_type = if !is_ssh_pty
        && spec.shell_type.as_deref() == Some("wsl")
        && !crate::wsl_distribution_installed()
    {
        None
    } else {
        spec.shell_type.as_deref()
    };

    #[cfg(target_os = "windows")]
    let mut cmd = if is_ssh_pty {
        crate::build_ssh_pty_command(&spec.work_dir)?
    } else {
        let shell_executable = match effective_shell_type {
            Some("cmd") => "cmd.exe",
            Some("gitbash") => "C:\\Program Files\\Git\\bin\\bash.exe",
            Some("wsl") => "wsl.exe",
            _ => "powershell.exe", // default
        };
        CommandBuilder::new(shell_executable)
    };

    // shell_type is only consulted in the #[cfg(windows)] branches.
    #[cfg(not(target_os = "windows"))]
    let _ = &spec.shell_type;

    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("/bin/zsh");

    #[cfg(not(target_os = "windows"))]
    cmd.arg("-l");

    let shell_work_dir = &deps.shell_work_dir;
    #[cfg(target_os = "windows")]
    crate::configure_windows_pty_encoding(&mut cmd, effective_shell_type, is_ssh_pty);
    #[cfg(target_os = "windows")]
    if !is_ssh_pty && effective_shell_type == Some("wsl") {
        if let Some(wsl_dir) =
            crate::windows_path_to_wsl_path(std::path::Path::new(shell_work_dir))
        {
            cmd.arg("--cd");
            cmd.arg(wsl_dir);
        }
    }
    cmd.cwd(shell_work_dir);

    // ssh forwards TERM to the remote shell, so prefer a widely-supported value there.
    #[cfg(target_os = "windows")]
    let term = if is_ssh_pty || effective_shell_type == Some("wsl") {
        "xterm-256color"
    } else {
        "cygwin"
    };
    #[cfg(not(target_os = "windows"))]
    let term = "xterm-256color";

    apply_shell_env(&mut cmd, spec, deps, term);
    Ok(cmd)
}

/// Env removals and overrides on top of whatever `cmd` inherited, in the order
/// create_shell has always applied them.
fn apply_shell_env(cmd: &mut CommandBuilder, spec: &ShellSpawnSpec, deps: &ShellEnvDeps, term: &str) {
    // Remove inherited Claude Code markers (CLAUDECODE etc.) so Claude runs and saves its
    // transcript inside the tab, and add the session-hook env (docs/CLAUDE_SESSION_HOOK.md).
    crate::apply_bbarit_terminal_env(cmd, &spec.terminal_id, deps.claude_hook.as_deref());
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

    // Per-terminal scope token; close_pty sweeps every process that still carries it.
    cmd.env(crate::SCOPE_ENV, &spec.scope_token);
    if let Some(ctl) = &deps.ctl_path {
        cmd.env("BBARIT_CTL", ctl);
    }

    cmd.env("TERM", term);

    #[cfg(not(target_os = "windows"))]
    {
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "ko_KR.UTF-8");
        cmd.env("LC_ALL", "ko_KR.UTF-8");

        let home = &deps.home;
        cmd.env("HOME", home);
        cmd.env("USER", &deps.username);

        // Remove npm_config_prefix for nvm compatibility and set PATH directly
        cmd.env_remove("npm_config_prefix");

        let path = shell_path(&deps.nvm_node_bin, home);
        cmd.env("PATH", &path);
        cmd.env("SHELL", "/bin/zsh");
        cmd.env("NVM_DIR", format!("{}/.nvm", home));

        // Load API keys from ~/.config/octo/.env
        if let Some(content) = &deps.env_file {
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

        if !deps.github_env.is_empty() {
            // gh prefers GH_TOKEN, but drop a stale GITHUB_TOKEN so nothing else picks it up.
            cmd.env_remove("GITHUB_TOKEN");
        }
        for (key, value) in &deps.github_env {
            cmd.env(key, value);
        }
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    const HOOK: &str = "/res/claude-hooks/session-start.sh";
    const CTL: &str = "/res/bbarit-ctl.mjs";

    fn spec() -> ShellSpawnSpec {
        ShellSpawnSpec {
            terminal_id: "term-1".into(),
            work_dir: "/work/proj".into(),
            shell_type: Some("wsl".into()), // ignored off Windows
            scope_token: "1700000000000-0badc0de".into(),
        }
    }

    fn deps(github: bool) -> ShellEnvDeps {
        ShellEnvDeps {
            shell_work_dir: "/work/proj".into(),
            claude_hook: Some(HOOK.into()),
            ctl_path: Some(CTL.into()),
            username: "alice".into(),
            home: "/Users/alice".into(),
            nvm_node_bin: "/Users/alice/.nvm/versions/node/v22.1.0/bin".into(),
            env_file: Some(
                "# comment\n\nOPENAI_API_KEY=\"sk-quoted\"\n  EXTRA_SINGLE = 'x y' \nNOT_A_PAIR\n"
                    .into(),
            ),
            github_env: if github {
                vec![
                    ("GH_TOKEN".into(), "gho_test".into()),
                    ("BBARIT_GITHUB_ACCOUNT".into(), "alice".into()),
                ]
            } else {
                Vec::new()
            },
        }
    }

    /// Keys the old inline create_shell removed from the inherited app env (macOS/Linux).
    /// GITHUB_TOKEN only when a GitHub account was resolved.
    const REMOVED_KEYS: [&str; 8] = [
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "NO_COLOR",
        "COLOR",
        "FORCE_COLOR",
        "npm_config_prefix",
        "GITHUB_TOKEN",
    ];

    /// Keys the old inline create_shell set (macOS/Linux), with the values the deps above yield.
    fn expected_set(github: bool) -> BTreeMap<String, String> {
        let path = "/Users/alice/.nvm/versions/node/v22.1.0/bin:/Users/alice/.local/bin:\
/Users/alice/.opencode/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
        let mut m: BTreeMap<String, String> = [
            ("BBARIT_TERMINAL_ID", "term-1".to_string()),
            ("BBARIT_BRIDGE_PORT", crate::browser_bridge::BRIDGE_PORT.to_string()),
            ("BBARIT_CLAUDE_HOOK", HOOK.to_string()),
            ("PAGER", "cat".into()),
            ("GIT_PAGER", "cat".into()),
            ("GH_PAGER", "cat".into()),
            ("BBARIT_TERM_SCOPE", "1700000000000-0badc0de".into()),
            ("BBARIT_CTL", CTL.into()),
            ("TERM", "xterm-256color".into()),
            ("COLORTERM", "truecolor".into()),
            ("LANG", "ko_KR.UTF-8".into()),
            ("LC_ALL", "ko_KR.UTF-8".into()),
            ("HOME", "/Users/alice".into()),
            ("USER", "alice".into()),
            ("PATH", path.into()),
            ("SHELL", "/bin/zsh".into()),
            ("NVM_DIR", "/Users/alice/.nvm".into()),
            ("OPENAI_API_KEY", "sk-quoted".into()),
            ("EXTRA_SINGLE", "x y".into()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        if github {
            m.insert("GH_TOKEN".into(), "gho_test".into());
            m.insert("BBARIT_GITHUB_ACCOUNT".into(), "alice".into());
        }
        m
    }

    fn env_map(cmd: &CommandBuilder) -> BTreeMap<String, String> {
        cmd.iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// Run the env step on a known "inherited" env so removals are observable.
    fn env_from_seed(github: bool) -> BTreeMap<String, String> {
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env_clear();
        for key in REMOVED_KEYS {
            cmd.env(key, "inherited");
        }
        cmd.env("KEEP_ME", "inherited");
        cmd.env("PATH", "/inherited/bin");
        cmd.env("HOME", "/inherited/home");
        apply_shell_env(&mut cmd, &spec(), &deps(github), "xterm-256color");
        env_map(&cmd)
    }

    #[test]
    fn argv_and_cwd_match_old_create_shell() {
        let cmd = build_shell_command(&spec(), &deps(true)).unwrap();
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv, vec!["/bin/zsh", "-l"]);
        assert_eq!(cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()), Some("/work/proj".into()));
    }

    #[test]
    fn env_is_exactly_inherited_minus_removed_plus_set() {
        let mut expected = expected_set(true);
        expected.insert("KEEP_ME".into(), "inherited".into());
        assert_eq!(env_from_seed(true), expected);
    }

    #[test]
    fn github_token_is_kept_when_no_account_resolved() {
        let mut expected = expected_set(false);
        expected.insert("KEEP_ME".into(), "inherited".into());
        expected.insert("GITHUB_TOKEN".into(), "inherited".into());
        assert_eq!(env_from_seed(false), expected);
    }

    #[test]
    fn full_builder_on_real_inherited_env_sets_and_removes_the_same_keys() {
        let env = env_map(&build_shell_command(&spec(), &deps(true)).unwrap());
        for (key, value) in expected_set(true) {
            assert_eq!(env.get(&key), Some(&value), "{key}");
        }
        for key in REMOVED_KEYS {
            assert!(!env.contains_key(key), "{key} should be removed");
        }
    }

    #[test]
    fn missing_hook_and_ctl_leave_their_keys_out() {
        let mut d = deps(false);
        d.claude_hook = None;
        d.ctl_path = None;
        d.env_file = None;
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.env_clear();
        apply_shell_env(&mut cmd, &spec(), &d, "xterm-256color");
        let env = env_map(&cmd);
        for key in ["BBARIT_CLAUDE_HOOK", "BBARIT_CTL", "OPENAI_API_KEY", "GH_TOKEN"] {
            assert!(!env.contains_key(key), "{key}");
        }
        assert_eq!(env.get("BBARIT_TERMINAL_ID").map(String::as_str), Some("term-1"));
    }

    #[test]
    fn env_file_and_github_account_override_earlier_values() {
        let mut d = deps(true);
        d.env_file = Some("PATH=/from/env/file\nGH_TOKEN=from_file\n".into());
        let mut cmd = CommandBuilder::new("/bin/zsh");
        apply_shell_env(&mut cmd, &spec(), &d, "xterm-256color");
        assert_eq!(cmd.get_env("PATH").and_then(|v| v.to_str()), Some("/from/env/file"));
        // The GitHub account is applied last, as before.
        assert_eq!(cmd.get_env("GH_TOKEN").and_then(|v| v.to_str()), Some("gho_test"));
    }

    // ─── PtySelection ───

    #[test]
    fn selection_defaults_to_in_process_and_resolves_lazily() {
        for setting in [None, Some("off"), Some("bogus")] {
            let sel = PtySelection::new(setting);
            // Nothing resolved yet: calls behave like an empty backend.
            assert_eq!(sel.read("x"), Err("PTY not found".to_string()));
            assert_eq!(sel.close("x"), Ok(()));
            assert!(sel.list().is_empty() && !sel.alive("x"));
            assert!(!sel.on_app_exit(ExitReason::Quit), "in-process exit sweep stays with the caller");
            assert_eq!(sel.recovered_list(), serde_json::json!([]));
            let info = sel.info();
            assert_eq!(info["kind"], "in-process");
            assert_eq!(info["recovered"], serde_json::json!([]));
            assert!(info["fallbackReason"].is_null(), "{setting:?}: {info}");
        }
        let sel = PtySelection::new(None);
        sel.spawn(SpawnRequest {
            terminal_id: "s1".into(),
            cmd: sh("printf sel"),
            rows: 24,
            cols: 80,
            scope_token: TEST_SCOPE.into(),
            replace: false,
        })
        .unwrap();
        assert_eq!(sel.list().len(), 1);
        sel.close("s1").unwrap();
    }

    #[test]
    fn goodbye_reason_selection() {
        use ExitReason::*;
        // (keep_running, kill_all requested, handover) → reason
        assert_eq!(exit_goodbye_reason(true, false, false), Quit);
        assert_eq!(exit_goodbye_reason(false, false, false), KillAll);
        assert_eq!(exit_goodbye_reason(true, false, true), Handover);
        assert_eq!(exit_goodbye_reason(false, false, true), Handover, "updates keep terminals");
        assert_eq!(exit_goodbye_reason(true, true, false), KillAll, "the menu item wins");
        assert_eq!(exit_goodbye_reason(true, true, true), KillAll);
        assert_eq!((Quit.as_str(), Handover.as_str(), KillAll.as_str()), ("quit", "handover", "kill_all"));
    }

    #[test]
    fn keep_running_on_quit_defaults_true_but_debug_needs_explicit_true() {
        assert!(keep_running_on_quit(None, false));
        assert!(!keep_running_on_quit(Some(false), false));
        assert!(keep_running_on_quit(Some(true), false));
        assert!(!keep_running_on_quit(None, true), "dev default is kill_all");
        assert!(!keep_running_on_quit(Some(false), true));
        assert!(keep_running_on_quit(Some(true), true));
    }

    #[test]
    fn holder_failure_falls_back_to_in_process_with_the_reason() {
        let mut sel = PtySelection::new(Some("on"));
        // A run dir whose socket path can't fit sun_path: the holder is never started.
        sel.run_dir = Some(std::env::temp_dir().join("x".repeat(120)));
        let info = sel.info();
        assert_eq!(info["kind"], "in-process");
        let reason = info["fallbackReason"].as_str().unwrap();
        assert!(reason.contains("max 100"), "{reason}");
        assert!(sel.read("x").is_err());
        let _ = std::fs::remove_dir(std::env::temp_dir().join("x".repeat(120)));
    }

    // ─── InProcessBackend ───

    fn sh(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd
    }

    // Deliberately not a well-formed scope token: close() must never sweep real processes.
    const TEST_SCOPE: &str = "test-scope";

    fn spawn(backend: &InProcessBackend, id: &str, script: &str) {
        backend
            .spawn(SpawnRequest {
                terminal_id: id.into(),
                cmd: sh(script),
                rows: 24,
                cols: 80,
                scope_token: TEST_SCOPE.into(),
                replace: false,
            })
            .unwrap();
    }

    #[test]
    fn unknown_terminal_keeps_the_frontend_error_strings() {
        let b = InProcessBackend::default();
        assert_eq!(b.read("nope"), Err("PTY not found".to_string()));
        assert_eq!(b.write("nope", "x"), Err("PTY not found".to_string()));
        assert_eq!(b.resize("nope", 10, 10), Err("PTY not found".to_string()));
        assert_eq!(b.tail("nope"), Err("PTY not found".to_string()));
        assert_eq!(b.idle_ms("nope"), Err("PTY not found".to_string()));
        assert_eq!(b.pid("nope"), Err("PTY not found".to_string()));
        assert!(!b.alive("nope"));
        assert_eq!(b.close("nope"), Ok(()));
        assert!(b.list().is_empty());
    }

    #[test]
    fn output_is_pulled_then_disconnected_and_kept_in_tail() {
        let b = InProcessBackend::default();
        // "é" is split across two printf writes to exercise UTF-8 reassembly.
        spawn(&b, "t1", "printf 'hi \\303'; printf '\\251 done'");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut out = String::new();
        let end = loop {
            assert!(Instant::now() < deadline, "no disconnect; got {out:?}");
            match b.read("t1") {
                Ok(Some(chunk)) => out.push_str(&chunk),
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => break e,
            }
        };
        assert_eq!(end, "PTY disconnected");
        assert!(out.contains("hi é done"), "{out:?}");
        assert!(!b.alive("t1"));
        assert!(b.tail("t1").unwrap().contains("hi é done"));
        assert!(b.pid("t1").unwrap().is_some());
        assert!(b.idle_ms("t1").is_ok());
        let list = b.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "t1");
        assert_eq!(list[0].scope_token, TEST_SCOPE);
        b.close("t1").unwrap();
        assert!(b.list().is_empty());
    }

    #[test]
    fn attach_snapshot_takes_the_buffer_and_drains_the_queue() {
        let b = InProcessBackend::default();
        spawn(&b, "t3", "printf 'one\\n'; read l; printf 'two:%s\\n' \"$l\"; sleep 30");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !b.tail("t3").unwrap().contains("one") {
            assert!(Instant::now() < deadline, "no output");
            std::thread::sleep(Duration::from_millis(20));
        }
        // tail() is a read-only copy: the queue still holds "one".
        assert!(b.tail("t3").unwrap().contains("one"));
        // A webview reload replays the snapshot; read() must not hand "one" over again.
        let snap = b.attach_snapshot("t3").unwrap();
        assert!(snap.contains("one"), "{snap:?}");
        assert_eq!(b.read("t3"), Ok(None));
        b.write("t3", "x\n").unwrap();
        let mut out = String::new();
        while !out.contains("two:x") {
            assert!(Instant::now() < deadline, "no echo; got {out:?}");
            if let Ok(Some(chunk)) = b.read("t3") {
                out.push_str(&chunk);
            } else {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        assert!(!out.contains("one"), "{out:?}");
        assert_eq!(b.attach_snapshot("nope"), Err("PTY not found".to_string()));
        b.close("t3").unwrap();
    }

    #[test]
    fn write_resize_and_close_a_running_shell() {
        let b = InProcessBackend::default();
        spawn(&b, "t2", "read line; echo \"got:$line\"; sleep 30");
        assert!(b.alive("t2"));
        b.resize("t2", 40, 120).unwrap();
        b.write("t2", "ping\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut out = String::new();
        while !out.contains("got:ping") {
            assert!(Instant::now() < deadline, "no echo; got {out:?}");
            if let Ok(Some(chunk)) = b.read("t2") {
                out.push_str(&chunk);
            } else {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let pid = b.pid("t2").unwrap().expect("shell pid");
        b.close("t2").unwrap();
        assert_eq!(b.read("t2"), Err("PTY not found".to_string()));
        assert!(!b.alive("t2"));
        // close() reaps in the background; the shell must be gone shortly after.
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            assert!(Instant::now() < deadline, "shell {pid} survived close");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
