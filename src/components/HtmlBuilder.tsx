/**
 * HtmlBuilder.tsx
 *
 * Figma-style visual builder for HTML documents. Renders the page in a
 * sandboxed iframe sized to its full content height (the outer canvas
 * scrolls, Figma-frame style) and draws hover/selection boxes, resize
 * handles, and drop indicators on an overlay that shares the iframe's
 * coordinate space. All structure edits mutate the live iframe DOM, then
 * serialize back to clean HTML (builder markers stripped) through onChange.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, Blocks, MousePointer2, Undo2, Redo2, Monitor, Tablet, Smartphone,
  ZoomIn, ZoomOut, Maximize, ArrowUp, ArrowDown, CopyPlus, Trash2, Sparkles,
  ChevronRight, ChevronDown, AlignLeft, AlignCenter, AlignRight, Send,
  PanelLeft, PanelRight,
} from 'lucide-react';
import {
  BUILDER_BLOCK_CATEGORIES, EMPTY_PAGE_HTML, type BuilderBlock,
} from './htmlBuilderBlocks';
import {
  buildLayerTree, cssColorToHex, elementDisplayName, extractDoctypeFrom,
  getElementPath, isDropContainer, isTextEditable, resolveElementPath, serializeCleanHtml,
  type LayerNode,
} from './htmlBuilderCore';
import { focusOutsideEditor } from './editorKeyScope';
import './HtmlBuilder.css';

export interface HtmlBuilderProps {
  html: string;
  onChange: (html: string) => void;
  onSave?: () => void;
  accent: string;
  isLightTheme: boolean;
  currentFilePath?: string;
  onTerminalPrompt?: (prompt: string) => void;
}

type DeviceMode = 'desktop' | 'tablet' | 'mobile';
const DEVICE_WIDTHS: Record<DeviceMode, number> = { desktop: 1280, tablet: 768, mobile: 375 };

interface Box { x: number; y: number; w: number; h: number; name: string }
interface DropSpot { ref: Element; where: 'before' | 'after' | 'append' }
interface Snapshot { html: string; sel: number[] | null }

type DragState =
  | { kind: 'move'; el: Element; startX: number; startY: number; started: boolean; preHtml: string; reclick: boolean; cloned: boolean }
  | { kind: 'insert'; block: BuilderBlock; started: boolean; startX: number; startY: number }
  | { kind: 'resize'; el: Element; dir: 'e' | 's' | 'se'; startX: number; startY: number; startW: number; startH: number; preHtml: string };

const DRAG_THRESHOLD = 5;
const MAX_UNDO = 100;

/** Inspector snapshot of the selected element. */
interface SelStyles {
  tag: string;
  text: string | null;      // null → element has child elements, no plain text edit
  href: string | null;
  src: string | null;
  alt: string | null;
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  gap: string;
  width: string;
  height: string;
  maxWidth: string;
  margin: [string, string, string, string];
  padding: [string, string, string, string];
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  textAlign: string;
  color: string;
  backgroundColor: string;
  borderWidth: string;
  borderColor: string;
  borderRadius: string;
  opacity: string;
}

const SHADOW_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'None', value: 'none' },
  { label: 'S', value: '0 1px 3px rgba(0,0,0,0.12)' },
  { label: 'M', value: '0 4px 12px rgba(0,0,0,0.15)' },
  { label: 'L', value: '0 12px 32px rgba(0,0,0,0.2)' },
];

export function HtmlBuilder({
  html, onChange, onSave, accent, isLightTheme, currentFilePath, onTerminalPrompt,
}: HtmlBuilderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const sourceRef = useRef('');
  const doctypeRef = useRef('');
  const suppressPropSync = useRef(false);
  const undoRef = useRef<Snapshot[]>([]);
  const redoRef = useRef<Snapshot[]>([]);
  const selElRef = useRef<Element | null>(null);
  const editingElRef = useRef<Element | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const styleBurstRef = useRef<string | null>(null);   // pre-burst html for one undo per typing burst
  const styleCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docCleanupRef = useRef<(() => void) | null>(null);

  const [tick, setTick] = useState(0);                  // bump → overlay/layers re-render
  const [selPath, setSelPath] = useState<number[] | null>(null);
  const [hoverBox, setHoverBox] = useState<Box | null>(null);
  const [dropLine, setDropLine] = useState<{ x: number; y: number; w: number } | null>(null);
  const [dropInside, setDropInside] = useState<Box | null>(null);
  const copiedHtmlRef = useRef<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [zoom, setZoom] = useState(0.75);
  const [device, setDevice] = useState<DeviceMode>('desktop');
  const [leftTab, setLeftTab] = useState<'blocks' | 'layers'>('blocks');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selStyles, setSelStyles] = useState<SelStyles | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Space/middle-button canvas panning (Figma-style).
  const panRef = useRef({ spaceHeld: false, panning: false, startX: 0, startY: 0, sl: 0, st: 0 });
  const [historyLen, setHistoryLen] = useState<[number, number]>([0, 0]);
  const [showLeft, setShowLeft] = useState(true);
  const [showInspector, setShowInspector] = useState(true);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  const getDoc = useCallback((): Document | null => {
    try { return iframeRef.current?.contentDocument ?? null; } catch { return null; }
  }, []);

  /* ── Serialization / undo ── */

  const syncHistoryLen = useCallback(() => {
    setHistoryLen([undoRef.current.length, redoRef.current.length]);
  }, []);

  const pushUndo = useCallback((snapshot: Snapshot) => {
    undoRef.current.push(snapshot);
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    redoRef.current = [];
    syncHistoryLen();
  }, [syncHistoryLen]);

  const emit = useCallback((nextHtml: string) => {
    sourceRef.current = nextHtml;
    suppressPropSync.current = true;
    onChange(nextHtml);
  }, [onChange]);

  /** Serialize the live doc and emit; pushes `preHtml` as the undo snapshot. */
  const commit = useCallback((preHtml?: string) => {
    const doc = getDoc();
    if (!doc) return;
    const next = serializeCleanHtml(doc, doctypeRef.current);
    if (next === sourceRef.current) return;
    pushUndo({ html: preHtml ?? sourceRef.current, sel: selPathFromEl(selElRef.current, doc) });
    emit(next);
    bump();
  }, [getDoc, pushUndo, emit, bump]);

  function selPathFromEl(el: Element | null, doc: Document): number[] | null {
    if (!el || !el.isConnected) return null;
    return getElementPath(el, doc.body);
  }

  /* ── Selection ── */

  const readStyles = useCallback((el: Element): SelStyles => {
    const doc = el.ownerDocument;
    const cs = doc.defaultView!.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const inline = (el as HTMLElement).style;
    const side = (prop: 'margin' | 'padding'): [string, string, string, string] => ([
      cs.getPropertyValue(`${prop}-top`), cs.getPropertyValue(`${prop}-right`),
      cs.getPropertyValue(`${prop}-bottom`), cs.getPropertyValue(`${prop}-left`),
    ]);
    return {
      tag,
      text: el.children.length === 0 && isTextEditable(el) ? (el.textContent ?? '') : null,
      href: tag === 'a' ? (el.getAttribute('href') ?? '') : null,
      src: tag === 'img' ? (el.getAttribute('src') ?? '') : null,
      alt: tag === 'img' ? (el.getAttribute('alt') ?? '') : null,
      display: cs.display,
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      gap: inline.gap || cs.gap,
      width: inline.width,
      height: inline.height,
      maxWidth: inline.maxWidth,
      margin: side('margin'),
      padding: side('padding'),
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: inline.lineHeight || cs.lineHeight,
      textAlign: cs.textAlign,
      color: cssColorToHex(cs.color),
      backgroundColor: cssColorToHex(cs.backgroundColor, '#ffffff'),
      borderWidth: cs.borderTopWidth,
      borderColor: cssColorToHex(cs.borderTopColor),
      borderRadius: cs.borderTopLeftRadius,
      opacity: cs.opacity,
    };
  }, []);

  const stopTextEdit = useCallback((commitAfter: boolean) => {
    const el = editingElRef.current as HTMLElement | null;
    if (!el) return;
    editingElRef.current = null;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-bbarit-editing');
    setEditingText(false);
    if (commitAfter) commit();
  }, [commit]);

  const select = useCallback((el: Element | null) => {
    if (editingElRef.current && el !== editingElRef.current) stopTextEdit(true);
    selElRef.current = el;
    const doc = getDoc();
    setSelPath(el && doc ? getElementPath(el, doc.body) : null);
    setSelStyles(el ? readStyles(el) : null);
    setAiPrompt('');
    bump();
  }, [getDoc, readStyles, bump, stopTextEdit]);

  const startTextEdit = useCallback((el: Element) => {
    if (!isTextEditable(el)) return;
    stopTextEdit(true);
    editingElRef.current = el;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-bbarit-editing', '1');
    (el as HTMLElement).focus();
    // Select the whole text so placeholder copy is replaced by just typing.
    try {
      const doc = el.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.defaultView?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch { /* selection is a convenience only */ }
    setEditingText(true);
  }, [stopTextEdit]);

  /* ── Iframe sizing (canvas scrolls, not the iframe) ── */

  const fitIframeHeight = useCallback(() => {
    const doc = getDoc();
    const iframe = iframeRef.current;
    if (!doc || !iframe || !doc.documentElement) return;
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, 600);
    if (iframe.style.height !== `${h}px`) iframe.style.height = `${h}px`;
  }, [getDoc]);

  /* ── Drops (shared by element move and palette insert) ── */

  const clientToDocPoint = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const iframe = iframeRef.current;
    if (!iframe) return null;
    const r = iframe.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  }, [zoom]);

  const computeDropSpot = useCallback((x: number, y: number, exclude: Element | null): DropSpot | null => {
    const doc = getDoc();
    if (!doc?.body) return null;
    let hit = doc.elementFromPoint(x, y);
    if (hit === doc.documentElement || !hit) hit = doc.body;
    if (exclude) {
      while (hit && (hit === exclude || exclude.contains(hit))) hit = hit.parentElement;
    }
    if (!hit || hit === doc.documentElement) return null;
    if (hit === doc.body) return { ref: doc.body, where: 'append' };
    const r = hit.getBoundingClientRect();
    // Empty structural containers (e.g. a column of a 2-column block) accept
    // drops INTO them when the cursor sits in their middle band.
    if (isDropContainer(hit) && r.height >= 40 && y > r.top + r.height * 0.25 && y < r.bottom - r.height * 0.25) {
      return { ref: hit, where: 'append' };
    }
    return { ref: hit, where: y < r.top + r.height / 2 ? 'before' : 'after' };
  }, [getDoc]);

  const showDropIndicator = useCallback((spot: DropSpot | null) => {
    if (!spot) { setDropLine(null); setDropInside(null); return; }
    if (spot.where === 'append') {
      const ref = spot.ref as HTMLElement;
      if (ref.tagName !== 'BODY') {
        const r = ref.getBoundingClientRect();
        setDropLine(null);
        setDropInside({ x: r.left, y: r.top, w: r.width, h: r.height, name: elementDisplayName(ref) });
        return;
      }
      const last = ref.lastElementChild;
      const y = last ? last.getBoundingClientRect().bottom : 8;
      setDropInside(null);
      setDropLine({ x: 8, y, w: ref.clientWidth - 16 });
      return;
    }
    const r = spot.ref.getBoundingClientRect();
    setDropInside(null);
    setDropLine({ x: r.left, y: spot.where === 'before' ? r.top : r.bottom, w: r.width });
  }, []);

  const performDrop = useCallback((spot: DropSpot, payload: { el?: Element; html?: string }): Element | null => {
    let inserted: Element | null = null;
    if (payload.el) {
      const el = payload.el;
      if (spot.where === 'append') spot.ref.appendChild(el);
      else spot.ref.parentElement?.insertBefore(el, spot.where === 'before' ? spot.ref : spot.ref.nextSibling);
      inserted = el;
    } else if (payload.html) {
      const doc = spot.ref.ownerDocument;
      const host = doc.createElement('div');
      host.innerHTML = payload.html;
      const el = host.firstElementChild;
      if (!el) return null;
      if (spot.where === 'append') spot.ref.appendChild(el);
      else spot.ref.parentElement?.insertBefore(el, spot.where === 'before' ? spot.ref : spot.ref.nextSibling);
      inserted = el;
    }
    return inserted;
  }, []);

  /* ── Structural element operations ── */

  const insertBlock = useCallback((block: BuilderBlock, spot?: DropSpot | null) => {
    const doc = getDoc();
    if (!doc?.body) return;
    const pre = sourceRef.current;
    const target: DropSpot = spot
      ?? (selElRef.current?.isConnected
        ? { ref: selElRef.current, where: 'after' }
        : { ref: doc.body, where: 'append' });
    const el = performDrop(target, { html: block.html });
    if (!el) return;
    fitIframeHeight();
    commit(pre);
    select(el);
    el.scrollIntoView({ block: 'nearest' });
  }, [getDoc, performDrop, fitIframeHeight, commit, select]);

  const deleteSelected = useCallback(() => {
    const el = selElRef.current;
    if (!el || !el.isConnected) return;
    const pre = sourceRef.current;
    const next = (el.nextElementSibling ?? el.previousElementSibling ?? el.parentElement) as Element | null;
    el.remove();
    fitIframeHeight();
    commit(pre);
    select(next && next.tagName !== 'BODY' ? next : null);
  }, [commit, fitIframeHeight, select]);

  const duplicateSelected = useCallback(() => {
    const el = selElRef.current;
    if (!el?.parentElement) return;
    const pre = sourceRef.current;
    const copy = el.cloneNode(true) as Element;
    el.parentElement.insertBefore(copy, el.nextSibling);
    fitIframeHeight();
    commit(pre);
    select(copy);
  }, [commit, fitIframeHeight, select]);

  const moveSelected = useCallback((dir: -1 | 1) => {
    const el = selElRef.current;
    if (!el?.parentElement) return;
    const sibling = dir === -1 ? el.previousElementSibling : el.nextElementSibling;
    if (!sibling) return;
    const pre = sourceRef.current;
    el.parentElement.insertBefore(el, dir === -1 ? sibling : sibling.nextSibling);
    commit(pre);
    select(el);
    el.scrollIntoView({ block: 'nearest' });
  }, [commit, select]);

  /* ── Inspector style application (one undo per typing burst) ── */

  const applyStyle = useCallback((prop: string, value: string) => {
    const el = selElRef.current as HTMLElement | null;
    if (!el) return;
    if (styleBurstRef.current === null) styleBurstRef.current = sourceRef.current;
    if (value === '') el.style.removeProperty(prop);
    else el.style.setProperty(prop, value);
    setSelStyles(readStyles(el));
    fitIframeHeight();
    bump();
    if (styleCommitTimer.current) clearTimeout(styleCommitTimer.current);
    styleCommitTimer.current = setTimeout(() => {
      const pre = styleBurstRef.current;
      styleBurstRef.current = null;
      commit(pre ?? undefined);
    }, 400);
  }, [readStyles, fitIframeHeight, bump, commit]);

  const applyAttr = useCallback((attr: string, value: string) => {
    const el = selElRef.current;
    if (!el) return;
    if (styleBurstRef.current === null) styleBurstRef.current = sourceRef.current;
    if (value === '') el.removeAttribute(attr);
    else el.setAttribute(attr, value);
    setSelStyles(readStyles(el));
    if (styleCommitTimer.current) clearTimeout(styleCommitTimer.current);
    styleCommitTimer.current = setTimeout(() => {
      const pre = styleBurstRef.current;
      styleBurstRef.current = null;
      commit(pre ?? undefined);
    }, 400);
  }, [readStyles, commit]);

  const applyText = useCallback((value: string) => {
    const el = selElRef.current;
    if (!el) return;
    if (styleBurstRef.current === null) styleBurstRef.current = sourceRef.current;
    el.textContent = value;
    setSelStyles((prev) => (prev ? { ...prev, text: value } : prev));
    fitIframeHeight();
    bump();
    if (styleCommitTimer.current) clearTimeout(styleCommitTimer.current);
    styleCommitTimer.current = setTimeout(() => {
      const pre = styleBurstRef.current;
      styleBurstRef.current = null;
      commit(pre ?? undefined);
    }, 400);
  }, [fitIframeHeight, bump, commit]);

  /* ── Element clipboard (⌘C/⌘X/⌘V inside the builder) ── */

  const copySelected = useCallback(() => {
    const el = selElRef.current;
    if (!el) return;
    copiedHtmlRef.current = el.outerHTML;
    // Best effort: mirror to the OS clipboard so the markup can be pasted elsewhere.
    navigator.clipboard?.writeText(el.outerHTML).catch(() => {});
  }, []);

  const pasteCopied = useCallback(() => {
    const html = copiedHtmlRef.current;
    const doc = getDoc();
    if (!html || !doc?.body) return;
    const pre = sourceRef.current;
    const target: DropSpot = selElRef.current?.isConnected
      ? { ref: selElRef.current, where: 'after' }
      : { ref: doc.body, where: 'append' };
    const el = performDrop(target, { html });
    if (!el) return;
    fitIframeHeight();
    commit(pre);
    select(el);
  }, [getDoc, performDrop, fitIframeHeight, commit, select]);

  /* ── Undo / redo ── */

  const writeDoc = useCallback((nextHtml: string) => {
    const doc = getDoc();
    if (!doc) return;
    doctypeRef.current = extractDoctypeFrom(nextHtml);
    doc.open();
    doc.write(nextHtml || EMPTY_PAGE_HTML);
    doc.close();
    // document.open() strips every listener but expandos survive — clear the
    // hooked marker so the attach watchdog re-hooks this document.
    delete (doc as Document & { __bbaritBuilderHooked?: boolean }).__bbaritBuilderHooked;
    const style = doc.createElement('style');
    style.setAttribute('data-bbarit-builder', '1');
    style.textContent = 'a,button{cursor:default} [data-bbarit-editing]{outline:none;cursor:text}';
    doc.head?.appendChild(style);
    fitIframeHeight();
    bump();
  }, [getDoc, fitIframeHeight, bump]);

  const applySnapshot = useCallback((snap: Snapshot) => {
    stopTextEdit(false);
    emit(snap.html);
    writeDoc(snap.html);
    const doc = getDoc();
    const el = snap.sel && doc?.body ? resolveElementPath(doc.body, snap.sel) : null;
    select(el);
    syncHistoryLen();
  }, [emit, writeDoc, getDoc, select, stopTextEdit, syncHistoryLen]);

  const undo = useCallback(() => {
    const snap = undoRef.current.pop();
    if (!snap) return;
    const doc = getDoc();
    redoRef.current.push({ html: sourceRef.current, sel: doc ? selPathFromEl(selElRef.current, doc) : null });
    applySnapshot(snap);
  }, [applySnapshot, getDoc]);

  const redo = useCallback(() => {
    const snap = redoRef.current.pop();
    if (!snap) return;
    const doc = getDoc();
    undoRef.current.push({ html: sourceRef.current, sel: doc ? selPathFromEl(selElRef.current, doc) : null });
    syncHistoryLen();
    applySnapshot(snap);
  }, [applySnapshot, getDoc, syncHistoryLen]);

  /* ── Drag machinery (element move / palette insert / resize) ── */

  const endDrag = useCallback((clientX: number, clientY: number) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setIsDragging(false);
    setDropLine(null);
    setDropInside(null);
    document.body.style.cursor = '';
    if (!drag) return;

    if (drag.kind === 'resize') {
      commit(drag.preHtml);
      if (selElRef.current) setSelStyles(readStyles(selElRef.current));
      return;
    }
    if (!drag.started) {
      if (drag.kind === 'insert') insertBlock(drag.block);
      // Alt+click without a drag still leaves a duplicate — commit it.
      else if (drag.kind === 'move' && drag.cloned) { fitIframeHeight(); commit(drag.preHtml); select(drag.el); }
      // Clicking an already-selected text element again starts editing —
      // no precise double-click needed.
      else if (drag.kind === 'move' && drag.reclick && isTextEditable(drag.el)) startTextEdit(drag.el);
      return;
    }
    const pt = clientToDocPoint(clientX, clientY);
    if (!pt) return;
    if (drag.kind === 'move') {
      const spot = computeDropSpot(pt.x, pt.y, drag.el);
      if (spot) {
        performDrop(spot, { el: drag.el });
        fitIframeHeight();
        commit(drag.preHtml);
        select(drag.el);
      }
    } else {
      const spot = computeDropSpot(pt.x, pt.y, null);
      if (spot) insertBlock(drag.block, spot);
    }
  }, [clientToDocPoint, computeDropSpot, performDrop, insertBlock, commit, select, fitIframeHeight, readStyles, startTextEdit]);

  const moveDrag = useCallback((clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.kind === 'resize') {
      const el = drag.el as HTMLElement;
      const dx = (clientX - drag.startX) / zoom;
      const dy = (clientY - drag.startY) / zoom;
      if (drag.dir === 'e' || drag.dir === 'se') el.style.width = `${Math.max(16, Math.round(drag.startW + dx))}px`;
      if (drag.dir === 's' || drag.dir === 'se') el.style.height = `${Math.max(16, Math.round(drag.startH + dy))}px`;
      fitIframeHeight();
      bump();
      return;
    }

    if (!drag.started) {
      if (Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.started = true;
      setIsDragging(true);
      setHoverBox(null);
      document.body.style.cursor = 'grabbing';
    }
    const pt = clientToDocPoint(clientX, clientY);
    if (!pt) return;
    const exclude = drag.kind === 'move' ? drag.el : null;
    showDropIndicator(computeDropSpot(pt.x, pt.y, exclude));
  }, [zoom, clientToDocPoint, computeDropSpot, showDropIndicator, fitIframeHeight, bump]);

  // Event handlers delegate through this ref so listener attachment lifetime
  // is decoupled from render-to-render callback identities (prop identity
  // churn must never leave the canvas with stale or missing listeners).
  const latestRef = useRef({
    zoom, select, startTextEdit, stopTextEdit, deleteSelected, duplicateSelected, moveSelected,
    copySelected, pasteCopied, undo, redo, onSave, fitIframeHeight, bump, moveDrag, endDrag,
    zoomBy: (d: number) => setZoom((z) => Math.min(2, Math.max(0.1, +(z + d).toFixed(2)))),
    zoomReset: () => setZoom(1),
  });
  latestRef.current = {
    zoom, select, startTextEdit, stopTextEdit, deleteSelected, duplicateSelected, moveSelected,
    copySelected, pasteCopied, undo, redo, onSave, fitIframeHeight, bump, moveDrag, endDrag,
    // Inline lambda: zoomBy is declared further down; a direct reference here
    // would run before initialization during render (TDZ crash).
    zoomBy: (d: number) => setZoom((z) => Math.min(2, Math.max(0.1, +(z + d).toFixed(2)))),
    zoomReset: () => setZoom(1),
  };

  // Global mouse tracking while a drag is pending/active (palette drags start
  // outside the iframe; element drags can leave it).
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (panRef.current.panning) {
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.scrollLeft = panRef.current.sl - (e.clientX - panRef.current.startX);
          canvas.scrollTop = panRef.current.st - (e.clientY - panRef.current.startY);
        }
        return;
      }
      latestRef.current.moveDrag(e.clientX, e.clientY);
    };
    const onUp = (e: MouseEvent) => {
      if (panRef.current.panning) {
        panRef.current.panning = false;
        document.body.style.cursor = panRef.current.spaceHeld ? 'grab' : '';
        return;
      }
      if (dragRef.current) latestRef.current.endDrag(e.clientX, e.clientY);
    };
    const onDown = () => setCtxMenu(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  /* ── Iframe document listeners ── */

  const attachDocListeners = useCallback(() => {
    docCleanupRef.current?.();
    const doc = getDoc();
    const win = doc?.defaultView;
    if (!doc || !win) return;
    const H = () => latestRef.current;

    // Iframe events report iframe-viewport coordinates; drag logic works in
    // parent-client space so a drag can cross the iframe boundary.
    const toParent = (e: MouseEvent): { x: number; y: number } => {
      const r = iframeRef.current?.getBoundingClientRect();
      if (!r) return { x: e.clientX, y: e.clientY };
      return { x: r.left + e.clientX * H().zoom, y: r.top + e.clientY * H().zoom };
    };

    const pickTarget = (e: Event): Element | null => {
      const t = e.target as Element | null;
      if (!t || !(t instanceof win.Element)) return null;
      if (t === doc.documentElement || t === doc.body) return null;
      return t;
    };

    const onMouseOver = (e: MouseEvent) => {
      // resize 드래그에는 started 플래그가 없다 — 진행 중이면 무조건 호버 갱신을 멈춘다.
      const drag = dragRef.current;
      if (drag && (drag.kind === 'resize' || drag.started)) return;
      if (editingElRef.current) return;
      const t = pickTarget(e);
      if (!t) { setHoverBox(null); return; }
      const r = t.getBoundingClientRect();
      setHoverBox({ x: r.left, y: r.top, w: r.width, h: r.height, name: elementDisplayName(t) });
    };
    const onMouseOut = () => setHoverBox(null);

    const startPan = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      panRef.current = { ...panRef.current, panning: true, startX: clientX, startY: clientY, sl: canvas.scrollLeft, st: canvas.scrollTop };
      document.body.style.cursor = 'grabbing';
    };

    const onMouseDown = (e: MouseEvent) => {
      setCtxMenu(null);
      // Figma-style panning: space+drag or middle-button drag.
      if (e.button === 1 || (e.button === 0 && panRef.current.spaceHeld)) {
        e.preventDefault();
        const p = toParent(e);
        startPan(p.x, p.y);
        return;
      }
      if (e.button !== 0) return;
      const t = pickTarget(e);
      if (editingElRef.current) {
        if (t && editingElRef.current.contains(t)) return; // keep typing
        H().stopTextEdit(true);
      }
      // preventDefault blocks the browser's focus change, so move focus to the
      // iframe explicitly — otherwise keys (Delete/⌘Z) leak to whatever was
      // focused before, e.g. a terminal pane.
      iframeRef.current?.focus();
      if (!t) { H().select(null); return; }
      e.preventDefault();
      const reclick = selElRef.current === t;
      let target = t;
      let cloned = false;
      // Alt+drag duplicates: drag a fresh copy, leave the original in place.
      if (e.altKey && t.parentElement) {
        const copy = t.cloneNode(true) as Element;
        t.parentElement.insertBefore(copy, t.nextSibling);
        target = copy;
        cloned = true;
      }
      H().select(target);
      const p = toParent(e);
      dragRef.current = { kind: 'move', el: target, startX: p.x, startY: p.y, started: false, preHtml: sourceRef.current, reclick: reclick && !cloned, cloned };
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const t = pickTarget(e);
      if (!t) { setCtxMenu(null); return; }
      H().select(t);
      const p = toParent(e);
      setCtxMenu({ x: p.x, y: p.y });
    };

    const onDocMouseMove = (e: MouseEvent) => {
      const p = toParent(e);
      if (panRef.current.panning) {
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.scrollLeft = panRef.current.sl - (p.x - panRef.current.startX);
          canvas.scrollTop = panRef.current.st - (p.y - panRef.current.startY);
        }
        return;
      }
      if (!dragRef.current) return;
      H().moveDrag(p.x, p.y);
    };
    const onDocMouseUp = (e: MouseEvent) => {
      if (panRef.current.panning) {
        panRef.current.panning = false;
        document.body.style.cursor = panRef.current.spaceHeld ? 'grab' : '';
        return;
      }
      if (!dragRef.current) return;
      const p = toParent(e);
      H().endDrag(p.x, p.y);
    };

    const onClick = (e: MouseEvent) => {
      // Never follow links / submit forms inside the builder.
      e.preventDefault();
    };

    const onDblClick = (e: MouseEvent) => {
      const t = pickTarget(e);
      if (!t) return;
      e.preventDefault();
      H().select(t);
      H().startTextEdit(t);
    };

    const onInput = () => { H().fitIframeHeight(); H().bump(); };

    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); H().stopTextEdit(true); H().onSave?.(); return; }
      if (editingElRef.current) {
        if (e.key === 'Escape') { e.preventDefault(); H().stopTextEdit(true); }
        return;
      }
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) H().redo(); else H().undo(); return; }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); H().duplicateSelected(); return; }
      if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); H().copySelected(); return; }
      if (meta && e.key.toLowerCase() === 'x') { e.preventDefault(); H().copySelected(); H().deleteSelected(); return; }
      if (meta && e.key.toLowerCase() === 'v') { e.preventDefault(); H().pasteCopied(); return; }
      if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); H().zoomBy(0.1); return; }
      if (meta && e.key === '-') { e.preventDefault(); H().zoomBy(-0.1); return; }
      if (meta && e.key === '0') { e.preventDefault(); H().zoomReset(); return; }
      if (e.key === ' ' && !panRef.current.spaceHeld) {
        e.preventDefault();
        panRef.current.spaceHeld = true;
        document.body.style.cursor = 'grab';
        return;
      }
      if (e.key === 'Escape') { setCtxMenu(null); H().select(null); return; }
      if (e.key === 'Enter' && e.shiftKey && selElRef.current) {
        // Shift+Enter selects the parent (Figma convention).
        e.preventDefault();
        const parent = selElRef.current.parentElement;
        if (parent && parent !== doc.body && parent.tagName !== 'HTML') H().select(parent);
        return;
      }
      if (e.key === 'Enter' && selElRef.current && isTextEditable(selElRef.current)) {
        e.preventDefault();
        H().startTextEdit(selElRef.current);
        return;
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selElRef.current) {
        e.preventDefault();
        H().moveSelected(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selElRef.current) {
        e.preventDefault();
        H().deleteSelected();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        panRef.current.spaceHeld = false;
        if (!panRef.current.panning) document.body.style.cursor = '';
      }
    };

    // iframe 안에서 발생한 휠 이벤트는 부모로 전파되지 않는다. iframe 문서는
    // 콘텐츠 전체 높이로 맞춰져 있어(fitIframeHeight) 자기 자신은 스크롤할 게
    // 없으므로, 커서가 프레임 위에 있으면 캔버스 좌우/상하 스크롤이 죽는다 —
    // 여기서 캔버스로 직접 전달한다. ⌘/Ctrl+휠은 캔버스와 동일하게 줌.
    const onWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        H().zoomBy(e.deltaY < 0 ? 0.05 : -0.05);
        return;
      }
      // 페이지 내부의 자체 스크롤 영역(overflow 된 div 등)이면 그쪽을 살린다.
      let t: Element | null = e.target instanceof win.Element ? e.target : null;
      while (t && t !== doc.documentElement && t !== doc.body) {
        const st = win.getComputedStyle(t);
        const scrollableY = /(auto|scroll)/.test(st.overflowY) && t.scrollHeight > t.clientHeight;
        const scrollableX = /(auto|scroll)/.test(st.overflowX) && t.scrollWidth > t.clientWidth;
        if (scrollableY || scrollableX) return;
        t = t.parentElement;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      canvas.scrollLeft += e.deltaX;
      canvas.scrollTop += e.deltaY;
    };

    doc.addEventListener('mouseover', onMouseOver);
    doc.addEventListener('mouseout', onMouseOut);
    doc.addEventListener('mousedown', onMouseDown);
    doc.addEventListener('contextmenu', onContextMenu);
    doc.addEventListener('keyup', onKeyUp);
    doc.addEventListener('mousemove', onDocMouseMove);
    doc.addEventListener('mouseup', onDocMouseUp);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('dblclick', onDblClick);
    doc.addEventListener('input', onInput);
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('wheel', onWheel, { passive: false });
    // document.open() (every writeDoc) silently strips all listeners; this
    // expando marks the hooked state so the watchdog can detect and re-attach.
    (doc as Document & { __bbaritBuilderHooked?: boolean }).__bbaritBuilderHooked = true;
    docCleanupRef.current = () => {
      delete (doc as Document & { __bbaritBuilderHooked?: boolean }).__bbaritBuilderHooked;
      doc.removeEventListener('mouseover', onMouseOver);
      doc.removeEventListener('mouseout', onMouseOut);
      doc.removeEventListener('mousedown', onMouseDown);
      doc.removeEventListener('contextmenu', onContextMenu);
      doc.removeEventListener('keyup', onKeyUp);
      doc.removeEventListener('mousemove', onDocMouseMove);
      doc.removeEventListener('mouseup', onDocMouseUp);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('dblclick', onDblClick);
      doc.removeEventListener('input', onInput);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('wheel', onWheel);
    };
  }, [getDoc]);

  /* ── Mount / external content sync ── */

  useEffect(() => {
    const initial = html.trim() ? html : EMPTY_PAGE_HTML;
    sourceRef.current = initial;
    writeDoc(initial);
    attachDocListeners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (suppressPropSync.current) { suppressPropSync.current = false; return; }
    if (html === sourceRef.current) return;
    // External edit (source pane, file reload, agent): reload the canvas.
    sourceRef.current = html.trim() ? html : EMPTY_PAGE_HTML;
    writeDoc(sourceRef.current);
    attachDocListeners();
    select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html]);

  // Re-attach listeners after every doc rewrite triggered by undo/redo, and
  // run a watchdog: writeDoc's document.open() strips listeners, and other
  // rewrites (HMR, webview quirks) must never leave a dead canvas.
  useEffect(() => {
    attachDocListeners();
    const watchdog = window.setInterval(() => {
      const doc = getDoc() as (Document & { __bbaritBuilderHooked?: boolean }) | null;
      if (doc && doc.body && !doc.__bbaritBuilderHooked) attachDocListeners();
    }, 400);
    return () => {
      window.clearInterval(watchdog);
      docCleanupRef.current?.();
      docCleanupRef.current = null;
    };
  }, [attachDocListeners, getDoc, tick]);

  useEffect(() => () => {
    if (styleCommitTimer.current) clearTimeout(styleCommitTimer.current);
  }, []);

  /* ── Parent-window shortcuts (scoped to this editor) ── */

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (focusOutsideEditor(rootRef.current, e)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
      if (meta && e.key.toLowerCase() === 'd' && selElRef.current) { e.preventDefault(); duplicateSelected(); return; }
      if (meta && e.key.toLowerCase() === 'c' && selElRef.current) { e.preventDefault(); copySelected(); return; }
      if (meta && e.key.toLowerCase() === 'x' && selElRef.current) { e.preventDefault(); copySelected(); deleteSelected(); return; }
      if (meta && e.key.toLowerCase() === 'v' && copiedHtmlRef.current) { e.preventDefault(); pasteCopied(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selElRef.current) { e.preventDefault(); deleteSelected(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, onSave, duplicateSelected, deleteSelected, copySelected, pasteCopied]);

  /* ── Zoom: ⌘+wheel on the canvas, fit on mount and device change ── */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      setZoom((z) => Math.min(2, Math.max(0.1, +(z + (e.deltaY < 0 ? 0.05 : -0.05)).toFixed(2))));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    zoomFit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  /* ── AI edit request → terminal agent ── */

  const sendAiEdit = useCallback(() => {
    const el = selElRef.current;
    const ask = aiPrompt.trim();
    if (!el || !ask || !onTerminalPrompt) return;
    onSave?.();
    const snippet = el.outerHTML.length > 2400 ? `${el.outerHTML.slice(0, 2400)}…` : el.outerHTML;
    onTerminalPrompt(
      `HTML 파일을 수정해줘: ${currentFilePath || '(현재 열린 HTML 파일)'}\n\n` +
      `아래 요소(빌더에서 선택됨)를 찾아서 요청대로 바꿔줘. 다른 부분은 건드리지 마.\n\n` +
      `\`\`\`html\n${snippet}\n\`\`\`\n\n요청: ${ask}`,
    );
    setAiPrompt('');
  }, [aiPrompt, onTerminalPrompt, onSave, currentFilePath]);

  /* ── Derived render data ── */

  const doc = getDoc();
  const layers = useMemo<LayerNode[]>(() => {
    void tick;
    const body = getDoc()?.body;
    return body ? buildLayerTree(body) : [];
  }, [getDoc, tick]);

  const selBox: Box | null = useMemo(() => {
    void tick;
    const el = selElRef.current;
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, name: elementDisplayName(el) };
  }, [tick, selPath]);

  const crumbs = useMemo(() => {
    void tick;
    const el = selElRef.current;
    const body = getDoc()?.body;
    if (!el || !el.isConnected || !body) return [];
    const chain: Element[] = [];
    let cur: Element | null = el;
    while (cur && cur !== body) { chain.unshift(cur); cur = cur.parentElement; }
    return chain;
  }, [tick, selPath, getDoc]);

  const deviceWidth = DEVICE_WIDTHS[device];
  const bodyIsEmpty = !!doc?.body && doc.body.children.length === 0;

  const zoomBy = useCallback((delta: number) => {
    setZoom((z) => Math.min(2, Math.max(0.1, +(z + delta).toFixed(2))));
  }, []);

  const zoomFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Fit never zooms past 100% — blowing a 375px frame up to 2× reads wrong.
    setZoom(Math.min(1, Math.max(0.1, (canvas.clientWidth - 64) / deviceWidth)));
  }, [deviceWidth]);

  const startResize = useCallback((dir: 'e' | 's' | 'se', e: React.MouseEvent) => {
    const el = selElRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    dragRef.current = {
      kind: 'resize', el, dir, startX: e.clientX, startY: e.clientY,
      startW: r.width, startH: r.height, preHtml: sourceRef.current,
    };
    setIsDragging(true);
  }, []);

  const startPaletteDrag = useCallback((block: BuilderBlock, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { kind: 'insert', block, started: false, startX: e.clientX, startY: e.clientY };
  }, []);

  const renderLayer = (node: LayerNode, depth: number): React.ReactNode => {
    const key = node.path.join('.');
    const hasKids = node.children.length > 0;
    // Shallow rows are open by default; `!key` entries mark explicitly closed ones.
    const isOpen = expanded.has(`!${key}`) ? false : (expanded.has(key) || depth < 2);
    const isSel = !!selPath && key === selPath.join('.');
    return (
      <React.Fragment key={key}>
        <button
          className={`hb-layer-row ${isSel ? 'selected' : ''}`}
          style={{ paddingLeft: 4 + depth * 12 }}
          onClick={() => {
            const body = getDoc()?.body;
            const el = body ? resolveElementPath(body, node.path) : null;
            if (el) { select(el); el.scrollIntoView({ block: 'nearest' }); }
          }}
          onMouseEnter={() => {
            const body = getDoc()?.body;
            const el = body ? resolveElementPath(body, node.path) : null;
            if (el) {
              const r = el.getBoundingClientRect();
              setHoverBox({ x: r.left, y: r.top, w: r.width, h: r.height, name: node.name });
            }
          }}
          onMouseLeave={() => setHoverBox(null)}
        >
          <span
            className="hb-layer-caret"
            onClick={(e) => {
              if (!hasKids) return;
              e.stopPropagation();
              setExpanded((prev) => {
                const next = new Set(prev);
                if (isOpen) { next.delete(key); next.add(`!${key}`); }
                else { next.delete(`!${key}`); next.add(key); }
                return next;
              });
            }}
          >
            {hasKids ? (isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        </button>
        {hasKids && isOpen && node.children.map((child) => renderLayer(child, depth + 1))}
      </React.Fragment>
    );
  };

  const labelBelow = (box: Box) => box.y < 26;
  const styleNum = (v: string) => v.replace(/px$/, '');

  return (
    <div
      ref={rootRef}
      className={`hb-root ${isLightTheme ? 'hb-light' : ''}`}
      style={{ '--hb-accent': accent } as React.CSSProperties}
    >
      {/* ── Top bar ── */}
      <div className="hb-topbar">
        <div className="hb-topbar-group">
          <button className="hb-btn" onClick={undo} disabled={historyLen[0] === 0} title="Undo (⌘Z)"><Undo2 size={13} /></button>
          <button className="hb-btn" onClick={redo} disabled={historyLen[1] === 0} title="Redo (⌘⇧Z)"><Redo2 size={13} /></button>
        </div>
        <div className="hb-topbar-sep" />
        <div className="hb-topbar-group">
          <button className={`hb-btn ${device === 'desktop' ? 'active' : ''}`} onClick={() => setDevice('desktop')} title="Desktop (1280)"><Monitor size={13} /></button>
          <button className={`hb-btn ${device === 'tablet' ? 'active' : ''}`} onClick={() => setDevice('tablet')} title="Tablet (768)"><Tablet size={13} /></button>
          <button className={`hb-btn ${device === 'mobile' ? 'active' : ''}`} onClick={() => setDevice('mobile')} title="Mobile (375)"><Smartphone size={13} /></button>
        </div>
        <div className="hb-topbar-sep" />
        <div className="hb-topbar-group">
          <button className="hb-btn" onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.1).toFixed(2)))} title="Zoom out"><ZoomOut size={13} /></button>
          <span className="hb-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="hb-btn" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} title="Zoom in"><ZoomIn size={13} /></button>
          <button className="hb-btn" onClick={zoomFit} title="Fit width"><Maximize size={13} /></button>
        </div>
        <div className="hb-topbar-sep" />
        <div className="hb-topbar-group">
          <button className={`hb-btn ${showLeft ? 'active' : ''}`} onClick={() => setShowLeft(v => !v)} title="Toggle blocks/layers panel"><PanelLeft size={13} /></button>
          <button className={`hb-btn ${showInspector ? 'active' : ''}`} onClick={() => setShowInspector(v => !v)} title="Toggle inspector"><PanelRight size={13} /></button>
        </div>
        <div className="hb-topbar-group" style={{ marginLeft: 'auto', opacity: 0.55 }}>
          <MousePointer2 size={12} />
          <span>{selBox ? selBox.name : 'Click to select · click again or press Enter to edit text'}</span>
        </div>
      </div>

      <div className="hb-body">
        {/* ── Left: blocks / layers ── */}
        {showLeft && (
        <div className="hb-left">
          <div className="hb-left-tabs">
            <button className={`hb-left-tab ${leftTab === 'blocks' ? 'active' : ''}`} onClick={() => setLeftTab('blocks')}>
              <Blocks size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Blocks
            </button>
            <button className={`hb-left-tab ${leftTab === 'layers' ? 'active' : ''}`} onClick={() => setLeftTab('layers')}>
              <Layers size={11} style={{ verticalAlign: -1, marginRight: 4 }} />Layers
            </button>
          </div>
          <div className="hb-left-scroll">
            {leftTab === 'blocks' ? (
              BUILDER_BLOCK_CATEGORIES.map((cat) => (
                <div key={cat.id} className="hb-block-cat">
                  <div className="hb-block-cat-name">{cat.name}</div>
                  <div className="hb-block-grid">
                    {cat.blocks.map((block) => (
                      <div
                        key={block.id}
                        className="hb-block-item"
                        title={`${block.description} — click or drag into the page`}
                        onMouseDown={(e) => startPaletteDrag(block, e)}
                      >
                        <div className="hb-block-thumb">
                          {/* Blocks are self-contained inline-styled HTML, so a scaled-down live render works as the preview. */}
                          <div className="hb-block-thumb-inner" dangerouslySetInnerHTML={{ __html: block.html }} />
                        </div>
                        <div className="hb-block-item-name">{block.name}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : layers.length === 0 ? (
              <div className="hb-layers-empty">Empty page.<br />Add blocks to get started.</div>
            ) : (
              layers.map((node) => renderLayer(node, 0))
            )}
          </div>
        </div>
        )}

        {/* ── Canvas ── */}
        <div className="hb-canvas" ref={canvasRef} onMouseDown={(e) => { if (e.target === canvasRef.current) select(null); }}>
          <div className="hb-frame-outer" style={{ width: deviceWidth * zoom }}>
            <div className="hb-frame-label">{device} · {deviceWidth}px</div>
            <div
              ref={frameRef}
              className={`hb-frame ${isDragging ? 'dragging' : ''}`}
              style={{ width: deviceWidth, transform: `scale(${zoom})` }}
            >
              {/* allow-scripts is required: without it WebKit suppresses ALL
                  event listeners inside the document — even ones attached from
                  the parent — leaving the canvas inert. Same-origin + scripts
                  matches how Webflow/GrapesJS canvases run page content. */}
              <iframe
                ref={iframeRef}
                className="hb-iframe"
                sandbox="allow-same-origin allow-scripts"
                title="HTML Builder Canvas"
              />
              {bodyIsEmpty && !isDragging && (
                <div className="hb-canvas-hint">
                  <div className="hb-empty-card">
                    <div className="hb-empty-title">Blank page</div>
                    <div className="hb-empty-sub">Pick a starting point, or drag blocks from the left panel.</div>
                    <div className="hb-empty-actions">
                      {['template-landing', 'hero', 'navbar'].map((id) => {
                        const block = BUILDER_BLOCK_CATEGORIES.flatMap((c) => c.blocks).find((b) => b.id === id);
                        if (!block) return null;
                        return (
                          <button key={id} className="hb-btn hb-empty-btn" onClick={() => insertBlock(block)}>
                            {block.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
              <div className="hb-overlay">
                {hoverBox && (!selBox || hoverBox.x !== selBox.x || hoverBox.y !== selBox.y || hoverBox.w !== selBox.w) && (
                  <div className="hb-hover-box" style={{ left: hoverBox.x, top: hoverBox.y, width: hoverBox.w, height: hoverBox.h }}>
                    <span className={`hb-box-label ${labelBelow(hoverBox) ? 'below' : ''}`} style={{ opacity: 0.75 }}>{hoverBox.name}</span>
                  </div>
                )}
                {selBox && (
                  <div className="hb-sel-box" style={{ left: selBox.x, top: selBox.y, width: selBox.w, height: selBox.h }}>
                    <span className={`hb-box-label ${labelBelow(selBox) ? 'below' : ''}`}>{selBox.name}</span>
                    <span className="hb-size-badge">{Math.round(selBox.w)} × {Math.round(selBox.h)}</span>
                    {!editingText && (
                      <div className={`hb-sel-actions ${labelBelow(selBox) ? 'below' : ''}`}>
                        <button className="hb-btn" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); moveSelected(-1); }} title="Move up"><ArrowUp size={12} /></button>
                        <button className="hb-btn" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); moveSelected(1); }} title="Move down"><ArrowDown size={12} /></button>
                        <button className="hb-btn" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); duplicateSelected(); }} title="Duplicate (⌘D)"><CopyPlus size={12} /></button>
                        <button className="hb-btn" onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); deleteSelected(); }} title="Delete"><Trash2 size={12} /></button>
                      </div>
                    )}
                    {!editingText && (
                      <>
                        <span className="hb-handle e" onMouseDown={(e) => startResize('e', e)} />
                        <span className="hb-handle s" onMouseDown={(e) => startResize('s', e)} />
                        <span className="hb-handle se" onMouseDown={(e) => startResize('se', e)} />
                      </>
                    )}
                  </div>
                )}
                {dropLine && (
                  <div className="hb-drop-line" style={{ left: dropLine.x, top: dropLine.y - 1.5, width: dropLine.w }} />
                )}
                {dropInside && (
                  <div className="hb-drop-inside" style={{ left: dropInside.x, top: dropInside.y, width: dropInside.w, height: dropInside.h }} />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Inspector ── */}
        {showInspector && (
        <div className="hb-inspector">
          {!selStyles ? (
            <div className="hb-inspector-empty">
              Select an element on the canvas<br />to edit its styles.
            </div>
          ) : (
            <>
              {(selStyles.text !== null || selStyles.href !== null || selStyles.src !== null) && (
                <div className="hb-insp-section">
                  <div className="hb-insp-title">Content</div>
                  {selStyles.text !== null && (
                    <div className="hb-insp-row">
                      <textarea
                        className="hb-textarea"
                        rows={2}
                        value={selStyles.text}
                        onChange={(e) => applyText(e.target.value)}
                      />
                    </div>
                  )}
                  {selStyles.href !== null && (
                    <div className="hb-insp-row">
                      <span className="hb-insp-label">Link</span>
                      <input className="hb-input" value={selStyles.href} onChange={(e) => applyAttr('href', e.target.value)} placeholder="https://…" />
                    </div>
                  )}
                  {selStyles.src !== null && (
                    <>
                      <div className="hb-insp-row">
                        <span className="hb-insp-label">Source</span>
                        <input className="hb-input" value={selStyles.src} onChange={(e) => applyAttr('src', e.target.value)} placeholder="image url or path" />
                      </div>
                      <div className="hb-insp-row">
                        <span className="hb-insp-label">Alt</span>
                        <input className="hb-input" value={selStyles.alt ?? ''} onChange={(e) => applyAttr('alt', e.target.value)} />
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="hb-insp-section">
                <div className="hb-insp-title">Layout</div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Display</span>
                  <select className="hb-select" value={selStyles.display} onChange={(e) => applyStyle('display', e.target.value)}>
                    {['block', 'flex', 'inline-block', 'inline', 'grid', 'none'].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                {selStyles.display === 'flex' && (
                  <>
                    <div className="hb-insp-row">
                      <span className="hb-insp-label">Direction</span>
                      <select className="hb-select" value={selStyles.flexDirection} onChange={(e) => applyStyle('flex-direction', e.target.value)}>
                        {['row', 'column', 'row-reverse', 'column-reverse'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div className="hb-insp-row">
                      <span className="hb-insp-label">Justify</span>
                      <select className="hb-select" value={selStyles.justifyContent} onChange={(e) => applyStyle('justify-content', e.target.value)}>
                        {['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'normal'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div className="hb-insp-row">
                      <span className="hb-insp-label">Align</span>
                      <select className="hb-select" value={selStyles.alignItems} onChange={(e) => applyStyle('align-items', e.target.value)}>
                        {['stretch', 'flex-start', 'center', 'flex-end', 'baseline', 'normal'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div className="hb-insp-row">
                      <span className="hb-insp-label">Gap</span>
                      <input className="hb-input" value={selStyles.gap} onChange={(e) => applyStyle('gap', e.target.value)} placeholder="0px" />
                    </div>
                  </>
                )}
                <div className="hb-insp-row">
                  <span className="hb-insp-label">W × H</span>
                  <input className="hb-input" value={selStyles.width} onChange={(e) => applyStyle('width', e.target.value)} placeholder="auto" />
                  <input className="hb-input" value={selStyles.height} onChange={(e) => applyStyle('height', e.target.value)} placeholder="auto" />
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Max W</span>
                  <input className="hb-input" value={selStyles.maxWidth} onChange={(e) => applyStyle('max-width', e.target.value)} placeholder="none" />
                </div>
              </div>

              <div className="hb-insp-section">
                <div className="hb-insp-title">Spacing</div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Margin</span>
                  <div className="hb-quad">
                    {(['top', 'right', 'bottom', 'left'] as const).map((side, i) => (
                      <input
                        key={side}
                        type="number"
                        className="hb-input"
                        value={styleNum(selStyles.margin[i])}
                        onChange={(e) => applyStyle(`margin-${side}`, e.target.value === '' ? '' : `${e.target.value}px`)}
                      />
                    ))}
                  </div>
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label" />
                  <div className="hb-quad-tags"><span>T</span><span>R</span><span>B</span><span>L</span></div>
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Padding</span>
                  <div className="hb-quad">
                    {(['top', 'right', 'bottom', 'left'] as const).map((side, i) => (
                      <input
                        key={side}
                        type="number"
                        className="hb-input"
                        value={styleNum(selStyles.padding[i])}
                        onChange={(e) => applyStyle(`padding-${side}`, e.target.value === '' ? '' : `${e.target.value}px`)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="hb-insp-section">
                <div className="hb-insp-title">Typography</div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Size</span>
                  <input type="number" className="hb-input" value={styleNum(selStyles.fontSize)} onChange={(e) => applyStyle('font-size', e.target.value ? `${e.target.value}px` : '')} />
                  <select className="hb-select" value={selStyles.fontWeight} onChange={(e) => applyStyle('font-weight', e.target.value)}>
                    {['300', '400', '500', '600', '700', '800'].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Line</span>
                  <input className="hb-input" value={selStyles.lineHeight} onChange={(e) => applyStyle('line-height', e.target.value)} placeholder="1.5" />
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Align</span>
                  <div className="hb-seg">
                    {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([val, Icon]) => (
                      <button
                        key={val}
                        className={selStyles.textAlign === val || (val === 'left' && selStyles.textAlign === 'start') ? 'active' : ''}
                        onClick={() => applyStyle('text-align', val)}
                        title={`Align ${val}`}
                      >
                        <Icon size={12} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Color</span>
                  <input type="color" className="hb-color-input" value={selStyles.color} onChange={(e) => applyStyle('color', e.target.value)} />
                  <input className="hb-input" value={selStyles.color} onChange={(e) => applyStyle('color', e.target.value)} />
                </div>
              </div>

              <div className="hb-insp-section">
                <div className="hb-insp-title">Fill & Border</div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Fill</span>
                  <input type="color" className="hb-color-input" value={selStyles.backgroundColor} onChange={(e) => applyStyle('background-color', e.target.value)} />
                  <input className="hb-input" value={selStyles.backgroundColor} onChange={(e) => applyStyle('background-color', e.target.value)} />
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Border</span>
                  <input className="hb-input" style={{ maxWidth: 46 }} value={styleNum(selStyles.borderWidth)} onChange={(e) => applyStyle('border', e.target.value && e.target.value !== '0' ? `${e.target.value}px solid ${selStyles.borderColor}` : 'none')} />
                  <input type="color" className="hb-color-input" value={selStyles.borderColor} onChange={(e) => applyStyle('border-color', e.target.value)} />
                  <input className="hb-input" value={styleNum(selStyles.borderRadius)} onChange={(e) => applyStyle('border-radius', e.target.value ? `${e.target.value}px` : '')} placeholder="radius" />
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Shadow</span>
                  <div className="hb-seg">
                    {SHADOW_PRESETS.map((p) => (
                      <button key={p.label} onClick={() => applyStyle('box-shadow', p.value === 'none' ? '' : p.value)} title={p.value}>{p.label}</button>
                    ))}
                  </div>
                </div>
                <div className="hb-insp-row">
                  <span className="hb-insp-label">Opacity</span>
                  <input
                    className="hb-input"
                    type="range" min={0} max={1} step={0.05}
                    value={parseFloat(selStyles.opacity) || 1}
                    onChange={(e) => applyStyle('opacity', e.target.value === '1' ? '' : e.target.value)}
                  />
                </div>
              </div>

              {onTerminalPrompt && (
                <div className="hb-insp-section">
                  <div className="hb-insp-title"><Sparkles size={10} style={{ verticalAlign: -1 }} /> AI Edit</div>
                  <div className="hb-ai-row">
                    <input
                      className="hb-input"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendAiEdit(); }}
                      placeholder="Describe a change for this element…"
                    />
                    <button className="hb-btn" onClick={sendAiEdit} disabled={!aiPrompt.trim()} title="Send to terminal agent"><Send size={12} /></button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        )}
      </div>

      {/* ── Context menu (right-click on canvas) ── */}
      {ctxMenu && selStyles && (
        <div className="hb-ctx" style={{ left: ctxMenu.x, top: ctxMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {selElRef.current && isTextEditable(selElRef.current) && (
            <button onClick={() => { setCtxMenu(null); if (selElRef.current) startTextEdit(selElRef.current); }}>Edit Text<span>Enter</span></button>
          )}
          <button onClick={() => { setCtxMenu(null); duplicateSelected(); }}>Duplicate<span>⌘D</span></button>
          <button onClick={() => { setCtxMenu(null); copySelected(); }}>Copy<span>⌘C</span></button>
          <button disabled={!copiedHtmlRef.current} onClick={() => { setCtxMenu(null); pasteCopied(); }}>Paste<span>⌘V</span></button>
          <div className="hb-ctx-sep" />
          <button onClick={() => { setCtxMenu(null); moveSelected(-1); }}>Move Up<span>↑</span></button>
          <button onClick={() => { setCtxMenu(null); moveSelected(1); }}>Move Down<span>↓</span></button>
          <button onClick={() => {
            setCtxMenu(null);
            const parent = selElRef.current?.parentElement;
            const doc = getDoc();
            if (parent && doc && parent !== doc.body && parent.tagName !== 'HTML') select(parent);
          }}>Select Parent<span>⇧Enter</span></button>
          <div className="hb-ctx-sep" />
          <button className="danger" onClick={() => { setCtxMenu(null); deleteSelected(); }}>Delete<span>⌫</span></button>
        </div>
      )}

      {/* ── Breadcrumb ── */}
      <div className="hb-crumbs">
        <button className="hb-crumb" onClick={() => select(null)}>body</button>
        {crumbs.map((el, i) => (
          <React.Fragment key={i}>
            <span className="hb-crumb-sep">›</span>
            <button
              className={`hb-crumb ${i === crumbs.length - 1 ? 'current' : ''}`}
              onClick={() => select(el)}
            >
              {elementDisplayName(el)}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default HtmlBuilder;
