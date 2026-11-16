# Agent relay: run limits and an audit log

## Why
A relay child can itself call `agent run`, so nothing stopped runaway fan-out (a
child starting children that start children), and nothing recorded who started,
messaged or stopped whom. Both follow the "contain the blast radius, keep a trail"
part of the per-child worktree / team stop work
([2026-11-16-agent-worktree-and-stop-design.md](2026-11-16-agent-worktree-and-stop-design.md)),
which listed child/depth caps as later work.

## Goals
1. `agent run` refuses, before any tab, worktree or branch is created, once a tab has
   too many live children, the chain is too deep, or the app holds too many relay agents.
2. Every relay event is appended to a local log a person (or the parent agent) can read
   with `agent log`.

## Non-goals
- No Settings UI for the limits (config file only for now).
- No caller identity tokens: the caller is still the `BBARIT_TERMINAL_ID` the CLI sends.
- No tamper-proof log (same-user processes can edit it), no log shipping.
- No limits on tabs opened by hand or with `term create`.

## Decisions
- **Where**: a pure `checkAgentRunLimits(links, caller, isLive, limits, pendingParents)`
  in `src/terminal/agentLimits.ts`, wrapped by `createAgentRunReservations` and called
  from App `agent.run` after the caller/prompt checks. The App passes
  `isLive = !exited && (pending || tab still open)`.
- **Limits** (config `agents`, `normalizeAgentLimits`: finite numbers truncated and
  clamped, anything else the default):
  - `maxChildren` 6 (1..32): live links whose `parentId` is the caller.
  - `maxDepth` 2 (1..5): depth of the new child. A tab with no relay parent is 0, its
    children 1, grandchildren 2; so by default a grandchild cannot start agents. The
    chain walk stops at an id it has already seen (cycle guard) and after 64 steps.
  - `maxTotal` 12 (1..64): every live link, callerless runs included.
  - A run with no caller is checked against `maxTotal` only. Order: depth, children, total.
- **Refusal**: `{ ok: false, error, limit }`; the text names the limit, the current
  count, the maximum and how to proceed, e.g. `child limit reached: this tab already
  has 6 live children (max 6; a stopped child still counts: close one with agent stop
  <id> --close, or raise agents.maxChildren)`. The CLI prints it and exits 1 (also with
  `--json`).
- **Atomic check**: `createAgentRunReservations().reserve(...)` checks and takes a slot in
  one synchronous step after the last `await` of `agent.run`; the slot counts like a live
  child of the caller until the child's link is stored (then the link counts) or the run
  fails (worktree error, no terminal), when it is released. Concurrent `agent run --bg`
  calls and `--worktree` jobs still running git therefore cannot pass together. A link
  counts as live while `pending` too, because a new tab reaches `projectsRef` only after
  a render.
- **Parent closed / restart**: when a parent tab closes its children's links are kept with
  `parentId: ''` and their recorded `depth` (`orphanAgentLink`), so they still count
  toward `maxTotal` and keep their depth; with `parentId ''` they get no notes and are
  nobody's child for list/stop/the stop-team button. Callerless and orphaned links are
  saved with the projects and restored the same way (parent gone → orphaned).
- **Not a security boundary**: `maxChildren`/`maxDepth` use the caller id the tab
  reports; a process can omit or fake it. They stop accidents (runaway fan-out).
  `maxTotal` counts every link whatever the caller and is the hard cap.
- **Log file**: `~/.config/octo/agent-relay.log` (directory from the existing
  `config_file_path()` helper), one JSON object per line, written by the async Rust
  command `agent_relay_log_append` in `src-tauri/src/agent_relay_log.rs`; read by
  `agent_relay_log_tail` (default 20, max 500 lines, reaching into the rotated file).
  Mode 0600 on unix. Before an append that would pass 1 MiB the file is renamed to
  `agent-relay.log.1` (replacing it). Entries over 8 KiB are dropped. A process-wide
  mutex orders appends and rotation.
- **Entries** (built by `buildAgentRelayLogEntry`, `src/terminal/agentRelayLog.ts`):
  `ts`, `event` (`run`, `run_refused`, `send`, `stop`, `exit`), `caller` / `target`
  `{ id, name, cliType }` when known, `depth`, `worktree` / `branch`, and for run/send
  `textLen` + `textHead` (first 120 characters after `oneLine`). Event extras:
  `run_refused` `reason`/`count`/`max`/`error`; `send` `ok`/`reason`/`force`; `stop`
  `ok`/`keys`/`closed`/`reason`/`by: "ctl" | "button"`. Never environment, tokens or
  full prompts.
- **Fire and forget**: the App never awaits the append and swallows errors, so a full
  disk or a missing directory never fails or delays a relay action.
- **Reading**: UI command `agent.log { tail }` and `bbarit-ctl agent log [--tail N]`
  (one readable line per entry, `--json` raw lines). When the app is not reachable, or
  is too old to know `agent.log`, the CLI reads the file directly.
- **Secretary**: every `agent.*` command, `agent.log` included, stays off the remote
  secretary allowlist; the existing Rust test now also fails if any allowed command
  starts with `agent.`.
- `agent.status` / `agent.list` rows carry `depth`; the CLI table shows a depth column
  when the app reports it.

## Left out
- Settings UI for `agents.*` (edit `~/.config/octo/config.json` or `config set
  agents.maxChildren 8`).
- Caller identity tokens: a process inside a tab can still claim another tab with
  `--caller`; the per-tab counts follow that claim, `maxTotal` still holds.

## Verification
- vitest: `agentLimits.test.ts` (normalize, depth with cycles, each limit, pending
  worktree runs, callerless runs, wiring order in App), `agentRelayLog.test.ts`,
  `schema.test.ts` (config default + clamp).
- node:test: `tests/bbarit-ctl-agent.test.mjs` (`agent log` parsing, file fallback,
  formatting, depth column).
- cargo: `agent_relay_log::tests` (one line per entry, 0600, rotation, tail across the
  rotated file) and `secretary_commands_deny_shell_reach`.
- Not verified in a running app (native check by the maintainer).
