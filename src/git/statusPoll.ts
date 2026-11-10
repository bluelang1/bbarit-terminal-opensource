/**
 * Git panel status polling that never overlaps and backs off on slow repos.
 *
 * A fixed `setInterval(refresh, 5000)` piles up `git status` calls once one
 * takes longer than 5 s (a 274k-file repo takes about a minute), so the next
 * poll is only scheduled after the previous one finishes, and the wait grows
 * with the last measured duration.
 */

export const STATUS_POLL_BASE_MS = 5000;
export const STATUS_POLL_MAX_MS = 60000;
/** Wait this many times the last status duration before polling again. */
export const STATUS_POLL_DURATION_FACTOR = 3;

/** Delay before the next poll: max(base, 3 x last duration), capped at 60 s. */
export function nextStatusPollDelay(lastDurationMs: number, baseMs: number = STATUS_POLL_BASE_MS): number {
  const d = Number.isNaN(lastDurationMs) || lastDurationMs < 0 ? 0 : lastDurationMs;
  return Math.max(baseMs, Math.min(STATUS_POLL_MAX_MS, d * STATUS_POLL_DURATION_FACTOR));
}

export interface StatusPoller {
  /** Schedule polls; the first one runs after `firstDelayMs` (default: the base delay). */
  start(opts?: { firstDelayMs?: number }): void;
  /**
   * Run the status now. While a call is in flight this never starts a second
   * one: it shares the in-flight call, or with `fresh` (after a change the
   * caller made) queues a single rerun that starts once the current call ends.
   */
  refresh(opts?: { fresh?: boolean }): Promise<void>;
  /** Cancel the pending timer and any queued rerun. A running call is left to finish. */
  stop(): void;
}

export interface StatusPollerOptions {
  /** Shortest wait between polls (default 5 s). */
  baseMs?: number;
  now?: () => number;
}

export function createStatusPoller(
  run: () => Promise<void>,
  { baseMs = STATUS_POLL_BASE_MS, now = () => Date.now() }: StatusPollerOptions = {},
): StatusPoller {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let lastDurationMs = 0;

  const execute = (): Promise<void> => {
    const started = now();
    const p: Promise<void> = run()
      .catch(() => { /* the caller logs its own errors */ })
      .finally(() => {
        lastDurationMs = now() - started;
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
    return p;
  };

  const refresh = (opts?: { fresh?: boolean }): Promise<void> => {
    if (!inFlight) return stopped ? Promise.resolve() : execute();
    if (!opts?.fresh) return inFlight;
    if (!queued) {
      queued = inFlight.then(() => {
        queued = null;
        if (stopped) return;
        return inFlight ?? execute();
      });
    }
    return queued;
  };

  const schedule = (delayMs: number = nextStatusPollDelay(lastDurationMs, baseMs)) => {
    if (stopped) return;
    timer = setTimeout(tick, delayMs);
  };

  const tick = () => {
    timer = null;
    if (stopped) return;
    void refresh().then(() => schedule());
  };

  return {
    start(opts) {
      if (timer || stopped) return;
      schedule(opts?.firstDelayMs);
    },
    refresh,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
