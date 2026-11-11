import { describe, expect, it } from 'vitest';
import { ptySizeChanged } from './ptySize';

describe('ptySizeChanged', () => {
  it('is false when the grid is the same', () => {
    expect(ptySizeChanged({ cols: 168, rows: 49 }, { cols: 168, rows: 49 })).toBe(false);
  });
  it('is true when a bigger font leaves fewer columns or rows', () => {
    expect(ptySizeChanged({ cols: 168, rows: 49 }, { cols: 147, rows: 49 })).toBe(true);
    expect(ptySizeChanged({ cols: 168, rows: 49 }, { cols: 168, rows: 43 })).toBe(true);
  });
  it('ignores a terminal that has no size yet', () => {
    expect(ptySizeChanged({ cols: 168, rows: 49 }, { cols: 0, rows: 0 })).toBe(false);
    expect(ptySizeChanged({ cols: 168, rows: 49 }, { cols: NaN, rows: 49 })).toBe(false);
  });
});
