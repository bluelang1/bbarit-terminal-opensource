import { describe, expect, it } from 'vitest';
import type { AgentLink } from './agentRelay';
import { agentDepth, checkAgentRunLimits, createAgentRunReservations, DEFAULT_AGENT_LIMITS, normalizeAgentLimits } from './agentLimits';
import { orphanAgentLink, restoreAgentLinks, serializeAgentLinks } from './agentRelay';

function link(childId: string, parentId: string, extra: Partial<AgentLink> = {}): AgentLink {
  return { childId, parentId, createdAt: 0, lastNotifiedTurn: -1, ...extra };
}

function mapOf(...links: AgentLink[]): Map<string, AgentLink> {
  return new Map(links.map((l) => [l.childId, l]));
}

const liveAll = (l: AgentLink) => !l.exited;

describe('normalizeAgentLimits', () => {
  it('defaults when missing or not an object', () => {
    expect(normalizeAgentLimits(undefined)).toEqual(DEFAULT_AGENT_LIMITS);
    expect(normalizeAgentLimits(null)).toEqual(DEFAULT_AGENT_LIMITS);
    expect(normalizeAgentLimits('6')).toEqual(DEFAULT_AGENT_LIMITS);
    expect(normalizeAgentLimits([1, 2])).toEqual(DEFAULT_AGENT_LIMITS);
    expect(DEFAULT_AGENT_LIMITS).toEqual({ maxChildren: 6, maxDepth: 2, maxTotal: 12 });
  });

  it('keeps valid integers', () => {
    expect(normalizeAgentLimits({ maxChildren: 3, maxDepth: 4, maxTotal: 20 })).toEqual({ maxChildren: 3, maxDepth: 4, maxTotal: 20 });
  });

  it('truncates and clamps numbers to their range', () => {
    expect(normalizeAgentLimits({ maxChildren: 100, maxDepth: 0, maxTotal: -5 })).toEqual({ maxChildren: 32, maxDepth: 1, maxTotal: 1 });
    expect(normalizeAgentLimits({ maxChildren: 2.9, maxDepth: 9, maxTotal: 64.5 })).toEqual({ maxChildren: 2, maxDepth: 5, maxTotal: 64 });
  });

  it('invalid values fall back to the default per key', () => {
    expect(normalizeAgentLimits({ maxChildren: '3', maxDepth: Number.NaN, maxTotal: Number.POSITIVE_INFINITY }))
      .toEqual(DEFAULT_AGENT_LIMITS);
    expect(normalizeAgentLimits({ maxDepth: 3 })).toEqual({ ...DEFAULT_AGENT_LIMITS, maxDepth: 3 });
  });
});

describe('agentDepth', () => {
  it('is 0 without a relay parent and counts the chain', () => {
    const links = mapOf(link('c1', 'root'), link('g1', 'c1'), link('x', ''));
    expect(agentDepth(links, 'root')).toBe(0);
    expect(agentDepth(links, 'unknown')).toBe(0);
    expect(agentDepth(links, 'x')).toBe(0);
    expect(agentDepth(links, 'c1')).toBe(1);
    expect(agentDepth(links, 'g1')).toBe(2);
  });

  it('stops at a cycle instead of looping', () => {
    const links = mapOf(link('a', 'b'), link('b', 'a'), link('self', 'self'));
    expect(agentDepth(links, 'a')).toBe(1);
    expect(agentDepth(links, 'b')).toBe(1);
    expect(agentDepth(links, 'self')).toBe(0);
  });

  it('counts exited ancestors (the chain is structural)', () => {
    const links = mapOf(link('c1', 'root', { exited: true }), link('g1', 'c1'));
    expect(agentDepth(links, 'g1')).toBe(2);
  });
});

describe('checkAgentRunLimits', () => {
  it('allows a run under every limit and reports the new depth', () => {
    const links = mapOf(link('c1', 'root'));
    expect(checkAgentRunLimits(links, 'root', liveAll, DEFAULT_AGENT_LIMITS)).toEqual({ ok: true, depth: 1 });
    expect(checkAgentRunLimits(links, 'c1', liveAll, DEFAULT_AGENT_LIMITS)).toEqual({ ok: true, depth: 2 });
  });

  it('refuses a child beyond maxDepth (default: a depth-2 tab cannot run one)', () => {
    const links = mapOf(link('c1', 'root'), link('g1', 'c1'));
    const r = checkAgentRunLimits(links, 'g1', liveAll, DEFAULT_AGENT_LIMITS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.limit).toBe('maxDepth');
    expect(r.depth).toBe(3);
    expect(r.count).toBe(2);
    expect(r.error).toContain('depth limit reached');
    expect(r.error).toContain('agents.maxDepth');
    expect(r.error).toContain('depth 2');
  });

  it('refuses the 7th live child of one tab with the brief text', () => {
    const kids = Array.from({ length: 6 }, (_, i) => link(`c${i}`, 'root'));
    const r = checkAgentRunLimits(mapOf(...kids), 'root', liveAll, DEFAULT_AGENT_LIMITS);
    expect(r).toMatchObject({ ok: false, limit: 'maxChildren', count: 6, max: 6 });
    if (r.ok) return;
    expect(r.error).toBe('child limit reached: this tab already has 6 live children (max 6; a stopped child still counts: close one with agent stop <id> --close, or raise agents.maxChildren)');
  });

  it('does not count exited / closed children or grandchildren', () => {
    const kids = Array.from({ length: 6 }, (_, i) => link(`c${i}`, 'root', { exited: i === 0 }));
    kids.push(link('g', 'c1'));
    expect(checkAgentRunLimits(mapOf(...kids), 'root', liveAll, DEFAULT_AGENT_LIMITS).ok).toBe(true);
    const closed = new Set(['c2']);
    const all = Array.from({ length: 6 }, (_, i) => link(`c${i}`, 'root'));
    expect(checkAgentRunLimits(mapOf(...all), 'root', (l) => !l.exited && !closed.has(l.childId), DEFAULT_AGENT_LIMITS).ok).toBe(true);
  });

  it('counts pending worktree runs as children and towards the total', () => {
    const kids = Array.from({ length: 5 }, (_, i) => link(`c${i}`, 'root'));
    const links = mapOf(...kids);
    expect(checkAgentRunLimits(links, 'root', liveAll, DEFAULT_AGENT_LIMITS, ['other']).ok).toBe(true);
    expect(checkAgentRunLimits(links, 'root', liveAll, DEFAULT_AGENT_LIMITS, ['root'])).toMatchObject({ ok: false, limit: 'maxChildren', count: 6 });
    expect(checkAgentRunLimits(links, 'x', liveAll, { ...DEFAULT_AGENT_LIMITS, maxTotal: 7 }, ['a', ''])).toMatchObject({ ok: false, limit: 'maxTotal', count: 7 });
  });

  it('refuses beyond maxTotal across all tabs, callerless runs included', () => {
    const links = mapOf(
      ...Array.from({ length: 5 }, (_, i) => link(`a${i}`, 'A')),
      ...Array.from({ length: 5 }, (_, i) => link(`b${i}`, 'B')),
      link('n1', ''),
      link('n2', ''),
    );
    const r = checkAgentRunLimits(links, 'C', liveAll, DEFAULT_AGENT_LIMITS);
    expect(r).toMatchObject({ ok: false, limit: 'maxTotal', count: 12, max: 12, depth: 1 });
    if (r.ok) return;
    expect(r.error).toContain('agents.maxTotal');
    expect(r.error).toContain('12 live relay agents');
  });

  it('a run without a caller is checked against maxTotal only', () => {
    const deep = mapOf(link('c', 'root'), link('g', 'c'));
    expect(checkAgentRunLimits(deep, '', liveAll, { maxChildren: 1, maxDepth: 1, maxTotal: 12 })).toEqual({ ok: true, depth: 0 });
    const full = mapOf(...Array.from({ length: 3 }, (_, i) => link(`n${i}`, '')));
    expect(checkAgentRunLimits(full, '  ', liveAll, { maxChildren: 32, maxDepth: 5, maxTotal: 3 })).toMatchObject({ ok: false, limit: 'maxTotal' });
  });

  it('checks depth before the counts', () => {
    const links = mapOf(link('c', 'root'), link('g', 'c'));
    const r = checkAgentRunLimits(links, 'g', liveAll, { maxChildren: 1, maxDepth: 2, maxTotal: 1 });
    expect(r).toMatchObject({ ok: false, limit: 'maxDepth' });
  });
});

describe('agent run limits wiring', () => {
  it('App checks the limits before any tab or worktree and logs every relay event', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    const run = app.slice(app.indexOf("case 'agent.run': {"), app.indexOf("case 'agent.run.result': {"));
    const check = run.indexOf('agentRunReservationsRef.current.reserve(');
    expect(check).toBeGreaterThan(0);
    // Check + reserve happen after the last await and before any tab or worktree exists.
    expect(check).toBeGreaterThan(run.lastIndexOf('await '));
    expect(check).toBeLessThan(run.indexOf('addTerminal('));
    expect(check).toBeLessThan(run.indexOf('prepareAgentWorktree('));
    // The slot is handed back once the link exists, and on every failure path.
    expect(run.match(/releaseSlot\(\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(run).toContain("event: 'run_refused'");
    expect(run).toContain("event: 'run'");
    expect(app).toContain("event: 'send'");
    expect(app).toContain("event: 'stop'");
    expect(app).toContain("event: 'exit'");
    expect(app).toContain("case 'agent.log':");
    // Logging is fire and forget: the invoke is never awaited.
    expect(app).not.toContain("await invoke('agent_relay_log_append'");
  });
});

describe('createAgentRunReservations', () => {
  it('runs that arrive together cannot all pass: each reserve counts at once', () => {
    const r = createAgentRunReservations();
    const links = mapOf(...Array.from({ length: 5 }, (_, i) => link(`c${i}`, 'root')));
    const results = Array.from({ length: 5 }, () => r.reserve(links, 'root', liveAll, DEFAULT_AGENT_LIMITS));
    expect(results.map((x) => x.ok)).toEqual([true, false, false, false, false]);
    expect(results[1]).toMatchObject({ ok: false, limit: 'maxChildren', count: 6 });
    expect(r.held()).toEqual(['root']);
  });

  it('a released slot (run failed) is free again; a stored link takes its place', () => {
    const r = createAgentRunReservations();
    const links = mapOf(...Array.from({ length: 5 }, (_, i) => link(`c${i}`, 'root')));
    const first = r.reserve(links, 'root', liveAll, DEFAULT_AGENT_LIMITS);
    if (!first.ok) throw new Error('expected a slot');
    first.release();
    first.release(); // idempotent
    expect(r.held()).toEqual([]);
    const second = r.reserve(links, 'root', liveAll, DEFAULT_AGENT_LIMITS);
    if (!second.ok) throw new Error('expected a slot');
    links.set('c5', link('c5', 'root', { depth: second.depth }));
    second.release();
    expect(r.reserve(links, 'root', liveAll, DEFAULT_AGENT_LIMITS)).toMatchObject({ ok: false, limit: 'maxChildren', count: 6 });
  });

  it('reservations count toward maxTotal across callers, callerless included', () => {
    const r = createAgentRunReservations();
    const limits = { ...DEFAULT_AGENT_LIMITS, maxTotal: 3 };
    const links = mapOf(link('a', 'A'));
    expect(r.reserve(links, '', liveAll, limits).ok).toBe(true);
    expect(r.reserve(links, 'B', liveAll, limits).ok).toBe(true);
    expect(r.reserve(links, 'C', liveAll, limits)).toMatchObject({ ok: false, limit: 'maxTotal', count: 3 });
  });
});

describe('orphaned children (parent tab closed)', () => {
  it('keep their depth and still count toward maxTotal, but are nobody\'s child', () => {
    const links = mapOf(link('c', 'root'), link('g', 'c'));
    const gDepth = agentDepth(links, 'g');
    const cDepth = agentDepth(links, 'c');
    // root closes: c is orphaned; then c closes too: g is orphaned.
    links.set('c', orphanAgentLink(links.get('c')!, cDepth));
    expect(links.get('c')).toMatchObject({ parentId: '', depth: 1 });
    expect(agentDepth(links, 'g')).toBe(2);
    links.set('g', orphanAgentLink(links.get('g')!, gDepth));
    links.delete('c');
    expect(agentDepth(links, 'g')).toBe(2);
    // g still cannot start a child (depth 3 > 2), and it is counted in the total.
    expect(checkAgentRunLimits(links, 'g', liveAll, DEFAULT_AGENT_LIMITS)).toMatchObject({ ok: false, limit: 'maxDepth' });
    expect(checkAgentRunLimits(links, 'x', liveAll, { ...DEFAULT_AGENT_LIMITS, maxTotal: 1 })).toMatchObject({ ok: false, limit: 'maxTotal', count: 1 });
  });

  it('a recorded depth answers for the link (no chain walk needed)', () => {
    const links = mapOf(link('k', '', { depth: 2 }), link('kk', 'k'));
    expect(agentDepth(links, 'k')).toBe(2);
    expect(agentDepth(links, 'kk')).toBe(3);
  });
});

describe('caller-less and orphaned links survive a restart', () => {
  it('are saved, restored as parentId \'\' with their depth, and counted toward maxTotal', () => {
    const saved = JSON.parse(JSON.stringify(serializeAgentLinks([
      link('n1', '', { depth: 0 }),
      link('c1', 'p', { depth: 1 }),
      link('o1', '', { depth: 2 }),
      link('x', '', { exited: true }),
    ])));
    expect(saved.map((l: { childId: string }) => l.childId)).toEqual(['n1', 'c1', 'o1']);
    // Parent p did not come back: c1 is restored orphaned, depth kept.
    const restored = restoreAgentLinks(saved, new Set(['n1', 'c1', 'o1']), 9);
    expect(restored.map((l) => [l.childId, l.parentId, l.depth])).toEqual([['n1', '', 0], ['c1', '', 1], ['o1', '', 2]]);
    const links = mapOf(...restored);
    expect(checkAgentRunLimits(links, '', liveAll, { ...DEFAULT_AGENT_LIMITS, maxTotal: 3 })).toMatchObject({ ok: false, limit: 'maxTotal', count: 3 });
    // Nobody's child: no tab sees them as its children.
    expect(restored.some((l) => !!l.parentId)).toBe(false);
  });
});
