// Find the real control a guide step points at. Pure DOM lookup (testable in jsdom).
import type { GuideStep } from './steps';

export interface ResolvedTarget {
  rect: DOMRect;
  el: Element;
}

function visible(doc: Document, selector: string | undefined): ResolvedTarget | null {
  if (!selector) return null;
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { rect, el };
  }
  return null;
}

/** altSelector first (e.g. the open new-project modal's folder field), then the
 *  selector. Null when the control is missing or has no size (display:none,
 *  folded toolbar) — the caller then explains where to find it instead of
 *  highlighting something else. */
export function resolveTarget(step: GuideStep, doc: Document): ResolvedTarget | null {
  if (!step.target) return null;
  return visible(doc, step.target.altSelector) ?? visible(doc, step.target.selector);
}

export interface CaptionPlacement {
  left: number;
  top: number;
  side: 'below' | 'above';
}

const EDGE = 12;
const GAP = 16;

/** Caption bubble position next to the highlighted rect: below when it fits,
 *  else above; horizontally centred on the target and kept on screen. */
export function placeCaption(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height' | 'right' | 'bottom'>,
  vw: number,
  vh: number,
  bw: number,
  bh: number,
): CaptionPlacement {
  const fitsBelow = rect.bottom + GAP + bh <= vh - EDGE;
  const side: CaptionPlacement['side'] = fitsBelow || rect.top - GAP - bh < EDGE ? 'below' : 'above';
  const top = side === 'below'
    ? Math.min(rect.bottom + GAP, vh - EDGE - bh)
    : rect.top - GAP - bh;
  const centre = rect.left + rect.width / 2;
  const left = Math.max(EDGE, Math.min(centre - bw / 2, vw - EDGE - bw));
  return { left, top: Math.max(EDGE, top), side };
}

/** A rectangle in logical screen coordinates. */
export interface ScreenBox { x: number; y: number; w: number; h: number }

export function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Viewport rect inside a window whose content starts at `inner` → screen box. */
export function screenBoxOf(inner: { x: number; y: number }, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): ScreenBox {
  return { x: inner.x + rect.left, y: inner.y + rect.top, w: rect.width, h: rect.height };
}

/** Keep the guide window on top during a spotlight only when it does not cover
 *  what the spotlight shows. Unknown guide rect → do not pin (it is brought back
 *  to the front when the spotlight closes anyway). */
export function shouldPinGuide(guide: ScreenBox | null, target: ScreenBox): boolean {
  return guide != null && !boxesOverlap(guide, target);
}
