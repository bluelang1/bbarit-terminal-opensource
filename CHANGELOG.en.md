# Changelog

User-visible changes in this fork (bluelang1/bbarit-terminal-opensource), by version.
English mirror of [CHANGELOG.md](CHANGELOG.md) (Korean); both list the same versions and entries.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).
The same notes appear on the [GitHub Releases](https://github.com/bluelang1/bbarit-terminal-opensource/releases) page.

A PR with a user-visible change adds a Korean line to CHANGELOG.md and the same line in English here, under [Unreleased]. Groups: Added, Changed, Removed, Fixed, Security.

## [Unreleased]

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

[Unreleased]: https://github.com/bluelang1/bbarit-terminal-opensource/compare/v1.1.67...HEAD
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
