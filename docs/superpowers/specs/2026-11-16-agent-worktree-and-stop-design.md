# Agent relay: per-child worktree and team stop

## Why
Two ideas taken from Anthropic's "Safely scaling multi-agent teams" write-up, scaled
down to a desktop terminal: (1) each agent works on its own branch and never writes
to main directly; (2) when something goes wrong the whole team can be stopped and a
person looks. Today relay children work in the caller's folder (edits collide) and
there is no way to stop them short of closing tabs one by one.

## Goals
1. `agent run --worktree [name]`: the child gets its own git worktree and branch.
2. `agent stop`: interrupt one child or all of the caller's children; a "stop team"
   button in the UI interrupts every relay child.

## Non-goals
- No sandboxing, network limits or tool-call classifier (Claude Code's own permission
  system stays the gate).
- No automatic merge, push or worktree deletion. A person reviews the branch.
- No shared task board, identity tokens or child/depth caps (later work).

## Approaches
- Worktree: (a) app creates it in `agent.run` (picked: one place, reuses the existing
  `git_worktree_add` command, the path is known to status/list); (b) ctl creates it
  with git before calling `agent.run` (no app knowledge of it); (c) tell the child to
  create its own (unreliable).
- Stop: (a) interrupt the agent and keep the tab (picked: output stays readable, the
  child can be resumed with `agent send`); (b) close the tab (loses the transcript;
  offered only as `--close`).

## Design
### Worktree
- `agent run … --worktree [name]` → `agent.run` param `worktree: true | "<name>"`.
- Base repo = git top-level of the child's work dir (`--workdir`, else the caller's
  project path). Not a git repo → error, nothing is started.
- Location and naming follow whatever the existing Orchestra worktree code already
  uses if it fits; otherwise `<repo>/.bbarit/worktrees/<slug>` with the directory
  kept out of `git status` via `.git/info/exclude` (never edit the user's .gitignore).
  Branch `agent/<slug>` from the repo's current HEAD; slug from the name or the child
  name, made unique.
- The child starts in the worktree. Its first message adds: work only in this
  folder, commit on this branch, do not push, merge or switch branches.
- `agent status/list` rows carry `worktree` and `branch`; the done/blocked note to
  the parent names the branch so the parent can review or merge it.
- Nothing is removed automatically (closing the tab keeps worktree and branch).

### Stop
- `agent stop [<terminalId> | --children] [--close]` → `agent.stop`
  (`terminalId?`, `caller?`, `close?`). Without an id: all children of the caller
  (not grandchildren unless they are the caller's own).
- Stopping = drop that terminal's queued automatic input, then send the interrupt
  key for its CLI (what a person would press), as a clicked-action style write that
  does not wait for quiet. The tab and transcript stay. `--close` closes the tab.
- The link is marked stopped: no further automatic notes are typed into a stopped
  child's parent for that turn beyond one `state=stopped` note.
- UI: a "stop team" button, visible only while relay children exist and at least one
  is working, stops every relay child in the app. Tooltip ko/en.
- `agent.stop` stays off the remote secretary allowlist like the other `agent.*`.

## Left to the builder
Exact interrupt bytes per CLI, button placement and icon, slug rules, i18n keys.

## Verification
Unit tests for the pure parts (slug/branch naming, which terminals a stop targets,
note text), existing relay tests stay green, npm test/build, cargo test, audit.
Native behaviour (child really starts in the worktree, interrupt really stops
Claude/Codex) is checked in the dev app before release.
