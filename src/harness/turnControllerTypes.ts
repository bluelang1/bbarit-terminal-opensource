import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { CliProvider } from './cliRuntime';
import type { LearnedSkillEntry } from './learningRuntime';
import type { HarnessResponseLanguage } from './prompting';
import type { HarnessRuntime } from './runtimeFactory';
import type { PendingPlanReview, PendingSpecReview } from './workflowExecutor';
import type { WorkflowConfig, WorkflowExecutionProfile } from './workflow';
import type {
  AgentMode,
  AiProvider,
  Artifact,
  Attachment,
  ChatThread,
  MemoryEntry,
  PendingWorkflowStart,
  SkillInfo,
  SubTask,
} from './panelTypes';

export type PendingDecomposeTask = {
  description: string;
  provider: AiProvider;
  prompt: string;
};

export interface HarnessTurnControllerUiText {
  codingStatus: string;
  saved: string;
  files: string;
}

export interface HarnessTurnControllerParams {
  activeThreadId: string | null;
  input: string;
  attachments: Attachment[];
  isStreaming: boolean;
  memories: MemoryEntry[];
  mode: AgentMode;
  provider: AiProvider;
  responseLanguage: HarnessResponseLanguage;
  workflow: WorkflowConfig;
  runtimeSkills: SkillInfo[];
  workDir: string;
  threadTarget?: {
    projectId?: string;
    projectName?: string;
    workDir?: string;
  };
  executionProfile: WorkflowExecutionProfile;
  supportsWorkflowTimeoutFallback: boolean;
  uiText: HarnessTurnControllerUiText;
  harnessRuntime: HarnessRuntime;
  ultraProviders: ReadonlySet<AiProvider>;
  threadsRef: MutableRefObject<ChatThread[]>;
  streamingThreadIdRef: MutableRefObject<string | null>;
  pendingMsgRef: MutableRefObject<string>;
  abortRef: MutableRefObject<boolean>;
  pendingWorkflowStart: PendingWorkflowStart | null;
  pendingSpecReview: PendingSpecReview | null;
  pendingPlanReview: PendingPlanReview | null;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string | null>>;
  setInput: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  setShowWorkflowEditor: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFollowups: Dispatch<SetStateAction<string[]>>;
  setPendingWorkflowStart: Dispatch<SetStateAction<PendingWorkflowStart | null>>;
  setPendingSpecReview: Dispatch<SetStateAction<PendingSpecReview | null>>;
  setPendingPlanReview: Dispatch<SetStateAction<PendingPlanReview | null>>;
  setPendingDecompose: Dispatch<SetStateAction<PendingDecomposeTask[] | null>>;
  setSubTasks: Dispatch<SetStateAction<SubTask[]>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setStreamingContent: Dispatch<SetStateAction<string>>;
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  setShowArtifacts: Dispatch<SetStateAction<boolean>>;
  setSelectedArtifact: Dispatch<SetStateAction<Artifact | null>>;
  setLearnedSkills: Dispatch<SetStateAction<LearnedSkillEntry[]>>;
  addMemory: (content: string, source: string) => void;
  updateThread: (id: string, updater: (thread: ChatThread) => ChatThread) => void;
  ensureCliProvider: (provider: AiProvider) => CliProvider;
  genId: () => string;
}
