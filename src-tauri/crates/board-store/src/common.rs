//! Engine-neutral pieces both stores share: the task row both engines load, its JSON shape,
//! the done-note text and the input checks every write runs before it touches a database.
//! Keeping them here makes the SQLite and PostgreSQL stores differ only in SQL.

use super::model::*;
use serde_json::{json, Value};

/// A task as both engines load it (`TASK_COLS` order in each engine).
#[derive(Debug, Clone)]
pub struct TaskRow {
    pub id: String,
    pub team: String,
    pub seq: i64,
    pub parent_seq: Option<i64>,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub priority: i64,
    pub needs_review: bool,
    pub created_by_id: Option<String>,
    pub created_by_name: Option<String>,
    pub created_by_host: Option<String>,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub owner_host: Option<String>,
    pub owner_instance: Option<String>,
    pub attempt: i64,
    pub max_attempts: i64,
    pub blocked_reason: Option<String>,
    pub last_error: Option<String>,
    pub result_summary: Option<String>,
    pub result_body: Option<String>,
    pub result_branch: Option<String>,
    pub result_commit: Option<String>,
    pub result_worktree: Option<String>,
    pub result_checks: Option<String>,
    pub result_artifacts: Option<String>,
    pub labels: String,
    pub meta: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub started_at: Option<i64>,
    pub submitted_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub lease_until: Option<i64>,
    pub heartbeat_at: Option<i64>,
    pub due_at: Option<i64>,
    pub version: i64,
    pub team_uid: String,
    pub row_version: i64,
}

impl TaskRow {
    pub fn facts(&self) -> TaskFacts<'_> {
        TaskFacts {
            seq: self.seq,
            state: &self.state,
            owner_id: self.owner_id.as_deref(),
            owner_name: self.owner_name.as_deref(),
            created_by_id: self.created_by_id.as_deref(),
            needs_review: self.needs_review,
            attempt: self.attempt,
            max_attempts: self.max_attempts,
        }
    }
}

pub fn parse_json(raw: &str, fallback: Value) -> Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

pub fn party(id: &Option<String>, name: &Option<String>, host: &Option<String>) -> Value {
    let mut m = serde_json::Map::new();
    if let Some(v) = id {
        m.insert("id".into(), json!(v));
    }
    if let Some(v) = name {
        m.insert("name".into(), json!(v));
    }
    if let Some(v) = host {
        m.insert("host".into(), json!(v));
    }
    Value::Object(m)
}

/// A dependency in this state no longer holds its dependent back.
pub fn dep_met(state: &str) -> bool {
    state == "done" || state == "cancelled"
}

/// A task as JSON (camelCase). `waiting` and `stale` are derived, never stored.
pub fn task_json(t: &TaskRow, deps: &[(i64, String)], now: i64, stale_ms: i64) -> Value {
    // A cancelled dependency counts as met (flagged); a failed one still blocks.
    let waiting_on: Vec<i64> = deps.iter().filter(|(_, s)| !dep_met(s)).map(|(n, _)| *n).collect();
    let cancelled_deps: Vec<i64> = deps.iter().filter(|(_, s)| s == "cancelled").map(|(n, _)| *n).collect();
    let waiting = t.state == "open" && !waiting_on.is_empty();
    let stale = is_held(&t.state) && t.updated_at < now - stale_ms;
    let owner = if t.owner_id.is_some() {
        let mut o = party(&t.owner_id, &t.owner_name, &t.owner_host);
        if let Some(i) = &t.owner_instance {
            o["instance"] = json!(i);
        }
        o
    } else {
        Value::Null
    };
    let result = match &t.result_summary {
        Some(summary) => json!({
            "summary": summary,
            "body": t.result_body,
            "branch": t.result_branch,
            "commit": t.result_commit,
            "worktree": t.result_worktree,
            "checks": t.result_checks,
            "artifacts": t.result_artifacts.as_deref().map(|a| parse_json(a, json!({}))).unwrap_or(json!({})),
        }),
        None => Value::Null,
    };
    json!({
        "id": t.id,
        "team": t.team,
        "teamUid": t.team_uid,
        "seq": t.seq,
        "parent": t.parent_seq,
        "title": t.title,
        "body": t.body,
        "state": t.state,
        "priority": t.priority,
        "needsReview": t.needs_review,
        "createdBy": party(&t.created_by_id, &t.created_by_name, &t.created_by_host),
        "owner": owner,
        "attempt": t.attempt,
        "maxAttempts": t.max_attempts,
        "blockedReason": t.blocked_reason,
        "lastError": t.last_error,
        "result": result,
        "labels": parse_json(&t.labels, json!([])),
        "meta": parse_json(&t.meta, json!({})),
        "createdAt": t.created_at,
        "updatedAt": t.updated_at,
        "claimedAt": t.claimed_at,
        "startedAt": t.started_at,
        "submittedAt": t.submitted_at,
        "finishedAt": t.finished_at,
        "leaseUntil": t.lease_until,
        "heartbeatAt": t.heartbeat_at,
        "dueAt": t.due_at,
        "version": t.version,
        "rowVersion": t.row_version,
        "deps": deps.iter().map(|(n, s)| json!({ "seq": n, "state": s })).collect::<Vec<_>>(),
        "waiting": waiting,
        "waitingOn": waiting_on,
        "cancelledDeps": cancelled_deps,
        "stale": stale,
    })
}

pub fn done_post_text(row: &TaskRow, summary: &str, approved_by: Option<&Actor>) -> String {
    let mut lines = vec![match approved_by {
        Some(a) => format!("#{} done (approved by {}): {}", row.seq, a.name.as_deref().unwrap_or(&a.id), row.title),
        None => format!("#{} done: {}", row.seq, row.title),
    }];
    lines.push(summary.to_string());
    let mut where_ = Vec::new();
    if let Some(b) = &row.result_branch {
        where_.push(format!("branch {b}"));
    }
    if let Some(c) = &row.result_commit {
        where_.push(format!("commit {c}"));
    }
    if let Some(c) = &row.result_checks {
        where_.push(format!("checks {c}"));
    }
    if !where_.is_empty() {
        lines.push(where_.join(", "));
    }
    let text = lines.join("\n");
    clean_text(&text).unwrap_or_else(|_| text.chars().take(MAX_TEXT_CHARS).collect())
}

pub fn require_text(raw: &Option<String>, field: &str, flag: &str) -> Result<String, String> {
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => clean_multiline(v, field, MAX_REASON_CHARS, MAX_TEXT_LINES),
        None => Err(format!("{field} required ({flag} \"<text>\")")),
    }
}

/// A checked post (everything but the team row and the task link).
pub struct PostSpec {
    pub kind: String,
    pub text: String,
    pub author_id: String,
    pub author_name: Option<String>,
    pub author_cli: Option<String>,
    pub team_name: Option<String>,
}

impl PostSpec {
    pub fn check(team: &str, input: &PostInput) -> Result<PostSpec, String> {
        check_team(team)?;
        let kind = input.kind.trim().to_ascii_lowercase();
        if !POST_KINDS.contains(&kind.as_str()) {
            return Err(format!("invalid kind: {} ({})", input.kind, POST_KINDS.join("|")));
        }
        if kind == "announce" && !input.root {
            return Err("only the team's root tab can post an announcement (--kind announce)".to_string());
        }
        let text = clean_text(&input.text)?;
        let author_id = clean_label(Some(&input.author_id), 256).ok_or_else(|| "author required".to_string())?;
        Ok(PostSpec {
            kind,
            text,
            author_id,
            author_name: clean_label(input.author_name.as_deref(), MAX_NAME_CHARS),
            author_cli: clean_label(input.author_cli.as_deref(), 40),
            team_name: clean_label(input.team_name.as_deref(), MAX_NAME_CHARS),
        })
    }
}

/// A checked read query.
pub struct ReadSpec {
    pub limit: i64,
    pub kind: Option<String>,
    pub author: Option<String>,
    pub pattern: Option<String>,
    pub exclude: Option<String>,
    pub cursor_tab: Option<String>,
    /// No filter and no cursor: the newest announcements are returned apart.
    pub pinned: bool,
    pub since: i64,
    /// Lower bound on seq: none unless --since (a synced row can carry any number).
    pub seq_after: i64,
}

impl ReadSpec {
    pub fn check(team: &str, q: &ReadQuery) -> Result<ReadSpec, String> {
        check_team(team)?;
        let limit = q.limit.unwrap_or(DEFAULT_READ_LIMIT).clamp(1, MAX_READ_LIMIT);
        let kind = non_empty(&q.kind).map(|k| k.to_ascii_lowercase());
        if let Some(k) = &kind {
            if !POST_KINDS.contains(&k.as_str()) {
                return Err(format!("invalid kind: {k} ({})", POST_KINDS.join("|")));
            }
        }
        let author = non_empty(&q.author);
        let search = non_empty(&q.search);
        if let Some(s) = &search {
            if s.chars().count() > MAX_SEARCH_CHARS {
                return Err(format!("search text too long (max {MAX_SEARCH_CHARS} characters)"));
            }
        }
        let exclude = non_empty(&q.exclude_author);
        let cursor_tab = non_empty(&q.cursor_tab);
        if cursor_tab.as_deref().is_some_and(|t| !valid_team_id(t)) {
            return Err("invalid read cursor tab id (expected 1-128 characters of A-Z a-z 0-9 _ -)".to_string());
        }
        if cursor_tab.is_some() && (kind.is_some() || author.is_some() || search.is_some() || q.since.is_some()) {
            return Err(NEW_WITH_FILTER_ERROR.to_string());
        }
        let pinned = cursor_tab.is_none() && kind.is_none() && author.is_none() && search.is_none();
        let pattern = search.as_deref().map(like_pattern);
        Ok(ReadSpec {
            limit,
            kind,
            author,
            pattern,
            exclude,
            cursor_tab,
            pinned,
            since: q.since.unwrap_or(0).max(0),
            seq_after: q.since.map(|n| n.max(0)).unwrap_or(i64::MIN),
        })
    }

    /// The answer for a team that does not exist (yet).
    pub fn empty(&self, team: &str) -> Value {
        let mut out = json!({ "team": team, "posts": [], "lastSeq": 0, "total": 0, "matched": 0, "more": 0, "since": self.since });
        if self.pinned {
            out["announcements"] = json!([]);
        }
        if self.cursor_tab.is_some() {
            out["cursor"] = json!(0);
            out["nextCursor"] = json!(0);
        }
        out
    }
}

/// A checked `task add`.
pub struct AddSpec {
    pub title: String,
    pub body: Option<String>,
    pub priority: i64,
    pub max_attempts: i64,
    pub labels: Vec<String>,
    pub after: Vec<i64>,
    pub team_name: Option<String>,
    pub review: bool,
}

impl AddSpec {
    pub fn check(op: &TaskOpInput) -> Result<AddSpec, String> {
        let title = clean_line(op.title.as_deref().unwrap_or(""), "title", MAX_TITLE_CHARS)?;
        let body = match op.body.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(b) => Some(clean_multiline(b, "body", MAX_BODY_CHARS, MAX_BODY_LINES)?),
            None => None,
        };
        let priority = op.priority.unwrap_or(DEFAULT_PRIORITY);
        if !(0..=MAX_PRIORITY).contains(&priority) {
            return Err(format!("priority must be 0-{MAX_PRIORITY} (higher is claimed first)"));
        }
        let max_attempts = op.max_attempts.unwrap_or(DEFAULT_MAX_ATTEMPTS);
        if !(1..=MAX_MAX_ATTEMPTS).contains(&max_attempts) {
            return Err(format!("max attempts must be 1-{MAX_MAX_ATTEMPTS}"));
        }
        let labels = clean_labels(op.labels.as_deref().unwrap_or(&[]))?;
        let mut after: Vec<i64> = Vec::new();
        for n in &op.after {
            if !after.contains(n) {
                after.push(*n);
            }
        }
        if after.len() > MAX_DEPS_PER_TASK {
            return Err(format!("too many dependencies (max {MAX_DEPS_PER_TASK})"));
        }
        Ok(AddSpec {
            title,
            body,
            priority,
            max_attempts,
            labels,
            after,
            team_name: clean_label(op.team_name.as_deref(), MAX_NAME_CHARS),
            review: op.review.unwrap_or(false),
        })
    }

    pub fn labels_json(&self) -> String {
        serde_json::to_string(&self.labels).unwrap_or_else(|_| "[]".into())
    }
}

/// The checked parts of a transition (everything but `add`), before any database work.
pub struct WriteSpec {
    pub action: Action,
    pub reason: Option<String>,
    pub result: Option<TaskResult>,
    pub claim_next: bool,
    /// claim --next --label: only tasks carrying one of these (empty = any task).
    pub next_labels: Vec<String>,
    pub lease: i64,
}

impl WriteSpec {
    pub fn check(name: &str, op: &TaskOpInput) -> Result<WriteSpec, String> {
        let action = Action::parse(name).ok_or_else(|| format!("unknown task operation: {name}"))?;
        let reason = match action {
            Action::Block => Some(require_text(&op.reason, "reason", "--reason")?),
            Action::Reject => Some(require_text(&op.reason, "reason", "--reason")?),
            Action::Fail => Some(require_text(&op.error, "error", "--error")?),
            Action::Reopen | Action::Cancel | Action::Approve => match op.reason.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some(r) => Some(clean_multiline(r, "reason", MAX_REASON_CHARS, MAX_TEXT_LINES)?),
                None => None,
            },
            _ => None,
        };
        let result = match action {
            Action::Done | Action::Submit => Some(TaskResult::check(op.result.as_ref().unwrap_or(&ResultInput::default()))?),
            _ => None,
        };
        let claim_next = action == Action::Claim && op.next && op.task.is_none();
        if op.task.is_none() && !claim_next {
            return Err(format!("task number required (agent task {name} <#>)"));
        }
        let next_labels = match (&op.labels, action) {
            (Some(l), Action::Claim) if claim_next => clean_labels(l)?,
            (Some(l), Action::Claim) if !l.is_empty() => return Err("agent task claim: --label goes with --next".into()),
            _ => Vec::new(),
        };
        Ok(WriteSpec { action, reason, result, claim_next, next_labels, lease: lease_ms(op.lease_ms) })
    }
}

/// The checked fields of an `edit` (run after the permission and version checks).
pub struct EditSpec {
    pub title: Option<String>,
    /// Some(None): clear the body.
    pub body: Option<Option<String>>,
    pub labels: Option<String>,
    pub fields: Vec<&'static str>,
}

impl EditSpec {
    pub fn check(op: &TaskOpInput) -> Result<EditSpec, String> {
        let title = match &op.title {
            Some(t) => Some(clean_line(t, "title", MAX_TITLE_CHARS)?),
            None => None,
        };
        let body = match &op.body {
            Some(b) if b.trim().is_empty() => Some(None),
            Some(b) => Some(Some(clean_multiline(b, "body", MAX_BODY_CHARS, MAX_BODY_LINES)?)),
            None => None,
        };
        if let Some(p) = op.priority {
            if !(0..=MAX_PRIORITY).contains(&p) {
                return Err(format!("priority must be 0-{MAX_PRIORITY}"));
            }
        }
        let labels = match &op.labels {
            Some(l) => Some(serde_json::to_string(&clean_labels(l)?).unwrap_or_else(|_| "[]".into())),
            None => None,
        };
        let mut fields = Vec::new();
        if title.is_some() {
            fields.push("title");
        }
        if body.is_some() {
            fields.push("body");
        }
        if op.priority.is_some() {
            fields.push("priority");
        }
        if labels.is_some() {
            fields.push("labels");
        }
        if op.review.is_some() {
            fields.push("review");
        }
        if fields.is_empty() {
            return Err("nothing to edit (--title, --body, --priority, --label)".to_string());
        }
        Ok(EditSpec { title, body, labels, fields })
    }
}

/// A checked task list query.
pub struct ListSpec {
    pub stale: i64,
    pub stored: Vec<String>,
    pub want_waiting: bool,
    pub want_ready: bool,
    pub want_stale: bool,
    pub state_filter: bool,
    pub pattern: Option<String>,
    pub mine: Option<String>,
    pub limit: i64,
}

impl ListSpec {
    pub fn check(team: &str, q: &TaskListQuery) -> Result<ListSpec, String> {
        check_team(team)?;
        let stale = stale_ms(q.stale_ms);
        let mut stored: Vec<String> = Vec::new();
        let (mut want_waiting, mut want_ready, mut want_stale) = (false, q.ready, false);
        for s in &q.states {
            let s = s.trim().to_ascii_lowercase();
            match s.as_str() {
                "" => {}
                "waiting" => want_waiting = true,
                "ready" => want_ready = true,
                "stale" => want_stale = true,
                s if TASK_STATES.contains(&s) => stored.push(s.to_string()),
                other => return Err(format!("invalid state: {other} ({}|waiting|ready|stale)", TASK_STATES.join("|"))),
            }
        }
        let search = non_empty(&q.search);
        if let Some(s) = &search {
            if s.chars().count() > MAX_SEARCH_CHARS {
                return Err(format!("search text too long (max {MAX_SEARCH_CHARS} characters)"));
            }
        }
        let any_filter = !stored.is_empty() || want_waiting || want_ready || want_stale;
        if !any_filter && !q.all {
            stored = ["open", "claimed", "blocked", "review", "failed"].iter().map(|s| s.to_string()).collect();
        }
        let state_filter = !stored.is_empty() || want_waiting || want_ready || want_stale;
        Ok(ListSpec {
            stale,
            stored,
            want_waiting,
            want_ready,
            want_stale,
            state_filter,
            pattern: search.as_deref().map(like_pattern),
            mine: non_empty(&q.mine),
            limit: q.limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT),
        })
    }

    /// Per-state counts, all zero (filled by the engine).
    pub fn zero_counts() -> serde_json::Map<String, Value> {
        let mut counts = serde_json::Map::new();
        for s in TASK_STATES {
            counts.insert(s.into(), json!(0));
        }
        counts.insert("waiting".into(), json!(0));
        counts.insert("stale".into(), json!(0));
        counts
    }
}

/// The answer to `claim --next` when nothing is ready.
pub fn none_ready(open: i64, waiting: i64, expired: Vec<Value>) -> Value {
    let none = if open == 0 {
        "no open task to claim".to_string()
    } else {
        format!("no open task is ready: {waiting} wait for dependencies")
    };
    json!({ "action": "claim", "task": Value::Null, "open": open, "waiting": waiting, "expired": expired, "none": none })
}
