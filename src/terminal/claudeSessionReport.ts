// The bundled Claude Code SessionStart hook reports each tab's session id through
// the local bridge (POST /api/claude-session → Tauri event `claude-session-reported`).
// Storing it on the terminal makes the next launch `claude --resume <id>` instead of
// the shared `--continue`. docs/CLAUDE_SESSION_HOOK.md
import { isClaudeSessionId } from './claudeSessionDir';

export const CLAUDE_SESSION_REPORTED_EVENT = 'claude-session-reported';

export interface ClaudeSessionReport {
  terminalId: string;
  sessionId: string;
  transcriptPath?: string;
  /** startup | resume | clear | compact */
  source?: string;
}

type SessionTerminal = { id: string; cliType?: string; claudeSessionId?: string };

/**
 * Set `claudeSessionId` on the reported Claude terminal. Returns the same array when
 * nothing changes (unknown terminal, not a Claude tab, same id, bad payload) so a
 * React state update can bail out. `source: 'clear'` is handled the same way: the
 * new id replaces the old one.
 */
export function applyReportedClaudeSession<T extends SessionTerminal>(
  terminals: T[],
  report: Partial<ClaudeSessionReport> | null | undefined,
): T[] {
  if (!report || typeof report.terminalId !== 'string' || !isClaudeSessionId(report.sessionId)) return terminals;
  const sessionId = report.sessionId.toLowerCase();
  const index = terminals.findIndex((t) => t.id === report.terminalId);
  if (index < 0) return terminals;
  const target = terminals[index];
  if (target.cliType !== 'claude' || target.claudeSessionId === sessionId) return terminals;
  const next = terminals.slice();
  next[index] = { ...target, claudeSessionId: sessionId };
  return next;
}

/** Same as applyReportedClaudeSession across projects; returns the same array when nothing changes. */
export function applyReportedClaudeSessionToProjects<P extends { terminals: SessionTerminal[] }>(
  projects: P[],
  report: Partial<ClaudeSessionReport> | null | undefined,
): P[] {
  let changed = false;
  const next = projects.map((project) => {
    const terminals = applyReportedClaudeSession(project.terminals, report);
    if (terminals === project.terminals) return project;
    changed = true;
    return { ...project, terminals };
  });
  return changed ? next : projects;
}
