import { describe, expect, it } from 'vitest';
import {
  claudeProjectSessionDir,
  encodeClaudeProjectDir,
  hasClaudeSessionFiles,
  isLocalWorkDir,
  shouldContinueClaudeSession,
} from './claudeSessionDir';

describe('claude session directory', () => {
  it('encodes cwd the way Claude Code names project folders', () => {
    expect(encodeClaudeProjectDir('/Users/me/RustroverProjects/bbarit-terminal-opensource'))
      .toBe('-Users-me-RustroverProjects-bbarit-terminal-opensource');
    expect(encodeClaudeProjectDir('/Users/me/IdeaProjects/colo_global.ui')).toBe('-Users-me-IdeaProjects-colo-global-ui');
    expect(encodeClaudeProjectDir('C:\\Users\\me\\repo')).toBe('C--Users-me-repo');
    expect(encodeClaudeProjectDir('/Users/me/repo/')).toBe('-Users-me-repo');
    expect(encodeClaudeProjectDir('C:\\Users\\me\\repo\\')).toBe('C--Users-me-repo');
  });

  it('builds the projects path under the home directory', () => {
    expect(claudeProjectSessionDir('/Users/me', '/Users/me/repo')).toBe('/Users/me/.claude/projects/-Users-me-repo');
    expect(claudeProjectSessionDir('/Users/me/', '/Users/me/repo')).toBe('/Users/me/.claude/projects/-Users-me-repo');
    expect(claudeProjectSessionDir('C:\\Users\\me', 'C:\\Users\\me\\repo')).toBe('C:\\Users\\me\\.claude\\projects\\C--Users-me-repo');
  });

  it('treats only non-empty, non-ssh work dirs as local', () => {
    expect(isLocalWorkDir('/repo')).toBe(true);
    expect(isLocalWorkDir('ssh://host/repo')).toBe(false);
    expect(isLocalWorkDir('')).toBe(false);
    expect(isLocalWorkDir(undefined)).toBe(false);
  });

  it('needs a transcript file, not just the folder', () => {
    expect(hasClaudeSessionFiles([])).toBe(false);
    expect(hasClaudeSessionFiles([{ name: 'memory', is_dir: true }])).toBe(false);
    expect(hasClaudeSessionFiles([{ name: 'abc.jsonl', is_dir: true }])).toBe(false);
    expect(hasClaudeSessionFiles([{ name: 'memory', is_dir: true }, { name: 'abc.jsonl', is_dir: false }])).toBe(true);
    expect(hasClaudeSessionFiles([{ name: 'abc.JSONL', isDir: false }])).toBe(true);
  });

  it('drops --continue on a first run and keeps it once a session exists', async () => {
    const probe = (entries: { name: string; is_dir: boolean }[] | Error) => ({
      getHomeDir: async () => '/Users/me',
      readDirectory: async (path: string) => {
        expect(path).toBe('/Users/me/.claude/projects/-Users-me-repo');
        if (entries instanceof Error) throw entries;
        return entries;
      },
    });
    expect(await shouldContinueClaudeSession('/Users/me/repo', probe([]))).toBe(false);
    expect(await shouldContinueClaudeSession('/Users/me/repo', probe(new Error('No such file')))).toBe(false);
    expect(await shouldContinueClaudeSession('/Users/me/repo', probe([{ name: 's.jsonl', is_dir: false }]))).toBe(true);
  });

  it('keeps the previous behavior for remote or unknown work dirs', async () => {
    const never = { getHomeDir: async () => { throw new Error('unused'); }, readDirectory: async () => { throw new Error('unused'); } };
    expect(await shouldContinueClaudeSession('ssh://host/repo', never)).toBe(true);
    expect(await shouldContinueClaudeSession(undefined, never)).toBe(true);
    const homeFails = { getHomeDir: async () => { throw new Error('no home'); }, readDirectory: async () => [] };
    expect(await shouldContinueClaudeSession('/repo', homeFails)).toBe(false);
  });
});
