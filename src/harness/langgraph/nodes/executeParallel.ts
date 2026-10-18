/**
 * Execute sub-tasks in parallel.
 *
 * Each task runs via the injected executor (CLI/LLM call). Failures become
 * error entries in state.errors but do not short-circuit other tasks.
 */
import type { UltraStateType } from '../state';

export type SubAgentExecutor = (taskDescription: string) => Promise<string>;

/** Default echoing executor (tests). */
async function echoExecutor(desc: string): Promise<string> {
  return `[echo] ${desc}`;
}

export function makeExecuteParallelNode(executor?: SubAgentExecutor) {
  const run = executor || echoExecutor;
  return async function executeParallelNode(state: UltraStateType): Promise<Partial<UltraStateType>> {
    const tasks = state.tasks || [];
    if (tasks.length === 0) {
      return { errors: ['executeParallel: no tasks to run'] };
    }
    const settled = await Promise.allSettled(
      tasks.map(async (t) => ({ id: t.id, result: await run(t.description) }))
    );
    const subResults: Record<string, string> = {};
    const errors: string[] = [];
    settled.forEach((outcome, idx) => {
      const task = tasks[idx];
      if (outcome.status === 'fulfilled') {
        subResults[outcome.value.id] = outcome.value.result;
      } else {
        errors.push(`executeParallel: task ${task?.id ?? idx} failed: ${String(outcome.reason)}`);
      }
    });
    return { subResults, errors };
  };
}
