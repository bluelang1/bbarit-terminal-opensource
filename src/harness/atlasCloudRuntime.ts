import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { genId } from '../components/harness-utils';

export const ATLASCLOUD_PROVIDER = 'atlascloud' as const;
export const ATLASCLOUD_DEFAULT_BASE_URL = 'https://api.atlascloud.ai/v1';
export const ATLASCLOUD_DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-flash';
const ATLASCLOUD_LEGACY_DEFAULT_MODELS = new Set(['deepseek-v3']);

export const ATLASCLOUD_KV_KEYS = {
  apiKey: 'octo-atlascloud-api-key',
  baseUrl: 'octo-atlascloud-base-url',
  model: 'octo-atlascloud-model',
} as const;

export interface AtlasCloudConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AtlasCloudStreamOptions {
  timeoutSecs?: number;
  maxTokens?: number;
  model?: string;
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
}

export interface AtlasCloudCodingSmokeTestResult {
  ok: boolean;
  elapsedMs: number;
  model: string;
  baseUrl: string;
  output: string;
  issues: string[];
}

export interface AtlasCloudKoriniModelSelection {
  role: 'kimi' | 'deepseek4' | 'qwenCode';
  label: string;
  preferred: string;
  resolved: string;
  status: 'verified' | 'preferred-missing' | 'unverified';
  reason: string;
}

export interface AtlasCloudKoriniModelCheck {
  ok: boolean;
  checkedAt: string;
  baseUrl: string;
  availableCount: number;
  selections: AtlasCloudKoriniModelSelection[];
  issues: string[];
}

async function kvGet(key: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('kv_get', { key });
    if (value != null) return value;
  } catch {
    // DB can be briefly unavailable during startup; keep Harness usable via localStorage fallback.
  }
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl || ATLASCLOUD_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function normalizeRole(role: string): string {
  if (role === 'human') return 'user';
  if (role === 'tool') return 'user';
  if (role === 'system' || role === 'assistant' || role === 'user') return role;
  return 'user';
}

export function normalizeAtlasCloudModelPreference(model: string | null | undefined): string {
  const normalized = (model || '').trim();
  if (!normalized || ATLASCLOUD_LEGACY_DEFAULT_MODELS.has(normalized)) {
    return ATLASCLOUD_DEFAULT_MODEL;
  }
  return normalized;
}

export async function getAtlasCloudConfig(): Promise<AtlasCloudConfig> {
  const apiKey = ((await kvGet(ATLASCLOUD_KV_KEYS.apiKey)) || '').trim();
  const baseUrl = normalizeBaseUrl(((await kvGet(ATLASCLOUD_KV_KEYS.baseUrl)) || '').trim() || ATLASCLOUD_DEFAULT_BASE_URL);
  const model = normalizeAtlasCloudModelPreference(await kvGet(ATLASCLOUD_KV_KEYS.model));
  return { apiKey, baseUrl, model };
}

function parseAtlasModelIds(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const root = parsed as {
    data?: Array<{ id?: string; name?: string }>;
    models?: Array<{ id?: string; name?: string } | string>;
  };
  const raw = Array.isArray(root.data)
    ? root.data.map(item => item.id || item.name)
    : Array.isArray(root.models)
      ? root.models.map(item => typeof item === 'string' ? item : (item.id || item.name))
      : [];
  return Array.from(new Set(raw.map(item => String(item || '').trim()).filter(Boolean))).sort();
}

function scoreAtlasModelId(id: string, role: AtlasCloudKoriniModelSelection['role']): number {
  const lower = id.toLowerCase();
  let score = 0;
  if (role === 'kimi') {
    if (!/(kimi|moonshot)/.test(lower)) return -1;
    score += 100;
    if (/k2\.?6|k2-?6/.test(lower)) score += 60;
    if (/k2/.test(lower)) score += 35;
  } else if (role === 'deepseek4') {
    if (!/deepseek/.test(lower)) return -1;
    score += 100;
    if (/v4|deepseek-?4/.test(lower)) score += 80;
    if (/flash/.test(lower)) score += 20;
  } else {
    if (!/qwen/.test(lower) || !/(coder|code)/.test(lower)) return -1;
    score += 100;
    if (/next|latest/.test(lower)) score += 45;
    if (/coder/.test(lower)) score += 25;
  }
  if (/latest/.test(lower)) score += 50;
  if (/preview|beta|experimental/.test(lower)) score -= 5;
  const numbers = lower.match(/\d+(?:\.\d+)?/g) || [];
  score += numbers.reduce((sum, value, index) => sum + Number(value) / (index + 1), 0);
  return score;
}

function chooseAtlasModel(
  ids: string[],
  role: AtlasCloudKoriniModelSelection['role'],
  label: string,
  preferred: string,
): AtlasCloudKoriniModelSelection {
  if (ids.length === 0) {
    return {
      role,
      label,
      preferred,
      resolved: preferred,
      status: 'unverified',
      reason: 'Atlas 모델 목록을 가져오지 못해 저장된 기본 모델로 진행합니다.',
    };
  }
  const preferredFound = ids.includes(preferred);
  const best = ids
    .map(id => ({ id, score: scoreAtlasModelId(id, role) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))[0]?.id;
  const resolved = best || preferred;
  return {
    role,
    label,
    preferred,
    resolved,
    status: preferredFound ? 'verified' : 'preferred-missing',
    reason: preferredFound
      ? '기본 모델이 Atlas 모델 목록에서 확인되었습니다.'
      : best
        ? `기본 모델은 목록에서 못 찾았고, 같은 계열에서 ${best}를 찾았습니다.`
        : '같은 계열 모델을 찾지 못해 저장된 기본 모델로 진행합니다.',
  };
}

export async function listAtlasCloudModels(): Promise<string[]> {
  const config = await getAtlasCloudConfig();
  if (!config.apiKey) {
    throw new Error('Atlas Cloud API key is not configured. Open Korini Mode settings and enter your Atlas Cloud API key.');
  }
  const res = await invoke<{ status: number; body: string }>('http_request', {
    input: {
      method: 'GET',
      url: `${config.baseUrl}/models`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout_ms: 15000,
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Atlas model list failed (${res.status}).`);
  }
  return parseAtlasModelIds(res.body);
}

export async function checkAtlasCloudKoriniModels(): Promise<AtlasCloudKoriniModelCheck> {
  const config = await getAtlasCloudConfig();
  const ids = await listAtlasCloudModels();
  const selections = [
    chooseAtlasModel(ids, 'kimi', 'Kimi 이해 담당', 'moonshotai/kimi-k2.6'),
    chooseAtlasModel(ids, 'deepseek4', 'DeepSeek 4 계획/검토 담당', 'deepseek-ai/deepseek-v4-flash'),
    chooseAtlasModel(ids, 'qwenCode', 'Qwen 코드 구현 담당', 'qwen/qwen3-coder-next'),
  ];
  const issues = selections
    .filter(selection => selection.status !== 'verified')
    .map(selection => `${selection.label}: ${selection.reason}`);
  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    availableCount: ids.length,
    selections,
    issues,
  };
}

export function modelFromKoriniCheck(
  check: AtlasCloudKoriniModelCheck | null | undefined,
  role: AtlasCloudKoriniModelSelection['role'],
  fallback: string,
): string {
  return check?.selections.find(selection => selection.role === role)?.resolved || fallback;
}

export function formatKoriniModelCheck(check: AtlasCloudKoriniModelCheck): string {
  return [
    `시작 전 Atlas 최신 모델 확인: ${check.ok ? '정상' : '확인 필요'}`,
    `확인 시각: ${check.checkedAt}`,
    `Atlas 주소: ${check.baseUrl}`,
    `모델 목록 수: ${check.availableCount}`,
    ...check.selections.map(selection => (
      `- ${selection.label}: ${selection.resolved} (${selection.status}) - ${selection.reason}`
    )),
    ...(check.issues.length ? ['주의:', ...check.issues.map(issue => `- ${issue}`)] : []),
  ].join('\n');
}

export function normalizeAtlasCloudMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  return messages
    .map(message => ({
      role: normalizeRole(message.role),
      content: String(message.content || ''),
    }))
    .filter(message => message.content.trim());
}

export async function buildAtlasCloudChatRequest(
  messages: Array<{ role: string; content: string }>,
  options: { stream?: boolean; maxTokens?: number; model?: string } = {},
): Promise<{ url: string; headers: Record<string, string>; body: string; config: AtlasCloudConfig }> {
  const config = await getAtlasCloudConfig();
  if (!config.apiKey) {
    throw new Error('Atlas Cloud API key is not configured. Open Harness settings and enter your Atlas Cloud API key.');
  }
  const model = normalizeAtlasCloudModelPreference(options.model || config.model);
  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: normalizeAtlasCloudMessages(messages),
      stream: options.stream ?? true,
      ...((options.stream ?? true) ? { stream_options: { include_usage: true } } : {}),
      max_tokens: options.maxTokens ?? 4096,
    }),
    config: { ...config, model },
  };
}

export function parseAtlasCloudStreamChunk(
  rawData: string,
  onChunk: (text: string) => void,
  onThinking?: (text: string) => void,
): void {
  const lines = rawData.split('\n').filter(Boolean);
  for (const line of lines) {
    const stripped = line.startsWith('data: ') ? line.slice(6) : line;
    if (stripped.trim() === '[DONE]') continue;
    try {
      const obj = JSON.parse(stripped);
      const delta = obj.choices?.[0]?.delta || {};
      const content = delta.content || obj.choices?.[0]?.message?.content;
      const thinking = delta.reasoning_content || delta.reasoning || delta.thinking;
      if (content) onChunk(String(content));
      if (thinking) onThinking?.(String(thinking));
    } catch {
      // Streaming chunks can arrive split across packets; incomplete lines are ignored like existing SSE handlers.
    }
  }
}

export async function streamAtlasCloudMessages(
  messages: Array<{ role: string; content: string }>,
  options: AtlasCloudStreamOptions = {},
): Promise<string> {
  const streamId = genId();
  const { url, headers, body } = await buildAtlasCloudChatRequest(messages, {
    stream: true,
    maxTokens: options.maxTokens,
    model: options.model,
  });

  return new Promise<string>((resolve, reject) => {
    let fullOutput = '';
    let unlistenFn: (() => void) | null = null;

    listen<{ type: string; data?: string; error?: string }>(
      `ai-stream-${streamId}`,
      (event) => {
        const payload = event.payload;
        if (payload.type === 'chunk' && payload.data) {
          parseAtlasCloudStreamChunk(
            payload.data,
            (text) => {
              fullOutput += text;
              options.onChunk?.(text);
            },
            options.onThinking,
          );
        } else if (payload.type === 'done') {
          unlistenFn?.();
          resolve(fullOutput.trim());
        } else if (payload.type === 'error') {
          unlistenFn?.();
          reject(new Error(payload.error || 'Atlas Cloud stream error'));
        }
      },
    ).then((fn) => {
      unlistenFn = fn;
      invoke('http_stream_request', {
        streamId,
        input: {
          method: 'POST',
          url,
          headers,
          body,
          timeout_ms: Math.max(5000, Math.min((options.timeoutSecs ?? 300) * 1000, 600000)),
        },
      }).catch((error) => {
        unlistenFn?.();
        reject(error);
      });
    }).catch(reject);
  });
}

export async function runAtlasCloudPrompt(
  prompt: string,
  timeoutSecs = 300,
  options: Pick<AtlasCloudStreamOptions, 'model'> = {},
): Promise<string> {
  return streamAtlasCloudMessages(
    [{ role: 'user', content: prompt }],
    { timeoutSecs, model: options.model },
  );
}

export async function runAtlasCloudCodingSmokeTest(
  onChunk?: (text: string) => void,
): Promise<AtlasCloudCodingSmokeTestResult> {
  const config = await getAtlasCloudConfig();
  if (!config.apiKey) {
    throw new Error('Atlas Cloud API key is not configured. Open Harness settings and enter your Atlas Cloud API key.');
  }

  const startedAt = Date.now();
  const output = await streamAtlasCloudMessages(
    [
      {
        role: 'system',
        content: [
          'You are a coding smoke-test runner.',
          'Return only a unified diff patch.',
          'Do not include prose, markdown fences, or explanations.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          'Virtual file: virtual/math.ts',
          '',
          'Current code:',
          'export function clamp(value: number, min: number, max: number): number {',
          '  if (value < min) return max;',
          '  if (value > max) return min;',
          '  return value;',
          '}',
          '',
          'Task:',
          'Fix the swapped boundary returns. The correct behavior is:',
          '- values below min return min',
          '- values above max return max',
          '',
          'Return a minimal unified diff for virtual/math.ts.',
        ].join('\n'),
      },
    ],
    {
      timeoutSecs: 90,
      maxTokens: 1400,
      onChunk,
    },
  );

  const plain = output.replace(/```(?:diff|patch)?/gi, '').replace(/```/g, '');
  const issues: string[] = [];
  if (!/(diff --git|---\s+a\/virtual\/math\.ts|---\s+virtual\/math\.ts)/i.test(plain)) {
    issues.push('diff header missing');
  }
  if (!/@@/.test(plain)) {
    issues.push('diff hunk missing');
  }
  if (!/return\s+min\s*;/i.test(plain)) {
    issues.push('lower-bound fix missing');
  }
  if (!/return\s+max\s*;/i.test(plain)) {
    issues.push('upper-bound fix missing');
  }

  return {
    ok: issues.length === 0,
    elapsedMs: Date.now() - startedAt,
    model: config.model,
    baseUrl: config.baseUrl,
    output,
    issues,
  };
}
