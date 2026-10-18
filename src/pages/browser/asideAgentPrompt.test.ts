import { describe, expect, it } from 'vitest';
import { buildAsideAgentPromptPrefix, hostPath } from './asideAgentPrompt';

describe('buildAsideAgentPromptPrefix', () => {
  it('redacts secrets from page, mentioned tab, selection, and memory context', () => {
    const prompt = buildAsideAgentPromptPrefix({
      includeCtx: true,
      pageUrl: 'https://example.com/dashboard?token=abcd1234&safe=1',
      pageTitle: 'API key sk-abcdefghijklmnop1234',
      selectionText: 'Bearer abcdef1234567890XYZ and card 4111111111111111',
      mentionedTabs: [
        { title: 'password=hunter2secret', url: 'https://other.test/?api_key=myLongSecretValue123' },
      ],
      memoryOn: true,
      memoryLines: ['visited https://app.test/?secret=supersecret'],
    });

    expect(prompt).toContain('token=[REDACTED:credential]');
    expect(prompt).toContain('[REDACTED:apikey]');
    expect(prompt).toContain('[REDACTED:bearer]');
    expect(prompt).toContain('[REDACTED:card]');
    expect(prompt).toContain('password=[REDACTED:credential]');
    expect(prompt).toContain('api_key=[REDACTED:credential]');
    expect(prompt).toContain('secret=[REDACTED:credential]');
    expect(prompt).not.toContain('hunter2secret');
    expect(prompt).not.toContain('supersecret');
  });

  it('omits empty context blocks', () => {
    expect(buildAsideAgentPromptPrefix({
      includeCtx: false,
      pageUrl: null,
      pageTitle: null,
      mentionedTabs: [],
      memoryOn: false,
    })).toBe('');
  });
});

describe('hostPath', () => {
  it('formats URLs compactly', () => {
    expect(hostPath('https://example.com/path?q=1')).toBe('example.com/path');
    expect(hostPath('not a url')).toBe('not a url');
  });
});
