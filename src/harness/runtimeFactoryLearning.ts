import {
  createLearningProviderRegistry,
  gatherDefaultLearningContext,
  gatherLearningContext,
} from './learningProviders';
import { loadManagedSkills, mergeRuntimeSkills, persistReviewSkills } from './learningSkillManager';
import { finalizeCompletedTurn, orchestrateCompletedTurn } from './learningOrchestrator';
import { shouldCompressThread, summarizeThreadForCompression } from './learningCompressionManager';
import {
  appendLearningTrajectory,
  exportLearningBundle,
  listLearningTrajectories,
  listSessionEntries,
  recordSessionEntry,
} from './learningSessionStore';
import { createLearningMemoryManager } from './learningMemoryManager';
import {
  abortLearningAgentLoop,
  beginLearningAgentLoop,
  finalizeLearningAgentLoop,
} from './learningAgentLoop';
import { buildLearningContext, searchAllLearning, spawnBackgroundLearningReview } from './learningRuntime';
import {
  buildBackgroundReviewPrompt,
  createConsoleReviewChannel,
  createWebReviewChannel,
  markReviewProvenance,
  selectSkillUpdateTier,
  summarizeReviewActions,
} from './learningBackgroundReview';
import {
  findConsolidationCandidates,
  pinSkill,
  runCuratorPass,
  unpinSkill,
} from './learningCurator';
import {
  advanceNudge,
  createNudgeState,
  hydrateNudgeState,
  shouldReviewNow,
} from './learningNudge';
import type { HarnessLearningRuntimeAssembly } from './runtimeFactoryTypes';

export function createHarnessLearningRuntime(): HarnessLearningRuntimeAssembly {
  const learningProviderRegistry = createLearningProviderRegistry();
  const learningProviders = learningProviderRegistry.listProviders();

  return {
    learningProviderRegistry,
    selfImproving: {
      providers: learningProviders,
      providerRegistry: learningProviderRegistry,
      createMemoryManager: (workDir) => createLearningMemoryManager(workDir, learningProviderRegistry),
      loadDurableMemories: async (workDir) => {
        const memoryManager = createLearningMemoryManager(workDir, learningProviderRegistry);
        return memoryManager.loadDurableMemories();
      },
      persistDurableMemories: async (workDir, memories) => {
        const memoryManager = createLearningMemoryManager(workDir, learningProviderRegistry);
        await memoryManager.persistDurableMemories(memories);
      },
      gatherContext: (request, providers = learningProviders) => gatherLearningContext(request, providers),
      gatherDefaultContext: (request, extraProviders = []) => gatherDefaultLearningContext(request, extraProviders),
      buildLearningContext,
      searchAllLearning,
      loadManagedSkills,
      mergeRuntimeSkills,
      persistReviewSkills,
      orchestrateCompletedTurn,
      finalizeCompletedTurn: (params) => finalizeCompletedTurn({
        ...params,
        providersOrRegistry: learningProviderRegistry,
      }),
      completeTurn: async (params) => {
        const finalized = await finalizeCompletedTurn({
          ...params,
          providersOrRegistry: learningProviderRegistry,
        });
        return {
          ...finalized,
          followups: [],
        };
      },
      shouldCompressThread,
      summarizeThreadForCompression,
      appendLearningTrajectory,
      recordSessionEntry,
      listSessionEntries,
      listLearningTrajectories,
      exportLearningBundle,
      beginAgentLoop: beginLearningAgentLoop,
      finalizeAgentLoop: finalizeLearningAgentLoop,
      abortAgentLoop: abortLearningAgentLoop,
      spawnBackgroundReview: spawnBackgroundLearningReview,
      summarizeReviewActions,
      markReviewProvenance,
      buildBackgroundReviewPrompt,
      selectSkillUpdateTier,
      createConsoleReviewChannel,
      createWebReviewChannel,
      runCuratorPass,
      findConsolidationCandidates,
      pinSkill,
      unpinSkill,
      createNudgeState,
      advanceNudge,
      shouldReviewNow,
      hydrateNudgeState,
    },
  };
}
