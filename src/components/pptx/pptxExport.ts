/**
 * pptxExport.ts — Export slides to PPTX using pptxgenjs
 */

import type { Slide, SlideSize, SlideElement, PreservedPart } from './types';
import { applyTransitionsToPptxBase64 } from './pptxTransitions';
import { animationObjectName, applyAnimationsToPptxBase64 } from './pptxAnimationExport';

export async function exportSlidesToPptx(slides: Slide[], slideSize: SlideSize): Promise<string> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();

  const sw = slideSize.widthInch;
  const sh = slideSize.heightInch;
  if (Math.abs(slideSize.aspectRatio - 16 / 9) < 0.05) {
    pptx.layout = 'LAYOUT_WIDE';
  } else if (Math.abs(slideSize.aspectRatio - 4 / 3) < 0.05) {
    pptx.layout = 'LAYOUT_4x3';
  } else {
    pptx.defineLayout({ name: 'CUSTOM', width: sw, height: sh });
    pptx.layout = 'CUSTOM';
  }

  for (const slide of slides) {
    const pptxSlide = pptx.addSlide();
    pptxSlide.hidden = !!slide.hidden;
    if (slide.notes?.trim()) {
      pptxSlide.addNotes(slide.notes.trim());
    }
    if (slide.bgImage) {
      pptxSlide.background = { data: slide.bgImage };
    } else {
      pptxSlide.background = { color: slide.bgColor.replace('#', '') };
    }

    for (const el of slide.elements) {
      const xInch = (el.x / 100) * sw;
      const yInch = (el.y / 100) * sh;
      const wInch = (el.w / 100) * sw;
      const hInch = (el.h / 100) * sh;

      const rotOpt = el.rotation ? { rotate: el.rotation } : {};
      // Animated elements get a stable objectName so the timing injector can
      // recover their shape ids from the slide XML afterwards.
      const nameOpt = el.animation ? { objectName: animationObjectName(el.id) } : {};

      if (el.type === 'text') {
        const textOpts = {
          x: xInch, y: yInch, w: wInch, h: hInch,
          fontSize: el.fontSize || 18,
          color: (el.fontColor || '#000000').replace('#', ''),
          bold: el.bold || false,
          italic: el.italic || false,
          underline: el.underline ? { style: 'sng' as any } : undefined,
          strike: el.strikethrough ? 'sngStrike' as any : undefined,
          align: el.textAlign || 'left',
          fontFace: el.fontFamily || undefined,
          valign: 'top' as const,
          wrap: true,
          transparency: el.opacity != null ? (1 - el.opacity) * 100 : undefined,
          ...rotOpt,
          ...nameOpt,
        };
        if (el.listStyle === 'bullet' || el.listStyle === 'number') {
          // One paragraph per line so PowerPoint shows real bullet/number lists.
          const bullet = el.listStyle === 'bullet' ? true : { type: 'number' as const };
          const runs = (el.text || '').split('\n').map((line) => ({
            text: line,
            options: { bullet, breakLine: true },
          }));
          pptxSlide.addText(runs, textOpts);
        } else {
          pptxSlide.addText(el.text || '', textOpts);
        }
      } else if (el.type === 'rect') {
        addShapeWithText(pptxSlide, 'rect', el, xInch, yInch, wInch, hInch, { ...rotOpt, ...nameOpt });
      } else if (el.type === 'circle') {
        addShapeWithText(pptxSlide, 'ellipse', el, xInch, yInch, wInch, hInch, { ...rotOpt, ...nameOpt });
      } else if (el.type === 'triangle') {
        addShapeWithText(pptxSlide, 'triangle', el, xInch, yInch, wInch, hInch, { ...rotOpt, ...nameOpt });
      } else if (el.type === 'star') {
        addShapeWithText(pptxSlide, 'star5' as any, el, xInch, yInch, wInch, hInch, { ...rotOpt, ...nameOpt });
      } else if (el.type === 'arrow') {
        addShapeWithText(pptxSlide, 'rightArrow' as any, el, xInch, yInch, wInch, hInch, { ...rotOpt, ...nameOpt });
      } else if (el.type === 'line') {
        pptxSlide.addShape('line' as any, {
          // Keep the real height so vertical/diagonal connectors stay sloped —
          // forcing h:0 flattened every line into a horizontal rule.
          x: xInch, y: yInch, w: wInch, h: hInch,
          line: {
            color: (el.borderColor || '#000000').replace('#', ''),
            width: el.borderWidth || 2,
          },
          ...rotOpt,
          ...nameOpt,
        });
      } else if (el.type === 'table' && el.table) {
        addTable(pptxSlide, el, xInch, yInch, wInch, hInch);
      } else if (el.type === 'image' && el.imageSrc) {
        try {
          pptxSlide.addImage({
            data: el.imageSrc,
            x: xInch, y: yInch, w: wInch, h: hInch,
            ...rotOpt,
            ...nameOpt,
          });
        } catch {
          // skip unreadable images
        }
      }
    }
  }

  const output = await pptx.write({ outputType: 'base64' });
  const withTransitions = await applyTransitionsToPptxBase64(output as string, slides);
  const withAnimations = await applyAnimationsToPptxBase64(withTransitions, slides);
  return applyPreservedPartsToPptxBase64(withAnimations, slides);
}

// ─── Preserved graphicFrame re-injection ──────────────────────
// Charts / SmartArt-diagrams the editor can't render are round-tripped verbatim:
// their original parts are written back into the export zip and their
// graphicFrame XML is re-inserted into the generated slide (with fresh rIds).

/** Highest rId number in existing relationship ids → next free id. Pure. */
export function nextRelId(existingIds: string[]): string {
  let max = 0;
  for (const id of existingIds) {
    const m = /^rId(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `rId${max + 1}`;
}

/**
 * Rewrite relationship id attribute values per idMap in one pass (matched by
 * value so it is independent of the `r:`/`ns1:` namespace prefix). Pure.
 */
export function remapGraphicFrameRelIds(xml: string, idMap: Map<string, string>): string {
  return xml.replace(/="(rId\d+)"/g, (m, id) => (idMap.has(id) ? `="${idMap.get(id)}"` : m));
}

/** Insert graphicFrame fragments just before the spTree closes. Pure. */
export function injectGraphicFramesIntoSlide(slideXml: string, framesXml: string[]): string {
  if (framesXml.length === 0) return slideXml;
  const fragment = framesXml.join('');
  const close = slideXml.lastIndexOf('</p:spTree>');
  if (close < 0) return slideXml;
  return slideXml.slice(0, close) + fragment + slideXml.slice(close);
}

/** ppt/charts/chart1.xml → ../charts/chart1.xml (relative to a slide). Pure. */
export function relativeTargetFromSlide(partPath: string): string {
  return partPath.replace(/^ppt\/slides\//, '').replace(/^ppt\//, '../');
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Merge added relationships into a slide's .rels XML (creating it if absent). Pure. */
export function mergeSlideRels(
  existingRelsXml: string | null,
  added: Array<{ id: string; target: string; type: string }>,
): string {
  const entries = added
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join('');
  if (!existingRelsXml || !/<\/Relationships>/.test(existingRelsXml)) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="${REL_NS}">${entries}</Relationships>`;
  }
  return existingRelsXml.replace('</Relationships>', `${entries}</Relationships>`);
}

/** Existing relationship ids in a .rels XML. Pure. */
export function relIdsInXml(relsXml: string | null): string[] {
  if (!relsXml) return [];
  return [...relsXml.matchAll(/\bId="(rId\d+)"/g)].map((m) => m[1]);
}

/** Add missing Default (by extension) and Override (by part) content types. Pure. */
export function addContentTypes(
  ctXml: string,
  overrides: Array<{ part: string; type: string }>,
  defaults: Array<{ ext: string; type: string }>,
): string {
  let out = ctXml;
  const additions: string[] = [];
  for (const d of defaults) {
    if (new RegExp(`<Default[^>]*Extension="${d.ext}"`, 'i').test(out)) continue;
    if (additions.some((a) => a.includes(`Extension="${d.ext}"`))) continue;
    additions.push(`<Default Extension="${d.ext}" ContentType="${d.type}"/>`);
  }
  for (const o of overrides) {
    if (out.includes(`PartName="${o.part}"`)) continue;
    if (additions.some((a) => a.includes(`PartName="${o.part}"`))) continue;
    additions.push(`<Override PartName="${o.part}" ContentType="${o.type}"/>`);
  }
  if (additions.length === 0) return out;
  const close = out.lastIndexOf('</Types>');
  if (close < 0) return out;
  return out.slice(0, close) + additions.join('') + out.slice(close);
}

/** Content-type additions needed for one preserved part's files. */
function collectContentTypeNeeds(
  part: PreservedPart,
  overrides: Array<{ part: string; type: string }>,
  defaults: Array<{ ext: string; type: string }>,
) {
  for (const f of part.parts) {
    const ext = f.path.split('.').pop()?.toLowerCase() || '';
    if (ext === 'rels') continue; // pptxgenjs already declares the rels default
    if (!f.contentType) continue;
    if (ext === 'xml') overrides.push({ part: '/' + f.path, type: f.contentType });
    else defaults.push({ ext, type: f.contentType });
  }
}

export async function applyPreservedPartsToPptxBase64(base64: string, slides: Slide[]): Promise<string> {
  if (!slides.some((s) => s.preserved && s.preserved.length > 0)) return base64;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(base64, { base64: true });

  const overrides: Array<{ part: string; type: string }> = [];
  const defaults: Array<{ ext: string; type: string }> = [];

  for (let index = 0; index < slides.length; index++) {
    const slide = slides[index];
    if (!slide.preserved || slide.preserved.length === 0) continue;

    const slidePath = `ppt/slides/slide${index + 1}.xml`;
    const relsPath = `ppt/slides/_rels/slide${index + 1}.xml.rels`;
    const slideFile = zip.file(slidePath);
    if (!slideFile) continue;
    const slideXml = await slideFile.async('string');
    const existingRelsXml = (await zip.file(relsPath)?.async('string')) ?? null;
    const existingIds = relIdsInXml(existingRelsXml);

    const framesXml: string[] = [];
    const addedRels: Array<{ id: string; target: string; type: string }> = [];

    for (const pres of slide.preserved) {
      // Write every referenced part back at its original path (skip collisions).
      for (const f of pres.parts) {
        if (!zip.file(f.path)) zip.file(f.path, f.base64, { base64: true });
      }
      collectContentTypeNeeds(pres, overrides, defaults);

      // Fresh, non-colliding rIds for the slide → chart/diagram relationships.
      const idMap = new Map<string, string>();
      for (const r of pres.rels) {
        const nid = nextRelId(existingIds);
        existingIds.push(nid);
        idMap.set(r.id, nid);
        addedRels.push({ id: nid, target: relativeTargetFromSlide(r.target), type: r.type });
      }
      framesXml.push(remapGraphicFrameRelIds(pres.graphicFrameXml, idMap));
    }

    zip.file(slidePath, injectGraphicFramesIntoSlide(slideXml, framesXml));
    zip.file(relsPath, mergeSlideRels(existingRelsXml, addedRels));
  }

  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    const ctXml = await ctFile.async('string');
    zip.file('[Content_Types].xml', addContentTypes(ctXml, overrides, defaults));
  }

  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

function addTable(
  pptxSlide: any, el: SlideElement,
  xInch: number, yInch: number, wInch: number, hInch: number,
) {
  const t = el.table!;
  const border = { type: 'solid', pt: 1, color: (t.borderColor || '#cbd5e1').replace('#', '') };
  const rows = t.cells.map((row, ri) => {
    const isHeader = !!t.headerRow && ri === 0;
    const outRow: any[] = [];
    for (let ci = 0; ci < row.length; ci++) {
      const cd = t.cellData?.[ri]?.[ci];
      // Cells absorbed by a merge origin are omitted — pptxgenjs expects the
      // covered slots to be absent, with colspan/rowspan on the origin cell.
      if (cd?.hMerge || cd?.vMerge) continue;
      const fill = cd?.fillColor || (isHeader ? (t.headerFill || '#2563eb') : (t.bodyFill || '#ffffff'));
      const options: any = {
        fill: { color: fill.replace('#', '') },
        color: (cd?.color || (isHeader ? (t.headerColor || '#ffffff') : (t.bodyColor || '#111827'))).replace('#', ''),
        bold: isHeader,
        fontSize: el.fontSize || 14,
        align: cd?.align || ('left' as const),
        valign: 'middle' as const,
        border,
      };
      if (cd?.colSpan && cd.colSpan > 1) options.colspan = cd.colSpan;
      if (cd?.rowSpan && cd.rowSpan > 1) options.rowspan = cd.rowSpan;
      outRow.push({ text: row[ci] || '', options });
    }
    return outRow;
  });
  const colW = t.colWidths && t.colWidths.length === t.cols
    ? t.colWidths.map((cw) => cw * wInch)
    : undefined;
  pptxSlide.addTable(rows, {
    x: xInch, y: yInch, w: wInch, h: hInch,
    colW,
    border,
    ...(el.animation ? { objectName: animationObjectName(el.id) } : {}),
  });
}

function addShapeWithText(
  pptxSlide: any, shape: string, el: SlideElement,
  xInch: number, yInch: number, wInch: number, hInch: number,
  rotOpt: Record<string, any>,
) {
  // A 'transparent' (or otherwise non-hex) fill must stay unfilled — passing it
  // straight to pptxgenjs makes it fall back to solid black, turning noFill
  // outline boxes into black rectangles.
  const rawFill = el.fillColor || '#4a90d9';
  const noFill = rawFill === 'transparent' || !/^#?[0-9a-fA-F]{3,8}$/.test(rawFill);
  const shapeOpts: any = {
    x: xInch, y: yInch, w: wInch, h: hInch,
    fill: noFill
      ? { type: 'none' }
      : { color: rawFill.replace('#', ''), transparency: el.opacity != null ? (1 - el.opacity) * 100 : undefined },
    ...rotOpt,
  };

  if (el.borderWidth || el.borderColor) {
    shapeOpts.line = {
      color: (el.borderColor || '#000000').replace('#', ''),
      width: el.borderWidth || 1,
    };
  }

  if (el.shadow) {
    shapeOpts.shadow = { type: 'outer', blur: 4, offset: 2, color: '000000', opacity: 0.4 };
  }

  pptxSlide.addShape(shape as any, shapeOpts);

  if (el.text) {
    pptxSlide.addText(el.text, {
      ...(el.animation ? { objectName: animationObjectName(el.id) } : {}),
      x: xInch, y: yInch, w: wInch, h: hInch,
      fontSize: el.fontSize || 14,
      color: (el.fontColor || '#ffffff').replace('#', ''),
      bold: el.bold || false,
      italic: el.italic || false,
      underline: el.underline ? { style: 'sng' as any } : undefined,
      strike: el.strikethrough ? 'sngStrike' as any : undefined,
      align: el.textAlign || 'center',
      fontFace: el.fontFamily || undefined,
      valign: 'middle',
    });
  }
}
