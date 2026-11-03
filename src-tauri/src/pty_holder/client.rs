//! `HolderBackend`: the app side of the holder (docs/PTY_HOLDER_DAEMON.md 3.4).
//!
//! One socket connection; a reader thread routes OUTPUT into per-terminal queues
//! (`sync_channel(1024)`, same never-blocking/truncation rules as `InProcessBackend`)
//! and a per-terminal tail copy for `tail()`. UTF-8 reassembly happens here, per
//! terminal; the holder only moves bytes. Frames go out through a writer thread, so
//! a command (`write_to_pty` runs on the main thread) never blocks on the socket.
//!
//! No duplicate rendering: every terminal tracks `next_seq`, the stream offset of
//! the next byte expected from the holder. After a reconnect, only the part of the
//! TAIL at or past `next_seq` reaches the read queue. A terminal first seen in a
//! WELCOME (the app restarted) gets its TAIL as `tail()` only; `read()` then
//! returns just the bytes produced after it. Frames from any connection other than
//! the current one are ignored, and only one connect runs at a time.

use super::proto::{self, Frame, TerminalEntry};
use crate::pty_backend::{
    append_output_buffer, drain_output, new_output_channel, OutputQueue, PtyBackend, SpawnRequest,
    TerminalInfo, Utf8Reassembler, PTY_DISCONNECTED, PTY_NOT_FOUND,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A write the holder doesn't take within this long means the connection is gone.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const SPAWN_REPLY_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(10);
/// Three missed PONGs.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to keep retrying the same socket after the connection drops.
const RECONNECT_WINDOW: Duration = Duration::from_secs(10);
/// How long GOODBYE waits for the writer to flush (app exit).
const GOODBYE_FLUSH: Duration = Duration::from_secs(1);

struct Term {
    /// Holder handle; kept after EXITED (the holder keeps the tail until RELEASE),
    /// None once the holder lost the terminal.
    handle: Option<u32>,
    /// None once the program was reaped: the pid may already belong to someone else.
    pid: Option<u32>,
    scope: String,
    /// None once the program exited or the holder lost it: `read()` then reports
    /// "PTY disconnected" after the queue drains.
    queue: Option<OutputQueue>,
    rx: Receiver<String>,
    decoder: Utf8Reassembler,
    buffer: String,
    next_seq: u64,
    alive: bool,
    last_output_at: Instant,
    /// Seeded from a WELCOME and not yet replayed by the frontend: live output that
    /// arrives before the first `tail()` lands in both the buffer and the queue, so
    /// that `tail()` drains the queue to avoid rendering it twice.
    replay_pending: bool,
}

impl Term {
    fn new(handle: u32, pid: Option<u32>, scope: String) -> Self {
        let (queue, rx) = new_output_channel();
        Term {
            handle: Some(handle),
            pid,
            scope,
            queue: Some(queue),
            rx,
            decoder: Utf8Reassembler::default(),
            buffer: String::new(),
            next_seq: 0,
            alive: true,
            last_output_at: Instant::now(),
            replay_pending: false,
        }
    }

    /// The tail copy for `tail()`. The first call after a seed also discards what the
    /// queue holds: those bytes are in this copy, and `read()` must return only
    /// output produced after it (otherwise the reattach point renders twice).
    fn snapshot(&mut self) -> String {
        if self.replay_pending {
            self.replay_pending = false;
            while self.rx.try_recv().is_ok() {}
            if let Some(q) = self.queue.as_mut() {
                q.clear_truncated();
            }
        }
        self.buffer.clone()
    }

    /// Bytes for the frontend: tail copy + read queue.
    fn deliver(&mut self, bytes: &[u8]) {
        self.next_seq += bytes.len() as u64;
        self.last_output_at = Instant::now();
        let Term {
            decoder,
            buffer,
            queue,
            ..
        } = self;
        decoder.push(bytes, &mut |s: String| {
            append_output_buffer(buffer, &s);
            if let Some(q) = queue.as_mut() {
                q.send(s);
            }
            true
        });
    }

    /// TAIL bytes starting at `seq_start`: the part this app has not delivered yet goes
    /// to the queue (a gap gets the truncation marker).
    fn catch_up(&mut self, seq_start: u64, bytes: &[u8]) {
        if self.next_seq < seq_start {
            if let Some(q) = self.queue.as_mut() {
                q.mark_truncated();
            }
            self.next_seq = seq_start;
        }
        let skip = (self.next_seq - seq_start).min(bytes.len() as u64) as usize;
        self.deliver(&bytes[skip..]);
    }

    /// Bytes the frontend replays itself via `tail()` (recovered terminal): no queue.
    fn seed(&mut self, bytes: &[u8], seq_end: u64) {
        let Term {
            decoder, buffer, ..
        } = self;
        decoder.push(bytes, &mut |s: String| {
            append_output_buffer(buffer, &s);
            true
        });
        self.next_seq = seq_end;
        self.replay_pending = true;
    }

    /// The program ended (EXITED): no more output, and its pid is no longer ours.
    fn end(&mut self) {
        if let Some(rest) = self.decoder.finish() {
            append_output_buffer(&mut self.buffer, &rest);
            if let Some(q) = self.queue.as_mut() {
                q.send(rest);
            }
        }
        self.alive = false;
        self.queue = None;
        self.pid = None;
    }

    /// The holder no longer has it (holder gone, or a WELCOME without it).
    fn lose(&mut self) {
        self.end();
        self.handle = None;
    }
}

#[derive(Default)]
struct Shared {
    terms: HashMap<String, Term>,
    by_handle: HashMap<u32, String>,
    /// SPAWN sent, reply pending: id → (scope token, connection it went out on).
    pending: HashMap<String, (String, u64)>,
    replies: HashMap<String, Result<(), String>>,
    /// Terminals found in the first WELCOME (they outlived the previous app).
    recovered: Vec<TerminalEntry>,
    welcomed: bool,
    instance: Option<String>,
    /// Connection whose frames are current; frames from any other are dropped.
    generation: u64,
    /// Why the connection is gone (BYE reason, holder vanished), if it is.
    lost: Option<String>,
    /// Closed while no connection was up: RELEASE them if the next WELCOME lists them.
    release_later: HashSet<String>,
}

enum Out {
    Frame(Vec<u8>),
    /// Flush, shut the socket down, then signal.
    Close(Option<Sender<()>>),
}

struct Link {
    generation: u64,
    stream: UnixStream,
    out: Sender<Out>,
}

struct Inner {
    socket: Mutex<PathBuf>,
    /// Where to discover/spawn a new holder after losing ours (None: fixed socket, tests).
    run_dir: Option<PathBuf>,
    shared: Mutex<Shared>,
    replied: Condvar,
    link: Mutex<Option<Link>>,
    /// Held across connect + adopt so two reconnects never race.
    connecting: Mutex<()>,
    next_generation: Mutex<u64>,
    closing: AtomicBool,
}

pub struct HolderBackend {
    inner: Arc<Inner>,
}

/// A connected, welcomed socket.
struct Session {
    stream: UnixStream,
    welcome: proto::Welcome,
    tails: Vec<(u32, proto::TailHeader, Vec<u8>)>,
}

fn connect_session(socket: &Path) -> Result<Session, String> {
    super::check_socket_path(socket)?;
    let mut stream =
        UnixStream::connect(socket).map_err(|e| format!("connect {}: {e}", socket.display()))?;
    stream
        .set_read_timeout(Some(CONNECT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(WRITE_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let hello =
        proto::encode_json(proto::HELLO, 0, &proto::Hello::current()).map_err(|e| e.to_string())?;
    stream
        .write_all(&hello)
        .map_err(|e| format!("HELLO: {e}"))?;
    let first = proto::read_frame(&mut stream).map_err(|e| format!("waiting for WELCOME: {e}"))?;
    if first.kind == proto::BYE {
        let bye: proto::Bye = proto::parse(&first).map_err(|e| e.to_string())?;
        return Err(format!("holder refused: {}", bye.reason));
    }
    if first.kind != proto::WELCOME {
        return Err(format!("expected WELCOME, got frame kind {}", first.kind));
    }
    let welcome: proto::Welcome = proto::parse(&first).map_err(|e| e.to_string())?;
    if welcome.version != proto::PROTOCOL_VERSION {
        return Err(format!(
            "holder speaks protocol {} (app {})",
            welcome.version,
            proto::PROTOCOL_VERSION
        ));
    }
    let mut tails = Vec::with_capacity(welcome.terminals.len());
    for _ in &welcome.terminals {
        let f = proto::read_frame(&mut stream).map_err(|e| format!("waiting for TAIL: {e}"))?;
        if f.kind != proto::TAIL {
            return Err(format!("expected TAIL, got frame kind {}", f.kind));
        }
        let (header, bytes) = proto::decode_tail(&f.payload).map_err(|e| e.to_string())?;
        tails.push((f.handle, header, bytes.to_vec()));
    }
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(|e| e.to_string())?;
    Ok(Session {
        stream,
        welcome,
        tails,
    })
}

/// Writes queued frames in order; a failed or timed-out write closes the connection
/// (the reader then sees EOF and reconnects).
fn link_writer(mut stream: UnixStream, rx: Receiver<Out>) {
    let mut ack = None;
    for msg in rx {
        match msg {
            Out::Frame(bytes) => {
                if stream.write_all(&bytes).is_err() {
                    break;
                }
            }
            Out::Close(done) => {
                ack = done;
                break;
            }
        }
    }
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
    if let Some(done) = ack {
        let _ = done.send(());
    }
}

impl HolderBackend {
    /// Attach to the holder listening on `socket` (no discovery, no respawn).
    #[cfg(test)]
    pub fn connect(socket: &Path) -> Result<Self, String> {
        Self::start(socket.to_path_buf(), None)
    }

    /// Attach to a live holder of our protocol version in `run_dir`, or start one.
    pub fn attach_or_spawn(run_dir: &Path) -> Result<Self, String> {
        let socket = super::spawn::find_or_spawn(run_dir)?;
        Self::start(socket, Some(run_dir.to_path_buf()))
    }

    fn start(socket: PathBuf, run_dir: Option<PathBuf>) -> Result<Self, String> {
        let session = connect_session(&socket)?;
        let inner = Arc::new(Inner {
            socket: Mutex::new(socket),
            run_dir,
            shared: Mutex::new(Shared::default()),
            replied: Condvar::new(),
            link: Mutex::new(None),
            connecting: Mutex::new(()),
            next_generation: Mutex::new(0),
            closing: AtomicBool::new(false),
        });
        inner.adopt(session)?;
        let weak = Arc::downgrade(&inner);
        thread::spawn(move || pinger(weak));
        Ok(HolderBackend { inner })
    }

    pub fn socket(&self) -> PathBuf {
        self.inner
            .socket
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Terminals that were already in the holder when this app attached (for reattach, 2b).
    pub fn recovered(&self) -> Vec<TerminalEntry> {
        self.inner.lock_shared().recovered.clone()
    }

    /// Terminals the frontend should attach to instead of creating (`pty_list_recovered`):
    /// the ones the first WELCOME brought (they outlived the previous app run) plus the ones
    /// this app started and still holds (a webview reload). Closed terminals are left out;
    /// `exited` and `pid` reflect the current state.
    pub fn recovered_now(&self) -> Vec<TerminalEntry> {
        recovered_now(&self.inner.lock_shared())
    }

    /// The connection is gone and could not be re-established (reason), if so.
    pub fn lost_reason(&self) -> Option<String> {
        self.inner.lock_shared().lost.clone()
    }

    /// GOODBYE {reason} ("quit" | "handover" | "kill_all") and disconnect. Waits briefly
    /// for the frame to leave (the app is usually about to exit).
    pub fn goodbye(&self, reason: &str) {
        self.inner.closing.store(true, Ordering::SeqCst);
        if let Ok(f) = proto::encode_json(
            proto::GOODBYE,
            0,
            &proto::Goodbye {
                reason: reason.to_string(),
            },
        ) {
            let _ = self.inner.send(f);
        }
        let link = self.inner.take_link();
        if let Some(link) = link {
            let (done, flushed) = mpsc::channel();
            if link.out.send(Out::Close(Some(done))).is_ok() {
                let _ = flushed.recv_timeout(GOODBYE_FLUSH);
            }
            let _ = link.stream.shutdown(std::net::Shutdown::Both);
        }
    }

    /// Connections made so far, if one is currently up (tests wait for a reconnect).
    #[cfg(test)]
    pub fn live_connection(&self) -> Option<u64> {
        self.inner
            .link
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|l| l.generation)
    }

    /// Test hook: what the reconnect paths call, from any thread.
    #[cfg(test)]
    pub fn relink_for_test(&self) -> Result<(), String> {
        self.inner.relink()
    }

    fn handle_of(&self, id: &str) -> Result<u32, String> {
        let shared = self.inner.lock_shared();
        let term = shared
            .terms
            .get(id)
            .ok_or_else(|| PTY_NOT_FOUND.to_string())?;
        term.handle
            .filter(|_| term.alive)
            .ok_or_else(|| PTY_DISCONNECTED.to_string())
    }
}

impl Drop for HolderBackend {
    fn drop(&mut self) {
        self.inner.closing.store(true, Ordering::SeqCst);
        if let Some(link) = self.inner.take_link() {
            let _ = link.out.send(Out::Close(None));
            let _ = link.stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl Inner {
    fn lock_shared(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn take_link(&self) -> Option<Link> {
        self.link.lock().unwrap_or_else(|p| p.into_inner()).take()
    }

    /// Queue one frame on the current connection. Never blocks on the socket.
    fn send(&self, frame: Vec<u8>) -> Result<(), String> {
        let link = self.link.lock().unwrap_or_else(|p| p.into_inner());
        let Some(l) = link.as_ref() else {
            return Err(PTY_DISCONNECTED.to_string());
        };
        l.out
            .send(Out::Frame(frame))
            .map_err(|_| PTY_DISCONNECTED.to_string())
    }

    fn is_linked(&self) -> bool {
        self.link
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// Take over a welcomed session: reconcile terminals, start its reader and writer.
    /// Callers hold `connecting` (or are the constructor).
    fn adopt(self: &Arc<Self>, session: Session) -> Result<(), String> {
        let Session {
            stream,
            welcome,
            tails,
        } = session;
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        let writer = stream.try_clone().map_err(|e| e.to_string())?;
        let generation = {
            let mut g = self
                .next_generation
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            *g += 1;
            *g
        };
        let (out, queued) = mpsc::channel::<Out>();
        thread::spawn(move || link_writer(writer, queued));
        // The link is installed while `shared` is held, so no frame of this connection is
        // processed (on_frame checks the generation) before the WELCOME is applied.
        let release = {
            let mut shared = self.lock_shared();
            shared.generation = generation;
            let release = apply_welcome(&mut shared, &welcome, tails, generation);
            *self.link.lock().unwrap_or_else(|p| p.into_inner()) = Some(Link {
                generation,
                stream,
                out,
            });
            self.replied.notify_all();
            release
        };
        for handle in release {
            if let Ok(f) = proto::encode(proto::RELEASE, handle, &[]) {
                let _ = self.send(f);
            }
        }
        let inner = Arc::clone(self);
        thread::spawn(move || inner.read_loop(generation, reader));
        Ok(())
    }

    fn read_loop(self: Arc<Self>, generation: u64, mut stream: UnixStream) {
        let mut bye: Option<String> = None;
        while let Ok(frame) = proto::read_frame(&mut stream) {
            if frame.kind == proto::BYE {
                bye = Some(
                    proto::parse::<proto::Bye>(&frame)
                        .map(|b| b.reason)
                        .unwrap_or_else(|_| "bye".to_string()),
                );
                break;
            }
            self.on_frame(generation, frame);
        }
        {
            let mut link = self.link.lock().unwrap_or_else(|p| p.into_inner());
            if link.as_ref().is_some_and(|l| l.generation == generation) {
                if let Some(l) = link.take() {
                    let _ = l.out.send(Out::Close(None));
                }
            } else {
                return; // a newer connection already replaced this one
            }
        }
        if self.closing.load(Ordering::SeqCst) {
            return;
        }
        if let Some(reason) = bye {
            // Another app took the holder over; reconnecting would just steal it back.
            self.mark_all_lost(generation, format!("holder dropped this app: {reason}"));
            return;
        }
        let socket = self
            .socket
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let deadline = Instant::now() + RECONNECT_WINDOW;
        let mut backoff = Duration::from_millis(100);
        while Instant::now() < deadline && !self.closing.load(Ordering::SeqCst) {
            {
                let _connecting = self.connecting.lock().unwrap_or_else(|p| p.into_inner());
                if self.is_linked() {
                    return; // someone else (spawn's relink) already reconnected
                }
                if let Ok(session) = connect_session(&socket) {
                    if self.adopt(session).is_ok() {
                        safe_eprintln!("[pty-holder] reconnected to {}", socket.display());
                        return;
                    }
                }
            }
            thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(2));
        }
        self.mark_all_lost(
            generation,
            format!("holder at {} is gone", socket.display()),
        );
    }

    fn on_frame(&self, generation: u64, frame: Frame) {
        let mut shared = self.lock_shared();
        if shared.generation != generation {
            return; // a stale connection's frame
        }
        match frame.kind {
            proto::OUTPUT => {
                let Some(id) = shared.by_handle.get(&frame.handle).cloned() else {
                    return;
                };
                if let Some(term) = shared.terms.get_mut(&id) {
                    term.deliver(&frame.payload);
                }
            }
            proto::SPAWNED => {
                let Ok(s) = proto::parse::<proto::Spawned>(&frame) else {
                    return;
                };
                let Some((scope, _)) = shared.pending.remove(&s.id) else {
                    // Nobody waits for it (timed out, or closed meanwhile): don't leak it.
                    if let Ok(f) = proto::encode(proto::RELEASE, s.handle, &[]) {
                        let _ = self.send(f);
                    }
                    return;
                };
                if let Some(old) = shared.terms.get(&s.id).and_then(|t| t.handle) {
                    shared.by_handle.remove(&old);
                }
                shared.by_handle.insert(s.handle, s.id.clone());
                shared
                    .terms
                    .insert(s.id.clone(), Term::new(s.handle, s.pid, scope));
                shared.replies.insert(s.id, Ok(()));
                self.replied.notify_all();
            }
            proto::SPAWN_FAILED => {
                let Ok(f) = proto::parse::<proto::SpawnFailed>(&frame) else {
                    return;
                };
                shared.pending.remove(&f.id);
                shared.replies.insert(f.id, Err(f.error));
                self.replied.notify_all();
            }
            proto::EXITED => {
                let Some(id) = shared.by_handle.remove(&frame.handle) else {
                    return;
                };
                if let Some(term) = shared.terms.get_mut(&id) {
                    term.end();
                }
            }
            _ => {} // PONG, and nothing else is expected mid-stream
        }
    }

    /// Give up on the connection `generation` (no-op if a newer one is up).
    fn mark_all_lost(&self, generation: u64, reason: String) {
        let mut shared = self.lock_shared();
        if shared.generation != generation || self.is_linked() {
            return;
        }
        safe_eprintln!("[pty-holder] {reason}");
        for term in shared.terms.values_mut() {
            term.lose();
        }
        shared.by_handle.clear();
        for (id, _) in std::mem::take(&mut shared.pending) {
            shared.replies.insert(id, Err(reason.clone()));
        }
        shared.lost = Some(reason);
        self.replied.notify_all();
    }

    /// After losing the holder: find or start another (run-dir mode only).
    fn relink(self: &Arc<Self>) -> Result<(), String> {
        let _connecting = self.connecting.lock().unwrap_or_else(|p| p.into_inner());
        if self.is_linked() {
            return Ok(());
        }
        let socket = match &self.run_dir {
            Some(dir) => super::spawn::find_or_spawn(dir)?,
            None => self
                .socket
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        };
        let session = connect_session(&socket)?;
        *self.socket.lock().unwrap_or_else(|p| p.into_inner()) = socket;
        self.adopt(session)?;
        self.lock_shared().lost = None;
        Ok(())
    }
}

fn recovered_now(shared: &Shared) -> Vec<TerminalEntry> {
    let mut out: Vec<TerminalEntry> = Vec::new();
    for (id, term) in &shared.terms {
        let Some(handle) = term.handle else {
            continue; // the holder lost it: nothing to attach to
        };
        let mut entry = match shared.recovered.iter().find(|e| &e.id == id) {
            Some(e) => e.clone(),
            None => TerminalEntry {
                handle,
                id: id.clone(),
                cwd: None,
                pid: None,
                rows: 0,
                cols: 0,
                exited: false,
                exit_code: None,
                scope: term.scope.clone(),
                started_at: 0,
                dropped_bytes: 0,
                modes: proto::Modes::default(),
            },
        };
        entry.handle = handle;
        entry.exited = entry.exited || !term.alive;
        entry.pid = if term.alive { term.pid } else { None };
        out.push(entry);
    }
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Reconcile local terminals with a WELCOME and its TAILs. Returns the handles of
/// terminals this app closed while disconnected (to RELEASE now).
fn apply_welcome(
    shared: &mut Shared,
    welcome: &proto::Welcome,
    tails: Vec<(u32, proto::TailHeader, Vec<u8>)>,
    generation: u64,
) -> Vec<u32> {
    let first = !shared.welcomed;
    shared.welcomed = true;
    if shared.instance.as_deref() != Some(welcome.instance.as_str()) && !first {
        safe_eprintln!(
            "[pty-holder] attached to a different holder instance {}",
            welcome.instance
        );
    }
    shared.instance = Some(welcome.instance.clone());
    let mut tails: HashMap<u32, (proto::TailHeader, Vec<u8>)> = tails
        .into_iter()
        .map(|(h, header, bytes)| (h, (header, bytes)))
        .collect();
    shared.by_handle.clear();
    let mut seen: Vec<&str> = Vec::new();
    let mut release = Vec::new();
    for entry in &welcome.terminals {
        if shared.release_later.remove(&entry.id) {
            release.push(entry.handle);
            continue;
        }
        seen.push(entry.id.as_str());
        let (header, bytes) = tails.remove(&entry.handle).unwrap_or((
            proto::TailHeader {
                seq_start: 0,
                dropped_bytes: entry.dropped_bytes,
            },
            Vec::new(),
        ));
        let seq_end = header.seq_start + bytes.len() as u64;
        if let Some((scope, _)) = shared.pending.remove(&entry.id) {
            // Our SPAWN went through but its SPAWNED was lost with the old connection:
            // everything it printed is new to the frontend.
            let mut term = Term::new(entry.handle, entry.pid, scope);
            term.catch_up(header.seq_start, &bytes);
            shared.terms.insert(entry.id.clone(), term);
            shared.replies.insert(entry.id.clone(), Ok(()));
        } else {
            match shared.terms.get_mut(&entry.id) {
                Some(term) if term.alive || term.handle.is_some() => {
                    // Reconnect: hand over only what this app has not delivered yet.
                    term.catch_up(header.seq_start, &bytes);
                    term.handle = Some(entry.handle);
                    if term.alive {
                        term.pid = entry.pid;
                    }
                }
                _ => {
                    // First sight (app restarted, or the id was closed here and lives on there).
                    let mut term = Term::new(entry.handle, entry.pid, entry.scope.clone());
                    term.seed(&bytes, seq_end);
                    shared.terms.insert(entry.id.clone(), term);
                    if first {
                        shared.recovered.push(entry.clone());
                    }
                }
            }
        }
        let term = shared.terms.get_mut(&entry.id).expect("just inserted");
        term.next_seq = seq_end;
        if entry.exited {
            term.end();
        } else {
            shared.by_handle.insert(entry.handle, entry.id.clone());
        }
    }
    // Only ids the very next WELCOME could still list are worth remembering.
    shared.release_later.clear();
    // SPAWNs sent on an older connection that this holder never started.
    let stale: Vec<String> = shared
        .pending
        .iter()
        .filter(|(_, (_, sent_on))| *sent_on < generation)
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        shared.pending.remove(&id);
        shared.replies.insert(
            id,
            Err("pty holder connection was lost during SPAWN".to_string()),
        );
    }
    // Ours, but unknown to this holder: it lost them.
    for (id, term) in shared.terms.iter_mut() {
        if !seen.contains(&id.as_str()) && term.handle.is_some() {
            term.lose();
        }
    }
    release
}

fn pinger(inner: Weak<Inner>) {
    loop {
        thread::sleep(PING_INTERVAL);
        let Some(inner) = inner.upgrade() else { return };
        if inner.closing.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(f) = proto::encode(proto::PING, 0, &[]) {
            let _ = inner.send(f);
        }
    }
}

impl PtyBackend for HolderBackend {
    fn spawn(&self, req: SpawnRequest) -> Result<(), String> {
        let SpawnRequest {
            terminal_id,
            cmd,
            rows,
            cols,
            scope_token,
        } = req;
        // Same id again (no reattach UI yet): replace it, like the in-process map does.
        if self.inner.lock_shared().terms.contains_key(&terminal_id) {
            self.close(&terminal_id)?;
        }
        self.inner.relink()?;
        let spawn = proto::Spawn {
            id: terminal_id.clone(),
            argv: cmd
                .get_argv()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            cwd: cmd.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            env: cmd
                .iter_full_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
            rows,
            cols,
            scope: scope_token.clone(),
        };
        let frame = proto::encode_json(proto::SPAWN, 0, &spawn).map_err(|e| e.to_string())?;
        let mut shared = self.inner.lock_shared();
        // A fresh terminal under a reused id must never be RELEASEd for the old one.
        shared.release_later.remove(&terminal_id);
        shared.replies.remove(&terminal_id);
        let generation = shared.generation;
        shared
            .pending
            .insert(terminal_id.clone(), (scope_token, generation));
        drop(shared);
        if let Err(e) = self.inner.send(frame) {
            self.inner.lock_shared().pending.remove(&terminal_id);
            return Err(e);
        }
        let deadline = Instant::now() + SPAWN_REPLY_TIMEOUT;
        let mut shared = self.inner.lock_shared();
        loop {
            if let Some(reply) = shared.replies.remove(&terminal_id) {
                return reply;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // A late SPAWNED finds no pending entry and is RELEASEd (on_frame).
                shared.pending.remove(&terminal_id);
                return Err("pty holder did not answer SPAWN".to_string());
            }
            shared = self
                .inner
                .replied
                .wait_timeout(shared, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }

    fn read(&self, id: &str) -> Result<Option<String>, String> {
        let shared = self.inner.lock_shared();
        match shared.terms.get(id) {
            Some(term) => drain_output(&term.rx),
            None => Err(PTY_NOT_FOUND.to_string()),
        }
    }

    fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let handle = self.handle_of(id)?;
        let frame =
            proto::encode(proto::INPUT, handle, data.as_bytes()).map_err(|e| e.to_string())?;
        self.inner.send(frame)
    }

    fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let handle = self.handle_of(id)?;
        let frame = proto::encode_json(proto::RESIZE, handle, &proto::Resize { rows, cols })
            .map_err(|e| e.to_string())?;
        self.inner.send(frame)
    }

    fn close(&self, id: &str) -> Result<(), String> {
        let mut shared = self.inner.lock_shared();
        let Some(term) = shared.terms.remove(id) else {
            return Ok(());
        };
        // An exited terminal is still in the holder (with its tail) until RELEASE.
        let Some(handle) = term.handle else {
            return Ok(());
        };
        shared.by_handle.remove(&handle);
        let sent = proto::encode(proto::RELEASE, handle, &[])
            .map_err(|e| e.to_string())
            .and_then(|f| self.inner.send(f));
        if sent.is_err() {
            // Mid-reconnect: release it if the next WELCOME lists it.
            shared.release_later.insert(id.to_string());
        }
        Ok(())
    }

    fn alive(&self, id: &str) -> bool {
        self.inner
            .lock_shared()
            .terms
            .get(id)
            .is_some_and(|t| t.alive)
    }

    fn tail(&self, id: &str) -> Result<String, String> {
        match self.inner.lock_shared().terms.get_mut(id) {
            Some(term) => Ok(term.snapshot()),
            None => Err(PTY_NOT_FOUND.to_string()),
        }
    }

    fn idle_ms(&self, id: &str) -> Result<u64, String> {
        match self.inner.lock_shared().terms.get(id) {
            Some(term) => Ok(term.last_output_at.elapsed().as_millis() as u64),
            None => Err(PTY_NOT_FOUND.to_string()),
        }
    }

    /// None after the program ended: the holder reaped it and the pid may be reused.
    fn pid(&self, id: &str) -> Result<Option<u32>, String> {
        match self.inner.lock_shared().terms.get(id) {
            Some(term) => Ok(term.pid),
            None => Err(PTY_NOT_FOUND.to_string()),
        }
    }

    fn list(&self) -> Vec<TerminalInfo> {
        self.inner
            .lock_shared()
            .terms
            .iter()
            .map(|(id, t)| TerminalInfo {
                id: id.clone(),
                pid: t.pid,
                scope_token: t.scope.clone(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every call here is on one connection generation.
    fn apply_welcome(
        shared: &mut Shared,
        welcome: &proto::Welcome,
        tails: Vec<(u32, proto::TailHeader, Vec<u8>)>,
    ) -> Vec<u32> {
        super::apply_welcome(shared, welcome, tails, 1)
    }

    fn entry(id: &str, handle: u32, exited: bool) -> TerminalEntry {
        TerminalEntry {
            handle,
            id: id.into(),
            cwd: None,
            pid: Some(42),
            rows: 24,
            cols: 80,
            exited,
            exit_code: None,
            scope: "s".into(),
            started_at: 0,
            dropped_bytes: 0,
            modes: proto::Modes::default(),
        }
    }

    fn welcome(entries: Vec<TerminalEntry>) -> proto::Welcome {
        proto::Welcome {
            version: proto::PROTOCOL_VERSION,
            instance: "i".into(),
            terminals: entries,
        }
    }

    fn tail(handle: u32, seq_start: u64, bytes: &[u8]) -> (u32, proto::TailHeader, Vec<u8>) {
        (
            handle,
            proto::TailHeader {
                seq_start,
                dropped_bytes: seq_start,
            },
            bytes.to_vec(),
        )
    }

    fn drain(shared: &Shared, id: &str) -> String {
        let mut out = String::new();
        while let Ok(Some(c)) = drain_output(&shared.terms[id].rx) {
            out.push_str(&c);
        }
        out
    }

    #[test]
    fn first_welcome_seeds_tail_only_and_reconnect_delivers_only_new_bytes() {
        let mut shared = Shared::default();
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 7, false)]),
            vec![tail(7, 0, b"A1\n")],
        );
        assert_eq!(shared.recovered.len(), 1);
        assert_eq!(shared.terms["t"].buffer, "A1\n");
        assert_eq!(
            drain(&shared, "t"),
            "",
            "recovered tail must not be re-read"
        );

        // Live OUTPUT after the TAIL.
        shared.terms.get_mut("t").unwrap().deliver(b"B2\n");
        assert_eq!(drain(&shared, "t"), "B2\n");

        // Reconnect: the TAIL overlaps everything delivered; only C3 is new
        // (it was produced while this app was disconnected).
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 9, false)]),
            vec![tail(9, 0, b"A1\nB2\nC3\n")],
        );
        assert_eq!(drain(&shared, "t"), "C3\n");
        assert_eq!(shared.terms["t"].buffer, "A1\nB2\nC3\n");
        assert_eq!(shared.terms["t"].handle, Some(9));
        assert_eq!(shared.by_handle.get(&9).map(String::as_str), Some("t"));
        assert_eq!(shared.recovered.len(), 1, "a reconnect is not a recovery");
    }

    #[test]
    fn output_before_the_first_tail_of_a_recovered_terminal_renders_once() {
        let mut shared = Shared::default();
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 1, false)]),
            vec![tail(1, 0, b"tick 150\n")],
        );
        // The program keeps printing between the WELCOME and the frontend's replay.
        let term = shared.terms.get_mut("t").unwrap();
        term.deliver(b"tick 151\n");
        term.deliver(b"tick 152\n");
        assert_eq!(term.snapshot(), "tick 150\ntick 151\ntick 152\n");
        assert_eq!(drain(&shared, "t"), "", "replayed bytes must not be read again");

        let term = shared.terms.get_mut("t").unwrap();
        term.deliver(b"tick 153\n");
        // Later tail() calls (ctl term read, startup probe) leave the read queue alone.
        assert_eq!(term.snapshot(), "tick 150\ntick 151\ntick 152\ntick 153\n");
        assert_eq!(drain(&shared, "t"), "tick 153\n");
    }

    #[test]
    fn a_terminal_this_app_spawned_keeps_its_queue_on_tail() {
        let mut term = Term::new(1, Some(9), "s".into());
        term.deliver(b"live");
        assert_eq!(term.snapshot(), "live");
        assert_eq!(drain_output(&term.rx), Ok(Some("live".into())));
    }

    #[test]
    fn recovered_now_lists_live_and_exited_terminals_but_not_closed_ones() {
        let mut shared = Shared::default();
        let mut gone_while_away = entry("away", 2, true);
        gone_while_away.exit_code = Some(3);
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 1, false), gone_while_away]),
            vec![tail(1, 0, b"x"), tail(2, 0, b"bye")],
        );
        // Started by this app (no WELCOME entry): still listed, for a webview reload.
        shared.terms.insert("mine".into(), Term::new(7, Some(99), "s7".into()));
        let list = recovered_now(&shared);
        let ids: Vec<&str> = list.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["away", "mine", "t"]);
        let away = list.iter().find(|e| e.id == "away").unwrap();
        assert!(away.exited);
        assert_eq!(away.exit_code, Some(3));
        assert_eq!(away.pid, None, "a reaped pid is never handed out");
        let mine = list.iter().find(|e| e.id == "mine").unwrap();
        assert_eq!((mine.handle, mine.pid, mine.exited), (7, Some(99), false));

        // Exits after the WELCOME → exited; lost by the holder → left out.
        shared.terms.get_mut("t").unwrap().end();
        shared.terms.get_mut("mine").unwrap().lose();
        let list = recovered_now(&shared);
        assert_eq!(list.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["away", "t"]);
        assert!(list.iter().find(|e| e.id == "t").unwrap().exited);
    }

    #[test]
    fn a_gap_past_the_tail_is_marked_truncated() {
        let mut shared = Shared::default();
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 1, false)]),
            vec![tail(1, 0, b"ab")],
        );
        // While detached the program wrote more than the ring holds: the TAIL now
        // starts at seq 100, past the 2 bytes this app has seen.
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 1, false)]),
            vec![tail(1, 100, b"xyz")],
        );
        assert_eq!(drain(&shared, "t"), "\r\n[output truncated]\r\nxyz");
        assert_eq!(shared.terms["t"].next_seq, 103);
    }

    #[test]
    fn utf8_split_between_tail_and_output_is_reassembled() {
        let mut shared = Shared::default();
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("t", 1, false)]),
            vec![tail(1, 0, b"x\xc3")],
        );
        shared.terms.get_mut("t").unwrap().deliver(b"\xa9y");
        assert_eq!(drain(&shared, "t"), "\u{e9}y");
        assert_eq!(shared.terms["t"].buffer, "x\u{e9}y");
    }

    #[test]
    fn terminals_closed_while_disconnected_are_released_on_welcome() {
        let mut shared = Shared::default();
        shared.release_later.insert("gone".into());
        let release = apply_welcome(
            &mut shared,
            &welcome(vec![entry("gone", 4, false), entry("kept", 5, false)]),
            vec![tail(4, 0, b""), tail(5, 0, b"")],
        );
        assert_eq!(release, vec![4]);
        assert!(!shared.terms.contains_key("gone"));
        assert!(shared.terms.contains_key("kept"));
        assert!(shared.release_later.is_empty());
    }

    #[test]
    fn release_later_is_cleared_after_every_welcome() {
        let mut shared = Shared::default();
        // Closed while disconnected, but the holder no longer has it: forget it, so a
        // later terminal under the same id is never released by mistake.
        shared.release_later.insert("old".into());
        let release = apply_welcome(&mut shared, &welcome(vec![]), vec![]);
        assert!(release.is_empty());
        assert!(shared.release_later.is_empty());
        let release = apply_welcome(
            &mut shared,
            &welcome(vec![entry("old", 3, false)]),
            vec![tail(3, 0, b"")],
        );
        assert!(release.is_empty());
        assert!(shared.terms.contains_key("old"));
    }

    #[test]
    fn a_spawn_whose_reply_was_lost_is_resolved_by_welcome() {
        let mut shared = Shared::default();
        shared.pending.insert("new".into(), ("scope".into(), 1));
        shared.pending.insert("never".into(), ("scope".into(), 1));
        super::apply_welcome(
            &mut shared,
            &welcome(vec![entry("new", 8, false)]),
            vec![tail(8, 0, b"hello")],
            2,
        );
        assert_eq!(shared.replies.get("new"), Some(&Ok(())));
        assert!(shared.replies["never"].is_err());
        assert!(shared.pending.is_empty());
        assert_eq!(
            drain(&shared, "new"),
            "hello",
            "a new terminal's output is all new"
        );
        assert!(shared.recovered.is_empty());
    }

    #[test]
    fn exited_and_missing_terminals_read_as_disconnected() {
        let mut shared = Shared::default();
        apply_welcome(
            &mut shared,
            &welcome(vec![entry("done", 1, true), entry("live", 2, false)]),
            vec![tail(1, 0, b"bye"), tail(2, 0, b"")],
        );
        assert!(!shared.terms["done"].alive);
        assert_eq!(shared.terms["done"].pid, None, "a reaped pid may be reused");
        assert_eq!(shared.terms["done"].handle, Some(1), "kept for RELEASE");
        assert_eq!(
            drain_output(&shared.terms["done"].rx),
            Err(PTY_DISCONNECTED.to_string())
        );
        // The holder no longer has "live" (it died with a previous holder).
        apply_welcome(&mut shared, &welcome(vec![]), vec![]);
        assert!(!shared.terms["live"].alive);
        assert_eq!(shared.terms["live"].pid, None);
        assert_eq!(shared.terms["live"].handle, None);
    }
}
