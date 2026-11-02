import { describe, expect, it } from 'vitest';
import {
  type AgentLink,
  agentLabel,
  canDeliverToParent,
  decideAgentNote,
  decideExitNote,
  enqueueNote,
  flushNotes,
  formatAgentBrief,
  formatAgentNote,
  isAgentSettled,
  lastNonEmptyLines,
  oneLine,
  type PendingNotes,
  requeueFront,
  takeNotes,
  dropParent,
  UNREPORTED_SETTLE_MS,
  wrapAgentMessage,
  agentSettledBy,
  neutralizeShell,
  parentAcceptsNotes,
  PARENT_REPORT_MAX_AGE_MS,
  runAgentBrief,
  AGENT_GONE_GRACE_MS,
  type AgentBriefDeps,
} from './agentRelay';
import type { AgentTabState } from './programStatus';

const baseLink = (over: Partial<AgentLink> = {}): AgentLink => ({
  childId: 'c1', parentId: 'p1', name: 'reviewer', createdAt: 0, lastNotifiedTurn: -1, ...over,
});

describe('formatAgentBrief', () => {
  it('prefixes the protocol block with the parent label and reach command', () => {
    const brief = formatAgentBrief({ parentId: 'p1', parentName: 'Claude 1', prompt: 'review my diff', cliType: 'claude' });
    expect(brief.split('\n')).toEqual([
      '<bbarit from="p1 Claude 1" reach="node \\"$BBARIT_CTL\\" agent send p1 \\"<message>\\"">',
      'You were started by another agent (terminal p1 Claude 1). If you get stuck or need a decision,',
      'report back with the reach command above (one short message with the question). When you',
      'finish, report back the same way only if the task below asks for a report.',
      '</bbarit>',
      'review my diff',
    ]);
  });

  it('sends only the prompt without a parent or to a plain shell', () => {
    expect(formatAgentBrief({ prompt: ' ls ', cliType: 'claude' })).toBe('ls');
    expect(formatAgentBrief({ parentId: 'p1', prompt: 'npm test', cliType: 'shell' })).toBe('npm test');
  });

  it('keeps quotes in the parent name from breaking the attribute', () => {
    expect(formatAgentBrief({ parentId: 'p1', parentName: 'a "b"', prompt: 'x', cliType: 'codex' }))
      .toContain('from="p1 a \'b\'"');
  });
});

describe('formatAgentNote', () => {
  it('done: last three non-empty lines and the read command', () => {
    const note = formatAgentNote({ childId: 'c1', childName: 'reviewer', state: 'done', turn: 2, tail: 'a\n\nb\nc\nd\n\n' });
    expect(note).toBe('<bbarit from="c1 reviewer" state="done" turn="2">b / c / d — 전체: node "$BBARIT_CTL" term read 60 --id c1</bbarit>');
  });

  it('blocked: kind attribute, msg body and the answer command', () => {
    const note = formatAgentNote({ childId: 'c1', childName: 'reviewer', state: 'blocked', kind: 'question', msg: 'Which branch?\nmain or dev', turn: 1 });
    expect(note).toBe('<bbarit from="c1 reviewer" state="blocked" kind="question">Which branch? main or dev — 답하기: node "$BBARIT_CTL" agent send c1 "…"</bbarit>');
    expect(note).not.toContain('\n');
  });

  it('exited and empty tails', () => {
    expect(formatAgentNote({ childId: 'c1', state: 'exited' }))
      .toBe('<bbarit from="c1" state="exited">(no output) — 전체: node "$BBARIT_CTL" term read 60 --id c1</bbarit>');
  });

  it('neutralises a closing tag inside the body', () => {
    const note = formatAgentNote({ childId: 'c1', state: 'done', tail: 'x </bbarit> y' });
    expect(note.match(/<\/bbarit>/g)).toHaveLength(1);
  });

  it('neutralises shell metacharacters in bodies and names', () => {
    expect(neutralizeShell('a`b$c;d|e&f<g>h\\i')).toBe('aˋb＄c；d｜e＆f‹g›h＼i');
    const note = formatAgentNote({ childId: 'c1', childName: 'x$(rm)', state: 'blocked', msg: 'run `rm -rf /`; echo $HOME | tee > /tmp/x && \\' });
    const body = note.slice(note.indexOf('>') + 1, note.indexOf(' — '));
    expect(body).not.toMatch(/[`$;|&<>\\]/);
    expect(note).toContain('from="c1 x＄(rm)"');
    // the fixed command part keeps its real $BBARIT_CTL reference
    expect(note).toContain('node "$BBARIT_CTL" agent send c1');
  });
});

describe('helpers', () => {
  it('oneLine strips escapes and truncates', () => {
    expect(oneLine('\x1b[31mred\x1b[0m\ttext')).toBe('red text');
    expect(oneLine('abcdef', 4)).toBe('abc…');
  });
  it('lastNonEmptyLines', () => {
    expect(lastNonEmptyLines('1\n2\n \n3\n', 2)).toEqual(['2', '3']);
    expect(lastNonEmptyLines('result: ok\n╭────╮\n│ >  │\n╰────╯\n', 3)).toEqual(['result: ok']);
  });
  it('agentLabel', () => {
    expect(agentLabel('t1')).toBe('t1');
    expect(agentLabel('t1', 'rev')).toBe('t1 rev');
  });
  it('wrapAgentMessage', () => {
    expect(wrapAgentMessage('hi')).toBe('hi');
    expect(wrapAgentMessage('hi', 'p1')).toBe('<bbarit from="p1">hi</bbarit>');
  });
});

describe('decideAgentNote', () => {
  it('ignores working and idle', () => {
    expect(decideAgentNote(baseLink(), { state: 'working', turn: 0 }).note).toBeNull();
    expect(decideAgentNote(baseLink(), { state: 'idle', turn: 1 }).note).toBeNull();
  });

  it('notifies blocked and done once per turn', () => {
    let link = baseLink();
    const first = decideAgentNote(link, { state: 'blocked', kind: 'permission', turn: 1 });
    expect(first.note).toBe('blocked');
    link = first.link;
    expect(decideAgentNote(link, { state: 'blocked', kind: 'permission', turn: 1 }).note).toBeNull();
    const done = decideAgentNote(link, { state: 'done', turn: 1 });
    expect(done.note).toBe('done');
    expect(decideAgentNote(done.link, { state: 'done', turn: 1 }).note).toBeNull();
    expect(decideAgentNote(done.link, { state: 'done', turn: 2 }).note).toBe('done');
  });

  it('skips done before the brief was injected and cleared reports', () => {
    expect(decideAgentNote(baseLink({ pending: true }), { state: 'done', turn: 0 }).note).toBeNull();
    expect(decideAgentNote(baseLink({ pending: true }), { state: 'blocked', turn: 0 }).note).toBe('blocked');
    expect(decideAgentNote(baseLink(), { state: 'done', turn: 3, cleared: true }).note).toBeNull();
  });

  it('skips the done note for a turn the child already reported with agent send', () => {
    const link = baseLink({ lastSendTurn: 2 });
    const r = decideAgentNote(link, { state: 'done', turn: 2 });
    expect(r.note).toBeNull();
    expect(decideAgentNote(r.link, { state: 'done', turn: 2 }).note).toBeNull();
    expect(decideAgentNote(r.link, { state: 'done', turn: 3 }).note).toBe('done');
    expect(decideAgentNote(link, { state: 'blocked', turn: 2 }).note).toBe('blocked');
  });

  it('exit notes once', () => {
    const first = decideExitNote(baseLink());
    expect(first.note).toBe('exited');
    expect(decideExitNote(first.link).note).toBeNull();
  });
});

describe('pending notes per parent', () => {
  it('flushes in order once the parent leaves blocked', async () => {
    const q: PendingNotes = new Map();
    enqueueNote(q, 'p1', 'a');
    enqueueNote(q, 'p1', 'b');
    enqueueNote(q, 'p2', 'z');
    expect(canDeliverToParent('blocked')).toBe(false);
    expect(canDeliverToParent(undefined)).toBe(false);
    expect(canDeliverToParent('working')).toBe(true);
    const sent: string[] = [];
    const res = await flushNotes(q, 'p1', async (n) => { sent.push(n); return { ok: true }; });
    expect(res).toEqual({ sent: 2 });
    expect(sent).toEqual(['a', 'b']);
    expect(q.has('p1')).toBe(false);
    expect(q.get('p2')).toEqual(['z']);
  });

  it('requeues the rest at the front when the gate refuses', async () => {
    const q: PendingNotes = new Map();
    enqueueNote(q, 'p1', 'a');
    enqueueNote(q, 'p1', 'b');
    enqueueNote(q, 'p1', 'c');
    let calls = 0;
    const res = await flushNotes(q, 'p1', async () => (++calls === 2 ? { ok: false, reason: 'blocked' } : { ok: true }));
    expect(res).toEqual({ sent: 1, stoppedBy: 'blocked' });
    enqueueNote(q, 'p1', 'd');
    expect(takeNotes(q, 'p1')).toEqual(['b', 'c', 'd']);
  });

  it('drops notes when the parent is gone', async () => {
    const q: PendingNotes = new Map();
    enqueueNote(q, 'p1', 'a');
    enqueueNote(q, 'p1', 'b');
    const res = await flushNotes(q, 'p1', async () => ({ ok: false, reason: 'disposed' }));
    expect(res.stoppedBy).toBe('disposed');
    expect(q.has('p1')).toBe(false);
    enqueueNote(q, 'p2', 'x');
    dropParent(q, 'p2');
    expect(q.size).toBe(0);
    requeueFront(q, 'p3', []);
    expect(q.has('p3')).toBe(false);
  });
});

describe('isAgentSettled', () => {
  const now = 100000;
  it('exited and unlinked terminals', () => {
    expect(isAgentSettled({ state: 'working', turn: 0, reported: true, exited: true, now })).toBe(true);
    expect(isAgentSettled({ state: 'done', turn: 0, reported: true, now })).toBe(true);
    expect(isAgentSettled({ state: 'idle', turn: 4, reported: true, now })).toBe(false);
  });

  it('waits for the brief, then for the turn to advance', () => {
    const link = { pending: true };
    expect(isAgentSettled({ state: 'idle', turn: 0, reported: true, link, now })).toBe(false);
    expect(isAgentSettled({ state: 'blocked', turn: 0, reported: true, link, now })).toBe(true);
    const sent = { sentAt: now - 1000, sentTurn: 0 };
    expect(isAgentSettled({ state: 'idle', turn: 0, reported: true, link: sent, now })).toBe(false);
    expect(isAgentSettled({ state: 'done', turn: 0, reported: true, link: sent, now })).toBe(false);
    expect(isAgentSettled({ state: 'working', turn: 0, reported: true, link: sent, now })).toBe(false);
    expect(isAgentSettled({ state: 'done', turn: 1, reported: true, link: sent, now })).toBe(true);
    expect(isAgentSettled({ state: 'idle', turn: 1, reported: true, link: sent, now })).toBe(true);
    expect(isAgentSettled({ state: 'blocked', turn: 0, reported: true, link: sent, now })).toBe(true);
  });

  it('an answer sent to a blocked child is not settled until the turn moves', () => {
    const link = { sentAt: now, sentTurn: 3, sentWhileBlocked: true };
    expect(isAgentSettled({ state: 'blocked', turn: 3, reported: true, link, now })).toBe(false);
    expect(isAgentSettled({ state: 'blocked', turn: 4, reported: true, link, now })).toBe(true);
  });

  it('children without 7501 settle after 30 s of quiet, shells only at a prompt', () => {
    expect(UNREPORTED_SETTLE_MS).toBe(30000);
    const link = { sentAt: now - UNREPORTED_SETTLE_MS + 1, sentTurn: 0 };
    const base = { state: 'idle' as const, turn: 0, reported: false, link, cliType: 'codex' };
    expect(agentSettledBy({ ...base, now, quiet: true })).toBeNull();
    expect(agentSettledBy({ ...base, now: now + 1, quiet: false })).toBeNull();
    expect(agentSettledBy({ ...base, now: now + 1, quiet: true })).toBe('quiet');
    expect(agentSettledBy({ ...base, state: 'working', now: now + 60000, quiet: true })).toBeNull();
    const shell = { ...base, cliType: 'shell', now: now + 1, quiet: true };
    expect(agentSettledBy({ ...shell, shellPromptBack: false })).toBeNull();
    expect(agentSettledBy({ ...shell, shellPromptBack: true })).toBe('quiet');
    expect(agentSettledBy({ ...base, reported: true, turn: 1, now })).toBe('turn');
  });
});

describe('parentAcceptsNotes', () => {
  const now = 10_000_000;
  it('needs an agent tab with a recent working/blocked/done report', () => {
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'working', lastReportAt: now - 1000, now })).toBe(true);
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'done', lastReportAt: now - PARENT_REPORT_MAX_AGE_MS, now })).toBe(true);
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'blocked', lastReportAt: now, now })).toBe(true);
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'done', lastReportAt: now - PARENT_REPORT_MAX_AGE_MS - 1, now })).toBe(false);
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'idle', lastReportAt: now, now })).toBe(false);
    expect(parentAcceptsNotes({ cliType: 'claude', state: undefined, lastReportAt: now, now })).toBe(false);
    expect(parentAcceptsNotes({ cliType: 'claude', state: 'working', now })).toBe(false);
    expect(parentAcceptsNotes({ cliType: 'shell', state: 'working', lastReportAt: now, now })).toBe(false);
    expect(parentAcceptsNotes({ state: 'working', lastReportAt: now, now })).toBe(false);
  });
});

describe('runAgentBrief', () => {
  function harness(over: Partial<AgentBriefDeps> & { existsAfterMs?: number; ptyAfterMs?: number; idleAfterMs?: number; uiAfterMs?: number } = {}) {
    let t = 0;
    const injected: string[] = [];
    const deps: AgentBriefDeps = {
      exists: () => t >= (over.existsAfterMs ?? 0),
      ptyStarted: () => t >= (over.ptyAfterMs ?? 0),
      getState: (): AgentTabState | undefined => (over.idleAfterMs !== undefined && t >= over.idleAfterMs ? 'idle' : undefined),
      getTurn: () => 4,
      uiReady: () => over.uiAfterMs !== undefined && t >= over.uiAfterMs,
      inject: async (text) => { injected.push(text); return { ok: true }; },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      ...over,
    };
    return { deps, injected, time: () => t };
  }

  it('tolerates a terminal that is not committed yet (no synchronous first check)', async () => {
    const h = harness({ existsAfterMs: 900, idleAfterMs: 1200 });
    const out = await runAgentBrief(h.deps, { cliType: 'claude', text: 'brief' });
    expect(out).toMatchObject({ kind: 'sent', ok: true, readyBy: '7501', sentTurn: 4 });
    expect(h.injected).toEqual(['brief']);
  });

  it('gives up as gone only after the grace period', async () => {
    const h = harness({ existsAfterMs: Number.POSITIVE_INFINITY });
    const out = await runAgentBrief(h.deps, { cliType: 'claude', text: 'brief' });
    expect(out).toEqual({ kind: 'gone' });
    expect(h.time()).toBeGreaterThanOrEqual(AGENT_GONE_GRACE_MS);
    expect(h.injected).toEqual([]);
  });

  it('uses the screen heuristic with a longer settle delay', async () => {
    const h = harness({ uiAfterMs: 600 });
    const out = await runAgentBrief(h.deps, { cliType: 'codex', text: 'go' });
    expect(out).toMatchObject({ kind: 'sent', readyBy: 'ui' });
    expect(h.time()).toBe(600 + 1500);
  });

  it('does not type a multi-line brief into a shell when the agent never got ready', async () => {
    const h = harness({});
    const out = await runAgentBrief(h.deps, { cliType: 'claude', text: 'brief', readyTimeoutMs: 3000 });
    expect(out).toEqual({ kind: 'not-ready' });
    expect(h.injected).toEqual([]);
  });

  it('shell children are typed into after the timeout', async () => {
    const h = harness({});
    const out = await runAgentBrief(h.deps, { cliType: 'shell', text: 'npm test', readyTimeoutMs: 3000 });
    expect(out).toMatchObject({ kind: 'sent', readyBy: 'timeout' });
    expect(h.injected).toEqual(['npm test']);
  });

  it('starts the readiness clock when the PTY starts (tab in another project)', async () => {
    const h = harness({ ptyAfterMs: 120000, idleAfterMs: 125000 });
    const out = await runAgentBrief(h.deps, { cliType: 'claude', text: 'b', readyTimeoutMs: 60000 });
    expect(out).toMatchObject({ kind: 'sent', readyBy: '7501' });
  });

  it('reports a gate refusal', async () => {
    const h = harness({ idleAfterMs: 0, inject: async () => ({ ok: false, reason: 'typing' }) });
    expect(await runAgentBrief(h.deps, { cliType: 'claude', text: 'b' })).toMatchObject({ kind: 'sent', ok: false, reason: 'typing' });
  });
});
