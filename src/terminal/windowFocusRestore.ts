// Returning from another app reactivates the window, but the webview can come back without
// handing keystrokes to the element it still reports as activeElement — typing then does nothing
// until the user clicks the terminal. Re-focusing that same element is a no-op, so the caller has
// to drop focus first. Ownership is sampled at blur time so a user who left from the editor or a
// search box keeps their place instead of having the terminal steal focus on return.
export interface WindowFocusRestoreOptions {
  win: Window;
  ownsFocus: () => boolean;
  refocus: (isRetry: boolean) => void;
  isDisposed: () => boolean;
  retryDelayMs?: number;
}

export const attachWindowFocusRestore = ({
  win,
  ownsFocus,
  refocus,
  isDisposed,
  retryDelayMs = 60,
}: WindowFocusRestoreOptions): (() => void) => {
  let ownedBeforeBlur = false;
  let retryTimer: number | null = null;

  const clearRetry = () => {
    if (retryTimer == null) return;
    win.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const handleBlur = () => {
    ownedBeforeBlur = ownsFocus();
  };

  const handleFocus = () => {
    if (!ownedBeforeBlur) return;
    ownedBeforeBlur = false;
    clearRetry();
    refocus(false);
    // Layout and the webview's own focus handling can still be settling right after the window
    // comes back, so make one more attempt.
    retryTimer = win.setTimeout(() => {
      retryTimer = null;
      if (!isDisposed()) refocus(true);
    }, retryDelayMs);
  };

  win.addEventListener('blur', handleBlur);
  win.addEventListener('focus', handleFocus);

  return () => {
    clearRetry();
    win.removeEventListener('blur', handleBlur);
    win.removeEventListener('focus', handleFocus);
  };
};
