//! Shared types and utility functions used across modules.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const LOCAL_WHISPER_MODEL_DEFAULT: &str = "ggml-large-v3-turbo.bin";
pub const LOCAL_WHISPER_MODEL_URL_BASE_DEFAULT: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Build a `std::process::Command` that never pops up a console window on Windows.
///
/// On Windows, spawning a child process (git, powershell, etc.) without the
/// `CREATE_NO_WINDOW` flag flashes a black `conhost.exe` window. Background/polled
/// spawns (e.g. periodic `git status`) make these appear endlessly. macOS and Linux
/// are unaffected — the `#[cfg(windows)]` block is compiled out there.
pub fn no_window_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Async (`tokio`) variant of [`no_window_command`].
pub fn no_window_async_command<S: AsRef<std::ffi::OsStr>>(program: S) -> tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        // tokio::process::Command는 creation_flags가 고유 메서드라 트레이트 import 불필요.
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
}

pub fn resolve_home_dir() -> Option<String> {
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(home);
        }
    }

    if let Ok(home) = std::env::var("USERPROFILE") {
        if !home.trim().is_empty() {
            return Some(home);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let username = std::process::Command::new("id")
            .arg("-un")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        if let Some(u) = username {
            return Some(format!("/Users/{}", u));
        }
    }

    None
}

pub fn read_octo_env() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    let Some(home) = resolve_home_dir() else {
        return map;
    };

    let env_path = format!("{}/.config/octo/.env", home);
    let Ok(content) = std::fs::read_to_string(&env_path) else {
        return map;
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq_pos) = line.find('=') else {
            continue;
        };

        let key = line[..eq_pos].trim();
        let mut value = line[eq_pos + 1..].trim();

        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = &value[1..value.len().saturating_sub(1)];
        }

        if !key.is_empty() {
            map.insert(key.to_string(), value.to_string());
        }
    }

    map
}

pub fn get_env_value(key: &str) -> Option<String> {
    if let Ok(v) = std::env::var(key) {
        if !v.trim().is_empty() {
            return Some(v);
        }
    }

    read_octo_env()
        .get(key)
        .cloned()
        .filter(|v| !v.trim().is_empty())
}

pub fn get_env_value_or(key: &str, default: &str) -> String {
    get_env_value(key).unwrap_or_else(|| default.to_string())
}

/// Locate a CLI executable (`node`, `git`, `claude`, …) by checking well-known
/// install prefixes BEFORE falling back to a `PATH` scan.
///
/// A GUI app launched from Finder/Dock inherits a minimal `PATH` that usually
/// omits Homebrew, nvm, and `~/.local/bin`, so a bare `Command::new("node")`
/// fails in the installed `.app` even though the tool is installed. Pattern
/// adapted from brew-browser's `resolve_brew_path` (MIT, © Michael
/// Sitarzewski) — see THIRD_PARTY.md.
///
/// `extra_dirs` lets a caller prepend tool-specific locations (e.g. an nvm
/// `bin` dir for `node`). Returns the first existing file, else `None`.
pub fn resolve_tool_path(name: &str, extra_dirs: &[std::path::PathBuf]) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    let exe_name = if name.ends_with(".exe") || name.ends_with(".cmd") || name.ends_with(".bat") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    #[cfg(not(target_os = "windows"))]
    let exe_name = name.to_string();

    let mut dirs: Vec<std::path::PathBuf> = extra_dirs.to_vec();
    let home = resolve_home_dir().map(std::path::PathBuf::from);
    #[cfg(target_os = "windows")]
    {
        if let Some(h) = &home {
            dirs.push(h.join("AppData").join("Local").join("Programs"));
            dirs.push(h.join(".cargo").join("bin"));
            dirs.push(h.join(".local").join("bin"));
        }
        for p in [r"C:\Program Files\nodejs", r"C:\Program Files\Git\cmd"] {
            dirs.push(std::path::PathBuf::from(p));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
            dirs.push(std::path::PathBuf::from(p));
        }
        if let Some(h) = &home {
            dirs.push(h.join(".local").join("bin"));
            dirs.push(h.join(".cargo").join("bin"));
        }
        for p in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
            dirs.push(std::path::PathBuf::from(p));
        }
    }
    for dir in &dirs {
        let candidate = dir.join(&exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // PATH fallback — last, because it's the unreliable part in a GUI launch.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(&exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Newest nvm-installed node `bin` dir, if any (`~/.nvm/versions/node/*/bin`).
pub fn nvm_node_bin_dir() -> Option<std::path::PathBuf> {
    let home = resolve_home_dir()?;
    std::fs::read_dir(format!("{home}/.nvm/versions/node"))
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .max()
        .map(|p| p.join("bin"))
}

pub fn format_http_error(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        format!("HTTP {}", status.as_u16())
    } else if trimmed.len() > 2000 {
        format!("HTTP {}: {}…", status.as_u16(), &trimmed[..2000])
    } else {
        format!("HTTP {}: {}", status.as_u16(), trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_tool_path_prefers_extra_dir_then_falls_back() {
        let tmp = std::env::temp_dir().join(format!("bbarit-resolve-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        #[cfg(target_os = "windows")]
        let tool = "bbarittool.exe";
        #[cfg(not(target_os = "windows"))]
        let tool = "bbarittool";
        let tool_path = tmp.join(tool);
        std::fs::write(&tool_path, b"#!/bin/sh\n").unwrap();

        // Found in the caller-supplied extra dir.
        let found = resolve_tool_path("bbarittool", &[tmp.clone()]);
        assert_eq!(found.as_deref(), Some(tool_path.as_path()));

        // A tool that exists nowhere resolves to None.
        assert!(resolve_tool_path("definitely-not-a-real-tool-xyz", &[]).is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
