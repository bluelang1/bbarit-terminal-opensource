//! Desktop pet host: main-window lifecycle, the `pet` window and user pack listing.
//!
//! The pet window (label `pet`, page `/pet`) is created lazily the first time it should
//! show, then only shown and hidden while the app runs. It shows while the main window is
//! hidden (macOS red button) or minimized and `pet.enabled` in ~/.config/octo/config.json
//! is not `false`. Every show/hide emits `pet-visibility` `{ visible }` to the pet window;
//! the page should treat itself as visible on first load (the first event can arrive
//! before its listener is attached).
//!
//! Character tour (Help > Character Tour, `start_pet_tour`): shows the pet even while main
//! is visible (or `pet.enabled` is false), puts it at the bottom center of main's monitor and
//! emits `pet-tour-start`; the page plays src/pet/showcase.ts and calls `pet_tour_end` when
//! the tour is over, after which the normal rules apply again. A page that loads during the
//! tour asks `pet_tour_active` (the start event can fire before its listener exists).
//! Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md.

pub mod weather;

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
/// Host -> pet: play the character tour from its first step (payload `PetTourStart`).
const PET_TOUR_START_EVENT: &str = "pet-tour-start";

/// The owner hid the pet from its menu; stays hidden until the main window is shown again.
static PET_SUPPRESSED: AtomicBool = AtomicBool::new(false);
/// Serializes `sync_pet` so two callers never both create the pet window.
static SYNC_LOCK: Mutex<()> = Mutex::new(());
/// The character tour is running: the pet shows whatever main does (see `pet_visible_now`).
static PET_TOUR: Mutex<Option<PetTourStart>> = Mutex::new(None);

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

/// Where the tour puts the pet window (logical px, its top-left).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PetTourSpot {
    pub x: f64,
    pub y: f64,
}

/// `pet-tour-start` payload / `pet_tour_active` result. `spot` is null when main's monitor
/// is unknown (the pet then tours where it stands).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PetTourStart {
    pub spot: Option<PetTourSpot>,
}

/// The pet shows when it is enabled and the main window is away (hidden or minimized).
pub fn pet_should_show(enabled: bool, main_visible: bool, main_minimized: bool) -> bool {
    enabled && (!main_visible || main_minimized)
}

/// What `sync_pet` decides: a running tour always shows the pet (an explicit request, even
/// with `pet.enabled` false or main in front); otherwise it is the normal rule unless the
/// owner hid the pet from its menu.
pub fn pet_visible_now(
    tour: bool,
    suppressed: bool,
    enabled: bool,
    main_visible: bool,
    main_minimized: bool,
) -> bool {
    tour || (!suppressed && pet_should_show(enabled, main_visible, main_minimized))
}

/// Pet window top-left at the bottom center of a work area (logical px).
pub fn pet_tour_spot(area_x: f64, area_y: f64, area_w: f64, area_h: f64) -> PetTourSpot {
    PetTourSpot {
        x: area_x + ((area_w - PET_SIZE) / 2.0).max(0.0),
        y: area_y + (area_h - PET_SIZE).max(0.0),
    }
}

fn tour_state() -> std::sync::MutexGuard<'static, Option<PetTourStart>> {
    PET_TOUR.lock().unwrap_or_else(|e| e.into_inner())
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
    let show = pet_visible_now(
        tour_state().is_some(),
        PET_SUPPRESSED.load(Ordering::SeqCst),
        pet_enabled_from_config(),
        main_visible,
        main_minimized,
    );
    set_pet_visible(app, show);
}

/// Bottom center of the work area of main's monitor (else the primary one), logical px.
fn tour_spot(app: &AppHandle) -> Option<PetTourSpot> {
    let monitor = app
        .get_webview_window(MAIN_LABEL)
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    if !(scale > 0.0) {
        return None;
    }
    let area = monitor.work_area();
    Some(pet_tour_spot(
        area.position.x as f64 / scale,
        area.position.y as f64 / scale,
        area.size.width as f64 / scale,
        area.size.height as f64 / scale,
    ))
}

/// Help > Character Tour: show the pet (main stays as it is), move it to the bottom center
/// of main's monitor and (re)start the tour from its first step. Runs off the calling
/// thread (menu events arrive on the main thread, where window creation can deadlock).
pub fn start_pet_tour(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let start = PetTourStart { spot: tour_spot(&app) };
        let _guard = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *tour_state() = Some(start);
        set_pet_visible(&app, true);
        if let (Some(pet), Some(spot)) = (app.get_webview_window(PET_LABEL), start.spot) {
            let _ = pet.set_position(tauri::LogicalPosition::new(spot.x, spot.y));
        }
        let _ = app.emit_to(PET_LABEL, PET_TOUR_START_EVENT, start);
    });
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
    *tour_state() = None;
    set_pet_visible(&app, false);
}

/// The running tour (a pet page that just loaded starts it), else null.
#[tauri::command(async)]
pub fn pet_tour_active() -> Option<PetTourStart> {
    *tour_state()
}

/// The pet page finished the tour (last step, caption click, double-click): back to the
/// normal show / hide rules (the pet hides again while main is in front).
#[tauri::command(async)]
pub fn pet_tour_end(app: AppHandle) {
    *tour_state() = None;
    sync_pet(&app);
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
    fn pet_visible_now_tour_overrides_everything() {
        // Tour: shown even with main in front, the pet disabled or hidden from its menu.
        assert!(pet_visible_now(true, false, true, true, false));
        assert!(pet_visible_now(true, false, false, true, false));
        assert!(pet_visible_now(true, true, true, true, false));
        // No tour: the normal rule, unless the owner hid it.
        assert!(pet_visible_now(false, false, true, false, false));
        assert!(pet_visible_now(false, false, true, true, true));
        assert!(!pet_visible_now(false, false, true, true, false));
        assert!(!pet_visible_now(false, false, false, false, false));
        assert!(!pet_visible_now(false, true, true, false, false));
    }

    #[test]
    fn pet_tour_spot_is_bottom_center_of_the_work_area() {
        assert_eq!(
            pet_tour_spot(0.0, 25.0, 1440.0, 875.0),
            PetTourSpot { x: 640.0, y: 740.0 }
        );
        // Second monitor to the left of the primary one.
        assert_eq!(
            pet_tour_spot(-1920.0, 0.0, 1920.0, 1080.0),
            PetTourSpot { x: -1040.0, y: 920.0 }
        );
        // An area smaller than the pet keeps it at the area's top-left.
        assert_eq!(pet_tour_spot(10.0, 20.0, 100.0, 100.0), PetTourSpot { x: 10.0, y: 20.0 });
    }

    #[test]
    fn pet_tour_start_payload_shape() {
        let v = serde_json::to_value(PetTourStart { spot: Some(PetTourSpot { x: 1.0, y: 2.0 }) }).unwrap();
        assert_eq!(v, json!({"spot": {"x": 1.0, "y": 2.0}}));
        let none = serde_json::to_value(PetTourStart { spot: None }).unwrap();
        assert_eq!(none, json!({"spot": null}));
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
