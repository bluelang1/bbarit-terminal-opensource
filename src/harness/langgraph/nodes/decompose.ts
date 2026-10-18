/**
 * Decompose node — break the user's request into parallel sub-tasks.
 *
 * The actual decomposition is delegated to an injected executor (e.g. CLI/LLM).
 * For tests / offline fallback, a deterministic keyword-based decomposer is
 * provided.
 */
import type { UltraStateType } from '../state';

export type DecomposeExecutor = (prompt: string) => Promise<string>;

/** Prompt template used by the LLM executor. */
const DECOMPOSE_PROMPT = (userInput: string) => [
  `You are a task planner. Split the following user request into 2–5 independent sub-tasks`,
  `that can run in parallel. Return ONLY a JSON array of {"id": "t1", "description": "..."} objects.`,
  `No markdown, no extra text.`,
  '',
  `User request: ${userInput}`,
].join('\n');

/** Simple fallback when no executor is given (used in tests). */
function fallbackDecompose(userInput: string): Array<{ id: string; description: string }> {
  const lines = userInput.split(/[.;\n]/).map((s) => s.trim()).filter(Boolean);
  const parts = lines.length > 1 ? lines : [userInput];
  return parts.slice(0, 5).map((desc, i) => ({ id: `t${i + 1}`, description: desc }));
}

/** Robust JSON extraction — tolerates code fences and surrounding prose. */
export function extractTaskList(raw: string): Array<{ id: string; description: string }> | null {
  if (!raw) return null;
  const text = raw.trim().replace(/^```(?:json)?\n?/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((t) => t && typeof t.description === 'string')) {
      return parsed.map((t, i) => ({
        id: String(t.id || `t${i + 1}`),
        description: String(t.description),
      }));
    }
  } catch {
    // try to locate first JSON array block
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
  }
  return null;
}

export function makeDecomposeNode(executor?: DecomposeExecutor) {
  return async function decomposeNode(state: UltraStateType): Promise<Partial<UltraStateType>> {
    if (!executor) {
      return { tasks: fallbackDecompose(state.userInput) };
    }
    try {
      const raw = await executor(DECOMPOSE_PROMPT(state.userInput));
      const parsed = extractTaskList(raw);
      if (parsed && parsed.length > 0) return { tasks: parsed };
      return {
        tasks: fallbackDecompose(state.userInput),
        errors: ['decompose: failed to parse LLM output, used fallback'],
      };
    } catch (err) {
      return {
        tasks: fallbackDecompose(state.userInput),
        errors: [`decompose: executor error: ${String(err)}`],
      };
    }
  };
}
