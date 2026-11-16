// Agent relay audit log: one JSON line per relay event in ~/.config/octo/agent-relay.log
// (written by the Rust command agent_relay_log_append, read by agent_relay_log_tail).
// Only ids, names, CLI types, depth, worktree/branch and the length + first 120 characters
// of a prompt or message are recorded — never the environment, tokens or full prompts.
// Design: docs/superpowers/specs/2026-11-16-agent-limits-and-log-design.md
import { oneLine } from './agentRelay';

export type AgentRelayLogEvent = 'run' | 'run_refused' | 'send' | 'stop' | 'exit' | 'caller_refused';

export const AGENT_LOG_TEXT_HEAD = 120;

export interface AgentLogParty { id: string; name?: string; cliType?: string }

export interface AgentRelayLogInput {
  event: AgentRelayLogEvent;
  caller?: AgentLogParty;
  /** How the caller id was checked (src/terminal/agentCaller.ts): token match, or `legacy`
   *  (a PTY-holder tab started by an older app, no token). Left out without a caller. */
  callerVerified?: true | 'legacy';
  target?: AgentLogParty;
  depth?: number;
  worktree?: string;
  branch?: string;
  /** run/send: the prompt or message (only its length and first 120 chars are kept). */
  text?: string;
  /** Any other small scalar fields (reason, ok, keys, closed, by, error, …). */
  extra?: Record<string, string | number | boolean | undefined>;
}

function party(p?: AgentLogParty): Record<string, string> | undefined {
  if (!p) return undefined;
  const id = String(p.id || '').trim();
  const name = String(p.name || '').trim();
  const cliType = String(p.cliType || '').trim();
  if (!id && !name && !cliType) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name: oneLine(name, 80) } : {}),
    ...(cliType ? { cliType } : {}),
  };
}

/** One log entry (a plain JSON object; undefined fields are left out). */
export function buildAgentRelayLogEntry(input: AgentRelayLogInput, now: Date = new Date()): Record<string, unknown> {
  const entry: Record<string, unknown> = { ts: now.toISOString(), event: input.event };
  const caller = party(input.caller);
  const target = party(input.target);
  if (caller) entry.caller = caller;
  if (caller && (input.callerVerified === true || input.callerVerified === 'legacy')) entry.callerVerified = input.callerVerified;
  if (target) entry.target = target;
  if (typeof input.depth === 'number' && Number.isFinite(input.depth)) entry.depth = input.depth;
  if (input.worktree) entry.worktree = input.worktree;
  if (input.branch) entry.branch = input.branch;
  if (typeof input.text === 'string') {
    entry.textLen = Array.from(input.text).length;
    entry.textHead = Array.from(oneLine(input.text, Number.POSITIVE_INFINITY)).slice(0, AGENT_LOG_TEXT_HEAD).join('');
  }
  for (const [k, v] of Object.entries(input.extra || {})) {
    if (v === undefined || k in entry) continue;
    entry[k] = typeof v === 'string' ? oneLine(v, 300) : v;
  }
  return entry;
}
