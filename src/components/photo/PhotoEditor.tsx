// Photoshop-class raster editor: layers, selections, brushes, adjustments,
// filters, free transform, history. Editor UI text is English-only by design.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  MousePointer2, SquareDashed, Lasso, Wand2, Crop as CropIcon, Pipette,
  Brush, Eraser, PaintBucket, Stamp, Type as TypeIcon, Hand, Square, Circle,
  Minus, Undo2, Redo2, Save, X, Plus, Copy, Trash2, ChevronUp, ChevronDown,
  Eye, EyeOff, Layers as LayersIcon, ZoomIn, ZoomOut, Maximize2, ArrowLeftRight,
  Blend, Check, CircleDashed,
} from 'lucide-react';
import {
  type PixelBuf,
  adjustBrightnessContrast, adjustHsl, adjustLevels, adjustColorBalance,
  invertPixels, grayscalePixels, sepiaPixels, blurPixels, sharpenPixels,
  pixelatePixels, noisePixels, vignettePixels,
  floodFillMask, polygonMask, rectMask, ellipseMask, invertMask, maskIsEmpty,
  unionMask, subtractMask, blendByMask, bucketFill, hexToRgb,
  type CurvePoint, curveLut, applyLut, lumaHistogram,
} from './photoFilters';
import {
  type PhotoLayer, type DocSnapshot, type BlendMode, type TextData,
  BLEND_MODES, makeLayer, createCanvas, ctx2d, cloneCanvas, snapshotDoc,
  restoreDoc, compositeLayers, renderTextLayer, measureTextLayer,
  maskToCanvas, maskEdgePoints, clipCanvasByMask, makeBrushStamp,
  stampSegment, cloneStampSegment, getPixels, putPixels,
  rotateLayerCanvas, flipLayerCanvas, cropLayerCanvas, resizeLayerCanvas,
  loadImage, nextLayerId,
} from './photoEngine';
import './PhotoEditor.css';

interface PhotoEditorProps {
  src: string;
  fileName: string;
  filePath?: string;
  style?: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onSavedData?: (dataUrl: string, path: string) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

type Tool =
  | 'move' | 'marquee-rect' | 'marquee-ellipse' | 'lasso' | 'wand' | 'crop'
  | 'eyedropper' | 'brush' | 'eraser' | 'fill' | 'gradient' | 'clone'
  | 'text' | 'shape-rect' | 'shape-ellipse' | 'shape-line' | 'hand';

type SelOutline =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'poly'; points: Array<{ x: number; y: number }> }
  | { kind: 'pixels'; points: Array<{ x: number; y: number }> };

interface Selection {
  mask: Uint8Array;
  maskCanvas: HTMLCanvasElement;
  outline: SelOutline;
}

type AdjustKind =
  | 'brightness-contrast' | 'hue-saturation' | 'levels' | 'color-balance'
  | 'blur' | 'sharpen' | 'pixelate' | 'noise' | 'vignette';

interface AdjustParam { key: string; label: string; min: number; max: number; step?: number; def: number }

const ADJUSTMENTS: Record<AdjustKind, { title: string; params: AdjustParam[] }> = {
  'brightness-contrast': {
    title: 'Brightness / Contrast',
    params: [
      { key: 'brightness', label: 'Brightness', min: -100, max: 100, def: 0 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, def: 0 },
    ],
  },
  'hue-saturation': {
    title: 'Hue / Saturation',
    params: [
      { key: 'hue', label: 'Hue', min: -180, max: 180, def: 0 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, def: 0 },
      { key: 'lightness', label: 'Lightness', min: -100, max: 100, def: 0 },
    ],
  },
  levels: {
    title: 'Levels',
    params: [
      { key: 'black', label: 'Black Point', min: 0, max: 254, def: 0 },
      { key: 'white', label: 'White Point', min: 1, max: 255, def: 255 },
      { key: 'gamma', label: 'Gamma', min: 0.1, max: 3, step: 0.01, def: 1 },
    ],
  },
  'color-balance': {
    title: 'Color Balance',
    params: [
      { key: 'r', label: 'Red', min: -100, max: 100, def: 0 },
      { key: 'g', label: 'Green', min: -100, max: 100, def: 0 },
      { key: 'b', label: 'Blue', min: -100, max: 100, def: 0 },
    ],
  },
  blur: { title: 'Gaussian Blur', params: [{ key: 'radius', label: 'Radius', min: 0, max: 50, def: 4 }] },
  sharpen: { title: 'Sharpen', params: [{ key: 'amount', label: 'Amount', min: 0, max: 300, def: 80 }] },
  pixelate: { title: 'Pixelate', params: [{ key: 'size', label: 'Block Size', min: 2, max: 64, def: 8 }] },
  noise: { title: 'Add Noise', params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, def: 20 }] },
  vignette: { title: 'Vignette', params: [{ key: 'amount', label: 'Amount', min: 0, max: 100, def: 50 }] },
};

function runAdjust(kind: AdjustKind, src: PixelBuf, p: Record<string, number>): PixelBuf {
  switch (kind) {
    case 'brightness-contrast': return adjustBrightnessContrast(src, p.brightness, p.contrast);
    case 'hue-saturation': return adjustHsl(src, p.hue, p.saturation, p.lightness);
    case 'levels': return adjustLevels(src, p.black, p.white, p.gamma);
    case 'color-balance': return adjustColorBalance(src, p.r, p.g, p.b);
    case 'blur': return blurPixels(src, p.radius);
    case 'sharpen': return sharpenPixels(src, p.amount);
    case 'pixelate': return pixelatePixels(src, p.size);
    case 'noise': return noisePixels(src, p.amount);
    case 'vignette': return vignettePixels(src, p.amount);
  }
}

const FONTS = ['Inter', 'Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Menlo', 'Impact'];
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const HISTORY_LIMIT = 20;

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function mimeOf(name: string): string {
  const ext = extOf(name);
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

interface DragState {
  kind: 'marquee' | 'lasso' | 'move' | 'brush' | 'eraser' | 'clone' | 'gradient'
  | 'shape' | 'crop' | 'hand' | 'transform-move' | 'transform-scale' | 'transform-rotate';
  start: { x: number; y: number };
  last: { x: number; y: number };
  startClient?: { x: number; y: number };
  startPan?: { x: number; y: number };
  points?: Array<{ x: number; y: number }>;
  strokeCanvas?: HTMLCanvasElement;
  stamp?: HTMLCanvasElement;
  layerSnapshot?: HTMLCanvasElement;
  eraserTemp?: HTMLCanvasElement;
  cloneOffset?: { x: number; y: number };
  combine?: 'replace' | 'add' | 'sub';
  pushed?: boolean;
  handle?: number;
  origT?: { cx: number; cy: number; w: number; h: number; rot: number };
  textStart?: { x: number; y: number };
}

interface TransformState { cx: number; cy: number; w: number; h: number; rot: number }

// Interactive curve editor: histogram backdrop, draggable control points,
// click adds a point, double-click removes one.
function CurvesPanel({ points, hist, accent, onChange }: {
  points: CurvePoint[];
  hist: Uint32Array | null;
  accent: string;
  onChange: (pts: CurvePoint[]) => void;
}) {
  const W = 256, H = 200;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragIdx = useRef<number | null>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (hist) {
      let max = 1;
      for (let i = 0; i < 256; i++) if (hist[i] > max) max = hist[i];
      ctx.fillStyle = 'rgba(128,128,128,0.35)';
      for (let x = 0; x < 256; x++) {
        const bh = (hist[x] / max) * (H - 6);
        if (bh > 0) ctx.fillRect(x, H - bh, 1, bh);
      }
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo((W * i) / 4, 0); ctx.lineTo((W * i) / 4, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, (H * i) / 4); ctx.lineTo(W, (H * i) / 4); ctx.stroke();
    }
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.stroke();
    ctx.setLineDash([]);
    const lut = curveLut(points);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = H - 1 - (lut[x] / 255) * (H - 1);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    for (const p of points) {
      const cx = p.x, cy = H - 1 - (p.y / 255) * (H - 1);
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
  }, [points, hist, accent]);

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { cx: ((e.clientX - r.left) * W) / r.width, cy: ((e.clientY - r.top) * H) / r.height };
  };
  const toPoint = (cx: number, cy: number): CurvePoint => ({
    x: Math.round(Math.min(255, Math.max(0, cx))),
    y: Math.round(Math.min(255, Math.max(0, 255 * (1 - cy / (H - 1))))),
  });
  const hitIndex = (cx: number, cy: number): number => points.findIndex((p) => {
    const py = H - 1 - (p.y / 255) * (H - 1);
    return Math.hypot(p.x - cx, py - cy) < 9;
  });

  return (
    <canvas
      ref={canvasRef}
      className="pe-curves-canvas"
      width={W}
      height={H}
      onPointerDown={(e) => {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        const { cx, cy } = pos(e);
        const hit = hitIndex(cx, cy);
        if (hit >= 0) {
          dragIdx.current = hit;
        } else {
          const next = [...points, toPoint(cx, cy)].sort((a, b) => a.x - b.x);
          dragIdx.current = next.findIndex((p) => p.x === toPoint(cx, cy).x && p.y === toPoint(cx, cy).y);
          onChange(next);
        }
      }}
      onPointerMove={(e) => {
        if (dragIdx.current === null) return;
        const i = dragIdx.current;
        const { cx, cy } = pos(e);
        const p = toPoint(cx, cy);
        const lo = i > 0 ? points[i - 1].x + 1 : 0;
        const hi = i < points.length - 1 ? points[i + 1].x - 1 : 255;
        p.x = Math.min(hi, Math.max(lo, p.x));
        const next = points.slice();
        next[i] = p;
        onChange(next);
      }}
      onPointerUp={() => { dragIdx.current = null; }}
      onDoubleClick={(e) => {
        if (points.length <= 2) return;
        const { cx, cy } = pos(e);
        const hit = hitIndex(cx, cy);
        if (hit >= 0) onChange(points.filter((_, i) => i !== hit));
      }}
    />
  );
}

export default function PhotoEditor({ src, fileName, filePath, style, onSaved, onSavedData, onClose, onDirtyChange }: PhotoEditorProps) {
  const bg = style?.bg || '#1b1b1f';
  const fg = style?.text || '#d6d6d6';
  const accent = style?.accent || '#4a9eff';

  // --- document state (refs: mutated imperatively, `version` re-renders panels) ---
  const docRef = useRef({ w: 0, h: 0 });
  const layersRef = useRef<PhotoLayer[]>([]);
  const historyRef = useRef<{ undo: DocSnapshot[]; redo: DocSnapshot[] }>({ undo: [], redo: [] });
  const selectionRef = useRef<Selection | null>(null);
  const previewRef = useRef<{ layerId: string; draw: (ctx: CanvasRenderingContext2D) => void } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const antsOffsetRef = useRef(0);
  const spaceRef = useRef(false);
  const cloneSourceRef = useRef<{ x: number; y: number } | null>(null);

  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [ready, setReady] = useState(false);
  const [activeLayerId, setActiveLayerId] = useState('');
  const [tool, setTool] = useState<Tool>('move');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // tool options
  const [fgColor, setFgColor] = useState('#ffffff');
  const [bgColor, setBgColor] = useState('#000000');
  const [brushSize, setBrushSize] = useState(24);
  const [brushHardness, setBrushHardness] = useState(80);
  const [brushOpacity, setBrushOpacity] = useState(100);
  const [eraserSize, setEraserSize] = useState(30);
  const [tolerance, setTolerance] = useState(32);
  const [shapeFill, setShapeFill] = useState(false);
  const [shapeStroke, setShapeStroke] = useState(4);
  const [gradKind, setGradKind] = useState<'linear' | 'radial'>('linear');
  const [gradToTransparent, setGradToTransparent] = useState(false);
  const [fontFamily, setFontFamily] = useState('Inter');
  const [fontSize, setFontSize] = useState(48);
  const [fontBold, setFontBold] = useState(false);
  const [fontItalic, setFontItalic] = useState(false);

  const [adjust, setAdjust] = useState<{ kind: AdjustKind; params: Record<string, number> } | null>(null);
  const [curves, setCurves] = useState<CurvePoint[] | null>(null);
  const curvesHistRef = useRef<Uint32Array | null>(null);
  const [transform, setTransform] = useState<TransformState | null>(null);
  const transformSnapRef = useRef<HTMLCanvasElement | null>(null);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [resizeDialog, setResizeDialog] = useState<{ kind: 'image' | 'canvas'; w: number; h: number; lock: boolean } | null>(null);
  const [exportDialog, setExportDialog] = useState<{ format: 'png' | 'jpeg' | 'webp'; quality: number } | null>(null);

  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const activeLayer = useCallback((): PhotoLayer | null =>
    layersRef.current.find((l) => l.id === activeLayerId) || null, [activeLayerId]);

  // --- rendering ---
  const redraw = useCallback(() => {
    const main = mainCanvasRef.current;
    if (!main || !docRef.current.w) return;
    const { w, h } = docRef.current;
    if (transform && transformSnapRef.current) {
      const snap = transformSnapRef.current;
      const t = transform;
      compositeLayers(layersRef.current, w, h, main, {
        layerId: activeLayerId,
        draw: (ctx) => {
          ctx.save();
          ctx.translate(t.cx, t.cy);
          ctx.rotate(t.rot);
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(snap, -t.w / 2, -t.h / 2, t.w, t.h);
          ctx.restore();
        },
      });
    } else {
      compositeLayers(layersRef.current, w, h, main, previewRef.current);
    }
  }, [activeLayerId, transform]);

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || !docRef.current.w) return;
    const { w, h } = docRef.current;
    if (overlay.width !== w) overlay.width = w;
    if (overlay.height !== h) overlay.height = h;
    const ctx = ctx2d(overlay);
    ctx.clearRect(0, 0, w, h);
    const lw = 1 / zoom;
    const dash = 5 / zoom;
    const drag = dragRef.current;

    // selection marching ants
    const sel = selectionRef.current;
    const ants = (path: () => void) => {
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.beginPath(); path(); ctx.stroke();
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = -antsOffsetRef.current / zoom;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath(); path(); ctx.stroke();
      ctx.setLineDash([]);
    };
    if (sel) {
      const o = sel.outline;
      if (o.kind === 'rect') ants(() => ctx.rect(o.x, o.y, o.w, o.h));
      else if (o.kind === 'ellipse') ants(() => ctx.ellipse(o.cx, o.cy, o.rx, o.ry, 0, 0, Math.PI * 2));
      else if (o.kind === 'poly') ants(() => {
        o.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
      });
      else {
        const off = Math.floor(antsOffsetRef.current / 2);
        for (const p of o.points) {
          ctx.fillStyle = ((p.x + p.y + off) % 8) < 4 ? '#ffffff' : '#000000';
          ctx.fillRect(p.x, p.y, Math.max(1, lw), Math.max(1, lw));
        }
      }
    }

    // in-progress marquee / lasso / shape / gradient / crop preview
    if (drag) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([dash, dash]);
      if (drag.kind === 'marquee') {
        const x = Math.min(drag.start.x, drag.last.x), y = Math.min(drag.start.y, drag.last.y);
        const rw = Math.abs(drag.last.x - drag.start.x), rh = Math.abs(drag.last.y - drag.start.y);
        if (tool === 'marquee-ellipse') { ctx.beginPath(); ctx.ellipse(x + rw / 2, y + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
        else ctx.strokeRect(x, y, rw, rh);
      } else if (drag.kind === 'lasso' && drag.points) {
        ctx.beginPath();
        drag.points.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.stroke();
      } else if (drag.kind === 'shape') {
        ctx.setLineDash([]);
        ctx.strokeStyle = fgColor;
        ctx.lineWidth = shapeStroke;
        ctx.beginPath();
        if (tool === 'shape-rect') ctx.rect(Math.min(drag.start.x, drag.last.x), Math.min(drag.start.y, drag.last.y), Math.abs(drag.last.x - drag.start.x), Math.abs(drag.last.y - drag.start.y));
        else if (tool === 'shape-ellipse') ctx.ellipse((drag.start.x + drag.last.x) / 2, (drag.start.y + drag.last.y) / 2, Math.abs(drag.last.x - drag.start.x) / 2, Math.abs(drag.last.y - drag.start.y) / 2, 0, 0, Math.PI * 2);
        else { ctx.moveTo(drag.start.x, drag.start.y); ctx.lineTo(drag.last.x, drag.last.y); }
        if (shapeFill && tool !== 'shape-line') { ctx.fillStyle = fgColor; ctx.fill(); }
        else ctx.stroke();
      } else if (drag.kind === 'gradient') {
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath(); ctx.moveTo(drag.start.x, drag.start.y); ctx.lineTo(drag.last.x, drag.last.y); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // crop rect
    if (cropRect || (drag && drag.kind === 'crop')) {
      const r = drag && drag.kind === 'crop'
        ? { x: Math.min(drag.start.x, drag.last.x), y: Math.min(drag.start.y, drag.last.y), w: Math.abs(drag.last.x - drag.start.x), h: Math.abs(drag.last.y - drag.start.y) }
        : cropRect!;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.fill('evenodd');
      ctx.lineWidth = lw * 1.5;
      ctx.strokeStyle = accent;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }

    // transform handles
    if (transform) {
      const t = transform;
      const corners = transformCorners(t);
      ctx.lineWidth = lw;
      ctx.strokeStyle = accent;
      ctx.beginPath();
      corners.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
      ctx.stroke();
      const hs = 5 / zoom;
      for (const p of corners) {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = accent;
        ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
        ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      }
      const rot = rotateHandlePos(t, zoom);
      ctx.beginPath();
      ctx.arc(rot.x, rot.y, hs, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    // text layer bounds
    const layer = layersRef.current.find((l) => l.id === activeLayerId);
    if (layer?.text && (tool === 'text' || tool === 'move') && !transform) {
      const m = measureTextLayer(layer.text);
      ctx.lineWidth = lw;
      ctx.setLineDash([dash, dash]);
      ctx.strokeStyle = accent;
      ctx.strokeRect(layer.text.x - 2, layer.text.y - 2, m.w + 4, m.h + 4);
      ctx.setLineDash([]);
    }

    // brush cursor
    const pt = pointerRef.current;
    if (pt && (tool === 'brush' || tool === 'eraser' || tool === 'clone') && !drag) {
      const size = tool === 'eraser' ? eraserSize : brushSize;
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, size / 2 + lw, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (tool === 'clone' && cloneSourceRef.current) {
      const s = cloneSourceRef.current;
      ctx.strokeStyle = accent;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(s.x - 6 / zoom, s.y); ctx.lineTo(s.x + 6 / zoom, s.y);
      ctx.moveTo(s.x, s.y - 6 / zoom); ctx.lineTo(s.x, s.y + 6 / zoom);
      ctx.stroke();
    }
  }, [zoom, tool, cropRect, transform, activeLayerId, brushSize, eraserSize, fgColor, shapeFill, shapeStroke, accent]);

  // marching ants animation
  useEffect(() => {
    const id = window.setInterval(() => {
      if (selectionRef.current) {
        antsOffsetRef.current = (antsOffsetRef.current + 1) % 1000;
        drawOverlay();
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [drawOverlay]);

  useEffect(() => { redraw(); drawOverlay(); });

  // --- init ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const img = await loadImage(src);
        if (cancelled) return;
        const w = img.naturalWidth, h = img.naturalHeight;
        docRef.current = { w, h };
        const base = makeLayer('Background', w, h);
        ctx2d(base.canvas).drawImage(img, 0, 0);
        layersRef.current = [base];
        historyRef.current = { undo: [], redo: [] };
        setActiveLayerId(base.id);
        const vp = viewportRef.current?.getBoundingClientRect();
        if (vp) {
          const fit = Math.min(1, (vp.width - 80) / w, (vp.height - 80) / h);
          setZoom(Math.max(MIN_ZOOM, fit));
        }
        setReady(true);
        bump();
      } catch (err) {
        console.error('[PhotoEditor] load failed:', err);
        showToast('err', 'Failed to load image');
      }
    })();
    return () => { cancelled = true; };
  }, [src, bump, showToast]);

  // --- history ---
  const pushHistory = useCallback(() => {
    const h = historyRef.current;
    h.undo.push(snapshotDoc(docRef.current.w, docRef.current.h, layersRef.current, activeLayerId));
    if (h.undo.length > HISTORY_LIMIT) h.undo.shift();
    h.redo = [];
    setDirty(true);
  }, [activeLayerId]);

  const applySnapshot = useCallback((snap: DocSnapshot) => {
    docRef.current = { w: snap.width, h: snap.height };
    layersRef.current = restoreDoc(snap);
    setActiveLayerId(snap.activeLayerId);
    selectionRef.current = null;
    previewRef.current = null;
    setTransform(null);
    setCropRect(null);
    bump();
  }, [bump]);

  const undo = useCallback(() => {
    const h = historyRef.current;
    const snap = h.undo.pop();
    if (!snap) return;
    h.redo.push(snapshotDoc(docRef.current.w, docRef.current.h, layersRef.current, activeLayerId));
    applySnapshot(snap);
    if (h.undo.length === 0) setDirty(false);
  }, [activeLayerId, applySnapshot]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    const snap = h.redo.pop();
    if (!snap) return;
    h.undo.push(snapshotDoc(docRef.current.w, docRef.current.h, layersRef.current, activeLayerId));
    applySnapshot(snap);
    setDirty(true);
  }, [activeLayerId, applySnapshot]);

  // --- selection helpers ---
  const setSelectionFromMask = useCallback((mask: Uint8Array, outline?: SelOutline) => {
    const { w, h } = docRef.current;
    if (maskIsEmpty(mask)) {
      selectionRef.current = null;
    } else {
      selectionRef.current = {
        mask,
        maskCanvas: maskToCanvas(mask, w, h),
        outline: outline || { kind: 'pixels', points: maskEdgePoints(mask, w, h) },
      };
    }
    drawOverlay();
    bump();
  }, [drawOverlay, bump]);

  const deselect = useCallback(() => { selectionRef.current = null; drawOverlay(); bump(); }, [drawOverlay, bump]);

  const selectAll = useCallback(() => {
    const { w, h } = docRef.current;
    setSelectionFromMask(rectMask(0, 0, w, h, w, h), { kind: 'rect', x: 0, y: 0, w, h });
  }, [setSelectionFromMask]);

  const invertSelection = useCallback(() => {
    const { w, h } = docRef.current;
    const cur = selectionRef.current;
    const mask = cur ? invertMask(cur.mask) : rectMask(0, 0, w, h, w, h);
    setSelectionFromMask(mask);
  }, [setSelectionFromMask]);

  // Photoshop-style combining: Shift adds to, Alt subtracts from the selection.
  const combineSelection = useCallback((mask: Uint8Array, outline: SelOutline | undefined, combine: 'replace' | 'add' | 'sub') => {
    const cur = selectionRef.current;
    if (combine === 'add' && cur) setSelectionFromMask(unionMask(cur.mask, mask));
    else if (combine === 'sub' && cur) setSelectionFromMask(subtractMask(cur.mask, mask));
    else setSelectionFromMask(mask, outline);
  }, [setSelectionFromMask]);

  // --- layer ops ---
  const ensureRaster = useCallback((layer: PhotoLayer): PhotoLayer => {
    if (layer.text) {
      delete layer.text;
      showToast('ok', 'Text layer rasterized');
    }
    return layer;
  }, [showToast]);

  const addLayer = useCallback(() => {
    pushHistory();
    const { w, h } = docRef.current;
    const layer = makeLayer(`Layer ${layersRef.current.length + 1}`, w, h);
    const idx = layersRef.current.findIndex((l) => l.id === activeLayerId);
    layersRef.current.splice(idx + 1, 0, layer);
    setActiveLayerId(layer.id);
    bump();
  }, [activeLayerId, pushHistory, bump]);

  const duplicateLayer = useCallback(() => {
    const layer = activeLayer();
    if (!layer) return;
    pushHistory();
    const copy: PhotoLayer = {
      ...layer,
      id: nextLayerId(),
      name: `${layer.name} copy`,
      canvas: cloneCanvas(layer.canvas),
      text: layer.text ? { ...layer.text } : undefined,
    };
    const idx = layersRef.current.findIndex((l) => l.id === layer.id);
    layersRef.current.splice(idx + 1, 0, copy);
    setActiveLayerId(copy.id);
    bump();
  }, [activeLayer, pushHistory, bump]);

  // ⌘J — copy the selection (or whole layer) onto a new layer above.
  const layerViaCopy = useCallback(() => {
    const layer = activeLayer();
    if (!layer) return;
    pushHistory();
    const { w, h } = docRef.current;
    const copy = makeLayer(`Layer ${layersRef.current.length + 1}`, w, h);
    const ctx = ctx2d(copy.canvas);
    ctx.drawImage(layer.canvas, 0, 0);
    const sel = selectionRef.current;
    if (sel) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(sel.maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    const idx = layersRef.current.findIndex((l) => l.id === layer.id);
    layersRef.current.splice(idx + 1, 0, copy);
    setActiveLayerId(copy.id);
    bump();
  }, [activeLayer, pushHistory, bump]);

  const deleteLayer = useCallback(() => {
    if (layersRef.current.length <= 1) { showToast('err', 'Cannot delete the last layer'); return; }
    const idx = layersRef.current.findIndex((l) => l.id === activeLayerId);
    if (idx < 0) return;
    pushHistory();
    layersRef.current.splice(idx, 1);
    setActiveLayerId(layersRef.current[Math.max(0, idx - 1)].id);
    bump();
  }, [activeLayerId, pushHistory, bump, showToast]);

  const mergeDown = useCallback(() => {
    const idx = layersRef.current.findIndex((l) => l.id === activeLayerId);
    if (idx <= 0) { showToast('err', 'No layer below to merge'); return; }
    pushHistory();
    const upper = layersRef.current[idx];
    const lower = layersRef.current[idx - 1];
    ensureRaster(lower);
    const ctx = ctx2d(lower.canvas);
    ctx.globalAlpha = upper.opacity / 100;
    ctx.globalCompositeOperation = (upper.blendMode === 'normal' ? 'source-over' : upper.blendMode) as GlobalCompositeOperation;
    if (upper.visible) ctx.drawImage(upper.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    layersRef.current.splice(idx, 1);
    setActiveLayerId(lower.id);
    bump();
  }, [activeLayerId, pushHistory, bump, ensureRaster, showToast]);

  const flattenLayers = useCallback(() => {
    if (layersRef.current.length <= 1) return;
    pushHistory();
    const { w, h } = docRef.current;
    const flat = makeLayer('Background', w, h);
    compositeLayers(layersRef.current, w, h, flat.canvas);
    layersRef.current = [flat];
    setActiveLayerId(flat.id);
    bump();
  }, [pushHistory, bump]);

  const moveLayer = useCallback((dir: 1 | -1) => {
    const idx = layersRef.current.findIndex((l) => l.id === activeLayerId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= layersRef.current.length) return;
    pushHistory();
    const [layer] = layersRef.current.splice(idx, 1);
    layersRef.current.splice(target, 0, layer);
    bump();
  }, [activeLayerId, pushHistory, bump]);

  // --- adjustments ---
  const applyOneShot = useCallback((kind: 'invert' | 'grayscale' | 'sepia') => {
    const layer = activeLayer();
    if (!layer) return;
    ensureRaster(layer);
    pushHistory();
    const srcBuf = getPixels(layer.canvas);
    const filtered = kind === 'invert' ? invertPixels(srcBuf) : kind === 'grayscale' ? grayscalePixels(srcBuf) : sepiaPixels(srcBuf);
    putPixels(layer.canvas, blendByMask(srcBuf, filtered, selectionRef.current?.mask || null));
    bump();
  }, [activeLayer, ensureRaster, pushHistory, bump]);

  const adjustPreviewTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!adjust) {
      if (!curves) { previewRef.current = null; redraw(); }
      return;
    }
    if (adjustPreviewTimer.current) window.clearTimeout(adjustPreviewTimer.current);
    adjustPreviewTimer.current = window.setTimeout(() => {
      const layer = layersRef.current.find((l) => l.id === activeLayerId);
      if (!layer) return;
      const srcBuf = getPixels(layer.canvas);
      const out = blendByMask(srcBuf, runAdjust(adjust.kind, srcBuf, adjust.params), selectionRef.current?.mask || null);
      const temp = createCanvas(docRef.current.w, docRef.current.h);
      putPixels(temp, out);
      previewRef.current = { layerId: layer.id, draw: (ctx) => ctx.drawImage(temp, 0, 0) };
      redraw();
    }, 90);
    return () => { if (adjustPreviewTimer.current) window.clearTimeout(adjustPreviewTimer.current); };
  }, [adjust, curves, activeLayerId, redraw]);

  const applyAdjust = useCallback(() => {
    if (!adjust) return;
    const layer = activeLayer();
    if (!layer) return;
    ensureRaster(layer);
    pushHistory();
    const srcBuf = getPixels(layer.canvas);
    const out = blendByMask(srcBuf, runAdjust(adjust.kind, srcBuf, adjust.params), selectionRef.current?.mask || null);
    putPixels(layer.canvas, out);
    previewRef.current = null;
    setAdjust(null);
    bump();
  }, [adjust, activeLayer, ensureRaster, pushHistory, bump]);

  const openAdjust = useCallback((kind: AdjustKind) => {
    const params: Record<string, number> = {};
    for (const p of ADJUSTMENTS[kind].params) params[p.key] = p.def;
    setAdjust({ kind, params });
    setCurves(null);
    setOpenMenu(null);
  }, []);

  // --- curves ---
  const openCurves = useCallback(() => {
    const layer = activeLayer();
    if (!layer) return;
    curvesHistRef.current = lumaHistogram(getPixels(layer.canvas));
    setAdjust(null);
    setCurves([{ x: 0, y: 0 }, { x: 255, y: 255 }]);
    setOpenMenu(null);
  }, [activeLayer]);

  const curvesPreviewTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!curves) {
      if (!adjust) { previewRef.current = null; redraw(); }
      return;
    }
    if (curvesPreviewTimer.current) window.clearTimeout(curvesPreviewTimer.current);
    curvesPreviewTimer.current = window.setTimeout(() => {
      const layer = layersRef.current.find((l) => l.id === activeLayerId);
      if (!layer) return;
      const srcBuf = getPixels(layer.canvas);
      const out = blendByMask(srcBuf, applyLut(srcBuf, curveLut(curves)), selectionRef.current?.mask || null);
      const temp = createCanvas(docRef.current.w, docRef.current.h);
      putPixels(temp, out);
      previewRef.current = { layerId: layer.id, draw: (ctx) => ctx.drawImage(temp, 0, 0) };
      redraw();
    }, 60);
    return () => { if (curvesPreviewTimer.current) window.clearTimeout(curvesPreviewTimer.current); };
  }, [curves, adjust, activeLayerId, redraw]);

  const applyCurves = useCallback(() => {
    if (!curves) return;
    const layer = activeLayer();
    if (!layer) return;
    ensureRaster(layer);
    pushHistory();
    const srcBuf = getPixels(layer.canvas);
    putPixels(layer.canvas, blendByMask(srcBuf, applyLut(srcBuf, curveLut(curves)), selectionRef.current?.mask || null));
    previewRef.current = null;
    setCurves(null);
    bump();
  }, [curves, activeLayer, ensureRaster, pushHistory, bump]);

  // --- transform ---
  const startTransform = useCallback(() => {
    const layer = activeLayer();
    if (!layer) return;
    ensureRaster(layer);
    const buf = getPixels(layer.canvas);
    let minX = buf.width, minY = buf.height, maxX = -1, maxY = -1;
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        if (buf.data[(y * buf.width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) { showToast('err', 'Layer is empty'); return; }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    transformSnapRef.current = cropLayerCanvas(layer.canvas, minX, minY, w, h);
    setTransform({ cx: minX + w / 2, cy: minY + h / 2, w, h, rot: 0 });
  }, [activeLayer, ensureRaster, showToast]);

  const applyTransform = useCallback(() => {
    if (!transform || !transformSnapRef.current) return;
    const layer = activeLayer();
    if (!layer) return;
    pushHistory();
    const ctx = ctx2d(layer.canvas);
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    ctx.save();
    ctx.translate(transform.cx, transform.cy);
    ctx.rotate(transform.rot);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(transformSnapRef.current, -transform.w / 2, -transform.h / 2, transform.w, transform.h);
    ctx.restore();
    transformSnapRef.current = null;
    setTransform(null);
    bump();
  }, [transform, activeLayer, pushHistory, bump]);

  const cancelTransform = useCallback(() => {
    transformSnapRef.current = null;
    setTransform(null);
    redraw();
  }, [redraw]);

  // --- crop / canvas ops ---
  const applyCrop = useCallback(() => {
    if (!cropRect || cropRect.w < 2 || cropRect.h < 2) return;
    pushHistory();
    const r = {
      x: Math.max(0, Math.round(cropRect.x)),
      y: Math.max(0, Math.round(cropRect.y)),
      w: Math.round(cropRect.w),
      h: Math.round(cropRect.h),
    };
    r.w = Math.min(r.w, docRef.current.w - r.x);
    r.h = Math.min(r.h, docRef.current.h - r.y);
    for (const layer of layersRef.current) {
      layer.canvas = cropLayerCanvas(layer.canvas, r.x, r.y, r.w, r.h);
      if (layer.text) { layer.text.x -= r.x; layer.text.y -= r.y; }
    }
    docRef.current = { w: r.w, h: r.h };
    selectionRef.current = null;
    setCropRect(null);
    bump();
  }, [cropRect, pushHistory, bump]);

  const rotateCanvas = useCallback((deg: 90 | -90 | 180) => {
    pushHistory();
    for (const layer of layersRef.current) {
      delete layer.text;
      layer.canvas = rotateLayerCanvas(layer.canvas, deg);
    }
    if (deg !== 180) docRef.current = { w: docRef.current.h, h: docRef.current.w };
    selectionRef.current = null;
    setOpenMenu(null);
    bump();
  }, [pushHistory, bump]);

  const flipCanvas = useCallback((axis: 'h' | 'v') => {
    pushHistory();
    for (const layer of layersRef.current) {
      delete layer.text;
      layer.canvas = flipLayerCanvas(layer.canvas, axis);
    }
    selectionRef.current = null;
    setOpenMenu(null);
    bump();
  }, [pushHistory, bump]);

  const applyResize = useCallback(() => {
    if (!resizeDialog) return;
    const w = Math.max(1, Math.round(resizeDialog.w));
    const h = Math.max(1, Math.round(resizeDialog.h));
    pushHistory();
    if (resizeDialog.kind === 'image') {
      const sx = w / docRef.current.w, sy = h / docRef.current.h;
      for (const layer of layersRef.current) {
        layer.canvas = resizeLayerCanvas(layer.canvas, w, h);
        if (layer.text) {
          layer.text.x *= sx; layer.text.y *= sy;
          layer.text.fontSize = Math.max(1, layer.text.fontSize * sy);
          renderTextLayer(layer);
        }
      }
    } else {
      for (const layer of layersRef.current) {
        const c = createCanvas(w, h);
        ctx2d(c).drawImage(layer.canvas, 0, 0);
        layer.canvas = c;
        if (layer.text) renderTextLayer(layer);
      }
    }
    docRef.current = { w, h };
    selectionRef.current = null;
    setResizeDialog(null);
    bump();
  }, [resizeDialog, pushHistory, bump]);

  const deleteSelectedPixels = useCallback(() => {
    const sel = selectionRef.current;
    const layer = activeLayer();
    if (!sel || !layer) return;
    ensureRaster(layer);
    pushHistory();
    const ctx = ctx2d(layer.canvas);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel.maskCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    bump();
  }, [activeLayer, ensureRaster, pushHistory, bump]);

  // --- coordinates ---
  const docPoint = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const wrap = wrapRef.current;
    if (!wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  }, [zoom]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    setZoom((prev) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * factor));
      if (next === prev) return prev;
      const wrap = wrapRef.current;
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        const px = (clientX - rect.left) / prev;
        const py = (clientY - rect.top) / prev;
        setPan((p) => ({
          x: p.x + (prev - next) * (px - docRef.current.w / 2),
          y: p.y + (prev - next) * (py - docRef.current.h / 2),
        }));
      }
      return next;
    });
  }, []);

  const fitZoom = useCallback(() => {
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!vp || !docRef.current.w) return;
    const fit = Math.min(1, (vp.width - 80) / docRef.current.w, (vp.height - 80) / docRef.current.h);
    setZoom(Math.max(MIN_ZOOM, fit));
    setPan({ x: 0, y: 0 });
  }, []);

  // --- transform geometry helpers ---
  function transformCorners(t: TransformState): Array<{ x: number; y: number }> {
    const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
      x: t.cx + (sx * t.w / 2) * cos - (sy * t.h / 2) * sin,
      y: t.cy + (sx * t.w / 2) * sin + (sy * t.h / 2) * cos,
    }));
  }
  function rotateHandlePos(t: TransformState, z: number): { x: number; y: number } {
    const d = t.h / 2 + 28 / z;
    return { x: t.cx + d * Math.sin(t.rot), y: t.cy - d * Math.cos(t.rot) };
  }

  // --- pointer handlers ---
  const beginPaintStroke = useCallback((p: { x: number; y: number }, kind: 'brush' | 'eraser'): DragState | null => {
    const layer = activeLayer();
    if (!layer) return null;
    if (!layer.visible) { showToast('err', 'Layer is hidden'); return null; }
    ensureRaster(layer);
    const { w, h } = docRef.current;
    const strokeCanvas = createCanvas(w, h);
    const size = kind === 'eraser' ? eraserSize : brushSize;
    const stamp = makeBrushStamp({ size, hardness: brushHardness, color: kind === 'eraser' ? '#ffffff' : fgColor });
    stampSegment(ctx2d(strokeCanvas), stamp, p.x, p.y, p.x, p.y, size);
    const state: DragState = { kind, start: p, last: p, strokeCanvas, stamp };
    if (kind === 'eraser') state.eraserTemp = createCanvas(w, h);
    const opacity = brushOpacity / 100;
    previewRef.current = {
      layerId: layer.id,
      draw: (ctx) => {
        if (kind === 'brush') {
          ctx.drawImage(layer.canvas, 0, 0);
          const a = ctx.globalAlpha;
          ctx.globalAlpha = a * opacity;
          ctx.drawImage(strokeCanvas, 0, 0);
          ctx.globalAlpha = a;
        } else {
          const temp = state.eraserTemp!;
          const tctx = ctx2d(temp);
          tctx.clearRect(0, 0, w, h);
          tctx.drawImage(layer.canvas, 0, 0);
          tctx.globalCompositeOperation = 'destination-out';
          tctx.globalAlpha = opacity;
          tctx.drawImage(strokeCanvas, 0, 0);
          tctx.globalAlpha = 1;
          tctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(temp, 0, 0);
        }
      },
    };
    return state;
  }, [activeLayer, ensureRaster, brushSize, eraserSize, brushHardness, brushOpacity, fgColor, showToast]);

  const commitPaintStroke = useCallback((drag: DragState) => {
    const layer = activeLayer();
    if (!layer || !drag.strokeCanvas) return;
    pushHistory();
    clipCanvasByMask(drag.strokeCanvas, selectionRef.current?.maskCanvas || null);
    const ctx = ctx2d(layer.canvas);
    ctx.globalAlpha = brushOpacity / 100;
    if (drag.kind === 'eraser') ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(drag.strokeCanvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    previewRef.current = null;
    bump();
  }, [activeLayer, pushHistory, brushOpacity, bump]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!ready || e.button === 2) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    const p = docPoint(e);
    pointerRef.current = p;

    // pan: middle button / space / hand tool
    if (e.button === 1 || spaceRef.current || tool === 'hand') {
      dragRef.current = { kind: 'hand', start: p, last: p, startClient: { x: e.clientX, y: e.clientY }, startPan: { ...pan } };
      return;
    }

    // transform interactions take precedence
    if (transform) {
      const hs = 10 / zoom;
      const rotP = rotateHandlePos(transform, zoom);
      if (Math.hypot(p.x - rotP.x, p.y - rotP.y) < hs) {
        dragRef.current = { kind: 'transform-rotate', start: p, last: p, origT: { ...transform } };
        return;
      }
      const corners = transformCorners(transform);
      for (let i = 0; i < corners.length; i++) {
        if (Math.hypot(p.x - corners[i].x, p.y - corners[i].y) < hs) {
          dragRef.current = { kind: 'transform-scale', start: p, last: p, handle: i, origT: { ...transform } };
          return;
        }
      }
      dragRef.current = { kind: 'transform-move', start: p, last: p, origT: { ...transform } };
      return;
    }

    switch (tool) {
      case 'marquee-rect':
      case 'marquee-ellipse':
        dragRef.current = { kind: 'marquee', start: p, last: p, combine: e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace' };
        break;
      case 'lasso':
        dragRef.current = { kind: 'lasso', start: p, last: p, points: [p], combine: e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace' };
        break;
      case 'wand': {
        const main = mainCanvasRef.current;
        if (!main) return;
        const buf = getPixels(main);
        const mask = floodFillMask(buf, p.x, p.y, tolerance);
        combineSelection(mask, undefined, e.shiftKey ? 'add' : e.altKey ? 'sub' : 'replace');
        break;
      }
      case 'crop':
        setCropRect(null);
        dragRef.current = { kind: 'crop', start: p, last: p };
        break;
      case 'eyedropper': {
        const main = mainCanvasRef.current;
        if (!main) return;
        const d = ctx2d(main).getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
        setFgColor(`#${((1 << 24) | (d[0] << 16) | (d[1] << 8) | d[2]).toString(16).slice(1)}`);
        break;
      }
      case 'brush':
      case 'eraser': {
        if (e.altKey && tool === 'brush') {
          const main = mainCanvasRef.current;
          if (main) {
            const d = ctx2d(main).getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
            setFgColor(`#${((1 << 24) | (d[0] << 16) | (d[1] << 8) | d[2]).toString(16).slice(1)}`);
          }
          break;
        }
        const state = beginPaintStroke(p, tool);
        if (state) { dragRef.current = state; redraw(); }
        break;
      }
      case 'clone': {
        if (e.altKey) {
          cloneSourceRef.current = p;
          drawOverlay();
          break;
        }
        if (!cloneSourceRef.current) { showToast('err', 'Alt+click to set clone source'); break; }
        const layer = activeLayer();
        if (!layer) break;
        ensureRaster(layer);
        const { w, h } = docRef.current;
        const strokeCanvas = createCanvas(w, h);
        const snap = cloneCanvas(layer.canvas);
        const offset = { x: cloneSourceRef.current.x - p.x, y: cloneSourceRef.current.y - p.y };
        cloneStampSegment(ctx2d(strokeCanvas), snap, offset.x, offset.y, p.x, p.y, p.x, p.y, brushSize, brushHardness);
        dragRef.current = { kind: 'clone', start: p, last: p, strokeCanvas, layerSnapshot: snap, cloneOffset: offset };
        previewRef.current = {
          layerId: layer.id,
          draw: (ctx) => { ctx.drawImage(layer.canvas, 0, 0); ctx.drawImage(strokeCanvas, 0, 0); },
        };
        redraw();
        break;
      }
      case 'fill': {
        const layer = activeLayer();
        if (!layer) break;
        ensureRaster(layer);
        pushHistory();
        const buf = getPixels(layer.canvas);
        const out = bucketFill(buf, p.x, p.y, hexToRgb(fgColor), tolerance, selectionRef.current?.mask || null);
        putPixels(layer.canvas, out);
        bump();
        break;
      }
      case 'gradient':
        dragRef.current = { kind: 'gradient', start: p, last: p };
        break;
      case 'shape-rect':
      case 'shape-ellipse':
      case 'shape-line':
        dragRef.current = { kind: 'shape', start: p, last: p };
        break;
      case 'text': {
        const layer = activeLayer();
        if (layer?.text) {
          // click inside existing text layer bounds → start dragging it
          const m = measureTextLayer(layer.text);
          if (p.x >= layer.text.x - 4 && p.x <= layer.text.x + m.w + 4 && p.y >= layer.text.y - 4 && p.y <= layer.text.y + m.h + 4) {
            dragRef.current = { kind: 'move', start: p, last: p, textStart: { x: layer.text.x, y: layer.text.y } };
            break;
          }
        }
        pushHistory();
        const { w, h } = docRef.current;
        const textLayer = makeLayer(`Text ${layersRef.current.length + 1}`, w, h);
        textLayer.text = {
          text: 'Text', x: p.x, y: p.y, fontFamily, fontSize,
          color: fgColor, bold: fontBold, italic: fontItalic,
        };
        renderTextLayer(textLayer);
        const idx = layersRef.current.findIndex((l) => l.id === activeLayerId);
        layersRef.current.splice(idx + 1, 0, textLayer);
        setActiveLayerId(textLayer.id);
        bump();
        break;
      }
      case 'move': {
        const layer = activeLayer();
        if (!layer) break;
        if (layer.text) {
          dragRef.current = { kind: 'move', start: p, last: p, textStart: { x: layer.text.x, y: layer.text.y } };
        } else {
          dragRef.current = { kind: 'move', start: p, last: p, layerSnapshot: cloneCanvas(layer.canvas) };
        }
        break;
      }
    }
  }, [ready, tool, pan, zoom, transform, docPoint, tolerance, setSelectionFromMask, beginPaintStroke, activeLayer,
    ensureRaster, pushHistory, bump, redraw, drawOverlay, fgColor, brushSize, brushHardness, fontFamily, fontSize,
    fontBold, fontItalic, activeLayerId, showToast]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const p = docPoint(e);
    pointerRef.current = p;
    const drag = dragRef.current;
    if (!drag) {
      if (tool === 'brush' || tool === 'eraser' || tool === 'clone') drawOverlay();
      return;
    }
    const prev = drag.last;
    drag.last = p;
    switch (drag.kind) {
      case 'hand': {
        if (drag.startClient && drag.startPan) {
          setPan({ x: drag.startPan.x + e.clientX - drag.startClient.x, y: drag.startPan.y + e.clientY - drag.startClient.y });
        }
        break;
      }
      case 'marquee':
      case 'crop':
        drawOverlay();
        break;
      case 'lasso':
        drag.points!.push(p);
        drawOverlay();
        break;
      case 'brush':
      case 'eraser': {
        if (drag.strokeCanvas && drag.stamp) {
          const size = drag.kind === 'eraser' ? eraserSize : brushSize;
          stampSegment(ctx2d(drag.strokeCanvas), drag.stamp, prev.x, prev.y, p.x, p.y, size);
          redraw();
        }
        break;
      }
      case 'clone': {
        if (drag.strokeCanvas && drag.layerSnapshot && drag.cloneOffset) {
          cloneStampSegment(ctx2d(drag.strokeCanvas), drag.layerSnapshot, drag.cloneOffset.x, drag.cloneOffset.y,
            prev.x, prev.y, p.x, p.y, brushSize, brushHardness);
          redraw();
        }
        break;
      }
      case 'gradient':
      case 'shape':
        drawOverlay();
        break;
      case 'move': {
        const layer = activeLayer();
        if (!layer) break;
        if (!drag.pushed) { pushHistory(); drag.pushed = true; }
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (layer.text && drag.textStart) {
          layer.text.x = drag.textStart.x + dx;
          layer.text.y = drag.textStart.y + dy;
          renderTextLayer(layer);
        } else if (drag.layerSnapshot) {
          const ctx = ctx2d(layer.canvas);
          ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
          ctx.drawImage(drag.layerSnapshot, dx, dy);
        }
        redraw();
        drawOverlay();
        break;
      }
      case 'transform-move': {
        if (transform && drag.origT) {
          setTransform({ ...transform, cx: drag.origT.cx + (p.x - drag.start.x), cy: drag.origT.cy + (p.y - drag.start.y) });
        }
        break;
      }
      case 'transform-rotate': {
        if (transform && drag.origT) {
          const a = Math.atan2(p.y - drag.origT.cy, p.x - drag.origT.cx) + Math.PI / 2;
          setTransform({ ...transform, rot: e.shiftKey ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a });
        }
        break;
      }
      case 'transform-scale': {
        if (transform && drag.origT) {
          const t = drag.origT;
          const cos = Math.cos(-t.rot), sin = Math.sin(-t.rot);
          const lx = (p.x - t.cx) * cos - (p.y - t.cy) * sin;
          const ly = (p.x - t.cx) * sin + (p.y - t.cy) * cos;
          let w = Math.max(2, Math.abs(lx) * 2);
          let h = Math.max(2, Math.abs(ly) * 2);
          if (e.shiftKey) {
            const s = Math.max(w / t.w, h / t.h);
            w = t.w * s; h = t.h * s;
          }
          setTransform({ ...t, w, h, rot: transform.rot });
        }
        break;
      }
    }
  }, [docPoint, tool, drawOverlay, redraw, brushSize, eraserSize, brushHardness, activeLayer, pushHistory, transform]);

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const { w, h } = docRef.current;
    switch (drag.kind) {
      case 'marquee': {
        const x = Math.min(drag.start.x, drag.last.x), y = Math.min(drag.start.y, drag.last.y);
        const rw = Math.abs(drag.last.x - drag.start.x), rh = Math.abs(drag.last.y - drag.start.y);
        const combine = drag.combine || 'replace';
        if (rw < 2 || rh < 2) { if (combine === 'replace') deselect(); break; }
        if (tool === 'marquee-ellipse') {
          combineSelection(ellipseMask(x + rw / 2, y + rh / 2, rw / 2, rh / 2, w, h),
            { kind: 'ellipse', cx: x + rw / 2, cy: y + rh / 2, rx: rw / 2, ry: rh / 2 }, combine);
        } else {
          combineSelection(rectMask(x, y, rw, rh, w, h), { kind: 'rect', x, y, w: rw, h: rh }, combine);
        }
        break;
      }
      case 'lasso': {
        const combine = drag.combine || 'replace';
        if (!drag.points || drag.points.length < 3) { if (combine === 'replace') deselect(); break; }
        combineSelection(polygonMask(drag.points, w, h), { kind: 'poly', points: drag.points }, combine);
        break;
      }
      case 'brush':
      case 'eraser':
        commitPaintStroke(drag);
        break;
      case 'clone': {
        const layer = activeLayer();
        if (layer && drag.strokeCanvas) {
          pushHistory();
          clipCanvasByMask(drag.strokeCanvas, selectionRef.current?.maskCanvas || null);
          ctx2d(layer.canvas).drawImage(drag.strokeCanvas, 0, 0);
          previewRef.current = null;
          bump();
        }
        break;
      }
      case 'gradient': {
        const layer = activeLayer();
        if (!layer) break;
        if (Math.hypot(drag.last.x - drag.start.x, drag.last.y - drag.start.y) < 3) break;
        ensureRaster(layer);
        pushHistory();
        const temp = createCanvas(w, h);
        const tctx = ctx2d(temp);
        const [r1, g1, b1] = hexToRgb(fgColor);
        const [r2, g2, b2] = hexToRgb(bgColor);
        const c0 = `rgba(${r1},${g1},${b1},1)`;
        const c1 = gradToTransparent ? `rgba(${r1},${g1},${b1},0)` : `rgba(${r2},${g2},${b2},1)`;
        let grad: CanvasGradient;
        if (gradKind === 'linear') {
          grad = tctx.createLinearGradient(drag.start.x, drag.start.y, drag.last.x, drag.last.y);
        } else {
          const radius = Math.hypot(drag.last.x - drag.start.x, drag.last.y - drag.start.y);
          grad = tctx.createRadialGradient(drag.start.x, drag.start.y, 0, drag.start.x, drag.start.y, radius);
        }
        grad.addColorStop(0, c0);
        grad.addColorStop(1, c1);
        tctx.fillStyle = grad;
        tctx.fillRect(0, 0, w, h);
        clipCanvasByMask(temp, selectionRef.current?.maskCanvas || null);
        ctx2d(layer.canvas).drawImage(temp, 0, 0);
        bump();
        break;
      }
      case 'shape': {
        const layer = activeLayer();
        if (!layer) break;
        ensureRaster(layer);
        pushHistory();
        const temp = createCanvas(w, h);
        const tctx = ctx2d(temp);
        tctx.strokeStyle = fgColor;
        tctx.fillStyle = fgColor;
        tctx.lineWidth = shapeStroke;
        tctx.beginPath();
        if (tool === 'shape-rect') tctx.rect(Math.min(drag.start.x, drag.last.x), Math.min(drag.start.y, drag.last.y), Math.abs(drag.last.x - drag.start.x), Math.abs(drag.last.y - drag.start.y));
        else if (tool === 'shape-ellipse') tctx.ellipse((drag.start.x + drag.last.x) / 2, (drag.start.y + drag.last.y) / 2, Math.abs(drag.last.x - drag.start.x) / 2, Math.abs(drag.last.y - drag.start.y) / 2, 0, 0, Math.PI * 2);
        else { tctx.moveTo(drag.start.x, drag.start.y); tctx.lineTo(drag.last.x, drag.last.y); }
        if (shapeFill && tool !== 'shape-line') tctx.fill();
        else tctx.stroke();
        clipCanvasByMask(temp, selectionRef.current?.maskCanvas || null);
        ctx2d(layer.canvas).drawImage(temp, 0, 0);
        bump();
        break;
      }
      case 'crop': {
        const x = Math.min(drag.start.x, drag.last.x), y = Math.min(drag.start.y, drag.last.y);
        const rw = Math.abs(drag.last.x - drag.start.x), rh = Math.abs(drag.last.y - drag.start.y);
        if (rw >= 2 && rh >= 2) setCropRect({ x, y, w: rw, h: rh });
        drawOverlay();
        break;
      }
      default:
        break;
    }
  }, [tool, deselect, setSelectionFromMask, commitPaintStroke, activeLayer, ensureRaster, pushHistory, bump,
    fgColor, bgColor, gradKind, gradToTransparent, shapeFill, shapeStroke, drawOverlay]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, [zoomAt]);

  // --- text editing (options bar) ---
  const updateActiveText = useCallback((patch: Partial<TextData>) => {
    const layer = activeLayer();
    if (!layer?.text) return;
    Object.assign(layer.text, patch);
    renderTextLayer(layer);
    redraw();
    drawOverlay();
    bump();
  }, [activeLayer, redraw, drawOverlay, bump]);

  // --- save / export ---
  const flattenToDataUrl = useCallback((mime: string, quality?: number): string => {
    const { w, h } = docRef.current;
    const flat = createCanvas(w, h);
    if (mime === 'image/jpeg') {
      const ctx = ctx2d(flat);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    compositeLayers(layersRef.current, w, h, flat);
    // compositeLayers resets the canvas; re-add white base for jpeg
    if (mime === 'image/jpeg') {
      const withBg = createCanvas(w, h);
      const ctx = ctx2d(withBg);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(flat, 0, 0);
      return withBg.toDataURL(mime, quality ?? 0.92);
    }
    return flat.toDataURL(mime, quality ?? 0.92);
  }, []);

  const writeToPath = useCallback(async (path: string, dataUrl: string) => {
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    await invoke('write_file_base64', { path, base64Data: base64 });
  }, []);

  const save = useCallback(async (as?: boolean) => {
    setBusy(true);
    try {
      let targetPath = !as ? filePath : undefined;
      const ext = extOf(fileName) || 'png';
      if (!targetPath) {
        const base = (fileName || 'image').replace(/\.[^.]+$/, '');
        const picked = await invoke<string | null>('save_file_dialog', {
          defaultName: `${base}_edited.${ext}`,
          filters: [[`${ext.toUpperCase()} Image`, [ext]]],
        });
        if (!picked) { setBusy(false); return; }
        targetPath = picked;
      }
      const dataUrl = flattenToDataUrl(mimeOf(fileName));
      await writeToPath(targetPath, dataUrl);
      setDirty(false);
      onSaved?.(targetPath);
      onSavedData?.(dataUrl, targetPath);
      showToast('ok', 'Saved');
    } catch (err) {
      console.error('[PhotoEditor] save failed:', err);
      showToast('err', 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [filePath, fileName, flattenToDataUrl, writeToPath, onSaved, showToast]);

  const doExport = useCallback(async () => {
    if (!exportDialog) return;
    setBusy(true);
    try {
      const ext = exportDialog.format === 'jpeg' ? 'jpg' : exportDialog.format;
      const base = (fileName || 'image').replace(/\.[^.]+$/, '');
      const picked = await invoke<string | null>('save_file_dialog', {
        defaultName: `${base}.${ext}`,
        filters: [[`${ext.toUpperCase()} Image`, [ext]]],
      });
      if (!picked) { setBusy(false); return; }
      const mime = `image/${exportDialog.format}`;
      await writeToPath(picked, flattenToDataUrl(mime, exportDialog.quality / 100));
      setExportDialog(null);
      onSaved?.(picked);
      showToast('ok', 'Exported');
    } catch (err) {
      console.error('[PhotoEditor] export failed:', err);
      showToast('err', 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [exportDialog, fileName, flattenToDataUrl, writeToPath, onSaved, showToast]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onDirtyChange?.(false);
    onClose();
  }, [dirty, onClose, onDirtyChange]);

  // --- keyboard ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space' && !typing) { spaceRef.current = true; }
      if (typing && !mod) return;
      if (mod) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
        if (k === 'y') { e.preventDefault(); redo(); return; }
        if (k === 's') { e.preventDefault(); void save(e.shiftKey); return; }
        if (k === 'a' && !typing) { e.preventDefault(); selectAll(); return; }
        if (k === 'd' && !typing) { e.preventDefault(); deselect(); return; }
        if (k === 'i' && e.shiftKey) { e.preventDefault(); invertSelection(); return; }
        if (k === 't' && !typing) { e.preventDefault(); if (!transform) startTransform(); return; }
        if (k === 'j' && !typing) { e.preventDefault(); layerViaCopy(); return; }
        if (k === 'm' && !typing) { e.preventDefault(); if (!curves) openCurves(); return; }
        if (k === '=' || k === '+') { e.preventDefault(); setZoom((z) => Math.min(MAX_ZOOM, z * 1.25)); return; }
        if (k === '-') { e.preventDefault(); setZoom((z) => Math.max(MIN_ZOOM, z / 1.25)); return; }
        if (k === '0') { e.preventDefault(); fitZoom(); return; }
        if (k === '1') { e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); return; }
        return;
      }
      if (typing) return;
      switch (e.key) {
        case 'Enter':
          if (transform) { e.preventDefault(); applyTransform(); }
          else if (cropRect) { e.preventDefault(); applyCrop(); }
          break;
        case 'Escape':
          if (transform) cancelTransform();
          else if (cropRect) { setCropRect(null); drawOverlay(); }
          else if (adjust) setAdjust(null);
          else if (curves) setCurves(null);
          else if (openMenu) setOpenMenu(null);
          else if (selectionRef.current) deselect();
          break;
        case 'Delete': case 'Backspace':
          if (selectionRef.current) { e.preventDefault(); deleteSelectedPixels(); }
          break;
        case '[':
          if (tool === 'eraser') setEraserSize((s) => Math.max(1, Math.round(s / 1.15)));
          else setBrushSize((s) => Math.max(1, Math.round(s / 1.15)));
          break;
        case ']':
          if (tool === 'eraser') setEraserSize((s) => Math.min(500, Math.round(s * 1.15) + 1));
          else setBrushSize((s) => Math.min(500, Math.round(s * 1.15) + 1));
          break;
        case 'x': case 'X': {
          setFgColor(bgColor); setBgColor(fgColor);
          break;
        }
        case 'v': case 'V': setTool('move'); break;
        case 'm': case 'M': setTool((t) => t === 'marquee-rect' ? 'marquee-ellipse' : 'marquee-rect'); break;
        case 'l': case 'L': setTool('lasso'); break;
        case 'w': case 'W': setTool('wand'); break;
        case 'c': case 'C': setTool('crop'); break;
        case 'i': case 'I': setTool('eyedropper'); break;
        case 'b': case 'B': setTool('brush'); break;
        case 'e': case 'E': setTool('eraser'); break;
        case 'g': case 'G': setTool('fill'); break;
        case 's': case 'S': setTool('clone'); break;
        case 't': case 'T': setTool('text'); break;
        case 'u': case 'U': setTool((t) => t === 'shape-rect' ? 'shape-ellipse' : t === 'shape-ellipse' ? 'shape-line' : 'shape-rect'); break;
        case 'h': case 'H': setTool('hand'); break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [undo, redo, save, selectAll, deselect, invertSelection, transform, startTransform, applyTransform,
    cancelTransform, cropRect, applyCrop, adjust, curves, openCurves, layerViaCopy, openMenu,
    deleteSelectedPixels, tool, fgColor, bgColor, fitZoom, drawOverlay]);

  // --- layer thumbnails ---
  const thumbs = useMemo(() => {
    void version;
    const map: Record<string, string> = {};
    for (const layer of layersRef.current) {
      const t = createCanvas(40, 30);
      const ctx = ctx2d(t);
      const scale = Math.min(40 / layer.canvas.width, 30 / layer.canvas.height);
      const tw = layer.canvas.width * scale, th = layer.canvas.height * scale;
      ctx.drawImage(layer.canvas, (40 - tw) / 2, (30 - th) / 2, tw, th);
      map[layer.id] = t.toDataURL();
    }
    return map;
  }, [version]);

  const active = activeLayer();
  const doc = docRef.current;
  const hasSelection = !!selectionRef.current;

  const TOOL_DEFS: Array<{ id: Tool; icon: React.ReactNode; label: string }> = [
    { id: 'move', icon: <MousePointer2 size={15} />, label: 'Move (V)' },
    { id: 'marquee-rect', icon: <SquareDashed size={15} />, label: 'Rectangular Marquee (M)' },
    { id: 'marquee-ellipse', icon: <CircleDashed size={15} />, label: 'Elliptical Marquee (M)' },
    { id: 'lasso', icon: <Lasso size={15} />, label: 'Lasso (L)' },
    { id: 'wand', icon: <Wand2 size={15} />, label: 'Magic Wand (W)' },
    { id: 'crop', icon: <CropIcon size={15} />, label: 'Crop (C)' },
    { id: 'eyedropper', icon: <Pipette size={15} />, label: 'Eyedropper (I)' },
    { id: 'brush', icon: <Brush size={15} />, label: 'Brush (B)' },
    { id: 'eraser', icon: <Eraser size={15} />, label: 'Eraser (E)' },
    { id: 'fill', icon: <PaintBucket size={15} />, label: 'Paint Bucket (G)' },
    { id: 'gradient', icon: <Blend size={15} />, label: 'Gradient' },
    { id: 'clone', icon: <Stamp size={15} />, label: 'Clone Stamp (S) — Alt+click sets source' },
    { id: 'text', icon: <TypeIcon size={15} />, label: 'Text (T)' },
    { id: 'shape-rect', icon: <Square size={15} />, label: 'Rectangle (U)' },
    { id: 'shape-ellipse', icon: <Circle size={15} />, label: 'Ellipse (U)' },
    { id: 'shape-line', icon: <Minus size={15} />, label: 'Line (U)' },
    { id: 'hand', icon: <Hand size={15} />, label: 'Hand (H / Space)' },
  ];

  const menuDef: Record<string, Array<{ label: string; action?: () => void; divider?: boolean; disabled?: boolean }>> = {
    Image: [
      { label: 'Image Size…', action: () => { setResizeDialog({ kind: 'image', w: doc.w, h: doc.h, lock: true }); setOpenMenu(null); } },
      { label: 'Canvas Size…', action: () => { setResizeDialog({ kind: 'canvas', w: doc.w, h: doc.h, lock: false }); setOpenMenu(null); } },
      { label: '', divider: true },
      { label: 'Rotate 90° CW', action: () => rotateCanvas(90) },
      { label: 'Rotate 90° CCW', action: () => rotateCanvas(-90) },
      { label: 'Rotate 180°', action: () => rotateCanvas(180) },
      { label: 'Flip Horizontal', action: () => flipCanvas('h') },
      { label: 'Flip Vertical', action: () => flipCanvas('v') },
    ],
    Select: [
      { label: 'Select All (⌘A)', action: () => { selectAll(); setOpenMenu(null); } },
      { label: 'Deselect (⌘D)', action: () => { deselect(); setOpenMenu(null); } },
      { label: 'Invert Selection (⇧⌘I)', action: () => { invertSelection(); setOpenMenu(null); } },
      { label: 'Delete Selected Pixels', action: () => { deleteSelectedPixels(); setOpenMenu(null); }, disabled: !hasSelection },
    ],
    Adjust: [
      { label: 'Brightness / Contrast…', action: () => openAdjust('brightness-contrast') },
      { label: 'Hue / Saturation…', action: () => openAdjust('hue-saturation') },
      { label: 'Curves… (⌘M)', action: openCurves },
      { label: 'Levels…', action: () => openAdjust('levels') },
      { label: 'Color Balance…', action: () => openAdjust('color-balance') },
      { label: '', divider: true },
      { label: 'Invert', action: () => { applyOneShot('invert'); setOpenMenu(null); } },
      { label: 'Grayscale', action: () => { applyOneShot('grayscale'); setOpenMenu(null); } },
      { label: 'Sepia', action: () => { applyOneShot('sepia'); setOpenMenu(null); } },
    ],
    Filter: [
      { label: 'Gaussian Blur…', action: () => openAdjust('blur') },
      { label: 'Sharpen…', action: () => openAdjust('sharpen') },
      { label: 'Pixelate…', action: () => openAdjust('pixelate') },
      { label: 'Add Noise…', action: () => openAdjust('noise') },
      { label: 'Vignette…', action: () => openAdjust('vignette') },
    ],
    Layer: [
      { label: 'New Layer', action: () => { addLayer(); setOpenMenu(null); } },
      { label: 'Layer via Copy (⌘J)', action: () => { layerViaCopy(); setOpenMenu(null); } },
      { label: 'Duplicate Layer', action: () => { duplicateLayer(); setOpenMenu(null); } },
      { label: 'Delete Layer', action: () => { deleteLayer(); setOpenMenu(null); } },
      { label: '', divider: true },
      { label: 'Free Transform (⌘T)', action: () => { startTransform(); setOpenMenu(null); } },
      { label: 'Merge Down', action: () => { mergeDown(); setOpenMenu(null); } },
      { label: 'Flatten Image', action: () => { flattenLayers(); setOpenMenu(null); } },
    ],
  };

  return (
    <div className="pe-root" style={{ ['--pe-bg' as any]: bg, ['--pe-fg' as any]: fg, ['--pe-accent' as any]: accent }}>
      {/* top bar: menus + actions */}
      <div className="pe-topbar">
        <span className="pe-title" title={filePath || fileName}>{fileName}{dirty ? ' •' : ''}</span>
        <div className="pe-menus">
          {Object.keys(menuDef).map((name) => (
            <div key={name} className="pe-menu-wrap">
              <button
                className={`pe-menu-btn ${openMenu === name ? 'open' : ''}`}
                onClick={() => setOpenMenu(openMenu === name ? null : name)}
              >{name}</button>
              {openMenu === name && (
                <div className="pe-menu-drop">
                  {menuDef[name].map((item, i) => item.divider
                    ? <div key={i} className="pe-menu-divider" />
                    : (
                      <button key={i} className="pe-menu-item" disabled={item.disabled} onClick={item.action}>
                        {item.label}
                      </button>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="pe-top-actions">
          <button className="pe-icon-btn" onClick={undo} disabled={historyRef.current.undo.length === 0} title="Undo (⌘Z)"><Undo2 size={14} /></button>
          <button className="pe-icon-btn" onClick={redo} disabled={historyRef.current.redo.length === 0} title="Redo (⇧⌘Z)"><Redo2 size={14} /></button>
          <span className="pe-sep" />
          <button className="pe-icon-btn" onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25)} title="Zoom out"><ZoomOut size={14} /></button>
          <span className="pe-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="pe-icon-btn" onClick={() => zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25)} title="Zoom in"><ZoomIn size={14} /></button>
          <button className="pe-icon-btn" onClick={fitZoom} title="Fit (⌘0)"><Maximize2 size={14} /></button>
          <span className="pe-sep" />
          <button className="pe-primary-btn" onClick={() => void save(false)} disabled={busy || !dirty} title="Save (⌘S)">
            <Save size={13} /> Save
          </button>
          <button className="pe-secondary-btn" onClick={() => void save(true)} disabled={busy}>Save As</button>
          <button className="pe-secondary-btn" onClick={() => setExportDialog({ format: 'png', quality: 92 })} disabled={busy}>Export</button>
          <button className="pe-icon-btn pe-close" onClick={requestClose} title="Close editor"><X size={15} /></button>
        </div>
      </div>

      {/* options bar (per tool) */}
      <div className="pe-optionsbar">
        {(tool === 'brush' || tool === 'clone') && (
          <>
            <label>Size <input type="range" min={1} max={300} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} /> <span className="pe-val">{brushSize}px</span></label>
            <label>Hardness <input type="range" min={0} max={100} value={brushHardness} onChange={(e) => setBrushHardness(+e.target.value)} /> <span className="pe-val">{brushHardness}%</span></label>
            <label>Opacity <input type="range" min={1} max={100} value={brushOpacity} onChange={(e) => setBrushOpacity(+e.target.value)} /> <span className="pe-val">{brushOpacity}%</span></label>
            {tool === 'clone' && <span className="pe-hint">Alt+click to set source, then paint</span>}
          </>
        )}
        {tool === 'eraser' && (
          <>
            <label>Size <input type="range" min={1} max={300} value={eraserSize} onChange={(e) => setEraserSize(+e.target.value)} /> <span className="pe-val">{eraserSize}px</span></label>
            <label>Hardness <input type="range" min={0} max={100} value={brushHardness} onChange={(e) => setBrushHardness(+e.target.value)} /> <span className="pe-val">{brushHardness}%</span></label>
            <label>Opacity <input type="range" min={1} max={100} value={brushOpacity} onChange={(e) => setBrushOpacity(+e.target.value)} /> <span className="pe-val">{brushOpacity}%</span></label>
          </>
        )}
        {(tool === 'wand' || tool === 'fill') && (
          <label>Tolerance <input type="range" min={0} max={255} value={tolerance} onChange={(e) => setTolerance(+e.target.value)} /> <span className="pe-val">{tolerance}</span></label>
        )}
        {tool === 'gradient' && (
          <>
            <label>Type
              <select value={gradKind} onChange={(e) => setGradKind(e.target.value as 'linear' | 'radial')}>
                <option value="linear">Linear</option>
                <option value="radial">Radial</option>
              </select>
            </label>
            <label className="pe-check"><input type="checkbox" checked={gradToTransparent} onChange={(e) => setGradToTransparent(e.target.checked)} /> To transparent</label>
            <span className="pe-hint">Drag on canvas to draw the gradient</span>
          </>
        )}
        {(tool === 'shape-rect' || tool === 'shape-ellipse' || tool === 'shape-line') && (
          <>
            {tool !== 'shape-line' && <label className="pe-check"><input type="checkbox" checked={shapeFill} onChange={(e) => setShapeFill(e.target.checked)} /> Fill</label>}
            <label>Stroke <input type="range" min={1} max={64} value={shapeStroke} onChange={(e) => setShapeStroke(+e.target.value)} /> <span className="pe-val">{shapeStroke}px</span></label>
          </>
        )}
        {tool === 'crop' && (
          <>
            <span className="pe-hint">Drag to choose crop area</span>
            {cropRect && (
              <>
                <span className="pe-val">{Math.round(cropRect.w)} × {Math.round(cropRect.h)}px</span>
                <button className="pe-primary-btn" onClick={applyCrop}><Check size={12} /> Apply Crop (Enter)</button>
                <button className="pe-secondary-btn" onClick={() => { setCropRect(null); drawOverlay(); }}>Cancel (Esc)</button>
              </>
            )}
          </>
        )}
        {tool === 'text' && (
          <>
            <input
              className="pe-text-input"
              type="text"
              placeholder="Type text…"
              value={active?.text?.text ?? ''}
              disabled={!active?.text}
              onChange={(e) => updateActiveText({ text: e.target.value })}
            />
            <select value={active?.text?.fontFamily ?? fontFamily} onChange={(e) => { setFontFamily(e.target.value); updateActiveText({ fontFamily: e.target.value }); }}>
              {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <input
              className="pe-num-input" type="number" min={4} max={800}
              value={Math.round(active?.text?.fontSize ?? fontSize)}
              onChange={(e) => { setFontSize(+e.target.value); updateActiveText({ fontSize: +e.target.value }); }}
            />
            <button className={`pe-toggle ${(active?.text?.bold ?? fontBold) ? 'on' : ''}`} onClick={() => { const v = !(active?.text?.bold ?? fontBold); setFontBold(v); updateActiveText({ bold: v }); }}><b>B</b></button>
            <button className={`pe-toggle ${(active?.text?.italic ?? fontItalic) ? 'on' : ''}`} onClick={() => { const v = !(active?.text?.italic ?? fontItalic); setFontItalic(v); updateActiveText({ italic: v }); }}><i>I</i></button>
            <input type="color" value={active?.text?.color ?? fgColor} onChange={(e) => updateActiveText({ color: e.target.value })} title="Text color" />
            {!active?.text && <span className="pe-hint">Click on canvas to add a text layer</span>}
          </>
        )}
        {transform && (
          <>
            <span className="pe-hint">Drag corners to scale · top handle rotates · Shift constrains</span>
            <button className="pe-primary-btn" onClick={applyTransform}><Check size={12} /> Apply (Enter)</button>
            <button className="pe-secondary-btn" onClick={cancelTransform}>Cancel (Esc)</button>
          </>
        )}
        {(tool === 'move' && !transform) && <span className="pe-hint">Drag to move the active layer · ⌘T free transform</span>}
        {(tool === 'wand' || tool === 'marquee-rect' || tool === 'marquee-ellipse' || tool === 'lasso') && hasSelection && (
          <button className="pe-secondary-btn" onClick={deselect}>Deselect (⌘D)</button>
        )}
      </div>

      <div className="pe-body">
        {/* left tool palette */}
        <div className="pe-tools">
          {TOOL_DEFS.map((t) => (
            <button
              key={t.id}
              className={`pe-tool-btn ${tool === t.id ? 'active' : ''}`}
              title={t.label}
              onClick={() => { setTool(t.id); if (t.id !== 'crop') { setCropRect(null); drawOverlay(); } }}
            >{t.icon}</button>
          ))}
          <div className="pe-colors">
            <div className="pe-color-stack" title="Foreground / Background (X swaps)">
              <input type="color" className="pe-color-fg" value={fgColor} onChange={(e) => setFgColor(e.target.value)} />
              <input type="color" className="pe-color-bg" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
            </div>
            <button className="pe-icon-btn" onClick={() => { setFgColor(bgColor); setBgColor(fgColor); }} title="Swap colors (X)"><ArrowLeftRight size={11} /></button>
          </div>
        </div>

        {/* canvas viewport */}
        <div
          ref={viewportRef}
          className={`pe-viewport pe-cursor-${tool}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => { pointerRef.current = null; drawOverlay(); }}
          onWheel={handleWheel}
        >
          {!ready && <div className="pe-loading">Loading image…</div>}
          <div
            ref={wrapRef}
            className="pe-canvas-wrap"
            style={{
              width: doc.w * zoom,
              height: doc.h * zoom,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              display: ready ? 'block' : 'none',
            }}
          >
            <canvas ref={mainCanvasRef} className="pe-main-canvas" />
            <canvas ref={overlayRef} className="pe-overlay-canvas" />
          </div>
          {toast && <div className={`pe-toast ${toast.kind}`}>{toast.text}</div>}
        </div>

        {/* right panel: layers */}
        <div className="pe-side">
          <div className="pe-panel-title"><LayersIcon size={13} /> Layers</div>
          <div className="pe-layer-controls">
            <select
              value={active?.blendMode ?? 'normal'}
              onChange={(e) => { if (!active) return; pushHistory(); active.blendMode = e.target.value as BlendMode; bump(); }}
              title="Blend mode"
            >
              {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <label className="pe-opacity">
              Opacity
              <input
                type="range" min={0} max={100}
                value={active?.opacity ?? 100}
                onChange={(e) => { if (!active) return; active.opacity = +e.target.value; redraw(); bump(); }}
                onMouseDown={() => { if (active) pushHistory(); }}
              />
              <span className="pe-val">{active?.opacity ?? 100}%</span>
            </label>
          </div>
          <div className="pe-layer-list">
            {[...layersRef.current].reverse().map((layer) => (
              <div
                key={layer.id}
                className={`pe-layer-item ${layer.id === activeLayerId ? 'active' : ''}`}
                onClick={() => setActiveLayerId(layer.id)}
                onDoubleClick={() => setRenamingId(layer.id)}
              >
                <button
                  className="pe-eye"
                  onClick={(e) => { e.stopPropagation(); layer.visible = !layer.visible; redraw(); bump(); }}
                  title={layer.visible ? 'Hide layer' : 'Show layer'}
                >{layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                <img className="pe-thumb" src={thumbs[layer.id]} alt="" draggable={false} />
                {renamingId === layer.id ? (
                  <input
                    className="pe-rename"
                    autoFocus
                    defaultValue={layer.name}
                    onBlur={(e) => { layer.name = e.target.value || layer.name; setRenamingId(null); bump(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenamingId(null);
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="pe-layer-name">{layer.text ? 'T ' : ''}{layer.name}</span>
                )}
              </div>
            ))}
          </div>
          <div className="pe-layer-actions">
            <button className="pe-icon-btn" onClick={addLayer} title="New layer"><Plus size={13} /></button>
            <button className="pe-icon-btn" onClick={duplicateLayer} title="Duplicate layer"><Copy size={13} /></button>
            <button className="pe-icon-btn" onClick={() => moveLayer(1)} title="Move layer up"><ChevronUp size={13} /></button>
            <button className="pe-icon-btn" onClick={() => moveLayer(-1)} title="Move layer down"><ChevronDown size={13} /></button>
            <button className="pe-icon-btn" onClick={mergeDown} title="Merge down"><Blend size={13} /></button>
            <button className="pe-icon-btn" onClick={deleteLayer} title="Delete layer"><Trash2 size={13} /></button>
          </div>
          <div className="pe-doc-info">
            {doc.w} × {doc.h}px{hasSelection ? ' · selection active' : ''}
          </div>
        </div>
      </div>

      {/* adjustment / filter dialog */}
      {adjust && (
        <div className="pe-dialog-scrim" onClick={(e) => { if (e.target === e.currentTarget) setAdjust(null); }}>
          <div className="pe-dialog">
            <div className="pe-dialog-title">{ADJUSTMENTS[adjust.kind].title}</div>
            {ADJUSTMENTS[adjust.kind].params.map((p) => (
              <label key={p.key} className="pe-dialog-row">
                <span>{p.label}</span>
                <input
                  type="range" min={p.min} max={p.max} step={p.step ?? 1}
                  value={adjust.params[p.key]}
                  onChange={(e) => setAdjust({ ...adjust, params: { ...adjust.params, [p.key]: +e.target.value } })}
                />
                <span className="pe-val">{adjust.params[p.key]}</span>
              </label>
            ))}
            {hasSelection && <div className="pe-hint" style={{ marginTop: 4 }}>Applies to current selection only</div>}
            <div className="pe-dialog-actions">
              <button className="pe-secondary-btn" onClick={() => setAdjust(null)}>Cancel</button>
              <button className="pe-primary-btn" onClick={applyAdjust}><Check size={12} /> Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* curves dialog */}
      {curves && (
        <div className="pe-dialog-scrim" onClick={(e) => { if (e.target === e.currentTarget) setCurves(null); }}>
          <div className="pe-dialog">
            <div className="pe-dialog-title">Curves</div>
            <CurvesPanel points={curves} hist={curvesHistRef.current} accent={accent} onChange={setCurves} />
            <div className="pe-hint">Drag points to shape the curve · click adds a point · double-click removes</div>
            {hasSelection && <div className="pe-hint">Applies to current selection only</div>}
            <div className="pe-dialog-actions">
              <button className="pe-secondary-btn" onClick={() => setCurves([{ x: 0, y: 0 }, { x: 255, y: 255 }])}>Reset</button>
              <button className="pe-secondary-btn" onClick={() => setCurves(null)}>Cancel</button>
              <button className="pe-primary-btn" onClick={applyCurves}><Check size={12} /> Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* resize dialog */}
      {resizeDialog && (
        <div className="pe-dialog-scrim" onClick={(e) => { if (e.target === e.currentTarget) setResizeDialog(null); }}>
          <div className="pe-dialog">
            <div className="pe-dialog-title">{resizeDialog.kind === 'image' ? 'Image Size' : 'Canvas Size'}</div>
            <label className="pe-dialog-row">
              <span>Width</span>
              <input
                className="pe-num-input" type="number" min={1} max={16384} value={Math.round(resizeDialog.w)}
                onChange={(e) => {
                  const w = +e.target.value;
                  setResizeDialog((d) => d && ({ ...d, w, h: d.lock ? Math.round(w * doc.h / doc.w) : d.h }));
                }}
              />
              <span className="pe-val">px</span>
            </label>
            <label className="pe-dialog-row">
              <span>Height</span>
              <input
                className="pe-num-input" type="number" min={1} max={16384} value={Math.round(resizeDialog.h)}
                onChange={(e) => {
                  const h = +e.target.value;
                  setResizeDialog((d) => d && ({ ...d, h, w: d.lock ? Math.round(h * doc.w / doc.h) : d.w }));
                }}
              />
              <span className="pe-val">px</span>
            </label>
            <label className="pe-check" style={{ marginTop: 4 }}>
              <input type="checkbox" checked={resizeDialog.lock} onChange={(e) => setResizeDialog((d) => d && ({ ...d, lock: e.target.checked }))} />
              Constrain proportions
            </label>
            <div className="pe-dialog-actions">
              <button className="pe-secondary-btn" onClick={() => setResizeDialog(null)}>Cancel</button>
              <button className="pe-primary-btn" onClick={applyResize}><Check size={12} /> Apply</button>
            </div>
          </div>
        </div>
      )}

      {/* export dialog */}
      {exportDialog && (
        <div className="pe-dialog-scrim" onClick={(e) => { if (e.target === e.currentTarget) setExportDialog(null); }}>
          <div className="pe-dialog">
            <div className="pe-dialog-title">Export</div>
            <div className="pe-dialog-row">
              <span>Format</span>
              <div className="pe-format-row">
                {(['png', 'jpeg', 'webp'] as const).map((f) => (
                  <button
                    key={f}
                    className={`pe-toggle ${exportDialog.format === f ? 'on' : ''}`}
                    onClick={() => setExportDialog({ ...exportDialog, format: f })}
                  >{f.toUpperCase()}</button>
                ))}
              </div>
            </div>
            {exportDialog.format !== 'png' && (
              <label className="pe-dialog-row">
                <span>Quality</span>
                <input type="range" min={5} max={100} value={exportDialog.quality} onChange={(e) => setExportDialog({ ...exportDialog, quality: +e.target.value })} />
                <span className="pe-val">{exportDialog.quality}%</span>
              </label>
            )}
            <div className="pe-dialog-actions">
              <button className="pe-secondary-btn" onClick={() => setExportDialog(null)}>Cancel</button>
              <button className="pe-primary-btn" onClick={() => void doExport()} disabled={busy}><Check size={12} /> Export…</button>
            </div>
          </div>
        </div>
      )}

      {openMenu && <div className="pe-menu-scrim" onClick={() => setOpenMenu(null)} />}
    </div>
  );
}
