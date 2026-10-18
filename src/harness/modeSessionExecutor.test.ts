import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  executeImageGenerationModeMock,
  executeVideoGenerationModeMock,
  executeUltraModeMock,
  executeDirectResponseMock,
} = vi.hoisted(() => ({
  executeImageGenerationModeMock: vi.fn(),
  executeVideoGenerationModeMock: vi.fn(),
  executeUltraModeMock: vi.fn(),
  executeDirectResponseMock: vi.fn(),
}));

vi.mock('./modeExecutor', () => ({
  executeImageGenerationMode: executeImageGenerationModeMock,
  executeVideoGenerationMode: executeVideoGenerationModeMock,
  executeUltraMode: executeUltraModeMock,
}));

vi.mock('./responseExecutor', async () => {
  const actual = await vi.importActual<typeof import('./responseExecutor')>('./responseExecutor');
  return {
    ...actual,
    executeDirectResponse: executeDirectResponseMock,
  };
});

import { runModeSession } from './modeSessionExecutor';

const baseParams = {
  thread: { title: 'Chat', messages: [], todos: [] },
  msgText: 'hello',
  mode: 'thinking' as const,
  provider: 'claude-cli' as const,
  memories: [],
  skills: [],
  workDir: '/tmp/project',
  responseLanguage: 'en' as const,
  executionProfile: {
    effort: 'normal' as const,
    stageTimeoutSecs: 600,
    directConversationTimeoutSecs: 600,
    decomposeTimeoutSecs: 60,
    subAgentTimeoutSecs: 300,
    summaryTimeoutSecs: 30,
    toolBashTimeoutSecs: 30,
    reviewRetryLimit: 2,
  },
  ensureCliProvider: (provider: any) => provider,
  ultraProviders: ['claude-cli', 'codex-cli', 'kimi-cli'] as const,
  startTime: 1,
  createId: () => 'm1',
  onStreamingContent: () => {},
  onStreamingThinking: () => {},
  abortRef: { current: false },
};

describe('modeSessionExecutor', () => {
  beforeEach(() => {
    executeImageGenerationModeMock.mockReset();
    executeVideoGenerationModeMock.mockReset();
    executeUltraModeMock.mockReset();
    executeDirectResponseMock.mockReset();
  });

  it('returns completed image-gen thread presentation', async () => {
    executeImageGenerationModeMock.mockResolvedValue({
      content: 'generated',
      images: ['data:image/png;base64,abc'],
      durationMs: 10,
      followups: ['more'],
    });

    const result = await runModeSession({
      ...baseParams,
      route: { kind: 'image-gen', runtimeMode: 'image-gen', runtimeUserMsg: 'hello', isDirectCodingConversation: false },
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.thread.messages).toHaveLength(1);
    expect(result.followups).toEqual(['more']);
  });

  it('returns pending decompose for ultra mode', async () => {
    executeUltraModeMock.mockResolvedValue({
      kind: 'pending-decompose',
      tasks: [{ description: 'Research', provider: 'kimi-cli', prompt: 'research' }],
    });

    const result = await runModeSession({
      ...baseParams,
      route: { kind: 'ultra', runtimeMode: 'ultra', runtimeUserMsg: 'hello', isDirectCodingConversation: false },
    });

    expect(result.kind).toBe('pending-decompose');
    if (result.kind !== 'pending-decompose') return;
    expect(result.tasks).toHaveLength(1);
  });

  it('returns completed direct-response presentation with memory and followup metadata', async () => {
    executeDirectResponseMock.mockResolvedValue({
      mainContent: 'answer',
      thinking: undefined,
      toolCalls: [],
      artifacts: [],
      todos: [],
      postMessages: [],
      durationMs: 5,
      followupSource: 'answer',
      followupProvider: 'claude-cli',
      memorySummary: 'summary',
    });

    const result = await runModeSession({
      ...baseParams,
      route: { kind: 'direct-response', runtimeMode: 'thinking', runtimeUserMsg: 'hello', isDirectCodingConversation: false },
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.thread.messages).toHaveLength(1);
    expect(result.followupSource).toBe('answer');
    expect(result.memorySummary).toBe('summary');
    expect(executeDirectResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      middlewareAssembly: undefined,
    }));
  });

  it('forwards direct-response middleware assembly into the executor', async () => {
    executeDirectResponseMock.mockResolvedValue({
      mainContent: 'answer',
      thinking: undefined,
      toolCalls: [],
      artifacts: [],
      todos: [],
      postMessages: [],
      durationMs: 5,
    });

    await runModeSession({
      ...baseParams,
      route: { kind: 'direct-response', runtimeMode: 'thinking', runtimeUserMsg: 'hello', isDirectCodingConversation: false },
      middlewareAssembly: { features: { memoryAndPrompt: false } },
    });

    expect(executeDirectResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      middlewareAssembly: { features: { memoryAndPrompt: false } },
    }));
  });
});
