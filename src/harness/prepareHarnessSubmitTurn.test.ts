import { describe, expect, it } from 'vitest';
import { prepareHarnessSubmitTurn } from './prepareHarnessSubmitTurn';
import { createHarnessRuntime } from './runtimeFactory';
import type { ChatThread } from './panelTypes';

describe('prepareHarnessSubmitTurn', () => {
  const harnessRuntime = createHarnessRuntime({
    mode: 'coding',
    provider: 'claude-cli',
    backgroundProvider: 'codex-cli',
    responseLanguage: 'en',
    ensureCliProvider: (provider) => provider as any,
  });

  it('creates a new thread submission and returns an immediate workflow run when forced', () => {
    const result = prepareHarnessSubmitTurn({
      activeThreadId: null,
      messageText: 'build a full workflow',
      mode: 'coding',
      provider: 'claude-cli',
      attachments: [{ id: 'a1', name: 'spec.md', type: 'text', mimeType: 'text/plain', dataUrl: 'hello', size: 5 }],
      threads: [],
      genId: () => 'fixed-id',
      forceWorkflow: true,
      harnessRuntime,
    });

    expect(result.submissionStart.activeThreadId).toBe('fixed-id');
    expect(result.submissionStart.threadId).toBe('fixed-id');
    expect(result.submissionRoute.kind).toBe('workflow-run');
    if (result.submissionRoute.kind === 'workflow-run') {
      expect(result.submissionRoute.runtimeMode).toBe('coding');
      expect(result.submissionRoute.runtimeUserMsg).toBe('build a full workflow');
    }
  });

  it('uses prior thread messages when routing a direct coding turn', () => {
    const threads: ChatThread[] = [{
      id: 'thread-1',
      title: 'Existing',
      createdAt: 1,
      mode: 'coding',
      provider: 'claude-cli',
      todos: [],
      messages: [
        { id: 'm1', role: 'human', content: 'first', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'reply', timestamp: 2 },
      ],
    }];

    const result = prepareHarnessSubmitTurn({
      activeThreadId: 'thread-1',
      messageText: '짧게 답해줘',
      mode: 'coding',
      provider: 'claude-cli',
      attachments: [],
      threads,
      genId: () => 'next-id',
      harnessRuntime,
    });

    expect(result.submissionStart.threadId).toBe('thread-1');
    expect(result.submissionStart.existingThreadBeforeSubmit?.messages).toHaveLength(2);
    expect(result.submissionRoute.kind).toBe('direct-response');
  });
});
