import type { CliProvider } from './cliRuntime';

export type HarnessAgentMode =
  | 'flash'
  | 'thinking'
  | 'pro'
  | 'ultra'
  | 'deep-research'
  | 'image-gen'
  | 'video-gen'
  | 'coding';

export type HarnessAiProvider =
  | 'atlascloud'
  | 'ollama'
  | 'openai'
  | 'claude-api'
  | 'claude-cli'
  | 'codex-cli'
  | 'kimi-cli'
  | 'gemini-cli'
  | 'qwen-cli';

export interface HarnessModeFeatureProfile {
  mode: HarnessAgentMode;
  supportsWorkflow: boolean;
  supportsWorkflowEditor: boolean;
  supportsWorkflowTimeoutFallback: boolean;
  forceProvider?: HarnessAiProvider;
}

export function getModeFeatureProfile(mode: HarnessAgentMode): HarnessModeFeatureProfile {
  return {
    mode,
    supportsWorkflow: mode === 'coding',
    supportsWorkflowEditor: mode === 'coding',
    supportsWorkflowTimeoutFallback: mode === 'coding',
    forceProvider: mode === 'deep-research' ? 'atlascloud' : undefined,
  };
}

export function resolveEffectiveCliProvider(
  mode: HarnessAgentMode,
  provider: HarnessAiProvider,
  ensureCliProvider: (provider: HarnessAiProvider) => CliProvider,
): CliProvider {
  const profile = getModeFeatureProfile(mode);
  return ensureCliProvider(profile.forceProvider || provider);
}
