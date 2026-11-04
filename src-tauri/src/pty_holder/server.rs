//! The holder process (docs/PTY_HOLDER_DAEMON.md 3.1-3.3).
//!
//! Dumb on purpose: it starts programs with exactly the argv/cwd/env the app sent,
//! moves bytes both ways, keeps a 1 MiB tail per terminal, kills and reaps. Every
//! terminal has its own pump (reader), writer and reap threads; the pump never
//! blocks on the client, so a program never stalls because the app is gone or slow.
//!
//! One controlling client at a time: a newer HELLO gets the terminals and the older
//! connection gets BYE. A client whose unwritten backlog passes `CLIENT_BACKLOG_MAX`
//! is dropped instead of slowing the pumps; it reconnects and resyncs from TAIL.

use super::proto::{self, Frame, Modes};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// Per-terminal tail ring size.
pub const TAIL_BYTES: usize = 1024 * 1024;
/// After the program exits, wait at most this long for its last output before EXITED.
const EXIT_DRAIN: Duration = Duration::from_millis(200);
const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(60);
/// Overrides the 60 s "no terminals and no client" exit (milliseconds). For tests/debugging.
pub const IDLE_EXIT_ENV: &str = "BBARIT_PTY_HOLDER_IDLE_EXIT_MS";
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// The app PINGs every 10 s; 30 s of silence means the connection is gone.
const CLIENT_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Queued-but-unwritten bytes for one client before it is dropped (it resyncs via TAIL).
const CLIENT_BACKLOG_MAX: usize = 32 * 1024 * 1024;
/// Cap on how long shutdown waits for release sweeps and a running GOODBYE kill_all.
const SWEEP_WAIT: Duration = Duration::from_secs(10);

pub struct Config {
    pub idle_exit: Duration,
    /// Only connections from this uid are served (getpeereid / SO_PEERCRED).
    pub allowed_uid: u32,
    pub instance: String,
    /// Protocol version this holder speaks (HELLO must match; WELCOME reports it).
    pub version: u32,
}

impl Config {
    pub fn new(instance: String) -> Self {
        let idle_exit = idle_exit_from(std::env::var(IDLE_EXIT_ENV).ok().as_deref());
        Config {
            idle_exit,
            allowed_uid: current_uid(),
            instance,
            version: proto::protocol_version(),
        }
    }
}

/// `IDLE_EXIT_ENV` value (ms) → timeout; unset/invalid → 60 s.
pub fn idle_exit_from(value: Option<&str>) -> Duration {
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .map_or(DEFAULT_IDLE_EXIT, Duration::from_millis)
}

pub fn current_uid() -> u32 {
    // SAFETY: geteuid never fails.
    unsafe { libc::geteuid() }
}

/// `--mode pty-holder --socket <path>` entry point. Returns the process exit code.
pub fn main_from_args(args: &[std::ffi::OsString]) -> i32 {
    let Some(socket) = arg_value(args, "--socket") else {
        safe_eprintln!("pty-holder: --socket <path> is required");
        return 2;
    };
    let spawned = SpawnedBy {
        method: arg_value(args, "--spawn-method")
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_else(|| "manual".to_string()),
        job: arg_value(args, "--job").map(|v| v.to_string_lossy().into_owned()),
    };
    match run(&socket, &spawned) {
        Ok(()) => 0,
        Err(e) => {
            safe_eprintln!("pty-holder: {e}");
            1
        }
    }
}

fn arg_value(args: &[std::ffi::OsString], name: &str) -> Option<std::path::PathBuf> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from)
}

/// How the app started this holder (`--spawn-method`, `--job`), recorded in the info file
/// so a later app knows which launchd label / systemd unit to stop.
#[derive(Debug, Clone)]
pub struct SpawnedBy {
    /// "launchd" | "systemd" | "setsid" | "manual" (started by hand / tests).
    pub method: String,
    /// launchd label or systemd unit.
    pub job: Option<String>,
}

/// Bind `socket`, write the info file next to it, serve until the holder decides to
/// exit, then remove both files.
pub fn run(socket: &Path, spawned: &SpawnedBy) -> Result<(), String> {
    // The holder must not carry a tab's scope token: a sweep of that tab would kill it
    // (dev: an app started from inside a BBARIT tab). Single-threaded here.
    std::env::remove_var(crate::SCOPE_ENV);
    // Before the socket exists, so a TERM can never leave the files behind.
    install_stop_handlers()?;
    let instance = instance_from_socket(socket).unwrap_or_else(super::new_instance_id);
    let listener = bind(socket)?;
    let info_path = super::info_path_for(socket);
    write_info(&info_path, socket, &instance, spawned)?;
    safe_eprintln!(
        "[pty-holder] pid {} listening on {} (spawned by {}{})",
        std::process::id(),
        socket.display(),
        spawned.method,
        spawned.job.as_deref().map(|j| format!(" as {j}")).unwrap_or_default()
    );
    let holder = Holder::new(Config::new(instance));
    {
        let holder = Arc::clone(&holder);
        thread::spawn(move || watch_stop_signal(&holder));
    }
    let result = holder.serve(listener).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(socket);
    let _ = std::fs::remove_file(&info_path);
    match holder.shutdown_reason() {
        Some(why) => safe_eprintln!("[pty-holder] exiting: {why}"),
        None => safe_eprintln!("[pty-holder] exiting"),
    }
    result
}

/// SIGTERM/SIGINT that asked the holder to stop (0 = none yet).
static STOP_SIGNAL: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_stop_signal(sig: libc::c_int) {
    // Async-signal-safe: one atomic store; the watcher thread does the rest.
    STOP_SIGNAL.store(sig, Ordering::SeqCst);
}

/// SIGTERM (launchd bootout, systemd stop, `kill`) and SIGINT stop the holder cleanly:
/// it stops accepting and removes its socket and info file. It does not kill or sweep
/// its terminals (that is GOODBYE kill_all); they get SIGHUP from the kernel when the
/// holder's PTY masters close at exit, exactly as on any other holder death.
fn install_stop_handlers() -> Result<(), String> {
    for sig in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: a zeroed sigaction with a plain handler and an empty mask is valid;
        // the handler only stores to an atomic.
        let rc = unsafe {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_stop_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            libc::sigemptyset(&mut sa.sa_mask);
            sa.sa_flags = libc::SA_RESTART;
            libc::sigaction(sig, &sa, std::ptr::null_mut())
        };
        if rc != 0 {
            return Err(format!("sigaction({sig}): {}", io::Error::last_os_error()));
        }
    }
    Ok(())
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGTERM => "SIGTERM".to_string(),
        libc::SIGINT => "SIGINT".to_string(),
        other => format!("signal {other}"),
    }
}

fn watch_stop_signal(holder: &Holder) {
    while !holder.is_shutting_down() {
        let sig = STOP_SIGNAL.load(Ordering::SeqCst);
        if sig != 0 {
            holder.begin_shutdown(&signal_name(sig));
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// `<run>/<prefix>.<instance>.sock` → `<instance>`.
fn instance_from_socket(socket: &Path) -> Option<String> {
    let stem = socket.file_stem()?.to_str()?;
    let instance = stem.rsplit('.').next()?;
    (!instance.is_empty()).then(|| instance.to_string())
}

/// Bind a 0600 socket in a 0700 directory. A live socket at `path` means another
/// holder owns it (error); a dead one is replaced.
pub fn bind(path: &Path) -> Result<UnixListener, String> {
    use std::os::unix::fs::PermissionsExt;
    super::check_socket_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "socket path has no parent".to_string())?;
    // A missing directory is created 0700; an existing one (the run dir the app already
    // made private, or a path given by hand such as /tmp) is never chmod-ed.
    if !parent.exists() {
        super::ensure_private_dir(parent)?;
    }
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(format!("another holder is listening on {}", path.display()));
        }
        let _ = std::fs::remove_file(path);
    }
    let listener = UnixListener::bind(path).map_err(|e| format!("bind {}: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    Ok(listener)
}

fn write_info(
    info_path: &Path,
    socket: &Path,
    instance: &str,
    spawned: &SpawnedBy,
) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let info = proto::HolderInfo {
        pid: std::process::id(),
        socket: socket.to_string_lossy().into_owned(),
        version: proto::protocol_version(),
        build: env!("CARGO_PKG_VERSION").to_string(),
        instance: instance.to_string(),
        spawn_method: Some(spawned.method.clone()),
        label: spawned.job.clone().filter(|_| spawned.method == "launchd"),
        unit: spawned.job.clone().filter(|_| spawned.method == "systemd"),
    };
    let json = serde_json::to_vec_pretty(&info).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(info_path)
        .map_err(|e| format!("write {}: {e}", info_path.display()))?;
    f.write_all(&json).map_err(|e| e.to_string())
}

/// Effective uid of the process on the other end of a unix socket.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let fd = stream.as_raw_fd();
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: cred/len point to a properly sized ucred.
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut _ as *mut libc::c_void,
                &mut len,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(cred.uid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: getpeereid writes two plain integers.
        let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }
}

// ─── Output tracking ───

/// Last `cap` bytes of a terminal's output plus stream offsets.
pub struct TailRing {
    cap: usize,
    bytes: VecDeque<u8>,
    /// Total bytes ever produced (seq of the next byte).
    seq_end: u64,
    /// Bytes evicted from the front so far (== seq of the first kept byte).
    dropped: u64,
}

impl TailRing {
    pub fn new(cap: usize) -> Self {
        TailRing {
            cap,
            bytes: VecDeque::new(),
            seq_end: 0,
            dropped: 0,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        self.seq_end += data.len() as u64;
        if data.len() >= self.cap {
            self.dropped += (self.bytes.len() + data.len() - self.cap) as u64;
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - self.cap..]);
            return;
        }
        self.bytes.extend(data);
        let excess = self.bytes.len().saturating_sub(self.cap);
        if excess > 0 {
            self.bytes.drain(..excess);
            self.dropped += excess as u64;
        }
    }

    pub fn seq_start(&self) -> u64 {
        self.dropped
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    pub fn contents(&self) -> Vec<u8> {
        let (a, b) = self.bytes.as_slices();
        [a, b].concat()
    }
}

/// Private modes that must be re-applied when a TAIL starts after they were set.
const TRACKED_DECSET: [u16; 8] = [47, 1000, 1002, 1003, 1006, 1047, 1049, 2004];
const MAX_CSI_PARAMS: usize = 64;
const MAX_KITTY_STACK: usize = 16;

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum ParseState {
    #[default]
    Ground,
    Esc,
    Csi,
}

/// Streaming scan of output bytes for DECSET/DECRST (`CSI ? Pn h/l`) and kitty keyboard
/// (`CSI > f u` push, `CSI < n u` pop, `CSI = f ; m u` set). Escape sequences may be
/// split across reads. RIS (`ESC c`) clears everything.
#[derive(Default)]
pub struct ModeTracker {
    state: ParseState,
    params: Vec<u8>,
    decset: BTreeSet<u16>,
    kitty: Vec<u32>,
}

impl ModeTracker {
    pub fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match self.state {
                ParseState::Ground => {
                    if b == 0x1b {
                        self.state = ParseState::Esc;
                    }
                }
                ParseState::Esc => {
                    self.state = match b {
                        b'[' => {
                            self.params.clear();
                            ParseState::Csi
                        }
                        b'c' => {
                            self.decset.clear();
                            self.kitty.clear();
                            ParseState::Ground
                        }
                        0x1b => ParseState::Esc,
                        _ => ParseState::Ground,
                    }
                }
                ParseState::Csi => match b {
                    0x20..=0x3f => {
                        if self.params.len() < MAX_CSI_PARAMS {
                            self.params.push(b);
                        } else {
                            self.state = ParseState::Ground;
                        }
                    }
                    0x40..=0x7e => {
                        self.dispatch(b);
                        self.state = ParseState::Ground;
                    }
                    0x1b => self.state = ParseState::Esc,
                    0x18 | 0x1a => self.state = ParseState::Ground,
                    _ => {} // C0 controls inside a CSI are executed, not part of it
                },
            }
        }
    }

    fn dispatch(&mut self, final_byte: u8) {
        let (prefix, rest) = match self.params.first() {
            Some(&p @ (b'?' | b'>' | b'<' | b'=')) => (Some(p), &self.params[1..]),
            _ => (None, &self.params[..]),
        };
        let nums: Vec<Option<u32>> = std::str::from_utf8(rest)
            .unwrap_or("")
            .split(';')
            .map(|s| {
                if s.is_empty() {
                    None
                } else {
                    s.parse::<u32>().ok()
                }
            })
            .collect();
        match (prefix, final_byte) {
            (Some(b'?'), b'h' | b'l') => {
                for n in nums.into_iter().flatten() {
                    let Ok(n) = u16::try_from(n) else { continue };
                    if TRACKED_DECSET.contains(&n) {
                        if final_byte == b'h' {
                            self.decset.insert(n);
                        } else {
                            self.decset.remove(&n);
                        }
                    }
                }
            }
            (Some(b'>'), b'u') => {
                let flags = nums.first().copied().flatten().unwrap_or(0);
                if self.kitty.len() >= MAX_KITTY_STACK {
                    self.kitty.remove(0);
                }
                self.kitty.push(flags);
            }
            (Some(b'<'), b'u') => {
                let n = nums.first().copied().flatten().unwrap_or(1).max(1) as usize;
                let keep = self.kitty.len().saturating_sub(n);
                self.kitty.truncate(keep);
            }
            (Some(b'='), b'u') => {
                let flags = nums.first().copied().flatten().unwrap_or(0);
                let mode = nums.get(1).copied().flatten().unwrap_or(1);
                if self.kitty.is_empty() {
                    self.kitty.push(0);
                }
                let cur = self.kitty.last_mut().expect("just ensured");
                match mode {
                    1 => *cur = flags,
                    2 => *cur |= flags,
                    3 => *cur &= !flags,
                    _ => {}
                }
            }
            _ => {}
        }
    }

    pub fn snapshot(&self) -> Modes {
        Modes {
            decset: self.decset.iter().copied().collect(),
            kitty_keyboard: self.kitty.last().copied().unwrap_or(0),
        }
    }
}

// ─── Holder state ───

enum Out {
    Frame(Vec<u8>),
    /// Flush what's queued, then shut the connection down.
    Close,
}

struct ClientLink {
    generation: u64,
    out: mpsc::Sender<Out>,
    backlog: Arc<AtomicUsize>,
    /// Shut down directly when the client must go now: its writer may be stuck in write_all.
    stream: UnixStream,
}

struct Term {
    id: String,
    cwd: Option<String>,
    pid: Option<u32>,
    rows: u16,
    cols: u16,
    scope: String,
    started_at: u64,
    input: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    ring: TailRing,
    modes: ModeTracker,
    /// wait() returned: the pid may be reused, never signal it again.
    reaped: bool,
    exit: Option<proto::Exited>,
    reader_done: bool,
}

impl Term {
    fn entry(&self, handle: u32) -> proto::TerminalEntry {
        proto::TerminalEntry {
            handle,
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            pid: self.pid,
            rows: self.rows,
            cols: self.cols,
            exited: self.exit.is_some(),
            exit_code: self.exit.as_ref().and_then(|e| e.code),
            scope: self.scope.clone(),
            started_at: self.started_at,
            dropped_bytes: self.ring.dropped(),
            modes: self.modes.snapshot(),
        }
    }
}

struct State {
    terms: HashMap<u32, Term>,
    next_handle: u32,
    client: Option<ClientLink>,
    generation: u64,
    /// Since when there has been no client and no live terminal (for the idle exit).
    idle_since: Instant,
    /// Open connections, HELLO'd or not: an app between its probe and HELLO counts.
    conns: usize,
    draining: bool,
}

pub struct Holder {
    st: Mutex<State>,
    /// One command at a time across connections (see serve_client).
    dispatching: Mutex<()>,
    changed: Condvar,
    cfg: Config,
    shutdown: AtomicBool,
    /// Why the holder is shutting down (logged as "exiting: <why>").
    shutdown_reason: Mutex<Option<String>>,
    /// Release sweeps and GOODBYE kill_all in progress: serve() waits for them before the
    /// process ends, so a SIGTERM during kill_all (macOS logout: the app's kill_all and
    /// launchd's TERM overlap) never cuts the kill short.
    sweeps: Sweeps,
}

/// Count of kill/sweep work still running, with a wakeup when it reaches zero.
#[derive(Default)]
struct Sweeps {
    running: Mutex<usize>,
    done: Condvar,
}

/// Decrements the count when the kill/sweep work it was created for ends (or panics).
struct SweepTurn<'a>(&'a Sweeps);

impl Sweeps {
    fn begin(&self) -> SweepTurn<'_> {
        *self.running.lock().unwrap_or_else(|p| p.into_inner()) += 1;
        SweepTurn(self)
    }

    /// For work that ends on another thread: call `end` there.
    fn begin_detached(&self) {
        std::mem::forget(self.begin());
    }

    fn end(&self) {
        let mut n = self.running.lock().unwrap_or_else(|p| p.into_inner());
        *n = n.saturating_sub(1);
        if *n == 0 {
            self.done.notify_all();
        }
    }

    /// Wait until nothing runs, at most `cap`. True when it drained in time.
    fn wait_idle(&self, cap: Duration) -> bool {
        let deadline = Instant::now() + cap;
        let mut n = self.running.lock().unwrap_or_else(|p| p.into_inner());
        while *n > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            n = self.done.wait_timeout(n, left).unwrap_or_else(|p| p.into_inner()).0;
        }
        true
    }

    #[cfg(test)]
    fn running(&self) -> usize {
        *self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

impl Drop for SweepTurn<'_> {
    fn drop(&mut self) {
        self.0.end();
    }
}

impl Holder {
    pub fn new(cfg: Config) -> Arc<Self> {
        Arc::new(Holder {
            dispatching: Mutex::new(()),
            st: Mutex::new(State {
                terms: HashMap::new(),
                next_handle: 1,
                client: None,
                generation: 0,
                idle_since: Instant::now(),
                conns: 0,
                draining: false,
            }),
            changed: Condvar::new(),
            cfg,
            shutdown: AtomicBool::new(false),
            shutdown_reason: Mutex::new(None),
            sweeps: Sweeps::default(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    fn begin_shutdown(&self, why: &str) {
        if !self.shutdown.swap(true, Ordering::SeqCst) {
            *self.shutdown_reason.lock().unwrap_or_else(|p| p.into_inner()) = Some(why.to_string());
            safe_eprintln!("[pty-holder] shutting down: {why}");
        }
    }

    pub fn shutdown_reason(&self) -> Option<String> {
        self.shutdown_reason.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Accept connections until shutdown. Blocks the calling thread.
    pub fn serve(self: &Arc<Self>, listener: UnixListener) -> io::Result<()> {
        listener.set_nonblocking(true)?;
        let supervisor = Arc::clone(self);
        thread::spawn(move || supervisor.supervise());
        while !self.is_shutting_down() {
            match listener.accept() {
                Ok((stream, _)) => {
                    let holder = Arc::clone(self);
                    thread::spawn(move || holder.handle_conn(stream));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    safe_eprintln!("[pty-holder] accept: {e}");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
        // Release sweeps run on their own threads, and a GOODBYE kill_all may still be running
        // on its client thread (a SIGTERM arrived meanwhile): let them finish before the
        // process ends, or HUP-ignoring children of those terminals survive.
        self.wait_for_sweeps();
        let mut st = self.lock();
        if let Some(c) = st.client.take() {
            let _ = c.out.send(Out::Close);
        }
        Ok(())
    }

    fn wait_for_sweeps(&self) {
        if !self.sweeps.wait_idle(SWEEP_WAIT) {
            safe_eprintln!("[pty-holder] kill/sweep still running after {SWEEP_WAIT:?}; exiting anyway");
        }
    }

    /// Exit after `idle_exit` with no client and no live terminal.
    fn supervise(&self) {
        let tick =
            (self.cfg.idle_exit / 4).clamp(Duration::from_millis(10), Duration::from_millis(500));
        while !self.is_shutting_down() {
            thread::sleep(tick);
            let st = self.lock();
            let live = st.terms.values().any(|t| !t.reaped);
            if !live
                && st.client.is_none()
                && st.conns == 0
                && st.idle_since.elapsed() >= self.cfg.idle_exit
            {
                drop(st);
                self.begin_shutdown("idle: no terminals and no client");
            }
        }
    }

    // ─── connection ───

    fn handle_conn(self: &Arc<Self>, stream: UnixStream) {
        self.lock().conns += 1;
        self.serve_conn(stream);
        let mut st = self.lock();
        st.conns -= 1;
        st.idle_since = Instant::now();
    }

    fn serve_conn(self: &Arc<Self>, stream: UnixStream) {
        let _ = stream.set_nonblocking(false);
        match peer_uid(&stream) {
            Ok(uid) if uid == self.cfg.allowed_uid => {}
            Ok(uid) => {
                safe_eprintln!("[pty-holder] rejected connection from uid {uid}");
                return;
            }
            Err(e) => {
                safe_eprintln!("[pty-holder] peer credentials unavailable: {e}");
                return;
            }
        }
        if let Err(e) = self.serve_client(stream) {
            if e.kind() != io::ErrorKind::UnexpectedEof {
                safe_eprintln!("[pty-holder] client: {e}");
            }
        }
    }

    fn serve_client(self: &Arc<Self>, mut stream: UnixStream) -> io::Result<()> {
        stream
            .set_read_timeout(Some(HELLO_TIMEOUT))
            .map_err(quiet_before_hello)?;
        let first = proto::read_frame(&mut stream).map_err(quiet_before_hello)?;
        if first.kind != proto::HELLO {
            let _ = send_bye(&mut stream, "expected HELLO");
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "first frame was not HELLO",
            ));
        }
        let hello: proto::Hello = proto::parse(&first)?;
        if let Err(why) = hello.check(self.cfg.version) {
            let _ = send_bye(&mut stream, &why);
            return Err(io::Error::new(io::ErrorKind::InvalidData, why));
        }
        stream.set_read_timeout(Some(CLIENT_READ_TIMEOUT))?;

        let writer = stream.try_clone()?;
        let (tx, rx) = mpsc::channel::<Out>();
        let backlog = Arc::new(AtomicUsize::new(0));
        let writer_backlog = Arc::clone(&backlog);
        thread::spawn(move || client_writer(writer, rx, writer_backlog));

        let generation = {
            let _turn = self.dispatching.lock().unwrap_or_else(|p| p.into_inner());
            let mut st = self.lock();
            if let Some(old) = st.client.take() {
                if let Ok(bye) = proto::encode_json(
                    proto::BYE,
                    0,
                    &proto::Bye {
                        reason: "replaced".into(),
                    },
                ) {
                    let _ = old.out.send(Out::Frame(bye));
                }
                let _ = old.out.send(Out::Close);
            }
            st.generation += 1;
            let generation = st.generation;
            // WELCOME and every TAIL are queued under the lock, so no OUTPUT can slip in
            // between: each byte reaches this client once, either in TAIL or in OUTPUT.
            let mut handles: Vec<u32> = st.terms.keys().copied().collect();
            handles.sort_unstable();
            let welcome = proto::Welcome {
                version: self.cfg.version,
                instance: self.cfg.instance.clone(),
                terminals: handles.iter().map(|h| st.terms[h].entry(*h)).collect(),
            };
            let mut frames = vec![proto::encode_json(proto::WELCOME, 0, &welcome)?];
            for h in &handles {
                let t = &st.terms[h];
                let header = proto::TailHeader {
                    seq_start: t.ring.seq_start(),
                    dropped_bytes: t.ring.dropped(),
                };
                frames.push(proto::encode_tail(*h, header, &t.ring.contents())?);
            }
            for f in frames {
                backlog.fetch_add(f.len(), Ordering::SeqCst);
                let _ = tx.send(Out::Frame(f));
            }
            st.client = Some(ClientLink {
                generation,
                out: tx,
                backlog,
                stream: stream.try_clone()?,
            });
            generation
        };
        safe_eprintln!(
            "[pty-holder] client attached (pid {}, build {})",
            hello.pid,
            hello.build
        );

        let result = loop {
            let frame = match proto::read_frame(&mut stream) {
                Ok(f) => f,
                Err(e) => break Err(e),
            };
            // Checked and dispatched under `dispatching`, which a takeover HELLO also takes:
            // a replaced client's frames are never acted on.
            let _turn = self.dispatching.lock().unwrap_or_else(|p| p.into_inner());
            if !self.is_current(generation) {
                break Ok(());
            }
            match self.dispatch(frame) {
                Ok(true) => {}
                Ok(false) => break Ok(()),
                Err(e) => break Err(e),
            }
        };

        let mut st = self.lock();
        if st
            .client
            .as_ref()
            .is_some_and(|c| c.generation == generation)
        {
            if let Some(c) = st.client.take() {
                let _ = c.out.send(Out::Close);
            }
            st.idle_since = Instant::now();
        }
        result
    }

    /// Test hook: end every terminal (e.g. ones a failed test left behind) and stop.
    #[cfg(test)]
    pub fn kill_all_for_test(&self) {
        self.kill_all();
        self.begin_shutdown("test cleanup");
    }

    /// Test hook: what the SIGTERM watcher does.
    #[cfg(test)]
    pub fn stop_for_test(&self, why: &str) {
        self.begin_shutdown(why);
    }

    /// Test hook: DRAIN received.
    #[cfg(test)]
    pub fn is_draining(&self) -> bool {
        self.lock().draining
    }

    /// Test hook: terminals the holder still has (released ones are gone).
    #[cfg(test)]
    pub fn terminal_count(&self) -> usize {
        self.lock().terms.len()
    }

    /// Test hook: release sweeps / kill_all still running.
    #[cfg(test)]
    pub fn sweeps_running(&self) -> usize {
        self.sweeps.running()
    }

    /// Test hook: drop the controlling client without BYE, as a broken socket would.
    #[cfg(test)]
    pub fn kick_client(&self) {
        let mut st = self.lock();
        if let Some(c) = st.client.take() {
            let _ = c.out.send(Out::Close);
        }
        st.idle_since = Instant::now();
    }

    fn is_current(&self, generation: u64) -> bool {
        self.lock()
            .client
            .as_ref()
            .is_some_and(|c| c.generation == generation)
    }

    /// Queue a frame for the controlling client, if any. Drops a client that fell too far behind.
    fn send_to_client(&self, st: &mut State, frame: Vec<u8>) {
        let Some(c) = st.client.as_ref() else { return };
        let queued = c.backlog.fetch_add(frame.len(), Ordering::SeqCst) + frame.len();
        if queued > CLIENT_BACKLOG_MAX {
            safe_eprintln!("[pty-holder] client fell {queued} bytes behind; dropping it");
            if let Some(c) = st.client.take() {
                let _ = c.stream.shutdown(std::net::Shutdown::Both);
                let _ = c.out.send(Out::Close);
            }
            st.idle_since = Instant::now();
            return;
        }
        if c.out.send(Out::Frame(frame)).is_err() {
            st.client = None;
            st.idle_since = Instant::now();
        }
    }

    fn reply(&self, frame: io::Result<Vec<u8>>) {
        if let Ok(frame) = frame {
            let mut st = self.lock();
            self.send_to_client(&mut st, frame);
        }
    }

    /// Ok(false) ends the connection gracefully.
    fn dispatch(self: &Arc<Self>, frame: Frame) -> io::Result<bool> {
        match frame.kind {
            proto::SPAWN => {
                let spec: proto::Spawn = proto::parse(&frame)?;
                self.spawn(spec);
            }
            proto::INPUT => {
                let st = self.lock();
                if let Some(t) = st.terms.get(&frame.handle) {
                    let _ = t.input.send(frame.payload);
                }
            }
            proto::RESIZE => {
                let size: proto::Resize = proto::parse(&frame)?;
                let mut st = self.lock();
                if let Some(t) = st.terms.get_mut(&frame.handle) {
                    let _ = t.master.resize(PtySize {
                        rows: size.rows,
                        cols: size.cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                    t.rows = size.rows;
                    t.cols = size.cols;
                }
            }
            proto::SIGNAL => {
                let sig: proto::Signal = proto::parse(&frame)?;
                let signo = match sig.sig.as_str() {
                    "TERM" => libc::SIGTERM,
                    "KILL" => libc::SIGKILL,
                    "HUP" => libc::SIGHUP,
                    "INT" => libc::SIGINT,
                    _ => return Ok(true),
                };
                let st = self.lock();
                if let Some(pid) = st
                    .terms
                    .get(&frame.handle)
                    .filter(|t| !t.reaped)
                    .and_then(|t| t.pid)
                {
                    // SAFETY: plain kill(2); the reaped guard keeps us off recycled pids.
                    unsafe {
                        libc::kill(pid as libc::pid_t, signo);
                    }
                }
            }
            proto::RELEASE => self.release(frame.handle),
            proto::GOODBYE => {
                let bye: proto::Goodbye = proto::parse(&frame)?;
                if bye.reason == "kill_all" {
                    self.kill_all();
                    self.begin_shutdown("GOODBYE kill_all");
                }
                return Ok(false);
            }
            proto::DRAIN => {
                let mut st = self.lock();
                if !st.draining {
                    safe_eprintln!("[pty-holder] draining: {} terminal(s) left", st.terms.len());
                }
                st.draining = true;
                if let Ok(f) = proto::encode_json(
                    proto::ACK,
                    0,
                    &proto::Ack {
                        of: "DRAIN".into(),
                        terminals: st.terms.len(),
                    },
                ) {
                    self.send_to_client(&mut st, f);
                }
                self.exit_if_drained(&st);
            }
            proto::PING => self.reply(proto::encode(proto::PONG, 0, &frame.payload)),
            _ => {}
        }
        Ok(true)
    }

    // ─── terminals ───

    fn spawn(self: &Arc<Self>, spec: proto::Spawn) {
        let fail = |error: String| {
            proto::encode_json(
                proto::SPAWN_FAILED,
                0,
                &proto::SpawnFailed {
                    id: spec.id.clone(),
                    error,
                },
            )
        };
        {
            let st = self.lock();
            let refusal = if st.draining {
                Some("holder is draining".to_string())
            } else if st.terms.values().any(|t| t.id == spec.id) {
                Some(format!("terminal id {:?} already exists", spec.id))
            } else {
                None
            };
            if let Some(why) = refusal {
                drop(st);
                return self.reply(fail(why));
            }
        }
        let started = match start_pty(&spec) {
            Ok(s) => s,
            Err(e) => {
                safe_eprintln!("[pty-holder] spawn failed: {e}");
                return self.reply(fail(e));
            }
        };
        let StartedPty {
            reader,
            mut writer,
            master,
            child,
        } = started;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let (input, queued) = mpsc::channel::<Vec<u8>>();
        // A program that stops reading stdin only blocks its own writer thread.
        thread::spawn(move || {
            for bytes in queued {
                if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });
        let handle = {
            let mut st = self.lock();
            // Never 0, never a handle still in use (after a u32 wrap).
            let mut handle = st.next_handle;
            while handle == 0 || st.terms.contains_key(&handle) {
                handle = handle.wrapping_add(1);
            }
            st.next_handle = handle.wrapping_add(1);
            st.terms.insert(
                handle,
                Term {
                    id: spec.id.clone(),
                    cwd: spec.cwd.clone(),
                    pid,
                    rows: spec.rows,
                    cols: spec.cols,
                    scope: spec.scope.clone(),
                    started_at: super::now_ms(),
                    input,
                    master,
                    killer,
                    ring: TailRing::new(TAIL_BYTES),
                    modes: ModeTracker::default(),
                    reaped: false,
                    exit: None,
                    reader_done: false,
                },
            );
            // SPAWNED is queued before the pump starts, so it precedes any OUTPUT.
            if let Ok(f) = proto::encode_json(
                proto::SPAWNED,
                handle,
                &proto::Spawned {
                    id: spec.id.clone(),
                    handle,
                    pid,
                },
            ) {
                self.send_to_client(&mut st, f);
            }
            handle
        };
        let pump = Arc::clone(self);
        thread::spawn(move || pump.pump(handle, reader));
        let reap = Arc::clone(self);
        thread::spawn(move || reap.reap(handle, child));
    }

    /// Always reads, client or not, so programs never stall on a full PTY.
    fn pump(&self, handle: u32, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break, // EIO: every slave side closed
            };
            let mut st = self.lock();
            let Some(t) = st.terms.get_mut(&handle) else {
                return;
            };
            t.ring.push(&buf[..n]);
            t.modes.feed(&buf[..n]);
            if let Ok(f) = proto::encode(proto::OUTPUT, handle, &buf[..n]) {
                self.send_to_client(&mut st, f);
            }
        }
        if let Some(t) = self.lock().terms.get_mut(&handle) {
            t.reader_done = true;
        }
        self.changed.notify_all();
    }

    /// Reports EXITED after the remaining output (up to EXIT_DRAIN).
    fn reap(&self, handle: u32, mut child: Box<dyn portable_pty::Child + Send + Sync>) {
        let exit = match child.wait() {
            Ok(status) => proto::Exited {
                code: Some(status.exit_code()),
                signal: (!status.success() && status.to_string().starts_with("Terminated by"))
                    .then(|| {
                        status
                            .to_string()
                            .trim_start_matches("Terminated by ")
                            .to_string()
                    }),
            },
            Err(_) => proto::Exited {
                code: None,
                signal: None,
            },
        };
        let exited_at = Instant::now();
        let mut st = self.lock();
        if let Some(t) = st.terms.get_mut(&handle) {
            t.reaped = true;
        }
        while st.terms.get(&handle).is_some_and(|t| !t.reader_done) {
            let left = (exited_at + EXIT_DRAIN).saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = self
                .changed
                .wait_timeout(st, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        if let Some(t) = st.terms.get_mut(&handle) {
            t.exit = Some(exit.clone());
            if let Ok(f) = proto::encode_json(proto::EXITED, handle, &exit) {
                self.send_to_client(&mut st, f);
            }
        }
        if !st.terms.values().any(|t| !t.reaped) {
            st.idle_since = Instant::now();
        }
        self.exit_if_drained(&st);
    }

    /// Forget a terminal; kill its tree and sweep its scope in the background.
    fn release(self: &Arc<Self>, handle: u32) {
        // Counted before the terminal leaves the map: serve() waits for this counter, and
        // removing the last terminal may start a DRAIN shutdown.
        self.sweeps.begin_detached();
        let term = {
            let mut st = self.lock();
            let term = st.terms.remove(&handle);
            if !st.terms.values().any(|t| !t.reaped) {
                st.idle_since = Instant::now();
            }
            self.exit_if_drained(&st);
            term
        };
        let Some(term) = term else {
            self.sweeps.end();
            return;
        };
        let holder = Arc::clone(self);
        thread::spawn(move || {
            kill_term(term, true);
            holder.sweeps.end();
        });
    }

    /// GOODBYE kill_all: release everything, one combined scope sweep, then return.
    /// Counted in `sweeps` for its whole run, so a shutdown that starts meanwhile
    /// (SIGTERM) waits for it instead of ending the process mid-kill.
    fn kill_all(&self) {
        let _turn = self.sweeps.begin();
        let terms: Vec<Term> = {
            let mut st = self.lock();
            st.idle_since = Instant::now();
            st.terms.drain().map(|(_, t)| t).collect()
        };
        let scopes: Vec<String> = terms.iter().map(|t| t.scope.clone()).collect();
        let workers: Vec<_> = terms
            .into_iter()
            .map(|t| thread::spawn(move || kill_term(t, false)))
            .collect();
        for w in workers {
            let _ = w.join();
        }
        let refs: Vec<&str> = scopes.iter().map(String::as_str).collect();
        crate::sweep_scopes(&refs, &[]);
    }

    /// A draining holder ends once its last terminal is released. Not when they have
    /// merely exited: the app that drains it still replays their tails and the
    /// "exited (code N)" banner, then RELEASEs. (Exited ones nobody releases go with
    /// the ordinary idle exit: no live terminal and no client.)
    fn exit_if_drained(&self, st: &State) {
        if st.draining && st.terms.is_empty() {
            self.begin_shutdown("drained");
        }
    }
}

fn kill_term(mut term: Term, sweep: bool) {
    // A reaped pid may already belong to another process: never signal it again.
    if !term.reaped {
        if let Some(pid) = term.pid {
            crate::kill_process_tree(pid);
        }
        let _ = term.killer.kill();
    }
    if sweep {
        crate::sweep_scope(&term.scope, &[]);
    }
}

fn send_bye(stream: &mut UnixStream, reason: &str) -> io::Result<()> {
    let f = proto::encode_json(
        proto::BYE,
        0,
        &proto::Bye {
            reason: reason.to_string(),
        },
    )?;
    stream.write_all(&f)
}

fn client_writer(mut stream: UnixStream, rx: mpsc::Receiver<Out>, backlog: Arc<AtomicUsize>) {
    for msg in rx {
        match msg {
            Out::Frame(bytes) => {
                let len = bytes.len();
                let ok = stream.write_all(&bytes).is_ok();
                backlog.fetch_sub(len, Ordering::SeqCst);
                if !ok {
                    break;
                }
            }
            Out::Close => break,
        }
    }
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

struct StartedPty {
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// A liveness probe (`UnixStream::connect` in the app) hangs up before HELLO; macOS then
/// fails setsockopt with EINVAL. Report such hang-ups as EOF so they are not logged.
fn quiet_before_hello(e: io::Error) -> io::Error {
    match e.raw_os_error() {
        Some(code) if code == libc::EINVAL || code == libc::ENOTCONN || code == libc::ECONNRESET => {
            io::Error::new(io::ErrorKind::UnexpectedEof, e)
        }
        _ => e,
    }
}

#[cfg(test)]
mod hello_tests {
    use super::*;

    #[test]
    fn a_probe_hang_up_before_hello_is_not_an_error_worth_logging() {
        for code in [libc::EINVAL, libc::ENOTCONN, libc::ECONNRESET] {
            let e = quiet_before_hello(io::Error::from_raw_os_error(code));
            assert_eq!(e.kind(), io::ErrorKind::UnexpectedEof, "{code}");
        }
        let other = quiet_before_hello(io::Error::new(io::ErrorKind::InvalidData, "bad"));
        assert_eq!(other.kind(), io::ErrorKind::InvalidData);
    }
}

/// Exactly the argv/cwd/env the app sent: the holder's own environment never leaks in.
fn start_pty(spec: &proto::Spawn) -> Result<StartedPty, String> {
    if spec.argv.is_empty() {
        return Err("empty argv".to_string());
    }
    let mut cmd =
        CommandBuilder::from_argv(spec.argv.iter().map(std::ffi::OsString::from).collect());
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave fd is dropped here so the pump sees EOF once the program's side closes.
    drop(pair.slave);
    Ok(StartedPty {
        reader,
        writer,
        master: pair.master,
        child,
    })
}
