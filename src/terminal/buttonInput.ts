// 사용자가 그 자리에서 누른 버튼이 터미널에 쓰는 경로(스킬 실행, 저장된 명령, 프롬프트 라이브러리,
// PM2 뷰어, 페르소나, 어시스트 바, Scrum/Harness 페이지, 노트 모달 등). 사용자가 방금 클릭했으므로
// blocked 검사(force)와 사람 입력 3 초 대기(quietMs: 0)는 건너뛰고, 직렬 큐·bracketed paste·
// Enter 분리·사람 키 보류는 자동 입력 게이트를 그대로 탄다. 설계: docs/TERMINAL_SCOPE_SWEEP.md
import { invoke } from '@tauri-apps/api/core';
import { queueAutoInput, type AutoInputResult } from './inputGate';

export interface ButtonInputOptions {
  /** 본문 뒤에 Enter 를 따로 보낸다(예전에 `\n`/`\r` 을 붙이던 호출). */
  submit: boolean;
  /** 본문과 Enter 사이 간격. 일반 셸이면 MIN_SUBMIT_DELAY_MS 를 넘긴다. */
  submitDelayMs?: number;
}

/**
 * 버튼 클릭 쓰기. 이 창에 마운트된 writer 가 없으면(팝아웃·별도 창·자체 PTY) 예전처럼
 * `write_to_pty` 로 PTY 에 직접 쓴다. 그 직접 쓰기가 실패하면(PTY 없음) `no-writer` 를 돌려준다.
 */
export async function queueButtonInput(
  terminalId: string,
  text: string,
  opts: ButtonInputOptions,
): Promise<AutoInputResult> {
  const direct: Promise<unknown>[] = [];
  const result = await queueAutoInput(terminalId, text, {
    source: 'button',
    submit: opts.submit,
    force: true,
    quietMs: 0,
    submitDelayMs: opts.submitDelayMs,
    fallbackWrite: (data) => { direct.push(invoke('write_to_pty', { terminalId, data })); },
  });
  const settled = await Promise.allSettled(direct);
  if (result.ok && settled.some((s) => s.status === 'rejected')) return { ok: false, reason: 'no-writer' };
  return result;
}
