import type { Slide, SlideElement } from './types';
import type { PptxDesignTheme } from './pptxDesignThemes';
import { applyDesignThemeToSlide } from './pptxDesignThemes';
import { isAgentLayoutSlide } from './pptxAgentLayouts';

export interface PptxDesignIssue {
  slideId: string;
  severity: 'info' | 'warning';
  message: string;
}

export interface PptxDesignAudit {
  score: number;
  issues: PptxDesignIssue[];
}

const DESIGNER_PREFIX = 'designer-';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// 파서가 깨진 pptx에서 NaN/Infinity 좌표를 내보낼 수 있다 — clamp 전에 무해화.
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function isDesignerElement(el: SlideElement): boolean {
  return el.id.startsWith(DESIGNER_PREFIX);
}

function isAuditIgnoredElement(el: SlideElement): boolean {
  return isDesignerElement(el) && !el.id.startsWith(`${DESIGNER_PREFIX}title-`);
}

function isText(el: SlideElement): boolean {
  return el.type === 'text' || el.type === 'rect' || el.type === 'circle';
}

function textValue(el: SlideElement): string {
  return (el.text || '').trim();
}

function isTitleCandidate(el: SlideElement): boolean {
  return el.type === 'text' && Boolean(textValue(el)) && ((el.fontSize || 0) >= 24 || el.y <= 18 || Boolean(el.bold));
}

function isBodyCandidate(el: SlideElement): boolean {
  return isText(el) && Boolean(textValue(el)) && !isTitleCandidate(el);
}

function isShapeSurface(el: SlideElement): boolean {
  return el.type === 'rect' || el.type === 'circle' || el.type === 'triangle' || el.type === 'star' || el.type === 'arrow';
}

function rect(id: string, x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement {
  return { id, type: 'rect', x, y, w, h, fillColor, borderWidth: 0, ...extra };
}

function text(id: string, x: number, y: number, w: number, h: number, value: string, fontSize: number, extra: Partial<SlideElement> = {}): SlideElement {
  return {
    id,
    type: 'text',
    x,
    y,
    w,
    h,
    text: value,
    fontSize,
    fontColor: '#111827',
    ...extra,
  };
}

function parseHexColor(color?: string): [number, number, number] | null {
  const value = String(color || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(color?: string): number | null {
  const rgb = parseHexColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((component) => {
    const normalized = component / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a?: string, b?: string): number | null {
  const aLum = luminance(a);
  const bLum = luminance(b);
  if (aLum === null || bLum === null) return null;
  const bright = Math.max(aLum, bLum);
  const dark = Math.min(aLum, bLum);
  return (bright + 0.05) / (dark + 0.05);
}

function overlaps(a: SlideElement, b: SlideElement): boolean {
  if (isAuditIgnoredElement(a) || isAuditIgnoredElement(b)) return false;
  if (a.type === 'line' || b.type === 'line') return false;
  if ((isText(a) && isShapeSurface(b)) || (isText(b) && isShapeSurface(a))) return false;
  const xOverlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const area = xOverlap * yOverlap;
  const minArea = Math.max(1, Math.min(a.w * a.h, b.w * b.h));
  return area / minArea > 0.18;
}

function normalizeBodyText(el: SlideElement, theme: PptxDesignTheme, idx: number, total: number): SlideElement {
  const columnLayout = total >= 3;
  if (columnLayout) {
    const colW = 25;
    return {
      ...el,
      x: 8 + (idx % 3) * 29,
      y: 31 + Math.floor(idx / 3) * 24,
      w: colW,
      h: 17,
      fontSize: clamp(el.fontSize || 16, 13, 18),
      fontColor: theme.textColor,
      fontFamily: theme.fontFamily,
      textAlign: el.textAlign || 'left',
    };
  }
  return {
    ...el,
    x: 8,
    y: 28 + idx * 18,
    w: 42,
    h: 13,
    fontSize: clamp(el.fontSize || 17, 14, 20),
    fontColor: theme.textColor,
    fontFamily: theme.fontFamily,
  };
}

function normalizeVisualElement(el: SlideElement, theme: PptxDesignTheme, idx: number, hasImages: boolean): SlideElement {
  if (el.type === 'image') {
    return {
      ...el,
      x: idx === 0 ? 56 : 56 + (idx % 2) * 19,
      y: idx === 0 ? 25 : 30 + Math.floor(idx / 2) * 22,
      w: idx === 0 && !hasImages ? 34 : 34,
      h: idx === 0 && !hasImages ? 42 : 20,
      shadow: true,
    };
  }
  if (el.type === 'line') {
    return {
      ...el,
      x: 8,
      y: 21 + idx * 3,
      w: clamp(el.w || 26, 18, 48),
      h: 1,
      borderColor: theme.accentColor,
      borderWidth: clamp(el.borderWidth || 2, 1, 5),
    };
  }
  // 표는 장식이 아니라 본문 — 우측 그리드 칸에 찌그러뜨리지 않고 콘텐츠 영역을 준다.
  if (el.type === 'table') {
    return {
      ...el,
      x: 52,
      y: 26,
      w: clamp(finiteOr(el.w, 42), 30, 44),
      h: clamp(finiteOr(el.h, 55), 24, 62),
    };
  }
  return {
    ...el,
    x: 56 + (idx % 2) * 19,
    y: 30 + Math.floor(idx / 2) * 20,
    w: clamp(el.w || 20, 15, 34),
    h: clamp(el.h || 14, 10, 24),
    fillColor: el.fillColor || theme.surfaceColor,
    borderColor: el.borderWidth ? theme.accentColor : el.borderColor,
    fontColor: el.fontColor || theme.textColor,
    fontFamily: theme.fontFamily,
  };
}

function boundElement(el: SlideElement): SlideElement {
  const x = clamp(finiteOr(el.x, 8), 0, 99.5);
  const y = clamp(finiteOr(el.y, 8), 0, 99.5);
  return {
    ...el,
    x,
    y,
    w: clamp(finiteOr(el.w, 20), 0.5, 100 - x),
    h: clamp(finiteOr(el.h, 10), 0.5, 100 - y),
  };
}

export function auditSlideDesign(slide: Slide): PptxDesignAudit {
  const issues: PptxDesignIssue[] = [];
  const elements = slide.elements.filter((el) => !isAuditIgnoredElement(el));
  const hasTitle = elements.some(isTitleCandidate);
  const textElements = elements.filter(isText);

  if (!hasTitle) {
    issues.push({ slideId: slide.id, severity: 'warning', message: 'Missing clear title' });
  }

  for (const el of elements) {
    const finiteBox = [el.x, el.y, el.w, el.h].every((n) => Number.isFinite(n));
    if (!finiteBox || el.x < 0 || el.y < 0 || el.x + el.w > 100 || el.y + el.h > 100) {
      issues.push({ slideId: slide.id, severity: 'warning', message: 'Element outside slide bounds' });
      break;
    }
  }

  for (let i = 0; i < elements.length; i += 1) {
    for (let j = i + 1; j < elements.length; j += 1) {
      if (overlaps(elements[i], elements[j])) {
        issues.push({ slideId: slide.id, severity: 'warning', message: 'Overlapping content' });
        i = elements.length;
        break;
      }
    }
  }

  for (const el of textElements) {
    const ratio = contrastRatio(el.fontColor, slide.bgColor);
    if (ratio !== null && ratio < 3.2) {
      issues.push({ slideId: slide.id, severity: 'warning', message: 'Low text contrast' });
      break;
    }
  }

  const denseText = textElements.some((el) => textValue(el).length > Math.max(80, el.w * el.h * 0.45));
  if (denseText) {
    issues.push({ slideId: slide.id, severity: 'info', message: 'Dense text block' });
  }

  const score = clamp(100 - issues.filter((issue) => issue.severity === 'warning').length * 18 - issues.filter((issue) => issue.severity === 'info').length * 8, 0, 100);
  return { score, issues };
}

export function auditDeckDesign(slides: Slide[]): PptxDesignAudit {
  const audits = slides.map(auditSlideDesign);
  const issues = audits.flatMap((audit) => audit.issues);
  const score = slides.length
    ? Math.round(audits.reduce((sum, audit) => sum + audit.score, 0) / slides.length)
    : 100;
  return { score, issues };
}

export function polishSlideDesign(slide: Slide, theme: PptxDesignTheme, slideIndex = 0, slideCount = 1): Slide {
  // Agent-layout slides are already composed designs (cover, metrics, timeline…);
  // re-normalizing or re-theming them would destroy inverted covers and card grids.
  if (isAgentLayoutSlide(slide)) {
    return slide;
  }
  const themed = applyDesignThemeToSlide({
    ...slide,
    elements: slide.elements.filter((el) => !isDesignerElement(el)),
  }, theme);
  const titleCandidate = themed.elements.find(isTitleCandidate);
  const bodyElements = themed.elements.filter((el) => isText(el) && Boolean(textValue(el)) && el.id !== titleCandidate?.id);
  const imageElements = themed.elements.filter((el) => el.type === 'image');
  const visualElements = themed.elements.filter((el) => (!isText(el) || !textValue(el)) && el.id !== titleCandidate?.id);
  const hasWideVisual = imageElements.length > 0 || visualElements.some((el) => el.type !== 'line' && el.type !== 'text');
  const progressPct = slideCount <= 1 ? 100 : ((slideIndex + 1) / slideCount) * 100;

  const nextElements: SlideElement[] = [];

  if (titleCandidate) {
    nextElements.push({
      ...titleCandidate,
      x: 7,
      y: 7,
      w: 76,
      h: 10,
      fontSize: clamp(titleCandidate.fontSize || 30, 28, 36),
      bold: true,
      fontColor: theme.primaryColor,
      fontFamily: theme.fontFamily,
    });
  } else {
    const fallbackTitle = slide.title?.trim()
      || bodyElements.map(textValue).find(Boolean)?.split(/\s+/).slice(0, 7).join(' ')
      || `Slide ${slideIndex + 1}`;
    nextElements.push(text(`${DESIGNER_PREFIX}title-${slide.id}`, 7, 7, 76, 10, fallbackTitle, 32, {
      bold: true,
      fontColor: theme.primaryColor,
      fontFamily: theme.fontFamily,
    }));
  }

  nextElements.push(rect(`${DESIGNER_PREFIX}rule-${slide.id}`, 7, 20, 24, 0.75, theme.accentColor, { opacity: 0.9 }));

  bodyElements.forEach((el, idx) => {
    const body = normalizeBodyText(el, theme, idx, bodyElements.length);
    nextElements.push(hasWideVisual ? body : {
      ...body,
      x: bodyElements.length >= 3 ? body.x : 9,
      y: bodyElements.length >= 3 ? body.y : 30 + idx * 16,
      w: bodyElements.length >= 3 ? body.w : 78,
      h: bodyElements.length >= 3 ? body.h : 12,
    });
  });

  visualElements.forEach((el, idx) => {
    nextElements.push(normalizeVisualElement(el, theme, idx, imageElements.length > 1));
  });

  nextElements.push(rect(`${DESIGNER_PREFIX}progress-bg-${slide.id}`, 0, 98.6, 100, 1.4, theme.surfaceAltColor, { opacity: 0.9 }));
  nextElements.push(rect(`${DESIGNER_PREFIX}progress-${slide.id}`, 0, 98.6, progressPct, 1.4, theme.accentColor, { opacity: 0.95 }));
  nextElements.push(text(`${DESIGNER_PREFIX}folio-${slide.id}`, 89, 92.5, 6, 4, String(slideIndex + 1), 10, {
    fontColor: theme.mutedTextColor,
    fontFamily: theme.fontFamily,
    textAlign: 'right',
  }));

  return {
    ...themed,
    transition: themed.transition?.type && themed.transition.type !== 'none'
      ? themed.transition
      : { type: 'fade', durationMs: 450, advanceAfterSec: themed.transition?.advanceAfterSec || 0 },
    elements: nextElements.map(boundElement),
  };
}

export function polishDeckDesign(slides: Slide[], theme: PptxDesignTheme): Slide[] {
  return slides.map((slide, idx) => polishSlideDesign(slide, theme, idx, slides.length));
}
