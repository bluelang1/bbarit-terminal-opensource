// OSC 133 셸 통합(FinalTerm 의미 프롬프트). xterm 의 registerOscHandler(133) 는 "133;" 뒤
// 페이로드만 넘긴다. 셸이 보내는 표식:
//   A  프롬프트 시작          B  프롬프트 끝(입력 시작)
//   C  명령 실행 시작         D[;<exit>]  명령 끝
// Ghostty·iTerm2·WezTerm 셸 통합은 뒤에 `;key=value` 옵션(aid, cl 등)을 붙이기도 한다.
// 설계: docs/SHELL_PROMPT_OSC133.md

export type Osc133Mark = 'A' | 'B' | 'C' | 'D';

export interface Osc133Event {
  mark: Osc133Mark;
  /** D 의 종료 코드(0–255). 없으면 undefined. */
  exitCode?: number;
}

const MARKS: readonly Osc133Mark[] = ['A', 'B', 'C', 'D'];

/**
 * OSC 133 페이로드를 해석한다. 모르는 표식, 빈 문자열, 0–255 정수가 아닌 D 종료 코드는 null.
 * A/B/C 뒤의 옵션(`;aid=…`)은 무시한다. D 는 두 번째 필드가 종료 코드다.
 */
export function parseOsc133(data: string): Osc133Event | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > 1024) return null;
  const fields = data.split(';');
  const mark = fields[0].trim() as Osc133Mark;
  if (!MARKS.includes(mark)) return null;
  if (mark !== 'D') return { mark };
  const code = fields[1]?.trim();
  if (code === undefined || code === '') return { mark };
  if (!/^\d{1,3}$/.test(code)) return null;
  const n = Number(code);
  if (n > 255) return null;
  return { mark, exitCode: n };
}
