/**
 * Ultra mode StateGraph — Plane-style parallel agent execution.
 *
 * Flow:
 *   __start__ → decompose → executeParallel → synthesize → END
 *
 * All LLM/CLI calls are injected via executors so the graph is pure and
 * fully testable.
 */
import { StateGraph, START, END } from '@langchain/langgraph';
import { UltraState, type UltraStateType } from './state';
import { makeDecomposeNode, type DecomposeExecutor } from './nodes/decompose';
import { makeExecuteParallelNode, type SubAgentExecutor } from './nodes/executeParallel';
import { makeSynthesizeNode, type SynthesizeExecutor } from './nodes/synthesize';

export interface UltraGraphExecutors {
  /** Used to split user input into sub-tasks. */
  decompose?: DecomposeExecutor;
  /** Runs each sub-task in parallel. */
  subAgent?: SubAgentExecutor;
  /** Combines sub-results into a final answer. */
  synthesize?: SynthesizeExecutor;
}

export function buildUltraGraph(executors: UltraGraphExecutors = {}) {
  return new StateGraph(UltraState)
    .addNode('decompose', makeDecomposeNode(executors.decompose))
    .addNode('executeParallel', makeExecuteParallelNode(executors.subAgent))
    .addNode('synthesize', makeSynthesizeNode(executors.synthesize))
    .addEdge(START, 'decompose')
    .addEdge('decompose', 'executeParallel')
    .addEdge('executeParallel', 'synthesize')
    .addEdge('synthesize', END)
    .compile();
}

/**
 * Convenience runner used by the UI / agentLoopRunner.
 * Returns the terminal state.
 */
export async function runUltraGraph(
  userInput: string,
  executors: UltraGraphExecutors = {},
): Promise<UltraStateType> {
  const graph = buildUltraGraph(executors);
  const result = await graph.invoke({
    userInput,
    tasks: [],
    subResults: {},
    finalAnswer: undefined,
    errors: [],
  });
  return result;
}
