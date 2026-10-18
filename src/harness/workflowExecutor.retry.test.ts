import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, streamCliPromptMock, runCliPromptMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  streamCliPromptMock: vi.fn(),
  runCliPromptMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./cliRuntime', () => ({
  streamCliPrompt: streamCliPromptMock,
  runCliPrompt: runCliPromptMock,
}));

import { executeInitialWorkflow } from './workflowExecutor';
import { getWorkflowExecutionProfile, type WorkflowConfig } from './workflow';

describe('workflowExecutor review retry loop', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    streamCliPromptMock.mockReset();
    runCliPromptMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'read_directory') return [];
      return null;
    });
  });

  it('retries implement/review when review requests changes', async () => {
    const workflow: WorkflowConfig = {
      id: 'test',
      name: 'Test',
      effort: 'normal',
      stages: [
        { id: 'implement', name: 'Implement', provider: 'claude-cli', role: 'implement', promptTemplate: 'implement', enabled: true },
        { id: 'review', name: 'Review', provider: 'codex-cli', role: 'review', promptTemplate: 'review', enabled: true },
      ],
    };

    streamCliPromptMock
      .mockResolvedValueOnce('```src/a.ts\nconsole.log(\"draft 1\")\n```')
      .mockResolvedValueOnce('Verdict: CHANGES_REQUESTED\n\nBlocking issues:\n- add tests')
      .mockResolvedValueOnce('```src/a.ts\nconsole.log(\"draft 2 with tests\")\n```')
      .mockResolvedValueOnce('Verdict: APPROVED\n\nLooks good.');

    const pipelineUpdates: any[] = [];
    const result = await executeInitialWorkflow({
      threadId: 'thread-1',
      msgText: 'fix the harness',
      startTime: 0,
      attachments: [],
      workDir: '/tmp/project',
      workflow,
      executionProfile: getWorkflowExecutionProfile(workflow),
      responseLanguage: 'en',
      labels: { saved: 'Saved', files: 'files' },
      ensureCliProvider: (provider) => provider as any,
      onStreamingContent: () => {},
      onPipelineUpdate: (tasks) => pipelineUpdates.push(tasks.map((task) => task.description)),
      threadMessages: [],
    });

    expect(streamCliPromptMock).toHaveBeenCalledTimes(4);
    expect(streamCliPromptMock.mock.calls[2][1]).toContain('Latest review feedback to address before saving');
    expect(streamCliPromptMock.mock.calls[2][1]).toContain('CHANGES_REQUESTED');
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.responseContent).toContain('Workflow completed');
    expect(pipelineUpdates.some((update) => update.includes('Implement Retry 1'))).toBe(true);
    expect(pipelineUpdates.some((update) => update.includes('Review Retry 1'))).toBe(true);
  });
});
