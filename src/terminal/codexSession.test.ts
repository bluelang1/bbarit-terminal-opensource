import { describe, expect, it } from 'vitest';
import { codexLaunchCommand, dedicatedCodexSessionFields, restoredCodexFreshSession } from './codexSession';

describe('codexLaunchCommand', () => {
  it('plain tabs resume the shared last session only when resume is on', () => {
    expect(codexLaunchCommand({ resumeLastSession: true, flags: ' --search' })).toBe('codex resume --last --search');
    expect(codexLaunchCommand({ resumeLastSession: false, flags: ' --search' })).toBe('codex --search');
    expect(codexLaunchCommand({ resumeLastSession: true, freshSession: false, flags: '' })).toBe('codex resume --last');
  });

  it('"new session" tabs always start a fresh session', () => {
    expect(codexLaunchCommand({ resumeLastSession: true, freshSession: true, flags: ' --model gpt-5' })).toBe('codex --model gpt-5');
    expect(codexLaunchCommand({ resumeLastSession: false, freshSession: true, flags: '' })).toBe('codex');
  });
});

describe('Codex new-session fields', () => {
  it('marks only fresh tabs', () => {
    expect(dedicatedCodexSessionFields(true)).toEqual({ codexFreshSession: true });
    expect(dedicatedCodexSessionFields(false)).toEqual({});
  });

  it('restores the flag for Codex tabs and ignores older or odd saves', () => {
    expect(restoredCodexFreshSession({ cliType: 'codex', codexFreshSession: true })).toBe(true);
    expect(restoredCodexFreshSession({ cliType: 'codex' })).toBeUndefined();
    expect(restoredCodexFreshSession({ cliType: 'codex', codexFreshSession: 'true' })).toBeUndefined();
    expect(restoredCodexFreshSession({ cliType: 'claude', codexFreshSession: true })).toBeUndefined();
    expect(restoredCodexFreshSession(undefined)).toBeUndefined();
    expect(restoredCodexFreshSession(null)).toBeUndefined();
  });
});
