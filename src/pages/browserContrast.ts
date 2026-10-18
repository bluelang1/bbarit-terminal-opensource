// WCAG color-contrast checking (accessibility). Extends the a11y audit, which covered
// alts/labels/headings but not CONTRAST — the most common real-world WCAG failure.
//
// Computes the WCAG 2.x contrast ratio between a foreground and background color and
// reports AA/AAA pass for normal vs large text. Pure math, fully tested; the in-page
// collector just samples text/background color pairs.
//
// D1: Follow the WCAG relative-luminance formula exactly (sRGB linearization + 0.2126/
//     0.7152/0.0722 weights, ratio = (L1+0.05)/(L2+0.05)). "Large text" = >=18pt (24px)
//     or >=14pt (18.66px) bold, per WCAG. Thresholds: AA 4.5 / 3 (large), AAA 7 / 4.5.

export interface Rgb { r: number; g: number; b: number }

// Parse #rgb, #rrggbb, rgb()/rgba() → RGB. Returns null for unparseable.
export function parseColor(input: string): Rgb | null {
  const s = String(input || '').trim().toLowerCase();
  const rgbm = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbm) return clampRgb(Number(rgbm[1]), Number(rgbm[2]), Number(rgbm[3]));
  const hex6 = s.match(/^#([0-9a-f]{6})$/);
  if (hex6) { const n = parseInt(hex6[1], 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  const hex3 = s.match(/^#([0-9a-f]{3})$/);
  if (hex3) { const [a, b, c] = hex3[1].split(''); return clampRgb(parseInt(a + a, 16), parseInt(b + b, 16), parseInt(c + c, 16)); }
  const named: Record<string, string> = { black: '#000000', white: '#ffffff' };
  if (named[s]) return parseColor(named[s]);
  return null;
}

function clampRgb(r: number, g: number, b: number): Rgb {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return { r: c(r), g: c(g), b: c(b) };
}

export function relativeLuminance(rgb: Rgb): number {
  const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

// Contrast ratio 1..21, rounded to 2 decimals.
export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const l1 = relativeLuminance(f);
  const l2 = relativeLuminance(b);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return Math.round(ratio * 100) / 100;
}

export function isLargeText(fontSizePx: number, bold: boolean): boolean {
  const px = Number(fontSizePx) || 0;
  return px >= 24 || (bold && px >= 18.66);
}

export interface ContrastVerdict {
  ratio: number | null;
  large: boolean;
  passAA: boolean;
  passAAA: boolean;
  level: 'pass-aaa' | 'pass-aa' | 'fail';
  required: number;   // AA threshold for this text size
}

export function checkContrast(fg: string, bg: string, fontSizePx = 16, bold = false): ContrastVerdict {
  const ratio = contrastRatio(fg, bg);
  const large = isLargeText(fontSizePx, bold);
  const aa = large ? 3 : 4.5;
  const aaa = large ? 4.5 : 7;
  if (ratio === null) return { ratio: null, large, passAA: false, passAAA: false, level: 'fail', required: aa };
  const passAA = ratio >= aa;
  const passAAA = ratio >= aaa;
  return { ratio, large, passAA, passAAA, level: passAAA ? 'pass-aaa' : passAA ? 'pass-aa' : 'fail', required: aa };
}

export interface ContrastSample { fg: string; bg: string; fontSize?: number; bold?: boolean; text?: string }
export interface ContrastReport { checked: number; failures: Array<{ ratio: number | null; required: number; text: string; fg: string; bg: string }>; worstRatio: number | null }

// Audit a set of sampled text/background pairs; return the AA failures (worst first).
export function auditContrast(samples: ContrastSample[]): ContrastReport {
  const failures: ContrastReport['failures'] = [];
  let checked = 0;
  let worst: number | null = null;
  for (const s of samples || []) {
    const v = checkContrast(s.fg, s.bg, s.fontSize ?? 16, !!s.bold);
    if (v.ratio === null) continue;   // unparseable pair — skip, don't false-alarm
    checked++;
    if (worst === null || v.ratio < worst) worst = v.ratio;
    if (!v.passAA) failures.push({ ratio: v.ratio, required: v.required, text: String(s.text || '').slice(0, 60), fg: s.fg, bg: s.bg });
  }
  failures.sort((a, b) => (a.ratio ?? 99) - (b.ratio ?? 99));
  return { checked, failures: failures.slice(0, 20), worstRatio: worst };
}
