/**
 * Synthesize node — combine sub-task results into a final answer.
 */
import type { UltraStateType } from '../state';

export type SynthesizeExecutor = (prompt: string) => Promise<string>;

const SYNTHESIZE_PROMPT = (userInput: string, parts: string) => [
  `Combine the following parallel sub-task results into a single cohesive response to the user.`,
  `Preserve facts, remove duplication, keep it concise.`,
  '',
  `User request: ${userInput}`,
  '',
  `Sub-results:`,
  parts,
].join('\n');

function fallbackSynthesize(state: UltraStateType): string {
  const tasks = state.tasks || [];
  const results = state.subResults || {};
  const lines = tasks.map((t) => `## ${t.description}\n${results[t.id] || '(no result)'}`);
  return lines.join('\n\n');
}

export function makeSynthesizeNode(executor?: SynthesizeExecutor) {
  return async function synthesizeNode(state: UltraStateType): Promise<Partial<UltraStateType>> {
    const tasks = state.tasks || [];
    if (tasks.length === 0) {
      return {
        finalAnswer: '',
        errors: ['synthesize: no tasks available'],
      };
    }
    if (!executor) {
      return { finalAnswer: fallbackSynthesize(state) };
    }
    const parts = tasks
      .map((t) => `- ${t.description}:\n${(state.subResults || {})[t.id] || '(missing)'}`)
      .join('\n\n');
    try {
      const answer = await executor(SYNTHESIZE_PROMPT(state.userInput, parts));
      return { finalAnswer: answer.trim() || fallbackSynthesize(state) };
    } catch (err) {
      return {
        finalAnswer: fallbackSynthesize(state),
        errors: [`synthesize: executor error: ${String(err)}`],
      };
    }
  };
}
