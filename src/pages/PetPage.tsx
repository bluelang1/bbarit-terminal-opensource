// Desktop pet window (/pet, label `pet`, created by src-tauri/src/pet.rs).
//
// Renders the configured character pack on a canvas and moves its own window along the
// bottom of the screen with the pure engine in src/pet/engine.ts. The loop runs on
// setTimeout (~12 fps, slower while asleep) and stops while the window is hidden.
// Claude state arrives from the main window as `pet-summary` (src/pet/summary.ts): it sets
// the engine mood, a speech bubble (blocked / just done) and an unseen-done badge. While a
// bubble shows the window widens / grows upward around the body box (petWindowLayout);
// the body stays on the same screen spot.
// Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { exit } from '@tauri-apps/plugin-process';
import { DEFAULT_PET_CONFIG, normalizePetConfig, type PetConfig } from '../config/schema';
import { getTranslation, type Locale, type TranslationKey } from '../i18n';
import { PET_H, PET_W, clampToWorkArea, initialState, step, type PetState, type WorkArea } from '../pet/engine';
import { framesFor, type CharacterPack } from '../pet/pack';
import { drawFrame } from '../pet/render';
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
import './PetPage.css';

const TICK_MS = 83; // ~12 fps
const FALL_TICK_MS = 33;
const DRAG_TICK_MS = 16;
const SLEEP_TICK_MS = 250;
const AREA_REFRESH_MS = 30_000;
const SAVE_EVERY_MS = 2_000;
const DRAG_THRESHOLD_PX = 3;
const LOCALES: Locale[] = ['en', 'ko', 'ja', 'zh', 'fr', 'de', 'it', 'es'];
/** Gap between the tail element's bottom (tip + its shadow row) and the head's top row. */
const TAIL_TIP_GAP_PX = 0;
/** Bubble box bottom above the head top: the part of the tail below the bubble, plus the gap. */
const BUBBLE_LIFT_PX = (TAIL_ART.length - TAIL_OVERLAP) * ART_PX + TAIL_TIP_GAP_PX;
const TAIL_W_PX = TAIL_ART[0].length * ART_PX;
const TAIL_H_PX = TAIL_ART.length * ART_PX;

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
      const headInset = packHeadroomRows(r.pack) * scale;
      if (r.sprite.w !== pw || r.sprite.h !== ph || r.sprite.headInset !== headInset) {
        r.sprite = { w: pw, h: ph, headInset };
        applyDom(r.layout);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, PET_W, PET_H);
      drawFrame(ctx, pack, frames[idx], Math.round((PET_W - pw) / 2), PET_H - ph, flip);
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
      const l = petWindowLayout(r.state, r.bubble ? { spriteH: r.sprite.h - r.sprite.headInset } : null, area);
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

    // Bubble / badge from the latest summary; React state only changes when they do.
    const refreshBubble = () => {
      const next = petBubble(r.summary, Date.now(), r.lastDone, r.labels);
      if (bubbleKey(next) === bubbleKey(r.bubble)) return;
      r.bubble = next;
      setBubble(next);
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
          mood: moodFor(r.summary, Date.now(), r.lastDone?.atMs ?? null),
        });
        r.activity = false;
        r.animElapsed = r.state.anim === prevAnim ? r.animElapsed + dt : 0;
      }
      refreshBubble();
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

    const unlistenSummary = tauri
      ? listen<PetSummary>('pet-summary', (e) => {
          const p = e.payload;
          if (disposed || !p || !Array.isArray(p.blocked) || !Array.isArray(p.working)) return;
          const { doneEvent, ...summary } = p;
          r.summary = { ...summary, unseenDone: Number(summary.unseenDone) || 0 };
          // A turn that finished while the pet was away is not celebrated later.
          if (doneEvent && r.visible) r.lastDone = { atMs: Date.now(), event: doneEvent };
          setUnseenDone(r.summary.unseenDone);
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
      start();
    })();

    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onDocVisibility);
      window.removeEventListener('pagehide', persist);
      void unlistenVisibility?.then((un) => un()).catch(() => {});
      void unlistenSummary?.then((un) => un()).catch(() => {});
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

  // Blocked tab first, then the latest unseen done, else main's last active tab.
  const onDoubleClick = () => {
    const r = rtRef.current;
    openTerminal(r ? petOpenTarget(r.summary) : null);
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
            onClick={() => openTerminal(bubble.terminalId)}
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
      {unseenDone > 0 && (
        <div ref={badgeRef} className="pet-badge" title={t('pet.badge.unseen')}>
          {unseenDone > 9 ? '9+' : unseenDone}
        </div>
      )}
    </div>
  );
}
