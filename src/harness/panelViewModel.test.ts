import { describe, expect, it } from 'vitest';
import { buildHarnessPanelViewModel, collectThreadArtifacts, findActiveThread } from './panelViewModel';

describe('panelViewModel', () => {
  it('finds the active thread by id', () => {
    const active = findActiveThread([
      { id: 'a', messages: [], todos: [] },
      { id: 'b', messages: [], todos: [] },
    ], 'b');
    expect(active?.id).toBe('b');
  });

  it('collects artifacts from thread messages', () => {
    const artifacts = collectThreadArtifacts([
      { artifacts: [{ id: 'x', filename: 'a.ts', language: 'ts', content: 'code' }] },
      {},
      { artifacts: [{ id: 'y', filename: 'b.ts', language: 'ts', content: 'code' }] },
    ]);
    expect(artifacts.map((artifact) => artifact.id)).toEqual(['x', 'y']);
  });

  it('builds a filtered render view model for the panel', () => {
    const vm = buildHarnessPanelViewModel({
      threads: [{
        id: 'a',
        messages: [{ artifacts: [{ id: 'x', filename: 'a.ts', language: 'ts', content: 'code' }] }],
        todos: [
          { id: 't1', text: 'done', status: 'completed' as const },
          { id: 't2', text: 'pending', status: 'pending' as const },
        ],
      }],
      activeThreadId: 'a',
      pendingSpecReview: null,
      pendingPlanReview: {
        options: [{ id: 'p1', title: 'Bundle', summary: 'sum', spec: 'spec' }],
        selectedIds: ['p1'],
      },
      followups: ['next'],
      isStreaming: false,
    });

    expect(vm.activeThread?.id).toBe('a');
    expect(vm.allArtifacts).toHaveLength(1);
    expect(vm.visibleTodos).toEqual([]);
    expect(vm.selectedPlanOptionChips).toHaveLength(1);
    expect(vm.showFollowupChips).toBe(false);
  });

  it('hides todos while workflow streaming is active', () => {
    const vm = buildHarnessPanelViewModel({
      threads: [{
        id: 'a',
        messages: [],
        todos: [{ id: 't1', text: 'pending', status: 'pending' as const }],
      }],
      activeThreadId: 'a',
      pendingSpecReview: null,
      pendingPlanReview: null,
      followups: [],
      isStreaming: true,
    });

    expect(vm.visibleTodos).toEqual([]);
  });
});
