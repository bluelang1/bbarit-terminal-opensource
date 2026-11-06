import { afterEach, describe, expect, it, vi } from 'vitest';
import { OCTO_PACK } from './characters/octo';
import {
  POS_KEY,
  characterOptions,
  choosePack,
  frameIndexAt,
  loadSavedPos,
  monitorsToAreas,
  petMenuEntries,
  savePos,
} from './page';

const userJson = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...OCTO_PACK, id: 'ignored', name, ...extra });

function memStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('choosePack', () => {
  it('returns the bundled octo by default', () => {
    expect(choosePack('octo', [])).toBe(OCTO_PACK);
  });

  it('a valid user pack with the same id overrides the bundled one; id is the folder name', () => {
    const pack = choosePack('octo', [{ id: 'octo', json: userJson('My Octo') }]);
    expect(pack.name).toBe('My Octo');
    expect(pack.id).toBe('octo');
  });

  it('broken user packs fall back to the default with a warning, never throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(choosePack('mine', [{ id: 'mine', json: '{not json' }])).toBe(OCTO_PACK);
    const noWalk = JSON.parse(userJson('x'));
    delete noWalk.animations.walk;
    expect(choosePack('mine', [{ id: 'mine', json: JSON.stringify(noWalk) }])).toBe(OCTO_PACK);
    expect(choosePack('mine', [{ id: 'mine', json: userJson('x', { palette: {} }) }])).toBe(OCTO_PACK);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[1][0])).toContain('walk');
  });

  it('an unknown id falls back to the default', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(choosePack('nope', [])).toBe(OCTO_PACK);
  });
});

describe('characterOptions', () => {
  it('lists bundled then valid user packs and skips broken ones', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = characterOptions([
      { id: 'bad', json: '[]' },
      { id: 'mine', json: userJson('Mine') },
    ]);
    expect(opts).toEqual([
      { id: 'octo', name: OCTO_PACK.name, user: false },
      { id: 'mine', name: 'Mine', user: true },
    ]);
  });

  it('a user override keeps the bundled slot', () => {
    expect(characterOptions([{ id: 'octo', json: userJson('Mine') }])).toEqual([
      { id: 'octo', name: 'Mine', user: true },
    ]);
  });
});

describe('monitorsToAreas', () => {
  it('uses the work area in logical px', () => {
    const areas = monitorsToAreas([
      {
        position: { x: 0, y: 0 },
        size: { width: 3024, height: 1964 },
        workArea: { position: { x: 0, y: 74 }, size: { width: 3024, height: 1780 } },
        scaleFactor: 2,
      },
      { position: { x: 1512, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    ]);
    expect(areas).toEqual([
      { x: 0, y: 37, w: 1512, h: 890 },
      { x: 1512, y: 0, w: 1920, h: 1080 },
    ]);
  });

  it('drops empty monitors and treats a bad scale as 1', () => {
    expect(
      monitorsToAreas([
        { position: { x: 0, y: 0 }, size: { width: 0, height: 0 }, scaleFactor: 1 },
        { position: { x: 0, y: 0 }, size: { width: 800, height: 600 }, scaleFactor: 0 },
      ]),
    ).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
  });
});

describe('saved position', () => {
  it('round-trips x/y/pinned through storage', () => {
    const s = memStorage();
    savePos(s, { x: 10.4, y: 20.6, pinned: true });
    expect(JSON.parse(s.data[POS_KEY])).toEqual({ x: 10, y: 21, pinned: true });
    expect(loadSavedPos(s)).toEqual({ x: 10, y: 21, pinned: true });
  });

  it('ignores missing, corrupt or throwing storage', () => {
    expect(loadSavedPos(undefined)).toBeUndefined();
    expect(loadSavedPos(memStorage({ [POS_KEY]: '{oops' }))).toBeUndefined();
    expect(loadSavedPos(memStorage({ [POS_KEY]: '{"x":"1","y":2}' }))).toBeUndefined();
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSavedPos(throwing)).toBeUndefined();
    expect(() => savePos(throwing, { x: 1, y: 2, pinned: false })).not.toThrow();
  });
});

describe('frameIndexAt', () => {
  const f = (ms: number) => ({ rows: [], ms });
  it('loops through frames by their durations', () => {
    const frames = [f(100), f(300)];
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 99)).toBe(0);
    expect(frameIndexAt(frames, 100)).toBe(1);
    expect(frameIndexAt(frames, 399)).toBe(1);
    expect(frameIndexAt(frames, 400)).toBe(0);
    expect(frameIndexAt([f(100)], 5000)).toBe(0);
  });
});

describe('petMenuEntries', () => {
  it('lists open, pin toggle, hide, quit in order with stable ids', () => {
    expect(petMenuEntries(false)).toEqual([
      { id: 'pet-menu-open', action: 'open', labelKey: 'pet.menu.open' },
      { id: 'pet-menu-pin', action: 'togglePin', labelKey: 'pet.menu.pin' },
      { id: 'pet-menu-hide', action: 'hide', labelKey: 'pet.menu.hide' },
      { id: 'pet-menu-quit', action: 'quit', labelKey: 'pet.menu.quit' },
    ]);
  });

  it('labels the toggle by the current pin state', () => {
    expect(petMenuEntries(true)[1]).toEqual({ id: 'pet-menu-pin', action: 'togglePin', labelKey: 'pet.menu.unpin' });
  });
});
