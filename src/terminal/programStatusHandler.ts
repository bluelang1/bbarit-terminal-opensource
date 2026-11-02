// OSC 7501 수신 처리(XTerminal 의 registerOscHandler(7501) 본체). 터미널 상태 객체와
// 알림 콜백을 받는 순수 로직이라 XTerminal 없이 테스트한다.
// 설계: docs/AGENT_STATUS_OSC7501.md
import {
  applyProgramStatusReport,
  createProgramStatusStore,
  dropTransientProgramStatus,
  parseProgramStatus,
  programStatusQueryReply,
  rollupAgentState,
  type AgentTabState,
  type ProgramStatusStore,
} from './programStatus';
import { parseOsc133 } from './shellIntegration';

export interface ProgramStatusHost {
  writeToPty: ((data: string) => void) | null;
  programStatus?: ProgramStatusStore;
  /** writer 등록 전에 온 지원 질의 — 등록되면 답한다. */
  pendingStatusProbe?: boolean;
  /** 저장된 PTY 출력을 다시 그리는 중(재부착·팝아웃 복귀·웹뷰 새로고침). */
  replayingOutput?: boolean;
  // OSC 133 셸 통합 — docs/SHELL_PROMPT_OSC133.md. 기록만 하고 표시는 하지 않는다.
  /** 마지막 133 A(프롬프트 시작) 시각(ms). */
  lastPromptAt?: number;
  /** 마지막 133 C(명령 실행 시작) 시각(ms). */
  lastCommandStartAt?: number;
  /** 마지막 133 D 의 종료 코드. D 에 코드가 없으면 null. */
  lastCommandExitCode?: number | null;
}

export interface ProgramStatusChange {
  prev: AgentTabState;
  next: AgentTabState;
  /** true 면 알림을 내지 않는다(앱 시작 후 첫 보고, 또는 재생 중 보고). */
  firstReport: boolean;
  store: ProgramStatusStore;
}

export interface ProgramStatusCallbacks {
  onChange: (change: ProgramStatusChange) => void;
  /** 새 세션 질의로 이전 상태를 버렸을 때(표시를 비운다). */
  onReset?: () => void;
}

export function answerProgramStatusProbe(host: ProgramStatusHost): boolean {
  if (!host.writeToPty) return false;
  host.writeToPty(programStatusQueryReply());
  host.pendingStatusProbe = false;
  return true;
}

/**
 * 질의면 응답하고(재생 중이면 응답하지 않는다), 보고면 저장소에 반영한 뒤 onChange 를
 * 부른다. 재생 중 보고는 상태는 반영하되 firstReport 로 표시해 알림을 막는다.
 * 새 질의는 같은 탭에서 새 세션이 시작됐다는 뜻이라 이전 상태와 reported 를 버린다.
 */
export function handleProgramStatusOsc(
  host: ProgramStatusHost,
  data: string,
  callbacks: ProgramStatusCallbacks,
  now: number = Date.now(),
): boolean {
  const parsed = parseProgramStatus(data);
  if (!parsed) return true; // 잘못된 보고는 조용히 삼킨다
  if ('query' in parsed) {
    if (host.programStatus?.reported) {
      host.programStatus = createProgramStatusStore();
      callbacks.onReset?.();
    }
    // 재생된 질의는 이미 답한 것 — 살아 있는 프로세스에 응답을 또 쓰지 않는다.
    if (host.replayingOutput) return true;
    if (!answerProgramStatusProbe(host)) host.pendingStatusProbe = true;
    return true;
  }
  const store = host.programStatus ?? (host.programStatus = createProgramStatusStore());
  const firstReport = !store.reported || !!host.replayingOutput;
  const prev = rollupAgentState(store);
  applyProgramStatusReport(store, parsed);
  store.lastReportAt = now;
  callbacks.onChange({ prev, next: rollupAgentState(store), firstReport, store });
  return true;
}

/** 이 시간 동안 보고도 PTY 출력도 없으면 working/blocked 를 버린다. */
export const STALE_PROGRAM_STATUS_MS = 10 * 60 * 1000;

/**
 * 셸 안에서 에이전트 프로세스만 죽으면 pty-exit 가 오지 않아 working/blocked 가
 * 남는다. 마지막 보고와 마지막 PTY 출력이 모두 임계값보다 오래됐으면 낡은 상태로 본다.
 */
export function isProgramStatusStale(
  store: ProgramStatusStore | undefined,
  now: number,
  ptyIdleMs: number,
  thresholdMs: number = STALE_PROGRAM_STATUS_MS,
): boolean {
  if (!store?.reported) return false;
  const state = rollupAgentState(store);
  if (state !== 'working' && state !== 'blocked') return false;
  return now - store.lastReportAt >= thresholdMs && ptyIdleMs >= thresholdMs;
}

/**
 * OSC 133 셸 통합 처리. A(새 프롬프트)는 에이전트가 끝나고 셸로 돌아왔다는 뜻이라 7501 의
 * working/blocked 레코드를 버린다(done/error/idle 은 남긴다). 상태가 바뀌면 onChange 를
 * firstReport=true 로 불러 알림 없이 상태만 알린다. 재생 중에도 같다(상태 이벤트를 빼면
 * 재생된 7501 working 이 App 에 그대로 남는다). C/D 는 기록만, B 는 무시한다.
 */
export function handleShellIntegrationOsc(
  host: ProgramStatusHost,
  data: string,
  callbacks: Pick<ProgramStatusCallbacks, 'onChange'>,
  now: number = Date.now(),
): boolean {
  const parsed = parseOsc133(data);
  if (!parsed) return true;
  switch (parsed.mark) {
    case 'A': {
      host.lastPromptAt = now;
      const store = host.programStatus;
      if (!store?.reported) return true;
      const prev = rollupAgentState(store);
      dropTransientProgramStatus(store);
      const next = rollupAgentState(store);
      if (prev !== next) callbacks.onChange({ prev, next, firstReport: true, store });
      return true;
    }
    case 'C':
      host.lastCommandStartAt = now;
      return true;
    case 'D':
      host.lastCommandExitCode = parsed.exitCode ?? null;
      return true;
    default:
      return true;
  }
}
