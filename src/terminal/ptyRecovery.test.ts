import { describe, expect, it } from 'vitest';
import {
  awaitingRestartBanner, clearAwaitingRestart, decsetPrefix, decsetReset, exitedBannerText, getPtyRecovery,
  describePtyBackend, holderIntroWanted, hostDebugBuild, isAliveInHolderError, isRestoredTerminal, loadPtyRecovery, markAwaitingRestart, markRecoveredHandled,
  omittedBytesLine, placeUnknownRecovered, planAfterProbe, ptyHolderDefaultOn, recoveredPtyFor, recoveredStartPlan,
  resetPtyRecoveryForTests, setPtyRecovery, withoutRecovered, type RecoveredPty,
} from './ptyRecovery';

const entry = (id: string, extra: Partial<RecoveredPty> = {}): RecoveredPty => ({
  handle: 1, id, exited: false, dropped_bytes: 0, modes: { decset: [], kitty_keyboard: 0 }, ...extra,
});

describe('recovered-id gating', () => {
  it('attaches live, shows exited, creates otherwise', () => {
    expect(recoveredStartPlan(entry('a'), false)).toBe('attach');
    expect(recoveredStartPlan(entry('a', { exited: true }), false)).toBe('exited');
    expect(recoveredStartPlan(undefined, false)).toBe('create');
    expect(recoveredStartPlan(entry('a'), true)).toBe('create');
  });

  it('never defers recovered terminals on startup', () => {
    const deferred = new Set(['a', 'b', 'c']);
    expect([...withoutRecovered(deferred, [entry('b'), entry('z', { exited: true })])]).toEqual(['a', 'c']);
    expect(withoutRecovered(deferred, [])).toBe(deferred);
  });

  it('isRestored: holder = in the list, in-process = lastWorkDir heuristic', () => {
    const holder = { kind: 'holder' as const, recovered: [entry('a')] };
    expect(isRestoredTerminal('a', '', holder)).toBe(true);
    expect(isRestoredTerminal('b', '/work', holder)).toBe(false);
    const inProcess = { kind: 'in-process' as const, recovered: [] };
    expect(isRestoredTerminal('b', '/work', inProcess)).toBe(true);
    expect(isRestoredTerminal('b', '', inProcess)).toBe(false);
  });

  it('registry: handled exited entries are not offered again', () => {
    setPtyRecovery({ kind: 'holder', recovered: [entry('x', { exited: true })] });
    expect(recoveredPtyFor('x')?.id).toBe('x');
    markRecoveredHandled('x');
    expect(recoveredPtyFor('x')).toBeUndefined();
    expect(isRestoredTerminal('x', '')).toBe(true); // stays stable (effect dep)
  });

  it('describePtyBackend shows kind, spawn method and fallback reasons', () => {
    expect(describePtyBackend({ kind: 'holder', spawnMethod: 'launchd' }, false)).toBe('PTY holder · launchd');
    expect(describePtyBackend({ kind: 'holder', spawnMethod: 'setsid', spawnFallbackReason: 'launchd: x' }, true))
      .toBe('PTY 홀더 · setsid (launchd: x)');
    expect(describePtyBackend({ kind: 'in-process', fallbackReason: 'newer holder' }, false))
      .toBe('inside the app (in-process): newer holder');
    expect(describePtyBackend({ kind: 'in-process' }, true)).toBe('앱 안 (in-process)');
  });

  it('loadPtyRecovery asks the list only for the holder and memoizes', async () => {
    const calls: string[] = [];
    const invokeFn = async <T,>(cmd: string): Promise<T> => {
      calls.push(cmd);
      return (cmd === 'pty_backend_info' ? { kind: 'holder' } : [entry('r1')]) as T;
    };
    const a = await loadPtyRecovery(invokeFn);
    const b = await loadPtyRecovery(invokeFn);
    expect(a).toBe(b);
    expect(calls).toEqual(['pty_backend_info', 'pty_list_recovered']);
    expect(getPtyRecovery().recovered.map((e) => e.id)).toEqual(['r1']);
  });

  it('loadPtyRecovery retries errors and timeouts instead of concluding in-process', async () => {
    resetPtyRecoveryForTests();
    let n = 0;
    const waits: number[] = [];
    const retries: number[] = [];
    const invokeFn = async <T,>(cmd: string): Promise<T> => {
      if (cmd === 'pty_backend_info') {
        n += 1;
        if (n === 1) throw new Error('ipc down');
        if (n === 2) return new Promise<T>(() => {}); // never answers: the attempt times out
        return { kind: 'holder' } as T;
      }
      return [entry('kept')] as T;
    };
    const rec = await loadPtyRecovery(invokeFn, {
      timeoutMs: 5,
      backoffMs: [1, 2],
      sleep: async (ms) => { waits.push(ms); },
      onRetry: (attempt) => { retries.push(attempt); },
    });
    expect(rec.kind).toBe('holder');
    expect(rec.recovered.map((e) => e.id)).toEqual(['kept']);
    expect(retries).toEqual([1, 2]);
    expect(waits).toEqual([1, 2]);
    expect(getPtyRecovery().kind).toBe('holder');
  });

  it('loadPtyRecovery does not resolve while the backend keeps failing', async () => {
    resetPtyRecoveryForTests();
    let attempts = 0;
    let settled = false;
    const invokeFn = async <T,>(): Promise<T> => { attempts += 1; throw new Error('down'); };
    void loadPtyRecovery(invokeFn, { timeoutMs: 5, backoffMs: [0], sleep: () => new Promise((r) => { setTimeout(r, 0); }) })
      .then(() => { settled = true; });
    await new Promise((r) => { setTimeout(r, 30); });
    expect(attempts).toBeGreaterThan(2);
    expect(settled).toBe(false);
    expect(getPtyRecovery().kind).toBe('in-process'); // untouched default, never "loaded"
    resetPtyRecoveryForTests();
  });

  it('an attach whose terminal is gone after the probe becomes exited', () => {
    expect(planAfterProbe('attach', true)).toBe('attach');
    expect(planAfterProbe('attach', false)).toBe('exited');
    expect(planAfterProbe('create', false)).toBe('create');
    expect(planAfterProbe('exited', true)).toBe('exited');
  });

  it('recognizes the holder guard error from create_shell', () => {
    expect(isAliveInHolderError('PTY alive in holder')).toBe(true);
    expect(isAliveInHolderError(new Error('PTY alive in holder'))).toBe(true);
    expect(isAliveInHolderError('PTY not found')).toBe(false);
    expect(isAliveInHolderError(undefined)).toBe(false);
  });

  it('an exited tab waiting for Enter keeps its banner across remounts until cleared', () => {
    resetPtyRecoveryForTests();
    expect(awaitingRestartBanner('t1')).toBeUndefined();
    markAwaitingRestart('t1', 'BANNER');
    expect(awaitingRestartBanner('t1')).toBe('BANNER');
    expect(awaitingRestartBanner('t1')).toBe('BANNER'); // a second remount still sees it
    clearAwaitingRestart('t1');
    expect(awaitingRestartBanner('t1')).toBeUndefined();
  });
});

describe('replay prefix', () => {
  it('turns tracked modes into DECSET, alt screen first, plus kitty flags', () => {
    expect(decsetPrefix({ decset: [1006, 1049, 2004], kitty_keyboard: 1 })).toBe('\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[>1u');
    expect(decsetPrefix({ decset: [], kitty_keyboard: 0 })).toBe('');
    expect(decsetPrefix(undefined)).toBe('');
    expect(decsetPrefix({ decset: [9999], kitty_keyboard: 0 })).toBe('');
    expect(decsetReset({ decset: [1049, 2004], kitty_keyboard: 3 })).toBe('\x1b[<u\x1b[?2004l\x1b[?1049l');
  });

  it('omitted-bytes line only when bytes were dropped', () => {
    expect(omittedBytesLine(0)).toBe('');
    expect(omittedBytesLine(3 * 1024 * 1024)).toContain('[앱이 꺼진 동안 3 MB 생략]');
    expect(omittedBytesLine(1000)).toContain('0.1 MB');
    expect(omittedBytesLine(25.4 * 1024 * 1024)).toContain('25 MB');
  });

  it('exited banner decision', () => {
    expect(exitedBannerText(entry('a'))).toBeNull();
    expect(exitedBannerText(entry('a', { exited: true, exit_code: 2 }))).toBe('종료됨 (code 2)');
    expect(exitedBannerText(entry('a', { exited: true, exit_code: null }))).toBe('종료됨');
  });
});

describe('unknown holder terminals', () => {
  type T = { id: string; name: string };
  type P = { id: string; workDir: string; terminals: T[] };
  const make = {
    terminal: (e: RecoveredPty): T => ({ id: e.id, name: '복구됨' }),
    project: (_: RecoveredPty[], terminals: T[]): P => ({ id: 'recovered', workDir: '/', terminals }),
  };

  it('joins the project with the same cwd, else one synthetic project', () => {
    const projects: P[] = [{ id: 'p1', workDir: '/work/a/', terminals: [{ id: 'saved', name: 's' }] }];
    const { projects: next, placed } = placeUnknownRecovered(projects, [
      entry('saved'), entry('u1', { cwd: '/work/a' }), entry('u2', { cwd: '/elsewhere' }), entry('u3'),
    ], make);
    expect(next[0].terminals.map((t) => t.id)).toEqual(['saved', 'u1']);
    expect(next[1].id).toBe('recovered');
    expect(next[1].terminals.map((t) => t.id)).toEqual(['u2', 'u3']);
    expect(Object.fromEntries(placed)).toEqual({ u1: 'p1', u2: 'recovered', u3: 'recovered' });
    expect(projects[0].terminals).toHaveLength(1); // input untouched
  });

  it('returns the same array when every terminal is known', () => {
    const projects: P[] = [{ id: 'p1', workDir: '/w', terminals: [{ id: 'a', name: 'a' }] }];
    expect(placeUnknownRecovered(projects, [entry('a')], make).projects).toBe(projects);
  });
});

describe('holder intro notice', () => {
  it('shows only for the holder in release builds when quitting keeps terminals', () => {
    const holder = { kind: 'holder' as const };
    expect(holderIntroWanted(holder, false, true)).toBe(true);
    expect(holderIntroWanted(holder, false, false)).toBe(false);
    expect(holderIntroWanted(holder, true, true)).toBe(false);
    expect(holderIntroWanted({ kind: 'in-process' }, false, true)).toBe(false);
  });
});

describe('host build defaults (pty_backend_info.defaultOn / debugBuild)', () => {
  it('prefers what the host reports over the Vite flag', () => {
    // `tauri build --debug`: Rust debug_assertions on, Vite DEV off.
    expect(hostDebugBuild({ debugBuild: true }, false)).toBe(true);
    expect(hostDebugBuild({}, false)).toBe(false);
    expect(hostDebugBuild({}, true)).toBe(true);
    expect(ptyHolderDefaultOn({ defaultOn: false, debugBuild: true }, false)).toBe(false);
    expect(ptyHolderDefaultOn({ defaultOn: false }, false)).toBe(false); // e.g. Windows release
    expect(ptyHolderDefaultOn({ debugBuild: true }, false)).toBe(false);
    expect(ptyHolderDefaultOn({}, false)).toBe(true);
  });

  it('loadPtyRecovery keeps defaultOn/debugBuild from pty_backend_info', async () => {
    resetPtyRecoveryForTests();
    const invokeFn = (async (cmd: string) => (cmd === 'pty_backend_info'
      ? { kind: 'in-process', defaultOn: false, debugBuild: true }
      : [])) as <T>(command: string) => Promise<T>;
    const rec = await loadPtyRecovery(invokeFn);
    expect(rec.defaultOn).toBe(false);
    expect(rec.debugBuild).toBe(true);
    resetPtyRecoveryForTests();
  });
});
