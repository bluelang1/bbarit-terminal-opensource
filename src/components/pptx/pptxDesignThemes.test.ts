import { describe, expect, it } from 'vitest';
import type { Slide } from './types';
import {
  PPTX_DESIGN_THEMES,
  applyDesignThemeToSlide,
  applyDesignThemeToSlides,
  getPptxDesignTheme,
} from './pptxDesignThemes';

const sampleSlide: Slide = {
  id: 'slide-1',
  title: 'Quarterly update',
  bgColor: '#ffffff',
  notes: 'speaker note',
  hidden: false,
  elements: [
    { id: 'title', type: 'text', x: 8, y: 8, w: 80, h: 12, text: 'Title', fontSize: 30, bold: true, fontColor: '#000000' },
    { id: 'body', type: 'text', x: 8, y: 28, w: 80, h: 20, text: 'Body', fontSize: 16, fontColor: '#333333' },
    { id: 'shape', type: 'rect', x: 8, y: 55, w: 30, h: 20, fillColor: '#eeeeee' },
    { id: 'line', type: 'line', x: 8, y: 80, w: 40, h: 1, borderColor: '#111111', borderWidth: 2 },
    { id: 'image', type: 'image', x: 48, y: 55, w: 30, h: 20, imageSrc: 'data:image/png;base64,abc' },
  ],
};

describe('pptx design themes', () => {
  it('finds themes with a safe fallback', () => {
    expect(getPptxDesignTheme('data-lab').id).toBe('data-lab');
    expect(getPptxDesignTheme('architecture-blueprint').label).toBe('Architecture Blueprint');
    expect(getPptxDesignTheme('investor-copper').accentColor).toBe('#b45309');
    expect(getPptxDesignTheme('keynote-spectrum').bgColor).toBe('#0a0f1f');
    expect(getPptxDesignTheme('finance-terminal').accentColor).toBe('#16a34a');
    expect(getPptxDesignTheme('customer-aurora').primaryColor).toBe('#0f766e');
    expect(getPptxDesignTheme('product-prism').surfaceColor).toBe('#e0e7ff');
    expect(getPptxDesignTheme('missing').id).toBe(PPTX_DESIGN_THEMES[0].id);
  });

  it('applies background, typography, and shape colors without mutating the original slide', () => {
    const theme = getPptxDesignTheme('startup-signal');
    const themed = applyDesignThemeToSlide(sampleSlide, theme);

    expect(themed.bgColor).toBe(theme.bgColor);
    expect(themed.elements[0].fontColor).toBe(theme.primaryColor);
    expect(themed.elements[0].fontFamily).toBe(theme.fontFamily);
    expect(themed.elements[1].fontColor).toBe(theme.textColor);
    expect(themed.elements[2].fillColor).toBe(theme.surfaceColor);
    expect(themed.elements[3].borderColor).toBe(theme.accentColor);
    expect(themed.elements[4].imageSrc).toBe(sampleSlide.elements[4].imageSrc);
    expect(sampleSlide.bgColor).toBe('#ffffff');
    expect(sampleSlide.elements[2].fillColor).toBe('#eeeeee');
  });

  it('applies the selected theme across an entire deck', () => {
    const theme = getPptxDesignTheme('editorial-red');
    const deck = applyDesignThemeToSlides([sampleSlide, { ...sampleSlide, id: 'slide-2' }], theme);

    expect(deck).toHaveLength(2);
    expect(deck.every((slide) => slide.bgColor === theme.bgColor)).toBe(true);
    expect(deck.every((slide) => slide.elements[0].fontFamily === theme.fontFamily)).toBe(true);
  });
});
