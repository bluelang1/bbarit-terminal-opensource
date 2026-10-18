import type { Artifact, TodoItem } from '../components/harness-utils';
import { runCliPrompt, type CliProvider } from './cliRuntime';
import { autoSaveFiles } from './contentRuntime';
import { extractArtifacts } from '../components/harness-utils';
import { finalizeTodoExecution, markTodoInProgress } from './threadSessionRuntime';

export interface TodoExecutionResult<TThread extends { messages: unknown[]; todos: TodoItem[] }> {
  thread: TThread;
  artifacts: Artifact[];
  resultContent: string;
}

export async function executeTodoTask<TThread extends { messages: unknown[]; todos: TodoItem[] }>(params: {
  thread: TThread;
  todoId: string;
  todoText: string;
  provider: CliProvider;
  workDir: string;
  timeoutSecs: number;
  createId: () => string;
  now?: () => number;
}): Promise<TodoExecutionResult<TThread>> {
  const inProgressThread = markTodoInProgress(params.thread, params.todoId);

  try {
    const result = await runCliPrompt(params.provider, params.todoText, params.workDir, params.timeoutSecs);
    const todoSaved = await autoSaveFiles(result || '', params.workDir);
    const todoSaveNotice = todoSaved.length > 0
      ? `\n\n**Saved:** ${todoSaved.map((file) => `\`${file}\``).join(', ')}`
      : '';
    const artifacts = extractArtifacts(result || '');
    const resultContent = `**${params.todoText}**\n\n${result || '(completed)'}${todoSaveNotice}`;
    return {
      thread: finalizeTodoExecution(inProgressThread, {
        todoId: params.todoId,
        todoText: params.todoText,
        resultContent,
        artifacts,
        createId: params.createId,
        now: params.now,
      }),
      artifacts,
      resultContent,
    };
  } catch (error) {
    const resultContent = `**${params.todoText}** — Error: ${String(error)}`;
    return {
      thread: finalizeTodoExecution(inProgressThread, {
        todoId: params.todoId,
        todoText: params.todoText,
        resultContent,
        createId: params.createId,
        now: params.now,
      }),
      artifacts: [],
      resultContent,
    };
  }
}
