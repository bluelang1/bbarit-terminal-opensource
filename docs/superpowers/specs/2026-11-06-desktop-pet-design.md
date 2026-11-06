# Desktop pet — design

Date: 2026-11-06. Status: draft for owner approval.

## Intent

When BBARIT is minimized or its window is closed, a small pixel-art character
lives on the desktop. It is there mostly for fun while the owner does other
work: it walks along the bottom of the screen, sleeps, eats seasonal snacks,
wears holiday outfits and reacts to the real weather. It also carries the
terminal's state: when a Claude tab is working, done or waiting for approval
the character shows it, with a speech bubble for anything that needs the
owner. Double-clicking the character brings BBARIT back to its previous size
with the right tab in front.

Priority set by the owner: fun first, notifications second (but they come
almost for free because Claude state drives the character's mood).

## Goals

1. A transparent, always-on-top, pet-sized window that appears when the main
   window is minimized or closed (red button) and disappears when it is
   restored.
2. Idle life: walk along the bottom edge of the current screen, stop and look
   around, sit, yawn, fall asleep after a while; react when picked up and
   dropped. The owner can drag it anywhere; a dropped character stays pinned
   there and does its idle actions in place (see "Movement and pinning").
3. Claude state from BBARIT tabs: working (busy animation), done (happy),
   blocked / approval needed (waves + bubble "프로젝트 · 탭: 승인 필요").
   Several tabs: the most urgent wins (blocked > fresh done > working > idle).
   "Claude state" counts only tabs that have reported OSC 7501 or are agent
   tabs (Claude/Codex launched by BBARIT). Plain shell output (dev servers,
   `tail -f`, watchers) never makes the pet busy, so it still gets to sleep.
   [designer's call]
4. Double-click the character: unminimize / show the main window, focus it,
   and switch to the tab that needs attention (blocked first, then the most
   recent done-unseen, else the last active tab). Clicking a bubble does the
   same for that bubble's tab.
5. Special days (local date): 11/11 빼빼로데이 (eats Pepero), 2/14
   발렌타인데이 (chocolate), 3/14 화이트데이 (candy), 10/31 할로윈 (costume +
   pumpkin), 12/24–25 크리스마스 (Santa outfit). Shown all day.
6. Seasons (Korean months): spring 3–5 (petals), summer 6–8 (sunglasses /
   fan), autumn 9–11 (falling leaves), winter 12–2 (scarf, breath puffs).
7. Weather: if the owner sets a city, current conditions come from Open-Meteo
   (no key). Rain: drops fall inside the pet window, the character uses an
   umbrella or raincoat, footsteps make ripples and splashes. Snow: flakes,
   footprints. Clear/cloudy/fog/thunder get lighter touches.
8. Characters are packs. The repo ships one original character. The owner's
   Claude Code character (Clawd) is generated as a local pack that lives
   outside the app bundle and survives updates.

## Non-goals (for now)

- Full-screen overlay effects (rain across the whole screen). Effects stay
  inside the pet window.
- Sitting on top of other apps' windows. Later phase, only if reading window
  bounds needs no extra macOS permission.
- Popped-out terminal windows (`term-detach-*`): their tabs are not in the
  pet feed, and the pet's show/hide follows the main window only.
  [designer's call]
- Answering approvals (Allow/Deny) from the bubble. The bubble opens the tab;
  the owner answers there.
- Lunar holidays (설날, 추석), user-defined events.
- Windows/Linux polish. Code stays cross-platform where free, but only macOS
  is verified.
- Living on after Cmd-Q. Quit means quit; terminals still survive in the PTY
  holder as today.

## Anti-goals (failure even if it works)

- The pet gets in the way: steals focus, blocks clicks outside its body,
  appears in Cmd-Tab or the Dock, covers text the owner is reading for long.
- Noticeable CPU/battery use. Target < 1% CPU idle on Apple Silicon; the
  animation pauses when the pet is hidden.
- Clawd art committed to the public repo.
- Location or weather calls happening without the owner choosing a city.
- An update deleting the owner's character packs.

## Constraints from the codebase

- Tauri 2.10.3: transparent windows on macOS need the `macos-private-api`
  cargo feature and `app.macOSPrivateApi: true` (not App Store compatible; the
  fork is not on the App Store).
- Main-window close on macOS currently destroys the window
  (`main.rs` `CloseRequested` returns without `prevent_close`), the Dock icon
  then cannot reopen it, and the single-instance handler only focuses an
  existing `main`. This must change to hide-instead-of-destroy.
- Agent status (OSC 7501 → `agentStatus` Map, `src/App.tsx`) and done/blocked
  alerts exist only in the main webview. Hiding (not destroying) the main
  window keeps that webview, its terminals and parsers running, so the pet
  can be fed from there. No new Claude hooks; never write
  `~/.claude/settings.json`.
- `capabilities/default.json` lists window labels; the pet window label must
  be added with only the permissions it needs.
- New windows are created from JS (`new WebviewWindow`) today; the pet window
  may be created from Rust or JS (builder's call), but must exist once.

## Approaches considered

- **A. Pet-sized transparent window that moves itself (chosen).** About
  160×160 logical px (bubble space above the body). Walking moves the window.
  Clicks outside the window go to whatever is behind; inside it the whole
  rect is clickable (transparent corners included — acceptable at this size).
  Lowest CPU, simplest input.
- B. Full-screen click-through overlay. Allows screen-wide rain, but
  `set_ignore_cursor_events` is all-or-nothing, so it needs a Rust global
  cursor poller to toggle it, costs more GPU, and breaks on multi-monitor and
  full-screen apps. Rejected: too much risk for the gain.
- C. Separate pet process that survives Cmd-Q. Rejected: needs its own state
  feed (hooks), more moving parts; owner accepted pet-ends-with-app.

The owner picked A.

## Decided design

### Window and lifecycle
- One window, label `pet`, transparent, no decorations, no shadow,
  always-on-top, visible on all workspaces, skip taskbar, not focusable on
  show (must not steal focus), not resizable.
- macOS main window close (red button): hide instead of destroy. Dock icon
  click (`RunEvent::Reopen`) and single-instance activation show it again.
- Pet shows when the main window is minimized or hidden, and the setting is
  on; hides when the main window is shown/unminimized. Owner can also
  hide the pet from its right-click menu ("숨기기 / 설정 / 빠릿 열기").
- While the main window is hidden the app keeps its Dock icon (Regular
  activation policy). Switching to Accessory is out of scope.
- Settings (Settings panel): pet on/off (default on), character, city for
  weather (default none = weather off), "walk around" vs "stay put".

### Movement and pinning
- Default: walks along the bottom of the work area (above the Dock) of the
  screen it is on, at a slow pace, with pauses; turns at screen edges.
- Drag with the mouse: plays a "held" animation; on drop it "falls" to the
  bottom edge if dropped low, otherwise stays pinned where dropped and does
  idle actions in place. Right-click menu "다시 걸어다니기" unpins.
- Position and pin state persist across launches.
- Screen changes (monitor unplugged, resolution change) clamp the pet back
  into a visible work area.

### Behavior engine
A small state machine in the pet webview. Inputs: Claude summary state, time,
date, season, weather, drag events, idle time. Priority:
1. Being dragged.
2. Claude blocked → wave + bubble (stays until the tab is seen or state
   changes).
3. Claude done → one reaction: happy jump plus a "완료" bubble that hides
   after 10 s, then back to normal idle life. Unseen finished tabs only keep
   a small badge on the pet (count), they do not hold the happy state or
   block sleep — the main window being hidden leaves turns unseen for hours.
   [designer's call: fun first]
4. Claude working → busy animation (typing/running), walks less.
5. Special-day action (periodically eats the treat, wears the outfit
   always).
6. Idle cycle: walk / stand / look around / sit; after N minutes without
   Claude activity or owner input, yawn → sleep (Zzz). Any state change
   wakes it.
Weather and season are visual layers that apply on top of every state
(umbrella while walking in rain, scarf in winter...).

### Rendering and art
- Canvas 2D, nearest-neighbor scaling of a small pixel grid (e.g. 32×32 body
  scaled ×3–4). ~12 fps sprite animation; movement ticks smooth.
- Three layers:
  1. Character body frames (per pack).
  2. Accessories (shared across packs): Santa hat/outfit, pumpkin, scarf,
     sunglasses, umbrella, raincoat, Pepero, chocolate, candy. Each pack
     declares anchor points (head, hand, body) per frame so shared
     accessories fit any character.
  3. Effects drawn in code: rain, splashes, ripples, snow, footprints,
     petals, leaves, Zzz, hearts, sweat drops.
- Art is authored by Claude (the assistant) as text pixel grids with a
  palette. The owner will review the look; if it is off, the owner supplies
  reference images and the art is redone. Art quality is expected to iterate.

### Character packs
- Bundled pack(s) ship inside the app resources (read-only, replaced on
  update). The repo's default is an original character (not Clawd).
- User packs live in `~/.config/octo/characters/<id>/` and are never touched
  by updates or uninstall of the app bundle. A user pack with the same id as
  a bundled one overrides it.
- Pack = `character.json`: id, name, palette, frame size, scale, animations
  (name → frames as row strings + per-frame duration + anchors), optional
  per-pack accessory overrides. Required animations: idle, walk, sit, sleep,
  held, fall, happy, busy, wave, eat. Missing optional ones fall back to
  idle.
- The Clawd pack is generated into the owner's `~/.config/octo/characters/
  clawd/` by a local, uncommitted step. Nothing Clawd-specific is committed.

### Claude state feed
- The main webview already computes per-tab `agentStatus` and done/blocked
  alerts. It sends the pet a compact summary (Tauri event): list of tabs that
  are blocked / done-unseen / working, with project name, tab title and tab
  id. Only on change, plus on pet show.
- Pet → main: "open tab <id>" / "open app" requests. The main window handles
  show/unminimize/focus and tab switching.

### Weather
- Open-Meteo forecast API with lat/lon from a city the owner picks (Open-Meteo
  geocoding search in Settings). Poll every 30 min while the pet is visible,
  cache the last result; offline = no weather layer. Weather code mapped to:
  clear, cloudy, fog, drizzle/rain, thunder, snow.
- No IP geolocation, no OS location permission.

## Phases (suggested order)

1. Window + lifecycle (hide-on-close, Reopen, minimize detection, pet show/
   hide), default character with idle/walk/sleep/held/fall, drag + pin,
   double-click restore, right-click menu, settings toggle.
2. Claude state summary feed, busy/happy/wave animations, bubbles, open-tab.
3. Seasons and special days (accessory layer + anchors, eat animation).
4. Weather (settings city search, Open-Meteo, rain/snow effects).
5. Local Clawd pack generation + pack loading from `~/.config/octo/characters`.
   (Pack loading itself lands in phase 1 so the default character uses it.)
Each phase gets a dev-app check by the owner before merge (owner's rule).

## Left to the builder

- Exact pixel sizes, frame counts, walk speed, sleep timeout, poll intervals.
- Whether the pet window is created in Rust or JS, and how its position is
  animated (JS `setPosition` per tick vs Rust-side mover), as long as idle
  CPU stays under target.
- Event names and payload shapes between main and pet windows.
- Test strategy: behavior engine, date/season/holiday mapping, weather-code
  mapping and pack parsing are pure and unit-tested; window behavior is
  checked in the dev app.
