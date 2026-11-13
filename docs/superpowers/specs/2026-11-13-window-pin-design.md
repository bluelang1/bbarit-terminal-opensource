# Window pin: follow desktops and always on top

## Why
The main window once got stuck above every window and on every desktop (a macOS
window-server state, not app code: the window was registered to one Space, drawn on
another, at normal level). The owner liked the effect and wants it as two deliberate
switches instead of an accident.

## Goals
- Two toggle buttons next to the task-completion bell in the top bar:
  - Follow desktops: the main window follows you to the macOS desktop (Space) you
    switch to. It lives on one Space at a time (MoveToActiveSpace, moved on each
    Space change in src-tauri/src/window_pin.rs); CanJoinAllSpaces was dropped because
    picking the window in Mission Control switched back to its original Space.
  - Always on top: the main window stays above other windows.
- Both off by default. The same two values appear in Settings.
- The state is remembered: button and Settings edit one persisted value per switch
  (config.json), applied at startup and immediately on change.

## Non-goals
- The pet window is untouched. (Always on top carries over to the app's other windows
  so they never open behind main; follow desktops is main only and arrives behind the
  desktop's windows unless always on top is also on.)
- No attempt to reproduce or repair the accidental macOS state.
- No guarantee of showing over another app's full-screen Space (macOS limit).

## Approaches
1. Tauri window API from the frontend (`setAlwaysOnTop`,
   `setVisibleOnAllWorkspaces`) driven by config. Picked: no Rust, same path the bell
   uses for persistence, testable with a fake window.
2. Rust command setting NSWindow level / collectionBehavior. More code, same result.
   Update after native testing: on macOS this is what ships (window_pin_apply), since
   the Tauri path left a pinned window out of Mission Control and CanJoinAllSpaces
   jumped back to the original Space; other platforms keep approach 1.
3. Separate "session state" and "startup default". Dropped: the owner chose remembered
   state, so one value per switch is enough.

## Design
- Config: `window.alwaysOnTop`, `window.followDesktops` (booleans, default false) in
  src/config/schema.ts, with the usual load/merge defaults.
- `src/window/windowPin.ts`: pure `applyWindowPin(win, state)` calling the two window
  methods, swallowing/logging failures; unit-tested with a fake window.
- App.tsx: effect keyed on the two booleans applies them to the main window (Tauri
  only); two buttons after the bell, same visual pattern (accent when on), ko/en
  titles; they update state + `updateConfig` like the bell.
- Settings: two toggles bound to the same values.
- Capability: add `core:window:allow-set-visible-on-all-workspaces` to the default
  capability (`allow-set-always-on-top` is already there).
- Guide: one step in src/guide/steps.ts pointing at the buttons (`data-guide`).
- CHANGELOG.md (추가) and CHANGELOG.en.md (Added): one line each.

## Left to the builder
Icon choice (lucide), exact settings section, key names in i18n.

## Verification
Unit tests + `npm run test:run`, `npm run build`. Native behaviour (follows desktops,
stays on top, survives restart) is checked in the dev app on macOS before release.
