import { describe, expect, it } from 'vitest';
import {
  ART_PALETTE,
  ART_PX,
  BANG_ART,
  BUBBLE_ART,
  CHIP_DARK_ART,
  CHIP_LIGHT_ART,
  TAIL_ART,
  TAIL_OVERLAP,
  artDataUrl,
  artRuns,
  nineSliceBorderImage,
  nineSliceWidth,
  petArtStyle,
  type NineSlice,
} from './bubbleArt';

const SPRITES: Record<string, string[]> = {
  bubble: BUBBLE_ART.rows,
  chipDark: CHIP_DARK_ART.rows,
  chipLight: CHIP_LIGHT_ART.rows,
  tail: TAIL_ART,
  bang: BANG_ART,
};
const NINE_SLICES: Record<string, NineSlice> = { bubble: BUBBLE_ART, chipDark: CHIP_DARK_ART, chipLight: CHIP_LIGHT_ART };

/** Column `x` of `rows`, top to bottom. */
const column = (rows: string[], x: number) => rows.map((r) => r[x]).join('');

describe('bubble art', () => {
  it.each(Object.entries(SPRITES))('%s: every row has the same length and only palette chars', (_, rows) => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.length).toBe(rows[0].length);
      for (const ch of row) expect(ch === '.' || ch in ART_PALETTE, `char "${ch}"`).toBe(true);
    }
  });

  it.each(Object.entries(NINE_SLICES))('%s: slices leave exactly a 1x1 center that is opaque fill', (_, art) => {
    const { top, right, bottom, left } = art.slice;
    expect(top + bottom + 1).toBe(art.rows.length);
    expect(left + right + 1).toBe(art.rows[0].length);
    expect(art.rows[top][left]).not.toBe('.');
    // The stretched edge strips are opaque where the box has its outline.
    expect(column(art.rows, left)).toContain('o');
    expect(art.rows[top]).toContain('o');
  });

  it('the tail opens into the bubble: its overlap rows are the bubble rows below the fill', () => {
    const edge = column(BUBBLE_ART.rows, BUBBLE_ART.slice.left); // top edge .. bottom edge
    const belowFill = edge.length - 1 - edge.lastIndexOf('w');
    expect(belowFill).toBe(TAIL_OVERLAP);
    // Inside the opening the tail paints fill over the bubble's shade / outline / shadow rows.
    for (let y = 0; y < TAIL_OVERLAP; y++) expect(TAIL_ART[y]).toContain('w');
    // The tip (lowest outline pixel) is column 0, which PetPage puts on the character's center.
    const tipRow = TAIL_ART.map((r) => r.includes('o')).lastIndexOf(true);
    expect(TAIL_ART[tipRow].indexOf('o')).toBe(0);
  });

  it('the "!" badge is one 16 px text line tall', () => {
    expect(BANG_ART.length * ART_PX).toBe(16);
  });

  it('artRuns merges same-colored pixels and skips transparent ones', () => {
    expect(artRuns(['.oo', 'wwk'])).toEqual([
      { x: 1, y: 0, w: 2, color: ART_PALETTE.o },
      { x: 0, y: 1, w: 2, color: ART_PALETTE.w },
      { x: 2, y: 1, w: 1, color: ART_PALETTE.k },
    ]);
  });

  it('builds border-image values with slices in image px and widths in CSS px', () => {
    expect(nineSliceWidth(BUBBLE_ART)).toBe('8px 10px 10px 8px');
    expect(nineSliceBorderImage(BUBBLE_ART, 'data:x', 4)).toBe('url("data:x") 16 20 20 16 fill / 8px 10px 10px 8px stretch');
  });
});

describe('artDataUrl / petArtStyle', () => {
  function fakeCanvas() {
    const rects: number[][] = [];
    const canvases: { width: number; height: number }[] = [];
    const make = () => {
      const c = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '' as string | CanvasGradient | CanvasPattern,
          imageSmoothingEnabled: true,
          fillRect: (...a: number[]) => void rects.push(a),
        }),
        toDataURL: () => `data:image/png;base64,${c.width}x${c.height}`,
      };
      canvases.push(c);
      return c;
    };
    return { make, rects, canvases };
  }

  it('scales each art pixel by k', () => {
    const f = fakeCanvas();
    expect(artDataUrl(['.o', 'oo'], 3, f.make)).toBe('data:image/png;base64,6x6');
    expect(f.rects).toEqual([
      [3, 0, 3, 3],
      [0, 3, 6, 3],
    ]);
  });

  it('pre-scales images to device pixels and returns null without a 2D context', () => {
    const f = fakeCanvas();
    const style = petArtStyle(2, f.make);
    expect(style?.['--pet-bubble-bw']).toBe('8px 10px 10px 8px');
    expect(style?.['--pet-bubble-bi']).toContain(' 16 20 20 16 fill / 8px 10px 10px 8px stretch');
    expect(f.canvases[0]).toMatchObject({ width: BUBBLE_ART.rows[0].length * 4, height: BUBBLE_ART.rows.length * 4 });
    expect(style?.['--pet-tail-img']).toMatch(/^url\("data:/);
    const noCtx = () => ({ width: 0, height: 0, getContext: () => null, toDataURL: () => '' });
    expect(petArtStyle(1, noCtx)).toBeNull();
  });
});
