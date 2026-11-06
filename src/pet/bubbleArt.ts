// Pixel art for the pet's speech bubble and its small badges, authored like the character
// packs: one string per row, one char per pixel, '.' transparent. PetPage turns each piece
// into a PNG data URL once (petArtStyle) and uses it as CSS border-image / background, so
// the boxes stretch with their HTML text while staying crisp pixel art.
//
// The bubble and the chips are 9-slice images: the `slice` corners are drawn as-is, the
// single middle row / column of each edge stretches, and the 1x1 center fills the box.
//
// Palette: o outline (OCTO's), w fill, h highlight, s shade, k drop shadow, r alert.

import { OCTO_PACK } from './characters/octo';

/** CSS px per art pixel. The character is drawn at 4; text-sized boxes read better at 2. */
export const ART_PX = 2;

export const ART_PALETTE: Record<string, string> = {
  o: OCTO_PACK.palette.o,
  w: '#fff8ec',
  h: '#ffffff',
  s: '#ecdcc8',
  k: 'rgba(20, 8, 28, 0.32)',
  r: OCTO_PACK.palette.d,
};

export type Slice = { top: number; right: number; bottom: number; left: number };
export type NineSlice = { rows: string[]; slice: Slice };

/** Speech bubble: stepped rounded corners, highlight top-left, shade and shadow bottom-right. */
export const BUBBLE_ART: NineSlice = {
  rows: [
    '..ooooo...',
    '.ohhhhho..',
    'ohwwwwwso.',
    'ohwwwwwsok',
    'ohwwwwwsok',
    'ohwwwwwsok',
    'ohwwwwwsok',
    '.osssssokk',
    '..oooookk.',
    '...kkkkk..',
  ],
  slice: { top: 4, right: 5, bottom: 5, left: 4 },
};

/**
 * Tail under the bubble, tip at column 0 (placed on the character's center). Its first
 * TAIL_OVERLAP rows lie on the bubble's bottom shade / outline / shadow rows and open the
 * fill into the tail; '.' there lets the bubble show through.
 */
export const TAIL_ART: string[] = [
  '.wwwww..',
  'owwwwso.',
  'owwwso..',
  'owwsokk.',
  'owsokk..',
  'osokk...',
  'ookk....',
  'okk.....',
  '.k......',
];
export const TAIL_OVERLAP = 3;

/** Dark chip behind "+N". */
export const CHIP_DARK_ART: NineSlice = {
  rows: ['.o.', 'ooo', '.o.'],
  slice: { top: 1, right: 1, bottom: 1, left: 1 },
};

/** Light chip behind the unseen-done count. */
export const CHIP_LIGHT_ART: NineSlice = {
  rows: ['.o.', 'owo', '.o.'],
  slice: { top: 1, right: 1, bottom: 1, left: 1 },
};

/** "!" badge in front of a blocked bubble's text (one 16 px text line tall). */
export const BANG_ART: string[] = [
  '.ooooo.',
  'orrhrro',
  'orrhrro',
  'orrhrro',
  'orrhrro',
  'orrrrro',
  'orrhrro',
  '.ooooo.',
];

export type ArtRun = { x: number; y: number; w: number; color: string };

/** Horizontal runs of same-colored pixels (transparent and unknown chars skipped). */
export function artRuns(rows: string[], palette: Record<string, string> = ART_PALETTE): ArtRun[] {
  const out: ArtRun[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === '.' ? undefined : palette[ch];
      if (color) out.push({ x, y, w: end - x, color });
      x = end;
    }
  });
  return out;
}

type CanvasLike = {
  width: number;
  height: number;
  getContext(id: '2d'): Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'imageSmoothingEnabled'> | null;
  toDataURL(type?: string): string;
};

/** PNG data URL of `rows`, each art pixel `k` image px. Null when the canvas has no 2D context. */
export function artDataUrl(rows: string[], k: number, makeCanvas: () => CanvasLike): string | null {
  const c = makeCanvas();
  c.width = rows[0].length * k;
  c.height = rows.length * k;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  for (const run of artRuns(rows)) {
    ctx.fillStyle = run.color;
    ctx.fillRect(run.x * k, run.y * k, run.w * k, k);
  }
  return c.toDataURL('image/png');
}

/** `border-width` value for a 9-slice drawn at ART_PX. */
export function nineSliceWidth(art: NineSlice): string {
  const { top, right, bottom, left } = art.slice;
  return [top, right, bottom, left].map((n) => `${n * ART_PX}px`).join(' ');
}

/** `border-image` value for a 9-slice whose image has `k` image px per art pixel. */
export function nineSliceBorderImage(art: NineSlice, url: string, k: number): string {
  const { top, right, bottom, left } = art.slice;
  const slice = [top, right, bottom, left].map((n) => n * k).join(' ');
  return `url("${url}") ${slice} fill / ${nineSliceWidth(art)} stretch`;
}

/**
 * CSS custom properties for PetPage's root: border-images for the bubble and chips and
 * background images for the tail and "!" badge. Images are pre-scaled to whole device
 * pixels (ART_PX * dpr per art pixel) so they stay crisp without browser resampling.
 * Null when no canvas is available (tests); the CSS then keeps its plain fallback.
 */
export function petArtStyle(dpr: number, makeCanvas: () => CanvasLike): Record<string, string> | null {
  const k = ART_PX * Math.max(1, Math.round(dpr || 1));
  const bubble = artDataUrl(BUBBLE_ART.rows, k, makeCanvas);
  const dark = artDataUrl(CHIP_DARK_ART.rows, k, makeCanvas);
  const light = artDataUrl(CHIP_LIGHT_ART.rows, k, makeCanvas);
  const tail = artDataUrl(TAIL_ART, k, makeCanvas);
  const bang = artDataUrl(BANG_ART, k, makeCanvas);
  if (!bubble || !dark || !light || !tail || !bang) return null;
  return {
    '--pet-bubble-bi': nineSliceBorderImage(BUBBLE_ART, bubble, k),
    '--pet-bubble-bw': nineSliceWidth(BUBBLE_ART),
    '--pet-chip-dark-bi': nineSliceBorderImage(CHIP_DARK_ART, dark, k),
    '--pet-chip-light-bi': nineSliceBorderImage(CHIP_LIGHT_ART, light, k),
    '--pet-chip-bw': nineSliceWidth(CHIP_DARK_ART),
    '--pet-tail-img': `url("${tail}")`,
    '--pet-bang-img': `url("${bang}")`,
  };
}
