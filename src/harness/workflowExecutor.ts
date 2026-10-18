import { invoke } from '@tauri-apps/api/core';
import {
  extractArtifacts,
  extractFileBlocks,
  extractTodos,
  genId,
  isSuspiciousAgentResponse,
  parseSelectionOptions,
  type Artifact,
  type SelectionOption,
  type TodoItem,
} from '../components/harness-utils';
import {
  runCliPrompt,
  streamCliPrompt,
  type CliProvider,
  type RuntimeSubTask,
} from './cliRuntime';
import { renderHarnessStagePreview } from './responsePipeline';
import { formatRecentConversationContext, type HarnessMessageLike } from './threadState';
import { buildCompressedConversationContext } from './learningCompressionManager';
import {
  buildStagePrompt,
  type WorkflowConfig,
  type WorkflowExecutionProfile,
  type WorkflowProvider,
} from './workflow';
import type { HarnessResponseLanguage } from './prompting';
import { abortLearningAgentLoop, beginLearningAgentLoop, formatLearningAgentLoopContext } from './learningAgentLoop';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';
import { loadHarnessProjectDocsContext } from './projectDocs';
import {
  checkAtlasCloudKoriniModels,
  formatKoriniModelCheck,
  modelFromKoriniCheck,
  type AtlasCloudKoriniModelCheck,
} from './atlasCloudRuntime';
import { ensureKoriniNextStarter, ensureKoriniProjectDeliverables } from './koriniDeliverables';
import {
  buildWorkspaceAttachmentContext,
  type RuntimeAttachment,
} from './attachmentRuntime';

export interface WorkflowAttachment extends RuntimeAttachment {}

export interface TechnicalSpecOption extends SelectionOption {}

export interface PendingSpecReview {
  threadId: string;
  message: string;
  fileList: string;
  researchResult: string;
  options: TechnicalSpecOption[];
  selectedIds: string[];
}

export interface PendingPlanReview {
  threadId: string;
  message: string;
  fileList: string;
  researchResult: string;
  selectedSpecs: TechnicalSpecOption[];
  planResult: string;
  options: TechnicalSpecOption[];
  selectedIds: string[];
}

export interface WorkflowExecutionTask extends RuntimeSubTask {}

export interface WorkflowLabels {
  saved: string;
  files: string;
}

interface WorkflowRuntimeDeps {
  workDir: string;
  workflow: WorkflowConfig;
  executionProfile: WorkflowExecutionProfile;
  responseLanguage: HarnessResponseLanguage;
  labels: WorkflowLabels;
  ensureCliProvider: (provider: WorkflowProvider) => CliProvider;
  onStreamingContent: (content: string) => void;
  onPipelineUpdate: (tasks: WorkflowExecutionTask[]) => void;
  conversationContext?: string;
  learningContext?: string;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  shouldAbort?: () => boolean;
}

interface WorkflowRunCoreParams extends WorkflowRuntimeDeps {
  fileList: string;
  msgText: string;
  startTime: number;
  projectDocsContext?: string;
  attachmentContext?: string;
  initialCompletedStages?: WorkflowExecutionTask[];
  initialPreviousResults?: Record<string, string>;
  initialTodos?: TodoItem[];
  selectedSpecs?: TechnicalSpecOption[];
  selectedPlanOptions?: TechnicalSpecOption[];
  stageOffset?: number;
}

export type WorkflowExecutionResult =
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
      responseContent: string;
      artifacts: Artifact[];
      todos: TodoItem[];
      durationMs: number;
      followupSource: string;
      followupProvider: CliProvider;
      primaryArtifact?: Artifact;
    };

export function formatSelectedOptions(options: TechnicalSpecOption[]): string {
  return options.map((option, index) => (
    `Option ${index + 1}: ${option.title}\nSummary: ${option.summary}\nSpec:\n${option.spec}`
  )).join('\n\n---\n\n');
}

export function buildWorkflowSelectionSummary(
  selectedSpecs: TechnicalSpecOption[] = [],
  selectedPlanOptions: TechnicalSpecOption[] = [],
): string {
  const lines: string[] = [];
  if (selectedSpecs.length > 0) {
    lines.push(`Selected spec bundles: ${selectedSpecs.map(option => option.title).join(', ')}`);
  }
  if (selectedPlanOptions.length > 0) {
    lines.push(`Approved plan bundles: ${selectedPlanOptions.map(option => option.title).join(', ')}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

export async function buildWorkflowAttachmentContext(
  attachments: WorkflowAttachment[],
  workDir: string,
): Promise<string> {
  return buildWorkspaceAttachmentContext(attachments, workDir);
}

export async function loadWorkflowFileList(workDir: string): Promise<string> {
  try {
    const entries = await invoke<{ name: string; is_dir: boolean }[]>('read_directory', { path: workDir });
    return entries.map(entry => `${entry.is_dir ? '📁' : '📄'} ${entry.name}`).join('\n');
  } catch {
    return '';
  }
}

async function saveDraftFiles(result: string, workDir: string): Promise<string[]> {
  const fileBlocks = extractFileBlocks(result);
  const savedFiles: string[] = [];
  for (const fileBlock of fileBlocks) {
    try {
      const fullPath = fileBlock.path.startsWith('/') ? fileBlock.path : `${workDir}/${fileBlock.path}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir) await invoke('create_directory', { path: dir }).catch(() => {});
      await invoke('write_file', { path: fullPath, content: fileBlock.content });
      savedFiles.push(fileBlock.path);
    } catch (error) {
      console.warn('[WorkflowExecutor] Failed to save:', fileBlock.path, error);
    }
  }
  return savedFiles;
}

function buildSaveNotice(savedFiles: string[], labels: WorkflowLabels): string {
  if (savedFiles.length === 0) return '';
  return `\n\n**${labels.saved}** ${savedFiles.length} ${labels.files}:\n${savedFiles.map(file => `- \`${file}\``).join('\n')}`;
}

async function saveKoriniWorkflowDeliverables(params: {
  workDir: string;
  userRequest: string;
  workflowName: string;
  savedFiles: string[];
  finalSummary: string;
  reviewApproved?: boolean;
}): Promise<string[]> {
  const generated = await ensureKoriniProjectDeliverables(params.workDir, {
    userRequest: params.userRequest,
    workflowName: params.workflowName,
    changedFiles: params.savedFiles,
    finalSummary: params.finalSummary,
    reviewApproved: params.reviewApproved,
  });
  return Array.from(new Set([...params.savedFiles, ...generated]));
}

function buildReviewedResponseContent(params: {
  pipelineName: string;
  displayStageResult: string;
  lastImplResult: string;
  savedFiles: string[];
  labels: WorkflowLabels;
  selectedSpecs?: TechnicalSpecOption[];
  selectedPlanOptions?: TechnicalSpecOption[];
  reviewApproved: boolean;
}): string {
  const selectionSummary = buildWorkflowSelectionSummary(params.selectedSpecs, params.selectedPlanOptions);
  if (params.reviewApproved && params.savedFiles.length > 0) {
    return `**Workflow completed: ${params.pipelineName}**\n\n${selectionSummary}${params.displayStageResult}${buildSaveNotice(params.savedFiles, params.labels)}\n\n---\n\n${params.lastImplResult}`;
  }
  return `**Workflow stopped before saving: ${params.pipelineName}**\n\n${selectionSummary}${params.displayStageResult}\n\n---\n\nDraft:\n${params.lastImplResult}`;
}

function buildAutoSavedResponseContent(params: {
  pipelineName: string;
  lastImplResult: string;
  savedFiles: string[];
  labels: WorkflowLabels;
  selectedSpecs?: TechnicalSpecOption[];
  selectedPlanOptions?: TechnicalSpecOption[];
}): string {
  const selectionSummary = buildWorkflowSelectionSummary(params.selectedSpecs, params.selectedPlanOptions);
  return `**Workflow completed: ${params.pipelineName}**\n\n${selectionSummary}${params.lastImplResult}${buildSaveNotice(params.savedFiles, params.labels)}`;
}

async function runWorkflowStages(params: WorkflowRunCoreParams): Promise<WorkflowExecutionResult> {
  const enabledStages = params.workflow.stages.filter(stage => stage.enabled);
  const completedStages = params.initialCompletedStages || [];
  const startIndex = completedStages.length;
  let modelCheck: AtlasCloudKoriniModelCheck | null = null;
  let previousModelCheckText = '';
  if (
    startIndex === 0
    && enabledStages.some(stage => stage.provider === 'atlascloud')
  ) {
    params.onStreamingContent('시작 전 확인: Kimi, DeepSeek 4, Qwen 코드 최신 모델을 Atlas에서 확인하는 중...');
    try {
      modelCheck = await checkAtlasCloudKoriniModels();
      previousModelCheckText = formatKoriniModelCheck(modelCheck);
    } catch (error) {
      previousModelCheckText = [
        '시작 전 Atlas 최신 모델 확인: 실패',
        `이유: ${error instanceof Error ? error.message : String(error)}`,
        '초보자 안내: 연결키, Atlas 주소, 네트워크 상태를 확인해야 합니다. 그래도 작업은 저장된 기본 모델로 시도합니다.',
      ].join('\n');
    }
  }
  const stageQueue = enabledStages.slice(startIndex).map(stage => {
    if (stage.provider !== 'atlascloud' || !modelCheck) return { ...stage };
    const role = stage.role === 'research' || stage.promptTemplate === 'research'
      ? 'kimi'
      : stage.role === 'implement' || stage.promptTemplate === 'implement'
        ? 'qwenCode'
        : 'deepseek4';
    return {
      ...stage,
      model: modelFromKoriniCheck(modelCheck, role, stage.model || ''),
    };
  });
  const pipeline: WorkflowExecutionTask[] = [
    ...completedStages.map(stage => ({ ...stage })),
    ...stageQueue.map(stage => ({
      id: genId(),
      description: stage.name,
      provider: params.ensureCliProvider(stage.provider),
      status: 'pending' as const,
    })),
  ];
  const previousResults: Record<string, string> = { ...(params.initialPreviousResults || {}) };
  if (previousModelCheckText) previousResults.model_check = previousModelCheckText;
  const pipelineName = enabledStages.map(stage => stage.name).join(' → ');
  let planningTodos = [...(params.initialTodos || [])];
  let lastImplResult = '';
  let lastStageProvider: CliProvider = params.ensureCliProvider(enabledStages[enabledStages.length - 1]?.provider || 'atlascloud');
  let reviewRetryCount = 0;

  params.onPipelineUpdate([...pipeline]);

  for (let i = 0; i < stageQueue.length; i++) {
    if (params.shouldAbort?.()) break;

    const stage = stageQueue[i];
    const pipelineIdx = startIndex + i;
    const pipelineTask = pipeline[pipelineIdx];
    const stageModel = stage.model || 'Atlas default';

    params.onStreamingContent(`Workflow ${pipelineIdx + 1}/${pipeline.length}: ${stage.name} · model: ${stageModel}...`);
    pipeline[pipelineIdx] = {
      ...pipelineTask,
      status: 'running',
      startedAt: Date.now(),
    };
    params.onPipelineUpdate([...pipeline]);

    const prompt = buildStagePrompt(stage, {
      workDir: params.workDir,
      fileList: params.fileList,
      msgText: params.msgText,
      previousResults,
      projectDocsContext: params.projectDocsContext,
      attachmentContext: params.attachmentContext,
      conversationContext: params.conversationContext,
      learningContext: params.learningContext,
      effort: params.executionProfile.effort,
      responseLanguage: params.responseLanguage,
    });

    let stageResult = '';
    let streamedStageText = '';
    try {
      stageResult = await streamCliPrompt(
        params.ensureCliProvider(stage.provider),
        prompt,
        params.workDir,
        params.executionProfile.stageTimeoutSecs,
        (chunk) => {
          streamedStageText += chunk;
          const header = `**[${pipelineIdx + 1}/${pipeline.length}] ${stage.name}** (${stage.provider.replace('-cli', '')} · ${stageModel})\n\n`;
          params.onStreamingContent(header + renderHarnessStagePreview(streamedStageText, stage.provider));
        },
        stage.model,
      );
    } catch (error) {
      console.warn(`[WorkflowExecutor] Streaming failed for ${stage.provider}, falling back to oneshot:`, error);
      stageResult = await runCliPrompt(
        params.ensureCliProvider(stage.provider),
        prompt,
        params.workDir,
        params.executionProfile.stageTimeoutSecs,
        stage.model,
      );
    }

    if (isSuspiciousAgentResponse(stageResult)) {
      throw new Error(`${stage.name} (${stage.provider}) returned an unstructured response.`);
    }

    const cleanStageResult = renderHarnessStagePreview(stageResult, stage.provider);
    previousResults[stage.role] = cleanStageResult || '(내부 옵션 데이터만 반환되어 사용자용 요약이 비어 있습니다.)';
    lastStageProvider = params.ensureCliProvider(stage.provider);
    pipeline[pipelineIdx] = {
      ...pipeline[pipelineIdx],
      status: 'completed',
      result: cleanStageResult || stageResult,
      durationMs: Date.now() - (pipeline[pipelineIdx].startedAt || Date.now()),
    };
    params.onPipelineUpdate([...pipeline]);

    if (stage.promptTemplate === 'research' && pipelineIdx < enabledStages.length - 1) {
      const options = parseSelectionOptions(
        stageResult,
        'SPEC_OPTIONS_JSON',
        'Recommended spec',
        'Use the research result as the implementation spec.',
      ) as TechnicalSpecOption[];
      const recommended = options[0];
      if (recommended) {
        previousResults.selected_spec = [
          '코린이모드 자동 선택:',
          recommended.title,
          recommended.summary,
          recommended.spec,
        ].filter(Boolean).join('\n');
      }
      params.onStreamingContent(`방향 선택: 코린이모드가 추천 방향으로 자동 진행합니다.\n${recommended?.title || '추천 방향'}`);
    }

    if (stage.promptTemplate === 'plan' && pipelineIdx < enabledStages.length - 1) {
      const options = parseSelectionOptions(
        stageResult,
        'PLAN_OPTIONS_JSON',
        'Use the recommended plan',
        'Continue with the implementation plan as drafted.',
      ) as TechnicalSpecOption[];
      planningTodos = extractTodos(stageResult);
      const recommended = options[0];
      if (recommended) {
        previousResults.selected_plan = [
          '코린이모드 자동 선택:',
          recommended.title,
          recommended.summary,
          recommended.spec,
        ].filter(Boolean).join('\n');
      }
      params.onStreamingContent(`작업 계획: 코린이모드가 추천 계획으로 자동 구현을 시작합니다.\n${recommended?.title || '추천 계획'}`);
    }

    if (stage.promptTemplate === 'implement') {
      lastImplResult = stageResult;
      const nextTodos = extractTodos(stageResult);
      if (nextTodos.length > 0) planningTodos = nextTodos;
    }

    if (stage.promptTemplate === 'review' && lastImplResult) {
      const reviewApproved = /Verdict:\s*APPROVED/i.test(stageResult);
      if (!reviewApproved) {
        previousResults.review = stageResult;
        const latestImplementStage = [...stageQueue.slice(0, i)].reverse().find(candidate => candidate.promptTemplate === 'implement');
        if (latestImplementStage && reviewRetryCount < params.executionProfile.reviewRetryLimit) {
          reviewRetryCount += 1;
          const retrySuffix = `Retry ${reviewRetryCount}`;
          const retryImplementStage = {
            ...latestImplementStage,
            id: `${latestImplementStage.id}-retry-${reviewRetryCount}`,
            name: `${latestImplementStage.name} ${retrySuffix}`,
          };
          const retryReviewStage = {
            ...stage,
            id: `${stage.id}-retry-${reviewRetryCount}`,
            name: `${stage.name} ${retrySuffix}`,
          };
          stageQueue.splice(i + 1, 0, retryImplementStage, retryReviewStage);
          pipeline.push(
            {
              id: genId(),
              description: retryImplementStage.name,
              provider: params.ensureCliProvider(retryImplementStage.provider),
              status: 'pending',
            },
            {
              id: genId(),
              description: retryReviewStage.name,
              provider: params.ensureCliProvider(retryReviewStage.provider),
              status: 'pending',
            },
          );
          params.onPipelineUpdate([...pipeline]);
          continue;
        }
      }
      const draftSavedFiles = reviewApproved ? await saveDraftFiles(lastImplResult, params.workDir) : [];
      const savedFiles = reviewApproved
        ? await saveKoriniWorkflowDeliverables({
          workDir: params.workDir,
          userRequest: params.msgText,
          workflowName: pipelineName,
          savedFiles: draftSavedFiles,
          finalSummary: lastImplResult,
          reviewApproved,
        })
        : [];
      const artifacts = extractArtifacts(lastImplResult);
      return {
        kind: 'completed',
        responseContent: buildReviewedResponseContent({
          pipelineName,
          displayStageResult: renderHarnessStagePreview(stageResult, stage.provider) || '(empty)',
          lastImplResult,
          savedFiles,
          labels: params.labels,
          selectedSpecs: params.selectedSpecs,
          selectedPlanOptions: params.selectedPlanOptions,
          reviewApproved,
        }),
        artifacts,
        todos: planningTodos,
        durationMs: Date.now() - params.startTime,
        followupSource: stageResult,
        followupProvider: params.ensureCliProvider(stage.provider),
        primaryArtifact: artifacts[0],
      };
    }
  }

  if (lastImplResult) {
    const draftSavedFiles = await saveDraftFiles(lastImplResult, params.workDir);
    const savedFiles = await saveKoriniWorkflowDeliverables({
      workDir: params.workDir,
      userRequest: params.msgText,
      workflowName: pipelineName,
      savedFiles: draftSavedFiles,
      finalSummary: lastImplResult,
      reviewApproved: true,
    });
    const artifacts = extractArtifacts(lastImplResult);
    return {
      kind: 'completed',
      responseContent: buildAutoSavedResponseContent({
        pipelineName,
        lastImplResult,
        savedFiles,
        labels: params.labels,
        selectedSpecs: params.selectedSpecs,
        selectedPlanOptions: params.selectedPlanOptions,
      }),
      artifacts,
      todos: planningTodos,
      durationMs: Date.now() - params.startTime,
      followupSource: lastImplResult,
      followupProvider: lastStageProvider,
      primaryArtifact: artifacts[0],
    };
  }

  const lastResult = Object.values(previousResults).pop() || '(empty)';
  const artifacts = extractArtifacts(lastResult);
  return {
    kind: 'completed',
    responseContent: lastResult,
    artifacts,
    todos: planningTodos,
    durationMs: Date.now() - params.startTime,
    followupSource: lastResult,
    followupProvider: lastStageProvider,
    primaryArtifact: artifacts[0],
  };
}

export async function executeInitialWorkflow(params: WorkflowRuntimeDeps & {
  threadId: string;
  msgText: string;
  startTime: number;
  attachments: WorkflowAttachment[];
  threadMessages?: HarnessMessageLike[];
}): Promise<WorkflowExecutionResult> {
  const attachmentContext = await buildWorkflowAttachmentContext(params.attachments, params.workDir);
  const starterFiles = await ensureKoriniNextStarter(params.workDir, params.msgText);
  const fileList = await loadWorkflowFileList(params.workDir);
  const projectDocsContext = await loadHarnessProjectDocsContext(params.workDir);
  const conversationContext = params.conversationContext || buildCompressedConversationContext({
    messages: params.threadMessages || [],
    threadSummary: params.threadSummary,
  }) || formatRecentConversationContext(params.threadMessages || []);
  const loopContext = await beginLearningAgentLoop({
    workDir: params.workDir,
    query: params.msgText,
    threadSummary: params.threadSummary,
    providersOrRegistry: params.providersOrRegistry,
  });
  const learningContext = formatLearningAgentLoopContext(loopContext);
  try {
    const result = await runWorkflowStages({
      ...params,
      fileList,
      msgText: params.msgText,
      startTime: params.startTime,
      projectDocsContext,
      attachmentContext,
      conversationContext,
      learningContext,
      threadSummary: params.threadSummary,
      initialPreviousResults: starterFiles.length > 0
        ? {
          starter: [
            '코린이모드가 빈 폴더에서 바로 실행 가능한 Next.js 기본 앱을 먼저 만들었습니다.',
            '생성 파일:',
            ...starterFiles.map(file => `- ${file}`),
            '이 기본 앱 위에서 사용자의 요청에 맞게 화면, 데이터, 로그인, 결제, 배포 설정을 이어서 바꾸세요.',
          ].join('\n')
        }
        : undefined,
    });

    if (result.kind === 'pending-spec-review') {
      result.pending.threadId = params.threadId;
    }
    if (result.kind === 'pending-plan-review') {
      result.pending.threadId = params.threadId;
    }
    return result;
  } finally {
    await abortLearningAgentLoop(loopContext);
  }
}

export async function resumeWorkflowAfterSpecSelection(params: WorkflowRuntimeDeps & {
  pending: PendingSpecReview;
  selectedOptions: TechnicalSpecOption[];
  startTime: number;
  threadMessages?: HarnessMessageLike[];
}): Promise<WorkflowExecutionResult> {
  const enabledStages = params.workflow.stages.filter(stage => stage.enabled);
  const researchStage = enabledStages.find(stage => stage.promptTemplate === 'research');
  const researchStageTask: WorkflowExecutionTask | undefined = researchStage ? {
    id: genId(),
    description: researchStage.name,
    provider: params.ensureCliProvider(researchStage.provider),
    status: 'completed',
    result: params.pending.researchResult,
  } : undefined;
  const loopContext = await beginLearningAgentLoop({
    workDir: params.workDir,
    query: params.pending.message,
    threadSummary: params.threadSummary,
    providersOrRegistry: params.providersOrRegistry,
  });
  const learningContext = formatLearningAgentLoopContext(loopContext);
  const projectDocsContext = await loadHarnessProjectDocsContext(params.workDir);
  try {
    const result = await runWorkflowStages({
      ...params,
      fileList: params.pending.fileList,
      msgText: params.pending.message,
      startTime: params.startTime,
      projectDocsContext,
      conversationContext: params.conversationContext || buildCompressedConversationContext({
        messages: params.threadMessages || [],
        threadSummary: params.threadSummary,
      }) || formatRecentConversationContext(params.threadMessages || []),
      learningContext,
      threadSummary: params.threadSummary,
      initialCompletedStages: researchStageTask ? [researchStageTask] : [],
      initialPreviousResults: {
        research: `${params.pending.researchResult}\n\nUser-selected technical spec options:\n${formatSelectedOptions(params.selectedOptions)}`,
      },
      selectedSpecs: params.selectedOptions,
    });

    if (result.kind === 'pending-plan-review') {
      result.pending.threadId = params.pending.threadId;
      result.pending.researchResult = params.pending.researchResult;
      result.pending.selectedSpecs = params.selectedOptions;
    }
    return result;
  } finally {
    await abortLearningAgentLoop(loopContext);
  }
}

export async function resumeWorkflowAfterPlanSelection(params: WorkflowRuntimeDeps & {
  pending: PendingPlanReview;
  selectedPlanOptions: TechnicalSpecOption[];
  startTime: number;
  threadMessages?: HarnessMessageLike[];
}): Promise<WorkflowExecutionResult> {
  const enabledStages = params.workflow.stages.filter(stage => stage.enabled);
  const researchStage = enabledStages.find(stage => stage.promptTemplate === 'research');
  const planStage = enabledStages.find(stage => stage.promptTemplate === 'plan');
  const researchWithSelection = `${params.pending.researchResult}\n\nUser-selected technical spec options:\n${formatSelectedOptions(params.pending.selectedSpecs)}`;
  const approvedPlan = `${params.pending.planResult}\n\nUser-approved plan bundles:\n${formatSelectedOptions(params.selectedPlanOptions)}`;
  const initialCompletedStages: WorkflowExecutionTask[] = [];
  if (researchStage) {
    initialCompletedStages.push({
      id: genId(),
      description: researchStage.name,
      provider: params.ensureCliProvider(researchStage.provider),
      status: 'completed',
      result: researchWithSelection,
    });
  }
  if (planStage) {
    initialCompletedStages.push({
      id: genId(),
      description: planStage.name,
      provider: params.ensureCliProvider(planStage.provider),
      status: 'completed',
      result: approvedPlan,
    });
  }

  const loopContext = await beginLearningAgentLoop({
    workDir: params.workDir,
    query: params.pending.message,
    threadSummary: params.threadSummary,
    providersOrRegistry: params.providersOrRegistry,
  });
  const learningContext = formatLearningAgentLoopContext(loopContext);
  const projectDocsContext = await loadHarnessProjectDocsContext(params.workDir);
  try {
    return await runWorkflowStages({
      ...params,
      fileList: params.pending.fileList,
      msgText: params.pending.message,
      startTime: params.startTime,
      projectDocsContext,
      conversationContext: params.conversationContext || buildCompressedConversationContext({
        messages: params.threadMessages || [],
        threadSummary: params.threadSummary,
      }) || formatRecentConversationContext(params.threadMessages || []),
      learningContext,
      threadSummary: params.threadSummary,
      initialCompletedStages,
      initialPreviousResults: {
        research: researchWithSelection,
        plan: approvedPlan,
      },
      initialTodos: extractTodos(params.pending.planResult),
      selectedSpecs: params.pending.selectedSpecs,
      selectedPlanOptions: params.selectedPlanOptions,
    });
  } finally {
    await abortLearningAgentLoop(loopContext);
  }
}
