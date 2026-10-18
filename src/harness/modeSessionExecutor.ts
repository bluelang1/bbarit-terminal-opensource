import { applyDirectResponsePresentationToThread } from './threadSessionRuntime';
import { executeImageGenerationMode, executeUltraMode, executeVideoGenerationMode } from './modeExecutor';
import { executeDirectResponse, type ResponseExecutorMemory, type ResponseExecutorMessage, type ResponseExecutorMode, type ResponseExecutorProvider, type ResponseExecutorSkill } from './responseExecutor';
import type { LearningReviewResult } from './learningRuntime';
import { presentDirectResponse, presentSimpleAssistantResponse } from './chatOutput';
import { estimateTokenUsage } from './tokenUsage';
import type { WorkflowExecutionProfile } from './workflow';
import type { CliProvider, DecomposedTask } from './cliRuntime';
import type { HarnessResponseLanguage } from './prompting';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';
import type {
  DirectResponseAssemblyOptions,
  DirectResponseMiddlewareContext,
  DirectResponseMiddlewareInput,
} from './middleware';
import type { TodoItem } from '../components/harness-utils';

export type ModeSubmissionRoute =
  | { kind: 'image-gen'; runtimeMode: 'image-gen'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'video-gen'; runtimeMode: 'video-gen'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'ultra'; runtimeMode: 'ultra'; runtimeUserMsg: string; isDirectCodingConversation: false }
  | { kind: 'direct-response'; runtimeMode: Exclude<ResponseExecutorMode, 'coding'> | 'thinking'; runtimeUserMsg: string; isDirectCodingConversation: boolean };

export type ModeSessionResult<TThread extends { messages: unknown[]; todos: TodoItem[]; title?: string }> =
  | { kind: 'pending-decompose'; tasks: DecomposedTask[]; pendingMessage: string }
  | {
      kind: 'completed';
      thread: TThread;
      primaryArtifact?: { id: string; filename: string; language: string; content: string };
      followups?: string[];
      followupSource?: string;
      followupProvider?: CliProvider;
      memorySummary?: string;
      learningReview?: LearningReviewResult;
    };

export async function runModeSession<TThread extends { messages: unknown[]; todos: TodoItem[]; title?: string }>(params: {
  route: ModeSubmissionRoute;
  thread: TThread;
  msgText: string;
  mode: ResponseExecutorMode;
  provider: ResponseExecutorProvider;
  memories: ResponseExecutorMemory[];
  skills: ResponseExecutorSkill[];
  workDir: string;
  executionProfile: WorkflowExecutionProfile;
  responseLanguage: HarnessResponseLanguage;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  ensureCliProvider: (provider: ResponseExecutorProvider) => CliProvider;
  middlewareAssembly?: DirectResponseAssemblyOptions;
  prepareDirectResponseContext?: (
    input: DirectResponseMiddlewareInput,
    options?: DirectResponseAssemblyOptions,
  ) => DirectResponseMiddlewareContext;
  forceProviderForMode?: ResponseExecutorProvider;
  ultraProviders: readonly CliProvider[];
  startTime: number;
  createId: () => string;
  onStreamingContent: (text: string) => void;
  onStreamingThinking: (text: string) => void;
  onStepProgress?: (text: string) => void;
  abortRef: { current: boolean };
}): Promise<ModeSessionResult<TThread>> {
  if (params.route.kind === 'image-gen') {
    const result = await executeImageGenerationMode(params.msgText, params.startTime);
    const presented = presentSimpleAssistantResponse({
      content: result.content,
      createId: params.createId,
      durationMs: result.durationMs,
      images: result.images,
      followups: result.followups,
      tokenUsage: estimateTokenUsage({
        promptText: params.msgText,
        completionText: result.content,
        warning: 'Image mode token usage is estimated; Gemini image API usage was not reported.',
      }),
    });
    return {
      kind: 'completed',
      thread: {
        ...params.thread,
        messages: [...params.thread.messages, presented.primaryMessage],
      } as TThread,
      followups: presented.followups,
    };
  }

  if (params.route.kind === 'video-gen') {
    const result = await executeVideoGenerationMode(params.msgText, params.startTime);
    const presented = presentSimpleAssistantResponse({
      content: result.content,
      createId: params.createId,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
      images: result.images,
      followups: result.followups,
      tokenUsage: estimateTokenUsage({
        promptText: params.msgText,
        completionText: result.content,
        warning: 'Video mode token usage is estimated; Gemini API usage was not reported.',
      }),
    });
    return {
      kind: 'completed',
      thread: {
        ...params.thread,
        messages: [...params.thread.messages, presented.primaryMessage],
      } as TThread,
      primaryArtifact: presented.primaryArtifact,
      followups: presented.followups,
    };
  }

  if (params.route.kind === 'ultra') {
    const result = await executeUltraMode(
      params.msgText,
      params.startTime,
      params.ensureCliProvider(params.provider),
      params.workDir,
      [...params.ultraProviders],
      params.executionProfile,
    );
    if (result.kind === 'pending-decompose') {
      return {
        kind: 'pending-decompose',
        tasks: result.tasks,
        pendingMessage: params.msgText,
      };
    }
    const presented = presentSimpleAssistantResponse({
      content: result.content,
      createId: params.createId,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
      tokenUsage: estimateTokenUsage({
        promptText: params.msgText,
        completionText: result.content,
        warning: 'Ultra fallback token usage is estimated from text length.',
      }),
    });
    return {
      kind: 'completed',
      thread: {
        ...params.thread,
        messages: [...params.thread.messages, presented.primaryMessage],
      } as TThread,
      primaryArtifact: presented.primaryArtifact,
    };
  }

  const result = await executeDirectResponse({
    mode: params.mode,
    provider: params.provider,
    msgText: params.msgText,
    runtimeUserMsg: params.route.runtimeUserMsg,
    workDir: params.workDir,
    memories: params.memories,
    skills: params.skills,
    threadMessages: params.thread.messages as ResponseExecutorMessage[],
    threadSummary: params.threadSummary,
    executionProfile: params.executionProfile,
    isDirectCodingConversation: params.route.isDirectCodingConversation,
    responseLanguage: params.responseLanguage,
    activeThreadTitle: params.thread.title,
    ensureCliProvider: params.ensureCliProvider,
    providersOrRegistry: params.providersOrRegistry,
    middlewareAssembly: params.middlewareAssembly,
    prepareContext: params.prepareDirectResponseContext,
    forceProviderForMode: params.forceProviderForMode,
    onStreamingContent: params.onStreamingContent,
    onStreamingThinking: params.onStreamingThinking,
    onStepProgress: params.onStepProgress,
    abortRef: params.abortRef,
  });

  const presented = presentDirectResponse(result, params.createId);
  return {
    kind: 'completed',
    thread: applyDirectResponsePresentationToThread(params.thread, presented) as TThread,
    primaryArtifact: presented.primaryArtifact,
    followupSource: presented.followupSource,
    followupProvider: presented.followupProvider,
    memorySummary: presented.memorySummary,
    learningReview: result.learningReview,
  };
}
