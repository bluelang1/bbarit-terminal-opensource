import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_SUBMIT_BYTES,
  claudeSubmitKey,
  claudeSubmitSpec,
  opensAutocomplete,
  submitSpecFor,
  normalizeKeyName,
  pickClaudeSubmitKey,
  refreshClaudeSubmitKey,
  resetClaudeSubmitKey,
  submitKeyForTerminal,
} from './claudeSubmitKey';

beforeEach(() => resetClaudeSubmitKey());

describe('pickClaudeSubmitKey', () => {
  it('keeps Enter while it still submits (default, unset, or bound to chat:submit)', () => {
    expect(pickClaudeSubmitKey(null)).toEqual({ key: '\r', via: 'enter' });
    expect(pickClaudeSubmitKey({})).toEqual({ key: '\r', via: 'enter' });
    expect(pickClaudeSubmitKey({ enter: 'chat:submit', 'shift+enter': 'chat:submit' })).toEqual({ key: '\r', via: 'enter' });
  });

  it('uses Shift+Enter or Cmd+Enter (the app’s CSI-u bytes) when Enter is a newline', () => {
    expect(pickClaudeSubmitKey({ enter: 'chat:newline', 'shift+enter': 'chat:submit', 'cmd+enter': 'chat:submit' }))
      .toEqual({ key: '\x1b[13;2u', via: 'shift+enter' });
    expect(pickClaudeSubmitKey({ enter: 'chat:newline', 'cmd+enter': 'chat:submit' }))
      .toEqual({ key: '\x1b[13;9u', via: 'cmd+enter' });
    // Spelling variants Claude Code accepts.
    expect(pickClaudeSubmitKey({ Return: 'chat:newline', 'Meta+Return': 'chat:submit' }))
      .toEqual({ key: CLAUDE_SUBMIT_BYTES['cmd+enter'], via: 'cmd+enter' });
    expect(pickClaudeSubmitKey({ enter: null, 'enter+shift': 'chat:submit' }).via).toBe('shift+enter');
  });

  it('falls back to Enter with a reason when the submit key cannot be encoded', () => {
    const r = pickClaudeSubmitKey({ enter: 'chat:newline', 'ctrl+enter': 'chat:submit' });
    expect(r.key).toBe('\r');
    expect(r.via).toBe('enter');
    expect(r.reason).toMatch(/Claude submit key is not Enter and cannot be sent/);
    expect(pickClaudeSubmitKey({ enter: 'chat:newline' }).reason).toBeTruthy();
  });

  it('normalizes key names', () => {
    expect(normalizeKeyName('Shift+Enter')).toBe('shift+enter');
    expect(normalizeKeyName('enter+cmd')).toBe('cmd+enter');
    expect(normalizeKeyName('command+return')).toBe('cmd+enter');
    expect(normalizeKeyName('super+enter')).toBe('cmd+enter');
  });
});

describe('cached submit key', () => {
  it('starts as Enter, refreshes from the loader, and survives a failed load', async () => {
    expect(claudeSubmitKey()).toEqual({ key: '\r', via: 'enter' });
    await refreshClaudeSubmitKey(async () => ({ chat: { enter: 'chat:newline', 'cmd+enter': 'chat:submit' } }), { force: true });
    expect(claudeSubmitKey().key).toBe('\x1b[13;9u');
    await refreshClaudeSubmitKey(async () => { throw new Error('ipc'); }, { force: true });
    expect(claudeSubmitKey().key).toBe('\x1b[13;9u');
  });

  it('skips a reload inside the min interval unless forced', async () => {
    let calls = 0;
    const load = async () => { calls += 1; return {}; };
    await refreshClaudeSubmitKey(load, { now: 1000 });
    await refreshClaudeSubmitKey(load, { now: 1500 });
    expect(calls).toBe(1);
    await refreshClaudeSubmitKey(load, { now: 1500, force: true });
    expect(calls).toBe(2);
  });

  it('applies only to Claude tabs where Claude is running and not in a dialog', async () => {
    await refreshClaudeSubmitKey(async () => ({ chat: { enter: 'chat:newline', 'shift+enter': 'chat:submit' } }), { force: true });
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'working', agentRunning: true })).toEqual({ key: '\x1b[13;2u', presses: 1 });
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'idle', agentRunning: true }).key).toBe('\x1b[13;2u');
    // Claude exited (its 7501 clear left the rollup at idle) or has not started: zsh prompt — CR.
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'idle', agentRunning: false }).key).toBe('\r');
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'done' }).key).toBe('\r');
    expect(submitKeyForTerminal({ cliType: 'claude' }).key).toBe('\r');
    // The relay brief is typed after readiness, which may be the welcome screen only: it asks explicitly.
    expect(claudeSubmitSpec('review the diff')).toEqual({ key: '\x1b[13;2u', presses: 1 });
    // A permission/question dialog is not the Chat context: Enter confirms there.
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'blocked', agentRunning: true }).key).toBe('\r');
    expect(submitKeyForTerminal({ cliType: 'codex', state: 'idle', agentRunning: true }).key).toBe('\r');
    expect(submitKeyForTerminal({ cliType: 'shell' }).key).toBe('\r');
    expect(submitKeyForTerminal({}).key).toBe('\r');
  });
});

describe('autocomplete dismiss (double press)', () => {
  const chat = { enter: 'chat:newline', 'shift+enter': 'chat:submit', 'cmd+enter': 'chat:submit' };
  const autocomplete = { 'shift+enter': 'autocomplete:dismiss', 'cmd+enter': 'autocomplete:dismiss' };

  it('marks the pick when the submit key closes the autocomplete menu', () => {
    expect(pickClaudeSubmitKey(chat, autocomplete)).toEqual({ key: '\x1b[13;2u', via: 'shift+enter', dismissesAutocomplete: true });
    expect(pickClaudeSubmitKey(chat, { tab: 'autocomplete:accept' }).dismissesAutocomplete).toBeUndefined();
    expect(pickClaudeSubmitKey({}, { enter: 'autocomplete:dismiss' }).dismissesAutocomplete).toBe(true);
  });

  it('knows which text opens the menu', () => {
    expect(opensAutocomplete('/cost')).toBe(true);
    expect(opensAutocomplete('  /review this')).toBe(true);
    expect(opensAutocomplete('look at @src/App.tsx')).toBe(true);
    expect(opensAutocomplete('look at @src/App.tsx please')).toBe(false);
    expect(opensAutocomplete('mail a@b.c then x')).toBe(false);
    expect(opensAutocomplete('run tests')).toBe(false);
    expect(opensAutocomplete('')).toBe(false);
  });

  it('presses twice only for menu text with a dismissing key', async () => {
    const pick = pickClaudeSubmitKey(chat, autocomplete);
    expect(submitSpecFor(pick, '/cost')).toEqual({ key: '\x1b[13;2u', presses: 2 });
    expect(submitSpecFor(pick, 'run tests')).toEqual({ key: '\x1b[13;2u', presses: 1 });
    expect(submitSpecFor(pickClaudeSubmitKey(chat), '/cost')).toEqual({ key: '\x1b[13;2u', presses: 1 });
    await refreshClaudeSubmitKey(async () => ({ chat, autocomplete }), { force: true });
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'idle', agentRunning: true, text: '/cost' })).toEqual({ key: '\x1b[13;2u', presses: 2 });
    expect(submitKeyForTerminal({ cliType: 'claude', state: 'idle', agentRunning: false, text: '/cost' })).toEqual({ key: '\r', presses: 1 });
  });
});
