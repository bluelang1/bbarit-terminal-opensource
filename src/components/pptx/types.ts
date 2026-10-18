/**
 * types.ts — PptxEditor shared types, interfaces, constants, and utilities
 */

// ─── Props ────────────────────────────────────────────────────

export interface PptxEditorProps {
  filePath: string;
  pptxData: string; // base64 data URL
  style: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onModifiedChange?: (modified: boolean) => void;
}

// ─── Element Types ────────────────────────────────────────────

export type SlideElementType =
  | 'text' | 'rect' | 'circle' | 'image'
  | 'triangle' | 'star' | 'arrow' | 'line' | 'table';

/** Per-cell merge + fill metadata, parallel to TableData.cells. */
export interface TableCell {
  colSpan?: number;   // horizontal span (gridSpan), default 1
  rowSpan?: number;   // vertical span, default 1
  hMerge?: boolean;   // absorbed by a horizontal-merge origin to its left
  vMerge?: boolean;   // absorbed by a vertical-merge origin above
  fillColor?: string; // cell background (a:tcPr solidFill)
  color?: string;     // cell text color
  align?: 'left' | 'center' | 'right';
}

export interface TableData {
  rows: number;
  cols: number;
  cells: string[][];       // [row][col] text
  cellData?: TableCell[][]; // [row][col] merge + fill metadata, parallel to cells
  colWidths?: number[];    // per-column width ratios (sum ≈ 1)
  headerRow?: boolean;     // treat first row as a styled header
  headerFill?: string;
  headerColor?: string;
  bodyFill?: string;
  bodyColor?: string;
  borderColor?: string;
}

export type ElementAnimationEffect = 'fade' | 'rise' | 'zoom' | 'slide-left' | 'slide-right' | 'wipe';

/** Entrance animation played per click-step in presentation mode. */
export interface ElementAnimation {
  effect: ElementAnimationEffect;
  /** Click step (1-based). Elements sharing a step animate together. */
  order: number;
  durationMs?: number;
}

export interface SlideElement {
  id: string;
  type: SlideElementType;
  x: number;       // percentage 0-100
  y: number;
  w: number;
  h: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** bodyPr text insets in points (PowerPoint defaults: 7.2 l/r, 3.6 t/b) */
  insetPt?: { l: number; t: number; r: number; b: number };
  fontFamily?: string;
  fillColor?: string;
  borderColor?: string;
  borderWidth?: number;
  imageSrc?: string; // data URL for images
  rotation?: number; // 0-360
  opacity?: number;  // 0-1
  shadow?: boolean;
  table?: TableData; // for type === 'table'
  /** Bullet/numbered list rendering for multi-line text elements. */
  listStyle?: 'none' | 'bullet' | 'number';
  animation?: ElementAnimation;
  /** Elements sharing a groupId select and move as one (⌘G / ⌘⇧G). */
  groupId?: string;
}

// Build a default table element model (used by the insert-table button).
export function createTableData(rows = 3, cols = 3): TableData {
  const cells: string[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(r === 0 ? `Header ${c + 1}` : '');
    }
    cells.push(row);
  }
  return {
    rows,
    cols,
    cells,
    colWidths: Array.from({ length: cols }, () => 1 / cols),
    headerRow: true,
    headerFill: '#2563eb',
    headerColor: '#ffffff',
    bodyFill: '#ffffff',
    bodyColor: '#111827',
    borderColor: '#cbd5e1',
  };
}

/** One relationship the preserved graphicFrame depends on (slide → chart/diagram). */
export interface PreservedRel {
  id: string;     // original r:id used inside graphicFrameXml
  target: string; // resolved zip path of the referenced part (e.g. ppt/charts/chart1.xml)
  type: string;   // relationship Type URI
}

/** One OOXML part captured verbatim so it can be written back into the export zip. */
export interface PreservedFile {
  path: string;         // original zip path (kept identical on round-trip)
  base64: string;       // raw part bytes, base64-encoded
  contentType?: string; // from the original [Content_Types].xml, if known
}

/**
 * A non-table graphicFrame (chart / SmartArt-diagram / embedded object) the
 * editor can't natively render. Its original XML and every referenced part are
 * kept opaque so export can re-inject them without data loss.
 */
export interface PreservedPart {
  kind: 'chart' | 'graphicFrame' | 'diagram';
  graphicFrameXml: string;   // verbatim <p:graphicFrame>…</p:graphicFrame>
  parts: PreservedFile[];    // chart xml, its _rels, embeddings, colors/style, …
  rels: PreservedRel[];      // slide-level relationships the frame references
  x: number;                 // percentage position, mirrors SlideElement units
  y: number;
  w: number;
  h: number;
}

export interface Slide {
  id: string;
  title?: string;
  bgColor: string;
  bgImage?: string; // data URL for background image
  notes?: string;
  hidden?: boolean;
  transition?: SlideTransition;
  elements: SlideElement[];
  /** Opaque graphicFrames (charts/diagrams) round-tripped verbatim, not rendered natively. */
  preserved?: PreservedPart[];
}

export interface SlideTransition {
  type: 'none' | 'fade' | 'push' | 'wipe' | 'zoom';
  durationMs?: number;
  advanceAfterSec?: number;
}

export interface SlideSize {
  widthEmu: number;
  heightEmu: number;
  widthInch: number;
  heightInch: number;
  aspectRatio: number;
}

export interface ParsedPptx {
  slides: Slide[];
  slideSize: SlideSize;
  /** Set when parsing threw and the returned deck is an empty fallback (blocks in-place overwrite). */
  parseError?: boolean;
  /** Set when the original held content the editor can't round-trip (charts/SmartArt, transitions, timing). */
  hasUnsupportedContent?: boolean;
}

// ─── Constants ────────────────────────────────────────────────

export const CANVAS_MAX_W = 720;
export const MAX_HISTORY = 50;
export const SNAP_PCT = 1; // snap grid size in %
export const DEFAULT_SLIDE_SIZE: SlideSize = {
  widthEmu: 12192000, // 13.33 inches (widescreen)
  heightEmu: 6858000, // 7.5 inches
  widthInch: 13.33,
  heightInch: 7.5,
  aspectRatio: 16 / 9,
};

export const FONT_FAMILIES = [
  'Sans-serif',
  'Serif',
  'Monospace',
  'Nanum Gothic',
  'Nanum Myeongjo',
  'system-ui',
];

export const SHAPE_CLIPS: Record<string, string> = {
  triangle: 'polygon(50% 0%, 0% 100%, 100% 100%)',
  star: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
  arrow: 'polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)',
};

export interface SlidePreset {
  label: string;
  category?: string;
  description?: string;
  build: () => SlideElement[];
}

export function getSlidePresets(t: (key: any) => string): SlidePreset[] {
  const text = (
    x: number,
    y: number,
    w: number,
    h: number,
    value: string,
    fontSize = 18,
    extra: Partial<SlideElement> = {},
  ): SlideElement => ({
    id: uid(),
    type: 'text',
    x,
    y,
    w,
    h,
    text: value,
    fontSize,
    fontColor: '#000000',
    ...extra,
  });

  const rect = (x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement => ({
    id: uid(),
    type: 'rect',
    x,
    y,
    w,
    h,
    fillColor,
    ...extra,
  });

  const circle = (x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement => ({
    id: uid(),
    type: 'circle',
    x,
    y,
    w,
    h,
    fillColor,
    ...extra,
  });

  const line = (x: number, y: number, w: number, borderColor: string, borderWidth = 2): SlideElement => ({
    id: uid(),
    type: 'line',
    x,
    y,
    w,
    h: 1,
    borderColor,
    borderWidth,
  });

  const imageBox = (x: number, y: number, w: number, h: number, fillColor = '#e0e0e0'): SlideElement => ({
    id: uid(),
    type: 'rect',
    x,
    y,
    w,
    h,
    fillColor,
  });

  return [
    { label: 'Blank slide', build: () => [] },
    {
      label: 'Title',
      build: () => [text(10, 35, 80, 20, 'Enter title', 36, { bold: true, textAlign: 'center' })],
    },
    {
      label: 'Title + Body',
      build: () => [
        text(8, 8, 84, 15, 'Title', 32, { bold: true }),
        text(8, 28, 84, 60, 'Enter body text', 18, { fontColor: '#333333' }),
      ],
    },
    {
      label: 'Two columns',
      build: () => [
        text(8, 5, 84, 12, 'Title', 28, { bold: true, textAlign: 'center' }),
        rect(4, 20, 44, 72, '#e8f0fe'),
        rect(52, 20, 44, 72, '#fce8e8'),
      ],
    },
    {
      label: 'Image + Text',
      build: () => [
        imageBox(4, 4, 44, 92),
        text(52, 8, 44, 15, 'Title', 28, { bold: true }),
        text(52, 28, 44, 60, 'Enter description', 16, { fontColor: '#444444' }),
      ],
    },
    {
      label: 'Section Header',
      build: () => [
        rect(0, 0, 100, 28, '#17324d'),
        text(8, 8, 84, 12, 'Title', 30, { bold: true, fontColor: '#ffffff' }),
        text(8, 38, 84, 14, 'Enter description', 18, { fontColor: '#17324d' }),
      ],
    },
    {
      label: 'Hero Cover',
      build: () => [
        rect(0, 0, 100, 100, '#1f2937'),
        rect(6, 10, 40, 80, '#374151'),
        text(52, 18, 38, 18, 'Title', 30, { bold: true, fontColor: '#ffffff' }),
        text(52, 40, 36, 26, 'Enter description', 16, { fontColor: '#d1d5db' }),
      ],
    },
    {
      label: 'Big Number',
      build: () => [
        text(8, 8, 84, 12, 'Title', 24, { bold: true }),
        text(8, 24, 28, 42, '01', 72, { bold: true, fontColor: '#2563eb' }),
        text(34, 36, 56, 20, 'Enter description', 22, { bold: true }),
        text(34, 58, 54, 20, 'Enter body text', 15, { fontColor: '#4b5563' }),
      ],
    },
    {
      label: 'Three Columns',
      build: () => [
        text(8, 6, 84, 10, 'Title', 26, { bold: true, textAlign: 'center' }),
        rect(4, 22, 28, 66, '#e0f2fe'),
        rect(36, 22, 28, 66, '#dcfce7'),
        rect(68, 22, 28, 66, '#fee2e2'),
      ],
    },
    {
      label: 'Four Cards',
      build: () => [
        text(8, 6, 84, 10, 'Title', 24, { bold: true }),
        rect(6, 22, 40, 28, '#eff6ff'),
        rect(54, 22, 40, 28, '#f5f3ff'),
        rect(6, 56, 40, 28, '#ecfccb'),
        rect(54, 56, 40, 28, '#fef3c7'),
      ],
    },
    {
      label: 'Quote',
      build: () => [
        text(10, 18, 80, 34, '"Add your key quote here"', 28, { italic: true, textAlign: 'center', fontColor: '#111827' }),
        line(22, 60, 56, '#d1d5db', 2),
        text(28, 66, 44, 8, 'Speaker name', 16, { textAlign: 'center', fontColor: '#6b7280' }),
      ],
    },
    {
      label: 'Timeline 3 Step',
      build: () => [
        text(8, 6, 84, 10, 'Title', 24, { bold: true, textAlign: 'center' }),
        line(16, 52, 68, '#60a5fa', 3),
        circle(16, 44, 8, 8, '#2563eb'),
        circle(46, 44, 8, 8, '#2563eb'),
        circle(76, 44, 8, 8, '#2563eb'),
        text(8, 58, 20, 10, 'Step 1', 16, { bold: true, textAlign: 'center' }),
        text(38, 58, 20, 10, 'Step 2', 16, { bold: true, textAlign: 'center' }),
        text(68, 58, 20, 10, 'Step 3', 16, { bold: true, textAlign: 'center' }),
      ],
    },
    {
      label: 'Timeline 5 Step',
      build: () => [
        text(8, 6, 84, 10, 'Title', 22, { bold: true, textAlign: 'center' }),
        line(12, 50, 76, '#94a3b8', 2),
        circle(12, 44, 8, 8, '#0ea5e9'),
        circle(31, 44, 8, 8, '#0ea5e9'),
        circle(50, 44, 8, 8, '#0ea5e9'),
        circle(69, 44, 8, 8, '#0ea5e9'),
        circle(88, 44, 8, 8, '#0ea5e9'),
      ],
    },
    {
      label: 'Comparison',
      build: () => [
        text(8, 6, 84, 10, 'Title', 24, { bold: true, textAlign: 'center' }),
        rect(8, 20, 38, 66, '#eef2ff'),
        rect(54, 20, 38, 66, '#fef2f2'),
        text(14, 24, 26, 8, 'Option A', 20, { bold: true, textAlign: 'center' }),
        text(60, 24, 26, 8, 'Option B', 20, { bold: true, textAlign: 'center' }),
      ],
    },
    {
      label: 'SWOT',
      build: () => [
        rect(6, 18, 42, 32, '#dcfce7'),
        rect(52, 18, 42, 32, '#dbeafe'),
        rect(6, 54, 42, 32, '#fef3c7'),
        rect(52, 54, 42, 32, '#fee2e2'),
        text(18, 30, 18, 8, 'Strength', 18, { bold: true, textAlign: 'center' }),
        text(64, 30, 18, 8, 'Weakness', 18, { bold: true, textAlign: 'center' }),
        text(18, 66, 18, 8, 'Opportunity', 17, { bold: true, textAlign: 'center' }),
        text(64, 66, 18, 8, 'Threat', 18, { bold: true, textAlign: 'center' }),
      ],
    },
    {
      label: 'Agenda',
      build: () => [
        text(8, 8, 84, 10, 'Agenda', 28, { bold: true }),
        text(14, 26, 8, 8, '1', 20, { bold: true, fontColor: '#2563eb', textAlign: 'center' }),
        text(24, 26, 56, 8, 'Opening and context', 20, { bold: true }),
        text(14, 42, 8, 8, '2', 20, { bold: true, fontColor: '#2563eb', textAlign: 'center' }),
        text(24, 42, 56, 8, 'Core discussion points', 20, { bold: true }),
        text(14, 58, 8, 8, '3', 20, { bold: true, fontColor: '#2563eb', textAlign: 'center' }),
        text(24, 58, 56, 8, 'Action items and close', 20, { bold: true }),
      ],
    },
    {
      label: 'Title with Metrics',
      build: () => [
        text(8, 8, 84, 10, 'Title', 28, { bold: true }),
        rect(8, 30, 26, 24, '#dbeafe'),
        rect(37, 30, 26, 24, '#dcfce7'),
        rect(66, 30, 26, 24, '#fef3c7'),
        text(11, 36, 20, 8, '120%', 22, { bold: true, textAlign: 'center' }),
        text(40, 36, 20, 8, '32K', 22, { bold: true, textAlign: 'center' }),
        text(69, 36, 20, 8, '4.8', 22, { bold: true, textAlign: 'center' }),
      ],
    },
    {
      label: 'Image Left Quote',
      build: () => [
        imageBox(6, 10, 34, 80, '#d1d5db'),
        text(46, 22, 44, 30, '"Add supporting quote or statement"', 24, { italic: true, fontColor: '#111827' }),
        text(46, 60, 30, 8, 'Name / title', 16, { fontColor: '#6b7280' }),
      ],
    },
    {
      label: 'Image Right Quote',
      build: () => [
        text(10, 22, 40, 30, '"Add supporting quote or statement"', 24, { italic: true, fontColor: '#111827' }),
        text(10, 60, 30, 8, 'Name / title', 16, { fontColor: '#6b7280' }),
        imageBox(56, 10, 34, 80, '#d1d5db'),
      ],
    },
    {
      label: 'Process Flow',
      build: () => [
        text(8, 6, 84, 10, 'Process Flow', 24, { bold: true, textAlign: 'center' }),
        rect(8, 38, 18, 14, '#dbeafe'),
        rect(32, 38, 18, 14, '#dcfce7'),
        rect(56, 38, 18, 14, '#fef3c7'),
        rect(80, 38, 12, 14, '#fee2e2'),
      ],
    },
    {
      label: 'Roadmap',
      build: () => [
        text(8, 6, 84, 10, 'Roadmap', 24, { bold: true }),
        line(10, 44, 80, '#cbd5e1', 4),
        circle(14, 38, 8, 8, '#2563eb'),
        circle(38, 38, 8, 8, '#2563eb'),
        circle(62, 38, 8, 8, '#2563eb'),
        circle(86, 38, 8, 8, '#2563eb'),
      ],
    },
    {
      label: 'Milestones',
      build: () => [
        text(8, 8, 84, 10, 'Milestones', 24, { bold: true }),
        rect(8, 26, 84, 12, '#eff6ff'),
        rect(8, 44, 84, 12, '#f0fdf4'),
        rect(8, 62, 84, 12, '#fff7ed'),
      ],
    },
    {
      label: 'Checklist',
      build: () => [
        text(8, 8, 84, 10, 'Checklist', 26, { bold: true }),
        rect(10, 28, 4, 4, '#22c55e'),
        rect(10, 42, 4, 4, '#22c55e'),
        rect(10, 56, 4, 4, '#22c55e'),
        rect(10, 70, 4, 4, '#22c55e'),
        text(18, 25, 60, 8, 'Checklist item one', 18),
        text(18, 39, 60, 8, 'Checklist item two', 18),
        text(18, 53, 60, 8, 'Checklist item three', 18),
        text(18, 67, 60, 8, 'Checklist item four', 18),
      ],
    },
    {
      label: 'KPI Dashboard',
      build: () => [
        text(8, 6, 84, 10, 'KPI Dashboard', 24, { bold: true }),
        rect(6, 22, 28, 24, '#dbeafe'),
        rect(36, 22, 28, 24, '#dcfce7'),
        rect(66, 22, 28, 24, '#fef3c7'),
        rect(6, 52, 88, 32, '#f8fafc'),
      ],
    },
    {
      label: 'Gallery 2x2',
      build: () => [
        imageBox(6, 14, 40, 34),
        imageBox(54, 14, 40, 34),
        imageBox(6, 54, 40, 34),
        imageBox(54, 54, 40, 34),
      ],
    },
    {
      label: 'Gallery 3 Up',
      build: () => [
        imageBox(4, 18, 28, 54),
        imageBox(36, 18, 28, 54),
        imageBox(68, 18, 28, 54),
      ],
    },
    {
      label: 'Case Study',
      build: () => [
        text(8, 6, 84, 10, 'Case Study', 26, { bold: true }),
        rect(8, 20, 32, 68, '#e5e7eb'),
        text(46, 20, 44, 12, 'Challenge', 18, { bold: true }),
        text(46, 34, 44, 12, 'Approach', 18, { bold: true }),
        text(46, 48, 44, 12, 'Outcome', 18, { bold: true }),
      ],
    },
    {
      label: 'Before After',
      build: () => [
        text(8, 6, 84, 10, 'Before / After', 24, { bold: true, textAlign: 'center' }),
        rect(6, 20, 40, 64, '#f3f4f6'),
        rect(54, 20, 40, 64, '#ecfccb'),
        text(18, 22, 16, 8, 'Before', 18, { bold: true, textAlign: 'center' }),
        text(66, 22, 16, 8, 'After', 18, { bold: true, textAlign: 'center' }),
      ],
    },
    {
      label: 'Team Grid',
      build: () => [
        text(8, 6, 84, 10, 'Team', 24, { bold: true, textAlign: 'center' }),
        circle(10, 24, 14, 14, '#d1d5db'),
        circle(30, 24, 14, 14, '#d1d5db'),
        circle(50, 24, 14, 14, '#d1d5db'),
        circle(70, 24, 14, 14, '#d1d5db'),
        circle(20, 56, 14, 14, '#d1d5db'),
        circle(40, 56, 14, 14, '#d1d5db'),
        circle(60, 56, 14, 14, '#d1d5db'),
      ],
    },
    {
      label: 'Org Chart',
      build: () => [
        rect(38, 10, 24, 12, '#dbeafe'),
        line(50, 22, 1, '#94a3b8', 2),
        line(20, 38, 60, '#94a3b8', 2),
        rect(8, 40, 20, 12, '#fef3c7'),
        rect(40, 40, 20, 12, '#fef3c7'),
        rect(72, 40, 20, 12, '#fef3c7'),
      ],
    },
    {
      label: 'Split Story',
      build: () => [
        rect(0, 0, 48, 100, '#111827'),
        text(6, 18, 36, 18, 'Title', 28, { bold: true, fontColor: '#ffffff' }),
        text(6, 42, 34, 22, 'Enter description', 16, { fontColor: '#d1d5db' }),
        imageBox(54, 10, 38, 80, '#d1d5db'),
      ],
    },
    {
      label: 'Title and 3 Bullets',
      build: () => [
        text(8, 8, 84, 10, 'Title', 28, { bold: true }),
        text(12, 28, 74, 10, '• First key point', 20),
        text(12, 44, 74, 10, '• Second key point', 20),
        text(12, 60, 74, 10, '• Third key point', 20),
      ],
    },
    {
      label: 'Feature Spotlight',
      build: () => [
        imageBox(6, 18, 36, 64, '#d1d5db'),
        text(48, 18, 42, 10, 'Feature Spotlight', 24, { bold: true }),
        text(48, 34, 40, 26, 'Enter description', 16, { fontColor: '#4b5563' }),
        rect(48, 66, 20, 10, '#2563eb'),
      ],
    },
    {
      label: 'Section Divider',
      build: () => [
        rect(0, 0, 100, 100, '#0f172a'),
        line(20, 50, 60, '#fbbf24', 3),
        text(20, 34, 60, 12, 'Title', 30, { bold: true, textAlign: 'center', fontColor: '#ffffff' }),
      ],
    },
    {
      label: 'Thank You',
      build: () => [
        text(10, 26, 80, 18, 'Thank You', 40, { bold: true, textAlign: 'center' }),
        text(18, 52, 64, 10, 'name@email.com', 18, { textAlign: 'center', fontColor: '#6b7280' }),
      ],
    },
    {
      label: 'Contact Card',
      build: () => [
        rect(14, 24, 72, 46, '#f8fafc', { borderColor: '#cbd5e1', borderWidth: 1, shadow: true }),
        circle(20, 34, 14, 14, '#d1d5db'),
        text(40, 32, 34, 8, 'Your Name', 22, { bold: true }),
        text(40, 44, 34, 8, 'Role / Company', 16, { fontColor: '#6b7280' }),
        text(40, 56, 34, 8, 'email@example.com', 16, { fontColor: '#2563eb' }),
      ],
    },
    {
      label: 'Table Layout',
      build: () => [
        text(8, 6, 84, 10, 'Table Layout', 24, { bold: true }),
        rect(8, 22, 84, 14, '#e2e8f0'),
        rect(8, 38, 84, 14, '#f8fafc'),
        rect(8, 54, 84, 14, '#f8fafc'),
        rect(8, 70, 84, 14, '#f8fafc'),
      ],
    },
    {
      label: 'Metrics + Chart',
      build: () => [
        rect(6, 14, 26, 22, '#dbeafe'),
        rect(6, 40, 26, 22, '#dcfce7'),
        rect(6, 66, 26, 22, '#fef3c7'),
        rect(38, 18, 54, 62, '#f8fafc'),
        line(44, 72, 40, '#94a3b8', 2),
      ],
    },
    {
      label: 'Image Banner',
      build: () => [
        imageBox(0, 0, 100, 40, '#d1d5db'),
        text(8, 50, 84, 10, 'Title', 28, { bold: true }),
        text(8, 64, 74, 14, 'Enter description', 16, { fontColor: '#4b5563' }),
      ],
    },
    {
      label: 'Centered Statement',
      build: () => [
        text(14, 28, 72, 18, 'Add a strong statement here', 30, { bold: true, textAlign: 'center' }),
        text(24, 52, 52, 10, 'Optional supporting line', 18, { textAlign: 'center', fontColor: '#6b7280' }),
      ],
    },
    {
      label: 'Three Stats',
      build: () => [
        rect(6, 28, 26, 34, '#e0f2fe'),
        rect(37, 28, 26, 34, '#dcfce7'),
        rect(68, 28, 26, 34, '#fef3c7'),
        text(10, 34, 18, 8, '24%', 24, { bold: true, textAlign: 'center' }),
        text(41, 34, 18, 8, '18K', 24, { bold: true, textAlign: 'center' }),
        text(72, 34, 18, 8, '7.2', 24, { bold: true, textAlign: 'center' }),
      ],
    },
  ];
}

// ─── Utilities ────────────────────────────────────────────────

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createBlankSlide(): Slide {
  return {
    id: uid(),
    title: '',
    bgColor: '#ffffff',
    bgImage: undefined,
    notes: '',
    hidden: false,
    transition: { type: 'none', durationMs: 450, advanceAfterSec: 0 },
    elements: [],
  };
}

export function snapVal(v: number, enabled: boolean): number {
  if (!enabled) return v;
  return Math.round(v / SNAP_PCT) * SNAP_PCT;
}
