import { describe, it, expect } from 'vitest';
import { streamUltraMode, streamWorkflowMode, type StreamEvent } from '../index';
import type { UltraStateType, WorkflowStateType } from '../index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('streamUltraMode', () => {
  it('yields start → node events → end with final state', async () => {
    const events = await collect(streamUltraMode({
      userInput: 'Research X. Draft Y. Compare Z.',
      backend: 'claude',
      // injected executors avoid touching Tauri
      executorsOverride: {
        decompose: async () => JSON.stringify([
          { id: 't1', description: 'research' },
          { id: 't2', description: 'draft' },
        ]),
        subAgent: async (desc) => `ok: ${desc}`,
        synthesize: async () => 'FINAL',
      },
    }));
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds[kinds.length - 1]).toBe('end');
    expect(kinds).toContain('node');
    const end = events[events.length - 1] as Extract<StreamEvent<UltraStateType>, { kind: 'end' }>;
    expect(end.state.finalAnswer).toBe('FINAL');
    expect(end.state.tasks.length).toBe(2);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits a node event for each of decompose, executeParallel, synthesize', async () => {
    const events = await collect(streamUltraMode({
      userInput: 'a. b. c.',
      backend: 'claude',
      executorsOverride: {
        decompose: async () => JSON.stringify([{ id: '1', description: 'x' }]),
        subAgent: async () => 'ok',
        synthesize: async () => 'done',
      },
    }));
    const nodeNames = events
      .filter((e): e is Extract<StreamEvent<UltraStateType>, { kind: 'node' }> => e.kind === 'node')
      .map((e) => e.node);
    expect(nodeNames).toEqual(['decompose', 'executeParallel', 'synthesize']);
  });
});

describe('streamWorkflowMode', () => {
  it('yields events for all stages and their reviews', async () => {
    const events = await collect(streamWorkflowMode({
      userGoal: 'ship feature',
      backend: 'claude',
      executorsOverride: {
        generateSpec: async () => 'spec',
        generateDesign: async () => 'design',
        generateImpl: async () => 'impl',
        generateTest: async () => 'test',
      },
    }));
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds[kinds.length - 1]).toBe('end');
    const nodes = events
      .filter((e): e is Extract<StreamEvent<WorkflowStateType>, { kind: 'node' }> => e.kind === 'node')
      .map((e) => e.node);
    // Order can vary slightly but must include each stage + its review + finalize.
    for (const expected of ['spec', 'reviewSpec', 'design', 'reviewDesign', 'impl', 'reviewImpl', 'test', 'reviewTest', 'finalize']) {
      expect(nodes).toContain(expected);
    }
    const end = events[events.length - 1] as Extract<StreamEvent<WorkflowStateType>, { kind: 'end' }>;
    expect(end.state.currentStage).toBe('done');
    expect(end.state.finalAnswer).toContain('spec');
  });
});
