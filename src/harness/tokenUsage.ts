export interface HarnessTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: 'provider' | 'estimated';
  verified: boolean;
  warning?: string;
}

function positiveNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : undefined;
}

export function normalizeProviderTokenUsage(value: {
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
}): HarnessTokenUsage | null {
  const promptTokens = positiveNumber(value.promptTokens);
  const completionTokens = positiveNumber(value.completionTokens);
  const totalTokens = positiveNumber(value.totalTokens) ?? (
    promptTokens != null || completionTokens != null
      ? (promptTokens || 0) + (completionTokens || 0)
      : undefined
  );
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    source: 'provider',
    verified: true,
  };
}

export function estimateTokenUsage(params: {
  promptText: string;
  completionText: string;
  warning?: string;
}): HarnessTokenUsage {
  const estimate = (text: string) => Math.max(1, Math.ceil(String(text || '').length / 3.5));
  const promptTokens = estimate(params.promptText);
  const completionTokens = estimate(params.completionText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: 'estimated',
    verified: false,
    warning: params.warning || 'Provider did not return token usage; estimated from text length.',
  };
}

export function formatTokenUsage(usage?: HarnessTokenUsage): string {
  if (!usage) return '';
  const total = usage.totalTokens != null ? `${usage.totalTokens}` : '?';
  const prompt = usage.promptTokens != null ? `${usage.promptTokens}` : '?';
  const completion = usage.completionTokens != null ? `${usage.completionTokens}` : '?';
  const suffix = usage.verified ? 'verified' : 'estimated';
  return `tokens ${total} (${prompt}/${completion}, ${suffix})`;
}
