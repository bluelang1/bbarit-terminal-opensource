/**
 * htmlBuilderBridge.ts
 *
 * Editor-bridge command handlers for the HTML builder ("terminal builder"):
 * pure string→string transforms so the terminal agent can build pages with
 * the same block library and element model as the visual builder. Used by the
 * App.tsx editor bridge for `html.*` commands (scripts/editor-control.mjs).
 */

import { BUILDER_BLOCK_CATEGORIES, EMPTY_PAGE_HTML } from './htmlBuilderBlocks';
import { buildLayerTree, extractDoctypeFrom, resolveElementPath } from './htmlBuilderCore';

export interface HtmlBridgeOutcome {
  ok: boolean;
  error?: string;
  /** Present when the document changed. */
  content?: string;
  data?: unknown;
}

const findBlock = (id: string) =>
  BUILDER_BLOCK_CATEGORIES.flatMap((c) => c.blocks).find((b) => b.id === id) ?? null;

/**
 * Resolve a bridge target to an element: an index path (`[1,0]`, as reported
 * by html.outline) or a CSS selector scoped to <body>.
 */
function resolveTarget(body: HTMLElement, target: unknown): Element | null {
  if (Array.isArray(target)) {
    return resolveElementPath(body, target.map((n) => Number(n)));
  }
  if (typeof target === 'string' && target.trim()) {
    try { return body.querySelector(target); } catch { return null; }
  }
  return null;
}

export function runHtmlBuilderOp(cmd: string, request: Record<string, unknown>, content: string): HtmlBridgeOutcome {
  if (cmd === 'html.blocks') {
    return {
      ok: true,
      data: BUILDER_BLOCK_CATEGORIES.map((cat) => ({
        category: cat.id,
        blocks: cat.blocks.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      })),
    };
  }

  const source = content.trim() ? content : EMPTY_PAGE_HTML;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const body = doc.body;
  if (!body) return { ok: false, error: 'document has no <body>' };
  const doctype = extractDoctypeFrom(source) || '<!DOCTYPE html>';
  const serialize = () => `${doctype}\n${doc.documentElement.outerHTML}`;

  switch (cmd) {
    case 'html.outline': {
      const flat: Array<{ path: number[]; tag: string; name: string; preview: string }> = [];
      const walk = (nodes: ReturnType<typeof buildLayerTree>) => {
        for (const n of nodes) {
          const el = resolveElementPath(body, n.path);
          const text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
          flat.push({ path: n.path, tag: n.tag, name: n.name, preview: text.slice(0, 60) });
          walk(n.children);
        }
      };
      walk(buildLayerTree(body));
      return { ok: true, data: flat };
    }

    case 'html.insertBlock':
    case 'html.insertHtml': {
      let html: string;
      if (cmd === 'html.insertBlock') {
        const block = findBlock(String(request.blockId ?? request.block ?? ''));
        if (!block) return { ok: false, error: `unknown blockId — run html.blocks for the list` };
        html = block.html;
      } else {
        html = String(request.html ?? '');
        if (!html.trim()) return { ok: false, error: 'html required' };
        if (/<script\b/i.test(html)) return { ok: false, error: 'script tags are not allowed' };
      }
      const host = doc.createElement('div');
      host.innerHTML = html;
      const el = host.firstElementChild;
      if (!el) return { ok: false, error: 'html did not parse to an element' };

      const anchor = resolveTarget(body, request.target);
      const position = String(request.position ?? (anchor ? 'after' : 'append'));
      if (!anchor || position === 'append') {
        (anchor ?? body).appendChild(el);
      } else if (position === 'before') {
        anchor.parentElement?.insertBefore(el, anchor);
      } else {
        anchor.parentElement?.insertBefore(el, anchor.nextSibling);
      }
      return { ok: true, content: serialize(), data: { insertedTag: el.tagName.toLowerCase() } };
    }

    case 'html.setStyle': {
      const el = resolveTarget(body, request.target) as HTMLElement | null;
      if (!el) return { ok: false, error: 'target not found (use html.outline paths or a CSS selector)' };
      const style = request.style;
      if (!style || typeof style !== 'object') return { ok: false, error: 'style object required, e.g. {"background":"#fff"}' };
      for (const [prop, value] of Object.entries(style as Record<string, unknown>)) {
        if (value === null || value === '') el.style.removeProperty(prop);
        else el.style.setProperty(prop, String(value));
      }
      return { ok: true, content: serialize() };
    }

    case 'html.setText': {
      const el = resolveTarget(body, request.target);
      if (!el) return { ok: false, error: 'target not found' };
      el.textContent = String(request.text ?? '');
      return { ok: true, content: serialize() };
    }

    case 'html.setAttr': {
      const el = resolveTarget(body, request.target);
      if (!el) return { ok: false, error: 'target not found' };
      const attr = String(request.attr ?? '').trim();
      if (!attr) return { ok: false, error: 'attr required' };
      if (/^on/i.test(attr)) return { ok: false, error: 'event handler attributes are not allowed' };
      const value = request.value;
      if (value === null || value === undefined || value === '') el.removeAttribute(attr);
      else el.setAttribute(attr, String(value));
      return { ok: true, content: serialize() };
    }

    case 'html.remove': {
      const el = resolveTarget(body, request.target);
      if (!el) return { ok: false, error: 'target not found' };
      el.remove();
      return { ok: true, content: serialize() };
    }

    case 'html.duplicate': {
      const el = resolveTarget(body, request.target);
      if (!el?.parentElement) return { ok: false, error: 'target not found' };
      el.parentElement.insertBefore(el.cloneNode(true), el.nextSibling);
      return { ok: true, content: serialize() };
    }

    case 'html.move': {
      const el = resolveTarget(body, request.target);
      if (!el?.parentElement) return { ok: false, error: 'target not found' };
      const delta = Number(request.delta ?? 0);
      const sibling = delta < 0 ? el.previousElementSibling : el.nextElementSibling;
      if (!sibling) return { ok: false, error: 'already at the edge' };
      el.parentElement.insertBefore(el, delta < 0 ? sibling : sibling.nextSibling);
      return { ok: true, content: serialize() };
    }

    default:
      return { ok: false, error: `unknown cmd: ${cmd}` };
  }
}
