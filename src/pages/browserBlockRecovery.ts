// Block-recovery policy: turn a block VERDICT into an automatic recovery action.
//
// browserBlockDetector tells us WHAT wall we hit; this decides WHAT TO DO about it
// without giving up. Many walls clear themselves: a Cloudflare/JS interstitial passes
// in a few seconds; a rate limit lifts after a pause. Others need a human (captcha,
// login) or cannot be auto-solved (geo). Encoding that as a pure policy lets the
// browser auto-retry the recoverable ones and stop wasting steps on the rest.
//
// D1: Only "wait-and-retry" walls are auto-recovered; human/geo walls short-circuit
//     to a clear instruction. Reason: silently retrying a captcha or 403 is a loop
//     that burns the step budget and hammers the site. Cost: recoverable walls take
//     a few extra seconds. Escape hatch: attempt count is capped (maxAttempts).

import type { BlockKind, BlockVerdict } from './browserBlockDetector';

export type RecoveryAction = 'retry' | 'reload' | 'wait_human' | 'give_up';

export interface RecoveryPlan {
  action: RecoveryAction;
  waitMs: number;       // how long to pause before the action (0 for none)
  message: string;      // what to tell the agent/user
  exhausted: boolean;   // attempts ran out
}

// Escalating backoff for JS/rate-limit interstitials (they usually clear by attempt 2).
export const BLOCK_WAIT_SCHEDULE_MS = [4_000, 8_000, 15_000];
export const MAX_BLOCK_ATTEMPTS = BLOCK_WAIT_SCHEDULE_MS.length;

// Which block kinds are worth auto-waiting for the page to clear itself.
const AUTO_WAIT_KINDS = new Set<BlockKind>(['cloudflare', 'ratelimit', 'unavailable']);
// Walls that need a person acting in the visible browser.
const HUMAN_KINDS = new Set<BlockKind>(['captcha', 'login']);
// Walls we cannot get past from here.
const HARD_KINDS = new Set<BlockKind>(['geo', 'forbidden']);

export function planBlockRecovery(verdict: BlockVerdict, attempt: number): RecoveryPlan {
  if (!verdict?.blocked) {
    return { action: 'give_up', waitMs: 0, message: 'not blocked', exhausted: false };
  }
  const kind = verdict.kind;

  if (HUMAN_KINDS.has(kind)) {
    return { action: 'wait_human', waitMs: 0, exhausted: false,
      message: `${kind === 'captcha' ? 'CAPTCHA' : 'Login'} required — solve it in the visible BBARIT Browser window, then continue on the same page.` };
  }
  if (HARD_KINDS.has(kind)) {
    return { action: 'give_up', waitMs: 0, exhausted: false,
      message: kind === 'geo' ? 'Region-blocked; a different network is needed and cannot be bypassed here.' : 'Access forbidden (403); confirm the URL and your permission.' };
  }
  if (AUTO_WAIT_KINDS.has(kind)) {
    const i = Math.max(0, Math.floor(attempt));
    if (i >= MAX_BLOCK_ATTEMPTS) {
      return { action: 'give_up', waitMs: 0, exhausted: true,
        message: `Auto-retry exhausted after ${MAX_BLOCK_ATTEMPTS} attempts on a ${kind} wall; try later or act in the visible browser.` };
    }
    const waitMs = BLOCK_WAIT_SCHEDULE_MS[i];
    // Rate limits need a plain wait; JS interstitials clear faster with a reload.
    const action: RecoveryAction = kind === 'ratelimit' ? 'retry' : 'reload';
    return { action, waitMs, exhausted: false,
      message: `${kind} wall — waiting ${Math.round(waitMs / 1000)}s then ${action === 'reload' ? 'reloading' : 'retrying'} (attempt ${i + 1}/${MAX_BLOCK_ATTEMPTS}).` };
  }
  return { action: 'give_up', waitMs: 0, exhausted: false, message: verdict.advice || 'Unrecoverable block.' };
}

// Convenience: is this verdict something we should even try to auto-recover?
export function isAutoRecoverable(verdict: BlockVerdict): boolean {
  return !!verdict?.blocked && AUTO_WAIT_KINDS.has(verdict.kind);
}
