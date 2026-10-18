import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { attachWindowFocusRestore } from './windowFocusRestore';

const leaveAndReturn = () => {
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
};

describe('window focus restore', () => {
  let owned: boolean;
  let disposed: boolean;
  let refocus: Mock<(isRetry: boolean) => void>;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    owned = true;
    disposed = false;
    refocus = vi.fn<(isRetry: boolean) => void>();
    detach = attachWindowFocusRestore({
      win: window,
      ownsFocus: () => owned,
      refocus,
      isDisposed: () => disposed,
    });
  });

  afterEach(() => {
    detach();
    vi.useRealTimers();
  });

  it('refocuses the terminal when it owned focus before the window went away', () => {
    leaveAndReturn();
    expect(refocus).toHaveBeenCalledWith(false);
  });

  it('retries once after the window has settled', () => {
    leaveAndReturn();
    vi.advanceTimersByTime(200);
    expect(refocus.mock.calls).toEqual([[false], [true]]);
  });

  it('leaves focus alone when the user left from somewhere else', () => {
    owned = false;
    leaveAndReturn();
    vi.advanceTimersByTime(200);
    expect(refocus).not.toHaveBeenCalled();
  });

  it('ignores a focus event that was not preceded by a blur', () => {
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(200);
    expect(refocus).not.toHaveBeenCalled();
  });

  it('does not restore twice from a single blur', () => {
    leaveAndReturn();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(200);
    expect(refocus.mock.calls).toEqual([[false], [true]]);
  });

  it('skips the retry once the terminal is disposed', () => {
    leaveAndReturn();
    disposed = true;
    vi.advanceTimersByTime(200);
    expect(refocus.mock.calls).toEqual([[false]]);
  });

  it('drops a pending retry when detached', () => {
    leaveAndReturn();
    detach();
    vi.advanceTimersByTime(200);
    expect(refocus.mock.calls).toEqual([[false]]);
  });

  it('stops responding after detach', () => {
    detach();
    leaveAndReturn();
    vi.advanceTimersByTime(200);
    expect(refocus).not.toHaveBeenCalled();
  });
});
