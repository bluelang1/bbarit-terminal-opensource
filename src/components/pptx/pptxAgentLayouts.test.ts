import { describe, it, expect } from 'vitest';
import {
  AGENT_LAYOUT_IDS,
  AGENT_LAYOUT_PREFIX,
  buildAgentLayoutSlide,
  isAgentLayoutSlide,
} from './pptxAgentLayouts';
import { PPTX_DESIGN_THEMES } from './pptxDesignThemes';
import { polishSlideDesign } from './pptxDesigner';
import { createBlankSlide } from './types';

const theme = PPTX_DESIGN_THEMES[0];

describe('buildAgentLayoutSlide', () => {
  it('builds every layout with agent-prefixed elements inside bounds', () => {
    for (const layout of AGENT_LAYOUT_IDS) {
      const slide = buildAgentLayoutSlide(layout, {
        title: 'Quarterly Review',
        subtitle: 'FY26 Q2',
        body: 'First point\nSecond point\nThird point',
        bullets: ['Alpha', 'Beta', 'Gamma'],
        metrics: [
          { label: 'Revenue', value: '$1.2M', note: '+18% QoQ' },
          { label: 'NPS', value: '62' },
        ],
        items: [
          { title: 'Before', body: 'slow; manual; error-prone' },
          { title: 'After', body: 'fast; automated; reliable' },
        ],
        kicker: '01',
        footer: 'BBARIT',
        data: [['Q1', 35], ['Q2', 52], ['Q3', 68]],
      }, theme);

      expect(slide.elements.length, layout).toBeGreaterThan(2);
      expect(isAgentLayoutSlide(slide), layout).toBe(true);
      for (const el of slide.elements) {
        expect(el.id.startsWith(AGENT_LAYOUT_PREFIX), `${layout}: ${el.id}`).toBe(true);
        expect(el.x, layout).toBeGreaterThanOrEqual(0);
        expect(el.y, layout).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w, layout).toBeLessThanOrEqual(101);
        expect(el.y + el.h, layout).toBeLessThanOrEqual(101);
      }
    }
  });

  it('cover layouts use inverted (primary) background', () => {
    const cover = buildAgentLayoutSlide('title', { title: 'T' }, theme);
    const closing = buildAgentLayoutSlide('closing', { title: 'Thanks' }, theme);
    expect(cover.bgColor).toBe(theme.primaryColor);
    expect(closing.bgColor).toBe(theme.primaryColor);
  });

  it('bullets layout falls back to multi-line body when bullets missing', () => {
    const slide = buildAgentLayoutSlide('bullets', { title: 'T', body: 'a\nb\nc' }, theme);
    const bulletTexts = slide.elements.filter((el) => el.id.includes('bullet-'));
    expect(bulletTexts.length).toBe(3);
  });

  it('metrics layout renders one card per metric (max 4)', () => {
    const slide = buildAgentLayoutSlide('metrics', {
      title: 'KPIs',
      metrics: [1, 2, 3, 4, 5].map((n) => ({ label: `M${n}`, value: `${n}` })),
    }, theme);
    const cards = slide.elements.filter((el) => el.id.includes('card-'));
    expect(cards.length).toBe(4);
  });

  it('chart layout scales bars to max value', () => {
    const slide = buildAgentLayoutSlide('chart', {
      title: 'Chart',
      data: [['A', 10], ['B', 100]],
    }, theme);
    const bars = slide.elements.filter((el) => el.id.includes('bar-') && el.type === 'rect');
    expect(bars.length).toBe(2);
    expect(bars[1].h).toBeGreaterThan(bars[0].h);
  });
});

describe('polishSlideDesign vs agent layouts', () => {
  it('leaves agent-layout slides untouched', () => {
    const slide = buildAgentLayoutSlide('metrics', {
      title: 'KPIs',
      metrics: [{ label: 'Revenue', value: '$1M' }],
    }, theme);
    const polished = polishSlideDesign(slide, theme, 0, 5);
    expect(polished).toBe(slide);
  });

  it('still polishes plain slides', () => {
    const slide = createBlankSlide();
    slide.elements.push({
      id: 'plain-1', type: 'text', x: 6, y: 8, w: 88, h: 14,
      text: 'Plain title', fontSize: 30, bold: true,
    });
    const polished = polishSlideDesign(slide, theme, 0, 5);
    expect(polished).not.toBe(slide);
    expect(polished.elements.some((el) => el.id.startsWith('designer-'))).toBe(true);
  });
});
