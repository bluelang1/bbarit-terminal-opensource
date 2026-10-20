import { afterEach, describe, expect, it } from 'vitest';
import { createDragGhost, landDragGhost, moveDragGhost, removeStaleDragGhosts } from './projectDragGhost';

function makeRow(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'project-selector-item active dragging';
  row.setAttribute('data-project-tab-id', 'p1');
  row.setAttribute('data-project-drop-id', 'p1');
  row.style.setProperty('--selector-accent', '#f00');
  row.innerHTML = '<span class="project-selector-name">Alpha</span>';
  row.getBoundingClientRect = () => ({ left: 20, top: 100, width: 240, height: 84, right: 260, bottom: 184, x: 20, y: 100, toJSON() {} }) as DOMRect;
  document.body.appendChild(row);
  return row;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('project drag ghost', () => {
  it('clones the pressed row at its rect and keeps the grab offset', () => {
    const row = makeRow();
    const ghost = createDragGhost(row, 50, 130);
    expect(ghost.element.classList.contains('project-drag-ghost')).toBe(true);
    expect(ghost.element.classList.contains('dragging')).toBe(false);
    expect(ghost.element.classList.contains('active')).toBe(false);
    expect(ghost.element.hasAttribute('data-project-drop-id')).toBe(false);
    expect(ghost.element.hasAttribute('data-project-tab-id')).toBe(false);
    expect(ghost.element.style.width).toBe('240px');
    expect(ghost.element.style.height).toBe('84px');
    expect(ghost.element.style.transform).toBe('translate3d(20px, 100px, 0)');
    expect(ghost.element.textContent).toBe('Alpha');
    expect(ghost.element.parentElement).toBe(document.body);
    expect({ grabX: ghost.grabX, grabY: ghost.grabY }).toEqual({ grabX: 30, grabY: 30 });
  });

  it('follows the pointer from the grab point', () => {
    const ghost = createDragGhost(makeRow(), 50, 130);
    moveDragGhost(ghost, 300, 500);
    expect(ghost.element.style.transform).toBe('translate3d(270px, 470px, 0)');
  });

  it('removes itself when landing without a target or without Web Animations', async () => {
    const ghost = createDragGhost(makeRow(), 50, 130);
    await landDragGhost(ghost, null);
    expect(document.querySelector('.project-drag-ghost')).toBeNull();
  });

  it('animates onto the target rect and then removes itself', async () => {
    const row = makeRow();
    const ghost = createDragGhost(row, 50, 130);
    const target = document.createElement('div');
    target.getBoundingClientRect = () => ({ left: 20, top: 284, width: 240, height: 84, right: 260, bottom: 368, x: 20, y: 284, toJSON() {} }) as DOMRect;
    const listeners: Record<string, () => void> = {};
    let frames: Keyframe[] = [];
    ghost.element.animate = ((keyframes: Keyframe[]) => {
      frames = keyframes;
      return { addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; } } as unknown as Animation;
    }) as HTMLElement['animate'];
    const done = landDragGhost(ghost, target, 10);
    expect(frames[1]).toEqual({ transform: 'translate3d(20px, 284px, 0)' });
    listeners.finish();
    await done;
    expect(document.querySelector('.project-drag-ghost')).toBeNull();
  });
});

describe('ghost hygiene', () => {
  it('drops stale ghosts when a new drag starts', () => {
    const row = makeRow();
    createDragGhost(row, 50, 130);
    createDragGhost(row, 50, 130);
    expect(document.querySelectorAll('.project-drag-ghost')).toHaveLength(1);
    removeStaleDragGhosts();
    expect(document.querySelectorAll('.project-drag-ghost')).toHaveLength(0);
  });

  it('removes the ghost even if the animation never finishes', async () => {
    const ghost = createDragGhost(makeRow(), 50, 130);
    const target = document.createElement('div');
    ghost.element.animate = (() => ({ addEventListener: () => {} }) as unknown as Animation) as HTMLElement['animate'];
    await landDragGhost(ghost, target, 10);
    expect(document.querySelector('.project-drag-ghost')).toBeNull();
  });
});
