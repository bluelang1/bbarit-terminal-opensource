import { describe, expect, it } from 'vitest';
import {
  auditContrast,
  checkContrast,
  contrastRatio,
  isLargeText,
  parseColor,
  relativeLuminance,
  type ContrastSample,
} from './browserContrast';

describe('parseColor', () => {
  // 정상 + 매핑: hex6/hex3/rgb/named.
  it('parses hex, rgb and named colors', () => {
    expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor('rgb(37, 99, 235)')).toEqual({ r: 37, g: 99, b: 235 });
    expect(parseColor('rgba(0,0,0,0.5)')).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255 });
  });
  // None/변조: junk → null.
  it('returns null for unparseable', () => {
    expect(parseColor('nonsense')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('is 1 for white and 0 for black', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  // 정상: known WCAG ratios.
  it('computes correct ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);   // max
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);    // same
    // #767676 on white ≈ 4.54 (a classic AA-boundary grey)
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });
  it('returns null for unparseable colors', () => {
    expect(contrastRatio('bad', '#fff')).toBeNull();
  });
});

describe('isLargeText', () => {
  it('classifies large text per WCAG', () => {
    expect(isLargeText(24, false)).toBe(true);
    expect(isLargeText(19, true)).toBe(true);   // >=18.66 bold
    expect(isLargeText(16, false)).toBe(false);
    expect(isLargeText(16, true)).toBe(false);
  });
});

describe('checkContrast', () => {
  // 정상: pass AAA (black/white).
  it('passes AAA for black on white', () => {
    const v = checkContrast('#000', '#fff', 16, false);
    expect(v).toMatchObject({ ratio: 21, passAA: true, passAAA: true, level: 'pass-aaa', required: 4.5 });
  });
  // 매핑: mid-grey passes AA but not AAA at normal size.
  it('distinguishes AA vs AAA', () => {
    const v = checkContrast('#767676', '#ffffff', 16, false);
    expect(v.passAA).toBe(true);
    expect(v.passAAA).toBe(false);
    expect(v.level).toBe('pass-aa');
  });
  // 매핑: large text has a lower threshold (3:1).
  it('uses the 3:1 threshold for large text', () => {
    const normal = checkContrast('#949494', '#ffffff', 16, false); // ~3.0 → fails AA normal
    const large = checkContrast('#949494', '#ffffff', 24, false);  // large → passes AA
    expect(normal.passAA).toBe(false);
    expect(large.passAA).toBe(true);
    expect(large.required).toBe(3);
  });
  // 변조: unparseable → fail with null ratio.
  it('fails safely for unparseable colors', () => {
    expect(checkContrast('bad', '#fff').level).toBe('fail');
  });
});

describe('auditContrast', () => {
  const samples: ContrastSample[] = [
    { fg: '#000', bg: '#fff', text: 'good' },
    { fg: '#bbbbbb', bg: '#ffffff', fontSize: 14, text: 'too light' }, // ~1.9 fail
    { fg: '#767676', bg: '#ffffff', text: 'boundary ok' },             // ~4.54 pass
    { fg: 'bad', bg: 'also-bad', text: 'unparseable' },                // skipped
  ];
  // 정상: only AA failures returned, worst first.
  it('reports AA failures worst-first and skips unparseable', () => {
    const r = auditContrast(samples);
    expect(r.checked).toBe(3);            // unparseable skipped
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].text).toBe('too light');
    expect(r.worstRatio).toBeLessThan(2);
  });
  // None: empty input.
  it('handles empty input', () => {
    expect(auditContrast([])).toEqual({ checked: 0, failures: [], worstRatio: null });
    expect(auditContrast(undefined as unknown as ContrastSample[]).checked).toBe(0);
  });
});
