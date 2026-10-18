//! Browser control for the agent. Prefer the host app's native BBARIT Browser
//! CLI (Tauri WebView/WebView2 with the full CDP-backed control surface), then
//! fall back to the older Chrome extension bridge only when the CLI is absent.

use std::hash::{Hash, Hasher};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde_json::{Value, json};
use tungstenite::{Message, WebSocket, accept};

const PORT: u16 = 7333;

static CONN: OnceLock<Mutex<Option<WebSocket<TcpStream>>>> = OnceLock::new();
static STARTED: OnceLock<()> = OnceLock::new();
static BROWSER_SESSION: OnceLock<String> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn conn() -> &'static Mutex<Option<WebSocket<TcpStream>>> {
    CONN.get_or_init(|| Mutex::new(None))
}

/// Start the bridge listener once (idempotent). Safe to call on every tool use.
pub fn ensure_bridge() {
    STARTED.get_or_init(|| {
        std::thread::spawn(|| {
            let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT)) else {
                return;
            };
            for stream in listener.incoming().flatten() {
                let _ = stream.set_nodelay(true);
                if let Ok(ws) = accept(stream) {
                    // Newest connection wins (extension reloaded/reconnected).
                    *conn().lock().unwrap() = Some(ws);
                }
            }
        });
    });
}

/// True if the Chrome extension is currently connected.
pub fn is_connected() -> bool {
    ensure_bridge();
    conn().lock().unwrap().is_some()
}

/// True when the `browser` tool can actually drive a page right now: the native
/// BBARIT Browser CLI is reachable (host-app env or a repo-vendored copy) or the
/// extension bridge already has a live connection. Side-effect-free — it does not
/// start the listener — so it is safe to call while building the tool list.
pub fn control_available() -> bool {
    find_browser_cli().is_some() || conn().lock().map(|guard| guard.is_some()).unwrap_or(false)
}

/// Strip the Windows `\\?\` extended-length prefix. Canonicalized paths (e.g.
/// Tauri's resource_dir in installed builds) carry it, and Node.js cannot load
/// a `\\?\C:\...` entry script — it crashes with `EISDIR lstat 'C:'`, which
/// surfaced as "browser tool broken" in installed apps. Normalize before the
/// path leaves this process.
fn strip_extended_length_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Locate the BBARIT Browser CLI: the host app provides `BBARIT_BROWSER_CLI`;
/// otherwise walk up from the working directory for a repo-vendored copy so the
/// agent still gets the native app browser when run standalone.
fn find_browser_cli() -> Option<String> {
    // 1) Explicit env from the host app (preferred, and the fast path).
    if let Some(cli) = std::env::var_os("BBARIT_BROWSER_CLI") {
        let cli = strip_extended_length_prefix(&cli.to_string_lossy());
        if !cli.trim().is_empty() && std::path::Path::new(&cli).exists() {
            return Some(cli);
        }
    }
    // 2) Relative to THIS executable. The agent runs as the host's own exe
    //    (octo-ui.exe self-exec), so this makes the BBARIT Browser the default
    //    even when the env wasn't passed and the cwd is an unrelated project —
    //    the previous behavior silently fell back to the extension bridge.
    if let Ok(exe) = std::env::current_exe() {
        let rel = ["agent-browser-cli", "bin", "bbarit-browser-control.mjs"];
        let mut roots: Vec<std::path::PathBuf> = Vec::new();
        // installed: <resources>/_up_/agent-browser-cli/... (Tauri maps "../" to _up_)
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("resources").join("_up_"));
            roots.push(dir.join("_up_"));
            roots.push(dir.to_path_buf());
        }
        // dev: exe = <repo>/src-tauri/target/<profile>/octo-ui.exe → repo is 4 up.
        if let Some(repo) = exe.ancestors().nth(4) {
            roots.push(repo.to_path_buf());
        }
        for root in roots {
            let candidate = rel.iter().fold(root, |p, s| p.join(s));
            if candidate.exists() {
                return Some(strip_extended_length_prefix(
                    &candidate.display().to_string(),
                ));
            }
        }
    }
    // 3) Walk up from the working directory (standalone / repo checkout).
    find_browser_cli_from(&std::env::current_dir().ok()?)
}

fn find_browser_cli_from(start: &std::path::Path) -> Option<String> {
    let mut dir = start.to_path_buf();
    loop {
        let candidate = dir
            .join("agent-browser-cli")
            .join("bin")
            .join("bbarit-browser-control.mjs");
        if candidate.exists() {
            return Some(candidate.display().to_string());
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn browser_session_id() -> String {
    BROWSER_SESSION
        .get_or_init(|| {
            let env_values = [
                (
                    "BBARIT_BROWSER_SESSION",
                    std::env::var("BBARIT_BROWSER_SESSION").ok(),
                ),
                (
                    "BBARIT_AGENT_SESSION",
                    std::env::var("BBARIT_AGENT_SESSION").ok(),
                ),
                ("BBARIT_AGENT_ID", std::env::var("BBARIT_AGENT_ID").ok()),
                ("CODEX_SESSION_ID", std::env::var("CODEX_SESSION_ID").ok()),
                ("OCTO_SESSION_ID", std::env::var("OCTO_SESSION_ID").ok()),
            ];
            let cwd = std::env::current_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_default();
            browser_session_from_values(
                env_values
                    .iter()
                    .map(|(key, value)| (*key, value.as_deref())),
                &cwd,
            )
        })
        .clone()
}

fn browser_session_from_values<'a>(
    values: impl IntoIterator<Item = (&'a str, Option<&'a str>)>,
    cwd: &str,
) -> String {
    for (_key, value) in values {
        if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
            return value.to_string();
        }
    }
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    cwd.hash(&mut hasher);
    let hash = hasher.finish();
    format!("bbarit-agent-{hash:016x}")
}

pub fn browser_action(args: &Value) -> Result<String> {
    // Prefer the host app's native BBARIT Browser when its CLI is
    // available — screencast-accurate DOM/CSS plus the full network toolset.
    // Fall back to the chrome-extension bridge otherwise.
    if let Some(cli) = find_browser_cli() {
        return route_via_bbarit_browser(&cli, args);
    }

    ensure_bridge();
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if action.is_empty() {
        bail!(
            "browser: 'action' is required (navigate|newtab|click|type|read|html|url|screenshot|eval)"
        );
    }
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let mut command = args.clone();
    command["id"] = json!(id);

    let mut guard = conn().lock().unwrap();
    let Some(ws) = guard.as_mut() else {
        bail!(
            "Chrome extension not connected. Open chrome://extensions, enable Developer mode, \
             click \"Load unpacked\", and select the `chrome-extension/` folder in this project. \
             It connects to bbarit on ws://127.0.0.1:{PORT}."
        );
    };

    ws.send(Message::Text(command.to_string()))
        .context("send command to extension")?;
    let _ = ws.flush();

    loop {
        let message = match ws.read() {
            Ok(message) => message,
            Err(error) => {
                *guard = None;
                bail!("browser bridge read failed (extension disconnected?): {error}");
            }
        };
        match message {
            Message::Text(text) => {
                let reply: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if reply.get("id").and_then(Value::as_u64) != Some(id) {
                    continue; // not our reply
                }
                if reply.get("ok").and_then(Value::as_bool) != Some(true) {
                    bail!(
                        "browser {action} failed: {}",
                        reply
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                    );
                }
                let result = reply
                    .get("result")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| {
                        reply
                            .get("result")
                            .cloned()
                            .unwrap_or(Value::Null)
                            .to_string()
                    });

                // Screenshots come back as a data URL — save to a file instead of
                // dumping base64 into the transcript.
                if action == "screenshot" && result.starts_with("data:image") {
                    let path = args
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("screenshot.png");
                    save_data_url(&result, path)?;
                    return Ok(format!("Saved screenshot to {path}"));
                }
                let trimmed: String = result.chars().take(12000).collect();
                return Ok(trimmed);
            }
            Message::Close(_) => {
                *guard = None;
                bail!("browser bridge closed by extension");
            }
            Message::Ping(payload) => {
                let _ = ws.send(Message::Pong(payload));
            }
            _ => {}
        }
    }
}

/// Drive the host app's BBARIT Browser CLI. Maps the
/// agent's `browser` action to a CLI subcommand and returns its output. Unknown
/// actions pass through as raw CLI subcommands (with an optional `args` array),
/// exposing the full toolset (tabs, packets, har, composer, respond, breakpoint…).
fn route_via_bbarit_browser(cli: &str, args: &Value) -> Result<String> {
    let action = args.get("action").and_then(Value::as_str).unwrap_or("");
    if action.is_empty() {
        bail!(
            "browser: 'action' is required (navigate|newtab|click|type|read|html|url|screenshot|eval|<cli-command>)"
        );
    }
    let get = |key: &str| args.get(key).and_then(Value::as_str).map(ToOwned::to_owned);

    let mut sub: Vec<String> = Vec::new();
    let mut read_back: Option<String> = None;

    match action {
        "navigate" => {
            // `navigate`는 활성 탭에서 이동한다(같은 탭 재사용). 예전엔 `open`으로
            // 매핑해 매 navigate마다 새 탭이 열렸다(=브라우저가 계속 새로 열림, 실측).
            // 세션이 없으면 CLI가 open-first로 알아서 시동한다.
            let url = get("url").context("browser navigate: 'url' is required")?;
            sub = vec!["navigate".into(), url];
        }
        "open" => {
            // 명시적으로 새 세션을 열 때만 open.
            let url = get("url").context("browser open: 'url' is required")?;
            sub = vec!["open".into(), "--url".into(), url];
        }
        "newtab" => {
            sub = vec![
                "new-tab".into(),
                get("url").unwrap_or_else(|| "about:blank".into()),
            ]
        }
        "click" => {
            if let Some(sel) = get("selector") {
                sub = vec!["click-selector".into(), sel];
            } else if let (Some(x), Some(y)) = (args.get("x"), args.get("y")) {
                sub = vec![
                    "click".into(),
                    "--x".into(),
                    x.to_string(),
                    "--y".into(),
                    y.to_string(),
                ];
            } else {
                bail!("browser click: 'selector' or both 'x' and 'y' are required");
            }
        }
        "type" => {
            let text = get("text").unwrap_or_default();
            if let Some(sel) = get("selector") {
                sub = vec![
                    "type-selector".into(),
                    sel,
                    "--text".into(),
                    text,
                    "--clear".into(),
                ];
            } else {
                sub = vec!["type".into(), "--text".into(), text];
            }
        }
        "key" => {
            sub = vec![
                "key".into(),
                "--key".into(),
                get("key").unwrap_or_else(|| "Enter".into()),
            ]
        }
        "read" | "text" => {
            let sel = get("selector").unwrap_or_else(|| "body".into());
            let tmp = temp_artifact("txt");
            sub = vec![
                "text".into(),
                "--selector".into(),
                sel,
                "--file".into(),
                tmp.clone(),
            ];
            read_back = Some(tmp);
        }
        "html" => {
            let sel = get("selector").unwrap_or_else(|| "html".into());
            let tmp = temp_artifact("html");
            sub = vec![
                "html".into(),
                "--selector".into(),
                sel,
                "--file".into(),
                tmp.clone(),
            ];
            read_back = Some(tmp);
        }
        "url" | "info" => sub = vec!["info".into()],
        "screenshot" => {
            let path = get("path").unwrap_or_else(|| "screenshot.png".into());
            run_browser_cli_autoconnect(
                cli,
                &["screenshot".to_string(), "--file".to_string(), path.clone()],
            )?;
            return Ok(format!("Saved screenshot to {path}"));
        }
        "eval" => {
            let code = get("code")
                .or_else(|| get("js"))
                .context("browser eval: 'code' (or 'js') is required")?;
            sub = vec!["eval".into(), "--code".into(), code];
        }
        // browser-use 스타일: 페이지의 클릭 가능/입력 가능 요소를 번호로 인덱싱해
        // 반환한다. 에이전트가 셀렉터를 몰라도 `click --x --y`로 번호의 좌표를
        // 눌러 조작할 수 있다. 각 요소: {n, tag, text, x, y}.
        "elements" | "snapshot" => {
            let js = r#"(() => {
  const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick],[tabindex]:not([tabindex="-1"])';
  const seen = new Set();
  const out = [];
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const key = Math.round(r.x)+','+Math.round(r.y)+','+e.tagName;
    if (seen.has(key)) continue; seen.add(key);
    const text = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim().replace(/\s+/g,' ').slice(0,70);
    out.push({ n: out.length, tag: e.tagName.toLowerCase(), type: e.type || '', text, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    if (out.length >= 120) break;
  }
  return JSON.stringify(out);
})()"#;
            sub = vec!["eval".into(), "--code".into(), js.into()];
        }
        "wait" | "waitfor" => {
            let sel = get("selector").unwrap_or_else(|| "body".into());
            sub = vec!["wait".into(), "--selector".into(), sel];
        }
        "box" => {
            let sel = get("selector").context("browser box: 'selector' is required")?;
            sub = vec!["box".into(), "--selector".into(), sel];
        }
        "wheel" | "scroll" => {
            let x = args.get("x").and_then(Value::as_i64).unwrap_or(400);
            let y = args.get("y").and_then(Value::as_i64).unwrap_or(300);
            let dy = args
                .get("deltaY")
                .or_else(|| args.get("dy"))
                .and_then(Value::as_i64)
                .unwrap_or(600);
            sub = vec![
                "wheel".into(),
                "--x".into(),
                x.to_string(),
                "--y".into(),
                y.to_string(),
                "--deltaY".into(),
                dy.to_string(),
            ];
        }
        "resize" => {
            let width = args.get("width").and_then(Value::as_i64).unwrap_or(1440);
            let height = args.get("height").and_then(Value::as_i64).unwrap_or(980);
            sub = vec![
                "resize".into(),
                "--width".into(),
                width.to_string(),
                "--height".into(),
                height.to_string(),
            ];
        }
        "switch_tab" | "close_tab" => {
            let id = get("id").context("browser switch_tab/close_tab: 'id' is required")?;
            sub = vec![action.replace('_', "-"), id];
        }
        "har" => {
            let path = get("path").unwrap_or_else(|| "browser.har".into());
            run_browser_cli_autoconnect(
                cli,
                &["har".to_string(), "--file".to_string(), path.clone()],
            )?;
            return Ok(format!(
                "Saved HAR to {path} (secrets redacted). Read it with the read tool or jq via bash."
            ));
        }
        "record" | "record-start" => {
            let fps = args
                .get("fps")
                .and_then(Value::as_i64)
                .map(|n| n.to_string())
                .or_else(|| get("fps"))
                .unwrap_or_else(|| "2".into());
            sub = vec!["record-start".into(), "--fps".into(), fps];
        }
        "record-stop" => {
            let path = get("path").unwrap_or_else(|| "browser-rec.mp4".into());
            let stdout = run_browser_cli_autoconnect(
                cli,
                &["record-stop".to_string(), "--file".to_string(), path],
            )?;
            // The CLI prints JSON with the resolved output path, frames, and mime.
            return Ok(stdout.chars().take(12000).collect());
        }
        // Passthrough: any other action is the raw CLI subcommand (tabs, back,
        // forward, reload, console, network, packets, packet, exchange,
        // composer, respond, breakpoint, security, cert, assert, fidelity,
        // doctor, cleanup, cdp, tree, terminal, guide …).
        other => {
            sub.push(other.to_string());
            if let Some(extra) = args.get("args").and_then(Value::as_array) {
                for value in extra {
                    if let Some(s) = value.as_str() {
                        sub.push(s.to_string());
                    }
                }
            }
        }
    }

    let stdout = run_browser_cli_autoconnect(cli, &sub)?;
    if let Some(file) = read_back {
        let content = std::fs::read_to_string(&file).unwrap_or(stdout);
        let _ = std::fs::remove_file(&file);
        return Ok(content.chars().take(12000).collect());
    }
    Ok(stdout.chars().take(12000).collect())
}

/// True when a failed CLI command should trigger an automatic `open` and one
/// retry: the command itself wasn't `open`, and the error says there is no
/// live browser session (the memorable "Browser is not available: iab").
fn should_autoconnect(first_sub: Option<&str>, error_text: &str) -> bool {
    if first_sub == Some("open") {
        return false;
    }
    let lowered = error_text.to_lowercase();
    [
        "not available",
        "no active browser",
        "no browser session",
        "browser is not open",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// Run a CLI command with open-first auto-connect: if it fails because no
/// BBARIT Browser session exists yet, open one and retry once.
/// A freshly opened session's Chrome renderer needs a moment to attach, so
/// "renderer is not connected" retries with a short wait instead of failing.
fn run_browser_cli_autoconnect(cli: &str, sub: &[String]) -> Result<String> {
    let mut last = match run_browser_cli(cli, sub) {
        Ok(output) => return Ok(output),
        Err(error) => error,
    };
    let text = format!("{last:#}");
    if should_autoconnect(sub.first().map(String::as_str), &text) {
        run_browser_cli(cli, &["open".to_string()]).context("auto-open BBARIT Browser session")?;
        match run_browser_cli(cli, sub) {
            Ok(output) => return Ok(output),
            Err(error) => last = error,
        }
    }
    // Renderer still attaching (right after open/app start): wait and retry.
    for _ in 0..2 {
        let text = format!("{last:#}").to_lowercase();
        if !text.contains("renderer is not connected") && !text.contains("connection is detached") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        match run_browser_cli(cli, sub) {
            Ok(output) => return Ok(output),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Run `node <cli> <sub...> --project <cwd>` and return stdout (or stderr on it).
fn run_browser_cli(cli: &str, sub: &[String]) -> Result<String> {
    use std::io::Read;
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut command = crate::spawn::node_command();
    command.arg(cli);
    for part in sub {
        command.arg(part);
    }
    command.arg("--project").arg(&cwd);
    command.env("BBARIT_BROWSER_SESSION", browser_session_id());
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .context("run BBARIT Browser CLI (is `node` on PATH?)")?;

    // Drain stdout/stderr on their own threads from the moment the child
    // starts. Reading only AFTER exit deadlocks: a child that writes more than
    // the OS pipe buffer (~64KB on Windows) before exiting blocks on write, so
    // it never exits, `try_wait` stays None, and the tool hangs to the deadline
    // with its output lost. (Same pattern orchestrator.rs already uses.)
    let stdout_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stderr_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let mut drainers = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let buf = std::sync::Arc::clone(&stdout_buf);
        drainers.push(std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            *buf.lock().unwrap() = s;
        }));
    }
    if let Some(mut err) = child.stderr.take() {
        let buf = std::sync::Arc::clone(&stderr_buf);
        drainers.push(std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            *buf.lock().unwrap() = s;
        }));
    }

    // Bounded wait: the FIRST call cold-starts the BBARIT Browser window and
    // attaches the native browser control runtime (~20-40s). Without a cap, a runtime that
    // never attaches would block the agent forever with no output — which reads
    // as "can't find the browser" / a frozen agent. 150s covers a slow cold
    // start; past that we kill and return an actionable error. Esc (cancel)
    // breaks out immediately so a wedged runtime isn't un-interruptible.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(150);
    let collect = |drainers: Vec<std::thread::JoinHandle<()>>| {
        for d in drainers {
            let _ = d.join();
        }
        (
            std::mem::take(&mut *stdout_buf.lock().unwrap()),
            std::mem::take(&mut *stderr_buf.lock().unwrap()),
        )
    };
    loop {
        if let Some(status) = child.try_wait()? {
            let (stdout, stderr) = collect(drainers);
            return finish_browser_cli(sub, status.success(), stdout, stderr);
        }
        if crate::commands::cancel_requested() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = collect(drainers);
            bail!("browser command cancelled");
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = collect(drainers);
            bail!(
                "BBARIT Browser did not respond within 150s (the browser window or its \
                 native WebView control runtime failed to start). The agent's `browser` tool drives the \
                 BBARIT Browser in this app — make sure the app window is open. Retry; if it \
                 keeps failing, the browser panel may need to be opened manually once."
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn finish_browser_cli(
    sub: &[String],
    success: bool,
    stdout: String,
    stderr: String,
) -> Result<String> {
    if !success {
        let detail = if stderr.trim().is_empty() {
            &stdout
        } else {
            &stderr
        };
        bail!(
            "BBARIT Browser CLI `{}` failed: {}",
            sub.first().map(String::as_str).unwrap_or(""),
            detail.trim()
        );
    }
    Ok(if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    })
}

fn temp_artifact(ext: &str) -> String {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir()
        .join(format!("bbarit-browser-{id}.{ext}"))
        .display()
        .to_string()
}

fn save_data_url(data_url: &str, path: &str) -> Result<()> {
    let base64 = data_url
        .split_once(',')
        .map(|(_, rest)| rest)
        .unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.trim())
        .context("decode screenshot data url")?;
    std::fs::write(path, bytes).with_context(|| format!("write {path}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extended_length_prefix_is_stripped_for_node() {
        // Installed builds hand the agent a canonicalized `\\?\C:\...` CLI path;
        // node crashes on it (EISDIR lstat 'C:'), so it must come out plain.
        assert_eq!(
            strip_extended_length_prefix(r"\\?\C:\Apps\BBARIT Terminal\_up_\cli.mjs"),
            r"C:\Apps\BBARIT Terminal\_up_\cli.mjs"
        );
        assert_eq!(
            strip_extended_length_prefix(r"\\?\UNC\server\share\cli.mjs"),
            r"\\server\share\cli.mjs"
        );
        // Plain paths pass through untouched.
        assert_eq!(
            strip_extended_length_prefix(r"C:\repo\cli.mjs"),
            r"C:\repo\cli.mjs"
        );
    }

    #[test]
    fn autoconnect_triggers_only_on_session_missing_errors() {
        // The known no-session failure retries with an auto-open…
        assert!(should_autoconnect(
            Some("screenshot"),
            "BBARIT Browser CLI `screenshot` failed: Browser is not available: iab"
        ));
        assert!(should_autoconnect(Some("read"), "No active browser window"));
        // …but `open` itself never loops, and unrelated errors pass through.
        assert!(!should_autoconnect(
            Some("open"),
            "Browser is not available: iab"
        ));
        assert!(!should_autoconnect(
            Some("click-selector"),
            "selector did not match any element"
        ));
        assert!(!should_autoconnect(Some("eval"), ""));
    }

    #[test]
    fn browser_session_prefers_explicit_agent_ids() {
        let session = browser_session_from_values(
            [
                ("BBARIT_BROWSER_SESSION", Some("")),
                ("BBARIT_AGENT_SESSION", Some("agent-session-1")),
                ("CODEX_SESSION_ID", Some("codex-session")),
            ],
            "/tmp/project",
        );
        assert_eq!(session, "agent-session-1");
    }

    #[test]
    fn browser_session_falls_back_to_stable_process_scope() {
        let empty: [(&str, Option<&str>); 0] = [];
        let one = browser_session_from_values(empty, "/tmp/project");
        let two = browser_session_from_values(empty, "/tmp/project");
        let other = browser_session_from_values(empty, "/tmp/other");
        assert_eq!(one, two);
        assert_ne!(one, other);
        assert!(one.starts_with("bbarit-agent-"));
    }

    #[test]
    fn browser_cli_is_found_by_walking_ancestors() {
        let root = std::env::temp_dir().join("bbarit-browser-cli-find");
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("agent-browser-cli").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let cli = bin.join("bbarit-browser-control.mjs");
        std::fs::write(&cli, "// stub").unwrap();
        // From a nested project dir, the walk finds the vendored CLI…
        let nested = root.join("apps").join("web");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            find_browser_cli_from(&nested),
            Some(cli.display().to_string())
        );
        // …and from an unrelated tree it finds nothing (temp dir has no CLI).
        let lonely = std::env::temp_dir().join("bbarit-browser-cli-none");
        std::fs::create_dir_all(&lonely).unwrap();
        assert_eq!(find_browser_cli_from(&lonely), None);
    }

    #[test]
    fn native_browser_open_does_not_pass_removed_chrome_mode() {
        let root = std::env::temp_dir().join(format!(
            "bbarit-browser-cli-args-{}",
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cli = root.join("fake-browser-cli.mjs");
        std::fs::write(&cli, "console.log(JSON.stringify(process.argv.slice(2)))\n").unwrap();

        let output = route_via_bbarit_browser(
            &cli.display().to_string(),
            &json!({"action": "open", "url": "https://example.com"}),
        )
        .unwrap();
        let args: Vec<String> = serde_json::from_str(output.trim()).unwrap();

        assert!(args.starts_with(&[
            "open".to_string(),
            "--url".to_string(),
            "https://example.com".to_string(),
        ]));
        assert!(!args.iter().any(|arg| arg == "--chrome"));
        assert!(!args.iter().any(|arg| arg == "hidden"));
        assert!(args.iter().any(|arg| arg == "--project"));
    }

    #[test]
    fn native_browser_read_maps_through_cli_and_reads_file_output() {
        let root = std::env::temp_dir().join(format!(
            "bbarit-browser-cli-read-{}",
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cli = root.join("fake-browser-cli.mjs");
        std::fs::write(
            &cli,
            r#"import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
writeFileSync(file, JSON.stringify(args));
console.log('wrote file');
"#,
        )
        .unwrap();

        let output = route_via_bbarit_browser(
            &cli.display().to_string(),
            &json!({"action": "read", "selector": "#result"}),
        )
        .unwrap();
        let args: Vec<String> = serde_json::from_str(output.trim()).unwrap();

        assert!(args.starts_with(&[
            "text".to_string(),
            "--selector".to_string(),
            "#result".to_string(),
            "--file".to_string(),
        ]));
        assert!(args.iter().any(|arg| arg == "--project"));
        assert!(args.iter().all(|arg| arg != "--chrome" && arg != "hidden"));
    }

    #[test]
    fn native_browser_key_passes_exactly_one_named_key() {
        let root = std::env::temp_dir().join(format!(
            "bbarit-browser-cli-key-{}",
            NEXT_ID.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let cli = root.join("fake-browser-cli.mjs");
        std::fs::write(&cli, "console.log(JSON.stringify(process.argv.slice(2)))\n").unwrap();

        let output = route_via_bbarit_browser(
            &cli.display().to_string(),
            &json!({"action": "key", "key": "Enter"}),
        )
        .unwrap();
        let args: Vec<String> = serde_json::from_str(output.trim()).unwrap();

        assert!(args.starts_with(&["key".to_string(), "--key".to_string(), "Enter".to_string(),]));
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "Enter").count(), 1);
    }
}
