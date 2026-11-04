//! Holder server + HolderBackend against an in-thread holder on a temp socket
//! (docs/PTY_HOLDER_DAEMON.md 5).

use super::client::HolderBackend;
use super::multi::HolderSet;
use super::proto::{self, Frame};
use super::server::{self, Config, Holder, ModeTracker, TailRing, TAIL_BYTES};
use crate::pty_backend::{PtyBackend, SpawnRequest};
use portable_pty::CommandBuilder;
use std::collections::BTreeMap;
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const SLEEPER_PIDFILE_ENV: &str = "BBARIT_HOLDER_TEST_SLEEPER_PIDFILE";

/// Victim for the scope test: when started with the pidfile env it leaves its session
/// (so neither the process tree nor the process group reaches it), records its pid and
/// idles. Without the env (normal test runs) it is a no-op.
#[test]
fn scope_sleeper() {
    if let Some(pidfile) = std::env::var_os(SLEEPER_PIDFILE_ENV) {
        // SAFETY: setsid in a fresh single-purpose process.
        unsafe {
            libc::setsid();
        }
        std::fs::write(pidfile, std::process::id().to_string()).unwrap();
        thread::sleep(Duration::from_secs(30));
    }
}

const RUN_HOLDER_SOCKET_ENV: &str = "BBARIT_HOLDER_TEST_RUN_SOCKET";

/// A real holder process for the signal test: when started with the socket env this test
/// binary becomes `--mode pty-holder --socket <env>` and exits. Otherwise a no-op.
#[test]
fn holder_process_main() {
    if let Some(socket) = std::env::var_os(RUN_HOLDER_SOCKET_ENV) {
        let args: Vec<std::ffi::OsString> = vec![
            "holder".into(),
            "--mode".into(),
            "pty-holder".into(),
            "--socket".into(),
            socket,
            "--spawn-method".into(),
            "manual".into(),
        ];
        std::process::exit(server::main_from_args(&args));
    }
}

struct TestHolder {
    holder: Arc<Holder>,
    socket: PathBuf,
    dir: PathBuf,
    serving: Option<JoinHandle<()>>,
}

impl TestHolder {
    fn start(idle_exit: Duration, allowed_uid: u32) -> Self {
        Self::start_version(idle_exit, allowed_uid, proto::PROTOCOL_VERSION)
    }

    fn start_version(idle_exit: Duration, allowed_uid: u32, version: u32) -> Self {
        // /tmp keeps sun_path short (the macOS per-user temp dir is long).
        let dir = PathBuf::from(format!("/tmp/bbh-{}", super::new_instance_id()));
        let socket = dir.join("h.sock");
        let listener = server::bind(&socket).expect("bind");
        let holder = Holder::new(Config {
            idle_exit,
            allowed_uid,
            instance: format!("test-v{version}"),
            version,
        });
        let serving = {
            let holder = Arc::clone(&holder);
            thread::spawn(move || holder.serve(listener).expect("serve"))
        };
        TestHolder {
            holder,
            socket,
            dir,
            serving: Some(serving),
        }
    }

    fn default() -> Self {
        Self::start(Duration::from_secs(60), server::current_uid())
    }

    /// Wait for serve() to return (idle exit / kill_all).
    fn wait_stopped(&mut self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if self.serving.as_ref().is_some_and(|h| h.is_finished()) {
                let _ = self.serving.take().unwrap().join();
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

impl Drop for TestHolder {
    fn drop(&mut self) {
        // A failed test must not leave `sleep 30` shells behind.
        if self.serving.as_ref().is_some_and(|h| !h.is_finished()) {
            self.holder.kill_all_for_test();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

type Tails = Vec<(u32, proto::TailHeader, Vec<u8>)>;

/// A bare protocol client.
struct Raw {
    stream: UnixStream,
}

impl Raw {
    fn connect(socket: &Path) -> (Raw, proto::Welcome, Tails) {
        let mut raw = Raw::hello(socket, &proto::Hello::current());
        let welcome_frame = raw.next();
        assert_eq!(welcome_frame.kind, proto::WELCOME);
        let welcome: proto::Welcome = proto::parse(&welcome_frame).unwrap();
        let tails = welcome
            .terminals
            .iter()
            .map(|_| {
                let f = raw.next();
                assert_eq!(f.kind, proto::TAIL);
                let (h, bytes) = proto::decode_tail(&f.payload).unwrap();
                (f.handle, h, bytes.to_vec())
            })
            .collect();
        (raw, welcome, tails)
    }

    fn hello(socket: &Path, hello: &proto::Hello) -> Raw {
        let mut stream = UnixStream::connect(socket).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        proto::write_frame(
            &mut stream,
            proto::HELLO,
            0,
            &serde_json::to_vec(hello).unwrap(),
        )
        .unwrap();
        Raw { stream }
    }

    fn next(&mut self) -> Frame {
        proto::read_frame(&mut self.stream).expect("frame")
    }

    fn send(&mut self, kind: u8, handle: u32, payload: &[u8]) {
        proto::write_frame(&mut self.stream, kind, handle, payload).unwrap();
    }

    fn send_json<T: serde::Serialize>(&mut self, kind: u8, handle: u32, v: &T) {
        self.stream
            .write_all(&proto::encode_json(kind, handle, v).unwrap())
            .unwrap();
    }

    /// Read until OUTPUT for `handle` contains `needle`; returns all output seen.
    fn output_until(&mut self, handle: u32, needle: &str) -> String {
        let mut out = String::new();
        while !out.contains(needle) {
            let f = self.next();
            if f.kind == proto::OUTPUT && f.handle == handle {
                out.push_str(&String::from_utf8_lossy(&f.payload));
            }
        }
        out
    }

    fn spawn(
        &mut self,
        id: &str,
        script: &str,
        extra_env: &[(&str, &str)],
        scope: &str,
    ) -> (u32, u32) {
        let mut env: BTreeMap<String, String> = [
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/tmp"),
            ("BBARIT_TERM_SCOPE", scope),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in extra_env {
            env.insert(k.to_string(), v.to_string());
        }
        self.send_json(
            proto::SPAWN,
            0,
            &proto::Spawn {
                id: id.into(),
                argv: vec!["/bin/sh".into(), "-c".into(), script.into()],
                cwd: Some("/tmp".into()),
                env,
                rows: 24,
                cols: 80,
                scope: scope.into(),
            },
        );
        loop {
            let f = self.next();
            match f.kind {
                proto::SPAWNED => {
                    let s: proto::Spawned = proto::parse(&f).unwrap();
                    assert_eq!(s.id, id);
                    return (s.handle, s.pid.expect("pid"));
                }
                proto::SPAWN_FAILED => panic!("{:?}", proto::parse::<proto::SpawnFailed>(&f)),
                _ => {}
            }
        }
    }
}

fn alive(pid: u32) -> bool {
    super::pid_alive(pid)
}

/// Alive and not a zombie (a killed child stays a zombie until its reap thread runs).
fn running(pid: u32) -> bool {
    if !alive(pid) {
        return false;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim_start().starts_with('Z')
}

fn wait_gone(pid: u32, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "{what} ({pid}) survived");
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(s) = std::fs::read_to_string(path) {
            if !s.is_empty() {
                return s;
            }
        }
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn spawn_output_reattach_tail_input_release_sweeps_scope() {
    let th = TestHolder::default();
    let (mut a, welcome, _) = Raw::connect(&th.socket);
    assert_eq!(welcome.version, proto::PROTOCOL_VERSION);
    assert!(welcome.terminals.is_empty());

    let token = crate::new_scope_token();
    let pidfile = th.dir.join("sleeper.pid");
    let exe = std::env::current_exe().unwrap();
    // The sleeper is double-forked and leaves the session: only the scope sweep reaches it.
    let script = "echo hi; ( \"$TEST_EXE\" --exact pty_holder::integration_tests::scope_sleeper \
                  --test-threads=1 >/dev/null 2>&1 & ); read line; echo \"got:$line\"; sleep 30";
    let exe_s = exe.to_string_lossy().into_owned();
    let pidfile_s = pidfile.to_string_lossy().into_owned();
    let (handle, sh_pid) = a.spawn(
        "t1",
        script,
        &[
            ("TEST_EXE", exe_s.as_str()),
            (SLEEPER_PIDFILE_ENV, pidfile_s.as_str()),
        ],
        &token,
    );
    a.output_until(handle, "hi");
    let sleeper: u32 = wait_for_file(&pidfile).trim().parse().unwrap();
    assert!(alive(sleeper) && alive(sh_pid));

    // The app goes away; the program keeps running.
    drop(a);
    thread::sleep(Duration::from_millis(200));
    assert!(alive(sh_pid), "terminal died with its client");

    // Reattach: WELCOME lists it, TAIL replays it from seq 0.
    let (mut b, welcome, tails) = Raw::connect(&th.socket);
    assert_eq!(welcome.terminals.len(), 1);
    let t = &welcome.terminals[0];
    assert_eq!(
        (t.id.as_str(), t.handle, t.pid),
        ("t1", handle, Some(sh_pid))
    );
    assert_eq!(
        (t.rows, t.cols, t.exited, t.dropped_bytes),
        (24, 80, false, 0)
    );
    assert_eq!(t.scope, token);
    assert_eq!(t.cwd.as_deref(), Some("/tmp"));
    assert_eq!(tails.len(), 1);
    let (tail_handle, header, bytes) = &tails[0];
    assert_eq!(*tail_handle, handle);
    assert_eq!(header.seq_start, 0);
    assert!(String::from_utf8_lossy(bytes).contains("hi"), "{bytes:?}");

    // Input still reaches the program.
    b.send(proto::INPUT, handle, b"ping\n");
    b.output_until(handle, "got:ping");
    b.send_json(
        proto::RESIZE,
        handle,
        &proto::Resize {
            rows: 30,
            cols: 100,
        },
    );

    // RELEASE: the shell tree and the escaped, scope-carrying sleeper are both gone.
    b.send(proto::RELEASE, handle, &[]);
    wait_gone(sh_pid, "shell");
    wait_gone(sleeper, "scope-carrying double-forked child");
    drop(b);
    let (_c, welcome, _) = Raw::connect(&th.socket);
    assert!(welcome.terminals.is_empty());
}

#[test]
fn exit_is_reported_after_the_last_output() {
    let th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (handle, _) = a.spawn("t-exit", "echo bye; exit 3", &[], "test-scope");
    let mut out = String::new();
    let exited = loop {
        let f = a.next();
        match f.kind {
            proto::OUTPUT => out.push_str(&String::from_utf8_lossy(&f.payload)),
            proto::EXITED => break proto::parse::<proto::Exited>(&f).unwrap(),
            _ => {}
        }
    };
    assert!(out.contains("bye"), "output after EXITED: {out:?}");
    assert_eq!(exited.code, Some(3));
    // Exited terminals stay (with their tail) until RELEASE.
    drop(a);
    let (mut b, welcome, tails) = Raw::connect(&th.socket);
    assert_eq!(welcome.terminals.len(), 1);
    assert!(welcome.terminals[0].exited);
    assert_eq!(welcome.terminals[0].exit_code, Some(3));
    assert!(String::from_utf8_lossy(&tails[0].2).contains("bye"));
    b.send(proto::RELEASE, handle, &[]);
}

#[test]
fn duplicate_ids_and_bad_hello_are_refused() {
    let th = TestHolder::default();
    // Wrong protocol version: BYE, no WELCOME.
    let mut bad = proto::Hello::current();
    bad.version = 99;
    let mut r = Raw::hello(&th.socket, &bad);
    let f = r.next();
    assert_eq!(f.kind, proto::BYE);
    assert!(proto::parse::<proto::Bye>(&f)
        .unwrap()
        .reason
        .contains("protocol version 99"));

    let (mut a, _, _) = Raw::connect(&th.socket);
    let (handle, _) = a.spawn("dup", "sleep 30", &[], "test-scope");
    a.send_json(
        proto::SPAWN,
        0,
        &proto::Spawn {
            id: "dup".into(),
            argv: vec!["/bin/sh".into()],
            cwd: None,
            env: BTreeMap::new(),
            rows: 24,
            cols: 80,
            scope: "test-scope".into(),
        },
    );
    let f = loop {
        let f = a.next();
        if f.kind == proto::SPAWN_FAILED {
            break f;
        }
    };
    assert!(proto::parse::<proto::SpawnFailed>(&f)
        .unwrap()
        .error
        .contains("already exists"));
    a.send(proto::RELEASE, handle, &[]);
}

#[test]
fn newest_hello_wins_and_the_old_client_gets_bye() {
    let th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (_b, _, _) = Raw::connect(&th.socket);
    let f = a.next();
    assert_eq!(f.kind, proto::BYE);
    assert_eq!(proto::parse::<proto::Bye>(&f).unwrap().reason, "replaced");
}

#[test]
fn peer_uid_is_checked() {
    let (x, _y) = UnixStream::pair().unwrap();
    assert_eq!(server::peer_uid(&x).unwrap(), server::current_uid());

    // A holder that only serves some other uid closes the connection without WELCOME.
    let th = TestHolder::start(
        Duration::from_secs(60),
        server::current_uid().wrapping_add(1),
    );
    let mut r = Raw::hello(&th.socket, &proto::Hello::current());
    let err = proto::read_frame(&mut r.stream).unwrap_err();
    // macOS reports EOF; Linux AF_UNIX may reset (our HELLO was unread when it closed).
    assert!(
        matches!(
            err.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
        ),
        "{err:?}"
    );
}

#[test]
fn garbage_oversized_and_truncated_frames_never_take_the_holder_down() {
    let th = TestHolder::default();
    let read_ends = |mut s: UnixStream| {
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut buf = Vec::new();
        // The holder closes (or BYEs and closes) instead of hanging or panicking.
        let _ = std::io::Read::read_to_end(&mut s, &mut buf);
        buf
    };
    // Not a HELLO.
    let mut s = UnixStream::connect(&th.socket).unwrap();
    s.write_all(&proto::encode(proto::PING, 0, b"x").unwrap())
        .unwrap();
    let reply = read_ends(s);
    assert_eq!(reply.first(), Some(&proto::BYE));
    // Random bytes that decode to a huge length.
    let mut s = UnixStream::connect(&th.socket).unwrap();
    s.write_all(&[0xff; 64]).unwrap();
    read_ends(s);
    // A header promising more than it sends, then EOF.
    let mut s = UnixStream::connect(&th.socket).unwrap();
    s.write_all(&[proto::HELLO, 0, 0, 0, 0, 100, 0, 0, 0, b'{'])
        .unwrap();
    s.shutdown(std::net::Shutdown::Write).unwrap();
    read_ends(s);
    // After a good HELLO: an oversized frame header, then a SPAWN with bad JSON.
    let (mut a, _, _) = Raw::connect(&th.socket);
    let mut header = vec![proto::INPUT, 1, 0, 0, 0];
    header.extend_from_slice(&((proto::MAX_PAYLOAD as u32) + 1).to_le_bytes());
    a.stream.write_all(&header).unwrap();
    read_ends(a.stream.try_clone().unwrap());
    let (mut b, _, _) = Raw::connect(&th.socket);
    b.send(proto::SPAWN, 0, b"{not json");
    read_ends(b.stream.try_clone().unwrap());
    // Still serving.
    let (mut c, welcome, _) = Raw::connect(&th.socket);
    assert!(welcome.terminals.is_empty());
    let (handle, _) = c.spawn("after-garbage", "echo alive; sleep 30", &[], "test-scope");
    c.output_until(handle, "alive");
    c.send(proto::RELEASE, handle, &[]);
}

#[test]
fn tail_ring_keeps_one_mib_and_counts_dropped_bytes() {
    let mut ring = TailRing::new(TAIL_BYTES);
    ring.push(&vec![b'a'; TAIL_BYTES - 1]);
    assert_eq!((ring.seq_start(), ring.dropped()), (0, 0));
    ring.push(b"bcd");
    assert_eq!((ring.seq_start(), ring.dropped()), (2, 2));
    let c = ring.contents();
    assert_eq!(c.len(), TAIL_BYTES);
    assert_eq!(&c[c.len() - 3..], b"bcd");
    // One chunk bigger than the ring.
    ring.push(&vec![b'z'; TAIL_BYTES + 5]);
    assert_eq!(ring.dropped(), 2 + TAIL_BYTES as u64 + 5);
    assert_eq!(ring.contents(), vec![b'z'; TAIL_BYTES]);
}

#[test]
fn dropped_bytes_grow_past_one_mib_end_to_end() {
    let th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let total = TAIL_BYTES + 100_000;
    let script = format!("head -c {total} /dev/zero | tr '\\0' a; echo; echo DONE; sleep 30");
    let (handle, _) = a.spawn("big", &script, &[], "test-scope");
    a.output_until(handle, "DONE");
    drop(a);
    let (mut b, welcome, tails) = Raw::connect(&th.socket);
    let t = &welcome.terminals[0];
    let (_, header, bytes) = &tails[0];
    assert!(t.dropped_bytes > 0, "dropped_bytes stayed 0");
    assert_eq!(header.dropped_bytes, t.dropped_bytes);
    assert_eq!(header.seq_start, t.dropped_bytes);
    assert_eq!(bytes.len(), TAIL_BYTES);
    // seq_start + tail = every byte produced (total 'a's + "\r\nDONE\r\n").
    assert!(header.seq_start + bytes.len() as u64 >= total as u64);
    b.send(proto::RELEASE, handle, &[]);
}

#[test]
fn modes_are_tracked_across_split_sequences() {
    let mut m = ModeTracker::default();
    m.feed(b"\x1b[?10");
    m.feed(b"49h\x1b[?2004h\x1b[?1000;1006h");
    assert_eq!(m.snapshot().decset, vec![1000, 1006, 1049, 2004]);
    m.feed(b"\x1b[?1000l\x1b[?25l\x1b[?1h"); // untracked modes are ignored
    assert_eq!(m.snapshot().decset, vec![1006, 1049, 2004]);
    // kitty keyboard: push, set-or, pop
    m.feed(b"\x1b[>1u");
    assert_eq!(m.snapshot().kitty_keyboard, 1);
    m.feed(b"\x1b[=4;2u");
    assert_eq!(m.snapshot().kitty_keyboard, 5);
    m.feed(b"\x1b[>3u\x1b[<u");
    assert_eq!(m.snapshot().kitty_keyboard, 5);
    m.feed(b"\x1b[?u"); // query, not a change
    m.feed(b"\x1b[<u");
    assert_eq!(m.snapshot().kitty_keyboard, 0);
    // Text and other CSIs don't disturb it; RIS resets.
    m.feed("plain 텍스트 \x1b[31m red \x1b[0m".as_bytes());
    assert_eq!(m.snapshot().decset, vec![1006, 1049, 2004]);
    m.feed(b"\x1bc");
    assert_eq!(m.snapshot(), proto::Modes::default());
    // The holder reports modes in WELCOME.
    let mut m2 = ModeTracker::default();
    m2.feed(b"\x1b[?47h\x1b[?1047h\x1b[?1002h\x1b[?1003h");
    assert_eq!(m2.snapshot().decset, vec![47, 1002, 1003, 1047]);
}

#[test]
fn welcome_reports_tracked_modes() {
    let th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (handle, _) = a.spawn(
        "modes",
        "printf '\\033[?1049h\\033[?2004h\\033[>1uREADY'; sleep 30",
        &[],
        "test-scope",
    );
    a.output_until(handle, "READY");
    drop(a);
    let (mut b, welcome, _) = Raw::connect(&th.socket);
    let modes = &welcome.terminals[0].modes;
    assert_eq!(modes.decset, vec![1049, 2004]);
    assert_eq!(modes.kitty_keyboard, 1);
    b.send(proto::RELEASE, handle, &[]);
}

#[test]
fn idle_holder_exits_on_its_own() {
    assert_eq!(server::idle_exit_from(None), Duration::from_secs(60));
    assert_eq!(
        server::idle_exit_from(Some("1500")),
        Duration::from_millis(1500)
    );
    assert_eq!(server::idle_exit_from(Some("x")), Duration::from_secs(60));

    let mut th = TestHolder::start(Duration::from_millis(300), server::current_uid());
    // A connected client keeps it alive past the timeout...
    let (a, _, _) = Raw::connect(&th.socket);
    thread::sleep(Duration::from_millis(800));
    assert!(
        !th.holder.is_shutting_down(),
        "exited with a client attached"
    );
    // ...and once it leaves, the holder ends by itself.
    drop(a);
    assert!(
        th.wait_stopped(Duration::from_secs(5)),
        "holder did not exit when idle"
    );
}

#[test]
fn goodbye_kill_all_ends_terminals_and_holder() {
    let mut th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (_, pid1) = a.spawn("k1", "sleep 30", &[], "test-scope");
    let (_, pid2) = a.spawn("k2", "sleep 30", &[], "test-scope");
    a.send_json(
        proto::GOODBYE,
        0,
        &proto::Goodbye {
            reason: "kill_all".into(),
        },
    );
    wait_gone(pid1, "k1");
    wait_gone(pid2, "k2");
    assert!(
        th.wait_stopped(Duration::from_secs(10)),
        "holder kept running after kill_all"
    );
}

// ─── HolderBackend through the PtyBackend trait ───

fn sh(script: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.arg("-c");
    cmd.arg(script);
    cmd
}

fn spawn_req(id: &str, script: &str) -> SpawnRequest {
    SpawnRequest {
        terminal_id: id.into(),
        cmd: sh(script),
        rows: 24,
        cols: 80,
        scope_token: "test-scope".into(),
        replace: false,
    }
}

/// Pull until `needle` shows up; returns everything read.
fn read_until(b: &dyn PtyBackend, id: &str, needle: &str, out: &mut String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !out.contains(needle) {
        assert!(Instant::now() < deadline, "no {needle:?}; got {out:?}");
        match b.read(id) {
            Ok(Some(chunk)) => out.push_str(&chunk),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => panic!("read: {e}; got {out:?}"),
        }
    }
}

fn write_retrying(b: &dyn PtyBackend, id: &str, data: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while let Err(e) = b.write(id, data) {
        assert!(Instant::now() < deadline, "write never succeeded: {e}");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn holder_backend_end_to_end_without_duplicates() {
    let th = TestHolder::default();
    let backend = HolderBackend::connect(&th.socket).unwrap();
    let b: &dyn PtyBackend = &backend;
    assert!(backend.recovered().is_empty());
    assert_eq!(b.read("nope"), Err("PTY not found".to_string()));

    // "é" split across two writes exercises the per-terminal UTF-8 reassembly.
    b.spawn(spawn_req(
        "h1",
        "printf 'A1 \\303'; printf '\\251\\n'; read l; printf 'B2:%s\\n' \"$l\"; read l; printf 'C3:%s\\n' \"$l\"; sleep 30",
    ))
    .unwrap();
    assert!(b.alive("h1"));
    let pid = b.pid("h1").unwrap().expect("pid");
    assert_eq!(b.list().len(), 1);
    let mut out = String::new();
    read_until(b, "h1", "A1 é", &mut out);

    // Connection drops (no BYE): the backend reconnects on its own and must not
    // hand the already-delivered "A1" over a second time. (Input written into a
    // connection the holder is closing is lost, so wait for the new one.)
    assert_eq!(backend.live_connection(), Some(1));
    th.holder.kick_client();
    let deadline = Instant::now() + Duration::from_secs(10);
    while backend.live_connection() != Some(2) {
        assert!(Instant::now() < deadline, "backend never reconnected");
        thread::sleep(Duration::from_millis(10));
    }
    write_retrying(b, "h1", "x\n");
    read_until(b, "h1", "B2:x", &mut out);
    b.resize("h1", 40, 120).unwrap();

    // A second app attaches (the first gets BYE): the terminal is "recovered",
    // its history is in tail(), and read() returns only what comes after.
    let app2 = HolderBackend::connect(&th.socket).unwrap();
    let b2: &dyn PtyBackend = &app2;
    let rec = app2.recovered();
    assert_eq!(rec.len(), 1);
    assert_eq!((rec[0].id.as_str(), rec[0].pid), ("h1", Some(pid)));
    let tail = b2.attach_snapshot("h1").unwrap();
    assert!(tail.contains("A1 é") && tail.contains("B2:x"), "{tail:?}");
    assert_eq!(
        b2.read("h1"),
        Ok(None),
        "recovered terminal re-sent its tail through read()"
    );
    b2.write("h1", "y\n").unwrap();
    let mut out2 = String::new();
    read_until(b2, "h1", "C3:y", &mut out2);
    assert!(!out2.contains("A1") && !out2.contains("B2"), "{out2:?}");

    // The first app was pushed off: its terminal reads as disconnected.
    let deadline = Instant::now() + Duration::from_secs(5);
    while b.alive("h1") {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    assert!(backend.lost_reason().unwrap().contains("replaced"));
    assert_eq!(out.matches("A1").count(), 1, "{out:?}");
    assert_eq!(out.matches("B2:x").count(), 1, "{out:?}");

    b2.close("h1").unwrap();
    assert_eq!(b2.read("h1"), Err("PTY not found".to_string()));
    wait_gone(pid, "released shell");
}

#[test]
fn racing_reconnects_deliver_no_duplicate_bytes() {
    let th = TestHolder::default();
    let backend = Arc::new(HolderBackend::connect(&th.socket).unwrap());
    let b: &dyn PtyBackend = &*backend;
    b.spawn(spawn_req(
        "r1",
        "printf 'M0\\n'; while read l; do printf 'M:%s\\n' \"$l\"; done",
    ))
    .unwrap();
    let mut out = String::new();
    read_until(b, "r1", "M0", &mut out);
    for round in 0..5 {
        let before = backend.live_connection().expect("connected");
        th.holder.kick_client();
        // The reader's own reconnect plus several callers (spawn's relink) at once.
        let racers: Vec<_> = (0..4)
            .map(|_| {
                let be = Arc::clone(&backend);
                thread::spawn(move || be.relink_for_test())
            })
            .collect();
        for r in racers {
            let _ = r.join();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while backend.live_connection().is_none_or(|g| g <= before) {
            assert!(Instant::now() < deadline, "never reconnected");
            thread::sleep(Duration::from_millis(10));
        }
        write_retrying(b, "r1", &format!("x{round}\n"));
        read_until(b, "r1", &format!("M:x{round}"), &mut out);
    }
    assert!(
        backend.lost_reason().is_none(),
        "{:?}",
        backend.lost_reason()
    );
    assert_eq!(out.matches("M0").count(), 1, "{out:?}");
    for round in 0..5 {
        assert_eq!(out.matches(&format!("M:x{round}")).count(), 1, "{out:?}");
    }
    b.close("r1").unwrap();
}

#[test]
fn holder_backend_reports_exit_like_in_process() {
    let th = TestHolder::default();
    let backend = HolderBackend::connect(&th.socket).unwrap();
    let b: &dyn PtyBackend = &backend;
    b.spawn(spawn_req("e1", "printf 'done'; exit 0")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut out = String::new();
    let end = loop {
        assert!(Instant::now() < deadline, "no disconnect; got {out:?}");
        match b.read("e1") {
            Ok(Some(c)) => out.push_str(&c),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(e) => break e,
        }
    };
    assert_eq!(end, "PTY disconnected");
    assert!(out.contains("done"));
    assert!(!b.alive("e1"));
    assert!(b.tail("e1").unwrap().contains("done"));
    assert!(b.write("e1", "x").is_err());
    // Reaped: the pid may already be someone else's, so it is no longer reported.
    assert_eq!(b.pid("e1"), Ok(None));
    assert!(b.list().iter().all(|t| t.pid.is_none()));
    // An ended terminal may be respawned under the same id.
    b.spawn(spawn_req("e1", "printf again; sleep 30")).unwrap();
    let mut again = String::new();
    read_until(b, "e1", "again", &mut again);
    b.close("e1").unwrap();
}

#[test]
fn a_running_id_is_refused_unless_replace_is_asked_for() {
    let th = TestHolder::default();
    let backend = HolderBackend::connect(&th.socket).unwrap();
    let b: &dyn PtyBackend = &backend;
    b.spawn(spawn_req("k1", "printf first; sleep 30")).unwrap();
    let pid = b.pid("k1").unwrap().expect("pid");
    let mut out = String::new();
    read_until(b, "k1", "first", &mut out);
    // A create_shell that missed the recovery list must not kill the running program.
    assert_eq!(
        b.spawn(spawn_req("k1", "printf second; sleep 30")),
        Err(crate::pty_backend::PTY_ALIVE_IN_HOLDER.to_string())
    );
    assert!(b.alive("k1"));
    assert_eq!(b.pid("k1"), Ok(Some(pid)));
    // Explicit intent replaces it.
    let mut req = spawn_req("k1", "printf second; sleep 30");
    req.replace = true;
    b.spawn(req).unwrap();
    let mut out2 = String::new();
    read_until(b, "k1", "second", &mut out2);
    wait_gone(pid, "replaced shell");
    b.close("k1").unwrap();
}

/// Manual check against a real holder process (`octo-ui --mode pty-holder --socket …`):
/// `BBARIT_HOLDER_LIVE_SOCKET=<sock> BBARIT_HOLDER_LIVE_PHASE=spawn|reattach
///  cargo test live_holder_client -- --ignored --nocapture`.
/// `spawn` starts `sh` and then idles until killed; `reattach` lists, replays, types,
/// releases, and says GOODBYE quit.
#[test]
#[ignore]
fn live_holder_client() {
    let (Some(socket), Some(phase)) = (
        std::env::var_os("BBARIT_HOLDER_LIVE_SOCKET"),
        std::env::var("BBARIT_HOLDER_LIVE_PHASE").ok(),
    ) else {
        return;
    };
    let backend = HolderBackend::connect(Path::new(&socket)).unwrap();
    let b: &dyn PtyBackend = &backend;
    match phase.as_str() {
        "spawn" => {
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.env("PS1", "$ ");
            b.spawn(SpawnRequest {
                terminal_id: "live-1".into(),
                cmd,
                rows: 24,
                cols: 80,
                scope_token: crate::new_scope_token(),
                replace: false,
            })
            .unwrap();
            b.write("live-1", "echo hello-from-holder\n").unwrap();
            let mut out = String::new();
            read_until(b, "live-1", "hello-from-holder\r\n", &mut out);
            println!(
                "LIVE spawned sh pid={} output={out:?}",
                b.pid("live-1").unwrap().unwrap()
            );
            println!("LIVE client pid={} idling until killed", std::process::id());
            thread::sleep(Duration::from_secs(600));
        }
        "reattach" => {
            for t in backend.recovered() {
                println!(
                    "LIVE recovered id={} handle={} pid={:?} exited={} dropped_bytes={} modes={:?}",
                    t.id, t.handle, t.pid, t.exited, t.dropped_bytes, t.modes
                );
            }
            println!("LIVE tail={:?}", b.tail("live-1").unwrap());
            println!(
                "LIVE first read after attach={:?}",
                b.read("live-1").unwrap()
            );
            b.write("live-1", "echo after-reattach\n").unwrap();
            let mut out = String::new();
            read_until(b, "live-1", "after-reattach\r\n", &mut out);
            println!("LIVE output after input={out:?}");
            let pid = b.pid("live-1").unwrap().unwrap();
            b.close("live-1").unwrap();
            wait_gone(pid, "released sh");
            println!("LIVE released; sh {pid} gone");
            backend.goodbye("quit");
        }
        other => panic!("unknown phase {other}"),
    }
}

/// `launchctl list` row for `label`: None = not listed, Some(None) = listed with pid `-`.
fn launchctl_pid(label: &str) -> Option<Option<u32>> {
    let out = std::process::Command::new("launchctl").arg("list").output().unwrap();
    let list = String::from_utf8_lossy(&out.stdout);
    super::spawn::launchd::our_jobs(&list, &super::spawn::launchd::label_prefix())
        .into_iter()
        .find(|(_, l)| l == label)
        .map(|(pid, _)| pid)
}

/// Manual check of the app-side spawn path with the real binary (macOS: as a launchd job;
/// `BBARIT_PTY_HOLDER_SPAWN=setsid` for the setsid path):
/// `BBARIT_HOLDER_LIVE_EXE=target/debug/octo-ui cargo test live_spawn_detached_holder -- --ignored --nocapture`.
#[test]
#[ignore]
fn live_spawn_detached_holder() {
    let Some(exe) = std::env::var_os("BBARIT_HOLDER_LIVE_EXE") else {
        return;
    };
    let run = PathBuf::from(format!("/tmp/bbh-run-{}", super::new_instance_id()));
    let socket = super::spawn::spawn_holder_with(Path::new(&exe), &run).unwrap();
    let found = super::spawn::discover(&run);
    assert_eq!(found.len(), 1);
    let info = &found[0].1;
    println!("LIVE socket={} info={info:?}", socket.display());
    assert_eq!(
        super::spawn::find_or_spawn(&run).unwrap(),
        socket,
        "second lookup reuses the live holder"
    );
    let sid = unsafe { libc::getsid(info.pid as libc::pid_t) };
    let pgid = unsafe { libc::getpgid(info.pid as libc::pid_t) };
    println!(
        "LIVE holder pid={} sid={sid} pgid={pgid} spawnMethod={:?} label={:?} unit={:?}",
        info.pid, info.spawn_method, info.label, info.unit
    );
    if info.spawn_method.as_deref() == Some("setsid") {
        assert_eq!(sid as u32, info.pid, "setsid → sid == pid");
    }
    let launchd_label = if cfg!(target_os = "macos") && std::env::var_os(super::spawn::SPAWN_ENV).is_none() {
        assert_eq!(info.spawn_method.as_deref(), Some("launchd"), "{:?}", super::spawn::describe(&socket));
        let label = info.label.clone().expect("launchd label");
        assert_eq!(launchctl_pid(&label), Some(Some(info.pid)), "live job listed with the holder pid");
        Some(label)
    } else {
        None
    };
    let mut sys = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(info.pid);
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing().with_environ(sysinfo::UpdateKind::Always),
    );
    let env = sys.process(pid).unwrap().environ();
    assert!(!env.is_empty(), "holder environ unreadable");
    let leaked: Vec<_> = env
        .iter()
        .filter(|e| e.to_string_lossy().starts_with("BBARIT_TERM_SCOPE="))
        .collect();
    println!(
        "LIVE holder environ has {} vars, BBARIT_TERM_SCOPE entries: {leaked:?}",
        env.len()
    );
    assert!(leaked.is_empty());
    let backend = HolderBackend::connect(&socket).unwrap();
    backend.goodbye("kill_all");
    wait_gone(info.pid, "holder after kill_all");
    if let Some(label) = &launchd_label {
        // A finished one-shot job stays listed as `- 0 <label>` until the next spawn's cleanup.
        assert_eq!(launchctl_pid(label), Some(None), "finished job listed with pid -");
        println!("LIVE after kill_all: {label} listed with pid -");
        // Zero age limit: the plist is seconds old (the app's own cleanup waits STALE_MIN_AGE).
        super::spawn::launchd::cleanup_stale_with(&run, Duration::ZERO);
        assert_eq!(launchctl_pid(label), None, "stale job booted out");
        let plists: Vec<_> = std::fs::read_dir(&run)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".plist"))
            .collect();
        assert!(plists.is_empty(), "plist of a finished job removed: {plists:?}");
        println!("LIVE cleanup booted out {label} and removed its plist");
    }
    println!(
        "LIVE holder exited after GOODBYE kill_all; files left: {:?}",
        std::fs::read_dir(&run)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect::<Vec<_>>()
    );
    let _ = std::fs::remove_dir_all(&run);
}

/// SIGTERM (launchd bootout / systemd stop) removes the socket and info file and logs
/// "exiting: SIGTERM". It does not kill_all: terminals are not killed by the holder; they
/// end by the kernel's SIGHUP when the PTY master closes with the holder.
#[test]
fn sigterm_removes_socket_and_info_and_leaves_terminals_to_the_hangup() {
    let dir = PathBuf::from(format!("/tmp/bbh-sig-{}", super::new_instance_id()));
    super::ensure_private_dir(&dir).unwrap();
    let socket = dir.join("pty-holder.dev.sigtest1.sock");
    let info_path = super::info_path_for(&socket);
    let log_path = dir.join("holder.log");
    let mut holder = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "pty_holder::integration_tests::holder_process_main",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(RUN_HOLDER_SOCKET_ENV, &socket)
        .env_remove(crate::SCOPE_ENV)
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(&log_path).unwrap())
        .spawn()
        .unwrap();
    let info: proto::HolderInfo = serde_json::from_str(&wait_for_file(&info_path)).unwrap();
    assert_eq!(info.pid, holder.id());
    assert_eq!(info.spawn_method.as_deref(), Some("manual"));
    assert_eq!(info.instance, "sigtest1");

    let backend = HolderBackend::connect(&socket).unwrap();
    // The shell records SIGHUP, so its death is the PTY hangup, not a holder kill.
    let hup_file = dir.join("hup");
    let script = format!("trap 'echo hup > {}; exit 0' HUP; echo ready; while :; do sleep 0.1; done", hup_file.display());
    backend.spawn(spawn_req("sig-1", &script)).unwrap();
    let mut out = String::new();
    read_until(&backend, "sig-1", "ready", &mut out);
    let sh_pid = backend.pid("sig-1").unwrap().unwrap();
    assert!(alive(sh_pid));

    // SAFETY: signalling our own child.
    unsafe {
        libc::kill(holder.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = holder.try_wait().unwrap() {
            break st;
        }
        assert!(Instant::now() < deadline, "holder ignored SIGTERM");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "holder exit status {status:?}");
    let log = std::fs::read_to_string(&log_path).unwrap();
    assert!(log.contains("[pty-holder] exiting: SIGTERM"), "{log}");
    assert!(!socket.exists(), "socket left behind");
    assert!(!info_path.exists(), "info file left behind");
    wait_gone(sh_pid, "shell after the holder's PTY closed");
    assert_eq!(wait_for_file(&hup_file).trim(), "hup", "shell ended by SIGHUP");
    drop(backend);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_sigterm_during_goodbye_kill_all_waits_for_the_kill() {
    // macOS logout: the app's GOODBYE kill_all and launchd's SIGTERM overlap. The holder
    // must not end (and leave HUP/TERM-ignoring children behind) while kill_all still runs.
    let mut th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (handle, pid) = a.spawn(
        "stubborn",
        "trap '' HUP TERM; printf ready; while :; do sleep 1; done",
        &[],
        "test-scope-kill-all",
    );
    a.output_until(handle, "ready");
    a.send_json(
        proto::GOODBYE,
        0,
        &proto::Goodbye {
            reason: "kill_all".into(),
        },
    );
    // kill_all has taken the terminals (its TERM → 300 ms → KILL is still ahead)...
    let deadline = Instant::now() + Duration::from_secs(5);
    while th.holder.terminal_count() > 0 {
        assert!(Instant::now() < deadline, "kill_all never started");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(th.holder.sweeps_running() > 0 || !running(pid), "kill_all is not counted");
    // ...when the SIGTERM arrives.
    th.holder.stop_for_test("SIGTERM");
    assert!(th.wait_stopped(Duration::from_secs(15)), "holder never stopped");
    // serve() returning is the process exit: by then the stubborn shell must be gone.
    assert!(!running(pid), "a TERM/HUP-ignoring terminal outlived the holder");
    assert_eq!(th.holder.sweeps_running(), 0);
}

// ─── Update across a protocol change: older holder drained, new one primary (3.6) ───

#[test]
fn an_older_holder_is_recovered_and_drained_while_new_terminals_go_to_ours() {
    let old_v = proto::PROTOCOL_VERSION;
    let new_v = old_v + 1;
    let mut old = TestHolder::start_version(Duration::from_secs(60), server::current_uid(), old_v);
    let new = TestHolder::start_version(Duration::from_secs(60), server::current_uid(), new_v);

    // The previous app (old protocol) left a running terminal and an exited one behind.
    {
        let prev = HolderBackend::connect_version(&old.socket, old_v).unwrap();
        let p: &dyn PtyBackend = &prev;
        p.spawn(spawn_req(
            "old1",
            "printf 'OLD-READY\\n'; while read l; do printf 'OLD:%s\\n' \"$l\"; done",
        ))
        .unwrap();
        let mut out = String::new();
        read_until(p, "old1", "OLD-READY", &mut out);
        p.spawn(spawn_req("old2", "printf 'bye'; exit 3")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while p.alive("old2") {
            assert!(Instant::now() < deadline, "old2 never exited");
            thread::sleep(Duration::from_millis(20));
        }
        prev.goodbye("handover");
    }

    // The updated app: our protocol is new_v; the old holder is attached in old_v.
    let primary = HolderBackend::connect_version(&new.socket, new_v).unwrap();
    let set = HolderSet::with_older(primary, vec![(old.socket.clone(), old_v)]);
    let b: &dyn PtyBackend = &set;

    // Draining (and the holder says so), but still there for its terminals.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !(old.holder.is_draining() && set.holders_info()[1]["drainAcked"] == true) {
        assert!(Instant::now() < deadline, "DRAIN never reached the old holder");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!new.holder.is_draining());
    let ids: Vec<String> = set.recovered_now().into_iter().map(|e| e.id).collect();
    assert_eq!(ids, vec!["old1".to_string(), "old2".to_string()]);
    let info = set.holders_info();
    assert_eq!(info.len(), 2, "{info:?}");
    assert_eq!((info[0]["version"].as_u64(), info[0]["primary"].as_bool()), (Some(new_v as u64), Some(true)));
    assert_eq!(info[0]["draining"], false);
    assert_eq!((info[1]["version"].as_u64(), info[1]["draining"].as_bool()), (Some(old_v as u64), Some(true)));
    assert_eq!(info[1]["terminals"], 2);

    // Attach to the old terminal: replay, type, read.
    assert!(set.attach_snapshot("old1").unwrap().contains("OLD-READY"));
    assert!(set.tail("old2").unwrap().contains("bye"));
    b.write("old1", "ping\n").unwrap();
    let mut out = String::new();
    read_until(b, "old1", "OLD:ping", &mut out);
    b.resize("old1", 30, 100).unwrap();
    // A create_shell for the running id must attach, not start a second program.
    assert_eq!(b.spawn(spawn_req("old1", "true")), Err(crate::pty_backend::PTY_ALIVE_IN_HOLDER.to_string()));

    // New terminals go to the new holder only.
    b.spawn(spawn_req("new1", "printf 'NEW-READY\\n'; sleep 30")).unwrap();
    let mut out = String::new();
    read_until(b, "new1", "NEW-READY", &mut out);
    assert_eq!(new.holder.terminal_count(), 1);
    assert_eq!(old.holder.terminal_count(), 2);
    assert_eq!(set.older_index_of("new1"), None);
    // The exited old terminal is released after its banner; reusing its id spawns on ours.
    b.spawn(spawn_req("old2", "printf 'AGAIN\\n'; sleep 30")).unwrap();
    let mut out = String::new();
    read_until(b, "old2", "AGAIN", &mut out);
    assert_eq!(set.older_index_of("old2"), None);
    assert_eq!(new.holder.terminal_count(), 2);
    let deadline = Instant::now() + Duration::from_secs(5);
    while old.holder.terminal_count() != 1 {
        assert!(Instant::now() < deadline, "old2 was not released in the old holder");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(!old.holder.is_shutting_down(), "a draining holder with a live terminal stays");
    assert_eq!(b.list().len(), 3);

    // Closing the last old terminal ends the old holder; the set reports one holder.
    let old_pid = b.pid("old1").unwrap().expect("pid");
    b.close("old1").unwrap();
    wait_gone(old_pid, "old1 after release");
    assert!(old.wait_stopped(Duration::from_secs(10)), "drained holder kept running");
    let info = set.holders_info();
    assert_eq!(info.len(), 1, "{info:?}");
    assert_eq!(info[0]["primary"], true);
    assert_eq!(b.read("old1"), Err(crate::pty_backend::PTY_NOT_FOUND.to_string()));
    b.close("new1").unwrap();
    b.close("old2").unwrap();
}

#[test]
fn a_draining_holder_keeps_exited_terminals_until_they_are_released() {
    let mut th = TestHolder::default();
    let (mut a, _, _) = Raw::connect(&th.socket);
    let (h, _) = a.spawn("ex", "printf done; exit 0", &[], "test-scope-drain");
    loop {
        if a.next().kind == proto::EXITED {
            break;
        }
    }
    a.send(proto::DRAIN, 0, &[]);
    let ack = loop {
        let f = a.next();
        if f.kind == proto::ACK {
            break proto::parse::<proto::Ack>(&f).unwrap();
        }
    };
    assert_eq!(ack, proto::Ack { of: "DRAIN".into(), terminals: 1 });
    // Exited but not released: the app still has to replay its tail. Still serving.
    thread::sleep(Duration::from_millis(300));
    assert!(!th.holder.is_shutting_down(), "drained before the exited terminal was released");
    // A SPAWN is refused while draining.
    a.send_json(
        proto::SPAWN,
        0,
        &proto::Spawn {
            id: "late".into(),
            argv: vec!["/bin/sh".into()],
            cwd: None,
            env: BTreeMap::new(),
            rows: 24,
            cols: 80,
            scope: "s".into(),
        },
    );
    let refused = loop {
        let f = a.next();
        if f.kind == proto::SPAWN_FAILED {
            break proto::parse::<proto::SpawnFailed>(&f).unwrap();
        }
    };
    assert!(refused.error.contains("draining"), "{refused:?}");
    // DRAIN again is harmless; the RELEASE of the last terminal ends it.
    a.send(proto::DRAIN, 0, &[]);
    a.send(proto::RELEASE, h, &[]);
    assert!(th.wait_stopped(Duration::from_secs(10)), "holder did not exit when drained");
}
