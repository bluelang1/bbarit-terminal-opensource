import { describe, expect, it } from 'vitest';
import { feedTerminalInput, lastCommandOf, dropLastCommand } from './lastCommand';

describe('terminal last command tracking', () => {
  it('commits the typed line when Enter is sent', () => {
    feedTerminalInput('t-enter', 'git status\r');
    expect(lastCommandOf('t-enter')).toBe('git status');
    dropLastCommand('t-enter');
  });

  it('accumulates input across separate chunks', () => {
    feedTerminalInput('t-chunk', 'npm');
    feedTerminalInput('t-chunk', ' run dev');
    feedTerminalInput('t-chunk', '\r');
    expect(lastCommandOf('t-chunk')).toBe('npm run dev');
    dropLastCommand('t-chunk');
  });

  it('applies backspace edits to the pending line', () => {
    feedTerminalInput('t-bs', 'lsa\x7f\r');
    expect(lastCommandOf('t-bs')).toBe('ls');
    dropLastCommand('t-bs');
  });

  it('discards the pending line on Ctrl+C', () => {
    feedTerminalInput('t-sigint', 'rm -rf /tmp/x\x03');
    feedTerminalInput('t-sigint', 'echo ok\r');
    expect(lastCommandOf('t-sigint')).toBe('echo ok');
    dropLastCommand('t-sigint');
  });

  it('ignores escape sequences like arrows and bracketed paste markers', () => {
    feedTerminalInput('t-esc', '\x1b[A\x1b[200~npm test\x1b[201~\r');
    expect(lastCommandOf('t-esc')).toBe('npm test');
    dropLastCommand('t-esc');
  });

  it('keeps the last command when only empty Enters follow', () => {
    feedTerminalInput('t-empty', 'ls\r');
    feedTerminalInput('t-empty', '\r\r  \r');
    expect(lastCommandOf('t-empty')).toBe('ls');
    dropLastCommand('t-empty');
  });

  it('returns an empty string for unknown terminals', () => {
    expect(lastCommandOf('t-none')).toBe('');
  });
});
