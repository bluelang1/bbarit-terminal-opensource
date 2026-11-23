// Settings → "Agent team in tabs" (config.json `agents.enabled`, default on). Off: the app's own
// agent team — child agents opened as app tabs (agent run/send/wait/stop/status/list), the team
// board and team tasks (agent board …, agent task …), the team status view — is turned off.
// Claude Code's own subagents run inside one tab and are not affected.
//
// The refusal lives in the UI command dispatcher (App.tsx gatewayUiHandlerRef), the one place
// bbarit-ctl (mcp-bridge `__BBARIT_CTL__.dispatch`) and the gateway (`gateway-ui-command`) reach.
// docs/AGENT_RELAY.md "탭 에이전트 팀 스위치".

/** Stable code agents and ctl can match on. */
export const AGENTS_DISABLED_CODE = 'agents_disabled';

/** One message for every refused command: enough for an agent to carry on without child tabs. */
export const AGENTS_DISABLED_ERROR =
  'agent team is turned off: BBARIT Settings → "Agent team in tabs" is off, so child agent tabs, '
  + 'the team board and team tasks are unavailable. Do the work yourself in this tab (subagents '
  + 'built into your own CLI are not affected) and do not retry agent commands unless the user '
  + 'turns it back on.';

/**
 * Commands still answered while off: `agent.run.result` (a worktree run that was already
 * running finishes and its result can be read) and `agent.log` (reads the audit log; starts,
 * messages and controls nothing).
 */
const STILL_ANSWERED = new Set(['agent.run.result', 'agent.log']);

/** Is `agents.enabled` on? Anything but an explicit `false` (missing, old files) is on. */
export function agentTeamEnabled(agents: unknown): boolean {
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return true;
  return (agents as { enabled?: unknown }).enabled !== false;
}

/**
 * Does `cmd` belong to the agent team (refused while off)? Every `agent.*` UI command except
 * the two in STILL_ANSWERED — a future `agent.*` command is refused by default.
 */
export function isAgentTeamCommand(cmd: string): boolean {
  const c = String(cmd || '').trim();
  return c.startsWith('agent.') && !STILL_ANSWERED.has(c);
}

export interface AgentsDisabledRefusal {
  ok: false;
  error: string;
  code: typeof AGENTS_DISABLED_CODE;
}

/** The dispatcher's answer for `cmd` while off, or null when it may run. */
export function agentTeamRefusal(cmd: string, agents: unknown): AgentsDisabledRefusal | null {
  if (!isAgentTeamCommand(cmd) || agentTeamEnabled(agents)) return null;
  return { ok: false, error: AGENTS_DISABLED_ERROR, code: AGENTS_DISABLED_CODE };
}

// ── What the main window shows (App.tsx) ──

/**
 * Toolbar stop-team button: a relay child is working. Shown even while the team is off, so a
 * person can still stop children that were already running (agents' `agent stop` is refused).
 */
export function showStopTeamButton(_enabled: boolean, relayChildWorking: boolean): boolean {
  return relayChildWorking;
}

/** Team status button in the project bar: the project has a team and the team is on. */
export function showTeamStatusButton(enabled: boolean, projectTeamCount: number): boolean {
  return enabled && projectTeamCount > 0;
}

/** Toolbar gauge button: no team status mention or guide target while the team is off. */
export function gaugeButtonLabel(enabled: boolean, locale: string): { title: string; guide?: 'team-status' } {
  const ko = locale === 'ko';
  if (enabled) {
    return { title: ko ? '팀 현황 · 에이전트 대시보드 (대시보드 주소는 설정 > Hub)' : 'Team status · Agent Dashboard (dashboard URL in Settings > Hub)', guide: 'team-status' };
  }
  return { title: ko ? '에이전트 대시보드 (대시보드 주소는 설정 > Hub)' : 'Agent Dashboard (dashboard URL in Settings > Hub)' };
}

type NoteSend = (note: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

/**
 * Wraps a parent-note sender for flushNotes: once the team is off, the notes still in that
 * flush's batch (already taken out of the queue) are dropped (`disposed`), never typed.
 */
export function teamGatedNoteSend(isOn: () => boolean, send: NoteSend): NoteSend {
  return async (note) => (isOn() ? send(note) : { ok: false, reason: 'disposed' });
}

/**
 * `agent run --worktree` whose worktree became ready after the team was turned off: no tab, no
 * brief; the refusal names the worktree and branch that were already created (kept on disk).
 */
export function refusalAfterWorktree(agents: unknown, prepared: { path: string; branch: string }): (AgentsDisabledRefusal & { worktree: string; branch: string }) | null {
  if (agentTeamEnabled(agents)) return null;
  return {
    ok: false,
    code: AGENTS_DISABLED_CODE,
    error: `${AGENTS_DISABLED_ERROR} The worktree ${prepared.path} (branch ${prepared.branch}) was already created and is kept; no tab was opened.`,
    worktree: prepared.path,
    branch: prepared.branch,
  };
}

/** Number on a project-tab / gauge badge (0 = no badge): none while the team is off. */
export function teamBadgeCount(enabled: boolean, count: number): number {
  return enabled ? count : 0;
}

// ── Lead mode trigger (config `agents.leadPhrase`, docs/AGENT_RELAY.md "Lead mode") ──
// A prompt containing the phrase gets lead-mode context from the bundled UserPromptSubmit hook
// (src-tauri/resources/claude-hooks/user-prompt-submit.sh, phrases from GET /api/agent-lead).

export const DEFAULT_LEAD_PHRASE = '리드 에이전트로 진행해줘';
/** Always accepted next to the configured phrase (compared case-insensitively). */
export const ENGLISH_LEAD_PHRASE = 'proceed as the lead agent';
export const LEAD_PHRASE_MIN = 2;
export const LEAD_PHRASE_MAX = 60;

export type LeadPhraseCheck = { ok: true; value: string } | { ok: false; error: 'length' | 'chars' };

/** One line of 2–60 characters, no control or format characters; whitespace trimmed and collapsed. */
export function normalizeLeadPhrase(raw: unknown): LeadPhraseCheck {
  const text = typeof raw === 'string' ? raw : '';
  if (/[\p{Cc}\p{Cf}]/u.test(text)) return { ok: false, error: 'chars' };
  const value = text.trim().split(/\s+/).filter(Boolean).join(' ');
  const n = [...value].length;
  if (n < LEAD_PHRASE_MIN || n > LEAD_PHRASE_MAX) return { ok: false, error: 'length' };
  return { ok: true, value };
}

/** `agents.leadPhrase`, or the default when missing or invalid. */
export function readLeadPhrase(agents: unknown): string {
  const raw = agents && typeof agents === 'object' && !Array.isArray(agents) ? (agents as { leadPhrase?: unknown }).leadPhrase : undefined;
  const r = normalizeLeadPhrase(raw);
  return r.ok ? r.value : DEFAULT_LEAD_PHRASE;
}
