import { describe, expect, it } from 'vitest';
import { PPTX_DESIGN_THEMES } from './pptxDesignThemes';
import { buildEditablePptxBarChartElements, buildEditablePptxTableElements } from './pptxSmartElements';

describe('pptx smart editable elements', () => {
  it('builds an editable table from export-safe slide elements', () => {
    const elements = buildEditablePptxTableElements(PPTX_DESIGN_THEMES[0]);

    expect(elements.length).toBeGreaterThan(20);
    expect(elements.every((el) => ['text', 'rect', 'line'].includes(el.type))).toBe(true);
    expect(elements.some((el) => el.type === 'text' && el.text === 'Editable Table')).toBe(true);
    expect(elements.some((el) => el.type === 'text' && el.text === 'Revenue')).toBe(true);
  });

  it('builds an editable bar chart with labels and bars', () => {
    const elements = buildEditablePptxBarChartElements(PPTX_DESIGN_THEMES[1]);
    const bars = elements.filter((el) => el.type === 'rect' && (el.h || 0) > 4);

    expect(elements.some((el) => el.type === 'text' && el.text === 'Editable Bar Chart')).toBe(true);
    expect(elements.some((el) => el.type === 'text' && el.text === 'Q4')).toBe(true);
    expect(bars.length).toBeGreaterThanOrEqual(4);
  });
});
