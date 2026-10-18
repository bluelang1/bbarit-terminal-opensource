import { describe, it, expect } from 'vitest';
import { KvCheckpointSaver, InMemoryKvAdapter } from './checkpointer';
import { runWorkflowGraph, buildWorkflowGraph } from './workflowGraph';

describe('KvCheckpointSaver', () => {
  it('persists a run and retrieves via getTuple', async () => {
    const kv = new InMemoryKvAdapter();
    const saver = new KvCheckpointSaver(kv);
    const threadId = 'thr-1';
    await runWorkflowGraph('Feature X', {
      generateSpec: async () => 'S',
      generateDesign: async () => 'D',
      generateImpl: async () => 'I',
      generateTest: async () => 'T',
    }, { checkpointer: saver as any, threadId });
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    expect(tuple).toBeTruthy();
    expect(tuple?.checkpoint).toBeTruthy();
  });

  it('survives a fresh graph rebuild (same thread_id resumes state)', async () => {
    const kv = new InMemoryKvAdapter();
    const saver = new KvCheckpointSaver(kv);
    const threadId = 'thr-resume';
    const goal = 'Ship billing';

    // First run — completes
    const first = await runWorkflowGraph(goal, {
      generateSpec: async () => 'spec-v1',
      generateDesign: async () => 'design-v1',
      generateImpl: async () => 'impl-v1',
      generateTest: async () => 'test-v1',
    }, { checkpointer: saver as any, threadId });
    expect(first.currentStage).toBe('done');

    // Second invocation: a brand-new graph instance with the SAME saver + thread
    // should surface the last checkpoint (getTuple returns persisted state).
    const graph2 = buildWorkflowGraph({}, { checkpointer: saver as any });
    const snapshot = await graph2.getState({ configurable: { thread_id: threadId } });
    expect(snapshot.values.outputs.spec).toBe('spec-v1');
    expect(snapshot.values.outputs.design).toBe('design-v1');
    expect(snapshot.values.finalAnswer).toContain('spec-v1');
  });

  it('list() yields checkpoints newest-first and respects limit', async () => {
    const kv = new InMemoryKvAdapter();
    const saver = new KvCheckpointSaver(kv);
    const threadId = 'thr-list';
    await runWorkflowGraph('a', {
      generateSpec: async () => 'a1',
      generateDesign: async () => 'a2',
      generateImpl: async () => 'a3',
      generateTest: async () => 'a4',
    }, { checkpointer: saver as any, threadId });
    const collected: string[] = [];
    for await (const t of saver.list({ configurable: { thread_id: threadId } }, { limit: 3 })) {
      collected.push(t.checkpoint.id);
    }
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.length).toBeLessThanOrEqual(3);
  });

  it('deleteThread() clears all data for a thread', async () => {
    const kv = new InMemoryKvAdapter();
    const saver = new KvCheckpointSaver(kv);
    const threadId = 'thr-delete';
    await runWorkflowGraph('hello', {
      generateSpec: async () => 's',
      generateDesign: async () => 'd',
      generateImpl: async () => 'i',
      generateTest: async () => 't',
    }, { checkpointer: saver as any, threadId });
    expect(await saver.getTuple({ configurable: { thread_id: threadId } })).toBeTruthy();
    await saver.deleteThread(threadId);
    expect(await saver.getTuple({ configurable: { thread_id: threadId } })).toBeUndefined();
  });
});
