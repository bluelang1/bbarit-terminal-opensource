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
  petBubble,
  petOpenTarget,
  petWindowLayout,
  packHeadroomRows,
  BUBBLE_BAND_H,
  BUBBLE_TEXT_MAX,
  BUBBLE_WIN_W,
} from './page';
import { PET_H, PET_W } from './engine';
import type { PetSummary, PetTab } from './summary';

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

  it('plays once and holds the last frame when loop is false', () => {
    const frames = [f(100), f(300)];
    expect(frameIndexAt(frames, 50, false)).toBe(0);
    expect(frameIndexAt(frames, 150, false)).toBe(1);
    expect(frameIndexAt(frames, 400, false)).toBe(1);
    expect(frameIndexAt(frames, 99_999, false)).toBe(1);
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

const tab = (id: string, over: Partial<PetTab> = {}): PetTab => ({ terminalId: id, projectId: 'p', project: 'Proj', tab: `Tab ${id}`, since: 0, ...over });
const NONE: PetSummary = { blocked: [], working: [], unseenDone: 0 };
const LABELS = { needsApproval: 'needs approval', done: 'Done' };

describe('petBubble', () => {
  it('blocked: "<project> · <tab>: needs approval" for the oldest, +N for the rest', () => {
    const s: PetSummary = { ...NONE, blocked: [tab('a'), tab('b'), tab('c')] };
    expect(petBubble(s, 0, null, LABELS)).toEqual({ kind: 'blocked', terminalId: 'a', text: 'Proj · Tab a: needs approval', more: 2 });
    expect(petBubble({ ...NONE, blocked: [tab('a')] }, 0, null, LABELS)?.more).toBe(0);
  });

  it('truncates long text to one line with an ellipsis', () => {
    const s: PetSummary = { ...NONE, blocked: [tab('a', { project: '아주아주긴프로젝트이름입니다정말로', tab: '클로드 새 세션' })] };
    const text = petBubble(s, 0, null, { needsApproval: '승인 필요', done: '완료' })!.text;
    expect(Array.from(text).length).toBe(BUBBLE_TEXT_MAX + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('done: "Done · <tab>" for 10 s after the done event, then nothing', () => {
    const done = { atMs: 1000, event: { terminalId: 'd', turn: 1, project: 'Proj', tab: 'Claude' } };
    expect(petBubble(NONE, 10_999, done, LABELS)).toEqual({ kind: 'done', terminalId: 'd', text: 'Done · Claude', more: 0 });
    expect(petBubble(NONE, 11_001, done, LABELS)).toBeNull();
  });

  it('blocked wins over a fresh done', () => {
    const done = { atMs: 1000, event: { terminalId: 'd', turn: 1, project: 'Proj', tab: 'Claude' } };
    expect(petBubble({ ...NONE, blocked: [tab('a')] }, 2000, done, LABELS)?.kind).toBe('blocked');
  });
});

describe('petOpenTarget', () => {
  it('first blocked, else the latest unseen done, else none', () => {
    expect(petOpenTarget({ ...NONE, blocked: [tab('a'), tab('b')], latestDone: tab('d') })).toBe('a');
    expect(petOpenTarget({ ...NONE, unseenDone: 1, latestDone: tab('d') })).toBe('d');
    expect(petOpenTarget(NONE)).toBeNull();
  });
});

describe('packHeadroomRows', () => {
  it('is the lowest head anchor y over every frame', () => {
    const ys = Object.values(OCTO_PACK.animations).flatMap((fs) => (fs ?? []).map((f) => f.anchors?.head?.y ?? -1));
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(packHeadroomRows(OCTO_PACK)).toBe(Math.min(...ys));
  });

  it('is 0 when a frame has no head anchor', () => {
    const idle = [{ rows: ['a'], ms: 100 }];
    const pack = { ...OCTO_PACK, animations: { ...OCTO_PACK.animations, idle } };
    expect(packHeadroomRows(pack)).toBe(0);
  });
});

describe('petWindowLayout', () => {
  const AREA = { x: 0, y: 25, w: 1440, h: 850 };

  it('without a bubble the window is the body box', () => {
    expect(petWindowLayout({ x: 500, y: 600 }, null, AREA)).toEqual({ x: 500, y: 600, w: PET_W, h: PET_H, bodyLeft: 0, bodyTop: 0 });
  });

  it('with a bubble the window widens around the body and the body stays on the same screen spot', () => {
    const l = petWindowLayout({ x: 500, y: 600 }, { spriteH: 96 }, AREA);
    expect(l.w).toBe(BUBBLE_WIN_W);
    expect(l.h).toBe(PET_H); // 64 px of headroom above a 96 px body fits the bubble
    expect(BUBBLE_BAND_H).toBeLessThanOrEqual(64);
    expect(l.x + l.bodyLeft).toBe(500);
    expect(l.y + l.bodyTop).toBe(600);
    expect(l.bodyLeft).toBe((BUBBLE_WIN_W - PET_W) / 2);
  });

  it('grows upward for a tall body, keeping the body anchored', () => {
    const l = petWindowLayout({ x: 500, y: 600 }, { spriteH: PET_H }, AREA);
    expect(l.h).toBeGreaterThan(PET_H);
    expect(l.y + l.bodyTop).toBe(600);
    expect(l.bodyTop).toBe(l.h - PET_H);
  });

  it('keeps the wider window inside the work area at the screen edges', () => {
    const left = petWindowLayout({ x: 0, y: 600 }, { spriteH: 96 }, AREA);
    expect(left.x).toBe(0);
    expect(left.bodyLeft).toBe(0);
    const right = petWindowLayout({ x: AREA.w - PET_W, y: 600 }, { spriteH: 96 }, AREA);
    expect(right.x + right.w).toBe(AREA.w);
    expect(right.x + right.bodyLeft).toBe(AREA.w - PET_W);
  });
});
