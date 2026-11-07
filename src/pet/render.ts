// Canvas renderer for character packs: one fillRect per horizontal run of
// same-colored pixels, nearest-neighbor, scaled by pack.scale.

import type { CharacterPack, PackFrame } from './pack';

/**
 * Draw `frame` with its top-left at canvas px (x, y). `flip` mirrors it
 * horizontally (packs are authored facing right / the viewer).
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  pack: CharacterPack,
  frame: PackFrame,
  x: number,
  y: number,
  flip: boolean,
): void {
  const s = pack.scale;
  const w = pack.size.w;
  ctx.imageSmoothingEnabled = false;
  frame.rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      let end = c + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === '.' ? undefined : pack.palette[ch];
      if (color) {
        const left = flip ? w - end : c;
        ctx.fillStyle = color;
        ctx.fillRect(x + left * s, y + r * s, (end - c) * s, s);
      }
      c = end;
    }
  });
}
