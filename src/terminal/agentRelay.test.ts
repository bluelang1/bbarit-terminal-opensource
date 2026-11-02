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
} from './agentRelay';

const baseLink = (over: Partial<AgentLink> = {}): AgentLink => ({
  childId: 'c1', parentId: 'p1', name: 'reviewer', createdAt: 0, lastNotifiedTurn: -1, ...over,
});

describe('formatAgentBrief', () => {
  it('prefixes the protocol block with the parent label and reach command', () => {
    const brief = formatAgentBrief({ parentId: 'p1', parentName: 'Claude 1', prompt: 'review my diff', cliType: 'claude' });
    expect(brief.split('\n')).toEqual([
      '<bbarit from="p1 Claude 1" reach="node \\"$BBARIT_CTL\\" agent send p1 \\"<message>\\"">',
      'You were started by another agent (terminal p1 Claude 1). When you finish or get stuck, report back',
      'with the reach command above (one short message with the result or the question).',
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
});

describe('helpers', () => {
  it('oneLine strips escapes and truncates', () => {
    expect(oneLine('\x1b[31mred\x1b[0m\ttext')).toBe('red text');
    expect(oneLine('abcdef', 4)).toBe('abc…');
  });
  it('lastNonEmptyLines', () => {
    expect(lastNonEmptyLines('1\n2\n \n3\n', 2)).toEqual(['2', '3']);
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

  it('children without 7501 settle after a quiet period', () => {
    const link = { sentAt: now - UNREPORTED_SETTLE_MS + 1, sentTurn: 0 };
    expect(isAgentSettled({ state: 'idle', turn: 0, reported: false, link, now })).toBe(false);
    expect(isAgentSettled({ state: 'idle', turn: 0, reported: false, link, now: now + 1 })).toBe(true);
    expect(isAgentSettled({ state: 'working', turn: 0, reported: false, link, now: now + 10000 })).toBe(false);
  });
});
