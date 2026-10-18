# Third-party code & patterns

## brew-browser (MIT)

Some backend infrastructure patterns were adapted from
[msitarzewski/brew-browser](https://github.com/msitarzewski/brew-browser)
(MIT License, © 2026 Michael Sitarzewski):

- `src-tauri/src/common.rs` — `resolve_tool_path` / `nvm_node_bin_dir`: the
  "check known install prefixes before PATH" approach for locating a CLI from a
  GUI-launched app, adapted from brew-browser's `resolve_brew_path`.
- `src-tauri/src/main.rs` — `atomic_write`: the parent-directory `fsync` after
  rename (durability of the rename itself) mirrors brew-browser's `util/fs.rs`.
- `.gitleaks.toml` — secret-scanning config modeled on brew-browser's.

These are pattern re-implementations, not verbatim copies. The MIT license
requires the copyright notice be retained; it is reproduced below.

```
MIT License

Copyright (c) 2026 Michael Sitarzewski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
