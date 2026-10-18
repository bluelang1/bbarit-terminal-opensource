//! File system helpers: text encoding (BOM), file search, and project file indexing.

#[cfg(target_os = "windows")]
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

pub fn strip_utf8_bom(content: String) -> String {
    match content.strip_prefix('\u{feff}') {
        Some(stripped) => stripped.to_string(),
        None => content,
    }
}

#[cfg(target_os = "windows")]
fn is_markdown_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "md" || ext == "markdown"
        })
        .unwrap_or(false)
}

pub fn encode_text_file_content(path: &std::path::Path, content: &str) -> Vec<u8> {
    #[cfg(target_os = "windows")]
    {
        let needs_windows_markdown_bom = is_markdown_path(path)
            && !content.is_empty()
            && !content.starts_with('\u{feff}')
            && !content.is_ascii();

        if needs_windows_markdown_bom {
            let mut bytes = Vec::with_capacity(UTF8_BOM.len() + content.len());
            bytes.extend_from_slice(UTF8_BOM);
            bytes.extend_from_slice(content.as_bytes());
            return bytes;
        }
    }

    let _ = path;
    content.as_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn strip_utf8_bom_removes_leading_marker() {
        assert_eq!(strip_utf8_bom("\u{feff}한글".to_string()), "한글");
    }

    #[test]
    fn encode_text_file_content_keeps_non_markdown_plain_utf8() {
        assert_eq!(
            encode_text_file_content(Path::new("note.txt"), "한글"),
            "한글".as_bytes()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn encode_text_file_content_adds_bom_for_non_ascii_markdown_on_windows() {
        let bytes = encode_text_file_content(Path::new("note.md"), "한글");
        assert!(bytes.starts_with(UTF8_BOM));
        assert_eq!(&bytes[UTF8_BOM.len()..], "한글".as_bytes());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn encode_text_file_content_does_not_duplicate_existing_bom() {
        let bytes = encode_text_file_content(Path::new("note.md"), "\u{feff}한글");
        assert_eq!(bytes, "\u{feff}한글".as_bytes());
    }
}

/// Recursively search files by name and/or content.
/// Returns up to `limit` matches. Skips binary files and common ignore dirs.
pub fn search_files(
    root: String,
    query: String,
    search_content: bool,
    limit: Option<usize>,
) -> Result<Vec<SearchResult>, String> {
    use std::path::Path;

    let max = limit.unwrap_or(200).min(500);
    let q_lower = query.to_lowercase();
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("Root path is not a directory".to_string());
    }

    let mut results = Vec::new();
    let mut stack = vec![root_path.to_path_buf()];
    let mut files_scanned: usize = 0;
    const MAX_FILES_SCANNED: usize = 10_000;

    const IGNORE_DIRS: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        "__pycache__",
        ".venv",
        "venv",
        ".idea",
        ".vscode",
    ];
    const MAX_FILE_SIZE: u64 = 1024 * 1024; // 1MB

    while let Some(dir) = stack.pop() {
        if results.len() >= max || files_scanned >= MAX_FILES_SCANNED {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            if results.len() >= max || files_scanned >= MAX_FILES_SCANNED {
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && name != ".env" {
                // skip hidden dirs/files except .env
                if entry.path().is_dir() {
                    continue;
                }
            }
            let path = entry.path();
            if path.is_dir() {
                if IGNORE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }

            files_scanned += 1;
            let name_match = name.to_lowercase().contains(&q_lower);

            if search_content {
                // Check file size
                let meta = match std::fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.len() > MAX_FILE_SIZE || meta.len() == 0 {
                    if name_match {
                        results.push(SearchResult {
                            path: path.to_string_lossy().to_string(),
                            name: name.clone(),
                            matches: vec![],
                            is_name_match: true,
                        });
                    }
                    continue;
                }
                // Read content
                let content = match std::fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => {
                        // Binary file or encoding error
                        if name_match {
                            results.push(SearchResult {
                                path: path.to_string_lossy().to_string(),
                                name: name.clone(),
                                matches: vec![],
                                is_name_match: true,
                            });
                        }
                        continue;
                    }
                };
                let mut line_matches = Vec::new();
                for (i, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(&q_lower) {
                        line_matches.push(ContentMatch {
                            line_number: i + 1,
                            line_text: if line.len() > 300 {
                                // Find a valid UTF-8 char boundary at or before 300
                                let mut end = 300;
                                while end > 0 && !line.is_char_boundary(end) {
                                    end -= 1;
                                }
                                format!("{}...", &line[..end])
                            } else {
                                line.to_string()
                            },
                        });
                        if line_matches.len() >= 5 {
                            break;
                        }
                    }
                }
                if name_match || !line_matches.is_empty() {
                    results.push(SearchResult {
                        path: path.to_string_lossy().to_string(),
                        name: name.clone(),
                        matches: line_matches,
                        is_name_match: name_match,
                    });
                }
            } else {
                // Name-only search
                if name_match {
                    results.push(SearchResult {
                        path: path.to_string_lossy().to_string(),
                        name,
                        matches: vec![],
                        is_name_match: true,
                    });
                }
            }
        }
    }

    // Sort: name matches first, then by path
    results.sort_by(|a, b| {
        b.is_name_match
            .cmp(&a.is_name_match)
            .then_with(|| a.path.cmp(&b.path))
    });

    Ok(results)
}

/// Build a name-only file index for quick-open.
/// This is intentionally content-free so the UI can cache and filter it quickly.
pub fn list_project_files(root: String, limit: Option<usize>) -> Result<Vec<SearchResult>, String> {
    use std::path::Path;

    let max = limit.unwrap_or(20_000).min(50_000);
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err("Root path is not a directory".to_string());
    }

    const IGNORE_DIRS: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        "__pycache__",
        ".venv",
        "venv",
        ".idea",
        ".vscode",
        ".cache",
        ".turbo",
        ".parcel-cache",
        "coverage",
    ];

    let mut results = Vec::new();
    let mut stack = vec![root_path.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if results.len() >= max {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            if results.len() >= max {
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if name.starts_with('.') || IGNORE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if name.starts_with('.') && name != ".env" {
                continue;
            }
            results.push(SearchResult {
                path: path.to_string_lossy().to_string(),
                name,
                matches: vec![],
                is_name_match: true,
            });
        }
    }

    results.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(results)
}

#[derive(serde::Serialize, Clone)]
pub struct SearchResult {
    pub path: String,
    pub name: String,
    pub matches: Vec<ContentMatch>,
    pub is_name_match: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct ContentMatch {
    pub line_number: usize,
    pub line_text: String,
}

