// Desktop pet window (/pet, label `pet`, created by src-tauri/src/pet.rs).
//
// Renders the configured character pack on a canvas and moves its own window along the
// bottom of the screen with the pure engine in src/pet/engine.ts. The loop runs on
// setTimeout (~12 fps, slower while asleep) and stops while the window is hidden.
// Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md.

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { exit } from '@tauri-apps/plugin-process';
import { DEFAULT_PET_CONFIG, normalizePetConfig, type PetConfig } from '../config/schema';
import { getTranslation, type Locale, type TranslationKey } from '../i18n';
import { PET_H, PET_W, initialState, step, type PetState, type WorkArea } from '../pet/engine';
import { framesFor, type CharacterPack } from '../pet/pack';
import { drawFrame } from '../pet/render';
import {
  DEFAULT_PACK,
  choosePack,
  frameIndexAt,
  loadSavedPos,
  monitorsToAreas,
  petMenuEntries,
  savePos,
  type PetMenuAction,
  type UserPackJson,
} from '../pet/page';
import './PetPage.css';

const TICK_MS = 83; // ~12 fps
const FALL_TICK_MS = 33;
const DRAG_TICK_MS = 16;
const SLEEP_TICK_MS = 250;
const AREA_REFRESH_MS = 30_000;
const SAVE_EVERY_MS = 2_000;
const DRAG_THRESHOLD_PX = 3;
const LOCALES: Locale[] = ['en', 'ko', 'ja', 'zh', 'fr', 'de', 'it', 'es'];

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
  drag: Drag | null;
  activity: boolean;
  menuOpen: boolean;
  savedAt: number;
  savedKey: string;
  kick: () => void;
  persist: () => void;
};

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export default function PetPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rtRef = useRef<Runtime | null>(null);
  const [dragging, setDragging] = useState(false);
  const [locale, setLocale] = useState<Locale>('en');

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
      drag: null,
      activity: true,
      menuOpen: false,
      savedAt: 0,
      savedKey: '',
      kick: () => {},
      persist: () => {},
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
      if (r.state) r.state = { ...r.state, mode: pet.mode };
      r.drawnKey = '';
      setLocale(LOCALES.includes(language as Locale) ? (language as Locale) : 'en');
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
      const frames = framesFor(r.pack, r.state.anim);
      const idx = frameIndexAt(frames, r.animElapsed);
      const flip = r.state.dir === -1;
      const key = `${r.pack.id}|${r.state.anim}|${idx}|${flip}`;
      if (key === r.drawnKey) return;
      r.drawnKey = key;
      // Oversized user packs are scaled down to fit the window instead of being cut off.
      const scale = Math.max(
        1,
        Math.min(r.pack.scale, Math.floor(PET_W / r.pack.size.w), Math.floor(PET_H / r.pack.size.h)),
      );
      const pack = scale === r.pack.scale ? r.pack : { ...r.pack, scale };
      const pw = pack.size.w * scale;
      const ph = pack.size.h * scale;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, PET_W, PET_H);
      drawFrame(ctx, pack, frames[idx], Math.round((PET_W - pw) / 2), PET_H - ph, flip);
    };

    const move = () => {
      if (!win || !r.state) return;
      const x = Math.round(r.state.x);
      const y = Math.round(r.state.y);
      if (r.lastPos && r.lastPos.x === x && r.lastPos.y === y) return;
      r.lastPos = { x, y };
      win.setPosition(new LogicalPosition(x, y)).catch(() => {});
    };

    const nextDelay = (): number => {
      const anim = r.state?.anim;
      if (r.drag?.active || anim === 'held') return DRAG_TICK_MS;
      if (anim === 'fall') return FALL_TICK_MS;
      if (anim === 'sleep') return SLEEP_TICK_MS;
      return TICK_MS;
    };

    const tick = () => {
      r.timer = null;
      if (disposed || !r.visible || document.hidden || !r.state) return;
      const now = performance.now();
      const dt = now - r.last;
      r.last = now;
      if (now - r.areasAt > AREA_REFRESH_MS) void refreshAreas();

      if (r.menuOpen) {
        r.animElapsed += dt;
      } else {
        const prevAnim = r.state.anim;
        r.state = step(r.state, {
          dtMs: dt,
          areas: r.areas,
          rand: Math.random,
          dragging: r.drag?.active ? { x: r.drag.x, y: r.drag.y } : null,
          activity: r.activity,
          mood: 'none',
        });
        r.activity = false;
        r.animElapsed = r.state.anim === prevAnim ? r.animElapsed + dt : 0;
      }
      draw();
      move();
      const settled = r.state.anim !== 'held' && r.state.anim !== 'fall';
      if (settled && now - r.savedAt > SAVE_EVERY_MS) {
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

    const onDocVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onDocVisibility);
    window.addEventListener('pagehide', persist);

    const unlistenVisibility = tauri
      ? listen<{ visible: boolean }>('pet-visibility', (e) => {
          if (disposed) return;
          r.visible = e.payload?.visible === true;
          if (r.visible) {
            // The owner just put BBARIT away: the pet wakes up, picks up settings changes.
            r.activity = true;
            void loadConfigAndPack();
            void refreshAreas();
            start();
          } else {
            r.drag = null;
            setDragging(false);
            stop();
          }
        })
      : null;

    void (async () => {
      await Promise.all([loadConfigAndPack(), refreshAreas()]);
      if (disposed) return;
      const saved = loadSavedPos(safeStorage());
      r.state = initialState(r.areas, { ...saved, mode: r.mode });
      start();
    })();

    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onDocVisibility);
      window.removeEventListener('pagehide', persist);
      void unlistenVisibility?.then((un) => un()).catch(() => {});
      if (rtRef.current === r) rtRef.current = null;
    };
  }, []);

  const t = (key: TranslationKey) => getTranslation(locale, key);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = rtRef.current;
    if (!r?.state || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    r.drag = {
      offX: e.clientX,
      offY: e.clientY,
      startX: e.screenX,
      startY: e.screenY,
      active: false,
      x: e.screenX - e.clientX,
      y: e.screenY - e.clientY,
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

  const onDoubleClick = () => {
    if (isTauri()) void invoke('pet_open_main').catch((e) => console.warn('[pet] pet_open_main failed:', e));
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
    <div className="pet-root" onContextMenu={onContextMenu}>
      <canvas
        ref={canvasRef}
        className={`pet-canvas${dragging ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
