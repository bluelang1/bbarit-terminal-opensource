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
  private key. Releases: bump with scripts/bump-version.mjs, then run
  `cargo update -p octo-ui --offline` in src-tauri or `--locked` fails; then
  `gh workflow run fork-release.yml --ref main -f tag=v<version>` (draft
  release; GitHub creates the tag when the draft is published). Never push
  the tag by hand: Actions caches are scoped per ref, so a tag-ref run never
  restores the Rust cache (~35 min cold); the first main run is cold too.
- The original installed app (com.octo.terminal, author-signed) cannot receive
  fork updates; only an installed fork build (com.bbarit.terminal.source) can.
- bbarit-ctl / tauri-dev-screen auto-scan accepts com.bbarit.terminal.source
  first and com.octo.terminal as fallback; BBARIT_BRIDGE_APP_ID pins one.
- Claude Code stores sessions in ~/.claude/projects/<cwd with every
  non-alphanumeric char replaced by "-">/*.jsonl; src/terminal/claudeSessionDir.ts
  probes it so `--continue` is only added when a transcript exists (sessions
  relocated with CLAUDE_CONFIG_DIR are not detected, so resume is skipped).
- "Claude (new session)" tabs carry TerminalInstance.claudeSessionId (uuid) and
  launch `claude --session-id <id>` first, `--resume <id>` afterwards; plain
  Claude tabs keep the shared `--continue` behavior.
- Terminal drops insert quoted paths + a space and never press Enter
  (insertDroppedPaths in XTerminal.tsx); paste keeps its own submit rules.
- `vite build` needs a ~5 GB Node heap (peak RSS 4.8 GB); on the 7 GB macOS
  CI runner set NODE_OPTIONS=--max-old-space-size=5120 or it aborts with OOM.
- Full-screen TUIs (Claude `tui: fullscreen`, alt buffer) scroll through the wheel
  bridge in XTerminal.tsx, not xterm scrollback; tick math lives in
  src/terminal/wheelTicks.ts (accumulate trackpad pixels, one tick per notch).
- Plain `#[tauri::command] fn` runs on the main thread; any subprocess or network
  work in it freezes the whole UI. Use `#[tauri::command(async)]` or a thread.
- PTY env is built twice (create_shell, create_cli_shell in main.rs); change both.
  create_cli_shell has no frontend caller today.
- Per-tab GitHub account: create_shell sets GH_TOKEN from Project.githubAccount >
  ~/.config/octo/github-accounts.json `owners` > owner==gh login (local only); org
  detection (`gh api user/orgs`) runs in the background and caches hits to that file.
  gh accounts come from ~/.config/gh/hosts.yml; never return or log tokens.
- Project edit reuses the new-project modal (editingProjectId); save logic lives in
  src/projectEdit.ts. Category is forced to `coding` on load/save.

The source allowlist is opensource/manifest.json. The exporter creates fresh
source directories and archives without Git history. It does not publish.
