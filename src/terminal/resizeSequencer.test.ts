import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PTY_FIRST_ROUNDS, REDRAW_NUDGE_MS, createResizeSequencer, mergeJobs, resizeOrder, waitForQuietWrites, type ResizeJob, type ResizeSequencerDeps } from './resizeSequencer';
import type { GridSize } from './ptySize';

const normal = { altBuffer: false, replaying: false };
const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };

describe('resizeOrder', () => {
  it('tells the PTY first when a normal-buffer terminal gets narrower', () => {
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, normal)).toBe('pty-first');
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 150, rows: 60 }, normal)).toBe('pty-first');
  });
  it('keeps xterm first when widening or only the rows change', () => {
    expect(resizeOrder({ cols: 157, rows: 46 }, { cols: 168, rows: 51 }, normal)).toBe('xterm-first');
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 168, rows: 40 }, normal)).toBe('xterm-first');
  });
  it('keeps xterm first for full-screen TUIs and during output replay', () => {
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, { altBuffer: true, replaying: false })).toBe('xterm-first');
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, { altBuffer: false, replaying: true })).toBe('xterm-first');
  });
  it('keeps xterm first when no program can redraw (no PTY yet, exited, Ollama)', () => {
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, { ...normal, ptyLive: false })).toBe('xterm-first');
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, { ...normal, ptyLive: true })).toBe('pty-first');
  });
  it('is none for the same grid and xterm-first when the target cannot be measured', () => {
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: 168, rows: 51 }, normal)).toBe('none');
    expect(resizeOrder({ cols: 168, rows: 51 }, null, normal)).toBe('xterm-first');
    expect(resizeOrder({ cols: 168, rows: 51 }, { cols: NaN, rows: 51 }, normal)).toBe('xterm-first');
    expect(resizeOrder({ cols: 0, rows: 0 }, { cols: 80, rows: 24 }, normal)).toBe('xterm-first');
  });
});

describe('waitForQuietWrites', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const source = () => {
    let listener: (() => void) | null = null;
    let disposed = false;
    return {
      onWrite: (l: () => void) => { listener = l; return { dispose: () => { disposed = true; listener = null; } }; },
      fire: () => listener?.(),
      get disposed() { return disposed; },
    };
  };

  it('resolves once writes have been quiet for quietMs', async () => {
    const src = source();
    let done = false;
    void waitForQuietWrites(src.onWrite, timers, { quietMs: 30, capMs: 150 }).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(20);
    src.fire();
    await vi.advanceTimersByTimeAsync(20);
    src.fire();
    await vi.advanceTimersByTimeAsync(29);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(src.disposed).toBe(true);
  });

  it('gives up at capMs when nothing is written or output never stops', async () => {
    const quietSrc = source();
    let quietDone = false;
    void waitForQuietWrites(quietSrc.onWrite, timers, { quietMs: 30, capMs: 150 }).then(() => { quietDone = true; });
    const busySrc = source();
    let busyDone = false;
    void waitForQuietWrites(busySrc.onWrite, timers, { quietMs: 30, capMs: 150 }).then(() => { busyDone = true; });
    for (let t = 0; t < 140; t += 10) { busySrc.fire(); await vi.advanceTimersByTimeAsync(10); }
    expect(quietDone).toBe(false);
    expect(busyDone).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(quietDone).toBe(true);
    expect(busyDone).toBe(true);
  });
});

// A fake terminal: refit applies `layout` to xterm; pty records every resize_pty call.
// `gone` makes current() report 0x0 like a disposed terminal; `refitThrows` makes the default refit fail.
function harness(start: GridSize, layout: GridSize, opts: { alt?: boolean } = {}) {
  const state = { xterm: { ...start }, layout: { ...layout }, visible: true, alt: !!opts.alt, replaying: false, ptyLive: true, gone: false, refitThrows: false };
  const pty: GridSize[] = [];
  const events: string[] = [];
  const refitJobs: ResizeJob[] = [];
  let release: (() => void) | null = null;
  const deps: ResizeSequencerDeps = {
    current: () => (state.gone ? { cols: 0, rows: 0 } : { ...state.xterm }),
    propose: () => (state.visible ? { ...state.layout } : null),
    visible: () => state.visible,
    altBuffer: () => state.alt,
    replaying: () => state.replaying,
    ptyLive: () => state.ptyLive,
    defaultRefit: (job) => {
      refitJobs.push(job);
      if (state.refitThrows) throw new Error('fit failed');
      state.xterm = { ...state.layout };
      events.push(`xterm ${state.xterm.cols}x${state.xterm.rows}`);
    },
    resizePty: (s) => { pty.push({ ...s }); events.push(`pty ${s.cols}x${s.rows}`); },
    waitForRedraw: () => new Promise<void>((r) => { events.push('wait'); release = r; }),
    timers,
  };
  const seq = createResizeSequencer(deps);
  const finishWait = async () => { const r = release; release = null; r?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { state, pty, events, refitJobs, seq, finishWait, waiting: () => release != null };
}

describe('createResizeSequencer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('narrowing a shell: PTY first, waits for the redraw, then xterm, then the PTY at xterm size', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 51 });
    h.seq.request();
    expect(h.events).toEqual(['pty 157x51', 'wait']);
    await h.finishWait();
    // The final sync is always sent after a PTY-first run: another resize_pty (e.g. an attach
    // nudge) may have landed during the wait. Same rows: exactly these two PTY calls.
    expect(h.events).toEqual(['pty 157x51', 'wait', 'xterm 157x51', 'pty 157x51']);
    expect(h.state.xterm).toEqual({ cols: 157, rows: 51 });
  });

  it('narrower and shorter: the PTY-first step keeps the rows, the final sync changes them', async () => {
    // xterm drops the lines below the cursor when it loses rows (an inline TUI's status line and
    // footer). The program must get its row change after that, so it repaints them.
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    expect(h.events).toEqual(['pty 157x51', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x51', 'wait', 'xterm 157x46', 'pty 157x46']);
    expect(h.state.xterm).toEqual({ cols: 157, rows: 46 });
  });

  it('narrower and taller: the PTY-first step keeps the rows, the final sync changes them', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 150, rows: 60 });
    h.seq.request();
    expect(h.events).toEqual(['pty 150x51', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 150x51', 'wait', 'xterm 150x60', 'pty 150x60']);
  });

  it('with no live PTY narrowing resizes xterm first and does not wait', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.state.ptyLive = false;
    h.seq.request();
    await Promise.resolve();
    expect(h.events).toEqual(['xterm 157x46', 'pty 157x46']);
  });

  it('a refit that throws after a PTY-first resize still syncs the PTY to xterm', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.state.refitThrows = true;
    h.seq.request();
    await h.finishWait();
    expect(h.state.xterm).toEqual({ cols: 168, rows: 51 });
    expect(h.pty).toEqual([{ cols: 157, rows: 51 }, { cols: 168, rows: 51 }]);
    // Later requests still run.
    h.state.refitThrows = false;
    h.seq.request();
    await h.finishWait();
    expect(h.state.xterm).toEqual({ cols: 157, rows: 46 });
    expect(h.pty.at(-1)).toEqual({ cols: 157, rows: 46 });
  });

  it('widening keeps xterm first and then tells the PTY', async () => {
    const h = harness({ cols: 157, rows: 46 }, { cols: 168, rows: 51 });
    h.seq.request();
    await Promise.resolve();
    expect(h.events).toEqual(['xterm 168x51', 'pty 168x51']);
  });

  it('a full-screen TUI keeps xterm first even when narrowing', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 }, { alt: true });
    h.seq.request();
    expect(h.events).toEqual(['xterm 157x46', 'pty 157x46']);
  });

  it('only sends an unchanged size when asked to', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.seq.request();
    await Promise.resolve();
    expect(h.pty).toEqual([]);
    h.seq.request({ alwaysSyncPty: true });
    await Promise.resolve();
    expect(h.pty).toEqual([{ cols: 168, rows: 51 }]);
  });

  it('coalesces delayed requests into one resize after the last one', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    for (const cols of [160, 150, 140]) {
      h.state.layout = { cols, rows: 45 };
      h.seq.request({}, 150);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.events).toEqual(['pty 140x51', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 140x51', 'wait', 'xterm 140x45', 'pty 140x45']);
  });

  it('a font step back and forth inside the coalesce window resizes nothing; a burst ends with the PTY at xterm size', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.state.layout = { cols: 157, rows: 48 };
    h.seq.request({}, 150);
    await vi.advanceTimersByTimeAsync(60);
    h.state.layout = { cols: 168, rows: 51 };
    h.seq.request({}, 150);
    await vi.advanceTimersByTimeAsync(150);
    // One refit to the unchanged layout, no PTY call.
    expect(h.events).toEqual(['xterm 168x51']);
    expect(h.pty).toEqual([]);
    h.events.length = 0;
    for (const layout of [{ cols: 157, rows: 48 }, { cols: 147, rows: 45 }, { cols: 138, rows: 42 }]) {
      h.state.layout = layout;
      h.seq.request({}, 150);
      await vi.advanceTimersByTimeAsync(60);
    }
    await vi.advanceTimersByTimeAsync(90);
    await h.finishWait();
    expect(h.events).toEqual(['pty 138x51', 'wait', 'xterm 138x42', 'pty 138x42']);
    expect(h.pty.at(-1)).toEqual(h.state.xterm);
  });

  it('a request during the wait runs afterwards against the new layout', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.state.layout = { cols: 160, rows: 48 };
    h.seq.request({ alwaysSyncPty: true });
    await h.finishWait();
    // The first run fits xterm to the layout of that moment (160, wider than what the PTY got,
    // so no second wait) and the PTY follows it; the queued run then only re-syncs the PTY.
    expect(h.events).toEqual(['pty 157x51', 'wait', 'xterm 160x48', 'pty 160x48', 'xterm 160x48', 'pty 160x48']);
    expect(h.state.xterm).toEqual({ cols: 160, rows: 48 });
    expect(h.waiting()).toBe(false);
  });

  it('a layout that gets narrower during the wait is sent to the PTY before xterm shrinks', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.state.layout = { cols: 147, rows: 43 };
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x51', 'wait', 'pty 147x51', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x51', 'wait', 'pty 147x51', 'wait', 'xterm 147x43', 'pty 147x43']);
  });

  it('stops re-sending after a bounded number of rounds', async () => {
    const h = harness({ cols: 200, rows: 51 }, { cols: 199, rows: 46 });
    h.seq.request();
    // Narrower again during every wait: MAX_PTY_FIRST_ROUNDS rounds, then xterm follows the layout.
    for (let i = 0; i < MAX_PTY_FIRST_ROUNDS; i++) {
      h.state.layout = { cols: h.state.layout.cols - 1, rows: 46 };
      await h.finishWait();
    }
    expect(h.waiting()).toBe(false);
    expect(h.events.filter((e) => e === 'wait')).toHaveLength(MAX_PTY_FIRST_ROUNDS);
    expect(h.state.xterm).toEqual(h.state.layout);
    expect(h.pty.at(-1)).toEqual(h.state.layout);
  });

  it('a tab hidden during the wait gets its PTY put back to xterm size', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.state.visible = false;
    await h.finishWait();
    expect(h.state.xterm).toEqual({ cols: 168, rows: 51 });
    expect(h.pty.at(-1)).toEqual({ cols: 168, rows: 51 });
  });

  it('disposing during the wait puts the PTY back and ignores later requests', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.seq.dispose();
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x51', 'wait', 'pty 168x51']);
    h.seq.request();
    h.seq.request({}, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.events).toHaveLength(3);
  });

  it('disposing during the wait never sends a 0x0 size when the terminal is already gone', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.seq.dispose();
    h.state.gone = true;
    await h.finishWait();
    expect(h.pty).toEqual([{ cols: 157, rows: 51 }]);
  });

  it('a job without a custom refit makes the merged run use the default refit', async () => {
    const h = harness({ cols: 157, rows: 46 }, { cols: 168, rows: 51 });
    const custom = vi.fn();
    h.seq.request({}, 150);
    h.seq.request({ refit: custom }, 150);
    await vi.advanceTimersByTimeAsync(150);
    expect(custom).not.toHaveBeenCalled();
    expect(h.refitJobs).toHaveLength(1);
    expect(h.state.xterm).toEqual({ cols: 168, rows: 51 });
  });

  it('a reveal pin survives merging with a later job and forces the default refit', async () => {
    const h = harness({ cols: 157, rows: 46 }, { cols: 168, rows: 51 });
    const custom = vi.fn();
    h.seq.request({ revealPin: 'pin', alwaysSyncPty: true }, 100);
    h.seq.request({}, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.refitJobs[0]).toMatchObject({ revealPin: 'pin', alwaysSyncPty: true });
    h.seq.request({ refit: custom, revealPin: 'pin2' });
    await Promise.resolve();
    expect(custom).not.toHaveBeenCalled();
    expect(h.refitJobs[1]).toMatchObject({ revealPin: 'pin2' });
  });

  it('does nothing for a hidden tab', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.state.visible = false;
    h.seq.request({ alwaysSyncPty: true });
    await Promise.resolve();
    expect(h.events).toEqual([]);
  });

  it('uses the request refit and resyncs the PTY when xterm ends elsewhere', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    const refit = vi.fn(() => { h.state.xterm = { cols: 150, rows: 46 }; });
    h.seq.request({ refit });
    await h.finishWait();
    expect(refit).toHaveBeenCalledTimes(1);
    expect(h.pty).toEqual([{ cols: 157, rows: 51 }, { cols: 150, rows: 46 }]);
  });
});

describe('redraw nudge', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends one column less, then xterm size after REDRAW_NUDGE_MS', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.seq.request({ nudge: true });
    await Promise.resolve();
    expect(h.pty).toEqual([{ cols: 167, rows: 51 }]);
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS - 1);
    expect(h.pty).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.pty).toEqual([{ cols: 167, rows: 51 }, { cols: 168, rows: 51 }]);
  });

  it('a real resize requested during the nudge runs after the PTY is back', async () => {
    const h = harness({ cols: 157, rows: 46 }, { cols: 157, rows: 46 });
    h.seq.request({ nudge: true });
    await Promise.resolve();
    h.state.layout = { cols: 168, rows: 51 };
    h.seq.request();
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.events).toEqual(['xterm 157x46', 'pty 156x46', 'pty 157x46', 'xterm 168x51', 'pty 168x51']);
  });

  it('is skipped while replaying output, without a live PTY or while hidden', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.state.replaying = true;
    h.seq.request({ nudge: true });
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    h.state.replaying = false;
    h.state.ptyLive = false;
    h.seq.request({ nudge: true });
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    h.state.ptyLive = true;
    h.state.visible = false;
    h.seq.request({ nudge: true });
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.pty).toEqual([]);
  });

  it('a nudge asked for while hidden runs with the next job once the tab is shown', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.state.visible = false;
    h.seq.request({ nudge: true });
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.pty).toEqual([]);
    h.state.visible = true;
    h.seq.request({});
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.pty).toEqual([{ cols: 167, rows: 51 }, { cols: 168, rows: 51 }]);
    // Only once.
    h.seq.request({});
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.pty).toHaveLength(2);
  });

  it('puts the PTY back to xterm size when disposed during the nudge', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 168, rows: 51 });
    h.seq.request({ nudge: true });
    await Promise.resolve();
    h.seq.dispose();
    await vi.advanceTimersByTimeAsync(REDRAW_NUDGE_MS);
    expect(h.pty).toEqual([{ cols: 167, rows: 51 }, { cols: 168, rows: 51 }]);
  });

  it('merged into a resize job, nudges once after the resize', async () => {
    const h = harness({ cols: 157, rows: 46 }, { cols: 168, rows: 51 });
    h.seq.request({ nudge: true }, 50);
    h.seq.request({}, 50);
    await vi.advanceTimersByTimeAsync(50 + REDRAW_NUDGE_MS);
    expect(h.events).toEqual(['xterm 168x51', 'pty 168x51', 'pty 167x51', 'pty 168x51']);
  });
});

describe('mergeJobs', () => {
  const a = () => {};
  const b = () => {};
  it('keeps a custom refit only when both jobs have one', () => {
    expect(mergeJobs({ refit: a }, { refit: b }).refit).toBe(b);
    expect(mergeJobs({ refit: a }, {}).refit).toBeUndefined();
    expect(mergeJobs({}, { refit: b }).refit).toBeUndefined();
    expect(mergeJobs(null, { refit: b }).refit).toBe(b);
  });
  it('ORs the PTY sync and nudge flags and keeps the latest reveal pin', () => {
    expect(mergeJobs({ alwaysSyncPty: true, revealPin: 1 }, {})).toMatchObject({ alwaysSyncPty: true, revealPin: 1 });
    expect(mergeJobs({ nudge: true }, {}).nudge).toBe(true);
    expect(mergeJobs({}, { nudge: true }).nudge).toBe(true);
    expect(mergeJobs({ revealPin: 1 }, { revealPin: 2 }).revealPin).toBe(2);
  });
});
