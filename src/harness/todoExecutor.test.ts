import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, autoSaveFilesMock, extractArtifactsMock, runCliPromptMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  autoSaveFilesMock: vi.fn(),
  extractArtifactsMock: vi.fn(),
  runCliPromptMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./contentRuntime', () => ({
  autoSaveFiles: autoSaveFilesMock,
}));

vi.mock('./cliRuntime', () => ({
  runCliPrompt: runCliPromptMock,
}));

vi.mock('../components/harness-utils', async () => {
  const actual = await vi.importActual<typeof import('../components/harness-utils')>('../components/harness-utils');
  return {
    ...actual,
    extractArtifacts: extractArtifactsMock,
  };
});

import { executeTodoTask } from './todoExecutor';

describe('todoExecutor', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    autoSaveFilesMock.mockReset();
    extractArtifactsMock.mockReset();
    runCliPromptMock.mockReset();
  });

  it('marks todo complete with saved notice and artifacts on success', async () => {
    runCliPromptMock.mockResolvedValue('All green');
    autoSaveFilesMock.mockResolvedValue(['src/a.ts']);
    extractArtifactsMock.mockReturnValue([{ id: 'a', filename: 'src/a.ts', language: 'ts', content: 'code' }]);

    const result = await executeTodoTask({
      thread: {
        messages: [],
        todos: [{ id: 'todo-1', text: 'Run tests', status: 'pending' as const }],
      },
      todoId: 'todo-1',
      todoText: 'Run tests',
      provider: 'claude-cli',
      workDir: '/tmp/project',
      timeoutSecs: 30,
      createId: () => 'm1',
      now: () => 10,
    });

    expect(result.thread.todos[0].status).toBe('completed');
    expect(result.thread.messages).toHaveLength(1);
    expect((result.thread.messages[0] as { content: string }).content).toContain('Saved');
    expect(result.artifacts).toHaveLength(1);
  });

  it('returns an error completion message when cli execution fails', async () => {
    runCliPromptMock.mockRejectedValue(new Error('boom'));

    const result = await executeTodoTask({
      thread: {
        messages: [],
        todos: [{ id: 'todo-1', text: 'Run tests', status: 'pending' as const }],
      },
      todoId: 'todo-1',
      todoText: 'Run tests',
      provider: 'claude-cli',
      workDir: '/tmp/project',
      timeoutSecs: 30,
      createId: () => 'm1',
      now: () => 10,
    });

    expect(result.thread.todos[0].status).toBe('completed');
    expect(result.resultContent).toContain('Error');
    expect(result.artifacts).toEqual([]);
  });
});
