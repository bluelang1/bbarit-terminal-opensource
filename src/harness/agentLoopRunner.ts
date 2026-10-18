import type { CliProvider, DecomposedTask, RuntimeSubTask } from './cliRuntime';
import type { ModeSessionResult } from './modeSessionExecutor';
import type { HarnessRuntime } from './runtimeFactory';
import { completePresentedHarnessTurn, type CompleteHarnessTurnResult, type CompletionThread } from './turnCompletionRuntime';
import type { PendingPlanReview, PendingSpecReview, WorkflowExecutionTask } from './workflowExecutor';
import type { WorkflowSessionPresentation } from './workflowSessionExecutor';
import type { TodoItem } from '../components/harness-utils';

export type HarnessAgentLoopOutcome =
  | {
      kind: 'pending-decompose';
      tasks: DecomposedTask[];
      pendingMessage: string;
    }
  | {
      kind: 'pending-spec-review';
      pending: PendingSpecReview;
      pipeline: WorkflowExecutionTask[];
    }
  | {
      kind: 'pending-plan-review';
      pending: PendingPlanReview;
      pipeline: WorkflowExecutionTask[];
      todos: TodoItem[];
    }
  | {
      kind: 'completed';
      completion: CompleteHarnessTurnResult;
      pipeline?: WorkflowExecutionTask[] | RuntimeSubTask[];
    };

export type HarnessAgentLoopTurnParams<TThread extends CompletionThread & { todos: TodoItem[]; title?: string; summary?: string }> =
  | {
      kind: 'mode';
      executeSession: () => Promise<ModeSessionResult<TThread>>;
      harnessRuntime: HarnessRuntime;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
    }
  | {
      kind: 'workflow';
      executePresentation: () => Promise<WorkflowSessionPresentation<TThread> | null>;
      harnessRuntime: HarnessRuntime;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
    }
  | {
      kind: 'subagent';
      executeSubAgents: () => Promise<{
        pipeline: RuntimeSubTask[];
        mainContent: string;
        artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
        durationMs: number;
        followupSource: string;
      }>;
      harnessRuntime: HarnessRuntime;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
      appendAssistantMessage: (result: {
        pipeline: RuntimeSubTask[];
        mainContent: string;
        artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
        durationMs: number;
        followupSource: string;
      }) => TThread;
    };

export async function runHarnessAgentTurn<TThread extends CompletionThread & { todos: TodoItem[]; title?: string; summary?: string }>(
  params: HarnessAgentLoopTurnParams<TThread>,
): Promise<HarnessAgentLoopOutcome | null> {
  switch (params.kind) {
    case 'mode':
      return runHarnessModeTurn(params);
    case 'workflow':
      return runHarnessWorkflowTurn(params);
    case 'subagent':
      return runHarnessSubAgentTurn(params);
    default:
      return null;
  }
}

export async function runHarnessModeTurn<TThread extends CompletionThread & { todos: TodoItem[]; title?: string; summary?: string }>(params: {
  executeSession: () => Promise<ModeSessionResult<TThread>>;
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: TThread;
  userMessage: string;
  summaryTimeoutSecs: number;
  defaultFollowupProvider: CliProvider;
}): Promise<HarnessAgentLoopOutcome> {
  const sessionResult = await params.executeSession();
  if (sessionResult.kind === 'pending-decompose') {
    return {
      kind: 'pending-decompose',
      tasks: sessionResult.tasks,
      pendingMessage: sessionResult.pendingMessage,
    };
  }

  return {
    kind: 'completed',
    completion: await completePresentedHarnessTurn({
      harnessRuntime: params.harnessRuntime,
      workDir: params.workDir,
      mode: params.mode,
      provider: params.provider,
      threadBefore: params.threadBefore,
      userMessage: params.userMessage,
      presentation: {
        thread: sessionResult.thread,
        primaryArtifact: sessionResult.primaryArtifact,
        memorySummary: sessionResult.memorySummary,
        learningReview: sessionResult.learningReview,
        followupSource: sessionResult.followupSource,
        followupProvider: sessionResult.followupProvider,
        followups: sessionResult.followups,
        providerSyncHandled: true,
      },
      summaryTimeoutSecs: params.summaryTimeoutSecs,
      defaultFollowupProvider: params.defaultFollowupProvider,
    }),
  };
}

export async function runHarnessWorkflowTurn<TThread extends CompletionThread & { todos: TodoItem[]; title?: string; summary?: string }>(params: {
  executePresentation: () => Promise<WorkflowSessionPresentation<TThread> | null>;
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: TThread;
  userMessage: string;
  summaryTimeoutSecs: number;
  defaultFollowupProvider: CliProvider;
}): Promise<HarnessAgentLoopOutcome | null> {
  const presentation = await params.executePresentation();
  if (!presentation) return null;

  if (presentation.kind === 'pending-spec-review') {
    return {
      kind: 'pending-spec-review',
      pending: presentation.pending,
      pipeline: presentation.pipeline,
    };
  }

  if (presentation.kind === 'pending-plan-review') {
    return {
      kind: 'pending-plan-review',
      pending: presentation.pending,
      pipeline: presentation.pipeline,
      todos: presentation.thread.todos,
    };
  }

  return {
    kind: 'completed',
    pipeline: presentation.kind === 'completed' ? [] : undefined,
    completion: await completePresentedHarnessTurn({
      harnessRuntime: params.harnessRuntime,
      workDir: params.workDir,
      mode: params.mode,
      provider: params.provider,
      threadBefore: params.threadBefore,
      userMessage: params.userMessage,
      presentation,
      summaryTimeoutSecs: params.summaryTimeoutSecs,
      defaultFollowupProvider: params.defaultFollowupProvider,
    }),
  };
}

export async function runHarnessSubAgentTurn<TThread extends CompletionThread & { todos: TodoItem[]; title?: string; summary?: string }>(params: {
  executeSubAgents: () => Promise<{
    pipeline: RuntimeSubTask[];
    mainContent: string;
    artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
    durationMs: number;
    followupSource: string;
  }>;
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: TThread;
  userMessage: string;
  summaryTimeoutSecs: number;
  defaultFollowupProvider: CliProvider;
  appendAssistantMessage: (result: {
    pipeline: RuntimeSubTask[];
    mainContent: string;
    artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
    durationMs: number;
    followupSource: string;
  }) => TThread;
}): Promise<HarnessAgentLoopOutcome> {
  const result = await params.executeSubAgents();
  const threadAfter = params.appendAssistantMessage(result);

  return {
    kind: 'completed',
    pipeline: result.pipeline,
    completion: await completePresentedHarnessTurn({
      harnessRuntime: params.harnessRuntime,
      workDir: params.workDir,
      mode: params.mode,
      provider: params.provider,
      threadBefore: params.threadBefore,
      userMessage: params.userMessage,
      presentation: {
        thread: threadAfter,
        followupSource: result.followupSource,
        followupProvider: params.defaultFollowupProvider,
      },
      summaryTimeoutSecs: params.summaryTimeoutSecs,
      defaultFollowupProvider: params.defaultFollowupProvider,
    }),
  };
}
