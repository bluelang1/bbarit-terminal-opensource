import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  executeInitialWorkflowMock,
  executeSpecReviewSelectionMock,
  executePlanReviewSelectionMock,
} = vi.hoisted(() => ({
  executeInitialWorkflowMock: vi.fn(),
  executeSpecReviewSelectionMock: vi.fn(),
  executePlanReviewSelectionMock: vi.fn(),
}));

vi.mock('./workflowExecutor', async () => {
  const actual = await vi.importActual<typeof import('./workflowExecutor')>('./workflowExecutor');
  return {
    ...actual,
    executeInitialWorkflow: executeInitialWorkflowMock,
  };
});

vi.mock('./workflowReviewExecutor', () => ({
  executeSpecReviewSelection: executeSpecReviewSelectionMock,
  executePlanReviewSelection: executePlanReviewSelectionMock,
}));

import {
  runWorkflowPlanReviewSelection,
  runWorkflowSessionStart,
  runWorkflowSpecReviewSelection,
} from './workflowSessionExecutor';

describe('workflowSessionExecutor', () => {
  beforeEach(() => {
    executeInitialWorkflowMock.mockReset();
    executeSpecReviewSelectionMock.mockReset();
    executePlanReviewSelectionMock.mockReset();
  });

  it('presents a completed workflow run as a thread transition', async () => {
    executeInitialWorkflowMock.mockResolvedValue({
      kind: 'completed',
      responseContent: 'Workflow completed',
      artifacts: [],
      todos: [{ id: 'todo-1', text: 'Test it', status: 'pending' }],
      durationMs: 25,
      followupSource: 'Workflow completed',
      followupProvider: 'claude-cli',
    });

    const result = await runWorkflowSessionStart({
      threadId: 'thread-1',
      thread: { messages: [], todos: [] },
      msgText: 'Fix it',
      startTime: 1,
      attachments: [],
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: {
        effort: 'normal',
        stageTimeoutSecs: 600,
        directConversationTimeoutSecs: 600,
        decomposeTimeoutSecs: 60,
        subAgentTimeoutSecs: 300,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
      threadMessages: [],
      createId: () => 'm1',
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.thread.messages).toHaveLength(1);
    expect((result.thread.messages[0] as { content: string }).content).toContain('Workflow completed');
    expect((result.thread.todos[0] as { status: string }).status).toBe('completed');
  });

  it('passes selected ids through spec review execution and returns pending plan review', async () => {
    executeSpecReviewSelectionMock.mockResolvedValue({
      kind: 'pending-plan-review',
      pending: {
        threadId: 'thread-1',
        message: 'Fix it',
        fileList: '',
        researchResult: 'research',
        selectedSpecs: [],
        planResult: 'plan',
        options: [],
        selectedIds: [],
      },
      pipeline: [],
      todos: [{ id: 'todo-1', text: 'Plan', status: 'pending' }],
    });

    const result = await runWorkflowSpecReviewSelection({
      thread: { messages: [], todos: [] },
      pending: {
        threadId: 'thread-1',
        message: 'Fix it',
        fileList: '',
        researchResult: 'research',
        options: [{ id: 'spec-a', title: 'A', summary: '', spec: '' }],
        selectedIds: ['spec-a'],
      },
      selectedIds: ['spec-a'],
      startTime: 1,
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: {
        effort: 'normal',
        stageTimeoutSecs: 600,
        directConversationTimeoutSecs: 600,
        decomposeTimeoutSecs: 60,
        subAgentTimeoutSecs: 300,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
      threadMessages: [],
      createId: () => 'm1',
    });

    expect(executeSpecReviewSelectionMock).toHaveBeenCalledWith(expect.objectContaining({
      selectedIds: ['spec-a'],
    }));
    expect(result?.kind).toBe('pending-plan-review');
  });

  it('returns null when plan review executor returns null', async () => {
    executePlanReviewSelectionMock.mockResolvedValue(null);

    const result = await runWorkflowPlanReviewSelection({
      thread: { messages: [], todos: [] },
      pending: {
        threadId: 'thread-1',
        message: 'Fix it',
        fileList: '',
        researchResult: 'research',
        selectedSpecs: [],
        planResult: 'plan',
        options: [],
        selectedIds: [],
      },
      selectedIds: ['plan-a'],
      startTime: 1,
      workDir: '/tmp/project',
      workflow: { id: 'w', name: 'Workflow', stages: [] },
      executionProfile: {
        effort: 'normal',
        stageTimeoutSecs: 600,
        directConversationTimeoutSecs: 600,
        decomposeTimeoutSecs: 60,
        subAgentTimeoutSecs: 300,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: () => {},
      threadMessages: [],
      createId: () => 'm1',
    });

    expect(result).toBeNull();
  });
});
