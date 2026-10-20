import { describe, expect, it } from 'vitest';
import { projectInsertIndex, projectReorderShifts, projectShiftTransform } from './projectReorderPreview';

const ids = ['a', 'b', 'c', 'd', 'e'];
const entries = (m: Map<string, -1 | 1>) => Object.fromEntries(m);

describe('project reorder preview', () => {
  it('computes the slot index from the hovered row and side', () => {
    expect(projectInsertIndex(ids, { projectId: 'c', side: 'before' })).toBe(2);
    expect(projectInsertIndex(ids, { projectId: 'c', side: 'after' })).toBe(3);
    expect(projectInsertIndex(ids, { projectId: 'zz', side: 'after' })).toBe(-1);
  });

  it('slides the rows between the dragged row and the slot when moving down', () => {
    expect(entries(projectReorderShifts(ids, 'a', { projectId: 'd', side: 'after' }))).toEqual({ b: -1, c: -1, d: -1 });
    expect(entries(projectReorderShifts(ids, 'a', { projectId: 'c', side: 'before' }))).toEqual({ b: -1 });
  });

  it('slides the rows between the slot and the dragged row when moving up', () => {
    expect(entries(projectReorderShifts(ids, 'e', { projectId: 'b', side: 'before' }))).toEqual({ b: 1, c: 1, d: 1 });
    expect(entries(projectReorderShifts(ids, 'd', { projectId: 'c', side: 'before' }))).toEqual({ c: 1 });
  });

  it('does nothing when the slot is where the row already is', () => {
    expect(projectReorderShifts(ids, 'c', { projectId: 'b', side: 'after' }).size).toBe(0);
    expect(projectReorderShifts(ids, 'c', { projectId: 'd', side: 'before' }).size).toBe(0);
    expect(projectReorderShifts(ids, 'c', { projectId: 'c', side: 'after' }).size).toBe(0);
    expect(projectReorderShifts(ids, 'c', null).size).toBe(0);
  });

  it('leaves the list alone for a row dragged in from another list', () => {
    expect(projectReorderShifts(ids, 'x', { projectId: 'c', side: 'before' }).size).toBe(0);
  });

  it('renders transforms along the list axis only', () => {
    expect(projectShiftTransform(1, { w: 120.4, h: 92.6, multiLine: false }, 'vertical')).toBe('translate3d(0, 93px, 0)');
    expect(projectShiftTransform(-1, { w: 120.4, h: 92.6, multiLine: false }, 'horizontal')).toBe('translate3d(-120px, 0, 0)');
    expect(projectShiftTransform(-1, { w: 120.4, h: 92.6, multiLine: true }, 'horizontal')).toBeUndefined();
    expect(projectShiftTransform(1, { w: 120.4, h: 92.6, multiLine: true }, 'vertical')).toBe('translate3d(0, 93px, 0)');
    expect(projectShiftTransform(undefined, { w: 1, h: 1, multiLine: false }, 'vertical')).toBeUndefined();
    expect(projectShiftTransform(1, null, 'vertical')).toBeUndefined();
  });
});
