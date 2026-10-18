import { describe, expect, it } from 'vitest';
import {
  beginHarnessSubmission,
  createNewCodingThread,
  insertThreadAtTop,
  removeThreadById,
  updateThreadById,
} from './panelSessionRuntime';

describe('panelSessionRuntime', () => {
  it('inserts a new thread at the top', () => {
    expect(insertThreadAtTop([{ id: 'a' }], { id: 'b' })).toEqual([{ id: 'b' }, { id: 'a' }]);
  });

  it('removes a thread by id', () => {
    expect(removeThreadById([{ id: 'a' }, { id: 'b' }], 'a')).toEqual([{ id: 'b' }]);
  });

  it('updates a thread by id', () => {
    expect(updateThreadById([{ id: 'a', value: 1 }, { id: 'b', value: 2 }], 'b', (thread) => ({
      ...thread,
      value: 3,
    }))).toEqual([{ id: 'a', value: 1 }, { id: 'b', value: 3 }]);
  });

  it('begins submission by creating a new thread when none is active', () => {
    const result = beginHarnessSubmission({
      threads: [],
      activeThreadId: null,
      humanMessage: { id: 'm1', content: 'hello' },
      buildNewThread: (message) => createNewCodingThread<{
        id: string;
        title: string;
        messages: Array<{ id: string; content: string }>;
        todos: never[];
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
        title: message.content,
        initialMessages: [message],
      }),
    });

    expect(result.threadId).toBe('t1');
    expect(result.activeThreadId).toBe('t1');
    expect(result.threads).toHaveLength(1);
    expect(result.existingThreadBeforeSubmit).toBeNull();
  });

  it('begins submission by appending to the active thread', () => {
    const result = beginHarnessSubmission({
      threads: [{
        id: 't1',
        title: 'Chat',
        messages: [{ id: 'm0', content: 'before' }],
      }],
      activeThreadId: 't1',
      humanMessage: { id: 'm1', content: 'after' },
      buildNewThread: () => {
        throw new Error('should not create');
      },
    });

    expect(result.threadId).toBe('t1');
    expect(result.existingThreadBeforeSubmit?.id).toBe('t1');
    expect(result.threads[0].messages).toHaveLength(2);
    expect(result.threads[0].messages[1].content).toBe('after');
  });
});
