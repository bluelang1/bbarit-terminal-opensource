import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncStatus } from '../terminal/agentBoardStorage';
import { canOfferTakeover } from '../terminal/agentBoardStorage';
import type { OutboxEntry, TeamBoardSource } from './source';
import { TeamStatusView, type TeamStatusViewProps } from './TeamStatusView';

const NOW = Date.now();
const HOUR = 3_600_000;

const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  mode: 'sync', host: 'mac-a', hostSource: 'system', state: 'on', lastPushAt: NOW, lastPullAt: NOW, lastError: null,
  waiting: 0, skipped: 0, refused: 0, fullPush: false, machines: [{ host: 'mac-b', teams: 1 }],
  outboxWaiting: 0, outboxRefused: 0, serverSchema: 4, codeSchema: 4, hosts: [{ host: 'mac-b', lastSeen: NOW - 30 * HOUR, ageMs: 30 * HOUR }], adoptAfterMs: 24 * HOUR, keptRows: 0, keptFile: null, serverEvent: null, serverEventAt: null,
  ...over,
});

const outbox: OutboxEntry[] = [
  { id: 'o1', team: 'r1', home: 'mac-b', text: 'please look at #3', ts: NOW - 1_000, state: 'sent', author: { id: 'user', name: 'user' } },
  { id: 'o2', team: 'r1', home: 'mac-b', text: 'too late', ts: NOW - 500, state: 'refused', reason: 'expired', author: { id: 'user', name: 'user' } },
];

function source(over: Partial<TeamBoardSource> = {}, st: SyncStatus = sync()): TeamBoardSource {
  return {
    info: async () => ({ host: 'mac-a', mode: 'sync', backend: 'sqlite' }),
    teams: async () => [{ team: 'r1', teamName: 'theirs', updatedTs: NOW, homeHost: 'mac-b', mirror: true, syncedAt: NOW - 60_000 }],
    tasks: async () => ({ tasks: [] }),
    events: async () => [],
    posts: async () => [{ seq: 4, ts: NOW - 2_000, kind: 'note', text: 'hello from a', author: { id: 'u', name: 'user', host: 'mac-a' } }],
    history: async () => [],
    refusals: async () => [],
    act: vi.fn(async () => ({ ok: true as const })),
    postNote: vi.fn(async () => ({ ok: true as const })),
    syncStatus: async () => st,
    outbox: vi.fn(async () => outbox),
    dismissOutbox: vi.fn(async () => ({ ok: true as const })),
    adoptPreview: vi.fn(async () => ({ team: 'r1', teamName: 'theirs', uid: 'uid-1', home: 'mac-b', version: 7, lastSeen: NOW - 30 * HOUR, ageMs: 30 * HOUR, adoptAfterMs: 24 * HOUR, allowed: true })),
    adopt: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

const props = (src: TeamBoardSource): TeamStatusViewProps => ({
  source: src, locale: 'en', surface: 'tinted', projectId: 'P3', projectTeamIds: [],
  membersOf: () => [], limits: { children: { used: 0, max: 6, parent: '', perParent: [] }, depth: { used: 0, max: 2 }, total: { used: 0, max: 12 } },
  staleMs: 30 * 60_000, onJump: vi.fn(), onOpenSettings: vi.fn(), onCopy: vi.fn(),
});

afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });
const settle = async () => { for (let i = 0; i < 3; i++) await act(async () => { for (let j = 0; j < 8; j++) await Promise.resolve(); }); };

describe('remote notes on another computer\'s team', () => {
  it('lets a person post a note on a copy and marks waiting and refused notes', async () => {
    const src = source();
    render(<TeamStatusView {...props(src)} />);
    await settle();
    const list = screen.getByTestId('ts-outbox');
    expect(list.textContent).toContain('waiting to be delivered to mac-b');
    expect(list.textContent).toContain('please look at #3');
    expect(list.textContent).toContain('not delivered: the home computer did not take it for 7 days');
    expect(document.body.textContent).toContain('A note posted here waits until mac-b syncs');
    // A post written on another computer says so.
    expect(document.body.textContent).toContain('(from mac-a)');
    const box = screen.getByRole('textbox', { name: /note/i });
    fireEvent.change(box, { target: { value: 'from this computer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post note' }));
    await settle();
    expect(src.postNote).toHaveBeenCalledWith('r1', 'from this computer');
    expect((src.outbox as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(src.dismissOutbox).toHaveBeenCalledWith('o2');
  });

  it('keeps the note box away while the server tables are version 3 and says what to do', async () => {
    render(<TeamStatusView {...props(source({}, sync({ serverSchema: 3 })))} />);
    await settle();
    expect(screen.queryByRole('textbox', { name: /note/i })).toBeNull();
    expect(document.body.textContent).toContain('need the server tables upgraded');
    expect(screen.queryByTestId('ts-takeover')).toBeNull();
  });
});

describe('take over a team whose home is gone', () => {
  it('is offered only past the age guard and only for a copy in sync mode', () => {
    expect(canOfferTakeover(sync(), 'mac-b')).toBe(true);
    expect(canOfferTakeover(sync({ hosts: [{ host: 'mac-b', lastSeen: NOW - HOUR, ageMs: HOUR }] }), 'mac-b')).toBe(false);
    expect(canOfferTakeover(sync({ mode: 'sqlite' }), 'mac-b')).toBe(false);
    expect(canOfferTakeover(sync({ serverSchema: 3 }), 'mac-b')).toBe(false);
    expect(canOfferTakeover(sync(), 'mac-z')).toBe(false);
  });

  it('shows team, old home and last-seen age, cancels without a change, and adopts on confirm', async () => {
    const src = source();
    render(<TeamStatusView {...props(src)} />);
    await settle();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    const dialog = screen.getByTestId('ts-takeover-confirm');
    expect(dialog.textContent).toContain('Take over theirs from mac-b? mac-b last synced 30 h ago (offered after 24 h).');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('ts-takeover-confirm')).toBeNull();
    expect(src.adopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await settle();
    expect(src.adopt).toHaveBeenCalledWith('r1', 'uid-1', 'mac-b', 7);
  });

  it('is not offered while the home synced recently, and translates a refusal', async () => {
    render(<TeamStatusView {...props(source({}, sync({ hosts: [{ host: 'mac-b', lastSeen: NOW - HOUR, ageMs: HOUR }] })))} />);
    await settle();
    expect(screen.queryByTestId('ts-takeover')).toBeNull();
    cleanup();
    const refused = source({ adopt: vi.fn(async () => ({ ok: false as const, error: JSON.stringify({ code: 'home_alive', vars: { home: 'mac-b', hours: 24 }, message: 'x' }) })) });
    render(<TeamStatusView {...props(refused)} />);
    await settle();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('mac-b synced less than 24 hours ago; it may still be working on this team.');
  });

  it('works through the pop-out bridge too', async () => {
    const { remoteSource, serveRequest } = await import('./popout');
    const src = source();
    const token = 'tok-of-t1';
    let deliver: (res: unknown) => void = () => {};
    const remote = remoteSource(
      (req) => { void serveRequest(src, req, token).then((res) => res && deliver(res)); },
      (on) => { deliver = on as (res: unknown) => void; return () => {}; },
      { token },
    );
    expect(await remote.outbox!('r1')).toEqual(outbox);
    expect((await remote.adoptPreview!('r1') as { uid: string }).uid).toBe('uid-1');
    expect(await remote.adopt!('r1', 'uid-1', 'mac-b', 7)).toEqual({ ok: true });
    expect(src.adopt).toHaveBeenCalledWith('r1', 'uid-1', 'mac-b', 7);
    expect(await remote.dismissOutbox!('o2')).toEqual({ ok: true });
    remote.dispose();
  });
});

describe('stage 3c review fixes', () => {
  it('after a takeover the team is this computer\'s: no lock chip, task actions, a notice, remembered', async () => {
    let adopted = false;
    const src = source({
      teams: async () => [{ team: 'r1', teamName: 'theirs', updatedTs: NOW, homeHost: adopted ? 'mac-a' : 'mac-b', mirror: adopted ? undefined : true, syncedAt: NOW - 60_000 }],
      adopt: vi.fn(async () => { adopted = true; return { ok: true as const }; }),
    });
    render(<TeamStatusView {...props(src)} />);
    await settle();
    expect(screen.getByTestId('ts-readonly-chip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await settle();
    await settle();
    expect(screen.getByTestId('ts-notice').textContent).toBe('This computer is now the home of theirs.');
    expect(screen.queryByTestId('ts-readonly-chip')).toBeNull();
    expect(screen.queryByTestId('ts-takeover')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Add task/ }).length).toBeGreaterThan(0);
    expect(localStorage.getItem('octo.teamStatus.team:P3')).toBe('r1');
  });

  it('Esc closes only the confirmation; focus goes to Cancel and back to the button', async () => {
    const { EscapeContext, createEscapeStack } = await import('./escape');
    const stack = createEscapeStack();
    const outer = vi.fn();
    render(<EscapeContext.Provider value={stack}><TeamStatusView {...props(source())} /></EscapeContext.Provider>);
    await settle();
    const button = screen.getByTestId('ts-takeover');
    fireEvent.click(button);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    act(() => { if (!stack.run()) outer(); });
    await settle();
    expect(screen.queryByTestId('ts-takeover-confirm')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByTestId('ts-takeover'));
    act(() => { if (!stack.run()) outer(); });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('says so when Dismiss fails', async () => {
    render(<TeamStatusView {...props(source({ dismissOutbox: vi.fn(async () => ({ ok: false as const, error: 'disk full' })) }))} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('Could not dismiss the note: disk full');
  });

  it('pop-out: the new methods with a wrong token get no answer', async () => {
    const { serveRequest } = await import('./popout');
    const src = source();
    for (const [method, args] of [['outbox', ['r1']], ['adoptPreview', ['r1']], ['dismissOutbox', ['o2']], ['adopt', ['r1', 'uid-1', 'mac-b', 7]]] as const) {
      expect(await serveRequest(src, { id: 'x', token: 'tok-wrong', method, args }, 'tok-of-t1')).toBeNull();
    }
    expect(src.adopt).not.toHaveBeenCalled();
    expect(src.dismissOutbox).not.toHaveBeenCalled();
  });

  it('every refusal code the host sends has English and Korean text', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { TAKEOVER_REFUSAL_CODES, OUTBOX_REASON_CODES, hasTsKey } = await import('./strings');
    const { RESTORE_REFUSAL_CODES } = await import('../components/AgentBoardSettings');
    const { en } = await import('../i18n/en');
    const { ko } = await import('../i18n/ko');
    const dir = path.resolve(__dirname, '../../src-tauri/src/agent_board');
    const sync = fs.readFileSync(path.join(dir, 'sync.rs'), 'utf8');
    const pg = fs.readFileSync(path.join(dir, 'pg.rs'), 'utf8');
    const sqlite = fs.readFileSync(path.join(dir, 'sqlite.rs'), 'utf8');
    // Host-name refusals and "remove copies" have their own texts elsewhere in Settings.
    const other = new Set(['env_set', 'invalid', 'live_teams', 'sync_on']);
    const host = new Set<string>([
      ...[...sync.matchAll(/refusal\("([a-z_]+)"/g)].map((m) => m[1]).filter((c) => !other.has(c)),
      ...[...pg.matchAll(/Ok\(Err\(\("([a-z_]+)"/g)].map((m) => m[1]),
    ]);
    expect(host.size).toBeGreaterThan(10);
    for (const code of host) {
      expect(TAKEOVER_REFUSAL_CODES as readonly string[], code).toContain(code);
      expect(hasTsKey('en', `takeover.refused.${code}`) && hasTsKey('ko', `takeover.refused.${code}`), code).toBe(true);
      expect(RESTORE_REFUSAL_CODES as readonly string[], code).toContain(code);
      expect(`settings.agentBoard.restore.refused.${code}` in en && `settings.agentBoard.restore.refused.${code}` in ko, code).toBe(true);
    }
    const inbox = sqlite.slice(sqlite.indexOf('pub fn inbox_apply'), sqlite.indexOf('fn key_sql_x'));
    const send = pg.slice(pg.indexOf('pub async fn outbox_send'), pg.indexOf('pub async fn outbox_states'));
    const reasons = new Set([...`${inbox}${send}`.matchAll(/Some\("([a-z_]+)"\)/g)].map((m) => m[1]).concat(['expired']));
    for (const code of reasons) {
      expect(OUTBOX_REASON_CODES as readonly string[], code).toContain(code);
      expect(hasTsKey('en', `outbox.reason.${code}`) && hasTsKey('ko', `outbox.reason.${code}`), code).toBe(true);
    }
  });
});

describe('takeover: team switch and slow answers', () => {
  it('drops a preview that arrives after the person picked another team, and confirms with the preview\'s own team', async () => {
    let answer: (v: unknown) => void = () => {};
    const teams = async () => [
      { team: 'r1', teamName: 'theirs', updatedTs: NOW, homeHost: 'mac-b', mirror: true, syncedAt: NOW },
      { team: 'r2', teamName: 'other', updatedTs: NOW - 1, homeHost: 'mac-b', mirror: true, syncedAt: NOW },
    ];
    const src = source({ teams, adoptPreview: vi.fn(() => new Promise((r) => { answer = r; })) });
    localStorage.setItem('octo.teamStatus.team:P3', 'r1');
    render(<TeamStatusView {...props(src)} />);
    await settle();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose a team' }), { target: { value: 'r2' } });
    await settle();
    await act(async () => { answer({ team: 'r1', teamName: 'theirs', uid: 'uid-1', home: 'mac-b', version: 7, lastSeen: 0, ageMs: 30 * HOUR, adoptAfterMs: 24 * HOUR, allowed: true }); });
    await settle();
    expect(screen.queryByTestId('ts-takeover-confirm')).toBeNull();
    // Asked and confirmed on r2: the request names r2's preview team, not whatever is selected later.
    (src.adoptPreview as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ team: 'r2', teamName: 'other', uid: 'uid-2', home: 'mac-b', version: 3, lastSeen: 0, ageMs: 30 * HOUR, adoptAfterMs: 24 * HOUR, allowed: true }));
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await settle();
    expect(src.adopt).toHaveBeenCalledWith('r2', 'uid-2', 'mac-b', 3);
  });

  it('pop-out: a takeover gets 60 s, and a timeout reads as "check again" and refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { remoteSource, TAKEOVER_TIMEOUT_MS } = await import('./popout');
    expect(TAKEOVER_TIMEOUT_MS).toBe(60_000);
    const remote = remoteSource(() => {}, () => () => {}, { token: 'tok-of-t1', timeoutMs: 15_000 });
    const res = remote.adopt!('r1', 'uid-1', 'mac-b', 7);
    let done = false;
    void res.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(41_000);
    const r = await res;
    expect(r.ok).toBe(false);
    remote.dispose();
    vi.useRealTimers();
    const teamsRead = vi.fn(async () => [{ team: 'r1', teamName: 'theirs', updatedTs: NOW, homeHost: 'mac-b', mirror: true, syncedAt: NOW }]);
    const src = source({ teams: teamsRead, adopt: vi.fn(async () => r) });
    render(<TeamStatusView {...props(src)} />);
    await settle();
    fireEvent.click(screen.getByTestId('ts-takeover'));
    await settle();
    const reads = teamsRead.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('No answer yet: the takeover may still have gone through. Check again in a moment (the view refreshes).');
    expect(teamsRead.mock.calls.length).toBeGreaterThan(reads);
  });
});
