import { describe, expect, it } from 'vitest';
import type { Slide } from './types';
import { getPptxDesignTheme } from './pptxDesignThemes';
import { auditDeckDesign, auditSlideDesign, polishDeckDesign, polishSlideDesign } from './pptxDesigner';

const messySlide: Slide = {
  id: 'messy',
  title: 'Quarterly Review',
  bgColor: '#ffffff',
  elements: [
    { id: 'title', type: 'text', x: -3, y: 4, w: 90, h: 12, text: 'Quarterly Review', fontSize: 34, fontColor: '#eeeeee' },
    { id: 'body1', type: 'text', x: 10, y: 18, w: 72, h: 26, text: 'Revenue increased while acquisition costs also moved higher.', fontSize: 18, fontColor: '#eeeeee' },
    { id: 'body2', type: 'text', x: 12, y: 22, w: 70, h: 20, text: 'Margin pressure needs a decision this week.', fontSize: 17, fontColor: '#eeeeee' },
    { id: 'image', type: 'image', x: 70, y: 70, w: 42, h: 34, imageSrc: 'data:image/png;base64,abc' },
  ],
};

describe('pptx designer', () => {
  it('audits common design issues', () => {
    const audit = auditSlideDesign(messySlide);

    expect(audit.score).toBeLessThan(100);
    expect(audit.issues.map((issue) => issue.message)).toContain('Element outside slide bounds');
    expect(audit.issues.map((issue) => issue.message)).toContain('Low text contrast');
  });

  it('polishes a slide into a bounded presentation-ready layout', () => {
    const theme = getPptxDesignTheme('executive-ink');
    const polished = polishSlideDesign(messySlide, theme, 1, 4);

    expect(polished.bgColor).toBe(theme.bgColor);
    expect(polished.transition?.type).toBe('fade');
    expect(polished.elements.every((el) => el.x >= 0 && el.y >= 0 && el.x + el.w <= 100.5 && el.y + el.h <= 100.5)).toBe(true);
    expect(polished.elements.some((el) => el.id.startsWith('designer-progress-'))).toBe(true);
    expect(polished.elements.find((el) => el.id === 'title')?.fontColor).toBe(theme.primaryColor);
  });

  it('keeps designer artifacts idempotent when polishing repeatedly', () => {
    const theme = getPptxDesignTheme('data-lab');
    const once = polishSlideDesign(messySlide, theme, 0, 2);
    const twice = polishSlideDesign(once, theme, 0, 2);

    const onceDesignerCount = once.elements.filter((el) => el.id.startsWith('designer-')).length;
    const twiceDesignerCount = twice.elements.filter((el) => el.id.startsWith('designer-')).length;

    expect(twiceDesignerCount).toBe(onceDesignerCount);
  });

  it('polishes and audits a deck', () => {
    const theme = getPptxDesignTheme('startup-signal');
    const deck = polishDeckDesign([messySlide, { ...messySlide, id: 'messy-2' }], theme);
    const audit = auditDeckDesign(deck);

    expect(deck).toHaveLength(2);
    expect(deck[1].elements.some((el) => el.id === 'designer-folio-messy-2' && el.text === '2')).toBe(true);
    expect(audit.score).toBeGreaterThan(50);
  });

  it('flags non-finite element geometry as out of bounds instead of passing silently', () => {
    const broken: Slide = {
      id: 'broken',
      bgColor: '#ffffff',
      elements: [
        { id: 'nan', type: 'text', x: Number.NaN, y: 10, w: 40, h: 10, text: 'Broken import', fontSize: 30, bold: true },
      ],
    };
    const audit = auditSlideDesign(broken);
    expect(audit.issues.map((issue) => issue.message)).toContain('Element outside slide bounds');
  });

  it('sanitizes non-finite geometry from a broken parse when polishing', () => {
    const theme = getPptxDesignTheme('executive-ink');
    const broken: Slide = {
      id: 'broken',
      bgColor: '#ffffff',
      elements: [
        { id: 'nan', type: 'text', x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: 10, text: 'Broken', fontSize: 16 },
        { id: 'inf', type: 'rect', x: 10, y: 10, w: Number.NEGATIVE_INFINITY, h: Number.NaN, fillColor: '#ff0000' },
      ],
    };
    const polished = polishSlideDesign(broken, theme);
    expect(polished.elements.every((el) => [el.x, el.y, el.w, el.h].every((n) => Number.isFinite(n)))).toBe(true);
    expect(polished.elements.every((el) => el.x >= 0 && el.y >= 0 && el.x + el.w <= 100.5 && el.y + el.h <= 100.5)).toBe(true);
  });

  it('polishes an empty slide into a usable scaffold', () => {
    const theme = getPptxDesignTheme('executive-ink');
    const polished = polishSlideDesign({ id: 'blank', bgColor: '#ffffff', elements: [] }, theme, 2, 5);

    expect(polished.elements.some((el) => el.id.startsWith('designer-title-') && el.text === 'Slide 3')).toBe(true);
    expect(polished.elements.some((el) => el.id.startsWith('designer-progress-'))).toBe(true);
    expect(polished.elements.some((el) => el.id.startsWith('designer-folio-') && el.text === '3')).toBe(true);
  });

  it('handles an empty deck', () => {
    const theme = getPptxDesignTheme('executive-ink');
    expect(polishDeckDesign([], theme)).toEqual([]);
    expect(auditDeckDesign([]).score).toBe(100);
    expect(auditDeckDesign([]).issues).toEqual([]);
  });

  it('keeps many body blocks inside slide bounds', () => {
    const theme = getPptxDesignTheme('data-lab');
    const crowded: Slide = {
      id: 'crowded',
      bgColor: '#ffffff',
      elements: Array.from({ length: 12 }, (_, i) => ({
        id: `body-${i}`, type: 'text' as const, x: 10, y: 20 + i, w: 60, h: 8,
        text: `Point ${i + 1}`, fontSize: 16,
      })),
    };
    const polished = polishSlideDesign(crowded, theme);
    expect(polished.elements.every((el) => el.x >= 0 && el.y >= 0 && el.x + el.w <= 100.5 && el.y + el.h <= 100.5)).toBe(true);
  });

  it('gives tables a real content area instead of a decorative grid cell', () => {
    const theme = getPptxDesignTheme('executive-ink');
    const withTable: Slide = {
      id: 'tabled',
      bgColor: '#ffffff',
      elements: [
        { id: 'title', type: 'text', x: 8, y: 6, w: 70, h: 10, text: 'Metrics', fontSize: 32, bold: true },
        {
          id: 'tbl', type: 'table', x: 10, y: 30, w: 80, h: 50,
          table: { rows: 3, cols: 3, cells: [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']] },
        },
      ],
    };
    const polished = polishSlideDesign(withTable, theme);
    const table = polished.elements.find((el) => el.id === 'tbl');
    expect(table).toBeDefined();
    expect(table!.w).toBeGreaterThanOrEqual(30);
    expect(table!.h).toBeGreaterThanOrEqual(24);
  });

  it('never returns a negative score even for a slide full of issues', () => {
    const disaster: Slide = {
      id: 'disaster',
      bgColor: '#ffffff',
      elements: [
        { id: 'a', type: 'text', x: -20, y: -20, w: 200, h: 200, text: 'x'.repeat(400), fontSize: 8, fontColor: '#fefefe' },
        { id: 'b', type: 'image', x: -20, y: -20, w: 200, h: 200, imageSrc: 'data:image/png;base64,abc' },
        { id: 'c', type: 'image', x: -20, y: -20, w: 200, h: 200, imageSrc: 'data:image/png;base64,abc' },
      ],
    };
    const audit = auditSlideDesign(disaster);
    expect(audit.score).toBeGreaterThanOrEqual(0);
  });
});
