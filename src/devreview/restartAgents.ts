import { isHarnessInReviewLoop } from './devReviewPair';

export interface AgentRestartDeps {
  /** LIVE (synchronously-updated) harness status — NOT a React-render-captured copy. The guard
   *  must read this so a click that races an APPROVED/merging transition sees the current cycle,
   *  not the cycle from the render that bound the button. Returning undefined means "unknown",
   *  which allows teardown (resting harnesses hide the control anyway). */
  liveStatus: () => { cycle?: string | null; lifecycle?: string | null } | undefined;
  /** The harness's two terminal ids, or undefined if unknown (then this is a no-op). */
  terms: { devId: string; revId: string } | undefined;
  /** Close one terminal's PTY + delete its state (destructive — only after the guard passes). */
  dispose: (terminalId: string) => void;
  /** Remount both terminals (fresh PTY + CLI start). */
  remount: () => void;
  /** Resolve when a restarted terminal's CLI is interactive again. */
  waitReady: (terminalId: string) => Promise<boolean>;
  /** Re-brief the restarted agents; undefined when no live relay handle (e.g. restored record). */
  rebrief: (() => Promise<boolean>) | undefined;
  /** ms to let the async PTY close settle before remount (so the new PTY isn't created mid-close). */
  settleMs: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Restart both agent CLIs in place (same worktree + relay loop). The pre-teardown guard reads the
 * LIVE status via `liveStatus()` BEFORE any `dispose`, so a click that races an APPROVED/merging
 * status update can never kill the CLIs during the one-way auto-merge. Returns false (no teardown)
 * when the harness is not in the dev↔review loop, or when the terminals are unknown.
 */
export async function performAgentRestart(deps: AgentRestartDeps): Promise<boolean> {
  const status = deps.liveStatus();
  if (status && !isHarnessInReviewLoop(status.cycle, status.lifecycle)) return false;
  const terms = deps.terms;
  if (!terms) return false;
  // 1) Destructive teardown — guarded above.
  deps.dispose(terms.devId);
  deps.dispose(terms.revId);
  // 2) Let the async PTY close settle, then remount (fresh PTY + CLI start command re-injected).
  const sleep = deps.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await sleep(deps.settleMs);
  deps.remount();
  // 3) Re-brief once BOTH restarted CLIs are ready again (fire-and-forget). It must be BOTH, not
  //    either: rebrief() relays to the dev AND the reviewer, so briefing while one CLI is still
  //    booting would inject into a not-ready terminal. If one never comes back (waitReady times
  //    out to false) we skip rebrief rather than half-brief.
  const rebrief = deps.rebrief;
  if (!rebrief) return true;
  void (async () => {
    const devReady = await deps.waitReady(terms.devId);
    const revReady = await deps.waitReady(terms.revId);
    if (devReady && revReady) { try { await rebrief(); } catch { /* ignore */ } }
  })();
  return true;
}
