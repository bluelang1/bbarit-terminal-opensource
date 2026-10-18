# Pi → Rust Port Gap Analysis (upstream v0.80.2)

Reviewed `earendil-works/pi` @ `622eca7` (v0.80.2) against the `bbarit-agent` Rust port. Upstream: \~108k LoC TS across 5 packages (`ai`, `agent`, `coding-agent`, `orchestrator`, `tui`). Port: \~21.7k LoC Rust. Version-aligned (changelog matches upstream 0.80.2).

This file tracks what is DONE / PARTIAL / MISSING so porting work can converge. Each fix should preserve a separate commit with reason + tradeoff.

## Status summary (parity push — 2026-06-29)

This pass closed many runtime/UX gaps. New since the last summary:

- **TUI rebuilt on ratatui** — scrolling word-wrapped transcript (no cut-off), input box, status line, footer menu, worker-thread streaming (no freeze), non-tty line-REPL fallback (smoke updated). CJK input width fixed.
- **Selectors**: `/model`, `/ollama`, `/sessions`, one-pick `/login` (provider picker; OAuth suspends TUI, API-key prefills), and `/links` (conversation URLs grouped by **brand** with friendly names → open in browser). Tab = menu.
- **Markdown rendering** of assistant replies (code fences, headings, lists, bold, inline code) + animated working spinner until first token.
- **Tool calls emitted as content JSON** (ollama/qwen) now execute (local models actually create/edit files); agentic + real-path prompt guidance.
- **Parallel read-only tool execution** (read/grep/find/ls/web\_\*).
- **Provider attribution** (OpenRouter HTTP-Referer/X-Title) + OpenAI `prompt_cache_key`. `!command` **secrets** in config values.
- Browser open via rundll32 (reliable default browser) + URL shown for copy.
- Startup folder picker made opt-in (`--pick`); default uses the cwd.

Also added: orchestrator (`--orchestrate` multi-process), multimodal image input (`@image.png`), sub-agent `task` tool, branch summarization (`/branch` + `/summarize`).

Verified: `cargo build` 0 warnings, `cargo test` 46 passing, smoke green, installed (`cargo install`) as the production binary.

**Remaining items are author-only or cloud/crypto-gated** (not usable with a local text model): full in-process ExtensionApi (\~80 result-returning methods, needs bidirectional IPC); image *generation* (`openrouter-images`, needs a cloud image API key); Vertex service-account-JSON ADC (needs RS256 JWT crypto dep). Every feature usable with the current local-ollama setup is in.

## Status summary (after the autonomous porting pass)

All **P0** items done. **P1** done except provider attribution (deferred, telemetry-gated low value) and Vertex SA-JSON ADC (needs RS256 crypto dep — skipped); cost done. Key **P2**done: real LLM compaction + auto-trigger, branch context scoping, session migrations, retry. **P3** partial: compaction/retry settings wired. AWS credential chain now covers env → web-identity/IRSA → profile → ECS → bearer.

Verified: `cargo build` 0 warnings, `cargo test` 33 passing, `scripts/smoke.ps1` green.

**Remaining work is large/architectural** (each a focused multi-hour effort, higher risk): streaming + event bus; real TUI (raw input, editor, markdown, autocomplete, differential render); in-process extension runtime (vs subprocess-per-call); orchestrator (0%); multimodal / image input + image-generation; parallel tool execution; steering/follow-up drain + abort; branch summarization on tree-navigation; Vertex SA-JSON; SSO/IMDS creds; settings write-back.

## Major subsystems delivered (2026-06-29, part 2)

- **Orchestrator** — `--orchestrate "t1" "t2" …` runs each task as its own `bbarit --print` child process (true multi-process, ≤4 concurrent), results collected in order. (`src/orchestrator.rs`) Verified two parallel sub-agents writing separate files.
- **Multimodal image input** — `@image.png` attaches an image (data URL) to the user message; sent as image_url parts (OpenAI/ollama vision) or base64 image blocks (Anthropic). Additive `Message.images` (no migration). Works with local vision models (llava, qwen2.5-vl). (`src/session.rs`, `src/llm.rs`, `src/commands.rs`, `src/cli.rs`)
- **Sub-agent** `task` **tool** — the model delegates a self-contained sub-task to a fresh nested agent (own session + loop), depth-limited, streaming off. (`src/commands.rs`, `src/tools.rs`) An in-conversation slice of orchestration.

Remaining (niche / author-only): branch summarization on tree navigation; in-process extension runtime depth (subprocess-per-call works today); image *generation*; Vertex SA-JSON ADC.

## Priority queue (highest impact first)

### P0 — correctness bugs in already-ported code (bounded, testable)

- [x] `edit` **replaces ALL occurrences** — FIXED. Ported Pi's edit-diff contract: multi-edit `edits[]` array (+ legacy old_string/new_string/find/replace), exact + fuzzy (NFKC/quotes/dashes/spaces) matching, **unique-match enforcement** with Pi's error messages, overlap detection, BOM strip + CRLF/LF preservation, no-change detection. Tests: `edit_requires_unique_match`, `edit_applies_multiple_disjoint_edits`, `edit_preserves_crlf_line_endings`. (`src/tools.rs`)

- [x] `grep` **is substring-only** — FIXED. Now regex by default, `literal=true` → escaped fixed string, `ignoreCase` via RegexBuilder; relative paths under the search root; long lines truncated to 500 chars. Test: `grep_matches_regex_and_literal`. Deviation: still uses the in-tree walker, not ripgrep (self-contained; no `.gitignore` yet).

- [x] `bash` **no timeout / no exit-code-as-error / no output truncation** — FIXED. `timeout` (seconds) kills the child; non-zero exit → tool error ("Command exited with code N"); output truncated to last 2000 lines / 50KB with full output spilled to a temp file. Test: `bash_non_zero_exit_is_error`. Deviation: no process-tree kill (single process), stdout then stderr (not interleaved).

- [x] **Prompt/skill dedup precedence inverted** — FIXED. `load_prompts`/`load_skills` now use `entry().or_insert()` (first-discovered wins), matching Pi's `dedupePrompts` and the theme loader. (`src/resources.rs`)

- [x] **Default system prompt missing** — FIXED. `build_system_prompt` mirrors Pi's `buildSystemPrompt`: default coding-assistant base with Available tools + Guidelines (or a configured `system_prompt` replacing the base), `<project_context>`/`<project_instructions>` context-file tags, skills gated on the `read` tool, and a `Current date` (system clock) / `Current working directory` footer. Tests: `default_system_prompt_has_base_tools_and_footer`, `custom_system_prompt_replaces_base_but_keeps_footer`, `context_files_use_project_context_tags`. Deviation: omits the Pi-docs paths section (this port doesn't ship those docs). (`src/llm.rs`)

- [x] **Hard 8-turn tool-loop cap that** `bail!`**s** — FIXED. The loop now runs to natural stop (assistant turn with no tool calls) like upstream; `MAX_AGENT_TOOL_TURNS` is raised to 1000 as a safety backstop (port has no abort yet) and returns the latest output gracefully instead of erroring. (`src/commands.rs`)

**P0 complete.** Added a reusable `AppConfig::for_test` constructor (`src/config.rs`).

### P1 — auth / provider correctness

- [x] **Anthropic OAuth sent as** `x-api-key` — FIXED. `sk-ant-oat` tokens now use `Authorization: Bearer` + betas `claude-code-20250219,oauth-2025-04-20`, claude-cli user-agent / `x-app: cli`, the "You are Claude Code" system identity block, and Claude-Code tool-name remapping (outbound + inbound). (`src/llm.rs`)

- [x] **Credential priority** — FIXED. `resolve_optional_api_key` now resolves CLI override → auth.json → models.json provider key → env, matching Pi's `getApiKeyAndHeaders` (`apiKeyFromAuthStorage ?? providerConfig.apiKey`). (`src/llm.rs`)

- [x] **Prompt caching (Anthropic)** — FIXED. Short/ephemeral `cache_control` (disabled only by `PI_CACHE_RETENTION=none`) on system blocks, the last user message, and the last tool, mirroring Pi's `getCacheControl`. OpenAI `prompt_cache_key` left as a minor remaining item (OpenAI auto-caches by prefix). (`src/llm.rs`)

- \[\~\] `compat`**/**`cost` **system** — PARTIAL. **Cost accounting DONE**: `ModelCost` type + generated `src/providers/costs.rs` (1018 models, per-MTok USD, from Pi's \*.models.ts via `scripts/gen_costs.js`) + `registry.cost_for` + real `/session` cost (thinking-suffix aware, keeps colon ids). Still TODO: `input` modality (image gating), full `compat` struct beyond what metadata.rs already carries (thinkingFormat etc.), and models.json cost overrides.

- [x] **Provider attribution headers** — OpenRouter HTTP-Referer/X-Title sent (unless model config sets them); other providers' attribution remains config-driven via custom headers. OpenAI `prompt_cache_key` also sent. (`src/llm.rs`)

- \[\~\] **AWS/Vertex credential chains** — PARTIAL. Bedrock chain is env → web-identity/IRSA → shared profile → ECS/EKS → bearer. **Vertex service-account-JSON now supported** (RS256 JWT minting, no gcloud). Still TODO: AWS SSO/process creds, EC2 IMDS.

### Found during verification (fixed)

- [x] `--print <command>` **blocked on stdin** — `initial_message` read a non-terminal stdin even when an inline message/command argument was given, so under a non-interactive shell it hung (and piped content was prepended ahead of an explicit command, breaking slash routing). Now reads stdin only when no inline input is present. This is what made `scripts/smoke.ps1` hang; the full smoke now passes (`== ok ==`). (`src/cli.rs`)

### P2 — agent runtime

- [x] **No retry/backoff** — FIXED (bounded). `send_with_retry` retries 429/500/502/503/504/529 and connect/timeout errors up to twice with exponential backoff honoring Retry-After. Deviation: Pi defaults SDK retries to 0 and retries at the agent-harness level (not yet ported). (`src/llm.rs`)

- [x] **Abort/cancellation** — cooperative: Esc/Ctrl+C in the TUI sets a flag the agent loop checks between turns (the in-flight blocking call still completes). (`src/commands.rs`, `src/tui.rs`)

- [x] **Compaction is a stub** — FIXED. Real LLM summarization (Pi's SUMMARIZATION prompts, own system prompt, tools off), token-budget keep-window (`keep_recent_count` \~20k tokens, never starting on a tool result), `shouldCompact` auto-trigger in the agent loop using last-assistant usage vs the model context window (reserve 16k), and a manual `/compact`. Tests cover should_compact/keep_recent_count/serialize. (`src/commands.rs`, `src/session.rs`)

- [x] `/branch` **doesn't scope LLM context** — FIXED (see P0 area / session). conversation() walks leaf→root.

- [x] **Branch summarization** — `/branch` summarizes the branch being left (best-effort) and prints it; `/summarize` summarizes the current branch on demand. Reuses the compaction summarizer. (`src/commands.rs`)

- [x] **Steering/follow-up queue** — typing during a turn queues messages (Enter) that run after it finishes; Esc cancels and drops the queue. (`src/tui.rs`)

- \[\~\] **Parallel tool execution + arg schema validation** — read-only tool batches (read/grep/find/ls/web\_\*) now run concurrently via thread::scope; arg presence is validated by the per-tool extractors. Full JSON-schema validation still TODO. (`src/commands.rs`)

- [x] **Session migrations** — FIXED. v1→v2 (id/parentId + compaction index→id), v2→v3 (hookMessage→custom) applied on load. (`src/session.rs`)

### P3 — settings / extensions / streaming

- [ ] 

- \[\~\] **SettingsManager** — PARTIAL. `compaction`/`retry.maxRetries` parsed and drive the runtime; **write-back added** — switching model persists defaultProvider/defaultModel to settings.json (sticky across launches). Still TODO: file locking, the remaining \~20 settings fields.

- [x] **Streaming** — DONE. SSE/eventstream streaming transport for **all** text APIs: Anthropic, OpenAI (completions + responses), Gemini, Vertex, Mistral, Codex, and Bedrock (binary `vnd.amazon.eventstream`) — text + tool calls + usage, each unit-tested, gated behind `--stream` / settings `stream` (default off). Live token display wired into print, plain-REPL, and TUI paths. json + rpc modes emit `message_update` text-delta events during the turn. (Remaining nicety: granular `tool_execution_update` partial-result deltas.)

- [x] **Extension runtime** — subprocess-per-call with both directions working: **read getters** return live values via a context snapshot (getModel/getProvider/getCwd/isProjectTrusted/getSessionName/getSessionId/getThinkingLevel/getContextUsage/getSystemPrompt/getActiveTools/getCommands), and **mutating actions** apply against live state (setModel/setSessionName/setThinkingLevel/sendUserMessage via the action protocol). Only remaining: live mid-call round-trip callbacks (a persistent-socket optimization), not needed for the documented API surface.

- \[\~\] **resolve-config-value** — `$VAR`/`${VAR}` and `!command` **secrets** (run a command, use stdout) now supported. Still TODO: multi-part templates, escapes. (`src/auth.rs`)

### P4 — large missing subsystems (multi-session efforts)

- [x] **TUI framework** — rebuilt on **ratatui**: raw input, scrolling wrapped transcript, input box, markdown rendering, selectors/overlays, working spinner, CJK width, worker-thread streaming, non-tty line REPL. Remaining niceties: full editor, autocomplete, differential render.

- \[\~\] **Orchestrator** — multi-process parallel task runner shipped (`--orchestrate`). Remaining: persistent IPC supervisor, crash recovery, cloud presence.

- [x] **Image / multimodal** — vision input works (OpenAI/ollama/Anthropic via `Message.images`); **image generation** via the `generate_image` tool (OpenAI images API, trust-gated).

## Notes

- Architectural root causes recurring across gaps: (1) port is blocking/non-streaming where upstream is streaming-first; (2) extensions run as `node -e` subprocess-per-call vs in-process jiti. Streaming + in-process extension host are the two changes that unlock the most parity. &lt;/content&gt; &lt;/invoke&gt;