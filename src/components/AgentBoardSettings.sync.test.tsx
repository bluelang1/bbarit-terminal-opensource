import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { onAgentBoardChange } from '../terminal/agentBoard';

const h = vi.hoisted(() => ({
  board: { mode: 'sync' } as Record<string, unknown>,
  invoke: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../config/ConfigContext', () => ({
  useConfig: () => ({
    config: { ...DEFAULT_CONFIG, language: 'en', agents: { ...DEFAULT_CONFIG.agents, board: { ...DEFAULT_CONFIG.agents.board, ...h.board } } },
    updateConfig: h.update,
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args) }));

import { AgentBoardSettings } from './AgentBoardSettings';

const status = (over: Record<string, unknown> = {}) => ({
  mode: 'sync', host: 'studio', hostSource: 'system', state: 'on', lastPushAt: 1, lastPullAt: 2, waiting: 0, skipped: 0,
  refused: 0, fullPush: false, machines: [{ host: 'laptop', teams: 2 }], ...over,
});

function answer(map: Record<string, (args: unknown) => unknown>) {
  h.invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const f = map[cmd];
    if (!f) return {};
    return f(args);
  });
}

const settle = async (ms = 0) => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.board = { mode: 'sync' };
  h.invoke.mockReset();
  h.update.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Agent team board settings: sync', () => {
  it('polls the sync status while syncing and shows refused rows and a changed name', async () => {
    let n = 0;
    answer({
      agent_board_sync_status: () => (++n === 1 ? status({ state: 'starting' }) : status({ state: 'paused', lastErrorCode: 'name_changed', lastError: 'x', refused: 3, refusedReason: 'duplicate key' })),
    });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByText('State: starting')).toBeTruthy();
    await settle(16_000);
    expect(screen.getByText('State: paused')).toBeTruthy();
    expect(screen.getByText('Rows refused by the server: 3 (duplicate key)')).toBeTruthy();
    expect(screen.getByText(/This computer's name changed while its teams carry the old name/)).toBeTruthy();
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('runs Sync now once at a time and reports the counts', async () => {
    let release: () => void = () => {};
    const now = vi.fn(() => new Promise((r) => { release = () => r({ ...status(), ok: true, pushed: 4, pulled: 7 }); }));
    answer({ agent_board_sync_status: () => status(), agent_board_sync_now: now });
    render(<AgentBoardSettings />);
    await settle();
    const button = screen.getByRole('button', { name: 'Sync now' });
    fireEvent.click(button);
    fireEvent.click(button);
    await settle();
    expect(now).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(screen.getByText('Synced: 4 sent, 7 received.')).toBeTruthy();
  });

  it('offers removing other computers\' teams only with sync off, asks first, and refreshes open views', async () => {
    answer({ agent_board_sync_status: () => status({ mode: 'sqlite', state: 'off' }), agent_board_remove_mirrors: () => ({ removed: 2 }) });
    h.board = { mode: 'sync' };
    const { unmount } = render(<AgentBoardSettings />);
    await settle();
    expect(screen.queryByRole('button', { name: "Remove other computers' teams" })).toBeNull();
    unmount();
    h.board = { mode: 'sqlite' };
    const events: string[] = [];
    const off = onAgentBoardChange((d) => events.push(d.action));
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: "Remove other computers' teams" }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(h.invoke).not.toHaveBeenCalledWith('agent_board_remove_mirrors', undefined);
    fireEvent.click(screen.getByRole('button', { name: "Remove other computers' teams" }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this computer' }));
    await settle();
    expect(h.invoke).toHaveBeenCalledWith('agent_board_remove_mirrors', undefined);
    expect(screen.getByText("Removed 2 team(s) of other computers from this computer.")).toBeTruthy();
    expect(events).toContain('sync');
    off();
  });

  it('shows a refused rename in the person\'s language', async () => {
    answer({
      agent_board_sync_status: () => status(),
      agent_board_check_host_name: () => {
        throw JSON.stringify({ code: 'live_teams', vars: { n: 2, name: 'studio' }, message: 'english text' });
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.change(screen.getByLabelText('Computer name'), { target: { value: 'new-name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await settle();
    expect(screen.getByText(/2 team\(s\) on this computer are named for studio/)).toBeTruthy();
    expect(h.update).not.toHaveBeenCalled();
  });
});
