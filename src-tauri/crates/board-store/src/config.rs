//! Where the team board lives: `agents.board` in config.json (usage type and PostgreSQL
//! connection fields), the password file and the `BBARIT_BOARD_DATABASE_URL` override. Pure
//! functions (no I/O except the secret file helpers, which take their path), so the rules are
//! unit-tested. Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md
//! ("Configuration", "Usage types and sync").
//!
//! Never log or return a password or a URL that may contain one: every error that can carry
//! connection text goes through `redact`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(feature = "pg")]
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::path::Path;
#[cfg(feature = "pg")]
use std::str::FromStr;

/// The local board file in the app's config directory.
pub const DB_FILE: &str = if cfg!(debug_assertions) { "agent-board.dev.db" } else { "agent-board.db" };
pub const SECRET_FILE: &str = if cfg!(debug_assertions) { "agent-board.dev.secret" } else { "agent-board.secret" };
pub const URL_ENV: &str = "BBARIT_BOARD_DATABASE_URL";
pub const DEFAULT_SCHEMA: &str = "bbarit_board";
pub const DEFAULT_PORT: u16 = 5432;
pub const SSL_MODES: [&str; 6] = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"];
pub const MAX_PASSWORD_CHARS: usize = 1024;
/// Every PostgreSQL session of the board: a statement never runs longer than this.
pub const STATEMENT_TIMEOUT_MS: u64 = 5000;
pub const CONNECT_TIMEOUT_SECS: u64 = 5;

// ── Usage type ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardMode {
    /// One local SQLite file (default).
    Sqlite,
    /// Local SQLite file plus a sync worker to PostgreSQL (stage 3b; until then = SQLite).
    Sync,
    /// Commands read and write the PostgreSQL server directly.
    Postgres,
}

impl BoardMode {
    pub fn as_str(self) -> &'static str {
        match self {
            BoardMode::Sqlite => "sqlite",
            BoardMode::Sync => "sync",
            BoardMode::Postgres => "postgres",
        }
    }
}

/// The usage type and, when the setting could not be used, why (shown in Settings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeChoice {
    pub mode: BoardMode,
    pub warning: Option<String>,
}

/// `agents.board.mode` (`sqlite` | `sync` | `postgres`); when it is missing or empty the
/// older `backend` key (`sqlite` | `postgres`) is read as the same-named mode. Anything else
/// is SQLite with a warning (never a silent switch to a server).
pub fn parse_mode(board: Option<&Value>) -> ModeChoice {
    let read = |key: &str| {
        board
            .and_then(|b| b.get(key))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
    };
    let ok = |mode| ModeChoice { mode, warning: None };
    if let Some(m) = read("mode") {
        return match m.as_str() {
            "sqlite" => ok(BoardMode::Sqlite),
            "sync" => ok(BoardMode::Sync),
            "postgres" | "postgresql" => ok(BoardMode::Postgres),
            other => ModeChoice {
                mode: BoardMode::Sqlite,
                warning: Some(format!("unknown agents.board.mode \"{}\": using sqlite", short(other))),
            },
        };
    }
    if let Some(b) = read("backend") {
        return match b.as_str() {
            "sqlite" => ok(BoardMode::Sqlite),
            "postgres" | "postgresql" => ok(BoardMode::Postgres),
            other => ModeChoice {
                mode: BoardMode::Sqlite,
                warning: Some(format!("unknown agents.board.backend \"{}\": using sqlite", short(other))),
            },
        };
    }
    ok(BoardMode::Sqlite)
}

fn short(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(40).collect()
}

// ── PostgreSQL settings ──────────────────────────────────────────────────

/// `agents.board.postgres` (no password; that lives in the secret file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PgSettings {
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub user: String,
    #[serde(default = "default_ssl")]
    pub ssl_mode: String,
    #[serde(default = "default_schema")]
    pub schema: String,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_ssl() -> String {
    "prefer".into()
}
fn default_schema() -> String {
    DEFAULT_SCHEMA.into()
}

impl Default for PgSettings {
    fn default() -> Self {
        PgSettings {
            host: String::new(),
            port: DEFAULT_PORT,
            database: String::new(),
            user: String::new(),
            ssl_mode: default_ssl(),
            schema: default_schema(),
        }
    }
}

impl PgSettings {
    /// Lenient read of `agents.board.postgres`: wrong types fall back to the defaults, the
    /// port may be a number or a numeric string, text is trimmed.
    pub fn from_board(board: Option<&Value>) -> PgSettings {
        let pg = board.and_then(|b| b.get("postgres"));
        let text = |key: &str| pg.and_then(|p| p.get(key)).and_then(Value::as_str).map(|s| s.trim().to_string());
        let port = pg
            .and_then(|p| p.get("port"))
            .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
            .and_then(|n| u16::try_from(n).ok())
            .unwrap_or(DEFAULT_PORT);
        let mut s = PgSettings {
            host: text("host").unwrap_or_default(),
            port,
            database: text("database").unwrap_or_default(),
            user: text("user").unwrap_or_default(),
            ssl_mode: text("sslMode").filter(|v| !v.is_empty()).unwrap_or_else(default_ssl),
            schema: text("schema").filter(|v| !v.is_empty()).unwrap_or_else(default_schema),
        };
        s.ssl_mode = s.ssl_mode.to_ascii_lowercase();
        s
    }

    /// What is missing or wrong, in one message; Ok when a connection can be attempted.
    pub fn check(&self) -> Result<(), String> {
        let mut missing = Vec::new();
        if self.host.is_empty() {
            missing.push("host");
        }
        if self.database.is_empty() {
            missing.push("database");
        }
        if self.user.is_empty() {
            missing.push("user");
        }
        if !missing.is_empty() {
            return Err(format!("PostgreSQL is not configured: {} missing (Settings → Agent team board)", missing.join(", ")));
        }
        if self.port == 0 {
            return Err("PostgreSQL port must be 1-65535".to_string());
        }
        #[cfg(feature = "pg")]
        ssl_mode(&self.ssl_mode)?;
        #[cfg(not(feature = "pg"))]
        if !SSL_MODES.contains(&self.ssl_mode.trim()) {
            return Err(format!("invalid SSL mode: {} ({})", short(&self.ssl_mode), SSL_MODES.join("|")));
        }
        check_schema_name(&self.schema)
    }

    /// `user@host:port/database` (never a password), for status lines.
    pub fn label(&self) -> String {
        format!("{}@{}:{}/{}", self.user, self.host, self.port, self.database)
    }
}

#[cfg(feature = "pg")]
pub fn ssl_mode(raw: &str) -> Result<PgSslMode, String> {
    PgSslMode::from_str(raw.trim()).map_err(|_| format!("invalid SSL mode: {} ({})", short(raw), SSL_MODES.join("|")))
}

/// A PostgreSQL schema the board may use: `[a-z_][a-z0-9_]{0,62}`, not `pg_*` (reserved by
/// PostgreSQL) and not `information_schema`. It is still quoted wherever it appears in SQL.
pub fn valid_schema_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && (b[0].is_ascii_lowercase() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
        && !name.starts_with("pg_")
        && name != "information_schema"
}

pub fn check_schema_name(name: &str) -> Result<(), String> {
    if valid_schema_name(name) {
        Ok(())
    } else {
        Err(format!(
            "invalid schema name: {} (1-63 characters of a-z 0-9 _, starting with a letter or _, not pg_… or information_schema)",
            short(name)
        ))
    }
}

/// `"name"` — only for names that passed `valid_schema_name`.
pub fn quote_ident(name: &str) -> String {
    debug_assert!(valid_schema_name(name));
    format!("\"{name}\"")
}

// ── Password ─────────────────────────────────────────────────────────────

/// A password the secret file accepts: 1..=1024 characters on one line, no NUL.
pub fn check_password(pw: &str) -> Result<(), String> {
    if pw.is_empty() {
        return Err("password required".to_string());
    }
    if pw.chars().count() > MAX_PASSWORD_CHARS {
        return Err(format!("password too long (max {MAX_PASSWORD_CHARS} characters)"));
    }
    if pw.contains(['\n', '\r', '\0']) {
        return Err("the password must be one line".to_string());
    }
    Ok(())
}

/// The saved password and the server it was saved for (`user@host:port/database`).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret {
    pub password: String,
    pub label: Option<String>,
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Secret").field("label", &self.label).finish()
    }
}

/// The saved password (first line) and its server (second line), or None.
pub fn read_secret(path: &Path) -> Option<Secret> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let password = lines.next().unwrap_or("").to_string();
    if password.is_empty() {
        return None;
    }
    let label = lines.next().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string);
    Some(Secret { password, label })
}

/// Write the password and the server it is for, owner-only (0600): a new temp file (random
/// name) in the same directory, then a rename over the old one, so the file is never readable
/// by others even for a moment.
pub fn write_secret(path: &Path, pw: &str, label: &str) -> Result<(), String> {
    check_password(pw)?;
    if label.is_empty() || label.contains(['\n', '\r']) {
        return Err("the password needs the server it is for (host, port, database, user)".to_string());
    }
    let dir = path.parent().ok_or_else(|| "no directory for the password file".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.{}-{:016x}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("secret"),
        std::process::id(),
        rand::random::<u64>()
    ));
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp).map_err(|e| format!("cannot write the password file: {e}"))?;
        let body = format!("{pw}\n{label}\n");
        f.write_all(body.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("cannot write the password file: {e}")
        })?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save the password file: {e}")
    })
}

/// Remove the password file; Ok(false) when there was none.
pub fn clear_secret(path: &Path) -> Result<bool, String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("cannot remove the password file: {e}")),
    }
}

// ── Redaction ────────────────────────────────────────────────────────────

/// Remove secrets from a message before it is shown, logged or returned: every
/// `scheme://user:password@` user-info part becomes `scheme://***@`, `password=…` becomes
/// `password=***`, and each known secret (the saved password, the override URL) is replaced
/// by `***` wherever it appears (secrets shorter than 4 characters only through the first two
/// rules, so a short password does not blank out ordinary words).
pub fn redact(msg: &str, secrets: &[&str]) -> String {
    let mut out = msg.to_string();
    for s in secrets {
        if s.chars().count() >= 4 {
            out = out.replace(s, "***");
            let enc = urlencoding::encode(s).into_owned();
            if enc != *s {
                out = out.replace(&enc, "***");
            }
        }
    }
    out = redact_userinfo(&out);
    redact_password_pairs(&out)
}

fn redact_userinfo(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut rest = msg;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        // The authority ends at '/', '?', '#', whitespace or a quote.
        let end = tail.find(|c: char| matches!(c, '/' | '?' | '#' | '"' | '\'' | '`' | '>' | ')') || c.is_whitespace()).unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                out.push_str("***");
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn redact_password_pairs(msg: &str) -> String {
    let lower = msg.to_ascii_lowercase();
    let mut out = String::with_capacity(msg.len());
    let mut i = 0;
    while let Some(pos) = lower[i..].find("password=") {
        let start = i + pos + "password=".len();
        out.push_str(&msg[i..start]);
        let end = msg[start..].find(|c: char| c.is_whitespace() || c == '&' || c == ';' || c == '"' || c == '\'').map(|e| start + e).unwrap_or(msg.len());
        if end > start {
            out.push_str("***");
        }
        i = end;
    }
    out.push_str(&msg[i..]);
    out
}

// ── Connection ───────────────────────────────────────────────────────────

#[cfg(feature = "pg")]
/// Where a PostgreSQL board lives: connection options (may hold the password; never
/// printed), the schema and the secrets every error from it must be scrubbed of.
#[derive(Clone)]
pub struct PgTarget {
    pub opts: PgConnectOptions,
    pub schema: String,
    /// `user@host:port/database` or "BBARIT_BOARD_DATABASE_URL" — safe to show.
    pub label: String,
    pub from_env: bool,
    pub secrets: Vec<String>,
    /// The server host (or socket directory), for the "TLS off on a remote host" warning.
    pub host: String,
}

#[cfg(feature = "pg")]
impl std::fmt::Debug for PgTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgTarget").field("schema", &self.schema).field("label", &self.label).field("from_env", &self.from_env).finish()
    }
}

/// localhost, 127.x, ::1 or a Unix socket directory: plain text there never leaves the machine.
pub fn is_loopback(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    h.is_empty() || h == "localhost" || h.starts_with("127.") || h == "::1" || h.starts_with('/')
}

#[cfg(feature = "pg")]
impl PgTarget {
    pub fn redact(&self, msg: &str) -> String {
        let s: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        redact(msg, &s)
    }
}

#[cfg(feature = "pg")]
fn session_options(opts: PgConnectOptions) -> PgConnectOptions {
    let timeout = STATEMENT_TIMEOUT_MS.to_string();
    opts.application_name("bbarit-board").options([("statement_timeout", timeout.as_str())])
}

#[cfg(feature = "pg")]
/// The board's PostgreSQL target: `BBARIT_BOARD_DATABASE_URL` when set (it replaces the
/// connection fields and the saved password; the schema still comes from the settings), else
/// the settings plus the saved password — only when it was saved for this same server
/// (`user@host:port/database`), so editing the host never sends one server's password to another.
pub fn pg_target(settings: &PgSettings, env_url: Option<&str>, secret: Option<&Secret>) -> Result<PgTarget, String> {
    check_schema_name(&settings.schema)?;
    if let Some(url) = env_url.map(str::trim).filter(|u| !u.is_empty()) {
        let mut secrets = vec![url.to_string()];
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("postgres://") || lower.starts_with("postgresql://")) {
            return Err(format!("{URL_ENV} must start with postgres:// or postgresql://"));
        }
        let opts = PgConnectOptions::from_str(url)
            .map_err(|e| format!("{URL_ENV} is not a valid PostgreSQL URL: {}", redact(&e.to_string(), &[url])))?;
        if let Some(pw) = url_password(url) {
            secrets.push(pw);
        }
        let host = opts.get_host().to_string();
        return Ok(PgTarget { opts: session_options(opts), schema: settings.schema.clone(), label: URL_ENV.to_string(), from_env: true, secrets, host });
    }
    settings.check()?;
    let label = settings.label();
    let mut opts = PgConnectOptions::new()
        .host(&settings.host)
        .port(settings.port)
        .database(&settings.database)
        .username(&settings.user)
        .ssl_mode(ssl_mode(&settings.ssl_mode)?);
    let mut secrets = Vec::new();
    if let Some(sec) = secret.filter(|s| !s.password.is_empty()) {
        if sec.label.as_deref() != Some(label.as_str()) {
            return Err(format!(
                "the saved password is for {}, not {label}: re-enter the password for this server",
                sec.label.as_deref().unwrap_or("another server")
            ));
        }
        opts = opts.password(&sec.password);
        secrets.push(sec.password.clone());
    }
    Ok(PgTarget { opts: session_options(opts), schema: settings.schema.clone(), label, from_env: false, secrets, host: settings.host.clone() })
}

/// The password part of `scheme://user:password@host…` (percent-decoded), if any.
pub fn url_password(url: &str) -> Option<String> {
    let rest = &url[url.find("://")? + 3..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    let userinfo = &authority[..authority.rfind('@')?];
    let pw = &userinfo[userinfo.find(':')? + 1..];
    if pw.is_empty() {
        return None;
    }
    Some(urlencoding::decode(pw).map(|c| c.into_owned()).unwrap_or_else(|_| pw.to_string()))
}

#[cfg(all(test, feature = "pg"))]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mode_reads_mode_then_the_backend_alias() {
        let m = |v: Value| parse_mode(Some(&v));
        assert_eq!(parse_mode(None).mode, BoardMode::Sqlite);
        assert_eq!(m(json!({})).mode, BoardMode::Sqlite);
        assert_eq!(m(json!({ "mode": "sync" })).mode, BoardMode::Sync);
        assert_eq!(m(json!({ "mode": " Postgres " })).mode, BoardMode::Postgres);
        assert_eq!(m(json!({ "backend": "postgres" })).mode, BoardMode::Postgres, "backend is read as the same-named mode");
        assert_eq!(m(json!({ "backend": "sqlite" })).mode, BoardMode::Sqlite);
        assert_eq!(m(json!({ "mode": "sqlite", "backend": "postgres" })).mode, BoardMode::Sqlite, "mode wins over backend");
        assert_eq!(m(json!({ "mode": "", "backend": "postgres" })).mode, BoardMode::Postgres, "an empty mode falls back to backend");
        let bad = m(json!({ "mode": "mongo" }));
        assert_eq!(bad.mode, BoardMode::Sqlite, "never a silent switch to a server");
        assert!(bad.warning.unwrap().contains("unknown agents.board.mode"));
        let bad = m(json!({ "backend": "sync" }));
        assert_eq!(bad.mode, BoardMode::Sqlite, "sync is a mode, not a backend");
        assert!(bad.warning.is_some());
        assert_eq!(m(json!({ "mode": 3 })).mode, BoardMode::Sqlite);
    }

    #[test]
    fn schema_names_are_plain_identifiers() {
        for ok in ["bbarit_board", "_x", "a", "team1", &"a".repeat(63)] {
            assert!(valid_schema_name(ok), "{ok}");
        }
        for bad in ["", "1abc", "Board", "a-b", "a b", "a\"b", "a;drop", "pg_catalog", "pg_x", "information_schema", &"a".repeat(64), "ä"] {
            assert!(!valid_schema_name(bad), "{bad:?}");
        }
        assert_eq!(quote_ident("bbarit_board"), "\"bbarit_board\"");
        assert!(check_schema_name("x;y").unwrap_err().starts_with("invalid schema name"));
    }

    #[test]
    fn settings_are_read_leniently_and_checked() {
        let s = PgSettings::from_board(Some(&json!({ "postgres": { "host": " db.local ", "port": "6543", "database": "team", "user": "u", "sslMode": "REQUIRE" } })));
        assert_eq!((s.host.as_str(), s.port, s.ssl_mode.as_str(), s.schema.as_str()), ("db.local", 6543, "require", DEFAULT_SCHEMA));
        assert!(s.check().is_ok());
        assert_eq!(s.label(), "u@db.local:6543/team");
        let empty = PgSettings::from_board(None);
        assert_eq!(empty.port, DEFAULT_PORT);
        assert!(empty.check().unwrap_err().contains("host, database, user missing"));
        let bad_ssl = PgSettings { ssl_mode: "maybe".into(), ..s.clone() };
        assert!(bad_ssl.check().unwrap_err().starts_with("invalid SSL mode"));
        let bad_schema = PgSettings { schema: "Bad".into(), ..s.clone() };
        assert!(bad_schema.check().unwrap_err().starts_with("invalid schema name"));
        let bad_port = PgSettings::from_board(Some(&json!({ "postgres": { "port": 70000 } })));
        assert_eq!(bad_port.port, DEFAULT_PORT);
    }

    #[test]
    fn redaction_removes_passwords_and_url_userinfo() {
        let url = "postgres://board:test-pass-1@db.local:5432/team?sslmode=require";
        let msg = format!("error connecting to {url}: password authentication failed; password=test-pass-1 rest");
        let out = redact(&msg, &[url, "test-pass-1"]);
        assert!(!out.contains("test-pass-1"), "{out}");
        assert!(!out.contains("board:"), "{out}");
        assert!(out.contains("authentication failed"), "{out}");
        // Unknown URLs are still scrubbed by shape.
        let other = redact("see postgresql://u:s3cr3t@h/db and http://example.invalid/x", &[]);
        assert_eq!(other, "see postgresql://***@h/db and http://example.invalid/x");
        assert_eq!(redact("password=abc def", &[]), "password=*** def");
        // A percent-encoded password inside a URL.
        let out = redact("postgres://u:p%40ss%3Aword@h/db", &["p@ss:word"]);
        assert!(!out.contains("p%40ss"), "{out}");
        // Short secrets do not blank out ordinary text.
        assert_eq!(redact("a connection error", &["a"]), "a connection error");
        assert_eq!(url_password("postgres://u:p%40ss@h:1/db").as_deref(), Some("p@ss"));
        assert_eq!(url_password("postgres://u@h/db"), None);
    }

    #[test]
    fn target_prefers_the_environment_url_and_never_shows_secrets() {
        let s = PgSettings { host: "h".into(), database: "d".into(), user: "u".into(), ..PgSettings::default() };
        let sec = Secret { password: "test".into(), label: Some("u@h:5432/d".into()) };
        let t = pg_target(&s, None, Some(&sec)).unwrap();
        // The password is only sent to the server it was saved for.
        let other = PgSettings { host: "elsewhere".into(), ..s.clone() };
        let e = pg_target(&other, None, Some(&sec)).unwrap_err();
        assert_eq!(e, "the saved password is for u@h:5432/d, not u@elsewhere:5432/d: re-enter the password for this server");
        assert!(pg_target(&other, None, None).is_ok(), "no saved password: connect without one");
        assert!(pg_target(&s, None, Some(&Secret { label: None, ..sec.clone() })).is_err(), "a password without a server is not used");
        assert!(is_loopback("localhost") && is_loopback("127.0.0.1") && is_loopback("::1") && is_loopback("/tmp"));
        assert!(!is_loopback("db.example.com") && !is_loopback("10.0.0.5"));
        assert_eq!(t.label, "u@h:5432/d");
        assert!(!t.from_env);
        assert!(!format!("{t:?}").contains("test"));
        let env = pg_target(&s, Some("postgres://x:test-env-pw@e:1/db"), Some(&sec)).unwrap();
        assert_eq!(env.host, "e");
        assert!(env.from_env);
        assert_eq!(env.label, URL_ENV);
        assert_eq!(env.schema, DEFAULT_SCHEMA);
        assert!(env.secrets.contains(&"test-env-pw".to_string()));
        assert!(!env.redact("bad postgres://x:test-env-pw@e:1/db").contains("test-env-pw"));
        let err = pg_target(&s, Some("mysql://nope:test-env-pw@x"), None).unwrap_err();
        assert!(!err.contains("test-env-pw"), "{err}");
        let unset = pg_target(&PgSettings::default(), None, None).unwrap_err();
        assert!(unset.contains("not configured"));
    }

    #[test]
    fn the_secret_file_is_owner_only_and_one_line() {
        let dir = std::env::temp_dir().join(format!("bbarit-secret-{}-{}", std::process::id(), super::super::now_ms()));
        let path = dir.join(SECRET_FILE);
        assert_eq!(read_secret(&path), None);
        write_secret(&path, "test", "u@h:1/d").unwrap();
        assert_eq!(read_secret(&path), Some(Secret { password: "test".into(), label: Some("u@h:1/d".into()) }));
        assert!(!format!("{:?}", read_secret(&path)).contains("test\""), "Debug never shows the password");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        write_secret(&path, "test-2", "u@h:1/d").unwrap();
        assert_eq!(read_secret(&path).unwrap().password, "test-2", "replaced");
        assert!(write_secret(&path, "a\nb", "u@h:1/d").is_err());
        assert!(write_secret(&path, "", "u@h:1/d").is_err());
        assert!(write_secret(&path, "x", "").is_err());
        assert_eq!(clear_secret(&path), Ok(true));
        assert_eq!(clear_secret(&path), Ok(false));
        let leftovers: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert!(leftovers.is_empty(), "no temp files left");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(SECRET_FILE, "agent-board.dev.secret", "tests are debug builds");
    }
}
