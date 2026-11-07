# Desktop Pet — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pixel-art character window that appears when BBARIT's main window is minimized or closed, walks / idles / sleeps along the bottom of the screen, can be dragged and pinned, and brings BBARIT back on double-click.

**Architecture:** Rust owns window lifecycle (hide-on-close on macOS, Reopen, pet show/hide, user pack listing). A new `/pet` page renders a character pack on a canvas and runs a pure behavior engine that decides animation and position each tick. Packs are JSON pixel grids; the default character ships as a TS module, user packs come from `~/.config/octo/characters/<id>/character.json`.

**Tech Stack:** Tauri 2.10.3 (Rust), React 18 + TypeScript, Vitest, Canvas 2D.

**Spec:** `docs/superpowers/specs/2026-11-06-desktop-pet-design.md` (phase 1 of its "Phases" list; read the spec's Goals 1, 2, 4, 8, Anti-goals, Constraints, "Window and lifecycle", "Movement and pinning", "Rendering and art", "Character packs").

## Global Constraints

- Never write `~/.claude/settings.json`. No new Claude hooks.
- The pet window must not take focus, must not appear in Cmd-Tab / Dock as its own window, and only its own rect is clickable.
- Idle CPU of the pet under 1% on Apple Silicon; animation loop stops while the pet window is hidden.
- Nothing Clawd-related is committed. Default character is original.
- User packs live in `~/.config/octo/characters/<id>/character.json`; the app only reads them.
- Config lives in `~/.config/octo/config.json` under a new top-level `pet` object: `{ "enabled": boolean (default true), "character": string (default "octo"), "mode": "walk" | "stay" (default "walk") }`.
- macOS only is verified; other OS keeps current close behavior (quit) unchanged.
- Dev-app testing: back up/restore `~/.config/octo/config.json`; address the dev app only by pid from `pgrep -f 'src-tauri/target/debug/octo-ui$'` (CLAUDE.md).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Subagents commit, never push.

## Review Focus

1. Unsaved-file prompt on close: with hide-on-close, closing the main window on macOS must not prompt and must not destroy the window; Cmd-Q still quits normally (holder handover unchanged).
2. Monitor changes: pet position saved on a monitor that is gone, or a resolution change, must clamp back into a visible work area (engine test `clampToWorkArea`).
3. Broken user pack (bad JSON, missing required animation, ragged rows, unknown palette char) must be skipped with a console warning, never crash the pet; default pack still loads.
4. Main window restored by any path (Dock click, Cmd-Tab, single-instance launch, double-click on pet) must hide the pet — no pet left floating over the open app.
5. Drag released outside every work area / off-screen must land the pet back on a valid bottom edge.

---

### Task 1: Rust host — lifecycle, pet window, pack listing

**Files:**
- Create: `src-tauri/src/pet.rs`
- Modify: `src-tauri/src/main.rs` (`mod pet;`, `.on_window_event` CloseRequested/Resized branches ~10071, single-instance handler ~10018, `.run` closure ~10549 add `RunEvent::Reopen`, register commands in `invoke_handler`)
- Modify: `src-tauri/Cargo.toml` (tauri features add `macos-private-api`), `src-tauri/tauri.conf.json` (`app.macOSPrivateApi: true`), `src-tauri/capabilities/default.json` (add `"pet"` to `windows`, add `core:window:allow-set-position`, `core:window:allow-start-dragging` if used, `core:window:allow-hide`, `core:window:allow-show`, `core:window:allow-unminimize`)
- Modify: `src/App.tsx` ~14770 main `onCloseRequested`: on macOS return immediately (no prompt; Rust hides the window).

**Interfaces:**
- Produces (Tauri commands, all `#[tauri::command(async)]`):
  - `pet_list_characters() -> Vec<UserPack>` where `UserPack { id: String, json: String }` (serde camelCase), read from `~/.config/octo/characters/*/character.json`, skipping unreadable dirs; `id` = folder name.
  - `pet_open_main()` — show + unminimize + focus `main`, hide `pet`.
  - `pet_hide()` — hide `pet` (until main is shown and hidden/minimized again).
- Produces (pure, in `pet.rs`): `pub fn pet_should_show(enabled: bool, main_visible: bool, main_minimized: bool) -> bool` (true iff enabled && (!main_visible || main_minimized)); `pub fn read_user_packs(dir: &Path) -> Vec<UserPack>`; `pub fn pet_enabled(config: &serde_json::Value) -> bool` (default true; only `pet.enabled == false` disables).
- Pet window: label `pet`, url `/pet`, 160×160 logical, `transparent(true)`, `decorations(false)`, `shadow(false)`, `always_on_top(true)`, `visible_on_all_workspaces(true)`, `skip_taskbar(true)`, `resizable(false)`, `focused(false)`, created lazily on first show, then shown/hidden (never destroyed while the app runs).
- Events emitted to the pet window: `pet-visibility` `{ visible: bool }` on every show/hide.

- [ ] **Step 1: Write failing Rust tests in `pet.rs` `#[cfg(test)]`**
  - `pet_should_show(true, false, false) == true`, `(true, true, true) == true`, `(true, true, false) == false`, `(false, false, false) == false`.
  - `pet_enabled(&json!({})) == true`, `pet_enabled(&json!({"pet":{"enabled":false}})) == false`, `pet_enabled(&json!({"pet":{"enabled":"no"}})) == true`.
  - `read_user_packs` on a tempdir with `a/character.json` (content `{}`), `b/` (no file), `c.txt` (file) returns exactly `[UserPack{id:"a", json:"{}"}]`; on a missing dir returns empty.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml --locked pet::` — expect FAIL (unresolved).
- [ ] **Step 3: Implement `pet.rs`** pure fns + commands + `fn sync_pet(app: &AppHandle)` that reads main's `is_visible`/`is_minimized` and config, creates/shows/hides the pet and emits `pet-visibility`.
- [ ] **Step 4: Wire lifecycle in `main.rs`:** macOS `CloseRequested` on `main` → `api.prevent_close()`, `window.hide()`, `sync_pet`. `Resized`/`Focused` on `main` → `sync_pet`. `RunEvent::Reopen` → show+focus main, `sync_pet`. Single-instance → show+unminimize+focus main, `sync_pet`. Non-macOS paths unchanged.
- [ ] **Step 5: Run** the pet tests (PASS) and `cargo check --manifest-path src-tauri/Cargo.toml --locked` (no errors). Paste the real output in the report.
- [ ] **Step 6: Commit** `Desktop pet: host lifecycle, pet window, user pack listing`.

### Task 2: Pack format, default character, renderer

**Files:**
- Create: `src/pet/pack.ts`, `src/pet/pack.test.ts`, `src/pet/characters/octo.ts`, `src/pet/render.ts`

**Interfaces:**
- Produces:
  - `type Anchor = { x: number; y: number }`
  - `type PackFrame = { rows: string[]; ms: number; anchors?: Partial<Record<'head'|'hand'|'body', Anchor>> }`
  - `type CharacterPack = { id: string; name: string; size: { w: number; h: number }; scale: number; palette: Record<string, string>; animations: Record<AnimName, PackFrame[]> }` — `'.'` in rows is always transparent and must not be in `palette`.
  - `type AnimName = 'idle'|'walk'|'sit'|'sleep'|'held'|'fall'|'happy'|'busy'|'wave'|'eat'`; `REQUIRED_ANIMS: AnimName[] = ['idle','walk','sit','sleep','held','fall']` (the rest fall back to `idle`).
  - `parsePack(json: unknown, idFallback: string): { ok: true; pack: CharacterPack } | { ok: false; error: string }`
  - `framesFor(pack: CharacterPack, anim: AnimName): PackFrame[]` (fallback to idle)
  - `OCTO_PACK: CharacterPack` — original small octopus, 24×24 grid, scale 4, ≥2 frames for idle/walk/sleep/held/fall, 1+ for sit; also happy/busy/wave/eat (used in later phases). Expressive face (eyes blink in idle, closed eyes + "z" not drawn in sprite — Zzz is an effect later).
  - `drawFrame(ctx: CanvasRenderingContext2D, pack: CharacterPack, frame: PackFrame, x: number, y: number, flip: boolean): void` (nearest-neighbor `fillRect` per pixel, `imageSmoothingEnabled=false`).
- [ ] **Step 1: Failing tests in `pack.test.ts`:** `parsePack(OCTO_PACK,'x').ok === true`; missing `walk` → `ok:false` with error containing `walk`; a row shorter than `size.w` → `ok:false` containing `row`; a char not in palette and not `.` → `ok:false` containing the char; non-object input → `ok:false`; `framesFor(packWithoutHappy,'happy') === pack.animations.idle`; every OCTO frame has `rows.length === size.h` and each row `length === size.w`.
- [ ] **Step 2: Run** `npx vitest run src/pet/pack.test.ts` — FAIL.
- [ ] **Step 3: Implement** `pack.ts`, author `octo.ts` art, `render.ts`.
- [ ] **Step 4: Run** the tests — PASS (paste output).
- [ ] **Step 5: Commit** `Desktop pet: pack format, default octo character, renderer`.

### Task 3: Behavior engine

**Files:**
- Create: `src/pet/engine.ts`, `src/pet/engine.test.ts`

**Interfaces:**
- Consumes: `AnimName` from Task 2.
- Produces:
  - `type WorkArea = { x: number; y: number; w: number; h: number }` (logical px)
  - `type PetState = { anim: AnimName; x: number; y: number; dir: 1 | -1; mode: 'walk'|'stay'; pinned: boolean; idleMs: number; actionMs: number; vy: number }` — `x,y` = window top-left; pet window size `PET_W = 160`, `PET_H = 160`.
  - `type PetInput = { dtMs: number; areas: WorkArea[]; rand: () => number; dragging: { x: number; y: number } | null; activity: boolean }` (`activity` = owner input or, later, Claude activity; resets the sleep timer).
  - `initialState(areas: WorkArea[], saved?: Partial<PetState>): PetState`
  - `step(s: PetState, i: PetInput): PetState` — pure.
  - `clampToWorkArea(x: number, y: number, areas: WorkArea[]): { x: number; y: number; area: WorkArea }` — nearest area if the point is in none.
  - `groundY(area: WorkArea): number` = `area.y + area.h - PET_H`.
  - Constants: `WALK_PX_PER_S = 30`, `SLEEP_AFTER_MS = 5 * 60_000`, `FALL_G = 2000` (px/s²).
- Rules: dragging → `anim='held'`, position = drag point, `pinned=false`. On release: if within 40 px of `groundY` → `fall` to ground then walk mode; else `pinned=true`, stay there. Not pinned + mode walk: alternate walk (2–8 s) and idle/sit (3–10 s) by `rand`; reverse `dir` at area edges. Pinned or mode stay: idle/sit only, no x change. `idleMs >= SLEEP_AFTER_MS` → `sleep` (no movement); any `activity` or drag → wake (`idleMs=0`, anim idle).
- [ ] **Step 1: Failing tests:** walking 1000 ms moves `x` by 30 ± 1 in `dir`; at right edge `dir` flips to -1 and x stays inside area; after `SLEEP_AFTER_MS` with no activity `anim==='sleep'` and x unchanged over another tick; `activity:true` wakes it; drag sets `held` and position; release high on screen → `pinned` and x,y unchanged after 10 s of ticks; release 20 px above ground → ends on `groundY` with `pinned=false`; `clampToWorkArea(-5000, -5000, [area])` returns a point inside `area`; `initialState(areas, {x: 99999, y: 99999})` lands inside an area; `rand` stubbed for determinism.
- [ ] **Step 2: Run** `npx vitest run src/pet/engine.test.ts` — FAIL.
- [ ] **Step 3: Implement** `engine.ts`.
- [ ] **Step 4: Run** — PASS (paste output).
- [ ] **Step 5: Commit** `Desktop pet: behavior engine`.

### Task 4: Pet page, interaction, settings

**Files:**
- Create: `src/pages/PetPage.tsx`, `src/pages/PetPage.css`
- Modify: `src/main.tsx` (route `/pet` → `PetPage`), `src/components/SettingsPanel.tsx` (pet section: enabled toggle, character select from OCTO + `pet_list_characters`, mode walk/stay), `src/i18n/ko.ts`, `src/i18n/en.ts` (keys `settings.pet.*`, `pet.menu.*`).

**Interfaces:**
- Consumes: Task 1 commands/event, Task 2 `parsePack`/`framesFor`/`drawFrame`/`OCTO_PACK`, Task 3 `initialState`/`step`.
- Behavior:
  - Transparent page (`html, body, #root { background: transparent }` scoped by a `pet-page` class on `<html>` set in PetPage — no inline `<style>` in index.html).
  - Loop at ~12 fps via `setTimeout` (not rAF spinning); stops when `pet-visibility` says hidden or `document.hidden`.
  - Each tick: `step()`, move window with `getCurrentWindow().setPosition(new LogicalPosition(x, y))` only when position changed; draw current frame bottom-centered.
  - Work areas from `availableMonitors()` (use `workArea` if present, else `position/size`, converted to logical by `scaleFactor`); refresh on `pet-visibility` and every 30 s.
  - Drag: pointerdown on canvas body → track `screenX/screenY` (pointer capture) and feed `dragging`; pointerup ends it. Do not use `startDragging()`.
  - Double-click → `invoke('pet_open_main')`.
  - Right-click → small in-window menu: `빠릿 열기` (`pet_open_main`), `여기 고정` / `다시 걸어다니기` (toggle pinned), `숨기기` (`pet_hide`).
  - Persist `{x, y, pinned}` in `localStorage` key `bbarit.pet.pos` (try/catch).
  - Character: config `pet.character`; user pack with same id overrides bundled; parse failures fall back to `OCTO_PACK` with `console.warn`.
- [ ] **Step 1: Implement** the page, route, settings and i18n.
- [ ] **Step 2: Verify** `npm run build` succeeds and `npx vitest run src/pet` passes; `cargo check` still clean. Paste outputs.
- [ ] **Step 3: Commit** `Desktop pet: pet page, drag/pin, double-click restore, settings`.

### Task 5: Dev-app check (main session with the owner)

- [ ] Run dev app from the worktree (backup config first). Check: close main → pet appears, no prompt; minimize → pet appears; Dock click / double-click pet → main back, pet gone; walk, pause, sleep (temporarily lower `SLEEP_AFTER_MS` via a dev-only query param `?sleepMs=` is allowed); drag + pin; right-click menu; settings toggle off → pet never shows; CPU `ps -o %cpu -p <pet webview pid>` under 1% idle.
- [ ] Owner looks at the art and behavior; iterate before merge.
