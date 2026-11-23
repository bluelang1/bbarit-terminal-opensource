//! Agent relay caller tokens. Every tab PTY gets `BBARIT_TERM_TOKEN` =
//! hex(HMAC-SHA256(key, terminal_id)) truncated to 32 hex characters; `agent.*` requests
//! from bbarit-ctl carry it next to `caller`, and the app checks it with
//! `agent_caller_verify` before trusting the caller id. The token is a function of the
//! terminal id and a per-user key, so it survives app restarts and PTY-holder reattach
//! without a stored map.
//!
//! The key file (`~/.config/octo/agent-relay.key`; debug builds `agent-relay.dev.key`, so a
//! dev run never touches the installed app's key) holds two lines: 32 random bytes as 64 hex
//! characters, and the creation time in unix ms (0 = unknown). It is created on first use
//! with mode 0600 on unix, under a lock file so two app instances never end up with
//! different keys. A valid key is never rewritten; a malformed one is replaced with
//! creation time 0, which grants no `legacy` pass. The key is never logged and no command
//! returns it or a token. This stops a tab from claiming to be another tab by flag or env
//! var; it is not a boundary against a hostile process of the same user (it can read the
//! key file).
//! Design: docs/superpowers/specs/2026-11-16-agent-caller-verification-design.md

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Release and debug builds keep separate keys (like the PTY holder's `.dev` files).
pub const KEY_FILE: &str = if cfg!(debug_assertions) { "agent-relay.dev.key" } else { "agent-relay.key" };
pub const TOKEN_ENV: &str = "BBARIT_TERM_TOKEN";
const KEY_BYTES: usize = 32;
/// Bytes of the HMAC kept in the token (32 hex characters).
const TOKEN_BYTES: usize = 16;
/// Longer terminal ids are not tokens' business (ids are short uuids / `term-…`).
const MAX_ID_LEN: usize = 256;
/// Waiting for another instance that is creating the key.
const LOCK_ATTEMPTS: u32 = 100;
const LOCK_RETRY: Duration = Duration::from_millis(20);
/// A lock file older than this was left by a crashed instance.
const STALE_LOCK: Duration = Duration::from_secs(10);

type HmacSha256 = Hmac<Sha256>;

/// What the key file holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyRecord {
    pub key: [u8; KEY_BYTES],
    /// Unix ms when this key was created; 0 when unknown (a replaced malformed key).
    pub created_ms: u64,
}

/// The key, read or created once per app run (a failure is retried on the next call).
static KEY: Mutex<Option<KeyRecord>> = Mutex::new(None);

fn key_dir() -> Option<PathBuf> {
    crate::config_file_path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.as_bytes();
    if text.len() % 2 != 0 {
        return None;
    }
    let nibble = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    text.chunks(2)
        .map(|pair| Some(nibble(pair[0])? << 4 | nibble(pair[1])?))
        .collect()
}

fn format_record(rec: &KeyRecord) -> String {
    format!("{}\n{}\n", to_hex(&rec.key), rec.created_ms)
}

/// Exactly two non-empty lines: 64 hex characters, then the creation time (unix ms).
fn parse_record(text: &str) -> Option<KeyRecord> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let [hex, created] = lines.as_slice() else {
        return None;
    };
    let bytes = from_hex(hex).filter(|b| b.len() == KEY_BYTES)?;
    let created_ms = created.parse::<u64>().ok()?;
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&bytes);
    Some(KeyRecord { key, created_ms })
}

#[cfg(unix)]
fn create_owner_only(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn create_owner_only(path: &Path) -> io::Result<fs::File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(unix)]
fn tighten_mode(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().mode() & 0o077 != 0 {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
fn tighten_mode(_path: &Path) {}

/// `Ok(None)` when the file does not exist; `InvalidData` when it is malformed.
fn read_record(path: &Path) -> io::Result<Option<KeyRecord>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let rec = parse_record(&text)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed agent relay key"))?;
    tighten_mode(path);
    Ok(Some(rec))
}

/// Write `rec` to a fresh 0600 temp file and rename it over `path` (atomic for readers).
/// Only called while holding the key lock.
fn write_record(dir: &Path, path: &Path, rec: &KeyRecord) -> io::Result<()> {
    let tmp = dir.join(format!(".{KEY_FILE}.{}.{}.tmp", std::process::id(), now_ms()));
    let written = create_owner_only(&tmp).and_then(|mut file| {
        file.write_all(format_record(rec).as_bytes())?;
        file.sync_all()
    });
    let placed = written.and_then(|_| fs::rename(&tmp, path));
    if placed.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    placed
}

/// Run `f` while holding `<dir>/.<KEY_FILE>.lock` (created exclusively). Another instance
/// holding it is waited for (up to ~2 s); a lock older than 10 s is taken over.
fn with_key_lock<T>(dir: &Path, f: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let lock = dir.join(format!(".{KEY_FILE}.lock"));
    let mut acquired = false;
    for _ in 0..LOCK_ATTEMPTS {
        match create_owner_only(&lock) {
            Ok(_) => {
                acquired = true;
                break;
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > STALE_LOCK);
                if stale {
                    let _ = fs::remove_file(&lock);
                    continue;
                }
                std::thread::sleep(LOCK_RETRY);
            }
            Err(e) => return Err(e),
        }
    }
    if !acquired {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "agent relay key is locked"));
    }
    let result = f();
    let _ = fs::remove_file(&lock);
    result
}

/// The key in `<dir>/<KEY_FILE>`. A valid file is used as is (never rewritten). A missing
/// one is created (creation time = now) and a malformed one replaced (creation time 0: no
/// shell can be proven older than it), both under the lock and re-read from disk afterwards,
/// so every instance ends up with what is on disk.
pub fn load_or_create_key(dir: &Path) -> io::Result<KeyRecord> {
    let path = dir.join(KEY_FILE);
    match read_record(&path) {
        Ok(Some(rec)) => return Ok(rec),
        Ok(None) => {}
        Err(e) if e.kind() == io::ErrorKind::InvalidData => {}
        Err(e) => return Err(e),
    }
    fs::create_dir_all(dir)?;
    with_key_lock(dir, || {
        // Another instance may have created or replaced it while we waited.
        let created_ms = match read_record(&path) {
            Ok(Some(rec)) => return Ok(rec),
            Ok(None) => now_ms(),
            Err(e) if e.kind() == io::ErrorKind::InvalidData => 0,
            Err(e) => return Err(e),
        };
        let mut key = [0u8; KEY_BYTES];
        rand::rngs::OsRng.fill_bytes(&mut key);
        write_record(dir, &path, &KeyRecord { key, created_ms })?;
        read_record(&path)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "agent relay key vanished"))
    })
}

fn mac_for(key: &[u8; KEY_BYTES], terminal_id: &str) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(terminal_id.as_bytes());
    mac
}

/// `BBARIT_TERM_TOKEN` for one terminal id: 32 hex characters.
pub fn token_for(key: &[u8; KEY_BYTES], terminal_id: &str) -> String {
    let tag = mac_for(key, terminal_id).finalize().into_bytes();
    to_hex(&tag[..TOKEN_BYTES])
}

/// Constant-time check of `token` against the terminal id (HMAC verify on the left bytes).
pub fn verify_token(key: &[u8; KEY_BYTES], terminal_id: &str, token: &str) -> bool {
    if terminal_id.is_empty() || terminal_id.len() > MAX_ID_LEN {
        return false;
    }
    let token = token.trim();
    if token.len() != TOKEN_BYTES * 2 {
        return false;
    }
    let Some(bytes) = from_hex(token) else {
        return false;
    };
    mac_for(key, terminal_id).verify_truncated_left(&bytes).is_ok()
}

fn cached() -> Option<KeyRecord> {
    let mut slot = KEY.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(rec) = *slot {
        return Some(rec);
    }
    let rec = load_or_create_key(&key_dir()?).ok()?;
    *slot = Some(rec);
    Some(rec)
}

/// Token for a new tab PTY (create_shell). None when the key cannot be read or created:
/// the tab then has no token and its `agent.*` calls with a caller are refused.
pub fn term_token(terminal_id: &str) -> Option<String> {
    if terminal_id.is_empty() || terminal_id.len() > MAX_ID_LEN {
        return None;
    }
    cached().map(|rec| token_for(&rec.key, terminal_id))
}

/// True when `token` is the `BBARIT_TERM_TOKEN` of `terminal_id`. Never returns the token.
#[tauri::command(async)]
pub fn agent_caller_verify(terminal_id: String, token: String) -> bool {
    match cached() {
        Some(rec) => verify_token(&rec.key, terminal_id.trim(), &token),
        None => false,
    }
}

/// `{ available, sinceMs, file }` for src/terminal/agentCaller.ts (no secret): whether the
/// key could be read or created, and since when (unix ms, null when unknown) shells carry a
/// token. A PTY-holder shell started before `sinceMs` was started by an older app and has
/// none (`legacy`). Creates the key when missing, like the other entry points.
#[tauri::command(async)]
pub fn agent_caller_key_info() -> serde_json::Value {
    let rec = cached();
    serde_json::json!({
        "available": rec.is_some(),
        "sinceMs": rec.map(|r| r.created_ms).filter(|ms| *ms > 0),
        "file": KEY_FILE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bbarit-caller-key-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn debug_builds_use_their_own_key_file() {
        assert_eq!(KEY_FILE, "agent-relay.dev.key", "tests are debug builds");
    }

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        // RFC 4231 test case 2 (key "Jefe"), checked through the same Hmac<Sha256> type.
        let mut mac = HmacSha256::new_from_slice(b"Jefe").unwrap();
        mac.update(b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&mac.finalize().into_bytes()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn tokens_are_deterministic_per_id_and_key() {
        let key = [7u8; KEY_BYTES];
        let a = token_for(&key, "term-1");
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, token_for(&key, "term-1"), "same id + key → same token (restart, reattach)");
        assert_ne!(a, token_for(&key, "term-2"));
        assert_ne!(a, token_for(&[8u8; KEY_BYTES], "term-1"));
    }

    #[test]
    fn verify_accepts_only_the_matching_token() {
        let key = [3u8; KEY_BYTES];
        let token = token_for(&key, "t1");
        assert!(verify_token(&key, "t1", &token));
        assert!(verify_token(&key, "t1", &format!(" {} ", token.to_uppercase())));
        assert!(!verify_token(&key, "t2", &token), "another tab's token");
        assert!(!verify_token(&[4u8; KEY_BYTES], "t1", &token), "another key");
        let mut flipped = token.clone().into_bytes();
        flipped[31] = if flipped[31] == b'0' { b'1' } else { b'0' };
        assert!(!verify_token(&key, "t1", std::str::from_utf8(&flipped).unwrap()));
        assert!(!verify_token(&key, "t1", ""));
        assert!(!verify_token(&key, "t1", &token[..30]));
        assert!(!verify_token(&key, "t1", &format!("{token}00")));
        assert!(!verify_token(&key, "t1", &"zz".repeat(16)));
        assert!(!verify_token(&key, "", &token_for(&key, "")));
        let long = "x".repeat(MAX_ID_LEN + 1);
        assert!(!verify_token(&key, &long, &token_for(&key, &long)));
    }

    #[test]
    fn record_format_round_trips_and_rejects_anything_else() {
        let rec = KeyRecord { key: [0xab; KEY_BYTES], created_ms: 1_793_000_000_123 };
        assert_eq!(parse_record(&format_record(&rec)), Some(rec));
        let hex = to_hex(&[1u8; KEY_BYTES]);
        assert_eq!(parse_record(&hex), None, "old one-line format: no creation time");
        assert_eq!(parse_record(&format!("{hex}\nsoon\n")), None);
        assert_eq!(parse_record(&format!("{hex}\n1\n2\n")), None);
        assert_eq!(parse_record(&format!("{}\n1\n", &hex[..62])), None);
        assert_eq!(parse_record(&format!("{hex}\n0\n")).map(|r| r.created_ms), Some(0));
    }

    #[test]
    fn key_is_created_once_with_its_creation_time_and_reused() {
        let dir = temp_dir("create");
        let before = now_ms();
        let first = load_or_create_key(&dir).unwrap();
        let second = load_or_create_key(&dir).unwrap();
        assert_eq!(first, second, "the key on disk is reused");
        assert!(first.created_ms >= before && first.created_ms <= now_ms());
        let text = fs::read_to_string(dir.join(KEY_FILE)).unwrap();
        assert_eq!(text, format_record(&first));
        assert_eq!(files_in(&dir), vec![KEY_FILE.to_string()], "no temp or lock file left");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creation_time_comes_from_the_file_not_its_mtime() {
        let dir = temp_dir("mtime");
        let rec = load_or_create_key(&dir).unwrap();
        // Touch the file far into the future: the recorded time does not move.
        let file = OpenOptions::new().write(true).open(dir.join(KEY_FILE)).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(86_400)).unwrap();
        drop(file);
        assert_eq!(load_or_create_key(&dir).unwrap(), rec);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_key_is_replaced_with_an_unknown_creation_time() {
        let dir = temp_dir("malformed");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(KEY_FILE), "not a key\n").unwrap();
        let rec = load_or_create_key(&dir).unwrap();
        assert_eq!(rec.created_ms, 0, "a rewrite must not make older token shells look legacy");
        assert_eq!(fs::read_to_string(dir.join(KEY_FILE)).unwrap(), format_record(&rec));
        assert_eq!(load_or_create_key(&dir).unwrap(), rec, "then it is a valid key, kept");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_instances_end_up_with_the_same_key() {
        for (tag, seed) in [("race-missing", None), ("race-malformed", Some("broken\n"))] {
            let dir = temp_dir(tag);
            fs::create_dir_all(&dir).unwrap();
            if let Some(text) = seed {
                fs::write(dir.join(KEY_FILE), text).unwrap();
            }
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let dir = dir.clone();
                    std::thread::spawn(move || load_or_create_key(&dir).unwrap())
                })
                .collect();
            let recs: Vec<KeyRecord> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            assert!(recs.iter().all(|r| *r == recs[0]), "{tag}: every instance has the same key");
            assert_eq!(read_record(&dir.join(KEY_FILE)).unwrap(), Some(recs[0]), "{tag}: = disk");
            assert_eq!(files_in(&dir), vec![KEY_FILE.to_string()], "{tag}: no leftovers");
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_stale_lock_is_taken_over_and_a_live_one_times_out() {
        let dir = temp_dir("lock");
        fs::create_dir_all(&dir).unwrap();
        let lock = dir.join(format!(".{KEY_FILE}.lock"));
        fs::write(&lock, "").unwrap();
        let file = OpenOptions::new().write(true).open(&lock).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60)).unwrap();
        drop(file);
        assert!(load_or_create_key(&dir).is_ok(), "crashed instance's lock is taken over");
        assert!(!lock.exists());
        fs::remove_file(dir.join(KEY_FILE)).unwrap();
        fs::write(&lock, "").unwrap();
        let err = load_or_create_key(&dir).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut, "a live lock is waited for, then gives up");
        assert!(!dir.join(KEY_FILE).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        load_or_create_key(&dir).unwrap();
        let mode = fs::metadata(dir.join(KEY_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        fs::set_permissions(dir.join(KEY_FILE), fs::Permissions::from_mode(0o644)).unwrap();
        load_or_create_key(&dir).unwrap();
        let mode = fs::metadata(dir.join(KEY_FILE)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a wider key file is tightened on read");
        let _ = fs::remove_dir_all(&dir);
    }
}
