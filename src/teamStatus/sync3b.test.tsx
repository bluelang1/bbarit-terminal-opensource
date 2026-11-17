import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../terminal/agentTasks';
import type { SyncStatus } from '../terminal/agentBoardStorage';
import { MachinesCard } from './LimitsCard';
import { makeT } from './strings';
import type { TeamBoardSource } from './source';
import { TeamStatusView, type TeamStatusViewProps } from './TeamStatusView';

const NOW = Date.now();
const task = (seq: number, state: string): BoardTask => ({ seq, title: `task ${seq}`, state, attempt: 0, maxAttempts: 3, priority: 1, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 });

const sync: SyncStatus = {
  mode: 'sync', host: 'mac-a', hostSource: 'system', state: 'on', lastPushAt: NOW - 120_000, lastPullAt: NOW - 10_000,
  lastError: null, waiting: 4, skipped: 2, refused: 0, fullPush: false, machines: [{ host: 'mac-b', teams: 3 }],
};

function source(over: Partial<TeamBoardSource> = {}): TeamBoardSource {
  return {
    info: async () => ({ host: 'mac-a', mode: 'sync', backend: 'sqlite' }),
    teams: async () => [
      { team: 't1', teamName: 'mine', updatedTs: NOW, homeHost: 'mac-a' },
      { team: 'r1', teamName: 'theirs', updatedTs: NOW - 5, homeHost: 'mac-b', mirror: true, syncedAt: NOW - 60_000 },
    ],
    tasks: async () => ({ tasks: [task(1, 'claimed'), task(2, 'failed')] }),
    events: async () => [],
    posts: async () => [],
    history: async () => [],
    refusals: async () => [],
    act: vi.fn(async () => ({ ok: true as const })),
    postNote: async () => ({ ok: true }),
    syncStatus: async () => sync,
    ...over,
  };
}

const props = (src: TeamBoardSource, extra: Partial<TeamStatusViewProps> = {}): TeamStatusViewProps => ({
  source: src, locale: 'en', surface: 'tinted', projectId: 'P1', projectTeamIds: [],
  membersOf: () => [], limits: { children: { used: 0, max: 6, parent: '', perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
  staleMs: 30 * 60_000, onJump: vi.fn(), onOpenSettings: vi.fn(), onCopy: vi.fn(), ...extra,
});

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

describe('Machines card (sync)', () => {
  it('shows the sync state, times, waiting and skipped rows and other machines', () => {
    render(<MachinesCard mode="sync" sync={sync} now={NOW} locale="en" t={makeT('en')} onOpenSettings={() => {}} />);
    const card = screen.getByRole('region', { name: 'Computers' });
    expect(card.getAttribute('data-sync-state')).toBe('on');
    expect(within(card).getByText('This computer: mac-a')).toBeTruthy();
    expect(within(card).getByText('2m ago')).toBeTruthy();
    expect(within(card).getByText('just now')).toBeTruthy();
    expect(within(card).getByText('4')).toBeTruthy();
    expect(within(card).getByText('Rows skipped')).toBeTruthy();
    expect(within(card).getByText('mac-b: 3 team(s)')).toBeTruthy();
  });

  it('shows the last error and the paused state in Korean without jargon', () => {
    render(<MachinesCard mode="sync" sync={{ ...sync, state: 'paused', lastError: 'another machine uses the name mac-a; set a machine name in Settings' }} now={NOW} locale="ko" t={makeT('ko')} onOpenSettings={() => {}} />);
    const card = screen.getByRole('region', { name: '컴퓨터' });
    expect(within(card).getByText('멈춤')).toBeTruthy();
    expect(within(card).getByText('마지막 올리기')).toBeTruthy();
    expect(within(card).getByText('다른 컴퓨터 (여기서는 읽기 전용)')).toBeTruthy();
    expect(card.textContent).not.toMatch(/미러|푸시|호스트|맥/);
  });

  it('says sync is off on a local-only board', () => {
    render(<MachinesCard mode="sqlite" sync={{ ...sync, mode: 'sqlite', state: 'off', machines: [] }} now={NOW} locale="en" t={makeT('en')} onOpenSettings={() => {}} />);
    expect(screen.getByText('Sync is off (this computer only)')).toBeTruthy();
  });
});

describe('Team status view with teams of other machines', () => {
  it('groups the selector and shows a team of another machine read-only, without human actions', async () => {
    const src = source();
    localStorage.setItem('octo.teamStatus.team:P1', 'r1');
    render(<TeamStatusView {...props(src)} />);
    await settle();
    await settle();
    const select = screen.getByRole('combobox', { name: 'Choose a team' });
    const groups = select.querySelectorAll('optgroup');
    expect([...groups].map((g) => g.getAttribute('label'))).toEqual(['This computer', 'Other computers (read-only)']);
    expect(groups[1].textContent).toContain('theirs');
    expect(screen.getByTestId('ts-readonly-chip').textContent).toContain('read-only');
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it("keeps a person's actions on this machine's team", async () => {
    const src = source();
    localStorage.setItem('octo.teamStatus.team:P1', 't1');
    render(<TeamStatusView {...props(src)} />);
    await settle();
    await settle();
    expect(screen.queryByTestId('ts-readonly-chip')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Add task/ }).length).toBeGreaterThan(0);
  });
});

describe('badges with teams of other machines', () => {
  it('never counts items of a read-only team', async () => {
    const { readTeamWatch } = await import('./watch');
    const { badgeCount } = await import('./model');
    const w = await readTeamWatch(source(), NOW, 30 * 60_000);
    expect(badgeCount(w.needs.get('t1') || [])).toBeGreaterThan(0);
    expect(badgeCount(w.needs.get('r1') || [])).toBe(0);
  });
});

describe('sync status hook and pop-out', () => {
  it('polls, drops an answer that arrives after the key changed, and stops on unmount', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useSyncStatus } = await import('./source');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers: Array<(v: unknown) => void> = [];
    const read = vi.fn(() => new Promise<unknown>((r) => answers.push(r)));
    const { result, rerender, unmount } = renderHook(({ k }) => useSyncStatus(read, { key: k, poll: true, pollMs: 1_000 }), { initialProps: { k: 'sqlite' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(answers.length).toBe(1);
    // The usage type changes while the first read is out: its late answer is dropped.
    rerender({ k: 'sync' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(answers.length).toBe(2);
    await act(async () => { answers[1]({ ...sync, waiting: 9 }); });
    await act(async () => { answers[0]({ ...sync, state: 'offline' }); });
    expect(result.current?.waiting).toBe(9);
    expect(result.current?.state).toBe('on');
    // Polls again later.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(answers.length).toBeGreaterThan(2);
    unmount();
    const calls = read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(read.mock.calls.length).toBe(calls);
    vi.useRealTimers();
  });

  it('serves syncStatus through the pop-out bridge', async () => {
    const { remoteSource, serveRequest } = await import('./popout');
    const src = source();
    const token = 'tok-placeholder';
    let deliver: (res: unknown) => void = () => {};
    const remote = remoteSource(
      (req) => { void serveRequest(src, req, token).then((res) => res && deliver(res)); },
      (on) => { deliver = on as (res: unknown) => void; return () => {}; },
      { token },
    );
    expect(await remote.syncStatus!()).toEqual(sync);
    remote.dispose();
  });
});

describe('team lists with other computers\' teams', () => {
  it('badges a local team even behind 13 newer read-only teams', async () => {
    const { readTeamWatch } = await import('./watch');
    const { badgeCount } = await import('./model');
    const teams = [
      ...Array.from({ length: 13 }, (_, i) => ({ team: `m${i}`, updatedTs: NOW + i, mirror: true, homeHost: 'laptop' })),
      { team: 'local', updatedTs: NOW - 1_000 },
    ];
    const w = await readTeamWatch(source({ teams: async () => teams }), NOW, 30 * 60_000);
    expect(w.teams).toEqual(['local']);
    expect(badgeCount(w.needs.get('local') || [])).toBeGreaterThan(0);
  });

  it('picks this computer\'s team by default and remembers a read-only team only when picked', async () => {
    const { pickDefaultTeam } = await import('./model');
    expect(pickDefaultTeam([{ team: 'r1', updatedTs: 9, mirror: true }, { team: 't1', updatedTs: 1 }], [])).toBe('t1');
    expect(pickDefaultTeam([{ team: 'r1', updatedTs: 9, mirror: true }], [])).toBe('r1');
    render(<TeamStatusView {...props(source())} />);
    await settle();
    await settle();
    expect(localStorage.getItem('octo.teamStatus.team:P1')).toBe('t1');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose a team' }), { target: { value: 'r1' } });
    await settle();
    expect(localStorage.getItem('octo.teamStatus.team:P1')).toBe('r1');
  });

  it('hides drawer actions and the note box on a read-only team, and is read-only until the list loads', async () => {
    const { fireEvent } = await import('@testing-library/react');
    localStorage.setItem('octo.teamStatus.team:P1', 'r1');
    let resolveTeams: (v: unknown) => void = () => {};
    const slow = source({ teams: () => new Promise((r) => { resolveTeams = r as (v: unknown) => void; }) as never });
    render(<TeamStatusView {...props(slow)} />);
    await settle();
    expect(screen.queryByRole('button', { name: /Add task/ })).toBeNull();
    await act(async () => { resolveTeams(await source().teams()); });
    await settle();
    await settle();
    const card = screen.getAllByRole('button').find((b) => /task 2/.test(b.textContent || ''));
    expect(card).toBeTruthy();
    fireEvent.click(card!);
    await settle();
    await settle();
    expect(document.body.textContent).toContain('read-only here');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /note/i })).toBeNull();
  });
});
