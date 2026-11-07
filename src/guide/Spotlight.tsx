// "직접 해보기" overlay in the main window: dims everything but the real control,
// rings it, and explains it. Clicks inside the cut-out reach the control;
// anywhere else (or Esc, or 6 s) closes. A missing/hidden control gets a centred
// card that says where to find it instead of a wrong highlight.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { MousePointerClick, MapPin } from 'lucide-react';
import { GUIDE_WINDOW_LABEL, type GuideStep } from './steps';
import { placeCaption, resolveTarget, screenBoxOf, shouldPinGuide, type ScreenBox } from './spotlightTarget';
import './Spotlight.css';

const PAD = 8;
const TIMEOUT_MS = 6000;
const CAPTION_W = 280;
const CAPTION_H = 92;
/** Size of the centred "where to find it" card, for the overlap check. */
const MISSING_CARD = { w: 400, h: 240 };

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

async function guideWindow(): Promise<WebviewWindow | null> {
  try { return await WebviewWindow.getByLabel(GUIDE_WINDOW_LABEL); } catch { return null; }
}

async function guideScreenBox(guide: WebviewWindow): Promise<ScreenBox | null> {
  try {
    const [pos, size, scale] = await Promise.all([guide.outerPosition(), guide.outerSize(), guide.scaleFactor()]);
    return { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale };
  } catch {
    return null;
  }
}

/** Screen box of what this spotlight shows: the highlighted control, or the
 *  centred card when the control is missing. */
async function shownScreenBox(step: GuideStep): Promise<ScreenBox | null> {
  try {
    const main = getCurrentWindow();
    const [inner, scale] = await Promise.all([main.innerPosition(), main.scaleFactor()]);
    const origin = { x: inner.x / scale, y: inner.y / scale };
    const hit = resolveTarget(step, document);
    if (hit) {
      const r = hit.rect;
      return screenBoxOf(origin, { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    }
    const w = Math.min(MISSING_CARD.w, window.innerWidth);
    const h = Math.min(MISSING_CARD.h, window.innerHeight);
    return screenBoxOf(origin, { left: (window.innerWidth - w) / 2, top: (window.innerHeight - h) / 2, width: w, height: h });
  } catch {
    return null;
  }
}

export function Spotlight({ step, t, onClose }: {
  step: GuideStep;
  t: (key: string) => string;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [resolved, setResolved] = useState(false);
  const closedRef = useRef(false);
  // Guide-window calls run in order, so an unpin can never be overtaken by a
  // pin that was still deciding.
  const opsRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((op: () => Promise<void>) => {
    opsRef.current = opsRef.current.then(op).catch(() => {});
  }, []);
  const release = useCallback(() => {
    if (!isTauri()) return;
    enqueue(async () => {
      const guide = await guideWindow();
      if (!guide) return;
      await guide.setAlwaysOnTop(false).catch(() => {});
      await guide.setFocus().catch(() => {});
    });
  }, [enqueue]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    release();
    onClose();
  }, [onClose, release]);

  const measure = useCallback(() => {
    const hit = resolveTarget(step, document);
    if (!hit) { setRect(null); return; }
    const r = hit.rect;
    setRect({
      left: r.left - PAD,
      top: r.top - PAD,
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
      right: r.right + PAD,
      bottom: r.bottom + PAD,
    });
  }, [step]);

  useLayoutEffect(() => {
    resolveTarget(step, document)?.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
    setResolved(true);
  }, [measure, step]);

  useEffect(() => {
    if (isTauri()) {
      void getCurrentWindow().setFocus().catch(() => {});
      // Keep the guide (다음, checklist) in front — unless it would cover the spot.
      enqueue(async () => {
        if (closedRef.current) return;
        const guide = await guideWindow();
        if (!guide) return;
        const [g, target] = await Promise.all([guideScreenBox(guide), shownScreenBox(step)]);
        if (closedRef.current || !target || !shouldPinGuide(g, target)) return;
        await guide.setAlwaysOnTop(true);
      });
    }
    const timer = window.setTimeout(close, TIMEOUT_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    // Capture phase, no preventDefault: a click in the cut-out still reaches the
    // control; a click on the blockers lands on them, so nothing underneath fires.
    const onDown = () => close();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('click', onDown, true);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('click', onDown, true);
      window.removeEventListener('resize', measure);
    };
  }, [close, measure, enqueue, step]);

  // Unmount without an explicit close (e.g. a new spotlight replaced this one).
  // Setup resets the flag so StrictMode's mount → unmount → mount stays usable.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      if (closedRef.current) return;
      closedRef.current = true;
      release();
    };
  }, [release]);

  if (!resolved) return null;
  const caption = step.target ? t(step.target.captionKey) : t(step.titleKey);

  if (!rect) {
    return (
      <div className="guide-spot guide-spot-dim" role="dialog" aria-live="polite">
        <div className="guide-spot-card">
          <span className="guide-spot-card-icon"><MapPin size={18} /></span>
          <strong>{caption}</strong>
          <p className="guide-spot-card-title">{t('guide.spotlight.missingTitle')}</p>
          {step.target && <p>{t(step.target.missingKey)}</p>}
          <small>{t('guide.spotlight.dismiss')}</small>
        </div>
      </div>
    );
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cap = placeCaption(rect, vw, vh, CAPTION_W, CAPTION_H);
  // Four transparent blockers around the hole swallow outside clicks; the hole has none.
  const blockers = [
    { left: 0, top: 0, width: vw, height: Math.max(0, rect.top) },
    { left: 0, top: rect.bottom, width: vw, height: Math.max(0, vh - rect.bottom) },
    { left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height },
    { left: rect.right, top: rect.top, width: Math.max(0, vw - rect.right), height: rect.height },
  ];

  return (
    <div className="guide-spot" role="dialog" aria-live="polite">
      {blockers.map((b, i) => (
        <div key={i} className="guide-spot-block" style={b} onMouseDown={(e) => e.preventDefault()} />
      ))}
      <div className="guide-spot-hole" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      <div className="guide-spot-ring" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      <div
        className={`guide-spot-caption guide-spot-caption-${cap.side}`}
        style={{ left: cap.left, top: cap.top, width: CAPTION_W }}
      >
        <span className="guide-spot-caption-icon"><MousePointerClick size={15} /></span>
        <div>
          <strong>{caption}</strong>
          <small>{t('guide.spotlight.dismiss')}</small>
        </div>
      </div>
    </div>
  );
}
