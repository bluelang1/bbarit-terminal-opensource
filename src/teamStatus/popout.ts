// Team status pop-out window (label `tool-team-status`, route /team-status): the protocol
// between it and the main window. The main window stays the only place that reads the board
// and acts as a person (humanTaskAction, author "user"); the pop-out asks it over Tauri
// events and gets pushed the context it cannot compute itself (agent tabs and their 7501
// state, relay limits, the owning project's theme). Board change hints (`octo-agent-board`)
// are DOM events and do not cross windows, so the main window forwards them.
// Design: docs/superpowers/specs/2026-11-16-team-status-view-design.md section 8.
import type { LimitUsage } from './model';
import type { ActionResult, BoardInfo, BoardTeam, HumanTaskSub, TeamBoardSource } from './source';
import type { TeamMember } from './TeamStatusView';

export const POPOUT_LABEL = 'tool-team-status';
export const POPOUT_PATH = '/team-status';
export const POPOUT_SIZE = { width: 440, height: 720, minWidth: 360, minHeight: 480 } as const;

/** Event names. `req`/`hello`/`team`/`jump`/`settings` go to `main`; the rest to the pop-out. */
export const POPOUT_EVENT = {
  hello: 'ts-pop:hello',
  team: 'ts-pop:team',
  req: 'ts-pop:req',
  res: 'ts-pop:res',
  ctx: 'ts-pop:ctx',
  board: 'ts-pop:board',
  jump: 'ts-pop:jump',
  settings: 'ts-pop:settings',
} as const;

/** What the main window pushes to the pop-out (again whenever any of it changes). */
export interface PopoutContext {
  /** The team the pop-out shows (it may pick another; it reports that with `team`). */
  team: string;
  /** Changes when the main window asks the pop-out to show `team` (opened again from a team entry point). */
  nonce: number;
  projectId: string;
  projectTeamIds: string[];
  locale: string;
  surface: 'tinted' | 'neutral';
  /** The theme of the project that owns the team. */
  theme: { bg: string; text: string; accent: string; font: string; light: boolean };
  staleMs: number;
  members: TeamMember[];
  limits: LimitUsage;
  /** The main window is pinned (always on top); the pop-out stays on top too then. */
  mainPinned: boolean;
}

/** The pop-out's on-top state: its own pin or the main window's; `fromMain` = only because of main. */
export function popoutOnTop(ownPin: boolean, mainPinned: boolean): { onTop: boolean; fromMain: boolean } {
  return { onTop: ownPin || mainPinned, fromMain: !ownPin && mainPinned };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isMeter = (v: unknown) => isObj(v) && isNum(v.used) && isNum(v.max);
const MEMBER_STATUS = ['working', 'blocked', 'done', 'idle', 'exited'];

/** The context message has the expected shape (a malformed one is ignored). */
export function isPopoutContext(v: unknown): v is PopoutContext {
  if (!isObj(v)) return false;
  if (!isStr(v.team) || !isNum(v.nonce) || !isStr(v.projectId) || !isStr(v.locale) || !isNum(v.staleMs) || typeof v.mainPinned !== 'boolean') return false;
  if (v.surface !== 'tinted' && v.surface !== 'neutral') return false;
  if (!Array.isArray(v.projectTeamIds) || !v.projectTeamIds.every(isStr)) return false;
  const th = v.theme;
  if (!isObj(th) || !isStr(th.bg) || !isStr(th.text) || !isStr(th.accent) || !isStr(th.font) || typeof th.light !== 'boolean') return false;
  if (!Array.isArray(v.members) || !v.members.every((m) => isObj(m) && isStr(m.id) && isStr(m.name) && typeof m.open === 'boolean' && MEMBER_STATUS.includes(m.status as string))) return false;
  const l = v.limits;
  if (!isObj(l) || !isMeter(l.depth) || !isMeter(l.total) || !isMeter(l.children) || !Array.isArray((l.children as Record<string, unknown>).perParent)) return false;
  return true;
}

/** A random id (crypto.randomUUID where available). */
function randomId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** The per-open token the main window puts in the pop-out's URL. */
export function newPopoutToken(): string {
  return randomId();
}

const READS = ['info', 'teams', 'tasks', 'events', 'posts', 'history', 'refusals', 'syncStatus', 'outbox', 'adoptPreview'] as const;
const WRITES = ['act', 'postNote', 'dismissOutbox', 'adopt'] as const;
export type SourceMethod = (typeof READS)[number] | (typeof WRITES)[number];
const METHODS: readonly string[] = [...READS, ...WRITES];
/** A person's task actions only (never claim, block, release or finish). */
const HUMAN_SUBS: readonly HumanTaskSub[] = ['add', 'edit', 'cancel', 'reopen', 'retry', 'approve', 'reject'];

export interface PopoutRequest {
  id: string;
  /** The per-open token from the pop-out's URL; requests without the current one are ignored. */
  token: string;
  method: SourceMethod;
  args: unknown[];
}

export interface PopoutResponse {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export function popoutUrl(origin: string, team: string, projectId: string, token = ''): string {
  const q = new URLSearchParams();
  if (team) q.set('team', team);
  if (projectId) q.set('projectId', projectId);
  if (token) q.set('token', token);
  return `${origin}${POPOUT_PATH}?${q.toString()}`;
}

export function readPopoutQuery(search: string): { team: string; projectId: string; token: string } {
  const q = new URLSearchParams(search);
  return { team: q.get('team') || '', projectId: q.get('projectId') || '', token: q.get('token') || '' };
}

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e ?? 'error') || 'error';

/**
 * Main window: answer one request with the real source. Requests without the current
 * per-open token are ignored (null: no answer). Only the source's methods are served, with
 * string team ids, a numeric task # and a person's action names. Tauri events carry no sender,
 * so the token is the only check (defence in depth, not a boundary against code that already
 * controls the main window).
 */
export async function serveRequest(source: TeamBoardSource, req: unknown, token: string | null): Promise<PopoutResponse | null> {
  const r = req as Partial<PopoutRequest> | null;
  if (!r || typeof r.id !== 'string' || !r.id) return null;
  if (!token || r.token !== token) return null;
  const id = r.id;
  if (typeof r.method !== 'string' || !METHODS.includes(r.method) || !Array.isArray(r.args)) return { id, ok: false, error: 'unknown request' };
  const a = r.args;
  const team = typeof a[0] === 'string' ? a[0] : '';
  try {
    switch (r.method as SourceMethod) {
      case 'info': return { id, ok: true, value: await source.info() };
      case 'teams': return { id, ok: true, value: await source.teams() };
      case 'refusals': return { id, ok: true, value: await source.refusals() };
      case 'syncStatus': return { id, ok: true, value: source.syncStatus ? await source.syncStatus() : null };
      case 'tasks': return { id, ok: true, value: await source.tasks(team) };
      case 'events': return { id, ok: true, value: await source.events(team) };
      case 'posts': return { id, ok: true, value: await source.posts(team) };
      case 'history': {
        const seq = Number(a[1]);
        if (!Number.isInteger(seq)) return { id, ok: false, error: 'bad task' };
        return { id, ok: true, value: await source.history(team, seq) };
      }
      case 'act': {
        const sub = a[1] as HumanTaskSub;
        const request = a[2] && typeof a[2] === 'object' && !Array.isArray(a[2]) ? (a[2] as Record<string, unknown>) : null;
        if (!team || !HUMAN_SUBS.includes(sub) || !request) return { id, ok: true, value: { ok: false, error: 'not a person\'s action' } satisfies ActionResult };
        return { id, ok: true, value: await source.act(team, sub, request) };
      }
      case 'postNote': {
        if (!team || typeof a[1] !== 'string') return { id, ok: true, value: { ok: false, error: 'empty note' } satisfies ActionResult };
        return { id, ok: true, value: await source.postNote(team, a[1]) };
      }
      case 'outbox': return { id, ok: true, value: source.outbox && team ? await source.outbox(team) : [] };
      case 'adoptPreview': {
        if (!team || !source.adoptPreview) return { id, ok: false, error: 'not available' };
        return { id, ok: true, value: await source.adoptPreview(team) };
      }
      case 'dismissOutbox': {
        if (typeof a[0] !== 'string' || !source.dismissOutbox) return { id, ok: true, value: { ok: false, error: 'not available' } satisfies ActionResult };
        return { id, ok: true, value: await source.dismissOutbox(a[0]) };
      }
      case 'adopt': {
        const [, uid, home, version] = a;
        if (!team || !source.adopt || typeof uid !== 'string' || typeof home !== 'string' || typeof version !== 'number') {
          return { id, ok: true, value: { ok: false, error: 'not available' } satisfies ActionResult };
        }
        return { id, ok: true, value: await source.adopt(team, uid, home, version) };
      }
    }
  } catch (e) {
    return { id, ok: false, error: errorText(e) };
  }
  return { id, ok: false, error: 'unknown request' };
}

/**
 * Pop-out: a TeamBoardSource that asks the main window. `send` delivers a request,
 * `subscribe` hands every response to the given callback and returns its cleanup. A request
 * with no answer within `timeoutMs` fails (the view shows "team board unavailable").
 */
export function remoteSource(
  send: (req: PopoutRequest) => void,
  subscribe: (onResponse: (res: PopoutResponse) => void) => () => void,
  opts: { timeoutMs?: number; idPrefix?: string; token?: string } = {},
): TeamBoardSource & { dispose: () => void } {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const prefix = opts.idPrefix ?? `${randomId()}-`;
  const token = opts.token ?? '';
  let n = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const off = subscribe((res) => {
    const p = res && pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.value); else p.reject(new Error(res.error || 'error'));
  });
  // A takeover (and its preview) may wait behind a sync round holding the host's lock, so it
  // gets TAKEOVER_TIMEOUT_MS; a timeout there is "no answer yet" (code `timeout`), never a refusal.
  const slow = (m: SourceMethod) => m === 'adopt' || m === 'adoptPreview';
  const call = <T>(method: SourceMethod, ...args: unknown[]): Promise<T> => new Promise<T>((resolve, reject) => {
    const id = `${prefix}${++n}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(slow(method) ? JSON.stringify({ code: 'timeout', vars: {}, message: 'no answer yet' }) : 'the main window did not answer'));
    }, slow(method) ? Math.max(timeoutMs, TAKEOVER_TIMEOUT_MS) : timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      send({ id, token, method, args });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(errorText(e)));
    }
  });
  // Actions answer with a result, never throw (a lost answer reads as a failed action).
  const action = async (p: Promise<ActionResult>): Promise<ActionResult> => {
    try {
      return await p;
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  };
  return {
    info: () => call<BoardInfo>('info'),
    teams: () => call<BoardTeam[]>('teams'),
    tasks: (team) => call('tasks', team),
    events: (team) => call('events', team),
    posts: (team) => call('posts', team),
    history: (team, seq) => call('history', team, seq),
    refusals: () => call('refusals'),
    syncStatus: () => call('syncStatus'),
    act: (team, sub, request) => action(call<ActionResult>('act', team, sub, request)),
    postNote: (team, text) => action(call<ActionResult>('postNote', team, text)),
    outbox: (team) => call('outbox', team),
    dismissOutbox: (id) => action(call<ActionResult>('dismissOutbox', id)),
    adoptPreview: (team) => call('adoptPreview', team),
    adopt: (team, uid, home, version) => action(call<ActionResult>('adopt', team, uid, home, version)),
    dispose: () => {
      off();
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
      pending.clear();
    },
  };
}

/** How long the pop-out waits for "Take over this team" and its preview. */
export const TAKEOVER_TIMEOUT_MS = 60_000;

/** A stable string of the context, so the main window pushes it only when something changed. */
export function contextKey(ctx: PopoutContext | null): string {
  return ctx ? JSON.stringify(ctx) : '';
}
