import { describe, expect, it } from 'vitest';
import {
  WORD_THEME_COLORS,
  WORD_STANDARD_COLORS,
  WORD_HIGHLIGHT_COLORS,
  hexToRgb,
  rgbToHex,
  tint,
  shade,
  themeColorColumn,
  buildThemeColorGrid,
  LINE_SPACING_OPTIONS,
  DOCX_PAGE_SIZES,
  DOCX_PAGE_MARGINS,
  DEFAULT_PAGE_SETUP,
  pageDimensions,
  pxToTwip,
} from './docxWordChrome';

const HEX = /^#[0-9A-F]{6}$/;

describe('word color palette', () => {
  it('defines the Word palette rows', () => {
    expect(WORD_THEME_COLORS).toHaveLength(10);
    expect(WORD_STANDARD_COLORS).toHaveLength(10);
    expect(WORD_HIGHLIGHT_COLORS).toHaveLength(15);
    for (const c of [...WORD_THEME_COLORS, ...WORD_STANDARD_COLORS, ...WORD_HIGHLIGHT_COLORS]) {
      expect(c).toMatch(HEX);
    }
  });

  it('converts hex to rgb and back', () => {
    expect(hexToRgb('#4472C4')).toEqual([0x44, 0x72, 0xC4]);
    expect(hexToRgb('nope')).toBeNull();
    expect(rgbToHex(0x44, 0x72, 0xC4)).toBe('#4472C4');
    expect(rgbToHex(-5, 300, 128)).toBe('#00FF80');
  });

  it('tints toward white and shades toward black', () => {
    expect(tint('#000000', 1)).toBe('#FFFFFF');
    expect(tint('#4472C4', 0)).toBe('#4472C4');
    expect(shade('#FFFFFF', 1)).toBe('#000000');
    expect(shade('#4472C4', 0)).toBe('#4472C4');
    // 밝게는 원색보다 밝고, 어둡게는 어둡다
    const [r0] = hexToRgb('#4472C4')!;
    expect(hexToRgb(tint('#4472C4', 0.4))![0]).toBeGreaterThan(r0);
    expect(hexToRgb(shade('#4472C4', 0.25))![0]).toBeLessThan(r0);
  });

  it('builds a 5x10 theme variant grid', () => {
    const grid = buildThemeColorGrid();
    expect(grid).toHaveLength(5);
    for (const row of grid) {
      expect(row).toHaveLength(10);
      for (const c of row) expect(c).toMatch(HEX);
    }
  });

  it('darkens the white column and lightens the black column like Word', () => {
    const white = themeColorColumn('#FFFFFF');
    const black = themeColorColumn('#000000');
    // 흰색 열: 아래로 갈수록 어둡다
    const lum = (hex: string) => hexToRgb(hex)!.reduce((a, b) => a + b, 0);
    for (let i = 1; i < white.length; i += 1) expect(lum(white[i])).toBeLessThan(lum(white[i - 1]));
    // 검정 열: 아래로 갈수록 어둡다(밝은 변형이 위)
    for (let i = 1; i < black.length; i += 1) expect(lum(black[i])).toBeLessThan(lum(black[i - 1]));
  });
});

describe('line spacing', () => {
  it('matches Word dropdown options', () => {
    expect(LINE_SPACING_OPTIONS).toEqual(['1.0', '1.15', '1.5', '2.0', '2.5', '3.0']);
  });
});

describe('page setup', () => {
  it('swaps dimensions for landscape', () => {
    expect(pageDimensions({ ...DEFAULT_PAGE_SETUP })).toEqual({ w: 794, h: 1123 });
    expect(pageDimensions({ ...DEFAULT_PAGE_SETUP, orientation: 'landscape' })).toEqual({ w: 1123, h: 794 });
    expect(pageDimensions({ size: 'letter', orientation: 'portrait', margin: 'normal' })).toEqual({ w: 816, h: 1054 });
  });

  it('defines Word margin presets with narrow < normal < wide', () => {
    expect(DOCX_PAGE_MARGINS.narrow.side).toBeLessThan(DOCX_PAGE_MARGINS.normal.side);
    expect(DOCX_PAGE_MARGINS.normal.side).toBeLessThan(DOCX_PAGE_MARGINS.wide.side);
    expect(DOCX_PAGE_MARGINS.moderate.side).toBeLessThan(DOCX_PAGE_MARGINS.normal.side);
  });

  it('converts 96dpi px to twip (1in = 1440 twip)', () => {
    expect(pxToTwip(96)).toBe(1440);
    expect(pxToTwip(DOCX_PAGE_SIZES.a4.w)).toBe(11910);
  });
});
