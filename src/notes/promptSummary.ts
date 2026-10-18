/**
 * Summarize the user's recent terminal/prompt activity from PromptLibrary entries.
 *
 * The library auto-saves shell commands and CLI prompts (see XTerminal's onData
 * pipeline + savePromptToLibrary), so the entries are a fair proxy for "what the
 * user has been doing". We feed the most recent N entries to the unified aiChat()
 * provider and ask for a short Korean natural-language summary.
 */

import type { PromptEntry } from '../components/PromptLibraryPanel';
import { aiChat } from './ollamaTagging';

const MAX_ENTRIES = 30;
const MAX_TEXT_PER_ENTRY = 280;

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export interface SummarizeOptions {
  /** Restrict to entries belonging to this project path. */
  projectPath?: string;
  /** Override the default 30-entry window. */
  limit?: number;
}

export async function summarizeRecentPrompts(
  entries: PromptEntry[],
  opts: SummarizeOptions = {},
): Promise<string> {
  const pool = opts.projectPath
    ? entries.filter(e => e.projectPath === opts.projectPath)
    : entries;
  if (pool.length === 0) {
    throw new Error('저장된 프롬프트가 없습니다.');
  }

  const limit = opts.limit ?? MAX_ENTRIES;
  const recent = [...pool]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);

  const lines = recent.map(e => {
    const text = e.text.length > MAX_TEXT_PER_ENTRY
      ? `${e.text.slice(0, MAX_TEXT_PER_ENTRY)}…`
      : e.text;
    const stamp = formatStamp(e.updatedAt);
    return `[${stamp}] (×${e.useCount}) ${text.replace(/\n+/g, ' ')}`;
  });

  const systemPrompt = `당신은 개발자의 터미널 활동 로그를 요약하는 한국어 어시스턴트입니다.
다음 입력은 사용자가 최근 빠릿 터미널에서 실행했거나 AI에게 보낸 명령/프롬프트 기록(시간 역순)입니다.

요구사항:
- 한국어 평문으로 3~6줄 분량.
- "최근에는 …을(를) 했고, …도 함께 진행 중입니다" 류의 자연스러운 서술.
- 비슷한 명령은 묶어서 한 줄로 (예: git 관련, 빌드, 설치, 디버깅, 문서 작성, AI 프롬프트 등).
- 명령 그 자체보다는 "무엇을 하려고 했는지"에 초점.
- 마크다운/리스트/코드블록 사용 금지. 일반 문장만.
- 답변 앞뒤에 인사말이나 메타 설명을 넣지 말 것. 본문만.`;

  const userPrompt = lines.join('\n');

  const raw = await aiChat(systemPrompt, userPrompt);
  return raw.trim();
}
