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
//
// The PTY-first step sends only the new column count and keeps xterm's current rows. When xterm
// loses rows it drops the lines below the cursor whatever they hold, and an inline TUI such as
// Claude Code keeps its cursor on the input line with its status line and footer below it. Had the
// PTY already been given the new rows, the program would have repainted before xterm dropped those
// lines and the final PTY sync would carry no change, so they would stay blank. With the rows kept,
// the final sync changes the rows and the program repaints after xterm has shrunk.
import { ptySizeChanged, type GridSize } from './ptySize';

export type ResizeOrder = 'none' | 'xterm-first' | 'pty-first';

export interface ResizeOrderContext {
  /** xterm shows the alternate buffer (full-screen TUI). */
  altBuffer: boolean;
  /** Saved PTY output is being replayed: shell output is not live, so nothing to wait for. */
  replaying: boolean;
  /** A running program can redraw: false with no PTY (Ollama chat), before it starts
   *  (deferStart) or after it exited. Defaults to true. */
  ptyLive?: boolean;
}

const validSize = (s: GridSize | null | undefined): s is GridSize =>
  !!s && s.cols > 0 && s.rows > 0 && Number.isFinite(s.cols) && Number.isFinite(s.rows);

export function resizeOrder(current: GridSize, target: GridSize | null, ctx: ResizeOrderContext): ResizeOrder {
  if (!validSize(target) || !validSize(current)) return 'xterm-first';
  if (current.cols === target.cols && current.rows === target.rows) return 'none';
  if (ctx.altBuffer || ctx.replaying || ctx.ptyLive === false) return 'xterm-first';
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
  /** Fits xterm to its area. Used only when every job merged into this run has one (the latest
   *  wins); otherwise, and whenever revealPin is set, the default refit runs. */
  refit?: () => void;
  /** Send the PTY xterm's size even when the grid did not change. */
  alwaysSyncPty?: boolean;
  /** Opaque scroll pin to restore after the tab was hidden (handled by defaultRefit). Kept
   *  across merges, so a later job cannot drop it. */
  revealPin?: unknown;
  /** After the resize, make the program repaint: PTY one column narrower, then back after
   *  REDRAW_NUDGE_MS. For screens erased behind the program's back (Clear terminal, output
   *  replay), where an incremental renderer would only redraw the cells that change. Skipped
   *  while hidden, replaying or without a live PTY. Runs inside the queue, so a real resize
   *  waits until the PTY is back at xterm's size. */
  nudge?: boolean;
}

export interface ResizeSequencerDeps {
  /** xterm's current grid; 0x0 when the terminal is gone. */
  current(): GridSize;
  /** The grid a refit would produce now, or null when it cannot be measured. */
  propose(): GridSize | null;
  /** The terminal area has a size (false for a hidden tab). */
  visible(): boolean;
  altBuffer(): boolean;
  replaying(): boolean;
  /** See ResizeOrderContext.ptyLive; treated as live when omitted. */
  ptyLive?(): boolean;
  /** Fits xterm to its area for the (merged) job, restoring job.revealPin when set. */
  defaultRefit(job: ResizeJob): void;
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

/** Gap between the two halves of a redraw nudge. A program reads its size when SIGWINCH arrives
 *  and ignores one that shows no change, so the narrower size must still be there when it reads. */
export const REDRAW_NUDGE_MS = 100;

/** Safety bound only: each extra round needs strictly fewer columns than the last, so a window
 *  drag ends the loop by itself; xterm stays at the old width (clipped) until it does. */
export const MAX_PTY_FIRST_ROUNDS = 32;

export const mergeJobs = (a: ResizeJob | null, b: ResizeJob): ResizeJob => (a ? {
  // A custom refit (e.g. one with a fit-key shortcut) must not stand in for a job that needs the
  // default fit, so it survives only when both sides have one.
  refit: a.refit && b.refit ? b.refit : undefined,
  alwaysSyncPty: !!(a.alwaysSyncPty || b.alwaysSyncPty),
  revealPin: b.revealPin ?? a.revealPin,
  nudge: !!(a.nudge || b.nudge),
} : { ...b });

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

  const sleep = (ms: number) => new Promise<void>((resolve) => { timers.set(resolve, ms); });

  const nudge = async () => {
    if (disposed || !deps.visible() || deps.replaying() || deps.ptyLive?.() === false) return;
    const size = deps.current();
    if (!validSize(size) || size.cols < 3) return;
    deps.resizePty({ cols: size.cols - 1, rows: size.rows });
    try {
      await sleep(REDRAW_NUDGE_MS);
    } finally {
      // Back to xterm's grid even when hidden or disposed meanwhile (like a PTY-first run).
      const now = deps.current();
      deps.resizePty(validSize(now) ? now : size);
    }
  };

  const runOne = async (job: ResizeJob) => {
    if (!deps.visible()) return;
    if (await resizeOnce(job) && job.nudge) await nudge();
  };

  // Returns false when the run stopped early (hidden or disposed during the wait).
  const resizeOnce = async (job: ResizeJob): Promise<boolean> => {
    const before = deps.current();
    let ptyFirst = false;
    try {
      let target = deps.propose();
      let from = before;
      // The layout can get narrower again while the shell redraws (another font step, the window
      // still being dragged): xterm must not shrink below the width the shell last drew for, so
      // tell the PTY again and wait once more. After MAX_PTY_FIRST_ROUNDS xterm follows the layout.
      for (let round = 0; round < MAX_PTY_FIRST_ROUNDS; round++) {
        const ctx = { altBuffer: deps.altBuffer(), replaying: deps.replaying(), ptyLive: deps.ptyLive?.() ?? true };
        if (!target || resizeOrder(from, target, ctx) !== 'pty-first') break;
        // New columns, xterm's rows (see the top of this file): a row change reaches the program
        // with the final sync, after xterm has resized.
        const step = { cols: target.cols, rows: from.rows };
        deps.resizePty(step);
        ptyFirst = true;
        await deps.waitForRedraw();
        // Hidden or unmounted during the wait: xterm is not resized now (it is when the tab is
        // shown or mounted again); the finally block puts the PTY back to xterm's grid.
        if (disposed || !deps.visible()) return false;
        from = step;
        target = deps.propose();
      }
      if (job.refit && job.revealPin == null) job.refit();
      else deps.defaultRefit(job);
      return true;
    } finally {
      // After a PTY-first run the PTY is always set to xterm's final grid: the sequencer's own
      // record is not trusted (another resize_pty can land during the wait) and a refit that
      // threw must not leave the PTY narrower than xterm.
      const after = deps.current();
      if (ptyFirst || job.alwaysSyncPty ? validSize(after) : ptySizeChanged(before, after)) {
        deps.resizePty(after);
      }
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
