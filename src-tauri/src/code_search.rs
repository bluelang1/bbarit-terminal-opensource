use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const DESIRED_CHUNK_CHARS: usize = 1_500;
const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_FILES_SCANNED: usize = 20_000;
const CACHE_MAX_ENTRIES: usize = 8;
const BM25_K1: f64 = 1.5;
const BM25_B: f64 = 0.75;
const RRF_K: f64 = 60.0;
const EMBEDDING_DIMS: usize = 256;

const IGNORE_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "coverage",
];

const CODE_EXTENSIONS: &[(&str, &str)] = &[
    ("py", "python"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("go", "go"),
    ("rs", "rust"),
    ("java", "java"),
    ("kt", "kotlin"),
    ("kts", "kotlin"),
    ("rb", "ruby"),
    ("php", "php"),
    ("c", "c"),
    ("h", "c"),
    ("cpp", "cpp"),
    ("hpp", "cpp"),
    ("cc", "cpp"),
    ("cs", "csharp"),
    ("swift", "swift"),
    ("scala", "scala"),
    ("sbt", "scala"),
    ("ex", "elixir"),
    ("exs", "elixir"),
    ("dart", "dart"),
    ("lua", "lua"),
    ("sql", "sql"),
    ("sh", "bash"),
    ("bash", "bash"),
    ("zsh", "bash"),
    ("zig", "zig"),
    ("hs", "haskell"),
];

const TEXT_EXTENSIONS: &[(&str, &str)] = &[
    ("md", "markdown"),
    ("yaml", "yaml"),
    ("yml", "yaml"),
    ("toml", "toml"),
    ("json", "json"),
];

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "has", "have",
    "how", "if", "in", "is", "it", "not", "of", "on", "or", "the", "to", "was", "what", "when",
    "where", "which", "who", "why", "with",
];

#[derive(Clone)]
struct CodeChunk {
    content: String,
    abs_path: PathBuf,
    rel_path: String,
    start_line: usize,
    end_line: usize,
    language: Option<String>,
}

#[derive(Clone)]
struct IndexedChunk {
    chunk: CodeChunk,
    term_freq: HashMap<String, usize>,
    doc_len: usize,
    semantic_vector: Vec<f32>,
}

struct CodeSearchIndex {
    root: PathBuf,
    include_text_files: bool,
    chunks: Vec<IndexedChunk>,
    idf: HashMap<String, f64>,
    avg_doc_len: f64,
    indexed_files: usize,
    files_scanned: usize,
    latest_mtime: SystemTime,
}

#[derive(Serialize, Clone)]
pub struct CodeSearchResult {
    pub path: String,
    pub file_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub language: Option<String>,
    pub score: f64,
    pub source: String,
    pub snippet: String,
}

#[derive(Serialize, Clone)]
pub struct CodeSearchStats {
    pub root: String,
    pub indexed_files: usize,
    pub total_chunks: usize,
    pub files_scanned: usize,
    pub languages: HashMap<String, usize>,
    pub include_text_files: bool,
}

#[derive(Serialize, Clone)]
pub struct CodeSearchSavings {
    pub calls: usize,
    pub snippet_chars: usize,
    pub file_chars: usize,
    pub saved_tokens: usize,
    pub saved_percent: u8,
}

struct CacheEntry {
    index: Arc<CodeSearchIndex>,
    last_used: u64,
}

#[derive(Default)]
struct SearchCache {
    tick: u64,
    entries: HashMap<String, CacheEntry>,
}

fn cache() -> &'static Mutex<SearchCache> {
    static CACHE: OnceLock<Mutex<SearchCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SearchCache::default()))
}

pub fn clear_cache(root: Option<String>) -> Result<(), String> {
    let mut guard = cache().lock().map_err(|e| e.to_string())?;
    if let Some(root) = root {
        let root = Path::new(&root)
            .canonicalize()
            .map_err(|e| format!("Invalid root: {e}"))?;
        let prefix = root.to_string_lossy().to_string();
        guard.entries.retain(|key, _| !key.starts_with(&prefix));
    } else {
        guard.entries.clear();
    }
    Ok(())
}

pub fn savings() -> Result<CodeSearchSavings, String> {
    let Some(path) = savings_file_path() else {
        return Ok(CodeSearchSavings {
            calls: 0,
            snippet_chars: 0,
            file_chars: 0,
            saved_tokens: 0,
            saved_percent: 0,
        });
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(CodeSearchSavings {
            calls: 0,
            snippet_chars: 0,
            file_chars: 0,
            saved_tokens: 0,
            saved_percent: 0,
        });
    };

    let mut calls = 0usize;
    let mut snippet_chars = 0usize;
    let mut file_chars = 0usize;
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        calls += 1;
        snippet_chars += value
            .get("snippet_chars")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        file_chars += value
            .get("file_chars")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
    }
    let saved_chars = file_chars.saturating_sub(snippet_chars);
    let saved_percent = if file_chars > 0 {
        ((saved_chars as f64 / file_chars as f64) * 100.0).round() as u8
    } else {
        0
    };
    Ok(CodeSearchSavings {
        calls,
        snippet_chars,
        file_chars,
        saved_tokens: saved_chars / 4,
        saved_percent,
    })
}

pub fn stats(root: String, include_text_files: Option<bool>) -> Result<CodeSearchStats, String> {
    let index = get_index(root, include_text_files.unwrap_or(false))?;
    Ok(index.stats())
}

pub fn search(
    root: String,
    query: String,
    limit: Option<usize>,
    mode: Option<String>,
    include_text_files: Option<bool>,
) -> Result<Vec<CodeSearchResult>, String> {
    let index = get_index(root, include_text_files.unwrap_or(false))?;
    let mode = RetrievalMode::parse(mode.as_deref())?;
    let results = index.search(&query, limit.unwrap_or(8).clamp(1, 50), None, mode);
    save_search_stats(&results);
    Ok(results)
}

pub fn find_related(
    root: String,
    file_path: String,
    line: usize,
    limit: Option<usize>,
    include_text_files: Option<bool>,
) -> Result<Vec<CodeSearchResult>, String> {
    let index = get_index(root, include_text_files.unwrap_or(false))?;
    let source = index
        .chunks
        .iter()
        .find(|item| {
            item.chunk.rel_path == file_path
                && item.chunk.start_line <= line
                && line <= item.chunk.end_line
        })
        .ok_or_else(|| format!("No indexed chunk found at {file_path}:{line}"))?;
    let query = related_query(&source.chunk.content);
    let mut results = index.search(
        &query,
        limit.unwrap_or(8).clamp(1, 50) + 1,
        source.chunk.language.as_deref(),
        RetrievalMode::Hybrid,
    );
    results.retain(|r| {
        !(r.file_path == source.chunk.rel_path && r.start_line == source.chunk.start_line)
    });
    results.truncate(limit.unwrap_or(8).clamp(1, 50));
    Ok(results)
}

fn get_index(root: String, include_text_files: bool) -> Result<Arc<CodeSearchIndex>, String> {
    let root = Path::new(&root)
        .canonicalize()
        .map_err(|e| format!("Invalid root: {e}"))?;
    if !root.is_dir() {
        return Err("Root path is not a directory".to_string());
    }
    let key = format!("{}::text={}", root.to_string_lossy(), include_text_files);
    let latest_mtime = latest_project_mtime(&root)?;

    {
        let mut guard = cache().lock().map_err(|e| e.to_string())?;
        guard.tick += 1;
        let tick = guard.tick;
        if let Some(entry) = guard.entries.get_mut(&key) {
            if entry.index.latest_mtime >= latest_mtime {
                entry.last_used = tick;
                return Ok(Arc::clone(&entry.index));
            }
        }
    }

    let index = Arc::new(CodeSearchIndex::build(
        root,
        include_text_files,
        latest_mtime,
    )?);
    let mut guard = cache().lock().map_err(|e| e.to_string())?;
    guard.tick += 1;
    let tick = guard.tick;
    guard.entries.insert(
        key,
        CacheEntry {
            index: Arc::clone(&index),
            last_used: tick,
        },
    );
    while guard.entries.len() > CACHE_MAX_ENTRIES {
        if let Some(oldest_key) = guard
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(key, _)| key.clone())
        {
            guard.entries.remove(&oldest_key);
        } else {
            break;
        }
    }
    Ok(index)
}

impl CodeSearchIndex {
    fn build(
        root: PathBuf,
        include_text_files: bool,
        latest_mtime: SystemTime,
    ) -> Result<Self, String> {
        let mut chunks = Vec::new();
        let mut indexed_files = 0usize;
        let mut files_scanned = 0usize;

        for path in walk_files(&root, include_text_files, &mut files_scanned) {
            let meta = match std::fs::metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.len() == 0 || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let source = match std::fs::read_to_string(&path) {
                Ok(source) => source,
                Err(_) => continue,
            };
            let rel_path = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let language = language_for_path(&path, include_text_files).map(str::to_string);
            let file_chunks = chunk_source(&source, path.clone(), rel_path, language);
            if !file_chunks.is_empty() {
                indexed_files += 1;
            }
            for chunk in file_chunks {
                let mut tokens = tokenize_index_text(&chunk.content);
                tokens.extend(tokenize_path(&chunk.rel_path));
                if tokens.is_empty() {
                    continue;
                }
                let doc_len = tokens.len();
                let semantic_vector = embed_tokens(&tokens);
                let mut term_freq = HashMap::new();
                for token in tokens {
                    *term_freq.entry(token).or_insert(0) += 1;
                }
                chunks.push(IndexedChunk {
                    chunk,
                    term_freq,
                    doc_len,
                    semantic_vector,
                });
            }
        }

        if chunks.is_empty() {
            return Err(format!("No supported files found under {}", root.display()));
        }

        let mut document_frequency: HashMap<String, usize> = HashMap::new();
        let total_len: usize = chunks.iter().map(|item| item.doc_len).sum();
        for item in &chunks {
            for term in item.term_freq.keys() {
                *document_frequency.entry(term.clone()).or_insert(0) += 1;
            }
        }
        let n_docs = chunks.len() as f64;
        let idf = document_frequency
            .into_iter()
            .map(|(term, df)| {
                let df = df as f64;
                (term, ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln())
            })
            .collect();

        Ok(Self {
            root,
            include_text_files,
            chunks,
            idf,
            avg_doc_len: total_len as f64 / n_docs,
            indexed_files,
            files_scanned,
            latest_mtime,
        })
    }

    fn stats(&self) -> CodeSearchStats {
        let mut languages = HashMap::new();
        for item in &self.chunks {
            if let Some(language) = &item.chunk.language {
                *languages.entry(language.clone()).or_insert(0) += 1;
            }
        }
        CodeSearchStats {
            root: self.root.to_string_lossy().to_string(),
            indexed_files: self.indexed_files,
            total_chunks: self.chunks.len(),
            files_scanned: self.files_scanned,
            languages,
            include_text_files: self.include_text_files,
        }
    }

    fn search(
        &self,
        query: &str,
        limit: usize,
        language_filter: Option<&str>,
        mode: RetrievalMode,
    ) -> Vec<CodeSearchResult> {
        if query.trim().is_empty() {
            return Vec::new();
        }
        let query_terms = tokenize_query(query);
        if mode != RetrievalMode::Bm25 && query_terms.is_empty() {
            return Vec::new();
        }

        let is_symbol = is_symbol_query(query);
        let candidate_count = (limit * 5).max(limit).min(self.chunks.len().max(1));
        let mut scored = match mode {
            RetrievalMode::Bm25 => self.literal_scores(query, candidate_count, language_filter),
            RetrievalMode::Semantic => {
                self.semantic_scores(&query_terms, candidate_count, language_filter)
            }
            RetrievalMode::Hybrid => {
                let bm25 = self.bm25_scores(&query_terms, candidate_count, language_filter);
                let semantic = self.semantic_scores(&query_terms, candidate_count, language_filter);
                fuse_rrf(&semantic, &bm25, if is_symbol { 0.3 } else { 0.5 })
            }
        };

        let penalise_paths = mode != RetrievalMode::Semantic;
        for (idx, score) in &mut scored {
            let item = &self.chunks[*idx];
            *score = apply_ranking_boosts(
                *score,
                query,
                &query_terms,
                &item.chunk,
                is_symbol,
                penalise_paths,
            );
        }
        scored.retain(|(_, score)| *score > 0.0);
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        apply_file_saturation(scored, &self.chunks, limit)
            .into_iter()
            .map(|(idx, score)| self.result_for(idx, score, mode))
            .collect()
    }

    fn bm25_scores(
        &self,
        query_terms: &[String],
        candidate_count: usize,
        language_filter: Option<&str>,
    ) -> Vec<(usize, f64)> {
        let mut scored = Vec::new();
        for (idx, item) in self.chunks.iter().enumerate() {
            if let Some(language) = language_filter {
                if item.chunk.language.as_deref() != Some(language) {
                    continue;
                }
            }
            let mut score = 0.0;
            for term in query_terms {
                let Some(tf) = item.term_freq.get(term) else {
                    continue;
                };
                let idf = self.idf.get(term).copied().unwrap_or(0.0);
                let tf = *tf as f64;
                let denom =
                    tf + BM25_K1 * (1.0 - BM25_B + BM25_B * item.doc_len as f64 / self.avg_doc_len);
                score += idf * (tf * (BM25_K1 + 1.0)) / denom;
            }
            if score <= 0.0 {
                continue;
            }
            scored.push((idx, score));
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(candidate_count);
        scored
    }

    fn literal_scores(
        &self,
        query: &str,
        candidate_count: usize,
        language_filter: Option<&str>,
    ) -> Vec<(usize, f64)> {
        let groups = parse_literal_query(query);
        if groups.is_empty() {
            return Vec::new();
        }
        let mut scored = Vec::new();
        for (idx, item) in self.chunks.iter().enumerate() {
            if let Some(language) = language_filter {
                if item.chunk.language.as_deref() != Some(language) {
                    continue;
                }
            }
            let content_lower = item.chunk.content.to_lowercase();
            let path_lower = item.chunk.rel_path.to_lowercase();
            let mut best_score = 0.0_f64;
            for group in &groups {
                let all_match = group
                    .iter()
                    .all(|t| content_lower.contains(t) || path_lower.contains(t));
                if !all_match {
                    continue;
                }
                let mut score = 0.0;
                for t in group {
                    score += count_substring(&content_lower, t) as f64;
                    score += count_substring(&path_lower, t) as f64 * 5.0;
                }
                if score > best_score {
                    best_score = score;
                }
            }
            if best_score > 0.0 {
                scored.push((idx, best_score));
            }
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(candidate_count);
        scored
    }

    fn semantic_scores(
        &self,
        query_terms: &[String],
        candidate_count: usize,
        language_filter: Option<&str>,
    ) -> Vec<(usize, f64)> {
        let query_vector = embed_tokens(query_terms);
        let mut scored = Vec::new();
        for (idx, item) in self.chunks.iter().enumerate() {
            if let Some(language) = language_filter {
                if item.chunk.language.as_deref() != Some(language) {
                    continue;
                }
            }
            let score = cosine_similarity(&query_vector, &item.semantic_vector);
            if score > 0.0 {
                scored.push((idx, score));
            }
        }
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(candidate_count);
        scored
    }

    fn result_for(&self, idx: usize, score: f64, source: RetrievalMode) -> CodeSearchResult {
        let chunk = &self.chunks[idx].chunk;
        CodeSearchResult {
            path: chunk.abs_path.to_string_lossy().to_string(),
            file_path: chunk.rel_path.clone(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
            language: chunk.language.clone(),
            score: (score * 1000.0).round() / 1000.0,
            source: source.as_str().to_string(),
            snippet: chunk.content.trim().to_string(),
        }
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
pub enum RetrievalMode {
    Hybrid,
    Semantic,
    Bm25,
}

impl RetrievalMode {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("hybrid").to_ascii_lowercase().as_str() {
            "hybrid" => Ok(Self::Hybrid),
            "semantic" => Ok(Self::Semantic),
            "bm25" => Ok(Self::Bm25),
            other => Err(format!("Unknown code search mode: {other}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Hybrid => "hybrid",
            Self::Semantic => "semantic",
            Self::Bm25 => "bm25",
        }
    }
}

fn walk_files(root: &Path, include_text_files: bool, files_scanned: &mut usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !should_ignore_dir(&name) {
                    dirs.push(path);
                }
            } else {
                files.push(path);
            }
        }
        dirs.sort();
        files.sort();
        for path in files {
            if *files_scanned >= MAX_FILES_SCANNED {
                return out;
            }
            *files_scanned += 1;
            if language_for_path(&path, include_text_files).is_some() {
                out.push(path);
            }
        }
        for dir in dirs.into_iter().rev() {
            stack.push(dir);
        }
    }
    out
}

fn should_ignore_dir(name: &str) -> bool {
    IGNORE_DIRS.contains(&name) || (name.starts_with('.') && name != ".github")
}

fn latest_project_mtime(root: &Path) -> Result<SystemTime, String> {
    let mut latest = SystemTime::UNIX_EPOCH;
    let mut files_scanned = 0usize;
    for path in walk_files(root, true, &mut files_scanned) {
        if let Ok(modified) = std::fs::metadata(path).and_then(|m| m.modified()) {
            if modified > latest {
                latest = modified;
            }
        }
    }
    Ok(latest)
}

fn language_for_path(path: &Path, include_text_files: bool) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    CODE_EXTENSIONS
        .iter()
        .chain(if include_text_files {
            TEXT_EXTENSIONS.iter()
        } else {
            [].iter()
        })
        .find_map(|(candidate, language)| (*candidate == ext).then_some(*language))
}

fn chunk_source(
    source: &str,
    abs_path: PathBuf,
    rel_path: String,
    language: Option<String>,
) -> Vec<CodeChunk> {
    if source.trim().is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut start_line = 1usize;
    let mut current_line = 1usize;

    for line in source.lines() {
        if current.is_empty() {
            start_line = current_line;
        }
        current.push_str(line);
        current.push('\n');
        if current.len() >= DESIRED_CHUNK_CHARS {
            chunks.push(CodeChunk {
                content: std::mem::take(&mut current),
                abs_path: abs_path.clone(),
                rel_path: rel_path.clone(),
                start_line,
                end_line: current_line,
                language: language.clone(),
            });
        }
        current_line += 1;
    }

    if !current.trim().is_empty() {
        chunks.push(CodeChunk {
            content: current,
            abs_path,
            rel_path,
            start_line,
            end_line: current_line.saturating_sub(1),
            language,
        });
    }
    chunks
}

fn tokenize_index_text(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in raw_tokens(text) {
        tokens.push(raw.clone());
        tokens.extend(split_identifier(&raw));
    }
    tokens
}

fn tokenize_query(query: &str) -> Vec<String> {
    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raw_tokens(query) {
        for token in std::iter::once(raw.clone()).chain(split_identifier(&raw).into_iter()) {
            if token.len() < 2 || stopwords.contains(token.as_str()) {
                continue;
            }
            if seen.insert(token.clone()) {
                out.push(token);
            }
        }
    }
    out
}

fn parse_literal_query(query: &str) -> Vec<Vec<String>> {
    query
        .split('|')
        .map(|or_group| {
            or_group
                .split_whitespace()
                .map(|s| s.to_lowercase())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|g| !g.is_empty())
        .collect()
}

fn count_substring(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let nlen = needle.len();
    let mut count = 0;
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        count += 1;
        start += pos + nlen;
        if start >= haystack.len() {
            break;
        }
    }
    count
}

fn tokenize_path(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in path.split(['/', '\\', '.', '-', '_']) {
        let part = part.trim();
        if part.len() < 2 {
            continue;
        }
        let lowered = part.to_lowercase();
        out.push(lowered.clone());
        out.extend(split_identifier(&lowered));
    }
    out
}

fn raw_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            current.extend(ch.to_lowercase());
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn embed_tokens(tokens: &[String]) -> Vec<f32> {
    let mut vector = vec![0.0_f32; EMBEDDING_DIMS];
    for token in tokens {
        let mut hasher = DefaultHasher::new();
        token.hash(&mut hasher);
        let hash = hasher.finish();
        let idx = (hash as usize) % EMBEDDING_DIMS;
        let sign = if (hash >> 63) == 0 { 1.0 } else { -1.0 };
        vector[idx] += sign;
    }
    normalize_vector(&mut vector);
    vector
}

fn normalize_vector(vector: &mut [f32]) {
    let norm = vector
        .iter()
        .map(|v| (*v as f64) * (*v as f64))
        .sum::<f64>()
        .sqrt();
    if norm <= f64::EPSILON {
        return;
    }
    for value in vector {
        *value = (*value as f64 / norm) as f32;
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (*x as f64) * (*y as f64))
        .sum::<f64>()
}

fn split_identifier(token: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = token.chars().collect();
    for (i, ch) in chars.iter().copied().enumerate() {
        if ch == '_' || ch == '-' {
            if current.len() > 1 {
                parts.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            continue;
        }
        let prev = i.checked_sub(1).and_then(|idx| chars.get(idx)).copied();
        if ch.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase())
            && current.len() > 1
        {
            parts.push(std::mem::take(&mut current).to_lowercase());
        }
        current.push(ch.to_ascii_lowercase());
    }
    if current.len() > 1 {
        parts.push(current);
    }
    parts
}

fn is_symbol_query(query: &str) -> bool {
    let q = query.trim();
    !q.contains(char::is_whitespace)
        && (q.contains("::")
            || q.contains('.')
            || q.contains('_')
            || q.chars()
                .next()
                .is_some_and(|c| c == '_' || c.is_ascii_uppercase())
            || q.chars().any(|c| c.is_ascii_uppercase()))
}

fn apply_ranking_boosts(
    mut score: f64,
    query: &str,
    query_terms: &[String],
    chunk: &CodeChunk,
    is_symbol: bool,
    penalise_paths: bool,
) -> f64 {
    if is_symbol {
        let symbol = query
            .trim()
            .rsplit([':', '.', '\\', '>'])
            .find(|s| !s.is_empty())
            .unwrap_or(query.trim());
        if chunk_defines_symbol(chunk, symbol) {
            score *= if stem_matches(&chunk.rel_path, symbol) {
                4.5
            } else {
                3.0
            };
        }
    } else {
        let rel_lower = chunk.rel_path.to_lowercase();
        let mut path_hits = 0usize;
        for term in query_terms {
            if term.len() > 2 && rel_lower.contains(term) {
                path_hits += 1;
            }
        }
        if path_hits > 0 {
            score *= 1.0 + (path_hits as f64 / query_terms.len().max(1) as f64);
        }
    }

    if penalise_paths {
        score *= file_path_penalty(&chunk.rel_path);
    }
    score
}

fn chunk_defines_symbol(chunk: &CodeChunk, symbol: &str) -> bool {
    let symbol_lower = symbol.to_lowercase();
    let needles = [
        format!("class {symbol_lower}"),
        format!("def {symbol_lower}"),
        format!("function {symbol_lower}"),
        format!("fn {symbol_lower}"),
        format!("struct {symbol_lower}"),
        format!("enum {symbol_lower}"),
        format!("trait {symbol_lower}"),
        format!("interface {symbol_lower}"),
        format!("type {symbol_lower}"),
        format!("const {symbol_lower}"),
        format!("let {symbol_lower}"),
        format!("var {symbol_lower}"),
        format!("create table {symbol_lower}"),
    ];
    let content = chunk.content.to_lowercase();
    needles.iter().any(|needle| content.contains(needle))
}

fn stem_matches(path: &str, symbol: &str) -> bool {
    let stem = Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let symbol = symbol.to_lowercase();
    let stem_norm = stem.replace('_', "");
    let symbol_norm = symbol.replace('_', "");
    stem == symbol || stem_norm == symbol_norm || symbol_norm.starts_with(&stem_norm)
}

fn file_path_penalty(path: &str) -> f64 {
    let p = path.replace('\\', "/").to_lowercase();
    let name = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mut penalty = 1.0;
    if p.contains("/test/")
        || p.contains("/tests/")
        || p.contains("/__tests__/")
        || name.starts_with("test_")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.ends_with("_test.rs")
        || name.ends_with("_test.go")
        || name.ends_with("_spec.rb")
    {
        penalty *= 0.3;
    }
    if name == "__init__.py" || name == "mod.rs" {
        penalty *= 0.6;
    }
    if p.contains("/examples/")
        || p.contains("/docs/")
        || p.contains("/legacy/")
        || p.contains("/compat/")
    {
        penalty *= 0.4;
    }
    if name.ends_with(".d.ts") {
        penalty *= 0.7;
    }
    penalty
}

fn apply_file_saturation(
    scored: Vec<(usize, f64)>,
    chunks: &[IndexedChunk],
    limit: usize,
) -> Vec<(usize, f64)> {
    let mut selected = Vec::new();
    let mut file_counts: HashMap<&str, usize> = HashMap::new();
    for (idx, score) in scored {
        let rel = chunks[idx].chunk.rel_path.as_str();
        let count = file_counts.entry(rel).or_insert(0);
        let effective_score = if *count == 0 {
            score
        } else {
            score * 0.5_f64.powi(*count as i32)
        };
        *count += 1;
        selected.push((idx, effective_score));
        if selected.len() >= limit * 3 {
            break;
        }
    }
    selected.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    selected.truncate(limit);
    selected
}

fn fuse_rrf(semantic: &[(usize, f64)], bm25: &[(usize, f64)], alpha: f64) -> Vec<(usize, f64)> {
    let mut combined: HashMap<usize, f64> = HashMap::new();
    for (rank, (idx, _)) in semantic.iter().enumerate() {
        *combined.entry(*idx).or_insert(0.0) += alpha / (RRF_K + rank as f64 + 1.0);
    }
    for (rank, (idx, _)) in bm25.iter().enumerate() {
        *combined.entry(*idx).or_insert(0.0) += (1.0 - alpha) / (RRF_K + rank as f64 + 1.0);
    }
    combined.into_iter().collect()
}

fn save_search_stats(results: &[CodeSearchResult]) {
    if results.is_empty() {
        return;
    }
    let snippet_chars: usize = results.iter().map(|r| r.snippet.len()).sum();
    let mut file_chars = 0usize;
    let mut seen = HashSet::new();
    for result in results {
        if seen.insert(result.path.clone()) {
            if let Ok(meta) = std::fs::metadata(&result.path) {
                file_chars += meta.len() as usize;
            }
        }
    }
    let Some(stats_path) = savings_file_path() else {
        return;
    };
    if let Some(parent) = stats_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let record = serde_json::json!({
        "ts": ts,
        "results": results.len(),
        "snippet_chars": snippet_chars,
        "file_chars": file_chars,
    });
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(stats_path)
    {
        let _ = writeln!(file, "{record}");
    }
}

fn savings_file_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(
        PathBuf::from(home)
            .join(".config")
            .join("octo")
            .join("code-search-savings.jsonl"),
    )
}

fn related_query(content: &str) -> String {
    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for token in tokenize_index_text(content) {
        if token.len() < 3 || stopwords.contains(token.as_str()) {
            continue;
        }
        if seen.insert(token.clone()) {
            terms.push(token);
        }
        if terms.len() >= 24 {
            break;
        }
    }
    terms.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("octo-code-search-{name}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn indexes_code_and_text_optionally() {
        let root = temp_project("stats");
        write(
            &root.join("src/auth.py"),
            "def authenticate(token):\n    return token == 'secret'\n",
        );
        write(&root.join("README.md"), "# Authentication docs\n");

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        let without_text = stats(root.to_string_lossy().to_string(), Some(false)).unwrap();
        let with_text = stats(root.to_string_lossy().to_string(), Some(true)).unwrap();

        assert_eq!(without_text.indexed_files, 1);
        assert_eq!(with_text.indexed_files, 2);
        assert!(with_text.languages.contains_key("markdown"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn symbol_search_prefers_definition_chunk() {
        let root = temp_project("symbol");
        write(
            &root.join("src/user_service.rs"),
            "pub struct UserService {\n    id: u64,\n}\n\nimpl UserService {\n    pub fn new() -> Self { Self { id: 1 } }\n}\n",
        );
        write(
            &root.join("tests/user_service_test.rs"),
            "use crate::UserService;\n\nfn checks_user_service() { let _name = \"UserService\"; }\n",
        );

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        let results = search(
            root.to_string_lossy().to_string(),
            "UserService".to_string(),
            Some(3),
            Some("hybrid".to_string()),
            Some(false),
        )
        .unwrap();

        assert!(!results.is_empty());
        assert_eq!(results[0].file_path, "src/user_service.rs");
        assert!(results[0].snippet.contains("struct UserService"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_modes_are_supported() {
        let root = temp_project("modes");
        write(
            &root.join("src/search.rs"),
            "pub fn search_hybrid(query: &str) { bm25(query); semantic(query); }\n",
        );
        write(&root.join("src/other.rs"), "pub fn render_ui() {}\n");

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        for mode in ["hybrid", "bm25", "semantic"] {
            let results = search(
                root.to_string_lossy().to_string(),
                "hybrid semantic".to_string(),
                Some(2),
                Some(mode.to_string()),
                Some(false),
            )
            .unwrap();
            assert!(!results.is_empty(), "mode={mode}");
            assert_eq!(results[0].source, mode);
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_matches_korean_code_text() {
        let root = temp_project("korean-code");
        write(
            &root.join("src/page.tsx"),
            "const ROLE_LABELS = { docs: '문서관리자', qa: '품질관리' };\n",
        );

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        let results = search(
            root.to_string_lossy().to_string(),
            "문서관리자".to_string(),
            Some(3),
            Some("hybrid".to_string()),
            Some(false),
        )
        .unwrap();

        assert!(!results.is_empty());
        assert_eq!(results[0].file_path, "src/page.tsx");
        assert!(results[0].snippet.contains("문서관리자"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_matches_korean_docs_when_enabled() {
        let root = temp_project("korean-docs");
        write(
            &root.join("README.md"),
            "# 검색 테스트\n\n한글 입력과 한국어 문서 검색을 지원합니다.\n",
        );

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        let results = search(
            root.to_string_lossy().to_string(),
            "한글".to_string(),
            Some(3),
            Some("bm25".to_string()),
            Some(true),
        )
        .unwrap();

        assert!(!results.is_empty());
        assert_eq!(results[0].file_path, "README.md");
        assert!(results[0].snippet.contains("한글 입력"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn find_related_uses_source_chunk_terms() {
        let root = temp_project("related");
        write(
            &root.join("src/auth.py"),
            "def authenticate(token):\n    return token == 'secret'\n",
        );
        write(
            &root.join("src/session.py"),
            "def validate_session(token):\n    return authenticate(token)\n",
        );
        write(
            &root.join("src/date.py"),
            "def format_date(dt):\n    return str(dt)\n",
        );

        clear_cache(Some(root.to_string_lossy().to_string())).unwrap();
        let results = find_related(
            root.to_string_lossy().to_string(),
            "src/auth.py".to_string(),
            1,
            Some(3),
            Some(false),
        )
        .unwrap();

        assert!(results.iter().any(|r| r.file_path == "src/session.py"));
        assert!(results.iter().all(|r| r.file_path != "src/auth.py"));

        let _ = fs::remove_dir_all(root);
    }
}
