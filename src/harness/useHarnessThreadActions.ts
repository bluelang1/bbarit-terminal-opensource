import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { HarnessRuntime } from './runtimeFactory';
import {
  clearHarnessTurnTransientState,
  finishHarnessStreamingState,
} from './turnControllerState';
import type {
  AiProvider,
  Artifact,
  ChatThread,
  PendingWorkflowStart,
  SubTask,
} from './panelTypes';
import type { PendingPlanReview, PendingSpecReview } from './workflowExecutor';

interface HarnessThreadTarget {
  projectId?: string;
  projectName?: string;
  workDir?: string;
}

interface HarnessThreadActionsParams {
  harnessRuntime: Pick<HarnessRuntime, 'panel'>;
  provider: AiProvider;
  newChatLabel: string;
  threadsRef: MutableRefObject<ChatThread[]>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  setActiveThreadId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFollowups: Dispatch<SetStateAction<string[]>>;
  setSubTasks: Dispatch<SetStateAction<SubTask[]>>;
  setPendingWorkflowStart: Dispatch<SetStateAction<PendingWorkflowStart | null>>;
  setPendingSpecReview: Dispatch<SetStateAction<PendingSpecReview | null>>;
  setPendingPlanReview: Dispatch<SetStateAction<PendingPlanReview | null>>;
  setStreamingContent: Dispatch<SetStateAction<string>>;
  setStreamingThinking: Dispatch<SetStateAction<string>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setSelectedArtifact: Dispatch<SetStateAction<Artifact | null>>;
  genId: () => string;
}

export function useHarnessThreadActions(params: HarnessThreadActionsParams) {
  const createThread = useCallback((target?: HarnessThreadTarget) => {
    const newThread = params.harnessRuntime.panel.createNewCodingThread<ChatThread>({
      thread: {
        id: params.genId(),
        createdAt: Date.now(),
        targetProjectId: target?.projectId,
        targetProjectName: target?.projectName,
        targetWorkDir: target?.workDir,
        mode: 'coding',
        provider: params.provider,
      } as Omit<ChatThread, 'title' | 'messages' | 'todos'>,
      title: target?.projectName ? `${params.newChatLabel} · ${target.projectName}` : params.newChatLabel,
    });
    params.setThreads((prev) => {
      const next = params.harnessRuntime.panel.insertThreadAtTop(prev, newThread);
      params.threadsRef.current = next;
      return next;
    });
    params.setActiveThreadId(newThread.id);
    clearHarnessTurnTransientState({
      setError: params.setError,
      setFollowups: params.setFollowups,
      setPendingWorkflowStart: params.setPendingWorkflowStart,
      setPendingSpecReview: params.setPendingSpecReview,
      setPendingPlanReview: params.setPendingPlanReview,
    });
    params.setSubTasks([]);
    finishHarnessStreamingState({
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
    });
    params.setSelectedArtifact(null);
    setTimeout(() => params.textareaRef.current?.focus(), 50);
  }, [params]);

  const deleteThread = useCallback((id: string, activeThreadId: string | null) => {
    params.setThreads(prev => params.harnessRuntime.panel.removeThreadById(prev, id));
    if (activeThreadId === id) params.setActiveThreadId(null);
  }, [params]);

  const updateThread = useCallback((id: string, updater: (thread: ChatThread) => ChatThread) => {
    params.setThreads((prev) => {
      const next = params.harnessRuntime.panel.updateThreadById(prev, id, updater);
      params.threadsRef.current = next;
      return next;
    });
  }, [params]);

  return {
    createThread,
    deleteThread,
    updateThread,
  };
}
