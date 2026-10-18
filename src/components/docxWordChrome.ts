/**
 * MS Word 크롬의 순수 데이터·계산 — 색상 팔레트(테마색 격자·표준색·형광펜),
 * 줄 간격 옵션, 페이지 설정(용지·방향·여백) 프리셋.
 * DocxEditor가 렌더와 적용을 담당하고, 여기는 Word와 같은 값 체계만 정의한다.
 */

// Office 기본 테마 색 10개 — Word 색상 팔레트의 첫 행과 동일한 순서
export const WORD_THEME_COLORS = [
  '#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4',
  '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47',
];

// Word 팔레트 하단의 표준 색 10개
export const WORD_STANDARD_COLORS = [
  '#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050',
  '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0',
];

// Word 형광펜 15색 (팔레트 순서 그대로)
export const WORD_HIGHLIGHT_COLORS = [
  '#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#0000FF',
  '#FF0000', '#000080', '#008080', '#008000', '#800080',
  '#800000', '#808000', '#808080', '#C0C0C0', '#000000',
];

export function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** 흰색 쪽으로 섞기 — Word의 "밝게 n%" */
export function tint(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(...rgb.map((n) => n + (255 - n) * factor) as [number, number, number]);
}

/** 검은색 쪽으로 섞기 — Word의 "어둡게 n%" */
export function shade(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return rgbToHex(...rgb.map((n) => n * (1 - factor)) as [number, number, number]);
}

/**
 * 테마 색 한 칸의 세로 5단 변형 — Word와 같은 규칙:
 * 흰색 열은 점점 어둡게, 검정 열은 점점 밝게, 그 외는 밝게 80/60/40% + 어둡게 25/50%.
 */
export function themeColorColumn(hex: string): string[] {
  const upper = hex.toUpperCase();
  if (upper === '#FFFFFF') return [0.05, 0.15, 0.25, 0.35, 0.5].map((f) => shade(hex, f));
  if (upper === '#000000') return [0.5, 0.35, 0.25, 0.15, 0.05].map((f) => tint(hex, f));
  return [tint(hex, 0.8), tint(hex, 0.6), tint(hex, 0.4), shade(hex, 0.25), shade(hex, 0.5)];
}

/** 테마 색 변형 격자 — rows[5][10], Word 팔레트의 본체 */
export function buildThemeColorGrid(): string[][] {
  const columns = WORD_THEME_COLORS.map(themeColorColumn);
  return Array.from({ length: 5 }, (_, row) => columns.map((column) => column[row]));
}

// Word 줄 간격 드롭다운과 동일한 옵션
export const LINE_SPACING_OPTIONS = ['1.0', '1.15', '1.5', '2.0', '2.5', '3.0'];

// ─── 페이지 설정 (96dpi px 기준) ───

export interface DocxPageSetup {
  size: keyof typeof DOCX_PAGE_SIZES;
  orientation: 'portrait' | 'landscape';
  margin: keyof typeof DOCX_PAGE_MARGINS;
}

export const DOCX_PAGE_SIZES = {
  a4: { label: 'A4', w: 794, h: 1123 },        // 210 × 297 mm
  letter: { label: 'Letter', w: 816, h: 1054 }, // 8.5 × 11 in
} as const;

export const DOCX_PAGE_MARGINS = {
  normal: { label: 'Normal', top: 96, bottom: 96, side: 96 },     // 1 in
  narrow: { label: 'Narrow', top: 48, bottom: 48, side: 48 },     // 0.5 in
  moderate: { label: 'Moderate', top: 96, bottom: 96, side: 72 }, // 1 in / 0.75 in
  wide: { label: 'Wide', top: 96, bottom: 96, side: 192 },        // 1 in / 2 in
} as const;

export const DEFAULT_PAGE_SETUP: DocxPageSetup = { size: 'a4', orientation: 'portrait', margin: 'normal' };

/** 방향을 반영한 페이지 크기 */
export function pageDimensions(setup: DocxPageSetup): { w: number; h: number } {
  const base = DOCX_PAGE_SIZES[setup.size];
  return setup.orientation === 'portrait' ? { w: base.w, h: base.h } : { w: base.h, h: base.w };
}

/** 96dpi px → twip (docx 페이지 단위, 1in = 96px = 1440twip) */
export function pxToTwip(px: number): number {
  return Math.round(px * 15);
}
