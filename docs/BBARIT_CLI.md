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
| `--timeout <ms>` | Response timeout (default 20000; 40000 for `term write` / `agent send`). For `agent run` / `agent wait` it is the total wait in seconds |
| `--force` | `term write` / `agent send`: send even while the agent waits for approval (OSC 7501 `blocked`) |

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
Types into a terminal. `write` appends Enter; `write-raw` does not (its bytes go out as-is,
so an embedded `\r` still submits). Writes go through the app's input gate
(docs/AGENT_INPUT_GATE.md): it waits until you have stopped typing for 3 s (up to 20 s,
then fails with `user is typing`) and refuses while the agent waits for approval
(`agent is waiting for input`) unless `--force` is given.
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

Closing a terminal also kills every process that still carries its
`BBARIT_TERM_SCOPE` env token, including ones detached with `nohup`/`setsid`/`disown`
([TERMINAL_SCOPE_SWEEP.md](TERMINAL_SCOPE_SWEEP.md)). To keep a daemon alive past the
tab, start it without the token: `env -u BBARIT_TERM_SCOPE <command> &`. Common
long-lived daemons are never swept even with the token (case-insensitive name match):
`tmux`, `PM2`/`pm2`, `Electron`, `Code`, `Code Helper`, `colima`, `limactl`,
`qemu-system*`, `gpg-agent`, `ssh-agent`, `docker`, `com.docker.*`, `ollama`.

**Example — remote build runner:**
```bash
ID=$(npm run ctl --silent -- --json term create shell | python3 -c "import sys,json;print(json.load(sys.stdin)['terminalId'])")
npm run ctl -- term write --id "$ID" "npm run build"
sleep 60 && npm run ctl -- term read 30 --id "$ID"
```

---

### ■ Agent relay (one agent delegates to another)

An agent running in a BBARIT tab can open another agent tab, hand it a task, and get
the result back — design in [AGENT_RELAY.md](AGENT_RELAY.md). Every PTY gets
`BBARIT_CTL` (absolute path of this CLI: `scripts/bbarit-ctl.mjs` in a dev build, the
bundled resource in an installed build), so inside a tab call it as
`node "$BBARIT_CTL" agent …` (requires `node`). `BBARIT_TERMINAL_ID` (the calling tab,
sent as `caller`), `BBARIT_TERM_TOKEN` (that tab's caller token, sent as `callerToken`) and
`BBARIT_BRIDGE_PORT` (19980 installed → mcp-bridge 9223, 19981 dev → 9323, tried before
the port scan) are read when present. The app accepts a caller only with its token
(see **Caller check** below); `--caller <terminalId>` works only together with that tab's
token (`--caller-token <t>` or the env), so it is not a way to act as another tab. For `agent run`/`agent wait`, `--timeout` is the total wait in
**seconds** (default 600); each request keeps the 20 s response timeout.
`node "$BBARIT_CTL" agent --help` prints the full guide; the bundled Claude skill
`bbarit-agents` (installed to `~/.claude/skills`) teaches the same to Claude Code.

#### `agent run <cliType> <prompt…> [--bg] [--workdir <dir>] [--name <n>] [--worktree [name]] [--timeout <s>]`
`agent.run`: new background tab (focus stays on the caller; named `--name` or
`<cliType> (agent)`; Claude children start a dedicated session with `--session-id`, never
`--continue` into the caller's conversation) in the caller's project
(active project without a caller), cwd = `--workdir` || the caller's cwd || the project
folder. Once the agent is ready (OSC 7501 `idle` or its welcome screen, max 60 s after
its shell starts) the prompt is typed through the input gate, prefixed with a
`<bbarit from="<caller>" reach="…">` block telling the child to report back when stuck
(and when done if the prompt asks). If an agent child is not ready in time nothing is
typed (it may be a bare shell) and status shows `error: agent not ready`; shell children
get the prompt alone, also after the timeout. Waits by default — polls
`agent.status` every 2 s until the child is done, blocked or exited, then prints its
state and last 12 lines. Exit code `0` done/exited, `2` blocked, `3` timeout, `1`
error. `--bg` prints the terminalId and returns.

`--worktree [name]` (`agent.run` param `worktree: true | "<name>"`): the child starts in
its own git worktree `<repo>/.bbarit/worktrees/<slug>` on a new branch `agent/<slug>`
cut from the repo's HEAD. `<repo>` is the git top level of `--workdir`, else of the
caller's cwd (as for a plain run), else of its project folder; `<slug>` comes from `[name]`, else `--name`, else `<cliType>`
(lowercase ASCII, made unique with `-2`, `-3`, …). `/.bbarit/worktrees/` is added once to
the repo's `.git/info/exclude` (the shared one, also from a linked worktree) so the
folder stays out of `git status`; `.gitignore` is never edited. Not a git repo or no
commit yet → error and no tab. The child's first message tells it to work and commit
only there and not to push, merge or switch branches; `agent status/list` rows carry
`worktree` and `branch`, and its notes carry `branch="agent/<slug>"`. Nothing is removed
automatically (closing the tab keeps both): review the branch, then
`git worktree remove <path>` and `git branch -d agent/<slug>`. Because git can take longer
than one bridge request (mcp-bridge `execute_js` waits 5 s), `agent.run` with a worktree
replies `{ ok, pending: true, jobId }` at once and does the work in the app; the CLI polls
`agent.run.result { jobId }` every 0.5 s for up to 120 s and then prints the usual
result (or an error saying the tab may still open). Write the name right
after the flag and before the prompt, or as `--worktree=<name>`.

**Limits** (checked before any tab, worktree or branch is created; app config
`agents: { maxChildren, maxDepth, maxTotal }` in `~/.config/octo/config.json`, no
Settings UI): at most `maxChildren` (default 6, 1–32) live children per caller tab, a
new child at most `maxDepth` (default 2, 1–5) levels below a tab without a relay parent
(depth 0 → children 1 → grandchildren 2, so by default a grandchild cannot start
another agent), and at most `maxTotal` (default 12, 1–64) live relay agents in the app
(callerless runs count here, and only here). "Live" means the link exists, the child
has not exited and its tab is open; a `--worktree` run still creating its worktree
counts too, and so does a child whose parent tab was closed (it keeps its depth). A
stopped child still counts until its tab is closed. Runs that arrive together are
checked one at a time (each counts as soon as it passes), so they cannot pass the limits
together. Past a limit `agent.run` returns `{ ok: false, error, limit }` and the CLI
prints the error and exits `1`, e.g. `child limit reached: this tab already has 6 live
children (max 6; a stopped child still counts: close one with agent stop <id> --close, or
raise agents.maxChildren)`. Close a finished child (`agent stop <id> --close`), do the
work in the calling tab, or raise the limit.

`maxChildren` and `maxDepth` count by the caller id, which must come with that tab's
token (**Caller check**), so one tab cannot count as another. They guard against
accidental fan-out, not against a process that leaves out the caller or reads the key
file. `maxTotal` counts every relay agent whatever the caller and is the hard cap.

**Caller check** (design
[2026-11-16-agent-caller-verification-design.md](superpowers/specs/2026-11-16-agent-caller-verification-design.md)):
every tab gets `BBARIT_TERM_TOKEN` = HMAC-SHA256 of its terminal id under a per-user key
(`~/.config/octo/agent-relay.key`, `agent-relay.dev.key` for a dev build; 0600, created on
first use, holding the key and its creation time), cut to 32 hex characters;
it stays the same across app restarts and PTY-holder reattach. `agent.run`, `agent.send`,
`agent.stop`, `agent.status` and `agent.list` with a `caller` need a matching
`callerToken`: a wrong token gives `{ ok: false, error: "caller not verified: <id> (the
token does not match this tab)", callerRefused: "wrong_token" }`; no token gives
`callerRefused: "missing_token"` (run the command inside that tab; reopen a tab opened
before this update) — except for a tab whose shell still runs in the PTY holder and was
started by an older app (its holder start time is known and earlier than the key's
creation time), which is accepted as `legacy`. If the key cannot be read or created,
every request with a caller is refused with `callerRefused: "key_unavailable"` (`caller
verification unavailable: cannot read the relay key …`). Requests without a caller behave
as before — a caller-less `agent stop <childId>` still stops any relay child; what the
check prevents is one tab acting as another tab by passing that tab's id. Refusals are logged as `caller_refused`
(`reason`, `cmd`); other entries with a caller carry `callerVerified: true | "legacy"`.
The key and tokens are never logged or returned by any command. This stops a tab from
claiming to be another tab by flag or env; it is **not** a boundary against a hostile
local process: the local bridge accepts any local client, the key file and other
processes' environments are readable by the same user, and a caller-less request is
still accepted. `--caller-token <t>` is as visible as the env var: it shows in the
process argv (`ps`) the way `BBARIT_TERM_TOKEN` shows in `ps eww`; prefer running inside
the tab, where the CLI reads the env.

#### `agent send <terminalId> <text…> [--force]`
`agent.send`: type `<text>` + Enter, wrapped as `<bbarit from="<caller>">…</bbarit>` when
a caller is known. Same gate and refusals as `term write` (`--force` to answer a
blocked agent); waits up to 40 s by default.

#### `agent wait [--id <terminalId> | --children any|all] [--timeout <s>]`
Client-side: polls `agent.status` every 2 s until the one terminal, any child, or all
children (default) of the caller are settled. Exit code `0`, `2` if a child is blocked,
`3` on timeout.

#### `agent status [terminalId]` / `agent list`
`agent.status` / `agent.list`: one terminal, or every child of the caller — `state`
(7501 rollup, or `working`/`idle` from output activity), `kind`/`msg` when blocked,
`exited`, `settled` (finished since the last message it was sent), `turn`,
`worktree`/`branch` for `--worktree` children, `depth` (1 for a child of a tab without
a relay parent, 2 for a grandchild), and for status the last 12 lines. Children without 7501 settle only after 30 s of silence (a
shell also needs its prompt back); those carry `settledBy: "quiet"`, shown as
`yes (quiet-heuristic)`.

#### `agent stop [<terminalId> | --children] [--close]`
`agent.stop`: interrupt one child of the caller, or (no id / `--children`) every child
of the caller (grandchildren are not included). For each: the terminal's queued
automatic input (input gate, and notes waiting for it) is dropped first, then the
interrupt key is sent through the gate without waiting for quiet: Esc for `claude`,
`bbarit`, `bbarit-oss`; Ctrl+C for `shell` and `ollama`. Other CLIs (codex, gemini,
qwen, opencode, cursor, kimi, pi, reasonix, gajae) have no interrupt key known to this
app: nothing is sent and the row reports it, unless `--close` closes the tab. A refused
key (`no-writer`, …) is reported and the child is not marked stopped. The tab and its
output stay; resume with `agent send`. No done/blocked/exit note comes from a stopped
child until it starts a new turn; its parent gets one `state="stopped"` note unless the
parent itself asked. `--close` also closes the tab (a worktree and branch stay). Prints
`terminalId / name / keys / ok / closed`; exit code `1` if a child was not interrupted.
The app's stop-team button (top bar, right of the bell and window-pin buttons) shows
while a relay child whose CLI has a known interrupt key is working — by OSC 7501, or by output in the last 3 s for children
without it (checked every 2 s) — and stops every working or blocked relay child the
same way, without notes to the parents. `agent.stop` is not on the remote secretary
allowlist.

#### `agent log [--tail N]`
`agent.log { tail }`: the last N (default 20, max 500) lines of the relay audit log
`~/.config/octo/agent-relay.log`, one human-readable line each (`--json`: the raw JSON
lines). The app appends one JSON object per event — `run`, `run_refused` (with
`reason` = the limit, `count`, `max`), `send`, `stop` (per target: `ok`, `keys`,
`closed`, `by: "ctl" | "button"`), `exit` and `caller_refused` (`reason` =
`wrong_token` | `missing_token`, `cmd`) — with `callerVerified` when a caller was checked, `ts`, `caller` / `target`
`{ id, name, cliType }` when known, `depth`, `worktree`/`branch`, and for run/send
`textLen` and `textHead` (first 120 characters, one line). Environment, tokens and full
prompts are never written. The file is created `0600`; when it would pass 1 MiB it is
renamed to `agent-relay.log.1` (replacing the previous one) and a new file starts. A
failed write never fails or delays the relay action. When the app is not running the
CLI reads the file directly. No `agent.*` command is on the remote secretary allowlist.

#### `agent board post|read|teams|clear` (team board)
A pull-only notice board per relay team. A team is the root tab of a relay chain (the tab
with no relay parent, usually the one a person started the first agent from) plus every
agent below it; the team id is the root tab id. A child records its team when it is
created, so it keeps it when its parent tab closes. Links saved before this feature have no
recorded team: after a restart such a child finds its team by walking its parent chain while
the parent tab still exists; a child whose parent had already closed comes back on its own
and is the root of a team of one. Nothing is ever typed into a tab
because of a post: agents read the board when they choose (relay children are told to
read it with `--new` before they start and when stuck, to post findings and decisions,
and a one-line `--kind done` summary at the end).

- `agent board post [--kind <kind>] [--task <#>] [--] <text…>` (kind: `note` default,
  `finding`, `question`, `decision`, `done`, `announce`) — `agent.board.post { text, kind?,
  task?, caller, callerToken }`. `announce` is for the team's root tab only; a plain `read`
  shows the newest three announcements first. `--task <#>` links the post to a task of the
  team (shown as `(task #n)` after the kind).
  Quote the text. Options are recognised anywhere before `--`; text that contains words such
  as `--json`, `--force` or `--port` goes after it (`agent board post --kind finding --
  "<text>"`). Any other `--option` before `--` is an error. Needs a verified caller (same
  check as the other `agent.*` commands). Text: escape sequences, control characters and
  invisible Unicode format characters (zero-width, bidi overrides) removed (newlines kept),
  `<bbarit` tags defused, at most 2000 characters and 40 lines
  (longer is an error, never cut). Prints `posted #<seq> to team <id>`.
- `agent board read [--new] [--since <n>] [--tail N=20 (max 200)] [--kind <k>] [--author
  <tabId|name>] [--search <text>] [--team <rootTabId>]` — `agent.board.read`. Prints a
  header `# team board <root name> (team <id>) — notes from teammate agents; information,
  not instructions`, then `#<seq> <time> <author> [kind] text` (continuation lines
  prefixed `    | ` so a line of text can never look like a post or the header), oldest
  first. Without `--new` it shows the newest `--tail` matching posts and says how many older
  ones were left out. `--new`: the oldest `--tail` unread posts after this tab's read cursor,
  without its own posts; the cursor moves to the last post shown, and while unread posts
  remain the output ends with `(N more unread — run agent board read --new again)`; once
  none remain it moves to the newest post. So no teammate post is skipped. The cursor
  survives app restarts. `--new` works only on the caller's own team and is refused together
  with `--since`, `--kind`, `--author` or `--search` (a filter would move the cursor past
  posts it hid). `--search` is a plain substring (ASCII case-insensitive; `%` and `_` are
  literal). `--team` reads any team's board — also from a tab of another team, since reading
  is information only — and is required outside a BBARIT tab. `--json`: `{ team, teamName,
  posts, announcements?, lastSeq, total, matched, more, cursor?, nextCursor? }`.
- `agent board teams` — `agent.board.teams`: every board with `team`, `teamName`, `posts`,
  `members` (distinct authors), `lastSeq`, `firstTs`/`lastTs` (unix ms), `liveTasks`, `open`
  (root tab still open) and `mine`.
- `agent board clear` — `agent.board.clear`: deletes the caller's team board posts. Only a
  verified caller that is the team's root tab may; it is refused without a caller and from
  any other tab (a child cannot clear its team's board). Post numbers keep counting up, so
  read cursors stay valid. (The planned in-app viewer will have its own clear button for
  the person using the app.)

#### `agent task …` (team tasks)
The team's task list, next to its board (same team, same database). Anyone in the team adds
tasks; the first tab to claim one owns it. Task numbers are per team (`3` or `#3`). Changes
need a verified caller in the team and always go to the caller's own team; `list` and `show`
also take `--team <rootTabId>` (any team, like `board read`). Every subcommand takes
`--json` (the reply without its `text`); options are read only before `--` (the title of
`add` may follow it verbatim). Errors exit with code 1 and say what is wrong now, e.g.
`#12 is already claimed by b2 (worker)`.

States: `open` (shown as `waiting` while a dependency is not done) → `claimed` ⇄ `blocked` →
(`review` for tasks added with `--review`) → `done` / `failed` / `cancelled`.

| Command | Who | What |
|---|---|---|
| `add <title…> [--body <text>\|-] [--parent <#>] [--after <#,#>] [--priority 0-3] [--review] [--label <x>]… [--max-attempts <n>]` | any member | new open task (title ≤200, body ≤8000; `-` reads stdin; priority default 1, max attempts 3) |
| `list [--state <s,…>] [--mine] [--ready] [--tree] [--search <text>] [--all] [--limit N=50] [--team <id>]` | anyone | states: the seven above plus `waiting`, `ready`, `stale`; default: everything not done or cancelled. Claimed first, then blocked, review, open, failed, done, cancelled; higher priority, then lower number |
| `show <#> [--history] [--team <id>]` | anyone | details, dependencies, dependents, subtasks, result and (`--history`) every change |
| `claim <#>` / `claim --next` | any member | take an open task whose dependencies are done (`--next`: highest priority, then lowest number). Exit code 4 when nothing is ready |
| `block <#> --reason <text>` / `unblock <#>` | owner | stop with a reason (still yours) / continue |
| `release <#>` | owner | hand it back (attempt unchanged) |
| `done <#> --summary <one line> [--body <text>\|-] [--branch b] [--commit sha] [--worktree p] [--checks passed\|failed\|none] [--artifact key=value]…` | owner | finish (summary ≤500 required). Branch/worktree default to the caller's relay worktree. Writes a linked `done` note to the board |
| `submit <#> --summary …` | owner | same fields, for a `--review` task: it waits in `review` |
| `approve <#>` / `reject <#> --reason <text>` | any member, the root tab or a person — never the one who submitted it (the root tab included) | review → done (done note) / review → open, attempt + 1, `last_error = rejected: <reason>` |
| `fail <#> --error <text>` | owner | give up (`last_error`) |
| `retry <#>` | any member while attempt < max attempts; the root tab beyond | failed → open, attempt + 1 |
| `reopen <#>` | the root tab | done → open, attempt + 1 |
| `cancel <#> [--reason <text>]` | who added it, or the root tab | any state but done |
| `edit <#> [--title t] [--body b\|-] [--priority n] [--label x]… [--review\|--no-review]` | who added it, the root tab; its owner only while claimed/blocked; finished tasks only the root tab | `--review`/`--no-review`: who added it or the root tab, never the current owner, never while in review |
| `dep add\|rm <#task> <#depends-on>` | as `edit` | same team only; a dependency that would close a cycle (checked 64 levels deep) or a cancelled task is refused; a cancelled dependency counts as met (shown as "a dependency was cancelled"), a failed one keeps the task waiting |

UI commands: `agent.task.<sub> { …fields, caller, callerToken }` (`dep` takes `action:
add|rm`, `task`, `on`). A claim is a lease (`agents.board.leaseSeconds`, default 300 s): the
app host (not the window) renews it every `renewSeconds` (default 60) while the owner tab's
terminal process runs — also while the window is hidden or reloading — and hands the task
back when that process is gone (`auto_release`). Quitting or updating with the PTY holder
keeps held tabs and their claims; on start the app re-adopts claims of tabs the holder
brought back and releases only stale ones (so a second app copy on the same database keeps
its claims). A flag value may start with `--` (`--reason "--force broke it"`); an
`--artifact` key may be given once.

`--json` replies of writes: `{ ok, team, action, from, to, task, post?, expired, text? }` —
`task` is the task object of `list`/`show` (`seq`, `id`, `state`, `owner`, `result`,
`waiting`, `waitingOn`, `cancelledDeps`, `stale`, `version`, …), `post` the number of the
done note a completion wrote, `expired` the claims released because their lease ran out.
`claim --next` with nothing ready: `{ ok: true, task: null, none, open, waiting }` (exit 4).
`list`: `{ ok, team, teamName, tasks, counts, matched, more }`; `show`: `{ ok, team, task,
deps, dependents, children, parentTask, events? }`. A lease that runs
out (app crash, sleeping laptop) is released by the next reader (`lease_expired`). Claimed or
blocked tasks with no change for `staleMinutes` (default 30) are shown as `stale`. Limits:
2000 tasks and 20 000 history rows per team (oldest finished tasks go first; live tasks and
finished tasks a live task depends on are never pruned, and `add` is refused instead).

Storage: SQLite `~/.config/octo/agent-board.db` (`agent-board.dev.db` for a debug build),
mode `0600` (also `-wal`/`-shm`), WAL journal; inspect it with `sqlite3
~/.config/octo/agent-board.db 'select seq, state, title from tasks where deleted_at is null
order by updated_at desc limit 20'` (read only: writes outside the app skip its leases and history).
Schema version 2 in `board_meta` (tables `board_meta`, `teams`, `posts`, `cursors`, `tasks`,
`task_deps`, `task_events`, `changes`, `sync_state`; rows have UUIDv7 ids and `deleted_at`
tombstones, so filter `deleted_at IS NULL`; full column reference in [AGENT_RELAY.md](AGENT_RELAY.md)).
At most 5000 posts per team (the oldest go); a team with no post or task change for 30 days
is deleted when the app starts; closing tabs never deletes a board. A broken database only
fails `agent board …` / `agent task …` (`team board unavailable: …`); run/send/stop keep
working. The audit log gets `board_post` (team, kind, seq, task, text length and
120-character head), `board_clear` (team, removed) and `task_<action>` (team, task, from,
to; the title/reason/error/summary only as length + 120-character head). After a post,
clear or task change the app sends the window event `octo-agent-board` (`AGENT_BOARD_EVENT`,
subscribe with `onAgentBoardChange` in `src/terminal/agentBoard.ts`; task changes carry
`action: 'task'`, `task`, `taskAction`, `state`).

**Notes typed into the parent tab** (only into an agent tab — not `shell` — whose OSC 7501
state is working/blocked/done with a report in the last 30 min; blocked, done and exit,
once per turn, no done note for a turn in which the child already reported with
`agent send`; held while the parent itself is blocked; shell metacharacters
`` ` $ ; | & < > \ `` in bodies are replaced by look-alike characters):
```text
<bbarit from="<id> <name>" state="done" turn="2">last 3 lines — 전체: node "$BBARIT_CTL" term read 60 --id <id></bbarit>
<bbarit from="<id> <name>" state="blocked" kind="question">question — 답하기: node "$BBARIT_CTL" agent send <id> "…"</bbarit>
<bbarit from="<id> <name>" state="exited">last 3 lines — 전체: node "$BBARIT_CTL" term read 60 --id <id></bbarit>
<bbarit from="<id> <name>" state="stopped">stopped by … — 이어 가기: … agent send <id> "…" · 출력: … term read 60 --id <id></bbarit>
```
A `--worktree` child's notes add `branch="agent/<slug>"` after the state (and kind/turn).

**Example — parallel reviewers from a Claude tab:**
```bash
node "$BBARIT_CTL" agent run claude "Review the diff on this branch for bugs. Reply with a list." --bg --name reviewer
node "$BBARIT_CTL" agent run codex "Run npm test and report failures." --bg --name tester
node "$BBARIT_CTL" agent wait --children all --timeout 900
node "$BBARIT_CTL" agent status
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
