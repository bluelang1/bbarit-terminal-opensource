# Changelog

User-visible changes in this fork (bluelang1/bbarit-terminal-opensource), by version.
English mirror of [CHANGELOG.md](CHANGELOG.md) (Korean); both list the same versions and entries.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).
The same notes appear on the [GitHub Releases](https://github.com/bluelang1/bbarit-terminal-opensource/releases) page.

A PR with a user-visible change adds a Korean line to CHANGELOG.md and the same line in English here, under [Unreleased]. Groups: Added, Changed, Removed, Fixed, Security.

## [Unreleased]

### Added

- Agent relay `agent run --worktree [name]`: a child agent works in its own git worktree (`<repo>/.bbarit/worktrees/<name>`) on a new branch `agent/<name>`, so several children no longer overwrite each other's edits in one folder, and the child is told to only commit on that branch and not to push, merge or switch branches. `agent status`, `agent list` and the notes typed into the parent show the branch, and the worktree folder is kept out of `git status` through the repo's `.git/info/exclude` (`.gitignore` is not touched). Outside a git repository no tab is opened and an error is returned; worktrees and branches are never deleted automatically.
- Agent relay `agent stop [terminalId | --children] [--close]` and a stop-team button in the top bar: interrupt one child agent or all of your children with the interrupt key a person would press (Esc for Claude and bbarit, Ctrl+C for shells and ollama). CLIs whose interrupt key is not confirmed (Codex, Gemini, …) get no key and the result says so; only `--close` stops them by closing the tab. Automatic input queued for that tab is dropped first, so a waiting note cannot set the child going again, and the tab and its output stay so you can continue with `agent send` (`--close` also closes the tab). The red stop-team button appears next to the bell and window-pin buttons only while a relay child it can interrupt is working; it stops every relay child that is working or waiting for input the same way and types nothing into the parent tabs. `agent run --worktree` now creates the worktree in the background in the app while `bbarit-ctl` waits up to 120 s.
- Agent relay safety limits and an audit log: so children starting children cannot fan out without end, `agent run` refuses past 6 live children per tab, depth 2 (grandchildren) or 12 relay agents in the app, creates no tab or worktree, and says which limit was hit and what to do (adjust with `agents.maxChildren`, `maxDepth` and `maxTotal` in the config file). Who started, messaged and stopped whom, and refused runs, are written one line each to `~/.config/octo/agent-relay.log` (only the first 120 characters of a prompt, rotated every 1 MiB) and shown by `agent log [--tail N]`; `agent status` and `agent list` show each child's depth.
- Agent relay team board `agent board post|read|teams|clear`: one relay team (the tab that started the first agent plus every agent below it) now shares a board. Agents post findings, decisions, questions and done summaries (`--kind`, up to 2000 characters / 40 lines) and read it when they choose with `agent board read --new`, which shows only teammates' posts they have not seen yet, oldest first (it says when more are unread; the whole board can be filtered by kind, author or search text). A post is never typed into any tab, and the read output is headed as notes from teammate agents, not instructions. Child agents are told to read the board when they start and to post their results. Boards are stored in `~/.config/octo/agent-board.db` (SQLite, open it with `sqlite3`), keeping the latest 5000 posts per team; a board with no post or task change for 30 days is deleted when the app starts. Clearing a board (`agent board clear`) works only inside the team's root tab (refused when the calling tab is not verified).
- Agent relay team tasks `agent task add|list|show|claim|done|…`: the team board now has a task list next to it. Anyone adds tasks and the first tab to claim one (`claim`, or `--next` by priority) owns it, so two children no longer do the same work. A task moves from open → claimed ⇄ blocked → (review) → done, failed or cancelled, and every change is kept in its history (`show --history`). Finishing a task with a one-line summary and its branch, commit and check result posts a done note on the board automatically; a task can wait for others (`--after`), need another tab's approval (`--review`), and be retried a set number of times after it fails. The app holds a claim while its tab is open, hands it back as soon as the tab closes or its program exits, and if the app dies another tab can take it after about 5 minutes (`agents.board.leaseSeconds`, `renewSeconds`, `staleMinutes` in the config file). The root tab can pin a team-wide note with `agent board post --kind announce`, and posts can be linked to a task with `--task <n>`. Child agents are told how to claim and finish tasks. The board file is converted to the new format on first open with its data kept; app versions before this one do not open the converted file.
- Choose where the agent team board is stored (Settings → Agent → Agent team board): usage type "SQLite only" (default, a file on this computer), "Both (sync)" (works like SQLite only until the next update) or "PostgreSQL only" (several computers share boards on one server). It has PostgreSQL connection fields (host, port, database, user, SSL mode, schema), a password that is saved but never shown again (`~/.config/octo/agent-board.secret`, 0600, never in config.json), Test connection (server version, TLS, schema version, privileges and what to do next), "Create / upgrade tables" that shows the statements before running them, "Copy data" in a direction you choose that never deletes the source (into an empty board, or merging teams that are not there yet), "Clean up old teams" for the server that shows how many first and asks to confirm, and a status line. Connection fields change only when you press Apply, and the password is only sent to the server it was saved for. When the server cannot be reached only board commands fail with `team board unavailable: …` and the rest of the relay keeps working; it never silently falls back to SQLite. Tables are created only from the button. `BBARIT_BOARD_DATABASE_URL` (environment or `~/.config/octo/.env`) replaces the connection fields. Agents cannot read or change these settings through `config get|set`.
- Team status view (the gauge button in the top bar): the gauge overlay now has tabs [Team status | Dashboard] and remembers the last one. Team status shows one team's "Needs you" list (approve or reject a review with a required reason, retry a failed task, agents waiting for an answer, blocked and stale work), a state bar with counts and a 2-hour done trend, each agent's state and held tasks (click to go to its tab; nothing is typed), a task board grouped into five columns and a list (filter by state, agent, label, search), task details (body, result, dependencies, history, and approve, reject, retry, reopen, edit, cancel after a confirmation), an activity feed with a note box, and relay limit usage with the last hour of `agent run` refusals (time, limit and calling tab only, read from the audit log). What a person does is recorded with author "user", and a person never claims or finishes a task. The gauge button and project tabs carry a badge with the number of items that need you, and projects with a team get a Team status button next to the stop-team button. When the team board is unavailable the last snapshot stays, greyed, with Retry and Open Settings. The layout adapts to the window width (wide, medium, narrow). A Dependencies tab draws what waits on what (hovering or focusing a task lights its whole chain, arrow keys move between tasks, a click opens it) and switches to a collapsible list when there are too many tasks, the chain is too long, tasks wait on each other or the window is narrow. A Timeline tab shows all tasks against done over time and how long each task sat in each state (with the median time in review and blocked); every chart can be shown as a table. "Open in its own window" puts Team status in a small window you can pin on top; it follows the theme of the project that owns the team, and approving, rejecting and the other actions work there too. The getting-started guide has a Team status step.
- Agent team board sync (usage type "Both (sync)"): the board is written to this computer's file as before, and whenever the PostgreSQL server is reachable the app sends this computer's teams and receives other computers' teams every 30 s (2 s after a write). Board commands keep working offline, and changes made offline (deletions included) are sent once the server is back. Other computers' teams appear in Team status under "Other computers (read-only)": reading, search and history work, every write by an agent or a person is refused with "this team lives on <name>; it is read-only here", and they never count for the needs-you badges. Computers in "PostgreSQL only" cannot write a syncing computer's team either. Settings gains a "Computer name" field, the sync state (on, paused, offline, server busy, last sent and received, changes waiting, rows skipped, rows the server refused with the reason, last error), "Sync now" and "Remove other computers' teams" (only with sync off; asks first; removes them from this computer only), and the Team status Computers card shows the same state. When another computer already uses the name, the board file was copied to another computer, or this computer's name changed while its teams carry the old one, sync pauses and says what to do. Rows received from the server go through the same checks as local input; rows that fail are counted and not written. The PostgreSQL tables move to version 3, so with "PostgreSQL only" or "Both (sync)" press "Create / upgrade tables" in Settings once after updating.

### Fixed

- Terminal copy: text selected by dragging some time ago no longer returns to the clipboard. While a selection stayed on screen, any click in the app copied it again over whatever was copied since, and Cmd/Ctrl+C or a right-click just after a program that owns the mouse (such as Claude Code) had copied something put a much older selection there instead. A selection is now auto-copied once, when it changes, and is forgotten when it is cleared.
- Agent tab status dot: right after a program such as Claude Code starts in a tab and before it reports its state, screen repaints alone no longer turn the dot green (working). The app also keeps the last 30 status events per tab for troubleshooting.
- When Claude Code's Enter is rebound to newline (`chat:newline` in `keybindings.json`), agent relay briefs, `agent send`, notes and other automatic input were only pasted into the input box and never submitted. Claude tabs now get the submit key configured in Claude Code (Shift+Enter or Cmd+Enter). When that key also dismisses the autocomplete menu, input that starts with `/` or ends with an `@` mention gets a second press so it really runs. If submit is bound only to a key the app cannot send, `agent run` and `agent send` show a warning.

### Security

- The agent relay now checks which tab is calling: every tab gets its own token (`BBARIT_TERM_TOKEN`), and `agent run`, `send`, `wait`, `status`, `list` and `stop` accept a caller tab only when its token matches. One tab can therefore no longer act as another tab by passing that tab's id with `--caller` or an environment variable (so the agents it starts are not linked to that tab or counted against that tab's limits), and `--caller <id>` alone no longer works (that tab's token is needed too). Requests sent without a caller (for example `agent stop <childId>`) work as before. Tabs opened before the update keep working while they still run in the PTY holder; otherwise open the tab again. Refused calls are written to the audit log. This does not stop a malicious program running as the same user.

## [1.1.71] - 2026-11-13

### Added

- Window pin: new buttons next to the bell in the top bar. The pin keeps the main window above other windows, and while it is on the app's other windows (guide, tool windows, detached terminals) stay on top too so they never open behind it (the desktop pet is unchanged). On macOS a stacked-windows button also makes the main window follow you to the desktop (Space) you switch to (it is on one desktop at a time and arrives behind that desktop's windows; turn the pin on as well to keep it in view while you move). Both are off by default, stay as you left them after a restart, and are also under Settings > Terminal > Window.

## [1.1.70] - 2026-11-12

### Added

- Move between screen regions by keyboard: F6 moves focus through the top bar, toolbar, project list, sidebar, editor, terminal header and tabs, terminal, right quick-command buttons, open panel, prompt library and bottom status bar, and Shift+F6 goes the other way. It works inside a terminal, so you can leave a terminal without the mouse, and each region puts focus back where you last were (or on the selected project or tab). Once you leave, the terminal no longer pulls focus back; clicking it, F6 back into it, a hint pick, a project/tab switch shortcut, or Enter/Space on a project or terminal tab returns to it. Tab walking the screen skips terminal inputs (Tab inside a terminal still completes in the shell). On Mac laptop keyboards you may need Fn+F6. The keys are listed in Settings > Shortcuts; while the feature is on F6 is not passed to terminal programs, and switching it off there sends F6 / Shift+F6 to the terminal as before (mc, htop, nano).
- “Codex (new session)” in the add-AI-terminal menu and the command palette. Even with "Resume Last Session" turned on in Settings, this tab never picks up the folder's latest Codex conversation (`codex resume --last`); it always starts a new one, and tabs are named like “Codex (new session) 1”. After an app restart the tab starts a new conversation again (unlike Claude, Codex offers no way to pin a session to a tab and resume it). Codex child tabs started by the agent relay start the same way, so they no longer pick up the parent's conversation.

### Fixed

- After changing the terminal font size or the window size, Claude Code's status line and bottom lines could stay blank until Ctrl+L. They now redraw.
- Starting with this version, folder access permissions (Documents, Desktop, Downloads) survive app updates. Until now macOS forgot them on every update, so terminals in `~/Documents` failed with `Operation not permitted`. The first update onto this version asks for the permission once more.
- Hint mode: on small icon buttons (the toolbar and the terminal pane buttons) the label box now sits centred just below the button (above it when there is no room) instead of covering the icon, so you can tell which button each label belongs to.
- AI tool tabs no longer print a false "CLI not found" message when the tool is installed but exits with an error (for example when it cannot read the current folder). The message now appears only when the tool is really not installed, and the tool's own error stays visible.
- Hint mode: picking the terminal layout, Office or tool (☰) menu now puts keyboard focus inside it. Arrow Up/Down and Home/End move between items, Enter/Space choose, and Esc closes the menu and returns focus to the terminal you were using. Keys pressed while the menu is open no longer reach the terminal.
- In confirmation dialogs, Enter no longer confirms while the Cancel button has focus. When a dialog opens, focus now moves to one of its buttons (Cancel for actions that cannot be undone, such as deleting; otherwise the confirm button); Enter and Space press the focused button, Tab stays inside the dialog, and Esc cancels. When the dialog closes, focus goes back to where it was (usually the terminal).
- In the tabs view, the Tab key no longer moves into the input and buttons of terminal tabs that are not on screen. Tab now only visits the terminal you can see.
- The Tab key now moves through the top toolbar in the order the buttons appear on screen, left to right. Before, it jumped around, starting at the hide-toolbar button on the far right. The button layout is unchanged.

## [1.1.69] - 2026-11-12

### Added

- Keyboard hint mode: press ⌘J (Alt+J on Windows/Linux) and a yellow label appears on projects, terminal tabs, terminal panes and panel/view switches (sidebar, editor and terminal show/hide, view modes, toolbar panel buttons, settings and similar); type the label to go there. Picking a terminal pane puts the cursor in that terminal. Ordinary action buttons such as close or delete get no label. With many targets some labels are two characters; Backspace removes one, and Esc or the same shortcut closes hint mode and returns focus to the terminal. Works while the Korean input method is on; Settings > Shortcuts picks the style (raised, flat, dark, colour by kind) and size (small, normal).

### Changed

- The next/previous project shortcuts (⌘⇧] / ⌘⇧[, plus Ctrl⇧] / Ctrl⇧[ on macOS) now follow the project list as shown on screen instead of most-recently-used order. Next is the project below (to the right in the top tabs), previous the one above, wrapping around at the ends; projects inside a collapsed group are skipped. The project number shortcuts (Ctrl+1~9 on macOS, Alt+1~9 on Windows/Linux) use the same on-screen order.

### Fixed

- Programs running in a terminal no longer keep drawing for the old column count right after the terminal font size changes, and the shell prompt no longer moves down a line (leaving blank lines behind) each time the font gets bigger or the window gets narrower. The new size is sent to the terminal immediately and the prompt stays in place.

## [1.1.68] - 2026-11-11

### Added

- The bottom status bar shows the selected project folder's disk size (DISK). It is measured once when you select the project; click it to measure again. The order is now CPU, MEM, DISK.

### Changed

- The bottom terminal strip (branch and change count per terminal) is now hidden by default. Turn on "Show bottom terminal strip" under Settings > Terminal > Display to bring it back; while it is off, git status is not read for it.
- The left project list now uses compact single-line rows so more projects fit on screen. The folder path moved to the row's hover tooltip, and the favorite, edit and close buttons appear on hover (favorite projects always show a star before the name).
- The left project list can be resized between 180 and 520 px by dragging its right edge, and the width is remembered across restarts. Double-click the edge to return to the default 260 px.
- Quick command buttons moved from the bottom bar into a button strip on the right side of each terminal, which never covers terminal text; full-screen TUIs (such as Claude Code's full-screen mode) also get the unused scrollbar space for text. The order is clear input, clear all input, rerun, clear terminal, then your own buttons, and they run in that terminal. Buttons with an empty command are hidden, and clear input has a new backspace icon.
- The last-command display moved from the top of the terminal (yellow text that covered terminal output) to the left of the bottom status bar. It shows the selected terminal's command, shortened when long, with the full command on hover.

### Fixed

- The last-command display (bottom bar, terminal tabs) no longer joins several inputs or shows startup commands and automated input. Shells show the line run with Enter; agent tabs (Claude and others) show the prompt actually submitted, whichever Enter key submits it, and text cleared without sending is dropped.
- The whole app no longer freezes when a very large repository (hundreds of thousands of files) is the selected project: the git status shown under the terminals kept running `git status` without pause. Git commands no longer block the thread that draws the window, terminal tabs in the same repository share one status read, and refreshes (terminal git status and the Git panel) only run again after the previous one finishes, waiting longer on slow repositories (up to 60 seconds). Reading the status no longer takes Git's lock file, so staging or committing does not fail with "index.lock" errors.

## [1.1.67] - 2026-11-08

### Added

- On a fresh install a getting-started guide opens so you can learn by doing: opening a project, AI terminals, status dots, keep running, Git and the desktop pet. The first launch after an update shows what is new, and both can be reopened from the Help menu at any time.

### Changed

- The macOS menu bar (app, Edit, Help) follows the language chosen in settings (Korean/English).

## [1.1.66] - 2026-11-07

### Fixed

- Pressing the update button no longer shows the "work will be interrupted" warning while the PTY holder is on. With the holder on, work continues across the update, so it updates right away; the warning only appears when the holder is off.

## [1.1.65] - 2026-11-07

### Added

- Added this changelog (CHANGELOG.md); the release page also shows that version's changes above the install guide.
- A button at the top right of the Git popup (next to refresh) opens the selected project's repository page (GitHub, GitLab, Bitbucket and more) in the browser.
- The terminal sends Cmd+Enter separately from Enter. Claude Code can use `cmd+enter` as its send key (works during Korean input too).

### Changed

- Every release also uploads a DMG without the version in its name (`BBARIT-Terminal-Source_aarch64.dmg`), so the README download link always points to the latest version.

## [1.1.64] - 2026-11-07

### Added

- Desktop pet: minimize or close the app window and a small pixel octopus wanders your desktop. It walks, sits and sleeps; you can drag it or pin it in place, and its right-click menu opens the app, pins, hides or quits.
- The pet shows the state of Claude and Codex tabs. It pulls out a laptop while working, says "done" when a task finishes, and waves with a speech bubble when approval is needed. Clicking the bubble or double-clicking the pet opens that tab.
- The pet's outfit and effects change with the seasons (petals, sunglasses, autumn leaves, scarf and snow) and special days (Pepero Day, Valentine's Day, White Day, Halloween, Christmas).
- Settings turn the pet on or off and choose its character and movement (wander/stay put). The weather display is off by default and asks for location permission when turned on.
- Put your own character in `~/.config/octo/characters/<id>/character.json` to use it as the pet.
- Help → Character Tour shows every look of the pet in turn.

### Changed

- On macOS the window's close (red) button hides the window instead of quitting. Click the Dock icon or double-click the pet to open it again.

### Fixed

- Fixed the window flickering when hovering a theme swatch in the edit-project window (left over in 1.1.63).

## [1.1.63] - 2026-11-06

### Fixed

- Fixed the whole window shaking and its border colour flickering when hovering the font or theme buttons in the new-project and edit-project windows.

## [1.1.62] - 2026-11-05

### Added

- Choosing "Custom" as the project font opens a list of installed fonts that you can search and preview.
- When reopening the app restores terminals slowly, a "Waiting for terminal recovery…" notice appears.

### Changed

- The default font prefers FiraCode Nerd Font Mono and falls back to the bundled Fira Code when it is not installed.
- Terminal recovery text (restored marks, the exited banner, notices and more) is translated into 8 languages.

### Removed

- Removed the GitHub star request popup in the bottom right corner.

### Fixed

- Fixed a project font set to "Custom" not being applied. Separate windows (agent terminals and others) use the custom font too, and a missing font falls back to the default.
- Fixed the app starting again when "Quit and End All Terminals" was pressed during an update restart.

## [1.1.61] - 2026-11-05

### Added

- Terminals keep running when you quit or update the app, and even when it crashes (default on macOS and Linux). Reopening reattaches to the running shells and Claude work; tabs that ended while the app was closed are marked "Exited", and Enter restarts the shell.
- Added "Quit and End All Terminals" to the menu. A normal quit leaves terminals running.
- Settings gained a switch for this behaviour and a status line, and a one-time notice explains it. Windows keeps the previous behaviour.

### Changed

- Agent relay parent and child tab links survive reopening the app, and completion notices are no longer duplicated.

## [1.1.60] - 2026-11-03

### Added

- Agent relay: a Claude tab can start other agent tabs in the same project with `node "$BBARIT_CTL" agent run|send|wait|status|list`, hand them work, and get a one-line notice back when they finish or get stuck. Child Claude tabs keep their own conversations.
- Claude tabs remember their own conversation. With "Resume last session" on in settings, the tab returns to that conversation next time (following it across `/clear` and `/compact`). Your `~/.claude/settings.json` is never touched.
- Closing a tab (or quitting the app) also cleans up background processes started from that tab. Resident programs such as tmux, pm2, Docker and ollama are left alone; start anything that must outlive the tab with `env -u BBARIT_TERM_SCOPE`.
- Pressing update while an agent tab is working or waiting for approval lists the work that would be interrupted and asks once more.

### Changed

- Input that buttons send to the terminal (prompt library, skills, saved commands and more) is also queued so it never mixes with other input.
- Claude config folders moved with `CLAUDE_CONFIG_DIR` are recognised (when the variable is visible to the app or set in `~/.config/octo/.env`).

### Fixed

- Fixed conversation history of Claude tabs not being saved when the app was started from inside Claude Code.
- Fixed tabs still showing "working" or "waiting for approval" after returning to the shell prompt.

## [1.1.59] - 2026-11-02

### Added

- Claude tab status: tabs, the sidebar and the project list show whether Claude is working, finished, or waiting for approval or an answer (Claude Code 2.1.295 or later). Approval requests always notify; finished work notifies only when you are looking elsewhere.

### Changed

- Input the app sends on its own (scheduled jobs, messenger integrations, `bbarit-ctl` and more) waits until you have stopped typing for 3 seconds and is held while Claude waits for approval. `bbarit-ctl term write` waits up to 40 seconds and `--force` sends right away.

## [1.1.58] - 2026-10-28

### Fixed

- Fixed full-screen TUIs (such as Claude Code's full-screen mode) jumping a long way on a small trackpad movement. A mouse wheel scrolls once per notch.

## [1.1.57] - 2026-10-22

### Added

- Per-project GitHub accounts: terminal tabs open with the `gh` account that matches the repository owner, so work and personal repositories work side by side without `gh auth switch`. Organization membership is detected and remembered automatically.
- The pencil button in the sidebar and the right-click "Edit project" change a project's path, name, theme, font and GitHub account.

### Changed

- Opening a new terminal tab no longer freezes the app.
- The Local/SSH buttons show which one is selected.

## [1.1.56] - 2026-10-21

### Changed

- The toolbar image button shows an outlined picture icon instead of a filled square.

## [1.1.55] - 2026-10-21

### Added

- Added a "Clear all input (all lines)" button below the existing clear-input button to wipe a multi-line prompt at once. Shell tabs and the like still clear a single line.

### Fixed

- Fixed Ctrl+E/Ctrl+U typing the letters `e`/`u` in the built-in bbarit agent's API key entry and picker screens.

## [1.1.54] - 2026-10-21

### Added

- Dashboard button: opens your own dashboard inside the app from the toolbar (also in the tools menu). Change its address in Settings > Hub or the dashboard address bar (default `http://localhost:3000`) and close it with Esc. The dashboard page is isolated so it cannot control the app.

### Changed

- Dropping files on a terminal types only the quoted paths and a space, without pressing Enter. Dropping an image on a bbarit agent tab attaches it as `@path`.

## [1.1.53] - 2026-10-21

### Changed

- Reordering projects works like kanban cards: the item follows the pointer, its old spot stays as a dashed outline, and it slides into the new spot when dropped. No text gets selected while dragging.

### Fixed

- Fixed files dragged from Finder onto a terminal doing nothing.

## [1.1.52] - 2026-10-20

### Added

- Added a "Claude (new session)" tab to the new terminal menu and the command palette. Its conversation never mixes with other Claude tabs in the same project and continues after reopening the app.
- Dragging the project list or the top tabs to reorder them pushes neighbouring items aside to show where the item will land.

### Changed

- `bbarit-ctl` and `tauri-dev-screen` connect to the installed fork app (`com.bbarit.terminal.source`) first and fall back to the original author's app.

### Fixed

- Fixed Claude tabs ending with "No conversation found" when "Resume last session" was on in a project where Claude had never run.
- Fixed the drop position of files dragged on macOS being miscalculated.

## [1.1.51] - 2026-10-20

The first release of this fork, based on the original author's `v1.1.50`.

### Added

- Fork-only auto-update: new versions come from GitHub Releases signed with the fork's own key, and install only when you press the update button.
- The server address, product notices (`off` turns them off), lounge and release repository can be changed at build time with `VITE_BBARIT_*` environment variables.

### Changed

- Moved the design server ports to 19985/19986 and the default collaboration port to 19990 so they no longer clash with the development bridge (19981).

### Security

- The local bridges (19980/19981) and the design server reject requests from origins other than the app's own screens. Before, any web page open in a browser could ask the app to run shell commands or write files.
- The app-control WebSocket rejects connections from browser web pages and external hosts, so a web page cannot run scripts inside the app.
- A Content Security Policy (CSP) on the app's screens blocks loading remote scripts.
- Git commands no longer accept branches, remotes, paths or URLs that look like options, and PM2 app names and SSH user/host input can no longer inject command arguments.
- The built-in agent reads `.mcp.json` and `.bbarit/models.json` only in trusted projects, and `/trust no` takes precedence over the app's auto-approve run option.
- Updated or replaced dependencies with known vulnerabilities and removed unused ones.

[Unreleased]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.71...HEAD
[1.1.71]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.70...v1.1.71
[1.1.70]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.69...v1.1.70
[1.1.69]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.68...v1.1.69
[1.1.68]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.67...v1.1.68
[1.1.67]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.66...v1.1.67
[1.1.66]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.65...v1.1.66
[1.1.65]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.64...v1.1.65
[1.1.64]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.63...v1.1.64
[1.1.63]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.62...v1.1.63
[1.1.62]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.61...v1.1.62
[1.1.61]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.60...v1.1.61
[1.1.60]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.59...v1.1.60
[1.1.59]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.58...v1.1.59
[1.1.58]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.57...v1.1.58
[1.1.57]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.56...v1.1.57
[1.1.56]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.55...v1.1.56
[1.1.55]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.54...v1.1.55
[1.1.54]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.53...v1.1.54
[1.1.53]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.52...v1.1.53
[1.1.52]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.51...v1.1.52
[1.1.51]: https://github.com/bluelang1/bbarit-terminal-opensource/releases/tag/v1.1.51
