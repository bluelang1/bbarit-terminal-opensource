import { beforeEach, describe, expect, it, vi } from 'vitest';

const { decomposeTaskMock, runCliPromptMock } = vi.hoisted(() => ({
  decomposeTaskMock: vi.fn(),
  runCliPromptMock: vi.fn(),
}));

vi.mock('./cliRuntime', () => ({
  decomposeTask: decomposeTaskMock,
  runCliPrompt: runCliPromptMock,
}));

import { detectRequestedImageCount, executeUltraMode } from './modeExecutor';

describe('detectRequestedImageCount', () => {
  it('extracts requested image counts from english and korean phrases', () => {
    expect(detectRequestedImageCount('make 3 images')).toBe(3);
    expect(detectRequestedImageCount('이미지 2개 만들어줘')).toBe(2);
    expect(detectRequestedImageCount('just make something')).toBe(1);
  });
});

describe('executeUltraMode', () => {
  beforeEach(() => {
    decomposeTaskMock.mockReset();
    runCliPromptMock.mockReset();
  });

  it('returns pending decompose result when decomposition succeeds', async () => {
    decomposeTaskMock.mockResolvedValue([
      { description: 'Research', provider: 'kimi-cli', prompt: 'research it' },
    ]);

    const result = await executeUltraMode(
      'analyze this',
      100,
      'claude-cli',
      '/tmp/project',
      ['claude-cli', 'codex-cli', 'kimi-cli'],
      {
        effort: 'normal',
        stageTimeoutSecs: 600,
        directConversationTimeoutSecs: 600,
        decomposeTimeoutSecs: 60,
        subAgentTimeoutSecs: 300,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
    );

    expect(result.kind).toBe('pending-decompose');
    if (result.kind === 'pending-decompose') {
      expect(result.tasks).toHaveLength(1);
    }
    expect(runCliPromptMock).not.toHaveBeenCalled();
  });

  it('falls back to a single cli response when decomposition is empty', async () => {
    decomposeTaskMock.mockResolvedValue([]);
    runCliPromptMock.mockResolvedValue('fallback answer');

    const result = await executeUltraMode(
      'analyze this',
      Date.now() - 50,
      'claude-cli',
      '/tmp/project',
      ['claude-cli', 'codex-cli', 'kimi-cli'],
      {
        effort: 'normal',
        stageTimeoutSecs: 600,
        directConversationTimeoutSecs: 600,
        decomposeTimeoutSecs: 60,
        subAgentTimeoutSecs: 300,
        summaryTimeoutSecs: 30,
        toolBashTimeoutSecs: 30,
        reviewRetryLimit: 2,
      },
    );

    expect(result.kind).toBe('fallback-response');
    if (result.kind === 'fallback-response') {
      expect(result.content).toBe('fallback answer');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
