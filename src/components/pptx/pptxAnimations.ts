/**
 * pptxAnimations.ts — element entrance animations for presentation mode.
 *
 * Elements carry an optional `animation` ({ effect, order, durationMs }).
 * In presentation mode the deck advances one click-step at a time: elements
 * without an animation are always visible; animated elements appear when the
 * presenter reaches their step (elements sharing an order animate together).
 */

import type { ElementAnimationEffect, Slide, SlideElement } from './types';

export const ANIMATION_EFFECTS: Array<{ value: ElementAnimationEffect | 'none'; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade In' },
  { value: 'rise', label: 'Rise Up' },
  { value: 'zoom', label: 'Zoom In' },
  { value: 'slide-left', label: 'Slide from Right' },
  { value: 'slide-right', label: 'Slide from Left' },
  { value: 'wipe', label: 'Wipe' },
];

export const DEFAULT_ANIMATION_MS = 500;

/**
 * Click steps for a slide: element ids grouped by animation order, ascending.
 * Step N (0-based index) contains every element whose `animation.order`
 * is the (N+1)-th distinct order value on the slide.
 */
export function buildAnimationSteps(slide: Slide): string[][] {
  const grouped = new Map<number, string[]>();
  for (const el of slide.elements) {
    if (!el.animation) continue;
    const order = Number.isFinite(el.animation.order) ? el.animation.order : 1;
    const bucket = grouped.get(order) ?? [];
    bucket.push(el.id);
    grouped.set(order, bucket);
  }
  return [...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
}

/** Total click-steps a slide needs before it is fully revealed. */
export function animationStepCount(slide: Slide): number {
  return buildAnimationSteps(slide).length;
}

/**
 * Presentation visibility: has this element been revealed after `stepsDone`
 * click-steps? Non-animated elements are always visible.
 */
export function isElementRevealed(el: SlideElement, stepsDone: number, steps: string[][]): boolean {
  if (!el.animation) return true;
  const idx = steps.findIndex((ids) => ids.includes(el.id));
  if (idx < 0) return true;
  return stepsDone > idx;
}

/**
 * Elements that animate on exactly the step that just played — used to apply
 * the entrance animation class only to newly revealed elements.
 */
export function elementsAnimatingAtStep(steps: string[][], stepsDone: number): Set<string> {
  if (stepsDone <= 0 || stepsDone > steps.length) return new Set();
  return new Set(steps[stepsDone - 1]);
}

/** CSS class for an entrance effect (keyframes live in PptxEditor.css). */
export function animationClass(effect: ElementAnimationEffect): string {
  return `px-anim-${effect}`;
}

/**
 * Normalize step orders so they run 1..N without gaps (called after deletes
 * or order edits so the properties panel shows stable, dense numbering).
 */
export function normalizeAnimationOrders(elements: SlideElement[]): SlideElement[] {
  const orders = [...new Set(
    elements.filter((e) => e.animation).map((e) => e.animation!.order),
  )].sort((a, b) => a - b);
  const remap = new Map(orders.map((o, i) => [o, i + 1]));
  let changed = false;
  const next = elements.map((e) => {
    if (!e.animation) return e;
    const mapped = remap.get(e.animation.order) ?? 1;
    if (mapped === e.animation.order) return e;
    changed = true;
    return { ...e, animation: { ...e.animation, order: mapped } };
  });
  return changed ? next : elements;
}

/** Next free order value for a newly animated element. */
export function nextAnimationOrder(elements: SlideElement[]): number {
  let max = 0;
  for (const el of elements) {
    if (el.animation && el.animation.order > max) max = el.animation.order;
  }
  return max + 1;
}
