import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FONT_INDEX,
  DEFAULT_FONT_INDEX,
  FONTS,
  cssFontFamilyName,
  fontDisplayName,
  getEffectiveFont,
  rankSystemFonts,
} from './theme';

describe('font presets', () => {
  it('first preset prefers the installed Nerd font and falls back to bundled Fira Code', () => {
    expect(FONTS[0]).toEqual({
      name: 'FiraCode Nerd Font Mono',
      value: "'FiraCode Nerd Font Mono', 'Fira Code', monospace",
    });
  });

  it('keeps preset indexes stable and Custom last', () => {
    expect(FONTS.map((f) => f.name)).toEqual([
      'FiraCode Nerd Font Mono', 'JetBrains Mono', 'Source Code Pro', 'Cascadia Code', 'Hack',
      'D2Coding', 'Nanum Gothic Coding', 'Custom',
    ]);
    expect(CUSTOM_FONT_INDEX).toBe(7);
  });

  it('new projects default to the Nerd font preset', () => {
    expect(DEFAULT_FONT_INDEX).toBe(0);
    expect(getEffectiveFont(DEFAULT_FONT_INDEX)).toContain('FiraCode Nerd Font Mono');
  });
});

describe('getEffectiveFont', () => {
  it('returns preset values and falls back to the default for bad indexes', () => {
    expect(getEffectiveFont(1)).toBe("'JetBrains Mono', monospace");
    expect(getEffectiveFont(99)).toBe(FONTS[0].value);
    expect(getEffectiveFont(-1)).toBe(FONTS[0].value);
  });

  it('ignores the custom family unless Custom is selected', () => {
    expect(getEffectiveFont(1, 'Menlo')).toBe("'JetBrains Mono', monospace");
  });

  it('quotes the custom family', () => {
    expect(getEffectiveFont(CUSTOM_FONT_INDEX, '  FiraCode Nerd Font Mono ')).toBe('"FiraCode Nerd Font Mono", monospace');
    expect(getEffectiveFont(CUSTOM_FONT_INDEX, 'Menlo')).toBe('"Menlo", monospace');
    expect(getEffectiveFont(CUSTOM_FONT_INDEX, '3270 Nerd Font')).toBe('"3270 Nerd Font", monospace');
  });

  it('Custom without a family falls back to the default preset instead of an empty string', () => {
    expect(getEffectiveFont(CUSTOM_FONT_INDEX)).toBe(FONTS[0].value);
    expect(getEffectiveFont(CUSTOM_FONT_INDEX, '   ')).toBe(FONTS[0].value);
  });
});

describe('cssFontFamilyName', () => {
  it('escapes quotes and backslashes', () => {
    expect(cssFontFamilyName('A "B"')).toBe('"A \\"B\\""');
    expect(cssFontFamilyName('C\\D')).toBe('"C\\\\D"');
  });
});

describe('fontDisplayName', () => {
  it('shows the custom family name, or Custom when none is chosen', () => {
    expect(fontDisplayName(0)).toBe('FiraCode Nerd Font Mono');
    expect(fontDisplayName(CUSTOM_FONT_INDEX, 'Menlo')).toBe('Menlo');
    expect(fontDisplayName(CUSTOM_FONT_INDEX, '')).toBe('Custom');
  });
});

describe('rankSystemFonts', () => {
  const fonts = ['Arial', 'FiraCode Nerd Font Mono', 'Helvetica', 'Menlo', 'SF Mono', 'Times'];

  it('puts monospace-looking families first, keeping input order', () => {
    expect(rankSystemFonts(fonts)).toEqual(['FiraCode Nerd Font Mono', 'Menlo', 'SF Mono', 'Arial', 'Helvetica', 'Times']);
  });

  it('filters by case-insensitive substring', () => {
    expect(rankSystemFonts(fonts, 'nerd')).toEqual(['FiraCode Nerd Font Mono']);
    expect(rankSystemFonts(fonts, '  hel ')).toEqual(['Helvetica']);
    expect(rankSystemFonts(fonts, 'zzz')).toEqual([]);
  });
});
