// "Codex (new session)" tabs.
//
// A plain Codex tab runs `codex resume --last` when Settings > resume last session is on (the
// most recent recorded session for that folder, shared by every Codex tab there) and plain
// `codex` otherwise. A "Codex (new session)" tab always runs plain `codex`, so it never picks up
// a sibling tab's conversation.
//
// Unlike Claude (`--session-id <uuid>` then `--resume <uuid>`), it cannot resume its own
// conversation after a restart: codex-cli 0.147 has no flag to choose the session id up front
// (`codex resume [SESSION_ID]` only takes an id Codex generated), and the id is only discoverable
// afterwards from ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl, which carries the cwd
// but nothing that ties it to a tab. So a restarted "new session" tab starts fresh again.

/** Fields addTerminal puts on a new Codex tab. */
export function dedicatedCodexSessionFields(fresh: boolean): { codexFreshSession?: true } {
  return fresh ? { codexFreshSession: true } : {};
}

/** Persisted flag from a saved terminal; anything but a Codex tab with `true` drops it. */
export function restoredCodexFreshSession(saved: { cliType?: unknown; codexFreshSession?: unknown } | null | undefined): true | undefined {
  return saved?.cliType === 'codex' && saved.codexFreshSession === true ? true : undefined;
}

/**
 * Codex launch command before the "CLI not found" wrapper. `flags` is the already joined
 * " --a --b" suffix (empty or starting with a space).
 */
export function codexLaunchCommand(options: { resumeLastSession: boolean; freshSession?: boolean; flags: string }): string {
  const resume = options.resumeLastSession && !options.freshSession;
  return `${resume ? 'codex resume --last' : 'codex'}${options.flags}`;
}
