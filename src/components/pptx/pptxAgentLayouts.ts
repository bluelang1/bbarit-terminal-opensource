/**
 * pptxAgentLayouts.ts — Designed slide layouts for the agent `pptx` tool.
 *
 * The agent bridge's plain addSlide (title + bullet body) produces flat,
 * document-looking decks. These builders give the agent the same visual
 * quality as the UI deck templates: cover pages, section breaks, metric
 * cards, timelines, comparisons, quotes, and bar charts — all themed.
 *
 * Element ids carry AGENT_LAYOUT_PREFIX so polishDesign can recognize
 * already-designed slides and leave them untouched.
 */

import type { Slide, SlideElement } from './types';
import { uid, createBlankSlide } from './types';
import type { PptxDesignTheme } from './pptxDesignThemes';

export const AGENT_LAYOUT_PREFIX = 'agent-layout-';

export const AGENT_LAYOUT_IDS = [
  'title', 'section', 'bullets', 'two-column', 'quote',
  'metrics', 'timeline', 'comparison', 'chart', 'closing',
] as const;

export type AgentLayoutId = typeof AGENT_LAYOUT_IDS[number];

export interface AgentLayoutMetric { label: string; value: string; note?: string }
export interface AgentLayoutItem { title: string; body?: string }

export interface AgentLayoutOptions {
  title?: string;
  subtitle?: string;
  body?: string;
  bullets?: string[];
  metrics?: AgentLayoutMetric[];
  items?: AgentLayoutItem[];
  kicker?: string;
  footer?: string;
  /** chart layout: [label, value] pairs */
  data?: [string, number][];
}

export function isAgentLayoutSlide(slide: Slide): boolean {
  return slide.elements.some((el) => el.id.startsWith(AGENT_LAYOUT_PREFIX));
}

const aid = (tag: string) => `${AGENT_LAYOUT_PREFIX}${tag}-${uid()}`;

function text(
  tag: string, x: number, y: number, w: number, h: number,
  value: string, fontSize: number, theme: PptxDesignTheme,
  extra: Partial<SlideElement> = {},
): SlideElement {
  return {
    id: aid(tag), type: 'text', x, y, w, h,
    text: value, fontSize, fontColor: theme.textColor,
    fontFamily: theme.fontFamily, ...extra,
  };
}

function rect(
  tag: string, x: number, y: number, w: number, h: number,
  fillColor: string, extra: Partial<SlideElement> = {},
): SlideElement {
  return { id: aid(tag), type: 'rect', x, y, w, h, fillColor, borderWidth: 0, ...extra };
}

function line(tag: string, x: number, y: number, w: number, color: string, borderWidth = 2): SlideElement {
  return { id: aid(tag), type: 'line', x, y, w, h: 1, borderColor: color, borderWidth };
}

function headerElements(title: string, theme: PptxDesignTheme): SlideElement[] {
  return [
    text('title', 7, 7, 80, 11, title, 28, theme, { bold: true, fontColor: theme.primaryColor }),
    rect('rule', 7, 19.5, 16, 0.9, theme.accentColor),
  ];
}

function splitBullets(opts: AgentLayoutOptions, max: number): string[] {
  const list = (opts.bullets && opts.bullets.length)
    ? opts.bullets
    : (opts.body || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return list.slice(0, max);
}

function splitItems(opts: AgentLayoutOptions, max: number): AgentLayoutItem[] {
  if (opts.items && opts.items.length) return opts.items.slice(0, max);
  return splitBullets(opts, max).map((b) => {
    const sep = b.indexOf(':');
    return sep > 0 && sep < 40
      ? { title: b.slice(0, sep).trim(), body: b.slice(sep + 1).trim() }
      : { title: b };
  });
}

// ─── Layouts ─────────────────────────────────────────────────

function coverSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme, closing: boolean): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.primaryColor;
  slide.title = opts.title || '';
  const align = closing ? 'center' as const : 'left' as const;
  const x = closing ? 10 : 8;
  const w = closing ? 80 : 78;
  slide.elements = [
    rect('edge', 0, 0, 1.6, 100, theme.accentColor),
  ];
  if (opts.kicker) {
    slide.elements.push(text('kicker', x, closing ? 24 : 26, w, 5, opts.kicker.toUpperCase(), 13, theme, {
      bold: true, fontColor: theme.accentColor, textAlign: align,
    }));
  }
  slide.elements.push(text('title', x, closing ? 34 : 36, w, 22, opts.title || '', closing ? 36 : 40, theme, {
    bold: true, fontColor: theme.bgColor, textAlign: align,
  }));
  if (opts.subtitle || opts.body) {
    slide.elements.push(text('subtitle', x, closing ? 58 : 62, w, 10, opts.subtitle || opts.body || '', 16, theme, {
      fontColor: theme.surfaceAltColor, textAlign: align,
    }));
  }
  if (opts.footer) {
    slide.elements.push(text('footer', x, 86, w, 5, opts.footer, 12, theme, {
      fontColor: theme.accentColor, bold: closing, textAlign: align,
    }));
  }
  return slide;
}

function sectionSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  slide.elements = [
    rect('panel', 0, 0, 34, 100, theme.surfaceColor, { opacity: 0.55 }),
  ];
  if (opts.kicker) {
    slide.elements.push(text('kicker', 8, 16, 40, 16, opts.kicker, 54, theme, {
      bold: true, fontColor: theme.accentColor,
    }));
  }
  slide.elements.push(text('title', 8, 42, 80, 14, opts.title || '', 34, theme, {
    bold: true, fontColor: theme.primaryColor,
  }));
  slide.elements.push(rect('rule', 8, 57, 18, 0.9, theme.accentColor));
  if (opts.subtitle || opts.body) {
    slide.elements.push(text('subtitle', 8, 62, 66, 14, opts.subtitle || opts.body || '', 15, theme, {
      fontColor: theme.mutedTextColor,
    }));
  }
  return slide;
}

function bulletsSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const bullets = splitBullets(opts, 7);
  slide.elements = [...headerElements(opts.title || '', theme)];
  if (opts.subtitle) {
    slide.elements.push(text('subtitle', 7, 21.5, 80, 5, opts.subtitle, 13, theme, {
      fontColor: theme.mutedTextColor,
    }));
  }
  const startY = opts.subtitle ? 30 : 27;
  const rowH = bullets.length > 5 ? 9 : 11;
  bullets.forEach((b, i) => {
    const y = startY + i * rowH;
    slide.elements.push(rect(`dot-${i}`, 7.4, y + 1.4, 1.1, 2, theme.accentColor));
    slide.elements.push(text(`bullet-${i}`, 10.5, y, 82, rowH - 2, b, bullets.length > 5 ? 14 : 16, theme));
  });
  if (opts.footer) {
    slide.elements.push(text('footer', 7, 92, 80, 4, opts.footer, 10, theme, { fontColor: theme.mutedTextColor }));
  }
  return slide;
}

function twoColumnSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const items = splitItems(opts, 6);
  const left = items.filter((_, i) => i % 2 === 0);
  const right = items.filter((_, i) => i % 2 === 1);
  slide.elements = [...headerElements(opts.title || '', theme)];
  const renderColumn = (colItems: AgentLayoutItem[], colX: number, col: number) => {
    colItems.forEach((item, i) => {
      const y = 27 + i * 22;
      slide.elements.push(rect(`card-${col}-${i}`, colX, y, 42, 19, theme.surfaceColor, { opacity: 0.75 }));
      slide.elements.push(rect(`bar-${col}-${i}`, colX, y, 0.9, 19, theme.accentColor));
      slide.elements.push(text(`head-${col}-${i}`, colX + 2.5, y + 2, 37, 5, item.title, 15, theme, {
        bold: true, fontColor: theme.primaryColor,
      }));
      if (item.body) {
        slide.elements.push(text(`body-${col}-${i}`, colX + 2.5, y + 8.5, 37, 9, item.body, 12, theme, {
          fontColor: theme.mutedTextColor,
        }));
      }
    });
  };
  renderColumn(left, 7, 0);
  renderColumn(right, 51.5, 1);
  return slide;
}

function quoteSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const quote = opts.body || opts.title || '';
  slide.elements = [
    rect('panel', 8, 18, 84, 58, theme.surfaceColor, { opacity: 0.6 }),
    rect('bar', 8, 18, 1.2, 58, theme.accentColor),
    text('mark', 12, 20, 14, 14, '\u201C', 72, theme, { bold: true, fontColor: theme.accentColor }),
    text('quote', 14, 34, 72, 28, quote, 24, theme, { bold: true, fontColor: theme.primaryColor }),
  ];
  if (opts.subtitle) {
    slide.elements.push(text('attribution', 14, 66, 72, 6, `— ${opts.subtitle}`, 14, theme, {
      fontColor: theme.mutedTextColor,
    }));
  }
  if (opts.footer) {
    slide.elements.push(text('footer', 8, 86, 84, 4, opts.footer, 10, theme, { fontColor: theme.mutedTextColor }));
  }
  return slide;
}

function metricsSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const metrics: AgentLayoutMetric[] = (opts.metrics && opts.metrics.length
    ? opts.metrics
    : splitItems(opts, 4).map((it) => ({ label: it.title, value: it.body || '' }))
  ).slice(0, 4);
  slide.elements = [...headerElements(opts.title || '', theme)];
  if (opts.subtitle) {
    slide.elements.push(text('subtitle', 7, 21.5, 80, 5, opts.subtitle, 13, theme, { fontColor: theme.mutedTextColor }));
  }
  const count = metrics.length || 1;
  const gap = 3;
  const cardW = (86 - gap * (count - 1)) / count;
  metrics.forEach((m, i) => {
    const x = 7 + i * (cardW + gap);
    slide.elements.push(rect(`card-${i}`, x, 32, cardW, 34, theme.surfaceColor, { opacity: 0.8 }));
    slide.elements.push(rect(`cap-${i}`, x, 32, cardW, 1.4, theme.accentColor));
    slide.elements.push(text(`label-${i}`, x + 2, 37, cardW - 4, 5, m.label, 12, theme, {
      bold: true, fontColor: theme.mutedTextColor,
    }));
    slide.elements.push(text(`value-${i}`, x + 2, 44, cardW - 4, 11, m.value, 30, theme, {
      bold: true, fontColor: theme.primaryColor,
    }));
    if (m.note) {
      slide.elements.push(text(`note-${i}`, x + 2, 57, cardW - 4, 6, m.note, 10.5, theme, {
        fontColor: theme.mutedTextColor,
      }));
    }
  });
  if (opts.footer) {
    slide.elements.push(text('footer', 7, 90, 86, 4, opts.footer, 10, theme, { fontColor: theme.mutedTextColor }));
  }
  return slide;
}

function timelineSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const items = splitItems(opts, 5);
  slide.elements = [...headerElements(opts.title || '', theme)];
  const count = items.length || 1;
  const gap = 2.5;
  const cardW = (86 - gap * (count - 1)) / count;
  const railY = 38;
  slide.elements.push(line('rail', 7, railY, 86, theme.surfaceAltColor, 2));
  items.forEach((item, i) => {
    const x = 7 + i * (cardW + gap);
    const cx = x + cardW / 2;
    slide.elements.push({
      id: aid(`node-${i}`), type: 'circle', x: cx - 1.4, y: railY - 2.4, w: 2.8, h: 4.8,
      fillColor: i === count - 1 ? theme.accentColor : theme.primaryColor, borderWidth: 0,
    });
    slide.elements.push(text(`step-${i}`, x, railY - 10, cardW, 5, String(i + 1).padStart(2, '0'), 14, theme, {
      bold: true, fontColor: theme.accentColor, textAlign: 'center',
    }));
    slide.elements.push(rect(`card-${i}`, x, railY + 7, cardW, 26, theme.surfaceColor, { opacity: 0.75 }));
    slide.elements.push(text(`head-${i}`, x + 1.5, railY + 9.5, cardW - 3, 6, item.title, 13, theme, {
      bold: true, fontColor: theme.primaryColor, textAlign: 'center',
    }));
    if (item.body) {
      slide.elements.push(text(`body-${i}`, x + 1.5, railY + 17, cardW - 3, 14, item.body, 10.5, theme, {
        fontColor: theme.mutedTextColor, textAlign: 'center',
      }));
    }
  });
  return slide;
}

function comparisonSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const items = splitItems(opts, 2);
  const a = items[0] || { title: 'A' };
  const b = items[1] || { title: 'B' };
  slide.elements = [...headerElements(opts.title || '', theme)];
  const panel = (item: AgentLayoutItem, x: number, accent: boolean, key: string) => {
    slide.elements.push(rect(`panel-${key}`, x, 26, 43, 62, accent ? theme.primaryColor : theme.surfaceColor, {
      opacity: accent ? 1 : 0.7,
    }));
    slide.elements.push(rect(`cap-${key}`, x, 26, 43, 1.6, theme.accentColor));
    slide.elements.push(text(`head-${key}`, x + 3, 31, 37, 7, item.title, 19, theme, {
      bold: true, fontColor: accent ? theme.bgColor : theme.primaryColor,
    }));
    if (item.body) {
      const bodyLines = item.body.split(/;|\n/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
      bodyLines.forEach((lineText, i) => {
        slide.elements.push(rect(`dot-${key}-${i}`, x + 3, 43 + i * 9 + 1.2, 1, 1.8, theme.accentColor));
        slide.elements.push(text(`item-${key}-${i}`, x + 5.5, 43 + i * 9, 34, 8, lineText, 12.5, theme, {
          fontColor: accent ? theme.surfaceAltColor : theme.textColor,
        }));
      });
    }
  };
  panel(a, 7, false, 'a');
  panel(b, 52, true, 'b');
  return slide;
}

function chartSlide(opts: AgentLayoutOptions, theme: PptxDesignTheme): Slide {
  const slide = createBlankSlide();
  slide.bgColor = theme.bgColor;
  slide.title = opts.title || '';
  const raw = (opts.data && opts.data.length)
    ? opts.data
    : splitItems(opts, 8).map((it) => [it.title, Number(it.body) || 0] as [string, number]);
  const data = raw.slice(0, 8).map(([label, v]) => [String(label), Number(v) || 0] as [string, number]);
  slide.elements = [...headerElements(opts.title || '', theme)];
  if (opts.subtitle) {
    slide.elements.push(text('subtitle', 7, 21.5, 80, 5, opts.subtitle, 13, theme, { fontColor: theme.mutedTextColor }));
  }
  const chartX = 9;
  const chartY = 32;
  const chartW = 82;
  const chartH = 48;
  const baseY = chartY + chartH;
  const maxV = Math.max(1, ...data.map(([, v]) => v));
  const gap = 3;
  const barW = (chartW - gap * (data.length - 1)) / Math.max(1, data.length);
  slide.elements.push(rect('plot', chartX - 2, chartY - 4, chartW + 4, chartH + 12, theme.surfaceColor, { opacity: 0.45 }));
  slide.elements.push(line('axis', chartX, baseY, chartW, theme.mutedTextColor, 1));
  data.forEach(([label, v], i) => {
    const h = Math.max(1.5, (v / maxV) * (chartH - 8));
    const x = chartX + i * (barW + gap);
    const fill = i === data.length - 1 ? theme.accentColor : theme.primaryColor;
    slide.elements.push(rect(`bar-${i}`, x, baseY - h, barW, h, fill));
    slide.elements.push(text(`val-${i}`, x - 1, baseY - h - 5, barW + 2, 4, String(v), 11, theme, {
      bold: true, fontColor: theme.primaryColor, textAlign: 'center',
    }));
    slide.elements.push(text(`lab-${i}`, x - 1, baseY + 1.5, barW + 2, 4, label, 10.5, theme, {
      fontColor: theme.mutedTextColor, textAlign: 'center',
    }));
  });
  if (opts.footer) {
    slide.elements.push(text('footer', 7, 92, 86, 4, opts.footer, 10, theme, { fontColor: theme.mutedTextColor }));
  }
  return slide;
}

export function buildAgentLayoutSlide(
  layout: AgentLayoutId,
  opts: AgentLayoutOptions,
  theme: PptxDesignTheme,
): Slide {
  switch (layout) {
    case 'title': return coverSlide(opts, theme, false);
    case 'closing': return coverSlide(opts, theme, true);
    case 'section': return sectionSlide(opts, theme);
    case 'two-column': return twoColumnSlide(opts, theme);
    case 'quote': return quoteSlide(opts, theme);
    case 'metrics': return metricsSlide(opts, theme);
    case 'timeline': return timelineSlide(opts, theme);
    case 'comparison': return comparisonSlide(opts, theme);
    case 'chart': return chartSlide(opts, theme);
    case 'bullets':
    default:
      return bulletsSlide(opts, theme);
  }
}
