// Pure pixel operations for the photo editor. Everything here works on a plain
// PixelBuf (no DOM canvas) so it stays unit-testable under node/jsdom.

export interface PixelBuf {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function clonePixels(src: PixelBuf): PixelBuf {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// --- Color space helpers ---

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// --- Adjustments (each returns a new PixelBuf) ---

export function adjustBrightnessContrast(src: PixelBuf, brightness: number, contrast: number): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const b = (brightness / 100) * 128;
  const c = contrast / 100;
  const factor = c >= 0 ? 1 + c * 3 : 1 + c;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255((d[i] - 128) * factor + 128 + b);
    d[i + 1] = clamp255((d[i + 1] - 128) * factor + 128 + b);
    d[i + 2] = clamp255((d[i + 2] - 128) * factor + 128 + b);
  }
  return out;
}

export function adjustHsl(src: PixelBuf, hueDeg: number, saturation: number, lightness: number): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const dh = hueDeg / 360;
  const ds = saturation / 100;
  const dl = lightness / 100;
  for (let i = 0; i < d.length; i += 4) {
    let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    h += dh;
    s = Math.min(1, Math.max(0, s * (1 + ds)));
    l = dl >= 0 ? l + (1 - l) * dl : l + l * dl;
    const [r, g, b] = hslToRgb(h, s, l);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  return out;
}

export function adjustLevels(src: PixelBuf, black: number, white: number, gamma: number): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const range = Math.max(1, white - black);
  const invGamma = 1 / Math.max(0.01, gamma);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const norm = Math.min(1, Math.max(0, (v - black) / range));
    lut[v] = Math.round(Math.pow(norm, invGamma) * 255);
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return out;
}

export function adjustColorBalance(src: PixelBuf, r: number, g: number, b: number): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const dr = (r / 100) * 128;
  const dg = (g / 100) * 128;
  const db = (b / 100) * 128;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(d[i] + dr);
    d[i + 1] = clamp255(d[i + 1] + dg);
    d[i + 2] = clamp255(d[i + 2] + db);
  }
  return out;
}

export function invertPixels(src: PixelBuf): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
  return out;
}

export function grayscalePixels(src: PixelBuf): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = y; d[i + 1] = y; d[i + 2] = y;
  }
  return out;
}

export function sepiaPixels(src: PixelBuf): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = clamp255(0.393 * r + 0.769 * g + 0.189 * b);
    d[i + 1] = clamp255(0.349 * r + 0.686 * g + 0.168 * b);
    d[i + 2] = clamp255(0.272 * r + 0.534 * g + 0.131 * b);
  }
  return out;
}

// Separable box blur run 3 times ~ gaussian. Premultiplies alpha so transparent
// edges don't bleed dark fringes.
export function blurPixels(src: PixelBuf, radius: number): PixelBuf {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return clonePixels(src);
  const { width: w, height: h } = src;
  const pre = new Float32Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = src.data[i * 4 + 3] / 255;
    pre[i * 4] = src.data[i * 4] * a;
    pre[i * 4 + 1] = src.data[i * 4 + 1] * a;
    pre[i * 4 + 2] = src.data[i * 4 + 2] * a;
    pre[i * 4 + 3] = src.data[i * 4 + 3];
  }
  let buf = pre;
  let tmp = new Float32Array(w * h * 4);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurAxis(buf, tmp, w, h, r, true);
    boxBlurAxis(tmp, buf, w, h, r, false);
  }
  const out = clonePixels(src);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = buf[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    out.data[i * 4] = clamp255(buf[i * 4] * inv);
    out.data[i * 4 + 1] = clamp255(buf[i * 4 + 1] * inv);
    out.data[i * 4 + 2] = clamp255(buf[i * 4 + 2] * inv);
    out.data[i * 4 + 3] = clamp255(a);
  }
  return out;
}

function boxBlurAxis(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const lineCount = horizontal ? h : w;
  const lineLen = horizontal ? w : h;
  const stridePx = horizontal ? 1 : w;
  const norm = 1 / (r * 2 + 1);
  for (let line = 0; line < lineCount; line++) {
    const base = horizontal ? line * w : line;
    let sr = 0, sg = 0, sb = 0, sa = 0;
    for (let k = -r; k <= r; k++) {
      const idx = (base + Math.min(lineLen - 1, Math.max(0, k)) * stridePx) * 4;
      sr += src[idx]; sg += src[idx + 1]; sb += src[idx + 2]; sa += src[idx + 3];
    }
    for (let i = 0; i < lineLen; i++) {
      const di = (base + i * stridePx) * 4;
      dst[di] = sr * norm; dst[di + 1] = sg * norm; dst[di + 2] = sb * norm; dst[di + 3] = sa * norm;
      const addI = (base + Math.min(lineLen - 1, i + r + 1) * stridePx) * 4;
      const subI = (base + Math.max(0, i - r) * stridePx) * 4;
      sr += src[addI] - src[subI];
      sg += src[addI + 1] - src[subI + 1];
      sb += src[addI + 2] - src[subI + 2];
      sa += src[addI + 3] - src[subI + 3];
    }
  }
}

// Unsharp mask: out = src + amount * (src - blurred)
export function sharpenPixels(src: PixelBuf, amount: number): PixelBuf {
  const blurred = blurPixels(src, 1);
  const out = clonePixels(src);
  const d = out.data;
  const k = amount / 100;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp255(src.data[i] + k * (src.data[i] - blurred.data[i]));
    d[i + 1] = clamp255(src.data[i + 1] + k * (src.data[i + 1] - blurred.data[i + 1]));
    d[i + 2] = clamp255(src.data[i + 2] + k * (src.data[i + 2] - blurred.data[i + 2]));
  }
  return out;
}

export function pixelatePixels(src: PixelBuf, blockSize: number): PixelBuf {
  const size = Math.max(1, Math.round(blockSize));
  if (size === 1) return clonePixels(src);
  const { width: w, height: h } = src;
  const out = clonePixels(src);
  for (let by = 0; by < h; by += size) {
    for (let bx = 0; bx < w; bx += size) {
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      const yMax = Math.min(h, by + size);
      const xMax = Math.min(w, bx + size);
      for (let y = by; y < yMax; y++) {
        for (let x = bx; x < xMax; x++) {
          const i = (y * w + x) * 4;
          sr += src.data[i]; sg += src.data[i + 1]; sb += src.data[i + 2]; sa += src.data[i + 3];
          n++;
        }
      }
      const r = Math.round(sr / n), g = Math.round(sg / n), b = Math.round(sb / n), a = Math.round(sa / n);
      for (let y = by; y < yMax; y++) {
        for (let x = bx; x < xMax; x++) {
          const i = (y * w + x) * 4;
          out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = a;
        }
      }
    }
  }
  return out;
}

export function noisePixels(src: PixelBuf, amount: number, rand: () => number = Math.random): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const k = (amount / 100) * 128;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() * 2 - 1) * k;
    d[i] = clamp255(d[i] + n);
    d[i + 1] = clamp255(d[i + 1] + n);
    d[i + 2] = clamp255(d[i + 2] + n);
  }
  return out;
}

export function vignettePixels(src: PixelBuf, amount: number): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  const { width: w, height: h } = src;
  const cx = w / 2, cy = h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const k = amount / 100;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist;
      const factor = 1 - k * dist * dist;
      const i = (y * w + x) * 4;
      d[i] = clamp255(d[i] * factor);
      d[i + 1] = clamp255(d[i + 1] * factor);
      d[i + 2] = clamp255(d[i + 2] * factor);
    }
  }
  return out;
}

// --- Selection masks (0 = unselected, 255 = selected) ---

// Flood-fill based mask for the magic wand. Compares against the clicked pixel
// with a per-channel tolerance; 4-connected.
export function floodFillMask(src: PixelBuf, startX: number, startY: number, tolerance: number): Uint8Array {
  const { width: w, height: h } = src;
  const mask = new Uint8Array(w * h);
  const sx = Math.round(startX), sy = Math.round(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const si = (sy * w + sx) * 4;
  const tr = src.data[si], tg = src.data[si + 1], tb = src.data[si + 2], ta = src.data[si + 3];
  const tol = Math.max(0, tolerance);
  const matches = (i: number) =>
    Math.abs(src.data[i] - tr) <= tol &&
    Math.abs(src.data[i + 1] - tg) <= tol &&
    Math.abs(src.data[i + 2] - tb) <= tol &&
    Math.abs(src.data[i + 3] - ta) <= tol;
  const stack: number[] = [sy * w + sx];
  mask[sy * w + sx] = 255;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p / w) | 0;
    if (x > 0 && !mask[p - 1] && matches((p - 1) * 4)) { mask[p - 1] = 255; stack.push(p - 1); }
    if (x < w - 1 && !mask[p + 1] && matches((p + 1) * 4)) { mask[p + 1] = 255; stack.push(p + 1); }
    if (y > 0 && !mask[p - w] && matches((p - w) * 4)) { mask[p - w] = 255; stack.push(p - w); }
    if (y < h - 1 && !mask[p + w] && matches((p + w) * 4)) { mask[p + w] = 255; stack.push(p + w); }
  }
  return mask;
}

// Scanline polygon fill for lasso selections.
export function polygonMask(points: Array<{ x: number; y: number }>, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (points.length < 3) return mask;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y <= yc && b.y > yc) || (b.y <= yc && a.y > yc)) {
        xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * w + x] = 255;
    }
  }
  return mask;
}

export function rectMask(x: number, y: number, rw: number, rh: number, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.round(Math.min(x, x + rw)));
  const y0 = Math.max(0, Math.round(Math.min(y, y + rh)));
  const x1 = Math.min(w, Math.round(Math.max(x, x + rw)));
  const y1 = Math.min(h, Math.round(Math.max(y, y + rh)));
  for (let yy = y0; yy < y1; yy++) {
    mask.fill(255, yy * w + x0, yy * w + x1);
  }
  return mask;
}

export function ellipseMask(cx: number, cy: number, rx: number, ry: number, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (rx <= 0 || ry <= 0) return mask;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    const span = 1 - dy * dy;
    if (span <= 0) continue;
    const dx = Math.sqrt(span) * rx;
    const x0 = Math.max(0, Math.round(cx - dx));
    const x1 = Math.min(w, Math.round(cx + dx));
    if (x1 > x0) mask.fill(255, y * w + x0, y * w + x1);
  }
  return mask;
}

export function unionMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(a[i], b[i]);
  return out;
}

export function subtractMask(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = b[i] ? 0 : a[i];
  return out;
}

export function invertMask(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
  return out;
}

export function maskIsEmpty(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i]) return false;
  return true;
}

// Blends `filtered` over `orig` where mask is set (used to apply adjustments
// only inside the current selection).
export function blendByMask(orig: PixelBuf, filtered: PixelBuf, mask: Uint8Array | null): PixelBuf {
  if (!mask) return filtered;
  const out = clonePixels(orig);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const t = mask[p] / 255;
    const i = p * 4;
    out.data[i] = orig.data[i] + (filtered.data[i] - orig.data[i]) * t;
    out.data[i + 1] = orig.data[i + 1] + (filtered.data[i + 1] - orig.data[i + 1]) * t;
    out.data[i + 2] = orig.data[i + 2] + (filtered.data[i + 2] - orig.data[i + 2]) * t;
    out.data[i + 3] = orig.data[i + 3] + (filtered.data[i + 3] - orig.data[i + 3]) * t;
  }
  return out;
}

// --- Curves ---

export interface CurvePoint { x: number; y: number }

// Builds a 256-entry LUT from curve control points using Catmull-Rom
// interpolation (clamped, Photoshop-style flat extension past the end points).
export function curveLut(points: CurvePoint[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const pts = [...points]
    .map((p) => ({ x: Math.min(255, Math.max(0, p.x)), y: Math.min(255, Math.max(0, p.y)) }))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  if (pts.length === 1) {
    lut.fill(Math.round(pts[0].y));
    return lut;
  }
  const at = (i: number) => pts[Math.min(pts.length - 1, Math.max(0, i))];
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0].x) { lut[x] = Math.round(pts[0].y); continue; }
    if (x >= pts[pts.length - 1].x) { lut[x] = Math.round(pts[pts.length - 1].y); continue; }
    let seg = 0;
    while (seg < pts.length - 2 && x > pts[seg + 1].x) seg++;
    const p0 = at(seg - 1), p1 = at(seg), p2 = at(seg + 1), p3 = at(seg + 2);
    const t = (x - p1.x) / Math.max(1e-6, p2.x - p1.x);
    const t2 = t * t, t3 = t2 * t;
    const y = 0.5 * (
      2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
    );
    lut[x] = Math.round(Math.min(255, Math.max(0, y)));
  }
  return lut;
}

export function applyLut(src: PixelBuf, lut: Uint8ClampedArray): PixelBuf {
  const out = clonePixels(src);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  return out;
}

// Luminance histogram (256 bins), for the Curves dialog backdrop.
export function lumaHistogram(src: PixelBuf): Uint32Array {
  const bins = new Uint32Array(256);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    bins[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  }
  return bins;
}

// Flood fill paint (bucket tool): fills the region matched from (x, y) with the
// given color, optionally limited by a selection mask.
export function bucketFill(
  src: PixelBuf,
  x: number,
  y: number,
  color: [number, number, number],
  tolerance: number,
  selection: Uint8Array | null,
): PixelBuf {
  const region = floodFillMask(src, x, y, tolerance);
  const out = clonePixels(src);
  for (let p = 0; p < region.length; p++) {
    if (!region[p]) continue;
    if (selection && !selection[p]) continue;
    const i = p * 4;
    out.data[i] = color[0];
    out.data[i + 1] = color[1];
    out.data[i + 2] = color[2];
    out.data[i + 3] = 255;
  }
  return out;
}
