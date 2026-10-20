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

/** Transcript file Claude Code writes for a session id inside the project folder. */
export function claudeSessionFileName(sessionId: string): string {
  return `${sessionId}.jsonl`;
}

export function hasClaudeSessionFile(entries: readonly DirEntryLike[], sessionId: string): boolean {
  const wanted = claudeSessionFileName(sessionId).toLowerCase();
  return entries.some((entry) => !(entry.is_dir ?? entry.isDir) && entry.name.toLowerCase() === wanted);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function newClaudeSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type ClaudeSessionArgs =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'new'; sessionId: string }
  | { kind: 'continue' }
  | { kind: 'none' };

/**
 * Pick the session flag for a Claude terminal:
 * - a tab with its own session id resumes that exact conversation when its
 *   transcript exists and otherwise creates it with `--session-id`, so the
 *   tab never shares a conversation with sibling tabs;
 * - a tab without an id keeps the shared "continue the latest" behavior.
 */
export async function resolveClaudeSessionArgs(
  options: { workDir?: string; sessionId?: string | null; resumeLastSession: boolean },
  probe: ClaudeContinueProbe,
): Promise<ClaudeSessionArgs> {
  const sessionId = isClaudeSessionId(options.sessionId) ? options.sessionId : null;
  if (sessionId) {
    if (!isLocalWorkDir(options.workDir)) return { kind: 'new', sessionId };
    try {
      const home = await probe.getHomeDir();
      const entries = await probe.readDirectory(claudeProjectSessionDir(home, options.workDir));
      return hasClaudeSessionFile(entries, sessionId) ? { kind: 'resume', sessionId } : { kind: 'new', sessionId };
    } catch {
      return { kind: 'new', sessionId };
    }
  }
  if (!options.resumeLastSession) return { kind: 'none' };
  return (await shouldContinueClaudeSession(options.workDir, probe)) ? { kind: 'continue' } : { kind: 'none' };
}

export function claudeSessionArgsToFlags(args: ClaudeSessionArgs): string {
  switch (args.kind) {
    case 'resume': return ` --resume ${args.sessionId}`;
    case 'new': return ` --session-id ${args.sessionId}`;
    case 'continue': return ' --continue';
    default: return '';
  }
}
