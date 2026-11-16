// agent run --worktree: a relay child gets its own git worktree and branch.
// Layout: <repo>/.bbarit/worktrees/<slug> on branch agent/<slug>, cut from the repo's HEAD.
// The folder is kept out of `git status` with a line in the repo's info/exclude (the shared
// git dir, also from a linked worktree); the user's .gitignore is never edited. Nothing is
// removed automatically. Design: docs/superpowers/specs/2026-11-16-agent-worktree-and-stop-design.md
//
// The Orchestra/broker worktrees (<repo>/.octo-tmp/broker-wt-*) are detached, branchless and
// swept by git_cleanup_broker_worktrees, so they are not reused here; only the
// `git_worktree_add` command is.

export const AGENT_WORKTREE_DIR = '.bbarit/worktrees';
export const AGENT_BRANCH_PREFIX = 'agent/';
/** info/exclude line (anchored to the work tree root, so it matches in every worktree). */
export const AGENT_WORKTREE_EXCLUDE = `/${AGENT_WORKTREE_DIR}/`;
const SLUG_MAX = 40;

export interface AgentWorktree {
  /** Absolute path of the child's worktree. */
  path: string;
  /** Branch checked out there (agent/<slug>). */
  branch: string;
}

/**
 * `agent.run` param `worktree`: true (or "") → derive the name from the child, a string →
 * that name, anything else → no worktree.
 */
export function parseWorktreeRequest(value: unknown): { name?: string } | null {
  if (value === true) return {};
  if (typeof value === 'string') {
    const name = value.trim();
    return name ? { name } : {};
  }
  return null;
}

/** Lowercase ASCII letters, digits and single dashes, at most 40 chars; `fallback` if empty. */
export function slugifyAgentName(raw: string, fallback = 'agent'): string {
  const slug = String(raw || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return slug || (fallback === 'agent' ? 'agent' : slugifyAgentName(fallback));
}

/**
 * `base`, or `base-2`, `base-3`, … — the first one whose branch (agent/<slug>) and folder
 * are both free. Compared case-insensitively (macOS and Windows folders are).
 */
export function uniqueAgentSlug(base: string, takenBranches: Iterable<string>, takenDirs: Iterable<string>): string {
  const taken = new Set<string>();
  for (const b of takenBranches) {
    const name = String(b || '').trim();
    if (name.startsWith(AGENT_BRANCH_PREFIX)) taken.add(name.slice(AGENT_BRANCH_PREFIX.length).toLowerCase());
  }
  for (const d of takenDirs) taken.add(String(d || '').trim().replace(/\/+$/, '').toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function agentWorktreePlan(opts: {
  repoRoot: string;
  /** Explicit --worktree name, else the child's tab name. */
  name?: string;
  fallback?: string;
  takenBranches: Iterable<string>;
  takenDirs: Iterable<string>;
}): AgentWorktree & { slug: string } {
  const root = opts.repoRoot.replace(/[\\/]+$/, '');
  const slug = uniqueAgentSlug(slugifyAgentName(opts.name || '', opts.fallback || 'agent'), opts.takenBranches, opts.takenDirs);
  return { slug, branch: `${AGENT_BRANCH_PREFIX}${slug}`, path: `${root}/${AGENT_WORKTREE_DIR}/${slug}` };
}

/**
 * Folder whose git top level is the worktree base: --workdir, else the caller's cwd (same
 * order as a plain agent run, so a caller inside a linked worktree branches from its own
 * HEAD), else the caller's project folder, else the active project folder.
 */
export function agentWorktreeBaseDir(o: { requested?: string; callerCwd?: string; callerProjectDir?: string; activeProjectDir?: string }): string {
  return [o.requested, o.callerCwd, o.callerProjectDir, o.activeProjectDir].map((d) => (d || '').trim()).find(Boolean) || '';
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Run in the child's base folder: repo top level, whether HEAD exists, taken branches and folders. */
export const AGENT_WORKTREE_PROBE = [
  'top=$(git rev-parse --show-toplevel 2>/dev/null)',
  'if [ -z "$top" ]; then echo __NOT_A_REPO__; exit 0; fi',
  'echo __TOP__',
  'printf \'%s\\n\' "$top"',
  'if git rev-parse --verify -q HEAD >/dev/null 2>&1; then echo __HEAD_OK__; fi',
  'echo __BRANCHES__',
  `git -C "$top" for-each-ref --format='%(refname:short)' refs/heads/${AGENT_BRANCH_PREFIX} 2>/dev/null`,
  'echo __DIRS__',
  `ls -1A "$top/${AGENT_WORKTREE_DIR}" 2>/dev/null`,
  'echo __END__',
].join('\n');

export type WorktreeProbe =
  | { repo: false }
  | { repo: true; top: string; headOk: boolean; branches: string[]; dirs: string[] };

export function parseWorktreeProbe(output: string): WorktreeProbe {
  const lines = String(output || '').replace(/\r/g, '').split('\n');
  if (lines.some((l) => l.trim() === '__NOT_A_REPO__')) return { repo: false };
  const at = (marker: string) => lines.findIndex((l) => l.trim() === marker);
  const iTop = at('__TOP__');
  if (iTop < 0) return { repo: false };
  const top = (lines[iTop + 1] || '').trim();
  if (!top) return { repo: false };
  const section = (start: string, end: string) => {
    const s = at(start);
    const e = at(end);
    if (s < 0) return [];
    return lines.slice(s + 1, e > s ? e : undefined).map((l) => l.trim()).filter(Boolean);
  };
  return {
    repo: true,
    top,
    headOk: at('__HEAD_OK__') >= 0,
    branches: section('__BRANCHES__', '__DIRS__'),
    dirs: section('__DIRS__', '__END__'),
  };
}

/**
 * Run in the repo top level: add the exclude line to the repo's info/exclude unless it is
 * there (`--git-path` resolves the shared git dir from a linked worktree too). Prints the file.
 */
export const AGENT_WORKTREE_EXCLUDE_SCRIPT = [
  'f=$(git rev-parse --git-path info/exclude) || exit 1',
  `line=${shellQuote(AGENT_WORKTREE_EXCLUDE)}`,
  'if ! grep -qxF -- "$line" "$f" 2>/dev/null; then',
  '  mkdir -p "$(dirname "$f")" || exit 1',
  '  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf \'\\n\' >> "$f"; fi',
  '  printf \'%s\\n\' "$line" >> "$f" || exit 1',
  'fi',
  'printf \'%s\\n\' "$f"',
].join('\n');

export interface AgentWorktreeDeps {
  /** Run a POSIX shell script in `cwd` and return stdout (throws on failure). */
  run: (script: string, cwd: string) => Promise<string>;
  /** `git worktree add -b <branch> <path> HEAD` in `repo` (the existing git_worktree_add command). */
  addWorktree: (repo: string, path: string, branch: string) => Promise<unknown>;
}

export type AgentWorktreeResult = ({ ok: true } & AgentWorktree) | { ok: false; error: string };

/** Create the child's worktree. Not a git repo / no commit yet → an error and nothing is created. */
export async function prepareAgentWorktree(
  deps: AgentWorktreeDeps,
  opts: { baseDir: string; name?: string; fallback?: string },
): Promise<AgentWorktreeResult> {
  const baseDir = (opts.baseDir || '').trim();
  if (!baseDir) return { ok: false, error: 'worktree: no folder to start from (pass --workdir)' };
  let probe: WorktreeProbe;
  try {
    probe = parseWorktreeProbe(await deps.run(AGENT_WORKTREE_PROBE, baseDir));
  } catch (e) {
    return { ok: false, error: `worktree: cannot read git state in ${baseDir}: ${errorText(e)}` };
  }
  if (!probe.repo) return { ok: false, error: `worktree: not a git repository: ${baseDir}` };
  if (!probe.headOk) return { ok: false, error: `worktree: the repository has no commit yet: ${probe.top}` };
  const plan = agentWorktreePlan({
    repoRoot: probe.top,
    name: opts.name,
    fallback: opts.fallback,
    takenBranches: probe.branches,
    takenDirs: probe.dirs,
  });
  try {
    await deps.run(AGENT_WORKTREE_EXCLUDE_SCRIPT, probe.top);
  } catch (e) {
    return { ok: false, error: `worktree: cannot update info/exclude: ${errorText(e)}` };
  }
  try {
    await deps.addWorktree(probe.top, plan.path, plan.branch);
  } catch (e) {
    return { ok: false, error: `worktree: ${errorText(e)}` };
  }
  return { ok: true, path: plan.path, branch: plan.branch };
}

function errorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e).trim();
}
