import { describe, expect, it } from 'vitest';
import {
  animationObjectName,
  buildTimingXml,
  collectAnimatedSpids,
  injectTimingXml,
} from './pptxAnimationExport';
import type { Slide, SlideElement } from './types';

const el = (id: string, order?: number): SlideElement => ({
  id, type: 'text', x: 0, y: 0, w: 10, h: 10,
  ...(order !== undefined ? { animation: { effect: 'fade' as const, order } } : {}),
});

const slide = (elements: SlideElement[]): Slide => ({ id: 's', bgColor: '#fff', elements });

const slideXmlWith = (entries: Array<[number, string]>): string =>
  `<p:sld><p:cSld><p:spTree>${entries.map(([id, name]) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/></p:nvSpPr></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;

describe('collectAnimatedSpids', () => {
  it('maps animated elements to every shape carrying their objectName', () => {
    const s = slide([el('a', 1), el('b', 2), el('static')]);
    const xml = slideXmlWith([
      [4, animationObjectName('a')],
      [5, animationObjectName('a')],   // shape + text overlay share the name
      [6, animationObjectName('b')],
      [7, 'unrelated'],
    ]);
    const spids = collectAnimatedSpids(xml, s);
    expect(spids.get('a')).toEqual([4, 5]);
    expect(spids.get('b')).toEqual([6]);
    expect(spids.has('static')).toBe(false);
  });
});

describe('buildTimingXml', () => {
  const s = slide([el('a', 1), el('b', 2)]);
  const spids = new Map([['a', [4]], ['b', [5]]]);

  it('emits one click-step per animation order', () => {
    const xml = buildTimingXml(s, spids);
    expect(xml.startsWith('<p:timing>')).toBe(true);
    // Each click-step waits on delay="indefinite" until the presenter clicks.
    expect(xml.match(/delay="indefinite"/g)!.length).toBe(2);
    expect(xml).toContain('nodeType="mainSeq"');
    expect(xml).toContain('spid="4"');
    expect(xml).toContain('spid="5"');
    expect(xml).toContain('presetClass="entr"');
    expect(xml).toContain('style.visibility');
  });

  it('skips elements whose shapes were not found and returns "" when none', () => {
    expect(buildTimingXml(s, new Map())).toBe('');
    const partial = buildTimingXml(s, new Map([['b', [9]]]));
    expect(partial).toContain('spid="9"');
    expect(partial).not.toContain('spid="4"');
  });

  it('keeps XML tags balanced', () => {
    // Self-closing tags (<p:cTn .../>, <p:cond .../>) balance themselves.
    const xml = buildTimingXml(s, spids).replace(/<[^>]*\/>/g, '');
    for (const tag of ['p:par', 'p:cTn', 'p:childTnLst', 'p:set', 'p:animEffect', 'p:timing', 'p:seq']) {
      const open = (xml.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
      const close = (xml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      expect(close, tag).toBe(open);
    }
  });

  it('adds a scale behavior for zoom entrances', () => {
    const zoomSlide = slide([{ ...el('z'), animation: { effect: 'zoom', order: 1 } }]);
    const xml = buildTimingXml(zoomSlide, new Map([['z', [4]]]));
    expect(xml).toContain('<p:animScale>');
  });
});

describe('injectTimingXml', () => {
  it('inserts before </p:sld> and replaces an existing timing tree', () => {
    const base = '<p:sld><p:cSld/></p:sld>';
    const once = injectTimingXml(base, '<p:timing>NEW</p:timing>');
    expect(once).toBe('<p:sld><p:cSld/><p:timing>NEW</p:timing></p:sld>');
    const twice = injectTimingXml(once, '<p:timing>NEWER</p:timing>');
    expect(twice).toContain('NEWER');
    expect(twice).not.toContain('>NEW<');
  });

  it('removes timing when passed an empty tree', () => {
    const withTiming = '<p:sld><p:timing>OLD</p:timing></p:sld>';
    expect(injectTimingXml(withTiming, '')).toBe('<p:sld></p:sld>');
  });
});
