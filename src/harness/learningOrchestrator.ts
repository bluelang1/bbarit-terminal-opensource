import { runBackgroundLearningReview, type LearningReviewResult } from './learningRuntime';
import { shouldCompressThread, summarizeThreadForCompression } from './learningCompressionManager';
import { appendLearningTrajectory, recordSessionEntry } from './learningSessionStore';
import { persistReviewSkills } from './learningSkillManager';
import { createLearningMemoryManager } from './learningMemoryManager';
import { syncLearningProviderTurn } from './learningAgentLoop';
import {
  markReviewProvenance,
  spawnBackgroundReview,
  type BackgroundReviewChannel,
} from './learningBackgroundReview';
import type { CliProvider } from './cliRuntime';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';

export interface LearningOrchestratorMessage {
  role: 'human' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: Array<{ name: string }>;
  artifacts?: Array<{ filename: string }>;
}

export interface LearningOrchestratorThread {
  id: string;
  title?: string;
  summary?: string;
  messages: LearningOrchestratorMessage[];
}

export interface LearningOrchestratorResult {
  review?: LearningReviewResult;
  compressedSummary?: string;
  learnedSkillsChanged: boolean;
}

export interface FinalizeCompletedTurnResult extends LearningOrchestratorResult {
  effectiveReview?: LearningReviewResult;
}

export async function orchestrateCompletedTurn(params: {
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: LearningOrchestratorThread;
  threadAfter: LearningOrchestratorThread;
  userMessage: string;
  directLearningReview?: LearningReviewResult;
  followupProvider: CliProvider;
  summaryTimeoutSecs: number;
  reviewChannels?: BackgroundReviewChannel[];
  onReviewError?: (err: unknown) => void;
}): Promise<LearningOrchestratorResult> {
  const newAssistantMessages = params.threadAfter.messages
    .slice(params.threadBefore.messages.length)
    .filter((message) => message.role === 'assistant');

  const combinedAssistantSummary = newAssistantMessages
    .map((message) => message.content)
    .join('\n\n---\n\n')
    .slice(0, 2400);

  if (combinedAssistantSummary.trim()) {
    const toolNames = newAssistantMessages.flatMap((message) => (message.toolCalls || []).map((tool) => tool.name));
    const savedFiles = Array.from(
      combinedAssistantSummary.matchAll(/`([^`\n]+\.[^`\n]+)`/g),
      (match) => match[1],
    ).slice(0, 12);
    const artifactNames = newAssistantMessages.flatMap((message) => (message.artifacts || []).map((artifact) => artifact.filename));
    await recordSessionEntry(params.workDir, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      threadId: params.threadBefore.id,
      title: params.threadAfter.title || params.userMessage.slice(0, 80),
      workDir: params.workDir,
      mode: params.mode,
      provider: params.provider,
      userMessage: params.userMessage,
      assistantSummary: combinedAssistantSummary,
      toolNames,
      savedFiles,
      artifactNames,
      createdAt: Date.now(),
    });
  }

  await appendLearningTrajectory({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId: params.threadAfter.id,
    workDir: params.workDir,
    title: params.threadAfter.title || params.userMessage.slice(0, 80),
    mode: params.mode,
    provider: params.provider,
    messagesJson: JSON.stringify(params.threadAfter.messages.slice(-40)),
    reviewJson: params.directLearningReview ? JSON.stringify(params.directLearningReview) : null,
    createdAt: Date.now(),
  });

  let review = params.directLearningReview;
  if (!review && combinedAssistantSummary.trim().length >= 280) {
    review = await runBackgroundLearningReview({
      provider: params.followupProvider,
      workDir: params.workDir,
      threadTitle: params.threadAfter.title,
      userMessage: params.userMessage,
      assistantContent: combinedAssistantSummary,
      threadMessages: params.threadAfter.messages,
      timeoutSecs: params.summaryTimeoutSecs,
    });
  }

  if (review) {
    review = markReviewProvenance(review);
  }

  let learnedSkillsChanged = false;
  if (review?.skills?.length) {
    await persistReviewSkills(params.workDir, review);
    learnedSkillsChanged = true;
  }

  if (review && params.reviewChannels?.length) {
    // Report the "💾" summary out-of-band; never delays turn completion.
    const reviewedTurn = review;
    spawnBackgroundReview({
      runReview: async () => reviewedTurn,
      channels: params.reviewChannels,
      onError: params.onReviewError,
    });
  }

  let compressedSummary: string | undefined;
  if (shouldCompressThread(params.threadAfter.messages?.length || 0)) {
    compressedSummary = await summarizeThreadForCompression({
      provider: params.followupProvider,
      workDir: params.workDir,
      threadTitle: params.threadAfter.title,
      messages: params.threadAfter.messages,
      timeoutSecs: params.summaryTimeoutSecs,
    });
  }

  return {
    review,
    compressedSummary,
    learnedSkillsChanged,
  };
}

export async function finalizeCompletedTurn(params: {
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: LearningOrchestratorThread;
  threadAfter: LearningOrchestratorThread;
  userMessage: string;
  directLearningReview?: LearningReviewResult;
  followupProvider: CliProvider;
  summaryTimeoutSecs: number;
  providersOrRegistry: LearningProvider[] | LearningProviderRegistry;
  providerSyncHandled?: boolean;
  reviewChannels?: BackgroundReviewChannel[];
  onReviewError?: (err: unknown) => void;
}): Promise<FinalizeCompletedTurnResult> {
  const orchestration = await orchestrateCompletedTurn({
    workDir: params.workDir,
    mode: params.mode,
    provider: params.provider,
    threadBefore: params.threadBefore,
    threadAfter: params.threadAfter,
    userMessage: params.userMessage,
    directLearningReview: params.directLearningReview,
    followupProvider: params.followupProvider,
    summaryTimeoutSecs: params.summaryTimeoutSecs,
    reviewChannels: params.reviewChannels,
    onReviewError: params.onReviewError,
  });

  const effectiveReview = params.directLearningReview || orchestration.review;
  if (!params.providerSyncHandled) {
    const memoryManager = createLearningMemoryManager(params.workDir, params.providersOrRegistry);
    await memoryManager.initialize();
    try {
      await syncLearningProviderTurn({
        memoryManager,
        userMessage: params.userMessage,
        assistantMessage: params.threadAfter.messages
          .filter((message) => message.role === 'assistant')
          .slice(-3)
          .map((message) => message.content)
          .join('\n\n---\n\n')
          .slice(0, 4000),
        review: effectiveReview,
      });
    } finally {
      await memoryManager.shutdown();
    }
  }

  return {
    ...orchestration,
    effectiveReview,
  };
}
