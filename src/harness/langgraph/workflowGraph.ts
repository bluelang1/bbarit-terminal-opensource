/**
 * Workflow mode StateGraph — staged pipeline with human-in-the-loop reviews.
 *
 * Flow (happy path):
 *   START → spec → reviewSpec → design → reviewDesign → impl → reviewImpl
 *         → test → reviewTest → finalize → END
 *
 * Branches on review decision:
 *   - approved → next stage
 *   - revise   → repeat current stage (bounded by MAX_REVISIONS_PER_STAGE)
 *   - reject   → finalize (short-circuit with errors)
 */
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { WorkflowState, type WorkflowStateType, type WorkflowStage } from './state';
import {
  makeSpecNode,
  makeDesignNode,
  makeImplNode,
  makeTestNode,
  makeReviewNode,
  makeFinalizeNode,
  type StageExecutor,
  type Reviewer,
} from './nodes/workflowStages';

export interface WorkflowGraphExecutors {
  generateSpec?: StageExecutor;
  generateDesign?: StageExecutor;
  generateImpl?: StageExecutor;
  generateTest?: StageExecutor;
  review?: Reviewer;
}

/** Builds the conditional edge router for a given review stage. */
function makeReviewRouter(stage: WorkflowStage, next: string) {
  return function router(state: WorkflowStateType): string {
    if (state.reviewDecision === 'approved') return next;
    if (state.reviewDecision === 'revise') return stage;       // loop back
    return 'finalize';                                          // reject / pending
  };
}

export function buildWorkflowGraph(
  executors: WorkflowGraphExecutors = {},
  opts: { checkpointer?: MemorySaver } = {},
) {
  const builder = new StateGraph(WorkflowState)
    .addNode('spec', makeSpecNode(executors.generateSpec))
    .addNode('reviewSpec', makeReviewNode('spec', executors.review))
    .addNode('design', makeDesignNode(executors.generateDesign))
    .addNode('reviewDesign', makeReviewNode('design', executors.review))
    .addNode('impl', makeImplNode(executors.generateImpl))
    .addNode('reviewImpl', makeReviewNode('impl', executors.review))
    .addNode('test', makeTestNode(executors.generateTest))
    .addNode('reviewTest', makeReviewNode('test', executors.review))
    .addNode('finalize', makeFinalizeNode())
    .addEdge(START, 'spec')
    .addEdge('spec', 'reviewSpec')
    .addConditionalEdges('reviewSpec', makeReviewRouter('spec', 'design'), {
      spec: 'spec', design: 'design', finalize: 'finalize',
    })
    .addEdge('design', 'reviewDesign')
    .addConditionalEdges('reviewDesign', makeReviewRouter('design', 'impl'), {
      design: 'design', impl: 'impl', finalize: 'finalize',
    })
    .addEdge('impl', 'reviewImpl')
    .addConditionalEdges('reviewImpl', makeReviewRouter('impl', 'test'), {
      impl: 'impl', test: 'test', finalize: 'finalize',
    })
    .addEdge('test', 'reviewTest')
    .addConditionalEdges('reviewTest', makeReviewRouter('test', 'finalize'), {
      test: 'test', finalize: 'finalize',
    })
    .addEdge('finalize', END);

  return builder.compile({ checkpointer: opts.checkpointer });
}

/** Convenience runner. */
export async function runWorkflowGraph(
  userGoal: string,
  executors: WorkflowGraphExecutors = {},
  opts: { checkpointer?: MemorySaver; threadId?: string } = {},
): Promise<WorkflowStateType> {
  const graph = buildWorkflowGraph(executors, { checkpointer: opts.checkpointer });
  const config = opts.threadId ? { configurable: { thread_id: opts.threadId } } : undefined;
  const result = await graph.invoke(
    {
      userGoal,
      currentStage: 'spec',
      outputs: {},
      reviewDecision: 'pending',
      revisionCounts: {},
      errors: [],
      finalAnswer: undefined,
    },
    config,
  );
  return result;
}

export { MemorySaver };
