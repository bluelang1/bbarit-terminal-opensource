// Pure helpers for the pet page (src/pages/PetPage.tsx) and its settings:
// pack selection, monitor -> work area conversion, saved position, frame timing.

import { OCTO_PACK } from './characters/octo';
import { parsePack, type CharacterPack, type PackFrame } from './pack';
import type { PetState, WorkArea } from './engine';

/** Shape returned by the `pet_list_characters` command (pet.rs UserPack). */
export type UserPackJson = { id: string; json: string };

export const BUNDLED_PACKS: CharacterPack[] = [OCTO_PACK];
export const DEFAULT_PACK = OCTO_PACK;

/** Parse one user pack; failures are logged and return null (never throw). */
function parseUserPack(u: UserPackJson): CharacterPack | null {
  let raw: unknown;
  try {
    raw = JSON.parse(u.json);
  } catch (e) {
    console.warn(`[pet] skipping user pack "${u.id}": bad JSON (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
  const r = parsePack(raw, u.id);
  if (!r.ok) {
    console.warn(`[pet] skipping user pack "${u.id}": ${r.error}`);
    return null;
  }
  // The folder name is the id the config refers to.
  return { ...r.pack, id: u.id };
}

/**
 * The pack for `characterId`: a valid user pack with that id wins over a bundled one;
 * a broken or unknown id falls back to the default pack.
 */
export function choosePack(characterId: string, userPacks: UserPackJson[]): CharacterPack {
  const user = userPacks.find((u) => u.id === characterId);
  if (user) {
    const pack = parseUserPack(user);
    if (pack) return pack;
  }
  const bundled = BUNDLED_PACKS.find((p) => p.id === characterId);
  if (bundled) return bundled;
  if (!user) console.warn(`[pet] unknown character "${characterId}", using ${DEFAULT_PACK.id}`);
  return DEFAULT_PACK;
}

export type CharacterOption = { id: string; name: string; user: boolean };

/** Characters for the settings select: bundled first, then valid user packs (overrides keep the bundled slot). */
export function characterOptions(userPacks: UserPackJson[]): CharacterOption[] {
  const out: CharacterOption[] = BUNDLED_PACKS.map((p) => ({ id: p.id, name: p.name, user: false }));
  for (const u of userPacks) {
    const pack = parseUserPack(u);
    if (!pack) continue;
    const i = out.findIndex((o) => o.id === u.id);
    const opt = { id: u.id, name: pack.name, user: true };
    if (i >= 0) out[i] = opt;
    else out.push(opt);
  }
  return out;
}

type Pos = { x: number; y: number };
type Sz = { width: number; height: number };
export type MonitorLike = {
  position: Pos;
  size: Sz;
  workArea?: { position: Pos; size: Sz } | null;
  scaleFactor: number;
};

/** Monitors (physical px) -> work areas (logical px). Uses workArea when present. */
export function monitorsToAreas(monitors: MonitorLike[]): WorkArea[] {
  const out: WorkArea[] = [];
  for (const m of monitors) {
    const scale = Number.isFinite(m.scaleFactor) && m.scaleFactor > 0 ? m.scaleFactor : 1;
    const wa = m.workArea && m.workArea.size.width > 0 && m.workArea.size.height > 0 ? m.workArea : null;
    const pos = wa ? wa.position : m.position;
    const size = wa ? wa.size : m.size;
    const a = { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
    if ([a.x, a.y, a.w, a.h].every(Number.isFinite) && a.w > 0 && a.h > 0) out.push(a);
  }
  return out;
}

export const POS_KEY = 'bbarit.pet.pos';
export type SavedPos = Pick<PetState, 'x' | 'y' | 'pinned'>;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSavedPos(storage: StorageLike | undefined): SavedPos | undefined {
  try {
    const raw = storage?.getItem(POS_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return undefined;
    return { x: v.x as number, y: v.y as number, pinned: v.pinned === true };
  } catch {
    return undefined;
  }
}

export function savePos(storage: StorageLike | undefined, p: SavedPos): void {
  try {
    storage?.setItem(POS_KEY, JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y), pinned: p.pinned }));
  } catch {
    /* storage unavailable: position just is not remembered */
  }
}

/** Index of the frame showing `elapsedMs` into a looping animation. */
export function frameIndexAt(frames: PackFrame[], elapsedMs: number): number {
  if (frames.length <= 1) return 0;
  const total = frames.reduce((sum, f) => sum + f.ms, 0);
  if (!(total > 0)) return 0;
  let t = ((elapsedMs % total) + total) % total;
  for (let i = 0; i < frames.length; i++) {
    if (t < frames[i].ms) return i;
    t -= frames[i].ms;
  }
  return frames.length - 1;
}

export type PetMenuAction = 'open' | 'togglePin' | 'hide' | 'quit';
export type PetMenuLabelKey = 'pet.menu.open' | 'pet.menu.pin' | 'pet.menu.unpin' | 'pet.menu.hide' | 'pet.menu.quit';
export type PetMenuEntry = { id: string; action: PetMenuAction; labelKey: PetMenuLabelKey };

/**
 * Items of the pet's native right-click menu, top to bottom. Ids are stable (and prefixed
 * so they never match the app menu's ids in main.rs on_menu_event).
 */
export function petMenuEntries(pinned: boolean): PetMenuEntry[] {
  return [
    { id: 'pet-menu-open', action: 'open', labelKey: 'pet.menu.open' },
    { id: 'pet-menu-pin', action: 'togglePin', labelKey: pinned ? 'pet.menu.unpin' : 'pet.menu.pin' },
    { id: 'pet-menu-hide', action: 'hide', labelKey: 'pet.menu.hide' },
    { id: 'pet-menu-quit', action: 'quit', labelKey: 'pet.menu.quit' },
  ];
}
