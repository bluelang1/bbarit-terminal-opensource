// Season particles drawn in code inside the pet window (the body box canvas): cherry petals
// in spring, heat shimmer in summer, maple / ginkgo leaves in autumn, snowflakes and breath
// puffs in winter, plus dizzy stars after a slip and the ice patch it slips on.
//
// Pixel style like the speech bubble: art rows with OCTO's outline, ART_PX (2) CSS px per
// art pixel, positions snapped to that grid. Cheap: at most MAX_PARTICLES alive, stepped on
// the pet's existing tick. Positions are canvas CSS px (x, y = the particle's center).

import { ART_PX } from './bubbleArt';
import type { PetCalendar } from './calendar';

export type ParticleKind = 'petal' | 'leaf' | 'snow' | 'puff' | 'shimmer' | 'star';

export type Particle = {
  kind: ParticleKind;
  x: number;
  y: number;
  /** Velocity, CSS px per second. */
  vx: number;
  vy: number;
  age: number;
  /** Removed once age reaches it (ms). Landing shortens it to a short fade. */
  life: number;
  /** Which sprite of the kind (petal shape, maple / ginkgo, flake size). */
  variant: number;
  /** Sway / flutter phase (radians). */
  phase: number;
  /** Drawn in front of the character (else behind it). */
  front: boolean;
  /** Lying on the ground (petals, leaves, snow) and fading out. */
  landed: boolean;
};

export const MAX_PARTICLES = 12;
/** The page asks spawnFor for one new particle this often. */
export const SPAWN_EVERY_MS = 250;
/** Chance per spawn call, by kind. */
const CHANCE: Record<Exclude<ParticleKind, 'star'>, number> = {
  petal: 0.2,
  leaf: 0.13,
  snow: 0.12,
  puff: 0.08,
  shimmer: 0.05,
};
const FADE_IN_MS = 150;
const FADE_OUT_MS = 400;
const LANDED_MS = 1200;

const O = '#3b1f47';

type Sprite = { rows: string[]; palette: Record<string, string> };

const PETAL_PAL = { o: O, p: '#ffb3c8', h: '#ffe4ec', d: '#f07fa0' };
const PETALS: string[][] = [
  ['.o.o.', 'ohoho', 'ophpo', 'oppdo', '.ooo.'],
  ['.oo..', 'ohpo.', 'opppo', '.opdo', '..oo.'],
  ['.ooo.', 'ohppo', '.ooo.'],
];

const MAPLE_PAL = { o: O, r: '#f0603c', d: '#c23b2a', y: '#ffa94d' };
const MAPLE: string[][] = [
  [
    '....o....',
    '...oyo...',
    'oo.oro.oo',
    'oyrrrrryo',
    '.orrrrro.',
    'oorrrrroo',
    'oyrrdrryo',
    '.oo.d.oo.',
    '....d....',
    '....o....',
  ],
  ['..o..o...', '.oyoory..', '.orrrrdo.', 'oyrrrrrro', '.orrrrdo.', 'ooyrrdoo.', '..oodo...', '....do...', '.....o...'],
];

const GINKGO_PAL = { o: O, y: '#ffd23f', h: '#fff1a8', d: '#e0a800', s: '#a8781a' };
const GINKGO: string[][] = [
  ['.ooooooooo.', 'oyhyhyyyyyo', 'oyyyyyyyydo', '.oyyyyyydo.', '..ooyyydo..', '....oyo....', '.....s.....', '.....o.....'],
  ['..ooooo..', '.ohyyydo.', '..oyydo..', '...oyo...', '....s....', '....o....'],
];

const SNOW_PAL = { o: O, w: '#ffffff', b: '#cfe8ff' };
const SNOW: string[][] = [
  ['.o.', 'owo', '.o.'],
  ['..o..', '.owo.', 'owbwo', '.owo.', '..o..'],
];

const PUFF_PAL = { o: O, w: '#ffffff', s: '#dfe6f0' };
const PUFFS: string[][] = [
  ['.oo.', 'owwo', '.oo.'],
  ['.ooo.', 'owwwo', 'owwso', '.ooo.'],
  ['..oo..', '.owwoo', 'owwwwo', 'owwsso', '.oooo.'],
];

const SHIMMER_PAL = { w: 'rgba(255, 178, 64, 0.7)' };
const SHIMMERS: string[][] = [
  ['.w', 'w.', 'w.', '.w', '.w', 'w.'],
  ['w.', '.w', '.w', 'w.', 'w.', '.w'],
];

const STAR_PAL = { o: O, y: '#ffd23f', h: '#fff6c2' };
const STARS: string[][] = [
  ['...o...', '..oyo..', 'ooyhyoo', 'oyyyyyo', '.oyyyo.', 'oyo.oyo', 'oo...oo'],
  ['..o..', '.oyo.', 'oyhyo', '.oyo.', '..o..'],
];

/** Ice patch on the ground (winter slip), drawn behind the character. */
export const ICE_ART: Sprite = {
  rows: [
    '...oooooooooooooooooooooo...',
    '.ooiwwwiiiiiiiwwiiiiiiiIIoo.',
    'oiiiiiiwwiiiiiiiiiwiiiIIIIIo',
    '.ooIIiiiiiiiiiiiiiiiIIIIIoo.',
    '...oooooooooooooooooooooo...',
  ],
  palette: { o: O, i: '#bfe9ff', w: '#ffffff', I: '#8ccbea' },
};

function spriteFor(p: Particle): Sprite {
  // Edge-on for a short part of each flutter turn.
  const flutter = Math.abs(Math.cos(p.phase)) < 0.35 ? 1 : 0;
  switch (p.kind) {
    case 'petal':
      // Face-on (two shapes) or edge-on while it flutters; lies edge-on once landed.
      return { rows: PETALS[p.landed || flutter === 1 ? 2 : p.variant % 2], palette: PETAL_PAL };
    case 'leaf': {
      const set = p.variant % 2 === 0 ? MAPLE : GINKGO;
      return { rows: set[p.landed ? 0 : flutter], palette: p.variant % 2 === 0 ? MAPLE_PAL : GINKGO_PAL };
    }
    case 'snow':
      return { rows: SNOW[p.variant % 2], palette: SNOW_PAL };
    case 'puff':
      return { rows: PUFFS[Math.min(PUFFS.length - 1, Math.floor((p.age / p.life) * PUFFS.length))], palette: PUFF_PAL };
    case 'shimmer':
      return { rows: SHIMMERS[Math.floor(p.age / 200) % 2], palette: SHIMMER_PAL };
    case 'star':
      // Big when passing in front, small at the back of the orbit.
      return { rows: STARS[Math.sin(p.phase) >= 0 ? 0 : 1], palette: STAR_PAL };
  }
}

function base(kind: ParticleKind, rand: () => number): Particle {
  return { kind, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 12_000, variant: 0, phase: rand() * Math.PI * 2, front: rand() < 0.5, landed: false };
}

/** Where a breath puff starts (canvas px, just beside the head) and which way it drifts. */
export type BreathOrigin = { x: number; y: number; dir: 1 | -1 };

/**
 * Maybe one new season particle in a `w` x `h` box (call every SPAWN_EVERY_MS). Winter
 * breath puffs need `mouth` (where the character breathes out, canvas px).
 */
export function spawnFor(
  cal: PetCalendar,
  rand: () => number,
  w: number,
  h: number,
  mouth: BreathOrigin | null = null,
): Particle | null {
  const roll = rand();
  if (cal.season === 'spring') {
    if (roll >= CHANCE.petal) return null;
    const p = base('petal', rand);
    return { ...p, x: rand() * w, y: -6, vx: -6 + rand() * 12, vy: 18 + rand() * 12, variant: Math.floor(rand() * 2) };
  }
  if (cal.season === 'autumn') {
    if (roll >= CHANCE.leaf) return null;
    const p = base('leaf', rand);
    return { ...p, x: rand() * w, y: -10, vx: -5 + rand() * 10, vy: 14 + rand() * 10, variant: Math.floor(rand() * 2) };
  }
  if (cal.season === 'winter') {
    if (mouth && roll < CHANCE.puff) {
      const p = base('puff', rand);
      return { ...p, x: mouth.x, y: mouth.y, vx: mouth.dir * 12, vy: -10, life: 1300, front: true };
    }
    if (roll >= CHANCE.puff + CHANCE.snow) return null;
    const p = base('snow', rand);
    return { ...p, x: rand() * w, y: -6, vx: -3 + rand() * 6, vy: 16 + rand() * 10, variant: rand() < 0.35 ? 1 : 0 };
  }
  if (roll >= CHANCE.shimmer) return null;
  const p = base('shimmer', rand);
  return { ...p, x: 8 + rand() * (w - 16), y: h - 8, vy: -10, life: 1600, front: rand() < 0.3 };
}

/** Dizzy stars orbit an ellipse this wide / tall (CSS px) around their center. */
const ORBIT_RX = 26;
const ORBIT_RY = 7;

/**
 * `n` dizzy stars circling (cx, cy) for `lifeMs` after a slip. A star's x / y is its orbit
 * center; phase is its angle (front half of the orbit is drawn in front of the character).
 */
export function spawnDizzy(cx: number, cy: number, lifeMs: number, n = 3): Particle[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'star' as const,
    x: cx,
    y: cy,
    vx: 0,
    vy: 0,
    age: 0,
    life: lifeMs,
    variant: i,
    phase: (i * 2 * Math.PI) / n,
    front: true,
    landed: false,
  }));
}

/** Where a particle is drawn: stars on their orbit, everything else at (x, y). */
function drawPos(p: Particle): { x: number; y: number; front: boolean } {
  if (p.kind !== 'star') return { x: p.x, y: p.y, front: p.front };
  return { x: p.x + Math.cos(p.phase) * ORBIT_RX, y: p.y + Math.sin(p.phase) * ORBIT_RY, front: Math.sin(p.phase) >= 0 };
}

function halfHeight(p: Particle): number {
  return (spriteFor(p).rows.length * ART_PX) / 2;
}

/** Advance `ps` by `dtMs`; drops expired particles and those that left the box; keeps the newest MAX_PARTICLES. */
export function stepParticles(ps: Particle[], dtMs: number, w: number, h: number): Particle[] {
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(dtMs, 250) : 0;
  const s = dt / 1000;
  const out: Particle[] = [];
  for (const p0 of ps) {
    const p = { ...p0, age: p0.age + dt };
    if (p.kind === 'star') {
      // Orbits its center; never leaves the box on its own.
      p.phase += s * 5;
      if (p.age < p.life) out.push(p);
      continue;
    }
    if (!p.landed) {
      const sway = p.kind === 'petal' ? 14 : p.kind === 'leaf' ? 18 : p.kind === 'snow' ? 6 : 0;
      p.phase += s * (p.kind === 'leaf' ? 2.2 : 3);
      p.x += (p.vx + Math.cos(p.phase) * sway) * s;
      p.y += p.vy * s;
      const falls = p.kind === 'petal' || p.kind === 'leaf' || p.kind === 'snow';
      if (falls && p.y + halfHeight(p) >= h) {
        p.y = h - halfHeight(p);
        p.landed = true;
        p.life = p.age + LANDED_MS;
      }
    }
    if (p.age >= p.life) continue;
    if (p.x < -12 || p.x > w + 12 || p.y > h + 12 || p.y < -16) continue;
    out.push(p);
  }
  return out.length > MAX_PARTICLES ? out.slice(out.length - MAX_PARTICLES) : out;
}

/** Opacity from fade in / out. */
export function particleAlpha(p: Particle): number {
  const fadeOut = p.landed ? LANDED_MS : FADE_OUT_MS;
  return Math.max(0, Math.min(1, p.age / FADE_IN_MS, (p.life - p.age) / fadeOut));
}

type DrawCtx = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect' | 'globalAlpha'>;

function drawSprite(ctx: DrawCtx, sp: Sprite, left: number, top: number, px: number): void {
  sp.rows.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      const ch = row[c];
      let end = c + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === '.' ? undefined : sp.palette[ch];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(left + c * px, top + r * px, (end - c) * px, px);
      }
      c = end;
    }
  });
}

/**
 * Draw particles (`front`: only those in front of / behind the character; omitted: all),
 * each art pixel `px` CSS px, snapped to that grid.
 */
export function drawParticles(ctx: DrawCtx, ps: Particle[], px: number = ART_PX, front?: boolean): void {
  for (const p of ps) {
    const at = drawPos(p);
    if (front !== undefined && at.front !== front) continue;
    const sp = spriteFor(p);
    const w = sp.rows[0].length * px;
    const hh = sp.rows.length * px;
    ctx.globalAlpha = particleAlpha(p);
    drawSprite(ctx, sp, Math.round((at.x - w / 2) / px) * px, Math.round((at.y - hh / 2) / px) * px, px);
  }
  ctx.globalAlpha = 1;
}

/** Ice patch centered at canvas x `cx`, lying on `groundY`, at opacity `alpha`. */
export function drawIce(ctx: DrawCtx, cx: number, groundY: number, alpha: number, px: number = ART_PX): void {
  if (!(alpha > 0)) return;
  const w = ICE_ART.rows[0].length * px;
  const hh = ICE_ART.rows.length * px;
  ctx.globalAlpha = Math.min(1, alpha);
  drawSprite(ctx, ICE_ART, Math.round((cx - w / 2) / px) * px, groundY - hh, px);
  ctx.globalAlpha = 1;
}
