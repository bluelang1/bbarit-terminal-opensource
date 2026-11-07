import { describe, expect, it, vi } from 'vitest';
import {
  FLASH_MS,
  MAX_FX,
  PRINT_LIFE_MS,
  SKY,
  STEP_EVERY_MS,
  createWeatherFx,
  drawWeatherBack,
  drawWeatherFlash,
  drawWeatherFront,
  flashAlpha,
  stepWeather,
  type FxInput,
  type FxParticle,
  type WeatherFx,
} from './weatherFx';
import type { PetWeather } from './weather';

const W = 160;
const H = 160;
const TICK = 83;
const wx = (kind: PetWeather['kind'], heavy = false, night = false): PetWeather => ({ kind, heavy, night });

function seeded(seed = 7): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function input(over: Partial<FxInput> = {}): FxInput {
  return {
    weather: wx('rain'),
    dtMs: TICK,
    rand: seeded(),
    w: W,
    h: H,
    originX: 1000,
    feetX: W / 2,
    walking: false,
    grounded: true,
    ...over,
  };
}

/** Step `ms` in ticks; `each` can change the input per tick (e.g. walk the window). */
function run(fx: WeatherFx, ms: number, over: Partial<FxInput> = {}, each?: (t: number) => Partial<FxInput>): WeatherFx {
  const rand = seeded(11);
  for (let t = 0; t < ms; t += TICK) stepWeather(fx, input({ rand, ...over, ...(each ? each(t) : {}) }));
  return fx;
}

const kinds = (fx: WeatherFx) => new Set(fx.ps.map((p) => p.kind));

function spyCtx() {
  return { fillStyle: '' as string, globalAlpha: 1, globalCompositeOperation: 'source-over' as GlobalCompositeOperation, fillRect: vi.fn() };
}

describe('stepWeather', () => {
  it('no weather: nothing spawns; a puddle dries up', () => {
    const fx = createWeatherFx();
    fx.puddle = { x: 1080, size: 0.5 };
    run(fx, 10_000, { weather: null });
    expect(fx.ps).toHaveLength(0);
    expect(fx.puddle).toBeNull();
  });

  it('rain: drops fall, stay under the cap, and splash where they hit the ground', () => {
    const fx = run(createWeatherFx(), 5000, { weather: wx('rain', true) });
    expect(fx.ps.length).toBeGreaterThan(5);
    expect(fx.ps.length).toBeLessThanOrEqual(MAX_FX);
    expect(kinds(fx).has('drop')).toBe(true);
    const one = createWeatherFx();
    const drop: FxParticle = { kind: 'drop', x: 50, y: H - 4, vx: 0, vy: 300, age: 100, life: 5000, variant: 0, front: false };
    one.ps.push(drop);
    stepWeather(one, input({ weather: null }));
    expect(one.ps.map((p) => p.kind)).toEqual(['splash']);
    expect(one.ps[0].y).toBeLessThanOrEqual(H);
  });

  it('drizzle is lighter than heavy rain', () => {
    const count = (w: PetWeather) => {
      let n = 0;
      const fx = createWeatherFx();
      const rand = seeded(3);
      for (let t = 0; t < 20_000; t += TICK) {
        stepWeather(fx, input({ weather: w, rand }));
        n += fx.ps.filter((p) => p.kind === 'drop' && p.age === 0).length;
      }
      return n;
    };
    expect(count(wx('drizzle'))).toBeLessThan(count(wx('rain', true)));
  });

  it('walking in rain: ripples and kicked-up droplets at the feet, anchored to the screen', () => {
    const fx = run(createWeatherFx(), STEP_EVERY_MS * 3, { walking: true, weather: wx('drizzle') });
    const ripples = fx.ps.filter((p) => p.kind === 'ripple');
    expect(ripples.length).toBeGreaterThanOrEqual(2);
    // Screen x (window left + body center), at the outer tentacles on either side, not
    // hidden under the body.
    for (const r of ripples) {
      const off = Math.abs(r.x - (1000 + W / 2));
      expect(off).toBeGreaterThan(15);
      expect(off).toBeLessThan(40);
    }
    expect(new Set(ripples.map((r) => Math.sign(r.x - (1000 + W / 2)))).size).toBe(2);
    expect(kinds(fx).has('hop')).toBe(true);
  });

  it('snow: heavier flakes, footprints while walking that fade and go', () => {
    const fx = run(createWeatherFx(), 6000, { walking: true, weather: wx('snow', true) });
    expect(kinds(fx).has('flake')).toBe(true);
    const prints = fx.ps.filter((p) => p.kind === 'print');
    expect(prints.length).toBeGreaterThan(2);
    expect(kinds(fx).has('ripple')).toBe(false);
    expect(fx.snowCover).toBeGreaterThan(0);
    // Standing still afterwards: the prints fade away.
    run(fx, PRINT_LIFE_MS + 500, { walking: false, weather: wx('snow') });
    expect(fx.ps.some((p) => p.kind === 'print')).toBe(false);
  });

  it('a puddle grows under the resting pet in rain and fades once it walks off', () => {
    const fx = run(createWeatherFx(), 6000, { weather: wx('rain') });
    expect(fx.puddle?.size).toBeGreaterThan(0.8);
    expect(fx.puddle?.x).toBe(1000 + W / 2);
    run(fx, 4000, { walking: true, weather: wx('rain') });
    expect(fx.puddle).toBeNull();
  });

  it('not on the ground (pinned in the air, held): no puddle, prints or snow cover', () => {
    const rain = run(createWeatherFx(), 6000, { grounded: false, weather: wx('rain') });
    expect(rain.puddle).toBeNull();
    const snow = run(createWeatherFx(), 6000, { grounded: false, walking: true, weather: wx('snow') });
    expect(snow.ps.some((p) => p.kind === 'print')).toBe(false);
    expect(snow.snowCover).toBe(0);
  });

  it('thunder: short faint flashes every several seconds', () => {
    const fx = createWeatherFx();
    const rand = seeded(5);
    let flashes = 0;
    let lit = 0;
    let maxAlpha = 0;
    for (let t = 0; t < 120_000; t += 10) {
      stepWeather(fx, input({ weather: wx('thunder'), dtMs: 10, rand }));
      const a = flashAlpha(fx);
      if (fx.flashAge === 0) flashes++;
      if (a > 0) lit += 10;
      maxAlpha = Math.max(maxAlpha, a);
    }
    expect(flashes).toBeGreaterThanOrEqual(120 / 16);
    expect(flashes).toBeLessThanOrEqual(120 / 6 + 1);
    expect(lit / flashes).toBeLessThanOrEqual(FLASH_MS);
    expect(maxAlpha).toBeGreaterThan(0);
    expect(maxAlpha).toBeLessThanOrEqual(0.22);
    // No flashes in plain rain.
    const rain = run(createWeatherFx(), 30_000, { weather: wx('rain', true) });
    expect(rain.flashAge).toBe(-1);
  });

  it('clear / cloudy: a sky particle now and then (sun by day, moon at night, cloud)', () => {
    const seen = (w: PetWeather) => {
      const fx = createWeatherFx();
      const rand = seeded(11);
      const out = new Set<number>();
      for (let t = 0; t < 40_000; t += TICK) {
        stepWeather(fx, input({ weather: w, rand }));
        for (const p of fx.ps) if (p.kind === 'sky') out.add(p.variant);
      }
      return out;
    };
    expect(seen(wx('clear'))).toEqual(new Set([SKY.sun]));
    expect(seen(wx('clear', false, true))).toEqual(new Set([SKY.moon, SKY.star]));
    expect(seen(wx('cloudy'))).toEqual(new Set([SKY.cloud]));
    expect(seen(wx('cloudy', false, true))).toEqual(new Set([SKY.nightCloud]));
    expect(seen(wx('fog')).size).toBe(0);
  });
});

describe('draw', () => {
  it('back / front layers draw and restore alpha; fog stays faint and fades at the edges', () => {
    for (const w of [wx('rain', true), wx('snow', true), wx('fog'), wx('clear'), wx('thunder')]) {
      const fx = run(createWeatherFx(), 8000, { weather: w, walking: true });
      const ctx = spyCtx();
      const alphas: number[] = [];
      ctx.fillRect.mockImplementation(() => alphas.push(ctx.globalAlpha));
      drawWeatherBack(ctx, fx, w, 1000, W, H);
      drawWeatherFront(ctx, fx, w, 1000, W, H);
      expect(ctx.fillRect.mock.calls.length, w.kind).toBeGreaterThan(0);
      expect(ctx.globalAlpha, w.kind).toBe(1);
      if (w.kind === 'fog') {
        expect(Math.max(...alphas)).toBeLessThanOrEqual(0.45);
        const xs = ctx.fillRect.mock.calls.map((c) => c[0] as number);
        expect(Math.min(...xs)).toBeGreaterThan(0);
        expect(Math.max(...xs)).toBeLessThan(W - 2);
      }
    }
  });

  it('flash tints only what is drawn (source-atop) and restores the mode', () => {
    const fx = createWeatherFx();
    fx.flashAge = 10;
    const ctx = spyCtx();
    const modes: string[] = [];
    ctx.fillRect.mockImplementation(() => modes.push(ctx.globalCompositeOperation));
    drawWeatherFlash(ctx, fx, W, H);
    expect(modes).toContain('source-atop');
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.globalAlpha).toBe(1);
    const idle = spyCtx();
    drawWeatherFlash(idle, createWeatherFx(), W, H);
    expect(idle.fillRect).not.toHaveBeenCalled();
  });
});
