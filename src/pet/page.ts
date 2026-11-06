// Pure helpers for the pet page (src/pages/PetPage.tsx) and its settings:
// pack selection, monitor -> work area conversion, saved position, frame timing,
// Claude bubbles and the window layout that makes room for them.

import { OCTO_PACK } from './characters/octo';
import { parsePack, type CharacterPack, type PackFrame } from './pack';
import { PET_H, PET_W, type PetState, type WorkArea } from './engine';
import { HAPPY_MS, type PetDoneEvent, type PetSummary } from './summary';

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

/** Bubble text is one line: at most this many characters, then "…". */
export const BUBBLE_TEXT_MAX = 28;
/** Pet window width while a bubble shows (the body box stays PET_W wide inside it). */
export const BUBBLE_WIN_W = 300;
/** Room a bubble needs above the body sprite: bubble, tail and a small gap. */
export const BUBBLE_BAND_H = 40;

export type PetBubble = { kind: 'blocked' | 'done'; terminalId: string; text: string; more: number };
export type PetLastDone = { atMs: number; event: PetDoneEvent };

function oneLine(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > BUBBLE_TEXT_MAX ? `${chars.slice(0, BUBBLE_TEXT_MAX).join('')}…` : chars.join('');
}

/**
 * The bubble above the pet: the oldest blocked tab ("<project> · <tab>: needs approval",
 * `more` counts the other blocked tabs), else "Done · <tab>" for HAPPY_MS after a done.
 */
export function petBubble(
  summary: PetSummary,
  nowMs: number,
  lastDone: PetLastDone | null,
  labels: { needsApproval: string; done: string },
): PetBubble | null {
  const first = summary.blocked[0];
  if (first) {
    const where = [first.project, first.tab].filter(Boolean).join(' · ');
    return { kind: 'blocked', terminalId: first.terminalId, text: oneLine(`${where}: ${labels.needsApproval}`), more: summary.blocked.length - 1 };
  }
  if (lastDone) {
    const age = nowMs - lastDone.atMs;
    if (age >= 0 && age < HAPPY_MS) {
      const text = lastDone.event.tab ? `${labels.done} · ${lastDone.event.tab}` : labels.done;
      return { kind: 'done', terminalId: lastDone.event.terminalId, text: oneLine(text), more: 0 };
    }
  }
  return null;
}

/** Tab a double-click opens: first blocked, else the latest unseen done, else none (last active tab). */
export function petOpenTarget(summary: PetSummary): string | null {
  return summary.blocked[0]?.terminalId ?? summary.latestDone?.terminalId ?? null;
}

export type PetWindowLayout = { x: number; y: number; w: number; h: number; bodyLeft: number; bodyTop: number };

/**
 * Window rect for a body box at (body.x, body.y) (the engine's coordinates). Without a
 * bubble the window is the body box. With one it widens to BUBBLE_WIN_W (kept inside the
 * work area) and grows upward when the sprite leaves less than BUBBLE_BAND_H of headroom;
 * bodyLeft/bodyTop place the body box inside the window so it never moves on screen.
 */
export function petWindowLayout(
  body: { x: number; y: number },
  bubble: { spriteH: number } | null,
  area: WorkArea,
): PetWindowLayout {
  const bx = Math.round(body.x);
  const by = Math.round(body.y);
  if (!bubble) return { x: bx, y: by, w: PET_W, h: PET_H, bodyLeft: 0, bodyTop: 0 };
  const w = BUBBLE_WIN_W;
  const headroom = Math.max(0, PET_H - bubble.spriteH);
  const h = PET_H + Math.max(0, BUBBLE_BAND_H - headroom);
  let x = bx - Math.round((w - PET_W) / 2);
  if (area.w >= w) x = Math.min(Math.max(x, Math.round(area.x)), Math.round(area.x + area.w) - w);
  // Never cut the body off: the window always covers the whole body box.
  x = Math.min(Math.max(x, bx + PET_W - w), bx);
  const y = by - (h - PET_H);
  return { x, y, w, h, bodyLeft: bx - x, bodyTop: by - y };
}
