import { useCallback } from 'react';
import { prepareHarnessSubmitTurn } from './prepareHarnessSubmitTurn';
import {
  beginHarnessStreamingState,
  clearHarnessTurnTransientState,
  finishHarnessStreamingState,
} from './turnControllerState';
import type { HarnessTurnControllerParams } from './turnControllerTypes';
import { buildWorkspaceAttachmentContext } from './attachmentRuntime';

interface HarnessSubmitActionsParams extends Pick<
  HarnessTurnControllerParams,
  | 'activeThreadId'
  | 'input'
  | 'attachments'
  | 'isStreaming'
  | 'memories'
  | 'mode'
  | 'provider'
  | 'responseLanguage'
  | 'runtimeSkills'
  | 'workDir'
  | 'executionProfile'
  | 'harnessRuntime'
  | 'ultraProviders'
  | 'threadsRef'
  | 'streamingThreadIdRef'
  | 'abortRef'
  | 'setThreads'
  | 'setActiveThreadId'
  | 'setInput'
  | 'setAttachments'
  | 'setShowWorkflowEditor'
  | 'setError'
  | 'setFollowups'
  | 'setPendingWorkflowStart'
  | 'setPendingSpecReview'
  | 'setPendingPlanReview'
  | 'setSubTasks'
  | 'setIsStreaming'
  | 'setStreamingContent'
  | 'setStreamingThinking'
  | 'ensureCliProvider'
  | 'genId'
> {
  threadTarget?: {
    projectId?: string;
    projectName?: string;
    workDir?: string;
  };
  runCodingWorkflow: (params: {
    threadId: string;
    msgText: string;
    startTime: number;
    attachmentsSnapshot: HarnessTurnControllerParams['attachments'];
  }) => Promise<void>;
  applyAgentLoopOutcome: (params: { threadId: string; outcome: Awaited<ReturnType<HarnessTurnControllerParams['harnessRuntime']['agentLoop']['runTurn']>> extends infer T ? Exclude<T, null> : never }) => void;
}

export function useHarnessSubmitActions(params: HarnessSubmitActionsParams) {
  const handleSubmit = useCallback(async (text?: string, options?: { forceWorkflow?: boolean }) => {
    const msgText = (text || params.input).trim();
    const isCurrentThreadStreaming =
      params.isStreaming && params.streamingThreadIdRef.current === params.activeThreadId;
    if (!msgText || isCurrentThreadStreaming) return;

    clearHarnessTurnTransientState({
      setError: params.setError,
      setFollowups: params.setFollowups,
      setPendingWorkflowStart: params.setPendingWorkflowStart,
      setPendingSpecReview: params.setPendingSpecReview,
      setPendingPlanReview: params.setPendingPlanReview,
    });

    let attachmentContext = '';
    try {
      attachmentContext = await buildWorkspaceAttachmentContext(
        params.attachments,
        params.threadTarget?.workDir || params.workDir,
      );
    } catch (error) {
      params.setError(`Failed to copy attachment into the project workspace: ${String(error)}`);
      return;
    }

    const {
      submissionStart,
      submissionRoute,
      startTime,
    } = prepareHarnessSubmitTurn({
      activeThreadId: params.activeThreadId,
      messageText: msgText,
      mode: params.mode,
      provider: params.provider,
      attachments: params.attachments,
      attachmentContext,
      threads: params.threadsRef.current,
      genId: params.genId,
      forceWorkflow: options?.forceWorkflow,
      threadTarget: params.threadTarget,
      harnessRuntime: params.harnessRuntime,
    });

    params.setThreads(() => {
      params.threadsRef.current = submissionStart.threads;
      return submissionStart.threads;
    });
    params.setActiveThreadId(submissionStart.activeThreadId);

    const threadId = submissionStart.threadId;
    params.setInput('');
    params.setShowWorkflowEditor(false);

    if (submissionRoute.kind === 'workflow-pending') {
      params.setAttachments([]);
      params.setShowWorkflowEditor(false);
      finishHarnessStreamingState({
        setIsStreaming: params.setIsStreaming,
        setStreamingContent: params.setStreamingContent,
        setStreamingThinking: params.setStreamingThinking,
      });
      params.setSubTasks([]);
      params.setPendingWorkflowStart(submissionRoute.pending);
      return;
    }

    beginHarnessStreamingState({
      threadId,
      streamingThreadIdRef: params.streamingThreadIdRef,
      abortRef: params.abortRef,
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
      setSubTasks: params.setSubTasks,
    });

    if (submissionRoute.kind === 'workflow-run') {
      await params.runCodingWorkflow({
        threadId,
        msgText,
        startTime,
        attachmentsSnapshot: params.attachments,
      });
      return;
    }

    const thread = params.threadsRef.current.find((candidate) => candidate.id === threadId);
    if (!thread) {
      params.setError('Missing thread');
      finishHarnessStreamingState({
        setIsStreaming: params.setIsStreaming,
        setStreamingContent: params.setStreamingContent,
        setStreamingThinking: params.setStreamingThinking,
      });
      return;
    }

    try {
      const outcome = await params.harnessRuntime.agentLoop.runTurn({
        kind: 'mode',
        executeSession: () => params.harnessRuntime.sessions.runModeSession({
          route: submissionRoute,
          thread,
          msgText,
          mode: params.mode,
          provider: params.provider,
          memories: params.memories,
          skills: params.runtimeSkills,
          workDir: params.workDir,
          executionProfile: params.executionProfile,
          responseLanguage: params.responseLanguage,
          threadSummary: thread.summary,
          ensureCliProvider: params.ensureCliProvider,
          forceProviderForMode: params.harnessRuntime.features.getModeProfile(
            submissionRoute.runtimeMode,
          ).forceProvider,
          ultraProviders: [...params.ultraProviders].map(params.ensureCliProvider),
          startTime,
          createId: params.genId,
          onStreamingContent: params.setStreamingContent,
          onStreamingThinking: params.setStreamingThinking,
          onStepProgress: (progressText) => params.setStreamingContent(progressText),
          abortRef: params.abortRef,
        }),
        workDir: params.workDir,
        mode: params.mode,
        provider: params.provider,
        threadBefore: thread,
        userMessage: msgText,
        summaryTimeoutSecs: params.executionProfile.summaryTimeoutSecs,
        defaultFollowupProvider: params.ensureCliProvider(params.provider),
      });

      if (!outcome) {
        throw new Error('Mode turn returned no outcome.');
      }

      params.applyAgentLoopOutcome({ threadId, outcome });
    } catch (error) {
      params.setError(String(error));
    }

    finishHarnessStreamingState({
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
    });
  }, [params]);

  return {
    handleSubmit,
  };
}
