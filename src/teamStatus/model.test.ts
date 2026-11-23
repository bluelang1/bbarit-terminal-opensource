import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentLink } from '../terminal/agentRelay';
import type { BoardTask } from '../terminal/agentTasks';
import { DARK_STYLES, LIGHT_STYLES, WACKY_STYLES } from '../theme';
import {
  BAR_ORDER,
  CONTRAST_TARGET,
  NEUTRAL_SURFACES,
  STATUS_TOKEN_STATES,
  TS_TOKENS,
  agentActivity,
  agentLoad,
  badgeCount,
  badgeLabel,
  badgeSeverity,
  badgeText,
  boardColumns,
  bucketCounts,
  buildFeed,
  contrast,
  deriveTaskView,
  deriveTaskViews,
  filterViews,
  formatAge,
  isDoneEvent,
  limitUsage,
  needsYou,
  parseHex,
  pickDefaultTeam,
  projectTeams,
  stateBarSegments,
  summarize,
  teamMemberIds,
  teamStatusSurface,
  tintedSurfaces,
  tokenValue,
  tokensPass,
  triesUsed,
} from './model';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

const task = (seq: number, state: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  seq,
  title: `task ${seq}`,
  state,
  attempt: 0,
  maxAttempts: 3,
  priority: 1,
  createdAt: NOW - 60 * MIN,
  updatedAt: NOW - 5 * MIN,
  ...extra,
});

const link = (childId: string, parentId: string, extra: Partial<AgentLink> = {}): AgentLink => ({ childId, parentId, createdAt: 1, lastNotifiedTurn: 0, ...extra });

describe('deriveTaskView', () => {
  it('derives waiting, failed and cancelled dependencies from the current states', () => {
    const tasks = [
      task(1, 'failed'),
      task(2, 'cancelled'),
      task(3, 'open', { deps: [{ seq: 1, state: 'claimed' }, { seq: 2, state: 'cancelled' }] }),
      task(4, 'open', { deps: [{ seq: 2, state: 'cancelled' }] }),
      task(5, 'claimed', { deps: [{ seq: 1, state: 'failed' }] }),
    ];
    const [, , w, met, held] = deriveTaskViews(tasks, NOW, 30 * MIN);
    // #1 is failed now (the list wins over the state sent with #3).
    expect(w).toMatchObject({ display: 'waiting', waiting: true, waitingOn: [1], waitingOnFailed: true, depCancelled: true });
    expect(met).toMatchObject({ display: 'open', waiting: false, waitingOn: [], depCancelled: true });
    // Only an open task waits.
    expect(held).toMatchObject({ display: 'claimed', waiting: false });
  });

  it('marks claimed and blocked tasks stale after staleMs, never on a mirror', () => {
    const old = task(1, 'claimed', { updatedAt: NOW - 31 * MIN, owner: { id: 't2', name: 'rev' } });
    expect(deriveTaskView(old, new Map(), NOW, 30 * MIN)).toMatchObject({ stale: true, ownerId: 't2', ownerName: 'rev', ageMs: 31 * MIN });
    expect(deriveTaskView(old, new Map(), NOW, 30 * MIN, { mirror: true }).stale).toBe(false);
    expect(deriveTaskView({ ...old, state: 'blocked' }, new Map(), NOW, 30 * MIN).stale).toBe(true);
    expect(deriveTaskView({ ...old, state: 'open' }, new Map(), NOW, 30 * MIN).stale).toBe(false);
    expect(deriveTaskView({ ...old, updatedAt: NOW - 29 * MIN }, new Map(), NOW, 30 * MIN).stale).toBe(false);
  });

  it('falls back for unknown states and missing numbers', () => {
    const v = deriveTaskView({ seq: 9, title: 'x', state: 'weird' }, new Map(), NOW, MIN);
    expect(v).toMatchObject({ state: 'open', display: 'open', attempt: 0, maxAttempts: 3, priority: 1, labels: [], ageMs: 0 });
  });
});

describe('summarize and the state bar', () => {
  const views = deriveTaskViews([
    task(1, 'done'), task(2, 'done'), task(3, 'review'), task(4, 'claimed', { updatedAt: NOW - 40 * MIN }),
    task(5, 'open', { deps: [{ seq: 4, state: 'claimed' }] }), task(6, 'cancelled'), task(7, 'failed'),
  ], NOW, 30 * MIN);

  it('counts display states and leaves cancelled out of the total', () => {
    const s = summarize(views);
    expect(s.counts).toMatchObject({ done: 2, review: 1, claimed: 1, waiting: 1, cancelled: 1, failed: 1, open: 0 });
    expect(s.total).toBe(6);
    expect(s.cancelled).toBe(1);
    expect(s.stale).toBe(1);
  });

  it('lays segments out in the fixed order with exact gaps and a 4px minimum', () => {
    const segs = stateBarSegments({ done: 100, review: 1, failed: 1, waiting: 0, cancelled: 5 }, 300, 2);
    expect(segs.map((s) => s.state)).toEqual(['done', 'review', 'failed']);
    expect(segs.every((s) => s.w >= 4)).toBe(true);
    const last = segs[segs.length - 1];
    expect(last.x + last.w).toBe(300);
    for (let i = 1; i < segs.length; i++) expect(segs[i].x).toBe(segs[i - 1].x + segs[i - 1].w + 2);
  });

  it('sums exactly for awkward widths and handles empty or tiny bars', () => {
    for (const width of [97, 100, 101, 333, 1201]) {
      const segs = stateBarSegments({ done: 3, review: 3, blocked: 3, claimed: 1, failed: 2, open: 7, waiting: 1 }, width, 2);
      expect(segs.reduce((n, s) => n + s.w, 0) + 2 * (segs.length - 1)).toBe(width);
      expect(segs.map((s) => s.state)).toEqual([...BAR_ORDER]);
    }
    expect(stateBarSegments({}, 300)).toEqual([]);
    expect(stateBarSegments({ done: 1 }, 0)).toEqual([]);
    expect(stateBarSegments({ done: 1, open: 1, review: 1 }, 12, 2).reduce((n, s) => n + s.w, 0)).toBe(8);
  });
});

describe('needsYou and badges', () => {
  const views = deriveTaskViews([
    task(1, 'review', { updatedAt: NOW - 4 * MIN, owner: { id: 't2' }, result: { summary: 'split token' } }),
    task(2, 'failed', { updatedAt: NOW - 12 * MIN, attempt: 2, lastError: 'lint exit 1' }),
    task(3, 'claimed', { updatedAt: NOW - 42 * MIN, owner: { id: 't5' } }),
    task(4, 'blocked', { updatedAt: NOW - 50 * MIN, blockedReason: 'needs key' }),
    task(5, 'open', { deps: [{ seq: 2, state: 'failed' }] }),
    task(6, 'claimed'),
  ], NOW, 30 * MIN);
  const agents = [
    { id: 't4', name: 'builder', status: 'blocked' as const, since: NOW - 3 * MIN, message: 'which DB url?' },
    { id: 't6', status: 'working' as const },
  ];
  const refusals = [{ ts: NOW - 9 * MIN, limit: 'maxChildren', caller: { id: 't1' } }, { ts: NOW - 2 * 60 * MIN, limit: 'maxTotal' }];

  it('orders by severity then age and keeps a stale blocked task as one item', () => {
    const items = needsYou(views, agents, refusals, NOW);
    expect(items.map((i) => i.key)).toEqual(['failed:2', 'agent:t4', 'blocked:4', 'review:1', 'stale:3', expect.stringMatching(/^refusal:/)]);
    expect(items.find((i) => i.key === 'blocked:4')).toMatchObject({ stale: true, detail: 'needs key' });
    expect(items[0]).toMatchObject({ attempt: 3, maxAttempts: 3, detail: 'lint exit 1', ageMs: 12 * MIN });
    expect(items[1]).toMatchObject({ tabId: 't4', detail: 'which DB url?' });
    // Waiting (#5) and old refusals are not there; refusals never count.
    expect(badgeCount(items)).toBe(5);
    expect(badgeSeverity(items)).toBe('failed');
  });

  it('scopes refusals to team members and keys them without a list index', () => {
    const rs = [
      { ts: NOW - MIN, limit: 'maxChildren', caller: { id: 't1' } },
      { ts: NOW - MIN, limit: 'maxChildren', caller: { id: 't1' } },
      { ts: NOW - 2 * MIN, limit: 'maxTotal', caller: { id: 'other-team-tab' } },
      { ts: NOW - 3 * MIN, limit: 'maxTotal' },
    ];
    const mine = needsYou([], [], rs, NOW, { members: new Set(['t1', 't2']) });
    expect(mine.map((i) => i.key)).toEqual([`refusal:${NOW - MIN}:t1:maxChildren`]);
    expect(needsYou([], [], rs, NOW).length).toBe(3);
  });

  it('counts tries as people do: the first try is 1, a retry makes it 2, capped at the maximum', () => {
    const v = (attempt: number, state = 'failed') => deriveTaskView(task(1, state, { attempt, maxAttempts: 3 }), new Map(), NOW, MIN);
    expect(v(0).tries).toBe(1);
    expect(needsYou([v(0)], [], [], NOW)[0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(v(1, 'claimed').tries).toBe(2);
    expect(v(7).tries).toBe(3);
    expect(triesUsed(undefined, undefined)).toBe(1);
  });

  it('shows mirror task items without actions', () => {
    const items = needsYou(views, [], [], NOW, { mirror: true });
    expect(items.every((i) => !i.actionable)).toBe(true);
    expect(badgeCount(items)).toBe(0);
    expect(badgeSeverity(items)).toBe(null);
  });

  it('labels and caps the badge', () => {
    const items = needsYou(views, agents, refusals, NOW);
    expect(badgeLabel(items, 'en')).toBe('5 items need you: 1 review, 1 failed, 1 blocked agent, 1 blocked task, 1 stale');
    expect(badgeLabel([...items, { ...items[2], key: 'blocked:x' }], 'en')).toContain('2 blocked tasks');
    expect(badgeLabel(items, 'ko')).toBe('처리할 일 5개: 검수 대기 1, 실패 1, 막힌 에이전트 1, 막힌 할 일 1, 멈춘 작업 1');
    expect(badgeLabel([], 'en')).toBe('Nothing needs you');
    expect(badgeLabel(items.slice(3, 4), 'en')).toBe('1 item needs you: 1 review');
    expect(badgeText(12)).toBe('9+');
    expect(badgeText(4)).toBe('4');
    expect(badgeSeverity(items.filter((i) => i.kind === 'review' || i.kind === 'stale'))).toBe('review');
    expect(badgeSeverity(items.filter((i) => i.kind === 'stale'))).toBe('stale');
  });
});

describe('series', () => {
  it('buckets events into a window ending now, oldest first', () => {
    const ev = [
      { ts: NOW - 1, action: 'done', to: 'done' },
      { ts: NOW - 10 * MIN, action: 'done', to: 'done' },
      { ts: NOW - 10 * MIN - 1, action: 'approve', to: 'done' },
      { ts: NOW - 125 * MIN, action: 'done', to: 'done' },
      { ts: NOW, action: 'done', to: 'done' },
      { ts: NOW - 5 * MIN, action: 'claim', to: 'claimed' },
    ];
    const s = bucketCounts(ev, isDoneEvent, NOW, 10 * MIN, 12);
    expect(s).toHaveLength(12);
    expect(s[11]).toBe(2);
    expect(s[10]).toBe(1);
    expect(s.reduce((a, b) => a + b, 0)).toBe(3);
    expect(bucketCounts(ev, 'claim', NOW, 10 * MIN, 12)[11]).toBe(1);
    expect(bucketCounts(ev, 'claim', NOW, 0, 3)).toEqual([0, 0, 0]);
  });

  it('counts tasks held and activity per agent', () => {
    const views = deriveTaskViews([task(1, 'claimed', { owner: { id: 'a' } }), task(2, 'review', { owner: { id: 'a' } }), task(3, 'blocked', { owner: { id: 'b' } }), task(4, 'done', { owner: { id: 'a' } })], NOW, 30 * MIN);
    expect(agentLoad(views, ['a', 'b', 'c'])).toEqual({
      a: { claimed: 1, blocked: 0, review: 1, seqs: [1, 2] },
      b: { claimed: 0, blocked: 1, review: 0, seqs: [3] },
      c: { claimed: 0, blocked: 0, review: 0, seqs: [] },
    });
    const act = agentActivity('a', [{ ts: NOW - MIN, action: 'claim', actor: { id: 'a' } }, { ts: NOW - MIN, action: 'claim', actor: { id: 'b' } }], [{ seq: 1, ts: NOW - 7 * MIN, kind: 'note', text: 'x', author: { id: 'a' } }], NOW);
    expect(act.series.reduce((x, y) => x + y, 0)).toBe(2);
    expect(act.series[11]).toBe(1);
    expect(act.lastAt).toBe(NOW - MIN);
    expect(agentActivity('z', [], [], NOW).lastAt).toBeUndefined();
  });
});

describe('limits and teams', () => {
  const links = new Map<string, AgentLink>([
    ['c1', link('c1', 'root', { teamId: 'root' })],
    ['c2', link('c2', 'root', { teamId: 'root' })],
    ['g1', link('g1', 'c1', { teamId: 'root' })],
    ['x1', link('x1', 'other')],
    ['dead', link('dead', 'root', { exited: true })],
  ]);
  const live = (l: AgentLink) => !l.exited;

  it('reports the busiest parent, the deepest child and the total like checkAgentRunLimits', () => {
    const u = limitUsage(links, { maxChildren: 6, maxDepth: 2, maxTotal: 12 }, live);
    expect(u.children).toMatchObject({ used: 2, max: 6, parent: 'root' });
    expect(u.children.perParent).toEqual([{ id: 'root', n: 2 }, { id: 'c1', n: 1 }, { id: 'other', n: 1 }]);
    expect(u.depth).toEqual({ used: 2, max: 2 });
    expect(u.total).toEqual({ used: 4, max: 12 });
  });

  it('lists team members and maps teams to projects', () => {
    expect(teamMemberIds(links, 'root').sort()).toEqual(['c1', 'c2', 'dead', 'g1', 'root']);
    const projects = [{ id: 'P1', terminalIds: ['root', 'c1'] }, { id: 'P2', terminalIds: ['x1', 'solo'] }];
    const m = projectTeams(projects, links, ['root', 'other', 'solo', 'gone']);
    expect(m.get('P1')).toEqual(['root']);
    expect(m.get('P2')).toEqual(['other', 'solo']);
  });

  it('picks the remembered team, else the active project team, else the most recent', () => {
    const teams = [{ team: 'a', updatedTs: 3 }, { team: 'b', updatedTs: 5 }, { team: 'c', updatedTs: 1 }];
    expect(pickDefaultTeam(teams, ['c'], 'a')).toBe('a');
    expect(pickDefaultTeam(teams, ['c', 'a'], 'gone')).toBe('a');
    expect(pickDefaultTeam(teams, [])).toBe('b');
    expect(pickDefaultTeam([], [])).toBe('');
  });
});

describe('board columns, filters, feed', () => {
  const views = deriveTaskViews([
    task(1, 'open', { priority: 0 }), task(2, 'open', { priority: 3 }), task(3, 'open', { deps: [{ seq: 4, state: 'claimed' }] }),
    task(4, 'claimed', { owner: { id: 'a' }, labels: ['ui'] }), task(5, 'blocked'), task(6, 'review'), task(7, 'done'), task(8, 'failed'), task(9, 'cancelled'),
  ], NOW, 30 * MIN);

  it('groups five or three columns, blocked first in Working, waiting last in To do', () => {
    const five = boardColumns(views, { columns: 5 });
    expect(five.map((c) => [c.key, c.views.map((v) => v.seq)])).toEqual([
      ['todo', [2, 1, 3]], ['working', [5, 4]], ['review', [6]], ['done', [7]], ['failed', [8]],
    ]);
    const three = boardColumns(views, { columns: 3, showCancelled: true });
    expect(three.map((c) => c.key)).toEqual(['todo', 'working', 'finished']);
    expect(three[2].views.map((v) => v.seq).sort()).toEqual([6, 7, 8, 9]);
  });

  it('filters by state, agent, label and #seq or title', () => {
    expect(filterViews(views, { states: new Set(['waiting']) }).map((v) => v.seq)).toEqual([3]);
    expect(filterViews(views, { states: new Set(), agent: 'a' }).map((v) => v.seq)).toEqual([4]);
    expect(filterViews(views, { states: new Set(), label: 'ui' }).map((v) => v.seq)).toEqual([4]);
    expect(filterViews(views, { states: new Set(), search: '#7' }).map((v) => v.seq)).toEqual([7]);
    expect(filterViews(views, { states: new Set(), search: 'TASK 8' }).map((v) => v.seq)).toEqual([8]);
  });

  it('merges events and posts newest first and leaves done notes out', () => {
    const feed = buildFeed(
      [{ id: 'e1', ts: 10, action: 'claim', task: 1, actor: { id: 'a', name: 'A' } }, { id: 'e2', ts: 30, action: 'done', task: 1, to: 'done', actor: { id: 'a' } }],
      [{ seq: 1, ts: 20, kind: 'note', text: 'found flaky test', author: { id: 'b' } }, { seq: 2, ts: 31, kind: 'done', text: '#1 done', task: 1 }],
      10,
    );
    expect(feed.map((f) => f.key)).toEqual(['e:e2', 'p:1', 'e:e1']);
    expect(feed[2]).toMatchObject({ actorName: 'A', action: 'claim', task: 1 });
    expect(buildFeed([], [{ seq: 1, ts: 1, kind: 'note', text: 'x' }], 0)).toEqual([]);
  });
});

describe('formatAge', () => {
  it('is compact in both languages', () => {
    expect(formatAge(30_000, 'en')).toBe('now');
    expect(formatAge(4 * MIN, 'en')).toBe('4m');
    expect(formatAge(125 * MIN, 'en')).toBe('2h');
    expect(formatAge(3 * 24 * 60 * MIN, 'en')).toBe('3d');
    expect(formatAge(4 * MIN, 'ko')).toBe('4분');
    expect(formatAge(30_000, 'ko')).toBe('방금');
    expect(formatAge(-5, 'en')).toBe('now');
    expect(formatAge(Number.NaN, 'en')).toBe('now');
  });
});

describe('status colors (section 5)', () => {
  const builtIn = [...DARK_STYLES, ...LIGHT_STYLES];

  it('every status mark and ink meets its target on both tinted surfaces of every built-in theme', () => {
    const misses: string[] = [];
    for (const style of builtIn) {
      const s = tintedSurfaces(style.bg)!;
      for (const state of STATUS_TOKEN_STATES) {
        for (const role of ['mark', 'ink'] as const) {
          const c = parseHex(tokenValue(s.polarity, state, role))!;
          for (const [name, surf] of [['surface', s.surface], ['raised', s.raised]] as const) {
            const r = contrast(c, surf);
            if (r < CONTRAST_TARGET[role]) misses.push(`${style.name} ${s.polarity} ${state} ${role} on ${name}: ${r.toFixed(2)}`);
          }
        }
      }
    }
    expect(misses).toEqual([]);
    expect(builtIn.every((s) => teamStatusSurface(s) === 'tinted')).toBe(true);
  });

  it('meets the targets on the neutral surfaces, which wacky and imported themes use', () => {
    expect(tokensPass('dark', NEUTRAL_SURFACES.dark)).toBe(true);
    expect(tokensPass('light', NEUTRAL_SURFACES.light)).toBe(true);
    expect(WACKY_STYLES.every((s) => teamStatusSurface(s) === 'neutral')).toBe(true);
    expect(teamStatusSurface({ name: 'Imported', bg: '#202020', text: '#dddddd' })).toBe('neutral');
  });

  it('teamStatus.css carries exactly the tested token values', () => {
    const css = readFileSync(join(__dirname, 'teamStatus.css'), 'utf8');
    const block = (selector: string) => {
      const i = css.indexOf(`${selector} {`);
      expect(i, selector).toBeGreaterThanOrEqual(0);
      return css.slice(i, css.indexOf('}', i));
    };
    const read = (text: string) => Object.fromEntries([...text.matchAll(/--ts-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]));
    const dark = read(block('.team-status, .ts-badge'));
    const light = read(block('.light-theme .team-status, .light-theme .ts-badge'));
    for (const [k, v] of Object.entries(TS_TOKENS.dark)) expect(dark[k], `dark ${k}`).toBe(v);
    for (const [k, v] of Object.entries(TS_TOKENS.light)) expect(light[k], `light ${k}`).toBe(v);
  });
});
