// Agent relay caller verification (docs/superpowers/specs/2026-11-16-agent-caller-verification-design.md).
// bbarit-ctl sends `caller` (BBARIT_TERMINAL_ID or --caller) with `callerToken`
// (BBARIT_TERM_TOKEN or --caller-token). The app checks the token with the Rust command
// `agent_caller_verify` before any agent.* command trusts the caller id.
//
// This stops a tab from acting as another tab by passing that tab's id (flag or env var). It
// is not a boundary against a hostile local process: the local bridge accepts any local
// client, the key file and other processes' environments are readable by the same user, and a
// request without a caller is still accepted (it is nobody's parent and counts only toward
// maxTotal; a caller-less `agent stop <childId>` still stops any relay child).

export type CallerRefusal = 'wrong_token' | 'missing_token' | 'key_unavailable';

export type CallerDecision =
  /** No caller: as before (callerless run, every child for status/list). */
  | { ok: true; caller: ''; verified?: undefined }
  /** `true`: the token matches. `'legacy'`: no token, but the tab's shell was started by an
   *  older app and recovered from the PTY holder, so it cannot have one. */
  | { ok: true; caller: string; verified: true | 'legacy' }
  | { ok: false; caller: string; reason: CallerRefusal; error: string };

/** Rust `agent_caller_key_info` (no secret). */
export interface CallerKeyInfo {
  /** The key could be read or created. */
  available: boolean;
  /** Unix ms since which tab shells carry a token; null/undefined when unknown. */
  sinceMs?: number | null;
  /** Key file name (`agent-relay.key`, or `agent-relay.dev.key` in a debug build). */
  file?: string;
}

/** Tokens are 32 hex characters; anything much longer is not worth sending to Rust. */
const MAX_TOKEN_LEN = 128;

export function callerRefusalMessage(caller: string, reason: CallerRefusal, keyFile = 'agent-relay.key'): string {
  if (reason === 'key_unavailable') {
    return `caller verification unavailable: cannot read the relay key ~/.config/octo/${keyFile} (check that folder's permissions; requests without a caller still work)`;
  }
  return reason === 'wrong_token'
    ? `caller not verified: ${caller} (the token does not match this tab)`
    : `caller not verified: ${caller} (no caller token: run the command inside that BBARIT tab; a tab opened before this app update has no token, so close it and open a new one)`;
}

/**
 * The rule, pure: no caller → as before; key unreadable → refused (no legacy pass either);
 * caller + matching token → verified; caller + wrong token → refused; caller + no token →
 * refused, unless the tab's PTY was recovered from the PTY holder and was started by an older
 * app (cannot carry the env) → accepted as `legacy`.
 */
export function decideCaller(input: { caller: string; token: string; verified: boolean; recovered: boolean; keyAvailable?: boolean; keyFile?: string }): CallerDecision {
  const caller = input.caller.trim();
  if (!caller) return { ok: true, caller: '' };
  const refuse = (reason: CallerRefusal): CallerDecision => ({ ok: false, caller, reason, error: callerRefusalMessage(caller, reason, input.keyFile) });
  if (input.keyAvailable === false) return refuse('key_unavailable');
  if (input.token) return input.verified ? { ok: true, caller, verified: true } : refuse('wrong_token');
  if (input.recovered) return { ok: true, caller, verified: 'legacy' };
  return refuse('missing_token');
}

/**
 * A PTY-holder shell that cannot carry a token: recovered in this app run, still running, and
 * started (holder `started_at`, unix ms) before the key was created (`keySinceMs`, stored in
 * the key file). `started_at` 0 means "not known" — the holder client lists shells this app
 * run started that way (webview reload) — and never counts. An unknown key time (missing, or
 * a replaced malformed key) never counts either: every doubt refuses.
 */
export function predatesCallerTokens(
  entry: { exited?: boolean; started_at?: number } | null | undefined,
  keySinceMs: number | null | undefined,
): boolean {
  if (!entry || entry.exited) return false;
  if (typeof keySinceMs !== 'number' || !Number.isFinite(keySinceMs) || keySinceMs <= 0) return false;
  const started = Number(entry.started_at);
  if (!Number.isFinite(started) || started <= 0) return false;
  return started < keySinceMs;
}

export interface VerifyCallerDeps {
  /** Rust `agent_caller_key_info`. */
  keyInfo: () => Promise<CallerKeyInfo>;
  /** Rust `agent_caller_verify` (constant-time HMAC check). Never returns the token. */
  verify: (terminalId: string, token: string) => Promise<boolean>;
  /** The PTY-holder entry recovered for this tab in this app run (`recoveredPtyFor`). */
  recoveredEntry: (terminalId: string) => { exited?: boolean; started_at?: number } | null | undefined;
}

/**
 * Read `caller` / `callerToken` from an agent.* request and decide. With a caller, asks Rust
 * whether the key is available (a failure counts as unavailable), then checks the token when
 * one was sent (a failed check counts as a wrong token).
 */
export async function verifyAgentCaller(
  request: { caller?: unknown; callerToken?: unknown } | null | undefined,
  deps: VerifyCallerDeps,
): Promise<CallerDecision> {
  const caller = String(request?.caller ?? '').trim();
  if (!caller) return { ok: true, caller: '' };
  const raw = typeof request?.callerToken === 'string' ? request.callerToken.trim() : '';
  const token = raw.length > MAX_TOKEN_LEN ? raw.slice(0, MAX_TOKEN_LEN) : raw;
  let info: CallerKeyInfo;
  try {
    info = await deps.keyInfo();
  } catch {
    info = { available: false };
  }
  const keyAvailable = info?.available === true;
  let verified = false;
  if (keyAvailable && token) {
    try {
      verified = (await deps.verify(caller, token)) === true;
    } catch {
      verified = false;
    }
  }
  let recovered = false;
  if (keyAvailable && !token) {
    try {
      recovered = predatesCallerTokens(deps.recoveredEntry(caller), info.sinceMs);
    } catch {
      recovered = false;
    }
  }
  return decideCaller({ caller, token, verified, recovered, keyAvailable, keyFile: info?.file || undefined });
}
