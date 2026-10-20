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

export function captureDropTargets(root: ParentNode = document): DropTargetRect[] {
  const out: DropTargetRect[] = [];
  root.querySelectorAll<HTMLElement>('[data-project-drop-id]').forEach((el) => {
    if (el.classList.contains('project-drag-ghost')) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.push({
      id: el.dataset.projectDropId || '',
      orientation: el.dataset.projectDropOrientation === 'vertical' ? 'vertical' : 'horizontal',
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
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
