import { describe, expect, it } from 'vitest';
import { buildAgentRelayLogEntry } from './agentRelayLog';

const at = new Date('2026-11-16T01:02:03.004Z');

describe('buildAgentRelayLogEntry', () => {
  it('builds a run entry with caller, target, depth, worktree and a short text head', () => {
    const prompt = `Review the diff\nand list bugs. ${'x'.repeat(300)}`;
    const e = buildAgentRelayLogEntry({
      event: 'run',
      caller: { id: 't1', name: 'Claude' },
      target: { id: 't5', name: 'reviewer', cliType: 'claude' },
      depth: 1,
      worktree: '/repo/.bbarit/worktrees/reviewer',
      branch: 'agent/reviewer',
      text: prompt,
    }, at);
    expect(e).toMatchObject({
      ts: '2026-11-16T01:02:03.004Z',
      event: 'run',
      caller: { id: 't1', name: 'Claude' },
      target: { id: 't5', name: 'reviewer', cliType: 'claude' },
      depth: 1,
      worktree: '/repo/.bbarit/worktrees/reviewer',
      branch: 'agent/reviewer',
      textLen: Array.from(prompt).length,
    });
    const head = String(e.textHead);
    expect(Array.from(head).length).toBe(120);
    expect(head.startsWith('Review the diff and list bugs. xxx')).toBe(true);
    expect(head).not.toContain('\n');
  });

  it('leaves out unknown parties and fields, and never stores the full text', () => {
    const e = buildAgentRelayLogEntry({ event: 'exit', target: { id: 't9' }, caller: { id: '' } }, at);
    expect(e).toEqual({ ts: '2026-11-16T01:02:03.004Z', event: 'exit', target: { id: 't9' } });
    const s = buildAgentRelayLogEntry({ event: 'send', text: 'short $(rm -rf ~)' }, at);
    expect(s.textLen).toBe(17);
    // oneLine neutralizes shell metacharacters.
    expect(String(s.textHead)).not.toContain('$');
    expect(JSON.stringify(s)).not.toContain('\n');
  });

  it('adds extra scalar fields without overwriting the core ones', () => {
    const e = buildAgentRelayLogEntry({
      event: 'stop',
      target: { id: 't2', cliType: 'codex' },
      extra: { by: 'button', ok: false, keys: '', closed: true, reason: 'no known\ninterrupt key', event: 'hijack', skip: undefined },
    }, at);
    expect(e).toMatchObject({ event: 'stop', by: 'button', ok: false, keys: '', closed: true, reason: 'no known interrupt key' });
    expect('skip' in e).toBe(false);
  });

  it('run_refused keeps the reason', () => {
    const e = buildAgentRelayLogEntry({
      event: 'run_refused',
      caller: { id: 't1' },
      target: { cliType: 'claude', id: '' },
      depth: 3,
      text: 'go',
      extra: { reason: 'maxDepth', error: 'depth limit reached: …' },
    }, at);
    expect(e).toMatchObject({ event: 'run_refused', reason: 'maxDepth', depth: 3, target: { cliType: 'claude' }, textLen: 2, textHead: 'go' });
  });
});
