# Agent relay: verify the caller of `agent.*` commands

## Why
`agent run|send|wait|status|list|stop` took `caller` from `BBARIT_TERMINAL_ID` or
`--caller <id>` and the app believed it. Any process could claim to be another tab:
children then attached to the wrong parent, per-tab limits (`maxChildren`/`maxDepth`,
[2026-11-16-agent-limits-and-log-design.md](2026-11-16-agent-limits-and-log-design.md))
were counted against the wrong tab, and `agent stop --children` acted on another tab's
children as if that tab had asked. (A caller-less `agent stop <childId>` stops any relay
child; that stays as it was — this change is about acting *as* another tab.)

## Goal
A tab can act as itself only. Passing another tab's id (by `--caller` or by setting
`BBARIT_TERMINAL_ID`) is refused, while tabs that were opened before the update and still
run in the PTY holder keep working.

## Not a goal (honest limits)
- **Not a boundary against a hostile local process.** The local bridge (mcp-bridge
  `execute_js`) accepts any local client; the key file and other processes' environments
  (`ps eww`, `/proc/<pid>/environ`) are readable by the same user, so such a process can
  compute or copy a token. `--caller-token <t>` shows in `ps` argv the same way.
- A request **without** a caller is still accepted as before: it is nobody's parent and
  counts only toward `maxTotal`, which stays the hard cap.
- The audit log is still the app's own record, not tamper-proof.

## Decisions
- **Token**: every tab PTY gets `BBARIT_TERM_TOKEN` = lowercase hex of
  HMAC-SHA256(key, terminal_id), first 16 bytes (32 hex characters). Deterministic per
  terminal id, so it survives app restarts and PTY-holder reattach with no stored map.
  Set next to `BBARIT_TERMINAL_ID` in `apply_bbarit_terminal_env` (called by the pure
  `pty_backend::build_shell_command`; the token is an injected dep, `ShellEnvDeps::term_token`,
  computed by `create_shell`). An inherited `BBARIT_TERM_TOKEN` (app started from another
  tab) is removed first. No key → no token var.
- **Key file**: `~/.config/octo/agent-relay.key` in release builds and
  `agent-relay.dev.key` in debug builds (`cfg!(debug_assertions)`, like the PTY holder's
  `.dev` files), in the directory of `config_file_path()`, so a dev run never creates,
  replaces or re-times the installed app's key. Two lines: 32 random bytes (OS RNG) as 64
  hex characters, then the creation time in unix ms (0 = unknown). Mode 0600 on unix (a
  wider file is tightened on read). The key is cached in memory for the app run. Never
  logged, never returned by a command.
- **Creating / replacing**: a valid file is used as is and never rewritten. Otherwise the
  instance takes `.<key file>.lock` (exclusive create; waits up to ~2 s for another
  instance; a lock older than 10 s is taken over as left by a crash), re-reads the file
  (another instance may have finished meanwhile), writes a new record to a temp file,
  renames it into place and returns what it then reads back from disk. Two instances (or
  threads) therefore always end up with the same key. A missing key gets creation time =
  now; a malformed one is replaced with creation time 0, which grants no `legacy` pass, so
  a rewrite can never turn token-carrying shells into "older than the key" ones.
- **Key time**: stored in the file, not taken from its mtime (touching the file changes
  nothing). `agent_caller_key_info() -> { available, sinceMs, file }` returns whether the
  key could be read or created, its creation time (null when 0) and the file name — no
  secret; it creates the key when missing, like the other entry points. The key exists
  before the first token-carrying shell is spawned, so such shells always have
  `started_at` ≥ that time.
- **Crates**: `hmac` 0.12 (already in the tree through `pbkdf2`; added as a direct
  dependency, one line in Cargo.lock) with the existing `sha2` 0.10 and `rand` 0.8.
- **Verify**: `agent_caller_verify(terminalId, token) -> bool`
  (`src-tauri/src/agent_caller.rs`, `#[tauri::command(async)]`): parses exactly 32 hex
  characters and checks them with `Mac::verify_truncated_left` (constant time). Ids longer
  than 256 bytes and malformed tokens are false. No command returns a token or the key.
- **ctl**: every agent request that carries a caller also sends
  `callerToken` = `--caller-token <t>` || `BBARIT_TERM_TOKEN` (`agentCallerFields`). So
  `--caller <id>` works only together with that tab's token; from inside another tab it
  carries the wrong token and is refused. No caller → neither is sent.
- **App rule** (pure `decideCaller` in `src/terminal/agentCaller.ts`, wrapped by
  `verifyAgentCaller` and the App helper `checkAgentCaller`, used by `agent.run`, `agent.send`,
  `agent.stop`, `agent.status`, `agent.list`):
  - no caller → as before;
  - caller and the key cannot be read or created → `{ ok: false, error: "caller verification
    unavailable: cannot read the relay key ~/.config/octo/<file> …", callerRefused:
    "key_unavailable" }` (no `legacy` pass and no token check);
  - caller + matching token → verified (`callerVerified: true`);
  - caller + wrong token (or a failed check) → `{ ok: false, error: "caller not verified: <id>
    (the token does not match this tab)", callerRefused: "wrong_token" }`;
  - caller + no token → refused (`callerRefused: "missing_token"`, the message says to run the
    command inside that tab and to reopen a tab opened before the update), **except** when
    that tab's PTY was recovered from the PTY holder in this app run, is still running
    (`recoveredPtyFor(id)`, not exited) and was started before the key was created
    (`predatesCallerTokens`: holder `started_at` > 0 and < `sinceMs`): such shells were
    started by an older app and cannot have the env, so they are accepted as
    `callerVerified: "legacy"`. `started_at` 0 never counts: the holder client
    (`recovered_now` in `pty_holder/client.rs`) lists shells this app run started with
    `started_at: 0` so a webview reload can reattach them, and those have tokens. An unknown
    key time never counts either. A holder shell started after the key existed got a token,
    so omitting it gets no pass, also after later restarts.
- **Order in `agent.run`**: the caller check (an `await`) runs right after the prompt check,
  before the caller lookup, `refreshClaudeSubmitKey` and the limit check. The limit check and
  slot reservation (`createAgentRunReservations().reserve`) remain one synchronous step after
  the last `await`, so the check-then-create race stays closed.
- **Log**: refusals append `caller_refused` with `caller`, `reason` (`wrong_token` |
  `missing_token` | `key_unavailable`) and `cmd`; `run`, `run_refused`, `send` and ctl `stop` entries with a caller
  carry `callerVerified: true | "legacy"`. The token is never written. `agent log` shows both.
- **Unchanged**: the stop-team button and other in-app paths (no caller); the input gate;
  the limits logic; callerless requests; the remote secretary allowlist (no `agent.*`,
  `secretary_commands_deny_shell_reach`). The child brief and the `bbarit-agents` skill never
  tell an agent to pass `--caller`: a child tab has its own id and token.

## Verification
- cargo: `agent_caller::tests` (RFC 4231 vector through the same HMAC type, deterministic
  tokens, verify accepts only the matching token, `.dev` key file in debug builds, record
  format, key created once with its time / reused / 0600, time read from the file not the
  mtime, malformed replaced with time 0, 8 concurrent creators (missing and malformed file)
  end with one key equal to the disk, stale lock taken over / live lock times out), `claude_hook_env_tests` and `pty_backend::tests`
  (env snapshot with `BBARIT_TERM_TOKEN`, inherited token removed, no key → no var).
- vitest: `agentCaller.test.ts` (rule incl. `key_unavailable`, `started_at` 0 never legacy,
  verify wrapper, App wiring: every caller-reading
  `agent.*` case awaits `checkAgentCaller` before the reservation), `agentRelayLog.test.ts`.
- node:test: `tests/bbarit-ctl-agent.test.mjs` (`agentCallerFields`: real tab, `--caller`
  with and without `--caller-token`, missing token, no caller; log formatting).
- Not verified in a running app (native check by the maintainer).

## Known limits
- Deleting the key file creates a new key with a new time on next start: shells with the
  old key's tokens are refused as wrong tokens, but one that omits its token and started
  before the new time looks `legacy`. A process that can delete the key file is outside
  the boundary anyway.
- The holder client still reports `started_at: 0` for shells this app run started; recording
  the real spawn time there would also change the order of `pty_list_recovered`, so it was
  left alone (0 already gets no pass).
- `legacy` lasts for the life of such a shell: anyone can omit the token and claim that
  tab's id until it ends. Reopening old tabs closes this.
