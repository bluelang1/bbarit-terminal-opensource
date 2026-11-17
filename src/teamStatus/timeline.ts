// Team status: the Timeline tab as pure functions (no React, no clock — `now` is passed).
// `burnUp` = total scope vs done over time; `timeInState` = one lane per task with segments
// colored by stored state; `medianTimeIn` = the text above the lanes.
// Design: docs/superpowers/specs/2026-11-16-team-status-view-design.md section 4.
import type { BoardTask } from '../terminal/agentTasks';
import { STORED_STATES, type StoredState } from './model';

export interface TimelineEvent {
  ts: number;
  /** Event sequence (ties at the same ms keep store order). */
  seq?: number;
  /** The task's #. */
  task?: number;
  action?: string;
  from?: string | null;
  to?: string | null;
}

/** The state an action moves to when the event carries no `to` (older rows). */
const ACTION_TO: Record<string, StoredState> = {
  add: 'open', claim: 'claimed', release: 'open', auto_release: 'open', lease_expired: 'open', block: 'blocked', unblock: 'claimed',
  submit: 'review', approve: 'done', reject: 'open', done: 'done', fail: 'failed', retry: 'open', reopen: 'open', cancel: 'cancelled',
};

const asState = (s: unknown): StoredState | null => (typeof s === 'string' && (STORED_STATES as readonly string[]).includes(s) ? (s as StoredState) : null);

/** The state an event moves its task to, or null (edit, dependency changes, unknown). */
export function eventTarget(e: TimelineEvent): StoredState | null {
  return asState(e.to) ?? (e.action ? ACTION_TO[e.action] ?? null : null);
}

const byTime = (a: TimelineEvent, b: TimelineEvent) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0);

/** Events per task, oldest first (events without a task # or time are dropped). */
function perTask(events: readonly TimelineEvent[]): Map<number, TimelineEvent[]> {
  const out = new Map<number, TimelineEvent[]>();
  for (const e of events) {
    if (typeof e.task !== 'number' || typeof e.ts !== 'number' || !Number.isFinite(e.ts)) continue;
    (out.get(e.task) ?? out.set(e.task, []).get(e.task)!).push(e);
  }
  for (const list of out.values()) list.sort(byTime);
  return out;
}

/**
 * Where a task starts: its `add` event, else (the add fell out of the newest-events window)
 * its `createdAt` in the state its first event left, else its first event. A task with no
 * event in the window starts open at `createdAt` (burnUp moves it to its current state at
 * `updatedAt`, so an old finished task does not look done from its creation).
 */
function startOf(evs: readonly TimelineEvent[], task?: Pick<BoardTask, 'createdAt' | 'state' | 'updatedAt'>): { ts: number; state: StoredState } | null {
  const add = evs.find((e) => e.action === 'add');
  if (add) return { ts: add.ts, state: eventTarget(add) ?? 'open' };
  const first = evs[0];
  const created = typeof task?.createdAt === 'number' ? task.createdAt : undefined;
  if (first) {
    const from = asState(first.from) ?? 'open';
    return created !== undefined && created < first.ts ? { ts: created, state: from } : { ts: first.ts, state: from };
  }
  if (task && created !== undefined) return { ts: created, state: 'open' };
  return null;
}

// ── Burn-up ──────────────────────────────────────────────────────────────

export interface BurnPoint {
  t: number;
  /** Tasks on the board, cancelled ones left out (scope). */
  total: number;
  done: number;
  /** Done plus in review. */
  doneReview: number;
}

/**
 * Scope vs done over time: one point per moment something changed (and one at `now` when
 * given). Tasks whose history fell out of the event window start at `createdAt`.
 */
export function burnUp(events: readonly TimelineEvent[], tasks: ReadonlyArray<Pick<BoardTask, 'seq' | 'createdAt' | 'state' | 'updatedAt'>>, now?: number): BurnPoint[] {
  const evs = perTask(events);
  const taskById = new Map(tasks.map((t) => [t.seq, t]));
  const changes: Array<{ ts: number; seq: number; order: number; state: StoredState }> = [];
  const ids = new Set<number>([...taskById.keys(), ...evs.keys()]);
  let order = 0;
  for (const seq of [...ids].sort((a, b) => a - b)) {
    const list = evs.get(seq) || [];
    const start = startOf(list, taskById.get(seq));
    if (!start) continue;
    changes.push({ ts: start.ts, seq, order: order++, state: start.state });
    const task = taskById.get(seq);
    if (!list.length && task) {
      // No history in the window: open from createdAt, its current state from updatedAt.
      const cur = asState(task.state) ?? 'open';
      const at = typeof task.updatedAt === 'number' ? Math.max(task.updatedAt, start.ts) : start.ts;
      if (cur !== 'open') changes.push({ ts: at, seq, order: order++, state: cur });
    }
    for (const e of list) {
      if (e.action === 'add') continue;
      const to = eventTarget(e);
      if (to) changes.push({ ts: e.ts, seq, order: order++, state: to });
    }
  }
  changes.sort((a, b) => a.ts - b.ts || a.order - b.order);
  const state = new Map<number, StoredState>();
  const points: BurnPoint[] = [];
  const snapshot = (t: number): BurnPoint => {
    let total = 0;
    let done = 0;
    let review = 0;
    for (const s of state.values()) {
      if (s === 'cancelled') continue;
      total += 1;
      if (s === 'done') done += 1;
      else if (s === 'review') review += 1;
    }
    return { t, total, done, doneReview: done + review };
  };
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    state.set(c.seq, c.state);
    if (i + 1 < changes.length && changes[i + 1].ts === c.ts) continue;
    const p = snapshot(c.ts);
    const last = points[points.length - 1];
    if (last && last.total === p.total && last.done === p.done && last.doneReview === p.doneReview) continue;
    points.push(p);
  }
  if (now !== undefined && points.length && now > points[points.length - 1].t) points.push({ ...points[points.length - 1], t: now });
  return points;
}

// ── Time in state ────────────────────────────────────────────────────────

export interface StateSegment {
  state: StoredState;
  from: number;
  to: number;
  /** After the task finished (done/cancelled up to now): drawn faded, not counted as time in state. */
  after?: boolean;
}

export interface StateLane {
  seq: number;
  start: number;
  /** `now` while the task is still open; the finishing time for done/cancelled (a faded `after` segment then runs to now). */
  end: number;
  segments: StateSegment[];
  /** The state at the end of the lane. */
  last: StoredState;
  /** How many times it was claimed. */
  claims: number;
}

const TERMINAL: ReadonlySet<StoredState> = new Set(['done', 'cancelled']);

/**
 * One lane per task (sorted by start), segments of consecutive time in one stored state:
 * a repeated claim after a release, a reject back to open and a retry after a failure each
 * start a new segment; an event that does not change the state does not split one. A lane
 * ends at done/cancelled (a reopen continues it), otherwise at `now`; a finished lane gets a
 * faded `after` segment in that state up to now. Event times later than `now` (clock
 * difference on a shared board) are clamped to `now`.
 */
export function timeInState(
  events: readonly TimelineEvent[],
  now: number,
  tasks: ReadonlyArray<Pick<BoardTask, 'seq' | 'createdAt' | 'state' | 'updatedAt'>> = [],
): StateLane[] {
  const evs = perTask(events);
  const taskById = new Map(tasks.map((t) => [t.seq, t]));
  const lanes: StateLane[] = [];
  for (const [seq, list] of evs) {
    const start = startOf(list, taskById.get(seq));
    if (!start) continue;
    const segments: StateSegment[] = [];
    let cur = start.state;
    const startTs = Math.min(start.ts, now);
    let since = startTs;
    let claims = 0;
    for (const e of list) {
      if (e.action === 'add') continue;
      const to = eventTarget(e);
      if (!to) continue;
      if (to === 'claimed' && e.action === 'claim') claims += 1;
      if (to === cur) continue;
      const ts = Math.min(Math.max(e.ts, since), now);
      if (ts > since) segments.push({ state: cur, from: since, to: ts });
      cur = to;
      since = ts;
    }
    const end = TERMINAL.has(cur) ? since : Math.max(since, now);
    if (!TERMINAL.has(cur) && end > since) segments.push({ state: cur, from: since, to: end });
    if (TERMINAL.has(cur) && now > since) segments.push({ state: cur, from: since, to: now, after: true });
    lanes.push({ seq, start: startTs, end, segments, last: cur, claims });
  }
  return lanes.sort((a, b) => a.start - b.start || a.seq - b.seq);
}

/** Median time (ms) spent in `state` per visit across lanes, or null when no lane visited it. */
export function medianTimeIn(lanes: readonly StateLane[], state: StoredState): number | null {
  const d = lanes.flatMap((l) => l.segments.filter((s) => s.state === state && !s.after).map((s) => s.to - s.from)).sort((a, b) => a - b);
  if (!d.length) return null;
  const mid = Math.floor(d.length / 2);
  return d.length % 2 ? d[mid] : Math.round((d[mid - 1] + d[mid]) / 2);
}

/** Total ms per state of one lane (the table view). */
export function laneTotals(lane: StateLane): Partial<Record<StoredState, number>> {
  const out: Partial<Record<StoredState, number>> = {};
  for (const s of lane.segments) if (!s.after) out[s.state] = (out[s.state] || 0) + (s.to - s.from);
  return out;
}
