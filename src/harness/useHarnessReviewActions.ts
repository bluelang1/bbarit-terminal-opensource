import { useCallback } from 'react';
import type { SubTask } from './panelTypes';
import type { HarnessAgentLoopOutcome } from './agentLoopRunner';
import {
  beginHarnessStreamingState,
  finishHarnessStreamingState,
} from './turnControllerState';
import type { HarnessTurnControllerParams } from './turnControllerTypes';

interface HarnessReviewActionsParams extends Pick<
  HarnessTurnControllerParams,
  | 'pendingWorkflowStart'
  | 'pendingSpecReview'
  | 'pendingPlanReview'
  | 'setPendingWorkflowStart'
  | 'setPendingSpecReview'
  | 'setPendingPlanReview'
  | 'setShowWorkflowEditor'
  | 'setIsStreaming'
  | 'setStreamingThinking'
  | 'streamingThreadIdRef'
  | 'threadsRef'
  | 'harnessRuntime'
  | 'workDir'
  | 'workflow'
  | 'executionProfile'
  | 'responseLanguage'
  | 'uiText'
  | 'ensureCliProvider'
  | 'setStreamingContent'
  | 'setSubTasks'
  | 'genId'
  | 'abortRef'
  | 'mode'
  | 'provider'
  | 'setError'
> {
  runCodingWorkflow: (params: {
    threadId: string;
    msgText: string;
    startTime: number;
    attachmentsSnapshot: HarnessTurnControllerParams['attachments'];
  }) => Promise<void>;
  applyAgentLoopOutcome: (params: {
    threadId: string;
    outcome: HarnessAgentLoopOutcome;
  }) => void;
}

export function useHarnessReviewActions(params: HarnessReviewActionsParams) {
  const executePendingWorkflowStart = useCallback(async () => {
    if (!params.pendingWorkflowStart) return;

    const pending = params.pendingWorkflowStart;
    params.setPendingWorkflowStart(null);
    params.setShowWorkflowEditor(false);

    await params.runCodingWorkflow({
      threadId: pending.threadId,
      msgText: pending.message,
      startTime: pending.startTime,
      attachmentsSnapshot: pending.attachments,
    });
  }, [params]);

  const executeSelectedSpecReview = useCallback(async () => {
    if (!params.pendingSpecReview || params.pendingSpecReview.selectedIds.length === 0) return;

    const pending = params.pendingSpecReview;
    params.setPendingSpecReview(null);
    beginHarnessStreamingState({
      threadId: pending.threadId,
      streamingThreadIdRef: params.streamingThreadIdRef,
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
      setSubTasks: params.setSubTasks,
    });

    const startTime = Date.now();

    try {
      const thread = params.threadsRef.current.find(
        (candidate) => candidate.id === pending.threadId,
      );
      if (!thread) throw new Error('Missing workflow thread.');

      const outcome = await params.harnessRuntime.agentLoop.runTurn({
        kind: 'workflow',
        executePresentation: () => params.harnessRuntime.sessions.runWorkflowSpecReviewSelection({
          thread,
          pending,
          selectedIds: pending.selectedIds,
          startTime,
          workDir: params.workDir,
          workflow: params.workflow,
          executionProfile: params.executionProfile,
          responseLanguage: params.responseLanguage,
          labels: {
            saved: params.uiText.saved,
            files: params.uiText.files,
          },
          ensureCliProvider: params.ensureCliProvider,
          onStreamingContent: params.setStreamingContent,
          onPipelineUpdate: (tasks) => params.setSubTasks(tasks as unknown as SubTask[]),
          threadMessages: params.harnessRuntime.submission.toConversationMessages(
            params.threadsRef.current.find(
              (candidate) => candidate.id === pending.threadId,
            )?.messages || [],
          ),
          createId: params.genId,
          shouldAbort: () => params.abortRef.current,
        }),
        workDir: params.workDir,
        mode: params.mode,
        provider: params.provider,
        threadBefore: thread,
        userMessage: pending.message,
        summaryTimeoutSecs: params.executionProfile.summaryTimeoutSecs,
        defaultFollowupProvider: params.ensureCliProvider(params.provider),
      });

      if (outcome) {
        params.applyAgentLoopOutcome({
          threadId: pending.threadId,
          outcome,
        });
      }
    } catch (error) {
      params.setError(String(error));
    }

    finishHarnessStreamingState({
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
    });
  }, [params]);

  const executeSelectedPlanReview = useCallback(async () => {
    if (!params.pendingPlanReview || params.pendingPlanReview.selectedIds.length === 0) return;

    const pending = params.pendingPlanReview;
    params.setPendingPlanReview(null);
    beginHarnessStreamingState({
      threadId: pending.threadId,
      streamingThreadIdRef: params.streamingThreadIdRef,
      setIsStreaming: params.setIsStreaming,
      setStreamingContent: params.setStreamingContent,
      setStreamingThinking: params.setStreamingThinking,
      setSubTasks: params.setSubTasks,
    });

    const startTime = Date.now();

    try {
      const thread = params.threadsRef.current.find(
        (candidate) => candidate.id === pending.threadId,
      );
      if (!thread) throw new Error('Missing workflow thread.');

      const outcome = await params.harnessRuntime.agentLoop.runTurn({
        kind: 'workflow',
        executePresentation: () => params.harnessRuntime.sessions.runWorkflowPlanReviewSelection({
          thread,
          pending,
          selectedIds: pending.selectedIds,
          startTime,
          workDir: params.workDir,
          workflow: params.workflow,
          executionProfile: params.executionProfile,
          responseLanguage: params.responseLanguage,
          labels: {
            saved: params.uiText.saved,
            files: params.uiText.files,
          },
          ensureCliProvider: params.ensureCliProvider,
          onStreamingContent: params.setStreamingContent,
          onPipelineUpdate: (tasks) => params.setSubTasks(tasks as unknown as SubTask[]),
          threadMessages: params.harnessRuntime.submission.toConversationMessages(
            params.threadsRef.current.find(
              (candidate) => candidate.id === pending.threadId,
            )?.messages || [],
          ),
          createId: params.genId,
          shouldAbort: () => params.abortRef.current,
        }),
        workDir: params.workDir,
        mode: params.mode,
        provider: params.provider,
        threadBefore: thread,
        userMessage: pending.message,
        summaryTimeoutSecs: params.executionProfile.summaryTimeoutSecs,
        defaultFollowupProvider: params.ensureCliProvider(params.provider),
      });

      if (outcome) {
        params.applyAgentLoopOutcome({
          threadId: pending.threadId,
          outcome,
        });
      }
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
    executePendingWorkflowStart,
    executeSelectedSpecReview,
    executeSelectedPlanReview,
  };
}
