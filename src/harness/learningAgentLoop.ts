import { createLearningProviderRegistry, type LearningProvider, type LearningProviderRegistry } from './learningProviders';
import { createLearningMemoryManager, type LearningMemoryManager } from './learningMemoryManager';
import type { LearnedSkillEntry, LearningMemoryEntry, LearningReviewResult } from './learningRuntime';

export interface LearningAgentLoopContext {
  memoryManager: LearningMemoryManager;
  memories: LearningMemoryEntry[];
  skills: LearnedSkillEntry[];
}

export function formatLearningAgentLoopContext(
  context: Pick<LearningAgentLoopContext, 'memories' | 'skills'>,
  limits: { memories?: number; skills?: number; maxChars?: number } = {},
): string {
  const memoryLimit = limits.memories ?? 6;
  const skillLimit = limits.skills ?? 4;
  const maxChars = limits.maxChars ?? 5000;
  return [
    ...context.memories.slice(0, memoryLimit).map((memory, index) => `Memory ${index + 1}: ${memory.content}`),
    ...context.skills.slice(0, skillLimit).map((skill, index) => (
      `Skill ${index + 1}: ${skill.name}\nDescription: ${skill.description}\nProcedure: ${skill.command}`
    )),
  ].join('\n\n').slice(0, maxChars);
}

export async function beginLearningAgentLoop(params: {
  workDir: string;
  query: string;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
}): Promise<LearningAgentLoopContext> {
  const memoryManager = createLearningMemoryManager(
    params.workDir,
    params.providersOrRegistry || createLearningProviderRegistry(),
  );
  await memoryManager.initialize();
  const learningContext = await memoryManager.prefetch({
    query: params.query,
    threadSummary: params.threadSummary,
  });
  return {
    memoryManager,
    memories: learningContext.memories,
    skills: learningContext.skills,
  };
}

export async function finalizeLearningAgentLoop(params: {
  context: LearningAgentLoopContext;
  userMessage: string;
  assistantMessage: string;
  review?: LearningReviewResult;
}): Promise<void> {
  await syncLearningProviderTurn({
    memoryManager: params.context.memoryManager,
    userMessage: params.userMessage,
    assistantMessage: params.assistantMessage,
    review: params.review,
  });
  await params.context.memoryManager.shutdown();
}

export async function syncLearningProviderTurn(params: {
  memoryManager: LearningMemoryManager;
  userMessage: string;
  assistantMessage: string;
  review?: LearningReviewResult;
}): Promise<void> {
  await params.memoryManager.syncTurn({
    userMessage: params.userMessage,
    assistantMessage: params.assistantMessage,
    memories: params.review?.memories || [],
    skills: params.review?.skills || [],
  });
}

export async function abortLearningAgentLoop(context?: LearningAgentLoopContext): Promise<void> {
  await context?.memoryManager.shutdown();
}
