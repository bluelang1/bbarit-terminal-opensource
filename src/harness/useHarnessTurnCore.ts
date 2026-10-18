import { useCallback } from 'react';
import { applyHarnessAgentLoopOutcome } from './applyHarnessAgentLoopOutcome';
import { runHarnessWorkflowExecution } from './runHarnessWorkflowExecution';
import type { HarnessAgentLoopOutcome } from './agentLoopRunner';
import type { Attachment } from './panelTypes';
import type { HarnessTurnControllerParams } from './turnControllerTypes';

interface HarnessTurnCoreParams extends Pick<
  HarnessTurnControllerParams,
  | 'executionProfile'
  | 'genId'
  | 'harnessRuntime'
  | 'threadsRef'
  | 'updateThread'
  | 'workDir'
  | 'setPendingDecompose'
  | 'pendingMsgRef'
  | 'setPendingSpecReview'
  | 'setPendingPlanReview'
  | 'setSubTasks'
  | 'setShowArtifacts'
  | 'setSelectedArtifact'
  | 'addMemory'
  | 'setLearnedSkills'
  | 'setFollowups'
  | 'setIsStreaming'
  | 'streamingThreadIdRef'
  | 'uiText'
  | 'setStreamingContent'
  | 'setStreamingThinking'
  | 'abortRef'
  | 'responseLanguage'
  | 'ensureCliProvider'
  | 'mode'
  | 'provider'
  | 'supportsWorkflowTimeoutFallback'
  | 'setError'
  | 'setShowWorkflowEditor'
  | 'setPendingWorkflowStart'
  | 'workflow'
> {}

export function useHarnessTurnCore(params: HarnessTurnCoreParams) {
  const executeTodo = useCallback(async (threadId: string, todoId: string, todoText: string) => {
    const thread = params.threadsRef.current.find((candidate) => candidate.id === threadId);
    if (!thread) return;

    const effectiveProvider = params.harnessRuntime.providers.resolveEffectiveCliProvider();
    const inProgressTodos = thread.todos.map((todo) => (
      todo.id === todoId ? { ...todo, status: 'in_progress' as const } : todo
    ));

    params.updateThread(threadId, (currentThread) => ({ ...currentThread, todos: inProgressTodos }));

    const result = await params.harnessRuntime.sessions.executeTodoTask({
      thread: { ...thread, todos: inProgressTodos },
      todoId,
      todoText,
      provider: effectiveProvider,
      workDir: params.workDir,
      timeoutSecs: params.executionProfile.directConversationTimeoutSecs,
      createId: params.genId,
    });

    params.updateThread(threadId, (currentThread) => ({
      ...currentThread,
      messages: result.thread.messages,
      todos: result.thread.todos,
    }));
  }, [params]);

  const applyAgentLoopOutcome = useCallback(({
    threadId,
    outcome,
  }: {
    threadId: string;
    outcome: HarnessAgentLoopOutcome;
  }) => {
    applyHarnessAgentLoopOutcome({
      ...params,
      threadId,
      outcome,
    });
  }, [params]);

  const runCodingWorkflow = useCallback(async ({
    threadId,
    msgText,
    startTime,
    attachmentsSnapshot,
  }: {
    threadId: string;
    msgText: string;
    startTime: number;
    attachmentsSnapshot: Attachment[];
  }) => {
    await runHarnessWorkflowExecution({
      ...params,
      threadId,
      msgText,
      startTime,
      attachmentsSnapshot,
      applyAgentLoopOutcome,
    });
  }, [applyAgentLoopOutcome, params]);

  return {
    executeTodo,
    applyAgentLoopOutcome,
    runCodingWorkflow,
  };
}
