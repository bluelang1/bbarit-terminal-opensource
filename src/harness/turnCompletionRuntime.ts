import type { CliProvider } from './cliRuntime';
import type { LearningReviewResult } from './learningRuntime';
import type { HarnessRuntime } from './runtimeFactory';

export interface CompletionArtifact {
  id: string;
  filename: string;
  language: string;
  content: string;
}

export interface CompletionThread {
  id: string;
  title: string;
  summary?: string;
  messages: Array<{
    role: 'human' | 'assistant' | 'tool' | 'system';
    content: string;
    toolCalls?: Array<{ id: string; name: string; args: string; result?: string; status: 'running' | 'done' | 'error' }>;
    artifacts?: Array<{ id: string; filename: string; language: string; content: string }>;
  }>;
}

export interface PreparedTurnCompletion {
  learnedSkills: Awaited<ReturnType<HarnessRuntime['selfImproving']['loadManagedSkills']>> | null;
  memoryEntriesToAdd: Array<{ content: string; source: string }>;
  compressedSummary?: string;
  followups: string[];
}

export interface CompleteHarnessTurnResult {
  threadAfter: CompletionThread;
  primaryArtifact?: CompletionArtifact;
  learnedSkills: Awaited<ReturnType<HarnessRuntime['selfImproving']['loadManagedSkills']>> | null;
  memoryEntriesToAdd: Array<{ content: string; source: string }>;
  compressedSummary?: string;
  followups: string[];
}

export function applyCompletedHarnessTurnResult<TThread extends CompletionThread>(params: {
  threadId: string;
  completion: CompleteHarnessTurnResult;
  replaceThread: (threadId: string, threadAfter: TThread) => void;
  patchThreadSummary: (threadId: string, summary: string) => void;
  selectArtifact: (artifact: CompletionArtifact) => void;
  addMemory: (content: string, source: string) => void;
  setLearnedSkills: (skills: Awaited<ReturnType<HarnessRuntime['selfImproving']['loadManagedSkills']>>) => void;
  setFollowups: (followups: string[]) => void;
}): void {
  params.replaceThread(params.threadId, params.completion.threadAfter as TThread);

  if (params.completion.primaryArtifact) {
    params.selectArtifact(params.completion.primaryArtifact);
  }

  params.completion.memoryEntriesToAdd.forEach((memory) => {
    params.addMemory(memory.content, memory.source);
  });

  if (params.completion.learnedSkills) {
    params.setLearnedSkills(params.completion.learnedSkills);
  }

  if (params.completion.compressedSummary) {
    params.patchThreadSummary(params.threadId, params.completion.compressedSummary);
  }

  params.setFollowups(params.completion.followups);
}

export interface WorkflowLikePresentation {
  kind: 'completed';
  thread: {
    messages: CompletionThread['messages'];
    todos?: unknown;
  };
  primaryArtifact?: CompletionArtifact;
  followupSource?: string;
  followupProvider?: CliProvider;
}

export interface DirectLikePresentation<TThread extends CompletionThread> {
  thread: TThread;
  primaryArtifact?: CompletionArtifact;
  memorySummary?: string;
  learningReview?: LearningReviewResult;
  followupSource?: string;
  followupProvider?: CliProvider;
  followups?: string[];
  providerSyncHandled?: boolean;
}

export async function prepareCompletedTurn(params: {
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: CompletionThread;
  threadAfter: CompletionThread;
  userMessage: string;
  memorySummary?: string;
  learningReview?: LearningReviewResult;
  followupSource?: string;
  followupProvider?: CliProvider;
  followups?: string[];
  providerSyncHandled?: boolean;
  summaryTimeoutSecs: number;
}): Promise<PreparedTurnCompletion> {
  const memoryEntriesToAdd: Array<{ content: string; source: string }> = [];
  if (params.memorySummary) {
    memoryEntriesToAdd.push({
      content: params.memorySummary,
      source: params.threadBefore.title || 'chat',
    });
  }
  if (params.learningReview?.memories?.length) {
    memoryEntriesToAdd.push(
      ...params.learningReview.memories.map((memory) => ({
        content: memory.content,
        source: params.threadAfter.title || 'self-improving',
      })),
    );
  }

  let learnedSkills: PreparedTurnCompletion['learnedSkills'] = null;
  if (params.learningReview?.skills?.length) {
    learnedSkills = await params.harnessRuntime.selfImproving.persistReviewSkills(params.workDir, params.learningReview);
  }

  const orchestration = await params.harnessRuntime.selfImproving.completeTurn({
    workDir: params.workDir,
    mode: params.mode,
    provider: params.provider,
    threadBefore: params.threadBefore,
    threadAfter: params.threadAfter,
    userMessage: params.userMessage,
    directLearningReview: params.learningReview,
    followupProvider: params.followupProvider!,
    summaryTimeoutSecs: params.summaryTimeoutSecs,
    followupSource: params.followupSource,
    followups: params.followups,
    providerSyncHandled: params.providerSyncHandled,
  });

  if (!params.learningReview && orchestration.review?.memories?.length) {
    memoryEntriesToAdd.push(
      ...orchestration.review.memories.map((memory) => ({
        content: memory.content,
        source: params.threadAfter.title || 'self-improving',
      })),
    );
  }

  if (!params.learningReview && orchestration.learnedSkillsChanged) {
    learnedSkills = await params.harnessRuntime.selfImproving.loadManagedSkills(params.workDir);
  }

  return {
    learnedSkills,
    memoryEntriesToAdd,
    compressedSummary: orchestration.compressedSummary,
    followups: orchestration.followups,
  };
}

export async function completeHarnessTurn(params: {
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: CompletionThread;
  threadAfter: CompletionThread;
  userMessage: string;
  primaryArtifact?: CompletionArtifact;
  memorySummary?: string;
  learningReview?: LearningReviewResult;
  followupSource?: string;
  followupProvider?: CliProvider;
  followups?: string[];
  providerSyncHandled?: boolean;
  summaryTimeoutSecs: number;
}): Promise<CompleteHarnessTurnResult> {
  const prepared = await prepareCompletedTurn({
    harnessRuntime: params.harnessRuntime,
    workDir: params.workDir,
    mode: params.mode,
    provider: params.provider,
    threadBefore: params.threadBefore,
    threadAfter: params.threadAfter,
    userMessage: params.userMessage,
    memorySummary: params.memorySummary,
    learningReview: params.learningReview,
    followupSource: params.followupSource,
    followupProvider: params.followupProvider,
    followups: params.followups,
    providerSyncHandled: params.providerSyncHandled,
    summaryTimeoutSecs: params.summaryTimeoutSecs,
  });

  return {
    threadAfter: params.threadAfter,
    primaryArtifact: params.primaryArtifact,
    learnedSkills: prepared.learnedSkills,
    memoryEntriesToAdd: prepared.memoryEntriesToAdd,
    compressedSummary: prepared.compressedSummary,
    followups: prepared.followups,
  };
}

export async function completePresentedHarnessTurn<TThread extends CompletionThread & { todos?: unknown }>(params: {
  harnessRuntime: HarnessRuntime;
  workDir: string;
  mode: string;
  provider: string;
  threadBefore: TThread;
  userMessage: string;
  presentation: WorkflowLikePresentation | DirectLikePresentation<TThread>;
  summaryTimeoutSecs: number;
  defaultFollowupProvider: CliProvider;
}): Promise<CompleteHarnessTurnResult> {
  let threadAfter: TThread;
  if ('kind' in params.presentation) {
    threadAfter = {
      ...params.threadBefore,
      messages: params.presentation.thread.messages,
      todos: params.presentation.thread.todos ?? params.threadBefore.todos,
    } as TThread;
  } else {
    threadAfter = params.presentation.thread;
  }

  return completeHarnessTurn({
    harnessRuntime: params.harnessRuntime,
    workDir: params.workDir,
    mode: params.mode,
    provider: params.provider,
    threadBefore: params.threadBefore,
    threadAfter,
    userMessage: params.userMessage,
    primaryArtifact: params.presentation.primaryArtifact,
    memorySummary: 'memorySummary' in params.presentation ? params.presentation.memorySummary : undefined,
    learningReview: 'learningReview' in params.presentation ? params.presentation.learningReview : undefined,
    followupSource: params.presentation.followupSource,
    followupProvider: params.presentation.followupProvider || params.defaultFollowupProvider,
    followups: 'followups' in params.presentation ? params.presentation.followups : undefined,
    providerSyncHandled: 'providerSyncHandled' in params.presentation ? params.presentation.providerSyncHandled : undefined,
    summaryTimeoutSecs: params.summaryTimeoutSecs,
  });
}
