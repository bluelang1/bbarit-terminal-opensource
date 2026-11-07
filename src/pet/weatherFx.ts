// Weather effects drawn in code inside the pet window (the body box canvas): rain drops that
// splash where they hit the ground, ripples and kicked-up droplets under the pet's feet, a
// puddle under a resting pet; heavy snowflakes, a thin snow cover and footprints that fade;
// a short faint thunder flash (only on what is drawn, so the window never shows as a box)
// with a small bolt; drifting fog bands; now and then a sun, moon / stars or a cloud.
//
// Pixel style like particles.ts: art rows with OCTO's outline, ART_PX CSS px per art pixel,
// positions snapped to that grid. Cheap: its own pool of at most MAX_FX, stepped on the
// pet's existing tick. Falling things use canvas px; ground marks (ripples, footprints, the
// puddle) use screen x like the ice patch, so they stay put while the pet walks on.

import { ART_PX } from './bubbleArt';
import { drawSprite, type DrawCtx, type Sprite } from './particles';
import { rainy, type PetWeather } from './weather';

export type FxKind = 'drop' | 'splash' | 'hop' | 'ripple' | 'flake' | 'print' | 'sky';

export type FxParticle = {
  kind: FxKind;
  /** Canvas px, except ripple / print: screen px (x) on the ground. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  /** Sprite of the kind (flake size, splash shape, SKY index, ripple size). */
  variant: number;
  /** Flakes: in front of the character (else behind). */
  front: boolean;
  phase?: number;
  landed?: boolean;
};

/** Sky particle variants. */
export const SKY = { sun: 0, moon: 1, star: 2, cloud: 3, nightCloud: 4 } as const;

export type WeatherFx = {
  ps: FxParticle[];
  spawnAcc: number;
  /** Until the next sun / moon / cloud. */
  skyInMs: number;
  /** Thunder: until the next flash; flashAge = ms into the current one, -1 none. */
  flashInMs: number;
  flashAge: number;
  /** Canvas x of the bolt of the current flash. */
  boltX: number;
  /** Walking time until the next footstep, and which foot it is. */
  stepMs: number;
  foot: 1 | -1;
  /** Under a resting pet in rain: screen x of its center, size 0..1. */
  puddle: { x: number; size: number } | null;
  /** Snow lying under the pet, 0..1. */
  snowCover: number;
  /** Fog drift clock. */
  fogMs: number;
};

export type FxInput = {
  weather: PetWeather | null;
  dtMs: number;
  rand: () => number;
  /** Canvas (body box) size, CSS px. */
  w: number;
  h: number;
  /** Screen x of the canvas left edge (the pet window's body box). */
  originX: number;
  /** Canvas x of the character's center (where its feet are). */
  feetX: number;
  /** Walking along the ground (footsteps). */
  walking: boolean;
  /** Standing on the real ground (not pinned in the air, held or falling). */
  grounded: boolean;
};

export const MAX_FX = 40;
export const FX_SPAWN_MS = 80;
export const STEP_EVERY_MS = 340;
export const PRINT_LIFE_MS = 4000;
export const FLASH_MS = 150;
const PRINT_FADE_MS = 3000;
const RIPPLE_LIFE_MS = 700;
const SPLASH_LIFE_MS = 240;
const HOP_LIFE_MS = 700;
const FLAKE_LANDED_MS = 1500;
const FADE_IN_MS = 150;
const SKY_FADE_MS = 600;
const PUDDLE_GROW_MS = 4000;
const PUDDLE_DRY_MS = 2000;
const COVER_GROW_MS = 6000;
const COVER_MELT_MS = 6000;
const GRAVITY = 700;
/** Footsteps land this far left / right of the character's center (outer tentacles, CSS px). */
const FOOT_DX = 26;
/** A puddle elsewhere than under the pet (it moved on) dries before a new one starts. */
const PUDDLE_SAME_SPOT_PX = 8;

const O = '#3b1f47';

type Rate = { tries: number; chance: number; vy: number; vx: number; len: number };

function rainRate(w: PetWeather): Rate {
  if (w.kind === 'drizzle') return { tries: 1, chance: 0.55, vy: 160, vx: -8, len: 2 };
  if (w.heavy) return { tries: 3, chance: 0.85, vy: 300, vx: -30, len: 5 };
  if (w.kind === 'thunder') return { tries: 2, chance: 0.8, vy: 290, vx: -24, len: 4 };
  return { tries: 2, chance: 0.7, vy: 260, vx: -18, len: 4 };
}

export function createWeatherFx(): WeatherFx {
  return {
    ps: [],
    spawnAcc: 0,
    skyInMs: 3000,
    flashInMs: 3000,
    flashAge: -1,
    boltX: 20,
    stepMs: 0,
    foot: 1,
    puddle: null,
    snowCover: 0,
    fogMs: 0,
  };
}

function particle(kind: FxKind, over: Partial<FxParticle>): FxParticle {
  return { kind, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 10_000, variant: 0, front: false, ...over };
}

const FALLING: ReadonlySet<FxKind> = new Set<FxKind>(['drop', 'flake']);

/** Add `p` unless the pool is full; `force` makes room by dropping the oldest falling one. */
function add(fx: WeatherFx, p: FxParticle, force = false): void {
  if (fx.ps.length >= MAX_FX) {
    if (!force) return;
    const i = fx.ps.findIndex((q) => FALLING.has(q.kind));
    if (i < 0) return;
    fx.ps.splice(i, 1);
  }
  fx.ps.push(p);
}

/** Wider than the character (48 art px) once grown, so it shows on both sides. */
function puddleWidthPx(size: number, px: number): number {
  return Math.round(30 + 30 * Math.max(0, Math.min(1, size))) * px;
}

/** Advance the effects by `dtMs` for `weather` (mutates and returns `fx`). */
export function stepWeather(fx: WeatherFx, i: FxInput): WeatherFx {
  const dt = Number.isFinite(i.dtMs) && i.dtMs > 0 ? Math.min(i.dtMs, 250) : 0;
  const s = dt / 1000;
  const w = i.weather;
  const wet = rainy(w);
  const snow = w?.kind === 'snow';
  const px = ART_PX;

  // Move / age what is there.
  const out: FxParticle[] = [];
  for (const p0 of fx.ps) {
    const p = { ...p0, age: p0.age + dt };
    if (p.kind === 'drop') {
      p.x += p.vx * s;
      p.y += p.vy * s;
      const len = (p.variant || 3) * px;
      if (p.y + len / 2 >= i.h - 1) {
        // Hits the ground: a little crown (only where there is ground under the pet).
        if (i.grounded) out.push(particle('splash', { x: p.x, y: i.h - 1, life: SPLASH_LIFE_MS }));
        continue;
      }
    } else if (p.kind === 'flake' && !p.landed) {
      p.phase = (p.phase ?? 0) + s * 3;
      p.x += (p.vx + Math.cos(p.phase) * 6) * s;
      p.y += p.vy * s;
      const half = (FLAKES[p.variant % FLAKES.length].length * px) / 2;
      if (p.y + half >= i.h) {
        if (!i.grounded) continue;
        p.y = i.h - half;
        p.landed = true;
        p.life = p.age + FLAKE_LANDED_MS;
      }
    } else if (p.kind === 'hop') {
      p.vy += GRAVITY * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      if (p.y > i.h) continue;
    } else if (p.kind === 'sky') {
      p.x += p.vx * s;
    }
    if (p.age >= p.life) continue;
    const cx = p.kind === 'ripple' || p.kind === 'print' ? p.x - i.originX : p.x;
    if (cx < -24 || cx > i.w + 24 || p.y < -24) continue;
    out.push(p);
  }
  fx.ps = out.length > MAX_FX ? out.slice(out.length - MAX_FX) : out;

  // Falling drops / flakes, and the odd ripple in the puddle.
  fx.spawnAcc = Math.min(fx.spawnAcc + dt, 4 * FX_SPAWN_MS);
  while (fx.spawnAcc >= FX_SPAWN_MS) {
    fx.spawnAcc -= FX_SPAWN_MS;
    if (w && wet) {
      const r = rainRate(w);
      for (let t = 0; t < r.tries; t++) {
        if (i.rand() >= r.chance) continue;
        add(fx, particle('drop', { x: i.rand() * (i.w + 24) - 4, y: -8, vx: r.vx, vy: r.vy * (0.9 + 0.2 * i.rand()), variant: r.len, life: 5000 }));
      }
      if (fx.puddle && fx.puddle.size > 0.5 && i.rand() < 0.1) {
        const pw = puddleWidthPx(fx.puddle.size, px);
        add(fx, particle('ripple', { x: fx.puddle.x + (i.rand() - 0.5) * pw * 0.6, y: i.h - px, life: RIPPLE_LIFE_MS, variant: 0 }));
      }
    } else if (w && snow) {
      if (i.rand() < (w.heavy ? 0.42 : 0.2)) {
        const big = i.rand();
        const variant = w.heavy ? (big < 0.5 ? 1 : 2) : big < 0.3 ? 0 : 1;
        add(fx, particle('flake', { x: i.rand() * i.w, y: -8, vx: -4 + i.rand() * 8, vy: 22 + i.rand() * 18, variant, phase: i.rand() * Math.PI * 2, front: i.rand() < 0.5, life: 20_000 }));
      }
    }
  }

  // Footsteps: ripples and droplets in rain, footprints in snow.
  if (i.walking && i.grounded && (wet || snow)) {
    fx.stepMs -= dt;
    if (fx.stepMs <= 0) {
      fx.stepMs = STEP_EVERY_MS;
      fx.foot = fx.foot === 1 ? -1 : 1;
      const footX = i.feetX + fx.foot * FOOT_DX;
      if (wet) {
        add(fx, particle('ripple', { x: i.originX + footX, y: i.h - px, life: RIPPLE_LIFE_MS, variant: 1 }), true);
        for (const dir of [-1, 1]) {
          add(fx, particle('hop', { x: footX + dir * 2, y: i.h - 2 * px, vx: dir * (25 + i.rand() * 25), vy: -(110 + i.rand() * 60), life: HOP_LIFE_MS }));
        }
      } else {
        add(fx, particle('print', { x: i.originX + footX, y: i.h - px, life: PRINT_LIFE_MS }), true);
      }
    }
  } else {
    fx.stepMs = 0;
  }

  // Puddle: grows under a resting pet in rain, dries when it walks on or the rain stops.
  const center = i.originX + i.feetX;
  if (fx.puddle) {
    const here = Math.abs(fx.puddle.x - center) <= PUDDLE_SAME_SPOT_PX;
    if (wet && i.grounded && !i.walking && here) {
      fx.puddle.size = Math.min(1, fx.puddle.size + dt / (w?.heavy ? PUDDLE_GROW_MS / 1.6 : PUDDLE_GROW_MS));
    } else {
      fx.puddle.size -= dt / PUDDLE_DRY_MS;
      if (fx.puddle.size <= 0) fx.puddle = null;
    }
  } else if (wet && i.grounded && !i.walking) {
    fx.puddle = { x: center, size: 0 };
  }

  // Snow lying on the ground under the pet.
  fx.snowCover = snow && i.grounded
    ? Math.min(1, fx.snowCover + dt / COVER_GROW_MS)
    : Math.max(0, fx.snowCover - dt / COVER_MELT_MS);

  // Sun / moon and stars on clear days and nights, a passing cloud when cloudy.
  if (w && (w.kind === 'clear' || w.kind === 'cloudy')) {
    fx.skyInMs -= dt;
    if (fx.skyInMs <= 0 && !fx.ps.some((p) => p.kind === 'sky')) {
      if (w.kind === 'cloudy') {
        fx.skyInMs = 12_000 + i.rand() * 8000;
        const vx = 8 + i.rand() * 3;
        add(fx, particle('sky', { x: -14, y: 14 + i.rand() * 20, vx, life: ((i.w + 28) / vx) * 1000, variant: w.night ? SKY.nightCloud : SKY.cloud }), true);
      } else if (w.night) {
        fx.skyInMs = 10_000 + i.rand() * 10_000;
        add(fx, particle('sky', { x: i.w - 24, y: 18, life: 7000, variant: SKY.moon }), true);
        for (let n = 0; n < 2; n++) {
          add(fx, particle('sky', { x: 12 + i.rand() * (i.w - 60), y: 8 + i.rand() * 34, life: 2500 + i.rand() * 2000, variant: SKY.star, phase: i.rand() * 6 }), true);
        }
      } else {
        fx.skyInMs = 18_000 + i.rand() * 12_000;
        add(fx, particle('sky', { x: i.w - 22, y: 20, life: 6000, variant: SKY.sun }), true);
      }
    }
  } else {
    fx.skyInMs = Math.max(fx.skyInMs, 3000);
  }

  // Thunder: a short, faint flash every 6-16 s.
  if (fx.flashAge >= 0) {
    fx.flashAge += dt;
    if (fx.flashAge > FLASH_MS) fx.flashAge = -1;
  }
  if (w?.kind === 'thunder') {
    fx.flashInMs -= dt;
    if (fx.flashInMs <= 0) {
      fx.flashAge = 0;
      fx.flashInMs = 6000 + i.rand() * 10_000;
      fx.boltX = 10 + i.rand() * (i.w - 30);
    }
  } else {
    fx.flashAge = -1;
    fx.flashInMs = 2000 + i.rand() * 4000;
  }

  fx.fogMs += dt;
  return fx;
}

/** Flash strength now: two quick pulses, at most 0.22. */
export function flashAlpha(fx: WeatherFx): number {
  const a = fx.flashAge;
  if (a < 0) return 0;
  if (a < 50) return 0.22;
  if (a < 85) return 0;
  if (a < 130) return 0.12;
  return 0;
}

// ---- art ---------------------------------------------------------------------------

const WATER = { b: '#5a9fec', h: '#d6ecff', w: '#cfe6ff', d: '#3f7fcf' };

const SPLASHES: string[][] = [
  ['h.h', '.b.'],
  ['h...h', '.b.b.'],
];

const RIPPLES: string[][] = [
  ['.ww.', 'w..w', '.ww.'],
  ['..wwww..', 'ww....ww', '..wwww..'],
  ['...wwwwww...', 'www......www', '...wwwwww...'],
];

const FLAKE_PAL = { o: O, w: '#ffffff', b: '#cfe8ff' };
// Bigger than the seasonal flakes (particles.ts): a small one, then 5- and 7-pixel stars.
const FLAKES: string[][] = [
  ['..o..', '.owo.', 'owwwo', '.owo.', '..o..'],
  ['o..o..o', '.owwwo.', '.wwbww.', 'owbwbwo', '.wwbww.', '.owwwo.', 'o..o..o'],
  ['...o...', '..owo..', '.owwwo.', 'owwbwwo', '.owwwo.', '..owo..', '...o...'],
];

const PRINT: Sprite = { rows: ['.ss.', 'ssss'], palette: { s: '#9cb3cf' } };

const SKY_ART: Sprite[] = [
  {
    rows: ['....y....', '.y..y..y.', '...ooo...', '..oyyyo..', 'yyoyhyoyy', '..oyyyo..', '...ooo...', '.y..y..y.', '....y....'],
    palette: { o: O, y: '#ffd23f', h: '#fff6c2' },
  },
  {
    rows: ['..oooo.', '.oyyo..', 'oyyo...', 'oyyo...', 'oyyo...', '.oyyo..', '..oooo.'],
    palette: { o: O, y: '#fff1a8' },
  },
  { rows: ['..h..', '..y..', 'hyyyh', '..y..', '..h..'], palette: { y: '#fff1a8', h: 'rgba(255, 241, 168, 0.5)' } },
  {
    rows: ['....oooo....', '..oowwwwo...', '.owwwwwwwoo.', 'owwwwwwwwwwo', 'owswwwwswwso', '.oooooooooo.'],
    palette: { o: O, w: '#ffffff', s: '#dfe6f0' },
  },
  {
    rows: ['....oooo....', '..oowwwwo...', '.owwwwwwwoo.', 'owwwwwwwwwwo', 'owswwwwswwso', '.oooooooooo.'],
    palette: { o: O, w: '#b9c3d6', s: '#9aa5bc' },
  },
];

const BOLT: Sprite = {
  rows: ['..ooo', '.oyo.', '.oyo.', 'oyyoo', '.oyyo', '..oyo', '.oyo.', '.oo..', '.o...'],
  palette: { o: O, y: '#fff1a8' },
};

// Light blue-gray: reads as mist on dark desktops and still shows on light ones.
const FOG_COLOR = '#d3dbe6';

function snap(v: number, px: number): number {
  return Math.round(v / px) * px;
}

function centered(ctx: DrawCtx, sp: Sprite, cx: number, cy: number, px: number): void {
  const w = sp.rows[0].length * px;
  const h = sp.rows.length * px;
  drawSprite(ctx, sp, snap(cx - w / 2, px), snap(cy - h / 2, px), px);
}

/** Sprite bottom-centered on (cx, bottom). */
function onGround(ctx: DrawCtx, sp: Sprite, cx: number, bottom: number, px: number): void {
  const w = sp.rows[0].length * px;
  drawSprite(ctx, sp, snap(cx - w / 2, px), bottom - sp.rows.length * px, px);
}

function fade(p: FxParticle, inMs: number, outMs: number): number {
  return Math.max(0, Math.min(1, p.age / inMs, (p.life - p.age) / outMs));
}

function fogBand(ctx: DrawCtx, w: number, yc: number, thick: number, alpha: number, t: number, seed: number, dir: number, px: number): void {
  ctx.fillStyle = FOG_COLOR;
  for (let x = 2 * px; x < w - 2 * px; x += px) {
    const edge = Math.max(0, Math.min(1, Math.min(x, w - x) / 34));
    // Three alpha steps (pixel-art dithering, not a smooth gradient).
    const n1 = Math.sin(x * 0.05 + dir * t * 0.00035 + seed);
    const n2 = Math.sin(x * 0.13 - dir * t * 0.0006 + seed * 1.7);
    // Thicker and thinner puffs along the band; three alpha steps (pixel-art dithering).
    const body = edge * (0.55 + 0.45 * Math.sin(x * 0.031 + dir * t * 0.00025 + seed * 3));
    const level = body >= 0.8 ? 1 : body >= 0.5 ? 0.66 : body >= 0.22 ? 0.33 : 0;
    if (level === 0) continue;
    const half = (thick / 2) * (0.45 + 0.55 * body);
    const top = snap(yc - half * (0.7 + 0.3 * n1), px);
    const bottom = snap(yc + half * (0.7 + 0.3 * n2), px);
    if (bottom <= top) continue;
    ctx.globalAlpha = alpha * level;
    ctx.fillRect(x, top, px, bottom - top);
    // A fainter fringe above and below so the band has no hard edge.
    ctx.globalAlpha = alpha * level * 0.4;
    ctx.fillRect(x, top - px, px, px);
    ctx.fillRect(x, bottom, px, px);
  }
}

function drawPuddle(ctx: DrawCtx, cx: number, h: number, size: number, px: number): void {
  if (!(size > 0)) return;
  const full = puddleWidthPx(size, px);
  const rows = [0.7, 1, 0.86];
  const a = Math.min(1, size * 1.4);
  rows.forEach((k, r) => {
    const rw = snap(full * k, px);
    const left = snap(cx - rw / 2, px);
    const y = h - (rows.length - r) * px;
    ctx.globalAlpha = 0.6 * a;
    ctx.fillStyle = r === 2 ? WATER.d : WATER.b;
    ctx.fillRect(left, y, rw, px);
    if (r === 0) {
      // A short glint on the near-left of the surface.
      ctx.globalAlpha = 0.7 * a;
      ctx.fillStyle = WATER.h;
      ctx.fillRect(left + 2 * px, y, Math.min(4 * px, rw / 3), px);
    }
  });
}

function drawSnowCover(ctx: DrawCtx, w: number, h: number, cover: number, px: number): void {
  if (!(cover > 0)) return;
  ctx.globalAlpha = 0.35 + 0.6 * Math.min(1, cover);
  const cols = Math.floor(w / px);
  for (let c = 0; c < cols; c++) {
    const x = c * px;
    const edge = Math.min(x, w - x) / 36;
    // Ordered dither at the ends so the cover has no hard edge.
    if (edge < 1 && ((c * 7) % 5) / 5 >= edge) continue;
    // Bottom row with a little blue shade, a soft bumpy row above it.
    ctx.fillStyle = c % 11 === 5 ? '#d5e4f5' : '#f5f9ff';
    ctx.fillRect(x, h - px, px, px);
    if (Math.sin(c * 0.55) + Math.sin(c * 0.21) > -0.6) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, h - 2 * px, px, px);
    }
  }
}

/**
 * Everything behind the character: sky, ground (snow cover, puddle, footprints), the rain
 * (the umbrella covers it), the back half of the flakes and the far fog band.
 */
export function drawWeatherBack(
  ctx: DrawCtx,
  fx: WeatherFx,
  weather: PetWeather | null,
  originX: number,
  w: number,
  h: number,
  px: number = ART_PX,
): void {
  for (const p of fx.ps) {
    if (p.kind !== 'sky') continue;
    const twinkle = p.variant === SKY.star ? 0.55 + 0.45 * Math.abs(Math.sin((p.phase ?? 0) + p.age / 300)) : 1;
    ctx.globalAlpha = fade(p, SKY_FADE_MS, SKY_FADE_MS) * twinkle;
    centered(ctx, SKY_ART[p.variant] ?? SKY_ART[0], p.x, p.y, px);
  }
  drawSnowCover(ctx, w, h, fx.snowCover, px);
  if (fx.puddle) drawPuddle(ctx, fx.puddle.x - originX, h, fx.puddle.size, px);
  for (const p of fx.ps) {
    switch (p.kind) {
      case 'print':
        ctx.globalAlpha = 0.85 * Math.min(1, (p.life - p.age) / PRINT_FADE_MS);
        onGround(ctx, PRINT, p.x - originX, h - (fx.snowCover > 0.3 ? px : 0), px);
        break;
      case 'drop': {
        const len = (p.variant || 3) * px;
        const x = snap(p.x, px);
        const y = snap(p.y - len / 2, px);
        ctx.globalAlpha = Math.min(0.9, fade(p, FADE_IN_MS, 1));
        ctx.fillStyle = WATER.b;
        ctx.fillRect(x, y + px, px, len - px);
        ctx.fillStyle = WATER.h;
        ctx.fillRect(x, y, px, px);
        break;
      }
      case 'flake':
        if (!p.front) drawFlake(ctx, p, px);
        break;
      default:
        break;
    }
  }
  if (weather?.kind === 'fog') fogBand(ctx, w, h * 0.42, 24, 0.24, fx.fogMs, 0, 1, px);
  ctx.globalAlpha = 1;
}

function drawFlake(ctx: DrawCtx, p: FxParticle, px: number): void {
  ctx.globalAlpha = fade(p, FADE_IN_MS, p.landed ? FLAKE_LANDED_MS : 400);
  centered(ctx, { rows: FLAKES[p.variant % FLAKES.length], palette: FLAKE_PAL }, p.x, p.y, px);
}

/**
 * In front of the character: water at its feet (ripples, splashes, droplets), the front
 * flakes, the near fog band and the thunder bolt.
 */
export function drawWeatherFront(
  ctx: DrawCtx,
  fx: WeatherFx,
  weather: PetWeather | null,
  originX: number,
  w: number,
  h: number,
  px: number = ART_PX,
): void {
  // Water on the ground around the feet (ripples, splashes, kicked-up droplets) shows over
  // the tentacle tips, faint enough to read as water.
  for (const p of fx.ps) {
    switch (p.kind) {
      case 'ripple': {
        const k = p.age / p.life;
        const rows = RIPPLES[Math.min(RIPPLES.length - 1, p.variant + Math.floor(k * 2))];
        ctx.globalAlpha = 0.75 * (1 - k);
        onGround(ctx, { rows, palette: WATER }, p.x - originX, h, px);
        break;
      }
      case 'splash':
        ctx.globalAlpha = 0.9 * Math.max(0, 1 - p.age / p.life);
        onGround(ctx, { rows: SPLASHES[p.age < p.life / 2 ? 0 : 1], palette: WATER }, p.x, h, px);
        break;
      case 'hop':
        ctx.globalAlpha = 0.9 * fade(p, 1, 200);
        ctx.fillStyle = WATER.b;
        ctx.fillRect(snap(p.x, px), snap(p.y, px), px, px);
        break;
      case 'flake':
        if (p.front) drawFlake(ctx, p, px);
        break;
      default:
        break;
    }
  }
  if (weather?.kind === 'fog') fogBand(ctx, w, h - 24, 16, 0.36, fx.fogMs, 2.1, -1, px);
  if (flashAlpha(fx) > 0) {
    ctx.globalAlpha = 1;
    drawSprite(ctx, BOLT, snap(fx.boltX, px), 4 * px, px);
  }
  ctx.globalAlpha = 1;
}

type FlashCtx = DrawCtx & Pick<CanvasRenderingContext2D, 'globalCompositeOperation'>;

/** Thunder flash: lights up only what is already drawn (never the window's empty box). */
export function drawWeatherFlash(ctx: FlashCtx, fx: WeatherFx, w: number, h: number): void {
  const a = flashAlpha(fx);
  if (!(a > 0)) return;
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = a;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/** Anything to animate (keeps the pet's frame rate up while it sleeps in the rain). */
export function weatherLive(fx: WeatherFx, weather: PetWeather | null): boolean {
  return fx.ps.length > 0 || fx.puddle !== null || fx.snowCover > 0 || fx.flashAge >= 0 || weather?.kind === 'fog';
}
