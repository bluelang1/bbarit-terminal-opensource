# Getting-started guide and What's new Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/guide` window with a 6-step getting-started checklist (spotlight "직접 해보기", auto-ticking) opened once on a fresh install, plus a What's new mode opened once after an update from CHANGELOG.md.

**Architecture:** Pure logic (CHANGELOG parsing, version compare, open decisions, progress) in `src/guide/*.ts` with unit tests. A new routed page `src/pages/GuidePage.tsx` renders both modes. The main window (App.tsx) owns opening, progress and the spotlight overlay; the two windows talk with Tauri events. Rust adds two Help menu items and a `pet_start_tour` command.

**Tech Stack:** React 18 + TypeScript, Tauri v2 (`@tauri-apps/api/webviewWindow`, `event`), vitest, lucide-react icons, existing `kvGet/kvSet` (src/hooks/useKV.ts), `t()` i18n.

**Spec:** docs/superpowers/specs/2026-11-08-onboarding-guide-design.md

## Global Constraints

- Window label `tool-guide`, URL `/guide?mode=start|whatsnew[&step=<id>]`.
- kv keys: `bbarit-guide-progress` (JSON `{[stepId]: ms}`), `bbarit-guide-firstrun` (`'1'`), `bbarit-last-seen-version` (semver string).
- Events: `guide-spotlight {stepId}` (guide→main), `guide-action {stepId}` (guide→main), `guide-next {stepId}` (guide→main, marks done), `guide-reset` (guide→main), `guide-progress {progress}` (main→guide), `menu-guide-open` / `menu-whatsnew-open` (Rust→main).
- Targets only via `data-guide="project-open" | "new-project-folder" | "ai-terminal" | "git"`; never shared classes.
- No automatic opening in debug builds (`hostDebugBuild(getPtyRecovery(), import.meta.env.DEV)`); menu entries always work.
- Text through `t('guide.…')` keys in src/i18n/en.ts and ko.ts; no inline `locale === 'ko'` ternaries in new code.
- No inline `<style>`/`<script>` in index.html; styles in `src/pages/GuidePage.css` and `src/guide/Spotlight.css`.
- Never write into PTYs. Pet step only on macOS (`navigator.userAgent` contains `Mac`).
- Every user-visible PR adds a Korean CHANGELOG `[Unreleased]` line.

## Review Focus

1. CHANGELOG with an empty `[Unreleased]`, link-reference lines at the bottom, and versions with no section → What's new shows nothing and does not open an empty window (Task 1 test `sectionsToShow skips empty and missing`).
2. Skipped several versions (1.1.64 → 1.1.67) → all three sections, newest first (Task 1 test).
3. Fresh install: guide opens after the new-project modal, step 1 points at the modal folder field, and What's new does NOT also open (Task 1 test `decideStartup fresh install`).
4. Existing user with projects and no last-seen key → What's new for current version only, guide never auto-opens (Task 1 test).
5. Spotlight target hidden (toolbar Git hidden) → centered caption with where-to-find text, no wrong highlight (Task 3 test `resolveTarget missing`).

---

### Task 1: Pure guide logic

**Files:**
- Create: `src/guide/changelog.ts`, `src/guide/changelog.test.ts`
- Create: `src/guide/decide.ts`, `src/guide/decide.test.ts`
- Create: `src/guide/steps.ts`, `src/guide/steps.test.ts`
- Modify: `src/i18n/en.ts`, `src/i18n/ko.ts` (append `guide.*` keys)

**Interfaces:**
- Produces:
  - `type ChangeKind = '추가'|'변경'|'제거'|'수정'|'보안'`
  - `interface ChangelogSection { version: string; date: string; groups: { kind: ChangeKind; items: string[] }[] }`
  - `parseChangelog(md: string): ChangelogSection[]` (file order; skips `[Unreleased]`, link refs `[x]: url`)
  - `compareVersions(a: string, b: string): number` (numeric x.y.z)
  - `sectionsToShow(all: ChangelogSection[], lastSeen: string | null, current: string): ChangelogSection[]` (lastSeen null → only current; lastSeen < v ≤ current; newest first; drops sections with no items)
  - `decideStartup(i: { debugBuild: boolean; projectCount: number; firstRunDone: boolean; lastSeen: string | null; current: string; whatsNewCount: number }): { openGuide: boolean; openWhatsNew: boolean; writeFirstRun: boolean; writeLastSeen: string }`
    - debug → nothing opens and nothing is written: `writeLastSeen: ''` (caller skips an empty value).
    - projectCount 0 && !firstRunDone → openGuide, writeFirstRun, writeLastSeen=current, no What's new.
    - else openWhatsNew = whatsNewCount > 0 (count computed by caller via sectionsToShow); writeLastSeen=current.
  - `type GuideStepId = 'project'|'ai-terminal'|'status'|'keep-running'|'git-keys'|'pet'`
  - `interface GuideStep { id: GuideStepId; titleKey: string; bodyKey: string; target?: { selector: string; altSelector?: string; captionKey: string; missingKey: string }; action?: 'pet-tour'|'open-settings-terminal'; macOnly?: boolean }`
  - `GUIDE_STEPS: GuideStep[]` in the order of the spec table; `visibleSteps(isMac: boolean): GuideStep[]`
  - `type GuideProgress = Partial<Record<GuideStepId, number>>`; `markDone(p, id, now): GuideProgress` (keeps the first time); `doneCount(p, steps): number`

- [ ] **Step 1: Write failing tests**

```ts
// changelog.test.ts
const MD = `# 변경 이력\n\n## [Unreleased]\n\n## [1.1.67] - 2026-11-09\n\n### 추가\n\n- A **굵게** \`code\`\n\n### 수정\n\n- B\n\n## [1.1.66] - 2026-11-07\n\n### 수정\n\n- C\n\n## [1.1.65] - 2026-11-07\n\n## [1.1.64] - 2026-11-06\n\n### 변경\n\n- D\n\n[Unreleased]: https://x\n[1.1.67]: https://y\n`;
it('parses sections and groups', () => {
  const s = parseChangelog(MD);
  expect(s.map(x => x.version)).toEqual(['1.1.67','1.1.66','1.1.65','1.1.64']);
  expect(s[0].groups).toEqual([{ kind: '추가', items: ['A **굵게** `code`'] }, { kind: '수정', items: ['B'] }]);
});
it('compareVersions is numeric', () => { expect(compareVersions('1.1.10','1.1.9')).toBeGreaterThan(0); expect(compareVersions('1.1.6','1.1.6')).toBe(0); });
it('sectionsToShow skips empty and missing', () => {
  expect(sectionsToShow(parseChangelog(MD), '1.1.63', '1.1.67').map(s => s.version)).toEqual(['1.1.67','1.1.66','1.1.64']);
});
it('null lastSeen shows current only', () => { expect(sectionsToShow(parseChangelog(MD), null, '1.1.66').map(s => s.version)).toEqual(['1.1.66']); });
it('same or newer lastSeen shows nothing', () => { expect(sectionsToShow(parseChangelog(MD), '1.1.67', '1.1.67')).toEqual([]); });
it('parses the real CHANGELOG.md', () => { /* import ../../CHANGELOG.md?raw; expect >= 10 sections, every version matches /^\d+\.\d+\.\d+$/ */ });

// decide.test.ts
it('decideStartup fresh install', () => expect(decideStartup({ debugBuild:false, projectCount:0, firstRunDone:false, lastSeen:null, current:'1.1.67', whatsNewCount:1 }))
  .toEqual({ openGuide:true, openWhatsNew:false, writeFirstRun:true, writeLastSeen:'1.1.67' }));
it('existing user upgrading into the feature', () => expect(decideStartup({ debugBuild:false, projectCount:3, firstRunDone:false, lastSeen:null, current:'1.1.67', whatsNewCount:1 }))
  .toEqual({ openGuide:false, openWhatsNew:true, writeFirstRun:false, writeLastSeen:'1.1.67' }));
it('no new sections → nothing opens but lastSeen advances', ...whatsNewCount:0 → openWhatsNew false, writeLastSeen current);
it('0 projects but first run already done → no guide', ...);
it('debug build never opens or writes', ...→ { openGuide:false, openWhatsNew:false, writeFirstRun:false, writeLastSeen:'' });

// steps.test.ts
it('six steps in spec order', () => expect(GUIDE_STEPS.map(s=>s.id)).toEqual(['project','ai-terminal','status','keep-running','git-keys','pet']));
it('pet hidden off macOS', () => expect(visibleSteps(false).map(s=>s.id)).not.toContain('pet'));
it('every key exists in en and ko', () => { for each step key and target caption/missing key: expect(en[k]).toBeTruthy(); expect(ko[k]).toBeTruthy(); });
it('targets use data-guide selectors only', () => every selector/altSelector matches /^\[data-guide="[a-z-]+"\]$/);
it('markDone keeps first time; doneCount counts visible steps', ...);
```

- [ ] **Step 2:** `npx vitest run src/guide` → FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules. i18n keys (en + ko), copy written by the implementer, short and friendly; per step: `guide.step.<id>.title`, `.body` (2–3 sentences), `.caption`, `.missing` (where to find it when hidden, e.g. "메뉴 → Git"), plus window chrome: `guide.title` (BBARIT 시작하기 / Getting started), `guide.progress` ({done}/{total}), `guide.tryIt` (직접 해보기), `guide.next` (다음), `guide.finish` (완료), `guide.reset` (처음부터 다시), `guide.whatsnew.title` ({version}에서 새로 생긴 것), `guide.whatsnew.older` (이전 버전), `guide.whatsnew.allReleases` (전체 변경 이력), `guide.whatsnew.openGuide` (시작하기 가이드 보기), `guide.whatsnew.empty`, `guide.menu.start` (시작하기), `guide.menu.whatsnew` (새로운 기능). Step targets: project → `[data-guide="project-open"]` with altSelector `[data-guide="new-project-folder"]` (alt preferred when present); ai-terminal → `[data-guide="ai-terminal"]`; git-keys → `[data-guide="git"]`; status → target `[data-guide="ai-terminal"]`'s tab strip is not stable, so status has no target and its 직접 해보기 is hidden; keep-running → action `open-settings-terminal`; pet → action `pet-tour`, macOnly.
- [ ] **Step 4:** `npx vitest run src/guide` → PASS.
- [ ] **Step 5:** Commit `Guide: CHANGELOG parser, startup decision, step list`.

### Task 2: Guide window page

**Files:**
- Create: `src/pages/GuidePage.tsx`, `src/pages/GuidePage.css`, `src/guide/illustrations.tsx`
- Modify: `src/main.tsx` (route `/guide` → `GuidePage`, lazy like `ChatPage`)

**Interfaces:**
- Consumes: Task 1 exports; events from Global Constraints.
- Produces: page reading `mode` and `step` from `location.search`; emits `guide-spotlight`/`guide-action`/`guide-next`/`guide-reset` to label `main` (`emitTo('main', …)`); listens `guide-progress`; on mount reads `bbarit-guide-progress` via kvGetJSON for an initial render.

- [ ] **Step 1:** Implement `start` mode per the spec layout: left column progress bar + step list (check / current / empty markers) + "새로운 기능 보기" link (switches to whatsnew in place); right column illustration (from `illustrations.tsx`, one small CSS/SVG mock per step id, e.g. a mini tab bar with the + glowing, a terminal tab with a pulsing status dot, a laptop lid closing while the terminal keeps scrolling, the Git popup with the external-link button, the pixel pet walking), title, body, buttons 직접 해보기 (hidden when the step has neither target nor action), 다음 (emits `guide-next` then selects the next visible step), 완료 on the last step (closes the window via `getCurrentWebviewWindow().close()`), "처음부터 다시" small link.
- [ ] **Step 2:** Implement `whatsnew` mode: `sectionsToShow(parseChangelog(CHANGELOG), lastSeen param from query `from`, current from getVersion())`; header with newest version; cards grouped by kind with lucide icon + colour (추가 green Sparkles, 변경 blue RefreshCw, 수정 amber Wrench, 제거 grey Minus, 보안 red Shield); older sections in a collapsed `<details>`; render `**bold**` and `` `code` `` only (no HTML injection: build React nodes, never innerHTML); footer links: 전체 변경 이력 (opens `https://github.com/bluelang1/bbarit-terminal-opensource/releases` via `openExternalUrl` or opener plugin used elsewhere) and 시작하기 가이드 보기. Empty → `guide.whatsnew.empty`.
- [ ] **Step 3:** Styles: theme tokens from the existing app CSS variables (check what App.css exposes; fall back to a `prefers-color-scheme` pair), rounded 12px cards, 15px body text, comfortable 1.6 line height, subtle step-change fade.
- [ ] **Step 4:** `npm run build` passes; `npx vitest run src/guide` still passes.
- [ ] **Step 5:** Commit `Guide: guide window (start + what's new modes)`.

### Task 3: Main window integration and spotlight

**Files:**
- Create: `src/guide/Spotlight.tsx`, `src/guide/Spotlight.css`, `src/guide/spotlightTarget.ts`, `src/guide/spotlightTarget.test.ts`, `src/guide/openGuide.ts`
- Modify: `src/App.tsx` (data-guide attributes, listeners, progress marks, startup decision, menu dropdown + command palette entries), `src/components/SettingsPanel.tsx` (`initialTab?` prop applied when `isOpen` turns true)

**Interfaces:**
- Consumes: Task 1/2.
- Produces:
  - `resolveTarget(step: GuideStep, doc: Document): { rect: DOMRect; el: Element } | null` (altSelector first, then selector; null when missing or zero-size)
  - `openGuideWindow(opts: { mode: 'start'|'whatsnew'; step?: GuideStepId; from?: string | null }): Promise<void>` — reuse by label `tool-guide` (focus + emit `guide-navigate` with opts) else create `WebviewWindow('tool-guide', { url: '/guide?…', title, width: 900, height: 620 })` placed beside the main window when the monitor has room (right, else left), else over the main window's right half.

- [ ] **Step 1: Failing test** `spotlightTarget.test.ts` (jsdom): returns alt when both exist; returns primary when alt absent; `resolveTarget missing` → null when neither exists; null when element has zero size (stub getBoundingClientRect).
- [ ] **Step 2:** Run → FAIL. Implement `spotlightTarget.ts` → PASS.
- [ ] **Step 3:** `Spotlight.tsx`: full-window fixed overlay, dimmed backdrop with a cut-out (box-shadow trick) around the rect + 8px padding, pulsing ring, caption bubble beside it (flip to stay on screen); `pointer-events: none` over the cut-out so the real control is clickable; dismiss on click elsewhere / Esc / 6 s; when target is null show a centred card with `caption` + `missing` text. On show: `getCurrentWindow().setFocus()`; set the guide window always-on-top true; on dismiss set it false and `setFocus()` the guide window.
- [ ] **Step 4:** App.tsx wiring:
  - add `data-guide` attributes: `project-open` on the 프로젝트 열기 + button (~17168 only), `ai-terminal` on `.terminal-create-trigger` (~20996), `git` on the toolbar Git button (~17561), `new-project-folder` on the new-project modal's folder input/picker.
  - listeners (main window only): `guide-spotlight` → show Spotlight for that step; `guide-action` → `pet-tour` invokes `pet_start_tour`, `open-settings-terminal` opens settings with `initialTab='terminal'` and marks `keep-running`; `guide-next` → markDone; `guide-reset` → clear progress; after every change kvSet JSON + `emitTo('tool-guide','guide-progress',{progress})`.
  - auto-done marks: project created or restored with ≥1 project → `project`; agent tab added (cliType ≠ 'shell') → `ai-terminal`; first OSC 7501 status event for any tab → `status`; Git panel opened → `git-keys`; pet tour run or pet shown → `pet` (listen to the existing pet visibility path or mark on `pet_start_tour`).
  - startup: after `applyRestoredProjects` settles, compute `decideStartup` (kv reads, `getVersion()`, `sectionsToShow(...).length`), apply writes, then open guide (`mode:'start', step:'project'`) or What's new (`mode:'whatsnew', from:lastSeen`). Fresh install: open after the new-project modal is visible.
  - listen `menu-guide-open` / `menu-whatsnew-open` → `openGuideWindow`.
  - App 메뉴 dropdown: add 시작하기 and 새로운 기능 entries; command palette: `guide.open`, `guide.whatsnew`.
- [ ] **Step 5:** `npx vitest run src/guide`, `npm run test:run` (summary only), `npm run build` pass.
- [ ] **Step 6:** Commit `Guide: spotlight, progress and startup opening in the main window`.

### Task 4: Native menu, pet command, docs

**Files:**
- Modify: `src-tauri/src/main.rs` (Help menu ~10187-10208, invoke handler list ~10592), `src-tauri/src/pet.rs` (command), `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1:** pet.rs: `#[tauri::command] pub fn pet_start_tour(app: AppHandle) { start_pet_tour(&app) }`; register next to `pet::pet_tour_end`. Non-macOS: the command exists and is a no-op if the pet is unavailable (follow how pet.rs gates macOS today).
- [ ] **Step 2:** Help menu: items `guide-open` (시작하기 / Getting Started) and `whatsnew-open` (새로운 기능 / What's New) above `pet-tour`, a separator between; menu events `app.emit("menu-guide-open", ())` / `app.emit("menu-whatsnew-open", ())`.
- [ ] **Step 3:** `cargo test --manifest-path src-tauri/Cargo.toml --locked` passes (summary line).
- [ ] **Step 4:** CLAUDE.md bullet: "Getting-started guide: steps live in src/guide/steps.ts (ko/en `guide.step.*` keys, `data-guide` targets). A PR adding a user-facing feature worth teaching adds or updates a step; What's new reads CHANGELOG.md at build time." CHANGELOG `[Unreleased]` → `### 추가`: "처음 설치하면 시작하기 가이드 창이 열려 프로젝트 열기·AI 터미널·상태 표시·계속 실행·Git·데스크톱 펫을 직접 해 보며 익힐 수 있습니다. 업데이트 후 처음 켤 때는 새로 생긴 기능을 보여 주고, 도움말 메뉴에서 언제든 다시 열 수 있습니다."
- [ ] **Step 5:** `python3 -B scripts/export-opensource.py --audit` passes; commit `Guide: Help menu entries, pet tour command, docs`.

### Task 5: Dev app check (owner)

- [ ] Launch the dev app with a backed-up `~/.config/octo/config.json`; open 도움말 → 시작하기 and 새로운 기능; try each 직접 해보기; to see the fresh-install path, the kv keys can be cleared through ctl in the dev app. Owner confirms look and flow before merge.
