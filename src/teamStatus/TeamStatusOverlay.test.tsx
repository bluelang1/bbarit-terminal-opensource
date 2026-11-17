import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamBoardSource } from './source';
import { TeamStatusOverlay } from './TeamStatusOverlay';
import type { TeamStatusViewProps } from './TeamStatusView';

const NOW = Date.now();
const src = {
  info: async () => ({ mode: 'sqlite' }),
  teams: async () => [{ team: 't1', updatedTs: NOW }],
  tasks: async () => ({ tasks: [{ seq: 12, title: 'split token', state: 'review', updatedAt: NOW, owner: { id: 't2' } }] }),
  events: async () => [],
  posts: async () => [],
  history: async () => [],
  refusals: async () => [],
  act: async () => ({ ok: true }),
  postNote: async () => ({ ok: true }),
} as unknown as TeamBoardSource;

const view: TeamStatusViewProps = {
  source: src, locale: 'en', surface: 'tinted', projectId: 'P', projectTeamIds: ['t1'], membersOf: () => [],
  limits: { children: { used: 0, max: 6, perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
  staleMs: 1_800_000, onJump: () => {}, onOpenSettings: () => {}, onCopy: () => {},
};
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const esc = () => act(() => { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });

describe('TeamStatusOverlay Esc', () => {
  it('closes the reject form, then the drawer, then the overlay', async () => {
    const onClose = vi.fn();
    render(<TeamStatusOverlay initialTab="team" onClose={onClose} onOpenExternal={() => {}} view={view} />);
    await settle(); await settle();
    fireEvent.click(screen.getAllByRole('button', { name: /^#12 / })[0]);
    await settle();
    expect(screen.getByRole('complementary')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' }).at(-1)!);
    fireEvent.change(screen.getAllByLabelText('Reason (required)').at(-1)!, { target: { value: 'typed' } });
    esc();
    expect(screen.queryByLabelText('Reason (required)')).toBeNull();
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dashboard mounted once opened and does not read the board on the Dashboard tab', async () => {
    const teams = vi.spyOn(src, 'teams');
    const onTab = vi.fn();
    render(<TeamStatusOverlay initialTab="dashboard" onClose={() => {}} onOpenExternal={() => {}} onTabChange={onTab} view={view} />);
    await settle();
    expect(teams).not.toHaveBeenCalled();
    expect(onTab).toHaveBeenLastCalledWith('dashboard');
    const frame = document.querySelector('iframe');
    fireEvent.click(screen.getByRole('tab', { name: 'Team status' }));
    await settle();
    fireEvent.click(screen.getByRole('tab', { name: 'Dashboard' }));
    expect(document.querySelector('iframe')).toBe(frame);
  });
});

describe('TeamStatusOverlay pop-out', () => {
  it('offers the pop-out on the Team status tab, and shows [Bring to front] while popped out', async () => {
    const onPopOut = vi.fn();
    const onFront = vi.fn();
    const { rerender } = render(<TeamStatusOverlay initialTab="team" onClose={() => {}} onOpenExternal={() => {}} onPopOut={onPopOut} onBringToFront={onFront} view={view} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Open in its own window' }));
    expect(onPopOut).toHaveBeenCalledTimes(1);
    rerender(<TeamStatusOverlay initialTab="team" onClose={() => {}} onOpenExternal={() => {}} poppedOut onPopOut={onPopOut} onBringToFront={onFront} view={view} />);
    await settle();
    expect(screen.getByText('Team status is open in its own window.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in its own window' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bring to front' }));
    expect(onFront).toHaveBeenCalledTimes(1);
  });
});
