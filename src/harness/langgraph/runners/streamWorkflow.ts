/**
 * Streaming variant of the Workflow-mode runner.
 */
import { buildWorkflowGraph, type WorkflowStateType, type WorkflowGraphExecutors } from '../index';
import type { Reviewer } from '../nodes/workflowStages';
import { makeCliTextExecutor, type CliBackend } from '../executors/cliExecutor';
import type { KvCheckpointSaver } from '../checkpointer';
import {
  startEvent, nodeEvent, errorEvent, endEvent,
  type StreamEvent,
} from './streamEvents';

export interface StreamWorkflowModeOpts {
  userGoal: string;
  backend: CliBackend;
  workDir?: string;
  timeoutSecs?: number;
  specBackend?: CliBackend;
  designBackend?: CliBackend;
  implBackend?: CliBackend;
  testBackend?: CliBackend;
  reviewer?: Reviewer;
  checkpointer?: KvCheckpointSaver;
  threadId?: string;
  systemPrompt?: string;
  executorsOverride?: WorkflowGraphExecutors;
}

export async function* streamWorkflowMode(
  opts: StreamWorkflowModeOpts,
): AsyncGenerator<StreamEvent<WorkflowStateType>> {
  const {
    userGoal, backend, workDir, timeoutSecs,
    specBackend, designBackend, implBackend, testBackend,
    reviewer, checkpointer, threadId, systemPrompt, executorsOverride,
  } = opts;

  const make = (b: CliBackend) =>
    makeCliTextExecutor({ backend: b, workDir, timeoutSecs, systemPrompt });
  const executors: WorkflowGraphExecutors = executorsOverride || {
    generateSpec: async (ctx, goal) => make(specBackend ?? backend)(`${ctx}\n\n${goal}`),
    generateDesign: async (ctx) => make(designBackend ?? backend)(ctx),
    generateImpl: async (ctx) => make(implBackend ?? backend)(ctx),
    generateTest: async (ctx) => make(testBackend ?? backend)(ctx),
    review: reviewer,
  };

  const graph = buildWorkflowGraph(executors, { checkpointer: checkpointer as any });
  const config = threadId ? { configurable: { thread_id: threadId } } : undefined;

  const startTs = Date.now();
  yield startEvent<WorkflowStateType>();

  let finalState: WorkflowStateType = {
    userGoal,
    currentStage: 'spec',
    outputs: {},
    reviewDecision: 'pending',
    revisionCounts: {},
    errors: [],
    finalAnswer: undefined,
  };

  try {
    const initial: WorkflowStateType = { ...finalState };
    const iter = await graph.stream(initial, { ...config, streamMode: 'updates' });
    for await (const chunk of iter) {
      for (const [node, update] of Object.entries(chunk as Record<string, Partial<WorkflowStateType>>)) {
        yield nodeEvent<WorkflowStateType>(node, update);
        finalState = mergeWorkflow(finalState, update);
      }
    }
  } catch (err) {
    yield errorEvent<WorkflowStateType>(String(err));
  }

  yield endEvent<WorkflowStateType>(finalState, startTs);
}

function mergeWorkflow(prev: WorkflowStateType, p: Partial<WorkflowStateType>): WorkflowStateType {
  return {
    userGoal: p.userGoal ?? prev.userGoal,
    currentStage: p.currentStage ?? prev.currentStage,
    outputs: p.outputs ? { ...prev.outputs, ...p.outputs } : prev.outputs,
    reviewDecision: p.reviewDecision ?? prev.reviewDecision,
    revisionCounts: p.revisionCounts ? { ...prev.revisionCounts, ...p.revisionCounts } : prev.revisionCounts,
    errors: p.errors ? [...prev.errors, ...p.errors] : prev.errors,
    finalAnswer: p.finalAnswer ?? prev.finalAnswer,
  };
}
