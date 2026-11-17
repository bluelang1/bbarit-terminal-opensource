import { describe, expect, it, vi } from 'vitest';
import { contextKey, isPopoutContext, popoutOnTop, popoutUrl, readPopoutQuery, remoteSource, serveRequest, type PopoutRequest, type PopoutResponse } from './popout';
import type { TeamBoardSource } from './source';

function realSource(): TeamBoardSource & { act: ReturnType<typeof vi.fn>; postNote: ReturnType<typeof vi.fn> } {
  return {
    info: async () => ({ mode: 'sqlite' }),
    teams: async () => [{ team: 't1' }],
    tasks: async (team: string) => ({ tasks: [{ seq: 1, title: `in ${team}`, state: 'open' }] }),
    events: async () => [],
    posts: async () => [],
    history: async (_team: string, seq: number) => [{ ts: 1, action: 'add', task: seq }],
    refusals: async () => { throw new Error('log unreadable'); },
    act: vi.fn(async () => ({ ok: true as const })),
    postNote: vi.fn(async () => ({ ok: true as const })),
  } as never;
}

/** The two windows wired back to back (what Tauri events do in the app). */
function wire(main: TeamBoardSource, opts: { drop?: boolean; token?: string } = {}) {
  let deliver: ((r: PopoutResponse) => void) | null = null;
  const sent: PopoutRequest[] = [];
  const remote = remoteSource(
    (req) => {
      sent.push(req);
      if (opts.drop) return;
      void serveRequest(main, JSON.parse(JSON.stringify(req)), 'tok').then((res) => { if (res) deliver?.(JSON.parse(JSON.stringify(res))); });
    },
    (cb) => { deliver = cb; return () => { deliver = null; }; },
    { timeoutMs: 50, idPrefix: 'x', token: opts.token ?? 'tok' },
  );
  return { remote, sent };
}

describe('pop-out protocol', () => {
  it('reads through the main window and round-trips values', async () => {
    const { remote, sent } = wire(realSource());
    expect(await remote.teams()).toEqual([{ team: 't1' }]);
    expect((await remote.tasks('t9')).tasks[0].title).toBe('in t9');
    expect(await remote.history('t1', 4)).toEqual([{ ts: 1, action: 'add', task: 4 }]);
    expect(new Set(sent.map((r) => r.id)).size).toBe(sent.length);
  });

  it('turns a failing read into a rejected promise (the view shows the board as unavailable)', async () => {
    const { remote } = wire(realSource());
    await expect(remote.refusals()).rejects.toThrow('log unreadable');
  });

  it("runs a person's actions only, and reports a lost answer as a failed action", async () => {
    const main = realSource();
    const { remote } = wire(main);
    expect(await remote.act('t1', 'approve', { task: 3 })).toEqual({ ok: true });
    expect(main.act).toHaveBeenCalledWith('t1', 'approve', { task: 3 });
    expect(await remote.act('t1', 'claim' as never, { task: 3 })).toEqual({ ok: false, error: "not a person's action" });
    expect(main.act).toHaveBeenCalledTimes(1);
    expect(await remote.postNote('t1', 'hello')).toEqual({ ok: true });
    const lost = wire(main, { drop: true });
    expect(await lost.remote.act('t1', 'retry', { task: 1 })).toEqual({ ok: false, error: 'the main window did not answer' });
    await expect(lost.remote.teams()).rejects.toThrow('did not answer');
  });

  it('refuses unknown methods and malformed requests', async () => {
    const main = realSource();
    const T = 'tok';
    expect(await serveRequest(main, null, T)).toBeNull();
    expect(await serveRequest(main, { id: 'a', token: T, method: 'constructor', args: [] }, T)).toEqual({ id: 'a', ok: false, error: 'unknown request' });
    expect(await serveRequest(main, { id: 'b', token: T, method: 'teams' }, T)).toEqual({ id: 'b', ok: false, error: 'unknown request' });
    expect(await serveRequest(main, { id: 'c', token: T, method: 'history', args: ['t1', 'x'] }, T)).toEqual({ id: 'c', ok: false, error: 'bad task' });
    expect(await serveRequest(main, { id: 'd', token: T, method: 'act', args: ['t1', 'approve', 'no'] }, T)).toMatchObject({ ok: true, value: { ok: false } });
  });

  it('ignores requests without the current per-open token', async () => {
    const main = realSource();
    const approve = { id: 'e', method: 'act', args: ['t1', 'approve', { task: 3 }] };
    expect(await serveRequest(main, approve, 'tok')).toBeNull();
    expect(await serveRequest(main, { ...approve, token: 'old' }, 'tok')).toBeNull();
    expect(await serveRequest(main, { ...approve, token: 'tok' }, null)).toBeNull();
    expect(main.act).not.toHaveBeenCalled();
    expect(await serveRequest(main, { ...approve, token: 'tok' }, 'tok')).toEqual({ id: 'e', ok: true, value: { ok: true } });
    // A pop-out holding another token gets no answer (its calls time out as failures).
    const { remote } = wire(main, { token: 'stale' });
    expect(await remote.act('t1', 'approve', { task: 3 })).toEqual({ ok: false, error: 'the main window did not answer' });
    expect(main.act).toHaveBeenCalledTimes(1);
  });

  it('decides on-top from its own pin or the main pin', () => {
    expect(popoutOnTop(false, false)).toEqual({ onTop: false, fromMain: false });
    expect(popoutOnTop(true, false)).toEqual({ onTop: true, fromMain: false });
    expect(popoutOnTop(false, true)).toEqual({ onTop: true, fromMain: true });
    expect(popoutOnTop(true, true)).toEqual({ onTop: true, fromMain: false });
  });

  it('accepts only a well-formed context', () => {
    const ok = {
      team: 't1', nonce: 0, projectId: 'P', projectTeamIds: ['t1'], locale: 'en', surface: 'tinted', staleMs: 1, mainPinned: false,
      theme: { bg: '#000', text: '#fff', accent: '#f00', font: 'mono', light: false },
      members: [{ id: 't1', name: 'lead', status: 'idle', open: true }],
      limits: { children: { used: 0, max: 6, perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
    };
    expect(isPopoutContext(ok)).toBe(true);
    expect(isPopoutContext(null)).toBe(false);
    expect(isPopoutContext({ ...ok, members: 'x' })).toBe(false);
    expect(isPopoutContext({ ...ok, members: [{ id: 1 }] })).toBe(false);
    expect(isPopoutContext({ ...ok, limits: { children: {}, depth: {}, total: {} } })).toBe(false);
    expect(isPopoutContext({ ...ok, projectTeamIds: [1] })).toBe(false);
    expect(isPopoutContext({ ...ok, theme: { bg: '#000' } })).toBe(false);
    expect(isPopoutContext({ ...ok, surface: 'pink' })).toBe(false);
    expect(isPopoutContext({ ...ok, mainPinned: 'yes' })).toBe(false);
  });

  it('builds and reads the route, and keys the context', () => {
    const url = popoutUrl('http://localhost:1420', 't 1&x', 'P1', 'abc');
    expect(url).toBe('http://localhost:1420/team-status?team=t+1%26x&projectId=P1&token=abc');
    expect(readPopoutQuery(new URL(url).search)).toEqual({ team: 't 1&x', projectId: 'P1', token: 'abc' });
    expect(contextKey(null)).toBe('');
  });

  it('dispose rejects what is still waiting', async () => {
    const { remote } = wire(realSource(), { drop: true });
    const p = remote.info();
    remote.dispose();
    await expect(p).rejects.toThrow('closed');
  });
});
