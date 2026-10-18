use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use surrealdb::engine::local::Db;
use surrealdb::Surreal;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSessionPayload {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub work_dir: String,
    pub mode: String,
    pub provider: String,
    pub user_message: String,
    pub assistant_summary: String,
    #[serde(default)]
    pub tool_names: Vec<String>,
    #[serde(default)]
    pub saved_files: Vec<String>,
    #[serde(default)]
    pub artifact_names: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSkillPayload {
    pub id: String,
    pub name: String,
    pub description: String,
    pub command: String,
    pub cli_type: String,
    pub category: String,
    #[serde(default)]
    pub source_thread: Option<String>,
    pub work_dir: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningMemoryPayload {
    pub id: String,
    pub work_dir: String,
    pub content: String,
    pub source: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningTrajectoryPayload {
    pub id: String,
    pub thread_id: String,
    pub work_dir: String,
    pub title: String,
    pub mode: String,
    pub provider: String,
    pub messages_json: String,
    pub review_json: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSessionSearchParams {
    pub work_dir: String,
    pub query: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningSkillSearchParams {
    pub work_dir: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningTrajectorySearchParams {
    pub work_dir: String,
    pub query: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningMemorySearchParams {
    pub work_dir: String,
    pub query: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningUnifiedSearchParams {
    pub work_dir: String,
    pub query: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub session_limit: Option<usize>,
    #[serde(default)]
    pub skill_limit: Option<usize>,
    #[serde(default)]
    pub memory_limit: Option<usize>,
    #[serde(default)]
    pub trajectory_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningUnifiedSearchResult {
    #[serde(default)]
    pub sessions: Vec<LearningSessionPayload>,
    #[serde(default)]
    pub skills: Vec<LearningSkillPayload>,
    #[serde(default)]
    pub memories: Vec<LearningMemoryPayload>,
    #[serde(default)]
    pub trajectories: Vec<LearningTrajectoryPayload>,
    #[serde(default)]
    pub sources: Vec<String>,
}

fn tokenize_for_search(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .map(|token| token.trim().to_string())
        .filter(|token| token.len() >= 2)
        .collect()
}

fn extract_query_phrases(text: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut in_quote = false;
    let mut current = String::new();
    for ch in text.chars() {
        if ch == '"' {
            if in_quote {
                let phrase = current.trim().to_lowercase();
                if phrase.len() >= 2 {
                    phrases.push(phrase);
                }
                current.clear();
                in_quote = false;
            } else {
                in_quote = true;
            }
            continue;
        }
        if in_quote {
            current.push(ch);
        }
    }

    if phrases.is_empty() {
        let normalized = text.trim().to_lowercase();
        if normalized.contains(' ') && normalized.len() >= 4 {
            phrases.push(normalized);
        }
    }

    phrases
}

fn learning_fts_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("octo")
}

fn learning_fts_path() -> PathBuf {
    learning_fts_dir().join("learning_fts.sqlite3")
}

fn open_fts_connection() -> Result<Connection, String> {
    let dir = learning_fts_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Learning FTS create dir failed: {e}"))?;
    }
    let conn = Connection::open(learning_fts_path())
        .map_err(|e| format!("Learning FTS open failed: {e}"))?;
    ensure_fts_schema(&conn)?;
    Ok(conn)
}

fn ensure_fts_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE IF NOT EXISTS learning_session_fts USING fts5(
            entry_id UNINDEXED,
            work_dir UNINDEXED,
            thread_id UNINDEXED,
            title,
            user_message,
            assistant_summary,
            saved_files,
            tool_names,
            artifact_names,
            tokenize = 'unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS learning_skill_fts USING fts5(
            entry_id UNINDEXED,
            work_dir UNINDEXED,
            name,
            description,
            command,
            category,
            source_thread,
            tokenize = 'unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS learning_memory_fts USING fts5(
            entry_id UNINDEXED,
            work_dir UNINDEXED,
            content,
            source,
            pinned UNINDEXED,
            tokenize = 'unicode61'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS learning_trajectory_fts USING fts5(
            entry_id UNINDEXED,
            work_dir UNINDEXED,
            thread_id UNINDEXED,
            title,
            mode,
            provider,
            messages_json,
            review_json,
            tokenize = 'unicode61'
        );
        "#,
    )
    .map_err(|e| format!("Learning FTS schema setup failed: {e}"))?;
    Ok(())
}

fn build_fts_match_query(query: &str) -> Option<String> {
    let phrases = extract_query_phrases(query);
    let tokens = tokenize_for_search(query);
    let mut terms: Vec<String> = Vec::new();
    for phrase in phrases {
        let escaped = phrase.replace('"', "\"\"");
        if escaped.len() >= 2 {
            terms.push(format!("\"{}\"", escaped));
        }
    }
    for token in tokens {
        let escaped = token.replace('"', "\"\"");
        if escaped.len() >= 2 {
            terms.push(format!("\"{}\"", escaped));
        }
    }
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" OR "))
    }
}

fn upsert_session_fts(entry: &LearningSessionPayload) -> Result<(), String> {
    let conn = open_fts_connection()?;
    conn.execute(
        "DELETE FROM learning_session_fts WHERE entry_id = ?1",
        params![entry.id],
    )
    .map_err(|e| format!("Learning FTS delete session failed: {e}"))?;
    conn.execute(
        "INSERT INTO learning_session_fts (entry_id, work_dir, thread_id, title, user_message, assistant_summary, saved_files, tool_names, artifact_names)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            entry.id,
            entry.work_dir,
            entry.thread_id,
            entry.title,
            entry.user_message,
            entry.assistant_summary,
            entry.saved_files.join(" "),
            entry.tool_names.join(" "),
            entry.artifact_names.join(" "),
        ],
    ).map_err(|e| format!("Learning FTS insert session failed: {e}"))?;
    Ok(())
}

fn upsert_skill_fts(entry: &LearningSkillPayload) -> Result<(), String> {
    let conn = open_fts_connection()?;
    conn.execute(
        "DELETE FROM learning_skill_fts WHERE entry_id = ?1",
        params![entry.id],
    )
    .map_err(|e| format!("Learning FTS delete skill failed: {e}"))?;
    conn.execute(
        "INSERT INTO learning_skill_fts (entry_id, work_dir, name, description, command, category, source_thread)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.id,
            entry.work_dir,
            entry.name,
            entry.description,
            entry.command,
            entry.category,
            entry.source_thread.clone().unwrap_or_default(),
        ],
    ).map_err(|e| format!("Learning FTS insert skill failed: {e}"))?;
    Ok(())
}

fn upsert_memory_fts(entry: &LearningMemoryPayload) -> Result<(), String> {
    let conn = open_fts_connection()?;
    conn.execute(
        "DELETE FROM learning_memory_fts WHERE entry_id = ?1",
        params![entry.id],
    )
    .map_err(|e| format!("Learning FTS delete memory failed: {e}"))?;
    conn.execute(
        "INSERT INTO learning_memory_fts (entry_id, work_dir, content, source, pinned)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            entry.id,
            entry.work_dir,
            entry.content,
            entry.source,
            if entry.pinned { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("Learning FTS insert memory failed: {e}"))?;
    Ok(())
}

fn upsert_trajectory_fts(entry: &LearningTrajectoryPayload) -> Result<(), String> {
    let conn = open_fts_connection()?;
    conn.execute(
        "DELETE FROM learning_trajectory_fts WHERE entry_id = ?1",
        params![entry.id],
    )
    .map_err(|e| format!("Learning FTS delete trajectory failed: {e}"))?;
    conn.execute(
        "INSERT INTO learning_trajectory_fts (entry_id, work_dir, thread_id, title, mode, provider, messages_json, review_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.id,
            entry.work_dir,
            entry.thread_id,
            entry.title,
            entry.mode,
            entry.provider,
            entry.messages_json,
            entry.review_json.clone().unwrap_or_default(),
        ],
    ).map_err(|e| format!("Learning FTS insert trajectory failed: {e}"))?;
    Ok(())
}

fn search_fts_ids(
    table: &str,
    work_dir: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let Some(match_query) = build_fts_match_query(query) else {
        return Ok(Vec::new());
    };
    let conn = open_fts_connection()?;
    let sql = format!(
        "SELECT entry_id FROM {table} WHERE work_dir = ?1 AND {table} MATCH ?2 ORDER BY bm25({table}) LIMIT ?3"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("Learning FTS prepare search failed: {e}"))?;
    let rows = stmt
        .query_map(params![work_dir, match_query, limit as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("Learning FTS query failed: {e}"))?;
    let mut ids = Vec::new();
    for row in rows {
        if let Ok(id) = row {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn reorder_by_ids<T, F>(entries: Vec<T>, ids: &[String], id_of: F) -> Vec<T>
where
    F: Fn(&T) -> &str,
{
    let mut ordered = Vec::new();
    let mut remaining: Vec<T> = entries;
    for id in ids {
        if let Some(index) = remaining.iter().position(|entry| id_of(entry) == id) {
            ordered.push(remaining.remove(index));
        }
    }
    ordered
}

fn apply_phrase_bonus(
    haystack: &str,
    phrases: &[String],
    exact_fields: &[&str],
    prefix_fields: &[&str],
) -> f64 {
    let mut score = 0.0f64;
    for phrase in phrases {
        if haystack.contains(phrase) {
            score += 5.0;
        }
        if exact_fields.iter().any(|field| field == phrase) {
            score += 8.0;
        }
        if prefix_fields.iter().any(|field| field.starts_with(phrase)) {
            score += 3.0;
        }
    }
    score
}

fn score_session(
    entry: &LearningSessionPayload,
    query_tokens: &[String],
    query_phrases: &[String],
    now_ms: i64,
) -> f64 {
    let title = entry.title.to_lowercase();
    let user_message = entry.user_message.to_lowercase();
    let assistant_summary = entry.assistant_summary.to_lowercase();
    let saved_files = entry.saved_files.join(" ").to_lowercase();
    let tool_names = entry.tool_names.join(" ").to_lowercase();
    let artifact_names = entry.artifact_names.join(" ").to_lowercase();
    let haystack = format!(
        "{} {} {} {} {} {}",
        title, user_message, assistant_summary, saved_files, tool_names, artifact_names
    );

    let mut score = 0.0f64;
    for token in query_tokens {
        if haystack.contains(token) {
            score += 3.0;
        }
        if title.contains(token) {
            score += 2.0;
        }
        if user_message.contains(token) {
            score += 2.0;
        }
        if saved_files.contains(token) || artifact_names.contains(token) {
            score += 1.5;
        }
        if title == *token {
            score += 4.0;
        }
        if title.starts_with(token) {
            score += 1.5;
        }
    }

    score += apply_phrase_bonus(
        &haystack,
        query_phrases,
        &[&title, &user_message],
        &[&title, &saved_files, &artifact_names],
    );

    let age_hours = (((now_ms - entry.created_at).max(1)) as f64) / 3_600_000.0;
    score + (4.0 - age_hours.log10()).max(0.0)
}

fn score_skill(
    entry: &LearningSkillPayload,
    query_tokens: &[String],
    query_phrases: &[String],
) -> f64 {
    let name = entry.name.to_lowercase();
    let description = entry.description.to_lowercase();
    let command = entry.command.to_lowercase();
    let source_thread = entry
        .source_thread
        .clone()
        .unwrap_or_default()
        .to_lowercase();
    let haystack = format!("{} {} {} {}", name, description, command, source_thread);

    let mut score = 0.0f64;
    for token in query_tokens {
        if haystack.contains(token) {
            score += 3.0;
        }
        if name.contains(token) {
            score += 3.0;
        }
        if description.contains(token) {
            score += 2.0;
        }
        if name == *token {
            score += 5.0;
        }
        if name.starts_with(token) {
            score += 2.0;
        }
    }
    score
        + apply_phrase_bonus(
            &haystack,
            query_phrases,
            &[&name],
            &[&name, &description, &command],
        )
}

fn score_trajectory(
    entry: &LearningTrajectoryPayload,
    query_tokens: &[String],
    query_phrases: &[String],
    now_ms: i64,
) -> f64 {
    let title = entry.title.to_lowercase();
    let mode = entry.mode.to_lowercase();
    let provider = entry.provider.to_lowercase();
    let messages = entry.messages_json.to_lowercase();
    let review = entry.review_json.clone().unwrap_or_default().to_lowercase();
    let haystack = format!("{} {} {} {} {}", title, mode, provider, messages, review);

    let mut score = 0.0f64;
    for token in query_tokens {
        if haystack.contains(token) {
            score += 2.0;
        }
        if title.contains(token) {
            score += 2.0;
        }
        if title == *token || mode == *token || provider == *token {
            score += 3.0;
        }
    }

    score += apply_phrase_bonus(
        &haystack,
        query_phrases,
        &[&title],
        &[&title, &mode, &provider],
    );

    let age_hours = (((now_ms - entry.created_at).max(1)) as f64) / 3_600_000.0;
    score + (3.0 - age_hours.log10()).max(0.0)
}

fn score_memory(
    entry: &LearningMemoryPayload,
    query_tokens: &[String],
    query_phrases: &[String],
    now_ms: i64,
) -> f64 {
    let content = entry.content.to_lowercase();
    let source = entry.source.to_lowercase();
    let haystack = format!("{} {}", content, source);

    let mut score = if entry.pinned { 4.0 } else { 0.0 };
    for token in query_tokens {
        if haystack.contains(token) {
            score += 3.0;
        }
        if source.contains(token) {
            score += 1.0;
        }
        if source == *token {
            score += 2.5;
        }
    }

    score += apply_phrase_bonus(&haystack, query_phrases, &[&source], &[&source, &content]);

    let age_hours =
        (((now_ms - entry.updated_at.max(entry.created_at)).max(1)) as f64) / 3_600_000.0;
    score + (2.5 - age_hours.log10()).max(0.0)
}

pub async fn ensure_schema() -> Result<(), String> {
    let db = ensure_db_ready().await?;
    db.query(
        r#"
        DEFINE TABLE IF NOT EXISTS learning_session SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS session_id ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS thread_id ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS title ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS work_dir ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS mode ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS provider ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS user_message ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS assistant_summary ON learning_session TYPE string;
        DEFINE FIELD IF NOT EXISTS tool_names ON learning_session TYPE array;
        DEFINE FIELD IF NOT EXISTS saved_files ON learning_session TYPE array;
        DEFINE FIELD IF NOT EXISTS artifact_names ON learning_session TYPE array;
        DEFINE FIELD IF NOT EXISTS created_at ON learning_session TYPE number;
        DEFINE INDEX IF NOT EXISTS idx_learning_session_id ON learning_session FIELDS session_id UNIQUE;
        DEFINE INDEX IF NOT EXISTS idx_learning_session_work_dir ON learning_session FIELDS work_dir;

        DEFINE TABLE IF NOT EXISTS learning_skill SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS skill_id ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS work_dir ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS name ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS description ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS command ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS cli_type ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS category ON learning_skill TYPE string;
        DEFINE FIELD IF NOT EXISTS source_thread ON learning_skill TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS created_at ON learning_skill TYPE number;
        DEFINE FIELD IF NOT EXISTS updated_at ON learning_skill TYPE number;
        DEFINE INDEX IF NOT EXISTS idx_learning_skill_id ON learning_skill FIELDS skill_id UNIQUE;
        DEFINE INDEX IF NOT EXISTS idx_learning_skill_work_dir ON learning_skill FIELDS work_dir;

        DEFINE TABLE IF NOT EXISTS learning_memory SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS memory_id ON learning_memory TYPE string;
        DEFINE FIELD IF NOT EXISTS work_dir ON learning_memory TYPE string;
        DEFINE FIELD IF NOT EXISTS content ON learning_memory TYPE string;
        DEFINE FIELD IF NOT EXISTS source ON learning_memory TYPE string;
        DEFINE FIELD IF NOT EXISTS pinned ON learning_memory TYPE bool;
        DEFINE FIELD IF NOT EXISTS created_at ON learning_memory TYPE number;
        DEFINE FIELD IF NOT EXISTS updated_at ON learning_memory TYPE number;
        DEFINE INDEX IF NOT EXISTS idx_learning_memory_id ON learning_memory FIELDS memory_id UNIQUE;
        DEFINE INDEX IF NOT EXISTS idx_learning_memory_work_dir ON learning_memory FIELDS work_dir;

        DEFINE TABLE IF NOT EXISTS learning_trajectory SCHEMALESS;
        DEFINE FIELD IF NOT EXISTS trajectory_id ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS thread_id ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS work_dir ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS title ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS mode ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS provider ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS messages_json ON learning_trajectory TYPE string;
        DEFINE FIELD IF NOT EXISTS review_json ON learning_trajectory TYPE option<string>;
        DEFINE FIELD IF NOT EXISTS created_at ON learning_trajectory TYPE number;
        DEFINE INDEX IF NOT EXISTS idx_learning_trajectory_id ON learning_trajectory FIELDS trajectory_id UNIQUE;
        DEFINE INDEX IF NOT EXISTS idx_learning_trajectory_work_dir ON learning_trajectory FIELDS work_dir;
        "#,
    )
    .await
    .map_err(|e| format!("Learning DB schema setup failed: {e}"))?;
    Ok(())
}

pub async fn upsert_session(entry: LearningSessionPayload) -> Result<(), String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let _ = upsert_session_fts(&entry);
    let payload = serde_json::to_value(&entry)
        .map_err(|e| format!("Learning DB serialize session failed: {e}"))?;
    db.query("DELETE learning_session WHERE session_id = $session_id")
        .bind(("session_id", entry.id.clone()))
        .await
        .map_err(|e| format!("Learning DB delete session failed: {e}"))?;
    db.query("CREATE learning_session CONTENT { session_id: $session_id, payload: $payload, work_dir: $work_dir, thread_id: $thread_id, title: $title, mode: $mode, provider: $provider, user_message: $user_message, assistant_summary: $assistant_summary, tool_names: $tool_names, saved_files: $saved_files, artifact_names: $artifact_names, created_at: $created_at }")
        .bind(("session_id", entry.id))
        .bind(("payload", payload))
        .bind(("work_dir", entry.work_dir))
        .bind(("thread_id", entry.thread_id))
        .bind(("title", entry.title))
        .bind(("mode", entry.mode))
        .bind(("provider", entry.provider))
        .bind(("user_message", entry.user_message))
        .bind(("assistant_summary", entry.assistant_summary))
        .bind(("tool_names", entry.tool_names))
        .bind(("saved_files", entry.saved_files))
        .bind(("artifact_names", entry.artifact_names))
        .bind(("created_at", entry.created_at))
        .await
        .map_err(|e| format!("Learning DB insert session failed: {e}"))?;
    Ok(())
}

pub async fn list_sessions(work_dir: String) -> Result<Vec<LearningSessionPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let mut result = db
        .query("SELECT payload FROM learning_session WHERE work_dir = $work_dir ORDER BY created_at DESC LIMIT 200")
        .bind(("work_dir", work_dir))
        .await
        .map_err(|e| format!("Learning DB list sessions failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse sessions failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningSessionPayload>(payload.clone()) {
                out.push(parsed);
            }
        }
    }
    Ok(out)
}

pub async fn search_sessions(
    params: LearningSessionSearchParams,
) -> Result<Vec<LearningSessionPayload>, String> {
    let fts_ids = search_fts_ids(
        "learning_session_fts",
        &params.work_dir,
        &params.query,
        params.limit.unwrap_or(6).max(1) * 8,
    )
    .unwrap_or_default();
    if !fts_ids.is_empty() {
        let thread_filter = params.thread_id.as_deref();
        let ordered = reorder_by_ids(
            list_sessions(params.work_dir.clone()).await?,
            &fts_ids,
            |entry| entry.id.as_str(),
        )
        .into_iter()
        .filter(|entry| {
            thread_filter
                .map(|thread_id| entry.thread_id.as_str() != thread_id)
                .unwrap_or(true)
        })
        .take(params.limit.unwrap_or(6).max(1))
        .collect::<Vec<_>>();
        if !ordered.is_empty() {
            return Ok(ordered);
        }
    }

    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let fetch_limit = (params.limit.unwrap_or(6).max(1) * 40).min(400);
    let mut result = db
        .query("SELECT payload FROM learning_session WHERE work_dir = $work_dir ORDER BY created_at DESC LIMIT $limit")
        .bind(("work_dir", params.work_dir.clone()))
        .bind(("limit", fetch_limit))
        .await
        .map_err(|e| format!("Learning DB search sessions failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse searched sessions failed: {e}"))?;

    let mut entries = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningSessionPayload>(payload.clone()) {
                entries.push(parsed);
            }
        }
    }

    let query_tokens = tokenize_for_search(&params.query);
    let query_phrases = extract_query_phrases(&params.query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let thread_filter = params.thread_id.as_deref();
    let limit = params.limit.unwrap_or(6).max(1);

    let mut scored: Vec<(LearningSessionPayload, f64)> = entries
        .into_iter()
        .filter(|entry| {
            thread_filter
                .map(|thread_id| entry.thread_id.as_str() != thread_id)
                .unwrap_or(true)
        })
        .map(|entry| {
            let score = score_session(&entry, &query_tokens, &query_phrases, now_ms);
            (entry, score)
        })
        .filter(|(_, score)| *score > 3.0)
        .collect();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.created_at.cmp(&a.0.created_at))
    });

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(entry, _)| entry)
        .collect())
}

pub async fn list_skills(work_dir: String) -> Result<Vec<LearningSkillPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let mut result = db
        .query("SELECT payload FROM learning_skill WHERE work_dir = $work_dir ORDER BY updated_at DESC LIMIT 200")
        .bind(("work_dir", work_dir))
        .await
        .map_err(|e| format!("Learning DB list skills failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse skills failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningSkillPayload>(payload.clone()) {
                out.push(parsed);
            }
        }
    }
    Ok(out)
}

pub async fn search_skills(
    params: LearningSkillSearchParams,
) -> Result<Vec<LearningSkillPayload>, String> {
    let fts_ids = search_fts_ids(
        "learning_skill_fts",
        &params.work_dir,
        &params.query,
        params.limit.unwrap_or(8).max(1) * 8,
    )
    .unwrap_or_default();
    if !fts_ids.is_empty() {
        let ordered = reorder_by_ids(
            list_skills(params.work_dir.clone()).await?,
            &fts_ids,
            |entry| entry.id.as_str(),
        )
        .into_iter()
        .take(params.limit.unwrap_or(8).max(1))
        .collect::<Vec<_>>();
        if !ordered.is_empty() {
            return Ok(ordered);
        }
    }

    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let fetch_limit = (params.limit.unwrap_or(8).max(1) * 30).min(300);
    let mut result = db
        .query("SELECT payload FROM learning_skill WHERE work_dir = $work_dir ORDER BY updated_at DESC LIMIT $limit")
        .bind(("work_dir", params.work_dir.clone()))
        .bind(("limit", fetch_limit))
        .await
        .map_err(|e| format!("Learning DB search skills failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse searched skills failed: {e}"))?;

    let mut entries = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningSkillPayload>(payload.clone()) {
                entries.push(parsed);
            }
        }
    }

    let query_tokens = tokenize_for_search(&params.query);
    let query_phrases = extract_query_phrases(&params.query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let limit = params.limit.unwrap_or(8).max(1);
    let mut scored: Vec<(LearningSkillPayload, f64)> = entries
        .into_iter()
        .map(|entry| {
            let score = score_skill(&entry, &query_tokens, &query_phrases);
            (entry, score)
        })
        .filter(|(_, score)| *score > 2.0)
        .collect();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.updated_at.cmp(&a.0.updated_at))
    });

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(entry, _)| entry)
        .collect())
}

pub async fn upsert_skills(
    skills: Vec<LearningSkillPayload>,
) -> Result<Vec<LearningSkillPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    for skill in skills {
        let _ = upsert_skill_fts(&skill);
        let payload = serde_json::to_value(&skill)
            .map_err(|e| format!("Learning DB serialize skill failed: {e}"))?;
        db.query("DELETE learning_skill WHERE skill_id = $skill_id")
            .bind(("skill_id", skill.id.clone()))
            .await
            .map_err(|e| format!("Learning DB delete skill failed: {e}"))?;
        db.query("CREATE learning_skill CONTENT { skill_id: $skill_id, payload: $payload, work_dir: $work_dir, name: $name, description: $description, command: $command, cli_type: $cli_type, category: $category, source_thread: $source_thread, created_at: $created_at, updated_at: $updated_at }")
            .bind(("skill_id", skill.id))
            .bind(("payload", payload))
            .bind(("work_dir", skill.work_dir))
            .bind(("name", skill.name))
            .bind(("description", skill.description))
            .bind(("command", skill.command))
            .bind(("cli_type", skill.cli_type))
            .bind(("category", skill.category))
            .bind(("source_thread", skill.source_thread))
            .bind(("created_at", skill.created_at))
            .bind(("updated_at", skill.updated_at))
            .await
            .map_err(|e| format!("Learning DB insert skill failed: {e}"))?;
    }
    // Return grouped by work_dir from the last inserted batch is awkward here; caller will re-read.
    Ok(Vec::new())
}

pub async fn list_memories(work_dir: String) -> Result<Vec<LearningMemoryPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let mut result = db
        .query("SELECT payload FROM learning_memory WHERE work_dir = $work_dir ORDER BY pinned DESC, updated_at DESC LIMIT 300")
        .bind(("work_dir", work_dir))
        .await
        .map_err(|e| format!("Learning DB list memories failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse memories failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningMemoryPayload>(payload.clone()) {
                out.push(parsed);
            }
        }
    }
    Ok(out)
}

pub async fn search_memories(
    params: LearningMemorySearchParams,
) -> Result<Vec<LearningMemoryPayload>, String> {
    let fts_ids = search_fts_ids(
        "learning_memory_fts",
        &params.work_dir,
        &params.query,
        params.limit.unwrap_or(8).max(1) * 8,
    )
    .unwrap_or_default();
    if !fts_ids.is_empty() {
        let ordered = reorder_by_ids(
            list_memories(params.work_dir.clone()).await?,
            &fts_ids,
            |entry| entry.id.as_str(),
        )
        .into_iter()
        .take(params.limit.unwrap_or(8).max(1))
        .collect::<Vec<_>>();
        if !ordered.is_empty() {
            return Ok(ordered);
        }
    }

    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let fetch_limit = (params.limit.unwrap_or(8).max(1) * 30).min(300);
    let mut result = db
        .query("SELECT payload FROM learning_memory WHERE work_dir = $work_dir ORDER BY pinned DESC, updated_at DESC LIMIT $limit")
        .bind(("work_dir", params.work_dir.clone()))
        .bind(("limit", fetch_limit))
        .await
        .map_err(|e| format!("Learning DB search memories failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse searched memories failed: {e}"))?;

    let mut entries = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningMemoryPayload>(payload.clone()) {
                entries.push(parsed);
            }
        }
    }

    let query_tokens = tokenize_for_search(&params.query);
    let query_phrases = extract_query_phrases(&params.query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let limit = params.limit.unwrap_or(8).max(1);

    let mut scored: Vec<(LearningMemoryPayload, f64)> = entries
        .into_iter()
        .map(|entry| {
            let score = score_memory(&entry, &query_tokens, &query_phrases, now_ms);
            (entry, score)
        })
        .filter(|(_, score)| *score > 2.0)
        .collect();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.updated_at.cmp(&a.0.updated_at))
    });

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(entry, _)| entry)
        .collect())
}

pub async fn upsert_memories(
    memories: Vec<LearningMemoryPayload>,
) -> Result<Vec<LearningMemoryPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    for memory in memories {
        let _ = upsert_memory_fts(&memory);
        let payload = serde_json::to_value(&memory)
            .map_err(|e| format!("Learning DB serialize memory failed: {e}"))?;
        db.query("DELETE learning_memory WHERE memory_id = $memory_id")
            .bind(("memory_id", memory.id.clone()))
            .await
            .map_err(|e| format!("Learning DB delete memory failed: {e}"))?;
        db.query("CREATE learning_memory CONTENT { memory_id: $memory_id, payload: $payload, work_dir: $work_dir, content: $content, source: $source, pinned: $pinned, created_at: $created_at, updated_at: $updated_at }")
            .bind(("memory_id", memory.id))
            .bind(("payload", payload))
            .bind(("work_dir", memory.work_dir))
            .bind(("content", memory.content))
            .bind(("source", memory.source))
            .bind(("pinned", memory.pinned))
            .bind(("created_at", memory.created_at))
            .bind(("updated_at", memory.updated_at))
            .await
            .map_err(|e| format!("Learning DB insert memory failed: {e}"))?;
    }
    Ok(Vec::new())
}

pub async fn append_trajectory(entry: LearningTrajectoryPayload) -> Result<(), String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let _ = upsert_trajectory_fts(&entry);
    let payload = serde_json::to_value(&entry)
        .map_err(|e| format!("Learning DB serialize trajectory failed: {e}"))?;
    db.query("DELETE learning_trajectory WHERE trajectory_id = $trajectory_id")
        .bind(("trajectory_id", entry.id.clone()))
        .await
        .map_err(|e| format!("Learning DB delete trajectory failed: {e}"))?;
    db.query("CREATE learning_trajectory CONTENT { trajectory_id: $trajectory_id, payload: $payload, thread_id: $thread_id, work_dir: $work_dir, title: $title, mode: $mode, provider: $provider, messages_json: $messages_json, review_json: $review_json, created_at: $created_at }")
        .bind(("trajectory_id", entry.id))
        .bind(("payload", payload))
        .bind(("thread_id", entry.thread_id))
        .bind(("work_dir", entry.work_dir))
        .bind(("title", entry.title))
        .bind(("mode", entry.mode))
        .bind(("provider", entry.provider))
        .bind(("messages_json", entry.messages_json))
        .bind(("review_json", entry.review_json))
        .bind(("created_at", entry.created_at))
        .await
        .map_err(|e| format!("Learning DB insert trajectory failed: {e}"))?;
    Ok(())
}

pub async fn list_trajectories(work_dir: String) -> Result<Vec<LearningTrajectoryPayload>, String> {
    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let mut result = db
        .query("SELECT payload FROM learning_trajectory WHERE work_dir = $work_dir ORDER BY created_at DESC LIMIT 200")
        .bind(("work_dir", work_dir))
        .await
        .map_err(|e| format!("Learning DB list trajectories failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse trajectories failed: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningTrajectoryPayload>(payload.clone())
            {
                out.push(parsed);
            }
        }
    }
    Ok(out)
}

pub async fn search_trajectories(
    params: LearningTrajectorySearchParams,
) -> Result<Vec<LearningTrajectoryPayload>, String> {
    let fts_ids = search_fts_ids(
        "learning_trajectory_fts",
        &params.work_dir,
        &params.query,
        params.limit.unwrap_or(6).max(1) * 8,
    )
    .unwrap_or_default();
    if !fts_ids.is_empty() {
        let thread_filter = params.thread_id.as_deref();
        let ordered = reorder_by_ids(
            list_trajectories(params.work_dir.clone()).await?,
            &fts_ids,
            |entry| entry.id.as_str(),
        )
        .into_iter()
        .filter(|entry| {
            thread_filter
                .map(|thread_id| entry.thread_id.as_str() != thread_id)
                .unwrap_or(true)
        })
        .take(params.limit.unwrap_or(6).max(1))
        .collect::<Vec<_>>();
        if !ordered.is_empty() {
            return Ok(ordered);
        }
    }

    let db = ensure_db_ready().await?;
    ensure_schema().await?;
    let fetch_limit = (params.limit.unwrap_or(6).max(1) * 30).min(300);
    let mut result = db
        .query("SELECT payload FROM learning_trajectory WHERE work_dir = $work_dir ORDER BY created_at DESC LIMIT $limit")
        .bind(("work_dir", params.work_dir.clone()))
        .bind(("limit", fetch_limit))
        .await
        .map_err(|e| format!("Learning DB search trajectories failed: {e}"))?;
    let rows: Vec<Value> = result
        .take(0)
        .map_err(|e| format!("Learning DB parse searched trajectories failed: {e}"))?;

    let mut entries = Vec::new();
    for row in rows {
        if let Some(payload) = row.get("payload") {
            if let Ok(parsed) = serde_json::from_value::<LearningTrajectoryPayload>(payload.clone())
            {
                entries.push(parsed);
            }
        }
    }

    let query_tokens = tokenize_for_search(&params.query);
    let query_phrases = extract_query_phrases(&params.query);
    if query_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let thread_filter = params.thread_id.as_deref();
    let limit = params.limit.unwrap_or(6).max(1);

    let mut scored: Vec<(LearningTrajectoryPayload, f64)> = entries
        .into_iter()
        .filter(|entry| {
            thread_filter
                .map(|thread_id| entry.thread_id.as_str() != thread_id)
                .unwrap_or(true)
        })
        .map(|entry| {
            let score = score_trajectory(&entry, &query_tokens, &query_phrases, now_ms);
            (entry, score)
        })
        .filter(|(_, score)| *score > 2.0)
        .collect();

    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.0.created_at.cmp(&a.0.created_at))
    });

    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(entry, _)| entry)
        .collect())
}

pub async fn search_all(
    params: LearningUnifiedSearchParams,
) -> Result<LearningUnifiedSearchResult, String> {
    let session_limit = params.session_limit.unwrap_or(3).max(1);
    let skill_limit = params.skill_limit.unwrap_or(4).max(1);
    let memory_limit = params.memory_limit.unwrap_or(4).max(1);
    let trajectory_limit = params.trajectory_limit.unwrap_or(2).max(1);

    let sessions = search_sessions(LearningSessionSearchParams {
        work_dir: params.work_dir.clone(),
        query: params.query.clone(),
        thread_id: params.thread_id.clone(),
        limit: Some(session_limit),
    })
    .await?;

    let skills = search_skills(LearningSkillSearchParams {
        work_dir: params.work_dir.clone(),
        query: params.query.clone(),
        limit: Some(skill_limit),
    })
    .await?;

    let memories = search_memories(LearningMemorySearchParams {
        work_dir: params.work_dir.clone(),
        query: params.query.clone(),
        limit: Some(memory_limit),
    })
    .await?;

    let trajectories = search_trajectories(LearningTrajectorySearchParams {
        work_dir: params.work_dir,
        query: params.query,
        thread_id: params.thread_id,
        limit: Some(trajectory_limit),
    })
    .await?;

    let mut sources = Vec::new();
    if !memories.is_empty() {
        sources.push(format!("memory:{}", memories.len()));
    }
    if !sessions.is_empty() {
        sources.push(format!("session:{}", sessions.len()));
    }
    if !trajectories.is_empty() {
        sources.push(format!("trajectory:{}", trajectories.len()));
    }
    if !skills.is_empty() {
        sources.push(format!("skill:{}", skills.len()));
    }

    Ok(LearningUnifiedSearchResult {
        sessions,
        skills,
        memories,
        trajectories,
        sources,
    })
}

async fn ensure_db_ready() -> Result<std::sync::Arc<Surreal<Db>>, String> {
    crate::db::get_db().or_else(|_| Err("SurrealDB not ready".to_string()))
}
