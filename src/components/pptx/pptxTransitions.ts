import type { Slide, SlideTransition } from './types';

export const PPTX_TRANSITION_TYPES: Array<{ id: SlideTransition['type']; label: string; description: string }> = [
  { id: 'none', label: 'None', description: 'Immediate slide change.' },
  { id: 'fade', label: 'Fade', description: 'Soft dissolve for general presentations.' },
  { id: 'push', label: 'Push', description: 'Horizontal push for narrative sequences.' },
  { id: 'wipe', label: 'Wipe', description: 'Clean directional reveal for reports.' },
  { id: 'zoom', label: 'Zoom', description: 'Subtle scale-in for emphasis slides.' },
];

export function normalizeSlideTransition(transition?: SlideTransition): Required<SlideTransition> {
  return {
    type: transition?.type || 'none',
    durationMs: Math.max(100, Math.min(3000, Math.round(transition?.durationMs || 450))),
    advanceAfterSec: Math.max(0, Math.min(600, Math.round(transition?.advanceAfterSec || 0))),
  };
}

export function slideTransitionClass(transition?: SlideTransition): string {
  const normalized = normalizeSlideTransition(transition);
  return normalized.type === 'none' ? '' : `px-transition-${normalized.type}`;
}

export function describeSlideTransition(transition?: SlideTransition): string {
  const normalized = normalizeSlideTransition(transition);
  const label = PPTX_TRANSITION_TYPES.find((item) => item.id === normalized.type)?.label || 'None';
  const advance = normalized.advanceAfterSec > 0 ? `, auto ${normalized.advanceAfterSec}s` : '';
  return `${label} ${normalized.durationMs}ms${advance}`;
}

function transitionSpeed(durationMs: number): 'fast' | 'med' | 'slow' {
  if (durationMs <= 350) return 'fast';
  if (durationMs <= 900) return 'med';
  return 'slow';
}

function transitionChildXml(type: SlideTransition['type']): string {
  switch (type) {
    case 'fade':
      return '<p:fade/>';
    case 'push':
      return '<p:push dir="l"/>';
    case 'wipe':
      return '<p:wipe dir="l"/>';
    case 'zoom':
      return '<p:zoom/>';
    default:
      return '';
  }
}

export function buildOpenXmlTransition(transition?: SlideTransition): string {
  const normalized = normalizeSlideTransition(transition);
  if (normalized.type === 'none' && normalized.advanceAfterSec <= 0) return '';
  const attrs = [
    `spd="${transitionSpeed(normalized.durationMs)}"`,
    normalized.advanceAfterSec > 0 ? `advTm="${normalized.advanceAfterSec * 1000}"` : '',
    normalized.advanceAfterSec > 0 ? 'advClick="1"' : '',
  ].filter(Boolean).join(' ');
  return `<p:transition ${attrs}>${transitionChildXml(normalized.type)}</p:transition>`;
}

export function injectOpenXmlTransition(slideXml: string, transition?: SlideTransition): string {
  const transitionXml = buildOpenXmlTransition(transition);
  const withoutExisting = slideXml
    .replace(/<p:transition\b[\s\S]*?<\/p:transition>/, '')
    .replace(/<p:transition\b[^/>]*\/>/, '');
  if (!transitionXml) return withoutExisting;

  const insertionTargets = ['<p:timing', '<p:extLst', '</p:sld>'];
  for (const target of insertionTargets) {
    const idx = withoutExisting.indexOf(target);
    if (idx >= 0) {
      return `${withoutExisting.slice(0, idx)}${transitionXml}${withoutExisting.slice(idx)}`;
    }
  }
  return withoutExisting;
}

export async function applyTransitionsToPptxBase64(base64: string, slides: Slide[]): Promise<string> {
  if (!slides.some((slide) => buildOpenXmlTransition(slide.transition))) return base64;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(base64, { base64: true });
  await Promise.all(slides.map(async (slide, index) => {
    const transitionXml = buildOpenXmlTransition(slide.transition);
    if (!transitionXml) return;
    const path = `ppt/slides/slide${index + 1}.xml`;
    const file = zip.file(path);
    if (!file) return;
    const xml = await file.async('string');
    zip.file(path, injectOpenXmlTransition(xml, slide.transition));
  }));
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
