import {
  resumeWorkflowAfterPlanSelection,
  resumeWorkflowAfterSpecSelection,
  type PendingPlanReview,
  type PendingSpecReview,
  type TechnicalSpecOption,
  type WorkflowExecutionResult,
  type WorkflowExecutionTask,
  type WorkflowLabels,
} from './workflowExecutor';
import type { CliProvider } from './cliRuntime';
import type { HarnessResponseLanguage } from './prompting';
import type { HarnessMessageLike } from './threadState';
import type { WorkflowConfig, WorkflowExecutionProfile, WorkflowProvider } from './workflow';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';

interface BaseReviewRuntimeDeps {
  workDir: string;
  workflow: WorkflowConfig;
  executionProfile: WorkflowExecutionProfile;
  responseLanguage: HarnessResponseLanguage;
  labels: WorkflowLabels;
  ensureCliProvider: (provider: WorkflowProvider) => CliProvider;
  onStreamingContent: (content: string) => void;
  onPipelineUpdate: (tasks: WorkflowExecutionTask[]) => void;
  threadSummary?: string;
  threadMessages?: HarnessMessageLike[];
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  shouldAbort?: () => boolean;
  startTime: number;
}

export function getSelectedWorkflowOptions(
  options: TechnicalSpecOption[],
  selectedIds: string[],
): TechnicalSpecOption[] {
  if (!options.length || !selectedIds.length) return [];
  return options.filter((option) => selectedIds.includes(option.id));
}

export async function executeSpecReviewSelection(
  params: BaseReviewRuntimeDeps & {
    pending: PendingSpecReview;
    selectedIds: string[];
  },
): Promise<WorkflowExecutionResult | null> {
  const selectedOptions = getSelectedWorkflowOptions(params.pending.options, params.selectedIds);
  if (selectedOptions.length === 0) return null;
  return resumeWorkflowAfterSpecSelection({
    pending: params.pending,
    selectedOptions,
    startTime: params.startTime,
    workDir: params.workDir,
    workflow: params.workflow,
    executionProfile: params.executionProfile,
    responseLanguage: params.responseLanguage,
    labels: params.labels,
    ensureCliProvider: params.ensureCliProvider,
    onStreamingContent: params.onStreamingContent,
    onPipelineUpdate: params.onPipelineUpdate,
    threadSummary: params.threadSummary,
    threadMessages: params.threadMessages,
    providersOrRegistry: params.providersOrRegistry,
    shouldAbort: params.shouldAbort,
  });
}

export async function executePlanReviewSelection(
  params: BaseReviewRuntimeDeps & {
    pending: PendingPlanReview;
    selectedIds: string[];
  },
): Promise<WorkflowExecutionResult | null> {
  const selectedPlanOptions = getSelectedWorkflowOptions(params.pending.options, params.selectedIds);
  if (selectedPlanOptions.length === 0) return null;
  return resumeWorkflowAfterPlanSelection({
    pending: params.pending,
    selectedPlanOptions,
    startTime: params.startTime,
    workDir: params.workDir,
    workflow: params.workflow,
    executionProfile: params.executionProfile,
    responseLanguage: params.responseLanguage,
    labels: params.labels,
    ensureCliProvider: params.ensureCliProvider,
    onStreamingContent: params.onStreamingContent,
    onPipelineUpdate: params.onPipelineUpdate,
    threadSummary: params.threadSummary,
    threadMessages: params.threadMessages,
    providersOrRegistry: params.providersOrRegistry,
    shouldAbort: params.shouldAbort,
  });
}
