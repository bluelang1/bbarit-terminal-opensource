// Claude Code keeps one folder per working directory under ~/.claude/projects/
// and only `claude --continue` works when that folder already holds a session
// transcript (*.jsonl). On a brand-new project the flag makes the CLI exit with
// "No conversation found to continue", so the terminal must start without it.

/**
 * Claude Code's folder name for a cwd: every character outside [A-Za-z0-9]
 * becomes '-'. Claude encodes its physical process.cwd(), so a trailing
 * separator is stripped here; a symlinked work dir may still map elsewhere.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return String(cwd || '').replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

export function isLocalWorkDir(workDir: string | undefined | null): workDir is string {
  const value = String(workDir || '').trim();
  return value.length > 0 && !/^ssh:\/\//i.test(value);
}

export function claudeProjectSessionDir(home: string, cwd: string): string {
  const base = String(home || '').replace(/[\\/]+$/, '');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base}${sep}.claude${sep}projects${sep}${encodeClaudeProjectDir(cwd)}`;
}

export type DirEntryLike = { name: string; is_dir?: boolean; isDir?: boolean };

/** True when the listing holds at least one session transcript file. */
export function hasClaudeSessionFiles(entries: readonly DirEntryLike[]): boolean {
  return entries.some((entry) => !(entry.is_dir ?? entry.isDir) && /\.jsonl$/i.test(entry.name));
}

export type ClaudeContinueProbe = {
  getHomeDir: () => Promise<string>;
  readDirectory: (path: string) => Promise<readonly DirEntryLike[]>;
};

/**
 * Decide whether `--continue` is safe for this work dir. Remote (ssh://) and
 * empty work dirs keep the previous behavior and return true. A lookup failure
 * returns false: read_directory rejects on a missing folder, which is the
 * normal first-run case, and starting without the flag never breaks the launch.
 * Known gap: sessions kept elsewhere via CLAUDE_CONFIG_DIR are not seen.
 */
export async function shouldContinueClaudeSession(workDir: string | undefined, probe: ClaudeContinueProbe): Promise<boolean> {
  if (!isLocalWorkDir(workDir)) return true;
  try {
    const home = await probe.getHomeDir();
    const entries = await probe.readDirectory(claudeProjectSessionDir(home, workDir));
    return hasClaudeSessionFiles(entries);
  } catch {
    // The projects folder does not exist yet (first ever Claude run on this
    // machine) or could not be read: read_directory rejects on a missing path.
    return false;
  }
}
