import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitAgentBoardEvent } from '../terminal/agentBoard';
import type { TeamBoardSource } from './source';
import { EMPTY_WATCH, WATCH_EVENT_DEBOUNCE_MS, useTeamWatch } from './watch';

const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

function source(state: { failed: boolean }): TeamBoardSource {
  return {
    teams: vi.fn(async () => [{ team: 't1', updatedTs: 1 }]),
    tasks: vi.fn(async () => ({ tasks: state.failed ? [{ seq: 1, title: 'x', state: 'failed', updatedAt: Date.now() }] : [] })),
  } as unknown as TeamBoardSource;
}

afterEach(() => { vi.useRealTimers(); });

describe('useTeamWatch', () => {
  it('reads only while enabled, keeps the same object when nothing badge-relevant changed, clears when off', async () => {
    vi.useFakeTimers();
    const state = { failed: true };
    const src = source(state);
    const { result, rerender } = renderHook(({ on }) => useTeamWatch(src, on, 60_000), { initialProps: { on: false } });
    await flush();
    expect(src.teams).not.toHaveBeenCalled();
    rerender({ on: true });
    await flush();
    expect(result.current.needs.get('t1')?.map((i) => i.key)).toEqual(['failed:1']);
    const first = result.current;
    // A board event (debounced) re-reads; same items → same state object (no App re-render).
    act(() => { emitAgentBoardEvent({ team: 't1', action: 'task' }); emitAgentBoardEvent({ team: 't1', action: 'task' }); });
    await act(async () => { vi.advanceTimersByTime(WATCH_EVENT_DEBOUNCE_MS + 10); });
    await flush();
    expect((src.teams as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(result.current).toBe(first);
    // Something changed → new state.
    state.failed = false;
    act(() => { emitAgentBoardEvent({ team: 't1', action: 'task' }); });
    await act(async () => { vi.advanceTimersByTime(WATCH_EVENT_DEBOUNCE_MS + 10); });
    await flush();
    expect(result.current.needs.get('t1')).toEqual([]);
    // Disabled: badges cleared.
    rerender({ on: false });
    await flush();
    expect(result.current).toBe(EMPTY_WATCH);
  });
});
