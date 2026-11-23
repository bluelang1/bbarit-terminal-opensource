import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGENT_WORKTREE_EXCLUDE,
  agentWorktreeBaseDir,
  agentWorktreePlan,
  parseWorktreeProbe,
  parseWorktreeRequest,
  prepareAgentWorktree,
  slugifyAgentName,
  uniqueAgentSlug,
  type AgentWorktreeDeps,
} from './agentWorktree';

describe('worktree naming', () => {
  it('reads the agent.run worktree param', () => {
    expect(parseWorktreeRequest(true)).toEqual({});
    expect(parseWorktreeRequest('')).toEqual({});
    expect(parseWorktreeRequest('  fix-login ')).toEqual({ name: 'fix-login' });
    expect(parseWorktreeRequest(false)).toBeNull();
    expect(parseWorktreeRequest(undefined)).toBeNull();
    expect(parseWorktreeRequest(1)).toBeNull();
  });

  it('slugifies names into branch-safe slugs', () => {
    expect(slugifyAgentName('claude (agent)')).toBe('claude-agent');
    expect(slugifyAgentName('Fix/Login Bug!')).toBe('fix-login-bug');
    expect(slugifyAgentName('..lock -- x.lock')).toBe('lock-x-lock');
    expect(slugifyAgentName('Café ü')).toBe('cafe-u');
    expect(slugifyAgentName('리뷰어')).toBe('agent');
    expect(slugifyAgentName('리뷰어', 'codex')).toBe('codex');
    expect(slugifyAgentName('', '리뷰')).toBe('agent');
    const long = slugifyAgentName('a'.repeat(39) + '-bbbbbb');
    expect(long).toBe('a'.repeat(39));
    expect(long.length).toBeLessThanOrEqual(40);
  });

  it('makes the slug unique against agent/* branches and folders', () => {
    expect(uniqueAgentSlug('rev', [], [])).toBe('rev');
    expect(uniqueAgentSlug('rev', ['agent/rev', 'main', 'rev-2'], [])).toBe('rev-2');
    expect(uniqueAgentSlug('rev', ['agent/rev'], ['rev-2', 'REV-3'])).toBe('rev-4');
    expect(uniqueAgentSlug('rev', ['agent/Rev'], [])).toBe('rev-2');
    const long = 'x'.repeat(40);
    const next = uniqueAgentSlug(long, [`agent/${long}`], []);
    expect(next).toBe(`${'x'.repeat(38)}-2`);
  });

  it('bases the worktree on --workdir, then the caller cwd, then the project folders', () => {
    const all = { requested: '/w', callerCwd: '/r/.claude/worktrees/feat', callerProjectDir: '/r', activeProjectDir: '/a' };
    expect(agentWorktreeBaseDir(all)).toBe('/w');
    expect(agentWorktreeBaseDir({ ...all, requested: ' ' })).toBe('/r/.claude/worktrees/feat');
    expect(agentWorktreeBaseDir({ ...all, requested: '', callerCwd: undefined })).toBe('/r');
    expect(agentWorktreeBaseDir({ activeProjectDir: '/a' })).toBe('/a');
    expect(agentWorktreeBaseDir({})).toBe('');
  });

  it('plans path and branch under <repo>/.bbarit/worktrees', () => {
    expect(agentWorktreePlan({ repoRoot: '/r/app/', name: 'claude (agent)', takenBranches: ['agent/claude-agent'], takenDirs: [] }))
      .toEqual({ slug: 'claude-agent-2', branch: 'agent/claude-agent-2', path: '/r/app/.bbarit/worktrees/claude-agent-2' });
    expect(agentWorktreePlan({ repoRoot: '/r', name: '검토', fallback: 'codex', takenBranches: [], takenDirs: [] }).branch).toBe('agent/codex');
  });

  it('parses the probe output', () => {
    expect(parseWorktreeProbe('__NOT_A_REPO__\n')).toEqual({ repo: false });
    expect(parseWorktreeProbe('')).toEqual({ repo: false });
    expect(parseWorktreeProbe('__TOP__\n/r/app\n__HEAD_OK__\n__BRANCHES__\nagent/a\n__DIRS__\na\nb\n__END__\n')).toEqual({
      repo: true, top: '/r/app', headOk: true, branches: ['agent/a'], dirs: ['a', 'b'],
    });
    expect(parseWorktreeProbe('__TOP__\r\n/r\r\n__BRANCHES__\r\n__DIRS__\r\n__END__\r\n')).toEqual({
      repo: true, top: '/r', headOk: false, branches: [], dirs: [],
    });
  });
});

// Real git in a temp folder: the probe and exclude scripts are what the app runs.
describe('prepareAgentWorktree (real git)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const deps: AgentWorktreeDeps = {
    run: async (script, cwd) => execFileSync('sh', ['-c', script], { cwd, encoding: 'utf8' }),
    addWorktree: async (repo, path, branch) => git(repo, 'worktree', 'add', '-b', branch, path, 'HEAD'),
  };
  const tempDir = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'agent-wt-')));
    dirs.push(d);
    return d;
  };
  const newRepo = (commit = true) => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    if (commit) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); }
    return repo;
  };

  it('creates <repo>/.bbarit/worktrees/<slug> on agent/<slug> and keeps it out of git status', async () => {
    const repo = newRepo();
    writeFileSync(join(repo, '.git/info/exclude'), '# existing\n*.log');
    const sub = join(repo, 'src');
    execFileSync('mkdir', ['-p', sub]);
    const first = await prepareAgentWorktree(deps, { baseDir: sub, name: 'Reviewer' });
    expect(first).toEqual({ ok: true, path: `${repo}/.bbarit/worktrees/reviewer`, branch: 'agent/reviewer' });
    expect(git(join(repo, '.bbarit/worktrees/reviewer'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/reviewer');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const second = await prepareAgentWorktree(deps, { baseDir: repo, name: 'reviewer' });
    expect(second).toMatchObject({ ok: true, branch: 'agent/reviewer-2' });
    // The line is added once, after the existing (newline-less) last line.
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toBe(`# existing\n*.log\n${AGENT_WORKTREE_EXCLUDE}\n`);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('started from a linked worktree, writes the shared info/exclude', async () => {
    const repo = newRepo();
    const linked = join(tempDir(), 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked, 'HEAD');
    const res = await prepareAgentWorktree(deps, { baseDir: linked, fallback: 'codex' });
    expect(res).toEqual({ ok: true, path: `${linked}/.bbarit/worktrees/codex`, branch: 'agent/codex' });
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain(`${AGENT_WORKTREE_EXCLUDE}\n`);
    expect(git(linked, 'status', '--porcelain')).toBe('');
  });

  it('refuses a folder that is not a git repo, or a repo without a commit', async () => {
    const plain = tempDir();
    const notRepo = await prepareAgentWorktree(deps, { baseDir: plain, name: 'x' });
    expect(notRepo).toEqual({ ok: false, error: `worktree: not a git repository: ${plain}` });
    expect(existsSync(join(plain, '.bbarit'))).toBe(false);
    const empty = newRepo(false);
    const noHead = await prepareAgentWorktree(deps, { baseDir: empty, name: 'x' });
    expect(noHead).toMatchObject({ ok: false });
    expect((noHead as { error: string }).error).toContain('no commit');
    expect(await prepareAgentWorktree(deps, { baseDir: '' })).toMatchObject({ ok: false });
  });

  it('reports a failed git worktree add', async () => {
    const repo = newRepo();
    const res = await prepareAgentWorktree({ ...deps, addWorktree: async () => { throw new Error('git worktree add error: boom'); } }, { baseDir: repo });
    expect(res).toEqual({ ok: false, error: 'worktree: git worktree add error: boom' });
  });
});
