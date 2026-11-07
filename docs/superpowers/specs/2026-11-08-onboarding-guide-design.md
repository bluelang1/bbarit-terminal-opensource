# Getting-started guide and What's new — design

Date: 2026-11-08. Status: draft for owner approval.

## Intent

BBARIT has grown many features (PTY holder, agent status, agent relay, Git
panel, desktop pet, Cmd+Enter, 14 AI terminal kinds, 15 settings tabs) and keeps
adding more. A new user gets only the "새 프로젝트" modal on first launch and
no explanation; even the owner forgot a setting existed. We want:

1. A **getting-started guide** for people who just downloaded the app: a
   pleasant, easy-to-read window that teaches the core flow by doing.
2. A **What's new** window that opens once on the first launch after an
   update and lists what changed, taken from CHANGELOG.md.

Pretty and easy to read matters. Moving pictures (short demo clips) are wanted.

## Goals

- First launch of a fresh install opens the guide next to the new-project modal.
- The guide is a checklist; each step has a demo area, 2–3 lines of text,
  a **직접 해보기** button that points at the real control in the main window,
  and **다음**. Steps tick themselves when the user actually does the thing.
- First launch after an update opens What's new with the CHANGELOG sections
  between the last seen version and the current one.
- Help menu: 시작하기 / 새로운 기능 / 캐릭터 둘러보기. Non-macOS builds (no
  native menu) reach the same through the app's 메뉴 dropdown and command palette.
- Guide text in ko and en (other locales fall back to en via `t()`).
- Adding a step later is a small, local change (one entry in a step list + i18n keys + optional clip).

## Non-goals

- A full reference manual or searchable docs site (later, if wanted).
- Translating CHANGELOG.md; What's new shows it as written (Korean).
- Explaining every toolbar button or all 14 terminal kinds.
- Remote/fetched content; everything ships in the app.

## Anti-goals

- Nagging: the guide opens automatically once, What's new once per update; never
  on every start, never while the user is mid-task in a modal of ours they did not ask for.
- Pointing at the wrong place: if a target control is hidden or absent, say so
  instead of highlighting something else.
- Blocking work: the guide is a separate window; the main window stays usable.

## Approaches (decided: B)

- A. Spotlight-only tour over the real UI (Figma/Linear coach marks). Exact
  locations, but brittle when layout changes and little room for explanation.
- **B. Separate guide window with checklist + "직접 해보기" spotlight (VS Code
  walkthroughs + Warp checklist + Figma highlight).** Room to explain and show
  clips, learn-by-doing, auto-ticking steps, and the same window doubles as
  What's new. Chosen by the owner.
- C. Welcome slideshow. Cheapest, but forgotten after one pass and not reusable.

## Design

### Window

- Label `tool-guide` (already allowed by `capabilities/default.json` `tool-*`),
  URL `/guide?mode=start|whatsnew[&step=<id>]`, routed in `main.tsx` RootRouter
  like `/chat`. About 900×620, resizable, normal decorations, reused
  (focus + navigate) if already open.
- Placement (my call): beside the main window when the screen has room (right
  side, else left), otherwise centred over the main window's right half so the
  new-project modal in the middle stays visible. The guide is always-on-top
  only while a spotlight is showing, and is brought back to the front when the
  spotlight closes, so 다음 and the checklist are never lost behind the main window.
- Opened only by the main window (`openToolWindow`-style helper) so there is one
  place that decides when it appears.
- Layout (`start` mode):

  ```
  ┌ BBARIT 시작하기 ────────────────────────────────────────┐
  │ 진행 3/6 ▓▓▓░░░        │                                  │
  │ ✅ 1 프로젝트 열기       │   [ demo clip / illustration ]   │
  │ ▶ 2 AI 터미널 열기       │                                  │
  │ ○ 3 상태 표시와 알림     │   Title                          │
  │ ○ 4 앱을 닫아도 계속 실행 │   2–3 lines of text              │
  │ ○ 5 Git·검색·단축키      │                                  │
  │ ○ 6 데스크톱 펫          │   [직접 해보기]        [다음 →]   │
  │ ─────────────────────── │                                  │
  │ 새로운 기능 보기          │                                  │
  └─────────────────────────────────────────────────────────┘
  ```

  Follows the app theme tokens (dark/light), rounded cards, generous spacing,
  system font; the selected step is highlighted; done steps show a check.
  The final step offers "완료" which closes the window.

### Steps (initial set)

| id | Title (ko) | Teaches | Spotlight target | Auto-done when |
|---|---|---|---|---|
| `project` | 프로젝트 열기 | + button, folder = project, theme colour | `[data-guide="project-open"]` (the 프로젝트 열기 + button); while the new-project modal is open, the modal's folder field `[data-guide="new-project-folder"]` instead | a project exists |
| `ai-terminal` | AI 터미널 열기 | AI 터미널 추가 menu, Claude vs Claude 새 대화 | `[data-guide="ai-terminal"]` (the `.terminal-create-trigger` button) | an agent tab (cliType ≠ shell) was added |
| `status` | 상태 표시와 알림 | tab status dots (working/blocked/done), approval alerts | the active terminal tab | an agent tab reported a status (OSC 7501) |
| `keep-running` | 앱을 닫아도 계속 실행 | PTY holder, update keeps work, 설정 → 터미널 switches, "종료하고 모든 터미널 끝내기" | none (action opens 설정 on the 터미널 tab, scrolled to the PTY holder switch) | the action ran |
| `git-keys` | Git·검색·단축키 | Git popup + repo page button, quick search, Enter/Shift+Enter/Cmd+Enter and Claude keybindings | `[data-guide="git"]` (toolbar Git button) | Git panel opened |
| `pet` | 데스크톱 펫 | minimize/close shows the pet, double-click restores, Help → 캐릭터 둘러보기 (macOS) | none (button starts the pet tour via a new `pet_start_tour` Tauri command wrapping `pet::start_pet_tour`) | pet tour run or pet shown once |

Targets use dedicated `data-guide="…"` attributes added to the real controls,
never shared classes (`.project-tab-add` is on six different buttons).
The pet step is shown on macOS only (the pet is macOS-only).

Steps live in one list (`src/guide/steps.ts`): `{ id, titleKey, bodyKey,
target?: { selector, captionKey }, action?: 'pet-tour' | 'open-settings-terminal',
media?: string, doneEvent }`. Text in `src/i18n/{en,ko}.ts` under `guide.*`.

### 직접 해보기 (spotlight)

- Guide window emits `guide-spotlight { stepId }` to `main`; main window
  focuses itself, resolves the step's selector and draws a full-window overlay:
  dimmed backdrop with a cut-out around the element, a pulsing ring, and a
  caption bubble placed beside it. Click anywhere / Esc / 6 s timeout dismisses;
  clicking inside the cut-out passes through to the real control.
- If the selector is missing or zero-sized (toolbar button hidden by the user,
  layout without that control), show the caption centred with a line saying
  where to find it (e.g. 메뉴 → …) instead of highlighting anything.
- Steps with `action` instead of a target run it (start the pet tour; open
  settings on the 터미널 tab — SettingsPanel gains an `initialTab` prop, since
  'terminal' is already its default tab and opening it is not a signal).

### Progress

- A step counts as done when its event fires **or** the user presses 다음 on it
  (so the `status` step, which needs Claude Code ≥ 2.1.295 for OSC 7501, does not
  block Codex/Gemini users). "3/6" counts both. 완료 is always available and
  does not require every step.
- Main window owns progress: `kv` key `bbarit-guide-progress` = `{ [stepId]: doneAtMs }`.
- Main marks steps at the existing points where those things happen (project
  created/restored, agent tab added, first agent status, settings opened on 터미널,
  Git panel opened, pet shown/tour run) and emits `guide-progress` to the guide
  window. Existing users (who open the guide from Help) see steps they already
  satisfy ticked on open (computed from current state where possible:
  projects > 0, any agent tab).
- "처음부터 다시" link resets progress.

### First-run trigger

- In `applyRestoredProjects`, when 0 projects were restored and kv
  `bbarit-guide-firstrun` is unset: set it, write `bbarit-last-seen-version` =
  current version (so What's new does not also open), and open the guide in
  `start` mode after the new-project modal is up. Step 1 then points at the
  modal's folder field, not the + button the modal's overlay covers.
- Users with projects never get the guide automatically.
- Dev builds (`debugBuild`) skip all automatic opening; menu still works.

### What's new

- Content: `import CHANGELOG from '../../CHANGELOG.md?raw'` (pattern already
  used for docs/BBARIT_CLI.md), parsed by a pure function into
  `[{ version, date, groups: [{ kind: '추가'|'변경'|'제거'|'수정'|'보안', items: string[] }] }]`;
  `[Unreleased]` and link-reference lines ignored; inline `code` and **bold** rendered.
- Trigger: on main-window start (release build), compare `getVersion()` with kv
  `bbarit-last-seen-version`.
  - unset and projects > 0 → existing user upgrading into this feature: show
    the current version only.
  - stored < current → show every section with stored < version ≤ current,
    newest first.
  - equal / newer / no matching sections → nothing.
  - Always write current afterwards (also when nothing was shown).
  - Open after startup settles (after project restore), not over the update
    "busy" dialogs.
- Window (`whatsnew` mode): header "1.1.67에서 새로 생긴 것", cards grouped by
  kind with an icon/colour per kind (추가 green, 변경 blue, 수정 amber, 제거 grey,
  보안 red), a link "전체 변경 이력" (GitHub releases page) and a link to the
  getting-started guide. Older sections collapsible.

### Help menu and other entry points

- macOS Help menu: `guide-open` (시작하기 / Getting Started), `whatsnew-open`
  (새로운 기능 / What's New), existing `pet-tour`. The two new items `app.emit`
  to the main window (pattern: `menu-select-all`), which opens the window.
- App 메뉴 dropdown and command palette get the same two entries (all platforms).

### Demo media

- Phase 1 ships each step with a lightweight illustration (CSS/SVG mock of the
  relevant UI piece, animated with CSS where it helps) so the guide is complete
  without recordings.
- Phase 2 is a separate later plan (needs screen-recording permission and
  ffmpeg on the owner's Mac, and an `.mp4` allowance in `opensource/manifest.json`).
  It adds real clips: `scripts/guide-capture.mjs` drives the dev app
  through `npm run ctl` against an isolated test project and records the window
  region, converting to short muted looping H.264 MP4 (`<video autoplay loop
  muted playsinline>`, ≤ ~600 KB each, ≤ 8 s) under `public/guide/`. A step
  uses its clip when present, else the illustration. Re-running the script
  refreshes clips after UI changes. Clips must not contain personal data
  (isolated HOME/test project only); they are product assets, unlike local
  verification captures, and must be included in `opensource/manifest.json`.

### Maintenance rule

CLAUDE.md gains: a PR that adds a user-facing feature worth teaching adds or
updates a guide step (and its clip when phase 2 exists), alongside the
CHANGELOG line.

## Constraints

- Keep index.html free of inline style/script (CSP nonce); styles in a CSS file.
- Never write into user PTYs; the guide only highlights and opens UI.
- New window must not trigger the product-notice gate or pet feed logic
  (`isPetFeedWindow` guards, `ProductNoticeGate` main-window check).
- i18n via `t()` keys, not inline `locale === 'ko'` ternaries.
- Tests: pure parts unit-tested (CHANGELOG parser, version compare / which
  sections to show, first-run decision, progress merge, step list integrity:
  every step has ko+en keys).

## Left to the builder

- Exact component split, CSS, animation details, icons (lucide-react is in use).
- Exact hook points for auto-done events inside App.tsx.
- Window size tuning and caption placement math.
