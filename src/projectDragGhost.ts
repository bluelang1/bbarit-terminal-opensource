// Kanban-style drag ghost for project rows/tabs: a full-size clone of the
// pressed element follows the pointer from the grab point, the original stays
// in place as a dim placeholder, and on release the clone glides into the slot
// the row ends up in (or back to where it started when the drag is cancelled).

export type DragGhost = {
  element: HTMLElement;
  grabX: number;
  grabY: number;
  x: number;
  y: number;
};

const GHOST_CLASS = 'project-drag-ghost';
const STATE_CLASSES = ['dragging', 'active', 'drag-over', 'drop-before', 'drop-after', 'project-shift', 'context-active', 'project-reorder-animating'];

/** Remove ghosts a previous drag may have left behind (e.g. an interrupted landing). */
export function removeStaleDragGhosts(): void {
  document.querySelectorAll(`.${GHOST_CLASS}`).forEach((el) => el.remove());
}

export function createDragGhost(source: HTMLElement, clientX: number, clientY: number): DragGhost {
  removeStaleDragGhosts();
  const rect = source.getBoundingClientRect();
  const element = source.cloneNode(true) as HTMLElement;
  element.classList.add(GHOST_CLASS);
  for (const name of STATE_CLASSES) element.classList.remove(name);
  // The clone must never be a drop target or a FLIP participant.
  element.removeAttribute('data-project-tab-id');
  element.removeAttribute('data-project-drop-id');
  element.removeAttribute('data-project-drop-orientation');
  element.removeAttribute('id');
  element.setAttribute('aria-hidden', 'true');
  element.style.visibility = ''; // the source may be hidden while a previous ghost lands
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  const ghost: DragGhost = { element, grabX: clientX - rect.left, grabY: clientY - rect.top, x: rect.left, y: rect.top };
  element.style.transform = `translate3d(${ghost.x}px, ${ghost.y}px, 0)`;
  document.body.appendChild(element);
  return ghost;
}

export function moveDragGhost(ghost: DragGhost, clientX: number, clientY: number): void {
  ghost.x = clientX - ghost.grabX;
  ghost.y = clientY - ghost.grabY;
  ghost.element.style.transform = `translate3d(${ghost.x}px, ${ghost.y}px, 0)`;
}

/** Glide the ghost onto `target`'s current rect, then remove it. Resolves when done. */
export function landDragGhost(ghost: DragGhost, target: HTMLElement | null, duration = 220): Promise<void> {
  const el = ghost.element;
  if (!target || typeof el.animate !== 'function') {
    el.remove();
    return Promise.resolve();
  }
  const rect = target.getBoundingClientRect();
  const animation = el.animate(
    [
      { transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0)` },
      { transform: `translate3d(${rect.left}px, ${rect.top}px, 0)` },
    ],
    { duration, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' },
  );
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      el.remove();
      resolve();
    };
    animation.addEventListener('finish', done, { once: true });
    animation.addEventListener('cancel', done, { once: true });
    // Animations do not run (and never finish) while the window is hidden;
    // never leave a ghost behind in that case.
    setTimeout(done, duration + 300);
  });
}
