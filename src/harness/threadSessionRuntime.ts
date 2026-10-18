import type { Artifact, TodoItem } from '../components/harness-utils';
import type { DirectResponsePresentation } from './chatOutput';
import { buildAssistantMessage } from './chatOutput';
import type { CliProvider } from './cliRuntime';
import { estimateTokenUsage } from './tokenUsage';
import type {
  PendingPlanReview,
  PendingSpecReview,
  WorkflowExecutionResult,
  WorkflowExecutionTask,
} from './workflowExecutor';

export function createHarnessThread<T extends object>(params: {
  thread: Omit<T, 'title' | 'messages' | 'todos'>;
  title: string;
  initialMessages?: unknown[];
}): T {
  return {
    ...params.thread,
    title: params.title,
    messages: params.initialMessages || [],
    todos: [],
  } as unknown as T;
}

export function appendHumanMessageToThread<T extends { title: string; messages: M[] }, M extends { content: string }>(
  thread: T,
  message: M,
): T {
  return {
    ...thread,
    title: thread.messages.length === 0 ? message.content.slice(0, 50) : thread.title,
    messages: [...thread.messages, message] as T['messages'],
  };
}

export function appendAssistantMessageToThread<T extends { messages: M[] }, M>(
  thread: T,
  message: M,
): T {
  return {
    ...thread,
    messages: [...thread.messages, message] as T['messages'],
  };
}

export function replaceThreadTodosIfPresent<T extends { todos: TodoItem[] }>(
  thread: T,
  todos: TodoItem[],
): T {
  return {
    ...thread,
    todos: todos.length > 0 ? todos : thread.todos,
  };
}

export function applyDirectResponsePresentationToThread<T extends { messages: unknown[]; todos: TodoItem[] }>(
  thread: T,
  presentation: DirectResponsePresentation,
): T {
  return {
    ...thread,
    messages: [
      ...thread.messages,
      presentation.primaryMessage,
      ...presentation.postMessages,
    ] as T['messages'],
    todos: presentation.todos.length > 0 ? presentation.todos : thread.todos,
  };
}

export function markTodoInProgress<T extends { todos: TodoItem[] }>(thread: T, todoId: string): T {
  return {
    ...thread,
    todos: thread.todos.map((todo) => (
      todo.id === todoId ? { ...todo, status: 'in_progress' as const } : todo
    )),
  };
}

export function completeTodos(todos: TodoItem[]): TodoItem[] {
  return (todos || []).map((todo) => ({ ...todo, status: 'completed' as const }));
}

export function finalizeTodoExecution<T extends { messages: unknown[]; todos: TodoItem[] }>(
  thread: T,
  params: {
    todoId: string;
    todoText: string;
    resultContent: string;
    artifacts?: Artifact[];
    createId: () => string;
    now?: () => number;
  },
): T {
  const assistantMessage = buildAssistantMessage({
    id: params.createId(),
    content: params.resultContent,
    artifacts: params.artifacts,
    timestamp: (params.now || (() => Date.now()))(),
  });
  return {
    ...thread,
    messages: [...thread.messages, assistantMessage] as T['messages'],
    todos: thread.todos.map((todo) => (
      todo.id === params.todoId ? { ...todo, status: 'completed' as const } : todo
    )),
  };
}

export type WorkflowThreadTransition<T extends { messages: unknown[]; todos: TodoItem[] }> =
  | {
      kind: 'pending-spec-review';
      pending: PendingSpecReview;
      pipeline: WorkflowExecutionTask[];
      thread: Pick<T, 'todos'>;
    }
  | {
      kind: 'pending-plan-review';
      pending: PendingPlanReview;
      pipeline: WorkflowExecutionTask[];
      thread: Pick<T, 'todos'>;
    }
  | {
      kind: 'completed';
      primaryArtifact?: Artifact;
      followupSource: string;
      followupProvider: CliProvider;
      thread: Pick<T, 'messages' | 'todos'>;
    };

export function reduceWorkflowExecutionResultToThread<T extends { messages: unknown[]; todos: TodoItem[] }>(
  thread: T,
  result: WorkflowExecutionResult,
  createId: () => string,
  now: () => number = () => Date.now(),
): WorkflowThreadTransition<T> {
  if (result.kind === 'pending-spec-review') {
    return {
      kind: result.kind,
      pending: result.pending,
      pipeline: result.pipeline,
      thread: { todos: thread.todos },
    };
  }

  if (result.kind === 'pending-plan-review') {
    return {
      kind: result.kind,
      pending: result.pending,
      pipeline: result.pipeline,
      thread: {
        todos: result.todos.length > 0 ? result.todos : thread.todos,
      },
    };
  }

  const assistantMessage = buildAssistantMessage({
    id: createId(),
    content: result.responseContent,
    artifacts: result.artifacts,
    timestamp: now(),
    durationMs: result.durationMs,
    tokenUsage: estimateTokenUsage({
      promptText: '',
      completionText: result.responseContent,
      warning: 'Workflow token usage is estimated from the final response; per-stage provider usage was not reported.',
    }),
  });

  return {
    kind: 'completed',
    primaryArtifact: result.primaryArtifact,
    followupSource: result.followupSource,
    followupProvider: result.followupProvider,
    thread: {
      messages: [...thread.messages, assistantMessage],
      todos: result.todos.length > 0 ? completeTodos(result.todos) : completeTodos(thread.todos),
    },
  };
}
