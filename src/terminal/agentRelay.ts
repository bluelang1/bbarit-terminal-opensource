// 에이전트 간 위임(agent run / send / wait)의 순수 로직 — 자식에게 넣는 첫 메시지, 자식 →
// 부모 노트 형식, 노트를 보낼 전이 판정, 부모별 대기열, 자식이 "끝났는지" 판정.
// App.tsx 가 상태(agentLinks)와 입력 게이트 연결을 맡는다. 설계: docs/AGENT_RELAY.md
import type { AgentTabState } from './programStatus';

export interface AgentLink {
  childId: string;
  parentId: string;
  name?: string;
  cliType?: string;
  createdAt: number;
  /** 마지막으로 노트를 보낸 턴과 상태(같은 턴 같은 상태 중복 방지). */
  lastNotifiedTurn: number;
  lastNotifiedState?: AgentNoteState;
  lastState?: AgentTabState;
  exited?: boolean;
  /** 첫 메시지(브리프+프롬프트)를 아직 넣지 않았다. */
  pending?: boolean;
  /** 마지막으로 자식에게 입력(브리프 또는 agent.send)을 넣은 시각·턴·그때 blocked 였는지. */
  sentAt?: number;
  sentTurn?: number;
  sentWhileBlocked?: boolean;
  /** 브리프 주입이 거부된 사유(준비 시간 초과 포함). */
  briefError?: string;
  /**
   * 자식이 `agent send` 로 부모에게 직접 보고한 턴(그 보고가 끝나는 턴 번호). 그 턴의 done
   * 노트는 중복이라 보내지 않는다.
   */
  lastSendTurn?: number;
}

export type AgentNoteState = 'blocked' | 'done' | 'exited';

/** XTerminal 의 `octo-agent-status` detail 중 릴레이가 쓰는 필드. */
export interface AgentStatusSnapshot {
  state: AgentTabState;
  kind?: string;
  msg?: string;
  turn: number;
  cleared?: boolean;
  /** 보고를 받은 시각(ms). 부모가 "최근에" 7501 을 보고했는지 판단한다. */
  at?: number;
}

/** 노트·브리프의 `from` 에 쓰는 짧은 표시 이름. */
export function agentLabel(id: string, name?: string): string {
  const clean = sanitizeAttr(name || '');
  return clean ? `${id} ${clean}` : id;
}

function sanitizeAttr(value: string): string {
  return neutralizeShell(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

// 노트 본문은 에이전트 입력창에 타이핑된다. 혹시 셸에 들어가도 명령이 되지 않도록 셸
// 메타문자를 비슷하게 생긴 안전한 글자로 바꾼다(`<` `>` 는 `</bbarit>` 위조도 막는다).
const SHELL_SAFE: Record<string, string> = {
  '`': 'ˋ', $: '＄', ';': '；', '|': '｜', '&': '＆', '<': '‹', '>': '›', '\\': '＼',
};

export function neutralizeShell(text: string): string {
  return text.replace(/[`$;|&<>\\]/g, (c) => SHELL_SAFE[c] || '');
}

/** 본문을 한 줄로: 제어 문자 제거, 공백 접기, 셸 메타문자 무력화, 길이 제한. */
export function oneLine(text: string, max = 300): string {
  const flat = neutralizeShell(text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (Array.from(flat).length <= max) return flat;
  return `${Array.from(flat).slice(0, max - 1).join('')}…`;
}

/** 마지막 N 줄 — 글자나 숫자가 없는 줄(빈 줄, TUI 입력창 테두리 `╭──╮`·`│ > │`)은 건너뛴다. */
export function lastNonEmptyLines(text: string, n = 3): string[] {
  return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => /[\p{L}\p{N}]/u.test(l)).slice(-n);
}

// TUI 에이전트(Claude Code 등) 화면의 하단은 입력창·상태줄이다. 노트 본문은 그 위의 답을 써야 한다.
const USER_ECHO = /^\s*(?:❯|>)\s/;
const PROMPT_MARKER = /^\s*(?:❯|>)\s*$/;
const ASSISTANT_LINE = /^\s*⏺/;
const TUI_FOOTER = [
  /bypass permissions/i,
  /\? for shortcuts/i,
  /(?:Fable|Opus|Sonnet|Haiku)\b.*\$/,
  /✻.*\bdone\b/i,
  /^\s*[─━—–=_-]{3,}\s*$/,
  /\d+(?:\.\d+)?\s*%/,
];

function isTuiFooter(line: string): boolean {
  return TUI_FOOTER.some((re) => re.test(line));
}

/**
 * 노트 본문에 쓸 줄들. 마지막 사용자 입력 에코(`❯ `·`> ` 로 시작) 뒤부터 다음 프롬프트 표시
 * (`❯`·`>` 만 있는 줄) 전까지를 답으로 보고, 그중 `⏺` 로 시작하는 줄을 먼저 쓴다. 알려진
 * 하단 줄(권한 모드, 단축키 안내, 모델·비용, `✻ … done`, 가로줄, `%` 상태줄)은 버린다. 아무것도
 * 남지 않으면 예전 규칙(글자가 있는 마지막 N 줄)으로 돌아간다.
 */
export function noteTailLines(text: string, n = 3): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (USER_ECHO.test(lines[i]) && !PROMPT_MARKER.test(lines[i])) { start = i + 1; break; }
  }
  if (start >= 0) {
    let end = lines.length;
    for (let i = start; i < lines.length; i++) {
      if (PROMPT_MARKER.test(lines[i])) { end = i; break; }
    }
    const answer = lines.slice(start, end).filter((l) => /[\p{L}\p{N}]/u.test(l) && !isTuiFooter(l));
    const assistant = answer.filter((l) => ASSISTANT_LINE.test(l));
    const picked = (assistant.length > 0 ? assistant : answer).map((l) => l.trim()).slice(-n);
    if (picked.length > 0) return picked;
  }
  const plain = lastNonEmptyLines(text, Number.MAX_SAFE_INTEGER).filter((l) => !isTuiFooter(l)).slice(-n);
  return plain.length > 0 ? plain : lastNonEmptyLines(text, n);
}

export const CTL_REF = 'node "$BBARIT_CTL"';

/**
 * agent.run 이 만드는 자식 탭. Claude 는 전용 세션(`--session-id <uuid>`)으로 띄운다 — 같은
 * 프로젝트 폴더에 부모의 대화가 있으면 `--continue` 가 부모 대화를 이어 버린다. 이름은
 * `--name` 또는 `<cliType> (agent)`.
 */
export function agentRunTerminalSpec(cliType: string, name?: string): { name: string; freshClaudeSession: boolean } {
  return { name: (name || '').trim() || `${cliType} (agent)`, freshClaudeSession: cliType === 'claude' };
}

/** 전용 Claude 세션 탭의 필드(addTerminal 이 새 터미널에 붙인다). */
export function dedicatedClaudeSessionFields(fresh: boolean, newId: () => string): { claudeSessionId?: string; claudeSessionSource?: 'app' } {
  return fresh ? { claudeSessionId: newId(), claudeSessionSource: 'app' } : {};
}

/**
 * 자식에게 넣는 첫 입력(6 절). 부모가 없으면 프롬프트만. 셸 자식은 여러 줄이 명령으로
 * 실행되므로 프롬프트만 넣는다.
 */
export function formatAgentBrief(opts: { parentId?: string; parentName?: string; prompt: string; cliType?: string }): string {
  const prompt = opts.prompt.trim();
  if (!opts.parentId || !opts.cliType || opts.cliType === 'shell') return prompt;
  const label = agentLabel(opts.parentId, opts.parentName);
  const reach = `${CTL_REF} agent send ${opts.parentId} "<message>"`;
  return [
    `<bbarit from="${label}" reach="${reach.replace(/"/g, '\\"')}">`,
    `You were started by another agent (terminal ${label}). If you get stuck or need a decision,`,
    'report back with the reach command above (one short message with the question). When you',
    'finish, report back the same way only if the task below asks for a report.',
    '</bbarit>',
    prompt,
  ].join('\n');
}

/** agent.send 본문 — caller 가 있으면 `<bbarit from="…">text</bbarit>` 로 감싼다. */
export function wrapAgentMessage(text: string, callerId?: string, callerName?: string): string {
  if (!callerId) return text;
  return `<bbarit from="${agentLabel(callerId, callerName)}">${text}</bbarit>`;
}

/** 자식 → 부모 노트 한 줄(5 절). */
export function formatAgentNote(opts: {
  childId: string;
  childName?: string;
  state: AgentNoteState;
  turn?: number;
  kind?: string;
  msg?: string;
  /** 자식 터미널의 최근 출력(done/exited 에서 마지막 3 줄을 뽑는다). */
  tail?: string;
}): string {
  const from = agentLabel(opts.childId, opts.childName);
  if (opts.state === 'blocked') {
    const kind = opts.kind ? ` kind="${sanitizeAttr(opts.kind)}"` : '';
    const body = oneLine(opts.msg || noteTailLines(opts.tail || '', 3).join(' / ') || '(no message)');
    return `<bbarit from="${from}" state="blocked"${kind}>${body} — 답하기: ${CTL_REF} agent send ${opts.childId} "…"</bbarit>`;
  }
  const turn = opts.state === 'done' && typeof opts.turn === 'number' ? ` turn="${opts.turn}"` : '';
  const body = oneLine(noteTailLines(opts.tail || '', 3).join(' / ') || '(no output)');
  return `<bbarit from="${from}" state="${opts.state}"${turn}>${body} — 전체: ${CTL_REF} term read 60 --id ${opts.childId}</bbarit>`;
}

/**
 * 자식의 7501 상태 보고에서 부모에게 노트를 보낼지(5 절). blocked/done 만, 같은 턴에 같은
 * 상태는 한 번. 첫 메시지를 넣기 전(pending)의 done 은 무시한다(시작 직후 보고).
 * 반환: 보낼 상태(없으면 null)와 갱신된 링크.
 */
export function decideAgentNote(link: AgentLink, s: AgentStatusSnapshot): { note: AgentNoteState | null; link: AgentLink } {
  if (s.cleared) return { note: null, link };
  const next: AgentLink = { ...link, lastState: s.state };
  if (s.state !== 'blocked' && s.state !== 'done') return { note: null, link: next };
  if (s.state === 'done' && link.pending) return { note: null, link: next };
  // 이번 턴 결과는 자식이 agent send 로 이미 직접 보고했다.
  if (s.state === 'done' && link.lastSendTurn === s.turn) {
    return { note: null, link: { ...next, lastNotifiedTurn: s.turn, lastNotifiedState: s.state } };
  }
  if (link.lastNotifiedTurn === s.turn && link.lastNotifiedState === s.state) return { note: null, link: next };
  return { note: s.state, link: { ...next, lastNotifiedTurn: s.turn, lastNotifiedState: s.state } };
}

/** PTY 종료 → 노트는 한 번만. */
export function decideExitNote(link: AgentLink): { note: AgentNoteState | null; link: AgentLink } {
  if (link.exited) return { note: null, link };
  return { note: 'exited', link: { ...link, exited: true } };
}

// ── 부모별 대기열 ─────────────────────────────────────────────────────────
// 부모가 blocked 거나(게이트 거부) 사람이 치는 중이면 노트를 쌓아 두었다가 부모가 blocked 를
// 벗어나면 순서대로 다시 보낸다. 부모가 사라지면 버린다.
export type PendingNotes = Map<string, string[]>;

export function enqueueNote(queue: PendingNotes, parentId: string, note: string): void {
  const list = queue.get(parentId) || [];
  list.push(note);
  queue.set(parentId, list);
}

/** 보내지 못한 노트를 앞으로 되돌린다(순서 유지). */
export function requeueFront(queue: PendingNotes, parentId: string, notes: string[]): void {
  if (notes.length === 0) return;
  queue.set(parentId, [...notes, ...(queue.get(parentId) || [])]);
}

/** 대기열을 꺼내 비운다. */
export function takeNotes(queue: PendingNotes, parentId: string): string[] {
  const list = queue.get(parentId) || [];
  queue.delete(parentId);
  return list;
}

export function dropParent(queue: PendingNotes, parentId: string): void {
  queue.delete(parentId);
}

/** 대기열을 flush 해도 되는 부모 상태: 7501 을 보고하고 blocked 가 아니다. */
export function canDeliverToParent(parentState: AgentTabState | undefined): boolean {
  return parentState !== undefined && parentState !== 'blocked';
}

/** 부모의 7501 보고가 이보다 오래됐으면 에이전트가 떠났을 수 있다(셸만 남음) — 노트를 넣지 않는다. */
export const PARENT_REPORT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 노트를 쌓을지: 부모가 셸 탭이 아니고, 7501 루트 상태가 working/blocked/done 이며 마지막
 * 보고가 30 분 안이다. idle(입력 대기 프롬프트일 수도, 에이전트가 끝나 셸일 수도)과 보고 없음은 거절.
 */
export function parentAcceptsNotes(p: { cliType?: string; state?: AgentTabState; lastReportAt?: number; now: number }): boolean {
  if (!p.cliType || p.cliType === 'shell') return false;
  if (p.state !== 'working' && p.state !== 'blocked' && p.state !== 'done') return false;
  return typeof p.lastReportAt === 'number' && p.now - p.lastReportAt <= PARENT_REPORT_MAX_AGE_MS;
}

/**
 * 순서대로 보낸다. 거부되면(blocked/typing/no-writer) 남은 노트를 대기열 앞으로 되돌리고
 * 멈춘다. 터미널이 사라졌으면(disposed) 버린다. 반환: 보낸 개수.
 */
export async function flushNotes(
  queue: PendingNotes,
  parentId: string,
  send: (note: string) => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<{ sent: number; stoppedBy?: string }> {
  const notes = takeNotes(queue, parentId);
  for (let i = 0; i < notes.length; i++) {
    const res = await send(notes[i]);
    if (res.ok) continue;
    if (res.reason === 'disposed') return { sent: i, stoppedBy: res.reason };
    requeueFront(queue, parentId, notes.slice(i));
    return { sent: i, stoppedBy: res.reason };
  }
  return { sent: notes.length };
}

// ── 자식이 "끝났는지" ────────────────────────────────────────────────────
/**
 * 7501 을 보고하지 않는 자식(셸 등)은 마지막 입력과 마지막 출력 뒤 이만큼 조용하면 끝난 것으로
 * 본다(셸은 프롬프트가 다시 보여야 한다). 추정이므로 결과에 `settledBy: 'quiet'` 를 붙인다.
 */
export const UNREPORTED_SETTLE_MS = 30000;

export interface AgentSettleInput {
  state: AgentTabState;
  turn: number;
  /** 7501 보고가 있는 터미널인가. */
  reported: boolean;
  exited?: boolean;
  link?: Pick<AgentLink, 'pending' | 'sentAt' | 'sentTurn' | 'sentWhileBlocked'>;
  now: number;
  cliType?: string;
  /** 마지막 출력 뒤 UNREPORTED_SETTLE_MS 이상 조용했다(7501 없는 자식용). */
  quiet?: boolean;
  /** 셸 프롬프트가 다시 보인다(7501 없는 셸 자식용). */
  shellPromptBack?: boolean;
}

export type AgentSettledBy = 'exited' | 'blocked' | 'done' | 'turn' | 'quiet';

/**
 * agent wait / run 이 멈출 조건과 근거(아니면 null). 종료됐거나, blocked 거나, 마지막 입력 뒤
 * 턴이 끝났다(done/idle). 마지막 입력 시점에 이미 blocked 였고 같은 턴이면 아직 처리 전으로
 * 본다. 링크가 없는 터미널은 exited/blocked/done 만 끝으로 본다.
 */
export function agentSettledBy(s: AgentSettleInput): AgentSettledBy | null {
  if (s.exited) return 'exited';
  const link = s.link;
  if (!link) return s.state === 'blocked' ? 'blocked' : s.state === 'done' ? 'done' : null;
  if (link.pending) return s.state === 'blocked' ? 'blocked' : null;
  const sentTurn = link.sentTurn ?? -1;
  if (s.state === 'blocked') return link.sentWhileBlocked && s.turn === sentTurn ? null : 'blocked';
  if (s.state === 'working') return null;
  if (s.reported) return s.turn > sentTurn ? 'turn' : null;
  if (!s.quiet || s.now - (link.sentAt ?? 0) < UNREPORTED_SETTLE_MS) return null;
  if (s.cliType === 'shell' && !s.shellPromptBack) return null;
  return 'quiet';
}

export function isAgentSettled(s: AgentSettleInput): boolean {
  return agentSettledBy(s) !== null;
}

// ── agent.run: 준비되면 첫 메시지 주입 ─────────────────────────────────────
/** 셸이 뜬 뒤 에이전트 준비(7501 idle 또는 화면 휴리스틱)를 기다리는 최대 시간. */
export const AGENT_READY_TIMEOUT_MS = 60000;
/** 탭이 아직 마운트되지 않은(다른 프로젝트에 만든) 경우 셸이 뜨기를 기다리는 최대 시간. */
export const AGENT_START_TIMEOUT_MS = 10 * 60 * 1000;
/** 새 탭이 React 상태에 반영되기 전이라 안 보일 수 있다 — 이 시간 동안은 "사라짐" 으로 보지 않는다. */
export const AGENT_GONE_GRACE_MS = 2000;
export const AGENT_READY_POLL_MS = 300;

export interface AgentBriefDeps {
  /** 탭이 (아직) 있는가. */
  exists: () => boolean;
  /** PTY(셸)가 떴는가 — 준비 대기 시계는 이때부터 잰다. */
  ptyStarted: () => boolean;
  /** 7501 롤업 상태(보고 없으면 undefined). */
  getState: () => AgentTabState | undefined;
  getTurn: () => number;
  /** 화면 휴리스틱(looksLikeAgentUiReady). */
  uiReady: () => boolean;
  inject: (text: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type AgentBriefOutcome =
  | { kind: 'gone' }
  | { kind: 'not-ready' }
  | { kind: 'sent'; ok: boolean; reason?: string; readyBy: '7501' | 'ui' | 'timeout'; sentTurn: number; sentWhileBlocked: boolean };

/**
 * 준비를 기다렸다가 브리프+프롬프트를 넣는다. 첫 검사는 첫 sleep 뒤에 하고, 탭이 안 보여도
 * AGENT_GONE_GRACE_MS 동안은 기다린다(addTerminal 직후 projectsRef 에 아직 없다). 준비 시간이
 * 지나면 셸 자식은 그냥 넣지만, 에이전트 자식은 맨 셸일 수 있어 넣지 않는다(`not-ready`).
 */
export async function runAgentBrief(
  deps: AgentBriefDeps,
  opts: { cliType: string; text: string; readyTimeoutMs?: number; startTimeoutMs?: number },
): Promise<AgentBriefOutcome> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? AGENT_READY_TIMEOUT_MS;
  const startTimeoutMs = opts.startTimeoutMs ?? AGENT_START_TIMEOUT_MS;
  const createdAt = deps.now();
  let ptyAt: number | null = null;
  let readyBy: '7501' | 'ui' | 'timeout' = 'timeout';
  for (;;) {
    await deps.sleep(AGENT_READY_POLL_MS);
    const now = deps.now();
    if (!deps.exists()) {
      if (now - createdAt >= AGENT_GONE_GRACE_MS) return { kind: 'gone' };
      continue;
    }
    if (ptyAt === null) {
      if (!deps.ptyStarted()) {
        if (now - createdAt >= startTimeoutMs) break;
        continue;
      }
      ptyAt = now;
    }
    if (deps.getState() === 'idle') { readyBy = '7501'; break; }
    if (deps.uiReady()) { readyBy = 'ui'; break; }
    if (now - ptyAt >= readyTimeoutMs) break;
  }
  if (readyBy === 'timeout' && opts.cliType !== 'shell') return { kind: 'not-ready' };
  // 화면 휴리스틱은 환영 문구를 본 시점이라 입력창이 아직 안 그려졌을 수 있다.
  await deps.sleep(readyBy === '7501' ? 300 : 1500);
  if (!deps.exists()) return { kind: 'gone' };
  const sentTurn = deps.getTurn();
  const sentWhileBlocked = deps.getState() === 'blocked';
  const res = await deps.inject(opts.text);
  return res.ok
    ? { kind: 'sent', ok: true, readyBy, sentTurn, sentWhileBlocked }
    : { kind: 'sent', ok: false, reason: res.reason, readyBy, sentTurn, sentWhileBlocked };
}

// ── 재시작 뒤에도 이어지게(docs/PTY_HOLDER_DAEMON.md 3.5-6): 링크를 프로젝트와 함께 저장 ──
export interface PersistedAgentLink {
  childId: string;
  parentId: string;
  name?: string;
  cliType?: string;
  createdAt?: number;
  lastNotifiedTurn: number;
  lastNotifiedState?: AgentNoteState;
  lastSendTurn?: number;
}

export function serializeAgentLinks(links: Iterable<AgentLink>): PersistedAgentLink[] {
  const out: PersistedAgentLink[] = [];
  for (const l of links) {
    if (!l?.childId || !l.parentId || l.exited) continue;
    out.push({
      childId: l.childId,
      parentId: l.parentId,
      name: l.name || undefined,
      cliType: l.cliType || undefined,
      createdAt: l.createdAt,
      lastNotifiedTurn: Number(l.lastNotifiedTurn) || 0,
      lastNotifiedState: l.lastNotifiedState,
      lastSendTurn: l.lastSendTurn,
    });
  }
  return out;
}

/** Saved links whose child and parent tabs still exist (others are pruned). */
export function restoreAgentLinks(raw: unknown, aliveIds: ReadonlySet<string>, now = Date.now()): AgentLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentLink[] = [];
  for (const r of raw) {
    if (!r || typeof r.childId !== 'string' || typeof r.parentId !== 'string') continue;
    if (!aliveIds.has(r.childId) || !aliveIds.has(r.parentId)) continue;
    const state = r.lastNotifiedState === 'blocked' || r.lastNotifiedState === 'done' || r.lastNotifiedState === 'exited' ? r.lastNotifiedState : undefined;
    out.push({
      childId: r.childId,
      parentId: r.parentId,
      name: typeof r.name === 'string' ? r.name : undefined,
      cliType: typeof r.cliType === 'string' ? r.cliType : undefined,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : now,
      lastNotifiedTurn: Number.isFinite(r.lastNotifiedTurn) ? r.lastNotifiedTurn : 0,
      lastNotifiedState: state,
      lastSendTurn: Number.isFinite(r.lastSendTurn) ? r.lastSendTurn : undefined,
    });
  }
  return out;
}
