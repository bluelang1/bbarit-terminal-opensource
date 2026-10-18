import { applyCompletedHarnessTurnResult } from './turnCompletionRuntime';
import type { HarnessAgentLoopOutcome } from './agentLoopRunner';
import type {
  Artifact,
  ChatThread,
  SubTask,
  TodoItem,
} from './panelTypes';
import type {
  HarnessTurnControllerParams,
  PendingDecomposeTask,
} from './turnControllerTypes';

interface ApplyHarnessAgentLoopOutcomeParams extends Pick<
  HarnessTurnControllerParams,
  | 'setPendingDecompose'
  | 'pendingMsgRef'
  | 'setPendingSpecReview'
  | 'setPendingPlanReview'
  | 'setSubTasks'
  | 'updateThread'
  | 'setShowArtifacts'
  | 'setSelectedArtifact'
  | 'addMemory'
  | 'setLearnedSkills'
  | 'setFollowups'
> {
  threadId: string;
  outcome: HarnessAgentLoopOutcome;
}

export function applyHarnessAgentLoopOutcome(
  params: ApplyHarnessAgentLoopOutcomeParams,
): void {
  const outcome = params.outcome;

  if (outcome.kind === 'pending-decompose') {
    params.setPendingDecompose(outcome.tasks as PendingDecomposeTask[]);
    params.pendingMsgRef.current = outcome.pendingMessage;
    return;
  }

  if (outcome.kind === 'pending-spec-review') {
    params.setPendingSpecReview(outcome.pending);
    if (outcome.pipeline.length > 0) {
      params.setSubTasks(outcome.pipeline as unknown as SubTask[]);
    }
    return;
  }

  if (outcome.kind === 'pending-plan-review') {
    params.setPendingPlanReview(outcome.pending);
    if (outcome.pipeline.length > 0) {
      params.setSubTasks(outcome.pipeline as unknown as SubTask[]);
    }
    params.updateThread(params.threadId, (thread) => ({
      ...thread,
      todos: outcome.todos as TodoItem[],
    }));
    return;
  }

  if (outcome.pipeline?.length) {
    params.setSubTasks(outcome.pipeline as unknown as SubTask[]);
  }

  applyCompletedHarnessTurnResult<ChatThread>({
    threadId: params.threadId,
    completion: outcome.completion,
    replaceThread: (targetThreadId, threadAfter) =>
      params.updateThread(targetThreadId, (currentThread) => {
        const lastAssistant = [...(threadAfter.messages || [])].reverse().find(message => message.role === 'assistant');
        return {
          ...threadAfter,
          runState: currentThread.runState
            ? {
                ...currentThread.runState,
                status: 'completed',
                completedAt: currentThread.runState.completedAt || Date.now(),
                tokenUsage: lastAssistant?.tokenUsage || currentThread.runState.tokenUsage,
              }
            : threadAfter.runState,
        };
      }),
    patchThreadSummary: (targetThreadId, summary) =>
      params.updateThread(targetThreadId, (currentThread) => ({
        ...currentThread,
        summary,
      })),
    selectArtifact: (artifact) => {
      params.setShowArtifacts(true);
      params.setSelectedArtifact(artifact as Artifact);
    },
    addMemory: params.addMemory,
    setLearnedSkills: params.setLearnedSkills,
    setFollowups: params.setFollowups,
  });
}
