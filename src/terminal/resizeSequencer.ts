// Order of the two halves of a terminal resize: xterm's grid and the PTY's window size.
//
// When a normal-buffer terminal gets narrower and xterm resizes first, xterm reflows every line
// longer than the new width, so a full-width shell prompt (path ... right-aligned clock) wraps
// onto two rows. The shell then gets SIGWINCH and redraws its prompt assuming the old, unwrapped
// layout, which leaves one stale row: the prompt drifts one line down on every narrowing step.
// Telling the PTY first lets the shell redraw for the narrower width while xterm still has the
// wide grid; when xterm then shrinks, nothing on screen is longer than the new width and the
// reflow wraps nothing. Full-screen TUIs (alternate buffer) repaint everything on SIGWINCH and
// widening never wraps, so both keep the old order: xterm first, then the PTY.
import { ptySizeChanged, type GridSize } from './ptySize';

export type ResizeOrder = 'none' | 'xterm-first' | 'pty-first';

export interface ResizeOrderContext {
  /** xterm shows the alternate buffer (full-screen TUI). */
  altBuffer: boolean;
  /** Saved PTY output is being replayed: shell output is not live, so nothing to wait for. */
  replaying: boolean;
}

const validSize = (s: GridSize | null | undefined): s is GridSize =>
  !!s && s.cols > 0 && s.rows > 0 && Number.isFinite(s.cols) && Number.isFinite(s.rows);

export function resizeOrder(current: GridSize, target: GridSize | null, ctx: ResizeOrderContext): ResizeOrder {
  if (!validSize(target) || !validSize(current)) return 'xterm-first';
  if (current.cols === target.cols && current.rows === target.rows) return 'none';
  if (ctx.altBuffer || ctx.replaying) return 'xterm-first';
  return target.cols < current.cols ? 'pty-first' : 'xterm-first';
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

export const browserTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id as number),
};

/**
 * Resolves once writes have gone quiet for `quietMs` after at least one write, or after `capMs`
 * in any case (a busy program or a shell that prints nothing on SIGWINCH).
 */
export function waitForQuietWrites(
  onWrite: (listener: () => void) => { dispose(): void },
  timers: Timers,
  { quietMs, capMs }: { quietMs: number; capMs: number },
): Promise<void> {
  return new Promise((resolve) => {
    let quiet: unknown = null;
    let done = false;
    let sub: { dispose(): void } | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (quiet != null) timers.clear(quiet);
      timers.clear(cap);
      sub?.dispose();
      resolve();
    };
    const cap = timers.set(finish, capMs);
    sub = onWrite(() => {
      if (done) return;
      if (quiet != null) timers.clear(quiet);
      quiet = timers.set(finish, quietMs);
    });
  });
}

export interface ResizeJob {
  /** Fits xterm to its area; the sequencer's default refit when omitted. */
  refit?: () => void;
  /** Send the PTY xterm's size even when the grid did not change. */
  alwaysSyncPty?: boolean;
}

export interface ResizeSequencerDeps {
  /** xterm's current grid. */
  current(): GridSize;
  /** The grid a refit would produce now, or null when it cannot be measured. */
  propose(): GridSize | null;
  /** The terminal area has a size (false for a hidden tab). */
  visible(): boolean;
  altBuffer(): boolean;
  replaying(): boolean;
  defaultRefit(): void;
  resizePty(size: GridSize): void;
  /** Waits for the program to redraw after a PTY resize. */
  waitForRedraw(): Promise<void>;
  timers?: Timers;
}

export interface ResizeSequencer {
  /** Resize now, or `delayMs` after the last delayed request (coalesces bursts). */
  request(job?: ResizeJob, delayMs?: number): void;
  dispose(): void;
}

/** Safety bound only: each extra round needs strictly fewer columns than the last, so a window
 *  drag ends the loop by itself; xterm stays at the old width (clipped) until it does. */
export const MAX_PTY_FIRST_ROUNDS = 32;

const mergeJobs = (a: ResizeJob | null, b: ResizeJob): ResizeJob => ({
  refit: b.refit ?? a?.refit,
  alwaysSyncPty: !!(a?.alwaysSyncPty || b.alwaysSyncPty),
});

/**
 * Runs terminal resizes one at a time. A request that arrives while a PTY-first resize is waiting
 * for the redraw is merged and run right after it, against the layout at that moment. Every run
 * ends with the PTY at xterm's size, also when the tab was hidden or disposed during the wait.
 */
export function createResizeSequencer(deps: ResizeSequencerDeps): ResizeSequencer {
  const timers = deps.timers ?? browserTimers;
  let disposed = false;
  let running = false;
  let pending: ResizeJob | null = null;
  let delayed: ResizeJob | null = null;
  let delayTimer: unknown = null;

  const runOne = async (job: ResizeJob) => {
    if (!deps.visible()) return;
    const before = deps.current();
    let sent: GridSize | null = null;
    let target = deps.propose();
    let from = before;
    // The layout can get narrower again while the shell redraws (another font step, the window
    // still being dragged): xterm must not shrink below the width the shell last drew for, so
    // tell the PTY again and wait once more. After MAX_PTY_FIRST_ROUNDS xterm follows the layout.
    for (let round = 0; round < MAX_PTY_FIRST_ROUNDS; round++) {
      if (!target || resizeOrder(from, target, { altBuffer: deps.altBuffer(), replaying: deps.replaying() }) !== 'pty-first') break;
      deps.resizePty(target);
      sent = target;
      await deps.waitForRedraw();
      if (disposed || !deps.visible()) {
        // xterm was not resized: put the PTY back to xterm's grid. The tab is resized for real
        // when it is shown or mounted again.
        const now = deps.current();
        if (ptySizeChanged(sent, now)) deps.resizePty(now);
        return;
      }
      from = sent;
      target = deps.propose();
    }
    (job.refit ?? deps.defaultRefit)();
    const after = deps.current();
    if (job.alwaysSyncPty ? validSize(after) && !(sent && !ptySizeChanged(sent, after)) : ptySizeChanged(sent ?? before, after)) {
      deps.resizePty(after);
    }
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending && !disposed) {
        const job = pending;
        pending = null;
        try { await runOne(job); } catch { /* a failed refit must not stall later resizes */ }
      }
    } finally {
      running = false;
    }
  };

  const enqueue = (job: ResizeJob) => {
    pending = mergeJobs(pending, job);
    void drain();
  };

  return {
    request(job = {}, delayMs = 0) {
      if (disposed) return;
      if (delayMs > 0) {
        delayed = mergeJobs(delayed, job);
        if (delayTimer != null) timers.clear(delayTimer);
        delayTimer = timers.set(() => {
          delayTimer = null;
          const next = delayed;
          delayed = null;
          if (next && !disposed) enqueue(next);
        }, delayMs);
        return;
      }
      enqueue(job);
    },
    dispose() {
      disposed = true;
      if (delayTimer != null) timers.clear(delayTimer);
      delayTimer = null;
      delayed = null;
      pending = null;
    },
  };
}
