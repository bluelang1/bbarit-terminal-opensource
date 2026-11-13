//! Window pin on macOS: "always on top" and "follow desktops" for the main
//! window (and the app windows pinned along with it). Frontend: src/window/windowPin.ts.
//!
//! tao's `set_always_on_top` only raises the level to NSFloatingWindowLevel. AppKit
//! documents that a window whose level is not NSNormalWindowLevel defaults to
//! `Transient` (hidden by Exposé / Mission Control) and `IgnoresCycle`; a normal-level
//! window defaults to `Managed` + `ParticipatesInCycle`. A pinned window therefore
//! sets Managed + ParticipatesInCycle explicitly so it stays pickable in Mission Control.
//!
//! "Follow desktops" keeps the window on exactly one Space and moves it along. It sets
//! MoveToActiveSpace (never CanJoinAllSpaces: with that, picking the window in Mission
//! Control switched back to the Space it was created on). Apple documents
//! MoveToActiveSpace as "making the window active does not cause a space switch; the
//! window switches to the active space". On every active-Space change the main window
//! is also moved to the new Space without app activation or key focus: behind that
//! desktop's windows (`orderBack`) normally, in front (`orderFrontRegardless`) when it is
//! always on top. The move draws the window at its old front position for a frame, so
//! it is made transparent for the move and shown again ~150 ms later (HIDE_GEN keeps a
//! stale callback from showing or hiding it). If the window is still not on the active
//! Space after that, order front then back is tried. Each change logs which path worked.

use tauri::{AppHandle, Manager};

// NSWindowCollectionBehavior bits (AppKit NSWindow.h).
pub const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
pub const MOVE_TO_ACTIVE_SPACE: usize = 1 << 1;
pub const MANAGED: usize = 1 << 2;
pub const TRANSIENT: usize = 1 << 3;
pub const STATIONARY: usize = 1 << 4;
pub const PARTICIPATES_IN_CYCLE: usize = 1 << 5;
pub const IGNORES_CYCLE: usize = 1 << 6;

/// Mutually exclusive Exposé group and window-cycle group.
const SPACES_GROUP: usize = MANAGED | TRANSIENT | STATIONARY;
const CYCLE_GROUP: usize = PARTICIPATES_IN_CYCLE | IGNORES_CYCLE;
/// Mutually exclusive Space association (CanJoinAllSpaces vs MoveToActiveSpace).
const SPACE_ASSOC: usize = CAN_JOIN_ALL_SPACES | MOVE_TO_ACTIVE_SPACE;

pub const LEVEL_NORMAL: isize = 0; // NSNormalWindowLevel
pub const LEVEL_FLOATING: isize = 3; // NSFloatingWindowLevel

pub const MAIN_LABEL: &str = "main";

/// Level and collection behavior for a window.
///
/// `current` is the window's behavior now; `baseline` the behavior it had before the
/// pin ever touched it. Bits outside the Exposé, cycle and Space-association groups
/// (FullScreenPrimary, tiling, ...) are kept from `current`. Off restores the
/// baseline's groups at normal level, with CanJoinAllSpaces removed. Follow sets
/// MoveToActiveSpace and clears CanJoinAllSpaces (they are mutually exclusive).
pub fn pin_target(current: usize, baseline: usize, always_on_top: bool, follow_desktops: bool) -> (isize, usize) {
    let mut bits = current & !(SPACES_GROUP | CYCLE_GROUP | SPACE_ASSOC);
    if always_on_top {
        bits |= MANAGED | PARTICIPATES_IN_CYCLE;
    } else {
        bits |= baseline & (SPACES_GROUP | CYCLE_GROUP);
    }
    if follow_desktops {
        bits |= MOVE_TO_ACTIVE_SPACE;
    } else {
        bits |= baseline & MOVE_TO_ACTIVE_SPACE;
    }
    let level = if always_on_top { LEVEL_FLOATING } else { LEVEL_NORMAL };
    (level, bits)
}

/// What the main window is doing when the active Space changes.
#[derive(Clone, Copy, Debug, Default)]
pub struct SpaceChangeView {
    pub follow: bool,
    pub visible: bool,
    pub minimized: bool,
    pub fullscreen: bool,
    /// Already on an active Space (e.g. the change happened on another display).
    pub on_active_space: bool,
}

/// Move main to the new Space only while following, shown, not minimized, not in
/// native full screen and not already on an active Space.
pub fn should_follow_space_change(v: SpaceChangeView) -> bool {
    v.follow && v.visible && !v.minimized && !v.fullscreen && !v.on_active_space
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, Once, OnceLock};

    /// Main's current switches, read by the Space-change observer.
    static MAIN_FOLLOWS: AtomicBool = AtomicBool::new(false);
    static MAIN_ON_TOP: AtomicBool = AtomicBool::new(false);
    static OBSERVER: Once = Once::new();
    /// Latest Space change that hid the window; only that one may show it again.
    static HIDE_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// Wait before asking whether the window reached the active Space.
    const SETTLE_MS: u64 = 150;

    /// Behavior each window had before the pin first touched it (by label).
    fn baselines() -> &'static Mutex<HashMap<String, usize>> {
        static B: OnceLock<Mutex<HashMap<String, usize>>> = OnceLock::new();
        B.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn ns_window(app: &AppHandle, label: &str) -> Option<&'static NSWindow> {
        let win = app.get_webview_window(label)?;
        match win.ns_window() {
            // SAFETY: a live NSWindow owned by tao; only used on the main thread
            // within this call, while the window exists.
            Ok(ptr) if !ptr.is_null() => Some(unsafe { &*(ptr as *const NSWindow) }),
            _ => None,
        }
    }

    /// Main thread only: set level + behavior from the switches and the baseline.
    fn set_pin(win: &NSWindow, label: &str, always_on_top: bool, follow: bool) {
        let current = win.collectionBehavior().0;
        let baseline = *baselines()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(label.to_string())
            .or_insert(current);
        let (level, bits) = pin_target(current, baseline, always_on_top, follow);
        win.setLevel(level);
        win.setCollectionBehavior(NSWindowCollectionBehavior(bits));
    }

    /// Main thread only.
    pub fn apply(app: &AppHandle, label: &str, always_on_top: bool, follow: bool) {
        let Some(win) = ns_window(app, label) else { return };
        set_pin(win, label, always_on_top, follow);
        if label == MAIN_LABEL {
            // Never leave main invisible if a switch changes mid-move.
            HIDE_GEN.fetch_add(1, Ordering::SeqCst);
            win.setAlphaValue(1.0);
            MAIN_FOLLOWS.store(follow, Ordering::SeqCst);
            MAIN_ON_TOP.store(always_on_top, Ordering::SeqCst);
            if follow {
                OBSERVER.call_once(|| observe_space_changes(app.clone()));
            }
        }
    }

    /// Run `f` on the main thread after the window server has had time to settle.
    fn after_settle(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(SETTLE_MS));
            let _ = app.run_on_main_thread(f);
        });
    }

    /// Main thread only: move main to the new active Space.
    fn follow_space_change(app: &AppHandle) {
        let Some(win) = ns_window(app, MAIN_LABEL) else { return };
        let view = SpaceChangeView {
            follow: MAIN_FOLLOWS.load(Ordering::SeqCst),
            visible: win.isVisible(),
            minimized: win.isMiniaturized(),
            fullscreen: win.styleMask().contains(NSWindowStyleMask::FullScreen),
            on_active_space: win.isOnActiveSpace(),
        };
        if !should_follow_space_change(view) {
            return;
        }
        // Always on top: arrive in front (the level keeps it there). Otherwise arrive
        // BEHIND the desktop's own windows, so nothing flashes over what the user is
        // looking at; neither call activates the app or takes key focus.
        let on_top = MAIN_ON_TOP.load(Ordering::SeqCst);
        if on_top {
            win.orderFrontRegardless();
        } else {
            // Moving to the new Space shows the window at its old (front) position for
            // a frame before it drops behind. Make that frame invisible; the settle
            // callback below shows it again once it is behind the desktop's windows.
            win.setAlphaValue(0.0);
            win.orderBack(None);
        }
        let hide_gen = HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let app2 = app.clone();
        // The window server reports the move a little later than the call.
        after_settle(app, move || {
            let Some(win) = ns_window(&app2, MAIN_LABEL) else { return };
            // Always show the window again, unless a newer Space change owns it now.
            // A newer change also owns the rest of the work.
            if HIDE_GEN.load(Ordering::SeqCst) != hide_gen {
                return;
            }
            win.setAlphaValue(1.0);
            if !MAIN_FOLLOWS.load(Ordering::SeqCst) || win.isMiniaturized() {
                return;
            }
            if win.isOnActiveSpace() {
                crate::safe_eprintln!("[window-pin] space change: moved ({})", if on_top { "front" } else { "back" });
                return;
            }
            // Ordering back did not bring it over: ordering front does (measured),
            // then drop behind again in the same turn.
            win.orderFrontRegardless();
            if !MAIN_ON_TOP.load(Ordering::SeqCst) {
                win.orderBack(None);
            }
            let app3 = app2.clone();
            after_settle(&app2, move || {
                let Some(win) = ns_window(&app3, MAIN_LABEL) else { return };
                if win.isOnActiveSpace() {
                    crate::safe_eprintln!("[window-pin] space change: moved (front then back)");
                } else {
                    crate::safe_eprintln!("[window-pin] space change: still not on active space");
                }
            });
        });
    }

    /// Follow the active Space while main follows desktops. Installed once, on first use.
    fn observe_space_changes(app: AppHandle) {
        use block2::RcBlock;
        use objc2_app_kit::{NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification};
        use objc2_foundation::NSNotification;
        use std::ptr::NonNull;

        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if MAIN_FOLLOWS.load(Ordering::SeqCst) {
                follow_space_change(&app);
            }
        });
        // SAFETY: the notification name is an immutable AppKit constant; NSWorkspace
        // posts on the main thread, where all AppKit work here runs; the block captures
        // only an AppHandle.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceActiveSpaceDidChangeNotification),
                None,
                None,
                &block,
            )
        };
        // Never removed: lives as long as the app.
        std::mem::forget(token);
    }
}

/// Apply the pin to one window. The pet window is never touched.
#[tauri::command(async)]
pub fn window_pin_apply(
    app: AppHandle,
    label: String,
    always_on_top: bool,
    follow_desktops: bool,
) -> Result<(), String> {
    if label == "pet" {
        return Err("the pet window is not pinned".into());
    }
    if app.get_webview_window(&label).is_none() {
        return Err(format!("no window {label}"));
    }
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        app.run_on_main_thread(move || mac::apply(&app2, &label, always_on_top, follow_desktops))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let win = app.get_webview_window(&label).ok_or("window gone")?;
        win.set_always_on_top(always_on_top).map_err(|e| e.to_string())?;
        win.set_visible_on_all_workspaces(follow_desktops).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULLSCREEN_PRIMARY: usize = 1 << 7;
    const TILING: usize = 1 << 11;

    #[test]
    fn on_top_is_floating_and_stays_in_mission_control() {
        let (level, bits) = pin_target(0, 0, true, false);
        assert_eq!(level, LEVEL_FLOATING);
        assert_eq!(bits, MANAGED | PARTICIPATES_IN_CYCLE);
    }

    #[test]
    fn follow_moves_to_active_space_and_never_joins_all() {
        let (level, bits) = pin_target(CAN_JOIN_ALL_SPACES, 0, false, true);
        assert_eq!(level, LEVEL_NORMAL);
        assert_eq!(bits, MOVE_TO_ACTIVE_SPACE);
        assert_eq!(bits & CAN_JOIN_ALL_SPACES, 0);
    }

    #[test]
    fn keeps_unrelated_bits_and_combines_both_switches() {
        let cur = FULLSCREEN_PRIMARY | TILING;
        let (level, bits) = pin_target(cur, cur, true, true);
        assert_eq!(level, LEVEL_FLOATING);
        assert_eq!(bits, FULLSCREEN_PRIMARY | TILING | MANAGED | PARTICIPATES_IN_CYCLE | MOVE_TO_ACTIVE_SPACE);
    }

    #[test]
    fn replaces_conflicting_group_bits() {
        let cur = TRANSIENT | IGNORES_CYCLE | CAN_JOIN_ALL_SPACES;
        let (_, bits) = pin_target(cur, 0, true, true);
        assert_eq!(bits & (TRANSIENT | IGNORES_CYCLE | CAN_JOIN_ALL_SPACES), 0);
        assert_eq!(bits, MANAGED | PARTICIPATES_IN_CYCLE | MOVE_TO_ACTIVE_SPACE);
    }

    #[test]
    fn off_restores_the_baseline_exactly() {
        for baseline in [0, FULLSCREEN_PRIMARY, FULLSCREEN_PRIMARY | MANAGED, MOVE_TO_ACTIVE_SPACE | TILING] {
            for (top, follow) in [(true, true), (true, false), (false, true)] {
                let (_, pinned) = pin_target(baseline, baseline, top, follow);
                let (level, off) = pin_target(pinned, baseline, false, false);
                assert_eq!(level, LEVEL_NORMAL);
                assert_eq!(off, baseline, "baseline {baseline:#x} top {top} follow {follow}");
            }
        }
    }

    #[test]
    fn off_clears_a_stray_join_all_bit() {
        let mid = CAN_JOIN_ALL_SPACES | FULLSCREEN_PRIMARY;
        assert_eq!(pin_target(mid, FULLSCREEN_PRIMARY, false, false).1, FULLSCREEN_PRIMARY);
        assert_eq!(pin_target(mid, FULLSCREEN_PRIMARY, false, true).1, FULLSCREEN_PRIMARY | MOVE_TO_ACTIVE_SPACE);
    }

    #[test]
    fn space_change_moves_only_a_shown_following_window_off_the_active_space() {
        let base = SpaceChangeView { follow: true, visible: true, ..Default::default() };
        assert!(should_follow_space_change(base));
        assert!(!should_follow_space_change(SpaceChangeView { follow: false, ..base }));
        assert!(!should_follow_space_change(SpaceChangeView { visible: false, ..base }));
        assert!(!should_follow_space_change(SpaceChangeView { minimized: true, ..base }));
        assert!(!should_follow_space_change(SpaceChangeView { fullscreen: true, ..base }));
        // A Space change on another display leaves the window on an active Space.
        assert!(!should_follow_space_change(SpaceChangeView { on_active_space: true, ..base }));
    }
}
