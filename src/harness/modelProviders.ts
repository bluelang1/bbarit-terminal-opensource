import {
  ATLASCLOUD_DEFAULT_BASE_URL,
  ATLASCLOUD_DEFAULT_MODEL,
  ATLASCLOUD_KV_KEYS,
  ATLASCLOUD_PROVIDER,
} from './atlasCloudRuntime';
import {
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_URL,
  OLLAMA_MODEL_KV_KEY,
  OLLAMA_PROVIDER,
  OLLAMA_URL_KV_KEY,
} from './ollamaRuntime';
import type { AiProvider } from './panelTypes';

export type HarnessModelProviderProtocol = 'openai-compatible' | 'ollama';

export interface HarnessModelProviderOption {
  id: AiProvider;
  label: string;
  protocol: HarnessModelProviderProtocol;
  defaultBaseUrl: string;
  defaultModel: string;
  baseUrlKvKey?: string;
  modelKvKey?: string;
  apiKeyKvKey?: string;
  local?: boolean;
}

export const HARNESS_MODEL_PROVIDERS: Record<typeof ATLASCLOUD_PROVIDER | typeof OLLAMA_PROVIDER, HarnessModelProviderOption> = {
  [ATLASCLOUD_PROVIDER]: {
    id: ATLASCLOUD_PROVIDER,
    label: '클라우드 자동 작업',
    protocol: 'openai-compatible',
    defaultBaseUrl: ATLASCLOUD_DEFAULT_BASE_URL,
    defaultModel: ATLASCLOUD_DEFAULT_MODEL,
    baseUrlKvKey: ATLASCLOUD_KV_KEYS.baseUrl,
    modelKvKey: ATLASCLOUD_KV_KEYS.model,
    apiKeyKvKey: ATLASCLOUD_KV_KEYS.apiKey,
  },
  [OLLAMA_PROVIDER]: {
    id: OLLAMA_PROVIDER,
    label: '내 Ollama',
    protocol: 'ollama',
    defaultBaseUrl: OLLAMA_DEFAULT_URL,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    baseUrlKvKey: OLLAMA_URL_KV_KEY,
    modelKvKey: OLLAMA_MODEL_KV_KEY,
    local: true,
  },
};

export const HARNESS_PROVIDER_OPTIONS: { id: AiProvider; label: string }[] = Object.values(HARNESS_MODEL_PROVIDERS)
  .map(({ id, label }) => ({ id, label }))
  .concat([
    { id: 'claude-cli', label: 'Claude CLI' },
    { id: 'codex-cli', label: 'Codex CLI' },
    { id: 'kimi-cli', label: 'Kimi CLI' },
    { id: 'gemini-cli', label: 'Gemini CLI' },
    { id: 'qwen-cli', label: 'Qwen CLI' },
  ]);

export function getHarnessModelProvider(provider: AiProvider): HarnessModelProviderOption {
  if (provider === OLLAMA_PROVIDER) return HARNESS_MODEL_PROVIDERS[OLLAMA_PROVIDER];
  return HARNESS_MODEL_PROVIDERS[ATLASCLOUD_PROVIDER];
}

export function getHarnessProviderLabel(provider: AiProvider): string {
  return getHarnessModelProvider(provider).label;
}
