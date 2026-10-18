import { describe, expect, it } from 'vitest';
import { getModeFeatureProfile, resolveEffectiveCliProvider } from './runtimeFeatures';

describe('runtimeFeatures', () => {
  it('enables workflow features only for coding mode', () => {
    expect(getModeFeatureProfile('coding')).toMatchObject({
      supportsWorkflow: true,
      supportsWorkflowEditor: true,
      supportsWorkflowTimeoutFallback: true,
    });
    expect(getModeFeatureProfile('thinking')).toMatchObject({
      supportsWorkflow: false,
      supportsWorkflowEditor: false,
      supportsWorkflowTimeoutFallback: false,
    });
  });

  it('forces Atlas Cloud provider for deep-research mode', () => {
    expect(getModeFeatureProfile('deep-research').forceProvider).toBe('atlascloud');
    expect(resolveEffectiveCliProvider('deep-research', 'claude-cli', (provider) => provider as any)).toBe('atlascloud');
  });
});
