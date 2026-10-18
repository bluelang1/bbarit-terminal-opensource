// Phase 1.2: Config file backend
//
// ~/.config/octo/config.json 읽기/쓰기/감시.
// Tauri 이벤트로 프론트엔드에 변경 알림.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Get config directory: ~/.config/octo/
fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("octo")
}

/// Get config file path: ~/.config/octo/config.json
fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Read config from file. Returns JSON string.
#[tauri::command]
pub fn read_config() -> Result<String, String> {
    let path = config_path();
    if !path.exists() {
        // Return empty object if file doesn't exist yet
        return Ok("{}".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))
}

/// Write config to file. Creates directory if needed.
#[tauri::command]
pub fn write_config(json: String) -> Result<(), String> {
    let dir = config_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    // Validate JSON before writing
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|e| format!("Invalid JSON: {}", e))?;

    // Pretty-print for human readability
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let pretty = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to format JSON: {}", e))?;

    fs::write(config_path(), pretty).map_err(|e| format!("Failed to write config: {}", e))
}

/// Get config file path (for frontend display)
#[tauri::command]
pub fn get_config_path() -> String {
    config_path().to_string_lossy().to_string()
}

// ───────────────────────── File Watcher ─────────────────────────

pub struct ConfigWatcherState {
    pub _watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Start watching config file for changes. Emits "config-changed" event.
pub fn start_config_watcher(app: &tauri::App) {
    use notify::{Watcher, RecursiveMode, Event, EventKind};

    let dir = config_dir();

    // Create config dir if it doesn't exist
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }

    let app_handle = app.handle().clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            match event.kind {
                EventKind::Modify(_) | EventKind::Create(_) => {
                    // Check if the event is for our config file
                    let is_config = event.paths.iter().any(|p| {
                        p.file_name().map(|n| n == "config.json").unwrap_or(false)
                    });
                    if is_config {
                        // Read the new config and emit event
                        if let Ok(content) = fs::read_to_string(config_path()) {
                            let _ = app_handle.emit("config-changed", content);
                        }
                    }
                }
                _ => {}
            }
        }
    }).ok();

    if let Some(ref mut w) = watcher {
        let _ = w.watch(&dir, RecursiveMode::NonRecursive);
    }

    // Store watcher in state so it doesn't get dropped
    let state = app.state::<ConfigWatcherState>();
    *state._watcher.lock().unwrap() = watcher;
}
