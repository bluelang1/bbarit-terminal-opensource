import type { Slide, SlideElement } from './types';
import { uid } from './types';
import { normalizeSlideTransition } from './pptxTransitions';

function stripFence(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').trim();
}

function escapeHtmlComment(value: string): string {
  return value.replace(/-->/g, '-- >');
}

function normalizeMarkdown(source: string): string {
  return source.replace(/\r\n?/g, '\n').trim();
}

function splitSlidevSections(source: string): string[] {
  const lines = normalizeMarkdown(source).split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  let skippingDeckFrontmatter = lines[0]?.trim() === '---';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isDelimiter = line.trim() === '---';
    if (skippingDeckFrontmatter) {
      if (i > 0 && isDelimiter) skippingDeckFrontmatter = false;
      continue;
    }
    if (isDelimiter) {
      if (current.join('\n').trim()) sections.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }

  if (current.join('\n').trim()) sections.push(current.join('\n'));
  return sections.length ? sections : [source];
}

function removeSlideFrontmatter(section: string): string {
  const lines = section.split('\n');
  if (!lines.length) return section;
  const yamlLike = lines.findIndex((line) => /^#{1,6}\s+/.test(line) || line.trim() === '') === -1;
  if (!yamlLike) return section;
  const firstContent = lines.findIndex((line) => /^#{1,6}\s+/.test(line) || /^[-*+]\s+/.test(line) || line.trim().length > 0 && !/^[a-zA-Z0-9_-]+:\s*/.test(line));
  return firstContent > 0 ? lines.slice(firstContent).join('\n') : section;
}

function extractNotes(section: string): { content: string; notes: string } {
  const notes: string[] = [];
  const content = section.replace(/<!--\s*notes?:([\s\S]*?)-->/gi, (_match, note) => {
    notes.push(String(note).trim());
    return '';
  });
  return { content, notes: notes.join('\n\n') };
}

function extractTransition(section: string): Slide['transition'] {
  const match = section.match(/<!--\s*transition:\s*([a-z]+)(?:\s+(\d+)ms)?(?:\s+auto=(\d+)s)?\s*-->/i);
  if (!match) return { type: 'none', durationMs: 450, advanceAfterSec: 0 };
  const type = match[1] as NonNullable<Slide['transition']>['type'];
  const allowed = ['none', 'fade', 'push', 'wipe', 'zoom'];
  return normalizeSlideTransition({
    type: allowed.includes(type) ? type : 'none',
    durationMs: match[2] ? Number(match[2]) : undefined,
    advanceAfterSec: match[3] ? Number(match[3]) : undefined,
  });
}

function textElement(
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  fontSize: number,
  extra: Partial<SlideElement> = {},
): SlideElement {
  return {
    id: uid(),
    type: 'text',
    x,
    y,
    w,
    h,
    text,
    fontSize,
    fontColor: '#111827',
    ...extra,
  };
}

function sectionToSlide(section: string): Slide {
  const { content, notes } = extractNotes(removeSlideFrontmatter(section));
  const lines = content.split('\n').map((line) => line.trimEnd());
  const headingIdx = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
  const firstContentIdx = lines.findIndex((line) => line.trim());
  const title = headingIdx >= 0
    ? stripFence(lines[headingIdx])
    : firstContentIdx >= 0
      ? stripFence(lines[firstContentIdx])
      : 'Untitled slide';
  const bodyLines = lines.filter((line, idx) => idx !== headingIdx && idx !== firstContentIdx).map((line) => line.trim()).filter(Boolean);
  const body = bodyLines
    .map((line) => line.replace(/^[-*+]\s+/, '- '))
    .join('\n');
  const elements: SlideElement[] = [
    textElement(8, 9, 84, 14, title, 30, { bold: true }),
  ];

  if (body) {
    elements.push(textElement(10, 29, 80, 56, body, 18, { fontColor: '#374151' }));
  }

  return {
    id: uid(),
    title,
    bgColor: '#ffffff',
    bgImage: undefined,
    notes,
    transition: extractTransition(section),
    hidden: /<!--\s*hidden:\s*true\s*-->/i.test(section),
    elements,
  };
}

export function parseSlidevMarkdown(source: string): Slide[] {
  return splitSlidevSections(source)
    .map(sectionToSlide)
    .filter((slide) => slide.title?.trim() || slide.elements.length);
}

function slideTextElements(slide: Slide): SlideElement[] {
  return slide.elements
    .filter((el) => el.type === 'text' && el.text?.trim())
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

export function getSlideDisplayTitle(slide: Slide, index: number): string {
  const explicit = slide.title?.trim();
  if (explicit) return explicit;
  const largest = slide.elements
    .filter((el) => el.text?.trim())
    .sort((a, b) => (b.fontSize || 0) - (a.fontSize || 0))[0];
  return largest?.text?.split('\n')[0]?.trim() || `Slide ${index + 1}`;
}

export function exportSlidesToSlidevMarkdown(slides: Slide[]): string {
  const body = slides.map((slide, index) => {
    const textElements = slideTextElements(slide);
    const title = getSlideDisplayTitle(slide, index);
    const titleElement = textElements.find((el) => el.text?.trim() === title) || textElements[0];
    const bodyText = textElements
      .filter((el) => el.id !== titleElement?.id)
      .map((el) => el.text?.trim())
      .filter(Boolean)
      .join('\n\n');
    const parts = [`# ${title}`];
    if (bodyText) parts.push(bodyText);
    if (slide.hidden) parts.push('<!-- hidden: true -->');
    const transition = normalizeSlideTransition(slide.transition);
    if (transition.type !== 'none' || transition.advanceAfterSec > 0) {
      parts.push(`<!-- transition: ${transition.type} ${transition.durationMs}ms${transition.advanceAfterSec ? ` auto=${transition.advanceAfterSec}s` : ''} -->`);
    }
    if (slide.notes?.trim()) parts.push(`<!-- notes:\n${escapeHtmlComment(slide.notes.trim())}\n-->`);
    return parts.join('\n\n');
  }).join('\n\n---\n\n');

  return `---\ntheme: default\nclass: text-left\n---\n\n${body}\n`;
}
