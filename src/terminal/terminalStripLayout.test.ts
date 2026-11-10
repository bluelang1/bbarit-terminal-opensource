import { describe, expect, it } from 'vitest';
import { FIT_SCROLLBAR_LANE, fitAddonCols, terminalAreaWidth } from './terminalStripLayout';

const base = { padLeft: 8, minStrip: 28, lane: FIT_SCROLLBAR_LANE };

describe('terminal area width beside the button strip', () => {
  it('reserves the same 14 px lane as @xterm/addon-fit under xterm 5.3', () => {
    expect(FIT_SCROLLBAR_LANE).toBe(14);
  });

  it('absorbs the cols rounding leftover into the strip (8.625 px cells)', () => {
    // available = 1498 - 8 - 28 = 1462 -> cols = floor(1448 / 8.625) = 167
    const width = terminalAreaWidth({ ...base, wrapWidth: 1498, cellWidth: 8.625 });
    expect(width).toBe(Math.ceil(167 * 8.625 + 14)); // 1455 (1454.375 rounded up)
    expect(fitAddonCols(width!, 14, 8.625)).toBe(167);
    expect(1498 - 8 - width!).toBe(35); // strip = 28 + 7 px leftover
  });

  it('keeps an exact multiple exact', () => {
    // available = 1000 - 36 = 964 -> (964 - 14) / 10 = 95 cols, no leftover
    expect(terminalAreaWidth({ ...base, wrapWidth: 1000, cellWidth: 10 })).toBe(964);
  });

  it('never yields one column less than fitting the full available width would', () => {
    for (const cell of [7, 7.2, 8.4296875, 8.625, 9.01, 9.6, 10.5, 12.0000001, 16.8]) {
      for (let wrapWidth = 120; wrapWidth <= 2600; wrapWidth += 7) {
        const available = wrapWidth - 36;
        const width = terminalAreaWidth({ ...base, wrapWidth, cellWidth: cell });
        if (width === null) continue;
        expect(Number.isInteger(width)).toBe(true);
        expect(width).toBeLessThanOrEqual(available);
        expect(fitAddonCols(width, 14, cell)).toBe(fitAddonCols(available, 14, cell));
        // Only the scrollbar lane (plus the < 1 px ceil) sits between the text and the strip.
        expect(width - fitAddonCols(width, 14, cell) * cell - 14).toBeLessThan(1);
      }
    }
  });

  it('bumps the width when float noise would make fit drop a column', () => {
    // 3 * 0.1 style noise: cols * cell lands a hair above the integer.
    const cell = 0.1 + 0.2 + 7; // 7.300000000000001
    const width = terminalAreaWidth({ ...base, wrapWidth: 800, cellWidth: cell })!;
    expect(fitAddonCols(width, 14, cell)).toBe(fitAddonCols(800 - 36, 14, cell));
  });

  it('falls back (null) for tiny panes and unmeasured cells', () => {
    expect(terminalAreaWidth({ ...base, wrapWidth: 60, cellWidth: 9 })).toBeNull(); // < lane + 2 cells
    expect(terminalAreaWidth({ ...base, wrapWidth: 1000, cellWidth: 0 })).toBeNull();
    expect(terminalAreaWidth({ ...base, wrapWidth: 0, cellWidth: 9 })).toBeNull();
    expect(terminalAreaWidth({ ...base, wrapWidth: Number.NaN, cellWidth: 9 })).toBeNull();
  });
});
