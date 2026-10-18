import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { genId } from '../components/harness-utils';
import { normalizeAtlasCloudMessages, parseAtlasCloudStreamChunk } from './atlasCloudRuntime';

// Ollama 모델 목록 헬퍼 + 스트리밍.
//
// 실제 채팅 스트리밍은 responseExecutor(provider === 'ollama', /api/chat)가 이미
// 담당한다. 이 모듈은 모델 선택 UI를 위해 /api/tags 로 설치된 모델 목록만 제공하며,
// KV 키는 responseExecutor와 동일하게 'octo-ollama-url' / 'octo-ollama-model'을 쓴다.

export const OLLAMA_PROVIDER = 'ollama' as const;
// 127.0.0.1 고정: 앱 백엔드(reqwest)가 localhost를 IPv6(::1)로 풀어 Ollama(IPv4) 연결 실패.
export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
export const OLLAMA_URL_KV_KEY = 'octo-ollama-url';
export const OLLAMA_MODEL_KV_KEY = 'octo-ollama-model';
export const OLLAMA_DEFAULT_MODEL = 'llama3.2';

// responseExecutor는 베이스 URL을 그대로 /api/chat 에 붙인다. tags API도 루트에 있으므로
// 후행 슬래시와 (혹시 붙은) /v1 만 정리한다.
export function normalizeOllamaBaseUrl(baseUrl: string): string {
  return (baseUrl || OLLAMA_DEFAULT_URL).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function ollamaTagsUrl(baseUrl: string): string {
  return `${normalizeOllamaBaseUrl(baseUrl)}/api/tags`;
}

// Ollama /api/tags → { models: [{ name: "llama3.2:3b", ... }] }
export function parseOllamaModels(json: unknown): string[] {
  if (!json || typeof json !== 'object') return [];
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const names = models
    .map((entry) => (entry && typeof entry === 'object' ? String((entry as { name?: unknown }).name || '') : ''))
    .map((name) => name.trim())
    .filter(Boolean);
  return Array.from(new Set(names));
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

// 설치된 Ollama 모델 이름 목록. Ollama가 꺼져 있으면 빈 배열.
export async function listOllamaModels(baseUrl?: string): Promise<string[]> {
  const resolved = (baseUrl || (await kvGet(OLLAMA_URL_KV_KEY)) || '').trim() || OLLAMA_DEFAULT_URL;
  try {
    const res = await invoke<{ status: number; body: string }>('http_request', {
      input: { method: 'GET', url: ollamaTagsUrl(resolved), headers: {}, timeout_ms: 5000 },
    });
    return parseOllamaModels(JSON.parse(res.body));
  } catch {
    return [];
  }
}

export interface OllamaStreamOptions {
  timeoutSecs?: number;
  maxTokens?: number;
  model?: string;
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
}

// Ollama OpenAI 호환 엔드포인트(/v1/chat/completions)로 스트리밍. atlasCloud와 동일
// SSE 파서를 재사용하고, baseUrl/model은 responseExecutor와 같은 KV에서 읽는다.
export async function streamOllamaMessages(
  messages: Array<{ role: string; content: string }>,
  options: OllamaStreamOptions = {},
): Promise<string> {
  const streamId = genId();
  const baseUrlRaw = ((await kvGet(OLLAMA_URL_KV_KEY)) || '').trim() || OLLAMA_DEFAULT_URL;
  const model = (options.model || (await kvGet(OLLAMA_MODEL_KV_KEY)) || '').trim() || OLLAMA_DEFAULT_MODEL;
  const url = `${normalizeOllamaBaseUrl(baseUrlRaw)}/v1/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: normalizeAtlasCloudMessages(messages),
    stream: true,
    max_tokens: options.maxTokens ?? 4096,
  });

  return new Promise<string>((resolve, reject) => {
    let fullOutput = '';
    let unlistenFn: (() => void) | null = null;
    listen<{ type: string; data?: string; error?: string }>(`ai-stream-${streamId}`, (event) => {
      const payload = event.payload;
      if (payload.type === 'chunk' && payload.data) {
        parseAtlasCloudStreamChunk(payload.data, (text) => {
          fullOutput += text;
          options.onChunk?.(text);
        }, options.onThinking);
      } else if (payload.type === 'done') {
        unlistenFn?.();
        resolve(fullOutput.trim());
      } else if (payload.type === 'error') {
        unlistenFn?.();
        reject(new Error(payload.error || 'Ollama stream error'));
      }
    })
      .then((fn) => {
        unlistenFn = fn;
        invoke('http_stream_request', {
          streamId,
          input: {
            method: 'POST',
            url,
            headers: { 'Content-Type': 'application/json' },
            body,
            timeout_ms: Math.max(5000, Math.min((options.timeoutSecs ?? 300) * 1000, 600000)),
          },
        }).catch((error) => {
          unlistenFn?.();
          reject(error);
        });
      })
      .catch(reject);
  });
}
