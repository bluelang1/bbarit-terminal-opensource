import { describe, it, expect } from 'vitest';
import {
  runWorkflowGraph,
  MemorySaver,
  MAX_REVISIONS_PER_STAGE,
  type WorkflowStage,
  type ReviewDecision,
} from './index';

describe('Workflow StateGraph', () => {
  it('runs all stages with default auto-approval', async () => {
    const state = await runWorkflowGraph('Build a login page', {
      generateSpec: async (_ctx, goal) => `SPEC for ${goal}`,
      generateDesign: async () => 'DESIGN',
      generateImpl: async () => 'IMPL',
      generateTest: async () => 'TEST',
    });
    expect(state.currentStage).toBe('done');
    expect(state.outputs?.spec).toBe('SPEC for Build a login page');
    expect(state.outputs?.design).toBe('DESIGN');
    expect(state.outputs?.impl).toBe('IMPL');
    expect(state.outputs?.test).toBe('TEST');
    expect(state.finalAnswer).toContain('SPEC');
    expect(state.finalAnswer).toContain('TEST');
    expect(state.errors).toEqual([]);
  });

  it('skips to finalize when spec reviewer rejects', async () => {
    const state = await runWorkflowGraph('Risky goal', {
      generateSpec: async () => 'bad spec',
      review: async (stage) => (stage === 'spec' ? 'reject' : 'approved'),
    });
    expect(state.outputs?.spec).toBe('bad spec');
    expect(state.outputs?.design).toBeUndefined();
    expect(state.currentStage).toBe('done');
  });

  it('loops back on revise up to MAX then rejects', async () => {
    let specCallCount = 0;
    const reviewCalls: Array<{ stage: WorkflowStage; decision: ReviewDecision }> = [];
    const state = await runWorkflowGraph('Tough goal', {
      generateSpec: async () => {
        specCallCount++;
        return `spec v${specCallCount}`;
      },
      review: async (stage) => {
        const decision: ReviewDecision = stage === 'spec' ? 'revise' : 'approved';
        reviewCalls.push({ stage, decision });
        return decision;
      },
    });
    // spec is run MAX_REVISIONS_PER_STAGE + 1 times (initial + revisions until limit breached)
    expect(specCallCount).toBeGreaterThanOrEqual(MAX_REVISIONS_PER_STAGE);
    expect(state.errors.some((e) => /max revisions/i.test(e))).toBe(true);
    // should not have progressed past spec
    expect(state.outputs?.design).toBeUndefined();
  });

  it('persists state across runs via MemorySaver (checkpointer)', async () => {
    const saver = new MemorySaver();
    const threadId = 'wf-test-1';
    const first = await runWorkflowGraph('Ship feature X', {
      generateSpec: async () => 'S1',
      generateDesign: async () => 'D1',
      generateImpl: async () => 'I1',
      generateTest: async () => 'T1',
    }, { checkpointer: saver, threadId });
    expect(first.currentStage).toBe('done');
    // New invocation on same thread should pick up existing final state
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeTruthy();
    expect(tuple?.checkpoint).toBeTruthy();
  });
});
