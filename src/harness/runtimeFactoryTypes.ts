import { generateFollowupsAi } from './contentRuntime';
import { runModeSession } from './modeSessionExecutor';
import { executeDecomposedSubAgents } from './subAgentExecutor';
import {
  buildHarnessStorageKeys,
  parsePersistedValue,
  snapshotMemoriesForPersistence,
  snapshotThreadsForPersistence,
} from './threadRuntime';
import { getRunnableSelectedTodos, toggleSelectionId } from './panelState';
import { buildHarnessPanelViewModel } from './panelViewModel';
import {
  beginHarnessSubmission,
  createNewCodingThread,
  insertThreadAtTop,
  removeThreadById,
  updateThreadById,
} from './panelSessionRuntime';
import { buildWorkflowStartSeed, toConversationMessages } from './submissionRuntime';
import { determineSubmissionRoute } from './submissionCoordinator';
import {
  prepareDirectResponseContext,
  type DirectResponseAssemblyOptions,
  type DirectResponseMiddlewareInput,
} from './middleware';
import {
  type HarnessAiProvider,
  type HarnessModeFeatureProfile,
  type HarnessAgentMode,
} from './runtimeFeatures';
import { appendAssistantMessageToThread } from './threadSessionRuntime';
import {
  runWorkflowPlanReviewSelection,
  runWorkflowSessionStart,
  runWorkflowSpecReviewSelection,
} from './workflowSessionExecutor';
import {
  DEFAULT_WORKFLOW,
  WORKFLOW_PRESETS,
  applyProviderToWorkflow,
  cloneWorkflowConfig,
  getWorkflowExecutionProfile,
} from './workflow';
import { executeTodoTask } from './todoExecutor';
import {
  gatherDefaultLearningContext,
  gatherLearningContext,
  type LearningProvider,
  type LearningProviderRegistry,
} from './learningProviders';
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
import { loadManagedSkills, mergeRuntimeSkills, persistReviewSkills } from './learningSkillManager';
import {
  finalizeCompletedTurn,
  orchestrateCompletedTurn,
  type FinalizeCompletedTurnResult,
} from './learningOrchestrator';
import { shouldCompressThread, summarizeThreadForCompression } from './learningCompressionManager';
import {
  appendLearningTrajectory,
  exportLearningBundle,
  listLearningTrajectories,
  listSessionEntries,
  recordSessionEntry,
} from './learningSessionStore';
import { type LearningMemoryManager } from './learningMemoryManager';
import {
  abortLearningAgentLoop,
  beginLearningAgentLoop,
  finalizeLearningAgentLoop,
} from './learningAgentLoop';
import {
  type HarnessAgentLoopOutcome,
  type HarnessAgentLoopTurnParams,
} from './agentLoopRunner';
import type { CliProvider } from './cliRuntime';
import type { HarnessResponseLanguage } from './prompting';
import {
  buildLearningContext,
  searchAllLearning,
  spawnBackgroundLearningReview,
  type LearningReviewResult,
} from './learningRuntime';
import type { TodoItem } from '../components/harness-utils';

export type StripHarnessRuntime<T> = T extends any ? Omit<T, 'harnessRuntime'> : never;

export type StripHarnessRuntimeOutcome<T> =
  T extends { kind: 'mode' } ? HarnessAgentLoopOutcome :
  T extends { kind: 'subagent' } ? HarnessAgentLoopOutcome :
  T extends { kind: 'workflow' } ? HarnessAgentLoopOutcome | null :
  HarnessAgentLoopOutcome | null;

export interface HarnessRuntimeFactoryOptions {
  mode: HarnessAgentMode;
  provider: HarnessAiProvider;
  backgroundProvider: HarnessAiProvider;
  responseLanguage: HarnessResponseLanguage;
  ensureCliProvider: (provider: HarnessAiProvider) => CliProvider;
  directResponse?: DirectResponseAssemblyOptions;
  learningAssembly?: HarnessLearningRuntimeAssembly;
}

export interface HarnessRuntime {
  featureProfile: HarnessModeFeatureProfile;
  features: {
    getModeProfile: (mode: HarnessAgentMode) => HarnessModeFeatureProfile;
  };
  backgroundProvider: HarnessAiProvider;
  providers: {
    ensureCliProvider: (provider: HarnessAiProvider) => CliProvider;
    resolveEffectiveCliProvider: (provider?: HarnessAiProvider) => CliProvider;
  };
  selfImproving: {
    providers: LearningProvider[];
    providerRegistry: LearningProviderRegistry;
    createMemoryManager: (workDir: string) => LearningMemoryManager;
    loadDurableMemories: (workDir: string) => Promise<import('./learningRuntime').LearningMemoryEntry[]>;
    persistDurableMemories: (
      workDir: string,
      memories: import('./learningRuntime').LearningMemoryEntry[],
    ) => Promise<void>;
    gatherContext: typeof gatherLearningContext;
    gatherDefaultContext: typeof gatherDefaultLearningContext;
    buildLearningContext: typeof buildLearningContext;
    searchAllLearning: typeof searchAllLearning;
    loadManagedSkills: typeof loadManagedSkills;
    mergeRuntimeSkills: typeof mergeRuntimeSkills;
    persistReviewSkills: typeof persistReviewSkills;
    orchestrateCompletedTurn: typeof orchestrateCompletedTurn;
    finalizeCompletedTurn: (
      params: Omit<Parameters<typeof finalizeCompletedTurn>[0], 'providersOrRegistry'>
    ) => Promise<FinalizeCompletedTurnResult>;
    completeTurn: (
      params: Omit<Parameters<typeof finalizeCompletedTurn>[0], 'providersOrRegistry'> & {
        followupSource?: string;
        followups?: string[];
        directLearningReview?: LearningReviewResult;
      }
    ) => Promise<FinalizeCompletedTurnResult & { followups: string[] }>;
    shouldCompressThread: typeof shouldCompressThread;
    summarizeThreadForCompression: typeof summarizeThreadForCompression;
    appendLearningTrajectory: typeof appendLearningTrajectory;
    recordSessionEntry: typeof recordSessionEntry;
    listSessionEntries: typeof listSessionEntries;
    listLearningTrajectories: typeof listLearningTrajectories;
    exportLearningBundle: typeof exportLearningBundle;
    beginAgentLoop: typeof beginLearningAgentLoop;
    finalizeAgentLoop: typeof finalizeLearningAgentLoop;
    abortAgentLoop: typeof abortLearningAgentLoop;
    spawnBackgroundReview: typeof spawnBackgroundLearningReview;
    summarizeReviewActions: typeof summarizeReviewActions;
    markReviewProvenance: typeof markReviewProvenance;
    buildBackgroundReviewPrompt: typeof buildBackgroundReviewPrompt;
    selectSkillUpdateTier: typeof selectSkillUpdateTier;
    createConsoleReviewChannel: typeof createConsoleReviewChannel;
    createWebReviewChannel: typeof createWebReviewChannel;
    runCuratorPass: typeof runCuratorPass;
    findConsolidationCandidates: typeof findConsolidationCandidates;
    pinSkill: typeof pinSkill;
    unpinSkill: typeof unpinSkill;
    createNudgeState: typeof createNudgeState;
    advanceNudge: typeof advanceNudge;
    shouldReviewNow: typeof shouldReviewNow;
    hydrateNudgeState: typeof hydrateNudgeState;
  };
  content: {
    generateFollowupsAi: typeof generateFollowupsAi;
  };
  middleware: {
    assembly?: DirectResponseAssemblyOptions;
    names: (options?: DirectResponseAssemblyOptions) => string[];
    prepareContext: (
      input: DirectResponseMiddlewareInput,
      options?: DirectResponseAssemblyOptions,
    ) => ReturnType<typeof prepareDirectResponseContext>;
  };
  storage: {
    buildHarnessStorageKeys: typeof buildHarnessStorageKeys;
    parsePersistedValue: typeof parsePersistedValue;
    snapshotMemoriesForPersistence: typeof snapshotMemoriesForPersistence;
    snapshotThreadsForPersistence: typeof snapshotThreadsForPersistence;
  };
  panel: {
    buildViewModel: typeof buildHarnessPanelViewModel;
    beginSubmission: typeof beginHarnessSubmission;
    createNewCodingThread: typeof createNewCodingThread;
    insertThreadAtTop: typeof insertThreadAtTop;
    removeThreadById: typeof removeThreadById;
    updateThreadById: typeof updateThreadById;
  };
  selection: {
    getRunnableSelectedTodos: typeof getRunnableSelectedTodos;
    toggleSelectionId: typeof toggleSelectionId;
  };
  submission: {
    buildWorkflowStartSeed: typeof buildWorkflowStartSeed;
    toConversationMessages: typeof toConversationMessages;
    determineSubmissionRoute: typeof determineSubmissionRoute;
  };
  sessions: {
    runModeSession: typeof runModeSession;
    runWorkflowSessionStart: typeof runWorkflowSessionStart;
    runWorkflowSpecReviewSelection: typeof runWorkflowSpecReviewSelection;
    runWorkflowPlanReviewSelection: typeof runWorkflowPlanReviewSelection;
    executeTodoTask: typeof executeTodoTask;
    executeDecomposedSubAgents: typeof executeDecomposedSubAgents;
  };
  agentLoop: {
    runTurn: <
      TThread extends import('./turnCompletionRuntime').CompletionThread & {
        todos: TodoItem[];
        title?: string;
        summary?: string;
      }
    >(
      params: StripHarnessRuntime<HarnessAgentLoopTurnParams<TThread>>,
    ) => Promise<StripHarnessRuntimeOutcome<StripHarnessRuntime<HarnessAgentLoopTurnParams<TThread>>>>;
    runModeTurn: <
      TThread extends import('./turnCompletionRuntime').CompletionThread & {
        todos: TodoItem[];
        title?: string;
        summary?: string;
      }
    >(params: {
      executeSession: () => Promise<import('./modeSessionExecutor').ModeSessionResult<TThread>>;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
    }) => Promise<HarnessAgentLoopOutcome>;
    runWorkflowTurn: <
      TThread extends import('./turnCompletionRuntime').CompletionThread & {
        todos: TodoItem[];
        title?: string;
        summary?: string;
      }
    >(params: {
      executePresentation: () => Promise<import('./workflowSessionExecutor').WorkflowSessionPresentation<TThread> | null>;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
    }) => Promise<HarnessAgentLoopOutcome | null>;
    runSubAgentTurn: <
      TThread extends import('./turnCompletionRuntime').CompletionThread & {
        todos: TodoItem[];
        title?: string;
        summary?: string;
      }
    >(params: {
      executeSubAgents: () => Promise<{
        pipeline: import('./cliRuntime').RuntimeSubTask[];
        mainContent: string;
        artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
        durationMs: number;
        followupSource: string;
      }>;
      workDir: string;
      mode: string;
      provider: string;
      threadBefore: TThread;
      userMessage: string;
      summaryTimeoutSecs: number;
      defaultFollowupProvider: CliProvider;
      appendAssistantMessage: (result: {
        pipeline: import('./cliRuntime').RuntimeSubTask[];
        mainContent: string;
        artifacts: Array<{ id: string; filename: string; language: string; content: string }>;
        durationMs: number;
        followupSource: string;
      }) => TThread;
    }) => Promise<HarnessAgentLoopOutcome>;
  };
  thread: {
    appendAssistantMessageToThread: typeof appendAssistantMessageToThread;
  };
  workflow: {
    DEFAULT_WORKFLOW: typeof DEFAULT_WORKFLOW;
    WORKFLOW_PRESETS: typeof WORKFLOW_PRESETS;
    applyProviderToWorkflow: typeof applyProviderToWorkflow;
    cloneWorkflowConfig: typeof cloneWorkflowConfig;
    getWorkflowExecutionProfile: typeof getWorkflowExecutionProfile;
  };
}

export interface HarnessLearningRuntimeAssembly {
  learningProviderRegistry: HarnessRuntime['selfImproving']['providerRegistry'];
  selfImproving: HarnessRuntime['selfImproving'];
}
