import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { genId } from '../components/harness-utils';
import { getWorkflowExecutionProfile, type WorkflowExecutionProfile, type WorkflowProvider } from './workflow';
import {
  ATLASCLOUD_PROVIDER,
  streamAtlasCloudMessages,
} from './atlasCloudRuntime';
import { OLLAMA_PROVIDER, streamOllamaMessages } from './ollamaRuntime';

export type CliProvider = WorkflowProvider;

export interface DecomposedTask {
  description: string;
  provider: CliProvider;
  prompt: string;
}

export interface RuntimeSubTask {
  id: string;
  description: string;
  provider: CliProvider;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
  startedAt?: number;
  durationMs?: number;
}

const PROVIDER_ROLES: Record<CliProvider, string> = {
  atlascloud: 'API-based coding, reasoning, research, planning, and review',
  openai: 'OpenAI-compatible API',
  'claude-api': 'Anthropic API',
  ollama: 'local Ollama model',
  'claude-cli': 'local Claude Code CLI',
  'codex-cli': 'local Codex CLI',
  'kimi-cli': 'local Kimi CLI',
  'gemini-cli': 'local Gemini CLI',
  'qwen-cli': 'local Qwen Code CLI',
};

export function isLocalCliProvider(provider: CliProvider): boolean {
  return (
    provider === 'claude-cli'
    || provider === 'codex-cli'
    || provider === 'kimi-cli'
    || provider === 'gemini-cli'
    || provider === 'qwen-cli'
  );
}

async function streamProviderMessages(
  provider: CliProvider,
  messages: Array<{ role: string; content: string }>,
  options: {
    timeoutSecs?: number;
    maxTokens?: number;
    model?: string;
    onChunk?: (text: string) => void;
    onThinking?: (text: string) => void;
  } = {},
): Promise<string> {
  // workflow·셀프임프로빙 리뷰도 provider를 따른다. ollama면 로컬 Ollama로,
  // 그 외(CLI 포함)는 Atlas Cloud로 폴백.
  if (provider === OLLAMA_PROVIDER) {
    return streamOllamaMessages(messages, options);
  }
  if (isLocalCliProvider(provider)) {
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    return streamCliPrompt(provider, prompt, '', options.timeoutSecs || 300, options.onChunk || (() => {}), options.model);
  }
  return streamAtlasCloudMessages(messages, options);
}

function normalizeWorkDirPath(workDir: string): string {
  return String(workDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

export async function createHarnessTmpFile(workDir: string, prefix: string, content: string): Promise<string> {
  const baseDir = `${normalizeWorkDirPath(workDir)}/.octo-tmp`;
  await invoke('create_directory', { path: baseDir }).catch(() => {});
  const filePath = `${baseDir}/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
  await invoke('write_file', { path: filePath, content });
  return filePath;
}

function shellQuote(value: string): string {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function cliBackend(provider: CliProvider): 'claude' | 'codex' | 'kimi' | 'gemini' | 'qwen' {
  if (provider === 'codex-cli') return 'codex';
  if (provider === 'kimi-cli') return 'kimi';
  if (provider === 'gemini-cli') return 'gemini';
  if (provider === 'qwen-cli') return 'qwen';
  return 'claude';
}

function buildCliCommand(provider: CliProvider, tmpPath: string, model?: string): string {
  const quotedPath = shellQuote(tmpPath);
  const modelArg = model?.trim();
  switch (cliBackend(provider)) {
    case 'claude':
      return `cat ${quotedPath} | claude -p --output-format text${modelArg ? ` --model ${shellQuote(modelArg)}` : ''}`;
    case 'codex':
      return `cat ${quotedPath} | codex exec --skip-git-repo-check${modelArg ? ` --model ${shellQuote(modelArg)}` : ''} -`;
    case 'kimi':
      return `kimi --quiet${modelArg ? ` --model ${shellQuote(modelArg)}` : ''} -p "$(cat ${quotedPath})"`;
    case 'gemini':
      return `gemini --output-format text${modelArg ? ` --model ${shellQuote(modelArg)}` : ''} -p "$(cat ${quotedPath})"`;
    case 'qwen':
      return `qwen --output-format text${modelArg ? ` --model ${shellQuote(modelArg)}` : ''} -p "$(cat ${quotedPath})"`;
  }
}

export function buildDecomposePrompt(enabledProviders: CliProvider[]): string {
  const provList = enabledProviders.map(provider => `"${provider}"`).join('|') || `"${ATLASCLOUD_PROVIDER}"`;
  const roles = enabledProviders.map(provider => `- ${provider}: ${PROVIDER_ROLES[provider]}`).join('\n');
  return `You are a task decomposer. Given a user request, break it into 1-3 independent sub-tasks that can run in parallel.
Output ONLY a JSON array. Each item: {"description": "task description", "provider": ${provList}, "prompt": "detailed prompt for the sub-agent"}
Available provider:
${roles || `- ${ATLASCLOUD_PROVIDER}: ${PROVIDER_ROLES.atlascloud}`}
Reply with ONLY the JSON array, no markdown fences, no explanation.`;
}

export async function buildCliCmdWithTmpFile(
  provider: CliProvider,
  prompt: string,
  workDir: string,
  model?: string,
): Promise<{ command: string; tmpPath: string }> {
  if (!isLocalCliProvider(provider)) {
    throw new Error(`${provider} is not a local CLI provider.`);
  }
  const tmpPath = await createHarnessTmpFile(workDir || '/tmp', `harness-${cliBackend(provider)}`, prompt);
  return { command: buildCliCommand(provider, tmpPath, model), tmpPath };
}

export async function runCliPrompt(
  provider: CliProvider,
  prompt: string,
  workDir: string,
  timeoutSecs = 300,
  model?: string,
): Promise<string> {
  if (isLocalCliProvider(provider)) {
    const { command, tmpPath } = await buildCliCmdWithTmpFile(provider, prompt, workDir, model);
    try {
      const result = await invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs });
      if (!result.trim()) throw new Error(`${provider} returned empty response.`);
      return result.trim();
    } finally {
      await invoke('run_cli_oneshot', { command: `rm -f ${shellQuote(tmpPath)}`, timeoutSecs: 5 }).catch(() => {});
    }
  }

  const result = await streamProviderMessages(
    provider,
    [{ role: 'user', content: prompt }],
    { timeoutSecs, model },
  );
  if (!result.trim()) throw new Error(`${provider} returned empty response.`);
  return result;
}

export async function streamCliPrompt(
  provider: CliProvider,
  prompt: string,
  workDir: string,
  timeoutSecs: number,
  onChunk: (text: string) => void,
  model?: string,
): Promise<string> {
  if (isLocalCliProvider(provider)) {
    const { command, tmpPath } = await buildCliCmdWithTmpFile(provider, prompt, workDir, model);
    const streamId = genId();
    let fullOutput = '';
    return new Promise<string>((resolve, reject) => {
      let unlistenFn: (() => void) | null = null;
      listen<{ type: string; data?: string; error?: string }>(`cli-stream-${streamId}`, (event) => {
        const payload = event.payload;
        if (payload.type === 'chunk' && payload.data) {
          fullOutput += payload.data;
          onChunk(payload.data);
        } else if (payload.type === 'done') {
          unlistenFn?.();
          void invoke('run_cli_oneshot', { command: `rm -f ${shellQuote(tmpPath)}`, timeoutSecs: 5 }).catch(() => {});
          const trimmed = fullOutput.trim();
          if (!trimmed) reject(new Error(`${provider} returned empty response.`));
          else resolve(trimmed);
        } else if (payload.type === 'error') {
          unlistenFn?.();
          void invoke('run_cli_oneshot', { command: `rm -f ${shellQuote(tmpPath)}`, timeoutSecs: 5 }).catch(() => {});
          reject(new Error(payload.error || `${provider} stream error`));
        }
      }).then((fn) => {
        unlistenFn = fn;
        invoke('stream_cli_command', { streamId, command, workDir, timeoutSecs }).catch((error) => {
          unlistenFn?.();
          void invoke('run_cli_oneshot', { command: `rm -f ${shellQuote(tmpPath)}`, timeoutSecs: 5 }).catch(() => {});
          reject(error);
        });
      }).catch(reject);
    });
  }

  const result = await streamProviderMessages(
    provider,
    [{ role: 'user', content: prompt }],
    { timeoutSecs, onChunk, model },
  );
  if (!result.trim()) throw new Error(`${provider} returned empty response.`);
  return result;
}

export async function decomposeTask(
  userMsg: string,
  provider: CliProvider,
  workDir: string,
  enabledProviders: CliProvider[],
  timeoutSecs = 60,
): Promise<DecomposedTask[]> {
  const providers: CliProvider[] = enabledProviders.length > 0 ? enabledProviders : [ATLASCLOUD_PROVIDER];
  const fullPrompt = `${buildDecomposePrompt(providers)}\n\nUser request: ${userMsg}`;

  try {
    const result = await runCliPrompt(provider, fullPrompt, workDir, timeoutSecs);
    const match = result.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Array<{ description?: string; provider?: string; prompt?: string }>;
      return parsed.slice(0, 3).map(task => ({
        description: task.description || 'Sub-task',
        provider: (providers.includes(task.provider as CliProvider) ? task.provider : providers[0]) as CliProvider,
        prompt: task.prompt || task.description || userMsg,
      }));
    }
  } catch {
    // fall through
  }
  return [];
}

export async function runSubAgent(
  task: DecomposedTask,
  workDir: string,
  timeoutSecs = 300,
): Promise<string> {
  try {
    const result = await runCliPrompt(task.provider, task.prompt, workDir, timeoutSecs);
    return result && result.trim() ? result : '(empty response)';
  } catch {
    return '(failed)';
  }
}

export async function runSubAgents(
  userMsg: string,
  provider: CliProvider,
  workDir: string,
  enabledProviders: CliProvider[],
  onUpdate: (tasks: RuntimeSubTask[]) => void,
  profile: WorkflowExecutionProfile = getWorkflowExecutionProfile(),
): Promise<{ tasks: RuntimeSubTask[]; summary: string }> {
  const decomposed = await decomposeTask(userMsg, provider, workDir, enabledProviders, profile.decomposeTimeoutSecs);
  if (decomposed.length === 0) {
    return { tasks: [], summary: '' };
  }

  const subTasks: RuntimeSubTask[] = decomposed.map(task => ({
    id: genId(),
    description: task.description,
    provider: task.provider,
    status: 'pending',
  }));
  onUpdate([...subTasks]);

  await Promise.all(decomposed.map(async (task, index) => {
    subTasks[index].status = 'running';
    subTasks[index].startedAt = Date.now();
    onUpdate([...subTasks]);
    try {
      const result = await runSubAgent(task, workDir, profile.subAgentTimeoutSecs);
      subTasks[index].status = 'completed';
      subTasks[index].result = result;
      subTasks[index].durationMs = Date.now() - (subTasks[index].startedAt || Date.now());
    } catch (err) {
      subTasks[index].status = 'failed';
      subTasks[index].error = String(err);
      subTasks[index].durationMs = Date.now() - (subTasks[index].startedAt || Date.now());
    }
    onUpdate([...subTasks]);
  }));

  const summary = subTasks.map((task, index) =>
    `### Sub-task ${index + 1}: ${task.description}\n**Provider:** ${task.provider} | **Status:** ${task.status}${task.durationMs ? ` | ${(task.durationMs / 1000).toFixed(1)}s` : ''}\n\n${task.result || task.error || ''}`
  ).join('\n\n---\n\n');

  return { tasks: subTasks, summary };
}
