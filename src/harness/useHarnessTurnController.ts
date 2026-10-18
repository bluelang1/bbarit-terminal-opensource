import { useHarnessDecomposeActions } from './useHarnessDecomposeActions';
import { useHarnessReviewActions } from './useHarnessReviewActions';
import { useHarnessSubmitActions } from './useHarnessSubmitActions';
import { useHarnessTurnCore } from './useHarnessTurnCore';
import type { HarnessTurnControllerParams } from './turnControllerTypes';

export function useHarnessTurnController(params: HarnessTurnControllerParams) {
  const {
    executeTodo,
    applyAgentLoopOutcome,
    runCodingWorkflow,
  } = useHarnessTurnCore(params);

  const { handleSubmit } = useHarnessSubmitActions({
    ...params,
    applyAgentLoopOutcome,
    runCodingWorkflow,
  });

  const {
    executePendingWorkflowStart,
    executeSelectedSpecReview,
    executeSelectedPlanReview,
  } = useHarnessReviewActions({
    ...params,
    applyAgentLoopOutcome,
    runCodingWorkflow,
  });

  const { executeDecomposed } = useHarnessDecomposeActions({
    ...params,
    applyAgentLoopOutcome,
  });

  return {
    executeTodo,
    handleSubmit,
    executePendingWorkflowStart,
    executeSelectedSpecReview,
    executeSelectedPlanReview,
    executeDecomposed,
  };
}
