// Wheel → PTY tick conversion for full-screen TUIs (Claude Code `tui: fullscreen`,
// alt-buffer apps). Each tick becomes one mouse-wheel escape or arrow key, and the
// app scrolls several rows per tick. A macOS trackpad fires dozens of tiny pixel
// deltas per swipe (plus momentum); rounding each one up to a whole tick made a
// light swipe jump a whole screen. Pixel deltas are accumulated instead and a tick
// is emitted per `stepPx`, keeping the remainder for the next event.

export interface WheelInput {
  deltaY: number;
  deltaMode: number; // 0=pixel, 1=line, 2=page
  wheelDeltaY?: number; // legacy WebKit field; multiples of 120 mean a mouse notch
}

export interface WheelTicks {
  ticks: number; // signed: negative = up
  remainder: number; // carry for the next event
}

const NOTCH = 120;

export const wheelToTicks = (
  e: WheelInput,
  remainder: number,
  stepPx: number,
  rows: number,
): WheelTicks => {
  const dy = e.deltaY;
  if (dy === 0) return { ticks: 0, remainder };
  const sign = dy < 0 ? -1 : 1;
  if (e.deltaMode === 1) {
    return { ticks: sign * Math.max(1, Math.round(Math.abs(dy) / 3)), remainder: 0 };
  }
  if (e.deltaMode === 2) {
    return { ticks: sign * Math.max(1, Math.round(Math.abs(dy))) * Math.max(1, rows), remainder: 0 };
  }
  // Physical mouse wheel in pixel mode: one tick per notch, never swallowed.
  // WebKit reports trackpad wheelDeltaY as 3×deltaY, so a 40px trackpad event
  // also lands on 120 — those keep accumulating.
  const legacy = Math.abs(e.wheelDeltaY ?? 0);
  const trackpadLike = legacy === Math.round(Math.abs(dy) * 3);
  if (!trackpadLike && legacy >= NOTCH && legacy % NOTCH === 0) {
    return { ticks: sign * (legacy / NOTCH), remainder: 0 };
  }
  // Direction change drops the carry so reversing responds immediately.
  const carry = remainder !== 0 && Math.sign(remainder) !== sign ? 0 : remainder;
  const acc = carry + dy;
  const step = Math.max(1, stepPx);
  const ticks = Math.trunc(acc / step) || 0; // no -0
  return { ticks, remainder: acc - ticks * step };
};
