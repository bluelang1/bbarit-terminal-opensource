import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  isLocalCliProvider,
  runCliPrompt,
  streamCliPrompt,
  type CliProvider,
} from './cliRuntime';
import { buildAtlasCloudChatRequest, parseAtlasCloudStreamChunk } from './atlasCloudRuntime';
import { autoSaveFiles } from './contentRuntime';
import { prepareDirectResponseContext, type DirectResponseAssemblyOptions, type DirectResponseMiddlewareContext } from './middleware';
import { executeHarnessTool } from './toolExecutor';
import { runBackgroundLearningReview, type LearningReviewResult } from './learningRuntime';
import { abortLearningAgentLoop, beginLearningAgentLoop, finalizeLearningAgentLoop } from './learningAgentLoop';
import type { LearningProvider, LearningProviderRegistry } from './learningProviders';
import type { WorkflowExecutionProfile } from './workflow';
import type { HarnessResponseLanguage } from './prompting';
import { loadHarnessProjectDocsContext } from './projectDocs';
import {
  extractArtifacts,
  extractTodos,
  genId,
  parseToolCalls,
  type Artifact,
  type TodoItem,
} from '../components/harness-utils';
import {
  estimateTokenUsage,
  normalizeProviderTokenUsage,
  type HarnessTokenUsage,
} from './tokenUsage';

export type ResponseExecutorMode = 'flash' | 'thinking' | 'pro' | 'ultra' | 'deep-research' | 'image-gen' | 'video-gen' | 'coding';
export type ResponseExecutorProvider = 'atlascloud' | 'ollama' | 'openai' | 'claude-api' | 'claude-cli' | 'codex-cli' | 'kimi-cli' | 'gemini-cli' | 'qwen-cli';

export interface ResponseExecutorToolCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  status: 'running' | 'done' | 'error';
}

export interface ResponseExecutorMessage {
  role: 'human' | 'assistant' | 'tool' | 'system';
  content: string;
}

export interface ResponseExecutorMemory {
  content: string;
  pinned?: boolean;
  createdAt?: number;
}

export interface ResponseExecutorSkill {
  name: string;
  description: string;
  cliType?: string;
  category?: string;
  command?: string;
}

export interface DirectResponseResult {
  mainContent: string;
  thinking?: string;
  toolCalls?: ResponseExecutorToolCall[];
  artifacts: Artifact[];
  todos: TodoItem[];
  postMessages: Array<{ content: string; artifacts?: Artifact[] }>;
  durationMs: number;
  followupSource?: string;
  followupProvider?: CliProvider;
  memorySummary?: string;
  learningReview?: LearningReviewResult;
  clarificationOnly?: boolean;
  tokenUsage?: HarnessTokenUsage;
}

interface ExecuteDirectResponseParams {
  mode: ResponseExecutorMode;
  provider: ResponseExecutorProvider;
  msgText: string;
  runtimeUserMsg: string;
  workDir: string;
  memories: ResponseExecutorMemory[];
  skills: ResponseExecutorSkill[];
  threadMessages: ResponseExecutorMessage[];
  executionProfile: WorkflowExecutionProfile;
  isDirectCodingConversation: boolean;
  responseLanguage: HarnessResponseLanguage;
  activeThreadTitle?: string;
  threadSummary?: string;
  providersOrRegistry?: LearningProvider[] | LearningProviderRegistry;
  ensureCliProvider: (provider: ResponseExecutorProvider) => CliProvider;
  forceProviderForMode?: ResponseExecutorProvider;
  middlewareAssembly?: DirectResponseAssemblyOptions;
  prepareContext?: (
    input: Parameters<typeof prepareDirectResponseContext>[0],
    options?: DirectResponseAssemblyOptions,
  ) => DirectResponseMiddlewareContext;
  onStreamingContent: (text: string) => void;
  onStreamingThinking: (text: string) => void;
  onStepProgress?: (text: string) => void;
  abortRef: { current: boolean };
}

function extractExecutableShellBlocks(content: string): string[] {
  const commands: string[] = [];
  const regex = /```(?:bash|sh|shell|zsh)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content || '')) !== null) {
    const command = match[1].trim();
    const executableLines = command
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    if (executableLines.length === 0) continue;
    commands.push(command);
    if (commands.length >= 6) break;
  }
  return commands;
}

function stripExecutableShellBlocks(content: string): string {
  return String(content || '')
    .replace(/```(?:bash|sh|shell|zsh)\s*\n[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function summarizeShellCommand(command: string): string {
  const firstCommand = command
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#')) || command.trim();
  return firstCommand.length > 72 ? `${firstCommand.slice(0, 69)}...` : firstCommand;
}

async function kvGet(key: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('kv_get', { key });
    if (value != null) return value;
  } catch {
    // Fall back below.
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function parseStreamChunk(
  provider: ResponseExecutorProvider,
  rawData: string,
  onChunk: (text: string) => void,
  onThinking: (text: string) => void,
  onUsage?: (usage: HarnessTokenUsage) => void,
) {
  const lines = rawData.split('\n').filter(Boolean);
  for (const line of lines) {
    if (provider === 'ollama') {
      try {
        const obj = JSON.parse(line);
        if (obj.message?.content) onChunk(obj.message.content);
        const usage = normalizeProviderTokenUsage({
          promptTokens: obj.prompt_eval_count,
          completionTokens: obj.eval_count,
        });
        if (usage) onUsage?.(usage);
      } catch {
        /* skip */
      }
      continue;
    }
    if (provider === 'openai' || provider === 'atlascloud') {
      const stripped = line.startsWith('data: ') ? line.slice(6) : line;
      if (stripped.trim() !== '[DONE]') {
        try {
          const obj = JSON.parse(stripped);
          const usage = normalizeProviderTokenUsage({
            promptTokens: obj.usage?.prompt_tokens,
            completionTokens: obj.usage?.completion_tokens,
            totalTokens: obj.usage?.total_tokens,
          });
          if (usage) onUsage?.(usage);
        } catch {
          /* skip usage parse */
        }
      }
      parseAtlasCloudStreamChunk(line, onChunk, onThinking);
      continue;
    }
    if (provider === 'claude-api') {
      const stripped = line.startsWith('data: ') ? line.slice(6) : line;
      if (stripped.startsWith('event:') || !stripped.trim()) continue;
      try {
        const obj = JSON.parse(stripped);
        if (obj.type === 'content_block_delta') {
          if (obj.delta?.type === 'text_delta') onChunk(obj.delta.text);
          else if (obj.delta?.type === 'thinking_delta') onThinking(obj.delta.thinking);
        }
        const usage = normalizeProviderTokenUsage({
          promptTokens: obj.usage?.input_tokens,
          completionTokens: obj.usage?.output_tokens,
        });
        if (usage) onUsage?.(usage);
      } catch {
        /* skip */
      }
    }
  }
}

async function buildRequest(
  provider: ResponseExecutorProvider,
  messages: { role: string; content: string }[],
  mode: ResponseExecutorMode,
): Promise<{ url: string; headers: Record<string, string>; body: string }> {
  if (provider === 'ollama') {
    // 127.0.0.1 고정: 앱 백엔드(reqwest)가 localhost를 IPv6(::1)로 풀어 Ollama(IPv4) 연결에 실패함.
    const baseUrl = ((await kvGet('octo-ollama-url')) || '').trim() || 'http://127.0.0.1:11434';
    const model = ((await kvGet('octo-ollama-model')) || '').trim() || 'llama3.2';
    return {
      url: `${baseUrl}/api/chat`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { num_predict: mode === 'flash' ? 2048 : 4096 } }),
    };
  }
  if (provider === 'openai') {
    const apiKey = ((await kvGet('octo-openai-api-key')) || '').trim();
    const baseUrl = ((await kvGet('octo-openai-base-url')) || '').trim() || 'https://api.openai.com/v1';
    const model = ((await kvGet('octo-openai-model')) || '').trim() || 'gpt-4o';
    if (!apiKey) throw new Error('OpenAI API key not configured.');
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: mode === 'flash' ? 2048 : 4096 }),
    };
  }
  if (provider === 'atlascloud') {
    const { url, headers, body } = await buildAtlasCloudChatRequest(messages, {
      stream: true,
      maxTokens: mode === 'flash' ? 2048 : 4096,
    });
    return { url, headers, body };
  }
  if (provider === 'claude-api') {
    const apiKey = ((await kvGet('octo-anthropic-api-key')) || '').trim();
    const model = ((await kvGet('octo-anthropic-model')) || '').trim() || 'claude-sonnet-4-20250514';
    if (!apiKey) throw new Error('Anthropic API key not configured.');
    const systemMsg = messages.find(message => message.role === 'system');
    const chatMsgs = messages.filter(message => message.role !== 'system');
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: mode === 'flash' ? 2048 : 4096,
        stream: true,
        ...(systemMsg ? { system: systemMsg.content } : {}),
        messages: chatMsgs.map(message => ({
          role: message.role === 'human' ? 'user' : message.role,
          content: message.content,
        })),
        ...(mode !== 'flash' ? { thinking: { type: 'enabled', budget_tokens: 2048 } } : {}),
      }),
    };
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

async function callAiStream(
  provider: ResponseExecutorProvider,
  messages: { role: string; content: string }[],
  mode: ResponseExecutorMode,
  _workDir: string,
  _hasSession: boolean,
  timeoutSecs: number,
  _ensureCliProvider: (provider: ResponseExecutorProvider) => CliProvider,
  onChunk: (text: string) => void,
  onThinking: (text: string) => void,
  onUsage: (usage: HarnessTokenUsage) => void,
  onDone: () => void | Promise<void>,
  onError: (err: string) => void,
  abortRef: { current: boolean },
): Promise<void> {
  if (isLocalCliProvider(provider)) {
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    try {
      const output = await streamCliPrompt(provider, prompt, _workDir, timeoutSecs, onChunk);
      onUsage(estimateTokenUsage({
        promptText: prompt,
        completionText: output,
        warning: `${provider} does not report provider token usage; estimated from prompt/output text.`,
      }));
      await onDone();
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
    return;
  }

  const streamId = genId();
  const unlisten = await listen<{ type: string; data?: string; error?: string }>(
    `ai-stream-${streamId}`,
    (event) => {
      if (abortRef.current) return;
      const payload = event.payload;
      if (payload.type === 'chunk' && payload.data) {
        parseStreamChunk(provider, payload.data, onChunk, onThinking, onUsage);
      } else if (payload.type === 'done') {
        void Promise.resolve(onDone()).then(() => unlisten());
      } else if (payload.type === 'error') {
        onError(payload.error || 'Unknown error');
        unlisten();
      }
    },
  );

  try {
    const { url, headers, body } = await buildRequest(provider, messages, mode);
    await invoke('http_stream_request', {
      streamId,
      input: { method: 'POST', url, headers, body, timeout_ms: Math.max(5000, Math.min(timeoutSecs * 1000, 600000)) },
    });
  } catch (error) {
    unlisten();
    onError(String(error));
  }
}

async function maybeBuildMemorySummary(
  params: {
    effectiveProvider: CliProvider;
    msgText: string;
    accumulated: string;
    workDir: string;
    executionProfile: WorkflowExecutionProfile;
    activeThreadTitle?: string;
    threadMessages: ResponseExecutorMessage[];
  },
): Promise<string | undefined> {
  const msgCount = params.threadMessages.length;
  if (!(msgCount > 0 && msgCount % 10 === 0)) return undefined;
  try {
    const summaryPrompt = `Summarize the key facts and decisions from this conversation in 2-3 bullet points. Be very concise.\n\nConversation:\nUser: ${params.msgText.slice(0, 200)}\nAssistant: ${params.accumulated.slice(0, 500)}`;
    const summaryResult = await runCliPrompt(
      params.effectiveProvider,
      summaryPrompt,
      params.workDir,
      params.executionProfile.summaryTimeoutSecs,
    );
    if (summaryResult && summaryResult.trim().length > 10) {
      return summaryResult.trim().slice(0, 300);
    }
  } catch {
    /* silent */
  }
  return undefined;
}

async function runProTodoSteps(params: {
  todos: TodoItem[];
  effectiveProvider: CliProvider;
  workDir: string;
  executionProfile: WorkflowExecutionProfile;
  onStepProgress?: (text: string) => void;
}): Promise<Array<{ content: string; artifacts?: Artifact[] }>> {
  const postMessages: Array<{ content: string; artifacts?: Artifact[] }> = [];
  for (let i = 0; i < params.todos.length; i++) {
    const todo = params.todos[i];
    params.onStepProgress?.(`${i + 1}/${params.todos.length}: ${todo.text}`);
    try {
      const stepResult = await runCliPrompt(
        params.effectiveProvider,
        todo.text,
        params.workDir,
        params.executionProfile.directConversationTimeoutSecs,
      );
      postMessages.push({
        content: `**[${i + 1}/${params.todos.length}] ${todo.text}**\n\n${stepResult || '(completed)'}`,
        artifacts: extractArtifacts(stepResult || ''),
      });
    } catch (error) {
      postMessages.push({
        content: `**[${i + 1}/${params.todos.length}] ${todo.text}** — Error: ${error}`,
      });
    }
  }
  return postMessages;
}

export async function executeDirectResponse(
  params: ExecuteDirectResponseParams,
): Promise<DirectResponseResult> {
  const startTime = Date.now();
  const prepareContext = params.prepareContext || prepareDirectResponseContext;
  const loopContext = await beginLearningAgentLoop({
    workDir: params.workDir,
    query: params.msgText,
    threadSummary: params.threadSummary,
    providersOrRegistry: params.providersOrRegistry,
  });
  const mergedSkills = [...loopContext.skills, ...params.skills].filter((skill, index, array) => {
    const key = skill.name.trim().toLowerCase();
    return !!key && array.findIndex((item) => item.name.trim().toLowerCase() === key) === index;
  });
  const projectDocsContext = await loadHarnessProjectDocsContext(params.workDir);
  const runtime = prepareContext({
    mode: params.mode,
    provider: params.provider,
    runtimeUserMsg: params.runtimeUserMsg,
    workDir: params.workDir,
    projectDocsContext,
    memories: [...params.memories, ...loopContext.memories],
    skills: mergedSkills,
    threadMessages: params.threadMessages,
    threadSummary: params.threadSummary,
    executionProfile: params.executionProfile,
    isDirectCodingConversation: params.isDirectCodingConversation,
    responseLanguage: params.responseLanguage,
    forceProviderForMode: params.forceProviderForMode,
    ensureCliProvider: params.ensureCliProvider,
  }, params.middlewareAssembly);

  return new Promise<DirectResponseResult>((resolve, reject) => {
    let accumulated = '';
    let accumulatedThinking = '';
    let tokenUsage: HarnessTokenUsage | undefined;
    const executedTools: ResponseExecutorToolCall[] = [];
    const queuedAutoShellBlocks = new Set<string>();
    const liveToolResults: Array<{ key: string; label: string; text: string }> = [];
    let autoShellChain: Promise<void> = Promise.resolve();

    const renderToolResults = () => liveToolResults
      .map(item => `\n\n**${item.label}** → ${item.text}`)
      .join('');

    const renderStreamingContent = () => {
      const toolResults = renderToolResults();
      const visibleContent = queuedAutoShellBlocks.size > 0
        ? stripExecutableShellBlocks(accumulated)
        : accumulated;
      params.onStreamingContent(visibleContent + (toolResults ? `\n\n---\n${toolResults}` : ''));
    };

    const executeTrackedTool = async (toolCall: { name: string; args: string; label: string }) => {
      const nextTool: ResponseExecutorToolCall = {
        id: genId(),
        name: toolCall.name,
        args: toolCall.args,
        status: 'running',
      };
      executedTools.push(nextTool);
      const resultItem = {
        key: nextTool.id,
        label: toolCall.label,
        text: 'running...',
      };
      liveToolResults.push(resultItem);
      renderStreamingContent();

      const { result, error } = await executeHarnessTool(toolCall.name, toolCall.args, params.workDir, params.executionProfile);
      nextTool.status = error ? 'error' : 'done';
      nextTool.result = result || error;
      resultItem.text = (result || error || '').slice(0, 500) || '(completed)';
      renderStreamingContent();
    };

    const queueClosedShellBlocks = () => {
      if (parseToolCalls(accumulated).length > 0) return;
      for (const command of extractExecutableShellBlocks(accumulated)) {
        if (queuedAutoShellBlocks.has(command)) continue;
        queuedAutoShellBlocks.add(command);
        const index = queuedAutoShellBlocks.size;
        autoShellChain = autoShellChain
          .then(() => executeTrackedTool({
            name: 'bash',
            args: command,
            label: `${params.responseLanguage === 'ko' ? '실행 명령' : 'Shell command'} ${index}: ${summarizeShellCommand(command)}`,
          }))
          .catch((error) => {
            liveToolResults.push({
              key: genId(),
              label: `${params.responseLanguage === 'ko' ? '실행 명령' : 'Shell command'} ${index}: ${summarizeShellCommand(command)}`,
              text: String(error).slice(0, 500),
            });
            renderStreamingContent();
          });
      }
    };

    void callAiStream(
      runtime.effectiveProvider,
      runtime.apiMessages,
      runtime.runtimeMode,
      params.workDir,
      runtime.hasSession,
      params.executionProfile.directConversationTimeoutSecs,
      params.ensureCliProvider,
      (chunk) => {
        accumulated += chunk;
        renderStreamingContent();
        queueClosedShellBlocks();
      },
      (thinking) => {
        accumulatedThinking += thinking;
        params.onStreamingThinking(accumulatedThinking);
      },
      (usage) => {
        tokenUsage = usage;
      },
      async () => {
        await autoShellChain;
        const parsedToolCalls = parseToolCalls(accumulated);
        const shellBlocks = parsedToolCalls.length === 0
          ? extractExecutableShellBlocks(accumulated).filter(command => !queuedAutoShellBlocks.has(command))
          : [];

        if (parsedToolCalls.length > 0 || shellBlocks.length > 0) {
          const requestedTools = [
            ...parsedToolCalls.map(toolCall => ({
              name: toolCall.name,
              args: toolCall.args,
              label: `@tool(${toolCall.name})`,
            })),
            ...shellBlocks.map(command => ({
              name: 'bash',
              args: command,
              label: `${params.responseLanguage === 'ko' ? '실행 명령' : 'Shell command'}: ${summarizeShellCommand(command)}`,
            })),
          ];

          for (const toolCall of requestedTools) {
            await executeTrackedTool(toolCall);
          }
        }

        const askUser = executedTools.find(toolCall => toolCall.name === 'ask_user');
        if (askUser) {
          const finalTokenUsage = tokenUsage || estimateTokenUsage({
            promptText: runtime.apiMessages.map(message => message.content).join('\n\n'),
            completionText: accumulated,
          });
          resolve({
            mainContent: accumulated,
            thinking: accumulatedThinking || undefined,
            toolCalls: executedTools,
            artifacts: [],
            todos: [],
            postMessages: [],
            durationMs: Date.now() - startTime,
            clarificationOnly: true,
            tokenUsage: finalTokenUsage,
          });
          return;
        }

        const savedFiles = await autoSaveFiles(accumulated, params.workDir);
        const saveNotice = savedFiles.length > 0
          ? `\n\n**Saved** ${savedFiles.length} files: ${savedFiles.map(file => '`' + file + '`').join(', ')}`
          : '';
        const toolResults = renderToolResults();
        const visibleMainContent = queuedAutoShellBlocks.size > 0
          ? stripExecutableShellBlocks(accumulated)
          : accumulated;
        const fullContent = visibleMainContent + (toolResults ? '\n\n---\n' + toolResults : '') + saveNotice;
        const artifacts = extractArtifacts(accumulated + toolResults);
        const todos = runtime.runtimeMode === 'pro' ? extractTodos(accumulated) : [];
        const postMessages = runtime.runtimeMode === 'pro' && todos.length >= 2
          ? await runProTodoSteps({
              todos,
              effectiveProvider: runtime.effectiveProvider,
              workDir: params.workDir,
              executionProfile: params.executionProfile,
              onStepProgress: params.onStepProgress,
            })
          : [];

        const memorySummary = await maybeBuildMemorySummary({
          effectiveProvider: runtime.effectiveProvider,
          msgText: params.msgText,
          accumulated,
          workDir: params.workDir,
          executionProfile: params.executionProfile,
          activeThreadTitle: params.activeThreadTitle,
          threadMessages: params.threadMessages,
        });

        const shouldRunLearningReview = (
          accumulated.trim().length >= 280
          || parsedToolCalls.length > 0
          || savedFiles.length > 0
          || todos.length > 0
        );
        const learningReview = shouldRunLearningReview
          ? await runBackgroundLearningReview({
              provider: runtime.effectiveProvider,
              workDir: params.workDir,
              threadTitle: params.activeThreadTitle,
              userMessage: params.msgText,
              assistantContent: fullContent,
              threadMessages: params.threadMessages,
              timeoutSecs: params.executionProfile.summaryTimeoutSecs,
            })
          : undefined;

        await finalizeLearningAgentLoop({
          context: loopContext,
          userMessage: params.msgText,
          assistantMessage: fullContent,
          review: learningReview,
        });

        const finalTokenUsage = tokenUsage || estimateTokenUsage({
          promptText: runtime.apiMessages.map(message => message.content).join('\n\n'),
          completionText: fullContent,
        });

        resolve({
          mainContent: fullContent,
          thinking: accumulatedThinking || undefined,
          toolCalls: executedTools.length > 0 ? executedTools : undefined,
          artifacts,
          todos,
          postMessages,
          durationMs: Date.now() - startTime,
          followupSource: accumulated,
          followupProvider: runtime.effectiveProvider,
          memorySummary,
          learningReview,
          tokenUsage: finalTokenUsage,
        });
      },
      (error) => {
        void abortLearningAgentLoop(loopContext);
        if (accumulated) {
          const finalTokenUsage = tokenUsage || estimateTokenUsage({
            promptText: runtime.apiMessages.map(message => message.content).join('\n\n'),
            completionText: accumulated,
          });
          resolve({
            mainContent: accumulated + '\n\n[Error: ' + error + ']',
            artifacts: [],
            todos: [],
            postMessages: [],
            durationMs: Date.now() - startTime,
            thinking: accumulatedThinking || undefined,
            tokenUsage: finalTokenUsage,
          });
          return;
        }
        reject(new Error(error));
      },
      params.abortRef,
    );
  });
}
