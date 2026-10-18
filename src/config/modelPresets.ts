export interface ModelOption {
  value: string;       // '' = CLI default
  label: string;
  cliType: 'claude' | 'codex' | 'cursor' | 'kimi' | 'gemini' | 'ollama' | 'qwen' | 'pi';
}

export const MODEL_OPTIONS: ModelOption[] = [
  // Claude (latest → legacy order)
  { value: '', label: 'Default', cliType: 'claude' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', cliType: 'claude' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', cliType: 'claude' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', cliType: 'claude' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', cliType: 'claude' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', cliType: 'claude' },
  { value: 'claude-opus-4-5-20251101', label: 'Opus 4.5', cliType: 'claude' },
  // Codex
  { value: '', label: 'Default', cliType: 'codex' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', cliType: 'codex' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', cliType: 'codex' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', cliType: 'codex' },
  { value: 'gpt-5.5', label: 'GPT-5.5', cliType: 'codex' },
  { value: 'gpt-5.4', label: 'GPT-5.4', cliType: 'codex' },
  { value: 'gpt-5.3', label: 'GPT-5.3', cliType: 'codex' },
  { value: 'o3', label: 'o3', cliType: 'codex' },
  { value: 'o3-pro', label: 'o3-pro', cliType: 'codex' },
  { value: 'o4-mini', label: 'o4-mini', cliType: 'codex' },
  { value: 'gpt-4.1', label: 'GPT-4.1', cliType: 'codex' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', cliType: 'codex' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', cliType: 'codex' },
  // Cursor Agent
  { value: '', label: 'Default', cliType: 'cursor' },
  { value: 'auto', label: 'Auto', cliType: 'cursor' },
  { value: 'gpt-5', label: 'GPT-5', cliType: 'cursor' },
  // Kimi
  { value: '', label: 'Default', cliType: 'kimi' },
  { value: 'k2.5', label: 'K2.5', cliType: 'kimi' },
  { value: 'k2', label: 'K2', cliType: 'kimi' },
  { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K', cliType: 'kimi' },
  // Gemini (latest → stable order)
  { value: '', label: 'Default', cliType: 'gemini' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', cliType: 'gemini' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', cliType: 'gemini' },
  { value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite (Preview)', cliType: 'gemini' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', cliType: 'gemini' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', cliType: 'gemini' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', cliType: 'gemini' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', cliType: 'gemini' },
  // Qwen Code
  { value: '', label: 'Default', cliType: 'qwen' },
  { value: 'qwen3.6-plus', label: 'Qwen3.6 Plus', cliType: 'qwen' },
  // Pi
  { value: '', label: 'Default', cliType: 'pi' },
  // Ollama (uses OllamaConfig.model)
];

export function getModelsForCliType(cliType: string): ModelOption[] {
  return MODEL_OPTIONS.filter(m => m.cliType === cliType);
}
