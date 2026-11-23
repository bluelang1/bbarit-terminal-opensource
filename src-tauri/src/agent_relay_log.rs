//! Agent relay audit log: `~/.config/octo/agent-relay.log`, one JSON object per line
//! (run / run_refused / send / stop / exit). Entries are built by the frontend
//! (src/terminal/agentRelayLog.ts) and only carry ids, names, CLI types, depth,
//! worktree/branch and a 120-character text head — never environment or tokens.
//! The file is created 0600 on unix; when an append would push it past 1 MiB it is
//! renamed to `agent-relay.log.1` (replacing the old one) and a fresh file is started.
//! Design: docs/superpowers/specs/2026-11-16-agent-limits-and-log-design.md

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const LOG_FILE: &str = "agent-relay.log";
pub const ROTATED_FILE: &str = "agent-relay.log.1";
/// Rotate before the file would grow past this size.
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// One entry larger than this is dropped (entries are small; this bounds abuse).
pub const MAX_ENTRY_BYTES: usize = 8 * 1024;
pub const DEFAULT_TAIL: usize = 20;
pub const MAX_TAIL: usize = 500;
/// `tail_lines` reads at most this many bytes from the end of each file, even when the
/// file grew larger than the rotation size (written by something else, or by hand).
pub const MAX_READ_BYTES: u64 = 1024 * 1024;

/// Serialises appends + rotation across the async command threads.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_dir() -> Option<PathBuf> {
    crate::config_file_path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

#[cfg(unix)]
fn open_append(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    // A file created by someone else (or before this code) may be wider than 0600.
    if let Ok(meta) = file.metadata() {
        if meta.permissions().mode() & 0o077 != 0 {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_append(path: &Path) -> io::Result<fs::File> {
    OpenOptions::new().create(true).append(true).open(path)
}

/// Append one entry (must be a JSON object) as a single line to `<dir>/agent-relay.log`.
pub fn append_entry(dir: &Path, entry: &serde_json::Value) -> io::Result<()> {
    if !entry.is_object() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "entry must be a JSON object"));
    }
    // serde_json escapes control characters, so the line never contains a raw newline.
    let mut line = serde_json::to_string(entry)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    if line.len() > MAX_ENTRY_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "entry too large"));
    }
    line.push('\n');
    let _guard = LOG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > 0 && size + line.len() as u64 > MAX_LOG_BYTES {
        fs::rename(&path, dir.join(ROTATED_FILE))?;
    }
    let mut file = open_append(&path)?;
    file.write_all(line.as_bytes())
}

fn non_empty_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// The last `max_bytes` of a file as text: invalid UTF-8 is replaced (lossy), and when the
/// read starts mid-file the first (cut) line is dropped. Missing / unreadable → "".
pub fn read_file_tail(path: &Path, max_bytes: u64) -> String {
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.take(max_bytes).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    if start > 0 {
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => {
                buf.drain(..=i);
            }
            None => return String::new(),
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// The last `n` lines (1..=500), oldest first; reaches into the rotated file when the
/// current one has fewer. Reads at most the last 1 MiB of each file; invalid UTF-8 is
/// replaced. Missing files give an empty list.
pub fn tail_lines(dir: &Path, n: usize) -> Vec<String> {
    tail_lines_bounded(dir, n, MAX_READ_BYTES)
}

fn tail_lines_bounded(dir: &Path, n: usize, max_bytes: u64) -> Vec<String> {
    let n = n.clamp(1, MAX_TAIL);
    let read = |name: &str| non_empty_lines(&read_file_tail(&dir.join(name), max_bytes));
    let mut lines = read(LOG_FILE);
    if lines.len() < n {
        let mut older = read(ROTATED_FILE);
        older.append(&mut lines);
        lines = older;
    }
    let skip = lines.len().saturating_sub(n);
    lines.split_off(skip)
}

/// Fire-and-forget from the relay: errors are swallowed (logging never fails a relay action).
#[tauri::command(async)]
pub fn agent_relay_log_append(entry: serde_json::Value) {
    if let Some(dir) = log_dir() {
        let _ = append_entry(&dir, &entry);
    }
}

/// Last `lines` log lines (default 20, max 500), raw JSON strings, oldest first.
#[tauri::command(async)]
pub fn agent_relay_log_tail(lines: Option<usize>) -> Vec<String> {
    match log_dir() {
        Some(dir) => tail_lines(&dir, lines.unwrap_or(DEFAULT_TAIL)),
        None => Vec::new(),
    }
}

/// The limits `agent run` refuses on (src/terminal/agentLimits.ts `AgentLimitName`).
const LIMIT_NAMES: [&str; 3] = ["maxChildren", "maxDepth", "maxTotal"];
pub const DEFAULT_REFUSALS: usize = 20;
pub const MAX_REFUSALS: usize = 100;

/// One `run_refused` line of the relay log as the Team status view shows it: time (unix ms),
/// the limit, the calling tab and the counts. Never the prompt head or the error text.
/// Lines that are not JSON, not a limit refusal, or carry no readable time are skipped.
pub fn parse_refusal(line: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("event")?.as_str()? != "run_refused" {
        return None;
    }
    let limit = v.get("reason")?.as_str()?;
    if !LIMIT_NAMES.contains(&limit) {
        return None;
    }
    let ts = chrono::DateTime::parse_from_rfc3339(v.get("ts")?.as_str()?).ok()?.timestamp_millis();
    let mut out = serde_json::json!({ "ts": ts, "limit": limit });
    let small = |key: &str| v.get(key).and_then(serde_json::Value::as_i64).filter(|n| (0..=10_000).contains(n));
    if let Some(n) = small("count") {
        out["count"] = n.into();
    }
    if let Some(n) = small("max") {
        out["max"] = n.into();
    }
    let text = |p: &serde_json::Value, key: &str, max: usize| -> Option<String> {
        let s: String = p.get(key)?.as_str()?.chars().filter(|c| !c.is_control()).take(max).collect();
        Some(s).filter(|s| !s.trim().is_empty())
    };
    if let Some(caller) = v.get("caller").filter(|c| c.is_object()) {
        let mut c = serde_json::json!({});
        if let Some(id) = text(caller, "id", 128) {
            c["id"] = id.into();
        }
        if let Some(name) = text(caller, "name", 80) {
            c["name"] = name.into();
        }
        if c.as_object().is_some_and(|o| !o.is_empty()) {
            out["caller"] = c;
        }
    }
    Some(out)
}

/// The last `n` limit refusals (1..=100) among the last 500 log lines, oldest first.
pub fn recent_refusals(dir: &Path, n: usize) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = tail_lines(dir, MAX_TAIL).iter().filter_map(|l| parse_refusal(l)).collect();
    let skip = out.len().saturating_sub(n.clamp(1, MAX_REFUSALS));
    out.split_off(skip)
}

/// Team status view: recent `agent run` limit refusals (read only; not an `agent.*` command).
#[tauri::command(async)]
pub fn agent_relay_log_refusals(limit: Option<usize>) -> Vec<serde_json::Value> {
    match log_dir() {
        Some(dir) => recent_refusals(&dir, limit.unwrap_or(DEFAULT_REFUSALS)),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn refusals_keep_time_limit_caller_and_counts_but_never_text() {
        let line = json!({
            "ts": "2026-11-17T05:02:03.004Z", "event": "run_refused",
            "caller": { "id": "t1", "name": "lead\u{1b}[31m", "cliType": "claude" }, "depth": 1,
            "textLen": 40, "textHead": "secret prompt head",
            "reason": "maxChildren", "count": 6, "max": 6, "error": "child limit reached: …",
        })
        .to_string();
        let r = parse_refusal(&line).unwrap();
        assert_eq!(r["ts"], 1_794_891_723_004i64);
        assert_eq!(r["limit"], "maxChildren");
        assert_eq!(r["count"], 6);
        assert_eq!(r["max"], 6);
        assert_eq!(r["caller"]["id"], "t1");
        assert_eq!(r["caller"]["name"], "lead[31m");
        let s = r.to_string();
        assert!(!s.contains("secret") && !s.contains("child limit") && !s.contains("textHead"), "{s}");
    }

    #[test]
    fn refusal_parser_skips_other_events_bad_limits_bad_times_and_junk() {
        let ok = |reason: &str, ts: &str| json!({ "ts": ts, "event": "run_refused", "reason": reason }).to_string();
        assert!(parse_refusal(&ok("maxTotal", "2026-11-17T05:02:03Z")).is_some());
        assert!(parse_refusal(&ok("maxDepth", "2026-11-17T05:02:03+09:00")).is_some());
        assert!(parse_refusal(&ok("worktree", "2026-11-17T05:02:03Z")).is_none());
        assert!(parse_refusal(&ok("maxTotal", "yesterday")).is_none());
        assert!(parse_refusal(&json!({ "ts": "2026-11-17T05:02:03Z", "event": "run", "reason": "maxTotal" }).to_string()).is_none());
        assert!(parse_refusal("not json").is_none());
        assert!(parse_refusal("[1,2]").is_none());
        let r = parse_refusal(&json!({ "ts": "2026-11-17T05:02:03Z", "event": "run_refused", "reason": "maxTotal", "count": -1, "caller": { "id": "" } }).to_string()).unwrap();
        assert!(r.get("count").is_none() && r.get("caller").is_none(), "{r}");
    }

    #[test]
    fn recent_refusals_returns_the_last_n_oldest_first() {
        let dir = temp_dir("refusals");
        for i in 0..5 {
            append_entry(&dir, &json!({ "ts": format!("2026-11-17T05:0{i}:00Z"), "event": "run_refused", "reason": "maxTotal", "count": i })).unwrap();
            append_entry(&dir, &json!({ "ts": "2026-11-17T05:00:00Z", "event": "send" })).unwrap();
        }
        let r = recent_refusals(&dir, 3);
        assert_eq!(r.iter().map(|v| v["count"].as_i64().unwrap()).collect::<Vec<_>>(), vec![2, 3, 4]);
        assert!(recent_refusals(&temp_dir("refusals-none"), 3).is_empty());
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bbarit-relay-log-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn appends_one_json_line_per_entry_and_tails_them() {
        let dir = temp_dir("append");
        append_entry(&dir, &json!({"event": "run", "textHead": "a\nb"})).unwrap();
        append_entry(&dir, &json!({"event": "send"})).unwrap();
        append_entry(&dir, &json!({"event": "exit"})).unwrap();
        let text = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(text.lines().count(), 3, "{text}");
        let first: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(first["textHead"], "a\nb");
        let tail = tail_lines(&dir, 2);
        assert_eq!(tail.len(), 2);
        assert!(tail[0].contains("\"send\"") && tail[1].contains("\"exit\""));
        assert_eq!(tail_lines(&dir, 0).len(), 1, "n is clamped to at least 1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_objects_and_oversized_entries() {
        let dir = temp_dir("reject");
        assert!(append_entry(&dir, &json!("text")).is_err());
        assert!(append_entry(&dir, &json!({"textHead": "x".repeat(MAX_ENTRY_BYTES)})).is_err());
        assert!(tail_lines(&dir, 20).is_empty(), "missing file → empty");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_file_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(LOG_FILE), "").unwrap();
        fs::set_permissions(dir.join(LOG_FILE), fs::Permissions::from_mode(0o644)).unwrap();
        append_entry(&dir, &json!({"event": "run"})).unwrap();
        let mode = fs::metadata(dir.join(LOG_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let fresh = temp_dir("mode-fresh");
        append_entry(&fresh, &json!({"event": "run"})).unwrap();
        let mode = fs::metadata(fresh.join(LOG_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&fresh);
    }

    #[test]
    fn tail_tolerates_invalid_utf8() {
        let dir = temp_dir("utf8");
        fs::create_dir_all(&dir).unwrap();
        let mut bytes = b"{\"event\":\"run\"}\n".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe, b'x', b'\n']);
        bytes.extend_from_slice(b"{\"event\":\"exit\"}\n");
        fs::write(dir.join(LOG_FILE), &bytes).unwrap();
        let tail = tail_lines(&dir, 20);
        assert_eq!(tail.len(), 3, "{tail:?}");
        assert!(tail[0].contains("\"run\""));
        assert!(tail[1].contains('\u{FFFD}'));
        assert!(tail[2].contains("\"exit\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_reads_only_the_end_of_an_oversized_file() {
        let dir = temp_dir("bounded");
        fs::create_dir_all(&dir).unwrap();
        // 3 MiB file (larger than the rotation size, e.g. written by something else).
        let line = format!("{}\n", json!({"event": "send", "textHead": "q".repeat(1000)}));
        let mut text = String::from("{\"event\":\"oldest\"}\n");
        while text.len() < 3 * MAX_READ_BYTES as usize {
            text.push_str(&line);
        }
        text.push_str("{\"event\":\"newest\"}\n");
        fs::write(dir.join(LOG_FILE), &text).unwrap();
        let tail = tail_lines(&dir, MAX_TAIL);
        assert!(tail.last().unwrap().contains("newest"));
        assert!(tail.iter().all(|l| !l.contains("oldest")));
        assert!(tail.iter().all(|l| l.starts_with('{') && l.ends_with('}')), "no cut first line");
        // Directly: only the last bytes are read and the cut line is dropped.
        let cut = read_file_tail(&dir.join(LOG_FILE), 30);
        assert_eq!(cut, "{\"event\":\"newest\"}\n");
        let small = tail_lines_bounded(&dir, MAX_TAIL, 3 * line.len() as u64);
        assert_eq!(small.len(), 3, "{small:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_past_one_mib_and_tail_reaches_into_the_old_file() {
        let dir = temp_dir("rotate");
        fs::create_dir_all(&dir).unwrap();
        // Pre-fill close to the limit with valid lines.
        let filler = format!("{}\n", json!({"event": "send", "textHead": "y".repeat(1000)}));
        let count = MAX_LOG_BYTES as usize / filler.len();
        let mut text = String::new();
        for _ in 0..count {
            text.push_str(&filler);
        }
        fs::write(dir.join(LOG_FILE), &text).unwrap();
        fs::write(dir.join(ROTATED_FILE), "old\n").unwrap();
        append_entry(&dir, &json!({"event": "run", "textHead": "z".repeat(1000)})).unwrap();
        let rotated = fs::read_to_string(dir.join(ROTATED_FILE)).unwrap();
        assert_eq!(rotated, text, "the full file replaced the previous .1");
        let current = fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert_eq!(current.lines().count(), 1);
        assert!(current.contains("\"run\""));
        assert!(fs::metadata(dir.join(LOG_FILE)).unwrap().len() <= MAX_LOG_BYTES);
        let tail = tail_lines(&dir, 3);
        assert_eq!(tail.len(), 3);
        assert!(tail[0].contains("\"send\"") && tail[2].contains("\"run\""));
        assert_eq!(tail_lines(&dir, 10_000).len(), MAX_TAIL);
        let _ = fs::remove_dir_all(&dir);
    }
}
