// Scroll pin: while a TUI streams output, writeXterm restores the viewport to
// `scrollOffsetFromBottom` after every write. The pin must follow the user's
// wheel in BOTH directions — if wheel-down never updates it, each write yanks
// the viewport back up and the user can never reach the bottom while output
// flows (Kimi Code TUI on Windows/ConPTY repaints almost continuously, so
// onScroll's idle-time correction never runs there).
export interface ScrollPin {
  userScrolledUp: boolean;
  scrollOffsetFromBottom: number;
}

// distFromBottom is the viewport's current distance from the bottom
// (baseY - viewportY) read BEFORE the browser applies this wheel event's
// native scroll, so the new pin is predicted from the wheel delta instead of
// re-read afterwards — the write-time restore then lands on the same target
// and stops fighting the user.
export const applyWheelToScrollPin = (
  pin: ScrollPin,
  deltaY: number,
  distFromBottom: number,
  wheelLines: number,
): ScrollPin => {
  const lines = Math.max(1, wheelLines);
  if (deltaY < 0) {
    return { userScrolledUp: true, scrollOffsetFromBottom: Math.max(1, distFromBottom + lines) };
  }
  if (deltaY > 0 && pin.userScrolledUp) {
    const next = Math.max(0, distFromBottom - lines);
    if (next === 0) return { userScrolledUp: false, scrollOffsetFromBottom: 0 };
    return { userScrolledUp: true, scrollOffsetFromBottom: next };
  }
  return pin;
};
