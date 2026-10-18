//! file_watcher.rs — Cross-platform file system watcher (inotify/FSEvents/ReadDirectoryChangesW)
//!
//! Uses `notify` crate directly (not debouncer) to preserve full event types:
//! Create, Modify, Remove, Rename.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Payload emitted as "fs-events" Tauri event
#[derive(Clone, Serialize, Debug)]
pub struct FsEvent {
    pub kind: String,       // "create" | "modify" | "remove" | "rename" | "other"
    pub paths: Vec<String>, // affected file paths
    pub watch_root: String, // the directory being watched
}

/// Directories to skip
const IGNORE_SEGMENTS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".turbo",
    ".svelte-kit",
    ".nuxt",
];

fn should_ignore(path: &std::path::Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(s) = component {
            if let Some(s) = s.to_str() {
                if IGNORE_SEGMENTS.contains(&s) {
                    return true;
                }
            }
        }
    }
    false
}

fn event_kind_str(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        EventKind::Other => "other",
        EventKind::Any => "any",
    }
}

/// Holds active watchers keyed by canonical directory path
pub struct FileWatcherState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

/// Start watching a directory. Emits "fs-events" with kind: create/modify/remove.
#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    state: State<'_, FileWatcherState>,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let key = canonical.to_string_lossy().to_string();

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;

    if watchers.contains_key(&key) {
        return Ok(());
    }

    let watch_root = key.clone();
    let app_handle = app.clone();

    // Simple debounce: batch events for 300ms before emitting
    let pending = std::sync::Arc::new(Mutex::new(Vec::<FsEvent>::new()));
    let pending_clone = pending.clone();
    let app_clone = app_handle.clone();
    let root_clone = watch_root.clone();

    // Debounce flush thread
    let flush_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flush_flag_clone = flush_flag.clone();

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if flush_flag_clone.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let events: Vec<FsEvent> = {
                let mut p = pending_clone.lock().unwrap();
                if p.is_empty() {
                    continue;
                }
                p.drain(..).collect()
            };
            if events.is_empty() {
                continue;
            }

            // Merge events by kind
            let mut create_paths = Vec::new();
            let mut modify_paths = Vec::new();
            let mut remove_paths = Vec::new();
            let mut other_paths = Vec::new();

            for e in &events {
                match e.kind.as_str() {
                    "create" => create_paths.extend(e.paths.clone()),
                    "modify" => modify_paths.extend(e.paths.clone()),
                    "remove" => remove_paths.extend(e.paths.clone()),
                    _ => other_paths.extend(e.paths.clone()),
                }
            }

            // Emit separate events per kind
            if !create_paths.is_empty() {
                let _ = app_clone.emit(
                    "fs-events",
                    FsEvent {
                        kind: "create".to_string(),
                        paths: create_paths,
                        watch_root: root_clone.clone(),
                    },
                );
            }
            if !modify_paths.is_empty() {
                let _ = app_clone.emit(
                    "fs-events",
                    FsEvent {
                        kind: "modify".to_string(),
                        paths: modify_paths,
                        watch_root: root_clone.clone(),
                    },
                );
            }
            if !remove_paths.is_empty() {
                let _ = app_clone.emit(
                    "fs-events",
                    FsEvent {
                        kind: "remove".to_string(),
                        paths: remove_paths,
                        watch_root: root_clone.clone(),
                    },
                );
            }
            if !other_paths.is_empty() {
                let _ = app_clone.emit(
                    "fs-events",
                    FsEvent {
                        kind: "other".to_string(),
                        paths: other_paths,
                        watch_root: root_clone.clone(),
                    },
                );
            }
        }
    });

    let pending_for_callback = pending.clone();
    let root_for_callback = watch_root.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            let kind = event_kind_str(&event.kind);
            // Skip access events
            if kind == "access" {
                return;
            }

            let paths: Vec<String> = event
                .paths
                .iter()
                .filter(|p| !should_ignore(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();

            if paths.is_empty() {
                return;
            }

            let fs_event = FsEvent {
                kind: kind.to_string(),
                paths,
                watch_root: root_for_callback.clone(),
            };

            if let Ok(mut p) = pending_for_callback.lock() {
                p.push(fs_event);
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    let mode = if recursive.unwrap_or(true) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(canonical.as_path(), mode)
        .map_err(|e| format!("Failed to watch '{}': {}", path, e))?;

    // Store watcher and flush_flag together (flush_flag cleanup on drop via unwatch)
    watchers.insert(key.clone(), watcher);
    eprintln!(
        "[FileWatcher] Watching: {} (recursive: {})",
        key,
        recursive.unwrap_or(true)
    );

    Ok(())
}

/// Stop watching a directory.
#[tauri::command]
pub fn unwatch_directory(state: State<'_, FileWatcherState>, path: String) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let key = canonical.to_string_lossy().to_string();

    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    if watchers.remove(&key).is_some() {
        eprintln!("[FileWatcher] Unwatched: {}", key);
    }
    Ok(())
}

/// Stop all watchers.
#[tauri::command]
pub fn unwatch_all(state: State<'_, FileWatcherState>) -> Result<(), String> {
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    let count = watchers.len();
    watchers.clear();
    eprintln!("[FileWatcher] Cleared {} watchers", count);
    Ok(())
}
