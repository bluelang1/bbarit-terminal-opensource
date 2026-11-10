// Width of the xterm area next to the terminal's button strip (XTerminal TERMINAL_GUTTER_WIDTH).
//
// @xterm/addon-fit computes cols = floor((parentWidth - lane) / cellWidth), so whatever is left
// after the last column (< one cell) used to show up as empty space before the strip. This picks
// the narrowest integer width that still gives fit the same cols as the full available width;
// the strip grows by the leftover instead. The result depends only on the wrapper width and the
// cell width, never on the area's own width, so applying it cannot feed back into a resize loop.

/**
 * Scrollbar lane @xterm/addon-fit 0.11 reserves: `options.overviewRuler?.width || 14`. xterm 5.3
 * has no `overviewRuler` option (only `overviewRulerWidth`, which fit does not read), so it is
 * always 14 px here; the drawn scrollbar (App.css `.xterm-viewport::-webkit-scrollbar`) is 10 px.
 */
export const FIT_SCROLLBAR_LANE = 14;

/** Same minimum as @xterm/addon-fit. */
const MINIMUM_COLS = 2;
const EPSILON = 1e-6;

/** Cols @xterm/addon-fit computes for a parent of `width` px (it parseInt()s the computed width). */
export function fitAddonCols(width: number, lane: number, cellWidth: number): number {
  return Math.max(MINIMUM_COLS, Math.floor((Math.trunc(width) - lane) / cellWidth));
}

export interface TerminalAreaInput {
  /** Outer wrapper width (the element that holds both the xterm area and the strip). */
  wrapWidth: number;
  /** Space left of the xterm area inside the wrapper. */
  padLeft: number;
  /** Strip width when there is no leftover to absorb. */
  minStrip: number;
  /** Scrollbar lane fit reserves (FIT_SCROLLBAR_LANE). */
  lane: number;
  /** xterm CSS cell width (renderService dimensions.css.cell.width, as fit uses). */
  cellWidth: number;
}

/**
 * Integer px width for the xterm area, or null to keep the plain layout (area = wrapper minus
 * padding and strip) when the cell is not measured yet or the pane is too narrow.
 */
export function terminalAreaWidth({ wrapWidth, padLeft, minStrip, lane, cellWidth }: TerminalAreaInput): number | null {
  if (!(cellWidth > 0) || !Number.isFinite(cellWidth) || !Number.isFinite(wrapWidth)) return null;
  const available = Math.floor(wrapWidth - padLeft - minStrip);
  const cols = Math.floor((available - lane) / cellWidth);
  if (cols < MINIMUM_COLS) return null;
  let width = Math.ceil(cols * cellWidth + lane - EPSILON);
  // Float noise in cols * cellWidth can leave fit one column short; step up until it matches.
  while (width < available && fitAddonCols(width, lane, cellWidth) < cols) width += 1;
  return Math.min(width, available);
}
