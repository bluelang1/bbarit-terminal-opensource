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
}

export const AGENT_STATUS_EVENT = 'octo-agent-status';
