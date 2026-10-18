/**
 * Ultra-mode runner — adapts the LangGraph Ultra StateGraph to BBARIT's
 * existing inputs (user prompt + active CLI + project path).
 *
 * Usage (from AgentHarnessPanel Ultra branch):
 *   const { finalAnswer, errors } = await runUltraMode({
 *     userInput, backend: 'claude', workDir: activeProject.workDir,
 *   });
 */
import { runUltraGraph, type UltraStateType } from '../index';
import { makeCliTextExecutor, type CliBackend } from '../executors/cliExecutor';

export interface RunUltraModeOpts {
  userInput: string;
  backend: CliBackend;
  workDir?: string;
  timeoutSecs?: number;
  /** Use a different backend just for the decompose / synthesize stages. */
  plannerBackend?: CliBackend;
  /** Override system prompt for all sub-agent calls. */
  systemPrompt?: string;
}

export interface UltraRunResult extends UltraStateType {
  durationMs: number;
}

export async function runUltraMode(opts: RunUltraModeOpts): Promise<UltraRunResult> {
  const { userInput, backend, workDir, timeoutSecs, plannerBackend, systemPrompt } = opts;
  const planner = makeCliTextExecutor({
    backend: plannerBackend ?? backend,
    workDir,
    timeoutSecs,
  });
  const subAgent = makeCliTextExecutor({
    backend,
    workDir,
    timeoutSecs,
    systemPrompt,
  });

  const t0 = performance.now();
  const state = await runUltraGraph(userInput, {
    decompose: planner,
    subAgent,
    synthesize: planner,
  });
  return { ...state, durationMs: performance.now() - t0 };
}
