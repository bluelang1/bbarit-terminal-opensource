// Drop-target lookup for project drags that does not depend on the live DOM
// layout. While a row is dragged its neighbours are translated to open the
// slot, so document.elementFromPoint() under the pointer sees the shifted
// rows (or the gap they left) and the drop lands nowhere. The row rects are
// captured once when the drag starts, before any row moves, and every later
// hit-test runs against that snapshot.

export type DropTargetRect = {
  id: string;
  orientation: 'vertical' | 'horizontal';
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type DropSide = 'before' | 'after';

/** Inline `translate3d(x, y, 0)` applied by the reorder preview, so it can be undone. */
export function inlineTranslate(el: HTMLElement): { x: number; y: number } {
  const m = /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform || '');
  return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
}

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const { overflowY, overflowX } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) || /(auto|scroll)/.test(overflowX)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Snapshot of every row's rect in its untransformed position, clipped to its
 * scroll container so rows scrolled out of view cannot be hit through the
 * panel header. Safe to call again mid-drag (e.g. after a wheel scroll): the
 * preview's inline translate is subtracted before the rect is stored.
 */
export function captureDropTargets(root: ParentNode = document): DropTargetRect[] {
  const out: DropTargetRect[] = [];
  root.querySelectorAll<HTMLElement>('[data-project-drop-id]').forEach((el) => {
    if (el.classList.contains('project-drag-ghost')) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const t = inlineTranslate(el);
    let left = r.left - t.x; let top = r.top - t.y; let right = r.right - t.x; let bottom = r.bottom - t.y;
    const scroller = scrollParentOf(el);
    if (scroller) {
      const c = scroller.getBoundingClientRect();
      left = Math.max(left, c.left); top = Math.max(top, c.top);
      right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
      if (right <= left || bottom <= top) return; // fully scrolled out of view
    }
    out.push({
      id: el.dataset.projectDropId || '',
      orientation: el.dataset.projectDropOrientation === 'vertical' ? 'vertical' : 'horizontal',
      left, top, right, bottom,
    });
  });
  return out;
}

export function findDropTarget(targets: readonly DropTargetRect[], x: number, y: number): DropTargetRect | null {
  // Last match wins so a row rendered later (on top) beats an earlier overlap.
  let hit: DropTargetRect | null = null;
  for (const t of targets) {
    if (x >= t.left && x <= t.right && y >= t.top && y <= t.bottom) hit = t;
  }
  return hit;
}

export function dropSideFor(target: DropTargetRect, x: number, y: number): DropSide {
  return target.orientation === 'vertical'
    ? (y < target.top + (target.bottom - target.top) / 2 ? 'before' : 'after')
    : (x < target.left + (target.right - target.left) / 2 ? 'before' : 'after');
}
