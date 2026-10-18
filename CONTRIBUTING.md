# Contributing

The application consists of the React interface (`src/`), Tauri host (`src-tauri/`), embedded Rust agent (`bbarit-agent/`), and browser-control CLI (`agent-browser-cli/`). Preserve the vendored Semble crate, bundled personas, skills, and resources; they are required by the build. The separately maintained agent OSS project is not a replacement for this embedded agent.

Install the Node version required by `package.json`, a current Rust toolchain supporting edition 2024, and the native Tauri prerequisites for your OS. Start with:

```sh
npm ci
npm run test:run
npm run build
npm run check:bundled-scripts
npm run test:source-build
```

Use `npm run tauri:dev` and `npm run tauri:build` for native development/builds. They use the public build wrapper. Do not restore the original production signing configuration or automatic release/update channels. Verify native changes on each affected platform before claiming platform support.

Keep changes focused, preserve unrelated work, and add meaningful regression coverage for changed behavior. Retain copyright notices and license files when modifying imported code or bundled resources. Do not commit generated output, local credentials, browser profiles, databases, installers, or private history.

Source export tools require Python 3.11 or newer:

```sh
python3 -B -m unittest discover -s tests -p 'export_opensource_test.py' -v
python3 -B scripts/export-opensource.py --audit
```

Use `-B` when checking a clean export to avoid creating bytecode caches in it. Export to a new directory, review the included files, then run `--check` before starting a new Git history. The tool does not publish or push anything.

The root MIT license applies to original project code. Consult `THIRD_PARTY.md`, `THIRD_PARTY_NOTICES.md`, and `licenses/` for imported components and separately installed dependencies. Changes do not waive upstream terms or external service requirements.
