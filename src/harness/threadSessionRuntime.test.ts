import { describe, expect, it } from 'vitest';
import { presentDirectResponse } from './chatOutput';
import {
  appendHumanMessageToThread,
  applyDirectResponsePresentationToThread,
  createHarnessThread,
  finalizeTodoExecution,
  markTodoInProgress,
  reduceWorkflowExecutionResultToThread,
} from './threadSessionRuntime';

describe('threadSessionRuntime', () => {
  it('creates a harness thread with default empty collections', () => {
    const thread = createHarnessThread<{
      id: string;
      title: string;
      messages: Array<{ content: string }>;
      todos: Array<{ id: string }>;
      createdAt: number;
      mode: string;
      provider: string;
    }>({
      thread: {
        id: 't1',
        createdAt: 1,
        mode: 'coding',
        provider: 'claude-cli',
      },
      title: 'Hello',
    });

    expect(thread.title).toBe('Hello');
    expect(thread.messages).toEqual([]);
    expect(thread.todos).toEqual([]);
  });

  it('appends a human message and promotes the title when empty', () => {
    const thread = {
      id: 't1',
      title: 'New chat',
      messages: [],
      todos: [],
      createdAt: 1,
      mode: 'coding',
      provider: 'claude-cli',
    };

    const updated = appendHumanMessageToThread(thread, {
      id: 'm1',
      role: 'human',
      content: 'Refactor the harness runtime',
      timestamp: 2,
    });

    expect(updated.messages).toHaveLength(1);
    expect(updated.title).toBe('Refactor the harness runtime');
  });

  it('applies direct response presentation including post messages and todos', () => {
    const thread = {
      id: 't1',
      title: 'Chat',
      messages: [] as Array<{ content: string }>,
      todos: [],
      createdAt: 1,
      mode: 'coding',
      provider: 'claude-cli',
    };
    const presented = presentDirectResponse({
      mainContent: 'Primary answer',
      thinking: 'thinking',
      toolCalls: [],
      artifacts: [],
      todos: [{ id: 'todo-1', text: 'Ship it', status: 'pending' }],
      durationMs: 50,
      followupSource: 'Primary answer',
      followupProvider: 'claude-cli',
      memorySummary: 'summary',
      postMessages: [{ content: 'follow-up note', artifacts: [] }],
    }, (() => {
      let i = 0;
      return () => `m-${++i}`;
    })(), () => 100);

    const updated = applyDirectResponsePresentationToThread(thread, presented);

    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[0].content).toBe('Primary answer');
    expect(updated.messages[1].content).toBe('follow-up note');
    expect(updated.todos).toHaveLength(1);
  });

  it('marks todo progress and finalizes execution with an assistant result', () => {
    const thread = {
      id: 't1',
      title: 'Chat',
      messages: [] as Array<{ content: string }>,
      todos: [{ id: 'todo-1', text: 'Run tests', status: 'pending' as const }],
      createdAt: 1,
      mode: 'coding',
      provider: 'claude-cli',
    };

    const inProgress = markTodoInProgress(thread, 'todo-1');
    expect(inProgress.todos[0].status).toBe('in_progress');

    const completed = finalizeTodoExecution(inProgress, {
      todoId: 'todo-1',
      todoText: 'Run tests',
      resultContent: '**Run tests**\n\nAll green',
      createId: () => 'm1',
      now: () => 200,
    });
    expect(completed.todos[0].status).toBe('completed');
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0].content).toContain('All green');
  });

  it('reduces workflow completion into thread messages and todos', () => {
    const thread = {
      id: 't1',
      title: 'Chat',
      messages: [] as Array<{ content: string }>,
      todos: [{ id: 'todo-1', text: 'Old', status: 'pending' as const }],
      createdAt: 1,
      mode: 'coding',
      provider: 'claude-cli',
    };

    const reduced = reduceWorkflowExecutionResultToThread(thread, {
      kind: 'completed',
      responseContent: 'Implemented the runtime split',
      artifacts: [],
      todos: [{ id: 'todo-2', text: 'New todo', status: 'pending' }],
      durationMs: 500,
      followupSource: 'Implemented the runtime split',
      followupProvider: 'claude-cli',
      primaryArtifact: undefined,
    }, () => 'm1', () => 300);

    expect(reduced.kind).toBe('completed');
    if (reduced.kind !== 'completed') return;
    expect(reduced.thread.messages).toHaveLength(1);
    expect((reduced.thread.messages[0] as { content: string }).content).toContain('Implemented the runtime split');
    expect(reduced.thread.todos[0].id).toBe('todo-2');
  });
});
