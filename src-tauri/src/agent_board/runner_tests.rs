//! The runner for a board server: arguments, output parsing, path checks, the "program path only
//! from config.json" rule, and start/stop against a fake program (a shell script written to a
//! temp folder by each test).

use super::*;
use std::time::Instant;

const SERVER: &str = "https://board.example.invalid";

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("bbarit-runner-{tag}-{}-{:08x}", std::process::id(), rand::random::<u32>()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Write an executable shell script `name` in `dir`.
#[cfg(unix)]
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

fn cfg(mode: &str, url: &str, path: &str) -> Value {
    json!({ "agents": { "board": { "mode": mode, "server": { "url": url, "runnerPath": path } } } })
}

// ── Arguments ────────────────────────────────────────────────────────────

#[test]
fn argument_vectors_pass_the_server_as_one_argument() {
    assert_eq!(status_args(SERVER), ["runner", "status", "--json", "--server", SERVER]);
    assert_eq!(run_args(SERVER), ["runner", "run", "--server", SERVER]);
    assert_eq!(stop_args(SERVER), ["runner", "stop", "--server", SERVER]);
    assert_eq!(version_args(), ["version"]);
    // Nothing is split or interpreted: a value with spaces or shell characters stays one argument.
    let odd = "https://x.invalid; rm -rf ~";
    assert_eq!(status_args(odd).last().unwrap(), odd);
}

#[test]
fn the_command_drops_the_scope_token_and_runs_without_a_shell() {
    let cmd = base_command(Path::new("/opt/runner/bin/prog"), &status_args(SERVER));
    assert_eq!(cmd.get_program(), "/opt/runner/bin/prog");
    let argv: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert_eq!(argv, status_args(SERVER));
    let envs: Vec<_> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
    assert!(envs.contains(&(crate::SCOPE_ENV.to_string(), None)), "{envs:?}");
    assert!(envs.contains(&("BBARIT_AGENT_MODE".to_string(), None)), "{envs:?}");
    assert!(envs.iter().any(|(k, v)| k == "PATH" && v.as_deref().is_some_and(|p| p.contains("/opt/homebrew/bin"))));
}

#[test]
fn search_path_puts_user_install_folders_first() {
    assert_eq!(search_path("/home/u", "/usr/bin:/bin"), "/home/u/.local/bin:/home/u/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    assert_eq!(search_path("", ""), "/opt/homebrew/bin:/usr/local/bin");
}

// ── Configuration and the path ───────────────────────────────────────────

#[cfg(unix)]
#[test]
fn path_check_accepts_only_an_absolute_executable_file() {
    let dir = temp_dir("path");
    let prog = script(&dir, "prog", "exit 0");
    assert_eq!(check_program_path(&format!("  {}  ", prog.display())).unwrap(), prog);
    assert_eq!(check_program_path("").unwrap_err().kind, "no_path");
    assert_eq!(check_program_path("   ").unwrap_err().kind, "no_path");
    assert_eq!(check_program_path("bin/prog").unwrap_err().kind, "not_absolute");
    assert_eq!(check_program_path(&dir.join("missing").display().to_string()).unwrap_err().kind, "not_found");
    assert_eq!(check_program_path(&dir.display().to_string()).unwrap_err().kind, "not_file");
    let plain = dir.join("plain");
    std::fs::write(&plain, "x").unwrap();
    assert_eq!(check_program_path(&plain.display().to_string()).unwrap_err().kind, "not_executable");
    assert_eq!(check_program_path(&format!("{}\n", "/bin/sh\u{7}")).unwrap_err().kind, "bad_path");
    assert_eq!(check_program_path(&format!("/{}", "a".repeat(PATH_MAX_CHARS))).unwrap_err().kind, "bad_path");
    // A symbolic link to the program is followed.
    let link = dir.join("link");
    std::os::unix::fs::symlink(&prog, &link).unwrap();
    assert_eq!(check_program_path(&link.display().to_string()).unwrap(), link);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn the_target_comes_from_config_only() {
    let dir = temp_dir("target");
    let prog = script(&dir, "prog", "exit 0");
    let p = prog.display().to_string();
    let t = target_from_config(Some(&cfg("server", "https://Board.Example.invalid/", &p)), true).unwrap();
    assert_eq!(t, Target { program: prog.clone(), server: SERVER.to_string() });
    assert_eq!(target_from_config(Some(&cfg("sqlite", SERVER, &p)), true).unwrap_err().kind, "not_server_mode");
    assert_eq!(target_from_config(Some(&cfg("server", "", &p)), true).unwrap_err().kind, "bad_server");
    assert_eq!(target_from_config(Some(&cfg("server", "http://board.example.invalid", &p)), true).unwrap_err().kind, "bad_server");
    assert_eq!(target_from_config(Some(&cfg("server", SERVER, "")), true).unwrap_err().kind, "no_path");
    assert_eq!(target_from_config(None, true).unwrap_err().kind, "not_server_mode");
    // `version` needs no board server.
    assert_eq!(target_from_config(Some(&cfg("sqlite", "", &p)), false).unwrap().program, prog);
    assert_eq!(runner_path_from_config(Some(&json!({ "agents": { "board": { "server": { "runnerPath": 5 } } } }))), "");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The commands that run the program take no arguments at all (a page cannot name a program or
/// a server), and the one command that takes a path runs nothing.
#[test]
fn running_commands_take_nothing_from_the_webview() {
    let src = include_str!("runner.rs");
    for name in ["board_runner_status", "board_runner_start", "board_runner_stop", "board_runner_version"] {
        assert!(src.contains(&format!("pub async fn {name}() -> Result<Value, RunnerError>")), "{name} must take no arguments");
        assert_eq!(src.matches(&format!("fn {name}(")).count(), 1, "{name}");
    }
    let check = src.split("pub async fn board_runner_check_path").nth(1).unwrap();
    let body = check.split("#[cfg(test)]").next().unwrap();
    for runs in ["base_command", "capture(", "spawn_detached", "status(", "Command"] {
        assert!(!body.contains(runs), "board_runner_check_path must not run anything ({runs})");
    }
    // Every #[tauri::command] in the file is one of the five.
    assert_eq!(src.matches("#[tauri::command(async)]").count(), 5);
    assert!(!src.contains("#[tauri::command]\n"));
}

// ── Parsing ──────────────────────────────────────────────────────────────

fn full_status() -> Value {
    json!({
        "running": true, "pid": 4242, "server": SERVER, "runner": "studio", "account": "river",
        "startedAt": "2026-11-25T09:00:00Z", "mode": "stream", "cursor": 1234, "teams": ["alpha", "beta"],
        "wouldTake": ["alpha#3"], "lastChangeAt": "2026-11-25T09:05:00Z", "presenceAt": 1_790_000_000_000u64,
        "pool": { "min": 1, "max": 4, "idle": 1, "busy": 2, "suggestedMax": 3, "suggestion": "lower max: usage limit",
                  "limited": [{ "product": "agent-a", "until": "2026-11-25T12:00:00Z", "untilUnix": 1_790_010_000u64 }] },
        "workers": [
            { "id": "w1", "state": "working", "task": "alpha#2", "since": "2026-11-25T09:01:00Z", "product": "agent-a",
              "branch": "task/alpha-2", "worktree": "/tmp/w1", "profile": { "shell": true, "commands": ["git", "npm"], "domains": ["example.com"] },
              "refused": 0, "allowed": ["git"] },
            { "id": "w2", "state": "idle", "task": null, "since": "2026-11-25T09:00:00Z", "product": "agent-b", "branch": null, "worktree": null, "profile": null }
        ],
        "token": "never-copied",
    })
}

#[test]
fn parses_a_running_status_and_keeps_only_known_fields() {
    let v = parse_status(full_status().to_string().as_bytes()).unwrap();
    assert_eq!(v["running"], true);
    assert_eq!(v["pid"], 4242);
    assert_eq!(v["runner"], "studio");
    assert_eq!(v["account"], "river");
    assert_eq!(v["mode"], "stream");
    assert_eq!(v["cursor"], 1234);
    assert_eq!(v["teams"], json!(["alpha", "beta"]));
    assert_eq!(v["wouldTake"], json!(["alpha#3"]));
    assert_eq!(v["presenceAt"], 1_790_000_000_000u64);
    assert_eq!(v["pool"]["max"], 4);
    assert_eq!(v["pool"]["suggestedMax"], 3);
    assert_eq!(v["pool"]["limited"][0]["product"], "agent-a");
    assert_eq!(v["pool"]["limited"][0]["untilUnix"], 1_790_010_000u64);
    assert_eq!(v["workers"].as_array().unwrap().len(), 2);
    assert_eq!(v["workers"][0]["state"], "working");
    assert_eq!(v["workers"][0]["task"], "alpha#2");
    assert_eq!(v["workers"][0]["profile"]["commands"], json!(["git", "npm"]));
    assert_eq!(v["workers"][0]["allowed"], json!(["git"]));
    assert_eq!(v["workers"][1]["task"], Value::Null);
    assert_eq!(v["workers"][1]["profile"], Value::Null);
    assert!(v.get("token").is_none());
    assert!(!v.to_string().contains("never-copied"));
}

#[test]
fn parses_not_running_with_only_the_server() {
    let v = parse_status(format!("{{\"running\":false,\"server\":\"{SERVER}\",\"pid\":9}}\n").as_bytes()).unwrap();
    assert_eq!(v, json!({ "running": false, "server": SERVER }));
}

#[test]
fn rejects_output_that_is_not_the_expected_json() {
    for bad in [&b"hello"[..], b"", b"[1,2]", b"{\"running\":\"yes\"}", b"{}", b"{\"running\":true}{\"x\":1}"] {
        assert_eq!(parse_status(bad).unwrap_err().kind, "bad_output", "{:?}", String::from_utf8_lossy(bad));
    }
    let e = parse_status(b"\xff\xfe{\"running\":false}").unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("bad_output", "the output is not UTF-8 text"));
}

#[test]
fn untrusted_text_is_cleaned_and_capped() {
    let mut s = full_status();
    s["runner"] = json!(format!("evil\u{1b}[31m\u{202e}name{}", "x".repeat(500)));
    s["mode"] = json!("<b>stream</b>");
    s["workers"] = Value::Array((0..100).map(|i| json!({ "id": format!("w{i}"), "state": "idle" })).collect());
    s["teams"] = Value::Array((0..100).map(|i| json!(format!("t{i}"))).collect());
    s["pool"]["limited"] = Value::Array((0..40).map(|_| json!({ "product": "p" })).collect());
    let v = parse_status(s.to_string().as_bytes()).unwrap();
    let runner = v["runner"].as_str().unwrap();
    assert!(!runner.contains('\u{1b}') && !runner.contains('\u{202e}'), "{runner:?}");
    assert!(runner.starts_with("evil[31mname"));
    assert_eq!(runner.chars().count(), 120);
    assert!(runner.ends_with('…'));
    // Text stays text (the webview renders it as text, never HTML).
    assert_eq!(v["mode"], "<b>stream</b>");
    assert_eq!(v["workers"].as_array().unwrap().len(), 64);
    assert_eq!(v["teams"].as_array().unwrap().len(), 64);
    assert_eq!(v["pool"]["limited"].as_array().unwrap().len(), 16);
}

#[test]
fn error_details_are_capped_and_serialize_as_kind_and_detail() {
    let e = RunnerError::new("failed", format!("{}\u{7}", "e".repeat(5000)));
    assert_eq!(e.detail.chars().count(), DETAIL_CAP);
    assert_eq!(serde_json::to_value(&e).unwrap()["kind"], "failed");
    assert_eq!(cap_text("  a\nb\u{0}c  ", 10), "a\nbc");
    assert_eq!(cap_line("a\nb\tc", 10), "a b c");
}

// ── Running the fake program ─────────────────────────────────────────────

#[cfg(unix)]
#[tokio::test]
async fn status_runs_the_program_and_maps_failures() {
    let dir = temp_dir("status");
    // Arguments arrive as given (no shell in between): the script echoes them back.
    let ok = script(&dir, "ok", r#"[ "$1 $2 $3 $4" = "runner status --json --server" ] || exit 9; printf '{"running":false,"server":"%s"}\n' "$5""#);
    assert_eq!(status(&ok, SERVER, STATUS_TIMEOUT).await.unwrap(), json!({ "running": false, "server": SERVER }));

    let unsigned = script(&dir, "unsigned", "echo 'not signed in: run the login command first' >&2; exit 3");
    let e = status(&unsigned, SERVER, STATUS_TIMEOUT).await.unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("failed", "not signed in: run the login command first"));

    let silent = script(&dir, "silent", "exit 4");
    assert_eq!(status(&silent, SERVER, STATUS_TIMEOUT).await.unwrap_err().detail, "exit code 4");

    let garbage = script(&dir, "garbage", "echo hello");
    assert_eq!(status(&garbage, SERVER, STATUS_TIMEOUT).await.unwrap_err().kind, "bad_output");

    let binary = script(&dir, "binary", r#"printf '\377\376{}'"#);
    assert_eq!(status(&binary, SERVER, STATUS_TIMEOUT).await.unwrap_err().kind, "bad_output");

    // More than 1 MiB on standard output.
    let big = script(&dir, "big", "head -c 1100000 /dev/zero | tr '\\0' 'a'");
    let e = status(&big, SERVER, STATUS_TIMEOUT).await.unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("too_large", "more than 1024 KiB of output"));

    // A huge standard error is cut, never fatal.
    let noisy = script(&dir, "noisy", "head -c 300000 /dev/zero | tr '\\0' 'e' >&2; exit 1");
    let e = status(&noisy, SERVER, STATUS_TIMEOUT).await.unwrap_err();
    assert_eq!(e.kind, "failed");
    assert_eq!(e.detail.chars().count(), DETAIL_CAP);

    let missing = dir.join("gone");
    assert_eq!(status(&missing, SERVER, STATUS_TIMEOUT).await.unwrap_err().kind, "not_found");
    std::fs::remove_dir_all(&dir).unwrap();
}

/// The pid written to `file` by a test script.
#[cfg(unix)]
fn pid_in(file: &Path) -> i32 {
    for _ in 0..100 {
        if let Some(pid) = std::fs::read_to_string(file).ok().and_then(|s| s.trim().parse().ok()) {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("no pid in {}", file.display());
}

/// True once `pid` is gone (a killed child is reaped by init shortly after).
#[cfg(unix)]
fn gone(pid: i32) -> bool {
    for _ in 0..100 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[cfg(unix)]
#[tokio::test]
async fn a_slow_program_is_killed_at_the_timeout_with_its_children() {
    let dir = temp_dir("slow");
    let slow = script(&dir, "slow", &format!("sleep 30 & echo $! > '{}'; sleep 30; echo '{{\"running\":false}}'", dir.join("child").display()));
    let at = Instant::now();
    let e = status(&slow, SERVER, Duration::from_millis(300)).await.unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("timeout", "no answer within 300 ms"));
    assert!(at.elapsed() < Duration::from_secs(3), "{:?}", at.elapsed());
    // The program's own child is killed too (the whole process group).
    let child = pid_in(&dir.join("child"));
    assert!(gone(child), "child {child} still runs");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_child_left_holding_the_output_does_not_hold_up_the_answer() {
    let dir = temp_dir("leftover");
    // Exits at once but leaves a child that keeps standard output open.
    let prog = script(&dir, "prog", &format!("sleep 30 & echo $! > '{}'; printf '{{\"running\":false,\"server\":\"%s\"}}\\n' \"$5\"", dir.join("child").display()));
    let at = Instant::now();
    assert_eq!(status(&prog, SERVER, STATUS_TIMEOUT).await.unwrap(), json!({ "running": false, "server": SERVER }));
    assert!(at.elapsed() < Duration::from_secs(2), "{:?}", at.elapsed());
    let child = pid_in(&dir.join("child"));
    assert!(gone(child), "leftover child {child} still runs");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn capture_keeps_at_most_the_cap() {
    let dir = temp_dir("cap");
    let p = script(&dir, "p", "head -c 5000 /dev/zero | tr '\\0' 'a'");
    let c = capture(base_command(&p, &[]), STATUS_TIMEOUT, 1000).await.unwrap();
    assert!(c.success && c.stdout_over);
    assert_eq!(c.stdout.len(), 1000);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn version_reads_the_first_line() {
    let dir = temp_dir("version");
    let p = script(&dir, "p", r#"[ "$1" = version ] || exit 9; printf '\n  runner 1.2.3 \033\nmore\n'"#);
    assert_eq!(version(&p).await.unwrap(), json!({ "version": "runner 1.2.3" }));
    let q = script(&dir, "q", "echo 'runner 2.0.0'; echo extra");
    assert_eq!(version(&q).await.unwrap(), json!({ "version": "runner 2.0.0" }));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A fake runner: `runner run` records its pid, process group and scope variable and sleeps
/// until SIGTERM; `runner stop` sends that; `runner status --json` reports from the pid file.
#[cfg(unix)]
const FAKE_RUNNER: &str = r#"
dir=$(cd "$(dirname "$0")" && pwd)
case "$1 $2" in
  "runner status")
    if [ -f "$dir/pid" ] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
      printf '{"running":true,"pid":%s,"server":"%s","runner":"studio","account":"river","mode":"stream","pool":null,"workers":[]}\n' "$(cat "$dir/pid")" "$5"
    else
      printf '{"running":false,"server":"%s"}\n' "$5"
    fi ;;
  "runner run")
    [ "$3" = "--server" ] || exit 9
    echo "${BBARIT_TERM_SCOPE-unset}" > "$dir/scope"
    echo "$(ps -o pgid= -p $$ | tr -d ' ') $$" > "$dir/group"
    trap 'rm -f "$dir/pid"; echo stopped; exit 0' TERM
    echo $$ > "$dir/pid"
    echo "runner started for $4"
    echo "warning on stderr" >&2
    while :; do sleep 0.1; done ;;
  "runner stop")
    [ -f "$dir/pid" ] && kill "$(cat "$dir/pid")"
    exit 0 ;;
esac
"#;

/// Kills a fake runner left behind by a failed assertion.
#[cfg(unix)]
struct Reap(PathBuf);

#[cfg(unix)]
impl Drop for Reap {
    fn drop(&mut self) {
        if let Some(pid) = std::fs::read_to_string(self.0.join("pid")).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn start_detaches_logs_privately_and_stop_confirms() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("start");
    let _reap = Reap(dir.clone());
    let prog = script(&dir, "runner-prog", FAKE_RUNNER);
    let log = dir.join("run.log");
    let quick = Duration::from_millis(50);

    let v = start(&prog, SERVER, &log, Duration::from_secs(5), quick).await.unwrap();
    assert_eq!(v["running"], true);
    assert_eq!(v["runner"], "studio");
    assert_eq!(v["logPath"], log.display().to_string());
    // Its own session (process group = its pid), and no tab scope token.
    let group = std::fs::read_to_string(dir.join("group")).unwrap();
    let ids: Vec<&str> = group.split_whitespace().collect();
    assert_eq!(ids.len(), 2, "{group:?}");
    assert_eq!(ids[0], ids[1], "not in its own session: {group:?}");
    assert_eq!(std::fs::read_to_string(dir.join("scope")).unwrap().trim(), "unset");
    // The log is private and holds both streams.
    assert_eq!(std::fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(text.contains("starting the runner for https://board.example.invalid"), "{text}");
    assert!(text.contains("runner started for https://board.example.invalid"), "{text}");
    assert!(text.contains("warning on stderr"), "{text}");

    // Never a second one.
    let e = start(&prog, SERVER, &log, Duration::from_secs(5), quick).await.unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("already_running", "studio"));

    let v = stop(&prog, SERVER, Duration::from_secs(5), quick).await.unwrap();
    assert_eq!(v, json!({ "running": false, "server": SERVER }));
}

#[cfg(unix)]
#[tokio::test]
async fn a_start_that_ends_at_once_reports_the_log() {
    let dir = temp_dir("startfail");
    let _reap = Reap(dir.clone());
    let prog = script(
        &dir,
        "prog",
        r#"case "$1 $2" in
  "runner status") printf '{"running":false}\n' ;;
  "runner run") echo "not signed in: run the login command" >&2; exit 2 ;;
esac"#,
    );
    let log = dir.join("run.log");
    // A log over 5 MiB is moved aside before this start writes to it.
    std::fs::write(&log, vec![b'x'; LOG_ROTATE_BYTES as usize + 1]).unwrap();
    let e = start(&prog, SERVER, &log, Duration::from_secs(5), Duration::from_millis(100)).await.unwrap_err();
    assert_eq!(std::fs::metadata(dir.join("run.log.1")).unwrap().len(), LOG_ROTATE_BYTES + 1);
    assert!(std::fs::metadata(&log).unwrap().len() < 4096);
    assert_eq!(e.kind, "start_failed");
    assert!(e.detail.starts_with("the runner ended with exit code 2"), "{}", e.detail);
    assert!(e.detail.contains("not signed in: run the login command"), "{}", e.detail);
}

#[cfg(unix)]
#[tokio::test]
async fn a_runner_that_backgrounds_itself_and_exits_0_counts_as_started() {
    let dir = temp_dir("daemon");
    let _reap = Reap(dir.clone());
    let prog = script(
        &dir,
        "prog",
        r#"dir=$(cd "$(dirname "$0")" && pwd)
case "$1 $2" in
  "runner status")
    if [ -f "$dir/pid" ] && kill -0 "$(cat "$dir/pid")" 2>/dev/null; then printf '{"running":true,"runner":"studio"}\n'; else printf '{"running":false}\n'; fi ;;
  "runner run") ( while :; do sleep 0.1; done ) & echo $! > "$dir/pid"; exit 0 ;;
esac"#,
    );
    let log = dir.join("run.log");
    let v = start(&prog, SERVER, &log, Duration::from_secs(5), Duration::from_millis(200)).await.unwrap();
    assert_eq!(v["running"], true);
    // Exit 0 with nothing running is still a failed start.
    let quits = script(&dir, "quits", r#"case "$1 $2" in "runner status") printf '{"running":false}\n' ;; "runner run") exit 0 ;; esac"#);
    let e = start(&quits, SERVER, &dir.join("q.log"), Duration::from_secs(5), Duration::from_millis(100)).await.unwrap_err();
    assert_eq!(e.kind, "start_failed");
    assert!(e.detail.starts_with("the runner ended with exit code 0"), "{}", e.detail);
}

#[cfg(unix)]
#[tokio::test]
async fn a_start_that_never_reports_running_times_out() {
    let dir = temp_dir("startslow");
    let _reap = Reap(dir.clone());
    let prog = script(
        &dir,
        "prog",
        r#"dir=$(cd "$(dirname "$0")" && pwd)
case "$1 $2" in
  "runner status") printf '{"running":false}\n' ;;
  "runner run") echo $$ > "$dir/pid"; while :; do sleep 0.1; done ;;
esac"#,
    );
    let log = dir.join("run.log");
    let e = start(&prog, SERVER, &log, Duration::from_millis(400), Duration::from_millis(100)).await.unwrap_err();
    assert_eq!(e.kind, "start_timeout");
    assert!(e.detail.contains("did not report running within 400 ms"), "{}", e.detail);
}

#[cfg(unix)]
#[tokio::test]
async fn stop_says_so_when_the_runner_keeps_running() {
    let dir = temp_dir("stopstuck");
    let prog = script(&dir, "prog", r#"case "$1 $2" in "runner status") printf '{"running":true,"runner":"studio"}\n' ;; "runner stop") exit 0 ;; esac"#);
    let e = stop(&prog, SERVER, Duration::from_millis(300), Duration::from_millis(100)).await.unwrap_err();
    assert_eq!(e.kind, "stop_timeout");
    let failing = script(&dir, "failing", "echo 'cannot reach the runner' >&2; exit 1");
    let e = stop(&failing, SERVER, Duration::from_millis(300), Duration::from_millis(100)).await.unwrap_err();
    assert_eq!((e.kind, e.detail.as_str()), ("failed", "cannot reach the runner"));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn a_log_over_the_limit_is_moved_to_dot_1() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("rotate");
    let log = dir.join("run.log");
    let old = dir.join("run.log.1");
    // Missing or small: left alone.
    assert!(!rotate_log(&log, 100).unwrap());
    std::fs::write(&log, vec![b'a'; 100]).unwrap();
    assert!(!rotate_log(&log, 100).unwrap());
    assert!(log.exists() && !old.exists());
    // Over the limit: becomes .1 (replacing an older .1), private.
    std::fs::write(&old, "older").unwrap();
    std::fs::set_permissions(&log, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(&log, vec![b'a'; 101]).unwrap();
    assert!(rotate_log(&log, 100).unwrap());
    assert!(!log.exists());
    assert_eq!(std::fs::metadata(&old).unwrap().len(), 101);
    assert_eq!(std::fs::metadata(&old).unwrap().permissions().mode() & 0o777, 0o600);
    // A symbolic link at either name is refused.
    std::fs::write(&log, vec![b'a'; 101]).unwrap();
    std::fs::remove_file(&old).unwrap();
    std::os::unix::fs::symlink(dir.join("elsewhere"), &old).unwrap();
    assert_eq!(rotate_log(&log, 100).unwrap_err().kind, "io");
    std::fs::remove_file(&old).unwrap();
    let real = dir.join("real.log");
    std::fs::write(&real, vec![b'a'; 101]).unwrap();
    std::fs::remove_file(&log).unwrap();
    std::os::unix::fs::symlink(&real, &log).unwrap();
    assert_eq!(rotate_log(&log, 100).unwrap_err().kind, "io");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[cfg(unix)]
#[test]
fn the_log_refuses_a_symbolic_link() {
    let dir = temp_dir("loglink");
    let target = dir.join("elsewhere");
    std::fs::write(&target, "").unwrap();
    let link = dir.join("run.log");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(open_log(&link).unwrap_err().kind, "io");
    std::fs::remove_dir_all(&dir).unwrap();
}
