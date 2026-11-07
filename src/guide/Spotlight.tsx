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
import { placeCaption, resolveTarget } from './spotlightTarget';
import './Spotlight.css';

const PAD = 8;
const TIMEOUT_MS = 6000;
const CAPTION_W = 280;
const CAPTION_H = 92;

type Rect = { left: number; top: number; width: number; height: number; right: number; bottom: number };

async function guideOnTop(on: boolean) {
  if (!isTauri()) return;
  try {
    const guide = await WebviewWindow.getByLabel(GUIDE_WINDOW_LABEL);
    if (!guide) return;
    await guide.setAlwaysOnTop(on);
    if (!on) await guide.setFocus();
  } catch { /* guide closed meanwhile */ }
}

export function Spotlight({ step, t, onClose }: {
  step: GuideStep;
  t: (key: string) => string;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [resolved, setResolved] = useState(false);
  const closedRef = useRef(false);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    void guideOnTop(false);
    onClose();
  }, [onClose]);

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
    if (isTauri()) void getCurrentWindow().setFocus().catch(() => {});
    void guideOnTop(true);
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
  }, [close, measure]);

  // Unmount without an explicit close (e.g. a new spotlight replaced this one).
  useEffect(() => () => { if (!closedRef.current) void guideOnTop(false); }, []);

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
