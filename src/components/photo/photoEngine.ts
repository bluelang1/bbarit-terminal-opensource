// Canvas-side engine for the photo editor: layer model, compositing, history
// snapshots, brush stamping, text layer rendering. Pixel math lives in
// photoFilters.ts; this file owns everything that needs a real canvas.

import { hexToRgb, type PixelBuf } from './photoFilters';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

export function blendToComposite(mode: BlendMode): GlobalCompositeOperation {
  return (mode === 'normal' ? 'source-over' : mode) as GlobalCompositeOperation;
}

export interface TextData {
  text: string;
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface PhotoLayer {
  id: string;
  name: string;
  canvas: HTMLCanvasElement;
  visible: boolean;
  opacity: number; // 0..100
  blendMode: BlendMode;
  text?: TextData; // present → layer is an editable text layer
}

export interface DocSnapshot {
  width: number;
  height: number;
  activeLayerId: string;
  layers: Array<{
    id: string;
    name: string;
    visible: boolean;
    opacity: number;
    blendMode: BlendMode;
    text?: TextData;
    canvas: HTMLCanvasElement; // cloned, immutable
  }>;
}

let idCounter = 0;
export function nextLayerId(): string {
  idCounter += 1;
  return `layer-${Date.now().toString(36)}-${idCounter}`;
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function makeLayer(name: string, w: number, h: number): PhotoLayer {
  return {
    id: nextLayerId(),
    name,
    canvas: createCanvas(w, h),
    visible: true,
    opacity: 100,
    blendMode: 'normal',
  };
}

export function snapshotDoc(width: number, height: number, layers: PhotoLayer[], activeLayerId: string): DocSnapshot {
  return {
    width,
    height,
    activeLayerId,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      opacity: l.opacity,
      blendMode: l.blendMode,
      text: l.text ? { ...l.text } : undefined,
      canvas: cloneCanvas(l.canvas),
    })),
  };
}

export function restoreDoc(snap: DocSnapshot): PhotoLayer[] {
  return snap.layers.map((l) => ({
    id: l.id,
    name: l.name,
    visible: l.visible,
    opacity: l.opacity,
    blendMode: l.blendMode,
    text: l.text ? { ...l.text } : undefined,
    canvas: cloneCanvas(l.canvas),
  }));
}

// Composite all visible layers bottom→top into `target` (resized to doc size).
export function compositeLayers(
  layers: PhotoLayer[],
  width: number,
  height: number,
  target: HTMLCanvasElement,
  override?: { layerId: string; draw: (ctx: CanvasRenderingContext2D) => void } | null,
) {
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  const ctx = ctx2d(target);
  ctx.clearRect(0, 0, width, height);
  for (const layer of layers) {
    if (!layer.visible) continue;
    ctx.globalAlpha = layer.opacity / 100;
    ctx.globalCompositeOperation = blendToComposite(layer.blendMode);
    if (override && override.layerId === layer.id) {
      override.draw(ctx);
    } else {
      ctx.drawImage(layer.canvas, 0, 0);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

export function renderTextLayer(layer: PhotoLayer) {
  if (!layer.text) return;
  const t = layer.text;
  const ctx = ctx2d(layer.canvas);
  ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.fontSize}px ${t.fontFamily}`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'top';
  const lines = t.text.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, t.x, t.y + i * t.fontSize * 1.2);
  });
}

export function measureTextLayer(t: TextData): { w: number; h: number } {
  const c = createCanvas(1, 1);
  const ctx = ctx2d(c);
  ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${t.fontSize}px ${t.fontFamily}`;
  const lines = t.text.split('\n');
  let w = 0;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  return { w, h: lines.length * t.fontSize * 1.2 };
}

// --- Selection mask <-> canvas ---

export function maskToCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(w, h);
  for (let p = 0; p < mask.length; p++) {
    img.data[p * 4 + 3] = mask[p];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Edge pixels of a mask, for drawing wand-selection outlines.
export function maskEdgePoints(mask: Uint8Array, w: number, h: number, maxPoints = 20000): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < h && pts.length < maxPoints; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1
        || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) {
        pts.push({ x, y });
        if (pts.length >= maxPoints) break;
      }
    }
  }
  return pts;
}

export function maskBounds(mask: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Restrict a painted stroke canvas to the current selection before compositing.
export function clipCanvasByMask(strokeCanvas: HTMLCanvasElement, maskCanvas: HTMLCanvasElement | null) {
  if (!maskCanvas) return;
  const ctx = ctx2d(strokeCanvas);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}

// --- Brush stamping ---

export interface BrushStamp {
  size: number;      // diameter, px
  hardness: number;  // 0..100
  color: string;     // hex
}

// One round stamp: hard center, gradient falloff by hardness.
export function makeBrushStamp(stamp: BrushStamp): HTMLCanvasElement {
  const d = Math.max(1, Math.ceil(stamp.size));
  const c = createCanvas(d, d);
  const ctx = ctx2d(c);
  const r = d / 2;
  const [cr, cg, cb] = hexToRgb(stamp.color);
  const hard = Math.min(1, Math.max(0, stamp.hardness / 100));
  if (d <= 2) {
    ctx.fillStyle = stamp.color;
    ctx.fillRect(0, 0, d, d);
    return c;
  }
  const grad = ctx.createRadialGradient(r, r, r * hard * 0.99, r, r, r);
  grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
  grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = hard >= 1 ? `rgba(${cr},${cg},${cb},1)` : grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.closePath();
  if (hard >= 1) ctx.fill();
  else { ctx.fillStyle = grad; ctx.fill(); }
  return c;
}

// Stamp along the segment from (x0,y0) to (x1,y1) with proper spacing.
export function stampSegment(
  target: CanvasRenderingContext2D,
  stampCanvas: HTMLCanvasElement,
  x0: number, y0: number, x1: number, y1: number,
  size: number,
) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const spacing = Math.max(1, size * 0.12);
  const steps = Math.max(1, Math.ceil(dist / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    target.drawImage(stampCanvas, x - stampCanvas.width / 2, y - stampCanvas.height / 2);
  }
}

// Clone-stamp segment: pulls pixels from `source` at a fixed offset through a
// soft round mask.
export function cloneStampSegment(
  target: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  offsetX: number, offsetY: number,
  x0: number, y0: number, x1: number, y1: number,
  size: number, hardness: number,
) {
  const maskStamp = makeBrushStamp({ size, hardness, color: '#ffffff' });
  const d = maskStamp.width;
  const piece = createCanvas(d, d);
  const pctx = ctx2d(piece);
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const spacing = Math.max(1, size * 0.25);
  const steps = Math.max(1, Math.ceil(dist / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    pctx.clearRect(0, 0, d, d);
    pctx.drawImage(maskStamp, 0, 0);
    pctx.globalCompositeOperation = 'source-in';
    pctx.drawImage(source, x + offsetX - d / 2, y + offsetY - d / 2, d, d, 0, 0, d, d);
    pctx.globalCompositeOperation = 'source-over';
    target.drawImage(piece, x - d / 2, y - d / 2);
  }
}

// --- PixelBuf bridge ---

export function getPixels(canvas: HTMLCanvasElement): PixelBuf {
  const ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

export function putPixels(canvas: HTMLCanvasElement, buf: PixelBuf) {
  const ctx = ctx2d(canvas);
  const img = new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height);
  ctx.putImageData(img, 0, 0);
}

// --- Document-wide geometry ops (applied to every layer) ---

export function rotateLayerCanvas(canvas: HTMLCanvasElement, deg: 90 | -90 | 180): HTMLCanvasElement {
  const { width: w, height: h } = canvas;
  const out = deg === 180 ? createCanvas(w, h) : createCanvas(h, w);
  const ctx = ctx2d(out);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

export function flipLayerCanvas(canvas: HTMLCanvasElement, axis: 'h' | 'v'): HTMLCanvasElement {
  const { width: w, height: h } = canvas;
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  if (axis === 'h') { ctx.translate(w, 0); ctx.scale(-1, 1); }
  else { ctx.translate(0, h); ctx.scale(1, -1); }
  ctx.drawImage(canvas, 0, 0);
  return out;
}

export function cropLayerCanvas(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const out = createCanvas(w, h);
  ctx2d(out).drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out;
}

export function resizeLayerCanvas(canvas: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = createCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return out;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load image'));
    img.src = src;
  });
}
