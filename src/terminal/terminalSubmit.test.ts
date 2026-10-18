import { describe, expect, it } from 'vitest';
import { isInteractiveAgentTerminal, terminalSubmitDelayMs } from './terminalSubmit';

describe('terminal command submission', () => {
  it('submits shells immediately but lets interactive agent input settle', () => {
    expect(isInteractiveAgentTerminal('shell')).toBe(false);
    expect(isInteractiveAgentTerminal(undefined)).toBe(false);
    expect(isInteractiveAgentTerminal('bbarit')).toBe(true);
    expect(isInteractiveAgentTerminal('bbarit-oss')).toBe(true);
    expect(isInteractiveAgentTerminal('claude')).toBe(true);
    expect(isInteractiveAgentTerminal('codex')).toBe(true);
    expect(isInteractiveAgentTerminal('kimi')).toBe(true);
  });

  it('uses the proven 1.2 second floor and caps long pasted prompts', () => {
    expect(terminalSubmitDelayMs('git status')).toBe(1200);
    expect(terminalSubmitDelayMs('x'.repeat(2400))).toBe(1800);
    expect(terminalSubmitDelayMs('x'.repeat(20_000))).toBe(5000);
  });
});
