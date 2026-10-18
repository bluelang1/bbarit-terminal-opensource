/**
 * pptxParser.ts — Parse PPTX files using JSZip + XML DOMParser
 */

import type {
  Slide, SlideElement, SlideSize, ParsedPptx, TableData, TableCell,
  PreservedPart, PreservedFile, PreservedRel,
} from './types';
import { DEFAULT_SLIDE_SIZE, createBlankSlide, uid } from './types';

/** Return direct/descendant children whose local (namespace-stripped) name matches */
function localChildren(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter(
    (c) => (c.tagName.split(':').pop() || c.tagName) === name,
  );
}

/** Collect every descendant whose local (namespace-stripped) name matches */
function collectByLocalName(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if ((c.tagName.split(':').pop() || c.tagName) === name) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function firstByLocalName(root: ParentNode | null | undefined, name: string): Element | null {
  if (!root) return null;
  const walk = (node: ParentNode): Element | null => {
    for (const child of Array.from(node.children || [])) {
      if ((child.tagName.split(':').pop() || child.tagName) === name) return child;
      const nested = walk(child);
      if (nested) return nested;
    }
    return null;
  };
  return walk(root);
}

function directChildByLocalName(root: Element | null | undefined, name: string): Element | null {
  if (!root) return null;
  return Array.from(root.children).find((child) =>
    (child.tagName.split(':').pop() || child.tagName) === name,
  ) || null;
}

function directPathByLocalName(root: Element | null | undefined, names: string[]): Element | null {
  let current: Element | null | undefined = root;
  for (const name of names) {
    current = directChildByLocalName(current, name);
    if (!current) return null;
  }
  return current || null;
}

/** Resolve a schemeClr val (accent1, tx1, bg1, …) to a hex color via theme + master clrMap */
type SchemeResolver = (val: string) => string | undefined;

/** Read the first color hex out of a fill container (solidFill/gs/…) honouring srgb, sys, and scheme colors */
function hexFromClrParent(parent: Element | null, scheme: SchemeResolver): string | undefined {
  if (!parent) return undefined;
  for (const c of Array.from(parent.children)) {
    const n = c.tagName.split(':').pop() || c.tagName;
    if (n === 'srgbClr') {
      const v = c.getAttribute('val');
      if (v) return '#' + v;
    } else if (n === 'sysClr') {
      const v = c.getAttribute('lastClr');
      if (v) return '#' + v;
    } else if (n === 'schemeClr') {
      const v = c.getAttribute('val');
      if (v) {
        const r = scheme(v);
        if (r) return r;
      }
    }
  }
  return undefined;
}

/** Build a schemeClr→hex resolver from theme clrScheme + master clrMap */
function buildSchemeResolver(themeDoc: Document | null, clrMapEl: Element | null): SchemeResolver {
  const slotHex = new Map<string, string>(); // dk1/lt1/accent1/… → #hex
  const clrScheme = themeDoc?.querySelector('clrScheme') ||
    (themeDoc ? collectByLocalName(themeDoc.documentElement, 'clrScheme')[0] : undefined) || null;
  if (clrScheme) {
    for (const slot of Array.from(clrScheme.children)) {
      const name = slot.tagName.split(':').pop() || slot.tagName;
      const hex = hexFromClrParent(slot, () => undefined);
      if (hex) slotHex.set(name, hex);
    }
  }
  const clrMap = new Map<string, string>(); // bg1/tx1/… → scheme slot
  if (clrMapEl) {
    for (const attr of ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
      const v = clrMapEl.getAttribute(attr);
      if (v) clrMap.set(attr, v);
    }
  }
  return (val: string) => {
    if (!val) return undefined;
    const mapped = clrMap.get(val) || val; // tx1 → dk1, bg1 → lt1, accentN identity
    return slotHex.get(mapped) || slotHex.get(val);
  };
}

/** Resolve a typeface (or theme token +mj-lt/+mn-lt) to a CSS font stack */
type FontResolver = (typeface: string | null | undefined) => string | undefined;

/** Quote names with spaces and append the east-asian face so CJK text matches PowerPoint */
function cssFontStack(latin: string, ea?: string): string {
  const quote = (f: string) => (/[\s"']/.test(f) ? `"${f.replace(/"/g, '')}"` : f);
  const faces = [latin];
  if (ea && ea !== latin) faces.push(ea);
  return `${faces.map(quote).join(', ')}, sans-serif`;
}

/** Build a font resolver from the theme's fontScheme (major/minor + Hangul script face) */
function buildFontResolver(themeDoc: Document | null): FontResolver {
  const readFont = (el: Element | null): [string, string] => {
    if (!el) return ['', ''];
    const latin = directChildByLocalName(el, 'latin')?.getAttribute('typeface') || '';
    let ea = directChildByLocalName(el, 'ea')?.getAttribute('typeface') || '';
    for (const f of localChildren(el, 'font')) {
      if (f.getAttribute('script') === 'Hang') { ea = f.getAttribute('typeface') || ea; break; }
    }
    return [latin, ea];
  };
  const fontScheme = themeDoc
    ? collectByLocalName(themeDoc.documentElement, 'fontScheme')[0] || null
    : null;
  const [major, majorEa] = readFont(directChildByLocalName(fontScheme, 'majorFont'));
  const [minor, minorEa] = readFont(directChildByLocalName(fontScheme, 'minorFont'));
  return (typeface) => {
    if (!typeface) return undefined;
    if (typeface.startsWith('+mj')) return major ? cssFontStack(major, majorEa) : undefined;
    if (typeface.startsWith('+mn')) return minor ? cssFontStack(minor, minorEa) : undefined;
    return cssFontStack(typeface);
  };
}

/** Text defaults a shape inherits from the master txStyles / placeholder lstStyle chain */
interface InheritedTextStyle {
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  fontFamily?: string;
}

const ALGN_MAP: Record<string, 'left' | 'center' | 'right'> = {
  l: 'left', ctr: 'center', r: 'right', just: 'left', dist: 'left',
};

const ANCHOR_MAP: Record<string, 'top' | 'middle' | 'bottom'> = {
  t: 'top', ctr: 'middle', b: 'bottom',
};

/** Read lvl1 paragraph defaults (algn + defRPr sz/b/color/font) from a style container
    (master txStyles bucket or a placeholder txBody's lstStyle) */
function parseLvl1TextStyle(
  container: Element | null, scheme: SchemeResolver, fonts: FontResolver,
): InheritedTextStyle {
  const out: InheritedTextStyle = {};
  const lvl1 = container ? directChildByLocalName(container, 'lvl1pPr') : null;
  if (!lvl1) return out;
  const algn = lvl1.getAttribute('algn');
  if (algn && ALGN_MAP[algn]) out.textAlign = ALGN_MAP[algn];
  const defRPr = directChildByLocalName(lvl1, 'defRPr');
  if (defRPr) {
    const sz = defRPr.getAttribute('sz');
    if (sz) out.fontSize = parseInt(sz) / 100;
    if (defRPr.getAttribute('b') === '1') out.bold = true;
    const color = hexFromClrParent(directChildByLocalName(defRPr, 'solidFill'), scheme);
    if (color) out.fontColor = color;
    const family = fonts(directChildByLocalName(defRPr, 'latin')?.getAttribute('typeface'));
    if (family) out.fontFamily = family;
  }
  return out;
}

interface MasterTextStyles {
  title: InheritedTextStyle;
  body: InheritedTextStyle;
  other: InheritedTextStyle;
}

/** The master's p:txStyles — the base of every placeholder's text inheritance */
function parseMasterTextStyles(
  masterDoc: Document, scheme: SchemeResolver, fonts: FontResolver,
): MasterTextStyles {
  const txStyles = collectByLocalName(masterDoc.documentElement, 'txStyles')[0] || null;
  return {
    title: parseLvl1TextStyle(directChildByLocalName(txStyles, 'titleStyle'), scheme, fonts),
    body: parseLvl1TextStyle(directChildByLocalName(txStyles, 'bodyStyle'), scheme, fonts),
    other: parseLvl1TextStyle(directChildByLocalName(txStyles, 'otherStyle'), scheme, fonts),
  };
}

/** Which master txStyles bucket a placeholder type inherits from */
function masterBucketFor(type: string): keyof MasterTextStyles {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type === 'body' || type === 'subTitle' || type === '') return 'body';
  return 'other';
}

/** Per-placeholder text overrides carried by a layout's/master's own sp shapes:
    txBody lstStyle lvl1 + bodyPr anchor. Keyed like parsePlaceholderBoxes. */
function parsePlaceholderTextStyles(
  doc: Document, scheme: SchemeResolver, fonts: FontResolver,
): Map<string, InheritedTextStyle> {
  const map = new Map<string, InheritedTextStyle>();
  for (const sp of collectByLocalName(doc.documentElement, 'sp')) {
    const ph = getPlaceholderElement(sp);
    if (!ph) continue;
    const txBody = directChildByLocalName(sp, 'txBody');
    const style = parseLvl1TextStyle(
      txBody ? directChildByLocalName(txBody, 'lstStyle') : null, scheme, fonts,
    );
    const anchor = directChildByLocalName(txBody, 'bodyPr')?.getAttribute('anchor');
    if (anchor && ANCHOR_MAP[anchor]) style.verticalAlign = ANCHOR_MAP[anchor];
    if (Object.keys(style).length === 0) continue;
    map.set(placeholderKey(ph.getAttribute('type') || '', ph.getAttribute('idx') || ''), style);
  }
  return map;
}

/** Everything parseShapeTree needs to resolve inherited text styling */
interface StyleContext {
  fonts: FontResolver;
  phStyle: (type: string, idx: string) => InheritedTextStyle;
}

/** Raw a:tc descriptor, before merges are resolved into a normalised grid. */
export interface RawTableCell {
  text: string;
  gridSpan: number;   // a:tc @gridSpan, default 1
  rowSpan: number;    // a:tc @rowSpan, default 1
  hMerge: boolean;    // a:tc @hMerge='1' — continuation of a horizontal merge
  vMerge: boolean;    // a:tc @vMerge='1' — continuation of a vertical merge
  fillColor?: string; // a:tcPr solidFill
}

export interface TableGrid {
  rows: number;
  cols: number;
  cells: string[][];
  cellData: TableCell[][];
}

/**
 * Pure windowing math: fold raw a:tc rows (which include every grid position,
 * merge continuations and all) into a normalised text grid plus parallel
 * per-cell merge/fill metadata. Every row is padded to the same column count.
 */
export function buildTableGrid(rawRows: RawTableCell[][], gridColCount: number): TableGrid {
  let cols = gridColCount;
  for (const row of rawRows) {
    if (row.length > cols) cols = row.length;
  }
  const cells: string[][] = [];
  const cellData: TableCell[][] = [];
  for (const rawRow of rawRows) {
    const textRow: string[] = [];
    const dataRow: TableCell[] = [];
    for (const rc of rawRow) {
      textRow.push(rc.text);
      const cd: TableCell = {};
      if (rc.gridSpan > 1) cd.colSpan = rc.gridSpan;
      if (rc.rowSpan > 1) cd.rowSpan = rc.rowSpan;
      if (rc.hMerge) cd.hMerge = true;
      if (rc.vMerge) cd.vMerge = true;
      if (rc.fillColor) cd.fillColor = rc.fillColor;
      dataRow.push(cd);
    }
    while (textRow.length < cols) {
      textRow.push('');
      dataRow.push({});
    }
    cells.push(textRow);
    cellData.push(dataRow);
  }
  return { rows: cells.length, cols, cells, cellData };
}

/** Extract the concatenated text of an a:tc (one line per a:p). */
function tcText(tc: Element): string {
  const txBody = localChildren(tc, 'txBody')[0];
  if (!txBody) return '';
  return localChildren(txBody, 'p')
    .map((p) => {
      let s = '';
      for (const r of localChildren(p, 'r')) {
        const t = localChildren(r, 't')[0];
        if (t) s += t.textContent || '';
      }
      return s;
    })
    .join('\n');
}

/** Parse an a:tbl element into a TableData model, preserving merges and cell fills. */
function parseTable(tbl: Element, scheme: SchemeResolver): TableData | null {
  const grid = localChildren(tbl, 'tblGrid')[0];
  const gridCols = grid ? localChildren(grid, 'gridCol') : [];
  const colWidthsEmu = gridCols.map((g) => parseInt(g.getAttribute('w') || '0'));
  const rows = localChildren(tbl, 'tr');
  if (rows.length === 0) return null;

  const rawRows: RawTableCell[][] = rows.map((tr) =>
    localChildren(tr, 'tc').map((tc) => {
      const tcPr = localChildren(tc, 'tcPr')[0] || null;
      const fillColor = tcPr
        ? hexFromClrParent(localChildren(tcPr, 'solidFill')[0] || null, scheme)
        : undefined;
      return {
        text: tcText(tc),
        gridSpan: parseInt(tc.getAttribute('gridSpan') || '1') || 1,
        rowSpan: parseInt(tc.getAttribute('rowSpan') || '1') || 1,
        hMerge: tc.getAttribute('hMerge') === '1',
        vMerge: tc.getAttribute('vMerge') === '1',
        fillColor,
      };
    }),
  );

  const { rows: rowCount, cols, cells, cellData } = buildTableGrid(rawRows, gridCols.length);
  if (cols === 0) return null;

  const totalW = colWidthsEmu.reduce((s, w) => s + w, 0);
  const colWidths = totalW > 0 && colWidthsEmu.length === cols
    ? colWidthsEmu.map((w) => w / totalW)
    : Array.from({ length: cols }, () => 1 / cols);

  return {
    rows: rowCount,
    cols,
    cells,
    cellData,
    colWidths,
    headerRow: true,
    headerFill: '#2563eb',
    headerColor: '#ffffff',
    bodyFill: '#ffffff',
    bodyColor: '#111827',
    borderColor: '#cbd5e1',
  };
}

/** Resolve relative path from a PPTX relationship target */
function resolveRelPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseParts = base.split('/').slice(0, -1);
  const targetParts = target.split('/');
  for (const p of targetParts) {
    if (p === '..') baseParts.pop();
    else baseParts.push(p);
  }
  return baseParts.join('/');
}

/** One resolved relationship entry from a .rels part. */
export interface RelEntry {
  id: string;
  target: string;   // resolved zip path for internal targets; raw value for external
  type: string;
  external: boolean;
}

/** Parse a .rels XML string into resolved relationship entries. Pure. */
export function parseRelEntries(relXml: string, basePath: string): RelEntry[] {
  const out: RelEntry[] = [];
  const doc = new DOMParser().parseFromString(relXml, 'text/xml');
  doc.querySelectorAll('Relationship').forEach((rel: Element) => {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) return;
    const external = rel.getAttribute('TargetMode') === 'External';
    out.push({
      id,
      target: external ? target : resolveRelPath(basePath, target),
      type: rel.getAttribute('Type') || '',
      external,
    });
  });
  return out;
}

/** ppt/charts/chart1.xml → ppt/charts/_rels/chart1.xml.rels */
export function relsPathForPart(partPath: string): string {
  const idx = partPath.lastIndexOf('/');
  const dir = idx >= 0 ? partPath.slice(0, idx) : '';
  const name = idx >= 0 ? partPath.slice(idx + 1) : partPath;
  return `${dir ? dir + '/' : ''}_rels/${name}.rels`;
}

/** ppt/charts/_rels/chart1.xml.rels → ppt/charts/chart1.xml (the described part) */
export function partPathForRels(relsPath: string): string {
  return relsPath.replace(/_rels\//, '').replace(/\.rels$/, '');
}

/**
 * Every relationship id referenced in a part's XML. Matched by value
 * (`rId\d+`), not by attribute prefix, so it survives serializers that rewrite
 * the `r:` namespace prefix (e.g. jsdom → `ns1:`).
 */
export function extractRelIds(xml: string): string[] {
  const ids = new Set<string>();
  for (const m of xml.matchAll(/="(rId\d+)"/g)) ids.add(m[1]);
  return [...ids];
}

/** Classify a graphicFrame by its a:graphicData uri. Pure. */
export function detectGraphicFrameKind(xml: string): PreservedPart['kind'] {
  const uri = xml.match(/<[a-z]*:?graphicData[^>]*\buri="([^"]+)"/i)?.[1] || '';
  if (/diagram/i.test(uri)) return 'diagram';
  if (/chart/i.test(uri)) return 'chart';
  return 'graphicFrame';
}

/**
 * Transitive closure of parts reachable from the seed parts by following their
 * relationships. Pure: `relsFor` and `exists` are synchronous providers.
 */
export function collectTransitiveParts(
  seeds: string[],
  relsFor: (partPath: string) => RelEntry[],
  exists: (path: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    if (!exists(p)) continue;
    out.push(p);
    for (const rel of relsFor(p)) {
      if (rel.external) continue;
      if (!seen.has(rel.target)) queue.push(rel.target);
    }
  }
  return out;
}

/** Raw graphicFrame captured during shape-tree walk, resolved to parts later. */
interface RawGraphicFrame {
  kind: PreservedPart['kind'];
  graphicFrameXml: string;
  relIds: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PlaceholderBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type PlaceholderMap = Map<string, PlaceholderBox>;

function placeholderKey(type: string, idx: string): string {
  return `${type || ''}:${idx || ''}`;
}

function placeholderLookupKeys(type: string, idx: string): string[] {
  const normalizedType = type || '';
  const keys = [
    placeholderKey(normalizedType, idx),
    placeholderKey(normalizedType, ''),
    placeholderKey('', idx),
  ];
  if (normalizedType === 'ctrTitle') keys.push(placeholderKey('title', idx), placeholderKey('title', ''));
  if (normalizedType === 'title') keys.push(placeholderKey('ctrTitle', idx), placeholderKey('ctrTitle', ''));
  if (!normalizedType && idx) keys.push(placeholderKey('body', idx), placeholderKey('body', ''));
  return [...new Set(keys)];
}

function getPlaceholderElement(sp: Element): Element | null {
  const nvSpPr = directChildByLocalName(sp, 'nvSpPr');
  const nvPr = directChildByLocalName(nvSpPr, 'nvPr');
  return directChildByLocalName(nvPr, 'ph') || firstByLocalName(sp, 'ph');
}

function getXfrmBox(sp: Element, slideW: number, slideH: number): PlaceholderBox | null {
  const spPr = directChildByLocalName(sp, 'spPr') || firstByLocalName(sp, 'spPr');
  const xfrm = directChildByLocalName(spPr, 'xfrm') || firstByLocalName(spPr, 'xfrm');
  const off = directChildByLocalName(xfrm, 'off');
  const ext = directChildByLocalName(xfrm, 'ext');
  if (!off || !ext) return null;
  const x = parseInt(off.getAttribute('x') || '0');
  const y = parseInt(off.getAttribute('y') || '0');
  const w = parseInt(ext.getAttribute('cx') || '0');
  const h = parseInt(ext.getAttribute('cy') || '0');
  if (!w || !h) return null;
  return {
    x: (x / slideW) * 100,
    y: (y / slideH) * 100,
    w: (w / slideW) * 100,
    h: (h / slideH) * 100,
  };
}

function parsePlaceholderBoxes(doc: Document, slideW: number, slideH: number): PlaceholderMap {
  const out: PlaceholderMap = new Map();
  const shapeTree = collectByLocalName(doc.documentElement, 'spTree')[0] || doc.documentElement;
  for (const sp of collectByLocalName(shapeTree, 'sp')) {
    const ph = getPlaceholderElement(sp);
    if (!ph) continue;
    const box = getXfrmBox(sp, slideW, slideH);
    if (!box) continue;
    const type = ph.getAttribute('type') || '';
    const idx = ph.getAttribute('idx') || '';
    out.set(placeholderKey(type, idx), box);
    if (type && !out.has(placeholderKey(type, ''))) out.set(placeholderKey(type, ''), box);
    if (idx && !out.has(placeholderKey('', idx))) out.set(placeholderKey('', idx), box);
  }
  return out;
}

function resolvePlaceholderBox(ph: Element, placeholders: PlaceholderMap): PlaceholderBox | null {
  const type = ph.getAttribute('type') || '';
  const idx = ph.getAttribute('idx') || '';
  for (const key of placeholderLookupKeys(type, idx)) {
    const box = placeholders.get(key);
    if (box) return box;
  }
  return null;
}

/** Parse relationship file and return Map<rId, resolvedPath> */
async function parseRels(
  zip: any, relPath: string, basePath: string, parser: DOMParser,
): Promise<Map<string, string>> {
  const relMap = new Map<string, string>();
  const relXml = await zip.file(relPath)?.async('string');
  if (!relXml) return relMap;
  const relDoc = parser.parseFromString(relXml, 'text/xml');
  relDoc.querySelectorAll('Relationship').forEach((rel: Element) => {
    const rId = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (rId && target) {
      relMap.set(rId, resolveRelPath(basePath, target));
    }
  });
  return relMap;
}

/** Try to resolve a background (solid fill or image) from a bg/bgPr element */
function parseBgFromElement(
  bgEl: Element | null, relMap: Map<string, string>, imageMap: Map<string, string>,
  scheme: SchemeResolver,
): { bgColor?: string; bgImage?: string } {
  if (!bgEl) return {};

  const solidFill = collectByLocalName(bgEl, 'solidFill')[0] || null;
  const solidColor = hexFromClrParent(solidFill, scheme);
  if (solidColor) return { bgColor: solidColor };

  const blipFill = collectByLocalName(bgEl, 'blipFill')[0] || null;
  const blip = blipFill ? collectByLocalName(blipFill, 'blip')[0] || null : null;
  if (blip) {
    const rEmbed = blip.getAttribute('r:embed') ||
      blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
    if (rEmbed) {
      const mediaPath = relMap.get(rEmbed);
      if (mediaPath && imageMap.has(mediaPath)) {
        return { bgImage: imageMap.get(mediaPath) };
      }
    }
  }

  const gradFill = collectByLocalName(bgEl, 'gradFill')[0] || null;
  const gsLst = gradFill ? collectByLocalName(gradFill, 'gsLst')[0] || null : null;
  if (gsLst) {
    const firstGs = collectByLocalName(gsLst, 'gs')[0] || null;
    const gradColor = hexFromClrParent(firstGs, scheme);
    if (gradColor) return { bgColor: gradColor };
  }

  return {};
}

/** Recursively parse shape tree (handles grpSp) */
function parseShapeTree(
  parent: Element, slide: Slide,
  relMap: Map<string, string>, imageMap: Map<string, string>,
  slideW: number, slideH: number,
  scheme: SchemeResolver, flags: { hasUnsupportedContent: boolean },
  preservedOut: RawGraphicFrame[],
  placeholders: PlaceholderMap = new Map(),
  groupOffsetX = 0, groupOffsetY = 0,
  groupScaleX = 1, groupScaleY = 1,
  styleCtx?: StyleContext,
) {
  const children = parent.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const tag = node.tagName.split(':').pop() || node.tagName;

    if (tag === 'grpSp') {
      const xfrm = directPathByLocalName(node, ['grpSpPr', 'xfrm']);
      const grpOff = directChildByLocalName(xfrm, 'off');
      const grpExt = directChildByLocalName(xfrm, 'ext');
      const chOff = directChildByLocalName(xfrm, 'chOff');
      const chExt = directChildByLocalName(xfrm, 'chExt');

      const gx = parseInt(grpOff?.getAttribute('x') || '0');
      const gy = parseInt(grpOff?.getAttribute('y') || '0');
      const gw = parseInt(grpExt?.getAttribute('cx') || '0');
      const gh = parseInt(grpExt?.getAttribute('cy') || '0');
      const cx = parseInt(chOff?.getAttribute('x') || '0');
      const cy = parseInt(chOff?.getAttribute('y') || '0');
      const cw = parseInt(chExt?.getAttribute('cx') || '1');
      const ch = parseInt(chExt?.getAttribute('cy') || '1');

      const scaleX = gw / (cw || 1);
      const scaleY = gh / (ch || 1);
      const offX = gx - cx * scaleX;
      const offY = gy - cy * scaleY;

      parseShapeTree(
        node, slide, relMap, imageMap, slideW, slideH, scheme, flags, preservedOut,
        placeholders,
        groupOffsetX + offX * groupScaleX,
        groupOffsetY + offY * groupScaleY,
        groupScaleX * scaleX,
        groupScaleY * scaleY,
        styleCtx,
      );
      continue;
    }

    // Tables live inside a graphicFrame → a:graphic → a:graphicData → a:tbl
    if (tag === 'graphicFrame') {
      const tbl = node.querySelector('tbl') ||
        Array.from(node.querySelectorAll('*')).find(
          (c) => (c.tagName.split(':').pop() || c.tagName) === 'tbl',
        ) || null;
      const gfXfrm = localChildren(node, 'xfrm')[0] || null;
      const gfOff = gfXfrm ? localChildren(gfXfrm, 'off')[0] : null;
      const gfExt = gfXfrm ? localChildren(gfXfrm, 'ext')[0] : null;
      const gOffX = parseInt(gfOff?.getAttribute('x') || '0');
      const gOffY = parseInt(gfOff?.getAttribute('y') || '0');
      const gExtCx = parseInt(gfExt?.getAttribute('cx') || '0');
      const gExtCy = parseInt(gfExt?.getAttribute('cy') || '0');

      const gAbsX = groupOffsetX + gOffX * groupScaleX;
      const gAbsY = groupOffsetY + gOffY * groupScaleY;
      const gAbsW = gExtCx * groupScaleX;
      const gAbsH = gExtCy * groupScaleY;

      // Non-table graphicFrames (charts, SmartArt/diagrams, OLE) can't be rendered
      // natively — capture their XML + referenced parts verbatim for lossless
      // round-trip, and flag so save still falls back to a copy (not in-place).
      if (!tbl) {
        flags.hasUnsupportedContent = true;
        const graphicFrameXml = new XMLSerializer().serializeToString(node);
        preservedOut.push({
          kind: detectGraphicFrameKind(graphicFrameXml),
          graphicFrameXml,
          relIds: extractRelIds(graphicFrameXml),
          x: (gAbsX / slideW) * 100,
          y: (gAbsY / slideH) * 100,
          w: gAbsW > 0 ? (gAbsW / slideW) * 100 : 40,
          h: gAbsH > 0 ? (gAbsH / slideH) * 100 : 30,
        });
        continue;
      }

      const table = parseTable(tbl, scheme);
      if (table) {
        slide.elements.push({
          id: uid(), type: 'table',
          x: (gAbsX / slideW) * 100,
          y: (gAbsY / slideH) * 100,
          w: gAbsW > 0 ? (gAbsW / slideW) * 100 : 60,
          h: gAbsH > 0 ? (gAbsH / slideH) * 100 : 30,
          table,
        });
      }
      continue;
    }

    if (tag !== 'sp' && tag !== 'pic') continue;

    const directXfrm = directPathByLocalName(node, ['spPr', 'xfrm']);
    const fallbackXfrm = firstByLocalName(directChildByLocalName(node, 'spPr'), 'xfrm');
    const shapeXfrm = directXfrm || fallbackXfrm;
    const off = directChildByLocalName(shapeXfrm, 'off');
    const ext = directChildByLocalName(shapeXfrm, 'ext');
    const offX = parseInt(off?.getAttribute('x') || '0');
    const offY = parseInt(off?.getAttribute('y') || '0');
    const extCx = parseInt(ext?.getAttribute('cx') || '0');
    const extCy = parseInt(ext?.getAttribute('cy') || '0');

    const hasXfrm = off != null || ext != null;

    const absX = groupOffsetX + offX * groupScaleX;
    const absY = groupOffsetY + offY * groupScaleY;
    const absW = extCx * groupScaleX;
    const absH = extCy * groupScaleY;

    let x = (absX / slideW) * 100;
    let y = (absY / slideH) * 100;
    let w = (absW / slideW) * 100;
    let h = (absH / slideH) * 100;

    const phEl = tag === 'sp' ? getPlaceholderElement(node) : null;

    // Placeholder shapes (title, body, etc.) may lack xfrm — assign defaults
    if (!hasXfrm && tag === 'sp') {
      const ph = phEl;
      const phType = ph?.getAttribute('type') || '';
      const phIdx = ph?.getAttribute('idx') || '';
      if (ph) {
        const inherited = resolvePlaceholderBox(ph, placeholders);
        if (inherited) {
          x = inherited.x; y = inherited.y; w = inherited.w; h = inherited.h;
        } else if (phType === 'title' || phType === 'ctrTitle') {
          x = 5; y = 5; w = 90; h = 18;
        } else if (phType === 'subTitle') {
          x = 10; y = 28; w = 80; h = 20;
        } else if (phType === 'body' || phType === '' && phIdx) {
          x = 5; y = 28; w = 90; h = 62;
        } else if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr') {
          x = phType === 'sldNum' ? 80 : phType === 'dt' ? 2 : 35;
          y = 95; w = 18; h = 4;
        } else {
          x = 5; y = 10; w = 90; h = 30;
        }
      } else if (w === 0 && h === 0) {
        // Non-placeholder shape with no size — skip it
        continue;
      }
    }

    // Parse rotation (in 60000ths of a degree)
    const rotAttr = shapeXfrm?.getAttribute('rot');
    const rotation = rotAttr ? parseInt(rotAttr) / 60000 : undefined;

    if (tag === 'pic') {
      const blipFillEl = collectByLocalName(node, 'blipFill')[0] || null;
      const blipFill = blipFillEl ? collectByLocalName(blipFillEl, 'blip')[0] || null : null;
      const rEmbed = blipFill?.getAttribute('r:embed') ||
        blipFill?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      let imageSrc = '';
      if (rEmbed) {
        const mediaPath = relMap.get(rEmbed);
        if (mediaPath && imageMap.has(mediaPath)) {
          imageSrc = imageMap.get(mediaPath)!;
        }
      }
      slide.elements.push({ id: uid(), type: 'image', x, y, w, h, imageSrc, rotation });
    } else if (tag === 'sp') {
      let txBody = node.querySelector('txBody');
      if (!txBody) {
        // Fallback: find child element whose local name is 'txBody'
        txBody = Array.from(node.children).find(
          (c) => (c.tagName.split(':').pop() || c.tagName) === 'txBody',
        ) || null;
      }
      const spPr = directChildByLocalName(node, 'spPr');
      const prst = spPr ? collectByLocalName(spPr, 'prstGeom')[0] || null : null;
      const prstType = prst?.getAttribute('prst') || '';

      const spPrSolidFill = spPr ? directChildByLocalName(spPr, 'solidFill') : null;
      const noFill = spPr ? directChildByLocalName(spPr, 'noFill') : null;
      let fillColor = hexFromClrParent(spPrSolidFill, scheme) || '';
      if (!fillColor && spPr) {
        // Gradient fill: approximate with the first stop so the shape isn't bare
        const gradFill = directChildByLocalName(spPr, 'gradFill');
        const firstGs = gradFill ? firstByLocalName(gradFill, 'gs') : null;
        fillColor = hexFromClrParent(firstGs, scheme) || '';
      }

      // Border (outline)
      const lnEl = spPr ? directChildByLocalName(spPr, 'ln') : null;
      let borderColor: string | undefined;
      let borderWidth: number | undefined;
      if (lnEl) {
        const lnW = lnEl.getAttribute('w');
        if (lnW) borderWidth = parseInt(lnW) / 12700; // EMU to pt
        const lnColor = hexFromClrParent(collectByLocalName(lnEl, 'solidFill')[0] || null, scheme);
        if (lnColor) borderColor = lnColor;
      }

      // Fill image (picture fill on shapes)
      let fillImage = '';
      const shapeBlipFill = spPr ? collectByLocalName(spPr, 'blipFill')[0] || null : null;
      const shapePicFill = shapeBlipFill ? collectByLocalName(shapeBlipFill, 'blip')[0] || null : null;
      if (shapePicFill) {
        const rEmbed = shapePicFill.getAttribute('r:embed') ||
          shapePicFill.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
        if (rEmbed) {
          const mediaPath = relMap.get(rEmbed);
          if (mediaPath && imageMap.has(mediaPath)) fillImage = imageMap.get(mediaPath)!;
        }
      }

      if (fillImage) {
        slide.elements.push({ id: uid(), type: 'image', x, y, w, h, imageSrc: fillImage, rotation });
        continue;
      }

      // Text content — start from what the placeholder inherits (layout/master
      // lstStyle + master txStyles) so a run without explicit rPr still renders
      // at PowerPoint's effective size/color/font instead of a hardcoded default.
      const inheritedStyle = phEl && styleCtx
        ? styleCtx.phStyle(phEl.getAttribute('type') || '', phEl.getAttribute('idx') || '')
        : undefined;
      let textContent = '';
      let fontSize = inheritedStyle?.fontSize ?? 18;
      let fontColor = inheritedStyle?.fontColor ?? '#000000';
      let bold = inheritedStyle?.bold ?? false;
      let italic = false;
      let underline = false;
      let strikethrough = false;
      // Non-placeholder text defaults to the theme minor font, like PowerPoint
      let fontFamily = inheritedStyle?.fontFamily ?? styleCtx?.fonts('+mn-lt');
      let textAlign = inheritedStyle?.textAlign;
      let verticalAlign = inheritedStyle?.verticalAlign;
      let bulletParas = 0;
      let numberParas = 0;
      // Mixed-run shapes collapse to one style — first explicit value wins, so a
      // trailing footnote-sized run can't restyle the whole title.
      let sizeSeen = false;
      let colorSeen = false;
      let familySeen = false;
      let alignSeen = false;
      let autofitScale = 1;

      // PowerPoint text insets (EMU; defaults 0.1in sides, 0.05in top/bottom) —
      // wrap points only match MS when the same padding eats into the box.
      let insetPt = { l: 7.2, t: 3.6, r: 7.2, b: 3.6 };
      if (txBody) {
        const bodyPr = directChildByLocalName(txBody, 'bodyPr');
        const anchor = bodyPr?.getAttribute('anchor');
        if (anchor && ANCHOR_MAP[anchor]) verticalAlign = ANCHOR_MAP[anchor];
        if (bodyPr) {
          const insEmu = (attr: string, fallback: number) => {
            const v = bodyPr.getAttribute(attr);
            return v ? parseInt(v) / 12700 : fallback;
          };
          insetPt = {
            l: insEmu('lIns', 7.2), t: insEmu('tIns', 3.6),
            r: insEmu('rIns', 7.2), b: insEmu('bIns', 3.6),
          };
        }
        // PowerPoint shrank this text to fit its box — mirror the final scale
        const fontScaleAttr = bodyPr
          ? directChildByLocalName(bodyPr, 'normAutofit')?.getAttribute('fontScale')
          : null;
        if (fontScaleAttr) autofitScale = parseInt(fontScaleAttr) / 100000 || 1;

        const applyRunProps = (rPr: Element | null, isExplicit: boolean) => {
          if (!rPr) return;
          const sz = rPr.getAttribute('sz');
          if (sz && !sizeSeen) { fontSize = parseInt(sz) / 100; sizeSeen = isExplicit; }
          if (rPr.getAttribute('b') === '1') bold = true;
          if (rPr.getAttribute('i') === '1') italic = true;
          const u = rPr.getAttribute('u');
          if (u && u !== 'none') underline = true;
          const strike = rPr.getAttribute('strike');
          if (strike && strike !== 'noStrike') strikethrough = true;
          const runColor = hexFromClrParent(directChildByLocalName(rPr, 'solidFill'), scheme);
          if (runColor && !colorSeen) { fontColor = runColor; colorSeen = isExplicit; }
          const family = styleCtx?.fonts(
            directChildByLocalName(rPr, 'latin')?.getAttribute('typeface'),
          );
          if (family && !familySeen) { fontFamily = family; familySeen = isExplicit; }
        };

        const paraTexts: string[] = [];
        for (const p of localChildren(txBody, 'p')) {
          let paraText = '';
          const pPr = directChildByLocalName(p, 'pPr');
          if (pPr) {
            const algn = pPr.getAttribute('algn');
            if (algn && ALGN_MAP[algn] && !alignSeen) { textAlign = ALGN_MAP[algn]; alignSeen = true; }
            const kids = Array.from(pPr.children).map((c) => c.tagName.split(':').pop() || c.tagName);
            if (kids.includes('buChar')) bulletParas += 1;
            else if (kids.includes('buAutoNum')) numberParas += 1;
          }
          // Walk children in document order so <a:br/> line breaks land between
          // the right runs, and field (<a:fld>) text stays in place.
          for (const child of Array.from(p.children)) {
            const cn = child.tagName.split(':').pop() || child.tagName;
            if (cn === 'br') { paraText += '\n'; continue; }
            if (cn !== 'r' && cn !== 'fld') continue;
            const t = directChildByLocalName(child, 't');
            if (t) paraText += t.textContent || '';
            applyRunProps(directChildByLocalName(child, 'rPr'), true);
          }
          // Paragraph-level defaults cover runs that carry no rPr of their own
          if (pPr) applyRunProps(directChildByLocalName(pPr, 'defRPr'), false);
          paraTexts.push(paraText);
        }
        textContent = paraTexts.join('\n');

        // Final fallback: if no text found via runs, use raw textContent
        if (!textContent.trim() && txBody.textContent) {
          textContent = txBody.textContent.trim();
        }
      }
      if (autofitScale !== 1) fontSize = Math.round(fontSize * autofitScale * 10) / 10;

      const baseProps: Partial<SlideElement> = { rotation, borderColor, borderWidth };
      // OOXML defaults are left/top when nothing in the chain says otherwise —
      // set them explicitly so the renderer's app defaults (centered shape text)
      // don't restyle parsed files away from how PowerPoint shows them.
      const textProps: Partial<SlideElement> = {
        fontSize, fontColor, bold, italic, underline, strikethrough,
        ...(fontFamily ? { fontFamily } : {}),
        textAlign: textAlign ?? 'left',
        verticalAlign: verticalAlign ?? 'top',
        insetPt,
      };

      if (prstType === 'ellipse') {
        slide.elements.push({
          id: uid(), type: 'circle', x, y, w, h,
          fillColor: fillColor || (noFill ? 'transparent' : '#4a90d9'),
          text: textContent || undefined, ...textProps,
          ...baseProps,
        });
      } else if (prstType === 'triangle' || prstType === 'rtTriangle') {
        slide.elements.push({
          id: uid(), type: 'triangle', x, y, w, h,
          fillColor: fillColor || '#4a90d9',
          text: textContent || undefined, ...textProps,
          ...baseProps,
        });
      } else if (prstType === 'star5' || prstType === 'star4' || prstType === 'star6') {
        slide.elements.push({
          id: uid(), type: 'star', x, y, w, h,
          fillColor: fillColor || '#f5a623',
          text: textContent || undefined, ...textProps,
          ...baseProps,
        });
      } else if (prstType === 'rightArrow' || prstType === 'leftArrow' || prstType === 'upArrow' || prstType === 'downArrow') {
        slide.elements.push({
          id: uid(), type: 'arrow', x, y, w, h,
          fillColor: fillColor || '#4a90d9',
          ...baseProps,
        });
      } else if (prstType === 'line' || prstType === 'straightConnector1') {
        slide.elements.push({
          id: uid(), type: 'line', x, y, w, h,
          borderColor: borderColor || fillColor || '#000000',
          borderWidth: borderWidth || 2,
          ...baseProps,
        });
      } else if (prstType && prstType !== '') {
        // rect/roundRect and every other preset shape: keep the fill even when
        // the shape has text — MS renders "chevron with label" as shape + text,
        // not as a bare label.
        slide.elements.push({
          id: uid(), type: 'rect', x, y, w, h,
          fillColor: fillColor || (noFill ? 'transparent' : '#4a90d9'),
          text: textContent || undefined, ...textProps,
          ...baseProps,
        });
      } else if (textContent) {
        const listStyle = bulletParas > 0 && bulletParas >= numberParas
          ? 'bullet' as const
          : numberParas > 0 ? 'number' as const : undefined;
        slide.elements.push({
          id: uid(), type: 'text', x, y, w, h,
          text: textContent, ...textProps,
          ...(listStyle ? { listStyle } : {}),
          ...baseProps,
        });
      }
    }
  }
}

/** Parse a PPTX file from base64 data URL */
export async function parsePptxFromBase64(dataUrl: string): Promise<ParsedPptx> {
  try {
    const JSZip = (await import('jszip')).default;
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const zip = await JSZip.loadAsync(base64, { base64: true });
    const parser = new DOMParser();
    const EMU_PER_INCH = 914400;

    // Read actual slide size from presentation.xml
    let slideSize: SlideSize = { ...DEFAULT_SLIDE_SIZE };
    try {
      const presXml = await zip.file('ppt/presentation.xml')?.async('string');
      if (presXml) {
        const presDoc = parser.parseFromString(presXml, 'text/xml');
        const sldSz = presDoc.querySelector('sldSz');
        if (sldSz) {
          const cx = parseInt(sldSz.getAttribute('cx') || '0');
          const cy = parseInt(sldSz.getAttribute('cy') || '0');
          if (cx > 0 && cy > 0) {
            slideSize = {
              widthEmu: cx,
              heightEmu: cy,
              widthInch: cx / EMU_PER_INCH,
              heightInch: cy / EMU_PER_INCH,
              aspectRatio: cx / cy,
            };
          }
        }
      }
    } catch { /* use default */ }

    const SLIDE_W_EMU = slideSize.widthEmu;
    const SLIDE_H_EMU = slideSize.heightEmu;

    // Collect all media files as base64 data URLs
    const imageMap = new Map<string, string>();
    const mediaFiles: string[] = [];
    zip.forEach((path: string) => {
      if (path.startsWith('ppt/media/')) mediaFiles.push(path);
    });
    for (const mf of mediaFiles) {
      try {
        const data = await zip.file(mf)?.async('base64');
        if (data) {
          const ext = mf.split('.').pop()?.toLowerCase() || 'png';
          const mimeMap: Record<string, string> = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
            tiff: 'image/tiff', tif: 'image/tiff', emf: 'image/emf', wmf: 'image/wmf',
          };
          const mime = mimeMap[ext] || 'image/png';
          imageMap.set(mf, `data:${mime};base64,${data}`);
        }
      } catch { /* skip */ }
    }

    // Parse slide master/layout backgrounds for fallback
    const masterBgMap = new Map<string, { bgColor?: string; bgImage?: string }>();
    const masterPlaceholderMap = new Map<string, PlaceholderMap>();
    const masterFiles: string[] = [];
    zip.forEach((path: string) => {
      if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(path)) masterFiles.push(path);
    });

    // Build a schemeClr → hex resolver from theme1.xml + the first master's clrMap,
    // and a theme font resolver (+mj-lt/+mn-lt → concrete font stacks)
    let scheme: SchemeResolver = () => undefined;
    let fonts: FontResolver = () => undefined;
    try {
      const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string');
      const themeDoc = themeXml ? parser.parseFromString(themeXml, 'text/xml') : null;
      let clrMapEl: Element | null = null;
      if (masterFiles.length > 0) {
        const mXml = await zip.file(masterFiles[0])?.async('string');
        if (mXml) {
          const mDoc = parser.parseFromString(mXml, 'text/xml');
          clrMapEl = mDoc.querySelector('clrMap') ||
            collectByLocalName(mDoc.documentElement, 'clrMap')[0] || null;
        }
      }
      scheme = buildSchemeResolver(themeDoc, clrMapEl);
      fonts = buildFontResolver(themeDoc);
    } catch { /* no theme colors */ }

    const masterTxStylesMap = new Map<string, MasterTextStyles>();
    const masterPhStyleMap = new Map<string, Map<string, InheritedTextStyle>>();
    for (const mf of masterFiles) {
      try {
        const xml = await zip.file(mf)?.async('string');
        if (!xml) continue;
        const doc = parser.parseFromString(xml, 'text/xml');
        const num = mf.match(/slideMaster(\d+)/i)?.[1] || '1';
        const relPath = `ppt/slideMasters/_rels/slideMaster${num}.xml.rels`;
        const masterRelMap = await parseRels(zip, relPath, mf, parser);
        masterPlaceholderMap.set(mf, parsePlaceholderBoxes(doc, SLIDE_W_EMU, SLIDE_H_EMU));
        masterTxStylesMap.set(mf, parseMasterTextStyles(doc, scheme, fonts));
        masterPhStyleMap.set(mf, parsePlaceholderTextStyles(doc, scheme, fonts));
        const bg = directPathByLocalName(doc.documentElement, ['cSld', 'bg']);
        if (bg) {
          masterBgMap.set(mf, parseBgFromElement(bg, masterRelMap, imageMap, scheme));
        }
      } catch { /* skip */ }
    }

    const layoutBgMap = new Map<string, { bgColor?: string; bgImage?: string }>();
    const layoutMasterMap = new Map<string, string>();
    const layoutPlaceholderMap = new Map<string, PlaceholderMap>();
    const layoutPhStyleMap = new Map<string, Map<string, InheritedTextStyle>>();
    const layoutFiles: string[] = [];
    zip.forEach((path: string) => {
      if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(path)) layoutFiles.push(path);
    });
    for (const lf of layoutFiles) {
      try {
        const xml = await zip.file(lf)?.async('string');
        if (!xml) continue;
        const doc = parser.parseFromString(xml, 'text/xml');
        const num = lf.match(/slideLayout(\d+)/i)?.[1] || '1';
        const relPath = `ppt/slideLayouts/_rels/slideLayout${num}.xml.rels`;
        const layoutRelMap = await parseRels(zip, relPath, lf, parser);

        layoutRelMap.forEach((target) => {
          if (target.includes('slideMaster')) layoutMasterMap.set(lf, target);
        });

        const masterPath = layoutMasterMap.get(lf);
        const inherited = masterPath ? masterPlaceholderMap.get(masterPath) : undefined;
        const layoutPlaceholders = parsePlaceholderBoxes(doc, SLIDE_W_EMU, SLIDE_H_EMU);
        layoutPlaceholderMap.set(lf, new Map([...(inherited || new Map()), ...layoutPlaceholders]));
        layoutPhStyleMap.set(lf, parsePlaceholderTextStyles(doc, scheme, fonts));

        const bg = directPathByLocalName(doc.documentElement, ['cSld', 'bg']);
        if (bg) {
          layoutBgMap.set(lf, parseBgFromElement(bg, layoutRelMap, imageMap, scheme));
        }
      } catch { /* skip */ }
    }

    // Preload package metadata for preserving opaque graphicFrames (charts/diagrams):
    // every part path, every .rels (resolved), and content types by part/extension.
    const allPaths = new Set<string>();
    const relsFilePaths: string[] = [];
    zip.forEach((path: string) => {
      allPaths.add(path);
      if (/\.rels$/i.test(path)) relsFilePaths.push(path);
    });
    const relsByPart = new Map<string, RelEntry[]>();
    for (const rp of relsFilePaths) {
      const xml = await zip.file(rp)?.async('string');
      if (xml) relsByPart.set(partPathForRels(rp), parseRelEntries(xml, partPathForRels(rp)));
    }
    const ctOverrides = new Map<string, string>(); // '/ppt/charts/chart1.xml' → contentType
    const ctDefaults = new Map<string, string>();   // 'xlsx' → contentType
    try {
      const ctXml = await zip.file('[Content_Types].xml')?.async('string');
      if (ctXml) {
        const ctDoc = parser.parseFromString(ctXml, 'text/xml');
        ctDoc.querySelectorAll('Override').forEach((o: Element) => {
          const part = o.getAttribute('PartName');
          const type = o.getAttribute('ContentType');
          if (part && type) ctOverrides.set(part, type);
        });
        ctDoc.querySelectorAll('Default').forEach((d: Element) => {
          const ext = d.getAttribute('Extension');
          const type = d.getAttribute('ContentType');
          if (ext && type) ctDefaults.set(ext.toLowerCase(), type);
        });
      }
    } catch { /* content types stay empty */ }

    const contentTypeFor = (path: string): string | undefined => {
      const override = ctOverrides.get('/' + path);
      if (override) return override;
      const ext = path.split('.').pop()?.toLowerCase() || '';
      return ctDefaults.get(ext);
    };
    const relsFor = (partPath: string): RelEntry[] => relsByPart.get(partPath) || [];
    const exists = (path: string) => allPaths.has(path);

    // Resolve a captured graphicFrame into a PreservedPart: gather every referenced
    // part (transitively) plus its .rels, encode them, and record slide relationships.
    const buildPreservedPart = async (
      raw: RawGraphicFrame, slidePath: string,
    ): Promise<PreservedPart> => {
      const slideRelEntries = relsFor(slidePath);
      const byId = new Map(slideRelEntries.map((e) => [e.id, e]));
      const rels: PreservedRel[] = [];
      const seeds: string[] = [];
      for (const id of raw.relIds) {
        const e = byId.get(id);
        if (!e || e.external || !exists(e.target)) continue;
        rels.push({ id, target: e.target, type: e.type });
        seeds.push(e.target);
      }
      const partPaths = collectTransitiveParts(seeds, relsFor, exists);
      const storePaths = new Set<string>();
      for (const p of partPaths) {
        storePaths.add(p);
        const rp = relsPathForPart(p);
        if (exists(rp)) storePaths.add(rp);
      }
      const parts: PreservedFile[] = [];
      for (const p of storePaths) {
        const base64 = await zip.file(p)?.async('base64');
        if (base64 != null) parts.push({ path: p, base64, contentType: contentTypeFor(p) });
      }
      return { kind: raw.kind, graphicFrameXml: raw.graphicFrameXml, parts, rels, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
    };

    // Find slide files
    const slideFiles: string[] = [];
    zip.forEach((path: string) => {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(path)) slideFiles.push(path);
    });
    slideFiles.sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/i)?.[1] || '0');
      const nb = parseInt(b.match(/slide(\d+)/i)?.[1] || '0');
      return na - nb;
    });

    if (slideFiles.length === 0) return { slides: [createBlankSlide()], slideSize };

    // Parse each slide
    const slides: Slide[] = [];
    const flags = { hasUnsupportedContent: false };

    for (const sf of slideFiles) {
      const xmlStr = await zip.file(sf)?.async('string');
      if (!xmlStr) { slides.push(createBlankSlide()); continue; }

      const doc = parser.parseFromString(xmlStr, 'text/xml');
      const slide: Slide = { id: uid(), bgColor: '#ffffff', bgImage: undefined, elements: [] };

      const slideNum = sf.match(/slide(\d+)/i)?.[1] || '1';
      const relPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const slideRelMap = await parseRels(zip, relPath, sf, parser);

      // Hidden slide (p:sld show="0")
      if (doc.documentElement.getAttribute('show') === '0') slide.hidden = true;

      // Transitions/timing can't round-trip cleanly — flag so save falls back to a copy
      const hasLocal = (name: string) => collectByLocalName(doc.documentElement, name).length > 0;
      if (hasLocal('transition') || hasLocal('timing')) flags.hasUnsupportedContent = true;

      // Speaker notes: follow the slide rels to the notesSlide part and read the body text
      let notesPath = '';
      slideRelMap.forEach((target) => { if (target.includes('notesSlide')) notesPath = target; });
      if (notesPath) {
        const notesXml = await zip.file(notesPath)?.async('string');
        if (notesXml) {
          const notesDoc = parser.parseFromString(notesXml, 'text/xml');
          const noteTexts: string[] = [];
          for (const sp of collectByLocalName(notesDoc.documentElement, 'sp')) {
            const ph = collectByLocalName(sp, 'ph')[0];
            if (ph?.getAttribute('type') !== 'body') continue; // skip slide-image / number / date placeholders
            const txBody = collectByLocalName(sp, 'txBody')[0];
            if (!txBody) continue;
            for (const p of localChildren(txBody, 'p')) {
              noteTexts.push(localChildren(p, 'r').map((r) => localChildren(r, 't')[0]?.textContent || '').join(''));
            }
          }
          const notes = noteTexts.join('\n').trim();
          if (notes) slide.notes = notes;
        }
      }

      // Resolve background: slide → layout → master
      let layoutPath = '';
      slideRelMap.forEach((target) => {
        if (target.includes('slideLayout')) layoutPath = target;
      });

      const bg = directPathByLocalName(doc.documentElement, ['cSld', 'bg']);
      if (bg) {
        const bgResult = parseBgFromElement(bg, slideRelMap, imageMap, scheme);
        if (bgResult.bgImage) slide.bgImage = bgResult.bgImage;
        if (bgResult.bgColor) slide.bgColor = bgResult.bgColor;
      } else {
        let resolved = false;
        if (layoutPath) {
          const layoutBg = layoutBgMap.get(layoutPath);
          if (layoutBg && (layoutBg.bgColor || layoutBg.bgImage)) {
            if (layoutBg.bgImage) slide.bgImage = layoutBg.bgImage;
            if (layoutBg.bgColor) slide.bgColor = layoutBg.bgColor;
            resolved = true;
          }

          if (!resolved) {
            const masterPath = layoutMasterMap.get(layoutPath);
            if (masterPath) {
              const masterBg = masterBgMap.get(masterPath);
              if (masterBg) {
                if (masterBg.bgImage) slide.bgImage = masterBg.bgImage;
                if (masterBg.bgColor) slide.bgColor = masterBg.bgColor;
              }
            }
          }
        }
      }

      // Parse shapes — try CSS selector first, then fallback for namespaced elements
      let spTree = directPathByLocalName(doc.documentElement, ['cSld', 'spTree']);
      if (!spTree) {
        // Fallback: walk children to find spTree by local name
        const cSld = Array.from(doc.documentElement.children).find(
          (c) => (c.tagName.split(':').pop() || c.tagName) === 'cSld',
        );
        if (cSld) {
          spTree = Array.from(cSld.children).find(
            (c) => (c.tagName.split(':').pop() || c.tagName) === 'spTree',
          ) || null;
        }
      }
      const rawFrames: RawGraphicFrame[] = [];
      if (spTree) {
        // Inherited text styling for this slide's placeholders:
        // master txStyles → master placeholder sp → layout placeholder sp
        const masterPath = layoutPath ? layoutMasterMap.get(layoutPath) : undefined;
        const masterStyles = masterPath ? masterTxStylesMap.get(masterPath) : undefined;
        const masterPhStyles = masterPath ? masterPhStyleMap.get(masterPath) : undefined;
        const layoutPhStyles = layoutPath ? layoutPhStyleMap.get(layoutPath) : undefined;
        const styleCtx: StyleContext = {
          fonts,
          phStyle: (type, idx) => {
            const merged: InheritedTextStyle = {
              ...(masterStyles ? masterStyles[masterBucketFor(type)] : {}),
            };
            for (const source of [masterPhStyles, layoutPhStyles]) {
              if (!source) continue;
              for (const key of placeholderLookupKeys(type, idx)) {
                const hit = source.get(key);
                if (hit) { Object.assign(merged, hit); break; }
              }
            }
            return merged;
          },
        };
        parseShapeTree(
          spTree, slide, slideRelMap, imageMap, SLIDE_W_EMU, SLIDE_H_EMU,
          scheme, flags, rawFrames, layoutPath ? layoutPlaceholderMap.get(layoutPath) : undefined,
          0, 0, 1, 1, styleCtx,
        );
      }
      if (rawFrames.length > 0) {
        const preserved: PreservedPart[] = [];
        for (const raw of rawFrames) preserved.push(await buildPreservedPart(raw, sf));
        slide.preserved = preserved;
      }

      slides.push(slide);
    }

    return {
      slides: slides.length > 0 ? slides : [createBlankSlide()],
      slideSize,
      hasUnsupportedContent: flags.hasUnsupportedContent || undefined,
    };
  } catch (err) {
    console.warn('[PptxEditor] Failed to parse PPTX, starting with blank slide:', err);
    // Flag the failure so PptxEditor blocks in-place overwrite of the original file.
    return { slides: [createBlankSlide()], slideSize: { ...DEFAULT_SLIDE_SIZE }, parseError: true };
  }
}
