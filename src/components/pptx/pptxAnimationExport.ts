/**
 * pptxAnimationExport.ts — write entrance animations into exported .pptx files.
 *
 * pptxgenjs cannot emit <p:timing>, so (mirroring pptxTransitions) we
 * post-process the generated zip: animated elements are tagged with a stable
 * objectName at export time, their shape ids are recovered from each slide's
 * XML, and a PowerPoint-compatible timing tree (one click-step per animation
 * order, entrance presets) is injected into the slide.
 */

import type { ElementAnimationEffect, Slide } from './types';
import { DEFAULT_ANIMATION_MS, buildAnimationSteps } from './pptxAnimations';

/** objectName assigned to every animated element's pptxgenjs objects. */
export function animationObjectName(elementId: string): string {
  return `bb-anim-${elementId}`;
}

/** animEffect filter + PowerPoint preset metadata per effect. */
const EFFECT_XML: Record<ElementAnimationEffect, { filter: string; presetId: number; presetSubtype: number; scale?: boolean }> = {
  fade: { filter: 'fade', presetId: 10, presetSubtype: 0 },
  rise: { filter: 'slide(fromBottom)', presetId: 2, presetSubtype: 4 },
  zoom: { filter: 'fade', presetId: 53, presetSubtype: 0, scale: true },
  'slide-left': { filter: 'slide(fromRight)', presetId: 2, presetSubtype: 8 },
  'slide-right': { filter: 'slide(fromLeft)', presetId: 2, presetSubtype: 2 },
  wipe: { filter: 'wipe(right)', presetId: 22, presetSubtype: 8 },
};

/**
 * Shape ids of animated elements, recovered by objectName. One element can
 * own several drawing objects (a shape plus its text overlay) — all animate
 * together.
 */
export function collectAnimatedSpids(slideXml: string, slide: Slide): Map<string, number[]> {
  const byName = new Map<string, number[]>();
  const re = /<p:cNvPr id="(\d+)" name="([^"]*)"/g;
  for (const m of slideXml.matchAll(re)) {
    const bucket = byName.get(m[2]) ?? [];
    bucket.push(Number(m[1]));
    byName.set(m[2], bucket);
  }
  const result = new Map<string, number[]>();
  for (const el of slide.elements) {
    if (!el.animation) continue;
    const spids = byName.get(animationObjectName(el.id));
    if (spids?.length) result.set(el.id, spids);
  }
  return result;
}

/** Build the <p:timing> tree for a slide ('' when nothing animates). */
export function buildTimingXml(slide: Slide, spidsByElement: Map<string, number[]>): string {
  const steps = buildAnimationSteps(slide)
    .map((ids) => ids.filter((id) => spidsByElement.has(id)))
    .filter((ids) => ids.length > 0);
  if (steps.length === 0) return '';

  let nextId = 2;
  const id = () => ++nextId;
  const elById = new Map(slide.elements.map((e) => [e.id, e]));

  const effectPar = (elementId: string, first: boolean): string => {
    const el = elById.get(elementId)!;
    const anim = el.animation!;
    const fx = EFFECT_XML[anim.effect];
    const dur = anim.durationMs ?? DEFAULT_ANIMATION_MS;
    const spids = spidsByElement.get(elementId)!;
    const behaviors = spids.map((spid) => (
      `<p:set><p:cBhvr><p:cTn id="${id()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>` +
      `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr>` +
      `<p:to><p:strVal val="visible"/></p:to></p:set>` +
      `<p:animEffect transition="in" filter="${fx.filter}"><p:cBhvr><p:cTn id="${id()}" dur="${dur}"/>` +
      `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:animEffect>` +
      (fx.scale
        ? `<p:animScale><p:cBhvr><p:cTn id="${id()}" dur="${dur}"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr>` +
          `<p:from x="82000" y="82000"/><p:to x="100000" y="100000"/></p:animScale>`
        : '')
    )).join('');
    return (
      `<p:par><p:cTn id="${id()}" presetID="${fx.presetId}" presetClass="entr" presetSubtype="${fx.presetSubtype}" ` +
      `fill="hold" grpId="0" nodeType="${first ? 'clickEffect' : 'withEffect'}">` +
      `<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${behaviors}</p:childTnLst></p:cTn></p:par>`
    );
  };

  const clickPars = steps.map((ids) => (
    `<p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>` +
    `<p:par><p:cTn id="${id()}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
    ids.map((elementId, i) => effectPar(elementId, i === 0)).join('') +
    `</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`
  )).join('');

  return (
    '<p:timing><p:tnLst><p:par>' +
    '<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    clickPars +
    '</p:childTnLst></p:cTn>' +
    '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>' +
    '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  );
}

/** Insert (or replace) the timing tree; schema order puts it after transition. */
export function injectTimingXml(slideXml: string, timingXml: string): string {
  const withoutExisting = slideXml.replace(/<p:timing\b[\s\S]*?<\/p:timing>/, '');
  if (!timingXml) return withoutExisting;
  for (const target of ['<p:extLst', '</p:sld>']) {
    const idx = withoutExisting.indexOf(target);
    if (idx >= 0) {
      return `${withoutExisting.slice(0, idx)}${timingXml}${withoutExisting.slice(idx)}`;
    }
  }
  return withoutExisting;
}

export async function applyAnimationsToPptxBase64(base64: string, slides: Slide[]): Promise<string> {
  if (!slides.some((slide) => slide.elements.some((el) => el.animation))) return base64;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(base64, { base64: true });
  await Promise.all(slides.map(async (slide, index) => {
    if (!slide.elements.some((el) => el.animation)) return;
    const path = `ppt/slides/slide${index + 1}.xml`;
    const file = zip.file(path);
    if (!file) return;
    const xml = await file.async('string');
    const timing = buildTimingXml(slide, collectAnimatedSpids(xml, slide));
    if (!timing) return;
    zip.file(path, injectTimingXml(xml, timing));
  }));
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
