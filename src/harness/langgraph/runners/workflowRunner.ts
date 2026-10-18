/**
 * Workflow-mode runner — adapts the Workflow StateGraph for BBARIT.
 *
 * Runs the full spec → design → impl → test pipeline using a CLI backend.
 * Optional `reviewer` hook lets the UI prompt the user between stages for
 * Human-in-the-Loop. When a KvCheckpointSaver + threadId is supplied, the
 * run is resumable across app restarts.
 */
import { runWorkflowGraph, type WorkflowStateType } from '../index';
import type { Reviewer } from '../nodes/workflowStages';
import { makeCliTextExecutor, type CliBackend } from '../executors/cliExecutor';
import type { KvCheckpointSaver } from '../checkpointer';

export interface RunWorkflowModeOpts {
  userGoal: string;
  backend: CliBackend;
  workDir?: string;
  timeoutSecs?: number;
  /** Different backend per stage (optional). */
  specBackend?: CliBackend;
  designBackend?: CliBackend;
  implBackend?: CliBackend;
  testBackend?: CliBackend;
  /** HITL reviewer — returning 'approved' | 'revise' | 'reject'. */
  reviewer?: Reviewer;
  /** Persistence — when supplied, use the same threadId to resume later. */
  checkpointer?: KvCheckpointSaver;
  threadId?: string;
  /** Shared system prompt applied to every stage. */
  systemPrompt?: string;
}

export interface WorkflowRunResult extends WorkflowStateType {
  durationMs: number;
}

export async function runWorkflowMode(opts: RunWorkflowModeOpts): Promise<WorkflowRunResult> {
  const {
    userGoal,
    backend,
    workDir,
    timeoutSecs,
    specBackend,
    designBackend,
    implBackend,
    testBackend,
    reviewer,
    checkpointer,
    threadId,
    systemPrompt,
  } = opts;

  const make = (b: CliBackend) =>
    makeCliTextExecutor({ backend: b, workDir, timeoutSecs, systemPrompt });

  const t0 = performance.now();
  const state = await runWorkflowGraph(
    userGoal,
    {
      generateSpec: async (ctx, goal) => make(specBackend ?? backend)(`${ctx}\n\n${goal}`),
      generateDesign: async (ctx) => make(designBackend ?? backend)(ctx),
      generateImpl: async (ctx) => make(implBackend ?? backend)(ctx),
      generateTest: async (ctx) => make(testBackend ?? backend)(ctx),
      review: reviewer,
    },
    {
      checkpointer: checkpointer as any,
      threadId,
    },
  );
  return { ...state, durationMs: performance.now() - t0 };
}
