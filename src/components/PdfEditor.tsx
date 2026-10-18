/**
 * PdfEditor.tsx
 *
 * MS/Acrobat-class PDF viewer and editor:
 *   - Page thumbnail sidebar with delete / rotate / duplicate / move /
 *     insert-blank + drag reorder (page operations baked on save)
 *   - Annotations: text box, highlight, freehand, shapes (rectangle,
 *     ellipse, line, arrow), image / signature stamps
 *   - Undo / redo (snapshot stack), dirty tracking, inline find (Cmd+F)
 *   - Single top toolbar + toggleable annotation panel + 24px status bar,
 *     restyled to the shared office spec (--pe-* tokens from bg/text/accent)
 *
 * Built on top of:
 *   - react-pdf (v10) — PDF.js rendering (Document/Page, text + annotation layers)
 *   - pdf-lib (+ @pdf-lib/fontkit) — modification and saving
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Type, Highlighter, Pencil, RotateCw,
  Save, SaveAll, Trash2, MousePointer2,
  Square, Circle, Minus, ArrowUpRight, Image as ImageIcon, PenTool,
  Undo2, Redo2, Search, X, Copy, Plus, PanelRight,
  ChevronUp, ChevronDown,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import './PdfEditor.css';

// Configure PDF.js worker (required by react-pdf)
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
if (pdfjsWorkerUrl) {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
} else {
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
}

// ── Types ────────────────────────────────────────────────────────

interface PdfEditorProps {
  filePath: string;
  pdfData: string; // base64 data URL (data:application/pdf;base64,...)
  style: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onModifiedChange?: (modified: boolean) => void;
}

export type ToolMode =
  | 'select' | 'text' | 'highlight' | 'draw'
  | 'rect' | 'ellipse' | 'line' | 'arrow'
  | 'image' | 'signature';

export interface TextAnnotation {
  kind: 'text';
  id: string;
  page: number; // 1-based position in the current page order
  x: number; // percentage of page width
  y: number; // percentage of page height
  text: string;
  color: string;
  fontSize: number;
}

export interface HighlightAnnotation {
  kind: 'highlight';
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface DrawPath {
  kind: 'draw';
  id: string;
  page: number;
  points: { x: number; y: number }[];
  color: string;
  lineWidth: number;
}

export interface ShapeAnnotation {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow';
  id: string;
  page: number;
  x: number;
  y: number;
  x2: number;
  y2: number;
  color: string;
  lineWidth: number;
}

export interface ImageAnnotation {
  kind: 'image';
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string; // data:image/png|jpeg;base64,...
}

export type Annotation =
  | TextAnnotation | HighlightAnnotation | DrawPath | ShapeAnnotation | ImageAnnotation;

export function isTextAnnotation(a: Annotation): a is TextAnnotation { return a.kind === 'text'; }
export function isHighlightAnnotation(a: Annotation): a is HighlightAnnotation { return a.kind === 'highlight'; }
export function isDrawPath(a: Annotation): a is DrawPath { return a.kind === 'draw'; }
export function isShapeAnnotation(a: Annotation): a is ShapeAnnotation {
  return a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'line' || a.kind === 'arrow';
}
export function isImageAnnotation(a: Annotation): a is ImageAnnotation { return a.kind === 'image'; }

// A slot in the current page sequence. `src` is the 0-based index of the
// source page in the loaded PDF, or 'blank' for an inserted empty page.
export interface PageSlot {
  uid: string;
  src: number | 'blank';
  rotation: number; // extra rotation degrees added on top of the source page
}

export type PageOperation =
  | { kind: 'delete'; index: number }
  | { kind: 'rotate'; index: number; delta: number }
  | { kind: 'duplicate'; index: number }
  | { kind: 'move'; from: number; to: number }
  | { kind: 'insertBlank'; index: number }; // insert a blank page at slot position `index`

// ── Pure helpers (unit-tested in pdfEditor.test.ts) ──────────────

let uidCounter = 0;
export function makeUid(): string {
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}`;
}

export function hexToRgbTuple(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

export function createInitialPages(count: number): PageSlot[] {
  const pages: PageSlot[] = [];
  for (let i = 0; i < count; i++) {
    pages.push({ uid: makeUid(), src: i, rotation: 0 });
  }
  return pages;
}

// The page order is "identity" when it is the untouched 0..n-1 sequence with
// no extra rotation — i.e. the document was not structurally modified.
export function isIdentityPages(pages: PageSlot[], originalCount: number): boolean {
  if (pages.length !== originalCount) return false;
  return pages.every((p, i) => p.src === i && p.rotation === 0);
}

// Convert a top-left percentage point to bottom-left PDF coordinates.
export function pctPointToPdf(xPct: number, yPct: number, pw: number, ph: number): { x: number; y: number } {
  return { x: (xPct / 100) * pw, y: ph - (yPct / 100) * ph };
}

// Convert a top-left percentage rectangle to a bottom-left PDF rectangle.
export function pctRectToPdf(
  xPct: number, yPct: number, wPct: number, hPct: number, pw: number, ph: number,
): { x: number; y: number; width: number; height: number } {
  const width = (wPct / 100) * pw;
  const height = (hPct / 100) * ph;
  return { x: (xPct / 100) * pw, y: ph - (yPct / 100) * ph - height, width, height };
}

// Remap annotation page numbers (1-based) through a mapping. Annotations whose
// page maps to null are dropped.
export function remapAnnotationPages(
  annotations: Annotation[],
  map: (page: number) => number | null,
): Annotation[] {
  const out: Annotation[] = [];
  for (const a of annotations) {
    const next = map(a.page);
    if (next == null) continue;
    out.push(next === a.page ? a : { ...a, page: next });
  }
  return out;
}

// Apply a page operation, returning the new page order plus annotations whose
// page mapping has been shifted to follow their page.
export function applyPageOperation(
  pages: PageSlot[],
  annotations: Annotation[],
  op: PageOperation,
): { pages: PageSlot[]; annotations: Annotation[] } {
  switch (op.kind) {
    case 'rotate': {
      const next = pages.map((p, i) =>
        i === op.index ? { ...p, rotation: (((p.rotation + op.delta) % 360) + 360) % 360 } : p,
      );
      return { pages: next, annotations };
    }
    case 'delete': {
      if (pages.length <= 1) return { pages, annotations }; // never remove the last page
      const next = pages.filter((_, i) => i !== op.index);
      const removed = op.index + 1;
      const remapped = remapAnnotationPages(annotations, (page) => {
        if (page === removed) return null;
        return page > removed ? page - 1 : page;
      });
      return { pages: next, annotations: remapped };
    }
    case 'duplicate': {
      const next = [...pages];
      next.splice(op.index + 1, 0, { ...pages[op.index], uid: makeUid() });
      const after = op.index + 1; // new blank position is index+2 (1-based index+2)
      const remapped = remapAnnotationPages(annotations, (page) =>
        page > after ? page + 1 : page,
      );
      return { pages: next, annotations: remapped };
    }
    case 'insertBlank': {
      const next = [...pages];
      next.splice(op.index, 0, { uid: makeUid(), src: 'blank', rotation: 0 });
      const insertedAt = op.index + 1; // 1-based position of the new blank
      const remapped = remapAnnotationPages(annotations, (page) =>
        page >= insertedAt ? page + 1 : page,
      );
      return { pages: next, annotations: remapped };
    }
    case 'move': {
      if (op.from === op.to) return { pages, annotations };
      const next = [...pages];
      const [moved] = next.splice(op.from, 1);
      next.splice(op.to, 0, moved);
      // Build old(1-based) -> new(1-based) position map from the permutation.
      const map = new Map<number, number>();
      const order: number[] = [];
      for (let i = 0; i < pages.length; i++) order.push(i);
      const movedIdx = order.splice(op.from, 1)[0];
      order.splice(op.to, 0, movedIdx);
      order.forEach((oldIdx, newIdx) => map.set(oldIdx + 1, newIdx + 1));
      const remapped = remapAnnotationPages(annotations, (page) => map.get(page) ?? page);
      return { pages: next, annotations: remapped };
    }
  }
}

// ── Component ────────────────────────────────────────────────────

const BLANK_PAGE_WIDTH = 612;
const BLANK_PAGE_HEIGHT = 792;
const HISTORY_LIMIT = 50;

interface Snapshot {
  annotations: Annotation[];
  pages: PageSlot[];
}

export function PdfEditor({ filePath, pdfData, style, onSaved, onModifiedChange }: PdfEditorProps) {
  const [originalCount, setOriginalCount] = useState(0);
  const [pages, setPages] = useState<PageSlot[]>([]);
  const [currentPage, setCurrentPage] = useState(1); // 1-based slot position
  const [pageInputValue, setPageInputValue] = useState('1');
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<ToolMode>('select');
  const [penColor, setPenColor] = useState('#e02424');
  const [penWidth, setPenWidth] = useState(2);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pageError, setPageError] = useState('');
  const [showPanel, setShowPanel] = useState(true);

  // Find state
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<number[]>([]); // page positions containing the query
  const [findIndex, setFindIndex] = useState(0);

  // Signature modal
  const [signOpen, setSignOpen] = useState(false);

  const pageCount = pages.length;

  // Refs
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pdfProxyRef = useRef<any>(null);
  const pageTextCache = useRef<Map<number, string>>(new Map());
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const isDrawing = useRef(false);
  const currentDrawPoints = useRef<{ x: number; y: number }[]>([]);
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const annotationsRef = useRef(annotations);
  const pagesRef = useRef(pages);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragThumbFrom = useRef<number | null>(null);

  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);

  // Shape / highlight drag-create state
  const shapeStart = useRef<{ x: number; y: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);

  // Text / image move-drag state
  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; origW: number; origH: number } | null>(null);

  // Notify parent of dirty transitions
  useEffect(() => { onModifiedChange?.(modified); }, [modified, onModifiedChange]);

  const showToast = useCallback((kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Convert data URL to Uint8Array for react-pdf's Document file prop
  const pdfFileData = useMemo(() => {
    if (!pdfData) return null;
    const base64 = pdfData.replace(/^data:[^;]+;base64,/, '');
    if (!base64) return null;
    try {
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      return { data: bytes };
    } catch (e) {
      console.error('[PdfEditor] Failed to decode base64 data:', e);
      return null;
    }
  }, [pdfData]);

  // ── History ────────────────────────────────────────────────────
  const pushHistory = useCallback(() => {
    undoStack.current.push({ annotations: annotationsRef.current, pages: pagesRef.current });
    if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
    redoStack.current = [];
    setModified(true);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push({ annotations: annotationsRef.current, pages: pagesRef.current });
    setAnnotations(prev.annotations);
    setPages(prev.pages);
    setSelectedId(null);
    setModified(true);
    setCurrentPage((p) => Math.min(Math.max(1, p), Math.max(1, prev.pages.length)));
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push({ annotations: annotationsRef.current, pages: pagesRef.current });
    setAnnotations(next.annotations);
    setPages(next.pages);
    setSelectedId(null);
    setModified(true);
    setCurrentPage((p) => Math.min(Math.max(1, p), Math.max(1, next.pages.length)));
  }, []);

  // ── Document load ──────────────────────────────────────────────
  const onDocumentLoadSuccess = useCallback((pdf: any) => {
    pdfProxyRef.current = pdf;
    pageTextCache.current.clear();
    const n = pdf.numPages;
    setOriginalCount(n);
    setPages(createInitialPages(n));
    setAnnotations([]);
    undoStack.current = [];
    redoStack.current = [];
    setModified(false);
    setCurrentPage(1);
    setPageInputValue('1');
    setSelectedId(null);
    setLoadError('');
  }, []);

  // ── Freehand overlay canvas ────────────────────────────────────
  const redrawDrawAnnotations = useCallback(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pagePaths = annotations.filter((a) => isDrawPath(a) && a.page === currentPage) as DrawPath[];
    for (const path of pagePaths) {
      if (path.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = path.color;
      ctx.lineWidth = path.lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const first = path.points[0];
      ctx.moveTo((first.x / 100) * canvas.width, (first.y / 100) * canvas.height);
      for (let i = 1; i < path.points.length; i++) {
        const pt = path.points[i];
        ctx.lineTo((pt.x / 100) * canvas.width, (pt.y / 100) * canvas.height);
      }
      ctx.stroke();
    }
  }, [annotations, currentPage]);

  const syncDrawCanvas = useCallback(() => {
    const container = containerRef.current;
    const canvas = drawCanvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }
    redrawDrawAnnotations();
  }, [redrawDrawAnnotations]);

  useEffect(() => { syncDrawCanvas(); }, [syncDrawCanvas, currentPage, zoom, pages]);
  useEffect(() => {
    const handler = () => syncDrawCanvas();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [syncDrawCanvas]);

  // ── Navigation ─────────────────────────────────────────────────
  const goToPage = useCallback((page: number) => {
    setCurrentPage((cur) => {
      const p = Math.max(1, Math.min(pageCount || 1, page));
      setPageInputValue(String(p));
      if (p !== cur) setSelectedId(null);
      return p;
    });
  }, [pageCount]);

  const handlePageInput = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const val = parseInt(pageInputValue, 10);
      if (!isNaN(val)) goToPage(val);
    }
  }, [pageInputValue, goToPage]);

  // ── Page operations ────────────────────────────────────────────
  const runPageOp = useCallback((op: PageOperation) => {
    pushHistory();
    const result = applyPageOperation(pagesRef.current, annotationsRef.current, op);
    setPages(result.pages);
    setAnnotations(result.annotations);
    setSelectedId(null);
    setCurrentPage((p) => Math.min(Math.max(1, p), Math.max(1, result.pages.length)));
  }, [pushHistory]);

  const rotateCurrent = useCallback(() => runPageOp({ kind: 'rotate', index: currentPage - 1, delta: 90 }), [runPageOp, currentPage]);

  // ── Text annotations ───────────────────────────────────────────
  const addTextAt = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    pushHistory();
    const ann: TextAnnotation = {
      kind: 'text', id: makeUid(), page: currentPage, x, y, text: '', color: penColor, fontSize: 14,
    };
    setAnnotations((prev) => [...prev, ann]);
    setSelectedId(ann.id);
  }, [currentPage, penColor, pushHistory]);

  const handleTextDragStart = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedId(id);
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann || !isTextAnnotation(ann)) return;
    pushHistory();
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: ann.x, origY: ann.y };
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dx = ((ev.clientX - dragRef.current.startX) / rect.width) * 100;
      const dy = ((ev.clientY - dragRef.current.startY) / rect.height) * 100;
      setAnnotations((prev) => prev.map((a) =>
        a.id === dragRef.current!.id && isTextAnnotation(a)
          ? { ...a, x: dragRef.current!.origX + dx, y: dragRef.current!.origY + dy }
          : a));
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [pushHistory]);

  // ── Image annotations (move + resize) ─────────────────────────
  const handleImageDragStart = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedId(id);
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann || !isImageAnnotation(ann)) return;
    pushHistory();
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: ann.x, origY: ann.y };
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dx = ((ev.clientX - dragRef.current.startX) / rect.width) * 100;
      const dy = ((ev.clientY - dragRef.current.startY) / rect.height) * 100;
      setAnnotations((prev) => prev.map((a) =>
        a.id === dragRef.current!.id && isImageAnnotation(a)
          ? { ...a, x: dragRef.current!.origX + dx, y: dragRef.current!.origY + dy }
          : a));
    };
    const handleUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [pushHistory]);

  const handleImageResizeStart = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const ann = annotationsRef.current.find((a) => a.id === id);
    if (!ann || !isImageAnnotation(ann)) return;
    pushHistory();
    resizeRef.current = { id, startX: e.clientX, startY: e.clientY, origW: ann.width, origH: ann.height };
    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const dw = ((ev.clientX - resizeRef.current.startX) / rect.width) * 100;
      const dh = ((ev.clientY - resizeRef.current.startY) / rect.height) * 100;
      setAnnotations((prev) => prev.map((a) =>
        a.id === resizeRef.current!.id && isImageAnnotation(a)
          ? { ...a, width: Math.max(3, resizeRef.current!.origW + dw), height: Math.max(3, resizeRef.current!.origH + dh) }
          : a));
    };
    const handleUp = () => {
      resizeRef.current = null;
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [pushHistory]);

  const insertImageAnnotation = useCallback((dataUrl: string) => {
    pushHistory();
    const ann: ImageAnnotation = {
      kind: 'image', id: makeUid(), page: currentPage, x: 30, y: 30, width: 30, height: 20, dataUrl,
    };
    setAnnotations((prev) => [...prev, ann]);
    setSelectedId(ann.id);
    setTool('select');
  }, [currentPage, pushHistory]);

  const onImageFileChosen = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      if (url.startsWith('data:image/')) insertImageAnnotation(url);
    };
    reader.readAsDataURL(file);
  }, [insertImageAnnotation]);

  // ── Freehand drawing ───────────────────────────────────────────
  const handleDrawMouseDown = useCallback((e: React.MouseEvent) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    syncDrawCanvas();
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    isDrawing.current = true;
    currentDrawPoints.current = [{ x, y }];
  }, [syncDrawCanvas]);

  const handleDrawMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing.current) return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    currentDrawPoints.current.push({ x, y });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pts = currentDrawPoints.current;
    if (pts.length < 2) return;
    const prev = pts[pts.length - 2];
    const cur = pts[pts.length - 1];
    ctx.beginPath();
    ctx.strokeStyle = penColor;
    ctx.lineWidth = penWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo((prev.x / 100) * canvas.width, (prev.y / 100) * canvas.height);
    ctx.lineTo((cur.x / 100) * canvas.width, (cur.y / 100) * canvas.height);
    ctx.stroke();
  }, [penColor, penWidth]);

  const handleDrawMouseUp = useCallback(() => {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    const pts = currentDrawPoints.current;
    if (pts.length < 2) return;
    pushHistory();
    const path: DrawPath = {
      kind: 'draw', id: makeUid(), page: currentPage, points: [...pts], color: penColor, lineWidth: penWidth,
    };
    setAnnotations((prev) => [...prev, path]);
    currentDrawPoints.current = [];
  }, [currentPage, penColor, penWidth, pushHistory]);

  // ── Highlight + shape drag-create (rect / ellipse / line / arrow) ─
  const dragCreateStart = useCallback((e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    shapeStart.current = { x, y };
    setShapePreview({ x, y, x2: x, y2: y });
  }, []);

  const dragCreateMove = useCallback((e: React.MouseEvent) => {
    if (!shapeStart.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setShapePreview({ x: shapeStart.current.x, y: shapeStart.current.y, x2: x, y2: y });
  }, []);

  const dragCreateEnd = useCallback((e: React.MouseEvent) => {
    if (!shapeStart.current) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const start = shapeStart.current;
    shapeStart.current = null;
    setShapePreview(null);

    if (tool === 'highlight') {
      const w = Math.abs(x - start.x);
      const h = Math.abs(y - start.y);
      if (w < 1 && h < 1) return;
      pushHistory();
      const ann: HighlightAnnotation = {
        kind: 'highlight', id: makeUid(), page: currentPage,
        x: Math.min(start.x, x), y: Math.min(start.y, y), width: w, height: h, color: penColor,
      };
      setAnnotations((prev) => [...prev, ann]);
      return;
    }
    // Shapes
    const dist = Math.hypot(x - start.x, y - start.y);
    if (dist < 1) return;
    pushHistory();
    const ann: ShapeAnnotation = {
      kind: tool as ShapeAnnotation['kind'], id: makeUid(), page: currentPage,
      x: start.x, y: start.y, x2: x, y2: y, color: penColor, lineWidth: penWidth,
    };
    setAnnotations((prev) => [...prev, ann]);
  }, [tool, currentPage, penColor, penWidth, pushHistory]);

  // ── Delete ─────────────────────────────────────────────────────
  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    pushHistory();
    setAnnotations((prev) => prev.filter((a) => a.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, pushHistory]);

  const deleteAnnotation = useCallback((id: string) => {
    pushHistory();
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
  }, [selectedId, pushHistory]);

  // ── Overlay routing ────────────────────────────────────────────
  const isDragTool = tool === 'highlight' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow';

  const handleOverlayMouseDown = useCallback((e: React.MouseEvent) => {
    if (tool === 'text') { addTextAt(e); return; }
    if (isDragTool) { dragCreateStart(e); return; }
    if (tool === 'draw') { handleDrawMouseDown(e); return; }
    setSelectedId(null);
  }, [tool, isDragTool, addTextAt, dragCreateStart, handleDrawMouseDown]);

  const handleOverlayMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragTool) { dragCreateMove(e); return; }
    if (tool === 'draw') { handleDrawMouseMove(e); return; }
  }, [tool, isDragTool, dragCreateMove, handleDrawMouseMove]);

  const handleOverlayMouseUp = useCallback((e: React.MouseEvent) => {
    if (isDragTool) { dragCreateEnd(e); return; }
    if (tool === 'draw') { handleDrawMouseUp(); return; }
  }, [tool, isDragTool, dragCreateEnd, handleDrawMouseUp]);

  // ── Find (Cmd+F) ───────────────────────────────────────────────
  const getPageText = useCallback(async (slotPos: number): Promise<string> => {
    const slot = pagesRef.current[slotPos - 1];
    if (!slot || slot.src === 'blank') return '';
    const srcNum = slot.src + 1;
    const cached = pageTextCache.current.get(srcNum);
    if (cached != null) return cached;
    const pdf = pdfProxyRef.current;
    if (!pdf) return '';
    try {
      const page = await pdf.getPage(srcNum);
      const content = await page.getTextContent();
      const text = content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ');
      pageTextCache.current.set(srcNum, text);
      return text;
    } catch {
      return '';
    }
  }, []);

  const runFind = useCallback(async (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) { setFindMatches([]); setFindIndex(0); return; }
    const hits: number[] = [];
    for (let pos = 1; pos <= pagesRef.current.length; pos++) {
      const text = await getPageText(pos);
      if (text.toLowerCase().includes(q)) hits.push(pos);
    }
    setFindMatches(hits);
    setFindIndex(0);
    if (hits.length > 0) goToPage(hits[0]);
  }, [getPageText, goToPage]);

  const stepFind = useCallback((dir: 1 | -1) => {
    setFindIndex((idx) => {
      if (findMatches.length === 0) return 0;
      const next = (idx + dir + findMatches.length) % findMatches.length;
      goToPage(findMatches[next]);
      return next;
    });
  }, [findMatches, goToPage]);

  const openFind = useCallback(() => { setFindOpen(true); }, []);
  const closeFind = useCallback(() => { setFindOpen(false); setFindMatches([]); setFindIndex(0); }, []);

  // ── Save ───────────────────────────────────────────────────────
  const handleSave = useCallback(async (saveAs?: boolean) => {
    setSaveBusy(true);
    try {
      const { PDFDocument, rgb, StandardFonts, degrees } = await import('pdf-lib');
      const base64 = pdfData.replace(/^data:[^;]+;base64,/, '');
      if (!base64) throw new Error('PDF data is empty');
      const srcBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const srcDoc = await PDFDocument.load(srcBytes);
      const outDoc = await PDFDocument.create();

      const curPages = pagesRef.current;
      const curAnnos = annotationsRef.current;

      // Embed a CJK-capable font only when a text annotation needs it.
      const hasNonAscii = curAnnos.some((a) => isTextAnnotation(a) && /[^\x00-\x7F]/.test(a.text));
      let textFont: any;
      if (hasNonAscii) {
        try {
          const fontkit = (await import('@pdf-lib/fontkit')).default;
          outDoc.registerFontkit(fontkit);
          const fontPaths = [
            '/System/Library/Fonts/Supplemental/AppleGothic.ttf',
            '/System/Library/Fonts/AppleSDGothicNeo.ttc',
            '/Library/Fonts/Arial Unicode.ttf',
            'C:\\Windows\\Fonts\\malgun.ttf',
            'C:\\Windows\\Fonts\\msgothic.ttc',
            '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          ];
          let loaded = false;
          for (const fp of fontPaths) {
            try {
              const fontBase64: string = await invoke('read_file_base64', { path: fp });
              const fontBytes = Uint8Array.from(atob(fontBase64), (c) => c.charCodeAt(0));
              textFont = await outDoc.embedFont(fontBytes);
              loaded = true;
              break;
            } catch { continue; }
          }
          if (!loaded) throw new Error('no CJK font');
        } catch {
          textFont = await outDoc.embedFont(StandardFonts.Helvetica);
        }
      } else {
        textFont = await outDoc.embedFont(StandardFonts.Helvetica);
      }

      // Rebuild the document in the current page order (handles reorder,
      // delete, duplicate, blank inserts, and extra rotation).
      let lastRealSize = { w: BLANK_PAGE_WIDTH, h: BLANK_PAGE_HEIGHT };
      for (const slot of curPages) {
        if (slot.src === 'blank') {
          const page = outDoc.addPage([lastRealSize.w, lastRealSize.h]);
          if (slot.rotation) page.setRotation(degrees(slot.rotation % 360));
        } else {
          const [copied] = await outDoc.copyPages(srcDoc, [slot.src]);
          const size = copied.getSize();
          lastRealSize = { w: size.width, h: size.height };
          if (slot.rotation) {
            const base = copied.getRotation().angle;
            copied.setRotation(degrees((base + slot.rotation) % 360));
          }
          outDoc.addPage(copied);
        }
      }

      const outPages = outDoc.getPages();
      for (const ann of curAnnos) {
        const pageIdx = ann.page - 1;
        if (pageIdx < 0 || pageIdx >= outPages.length) continue;
        const page = outPages[pageIdx];
        const { width: pw, height: ph } = page.getSize();

        if (isTextAnnotation(ann)) {
          const [r, g, b] = hexToRgbTuple(ann.color);
          const pt = pctPointToPdf(ann.x, ann.y, pw, ph);
          page.drawText(ann.text || ' ', {
            x: pt.x, y: pt.y - ann.fontSize, size: ann.fontSize, font: textFont, color: rgb(r, g, b),
          });
        } else if (isHighlightAnnotation(ann)) {
          const [r, g, b] = hexToRgbTuple(ann.color);
          const rc = pctRectToPdf(ann.x, ann.y, ann.width, ann.height, pw, ph);
          page.drawRectangle({ x: rc.x, y: rc.y, width: rc.width, height: rc.height, color: rgb(r, g, b), opacity: 0.3 });
        } else if (isDrawPath(ann)) {
          const [r, g, b] = hexToRgbTuple(ann.color);
          if (ann.points.length >= 2) {
            let svgPath = `M ${(ann.points[0].x / 100) * pw} ${ph - (ann.points[0].y / 100) * ph}`;
            for (let i = 1; i < ann.points.length; i++) {
              svgPath += ` L ${(ann.points[i].x / 100) * pw} ${ph - (ann.points[i].y / 100) * ph}`;
            }
            page.drawSvgPath(svgPath, { borderColor: rgb(r, g, b), borderWidth: ann.lineWidth });
          }
        } else if (isShapeAnnotation(ann)) {
          const [r, g, b] = hexToRgbTuple(ann.color);
          const color = rgb(r, g, b);
          const p1 = pctPointToPdf(ann.x, ann.y, pw, ph);
          const p2 = pctPointToPdf(ann.x2, ann.y2, pw, ph);
          if (ann.kind === 'rect') {
            page.drawRectangle({
              x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y),
              width: Math.abs(p2.x - p1.x), height: Math.abs(p2.y - p1.y),
              borderColor: color, borderWidth: ann.lineWidth,
            });
          } else if (ann.kind === 'ellipse') {
            page.drawEllipse({
              x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2,
              xScale: Math.abs(p2.x - p1.x) / 2, yScale: Math.abs(p2.y - p1.y) / 2,
              borderColor: color, borderWidth: ann.lineWidth,
            });
          } else if (ann.kind === 'line') {
            page.drawLine({ start: p1, end: p2, thickness: ann.lineWidth, color });
          } else if (ann.kind === 'arrow') {
            page.drawLine({ start: p1, end: p2, thickness: ann.lineWidth, color });
            const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
            const head = 8 + ann.lineWidth * 2;
            const spread = Math.PI / 7;
            page.drawLine({
              start: p2,
              end: { x: p2.x - head * Math.cos(angle - spread), y: p2.y - head * Math.sin(angle - spread) },
              thickness: ann.lineWidth, color,
            });
            page.drawLine({
              start: p2,
              end: { x: p2.x - head * Math.cos(angle + spread), y: p2.y - head * Math.sin(angle + spread) },
              thickness: ann.lineWidth, color,
            });
          }
        } else if (isImageAnnotation(ann)) {
          try {
            const imgBase64 = ann.dataUrl.replace(/^data:[^;]+;base64,/, '');
            const imgBytes = Uint8Array.from(atob(imgBase64), (c) => c.charCodeAt(0));
            const embedded = ann.dataUrl.startsWith('data:image/png')
              ? await outDoc.embedPng(imgBytes)
              : await outDoc.embedJpg(imgBytes);
            const rc = pctRectToPdf(ann.x, ann.y, ann.width, ann.height, pw, ph);
            page.drawImage(embedded, { x: rc.x, y: rc.y, width: rc.width, height: rc.height });
          } catch (e) {
            console.warn('[PdfEditor] image embed failed:', e);
          }
        }
      }

      const savedBytes = await outDoc.save();
      const chunks: string[] = [];
      const chunkSize = 32768;
      for (let i = 0; i < savedBytes.length; i += chunkSize) {
        chunks.push(String.fromCharCode.apply(null, Array.from(savedBytes.subarray(i, i + chunkSize))));
      }
      const savedBase64 = btoa(chunks.join(''));

      let targetPath = filePath;
      if (saveAs) {
        const name = filePath.split('/').pop() || 'document.pdf';
        try {
          const result = await invoke<string | null>('save_file_dialog', {
            defaultName: name, filters: [['PDF', ['pdf']]],
          });
          if (!result) { setSaveBusy(false); return; }
          targetPath = result;
        } catch {
          setSaveBusy(false);
          return;
        }
      }

      await invoke('write_file_base64', { path: targetPath, base64Data: savedBase64 });

      // Clear the overlay so the reloaded (already-baked) file doesn't double-bake.
      const finalCount = curPages.length;
      setAnnotations([]);
      setPages(createInitialPages(finalCount));
      setOriginalCount(finalCount);
      undoStack.current = [];
      redoStack.current = [];
      setSelectedId(null);
      setModified(false);
      pageTextCache.current.clear();

      onSaved?.(targetPath);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      showToast('ok', `Saved ${hhmm}`);
    } catch (err: any) {
      console.error('[PdfEditor] Save failed:', err);
      showToast('err', 'Save failed');
    } finally {
      setSaveBusy(false);
    }
  }, [pdfData, filePath, onSaved, showToast]);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (meta && e.key.toLowerCase() === 's' && !e.shiftKey) { e.preventDefault(); handleSave(); return; }
      if (meta && e.key.toLowerCase() === 's' && e.shiftKey) { e.preventDefault(); handleSave(true); return; }
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (meta && (e.key.toLowerCase() === 'z' && e.shiftKey || e.key.toLowerCase() === 'y')) { e.preventDefault(); redo(); return; }
      if (meta && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
      if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2))); return; }
      if (meta && e.key === '-') { e.preventDefault(); setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2))); return; }
      if (meta && e.key === '0') { e.preventDefault(); setZoom(1); return; }

      if (inField) return;

      if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
      if (e.key === 'ArrowLeft' && !meta) { goToPage(currentPage - 1); return; }
      if (e.key === 'ArrowRight' && !meta) { goToPage(currentPage + 1); return; }
      if (e.key === 'v' || e.key === 'V') { setTool('select'); return; }
      if (e.key === 't' || e.key === 'T') { setTool('text'); return; }
      if (e.key === 'h' || e.key === 'H') { setTool('highlight'); return; }
      if (e.key === 'd' || e.key === 'D') { setTool('draw'); return; }
      if (e.key === 'r' || e.key === 'R') { rotateCurrent(); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, undo, redo, openFind, deleteSelected, goToPage, currentPage, rotateCurrent]);

  // ── Derived ────────────────────────────────────────────────────
  const currentSlot = pages[currentPage - 1];
  const pageAnnotations = annotations.filter((a) => a.page === currentPage);
  const pageTextAnnotations = pageAnnotations.filter(isTextAnnotation);
  const pageHighlightAnnotations = pageAnnotations.filter(isHighlightAnnotation);
  const pageShapeAnnotations = pageAnnotations.filter(isShapeAnnotation);
  const pageImageAnnotations = pageAnnotations.filter(isImageAnnotation);

  const annotationLabel = (a: Annotation): string => {
    if (isTextAnnotation(a)) return a.text.slice(0, 18) || 'Text';
    if (isHighlightAnnotation(a)) return 'Highlight';
    if (isDrawPath(a)) return 'Drawing';
    if (isImageAnnotation(a)) return 'Image';
    return a.kind.charAt(0).toUpperCase() + a.kind.slice(1);
  };
  const annotationIcon = (a: Annotation) => {
    if (isTextAnnotation(a)) return <Type size={11} />;
    if (isHighlightAnnotation(a)) return <Highlighter size={11} />;
    if (isDrawPath(a)) return <Pencil size={11} />;
    if (isImageAnnotation(a)) return <ImageIcon size={11} />;
    if (a.kind === 'rect') return <Square size={11} />;
    if (a.kind === 'ellipse') return <Circle size={11} />;
    if (a.kind === 'line') return <Minus size={11} />;
    return <ArrowUpRight size={11} />;
  };

  const rootStyle: React.CSSProperties = {
    color: style.text,
    background: style.bg,
    ['--pe-bg' as any]: style.bg,
    ['--pe-text' as any]: style.text,
    ['--pe-accent' as any]: style.accent,
  };

  const overlayClass = `pe-annotation-layer${tool !== 'select' ? ' pe-interactive' : ''}`
    + `${tool === 'draw' ? ' pe-drawing' : ''}${isDragTool ? ' pe-crosshair' : ''}`;

  return (
    <div className="pdf-editor" style={rootStyle}>
      {/* Single top toolbar */}
      <div className="pe-toolbar">
        <div className="pe-toolbar-group">
          <button className="pe-btn pe-btn-primary" onClick={() => handleSave()} disabled={saveBusy} title="Save (Cmd+S)">
            <Save size={14} />
          </button>
          <button className="pe-btn" onClick={() => handleSave(true)} disabled={saveBusy} title="Save As (Cmd+Shift+S)">
            <SaveAll size={14} />
          </button>
        </div>
        <div className="pe-toolbar-sep" />

        <div className="pe-toolbar-group">
          <button className="pe-btn" onClick={undo} disabled={undoStack.current.length === 0} title="Undo (Cmd+Z)">
            <Undo2 size={14} />
          </button>
          <button className="pe-btn" onClick={redo} disabled={redoStack.current.length === 0} title="Redo (Cmd+Shift+Z)">
            <Redo2 size={14} />
          </button>
        </div>
        <div className="pe-toolbar-sep" />

        <div className="pe-toolbar-group">
          <button className={`pe-btn ${tool === 'select' ? 'active' : ''}`} onClick={() => setTool('select')} title="Select (V)"><MousePointer2 size={14} /></button>
          <button className={`pe-btn ${tool === 'text' ? 'active' : ''}`} onClick={() => setTool('text')} title="Text (T)"><Type size={14} /></button>
          <button className={`pe-btn ${tool === 'highlight' ? 'active' : ''}`} onClick={() => setTool('highlight')} title="Highlight (H)"><Highlighter size={14} /></button>
          <button className={`pe-btn ${tool === 'draw' ? 'active' : ''}`} onClick={() => setTool('draw')} title="Draw (D)"><Pencil size={14} /></button>
          <button className={`pe-btn ${tool === 'rect' ? 'active' : ''}`} onClick={() => setTool('rect')} title="Rectangle"><Square size={14} /></button>
          <button className={`pe-btn ${tool === 'ellipse' ? 'active' : ''}`} onClick={() => setTool('ellipse')} title="Ellipse"><Circle size={14} /></button>
          <button className={`pe-btn ${tool === 'line' ? 'active' : ''}`} onClick={() => setTool('line')} title="Line"><Minus size={14} /></button>
          <button className={`pe-btn ${tool === 'arrow' ? 'active' : ''}`} onClick={() => setTool('arrow')} title="Arrow"><ArrowUpRight size={14} /></button>
          <button className="pe-btn" onClick={() => imageInputRef.current?.click()} title="Insert image"><ImageIcon size={14} /></button>
          <button className="pe-btn" onClick={() => setSignOpen(true)} title="Signature"><PenTool size={14} /></button>
        </div>
        <div className="pe-toolbar-sep" />

        <div className="pe-toolbar-group">
          <label className="pe-color-btn" title="Color">
            <span className="pe-color-swatch" style={{ background: penColor }} />
            <input type="color" value={penColor} onChange={(e) => setPenColor(e.target.value)} />
          </label>
          <input className="pe-range" type="range" min={1} max={20} value={penWidth} onChange={(e) => setPenWidth(+e.target.value)} title="Stroke width" />
          <span className="pe-range-value">{penWidth}px</span>
        </div>
        <div className="pe-toolbar-sep" />

        <button className="pe-btn" onClick={rotateCurrent} title="Rotate page (R)"><RotateCw size={14} /></button>
        <button className="pe-btn" onClick={deleteSelected} disabled={!selectedId} title="Delete selection"><Trash2 size={14} /></button>

        <div className="pe-toolbar-group pe-toolbar-right">
          <button className="pe-btn" onClick={openFind} title="Find (Cmd+F)"><Search size={14} /></button>
          <button className={`pe-btn ${showPanel ? 'active' : ''}`} onClick={() => setShowPanel((s) => !s)} title="Toggle annotation panel"><PanelRight size={14} /></button>
        </div>
      </div>

      {/* Find bar */}
      {findOpen && (
        <div className="pe-find-bar">
          <Search size={13} className="pe-find-icon" />
          <input
            className="pe-find-input"
            autoFocus
            value={findQuery}
            placeholder="Find in document"
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (findMatches.length) stepFind(e.shiftKey ? -1 : 1); else runFind(findQuery); }
              if (e.key === 'Escape') closeFind();
            }}
          />
          <span className="pe-find-count">{findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0/0'}</span>
          <button className="pe-btn pe-find-nav" onClick={() => runFind(findQuery)} title="Search">Go</button>
          <button className="pe-btn pe-find-nav" onClick={() => stepFind(-1)} disabled={!findMatches.length} title="Previous"><ChevronLeft size={14} /></button>
          <button className="pe-btn pe-find-nav" onClick={() => stepFind(1)} disabled={!findMatches.length} title="Next"><ChevronRight size={14} /></button>
          <button className="pe-btn pe-find-close" onClick={closeFind} title="Close"><X size={14} /></button>
        </div>
      )}

      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={onImageFileChosen} />

      <div className="pe-body">
        {!pdfFileData ? (
          <div className="pe-loading">Cannot read PDF data.</div>
        ) : loadError ? (
          <div className="pe-loading pe-loading-error">
            <div>Failed to load PDF</div>
            <div className="pe-loading-detail">{loadError}</div>
          </div>
        ) : (
          <Document
            file={pdfFileData}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={(err) => setLoadError(err?.message || String(err))}
            loading={<div className="pe-loading">Loading PDF…</div>}
            error={<div className="pe-loading pe-loading-error">Failed to load PDF</div>}
            className="pe-document"
          >
            {/* Thumbnail sidebar */}
            <div className="pe-thumbs">
              {pages.map((slot, i) => (
                <ThumbnailItem
                  key={slot.uid}
                  slot={slot}
                  position={i + 1}
                  active={i + 1 === currentPage}
                  onSelect={() => goToPage(i + 1)}
                  onRotate={() => runPageOp({ kind: 'rotate', index: i, delta: 90 })}
                  onDuplicate={() => runPageOp({ kind: 'duplicate', index: i })}
                  onDelete={() => runPageOp({ kind: 'delete', index: i })}
                  onInsertBlank={() => runPageOp({ kind: 'insertBlank', index: i + 1 })}
                  onMoveUp={i > 0 ? () => runPageOp({ kind: 'move', from: i, to: i - 1 }) : undefined}
                  onMoveDown={i < pages.length - 1 ? () => runPageOp({ kind: 'move', from: i, to: i + 1 }) : undefined}
                  canDelete={pages.length > 1}
                  onDragStartThumb={() => { dragThumbFrom.current = i; }}
                  onDropThumb={() => {
                    const from = dragThumbFrom.current;
                    dragThumbFrom.current = null;
                    if (from != null && from !== i) runPageOp({ kind: 'move', from, to: i });
                  }}
                />
              ))}
            </div>

            {/* Canvas area */}
            <div className="pe-canvas-wrap">
              <div className="pe-page-container" ref={containerRef}>
                {currentSlot && currentSlot.src === 'blank' ? (
                  <div
                    className="pe-blank-page"
                    style={{ width: BLANK_PAGE_WIDTH * zoom, height: BLANK_PAGE_HEIGHT * zoom }}
                    onLoad={() => syncDrawCanvas()}
                  />
                ) : currentSlot ? (
                  <Page
                    pageNumber={(currentSlot.src as number) + 1}
                    scale={zoom}
                    rotate={currentSlot.rotation}
                    renderTextLayer={tool === 'select'}
                    renderAnnotationLayer={tool === 'select'}
                    loading={<div className="pe-loading">Loading page…</div>}
                    onRenderSuccess={() => { setPageError(''); syncDrawCanvas(); }}
                    onRenderError={(err) => setPageError(err?.message || String(err))}
                    error={<div className="pe-loading pe-loading-error">Failed to render page{pageError ? `: ${pageError}` : ''}</div>}
                  />
                ) : null}

                <canvas ref={drawCanvasRef} className={`pe-draw-canvas ${tool === 'draw' ? 'pe-active' : ''}`} />

                <div
                  className={overlayClass}
                  onMouseDown={handleOverlayMouseDown}
                  onMouseMove={handleOverlayMouseMove}
                  onMouseUp={handleOverlayMouseUp}
                >
                  {/* Highlights */}
                  {pageHighlightAnnotations.map((h) => (
                    <div
                      key={h.id}
                      className={`pe-highlight-annotation ${selectedId === h.id ? 'pe-selected' : ''}`}
                      style={{ left: `${h.x}%`, top: `${h.y}%`, width: `${h.width}%`, height: `${h.height}%`, background: h.color, opacity: 0.3 }}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(h.id); }}
                    />
                  ))}

                  {/* Shapes via SVG */}
                  {(pageShapeAnnotations.length > 0 || shapePreview) && (
                    <svg className="pe-shape-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {pageShapeAnnotations.map((s) => (
                        <ShapeSvg key={s.id} shape={s} selected={selectedId === s.id} onSelect={() => setSelectedId(s.id)} />
                      ))}
                      {shapePreview && tool !== 'highlight' && (
                        <ShapeSvg
                          shape={{ kind: (tool as ShapeAnnotation['kind']), id: '__preview', page: currentPage, x: shapePreview.x, y: shapePreview.y, x2: shapePreview.x2, y2: shapePreview.y2, color: penColor, lineWidth: penWidth }}
                          preview
                        />
                      )}
                    </svg>
                  )}

                  {/* Highlight preview */}
                  {shapePreview && tool === 'highlight' && (
                    <div
                      style={{
                        position: 'absolute',
                        left: `${Math.min(shapePreview.x, shapePreview.x2)}%`,
                        top: `${Math.min(shapePreview.y, shapePreview.y2)}%`,
                        width: `${Math.abs(shapePreview.x2 - shapePreview.x)}%`,
                        height: `${Math.abs(shapePreview.y2 - shapePreview.y)}%`,
                        background: penColor, opacity: 0.2, border: `1px dashed ${penColor}`, pointerEvents: 'none',
                      }}
                    />
                  )}

                  {/* Images */}
                  {pageImageAnnotations.map((img) => (
                    <div
                      key={img.id}
                      className={`pe-image-annotation ${selectedId === img.id ? 'pe-selected' : ''}`}
                      style={{ left: `${img.x}%`, top: `${img.y}%`, width: `${img.width}%`, height: `${img.height}%` }}
                      onMouseDown={(e) => handleImageDragStart(e, img.id)}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(img.id); }}
                    >
                      <img src={img.dataUrl} alt="" draggable={false} />
                      {selectedId === img.id && (
                        <span className="pe-resize-handle" onMouseDown={(e) => handleImageResizeStart(e, img.id)} />
                      )}
                    </div>
                  ))}

                  {/* Text boxes */}
                  {pageTextAnnotations.map((ta) => (
                    <div
                      key={ta.id}
                      className={`pe-text-annotation ${selectedId === ta.id ? 'pe-selected' : ''}`}
                      style={{ left: `${ta.x}%`, top: `${ta.y}%`, color: ta.color, fontSize: ta.fontSize }}
                      onMouseDown={(e) => handleTextDragStart(e, ta.id)}
                      onClick={(e) => { e.stopPropagation(); setSelectedId(ta.id); }}
                    >
                      <textarea
                        value={ta.text}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAnnotations((prev) => prev.map((a) => (a.id === ta.id ? { ...a, text: val } : a)));
                        }}
                        onFocus={() => { if (!modified) setModified(true); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        placeholder="Type…"
                        rows={1}
                        style={{ color: ta.color, fontSize: ta.fontSize }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Annotation panel */}
            {showPanel && (
              <div className="pe-props-panel">
                <div className="pe-panel-title">Annotations</div>
                <div className="pe-annotation-list">
                  {pageAnnotations.length === 0 && <span className="pe-panel-empty">No annotations on this page</span>}
                  {pageAnnotations.map((a) => (
                    <div
                      key={a.id}
                      className={`pe-annotation-item ${selectedId === a.id ? 'pe-selected' : ''}`}
                      onClick={() => setSelectedId(a.id)}
                    >
                      {annotationIcon(a)}
                      <span className="pe-annotation-name">{annotationLabel(a)}</span>
                      <button className="pe-annotation-delete" onClick={(e) => { e.stopPropagation(); deleteAnnotation(a.id); }} title="Delete">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="pe-panel-title">Document</div>
                <span className="pe-panel-empty">{annotations.length} annotations · {pageCount} pages</span>
              </div>
            )}
          </Document>
        )}
      </div>

      {/* Bottom status bar */}
      <div className="pe-bottom-bar">
        <div className="pe-status-left">
          <span className="pe-status-pill">PDF</span>
          <span className={`pe-save-state ${modified ? 'is-modified' : ''}`}>{modified ? '● Modified' : 'Saved'}</span>
          <span className="pe-status-name">{filePath.split('/').pop()}</span>
        </div>
        <div className="pe-status-center">
          <button className="pe-page-btn" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="Previous page"><ChevronLeft size={13} /></button>
          <input
            className="pe-page-input"
            value={pageInputValue}
            onChange={(e) => setPageInputValue(e.target.value)}
            onKeyDown={handlePageInput}
            onBlur={() => {
              const val = parseInt(pageInputValue, 10);
              if (!isNaN(val)) goToPage(val); else setPageInputValue(String(currentPage));
            }}
          />
          <span className="pe-page-total">/ {pageCount}</span>
          <button className="pe-page-btn" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount} title="Next page"><ChevronRight size={13} /></button>
        </div>
        <div className="pe-status-right">
          <button className="pe-zoom-btn" onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))} title="Zoom out"><ZoomOut size={12} /></button>
          <button className="pe-zoom-level" onClick={() => setZoom(1)} title="Reset zoom">{Math.round(zoom * 100)}%</button>
          <button className="pe-zoom-btn" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} title="Zoom in"><ZoomIn size={12} /></button>
        </div>
      </div>

      {toast && <div className={`pe-save-toast ${toast.kind === 'ok' ? 'pe-save-toast-ok' : 'pe-save-toast-err'}`}>{toast.msg}</div>}

      {signOpen && (
        <SignaturePad
          color={penColor}
          onCancel={() => setSignOpen(false)}
          onApply={(dataUrl) => { setSignOpen(false); insertImageAnnotation(dataUrl); }}
        />
      )}
    </div>
  );
}

// ── Shape SVG renderer ───────────────────────────────────────────

function ShapeSvg({ shape, selected, preview, onSelect }: {
  shape: ShapeAnnotation; selected?: boolean; preview?: boolean; onSelect?: () => void;
}) {
  const stroke = shape.color;
  // lineWidth is in px; scale into the 0..100 viewBox roughly (percent units)
  const sw = Math.max(0.3, shape.lineWidth * 0.25);
  const common = {
    stroke, strokeWidth: sw, fill: 'none',
    vectorEffect: 'non-scaling-stroke' as const,
    style: { pointerEvents: (preview ? 'none' : 'stroke') as any, cursor: 'pointer', opacity: selected ? 1 : 0.95 },
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onSelect?.(); },
    strokeDasharray: preview ? '2 1.5' : undefined,
  };
  if (shape.kind === 'rect') {
    return <rect x={Math.min(shape.x, shape.x2)} y={Math.min(shape.y, shape.y2)} width={Math.abs(shape.x2 - shape.x)} height={Math.abs(shape.y2 - shape.y)} {...common} />;
  }
  if (shape.kind === 'ellipse') {
    return <ellipse cx={(shape.x + shape.x2) / 2} cy={(shape.y + shape.y2) / 2} rx={Math.abs(shape.x2 - shape.x) / 2} ry={Math.abs(shape.y2 - shape.y) / 2} {...common} />;
  }
  if (shape.kind === 'line') {
    return <line x1={shape.x} y1={shape.y} x2={shape.x2} y2={shape.y2} {...common} />;
  }
  // arrow
  const angle = Math.atan2(shape.y2 - shape.y, shape.x2 - shape.x);
  const head = 3;
  const spread = Math.PI / 7;
  const hx1 = shape.x2 - head * Math.cos(angle - spread);
  const hy1 = shape.y2 - head * Math.sin(angle - spread);
  const hx2 = shape.x2 - head * Math.cos(angle + spread);
  const hy2 = shape.y2 - head * Math.sin(angle + spread);
  return (
    <g {...common}>
      <line x1={shape.x} y1={shape.y} x2={shape.x2} y2={shape.y2} stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
      <line x1={shape.x2} y1={shape.y2} x2={hx1} y2={hy1} stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
      <line x1={shape.x2} y1={shape.y2} x2={hx2} y2={hy2} stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

// ── Thumbnail item (lazy render via IntersectionObserver) ────────

function ThumbnailItem({
  slot, position, active, onSelect, onRotate, onDuplicate, onDelete, onInsertBlank,
  onMoveUp, onMoveDown, canDelete, onDragStartThumb, onDropThumb,
}: {
  slot: PageSlot; position: number; active: boolean;
  onSelect: () => void; onRotate: () => void; onDuplicate: () => void; onDelete: () => void; onInsertBlank: () => void;
  onMoveUp?: () => void; onMoveDown?: () => void; canDelete: boolean;
  onDragStartThumb: () => void; onDropThumb: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { setVisible(true); obs.disconnect(); break; }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`pe-thumb ${active ? 'active' : ''}`}
      onClick={onSelect}
      draggable
      onDragStart={onDragStartThumb}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDropThumb(); }}
    >
      <div className="pe-thumb-frame">
        {slot.src === 'blank' ? (
          <div className="pe-thumb-blank" />
        ) : visible ? (
          <Page pageNumber={slot.src + 1} width={112} rotate={slot.rotation} renderTextLayer={false} renderAnnotationLayer={false} loading={<div className="pe-thumb-ph" />} />
        ) : (
          <div className="pe-thumb-ph" />
        )}
      </div>
      <div className="pe-thumb-num">{position}</div>
      <div className="pe-thumb-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={onRotate} title="Rotate"><RotateCw size={12} /></button>
        <button onClick={onDuplicate} title="Duplicate"><Copy size={12} /></button>
        <button onClick={onInsertBlank} title="Insert blank after"><Plus size={12} /></button>
        <button onClick={onMoveUp} disabled={!onMoveUp} title="Move up"><ChevronUp size={12} /></button>
        <button onClick={onMoveDown} disabled={!onMoveDown} title="Move down"><ChevronDown size={12} /></button>
        <button onClick={onDelete} disabled={!canDelete} title="Delete page"><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

// ── Signature pad modal ──────────────────────────────────────────

function SignaturePad({ color, onApply, onCancel }: { color: string; onApply: (dataUrl: string) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const point = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  };
  const down = (e: React.MouseEvent) => { drawing.current = true; last.current = point(e); };
  const move = (e: React.MouseEvent) => {
    if (!drawing.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const p = point(e);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    hasInk.current = true;
  };
  const up = () => { drawing.current = false; last.current = null; };
  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
  };
  const apply = () => {
    if (!hasInk.current) { onCancel(); return; }
    onApply(canvasRef.current!.toDataURL('image/png'));
  };

  return (
    <div className="pe-modal-backdrop" onMouseDown={onCancel}>
      <div className="pe-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pe-modal-title">Draw signature</div>
        <canvas
          ref={canvasRef}
          className="pe-sign-canvas"
          width={520}
          height={200}
          onMouseDown={down}
          onMouseMove={move}
          onMouseUp={up}
          onMouseLeave={up}
        />
        <div className="pe-modal-actions">
          <button className="pe-btn" onClick={clear}>Clear</button>
          <div style={{ flex: 1 }} />
          <button className="pe-btn" onClick={onCancel}>Cancel</button>
          <button className="pe-btn pe-btn-primary" onClick={apply}>Insert</button>
        </div>
      </div>
    </div>
  );
}

export default PdfEditor;
