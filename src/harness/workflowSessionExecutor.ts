import type { Artifact, TodoItem } from '../components/harness-utils';
import type { CliProvider } from './cliRuntime';
import {
  executeInitialWorkflow,
  type PendingPlanReview,
  type PendingSpecReview,
  type WorkflowAttachment,
  type WorkflowExecutionResult,
  type WorkflowExecutionTask,
  type WorkflowLabels,
} from './workflowExecutor';
import { executePlanReviewSelection, executeSpecReviewSelection } from './workflowReviewExecutor';
import { reduceWorkflowExecutionResultToThread } from './threadSessionRuntime';
import type { HarnessMessageLike } from './threadState';
import type { WorkflowConfig, WorkflowExecutionProfile, WorkflowProvider } from './workflow';
import type { HarnessResponseLanguage } from './prompting';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';

export type WorkflowSessionPresentation<TThread extends { messages: unknown[]; todos: TodoItem[]; summary?: string }> =
  | {
      kind: 'pending-spec-review';
      pending: PendingSpecReview;
      pipeline: WorkflowExecutionTask[];
      thread: Pick<TThread, 'todos'>;
    }
  | {
      kind: 'pending-plan-review';
      pending: PendingPlanReview;
      pipeline: WorkflowExecutionTask[];
      thread: Pick<TThread, 'todos'>;
    }
  | {
      kind: 'completed';
      thread: Pick<TThread, 'messages' | 'todos'>;
      primaryArtifact?: Artifact;
      followupSource: string;
      followupProvider: CliProvider;
    };

interface WorkflowRuntimeDeps {
  workDir: string;
  workflow: WorkflowConfig;
  executionProfile: WorkflowExecutionProfile;
  responseLanguage: HarnessResponseLanguage;
  labels: WorkflowLabels;
  ensureCliProvider: (provider: WorkflowProvider) => CliProvider;
  onStreamingContent: (content: string) => void;
  onPipelineUpdate: (tasks: WorkflowExecutionTask[]) => void;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  shouldAbort?: () => boolean;
}

function presentWorkflowResult<TThread extends { messages: unknown[]; todos: TodoItem[]; summary?: string }>(
  thread: TThread,
  result: WorkflowExecutionResult,
  createId: () => string,
): WorkflowSessionPresentation<TThread> {
  const transition = reduceWorkflowExecutionResultToThread(thread, result, createId);
  if (transition.kind === 'pending-spec-review') {
    return {
      kind: transition.kind,
      pending: transition.pending,
      pipeline: transition.pipeline,
      thread: transition.thread,
    };
  }
  if (transition.kind === 'pending-plan-review') {
    return {
      kind: transition.kind,
      pending: transition.pending,
      pipeline: transition.pipeline,
      thread: transition.thread,
    };
  }
  return {
    kind: 'completed',
    thread: transition.thread,
    primaryArtifact: transition.primaryArtifact,
    followupSource: transition.followupSource,
    followupProvider: transition.followupProvider,
  };
}

export async function runWorkflowSessionStart<TThread extends { messages: unknown[]; todos: TodoItem[]; summary?: string }>(
  params: WorkflowRuntimeDeps & {
    thread: TThread;
    threadId: string;
    msgText: string;
    startTime: number;
    attachments: WorkflowAttachment[];
    threadMessages: HarnessMessageLike[];
    createId: () => string;
  },
): Promise<WorkflowSessionPresentation<TThread>> {
  const result = await executeInitialWorkflow({
    threadId: params.threadId,
    msgText: params.msgText,
    startTime: params.startTime,
    attachments: params.attachments,
    workDir: params.workDir,
    workflow: params.workflow,
    executionProfile: params.executionProfile,
    responseLanguage: params.responseLanguage,
    labels: params.labels,
    ensureCliProvider: params.ensureCliProvider,
    onStreamingContent: params.onStreamingContent,
    onPipelineUpdate: params.onPipelineUpdate,
    threadSummary: params.thread.summary,
    threadMessages: params.threadMessages,
    providersOrRegistry: params.providersOrRegistry,
    shouldAbort: params.shouldAbort,
  });
  return presentWorkflowResult(params.thread, result, params.createId);
}

export async function runWorkflowSpecReviewSelection<TThread extends { messages: unknown[]; todos: TodoItem[]; summary?: string }>(
  params: WorkflowRuntimeDeps & {
    thread: TThread;
    pending: PendingSpecReview;
    selectedIds: string[];
    startTime: number;
    threadMessages: HarnessMessageLike[];
    createId: () => string;
  },
): Promise<WorkflowSessionPresentation<TThread> | null> {
  const result = await executeSpecReviewSelection({
    pending: params.pending,
    selectedIds: params.selectedIds,
    startTime: params.startTime,
    workDir: params.workDir,
    workflow: params.workflow,
    executionProfile: params.executionProfile,
    responseLanguage: params.responseLanguage,
    labels: params.labels,
    ensureCliProvider: params.ensureCliProvider,
    onStreamingContent: params.onStreamingContent,
    onPipelineUpdate: params.onPipelineUpdate,
    threadSummary: 'summary' in params.thread ? (params.thread as { summary?: string }).summary : undefined,
    threadMessages: params.threadMessages,
    providersOrRegistry: params.providersOrRegistry,
    shouldAbort: params.shouldAbort,
  });
  if (!result) return null;
  return presentWorkflowResult(params.thread, result, params.createId);
}

export async function runWorkflowPlanReviewSelection<TThread extends { messages: unknown[]; todos: TodoItem[]; summary?: string }>(
  params: WorkflowRuntimeDeps & {
    thread: TThread;
    pending: PendingPlanReview;
    selectedIds: string[];
    startTime: number;
    threadMessages: HarnessMessageLike[];
    createId: () => string;
  },
): Promise<WorkflowSessionPresentation<TThread> | null> {
  const result = await executePlanReviewSelection({
    pending: params.pending,
    selectedIds: params.selectedIds,
    startTime: params.startTime,
    workDir: params.workDir,
    workflow: params.workflow,
    executionProfile: params.executionProfile,
    responseLanguage: params.responseLanguage,
    labels: params.labels,
    ensureCliProvider: params.ensureCliProvider,
    onStreamingContent: params.onStreamingContent,
    onPipelineUpdate: params.onPipelineUpdate,
    threadSummary: 'summary' in params.thread ? (params.thread as { summary?: string }).summary : undefined,
    threadMessages: params.threadMessages,
    providersOrRegistry: params.providersOrRegistry,
    shouldAbort: params.shouldAbort,
  });
  if (!result) return null;
  return presentWorkflowResult(params.thread, result, params.createId);
}
