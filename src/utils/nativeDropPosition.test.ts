import { describe, expect, it } from 'vitest';
import { nativeDropPositionToCss } from './nativeDropPosition';

describe('nativeDropPositionToCss', () => {
  it('keeps macOS positions as-is: wry already reports CSS points on Retina displays', () => {
    expect(nativeDropPositionToCss({ x: 726, y: 594 }, 2, { platform: 'MacIntel' })).toEqual({ x: 726, y: 594 });
  });

  it('converts physical positions on scaled Windows displays', () => {
    expect(nativeDropPositionToCss({ x: 1500, y: 750 }, 1.25, { platform: 'Win32' })).toEqual({ x: 1200, y: 600 });
  });

  it('keeps Linux positions as-is: GTK widget coordinates are already CSS pixels', () => {
    expect(nativeDropPositionToCss({ x: 800, y: 450 }, 2, { platform: 'Linux x86_64' })).toEqual({ x: 800, y: 450 });
  });

  it('falls back to the viewport bounds when the platform is unknown', () => {
    const viewport = { width: 1800, height: 1098 };
    expect(nativeDropPositionToCss({ x: 726, y: 594 }, 2, { viewport })).toEqual({ x: 726, y: 594 });
    expect(nativeDropPositionToCss({ x: 2400, y: 1500 }, 2, { viewport })).toEqual({ x: 1200, y: 750 });
  });

  it('uses a safe 1x fallback for missing display scale', () => {
    expect(nativeDropPositionToCss({ x: 40, y: 60 }, 0, { platform: 'Win32' })).toEqual({ x: 40, y: 60 });
  });
});
