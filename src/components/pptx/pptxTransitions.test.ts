import { describe, expect, it } from 'vitest';
import {
  buildOpenXmlTransition,
  applyTransitionsToPptxBase64,
  describeSlideTransition,
  injectOpenXmlTransition,
  normalizeSlideTransition,
  slideTransitionClass,
} from './pptxTransitions';

describe('pptx transitions', () => {
  it('normalizes transition defaults and bounds', () => {
    expect(normalizeSlideTransition()).toEqual({ type: 'none', durationMs: 450, advanceAfterSec: 0 });
    expect(normalizeSlideTransition({ type: 'fade', durationMs: 10, advanceAfterSec: 999 })).toEqual({
      type: 'fade',
      durationMs: 100,
      advanceAfterSec: 600,
    });
  });

  it('describes and maps transition classes', () => {
    expect(slideTransitionClass({ type: 'push', durationMs: 700 })).toBe('px-transition-push');
    expect(slideTransitionClass({ type: 'none' })).toBe('');
    expect(describeSlideTransition({ type: 'wipe', durationMs: 800, advanceAfterSec: 5 })).toBe('Wipe 800ms, auto 5s');
  });

  it('builds PresentationML transition XML', () => {
    expect(buildOpenXmlTransition({ type: 'fade', durationMs: 250 })).toBe('<p:transition spd="fast"><p:fade/></p:transition>');
    expect(buildOpenXmlTransition({ type: 'wipe', durationMs: 1200, advanceAfterSec: 3 })).toBe(
      '<p:transition spd="slow" advTm="3000" advClick="1"><p:wipe dir="l"/></p:transition>',
    );
    expect(buildOpenXmlTransition({ type: 'none' })).toBe('');
  });

  it('injects transition XML in valid slide order and replaces previous transitions', () => {
    const xml = '<p:sld><p:cSld/><p:clrMapOvr/><p:transition><p:fade/></p:transition><p:timing/></p:sld>';
    const result = injectOpenXmlTransition(xml, { type: 'push', durationMs: 700, advanceAfterSec: 4 });

    expect(result).not.toContain('<p:fade/>');
    expect(result).toContain('<p:push dir="l"/>');
    expect(result.indexOf('<p:transition')).toBeLessThan(result.indexOf('<p:timing'));
    expect(result).toContain('advTm="4000"');
  });

  it('post-processes pptx zip slide XML with transitions', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><p:cSld/><p:timing/></p:sld>');
    zip.file('ppt/slides/slide2.xml', '<p:sld><p:cSld/></p:sld>');
    const base64 = await zip.generateAsync({ type: 'base64' });

    const nextBase64 = await applyTransitionsToPptxBase64(base64, [
      {
        id: 's1',
        bgColor: '#ffffff',
        transition: { type: 'zoom', durationMs: 1000, advanceAfterSec: 2 },
        elements: [],
      },
      {
        id: 's2',
        bgColor: '#ffffff',
        transition: { type: 'none' },
        elements: [],
      },
    ]);
    const nextZip = await JSZip.loadAsync(nextBase64, { base64: true });
    const slide1 = await nextZip.file('ppt/slides/slide1.xml')?.async('string');
    const slide2 = await nextZip.file('ppt/slides/slide2.xml')?.async('string');

    expect(slide1).toContain('<p:zoom/>');
    expect(slide1).toContain('advTm="2000"');
    expect(slide2).not.toContain('<p:transition');
  });
});
