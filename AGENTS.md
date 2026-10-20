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

The source allowlist is opensource/manifest.json. The exporter creates fresh
source directories and archives without Git history. It does not publish.
