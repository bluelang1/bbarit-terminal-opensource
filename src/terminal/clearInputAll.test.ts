import { describe, expect, it } from 'vitest';
import { CLEAR_LINE, CLEAR_PREVIOUS_LINE, clearAllInputSteps, runClearAllInput, usesSingleLineClear } from './clearInputAll';

describe('clear all input', () => {
  it('kills the current line, then joins and kills each line above', () => {
    expect(CLEAR_LINE).toBe('\x05\x15');
    expect(CLEAR_PREVIOUS_LINE).toBe('\x7f\x05\x15');
    expect(clearAllInputSteps(3)).toEqual(['\x7f\x05\x15', '\x7f\x05\x15']);
  });

  it('writes one small step at a time and stops when cancelled', async () => {
    const writes: string[] = [];
    await runClearAllInput((d) => writes.push(d), { maxLines: 4, delayMs: 0 });
    expect(writes).toHaveLength(3);
    expect(writes.every((w) => w.length <= 3)).toBe(true);

    const partial: string[] = [];
    await runClearAllInput((d) => partial.push(d), { maxLines: 10, delayMs: 0, isCancelled: () => partial.length >= 2 });
    expect(partial).toHaveLength(2);
  });
});

describe('which CLIs get the multi-line clear', () => {
  it('keeps the single-line clear for shells, ollama and the bbarit agent', () => {
    expect(usesSingleLineClear('shell', false)).toBe(true);
    expect(usesSingleLineClear(undefined, false)).toBe(true);
    expect(usesSingleLineClear('ollama', false)).toBe(true);
    expect(usesSingleLineClear('bbarit', true)).toBe(true);
    expect(usesSingleLineClear('claude', false)).toBe(false);
    expect(usesSingleLineClear('codex', false)).toBe(false);
  });
});
