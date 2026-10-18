# Changelog

## [0.80.2] - 2026-06-23

### Changed

- Changed inherited pi-ai `ApiKeyCredential` to use the `auth.json`-compatible discriminator `type: "api_key"` and provider-scoped `env` values instead of `type: "api-key"` and metadata.
- Renamed the inherited agent-core public harness shell execution options type from `ExecutionEnvExecOptions` to `ShellExecOptions`.

### Fixed

- Fixed inherited Anthropic-compatible custom models to use explicit compatibility metadata instead of provider-name heuristics for session-affinity headers and unsupported tool-field omissions.
- Fixed inherited request-scoped `apiKey` and `env` values to participate in provider auth resolution, so providers such as Cloudflare can derive request-specific base URLs from explicit call options.
- Restored inherited temporary legacy per-API stream aliases such as `streamSimpleOpenAICompletions` on the pi-ai compat entrypoint.
- Restored inherited runtime `detectCompat` fallback in `openai-completions` for models without explicit compat metadata.

## [0.80.1] - 2026-06-23

### Fixed

- Fixed inherited Amazon Bedrock scoped `AWS_PROFILE` endpoint resolution for built-in inference profile endpoints.
- Fixed inherited Fireworks Anthropic-compatible requests to apply session-affinity and unsupported tool-field defaults for custom Fireworks models.
- Fixed inherited Together MiniMax M2.7 metadata to avoid unsupported Together reasoning toggles.

## [0.80.0] - 2026-06-23

### Changed

- Added `Ctrl+J` as a default newline keybinding alongside `Shift+Enter`.
- Renamed the displayed `zai` provider label to ZAI Coding Plan (Global) for clarity.
- pi-ai's old global API moved off the `@earendil-works/pi-ai` root entrypoint to `@earendil-works/pi-ai/compat`.

### Fixed

- Fixed session names to normalize newline characters before storing or displaying labels.
- Fixed the session selector to order threaded session trees by the latest activity anywhere in each subtree.
- Fixed extension-related crash and startup-failure reporting to suggest restarting with `pi -ne`.
- Fixed inherited OpenAI Responses streams to fail before missing terminal events and fixed context usage and compaction estimates to ignore malformed all-zero assistant usage after truncated responses.
- Fixed inherited OpenAI Codex Responses WebSocket sessions to reconnect once when OpenAI's connection limit is reached before output starts.
- Fixed provider-scoped auth environment values to reach inherited `Models`/`ImagesModels` API calls and compat API-key injection.

