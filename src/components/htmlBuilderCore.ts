/**
 * htmlBuilderCore.ts
 *
 * Pure DOM helpers for the HTML builder canvas: stable element paths that
 * survive serialize→rewrite cycles, layer-tree construction for the layers
 * panel, and small CSS value utilities used by the inspector.
 */

import { cleanBuilderMarkup } from './htmlBuilderBlocks';

/** Leading `<!DOCTYPE ...>` of an HTML string ('' when absent). */
export function extractDoctypeFrom(html: string): string {
  const match = html.match(/^\s*<!doctype[^>]*>/i);
  return match ? match[0].trim() : '';
}

/**
 * Serialize a builder iframe document to clean HTML: builder artifacts are
 * stripped from a clone (the live document keeps its markers) and the
 * original doctype is re-attached (outerHTML always drops it).
 */
export function serializeCleanHtml(doc: Document, doctype: string): string {
  const clone = doc.documentElement.cloneNode(true) as Element;
  cleanBuilderMarkup(clone);
  return doctype ? `${doctype}\n${clone.outerHTML}` : clone.outerHTML;
}

/** Index path of `el` among element children, walking down from `root`. */
export function getElementPath(el: Element, root: Element): number[] {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return cur === root ? path : [];
}

/** Walk an index path down from `root`; null when the path no longer exists. */
export function resolveElementPath(root: Element, path: number[]): Element | null {
  let cur: Element = root;
  for (const idx of path) {
    const next = cur.children[idx];
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/** Short human name for the layers tree and the selection label. */
export function elementDisplayName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)[0];
  return cls ? `${tag}.${cls}` : tag;
}

export interface LayerNode {
  name: string;
  tag: string;
  path: number[];
  children: LayerNode[];
}

/** Element tree under `root` (usually <body>) for the layers panel. */
export function buildLayerTree(root: Element, maxDepth = 8): LayerNode[] {
  const walk = (el: Element, base: number[], depth: number): LayerNode => ({
    name: elementDisplayName(el),
    tag: el.tagName.toLowerCase(),
    path: base,
    children: depth >= maxDepth
      ? []
      : Array.from(el.children).map((child, i) => walk(child, [...base, i], depth + 1)),
  });
  return Array.from(root.children).map((child, i) => walk(child, [i], 1));
}

/**
 * Convert any CSS color the browser reports (rgb/rgba/hex/keyword-resolved)
 * to a #rrggbb hex for <input type="color">. Returns fallback when the value
 * can't be parsed (e.g. gradients, 'transparent' alpha 0).
 */
export function cssColorToHex(value: string, fallback = '#000000'): string {
  const v = (value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!m) return fallback;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return fallback;
  const hex = (n: string) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/** "12px" → 12; anything unparseable → null. Used for numeric steppers. */
export function pxToNumber(value: string): number | null {
  const m = (value || '').trim().match(/^(-?[\d.]+)px$/);
  return m ? parseFloat(m[1]) : null;
}

const BLOCK_LEVEL_TAGS = new Set([
  'div', 'section', 'main', 'article', 'aside', 'header', 'footer', 'nav', 'form',
  'ul', 'ol', 'table', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'hr', 'pre', 'figure',
]);

/** True when the element only contains text/inline markup worth dblclick-editing. */
export function isTextEditable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['img', 'hr', 'br', 'input', 'textarea', 'select', 'iframe', 'svg', 'video', 'audio'].includes(tag)) {
    return false;
  }
  // Editing a subtree with block-level structure via contentEditable mangles
  // it too easily — those are edited per-leaf or through the inspector.
  for (const child of Array.from(el.children)) {
    if (BLOCK_LEVEL_TAGS.has(child.tagName.toLowerCase())) return false;
  }
  return true;
}

const DROP_CONTAINER_TAGS = new Set(['div', 'section', 'main', 'article', 'aside', 'header', 'footer', 'nav', 'form']);

/** True when a drag can drop INTO this element (empty structural container). */
export function isDropContainer(el: Element): boolean {
  return DROP_CONTAINER_TAGS.has(el.tagName.toLowerCase()) && el.children.length === 0;
}
