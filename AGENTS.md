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

The source allowlist is opensource/manifest.json. The exporter creates fresh
source directories and archives without Git history. It does not publish.
