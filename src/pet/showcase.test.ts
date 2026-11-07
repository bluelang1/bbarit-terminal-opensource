import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { ACCESSORIES, BITE_MS, accessoriesFor } from './accessories';
import { treatFor } from './calendar';
import { ICE_LIFE_MS, SLIP_MS, iceAlpha } from './engine';
import {
  LIFT_PX,
  PACE_PX,
  SHOWCASE_KEY,
  SHOWCASE_STEPS,
  SHOWCASE_TOTAL_MS,
  showcaseAt,
  showcaseBubble,
  showcaseRequested,
  stepMs,
  type ShowcaseStep,
} from './showcase';

const LABELS = { needsApproval: 'needs approval', done: 'Done' };

/** Tour time at which step `id` starts. */
function startOf(id: string): number {
  let t = 0;
  for (const s of SHOWCASE_STEPS) {
    if (s.id === id) return t;
    t += stepMs(s);
  }
  throw new Error(`no step ${id}`);
}

function step(id: string): ShowcaseStep {
  const s = SHOWCASE_STEPS.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe('SHOWCASE_STEPS', () => {
  it('plays the owner-requested cases in order', () => {
    expect(SHOWCASE_STEPS.map((s) => s.id)).toEqual([
      'walk',
      'sit',
      'sleep',
      'held',
      'spring',
      'summer',
      'autumn',
      'winter',
      'ice',
      'pepero',
      'valentine',
      'white',
      'halloween',
      'christmas',
      'clear',
      'night',
      'cloudy',
      'fog',
      'drizzle',
      'rain',
      'thunder',
      'snow',
      'busy',
      'done',
      'blocked',
      'unseen',
    ]);
  });

  it('every step lasts about 6 s; the total adds up', () => {
    for (const s of SHOWCASE_STEPS) {
      expect(stepMs(s), s.id).toBeGreaterThanOrEqual(5500);
      expect(stepMs(s), s.id).toBeLessThanOrEqual(7000);
    }
    expect(SHOWCASE_TOTAL_MS).toBe(SHOWCASE_STEPS.reduce((sum, s) => sum + stepMs(s), 0));
  });

  it('captions are i18n keys pet.tour.step.<id>, translated in en and ko', () => {
    for (const s of SHOWCASE_STEPS) {
      expect(s.captionKey).toBe(`pet.tour.step.${s.id}`);
      expect(en[s.captionKey].length, `en ${s.id}`).toBeGreaterThan(0);
      expect(ko[s.captionKey].length, `ko ${s.id}`).toBeGreaterThan(0);
      expect(ko[s.captionKey], `ko ${s.id} is real Korean`).not.toBe(en[s.captionKey]);
    }
  });

  it('ids are unique', () => {
    expect(new Set(SHOWCASE_STEPS.map((s) => s.id)).size).toBe(SHOWCASE_STEPS.length);
  });

  it('seasons and special days use the matching calendar', () => {
    expect(step('spring').cal).toEqual({ season: 'spring', special: null });
    expect(step('summer').cal).toEqual({ season: 'summer', special: null });
    expect(step('autumn').cal).toEqual({ season: 'autumn', special: null });
    expect(step('winter').cal).toEqual({ season: 'winter', special: null });
    expect(step('ice').cal?.season).toBe('winter');
    expect(step('pepero').cal?.special).toBe('pepero');
    expect(step('valentine').cal?.special).toBe('valentine');
    expect(step('white').cal?.special).toBe('white');
    expect(step('halloween').cal?.special).toBe('halloween');
    expect(step('christmas').cal?.special).toBe('christmas');
  });

  it('weather steps carry fake weather (no location or network needed); others none', () => {
    const want: Record<string, string> = {
      clear: 'clear', night: 'clear', cloudy: 'cloudy', fog: 'fog', drizzle: 'drizzle', rain: 'rain', thunder: 'thunder', snow: 'snow',
    };
    for (const s of SHOWCASE_STEPS) {
      expect(s.weather?.kind ?? null, s.id).toBe(want[s.id] ?? null);
    }
    expect(step('night').weather?.night).toBe(true);
    expect(step('clear').weather?.night).toBe(false);
    expect(step('snow').cal?.season).toBe('winter');
    // The view carries it while the step plays, and nothing outside weather steps.
    expect(showcaseAt(startOf('rain') + 100)?.weather?.kind).toBe('rain');
    expect(showcaseAt(startOf('walk') + 100)?.weather).toBeNull();
  });

  it('rain: walks (ripples) then stands (puddle); snow walks both ways (footprints)', () => {
    expect(showcaseAt(startOf('rain') + 1000)?.anim).toBe('walk');
    expect(showcaseAt(startOf('rain') + stepMs(step('rain')) - 500)?.anim).toBe('idle');
    const there = showcaseAt(startOf('snow') + 2500)!;
    const back = showcaseAt(startOf('snow') + stepMs(step('snow')) - 500)!;
    expect(there.dir).toBe(1);
    expect(back.dir).toBe(-1);
  });

  it('weather steps show the umbrella only in rain', () => {
    for (const id of ['drizzle', 'rain', 'thunder']) {
      const v = showcaseAt(startOf(id) + 500)!;
      expect(accessoriesFor(v.cal!, v.anim, v.weather), id).toContain('umbrella');
    }
    const snow = showcaseAt(startOf('snow') + 500)!;
    expect(accessoriesFor(snow.cal!, snow.anim, snow.weather)).not.toContain('umbrella');
  });

  it('eat steps eat long enough to finish the treat on a treat day', () => {
    for (const id of ['pepero', 'valentine', 'white']) {
      const s = step(id);
      const treat = treatFor(s.cal?.special ?? null);
      expect(treat, id).not.toBeNull();
      const eat = s.segments.find((g) => g.anim === 'eat');
      const ids = accessoriesFor(s.cal!, 'eat');
      const food = ids.find((a) => ACCESSORIES[a].frames.length > 1)!;
      expect(food, id).toBeDefined();
      expect(eat!.ms, id).toBeGreaterThanOrEqual(ACCESSORIES[food].frames.length * BITE_MS);
    }
  });
});

describe('showcaseAt', () => {
  it('starts at the first step and returns null once the last step has ended', () => {
    expect(showcaseAt(0)?.id).toBe('walk');
    expect(showcaseAt(-50)?.id).toBe('walk');
    expect(showcaseAt(SHOWCASE_TOTAL_MS - 1)?.id).toBe('unseen');
    expect(showcaseAt(SHOWCASE_TOTAL_MS)).toBeNull();
    expect(showcaseAt(SHOWCASE_TOTAL_MS + 60_000)).toBeNull();
  });

  it('walks through every step in order at its start time', () => {
    SHOWCASE_STEPS.forEach((s, i) => {
      const v = showcaseAt(startOf(s.id));
      expect(v?.index).toBe(i);
      expect(v?.id).toBe(s.id);
      expect(v?.captionKey).toBe(s.captionKey);
      expect(v?.stepMs).toBe(0);
    });
  });

  it('pacing stays near the start spot and returns to it by the end of the step', () => {
    const t0 = startOf('walk');
    for (let t = 0; t < stepMs(step('walk')); t += 100) {
      const v = showcaseAt(t0 + t)!;
      expect(v.anim).toBe('walk');
      expect(Math.abs(v.dx)).toBeLessThanOrEqual(PACE_PX);
      expect(v.dy).toBe(0);
    }
    expect(showcaseAt(t0 + 500)!.dir).toBe(1);
    expect(showcaseAt(t0 + 2000)!.dir).toBe(-1);
    expect(Math.abs(showcaseAt(t0 + stepMs(step('walk')) - 1)!.dx)).toBeLessThan(1);
  });

  it('held lifts the pet, then it falls and lands as idle', () => {
    const t0 = startOf('held');
    expect(showcaseAt(t0 + 100)).toMatchObject({ anim: 'held', dy: LIFT_PX });
    const falling = showcaseAt(t0 + 2500 + 100)!;
    expect(falling.anim).toBe('fall');
    expect(falling.dy).toBeGreaterThan(0);
    expect(falling.dy).toBeLessThan(LIFT_PX);
    expect(showcaseAt(t0 + 2500 + 1000)).toMatchObject({ anim: 'idle', dy: 0 });
  });

  it('winter ice: walks onto the patch, slips, gets up and walks back to the start', () => {
    const t0 = startOf('ice');
    const before = showcaseAt(t0 + 1000)!;
    expect(before.anim).toBe('walk');
    expect(before.ice).toMatchObject({ used: false });
    expect(iceAlpha({ x: 0, ms: before.ice!.ms, used: false })).toBe(1);
    expect(iceAlpha({ x: 0, ms: showcaseAt(t0)!.ice!.ms, used: false })).toBe(0); // fades in
    const slip = showcaseAt(t0 + 1600)!;
    expect(slip.anim).toBe('slip');
    expect(slip.ice).toMatchObject({ used: true });
    // The pet's center reaches the ice center as it slips.
    expect(showcaseAt(t0 + 1500)!.dx).toBeCloseTo(slip.ice!.dx, 5);
    expect(showcaseAt(t0 + 1500 + SLIP_MS + 100)!.anim).toBe('getup');
    expect(showcaseAt(t0 + 1500 + SLIP_MS + 600)!.anim).toBe('walk');
    expect(showcaseAt(t0 + 1500 + SLIP_MS + 600)!.dir).toBe(-1);
    const end = showcaseAt(t0 + stepMs(step('ice')) - 1)!;
    expect(end.anim).toBe('idle');
    expect(Math.abs(end.dx)).toBeLessThan(1);
    expect(end.ice).toBeNull(); // melted
    expect(showcaseAt(t0 + 1000)!.ice!.ms).toBe(ICE_LIFE_MS - 1000);
  });

  it('eat steps eat then stand', () => {
    const t0 = startOf('pepero');
    expect(showcaseAt(t0 + 100)!.anim).toBe('eat');
    expect(showcaseAt(t0 + 5000)!.anim).toBe('idle');
  });

  it('non-calendar steps keep the real calendar (null)', () => {
    expect(showcaseAt(startOf('walk'))!.cal).toBeNull();
    expect(showcaseAt(startOf('busy'))!.cal).toBeNull();
  });

  it('Claude steps: busy, happy with a done bubble, wave with a blocked bubble (+2), unseen badge', () => {
    const busy = showcaseAt(startOf('busy') + 100)!;
    expect(busy).toMatchObject({ anim: 'busy', mood: 'busy' });
    expect(showcaseBubble(busy, LABELS)).toBeNull();

    const done = showcaseAt(startOf('done') + 100)!;
    expect(done).toMatchObject({ anim: 'happy', mood: 'happy' });
    expect(showcaseBubble(done, LABELS)).toMatchObject({ kind: 'done', text: 'Done · Claude', more: 0 });
    // Still showing at the end of the step (HAPPY_MS is longer than the step).
    expect(showcaseBubble(showcaseAt(startOf('done') + stepMs(step('done')) - 1)!, LABELS)?.kind).toBe('done');

    const blocked = showcaseAt(startOf('blocked') + 100)!;
    expect(blocked).toMatchObject({ anim: 'wave', mood: 'blocked' });
    expect(showcaseBubble(blocked, LABELS)).toMatchObject({ kind: 'blocked', terminalId: 'showcase-3', more: 2 });

    const unseen = showcaseAt(startOf('unseen') + 100)!;
    expect(unseen.summary.unseenDone).toBe(3);
    expect(unseen.mood).toBe('none');
    expect(showcaseBubble(unseen, LABELS)).toBeNull();
  });

  it('steps without a fake summary show no bubble or badge', () => {
    const v = showcaseAt(startOf('winter'))!;
    expect(v.summary).toEqual({ blocked: [], working: [], unseenDone: 0 });
    expect(showcaseBubble(v, LABELS)).toBeNull();
  });

  it('takes a custom step list', () => {
    const steps: ShowcaseStep[] = [
      { id: 'a', captionKey: 'pet.tour.step.sit', segments: [{ anim: 'sit', ms: 100 }] },
      { id: 'b', captionKey: 'pet.tour.step.walk', segments: [{ anim: 'idle', ms: 50 }] },
    ];
    expect(showcaseAt(99, steps)?.id).toBe('a');
    expect(showcaseAt(100, steps)?.id).toBe('b');
    expect(showcaseAt(150, steps)).toBeNull();
  });
});

describe('showcaseRequested', () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === SHOWCASE_KEY ? v : null) });

  it('only in dev builds with the key set to 1', () => {
    expect(showcaseRequested(true, store('1'))).toBe(true);
    expect(showcaseRequested(false, store('1'))).toBe(false);
    expect(showcaseRequested(true, store('0'))).toBe(false);
    expect(showcaseRequested(true, store(null))).toBe(false);
    expect(showcaseRequested(true, undefined)).toBe(false);
  });

  it('a throwing storage is treated as off', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(showcaseRequested(true, bad)).toBe(false);
  });
});
