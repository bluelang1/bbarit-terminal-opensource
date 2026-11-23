import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardHostBoardEvent } from '../terminal/agentBoard';
import { SERVER_POLL_MS, useTeamBoard, type TeamBoardSource } from './source';
import { WATCH_EVENT_DEBOUNCE_MS, useTeamWatch } from './watch';

function source(mode: string) {
  const tasks = vi.fn(async () => ({ tasks: [] }));
  const teams = vi.fn(async () => [{ team: 't1' }, { team: 't2' }]);
  const src: TeamBoardSource = {
    info: async () => ({ host: 'h', mode, backend: mode }),
    teams,
    tasks,
    events: async () => [],
    posts: async () => [],
    history: async () => [],
    refusals: async () => [],
    act: async () => ({ ok: true }),
    postNote: async () => ({ ok: true }),
  };
  return { src, tasks, teams };
}

const settle = async (ms = 0) => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('team view and the board server change stream', () => {
  it('re-reads the team when the host announces it (and every team on a reset)', async () => {
    const { src, tasks } = source('server');
    renderHook(() => useTeamBoard(src, 't1'));
    await settle();
    await settle();
    const base = tasks.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // The host's Tauri payload for a change of t1 (action "server").
    expect(forwardHostBoardEvent({ team: 't1', action: 'server' })).toBe(true);
    await settle();
    expect(tasks.mock.calls.length).toBe(base + 1);

    // Another team: no read of this one.
    forwardHostBoardEvent({ team: 't2', action: 'server' });
    await settle();
    expect(tasks.mock.calls.length).toBe(base + 1);

    // `reset`: every team.
    forwardHostBoardEvent({ team: '', action: 'server' });
    await settle();
    expect(tasks.mock.calls.length).toBe(base + 2);

    // Payloads that are not a team id are dropped.
    expect(forwardHostBoardEvent({ team: '../x' })).toBe(false);
    expect(forwardHostBoardEvent({ action: 'server' })).toBe(false);
    expect(forwardHostBoardEvent(null)).toBe(false);
    await settle();
    expect(tasks.mock.calls.length).toBe(base + 2);
  });

  it('polls more slowly in board server mode (the stream is the fast path), as before otherwise', async () => {
    const server = source('server');
    const hook = renderHook(() => useTeamBoard(server.src, 't1'));
    await settle();
    await settle();
    // Opening reads the board exactly once (learning the mode restarts nothing).
    expect(server.tasks).toHaveBeenCalledTimes(1);
    expect(server.teams).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loading).toBe(false);
    const a = server.tasks.mock.calls.length;
    await settle(10_000);
    expect(server.tasks.mock.calls.length).toBe(a);
    await settle(SERVER_POLL_MS - 10_000);
    expect(server.tasks.mock.calls.length).toBe(a + 1);
    cleanup();

    const local = source('sqlite');
    renderHook(() => useTeamBoard(local.src, 't1'));
    await settle();
    const b = local.tasks.mock.calls.length;
    await settle(10_000);
    expect(local.tasks.mock.calls.length).toBe(b + 1);
  });
});

describe('badges and the board server change stream', () => {
  it('useTeamWatch re-reads on a host announcement (debounced)', async () => {
    const { src, teams } = source('server');
    renderHook(() => useTeamWatch(src, true, 60_000, 45_000));
    await settle();
    const base = teams.mock.calls.length;
    expect(base).toBe(1);
    forwardHostBoardEvent({ team: 't1', action: 'server' });
    forwardHostBoardEvent({ team: 't2', action: 'server' });
    await settle(WATCH_EVENT_DEBOUNCE_MS - 50);
    expect(teams.mock.calls.length).toBe(base);
    await settle(100);
    expect(teams.mock.calls.length).toBe(base + 1);
  });
});
