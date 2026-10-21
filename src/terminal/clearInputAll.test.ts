import { describe, expect, it } from 'vitest';
import { CLEAR_LINE, CLEAR_PREVIOUS_LINE, clearAllInputSteps, runClearAllInput } from './clearInputAll';

describe('clear all input', () => {
  it('kills the current line, then joins and kills each line above', () => {
    expect(CLEAR_LINE).toBe('\x05\x15');
    expect(CLEAR_PREVIOUS_LINE).toBe('\x7f\x05\x15');
    expect(clearAllInputSteps(3)).toEqual(['\x05\x15', '\x7f\x05\x15', '\x7f\x05\x15']);
  });

  it('writes one small step at a time and stops when cancelled', async () => {
    const writes: string[] = [];
    await runClearAllInput((d) => writes.push(d), { maxLines: 4, delayMs: 0 });
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => w.length <= 3)).toBe(true);

    const partial: string[] = [];
    await runClearAllInput((d) => partial.push(d), { maxLines: 10, delayMs: 0, isCancelled: () => partial.length >= 2 });
    expect(partial).toHaveLength(2);
  });
});
