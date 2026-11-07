import { afterEach, describe, expect, it } from 'vitest';
import { GUIDE_STEPS, type GuideStep } from './steps';
import { boxesOverlap, placeCaption, resolveTarget, screenBoxOf, shouldPinGuide } from './spotlightTarget';

const project = GUIDE_STEPS.find(s => s.id === 'project')!;
const git = GUIDE_STEPS.find(s => s.id === 'git-keys')!;

function add(attr: string, size = { w: 40, h: 20 }) {
  const el = document.createElement('button');
  el.setAttribute('data-guide', attr);
  el.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, width: size.w, height: size.h, right: 10 + size.w, bottom: 10 + size.h, toJSON() { return {}; } }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe('resolveTarget', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('returns alt when both exist', () => {
    add('project-open');
    const alt = add('new-project-folder');
    expect(resolveTarget(project, document)?.el).toBe(alt);
  });

  it('returns primary when alt absent', () => {
    const primary = add('project-open');
    const r = resolveTarget(project, document);
    expect(r?.el).toBe(primary);
    expect(r?.rect.width).toBe(40);
  });

  it('falls back to primary when alt is zero-size', () => {
    const primary = add('project-open');
    add('new-project-folder', { w: 0, h: 0 });
    expect(resolveTarget(project, document)?.el).toBe(primary);
  });

  it('resolveTarget missing', () => {
    add('something-else');
    expect(resolveTarget(git, document)).toBeNull();
  });

  it('null when element has zero size (hidden toolbar)', () => {
    add('git', { w: 0, h: 0 });
    expect(resolveTarget(git, document)).toBeNull();
  });

  it('null for steps without a target', () => {
    const status = GUIDE_STEPS.find(s => s.id === 'status') as GuideStep;
    expect(resolveTarget(status, document)).toBeNull();
  });
});

describe('placeCaption', () => {
  const r = (left: number, top: number, w = 40, h = 20) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });

  it('goes below the target when there is room', () => {
    const p = placeCaption(r(100, 50), 1200, 800, 280, 100);
    expect(p.side).toBe('below');
    expect(p.top).toBeGreaterThan(70);
  });

  it('flips above near the bottom edge', () => {
    const p = placeCaption(r(100, 740), 1200, 800, 280, 100);
    expect(p.side).toBe('above');
    expect(p.top + 100).toBeLessThanOrEqual(740);
  });

  it('stays inside the viewport horizontally', () => {
    expect(placeCaption(r(1180, 50, 20), 1200, 800, 280, 100).left).toBeLessThanOrEqual(1200 - 280 - 12);
    expect(placeCaption(r(0, 50, 10), 1200, 800, 280, 100).left).toBeGreaterThanOrEqual(12);
  });
});

describe('shouldPinGuide', () => {
  const target = { x: 1000, y: 100, w: 40, h: 30 };

  it('pins the guide when it sits beside the target', () => {
    expect(shouldPinGuide({ x: 1300, y: 0, w: 900, h: 620 }, target)).toBe(true);
  });

  it('does not pin a guide that covers the target', () => {
    expect(shouldPinGuide({ x: 800, y: 50, w: 900, h: 620 }, target)).toBe(false);
  });

  it('touching edges is not an overlap', () => {
    expect(boxesOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });

  it('does not pin when the guide rect is unknown', () => {
    expect(shouldPinGuide(null, target)).toBe(false);
  });

  it('screenBoxOf maps a viewport rect to screen coordinates', () => {
    expect(screenBoxOf({ x: 200, y: 50 }, { left: 10, top: 20, width: 30, height: 40 })).toEqual({ x: 210, y: 70, w: 30, h: 40 });
  });
});
