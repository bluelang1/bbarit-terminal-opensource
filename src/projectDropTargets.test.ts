import { describe, expect, it } from 'vitest';
import { captureDropTargets, dropSideFor, findDropTarget, inlineTranslate, type DropTargetRect } from './projectDropTargets';

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

describe('snapshot hygiene', () => {
  it('parses the preview translate and subtracts it from captured rects', () => {
    const el = document.createElement('div');
    el.style.transform = 'translate3d(0px, -82px, 0px)';
    expect(inlineTranslate(el)).toEqual({ x: 0, y: -82 });
    el.style.transform = '';
    expect(inlineTranslate(el)).toEqual({ x: 0, y: 0 });

    document.body.innerHTML = '<div data-project-drop-id="b" style="transform: translate3d(0px, -82px, 0px)"></div>';
    const row = document.querySelector<HTMLElement>('[data-project-drop-id]')!;
    row.getBoundingClientRect = () => ({ left: 0, top: 8, right: 200, bottom: 88, width: 200, height: 80, x: 0, y: 8, toJSON() {} }) as DOMRect;
    expect(captureDropTargets()[0]).toMatchObject({ id: 'b', top: 90, bottom: 170 });
    document.body.innerHTML = '';
  });

  it('clips rows to their scroll container and drops rows scrolled out of view', () => {
    document.body.innerHTML = `
      <div id="list" style="overflow-y: auto">
        <div data-project-drop-id="a"></div>
        <div data-project-drop-id="b"></div>
      </div>`;
    const list = document.getElementById('list')!;
    list.getBoundingClientRect = () => ({ left: 0, top: 100, right: 200, bottom: 300, width: 200, height: 200, x: 0, y: 100, toJSON() {} }) as DOMRect;
    const [a, b] = Array.from(document.querySelectorAll<HTMLElement>('[data-project-drop-id]'));
    a.getBoundingClientRect = () => ({ left: 0, top: 60, right: 200, bottom: 140, width: 200, height: 80, x: 0, y: 60, toJSON() {} }) as DOMRect;
    b.getBoundingClientRect = () => ({ left: 0, top: 320, right: 200, bottom: 400, width: 200, height: 80, x: 0, y: 320, toJSON() {} }) as DOMRect;
    const captured = captureDropTargets();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ id: 'a', top: 100, bottom: 140 });
    document.body.innerHTML = '';
  });
});
