import { describe, expect, it, vi } from 'vitest';
import { OCTO_PACK } from './characters/octo';
import { ANIM_NAMES, type CharacterPack, type PackFrame } from './pack';
import {
  ACCESSORIES,
  accessoriesFor,
  biteFrame,
  BITE_MS,
  drawAccessories,
  drawAccessory,
  headRise,
  type AccessoryId,
} from './accessories';
import type { PetCalendar } from './calendar';

const IDS = Object.keys(ACCESSORIES) as AccessoryId[];

function spyCtx() {
  return { fillStyle: '', fillRect: vi.fn() };
}

describe('ACCESSORIES art', () => {
  it.each(IDS)('%s: rows of one width, only palette chars, anchor offset sane', (id) => {
    const acc = ACCESSORIES[id];
    expect(acc.frames.length).toBeGreaterThan(0);
    for (const f of acc.frames) {
      expect(f.rows.length).toBeGreaterThan(0);
      const w = f.rows[0].length;
      for (const row of f.rows) {
        expect(row).toHaveLength(w);
        for (const ch of row) if (ch !== '.') expect(ch in acc.palette, `${id} uses ${ch}`).toBe(true);
      }
      expect(Number.isInteger(f.ox) && Number.isInteger(f.oy)).toBe(true);
    }
    expect('.' in acc.palette).toBe(false);
  });

  it('treats have 3 bite frames, wearables 1', () => {
    for (const id of IDS) {
      if (id === 'laptop') continue;
      const treat = id === 'pepero' || id === 'chocolate' || id === 'candy';
      expect(ACCESSORIES[id].frames).toHaveLength(treat ? 3 : 1);
      if (treat) expect(ACCESSORIES[id].anchor).toBe('hand');
      expect(ACCESSORIES[id].frameBy ?? 'bite').toBe('bite');
    }
  });

  it('laptop: on the front anchor behind the body, one size, code changes every frame', () => {
    const lap = ACCESSORIES.laptop;
    expect(lap.anchor).toBe('front');
    expect(lap.behind).toBe(true);
    expect(lap.frameBy).toBe('tick');
    expect(lap.frames.length).toBeGreaterThanOrEqual(6);
    const size = (f: (typeof lap.frames)[number]) => `${f.rows[0].length}x${f.rows.length}|${f.ox},${f.oy}`;
    lap.frames.forEach((f, i) => {
      expect(size(f)).toBe(size(lap.frames[0]));
      const next = lap.frames[(i + 1) % lap.frames.length];
      expect(f.rows.join('\n'), `frame ${i}`).not.toBe(next.rows.join('\n'));
    });
  });

  it('the scarf is snug: at most one pixel wider than the head each side, short end', () => {
    const f = ACCESSORIES.scarf.frames[0];
    // OCTO's head is 18 wide (sit squash 20); the scarf may overhang by one each side.
    expect(f.rows[0].length).toBeLessThanOrEqual(20);
    expect(f.rows.length - f.oy).toBeLessThanOrEqual(5);
  });

  it('bites get smaller', () => {
    for (const id of ['pepero', 'chocolate', 'candy'] as const) {
      const ink = ACCESSORIES[id].frames.map((f) => f.rows.join('').replace(/\./g, '').length);
      expect(ink[0]).toBeGreaterThan(ink[1]);
      expect(ink[1]).toBeGreaterThan(ink[2]);
    }
  });
});

describe('OCTO anchors', () => {
  it('every frame has head / hand / body / front anchors inside the sprite box', () => {
    const { w, h } = OCTO_PACK.size;
    for (const name of ANIM_NAMES) {
      for (const f of OCTO_PACK.animations[name] ?? []) {
        for (const a of ['head', 'hand', 'body', 'front'] as const) {
          const p = f.anchors?.[a];
          expect(p, `${name} ${a}`).toBeDefined();
          expect(p!.x).toBeGreaterThanOrEqual(0);
          expect(p!.x).toBeLessThanOrEqual(w);
          expect(p!.y).toBeGreaterThanOrEqual(0);
          expect(p!.y).toBeLessThan(h);
        }
      }
    }
  });

  it('head anchor sits on the head outline (its row has outline pixels at the anchor column)', () => {
    for (const name of ['idle', 'walk', 'sit', 'busy', 'wave', 'eat'] as const) {
      for (const f of OCTO_PACK.animations[name] ?? []) {
        const { x, y } = f.anchors!.head!;
        // Normal head: the anchor row is the top outline; squashed head: one row above it.
        const row = f.rows[y][x] === 'o' ? y : y + 1;
        expect(f.rows[row].slice(x - 3, x + 3)).toMatch(/o/);
      }
    }
  });
});

describe('OCTO busy', () => {
  const busy = OCTO_PACK.animations.busy!;
  const total = busy.reduce((sum, f) => sum + f.ms, 0);

  it('loops in about 10 s', () => {
    expect(total).toBeGreaterThanOrEqual(8000);
    expect(total).toBeLessThanOrEqual(12_000);
  });

  it('typing frames reach the keyboard: tentacle pixels on the deck right of the front anchor', () => {
    const lap = ACCESSORIES.laptop.frames[0];
    const typing = busy.filter((f) => f.rows.slice(0, f.anchors!.head!.y).every((r) => !/[^.]/.test(r)));
    expect(typing.length).toBeGreaterThan(busy.length / 2);
    for (const f of typing) {
      const front = f.anchors!.front!;
      // Deck: the laptop's bottom 4 rows; the tentacle tips land on them.
      const deckTop = front.y - lap.oy + lap.rows.length - 4;
      const onDeck = f.rows.slice(deckTop, front.y).some((r) => /[ob]/.test(r.slice(front.x)));
      expect(onDeck).toBe(true);
    }
  });

  it('typing taps: consecutive typing frames differ', () => {
    const distinct = new Set(busy.map((f) => f.rows.join('')));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  it('has a short variant with a tentacle up on the head (scratching)', () => {
    const scratch = busy.filter((f) => f.rows.slice(0, f.anchors!.head!.y).some((r) => /[^.]/.test(r)));
    expect(scratch.length).toBeGreaterThanOrEqual(2);
    const ms = scratch.reduce((sum, f) => sum + f.ms, 0);
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(total / 3);
  });
});

describe('accessoriesFor', () => {
  const cal = (season: PetCalendar['season'], special: PetCalendar['special'] = null): PetCalendar => ({ season, special });

  it('season wearables', () => {
    expect(accessoriesFor(cal('winter'), 'idle')).toEqual(['scarf']);
    expect(accessoriesFor(cal('summer'), 'walk')).toEqual(['sunglasses']);
    expect(accessoriesFor(cal('spring'), 'idle')).toEqual([]);
    expect(accessoriesFor(cal('autumn'), 'idle')).toEqual([]);
  });

  it('christmas: santa hat and suit; the suit takes the scarf body anchor', () => {
    const ids = accessoriesFor(cal('winter', 'christmas'), 'idle');
    expect(ids).toContain('santaHat');
    expect(ids).toContain('santaSuit');
    expect(ids).not.toContain('scarf');
  });

  it('halloween: witch hat and pumpkin', () => {
    expect(accessoriesFor(cal('autumn', 'halloween'), 'walk')).toEqual(['witchHat', 'pumpkin']);
  });

  it('treats only while eating, on top of the season wearable', () => {
    expect(accessoriesFor(cal('autumn', 'pepero'), 'idle')).toEqual([]);
    expect(accessoriesFor(cal('autumn', 'pepero'), 'eat')).toEqual(['pepero']);
    expect(accessoriesFor(cal('winter', 'valentine'), 'idle')).toEqual(['scarf']);
    expect(accessoriesFor(cal('winter', 'valentine'), 'eat')).toEqual(['scarf', 'chocolate']);
    expect(accessoriesFor(cal('spring', 'white'), 'eat')).toEqual(['candy']);
    expect(accessoriesFor(cal('autumn', 'halloween'), 'eat')).not.toContain('pepero');
  });

  it('busy: a laptop on top of the outfit; carried things are put down', () => {
    expect(accessoriesFor(cal('spring'), 'busy')).toEqual(['laptop']);
    expect(accessoriesFor(cal('winter'), 'busy')).toEqual(['scarf', 'laptop']);
    expect(accessoriesFor(cal('autumn', 'halloween'), 'busy')).toEqual(['witchHat', 'laptop']);
    expect(accessoriesFor(cal('spring'), 'idle')).not.toContain('laptop');
    expect(accessoriesFor(cal('autumn', 'pepero'), 'busy')).not.toContain('pepero');
  });

  it('nothing while lying upside down after a slip', () => {
    expect(accessoriesFor(cal('winter', 'christmas'), 'slip')).toEqual([]);
    expect(accessoriesFor(cal('winter'), 'getup')).toEqual(['scarf']);
  });
});

describe('biteFrame', () => {
  it('whole, bitten, almost gone, then stays', () => {
    expect(biteFrame('pepero', 0)).toBe(0);
    expect(biteFrame('pepero', BITE_MS - 1)).toBe(0);
    expect(biteFrame('pepero', BITE_MS)).toBe(1);
    expect(biteFrame('pepero', 2 * BITE_MS)).toBe(2);
    expect(biteFrame('pepero', 99 * BITE_MS)).toBe(2);
    expect(biteFrame('scarf', 5 * BITE_MS)).toBe(0);
  });
});

describe('drawAccessory', () => {
  it('draws runs offset from the anchor at scale', () => {
    const ctx = spyCtx();
    drawAccessory(ctx, 'sunglasses', 0, { x: 100, y: 50 }, 4, false);
    const f = ACCESSORIES.sunglasses.frames[0];
    // First run is the top bar: starts ox pixels left of the anchor, oy rows below (oy < 0).
    expect(ctx.fillRect.mock.calls[0]).toEqual([100 - f.ox * 4, 50 - f.oy * 4, f.rows[0].length * 4, 4]);
  });

  it('mirrors around the anchor when flipped', () => {
    const a = spyCtx();
    const b = spyCtx();
    drawAccessory(a, 'pepero', 0, { x: 100, y: 50 }, 4, false);
    drawAccessory(b, 'pepero', 0, { x: 100, y: 50 }, 4, true);
    const span = (c: ReturnType<typeof spyCtx>) => {
      const xs = c.fillRect.mock.calls.flatMap(([x, , w]) => [x, x + w]);
      return [Math.min(...xs), Math.max(...xs)];
    };
    const [l1, r1] = span(a);
    const [l2, r2] = span(b);
    expect(l2).toBe(200 - r1);
    expect(r2).toBe(200 - l1);
  });

  it('draws nothing without an anchor', () => {
    const ctx = spyCtx();
    drawAccessory(ctx, 'santaHat', 0, undefined, 4, false);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe('drawAccessories', () => {
  const frame = OCTO_PACK.animations.idle[0];

  it('places by the frame anchor and splits behind / front layers', () => {
    const front = spyCtx();
    const behind = spyCtx();
    drawAccessories(front, OCTO_PACK, frame, ['witchHat', 'pumpkin'], 32, 64, 4, false, 0, 'front');
    drawAccessories(behind, OCTO_PACK, frame, ['witchHat', 'pumpkin'], 32, 64, 4, false, 0, 'behind');
    expect(front.fillRect).toHaveBeenCalled();
    expect(behind.fillRect).toHaveBeenCalled();
    const hatFirst = front.fillRect.mock.calls[0];
    const head = frame.anchors!.head!;
    const f = ACCESSORIES.witchHat.frames[0];
    expect(hatFirst[1]).toBe(64 + (head.y - f.oy) * 4);
  });

  it('skips accessories on a pack frame without anchors (user pack)', () => {
    const ctx = spyCtx();
    const bare: PackFrame = { rows: frame.rows, ms: 100 };
    const pack: Pick<CharacterPack, 'size'> = { size: { w: 24, h: 24 } };
    for (const layer of ['front', 'behind'] as const) {
      drawAccessories(ctx, pack, bare, ['santaHat', 'santaSuit', 'pumpkin', 'candy'], 0, 0, 4, false, 0, layer);
    }
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('animated accessories show frame tick % frames (laptop screen)', () => {
    const busy = OCTO_PACK.animations.busy![0];
    const calls = (tick: number) => {
      const ctx = spyCtx();
      const colors: string[] = [];
      ctx.fillRect.mockImplementation(() => colors.push(ctx.fillStyle));
      drawAccessories(ctx, OCTO_PACK, busy, ['laptop'], 0, 0, 4, false, 2, 'behind', tick);
      return JSON.stringify([ctx.fillRect.mock.calls, colors]);
    };
    const n = ACCESSORIES.laptop.frames.length;
    expect(calls(0)).not.toBe('[[],[]]');
    expect(calls(1)).not.toBe(calls(0));
    expect(calls(n)).toBe(calls(0));
    expect(calls(n + 1)).toBe(calls(1));
  });

  it('skips the laptop on a frame without a front anchor', () => {
    const ctx = spyCtx();
    const noFront: PackFrame = { rows: frame.rows, ms: 100, anchors: { head: { x: 12, y: 5 }, hand: { x: 20, y: 20 } } };
    drawAccessories(ctx, OCTO_PACK, noFront, ['laptop'], 0, 0, 4, false, 0, 'behind', 3);
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it('skips only the accessory whose anchor is missing', () => {
    const ctx = spyCtx();
    const headOnly: PackFrame = { rows: frame.rows, ms: 100, anchors: { head: { x: 12, y: 5 } } };
    drawAccessories(ctx, OCTO_PACK, headOnly, ['santaSuit'], 0, 0, 4, false, 0, 'front');
    expect(ctx.fillRect).not.toHaveBeenCalled();
    drawAccessories(ctx, OCTO_PACK, headOnly, ['santaHat'], 0, 0, 4, false, 0, 'front');
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});

describe('headRise', () => {
  it('is the tallest hat rise, 0 without hats', () => {
    expect(headRise([])).toBe(0);
    expect(headRise(['scarf', 'pepero'])).toBe(0);
    expect(headRise(['sunglasses'])).toBe(0);
    expect(headRise(['santaHat'])).toBe(ACCESSORIES.santaHat.frames[0].oy);
    expect(headRise(['witchHat', 'pumpkin'])).toBe(ACCESSORIES.witchHat.frames[0].oy);
  });
});
