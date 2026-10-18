import { describe, expect, it, vi } from 'vitest';
import { performAgentRestart } from './restartAgents';

function baseDeps(overrides: Partial<Parameters<typeof performAgentRestart>[0]> = {}) {
  const dispose = vi.fn();
  const remount = vi.fn();
  const rebrief = vi.fn().mockResolvedValue(true);
  const waitReady = vi.fn().mockResolvedValue(true);
  return {
    deps: {
      liveStatus: () => ({ cycle: 'reviewing' as string }),
      terms: { devId: 'dev-1', revId: 'rev-1' },
      dispose,
      remount,
      waitReady,
      rebrief,
      settleMs: 0,
      sleep: () => Promise.resolve(),
      ...overrides,
    },
    dispose,
    remount,
    rebrief,
    waitReady,
  };
}

describe('performAgentRestart — pre-teardown guard reads LIVE status (APPROVED race)', () => {
  it('restarts (disposes + remounts) when the harness is in the dev↔review loop', async () => {
    const { deps, dispose, remount } = baseDeps({ liveStatus: () => ({ cycle: 'reviewing' }) });
    const ok = await performAgentRestart(deps);
    expect(ok).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledWith('dev-1');
    expect(dispose).toHaveBeenCalledWith('rev-1');
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it.each(['approved', 'merging', 'merged', 'merge_failed'])(
    'does NOT dispose/remount when the LIVE cycle is %s, even if a stale render bound the button',
    async (liveCycle) => {
      // Simulates the race: the button was bound during a 'reviewing' render, but by click time
      // the broker has emitted APPROVED. liveStatus() returns the CURRENT (synchronously-updated)
      // cycle, so the guard must block teardown.
      const { deps, dispose, remount, rebrief } = baseDeps({ liveStatus: () => ({ cycle: liveCycle }) });
      const ok = await performAgentRestart(deps);
      expect(ok).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
      expect(remount).not.toHaveBeenCalled();
      expect(rebrief).not.toHaveBeenCalled();
    },
  );

  it('does NOT dispose for a resting harness regardless of cycle', async () => {
    const { deps, dispose } = baseDeps({ liveStatus: () => ({ cycle: 'reviewing', lifecycle: 'complete' }) });
    expect(await performAgentRestart(deps)).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('is a no-op (no dispose) when the terminals are unknown', async () => {
    const { deps, dispose } = baseDeps({ terms: undefined });
    expect(await performAgentRestart(deps)).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('still restarts when no rebrief handle is available (restored record)', async () => {
    const { deps, dispose, remount } = baseDeps({ rebrief: undefined });
    expect(await performAgentRestart(deps)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(remount).toHaveBeenCalledTimes(1);
  });
});

describe('performAgentRestart — rebrief fires only when BOTH restarted CLIs are ready', () => {
  // rebrief is fire-and-forget; let its awaited waitReady/rebrief microtasks + macrotask settle.
  const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

  it('re-briefs when both terminals report ready', async () => {
    const { deps, rebrief } = baseDeps({ waitReady: vi.fn().mockResolvedValue(true) });
    await performAgentRestart(deps);
    await flush();
    expect(rebrief).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the dev CLI never comes back', (id: string) => id !== 'dev-1'],
    ['the reviewer CLI never comes back', (id: string) => id !== 'rev-1'],
  ])('does NOT re-brief when %s (avoids relaying into a not-ready terminal)', async (_label, ready) => {
    const rebrief = vi.fn().mockResolvedValue(true);
    const { deps } = baseDeps({
      rebrief,
      waitReady: vi.fn((id: string) => Promise.resolve(ready(id))),
    });
    // teardown/remount still happen (the restart itself is fine); only rebrief is gated.
    expect(await performAgentRestart(deps)).toBe(true);
    await flush();
    expect(rebrief).not.toHaveBeenCalled();
  });
});
