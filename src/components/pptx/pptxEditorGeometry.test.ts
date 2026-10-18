import { describe, expect, it } from 'vitest';
import {
  RESIZE_MIN,
  computeResizeGeometry,
  shouldStartUndoGroup,
  alignBoxes,
  distributeBoxes,
  computeDragSnap,
  computeRotation,
  type Box,
} from './pptxEditorGeometry';

const box: Box = { x: 20, y: 20, w: 30, h: 20 };

describe('computeResizeGeometry', () => {
  it('grows width/height from the SE handle without moving the top-left', () => {
    const result = computeResizeGeometry('se', box, 10, 6, false);
    expect(result).toEqual({ x: 20, y: 20, w: 40, h: 26 });
  });

  it('anchors the opposite edge when dragging the west handle', () => {
    const result = computeResizeGeometry('w', box, 10, 0, false);
    // width shrinks by 10, right edge (x+w = 50) stays fixed
    expect(result.w).toBeCloseTo(20);
    expect(result.x).toBeCloseTo(30);
    expect(result.x + result.w).toBeCloseTo(50);
    expect(result.h).toBe(20);
  });

  it('anchors the bottom edge when dragging the north handle', () => {
    const result = computeResizeGeometry('n', box, 0, 5, false);
    expect(result.h).toBeCloseTo(15);
    expect(result.y).toBeCloseTo(25);
    expect(result.y + result.h).toBeCloseTo(40);
    expect(result.w).toBe(30);
  });

  it('clamps to the minimum size instead of inverting', () => {
    const result = computeResizeGeometry('se', box, -100, -100, false);
    expect(result.w).toBe(RESIZE_MIN);
    expect(result.h).toBe(RESIZE_MIN);
  });

  it('keeps the aspect ratio on corner drags when requested', () => {
    const ratio = box.w / box.h; // 1.5
    const result = computeResizeGeometry('se', box, 15, 0, true);
    expect(result.w / result.h).toBeCloseTo(ratio);
  });
});

describe('shouldStartUndoGroup', () => {
  it('always records the first change', () => {
    expect(shouldStartUndoGroup(null, 'a:x', 1000, 700)).toBe(true);
  });

  it('groups consecutive same-key changes within the window', () => {
    expect(shouldStartUndoGroup({ key: 'a:x', time: 1000 }, 'a:x', 1300, 700)).toBe(false);
  });

  it('starts a new group once the window elapses', () => {
    expect(shouldStartUndoGroup({ key: 'a:x', time: 1000 }, 'a:x', 1800, 700)).toBe(true);
  });

  it('starts a new group when the key changes', () => {
    expect(shouldStartUndoGroup({ key: 'a:x', time: 1000 }, 'a:y', 1100, 700)).toBe(true);
  });
});

describe('alignBoxes', () => {
  const a: Box = { x: 10, y: 10, w: 20, h: 10 };
  const b: Box = { x: 40, y: 30, w: 10, h: 20 };

  it('aligns left edges to the group leftmost', () => {
    const [ra, rb] = alignBoxes([a, b], 'left');
    expect(ra.x).toBe(10);
    expect(rb.x).toBe(10);
  });

  it('aligns right edges to the group rightmost', () => {
    const [ra, rb] = alignBoxes([a, b], 'right');
    expect(ra.x + ra.w).toBeCloseTo(50);
    expect(rb.x + rb.w).toBeCloseTo(50);
  });

  it('centres boxes on the group centre', () => {
    const [ra, rb] = alignBoxes([a, b], 'center');
    expect(ra.x + ra.w / 2).toBeCloseTo(rb.x + rb.w / 2);
  });

  it('aligns vertical middles', () => {
    const [ra, rb] = alignBoxes([a, b], 'middle');
    expect(ra.y + ra.h / 2).toBeCloseTo(rb.y + rb.h / 2);
  });
});

describe('distributeBoxes', () => {
  it('equalises horizontal gaps between three boxes', () => {
    const boxes: Box[] = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 15, y: 0, w: 10, h: 10 },
      { x: 80, y: 0, w: 10, h: 10 },
    ];
    const r = distributeBoxes(boxes, 'h');
    const gap1 = r[1].x - (r[0].x + r[0].w);
    const gap2 = r[2].x - (r[1].x + r[1].w);
    expect(gap1).toBeCloseTo(gap2);
    // extremes stay put
    expect(r[0].x).toBe(0);
    expect(r[2].x).toBe(80);
  });

  it('is a no-op for fewer than three boxes', () => {
    const boxes: Box[] = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 0, w: 10, h: 10 }];
    expect(distributeBoxes(boxes, 'h')).toEqual(boxes);
  });
});

describe('computeDragSnap', () => {
  it('snaps the moving box centre to the slide centre', () => {
    const moving: Box = { x: 39.5, y: 20, w: 20, h: 10 };
    const r = computeDragSnap(moving, [], 0.8);
    expect(r.x + moving.w / 2).toBeCloseTo(50);
    expect(r.vLines).toContain(50);
  });

  it('snaps a left edge to another box left edge', () => {
    const moving: Box = { x: 10.4, y: 40, w: 20, h: 10 };
    const other: Box = { x: 10, y: 0, w: 15, h: 10 };
    const r = computeDragSnap(moving, [other], 0.8);
    expect(r.x).toBeCloseTo(10);
    expect(r.vLines).toContain(10);
  });

  it('leaves the box untouched when nothing is within threshold', () => {
    const moving: Box = { x: 12, y: 33, w: 20, h: 10 };
    const r = computeDragSnap(moving, [], 0.8);
    expect(r.x).toBe(12);
    expect(r.y).toBe(33);
    expect(r.vLines).toHaveLength(0);
    expect(r.hLines).toHaveLength(0);
  });
});

describe('computeRotation', () => {
  it('reads 0° when the pointer is straight above the centre', () => {
    expect(computeRotation(50, 50, 50, 10, false)).toBeCloseTo(0);
  });

  it('reads 90° when the pointer is to the right', () => {
    expect(computeRotation(50, 50, 90, 50, false)).toBeCloseTo(90);
  });

  it('snaps to the nearest 15°', () => {
    expect(computeRotation(50, 50, 90, 44, true) % 15).toBe(0);
  });
});
