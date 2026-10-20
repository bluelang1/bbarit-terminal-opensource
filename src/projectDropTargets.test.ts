import { describe, expect, it } from 'vitest';
import { captureDropTargets, dropSideFor, findDropTarget, type DropTargetRect } from './projectDropTargets';

const row = (id: string, top: number, orientation: 'vertical' | 'horizontal' = 'vertical'): DropTargetRect => (
  { id, orientation, left: 0, top, right: 200, bottom: top + 80 }
);

describe('project drop targets', () => {
  it('finds the row under the point from the snapshot, not the live layout', () => {
    const targets = [row('a', 0), row('b', 90), row('c', 180)];
    expect(findDropTarget(targets, 10, 100)?.id).toBe('b');
    expect(findDropTarget(targets, 10, 85)).toBeNull();
    expect(findDropTarget(targets, 300, 100)).toBeNull();
  });

  it('splits before/after along the list axis', () => {
    expect(dropSideFor(row('b', 90), 10, 100)).toBe('before');
    expect(dropSideFor(row('b', 90), 10, 160)).toBe('after');
    const tab = { id: 't', orientation: 'horizontal' as const, left: 100, top: 0, right: 200, bottom: 30 };
    expect(dropSideFor(tab, 120, 10)).toBe('before');
    expect(dropSideFor(tab, 180, 10)).toBe('after');
  });

  it('captures rows from the DOM and skips the drag ghost', () => {
    document.body.innerHTML = `
      <div data-project-drop-id="a" data-project-drop-orientation="vertical"></div>
      <div data-project-drop-id="g" class="project-drag-ghost"></div>
      <div data-project-drop-id="b"></div>`;
    document.querySelectorAll<HTMLElement>('[data-project-drop-id]').forEach((el, i) => {
      el.getBoundingClientRect = () => ({ left: 0, top: i * 90, right: 200, bottom: i * 90 + 80, width: 200, height: 80, x: 0, y: i * 90, toJSON() {} }) as DOMRect;
    });
    const captured = captureDropTargets();
    expect(captured.map((t) => [t.id, t.orientation])).toEqual([['a', 'vertical'], ['b', 'horizontal']]);
    document.body.innerHTML = '';
  });
});
