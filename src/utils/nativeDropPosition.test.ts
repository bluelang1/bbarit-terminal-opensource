import { describe, expect, it } from 'vitest';
import { nativeDropPositionToCss } from './nativeDropPosition';

describe('nativeDropPositionToCss', () => {
  it('converts Tauri physical positions for Retina macOS displays', () => {
    expect(nativeDropPositionToCss({ x: 1600, y: 900 }, 2)).toEqual({ x: 800, y: 450 });
  });

  it('converts positions for scaled Windows displays', () => {
    expect(nativeDropPositionToCss({ x: 1500, y: 750 }, 1.25)).toEqual({ x: 1200, y: 600 });
  });

  it('uses a safe 1x fallback for missing display scale', () => {
    expect(nativeDropPositionToCss({ x: 40, y: 60 }, 0)).toEqual({ x: 40, y: 60 });
  });
});
