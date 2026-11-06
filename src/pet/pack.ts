// Character pack format for the desktop pet.
//
// A pack is a set of pixel-grid animations. Each frame is `size.h` row strings
// of `size.w` chars; every char is a palette key, and '.' is always
// transparent. Bundled packs are TS modules (characters/), user packs are
// ~/.config/octo/characters/<id>/character.json and go through parsePack.

export type AnimName =
  | 'idle'
  | 'walk'
  | 'sit'
  | 'sleep'
  | 'held'
  | 'fall'
  | 'happy'
  | 'busy'
  | 'wave'
  | 'eat';

export const ANIM_NAMES: AnimName[] = ['idle', 'walk', 'sit', 'sleep', 'held', 'fall', 'happy', 'busy', 'wave', 'eat'];

export const REQUIRED_ANIMS = ['idle', 'walk', 'sit', 'sleep', 'held', 'fall'] as const satisfies readonly AnimName[];
export type RequiredAnim = (typeof REQUIRED_ANIMS)[number];

export type AnchorName = 'head' | 'hand' | 'body';
export type Anchor = { x: number; y: number };

export type PackFrame = {
  rows: string[];
  ms: number;
  anchors?: Partial<Record<AnchorName, Anchor>>;
};

/** Required animations are always present; optional ones fall back to idle via framesFor. */
export type PackAnimations = Record<RequiredAnim, PackFrame[]> & Partial<Record<AnimName, PackFrame[]>>;

export type CharacterPack = {
  id: string;
  name: string;
  size: { w: number; h: number };
  scale: number;
  palette: Record<string, string>;
  animations: PackAnimations;
};

export type ParseResult = { ok: true; pack: CharacterPack } | { ok: false; error: string };

export const TRANSPARENT = '.';
const DEFAULT_FRAME_MS = 150;
const MAX_GRID = 128;
const MAX_SCALE = 16;
const ANCHOR_NAMES: AnchorName[] = ['head', 'hand', 'body'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
}

function parseAnchors(raw: unknown): PackFrame['anchors'] {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<AnchorName, Anchor>> = {};
  for (const name of ANCHOR_NAMES) {
    const a = raw[name];
    if (isRecord(a) && Number.isFinite(a.x) && Number.isFinite(a.y)) {
      out[name] = { x: a.x as number, y: a.y as number };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseFrames(
  name: AnimName,
  raw: unknown,
  size: { w: number; h: number },
  palette: Record<string, string>,
): PackFrame[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return `animation ${name} has no frames`;
  const frames: PackFrame[] = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    const where = `${name}[${i}]`;
    if (!isRecord(f) || !Array.isArray(f.rows)) return `${where} has no rows`;
    if (f.rows.length !== size.h) return `${where} has ${f.rows.length} rows, expected ${size.h}`;
    for (let r = 0; r < f.rows.length; r++) {
      const row = f.rows[r];
      if (typeof row !== 'string') return `${where} row ${r} is not a string`;
      if (row.length !== size.w) return `${where} row ${r} has length ${row.length}, expected ${size.w}`;
      for (const ch of row) {
        if (ch !== TRANSPARENT && !(ch in palette)) return `${where} row ${r} uses unknown palette char "${ch}"`;
      }
    }
    const ms = typeof f.ms === 'number' && Number.isFinite(f.ms) && f.ms > 0 ? f.ms : DEFAULT_FRAME_MS;
    const anchors = parseAnchors(f.anchors);
    frames.push(anchors ? { rows: f.rows as string[], ms, anchors } : { rows: f.rows as string[], ms });
  }
  return frames;
}

/** Validate untrusted pack JSON. Never throws. */
export function parsePack(json: unknown, idFallback: string): ParseResult {
  if (!isRecord(json)) return { ok: false, error: 'pack is not an object' };

  const id = typeof json.id === 'string' && json.id.trim() ? json.id.trim() : idFallback;
  const name = typeof json.name === 'string' && json.name.trim() ? json.name.trim() : id;

  const size = json.size;
  if (!isRecord(size) || !isPositiveInt(size.w, MAX_GRID) || !isPositiveInt(size.h, MAX_GRID)) {
    return { ok: false, error: `size must be { w, h } integers in 1..${MAX_GRID}` };
  }
  const grid = { w: size.w, h: size.h };

  const scale = json.scale === undefined ? 4 : json.scale;
  if (!isPositiveInt(scale, MAX_SCALE)) return { ok: false, error: `scale must be an integer in 1..${MAX_SCALE}` };

  if (!isRecord(json.palette)) return { ok: false, error: 'palette is not an object' };
  const palette: Record<string, string> = {};
  for (const [key, color] of Object.entries(json.palette)) {
    if (key === TRANSPARENT) return { ok: false, error: 'palette must not define "." (always transparent)' };
    if (key.length !== 1) return { ok: false, error: `palette key "${key}" must be one char` };
    if (typeof color !== 'string' || !color.trim()) return { ok: false, error: `palette color for "${key}" is not a string` };
    palette[key] = color.trim();
  }

  if (!isRecord(json.animations)) return { ok: false, error: 'animations is not an object' };
  const animations: Partial<Record<AnimName, PackFrame[]>> = {};
  for (const anim of REQUIRED_ANIMS) {
    if (!(anim in json.animations)) return { ok: false, error: `missing required animation ${anim}` };
  }
  for (const anim of ANIM_NAMES) {
    if (!(anim in json.animations)) continue;
    const frames = parseFrames(anim, json.animations[anim], grid, palette);
    if (typeof frames === 'string') return { ok: false, error: frames };
    animations[anim] = frames;
  }

  return {
    ok: true,
    pack: { id, name, size: grid, scale, palette, animations: animations as PackAnimations },
  };
}

/** Frames for `anim`, falling back to idle when the pack does not have it. */
export function framesFor(pack: CharacterPack, anim: AnimName): PackFrame[] {
  const frames = pack.animations[anim];
  return frames && frames.length > 0 ? frames : pack.animations.idle;
}
