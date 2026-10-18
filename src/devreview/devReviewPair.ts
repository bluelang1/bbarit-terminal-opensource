// Broker Harness opens TWO real terminals (developer + reviewer)
// and brokers between them. Deliberately simple:
//   - Input is just THROWN into a terminal via the write_to_pty Tauri command
//     (keyed by id, instance-independent): no readiness/timing gates; the CLIs
//     buffer stdin.
//   - The two agents do NOT talk via screen scraping. They communicate entirely
//     through git (the developer's diffs/commits) and the Karpathy wiki
//     (docs/wiki files). The broker just shuttles: it throws the current git diff
//     to the reviewer, and throws the reviewer's wiki review-feed to the developer.
//
// Roles: developer (agent) · reviewer (agent) · broker (BBARIT) · final approver (user).

import { invoke } from '@tauri-apps/api/core';
import { ensureProjectWikiScaffold, getProjectWikiPaths, ensureSharedWikiScaffold, getSharedWikiPaths } from '../notes/wiki';
import { codeGraphCliSource } from './codeGraphCli';
import { judge as mechanicalJudge, snapshotSource, cycleTable, CYCLE_LABELS, type SourceBaseline, type CycleState } from './brokerMechanic';

type InvokeLike = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Relative path the broker drops the code-intelligence CLI at, inside each project. */
const CODE_GRAPH_REL = '.broker/code-graph.mjs';
const STANDING_GOAL_WIKI_FILE = 'standing-goal.md';
/** The broker writes the developer's latest git diff here so the reviewer reads a
 *  file (not a terminal paste, which would pile up as unsubmitted [Pasted Content]). */
const DIFF_FILE_REL = '.broker/latest-diff.patch';
/** Build the reviewer's patch file (header + changed-files manifest + unified diff).
 *  A unified diff fed to `git apply` MUST end with a newline; computeDiff()/gitWorkingDiff()
 *  return a `.trim()`-ed diff (correct for diff-equality checks, but it strips the trailing
 *  newline). Written verbatim, the newline-less final hunk makes `git apply --check` fail
 *  with "corrupt patch at line N" — so the reviewer can never apply/verify the patch. Build
 *  every patch file through here so the on-disk patch is always apply-clean, without changing
 *  the trimmed diff the comparison logic relies on. */
export function ensureApplyCleanPatch(content: string): string {
  // A unified diff fed to `git apply` MUST end with a single terminating newline, or git
  // reports "corrupt patch at line N" on the final hunk. This is the one guard every patch
  // string passes through (build time AND the verify-after-write repair below).
  const s = String(content ?? '');
  return s.endsWith('\n') ? s : `${s}\n`;
}
export function buildReviewPatch(header: string, manifest: string, diff: string): string {
  return ensureApplyCleanPatch(`${header}\n\n${manifest}${diff}`);
}

function appendPath(base: string, leaf: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${leaf}`;
}

async function writeHarnessStandingGoal(
  workDir: string | undefined,
  projectName: string | undefined,
  goal: string,
  invokeFn: InvokeLike = invoke,
): Promise<void> {
  const text = goal.trim();
  if (!workDir || !text) return;
  await ensureProjectWikiScaffold(invokeFn, workDir, projectName || 'project').catch(() => {});
  const paths = getProjectWikiPaths(workDir);
  await invokeFn('write_file', {
    path: appendPath(paths.wikiDir, STANDING_GOAL_WIKI_FILE),
    content: `${text}\n`,
  });
}

async function readHarnessStandingGoal(
  workDir: string | undefined,
  invokeFn: InvokeLike = invoke,
): Promise<string> {
  if (!workDir) return '';
  const paths = getProjectWikiPaths(workDir);
  const content = await invokeFn<string>('read_file', {
    path: appendPath(paths.wikiDir, STANDING_GOAL_WIKI_FILE),
  }).catch(() => '');
  return String(content || '').trim();
}

export async function syncHarnessGoalWithWiki(
  config: Pick<DevReviewPairConfig, 'goal' | 'workDir' | 'projectName'>,
  invokeFn: InvokeLike = invoke,
): Promise<string> {
  const explicitGoal = config.goal.trim();
  if (explicitGoal) {
    await writeHarnessStandingGoal(config.workDir, config.projectName, explicitGoal, invokeFn);
    return explicitGoal;
  }
  return readHarnessStandingGoal(config.workDir, invokeFn);
}

/** The legacy broad transient-harness ignore line. It also matches durable wiki notes such as
 *  `docs/wiki/decisions/broker-harness-source-audit-*.md`, so it must be REMOVED, not just
 *  superseded — `.gitignore` is OR-matched, so leaving it alongside the narrow pattern keeps
 *  the durable note ignored. */
const LEGACY_BROAD_HARNESS_IGNORE = 'docs/wiki/decisions/broker-harness-*.md';
/** Ignore lines the broker's harden step guarantees. The transient harness session log is
 *  `broker-harness-<ISO-timestamp>.md` (recordToWiki: `broker-harness-` + a digit), so the
 *  narrow `broker-harness-[0-9]*.md` catches exactly those and never a durable
 *  `broker-harness-source-audit-*.md`. broker-status.md is per-run live state. */
const BROKER_IGNORE_LINES = [
  'docs/wiki/decisions/broker-brief-*.md',
  'docs/wiki/decisions/broker-harness-[0-9]*.md',
  'docs/wiki/decisions/broker-status.md',
  'docs/wiki/decisions/broker-*-feed.md',
  '.broker/',
];
/** Idempotently upgrade a project's `.gitignore` broker block. Returns the new content (input
 *  unchanged ⇒ identical output, so the caller can skip the write). It ACTIVELY REMOVES the
 *  legacy broad `broker-harness-*.md` line — appending the narrow pattern alone does not
 *  neutralize it (OR-matching keeps durable broker-harness-source-audit-*.md ignored in repos
 *  that already received the broad line), then adds only the missing required lines (no dupes). */
export function upgradeBrokerGitignore(existing: string): string {
  const lines = existing.split('\n');
  const kept = lines.filter((l) => l.trim() !== LEGACY_BROAD_HARNESS_IGNORE);
  const removedLegacy = kept.length !== lines.length;
  const present = new Set(kept.map((l) => l.trim()));
  const missing = BROKER_IGNORE_LINES.filter((line) => !present.has(line));
  if (!removedLegacy && missing.length === 0) return existing; // already upgraded → no-op
  let content = kept.join('\n').replace(/\n+$/, '');
  if (missing.length) {
    content += `\n\n# Broker Agent coordination files (auto-managed; transient harness logs + live state)\n${missing.join('\n')}`;
  }
  return `${content}\n`;
}

/** True when a harness is in the live dev↔review loop — i.e. the manual controls (re-request
 *  rework / reset review / restart agents) are SAFE to act. False during the merge phase
 *  (`approved`/`merging`/`merged`/`merge_failed`: the auto-merge is a one-way door a control
 *  must not interfere with) and for a resting harness (`complete`/`blocked`/`suspended`). Pure
 *  + string-typed so the modal (hide), the relay-loop closures (no-op), and the App-side
 *  Restart-agents guard (return before disposeTerminal) all share ONE definition. */
export function isHarnessInReviewLoop(cycle?: string | null, lifecycle?: string | null): boolean {
  const mergePhase = cycle === 'approved' || cycle === 'merging' || cycle === 'merged' || cycle === 'merge_failed';
  const resting = lifecycle === 'complete' || lifecycle === 'blocked' || lifecycle === 'suspended';
  return !mergePhase && !resting;
}

/** The broker brain keeps this live status doc current (goal/direction/progress/gaps). */
const STATUS_REL = 'docs/wiki/decisions/broker-status.md';

// Any agent CLI available in the terminal can be the developer or the reviewer.
export type DevReviewRole =
  | 'claude' | 'codex' | 'gemini' | 'kimi' | 'qwen'
  | 'cursor' | 'opencode' | 'ollama' | 'pi' | 'reasonix' | 'gajae';

export type BrokerReviewMode = 'off' | 'light' | 'normal' | 'careful' | 'very_careful';

export const ROLE_LABEL: Record<DevReviewRole, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  kimi: 'Kimi',
  qwen: 'Qwen',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  ollama: 'Ollama',
  pi: 'Pi',
  reasonix: 'Reasonix',
  gajae: 'Gajae',
};

// Broker harness roles must be autonomous terminal CLIs that can receive a task,
// edit/test files, and write DONE/APPROVED/REWORK handshakes. Ollama is kept in
// DevReviewRole for legacy terminal/session compatibility, but it is a chat/model
// backend in this app and is not a broker agent role.
export const BROKER_AGENT_ROLES = [
  'claude',
  'codex',
  'gemini',
  'kimi',
  'qwen',
  'cursor',
  'opencode',
  'pi',
  'reasonix',
  'gajae',
] as const satisfies readonly DevReviewRole[];

export function normalizeBrokerAgentRole(value: unknown, fallback: DevReviewRole): DevReviewRole {
  const role = String(value || '').trim() as DevReviewRole;
  return (BROKER_AGENT_ROLES as readonly string[]).includes(role) ? role : fallback;
}

export interface DevReviewPairConfig {
  developer: DevReviewRole;
  reviewer: DevReviewRole;
  goal: string;
  workDir?: string;
  projectName?: string;
  autoRelay: boolean;
  isolate?: boolean;
  /** Global notes root (e.g. ~/Documents/octo-notes). The shared/global wiki lives
   *  under it. Agents look up the project wiki first, then this global wiki. */
  globalNotesDir?: string;
  /** Other open projects (name + workDir). When stuck after project+global wiki,
   *  the developer studies these projects' wikis/source to learn past patterns. */
  otherProjects?: Array<{ name: string; dir: string }>;
  /** Language for the broker's PROGRESS messages + [BROKER] nudges. Default 'en'. */
  lang?: 'en' | 'ko';
  /** Live language getter: read each time so a language toggle takes effect on a
   *  RUNNING harness (new nudges/status switch immediately, no restart). Falls back to
   *  `lang`. The already-printed briefing keeps its start-time language. */
  getLang?: () => 'en' | 'ko';
  /** Deprecated boolean compatibility. When false, DONE skips reviewer and auto-merges after mechanical checks. */
  reviewStep?: boolean;
  /** Review intensity. `off` skips reviewer; other values tune reviewer strictness. */
  reviewMode?: BrokerReviewMode;
  /** When true, web-facing reviews must include BBARIT Browser evidence. Default true. */
  browserReview?: boolean;
  /** Continuous mode (default false). When true, the harness does NOT stop after a
   *  successful merge — it loops back to `developing` and keeps building → merging
   *  → building. The user ends it by stopping the harness. */
  continuous?: boolean;
  /** Live continuous-mode getter: read at the merge decision so UNCHECKING the box on a
   *  RUNNING harness actually stops it after the current unit (instead of looping forever
   *  on the value captured at start). Falls back to `continuous`. */
  getContinuous?: () => boolean;
  /** Continuous sub-mode (live): 'auto' = the agent decides the next unit on its own
   *  (default); 'queue' = the broker feeds the next user-provided task after each merge. */
  getContinuousMode?: () => 'auto' | 'queue';
  /** Queue-mode task source (live): returns AND consumes the next user-queued task, or null
   *  when the queue is empty (the harness then stops cleanly). Called once per merge loop-back. */
  getNextQueuedTask?: () => string | null;
  /** Push-on-merge (live): when true (default), after a successful LOCAL merge the broker also
   *  `git push`es to the remote. When false, it merges locally only. Read at merge time so the
   *  setting takes effect on a running harness. A push failure never flips a successful local
   *  merge to "failed" — it is surfaced as a distinct warning. */
  getPushOnMerge?: () => boolean;
}

/** Live snapshot the broker emits so a UI panel can show the situation at a glance. */
export interface BrokerStatusSnapshot {
  cycle: CycleState;
  cycleLabel: string;
  reason: string;
  action?: string;
  directionOk?: boolean;
  grownLoc?: number;
  /** Epoch ms of when this cycle state was entered. Lets the UI show "in this state for
   *  Xm" so a user can tell a quietly-working harness from a stuck one. Optional so
   *  persisted/restored snapshots from older records stay valid. */
  at?: number;
}

export interface PairEvent {
  kind: 'info' | 'relay' | 'error' | 'status';
  message: string;
  status?: BrokerStatusSnapshot;
}

export interface DevReviewPairHandle {
  stop: () => void;
  developerId: string;
  reviewerId: string;
  branch?: string;
  worktreeDir?: string;
  repoDir?: string;
  merge?: () => Promise<string>;
  /** P3-1: deterministically reset the dev worktree to the last reviewed snapshot,
   *  discarding a drifting REWORK. Returns true on success. User/UI-triggered (never
   *  auto-fired, so the developer's in-progress work is not silently destroyed). */
  rollback?: () => Promise<boolean>;
  /** UI-triggered: re-send the latest review feedback (REWORK) to the developer and move the
   *  cycle back to 'addressing'. For when the developer missed or ignored the relayed REWORK.
   *  Resolves false if the relay loop is not live (too early / already stopped). */
  requestRework?: () => Promise<boolean>;
  /** UI-triggered: clear the review feed file (reviewer + dev mirror) and reset the broker's
   *  review-cycle bookkeeping (rework/pending/repeat flags) so a stuck REWORK/APPROVED no
   *  longer gates the loop. Does NOT touch code or the diff. Resolves false if not live. */
  resetReviewFeed?: () => Promise<boolean>;
  /** Re-send the startup briefings to the agent CLIs. The frontend "restart agents" flow kills
   *  + re-spawns the two terminals in place (same worktree, same relay loop) and calls this once
   *  they are ready again, so the fresh CLIs are re-briefed to CONTINUE the in-progress work. */
  rebrief?: () => Promise<boolean>;
}

type Emit = (e: PairEvent) => void;

const RELAY_MARK = '[BROKER]';
// The reviewer appends its reviews here; the broker relays new content to the dev.
const REVIEW_FEED_REL = 'docs/wiki/decisions/broker-review-feed.md';
// The developer appends "DONE: <summary>" here after a meaningful unit is implemented,
// tested, and documented in the wiki. This is the broker's explicit review trigger.
const DEV_FEED_REL = 'docs/wiki/decisions/broker-dev-feed.md';

// [D-startup-settle] Settle after the dev CLI is already idle-debounce-ready, before the
// broker throws the startup briefing. Readiness already proves the CLI booted (running
// child + PTY quiet ≥1.5s), so this is a small safety margin, not a boot wait. Was 6000.
const POST_READY_SETTLE_MS = 1200;
// Gap between the reviewer-standby write and the dev-startup write so two relays don't
// land in the same render frame. Was 1500.
const INTER_BRIEF_GAP_MS = 700;
// The reviewer standby briefing is a single best-effort PTY write. If it lands in the agent
// CLI's final render frame it can be lost, and the first-send latch then blocks any retry —
// so the reviewer silently never gets briefed ("the broker message sometimes doesn't appear
// in the review agent at the start"). Re-send it ONCE, well-spaced, as a delivery backstop.
const REVIEWER_STANDBY_REBRIEF_GAP_MS = 6000;
const REVIEWER_STANDBY_MAX_SENDS = 2;

type OpenPair = (
  devCli: DevReviewRole,
  revCli: DevReviewRole,
  workDir?: string,
  reviewerWorkDir?: string, // P1-6: reviewer runs in its OWN worktree (isolated, not read-only);
                            // falls back to workDir when not provided.
) => { developerId: string; reviewerId: string } | null;

export interface StartOpts {
  /** Reuse these two terminals (just re-brief them) instead of opening new ones. */
  existing?: { developerId: string; reviewerId: string };
  /** Saved broker-managed git context to restore after a reload. */
  managed?: { branch?: string; worktreeDir?: string; reviewerWorkDir?: string; repoDir?: string };
  /** Last persisted UI status; used only to recover interrupted merge attempts. */
  restoredStatus?: BrokerStatusSnapshot;
  /** Resume after a reload: reuse terminals, skip the boot wait + briefing nudges,
   *  and just restart the relay loop from the current git/feed state. */
  resume?: boolean;
  /** Wait until the UI-mounted terminal has injected the agent CLI startup command. */
  waitForTerminalsReady?: (ids: { developerId: string; reviewerId: string }) => Promise<boolean>;
  /** Wait for one role terminal. Used so the dev agent can start even if review agent boot lags. */
  waitForTerminalReady?: (id: string, role: DevReviewRole) => Promise<boolean>;
  /** One-shot "is this terminal ready for broker input RIGHT NOW" probe (non-blocking).
   *  Unlike waitForTerminalReady (which blocks until ready), this returns the current state in
   *  one check. The relay-loop standby self-heal uses it so it NEVER briefs into a raw shell:
   *  the gold-standard predicate refuses a plain shell prompt, requires idle, and confirms a
   *  live agent process — strictly stronger than the legacy pty_terminal_has_child + idle gate,
   *  which is defeated on Windows (the PTY child is always the shell). */
  isTerminalReady?: (id: string, role: DevReviewRole) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// [D-perf-single-loop] At most ONE live relay loop per developer terminal. A React remount,
// a restore race, or a stale HMR closure can start a second loop for the same harness —
// each orphan then polls feeds/git forever, multiplying broker background cost invisibly.
// The registry lives on globalThis so it survives HMR module replacement: a newer loop
// registering the same terminal id supersedes the old one, which exits on its next tick.
type RelayLoopRegistry = Map<string, number>;
const relayLoopRegistry: RelayLoopRegistry = ((globalThis as Record<string, unknown> & { __octoBrokerRelayLoops?: RelayLoopRegistry }).__octoBrokerRelayLoops ||= new Map());
function nextRelayLoopToken(): number {
  const g = globalThis as Record<string, unknown> & { __octoBrokerRelaySeq?: number };
  g.__octoBrokerRelaySeq = (g.__octoBrokerRelaySeq || 0) + 1;
  return g.__octoBrokerRelaySeq;
}

let brokerBranchCounter = 0;
function nextBrokerBranchSlug(): string {
  brokerBranchCounter = (brokerBranchCounter + 1) % 1_000_000;
  return `${Date.now()}-${brokerBranchCounter.toString(36)}`;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function normDir(dir: string): string {
  return String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

async function sh(command: string, workDir: string, timeoutSecs: number): Promise<string> {
  // login:false — the broker only runs git here, which is always on PATH. A Git-Bash
  // login shell re-sources /etc/profile on EVERY call (~2.3s wasted/call on Windows),
  // and the 6s relay loop fires several of these per cycle. Non-login keeps the loop snappy.
  return invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs, login: false });
}

function submitTerminalInput(id: string): void {
  // Submit with a lone CR. Claude Code treats CRLF ("\r\n") as a newline INSERT, not
  // Enter, so the relayed briefing stayed in its input box unsubmitted (Codex still
  // submitted, hence the dev/reviewer asymmetry). A bare "\r" submits for Claude
  // Code, Codex, and shells alike — verified live.
  void invoke('write_to_pty', { terminalId: id, data: '\r' }).catch(() => {
    void invoke('write_to_pty', { terminalId: id, data: '\n' }).catch(() => {});
  });
}

// Throw input into a terminal by id. Text and Enter are sent separately because
// Claude Code / Codex treat a large multi-line write as a "[Pasted Content]" block
// and would otherwise absorb a trailing \r instead of submitting it.
function throwToTerminal(id: string, text: string): void {
  void invoke('write_to_pty', { terminalId: id, data: text }).catch(() => {});
  // Submit the typed text. Some agent CLIs (Kimi/K2.7 Code especially) buffer a longer
  // input and absorb a TOO-EARLY carriage return into the text instead of submitting it,
  // leaving the command sitting un-submitted in the input box. Wait long enough for the
  // input to settle, then send several spaced CRs so the Enter reliably lands. A stray CR
  // at an empty prompt is harmless. (Base delay raised to 1200ms — a live /help test
  // submitted at ~1.2s but not at 0.8s.)
  const submitDelayMs = Math.min(5000, Math.max(1200, 600 + Math.ceil(text.length / 2)));
  for (const d of [submitDelayMs, submitDelayMs + 1500, submitDelayMs + 3500, submitDelayMs + 6000]) {
    setTimeout(() => submitTerminalInput(id), d);
  }
}

// Write a review patch file and VERIFY it landed apply-clean. buildReviewPatch already
// guarantees a terminating newline, but the reviewer is hard-blocked by a "corrupt patch at
// line N" the moment the on-disk artifact lacks one — so don't TRUST the write, verify it:
// read the file back and repair a missing trailing newline (defends against a partial write,
// an encoding mangle, or a stale in-process builder that wrote the trimmed diff verbatim).
async function writeReviewPatchFile(path: string, content: string): Promise<void> {
  await invoke('write_file', { path, content: ensureApplyCleanPatch(content) }).catch(() => {});
  const written = (await invoke<string>('read_file', { path }).catch(() => '')) || '';
  if (written && !written.endsWith('\n')) {
    await invoke('write_file', { path, content: `${written}\n` }).catch(() => {});
  }
}

// Review diff for staged + unstaged changes. `git add -N` exposes brand-new
// untracked files to `git diff` without staging their content.
// P2-6: distinguish a git FAILURE from a genuinely EMPTY diff. A swallowed git error
// looked identical to "no changes", which falsely failed the DONE gate (the developer
// did change code, but the broker couldn't see it). Returns an explicit error so the
// caller doesn't misread a broken repo as an empty diff.
// [D-perf-lazydiff] Work dirs whose `rev-parse --is-inside-work-tree` health check already
// passed. The check exists to distinguish "empty diff" from "broken repo" (P2-6), but a
// harness worktree stays a valid work tree for its whole life — probing it before EVERY
// capture wastes one shell spawn each time. Sticky-cache the pass; any later capture
// failure evicts the entry so the next call re-probes from scratch.
const healthyGitWorkDirs = new Set<string>();
async function gitWorkingDiff(workDir: string, baseRef = ''): Promise<{ diff: string; error: string | null }> {
  try {
    // Health-check first: a real empty diff requires a working tree to exist. If this
    // isn't a git work tree (index lock, not-a-repo, permission), report an error.
    if (!healthyGitWorkDirs.has(workDir)) {
      const inside = ((await invoke<string>('run_cli_oneshot', { command: 'git rev-parse --is-inside-work-tree', workDir, timeoutSecs: 15, login: false })) || '').trim();
      if (!inside.includes('true')) {
        return { diff: '', error: `git is not healthy here (rev-parse: ${inside.slice(0, 80) || 'empty/failed'})` };
      }
      healthyGitWorkDirs.add(workDir);
    }
    await invoke('run_cli_oneshot', { command: 'git add -N . 2>/dev/null || true', workDir, timeoutSecs: 20, login: false });
    if (baseRef) {
      // P3-1: cumulative diff against the worktree's ORIGINAL base, so per-round snapshot
      // commits (which move HEAD) don't make this look empty. `git diff <base>` spans the
      // committed snapshots AND the current uncommitted edits = everything since base.
      const cumulative = ((await invoke<string>('run_cli_oneshot', { command: `git diff ${baseRef}`, workDir, timeoutSecs: 30, login: false })) || '').trim();
      return { diff: cumulative, error: null };
    }
    const staged = ((await invoke<string>('run_cli_oneshot', { command: 'git diff --cached', workDir, timeoutSecs: 25, login: false })) || '').trim();
    const unstaged = ((await invoke<string>('run_cli_oneshot', { command: 'git diff', workDir, timeoutSecs: 25, login: false })) || '').trim();
    return { diff: [staged, unstaged].filter(Boolean).join('\n').trim(), error: null };
  } catch (e) {
    // A capture failed after the health check passed — the repo may have degraded
    // (lock, deleted worktree). Drop the cached pass so the next call re-probes.
    healthyGitWorkDirs.delete(workDir);
    return { diff: '', error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

// [D-perf-lazydiff] Cheap "any working-tree changes?" probe for idle relay ticks. One
// `git status --porcelain` spawn (covers staged + unstaged + untracked — the same set
// `git add -N` + `git diff` exposes) instead of gitWorkingDiff's three spawns + the full
// cumulative patch over the shell pipe. An error reads as "no changes": the caller only
// uses this to refresh a display cycle, and the DONE path always re-checks with the
// authoritative gitWorkingDiff before any decision is made.
async function gitHasWorkingChanges(workDir: string): Promise<boolean> {
  try {
    const out = ((await invoke<string>('run_cli_oneshot', { command: 'git status --porcelain', workDir, timeoutSecs: 20, login: false })) || '').trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// P2-5: structured changed-files manifest (Cline getDiffSet { path, before/after }) so the
// reviewer can cite exact paths instead of parsing a flat patch, and binary files are
// flagged-and-excluded rather than appearing as opaque "Binary files differ" noise.
export function parseNumstatManifest(numstat: string): { rows: string[]; count: number } {
  const rows: string[] = [];
  for (const raw of String(numstat || '').split('\n')) {
    const m = raw.trim().match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) continue;
    const [, adds, dels, path] = m;
    if (adds === '-' || dels === '-') rows.push(`- ${path} (binary — excluded from the review diff)`);
    else rows.push(`- ${path} (+${adds} -${dels})`);
  }
  return { rows, count: rows.length };
}

// P3-2: path-conditional rules (Cline rule-conditionals). A rule block in the rules doc
// may carry a `paths:` line of globs; the broker activates only the rules whose globs
// match the changed file set (rules without `paths:` are always active). This focuses the
// reviewer on the rules that actually apply to THIS change.
export interface PathRule { title: string; paths: string[] }
function globToRegExp(glob: string): RegExp {
  // Escape regex specials (but NOT * or ?), then walk the glob expanding tokens:
  // `**/` spans any path segments, `**` spans anything, `*` stays within one
  // segment, `?` is a single non-slash char.
  const esc = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let body = '';
  let i = 0;
  while (i < esc.length) {
    if (esc[i] === '*' && esc[i + 1] === '*') {
      if (esc[i + 2] === '/') { body += '(?:.*/)?'; i += 3; } else { body += '.*'; i += 2; }
    } else if (esc[i] === '*') { body += '[^/]*'; i += 1; }
    else if (esc[i] === '?') { body += '[^/]'; i += 1; }
    else { body += esc[i]; i += 1; }
  }
  return new RegExp(`^${body}$`);
}
export function parsePathRules(md: string): PathRule[] {
  const rules: PathRule[] = [];
  let cur: { title: string; paths: string[]; sawBody: boolean } | null = null;
  for (const line of String(md || '').split('\n')) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) { if (cur) rules.push({ title: cur.title, paths: cur.paths }); cur = { title: h[1].trim(), paths: [], sawBody: false }; continue; }
    if (!cur) continue;
    const p = line.match(/^\s*paths:\s*(.+)$/i);
    if (p && !cur.sawBody) { cur.paths = p[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (line.trim()) cur.sawBody = true;
  }
  if (cur) rules.push({ title: cur.title, paths: cur.paths });
  return rules;
}
export function selectActiveRules(rules: PathRule[], changedPaths: string[]): PathRule[] {
  const norm = changedPaths.map((p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  return rules.filter((r) => {
    if (!r.paths.length) return true; // unconditional rule — always active
    return r.paths.some((g) => { const re = globToRegExp(g); return norm.some((p) => re.test(p)); });
  });
}
async function gitChangedPaths(workDir: string, baseRef: string): Promise<string[]> {
  try {
    const cmd = baseRef ? `git diff --name-only ${baseRef}` : 'git diff --name-only HEAD';
    const out = ((await invoke<string>('run_cli_oneshot', { command: cmd, workDir, timeoutSecs: 25, login: false })) || '').trim();
    return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Build the changed-files manifest against a STABLE base ref (the worktree's original
// baseSha), NOT HEAD. snapshotRound() commits each round and moves HEAD, so `git diff
// --numstat HEAD` is empty right after a checkpoint — which silently dropped the whole
// manifest. Diffing against baseSha matches the cumulative `working` patch the reviewer sees.
async function gitChangedFilesManifest(workDir: string, baseRef?: string): Promise<string> {
  try {
    const ref = (baseRef || '').trim() || 'HEAD';
    const out = ((await invoke<string>('run_cli_oneshot', { command: `git diff --numstat ${ref}`, workDir, timeoutSecs: 25, login: false })) || '').trim();
    const { rows, count } = parseNumstatManifest(out);
    if (!count) return '';
    return `## Changed files (${count})\n${rows.join('\n')}\n\n`;
  } catch {
    return '';
  }
}

function isClosedCycle(cycle: CycleState): boolean {
  return cycle === 'approved' || cycle === 'merging' || cycle === 'merged' || cycle === 'merge_failed';
}

function isTerminalCycle(cycle: CycleState): boolean {
  return cycle === 'merged' || cycle === 'merge_failed';
}

function isEarlyCycle(cycle: CycleState): boolean {
  return cycle === 'developing' || cycle === 'dev_done' || cycle === 'reviewing' || cycle === 'review_done' || cycle === 'addressing';
}

function isUserReopenedDevelopingStatus(status: BrokerStatusSnapshot | undefined | null): boolean {
  if (status?.cycle !== 'developing') return false;
  return /New work detected in a completed harness|완료된 하네스에서 새 작업 입력/.test(status.reason || '');
}

// Continuous mode intentionally loops back to `developing` right after a merge. That
// transition (approved/merging/merged -> developing) is exactly what the guards below
// reject for ordinary harnesses, so detect the broker's own continuous-loopback status
// by its reason marker and always accept it.
export function isContinuousLoopbackStatus(status: BrokerStatusSnapshot | undefined | null): boolean {
  if (status?.cycle !== 'developing') return false;
  return /continuous mode|연속 모드/.test(status.reason || '');
}

export function shouldAcceptBrokerStatusUpdate(current: BrokerStatusSnapshot | undefined | null, next: BrokerStatusSnapshot | undefined | null): boolean {
  if (!next || !current) return true;
  if (isContinuousLoopbackStatus(next)) return true;
  if (isUserReopenedDevelopingStatus(current) && next.cycle === 'merged') return false;
  if (isTerminalCycle(current.cycle)) return next.cycle === current.cycle;
  if ((current.cycle === 'approved' || current.cycle === 'merging') && isEarlyCycle(next.cycle)) return false;
  return true;
}

export function shouldReopenMergedCycleForDone(current: CycleState, next: CycleState, reason: string): boolean {
  return current === 'merged' && next === 'reviewing' && /^developer DONE\b/i.test(reason);
}

export function isPrematureReviewerFeedback(ctx: { pendingRevSince: number; reviewedOnce: boolean; cycle: CycleState }): boolean {
  return !ctx.pendingRevSince && !ctx.reviewedOnce && ctx.cycle === 'developing';
}

export function nextCycleForWorkingWithoutDone(cycle: CycleState): CycleState | null {
  if (cycle === 'addressing') return 'addressing';
  if (cycle === 'developing' || cycle === 'reviewing' || isClosedCycle(cycle)) return null;
  return 'developing';
}

// Cline-style canonical signature of a relay decision (loop-detection.ts toolCallSignature).
// Collapse whitespace/case and bound length so the same REWORK relayed N times produces an
// identical key — used to catch a reviewer that keeps issuing the same rework with no
// convergence (the broker would otherwise nudge forever).
export function relaySignature(role: 'dev' | 'rev', decision: string, body: string): string {
  const norm = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 2000);
  return `${role}|${decision}|${norm}`;
}

/** Whether to re-send the reviewer's standby briefing as a delivery backstop. The standby
 *  message is a single best-effort PTY write; if it lands in the agent CLI's final render
 *  frame it can be lost, and the first-send latch then blocks any retry — so the reviewer
 *  silently never gets briefed. This decides a SECOND, well-spaced send: only when the CLI
 *  is currently up (has a child) and settled (idle ≥ 1.5s), exactly one prior send happened,
 *  and the rebrief gap has elapsed. Bounded by maxSends so it can never spam. The
 *  never-briefed case (sends === 0) is handled by the ordinary readiness path, not here. */
export function shouldResendReviewerStandby(ctx: {
  hasChild: boolean;
  idleMs: number;
  sends: number;
  maxSends: number;
  msSinceLast: number;
  rebriefGapMs: number;
  stopped: boolean;
}): boolean {
  if (ctx.stopped || !ctx.hasChild) return false;
  if (ctx.sends <= 0 || ctx.sends >= ctx.maxSends) return false;
  if (ctx.idleMs < 1500) return false;
  return ctx.msSinceLast >= ctx.rebriefGapMs;
}

export type DoneReviewGate = 'no_done' | 'empty_diff' | 'empty_rework' | 'duplicate_diff' | 'duplicate_rework' | 'request_review';

export function classifyDoneSignalReview(
  hasDoneSignal: boolean,
  workingDiff: string,
  lastReviewedDiff: string,
  reworkOpen: boolean,
): DoneReviewGate {
  if (!hasDoneSignal) return 'no_done';
  const workingTrim = String(workingDiff || '').trim();
  if (!workingTrim) return reworkOpen ? 'empty_rework' : 'empty_diff';
  const sameAsLastReview = workingTrim === String(lastReviewedDiff || '').trim();
  if (sameAsLastReview) return reworkOpen ? 'duplicate_rework' : 'duplicate_diff';
  return 'request_review';
}

export function latestDoneLineStart(text: string): number {
  let last = -1;
  const re = /(^|\r?\n)([^\r\n]*\bDONE\b[^\r\n]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || '')))) {
    last = match.index + match[1].length;
  }
  return last;
}

export function extractBrokerReviewedDiff(text: string): string {
  const value = String(text || '').trim();
  const diffStart = value.search(/^diff --git /m);
  return (diffStart >= 0 ? value.slice(diffStart) : value).trim();
}

export function reviewDecisionFromText(text: string): 'approved' | 'rework' | null {
  let decision: 'approved' | 'rework' | null = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '').trim();
    if (!line) continue;
    const reworkMention = /\bREWORK\b/i.test(line);
    const negatedRework = (
      /\b(?:no|none|without|not)\s+(?:new\s+|further\s+|additional\s+)?REWORK\b/i.test(line)
      || /\bREWORK\s*(?:[:=-])?\s*(?:none|n\/a|no|unnecessary|없음)\b/i.test(line)
      || /\bREWORK\s+(?:is\s+)?not\s+(?:needed|required|necessary)\b/i.test(line)
    );
    const explicitRework = reworkMention && !negatedRework && (
      /^REWORK\b/i.test(line)
      || /\bREWORK\s*[:=-]/i.test(line)
    );
    const negatedChangeRequest = (
      /\bno\s+(?:changes?\s+requested|requested\s+changes|fix(?:es)?\s+(?:required|needed)|work\s+needed)\b/i.test(line)
      || /\bwithout\s+(?:changes?\s+requested|requested\s+changes|required\s+fix(?:es)?)\b/i.test(line)
    );
    const explicitChangeRequest = !negatedChangeRequest && (
      /\bCHANGES?\s+REQUESTED\b/i.test(line)
      || /\bREQUEST(?:ED)?\s+CHANGES\b/i.test(line)
      || /\bNEEDS?\s+(?:CHANGES?|WORK|FIX(?:ES)?)\b/i.test(line)
      || /\bFIX(?:ES)?\s+(?:REQUIRED|NEEDED)\b/i.test(line)
      || /\bnot\s+ready\s+to\s+ship\b/i.test(line)
    );
    const negatedApproval = (
      /\b(?:not|no|never|without)\s+(?:yet\s+)?(?:APPROVED|LGTM|approval)\b/i.test(line)
      || /\b(?:APPROVED|LGTM)\s*(?:[:?=-])?\s*(?:no\b(?!\s+(?:new\s+|further\s+|additional\s+)?REWORK)|false|not\s+yet)\b/i.test(line)
      || /\b(?:do\s+not|don't|not)\s+ship\s*it\b/i.test(line)
      || /\bnot\s+(?:ready\s+)?to\s+ship\b/i.test(line)
    );
    const approved = !negatedApproval && /\b(APPROVED|LGTM|ship\s*it)\b/i.test(line);
    if (explicitRework || explicitChangeRequest) decision = 'rework';
    else if (approved) decision = 'approved';
  }
  return decision;
}

export function trimFeedForArchive(text: string, maxChars = 48000, keepChars = 8000): { archive: string; live: string; removed: number } {
  const current = String(text || '');
  if (current.length <= maxChars) return { archive: '', live: current, removed: 0 };
  const rawCut = Math.max(0, current.length - keepChars);
  const lineCut = current.indexOf('\n', rawCut);
  const cut = lineCut >= 0 && lineCut < current.length - 1 ? lineCut + 1 : rawCut;
  const archive = current.slice(0, cut);
  const live = current.slice(cut);
  return { archive, live, removed: archive.length };
}

// The broker's mechanical judgement lives in ./brokerMechanic (judge()).

const KARPATHY_GUIDELINES = `[MANDATORY PRINCIPLES - Andrej Karpathy guidelines]
1. Think Before Coding - surface assumptions/tradeoffs; no hidden uncertainty; present valid approaches openly.
2. Simplicity First - minimum code that solves the problem; nothing speculative.
3. Surgical Changes - touch only what you must; preserve existing style; remove only what your change made unnecessary.
4. Goal-Driven Execution - define measurable success criteria first, then loop until verified.`;

function normalizeReviewMode(reviewMode?: BrokerReviewMode, reviewStep = true): BrokerReviewMode {
  if (reviewStep === false) return 'off';
  return reviewMode || 'careful';
}

function reviewModeLabel(mode: BrokerReviewMode): string {
  if (mode === 'off') return 'Off';
  if (mode === 'light') return 'Light';
  if (mode === 'normal') return 'Normal';
  if (mode === 'very_careful') return 'Very careful';
  return 'Careful';
}

function reviewModeInstruction(mode: BrokerReviewMode): string {
  switch (mode) {
    case 'light':
      return 'Review intensity: LIGHT. Do a fast sanity check for obvious correctness, broken builds/tests, scope drift, and dangerous regressions. Use REWORK only for concrete blockers.';
    case 'normal':
      return 'Review intensity: NORMAL. Check goal alignment, changed files, core correctness, likely edge cases, test/build evidence, and user-visible regressions before verdict.';
    case 'very_careful':
      return 'Review intensity: VERY CAREFUL. Perform a deep technical review: inspect the full diff and impact graph, verify goal alignment, architecture fit, edge cases, regression risk, changed-file scope, tests/build/typecheck evidence, state persistence, security/privacy, error handling, concurrency/race conditions, UI behavior, documentation accuracy, and whether the change can safely merge unattended. If anything important is unverified, write REWORK.';
    case 'careful':
      return 'Review intensity: CAREFUL. Perform a thorough technical review of diff, impact, tests/build evidence, regressions, edge cases, state persistence, security/privacy, error handling, concurrency, and UI behavior before verdict.';
    case 'off':
    default:
      return 'Review step is disabled.';
  }
}

export function workflowBriefing(role: 'developer' | 'reviewer', other: DevReviewRole, devRole: DevReviewRole, revRole: DevReviewRole, goal: string, globalWikiDir?: string, otherProjects?: Array<{ name: string; dir: string }>, lang: 'en' | 'ko' = 'en', reviewStep = true, reviewMode?: BrokerReviewMode, browserReview = true): string {
  const effectiveReviewMode = normalizeReviewMode(reviewMode, reviewStep);
  const reviewEnabled = effectiveReviewMode !== 'off';
  const otherLabel = ROLE_LABEL[other];
  const langRule = lang === 'ko'
    ? `[Language] 사용자에게 보이는 모든 대화, 설명, 진행 보고는 한국어로 작성하세요. 코드, 파일 경로, 커밋 메시지, wiki 기술 항목은 영어로 유지하세요.\n\n`
    : '';
  const goalText = goal.trim() || '(The user will give the specific task directly in this terminal. Greet briefly and wait for it.)';
  const roles = `[BBARIT Broker Agent - 4 roles] (1) Developer=${ROLE_LABEL[devRole]} (2) Reviewer=${ROLE_LABEL[revRole]} (3) Broker=BBARIT terminal (4) Human=user for direction and deploy decisions. You and ${otherLabel} do NOT see each other's terminal directly.`;
  const channel = `[Communication channel - broker relays locations, not document bodies] The DEVELOPER works like normal development: implement, test, commit meaningful units when useful, and keep project memory in docs/wiki. MANDATORY COMPLETION HANDSHAKE: when a meaningful unit is finished, tested, and documented, append exactly one line DONE: <summary> to ${DEV_FEED_REL}. Saying "complete", "ready", or "done" only in chat is not enough; the broker reacts only to the DONE line in ${DEV_FEED_REL}. ${reviewEnabled ? `Review mode: ${reviewModeLabel(effectiveReviewMode)}. The broker writes the current diff to ${DIFF_FILE_REL} and tells the REVIEWER where it is. The REVIEWER replies with REWORK: ... or APPROVED in ${REVIEW_FEED_REL}.` : `Review step is disabled for this harness. After DONE, the broker writes the current diff to ${DIFF_FILE_REL}, runs mechanical checks, and attempts auto-commit/merge without asking the REVIEWER unless risk is escalated.`} The broker relays availability only; open the referenced files yourself.`;
  const otherList = (otherProjects && otherProjects.length)
    ? otherProjects.slice(0, 12).map((p) => `${p.dir}${p.name ? ` (${p.name})` : ''}`).join(', ')
    : '';
  const knowledge = `[Knowledge base] Read project wiki docs/wiki first, then global wiki${globalWikiDir ? ` at ${globalWikiDir}` : ''}, then other project wikis/source if stuck${otherList ? `: ${otherList}` : ''}. Record project-specific decisions in small focused docs under docs/wiki/decisions or docs/wiki/concepts.`;
  const tooling = `[Structural code intelligence] Run node ${CODE_GRAPH_REL} <cmd> instead of many grep/read cycles. Useful commands: arch, defs <name>, callers <name>, impact [--staged].`;
  const reviewOnly = `[Reviewer boundaries] The REVIEWER is review-only: never edit product source, tests, config, manifests, or build files. The reviewer may write only ${REVIEW_FEED_REL} and focused wiki review/design notes.`;
  const reviewPolicy = reviewEnabled ? `[Review intensity policy] ${reviewModeInstruction(effectiveReviewMode)}` : '[Review intensity policy] Review step is disabled.';
  const browserReviewRequired = browserReview !== false;
  const browserReviewPolicy = browserReviewRequired
    ? `[Mandatory BBARIT Browser review] For any web UI, browser automation, frontend, routing, auth, network/API, console-error, layout, selector, or user-flow change, the REVIEWER must test with BBARIT Browser before verdict. Use the BBARIT Browser CLI from the repo root in this order: FIRST run 'npm run browser:open -- --url <APP_URL> --project "$PWD"' (idempotent — it just focuses the existing window if one is already open), THEN capture evidence with 'npm run browser -- snapshot', 'npm run browser -- screenshot --file .octo-tmp/review.png', 'npm run browser -- console', and 'npm run browser -- network' (full command list in agent-browser-cli/CLI.md). Capture at minimum: snapshot/DOM selectors, screenshot, console, network/server requests, and the changed user flow. A browser control command run before browser:open fails with a 'dev:screen failed'/timeout error — that is a setup-order mistake (open first), NOT proof that the browser is unavailable, so never REWORK for "browser not available" without having actually run browser:open first. If BBARIT Browser genuinely cannot be run after opening it, write REWORK with the exact missing browser verification instead of APPROVED. APPROVED evidence must name the browser checks performed.`
    : `[Optional BBARIT Browser review] BBARIT Browser testing is optional for this harness. Use it when it materially improves confidence, especially for web UI, browser automation, frontend, routing, auth, network/API, console-error, layout, selector, or user-flow changes; do not block approval solely because browser evidence is absent.`;
  const browserReviewStandard = browserReviewRequired
    ? 'For web-facing changes, BBARIT Browser verification is not optional.'
    : 'For web-facing changes, BBARIT Browser verification is optional for this harness; use it when useful, but do not reject solely because browser evidence is absent.';
  const approvedEvidence = browserReviewRequired
    ? 'APPROVED: <brief evidence checked, including BBARIT Browser evidence for web-facing changes>'
    : 'APPROVED: <brief evidence checked>';
  const common = `${langRule}${roles}\n\n${channel}\n\n${knowledge}\n\n${tooling}\n\n${reviewOnly}\n\n${reviewPolicy}\n\n${KARPATHY_GUIDELINES}`;
  if (role === 'developer') {
    return `${common}\n\nYour role: [DEVELOPER]. Work in English. Work like a normal developer: understand the task, make focused code changes, test them yourself, run build/typecheck where relevant, and record durable project knowledge in docs/wiki with focused notes. Do not wait for a broker-specific planning ceremony before coding.\n\n[CRITICAL DONE RULE] You MUST append DONE: <what you finished> to ${DEV_FEED_REL} when the work unit is genuinely implemented, tested, and documented. Do not only say "done", "ready for review", or "작업 완료" in chat; the broker will not move forward from chat text. The ${reviewStep ? 'review/merge pipeline' : 'auto-merge pipeline'} starts only after the DONE line is written to ${DEV_FEED_REL}. Never announce DONE early.\n\n${reviewStep ? `When broker says review feedback is available, open ${REVIEW_FEED_REL}. If it contains REWORK, that REWORK is mandatory: apply it exactly, change the code/tests, and do not append DONE again until the REWORK is actually fixed.` : 'Review step is disabled. After DONE, the broker will skip the reviewer and attempt auto-commit/merge after mechanical checks. High-risk changes may still be blocked for human attention.'} Do not manually merge or deploy. ${reviewStep ? 'After reviewer APPROVED, the broker auto-commits and merges the managed branch only when git checks pass' : 'The broker auto-commits and merges the managed branch only when git checks pass'}; failed commit/merge is escalated to the human.\n\n[GOAL]\n${goalText}`;
  }
  if (!reviewEnabled) {
    return `${common}\n\nYour role: [REVIEWER/TESTER]. Work in English. Review step is disabled for this harness. On startup, do NOT review, approve, reject, or append anything. Stay idle unless the broker later explicitly asks for emergency human-risk review. Do not edit source code.\n\n[REVIEW TARGET GOAL]\n${goalText}`;
  }
  const reviewBriefSections = [
    `${common}\n\nYour role: [REVIEWER/TESTER]. Work in English. You are review-only. On startup, do NOT review, approve, reject, or append anything yet. Wait silently until the broker sends an explicit "Review requested" message.`,
    browserReviewPolicy,
    `[TECHNICAL REVIEW STANDARD] Each time the broker requests review, open ${DIFF_FILE_REL} or run git diff, run node ${CODE_GRAPH_REL} impact, and perform a careful technical review before writing any verdict. Check at minimum: goal alignment, correctness, edge cases, regression risk, changed-file scope, tests/build/typecheck evidence, state persistence, security/privacy, error handling, concurrency/race conditions, UI behavior when relevant, and whether docs/wiki notes match the actual code. ${browserReviewStandard} Do not approve from summaries alone. Do not approve just because the developer says it is done. If you cannot verify a required point, write REWORK with the exact missing verification or fix.`,
    `[VERDICT FORMAT] Append either REWORK: <exact technical fixes> or ${approvedEvidence} to ${REVIEW_FEED_REL}. APPROVED means you personally checked the diff and the change is correct and ready for broker auto-commit/merge. If anything is wrong or unverified, issue REWORK and keep issuing REWORK until the developer has actually changed the code/tests and fixed it.`,
    `[SELF-IMPROVEMENT] If a real recurring lesson appears during an actual review, record it briefly in docs/wiki/concepts/design-rules.md or a focused docs/wiki note, preferring to sharpen an existing rule before adding a new one. Do not invent learning notes when no durable lesson exists.`,
    `[REVIEW TARGET GOAL]\n${goalText}`,
  ];
  return reviewBriefSections.join('\n\n');
}
async function recordToWiki(config: DevReviewPairConfig): Promise<void> {
  if (!config.workDir) return;
  const projectName = config.projectName || 'project';
  await ensureProjectWikiScaffold(invoke, config.workDir, projectName).catch(() => {});
  const paths = getProjectWikiPaths(config.workDir);
  const stamp = new Date().toISOString();
  const fileSlug = `broker-harness-${stamp.replace(/[:.]/g, '-')}`;
  const content = `# Broker Harness session

## Meta
- Date: ${stamp}
- Developer: ${ROLE_LABEL[config.developer]} · Reviewer: ${ROLE_LABEL[config.reviewer]}
- Broker: BBARIT · Final approver: user
- Goal: ${config.goal || '(given live in the terminal)'}

## Structure
\`\`\`
Developer(${config.developer}) --git commit/diff--> [broker] --> Reviewer(${config.reviewer})
Reviewer --append ${REVIEW_FEED_REL}--> [broker] --> Developer
Both <-> docs/wiki (Karpathy Wiki) for durable knowledge
Final approval (merge/deploy) <- user only
\`\`\`

## Links
- [[index]]
- [[log]]
`;
  await invoke('write_file', { path: `${paths.decisionsDir}/${fileSlug}.md`, content }).catch(() => {});
}

/**
 * Start (or reuse) a broker pair. Opens 2 terminals, throws the briefing into both,
 * and shuttles git diffs to the reviewer and wiki review-feed updates to the developer.
 */
export async function startDevReviewPair(
  config: DevReviewPairConfig,
  openPair: OpenPair,
  emit: Emit,
  opts: StartOpts = {},
): Promise<DevReviewPairHandle | null> {
  const syncedGoal = await syncHarnessGoalWithWiki(config).catch(() => config.goal.trim());
  if (syncedGoal !== config.goal.trim()) {
    config = { ...config, goal: syncedGoal };
  }

  let repoDir = opts.managed?.repoDir ? normDir(opts.managed.repoDir) : (config.workDir ? normDir(config.workDir) : '');
  const branchSlug = nextBrokerBranchSlug();
  let branch: string | undefined = opts.managed?.branch;
  let worktreeDir: string | undefined = opts.managed?.worktreeDir ? normDir(opts.managed.worktreeDir) : undefined;
  let devWorkDir = worktreeDir || (config.workDir ? normDir(config.workDir) : repoDir);
  // P3-1: the commit the worktree started at. Per-round snapshots are real commits on the
  // detached HEAD, so the reviewed diff is computed against THIS base (cumulative), not
  // against the moving HEAD — otherwise a snapshot commit would make `git diff` empty.
  let baseSha = '';
  // Per-review-round checkpoint commits (function scope so the handle's rollback reaches them).
  const checkpoints: { round: number; sha: string; at: number }[] = [];
  let reviewRound = 0;
  // P1-6: the reviewer runs in a SEPARATE detached worktree (ISOLATED, not read-only — the
  // reviewer CAN edit/apply there, but those edits stay in its own worktree and are never
  // merged into the dev worktree). If that worktree can't be created, the reviewer FALLS BACK
  // to sharing the dev worktree, and the isolation degrades to a prompt-only boundary (the
  // reviewer is warned not to edit). Reviewer-facing channel files (brief, diff, code-graph,
  // review-feed) live here; the broker bridges the reviewer's verdict back to the dev worktree.
  let revWorkDir: string | undefined = opts.managed?.reviewerWorkDir ? normDir(opts.managed.reviewerWorkDir) : undefined;
  let createdReviewerWorktree = false;
  let createdManagedWorktree = false;

  // Progress-message language: read LIVE so a toggle takes effect on a running harness.
  const L = (): 'en' | 'ko' => config.getLang?.() || config.lang || 'en';
  const tt = (en: string, ko: string) => (L() === 'ko' ? ko : en);
  const reviewMode = normalizeReviewMode(config.reviewMode, config.reviewStep !== false);
  const reviewStepEnabled = reviewMode !== 'off';
  const browserReviewEnabled = config.browserReview !== false;
  const CYCLE_LABEL_KO: Record<CycleState, string> = {
    developing: '작업중',
    dev_done: '작업완료',
    reviewing: '리뷰중',
    review_done: '리뷰완료',
    addressing: '재작업중',
    approved: '승인됨',
    merging: '자동 병합 중',
    merged: '머지 완료',
    merge_failed: '병합 실패',
  };
  const cycleLabel = (c: CycleState) => (L() === 'ko' ? CYCLE_LABEL_KO[c] : CYCLE_LABELS[c]);

  let developerId: string | undefined;
  let reviewerId: string | undefined;

  if (opts.existing) {
    developerId = opts.existing.developerId;
    reviewerId = opts.existing.reviewerId;
    emit({ kind: 'info', message: 'Reusing existing 2 terminals (re-briefing).' });
  } else {
    if (config.isolate && repoDir) {
      let inside = await sh('git rev-parse --is-inside-work-tree 2>/dev/null || echo no', repoDir, 10).catch(() => 'no');
      if (!inside.includes('true')) {
        emit({ kind: 'error', message: '⚠️ No git repo found. Broker is running `git init` and committing ALL current files as a baseline (respecting node_modules/dist/build/.DS_Store). If this project holds local data or secrets, stop the harness and add a .gitignore first.' });
        await sh(
          `git init -q && (test -f .gitignore || printf 'node_modules/\\ndist/\\nbuild/\\n.DS_Store\\n' > .gitignore) && git add -A && git -c user.email=broker@local -c user.name=broker commit -q -m 'broker: initial baseline' || true`,
          repoDir,
          90,
        ).catch(() => {});
        inside = await sh('git rev-parse --is-inside-work-tree 2>/dev/null || echo no', repoDir, 10).catch(() => 'no');
      }
      if (inside.includes('true')) {
        // A git repo with ZERO commits has an unborn HEAD, and `git worktree add ... HEAD`
        // fails with "fatal: invalid reference: HEAD" — which silently blocked the "+ new
        // harness" button on freshly-`git init`-ed projects. Ensure a baseline commit exists
        // first (stage current files so the worktree is populated, matching the no-git init
        // path above). This writes one commit to the project's current branch.
        const headRef = (await sh('git rev-parse --verify HEAD 2>/dev/null || true', repoDir, 10).catch(() => '')).trim();
        if (!/^[0-9a-f]{7,}$/i.test(headRef)) {
          emit({ kind: 'error', message: '⚠️ Repository has no commits yet. Broker is committing ALL current files as a baseline so an isolated worktree can be made. If this project holds local data or secrets, stop the harness and add a .gitignore / make your own first commit.' });
          await sh(
            `(test -f .gitignore || printf 'node_modules/\\ndist/\\nbuild/\\n.DS_Store\\n' > .gitignore) && git add -A && git -c user.email=broker@local -c user.name=broker commit -q -m 'broker: initial baseline' --allow-empty || true`,
            repoDir,
            90,
          ).catch(() => {});
        }
        // `branch` stays only as a human-readable label for status messages — we do
        // NOT create a git branch. A detached-HEAD worktree gives the same isolation
        // without leaving a `broker/*` branch behind when teardown is missed (those
        // leaked into the hundreds). The harness's work lives on the worktree's HEAD;
        // auto-merge merges that commit by SHA (see autoMergeApproved).
        branch = `broker/${branchSlug}`;
        worktreeDir = `${repoDir}/.octo-tmp/broker-wt-${branchSlug}`;
        const revDir = `${repoDir}/.octo-tmp/broker-rev-${branchSlug}`;
        // P1-6: reviewer gets its OWN detached worktree (read-only review copy at HEAD).
        const wantReviewerWorktree = reviewStepEnabled && !revWorkDir;
        // [D-startup-parallel-worktrees] The developer + reviewer worktrees each check out
        // ~1k files (~2.4s on this repo) and are completely independent (both `--detach HEAD`
        // off repoDir), so create them CONCURRENTLY. git serializes only the short
        // worktree-registration step internally, so the heavy file checkouts overlap with no
        // index/worktree lock race (verified on Windows, repeated runs clean). This halves the
        // pre-terminal file I/O on harness start. baseSha is HEAD of that same commit, so read
        // it from repoDir in parallel rather than blocking on the dev checkout finishing.
        let devAddErr = '';
        let revAddErr = '';
        const devAddP = sh(`git worktree add --detach ${shellQuote(worktreeDir)} HEAD`, repoDir, 60)
          .then(() => true).catch((e) => { devAddErr = String(e); return false; });
        const revAddP = wantReviewerWorktree
          ? sh(`git worktree add --detach ${shellQuote(revDir)} HEAD`, repoDir, 60)
              .then(() => true).catch((e) => { revAddErr = String(e); return false; })
          : Promise.resolve(false);
        const baseShaP = sh('git rev-parse HEAD', repoDir, 15).then((s) => s.trim()).catch(() => '');
        const [devOk, revOk, sha] = await Promise.all([devAddP, revAddP, baseShaP]);
        if (!devOk) {
          // The dev worktree is REQUIRED. A reviewer worktree may have been created
          // concurrently — remove it so the bail-out path does not leak it.
          if (revOk) await invoke('git_worktree_remove', { worktreeDir: revDir }).catch(() => {});
          emit({ kind: 'error', message: `Could not create required isolated broker branch/worktree: ${devAddErr}` });
          return null;
        }
        createdManagedWorktree = true;
        devWorkDir = worktreeDir;
        baseSha = sha;
        emit({ kind: 'info', message: `Created isolated broker worktree (detached HEAD, no branch): ${worktreeDir}` });
        // Reviewer worktree is optional: if it failed, the harness still works — the reviewer
        // falls back to the dev worktree (degrades to the old prompt-only boundary).
        if (wantReviewerWorktree) {
          if (revOk) {
            revWorkDir = revDir;
            createdReviewerWorktree = true;
            emit({ kind: 'info', message: `Created isolated reviewer worktree (separate copy; reviewer edits stay isolated, never merged): ${revDir}` });
          } else {
            emit({ kind: 'error', message: `⚠️ Isolation degraded: a separate reviewer worktree could not be created (${revAddErr.slice(0, 80)}); the reviewer SHARES the developer worktree (prompt-only boundary — reviewer is told not to edit).` });
          }
        }
      } else {
        emit({ kind: 'error', message: 'Could not initialize git; broker harness requires a managed branch.' });
        return null;
      }
    }
    const ids = openPair(config.developer, config.reviewer, devWorkDir || undefined, revWorkDir || undefined);
    if (ids) { developerId = ids.developerId; reviewerId = ids.reviewerId; }
    emit({ kind: 'info', message: `Pair opened: developer=${ROLE_LABEL[config.developer]}, reviewer=${ROLE_LABEL[config.reviewer]}` });
  }

  if (!developerId || !reviewerId) {
    emit({ kind: 'error', message: 'Could not open terminals.' });
    if (createdManagedWorktree && worktreeDir) {
      await invoke('git_worktree_remove', { worktreeDir }).catch(() => {});
      if (branch && repoDir) {
        await invoke('git_delete_branch', { repoDir, branchName: branch }).catch(() => {});
      }
    }
    if (createdReviewerWorktree && revWorkDir) {
      await invoke('git_worktree_remove', { worktreeDir: revWorkDir }).catch(() => {});
    }
    return null;
  }
  const devId = developerId;
  const revId = reviewerId;
  if (config.goal.trim()) {
    await writeHarnessStandingGoal(devWorkDir || config.workDir, config.projectName, config.goal).catch(() => {});
    if (revWorkDir && revWorkDir !== devWorkDir) {
      await writeHarnessStandingGoal(revWorkDir, config.projectName, config.goal).catch(() => {});
    }
  }
  // P1-5: single relay chokepoint. ALL broker→terminal text goes through relay(), so
  // there is ONE place to gate/observe/extend writes (the manual-inject path was removed,
  // so this is auto-only). PTY-death is detected in the relay loop, where escalateToHuman
  // is in scope; relay() stays a thin never-drop writer so a transient never swallows a
  // real relay.
  const relay = (id: string, text: string): void => { throwToTerminal(id, text); };
  // PTY-death tracking: once a broker terminal's CLI is up (has a child process), if that
  // child later disappears the agent CLI exited — the harness cannot continue, so escalate
  // rather than relaying into a dead terminal forever.
  let devSawChild = false, revSawChild = false;
  let devDeadStreak = 0, revDeadStreak = 0;
  let devReadyForInput = !!opts.resume || !!opts.existing;
  let revReadyForInput = !!opts.resume || !!opts.existing;
  const emitBrokerStatus = (cycle: CycleState, reason: string, extra?: Partial<BrokerStatusSnapshot>) => {
    emit({ kind: 'status', message: reason, status: { cycle, cycleLabel: cycleLabel(cycle), reason, ...(extra || {}) } });
  };
  const waitForOneTerminal = async (id: string, role: DevReviewRole): Promise<boolean> => {
    const waitPromise = opts.waitForTerminalReady
      ? opts.waitForTerminalReady(id, role)
      : opts.waitForTerminalsReady
        ? opts.waitForTerminalsReady({ developerId: devId, reviewerId: revId })
        : Promise.resolve(true);
    return Promise.race([
      waitPromise.catch(() => false),
      sleep(120_000).then(() => false),
    ]);
  };

  emitBrokerStatus('developing', tt(
    'agent terminals opened - waiting for CLI readiness',
    '에이전트 터미널을 열었습니다 - CLI 준비를 기다리는 중',
  ));
  void recordToWiki(config).then(() => emit({ kind: 'info', message: tt('Recorded to Karpathy Wiki', 'Karpathy Wiki에 기록했습니다.') }));

  let stopped = false;
  // [D-perf-single-loop] Claim this developer terminal. Any older loop for the same
  // terminal sees its token superseded and exits on its next tick.
  const relayLoopToken = nextRelayLoopToken();
  relayLoopRegistry.set(devId, relayLoopToken);
  // UI control hooks INTO the running relay loop. The loop assigns these once its state
  // machine is live (setCycle + feed paths exist); they stay null until then so a too-early
  // UI click is a safe no-op (resolves false) rather than touching half-initialized state.
  let controlRequestRework: (() => Promise<boolean>) | null = null;
  let controlResetReviewFeed: (() => Promise<boolean>) | null = null;
  // Re-send the startup briefings after the frontend restarts the agent CLIs in place (same
  // worktree, same relay loop). The frontend kills + re-spawns the two terminals, then calls
  // this once they are ready again so the fresh CLIs know their roles and the in-progress work.
  let controlRebrief: (() => Promise<boolean>) | null = null;

  (async () => {
    const restoredClosedStatus = opts.restoredStatus?.cycle === 'merged' || opts.restoredStatus?.cycle === 'merge_failed'
      ? opts.restoredStatus
      : null;
    // Write each full brief to a wiki file, then throw only a SHORT one-line nudge
    // into the terminal pointing at it. Pasting the whole (large) brief would pile
    // up as unsubmitted "[Pasted Content]"; a short line submits cleanly and the
    // brief lives in the wiki (git+wiki channel).
    // Two-tier wiki: project wiki first, global wiki as fallback. Ensure the global
    // (shared) wiki scaffold exists and tell the agents its absolute path.
    let globalWikiDir: string | undefined;
    if (config.globalNotesDir) {
      try {
        await ensureSharedWikiScaffold(invoke, config.globalNotesDir, config.projectName || 'global');
        globalWikiDir = getSharedWikiPaths(config.globalNotesDir).wikiDir;
      } catch { /* global wiki optional */ }
    }
    const devBriefRel = 'docs/wiki/decisions/broker-brief-developer.md';
    const revBriefRel = 'docs/wiki/decisions/broker-brief-reviewer.md';
    const devBrief = workflowBriefing('developer', config.reviewer, config.developer, config.reviewer, config.goal, globalWikiDir, config.otherProjects, L(), reviewStepEnabled, reviewMode, browserReviewEnabled);
    const revBrief = workflowBriefing('reviewer', config.developer, config.developer, config.reviewer, config.goal, globalWikiDir, config.otherProjects, L(), reviewStepEnabled, reviewMode, browserReviewEnabled);
    let reviewerStandbyBriefed = false;
    let reviewerStandbySends = 0;
    let lastReviewerStandbyAt = 0;
    // Raw sender: emits the standby text and records send count + timestamp so the relay
    // loop can re-send a spaced delivery backstop if the first throw was lost (see
    // shouldResendReviewerStandby). NOT latched here — the latch lives in briefReviewerStandby.
    const sendReviewerStandbyMessage = () => {
      if (stopped) return;
      reviewerStandbySends += 1;
      lastReviewerStandbyAt = Date.now();
      if (!reviewStepEnabled) {
        relay(revId, `${RELAY_MARK} ${tt(
          `This terminal is the REVIEW AGENT. Review step is disabled for this harness. Stand by; do not read files or analyze anything unless the broker explicitly asks for emergency human-risk review. Do not edit source code.`,
          `이 터미널은 검토 에이전트입니다. 이 하네스는 리뷰 단계가 꺼져 있습니다. 브로커가 긴급 리뷰를 요청하기 전까지 파일을 읽거나 분석하지 말고 대기하세요. 소스 코드는 수정하지 마세요.`,
        )}`);
        return;
      }
      relay(revId, `${RELAY_MARK} ${tt(
        `This terminal is the REVIEW AGENT. Stand by only. Do not read files, inspect the repo, or review yet. Wait until the broker sends "Review requested"; then read ${revBriefRel} and the diff. Review only; do not edit source code.`,
        `이 터미널은 검토 에이전트입니다. 지금은 대기만 하세요. 아직 파일을 읽거나 저장소를 검사하거나 리뷰하지 마세요. 브로커가 "Review requested"를 보내면 그때 ${revBriefRel}와 diff를 읽으세요. 리뷰만 하고 소스 코드는 수정하지 마세요.`,
      )}`);
    };
    const briefReviewerStandby = () => {
      if (stopped || reviewerStandbyBriefed) return;
      reviewerStandbyBriefed = true;
      sendReviewerStandbyMessage();
    };
    const watchReviewerReadyForStandby = () => {
      void (async () => {
        while (!stopped && !revReadyForInput && !reviewerStandbyBriefed) {
          const ready = await waitForOneTerminal(revId, config.reviewer);
          if (stopped) return;
          if (ready) {
            revReadyForInput = true;
            // Settle before the standby write, mirroring the dev briefing's POST_READY_SETTLE_MS.
            // Idle-readiness can flip one render frame before the CLI finishes painting its input
            // box; throwing immediately (as this path used to) risked the standby line landing in
            // that frame and being lost. (line-1018 path is already post-settle.)
            await sleep(POST_READY_SETTLE_MS);
            if (stopped) return;
            briefReviewerStandby();
            emit({ kind: 'info', message: tt('Review agent became ready and received standby instructions.', '검토 에이전트가 준비되어 대기 지시를 전달했습니다.') });
            return;
          }
          await sleep(3000);
        }
        if (!stopped && revReadyForInput) briefReviewerStandby();
      })();
    };
    // Reviewer-facing files live in the reviewer's own worktree (P1-6). Falls back to
    // the dev worktree when no separate reviewer worktree was created.
    const reviewerDir = revWorkDir || devWorkDir;
    if (devWorkDir) {
      // Worktree deps note: the broker worktree lives INSIDE the repo (.octo-tmp/...),
      // so Node/npm/tsc resolve the repo-root node_modules by walking up — the developer
      // can build/typecheck/test normally without any dependency install. (We deliberately
      // do NOT junction node_modules: a junction would let worktree teardown delete the
      // real repo's node_modules.) Point the agent at the repo root for non-Node envs.
      const depsNote = (repoDir && devWorkDir !== repoDir)
        ? `\n\n[WORKSPACE & DEPENDENCIES] Your worktree is ${devWorkDir}, located INSIDE the project repo at ${repoDir}. Installed dependencies live at the repo root and resolve automatically (Node/npm/tsc walk up to ${repoDir}/node_modules), so build, typecheck, and tests work normally here — run them to gather the evidence the reviewer requires. For environments that are NOT auto-resolved (e.g. a Python virtualenv), reference them under ${repoDir} by absolute path.`
        : '';
      await invoke('write_file', { path: `${devWorkDir}/${devBriefRel}`, content: devBrief + depsNote }).catch(() => {});
      // Reviewer brief + code-graph go into the reviewer worktree so the reviewer reads
      // them where it actually runs. When isolated, explain that `git diff` is empty by
      // design and the developer's changes live in the patch file.
      const reviewerWorktreeNote = (reviewerDir !== devWorkDir)
        ? `\n\n[YOUR WORKTREE — ISOLATED REVIEW COPY] You run in a SEPARATE git worktree checked out at the base commit. It is NOT read-only — you MAY edit/\`git apply ${DIFF_FILE_REL}\` here — but anything you change stays in THIS worktree and is NEVER merged into the developer's work. The developer's changes are not in your working tree, so \`git diff\` here shows nothing — that is expected. Read the developer's changes from ${DIFF_FILE_REL} (a unified patch). Write your verdict to ${REVIEW_FEED_REL} as usual.`
        : `\n\n[SHARED WORKTREE — ISOLATION DEGRADED] A separate reviewer worktree could not be created, so you SHARE the developer's working tree. Do NOT edit source files here (your edits WOULD land in the merged result). Review the patch in ${DIFF_FILE_REL} only and write your verdict to ${REVIEW_FEED_REL}.`;
      await invoke('write_file', { path: `${reviewerDir}/${revBriefRel}`, content: revBrief + reviewerWorktreeNote }).catch(() => {});
      // Drop the code-intelligence CLI into BOTH worktrees so each agent can run
      // structural queries (arch / defs / callers / impact) from its terminal.
      await invoke('write_file', { path: `${devWorkDir}/${CODE_GRAPH_REL}`, content: codeGraphCliSource() }).catch(() => {});
      if (reviewerDir !== devWorkDir) {
        await invoke('write_file', { path: `${reviewerDir}/${CODE_GRAPH_REL}`, content: codeGraphCliSource() }).catch(() => {});
      }
    }
    if (restoredClosedStatus) {
      const restoredMessage = restoredClosedStatus.cycle === 'merge_failed'
        ? tt('Restored blocked broker state; terminals stay attached for inspection and follow-up.', '차단된 브로커 상태를 복구했습니다. 터미널은 확인과 후속 작업을 위해 연결된 상태로 유지됩니다.')
        : tt('Restored completed broker state; terminals stay attached for follow-up work.', '완료된 브로커 상태를 복구했습니다. 터미널은 후속 작업을 위해 연결된 상태로 유지됩니다.');
      emit({ kind: 'info', message: restoredMessage });
    }
    if (opts.resume) {
      setTimeout(() => {
        submitTerminalInput(devId);
        submitTerminalInput(revId);
      }, 1200);
      // Resume after reload: terminals + agents are already running and briefed.
      // Don't wait or re-throw the briefing nudges (that would spam the agents);
      // just continue straight to the relay loop below.
      emit({ kind: 'info', message: tt('Broker relay resumed after reload.', '새로고침 후 브로커 릴레이를 복구했습니다.') });
    } else {
      // Brief the reviewer (standby) IN PARALLEL — its briefing must NOT be held hostage
      // by the developer's CLI startup. The previous order waited for the dev CLI first,
      // so a slow/flaky dev CLI left the reviewer un-briefed forever. Start the reviewer
      // readiness watcher BEFORE the dev wait so both get briefed independently.
      if (!revReadyForInput && !opts.waitForTerminalReady && !opts.waitForTerminalsReady) {
        revReadyForInput = true;
      }
      if (!revReadyForInput) {
        watchReviewerReadyForStandby();
        emit({ kind: 'info', message: tt(
          'Review-agent CLI is not ready yet. Broker will brief it the moment it is ready, independently of the dev agent.',
          '검토 에이전트 CLI가 아직 준비되지 않았습니다. 개발 에이전트와 무관하게 준비되는 즉시 브리핑합니다.',
        ) });
      }
      // Let the agent CLIs boot, then throw short nudges. Full briefs live in
      // the wiki; pasting them into CLIs creates large "[Pasted Content]" blocks.
      while (!stopped && !devReadyForInput) {
        devReadyForInput = await waitForOneTerminal(devId, config.developer);
        if (!devReadyForInput) {
          const reason = tt(
            'Dev-agent CLI is still starting. Broker is waiting and will not inject briefing text into a raw shell.',
            '개발 에이전트 CLI가 아직 시작 중입니다. 브로커는 계속 기다리며 일반 셸에는 브리핑 문장을 넣지 않습니다.',
          );
          emit({ kind: 'info', message: reason });
          emitBrokerStatus('developing', reason);
          await sleep(3000);
        }
      }
      if (stopped) return;
      emitBrokerStatus('developing', tt(
        'dev agent ready - sending startup instructions',
        '개발 에이전트 준비 완료 - 시작 지시 전달 중',
      ));
      // [D-startup-settle] waitForOneTerminal already gates on idle-debounce readiness
      // (the agent CLI has a running child process AND the PTY has been quiet ≥1.5s), so
      // the CLI is demonstrably booted and interactive by the time we get here. The old
      // fixed 6s+1.5s settle predates that idle gate — it was belt-and-suspenders from the
      // banner-regex era and is now ~7.5s of dead time on every harness start. Trim to a
      // short safety margin (cost: a slightly higher chance of landing in a final render
      // frame on an unusually slow CLI; escape hatch: bump POST_READY_SETTLE_MS back up).
      await sleep(POST_READY_SETTLE_MS);
      if (stopped) return;
      if (revReadyForInput) briefReviewerStandby();
      await sleep(INTER_BRIEF_GAP_MS);
      relay(devId, `${RELAY_MARK} ${tt(
        `This terminal is the DEV AGENT. The human will give the task here. Implement, test, update docs/wiki, then you MUST append exactly one line to ${DEV_FEED_REL}: DONE: <summary>. Do not only say done in chat; the broker starts review only after that DONE line exists. Read ${devBriefRel} for details.`,
        `이 터미널은 개발 에이전트입니다. 사람이 여기서 작업을 주면 구현·테스트·docs/wiki 갱신 후 반드시 ${DEV_FEED_REL}에 DONE: <요약> 한 줄을 적으세요. 채팅에 완료라고 말하는 것만으로는 부족하며, 브로커는 그 DONE 줄이 있어야 검토를 시작합니다. 자세한 규칙은 ${devBriefRel}을 읽으세요.`,
      )}`);
      emitBrokerStatus('developing', tt(
        'broker started - waiting for developer DONE',
        '브로커 시작 - 개발 에이전트 DONE 대기 중',
      ));
      emit({ kind: 'info', message: reviewerStandbyBriefed
        ? tt('Both agents received startup instructions (git + wiki channel).', '두 에이전트에게 시작 지침을 전달했습니다. (git + wiki 채널)')
        : tt('Dev agent received startup instructions; review agent will be instructed on first review request.', '개발 에이전트에게 시작 지침을 전달했습니다. 검토 에이전트는 첫 검토 요청 시점에 지시합니다.') });
    }

    if (!config.autoRelay || !devWorkDir) return;

    // If the project has no git, the broker SETS UP git (so diff-based review works)
    // and announces it in the developer terminal first.
    const isRepo = await sh('git rev-parse --is-inside-work-tree 2>/dev/null || echo no', devWorkDir, 10).catch(() => 'no');
    if (!isRepo.includes('true')) {
      emit({ kind: 'info', message: tt('No git repo found; broker is initializing git.', 'git 저장소가 없어 브로커가 git을 초기화합니다.') });
      relay(devId, `${RELAY_MARK} No git repo found; broker is initializing git so diff-based review can work.`);
      await sh(
        `git init -q && (grep -qsF 'node_modules' .gitignore || printf 'node_modules/\ndist/\nbuild/\n.DS_Store\n' >> .gitignore) && git add -A && git -c user.email=broker@local -c user.name=broker commit -q -m 'broker: initial baseline' || true`,
        devWorkDir,
        90,
      ).catch(() => {});
      relay(devId, `${RELAY_MARK} Git initialized. Future diffs will be reviewed automatically only after you append "DONE: <summary>" to ${DEV_FEED_REL}.`);
    }

    // Harden: keep the broker's own coordination files out of the developer's git diff.
    // Otherwise broker-brief-*/broker-harness-*/broker-status/broker-review-feed.md show up
    // as changes and the reviewer keeps flagging "scope", so the loop never converges on the
    // actual task.
    //
    // The .gitignore edit runs through the pure upgradeBrokerGitignore() (read → transform →
    // write), NOT a shell append. A plain append could not REMOVE the legacy broad
    // `broker-harness-*.md` line, and leaving it in place keeps durable notes like
    // docs/wiki/decisions/broker-harness-source-audit-*.md (linked from docs/wiki/index.md)
    // ignored — .gitignore is OR-matched, so the broad line still wins next to the narrow one.
    // Doing the transform in TS makes it unit-testable and lets us actively clean the legacy
    // line. Once the broad line is gone, the round's `git add -A` checkpoint re-tracks any
    // durable note it had untracked.
    try {
      const gitignorePath = `${devWorkDir}/.gitignore`;
      const existingGitignore = (await invoke<string>('read_file', { path: gitignorePath }).catch(() => '')) || '';
      const upgraded = upgradeBrokerGitignore(existingGitignore);
      if (upgraded !== existingGitignore) {
        await invoke('write_file', { path: gitignorePath, content: upgraded }).catch(() => {});
      }
    } catch { /* best-effort: a missing/locked .gitignore must not block the harness */ }
    // Untrack already-committed coordination files (an index op, so it stays in git). Narrowed
    // harness pattern + broker-status so durable broker-harness-* notes are preserved.
    await sh(
      `git rm --cached -rq --ignore-unmatch '.broker' 'docs/wiki/decisions/broker-brief-*.md' 'docs/wiki/decisions/broker-harness-[0-9]*.md' 'docs/wiki/decisions/broker-status.md' 'docs/wiki/decisions/broker-*-feed.md' 2>/dev/null; true`,
      devWorkDir,
      20,
    ).catch(() => {});

    // Reviewer writes its verdict in its OWN worktree; the broker polls it here and
    // bridges REWORK content back to the dev worktree so the developer can read it.
    const reviewFeedPath = `${reviewerDir}/${REVIEW_FEED_REL}`;
    const devReviewFeedPath = `${devWorkDir}/${REVIEW_FEED_REL}`;
    // Reviews are triggered by the developer's DONE signal. The broker does not guess
    // completion from a quiet git diff because the developer must finish tests/wiki first.
    // Capture the reviewer's existing feed length so we only relay NEW entries.
    const existingReviewFeed = (await invoke<string>('read_file', { path: reviewFeedPath }).catch(() => '')) || '';
    let lastFeedLen = existingReviewFeed.length;
    // Developer completion feed: a new DONE line means this unit is ready for review.
    const devFeedPath = `${devWorkDir}/${DEV_FEED_REL}`;
    const existingDevFeed = (await invoke<string>('read_file', { path: devFeedPath }).catch(() => '')) || '';
    const restoredReviewDecision = opts.resume && !restoredClosedStatus ? reviewDecisionFromText(existingReviewFeed) : null;
    const restoredReviewedDiff = opts.resume
      ? extractBrokerReviewedDiff((await invoke<string>('read_file', { path: `${reviewerDir}/${DIFF_FILE_REL}` }).catch(() => '')) || '')
      : '';
    const restoredPendingReview = Boolean(opts.resume && !restoredClosedStatus && !restoredReviewDecision && restoredReviewedDiff);
    const replayDoneFrom = opts.resume && !restoredClosedStatus && restoredReviewDecision !== 'approved' && !restoredPendingReview
      ? latestDoneLineStart(existingDevFeed)
      : -1;
    let lastDevFeedLen = replayDoneFrom >= 0 ? replayDoneFrom : existingDevFeed.length;

    // Relay only SHORT nudges; never paste the full diff/review. Pasting large
    // blocks repeatedly piles up unsubmitted "[Pasted Content]" entries in the
    // agent's input. A short one-line nudge submits cleanly, and the agent reads
    // the actual diff (via `git diff`) / review (the wiki file) itself.
    let lastNudgeDevAt = 0;
    let lastNudgeRevAt = restoredPendingReview ? Date.now() : 0;
    const MIN_NUDGE_GAP = 120000; // don't nudge the same direction more than once per 2 min
    // Reviewer learning is requested only as a lightweight follow-up to an actual
    // review result. A periodic background loop burns reviewer tokens while no
    // product work changed.
    // Keep the coordination feeds from growing into one giant file over months. When a
    // feed gets large, archive everything but the recent tail to a *-archive.md and
    // truncate the live feed so neither the broker nor an agent ever re-reads a huge
    // document. lastFeedLen/lastDevFeedLen are adjusted by the bytes removed.
    let lastRotateAt = Date.now();
    const ROTATE_GAP = 300000;     // 5 min
    const FEED_MAX = 48000, FEED_KEEP = 8000;
    const rotateFeed = async (path: string): Promise<number> => {
      const cur = (await invoke<string>('read_file', { path }).catch(() => '')) || '';
      const { archive, live, removed } = trimFeedForArchive(cur, FEED_MAX, FEED_KEEP);
      if (!removed) return 0;
      const archivePath = path.replace(/\.md$/, '') + '-archive.md';
      const archiveName = archivePath.split(/[\\/]/).pop() || 'archive';
      const prev = (await invoke<string>('read_file', { path: archivePath }).catch(() => '')) || '';
      await invoke('write_file', { path: archivePath, content: prev + archive }).catch(() => {});
      // P2-3: leave a breadcrumb at the top of the truncated feed so the agent sees that
      // older entries were ARCHIVED (not silently dropped) and where to find them — avoids
      // the "context jump" of a feed that suddenly lost its history. (Cline contextTruncationNotice)
      const notice = `> [BROKER] Older feed entries were archived to ${archiveName}; this live feed was truncated. Read that file for the full history.\n\n`;
      await invoke('write_file', { path, content: notice + live }).catch(() => {});
      // Return the NET chars removed (archived minus the breadcrumb we prepended) so the
      // caller's read-position accounting stays correct and the broker never re-reads the
      // notice as if it were new reviewer/dev feedback.
      return Math.max(0, removed - notice.length);
    };
    // Source-growth baseline (for the mechanical broker's growth/progress judgement).
    const baseline: SourceBaseline = await snapshotSource(devWorkDir);
    // P3-1: snapshot the state being reviewed as a real commit on the detached HEAD
    // (Cline checkpoints). checkpoints[]/baseSha live at function scope so the handle's
    // rollback can reach them. .broker/ is gitignored → checkpoints.json never enters
    // the reviewed/merged diff.
    const snapshotRound = async (): Promise<void> => {
      if (!baseSha || !devWorkDir) return; // snapshots only for fresh isolate harnesses
      reviewRound += 1;
      try {
        await sh(`git add -A && git -c user.email=broker@local -c user.name=broker commit -q --allow-empty --no-verify -m ${shellQuote(`broker-checkpoint round=${reviewRound}`)}`, devWorkDir, 60);
        const sha = (await sh('git rev-parse HEAD', devWorkDir, 20)).trim();
        if (sha) {
          checkpoints.push({ round: reviewRound, sha, at: Date.now() });
          await invoke('write_file', { path: `${devWorkDir}/.broker/checkpoints.json`, content: JSON.stringify({ baseSha, checkpoints }, null, 2) }).catch(() => {});
          emit({ kind: 'info', message: tt(`Checkpoint saved (round ${reviewRound}).`, `체크포인트 저장 (라운드 ${reviewRound}).`) });
        }
      } catch (e) {
        emit({ kind: 'info', message: `Checkpoint snapshot skipped: ${String(e).slice(0, 80)}` });
      }
    };
    let firstReview = true;
    // Until the developer has signalled DONE at least once (i.e. real work happened), the
    // broker stays QUIET: no periodic self-improvement nudges, no re-nudges. This
    // stops a freshly-started, task-less harness from churning the agents in a loop.
    let reviewedOnce = restoredPendingReview;
    // The diff last sent for review. A new DONE with the SAME diff must NOT re-review
    // (otherwise an unchanged/lingering git diff would loop the reviewer forever).
    let lastReviewedDiff = restoredReviewedDiff;
    // Continuous two-way protocol: the broker watches BOTH sides and confirms each
    // command was acted on. pendingRev* = we asked the reviewer and await its feedback;
    // pendingDev* = we relayed feedback and await the developer's next change.
    let pendingRevSince = restoredPendingReview ? Date.now() : 0;
    let pendingDevSince = 0;
    let reworkOpen = restoredReviewDecision === 'rework';
    // Patience tuned so the broker does NOT give up on a reviewer that is still working —
    // a careful review (incl. the BBARIT-Browser end-to-end test) legitimately takes a
    // while. Earlier values (5 min ACK, 4 stalls ≈ 20 min) escalated before the reviewer
    // finished; raised to ~10 min ACK and 8 stalls ≈ 80+ min before declaring a stall.
    const ACK_WINDOW = 600000; // 10 min with no response: re-nudge that side
    let stalls = 0;            // consecutive re-nudges without convergence: escalate to human
    // P1-4 escalation (Cline loop-detection): identical REWORK repeated or stall ceiling
    // hit -> HARD STOP the relay and surface a human decision, instead of nudging forever.
    const STALL_CEILING = 8;       // re-nudges with no convergence (was 4 — too hasty)
    const REWORK_REPEAT_LIMIT = 3; // identical REWORK bodies in a row
    // PTY-death tolerance: consecutive child-less probes (~6s apart) before declaring the
    // agent CLI dead and halting (차단). Raised 3 → 6: agents legitimately go child-less for
    // a few seconds (between subprocess spawns, an internal CLI restart, a tool call), and
    // a 3-streak (~18s) blocked harnesses far too eagerly. 6 (~40-60s) still catches a real
    // exit but no longer trips on a working agent.
    const PTY_DEAD_STREAK = 6;
    let lastReworkSig = '';
    let reworkRepeatCount = 0;
    let escalated = false;
    // Dev-review CYCLE state: the broker reads this and mediates; the UI shows it.
    // `as CycleState` keeps the type wide: it's reassigned inside setCycle (a closure),
    // which TS can't see, so without this it narrows to the literal 'developing' and
    // later `cycle !== 'reviewing'` comparisons fail to type-check.
    let cycle = 'developing' as CycleState;
    // When the CURRENT cycle state was entered (not when its reason last refreshed) —
    // powers the status panel's "in this state for Xm" elapsed chip.
    let cycleEnteredAt = Date.now();
    let lastMetricsMd = '';
    // Keep the latest mechanical metrics so every status emit carries them.
    let lastExt: Partial<BrokerStatusSnapshot> = {};
    const setCycle = (next: CycleState, reason: string, extra?: Partial<BrokerStatusSnapshot>) => {
      const nextStatus = { cycle: next, cycleLabel: cycleLabel(next), reason, ...lastExt, ...(extra || {}) };
      const allowNewDoneCycle = shouldReopenMergedCycleForDone(cycle, next, reason);
      if (!allowNewDoneCycle && !shouldAcceptBrokerStatusUpdate({ cycle, cycleLabel: cycleLabel(cycle), reason: '', ...lastExt }, nextStatus)) return;
      if (next !== cycle) cycleEnteredAt = Date.now();
      cycle = next;
      if (extra) lastExt = { ...lastExt, ...extra };
      emit({ kind: 'status', message: reason, status: { cycle, cycleLabel: cycleLabel(cycle), reason, ...lastExt, at: cycleEnteredAt } });
      void invoke('write_file', {
        path: `${devWorkDir}/${STATUS_REL}`,
        content: `# Broker Status\n\nCurrent: **${cycleLabel(cycle)}** - ${reason}\n\n## Cycle\n${cycleTable(cycle)}\n\n${lastMetricsMd}`,
      }).catch(() => {});
    };
    // UI control hooks (assigned now that setCycle + the cycle state vars exist). Exposed on
    // the handle; the modal buttons call them. They mutate the SAME loop state the relay uses,
    // so they take effect on the very next poll without restarting the harness.
    //
    // Both controls cover ONLY the dev↔review loop (developing/reviewing/addressing/…). Once a
    // review is APPROVED the broker has already queued autoMergeApproved() (a one-way door), and
    // setCycle would be rejected by shouldAcceptBrokerStatusUpdate for approved→earlier anyway —
    // so a "reset" there could not cancel the in-flight merge and would only desync state. Guard
    // both against the merge phase (the modal also hides the buttons there; this is defense in
    // depth against a click that races the APPROVED transition).
    // Shared predicate (also used by the modal hide + the App-side Restart-agents guard) so all
    // four guards agree. The loop has no lifecycle, so this reduces to the merge-phase check.
    const inMergePhase = (): boolean => !isHarnessInReviewLoop(cycle);
    controlRequestRework = async (): Promise<boolean> => {
      if (stopped) return false;
      if (inMergePhase()) {
        emit({ kind: 'info', message: tt(
          'Re-request rework is unavailable after approval/merge.',
          '승인·병합 단계에서는 재작업 재요청을 사용할 수 없습니다.',
        ) });
        return false;
      }
      // Re-send the latest review feedback to the developer and move back to 'addressing'.
      // pendingDevSince arms the ACK watch so a missed nudge is re-surfaced like any other.
      reworkOpen = true;
      reviewedOnce = true;
      pendingDevSince = Date.now();
      pendingRevSince = 0;
      setCycle('addressing', tt(
        'Manual rework re-request - developer must re-apply the latest review feedback',
        '수동 재작업 재요청 - 개발자가 최신 리뷰 피드백을 다시 반영해야 합니다',
      ));
      relay(devId, `${RELAY_MARK} ${tt(
        `Manual REWORK re-request from the human. Re-open ${REVIEW_FEED_REL}, apply the latest REWORK exactly, change the code/tests, then append a new DONE to ${DEV_FEED_REL}.`,
        `사람이 재작업을 다시 요청했습니다. ${REVIEW_FEED_REL}를 다시 열어 최신 REWORK를 정확히 반영하고 코드/테스트를 수정한 뒤 ${DEV_FEED_REL}에 새 DONE을 적으세요.`,
      )}`);
      emit({ kind: 'info', message: tt('Re-sent the latest review feedback to the developer.', '최신 리뷰 피드백을 개발자에게 다시 전달했습니다.') });
      return true;
    };
    controlResetReviewFeed = async (): Promise<boolean> => {
      if (stopped) return false;
      if (inMergePhase()) {
        emit({ kind: 'info', message: tt(
          'Reset review is unavailable after approval/merge; it cannot cancel an in-flight merge.',
          '승인·병합 단계에서는 리뷰 초기화를 사용할 수 없습니다. 진행 중인 병합은 취소할 수 없습니다.',
        ) });
        return false;
      }
      // Clear the round's verdict + reset review-cycle bookkeeping so a stuck REWORK no longer
      // gates the loop. Only valid in the dev↔review loop (guarded above). Touches NO code and
      // NO diff. lastFeedLen resets to 0 so the
      // now-empty feed is not mis-read, and the repeat-detector is cleared so the next genuine
      // REWORK is not counted as a repeat of the cleared one.
      reworkOpen = false;
      pendingRevSince = 0;
      pendingDevSince = 0;
      lastReworkSig = '';
      reworkRepeatCount = 0;
      lastFeedLen = 0;
      await invoke('write_file', { path: reviewFeedPath, content: '' }).catch(() => {});
      if (devReviewFeedPath !== reviewFeedPath) {
        await invoke('write_file', { path: devReviewFeedPath, content: '' }).catch(() => {});
      }
      setCycle('developing', tt(
        'Review feed reset - cycle returned to developing',
        '리뷰 피드백 초기화 - 사이클을 작업중으로 되돌림',
      ));
      emit({ kind: 'info', message: tt('Cleared the review feed and reset the review cycle.', '리뷰 피드백을 비우고 리뷰 사이클을 초기화했습니다.') });
      return true;
    };
    controlRebrief = async (): Promise<boolean> => {
      if (stopped) return false;
      // The frontend calls this ONLY after both restarted CLIs are verified ready
      // (performAgentRestart gates rebrief on devReady && revReady). So mark BOTH readiness
      // latches ready and re-brief both. Forcing revReadyForInput is required: a harness restarted
      // before the reviewer was ever initially ready would otherwise have revReadyForInput=false
      // and re-brief only the dev. Resetting reviewerStandbyBriefed lets briefReviewerStandby run.
      devReadyForInput = true;
      revReadyForInput = true;
      reviewerStandbyBriefed = false;
      briefReviewerStandby();
      relay(devId, `${RELAY_MARK} ${tt(
        `This terminal is the DEV AGENT (just restarted). The task and your changes are NOT lost — this worktree and its git history are intact. FIRST read ${devBriefRel}, the project wiki (docs/wiki), and the recent git log/diff to recover the in-progress work, then CONTINUE it; do not restart from scratch. When the unit is done, append a new DONE line to ${DEV_FEED_REL}.`,
        `이 터미널은 개발 에이전트입니다(방금 재기동됨). 작업과 변경은 사라지지 않았습니다 — 이 워크트리와 git 기록은 그대로입니다. 먼저 ${devBriefRel}, 프로젝트 위키(docs/wiki), 최근 git log/diff를 읽어 진행 중이던 작업을 복구한 뒤 이어서 진행하세요. 처음부터 다시 시작하지 마세요. 한 단위가 끝나면 ${DEV_FEED_REL}에 새 DONE 줄을 적으세요.`,
      )}`);
      emit({ kind: 'info', message: tt('Re-briefed the restarted agents.', '재기동된 에이전트를 다시 브리핑했습니다.') });
      return true;
    };
    // P1-4: hard stop + human decision point (Cline resolveMistakeLimitDecision). Instead
    // of nudging forever, halt the relay and tell the user; they restart or stop the harness.
    const escalateToHuman = (reason: string) => {
      if (escalated) return;
      escalated = true;
      setCycle('merge_failed', tt(`Broker halted - human decision needed: ${reason}`, `브로커 정지 - 사람 결정 필요: ${reason}`));
      emit({ kind: 'error', message: tt(`Broker halted (needs human decision): ${reason}. Restart the harness to continue, or stop it.`, `브로커 정지 (사람 결정 필요): ${reason}. 계속하려면 하네스를 재시작하거나 중단하세요.`) });
      stopped = true; // ends the while(!stopped) relay loop
    };
    setCycle(
      restoredClosedStatus?.cycle || (restoredReviewDecision === 'approved' ? 'approved' : restoredReviewDecision === 'rework' ? 'addressing' : restoredPendingReview ? 'reviewing' : 'developing'),
      restoredClosedStatus?.reason || (restoredReviewDecision === 'approved'
        ? `restored APPROVED review - auto merge queued for ${branch || '(unknown branch)'}`
        : restoredReviewDecision === 'rework'
          ? `restored REWORK review - waiting for developer fix in ${REVIEW_FEED_REL}`
          : restoredPendingReview
            ? `restored pending review - waiting for reviewer feedback in ${REVIEW_FEED_REL}`
        : tt('broker started - waiting for developer DONE', '브로커 시작 - 개발자 DONE 대기 중')),
      restoredClosedStatus || undefined,
    );
    if (restoredPendingReview) {
      relay(revId, tt(
        `${RELAY_MARK} Review still pending after reload. Open ${DIFF_FILE_REL} yourself (or run \`git diff\`) and append "APPROVED" OR "REWORK: ..." to ${REVIEW_FEED_REL}.`,
        `${RELAY_MARK} 새로고침 후에도 리뷰가 대기 중입니다. 직접 ${DIFF_FILE_REL}을 열거나 \`git diff\`를 실행한 뒤 ${REVIEW_FEED_REL}에 "APPROVED" 또는 "REWORK: ..."를 적으세요.`,
      ));
      emit({ kind: 'relay', message: tt('Reviewer re-nudged for restored pending review', '복구된 리뷰 대기 상태를 리뷰어에게 다시 알렸습니다.') });
    }
    let autoMergeStarted = false;
    const autoMergeApproved = async (): Promise<void> => {
      if (autoMergeStarted) return;
      autoMergeStarted = true;
      if (!branch || !worktreeDir || !repoDir) {
        const reason = 'reviewer approved, but no broker-managed branch/worktree is available for auto merge';
        setCycle('merge_failed', reason);
        emit({ kind: 'error', message: `Auto merge blocked: ${reason}` });
        relay(devId, `${RELAY_MARK} Reviewer APPROVED, but broker cannot auto-merge because this session has no managed branch/worktree. Human attention needed.`);
        return;
      }
      const commitMessage = `broker: ${config.goal || branch || 'session'}`;
      try {
        setCycle('merging', `reviewer approved - auto commit/merge started for ${branch}`);
        emit({ kind: 'info', message: `Auto commit/merge started for ${branch}` });
        relay(devId, `${RELAY_MARK} Reviewer APPROVED. Broker is auto-committing and merging branch ${branch}; do not type merge commands.`);
        relay(revId, `${RELAY_MARK} APPROVED received. Broker is auto-committing and merging branch ${branch}.`);
        const statusAfterCommit = (await sh(
          `git add -A && if ! git diff --cached --quiet; then git -c user.email=broker@local -c user.name=broker commit -q -m ${shellQuote(commitMessage)}; fi && git status --porcelain`,
          worktreeDir,
          90,
        )).trim();
        if (statusAfterCommit) {
          throw new Error(`worktree not clean after commit:\n${statusAfterCommit}`);
        }
        // The worktree is on a detached HEAD (no branch), so merge its HEAD commit
        // by SHA. `git merge <sha> --no-edit` accepts a commit-ish just like a branch.
        const mergeSha = (await sh('git rev-parse HEAD', worktreeDir, 20)).trim();
        if (!mergeSha) throw new Error('could not resolve worktree HEAD commit for merge');
        const mergeResult = await invoke<string>('git_merge_branch', { repoDir, branchName: mergeSha });
        // Push-on-merge is an EXPLICIT, live-read setting (default on). When off, the broker
        // merges LOCALLY ONLY and never touches the remote. When on, it pushes best-effort: a
        // push failure (no remote, auth, non-fast-forward) must NOT flip a successful LOCAL
        // merge into "failed" — but it IS surfaced as a distinct warning so "merged locally,
        // push failed" is never silently hidden behind a plain "merged" state.
        const pushOnMerge = config.getPushOnMerge ? config.getPushOnMerge() : true;
        let pushNote = '';
        if (!pushOnMerge) {
          pushNote = tt(' (local merge only; push disabled)', ' (로컬 머지만; push 비활성)');
        } else {
          try {
            await sh('git push', repoDir, 120);
            pushNote = tt(' + pushed to remote', ' + 원격 push 완료');
          } catch (e) {
            const detail = String(e instanceof Error ? e.message : e).slice(0, 120);
            pushNote = tt(
              ` (merged locally; PUSH FAILED: ${detail})`,
              ` (로컬 머지 완료; PUSH 실패: ${detail})`,
            );
            emit({ kind: 'error', message: tt(
              `⚠️ Merged LOCALLY but the push to remote FAILED (${detail}). The remote is NOT updated — push manually or check the remote/auth.`,
              `⚠️ 로컬 머지는 됐지만 원격 push가 실패했습니다 (${detail}). 원격이 갱신되지 않았습니다 — 수동 push하거나 원격/인증을 확인하세요.`,
            ) });
          }
        }
        const continuousNow = config.getContinuous ? config.getContinuous() : !!config.continuous;
        if (continuousNow) {
          // Continuous sub-mode: 'auto' = the agent invents the next unit; 'queue' = the
          // broker feeds the next USER-provided task and stops cleanly when the queue is empty.
          const contMode = config.getContinuousMode ? config.getContinuousMode() : 'auto';
          let queuedTask: string | null = null;
          if (contMode === 'queue') {
            queuedTask = config.getNextQueuedTask ? config.getNextQueuedTask() : null;
            if (!queuedTask) {
              // No more user tasks: stop cleanly instead of inventing work.
              setCycle('merged', `continuous (queue) - merged ${branch}${pushNote}; task queue empty - stopping`);
              emit({ kind: 'info', message: `Continuous (queue): merged ${branch}${pushNote}; task queue empty - stopping.` });
              relay(devId, `${RELAY_MARK} ${tt(
                `Merge complete. Continuous (task-queue) mode has no more queued tasks - stopping. Add tasks to the queue and start a new harness to keep going.`,
                `병합 완료. 연속(작업입력) 모드에 남은 작업이 없어 정지합니다. 작업 큐에 작업을 추가하고 새 하네스를 시작하세요.`,
              )}`);
              relay(revId, `${RELAY_MARK} ${tt(
                `Merge complete (continuous task-queue empty). This harness will stop.`,
                `병합 완료 (연속 작업입력 큐 비어 정지).`,
              )}`);
              autoMergeStarted = false;
              stopped = true;
              return;
            }
          }
          // Continuous mode: do NOT stop. The just-merged commit becomes the new base;
          // reset the review bookkeeping and loop back to developing for the next unit.
          // (The status reason carries the "continuous mode" marker so the loop-back past
          // merging/approved is accepted by shouldAcceptBrokerStatusUpdate.)
          baseSha = mergeSha;
          lastReviewedDiff = '';
          reworkOpen = false;
          firstReview = true;
          pendingRevSince = 0;
          pendingDevSince = 0;
          stalls = 0;
          autoMergeStarted = false;
          emit({ kind: 'info', message: `Continuous mode (${contMode}): merged ${branch}${pushNote}; looping back to development.` });
          setCycle('developing', tt(
            `continuous mode - merged & pushed; keep building the next unit`,
            `연속 모드 - 병합/푸시 완료; 다음 작업을 계속 진행합니다`,
          ), { action: undefined });
          if (contMode === 'queue' && queuedTask) {
            relay(devId, `${RELAY_MARK} ${tt(
              `Merge complete (CONTINUOUS · queued task). Your NEXT task is: ${queuedTask}. Implement and test it, then append a NEW DONE line to ${DEV_FEED_REL}. Do not invent other work; do exactly this task.`,
              `병합 완료 (연속 · 지정 작업). 다음 작업: ${queuedTask}. 구현·테스트한 뒤 ${DEV_FEED_REL}에 새 DONE 줄을 추가하세요. 다른 작업을 임의로 만들지 말고 이 작업만 하세요.`,
            )}`);
          } else {
            relay(devId, `${RELAY_MARK} ${tt(
              `Merge complete (CONTINUOUS mode ON). Keep going: implement the next improvement, test it, then append a NEW DONE line to ${DEV_FEED_REL}. The harness will keep building → reviewing → merging until the human stops it. Do not wait for a fresh harness.`,
              `병합 완료 (연속 모드 켜짐). 계속 진행하세요: 다음 개선을 구현·테스트한 뒤 ${DEV_FEED_REL}에 새 DONE 줄을 추가하세요. 사람이 멈출 때까지 개발→검토→병합을 계속 반복합니다. 새 하네스를 기다리지 마세요.`,
            )}`);
          }
          relay(revId, `${RELAY_MARK} ${tt(
            `Merge complete (continuous mode). Stand by for the next review request.`,
            `병합 완료 (연속 모드). 다음 검토 요청을 대기하세요.`,
          )}`);
          return;
        }
        setCycle('merged', `auto merge complete - ${branch}${pushNote}`);
        emit({ kind: 'info', message: `Auto merge complete: ${branch}${mergeResult ? ` - ${mergeResult}` : ''}${pushNote}` });
        relay(devId, `${RELAY_MARK} Auto merge complete for ${branch}. The broker committed/merged the reviewed work; this harness terminal will close. Start the next task with a fresh harness.`);
        relay(revId, `${RELAY_MARK} Auto merge complete for ${branch}. This harness terminal will close; no follow-up review is needed.`);
        autoMergeStarted = false;
        stopped = true;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error).slice(0, 1000);
        setCycle('merge_failed', `auto merge failed - ${reason}`);
        emit({ kind: 'error', message: `Auto merge failed for ${branch}: ${reason}` });
        relay(devId, `${RELAY_MARK} Auto merge failed for ${branch}: ${reason}. Stop and wait for human attention.`);
        stopped = true;
      }
    };
    if (
      opts.resume
      && restoredReviewDecision === 'approved'
    ) {
      emit({ kind: 'info', message: `Restored APPROVED review; retrying broker auto-merge for ${branch || '(unknown branch)'}.` });
      setTimeout(() => { void autoMergeApproved(); }, 0);
    }
    await sleep(8000);
    while (!stopped) {
      // [D-perf-single-loop] A newer loop claimed this terminal (remount/restart/HMR race):
      // this loop is an orphan — exit instead of polling in parallel forever.
      if (relayLoopRegistry.get(devId) !== relayLoopToken) {
        emit({ kind: 'info', message: 'Relay loop superseded by a newer harness loop for this terminal; stopping the old loop.' });
        stopped = true;
        break;
      }
      const now = Date.now();
      // P1-5: PTY-death detection. Once a terminal's agent CLI was up (has a child), a
      // later child-loss (CLI exited) or a vanished PTY (terminal closed) for several
      // consecutive checks means the harness can't continue — escalate instead of
      // relaying into a dead terminal forever. Probe errors alone never trip it (only
      // after the terminal was confirmed alive), and a streak tolerates transient blips.
      const probeChild = async (id: string): Promise<boolean | null> =>
        invoke<boolean>('pty_terminal_has_child', { terminalId: id }).then((v) => !!v).catch(() => null);
      if (!isClosedCycle(cycle as CycleState)) {
        const dc = await probeChild(devId);
        if (dc === true) { devSawChild = true; devDeadStreak = 0; } else if (devSawChild) { devDeadStreak += 1; }
        const rc = await probeChild(revId);
        if (rc === true) { revSawChild = true; revDeadStreak = 0; } else if (revSawChild) { revDeadStreak += 1; }
        if (devDeadStreak >= PTY_DEAD_STREAK || revDeadStreak >= PTY_DEAD_STREAK) {
          const who = devDeadStreak >= PTY_DEAD_STREAK ? ROLE_LABEL[config.developer] : ROLE_LABEL[config.reviewer];
          escalateToHuman(tt(`${who} terminal CLI exited / was closed`, `${who} 터미널 CLI가 종료되거나 닫힘`));
        }
        // Self-healing reviewer briefing fallback (the standby brief is normally sent by a
        // background readiness watcher, but a terminal remount / orphaned watcher could
        // leave the reviewer un-briefed). Only probe when there is something to (re)send.
        const needStandbyCheck = !stopped && (
          !reviewerStandbyBriefed
          || (reviewerStandbySends > 0 && reviewerStandbySends < REVIEWER_STANDBY_MAX_SENDS
              && (now - lastReviewerStandbyAt) >= REVIEWER_STANDBY_REBRIEF_GAP_MS)
        );
        if (needStandbyCheck) {
          // CRITICAL: brief ONLY when the reviewer agent is actually up and accepting input.
          // Prefer the host's gold-standard predicate (isTerminalReady) — it refuses a raw
          // shell prompt, requires idle, and confirms a live agent process. This is the SAME
          // gate the readiness watcher uses, so the self-heal can never dump the standby brief
          // into a raw PowerShell shell. The legacy `pty_terminal_has_child` probe (rc) is
          // defeated on Windows — the PTY child is ALWAYS the shell, so it reads "ready" even
          // when the CLI never launched, which is exactly how codex sat un-briefed at a PS
          // prompt while the briefing ran as PowerShell commands. Fall back to rc + idle only
          // when the host didn't wire isTerminalReady (unit tests).
          const reviewerReadyForStandby = opts.isTerminalReady
            ? await opts.isTerminalReady(revId, config.reviewer).catch(() => false)
            : (rc === true && (await invoke<number>('pty_idle_ms', { terminalId: revId }).catch(() => 0)) >= 1500);
          if (reviewerReadyForStandby && !reviewerStandbyBriefed) {
            revReadyForInput = true;
            briefReviewerStandby();
          } else if (
            // Delivery backstop: the first standby write may have been lost in the CLI's final
            // render frame, leaving the reviewer un-briefed with the latch already set. Re-send
            // ONCE, well-spaced. shouldResendReviewerStandby is the canon for the send bookkeeping;
            // reviewerReadyForStandby above is the (stronger) "agent is really up" guard.
            reviewerReadyForStandby
            && shouldResendReviewerStandby({
              hasChild: true,
              idleMs: 1500,
              sends: reviewerStandbySends,
              maxSends: REVIEWER_STANDBY_MAX_SENDS,
              msSinceLast: now - lastReviewerStandbyAt,
              rebriefGapMs: REVIEWER_STANDBY_REBRIEF_GAP_MS,
              stopped,
            })
          ) {
            sendReviewerStandbyMessage();
            emit({ kind: 'info', message: tt('Re-sent reviewer standby instructions (delivery backstop).', '검토 에이전트 대기 지시를 한 번 더 전달했습니다(전달 보강).') });
          }
        }
      }
      // Periodic feed rotation so the coordination files never grow into one giant doc.
      if (now - lastRotateAt > ROTATE_GAP) {
        lastRotateAt = now;
        const removedRev = await rotateFeed(reviewFeedPath); if (removedRev) lastFeedLen = Math.max(0, lastFeedLen - removedRev);
        const removedDev = await rotateFeed(devFeedPath); if (removedDev) lastDevFeedLen = Math.max(0, lastDevFeedLen - removedDev);
        if (removedRev || removedDev) emit({ kind: 'info', message: tt('Archived old feed entries (keeping the feed small).', '오래된 피드 항목을 아카이브했습니다. 피드를 작게 유지합니다.') });
      }
      // DEV -> REVIEWER: trigger only on the developer's DONE signal. When the
      // developer appends DONE to the dev-feed, the broker captures the diff,
      // judges it, and hands only the diff location to the reviewer.
      const devFeed = (await invoke<string>('read_file', { path: devFeedPath }).catch(() => '')) || '';
      const hasDoneSignal = devFeed.length > lastDevFeedLen;
      // [D-perf-lazydiff] The full cumulative diff (three git spawns + the whole patch over
      // the shell pipe, every 6s, per harness) is only NEEDED when a DONE signal must be
      // gated/judged. Idle ticks — the overwhelming majority while the developer is typing —
      // need at most a cheap "any changes?" boolean (see the !hasDoneSignal branch below).
      const workingResult = hasDoneSignal
        ? await gitWorkingDiff(devWorkDir, baseSha)
        : { diff: '', error: null as string | null };
      // P2-6: if git itself failed, do NOT treat it as an empty diff (that would falsely
      // reject the developer's DONE). Surface the error and retry on the next poll —
      // consume the DONE marker so we don't spin, but keep the cycle open.
      if (hasDoneSignal && workingResult.error) {
        lastDevFeedLen = devFeed.length;
        const reason = tt(
          `Broker could not read the git diff (git error: ${workingResult.error}). NOT failing your DONE; the broker will retry. If this persists, check the repo/worktree.`,
          `브로커가 git diff를 읽지 못했습니다 (git 에러: ${workingResult.error}). DONE을 거부하지 않고 재시도합니다. 계속되면 저장소/워크트리를 확인하세요.`,
        );
        emit({ kind: 'error', message: reason });
        relay(devId, `${RELAY_MARK} ${reason}`);
        await sleep(6000);
        continue;
      }
      const working = workingResult.diff;
      const doneGate = classifyDoneSignalReview(hasDoneSignal, working, lastReviewedDiff, reworkOpen);
      if (doneGate === 'empty_diff' || doneGate === 'empty_rework') {
        lastDevFeedLen = devFeed.length;
        if (doneGate === 'empty_rework') {
          pendingDevSince = now;
          setCycle('addressing', tt('REWORK is still open - developer DONE rejected because there is no diff', 'REWORK 미해결 - 검토할 diff가 없어 개발자 DONE을 거부했습니다.'));
          relay(devId, `${RELAY_MARK} REWORK is still open. Your DONE was rejected because there is no git diff to review. You MUST apply the latest REWORK in ${REVIEW_FEED_REL}, change the code/tests, then append a new DONE to ${DEV_FEED_REL}.`);
          emit({ kind: 'error', message: 'Developer DONE rejected: REWORK is still open and there is no diff to review.' });
        } else {
          emit({ kind: 'info', message: tt('Ignored DONE signal because there is no git diff to review.', '검토할 git diff가 없어 DONE 신호를 무시했습니다.') });
          relay(devId, `${RELAY_MARK} DONE ignored: there is no git diff to review. Make code/test/doc changes first, then append a new DONE to ${DEV_FEED_REL}.`);
        }
      } else if (doneGate === 'duplicate_diff' || doneGate === 'duplicate_rework') {
        lastDevFeedLen = devFeed.length;
        if (doneGate === 'duplicate_rework') {
          pendingDevSince = now;
          setCycle('addressing', tt('REWORK is still open - developer DONE rejected because the diff did not change', 'REWORK 미해결 - diff 변경이 없어 개발자 DONE을 거부했습니다.'));
          relay(devId, `${RELAY_MARK} REWORK is still open. Your DONE was rejected because the diff did not change. You MUST apply the latest REWORK in ${REVIEW_FEED_REL}, change the code/tests, then append a new DONE to ${DEV_FEED_REL}.`);
          emit({ kind: 'error', message: 'Developer DONE rejected: REWORK is still open and diff did not change.' });
        } else {
          emit({ kind: 'info', message: tt('Ignored duplicate DONE signal because the diff did not change.', 'diff did not change; duplicate DONE ignored.') });
        }
      } else if (!hasDoneSignal) {
        // [D-perf-lazydiff] Probe git only when the "has changes" boolean could actually MOVE
        // the displayed cycle. A same-state refresh (addressing → addressing was the only such
        // case) carries no new information but used to re-emit a status event and rewrite
        // broker-status.md every tick — skip it. Post-snapshot rounds short-circuit on
        // `checkpoints` (the cumulative diff vs baseSha is then provably non-empty) with zero
        // git spawns.
        const nextWorkingCycle = nextCycleForWorkingWithoutDone(cycle);
        if (nextWorkingCycle && nextWorkingCycle !== cycle) {
          const hasChanges = checkpoints.length > 0 || (await gitHasWorkingChanges(devWorkDir));
          if (hasChanges) {
            setCycle(nextWorkingCycle, nextWorkingCycle === 'addressing'
              ? tt('developer addressing REWORK - waiting for updated DONE', '개발자가 REWORK를 반영 중 - 수정 후 DONE 대기')
              : tt('developer working - not done yet', '개발자 작업 중 - 아직 미완료'));
          }
        }
      } else if (doneGate === 'request_review') {
        // Guard above: a repeated DONE with no new diff is ignored. A genuinely
        // new DONE should request review immediately, even if a previous review
        // nudge was sent recently.
        lastReviewedDiff = working;
        reworkOpen = false;
        reviewedOnce = true; // real work happened, so periodic checks may now run
        // P0 (audit 2026-06-25): JUDGE BEFORE CHECKPOINTING. snapshotRound() runs `git add -A
        // && commit`, moving HEAD to the current state — after which the judge's `git diff
        // HEAD` / `git diff --shortstat HEAD` reads are EMPTY and mis-classify a real change as
        // a no-op "skip" (under-reporting risk/size, and with review off corrupting auto-merge
        // decisions). Judge while the round's work is still uncommitted vs HEAD, THEN snapshot.
        const j = await mechanicalJudge(devWorkDir, { baseline, diff: working, goal: config.goal, firstReview }, new Date().toISOString());
        // P3-1: snapshot the exact state being reviewed (commit on the detached HEAD).
        // `working` (the reviewed diff) was already computed vs baseSha above, so this
        // commit does not change what the reviewer sees.
        await snapshotRound();
        const addedDev = hasDoneSignal ? devFeed.slice(lastDevFeedLen) : '';
        if (hasDoneSignal) lastDevFeedLen = devFeed.length;
        const doneLines = addedDev.split('\n').filter((l) => /\bdone\b|작업\s*끝/i.test(l)).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const doneSummary = doneLines.slice(-3).join(' / ') || 'developer signalled done';
        const reviewReason = `developer DONE - ${doneSummary}`;
        if (cycle === 'merged') autoMergeStarted = false;
        if (pendingDevSince) pendingDevSince = 0; // developer signalled done
        lastMetricsMd = j.statusMarkdown;
        const m = j.metrics;
        const ext = { action: j.action, directionOk: j.directionOk, grownLoc: m.grownLoc };
        firstReview = false;
        lastNudgeRevAt = now;
        pendingRevSince = now;
        // Write the reviewed diff into the reviewer's worktree (where it reviews), and
        // also into the dev worktree so the developer's own DIFF_FILE references resolve.
        // P2-5: prepend a structured changed-files manifest so the reviewer cites exact
        // paths and sees which files are binary (excluded) without parsing the patch.
        const manifest = await gitChangedFilesManifest(devWorkDir, baseSha);
        const diffContent = buildReviewPatch(`# review - ${reviewReason} - broker[${j.action}] ${j.reason}`, manifest, working);
        await writeReviewPatchFile(`${reviewerDir}/${DIFF_FILE_REL}`, diffContent);
        if (reviewerDir !== devWorkDir) {
          await writeReviewPatchFile(`${devWorkDir}/${DIFF_FILE_REL}`, diffContent);
        }
        if (!reviewStepEnabled) {
          pendingRevSince = 0;
          lastNudgeRevAt = 0;
          if (j.action === 'escalate' || !j.directionOk) {
            const reason = `review step disabled, but broker requires human review - ${j.reason}`;
            setCycle('merge_failed', reason, ext);
            emit({ kind: 'error', message: reason });
            relay(devId, `${RELAY_MARK} Review step is disabled, but this change is high-risk or off-track (${j.reason}). Human review is required before merge. Re-enable review or inspect ${DIFF_FILE_REL}.`);
            relay(revId, `${RELAY_MARK} Emergency review requested despite review mode OFF: ${j.reason}. Open ${DIFF_FILE_REL}; do not edit source code.`);
            continue;
          }
          setCycle('approved', tt('review step disabled - mechanical checks passed; auto commit/merge queued', '리뷰 단계 꺼짐 - 기계 검사 통과; 자동 커밋/머지 대기'), ext);
          emit({ kind: 'info', message: `Review step disabled; skipping reviewer and auto-merging ${branch || '(unmanaged branch)'}.` });
          relay(devId, `${RELAY_MARK} Review step is disabled. Broker mechanical checks passed (${j.reason}); auto-commit/merge is starting.`);
          setTimeout(() => { void autoMergeApproved(); }, 0);
          continue;
        }
        const browserReviewNudgeEn = browserReviewEnabled
          ? 'If this touches web UI/browser/frontend/network/user flow, you MUST test it in BBARIT Browser. From the repo root run npm run browser:open first, then capture npm run browser -- snapshot, screenshot, console, network, and the changed flow. If browser verification is missing or impossible, write REWORK, not APPROVED.'
          : 'BBARIT Browser testing is optional for this harness. Use it when useful for web UI/browser/frontend/network/user flow changes, but do not write REWORK solely because browser evidence is absent.';
        const browserReviewNudgeKo = browserReviewEnabled
          ? '웹 UI/브라우저/프론트엔드/네트워크/사용자 흐름 변경이면 반드시 BBARIT Browser로 테스트하세요. 저장소 루트에서 먼저 npm run browser:open을 실행한 뒤 npm run browser -- snapshot, screenshot, console, network와 변경 흐름을 확인하세요. 브라우저 검증이 없거나 불가능하면 APPROVED가 아니라 REWORK를 쓰세요.'
          : '이 하네스에서는 BBARIT Browser 테스트가 선택 사항입니다. 웹 UI/브라우저/프론트엔드/네트워크/사용자 흐름 변경에서 유용하면 사용하되, 브라우저 증거가 없다는 이유만으로 REWORK를 쓰지는 마세요.';
        if (!revReadyForInput) {
          revReadyForInput = await waitForOneTerminal(revId, config.reviewer);
        }
        if (!revReadyForInput) {
          const reason = 'review agent is not ready; cannot request automated review safely';
          setCycle('merge_failed', tt(reason, '검토 에이전트가 준비되지 않아 자동 검토를 안전하게 요청할 수 없습니다.'), ext);
          emit({ kind: 'error', message: reason });
          relay(devId, `${RELAY_MARK} Review agent is not ready, so the broker cannot safely request automated review yet. Check/restart the review agent terminal, then start a new harness or re-run the task.`);
          continue;
        }
        briefReviewerStandby();
        // P3-2: path-conditional rules. Select the rules whose `paths:` globs match THIS
        // change's files (from the authoritative changed-path set) and name the active
        // ones, so the reviewer focuses on rules that actually apply to this diff.
        const rulesMd = (await invoke<string>('read_file', { path: `${devWorkDir}/docs/wiki/concepts/design-rules.md` }).catch(() => '')) || '';
        let activeRulesNote = '';
        let activeRulesNoteKo = '';
        if (rulesMd.trim()) {
          const changedPaths = await gitChangedPaths(devWorkDir, baseSha);
          const scoped = selectActiveRules(parsePathRules(rulesMd), changedPaths).filter((r) => r.paths.length);
          if (scoped.length) {
            const titles = scoped.map((r) => r.title).join('; ');
            activeRulesNote = ` Path-scoped rules ACTIVE for the changed files: ${titles}. Apply them.`;
            activeRulesNoteKo = ` 이 변경 파일에 해당하는 경로-스코프 룰: ${titles}. 반드시 적용하세요.`;
          }
        }
        relay(revId, tt(
          `${RELAY_MARK} Review requested: ${reviewReason}. REVIEW now (${j.reason}). First read ${revBriefRel}, then open ${DIFF_FILE_REL} yourself (or run \`git diff\`) and inspect the change technically. Review mode is ${reviewModeLabel(reviewMode)}.${activeRulesNote} ${reviewModeInstruction(reviewMode)} ${browserReviewNudgeEn} Then append "APPROVED: <evidence checked>" OR "REWORK: <exact technical fixes>" to ${REVIEW_FEED_REL}. Do not edit source code yourself.`,
          `${RELAY_MARK} 리뷰 요청: ${reviewReason}. 지금 검토하세요 (${j.reason}). 먼저 ${revBriefRel}을 읽고, 직접 ${DIFF_FILE_REL}을 열거나 \`git diff\`를 실행해서 변경을 기술적으로 확인하세요. 리뷰 모드는 ${reviewModeLabel(reviewMode)}입니다.${activeRulesNoteKo} ${browserReviewNudgeKo} 검토 뒤 ${REVIEW_FEED_REL}에 "APPROVED: <확인한 근거>" 또는 "REWORK: <정확한 기술 수정사항>"을 쓰세요. 리뷰어는 소스 코드를 직접 수정하지 마세요.`));
        if (!j.directionOk) {
          relay(devId, tt(
            `${RELAY_MARK} Broker flags possible OFF-TRACK work: ${j.reason}. Re-align with the user's task before continuing.`,
            `${RELAY_MARK} 브로커가 작업 방향 이탈 가능성을 감지했습니다: ${j.reason}. 계속하기 전에 사용자 작업과 다시 맞추세요.`));
        }
        setCycle('reviewing', tt(`reviewing - ${reviewReason}`, `리뷰 중 - ${reviewReason}`), ext);
      }
      // REVIEWER -> DEV: the reviewer drives the REWORK loop. The broker reads
      // new feedback and routes it: an explicit APPROVAL ends the loop; anything
      // else is a rework instruction relayed to the developer, and the loop repeats.
      const feed = (await invoke<string>('read_file', { path: reviewFeedPath }).catch(() => '')) || '';
      if (feed.length > lastFeedLen) {
        const added = feed.slice(lastFeedLen);
        lastFeedLen = feed.length;
        // Bridge the reviewer's verdict back to the dev worktree so the developer can
        // open REVIEW_FEED and read the REWORK (the reviewer wrote it in its own
        // isolated worktree). No-op when reviewer shares the dev worktree.
        if (reviewerDir !== devWorkDir) {
          await invoke('write_file', { path: devReviewFeedPath, content: feed }).catch(() => {});
        }
        if (isPrematureReviewerFeedback({ pendingRevSince, reviewedOnce, cycle })) {
          emit({ kind: 'info', message: `Ignored premature reviewer feedback before developer DONE - ${REVIEW_FEED_REL}` });
          continue;
        }
        pendingRevSince = 0; // reviewer responded; ack cleared
        stalls = 0;
        const decision = reviewDecisionFromText(added);
        const hasRework = decision === 'rework';
        const approved = decision === 'approved';
        if (!approved && !hasRework) {
          emit({ kind: 'info', message: `${ROLE_LABEL[config.reviewer]} note added to ${REVIEW_FEED_REL}` });
        } else {
          emit({ kind: 'relay', message: `${ROLE_LABEL[config.reviewer]} ${approved ? 'APPROVED' : 'REWORK'} - ${REVIEW_FEED_REL}` });
          relay(revId, `${RELAY_MARK} Reviewer learning note: if this review exposed a recurring rule, update docs/wiki/concepts/design-rules.md or add a focused docs/wiki note now. If there is no durable lesson, do nothing; do not spend tokens inventing one.`);
        }
        if (approved) {
          // P3-3: stale-review guard. The reviewer approved the diff captured at review
          // request time (lastReviewedDiff). If the developer changed the code AFTER that
          // (kept editing instead of waiting), merging would ship UN-REVIEWED changes —
          // re-request review instead of merging. Skipped if git failed (don't falsely
          // flag) or if no prior diff was recorded.
          const nowResult = await gitWorkingDiff(devWorkDir, baseSha);
          if (!nowResult.error && lastReviewedDiff.trim() && nowResult.diff.trim() !== lastReviewedDiff.trim()) {
            pendingRevSince = now;
            reviewedOnce = true;
            lastReviewedDiff = nowResult.diff;
            await snapshotRound();
            const manifest = await gitChangedFilesManifest(devWorkDir, baseSha);
            const diffContent = buildReviewPatch('# re-review: the diff CHANGED after APPROVED (stale review)', manifest, nowResult.diff);
            await writeReviewPatchFile(`${reviewerDir}/${DIFF_FILE_REL}`, diffContent);
            if (reviewerDir !== devWorkDir) await writeReviewPatchFile(`${devWorkDir}/${DIFF_FILE_REL}`, diffContent);
            setCycle('reviewing', tt('APPROVED is stale - diff changed since review; re-requesting review', 'APPROVED가 낡음 - 리뷰 이후 diff가 변경됨; 재검토 요청'));
            emit({ kind: 'error', message: tt('Reviewer APPROVED, but the diff changed after review (stale). Not merging; re-requesting review.', '리뷰어가 APPROVED했지만 리뷰 이후 diff가 바뀌었습니다(낡음). 머지하지 않고 재검토를 요청합니다.') });
            relay(devId, `${RELAY_MARK} Your APPROVED is STALE: the code changed after the reviewer approved. The broker will NOT merge un-reviewed changes. Stop editing and wait; the updated diff was re-sent for review.`);
            relay(revId, `${RELAY_MARK} The developer changed the code after your APPROVED. Re-review the UPDATED diff at ${DIFF_FILE_REL}, then append APPROVED or REWORK to ${REVIEW_FEED_REL}.`);
            continue;
          }
          pendingRevSince = 0;
          pendingDevSince = 0;
          stalls = 0;
          setCycle('approved', tt('reviewer approved - auto commit/merge queued', '리뷰어 승인 - 자동 커밋/머지 대기'));
          setTimeout(() => { void autoMergeApproved(); }, 0);
        } else if (hasRework) {
          lastNudgeDevAt = now;
          pendingDevSince = now;
          reworkOpen = true;
          // P1-4: count identical REWORKs. Same body repeated => reviewer/dev not
          // converging; after the limit, halt instead of relaying the same rework forever.
          const sig = relaySignature('rev', 'rework', added);
          reworkRepeatCount = (sig === lastReworkSig) ? reworkRepeatCount + 1 : 1;
          lastReworkSig = sig;
          if (reworkRepeatCount >= REWORK_REPEAT_LIMIT) {
            escalateToHuman(tt(
              `reviewer issued ${reworkRepeatCount} identical REWORKs with no convergence`,
              `리뷰어가 동일 REWORK를 ${reworkRepeatCount}회 반복 (수렴 실패)`,
            ));
          } else {
            relay(devId, `${RELAY_MARK} MANDATORY REWORK. Open ${REVIEW_FEED_REL} now and apply the latest REWORK exactly. Do not continue as if approved. Do not append DONE until code/tests changed and the REWORK is actually fixed. Then append DONE to ${DEV_FEED_REL} for re-review.`);
            setCycle('addressing', tt('mandatory REWORK - developer must redo before any approval/merge', '필수 REWORK - 개발자는 승인/머지 전에 반드시 재작업해야 함'));
          }
        }
      }
      // Watch both sides: re-nudge whoever went silent past ACK_WINDOW.
      // An agent still producing output is WORKING (e.g. the reviewer running the browser
      // test), not stalled — don't re-nudge it (which interrupts) and don't count it toward
      // the stall ceiling. Reset its ack window instead so we wait for it to actually go quiet.
      const isActivelyWorking = async (id: string): Promise<boolean> =>
        (await invoke<number>('pty_idle_ms', { terminalId: id }).catch(() => 0)) < 30000;
      if (!isClosedCycle(cycle as CycleState) && pendingRevSince && now - pendingRevSince > ACK_WINDOW && now - lastNudgeRevAt > MIN_NUDGE_GAP) {
        if (await isActivelyWorking(revId)) {
          pendingRevSince = now; // reviewer is still working — give it more time, no stall
        } else {
          lastNudgeRevAt = now; pendingRevSince = now; stalls++;
          relay(revId, `${RELAY_MARK} Reminder: the change at ${DIFF_FILE_REL} still awaits your review. Append it to ${REVIEW_FEED_REL}.`);
          emit({ kind: 'relay', message: tt(`${ROLE_LABEL[config.reviewer]} re-nudge (awaiting review)`, `${ROLE_LABEL[config.reviewer]} 재촉 (리뷰 대기)`) });
        }
      }
      if (!isClosedCycle(cycle as CycleState) && pendingDevSince && now - pendingDevSince > ACK_WINDOW && now - lastNudgeDevAt > MIN_NUDGE_GAP) {
        if (await isActivelyWorking(devId)) {
          pendingDevSince = now; // developer is still working — give it more time, no stall
        } else {
          lastNudgeDevAt = now; pendingDevSince = now; stalls++;
          relay(devId, `${RELAY_MARK} Reminder: reviewer feedback in ${REVIEW_FEED_REL} is still to be addressed.`);
          emit({ kind: 'relay', message: tt(`${ROLE_LABEL[config.developer]} re-nudge (awaiting fix)`, `${ROLE_LABEL[config.developer]} 재촉 (수정 대기)`) });
        }
      }
      if (stalls >= STALL_CEILING) {
        // P1-4: was reset-and-warn (nudge forever). Now a hard stop with a human decision.
        escalateToHuman(tt('dev/reviewer stalled with no convergence', '개발/리뷰가 수렴하지 못하고 정체됨'));
      }
      await sleep(6000);
    }
    emit({ kind: 'info', message: 'Relay stopped.' });
  })().catch((e) => emit({ kind: 'error', message: String(e) }));

  const merge = (branch && worktreeDir && repoDir)
    ? async (): Promise<string> => {
        // The worktree is on a detached HEAD (no branch). `branch` is only a label —
        // merging it would fail with "not something we can merge". Commit then merge
        // the worktree HEAD *by SHA*, exactly like autoMergeApproved.
        await sh(
          `git add -A && if ! git diff --cached --quiet; then git -c user.email=broker@local -c user.name=broker commit -q -m ${shellQuote(`broker: ${config.goal || 'session'}`)}; fi`,
          worktreeDir!,
          30,
        ).catch(() => {});
        const mergeSha = (await sh('git rev-parse HEAD', worktreeDir!, 20)).trim();
        if (!mergeSha) throw new Error('could not resolve worktree HEAD commit for merge');
        return invoke<string>('git_merge_branch', { repoDir, branchName: mergeSha });
      }
    : undefined;

  // P3-1: deterministic restore to the last reviewed snapshot (discards a drifting
  // REWORK). User/UI-triggered only — never auto-fired, so dev work isn't silently lost.
  const rollback = (baseSha && devWorkDir)
    ? async (): Promise<boolean> => {
        if (!checkpoints.length) return false;
        // Reset to the snapshot BEFORE the latest (the drift), or baseSha if only one.
        const target = checkpoints.length >= 2 ? checkpoints[checkpoints.length - 2].sha : baseSha;
        try {
          await sh(`git reset --hard ${shellQuote(target)} && git clean -fd`, devWorkDir, 60);
          emit({ kind: 'info', message: tt(`Rolled back the dev worktree to checkpoint ${target.slice(0, 8)}.`, `개발 워크트리를 체크포인트 ${target.slice(0, 8)}로 롤백했습니다.`) });
          return true;
        } catch {
          return false;
        }
      }
    : undefined;
  return {
    developerId: devId, reviewerId: revId, branch, worktreeDir, repoDir, merge, rollback,
    // Resolve false (no-op) if a click lands before the loop armed the hook or after stop.
    requestRework: async (): Promise<boolean> => (controlRequestRework ? controlRequestRework() : false),
    resetReviewFeed: async (): Promise<boolean> => (controlResetReviewFeed ? controlResetReviewFeed() : false),
    rebrief: async (): Promise<boolean> => (controlRebrief ? controlRebrief() : false),
    stop: () => {
      stopped = true;
      // Release the terminal claim only if it is still ours (a newer loop may own it).
      if (relayLoopRegistry.get(devId) === relayLoopToken) relayLoopRegistry.delete(devId);
    },
  };
}
