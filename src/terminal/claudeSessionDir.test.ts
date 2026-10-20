import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeProjectSessionDir,
  claudeSessionArgsToFlags,
  hasClaudeSessionFile,
  isClaudeSessionId,
  newClaudeSessionId,
  resolveClaudeSessionArgs,
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

describe('dedicated claude sessions', () => {
  const ID = '0f4b2c1e-7d3a-4c5b-9e8f-1a2b3c4d5e6f';
  const probeWith = (entries: { name: string; is_dir: boolean }[] | Error) => ({
    getHomeDir: async () => '/Users/me',
    readDirectory: async () => { if (entries instanceof Error) throw entries; return entries; },
  });

  it('generates and validates uuid session ids', () => {
    const id = newClaudeSessionId();
    expect(isClaudeSessionId(id)).toBe(true);
    expect(isClaudeSessionId('not-a-uuid')).toBe(false);
    expect(isClaudeSessionId(undefined)).toBe(false);
    expect(newClaudeSessionId()).not.toBe(id);
  });

  it('finds the transcript of a specific session only', () => {
    expect(hasClaudeSessionFile([{ name: `${ID}.jsonl`, is_dir: false }], ID)).toBe(true);
    expect(hasClaudeSessionFile([{ name: 'other.jsonl', is_dir: false }], ID)).toBe(false);
    expect(hasClaudeSessionFile([{ name: ID, is_dir: true }], ID)).toBe(false);
  });

  it('creates the session on first launch and resumes it afterwards', async () => {
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', sessionId: ID, resumeLastSession: true }, probeWith([])))
      .toEqual({ kind: 'new', sessionId: ID });
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', sessionId: ID, resumeLastSession: false }, probeWith(new Error('missing'))))
      .toEqual({ kind: 'new', sessionId: ID });
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', sessionId: ID, resumeLastSession: false }, probeWith([{ name: `${ID}.jsonl`, is_dir: false }])))
      .toEqual({ kind: 'resume', sessionId: ID });
    expect(await resolveClaudeSessionArgs({ workDir: 'ssh://host/repo', sessionId: ID, resumeLastSession: true }, probeWith([])))
      .toEqual({ kind: 'new', sessionId: ID });
  });

  it('keeps the shared --continue behavior for tabs without an id', async () => {
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', resumeLastSession: true }, probeWith([{ name: 'x.jsonl', is_dir: false }])))
      .toEqual({ kind: 'continue' });
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', resumeLastSession: true }, probeWith([])))
      .toEqual({ kind: 'none' });
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', resumeLastSession: false }, probeWith([{ name: 'x.jsonl', is_dir: false }])))
      .toEqual({ kind: 'none' });
    expect(await resolveClaudeSessionArgs({ workDir: '/Users/me/repo', sessionId: 'bogus', resumeLastSession: false }, probeWith([])))
      .toEqual({ kind: 'none' });
  });

  it('renders the flags Claude Code expects', () => {
    expect(claudeSessionArgsToFlags({ kind: 'resume', sessionId: ID })).toBe(` --resume ${ID}`);
    expect(claudeSessionArgsToFlags({ kind: 'new', sessionId: ID })).toBe(` --session-id ${ID}`);
    expect(claudeSessionArgsToFlags({ kind: 'continue' })).toBe(' --continue');
    expect(claudeSessionArgsToFlags({ kind: 'none' })).toBe('');
  });
});

describe('claudeSessionId persistence in App.tsx', () => {
  // saveProjects/loadProjects use explicit field allowlists; a dropped field
  // silently turns a dedicated-session tab back into a shared --continue tab.
  const appSource = readFileSync(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8');

  it('is written by saveProjects and validated by loadProjects', () => {
    expect(appSource).toContain('claudeSessionId: t.claudeSessionId || undefined,');
    expect(appSource).toContain("claudeSessionId: isClaudeSessionId(t?.claudeSessionId) ? t.claudeSessionId : undefined,");
  });

  it('is passed to every XTerminal that receives resumeLastSession', () => {
    const resumeSites = appSource.match(/resumeLastSession=\{agentSettings\.resumeLastSession \?\? false\}/g) || [];
    const sessionSites = appSource.match(/claudeSessionId=\{terminal\.claudeSessionId\}/g) || [];
    expect(resumeSites.length).toBeGreaterThan(0);
    expect(sessionSites.length).toBe(resumeSites.length);
  });
});
