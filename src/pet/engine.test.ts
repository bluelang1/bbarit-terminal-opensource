import { describe, expect, it } from 'vitest';
import {
  EAT_EVERY_MS,
  EAT_MS,
  GETUP_MS,
  ICE_AHEAD_PX,
  ICE_LIFE_MS,
  SLIP_MS,
  clampToWorkArea,
  groundY,
  initialState,
  PET_H,
  PET_W,
  SLEEP_AFTER_MS,
  step,
  WALK_PX_PER_S,
  type PetInput,
  type PetState,
  type WorkArea,
} from './engine';

const AREA: WorkArea = { x: 0, y: 25, w: 1440, h: 850 };
const AREA2: WorkArea = { x: 1440, y: 0, w: 1920, h: 1055 };

function input(over: Partial<PetInput> = {}): PetInput {
  return {
    dtMs: 100,
    areas: [AREA],
    rand: () => 0.5,
    dragging: null,
    activity: false,
    mood: 'none',
    treat: false,
    icy: false,
    ...over,
  };
}

function run(s: PetState, ms: number, over: Partial<PetInput> = {}): PetState {
  const dt = over.dtMs ?? 100;
  for (let t = 0; t < ms; t += dt) s = step(s, input({ ...over, dtMs: dt }));
  return s;
}

function walking(over: Partial<PetState> = {}): PetState {
  return {
    anim: 'walk',
    x: 600,
    y: groundY(AREA),
    dir: 1,
    mode: 'walk',
    pinned: false,
    idleMs: 0,
    actionMs: 5000,
    vy: 0,
    lastMood: 'none',
    ...over,
  };
}

function inside(p: { x: number; y: number }, a: WorkArea) {
  expect(p.x).toBeGreaterThanOrEqual(a.x);
  expect(p.x + PET_W).toBeLessThanOrEqual(a.x + a.w);
  expect(p.y).toBeGreaterThanOrEqual(a.y);
  expect(p.y + PET_H).toBeLessThanOrEqual(a.y + a.h);
}

describe('walking', () => {
  it('moves WALK_PX_PER_S per second in dir', () => {
    const right = run(walking(), 1000);
    expect(right.anim).toBe('walk');
    expect(Math.abs(right.x - (600 + WALK_PX_PER_S))).toBeLessThanOrEqual(1);
    expect(right.y).toBe(groundY(AREA));
    const left = run(walking({ dir: -1 }), 1000);
    expect(Math.abs(left.x - (600 - WALK_PX_PER_S))).toBeLessThanOrEqual(1);
  });

  it('turns around at the right edge and stays inside the area', () => {
    const edge = AREA.x + AREA.w - PET_W;
    const s = run(walking({ x: edge - 5 }), 1000);
    expect(s.dir).toBe(-1);
    expect(s.x).toBeLessThanOrEqual(edge);
    inside(s, AREA);
  });

  it('turns around at the left edge', () => {
    const s = run(walking({ x: AREA.x + 5, dir: -1 }), 1000);
    expect(s.dir).toBe(1);
    expect(s.x).toBeGreaterThanOrEqual(AREA.x);
  });

  it('alternates walk and rest by rand, without moving while resting', () => {
    let s = run(walking({ actionMs: 300 }), 400);
    expect(['idle', 'sit']).toContain(s.anim);
    const x = s.x;
    s = run(s, 2000);
    expect(['idle', 'sit']).toContain(s.anim);
    expect(s.x).toBe(x);
    // rest lasts 3..10 s; after 11 s it must have started walking again
    s = run(s, 9000);
    expect(s.anim).toBe('walk');
  });

  it('never walks in stay mode or when pinned', () => {
    for (const over of [{ mode: 'stay' as const }, { pinned: true }]) {
      const s0 = walking({ anim: 'idle', actionMs: 0, ...over });
      let s = s0;
      for (let t = 0; t < 30_000; t += 100) {
        s = step(s, input({ rand: () => (t % 700) / 700 }));
        expect(s.anim).not.toBe('walk');
        expect(s.x).toBe(s0.x);
      }
    }
  });
});

describe('sleep', () => {
  it('falls asleep after SLEEP_AFTER_MS without activity and stops moving', () => {
    let s = run(walking({ actionMs: 10 * 60_000 }), SLEEP_AFTER_MS, { dtMs: 1000 });
    expect(s.anim).toBe('sleep');
    const x = s.x;
    s = step(s, input({ dtMs: 1000 }));
    expect(s.anim).toBe('sleep');
    expect(s.x).toBe(x);
  });

  it('wakes on activity', () => {
    const asleep = walking({ anim: 'sleep', idleMs: SLEEP_AFTER_MS + 1 });
    const s = step(asleep, input({ activity: true }));
    expect(s.anim).toBe('idle');
    expect(s.idleMs).toBe(0);
  });

  it('activity keeps resetting the timer', () => {
    const s = run(walking({ idleMs: SLEEP_AFTER_MS - 50 }), 1000, { activity: true });
    expect(s.anim).not.toBe('sleep');
    expect(s.idleMs).toBe(0);
  });
});

describe('drag, pin and fall', () => {
  it('drag sets held at the drag point and wakes', () => {
    const s = step(walking({ anim: 'sleep', idleMs: SLEEP_AFTER_MS + 5, pinned: true }), input({ dragging: { x: 300, y: 200 } }));
    expect(s.anim).toBe('held');
    expect(s.x).toBe(300);
    expect(s.y).toBe(200);
    expect(s.pinned).toBe(false);
    expect(s.idleMs).toBe(0);
  });

  it('release high on screen pins the pet where it was dropped', () => {
    let s = step(walking(), input({ dragging: { x: 300, y: 200 } }));
    s = step(s, input());
    expect(s.pinned).toBe(true);
    s = run(s, 10_000, { rand: () => 0.1 });
    expect(s.pinned).toBe(true);
    expect(s.x).toBe(300);
    expect(s.y).toBe(200);
    expect(s.anim).not.toBe('walk');
  });

  it('release 20 px above the ground falls to the ground unpinned', () => {
    const ground = groundY(AREA);
    let s = step(walking(), input({ dragging: { x: 300, y: ground - 20 } }));
    s = step(s, input({ dtMs: 16 }));
    expect(s.anim).toBe('fall');
    s = run(s, 2000, { dtMs: 16 });
    expect(s.y).toBe(ground);
    expect(s.pinned).toBe(false);
    expect(s.anim).not.toBe('fall');
    expect(s.vy).toBe(0);
  });

  it('release outside every work area lands on a valid bottom edge', () => {
    let s = step(walking(), input({ dragging: { x: -4000, y: -3000 } }));
    s = step(s, input());
    s = run(s, 5000, { dtMs: 16 });
    expect(s.pinned).toBe(false);
    expect(s.y).toBe(groundY(AREA));
    inside(s, AREA);
  });

  it('pinned position partly off-screen is pulled fully inside', () => {
    let s = step(walking(), input({ dragging: { x: AREA.w - 20, y: 100 } }));
    s = step(s, input());
    expect(s.pinned).toBe(true);
    inside(s, AREA);
  });
});

describe('work areas', () => {
  it('clampToWorkArea pulls a far-away point inside the area', () => {
    const p = clampToWorkArea(-5000, -5000, [AREA]);
    expect(p.area).toEqual(AREA);
    inside(p, AREA);
  });

  it('clampToWorkArea picks the area the pet is on, else the nearest', () => {
    expect(clampToWorkArea(2000, 500, [AREA, AREA2]).area).toEqual(AREA2);
    expect(clampToWorkArea(9000, 500, [AREA, AREA2]).area).toEqual(AREA2);
    expect(clampToWorkArea(-900, 500, [AREA, AREA2]).area).toEqual(AREA);
  });

  it('initialState with a saved position on a missing monitor lands inside an area', () => {
    const s = initialState([AREA, AREA2], { x: 99999, y: 99999 });
    const area = clampToWorkArea(s.x, s.y, [AREA, AREA2]).area;
    inside(s, area);
  });

  it('initialState starts unpinned pets on the ground and keeps pinned ones', () => {
    const free = initialState([AREA]);
    expect(free.y).toBe(groundY(AREA));
    expect(free.pinned).toBe(false);
    expect(free.mode).toBe('walk');
    const pinned = initialState([AREA], { x: 100, y: 100, pinned: true });
    expect(pinned).toMatchObject({ x: 100, y: 100, pinned: true });
  });

  it('a monitor change while walking moves the pet back onto a visible ground', () => {
    let s = walking({ x: 2500, y: groundY(AREA2) });
    s = run(s, 3000, { areas: [AREA], dtMs: 16 });
    inside(s, AREA);
    expect(s.y).toBe(groundY(AREA));
  });

  it('copes with no work areas at all', () => {
    const s = run(initialState([]), 1000, { areas: [] });
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.y)).toBe(true);
  });
});

describe('Claude mood', () => {
  const asleep = (over: Partial<PetState> = {}) => walking({ anim: 'sleep', actionMs: 0, idleMs: SLEEP_AFTER_MS + 1, ...over });

  it('blocked waves in place, never walks and never falls asleep', () => {
    let s = walking();
    const x = s.x;
    for (let t = 0; t < SLEEP_AFTER_MS + 60_000; t += 1000) {
      s = step(s, input({ dtMs: 1000, mood: 'blocked' }));
      expect(s.anim).toBe('wave');
      expect(s.x).toBe(x);
      expect(s.idleMs).toBe(0);
    }
  });

  it('blocked wakes a sleeping pet at once', () => {
    const s = step(asleep(), input({ mood: 'blocked' }));
    expect(s.anim).toBe('wave');
    expect(s.idleMs).toBe(0);
  });

  it('happy jumps in place and resets the idle timer only on entry', () => {
    let s = step(walking({ idleMs: 60_000 }), input({ mood: 'happy' }));
    expect(s.anim).toBe('happy');
    expect(s.idleMs).toBe(0);
    const x = s.x;
    s = run(s, 5000, { mood: 'happy' });
    expect(s.anim).toBe('happy');
    expect(s.x).toBe(x);
    expect(s.idleMs).toBeGreaterThanOrEqual(4900);
  });

  it('happy wakes a sleeping pet, which can fall asleep again later', () => {
    let s = step(asleep(), input({ mood: 'happy' }));
    expect(s.anim).toBe('happy');
    s = run(s, 10_000, { mood: 'happy' });
    expect(s.anim).toBe('happy');
    s = step(s, input({ mood: 'none' }));
    expect(['idle', 'sit', 'walk']).toContain(s.anim);
    s = run(s, SLEEP_AFTER_MS, { mood: 'none', dtMs: 1000 });
    expect(s.anim).toBe('sleep');
  });

  it('busy shows the busy animation while standing and never sleeps', () => {
    let s = step(walking({ anim: 'idle', actionMs: 5000 }), input({ mood: 'busy' }));
    expect(s.anim).toBe('busy');
    s = run(s, SLEEP_AFTER_MS + 60_000, { mood: 'busy', dtMs: 1000 });
    expect(s.anim).not.toBe('sleep');
    expect(s.idleMs).toBe(0);
  });

  it('busy wakes a sleeping pet', () => {
    const s = step(asleep(), input({ mood: 'busy' }));
    expect(s.anim).toBe('busy');
  });

  it('busy walks at half speed and still alternates walk and rest', () => {
    const s = run(walking(), 1000, { mood: 'busy' });
    expect(s.anim).toBe('walk');
    expect(Math.abs(s.x - (600 + WALK_PX_PER_S / 2))).toBeLessThanOrEqual(1);
    let r = run(walking({ actionMs: 300 }), 400, { mood: 'busy' });
    expect(r.anim).toBe('busy');
    r = run(r, 11_000, { mood: 'busy' });
    expect(r.anim).toBe('walk');
  });

  it('back to none: busy animation turns into ordinary rest', () => {
    let s = step(walking({ anim: 'idle', actionMs: 5000 }), input({ mood: 'busy' }));
    s = step(s, input({ mood: 'none' }));
    expect(['idle', 'sit']).toContain(s.anim);
  });

  it('wave and happy end into normal idle life when the mood clears', () => {
    for (const mood of ['blocked', 'happy'] as const) {
      let s = run(walking(), 1000, { mood });
      s = step(s, input({ mood: 'none' }));
      expect(['idle', 'sit', 'walk']).toContain(s.anim);
    }
  });

  it('dragging wins over every mood', () => {
    for (const mood of ['blocked', 'happy', 'busy'] as const) {
      const s = step(walking(), input({ mood, dragging: { x: 300, y: 200 } }));
      expect(s.anim).toBe('held');
    }
  });
});

/** Steps for `ms`, collecting every anim seen in order (deduplicated runs). */
function trace(s: PetState, ms: number, over: Partial<PetInput> = {}): { s: PetState; anims: string[] } {
  const dt = over.dtMs ?? 100;
  const anims: string[] = [];
  for (let t = 0; t < ms; t += dt) {
    s = step(s, input({ ...over, dtMs: dt }));
    if (anims[anims.length - 1] !== s.anim) anims.push(s.anim);
  }
  return { s, anims };
}

describe('treat days (eating)', () => {
  const resting = (over: Partial<PetState> = {}) => walking({ anim: 'idle', actionMs: 4000, ...over });

  it('eats in place within the eat window (stubbed rand: earliest)', () => {
    let s = resting();
    let firstEat = -1;
    for (let t = 0; t < EAT_EVERY_MS[0] + 5000; t += 100) {
      const prevX = s.x;
      s = step(s, input({ treat: true, activity: true, rand: () => 0 }));
      if (s.anim === 'eat') {
        if (firstEat < 0) firstEat = t;
        expect(s.x).toBe(prevX);
      }
    }
    expect(firstEat).toBeGreaterThanOrEqual(EAT_EVERY_MS[0] - 200);
    expect(firstEat).toBeLessThanOrEqual(EAT_EVERY_MS[0] + 100);
  });

  it('eats for EAT_MS then goes back to idle life, and eats again later', () => {
    const { anims } = trace(resting(), EAT_EVERY_MS[0] * 2 + EAT_MS[1] * 2, { treat: true, activity: true, rand: () => 0 });
    const eats = anims.filter((a) => a === 'eat').length;
    expect(eats).toBe(2);
    expect(anims[anims.length - 1]).not.toBe('eat');
  });

  it('eats at most every EAT_EVERY_MS[1] with the latest rand', () => {
    const { anims } = trace(resting(), EAT_EVERY_MS[1] - 1000, { treat: true, activity: true, rand: () => 0.999 });
    expect(anims).not.toContain('eat');
  });

  it('never eats without a treat day', () => {
    const { anims } = trace(resting(), 10 * 60_000, { activity: true, rand: () => 0, dtMs: 500 });
    expect(anims).not.toContain('eat');
  });

  it('blocked: waves, never eats', () => {
    const { anims } = trace(resting(), 10 * 60_000, { treat: true, mood: 'blocked', rand: () => 0, dtMs: 500 });
    expect(anims).toEqual(['wave']);
  });

  it('a Claude mood interrupts eating', () => {
    const eating = resting({ anim: 'eat', actionMs: 4000, eatInMs: 200_000 });
    expect(step(eating, input({ treat: true, mood: 'blocked' })).anim).toBe('wave');
    expect(step(eating, input({ treat: true, mood: 'happy' })).anim).toBe('happy');
    expect(step(eating, input({ treat: true, mood: 'busy' })).anim).toBe('busy');
    expect(step(eating, input({ treat: true, dragging: { x: 1, y: 1 } })).anim).toBe('held');
  });

  it('the day ending stops eating', () => {
    const eating = resting({ anim: 'eat', actionMs: 4000, eatInMs: 200_000 });
    expect(step(eating, input({ treat: false })).anim).not.toBe('eat');
  });

  it('asleep on a treat day: stays asleep, does not wake up to eat', () => {
    const asleep = walking({ anim: 'sleep', actionMs: 0, idleMs: SLEEP_AFTER_MS + 1, eatInMs: 1 });
    const { anims } = trace(asleep, 10 * 60_000, { treat: true, rand: () => 0, dtMs: 500 });
    expect(anims).toEqual(['sleep']);
  });

  it('a pinned or stay-mode pet still eats (in place)', () => {
    for (const over of [{ pinned: true, y: 300 }, { mode: 'stay' as const }]) {
      const { anims } = trace(resting(over), EAT_EVERY_MS[0] + 1000, { treat: true, activity: true, rand: () => 0, dtMs: 500 });
      expect(anims).toContain('eat');
    }
  });
});

describe('winter ice slip', () => {
  const center = (s: PetState) => s.x + PET_W / 2;
  const onIce = (over: Partial<PetState> = {}): PetState => {
    const s = walking(over);
    return { ...s, ice: { x: center(s) + s.dir * 3, ms: ICE_LIFE_MS, used: false } };
  };

  it('walking onto the ice slips in place-ish, gets up and walks on', () => {
    let s = onIce();
    s = run(s, 200, { icy: true });
    expect(s.anim).toBe('slip');
    expect(s.ice?.used).toBe(true);
    const x = s.x;
    const { s: after, anims } = trace(s, SLIP_MS + GETUP_MS + 200, { icy: true });
    expect(anims.slice(0, 3)).toEqual(['slip', 'getup', 'walk']);
    expect(after.x).toBeGreaterThan(x); // slid forward and walked on in the same direction
    expect(after.dir).toBe(1);
  });

  it('the used ice fades away after the slip', () => {
    const s = run(onIce(), 200, { icy: true });
    const later = run(s, SLIP_MS + 3000, { icy: true });
    expect(later.ice).toBeNull();
  });

  it('places ice just ahead while walking in winter (stubbed rand: earliest), then slips on it', () => {
    let s = walking({ actionMs: 600_000 });
    let placed: PetState['ice'] = null;
    let slipped = false;
    for (let t = 0; t < 7 * 60_000 && !slipped; t += 100) {
      s = step(s, input({ icy: true, activity: true, rand: () => 0 }));
      if (!placed && s.ice) {
        placed = s.ice;
        const d = (s.ice.x - center(s)) * s.dir;
        expect(d).toBeGreaterThan(0);
        expect(d).toBeLessThanOrEqual(ICE_AHEAD_PX);
      }
      if (s.anim === 'slip') slipped = true;
    }
    expect(placed).not.toBeNull();
    expect(slipped).toBe(true);
  });

  it('never slips outside winter', () => {
    const { anims, s } = trace(walking({ actionMs: 600_000 }), 10 * 60_000, { activity: true, rand: () => 0, dtMs: 200 });
    expect(anims).not.toContain('slip');
    expect(s.ice ?? null).toBeNull();
    expect(step(onIce(), input({ icy: false })).anim).toBe('walk');
  });

  it('never slips while pinned or in stay mode (it does not walk)', () => {
    for (const over of [{ pinned: true, y: 300 }, { mode: 'stay' as const }]) {
      const { anims } = trace(onIce(over), 10 * 60_000, { icy: true, activity: true, rand: () => 0, dtMs: 200 });
      expect(anims).not.toContain('slip');
    }
  });

  it('Claude moods win: blocked waves, busy walks over the ice', () => {
    expect(trace(onIce(), 60_000, { icy: true, mood: 'blocked' }).anims).toEqual(['wave']);
    const busy = trace(onIce(), 1000, { icy: true, mood: 'busy' });
    expect(busy.anims).not.toContain('slip');
    const slipping = run(onIce(), 200, { icy: true });
    expect(step(slipping, input({ icy: true, mood: 'blocked' })).anim).toBe('wave');
    expect(step(slipping, input({ icy: true, dragging: { x: 1, y: 1 } })).anim).toBe('held');
  });

  it('sleep wins over a slip in progress', () => {
    const slipping = { ...run(onIce(), 200, { icy: true }), idleMs: SLEEP_AFTER_MS - 50 };
    expect(step(slipping, input({ icy: true })).anim).toBe('sleep');
  });
});
