// The pop-out page with Tauri mocked: it says hello to the main window, renders the view
// from the pushed context, sends reads/actions as requests and re-dispatches board hints.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; event: string; payload: any }>,
  log: [] as Array<{ to: string; event: string; payload: any }>,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  pin: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: async (to: string, event: string, payload: unknown) => { h.sent.push({ to, event, payload }); h.log.push({ to, event, payload }); },
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    label: 'tool-team-status',
    listen: async (name: string, cb: (e: { payload: unknown }) => void) => { h.listeners.set(name, cb); return () => h.listeners.delete(name); },
    setAlwaysOnTop: h.pin,
    setVisibleOnAllWorkspaces: async () => {},
  }),
}));

import TeamStatusPage from './TeamStatusPage';
import { POPOUT_EVENT, type PopoutContext } from '../teamStatus/popout';
import { onAgentBoardChange } from '../terminal/agentBoard';

const NOW = Date.now();
const ctx: PopoutContext = {
  team: 't1', nonce: 1, projectId: 'P1', projectTeamIds: ['t1'], locale: 'en', surface: 'tinted',
  theme: { bg: '#fdf6e3', text: '#073642', accent: '#268bd2', font: 'monospace', light: true },
  staleMs: 1_800_000,
  members: [{ id: 't1', name: 'lead', status: 'idle', open: true }],
  limits: { children: { used: 0, max: 6, perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
  mainPinned: false,
};

/** Answer every request the page sent so far, like the main window does. */
async function answer() {
  const values: Record<string, unknown> = {
    info: { mode: 'sqlite' },
    teams: [{ team: 't1', updatedTs: NOW }],
    tasks: { tasks: [{ seq: 12, title: 'split token', state: 'review', updatedAt: NOW, owner: { id: 't2', name: 'reviewer' } }] },
    events: [], posts: [], refusals: [], history: [],
    act: { ok: true },
  };
  for (const m of h.sent.splice(0).filter((x) => x.event === POPOUT_EVENT.req)) {
    await act(async () => { h.listeners.get(POPOUT_EVENT.res)?.({ payload: { id: m.payload.id, ok: true, value: values[m.payload.method] } }); });
  }
}
const settle = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };

afterEach(() => { cleanup(); h.sent.length = 0; h.log.length = 0; h.listeners.clear(); try { localStorage.clear(); } catch { /* none */ } });

describe('TeamStatusPage (pop-out)', () => {
  it('waits for the main window, then shows the team in the owning project theme', async () => {
    window.history.replaceState(null, '', '/team-status?team=t1&projectId=P1&token=tk1');
    render(<TeamStatusPage />);
    await settle();
    expect(screen.getByRole('status').textContent).toMatch('Waiting for the main window');
    expect(h.sent.find((m) => m.event === POPOUT_EVENT.hello)).toMatchObject({ to: 'main', payload: { team: 't1', projectId: 'P1', token: 'tk1' } });
    // A malformed context is ignored.
    await act(async () => { h.listeners.get(POPOUT_EVENT.ctx)?.({ payload: { ...ctx, members: 'nope' } }); });
    expect(screen.getByRole('status').textContent).toMatch('Waiting for the main window');
    await act(async () => { h.listeners.get(POPOUT_EVENT.ctx)?.({ payload: ctx }); });
    await settle();
    await answer();
    await settle();
    await answer();
    await settle();
    const root = document.querySelector('.ts-popout') as HTMLElement;
    expect(root.classList.contains('light-theme')).toBe(true);
    expect(root.style.getPropertyValue('--bg-color')).toBe('#fdf6e3');
    // A person's action goes to the main window as a request.
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await settle();
    const req = h.sent.find((m) => m.event === POPOUT_EVENT.req && m.payload.method === 'act');
    expect(req).toMatchObject({ to: 'main', payload: { token: 'tk1', args: ['t1', 'approve', { task: 12 }] } });
    // The team shown is reported (the main window sends that team's agents).
    expect(h.log.find((m) => m.event === POPOUT_EVENT.team)).toMatchObject({ to: 'main', payload: { team: 't1' } });
  });

  it('pins the window and re-dispatches board hints in this window', async () => {
    render(<TeamStatusPage />);
    await settle();
    await act(async () => { h.listeners.get(POPOUT_EVENT.ctx)?.({ payload: ctx }); });
    await settle();
    h.pin.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Keep on top' }));
    await settle();
    expect(h.pin).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Stop keeping on top' }).getAttribute('aria-pressed')).toBe('true');
    // The main window's pin keeps it on top too; its own button stays off and says why.
    fireEvent.click(screen.getByRole('button', { name: 'Stop keeping on top' }));
    await settle();
    expect(h.pin).toHaveBeenLastCalledWith(false);
    await act(async () => { h.listeners.get(POPOUT_EVENT.ctx)?.({ payload: { ...ctx, mainPinned: true } }); });
    await settle();
    expect(h.pin).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Keep on top' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('on top with the pinned main window')).toBeTruthy();
    const seen: string[] = [];
    const off = onAgentBoardChange((d) => seen.push(d.team));
    await act(async () => { h.listeners.get(POPOUT_EVENT.board)?.({ payload: { team: 't1', action: 'post' } }); });
    off();
    expect(seen).toEqual(['t1']);
  });
});
