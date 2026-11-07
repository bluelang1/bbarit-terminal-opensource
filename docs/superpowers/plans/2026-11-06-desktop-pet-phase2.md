# Desktop Pet — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The pet reflects Claude state from BBARIT tabs (busy / one-shot happy / blocked wave + bubble) and opens the right tab when the owner double-clicks the pet or clicks a bubble.

**Architecture:** The main window (still alive while hidden or minimized) builds a compact summary from its `agentStatus` map and emits it to the pet window on change. The pet page turns the summary into an engine input and draws bubbles. Pet → main requests go through a Rust command that shows main and emits a "focus tab" event the main window handles.

**Spec:** `docs/superpowers/specs/2026-11-06-desktop-pet-design.md` — Goals 3–4, "Behavior engine", "Claude state feed", Non-goal "Popped-out terminal windows".

## Global Constraints

- Only tabs that reported OSC 7501 (an `agentStatus` entry exists) or are Claude/Codex agent tabs count. Plain shell output never makes the pet busy.
- Done is a one-shot reaction: happy jump + "완료" bubble that hides after 10 s, then normal idle life. Unseen finished tabs only show a small count badge; they never hold the happy state or block sleep.
- Blocked shows a bubble "<project> · <tab>: 승인 필요" (en: "needs approval") and the wave animation until that tab is no longer blocked.
- Popped-out terminals (`term-detach-*`) are excluded.
- Never write into a PTY. No new Claude hooks. Never write `~/.claude/settings.json`.
- Summary emitted only on change (deep-equal on the summary), and once when the pet becomes visible.
- Pet window size may grow to fit a bubble (keep the body anchored at the same screen spot); the bubble text is truncated to one line, ~28 chars + "…".
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push. Do not launch or quit any app.

## Review Focus

1. Several tabs blocked at once: bubble shows the first (oldest blocked) plus "+N"; clicking opens that tab.
2. A tab closed while it is blocked/working: it disappears from the summary; the pet does not stay stuck waving.
3. Turn finishes while the pet is asleep: it wakes, does the happy reaction, and can sleep again later.
4. Double-click with nothing pending opens main on the last active tab (phase 1 behavior unchanged).
5. Main window visible: no summary spam to a hidden pet beyond change events.

---

### Task 1: Summary model (pure)

**Files:** Create `src/pet/summary.ts`, `src/pet/summary.test.ts`.

**Interfaces (Produces):**
- `type PetTab = { terminalId: string; projectId: string; project: string; tab: string; since: number }`
- `type PetSummary = { blocked: PetTab[]; working: PetTab[]; unseenDone: number; doneEvent?: { terminalId: string; turn: number; project: string; tab: string } }`
- `buildPetSummary(rows: Array<{ terminalId; projectId; project; tab; state: 'working'|'blocked'|'done'|'idle'; turn: number; seenTurn: number; since: number; agentTab: boolean; reported7501: boolean; detached: boolean }>): Omit<PetSummary,'doneEvent'>` — filters per Global Constraints; blocked sorted by `since` ascending.
- `summaryEquals(a, b): boolean`.
- `type ClaudeMood = 'blocked' | 'happy' | 'busy' | 'none'`
- `moodFor(summary: PetSummary, nowMs: number, lastDoneAtMs: number | null): ClaudeMood` — blocked > happy (within 10 000 ms of lastDoneAtMs) > busy (any working) > none.

- [ ] Tests first: shell tab with output but no 7501 and `agentTab:false` is excluded; detached excluded; two blocked sorted by since; done with seenTurn < turn counts in `unseenDone`; `moodFor` priority and the 10 s window (9 999 ms → happy, 10 001 → busy/none); `summaryEquals` true for equal content in new objects.
- [ ] `npx vitest run src/pet/summary.test.ts` FAIL → implement → PASS. Commit.

### Task 2: Engine mood input

**Files:** Modify `src/pet/engine.ts`, `src/pet/engine.test.ts`.

**Interfaces:** `PetInput` gains `mood: ClaudeMood` (default `'none'` where tests construct inputs). Rules: `blocked` → anim `wave`, no walking, resets idle timer each tick; `happy` → anim `happy` (in place) for the window, resets idle timer once on entry; `busy` → anim `busy` while standing, walks at half speed, resets idle timer; `none` → phase 1 behavior. Dragging still wins over everything. Asleep + mood change to blocked/happy → wakes.

- [ ] Tests first (each rule above, plus asleep → happy wakes it and after happy window it can fall asleep again after `SLEEP_AFTER_MS`). FAIL → implement → PASS. Commit.

### Task 3: Main → pet feed and pet → main open-tab

**Files:** Modify `src/App.tsx` (near `agentStateOf` ~3635 and the agent status handler ~5788), `src-tauri/src/pet.rs` (+ register command in `main.rs`), `src/pages/PetPage.tsx`, `src/pages/PetPage.css`, i18n `ko`/`en` (others English).

**Interfaces:**
- Event `pet-summary` (main → all, payload `PetSummary`), emitted from App.tsx via `emit` when `buildPetSummary(...)` changes, plus a `doneEvent` the moment a tab's turn goes done (once per turn). Main also re-emits on `pet-visibility {visible:true}`.
- Command `pet_open_terminal(terminal_id: Option<String>)` (async): show + unminimize + focus main, hide pet, then emit `pet-focus-terminal { terminalId }` when Some. App.tsx listens and switches project + tab to it (reuse the existing tab-activation path used by toast clicks; find it). Double-click on the pet calls it with the first blocked tab, else the most recent unseen-done tab, else `None`.
- PetPage: listens to `pet-summary`, keeps `lastDoneAtMs` from `doneEvent`, passes `moodFor(...)` to `step`. Draws: bubble above the pet for blocked (text per Global Constraints, "+N" when more) or for 10 s after a done ("완료 · <tab>"); a small count badge for `unseenDone > 0`. Clicking the bubble calls `pet_open_terminal` with that tab. Window grows upward to fit the bubble without moving the body on screen.

- [ ] Implement; `npx tsc -p tsconfig.app.json --noEmit`, `npx vitest run src/pet src/config`, `cargo check --locked`, `cargo test --locked pet::`, `npm run build` all pass (paste output). Commit.

### Task 4: Dev-app check with the owner
- [ ] Start a Claude tab in the dev app, minimize: busy while it works, happy + bubble when done, wave + bubble when it asks for permission; click bubble → that tab opens.
