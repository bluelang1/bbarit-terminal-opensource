import { describe, expect, it } from 'vitest';
import { guideUrl, placeGuideWindow } from './openGuide';

const monitor = { x: 0, y: 0, w: 2560, h: 1440 };
const size = { w: 900, h: 620 };

describe('placeGuideWindow', () => {
  it('goes to the right of the main window when there is room', () => {
    const p = placeGuideWindow({ x: 100, y: 100, w: 1200, h: 900 }, monitor, size);
    expect(p.x).toBeGreaterThanOrEqual(1300);
    expect(p.x + size.w).toBeLessThanOrEqual(2560);
  });

  it('goes to the left when only the left has room', () => {
    const p = placeGuideWindow({ x: 1300, y: 100, w: 1200, h: 900 }, monitor, size);
    expect(p.x + size.w).toBeLessThanOrEqual(1300);
    expect(p.x).toBeGreaterThanOrEqual(0);
  });

  it('sits over the main window right half when the main window fills the screen', () => {
    const p = placeGuideWindow({ x: 0, y: 0, w: 2560, h: 1440 }, monitor, size);
    expect(p.x).toBeGreaterThanOrEqual(1280 - size.w / 2);
    expect(p.x + size.w).toBeLessThanOrEqual(2560);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + size.h).toBeLessThanOrEqual(1440);
  });

  it('respects a monitor that does not start at 0,0', () => {
    const m2 = { x: -1920, y: 0, w: 1920, h: 1080 };
    const p = placeGuideWindow({ x: -1920, y: 0, w: 1920, h: 1080 }, m2, size);
    expect(p.x).toBeGreaterThanOrEqual(-1920);
    expect(p.x + size.w).toBeLessThanOrEqual(0);
  });
});

describe('guideUrl', () => {
  it('encodes mode, step and from', () => {
    expect(guideUrl({ mode: 'start', step: 'project' })).toBe('/guide?mode=start&step=project');
    expect(guideUrl({ mode: 'whatsnew', from: '1.1.64' })).toBe('/guide?mode=whatsnew&from=1.1.64');
    expect(guideUrl({ mode: 'whatsnew', from: null })).toBe('/guide?mode=whatsnew');
  });
});
