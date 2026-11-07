# BBARIT Terminal contributor guide

Read README.md, CONTRIBUTING.md, SECURITY.md, THIRD_PARTY.md, and
THIRD_PARTY_NOTICES.md before changing this React + Tauri desktop application.

- src/ contains the React interface; src-tauri/ contains the Rust host.
- bbarit-agent/ is the embedded agent, including its required vendor/semble crate.
- agent-browser-cli/ and bundled skills/personas are part of the application.
- Do not replace the embedded agent with the separately maintained agent OSS.
- Preserve unrelated work and runtime resources; keep third-party notices intact.
- Use the public development/build scripts. Do not restore production signing,
  updater endpoints, release uploads, or copied private Git history.
- Never commit API keys, tokens, browser profiles, user projects, databases,
  generated output, signing material, logs, or local verification captures.
- The app can execute commands and control browsers. Run it only when needed
  for the requested work, using an isolated project and local test data.
- Native platform claims require verification on that platform; a web build
  does not establish installed macOS or Windows behavior.

Useful source checks:

    python3 -B -m unittest discover -s tests -p 'export_opensource_test.py' -v
    python3 -B scripts/export-opensource.py --audit
    npm run test:run
    npm run build
    npm run check:bundled-scripts
    cargo test --manifest-path bbarit-agent/Cargo.toml --locked   # ~370 tests, seconds once built
    cargo test --manifest-path src-tauri/Cargo.toml --locked      # ~120 tests; first build ~3 min
    cargo test -p tauri-plugin-mcp-bridge --lib --manifest-path src-tauri/Cargo.toml  # vendored plugin guard

Build/test gotchas:

- src-tauri needs `cmake` on PATH (whisper-rs build script); `brew install cmake`.
- `npm run test:run` prints jsdom "HTMLCanvasElement.getContext not implemented"
  stack traces from xterm; they are noise, check the pass/fail summary.
- ESLint has rules-of-hooks, exhaustive-deps, and no-unused-vars disabled; a
  clean lint does not mean hook usage is correct.
- src-tauri/src/{pty,gateway,config,shannon}.rs are not in the `mod` tree of
  main.rs; edit main.rs, not those files.
- New scripts referenced from package.json or tauri resources must be added to
  opensource/manifest.json `extra_files`, or `--audit` fails.
- Local bridges (browser_bridge.rs, design_http.rs) are wrapped in
  `with_local_guard`: native clients must send no Origin; webview origins are
  allowlisted in `local_origin_allowed`.
- Upstream remote `upstream` = johunsang/bbarit-terminal-opensource; fork main
  shares ancestry with it, so `git merge upstream/main` works normally.
- Keep index.html free of inline <style>/<script>: Tauri adds a CSP nonce to
  them, which disables 'unsafe-inline' and breaks JS-injected styles in release.
- srcdoc previews inherit the webview CSP (src-tauri/tauri.conf.json); do not
  tighten script-src/style-src without moving previews to the design server.
- Product URLs come from src/config/endpoints.ts (VITE_BBARIT_*); do not add
  bbarit.com literals elsewhere. Local ports: bridge 19980/19981, design
  19985/19986, collab 19990, mcp-bridge 9223/9323.
- tauri-plugin-mcp-bridge is vendored (src-tauri/vendor); upgrade by re-copying
  the crate and re-applying `upgrade_allowed` in websocket.rs.
- Fork auto-update: `npm run tauri:build:fork` layers src-tauri/tauri.fork.conf.json
  (fork minisign pubkey + GitHub latest.json endpoint) on the source config and
  keeps only TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) in the env; never commit the
  private key. Every user-visible PR adds a Korean line under CHANGELOG.md
  `## [Unreleased]` (추가/변경/제거/수정/보안). Releases: bump with
  scripts/bump-version.mjs, which moves [Unreleased] into
  `## [X.Y.Z] - YYYY-MM-DD` and fixes the compare links (warns if empty;
  `--date`, `--no-changelog`), then run
  `cargo update -p octo-ui --offline` in src-tauri or `--locked` fails; then
  `gh workflow run fork-release.yml --ref main -f tag=v<version>` (draft
  release; body = that CHANGELOG section via scripts/changelog-section.mjs +
  .github/release/notes-header.md + generated PR list; a missing section
  only warns; GitHub creates the tag when the draft is published). Never push
  the tag by hand: Actions caches are scoped per ref, so a tag-ref run never
  restores the Rust cache (~35 min cold); the first main run is cold too.
- The original installed app (com.octo.terminal, author-signed) cannot receive
  fork updates; only an installed fork build (com.bbarit.terminal.source) can.
- bbarit-ctl / tauri-dev-screen auto-scan accepts com.bbarit.terminal.source
  first and com.octo.terminal as fallback; BBARIT_BRIDGE_APP_ID pins one.
- Claude Code stores sessions in ~/.claude/projects/<cwd with every
  non-alphanumeric char replaced by "-">/*.jsonl; src/terminal/claudeSessionDir.ts
  probes it so `--continue` is only added when a transcript exists. It looks
  under $CLAUDE_CONFIG_DIR/projects when that is visible to the app process or
  ~/.config/octo/.env (read_env_var); a shell-rc-only export is not seen.
- "Claude (new session)" tabs carry TerminalInstance.claudeSessionId (uuid,
  claudeSessionSource 'app') and launch `claude --session-id <id>` first,
  `--resume <id>` afterwards; plain Claude tabs keep the shared `--continue`.
- Claude tabs launch with `--settings <bundled bbarit-session.json>` whose
  SessionStart hook POSTs the session id to `/api/claude-session`
  (src-tauri/resources/claude-hooks/); the id is stored with source 'hook' and
  resumed only when resumeLastSession is on. PTYs carry BBARIT_TERMINAL_ID /
  BBARIT_BRIDGE_PORT / BBARIT_CLAUDE_HOOK. Never write ~/.claude/settings.json.
- Terminal drops insert quoted paths + a space and never press Enter
  (insertDroppedPaths in XTerminal.tsx); paste keeps its own submit rules.
- `vite build` needs a ~5 GB Node heap (peak RSS 4.8 GB); on the 7 GB macOS
  CI runner set NODE_OPTIONS=--max-old-space-size=5120 or it aborts with OOM.
- Full-screen TUIs (Claude `tui: fullscreen`, alt buffer) scroll through the wheel
  bridge in XTerminal.tsx, not xterm scrollback; tick math lives in
  src/terminal/wheelTicks.ts (accumulate trackpad pixels, one tick per notch).
- Plain `#[tauri::command] fn` runs on the main thread; any subprocess or network
  work in it freezes the whole UI. Use `#[tauri::command(async)]` or a thread.
- PTY env and shell choice live in `pty_backend::build_shell_command` (pure, deps
  injected, snapshot-tested); `create_shell` only builds deps and calls the backend.
  All PTY Tauri commands forward to `AppState.pty: Arc<dyn PtyBackend>`.
  `create_cli_shell` was removed (no caller). Design: docs/PTY_HOLDER_DAEMON.md.
- Per-tab GitHub account: create_shell sets GH_TOKEN from Project.githubAccount >
  ~/.config/octo/github-accounts.json `owners` > owner==gh login (local only); org
  detection (`gh api user/orgs`) runs in the background and caches hits to that file.
  gh accounts come from ~/.config/gh/hosts.yml; never return or log tokens.
- PTY holder reattach: XTerminal asks src/terminal/ptyRecovery.ts (loaded from
  pty_list_recovered before applyRestoredProjects); recovered ids skip deferStart,
  create_shell and every startup-command injection. Holder isRestored = in that list.
- Quit with the holder: GOODBYE from exit_goodbye_reason (menu kill_all > update
  handover > terminal.keepRunningOnQuit, true by default, debug builds only if explicit).
- Project edit reuses the new-project modal (editingProjectId); save logic lives in
  src/projectEdit.ts. Category is forced to `coding` on load/save.
- Agent status comes from OSC 7501 (Claude Code >= 2.1.295 probes `ESC]7501;?`;
  XTerminal answers and feeds `agentStatus`). Terminals that have reported 7501
  skip the idle-timer done toast. Design: docs/AGENT_STATUS_OSC7501.md.
- Never write into a user PTY directly from new features; use `queueAutoInput`
  (src/terminal/inputGate.ts): refuses while blocked unless `force`, waits for
  3 s of human quiet, bracketed paste, Enter sent separately. `force: true` only
  for actions the user just clicked; `submit: false` sends raw bytes. Design:
  docs/AGENT_INPUT_GATE.md.
- Re-attaching a terminal replays saved PTY output through the parsers with
  `replayingOutput` set; output-driven handlers must not alert or reply during it.
- `bbarit-ctl term write` waits up to 40 s (gate) and takes `--force`.
- Every PTY gets `BBARIT_TERM_SCOPE=<ms>-<hex>`; closing a tab (and app exit) sweeps
  processes still carrying that token, even after setsid/nohup reparenting. Daemons
  in `scope_sweep_excluded` (tmux, pm2, Electron/Code, colima, docker, ollama…) are
  spared; start anything else that must outlive the tab with `env -u BBARIT_TERM_SCOPE`.
  macOS hides Apple platform binaries' environ, so /bin/sleep-style leftovers are
  not swept. Design: docs/TERMINAL_SCOPE_SWEEP.md.
- Button-click terminal sends use `queueButtonInput` (src/terminal/buttonInput.ts):
  force, no quiet wait, but still queued/bracketed. `setsid` does not exist on macOS;
  use `(cmd &)` double-fork when a test needs a process outside the PTY tree.
- Dev app vs installed app: both binaries are named `octo-ui`; the dev build has no
  bundle id, so `osascript quit app "octo-ui"`, `tell application id
  "com.bbarit.terminal.source"`, `pkill/killall octo-ui` hit the user's own app (and
  the Claude session inside it). Address the dev app only by pid from
  `pgrep -f 'src-tauri/target/debug/octo-ui$'`; quit it with
  `npm run ctl -- --port 9323 js "window.__TAURI__.core.invoke('plugin:process|exit')"`
  (normal quit path, keeps held terminals); System Events keystrokes are blocked by TCC.
- PTY holder: release builds default `terminal.ptyHolder` on and `keepRunningOnQuit` true
  (only `"off"`/false disable); debug builds need explicit `"on"`/true in
  ~/.config/octo/config.json (shared with the installed app: back up and restore).
  macOS spawns it as a one-shot launchd job `com.bbarit.terminal.pty-holder[.dev].<id>`
  (Linux systemd-run, setsid fallback; `BBARIT_PTY_HOLDER_SPAWN=setsid` forces it);
  finished jobs stay listed as `- 0 <label>` and are booted out later, never a live pid.
  Socket/log/info: ~/.config/octo/run/pty-holder[.dev].<id>.{sock,log,json}.
  `pty_backend_info` (ctl js) reports kind, spawnMethod, fallback reason and `holders[]`;
  `app_quit_kill_terminals` stops everything (`GOODBYE kill_all`); `app_relaunch_for_update`
  sends GOODBYE handover then restarts (8 s watchdog respawn). A holder with another
  protocol version is attached + DRAINed and a new one spawned; debug builds can force
  this with `BBARIT_PTY_HOLDER_PROTO_VERSION=<n>`. Holder exe must be replaced by a new
  inode (cargo/mv/codesign are; in-place `cp` gets SIGKILL). The holder survives app
  death and the BBARIT_TERM_SCOPE sweep; `dev:screen:start`'s sweep skips `--mode pty-holder`.
- PRs are squash-merged: a branch stacked on a merged branch needs
  `git rebase --onto main <old-base-sha>` or it carries duplicate commits.
- Agent relay: tabs can run `node "$BBARIT_CTL" agent run|send|wait|status|list`
  (docs/AGENT_RELAY.md). Children open as background tabs in the caller's project with
  their own Claude session; blocked/done/exit notes are typed into the parent as one
  `<bbarit from=… state=…>` line through the input gate (never into plain shells).
  `agent.*` stays off the remote secretary allowlist. Dev builds resolve BBARIT_CTL from
  CARGO_MANIFEST_DIR, so a shared CARGO_TARGET_DIR still points at the right checkout.

The source allowlist is opensource/manifest.json. The exporter creates fresh
source directories and archives without Git history. It does not publish.
