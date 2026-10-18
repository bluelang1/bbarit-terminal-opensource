/**
 * pptxEditorGeometry.ts — Pure geometry/undo helpers for the slide editor
 *
 * Kept free of React so the resize math and undo grouping decision can be
 * unit-tested without rendering the editor.
 */

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
export const RESIZE_MIN = 3;

// Resize an element from a directional handle. Deltas are in slide-percentage
// units. The edge opposite the dragged handle stays anchored, so dragging the
// west handle also moves x. keepAspect (Shift) locks the ratio for corners.
export function computeResizeGeometry(
  dir: ResizeDir,
  orig: Box,
  dxPct: number,
  dyPct: number,
  keepAspect: boolean,
): Box {
  const hasE = dir.includes('e');
  const hasW = dir.includes('w');
  const hasS = dir.includes('s');
  const hasN = dir.includes('n');

  let w = orig.w + (hasE ? dxPct : hasW ? -dxPct : 0);
  let h = orig.h + (hasS ? dyPct : hasN ? -dyPct : 0);

  const corner = (hasE || hasW) && (hasN || hasS);
  if (keepAspect && corner && orig.h !== 0) {
    const ratio = orig.w / orig.h;
    h = w / ratio;
  }

  w = Math.max(RESIZE_MIN, w);
  h = Math.max(RESIZE_MIN, h);

  const rightEdge = orig.x + orig.w;
  const bottomEdge = orig.y + orig.h;
  const x = hasW ? rightEdge - w : orig.x;
  const y = hasN ? bottomEdge - h : orig.y;

  return { x, y, w, h };
}

// Decide whether a fresh undo snapshot should be recorded for a change, or the
// change coalesced into the previous group. Consecutive changes to the same key
// within windowMs are grouped so slider drags / typing do not flood history.
export function shouldStartUndoGroup(
  last: { key: string; time: number } | null,
  key: string,
  now: number,
  windowMs: number,
): boolean {
  if (!last) return true;
  if (last.key !== key) return true;
  return now - last.time >= windowMs;
}

// ─── Multi-select alignment / distribution ────────────────────

export type AlignAxis = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

// Align a group of boxes to one another. The group's own bounding box provides
// the reference edge/center so PowerPoint's "align selected objects" behaviour
// falls out (left = leftmost edge, center = group centre, etc.).
export function alignBoxes<T extends Box>(boxes: T[], axis: AlignAxis): T[] {
  if (boxes.length === 0) return boxes.map((b) => ({ ...b }));
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return boxes.map((b) => {
    switch (axis) {
      case 'left': return { ...b, x: minX };
      case 'center': return { ...b, x: centerX - b.w / 2 };
      case 'right': return { ...b, x: maxX - b.w };
      case 'top': return { ...b, y: minY };
      case 'middle': return { ...b, y: centerY - b.h / 2 };
      case 'bottom': return { ...b, y: maxY - b.h };
      default: return { ...b };
    }
  });
}

// Distribute boxes so the gaps between adjacent edges are equal along one axis.
// The extreme boxes stay put; interior boxes are re-spaced. Needs 3+ boxes.
export function distributeBoxes<T extends Box>(boxes: T[], axis: 'h' | 'v'): T[] {
  const result = boxes.map((b) => ({ ...b }));
  if (boxes.length < 3) return result;
  const horizontal = axis === 'h';
  const sizeOf = (b: Box) => (horizontal ? b.w : b.h);
  const startOf = (b: Box) => (horizontal ? b.x : b.y);
  const order = boxes
    .map((b, i) => ({ b, i }))
    .sort((p, q) => startOf(p.b) - startOf(q.b));
  const totalSize = order.reduce((s, o) => s + sizeOf(o.b), 0);
  const first = order[0].b;
  const last = order[order.length - 1].b;
  const span = startOf(last) + sizeOf(last) - startOf(first);
  const gap = (span - totalSize) / (order.length - 1);
  let cursor = startOf(first);
  for (const o of order) {
    if (horizontal) result[o.i].x = cursor;
    else result[o.i].y = cursor;
    cursor += sizeOf(o.b) + gap;
  }
  return result;
}

// ─── Smart guides (snap lines) ────────────────────────────────

export interface DragSnapResult {
  x: number;
  y: number;
  vLines: number[]; // vertical guide positions in slide %
  hLines: number[]; // horizontal guide positions in slide %
}

// Snap the moving box's edges/centre to the slide edges/centre and to the
// edges/centres of the other boxes when within threshold %, returning the
// snapped position plus the guide lines to draw.
export function computeDragSnap(
  moving: Box,
  others: Box[],
  threshold: number,
): DragSnapResult {
  const snapAxis = (movingStart: number, size: number, targets: number[]) => {
    const anchors = [movingStart, movingStart + size / 2, movingStart + size];
    let bestDelta = 0;
    let bestDist = threshold;
    let found = false;
    for (const t of targets) {
      for (const a of anchors) {
        const d = Math.abs(a - t);
        if (d <= bestDist) {
          bestDist = d;
          bestDelta = t - a;
          found = true;
        }
      }
    }
    const start = movingStart + (found ? bestDelta : 0);
    const lines: number[] = [];
    if (found) {
      const snapped = [start, start + size / 2, start + size];
      for (const t of targets) {
        if (snapped.some((a) => Math.abs(a - t) < 0.05) && !lines.includes(t)) {
          lines.push(t);
        }
      }
    }
    return { start, lines };
  };

  const vTargets = [0, 50, 100];
  const hTargets = [0, 50, 100];
  for (const o of others) {
    vTargets.push(o.x, o.x + o.w / 2, o.x + o.w);
    hTargets.push(o.y, o.y + o.h / 2, o.y + o.h);
  }

  const v = snapAxis(moving.x, moving.w, vTargets);
  const h = snapAxis(moving.y, moving.h, hTargets);
  return { x: v.start, y: h.start, vLines: v.lines, hLines: h.lines };
}

// ─── Rotation ─────────────────────────────────────────────────

// Angle (0-360°, clockwise) from an element's centre to the pointer, offset so
// that dragging the top handle straight up reads 0°. Shift snaps to 15°.
export function computeRotation(
  cx: number,
  cy: number,
  px: number,
  py: number,
  snap15: boolean,
): number {
  let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
  deg = ((deg % 360) + 360) % 360;
  if (snap15) deg = (Math.round(deg / 15) * 15) % 360;
  return deg;
}
