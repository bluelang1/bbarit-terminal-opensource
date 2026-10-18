import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runSubAgentMock, runCliPromptMock } = vi.hoisted(() => ({
  runSubAgentMock: vi.fn(),
  runCliPromptMock: vi.fn(),
}));

vi.mock('./cliRuntime', () => ({
  runSubAgent: runSubAgentMock,
  runCliPrompt: runCliPromptMock,
}));

import { executeDecomposedSubAgents } from './subAgentExecutor';

describe('executeDecomposedSubAgents', () => {
  beforeEach(() => {
    runSubAgentMock.mockReset();
    runCliPromptMock.mockReset();
  });

  it('synthesizes successful sub-agent results', async () => {
    runSubAgentMock
      .mockResolvedValueOnce('research result')
      .mockResolvedValueOnce('implementation result');
    runCliPromptMock.mockResolvedValue('final synthesis');

    const updates: any[] = [];
    const result = await executeDecomposedSubAgents({
      userMessage: 'fix this',
      selectedTasks: [
        { description: 'Research', provider: 'kimi-cli', prompt: 'research' },
        { description: 'Implement', provider: 'codex-cli', prompt: 'implement' },
      ],
      workDir: '/tmp/project',
      synthesisProvider: 'claude-cli',
      executionProfile: {
        effort: 'normal',
        stageTimeoutSecs: 600,
        subAgentTimeoutSecs: 300,
        decomposeTimeoutSecs: 60,
        directConversationTimeoutSecs: 600,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
      onPipelineUpdate: (pipeline) => updates.push(pipeline.map((task) => task.status)),
    });

    expect(runSubAgentMock).toHaveBeenCalledTimes(2);
    expect(runCliPromptMock).toHaveBeenCalledTimes(1);
    expect(result.mainContent).toBe('final synthesis');
    expect(result.followupSource).toBe('final synthesis');
    expect(result.pipeline.every((task) => task.status === 'completed')).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
  });

  it('returns failure summary when all sub-agents fail', async () => {
    runSubAgentMock
      .mockRejectedValueOnce(new Error('first failed'))
      .mockRejectedValueOnce(new Error('second failed'));

    const result = await executeDecomposedSubAgents({
      userMessage: 'fix this',
      selectedTasks: [
        { description: 'Research', provider: 'kimi-cli', prompt: 'research' },
        { description: 'Implement', provider: 'codex-cli', prompt: 'implement' },
      ],
      workDir: '/tmp/project',
      synthesisProvider: 'claude-cli',
      executionProfile: {
        effort: 'normal',
        stageTimeoutSecs: 600,
        subAgentTimeoutSecs: 300,
        decomposeTimeoutSecs: 60,
        directConversationTimeoutSecs: 600,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
    });

    expect(runCliPromptMock).not.toHaveBeenCalled();
    expect(result.mainContent).toContain('first failed');
    expect(result.mainContent).toContain('second failed');
    expect(result.pipeline.every((task) => task.status === 'failed')).toBe(true);
  });
});
