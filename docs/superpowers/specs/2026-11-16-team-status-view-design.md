# Team status view: design brief

Scope: "Team status" tab of the toolbar gauge overlay (beside the Dashboard iframe tab), also
a pop-out always-on-top window. Data: board v2 spec (only in worktrees, e.g.
`.claude/worktrees/agent-board-pg/docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md`),
`docs/AGENT_RELAY.md`, `2026-11-16-agent-limits-and-log-design.md`.

## 0. Decisions (maintainer + main session, 2026-11-17)

요약: 상단 대시보드(계기판) 버튼 하나로 열고, 그 안에서 [팀 현황 | 대시보드] 탭으로 나눈다.
"창으로 떼기"로 독립 창이 되고 항상 위 고정을 켤 수 있다. 팀 전체 중지 버튼 옆 버튼과 프로젝트
탭의 숫자 배지로도 열린다. 아이디어 10개를 모두 넣되, 맥별 보기는 동기화(3b) 전까지 자리만 둔다.

- Entry points: the existing toolbar gauge button opens one overlay with tabs
  `[Team status | Dashboard]` (last tab remembered); a small button next to the stop-team
  button and the project-tab badge open the Team status tab for that team. No new toolbar button.
- Pop-out: "open in its own window" for either tab; pin (always on top) in the pop-out header.
- All ten ideas ship; "Machines" is a placeholder card until sync (stage 3b).
- Open choices in section 13, settled: (1) no OS notification in this stage; (2) the view shows
  one team, the badge sums the active project's teams; (3) the pop-out follows the theme of the
  project that owns the team; (4) stale uses `agents.board.staleMinutes`; (5) five grouped board
  columns; (6) review is pink; (7) the app's mono font everywhere; (8) refusals come from a new
  read-only host command over `agent-relay.log` (last entries only, never the text head of
  messages); (9) no mermaid.
- The look follows the app's flat, hard-edged skin first; the maintainer reviews it in the dev
  app and may ask for a softer look afterwards, so keep radius/shadow/spacing in `--ts-*` tokens.
- Stages: 4a = data model (pure functions + tests), overlay shell with the two tabs, summary
  strip, Needs you, agents, task board/list, task drawer with human actions, activity feed,
  limits, badges, the stop-team-side button. 4b = dependency graph/tree, timeline (burn-up,
  time in state), pop-out window + pin, machines placeholder, getting-started guide step.

## 1. What exists today (fit constraints)
| Topic | Finding | Where |
|---|---|---|
| Theme input | Per-project 3-color theme `{bg,text,accent}`; 50 dark, 121 light, 136 "wacky", plus imported Warp themes | `src/theme.ts:78-129`, `:132-256`, `:259-417`, `:425-453` |
| Theme vars | `--bg-color/--text-color/--accent-color/--font-family` set inline on `.terminal-app` | `src/App.tsx:16926` |
| Dark/light switch | `.light-theme` class when YIQ of bg > 128 (`isLightBg`) | `src/App.tsx:1241-1247`, `:16926` |
| Base tokens | `--bg-color`, `--text-color`, `--accent-color`, `--focus-ring` | `src/App.css:18-23` |
| UI tokens | `--ui-control-h` 36/32/28, `--ui-radius:0`, `--ui-border`, `--ui-panel-bg`, `--ui-panel-bg-raised`, `--ui-muted` (text 68%), `--ui-danger`, `--ui-success`, `--ui-shadow` | `src/index.css:32-50` |
| Brutalist skin | `--brutal-line`, `--brutal-line-soft`, `--brutal-radius: 2px`, `--brutal-shadow: 4px 4px 0`, `--brutal-shadow-small` | `src/App.css:9571-9578` |
| Chrome sizes | `--chrome-btn 28px`, `--chrome-radius = brutal radius` | `src/App.css:11169-11174` |
| Modal shell | `.panel-modal-overlay/-container/-header/-title`, 2px border + hard shadow forced | `src/App.css:9470-9550`, `:9615-9625` |
| Buttons | radius 0 forced globally; hover = translate(-1,-1) + 4px hard shadow + accent border | `src/index.css:52-58`, `src/App.css:9659-9705` |
| Motion | "Fast mode": overlays and tabs have 0 ms animation/transition; reduced-motion block exists | `src/App.css:7904`, `:9850-9905` |
| Existing status hues | working/running `#22c55e`, blocked `#f59e0b` (never animates), done `#22c55e`, stopped `#ef4444` | `src/App.css:9354-9361`, `:12320-12360` |
| Font | The whole UI uses the project's monospace font (`var(--font-family)`); tooltips use system sans | `src/App.css:224`, `:184` |
| Icons | `lucide-react ^0.562.0` | `package.json:117` |
| Charts | **No chart library.** Only `mermaid ^12.2.0` (used in editors). Hand-rolled SVG already in `TodoGanttPanel.tsx`, `AgentHarnessPanel.tsx`, `guide/illustrations.tsx` | `package.json:120`, `src/components/` |
| Current overlay | `DashboardPanel` uses inline styles: radius 12, soft 24/80 shadow, 1px borders. This does not match the brutalist skin | `src/dashboard/DashboardPanel.tsx:63-75` |
| Tool windows | `openToolWindow` creates a `WebviewWindow` with label `tool-<name>` and a route path. `windowPin.ts` wraps `setAlwaysOnTop` | `src/App.tsx:3071-3140`, `src/window/windowPin.ts` |
| Agent tab state | 7501 rollup `'working' \| 'blocked' \| 'done' \| 'idle'` (+ exited) | `src/terminal/busyAgentTabs.ts:1,22` |

**Decision: hand-written inline SVG + CSS, no new dependency.** Every chart here is bars,
ticks, lines or boxes (40-150 lines of SVG each) colored from CSS variables, so both themes
come free. recharts-class libraries bring their own theming, animation and tooltips that
would fight the brutalist skin and Fast mode. Mermaid's DAG is async, off-theme, and its
nodes can't take focus or per-state color.

## 2. Information hierarchy
1. **Needs you** (approve/reject a review, retry a failure, answer a blocked agent, check a
   stale claim): always top-left, above the fold, the only place with alert styling.
2. **Is the team moving?** Summary strip (state bar, counts, done sparkline). 3. **Who is
   doing what** (agent rows). 4. **The work** (board/list/deps/timeline tabs). 5. **Context**
   (activity, limits, machines). Everything outside Needs you stays calm: status color on
   marks, chips and icons only; text stays in the text color.

## 3. Layout and wireframes

Breakpoints come from **container width** (`container-type: inline-size` on the view root),
not viewport width, because the same component runs in the overlay (96vw x 92vh, like today)
and in a popped-out window.

### Wide (container >= 1200px; the right rail only appears at >= 1600px)

```
+-[ Team status | Dashboard ]----------------------------------------------------------------------+
| Team [refactor-auth v] (root t1)  * this machine . local    filter: [state v][agent v][/ search]  |
|                                                         [pop out] [pin] [x]                       |
+---------------------------------------------------------------------------------------------------+
| AGENTS     WORKING   WAITING   REVIEW   FAILED   DONE                                             |
| 5 / 12     3         2         1        1        8  ._.-^-'^  (done per 10 min, last 2 h)         |
| [######## done ########|rv|blk|#### working ####|f|.... open ....|//// waiting ////]  8/17 done    |
+--------------------------------+------------------------------------------------------------------+
| NEEDS YOU  4                   | [Board] [List] [Dependencies] [Timeline]        [x] show cancelled |
| ! #12 Review: "Split token.."  | TO DO 3      | WORKING 4     | REVIEW 1     | DONE 8   | FAILED 1   |
|   by t2 reviewer . 4m          | +----------+ | +-----------+ | +----------+ | +------+ | +--------+ |
|   [Approve] [Reject] [Open]    | |#14 Add.. | | |#11 Migr.. | | |#12 Split | | |#3 .. | | |#9 Lint | |
| x #9 Failed (try 2/3) . 12m    | |hourglass | | |t3 . 2m    | | |t2 . 4m   | | |      | | |oo. 2/3 | |
|   "lint exit 1" [Retry][Open]  | |waits #11 | | |pause blkd | | +----------+ | +------+ | +--------+ |
| ? t4 asks: "which DB url?"     | +----------+ | +-----------+ |              |          |            |
|   [Go to tab]                  |              |               |              |          |            |
| clock #7 stale 42m, t5 [Go]    |                                                                   |
+--------------------------------+                                                                   |
| AGENTS  5                      |                                                                   |
| * t2 reviewer  working  #12    |                                                                   |
|   [##|#] 2 held  ._-^ 1m       |                                                                   |
| ! t4 builder   blocked  #11    |                                                                   |
| o t5 tester    idle     -      |                                                                   |
+--------------------------------+------------------------------------------------------------------+
| LIMITS  children [######..] 4/6 (t1)  depth [##] 2/2  total [#####.......] 5/12  refusals 1 (9m)  |
| ACTIVITY (latest 50)  14:02 t2 submitted #12 for review . 14:01 t3 note "found flaky test" ...    |
+---------------------------------------------------------------------------------------------------+
```

Left rail 340px fixed (Needs you, then Agents), main flexes. At 1200-1599 Limits and
Activity share a band under both columns; at >= 1600 they move to a 320px right rail
(Activity, Limits, Machines). **Above the fold at 1280x800** (overlay ~1230x736): header,
summary, Needs you (5 items then "+n more"), 3-4 agent rows, top two cards per column.

### Medium (container 760-1199px)

```
+-[ Team status | Dashboard ]---------------- [team v] [pop out][pin][x]+
| 5/12 agents . 3 working . 2 waiting . 1 review . 1 failed . 8 done     |
| [####### done ######|rv|bk|### working ###|f|... open ...|// wait //] |
+-----------------------------+------------------------------------------+
| NEEDS YOU 4                 | [Board][List][Deps][Timeline][Activity] |
| ...                         | Board: 3 columns (To do / Working /      |
| AGENTS 5 (compact rows)     |   Review+Done+Failed stacked as one      |
| LIMITS (3 meters)           |   "Finished" column with sub-headers)    |
+-----------------------------+------------------------------------------+
```

Left rail 300px; Activity becomes a main tab; tiles become one sentence line over the bar;
below 900px the Board shows 3 grouped columns.

### Narrow / popped out (container < 760px; designed for 380-480px always-on-top)

```
+ Team [refactor-auth v]     [pin][x] +
| [##### done ###|r|b|## wk ##|f|.op.] |
| 8/17 done . 3 working . 1 review     |
+--------------------------------------+
| NEEDS YOU 4                          |
| ! #12 review . t2 . 4m    [Approve]  |
| x #9 failed 2/3           [Retry]    |
| ? t4 asks...              [Go]       |
+--------------------------------------+
| [Agents][Tasks][Activity][Deps][Limits] |
| * t2 reviewer working #12 ._-^  1m   |
| ! t4 builder  blocked #11       3m   |
+--------------------------------------+
```

No Board below 760px (Tasks = grouped list), Dependencies = indented tree, one primary
action button per item (others under "..."), 28px rows (`--ui-control-h-compact`).

## 4. Charts: one per data question

| Question | Chart | Why / spec |
|---|---|---|
| Where is the work right now? | **One 100% stacked horizontal bar** ("state bar"), 10px tall (8px narrow), full width under the tiles, 2px surface gap between segments, legend row of counts beneath | A single part-to-whole with 6-7 parts. A donut is worse at 6+ parts and wastes space (UNHCR, Semrush). The bar lines up with the tiles and fits a 400px window. Segment order is fixed (see 5.2) and color follows the state, never the rank. |
| Are we converging? | **Burn-up line** in the Timeline tab: gray "total tasks" step line + done line (+ dotted "done+review") vs time since team start | Linear's cycle graph pattern: scope vs completed. Scope creep shows as the gray line rising. One y-axis (count). |
| How fast are things finishing? | **Sparkline** in the Done tile: done events per 10-min bucket, last 2 h (12 buckets), 64x18px, no axes, last value dotted | Tufte word-sized graphic. Only the Done tile gets one (one sparkline per strip, so it stays meaningful). |
| How busy is each agent? | Per agent row: **mini stacked bar** of tasks held (claimed/blocked/review, max width = 3 tasks) + **activity sparkline** (task events + posts by that tab per 5 min, last 60 min) | Small multiples with the same scale on every row, so rows compare by eye. |
| How long did things sit? | **Time-in-state strip** per task (Timeline tab + task detail): one horizontal lane per task, segments colored by state from `task_events`, the shared time axis at top, "now" rule | The Temporal timeline pattern. Lanes sort by start time; at most 30 lanes, then "show more". Median time in review/blocked is shown as text above it. |
| Retries? | **Attempt pips** on cards: filled dot per attempt used, hollow up to `max_attempts` (`oo.` = 2 of 3) + "try 2/3" text | Discrete small integers. A histogram would be noise. |
| Limits | **Segmented meters** (one cell per unit): children 6 cells per parent (the busiest parent shown, others in tooltip/list), depth 2-step ladder, total 12 cells. Cells are neutral ink; when the used count = max, the meter gets a lock icon + "full" label in the blocked hue | Small integer caps read better as countable cells than as a radial gauge (Few's bullet graph: gauges waste space and say little). |
| Recent refusals | A **tick strip** (last 60 min, one tick per refusal) + a list of the last 5 with the limit named | Each tick links to its log line. |
| What waits on what? | **Layered DAG in SVG** (see 4.1); falls back to an indented tree | |
| What happened? | **Activity feed** (text list, not a chart) | Notes and task events merged by time. |

**Skip as noise:** donut/pie, radial gauges, priority distribution, per-day velocity or
calendar heatmaps (teams live hours, not weeks), cost/token charts (no data), a sparkline on
every tile, a 3D effect or gradient anywhere, and animated counters.

### 4.1 Dependency graph

- **Graph mode** when the deps subgraph has <= 40 tasks and <= 8 layers and the container is
  >= 760px; otherwise **tree mode**. Done/cancelled tasks appear only as direct deps of a
  visible open task, dimmed.
- `layoutDag` (pure): longest-path layering (Kahn) -> dummy nodes for long edges -> 4
  barycenter sweeps keeping the fewest-crossings order -> x by layer (left to right), y by
  order -> cubic edges. The client caps walks at 64 steps ("graph too deep" -> tree).
- Nodes 168x40: 4px state bar on the left, `#seq`, title cut at 22 chars, owner, state icon.
  Edges 1.5px `--ts-ink-faint`; dashed into a waiting task; failed hue + x marker from a
  failed dependency. Hover/focus highlights the full upstream+downstream chain and dims the
  rest to 35% (dcotelo's Actions visualizer). Critical path (longest not-done chain) = 2px
  ink outline, toggle, off by default.
- Tree mode: indented `role="tree"` list rooted at tasks nothing depends on, children =
  "waits on" (`#14 waits on #11 (working, t3)`), "dependency cancelled" flag, collapsible.

## 5. Color

### 5.1 Surface

Status colors can't be checked against 300+ arbitrary backgrounds. So the view paints its own
**tinted neutral surface** that keeps the theme's hue while bounding its lightness:

```css
.team-status            { --ts-surface: color-mix(in srgb, var(--bg-color) 72%, #08080a);
                          --ts-raised:  color-mix(in srgb, var(--ts-surface) 94%, #fff); }
.light-theme .team-status { --ts-surface: color-mix(in srgb, var(--bg-color) 30%, #fff);
                          --ts-raised:  #fff; }
.team-status[data-surface="neutral"]                { --ts-surface:#141418; --ts-raised:#1d1d22; }
.light-theme .team-status[data-surface="neutral"]   { --ts-surface:#fafafa; --ts-raised:#fff; }
```

- `teamStatusSurface(style)` (pure) sets `data-surface="neutral"` for wacky and imported
  themes, or whenever any status ink misses its target on the tinted surface (worst wacky
  case measured: 1.99:1, "Chad Thunder"). `--text-color` on the tinted surface measured
  >= 4.61:1 (dark, "Outrun") and >= 5.25:1 (light, "Solarized Light") over all built-ins.
- **Muted text:** not `--ui-muted` (text 68%, 2.7:1 on the worst themes). Use `--ts-muted:
  color-mix(in srgb, var(--text-color) 82%, var(--ts-surface))` (~3.4:1 on the 2-3 worst
  themes), for supplementary text only (ages, timestamps); essential text uses `--text-color`.

### 5.2 Status tokens

Mark color (bars, dots, borders, icons; >= 3:1) and ink color (colored text such as "try
2/3"; >= 4.5:1). Chip labels stay `--text-color` with a colored icon + 3px colored left edge.
Minimums are WCAG contrast over **all** built-in themes of that polarity, on both
`--ts-surface` and `--ts-raised`, computed from `theme.ts`.

| State (icon, lucide) | dark mark | dark ink | light mark | light ink | min dark / light (mark, ink) |
|---|---|---|---|---|---|
| done (`CircleCheck`) | `#22c55e` | `#22c55e` | `#15803d` | `#15803d` | 5.41 / 4.65 |
| review (`Eye`) | `#f472b6` | `#f472b6` | `#db2777` | `#be185d` | 4.66 / 4.26, 5.60 |
| blocked (`CirclePause`) | `#f59e0b` | `#f59e0b` | `#c2700a` | `#a3480b` | 5.74 / 3.47, 5.58 |
| claimed = "working" (`LoaderCircle`, static) | `#60a5fa` | `#60a5fa` | `#2563eb` | `#1d4ed8` | 4.85 / 4.79, 6.21 |
| failed (`CircleX`) | `#ef4444` | `#fb8080` | `#dc2626` | `#c81e1e` | 3.28, 4.99 / 4.48, 5.32 |
| open (`Circle`) | `#94a3b8` | `#94a3b8` | `#64748b` | `#526075` | 4.81 / 4.41, 5.92 |
| waiting, derived (`Hourglass`) | open hue as **outline + 45° hatch** | same | same | same | texture, not hue |
| cancelled (`CircleSlash`) | `#7c8595` | `#9ca3af` | `#7b8494` | `#5f6673` | 3.32, 4.86 / 3.49, 5.36 |
| stale, modifier (`Clock`) | `#fb923c` | `#fb923c` | `#c2410c` | `#b3410c` | 5.45 / 4.80, 5.29 |

```css
.team-status {
  --ts-done:#22c55e; --ts-review:#f472b6; --ts-blocked:#f59e0b; --ts-claimed:#60a5fa;
  --ts-failed:#ef4444; --ts-failed-ink:#fb8080; --ts-open:#94a3b8; --ts-cancelled:#7c8595;
  --ts-cancelled-ink:#9ca3af; --ts-stale:#fb923c;
  --ts-ink-faint: color-mix(in srgb, var(--text-color) 28%, transparent); /* grid, edges */
  --ts-line: var(--brutal-line-soft);
}
.light-theme .team-status {
  --ts-done:#15803d; --ts-review:#db2777; --ts-review-ink:#be185d; --ts-blocked:#c2700a;
  --ts-blocked-ink:#a3480b; --ts-claimed:#2563eb; --ts-claimed-ink:#1d4ed8;
  --ts-failed:#dc2626; --ts-failed-ink:#c81e1e; --ts-open:#64748b; --ts-open-ink:#526075;
  --ts-cancelled:#7b8494; --ts-cancelled-ink:#5f6673; --ts-stale:#c2410c; --ts-stale-ink:#b3410c;
}
/* each *-ink defaults to its mark: --ts-done-ink: var(--ts-done) etc. */
```

- **Same hues as the app:** blocked `#f59e0b`, done `#22c55e`, failed `#ef4444` match the tab
  dots (`App.css:9354`, `:12323-12333`), so amber means "waiting on you" everywhere.
- **Review is pink, not violet:** the palette validator (`dataviz` skill) put blue vs violet
  at ΔE 1.3 under deuteranopia (indistinguishable); pink vs blue passes.
- **Stacked-bar order** (fixed): `done | review | blocked | claimed | failed | open |
  waiting`; cancelled is left out ("+n cancelled" text). Validator, adjacent pairs: dark
  (surface `#181824`) CVD ΔE >= 10.4, normal >= 22.4; light (`#f8f6f3`) CVD >= 8.4, normal
  >= 19.7; all marks >= 3:1. The natural flow order failed (red next to green: ΔE 1.1 deutan).
- **Never color alone:** icon + word in chips, legend and tooltips. Waiting = hatch.
  Stale = hatch + `Clock` + "stale 42m" over the owner state's color, never its own fill
  (orange would sit next to blocked amber). `forced-colors: active` -> outlines + texture.
- **Accent** only for selection, focus and links, never a state (some themes have red/green/
  amber accents). **Agent 7501 status** reuses the tokens: working = claimed blue, blocked =
  amber, done = green, idle = open gray, exited = cancelled.

## 6. Typography, spacing, cards, density
- **Font:** inherit `var(--font-family)` (the app's mono font, `App.css:224`), so figures
  already align. **Scale** 11/12/13/16/24px: 11px uppercase `.06em` weight 700 section titles;
  12px meta; 13px row titles; 16px view title; 24px weight 800 tile numbers.
- **Spacing:** 4px grid; card padding 12px (8 narrow), gaps 12px (8 narrow), outer 16px; rows
  32px (`--ui-control-h-dense`), 28px narrow.
- **Cards:** `background: var(--ts-raised)`, `1px solid var(--ts-line)`, radius
  `var(--brutal-radius)` (2px), **no shadow**. Only the outer container keeps the
  `.panel-modal-container` 2px line + 4px hard shadow; reuse those classes instead of
  DashboardPanel's 12px rounded inline style (restyle its frame to match). Clickable
  cards/rows use the app's button hover: translate(-1,-1) + `--brutal-shadow-small` + accent
  border.
- **Needs-you items** are the only tinted cards: `color-mix(in srgb, var(--ts-<state>) 10%,
  var(--ts-raised))` + 3px left edge in the mark color; text stays `--text-color`.
- **Chart marks:** 2px lines, 1px data-end radius (square like the skin), 2px surface gaps,
  gridlines 1px `--ts-ink-faint` or none, at most 2 direct labels per chart.

## 7. States of the view
- **Loading:** static skeleton blocks at final tile/row sizes (`--ts-ink-faint` 12%), no
  shimmer (Fast mode); "Loading team board..." text after 300 ms.
- **Board unavailable** (Postgres unreachable, SQLite open error): full-width banner,
  `CircleX` + "Team board unavailable: <reason>" in failed ink, [Retry] [Open Settings > Agent
  team board]. Agent rows (from tabs) and limits still render; task areas show the last
  snapshot greyed with "as of 14:02" if one exists.
- **No team yet:** centered `.ui-empty-state` (`index.css:60`): "No agent team in this
  project" / "A team starts when an agent tab runs `agent run`. Ask a Claude tab to "spin up
  a reviewer"." + [Copy command] + guide-step link. No badge.
- **Notes but no tasks:** board collapses to one hint ("No tasks yet - agents add them with
  `agent task add`"); Activity takes the main area.
- **Nothing needs you:** one line, `CircleCheck` + "Nothing needs you" in muted ink, no
  illustration; the section keeps its place so the layout doesn't jump.
- **Mirror team** (sync mode, home elsewhere): header chip "read-only . home: <host> . synced
  2m ago"; human actions hidden; Needs you items say "on <host>" without actions.

## 8. Interaction
- **Team selector:** defaults to the team whose root tab is in the active project, else the
  most recently active team. Grouped "This machine" / "Other machines (read-only)", each with
  its needs-you count; remembered per project.
- **Filters** (one row, above the task area only): state chips (multi-toggle, mirrors the
  legend), agent, label, search on `#seq`/title. Clicking a state-bar segment or legend entry
  toggles that state. Filters reset when the team changes.
- **Click-throughs:** agent row or owner name -> jump to tab (overlay: close it and focus the
  terminal; pop-out: focus main window + tab, keep the pop-out). Task card -> detail drawer
  (right, 420px; full-screen sheet when narrow): body, result (summary, branch, commit,
  checks), deps, time-in-state strip, event history. Needs-you item -> its primary action or
  the task detail.
- **Human actions** (viewer spec): approve, reject (inline reason), retry, cancel, reopen,
  edit, post note. Cancel/clear confirm. Approve/Reject/Retry only in Needs you and the
  drawer, never on board cards. A person never claims, blocks, releases or finishes.
- **Tooltips** (hover and focus, 150 ms, system sans like `.octo-tooltip`): segment "Review .
  1 task . 6%"; sparkline bucket "13:50-14:00 . 2 done"; meter "t1 has 4 of 6 children"; DAG
  node title/owner/state/waits-on; time-in-state segment state + duration.
- **Badge count** = actionable needs-you items: reviews waiting (not on mirrors) + failed +
  blocked agents (7501) + blocked tasks + stale claims. Waiting, refusals and info are not
  counted. Shown on the toolbar gauge (sum over the active project's teams) and on each
  project tab. Style: 16px square, `--text-color` digits on `--ts-raised`, 2px border in the
  most severe state's mark (failed > blocked > review > stale), "9+" cap, never animates,
  `aria-label="4 items need you: 1 review, 1 failed, 1 blocked agent, 1 stale"`.
- **Pop-out:** `openToolWindow` pattern, label `tool-team-status`, route
  `/team-status?team=<id>&projectId=<id>`, 440x720 default, min 360x480. Header pin toggle ->
  `setAlwaysOnTop` (`windowPin.ts` helpers). Theme: pass the style index; the page computes
  `isLightBg` like `ScrumPage.tsx:69` and follows changes via an app event. While popped out,
  the overlay tab shows "Open in its own window" + [Bring to front].
- **Machines (placeholder):** usage type (`sqlite`/`sync`/`postgres`), machine name, sync chip
  (on/paused/offline), last push/pull, rows waiting, last error, other hosts with mirrored
  team counts. Until sync lands: dashed card "Sync not set up (local board)" + [Open Settings].

## 9. Motion
No entrance animations, no pulsing (blocked never animates, `App.css:12321`). A changed
count or new needs-you item gets one 600 ms tint fade (`--ts-<state>` 18% -> 0), skipped
under `prefers-reduced-motion: reduce` and on initial load. DAG hover dim and drawer slide:
90 ms (the app's hover speed), 0 ms under reduced motion. Refresh never reflows: reserve
space for counts and "+n more".

## 10. Keyboard and screen readers
- **Shell:** `data-kbd-region="panel"`, `role="dialog" aria-modal="true" aria-labelledby`;
  focus moves in on open; Esc closes, swallowed in the capture phase like
  `DashboardPanel.tsx`; focus trap via `src/a11y/dialogFocus.ts`.
- **Tabs** (`[Team status | Dashboard]`, `[Board|List|Dependencies|Timeline|Activity]`):
  `role="tablist"`, arrow keys, `data-hint` targets for hint mode.
- **Lists** (Needs you, Agents, Activity): `role="list"`, one focusable element per row,
  actions reachable by Tab, j/k between rows.
- **Charts:** `<svg role="img" aria-labelledby="title desc">` with a generated sentence ("17
  tasks: 8 done, 1 review, 1 blocked, 3 working, 1 failed, 2 open, 1 waiting"). Every chart
  card has a "Table" toggle rendering the same aggregation as a `<table>`. Interactive parts
  (bar segments as filter buttons, DAG nodes) are real `<button>`s / `tabindex=0` outside
  `role="img"`. DAG arrows: left/right = dependency/dependent, up/down = within a layer.
- **Live region:** `aria-live="polite"` for needs-you changes only ("New: review #12"), at
  most once per 10 s. **Focus ring:** `var(--focus-ring)` (`App.css:22`).

## 11. Components (props sketch)
```ts
TeamStatusOverlay({ initialTab: 'team'|'dashboard', onClose, onPopOut, style })
TeamStatusView({ teamId, layout?: 'auto'|'narrow', source: TeamBoardSource, now })  // root, container queries
  TeamHeader({ teams, teamId, onTeamChange, machine: MachineInfo, pinned, onPin, onPopOut, onClose })
  SummaryStrip({ summary: StateSummary, agents: {live,max}, doneSeries: number[] })
    StateBar({ counts, order: StateKey[], onToggle(state), active: Set<StateKey> })   StatTile({ label, value, state?, series? })
    Sparkline({ values: number[], width, height, label })
  NeedsYouList({ items: NeedsYouItem[], onAction(item, action), onJump(tabId) })
  AgentList({ rows: AgentRow[], onJump(tabId) })   // AgentRow: tab, name, cli, status7501, held: StateCounts, activity: number[], lastAt
  TaskArea({ view: 'board'|'list'|'deps'|'timeline'|'activity', filters, onFilters })
    TaskBoard({ columns: BoardColumn[], onOpen(taskId) })   TaskList({ groups, onOpen })
    TaskCard({ task: TaskView, compact? })   StateChip({ state, stale?, waiting? })   AttemptPips({ used, max })
    DependencyGraph({ layout: DagLayout, highlight?: number, onOpen })   DependencyTree({ roots: DepTreeNode[] })
    TimeInState({ lanes: StateLane[], range: [t0,t1] })   BurnUp({ total: Point[], done: Point[] })
  ActivityFeed({ entries: FeedEntry[], filter })
  LimitsCard({ usage: LimitUsage, refusals: Refusal[] })   SegmentedMeter({ used, max, label })   MachinesCard({ mode, sync? })
  TaskDrawer({ task, events, onAction })   ChartFrame({ title, summary, table: ReactNode, children })  // table toggle
```

**Pure functions in `src/teamStatus/model.ts`, each unit-tested (vitest):**
`deriveTaskView(task, depsById, now, staleMs)` (display state, `waiting`, `waitingOnFailed`,
`depCancelled`, `stale` - home teams only); `summarize(views)` (cancelled out of the bar);
`stateBarSegments(counts, width, gap)` (1-count segment >= 4px, exact gaps);
`needsYou(views, agents, refusals, now, {mirror})` (severity failed > blocked agent > blocked
task > review > stale, then age); `badgeCount` / `badgeLabel(items, locale)`;
`bucketCounts(events, action, now, bucketMs, n)`; `burnUp(events, tasks)`;
`timeInState(events, now)` (repeated claims, reject->open, retry); `agentLoad(views, tabs)`;
`limitUsage(links, limits)` (same inputs as `checkAgentRunLimits`);
`layoutDag(nodes, edges, {maxNodes:40, maxLayers:8})` -> `{mode:'graph', layers, positions,
paths, crossings}` | `{mode:'tree', reason}`, deterministic; `depTree(views, deps)`;
`teamStatusSurface(style)` -> `'tinted'|'neutral'`; `formatAge(ms, locale)`. Plus a vitest that
every `--ts-*` value meets its contrast target on the surfaces of all built-in themes (same
math as the brief's calculation; runs in ms).

## 12. References (one pattern taken from each)
| Source | Pattern taken |
|---|---|
| Linear Insights: https://linear.app/features/insights , https://linear.app/docs/insights | Status-segmented bars; click a segment to filter the view; hover shows count + %. |
| Linear cycle graph: https://linear.app/learn/insights-and-analytics | Burn-up with a gray scope line vs completed line; scope creep visible. |
| Linear dashboard advice: https://linear.app/now/dashboards-best-practices | Keep a single dashboard few-and-focused; small grid of same-shaped charts. |
| Linear Inbox / My Issues: https://linear.app/docs/assigning-issues , https://linear.app/now/how-we-redesigned-the-linear-ui | A dedicated "act on this" queue separate from the full board, with list + detail split. That is our Needs you + drawer. |
| Plane states: https://docs.plane.so/core-concepts/issues/states , https://docs.plane.so/core-concepts/analytics | Group fine states into a few columns (To do / Working / Review / Done / Failed) for the board and counts. |
| GitHub Primer color roles: https://primer-docs-preview.github.com/product/getting-started/foundations/color-usage/ , https://primer.github.io/design/components/icon/ | Distinct functional roles (open / attention / done / danger), each with fg/bg/border variants. Separate CVD-tuned values per theme. |
| GitHub Actions graph (via https://datadef.io/guides/en/living-diagram-from-github-actions , https://dcotelo.dev/blog/github-actions-visualizer/) | Jobs as nodes, `needs` as edges, live status color; hover highlights the full upstream/downstream chain. |
| Vercel Geist Status Dot: https://vercel.com/geist/status-dot | Only in-progress states may move; terminal states are static; the aria-label carries the state text. (We go further: nothing moves.) |
| Temporal timeline: https://temporal.io/blog/lets-visualize-a-workflow , https://temporal.io/blog/the-dark-magic-of-workflow-exploration | One lane per unit of work over a shared time axis; compact / timeline / full-history views of the same events. |
| Grafana Stat: https://grafana.com/grafana/plugins/stat/ , https://docs.aws.amazon.com/grafana/latest/userguide/v12-panels-stat.html | Big number + optional sparkline; the sparkline auto-hides when the tile is small. |
| Datadog Monitor Summary: https://docs.datadoghq.com/dashboards/widgets/monitor_summary/ | Status counts row, with an option to hide zero counts. We hide zero tiles except Done and Agents. |
| Langfuse agent graph: https://langfuse.com/changelog/2025-02-14-trace-graph-view | A graph view plus a flat log view for loopy runs. A graph alone fails on cycles and loops, hence our tree fallback. |
| Few, Bullet Graph spec: https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf | Replace gauges with linear meters; ranges in one neutral hue. |
| Tufte sparklines: https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/ | Word-sized, no frame or axes; scale comes from the adjacent number. |
| Part-to-whole guidance: https://dataviz.unhcr.org/chart-types/part-to-a-whole/ , https://developer.semrush.com/intergalactic/data-display/donut-chart/donut-chart | Donut only for ≤ 5 parts and a single set; otherwise a stacked bar. |
| Sugiyama layout: https://erikbrinkman.github.io/d3-dag/interfaces/src.Sugiyama.html , https://klanghaus.github.io/vitepress-plugin-diagram/guide/sugiyama.html | Longest-path layering + barycenter sweeps, keep the best ordering. Enough for 40 nodes without a library. |
| Accessible charts: https://accessibility.build/guides/accessible-charts | `role="img"` + title/desc; a data table as the real text alternative; no hover-only info. |
| Status color rules: https://lucky.graphics/learn/chart-color-accessibility-checklist-2026/ , https://accessibility.umich.edu/node/397 | Icon + word with every status color; 3:1 for marks, 4.5:1 for text (WCAG 1.4.1, 1.4.11). |
| Okabe-Ito: https://sci-draw.com/blog/colorblind-safe-palettes-okabe-ito-reference | Considered for the state hues and rejected, because its orange/vermilion/yellow clash with the app's existing amber/red/green semantics. Kept the app hues and fixed CVD by ordering + texture instead. |

## 13. Open choices (not settled)
1. **OS notification** for a new needs-you review? Today only tab alerts exist.
2. **"All teams" aggregate view.** The spec scopes the viewer to one team; an aggregate helps
   the badge but doubles the aggregation paths.
3. **Pop-out theme:** follow the *active* project live, or the project that owns the team
   (my pick, needs a project-to-team lookup)?
4. **Stale threshold:** `agents.board.staleMinutes` vs a fixed 30 min. Mirrors must show the
   home's verdict, which the sync payload may not carry yet.
5. **5 grouped board columns vs 7 raw ones.** I chose 5 (blocked inside Working, waiting
   inside To do, with sub-chips); the maintainer may want Blocked as its own column.
6. **Review pink** is deliberate (CVD), but Linear/GitHub use violet for review/done. Violet
   only works if review never touches claimed-blue in the bar. Taste call.
7. **Mono font everywhere** matches the app; a sans for prose (titles, notes) may read better
   at 12-13px. Try both in the dev app.
8. **Refusal data** lives in `~/.config/octo/agent-relay.log`; reading it needs a host
   command that doesn't exist yet.
9. **Mermaid** is bundled and could draw the graph as a stopgap. I recommend against it (no
   per-node focus, async, off-theme), but it would cut DAG work if time is short.

## Stage 4a notes (builder's choices inside the rules)

- Data: `agent_task_list` with `all: true, limit: 500` (tasks + dependency states), new
  `agent_board_team_events` (newest 500 task events of the whole team, both stores, shared
  suite `team_events_list_every_task_newest_window_oldest_first`), `agent_board_read` (200 posts,
  announcements first), `agent_task_show --history` for the drawer, new read-only
  `agent_relay_log_refusals` (last 20 `run_refused` entries with a limit name among the last
  500 log lines; returns ts/limit/caller id+name/count/max, never `textHead` or `error`). The
  relay log has no `.dev` variant, so neither does the reader.
- A person's actions reuse the App's existing `humanTaskAction` (store `Actor.human`) and a new
  `humanBoardPost` (author "user", kind note). No new host write command was needed; the
  store's `check_transition` already refuses claim/block/release/finish for a person. A shared
  test (`a_person_reviews_retries_reopens_cancels_and_edits`) covers reject/approve/reopen/
  retry-past-limit/edit/cancel as "user" on both engines.
- Strings live in `src/teamStatus/strings.ts` (en + ko; other locales fall back to English
  like `src/i18n`) instead of adding ~150 keys to all eight locale files.
- Needs you: a stale blocked task stays one "blocked" item flagged stale; refusals of the
  last 60 min are listed as info (never counted). Blocked agents have no start time from 7501,
  so their age reads "now". Mirror detection: `mode === 'sync'` and the team's `homeHost` is
  not this host (no mirrors exist until 3b).
- Badges: a background read (`useTeamWatch`, createStatusPoller 15 s + board events debounced
  500 ms) of the 12 most recently active teams, only while relay children exist or the Team
  status tab is open (never for the Dashboard tab alone). The hook computes the task-based items
  itself and sets state only when the teams/item-key string changes; turning it off clears the
  badges. It still reads alongside the open view's own poll (not merged; both are cheap local
  reads on SQLite). A team belongs to the project holding
  its root tab, else one of its relay children. The project-tab badge is clickable (opens Team
  status for that project's first team).
- Team status button: shown next to the stop-team button whenever the active project has a
  board team (the stop-team button itself still only appears while a child works).
- Layout: CSS container queries do the visual split; a ResizeObserver also picks the main tabs
  (wide [Board|List], medium [Board|List|Activity], narrow [Agents|Tasks|Activity|Limits]) and
  three board columns below 900 px. The drawer is absolutely placed in the view.
- The Dashboard tab is the old iframe panel content (`DashboardContent`), restyled to `ts-*`
  buttons inside the shared modal shell; URL, sandbox and Esc behaviour are unchanged.
- Review fixes (2026-11-17):
  - Cards a layout hides are not rendered (narrow: agents and band; medium: band activity), and
    `focusableIn` skips elements with no layout box (`getClientRects()`; jsdom falls back to
    computed `display`), so Tab never lands on hidden controls and ids stay unique.
  - Esc closes the innermost open part first (reject form / drawer edit-cancel-reject mode →
    drawer → add-task form) through an escape stack (`escape.ts`), then the overlay. Unsent note
    text is kept per team when the overlay closes.
  - Tries are shown as people count them: `attempt + 1` capped at the maximum (`triesUsed`;
    the store's attempt is 0 on the first try, +1 per retry/reject/reopen).
  - Needs you lists only refusals whose caller is a member of the selected team (keys without
    a list index); the Limits card still lists the app-wide recent refusals.
  - The "Agents" tile is this team's live agents, root tab left out, without `/max` (the
    Limits card shows the app-wide total/max).
  - A badge click remembers the chosen team under the badge's project.
  - Jump to tab closes the overlay without restoring the old focus (`useDialogFocus`
    `restoreFocus`) and focuses the target tab's xterm textarea.
  - No board file from the viewer: `agent_board_info` only builds the store (the SQLite file is
    opened lazily, so no file); `agent_board_teams` now returns `[]` in SQLite mode when the file
    does not exist (it used to open, and so create, it); the view reads a team's tasks/events/
    posts only once the board lists that team.
  - Narrow spacing tokens are set on `.ts-view`/`.ts-drawer` (a container query cannot style its
    container); badges use the `--ts-*` tokens; `[data-state]` rules are scoped to `.team-status`.
  - The Dashboard tab no longer grabs focus when reached with the arrow keys, and its iframe
    stays mounted (hidden) after the first visit, so tab switches do not reload it.
  - Korean wording without jargon (팀장 탭, 하위 에이전트, 응답이 끊겨 회수됨, 에이전트 추가가 한도에
    걸림; idle 쉬는 중 vs waiting 선행 작업 대기); note kinds are localized in Activity.
- Not done in 4a / not checked: the view has **not been looked at in a running app**
  (no dev-app check; container widths, focus order and the hard-shadow look are unverified);
  no merge of the badge read with the open view's read; no OS notification; no per-bucket sparkline tooltips; refusal ticks do not link to log
  lines; Machines card is the placeholder; 4b items (dependency graph/tree, timeline, pop-out +
  pin, guide step) not started.

## Stage 4b notes (builder's choices inside the rules)

- Pure functions live in `src/teamStatus/graph.ts` (`depSubgraph`, `layoutDag`, `dagChain`,
  `dagNeighbor`, `depTree`) and `src/teamStatus/timeline.ts` (`burnUp`, `timeInState`,
  `medianTimeIn`, `laneTotals`) instead of growing `model.ts` past 650 lines.
- Dependencies: the subgraph is built from the **filtered** tasks (filters apply); open tasks with
  no dependency and no dependent are left out and counted ("n open tasks wait on nothing").
  `layoutDag` sorts ids and edges first, so it is deterministic whatever the input order; the
  sweeps stop early at zero crossings. Self-dependencies count as a cycle. Graph → tree when
  > 40 tasks, > 8 layers (or the walk passes 64), a cycle, or a narrow view; when the graph fits,
  a [Graph | List] toggle is offered. Nodes are absolutely placed `<button>`s over the edge SVG
  (`role="img"` + sentence) with a roving tab stop; the table toggle lists depends on / needed
  by. The critical-path outline (spec 4.1) is **not** built.
- Tree: roots are tasks nothing in the graph depends on; a task already expanded elsewhere is
  shown again as a leaf marked "listed above"; a cycle is marked and not expanded. Keys follow
  the WAI-ARIA tree pattern (Up/Down, Right opens/enters, Left closes/goes up, Home/End,
  Enter/Space opens the task).
- Timeline: events come from the team's newest 500 task events; a task whose `add` fell out of
  that window starts at `createdAt` in the state its first known event left. A task with no event
  in the window is drawn open from `createdAt` and in its current state from `updatedAt` (review
  fix; before, an old finished task looked done from its creation); time-in-state skips such
  tasks. A lane's work ends at done/cancelled (then a faded segment in that state, 45% opacity,
  runs to now so the lane reads as finished; not counted in totals or medians), otherwise at now;
  event times later than now are clamped to now; an event that does not change the state never
  splits a segment. The cache key includes the team. Lanes are HTML spans (`role="img"` on the lane block, segment tooltips via
  `title`); the burn-up is SVG with `vector-effect: non-scaling-stroke` and HTML axis labels. The
  task drawer shows the same strip for one task from its full history.
- Tabs: wide [Board|List|Dependencies|Timeline], medium [... |Activity], narrow
  [Agents|Tasks|Activity|Dependencies|Timeline|Limits] (Timeline added to narrow too).
- Review fixes (2026-11-17): the dependency memo caches only the shape (ids + links, keyed on
  states/deps); titles, owners and waiting flags are read from the current task lists each render
  (graph and tree). Crossing counts use hops grouped per layer once (worst case 40 nodes / 8
  layers dense is tested). Mouse-leave keeps the keyboard-focus highlight. Korean sentence uses
  "먼저 끝나야 할 일을 기다림" (the short chip label stays "선행 작업 대기").
- Pop-out security wording: a person's actions are not reachable through `agent.*` UI commands,
  which is not a boundary (`bbarit-ctl js` / mcp-bridge already control the main window). Tauri
  events carry no sender, so each open makes a random token (`crypto.randomUUID`) passed in the
  URL; every request and notice (hello, team, jump, settings) must carry it, otherwise it is
  ignored. After the main window reloads (token lost) it adopts the token of the first hello.
- Pins: `tool-team-status` no longer follows the main window's pin (`windowPin.ts`
  NOT_FOLLOWING); the context carries `mainPinned` and the pop-out applies "own pin OR main pin"
  (`popoutOnTop`); its button shows its own pin, with a hint when on-top comes from main.
- Close race: a close event marks the pop-out closed only after `getByLabel` finds no live window
  with that label; one close listener at a time (replaced on open, set again only when a hello
  arrives while the state says closed). The context message is shape-checked before use.
- Pop-out: `src/teamStatus/popout.ts` + `src/pages/TeamStatusPage.tsx`. The pop-out never reads
  the board itself: every read and a person's action is a request to the main window
  (`serveRequest` serves only the source's read methods and a person's action names), so there is
  one data path and no Rust change. The main window pushes a context (team, nonce, agent tab
  states, limits, theme of the project owning the team, surface, stale threshold) whenever its
  JSON changes, and forwards `octo-agent-board` DOM events as `ts-pop:board`; the page re-emits
  them as DOM events, so `useTeamBoard` is unchanged. The page says hello every 2 s until the
  first context arrives (after ~12 s it says the main window is not answering). Only the window
  labelled `main` answers (the harness window loads the same App). Pin = `applyWindowPin` on
  the pop-out (remembered in localStorage); Esc closes the innermost open part, never the window.
  The overlay closes when the pop-out opens; reopening it shows "Team status is open in its own
  window" + [Bring to front]. `tool-*` is already in the default capability, so no capability or
  Rust change was needed. **Dashboard pop-out is not built** (the iframe tab would need its own
  route and Esc handling; skipped as not cheap enough).
- Guide: step `team-status` after `window-pin`, target `[data-guide="team-status"]` (the gauge
  button), ticked when the Team status tab or the pop-out is showing; other locales carry the
  English text like earlier steps.
- Fixes: Activity rows wrap inside the visible width (`overflow-x: hidden`, `scrollbar-gutter:
  stable`, `min-width: 0` on the grid cells, wrapping links); task-card titles/meta and Needs-you
  titles get `min-width: 0` + `overflow-wrap: anywhere`. The cause of the clipped "owner tal…" was
  not reproduced (no dev-app check); the rules are defensive.
- Not done / not checked: **nothing of 4b has been looked at in a running app** (graph sizes,
  hover dimming, pop-out window creation, theme push, pin on macOS, focus of the main window on
  jump are unverified); no critical-path toggle; no Dashboard pop-out; the Machines card stays
  the placeholder.
