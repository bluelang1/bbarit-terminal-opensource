import { describe, expect, it } from 'vitest';
import {
  animationStepCount,
  buildAnimationSteps,
  elementsAnimatingAtStep,
  isElementRevealed,
  nextAnimationOrder,
  normalizeAnimationOrders,
} from './pptxAnimations';
import type { Slide, SlideElement } from './types';

const el = (id: string, order?: number): SlideElement => ({
  id, type: 'text', x: 0, y: 0, w: 10, h: 10,
  ...(order !== undefined ? { animation: { effect: 'fade' as const, order } } : {}),
});

const slide = (elements: SlideElement[]): Slide => ({ id: 's1', bgColor: '#fff', elements });

describe('buildAnimationSteps', () => {
  it('groups elements by order, ascending, skipping non-animated', () => {
    const s = slide([el('static'), el('b', 2), el('a', 1), el('b2', 2)]);
    expect(buildAnimationSteps(s)).toEqual([['a'], ['b', 'b2']]);
    expect(animationStepCount(s)).toBe(2);
  });

  it('handles gaps in order values', () => {
    const s = slide([el('x', 10), el('y', 3)]);
    expect(buildAnimationSteps(s)).toEqual([['y'], ['x']]);
  });

  it('returns no steps for a slide without animations', () => {
    expect(buildAnimationSteps(slide([el('a'), el('b')]))).toEqual([]);
  });
});

describe('isElementRevealed', () => {
  const s = slide([el('static'), el('first', 1), el('second', 2)]);
  const steps = buildAnimationSteps(s);

  it('always reveals non-animated elements', () => {
    expect(isElementRevealed(s.elements[0], 0, steps)).toBe(true);
  });

  it('reveals animated elements only after their step has played', () => {
    const first = s.elements[1];
    const second = s.elements[2];
    expect(isElementRevealed(first, 0, steps)).toBe(false);
    expect(isElementRevealed(first, 1, steps)).toBe(true);
    expect(isElementRevealed(second, 1, steps)).toBe(false);
    expect(isElementRevealed(second, 2, steps)).toBe(true);
  });
});

describe('elementsAnimatingAtStep', () => {
  const steps = [['a'], ['b', 'c']];

  it('returns the ids of the step that just played', () => {
    expect([...elementsAnimatingAtStep(steps, 1)]).toEqual(['a']);
    expect([...elementsAnimatingAtStep(steps, 2)].sort()).toEqual(['b', 'c']);
  });

  it('returns empty outside the valid range', () => {
    expect(elementsAnimatingAtStep(steps, 0).size).toBe(0);
    expect(elementsAnimatingAtStep(steps, 3).size).toBe(0);
  });
});

describe('normalizeAnimationOrders', () => {
  it('re-numbers sparse orders densely from 1', () => {
    const input = [el('a', 5), el('b', 2), el('static')];
    const out = normalizeAnimationOrders(input);
    expect(out.find((e) => e.id === 'b')!.animation!.order).toBe(1);
    expect(out.find((e) => e.id === 'a')!.animation!.order).toBe(2);
    expect(out.find((e) => e.id === 'static')!.animation).toBeUndefined();
  });

  it('returns the same array when nothing changes', () => {
    const input = [el('a', 1), el('b', 2)];
    expect(normalizeAnimationOrders(input)).toBe(input);
  });
});

describe('nextAnimationOrder', () => {
  it('appends after the highest existing order', () => {
    expect(nextAnimationOrder([el('a', 1), el('b', 3), el('static')])).toBe(4);
    expect(nextAnimationOrder([el('static')])).toBe(1);
  });
});
