//! Engine-independent parts of the team board: limits, text cleaning, request types, actors
//! and the task state machine (who may do what, from which state). Both stores (SQLite now,
//! PostgreSQL in stage 3) call these, so the rules live in one place and the stores only hold
//! SQL. Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md

use serde::Deserialize;
use std::collections::BTreeMap;

// ── Limits ───────────────────────────────────────────────────────────────

pub const MAX_TEXT_CHARS: usize = 2000;
pub const MAX_TEXT_LINES: usize = 40;
pub const MAX_TEAM_ID_LEN: usize = 128;
pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_READ_LIMIT: i64 = 500;
pub const DEFAULT_READ_LIMIT: i64 = 20;
pub const MAX_SEARCH_CHARS: usize = 200;
pub const MAX_TEAMS_LISTED: i64 = 500;
pub const STALE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Newest announcements pinned above a plain `board read`.
pub const PINNED_ANNOUNCEMENTS: i64 = 3;

pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 8000;
pub const MAX_BODY_LINES: usize = 400;
pub const MAX_REASON_CHARS: usize = 2000;
pub const MAX_SUMMARY_CHARS: usize = 500;
pub const MAX_BRANCH_CHARS: usize = 200;
pub const MAX_COMMIT_CHARS: usize = 64;
pub const MAX_WORKTREE_CHARS: usize = 1000;
pub const MAX_LABELS: usize = 10;
pub const MAX_LABEL_CHARS: usize = 40;
pub const MAX_ARTIFACTS: usize = 20;
pub const MAX_ARTIFACT_KEY_CHARS: usize = 40;
pub const MAX_ARTIFACT_VALUE_CHARS: usize = 1000;
pub const MAX_DEPS_PER_TASK: usize = 32;
/// Deepest dependency chain walked by the cycle check.
pub const MAX_DEP_DEPTH: usize = 64;
pub const DEFAULT_MAX_ATTEMPTS: i64 = 3;
pub const MAX_MAX_ATTEMPTS: i64 = 10;
pub const DEFAULT_PRIORITY: i64 = 1;
pub const MAX_PRIORITY: i64 = 3;
pub const DEFAULT_LIST_LIMIT: i64 = 50;
pub const MAX_LIST_LIMIT: i64 = 500;
pub const MAX_HISTORY: i64 = 500;

/// Lease bounds (config `agents.board.leaseSeconds`, clamped here too).
pub const DEFAULT_LEASE_MS: i64 = 300_000;
pub const MIN_LEASE_MS: i64 = 30_000;
pub const MAX_LEASE_MS: i64 = 3_600_000;
pub const DEFAULT_STALE_MS: i64 = 30 * 60 * 1000;

/// Per-team caps on live rows, and the bound of the local change log while no sync worker
/// consumes it; tests use smaller ones.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub posts: i64,
    pub tasks: i64,
    pub events: i64,
    pub changes: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { posts: 5000, tasks: 2000, events: 20_000, changes: 50_000 }
    }
}

/// Tombstones (`deleted_at`) older than this are removed for good at app start.
pub const TOMBSTONE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// A new row id: UUIDv7 text (36 characters), ordered by creation time within this process.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// This machine's stable host id for `*_host` / `origin_host` / `home_host`: the
/// `BBARIT_BOARD_HOST` override when set (tests, several app copies on one machine), else the
/// host name; one line, at most 120 characters, `localhost` when nothing is usable.
pub fn host_id(env_override: Option<&str>, hostname: &str) -> String {
    clean_label(env_override.filter(|v| !v.trim().is_empty()), 120)
        .or_else(|| clean_label(Some(hostname), 120))
        .unwrap_or_else(|| "localhost".to_string())
}

/// Refusal for any write on a team another machine owns (sync home rule).
pub fn read_only_message(home: &str) -> String {
    format!("this team lives on {home}; it is read-only here")
}

pub const POST_KINDS: [&str; 6] = ["note", "finding", "question", "decision", "done", "announce"];
pub const TASK_STATES: [&str; 7] = ["open", "claimed", "blocked", "review", "done", "failed", "cancelled"];
pub const CHECKS: [&str; 3] = ["passed", "failed", "none"];

/// Tasks that still need someone: never pruned.
pub fn is_live(state: &str) -> bool {
    matches!(state, "open" | "claimed" | "blocked" | "review")
}

/// A tab holds these (lease applies).
pub fn is_held(state: &str) -> bool {
    matches!(state, "claimed" | "blocked")
}

pub fn unavailable(e: impl std::fmt::Display) -> String {
    format!("team board unavailable: {e}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Text ─────────────────────────────────────────────────────────────────

/// Team ids are relay tab ids: 1..=128 characters of `[A-Za-z0-9_-]`.
pub fn valid_team_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_TEAM_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn check_team(team: &str) -> Result<(), String> {
    if valid_team_id(team) {
        Ok(())
    } else {
        Err("invalid team id (expected 1-128 characters of A-Z a-z 0-9 _ -)".to_string())
    }
}

/// Unicode format characters (general category Cf): soft hyphen, zero-width characters,
/// bidi marks/overrides/isolates, word joiners, BOM, tag characters, …. They are invisible,
/// so `<\u{200B}bbarit` would look like a relay tag and slip past a plain-text check.
pub fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2
        | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F
        | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// Multi-line text: CR LF → LF, control characters other than LF and Unicode format characters
/// removed (tab → space), trimmed; then 1..=`max_chars` characters and at most `max_lines`
/// lines. `field` names the value in errors ("text too long: …"). The frontend strips escape
/// sequences and defuses `<bbarit` first (agentBoard.ts); this is the store's own guard.
pub fn clean_multiline(raw: &str, field: &str, max_chars: usize, max_lines: usize) -> Result<String, String> {
    let unified = raw.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned: String = unified
        .chars()
        .filter_map(|c| match c {
            '\n' => Some('\n'),
            '\t' => Some(' '),
            c if c.is_control() || is_format_char(c) => None,
            c => Some(c),
        })
        .collect();
    let text = cleaned.trim().to_string();
    if text.is_empty() {
        return Err(format!("{field} required"));
    }
    let chars = text.chars().count();
    if chars > max_chars {
        return Err(format!("{field} too long: {chars} characters (max {max_chars})"));
    }
    let lines = text.split('\n').count();
    if lines > max_lines {
        return Err(format!("{field} has too many lines: {lines} (max {max_lines})"));
    }
    Ok(text)
}

/// Post text: 1..=2000 characters, at most 40 lines.
pub fn clean_text(raw: &str) -> Result<String, String> {
    clean_multiline(raw, "text", MAX_TEXT_CHARS, MAX_TEXT_LINES)
}

/// A name or id shown on the board: one line, no control characters, at most `max` chars.
pub fn clean_label(raw: Option<&str>, max: usize) -> Option<String> {
    let flat: String = raw?
        .chars()
        .filter(|c| !is_format_char(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        None
    } else {
        Some(flat.chars().take(max).collect())
    }
}

/// One-line required text (title, summary): refused when longer than `max`, never cut.
pub fn clean_line(raw: &str, field: &str, max: usize) -> Result<String, String> {
    let line = clean_label(Some(raw), usize::MAX).ok_or_else(|| format!("{field} required"))?;
    let chars = line.chars().count();
    if chars > max {
        return Err(format!("{field} too long: {chars} characters (max {max})"));
    }
    Ok(line)
}

/// Optional one-line value (branch, commit, worktree): empty → None, too long → error.
pub fn clean_opt_line(raw: Option<&str>, field: &str, max: usize) -> Result<Option<String>, String> {
    match clean_label(raw, usize::MAX) {
        None => Ok(None),
        Some(v) if v.chars().count() > max => Err(format!("{field} too long (max {max} characters)")),
        Some(v) => Ok(Some(v)),
    }
}

/// `%`, `_` and the escape character itself are matched literally (`LIKE ? ESCAPE '\'`).
pub fn like_pattern(needle: &str) -> String {
    let mut out = String::with_capacity(needle.len() + 2);
    out.push('%');
    for c in needle.chars() {
        if c == '\\' || c == '%' || c == '_' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

pub fn non_empty(v: &Option<String>) -> Option<String> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

pub fn clean_labels(raw: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for l in raw {
        let Some(v) = clean_label(Some(l), usize::MAX) else { continue };
        if v.chars().count() > MAX_LABEL_CHARS {
            return Err(format!("label too long: {v} (max {MAX_LABEL_CHARS} characters)"));
        }
        if !out.contains(&v) {
            out.push(v);
        }
    }
    if out.len() > MAX_LABELS {
        return Err(format!("too many labels: {} (max {MAX_LABELS})", out.len()));
    }
    Ok(out)
}

// ── Requests ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostInput {
    #[serde(default)]
    pub team_name: Option<String>,
    pub author_id: String,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub author_cli: Option<String>,
    pub kind: String,
    pub text: String,
    /// Link to a task of the same team (its `#seq`).
    #[serde(default)]
    pub task: Option<i64>,
    /// The author is the team's root tab (only it may post `announce`).
    #[serde(default)]
    pub root: bool,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadQuery {
    /// Only posts with a seq above this.
    #[serde(default)]
    pub since: Option<i64>,
    /// The last N matching posts (1..=500, default 20).
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub kind: Option<String>,
    /// A tab id, or an author name (case-insensitive).
    #[serde(default)]
    pub author: Option<String>,
    /// Substring of the text (LIKE, ASCII case-insensitive; % and _ match literally).
    #[serde(default)]
    pub search: Option<String>,
    /// Leave out this author's posts (`--new` leaves out the reader's own).
    #[serde(default)]
    pub exclude_author: Option<String>,
    /// `--new`: unread posts after this tab's cursor, oldest first (no kind/author/search/
    /// since filter); the cursor moves only past what was returned.
    #[serde(default)]
    pub cursor_tab: Option<String>,
}

/// Error for `--new` combined with a filter: the cursor could skip posts the filter hid.
pub const NEW_WITH_FILTER_ERROR: &str =
    "--new cannot be combined with --kind, --author, --search or --since (a filter would move the read cursor past posts it hid)";

/// Who acts. `root`: the team's root tab; `human`: a person in the app (author "user").
/// The command layer decides both (the App knows the relay links); the store checks the
/// transition rules against them.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub cli: Option<String>,
    #[serde(default)]
    pub root: bool,
    #[serde(default)]
    pub human: bool,
}

#[derive(Debug, Clone)]
pub struct Actor {
    pub id: String,
    pub name: Option<String>,
    pub cli: Option<String>,
    pub host: Option<String>,
    pub root: bool,
    pub human: bool,
}

impl Actor {
    pub fn from_input(input: &ActorInput, host: Option<&str>) -> Result<Actor, String> {
        let id = if input.human {
            "user".to_string()
        } else {
            clean_label(Some(&input.id), 256).ok_or_else(|| "actor required".to_string())?
        };
        Ok(Actor {
            id,
            name: clean_label(input.name.as_deref(), MAX_NAME_CHARS).or_else(|| input.human.then(|| "user".to_string())),
            cli: clean_label(input.cli.as_deref(), 40),
            host: clean_label(host, 120),
            root: input.root,
            human: input.human,
        })
    }

    /// The app itself (lease expiry, auto-release).
    pub fn app(host: Option<&str>) -> Actor {
        Actor { id: "app".into(), name: Some("app".into()), cli: None, host: clean_label(host, 120), root: false, human: false }
    }

    fn privileged(&self) -> bool {
        self.root || self.human
    }
}

/// Where the call comes from: time, this machine and this app instance (random per start).
#[derive(Debug, Clone)]
pub struct Ctx {
    pub now: i64,
    pub host: Option<String>,
    pub instance: String,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultInput {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub checks: Option<String>,
    #[serde(default)]
    pub artifacts: BTreeMap<String, String>,
}

/// A checked completion record.
#[derive(Debug, Clone, Default)]
pub struct TaskResult {
    pub summary: String,
    pub body: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub worktree: Option<String>,
    pub checks: Option<String>,
    pub artifacts: Option<String>,
}

impl TaskResult {
    pub fn check(input: &ResultInput) -> Result<TaskResult, String> {
        let summary = clean_line(input.summary.as_deref().unwrap_or(""), "summary", MAX_SUMMARY_CHARS)
            .map_err(|e| if e == "summary required" { "summary required (--summary \"<one line>\")".to_string() } else { e })?;
        let body = match input.body.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(b) => Some(clean_multiline(b, "result body", MAX_BODY_CHARS, MAX_BODY_LINES)?),
            None => None,
        };
        let checks = match non_empty(&input.checks).map(|c| c.to_ascii_lowercase()) {
            Some(c) if CHECKS.contains(&c.as_str()) => Some(c),
            Some(c) => return Err(format!("invalid checks: {c} ({})", CHECKS.join("|"))),
            None => None,
        };
        if input.artifacts.len() > MAX_ARTIFACTS {
            return Err(format!("too many artifacts: {} (max {MAX_ARTIFACTS})", input.artifacts.len()));
        }
        let mut artifacts = serde_json::Map::new();
        for (k, v) in &input.artifacts {
            let key = k.trim();
            if key.is_empty()
                || key.chars().count() > MAX_ARTIFACT_KEY_CHARS
                || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            {
                return Err(format!("invalid artifact key: {key} (1-{MAX_ARTIFACT_KEY_CHARS} of A-Z a-z 0-9 _ - .)"));
            }
            let value = clean_opt_line(Some(v), "artifact value", MAX_ARTIFACT_VALUE_CHARS)?
                .ok_or_else(|| format!("artifact {key} has no value"))?;
            artifacts.insert(key.to_string(), serde_json::Value::String(value));
        }
        Ok(TaskResult {
            summary,
            body,
            branch: clean_opt_line(input.branch.as_deref(), "branch", MAX_BRANCH_CHARS)?,
            commit: clean_opt_line(input.commit.as_deref(), "commit", MAX_COMMIT_CHARS)?,
            worktree: clean_opt_line(input.worktree.as_deref(), "worktree", MAX_WORKTREE_CHARS)?,
            checks,
            artifacts: if artifacts.is_empty() { None } else { Some(serde_json::Value::Object(artifacts).to_string()) },
        })
    }
}

/// One task write (`agent task <op>`). `task`, `parent`, `after`, `on` are team `#seq` numbers.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOpInput {
    pub op: String,
    #[serde(default)]
    pub team_name: Option<String>,
    #[serde(default)]
    pub task: Option<i64>,
    /// claim: the best ready task (priority, then lowest number).
    #[serde(default)]
    pub next: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub parent: Option<i64>,
    #[serde(default)]
    pub after: Vec<i64>,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub review: Option<bool>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub max_attempts: Option<i64>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub result: Option<ResultInput>,
    /// dep add/rm: the task `task` depends on.
    #[serde(default)]
    pub on: Option<i64>,
    #[serde(default)]
    pub lease_ms: Option<i64>,
    /// edit: refuse when the task changed since this version (viewer edits).
    #[serde(default)]
    pub expected_version: Option<i64>,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListQuery {
    /// Stored states and the derived `waiting`, `ready`, `stale`. Empty: every live state + failed.
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub all: bool,
    /// Only tasks owned by this tab id.
    #[serde(default)]
    pub mine: Option<String>,
    /// Only open tasks whose dependencies are all done.
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub stale_ms: Option<i64>,
}

/// Team activity for the viewer (`agent_board_team_events`): the newest task events of every
/// task of a team. Not an `agent.*` command.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    /// At most this many events (1..=1000, default 200), the newest ones.
    #[serde(default)]
    pub limit: Option<i64>,
    /// Only events after this time (unix ms).
    #[serde(default)]
    pub since: Option<i64>,
}

pub const DEFAULT_TEAM_EVENTS: i64 = 200;
pub const MAX_TEAM_EVENTS: i64 = 1000;

impl EventsQuery {
    /// (limit, since) with the limit clamped and a missing `since` as "everything".
    pub fn check(&self) -> (i64, i64) {
        (self.limit.unwrap_or(DEFAULT_TEAM_EVENTS).clamp(1, MAX_TEAM_EVENTS), self.since.unwrap_or(i64::MIN))
    }
}

pub fn lease_ms(raw: Option<i64>) -> i64 {
    raw.unwrap_or(DEFAULT_LEASE_MS).clamp(MIN_LEASE_MS, MAX_LEASE_MS)
}

pub fn stale_ms(raw: Option<i64>) -> i64 {
    raw.unwrap_or(DEFAULT_STALE_MS).clamp(60_000, 7 * 24 * 60 * 60 * 1000)
}

// ── State machine ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Claim,
    Block,
    Unblock,
    Release,
    Done,
    Submit,
    Approve,
    Reject,
    Fail,
    Retry,
    Reopen,
    Cancel,
    Edit,
    DepAdd,
    DepRemove,
}

impl Action {
    pub fn parse(op: &str) -> Option<Action> {
        Some(match op {
            "claim" => Action::Claim,
            "block" => Action::Block,
            "unblock" => Action::Unblock,
            "release" => Action::Release,
            "done" => Action::Done,
            "submit" => Action::Submit,
            "approve" => Action::Approve,
            "reject" => Action::Reject,
            "fail" => Action::Fail,
            "retry" => Action::Retry,
            "reopen" => Action::Reopen,
            "cancel" => Action::Cancel,
            "edit" => Action::Edit,
            "dep_add" | "depAdd" => Action::DepAdd,
            "dep_remove" | "depRemove" | "dep_rm" => Action::DepRemove,
            _ => return None,
        })
    }

    /// The event action name (task_events.action).
    pub fn event(self) -> &'static str {
        match self {
            Action::Claim => "claim",
            Action::Block => "block",
            Action::Unblock => "unblock",
            Action::Release => "release",
            Action::Done => "done",
            Action::Submit => "submit",
            Action::Approve => "approve",
            Action::Reject => "reject",
            Action::Fail => "fail",
            Action::Retry => "retry",
            Action::Reopen => "reopen",
            Action::Cancel => "cancel",
            Action::Edit => "edit",
            Action::DepAdd => "dep_add",
            Action::DepRemove => "dep_remove",
        }
    }
}

/// What the rules need to know about a task.
#[derive(Debug, Clone)]
pub struct TaskFacts<'a> {
    pub seq: i64,
    pub state: &'a str,
    pub owner_id: Option<&'a str>,
    pub owner_name: Option<&'a str>,
    pub created_by_id: Option<&'a str>,
    pub needs_review: bool,
    pub attempt: i64,
    pub max_attempts: i64,
}

fn who(id: Option<&str>, name: Option<&str>) -> String {
    match (id, name) {
        (Some(i), Some(n)) if n != i => format!("{i} ({n})"),
        (Some(i), _) => i.to_string(),
        (None, Some(n)) => n.to_string(),
        (None, None) => "nobody".to_string(),
    }
}

/// "claimed by b2 (reviewer)", "in review (submitted by b2)", "done", …
pub fn describe_state(t: &TaskFacts) -> String {
    let owner = who(t.owner_id, t.owner_name);
    match t.state {
        "claimed" => format!("claimed by {owner}"),
        "blocked" => format!("blocked (owner {owner})"),
        "review" => format!("in review (submitted by {owner})"),
        other => other.to_string(),
    }
}

/// May `actor` apply `action` to the task? Returns the state the task moves to. Every
/// refusal names the task, its current state and owner, and what would work instead.
/// Rules: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md "States and
/// transitions". Dependency checks (claim) need the store and are done there.
pub fn check_transition(action: Action, t: &TaskFacts, actor: &Actor) -> Result<&'static str, String> {
    let n = t.seq;
    let desc = describe_state(t);
    let is_owner = !actor.id.is_empty() && t.owner_id == Some(actor.id.as_str());
    let owner_only = |verb: &str| -> Result<(), String> {
        if is_owner {
            Ok(())
        } else {
            Err(format!("#{n} is {desc}: only its owner can {verb} it"))
        }
    };
    let need = |states: &[&str], hint: &str| -> Result<(), String> {
        if states.contains(&t.state) {
            Ok(())
        } else {
            Err(format!("#{n} is {desc}{hint}"))
        }
    };
    // A person (the viewer) manages tasks but never works on one.
    if actor.human
        && matches!(action, Action::Claim | Action::Block | Action::Unblock | Action::Release | Action::Done | Action::Submit | Action::Fail)
    {
        return Err(format!("a person cannot {} a task: agents claim and work on tasks", action.event()));
    }
    match action {
        Action::Claim => {
            match t.state {
                "open" => {}
                "claimed" | "blocked" | "review" => return Err(format!("#{n} is already {desc}")),
                _ => return Err(format!("#{n} is {desc}: nothing to claim (retry or reopen it first)")),
            }
            Ok("claimed")
        }
        Action::Block => {
            need(&["claimed"], if t.state == "blocked" { " already" } else { ": only a claimed task can be blocked" })?;
            owner_only("block")?;
            Ok("blocked")
        }
        Action::Unblock => {
            need(&["blocked"], ": only a blocked task can be unblocked")?;
            owner_only("unblock")?;
            Ok("claimed")
        }
        Action::Release => {
            need(&["claimed", "blocked"], ": only a claimed or blocked task can be released")?;
            owner_only("release")?;
            Ok("open")
        }
        Action::Done => {
            need(&["claimed"], if t.state == "blocked" { ": unblock it first" } else { ": claim it first" })?;
            owner_only("finish")?;
            if t.needs_review {
                return Err(format!("#{n} needs review: use agent task submit (someone else approves it)"));
            }
            Ok("done")
        }
        Action::Submit => {
            need(&["claimed"], if t.state == "blocked" { ": unblock it first" } else { ": claim it first" })?;
            owner_only("submit")?;
            if !t.needs_review {
                return Err(format!("#{n} does not need review: use agent task done"));
            }
            Ok("review")
        }
        Action::Approve | Action::Reject => {
            need(&["review"], ": only a task in review can be approved or rejected")?;
            // Nobody reviews their own work, the root tab included; only a person is exempt.
            if is_owner && !actor.human {
                return Err(format!("#{n} was submitted by you: someone else (another member, the root tab or a person) reviews it"));
            }
            Ok(if action == Action::Approve { "done" } else { "open" })
        }
        Action::Fail => {
            need(&["claimed", "blocked"], ": only a claimed or blocked task can fail")?;
            owner_only("fail")?;
            Ok("failed")
        }
        Action::Retry => {
            need(&["failed"], ": only a failed task can be retried")?;
            if t.attempt >= t.max_attempts && !actor.privileged() {
                return Err(format!(
                    "#{n} has used its retries (attempt {} of {}): only the root tab or a person can retry it again",
                    t.attempt, t.max_attempts
                ));
            }
            Ok("open")
        }
        Action::Reopen => {
            need(&["done"], ": only a done task can be reopened")?;
            if !actor.privileged() {
                return Err(format!("#{n} is done: only the root tab or a person can reopen it"));
            }
            Ok("open")
        }
        Action::Cancel => {
            if t.state == "done" || t.state == "cancelled" {
                return Err(format!("#{n} is {desc}: it cannot be cancelled"));
            }
            let creator = !actor.id.is_empty() && t.created_by_id == Some(actor.id.as_str());
            if !creator && !actor.privileged() {
                return Err(format!("#{n} can be cancelled only by who added it ({}), the root tab or a person", who(t.created_by_id, None)));
            }
            Ok("cancelled")
        }
        Action::Edit => {
            check_edit(t, actor, false)?;
            Ok(state_static(t.state))
        }
        Action::DepAdd | Action::DepRemove => {
            if !is_live(t.state) || t.state == "review" {
                return Err(format!("#{n} is {desc}: dependencies change only on open, claimed or blocked tasks"));
            }
            check_edit(t, actor, false)?;
            Ok(state_static(t.state))
        }
    }
}

/// Who may edit a task (and change its dependencies):
/// - a finished task (done, failed, cancelled): only the root tab or a person;
/// - otherwise who added it, the root tab or a person; its owner only while it is claimed or
///   blocked;
/// - changing `review` (`review_change`): who added it, the root tab or a person, but never
///   the current owner (a person excepted) and never while the task is in review — so an
///   owner cannot drop the review step and finish the task unreviewed.
pub fn check_edit(t: &TaskFacts, actor: &Actor, review_change: bool) -> Result<(), String> {
    let n = t.seq;
    let is_owner = !actor.id.is_empty() && t.owner_id == Some(actor.id.as_str());
    let creator = !actor.id.is_empty() && t.created_by_id == Some(actor.id.as_str());
    let privileged = actor.root || actor.human;
    if matches!(t.state, "done" | "failed" | "cancelled") {
        if !privileged {
            return Err(format!("#{n} is {}: only the root tab or a person can change it", t.state));
        }
    } else if !(privileged || creator || (is_owner && is_held(t.state))) {
        return Err(format!(
            "#{n} can be changed only by who added it, the root tab, a person, or its owner while it is claimed or blocked"
        ));
    }
    if review_change {
        if t.state == "review" {
            return Err(format!("#{n} is in review: the review step cannot be changed now"));
        }
        if is_owner && !actor.human {
            return Err(format!("#{n} is yours: its owner cannot change whether it needs review"));
        }
        if !(creator || privileged) {
            return Err(format!("#{n}: only who added it, the root tab or a person can change whether it needs review"));
        }
    }
    Ok(())
}

// ── Lease worker decisions (pure; the worker in mod.rs runs them) ────────

/// One renewal tick for this app instance: renew the tasks whose owner tab still has a live
/// PTY, release those whose PTY is gone. Nothing at all while the app is exiting (a dying
/// app's PTY reads fail; with the PTY holder the tabs live on and are re-adopted after the
/// relaunch) or before the PTY backend is chosen (liveness unknown).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LeasePlan {
    pub renew: Vec<String>,
    pub release: Vec<String>,
}

pub fn plan_lease_tick(holders: &[String], exiting: bool, backend_ready: bool, alive: impl Fn(&str) -> bool) -> LeasePlan {
    let mut plan = LeasePlan::default();
    if exiting || !backend_ready {
        return plan;
    }
    for h in holders {
        if alive(h) {
            plan.renew.push(h.clone());
        } else {
            plan.release.push(h.clone());
        }
    }
    plan
}

/// Wait before the next tick: the renew interval, doubled per failed tick in a row, but
/// always below half the lease (one more failure must not let a live owner's lease run out).
pub fn next_tick_delay(renew_ms: i64, lease_ms: i64, failures: u32) -> i64 {
    let cap = (lease_ms / 2 - 1000).max(1000);
    renew_ms.saturating_mul(1i64 << failures.min(10)).min(cap).max(1000)
}

/// `agents.board.{leaseSeconds, renewSeconds}` from config.json → (lease_ms, renew_ms), with
/// the same clamps as the frontend (lease 60..3600 s, renew 10..600 s and at most half).
pub fn board_timing(config: Option<&serde_json::Value>) -> (i64, i64) {
    let board = config.and_then(|c| c.get("agents")).and_then(|a| a.get("board"));
    let num = |key: &str, default: i64, lo: i64, hi: i64| {
        board
            .and_then(|b| b.get(key))
            .and_then(|v| v.as_f64())
            .filter(|f| f.is_finite())
            .map(|f| (f.trunc() as i64).clamp(lo, hi))
            .unwrap_or(default)
    };
    let lease = num("leaseSeconds", 300, 60, 3600);
    let renew = num("renewSeconds", 60, 10, 600).min(lease / 2);
    (lease * 1000, renew * 1000)
}

fn state_static(s: &str) -> &'static str {
    TASK_STATES.iter().find(|x| **x == s).copied().unwrap_or("open")
}

// ── Lease / startup helpers (pure) ───────────────────────────────────────

/// A claimed/blocked task held on this host (for the startup decision).
#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseItem {
    /// The task's row id (UUIDv7 text).
    pub id: String,
    /// The owner_instance the caller saw; the store acts only when it is still the same.
    pub instance: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(id: &str) -> Actor {
        Actor { id: id.into(), name: None, cli: None, host: None, root: false, human: false }
    }

    fn facts<'a>(state: &'a str, owner: Option<&'a str>) -> TaskFacts<'a> {
        TaskFacts {
            seq: 7,
            state,
            owner_id: owner,
            owner_name: owner.map(|_| "worker"),
            created_by_id: Some("lead"),
            needs_review: false,
            attempt: 0,
            max_attempts: 3,
        }
    }

    #[test]
    fn claim_is_refused_with_the_current_owner_named() {
        let err = check_transition(Action::Claim, &facts("claimed", Some("b2")), &actor("c3")).unwrap_err();
        assert_eq!(err, "#7 is already claimed by b2 (worker)");
        assert!(check_transition(Action::Claim, &facts("done", None), &actor("c3")).unwrap_err().contains("retry or reopen"));
        assert_eq!(check_transition(Action::Claim, &facts("open", None), &actor("c3")).unwrap(), "claimed");
    }

    #[test]
    fn owner_only_transitions() {
        let other = check_transition(Action::Release, &facts("claimed", Some("b2")), &actor("c3")).unwrap_err();
        assert_eq!(other, "#7 is claimed by b2 (worker): only its owner can release it");
        assert_eq!(check_transition(Action::Block, &facts("claimed", Some("b2")), &actor("b2")).unwrap(), "blocked");
        assert_eq!(check_transition(Action::Unblock, &facts("blocked", Some("b2")), &actor("b2")).unwrap(), "claimed");
        assert!(check_transition(Action::Done, &facts("blocked", Some("b2")), &actor("b2")).unwrap_err().contains("unblock it first"));
        // Even root cannot finish someone else's task.
        let mut root = actor("lead");
        root.root = true;
        assert!(check_transition(Action::Done, &facts("claimed", Some("b2")), &root).is_err());
    }

    #[test]
    fn review_flow_rules() {
        let mut f = facts("claimed", Some("b2"));
        f.needs_review = true;
        assert!(check_transition(Action::Done, &f, &actor("b2")).unwrap_err().contains("use agent task submit"));
        assert_eq!(check_transition(Action::Submit, &f, &actor("b2")).unwrap(), "review");
        let r = facts("review", Some("b2"));
        assert!(check_transition(Action::Approve, &r, &actor("b2")).unwrap_err().contains("someone else"));
        assert_eq!(check_transition(Action::Approve, &r, &actor("c3")).unwrap(), "done");
        assert_eq!(check_transition(Action::Reject, &r, &actor("c3")).unwrap(), "open");
        let mut human = actor("b2");
        human.human = true;
        assert_eq!(check_transition(Action::Approve, &r, &human).unwrap(), "done", "a person may approve anything");
        let mut root_owner = actor("b2");
        root_owner.root = true;
        assert!(check_transition(Action::Approve, &r, &root_owner).unwrap_err().contains("someone else"), "the root tab cannot approve its own work");
        assert!(check_transition(Action::Reject, &r, &root_owner).is_err());
        assert!(check_transition(Action::Submit, &facts("claimed", Some("b2")), &actor("b2")).unwrap_err().contains("use agent task done"));
    }

    #[test]
    fn retry_reopen_cancel_and_edit_permissions() {
        let mut f = facts("failed", Some("b2"));
        f.attempt = 3;
        assert!(check_transition(Action::Retry, &f, &actor("c3")).unwrap_err().contains("attempt 3 of 3"));
        let mut root = actor("lead");
        root.root = true;
        assert_eq!(check_transition(Action::Retry, &f, &root).unwrap(), "open");
        f.attempt = 2;
        assert_eq!(check_transition(Action::Retry, &f, &actor("c3")).unwrap(), "open");
        assert!(check_transition(Action::Reopen, &facts("done", Some("b2")), &actor("b2")).is_err());
        assert_eq!(check_transition(Action::Reopen, &facts("done", Some("b2")), &root).unwrap(), "open");
        assert!(check_transition(Action::Cancel, &facts("open", None), &actor("c3")).unwrap_err().contains("who added it (lead)"));
        assert_eq!(check_transition(Action::Cancel, &facts("open", None), &actor("lead")).unwrap(), "cancelled");
        assert!(check_transition(Action::Cancel, &facts("done", None), &root).is_err());
        assert_eq!(check_transition(Action::Edit, &facts("claimed", Some("b2")), &actor("b2")).unwrap(), "claimed");
        assert!(check_transition(Action::Edit, &facts("claimed", Some("b2")), &actor("c3")).is_err());
    }

    #[test]
    fn the_owner_cannot_drop_the_review_step() {
        // The owner (also the creator) of a review task.
        let mut f = facts("claimed", Some("b2"));
        f.created_by_id = Some("b2");
        f.needs_review = true;
        assert!(check_edit(&f, &actor("b2"), true).unwrap_err().contains("its owner cannot change whether it needs review"));
        assert!(check_edit(&f, &actor("b2"), false).is_ok(), "title/body edits are fine while claimed");
        let mut root_owner = actor("b2");
        root_owner.root = true;
        assert!(check_edit(&f, &root_owner, true).is_err(), "not even as the root tab");
        let mut root = actor("lead");
        root.root = true;
        assert!(check_edit(&f, &root, true).is_ok());
        assert!(check_edit(&facts("review", Some("b2")), &root, true).unwrap_err().contains("in review"));
        // The owner may edit only while claimed/blocked; after done only root/person.
        assert!(check_edit(&facts("open", None), &actor("b2"), false).is_err());
        assert!(check_edit(&facts("done", Some("b2")), &actor("b2"), false).unwrap_err().contains("only the root tab or a person"));
        assert!(check_edit(&facts("done", Some("b2")), &actor("lead"), false).is_err(), "the creator neither, once finished");
        assert!(check_edit(&facts("cancelled", None), &root, false).is_ok());
        // Dependencies follow the same rule.
        assert!(check_transition(Action::DepRemove, &facts("open", None), &actor("c3")).unwrap_err().contains("can be changed only"));
        assert!(check_transition(Action::DepRemove, &facts("claimed", Some("c3")), &actor("c3")).is_ok());
    }

    #[test]
    fn a_person_manages_but_never_works_on_tasks() {
        let mut human = actor("user");
        human.human = true;
        for a in [Action::Claim, Action::Block, Action::Unblock, Action::Release, Action::Done, Action::Submit, Action::Fail] {
            assert!(check_transition(a, &facts("claimed", Some("user")), &human).unwrap_err().starts_with("a person cannot"), "{a:?}");
        }
        assert_eq!(check_transition(Action::Cancel, &facts("open", None), &human).unwrap(), "cancelled");
    }

    #[test]
    fn lease_plan_renews_live_owners_and_never_acts_while_exiting() {
        let holders = vec!["a".to_string(), "gone".to_string()];
        let alive = |id: &str| id == "a";
        assert_eq!(plan_lease_tick(&holders, false, true, alive), LeasePlan { renew: vec!["a".into()], release: vec!["gone".into()] });
        // Quit / update handover: a dying app's PTYs look dead; nothing is released.
        assert_eq!(plan_lease_tick(&holders, true, true, alive), LeasePlan::default());
        // PTY backend not chosen yet: liveness unknown, nothing happens.
        assert_eq!(plan_lease_tick(&holders, false, false, alive), LeasePlan::default());
        // After a webview reload the host still knows the PTYs: same-instance claims renew.
        assert_eq!(plan_lease_tick(&["a".to_string()], false, true, alive).renew, vec!["a"]);
        // A release that failed leaves the holder listed: it is released again, never renewed.
        let again = plan_lease_tick(&["gone".to_string()], false, true, alive);
        assert!(again.renew.is_empty() && again.release == vec!["gone"]);
    }

    #[test]
    fn tick_delay_backs_off_below_half_the_lease() {
        assert_eq!(next_tick_delay(60_000, 300_000, 0), 60_000);
        assert_eq!(next_tick_delay(60_000, 300_000, 1), 120_000);
        assert_eq!(next_tick_delay(60_000, 300_000, 5), 149_000);
        assert_eq!(next_tick_delay(60_000, 300_000, 40), 149_000);
        let cfg = serde_json::json!({ "agents": { "board": { "leaseSeconds": 100, "renewSeconds": 90 } } });
        assert_eq!(board_timing(Some(&cfg)), (100_000, 50_000));
        assert_eq!(board_timing(None), (300_000, 60_000));
    }

    #[test]
    fn ids_are_uuid_v7_and_sort_by_creation() {
        let ids: Vec<String> = (0..200).map(|_| new_id()).collect();
        for id in &ids {
            let u = uuid::Uuid::parse_str(id).unwrap();
            assert_eq!(u.get_version_num(), 7, "{id}");
            assert_eq!(id.len(), 36);
        }
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(sorted, ids, "later ids sort after earlier ones");
    }

    #[test]
    fn host_id_prefers_the_override() {
        assert_eq!(host_id(Some("test-host"), "real"), "test-host");
        assert_eq!(host_id(Some("  "), "real.local"), "real.local");
        assert_eq!(host_id(None, "a\nb"), "a b");
        assert_eq!(host_id(None, ""), "localhost");
    }

    #[test]
    fn text_rules() {
        assert_eq!(clean_line("  a\tb\nc ", "title", 10).unwrap(), "a b c");
        assert_eq!(clean_line(" ", "title", 10).unwrap_err(), "title required");
        assert!(clean_line(&"x".repeat(11), "title", 10).unwrap_err().starts_with("title too long: 11"));
        assert_eq!(clean_labels(&["a".into(), " a ".into(), "b".into(), "".into()]).unwrap(), vec!["a", "b"]);
        assert!(clean_labels(&(0..11).map(|i| i.to_string()).collect::<Vec<_>>()).is_err());
        let r = TaskResult::check(&ResultInput {
            summary: Some("did it".into()),
            checks: Some("PASSED".into()),
            artifacts: [("pr".to_string(), "https://example.invalid/pr/1".to_string())].into_iter().collect(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(r.checks.as_deref(), Some("passed"));
        assert_eq!(r.artifacts.as_deref(), Some(r#"{"pr":"https://example.invalid/pr/1"}"#));
        assert!(TaskResult::check(&ResultInput::default()).unwrap_err().starts_with("summary required"));
        assert!(TaskResult::check(&ResultInput { summary: Some("x".into()), checks: Some("maybe".into()), ..Default::default() }).is_err());
        let bad_key = ResultInput { summary: Some("x".into()), artifacts: [("a b".to_string(), "v".to_string())].into_iter().collect(), ..Default::default() };
        assert!(TaskResult::check(&bad_key).unwrap_err().starts_with("invalid artifact key"));
    }
}
