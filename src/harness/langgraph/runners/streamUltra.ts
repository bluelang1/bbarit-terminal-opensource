/**
 * Streaming variant of the Ultra-mode runner.
 *
 * Yields events as each node completes so the UI can show live progress
 * (e.g. "decompose: 4 tasks" → "executeParallel: t1 ok, t2 ok" → "synthesize: ...").
 */
import { buildUltraGraph, type UltraStateType, type UltraGraphExecutors } from '../index';
import { makeCliTextExecutor, type CliBackend } from '../executors/cliExecutor';
import {
  startEvent, nodeEvent, errorEvent, endEvent,
  type StreamEvent,
} from './streamEvents';

export interface StreamUltraModeOpts {
  userInput: string;
  backend: CliBackend;
  workDir?: string;
  timeoutSecs?: number;
  plannerBackend?: CliBackend;
  systemPrompt?: string;
  /** Allow injecting custom executors (e.g. in tests). Overrides CLI defaults. */
  executorsOverride?: UltraGraphExecutors;
}

export async function* streamUltraMode(
  opts: StreamUltraModeOpts,
): AsyncGenerator<StreamEvent<UltraStateType>> {
  const {
    userInput, backend, workDir, timeoutSecs, plannerBackend, systemPrompt, executorsOverride,
  } = opts;

  const planner = makeCliTextExecutor({
    backend: plannerBackend ?? backend, workDir, timeoutSecs,
  });
  const subAgent = makeCliTextExecutor({
    backend, workDir, timeoutSecs, systemPrompt,
  });
  const executors: UltraGraphExecutors = executorsOverride || {
    decompose: planner,
    subAgent,
    synthesize: planner,
  };

  const graph = buildUltraGraph(executors);

  const startTs = Date.now();
  yield startEvent<UltraStateType>();

  let finalState: UltraStateType = {
    userInput, tasks: [], subResults: {}, finalAnswer: undefined, errors: [],
  };

  try {
    const initial: UltraStateType = {
      userInput, tasks: [], subResults: {}, finalAnswer: undefined, errors: [],
    };
    const iter = await graph.stream(initial, { streamMode: 'updates' });
    for await (const chunk of iter) {
      // chunk is { nodeName: partialState }
      for (const [node, update] of Object.entries(chunk as Record<string, Partial<UltraStateType>>)) {
        yield nodeEvent<UltraStateType>(node, update);
        finalState = mergeUltra(finalState, update);
      }
    }
  } catch (err) {
    yield errorEvent<UltraStateType>(String(err));
  }

  yield endEvent<UltraStateType>(finalState, startTs);
}

function mergeUltra(prev: UltraStateType, partial: Partial<UltraStateType>): UltraStateType {
  return {
    userInput: partial.userInput ?? prev.userInput,
    tasks: partial.tasks ?? prev.tasks,
    subResults: partial.subResults ? { ...prev.subResults, ...partial.subResults } : prev.subResults,
    finalAnswer: partial.finalAnswer ?? prev.finalAnswer,
    errors: partial.errors ? [...prev.errors, ...partial.errors] : prev.errors,
  };
}
