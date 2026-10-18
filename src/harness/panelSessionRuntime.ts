import { appendHumanMessageToThread, createHarnessThread } from './threadSessionRuntime';

export interface SessionMessageLike {
  content: string;
}

export interface SessionThreadLike<TMessage extends SessionMessageLike = SessionMessageLike> {
  id: string;
  title: string;
  messages: TMessage[];
}

export interface BeginSubmissionResult<TThread> {
  threads: TThread[];
  activeThreadId: string;
  threadId: string;
  existingThreadBeforeSubmit: TThread | null;
}

export function insertThreadAtTop<TThread>(threads: TThread[], thread: TThread): TThread[] {
  return [thread, ...threads];
}

export function removeThreadById<TThread extends { id: string }>(
  threads: TThread[],
  threadId: string,
): TThread[] {
  return threads.filter((thread) => thread.id !== threadId);
}

export function updateThreadById<TThread extends { id: string }>(
  threads: TThread[],
  threadId: string,
  updater: (thread: TThread) => TThread,
): TThread[] {
  return threads.map((thread) => (thread.id === threadId ? updater(thread) : thread));
}

export function beginHarnessSubmission<
  TMessage extends SessionMessageLike,
  TThread extends SessionThreadLike<TMessage>
>(params: {
  threads: TThread[];
  activeThreadId: string | null;
  humanMessage: TMessage;
  buildNewThread: (message: TMessage) => TThread;
}): BeginSubmissionResult<TThread> {
  const existingThreadBeforeSubmit = params.activeThreadId
    ? (params.threads.find((thread) => thread.id === params.activeThreadId) || null)
    : null;

  if (!params.activeThreadId) {
    const newThread = params.buildNewThread(params.humanMessage);
    return {
      threads: insertThreadAtTop(params.threads, newThread),
      activeThreadId: newThread.id,
      threadId: newThread.id,
      existingThreadBeforeSubmit: null,
    };
  }

  return {
    threads: updateThreadById(params.threads, params.activeThreadId, (thread) =>
      appendHumanMessageToThread(thread, params.humanMessage),
    ),
    activeThreadId: params.activeThreadId,
    threadId: params.activeThreadId,
    existingThreadBeforeSubmit,
  };
}

export function createNewCodingThread<TThread extends { title: string; messages: unknown[]; todos: unknown[] }>(params: {
  thread: Omit<TThread, 'title' | 'messages' | 'todos'>;
  title: string;
  initialMessages?: unknown[];
}): TThread {
  return createHarnessThread<TThread>({
    thread: params.thread,
    title: params.title,
    initialMessages: params.initialMessages,
  });
}
