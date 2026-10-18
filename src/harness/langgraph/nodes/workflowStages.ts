/**
 * Workflow stage & review nodes.
 *
 * Each stage produces an output for that phase (spec/design/impl/test).
 * Review nodes delegate the approval decision to an injected reviewer
 * (for HITL) or auto-approve when none is provided.
 */
import type { WorkflowStateType, WorkflowStage, ReviewDecision } from '../state';

export type StageExecutor = (priorContext: string, userGoal: string) => Promise<string>;
export type Reviewer = (stage: WorkflowStage, output: string) => Promise<ReviewDecision>;

export const MAX_REVISIONS_PER_STAGE = 3;

function buildContext(state: WorkflowStateType, upTo: WorkflowStage): string {
  const order: WorkflowStage[] = ['spec', 'design', 'impl', 'test'];
  const idx = order.indexOf(upTo);
  const parts: string[] = [`Goal: ${state.userGoal}`];
  for (let i = 0; i < idx; i++) {
    const s = order[i];
    const out = state.outputs?.[s];
    if (out) parts.push(`--- ${s.toUpperCase()} ---\n${out}`);
  }
  return parts.join('\n\n');
}

async function runStage(
  stage: WorkflowStage,
  state: WorkflowStateType,
  executor: StageExecutor | undefined,
): Promise<Partial<WorkflowStateType>> {
  const ctx = buildContext(state, stage);
  const run = executor || (async (_ctx, goal) => `[stub:${stage}] ${goal}`);
  try {
    const output = await run(ctx, state.userGoal);
    return {
      currentStage: stage,
      outputs: { [stage]: output },
      reviewDecision: 'pending',
    };
  } catch (err) {
    return {
      currentStage: stage,
      errors: [`${stage}: ${String(err)}`],
      reviewDecision: 'reject',
    };
  }
}

export const makeSpecNode = (exec?: StageExecutor) =>
  (state: WorkflowStateType) => runStage('spec', state, exec);
export const makeDesignNode = (exec?: StageExecutor) =>
  (state: WorkflowStateType) => runStage('design', state, exec);
export const makeImplNode = (exec?: StageExecutor) =>
  (state: WorkflowStateType) => runStage('impl', state, exec);
export const makeTestNode = (exec?: StageExecutor) =>
  (state: WorkflowStateType) => runStage('test', state, exec);

/**
 * Review node factory. The reviewer is invoked with the just-completed stage's
 * output; missing reviewer → auto-approve.
 */
export function makeReviewNode(stage: WorkflowStage, reviewer?: Reviewer) {
  return async function reviewNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
    const output = state.outputs?.[stage] || '';
    if (!output) {
      return { reviewDecision: 'reject', errors: [`review(${stage}): no output`] };
    }
    try {
      const decision = reviewer ? await reviewer(stage, output) : 'approved';
      const revCounts = { ...(state.revisionCounts || {}) };
      if (decision === 'revise') {
        const next = (revCounts[stage] || 0) + 1;
        revCounts[stage] = next;
        if (next > MAX_REVISIONS_PER_STAGE) {
          return {
            reviewDecision: 'reject',
            revisionCounts: revCounts,
            errors: [`review(${stage}): max revisions (${MAX_REVISIONS_PER_STAGE}) exceeded`],
          };
        }
        return { reviewDecision: 'revise', revisionCounts: revCounts };
      }
      return { reviewDecision: decision };
    } catch (err) {
      return {
        reviewDecision: 'reject',
        errors: [`review(${stage}) error: ${String(err)}`],
      };
    }
  };
}

/** Produces a final synthesized answer from all stage outputs. */
export function makeFinalizeNode() {
  return async function finalizeNode(state: WorkflowStateType): Promise<Partial<WorkflowStateType>> {
    const order: WorkflowStage[] = ['spec', 'design', 'impl', 'test'];
    const sections = order
      .map((s) => {
        const body = state.outputs?.[s];
        return body ? `## ${s.toUpperCase()}\n${body}` : null;
      })
      .filter(Boolean)
      .join('\n\n');
    return {
      currentStage: 'done',
      finalAnswer: sections || '(no outputs)',
    };
  };
}
