import { describe, expect, it } from 'vitest';
import { OCTO_PACK } from './characters/octo';
import { ANIM_NAMES, framesFor, parsePack, REQUIRED_ANIMS, type CharacterPack } from './pack';
import { drawFrame } from './render';

function tinyPack(): Record<string, unknown> {
  const frame = { rows: ['.a', 'a.'], ms: 100 };
  const animations: Record<string, unknown> = {};
  for (const name of REQUIRED_ANIMS) animations[name] = [frame];
  return {
    id: 'tiny',
    name: 'Tiny',
    size: { w: 2, h: 2 },
    scale: 2,
    palette: { a: '#ff0000' },
    animations,
  };
}

function expectError(result: ReturnType<typeof parsePack>, fragment: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(fragment);
}

describe('parsePack', () => {
  it('accepts the bundled OCTO pack', () => {
    const result = parsePack(OCTO_PACK, 'x');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.id).toBe('octo');
  });

  it('accepts a JSON round trip of OCTO (user pack shape)', () => {
    expect(parsePack(JSON.parse(JSON.stringify(OCTO_PACK)), 'x').ok).toBe(true);
  });

  it('uses the fallback id when the pack has none', () => {
    const raw = tinyPack();
    delete raw.id;
    const result = parsePack(raw, 'folder-name');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pack.id).toBe('folder-name');
  });

  it('rejects a pack missing a required animation', () => {
    const raw = tinyPack();
    delete (raw.animations as Record<string, unknown>).walk;
    expectError(parsePack(raw, 'x'), 'walk');
  });

  it('rejects a required animation with no frames', () => {
    const raw = tinyPack();
    (raw.animations as Record<string, unknown>).sleep = [];
    expectError(parsePack(raw, 'x'), 'sleep');
  });

  it('rejects a row shorter than size.w', () => {
    const raw = tinyPack();
    (raw.animations as Record<string, unknown>).idle = [{ rows: ['.a', 'a'], ms: 100 }];
    expectError(parsePack(raw, 'x'), 'row');
  });

  it('rejects a frame with the wrong number of rows', () => {
    const raw = tinyPack();
    (raw.animations as Record<string, unknown>).idle = [{ rows: ['.a'], ms: 100 }];
    expectError(parsePack(raw, 'x'), 'row');
  });

  it('rejects a char that is neither in the palette nor "."', () => {
    const raw = tinyPack();
    (raw.animations as Record<string, unknown>).idle = [{ rows: ['.a', 'aQ'], ms: 100 }];
    expectError(parsePack(raw, 'x'), 'Q');
  });

  it('rejects "." in the palette', () => {
    const raw = tinyPack();
    raw.palette = { a: '#ff0000', '.': '#000000' };
    expectError(parsePack(raw, 'x'), '.');
  });

  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'pack', [], true]) {
      expect(parsePack(bad, 'x').ok).toBe(false);
    }
  });

  it('rejects a bad size or scale', () => {
    const raw = tinyPack();
    raw.size = { w: 0, h: 2 };
    expectError(parsePack(raw, 'x'), 'size');
    const raw2 = tinyPack();
    raw2.scale = -1;
    expectError(parsePack(raw2, 'x'), 'scale');
  });

  it('drops unknown animation names and keeps optional known ones', () => {
    const raw = tinyPack();
    (raw.animations as Record<string, unknown>).dance = [{ rows: ['aa', 'aa'], ms: 100 }];
    (raw.animations as Record<string, unknown>).happy = [{ rows: ['aa', 'aa'], ms: 100 }];
    const result = parsePack(raw, 'x');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('dance' in result.pack.animations).toBe(false);
    expect(result.pack.animations.happy).toHaveLength(1);
  });
});

describe('framesFor', () => {
  it('falls back to idle for a missing optional animation', () => {
    const result = parsePack(tinyPack(), 'x');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pack: CharacterPack = result.pack;
    expect(framesFor(pack, 'happy')).toBe(pack.animations.idle);
  });

  it('returns the animation itself when present', () => {
    expect(framesFor(OCTO_PACK, 'walk')).toBe(OCTO_PACK.animations.walk);
  });
});

describe('OCTO_PACK', () => {
  it('has every frame sized exactly size.w x size.h', () => {
    const { w, h } = OCTO_PACK.size;
    for (const name of ANIM_NAMES) {
      for (const frame of OCTO_PACK.animations[name] ?? []) {
        expect(frame.rows).toHaveLength(h);
        for (const row of frame.rows) expect(row).toHaveLength(w);
      }
    }
  });

  it('is 24x24 at scale 4 with every animation present', () => {
    expect(OCTO_PACK.size).toEqual({ w: 24, h: 24 });
    expect(OCTO_PACK.scale).toBe(4);
    for (const name of ANIM_NAMES) {
      expect(OCTO_PACK.animations[name]?.length ?? 0).toBeGreaterThan(0);
    }
    for (const name of ['idle', 'walk', 'sleep', 'held', 'fall'] as const) {
      expect(OCTO_PACK.animations[name].length).toBeGreaterThanOrEqual(2);
    }
  });

  it('blinks in idle: some idle frames differ', () => {
    const idle = OCTO_PACK.animations.idle.map((f) => f.rows.join('\n'));
    expect(new Set(idle).size).toBeGreaterThan(1);
  });
});

describe('drawFrame', () => {
  function fakeCtx() {
    const rects: Array<[string, number, number, number, number]> = [];
    const ctx = {
      fillStyle: '',
      imageSmoothingEnabled: true,
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push([String(this.fillStyle), x, y, w, h]);
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, rects, raw: ctx };
  }

  const pack: CharacterPack = {
    id: 't',
    name: 't',
    size: { w: 4, h: 1 },
    scale: 3,
    palette: { a: '#111111', b: '#222222' },
    animations: { idle: [], walk: [], sit: [], sleep: [], held: [], fall: [] },
  };
  const frame = { rows: ['aab.'], ms: 100 };

  it('merges runs, skips transparent pixels and disables smoothing', () => {
    const { ctx, rects, raw } = fakeCtx();
    drawFrame(ctx, pack, frame, 10, 20, false);
    expect(raw.imageSmoothingEnabled).toBe(false);
    expect(rects).toEqual([
      ['#111111', 10, 20, 6, 3],
      ['#222222', 16, 20, 3, 3],
    ]);
  });

  it('mirrors horizontally when flipped', () => {
    const { ctx, rects } = fakeCtx();
    drawFrame(ctx, pack, frame, 0, 0, true);
    expect(rects).toEqual([
      ['#111111', 6, 0, 6, 3],
      ['#222222', 3, 0, 3, 3],
    ]);
  });
});
