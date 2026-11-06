import { describe, expect, it, vi } from 'vitest';
import type { PetCalendar } from './calendar';
import {
  MAX_PARTICLES,
  drawIce,
  drawParticles,
  particleAlpha,
  spawnDizzy,
  spawnFor,
  stepParticles,
  type Particle,
} from './particles';

const W = 160;
const H = 160;
const cal = (season: PetCalendar['season'], special: PetCalendar['special'] = null): PetCalendar => ({ season, special });
/** rand that returns `first` once, then `rest`. */
function rolls(first: number, rest = 0.5): () => number {
  let n = 0;
  return () => (n++ === 0 ? first : rest);
}
function spyCtx() {
  return { fillStyle: '', globalAlpha: 1, fillRect: vi.fn() };
}
function particle(over: Partial<Particle> = {}): Particle {
  return { kind: 'petal', x: 80, y: 20, vx: 0, vy: 20, age: 500, life: 12_000, variant: 0, phase: 0, front: true, landed: false, ...over };
}

describe('spawnFor', () => {
  it('spawns the season kind on a low roll, nothing on a high one', () => {
    expect(spawnFor(cal('spring'), rolls(0), W, H)?.kind).toBe('petal');
    expect(spawnFor(cal('autumn'), rolls(0), W, H)?.kind).toBe('leaf');
    expect(spawnFor(cal('summer'), rolls(0), W, H)?.kind).toBe('shimmer');
    expect(spawnFor(cal('winter'), rolls(0.1), W, H)?.kind).toBe('snow');
    for (const s of ['spring', 'summer', 'autumn', 'winter'] as const) expect(spawnFor(cal(s), rolls(0.99), W, H)).toBeNull();
  });

  it('winter breath puffs need a mouth and start there', () => {
    const mouth = { x: 120, y: 120, dir: 1 as const };
    const puff = spawnFor(cal('winter'), rolls(0), W, H, mouth);
    expect(puff?.kind).toBe('puff');
    expect(puff?.x).toBe(120);
    expect(puff?.vx).toBeGreaterThan(0);
    expect(spawnFor(cal('winter'), rolls(0), W, H, null)?.kind).toBe('snow');
  });

  it('season particles keep running on special days', () => {
    expect(spawnFor(cal('autumn', 'pepero'), rolls(0), W, H)?.kind).toBe('leaf');
    expect(spawnFor(cal('winter', 'christmas'), rolls(0.1), W, H)?.kind).toBe('snow');
  });

  it('falling kinds start at the top inside the box width', () => {
    for (const s of ['spring', 'autumn'] as const) {
      const p = spawnFor(cal(s), () => 0.01, W, H)!;
      expect(p.y).toBeLessThan(0);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(W);
    }
  });
});

describe('stepParticles', () => {
  it('moves falling particles down', () => {
    const [p] = stepParticles([particle({ y: 20, vy: 20 })], 200, W, H);
    expect(p.y).toBeCloseTo(24, 5);
    expect(p.age).toBe(700);
  });

  it('caps one step at 250 ms (a stalled tick does not teleport)', () => {
    const [p] = stepParticles([particle({ y: 20, vy: 20 })], 5000, W, H);
    expect(p.y).toBeCloseTo(25, 5);
  });

  it('keeps at most MAX_PARTICLES, dropping the oldest', () => {
    const ps = Array.from({ length: MAX_PARTICLES + 5 }, (_, i) => particle({ x: 10 + i }));
    const out = stepParticles(ps, 16, W, H);
    expect(out).toHaveLength(MAX_PARTICLES);
    expect(out[out.length - 1].x).toBeCloseTo(ps[ps.length - 1].x, 0);
  });

  it('removes particles that leave the box sideways or expire', () => {
    const out = stepParticles(
      [particle({ x: -30 }), particle({ x: W + 30 }), particle({ kind: 'puff', y: -40, vy: -10, life: 1300 }), particle({ age: 11_990 })],
      100,
      W,
      H,
    );
    expect(out).toHaveLength(0);
  });

  it('a petal reaching the ground lands, fades and is then removed', () => {
    let ps = stepParticles([particle({ y: H - 4, vy: 30 })], 100, W, H);
    expect(ps[0].landed).toBe(true);
    expect(ps[0].y).toBeLessThan(H);
    const y = ps[0].y;
    ps = stepParticles(ps, 500, W, H);
    expect(ps[0].y).toBe(y);
    expect(particleAlpha(ps[0])).toBeLessThan(1);
    for (let i = 0; i < 10; i++) ps = stepParticles(ps, 200, W, H);
    expect(ps).toHaveLength(0);
  });

  it('ignores bad dt', () => {
    const p = particle();
    expect(stepParticles([p], Number.NaN, W, H)[0].y).toBe(p.y);
    expect(stepParticles([p], -5, W, H)[0].y).toBe(p.y);
  });
});

describe('dizzy stars', () => {
  it('orbit their center for their life, then go', () => {
    let ps = spawnDizzy(80, 60, 1000);
    expect(ps).toHaveLength(3);
    const phase0 = ps[0].phase;
    for (let t = 0; t < 900; t += 100) ps = stepParticles(ps, 100, W, H);
    expect(ps).toHaveLength(3);
    expect(ps.every((p) => p.x === 80 && p.y === 60)).toBe(true);
    expect(ps[0].phase).not.toBe(phase0);
    for (let t = 0; t < 200; t += 100) ps = stepParticles(ps, 100, W, H);
    expect(ps).toHaveLength(0);
  });
});

describe('drawing', () => {
  it('draws on the 2 px grid and resets globalAlpha', () => {
    const ctx = spyCtx();
    drawParticles(ctx, [particle({ x: 81.3, y: 33.7, age: 50 })], 2);
    expect(ctx.fillRect).toHaveBeenCalled();
    for (const [x, y, w, h] of ctx.fillRect.mock.calls) {
      expect(x % 2).toBe(0);
      expect(y % 2).toBe(0);
      expect(w % 2).toBe(0);
      expect(h).toBe(2);
    }
    expect(ctx.globalAlpha).toBe(1);
  });

  it('filters by layer', () => {
    const ctx = spyCtx();
    drawParticles(ctx, [particle({ front: false })], 2, true);
    expect(ctx.fillRect).not.toHaveBeenCalled();
    drawParticles(ctx, [particle({ front: false })], 2, false);
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it('ice lies on the ground and is skipped when faded out', () => {
    const ctx = spyCtx();
    drawIce(ctx, 80, H, 0);
    expect(ctx.fillRect).not.toHaveBeenCalled();
    drawIce(ctx, 80, H, 1);
    const bottoms = ctx.fillRect.mock.calls.map(([, y, , h]) => y + h);
    expect(Math.max(...bottoms)).toBe(H);
  });
});
