// AI omnibox: classify what the user typed in the browser address bar.
//
// Before this, everything that was not a URL went straight to Google search.
// A question like "이 페이지 왜 느려?" or "summarize this page" is a task for the
// in-browser AI agent, not a web search — routing it to the agent from the address
// bar is the core interaction of an AI-first browser.
//
// D1: Heuristic classifier, no LLM call.
//     Reason: the address bar must react instantly and offline; a misroute costs one
//     extra keypress (the user can still search), not a broken flow.
//     Escape hatch: 'search' stays the default for anything ambiguous, so classic
//     browser behavior is preserved unless the text clearly addresses the agent.

import { normalizeUrl } from './browserSeoTarget';

export type OmniboxIntent =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string; query: string }
  | { kind: 'ask'; question: string };

// Korean sentence endings that address the agent (요청/질문형), e.g. …해줘, …알려줘,
// …뭐야, …어떻게 해, …analyze 계열 명령. Kept intentionally conservative.
const KO_ASK_RE = /(해줘|해 줘|해주세요|해봐|줄래|알려줘|알려 줘|뭐야|뭔가요|인가요|일까|할까|어때|어떻게|왜 |고쳐|분석해|요약해|정리해|설명해|번역해|비교해|찾아줘)/;

// English interrogatives / agent verbs at the start of the input.
const EN_ASK_LEAD_RE = /^(who|what|when|where|why|how|can|could|would|should|is|are|does|do|did|please|summarize|analyze|explain|translate|compare|fix|review|audit)\b/i;

function isUrlLike(raw: string): boolean {
  if (/^(https?:|file:|data:|about:)/i.test(raw)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(raw)) return true;
  return raw.includes('.') && !raw.includes(' ');
}

export function classifyOmniboxInput(input: string): OmniboxIntent {
  const raw = String(input || '').trim();
  if (!raw || isUrlLike(raw)) return { kind: 'url', url: normalizeUrl(raw) };

  // Explicit agent prefix always wins: "@ 질문" / "ai: question".
  const prefixed = raw.match(/^(?:@|ai:)\s*(.+)$/i);
  if (prefixed && prefixed[1].trim()) return { kind: 'ask', question: prefixed[1].trim() };

  const hasSpace = raw.includes(' ');
  const endsWithQuestion = /\?$/.test(raw);
  const looksAsk =
    (endsWithQuestion && hasSpace) ||
    KO_ASK_RE.test(raw) ||
    (hasSpace && EN_ASK_LEAD_RE.test(raw));
  if (looksAsk) return { kind: 'ask', question: raw };

  return { kind: 'search', url: normalizeUrl(raw), query: raw };
}
