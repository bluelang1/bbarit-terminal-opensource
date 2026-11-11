import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PTY_FIRST_ROUNDS, createResizeSequencer, resizeOrder, waitForQuietWrites, type ResizeSequencerDeps } from './resizeSequencer';
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
function harness(start: GridSize, layout: GridSize, opts: { alt?: boolean } = {}) {
  const state = { xterm: { ...start }, layout: { ...layout }, visible: true, alt: !!opts.alt, replaying: false };
  const pty: GridSize[] = [];
  const events: string[] = [];
  let release: (() => void) | null = null;
  const deps: ResizeSequencerDeps = {
    current: () => ({ ...state.xterm }),
    propose: () => (state.visible ? { ...state.layout } : null),
    visible: () => state.visible,
    altBuffer: () => state.alt,
    replaying: () => state.replaying,
    defaultRefit: () => { state.xterm = { ...state.layout }; events.push(`xterm ${state.xterm.cols}x${state.xterm.rows}`); },
    resizePty: (s) => { pty.push({ ...s }); events.push(`pty ${s.cols}x${s.rows}`); },
    waitForRedraw: () => new Promise<void>((r) => { events.push('wait'); release = r; }),
    timers,
  };
  const seq = createResizeSequencer(deps);
  const finishWait = async () => { const r = release; release = null; r?.(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  return { state, pty, events, seq, finishWait, waiting: () => release != null };
}

describe('createResizeSequencer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('narrowing a shell: PTY first, waits for the redraw, then xterm, with no second PTY call', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    expect(h.events).toEqual(['pty 157x46', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x46', 'wait', 'xterm 157x46']);
    expect(h.state.xterm).toEqual({ cols: 157, rows: 46 });
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
    expect(h.events).toEqual(['pty 140x45', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 140x45', 'wait', 'xterm 140x45']);
  });

  it('a request during the wait runs afterwards against the new layout', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.state.layout = { cols: 160, rows: 48 };
    h.seq.request({ alwaysSyncPty: true });
    await h.finishWait();
    // The first run fits xterm to the layout of that moment (160, wider than what the PTY got,
    // so no second wait) and the PTY follows it; the queued run then only re-syncs the PTY.
    expect(h.events).toEqual(['pty 157x46', 'wait', 'xterm 160x48', 'pty 160x48', 'xterm 160x48', 'pty 160x48']);
    expect(h.state.xterm).toEqual({ cols: 160, rows: 48 });
    expect(h.waiting()).toBe(false);
  });

  it('a layout that gets narrower during the wait is sent to the PTY before xterm shrinks', async () => {
    const h = harness({ cols: 168, rows: 51 }, { cols: 157, rows: 46 });
    h.seq.request();
    h.state.layout = { cols: 147, rows: 43 };
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x46', 'wait', 'pty 147x43', 'wait']);
    await h.finishWait();
    expect(h.events).toEqual(['pty 157x46', 'wait', 'pty 147x43', 'wait', 'xterm 147x43']);
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
    expect(h.events).toEqual(['pty 157x46', 'wait', 'pty 168x51']);
    h.seq.request();
    h.seq.request({}, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(h.events).toHaveLength(3);
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
    expect(h.pty).toEqual([{ cols: 157, rows: 46 }, { cols: 150, rows: 46 }]);
  });
});
