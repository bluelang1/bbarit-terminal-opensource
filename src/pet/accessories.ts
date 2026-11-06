// Shared accessories for the desktop pet: season / special-day wearables and the treats it
// eats. Authored once like the character packs (one string per row, one char per pixel,
// '.' transparent) and placed on a pack frame through its anchors (pack.ts AnchorName):
//
//   head  top-center of the head (the row the head outline starts on). Hats sit on it;
//         sunglasses hang a fixed number of rows below it (OCTO puts the eyes 6 rows down).
//   hand  where a held thing is gripped (tentacle tip). Treats are drawn up against it.
//   body  center of the neck line, where the head meets the body / tentacles.
//   front the ground in front of the character where it sets things down (the laptop it
//         types on while Claude works): x the keyboard's near end, y the bottom sprite row.
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
  | 'candy'
  | 'laptop';

/** `rows` drawn with art pixel (ox, oy) on the anchor point. */
export type AccessoryFrame = { rows: string[]; ox: number; oy: number };

export type Accessory = {
  anchor: AnchorName;
  /** One frame for wearables; treats have one per bite stage (whole, bitten, almost gone). */
  frames: AccessoryFrame[];
  palette: Record<string, string>;
  /** Drawn before the body (the character's own pixels cover it), e.g. a carried pumpkin. */
  behind?: boolean;
  /**
   * Which frame is shown: 'bite' (default) the treat bite stage, 'tick' the pack frame index
   * of the animation (tick % frames, e.g. code typed on the laptop screen).
   */
  frameBy?: 'bite' | 'tick';
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

// Laptop on the ground, screen to the far side, keyboard deck reaching back toward the pet.
// The screen shows LAPTOP_CODE being typed, LAPTOP_TYPE_STEP chars per frame, the last
// LAPTOP_LINES lines visible with a cursor. Screen pixels: n background, colors code.
const LAPTOP_BODY = [
  '.....ooooooooo',
  '.....o.......o',
  '.....o.......o',
  '.....o.......o',
  '.....o.......o',
  '.....o.......o',
  '.....ooooooooo',
  '...ossssssssso',
  '..osksksksksSo',
  '.oskskskskkSo.',
  'oSSSSSSSSSSo..',
  'oooooooooooo..',
];
const LAPTOP_SCREEN = { left: 6, top: 1, w: 7, h: 5 };
// At most w - 2 chars per line, so the cursor always fits after it.
const LAPTOP_CODE = ['GGG.Y', '.BBBB', '.PP.G', 'YYY', '..BBP', 'GGGG', '.YY.B'];
const LAPTOP_LINES = 4;
const LAPTOP_TYPE_STEP = 2;

function laptopFrames(): AccessoryFrame[] {
  const total = LAPTOP_CODE.reduce((n, l) => n + l.length, 0);
  const frames: AccessoryFrame[] = [];
  for (let typed = LAPTOP_TYPE_STEP; typed <= total; typed += LAPTOP_TYPE_STEP) {
    // Lines typed so far; the last one partly, with the cursor after it.
    const lines: string[] = [];
    let left = typed;
    for (const l of LAPTOP_CODE) {
      if (left <= 0) break;
      lines.push(l.slice(0, left));
      left -= l.length;
    }
    const shown = lines.slice(-LAPTOP_LINES);
    const rows = LAPTOP_BODY.map((r) => r.split(''));
    const { left: sx, top: sy, w, h } = LAPTOP_SCREEN;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[sy + y][sx + x] = 'n';
    shown.forEach((line, i) => {
      const y = sy + 1 + i;
      for (let x = 0; x < line.length; x++) if (line[x] !== '.') rows[y][sx + 1 + x] = line[x];
      if (i === shown.length - 1) rows[y][sx + 1 + line.length] = 'w';
    });
    frames.push({ rows: rows.map((r) => r.join('')), ox: 0, oy: LAPTOP_BODY.length - 1 });
  }
  return frames;
}

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
    // A short knit wrap snug under the head (one pixel over its sides) with a small end
    // hanging at the front.
    frames: [
      {
        rows: [
          '.oooooooooooooooooo.',
          'orrwwrrwwrrwwrrwwrro',
          'oRRwwRRwwRRwwRRwwRRo',
          '.ooooooooooooorrwoo.',
          '.............oRRwo..',
          '..............ooo...',
        ],
        ox: 10,
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
  laptop: {
    anchor: 'front',
    behind: true,
    frameBy: 'tick',
    frames: laptopFrames(),
    palette: {
      o: O,
      s: '#d6dbe7',
      S: '#9aa1b8',
      k: '#6d7390',
      n: '#22304a',
      w: '#ffffff',
      G: '#7ee08a',
      Y: '#ffd166',
      B: '#7cc7ff',
      P: '#ff8fd0',
    },
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
  // Typing while Claude works: whatever it carries (the pumpkin) is put down for the laptop.
  if (anim === 'busy') return [...out.filter((id) => ACCESSORIES[id].anchor !== 'hand'), 'laptop'];
  const treat = treatFor(cal.special);
  if (treat && anim === 'eat') out.push(TREAT_IDS[treat]);
  return out;
}

/** Bite stage (accessory frame) after `elapsedMs` of eating: whole, bitten, almost gone. */
export const BITE_MS = 1200;
export function biteFrame(id: AccessoryId, elapsedMs: number): number {
  const n = ACCESSORIES[id].frames.length;
  if (n <= 1 || ACCESSORIES[id].frameBy === 'tick' || !(elapsedMs > 0)) return 0;
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
 * `bite` is the treat frame, `tick` the pack frame index (frameBy 'tick' accessories).
 * Accessories whose anchor the frame lacks are skipped.
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
  tick = 0,
): void {
  for (const id of ids) {
    const acc = ACCESSORIES[id];
    if ((acc.behind === true) !== (layer === 'behind')) continue;
    const a = frame.anchors?.[acc.anchor];
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    const ax = x + (flip ? pack.size.w - a.x : a.x) * scale;
    const ay = y + a.y * scale;
    const n = acc.frames.length;
    const fi = n <= 1 ? 0 : acc.frameBy === 'tick' ? ((Math.floor(tick) % n) + n) % n : bite;
    drawAccessory(ctx, id, fi, { x: ax, y: ay }, scale, flip);
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
