import { describe, it, expect } from 'vitest';
import {
  type PixelBuf,
  adjustBrightnessContrast,
  adjustHsl,
  adjustLevels,
  invertPixels,
  grayscalePixels,
  sepiaPixels,
  blurPixels,
  sharpenPixels,
  pixelatePixels,
  noisePixels,
  floodFillMask,
  polygonMask,
  rectMask,
  ellipseMask,
  invertMask,
  unionMask,
  subtractMask,
  maskIsEmpty,
  curveLut,
  applyLut,
  lumaHistogram,
  blendByMask,
  bucketFill,
  rgbToHsl,
  hslToRgb,
  hexToRgb,
} from './photoFilters';

function solidBuf(w: number, h: number, rgba: [number, number, number, number]): PixelBuf {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { data, width: w, height: h };
}

function pixelAt(buf: PixelBuf, x: number, y: number): number[] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2], buf.data[i + 3]];
}

describe('color conversion', () => {
  it('should_round_trip_rgb_hsl', () => {
    const [h, s, l] = rgbToHsl(200, 100, 50);
    const [r, g, b] = hslToRgb(h, s, l);
    expect(Math.abs(r - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(b - 50)).toBeLessThanOrEqual(1);
  });

  it('should_parse_hex_colors', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
    expect(hexToRgb('#0a141e')).toEqual([10, 20, 30]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
  });
});

describe('adjustBrightnessContrast', () => {
  it('should_brighten_and_clamp', () => {
    const buf = solidBuf(2, 2, [200, 200, 200, 255]);
    const out = adjustBrightnessContrast(buf, 100, 0);
    expect(pixelAt(out, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('should_not_change_pixels_at_zero', () => {
    const buf = solidBuf(2, 2, [123, 45, 67, 200]);
    const out = adjustBrightnessContrast(buf, 0, 0);
    expect(pixelAt(out, 1, 1)).toEqual([123, 45, 67, 200]);
  });

  it('should_push_toward_midgray_with_negative_contrast', () => {
    const buf = solidBuf(1, 1, [255, 0, 128, 255]);
    const out = adjustBrightnessContrast(buf, 0, -100);
    expect(pixelAt(out, 0, 0).slice(0, 3)).toEqual([128, 128, 128]);
  });
});

describe('adjustHsl', () => {
  it('should_rotate_red_to_green_with_120_hue', () => {
    const buf = solidBuf(1, 1, [255, 0, 0, 255]);
    const out = adjustHsl(buf, 120, 0, 0);
    const [r, g, b] = pixelAt(out, 0, 0);
    expect(g).toBe(255);
    expect(r).toBe(0);
    expect(b).toBe(0);
  });

  it('should_desaturate_to_gray_at_minus_100', () => {
    const buf = solidBuf(1, 1, [255, 0, 0, 255]);
    const out = adjustHsl(buf, 0, -100, 0);
    const [r, g, b] = pixelAt(out, 0, 0);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
});

describe('adjustLevels', () => {
  it('should_map_black_and_white_points', () => {
    const buf = solidBuf(1, 1, [50, 200, 125, 255]);
    const out = adjustLevels(buf, 50, 200, 1);
    const [r, g, b] = pixelAt(out, 0, 0);
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(128);
  });
});

describe('invert / grayscale / sepia', () => {
  it('should_invert_rgb_but_keep_alpha', () => {
    const out = invertPixels(solidBuf(1, 1, [10, 20, 30, 111]));
    expect(pixelAt(out, 0, 0)).toEqual([245, 235, 225, 111]);
  });

  it('should_grayscale_with_luma_weights', () => {
    const out = grayscalePixels(solidBuf(1, 1, [255, 0, 0, 255]));
    const [r, g, b] = pixelAt(out, 0, 0);
    expect(r).toBe(76);
    expect(g).toBe(76);
    expect(b).toBe(76);
  });

  it('should_apply_sepia_tone', () => {
    const out = sepiaPixels(solidBuf(1, 1, [100, 100, 100, 255]));
    const [r, g, b] = pixelAt(out, 0, 0);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});

describe('blurPixels', () => {
  it('should_keep_uniform_image_unchanged', () => {
    const out = blurPixels(solidBuf(8, 8, [90, 120, 150, 255]), 2);
    expect(pixelAt(out, 4, 4)).toEqual([90, 120, 150, 255]);
    expect(pixelAt(out, 0, 0)).toEqual([90, 120, 150, 255]);
  });

  it('should_spread_a_bright_pixel', () => {
    const buf = solidBuf(9, 9, [0, 0, 0, 255]);
    const c = (4 * 9 + 4) * 4;
    buf.data[c] = 255; buf.data[c + 1] = 255; buf.data[c + 2] = 255;
    const out = blurPixels(buf, 1);
    expect(pixelAt(out, 4, 4)[0]).toBeLessThan(255);
    expect(pixelAt(out, 3, 4)[0]).toBeGreaterThan(0);
  });
});

describe('sharpenPixels', () => {
  it('should_increase_edge_contrast', () => {
    const buf = solidBuf(8, 1, [100, 100, 100, 255]);
    for (let x = 4; x < 8; x++) {
      const i = x * 4;
      buf.data[i] = 200; buf.data[i + 1] = 200; buf.data[i + 2] = 200;
    }
    const out = sharpenPixels(buf, 100);
    expect(pixelAt(out, 4, 0)[0]).toBeGreaterThan(200);
    expect(pixelAt(out, 3, 0)[0]).toBeLessThan(100);
  });
});

describe('pixelatePixels', () => {
  it('should_average_each_block', () => {
    const buf = solidBuf(4, 4, [0, 0, 0, 255]);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      const i = (y * 4 + x) * 4;
      buf.data[i] = 255;
    }
    const out = pixelatePixels(buf, 4);
    // 4 of 16 pixels were red 255 → average red = 63.75 ≈ 64
    expect(pixelAt(out, 0, 0)[0]).toBe(64);
    expect(pixelAt(out, 3, 3)[0]).toBe(64);
  });
});

describe('noisePixels', () => {
  it('should_be_deterministic_with_seeded_rand', () => {
    const buf = solidBuf(2, 2, [128, 128, 128, 255]);
    let seed = 0;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const a = noisePixels(buf, 50, rand);
    seed = 0;
    const b = noisePixels(buf, 50, rand);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('floodFillMask', () => {
  it('should_select_contiguous_region_only', () => {
    // 4x1: [white, white, black, white] — fill from x=0 must stop at black
    const buf = solidBuf(4, 1, [255, 255, 255, 255]);
    buf.data.set([0, 0, 0, 255], 2 * 4);
    const mask = floodFillMask(buf, 0, 0, 10);
    expect(Array.from(mask)).toEqual([255, 255, 0, 0]);
  });

  it('should_respect_tolerance', () => {
    const buf = solidBuf(2, 1, [100, 100, 100, 255]);
    buf.data.set([130, 100, 100, 255], 4);
    expect(Array.from(floodFillMask(buf, 0, 0, 10))).toEqual([255, 0]);
    expect(Array.from(floodFillMask(buf, 0, 0, 40))).toEqual([255, 255]);
  });

  it('should_return_empty_mask_for_out_of_bounds_start', () => {
    const mask = floodFillMask(solidBuf(2, 2, [0, 0, 0, 255]), -1, 5, 10);
    expect(maskIsEmpty(mask)).toBe(true);
  });
});

describe('selection masks', () => {
  it('should_fill_rect_region', () => {
    const mask = rectMask(1, 1, 2, 2, 4, 4);
    expect(mask[1 * 4 + 1]).toBe(255);
    expect(mask[2 * 4 + 2]).toBe(255);
    expect(mask[0]).toBe(0);
    expect(mask[3 * 4 + 3]).toBe(0);
  });

  it('should_handle_negative_rect_dimensions', () => {
    const a = rectMask(3, 3, -2, -2, 4, 4);
    const b = rectMask(1, 1, 2, 2, 4, 4);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('should_fill_ellipse_center_not_corners', () => {
    const mask = ellipseMask(5, 5, 4, 4, 10, 10);
    expect(mask[5 * 10 + 5]).toBe(255);
    expect(mask[0]).toBe(0);
    expect(mask[9 * 10 + 9]).toBe(0);
  });

  it('should_fill_polygon_interior', () => {
    const mask = polygonMask([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }], 8, 8);
    expect(mask[4 * 8 + 4]).toBe(255);
  });

  it('should_invert_mask', () => {
    const mask = rectMask(0, 0, 1, 1, 2, 1);
    const inv = invertMask(mask);
    expect(Array.from(inv)).toEqual([0, 255]);
  });
});

describe('mask combine', () => {
  it('should_union_masks', () => {
    expect(Array.from(unionMask(new Uint8Array([255, 0, 0]), new Uint8Array([0, 255, 0])))).toEqual([255, 255, 0]);
  });

  it('should_subtract_mask_b_from_a', () => {
    expect(Array.from(subtractMask(new Uint8Array([255, 255, 0]), new Uint8Array([0, 255, 255])))).toEqual([255, 0, 0]);
  });
});

describe('curveLut / applyLut', () => {
  it('should_be_identity_with_diagonal_endpoints', () => {
    const lut = curveLut([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    expect(lut[0]).toBe(0);
    expect(lut[128]).toBe(128);
    expect(lut[255]).toBe(255);
  });

  it('should_brighten_midtones_with_raised_midpoint_and_keep_endpoints', () => {
    const lut = curveLut([{ x: 0, y: 0 }, { x: 128, y: 190 }, { x: 255, y: 255 }]);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    expect(lut[128]).toBe(190);
    expect(lut[64]).toBeGreaterThan(64);
  });

  it('should_extend_flat_past_end_points', () => {
    const lut = curveLut([{ x: 50, y: 100 }, { x: 200, y: 150 }]);
    expect(lut[0]).toBe(100);
    expect(lut[49]).toBe(100);
    expect(lut[201]).toBe(150);
    expect(lut[255]).toBe(150);
  });

  it('should_apply_lut_to_rgb_and_keep_alpha', () => {
    const lut = curveLut([{ x: 0, y: 255 }, { x: 255, y: 0 }]); // invert curve
    const out = applyLut(solidBuf(1, 1, [0, 128, 255, 77]), lut);
    const [r, g, b, a] = pixelAt(out, 0, 0);
    expect(r).toBe(255);
    expect(g).toBe(127);
    expect(b).toBe(0);
    expect(a).toBe(77);
  });
});

describe('lumaHistogram', () => {
  it('should_count_pixels_by_luma_and_skip_transparent', () => {
    const buf = solidBuf(2, 1, [255, 255, 255, 255]);
    buf.data[7] = 0; // second pixel fully transparent
    const bins = lumaHistogram(buf);
    expect(bins[255]).toBe(1);
    expect(Array.from(bins).reduce((s, v) => s + v, 0)).toBe(1);
  });
});

describe('blendByMask', () => {
  it('should_apply_filtered_only_inside_mask', () => {
    const orig = solidBuf(2, 1, [0, 0, 0, 255]);
    const filtered = solidBuf(2, 1, [255, 255, 255, 255]);
    const mask = new Uint8Array([255, 0]);
    const out = blendByMask(orig, filtered, mask);
    expect(pixelAt(out, 0, 0)[0]).toBe(255);
    expect(pixelAt(out, 1, 0)[0]).toBe(0);
  });

  it('should_return_filtered_when_mask_is_null', () => {
    const orig = solidBuf(1, 1, [0, 0, 0, 255]);
    const filtered = solidBuf(1, 1, [9, 9, 9, 255]);
    expect(pixelAt(blendByMask(orig, filtered, null), 0, 0)[0]).toBe(9);
  });
});

describe('bucketFill', () => {
  it('should_fill_contiguous_region_with_color', () => {
    const buf = solidBuf(3, 1, [255, 255, 255, 255]);
    buf.data.set([0, 0, 0, 255], 1 * 4);
    const out = bucketFill(buf, 0, 0, [255, 0, 0], 10, null);
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 2, 0)).toEqual([255, 255, 255, 255]);
  });

  it('should_respect_selection_mask', () => {
    const buf = solidBuf(2, 1, [255, 255, 255, 255]);
    const sel = new Uint8Array([255, 0]);
    const out = bucketFill(buf, 0, 0, [0, 255, 0], 10, sel);
    expect(pixelAt(out, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([255, 255, 255, 255]);
  });
});
