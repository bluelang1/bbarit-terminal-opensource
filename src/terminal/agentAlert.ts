import type { AgentTabState } from './programStatus';

export type AgentAlert = 'blocked' | 'done' | null;

/**
 * OSC 7501 상태 전이에 따른 알림 종류(docs/AGENT_STATUS_OSC7501.md 4절 표).
 * - 앱 시작 직후 첫 보고: 알림 없음.
 * - → blocked (이전이 blocked 아님): 보고 있든 아니든 알림.
 * - working/blocked → done/idle: 안 보고 있을 때만 알림.
 * - 같은 상태 반복 보고(같은 턴): 알림 없음.
 * looking = 그 터미널이 활성 탭 AND 창 포커스 AND 문서가 보임.
 */
export function decideAgentAlert(
  prev: AgentTabState | null,
  next: AgentTabState,
  looking: boolean,
  firstReport: boolean,
): AgentAlert {
  if (firstReport) return null;
  if (prev === next) return null;
  if (next === 'blocked') return 'blocked';
  if ((prev === 'working' || prev === 'blocked') && (next === 'done' || next === 'idle')) {
    return looking ? null : 'done';
  }
  return null;
}

/** "보고 있다" 판정. document 가 없으면(테스트·SSR) 보고 있지 않은 것으로 본다. */
export function isUserLooking(isActiveTab: boolean, doc: Pick<Document, 'hasFocus' | 'hidden'> | undefined = typeof document !== 'undefined' ? document : undefined): boolean {
  if (!isActiveTab || !doc) return false;
  try {
    return doc.hasFocus() && !doc.hidden;
  } catch {
    return false;
  }
}

/** 상태 점·탭 툴팁 문구. blocked 는 kind 별 문구(BLOCKED_KIND_LABEL)를 우선한다. */
export const AGENT_STATE_LABEL: Record<AgentTabState, string> = {
  working: '작업 중',
  blocked: '입력 대기',
  done: '완료',
  idle: '대기',
};

export const BLOCKED_KIND_LABEL: Record<string, string> = {
  permission: '권한 승인 필요',
  question: '질문에 답해 주세요',
  auth: '로그인 필요',
};

/** blocked 알림 제목·본문. */
export function blockedAlertText(projectName: string, terminalName: string, kind?: string, msg?: string): { title: string; body: string } {
  const who = [projectName, terminalName].filter(Boolean).join(' · ') || '터미널';
  const title = `${who} 이(가) 기다립니다`;
  const label = (kind && BLOCKED_KIND_LABEL[kind]) || '';
  const body = [label, (msg || '').replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · ');
  return { title, body };
}

/** XTerminal → App: `octo-agent-status` 이벤트 detail. */
export interface AgentStatusEventDetail {
  terminalId: string;
  cliType?: string;
  state: AgentTabState;
  kind?: string;
  app?: string;
  msg?: string;
  turn: number;
  /** 이번 전이에서 낼 알림(decideAgentAlert 결과). */
  alert: AgentAlert;
  /** 전이 시점에 사용자가 그 터미널을 보고 있었는가. */
  looking: boolean;
  /** 레코드가 모두 지워져 7501 상태가 없어졌다(기존 I/O 기반 표시로 돌아감). */
  cleared?: boolean;
  /**
   * cleared 인데, 프로그램이 7501 지원을 새로 물어서(시작 질의) 비운 경우. 곧 자기 상태를 보고할
   * 프로그램이므로 그때까지 출력 유무로 "작업 중"을 추정하지 않는다.
   */
  reset?: boolean;
  /** 저장된 출력을 재생하다 나온 보고(과거 것). 에이전트 노트를 만들지 않는다. */
  replaying?: boolean;
}

export const AGENT_STATUS_EVENT = 'octo-agent-status';

/**
 * 지워진(cleared) 상태를 탭 표시에서 어떻게 둘지 정한다. 'idle' = 7501 을 쓰는 프로그램이 방금
 * 시작 질의를 보낸 것이라 자리를 idle 로 남긴다(화면 출력만으로 초록 "작업 중"이 되지 않게).
 * 'drop' = 항목을 지우고 기존 I/O 기반 표시로 돌아간다(프로그램 종료, 낡은 상태 정리 등).
 */
export function clearedStatusDisplay(d: Pick<AgentStatusEventDetail, 'cleared' | 'reset'>): 'idle' | 'drop' | null {
  if (!d.cleared) return null;
  return d.reset ? 'idle' : 'drop';
}

/** 진단용: 탭별 최근 상태 이벤트(최대 30개). `window.__bbaritAgentStatusLog(terminalId)` 로 읽는다. */
export interface AgentStatusLogEntry { at: number; state: AgentTabState; kind?: string; turn: number; cleared: boolean; reset: boolean; replaying: boolean }
const STATUS_LOG_MAX = 30;
const statusLog = new Map<string, AgentStatusLogEntry[]>();
export function recordAgentStatusLog(d: AgentStatusEventDetail, now: number = Date.now()): void {
  const list = statusLog.get(d.terminalId) ?? [];
  list.push({ at: now, state: d.state, kind: d.kind, turn: d.turn, cleared: !!d.cleared, reset: !!d.reset, replaying: !!d.replaying });
  if (list.length > STATUS_LOG_MAX) list.splice(0, list.length - STATUS_LOG_MAX);
  statusLog.set(d.terminalId, list);
}
export function readAgentStatusLog(terminalId?: string): Record<string, AgentStatusLogEntry[]> | AgentStatusLogEntry[] {
  if (terminalId) return [...(statusLog.get(terminalId) ?? [])];
  return Object.fromEntries([...statusLog].map(([k, v]) => [k, [...v]]));
}

/** 시작 질의 뒤 이 시간 안에 보고가 없으면 7501 을 쓰지 않는 프로그램으로 보고 I/O 기반 표시로 돌아간다. */
export const RESET_PLACEHOLDER_MS = 10_000;

/**
 * 탭에 보일 상태. 7501 항목이 있으면 그것을 따르고(본 done 은 idle), 없으면 출력 활동으로 추정한다.
 * `resetAt` 이 있는 항목은 시작 질의 직후의 자리 표시라 RESET_PLACEHOLDER_MS 동안만 idle 로 본다.
 */
export function displayAgentState(
  entry: { state: AgentTabState; turn: number; seenTurn: number; resetAt?: number } | undefined,
  busy: boolean,
  now: number = Date.now(),
): AgentTabState {
  if (entry && !(entry.resetAt !== undefined && now - entry.resetAt > RESET_PLACEHOLDER_MS)) {
    return entry.state === 'done' && entry.seenTurn >= entry.turn ? 'idle' : entry.state;
  }
  return busy ? 'working' : 'idle';
}
