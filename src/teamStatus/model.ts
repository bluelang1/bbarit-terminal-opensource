// Team status view: the pure data model (no React, no Tauri, no clock — every time-dependent
// function takes `now`). Inputs are the board rows the Rust store returns (agentTasks.ts
// BoardTask / TaskEvent, agentBoard.ts BoardPost), the relay links and the 7501 tab states.
// Design: docs/superpowers/specs/2026-11-16-team-status-view-design.md (sections 4, 5, 8, 11).
import type { AgentLink } from '../terminal/agentRelay';
import type { AgentLimits } from '../terminal/agentLimits';
import { agentDepth } from '../terminal/agentLimits';
import { teamRootOf } from '../terminal/agentBoard';
import type { BoardTask } from '../terminal/agentTasks';
import { DARK_STYLES, LIGHT_STYLES, type StyleTheme } from '../theme';

// ── States ───────────────────────────────────────────────────────────────

export const STORED_STATES = ['open', 'claimed', 'blocked', 'review', 'done', 'failed', 'cancelled'] as const;
export type StoredState = (typeof STORED_STATES)[number];
/** Stored state, or `waiting` (open with a dependency that is not done). */
export type DisplayState = StoredState | 'waiting';

/** State-bar order (fixed, section 5.2); cancelled is left out of the bar. */
export const BAR_ORDER: readonly DisplayState[] = ['done', 'review', 'blocked', 'claimed', 'failed', 'open', 'waiting'];
export const ALL_DISPLAY_STATES: readonly DisplayState[] = [...BAR_ORDER, 'cancelled'];

const isStored = (s: string): s is StoredState => (STORED_STATES as readonly string[]).includes(s);
const depMet = (s: string) => s === 'done' || s === 'cancelled';

export interface TaskView {
  seq: number;
  title: string;
  state: StoredState;
  display: DisplayState;
  waiting: boolean;
  waitingOn: number[];
  /** Waiting on at least one failed dependency (it still blocks). */
  waitingOnFailed: boolean;
  /** A dependency was cancelled (counts as met; flagged). */
  depCancelled: boolean;
  /** Claimed/blocked with no change for `staleMs` (home teams only). */
  stale: boolean;
  /** ms since the last change. */
  ageMs: number;
  ownerId?: string;
  ownerName?: string;
  /** Store attempt counter: 0 on the first try, +1 per retry / reject / reopen. */
  attempt: number;
  maxAttempts: number;
  /** Tries used so far as people count them: attempt + 1, capped at maxAttempts. */
  tries: number;
  priority: number;
  needsReview: boolean;
  labels: string[];
  deps: number[];
  updatedAt: number;
  task: BoardTask;
}

/**
 * One task as the view shows it. `depsById` maps `#seq` → current state of the team's tasks
 * (the freshest source); a dependency missing there falls back to the state the store sent
 * with the task. Stale is evaluated only on the team's home (`mirror` false).
 */
export function deriveTaskView(
  task: BoardTask,
  depsById: ReadonlyMap<number, { state: string }>,
  now: number,
  staleMs: number,
  opts: { mirror?: boolean } = {},
): TaskView {
  const state: StoredState = isStored(task.state) ? task.state : 'open';
  const deps = (task.deps || []).map((d) => ({ seq: d.seq, state: depsById.get(d.seq)?.state ?? d.state }));
  const unmet = deps.filter((d) => !depMet(d.state));
  const waiting = state === 'open' && unmet.length > 0;
  const updatedAt = typeof task.updatedAt === 'number' ? task.updatedAt : typeof task.createdAt === 'number' ? task.createdAt : now;
  const ageMs = Math.max(0, now - updatedAt);
  const held = state === 'claimed' || state === 'blocked';
  return {
    seq: task.seq,
    title: String(task.title ?? ''),
    state,
    display: waiting ? 'waiting' : state,
    waiting,
    waitingOn: waiting ? unmet.map((d) => d.seq) : [],
    waitingOnFailed: waiting && unmet.some((d) => d.state === 'failed'),
    depCancelled: deps.some((d) => d.state === 'cancelled'),
    stale: !opts.mirror && held && ageMs > staleMs,
    ageMs,
    ownerId: task.owner?.id || undefined,
    ownerName: task.owner?.name || task.owner?.id || undefined,
    attempt: Math.max(0, Number(task.attempt) || 0),
    maxAttempts: Math.max(1, Number(task.maxAttempts) || 3),
    tries: triesUsed(task.attempt, task.maxAttempts),
    priority: typeof task.priority === 'number' ? task.priority : 1,
    needsReview: !!task.needsReview,
    labels: Array.isArray(task.labels) ? task.labels.map(String) : [],
    deps: deps.map((d) => d.seq),
    updatedAt,
    task,
  };
}

/** Tries used as shown to people ("try 1/3" for the first): attempt + 1, capped at the maximum. */
export function triesUsed(attempt: unknown, maxAttempts: unknown): number {
  const max = Math.max(1, Number(maxAttempts) || 3);
  return Math.min(max, Math.max(0, Math.trunc(Number(attempt) || 0)) + 1);
}

/** Views of every task, dependencies resolved against the same list. */
export function deriveTaskViews(tasks: readonly BoardTask[], now: number, staleMs: number, opts: { mirror?: boolean } = {}): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.seq, { state: t.state }]));
  return tasks.map((t) => deriveTaskView(t, byId, now, staleMs, opts));
}

export type StateCounts = Record<DisplayState, number>;

export interface StateSummary {
  counts: StateCounts;
  /** Tasks in the bar (cancelled left out). */
  total: number;
  cancelled: number;
  stale: number;
}

const zeroCounts = (): StateCounts => ({ open: 0, claimed: 0, blocked: 0, review: 0, done: 0, failed: 0, cancelled: 0, waiting: 0 });

/** Counts per display state; `total` leaves cancelled out (shown as "+n cancelled"). */
export function summarize(views: readonly TaskView[]): StateSummary {
  const counts = zeroCounts();
  let stale = 0;
  for (const v of views) {
    counts[v.display] += 1;
    if (v.stale) stale += 1;
  }
  return { counts, total: views.length - counts.cancelled, cancelled: counts.cancelled, stale };
}

export interface BarSegment {
  state: DisplayState;
  count: number;
  x: number;
  w: number;
}

/**
 * State-bar geometry in whole pixels: segments in BAR_ORDER for non-zero counts, `gap` px
 * between them, widths proportional to the counts with every segment at least 4 px (when
 * the bar is wide enough), summing exactly to `width` minus the gaps.
 */
export function stateBarSegments(counts: Partial<Record<DisplayState, number>>, width: number, gap = 2, order: readonly DisplayState[] = BAR_ORDER): BarSegment[] {
  const parts = order.map((state) => ({ state, count: Math.max(0, Math.trunc(counts[state] || 0)) })).filter((p) => p.count > 0);
  const W = Math.max(0, Math.floor(width));
  if (!parts.length || W <= 0) return [];
  const g = Math.max(0, Math.floor(gap));
  const avail = W - g * (parts.length - 1);
  if (avail < parts.length) return [];
  const total = parts.reduce((s, p) => s + p.count, 0);
  const min = avail >= parts.length * 4 ? 4 : 1;
  const exact = parts.map((p) => (avail * p.count) / total);
  const w = exact.map((e) => Math.max(min, Math.floor(e)));
  let diff = avail - w.reduce((s, n) => s + n, 0);
  // Hand out the remaining pixels by largest remainder; take back from the widest.
  const byRemainder = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; diff > 0; k = (k + 1) % byRemainder.length, diff--) w[byRemainder[k].i] += 1;
  while (diff < 0) {
    let widest = -1;
    for (let i = 0; i < w.length; i++) if (w[i] > min && (widest < 0 || w[i] > w[widest])) widest = i;
    if (widest < 0) break;
    w[widest] -= 1;
    diff += 1;
  }
  const out: BarSegment[] = [];
  let x = 0;
  parts.forEach((p, i) => {
    out.push({ state: p.state, count: p.count, x, w: w[i] });
    x += w[i] + g;
  });
  return out;
}

/** "17 tasks: 8 done, 1 review, …" (chart description, section 10). */
export function stateBarSentence(summary: StateSummary, label: (s: DisplayState) => string, tasksWord: (n: number) => string): string {
  const parts = BAR_ORDER.filter((s) => summary.counts[s] > 0).map((s) => `${summary.counts[s]} ${label(s)}`);
  return `${tasksWord(summary.total)}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

// ── Needs you ────────────────────────────────────────────────────────────

export type NeedsKind = 'failed' | 'blockedAgent' | 'blocked' | 'review' | 'stale' | 'refusal';

/** failed > blocked agent > blocked task > review > stale (then refusals, info only). */
const SEVERITY: Record<NeedsKind, number> = { failed: 0, blockedAgent: 1, blocked: 2, review: 3, stale: 4, refusal: 5 };

export interface AgentState {
  id: string;
  name?: string;
  /** 7501 rollup or `exited`. */
  status: 'working' | 'blocked' | 'done' | 'idle' | 'exited';
  /** When it entered that state (ms), if known. */
  since?: number;
  /** What it asks (blocked message), if the tab reported one. */
  message?: string;
}

export interface Refusal {
  ts: number;
  limit: 'maxChildren' | 'maxDepth' | 'maxTotal' | string;
  caller?: { id?: string; name?: string };
  count?: number;
  max?: number;
}

export interface NeedsYouItem {
  key: string;
  kind: NeedsKind;
  severity: number;
  /** Counts for the badge and has actions (false on mirrors and for refusals). */
  actionable: boolean;
  seq?: number;
  tabId?: string;
  title: string;
  /** When the situation started (ms). */
  since: number;
  ageMs: number;
  ownerId?: string;
  ownerName?: string;
  /** Tries used (attempt + 1, capped) and the maximum. */
  attempt?: number;
  maxAttempts?: number;
  /** The reason / last error / question to show. */
  detail?: string;
  /** A blocked task that is also stale. */
  stale?: boolean;
  limit?: string;
}

/** Refusals older than this are not shown in Needs you. */
export const REFUSAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * What needs a person, most severe first, then oldest first: failed tasks, blocked agents
 * (7501), blocked tasks, reviews, stale claims (a stale blocked task stays one blocked item),
 * then limit refusals of the last hour (info, never counted). On a mirror team the task items
 * are shown without actions.
 */
export function needsYou(
  views: readonly TaskView[],
  agents: readonly AgentState[],
  refusals: readonly Refusal[],
  now: number,
  opts: { mirror?: boolean; members?: ReadonlySet<string> } = {},
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const mirror = !!opts.mirror;
  const add = (it: Omit<NeedsYouItem, 'severity' | 'ageMs'>) => items.push({ ...it, severity: SEVERITY[it.kind], ageMs: Math.max(0, now - it.since) });
  for (const v of views) {
    const base = { seq: v.seq, title: v.title, since: v.updatedAt, ownerId: v.ownerId, ownerName: v.ownerName, actionable: !mirror };
    if (v.state === 'failed') add({ ...base, key: `failed:${v.seq}`, kind: 'failed', attempt: v.tries, maxAttempts: v.maxAttempts, detail: v.task.lastError || undefined });
    else if (v.state === 'blocked') add({ ...base, key: `blocked:${v.seq}`, kind: 'blocked', detail: v.task.blockedReason || undefined, stale: v.stale });
    else if (v.state === 'review') add({ ...base, key: `review:${v.seq}`, kind: 'review', detail: v.task.result?.summary || undefined });
    else if (v.state === 'claimed' && v.stale) add({ ...base, key: `stale:${v.seq}`, kind: 'stale' });
  }
  for (const a of agents) {
    if (a.status !== 'blocked') continue;
    add({ key: `agent:${a.id}`, kind: 'blockedAgent', tabId: a.id, title: a.name || a.id, since: a.since ?? now, actionable: true, detail: a.message });
  }
  // Refusals of this team only (the caller is a member) when members are given.
  const seen = new Set<string>();
  for (const r of refusals) {
    if (!(now - r.ts <= REFUSAL_WINDOW_MS && r.ts <= now + 60_000)) continue;
    const caller = r.caller?.id || '';
    if (opts.members && !opts.members.has(caller)) continue;
    const key = `refusal:${r.ts}:${caller}:${r.limit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add({ key, kind: 'refusal', title: r.limit, limit: r.limit, since: r.ts, actionable: false, tabId: caller || undefined, ownerName: r.caller?.name });
  }
  return items.sort((a, b) => a.severity - b.severity || a.since - b.since || a.key.localeCompare(b.key));
}

export function badgeCount(items: readonly NeedsYouItem[]): number {
  return items.filter((i) => i.actionable).length;
}

/** The badge's border state: failed > blocked > review > stale, or null with nothing to do. */
export function badgeSeverity(items: readonly NeedsYouItem[]): 'failed' | 'blocked' | 'review' | 'stale' | null {
  const kinds = new Set(items.filter((i) => i.actionable).map((i) => i.kind));
  if (kinds.has('failed')) return 'failed';
  if (kinds.has('blockedAgent') || kinds.has('blocked')) return 'blocked';
  if (kinds.has('review')) return 'review';
  if (kinds.has('stale')) return 'stale';
  return null;
}

/** "9+" cap. */
export function badgeText(n: number): string {
  return n > 9 ? '9+' : String(Math.max(0, n));
}

/** `aria-label`: "4 items need you: 1 review, 1 failed, 1 blocked agent, 1 stale". */
export function badgeLabel(items: readonly NeedsYouItem[], locale: string): string {
  const act = items.filter((i) => i.actionable);
  const n = act.length;
  const ko = locale === 'ko';
  if (!n) return ko ? '처리할 일 없음' : 'Nothing needs you';
  const order: NeedsKind[] = ['review', 'failed', 'blockedAgent', 'blocked', 'stale'];
  const names: Record<string, [string, string]> = {
    review: ['검수 대기', 'review'],
    failed: ['실패', 'failed'],
    blockedAgent: ['막힌 에이전트', 'blocked agent'],
    blocked: ['막힌 할 일', 'blocked task'],
    stale: ['멈춘 작업', 'stale'],
  };
  const parts = order
    .map((k) => [k, act.filter((i) => i.kind === k).length] as const)
    .filter(([, c]) => c > 0)
    .map(([k, c]) => (ko ? `${names[k][0]} ${c}` : `${c} ${names[k][1]}${c > 1 && (k === 'blockedAgent' || k === 'blocked') ? 's' : ''}`));
  return ko ? `처리할 일 ${n}개: ${parts.join(', ')}` : `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you: ${parts.join(', ')}`;
}

// ── Series ───────────────────────────────────────────────────────────────

export interface EventLike {
  ts: number;
  action?: string;
  to?: string | null;
  actor?: { id?: string } | null;
}

/**
 * Counts of matching events in `n` buckets of `bucketMs` ending at `now` (oldest first):
 * bucket i covers [now − (n − i)·bucketMs, now − (n − i − 1)·bucketMs). A string matches the
 * event action; a function decides itself. Events outside the window are ignored.
 */
export function bucketCounts<E extends EventLike>(events: readonly E[], match: string | ((e: E) => boolean), now: number, bucketMs: number, n: number): number[] {
  const out = new Array<number>(Math.max(0, n)).fill(0);
  if (n <= 0 || bucketMs <= 0) return out;
  const start = now - n * bucketMs;
  const test = typeof match === 'string' ? (e: E) => e.action === match : match;
  for (const e of events) {
    if (typeof e.ts !== 'number' || e.ts < start || e.ts >= now || !test(e)) continue;
    const i = Math.floor((e.ts - start) / bucketMs);
    if (i >= 0 && i < n) out[i] += 1;
  }
  return out;
}

/** An event that finished a task (done, or an approval moving it to done). */
export const isDoneEvent = (e: EventLike) => e.to === 'done' && (e.action === 'done' || e.action === 'approve');

/** Tasks each tab holds, by state (claimed / blocked / review). */
export function agentLoad(views: readonly TaskView[], tabs: readonly string[]): Record<string, { claimed: number; blocked: number; review: number; seqs: number[] }> {
  const out: Record<string, { claimed: number; blocked: number; review: number; seqs: number[] }> = {};
  for (const id of tabs) out[id] = { claimed: 0, blocked: 0, review: 0, seqs: [] };
  for (const v of views) {
    const o = v.ownerId ? out[v.ownerId] : undefined;
    if (!o || (v.state !== 'claimed' && v.state !== 'blocked' && v.state !== 'review')) continue;
    o[v.state] += 1;
    o.seqs.push(v.seq);
  }
  return out;
}

// ── Limits ───────────────────────────────────────────────────────────────

export interface LimitUsage {
  children: { used: number; max: number; parent?: string; perParent: Array<{ id: string; n: number }> };
  depth: { used: number; max: number };
  total: { used: number; max: number };
}

/**
 * Relay limit usage from the same inputs as checkAgentRunLimits: live links per parent (the
 * busiest parent is the meter), the deepest live child, and every live link.
 */
export function limitUsage(links: ReadonlyMap<string, AgentLink>, limits: AgentLimits, isLive: (l: AgentLink) => boolean): LimitUsage {
  const live = [...links.values()].filter(isLive);
  const per = new Map<string, number>();
  for (const l of live) if (l.parentId) per.set(l.parentId, (per.get(l.parentId) || 0) + 1);
  const perParent = [...per.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const depth = live.reduce((m, l) => Math.max(m, agentDepth(links, l.childId)), 0);
  return {
    children: { used: perParent[0]?.n ?? 0, max: limits.maxChildren, parent: perParent[0]?.id, perParent },
    depth: { used: depth, max: limits.maxDepth },
    total: { used: live.length, max: limits.maxTotal },
  };
}

// ── Teams ────────────────────────────────────────────────────────────────

/** Tab ids of a team: the root, then every relay child whose team is that root. */
export function teamMemberIds(links: ReadonlyMap<string, AgentLink>, team: string): string[] {
  const out = [team];
  for (const l of links.values()) if (l.childId !== team && teamRootOf(links, l.childId) === team) out.push(l.childId);
  return out;
}

/**
 * Which project each board team belongs to: the project holding the team's root tab, else
 * the project holding one of its relay children. Teams with no open tab are left out.
 */
export function projectTeams(
  projects: ReadonlyArray<{ id: string; terminalIds: readonly string[] }>,
  links: ReadonlyMap<string, AgentLink>,
  teams: readonly string[],
): Map<string, string[]> {
  const projectOf = new Map<string, string>();
  for (const p of projects) for (const id of p.terminalIds) projectOf.set(id, p.id);
  const out = new Map<string, string[]>();
  for (const team of teams) {
    let pid = projectOf.get(team);
    if (!pid) {
      for (const l of links.values()) {
        if (projectOf.has(l.childId) && teamRootOf(links, l.childId) === team) { pid = projectOf.get(l.childId); break; }
      }
    }
    if (!pid) continue;
    out.set(pid, [...(out.get(pid) || []), team]);
  }
  return out;
}

/**
 * Default team: the remembered one if still listed (a team of another computer is remembered
 * only when the person picked it), else the active project's most recent, else the most recent
 * — this computer's teams before other computers' (read-only) ones.
 */
export function pickDefaultTeam(teams: ReadonlyArray<{ team: string; updatedTs?: number; mirror?: boolean }>, projectTeamIds: readonly string[], remembered?: string): string {
  const ids = new Set(teams.map((t) => t.team));
  if (remembered && ids.has(remembered)) return remembered;
  const recent = [...teams].sort((a, b) => Number(!!a.mirror) - Number(!!b.mirror) || (b.updatedTs || 0) - (a.updatedTs || 0));
  return recent.find((t) => projectTeamIds.includes(t.team))?.team || recent[0]?.team || '';
}

// ── Board columns and filters ────────────────────────────────────────────

export type ColumnKey = 'todo' | 'working' | 'review' | 'done' | 'failed' | 'finished';

export interface BoardColumn {
  key: ColumnKey;
  views: TaskView[];
}

const byPriority = (a: TaskView, b: TaskView) => b.priority - a.priority || a.seq - b.seq;
const byRecent = (a: TaskView, b: TaskView) => b.updatedAt - a.updatedAt || b.seq - a.seq;

/**
 * Grouped board columns: five (To do = open + waiting, Working = claimed + blocked, Review,
 * Done, Failed) or three when narrow (To do, Working, Finished = review + done + failed).
 * Cancelled tasks join Done (or Finished) only when shown.
 */
export function boardColumns(views: readonly TaskView[], opts: { columns: 3 | 5; showCancelled?: boolean }): BoardColumn[] {
  const pick = (states: DisplayState[]) => views.filter((v) => states.includes(v.display));
  const todo = pick(['open', 'waiting']).sort((a, b) => Number(a.waiting) - Number(b.waiting) || byPriority(a, b));
  const working = pick(['blocked', 'claimed']).sort((a, b) => Number(b.state === 'blocked') - Number(a.state === 'blocked') || byPriority(a, b));
  const cancelled = opts.showCancelled ? pick(['cancelled']) : [];
  if (opts.columns === 3) {
    const finished = [...pick(['review']).sort(byRecent), ...pick(['failed']).sort(byRecent), ...[...pick(['done']), ...cancelled].sort(byRecent)];
    return [{ key: 'todo', views: todo }, { key: 'working', views: working }, { key: 'finished', views: finished }];
  }
  return [
    { key: 'todo', views: todo },
    { key: 'working', views: working },
    { key: 'review', views: pick(['review']).sort(byRecent) },
    { key: 'done', views: [...pick(['done']), ...cancelled].sort(byRecent) },
    { key: 'failed', views: pick(['failed']).sort(byRecent) },
  ];
}

export interface TaskFilters {
  states: ReadonlySet<DisplayState>;
  agent?: string;
  label?: string;
  search?: string;
}

/** States (empty = all), owner, label and `#seq`/title search. */
export function filterViews(views: readonly TaskView[], f: TaskFilters): TaskView[] {
  const q = (f.search || '').trim().toLowerCase();
  const seqQ = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  return views.filter((v) => {
    if (f.states.size && !f.states.has(v.display)) return false;
    if (f.agent && v.ownerId !== f.agent) return false;
    if (f.label && !v.labels.includes(f.label)) return false;
    if (q) {
      if (seqQ !== null) return v.seq === seqQ;
      return v.title.toLowerCase().includes(q);
    }
    return true;
  });
}

// ── Activity feed ────────────────────────────────────────────────────────

export interface FeedEntry {
  key: string;
  ts: number;
  kind: 'event' | 'post';
  actorId?: string;
  actorName?: string;
  /** Task events: action and task; posts: kind and text. */
  action?: string;
  task?: number;
  to?: string | null;
  note?: string | null;
  postKind?: string;
  text?: string;
}

export interface FeedEvent extends EventLike {
  id?: string;
  seq?: number;
  task?: number;
  from?: string | null;
  note?: string | null;
  actor?: { id?: string; name?: string } | null;
}

export interface FeedPost {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  task?: number;
  author?: { id?: string; name?: string };
}

/** Task events and posts merged, newest first, at most `limit`. Done notes are left out (the done event says it). */
export function buildFeed(events: readonly FeedEvent[], posts: readonly FeedPost[], limit = 50): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const e of events) {
    out.push({ key: `e:${e.id ?? `${e.task}:${e.seq}`}`, ts: e.ts, kind: 'event', actorId: e.actor?.id, actorName: e.actor?.name || e.actor?.id, action: e.action, task: e.task, to: e.to, note: e.note });
  }
  for (const p of posts) {
    if (p.kind === 'done') continue;
    out.push({ key: `p:${p.seq}`, ts: p.ts, kind: 'post', actorId: p.author?.id, actorName: p.author?.name || p.author?.id, postKind: p.kind, text: p.text, task: p.task });
  }
  return out.sort((a, b) => b.ts - a.ts || b.key.localeCompare(a.key)).slice(0, Math.max(0, limit));
}

/** Per tab: task events + posts by that tab in `n` buckets of `bucketMs` up to `now`, and the latest time. */
export function agentActivity(tabId: string, events: readonly FeedEvent[], posts: readonly FeedPost[], now: number, bucketMs = 5 * 60_000, n = 12): { series: number[]; lastAt?: number } {
  const mine: EventLike[] = [
    ...events.filter((e) => e.actor?.id === tabId),
    ...posts.filter((p) => p.author?.id === tabId).map((p) => ({ ts: p.ts })),
  ];
  const lastAt = mine.reduce<number | undefined>((m, e) => (m === undefined || e.ts > m ? e.ts : m), undefined);
  return { series: bucketCounts(mine, () => true, now, bucketMs, n), lastAt };
}

// ── Time ─────────────────────────────────────────────────────────────────

/** Compact age: "now", "4m", "2h", "3d" (ko: "방금", "4분", "2시간", "3일"). */
export function formatAge(ms: number, locale: string): string {
  const ko = locale === 'ko';
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return ko ? '방금' : 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return ko ? `${m}분` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return ko ? `${h}시간` : `${h}h`;
  const d = Math.floor(h / 24);
  return ko ? `${d}일` : `${d}d`;
}

// ── Color ────────────────────────────────────────────────────────────────

export type Polarity = 'dark' | 'light';
export type TokenRole = 'mark' | 'ink';

/** Status tokens (section 5.2). Every `*-ink` defaults to its mark. teamStatus.css carries the same values (a test compares them). */
export const TS_TOKENS: Record<Polarity, Record<string, string>> = {
  dark: {
    done: '#22c55e', review: '#f472b6', blocked: '#f59e0b', claimed: '#60a5fa', failed: '#ef4444', 'failed-ink': '#fb8080',
    open: '#94a3b8', cancelled: '#7c8595', 'cancelled-ink': '#9ca3af', stale: '#fb923c',
  },
  light: {
    done: '#15803d', review: '#db2777', 'review-ink': '#be185d', blocked: '#c2700a', 'blocked-ink': '#a3480b', claimed: '#2563eb',
    'claimed-ink': '#1d4ed8', failed: '#dc2626', 'failed-ink': '#c81e1e', open: '#64748b', 'open-ink': '#526075',
    cancelled: '#7b8494', 'cancelled-ink': '#5f6673', stale: '#c2410c', 'stale-ink': '#b3410c',
  },
};

export const STATUS_TOKEN_STATES = ['done', 'review', 'blocked', 'claimed', 'failed', 'open', 'cancelled', 'stale'] as const;

/** The token value of a state's mark or ink in one polarity. */
export function tokenValue(p: Polarity, state: (typeof STATUS_TOKEN_STATES)[number], role: TokenRole): string {
  const t = TS_TOKENS[p];
  return role === 'ink' ? t[`${state}-ink`] || t[state] : t[state];
}

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb | null {
  const h = String(hex || '').trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** `color-mix(in srgb, a p%, b)` per channel, rounded like browsers do. */
export function mixSrgb(a: Rgb, b: Rgb, p: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Same rule as App.tsx isLightBg (YIQ > 128). */
export function isLightHex(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return false;
  return (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 128;
}

/** The view's tinted surfaces for a theme background (section 5.1). */
export function tintedSurfaces(bg: string): { polarity: Polarity; surface: Rgb; raised: Rgb } | null {
  const c = parseHex(bg);
  if (!c) return null;
  if (isLightHex(bg)) return { polarity: 'light', surface: mixSrgb(c, [255, 255, 255], 0.3), raised: [255, 255, 255] };
  const surface = mixSrgb(c, [8, 8, 10], 0.72);
  return { polarity: 'dark', surface, raised: mixSrgb(surface, [255, 255, 255], 0.94) };
}

export const NEUTRAL_SURFACES: Record<Polarity, { surface: Rgb; raised: Rgb }> = {
  dark: { surface: [0x14, 0x14, 0x18], raised: [0x1d, 0x1d, 0x22] },
  light: { surface: [0xfa, 0xfa, 0xfa], raised: [0xff, 0xff, 0xff] },
};

/** Contrast targets: marks (bars, dots, icons) 3:1, ink (colored text) 4.5:1. */
export const CONTRAST_TARGET: Record<TokenRole, number> = { mark: 3, ink: 4.5 };

/** Does every status mark and ink meet its target on both surfaces? */
export function tokensPass(polarity: Polarity, surfaces: { surface: Rgb; raised: Rgb }): boolean {
  for (const state of STATUS_TOKEN_STATES) {
    for (const role of ['mark', 'ink'] as const) {
      const c = parseHex(tokenValue(polarity, state, role));
      if (!c) return false;
      for (const s of [surfaces.surface, surfaces.raised]) if (contrast(c, s) < CONTRAST_TARGET[role]) return false;
    }
  }
  return true;
}

const BUILT_IN = new Set([...DARK_STYLES, ...LIGHT_STYLES].map((s) => `${s.name}|${s.bg}|${s.text}`.toLowerCase()));

/**
 * `neutral` for wacky and imported/custom themes, or whenever a status color misses its
 * target on the tinted surface; `tinted` otherwise (the built-in dark and light themes).
 */
export function teamStatusSurface(style: Pick<StyleTheme, 'name' | 'bg' | 'text'>): 'tinted' | 'neutral' {
  if (!BUILT_IN.has(`${style.name}|${style.bg}|${style.text}`.toLowerCase())) return 'neutral';
  const s = tintedSurfaces(style.bg);
  if (!s) return 'neutral';
  return tokensPass(s.polarity, s) ? 'tinted' : 'neutral';
}
