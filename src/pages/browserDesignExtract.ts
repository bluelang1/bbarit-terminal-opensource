// Design-only reverse engineering → a reusable CSS design-token "skill".
//
// browser_reverse_engineer grabs a couple of colors/fonts for a rebuild spec. This is
// dedicated to the DESIGN SYSTEM: sample computed styles across the page, rank the
// real palette (by usage), derive the typography scale, and the spacing/radius/shadow
// tokens — then emit a `:root { --color-…; --font-…; }` stylesheet the user can drop
// into any project. Collection is a thin in-page read; the ranking/normalization/CSS
// rendering is pure and tested here.
//
// D1: Rank by USAGE frequency, not first-seen. Reason: the dominant brand color is the
//     most-painted one; a stray one-off shouldn't outrank it. Near-duplicate colors are
//     merged so the palette stays small and usable.

export interface Tally { value: string; count: number }
export interface DesignSignals {
  colors?: Tally[];        // text/border colors with usage counts
  backgrounds?: Tally[];   // background colors with usage counts
  fontFamilies?: Tally[];
  fontSizes?: number[];    // px
  fontWeights?: number[];
  radii?: number[];        // px
  shadows?: string[];
  spacings?: number[];     // px (margins/paddings/gaps)
}

export interface DesignTokens {
  palette: string[];       // ranked, hex where possible
  backgrounds: string[];
  fontFamilies: string[];
  typeScale: number[];     // ascending unique px
  fontWeights: number[];
  radii: number[];
  shadows: string[];
  spacing: number[];
}

// rgb()/rgba() → #hex (drops alpha); passthrough for hex/named.
export function toHex(color: string): string {
  const raw = String(color || '').trim();
  const m = raw.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return raw.toLowerCase();
  const hex = [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

// Colors close in RGB are considered the same swatch (dedupe noise).
function colorKey(hex: string): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  // Quantize each channel to 16 levels so #fefefe ≈ #ffffff.
  const r = (n >> 20) & 0xf, g = (n >> 12) & 0xf, b = (n >> 4) & 0xf;
  return `${r}-${g}-${b}`;
}

export function rankColors(tallies: Tally[] | undefined, limit = 8): string[] {
  const byKey = new Map<string, { hex: string; count: number }>();
  for (const t of tallies || []) {
    const hex = toHex(t.value);
    // Skip transparent: the keyword, or an rgba() whose ALPHA (4th value) is 0.
    // (Must not match rgb() colors whose blue channel is 0, e.g. rgb(255,0,0).)
    const isTransparent = hex === 'transparent'
      || /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(0|0?\.0+)\s*\)/i.test(t.value);
    if (!hex || isTransparent) continue;
    const key = colorKey(hex);
    const prev = byKey.get(key);
    if (prev) prev.count += Number(t.count) || 0;
    else byKey.set(key, { hex, count: Number(t.count) || 0 });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit).map((c) => c.hex);
}

function uniqSortedNums(nums: number[] | undefined, limit = 10): number[] {
  const set = new Set<number>();
  for (const n of nums || []) { const v = Math.round(Number(n)); if (Number.isFinite(v) && v > 0) set.add(v); }
  return [...set].sort((a, b) => a - b).slice(0, limit);
}

export function buildDesignTokens(signals: DesignSignals): DesignTokens {
  const s = signals || {};
  return {
    palette: rankColors(s.colors, 8),
    backgrounds: rankColors(s.backgrounds, 6),
    fontFamilies: dedupeStrings(s.fontFamilies?.map((t) => t.value), 4),
    typeScale: uniqSortedNums(s.fontSizes, 10),
    fontWeights: uniqSortedNums(s.fontWeights, 6),
    radii: uniqSortedNums(s.radii, 6),
    shadows: dedupeStrings(s.shadows, 4).filter((x) => x && x !== 'none'),
    spacing: uniqSortedNums(s.spacings, 10),
  };
}

function dedupeStrings(arr: (string | undefined)[] | undefined, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of arr || []) {
    const v = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

// Render the design tokens as a drop-in CSS custom-property stylesheet.
export function renderDesignCss(tokens: DesignTokens, opts: { name?: string } = {}): string {
  const t = tokens;
  const lines = [`/* Design tokens${opts.name ? ` — ${opts.name}` : ''} (reverse-engineered by BBARIT Browser) */`, ':root {'];
  t.palette.forEach((c, i) => lines.push(`  --color-${i + 1}: ${c};`));
  t.backgrounds.forEach((c, i) => lines.push(`  --bg-${i + 1}: ${c};`));
  t.fontFamilies.forEach((f, i) => lines.push(`  --font-${i === 0 ? 'body' : i}: ${f};`));
  t.typeScale.forEach((px, i) => lines.push(`  --text-${i + 1}: ${px}px;`));
  t.fontWeights.forEach((w) => lines.push(`  --weight-${w}: ${w};`));
  t.radii.forEach((px, i) => lines.push(`  --radius-${i + 1}: ${px}px;`));
  t.spacing.forEach((px, i) => lines.push(`  --space-${i + 1}: ${px}px;`));
  t.shadows.forEach((sh, i) => lines.push(`  --shadow-${i + 1}: ${sh};`));
  lines.push('}');
  return lines.join('\n');
}

export function formatDesignSummary(tokens: DesignTokens): string {
  const t = tokens;
  return [
    `Palette (${t.palette.length}): ${t.palette.join(', ') || '—'}`,
    `Backgrounds (${t.backgrounds.length}): ${t.backgrounds.join(', ') || '—'}`,
    `Fonts: ${t.fontFamilies.join(' | ') || '—'}`,
    `Type scale: ${t.typeScale.map((n) => n + 'px').join(', ') || '—'}`,
    `Radii: ${t.radii.map((n) => n + 'px').join(', ') || '—'}`,
    `Shadows: ${t.shadows.length}`,
  ].join('\n');
}
