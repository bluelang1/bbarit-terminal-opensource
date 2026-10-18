import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PendingWorkflowStart, SubTask } from './panelTypes';
import type { PendingPlanReview, PendingSpecReview } from './workflowExecutor';

interface ClearTurnTransientStateParams {
  setError?: Dispatch<SetStateAction<string | null>>;
  setFollowups?: Dispatch<SetStateAction<string[]>>;
  setPendingWorkflowStart?: Dispatch<SetStateAction<PendingWorkflowStart | null>>;
  setPendingSpecReview?: Dispatch<SetStateAction<PendingSpecReview | null>>;
  setPendingPlanReview?: Dispatch<SetStateAction<PendingPlanReview | null>>;
}

interface BeginStreamingStateParams {
  threadId: string;
  streamingThreadIdRef: MutableRefObject<string | null>;
  abortRef?: MutableRefObject<boolean>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setStreamingContent: Dispatch<SetStateAction<string>>;
  setStreamingThinking?: Dispatch<SetStateAction<string>>;
  setSubTasks?: Dispatch<SetStateAction<SubTask[]>>;
}

interface FinishStreamingStateParams {
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setStreamingContent: Dispatch<SetStateAction<string>>;
  setStreamingThinking?: Dispatch<SetStateAction<string>>;
}

export function clearHarnessTurnTransientState(params: ClearTurnTransientStateParams) {
  params.setError?.(null);
  params.setFollowups?.([]);
  params.setPendingWorkflowStart?.(null);
  params.setPendingSpecReview?.(null);
  params.setPendingPlanReview?.(null);
}

export function beginHarnessStreamingState(params: BeginStreamingStateParams) {
  params.setIsStreaming(true);
  params.streamingThreadIdRef.current = params.threadId;
  params.setStreamingContent('');
  params.setStreamingThinking?.('');
  params.setSubTasks?.([]);
  if (params.abortRef) {
    params.abortRef.current = false;
  }
}

export function finishHarnessStreamingState(params: FinishStreamingStateParams) {
  params.setIsStreaming(false);
  params.setStreamingContent('');
  params.setStreamingThinking?.('');
}
