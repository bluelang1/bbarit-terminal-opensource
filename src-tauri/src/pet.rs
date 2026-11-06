//! Desktop pet host: main-window lifecycle, the `pet` window and user pack listing.
//!
//! The pet window (label `pet`, page `/pet`) is created lazily the first time it should
//! show, then only shown and hidden while the app runs. It shows while the main window is
//! hidden (macOS red button) or minimized and `pet.enabled` in ~/.config/octo/config.json
//! is not `false`. Every show/hide emits `pet-visibility` `{ visible }` to the pet window;
//! the page should treat itself as visible on first load (the first event can arrive
//! before its listener is attached). Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const PET_LABEL: &str = "pet";
const MAIN_LABEL: &str = "main";
const PET_SIZE: f64 = 160.0;
const PET_VISIBILITY_EVENT: &str = "pet-visibility";
/// Pet -> main: switch to this tab (App.tsx listens and reuses the toast-click path).
const PET_FOCUS_TERMINAL_EVENT: &str = "pet-focus-terminal";

/// The owner hid the pet from its menu; stays hidden until the main window is shown again.
static PET_SUPPRESSED: AtomicBool = AtomicBool::new(false);
/// Serializes `sync_pet` so two callers never both create the pet window.
static SYNC_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPack {
    pub id: String,
    pub json: String,
}

#[derive(Clone, Serialize)]
struct PetVisibility {
    visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetFocusTerminal {
    terminal_id: String,
}

/// The pet shows when it is enabled and the main window is away (hidden or minimized).
pub fn pet_should_show(enabled: bool, main_visible: bool, main_minimized: bool) -> bool {
    enabled && (!main_visible || main_minimized)
}

/// `pet.enabled` from config.json; anything but an explicit `false` keeps the pet on.
pub fn pet_enabled(config: &serde_json::Value) -> bool {
    config
        .get("pet")
        .and_then(|p| p.get("enabled"))
        .and_then(|e| e.as_bool())
        != Some(false)
}

/// `<dir>/<id>/character.json` for every sub-directory that has one, sorted by id.
/// Unreadable entries are skipped; the JSON is returned unparsed (the page validates it).
pub fn read_user_packs(dir: &Path) -> Vec<UserPack> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut packs: Vec<UserPack> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_string();
            let json = std::fs::read_to_string(e.path().join("character.json")).ok()?;
            Some(UserPack { id, json })
        })
        .collect();
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    packs
}

fn user_packs_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".config/octo/characters"))
}

fn pet_enabled_from_config() -> bool {
    crate::read_octo_config_json()
        .map(|c| pet_enabled(&c))
        .unwrap_or(true)
}

fn create_pet_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("pet".into()))
        .title("BBARIT Pet")
        .inner_size(PET_SIZE, PET_SIZE)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .accept_first_mouse(true)
        .visible(false);
    // Start on the bottom edge of the primary work area; the page moves it from there.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let x = area.position.x as f64 / scale + area.size.width as f64 / scale - PET_SIZE - 40.0;
        let y = area.position.y as f64 / scale + area.size.height as f64 / scale - PET_SIZE;
        builder = builder.position(x.max(0.0), y.max(0.0));
    }
    builder.build()
}

fn set_pet_visible(app: &AppHandle, visible: bool) {
    let existing = app.get_webview_window(PET_LABEL);
    let pet = match (existing, visible) {
        (Some(w), _) => w,
        (None, false) => return,
        (None, true) => match create_pet_window(app) {
            Ok(w) => w,
            Err(e) => {
                crate::safe_eprintln!("[pet] create window failed: {e}");
                return;
            }
        },
    };
    if pet.is_visible().unwrap_or(false) == visible {
        return;
    }
    let result = if visible { pet.show() } else { pet.hide() };
    if let Err(e) = result {
        crate::safe_eprintln!("[pet] {} failed: {e}", if visible { "show" } else { "hide" });
        return;
    }
    let _ = app.emit_to(PET_LABEL, PET_VISIBILITY_EVENT, PetVisibility { visible });
}

/// Show or hide the pet to match the main window and the config. Never call this on the
/// main thread from an event handler (window creation can deadlock); use `sync_pet_soon`.
pub fn sync_pet(app: &AppHandle) {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        set_pet_visible(app, false);
        return;
    };
    let main_visible = main.is_visible().unwrap_or(true);
    let main_minimized = main.is_minimized().unwrap_or(false);
    if main_visible && !main_minimized {
        PET_SUPPRESSED.store(false, Ordering::SeqCst);
    }
    let show = !PET_SUPPRESSED.load(Ordering::SeqCst)
        && pet_should_show(pet_enabled_from_config(), main_visible, main_minimized);
    set_pet_visible(app, show);
}

/// `sync_pet` off the calling thread, once after each delay (ms).
pub fn sync_pet_soon(app: &AppHandle, delays_ms: &'static [u64]) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut waited = 0;
        for &d in delays_ms {
            std::thread::sleep(Duration::from_millis(d.saturating_sub(waited)));
            waited = d;
            sync_pet(&app);
        }
    });
}

/// macOS: re-sync the pet when the main window is minimized to or restored from the Dock.
/// tao has no minimize event there, so observe AppKit's NSWindowDidMiniaturize /
/// NSWindowDidDeminiaturize notifications for main's NSWindow. Call once, on the main
/// thread (app setup). The blocks run on the main thread while AppKit posts, so they only
/// hand off to `sync_pet_soon`; the observers live as long as the app.
#[cfg(target_os = "macos")]
pub fn observe_main_miniaturize(app: &AppHandle) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWindowDidDeminiaturizeNotification, NSWindowDidMiniaturizeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter};
    use std::ptr::NonNull;

    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let ns_window = match main.ns_window() {
        Ok(ptr) if !ptr.is_null() => ptr as *const AnyObject,
        _ => {
            crate::safe_eprintln!("[pet] main NSWindow unavailable; minimize will not show the pet");
            return;
        }
    };
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: AppKit's exported notification-name constants are immutable NSStrings.
    let names = unsafe { [NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification] };
    for name in names {
        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| sync_pet_soon(&app, &[0]));
        // SAFETY: `ns_window` is main's live NSWindow (the main window is hidden, never
        // destroyed, while the app runs) and only filters by sender; the block captures
        // only an AppHandle (Send + Sync) and does no AppKit work itself.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(&*ns_window),
                None,
                &block,
            )
        };
        // Never removed: the observation lasts for the life of the app.
        std::mem::forget(token);
    }
}

pub fn pet_is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PET_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Show, unminimize and focus the main window (Dock click, second launch, pet double-click).
pub fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

#[tauri::command(async)]
pub fn pet_list_characters() -> Vec<UserPack> {
    user_packs_dir()
        .map(|d| read_user_packs(&d))
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn pet_open_main(app: AppHandle) {
    show_main(&app);
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_pet_visible(&app, false);
}

/// Pet double-click / bubble click: bring main back (as `pet_open_main`) and, with a tab
/// id, ask main to switch to that tab. `None` leaves main on its last active tab.
#[tauri::command(async)]
pub fn pet_open_terminal(app: AppHandle, terminal_id: Option<String>) {
    pet_open_main(app.clone());
    if let Some(terminal_id) = terminal_id.filter(|id| !id.is_empty()) {
        let _ = app.emit_to(
            MAIN_LABEL,
            PET_FOCUS_TERMINAL_EVENT,
            PetFocusTerminal { terminal_id },
        );
    }
}

#[tauri::command(async)]
pub fn pet_hide(app: AppHandle) {
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    PET_SUPPRESSED.store(true, Ordering::SeqCst);
    set_pet_visible(&app, false);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pet_should_show_only_when_enabled_and_main_is_away() {
        assert!(pet_should_show(true, false, false));
        assert!(pet_should_show(true, true, true));
        assert!(!pet_should_show(true, true, false));
        assert!(!pet_should_show(false, false, false));
    }

    #[test]
    fn pet_enabled_defaults_on_and_only_false_disables() {
        assert!(pet_enabled(&json!({})));
        assert!(!pet_enabled(&json!({"pet": {"enabled": false}})));
        assert!(pet_enabled(&json!({"pet": {"enabled": "no"}})));
    }

    #[test]
    fn read_user_packs_lists_only_dirs_with_character_json() {
        let dir = std::env::temp_dir().join(format!("bbarit-pet-packs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a/character.json"), "{}").unwrap();
        std::fs::write(dir.join("c.txt"), "x").unwrap();
        let packs = read_user_packs(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(packs, vec![UserPack { id: "a".into(), json: "{}".into() }]);
    }

    #[test]
    fn pet_focus_terminal_payload_is_camel_case() {
        let v = serde_json::to_value(PetFocusTerminal { terminal_id: "t-1".into() }).unwrap();
        assert_eq!(v, json!({"terminalId": "t-1"}));
    }

    #[test]
    fn read_user_packs_on_missing_dir_is_empty() {
        let dir = std::env::temp_dir().join("bbarit-pet-packs-does-not-exist");
        assert!(read_user_packs(&dir).is_empty());
    }
}
