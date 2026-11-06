// Desktop pet window (/pet, label `pet`, created by src-tauri/src/pet.rs).
//
// Renders the configured character pack on a canvas and moves its own window along the
// bottom of the screen with the pure engine in src/pet/engine.ts. The loop runs on
// setTimeout (~12 fps, slower while asleep) and stops while the window is hidden.
// Claude state arrives from the main window as `pet-summary` (src/pet/summary.ts): it sets
// the engine mood, a speech bubble (blocked / just done) and an unseen-done badge. While a
// bubble shows the window widens / grows upward around the body box (petWindowLayout);
// the body stays on the same screen spot.
// Seasons and special days (src/pet/calendar.ts, re-read on show and every minute): the pet
// wears shared accessories by its pack anchors, eats treats on treat days, slips on ice in
// winter, and season particles fall inside the body box (drawn on the same canvas, so they
// never take clicks and stop with the loop).
// Weather (pet.weather, off by default; src/pet/weatherFeed.ts): while on and visible the page
// asks the host for the Mac's location (never the permission prompt; Settings asks) else uses
// the owner's city, polls Open-Meteo every 30 min, and draws src/pet/weatherFx.ts effects and
// the umbrella. Real weather wins over the season particles (weather.ts seasonGate).
// Character tour (Help > Character Tour, pet.rs start_pet_tour -> `pet-tour-start`): plays
// every case scripted in src/pet/showcase.ts with a caption on top, then calls
// `pet_tour_end` and returns to normal life. Clicking the caption or double-clicking the pet
// ends it; its fake bubbles open nothing. Dev builds also play it each time the pet becomes
// visible while localStorage['bbarit.pet.showcase'] = '1' (release builds ignore the key).
// Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { exit } from '@tauri-apps/plugin-process';
import { DEFAULT_PET_CONFIG, normalizePetConfig, type PetConfig, type PetWeatherConfig } from '../config/schema';
import { getTranslation, type Locale, type TranslationKey } from '../i18n';
import {
  PET_H,
  PET_W,
  SLIP_MS,
  clampToWorkArea,
  groundY,
  iceAlpha,
  initialState,
  step,
  type PetState,
  type WorkArea,
} from '../pet/engine';
import { ONE_SHOT_ANIMS, framesFor, type CharacterPack } from '../pet/pack';
import { drawFrame } from '../pet/render';
import { DEBUG_DATE_KEY, calendarFor, petDate, treatFor, type PetCalendar } from '../pet/calendar';
import { ACCESSORIES, accessoriesFor, accessoryRise, biteFrame, drawAccessories, headRise } from '../pet/accessories';
import { seasonGate, type PetLocation, type PetWeather, type PetWeatherNow } from '../pet/weather';
import { createWeatherFeed, type WeatherFeed } from '../pet/weatherFeed';
import {
  createWeatherFx,
  drawWeatherBack,
  drawWeatherFlash,
  drawWeatherFront,
  stepWeather,
  weatherLive,
  type WeatherFx,
} from '../pet/weatherFx';
import {
  MAX_PARTICLES,
  SPAWN_EVERY_MS,
  drawIce,
  drawParticles,
  spawnDizzy,
  spawnFor,
  spawnSleepZ,
  stepParticles,
  type BreathOrigin,
  type Particle,
} from '../pet/particles';
import { ART_PX, BUBBLE_ART, TAIL_ART, TAIL_OVERLAP, petArtStyle } from '../pet/bubbleArt';
import {
  DEFAULT_PACK,
  choosePack,
  frameIndexAt,
  loadSavedPos,
  monitorsToAreas,
  packHeadroomRows,
  petBubble,
  petMenuEntries,
  petOpenTarget,
  petWindowLayout,
  savePos,
  type PetBubble,
  type PetLastDone,
  type PetMenuAction,
  type PetWindowLayout,
  type UserPackJson,
} from '../pet/page';
import { moodFor, type PetSummary } from '../pet/summary';
import { showcaseAt, showcaseBubble, showcaseRequested, type ShowcaseView } from '../pet/showcase';
import './PetPage.css';

const TICK_MS = 83; // ~12 fps
const FALL_TICK_MS = 33;
const DRAG_TICK_MS = 16;
const SLEEP_TICK_MS = 250;
const AREA_REFRESH_MS = 30_000;
const SAVE_EVERY_MS = 2_000;
const CALENDAR_REFRESH_MS = 60_000;
const DRAG_THRESHOLD_PX = 3;
const LOCALES: Locale[] = ['en', 'ko', 'ja', 'zh', 'fr', 'de', 'it', 'es'];
/** Gap between the tail element's bottom (tip + its shadow row) and the head's top row. */
const TAIL_TIP_GAP_PX = 0;
/** Bubble box bottom above the head top: the part of the tail below the bubble, plus the gap. */
const BUBBLE_LIFT_PX = (TAIL_ART.length - TAIL_OVERLAP) * ART_PX + TAIL_TIP_GAP_PX;
const TAIL_W_PX = TAIL_ART[0].length * ART_PX;
const TAIL_H_PX = TAIL_ART.length * ART_PX;
/** Room for the tour caption above everything else while the tour runs. */
const CAPTION_BAND_PX = 18;

function bubbleKey(b: PetBubble | null): string {
  return b ? `${b.kind}|${b.terminalId}|${b.text}|${b.more}` : '';
}

function labelsFor(locale: Locale) {
  return { needsApproval: getTranslation(locale, 'pet.bubble.needsApproval'), done: getTranslation(locale, 'pet.bubble.done') };
}

type Drag = {
  /** Pointer offset inside the window at pointerdown (window top-left = screen - offset). */
  offX: number;
  offY: number;
  startX: number;
  startY: number;
  active: boolean;
  x: number;
  y: number;
};

type Runtime = {
  state: PetState | null;
  pack: CharacterPack;
  mode: PetConfig['mode'];
  areas: WorkArea[];
  areasAt: number;
  visible: boolean;
  timer: number | null;
  last: number;
  animElapsed: number;
  drawnKey: string;
  lastPos: { x: number; y: number } | null;
  lastSize: { w: number; h: number } | null;
  layout: PetWindowLayout;
  /** Drawn sprite size inside the body box (bottom-centered); headInset = blank px above the head. */
  sprite: { w: number; h: number; headInset: number };
  summary: PetSummary;
  lastDone: PetLastDone | null;
  bubble: PetBubble | null;
  labels: { needsApproval: string; done: string };
  drag: Drag | null;
  activity: boolean;
  menuOpen: boolean;
  savedAt: number;
  savedKey: string;
  cal: PetCalendar;
  calAt: number;
  particles: Particle[];
  spawnAcc: number;
  /** Dizzy stars already spawned for the current slip. */
  dizzy: boolean;
  /** Where winter breath puffs start (set by draw from the frame's body anchor). */
  breath: BreathOrigin | null;
  /** Where sleep Zs start (above the head, hat included) while asleep; set by draw. */
  zzz: BreathOrigin | null;
  /** The last paint had particles or ice, so the next one must clear them. */
  paintedLive: boolean;
  /** Character tour: time played and the spot it started on (set on its first tick). */
  tour: { elapsedMs: number; origin: { x: number; y: number } | null } | null;
  /** What the tour shows this tick (calendar, fake summary, caption); null outside it. */
  tourView: ShowcaseView | null;
  /** Badge count on screen (real summary, or the tour's fake one). */
  badge: number;
  /** i18n key of the tour caption on screen (translated at render, in the app language). */
  caption: TranslationKey | null;
  /** pet.weather from config (re-read on show). */
  weatherCfg: PetWeatherConfig;
  feed: WeatherFeed;
  fx: WeatherFx;
  /** Weather drawn on the last tick (kind|heavy|night), to repaint when it changes. */
  weatherKey: string;
  endTour: () => void;
  kick: () => void;
  persist: () => void;
  relayout: () => void;
};

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Debug builds only: localStorage['bbarit.pet.showcase'] = '1' (src/pet/showcase.ts). */
function wantsShowcase(): boolean {
  return import.meta.env.DEV && showcaseRequested(true, safeStorage());
}

/** Debug builds only: localStorage['bbarit.pet.debugDate'] = 'YYYY-MM-DD' (src/pet/calendar.ts petDate). */
function debugDate(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return safeStorage()?.getItem(DEBUG_DATE_KEY) ?? null;
  } catch {
    return null;
  }
}

function currentCalendar(): PetCalendar {
  return calendarFor(petDate(new Date(), debugDate(), import.meta.env.DEV));
}

export default function PetPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const rtRef = useRef<Runtime | null>(null);
  const [dragging, setDragging] = useState(false);
  const [locale, setLocale] = useState<Locale>('en');
  const [bubble, setBubble] = useState<PetBubble | null>(null);
  const [unseenDone, setUnseenDone] = useState(0);
  const [caption, setCaption] = useState<TranslationKey | null>(null);
  // Pixel-art images for the bubble, tail and badges, rendered once (null without a canvas).
  const [artStyle] = useState(() =>
    petArtStyle(window.devicePixelRatio, () => document.createElement('canvas')),
  );

  useEffect(() => {
    const tauri = isTauri();
    const win = tauri ? getCurrentWindow() : null;
    let disposed = false;

    const r: Runtime = {
      state: null,
      pack: DEFAULT_PACK,
      mode: DEFAULT_PET_CONFIG.mode,
      areas: [],
      areasAt: 0,
      // pet.rs: the first pet-visibility event can fire before this listener exists, and
      // the window only loads when it is about to show, so start out visible.
      visible: true,
      timer: null,
      last: 0,
      animElapsed: 0,
      drawnKey: '',
      lastPos: null,
      lastSize: null,
      layout: { x: 0, y: 0, w: PET_W, h: PET_H, bodyLeft: 0, bodyTop: 0 },
      sprite: { w: PET_W, h: PET_H, headInset: 0 },
      summary: { blocked: [], working: [], unseenDone: 0 },
      lastDone: null,
      bubble: null,
      labels: labelsFor('en'),
      drag: null,
      activity: true,
      menuOpen: false,
      savedAt: 0,
      savedKey: '',
      cal: currentCalendar(),
      calAt: performance.now(),
      particles: [],
      spawnAcc: 0,
      dizzy: false,
      breath: null,
      zzz: null,
      paintedLive: false,
      tour: null,
      tourView: null,
      badge: 0,
      caption: null,
      weatherCfg: DEFAULT_PET_CONFIG.weather,
      feed: createWeatherFeed({
        // ask: false: the pet never shows the permission prompt (Settings does).
        locate: () => invoke<PetLocation>('pet_location', { ask: false }),
        fetchNow: (lat, lon) => invoke<PetWeatherNow>('pet_weather_now', { lat, lon }),
        storage: safeStorage(),
      }),
      fx: createWeatherFx(),
      weatherKey: '',
      endTour: () => {},
      kick: () => {},
      persist: () => {},
      relayout: () => {},
    };
    rtRef.current = r;

    const canvas = canvasRef.current;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas) {
      canvas.width = PET_W * dpr;
      canvas.height = PET_H * dpr;
    }

    const persist = () => {
      if (!r.state) return;
      const key = `${Math.round(r.state.x)},${Math.round(r.state.y)},${r.state.pinned}`;
      if (key === r.savedKey) return;
      r.savedKey = key;
      savePos(safeStorage(), r.state);
    };
    r.persist = persist;

    const refreshCalendar = () => {
      r.cal = currentCalendar();
      r.calAt = performance.now();
      r.drawnKey = '';
    };

    // The tour's calendar while it runs, else today's.
    const cal = (): PetCalendar => r.tourView?.cal ?? r.cal;
    // The tour's fake weather while it runs (none outside its weather steps), else the real one.
    const weather = (): PetWeather | null => (r.tour ? r.tourView?.weather ?? null : r.feed.current(Date.now(), r.weatherCfg));
    const weatherOn = (): boolean => (r.tour ? weather() !== null : r.weatherCfg.enabled);

    const loadConfigAndPack = async () => {
      if (!tauri) return;
      let pet = DEFAULT_PET_CONFIG;
      let language: unknown = 'en';
      try {
        const raw = JSON.parse(await invoke<string>('read_config')) as Record<string, unknown> | null;
        pet = normalizePetConfig(raw?.pet);
        language = raw?.language;
      } catch (e) {
        console.warn('[pet] read_config failed, using defaults:', e);
      }
      let userPacks: UserPackJson[] = [];
      try {
        userPacks = await invoke<UserPackJson[]>('pet_list_characters');
      } catch (e) {
        console.warn('[pet] pet_list_characters failed:', e);
      }
      if (disposed) return;
      r.pack = choosePack(pet.character, Array.isArray(userPacks) ? userPacks : []);
      r.mode = pet.mode;
      r.weatherCfg = pet.weather;
      if (r.state) r.state = { ...r.state, mode: pet.mode };
      r.drawnKey = '';
      const loc = LOCALES.includes(language as Locale) ? (language as Locale) : 'en';
      r.labels = labelsFor(loc);
      setLocale(loc);
    };

    const refreshAreas = async () => {
      r.areasAt = performance.now();
      if (!tauri) return;
      try {
        const areas = monitorsToAreas(await availableMonitors());
        if (!disposed && areas.length > 0) r.areas = areas;
      } catch (e) {
        console.warn('[pet] availableMonitors failed:', e);
      }
    };

    const draw = () => {
      if (!ctx || !r.state) return;
      const st = r.state;
      const anim = st.anim;
      const frames = framesFor(r.pack, anim);
      const idx = frameIndexAt(frames, r.animElapsed, !ONE_SHOT_ANIMS.has(anim));
      const frame = frames[idx];
      const flip = st.dir === -1;
      const wx = weather();
      const ids = accessoriesFor(cal(), anim, wx);
      const treat = ids.find((id) => ACCESSORIES[id].frames.length > 1 && ACCESSORIES[id].frameBy !== 'tick');
      const bite = treat ? biteFrame(treat, r.animElapsed) : 0;
      // The ice lies on the ground: only drawn while the body box is on it.
      const onGround = !st.pinned && anim !== 'held' && anim !== 'fall';
      const ice = onGround ? iceAlpha(st.ice) : 0;
      const live = r.particles.length > 0 || ice > 0 || weatherLive(r.fx, wx);
      const key = `${r.pack.id}|${anim}|${idx}|${flip}|${ids.join(',')}|${bite}|${r.weatherKey}`;
      if (key === r.drawnKey && !live && !r.paintedLive) return;
      r.drawnKey = key;
      r.paintedLive = live;
      // Oversized user packs are scaled down to fit the window instead of being cut off.
      const scale = Math.max(
        1,
        Math.min(r.pack.scale, Math.floor(PET_W / r.pack.size.w), Math.floor(PET_H / r.pack.size.h)),
      );
      const pack = scale === r.pack.scale ? r.pack : { ...r.pack, scale };
      const pw = pack.size.w * scale;
      const ph = pack.size.h * scale;
      // Today's hat or the umbrella sticks out above the head: keep the bubble clear of it
      // (packs with head anchors only; others never draw them).
      const idleFrame = framesFor(r.pack, 'idle')[0];
      const rise = idleFrame ? accessoryRise(idleFrame, accessoriesFor(cal(), 'idle', wx)) : 0;
      const headInset = (packHeadroomRows(r.pack) - rise) * scale;
      if (r.sprite.w !== pw || r.sprite.h !== ph || r.sprite.headInset !== headInset) {
        r.sprite = { w: pw, h: ph, headInset };
        applyDom(r.layout);
      }
      const x0 = Math.round((PET_W - pw) / 2);
      const y0 = PET_H - ph;
      const at = (a: { x: number; y: number }) => ({ x: x0 + (flip ? pack.size.w - a.x : a.x) * scale, y: y0 + a.y * scale });
      const body = frame.anchors?.body;
      if (body && anim !== 'slip' && anim !== 'getup') {
        const p = at(body);
        const dir = flip ? -1 : 1;
        r.breath = { x: p.x + dir * pw * 0.42, y: p.y - 10, dir };
      } else {
        r.breath = null;
      }
      const head = frame.anchors?.head;
      if (head && anim === 'sleep') {
        const p = at(head);
        r.zzz = { x: p.x, y: p.y - headRise(ids) * scale, dir: flip ? -1 : 1 };
      } else {
        r.zzz = null;
      }
      // Dizzy stars circle above the pet once it has landed on its back.
      if (anim === 'slip' && !r.dizzy && frames.length > 1 && r.animElapsed >= frames[0].ms) {
        r.dizzy = true;
        const head = frame.anchors?.head;
        const cy = head ? at(head).y - 8 : y0 + ph / 3;
        r.particles.push(...spawnDizzy(PET_W / 2, cy, Math.max(300, SLIP_MS - r.animElapsed)));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, PET_W, PET_H);
      if (ice > 0 && st.ice) drawIce(ctx, st.ice.x - st.x, PET_H, ice);
      drawWeatherBack(ctx, r.fx, wx, st.x, PET_W, PET_H);
      drawParticles(ctx, r.particles, ART_PX, false);
      drawAccessories(ctx, pack, frame, ids, x0, y0, scale, flip, bite, 'behind', idx);
      drawFrame(ctx, pack, frame, x0, y0, flip);
      drawAccessories(ctx, pack, frame, ids, x0, y0, scale, flip, bite, 'front', idx);
      drawParticles(ctx, r.particles, ART_PX, true);
      drawWeatherFront(ctx, r.fx, wx, st.x, PET_W, PET_H);
      drawWeatherFlash(ctx, r.fx, PET_W, PET_H);
    };

    // Season particles: step every tick, maybe spawn one every SPAWN_EVERY_MS (capped).
    const updateParticles = (dt: number) => {
      if (r.state?.anim !== 'slip') {
        r.dizzy = false;
        if (r.particles.some((p) => p.kind === 'star')) r.particles = r.particles.filter((p) => p.kind !== 'star');
      }
      if (r.state?.anim !== 'sleep' && r.particles.some((p) => p.kind === 'zzz')) {
        r.particles = r.particles.filter((p) => p.kind !== 'zzz');
      }
      r.particles = stepParticles(r.particles, dt, PET_W, PET_H);
      if (r.state?.anim === 'sleep' && r.zzz) {
        const z = spawnSleepZ(r.particles, r.zzz, r.zzz.dir);
        if (z) r.particles.push(z);
      }
      r.spawnAcc = Math.min(r.spawnAcc + dt, 4 * SPAWN_EVERY_MS);
      while (r.spawnAcc >= SPAWN_EVERY_MS) {
        r.spawnAcc -= SPAWN_EVERY_MS;
        if (r.particles.length >= MAX_PARTICLES) continue;
        const p = spawnFor(cal(), Math.random, PET_W, PET_H, r.breath, seasonGate(weatherOn(), weather()));
        if (p) r.particles.push(p);
      }
    };

    // Weather: poll (never during the tour, which fakes it), then step the effects.
    const updateWeather = (dt: number) => {
      const st = r.state;
      if (!st) return;
      if (tauri && !r.tour) r.feed.tick(Date.now(), r.weatherCfg);
      const wx = weather();
      const key = wx ? `${wx.kind}|${wx.heavy}|${wx.night}` : '';
      if (key !== r.weatherKey) {
        // The tour switches weather every few seconds: start each one fresh, sun / flash soon.
        if (r.tour) r.fx = { ...createWeatherFx(), skyInMs: 400, flashInMs: 1500 };
        r.weatherKey = key;
        r.drawnKey = '';
      }
      const grounded = !st.pinned && st.anim !== 'held' && st.anim !== 'fall';
      stepWeather(r.fx, {
        weather: wx,
        dtMs: dt,
        rand: Math.random,
        w: PET_W,
        h: PET_H,
        originX: st.x,
        feetX: PET_W / 2,
        walking: grounded && st.anim === 'walk',
        grounded,
      });
    };

    // Place the body box, bubble, tail and badge inside the window (window px). The body
    // box always sits on the window's bottom edge.
    const applyDom = (l: PetWindowLayout) => {
      if (canvas) {
        canvas.style.left = `${l.bodyLeft}px`;
        canvas.style.top = `${l.bodyTop}px`;
      }
      // The sprite is drawn on the body box bottom, so its top is sprite.h above the window
      // bottom; the bubble's tail and the badge go by the head, below the blank top rows.
      const headTop = r.sprite.h - r.sprite.headInset;
      const center = l.bodyLeft + PET_W / 2;
      const b = bubbleRef.current;
      // The tail's tip column sits on the character's center, inside the bubble's straight
      // bottom edge (never under a rounded corner).
      let tailLeft = Math.round(center - ART_PX / 2);
      if (b) {
        const bw = b.offsetWidth;
        const left = Math.max(2, Math.min(Math.round(center - bw / 2), l.w - bw - 2));
        b.style.left = `${left}px`;
        b.style.bottom = `${headTop + BUBBLE_LIFT_PX}px`;
        const minTail = left + BUBBLE_ART.slice.left * ART_PX;
        const maxTail = left + bw - BUBBLE_ART.slice.right * ART_PX - TAIL_W_PX;
        tailLeft = Math.max(minTail, Math.min(tailLeft, maxTail));
      }
      const tail = tailRef.current;
      if (tail) {
        tail.style.left = `${tailLeft}px`;
        tail.style.bottom = `${headTop + BUBBLE_LIFT_PX - TAIL_H_PX + TAIL_OVERLAP * ART_PX}px`;
      }
      const badge = badgeRef.current;
      if (badge) {
        badge.style.left = `${Math.round(center + r.sprite.w / 2 - 10)}px`;
        badge.style.bottom = `${headTop - 22}px`;
      }
    };
    r.relayout = () => applyDom(r.layout);

    const move = () => {
      if (!r.state) return;
      const area = clampToWorkArea(r.state.x, r.state.y, r.areas).area;
      const l = petWindowLayout(
        r.state,
        r.bubble ? { spriteH: r.sprite.h - r.sprite.headInset } : null,
        area,
        r.tour ? CAPTION_BAND_PX : 0,
      );
      r.layout = l;
      const posChanged = !r.lastPos || r.lastPos.x !== l.x || r.lastPos.y !== l.y;
      const sizeChanged = !r.lastSize || r.lastSize.w !== l.w || r.lastSize.h !== l.h;
      r.lastPos = { x: l.x, y: l.y };
      r.lastSize = { w: l.w, h: l.h };
      if (!win) {
        applyDom(l);
        return;
      }
      if (sizeChanged) {
        // Move the body inside the window only once the window has its new rect, so the
        // character does not jump for a frame.
        void Promise.all([win.setSize(new LogicalSize(l.w, l.h)), win.setPosition(new LogicalPosition(l.x, l.y))])
          .catch(() => {})
          .finally(() => applyDom(r.layout));
        return;
      }
      if (posChanged) win.setPosition(new LogicalPosition(l.x, l.y)).catch(() => {});
      applyDom(l);
    };

    // Bubble / badge from the latest summary (the tour's fake one while it runs); React
    // state only changes when they do.
    const refreshBubble = () => {
      const v = r.tourView;
      const next = v ? showcaseBubble(v, r.labels) : petBubble(r.summary, Date.now(), r.lastDone, r.labels);
      const badge = v ? v.summary.unseenDone : r.summary.unseenDone;
      if (badge !== r.badge) {
        r.badge = badge;
        setUnseenDone(badge);
      }
      if (bubbleKey(next) === bubbleKey(r.bubble)) return;
      r.bubble = next;
      setBubble(next);
    };

    const setTourCaption = (next: TranslationKey | null) => {
      if (next === r.caption) return;
      r.caption = next;
      setCaption(next);
    };

    // (Re)start the tour from its first step, at `spot` (window top-left, logical px) when
    // the host gives one. Before the first state exists the page asks pet_tour_active itself.
    const startTour = (spot: { x: number; y: number } | null) => {
      if (!r.state) return;
      if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) {
        r.state = { ...r.state, x: spot.x, y: spot.y, pinned: false, anim: 'idle', vy: 0, actionMs: 0, ice: null };
      }
      r.tour = { elapsedMs: 0, origin: null };
      r.tourView = null;
      r.drag = null;
      setDragging(false);
      r.activity = true;
      start();
      r.kick();
    };

    // Back to normal life on the tour's starting spot (also when the owner ends it early).
    const endTour = () => {
      const tour = r.tour;
      if (!tour) return;
      r.tour = null;
      r.tourView = null;
      r.fx = createWeatherFx();
      setTourCaption(null);
      if (r.state && tour.origin) {
        r.state = { ...r.state, anim: 'idle', x: tour.origin.x, y: tour.origin.y, vy: 0, actionMs: 0, ice: null };
      }
      r.animElapsed = 0;
      r.activity = true;
      r.drawnKey = '';
      refreshBubble();
      r.kick();
      // The host drops its "show for the tour" override and re-applies the normal rules.
      if (tauri) void invoke('pet_tour_end').catch((e) => console.warn('[pet] pet_tour_end failed:', e));
    };
    r.endTour = endTour;

    // One tour tick: pose the pet from the script instead of stepping the engine. False
    // when no tour runs (or it just ended), so the caller steps the engine as usual.
    const tourTick = (dt: number): boolean => {
      const tour = r.tour;
      const st = r.state;
      if (!tour || !st) return false;
      // The owner grabbed the pet: the tour is over.
      if (r.drag?.active) {
        endTour();
        return false;
      }
      tour.elapsedMs += dt;
      const v = showcaseAt(tour.elapsedMs);
      if (!v) {
        endTour();
        return false;
      }
      const area = clampToWorkArea(st.x, st.y, r.areas).area;
      if (!tour.origin) {
        tour.origin = { x: st.x, y: st.pinned ? st.y : Math.max(area.y, groundY(area)) };
      }
      const o = tour.origin;
      const x = Math.min(Math.max(o.x + v.dx, area.x), Math.max(area.x, area.x + area.w - PET_W));
      const iceX = o.x + PET_W / 2;
      const ice = v.ice ? { x: iceX + v.ice.dx, ms: v.ice.ms, used: v.ice.used } : null;
      const restart = v.index !== r.tourView?.index || v.anim !== st.anim;
      r.state = { ...st, anim: v.anim, dir: v.dir, x, y: o.y - v.dy, vy: 0, actionMs: 0, idleMs: 0, ice };
      r.animElapsed = restart ? 0 : r.animElapsed + dt;
      if (v.cal && (v.cal.season !== r.tourView?.cal?.season || v.cal.special !== r.tourView?.cal?.special)) {
        r.drawnKey = '';
      }
      r.tourView = v;
      setTourCaption(v.captionKey);
      return true;
    };

    const nextDelay = (): number => {
      const anim = r.state?.anim;
      if (r.drag?.active || anim === 'held') return DRAG_TICK_MS;
      if (anim === 'fall') return FALL_TICK_MS;
      // Falling petals / snow keep their frame rate while the pet sleeps; its slow Zs do not need it.
      if (anim === 'sleep' && r.particles.every((p) => p.kind === 'zzz') && !weatherLive(r.fx, weather())) return SLEEP_TICK_MS;
      return TICK_MS;
    };

    const tick = () => {
      r.timer = null;
      if (disposed || !r.visible || document.hidden || !r.state) return;
      const now = performance.now();
      const dt = now - r.last;
      r.last = now;
      if (now - r.areasAt > AREA_REFRESH_MS) void refreshAreas();
      if (now - r.calAt > CALENDAR_REFRESH_MS) refreshCalendar();

      if (r.menuOpen) {
        r.animElapsed += dt;
      } else if (tourTick(dt)) {
        // posed by the showcase script
      } else {
        const prevAnim = r.state.anim;
        r.state = step(r.state, {
          dtMs: dt,
          areas: r.areas,
          rand: Math.random,
          dragging: r.drag?.active ? { x: r.drag.x, y: r.drag.y } : null,
          activity: r.activity,
          mood: moodFor(r.summary, Date.now(), r.lastDone?.atMs ?? null),
          treat: treatFor(r.cal.special) !== null,
          icy: r.cal.season === 'winter',
        });
        r.activity = false;
        r.animElapsed = r.state.anim === prevAnim ? r.animElapsed + dt : 0;
      }
      refreshBubble();
      updateParticles(dt);
      updateWeather(dt);
      draw();
      move();
      const settled = r.state.anim !== 'held' && r.state.anim !== 'fall';
      if (settled && !r.tour && now - r.savedAt > SAVE_EVERY_MS) {
        r.savedAt = now;
        persist();
      }
      r.timer = window.setTimeout(tick, nextDelay());
    };

    const stop = () => {
      if (r.timer !== null) window.clearTimeout(r.timer);
      r.timer = null;
      persist();
    };

    const start = () => {
      if (disposed || r.timer !== null || !r.visible || document.hidden || !r.state) return;
      // Fresh clock: time spent hidden must not count as idle time or physics.
      r.last = performance.now();
      r.timer = window.setTimeout(tick, 0);
    };

    // Run the next tick now (drag start, release) instead of waiting out a slow tick.
    r.kick = () => {
      if (r.timer === null) return;
      window.clearTimeout(r.timer);
      r.timer = window.setTimeout(tick, 0);
    };

    const onDocVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      refreshCalendar();
      start();
    };
    document.addEventListener('visibilitychange', onDocVisibility);
    window.addEventListener('pagehide', persist);

    const unlistenSummary = tauri
      ? listen<PetSummary>('pet-summary', (e) => {
          const p = e.payload;
          if (disposed || !p || !Array.isArray(p.blocked) || !Array.isArray(p.working)) return;
          const { doneEvent, ...summary } = p;
          r.summary = { ...summary, unseenDone: Number(summary.unseenDone) || 0 };
          // A turn that finished while the pet was away is not celebrated later.
          if (doneEvent && r.visible) r.lastDone = { atMs: Date.now(), event: doneEvent };
          refreshBubble();
          r.kick();
        })
      : null;
    // Ask main for the current summary once the listener is in place (the first
    // pet-visibility can arrive before this page has loaded).
    void unlistenSummary?.then(() => emitTo('main', 'pet-summary-request')).catch(() => {});

    const unlistenVisibility = tauri
      ? listen<{ visible: boolean }>('pet-visibility', (e) => {
          if (disposed) return;
          r.visible = e.payload?.visible === true;
          if (r.visible) {
            // The owner just put BBARIT away: the pet wakes up, picks up settings changes.
            r.activity = true;
            refreshCalendar();
            void loadConfigAndPack();
            void refreshAreas();
            if (wantsShowcase()) startTour(null);
            start();
          } else {
            r.drag = null;
            setDragging(false);
            // Hidden mid-tour (the owner hid the pet, main closed): the tour is over.
            endTour();
            stop();
          }
        })
      : null;

    type TourStart = { spot: { x: number; y: number } | null };
    const unlistenTour = tauri
      ? listen<TourStart>('pet-tour-start', (e) => {
          if (disposed) return;
          startTour(e.payload?.spot ?? null);
        })
      : null;

    void (async () => {
      await Promise.all([loadConfigAndPack(), refreshAreas()]);
      // A hide event can arrive before the listener above is attached (minimize + restore
      // during the first load); ask the window itself so a hidden pet never starts its loop.
      if (tauri) {
        await unlistenVisibility?.catch(() => undefined);
        try {
          r.visible = await getCurrentWindow().isVisible();
        } catch {
          // keep the optimistic default
        }
      }
      if (disposed) return;
      const saved = loadSavedPos(safeStorage());
      r.state = initialState(r.areas, { ...saved, mode: r.mode });
      // Loaded for a tour (its start event may have fired before the listener existed).
      let tour: TourStart | null = null;
      if (tauri) {
        await unlistenTour?.catch(() => undefined);
        try {
          tour = await invoke<TourStart | null>('pet_tour_active');
        } catch (e) {
          console.warn('[pet] pet_tour_active failed:', e);
        }
      }
      if (disposed) return;
      if (tour) startTour(tour.spot ?? null);
      else if (wantsShowcase()) startTour(null);
      start();
    })();

    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onDocVisibility);
      window.removeEventListener('pagehide', persist);
      void unlistenVisibility?.then((un) => un()).catch(() => {});
      void unlistenSummary?.then((un) => un()).catch(() => {});
      void unlistenTour?.then((un) => un()).catch(() => {});
      if (rtRef.current === r) rtRef.current = null;
    };
  }, []);

  const t = (key: TranslationKey) => getTranslation(locale, key);

  // The bubble's width is only known once rendered: place it (and the badge) right away.
  useLayoutEffect(() => {
    rtRef.current?.relayout();
  }, [bubble, unseenDone]);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = rtRef.current;
    if (!r?.state || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    // Offsets are relative to the body box (the canvas), which may sit inside a wider window.
    const box = e.currentTarget.getBoundingClientRect();
    const offX = e.clientX - box.left;
    const offY = e.clientY - box.top;
    r.drag = {
      offX,
      offY,
      startX: e.screenX,
      startY: e.screenY,
      active: false,
      x: e.screenX - offX,
      y: e.screenY - offY,
    };
    r.activity = true;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = rtRef.current;
    const d = r?.drag;
    if (!r || !d) return;
    if (!d.active) {
      if (Math.hypot(e.screenX - d.startX, e.screenY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.active = true;
      setDragging(true);
      r.kick();
    }
    d.x = e.screenX - d.offX;
    d.y = e.screenY - d.offY;
  };

  const endDrag = () => {
    const r = rtRef.current;
    if (!r?.drag) return;
    const wasActive = r.drag.active;
    r.drag = null;
    r.activity = true;
    if (wasActive) {
      setDragging(false);
      r.kick();
    }
  };

  const openTerminal = (terminalId: string | null) => {
    if (!isTauri()) return;
    void invoke('pet_open_terminal', { terminalId }).catch((e) => console.warn('[pet] pet_open_terminal failed:', e));
  };

  // Blocked tab first, then the latest unseen done, else main's last active tab. During
  // the tour it only ends the tour (its tabs are fake).
  const onDoubleClick = () => {
    const r = rtRef.current;
    if (r?.tour) {
      r.endTour();
      return;
    }
    openTerminal(r ? petOpenTarget(r.summary) : null);
  };

  // Fake tour bubbles open nothing.
  const onBubbleClick = (terminalId: string) => {
    if (rtRef.current?.tour) return;
    openTerminal(terminalId);
  };

  const togglePin = () => {
    const r = rtRef.current;
    if (!r?.state) return;
    // Unpinned above the ground, the engine lets the pet fall back down and walk again.
    r.state = { ...r.state, pinned: !r.state.pinned, actionMs: 0 };
    r.activity = true;
    r.persist();
    r.kick();
  };

  const hidePet = () => {
    if (isTauri()) void invoke('pet_hide').catch((e) => console.warn('[pet] pet_hide failed:', e));
  };

  // Same path as Cmd-Q: app.exit -> RunEvent::Exit, where the PTY holder GOODBYE follows
  // terminal.keepRunningOnQuit (not the "quit and end all terminals" kill_all).
  const quitApp = () => {
    rtRef.current?.persist();
    if (isTauri()) void exit(0).catch((e) => console.warn('[pet] exit failed:', e));
  };

  const menuActions: Record<PetMenuAction, () => void> = {
    open: onDoubleClick,
    togglePin,
    hide: hidePet,
    quit: quitApp,
  };

  // Native context menu: the pet window never takes focus, so an HTML menu could not be
  // dismissed by clicking elsewhere; the OS menu closes on any outside click. On macOS
  // popup() resolves once the menu has closed, so the pet holds still while it is open.
  const onContextMenu = async (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault();
    const r = rtRef.current;
    if (!r?.state || r.menuOpen || !isTauri()) return;
    r.drag = null;
    r.menuOpen = true;
    setDragging(false);
    let menu: Menu | null = null;
    try {
      menu = await Menu.new({
        items: petMenuEntries(r.state.pinned).map((entry) => ({
          id: entry.id,
          text: t(entry.labelKey),
          action: () => menuActions[entry.action](),
        })),
      });
      await menu.popup();
    } catch (err) {
      console.warn('[pet] context menu failed:', err);
    } finally {
      r.menuOpen = false;
      r.kick();
      void menu?.close().catch(() => {});
    }
  };

  return (
    <div
      className={`pet-root${artStyle ? ' pet-art' : ''}`}
      style={(artStyle ?? undefined) as CSSProperties | undefined}
      onContextMenu={onContextMenu}
    >
      <canvas
        ref={canvasRef}
        className={`pet-canvas${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      />
      {bubble && (
        <>
          <button
            ref={bubbleRef}
            type="button"
            className={`pet-bubble ${bubble.kind}`}
            title={t('pet.bubble.open')}
            onClick={() => onBubbleClick(bubble.terminalId)}
          >
            <span className="pet-bubble-text">{bubble.text}</span>
            {bubble.more > 0 && <span className="pet-bubble-more">+{bubble.more}</span>}
          </button>
          <div
            ref={tailRef}
            className="pet-bubble-tail"
            style={{ width: TAIL_W_PX, height: TAIL_H_PX }}
            aria-hidden="true"
          />
        </>
      )}
      {caption && (
        <button type="button" className="pet-caption" title={t('pet.tour.end')} onClick={() => rtRef.current?.endTour()}>
          {t(caption)}
        </button>
      )}
      {unseenDone > 0 && (
        <div ref={badgeRef} className="pet-badge" title={t('pet.badge.unseen')}>
          {unseenDone > 9 ? '9+' : unseenDone}
        </div>
      )}
    </div>
  );
}
