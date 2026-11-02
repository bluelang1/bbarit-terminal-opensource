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
  /** 브리프 주입이 거부된 사유. */
  briefError?: string;
}

export type AgentNoteState = 'blocked' | 'done' | 'exited';

/** XTerminal 의 `octo-agent-status` detail 중 릴레이가 쓰는 필드. */
export interface AgentStatusSnapshot {
  state: AgentTabState;
  kind?: string;
  msg?: string;
  turn: number;
  cleared?: boolean;
}

/** 노트·브리프의 `from` 에 쓰는 짧은 표시 이름. */
export function agentLabel(id: string, name?: string): string {
  const clean = sanitizeAttr(name || '');
  return clean ? `${id} ${clean}` : id;
}

function sanitizeAttr(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

/** 본문을 한 줄로: 제어 문자 제거, 공백 접기, `</bbarit` 무력화, 길이 제한. */
export function oneLine(text: string, max = 300): string {
  const flat = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/<\/?bbarit/gi, (m) => m.replace('<', '‹'))
    .replace(/\s+/g, ' ')
    .trim();
  if (Array.from(flat).length <= max) return flat;
  return `${Array.from(flat).slice(0, max - 1).join('')}…`;
}

/** 마지막 비어 있지 않은 N 줄. */
export function lastNonEmptyLines(text: string, n = 3): string[] {
  return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);
}

export const CTL_REF = 'node "$BBARIT_CTL"';

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
    `You were started by another agent (terminal ${label}). When you finish or get stuck, report back`,
    'with the reach command above (one short message with the result or the question).',
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
    const body = oneLine(opts.msg || lastNonEmptyLines(opts.tail || '', 3).join(' / ') || '(no message)');
    return `<bbarit from="${from}" state="blocked"${kind}>${body} — 답하기: ${CTL_REF} agent send ${opts.childId} "…"</bbarit>`;
  }
  const turn = opts.state === 'done' && typeof opts.turn === 'number' ? ` turn="${opts.turn}"` : '';
  const body = oneLine(lastNonEmptyLines(opts.tail || '', 3).join(' / ') || '(no output)');
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
/** 7501 을 보고하지 않는 자식(셸 등)은 입력 뒤 이만큼 조용하면 끝난 것으로 본다. */
export const UNREPORTED_SETTLE_MS = 5000;

export interface AgentSettleInput {
  state: AgentTabState;
  turn: number;
  /** 7501 보고가 있는 터미널인가. */
  reported: boolean;
  exited?: boolean;
  link?: Pick<AgentLink, 'pending' | 'sentAt' | 'sentTurn' | 'sentWhileBlocked'>;
  now: number;
}

/**
 * agent wait / run 이 멈출 조건. 종료됐거나, blocked 거나, 마지막 입력 뒤 턴이 끝났다(done/idle).
 * 마지막 입력 시점에 이미 blocked 였고 같은 턴이면 아직 처리 전으로 본다.
 * 링크가 없는 터미널은 exited/blocked/done 만 끝으로 본다.
 */
export function isAgentSettled(s: AgentSettleInput): boolean {
  if (s.exited) return true;
  const link = s.link;
  if (!link) return s.state === 'blocked' || s.state === 'done';
  if (link.pending) return s.state === 'blocked';
  const sentTurn = link.sentTurn ?? -1;
  if (s.state === 'blocked') return !(link.sentWhileBlocked && s.turn === sentTurn);
  if (s.state === 'working') return false;
  if (s.reported) return s.turn > sentTurn;
  return s.now - (link.sentAt ?? 0) >= UNREPORTED_SETTLE_MS;
}

/** agent.run readiness: 7501 idle 보고 또는 기존 화면 휴리스틱. */
export const AGENT_READY_TIMEOUT_MS = 60000;
