import { describe, expect, it } from 'vitest';
import { shouldNotifyReady } from './readyNotify';

describe('shouldNotifyReady', () => {
  it('notifies on the first ready of a fresh terminal', () => {
    expect(shouldNotifyReady(false, false)).toBe(true);
  });

  it('does not notify twice within one mount', () => {
    expect(shouldNotifyReady(true, true)).toBe(false);
  });

  it('re-registers the writer after a remount dropped it', () => {
    expect(shouldNotifyReady(true, false)).toBe(true);
  });
});
