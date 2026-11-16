// Agent relay safety limits: how many child agents one tab may run, how deep the
// parent → child chain may grow, and how many relay agents the app may hold at once.
// Checked by App.tsx `agent.run` before any tab or worktree is created.
// Design: docs/superpowers/specs/2026-11-16-agent-limits-and-log-design.md
import type { AgentLink } from './agentRelay';

export interface AgentLimits {
  /** Live relay children of one tab. */
  maxChildren: number;
  /** Depth of a new child (a tab with no relay parent is 0, its children 1, …). */
  maxDepth: number;
  /** Live relay agents in the whole app (callerless runs included). */
  maxTotal: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxChildren: 6, maxDepth: 2, maxTotal: 12 };

const BOUNDS: Record<keyof AgentLimits, [number, number]> = {
  maxChildren: [1, 32],
  maxDepth: [1, 5],
  maxTotal: [1, 64],
};

/**
 * config.agents → limits. A finite number is truncated to an integer and clamped to its
 * range (maxChildren 1..32, maxDepth 1..5, maxTotal 1..64); anything else (missing, a
 * string, NaN, Infinity) is the default.
 */
export function normalizeAgentLimits(raw: unknown): AgentLimits {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_AGENT_LIMITS };
  for (const key of Object.keys(BOUNDS) as Array<keyof AgentLimits>) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    const [lo, hi] = BOUNDS[key];
    out[key] = Math.min(hi, Math.max(lo, Math.trunc(n)));
  }
  return out;
}

/** Longest parent chain we walk (a guard on top of the cycle check). */
const MAX_CHAIN = 64;

/**
 * Depth of a tab along the relay parentId chain: 0 when it has no relay parent, else
 * 1 + its parent's depth. A link that recorded its depth when it was created (`depth`)
 * answers for itself and everything above it, so a child whose parent tab closed (its
 * link is kept with parentId '') keeps its depth. A cycle in the chain stops the walk.
 */
export function agentDepth(links: ReadonlyMap<string, AgentLink>, terminalId: string): number {
  let steps = 0;
  let cur = terminalId;
  const seen = new Set<string>([cur]);
  while (steps < MAX_CHAIN) {
    const link = links.get(cur);
    if (link && typeof link.depth === 'number' && Number.isFinite(link.depth) && link.depth >= 0) return steps + link.depth;
    const parent = link?.parentId || '';
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    steps += 1;
    cur = parent;
  }
  return steps;
}

export type AgentLimitName = keyof AgentLimits;

export type AgentRunLimitCheck =
  | { ok: true; depth: number }
  | { ok: false; limit: AgentLimitName; count: number; max: number; depth: number; error: string };

/**
 * May `caller` start one more relay child? `depth` is the new child's depth.
 * - maxDepth: the new child's depth (caller depth + 1) must not exceed it.
 * - maxChildren: live links whose parentId is the caller.
 * - maxTotal: every live link (callerless runs included).
 * A run without a caller is checked against maxTotal only. `pendingParents` are runs
 * accepted but not yet turned into a link (reservations, see createAgentRunReservations),
 * one entry per run with its caller ('' when none) — they count like live children.
 * maxChildren/maxDepth trust the caller id a tab reports (a guard against accidents, not
 * a security boundary); maxTotal counts every link whatever the caller.
 */
export function checkAgentRunLimits(
  links: ReadonlyMap<string, AgentLink>,
  caller: string,
  isLive: (link: AgentLink) => boolean,
  limits: AgentLimits,
  pendingParents: readonly string[] = [],
): AgentRunLimitCheck {
  const callerId = (caller || '').trim();
  const depth = callerId ? agentDepth(links, callerId) + 1 : 0;
  const live = [...links.values()].filter(isLive);
  if (callerId && depth > limits.maxDepth) {
    return {
      ok: false,
      limit: 'maxDepth',
      count: depth - 1,
      max: limits.maxDepth,
      depth,
      error: `depth limit reached: this tab is at depth ${depth - 1} of the agent chain and a child would be at depth ${depth} (max ${limits.maxDepth}; do the work in this tab, or raise agents.maxDepth)`,
    };
  }
  if (callerId) {
    const children = live.filter((l) => l.parentId === callerId).length + pendingParents.filter((p) => p === callerId).length;
    if (children >= limits.maxChildren) {
      return {
        ok: false,
        limit: 'maxChildren',
        count: children,
        max: limits.maxChildren,
        depth,
        error: `child limit reached: this tab already has ${children} live children (max ${limits.maxChildren}; a stopped child still counts: close one with agent stop <id> --close, or raise agents.maxChildren)`,
      };
    }
  }
  const total = live.length + pendingParents.length;
  if (total >= limits.maxTotal) {
    return {
      ok: false,
      limit: 'maxTotal',
      count: total,
      max: limits.maxTotal,
      depth,
      error: `total agent limit reached: the app already has ${total} live relay agents (max ${limits.maxTotal}; a stopped agent still counts: close some with agent stop <id> --close, or raise agents.maxTotal)`,
    };
  }
  return { ok: true, depth };
}

export type AgentRunReservation =
  | { ok: true; depth: number; release: () => void }
  | Extract<AgentRunLimitCheck, { ok: false }>;

/**
 * Check + reserve in one synchronous step, so runs that arrive together (several
 * `agent run --bg` at once, or a `--worktree` run still creating its worktree) cannot all
 * pass the limits before any of them is counted. A reservation counts like a live child
 * of its caller until `release()` — call it right after the child's link is stored (the
 * link counts from then on) or when the run fails. `release` is idempotent.
 */
export function createAgentRunReservations() {
  const held = new Map<number, string>();
  let next = 1;
  return {
    reserve(
      links: ReadonlyMap<string, AgentLink>,
      caller: string,
      isLive: (link: AgentLink) => boolean,
      limits: AgentLimits,
    ): AgentRunReservation {
      const check = checkAgentRunLimits(links, caller, isLive, limits, [...held.values()]);
      if (!check.ok) return check;
      const id = next++;
      held.set(id, (caller || '').trim());
      return { ok: true, depth: check.depth, release: () => { held.delete(id); } };
    },
    /** Callers of the reservations still held ('' for a callerless run). */
    held(): string[] { return [...held.values()]; },
  };
}
