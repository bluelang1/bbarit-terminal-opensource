// Live "make room" preview while a project row is dragged: the rows between
// the dragged row and the drop slot slide by one row so the slot opens up
// (the same scheme sortable list libraries use). The dragged row itself stays
// dimmed in place; a floating preview follows the cursor. On drop the real
// reorder commits and the FLIP animation in App.tsx finishes the motion.

export type ProjectDropSide = 'before' | 'after';
export type ProjectDropTarget = { projectId: string; side: ProjectDropSide };

/** Index where the dragged row would land in `ids` (counting the dragged row if present). */
export function projectInsertIndex(ids: readonly string[], target: ProjectDropTarget): number {
  const targetIndex = ids.indexOf(target.projectId);
  if (targetIndex < 0) return -1;
  return target.side === 'after' ? targetIndex + 1 : targetIndex;
}

/**
 * Rows to shift and in which direction: -1 = toward the list start (up/left),
 * +1 = toward the end (down/right). Rows that do not move are absent.
 */
export function projectReorderShifts(
  ids: readonly string[],
  dragId: string,
  target: ProjectDropTarget | null | undefined,
): Map<string, -1 | 1> {
  const shifts = new Map<string, -1 | 1>();
  if (!dragId || !target || target.projectId === dragId) return shifts;
  const insertAt = projectInsertIndex(ids, target);
  if (insertAt < 0) return shifts;
  const dragIndex = ids.indexOf(dragId);
  // A row dragged in from another list (group) leaves no gap behind, so sliding
  // this list would only overlap whatever follows it; the drop line is enough.
  if (dragIndex < 0) return shifts;
  if (insertAt === dragIndex || insertAt === dragIndex + 1) return shifts; // same place
  if (insertAt > dragIndex) {
    for (let i = dragIndex + 1; i < insertAt; i += 1) shifts.set(ids[i], -1);
  } else {
    for (let i = insertAt; i < dragIndex; i += 1) shifts.set(ids[i], 1);
  }
  return shifts;
}

export type ProjectDragShift = {
  w: number;
  h: number;
  /** The list wraps onto several lines; a horizontal slide would point past the line end. */
  multiLine: boolean;
};

/** Measure how far neighbours must slide to open one slot for `element` in its list. */
export function measureProjectDragShift(element: HTMLElement): ProjectDragShift {
  const rect = element.getBoundingClientRect();
  const parent = element.parentElement;
  const style = parent && typeof getComputedStyle === 'function' ? getComputedStyle(parent) : null;
  const px = (value: string | undefined) => {
    const n = parseFloat(value || '');
    return Number.isFinite(n) ? n : 0;
  };
  const tops = parent
    ? Array.from(parent.children, (child) => Math.round((child as HTMLElement).getBoundingClientRect().top))
    : [];
  return {
    w: rect.width + px(style?.columnGap),
    h: rect.height + px(style?.rowGap),
    multiLine: new Set(tops).size > 1,
  };
}

export function projectShiftTransform(
  shift: -1 | 1 | undefined,
  size: ProjectDragShift | null | undefined,
  orientation: 'vertical' | 'horizontal',
): string | undefined {
  if (!shift || !size) return undefined;
  if (orientation === 'horizontal' && size.multiLine) return undefined;
  return orientation === 'vertical'
    ? `translate3d(0, ${Math.round(shift * size.h)}px, 0)`
    : `translate3d(${Math.round(shift * size.w)}px, 0, 0)`;
}
