// Shared accessories for the desktop pet: season / special-day wearables and the treats it
// eats. Authored once like the character packs (one string per row, one char per pixel,
// '.' transparent) and placed on a pack frame through its anchors (pack.ts AnchorName):
//
//   head  top-center of the head (the row the head outline starts on). Hats sit on it;
//         sunglasses hang a fixed number of rows below it (OCTO puts the eyes 6 rows down).
//   hand  where a held thing is gripped (tentacle tip). Treats are drawn up against it.
//   body  center of the neck line, where the head meets the body / tentacles.
//
// An accessory pixel is one pack pixel (drawn at the pack's scale), so accessories match
// the character's chunky pixels. A frame without the anchor an accessory needs simply does
// not draw it. Outline color is OCTO's, like the speech bubble (bubbleArt.ts).

import type { Anchor, AnchorName, AnimName, CharacterPack, PackFrame } from './pack';
import { treatFor, type PetCalendar } from './calendar';

export type AccessoryId =
  | 'santaHat'
  | 'santaSuit'
  | 'witchHat'
  | 'pumpkin'
  | 'scarf'
  | 'sunglasses'
  | 'pepero'
  | 'chocolate'
  | 'candy';

/** `rows` drawn with art pixel (ox, oy) on the anchor point. */
export type AccessoryFrame = { rows: string[]; ox: number; oy: number };

export type Accessory = {
  anchor: AnchorName;
  /** One frame for wearables; treats have one per bite stage (whole, bitten, almost gone). */
  frames: AccessoryFrame[];
  palette: Record<string, string>;
  /** Drawn before the body (the character's own pixels cover it), e.g. a carried pumpkin. */
  behind?: boolean;
};

const O = '#3b1f47'; // OCTO outline

const SANTA_HAT: AccessoryFrame = {
  rows: [
    '..........ooooo..........',
    '........oorrrrRooo.......',
    '.......orhrrrrrRRRoo.....',
    '......orhrrrrrrrRRRRo....',
    '......orrrrrrrrrRoRRRo...',
    '.....orrrrrrrrrrRooooooo.',
    '.....orrrrrrrrrrRRo.owwwo',
    '....orrrrrrrrrrrrRo.owwwo',
    '....ooooooooooooooooowwso',
    '...owwwwwwwwwwwwwwwwoooo.',
    '...osswwwwwwwwwwwwsso....',
    '....oooooooooooooooo.....',
  ],
  ox: 12,
  oy: 6,
};

export const ACCESSORIES: Record<AccessoryId, Accessory> = {
  santaHat: {
    anchor: 'head',
    frames: [SANTA_HAT],
    palette: { o: O, r: '#e8384f', R: '#b3233b', h: '#ff7a8a', w: '#fff8ec', s: '#e3d6c6' },
  },
  santaSuit: {
    anchor: 'body',
    frames: [
      {
        rows: [
          '...orrrrrrrrrrrrrrrro...',
          '..okkkkkkkoyyokkkkkkko..',
          '..oswwwwwwwwwwwwwwwwso..',
          '...oooooooooooooooooo...',
        ],
        ox: 12,
        oy: 1,
      },
    ],
    palette: { o: O, r: '#e8384f', w: '#fff8ec', s: '#e3d6c6', k: '#2a1530', y: '#ffd166' },
  },
  witchHat: {
    anchor: 'head',
    frames: [
      {
        rows: [
          '..............oo........',
          '.............oPo........',
          '............opo.........',
          '...........oppo.........',
          '..........ohppo.........',
          '.........ohpppPo........',
          '........ohppppPPo.......',
          '........ogggggggo.......',
          '.......ogyggggggGo......',
          '.......opppppppppPPo....',
          '..ooooopppppppppppPPooo.',
          '.oppppppppppppppppppPPPo',
          '..oooooooooooooooooooo..',
        ],
        ox: 12,
        oy: 9,
      },
    ],
    palette: { o: O, p: '#6b3fa0', P: '#4a2a72', h: '#9168c8', g: '#58c27d', G: '#3d9a5e', y: '#ffd166' },
  },
  pumpkin: {
    anchor: 'hand',
    behind: true,
    frames: [
      {
        rows: [
          '......oo.....',
          '.....ogo.....',
          '..ooooooooo..',
          '.ohaaaaAaaAo.',
          'ohaayaaAayaAo',
          'oaayyyaAyyyAo',
          'oaaaaaaAaaaAo',
          'oaayyyyyyyaAo',
          '.oaayayayaAo.',
          '..ooooooooo..',
        ],
        ox: 3,
        oy: 6,
      },
    ],
    palette: { o: O, a: '#ff9a3c', A: '#d9701e', h: '#ffc27a', y: '#2a1530', g: '#58c27d' },
  },
  scarf: {
    anchor: 'body',
    frames: [
      {
        rows: [
          '.oooooooooooooooooooo.',
          'orrwwrrwwrrwwrrwwrrwwo',
          'oRRwwRRwwRRwwRRwwRRwso',
          '.oooooooooooooooorrwwo',
          '.................oRRso',
          '.................orrwo',
          '.................oRRso',
          '..................oo..',
        ],
        ox: 11,
        oy: 1,
      },
    ],
    palette: { o: O, r: '#e8384f', R: '#b3233b', w: '#fff8ec', s: '#e3d6c6' },
  },
  sunglasses: {
    anchor: 'head',
    frames: [
      {
        rows: [
          'oooooooooooooooo',
          '.okkwko..okkwko.',
          '.okwkko..okwkko.',
          '..oooo....oooo..',
        ],
        ox: 8,
        oy: -5,
      },
    ],
    palette: { o: O, k: '#241433', w: '#9fd8ff' },
  },
  pepero: {
    anchor: 'hand',
    // Chocolate end in the mouth, biscuit end out to the side; open at the mouth end.
    frames: [
      {
        rows: [
          'ooooooooooo',
          'cccccccyyyo',
          'ooooooooooo',
        ],
        ox: 3,
        oy: 1,
      },
      {
        rows: [
          'oooooooo',
          'ccccyyyo',
          'oooooooo',
        ],
        ox: 3,
        oy: 1,
      },
      {
        rows: [
          'oooo',
          'yyyo',
          'oooo',
        ],
        ox: 3,
        oy: 1,
      },
    ],
    palette: { o: O, c: '#8a4a30', y: '#f2c879' },
  },
  chocolate: {
    anchor: 'hand',
    // A heart; the bite comes out of the lobe next to the mouth.
    frames: [
      {
        rows: [
          '.oo.oo.',
          'ohcocco',
          'occccco',
          '.occco.',
          '..oco..',
          '...o...',
        ],
        ox: 1,
        oy: 2,
      },
      {
        rows: [
          '....oo.',
          '..o.cco',
          '.ooccco',
          '.occco.',
          '..oco..',
          '...o...',
        ],
        ox: 1,
        oy: 2,
      },
      {
        rows: [
          '.......',
          '.......',
          '...ooo.',
          '..occo.',
          '..oco..',
          '...o...',
        ],
        ox: 1,
        oy: 2,
      },
    ],
    palette: { o: O, c: '#9a5638', h: '#d08a64' },
  },
  candy: {
    anchor: 'hand',
    // Wrapped candy (bowtie), then unwrapped on one side, then a last little piece.
    frames: [
      {
        rows: [
          'oo..ooo..oo',
          'oxoohhpooxo',
          'oxxopppoxxo',
          'oxoopppooxo',
          'oo..ooo..oo',
        ],
        ox: 1,
        oy: 2,
      },
      {
        rows: [
          '.ooo..oo',
          'ohhpooxo',
          'opppoxxo',
          'opppooxo',
          '.ooo..oo',
        ],
        ox: 1,
        oy: 2,
      },
      {
        rows: [
          '.oo.',
          'ohpo',
          'oppo',
          '.oo.',
        ],
        ox: -1,
        oy: 2,
      },
    ],
    palette: { o: O, p: '#ff6fa0', h: '#ffd1e1', x: '#9fd8ff' },
  },
};

/** Treats are only in hand while eating. */
const TREAT_IDS: Record<'pepero' | 'chocolate' | 'candy', AccessoryId> = {
  pepero: 'pepero',
  chocolate: 'chocolate',
  candy: 'candy',
};

/** Special-day outfits, worn all day. */
const SPECIAL_WEAR: Partial<Record<NonNullable<PetCalendar['special']>, AccessoryId[]>> = {
  halloween: ['witchHat', 'pumpkin'],
  christmas: ['santaHat', 'santaSuit'],
};

/** Season wearables; a special-day outfit on the same anchor replaces them. */
const SEASON_WEAR: Partial<Record<PetCalendar['season'], AccessoryId[]>> = {
  winter: ['scarf'],
  summer: ['sunglasses'],
};

/**
 * What the pet wears / holds for `cal` while playing `anim`, back to front order is the
 * caller's (behind ones first). Nothing during `slip` (it is upside down; hats fall off).
 */
export function accessoriesFor(cal: PetCalendar, anim: AnimName): AccessoryId[] {
  if (anim === 'slip') return [];
  const special = (cal.special && SPECIAL_WEAR[cal.special]) || [];
  const taken = new Set(special.map((id) => ACCESSORIES[id].anchor));
  const season = (SEASON_WEAR[cal.season] ?? []).filter((id) => !taken.has(ACCESSORIES[id].anchor));
  const out = [...season, ...special];
  const treat = treatFor(cal.special);
  if (treat && anim === 'eat') out.push(TREAT_IDS[treat]);
  return out;
}

/** Bite stage (accessory frame) after `elapsedMs` of eating: whole, bitten, almost gone. */
export const BITE_MS = 1200;
export function biteFrame(id: AccessoryId, elapsedMs: number): number {
  const n = ACCESSORIES[id].frames.length;
  if (n <= 1 || !(elapsedMs > 0)) return 0;
  return Math.min(n - 1, Math.floor(elapsedMs / BITE_MS));
}

type FillCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>;

/**
 * Draw accessory `id` (frame `frameIndex`, clamped) with its (ox, oy) pixel on `anchor`
 * (canvas px), each art pixel `scale` px. `flip` mirrors it around the anchor. No anchor:
 * nothing is drawn.
 */
export function drawAccessory(
  ctx: FillCtx,
  id: AccessoryId,
  frameIndex: number,
  anchor: Anchor | undefined,
  scale: number,
  flip: boolean,
): void {
  if (!anchor) return;
  const acc = ACCESSORIES[id];
  const f = acc.frames[Math.max(0, Math.min(acc.frames.length - 1, Math.floor(frameIndex) || 0))];
  const w = f.rows.reduce((m, r) => Math.max(m, r.length), 0);
  const left = anchor.x - (flip ? w - f.ox : f.ox) * scale;
  const top = anchor.y - f.oy * scale;
  f.rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      let end = c + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === '.' ? undefined : acc.palette[ch];
      if (color) {
        const col = flip ? w - end : c;
        ctx.fillStyle = color;
        ctx.fillRect(left + col * scale, top + r * scale, (end - c) * scale, scale);
      }
      c = end;
    }
  });
}

/**
 * Draw `ids` on a pack frame drawn with its top-left at canvas px (x, y) at `scale`.
 * `layer` picks the accessories drawn before the body ('behind') or after it ('front');
 * `bite` is the treat frame. Accessories whose anchor the frame lacks are skipped.
 */
export function drawAccessories(
  ctx: FillCtx,
  pack: Pick<CharacterPack, 'size'>,
  frame: PackFrame,
  ids: AccessoryId[],
  x: number,
  y: number,
  scale: number,
  flip: boolean,
  bite: number,
  layer: 'behind' | 'front',
): void {
  for (const id of ids) {
    const acc = ACCESSORIES[id];
    if ((acc.behind === true) !== (layer === 'behind')) continue;
    const a = frame.anchors?.[acc.anchor];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    const ax = x + (flip ? pack.size.w - a.x : a.x) * scale;
    const ay = y + a.y * scale;
    drawAccessory(ctx, id, acc.frames.length > 1 ? bite : 0, { x: ax, y: ay }, scale, flip);
  }
}

/** Rows an accessory sticks out above the head anchor (hats), so the bubble can clear it. */
export function headRise(ids: AccessoryId[]): number {
  let rise = 0;
  for (const id of ids) {
    const acc = ACCESSORIES[id];
    if (acc.anchor !== 'head') continue;
    for (const f of acc.frames) rise = Math.max(rise, f.oy);
  }
  return rise;
}
