import { describe, expect, it } from 'vitest';
import { createHarnessRuntime } from './runtimeFactory';
import { createHarnessLearningRuntime } from './runtimeFactoryLearning';

describe('runtimeFactory', () => {
  it('assembles a coding runtime with workflow-enabled features', () => {
    const runtime = createHarnessRuntime({
      mode: 'coding',
      provider: 'claude-cli',
      backgroundProvider: 'codex-cli',
      responseLanguage: 'en',
      ensureCliProvider: (provider) => provider as any,
    });

    expect(runtime.featureProfile.supportsWorkflow).toBe(true);
    expect(runtime.backgroundProvider).toBe('codex-cli');
    expect(runtime.middleware.names()).toEqual([
      'runtime_mode',
      'thread_context',
      'memory_and_prompt',
      'provider_and_messages',
    ]);
  });

  it('resolves forced deep-research provider from assembled runtime', () => {
    const runtime = createHarnessRuntime({
      mode: 'deep-research',
      provider: 'claude-cli',
      backgroundProvider: 'kimi-cli',
      responseLanguage: 'en',
      ensureCliProvider: (provider) => provider as any,
    });

    expect(runtime.features.getModeProfile('deep-research').forceProvider).toBe('atlascloud');
    expect(runtime.providers.resolveEffectiveCliProvider()).toBe('atlascloud');
  });

  it('carries direct-response assembly features through the runtime', () => {
    const runtime = createHarnessRuntime({
      mode: 'coding',
      provider: 'claude-cli',
      backgroundProvider: 'claude-cli',
      responseLanguage: 'en',
      ensureCliProvider: (provider) => provider as any,
      directResponse: {
        features: {
          memoryAndPrompt: false,
        },
      },
    });

    expect(runtime.middleware.assembly).toEqual({
      features: {
        memoryAndPrompt: false,
      },
    });
    expect(runtime.middleware.names(runtime.middleware.assembly)).toEqual([
      'runtime_mode',
      'thread_context',
      'provider_and_messages',
    ]);
  });

  it('reuses an injected learning assembly across runtime recreation', () => {
    const learningAssembly = createHarnessLearningRuntime();

    const runtime = createHarnessRuntime({
      mode: 'coding',
      provider: 'claude-cli',
      backgroundProvider: 'claude-cli',
      responseLanguage: 'ko',
      ensureCliProvider: (provider) => provider as any,
      learningAssembly,
    });

    expect(runtime.selfImproving).toBe(learningAssembly.selfImproving);
    expect(runtime.selfImproving.providerRegistry).toBe(learningAssembly.learningProviderRegistry);
  });
});
