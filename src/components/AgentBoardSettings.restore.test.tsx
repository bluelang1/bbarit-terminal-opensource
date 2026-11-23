import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';

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
  refused: 0, fullPush: false, machines: [], serverSchema: 4, codeSchema: 4, outboxWaiting: 0, outboxRefused: 0, hosts: [], ...over,
});
const preview = (over: Record<string, unknown> = {}) => ({ host: 'studio', teams: 2, tasks: 5, notes: 9, unsent: 0, takeover: null, ...over });

function answer(map: Record<string, (args: unknown) => unknown>) {
  h.invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const f = map[cmd];
    if (!f) return {};
    return f(args);
  });
}

const settle = async () => {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
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

const restoreCalls = () => h.invoke.mock.calls.filter((c) => c[0] === 'agent_board_restore');

describe('Agent team board settings: restore my teams from the server', () => {
  it('shows what would come down, does nothing on Cancel, and restores after confirmation', async () => {
    const restore = vi.fn(() => ({ teams: 2, tasks: 5, notes: 9, keptNewer: 1 }));
    answer({ agent_board_sync_status: () => status(), agent_board_restore_preview: () => preview(), agent_board_restore: restore });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    const dialog = screen.getByRole('alertdialog', { name: 'Restore my teams from the server' });
    expect(dialog.textContent).toContain('The server has 2 team(s) of studio with 5 task(s) and 9 note(s).');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(restoreCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await settle();
    expect(restore).toHaveBeenCalledWith({ takeover: false });
    expect(screen.getByText('Restored 2 team(s): 5 task(s), 9 note(s). Rows newer on this computer kept: 1.')).toBeTruthy();
  });

  it('asks before taking the name over, and only once the other installation is silent', async () => {
    let allowed = false;
    const restore = vi.fn(() => ({ teams: 1, tasks: 0, notes: 0, keptNewer: 0 }));
    answer({
      agent_board_sync_status: () => status(),
      agent_board_restore_preview: () => preview({ takeover: { lastSeen: 1, ageMs: allowed ? 40 * 60_000 : 3 * 60_000, minAgeMs: 15 * 60_000, allowed } }),
      agent_board_restore: restore,
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    expect(screen.getByText(/Another installation holds the name studio; it last synced 3 minutes ago/)).toBeTruthy();
    expect(screen.getByText(/silent for 15 minutes/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    allowed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    const go = screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'That computer is gone: take over the name studio' }));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await settle();
    expect(restore).toHaveBeenCalledWith({ takeover: true });
  });

  it('translates the host refusals and blocks restore while changes wait', async () => {
    answer({
      agent_board_sync_status: () => status({ serverSchema: 3, outboxWaiting: 2 }),
      agent_board_restore_preview: () => preview({ unsent: 3 }),
      agent_board_restore: () => { throw JSON.stringify({ code: 'host_alive', vars: { host: 'studio', minutes: 15 }, message: 'x' }); },
    });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-upgrade-3c').textContent).toContain('Create / upgrade tables');
    expect(screen.getByText('Notes waiting to be delivered to other computers: 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    expect(screen.getByText(/3 change\(s\) of these teams on this computer were not sent yet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    answer({
      agent_board_sync_status: () => status(),
      agent_board_restore_preview: () => preview(),
      agent_board_restore: () => { throw JSON.stringify({ code: 'host_alive', vars: { host: 'studio', minutes: 15 }, message: 'x' }); },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await settle();
    expect(screen.getByText('The computer named studio synced less than 15 minutes ago; restore only replaces a computer that is gone.')).toBeTruthy();
  });
});

describe('restore: review fixes', () => {
  it('runs a double-clicked Restore once', async () => {
    let release: (v: unknown) => void = () => {};
    const restore = vi.fn(() => new Promise((r) => { release = r; }));
    answer({ agent_board_sync_status: () => status(), agent_board_restore_preview: () => preview(), agent_board_restore: restore });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    const go = screen.getByRole('button', { name: 'Restore' });
    fireEvent.click(go);
    fireEvent.click(go);
    await settle();
    release({ teams: 2, tasks: 5, notes: 9, keptNewer: 0 });
    await settle();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('shows an error when the preview cannot be read, never an empty dialog', async () => {
    answer({ agent_board_sync_status: () => status(), agent_board_restore_preview: () => null });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Could not read what the server has: ?')).toBeTruthy();
    cleanup();
    answer({ agent_board_sync_status: () => status(), agent_board_restore_preview: () => { throw 'connection refused'; } });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Restore my teams from the server' }));
    await settle();
    expect(screen.getByText('Could not read what the server has: connection refused')).toBeTruthy();
  });

  it('shows the replaced state and the kept-changes file with a reveal button', async () => {
    answer({
      agent_board_sync_status: () => status({ state: 'paused', lastErrorCode: 'replaced', lastError: 'x', keptRows: 3, keptFile: '/tmp/agent-board-kept/lead-1.json' }),
    });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByText(/took this computer's name over, so this board file no longer syncs/)).toBeTruthy();
    expect(screen.getByTestId('agent-board-kept').textContent).toContain('3 change(s)');
    fireEvent.click(screen.getByRole('button', { name: 'Show the file' }));
    await settle();
    expect(h.invoke).toHaveBeenCalledWith('reveal_in_explorer', { path: '/tmp/agent-board-kept/lead-1.json' });
  });
});

describe('sync: a different or restored server', () => {
  it('says once that the server at this address changed or was restored', async () => {
    answer({ agent_board_sync_status: () => status({ serverEvent: 'server_replaced', serverEventAt: 5 }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-event').textContent).toContain('The server at this address is a different one');
    cleanup();
    answer({ agent_board_sync_status: () => status({ serverEvent: 'server_restored', serverEventAt: 5 }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-event').textContent).toContain('restored from a backup');
    cleanup();
    answer({ agent_board_sync_status: () => status() });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.queryByTestId('agent-board-server-event')).toBeNull();
  });
});
