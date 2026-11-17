import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../terminal/agentTasks';
import { emitAgentBoardEvent } from '../terminal/agentBoard';
import type { TeamBoardSource } from './source';
import { loadTeamBoard } from './source';
import { TeamStatusView, type TeamStatusViewProps } from './TeamStatusView';
import { readTeamWatch } from './watch';

const NOW = Date.now();
const task = (seq: number, state: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  seq, title: `task ${seq}`, state, attempt: 0, maxAttempts: 3, priority: 1, createdAt: NOW - 3_600_000, updatedAt: NOW - 240_000, ...extra,
});

function fakeSource(over: Partial<TeamBoardSource> = {}): TeamBoardSource & { act: ReturnType<typeof vi.fn> } {
  const act = vi.fn(async () => ({ ok: true as const }));
  return {
    info: async () => ({ host: 'h', mode: 'sqlite', backend: 'sqlite' }),
    teams: async () => [{ team: 't1', teamName: 'lead', updatedTs: NOW }],
    tasks: async () => ({ tasks: [task(12, 'review', { owner: { id: 't2', name: 'reviewer' } }), task(9, 'failed', { attempt: 2, lastError: 'lint exit 1' }), task(3, 'done')] }),
    events: async () => [{ id: 'e1', ts: NOW - 60_000, action: 'submit', task: 12, to: 'review', actor: { id: 't2', name: 'reviewer' } }],
    posts: async () => [{ seq: 1, ts: NOW - 30_000, kind: 'note', text: 'found flaky test', author: { id: 't3', name: 'tester' } }],
    history: async () => [],
    refusals: async () => [],
    postNote: async () => ({ ok: true }),
    ...over,
    act: (over.act as never) ?? act,
  } as TeamBoardSource & { act: ReturnType<typeof vi.fn> };
}

const props = (source: TeamBoardSource, extra: Partial<TeamStatusViewProps> = {}): TeamStatusViewProps => ({
  source,
  locale: 'en',
  surface: 'tinted',
  projectId: 'P1',
  projectTeamIds: ['t1'],
  membersOf: () => [{ id: 't1', name: 'lead', status: 'idle', open: true }, { id: 't4', name: 'builder', status: 'blocked', open: true, message: 'which DB url?' }],
  limits: { children: { used: 2, max: 6, parent: 't1', perParent: [{ id: 't1', n: 2 }] }, depth: { used: 1, max: 2 }, total: { used: 2, max: 12 } },
  staleMs: 30 * 60_000,
  onJump: vi.fn(),
  onOpenSettings: vi.fn(),
  onCopy: vi.fn(),
  ...extra,
});

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });

const settle = async () => { await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); }); };

describe('TeamStatusView', () => {
  it('shows Needs you in severity order and approves a review as a person', async () => {
    const src = fakeSource();
    render(<TeamStatusView {...props(src)} />);
    await settle();
    await settle();
    const titles = screen.getAllByText(/#9 failed|builder is waiting|#12 review/).map((e) => e.textContent);
    expect(titles[0]).toMatch(/#9 failed \(try 3\/3\)/); // attempt 2 = third try
    expect(titles[1]).toMatch(/builder is waiting/);
    expect(titles[2]).toMatch(/#12 review/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await settle();
    expect(src.act).toHaveBeenCalledWith('t1', 'approve', { task: 12 });
    // The state bar is an image with a sentence; its segments are filter buttons.
    expect(screen.getByRole('img', { name: /3 tasks: 1 done, 1 review, 1 failed/ })).toBeTruthy();
  });

  it('asks for a reason before rejecting', async () => {
    const src = fakeSource();
    render(<TeamStatusView {...props(src)} />);
    await settle();
    await settle();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
    const send = screen.getByRole('button', { name: 'Send reject' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'add a test' } });
    fireEvent.click(send);
    await settle();
    expect(src.act).toHaveBeenCalledWith('t1', 'reject', { reason: 'add a test', task: 12 });
  });

  it('shows the unavailable banner and greys the last snapshot', async () => {
    let fail = false;
    const src = fakeSource({
      tasks: async () => { if (fail) throw new Error('team board unavailable: connection refused'); return { tasks: [task(1, 'claimed')] }; },
    });
    render(<TeamStatusView {...props(src)} />);
    await settle();
    await settle();
    fail = true;
    await act(async () => { emitAgentBoardEvent({ team: 't1', action: 'task' }); });
    await settle();
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('Team board unavailable: connection refused');
    expect(screen.getByText(/^as of /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
  });

  it('shows the empty state when there is no team', async () => {
    const src = fakeSource({ teams: async () => [] });
    const p = props(src);
    render(<TeamStatusView {...p} />);
    await settle();
    await settle();
    expect(screen.getByText('No agent team in this project')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }));
    expect(p.onCopy).toHaveBeenCalled();
  });
});

describe('loadTeamBoard / readTeamWatch', () => {
  it('keeps team list and refusal failures from hiding the team, reports board errors', async () => {
    const src = fakeSource({ refusals: async () => { throw new Error('x'); } });
    const ok = await loadTeamBoard(src, 't1', () => 5);
    expect(ok.error).toBeNull();
    expect(ok.snapshot?.tasks).toHaveLength(3);
    expect(ok.snapshot?.at).toBe(5);
    const bad = await loadTeamBoard(fakeSource({ events: async () => { throw 'team board unavailable: pg down'; } }), 't1', () => 5);
    expect(bad.error).toBe('pg down');
    expect(bad.snapshot).toBeNull();
  });

  it('reads at most the 12 most recent teams for badges', async () => {
    const teams = Array.from({ length: 15 }, (_, i) => ({ team: `t${i}`, updatedTs: i }));
    const seen: string[] = [];
    const w = await readTeamWatch({ teams: async () => teams, tasks: async (tm) => { seen.push(tm); return { tasks: [] }; } }, NOW, 60_000);
    expect(w.teams).toHaveLength(12);
    expect(w.teams[0]).toBe('t14');
    expect(seen).toHaveLength(12);
  });
});

describe('review fixes (stage 4a)', () => {
  const openDrawer = async (seq: number) => {
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(`^#${seq} `) })[0]);
    await settle();
  };

  it('drawer: cancel asks first, edit sends the version, reopen a done task', async () => {
    const src = fakeSource({
      tasks: async () => ({ tasks: [task(5, 'claimed', { version: 4, body: 'b' }), task(3, 'done')] }),
    });
    render(<TeamStatusView {...props(src)} />);
    await settle(); await settle();
    await openDrawer(5);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(src.act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    await settle();
    expect(src.act).toHaveBeenCalledWith('t1', 'cancel', { task: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    expect(src.act).toHaveBeenCalledWith('t1', 'edit', { title: 'renamed', body: 'b', priority: 1, expectedVersion: 4, task: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
    await openDrawer(3);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await settle();
    expect(src.act).toHaveBeenCalledWith('t1', 'reopen', { task: 3 });
  });

  it('posts a note as a person', async () => {
    const postNote = vi.fn(async () => ({ ok: true as const }));
    render(<TeamStatusView {...props(fakeSource({ postNote }))} />);
    await settle(); await settle();
    const box = screen.getAllByLabelText('Note to the team')[0];
    fireEvent.change(box, { target: { value: 'please rebase' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Post note' })[0]);
    await settle();
    expect(postNote).toHaveBeenCalledWith('t1', 'please rebase');
  });

  it('shows only this team\'s refusals in Needs you', async () => {
    const src = fakeSource({
      refusals: async () => [
        { ts: NOW - 60_000, limit: 'maxChildren', caller: { id: 't4', name: 'builder' } },
        { ts: NOW - 60_000, limit: 'maxTotal', caller: { id: 'someone-else' } },
      ],
    });
    render(<TeamStatusView {...props(src)} />);
    await settle(); await settle();
    expect(screen.getAllByText(/adding an agent hit a limit: children/)).toHaveLength(1);
    expect(screen.queryByText(/adding an agent hit a limit: total/)).toBeNull();
  });

  it('narrow layout renders no hidden cards: unique ids and no off-screen tab stops', async () => {
    const RO = globalThis.ResizeObserver;
    class FakeRO { cb: ResizeObserverCallback; constructor(cb: ResizeObserverCallback) { this.cb = cb; } observe() { this.cb([{ contentRect: { width: 420 } } as ResizeObserverEntry], this as never); } disconnect() {} unobserve() {} }
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
    try {
      const { container } = render(<TeamStatusView {...props(fakeSource())} />);
      await settle(); await settle();
      expect(container.querySelector('.ts-area-agents')).toBeNull();
      expect(container.querySelector('.ts-area-band')).toBeNull();
      const ids = Array.from(container.querySelectorAll('[id]')).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(screen.getAllByRole('tab').map((e) => e.textContent)).toEqual(['Agents', 'Tasks', 'Activity', 'Dependencies', 'Timeline', 'Limits']);
    } finally {
      (globalThis as { ResizeObserver: unknown }).ResizeObserver = RO;
    }
  });
});
