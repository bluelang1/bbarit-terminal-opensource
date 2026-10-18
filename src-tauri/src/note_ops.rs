//! Note-specific operations: search, metadata, frontmatter parsing.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ========== Data Structures ==========

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub line_number: usize,
    pub line_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchOptions {
    #[serde(default)]
    pub regex: bool,

    #[serde(default)]
    pub case_sensitive: bool,

    #[serde(default = "default_max_results")]
    pub max_results: usize,

    #[serde(default = "default_context_lines")]
    pub context_lines: usize,

    #[serde(default)]
    pub exclude_frontmatter: bool,
}

fn default_max_results() -> usize {
    100
}

fn default_context_lines() -> usize {
    2
}

impl Default for SearchOptions {
    fn default() -> Self {
        SearchOptions {
            regex: false,
            case_sensitive: false,
            max_results: default_max_results(),
            context_lines: default_context_lines(),
            exclude_frontmatter: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarkdownFileEntry {
    pub path: String,
    pub name: String,
    pub modified: u64,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: String,
    pub modified: u64,
    pub created: u64,
    pub size: u64,
    pub is_readonly: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Frontmatter {
    pub raw: String,
    pub tags: Vec<String>,
    pub title: Option<String>,
    pub date: Option<String>,
    pub fields: HashMap<String, String>,
}

// ========== Helper Functions ==========

/// Returns true if path should be excluded from note indexing.
fn should_skip_directory(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "dist" | "target" | ".git" | ".obsidian" | ".trash"
    )
}

/// Recursively collect all .md files in a directory.
fn collect_markdown_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut results = Vec::new();

    fn visit_dir(dir: &Path, results: &mut Vec<PathBuf>) -> std::io::Result<()> {
        if !dir.is_dir() {
            return Ok(());
        }

        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();

            if path.is_dir() {
                if should_skip_directory(&name) {
                    continue;
                }
                visit_dir(&path, results)?;
            } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
                results.push(path);
            }
        }

        Ok(())
    }

    visit_dir(dir, &mut results).map_err(|e| e.to_string())?;
    Ok(results)
}

/// Extract context lines before or after the current line.
fn extract_context(lines: &[&str], current: usize, count: usize, before: bool) -> Vec<String> {
    let mut context = Vec::new();

    if before {
        let start = current.saturating_sub(count);
        for i in start..current {
            context.push(lines[i].to_string());
        }
    } else {
        let end = (current + 1 + count).min(lines.len());
        for i in (current + 1)..end {
            context.push(lines[i].to_string());
        }
    }

    context
}

// ========== Tauri Commands ==========

#[tauri::command]
pub fn search_notes(
    dir: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<Vec<SearchResult>, String> {
    let opts = options.unwrap_or_default();
    let query = query.trim();

    if query.is_empty() {
        return Ok(Vec::new());
    }

    // 1. Collect all .md files recursively
    let dir_path = Path::new(&dir);
    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", dir));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", dir));
    }

    let md_files = collect_markdown_files(dir_path)?;

    // 2. Build regex pattern
    let pattern = if opts.regex {
        regex::RegexBuilder::new(query)
            .case_insensitive(!opts.case_sensitive)
            .build()
            .map_err(|e| format!("Invalid regex: {}", e))?
    } else {
        let escaped = regex::escape(query);
        regex::RegexBuilder::new(&escaped)
            .case_insensitive(!opts.case_sensitive)
            .build()
            .unwrap()
    };

    // 3. Search each file
    let mut results = Vec::new();

    for file_path in md_files {
        // Skip files larger than 10MB to avoid memory issues
        if let Ok(meta) = fs::metadata(&file_path) {
            if meta.len() > 10 * 1024 * 1024 {
                continue;
            }
        }

        // Read file with error handling (skip unreadable files)
        let content = match fs::read_to_string(&file_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let lines: Vec<&str> = content.lines().collect();
        let mut in_frontmatter = false;

        for (idx, line) in lines.iter().enumerate() {
            // Skip frontmatter if requested
            if opts.exclude_frontmatter {
                if idx == 0 && line.trim() == "---" {
                    in_frontmatter = true;
                    continue;
                }
                if in_frontmatter {
                    if line.trim() == "---" {
                        in_frontmatter = false;
                    }
                    continue;
                }
            }

            // Match pattern
            if pattern.is_match(line) {
                let line_number = idx + 1; // 1-based
                let context_before = extract_context(&lines, idx, opts.context_lines, true);
                let context_after = extract_context(&lines, idx, opts.context_lines, false);

                results.push(SearchResult {
                    path: file_path.to_string_lossy().to_string(),
                    line_number,
                    line_content: line.to_string(),
                    context_before,
                    context_after,
                });

                if results.len() >= opts.max_results {
                    return Ok(results);
                }
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn list_markdown_files(dir: String) -> Result<Vec<MarkdownFileEntry>, String> {
    let dir_path = Path::new(&dir);

    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", dir));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", dir));
    }

    let md_files = collect_markdown_files(dir_path)?;
    let mut entries = Vec::new();

    for path in md_files {
        let metadata = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        entries.push(MarkdownFileEntry {
            path: path.to_string_lossy().to_string(),
            name,
            modified,
            size: metadata.len(),
        });
    }

    // Sort by modified time (newest first)
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));

    Ok(entries)
}

#[tauri::command]
pub fn file_metadata(path: String) -> Result<FileMetadata, String> {
    let p = Path::new(&path);

    if !p.exists() {
        return Err(format!("File does not exist: {}", path));
    }

    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let is_readonly = metadata.permissions().readonly();

    Ok(FileMetadata {
        path,
        modified,
        created,
        size: metadata.len(),
        is_readonly,
    })
}

#[tauri::command]
pub fn parse_frontmatter(content: String) -> Result<Option<Frontmatter>, String> {
    let lines: Vec<&str> = content.lines().collect();

    // Check if content starts with ---
    if lines.is_empty() || lines[0].trim() != "---" {
        return Ok(None);
    }

    // Find closing ---
    let mut end_idx = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim() == "---" {
            end_idx = Some(i);
            break;
        }
    }

    let Some(end) = end_idx else {
        return Ok(None);
    };

    // Extract YAML block
    let yaml_lines = &lines[1..end];
    let raw = yaml_lines.join("\n");

    // Simple key-value parsing (no full YAML parser)
    let mut fields = HashMap::new();
    let mut tags = Vec::new();
    let mut title = None;
    let mut date = None;

    for line in yaml_lines {
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim();
            let value = line[colon_pos + 1..].trim();

            match key {
                "title" => title = Some(value.trim_matches('"').to_string()),
                "date" => date = Some(value.to_string()),
                "tags" => {
                    // Parse simple array: [tag1, tag2] format
                    if value.starts_with('[') && value.ends_with(']') {
                        let inner = &value[1..value.len() - 1];
                        tags = inner
                            .split(',')
                            .map(|s| s.trim().trim_matches('"').to_string())
                            .filter(|s| !s.is_empty())
                            .collect();
                    }
                }
                _ => {
                    fields.insert(key.to_string(), value.to_string());
                }
            }
        }
    }

    Ok(Some(Frontmatter {
        raw,
        tags,
        title,
        date,
        fields,
    }))
}
