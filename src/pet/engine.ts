// Desktop pet behavior engine. Pure: the pet page feeds it time, work areas,
// drag state and activity each tick and moves the window to (x, y).
//
// Coordinates are logical px; (x, y) is the pet window's top-left.

import type { AnimName } from './pack';

export const PET_W = 160;
export const PET_H = 160;
export const WALK_PX_PER_S = 30;
export const SLEEP_AFTER_MS = 5 * 60_000;
/** Fall acceleration, px/s². */
export const FALL_G = 2000;
/** A drop this close above the ground falls to it instead of pinning. */
export const LAND_SNAP_PX = 40;

const WALK_MS: [number, number] = [2000, 8000];
const REST_MS: [number, number] = [3000, 10_000];
/** Longest physics step; a long stall (sleep/wake) must not teleport the pet. */
const MAX_PHYSICS_DT_MS = 250;
const FALLBACK_AREA: WorkArea = { x: 0, y: 0, w: 1280, h: 800 };

export type WorkArea = { x: number; y: number; w: number; h: number };

export type PetState = {
  anim: AnimName;
  x: number;
  y: number;
  dir: 1 | -1;
  mode: 'walk' | 'stay';
  pinned: boolean;
  /** Time since the last owner input / activity. */
  idleMs: number;
  /** Time left in the current walk or rest action. */
  actionMs: number;
  /** Fall speed, px/s. */
  vy: number;
};

export type PetInput = {
  dtMs: number;
  areas: WorkArea[];
  rand: () => number;
  /** Window top-left while the owner drags the pet, else null. */
  dragging: { x: number; y: number } | null;
  /** Owner input (or, later, Claude activity): resets the sleep timer. */
  activity: boolean;
};

export function groundY(area: WorkArea): number {
  return area.y + area.h - PET_H;
}

function floorY(area: WorkArea): number {
  return Math.max(area.y, groundY(area));
}

function maxX(area: WorkArea): number {
  return Math.max(area.x, area.x + area.w - PET_W);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function usable(areas: WorkArea[]): WorkArea[] {
  const ok = areas.filter((a) => [a.x, a.y, a.w, a.h].every(Number.isFinite) && a.w > 0 && a.h > 0);
  return ok.length > 0 ? ok : [FALLBACK_AREA];
}

function distanceTo(a: WorkArea, px: number, py: number): number {
  const dx = px < a.x ? a.x - px : px > a.x + a.w ? px - (a.x + a.w) : 0;
  const dy = py < a.y ? a.y - py : py > a.y + a.h ? py - (a.y + a.h) : 0;
  return Math.hypot(dx, dy);
}

/** The area holding the pet's center, else the nearest one. */
function areaFor(x: number, y: number, areas: WorkArea[]): WorkArea {
  const cx = x + PET_W / 2;
  const cy = y + PET_H / 2;
  let best = areas[0];
  let bestD = Infinity;
  for (const a of areas) {
    const d = distanceTo(a, cx, cy);
    if (d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}

function overlapsAny(x: number, y: number, areas: WorkArea[]): boolean {
  return areas.some((a) => x < a.x + a.w && x + PET_W > a.x && y < a.y + a.h && y + PET_H > a.y);
}

/** Pull the pet window fully inside a work area (the one it is on, else the nearest). */
export function clampToWorkArea(x: number, y: number, areas: WorkArea[]): { x: number; y: number; area: WorkArea } {
  const list = usable(areas);
  const fx = Number.isFinite(x) ? x : list[0].x;
  const fy = Number.isFinite(y) ? y : floorY(list[0]);
  const area = areaFor(fx, fy, list);
  return { x: clamp(fx, area.x, maxX(area)), y: clamp(fy, area.y, floorY(area)), area };
}

function span(range: [number, number], rand: () => number): number {
  return range[0] + clamp(rand(), 0, 1) * (range[1] - range[0]);
}

function rest(s: PetState, rand: () => number): PetState {
  return { ...s, anim: rand() < 0.5 ? 'idle' : 'sit', actionMs: span(REST_MS, rand) };
}

function startWalk(s: PetState, rand: () => number): PetState {
  const dir: 1 | -1 = rand() < 0.3 ? (s.dir === 1 ? -1 : 1) : s.dir;
  return { ...s, anim: 'walk', dir, actionMs: span(WALK_MS, rand) };
}

export function initialState(areas: WorkArea[], saved?: Partial<PetState>): PetState {
  const list = usable(areas);
  const home = list[0];
  const pinned = saved?.pinned === true;
  const p = clampToWorkArea(saved?.x ?? home.x + (home.w - PET_W) / 2, saved?.y ?? floorY(home), list);
  return {
    anim: 'idle',
    x: p.x,
    y: pinned ? p.y : floorY(p.area),
    dir: saved?.dir === -1 ? -1 : 1,
    mode: saved?.mode === 'stay' ? 'stay' : 'walk',
    pinned,
    idleMs: 0,
    actionMs: 0,
    vy: 0,
  };
}

export function step(s: PetState, i: PetInput): PetState {
  const dt = Number.isFinite(i.dtMs) && i.dtMs > 0 ? i.dtMs : 0;
  const pdt = Math.min(dt, MAX_PHYSICS_DT_MS) / 1000;
  const areas = usable(i.areas);

  // 1. Being dragged: follow the pointer, wide awake.
  if (i.dragging) {
    return { ...s, anim: 'held', x: i.dragging.x, y: i.dragging.y, pinned: false, idleMs: 0, actionMs: 0, vy: 0 };
  }

  // 2. Just released.
  if (s.anim === 'held') {
    const p = clampToWorkArea(s.x, s.y, areas);
    const dropped = { ...s, idleMs: 0, vy: 0 };
    if (!overlapsAny(s.x, s.y, areas) || p.y >= floorY(p.area) - LAND_SNAP_PX) {
      return { ...dropped, anim: 'fall', x: p.x, y: p.y, pinned: false };
    }
    return rest({ ...dropped, x: p.x, y: p.y, pinned: true }, i.rand);
  }

  // Keep the pet on a visible work area (monitor unplugged, resolution change).
  const p = clampToWorkArea(s.x, s.y, areas);
  const ground = floorY(p.area);
  let n: PetState = { ...s, x: p.x, y: p.y };

  // 3. Falling.
  if (n.anim === 'fall' || (!n.pinned && n.y < ground)) {
    const vy = (n.anim === 'fall' ? n.vy : 0) + FALL_G * pdt;
    const y = n.y + vy * pdt;
    if (y >= ground) return rest({ ...n, anim: 'idle', y: ground, vy: 0, idleMs: n.idleMs + dt }, () => 0);
    return { ...n, anim: 'fall', y, vy, idleMs: n.idleMs + dt };
  }
  n.vy = 0;
  if (!n.pinned) n.y = ground;

  // 4. Sleep / wake.
  if (i.activity) {
    n.idleMs = 0;
    if (n.anim === 'sleep') return rest({ ...n, anim: 'idle' }, () => 0);
  } else {
    n.idleMs += dt;
  }
  if (n.idleMs >= SLEEP_AFTER_MS) return { ...n, anim: 'sleep', actionMs: 0 };
  if (n.anim === 'sleep') n = rest(n, i.rand);

  // 5. Idle life.
  const canWalk = !n.pinned && n.mode === 'walk';
  if (n.anim === 'walk' && !canWalk) n = rest(n, i.rand);
  n.actionMs -= dt;

  if (n.anim === 'walk') {
    const lo = p.area.x;
    const hi = maxX(p.area);
    let x = n.x + n.dir * WALK_PX_PER_S * pdt;
    let dir = n.dir;
    if (x >= hi) {
      x = hi;
      dir = -1;
    } else if (x <= lo) {
      x = lo;
      dir = 1;
    }
    n = { ...n, x, dir };
    if (n.actionMs <= 0) n = rest(n, i.rand);
    return n;
  }

  if (n.actionMs <= 0) n = canWalk ? startWalk(n, i.rand) : rest(n, i.rand);
  else if (n.anim !== 'idle' && n.anim !== 'sit') n = rest(n, i.rand);
  return n;
}
