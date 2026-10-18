# bbarit-ctl — BBARIT Terminal Control CLI

Control **every feature of a running BBARIT Terminal** from the command line.
It talks to the same UI command bus used by the gateway secretary's `app_control`
tool, so anything the secretary can do — plus terminal I/O, personas, harness
roles, and the full command palette — is scriptable.

```bash
npm run ctl -- <command> [args…] [options]
npm run ctl -- menu        # full menu
```

## How it works · prerequisites

| Item | Detail |
|---|---|
| Transport | mcp-bridge WebSocket → `window.__BBARIT_CTL__.dispatch()` (same dispatcher as the gateway) |
| Target app | **Dev app**: auto-scan ports 9323–9422 (default) / **Installed build**: pass `--port 9223` |
| Prerequisite | The app must be running (`npm run tauri:dev` or the installed app) |
| Auth | Local only — no tokens, nothing exposed externally |
| Exception | `harness` commands edit the agent config files (`~/.bbarit/agent/*.json`) directly — they work without the app |

## Common options

| Option | Description |
|---|---|
| `--port <n>` | Target port (installed build: `9223`) |
| `--json` | Raw JSON instead of human tables |
| `--window <label>` | Target window label (default `main`) |
| `--timeout <ms>` | Response timeout (default 20000) |

---

## Command reference

### ■ Status

#### `status`
Active project id, view mode, project list, and open files.
```bash
npm run ctl -- status
```

#### `commands`
The app's **full command-bus dictionary**, grouped. Source of truth is
`src/gatewayUiCommands.ts` inside the app — new commands show up automatically.
```bash
npm run ctl -- commands
npm run ctl -- commands --json
```

#### `menu` / `help`
Prints the condensed menu version of this document.

---

### ■ Projects

#### `project list`
Open projects as an `id / name / workDir` table.

#### `project create <workDir> [name]`
Opens a folder as a project. Creates the folder if missing; switches to the
project if it is already open.
```bash
npm run ctl -- project create ~/Documents/bbarit/web "Web"
```

#### `project switch <projectId>`
Switches the active project. Get ids from `project list`.

---

### ■ Layout & view

#### `view <mode>`

| mode | Screen |
|---|---|
| `default` | Editor (top) + terminal (bottom) |
| `terminal` | Terminal full screen |
| `editor` | Editor full screen |
| `side` | Editor (left) + terminal (right) |
| `kanban` | Kanban + terminal |
| `pm2` | Server (SSH) monitor |
| `hub` | Hub |
| `project-terminal` | Per-project terminals |

```bash
npm run ctl -- view side
```

#### `layout <mode>`
Terminal split layout: `tabs | horizontal | vertical | grid | mix | tiled | tiled_tb | tree | monitor`
```bash
npm run ctl -- layout vertical
```

#### `sidebar <on|off>`
Show/hide the file tree sidebar.

---

### ■ Terminals

#### `term list`
Terminals of the active project (`id / name / cliType / active`) plus the current split mode.

#### `term create [cliType] [workDir]`
Creates a terminal. cliType: `shell` (default) `claude` `codex` `bbarit` `kimi` `qwen` … (same set as the app's CLI types).
```bash
npm run ctl -- term create shell
npm run ctl -- term create bbarit ~/Documents/bbarit/web
```

#### `term write <text…>` / `term write-raw <text…>`
Types into a terminal. `write` appends Enter; `write-raw` does not.
Target a specific terminal with `--id <terminalId>` (default: active terminal).
```bash
npm run ctl -- term write "git status"
npm run ctl -- term write --id 17834163… "npm test"
npm run ctl -- term write-raw "y"        # just y, no Enter
```

#### `term read [lines]`
Reads the **last N lines** (default 80, max 2000) of a terminal's screen buffer.
Trailing blank lines are trimmed. It never touches the PTY stream, so it cannot
race the app's own output polling.
```bash
npm run ctl -- term read 40
npm run ctl -- term read 200 --id 17834163…
```

#### `term use <terminalId>` / `term close <terminalId>`
Focus a terminal tab / close a terminal (no confirmation).

> ⚠️ Right after a session restore, old terminals may not have a live PTY yet and
> writes are silently dropped. Run `term use <id>` first to attach the PTY.

**Example — remote build runner:**
```bash
ID=$(npm run ctl --silent -- --json term create shell | python3 -c "import sys,json;print(json.load(sys.stdin)['terminalId'])")
npm run ctl -- term write --id "$ID" "npm run build"
sleep 60 && npm run ctl -- term read 30 --id "$ID"
```

---

### ■ Editor & files

#### `open <path>`
Opens a file in the built-in editor. Text/code opens in Monaco; `xlsx/pptx/docx/pdf`
open in the office editors.
```bash
npm run ctl -- open ~/Documents/bbarit/terminal/README.md
npm run ctl -- open ./budget.xlsx
```

#### `files`
Lists the open editor tabs (path / kind / modified / active).

#### `close <path>`
Closes an open editor tab without confirmation (unsaved changes are discarded).
Accepts the full path or a unique suffix (e.g. just the file name).
```bash
npm run ctl -- files
npm run ctl -- close README.md
```

---

### ■ Kanban

#### `kanban list [column]`
Lists kanban tasks (id / title / column / priority). Optional column filter:
`backlog` `todo` `inprogress` `review` `done` `cancelled`.

#### `kanban add <title…> [--col <column>] [--pri <priority>] [--desc <text>]`
Adds a task. Defaults: column `todo`, priority `medium`
(priority: `none` `low` `medium` `high` `urgent`).
```bash
npm run ctl -- kanban add "Ship v1.0.23" --col inprogress --pri high
npm run ctl -- kanban list inprogress
```

#### `kanban move <taskId> <column>` / `kanban update <taskId> […]` / `kanban delete <taskId>`
Move, edit (`--title` `--desc` `--pri` `--col`), or delete a task by id
(get ids from `kanban list`).
```bash
npm run ctl -- kanban move task-123 done
npm run ctl -- kanban update task-123 --pri urgent --title "Hotfix build"
npm run ctl -- kanban delete task-123
```

Bus equivalents: `kanban.list/add/move/update/delete` — the gateway secretary's
app_control tool can manage the board the same way.

---

### ■ Scheduler (스케줄링 에이전트)

Schedule terminal commands with a natural-language line — Korean or English.
The app types the command into the active terminal when the time comes
(understands 매일/매주/요일마다/N분마다/N분 뒤/내일 HH:MM, every day / every N minutes / in N minutes).

#### `sched add <natural line…>`
```bash
npm run ctl -- sched add "매일 9시에 npm run build"
npm run ctl -- sched add "10분마다 git pull"
npm run ctl -- sched add "30분 뒤에 ./deploy.sh"
npm run ctl -- sched add "every monday at 9:00 npm run report"
```

#### `sched list` / `sched rm <jobId>` / `sched on|off <jobId>` / `sched run <jobId>` / `sched panel`
List jobs (with next-run time), delete, pause/resume, run immediately, or open the panel UI.
```bash
npm run ctl -- sched list
npm run ctl -- sched off sched_123   # pause
npm run ctl -- sched run sched_123   # run now
```

Bus equivalents: `schedule.list/add/delete/toggle/run/panel` — the gateway secretary's
app_control tool schedules the same way ("매일 아침 9시에 빌드 돌려줘" → schedule.add).
The panel is also in the command palette: `action run cp.tools.scheduler`.

---

### ■ Panels

#### `panel <name>`
Opens `image` `design` `cowork` `marketing` `browser` or `settings`.

#### `image <prompt…>`
Opens BBARIT Image and submits a generation prompt.
```bash
npm run ctl -- image "neon-style cat logo, 4 variations"
```

#### `design <prompt…>`
Opens BBARIT Design and submits the prompt.

#### `cowork [--dir <workDir>] <prompt…>`
Opens BBARIT Cowork and starts a task. `--dir` selects the project folder.
```bash
npm run ctl -- cowork --dir ~/Docs/reports "Summarize the documents in this folder into a briefing"
```

#### `marketing [--dir <workDir>] <prompt…>`
Opens BBARIT Marketing and starts a marketing task (SEO, content, social, ads, analytics, etc.). `--dir` selects the project folder.
```bash
npm run ctl -- marketing "Research keywords for this product and prioritize them"
npm run ctl -- marketing --dir ~/Projects/saas "Build a quarterly marketing strategy"
```

#### `lounge [open]` / `lounge send <text…>`
Opens the Chat panel (global BBARIT Lounge shared by all BBARIT Terminal users), or sends a message to it. Sending requires the panel to be open and connected.
```bash
npm run ctl -- lounge open
npm run ctl -- lounge send "hello from the CLI"
```

#### `thread [open]`
Opens the BBARIT Thread window — the public text SNS (GitHub sign-in, posts/replies/likes/images; read-only web feed at bbarit.com/thread).
```bash
npm run ctl -- thread open
```

---

### ■ Settings

#### `config get [path]` / `config set <path> <json>`
Read/write app config by dot path. Values are parsed as JSON (fallback: string).
```bash
npm run ctl -- config get                          # whole snapshot
npm run ctl -- config get agent.bbaritPersona
npm run ctl -- config set agent.bbaritLanguage '"en"'
npm run ctl -- config set terminal.fontSize 14
```

#### `persona list [query]` / `persona set <id|off>`
List/search the BBARIT Agent persona library and set the default BBARIT Agent persona.
```bash
npm run ctl -- persona list architect
npm run ctl -- persona set code-reviewer
npm run ctl -- persona set off
```

---

### ■ Harness (works without the app)

Edits the agent config files directly: `~/.bbarit/agent/harness-models.json`
and `harness-personas.json` (override the directory with `PI_CODING_AGENT_DIR`).

#### `harness roles`
Per-role (planner/developer/reviewer) model & persona overview.

#### `harness model <role|all> <provider/model|clear>`
```bash
npm run ctl -- harness model planner anthropic/claude-opus-4-8
npm run ctl -- harness model all deepseek/deepseek-v4-flash
npm run ctl -- harness model developer clear
```

#### `harness persona <role> <personaId|clear>`
```bash
npm run ctl -- harness persona reviewer code-reviewer
npm run ctl -- harness persona planner clear
```

> Changes apply from the next `/harness` run (a run already in progress is unaffected).

---

### ■ All actions — command palette (every menu & action)

Runs **any action registered in the app's command palette** (75+: view switching,
terminal management, panels, notes, skills, update checks, …). Anything not
covered by the structured commands above is reachable here.

#### `action list [query]`
```bash
npm run ctl -- action list             # all 75+
npm run ctl -- action list terminal    # search
```

#### `action run <id>`
```bash
npm run ctl -- action run cp.terminal.new
npm run ctl -- action run cp.settings
```

Bus equivalents: `palette.list` / `palette.run(id)` — the gateway secretary's
app_control tool can use them the same way.

---

### ■ Utility

#### `copy <text…>`
Copies text to the system clipboard.

#### `notify <text…> [--title <t>]`
Shows a native OS notification (macOS Notification Center / Windows toast).
```bash
npm run ctl -- notify "Build finished" --title "CI"
```

#### `screenshot [file]` / `snapshot [file]` / `js <code>`
Delegated to `tauri-dev-screen.mjs` — window capture, DOM snapshot, arbitrary JS.
```bash
npm run ctl -- screenshot .octo-tmp/now.png
npm run ctl -- js "document.title"
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot reach the dev app (ports 9323–9422)` | App not running → `npm run tauri:dev`. For the installed build add `--port 9223` |
| `__BBARIT_CTL__ not ready` | App predates this feature or is mid-reload → reload the app (dev: HMR) and retry |
| `terminal not found` (write) | Restored terminal without a live PTY → `term use <id>` first |
| `terminal not mounted` (read) | Terminal not mounted on screen → `term use <id>` |
| Command doesn't change the UI | Check `--window` label (sub-windows have their own), confirm the target with `status` |

## Architecture notes (for contributors)

- **Adding a command**: ① add a `case` to the `gatewayUiHandlerRef` switch in `src/App.tsx` → ② register it in `src/gatewayUiCommands.ts` → ③ optionally add a friendly subcommand in `scripts/bbarit-ctl.mjs`. The gateway secretary (app_control) gains it automatically since it shares the bus.
- `terminal.read` uses `window.__BBARIT_TERM_READERS__[id]` registered by `XTerminal.tsx` (an xterm buffer reader) — never call `read_from_pty` from outside; it would race the app's own polling.
- Related: remote secretary control lives in `src-tauri/src/agent_gateway.rs` (`WS /gateway/ws`, `POST /gateway/ui`); browser control in `agent-browser-cli/CLI.md`; low-level dev-screen control in `scripts/tauri-dev-screen.mjs`.
