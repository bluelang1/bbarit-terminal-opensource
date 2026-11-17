import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardTask } from '../terminal/agentTasks';
import { deriveTaskViews } from './model';
import type { TeamBoardSource } from './source';
import { DependencyTree, DependencyView } from './DependencyView';
import { TeamStatusView, type TeamStatusViewProps } from './TeamStatusView';
import { makeT } from './strings';

const NOW = Date.now();
const M = 60_000;
const task = (seq: number, state: string, deps: Array<[number, string]> = [], extra: Partial<BoardTask> = {}): BoardTask => ({
  seq, title: `task ${seq}`, state, attempt: 0, maxAttempts: 3, priority: 1, createdAt: NOW - 60 * M, updatedAt: NOW - 4 * M,
  deps: deps.map(([s, st]) => ({ seq: s, state: st })), ...extra,
});

const TASKS = [
  task(1, 'done'),
  task(2, 'claimed', [[1, 'done']], { owner: { id: 't3', name: 'builder' } }),
  task(3, 'open', [[2, 'claimed']]),
  task(4, 'failed'),
  task(5, 'open', [[4, 'failed']]),
];

function source(): TeamBoardSource {
  return {
    info: async () => ({ host: 'h', mode: 'sqlite', backend: 'sqlite' }),
    teams: async () => [{ team: 't1', teamName: 'lead', updatedTs: NOW }],
    tasks: async () => ({ tasks: TASKS }),
    events: async () => [
      { id: 'a1', seq: 1, ts: NOW - 50 * M, task: 1, action: 'add', from: null, to: 'open' },
      { id: 'a2', seq: 2, ts: NOW - 49 * M, task: 2, action: 'add', from: null, to: 'open' },
      { id: 'c1', seq: 3, ts: NOW - 40 * M, task: 1, action: 'claim', from: 'open', to: 'claimed' },
      { id: 's1', seq: 4, ts: NOW - 30 * M, task: 1, action: 'submit', from: 'claimed', to: 'review' },
      { id: 'p1', seq: 5, ts: NOW - 20 * M, task: 1, action: 'approve', from: 'review', to: 'done' },
      { id: 'c2', seq: 6, ts: NOW - 10 * M, task: 2, action: 'claim', from: 'open', to: 'claimed' },
    ],
    posts: async () => [],
    history: async () => [],
    refusals: async () => [],
    act: async () => ({ ok: true }),
    postNote: async () => ({ ok: true }),
  };
}

const props = (extra: Partial<TeamStatusViewProps> = {}): TeamStatusViewProps => ({
  source: source(),
  locale: 'en',
  surface: 'tinted',
  projectId: 'P1',
  projectTeamIds: ['t1'],
  membersOf: () => [{ id: 't1', name: 'lead', status: 'idle', open: true }],
  limits: { children: { used: 0, max: 6, perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
  staleMs: 30 * M,
  onJump: vi.fn(),
  onOpenSettings: vi.fn(),
  onCopy: vi.fn(),
  ...extra,
});

const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });

describe('Dependencies tab', () => {
  it('draws the graph as an image with a sentence, nodes as buttons that open the task', async () => {
    render(<TeamStatusView {...props()} />);
    await settle();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependencies' }));
    // 1 -> 2 -> 3 and 4 -> 5: five tasks, three steps; #3 and #5 wait, #5 on a failed task.
    expect(screen.getByRole('img', { name: '5 tasks in 3 steps: 2 waiting on others, 1 waiting on a failed task' })).toBeTruthy();
    const node2 = screen.getByRole('button', { name: /^#2 task 2, working, builder/ });
    expect(screen.getByRole('button', { name: /^#5 task 5, waiting, waits on #4, waits on a failed task/ })).toBeTruthy();
    // One tab stop in the graph (roving), arrow keys walk it.
    const node1 = screen.getByRole('button', { name: /^#1 task 1, done/ });
    expect(node1.tabIndex).toBe(0);
    expect(node2.tabIndex).toBe(-1);
    node1.focus();
    fireEvent.keyDown(node1, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node2);
    fireEvent.keyDown(node2, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(node1);
    // Focus lights the chain and dims the rest.
    act(() => { node2.focus(); });
    expect(screen.getByRole('button', { name: /^#5 task 5/ }).className).toContain('ts-dim');
    expect(node1.className).not.toContain('ts-dim');
    // The failed dependency's edge carries the marker.
    expect(document.querySelector('.ts-dag-edge[data-from="4"][data-to="5"]')?.classList.contains('ts-failed-edge')).toBe(true);
    fireEvent.click(node2);
    await settle();
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: '#2 task 2' })).toBeTruthy();
  });

  it('has a table alternative and a list mode', async () => {
    render(<TeamStatusView {...props()} />);
    await settle();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependencies' }));
    const panel = document.getElementById('ts-main-panel')!;
    fireEvent.click(within(panel).getByRole('button', { name: 'Table' }));
    const table = within(panel).getByRole('table');
    expect(within(table).getByText('#4')).toBeTruthy(); // #5 depends on #4
    fireEvent.click(within(panel).getByRole('button', { name: 'Chart' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'List' }));
    expect(screen.getByRole('tree', { name: '5 tasks: 2 waiting on others, 1 waiting on a failed task' })).toBeTruthy();
  });

  it('falls back to the list when narrow and says why', () => {
    const t = makeT('en');
    const v = deriveTaskViews(TASKS, NOW, 30 * M);
    render(<DependencyView visible={v} all={v} narrow locale="en" t={t} onOpen={() => {}} />);
    expect(screen.getByText('Shown as a list in a narrow window.')).toBeTruthy();
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('shows an edited title and a new owner without a state change (only the shape is cached)', () => {
    const t = makeT('en');
    const v1 = deriveTaskViews(TASKS, NOW, 30 * M);
    const { rerender } = render(<DependencyView visible={v1} all={v1} narrow={false} locale="en" t={t} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /^#3 task 3, waiting, waits on #2/ })).toBeTruthy();
    const edited = TASKS.map((x) => (x.seq === 3 ? { ...x, title: 'renamed', owner: { id: 't9', name: 'newbie' } } : x));
    const v2 = deriveTaskViews(edited, NOW, 30 * M);
    rerender(<DependencyView visible={v2} all={v2} narrow={false} locale="en" t={t} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /^#3 renamed, waiting, newbie, waits on #2/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getAllByRole('treeitem')[0].getAttribute('aria-label')).toMatch(/^#3 renamed, waiting, newbie/);
  });

  it('keeps the keyboard focus highlight when the mouse leaves another node', () => {
    const t = makeT('en');
    const v = deriveTaskViews(TASKS, NOW, 30 * M);
    render(<DependencyView visible={v} all={v} narrow={false} locale="en" t={t} onOpen={() => {}} />);
    const n2 = screen.getByRole('button', { name: /^#2 / });
    const n5 = screen.getByRole('button', { name: /^#5 / });
    act(() => { n2.focus(); });
    fireEvent.mouseEnter(n5);
    fireEvent.mouseLeave(n5);
    expect(n2.className).toContain('ts-hi');
    expect(n5.className).toContain('ts-dim');
  });

  it('walks the tree with the keyboard', () => {
    const t = makeT('en');
    const onOpen = vi.fn();
    const v = deriveTaskViews(TASKS, NOW, 30 * M);
    render(<DependencyTree visible={v} all={v} label="deps" locale="en" t={t} onOpen={onOpen} />);
    const items = () => screen.getAllByRole('treeitem');
    // Roots: #3 (waits on #2, which waits on #1) and #5 (waits on #4).
    expect(items().map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '3', '1', '2']);
    const root3 = items()[0];
    expect(root3.tabIndex).toBe(0);
    expect(root3.getAttribute('aria-expanded')).toBe('true');
    root3.focus();
    fireEvent.keyDown(root3, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
    expect(items()[1].getAttribute('aria-label')).toMatch(/^waits on #2 task 2, working, builder/);
    fireEvent.keyDown(items()[1], { key: 'ArrowLeft' }); // collapse #2
    expect(items()[1].getAttribute('aria-expanded')).toBe('false');
    expect(items().length).toBe(4);
    fireEvent.keyDown(items()[1], { key: 'ArrowLeft' }); // to the parent
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(items()[0], { key: 'End' });
    expect(document.activeElement).toBe(items()[3]);
    fireEvent.keyDown(items()[3], { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith(4);
  });
});

describe('Timeline tab', () => {
  it('shows the burn-up and time-in-state charts with sentences and tables', async () => {
    render(<TeamStatusView {...props()} />);
    await settle();
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(screen.getByRole('img', { name: /tasks in scope, 1 done, 0 in review$/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /^2 tasks from .* to now \(1 finished, faded after they finished\): median time in review 10m, blocked -$/ })).toBeTruthy();
    expect(screen.getByText(/^Median time in review: 10m · blocked: -/)).toBeTruthy();
    // #1 finished: its lane carries a faded done segment up to now.
    expect(document.querySelector('.ts-seg-span.ts-after[data-state="done"]')).toBeTruthy();
    const toggles = within(document.getElementById('ts-main-panel')!).getAllByRole('button', { name: 'Table' });
    expect(toggles.length).toBe(2);
    fireEvent.click(toggles[1]);
    const table = within(document.getElementById('ts-main-panel')!).getByRole('table');
    expect(within(table).getByText('#1')).toBeTruthy();
    expect(within(table).getAllByText('10m').length).toBeGreaterThan(0);
  });

  it('shows 30 lanes, then more', async () => {
    const { TimeInState } = await import('./TimelineView');
    const lanes = Array.from({ length: 35 }, (_, i) => ({ seq: i + 1, start: NOW - 10 * M, end: NOW, segments: [{ state: 'open' as const, from: NOW - 10 * M, to: NOW }], last: 'open' as const, claims: 0 }));
    render(<TimeInState lanes={lanes} now={NOW} locale="ko" t={makeT('ko')} />);
    expect(document.querySelectorAll('.ts-lane:not(.ts-lane-axis)').length).toBe(30);
    fireEvent.click(screen.getByRole('button', { name: '5개 더 보기' }));
    expect(document.querySelectorAll('.ts-lane:not(.ts-lane-axis)').length).toBe(35);
  });
});
