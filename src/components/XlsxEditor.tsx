/**
 * XlsxEditor.tsx
 *
 * Spreadsheet editor for XLSX files using SheetJS (xlsx) for parsing/writing
 * and a custom React grid for editing. Supports multiple sheets, cell formatting,
 * column/row resize, basic formulas, and import/export.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Bold, Italic, Underline, Strikethrough, WrapText, Save, SaveAll, Undo2, Redo2,
  AlignLeft, AlignCenter, AlignRight,
  Plus, Trash2, ArrowDownToLine, ArrowRightToLine,
  Merge, SplitSquareHorizontal,
  ArrowUpDown, ArrowDownUp, Filter, FilterX,
  Search, Replace, Lock, Unlock,
  Type, Hash, Percent, Calendar, DollarSign,
  PaintBucket, Crosshair,
  ChevronDown, ChevronsLeftRight, Eraser, Grid3x3,
  Sparkles, Table2, Calculator, BarChart3, Flame, TrendingUp, BriefcaseBusiness, SlidersHorizontal,
  Target, Paintbrush, Copy, X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { WorkSheet } from 'xlsx';
import { focusOutsideEditor } from './editorKeyScope';
import './XlsxEditor.css';

// ─── Types ──────────────────────────────────────────────────────────

interface XlsxEditorProps {
  filePath: string;
  /** base64 data URL (data:application/...;base64,...) */
  xlsxData: string;
  style: { bg: string; text: string; accent: string };
  onSaved?: (path: string) => void;
  onModifiedChange?: (modified: boolean) => void;
}

export interface CellBorder {
  top?: boolean;
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
}

export type BorderPreset = 'all' | 'outline' | 'top' | 'bottom' | 'left' | 'right' | 'none';

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  wrapText?: boolean;
  color?: string;       // text color
  bgColor?: string;     // background color
  align?: 'left' | 'center' | 'right';
  border?: CellBorder;
  numberFormat?:
    | 'general'
    | 'number'
    | 'integer'
    | 'decimal1'
    | 'decimal2'
    | 'currency'
    | 'accounting'
    | 'percent'
    | 'date'
    | 'datetime'
    | 'time'
    | 'scientific'
    | 'text';
  // Original Excel number-format code (cell.z) preserved verbatim so a
  // round-trip never rewrites e.g. a $ currency code into the ₩ bucket code.
  // Cleared when the user explicitly picks a format bucket in the UI/bridge.
  rawNumberFormat?: string;
  fontSize?: number;
}

export interface CellData {
  value: string;
  formula?: string;     // e.g. "=SUM(A1:A5)"
  format?: CellFormat;
}

interface MergeRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

export interface SheetData {
  name: string;
  cells: Record<string, CellData>;   // "A1" -> CellData
  colWidths: Record<number, number>;  // 0-indexed col -> px width
  rowHeights: Record<number, number>; // 0-indexed row -> px height
  maxCol: number;
  maxRow: number;
  merges?: MergeRange[];
  frozenRows?: number;
  frozenCols?: number;
  conditionalRules?: ConditionalRule[];
}

interface HistoryEntry {
  sheets: SheetData[];
  activeSheetIdx: number;
}

// ─── Utilities ──────────────────────────────────────────────────────

const DEFAULT_COL_WIDTH = 90;
const DEFAULT_ROW_HEIGHT = 24;
const MAX_UNDO = 40;
// Sheets at or below this row count render every row (no windowing needed).
const VIRTUAL_ROW_THRESHOLD = 200;
const ROW_OVERSCAN = 10;
// Sheets at or below this column count mount every column; beyond it the grid
// windows columns to the visible horizontal viewport (plus overscan).
const VIRTUAL_COL_THRESHOLD = 40;
const COL_OVERSCAN = 3;
// Excel grid limits + a bridge-side cell budget so one agent command can't
// materialize a runaway range and freeze/OOM the webview (mirrors the formula
// engine's buildRange guard). These input caps also bound the prefix-sum layout
// arrays the row/column windowing builds each render.
const XLSX_MAX_COL = 16383;   // XFD
const XLSX_MAX_ROW = 1048575; // 0-indexed; row 1048576
const BRIDGE_MAX_CELLS = 100000;

// Number of cells a start:end range would expand to (single ref counts as 1).
function rangeCellCount(range: string): number {
  const parts = range.split(':');
  if (parts.length !== 2) return 1;
  const start = parseCellRef(parts[0]);
  const end = parseCellRef(parts[1]);
  if (!start || !end) return 1;
  return (Math.abs(end.row - start.row) + 1) * (Math.abs(end.col - start.col) + 1);
}
const COL_HEADER_HEIGHT = 28;
// Visible border for cells the user has explicitly bordered (saved as thin black).
const CELL_BORDER_STYLE = '1px solid #333333';

// MS365-style fixed Office palette: the spreadsheet surface stays light with
// the Excel green accent regardless of the terminal theme, like Excel for web.
const OFFICE_UI = { bg: '#ffffff', text: '#242424', accent: '#107C41' };

type XlsxRibbonTab = 'File' | 'Home' | 'Insert' | 'Draw' | 'Page Layout' | 'Formulas' | 'Data' | 'Review' | 'View' | 'Automate' | 'Help';

const XLSX_RIBBON_TABS: XlsxRibbonTab[] = [
  'File',
  'Home',
  'Insert',
  'Draw',
  'Page Layout',
  'Formulas',
  'Data',
  'Review',
  'View',
  'Automate',
  'Help',
];

export interface XlsxFormulaHelper {
  name: string;
  category: 'Math' | 'Logic' | 'Lookup' | 'Text' | 'Date' | 'Stats';
  syntax: string;
  description: string;
  template: string;
}

export const XLSX_FORMULA_LIBRARY: XlsxFormulaHelper[] = [
  { name: 'SUM', category: 'Math', syntax: 'SUM(range)', description: 'Adds up all numbers in the selected range.', template: '=SUM({range})' },
  { name: 'AVERAGE', category: 'Math', syntax: 'AVERAGE(range)', description: 'Calculates the average of the selected range.', template: '=AVERAGE({range})' },
  { name: 'COUNT', category: 'Math', syntax: 'COUNT(range)', description: 'Counts the number of numeric cells in the selected range.', template: '=COUNT({range})' },
  { name: 'MIN', category: 'Math', syntax: 'MIN(range)', description: 'Finds the minimum value in the selected range.', template: '=MIN({range})' },
  { name: 'MAX', category: 'Math', syntax: 'MAX(range)', description: 'Finds the maximum value in the selected range.', template: '=MAX({range})' },
  { name: 'IF', category: 'Logic', syntax: 'IF(condition, true, false)', description: 'Shows a different value based on a condition.', template: '=IF({cell}>0,"Yes","No")' },
  { name: 'SUMIF', category: 'Logic', syntax: 'SUMIF(range, criteria, sumRange)', description: 'Sums only the items that match a condition.', template: '=SUMIF({range},"criteria",{range})' },
  { name: 'COUNTIF', category: 'Logic', syntax: 'COUNTIF(range, criteria)', description: 'Counts the number of cells that match a condition.', template: '=COUNTIF({range},"criteria")' },
  { name: 'XLOOKUP', category: 'Lookup', syntax: 'XLOOKUP(value, lookupRange, returnRange, fallback)', description: 'Looks up a key value and returns the matching value.', template: '=XLOOKUP({cell},{range},{range},"not found")' },
  { name: 'VLOOKUP', category: 'Lookup', syntax: 'VLOOKUP(value, tableRange, colIndex)', description: 'Finds a value in the first column of a table and returns a value from the specified column.', template: '=VLOOKUP({cell},{range},2)' },
  { name: 'INDEX', category: 'Lookup', syntax: 'INDEX(range, row, col)', description: 'Gets the value at a specified position within a range.', template: '=INDEX({range},1,1)' },
  { name: 'MATCH', category: 'Lookup', syntax: 'MATCH(value, range, 0)', description: 'Finds the position of a value within a range.', template: '=MATCH({cell},{range},0)' },
  { name: 'ABS', category: 'Math', syntax: 'ABS(value)', description: 'Calculates the absolute value.', template: '=ABS({cell})' },
  { name: 'SUMIFS', category: 'Logic', syntax: 'SUMIFS(sumRange, critRange1, crit1, ...)', description: 'Sums values that satisfy every criteria pair.', template: '=SUMIFS({range},{range},"criteria")' },
  { name: 'COUNTIFS', category: 'Logic', syntax: 'COUNTIFS(critRange1, crit1, ...)', description: 'Counts rows that satisfy every criteria pair.', template: '=COUNTIFS({range},"criteria")' },
  { name: 'AVERAGEIF', category: 'Logic', syntax: 'AVERAGEIF(range, criteria, avgRange)', description: 'Averages only the items that match a condition.', template: '=AVERAGEIF({range},"criteria",{range})' },
  { name: 'IFERROR', category: 'Logic', syntax: 'IFERROR(value, fallback)', description: 'Replaces formula errors with a fallback value.', template: '=IFERROR({cell},"-")' },
  { name: 'IFS', category: 'Logic', syntax: 'IFS(cond1, val1, cond2, val2, ...)', description: 'Returns the value for the first condition that is true.', template: '=IFS({cell}>0,"up",{cell}<0,"down")' },
  { name: 'AND', category: 'Logic', syntax: 'AND(cond1, cond2, ...)', description: 'TRUE when every condition is true.', template: '=AND({cell}>0,{cell}<100)' },
  { name: 'OR', category: 'Logic', syntax: 'OR(cond1, cond2, ...)', description: 'TRUE when any condition is true.', template: '=OR({cell}>0,{cell}<-10)' },
  { name: 'HLOOKUP', category: 'Lookup', syntax: 'HLOOKUP(value, tableRange, rowIndex, FALSE)', description: 'Finds a value in the first row of a table and returns a value from the specified row.', template: '=HLOOKUP({cell},{range},2,FALSE)' },
  { name: 'CHOOSE', category: 'Lookup', syntax: 'CHOOSE(index, val1, val2, ...)', description: 'Picks a value by position.', template: '=CHOOSE({cell},"a","b","c")' },
  { name: 'CONCAT', category: 'Text', syntax: 'CONCAT(val1, val2, ...)', description: 'Joins values and ranges into one text.', template: '=CONCAT({range})' },
  { name: 'TEXTJOIN', category: 'Text', syntax: 'TEXTJOIN(delimiter, ignoreEmpty, range)', description: 'Joins a range with a delimiter, optionally skipping blanks.', template: '=TEXTJOIN(", ",TRUE,{range})' },
  { name: 'SUBSTITUTE', category: 'Text', syntax: 'SUBSTITUTE(text, old, new)', description: 'Replaces matching text within a string.', template: '=SUBSTITUTE({cell},"old","new")' },
  { name: 'TEXT', category: 'Text', syntax: 'TEXT(value, format)', description: 'Formats a number or date as text (e.g. "#,##0.00", "0.0%").', template: '=TEXT({cell},"#,##0.00")' },
  { name: 'LEFT', category: 'Text', syntax: 'LEFT(text, count)', description: 'Takes characters from the start of a text.', template: '=LEFT({cell},3)' },
  { name: 'TODAY', category: 'Date', syntax: 'TODAY()', description: 'Returns today\'s date.', template: '=TODAY()' },
  { name: 'DATEDIF', category: 'Date', syntax: 'DATEDIF(start, end, "D|M|Y")', description: 'Days, months, or years between two dates.', template: '=DATEDIF({cell},TODAY(),"D")' },
  { name: 'EOMONTH', category: 'Date', syntax: 'EOMONTH(date, months)', description: 'Last day of the month, offset by N months.', template: '=EOMONTH({cell},0)' },
  { name: 'YEAR', category: 'Date', syntax: 'YEAR(date)', description: 'Extracts the year from a date.', template: '=YEAR({cell})' },
  { name: 'MEDIAN', category: 'Stats', syntax: 'MEDIAN(range)', description: 'Middle value of the selected range.', template: '=MEDIAN({range})' },
  { name: 'STDEV', category: 'Stats', syntax: 'STDEV(range)', description: 'Sample standard deviation of the selected range.', template: '=STDEV({range})' },
  { name: 'RANK', category: 'Stats', syntax: 'RANK(value, range)', description: 'Rank of a value within a range (1 = largest).', template: '=RANK({cell},{range})' },
  { name: 'LARGE', category: 'Stats', syntax: 'LARGE(range, k)', description: 'K-th largest value in a range.', template: '=LARGE({range},1)' },
  { name: 'SUMPRODUCT', category: 'Math', syntax: 'SUMPRODUCT(range1, range2)', description: 'Multiplies matching cells and sums the results.', template: '=SUMPRODUCT({range},{range})' },
  { name: 'ROUND', category: 'Math', syntax: 'ROUND(value, digits)', description: 'Rounds a number to the given number of digits.', template: '=ROUND({cell},2)' },
];

export function buildFormulaFromHelper(helper: XlsxFormulaHelper, range: string, cell: string): string {
  return helper.template
    .replace(/\{range\}/g, range || cell)
    .replace(/\{cell\}/g, cell || range);
}

export function colToLetter(col: number): string {
  let s = '';
  let c = col;
  while (c >= 0) {
    s = String.fromCharCode((c % 26) + 65) + s;
    c = Math.floor(c / 26) - 1;
  }
  return s;
}

export function letterToCol(letter: string): number {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col - 1;
}

export function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { col: letterToCol(m[1]), row: parseInt(m[2], 10) - 1 };
}

export function cellRef(col: number, row: number): string {
  return `${colToLetter(col)}${row + 1}`;
}

// ─── Row virtualization ─────────────────────────────────────────────
// Windows the rendered rows to the visible viewport (plus overscan) so a
// 10,000-row sheet only mounts the handful of <tr> that are on screen.

export function computeVisibleRowRange(params: {
  rowCount: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}): { startRow: number; endRow: number } {
  const { rowCount, rowHeight, scrollTop, viewportHeight, overscan } = params;
  if (rowCount <= 0 || rowHeight <= 0) return { startRow: 0, endRow: -1 };
  const first = Math.floor(scrollTop / rowHeight) - overscan;
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan;
  const endRow = Math.min(rowCount - 1, Math.max(0, last));
  return {
    startRow: Math.min(endRow, Math.max(0, first)),
    endRow,
  };
}

// A merge that begins above the window but still crosses into it must have its
// starting <tr> rendered, otherwise the rowSpan cell vanishes. Pull the window
// start up to the earliest such merge so the range stays contiguous.
export function expandRowRangeForMerges(
  startRow: number,
  endRow: number,
  merges: MergeRange[],
): { startRow: number; endRow: number } {
  let s = startRow;
  for (const m of merges) {
    if (m.startRow < s && m.endRow >= s) s = m.startRow;
  }
  return { startRow: s, endRow };
}

// ─── Prefix-sum windowing (rows + columns) ──────────────────────────
// Virtualization runs in *visible-slot* space: rows hidden by a column filter
// are dropped from `visibleRowIndices` entirely, and each slot contributes its
// real pixel size (custom row height / column width) to a prefix-sum. That keeps
// the scroll position, the rendered slice, and the spacer sizes exactly aligned
// even with a filter applied and mixed custom sizes — a single fixed per-row
// height (the old approach) drifted the moment either was present, which is why
// the old code disabled windowing entirely whenever a filter hid a row.

// offsets[i] is the cumulative pixel offset of visible slot i; offsets[n] is the
// grand total. Slot i spans [offsets[i], offsets[i + 1]).
export function computeRowLayout(
  visibleRowIndices: number[],
  rowHeights: Record<number, number>,
  defaultHeight: number,
): { offsets: number[]; total: number } {
  const offsets = new Array<number>(visibleRowIndices.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < visibleRowIndices.length; i++) {
    offsets[i + 1] = offsets[i] + (rowHeights[visibleRowIndices[i]] || defaultHeight);
  }
  return { offsets, total: offsets[visibleRowIndices.length] };
}

export function computeColLayout(
  colCount: number,
  colWidths: Record<number, number>,
  defaultWidth: number,
): { offsets: number[]; total: number } {
  const n = Math.max(0, colCount);
  const offsets = new Array<number>(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    offsets[i + 1] = offsets[i] + (colWidths[i] || defaultWidth);
  }
  return { offsets, total: offsets[n] };
}

// Smallest offsets index whose value is > target (strict) or >= target (orEqual).
function firstOffsetAbove(offsets: number[], target: number, orEqual: boolean): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const hit = orEqual ? offsets[mid] >= target : offsets[mid] > target;
    if (hit) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Inclusive slot range intersecting the viewport, padded by `overscan`. Returns
// { startIdx: 0, endIdx: -1 } when there are no slots so callers render nothing.
export function rangeForScroll(
  scroll: number,
  viewport: number,
  offsets: number[],
  overscan = 0,
): { startIdx: number; endIdx: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { startIdx: 0, endIdx: -1 };
  const top = Math.max(0, scroll);
  const bottom = top + Math.max(0, viewport);
  // First slot whose bottom edge passes `top`; last slot whose top edge precedes `bottom`.
  const startIdx = firstOffsetAbove(offsets, top, false) - 1;
  const endIdx = firstOffsetAbove(offsets, bottom, true) - 1;
  const clampedStart = Math.max(0, Math.min(n - 1, startIdx - overscan));
  const clampedEnd = Math.max(clampedStart, Math.min(n - 1, endIdx + overscan));
  return { startIdx: clampedStart, endIdx: clampedEnd };
}

// ─── Merge-aware column render plan ─────────────────────────────────
// Horizontal windowing renders only the frozen band plus [winColStart..winColEnd]
// and collapses the rest into pixel-width spacer cells. Merges make that unsafe
// on their own: a merge anchor sitting left of the window still needs its <td>
// mounted because its colSpan reaches into the window, and a merge whose span
// runs past a window edge must land that colSpan on a real slot boundary. This
// plan folds both cases into one ordered slot list that the header row, every
// body row, and the merge colSpans all share, so no hole or offset drift appears.
//
// A slot is either a rendered sheet column ('col') or a run of skipped columns
// ('spacer', carrying the summed pixel width). A spacer that lies inside a
// rendered merge's horizontal span is covered by that merge for the merge's rows
// (its colSpan on the anchor row, its rowSpan below), so it lists those row
// ranges in `coverRows` and callers drop it on exactly those rows.
export interface ColSlot {
  kind: 'col' | 'spacer';
  startCol: number;   // first sheet column represented by the slot
  endCol: number;     // last sheet column represented (== startCol for a 'col')
  width: number;      // spacer pixel width; 0 for a 'col' (its width is the column's own)
  coverRows?: { startRow: number; endRow: number }[];
}

interface ColSpan {
  startCol: number;
  endCol: number;
  startRow: number;
  endRow: number;
}

export function computeColRenderPlan(params: {
  colCount: number;
  frozenCols: number;
  winColStart: number;
  winColEnd: number;
  merges: ColSpan[];
  offsets: number[];
  virtualize: boolean;
}): { slots: ColSlot[]; renderCols: number[] } {
  const { colCount, offsets, merges } = params;
  if (colCount <= 0) return { slots: [], renderCols: [] };

  // Not virtualizing: every column is its own slot, no spacers, colSpans stay raw.
  if (!params.virtualize) {
    const slots: ColSlot[] = [];
    const renderCols: number[] = [];
    for (let c = 0; c < colCount; c++) {
      slots.push({ kind: 'col', startCol: c, endCol: c, width: 0 });
      renderCols.push(c);
    }
    return { slots, renderCols };
  }

  const frozen = Math.max(0, Math.min(params.frozenCols, colCount));
  const winStart = Math.max(frozen, Math.min(colCount - 1, params.winColStart));
  const winEnd = Math.max(winStart, Math.min(colCount - 1, params.winColEnd));

  // Columns that get a real <td> on every row: frozen band + scroll window + any
  // merge anchor that starts left of the window but reaches into it. At most one
  // merge can cross the left edge (two would overlap on winStart), but the loop
  // stays correct for any input.
  const rendered = new Set<number>();
  for (let c = 0; c < frozen; c++) rendered.add(c);
  for (let c = winStart; c <= winEnd; c++) rendered.add(c);
  for (const m of merges) {
    if (m.startCol < winStart && m.endCol >= winStart) rendered.add(m.startCol);
  }

  // A rendered anchor whose span ends inside a collapsed region needs that region
  // to break exactly at its endCol so the anchor's colSpan lands on a slot edge.
  const cutAfter = new Set<number>();
  for (const m of merges) {
    if (rendered.has(m.startCol) && !rendered.has(m.endCol)) cutAfter.add(m.endCol);
  }

  const slots: ColSlot[] = [];
  let c = 0;
  while (c < colCount) {
    if (rendered.has(c)) {
      slots.push({ kind: 'col', startCol: c, endCol: c, width: 0 });
      c++;
      continue;
    }
    const start = c;
    while (c < colCount && !rendered.has(c)) {
      const boundary = cutAfter.has(c);
      c++;
      if (boundary) break;
    }
    const end = c - 1;
    slots.push({ kind: 'spacer', startCol: start, endCol: end, width: offsets[end + 1] - offsets[start] });
  }

  // Mark spacers that sit wholly inside a rendered merge's horizontal span so
  // callers can drop them on that merge's rows (the anchor's colSpan/rowSpan
  // already paints those grid columns there).
  for (const slot of slots) {
    if (slot.kind !== 'spacer') continue;
    for (const m of merges) {
      if (rendered.has(m.startCol) && m.startCol <= slot.startCol && m.endCol >= slot.endCol) {
        (slot.coverRows ||= []).push({ startRow: m.startRow, endRow: m.endRow });
      }
    }
  }

  const renderCols = [...rendered].sort((a, b) => a - b);
  return { slots, renderCols };
}

// Grid-column span for a merge anchor inside a plan: count the slots its sheet
// span [startCol..endCol] covers. Falls back to the raw span when the endpoints
// are not slot boundaries (never happens for a rendered anchor).
export function gridColSpanForMerge(slots: ColSlot[], startCol: number, endCol: number): number {
  let i = -1;
  let j = -1;
  for (let k = 0; k < slots.length; k++) {
    if (slots[k].kind === 'col' && slots[k].startCol === startCol) i = k;
    if (slots[k].endCol === endCol) j = k;
  }
  if (i < 0 || j < 0 || j < i) return endCol - startCol + 1;
  return j - i + 1;
}

// ─── Cell borders ───────────────────────────────────────────────────

export function computeBorderEdges(
  preset: BorderPreset,
  col: number,
  row: number,
  minCol: number,
  maxCol: number,
  minRow: number,
  maxRow: number,
): CellBorder {
  switch (preset) {
    case 'all':
      return { top: true, bottom: true, left: true, right: true };
    case 'outline':
      return { top: row === minRow, bottom: row === maxRow, left: col === minCol, right: col === maxCol };
    case 'top':
      return { top: true };
    case 'bottom':
      return { bottom: true };
    case 'left':
      return { left: true };
    case 'right':
      return { right: true };
    default:
      return {};
  }
}

export function hasAnyBorder(border: CellBorder | undefined): boolean {
  return !!border && (!!border.top || !!border.bottom || !!border.left || !!border.right);
}

// ─── Freeze panes (SheetJS pane format ↔ per-sheet counts) ──────────

export function freezeToPane(
  frozenRows: number,
  frozenCols: number,
): { xSplit: number; ySplit: number; topLeftCell: string; activePane: string; state: string } | null {
  if (!frozenRows && !frozenCols) return null;
  return {
    xSplit: frozenCols,
    ySplit: frozenRows,
    topLeftCell: cellRef(frozenCols, frozenRows),
    activePane: 'bottomRight',
    state: 'frozen',
  };
}

export function paneToFreeze(pane: unknown): { frozenRows: number; frozenCols: number } {
  if (!pane || typeof pane !== 'object') return { frozenRows: 0, frozenCols: 0 };
  const p = pane as { xSplit?: unknown; ySplit?: unknown };
  return {
    frozenRows: Math.max(0, Math.round(Number(p.ySplit) || 0)),
    frozenCols: Math.max(0, Math.round(Number(p.xSplit) || 0)),
  };
}

export function nextSpreadsheetCellRef(
  ref: string,
  sheet: Pick<SheetData, 'maxCol' | 'maxRow'>,
  dCol: number,
  dRow: number,
  expand = false,
): string | null {
  const parsed = parseCellRef(ref);
  if (!parsed) return null;
  const maxCol = expand ? Math.max(sheet.maxCol, parsed.col + Math.max(0, dCol)) : sheet.maxCol;
  const maxRow = expand ? Math.max(sheet.maxRow, parsed.row + Math.max(0, dRow)) : sheet.maxRow;
  const nextCol = Math.max(0, Math.min(parsed.col + dCol, maxCol));
  const nextRow = Math.max(0, Math.min(parsed.row + dRow, maxRow));
  return cellRef(nextCol, nextRow);
}

export function expandRange(range: string): string[] {
  const parts = range.split(':');
  if (parts.length !== 2) return [range];
  const start = parseCellRef(parts[0]);
  const end = parseCellRef(parts[1]);
  if (!start || !end) return [range];
  const refs: string[] = [];
  for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
    for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
      refs.push(cellRef(c, r));
    }
  }
  return refs;
}

// ─── Formula engine ─────────────────────────────────────────────────
// Tokenizer + recursive-descent parser + evaluator. Supports nested function
// calls, operator precedence (comparisons < & < + - < * / < ^ < unary - < %),
// parentheses, $A$1 absolute references, quoted strings, TRUE/FALSE, column
// ranges (B:B), Excel-style error codes with propagation, and cycle detection.

class FormulaCalcError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const FORMULA_ERROR_CODES = new Set(['#DIV/0!', '#N/A', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#NULL!', '#SPILL!']);

/** rows × cols matrix of cell refs, produced by range expressions like A1:B3. */
interface FormulaRangeValue {
  rng: true;
  refs: string[][];
}

type FormulaScalar = number | string | boolean;
type FormulaValue = FormulaScalar | FormulaRangeValue;

function isFormulaRange(value: FormulaValue): value is FormulaRangeValue {
  return typeof value === 'object';
}

interface FormulaToken {
  t: 'num' | 'str' | 'ident' | 'op';
  v: string;
}

const FORMULA_CELL_REF = /^\$?[A-Za-z]{1,3}\$?\d+$/;
const FORMULA_COL_REF = /^\$?[A-Za-z]{1,3}$/;

function tokenizeFormula(expr: string): FormulaToken[] | null {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i++;
      while (i < expr.length && !(expr[i] === '"' && expr[i + 1] !== '"')) {
        if (expr[i] === '"' && expr[i + 1] === '"') {
          out += '"';
          i += 2;
        } else {
          out += expr[i++];
        }
      }
      if (expr[i] !== '"') return null;
      i++;
      tokens.push({ t: 'str', v: out });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(expr[i + 1] || ''))) {
      const match = expr.slice(i).match(/^(\d+\.?\d*|\.\d+)([Ee][+-]?\d+)?/);
      if (!match) return null;
      tokens.push({ t: 'num', v: match[0] });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = expr.slice(i).match(/^[$A-Za-z_][$A-Za-z0-9_.]*/);
      if (!match) return null;
      tokens.push({ t: 'ident', v: match[0] });
      i += match[0].length;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '<>') {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/^&%(),:=<>'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

type FormulaNode =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; ref: string }
  | { t: 'range'; from: string; to: string }
  | { t: 'colrange'; from: string; to: string }
  | { t: 'call'; name: string; args: FormulaNode[] }
  | { t: 'bin'; op: string; left: FormulaNode; right: FormulaNode }
  | { t: 'neg'; operand: FormulaNode }
  | { t: 'pct'; operand: FormulaNode };

function parseFormulaTokens(tokens: FormulaToken[]): FormulaNode {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => tokens[pos]?.t === 'op' && tokens[pos].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaCalcError('#VALUE!');
    pos++;
  };

  function comparison(): FormulaNode {
    let left = concat();
    while (peek()?.t === 'op' && ['=', '<>', '<=', '>=', '<', '>'].includes(peek().v)) {
      const op = tokens[pos++].v;
      left = { t: 'bin', op, left, right: concat() };
    }
    return left;
  }
  function concat(): FormulaNode {
    let left = additive();
    while (isOp('&')) {
      pos++;
      left = { t: 'bin', op: '&', left, right: additive() };
    }
    return left;
  }
  function additive(): FormulaNode {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].v;
      left = { t: 'bin', op, left, right: term() };
    }
    return left;
  }
  function term(): FormulaNode {
    let left = power();
    while (isOp('*') || isOp('/')) {
      const op = tokens[pos++].v;
      left = { t: 'bin', op, left, right: power() };
    }
    return left;
  }
  function power(): FormulaNode {
    let left = unary();
    while (isOp('^')) {
      pos++;
      left = { t: 'bin', op: '^', left, right: unary() };
    }
    return left;
  }
  function unary(): FormulaNode {
    if (isOp('-')) {
      pos++;
      return { t: 'neg', operand: unary() };
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return postfix();
  }
  function postfix(): FormulaNode {
    let node = atom();
    while (isOp('%')) {
      pos++;
      node = { t: 'pct', operand: node };
    }
    return node;
  }
  function atom(): FormulaNode {
    const token = peek();
    if (!token) throw new FormulaCalcError('#VALUE!');
    if (token.t === 'num') {
      pos++;
      return { t: 'num', v: Number(token.v) };
    }
    if (token.t === 'str') {
      pos++;
      return { t: 'str', v: token.v };
    }
    if (token.t === 'op' && token.v === '(') {
      pos++;
      const inner = comparison();
      expect(')');
      return inner;
    }
    if (token.t === 'ident') {
      pos++;
      const name = token.v;
      if (isOp('(')) {
        pos++;
        const args: FormulaNode[] = [];
        if (!isOp(')')) {
          args.push(comparison());
          while (isOp(',')) {
            pos++;
            // Excel allows omitted arguments: IF(A1>0,,"no")
            args.push(isOp(',') || isOp(')') ? { t: 'str', v: '' } : comparison());
          }
        }
        expect(')');
        return { t: 'call', name: name.toUpperCase(), args };
      }
      if (isOp(':') && FORMULA_CELL_REF.test(name)) {
        pos++;
        const to = tokens[pos++];
        if (to?.t !== 'ident' || !FORMULA_CELL_REF.test(to.v)) throw new FormulaCalcError('#REF!');
        return { t: 'range', from: name, to: to.v };
      }
      if (isOp(':') && FORMULA_COL_REF.test(name)) {
        pos++;
        const to = tokens[pos++];
        if (to?.t !== 'ident' || !FORMULA_COL_REF.test(to.v)) throw new FormulaCalcError('#REF!');
        return { t: 'colrange', from: name, to: to.v };
      }
      if (FORMULA_CELL_REF.test(name)) return { t: 'ref', ref: name };
      const upper = name.toUpperCase();
      if (upper === 'TRUE') return { t: 'bool', v: true };
      if (upper === 'FALSE') return { t: 'bool', v: false };
      throw new FormulaCalcError('#NAME?');
    }
    throw new FormulaCalcError('#VALUE!');
  }

  const root = comparison();
  if (pos !== tokens.length) throw new FormulaCalcError('#VALUE!');
  return root;
}

function formulaNumberToText(value: number): string {
  if (!Number.isFinite(value)) throw new FormulaCalcError('#NUM!');
  return String(Math.round(value * 1e10) / 1e10);
}

function formulaPad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formulaDateToIso(date: Date): string {
  return `${date.getFullYear()}-${formulaPad2(date.getMonth() + 1)}-${formulaPad2(date.getDate())}`;
}

/** Excel serial day 0 = 1899-12-30 (matches Excel's 1900 system for modern dates). */
const FORMULA_SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

function parseFormulaDate(value: FormulaScalar): Date {
  if (typeof value === 'number') {
    return new Date(FORMULA_SERIAL_EPOCH_MS + value * 86400000 + new Date().getTimezoneOffset() * 60000);
  }
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (iso) {
    return new Date(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      Number(iso[4] || 0), Number(iso[5] || 0), Number(iso[6] || 0),
    );
  }
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed;
  throw new FormulaCalcError('#VALUE!');
}

class FormulaEvaluator {
  private maxRowCache: number | null = null;
  private cells: Record<string, CellData>;
  private visited: Set<string>;

  constructor(cells: Record<string, CellData>, visited: Set<string>) {
    this.cells = cells;
    this.visited = visited;
  }

  display(value: FormulaValue): string {
    const scalar = this.scalar(value);
    if (typeof scalar === 'number') return formulaNumberToText(scalar);
    if (typeof scalar === 'boolean') return scalar ? 'TRUE' : 'FALSE';
    return scalar;
  }

  value(node: FormulaNode): FormulaValue {
    switch (node.t) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'bool': return node.v;
      case 'ref': return this.readCell(node.ref);
      case 'range': return this.buildRange(node.from, node.to);
      case 'colrange': return this.buildColRange(node.from, node.to);
      case 'neg': return -this.num(node.operand);
      case 'pct': return this.num(node.operand) / 100;
      case 'bin': return this.binary(node.op, node.left, node.right);
      case 'call': return this.call(node.name, node.args);
    }
  }

  private readCell(ref: string): string {
    const key = ref.replace(/\$/g, '').toUpperCase();
    if (this.visited.has(key)) throw new FormulaCalcError('#REF!');
    const cell = this.cells[key];
    if (!cell) return '';
    if (cell.formula) {
      // Backtrack on the shared visited set instead of cloning it per cell:
      // add before descending, delete on the way out (finally covers throws).
      this.visited.add(key);
      try {
        const out = evaluateFormula(cell.formula, this.cells, this.visited);
        if (FORMULA_ERROR_CODES.has(out)) throw new FormulaCalcError(out);
        return out;
      } finally {
        this.visited.delete(key);
      }
    }
    return cell.value;
  }

  private scalar(value: FormulaValue): FormulaScalar {
    if (!isFormulaRange(value)) return value;
    if (value.refs.length === 1 && value.refs[0].length === 1) return this.readCell(value.refs[0][0]);
    throw new FormulaCalcError('#VALUE!');
  }

  private toNumber(value: FormulaScalar): number {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new FormulaCalcError('#NUM!');
      return value;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    const raw = value.trim();
    if (!raw) return 0;
    const pct = raw.endsWith('%');
    const n = Number((pct ? raw.slice(0, -1) : raw).replace(/,/g, ''));
    if (!Number.isFinite(n)) throw new FormulaCalcError('#VALUE!');
    return pct ? n / 100 : n;
  }

  private tryNumber(value: FormulaScalar): number | null {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const raw = value.trim();
    if (!raw) return null;
    const n = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(n) ? n : null;
  }

  private toBool(value: FormulaScalar): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const raw = value.trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false' || raw === '') return false;
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) return n !== 0;
    throw new FormulaCalcError('#VALUE!');
  }

  private num(node: FormulaNode): number {
    return this.toNumber(this.scalar(this.value(node)));
  }

  private text(node: FormulaNode): string {
    const value = this.scalar(this.value(node));
    if (typeof value === 'number') return formulaNumberToText(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return value;
  }

  private bool(node: FormulaNode): boolean {
    return this.toBool(this.scalar(this.value(node)));
  }

  private binary(op: string, leftNode: FormulaNode, rightNode: FormulaNode): FormulaValue {
    if (op === '&') return this.text(leftNode) + this.text(rightNode);
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      return this.compare(op, this.scalar(this.value(leftNode)), this.scalar(this.value(rightNode)));
    }
    const left = this.num(leftNode);
    const right = this.num(rightNode);
    switch (op) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/':
        if (right === 0) throw new FormulaCalcError('#DIV/0!');
        return left / right;
      case '^': return Math.pow(left, right);
    }
    throw new FormulaCalcError('#VALUE!');
  }

  private compare(op: string, left: FormulaScalar, right: FormulaScalar): boolean {
    const ln = this.tryNumber(left);
    const rn = this.tryNumber(right);
    let l: number | string;
    let r: number | string;
    if (ln !== null && rn !== null) {
      l = ln;
      r = rn;
    } else {
      l = String(left).trim().toLowerCase();
      r = String(right).trim().toLowerCase();
    }
    switch (op) {
      case '=': return l === r;
      case '<>': return l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '<=': return l <= r;
      case '>=': return l >= r;
    }
    throw new FormulaCalcError('#VALUE!');
  }

  private eqValues(left: FormulaScalar, right: FormulaScalar): boolean {
    return this.compare('=', left, right);
  }

  private maxDataRow(): number {
    if (this.maxRowCache === null) {
      let max = 0;
      for (const key of Object.keys(this.cells)) {
        const parsed = parseCellRef(key);
        if (parsed && parsed.row > max) max = parsed.row;
      }
      this.maxRowCache = max;
    }
    return this.maxRowCache;
  }

  private buildRange(from: string, to: string): FormulaRangeValue {
    const start = parseCellRef(from.replace(/\$/g, '').toUpperCase());
    const end = parseCellRef(to.replace(/\$/g, '').toUpperCase());
    if (!start || !end) throw new FormulaCalcError('#REF!');
    const minRow = Math.min(start.row, end.row);
    const maxRow = Math.max(start.row, end.row);
    const minCol = Math.min(start.col, end.col);
    const maxCol = Math.max(start.col, end.col);
    if ((maxRow - minRow + 1) * (maxCol - minCol + 1) > 200000) throw new FormulaCalcError('#VALUE!');
    const refs: string[][] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const row: string[] = [];
      for (let c = minCol; c <= maxCol; c++) row.push(cellRef(c, r));
      refs.push(row);
    }
    return { rng: true, refs };
  }

  private buildColRange(from: string, to: string): FormulaRangeValue {
    const startCol = letterToCol(from.replace(/\$/g, '').toUpperCase());
    const endCol = letterToCol(to.replace(/\$/g, '').toUpperCase());
    const maxRow = this.maxDataRow();
    return this.buildRange(cellRef(Math.min(startCol, endCol), 0), cellRef(Math.max(startCol, endCol), maxRow));
  }

  private isRangeNode(node: FormulaNode): boolean {
    return node.t === 'range' || node.t === 'colrange' || node.t === 'ref';
  }

  /** Flat cell refs for a range-like argument (single ref counts as 1×1). */
  private flatRefs(node: FormulaNode): string[] {
    if (node.t === 'ref') return [node.ref.replace(/\$/g, '').toUpperCase()];
    const value = this.value(node);
    if (isFormulaRange(value)) return value.refs.flat();
    throw new FormulaCalcError('#VALUE!');
  }

  /** rows × cols ref matrix for table-shaped arguments (VLOOKUP/INDEX). */
  private refMatrix(node: FormulaNode): string[][] {
    if (node.t === 'ref') return [[node.ref.replace(/\$/g, '').toUpperCase()]];
    const value = this.value(node);
    if (isFormulaRange(value)) return value.refs;
    throw new FormulaCalcError('#VALUE!');
  }

  /** Numbers across scalar and range arguments; blank/text range cells are skipped. */
  private collectNumbers(args: FormulaNode[]): number[] {
    const out: number[] = [];
    for (const arg of args) {
      if (this.isRangeNode(arg)) {
        for (const ref of this.flatRefs(arg)) {
          const raw = this.readCell(ref).trim();
          if (!raw) continue;
          const n = Number(raw.replace(/,/g, ''));
          if (Number.isFinite(n)) out.push(n);
        }
      } else {
        out.push(this.num(arg));
      }
    }
    return out;
  }

  /** Scalar-or-range args flattened to display strings (TEXTJOIN/CONCAT). */
  private collectTexts(args: FormulaNode[]): string[] {
    const out: string[] = [];
    for (const arg of args) {
      if (this.isRangeNode(arg)) {
        for (const ref of this.flatRefs(arg)) out.push(this.readCell(ref));
      } else {
        out.push(this.text(arg));
      }
    }
    return out;
  }

  /** Boolean mask over `refs` for criteria-pair functions (SUMIFS family). */
  private criteriaMask(refs: string[], criteriaNode: FormulaNode): boolean[] {
    const criteria = this.text(criteriaNode);
    return refs.map((ref) => matchesFormulaCriteria(this.readCell(ref), criteria));
  }

  private cellNumberAt(ref: string | undefined): number | null {
    if (!ref) return null;
    const raw = this.readCell(ref).trim();
    if (!raw) return null;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  /** SUMIFS-family shared core: value range + (criteria range, criteria) pairs. */
  private multiCriteriaValues(valueRefs: string[] | null, pairs: FormulaNode[]): number[][] {
    if (pairs.length === 0 || pairs.length % 2 !== 0) throw new FormulaCalcError('#VALUE!');
    let mask: boolean[] | null = null;
    let length = valueRefs ? valueRefs.length : -1;
    const criteriaRefsList: string[][] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const refs = this.flatRefs(pairs[i]);
      if (length === -1) length = refs.length;
      criteriaRefsList.push(refs);
      const pairMask = this.criteriaMask(refs, pairs[i + 1]);
      mask = mask ? mask.map((m, idx) => m && (pairMask[idx] ?? false)) : pairMask;
    }
    const rows: number[][] = [];
    for (let idx = 0; idx < length; idx++) {
      if (!mask?.[idx]) continue;
      if (!valueRefs) {
        rows.push([idx]);
        continue;
      }
      const n = this.cellNumberAt(valueRefs[idx]);
      if (n !== null) rows.push([idx, n]);
    }
    return rows;
  }

  private applyTextFormat(value: FormulaScalar, format: string): string {
    if (/[ymd]/i.test(format) && !/[#0]/.test(format)) {
      const date = parseFormulaDate(value);
      return format
        .replace(/yyyy/gi, String(date.getFullYear()))
        .replace(/yy/gi, formulaPad2(date.getFullYear() % 100))
        .replace(/mm/gi, formulaPad2(date.getMonth() + 1))
        .replace(/m(?![a-z])/gi, String(date.getMonth() + 1))
        .replace(/dd/gi, formulaPad2(date.getDate()))
        .replace(/d(?![a-z])/gi, String(date.getDate()));
    }
    const percent = format.includes('%');
    const decimals = (format.split('.')[1]?.match(/0/g) || []).length;
    const grouping = format.includes(',');
    let n = this.toNumber(value);
    if (percent) n *= 100;
    let out = n.toFixed(decimals);
    if (grouping) {
      const [whole, frac] = out.split('.');
      out = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
    }
    const currency = format.match(/^([$€£¥₩])/);
    if (currency) out = currency[1] + out;
    return percent ? `${out}%` : out;
  }

  private call(name: string, args: FormulaNode[]): FormulaValue {
    const argAt = (idx: number): FormulaNode => {
      const node = args[idx];
      if (!node) throw new FormulaCalcError('#VALUE!');
      return node;
    };
    switch (name) {
      // ── Math & statistics ──
      case 'SUM': return this.collectNumbers(args).reduce((a, b) => a + b, 0);
      case 'PRODUCT': return this.collectNumbers(args).reduce((a, b) => a * b, 1);
      case 'AVERAGE': {
        const nums = this.collectNumbers(args);
        if (!nums.length) throw new FormulaCalcError('#DIV/0!');
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      }
      case 'COUNT': return this.collectNumbers(args).length;
      case 'COUNTA': {
        let count = 0;
        for (const arg of args) {
          if (this.isRangeNode(arg)) {
            for (const ref of this.flatRefs(arg)) if (this.readCell(ref).trim()) count++;
          } else if (String(this.scalar(this.value(arg))).trim()) {
            count++;
          }
        }
        return count;
      }
      case 'COUNTBLANK': {
        let count = 0;
        for (const ref of this.flatRefs(argAt(0))) if (!this.readCell(ref).trim()) count++;
        return count;
      }
      case 'MIN': {
        const nums = this.collectNumbers(args);
        return nums.length ? Math.min(...nums) : 0;
      }
      case 'MAX': {
        const nums = this.collectNumbers(args);
        return nums.length ? Math.max(...nums) : 0;
      }
      case 'MEDIAN': {
        const nums = this.collectNumbers(args).sort((a, b) => a - b);
        if (!nums.length) throw new FormulaCalcError('#NUM!');
        const mid = Math.floor(nums.length / 2);
        return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
      }
      case 'STDEV':
      case 'STDEV.S':
      case 'VAR':
      case 'VAR.S':
      case 'STDEVP':
      case 'STDEV.P':
      case 'VARP':
      case 'VAR.P': {
        const nums = this.collectNumbers(args);
        const population = name.includes('P');
        if (nums.length < (population ? 1 : 2)) throw new FormulaCalcError('#DIV/0!');
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (population ? nums.length : nums.length - 1);
        return name.startsWith('VAR') ? variance : Math.sqrt(variance);
      }
      case 'LARGE':
      case 'SMALL': {
        const nums = this.collectNumbers([argAt(0)]).sort((a, b) => (name === 'LARGE' ? b - a : a - b));
        const k = Math.trunc(this.num(argAt(1)));
        if (k < 1 || k > nums.length) throw new FormulaCalcError('#NUM!');
        return nums[k - 1];
      }
      case 'RANK':
      case 'RANK.EQ': {
        const target = this.num(argAt(0));
        const nums = this.collectNumbers([argAt(1)]);
        const ascending = args[2] ? this.bool(args[2]) : false;
        const sorted = [...nums].sort((a, b) => (ascending ? a - b : b - a));
        const idx = sorted.indexOf(target);
        if (idx < 0) throw new FormulaCalcError('#N/A');
        return idx + 1;
      }
      case 'SUMPRODUCT': {
        const matrices = args.map((arg) => this.flatRefs(arg));
        const length = matrices[0]?.length || 0;
        if (matrices.some((m) => m.length !== length)) throw new FormulaCalcError('#VALUE!');
        let total = 0;
        for (let i = 0; i < length; i++) {
          let product = 1;
          for (const refs of matrices) product *= this.cellNumberAt(refs[i]) ?? 0;
          total += product;
        }
        return total;
      }
      case 'ABS': return Math.abs(this.num(argAt(0)));
      case 'SIGN': return Math.sign(this.num(argAt(0)));
      case 'SQRT': {
        const n = this.num(argAt(0));
        if (n < 0) throw new FormulaCalcError('#NUM!');
        return Math.sqrt(n);
      }
      case 'POWER': return Math.pow(this.num(argAt(0)), this.num(argAt(1)));
      case 'EXP': return Math.exp(this.num(argAt(0)));
      case 'LN': {
        const n = this.num(argAt(0));
        if (n <= 0) throw new FormulaCalcError('#NUM!');
        return Math.log(n);
      }
      case 'LOG': {
        const n = this.num(argAt(0));
        const base = args[1] ? this.num(args[1]) : 10;
        if (n <= 0 || base <= 0 || base === 1) throw new FormulaCalcError('#NUM!');
        return Math.log(n) / Math.log(base);
      }
      case 'LOG10': {
        const n = this.num(argAt(0));
        if (n <= 0) throw new FormulaCalcError('#NUM!');
        return Math.log10(n);
      }
      case 'PI': return Math.PI;
      case 'RAND': return Math.random();
      case 'RANDBETWEEN': {
        const lo = Math.ceil(this.num(argAt(0)));
        const hi = Math.floor(this.num(argAt(1)));
        if (hi < lo) throw new FormulaCalcError('#NUM!');
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      }
      case 'MOD': {
        const n = this.num(argAt(0));
        const d = this.num(argAt(1));
        if (d === 0) throw new FormulaCalcError('#DIV/0!');
        return ((n % d) + d) % d;
      }
      case 'INT': return Math.floor(this.num(argAt(0)));
      case 'TRUNC': {
        const digits = args[1] ? Math.trunc(this.num(args[1])) : 0;
        const factor = Math.pow(10, digits);
        return Math.trunc(this.num(argAt(0)) * factor) / factor;
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        const n = this.num(argAt(0));
        const digits = args[1] ? Math.trunc(this.num(args[1])) : 0;
        const factor = Math.pow(10, digits);
        const scaled = n * factor;
        const rounded =
          name === 'ROUND' ? Math.round(scaled)
          : name === 'ROUNDUP' ? Math.sign(scaled) * Math.ceil(Math.abs(scaled))
          : Math.sign(scaled) * Math.floor(Math.abs(scaled));
        return rounded / factor;
      }
      case 'CEILING':
      case 'CEILING.MATH':
      case 'FLOOR':
      case 'FLOOR.MATH': {
        const n = this.num(argAt(0));
        const significance = args[1] ? this.num(args[1]) : 1;
        if (significance === 0) return 0;
        const ratio = n / significance;
        return (name.startsWith('CEILING') ? Math.ceil(ratio) : Math.floor(ratio)) * significance;
      }

      // ── Logic & information ──
      case 'IF': {
        const cond = this.bool(argAt(0));
        if (cond) return args[1] !== undefined ? this.scalar(this.value(args[1])) : 0;
        return args[2] !== undefined ? this.scalar(this.value(args[2])) : '';
      }
      case 'IFS': {
        for (let i = 0; i + 1 < args.length; i += 2) {
          if (this.bool(args[i])) return this.scalar(this.value(args[i + 1]));
        }
        throw new FormulaCalcError('#N/A');
      }
      case 'SWITCH': {
        const subject = this.scalar(this.value(argAt(0)));
        let i = 1;
        for (; i + 1 < args.length; i += 2) {
          if (this.eqValues(subject, this.scalar(this.value(args[i])))) return this.scalar(this.value(args[i + 1]));
        }
        if (i < args.length) return this.scalar(this.value(args[i]));
        throw new FormulaCalcError('#N/A');
      }
      case 'AND':
      case 'OR':
      case 'XOR': {
        const bools: boolean[] = [];
        for (const arg of args) {
          if (this.isRangeNode(arg)) {
            for (const ref of this.flatRefs(arg)) {
              const raw = this.readCell(ref).trim();
              if (!raw) continue;
              try {
                bools.push(this.toBool(raw));
              } catch {
                // Excel ignores non-boolean text inside ranges
              }
            }
          } else {
            bools.push(this.bool(arg));
          }
        }
        if (!bools.length) throw new FormulaCalcError('#VALUE!');
        if (name === 'AND') return bools.every(Boolean);
        if (name === 'OR') return bools.some(Boolean);
        return bools.filter(Boolean).length % 2 === 1;
      }
      case 'NOT': return !this.bool(argAt(0));
      case 'TRUE': return true;
      case 'FALSE': return false;
      case 'IFERROR':
      case 'IFNA': {
        try {
          return this.scalar(this.value(argAt(0)));
        } catch (error) {
          if (!(error instanceof FormulaCalcError)) throw error;
          if (name === 'IFNA' && error.code !== '#N/A') throw error;
          return args[1] !== undefined ? this.scalar(this.value(args[1])) : '';
        }
      }
      case 'ISERROR':
      case 'ISERR':
      case 'ISNA': {
        try {
          this.scalar(this.value(argAt(0)));
          return false;
        } catch (error) {
          if (!(error instanceof FormulaCalcError)) throw error;
          if (name === 'ISNA') return error.code === '#N/A';
          if (name === 'ISERR') return error.code !== '#N/A';
          return true;
        }
      }
      case 'ISBLANK': {
        const node = argAt(0);
        if (node.t === 'ref') return this.readCell(node.ref) === '';
        return String(this.scalar(this.value(node))) === '';
      }
      case 'ISNUMBER': {
        const value = this.scalar(this.value(argAt(0)));
        if (typeof value === 'number') return true;
        if (typeof value === 'boolean') return false;
        const raw = value.trim();
        return raw !== '' && Number.isFinite(Number(raw.replace(/,/g, '')));
      }
      case 'ISTEXT': {
        const value = this.scalar(this.value(argAt(0)));
        if (typeof value !== 'string') return false;
        const raw = value.trim();
        return raw !== '' && !Number.isFinite(Number(raw.replace(/,/g, '')));
      }
      case 'ISLOGICAL': {
        const value = this.scalar(this.value(argAt(0)));
        if (typeof value === 'boolean') return true;
        const raw = String(value).trim().toLowerCase();
        return raw === 'true' || raw === 'false';
      }

      // ── Text ──
      case 'CONCAT':
      case 'CONCATENATE': return this.collectTexts(args).join('');
      case 'TEXTJOIN': {
        const delimiter = this.text(argAt(0));
        const ignoreEmpty = this.bool(argAt(1));
        const items = this.collectTexts(args.slice(2));
        return (ignoreEmpty ? items.filter((item) => item.trim() !== '') : items).join(delimiter);
      }
      case 'LEFT': return this.text(argAt(0)).substring(0, args[1] ? Math.trunc(this.num(args[1])) : 1);
      case 'RIGHT': {
        const value = this.text(argAt(0));
        const n = args[1] ? Math.trunc(this.num(args[1])) : 1;
        return n >= value.length ? value : value.substring(value.length - n);
      }
      case 'MID': {
        const value = this.text(argAt(0));
        const start = Math.trunc(this.num(argAt(1)));
        const n = Math.trunc(this.num(argAt(2)));
        if (start < 1 || n < 0) throw new FormulaCalcError('#VALUE!');
        return value.substring(start - 1, start - 1 + n);
      }
      case 'LEN': return this.text(argAt(0)).length;
      case 'TRIM': return this.text(argAt(0)).replace(/\s+/g, ' ').trim();
      case 'CLEAN': return this.text(argAt(0)).replace(/[\x00-\x1f\x7f]/g, '');
      case 'UPPER': return this.text(argAt(0)).toUpperCase();
      case 'LOWER': return this.text(argAt(0)).toLowerCase();
      case 'PROPER':
        return this.text(argAt(0)).toLowerCase().replace(/(^|[^A-Za-z'])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
      case 'SUBSTITUTE': {
        const value = this.text(argAt(0));
        const oldText = this.text(argAt(1));
        const newText = this.text(argAt(2));
        if (!oldText) return value;
        if (args[3] !== undefined) {
          const instance = Math.trunc(this.num(args[3]));
          if (instance < 1) throw new FormulaCalcError('#VALUE!');
          let idx = -1;
          for (let found = 0; found < instance; found++) {
            idx = value.indexOf(oldText, idx + 1);
            if (idx < 0) return value;
          }
          return value.slice(0, idx) + newText + value.slice(idx + oldText.length);
        }
        return value.split(oldText).join(newText);
      }
      case 'REPLACE': {
        const value = this.text(argAt(0));
        const start = Math.trunc(this.num(argAt(1)));
        const count = Math.trunc(this.num(argAt(2)));
        if (start < 1 || count < 0) throw new FormulaCalcError('#VALUE!');
        return value.slice(0, start - 1) + this.text(argAt(3)) + value.slice(start - 1 + count);
      }
      case 'REPT': {
        const count = Math.trunc(this.num(argAt(1)));
        if (count < 0 || count > 32767) throw new FormulaCalcError('#VALUE!');
        return this.text(argAt(0)).repeat(count);
      }
      case 'FIND':
      case 'SEARCH': {
        const needle = this.text(argAt(0));
        const haystack = this.text(argAt(1));
        const start = args[2] ? Math.trunc(this.num(args[2])) : 1;
        if (start < 1) throw new FormulaCalcError('#VALUE!');
        const idx = name === 'FIND'
          ? haystack.indexOf(needle, start - 1)
          : haystack.toLowerCase().indexOf(needle.toLowerCase(), start - 1);
        if (idx < 0) throw new FormulaCalcError('#VALUE!');
        return idx + 1;
      }
      case 'EXACT': return this.text(argAt(0)) === this.text(argAt(1));
      case 'VALUE': return this.num(argAt(0));
      case 'T': {
        const value = this.scalar(this.value(argAt(0)));
        return typeof value === 'string' && !Number.isFinite(Number(value.trim())) ? value : '';
      }
      case 'CHAR': return String.fromCharCode(Math.trunc(this.num(argAt(0))));
      case 'CODE': {
        const value = this.text(argAt(0));
        if (!value) throw new FormulaCalcError('#VALUE!');
        return value.charCodeAt(0);
      }
      case 'TEXT': return this.applyTextFormat(this.scalar(this.value(argAt(0))), this.text(argAt(1)));

      // ── Date & time ──
      case 'TODAY': return formulaDateToIso(new Date());
      case 'NOW': {
        const now = new Date();
        return `${formulaDateToIso(now)} ${formulaPad2(now.getHours())}:${formulaPad2(now.getMinutes())}`;
      }
      case 'DATE': {
        const date = new Date(Math.trunc(this.num(argAt(0))), Math.trunc(this.num(argAt(1))) - 1, Math.trunc(this.num(argAt(2))));
        return formulaDateToIso(date);
      }
      case 'YEAR': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getFullYear();
      case 'MONTH': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getMonth() + 1;
      case 'DAY': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getDate();
      case 'HOUR': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getHours();
      case 'MINUTE': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getMinutes();
      case 'SECOND': return parseFormulaDate(this.scalar(this.value(argAt(0)))).getSeconds();
      case 'WEEKDAY': {
        const date = parseFormulaDate(this.scalar(this.value(argAt(0))));
        const type = args[1] ? Math.trunc(this.num(args[1])) : 1;
        const sundayFirst = date.getDay() + 1;             // 1 (Sun) … 7 (Sat)
        if (type === 1) return sundayFirst;
        if (type === 2) return date.getDay() === 0 ? 7 : date.getDay(); // 1 (Mon) … 7 (Sun)
        if (type === 3) return date.getDay() === 0 ? 6 : date.getDay() - 1; // 0 (Mon) … 6 (Sun)
        throw new FormulaCalcError('#NUM!');
      }
      case 'EDATE':
      case 'EOMONTH': {
        const date = parseFormulaDate(this.scalar(this.value(argAt(0))));
        const months = Math.trunc(this.num(argAt(1)));
        if (name === 'EOMONTH') return formulaDateToIso(new Date(date.getFullYear(), date.getMonth() + months + 1, 0));
        const day = date.getDate();
        const moved = new Date(date.getFullYear(), date.getMonth() + months, 1);
        const lastDay = new Date(moved.getFullYear(), moved.getMonth() + 1, 0).getDate();
        moved.setDate(Math.min(day, lastDay));
        return formulaDateToIso(moved);
      }
      case 'DAYS': {
        const end = parseFormulaDate(this.scalar(this.value(argAt(0))));
        const start = parseFormulaDate(this.scalar(this.value(argAt(1))));
        return Math.round((end.getTime() - start.getTime()) / 86400000);
      }
      case 'DATEDIF': {
        const start = parseFormulaDate(this.scalar(this.value(argAt(0))));
        const end = parseFormulaDate(this.scalar(this.value(argAt(1))));
        if (end.getTime() < start.getTime()) throw new FormulaCalcError('#NUM!');
        const unit = this.text(argAt(2)).toUpperCase();
        if (unit === 'D') return Math.floor((end.getTime() - start.getTime()) / 86400000);
        let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
        if (end.getDate() < start.getDate()) months--;
        if (unit === 'M') return months;
        if (unit === 'Y') return Math.floor(months / 12);
        throw new FormulaCalcError('#NUM!');
      }
      case 'NETWORKDAYS': {
        const start = parseFormulaDate(this.scalar(this.value(argAt(0))));
        const end = parseFormulaDate(this.scalar(this.value(argAt(1))));
        const step = end.getTime() >= start.getTime() ? 1 : -1;
        let count = 0;
        const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
        while (step > 0 ? cursor.getTime() <= last.getTime() : cursor.getTime() >= last.getTime()) {
          const day = cursor.getDay();
          if (day !== 0 && day !== 6) count++;
          cursor.setDate(cursor.getDate() + step);
        }
        return count * step;
      }

      // ── Lookup & reference ──
      case 'VLOOKUP':
      case 'HLOOKUP': {
        const target = this.scalar(this.value(argAt(0)));
        const matrix = name === 'HLOOKUP'
          ? this.refMatrix(argAt(1))[0]?.map((_, colIdx) => this.refMatrix(argAt(1)).map((row) => row[colIdx])) || []
          : this.refMatrix(argAt(1));
        const returnIdx = Math.trunc(this.num(argAt(2)));
        const approximate = args[3] !== undefined && this.bool(args[3]);
        if (returnIdx < 1) throw new FormulaCalcError('#VALUE!');
        let bestRow: string[] | null = null;
        for (const row of matrix) {
          const keyRaw = this.readCell(row[0]);
          if (approximate) {
            const keyNum = this.tryNumber(keyRaw);
            const targetNum = this.tryNumber(target);
            if (keyNum !== null && targetNum !== null && keyNum <= targetNum) bestRow = row;
          } else if (this.eqValues(keyRaw, target)) {
            bestRow = row;
            break;
          }
        }
        if (!bestRow) throw new FormulaCalcError('#N/A');
        const resultRef = bestRow[returnIdx - 1];
        if (!resultRef) throw new FormulaCalcError('#REF!');
        return this.readCell(resultRef);
      }
      case 'XLOOKUP': {
        const target = this.scalar(this.value(argAt(0)));
        const lookupRefs = this.flatRefs(argAt(1));
        const returnRefs = this.flatRefs(argAt(2));
        const length = Math.min(lookupRefs.length, returnRefs.length);
        for (let i = 0; i < length; i++) {
          if (this.eqValues(this.readCell(lookupRefs[i]), target)) return this.readCell(returnRefs[i]);
        }
        if (args[3] !== undefined) return this.scalar(this.value(args[3]));
        throw new FormulaCalcError('#N/A');
      }
      case 'INDEX': {
        const matrix = this.refMatrix(argAt(0));
        let rowIdx = Math.trunc(this.num(argAt(1)));
        let colIdx = args[2] !== undefined ? Math.trunc(this.num(args[2])) : 1;
        // Vector form: INDEX(A1:D1, n) indexes along the single row.
        if (matrix.length === 1 && args[2] === undefined) {
          colIdx = rowIdx;
          rowIdx = 1;
        }
        const ref = matrix[rowIdx - 1]?.[colIdx - 1];
        if (!ref) throw new FormulaCalcError('#REF!');
        return this.readCell(ref);
      }
      case 'MATCH': {
        const target = this.scalar(this.value(argAt(0)));
        const refs = this.flatRefs(argAt(1));
        const matchType = args[2] !== undefined ? Math.trunc(this.num(args[2])) : 1;
        if (matchType === 0) {
          const idx = refs.findIndex((ref) => this.eqValues(this.readCell(ref), target));
          if (idx < 0) throw new FormulaCalcError('#N/A');
          return idx + 1;
        }
        const targetNum = this.tryNumber(target);
        if (targetNum === null) throw new FormulaCalcError('#N/A');
        let best = -1;
        for (let i = 0; i < refs.length; i++) {
          const n = this.cellNumberAt(refs[i]);
          if (n === null) continue;
          if (matchType > 0 ? n <= targetNum : n >= targetNum) best = i;
        }
        if (best < 0) throw new FormulaCalcError('#N/A');
        return best + 1;
      }
      case 'CHOOSE': {
        const idx = Math.trunc(this.num(argAt(0)));
        if (idx < 1 || idx >= args.length) throw new FormulaCalcError('#VALUE!');
        return this.scalar(this.value(args[idx]));
      }
      case 'ROW':
      case 'COLUMN': {
        const node = argAt(0);
        const refs = this.isRangeNode(node) ? this.flatRefs(node) : null;
        const parsed = refs?.[0] ? parseCellRef(refs[0]) : null;
        if (!parsed) throw new FormulaCalcError('#VALUE!');
        return name === 'ROW' ? parsed.row + 1 : parsed.col + 1;
      }
      case 'ROWS': return this.refMatrix(argAt(0)).length;
      case 'COLUMNS': return this.refMatrix(argAt(0))[0]?.length || 0;

      // ── Conditional aggregation ──
      case 'SUMIF':
      case 'AVERAGEIF': {
        const criteriaRefs = this.flatRefs(argAt(0));
        const valueRefs = args[2] !== undefined ? this.flatRefs(args[2]) : criteriaRefs;
        const mask = this.criteriaMask(criteriaRefs, argAt(1));
        const values: number[] = [];
        mask.forEach((matched, idx) => {
          if (!matched) return;
          const n = this.cellNumberAt(valueRefs[idx]);
          if (n !== null) values.push(n);
        });
        if (name === 'AVERAGEIF') {
          if (!values.length) throw new FormulaCalcError('#DIV/0!');
          return values.reduce((a, b) => a + b, 0) / values.length;
        }
        return values.reduce((a, b) => a + b, 0);
      }
      case 'COUNTIF': {
        return this.criteriaMask(this.flatRefs(argAt(0)), argAt(1)).filter(Boolean).length;
      }
      case 'COUNTIFS': {
        return this.multiCriteriaValues(null, args).length;
      }
      case 'SUMIFS':
      case 'AVERAGEIFS':
      case 'MINIFS':
      case 'MAXIFS': {
        const valueRefs = this.flatRefs(argAt(0));
        const rows = this.multiCriteriaValues(valueRefs, args.slice(1));
        const values = rows.map(([, n]) => n);
        if (name === 'SUMIFS') return values.reduce((a, b) => a + b, 0);
        if (!values.length) {
          if (name === 'AVERAGEIFS') throw new FormulaCalcError('#DIV/0!');
          return 0;
        }
        if (name === 'AVERAGEIFS') return values.reduce((a, b) => a + b, 0) / values.length;
        return name === 'MINIFS' ? Math.min(...values) : Math.max(...values);
      }

      default:
        throw new FormulaCalcError('#NAME?');
    }
  }
}

export function evaluateFormula(formula: string, cells: Record<string, CellData>, visited: Set<string> = new Set()): string {
  const expr = (formula.startsWith('=') ? formula.slice(1) : formula).trim();
  if (!expr) return '';
  const tokens = tokenizeFormula(expr);
  if (!tokens || tokens.length === 0) return '#VALUE!';
  try {
    const node = parseFormulaTokens(tokens);
    const evaluator = new FormulaEvaluator(cells, visited);
    return evaluator.display(evaluator.value(node));
  } catch (error) {
    return error instanceof FormulaCalcError ? error.code : '#VALUE!';
  }
}

/**
 * Shift relative cell references in a formula by (dCol, dRow), the way Excel
 * rewrites formulas on copy/paste and fill. `$`-anchored parts stay pinned,
 * string literals are untouched, and function names (LOG10, ROUNDUP…) are
 * left alone. References pushed off the sheet become #REF!.
 */
export function adjustFormulaReferences(formula: string, dCol: number, dRow: number): string {
  if (dCol === 0 && dRow === 0) return formula;
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === '"' && formula[j + 1] === '"') { j += 2; continue; }
        if (formula[j] === '"') break;
        j++;
      }
      out += formula.slice(i, Math.min(j + 1, formula.length));
      i = Math.min(j + 1, formula.length);
      continue;
    }
    const prev = out[out.length - 1] || '';
    const match = formula.slice(i).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
    if (match && !/[A-Za-z0-9_.$]/.test(prev)) {
      const after = formula[i + match[0].length] || '';
      if (!/[A-Za-z0-9_(]/.test(after)) {
        const [token, colAbs, colLetters, rowAbs, rowDigits] = match;
        let col = letterToCol(colLetters.toUpperCase());
        let row = parseInt(rowDigits, 10) - 1;
        if (!colAbs) col += dCol;
        if (!rowAbs) row += dRow;
        i += token.length;
        out += col < 0 || row < 0 ? '#REF!' : `${colAbs}${colToLetter(col)}${rowAbs}${row + 1}`;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrite cell references in a formula after a row/column insert or delete.
 * Excel semantics: insert shifts every reference past the edit point (absolute
 * `$` refs included — `$` only pins during copy/fill, not structural edits);
 * delete turns references to the removed row/col into #REF!, except range
 * endpoints, which clamp so `A1:A10` minus row 10 becomes `A1:A9`.
 */
export function adjustFormulaAxisEdit(
  formula: string,
  axis: 'row' | 'col',
  op: 'insert' | 'delete',
  idx: number,
): string {
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === '"' && formula[j + 1] === '"') { j += 2; continue; }
        if (formula[j] === '"') break;
        j++;
      }
      out += formula.slice(i, Math.min(j + 1, formula.length));
      i = Math.min(j + 1, formula.length);
      continue;
    }
    const prev = out[out.length - 1] || '';
    const match = formula.slice(i).match(/^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/);
    if (match && !/[A-Za-z0-9_.$]/.test(prev)) {
      const after = formula[i + match[0].length] || '';
      if (!/[A-Za-z0-9_(]/.test(after)) {
        const [token, colAbs, colLetters, rowAbs, rowDigits] = match;
        let col = letterToCol(colLetters.toUpperCase());
        let row = parseInt(rowDigits, 10) - 1;
        let dead = false;
        const map = (v: number): number => {
          if (op === 'insert') return v > idx ? v + 1 : v;
          if (v === idx) { dead = true; return v; }
          return v > idx ? v - 1 : v;
        };
        if (axis === 'row') row = map(row); else col = map(col);
        if (dead) {
          const isRangeEnd = prev === ':';
          const isRangeStart = after === ':';
          if (isRangeEnd) {
            // Shrink the range end onto the previous row/col.
            if (axis === 'row') row = Math.max(0, idx - 1); else col = Math.max(0, idx - 1);
            dead = false;
          } else if (isRangeStart) {
            // The next row/col slides into the deleted slot — keep the index.
            dead = false;
          }
        }
        i += token.length;
        out += dead ? '#REF!' : `${colAbs}${colToLetter(col)}${rowAbs}${row + 1}`;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Shift row/col-keyed sheet metadata (custom sizes, merges, conditional-format
 * ranges, frozen panes) after an insert/delete. Cells were remapped but this
 * metadata was not, which left tall rows on the wrong data, visually corrupted
 * merged spans, and stale conditional ranges.
 */
export function remapSheetMetaAxis(
  sheet: Pick<SheetData, 'rowHeights' | 'colWidths' | 'merges' | 'conditionalRules' | 'frozenRows' | 'frozenCols'>,
  axis: 'row' | 'col',
  op: 'insert' | 'delete',
  idx: number,
): Partial<SheetData> {
  const shiftIndex = (v: number): number | null => {
    if (op === 'insert') return v > idx ? v + 1 : v;
    if (v === idx) return null;
    return v > idx ? v - 1 : v;
  };
  // Range boundaries: on delete, a start at idx stays (next row slides in) and
  // an end at idx shrinks by one; insert inside a span grows it (Excel).
  const shiftStart = (v: number): number => {
    if (op === 'insert') return v > idx ? v + 1 : v;
    return v > idx ? v - 1 : v;
  };
  const shiftEnd = (v: number): number => {
    if (op === 'insert') return v > idx ? v + 1 : v;
    return v >= idx ? v - 1 : v;
  };

  const out: Partial<SheetData> = {};

  const sizes = axis === 'row' ? sheet.rowHeights : sheet.colWidths;
  const remapped: Record<number, number> = {};
  for (const [k, v] of Object.entries(sizes || {})) {
    const n = shiftIndex(Number(k));
    if (n != null) remapped[n] = v;
  }
  if (axis === 'row') out.rowHeights = remapped; else out.colWidths = remapped;

  if (sheet.merges?.length) {
    out.merges = sheet.merges
      .map((m) => (axis === 'row'
        ? { ...m, startRow: shiftStart(m.startRow), endRow: shiftEnd(m.endRow) }
        : { ...m, startCol: shiftStart(m.startCol), endCol: shiftEnd(m.endCol) }))
      .filter((m) => m.endRow >= m.startRow && m.endCol >= m.startCol
        && (m.endRow > m.startRow || m.endCol > m.startCol));
  }

  if (sheet.conditionalRules?.length) {
    out.conditionalRules = sheet.conditionalRules.map((rule) => {
      const [a, b] = rule.range.split(':');
      const pa = parseCellRef(a);
      const pb = parseCellRef(b || a);
      if (!pa || !pb) return rule;
      const s = axis === 'row' ? shiftStart(pa.row) : pa.row;
      const e = axis === 'row' ? shiftEnd(pb.row) : pb.row;
      const sc = axis === 'col' ? shiftStart(pa.col) : pa.col;
      const ec = axis === 'col' ? shiftEnd(pb.col) : pb.col;
      if (e < s || ec < sc) return rule;
      return { ...rule, range: `${cellRef(sc, s)}:${cellRef(ec, e)}` };
    });
  }

  // Frozen panes: edits above/left of the freeze line move the line with them.
  if (axis === 'row' && sheet.frozenRows) {
    if (op === 'insert' && idx < sheet.frozenRows) out.frozenRows = sheet.frozenRows + 1;
    if (op === 'delete' && idx < sheet.frozenRows) out.frozenRows = Math.max(0, sheet.frozenRows - 1);
  }
  if (axis === 'col' && sheet.frozenCols) {
    if (op === 'insert' && idx < sheet.frozenCols) out.frozenCols = sheet.frozenCols + 1;
    if (op === 'delete' && idx < sheet.frozenCols) out.frozenCols = Math.max(0, sheet.frozenCols - 1);
  }

  return out;
}

/**
 * The next value in an Excel-style fill series for a single source cell:
 * numbers step by ±1, "Item 3"-style suffixes count up (zero padding kept),
 * ISO dates step by days. Everything else copies as-is.
 */
export function nextAutoFillValue(sourceValue: string, offset: number): string {
  const raw = sourceValue.trim();
  if (!raw) return sourceValue;
  const num = Number(raw.replace(/,/g, ''));
  if (Number.isFinite(num) && !/[A-Za-z]/.test(raw)) return String(num + offset);
  const dateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    const date = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]) + offset);
    return `${date.getFullYear()}-${formulaPad2(date.getMonth() + 1)}-${formulaPad2(date.getDate())}`;
  }
  const suffixMatch = raw.match(/^(.*?)(\d+)$/);
  if (suffixMatch) {
    const next = parseInt(suffixMatch[2], 10) + offset;
    if (next >= 0) return suffixMatch[1] + String(next).padStart(suffixMatch[2].length, '0');
  }
  return sourceValue;
}

/** Every built-in worksheet function — drives Excel-style formula autocomplete. */
export const FORMULA_FUNCTION_NAMES: string[] = [
  'ABS', 'AND', 'AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'CEILING', 'CHAR', 'CHOOSE', 'CLEAN', 'CODE',
  'COLUMN', 'COLUMNS', 'CONCAT', 'CONCATENATE', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS',
  'DATE', 'DATEDIF', 'DAY', 'DAYS', 'EDATE', 'EOMONTH', 'EXACT', 'EXP', 'FALSE', 'FIND', 'FLOOR',
  'HLOOKUP', 'HOUR', 'IF', 'IFERROR', 'IFNA', 'IFS', 'INDEX', 'INT', 'ISBLANK', 'ISERR', 'ISERROR',
  'ISLOGICAL', 'ISNA', 'ISNUMBER', 'ISTEXT', 'LARGE', 'LEFT', 'LEN', 'LN', 'LOG', 'LOG10', 'LOWER',
  'MATCH', 'MAX', 'MAXIFS', 'MEDIAN', 'MID', 'MIN', 'MINIFS', 'MINUTE', 'MOD', 'MONTH', 'NETWORKDAYS',
  'NOT', 'NOW', 'OR', 'PI', 'POWER', 'PRODUCT', 'PROPER', 'RAND', 'RANDBETWEEN', 'RANK', 'REPLACE',
  'REPT', 'RIGHT', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'ROW', 'ROWS', 'SEARCH', 'SECOND', 'SIGN', 'SMALL',
  'SQRT', 'STDEV', 'SUBSTITUTE', 'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SWITCH', 'T', 'TEXT',
  'TEXTJOIN', 'TODAY', 'TRIM', 'TRUE', 'TRUNC', 'UPPER', 'VALUE', 'VAR', 'VLOOKUP', 'WEEKDAY', 'XLOOKUP', 'XOR',
];

// ─── Conditional formatting ─────────────────────────────────────────
// MS Excel-style rules evaluated live over a range: highlight rules, top-N,
// duplicate detection, 3-color scales, and data bars. Rule order = priority
// (first matching rule wins a field, like Excel's rule list).

export interface ConditionalRule {
  id: string;
  range: string;      // "B2:B100"
  type: 'gt' | 'lt' | 'between' | 'eq' | 'contains' | 'duplicate' | 'top10' | 'colorScale' | 'dataBar';
  value1?: string;
  value2?: string;
}

export interface ConditionalCellStyle {
  bg?: string;
  text?: string;
  barFraction?: number;  // 0..1 data-bar length
  barColor?: string;
}

// Excel's classic "Light Red Fill with Dark Red Text" + default blue data bar.
const CF_FILL = '#ffc7ce';
const CF_TEXT = '#9c0006';
const CF_BAR = '#638ec6';

function cfNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed.replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function cfLerpChannel(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * t);
}

function cfLerpColor(from: string, to: string, t: number): string {
  const f = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const s = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  const mixed = f.map((c, i) => cfLerpChannel(c, s[i], t));
  return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** Excel's Green-Yellow-Red 3-color scale (t=0 red … t=1 green). */
export function colorScaleColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped < 0.5
    ? cfLerpColor('#f8696b', '#ffeb84', clamped * 2)
    : cfLerpColor('#ffeb84', '#63be7b', (clamped - 0.5) * 2);
}

export function computeConditionalFormatMap(
  sheet: Pick<SheetData, 'cells'> & { conditionalRules?: ConditionalRule[] },
): Map<string, ConditionalCellStyle> {
  const map = new Map<string, ConditionalCellStyle>();
  const rules = sheet.conditionalRules || [];
  if (!rules.length) return map;

  const merge = (ref: string, patch: ConditionalCellStyle) => {
    const existing = map.get(ref) || {};
    // First rule to claim a field keeps it (Excel priority order).
    map.set(ref, { ...patch, ...existing });
  };

  for (const rule of rules) {
    const refs = expandRange(rule.range.replace(/\$/g, '').toUpperCase());
    const entries = refs.map((ref) => {
      const cell = sheet.cells[ref];
      const raw = cell ? getDisplayValue(cell, sheet.cells) : '';
      return { ref, raw, num: cfNumber(raw) };
    });
    const nums = entries.filter((e) => e.num !== null).map((e) => e.num as number);
    const min = nums.length ? Math.min(...nums) : 0;
    const max = nums.length ? Math.max(...nums) : 0;

    switch (rule.type) {
      case 'gt':
      case 'lt':
      case 'eq':
      case 'between': {
        const v1 = cfNumber(rule.value1 || '');
        const v2 = cfNumber(rule.value2 || '');
        for (const e of entries) {
          let hit = false;
          if (rule.type === 'eq' && e.num === null) {
            hit = e.raw.trim() !== '' && e.raw.trim().toLowerCase() === (rule.value1 || '').trim().toLowerCase();
          } else if (e.num !== null && v1 !== null) {
            hit = rule.type === 'gt' ? e.num > v1
              : rule.type === 'lt' ? e.num < v1
              : rule.type === 'eq' ? e.num === v1
              : v2 !== null && e.num >= Math.min(v1, v2) && e.num <= Math.max(v1, v2);
          }
          if (hit) merge(e.ref, { bg: CF_FILL, text: CF_TEXT });
        }
        break;
      }
      case 'contains': {
        const needle = (rule.value1 || '').trim().toLowerCase();
        if (!needle) break;
        for (const e of entries) {
          if (e.raw.toLowerCase().includes(needle)) merge(e.ref, { bg: CF_FILL, text: CF_TEXT });
        }
        break;
      }
      case 'duplicate': {
        const counts = new Map<string, number>();
        for (const e of entries) {
          const key = e.raw.trim().toLowerCase();
          if (key) counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (const e of entries) {
          const key = e.raw.trim().toLowerCase();
          if (key && (counts.get(key) || 0) > 1) merge(e.ref, { bg: CF_FILL, text: CF_TEXT });
        }
        break;
      }
      case 'top10': {
        const n = Math.max(1, Math.trunc(cfNumber(rule.value1 || '') ?? 10));
        const threshold = [...nums].sort((a, b) => b - a)[Math.min(n, nums.length) - 1];
        if (threshold === undefined) break;
        for (const e of entries) {
          if (e.num !== null && e.num >= threshold) merge(e.ref, { bg: '#ffeb9c', text: '#9c6500' });
        }
        break;
      }
      case 'colorScale': {
        if (max === min) break;
        for (const e of entries) {
          if (e.num === null) continue;
          merge(e.ref, { bg: colorScaleColor((e.num - min) / (max - min)) });
        }
        break;
      }
      case 'dataBar': {
        const low = Math.min(0, min);
        const high = Math.max(0, max);
        if (high === low) break;
        for (const e of entries) {
          if (e.num === null) continue;
          merge(e.ref, { barFraction: Math.max(0, Math.min(1, (e.num - low) / (high - low))), barColor: CF_BAR });
        }
        break;
      }
    }
  }
  return map;
}

function wildcardCriteriaToRegex(criteria: string): RegExp {
  const escaped = criteria
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function matchesFormulaCriteria(value: string, criteria: string): boolean {
  const rawValue = String(value).trim();
  const rawCriteria = String(criteria).trim();
  const opMatch = rawCriteria.match(/^(>=|<=|<>|!=|>|<|=)(.*)$/);
  const op = opMatch?.[1] || '=';
  const target = (opMatch?.[2] ?? rawCriteria).trim();

  if ((target.includes('*') || target.includes('?')) && (op === '=' || !opMatch)) {
    return wildcardCriteriaToRegex(target).test(rawValue);
  }

  const valueNum = Number(rawValue.replace(/,/g, '').replace(/%$/, ''));
  const targetNum = Number(target.replace(/,/g, '').replace(/%$/, ''));
  const numericCompare = Number.isFinite(valueNum) && Number.isFinite(targetNum);
  const left = numericCompare ? valueNum : rawValue.toLowerCase();
  const right = numericCompare ? targetNum : target.toLowerCase();

  switch (op) {
    case '>=': return left >= right;
    case '<=': return left <= right;
    case '<>':
    case '!=': return left !== right;
    case '>': return left > right;
    case '<': return left < right;
    case '=':
    default: return left === right;
  }
}

function getDisplayValue(cell: CellData | undefined, cells: Record<string, CellData>): string {
  if (!cell) return '';
  if (cell.formula) {
    return evaluateFormula(cell.formula, cells);
  }
  return cell.value;
}

export interface SpreadsheetColumnSummary {
  col: number;
  label: string;
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

export interface SpreadsheetColumnProfile {
  col: number;
  label: string;
  totalRows: number;
  filledCount: number;
  blankCount: number;
  numericCount: number;
  textCount: number;
  uniqueCount: number;
  topValue: string;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
  type: 'numeric' | 'category' | 'mixed' | 'empty';
}

export interface SpreadsheetInsight {
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'success';
}

export interface SpreadsheetCorrelationPair {
  leftCol: number;
  rightCol: number;
  leftLabel: string;
  rightLabel: string;
  correlation: number;
  sampleSize: number;
  strength: 'very strong' | 'strong' | 'moderate' | 'weak';
  direction: 'positive' | 'negative';
}

export interface SpreadsheetSolverCandidate {
  label: string;
  objective: number;
  cost: number;
  maxUnits: number;
  objectivePerUnit: number;
  costPerUnit: number;
  roi: number;
}

interface SpreadsheetSolverAllocation extends SpreadsheetSolverCandidate {
  units: number;
  allocatedCost: number;
  expectedReturn: number;
}

function selectedBounds(sheet: SheetData, refs?: string[]) {
  const parsedRefs = (refs || [])
    .map((ref) => parseCellRef(ref))
    .filter((ref): ref is { col: number; row: number } => Boolean(ref));
  if (!parsedRefs.length) {
    const populatedRefs = Object.entries(sheet.cells)
      .filter(([, cell]) => Boolean(cell?.formula) || Boolean(getDisplayValue(cell, sheet.cells).trim()))
      .map(([ref]) => parseCellRef(ref))
      .filter((ref): ref is { col: number; row: number } => Boolean(ref));
    if (populatedRefs.length) {
      return populatedRefs.reduce((acc, ref) => ({
        minCol: Math.min(acc.minCol, ref.col),
        maxCol: Math.max(acc.maxCol, ref.col),
        minRow: Math.min(acc.minRow, ref.row),
        maxRow: Math.max(acc.maxRow, ref.row),
      }), {
        minCol: populatedRefs[0].col,
        maxCol: populatedRefs[0].col,
        minRow: populatedRefs[0].row,
        maxRow: populatedRefs[0].row,
      });
    }
    return { minCol: 0, maxCol: sheet.maxCol, minRow: 0, maxRow: sheet.maxRow };
  }
  return parsedRefs.reduce((acc, ref) => ({
    minCol: Math.min(acc.minCol, ref.col),
    maxCol: Math.max(acc.maxCol, ref.col),
    minRow: Math.min(acc.minRow, ref.row),
    maxRow: Math.max(acc.maxRow, ref.row),
  }), {
    minCol: parsedRefs[0].col,
    maxCol: parsedRefs[0].col,
    minRow: parsedRefs[0].row,
    maxRow: parsedRefs[0].row,
  });
}

export function analyzeSpreadsheetRange(sheet: SheetData, refs?: string[]): SpreadsheetColumnSummary[] {
  const bounds = selectedBounds(sheet, refs);
  const headerRow = bounds.minRow;
  const summaries: SpreadsheetColumnSummary[] = [];
  for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
    const headerRef = cellRef(col, headerRow);
    const header = getDisplayValue(sheet.cells[headerRef], sheet.cells).trim();
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let row = headerRow + 1; row <= bounds.maxRow; row++) {
      const ref = cellRef(col, row);
      const raw = getDisplayValue(sheet.cells[ref], sheet.cells);
      if (!String(raw).trim()) continue;
      const num = Number(String(raw).replace(/,/g, '').replace(/%$/, ''));
      if (Number.isFinite(num)) {
        count += 1;
        sum += num;
        min = Math.min(min, num);
        max = Math.max(max, num);
      }
    }
    if (count > 0) {
      summaries.push({
        col,
        label: header || colToLetter(col),
        count,
        sum: Math.round(sum * 100) / 100,
        avg: Math.round((sum / count) * 100) / 100,
        min,
        max,
      });
    }
  }
  return summaries;
}

export function profileSpreadsheetRange(sheet: SheetData, refs?: string[]): SpreadsheetColumnProfile[] {
  const bounds = selectedBounds(sheet, refs);
  const headerRow = bounds.minRow;
  const profiles: SpreadsheetColumnProfile[] = [];
  const totalRows = Math.max(0, bounds.maxRow - headerRow);

  for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
    const headerRef = cellRef(col, headerRow);
    const header = getDisplayValue(sheet.cells[headerRef], sheet.cells).trim();
    let blankCount = 0;
    let numericCount = 0;
    let textCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const frequencies = new Map<string, number>();

    for (let row = headerRow + 1; row <= bounds.maxRow; row++) {
      const ref = cellRef(col, row);
      const raw = String(getDisplayValue(sheet.cells[ref], sheet.cells)).trim();
      if (!raw) {
        blankCount += 1;
        continue;
      }
      frequencies.set(raw, (frequencies.get(raw) || 0) + 1);
      const num = Number(raw.replace(/,/g, '').replace(/%$/, ''));
      if (Number.isFinite(num)) {
        numericCount += 1;
        sum += num;
        min = Math.min(min, num);
        max = Math.max(max, num);
      } else {
        textCount += 1;
      }
    }

    const filledCount = numericCount + textCount;
    const top = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0];
    const numericRatio = filledCount ? numericCount / filledCount : 0;
    const textRatio = filledCount ? textCount / filledCount : 0;
    const type: SpreadsheetColumnProfile['type'] = filledCount === 0
      ? 'empty'
      : numericRatio >= 0.8
        ? 'numeric'
        : textRatio >= 0.8
          ? 'category'
          : 'mixed';

    profiles.push({
      col,
      label: header || colToLetter(col),
      totalRows,
      filledCount,
      blankCount,
      numericCount,
      textCount,
      uniqueCount: frequencies.size,
      topValue: top ? top[0] : '',
      sum: numericCount ? Math.round(sum * 100) / 100 : undefined,
      avg: numericCount ? Math.round((sum / numericCount) * 100) / 100 : undefined,
      min: numericCount ? min : undefined,
      max: numericCount ? max : undefined,
      type,
    });
  }

  return profiles;
}

export function generateSpreadsheetInsights(sheet: SheetData, refs?: string[]): SpreadsheetInsight[] {
  const profiles = profileSpreadsheetRange(sheet, refs);
  const insights: SpreadsheetInsight[] = [];
  const numeric = profiles.filter((profile) => profile.type === 'numeric');
  const categories = profiles.filter((profile) => profile.type === 'category');

  if (!profiles.length || profiles.every((profile) => profile.type === 'empty')) {
    return [{ title: 'No usable data', detail: 'The selected range does not contain enough values to analyze.', severity: 'warning' }];
  }

  if (numeric.length) {
    const topSum = [...numeric].sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
    const topAvg = [...numeric].sort((a, b) => Math.abs(b.avg || 0) - Math.abs(a.avg || 0))[0];
    insights.push({
      title: 'Largest metric',
      detail: `${topSum.label} has the largest absolute sum (${formatDisplayValue(String(topSum.sum ?? 0), 'decimal2')}).`,
      severity: 'success',
    });
    if (topAvg && topAvg.label !== topSum.label) {
      insights.push({
        title: 'Highest average',
        detail: `${topAvg.label} has the strongest average value (${formatDisplayValue(String(topAvg.avg ?? 0), 'decimal2')}).`,
        severity: 'info',
      });
    }
  }

  const incomplete = profiles
    .filter((profile) => profile.totalRows > 0 && profile.blankCount / profile.totalRows >= 0.15)
    .sort((a, b) => b.blankCount - a.blankCount)[0];
  if (incomplete) {
    insights.push({
      title: 'Data quality warning',
      detail: `${incomplete.label} has ${incomplete.blankCount} blank row${incomplete.blankCount === 1 ? '' : 's'} in the analyzed range.`,
      severity: 'warning',
    });
  }

  if (categories.length) {
    const richestCategory = [...categories].sort((a, b) => b.uniqueCount - a.uniqueCount)[0];
    insights.push({
      title: 'Best grouping field',
      detail: `${richestCategory.label} has ${richestCategory.uniqueCount} unique value${richestCategory.uniqueCount === 1 ? '' : 's'} and is a good pivot dimension.`,
      severity: 'info',
    });
  }

  const mixed = profiles.find((profile) => profile.type === 'mixed');
  if (mixed) {
    insights.push({
      title: 'Mixed data type',
      detail: `${mixed.label} mixes numbers and text. Clean this column before advanced modeling.`,
      severity: 'warning',
    });
  }

  return insights.length ? insights : [{ title: 'Clean table', detail: 'The selected range is structured and ready for formulas, pivots, or charts.', severity: 'success' }];
}

function spreadsheetCorrelationStrength(value: number): SpreadsheetCorrelationPair['strength'] {
  const abs = Math.abs(value);
  if (abs >= 0.85) return 'very strong';
  if (abs >= 0.65) return 'strong';
  if (abs >= 0.4) return 'moderate';
  return 'weak';
}

function calculatePearsonCorrelation(left: Array<{ row: number; value: number }>, right: Array<{ row: number; value: number }>): { correlation: number; sampleSize: number } | null {
  const rightByRow = new Map(right.map((item) => [item.row, item.value]));
  const pairs = left
    .map((item) => ({ x: item.value, y: rightByRow.get(item.row) }))
    .filter((item): item is { x: number; y: number } => Number.isFinite(item.y));
  if (pairs.length < 2) return null;
  const meanX = pairs.reduce((sum, item) => sum + item.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, item) => sum + item.y, 0) / pairs.length;
  let numerator = 0;
  let xSquares = 0;
  let ySquares = 0;
  pairs.forEach((item) => {
    const dx = item.x - meanX;
    const dy = item.y - meanY;
    numerator += dx * dy;
    xSquares += dx * dx;
    ySquares += dy * dy;
  });
  const denominator = Math.sqrt(xSquares * ySquares);
  if (!denominator) return null;
  return {
    correlation: Math.round((numerator / denominator) * 10000) / 10000,
    sampleSize: pairs.length,
  };
}

function collectSpreadsheetNumericSeries(sheet: SheetData, refs?: string[]) {
  const bounds = selectedBounds(sheet, refs);
  const profiles = profileSpreadsheetRange(sheet, refs).filter((profile) => profile.type === 'numeric');
  return profiles.map((profile) => {
    const values: Array<{ row: number; value: number }> = [];
    for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
      const raw = String(getDisplayValue(sheet.cells[cellRef(profile.col, row)], sheet.cells)).trim();
      if (!raw) continue;
      const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
      if (Number.isFinite(value)) values.push({ row, value });
    }
    return { col: profile.col, label: profile.label, values };
  }).filter((series) => series.values.length >= 2);
}

export function calculateSpreadsheetCorrelations(sheet: SheetData, refs?: string[]): SpreadsheetCorrelationPair[] {
  const series = collectSpreadsheetNumericSeries(sheet, refs);
  const pairs: SpreadsheetCorrelationPair[] = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const result = calculatePearsonCorrelation(series[i].values, series[j].values);
      if (!result) continue;
      pairs.push({
        leftCol: series[i].col,
        rightCol: series[j].col,
        leftLabel: series[i].label,
        rightLabel: series[j].label,
        correlation: result.correlation,
        sampleSize: result.sampleSize,
        strength: spreadsheetCorrelationStrength(result.correlation),
        direction: result.correlation >= 0 ? 'positive' : 'negative',
      });
    }
  }
  return pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

export function buildSpreadsheetSummarySheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const cells: Record<string, CellData> = {};
  const headers = ['Field', 'Count', 'Sum', 'Average', 'Min', 'Max'];
  headers.forEach((header, col) => {
    cells[cellRef(col, 0)] = {
      value: header,
      format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' },
    };
  });

  if (!summaries.length) {
    cells.A2 = {
      value: 'No numeric data found in the selected range.',
      format: { italic: true, color: '#64748b' },
    };
  } else {
    summaries.forEach((summary, index) => {
      const row = index + 1;
      const fill = index % 2 === 0 ? '#f8fafc' : '#eef6ff';
      const values = [summary.label, summary.count, summary.sum, summary.avg, summary.min, summary.max];
      values.forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: fill,
            numberFormat: col === 0 ? 'general' : 'decimal2',
            align: col === 0 ? 'left' : 'right',
          },
        };
      });
    });
  }

  return {
    name: `${sourceSheet.name || 'Sheet'} Summary`,
    cells,
    colWidths: { 0: 180, 1: 80, 2: 110, 3: 110, 4: 110, 5: 110 },
    rowHeights: {},
    maxCol: 5,
    maxRow: Math.max(1, summaries.length),
    frozenRows: 1,
    frozenCols: 0,
  };
}

export function buildSpreadsheetInsightSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const insights = generateSpreadsheetInsights(sourceSheet, refs);
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Insights`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A3: { value: 'Insight', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B3: { value: 'Detail', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    C3: { value: 'Severity', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A8: { value: 'Field', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    B8: { value: 'Type', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    C8: { value: 'Filled', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D8: { value: 'Blanks', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    E8: { value: 'Unique', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    F8: { value: 'Top Value', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    G8: { value: 'Average', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
  };

  insights.forEach((insight, idx) => {
    const row = idx + 3;
    const fill = insight.severity === 'warning' ? '#fef3c7' : insight.severity === 'success' ? '#dcfce7' : '#eff6ff';
    cells[cellRef(0, row)] = { value: insight.title, format: { bold: true, bgColor: fill, color: '#0f172a' } };
    cells[cellRef(1, row)] = { value: insight.detail, format: { bgColor: fill, color: '#0f172a' } };
    cells[cellRef(2, row)] = { value: insight.severity, format: { bgColor: fill, color: '#0f172a', align: 'center' } };
  });

  profiles.forEach((profile, idx) => {
    const row = idx + 8;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    const values = [
      profile.label,
      profile.type,
      profile.filledCount,
      profile.blankCount,
      profile.uniqueCount,
      profile.topValue,
      profile.avg ?? '',
    ];
    values.forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: fill,
          color: '#0f172a',
          numberFormat: col >= 2 && col !== 5 ? 'decimal2' : 'general',
          align: col >= 2 && col !== 5 ? 'right' : 'left',
        },
      };
    });
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Insights`,
    cells,
    colWidths: { 0: 190, 1: 460, 2: 90, 3: 90, 4: 90, 5: 160, 6: 110 },
    rowHeights: { 0: 34, 2: 30, 7: 30 },
    maxCol: 6,
    maxRow: Math.max(8 + profiles.length, 3 + insights.length),
    frozenRows: 8,
    frozenCols: 0,
  };
}

export function buildSpreadsheetPivotSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const category = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0);
  const metric = [...profiles].filter((profile) => profile.type === 'numeric').sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Pivot`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
  };

  if (!category || !metric) {
    cells.A3 = {
      value: 'Pivot generation needs at least one category column and one numeric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Pivot`,
      cells,
      colWidths: { 0: 420 },
      rowHeights: { 0: 34 },
      maxCol: 0,
      maxRow: 3,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const groups = new Map<string, { count: number; sum: number; min: number; max: number }>();
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const categoryValue = String(getDisplayValue(sourceSheet.cells[cellRef(category.col, row)], sourceSheet.cells)).trim() || '(blank)';
    const rawMetric = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
    const numericValue = Number(rawMetric.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isFinite(numericValue)) continue;
    const current = groups.get(categoryValue) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    current.count += 1;
    current.sum += numericValue;
    current.min = Math.min(current.min, numericValue);
    current.max = Math.max(current.max, numericValue);
    groups.set(categoryValue, current);
  }

  const headers = [category.label, `${metric.label} Sum`, `${metric.label} Average`, 'Count', 'Min', 'Max', 'Share'];
  headers.forEach((header, col) => {
    cells[cellRef(col, 2)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  });

  const rows = [...groups.entries()].sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum));
  const total = rows.reduce((sum, [, item]) => sum + Math.abs(item.sum), 0) || 1;
  rows.forEach(([label, item], idx) => {
    const row = idx + 3;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    const share = Math.abs(item.sum) / total;
    const values = [label, item.sum, item.sum / item.count, item.count, item.min, item.max, share];
    values.forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(col === 6 ? Math.round(Number(value) * 10000) / 10000 : Math.round(Number(value) * 100) / 100 || value),
        format: {
          bgColor: col === 6 ? '#dbeafe' : fill,
          color: '#0f172a',
          bold: col === 0,
          numberFormat: col === 6 ? 'percent' : col > 0 ? 'decimal2' : 'general',
          align: col === 0 ? 'left' : 'right',
        },
      };
    });
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Pivot`,
    cells,
    colWidths: { 0: 180, 1: 130, 2: 140, 3: 80, 4: 110, 5: 110, 6: 110 },
    rowHeights: { 0: 34, 2: 30 },
    maxCol: 6,
    maxRow: Math.max(3, rows.length + 2),
    frozenRows: 3,
    frozenCols: 1,
  };
}

export function buildSpreadsheetDashboardSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const cells: Record<string, CellData> = {
    A1: {
      value: `${sourceSheet.name || 'Sheet'} Dashboard`,
      format: { bold: true, fontSize: 18, color: '#0f172a' },
    },
    A3: {
      value: 'Field',
      format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' },
    },
    B3: {
      value: 'Sum',
      format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' },
    },
    C3: {
      value: 'Average',
      format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' },
    },
    D3: {
      value: 'Data Bar',
      format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' },
    },
  };

  if (!summaries.length) {
    cells.A4 = {
      value: 'No numeric data found for dashboard generation.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
  } else {
    const maxSum = Math.max(...summaries.map((summary) => Math.abs(summary.sum)), 1);
    summaries.forEach((summary, index) => {
      const row = index + 3;
      const fill = index % 2 === 0 ? '#f8fafc' : '#eef6ff';
      const barWidth = Math.max(1, Math.round((Math.abs(summary.sum) / maxSum) * 24));
      const values = [summary.label, summary.sum, summary.avg, '#'.repeat(barWidth)];
      values.forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: col === 3 ? '#dbeafe' : fill,
            color: col === 3 ? '#1d4ed8' : '#0f172a',
            bold: col === 0,
            numberFormat: col === 1 || col === 2 ? 'decimal2' : 'general',
            align: col === 0 ? 'left' : col === 3 ? 'left' : 'right',
          },
        };
      });
    });
    const top = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))[0];
    cells.F3 = { value: 'Top metric', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
    cells.F4 = { value: top.label, format: { bold: true, fontSize: 16, color: '#1f6feb', bgColor: '#eff6ff', align: 'center' } };
    cells.F5 = { value: String(top.sum), format: { bold: true, fontSize: 18, numberFormat: 'decimal2', color: '#0f172a', bgColor: '#eff6ff', align: 'center' } };
  }

  return {
    name: `${sourceSheet.name || 'Sheet'} Dashboard`,
    cells,
    colWidths: { 0: 170, 1: 120, 2: 120, 3: 220, 4: 24, 5: 150 },
    rowHeights: { 0: 34, 2: 30 },
    maxCol: 5,
    maxRow: Math.max(5, summaries.length + 3),
    frozenRows: 3,
    frozenCols: 0,
  };
}

export function buildSpreadsheetForecastSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const metric = [...profiles]
    .filter((profile) => profile.type === 'numeric')
    .sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
  const dimension = profiles.find((profile) => profile.col !== metric?.col && profile.filledCount > 0)
    || profiles.find((profile) => profile.col !== metric?.col);
  const cells: Record<string, CellData> = {
    A1: {
      value: `${sourceSheet.name || 'Sheet'} Forecast`,
      format: { bold: true, fontSize: 18, color: '#0f172a' },
    },
    A2: {
      value: 'Trend model generated from the selected range. Forecast uses average recent change and flags volatility.',
      format: { italic: true, color: '#475569' },
    },
  };

  if (!metric || !dimension) {
    cells.A4 = {
      value: 'Forecast generation needs one dimension column and one numeric metric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Forecast`,
      cells,
      colWidths: { 0: 520 },
      rowHeights: { 0: 34 },
      maxCol: 0,
      maxRow: 4,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const rows: Array<{ label: string; value: number }> = [];
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const label = String(getDisplayValue(sourceSheet.cells[cellRef(dimension.col, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
    const raw = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    if (Number.isFinite(value)) rows.push({ label, value });
  }

  if (rows.length < 2) {
    cells.A4 = {
      value: 'Forecast generation needs at least two numeric data points.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Forecast`,
      cells,
      colWidths: { 0: 520 },
      rowHeights: { 0: 34 },
      maxCol: 0,
      maxRow: 4,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const deltas = rows.slice(1).map((row, idx) => row.value - rows[idx].value);
  const recentDeltas = deltas.slice(-Math.min(3, deltas.length));
  const avgDelta = recentDeltas.reduce((sum, value) => sum + value, 0) / recentDeltas.length;
  const avgAbsDelta = recentDeltas.reduce((sum, value) => sum + Math.abs(value), 0) / recentDeltas.length;
  const lastValue = rows[rows.length - 1].value;
  const volatility = avgAbsDelta / (Math.abs(lastValue) || 1);
  const forecastRows = Array.from({ length: 3 }, (_, idx) => ({
    label: `Forecast +${idx + 1}`,
    value: Math.round((lastValue + avgDelta * (idx + 1)) * 100) / 100,
  }));
  const values = [...rows.map((row) => row.value), ...forecastRows.map((row) => row.value)];
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);

  const headers = [dimension.label, metric.label, 'Change', 'Growth', 'Moving Avg', 'Forecast', 'Bar'];
  headers.forEach((header, col) => {
    cells[cellRef(col, 3)] = {
      value: header,
      format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' },
    };
  });

  rows.forEach((item, idx) => {
    const row = idx + 4;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    const previous = idx > 0 ? rows[idx - 1].value : null;
    const change = previous === null ? '' : Math.round((item.value - previous) * 100) / 100;
    const growth = previous === null || previous === 0 ? '' : Math.round(((item.value - previous) / Math.abs(previous)) * 10000) / 10000;
    const movingSource = rows.slice(Math.max(0, idx - 2), idx + 1);
    const movingAvg = Math.round((movingSource.reduce((sum, value) => sum + value.value, 0) / movingSource.length) * 100) / 100;
    const bar = '█'.repeat(Math.max(1, Math.round((Math.abs(item.value) / maxAbs) * 18)));
    const rowValues = [item.label, item.value, change, growth, movingAvg, '', bar];
    rowValues.forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: col === 6 ? '#dbeafe' : fill,
          color: col === 6 ? '#1d4ed8' : '#0f172a',
          bold: col === 0,
          numberFormat: col === 3 ? 'percent' : col > 0 && col < 6 ? 'decimal2' : 'general',
          align: col === 0 || col === 6 ? 'left' : 'right',
        },
      };
    });
  });

  forecastRows.forEach((item, idx) => {
    const row = rows.length + idx + 4;
    const bar = '█'.repeat(Math.max(1, Math.round((Math.abs(item.value) / maxAbs) * 18)));
    const rowValues = [item.label, '', '', '', '', item.value, bar];
    rowValues.forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: col === 6 ? '#ede9fe' : '#f5f3ff',
          color: col === 6 ? '#6d28d9' : '#0f172a',
          bold: col === 0 || col === 5,
          numberFormat: col === 5 ? 'decimal2' : 'general',
          align: col === 0 || col === 6 ? 'left' : 'right',
        },
      };
    });
  });

  const summaryRow = rows.length + forecastRows.length + 6;
  cells[cellRef(0, summaryRow)] = { value: 'Model signal', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(1, summaryRow)] = { value: 'Value', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(0, summaryRow + 1)] = { value: 'Average recent change', format: { bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 1)] = { value: String(Math.round(avgDelta * 100) / 100), format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right' } };
  cells[cellRef(0, summaryRow + 2)] = { value: 'Volatility', format: { bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 2)] = { value: String(Math.round(volatility * 10000) / 10000), format: { bgColor: volatility > 0.25 ? '#fef3c7' : '#dcfce7', numberFormat: 'percent', align: 'right' } };
  cells[cellRef(0, summaryRow + 3)] = { value: 'Recommendation', format: { bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 3)] = {
    value: volatility > 0.25 ? 'High volatility: review outliers before using the forecast.' : 'Stable enough for a lightweight planning forecast.',
    format: { bgColor: volatility > 0.25 ? '#fef3c7' : '#dcfce7', color: '#0f172a' },
  };

  return {
    name: `${sourceSheet.name || 'Sheet'} Forecast`,
    cells,
    colWidths: { 0: 180, 1: 120, 2: 120, 3: 100, 4: 120, 5: 120, 6: 220 },
    rowHeights: { 0: 34, 1: 28, 3: 30 },
    maxCol: 6,
    maxRow: summaryRow + 3,
    frozenRows: 4,
    frozenCols: 1,
  };
}

function isAggregateRowLabel(value: string): boolean {
  return /^(total|subtotal|grand total|합계|소계|총계)$/i.test(String(value || '').trim());
}

function normalizeSpreadsheetHeader(raw: string, col: number, used: Set<string>): string {
  const base = String(raw || '').replace(/\s+/g, ' ').trim() || `Field ${col + 1}`;
  let label = base;
  let suffix = 2;
  while (used.has(label.toLowerCase())) {
    label = `${base} ${suffix}`;
    suffix += 1;
  }
  used.add(label.toLowerCase());
  return label;
}

function cleanSpreadsheetCellValue(raw: string): { value: string; format?: CellFormat; changed: boolean } {
  const original = String(raw || '');
  const trimmed = original.replace(/\s+/g, ' ').trim();
  if (!trimmed) return { value: '', changed: original.length > 0 };

  const percentMatch = trimmed.match(/^-?\d+(?:,\d{3})*(?:\.\d+)?%$/);
  if (percentMatch) {
    const value = Number(trimmed.replace(/,/g, '').replace('%', '')) / 100;
    if (Number.isFinite(value)) {
      return { value: String(Math.round(value * 1000000) / 1000000), format: { numberFormat: 'percent', align: 'right' }, changed: true };
    }
  }

  const currencyMatch = trimmed.match(/^\$?-?\d+(?:,\d{3})*(?:\.\d+)?$/);
  const hasCurrency = trimmed.startsWith('$');
  const cleanNumber = trimmed.replace(/^\$/, '').replace(/,/g, '');
  if (currencyMatch && !/^0\d+/.test(cleanNumber)) {
    const value = Number(cleanNumber);
    if (Number.isFinite(value)) {
      const isDecimal = cleanNumber.includes('.');
      return {
        value: String(Math.round(value * 100) / 100),
        format: { numberFormat: hasCurrency ? 'currency' : isDecimal ? 'decimal2' : 'integer', align: 'right' },
        changed: hasCurrency || trimmed.includes(',') || trimmed !== String(value),
      };
    }
  }

  return { value: trimmed, changed: trimmed !== original };
}

export function buildSpreadsheetScenarioSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const metric = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))[0];
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0);
  let detailSum = 0;
  let detailCount = 0;
  if (metric) {
    const labelCol = dimension?.col ?? bounds.minCol;
    for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
      const rowLabel = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim();
      if (isAggregateRowLabel(rowLabel)) continue;
      const raw = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
      if (!raw) continue;
      const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
      if (!Number.isFinite(value)) continue;
      detailSum += value;
      detailCount += 1;
    }
  }
  const baseline = metric ? Math.round((detailCount ? detailSum : metric.sum) * 100) / 100 : 0;
  const rows = [
    { name: 'Downside', growth: -0.12, multiplier: 0.9, confidence: 'Low', action: 'Protect cash, pause discretionary spend, review weak segments.' },
    { name: 'Base Case', growth: 0.03, multiplier: 1, confidence: 'Medium', action: 'Execute current plan and monitor weekly deltas.' },
    { name: 'Upside', growth: 0.18, multiplier: 1.08, confidence: 'High', action: 'Increase capacity, sales coverage, or inventory ahead of demand.' },
  ];
  const bestInsight = generateSpreadsheetInsights(sourceSheet, refs)[0];
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Scenario Model`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'What-if planning sheet generated from the selected range. Edit growth and multiplier cells to recalculate projected outcomes.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Decision Setup', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Primary metric', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: metric?.label || 'No numeric metric', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    A7: { value: 'Baseline value', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: String(baseline), format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right', bold: true } },
    A8: { value: 'Best segment field', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B8: { value: dimension?.label || 'No grouping field', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    D4: { value: 'Planning Signal', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D5: { value: detailCount ? `${detailCount} detail rows modeled` : bestInsight?.title || 'Scenario ready', format: { bold: true, bgColor: '#dbeafe', color: '#0f172a' } },
    D6: { value: detailCount ? 'Aggregate rows such as Total/Subtotal are excluded from the baseline to avoid double-counting.' : bestInsight?.detail || 'Adjust assumptions below to model downside, base, and upside cases.', format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A11: { value: 'Scenario', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B11: { value: 'Baseline', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    C11: { value: 'Growth', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    D11: { value: 'Multiplier', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    E11: { value: 'Projected', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    F11: { value: 'Delta', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    G11: { value: 'Confidence', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    H11: { value: 'Recommended Action', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
  };

  if (!metric) {
    cells.A12 = {
      value: 'Scenario modeling needs at least one numeric metric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Scenario`,
      cells,
      colWidths: { 0: 180, 1: 130, 2: 110, 3: 110, 4: 130, 5: 130, 6: 110, 7: 360 },
      rowHeights: { 0: 34, 1: 28, 3: 30, 10: 30 },
      maxCol: 7,
      maxRow: 12,
      frozenRows: 11,
      frozenCols: 1,
    };
  }

  rows.forEach((item, idx) => {
    const row = idx + 11;
    const fill = idx === 0 ? '#fff7ed' : idx === 1 ? '#eff6ff' : '#ecfdf5';
    cells[cellRef(0, row)] = { value: item.name, format: { bold: true, bgColor: fill, color: '#0f172a' } };
    cells[cellRef(1, row)] = { value: String(baseline), format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
    cells[cellRef(2, row)] = { value: String(item.growth), format: { bgColor: fill, numberFormat: 'percent', align: 'right', bold: true } };
    cells[cellRef(3, row)] = { value: String(item.multiplier), format: { bgColor: fill, numberFormat: 'decimal2', align: 'right', bold: true } };
    cells[cellRef(4, row)] = { value: '', formula: `=B${row + 1}*(1+C${row + 1})*D${row + 1}`, format: { bgColor: fill, numberFormat: 'decimal2', align: 'right', bold: true } };
    cells[cellRef(5, row)] = { value: '', formula: `=E${row + 1}-B${row + 1}`, format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
    cells[cellRef(6, row)] = { value: item.confidence, format: { bgColor: fill, color: '#0f172a', align: 'center' } };
    cells[cellRef(7, row)] = { value: item.action, format: { bgColor: fill, color: '#0f172a' } };
  });

  const narrativeRow = 17;
  cells[cellRef(0, narrativeRow)] = { value: 'Board Narrative', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(0, narrativeRow + 1)] = {
    value: `Base metric is ${metric.label}. The model uses editable assumptions so a code agent, analyst, or presenter can tune the plan without rebuilding the workbook.`,
    format: { bgColor: '#eff6ff', color: '#0f172a' },
  };
  cells[cellRef(0, narrativeRow + 3)] = { value: 'Formula Map', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  cells[cellRef(0, narrativeRow + 4)] = { value: 'Projected', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells[cellRef(1, narrativeRow + 4)] = { value: 'Baseline * (1 + Growth) * Multiplier', format: { bgColor: '#f8fafc', color: '#0f172a' } };
  cells[cellRef(0, narrativeRow + 5)] = { value: 'Delta', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, narrativeRow + 5)] = { value: 'Projected - Baseline', format: { bgColor: '#eff6ff', color: '#0f172a' } };

  return {
    name: `${sourceSheet.name || 'Sheet'} Scenario`,
    cells,
    colWidths: { 0: 180, 1: 130, 2: 110, 3: 110, 4: 130, 5: 130, 6: 110, 7: 360 },
    rowHeights: { 0: 34, 1: 28, 3: 30, 10: 30, [narrativeRow]: 30, [narrativeRow + 3]: 30 },
    maxCol: 7,
    maxRow: narrativeRow + 5,
    frozenRows: 11,
    frozenCols: 1,
  };
}

export function buildSpreadsheetSensitivitySheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const metric = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))[0];
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Sensitivity Lab`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Goal seek and sensitivity model generated from the selected range. Edit target and change cells to tune the plan.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Goal Seek', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Metric', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    B5: { value: 'Value', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D4: { value: 'Model Context', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    D5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    E5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    D6: { value: 'Primary field', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    D7: { value: 'Segment field', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
  };

  if (!metric) {
    cells.A7 = {
      value: 'Sensitivity modeling needs at least one numeric metric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Sensitivity`,
      cells,
      colWidths: { 0: 220, 1: 160, 2: 120, 3: 180, 4: 260 },
      rowHeights: { 0: 34, 1: 28, 3: 30, 4: 30 },
      maxCol: 4,
      maxRow: 7,
      frozenRows: 5,
      frozenCols: 0,
    };
  }

  let detailSum = 0;
  let detailCount = 0;
  const labelCol = dimension?.col ?? bounds.minCol;
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const rowLabel = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim();
    if (isAggregateRowLabel(rowLabel)) continue;
    const raw = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isFinite(value)) continue;
    detailSum += value;
    detailCount += 1;
  }

  const baseline = Math.round((detailCount ? detailSum : metric.sum) * 100) / 100;
  const target = Math.round(baseline * 1.15 * 100) / 100;
  cells.A6 = { value: 'Source metric', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.B6 = { value: metric.label, format: { bgColor: '#eff6ff', color: '#0f172a' } };
  cells.A7 = { value: 'Baseline', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.B7 = { value: String(baseline), format: { bgColor: '#f8fafc', numberFormat: 'decimal2', align: 'right', bold: true } };
  cells.A8 = { value: 'Target', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.B8 = { value: String(target), format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right', bold: true } };
  cells.A9 = { value: 'Required lift', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.B9 = { value: '', formula: '=B8/B7-1', format: { bgColor: '#f8fafc', numberFormat: 'percent', align: 'right', bold: true } };
  cells.A10 = { value: 'Target gap', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.B10 = { value: '', formula: '=B8-B7', format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right' } };
  cells.E6 = { value: metric.label, format: { bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E7 = { value: dimension?.label || 'No segment field', format: { bgColor: '#eff6ff', color: '#0f172a' } };
  cells.D8 = { value: 'Rows modeled', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E8 = { value: String(detailCount || metric.count), format: { bgColor: '#f8fafc', numberFormat: 'integer', align: 'right' } };

  const sensitivityStart = 13;
  cells[cellRef(0, sensitivityStart)] = { value: 'Sensitivity Table', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Change', 'Projected', 'Gap to Target', 'Signal'].forEach((header, col) => {
    cells[cellRef(col, sensitivityStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  [-0.2, -0.1, 0, 0.1, 0.15, 0.2, 0.3].forEach((change, idx) => {
    const row = sensitivityStart + 2 + idx;
    const excelRow = row + 1;
    const fill = change < 0 ? '#fff7ed' : change === 0 ? '#f8fafc' : '#ecfdf5';
    cells[cellRef(0, row)] = { value: String(change), format: { bgColor: fill, numberFormat: 'percent', align: 'right', bold: change === 0.15 } };
    cells[cellRef(1, row)] = { value: '', formula: `=B7*(1+A${excelRow})`, format: { bgColor: fill, numberFormat: 'decimal2', align: 'right', bold: change === 0.15 } };
    cells[cellRef(2, row)] = { value: '', formula: `=B${excelRow}-B8`, format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
    cells[cellRef(3, row)] = { value: '', formula: `=IF(B${excelRow}>=B8,"Above target","Below target")`, format: { bgColor: fill, color: '#0f172a' } };
  });

  const groups = new Map<string, { count: number; sum: number }>();
  if (dimension) {
    for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
      const categoryValue = String(getDisplayValue(sourceSheet.cells[cellRef(dimension.col, row)], sourceSheet.cells)).trim() || '(blank)';
      if (isAggregateRowLabel(categoryValue)) continue;
      const rawMetric = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
      const numericValue = Number(rawMetric.replace(/,/g, '').replace(/%$/, ''));
      if (!Number.isFinite(numericValue)) continue;
      const current = groups.get(categoryValue) || { count: 0, sum: 0 };
      current.count += 1;
      current.sum += numericValue;
      groups.set(categoryValue, current);
    }
  }

  const leverStart = 13;
  cells[cellRef(5, leverStart)] = { value: 'Segment Levers', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Segment', 'Base Sum', 'Share', '+10%', '-10%', 'Count'].forEach((header, idx) => {
    cells[cellRef(5 + idx, leverStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  const rows = [...groups.entries()].sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum)).slice(0, 8);
  if (!rows.length) {
    cells[cellRef(5, leverStart + 2)] = { value: 'No segment field found for lever analysis.', format: { italic: true, color: '#64748b', bgColor: '#f8fafc' } };
  } else {
    const totalAbs = rows.reduce((sum, [, item]) => sum + Math.abs(item.sum), 0) || 1;
    rows.forEach(([label, item], idx) => {
      const row = leverStart + 2 + idx;
      const excelRow = row + 1;
      const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      cells[cellRef(5, row)] = { value: label, format: { bold: true, bgColor: fill, color: '#0f172a' } };
      cells[cellRef(6, row)] = { value: String(Math.round(item.sum * 100) / 100), format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
      cells[cellRef(7, row)] = { value: String(Math.round((Math.abs(item.sum) / totalAbs) * 10000) / 10000), format: { bgColor: fill, numberFormat: 'percent', align: 'right' } };
      cells[cellRef(8, row)] = { value: '', formula: `=G${excelRow}*1.1`, format: { bgColor: '#ecfdf5', numberFormat: 'decimal2', align: 'right' } };
      cells[cellRef(9, row)] = { value: '', formula: `=G${excelRow}*0.9`, format: { bgColor: '#fff7ed', numberFormat: 'decimal2', align: 'right' } };
      cells[cellRef(10, row)] = { value: String(item.count), format: { bgColor: fill, numberFormat: 'integer', align: 'right' } };
    });
  }

  const narrativeRow = Math.max(sensitivityStart + 11, leverStart + rows.length + 5);
  cells[cellRef(0, narrativeRow)] = { value: 'Decision Readout', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  cells[cellRef(0, narrativeRow + 1)] = {
    value: `To reach the target for ${metric.label}, the workbook needs the required lift shown in Goal Seek. Change the target or the sensitivity rows to test a new plan instantly.`,
    format: { bgColor: '#eff6ff', color: '#0f172a' },
  };

  return {
    name: `${sourceSheet.name || 'Sheet'} Sensitivity`,
    cells,
    colWidths: { 0: 180, 1: 140, 2: 130, 3: 150, 4: 24, 5: 180, 6: 120, 7: 100, 8: 120, 9: 120, 10: 90 },
    rowHeights: { 0: 34, 1: 28, 3: 30, [sensitivityStart]: 30, [sensitivityStart + 1]: 30, [narrativeRow]: 30 },
    maxCol: 10,
    maxRow: narrativeRow + 1,
    frozenRows: 5,
    frozenCols: 0,
  };
}

export function buildSpreadsheetWaterfallBridgeSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const metric = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))[0];
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.col !== metric?.col && profile.filledCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Waterfall Bridge`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Explains movement across the selected range with start, change, ending value, contribution, and owner-ready narrative.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Bridge Setup', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Metric', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: metric?.label || 'No numeric metric', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    A7: { value: 'Dimension', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: dimension?.label || 'Row order', format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };

  if (!metric) {
    cells.A10 = {
      value: 'Waterfall bridge needs at least one numeric metric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Waterfall`,
      cells,
      colWidths: { 0: 180, 1: 240 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 1,
      maxRow: 10,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const rows: Array<{ label: string; value: number }> = [];
  const labelCol = dimension?.col ?? bounds.minCol;
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const label = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
    if (isAggregateRowLabel(label)) continue;
    const raw = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    if (Number.isFinite(value)) rows.push({ label, value });
  }

  if (rows.length < 2) {
    cells.A10 = {
      value: 'Waterfall bridge needs at least two numeric observations.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Waterfall`,
      cells,
      colWidths: { 0: 420 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 0,
      maxRow: 10,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const totalChange = rows[rows.length - 1].value - rows[0].value;
  const totalAbsChange = rows.slice(1).reduce((sum, item, idx) => sum + Math.abs(item.value - rows[idx].value), 0) || 1;
  cells.D4 = { value: 'Executive Readout', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells.D5 = {
    value: `${metric.label} moved from ${formatDisplayValue(String(rows[0].value), 'decimal2')} to ${formatDisplayValue(String(rows[rows.length - 1].value), 'decimal2')}.`,
    format: { bgColor: totalChange >= 0 ? '#dcfce7' : '#fee2e2', color: '#0f172a', bold: true },
  };
  cells.D6 = {
    value: `Net change: ${formatDisplayValue(String(Math.round(totalChange * 100) / 100), 'decimal2')}. Largest bridge steps are ranked below by absolute contribution.`,
    format: { bgColor: '#eff6ff', color: '#0f172a' },
  };

  const bridgeStart = 10;
  cells[cellRef(0, bridgeStart)] = { value: 'Waterfall Table', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Step', 'Start', 'Change', 'End', 'Contribution', 'Direction', 'Narrative'].forEach((header, col) => {
    cells[cellRef(col, bridgeStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  rows.slice(1).forEach((item, idx) => {
    const previous = rows[idx];
    const change = Math.round((item.value - previous.value) * 100) / 100;
    const contribution = Math.abs(change) / totalAbsChange;
    const direction = change >= 0 ? 'Increase' : 'Decrease';
    const row = bridgeStart + 2 + idx;
    const fill = change >= 0 ? '#ecfdf5' : '#fff7ed';
    const rowValues = [
      `${previous.label} -> ${item.label}`,
      previous.value,
      change,
      item.value,
      contribution,
      direction,
      `${direction} of ${formatDisplayValue(String(Math.abs(change)), 'decimal2')} explains ${Math.round(contribution * 1000) / 10}% of bridge movement.`,
    ];
    rowValues.forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: col === 6 ? '#eff6ff' : fill,
          color: '#0f172a',
          bold: col === 0 || col === 2 || col === 5,
          numberFormat: col === 4 ? 'percent' : col > 0 && col < 4 ? 'decimal2' : 'general',
          align: col === 0 || col === 5 || col === 6 ? 'left' : 'right',
        },
      };
    });
  });

  const leaderboardStart = bridgeStart + rows.length + 4;
  cells[cellRef(0, leaderboardStart)] = { value: 'Top Drivers', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Rank', 'Step', 'Change', 'Recommended Review'].forEach((header, col) => {
    cells[cellRef(col, leaderboardStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  rows.slice(1)
    .map((item, idx) => ({ step: `${rows[idx].label} -> ${item.label}`, change: item.value - rows[idx].value }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 5)
    .forEach((item, idx) => {
      const row = leaderboardStart + 2 + idx;
      const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      [idx + 1, item.step, Math.round(item.change * 100) / 100, item.change >= 0 ? 'Protect the driver and test repeatability.' : 'Assign owner to recover or explain the drop.'].forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: fill,
            color: '#0f172a',
            bold: col === 0 || col === 2,
            numberFormat: col === 0 ? 'integer' : col === 2 ? 'decimal2' : 'general',
            align: col === 0 || col === 2 ? 'right' : 'left',
          },
        };
      });
    });

  return {
    name: `${sourceSheet.name || 'Sheet'} Waterfall`,
    cells,
    colWidths: { 0: 210, 1: 120, 2: 120, 3: 120, 4: 110, 5: 110, 6: 420 },
    rowHeights: { 0: 34, 1: 28, 3: 30, [bridgeStart]: 30, [bridgeStart + 1]: 30, [leaderboardStart]: 30, [leaderboardStart + 1]: 30 },
    maxCol: 6,
    maxRow: leaderboardStart + 6,
    frozenRows: bridgeStart + 2,
    frozenCols: 1,
  };
}

export function buildSpreadsheetAnomalyMonitorSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const numericProfiles = profiles.filter((profile) => profile.type === 'numeric');
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0)
    || profiles.find((profile) => numericProfiles.every((metric) => metric.col !== profile.col) && profile.filledCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Anomaly Monitor`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Flags outliers, sudden changes, and unusual numeric movement across the selected range.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Monitor Setup', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Numeric fields', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: String(numericProfiles.length), format: { bgColor: '#f8fafc', color: '#0f172a', numberFormat: 'integer', align: 'right' } },
    A7: { value: 'Context field', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: dimension?.label || 'Row order', format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };

  const anomalies: Array<{
    field: string;
    label: string;
    ref: string;
    value: number;
    prior?: number;
    changePct?: number;
    zScore?: number;
    severity: 'watch' | 'warning' | 'critical';
    reason: string;
    action: string;
  }> = [];

  numericProfiles.forEach((profile) => {
    const values: Array<{ row: number; ref: string; label: string; value: number }> = [];
    for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
      const raw = String(getDisplayValue(sourceSheet.cells[cellRef(profile.col, row)], sourceSheet.cells)).trim();
      if (!raw) continue;
      const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
      if (!Number.isFinite(value)) continue;
      const label = String(getDisplayValue(sourceSheet.cells[cellRef(dimension?.col ?? bounds.minCol, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
      if (isAggregateRowLabel(label)) continue;
      values.push({ row, ref: cellRef(profile.col, row), label, value });
    }
    if (values.length < 3) return;
    const mean = values.reduce((sum, item) => sum + item.value, 0) / values.length;
    const variance = values.reduce((sum, item) => sum + (item.value - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance) || 1;
    values.forEach((item, idx) => {
      const zScore = Math.round(((item.value - mean) / stdDev) * 100) / 100;
      const prior = idx > 0 ? values[idx - 1].value : undefined;
      const changePct = prior !== undefined && prior !== 0 ? (item.value - prior) / Math.abs(prior) : undefined;
      const absZ = Math.abs(zScore);
      const absChange = Math.abs(changePct ?? 0);
      if (absZ < 1.7 && absChange < 0.35) return;
      const severity: 'watch' | 'warning' | 'critical' = absZ >= 2.3 || absChange >= 0.75
        ? 'critical'
        : absZ >= 1.9 || absChange >= 0.5
          ? 'warning'
          : 'watch';
      const reasons = [
        absZ >= 1.7 ? `z-score ${zScore}` : '',
        absChange >= 0.35 && changePct !== undefined ? `${Math.round(changePct * 1000) / 10}% vs prior` : '',
      ].filter(Boolean);
      anomalies.push({
        field: profile.label,
        label: item.label,
        ref: item.ref,
        value: item.value,
        prior,
        changePct: changePct === undefined ? undefined : Math.round(changePct * 10000) / 10000,
        zScore,
        severity,
        reason: reasons.join('; '),
        action: severity === 'critical'
          ? 'Escalate owner review before using this metric in a decision.'
          : severity === 'warning'
            ? 'Validate source, timing, and whether this is a real operating change.'
            : 'Watch in the next refresh and compare against forecast.',
      });
    });
  });

  anomalies.sort((a, b) => {
    const severityRank = { critical: 3, warning: 2, watch: 1 };
    const severityDiff = severityRank[b.severity] - severityRank[a.severity];
    if (severityDiff) return severityDiff;
    return Math.abs(b.zScore || 0) - Math.abs(a.zScore || 0);
  });

  const criticalCount = anomalies.filter((item) => item.severity === 'critical').length;
  const warningCount = anomalies.filter((item) => item.severity === 'warning').length;
  const watchCount = anomalies.filter((item) => item.severity === 'watch').length;
  cells.D4 = { value: 'Signal Summary', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells.D5 = { value: 'Critical', format: { bold: true, bgColor: '#fee2e2', color: '#0f172a', align: 'center' } };
  cells.E5 = { value: String(criticalCount), format: { bold: true, bgColor: '#fee2e2', numberFormat: 'integer', align: 'right', color: '#0f172a' } };
  cells.D6 = { value: 'Warnings', format: { bold: true, bgColor: '#fef3c7', color: '#0f172a', align: 'center' } };
  cells.E6 = { value: String(warningCount), format: { bold: true, bgColor: '#fef3c7', numberFormat: 'integer', align: 'right', color: '#0f172a' } };
  cells.D7 = { value: 'Watch', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a', align: 'center' } };
  cells.E7 = { value: String(watchCount), format: { bold: true, bgColor: '#eff6ff', numberFormat: 'integer', align: 'right', color: '#0f172a' } };

  const tableStart = 10;
  cells[cellRef(0, tableStart)] = { value: 'Anomaly Queue', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Severity', 'Field', 'Context', 'Cell', 'Value', 'Prior', 'Change', 'Z-Score', 'Reason', 'Recommended Action'].forEach((header, col) => {
    cells[cellRef(col, tableStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  if (!anomalies.length) {
    cells[cellRef(0, tableStart + 2)] = {
      value: numericProfiles.length ? 'No anomaly signals detected in the selected range.' : 'Anomaly monitor needs at least one numeric field.',
      format: { italic: true, color: '#166534', bgColor: '#dcfce7' },
    };
  } else {
    anomalies.slice(0, 40).forEach((item, idx) => {
      const row = tableStart + 2 + idx;
      const fill = item.severity === 'critical' ? '#fee2e2' : item.severity === 'warning' ? '#fef3c7' : '#eff6ff';
      [
        item.severity,
        item.field,
        item.label,
        item.ref,
        item.value,
        item.prior ?? '',
        item.changePct ?? '',
        item.zScore ?? '',
        item.reason,
        item.action,
      ].forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: fill,
            color: '#0f172a',
            bold: col === 0 || col === 1 || col === 3,
            numberFormat: col === 6 ? 'percent' : col >= 4 && col <= 7 ? 'decimal2' : 'general',
            align: col >= 4 && col <= 7 ? 'right' : col === 0 ? 'center' : 'left',
          },
        };
      });
    });
  }

  return {
    name: `${sourceSheet.name || 'Sheet'} Anomaly`,
    cells,
    colWidths: { 0: 100, 1: 150, 2: 160, 3: 90, 4: 120, 5: 120, 6: 110, 7: 100, 8: 260, 9: 430 },
    rowHeights: { 0: 34, 1: 28, 3: 30, [tableStart]: 30, [tableStart + 1]: 30 },
    maxCol: 9,
    maxRow: Math.max(tableStart + 2, tableStart + 2 + Math.min(40, anomalies.length)),
    frozenRows: tableStart + 2,
    frozenCols: 4,
  };
}

export function buildSpreadsheetCorrelationSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const series = collectSpreadsheetNumericSeries(sourceSheet, refs);
  const pairs = calculateSpreadsheetCorrelations(sourceSheet, refs);
  const bounds = selectedBounds(sourceSheet, refs);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const strongest = pairs[0];
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Correlation Lab`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Pearson correlation matrix generated from numeric fields in the selected range. Use this to spot driver relationships before forecasting or modeling.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Relationship Signal', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B4: { value: 'Detail', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    D4: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    E4: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };

  if (series.length < 2 || !pairs.length) {
    cells.A5 = { value: 'Not enough numeric variation', format: { bold: true, bgColor: '#fef3c7', color: '#0f172a' } };
    cells.B5 = { value: 'Correlation analysis needs at least two numeric columns with changing values.', format: { bgColor: '#fef3c7', color: '#0f172a' } };
    return {
      name: `${sourceSheet.name || 'Sheet'} Correlation`,
      cells,
      colWidths: { 0: 220, 1: 520, 2: 24, 3: 120, 4: 180 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 4,
      maxRow: 5,
      frozenRows: 4,
      frozenCols: 0,
    };
  }

  cells.A5 = { value: `${strongest.strength} ${strongest.direction}`, format: { bold: true, bgColor: Math.abs(strongest.correlation) >= 0.65 ? '#dcfce7' : '#eff6ff', color: '#0f172a' } };
  cells.B5 = {
    value: `${strongest.leftLabel} and ${strongest.rightLabel} correlate at ${formatDisplayValue(String(strongest.correlation), 'decimal2')} across ${strongest.sampleSize} matched rows.`,
    format: { bgColor: '#eff6ff', color: '#0f172a' },
  };
  cells.D5 = { value: 'Numeric fields', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E5 = { value: String(series.length), format: { bgColor: '#f8fafc', numberFormat: 'integer', align: 'right' } };

  const matrixStartRow = 8;
  cells[cellRef(0, matrixStartRow)] = { value: 'Correlation Matrix', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  cells[cellRef(0, matrixStartRow + 1)] = { value: 'Field', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  series.forEach((item, idx) => {
    cells[cellRef(idx + 1, matrixStartRow + 1)] = { value: item.label, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
    cells[cellRef(0, matrixStartRow + 2 + idx)] = { value: item.label, format: { bold: true, color: '#0f172a', bgColor: idx % 2 === 0 ? '#f8fafc' : '#eef6ff' } };
  });

  series.forEach((rowItem, rowIdx) => {
    series.forEach((colItem, colIdx) => {
      const pair = rowItem.col === colItem.col
        ? { correlation: 1, strength: 'very strong' as const }
        : pairs.find((item) => (
          (item.leftCol === rowItem.col && item.rightCol === colItem.col)
          || (item.leftCol === colItem.col && item.rightCol === rowItem.col)
        ));
      const correlation = pair?.correlation ?? 0;
      const abs = Math.abs(correlation);
      const fill = rowItem.col === colItem.col
        ? '#dbeafe'
        : abs >= 0.85
          ? '#dcfce7'
          : abs >= 0.65
            ? '#fef3c7'
            : abs >= 0.4
              ? '#ffedd5'
              : '#f8fafc';
      cells[cellRef(colIdx + 1, matrixStartRow + 2 + rowIdx)] = {
        value: String(correlation),
        format: {
          bgColor: fill,
          color: '#0f172a',
          numberFormat: 'decimal2',
          align: 'right',
          bold: abs >= 0.85 || rowItem.col === colItem.col,
        },
      };
    });
  });

  const pairStart = matrixStartRow + series.length + 4;
  cells[cellRef(0, pairStart)] = { value: 'Top Relationships', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Metric A', 'Metric B', 'Correlation', 'Strength', 'Rows', 'Modeling Move'].forEach((header, idx) => {
    cells[cellRef(idx, pairStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  pairs.slice(0, 8).forEach((item, idx) => {
    const row = pairStart + 2 + idx;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    const move = Math.abs(item.correlation) >= 0.65
      ? 'Use as candidate driver in forecast or scenario model.'
      : Math.abs(item.correlation) >= 0.4
        ? 'Review before modeling; relationship is directional but not decisive.'
        : 'Weak relation; avoid assuming causality.';
    [item.leftLabel, item.rightLabel, item.correlation, `${item.strength} ${item.direction}`, item.sampleSize, move].forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: col === 2 && Math.abs(item.correlation) >= 0.65 ? '#dcfce7' : fill,
          color: '#0f172a',
          numberFormat: col === 2 ? 'decimal2' : col === 4 ? 'integer' : 'general',
          align: col === 2 || col === 4 ? 'right' : 'left',
          bold: col === 0 || col === 1,
        },
      };
    });
  });

  const noteRow = pairStart + Math.min(8, pairs.length) + 4;
  cells[cellRef(0, noteRow)] = { value: 'Analyst Note', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  cells[cellRef(0, noteRow + 1)] = {
    value: 'Correlation shows relationship strength, not causation. Validate source quality, time ordering, and outliers before making decisions.',
    format: { bgColor: '#eff6ff', color: '#0f172a' },
  };

  const colWidths: Record<number, number> = { 0: 180 };
  series.forEach((item, idx) => {
    colWidths[idx + 1] = Math.max(100, Math.min(180, item.label.length * 9 + 38));
  });
  [1, 2, 3, 4, 5].forEach((col) => {
    colWidths[col] = Math.max(colWidths[col] || 0, col === 5 ? 340 : 130);
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Correlation`,
    cells,
    colWidths,
    rowHeights: { 0: 34, 1: 28, 3: 30, [matrixStartRow]: 30, [matrixStartRow + 1]: 30, [pairStart]: 30, [pairStart + 1]: 30, [noteRow]: 30 },
    maxCol: Math.max(series.length, 5),
    maxRow: noteRow + 1,
    frozenRows: matrixStartRow + 2,
    frozenCols: 1,
  };
}

export function buildSpreadsheetCleanRoomSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const headerRow = bounds.minRow;
  const usedHeaders = new Set<string>();
  const headers: string[] = [];
  for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
    const raw = getDisplayValue(sourceSheet.cells[cellRef(col, headerRow)], sourceSheet.cells);
    headers.push(normalizeSpreadsheetHeader(raw, col - bounds.minCol, usedHeaders));
  }

  const cells: Record<string, CellData> = {
    A1: { value: 'Source Row', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B1: { value: 'QA Status', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
  };
  headers.forEach((header, idx) => {
    cells[cellRef(idx + 2, 0)] = {
      value: header,
      format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' },
    };
  });

  const signatures = new Map<string, number>();
  let outputRow = 1;
  let skippedBlankRows = 0;
  for (let row = headerRow + 1; row <= bounds.maxRow; row++) {
    const cleanedValues: Array<{ value: string; format?: CellFormat; changed: boolean; formula: boolean }> = [];
    let filled = 0;
    for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
      const sourceCell = sourceSheet.cells[cellRef(col, row)];
      const display = getDisplayValue(sourceCell, sourceSheet.cells);
      const cleaned = cleanSpreadsheetCellValue(display);
      cleanedValues.push({ ...cleaned, formula: Boolean(sourceCell?.formula) });
      if (cleaned.value) filled += 1;
    }
    if (!filled) {
      skippedBlankRows += 1;
      continue;
    }

    const signature = cleanedValues.map((item) => item.value.toLowerCase()).join('\u001f');
    const prior = signatures.get(signature) || 0;
    signatures.set(signature, prior + 1);
    const statuses: string[] = [];
    if (cleanedValues.some((item) => item.changed)) statuses.push('trimmed/typed');
    if (cleanedValues.some((item) => item.formula)) statuses.push('formula flattened');
    if (prior > 0) statuses.push('possible duplicate');
    if (filled < cleanedValues.length) statuses.push('partial row');
    if (!statuses.length) statuses.push('clean');

    const fill = outputRow % 2 === 1 ? '#f8fafc' : '#eef6ff';
    cells[cellRef(0, outputRow)] = {
      value: String(row + 1),
      format: { bgColor: fill, numberFormat: 'integer', align: 'right', color: '#0f172a' },
    };
    cells[cellRef(1, outputRow)] = {
      value: statuses.join('; '),
      format: {
        bgColor: statuses.includes('clean') ? '#dcfce7' : statuses.includes('possible duplicate') ? '#fef3c7' : fill,
        color: '#0f172a',
      },
    };
    cleanedValues.forEach((item, idx) => {
      cells[cellRef(idx + 2, outputRow)] = {
        value: item.value,
        format: {
          ...(item.format || {}),
          bgColor: fill,
          color: '#0f172a',
        },
      };
    });
    outputRow += 1;
  }

  const summaryRow = outputRow + 2;
  cells[cellRef(0, summaryRow)] = { value: 'Clean Room Summary', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(0, summaryRow + 1)] = { value: 'Rows exported', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 1)] = { value: String(Math.max(0, outputRow - 1)), format: { bgColor: '#eff6ff', numberFormat: 'integer', align: 'right' } };
  cells[cellRef(0, summaryRow + 2)] = { value: 'Blank rows skipped', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 2)] = { value: String(skippedBlankRows), format: { bgColor: '#f8fafc', numberFormat: 'integer', align: 'right' } };
  cells[cellRef(0, summaryRow + 3)] = { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells[cellRef(1, summaryRow + 3)] = { value: `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`, format: { bgColor: '#eff6ff', color: '#0f172a' } };

  const colWidths: Record<number, number> = { 0: 90, 1: 170 };
  headers.forEach((header, idx) => {
    colWidths[idx + 2] = Math.max(110, Math.min(260, header.length * 9 + 42));
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Clean Room`,
    cells,
    colWidths,
    rowHeights: { 0: 30, [summaryRow]: 30 },
    maxCol: headers.length + 1,
    maxRow: summaryRow + 3,
    frozenRows: 1,
    frozenCols: 2,
  };
}

export function buildSpreadsheetDataDoctorSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const issues: Array<{
    location: string;
    field: string;
    severity: 'warning' | 'error' | 'info';
    issue: string;
    detail: string;
    fix: string;
  }> = [];
  const rowSignatures = new Map<string, number>();
  const numericValuesByCol = new Map<number, Array<{ ref: string; value: number }>>();

  profiles.forEach((profile) => {
    if (profile.type === 'mixed') {
      issues.push({
        location: colToLetter(profile.col),
        field: profile.label,
        severity: 'warning',
        issue: 'Mixed data type',
        detail: `${profile.numericCount} numeric and ${profile.textCount} text values detected.`,
        fix: 'Normalize this column before formulas, pivots, or charts.',
      });
    }
    if (profile.totalRows > 0 && profile.blankCount / profile.totalRows >= 0.25) {
      issues.push({
        location: colToLetter(profile.col),
        field: profile.label,
        severity: 'warning',
        issue: 'High blank rate',
        detail: `${profile.blankCount}/${profile.totalRows} rows are blank.`,
        fix: 'Fill missing values, remove incomplete rows, or mark blanks intentionally.',
      });
    }
    if (profile.type === 'empty') {
      issues.push({
        location: colToLetter(profile.col),
        field: profile.label,
        severity: 'info',
        issue: 'Empty field',
        detail: 'No values were found below the header.',
        fix: 'Delete this field or populate it before sharing the workbook.',
      });
    }
  });

  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const rowValues: string[] = [];
    let filled = 0;
    for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
      const ref = cellRef(col, row);
      const cell = sourceSheet.cells[ref];
      const raw = String(getDisplayValue(cell, sourceSheet.cells)).trim();
      rowValues.push(raw.toLowerCase());
      if (raw) filled += 1;
      if (cell?.formula && raw.startsWith('#')) {
        issues.push({
          location: ref,
          field: profiles.find((profile) => profile.col === col)?.label || colToLetter(col),
          severity: 'error',
          issue: 'Formula error',
          detail: `${cell.formula} currently returns ${raw}.`,
          fix: 'Open Formula+ to trace dependencies and broken references.',
        });
      }
      const numeric = Number(raw.replace(/,/g, '').replace(/%$/, ''));
      if (Number.isFinite(numeric)) {
        const values = numericValuesByCol.get(col) || [];
        values.push({ ref, value: numeric });
        numericValuesByCol.set(col, values);
      }
    }
    if (!filled) continue;
    if (filled < rowValues.length) {
      issues.push({
        location: `Row ${row + 1}`,
        field: 'Row completeness',
        severity: 'warning',
        issue: 'Partial row',
        detail: `${filled}/${rowValues.length} cells have values.`,
        fix: 'Complete required fields or move this row into a staging area.',
      });
    }
    const signature = rowValues.join('\u001f');
    const firstRow = rowSignatures.get(signature);
    if (firstRow !== undefined) {
      issues.push({
        location: `Row ${row + 1}`,
        field: 'Duplicate row',
        severity: 'warning',
        issue: 'Possible duplicate',
        detail: `Matches row ${firstRow + 1} across the analyzed range.`,
        fix: 'Keep one row, merge differences, or add a unique identifier.',
      });
    } else {
      rowSignatures.set(signature, row);
    }
  }

  numericValuesByCol.forEach((items, col) => {
    if (items.length < 4) return;
    const values = items.map((item) => item.value);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (!stdDev) return;
    const field = profiles.find((profile) => profile.col === col)?.label || colToLetter(col);
    items
      .filter((item) => Math.abs((item.value - avg) / stdDev) >= 1.7)
      .slice(0, 5)
      .forEach((item) => {
        issues.push({
          location: item.ref,
          field,
          severity: 'info',
          issue: 'Numeric outlier',
          detail: `${formatDisplayValue(String(item.value), 'decimal2')} is far from the column average ${formatDisplayValue(String(avg), 'decimal2')}.`,
          fix: 'Check source data, unit scale, and whether this point should be excluded.',
        });
      });
  });

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.filter((issue) => issue.severity === 'info').length;
  const qualityScore = Math.max(0, Math.round(100 - errorCount * 18 - warningCount * 7 - infoCount * 2));
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Data Doctor`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Automated QA scan for blanks, duplicates, mixed types, formula errors, and statistical outliers.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Quality Score', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B4: { value: 'Errors', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    C4: { value: 'Warnings', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    D4: { value: 'Info', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    E4: { value: 'Source Range', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: String(qualityScore), format: { bold: true, bgColor: qualityScore >= 80 ? '#dcfce7' : qualityScore >= 60 ? '#fef3c7' : '#fee2e2', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    B5: { value: String(errorCount), format: { bold: true, bgColor: errorCount ? '#fee2e2' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    C5: { value: String(warningCount), format: { bold: true, bgColor: warningCount ? '#fef3c7' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    D5: { value: String(infoCount), format: { bold: true, bgColor: infoCount ? '#eff6ff' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    E5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };
  const headers = ['Severity', 'Issue', 'Location', 'Field', 'Detail', 'Recommended Fix'];
  headers.forEach((header, col) => {
    cells[cellRef(col, 7)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  if (!issues.length) {
    cells.A9 = { value: 'No data quality issues detected in the analyzed range.', format: { italic: true, color: '#166534', bgColor: '#dcfce7' } };
  } else {
    issues.forEach((item, idx) => {
      const row = idx + 8;
      const fill = item.severity === 'error' ? '#fee2e2' : item.severity === 'warning' ? '#fef3c7' : '#eff6ff';
      [item.severity, item.issue, item.location, item.field, item.detail, item.fix].forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value,
          format: {
            bgColor: fill,
            color: '#0f172a',
            bold: col === 0 || col === 1,
            align: col === 0 ? 'center' : 'left',
          },
        };
      });
    });
  }

  return {
    name: `${sourceSheet.name || 'Sheet'} Data Doctor`,
    cells,
    colWidths: { 0: 100, 1: 170, 2: 110, 3: 160, 4: 360, 5: 420 },
    rowHeights: { 0: 34, 1: 28, 3: 30, 7: 30 },
    maxCol: 5,
    maxRow: Math.max(9, 8 + issues.length),
    frozenRows: 8,
    frozenCols: 2,
  };
}

function shortList(items: string[], limit = 10): string {
  if (!items.length) return '';
  const head = items.slice(0, limit).join(', ');
  const remaining = items.length - limit;
  return remaining > 0 ? `${head} +${remaining} more` : head;
}

export function extractFormulaReferences(formula: string): string[] {
  const body = formula.startsWith('=') ? formula.slice(1) : formula;
  const cleaned = body.replace(/\$/g, '').toUpperCase();
  const refs = new Set<string>();
  const rangePattern = /\b([A-Z]{1,3}\d+)\s*:\s*([A-Z]{1,3}\d+)\b/g;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangePattern.exec(cleaned)) !== null) {
    expandRange(`${rangeMatch[1]}:${rangeMatch[2]}`).forEach((ref) => refs.add(ref));
  }
  const withoutRanges = cleaned.replace(rangePattern, ' ');
  const refPattern = /\b[A-Z]{1,3}\d+\b/g;
  const refMatches = withoutRanges.match(refPattern) || [];
  refMatches.forEach((ref) => refs.add(ref));
  return [...refs].sort((a, b) => {
    const parsedA = parseCellRef(a);
    const parsedB = parseCellRef(b);
    if (!parsedA || !parsedB) return a.localeCompare(b);
    return parsedA.row === parsedB.row ? parsedA.col - parsedB.col : parsedA.row - parsedB.row;
  });
}

export function buildSpreadsheetFormulaAuditSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const explicitSelection = refs ? new Set(refs.map((ref) => ref.replace(/\$/g, '').toUpperCase())) : null;
  const formulaRows: Array<{
    ref: string;
    formula: string;
    value: string;
    references: string[];
    missingRefs: string[];
    status: string;
    risk: string;
    severity: 'ok' | 'warning' | 'error';
  }> = [];
  const volatilePattern = /\b(NOW|TODAY|RAND|RANDBETWEEN|OFFSET|INDIRECT)\s*\(/i;
  const externalPattern = /(?:'[^']+'|[A-Z0-9_ ]+)!\$?[A-Z]{1,3}\$?\d+/i;

  Object.entries(sourceSheet.cells)
    .filter(([, cell]) => Boolean(cell.formula))
    .forEach(([rawRef, cell]) => {
      const normalizedRef = rawRef.replace(/\$/g, '').toUpperCase();
      const parsed = parseCellRef(normalizedRef);
      if (!parsed) return;
      const inBounds = parsed.col >= bounds.minCol && parsed.col <= bounds.maxCol && parsed.row >= bounds.minRow && parsed.row <= bounds.maxRow;
      if (!inBounds || (explicitSelection && !explicitSelection.has(normalizedRef))) return;
      const formula = cell.formula || '';
      const references = extractFormulaReferences(formula);
      const missingRefs = references.filter((ref) => {
        const referenced = sourceSheet.cells[ref];
        return !referenced || (!String(referenced.value).trim() && !referenced.formula);
      });
      const value = getDisplayValue(cell, sourceSheet.cells);
      const risks: string[] = [];
      let status = 'OK';
      let severity: 'ok' | 'warning' | 'error' = 'ok';
      if (String(value).startsWith('#')) {
        status = 'Formula error';
        severity = 'error';
        risks.push(`Current result is ${value}`);
      }
      if (missingRefs.length) {
        status = severity === 'error' ? 'Error + broken ref' : 'Broken ref';
        severity = 'error';
        risks.push(`Missing or blank references: ${shortList(missingRefs, 8)}`);
      }
      if (externalPattern.test(formula)) {
        if (severity !== 'error') {
          status = 'Review external ref';
          severity = 'warning';
        }
        risks.push('Uses another sheet/workbook reference');
      }
      if (volatilePattern.test(formula)) {
        if (severity === 'ok') {
          status = 'Volatile';
          severity = 'warning';
        }
        risks.push('Volatile function can change on recalculation');
      }
      if (!references.length && !risks.length) {
        status = 'Manual check';
        severity = 'warning';
        risks.push('No cell references detected');
      }
      formulaRows.push({
        ref: normalizedRef,
        formula,
        value,
        references,
        missingRefs,
        status,
        risk: risks.length ? risks.join('; ') : 'No issues detected',
        severity,
      });
    });

  formulaRows.sort((a, b) => {
    const parsedA = parseCellRef(a.ref);
    const parsedB = parseCellRef(b.ref);
    if (!parsedA || !parsedB) return a.ref.localeCompare(b.ref);
    return parsedA.row === parsedB.row ? parsedA.col - parsedB.col : parsedA.row - parsedB.row;
  });

  const brokenCount = formulaRows.filter((row) => row.missingRefs.length > 0).length;
  const errorCount = formulaRows.filter((row) => String(row.value).startsWith('#')).length;
  const volatileCount = formulaRows.filter((row) => volatilePattern.test(row.formula)).length;
  const externalCount = formulaRows.filter((row) => externalPattern.test(row.formula)).length;
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;

  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Formula Audit`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Scans formulas, evaluated output, dependencies, broken references, volatile functions, and external links.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Formula cells', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    B4: { value: 'Broken refs', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    C4: { value: 'Error outputs', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    D4: { value: 'Volatile', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    E4: { value: 'External refs', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    F4: { value: 'Source range', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: String(formulaRows.length), format: { bold: true, bgColor: '#eff6ff', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    B5: { value: String(brokenCount), format: { bold: true, bgColor: brokenCount ? '#fee2e2' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    C5: { value: String(errorCount), format: { bold: true, bgColor: errorCount ? '#fee2e2' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    D5: { value: String(volatileCount), format: { bold: true, bgColor: volatileCount ? '#fef3c7' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    E5: { value: String(externalCount), format: { bold: true, bgColor: externalCount ? '#fef3c7' : '#dcfce7', numberFormat: 'integer', align: 'right', color: '#0f172a' } },
    F5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };
  const headers = ['Cell', 'Formula', 'Current Value', 'References', 'Missing References', 'Status', 'Risk'];
  headers.forEach((header, col) => {
    cells[cellRef(col, 7)] = {
      value: header,
      format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' },
    };
  });

  if (!formulaRows.length) {
    cells.A9 = { value: 'No formulas found in the selected range.', format: { italic: true, color: '#64748b', bgColor: '#f8fafc' } };
  } else {
    formulaRows.forEach((item, idx) => {
      const row = idx + 8;
      const fill = item.severity === 'error' ? '#fee2e2' : item.severity === 'warning' ? '#fef3c7' : idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      const values = [
        item.ref,
        item.formula,
        item.value,
        shortList(item.references, 12),
        shortList(item.missingRefs, 8),
        item.status,
        item.risk,
      ];
      values.forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: fill,
            color: '#0f172a',
            bold: col === 0 || col === 5,
            align: col === 2 ? 'right' : col === 5 ? 'center' : 'left',
            numberFormat: col === 2 && Number.isFinite(Number(value)) ? 'decimal2' : 'general',
          },
        };
      });
    });
  }

  return {
    name: `${sourceSheet.name || 'Sheet'} Formula Audit`,
    cells,
    colWidths: { 0: 90, 1: 300, 2: 120, 3: 240, 4: 220, 5: 140, 6: 420 },
    rowHeights: { 0: 34, 1: 28, 3: 30, 7: 30 },
    maxCol: 6,
    maxRow: Math.max(9, 8 + formulaRows.length),
    frozenRows: 8,
    frozenCols: 1,
  };
}

export function buildSpreadsheetExecutiveBriefSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const insights = generateSpreadsheetInsights(sourceSheet, refs);
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const filledCells = profiles.reduce((sum, profile) => sum + profile.filledCount, 0);
  const blankCells = profiles.reduce((sum, profile) => sum + profile.blankCount, 0);
  const totalCells = filledCells + blankCells || 1;
  const warningCount = insights.filter((insight) => insight.severity === 'warning').length;
  const qualityScore = Math.max(0, Math.round(100 - (blankCells / totalCells) * 45 - warningCount * 12));
  const numericProfiles = profiles.filter((profile) => profile.type === 'numeric');
  const categoryProfiles = profiles.filter((profile) => profile.type === 'category' || profile.type === 'mixed');
  const topMetrics = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)).slice(0, 4);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Executive Brief`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Generated from the selected range as a decision-ready workbook brief.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Decision Snapshot', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Rows analyzed', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: String(Math.max(0, bounds.maxRow - bounds.minRow)), format: { bgColor: '#f8fafc', numberFormat: 'integer', align: 'right' } },
    A7: { value: 'Fields', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: String(profiles.length), format: { bgColor: '#eff6ff', numberFormat: 'integer', align: 'right' } },
    A8: { value: 'Numeric fields', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B8: { value: String(numericProfiles.length), format: { bgColor: '#f8fafc', numberFormat: 'integer', align: 'right' } },
    A9: { value: 'Grouping fields', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B9: { value: String(categoryProfiles.length), format: { bgColor: '#eff6ff', numberFormat: 'integer', align: 'right' } },
    A10: { value: 'Data quality score', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B10: { value: String(qualityScore), format: { bold: true, bgColor: qualityScore >= 80 ? '#dcfce7' : qualityScore >= 60 ? '#fef3c7' : '#fee2e2', numberFormat: 'integer', align: 'right' } },
    D4: { value: 'Recommended Action', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D5: {
      value: warningCount
        ? 'Clean warnings before relying on forecasts or pivots.'
        : numericProfiles.length
          ? 'Ready for dashboard, pivot, and lightweight forecast review.'
          : 'Add numeric metrics to unlock deeper modeling.',
      format: { bgColor: warningCount ? '#fef3c7' : '#dcfce7', color: '#0f172a' },
    },
    A13: { value: 'Top Metrics', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A14: { value: 'Metric', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    B14: { value: 'Sum', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    C14: { value: 'Average', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D14: { value: 'Min', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    E14: { value: 'Max', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
  };

  if (!topMetrics.length) {
    cells.A15 = { value: 'No numeric metrics found.', format: { italic: true, color: '#64748b', bgColor: '#f8fafc' } };
  } else {
    topMetrics.forEach((summary, idx) => {
      const row = 14 + idx + 1;
      const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      [summary.label, summary.sum, summary.avg, summary.min, summary.max].forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(value),
          format: {
            bgColor: fill,
            color: '#0f172a',
            bold: col === 0,
            numberFormat: col === 0 ? 'general' : 'decimal2',
            align: col === 0 ? 'left' : 'right',
          },
        };
      });
    });
  }

  const insightStartRow = 21;
  cells[cellRef(0, insightStartRow)] = { value: 'Key Insights', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  cells[cellRef(0, insightStartRow + 1)] = { value: 'Insight', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(1, insightStartRow + 1)] = { value: 'Detail', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  cells[cellRef(2, insightStartRow + 1)] = { value: 'Severity', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  insights.slice(0, 6).forEach((insight, idx) => {
    const row = insightStartRow + 2 + idx;
    const fill = insight.severity === 'warning' ? '#fef3c7' : insight.severity === 'success' ? '#dcfce7' : '#eff6ff';
    cells[cellRef(0, row)] = { value: insight.title, format: { bold: true, bgColor: fill, color: '#0f172a' } };
    cells[cellRef(1, row)] = { value: insight.detail, format: { bgColor: fill, color: '#0f172a' } };
    cells[cellRef(2, row)] = { value: insight.severity, format: { bgColor: fill, color: '#0f172a', align: 'center' } };
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Executive Brief`,
    cells,
    colWidths: { 0: 180, 1: 220, 2: 120, 3: 220, 4: 120 },
    rowHeights: { 0: 34, 1: 28, 3: 30, 12: 30, [insightStartRow]: 30 },
    maxCol: 4,
    maxRow: insightStartRow + Math.max(7, insights.length + 1),
    frozenRows: 4,
    frozenCols: 0,
  };
}

export function buildSpreadsheetKpiStudioSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const summaries = analyzeSpreadsheetRange(sourceSheet, refs);
  const insights = generateSpreadsheetInsights(sourceSheet, refs);
  const correlations = calculateSpreadsheetCorrelations(sourceSheet, refs);
  const metric = [...summaries].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum))[0];
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} KPI Studio`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Decision cockpit generated from the selected range: KPI trend, segment leaderboard, data health, and next actions.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Command Center', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Primary Metric', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    B5: { value: 'Current', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    C5: { value: 'Prior', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    D5: { value: 'Delta', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    E5: { value: 'Target', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    F5: { value: 'Gap', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    G5: { value: 'Health', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
    I4: { value: 'Readout', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    I5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    J5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
  };

  if (!metric) {
    cells.A7 = {
      value: 'KPI Studio needs at least one numeric metric column.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} KPI Studio`,
      cells,
      colWidths: { 0: 180, 1: 130, 2: 130, 3: 130, 4: 130, 5: 130, 6: 110, 8: 150, 9: 260 },
      rowHeights: { 0: 34, 1: 28, 3: 30, 4: 30 },
      maxCol: 9,
      maxRow: 7,
      frozenRows: 5,
      frozenCols: 0,
    };
  }

  const detailRows: Array<{ row: number; label: string; value: number }> = [];
  const labelCol = dimension?.col ?? bounds.minCol;
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const label = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
    if (isAggregateRowLabel(label)) continue;
    const raw = String(getDisplayValue(sourceSheet.cells[cellRef(metric.col, row)], sourceSheet.cells)).trim();
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, '').replace(/%$/, ''));
    if (Number.isFinite(value)) detailRows.push({ row, label, value });
  }

  const duplicateRows = new Map<string, number>();
  let duplicateCount = 0;
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const values: string[] = [];
    let filled = 0;
    for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
      const raw = String(getDisplayValue(sourceSheet.cells[cellRef(col, row)], sourceSheet.cells)).trim().toLowerCase();
      values.push(raw);
      if (raw) filled += 1;
    }
    if (!filled) continue;
    const signature = values.join('\u001f');
    const prior = duplicateRows.get(signature) || 0;
    if (prior > 0) duplicateCount += 1;
    duplicateRows.set(signature, prior + 1);
  }

  const blankCount = profiles.reduce((sum, profile) => sum + profile.blankCount, 0);
  const mixedCount = profiles.filter((profile) => profile.type === 'mixed').length;
  const healthScore = Math.max(0, Math.round(100 - blankCount * 4 - mixedCount * 12 - duplicateCount * 10));
  const current = detailRows.length ? detailRows[detailRows.length - 1].value : metric.sum;
  const prior = detailRows.length >= 2 ? detailRows[detailRows.length - 2].value : metric.avg;
  const target = Math.round(current * 1.15 * 100) / 100;
  const delta = Math.round((current - prior) * 100) / 100;
  const gap = Math.round((target - current) * 100) / 100;
  const healthFill = healthScore >= 85 ? '#dcfce7' : healthScore >= 65 ? '#fef3c7' : '#fee2e2';

  [
    metric.label,
    current,
    prior,
    delta,
    target,
    gap,
    healthScore,
  ].forEach((value, col) => {
    cells[cellRef(col, 5)] = {
      value: String(value),
      format: {
        bgColor: col === 6 ? healthFill : '#eff6ff',
        color: '#0f172a',
        bold: col === 0 || col === 1 || col === 6,
        numberFormat: col === 0 ? 'general' : col === 6 ? 'integer' : 'decimal2',
        align: col === 0 ? 'left' : 'right',
      },
    };
  });

  cells.I6 = { value: 'Signal', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.J6 = {
    value: delta >= 0 ? `${metric.label} is up vs prior period.` : `${metric.label} is down vs prior period.`,
    format: { bgColor: delta >= 0 ? '#dcfce7' : '#fee2e2', color: '#0f172a' },
  };
  cells.I7 = { value: 'Data health', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.J7 = {
    value: `${healthScore}/100 from ${blankCount} blanks, ${mixedCount} mixed fields, ${duplicateCount} duplicate rows.`,
    format: { bgColor: healthFill, color: '#0f172a' },
  };
  cells.I8 = { value: 'Driver', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.J8 = {
    value: correlations[0]
      ? `${correlations[0].leftLabel} -> ${correlations[0].rightLabel}: ${correlations[0].strength} ${correlations[0].direction}`
      : insights[0]?.detail || 'No driver correlation detected yet.',
    format: { bgColor: '#f8fafc', color: '#0f172a' },
  };

  const groups = new Map<string, { count: number; sum: number; min: number; max: number }>();
  detailRows.forEach((item) => {
    const currentGroup = groups.get(item.label) || { count: 0, sum: 0, min: Infinity, max: -Infinity };
    currentGroup.count += 1;
    currentGroup.sum += item.value;
    currentGroup.min = Math.min(currentGroup.min, item.value);
    currentGroup.max = Math.max(currentGroup.max, item.value);
    groups.set(item.label, currentGroup);
  });

  const leaderboardStart = 9;
  cells[cellRef(0, leaderboardStart)] = { value: 'Segment Leaderboard', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Segment', 'Sum', 'Average', 'Count', 'Share', 'Rank', 'Action'].forEach((header, col) => {
    cells[cellRef(col, leaderboardStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  const groupRows = [...groups.entries()]
    .sort((a, b) => Math.abs(b[1].sum) - Math.abs(a[1].sum))
    .slice(0, 10);
  const totalAbs = groupRows.reduce((sum, [, item]) => sum + Math.abs(item.sum), 0) || 1;
  if (!groupRows.length) {
    cells[cellRef(0, leaderboardStart + 2)] = { value: 'No segment rows found for leaderboard analysis.', format: { italic: true, color: '#64748b', bgColor: '#f8fafc' } };
  } else {
    groupRows.forEach(([label, item], idx) => {
      const row = leaderboardStart + 2 + idx;
      const share = Math.abs(item.sum) / totalAbs;
      const action = idx === 0
        ? 'Double down, protect capacity, and inspect what changed.'
        : share >= 0.35
          ? 'Reduce concentration risk with a second growth lever.'
          : item.sum < 0
            ? 'Investigate negative contribution and owner follow-up.'
            : 'Track weekly and compare against target gap.';
      const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      [label, item.sum, item.sum / item.count, item.count, share, idx + 1, action].forEach((value, col) => {
        cells[cellRef(col, row)] = {
          value: String(Math.round(Number(value) * 10000) / 10000 || value),
          format: {
            bgColor: col === 6 ? '#eff6ff' : fill,
            color: '#0f172a',
            bold: col === 0 || col === 5,
            numberFormat: col === 4 ? 'percent' : col > 0 && col < 4 ? 'decimal2' : col === 5 ? 'integer' : 'general',
            align: col === 0 || col === 6 ? 'left' : 'right',
          },
        };
      });
    });
  }

  const trendStart = leaderboardStart + Math.max(14, groupRows.length + 5);
  cells[cellRef(0, trendStart)] = { value: 'Trend Watch', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Period', metric.label, 'Change', 'Growth', 'Signal'].forEach((header, col) => {
    cells[cellRef(col, trendStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  detailRows.slice(-8).forEach((item, idx, rows) => {
    const row = trendStart + 2 + idx;
    const priorValue = idx > 0 ? rows[idx - 1].value : null;
    const change = priorValue === null ? '' : Math.round((item.value - priorValue) * 100) / 100;
    const growth = priorValue === null || priorValue === 0 ? '' : Math.round(((item.value - priorValue) / Math.abs(priorValue)) * 10000) / 10000;
    const signal = priorValue === null ? 'Baseline' : Number(change) >= 0 ? 'Improving' : 'Needs attention';
    const fill = signal === 'Needs attention' ? '#fee2e2' : signal === 'Improving' ? '#dcfce7' : '#f8fafc';
    [item.label, item.value, change, growth, signal].forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: fill,
          color: '#0f172a',
          bold: col === 0 || col === 4,
          numberFormat: col === 3 ? 'percent' : col > 0 && col < 3 ? 'decimal2' : 'general',
          align: col === 0 || col === 4 ? 'left' : 'right',
        },
      };
    });
  });

  const actionStart = trendStart + Math.max(12, Math.min(8, detailRows.length) + 4);
  cells[cellRef(0, actionStart)] = { value: 'Action Queue', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Priority', 'Move', 'Owner Prompt'].forEach((header, col) => {
    cells[cellRef(col, actionStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  const actions = [
    ['P1', gap > 0 ? `Close ${formatDisplayValue(String(gap), 'decimal2')} gap to target.` : 'Target cleared; convert upside into next target.', 'Assign KPI owner and update target weekly.'],
    ['P1', groupRows[0] ? `Protect ${groupRows[0][0]} as the leading segment.` : 'Pick a segment owner.', 'Use the leaderboard to decide who acts first.'],
    ['P2', healthScore < 85 ? 'Fix workbook health before executive sharing.' : 'Workbook health is board-ready.', 'Run Doctor+ and Clean+ when the score drops.'],
    ['P2', correlations[0] ? `Validate ${correlations[0].leftLabel}/${correlations[0].rightLabel} relationship.` : 'Add a second numeric driver for correlation.', 'Use Correlation+ before forecast decisions.'],
  ];
  actions.forEach((action, idx) => {
    const row = actionStart + 2 + idx;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    action.forEach((value, col) => {
      cells[cellRef(col, row)] = { value, format: { bgColor: fill, color: '#0f172a', bold: col === 0 } };
    });
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} KPI Studio`,
    cells,
    colWidths: { 0: 190, 1: 130, 2: 130, 3: 110, 4: 110, 5: 90, 6: 360, 7: 24, 8: 150, 9: 390 },
    rowHeights: { 0: 34, 1: 28, 3: 30, 4: 30, [leaderboardStart]: 30, [leaderboardStart + 1]: 30, [trendStart]: 30, [trendStart + 1]: 30, [actionStart]: 30, [actionStart + 1]: 30 },
    maxCol: 9,
    maxRow: actionStart + 5,
    frozenRows: 5,
    frozenCols: 0,
  };
}

export function buildSpreadsheetVarianceControlSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const numericProfiles = profiles.filter((profile) => profile.type === 'numeric');
  const actualProfile = numericProfiles.find((profile) => /actual|current|revenue|sales|value|실적|매출/i.test(profile.label))
    || [...numericProfiles].sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
  const planProfile = numericProfiles.find((profile) => (
    profile.col !== actualProfile?.col
    && /budget|plan|target|forecast|goal|quota|prior|예산|목표|계획/i.test(profile.label)
  )) || numericProfiles.find((profile) => profile.col !== actualProfile?.col);
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.col !== actualProfile?.col && profile.col !== planProfile?.col && profile.filledCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Variance Control`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Actual-vs-plan control sheet with variance formulas, risk bands, owner actions, and executive readout.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Control Setup', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Actual field', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: actualProfile?.label || 'Missing actual metric', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    A7: { value: 'Plan field', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: planProfile?.label || 'Missing budget/target metric', format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A8: { value: 'Dimension', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B8: { value: dimension?.label || 'Row order', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    D4: { value: 'Executive Signal', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
  };

  if (!actualProfile || !planProfile) {
    cells.A11 = {
      value: 'Variance control needs at least two numeric columns such as Actual and Budget/Target.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Variance`,
      cells,
      colWidths: { 0: 180, 1: 260, 3: 180 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 3,
      maxRow: 11,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const varianceRows: Array<{ label: string; actual: number; plan: number; variance: number; variancePct: number }> = [];
  const labelCol = dimension?.col ?? bounds.minCol;
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const label = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
    if (isAggregateRowLabel(label)) continue;
    const actualRaw = String(getDisplayValue(sourceSheet.cells[cellRef(actualProfile.col, row)], sourceSheet.cells)).trim();
    const planRaw = String(getDisplayValue(sourceSheet.cells[cellRef(planProfile.col, row)], sourceSheet.cells)).trim();
    const actual = Number(actualRaw.replace(/,/g, '').replace(/%$/, ''));
    const plan = Number(planRaw.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isFinite(actual) || !Number.isFinite(plan)) continue;
    const variance = Math.round((actual - plan) * 100) / 100;
    const variancePct = plan === 0 ? 0 : Math.round((variance / Math.abs(plan)) * 10000) / 10000;
    varianceRows.push({ label, actual, plan, variance, variancePct });
  }

  if (!varianceRows.length) {
    cells.A11 = {
      value: 'No matched actual/plan numeric rows found in the selected range.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Variance`,
      cells,
      colWidths: { 0: 420 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 0,
      maxRow: 11,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const totalActual = Math.round(varianceRows.reduce((sum, row) => sum + row.actual, 0) * 100) / 100;
  const totalPlan = Math.round(varianceRows.reduce((sum, row) => sum + row.plan, 0) * 100) / 100;
  const totalVariance = Math.round((totalActual - totalPlan) * 100) / 100;
  const totalVariancePct = totalPlan === 0 ? 0 : Math.round((totalVariance / Math.abs(totalPlan)) * 10000) / 10000;
  const riskRows = varianceRows.filter((row) => Math.abs(row.variancePct) >= 0.1).length;
  const worst = [...varianceRows].sort((a, b) => Math.abs(b.variancePct) - Math.abs(a.variancePct))[0];
  const signalFill = Math.abs(totalVariancePct) >= 0.2 ? '#fee2e2' : Math.abs(totalVariancePct) >= 0.1 ? '#fef3c7' : '#dcfce7';

  cells.D5 = { value: 'Total actual', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.E5 = { value: String(totalActual), format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right', bold: true } };
  cells.D6 = { value: 'Total plan', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E6 = { value: String(totalPlan), format: { bgColor: '#f8fafc', numberFormat: 'decimal2', align: 'right' } };
  cells.D7 = { value: 'Variance %', format: { bold: true, bgColor: signalFill, color: '#0f172a' } };
  cells.E7 = { value: String(totalVariancePct), format: { bgColor: signalFill, numberFormat: 'percent', align: 'right', bold: true } };
  cells.D8 = { value: 'Rows at risk', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.E8 = { value: String(riskRows), format: { bgColor: '#eff6ff', numberFormat: 'integer', align: 'right' } };
  cells.D9 = { value: 'Largest gap', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E9 = { value: worst ? `${worst.label} (${formatDisplayValue(String(worst.variancePct), 'percent')})` : 'No gap', format: { bgColor: '#f8fafc', color: '#0f172a' } };

  const tableStart = 12;
  cells[cellRef(0, tableStart)] = { value: 'Variance Table', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Dimension', 'Actual', 'Plan', 'Variance', 'Variance %', 'Status', 'Action'].forEach((header, col) => {
    cells[cellRef(col, tableStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  varianceRows
    .sort((a, b) => Math.abs(b.variancePct) - Math.abs(a.variancePct))
    .forEach((item, idx) => {
      const row = tableStart + 2 + idx;
      const excelRow = row + 1;
      const absPct = Math.abs(item.variancePct);
      const fill = absPct >= 0.2 ? '#fee2e2' : absPct >= 0.1 ? '#fef3c7' : idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
      cells[cellRef(0, row)] = { value: item.label, format: { bold: true, bgColor: fill, color: '#0f172a' } };
      cells[cellRef(1, row)] = { value: String(item.actual), format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
      cells[cellRef(2, row)] = { value: String(item.plan), format: { bgColor: fill, numberFormat: 'decimal2', align: 'right' } };
      cells[cellRef(3, row)] = { value: '', formula: `=B${excelRow}-C${excelRow}`, format: { bgColor: fill, numberFormat: 'decimal2', align: 'right', bold: true } };
      cells[cellRef(4, row)] = { value: '', formula: `=D${excelRow}/C${excelRow}`, format: { bgColor: fill, numberFormat: 'percent', align: 'right', bold: true } };
      cells[cellRef(5, row)] = {
        value: '',
        formula: `=IF(E${excelRow}>=0.2,"Critical",IF(E${excelRow}<=-0.2,"Critical",IF(E${excelRow}>=0.1,"Watch",IF(E${excelRow}<=-0.1,"Watch","On track"))))`,
        format: { bgColor: fill, color: '#0f172a', bold: true, align: 'center' },
      };
      cells[cellRef(6, row)] = {
        value: absPct >= 0.2
          ? 'Assign owner, explain root cause, and update recovery plan.'
          : absPct >= 0.1
            ? 'Review driver and confirm whether variance is timing or structural.'
            : 'Keep cadence and monitor next refresh.',
        format: { bgColor: fill, color: '#0f172a' },
      };
    });

  const actionStart = tableStart + varianceRows.length + 5;
  cells[cellRef(0, actionStart)] = { value: 'Control Actions', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Priority', 'Owner Question', 'Decision Move'].forEach((header, col) => {
    cells[cellRef(col, actionStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  const controlActions = [
    ['P1', worst ? `Why is ${worst.label} off plan by ${formatDisplayValue(String(worst.variancePct), 'percent')}?` : 'Which row is furthest from plan?', 'Separate timing variance from structural miss.'],
    ['P1', totalVariance >= 0 ? 'Can upside be converted into a higher target?' : 'What specific lever closes the total gap?', totalVariance >= 0 ? 'Raise forecast or lock repeatable driver.' : 'Assign recovery owner and date.'],
    ['P2', `${riskRows} row${riskRows === 1 ? '' : 's'} need review.`, 'Use the variance table as the weekly operating agenda.'],
  ];
  controlActions.forEach((action, idx) => {
    const row = actionStart + 2 + idx;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    action.forEach((value, col) => {
      cells[cellRef(col, row)] = { value, format: { bgColor: fill, color: '#0f172a', bold: col === 0 } };
    });
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Variance`,
    cells,
    colWidths: { 0: 190, 1: 130, 2: 130, 3: 130, 4: 110, 5: 110, 6: 430 },
    rowHeights: { 0: 34, 1: 28, 3: 30, [tableStart]: 30, [tableStart + 1]: 30, [actionStart]: 30, [actionStart + 1]: 30 },
    maxCol: 6,
    maxRow: actionStart + 4,
    frozenRows: tableStart + 2,
    frozenCols: 1,
  };
}

function runSpreadsheetSolverAllocation(candidates: SpreadsheetSolverCandidate[], budget: number): SpreadsheetSolverAllocation[] {
  let remaining = budget;
  return candidates.map((candidate) => {
    const possibleUnits = candidate.costPerUnit > 0
      ? Math.min(candidate.maxUnits, Math.max(0, remaining / candidate.costPerUnit))
      : candidate.maxUnits;
    const units = Math.floor(possibleUnits * 10000) / 10000;
    const allocatedCost = Math.round(units * candidate.costPerUnit * 100) / 100;
    const expectedReturn = Math.round(units * candidate.objectivePerUnit * 100) / 100;
    remaining = Math.max(0, remaining - allocatedCost);
    return {
      ...candidate,
      units,
      allocatedCost,
      expectedReturn,
    };
  });
}

export function buildSpreadsheetSolverSheet(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const profiles = profileSpreadsheetRange(sourceSheet, refs);
  const numericProfiles = profiles.filter((profile) => profile.type === 'numeric');
  const objectiveProfile = numericProfiles.find((profile) => /profit|margin|revenue|sales|arr|bookings|value|return|score|actual|매출|수익|이익/i.test(profile.label))
    || [...numericProfiles].sort((a, b) => Math.abs(b.sum || 0) - Math.abs(a.sum || 0))[0];
  const costProfile = numericProfiles.find((profile) => (
    profile.col !== objectiveProfile?.col
    && /cost|spend|expense|budget|investment|price|cac|opex|capex|비용|예산|투자/i.test(profile.label)
  )) || numericProfiles.find((profile) => profile.col !== objectiveProfile?.col);
  const capacityProfile = numericProfiles.find((profile) => (
    profile.col !== objectiveProfile?.col
    && profile.col !== costProfile?.col
    && /capacity|units|qty|quantity|hours|headcount|limit|max|inventory|용량|수량|한도/i.test(profile.label)
  ));
  const dimension = profiles.find((profile) => profile.type === 'category' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.type === 'mixed' && profile.uniqueCount > 0)
    || profiles.find((profile) => profile.col !== objectiveProfile?.col && profile.col !== costProfile?.col && profile.filledCount > 0);
  const rangeLabel = `${cellRef(bounds.minCol, bounds.minRow)}:${cellRef(bounds.maxCol, bounds.maxRow)}`;
  const cells: Record<string, CellData> = {
    A1: { value: `${sourceSheet.name || 'Sheet'} Solver`, format: { bold: true, fontSize: 18, color: '#0f172a' } },
    A2: { value: 'Goal-seeking optimizer that ranks options, allocates constrained budget, and writes the decision moves into the workbook.', format: { italic: true, color: '#475569' } },
    A4: { value: 'Solver Setup', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } },
    A5: { value: 'Source range', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B5: { value: rangeLabel, format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A6: { value: 'Objective field', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B6: { value: objectiveProfile?.label || 'Missing objective metric', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    A7: { value: 'Constraint field', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } },
    B7: { value: costProfile?.label || 'Missing cost/budget metric', format: { bgColor: '#eff6ff', color: '#0f172a' } },
    A8: { value: 'Capacity field', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } },
    B8: { value: capacityProfile?.label || '1 unit per row', format: { bgColor: '#f8fafc', color: '#0f172a' } },
    D4: { value: 'Decision Signal', format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } },
  };

  if (!objectiveProfile || !costProfile) {
    cells.A11 = {
      value: 'Solver+ needs at least two numeric columns: one objective/return metric and one cost/budget constraint.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Solver`,
      cells,
      colWidths: { 0: 180, 1: 280, 3: 180 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 3,
      maxRow: 11,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const labelCol = dimension?.col ?? bounds.minCol;
  const candidates: SpreadsheetSolverCandidate[] = [];
  for (let row = bounds.minRow + 1; row <= bounds.maxRow; row++) {
    const label = String(getDisplayValue(sourceSheet.cells[cellRef(labelCol, row)], sourceSheet.cells)).trim() || `Row ${row + 1}`;
    if (isAggregateRowLabel(label)) continue;
    const objectiveRaw = String(getDisplayValue(sourceSheet.cells[cellRef(objectiveProfile.col, row)], sourceSheet.cells)).trim();
    const costRaw = String(getDisplayValue(sourceSheet.cells[cellRef(costProfile.col, row)], sourceSheet.cells)).trim();
    const objective = Number(objectiveRaw.replace(/,/g, '').replace(/%$/, ''));
    const cost = Number(costRaw.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isFinite(objective) || !Number.isFinite(cost) || cost <= 0) continue;
    const capacityRaw = capacityProfile
      ? String(getDisplayValue(sourceSheet.cells[cellRef(capacityProfile.col, row)], sourceSheet.cells)).trim()
      : '';
    const parsedCapacity = Number(capacityRaw.replace(/,/g, '').replace(/%$/, ''));
    const maxUnits = Number.isFinite(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : 1;
    const objectivePerUnit = objective / maxUnits;
    const costPerUnit = cost / maxUnits;
    candidates.push({
      label,
      objective,
      cost,
      maxUnits,
      objectivePerUnit,
      costPerUnit,
      roi: Math.round((objectivePerUnit / costPerUnit) * 10000) / 10000,
    });
  }

  if (!candidates.length) {
    cells.A11 = {
      value: 'No valid solver rows found. Add positive cost and objective values below the header row.',
      format: { italic: true, color: '#64748b', bgColor: '#f8fafc' },
    };
    return {
      name: `${sourceSheet.name || 'Sheet'} Solver`,
      cells,
      colWidths: { 0: 420 },
      rowHeights: { 0: 34, 1: 28, 3: 30 },
      maxCol: 0,
      maxRow: 11,
      frozenRows: 0,
      frozenCols: 0,
    };
  }

  const ranked = candidates.sort((a, b) => b.roi - a.roi || b.objective - a.objective);
  const totalCost = ranked.reduce((sum, item) => sum + item.cost, 0);
  const budget = Math.round(totalCost * 0.6 * 100) / 100;
  const allocation = runSpreadsheetSolverAllocation(ranked, budget);
  const totalAllocated = Math.round(allocation.reduce((sum, item) => sum + item.allocatedCost, 0) * 100) / 100;
  const totalReturn = Math.round(allocation.reduce((sum, item) => sum + item.expectedReturn, 0) * 100) / 100;
  const coverage = totalCost === 0 ? 0 : Math.round((totalAllocated / totalCost) * 10000) / 10000;
  const best = allocation.find((item) => item.units > 0) || allocation[0];
  const signalFill = totalReturn >= budget ? '#dcfce7' : totalReturn >= budget * 0.7 ? '#fef3c7' : '#fee2e2';

  cells.D5 = { value: 'Budget', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.E5 = { value: String(budget), format: { bgColor: '#eff6ff', numberFormat: 'decimal2', align: 'right', bold: true } };
  cells.D6 = { value: 'Expected return', format: { bold: true, bgColor: signalFill, color: '#0f172a' } };
  cells.E6 = { value: String(totalReturn), format: { bgColor: signalFill, numberFormat: 'decimal2', align: 'right', bold: true } };
  cells.D7 = { value: 'Budget used', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E7 = { value: String(totalAllocated), format: { bgColor: '#f8fafc', numberFormat: 'decimal2', align: 'right' } };
  cells.D8 = { value: 'Coverage', format: { bold: true, bgColor: '#eff6ff', color: '#0f172a' } };
  cells.E8 = { value: String(coverage), format: { bgColor: '#eff6ff', numberFormat: 'percent', align: 'right' } };
  cells.D9 = { value: 'First move', format: { bold: true, bgColor: '#f8fafc', color: '#0f172a' } };
  cells.E9 = { value: best ? `${best.label} (${formatDisplayValue(String(Math.round(best.roi * 100) / 100), 'decimal2')} ROI)` : 'No move', format: { bgColor: '#f8fafc', color: '#0f172a' } };

  const tableStart = 12;
  cells[cellRef(0, tableStart)] = { value: 'Solver Allocation', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Rank', 'Option', 'Objective / Unit', 'Cost / Unit', 'ROI', 'Recommended Units', 'Allocated Cost', 'Expected Return', 'Decision'].forEach((header, col) => {
    cells[cellRef(col, tableStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });

  allocation.forEach((item, idx) => {
    const row = tableStart + 2 + idx;
    const excelRow = row + 1;
    const fill = item.units <= 0 ? '#f8fafc' : idx === 0 ? '#dcfce7' : idx % 2 === 0 ? '#eef6ff' : '#f8fafc';
    const decision = item.units >= item.maxUnits
      ? 'Fund fully'
      : item.units > 0
        ? 'Fund partially'
        : 'Hold unless budget expands';
    [
      idx + 1,
      item.label,
      item.objectivePerUnit,
      item.costPerUnit,
      item.roi,
      item.units,
      '',
      '',
      decision,
    ].forEach((value, col) => {
      const ref = cellRef(col, row);
      const formula = col === 6 ? `=D${excelRow}*F${excelRow}` : col === 7 ? `=C${excelRow}*F${excelRow}` : undefined;
      cells[ref] = {
        value: String(value),
        formula,
        format: {
          bgColor: col === 8 ? '#eff6ff' : fill,
          color: '#0f172a',
          bold: col === 0 || col === 1 || col === 4 || col === 8,
          numberFormat: col === 0 ? 'integer' : col >= 2 && col <= 7 ? 'decimal2' : 'general',
          align: col === 1 || col === 8 ? 'left' : 'right',
        },
      };
    });
  });

  const frontierStart = tableStart + allocation.length + 5;
  cells[cellRef(0, frontierStart)] = { value: 'Tradeoff Frontier', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Budget Level', 'Budget', 'Expected Return', 'Budget Used', 'Coverage', 'Signal'].forEach((header, col) => {
    cells[cellRef(col, frontierStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  [0.25, 0.5, 0.75, 1].forEach((level, idx) => {
    const row = frontierStart + 2 + idx;
    const scenarioBudget = Math.round(totalCost * level * 100) / 100;
    const scenarioAllocation = runSpreadsheetSolverAllocation(ranked, scenarioBudget);
    const scenarioReturn = Math.round(scenarioAllocation.reduce((sum, item) => sum + item.expectedReturn, 0) * 100) / 100;
    const scenarioUsed = Math.round(scenarioAllocation.reduce((sum, item) => sum + item.allocatedCost, 0) * 100) / 100;
    const scenarioCoverage = totalCost === 0 ? 0 : Math.round((scenarioUsed / totalCost) * 10000) / 10000;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    [level, scenarioBudget, scenarioReturn, scenarioUsed, scenarioCoverage, scenarioReturn >= scenarioBudget ? 'Efficient' : 'Review constraints'].forEach((value, col) => {
      cells[cellRef(col, row)] = {
        value: String(value),
        format: {
          bgColor: col === 5 ? (scenarioReturn >= scenarioBudget ? '#dcfce7' : '#fef3c7') : fill,
          color: '#0f172a',
          bold: col === 0 || col === 5,
          numberFormat: col === 0 || col === 4 ? 'percent' : col >= 1 && col <= 3 ? 'decimal2' : 'general',
          align: col === 5 ? 'left' : 'right',
        },
      };
    });
  });

  const actionStart = frontierStart + 8;
  cells[cellRef(0, actionStart)] = { value: 'Optimization Actions', format: { bold: true, color: '#ffffff', bgColor: '#0f172a', align: 'center' } };
  ['Priority', 'Move', 'Owner Prompt'].forEach((header, col) => {
    cells[cellRef(col, actionStart + 1)] = { value: header, format: { bold: true, color: '#ffffff', bgColor: '#1f6feb', align: 'center' } };
  });
  [
    ['P1', `Fund ${best.label} first; it has the highest objective per constraint unit.`, 'Confirm the constraint is real and not an accounting artifact.'],
    ['P1', `Allocate ${formatDisplayValue(String(totalAllocated), 'decimal2')} of ${formatDisplayValue(String(budget), 'decimal2')} available budget.`, 'Approve or adjust the budget cell before sharing.'],
    ['P2', allocation.some((item) => item.units > 0 && item.units < item.maxUnits) ? 'One option is partially funded; decide whether partial execution is valid.' : 'No partial allocation in this run.', 'Use capacity and minimum-order rules if partial execution is invalid.'],
  ].forEach((action, idx) => {
    const row = actionStart + 2 + idx;
    const fill = idx % 2 === 0 ? '#f8fafc' : '#eef6ff';
    action.forEach((value, col) => {
      cells[cellRef(col, row)] = { value, format: { bgColor: fill, color: '#0f172a', bold: col === 0 } };
    });
  });

  return {
    name: `${sourceSheet.name || 'Sheet'} Solver`,
    cells,
    colWidths: { 0: 90, 1: 190, 2: 140, 3: 120, 4: 90, 5: 140, 6: 130, 7: 140, 8: 240 },
    rowHeights: { 0: 34, 1: 28, 3: 30, [tableStart]: 30, [tableStart + 1]: 30, [frontierStart]: 30, [frontierStart + 1]: 30, [actionStart]: 30, [actionStart + 1]: 30 },
    maxCol: 8,
    maxRow: actionStart + 4,
    frozenRows: tableStart + 2,
    frozenCols: 1,
  };
}

export function buildSpreadsheetExecutiveWorkbookSheets(sourceSheet: SheetData, refs?: string[]): SheetData[] {
  return [
    buildSpreadsheetExecutiveBriefSheet(sourceSheet, refs),
    buildSpreadsheetKpiStudioSheet(sourceSheet, refs),
    buildSpreadsheetVarianceControlSheet(sourceSheet, refs),
    buildSpreadsheetSolverSheet(sourceSheet, refs),
    buildSpreadsheetCleanRoomSheet(sourceSheet, refs),
    buildSpreadsheetDataDoctorSheet(sourceSheet, refs),
    buildSpreadsheetFormulaAuditSheet(sourceSheet, refs),
    buildSpreadsheetWaterfallBridgeSheet(sourceSheet, refs),
    buildSpreadsheetAnomalyMonitorSheet(sourceSheet, refs),
    buildSpreadsheetDashboardSheet(sourceSheet, refs),
    buildSpreadsheetInsightSheet(sourceSheet, refs),
    buildSpreadsheetPivotSheet(sourceSheet, refs),
    buildSpreadsheetCorrelationSheet(sourceSheet, refs),
    buildSpreadsheetForecastSheet(sourceSheet, refs),
    buildSpreadsheetScenarioSheet(sourceSheet, refs),
    buildSpreadsheetSensitivitySheet(sourceSheet, refs),
  ];
}

function blendHex(start: string, end: string, amount: number): string {
  const clamp = Math.max(0, Math.min(1, amount));
  const parse = (hex: string) => {
    const clean = hex.replace('#', '');
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  };
  const a = parse(start);
  const b = parse(end);
  const mixed = a.map((value, idx) => Math.round(value + (b[idx] - value) * clamp));
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function applySpreadsheetHeatmap(sourceSheet: SheetData, refs?: string[]): SheetData {
  const bounds = selectedBounds(sourceSheet, refs);
  const numericCells: Array<{ ref: string; value: number }> = [];
  for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
    for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
      const ref = cellRef(col, row);
      const raw = getDisplayValue(sourceSheet.cells[ref], sourceSheet.cells);
      if (!String(raw).trim()) continue;
      const value = Number(String(raw).replace(/,/g, '').replace(/%$/, ''));
      if (Number.isFinite(value)) numericCells.push({ ref, value });
    }
  }
  if (!numericCells.length) return sourceSheet;
  const values = numericCells.map((cell) => cell.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const cells = { ...sourceSheet.cells };
  numericCells.forEach(({ ref, value }) => {
    const ratio = (value - min) / span;
    const bgColor = ratio < 0.5
      ? blendHex('#fee2e2', '#fef3c7', ratio * 2)
      : blendHex('#fef3c7', '#dcfce7', (ratio - 0.5) * 2);
    const existing = cells[ref] || { value: '' };
    cells[ref] = {
      ...existing,
      format: {
        ...(existing.format || {}),
        bgColor,
        color: '#0f172a',
        bold: ratio >= 0.85 ? true : existing.format?.bold,
      },
    };
  });
  return { ...sourceSheet, cells };
}

export function formatDisplayValue(raw: string, numberFormat?: string): string {
  if (!numberFormat || numberFormat === 'general') return raw;
  if (numberFormat === 'text') return raw;
  const num = parseFloat(raw);
  if ((numberFormat === 'date' || numberFormat === 'datetime' || numberFormat === 'time') && !isNaN(num)) {
    // Above the max Excel serial (2958466 = 9999-12-31) it must be a JS ms
    // timestamp; below, an Excel serial. 50000 wrongly flipped post-2036 dates.
    const d = new Date(num > 2958466 ? num : (num - 25569) * 86400000);
    if (isNaN(d.getTime())) return raw;
    if (numberFormat === 'date') return d.toLocaleDateString('ko-KR');
    if (numberFormat === 'datetime') return `${d.toLocaleDateString('ko-KR')} ${d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  if (isNaN(num)) return raw;
  switch (numberFormat) {
    case 'integer': return num.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
    case 'number': return num.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'decimal1': return num.toLocaleString('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case 'decimal2': return num.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'currency': return num.toLocaleString('ko-KR', { style: 'currency', currency: 'KRW' });
    case 'accounting': return num.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'percent': return (num * 100).toFixed(1) + '%';
    case 'scientific': return num.toExponential(2);
    default: return raw;
  }
}

/** Check if a cell is hidden by a merge (not the top-left of the merge) */
function isCellHiddenByMerge(col: number, row: number, merges: MergeRange[]): MergeRange | null {
  for (const m of merges) {
    if (row >= m.startRow && row <= m.endRow && col >= m.startCol && col <= m.endCol) {
      if (row !== m.startRow || col !== m.startCol) return m;
    }
  }
  return null;
}

function getMergeForCell(col: number, row: number, merges: MergeRange[]): MergeRange | null {
  for (const m of merges) {
    if (row === m.startRow && col === m.startCol) return m;
  }
  return null;
}

export function parseClipboardTable(text: string): string[][] {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized) return [];
  const trimmedEnd = normalized.replace(/\n+$/g, '');
  if (!trimmedEnd) return [];
  if (trimmedEnd.includes('\t')) {
    return trimmedEnd.split('\n').map((line) => line.split('\t'));
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < trimmedEnd.length; i++) {
    const ch = trimmedEnd[i];
    const next = trimmedEnd[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\n' && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.length > 0));
}

// ─── XLSX Parsing & Writing (SheetJS) ───────────────────────────────

// Maps our CellFormat.numberFormat values to Excel number-format codes (cell.z)
// so round-trips through SheetJS preserve the chosen format.
const NUMBER_FORMAT_CODES: Record<string, string> = {
  integer: '#,##0',
  number: '#,##0.00',
  decimal1: '0.0',
  decimal2: '0.00',
  currency: '₩#,##0',
  accounting: '_("$"* #,##0.00_)',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  time: 'hh:mm:ss',
  scientific: '0.00E+00',
  text: '@',
};

function numberFormatToCode(nf?: string): string | undefined {
  if (!nf || nf === 'general') return undefined;
  return NUMBER_FORMAT_CODES[nf];
}

function numberFormatFromCode(z: unknown): CellFormat['numberFormat'] | undefined {
  if (!z || typeof z !== 'string') return undefined;
  for (const [key, code] of Object.entries(NUMBER_FORMAT_CODES)) {
    if (z === code) return key as CellFormat['numberFormat'];
  }
  const lower = z.toLowerCase();
  if (lower === 'general') return undefined;
  if (z.includes('@')) return 'text';
  if (z.includes('%')) return 'percent';
  if (/e[+-]/i.test(z)) return 'scientific';
  const hasYear = lower.includes('y');
  const hasDay = lower.includes('d');
  const hasClock = lower.includes('h') || z.includes(':');
  if ((hasYear || hasDay) && hasClock) return 'datetime';
  if (hasYear || hasDay) return 'date';
  if (hasClock) return 'time';
  if (/[_(]/.test(z) && /[$₩€]/.test(z)) return 'accounting';
  if (/[$₩€]/.test(z)) return 'currency';
  const decimals = (z.match(/0\.(0+)/) || [])[1]?.length || 0;
  if (decimals >= 2) return z.includes(',') ? 'number' : 'decimal2';
  if (decimals === 1) return 'decimal1';
  return 'integer';
}

/**
 * Excel-style Ctrl+Arrow navigation: jumps to the edge of the current data
 * block, or to the next filled cell across a gap.
 */
export function jumpToDataEdge(
  sheet: Pick<SheetData, 'cells' | 'maxCol' | 'maxRow'>,
  col: number,
  row: number,
  dCol: number,
  dRow: number,
): { col: number; row: number } {
  const inBounds = (c: number, r: number) => c >= 0 && c <= sheet.maxCol && r >= 0 && r <= sheet.maxRow;
  const filled = (c: number, r: number) => {
    const cell = sheet.cells[cellRef(c, r)];
    return !!(cell && (cell.value !== '' || cell.formula));
  };
  let c = col, r = row;
  if (!inBounds(c + dCol, r + dRow)) return { col: c, row: r };
  if (filled(c, r) && filled(c + dCol, r + dRow)) {
    while (inBounds(c + dCol, r + dRow) && filled(c + dCol, r + dRow)) { c += dCol; r += dRow; }
    return { col: c, row: r };
  }
  c += dCol; r += dRow;
  while (inBounds(c + dCol, r + dRow) && !filled(c, r)) { c += dCol; r += dRow; }
  return { col: c, row: r };
}

/**
 * Applies a pending cell edit to a copy of `sheets` and returns the new array.
 * Mirrors commitEdit's rules so a save reflects the value being typed even
 * before the async setState has flushed. Used only for the save payload.
 */
function applyPendingEdit(
  sheets: SheetData[],
  sheetIdx: number,
  ref: string,
  editValue: string,
): SheetData[] {
  const sheet = sheets[sheetIdx];
  if (!sheet) return sheets;
  const parsed = parseCellRef(ref);
  const cells = { ...sheet.cells };
  const val = editValue;
  if (val.trim() === '') {
    delete cells[ref];
  } else {
    const existing = cells[ref] || { value: '' };
    cells[ref] = { ...existing, value: val, formula: val.startsWith('=') ? val : undefined };
  }
  const next = [...sheets];
  next[sheetIdx] = {
    ...sheet,
    cells,
    maxCol: parsed ? Math.max(sheet.maxCol, parsed.col) : sheet.maxCol,
    maxRow: parsed ? Math.max(sheet.maxRow, parsed.row) : sheet.maxRow,
  };
  return next;
}

async function parseXlsxData(base64DataUrl: string): Promise<SheetData[]> {
  const base64 = base64DataUrl.replace(/^data:[^;]+;base64,/, '');
  // 새 문서(0바이트 파일): XLSX.read가 던지므로 빈 워크시트 하나로 시작한다.
  if (!base64.trim()) {
    return [{ name: 'Sheet1', cells: {}, colWidths: {}, rowHeights: {}, maxCol: 10, maxRow: 30 }];
  }
  const XLSX = await import('xlsx-js-style');
  // Decode the data URL in one native pass (fetch → arrayBuffer) instead of a
  // per-character atob loop; fall back to atob if the webview rejects data URLs.
  let bytes: Uint8Array;
  try {
    const buf = await (await fetch(base64DataUrl)).arrayBuffer();
    bytes = new Uint8Array(buf);
    if (bytes.length === 0) throw new Error('empty');
  } catch {
    const binaryStr = atob(base64);
    bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
  }
  const workbook = XLSX.read(bytes, { type: 'array', cellStyles: true, cellNF: true });

  // Conditional-formatting rules ride along as a workbook custom property
  // (SheetJS cannot write native <conditionalFormatting>); harmless to Excel.
  let cfBySheet: Record<string, ConditionalRule[]> = {};
  try {
    const raw = (workbook.Custprops as Record<string, unknown> | undefined)?.bbaritConditionalRules;
    if (typeof raw === 'string') cfBySheet = JSON.parse(raw);
  } catch {
    cfBySheet = {};
  }
  // Formats saved by BBARIT: SheetJS's reader surfaces only fills from
  // styles.xml, so this restores font/alignment/border details on reload.
  let fmtBySheet: Record<string, Record<string, CellFormat>> = {};
  try {
    const raw = (workbook.Custprops as Record<string, unknown> | undefined)?.bbaritCellFormats;
    if (typeof raw === 'string') fmtBySheet = JSON.parse(raw);
  } catch {
    fmtBySheet = {};
  }

  const sheets: SheetData[] = [];
  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    if (!ws) continue;
    const cellsMap: Record<string, CellData> = {};
    const colWidths: Record<number, number> = {};
    const rowHeights: Record<number, number> = {};
    let maxCol = 0;
    let maxRow = 0;

    if (ws['!cols']) {
      for (let i = 0; i < ws['!cols'].length; i++) {
        const c = ws['!cols'][i];
        if (c && c.wpx) {
          colWidths[i] = Math.max(40, Math.round(c.wpx));
        } else if (c && c.wch) {
          colWidths[i] = Math.max(40, Math.round(c.wch * 8));
        }
      }
    }

    if (ws['!rows']) {
      for (let i = 0; i < ws['!rows'].length; i++) {
        const r = ws['!rows'][i];
        if (r && r.hpx) {
          rowHeights[i] = Math.max(18, Math.round(r.hpx));
        } else if (r && r.hpt) {
          rowHeights[i] = Math.max(18, Math.round(r.hpt * 1.333));
        }
      }
    }

    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { c: 0, r: 0 }, e: { c: 0, r: 0 } };
    maxCol = range.e.c;
    maxRow = range.e.r;

    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const xlCell = ws[addr];
        if (!xlCell) continue;

        const format: CellFormat = {};
        if (xlCell.s) {
          if (xlCell.s.font) {
            if (xlCell.s.font.bold) format.bold = true;
            if (xlCell.s.font.italic) format.italic = true;
            if (xlCell.s.font.underline) format.underline = true;
            if (xlCell.s.font.strike) format.strikethrough = true;
            if (xlCell.s.font.color?.rgb) format.color = '#' + xlCell.s.font.color.rgb;
            if (xlCell.s.font.sz) format.fontSize = Math.round(Number(xlCell.s.font.sz));
          }
          if (xlCell.s.fill?.fgColor?.rgb) {
            format.bgColor = '#' + xlCell.s.fill.fgColor.rgb;
          }
          if (xlCell.s.alignment?.horizontal) {
            const h = xlCell.s.alignment.horizontal;
            if (h === 'left' || h === 'center' || h === 'right') format.align = h;
          }
          if (xlCell.s.alignment?.wrapText) format.wrapText = true;
          if (xlCell.s.border) {
            const b: CellBorder = {};
            const set = (e: { style?: string } | undefined) => !!(e && e.style && e.style !== 'none');
            if (set(xlCell.s.border.top)) b.top = true;
            if (set(xlCell.s.border.bottom)) b.bottom = true;
            if (set(xlCell.s.border.left)) b.left = true;
            if (set(xlCell.s.border.right)) b.right = true;
            if (hasAnyBorder(b)) format.border = b;
          }
        }
        const nf = numberFormatFromCode(xlCell.z);
        if (nf) format.numberFormat = nf;
        // Keep the exact source code so currency/custom formats survive a
        // save (the bucket→code map is lossy, e.g. any currency → ₩#,##0).
        if (typeof xlCell.z === 'string' && xlCell.z && xlCell.z.toLowerCase() !== 'general') {
          format.rawNumberFormat = xlCell.z;
        }

        const ref = cellRef(C, R);
        const value = xlCell.v != null ? String(xlCell.v) : '';
        const formula = xlCell.f ? '=' + xlCell.f : undefined;
        // BBARIT-saved formats win over the reader's partial style info.
        const stored = fmtBySheet[sheetName]?.[ref];
        const merged = stored ? { ...format, ...stored } : format;

        cellsMap[ref] = {
          value,
          formula,
          format: Object.keys(merged).length > 0 ? merged : undefined,
        };
      }
    }

    // Format-only cells are written as stubs, which the reader drops — restore
    // them from the stored format map so empty-but-styled cells keep styling.
    for (const [ref, stored] of Object.entries(fmtBySheet[sheetName] || {})) {
      if (cellsMap[ref]) continue;
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      cellsMap[ref] = { value: '', format: stored };
      maxCol = Math.max(maxCol, parsed.col);
      maxRow = Math.max(maxRow, parsed.row);
    }

    // Parse merges
    const merges: MergeRange[] = [];
    if (ws['!merges']) {
      for (const m of ws['!merges']) {
        merges.push({
          startCol: m.s.c,
          startRow: m.s.r,
          endCol: m.e.c,
          endRow: m.e.r,
        });
      }
    }

    const freeze = paneToFreeze((ws as Record<string, unknown>)['!freeze']);

    sheets.push({
      name: sheetName,
      cells: cellsMap,
      colWidths,
      rowHeights,
      maxCol: Math.max(maxCol, 5),
      maxRow: Math.max(maxRow, 20),
      merges: merges.length > 0 ? merges : undefined,
      frozenRows: freeze.frozenRows || undefined,
      conditionalRules: cfBySheet[sheetName]?.length ? cfBySheet[sheetName] : undefined,
      frozenCols: freeze.frozenCols || undefined,
    });
  }

  if (sheets.length === 0) {
    sheets.push({ name: 'Sheet1', cells: {}, colWidths: {}, rowHeights: {}, maxCol: 10, maxRow: 30 });
  }

  return sheets;
}

async function writeXlsxToBase64(sheets: SheetData[]): Promise<string> {
  const XLSX = await import('xlsx-js-style');
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws: Record<string, unknown> = {};
    let minR = Infinity, maxR = 0, minC = Infinity, maxC = 0;

    for (const [ref, cellData] of Object.entries(sheet.cells)) {
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      // Keep format-only cells so styling survives a round-trip.
      if (!cellData.value && !cellData.formula && !cellData.format) continue;

      const { col, row } = parsed;
      minR = Math.min(minR, row);
      maxR = Math.max(maxR, row);
      minC = Math.min(minC, col);
      maxC = Math.max(maxC, col);

      const addr = XLSX.utils.encode_cell({ r: row, c: col });
      const xlCell: Record<string, unknown> = {};

      if (cellData.formula) {
        xlCell.f = cellData.formula.startsWith('=') ? cellData.formula.slice(1) : cellData.formula;
        // Cache the computed result as the cell value so external readers
        // (pandas/openpyxl data_only=True) see the number, not the formula text.
        const evaluated = evaluateFormula(cellData.formula, sheet.cells);
        if (evaluated === '' || FORMULA_ERROR_CODES.has(evaluated)) {
          xlCell.v = '';
          xlCell.t = 's';
        } else if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(evaluated)) {
          xlCell.v = parseFloat(evaluated);
          xlCell.t = 'n';
        } else {
          xlCell.v = evaluated;
          xlCell.t = 's';
        }
      } else {
        // Only treat as a number when the raw text is a plain decimal that
        // round-trips: this keeps leading-zero ids ("010") and would-be
        // scientific text ("1e5") as strings instead of silently mangling them.
        const isPlainNumber = /^-?(0|[1-9]\d*)(\.\d+)?$/.test(cellData.value);
        if (cellData.value !== '' && isPlainNumber) {
          xlCell.v = parseFloat(cellData.value);
          xlCell.t = 'n';
        } else if (cellData.value !== '') {
          xlCell.v = cellData.value;
          xlCell.t = 's';
        } else {
          xlCell.t = 'z';
        }
      }

      if (cellData.format) {
        const s: Record<string, unknown> = {};
        const font: Record<string, unknown> = {};
        if (cellData.format.bold) font.bold = true;
        if (cellData.format.italic) font.italic = true;
        if (cellData.format.underline) font.underline = true;
        if (cellData.format.strikethrough) font.strike = true;
        if (cellData.format.color) font.color = { rgb: cellData.format.color.replace('#', '') };
        if (cellData.format.fontSize) font.sz = cellData.format.fontSize;
        if (Object.keys(font).length > 0) s.font = font;
        if (cellData.format.bgColor) {
          s.fill = { fgColor: { rgb: cellData.format.bgColor.replace('#', '') } };
        }
        if (cellData.format.align || cellData.format.wrapText) {
          s.alignment = {
            ...(cellData.format.align ? { horizontal: cellData.format.align } : {}),
            ...(cellData.format.wrapText ? { wrapText: true } : {}),
          };
        }
        if (hasAnyBorder(cellData.format.border)) {
          const b = cellData.format.border!;
          const edge = { style: 'thin', color: { rgb: '000000' } };
          const border: Record<string, unknown> = {};
          if (b.top) border.top = edge;
          if (b.bottom) border.bottom = edge;
          if (b.left) border.left = edge;
          if (b.right) border.right = edge;
          s.border = border;
        }
        if (Object.keys(s).length > 0) xlCell.s = s;
        // Prefer the preserved source code so $/custom formats round-trip intact;
        // fall back to the bucket code for formats set inside the app.
        const code = cellData.format.rawNumberFormat || numberFormatToCode(cellData.format.numberFormat);
        if (code) xlCell.z = code;
      }

      ws[addr] = xlCell;
    }

    if (minR === Infinity) { minR = 0; maxR = 0; minC = 0; maxC = 0; }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });

    const cols: Array<{ wch?: number; wpx?: number } | undefined> = [];
    for (let c = 0; c <= maxC; c++) {
      if (sheet.colWidths[c]) {
        cols[c] = { wpx: sheet.colWidths[c] };
      }
    }
    if (cols.length > 0) ws['!cols'] = cols;

    const rows: Array<{ hpx?: number } | undefined> = [];
    for (let r = 0; r <= maxR; r++) {
      if (sheet.rowHeights[r]) {
        rows[r] = { hpx: sheet.rowHeights[r] };
      }
    }
    if (rows.length > 0) ws['!rows'] = rows;

    // Write merges
    if (sheet.merges && sheet.merges.length > 0) {
      ws['!merges'] = sheet.merges.map(m => ({
        s: { r: m.startRow, c: m.startCol },
        e: { r: m.endRow, c: m.endCol },
      }));
    }

    // Persist per-sheet freeze panes.
    const pane = freezeToPane(sheet.frozenRows || 0, sheet.frozenCols || 0);
    if (pane) ws['!freeze'] = pane;

    XLSX.utils.book_append_sheet(wb, ws as WorkSheet, sheet.name);
  }

  // Conditional-formatting rules survive save/reload via a custom property.
  const cfBySheet: Record<string, ConditionalRule[]> = {};
  for (const sheet of sheets) {
    if (sheet.conditionalRules?.length) cfBySheet[sheet.name] = sheet.conditionalRules;
  }
  if (Object.keys(cfBySheet).length > 0) {
    (wb as { Custprops?: Record<string, unknown> }).Custprops = {
      ...(wb as { Custprops?: Record<string, unknown> }).Custprops,
      bbaritConditionalRules: JSON.stringify(cfBySheet),
    };
  }

  // Full per-cell formats also ride along: Excel reads the native styles.xml we
  // write, but SheetJS's READER only surfaces fills — this keeps a BBARIT
  // save→reload lossless (underline, wrap, alignment, borders, …).
  const fmtBySheet: Record<string, Record<string, CellFormat>> = {};
  for (const sheet of sheets) {
    const formats: Record<string, CellFormat> = {};
    for (const [ref, cellData] of Object.entries(sheet.cells)) {
      if (cellData.format && Object.keys(cellData.format).length > 0) formats[ref] = cellData.format;
    }
    if (Object.keys(formats).length > 0) fmtBySheet[sheet.name] = formats;
  }
  if (Object.keys(fmtBySheet).length > 0) {
    const json = JSON.stringify(fmtBySheet);
    // Guard against pathological format counts blowing up docProps/custom.xml.
    if (json.length < 2_000_000) {
      (wb as { Custprops?: Record<string, unknown> }).Custprops = {
        ...(wb as { Custprops?: Record<string, unknown> }).Custprops,
        bbaritCellFormats: json,
      };
    }
  }

  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const bytes = new Uint8Array(buffer);
  // Encode in 32KB chunks instead of one char-at-a-time concat: same result,
  // far less per-byte overhead on large workbooks.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

// ─── Component ──────────────────────────────────────────────────────

export function XlsxEditor({ filePath, xlsxData, style, onSaved, onModifiedChange }: XlsxEditorProps) {
  // UI copy is standardized to English across all three editors.
  const L = useCallback((_ko: string, en: string) => en, []);
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modified, setModified] = useState(false);
  const [saveToast, setSaveToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [activeRibbonTab, setActiveRibbonTab] = useState<XlsxRibbonTab>('Home');

  // Selection
  const [selectedCell, setSelectedCell] = useState<string>('A1');
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [formulaBarValue, setFormulaBarValue] = useState('');
  const [showFormulaPicker, setShowFormulaPicker] = useState(false);
  const [formulaQuery, setFormulaQuery] = useState('');
  const [formulaRefPickActive, setFormulaRefPickActive] = useState(false);

  // Range selection
  const [selectionRange, setSelectionRange] = useState<{ startCol: number; startRow: number; endCol: number; endRow: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ col: number; row: number } | null>(null);

  // Multi-select (Cmd+Click)
  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set());

  // Formatting state for toolbar
  const [fmtBold, setFmtBold] = useState(false);
  const [fmtItalic, setFmtItalic] = useState(false);
  const [fmtUnderline, setFmtUnderline] = useState(false);
  const [fmtStrike, setFmtStrike] = useState(false);
  const [fmtWrap, setFmtWrap] = useState(false);
  const [fmtAlign, setFmtAlign] = useState<'left' | 'center' | 'right'>('left');
  const [fmtColor, setFmtColor] = useState('#ffffff');
  const [fmtBgColor, setFmtBgColor] = useState('#000000');
  const [fmtNumberFormat, setFmtNumberFormat] = useState<string>('general');
  const [fmtFontSize, setFmtFontSize] = useState(12);

  // Conditional formatting dropdown (Home > Styles)
  const [showCfDropdown, setShowCfDropdown] = useState(false);
  const [cfPending, setCfPending] = useState<'gt' | 'lt' | 'between' | 'eq' | 'contains' | 'top10' | null>(null);
  const [cfValue1, setCfValue1] = useState('');
  const [cfValue2, setCfValue2] = useState('');

  // Column resize state
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  // Row resize state
  const [resizingRow, setResizingRow] = useState<number | null>(null);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  // Sheet tab rename state
  const [renamingSheet, setRenamingSheet] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; type: 'cell' | 'col' | 'row' | 'sheet'; idx: number } | null>(null);
  // Name-box draft: null = mirror the selection, string = user is typing a ref.
  const [refDraft, setRefDraft] = useState<string | null>(null);

  // Undo/redo
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const suppressHistory = useRef(false);

  // Auto-fill
  const [autoFillDragging, setAutoFillDragging] = useState(false);
  const [autoFillTarget, setAutoFillTarget] = useState<{ col: number; row: number } | null>(null);

  // Filter
  const [filterCol, setFilterCol] = useState<number | null>(null);
  const [filterValues, setFilterValues] = useState<Set<string> | null>(null);
  const [filterDropdownCol, setFilterDropdownCol] = useState<number | null>(null);
  const [hiddenRows, setHiddenRows] = useState<Set<number>>(new Set());

  // Row + column virtualization
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(800);

  // Border dropdown
  const [showBorderDropdown, setShowBorderDropdown] = useState(false);

  // Search/Replace
  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [searchResults, setSearchResults] = useState<string[]>([]);
  // O(1) per-cell highlight lookup — Array.includes per rendered cell made
  // grid renders O(cells × matches) once a search had many hits.
  const searchResultSet = useMemo(() => new Set(searchResults), [searchResults]);
  const [searchIdx, setSearchIdx] = useState(0);

  // Number format dropdown
  const [showNumFmtDropdown, setShowNumFmtDropdown] = useState(false);

  // Clipboard for multi-cell copy/paste
  const clipboardRef = useRef<{ cells: Record<string, CellData>; startCol: number; startRow: number; endCol: number; endRow: number } | null>(null);
  const clipboardTextRef = useRef('');

  const gridRef = useRef<HTMLDivElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const formulaRefPickActiveRef = useRef(false);
  const formulaDragRef = useRef<string | null>(null);
  const selectEditTextOnFocusRef = useRef(false);
  const skipNextEditBlurRef = useRef(false);
  // Mirror of the latest sheets so a save can read committed data without
  // waiting for the async setState flush from an in-progress cell edit.
  const sheetsRef = useRef<SheetData[]>(sheets);
  const saveToastTimer = useRef<number | null>(null);
  // Last save failure message, surfaced to the agent bridge (xlsx.save).
  const lastSaveErrorRef = useRef<string>('');

  const activeSheet = sheets[activeSheetIdx] || null;
  const merges = activeSheet?.merges || [];
  // Freeze is stored per-sheet so it follows the active sheet on tab switch.
  const frozenRows = activeSheet?.frozenRows || 0;
  const frozenCols = activeSheet?.frozenCols || 0;
  // Live conditional formats: recompute when the sheet object changes (edits
  // replace the sheet identity, so this stays in sync with cell values).
  const cfMap = useMemo(
    () => (activeSheet ? computeConditionalFormatMap(activeSheet) : new Map<string, ConditionalCellStyle>()),
    [activeSheet],
  );

  const focusGrid = useCallback(() => {
    gridRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    formulaRefPickActiveRef.current = formulaRefPickActive;
  }, [formulaRefPickActive]);

  useEffect(() => {
    sheetsRef.current = sheets;
  }, [sheets]);

  // Keep the parent (EditorPanel) in sync with the dirty state.
  useEffect(() => {
    onModifiedChange?.(modified);
  }, [modified, onModifiedChange]);

  useEffect(() => {
    return () => {
      if (saveToastTimer.current) window.clearTimeout(saveToastTimer.current);
    };
  }, []);

  // ─── Load XLSX ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const parsed = await parseXlsxData(xlsxData);
        if (cancelled) return;
        setSheets(parsed);
        setActiveSheetIdx(0);
        setSelectedCell('A1');
        // Store the parsed array by reference (same copy-on-write rule as
        // pushHistory): every mutation replaces sheet/cells objects, so this
        // snapshot is never edited in place. Avoids a multi-MB JSON clone on load.
        undoStack.current = [{ sheets: parsed, activeSheetIdx: 0 }];
        redoStack.current = [];
        setCanUndo(false);
        setCanRedo(false);
      } catch (err) {
        console.error('[XlsxEditor] Failed to parse XLSX:', err);
        // Never fall back to a blank sheet: saving that would overwrite the
        // original file with an empty workbook. Surface the error and block save.
        if (!cancelled) {
          setSheets([]);
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [xlsxData]);

  // ─── History ────────────────────────────────────────────────────

  // History entries hold plain references, not deep clones: every sheet
  // mutation in this file is copy-on-write (fresh sheets array, fresh sheet
  // object, fresh cells map / cell objects), so a snapshotted array can never
  // be edited in place. The previous JSON round-trip serialized the entire
  // workbook on every cell commit / format click — tens of MB on big sheets.
  const pushHistory = useCallback(() => {
    if (suppressHistory.current) return;
    const entry: HistoryEntry = { sheets, activeSheetIdx };
    undoStack.current.push(entry);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setModified(true);
  }, [sheets, activeSheetIdx]);

  const handleUndo = useCallback(() => {
    if (undoStack.current.length <= 1) return;
    const current = undoStack.current.pop()!;
    redoStack.current.push(current);
    const prev = undoStack.current[undoStack.current.length - 1];
    suppressHistory.current = true;
    setSheets(prev.sheets);
    setActiveSheetIdx(prev.activeSheetIdx);
    suppressHistory.current = false;
    setCanUndo(undoStack.current.length > 1);
    setCanRedo(true);
  }, []);

  const handleRedo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current.pop()!;
    undoStack.current.push(next);
    suppressHistory.current = true;
    setSheets(next.sheets);
    setActiveSheetIdx(next.activeSheetIdx);
    suppressHistory.current = false;
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  // ─── Sheet operations ─────────────────────────────────────────

  // Duplicate names crash xlsx's book_append_sheet at save time — always
  // uniquify. Excel's own constraints: ≤31 chars, no []:*?/\ characters.
  const sanitizeSheetName = useCallback((raw: string) => {
    return raw.replace(/[[\]:*?/\\]/g, '').trim().slice(0, 31);
  }, []);

  const uniqueSheetName = useCallback((base: string, excludeIdx?: number) => {
    const names = new Set(sheets.filter((_, i) => i !== excludeIdx).map(s => s.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} (${n})`.slice(0, 31))) n++;
    return `${base} (${n})`.slice(0, 31);
  }, [sheets]);

  const addSheet = useCallback(() => {
    pushHistory();
    const name = uniqueSheetName(`Sheet${sheets.length + 1}`);
    const newSheet: SheetData = { name, cells: {}, colWidths: {}, rowHeights: {}, maxCol: 10, maxRow: 30 };
    setSheets(prev => [...prev, newSheet]);
    setActiveSheetIdx(sheets.length);
  }, [sheets.length, pushHistory, uniqueSheetName]);

  const deleteSheet = useCallback((idx: number) => {
    if (sheets.length <= 1) return;
    pushHistory();
    setSheets(prev => prev.filter((_, i) => i !== idx));
    setActiveSheetIdx(prev => prev >= idx ? Math.max(0, prev - 1) : prev);
  }, [sheets.length, pushHistory]);

  const duplicateSheet = useCallback((idx: number) => {
    const src = sheets[idx];
    if (!src) return;
    pushHistory();
    const copy: SheetData = JSON.parse(JSON.stringify(src));
    copy.name = uniqueSheetName(src.name);
    setSheets(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setActiveSheetIdx(idx + 1);
  }, [sheets, pushHistory, uniqueSheetName]);

  const renameSheet = useCallback((idx: number, newName: string) => {
    const cleaned = sanitizeSheetName(newName);
    if (!cleaned) { setRenamingSheet(null); return; }
    const unique = uniqueSheetName(cleaned, idx);
    pushHistory();
    setSheets(prev => prev.map((s, i) => i === idx ? { ...s, name: unique } : s));
    setRenamingSheet(null);
  }, [pushHistory, sanitizeSheetName, uniqueSheetName]);

  // ─── Cell operations ──────────────────────────────────────────

  const updateCell = useCallback((ref: string, value: string, formula?: string) => {
    if (!activeSheet) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };

      const parsed = parseCellRef(ref);
      if (parsed) {
        sheet.maxCol = Math.max(sheet.maxCol, parsed.col);
        sheet.maxRow = Math.max(sheet.maxRow, parsed.row);
      }

      if (!value && !formula) {
        delete cells[ref];
      } else {
        const existing = cells[ref] || { value: '' };
        cells[ref] = { ...existing, value, formula };
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const commitEdit = useCallback(() => {
    if (editingCell === null) return;
    // Preserve intentional whitespace (e.g. leading spaces), but treat a
    // purely blank entry as clearing the cell to match the prior behavior.
    const val = editValue;
    if (val.trim() === '') {
      updateCell(editingCell, '', undefined);
    } else if (val.startsWith('=')) {
      updateCell(editingCell, val, val);
    } else {
      updateCell(editingCell, val, undefined);
    }
    setEditingCell(null);
    setEditValue('');
  }, [editingCell, editValue, updateCell]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditValue('');
  }, []);

  const ensureSheetExtent = useCallback((ref: string) => {
    const parsed = parseCellRef(ref);
    if (!parsed) return;
    setSheets(prev => {
      const sheet = prev[activeSheetIdx];
      if (!sheet || (sheet.maxCol >= parsed.col && sheet.maxRow >= parsed.row)) return prev;
      const next = [...prev];
      next[activeSheetIdx] = {
        ...sheet,
        maxCol: Math.max(sheet.maxCol, parsed.col),
        maxRow: Math.max(sheet.maxRow, parsed.row),
      };
      return next;
    });
  }, [activeSheetIdx]);

  const beginCellEdit = useCallback((ref: string, selectText = false) => {
    const cell = activeSheet?.cells[ref];
    selectEditTextOnFocusRef.current = selectText;
    setEditingCell(ref);
    setEditValue(cell?.formula || cell?.value || '');
  }, [activeSheet]);

  const selectCell = useCallback((ref: string, edit = false, selectText = false) => {
    ensureSheetExtent(ref);
    setSelectedCell(ref);
    setSelectionRange(null);
    setMultiSelect(new Set());
    if (edit) {
      beginCellEdit(ref, selectText);
    } else {
      window.setTimeout(() => gridRef.current?.focus({ preventScroll: true }), 0);
    }
  }, [beginCellEdit, ensureSheetExtent]);

  const commitEditAndMove = useCallback((dCol: number, dRow: number, keepEditing = false) => {
    if (!activeSheet) return;
    const originRef = editingCell || selectedCell;
    const nextRef = nextSpreadsheetCellRef(originRef, activeSheet, dCol, dRow, true);
    skipNextEditBlurRef.current = true;
    commitEdit();
    if (nextRef) {
      selectCell(nextRef, keepEditing, keepEditing);
    }
  }, [activeSheet, commitEdit, editingCell, selectCell, selectedCell]);

  // Update format state when selection changes
  useEffect(() => {
    if (!activeSheet) return;
    const cell = activeSheet.cells[selectedCell];
    const fmt = cell?.format;
    setFmtBold(!!fmt?.bold);
    setFmtItalic(!!fmt?.italic);
    setFmtUnderline(!!fmt?.underline);
    setFmtStrike(!!fmt?.strikethrough);
    setFmtWrap(!!fmt?.wrapText);
    setFmtAlign(fmt?.align || 'left');
    setFmtColor(fmt?.color || OFFICE_UI.text);
    setFmtBgColor(fmt?.bgColor || 'transparent');
    setFmtNumberFormat(fmt?.numberFormat || 'general');
    setFmtFontSize(fmt?.fontSize || 12);

    if (cell?.formula) {
      setFormulaBarValue(cell.formula);
    } else {
      setFormulaBarValue(cell?.value || '');
    }
  }, [selectedCell, activeSheet]);

  // ─── Selection helpers ─────────────────────────────────────────

  const getSelectedRefs = useCallback((): string[] => {
    if (multiSelect.size > 0) return Array.from(multiSelect);
    if (selectionRange) {
      const refs: string[] = [];
      const { startCol, startRow, endCol, endRow } = selectionRange;
      const minC = Math.min(startCol, endCol);
      const maxC = Math.max(startCol, endCol);
      const minR = Math.min(startRow, endRow);
      const maxR = Math.max(startRow, endRow);
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          refs.push(cellRef(c, r));
        }
      }
      return refs;
    }
    return [selectedCell];
  }, [multiSelect, selectionRange, selectedCell]);

  const isInSelection = useCallback((col: number, row: number): boolean => {
    const ref = cellRef(col, row);
    if (multiSelect.has(ref)) return true;
    if (selectionRange) {
      const { startCol, startRow, endCol, endRow } = selectionRange;
      const minC = Math.min(startCol, endCol);
      const maxC = Math.max(startCol, endCol);
      const minR = Math.min(startRow, endRow);
      const maxR = Math.max(startRow, endRow);
      return col >= minC && col <= maxC && row >= minR && row <= maxR;
    }
    return ref === selectedCell;
  }, [multiSelect, selectionRange, selectedCell]);

  // ─── Format operations ────────────────────────────────────────

  const applyFormatToSelection = useCallback((key: keyof CellFormat, value: unknown) => {
    if (!activeSheet) return;
    pushHistory();
    const refs = getSelectedRefs();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (const ref of refs) {
        const existing = cells[ref] || { value: '' };
        const format = { ...(existing.format || {}) };
        (format as Record<string, unknown>)[key] = value;
        // Picking a bucket in the UI overrides any preserved source code.
        if (key === 'numberFormat') delete format.rawNumberFormat;
        cells[ref] = { ...existing, format };
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getSelectedRefs, pushHistory]);

  const handleToggleBold = useCallback(() => {
    const newVal = !fmtBold;
    setFmtBold(newVal);
    applyFormatToSelection('bold', newVal);
  }, [fmtBold, applyFormatToSelection]);

  const handleToggleItalic = useCallback(() => {
    const newVal = !fmtItalic;
    setFmtItalic(newVal);
    applyFormatToSelection('italic', newVal);
  }, [fmtItalic, applyFormatToSelection]);

  const handleToggleUnderline = useCallback(() => {
    const newVal = !fmtUnderline;
    setFmtUnderline(newVal);
    applyFormatToSelection('underline', newVal);
  }, [fmtUnderline, applyFormatToSelection]);

  const handleToggleStrike = useCallback(() => {
    const newVal = !fmtStrike;
    setFmtStrike(newVal);
    applyFormatToSelection('strikethrough', newVal);
  }, [fmtStrike, applyFormatToSelection]);

  const handleToggleWrap = useCallback(() => {
    const newVal = !fmtWrap;
    setFmtWrap(newVal);
    applyFormatToSelection('wrapText', newVal);
  }, [fmtWrap, applyFormatToSelection]);

  const handleSetAlign = useCallback((align: 'left' | 'center' | 'right') => {
    setFmtAlign(align);
    applyFormatToSelection('align', align);
  }, [applyFormatToSelection]);

  const handleSetColor = useCallback((color: string) => {
    setFmtColor(color);
    applyFormatToSelection('color', color);
  }, [applyFormatToSelection]);

  const handleSetBgColor = useCallback((bgColor: string) => {
    setFmtBgColor(bgColor);
    applyFormatToSelection('bgColor', bgColor);
  }, [applyFormatToSelection]);

  const applyBorderPreset = useCallback((preset: BorderPreset) => {
    if (!activeSheet) return;
    setShowBorderDropdown(false);
    pushHistory();
    const parsedRefs = getSelectedRefs()
      .map(ref => ({ ref, p: parseCellRef(ref) }))
      .filter((x): x is { ref: string; p: { col: number; row: number } } => x.p !== null);
    if (parsedRefs.length === 0) return;
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (const { p } of parsedRefs) {
      minCol = Math.min(minCol, p.col); maxCol = Math.max(maxCol, p.col);
      minRow = Math.min(minRow, p.row); maxRow = Math.max(maxRow, p.row);
    }
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (const { ref, p } of parsedRefs) {
        const existing = cells[ref] || { value: '' };
        const format = { ...(existing.format || {}) };
        if (preset === 'none') {
          delete format.border;
        } else {
          format.border = computeBorderEdges(preset, p.col, p.row, minCol, maxCol, minRow, maxRow);
        }
        cells[ref] = { ...existing, format: Object.keys(format).length > 0 ? format : undefined };
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getSelectedRefs, pushHistory]);

  const handleSetNumberFormat = useCallback((nf: string) => {
    setFmtNumberFormat(nf);
    applyFormatToSelection('numberFormat', nf);
    setShowNumFmtDropdown(false);
  }, [applyFormatToSelection]);

  const handleIncreaseDecimals = useCallback(() => {
    const next =
      fmtNumberFormat === 'integer' ? 'decimal1'
      : fmtNumberFormat === 'decimal1' ? 'decimal2'
      : fmtNumberFormat === 'general' ? 'decimal1'
      : fmtNumberFormat;
    handleSetNumberFormat(next);
  }, [fmtNumberFormat, handleSetNumberFormat]);

  const handleDecreaseDecimals = useCallback(() => {
    const next =
      fmtNumberFormat === 'decimal2' ? 'decimal1'
      : fmtNumberFormat === 'decimal1' ? 'integer'
      : fmtNumberFormat === 'number' ? 'decimal1'
      : fmtNumberFormat;
    handleSetNumberFormat(next);
  }, [fmtNumberFormat, handleSetNumberFormat]);

  const handleSetFontSize = useCallback((size: number) => {
    setFmtFontSize(size);
    applyFormatToSelection('fontSize', size);
  }, [applyFormatToSelection]);

  const clearSelectionFormat = useCallback(() => {
    if (!activeSheet) return;
    pushHistory();
    const refs = getSelectedRefs();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (const ref of refs) {
        if (cells[ref]) {
          cells[ref] = { ...cells[ref], format: undefined };
        }
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getSelectedRefs, pushHistory]);

  const autoFitSelectedColumns = useCallback(() => {
    if (!activeSheet) return;
    const refs = getSelectedRefs();
    const cols = new Set<number>();
    for (const ref of refs) {
      const parsed = parseCellRef(ref);
      if (parsed) cols.add(parsed.col);
    }
    if (cols.size === 0) {
      const parsed = parseCellRef(selectedCell);
      if (parsed) cols.add(parsed.col);
    }
    if (cols.size === 0) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const colWidths = { ...sheet.colWidths };
      for (const col of cols) {
        let longest = colToLetter(col).length;
        for (let row = 0; row <= sheet.maxRow; row++) {
          const ref = cellRef(col, row);
          const cell = sheet.cells[ref];
          const display = formatDisplayValue(getDisplayValue(cell, sheet.cells), cell?.format?.numberFormat);
          longest = Math.max(longest, display.length);
        }
        colWidths[col] = Math.max(48, Math.min(360, longest * 8 + 28));
      }
      sheet.colWidths = colWidths;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getSelectedRefs, pushHistory, selectedCell]);

  const getExplicitSelectionRefs = useCallback(() => {
    return selectionRange || multiSelect.size > 0 ? getSelectedRefs() : undefined;
  }, [getSelectedRefs, multiSelect.size, selectionRange]);

  const formatSelectionAsSmartTable = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const bounds = selectedBounds(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      const colWidths = { ...sheet.colWidths };
      for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
        const isHeader = row === bounds.minRow;
        const fill = isHeader ? '#1f6feb' : (row - bounds.minRow) % 2 === 0 ? '#eef6ff' : '#f8fafc';
        for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
          const ref = cellRef(col, row);
          const existing = cells[ref] || { value: '' };
          cells[ref] = {
            ...existing,
            format: {
              ...(existing.format || {}),
              bold: isHeader || col === bounds.minCol,
              color: isHeader ? '#ffffff' : '#0f172a',
              bgColor: fill,
              align: isHeader ? 'center' : existing.format?.align || 'left',
            },
          };
        }
        sheet.rowHeights = {
          ...sheet.rowHeights,
          [row]: isHeader ? Math.max(sheet.rowHeights[row] || DEFAULT_ROW_HEIGHT, 30) : sheet.rowHeights[row] || DEFAULT_ROW_HEIGHT,
        };
      }
      for (let col = bounds.minCol; col <= bounds.maxCol; col++) {
        let longest = colToLetter(col).length;
        for (let row = bounds.minRow; row <= bounds.maxRow; row++) {
          const ref = cellRef(col, row);
          const cell = cells[ref];
          const display = formatDisplayValue(getDisplayValue(cell, cells), cell?.format?.numberFormat);
          longest = Math.max(longest, display.length);
        }
        colWidths[col] = Math.max(76, Math.min(340, longest * 8 + 34));
      }
      sheet.cells = cells;
      sheet.colWidths = colWidths;
      if (bounds.minRow === 0) sheet.frozenRows = Math.max(sheet.frozenRows || 0, 1);
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getExplicitSelectionRefs, pushHistory]);

  const createSummarySheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const summary = buildSpreadsheetSummarySheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = summary.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${summary.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...summary, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createCleanRoomSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const cleanRoom = buildSpreadsheetCleanRoomSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = cleanRoom.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${cleanRoom.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...cleanRoom, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createDataDoctorSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const doctor = buildSpreadsheetDataDoctorSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = doctor.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${doctor.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...doctor, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createKpiStudioSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const kpi = buildSpreadsheetKpiStudioSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = kpi.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${kpi.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...kpi, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createVarianceSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const variance = buildSpreadsheetVarianceControlSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = variance.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${variance.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...variance, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createSolverSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const solver = buildSpreadsheetSolverSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = solver.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${solver.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...solver, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createFormulaAuditSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const formulaAudit = buildSpreadsheetFormulaAuditSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = formulaAudit.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${formulaAudit.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...formulaAudit, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createInsightSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const insight = buildSpreadsheetInsightSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = insight.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${insight.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...insight, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createPivotSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const pivot = buildSpreadsheetPivotSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = pivot.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${pivot.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...pivot, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createDashboardSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const dashboard = buildSpreadsheetDashboardSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = dashboard.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${dashboard.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...dashboard, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createForecastSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const forecast = buildSpreadsheetForecastSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = forecast.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${forecast.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...forecast, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createScenarioSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const scenario = buildSpreadsheetScenarioSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = scenario.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${scenario.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...scenario, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createCorrelationSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const correlation = buildSpreadsheetCorrelationSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = correlation.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${correlation.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...correlation, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createSensitivitySheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const sensitivity = buildSpreadsheetSensitivitySheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = sensitivity.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${sensitivity.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...sensitivity, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createWaterfallSheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const waterfall = buildSpreadsheetWaterfallBridgeSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = waterfall.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${waterfall.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...waterfall, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createAnomalySheet = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const anomaly = buildSpreadsheetAnomalyMonitorSheet(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      let name = anomaly.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${anomaly.name} ${suffix}`;
        suffix += 1;
      }
      return [...prev, { ...anomaly, name }];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const createExecutiveWorkbook = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    const pack = buildSpreadsheetExecutiveWorkbookSheets(activeSheet, refs);
    pushHistory();
    setSheets(prev => {
      const usedNames = new Set(prev.map((sheet) => sheet.name));
      const nextPack = pack.map((sheet) => {
        let name = sheet.name;
        let suffix = 2;
        while (usedNames.has(name)) {
          name = `${sheet.name} ${suffix}`;
          suffix += 1;
        }
        usedNames.add(name);
        return { ...sheet, name };
      });
      return [...prev, ...nextPack];
    });
    setActiveSheetIdx(sheets.length);
    setSelectedCell('A1');
    setSelectionRange(null);
    setMultiSelect(new Set());
  }, [activeSheet, getExplicitSelectionRefs, pushHistory, sheets.length]);

  const applySelectionHeatmap = useCallback(() => {
    if (!activeSheet) return;
    const refs = getExplicitSelectionRefs();
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      next[activeSheetIdx] = applySpreadsheetHeatmap(next[activeSheetIdx], refs);
      return next;
    });
  }, [activeSheet, activeSheetIdx, getExplicitSelectionRefs, pushHistory]);

  // ─── Merge/Unmerge ─────────────────────────────────────────────

  const handleMerge = useCallback(() => {
    if (!activeSheet || !selectionRange) return;
    pushHistory();
    const { startCol, startRow, endCol, endRow } = selectionRange;
    const minC = Math.min(startCol, endCol);
    const maxC = Math.max(startCol, endCol);
    const minR = Math.min(startRow, endRow);
    const maxR = Math.max(startRow, endRow);
    if (minC === maxC && minR === maxR) return; // single cell
    const newMerge: MergeRange = { startCol: minC, startRow: minR, endCol: maxC, endRow: maxR };
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const existing = [...(sheet.merges || [])];
      // Remove any overlapping merges
      const filtered = existing.filter(m =>
        !(m.startCol <= maxC && m.endCol >= minC && m.startRow <= maxR && m.endRow >= minR)
      );
      filtered.push(newMerge);
      sheet.merges = filtered;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, selectionRange, activeSheetIdx, pushHistory]);

  const handleUnmerge = useCallback(() => {
    if (!activeSheet) return;
    const parsed = parseCellRef(selectedCell);
    if (!parsed) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      sheet.merges = (sheet.merges || []).filter(m =>
        !(parsed.col >= m.startCol && parsed.col <= m.endCol && parsed.row >= m.startRow && parsed.row <= m.endRow)
      );
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, selectedCell, activeSheetIdx, pushHistory]);

  // ─── Sort ──────────────────────────────────────────────────────

  const handleSort = useCallback((ascending: boolean) => {
    if (!activeSheet) return;
    const parsed = parseCellRef(selectedCell);
    if (!parsed) return;
    const sortCol = parsed.col;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      // Header detection: frozen rows always stay put; otherwise, if the sort
      // column's first cell is non-numeric while the rest are mostly numeric,
      // treat row 0 as a header (Excel's "My data has headers" heuristic).
      let headerRows = sheet.frozenRows || 0;
      if (headerRows === 0) {
        const first = cells[cellRef(sortCol, 0)];
        const firstVal = first ? getDisplayValue(first, cells) : '';
        if (firstVal && isNaN(parseFloat(firstVal))) {
          let numeric = 0, filled = 0;
          for (let r = 1; r <= sheet.maxRow; r++) {
            const v = cells[cellRef(sortCol, r)] ? getDisplayValue(cells[cellRef(sortCol, r)], cells) : '';
            if (!v) continue;
            filled++;
            if (!isNaN(parseFloat(v))) numeric++;
          }
          if (filled > 0 && numeric / filled > 0.5) headerRows = 1;
        }
      }
      // Collect data rows (below the header)
      const rowData: { row: number; sortVal: string }[] = [];
      for (let r = headerRows; r <= sheet.maxRow; r++) {
        const ref = cellRef(sortCol, r);
        const cell = cells[ref];
        const val = cell ? getDisplayValue(cell, cells) : '';
        rowData.push({ row: r, sortVal: val });
      }
      // Sort — blank cells always sink to the bottom (Excel behavior).
      rowData.sort((a, b) => {
        if (!a.sortVal && !b.sortVal) return 0;
        if (!a.sortVal) return 1;
        if (!b.sortVal) return -1;
        const aNum = parseFloat(a.sortVal);
        const bNum = parseFloat(b.sortVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return ascending ? aNum - bNum : bNum - aNum;
        }
        return ascending ? a.sortVal.localeCompare(b.sortVal) : b.sortVal.localeCompare(a.sortVal);
      });
      // Remap cells (header rows copied through untouched)
      const newCells: Record<string, CellData> = {};
      for (let r = 0; r < headerRows; r++) {
        for (let c = 0; c <= sheet.maxCol; c++) {
          const cellData = cells[cellRef(c, r)];
          if (cellData) newCells[cellRef(c, r)] = cellData;
        }
      }
      // Row heights follow their rows so tall/short rows don't land on the wrong data.
      const newRowHeights: Record<number, number> = {};
      for (let r = 0; r < headerRows; r++) {
        if (sheet.rowHeights[r] != null) newRowHeights[r] = sheet.rowHeights[r];
      }
      // Track where each data row lands so formulas and merges can follow it.
      const rowMap = new Map<number, number>();
      for (let i = 0; i < rowData.length; i++) {
        const oldRow = rowData[i].row;
        const newRow = headerRows + i;
        rowMap.set(oldRow, newRow);
        const dRow = newRow - oldRow;
        for (let c = 0; c <= sheet.maxCol; c++) {
          const cellData = cells[cellRef(c, oldRow)];
          if (!cellData) continue;
          // A row-relative formula (e.g. =SUM(A5:C5)) must shift with its row,
          // otherwise it keeps summing the data that used to live at oldRow.
          if (cellData.formula && dRow !== 0) {
            const formula = adjustFormulaReferences(cellData.formula, 0, dRow);
            newCells[cellRef(c, newRow)] = { ...cellData, value: formula, formula };
          } else {
            newCells[cellRef(c, newRow)] = cellData;
          }
        }
        if (sheet.rowHeights[oldRow] != null) newRowHeights[newRow] = sheet.rowHeights[oldRow];
      }
      // Merges: keep header-only merges; move single-row data merges with their
      // row; release multi-row merges crossing the sort range (their block would
      // otherwise land on scrambled rows).
      if (sheet.merges && sheet.merges.length > 0) {
        const newMerges: MergeRange[] = [];
        for (const m of sheet.merges) {
          if (m.endRow < headerRows) {
            newMerges.push(m);
          } else if (m.startRow === m.endRow && rowMap.has(m.startRow)) {
            const nr = rowMap.get(m.startRow)!;
            newMerges.push({ ...m, startRow: nr, endRow: nr });
          }
          // else: multi-row merge intersecting the sorted region → dropped.
        }
        sheet.merges = newMerges.length > 0 ? newMerges : undefined;
      }
      sheet.cells = newCells;
      sheet.rowHeights = newRowHeights;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, selectedCell, activeSheetIdx, pushHistory]);

  // ─── Filter ────────────────────────────────────────────────────

  const handleToggleFilter = useCallback((colIdx: number) => {
    if (filterCol === colIdx) {
      // Turn off filter
      setFilterCol(null);
      setFilterValues(null);
      setFilterDropdownCol(null);
      setHiddenRows(new Set());
    } else {
      setFilterCol(colIdx);
      setFilterDropdownCol(colIdx);
      // Collect unique values in this column
      if (activeSheet) {
        const vals = new Set<string>();
        for (let r = 0; r <= activeSheet.maxRow; r++) {
          const ref = cellRef(colIdx, r);
          const cell = activeSheet.cells[ref];
          vals.add(cell ? getDisplayValue(cell, activeSheet.cells) : '');
        }
        setFilterValues(vals);
      }
    }
  }, [filterCol, activeSheet]);

  const applyFilter = useCallback((colIdx: number, selectedValues: Set<string>) => {
    if (!activeSheet) return;
    const hidden = new Set<number>();
    for (let r = 0; r <= activeSheet.maxRow; r++) {
      const ref = cellRef(colIdx, r);
      const cell = activeSheet.cells[ref];
      const val = cell ? getDisplayValue(cell, activeSheet.cells) : '';
      if (!selectedValues.has(val)) {
        hidden.add(r);
      }
    }
    setHiddenRows(hidden);
    setFilterDropdownCol(null);
  }, [activeSheet]);

  const clearFilter = useCallback(() => {
    setFilterCol(null);
    setFilterValues(null);
    setFilterDropdownCol(null);
    setHiddenRows(new Set());
  }, []);

  // ─── Auto-fill ─────────────────────────────────────────────────

  const handleAutoFillComplete = useCallback(() => {
    if (!autoFillTarget || !activeSheet) {
      setAutoFillDragging(false);
      setAutoFillTarget(null);
      return;
    }
    const parsed = parseCellRef(selectedCell);
    if (!parsed) return;
    pushHistory();
    const sourceCell = activeSheet.cells[selectedCell];
    const sourceVal = sourceCell?.value || '';

    // Excel-style fill: formulas shift their relative references, values
    // continue their series (numbers, "Item 3" suffixes, ISO dates).
    const filledCell = (dCol: number, dRow: number): CellData => {
      if (sourceCell?.formula) {
        const formula = adjustFormulaReferences(sourceCell.formula, dCol, dRow);
        return { value: formula, formula, format: sourceCell.format ? { ...sourceCell.format } : undefined };
      }
      return {
        value: nextAutoFillValue(sourceVal, dCol + dRow),
        format: sourceCell?.format ? { ...sourceCell.format } : undefined,
      };
    };

    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };

      if (autoFillTarget.col === parsed.col) {
        // Vertical fill
        const startR = Math.min(parsed.row, autoFillTarget.row);
        const endR = Math.max(parsed.row, autoFillTarget.row);
        for (let r = startR; r <= endR; r++) {
          if (r === parsed.row) continue;
          cells[cellRef(parsed.col, r)] = filledCell(0, r - parsed.row);
          sheet.maxRow = Math.max(sheet.maxRow, r);
        }
      } else {
        // Horizontal fill
        const startC = Math.min(parsed.col, autoFillTarget.col);
        const endC = Math.max(parsed.col, autoFillTarget.col);
        for (let c = startC; c <= endC; c++) {
          if (c === parsed.col) continue;
          cells[cellRef(c, parsed.row)] = filledCell(c - parsed.col, 0);
          sheet.maxCol = Math.max(sheet.maxCol, c);
        }
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
    setAutoFillDragging(false);
    setAutoFillTarget(null);
  }, [autoFillTarget, activeSheet, selectedCell, activeSheetIdx, pushHistory]);

  // ─── Column resize ────────────────────────────────────────────

  const handleColResizeStart = useCallback((e: React.MouseEvent, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    // One history entry per drag so Ctrl+Z undoes the resize, not older edits.
    pushHistory();
    setResizingCol(colIdx);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = activeSheet?.colWidths[colIdx] || DEFAULT_COL_WIDTH;
  }, [activeSheet, pushHistory]);

  useEffect(() => {
    if (resizingCol === null) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const newWidth = Math.max(40, resizeStartWidth.current + delta);
      setSheets(prev => {
        const next = [...prev];
        const sheet = { ...next[activeSheetIdx] };
        sheet.colWidths = { ...sheet.colWidths, [resizingCol]: newWidth };
        next[activeSheetIdx] = sheet;
        return next;
      });
    };
    const handleMouseUp = () => {
      setResizingCol(null);
      setModified(true);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingCol, activeSheetIdx]);

  const handleRowResizeStart = useCallback((e: React.MouseEvent, rowIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    setResizingRow(rowIdx);
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = activeSheet?.rowHeights[rowIdx] || DEFAULT_ROW_HEIGHT;
  }, [activeSheet, pushHistory]);

  useEffect(() => {
    if (resizingRow === null) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - resizeStartY.current;
      const newHeight = Math.max(18, resizeStartHeight.current + delta);
      setSheets(prev => {
        const next = [...prev];
        const sheet = { ...next[activeSheetIdx] };
        sheet.rowHeights = { ...sheet.rowHeights, [resizingRow]: newHeight };
        next[activeSheetIdx] = sheet;
        return next;
      });
    };
    const handleMouseUp = () => {
      setResizingRow(null);
      setModified(true);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizingRow, activeSheetIdx]);

  // ─── Drag selection ────────────────────────────────────────────

  useEffect(() => {
    if (!isDragging) return;
    // Prevent native text selection during drag
    const preventSelect = (e: Event) => e.preventDefault();
    document.addEventListener('selectstart', preventSelect);
    const handleMouseUp = () => {
      setIsDragging(false);
      // Formula drag completion: if user was editing a formula and released
      // the mouse after a drag, the onClick handler on the target cell will
      // insert the range reference — just clean up the drag start ref here.
      if (formulaDragRef.current && editInputRef.current) {
        setTimeout(() => editInputRef.current?.focus(), 0);
      }
      dragStartRef.current = null;
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('selectstart', preventSelect);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Auto-fill mouse up
  useEffect(() => {
    if (!autoFillDragging) return;
    const handleMouseUp = () => {
      handleAutoFillComplete();
    };
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [autoFillDragging, handleAutoFillComplete]);

  // ─── Insert/delete rows/cols ──────────────────────────────────

  // One shared implementation: remaps cells, rewrites formula references, and
  // shifts sizes/merges/conditional ranges/frozen panes together — doing only
  // the cells (as before) visually corrupted everything else on the sheet.
  const applyAxisEdit = useCallback((axis: 'row' | 'col', op: 'insert' | 'delete', idx: number) => {
    if (!activeSheet) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells: Record<string, CellData> = {};
      for (const [ref, cell] of Object.entries(sheet.cells)) {
        const parsed = parseCellRef(ref);
        if (!parsed) continue;
        const v = axis === 'row' ? parsed.row : parsed.col;
        let nv = v;
        if (op === 'insert') {
          if (v > idx) nv = v + 1;
        } else {
          if (v === idx) continue;
          if (v > idx) nv = v - 1;
        }
        let outCell = cell;
        if (cell.formula) {
          const adjusted = adjustFormulaAxisEdit(cell.formula, axis, op, idx);
          if (adjusted !== cell.formula) outCell = { ...cell, formula: adjusted, value: adjusted };
        }
        cells[cellRef(axis === 'col' ? nv : parsed.col, axis === 'row' ? nv : parsed.row)] = outCell;
      }
      Object.assign(sheet, remapSheetMetaAxis(sheet, axis, op, idx));
      sheet.cells = cells;
      if (axis === 'row') sheet.maxRow = op === 'insert' ? sheet.maxRow + 1 : Math.max(0, sheet.maxRow - 1);
      else sheet.maxCol = op === 'insert' ? sheet.maxCol + 1 : Math.max(0, sheet.maxCol - 1);
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const insertRow = useCallback((afterRow: number) => {
    applyAxisEdit('row', 'insert', afterRow);
  }, [applyAxisEdit]);

  const insertCol = useCallback((afterCol: number) => {
    applyAxisEdit('col', 'insert', afterCol);
  }, [applyAxisEdit]);

  const deleteRow = useCallback((rowIdx: number) => {
    applyAxisEdit('row', 'delete', rowIdx);
  }, [applyAxisEdit]);

  const deleteCol = useCallback((colIdx: number) => {
    applyAxisEdit('col', 'delete', colIdx);
  }, [applyAxisEdit]);

  // ─── Column/Row/All select ─────────────────────────────────────

  const selectColumn = useCallback((colIdx: number) => {
    if (!activeSheet) return;
    setSelectedCell(cellRef(colIdx, 0));
    setSelectionRange({ startCol: colIdx, startRow: 0, endCol: colIdx, endRow: activeSheet.maxRow });
    setMultiSelect(new Set());
    setEditingCell(null);
  }, [activeSheet]);

  const selectRow = useCallback((rowIdx: number) => {
    if (!activeSheet) return;
    setSelectedCell(cellRef(0, rowIdx));
    setSelectionRange({ startCol: 0, startRow: rowIdx, endCol: activeSheet.maxCol, endRow: rowIdx });
    setMultiSelect(new Set());
    setEditingCell(null);
  }, [activeSheet]);

  const selectAll = useCallback(() => {
    if (!activeSheet) return;
    setSelectedCell('A1');
    setSelectionRange({ startCol: 0, startRow: 0, endCol: activeSheet.maxCol, endRow: activeSheet.maxRow });
    setMultiSelect(new Set());
    setEditingCell(null);
  }, [activeSheet]);

  // ─── Copy/Paste ────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    if (!activeSheet) return;
    const refs = getSelectedRefs();
    if (refs.length === 0) return;
    let minC = Infinity, minR = Infinity, maxC = 0, maxR = 0;
    const copiedCells: Record<string, CellData> = {};
    for (const ref of refs) {
      const parsed = parseCellRef(ref);
      if (!parsed) continue;
      minC = Math.min(minC, parsed.col);
      minR = Math.min(minR, parsed.row);
      maxC = Math.max(maxC, parsed.col);
      maxR = Math.max(maxR, parsed.row);
      const cell = activeSheet.cells[ref];
      if (cell) copiedCells[ref] = JSON.parse(JSON.stringify(cell));
    }
    clipboardRef.current = { cells: copiedCells, startCol: minC, startRow: minR, endCol: maxC, endRow: maxR };
    // Also copy as text for system clipboard
    const lines: string[] = [];
    for (let r = minR; r <= maxR; r++) {
      const cols: string[] = [];
      for (let c = minC; c <= maxC; c++) {
        const ref = cellRef(c, r);
        const cell = activeSheet.cells[ref];
        cols.push(cell ? getDisplayValue(cell, activeSheet.cells) : '');
      }
      lines.push(cols.join('\t'));
    }
    const text = lines.join('\n');
    clipboardTextRef.current = text;
    navigator.clipboard.writeText(text).catch(() => {});
  }, [activeSheet, getSelectedRefs]);

  const handleCut = useCallback(() => {
    if (!activeSheet) return;
    const refs = getSelectedRefs();
    if (refs.length === 0) return;
    handleCopy();
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (const ref of refs) delete cells[ref];
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, getSelectedRefs, handleCopy, pushHistory]);

  const pasteClipboardRows = useCallback((rows: string[][], targetRef: string) => {
    if (!activeSheet || rows.length === 0) return;
    const parsed = parseCellRef(targetRef);
    if (!parsed) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < rows[r].length; c++) {
          const dstCol = parsed.col + c;
          const dstRow = parsed.row + r;
          const dstRef = cellRef(dstCol, dstRow);
          const raw = rows[r][c] ?? '';
          const value = raw.trim();
          if (!value) {
            delete cells[dstRef];
          } else {
            const existing = cells[dstRef] || { value: '' };
            cells[dstRef] = {
              ...existing,
              value,
              formula: value.startsWith('=') ? value : undefined,
            };
          }
          sheet.maxCol = Math.max(sheet.maxCol, dstCol);
          sheet.maxRow = Math.max(sheet.maxRow, dstRow);
        }
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const pasteInternalClipboard = useCallback((targetRef: string) => {
    if (!activeSheet || !clipboardRef.current) return false;
    const parsed = parseCellRef(targetRef);
    if (!parsed) return false;
    pushHistory();
    const { cells: copiedCells, startCol, startRow } = clipboardRef.current;
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      for (const [ref, cellData] of Object.entries(copiedCells)) {
        const srcParsed = parseCellRef(ref);
        if (!srcParsed) continue;
        const dstCol = parsed.col + (srcParsed.col - startCol);
        const dstRow = parsed.row + (srcParsed.row - startRow);
        const dstRef = cellRef(dstCol, dstRow);
        const copied: CellData = JSON.parse(JSON.stringify(cellData));
        // Excel semantics: relative references travel with the paste offset.
        if (copied.formula) {
          copied.formula = adjustFormulaReferences(copied.formula, dstCol - srcParsed.col, dstRow - srcParsed.row);
          copied.value = copied.formula;
        }
        cells[dstRef] = copied;
        sheet.maxCol = Math.max(sheet.maxCol, dstCol);
        sheet.maxRow = Math.max(sheet.maxRow, dstRow);
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
    return true;
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const handlePaste = useCallback(async () => {
    if (!activeSheet) return;
    let systemText = '';
    try {
      systemText = await navigator.clipboard.readText();
    } catch {
      systemText = '';
    }

    if (systemText && systemText !== clipboardTextRef.current) {
      const rows = parseClipboardTable(systemText);
      if (rows.length > 0) {
        pasteClipboardRows(rows, selectedCell);
        return;
      }
    }

    if (pasteInternalClipboard(selectedCell)) return;

    if (systemText) {
      const rows = parseClipboardTable(systemText);
      if (rows.length > 0) pasteClipboardRows(rows, selectedCell);
    }
  }, [activeSheet, pasteClipboardRows, pasteInternalClipboard, selectedCell]);

  // ─── Search/Replace ────────────────────────────────────────────

  const doSearch = useCallback((text: string) => {
    if (!activeSheet || !text) {
      setSearchResults([]);
      return;
    }
    const results: string[] = [];
    const lower = text.toLowerCase();
    for (let r = 0; r <= activeSheet.maxRow; r++) {
      for (let c = 0; c <= activeSheet.maxCol; c++) {
        const ref = cellRef(c, r);
        const cell = activeSheet.cells[ref];
        if (cell) {
          const display = getDisplayValue(cell, activeSheet.cells).toLowerCase();
          if (display.includes(lower)) results.push(ref);
        }
      }
    }
    setSearchResults(results);
    setSearchIdx(0);
    if (results.length > 0) setSelectedCell(results[0]);
  }, [activeSheet]);

  const searchNext = useCallback(() => {
    if (searchResults.length === 0) return;
    const next = (searchIdx + 1) % searchResults.length;
    setSearchIdx(next);
    setSelectedCell(searchResults[next]);
  }, [searchResults, searchIdx]);

  const searchPrev = useCallback(() => {
    if (searchResults.length === 0) return;
    const prev = (searchIdx - 1 + searchResults.length) % searchResults.length;
    setSearchIdx(prev);
    setSelectedCell(searchResults[prev]);
  }, [searchResults, searchIdx]);

  // Replace edits the cell's RAW text (formula source included) — replacing in
  // the computed display value silently flattened formulas into static text.
  const doReplace = useCallback(() => {
    if (!activeSheet || searchResults.length === 0) return;
    const ref = searchResults[searchIdx];
    const cell = activeSheet.cells[ref];
    if (!cell) return;
    const raw = cell.formula ?? cell.value;
    const newVal = raw.replace(new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replaceText);
    updateCell(ref, newVal, newVal.startsWith('=') ? newVal : undefined);
    doSearch(searchText);
  }, [activeSheet, searchResults, searchIdx, searchText, replaceText, updateCell, doSearch]);

  const doReplaceAll = useCallback(() => {
    if (!activeSheet || searchResults.length === 0) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      const cells = { ...sheet.cells };
      const pattern = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const ref of searchResults) {
        const cell = cells[ref];
        if (!cell) continue;
        const raw = cell.formula ?? cell.value;
        const newVal = raw.replace(pattern, replaceText);
        cells[ref] = { ...cell, value: newVal, formula: newVal.startsWith('=') ? newVal : undefined };
      }
      sheet.cells = cells;
      next[activeSheetIdx] = sheet;
      return next;
    });
    doSearch(searchText);
  }, [activeSheet, searchResults, searchText, replaceText, activeSheetIdx, pushHistory, doSearch]);

  // ─── Context menu ─────────────────────────────────────────────

  const handleCellContextMenu = useCallback((e: React.MouseEvent, ref: string) => {
    e.preventDefault();
    const parsed = parseCellRef(ref);
    if (!parsed) return;
    setSelectedCell(ref);
    setCtxMenu({ x: e.clientX, y: e.clientY, type: 'cell', idx: parsed.row });
  }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    const handler = () => setCtxMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [ctxMenu]);

  // Close filter dropdown on outside click
  useEffect(() => {
    if (filterDropdownCol === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.xe-filter-dropdown')) setFilterDropdownCol(null);
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [filterDropdownCol]);

  // Close number format dropdown
  useEffect(() => {
    if (!showNumFmtDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.xe-numfmt-dropdown')) setShowNumFmtDropdown(false);
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [showNumFmtDropdown]);

  // Close border dropdown on outside click
  useEffect(() => {
    if (!showBorderDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.xe-border-dropdown') && !target.closest('.xe-border-btn')) setShowBorderDropdown(false);
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
    return () => document.removeEventListener('click', handler);
  }, [showBorderDropdown]);

  // ─── Virtualization: track viewport size + reset scroll on sheet switch
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => {
      setViewportHeight(el.clientHeight);
      setViewportWidth(el.clientWidth);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.scrollTop = 0;
      gridRef.current.scrollLeft = 0;
    }
    setScrollTop(0);
    setScrollLeft(0);
  }, [activeSheetIdx]);

  // ─── Save ─────────────────────────────────────────────────────

  const showSaveToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setSaveToast({ kind, text });
    if (saveToastTimer.current) window.clearTimeout(saveToastTimer.current);
    saveToastTimer.current = window.setTimeout(() => setSaveToast(null), 3000);
  }, []);

  // Returns true only when the file was actually written. Callers that must
  // report success/failure (the agent bridge) rely on this; disk/permission
  // errors are no longer swallowed as a successful save.
  const handleSave = useCallback(async (saveAs?: boolean): Promise<boolean> => {
    // Guard against overwriting the original file when the workbook never
    // loaded — its cells are empty and saving would destroy the source.
    if (loadError) {
      lastSaveErrorRef.current = 'workbook failed to load; refusing to save';
      showSaveToast('error', 'Save failed');
      return false;
    }
    // Fold any in-progress edit into the payload so the newest value is saved,
    // not the stale closure captured before commitEdit's setState flushes.
    const base = editingCell !== null
      ? applyPendingEdit(sheetsRef.current, activeSheetIdx, editingCell, editValue)
      : sheetsRef.current;
    if (editingCell !== null) commitEdit();
    try {
      const base64 = await writeXlsxToBase64(base);
      let targetPath = filePath;
      if (saveAs) {
        const name = filePath.split(/[\\/]/).pop() || 'spreadsheet.xlsx';
        const result = await invoke<string | null>('save_file_dialog', {
          defaultName: name,
          filters: [['Excel', ['xlsx', 'xls']]],
        });
        if (!result) return false;
        targetPath = result;
      }
      await invoke('write_file_base64', { path: targetPath, base64Data: base64 });
      setModified(false);
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      showSaveToast('ok', `Saved ${hhmm}`);
      onSaved?.(targetPath);
      lastSaveErrorRef.current = '';
      return true;
    } catch (err) {
      console.error('[XlsxEditor] Save failed:', err);
      // Keep the dirty state so the user knows the change is not persisted.
      lastSaveErrorRef.current = err instanceof Error ? err.message : String(err);
      showSaveToast('error', 'Save failed');
      return false;
    }
  }, [loadError, editingCell, editValue, activeSheetIdx, commitEdit, filePath, onSaved, showSaveToast]);

  // ─── Editor control bridge (terminal agent → cell-level control) ──
  // App.tsx delegates `xlsx.*` commands here via a window CustomEvent, filtered
  // by filePath so only the editor rendering this file responds. Kept in a ref
  // so fresh state is used without re-registering the listener on every edit.
  const xlsxBridgeHandlerRef = useRef<(cmd: string, request: any) => Promise<any>>(async () => ({ ok: false, error: 'xlsx bridge not ready' }));
  xlsxBridgeHandlerRef.current = async (cmd: string, request: any) => {
    const BOOL_KEYS: (keyof CellFormat)[] = ['bold', 'italic', 'underline', 'strikethrough', 'wrapText'];
    const STRING_KEYS: (keyof CellFormat)[] = ['color', 'bgColor'];
    const NUMBER_FORMATS = new Set(['general', 'number', 'integer', 'decimal1', 'decimal2', 'currency', 'accounting', 'percent', 'date', 'datetime', 'time', 'scientific', 'text']);
    // Only accept values of the right shape so junk (e.g. fontSize:"big",
    // align:"middle") is dropped instead of being persisted verbatim.
    const sanitizeFormat = (raw: any): Partial<CellFormat> => {
      const out: Partial<CellFormat> = {};
      if (!raw || typeof raw !== 'object') return out;
      for (const key of BOOL_KEYS) {
        if (typeof raw[key] === 'boolean') (out as any)[key] = raw[key];
      }
      for (const key of STRING_KEYS) {
        if (typeof raw[key] === 'string') (out as any)[key] = raw[key];
      }
      if (raw.align === 'left' || raw.align === 'center' || raw.align === 'right') out.align = raw.align;
      if (typeof raw.numberFormat === 'string' && NUMBER_FORMATS.has(raw.numberFormat)) out.numberFormat = raw.numberFormat as CellFormat['numberFormat'];
      if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) out.fontSize = raw.fontSize;
      if (raw.border && typeof raw.border === 'object') out.border = raw.border;
      return out;
    };
    const resolveIdx = (name?: string): number => (name ? sheets.findIndex((s) => s.name === name) : activeSheetIdx);

    switch (cmd) {
      case 'xlsx.listSheets':
        return { ok: true, sheets: sheets.map((s) => s.name), activeIndex: activeSheetIdx };

      case 'xlsx.getCells': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        const sheet = sheets[idx];
        // Uppercase so 'a1:c10' parses as a range instead of a single stray ref.
        const range = String(request?.range || '').trim().toUpperCase();
        if (!range) return { ok: false, error: 'range required (e.g. A1:C10)' };
        // Reject unparseable / unbounded ranges instead of silently returning
        // one empty cell or trying to materialize hundreds of millions of refs.
        const rangeParts = range.split(':');
        if (!rangeParts.every((p) => parseCellRef(p))) return { ok: false, error: `invalid range: ${range}` };
        const count = rangeCellCount(range);
        if (count > BRIDGE_MAX_CELLS) return { ok: false, error: `range too large: ${count} cells (max ${BRIDGE_MAX_CELLS})` };
        const refs = expandRange(range);
        const cells = refs.map((ref) => {
          const c = sheet.cells[ref];
          const out: { ref: string; value: string; formula?: string; display: string } = {
            ref,
            value: c?.value ?? '',
            display: c ? formatDisplayValue(getDisplayValue(c, sheet.cells), c.format?.numberFormat) : '',
          };
          if (c?.formula) out.formula = c.formula;
          return out;
        });
        return { ok: true, sheet: sheet.name, range, cells };
      }

      case 'xlsx.setCells': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        const inputCells = Array.isArray(request?.cells) ? request.cells : [];
        if (!inputCells.length) return { ok: false, error: 'cells array required, e.g. [{"ref":"A1","value":"hi"}]' };
        if (inputCells.length > BRIDGE_MAX_CELLS) return { ok: false, error: `too many cells: ${inputCells.length} (max ${BRIDGE_MAX_CELLS})` };
        // Validate every ref up front: bad refs (lowercase, off-grid) must fail
        // loudly, not be silently skipped while still reporting success.
        const invalidRefs: string[] = [];
        const parsedItems: { ref: string; parsed: { col: number; row: number }; value: string }[] = [];
        for (const item of inputCells) {
          const ref = String(item?.ref || '').trim().toUpperCase();
          const parsed = parseCellRef(ref);
          if (!parsed || parsed.col > XLSX_MAX_COL || parsed.row > XLSX_MAX_ROW) {
            invalidRefs.push(String(item?.ref ?? ''));
            continue;
          }
          parsedItems.push({ ref, parsed, value: item?.value == null ? '' : String(item.value) });
        }
        if (invalidRefs.length) return { ok: false, error: `invalid cell refs: ${invalidRefs.join(', ')}`, invalidRefs };
        pushHistory();
        setSheets((prev) => {
          const next = [...prev];
          const sheet = { ...next[idx] };
          const cellMap = { ...sheet.cells };
          for (const { ref, parsed, value } of parsedItems) {
            sheet.maxCol = Math.max(sheet.maxCol, parsed.col);
            sheet.maxRow = Math.max(sheet.maxRow, parsed.row);
            const val = value;
            if (val.trim() === '') {
              delete cellMap[ref];
            } else if (val.startsWith('=')) {
              cellMap[ref] = { ...(cellMap[ref] || { value: '' }), value: val, formula: val };
            } else {
              cellMap[ref] = { ...(cellMap[ref] || { value: '' }), value: val, formula: undefined };
            }
          }
          sheet.cells = cellMap;
          next[idx] = sheet;
          return next;
        });
        return { ok: true, sheet: sheets[idx].name, count: parsedItems.length };
      }

      case 'xlsx.setFormat': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        const range = String(request?.range || '').trim().toUpperCase();
        if (!range) return { ok: false, error: 'range required (e.g. A1:B2)' };
        const rangeParts = range.split(':');
        if (!rangeParts.every((p) => parseCellRef(p))) return { ok: false, error: `invalid range: ${range}` };
        const count = rangeCellCount(range);
        if (count > BRIDGE_MAX_CELLS) return { ok: false, error: `range too large: ${count} cells (max ${BRIDGE_MAX_CELLS})` };
        const format = sanitizeFormat(request?.format);
        if (Object.keys(format).length === 0) return { ok: false, error: 'format object required (bold/italic/color/bgColor/align/numberFormat/fontSize/border)' };
        // A picked bucket must override any preserved source code on save.
        const clearRaw = 'numberFormat' in format;
        const refs = expandRange(range);
        pushHistory();
        setSheets((prev) => {
          const next = [...prev];
          const sheet = { ...next[idx] };
          const cellMap = { ...sheet.cells };
          for (const ref of refs) {
            const parsed = parseCellRef(ref);
            if (!parsed) continue;
            sheet.maxCol = Math.max(sheet.maxCol, parsed.col);
            sheet.maxRow = Math.max(sheet.maxRow, parsed.row);
            const existing = cellMap[ref] || { value: '' };
            const merged = { ...(existing.format || {}), ...format };
            if (clearRaw) delete merged.rawNumberFormat;
            cellMap[ref] = { ...existing, format: merged };
          }
          sheet.cells = cellMap;
          next[idx] = sheet;
          return next;
        });
        return { ok: true, sheet: sheets[idx].name, range, applied: Object.keys(format) };
      }

      case 'xlsx.addSheet': {
        const requested = String(request?.name || '').trim();
        if (requested && sheets.some((s) => s.name === requested)) return { ok: false, error: `sheet already exists: ${requested}` };
        pushHistory();
        let addedName = requested || `Sheet${sheets.length + 1}`;
        let addedIndex = sheets.length;
        // Derive the default name and dedupe inside the functional update so two
        // near-simultaneous addSheet calls can't both mint the same name/index.
        setSheets((prev) => {
          const finalName = requested || `Sheet${prev.length + 1}`;
          if (prev.some((s) => s.name === finalName)) return prev;
          addedName = finalName;
          addedIndex = prev.length;
          return [...prev, { name: finalName, cells: {}, colWidths: {}, rowHeights: {}, maxCol: 10, maxRow: 30 }];
        });
        setActiveSheetIdx(addedIndex);
        return { ok: true, name: addedName, index: addedIndex };
      }

      case 'xlsx.renameSheet': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        const newName = String(request?.name || '').trim();
        if (!newName) return { ok: false, error: 'name required' };
        if (sheets.some((s, i) => i !== idx && s.name === newName)) return { ok: false, error: `sheet already exists: ${newName}` };
        renameSheet(idx, newName);
        return { ok: true, index: idx, name: newName };
      }

      case 'xlsx.deleteSheet': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        if (sheets.length <= 1) return { ok: false, error: 'cannot delete the only sheet' };
        deleteSheet(idx);
        return { ok: true, deleted: sheets[idx].name, count: sheets.length - 1 };
      }

      case 'xlsx.duplicateSheet': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        duplicateSheet(idx);
        return { ok: true, source: sheets[idx].name, index: idx + 1 };
      }

      case 'xlsx.clearRange': {
        const idx = resolveIdx(request?.sheet);
        if (idx < 0) return { ok: false, error: `sheet not found: ${request?.sheet}` };
        const range = String(request?.range || '').trim().toUpperCase();
        if (!range) return { ok: false, error: 'range required (e.g. A1:C10)' };
        const rangeParts = range.split(':');
        if (!rangeParts.every((p) => parseCellRef(p))) return { ok: false, error: `invalid range: ${range}` };
        const count = rangeCellCount(range);
        if (count > BRIDGE_MAX_CELLS) return { ok: false, error: `range too large: ${count} cells (max ${BRIDGE_MAX_CELLS})` };
        const refs = expandRange(range);
        pushHistory();
        setSheets((prev) => {
          const next = [...prev];
          const sheet = { ...next[idx] };
          const cellMap = { ...sheet.cells };
          for (const ref of refs) delete cellMap[ref];
          sheet.cells = cellMap;
          next[idx] = sheet;
          return next;
        });
        return { ok: true, sheet: sheets[idx].name, range, cleared: refs.length };
      }

      case 'xlsx.save': {
        if (loadError) return { ok: false, error: 'workbook failed to load; refusing to save' };
        try {
          const saved = await handleSave();
          // handleSave swallows the write error to keep the UI toast; surface it
          // here so the agent never treats a failed write as a successful save.
          if (!saved) return { ok: false, error: lastSaveErrorRef.current || 'save failed' };
          return { ok: true, path: filePath };
        } catch (e: any) {
          return { ok: false, error: String(e?.message || e) };
        }
      }

      default:
        return { ok: false, error: `unknown xlsx cmd: ${cmd}` };
    }
  };

  useEffect(() => {
    // Windows paths arrive with any mix of separators (and case) depending on
    // who resolved them — match on a normalized form, never the raw string.
    const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const handler = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { reqId?: string; path?: string; cmd?: string; request?: any } | undefined;
      if (!d || normPath(String(d.path || '')) !== normPath(filePath)) return;
      const reqId = d.reqId;
      Promise.resolve(xlsxBridgeHandlerRef.current(String(d.cmd || ''), d.request || {}))
        .then((result) => {
          window.dispatchEvent(new CustomEvent('octo-xlsx-result', { detail: { reqId, result } }));
        })
        .catch((e: any) => {
          window.dispatchEvent(new CustomEvent('octo-xlsx-result', { detail: { reqId, result: { ok: false, error: String(e?.message || e) } } }));
        });
    };
    window.addEventListener('octo-xlsx-command', handler);
    return () => window.removeEventListener('octo-xlsx-command', handler);
  }, [filePath]);

  // ─── Keyboard shortcuts ───────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (focusOutsideEditor(editorRootRef.current, e)) return;
      const meta = e.metaKey || e.ctrlKey;
      // Compare lowercased: with Shift (or CapsLock) held, e.key arrives as an
      // uppercase letter, which used to silently kill Redo and Save-As.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (meta && key === 'z' && !e.shiftKey) { e.preventDefault(); handleUndo(); return; }
      if (meta && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); handleRedo(); return; }
      if (meta && key === 's' && !e.shiftKey) { e.preventDefault(); void handleSave(); return; }
      if (meta && key === 's' && e.shiftKey) { e.preventDefault(); void handleSave(true); return; }
      if (meta && key === 'b') { e.preventDefault(); handleToggleBold(); return; }
      if (meta && key === 'i') { e.preventDefault(); handleToggleItalic(); return; }
      if (meta && key === 'u') { e.preventDefault(); handleToggleUnderline(); return; }
      if (meta && key === 'c') {
        if (editingCell) return; // let native copy work
        e.preventDefault(); handleCopy(); return;
      }
      if (meta && key === 'x') {
        if (editingCell) return; // let native cut work
        e.preventDefault(); handleCut(); return;
      }
      if (meta && key === 'v') {
        if (editingCell) return;
        e.preventDefault(); void handlePaste(); return;
      }
      if (meta && key === 'f') { e.preventDefault(); setShowSearch(true); return; }
      if (meta && key === 'h') { e.preventDefault(); setShowSearch(true); return; }
      if (meta && key === 'a') {
        if (editingCell) return;
        e.preventDefault(); selectAll(); return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo, handleSave, handleToggleBold, handleToggleItalic, handleToggleUnderline, handleCopy, handleCut, handlePaste, selectAll, editingCell]);

  // ─── Navigation ───────────────────────────────────────────────

  const navigate = useCallback((dCol: number, dRow: number) => {
    if (!activeSheet) return;
    const nextRef = nextSpreadsheetCellRef(selectedCell, activeSheet, dCol, dRow, false);
    if (nextRef) selectCell(nextRef);
  }, [selectedCell, activeSheet, selectCell]);

  useEffect(() => {
    const wrap = gridRef.current;
    if (!wrap) return;
    const el = wrap.querySelector<HTMLElement>(`[data-cell-ref="${selectedCell}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      return;
    }
    // The cell is windowed out of the DOM: scroll to its computed row offset so
    // arrow-key navigation past the visible range still follows the selection.
    const parsed = parseCellRef(selectedCell);
    if (!parsed) return;
    const rowTop = parsed.row * DEFAULT_ROW_HEIGHT;
    const rowBottom = rowTop + DEFAULT_ROW_HEIGHT;
    const viewTop = wrap.scrollTop;
    const viewBottom = wrap.scrollTop + wrap.clientHeight - COL_HEADER_HEIGHT;
    if (rowTop < viewTop) wrap.scrollTop = rowTop;
    else if (rowBottom > viewBottom) wrap.scrollTop = rowBottom - wrap.clientHeight + COL_HEADER_HEIGHT;
  }, [selectedCell]);

  const handleGridKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingCell) return;

    // Cmd/Ctrl+Arrow: jump to the edge of the data block (Excel behavior)
    if ((e.metaKey || e.ctrlKey) && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const parsed = parseCellRef(selectedCell);
      if (!parsed || !activeSheet) return;
      const [dCol, dRow] =
        e.key === 'ArrowUp' ? [0, -1]
        : e.key === 'ArrowDown' ? [0, 1]
        : e.key === 'ArrowLeft' ? [-1, 0]
        : [1, 0];
      const target = jumpToDataEdge(activeSheet, parsed.col, parsed.row, dCol, dRow);
      if (e.shiftKey) {
        const current = selectionRange || { startCol: parsed.col, startRow: parsed.row, endCol: parsed.col, endRow: parsed.row };
        setSelectionRange({ startCol: current.startCol, startRow: current.startRow, endCol: target.col, endRow: target.row });
      } else {
        selectCell(cellRef(target.col, target.row));
      }
      return;
    }

    // Ctrl+Home / Ctrl+End: jump to A1 / the last data cell (Excel behavior)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      if (!activeSheet) return;
      selectCell(e.key === 'Home' ? 'A1' : cellRef(activeSheet.maxCol, activeSheet.maxRow));
      return;
    }

    // Shift+Arrow for range selection
    if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const parsed = parseCellRef(selectedCell);
      if (!parsed || !activeSheet) return;
      const current = selectionRange || { startCol: parsed.col, startRow: parsed.row, endCol: parsed.col, endRow: parsed.row };
      let { endCol, endRow } = current;
      switch (e.key) {
        case 'ArrowUp': endRow = Math.max(0, endRow - 1); break;
        case 'ArrowDown': endRow = Math.min(activeSheet.maxRow, endRow + 1); break;
        case 'ArrowLeft': endCol = Math.max(0, endCol - 1); break;
        case 'ArrowRight': endCol = Math.min(activeSheet.maxCol, endCol + 1); break;
      }
      setSelectionRange({ ...current, endCol, endRow });
      return;
    }

    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); navigate(0, -1); break;
      case 'ArrowDown':  e.preventDefault(); navigate(0, 1); break;
      case 'ArrowLeft':  e.preventDefault(); navigate(-1, 0); break;
      case 'ArrowRight': e.preventDefault(); navigate(1, 0); break;
      case 'Tab':
        e.preventDefault();
        {
          const nextRef = nextSpreadsheetCellRef(selectedCell, activeSheet, e.shiftKey ? -1 : 1, 0, true);
          if (nextRef) selectCell(nextRef);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) {
          navigate(0, -1);
        } else {
          setEditingCell(selectedCell);
          const cell = activeSheet?.cells[selectedCell];
          setEditValue(cell?.formula || cell?.value || '');
        }
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        {
          const refs = getSelectedRefs();
          if (refs.length > 1) {
            pushHistory();
            setSheets(prev => {
              const next = [...prev];
              const sheet = { ...next[activeSheetIdx] };
              const cells = { ...sheet.cells };
              for (const ref of refs) delete cells[ref];
              sheet.cells = cells;
              next[activeSheetIdx] = sheet;
              return next;
            });
          } else {
            updateCell(selectedCell, '', undefined);
          }
        }
        break;
      case 'Escape':
        setSelectionRange(null);
        setMultiSelect(new Set());
        setShowSearch(false);
        break;
      case 'F2':
        e.preventDefault();
        setEditingCell(selectedCell);
        {
          const cell = activeSheet?.cells[selectedCell];
          setEditValue(cell?.formula || cell?.value || '');
        }
        break;
      case 'Home':
        e.preventDefault();
        {
          const p = parseCellRef(selectedCell);
          if (p) selectCell(cellRef(0, p.row));
        }
        break;
      case 'PageDown':
      case 'PageUp':
        e.preventDefault();
        {
          const p = parseCellRef(selectedCell);
          if (p && activeSheet) {
            const page = Math.max(1, Math.floor((gridRef.current?.clientHeight || 600) / DEFAULT_ROW_HEIGHT) - 2);
            const row = e.key === 'PageDown'
              ? Math.min(activeSheet.maxRow, p.row + page)
              : Math.max(0, p.row - page);
            selectCell(cellRef(p.col, row));
          }
        }
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          setEditingCell(selectedCell);
          setEditValue(e.key);
        }
        break;
    }
  }, [editingCell, navigate, selectedCell, activeSheet, updateCell, getSelectedRefs, selectionRange, pushHistory, activeSheetIdx, selectCell]);

  // Excel-style formula autocomplete: typing "=SU" suggests SUM, SUMIF, … —
  // Tab or click inserts "NAME(" without committing the cell.
  const formulaSuggestions = useMemo(() => {
    if (!editingCell || !editValue.startsWith('=')) return [];
    const token = editValue.match(/([A-Za-z][A-Za-z0-9.]*)$/)?.[1];
    // When only '=' is typed with no prefix yet, show the most common functions as hints
    if (!token) {
      return ['SUM', 'AVERAGE', 'IF', 'VLOOKUP', 'COUNT', 'MAX', 'MIN', 'CONCATENATE'];
    }
    const prefix = token.toUpperCase();
    return FORMULA_FUNCTION_NAMES.filter((name) => name.startsWith(prefix) && name !== prefix).slice(0, 8);
  }, [editingCell, editValue]);
  const [fnSuggestIdx, setFnSuggestIdx] = useState(0);
  useEffect(() => { setFnSuggestIdx(0); }, [editValue, editingCell]);

  const acceptFormulaSuggestion = useCallback((name: string) => {
    setEditValue((prev) => prev.replace(/([A-Za-z][A-Za-z0-9.]*)$/, '') + name + '(');
    editInputRef.current?.focus();
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (formulaSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFnSuggestIdx((i) => (i + 1) % formulaSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFnSuggestIdx((i) => (i - 1 + formulaSuggestions.length) % formulaSuggestions.length);
        return;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        acceptFormulaSuggestion(formulaSuggestions[fnSuggestIdx]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commitEditAndMove(0, e.shiftKey ? -1 : 1, false);
    } else if (e.key === 'Tab' && !e.nativeEvent.isComposing) {
      // Same IME guard as Enter — Tab mid-composition would commit a
      // half-composed Hangul syllable and move the selection.
      e.preventDefault();
      commitEditAndMove(e.shiftKey ? -1 : 1, 0, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEditAndMove, cancelEdit, formulaSuggestions, fnSuggestIdx, acceptFormulaSuggestion]);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      if (selectEditTextOnFocusRef.current) {
        editInputRef.current.select();
        selectEditTextOnFocusRef.current = false;
      }
    }
  }, [editingCell]);

  const insertCellRefIntoEdit = useCallback((ref: string, rangeStart?: string) => {
    // Insert a cell reference (or range ref) at the current cursor position
    // in the inline edit input, like Excel's formula reference picker.
    const rangeRef = rangeStart ? `${rangeStart}:${ref}` : ref;
    setEditValue((prev) => {
      const input = editInputRef.current;
      const start = input?.selectionStart ?? prev.length;
      const end = input?.selectionEnd ?? start;
      return `${prev.slice(0, start)}${rangeRef}${prev.slice(end)}`;
    });
    // Keep focus on edit input
    setTimeout(() => {
      const input = editInputRef.current;
      if (input) {
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
        input.focus();
      }
    }, 0);
  }, []);

  const handleEditBlur = useCallback(() => {
    if (skipNextEditBlurRef.current) {
      skipNextEditBlurRef.current = false;
      return;
    }
    commitEdit();
  }, [commitEdit]);

  // ─── Formula bar ──────────────────────────────────────────────

  const getSelectionReference = useCallback(() => {
    if (selectionRange) {
      const start = cellRef(
        Math.min(selectionRange.startCol, selectionRange.endCol),
        Math.min(selectionRange.startRow, selectionRange.endRow),
      );
      const end = cellRef(
        Math.max(selectionRange.startCol, selectionRange.endCol),
        Math.max(selectionRange.startRow, selectionRange.endRow),
      );
      return start === end ? start : `${start}:${end}`;
    }
    return selectedCell;
  }, [selectedCell, selectionRange]);

  const addConditionalRule = useCallback((type: ConditionalRule['type'], value1?: string, value2?: string) => {
    if (!activeSheet) return;
    pushHistory();
    const rule: ConditionalRule = {
      id: `cf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      range: getSelectionReference(),
      type,
      value1,
      value2,
    };
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      sheet.conditionalRules = [...(sheet.conditionalRules || []), rule];
      next[activeSheetIdx] = sheet;
      return next;
    });
    setShowCfDropdown(false);
    setCfPending(null);
    setCfValue1('');
    setCfValue2('');
  }, [activeSheet, activeSheetIdx, getSelectionReference, pushHistory]);

  const clearConditionalRules = useCallback(() => {
    if (!activeSheet?.conditionalRules?.length) {
      setShowCfDropdown(false);
      return;
    }
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      sheet.conditionalRules = undefined;
      next[activeSheetIdx] = sheet;
      return next;
    });
    setShowCfDropdown(false);
    setCfPending(null);
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const applyFormulaBarValue = useCallback((move: 'none' | 'left' | 'right' = 'none') => {
    const val = formulaBarValue.trim();
    if (val.startsWith('=')) {
      updateCell(selectedCell, val, val);
    } else {
      updateCell(selectedCell, val, undefined);
    }
    setFormulaRefPickActive(false);
    setShowFormulaPicker(false);
    if (move !== 'none' && activeSheet) {
      const nextRef = nextSpreadsheetCellRef(selectedCell, activeSheet, move === 'left' ? -1 : 1, 0, true);
      if (nextRef) selectCell(nextRef, true, true);
    } else {
      gridRef.current?.focus({ preventScroll: true });
    }
  }, [activeSheet, formulaBarValue, selectedCell, selectCell, updateCell]);

  const insertIntoFormulaBar = useCallback((text: string) => {
    const input = formulaInputRef.current;
    setFormulaBarValue((current) => {
      const start = input?.selectionStart ?? current.length;
      const end = input?.selectionEnd ?? start;
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
    window.setTimeout(() => {
      formulaInputRef.current?.focus();
      const pos = (formulaInputRef.current?.selectionStart ?? formulaBarValue.length) + text.length;
      formulaInputRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }, [formulaBarValue.length]);

  const insertFormulaReference = useCallback((ref: string) => {
    const current = formulaBarValue.trim();
    if (!current.startsWith('=')) return;
    insertIntoFormulaBar(ref);
  }, [formulaBarValue, insertIntoFormulaBar]);

  const insertFormulaHelper = useCallback((helper: XlsxFormulaHelper) => {
    const formula = buildFormulaFromHelper(helper, getSelectionReference(), selectedCell);
    setFormulaBarValue(formula);
    setShowFormulaPicker(false);
    setFormulaRefPickActive(true);
    window.setTimeout(() => {
      formulaInputRef.current?.focus();
      formulaInputRef.current?.setSelectionRange(formula.length, formula.length);
    }, 0);
  }, [getSelectionReference, selectedCell]);

  const handleFormulaBarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      applyFormulaBarValue();
    } else if (e.key === 'Escape') {
      const cell = activeSheet?.cells[selectedCell];
      setFormulaBarValue(cell?.formula || cell?.value || '');
      setFormulaRefPickActive(false);
      setShowFormulaPicker(false);
      gridRef.current?.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      applyFormulaBarValue(e.shiftKey ? 'left' : 'right');
    }
  }, [activeSheet, applyFormulaBarValue, selectedCell]);

  // ─── Statistics ───────────────────────────────────────────────

  const stats = useMemo(() => {
    if (!activeSheet) return { count: 0, sum: 0, avg: 0, min: 0, max: 0 };
    const refs = getSelectedRefs();
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const ref of refs) {
      const cell = activeSheet.cells[ref];
      if (!cell) continue;
      const display = getDisplayValue(cell, activeSheet.cells);
      const num = parseFloat(display);
      if (!isNaN(num)) {
        count++;
        sum += num;
        if (num < min) min = num;
        if (num > max) max = num;
      }
    }
    return {
      count,
      sum: Math.round(sum * 1e10) / 1e10,
      avg: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
      min: min === Infinity ? 0 : min,
      max: max === -Infinity ? 0 : max,
    };
  }, [activeSheet, getSelectedRefs]);

  // ─── Freeze pane helpers ───────────────────────────────────────

  const toggleFreezeRow = useCallback(() => {
    if (!activeSheet) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      sheet.frozenRows = (sheet.frozenRows || 0) > 0 ? 0 : 1;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, pushHistory]);

  const toggleFreezeCol = useCallback(() => {
    if (!activeSheet) return;
    pushHistory();
    setSheets(prev => {
      const next = [...prev];
      const sheet = { ...next[activeSheetIdx] };
      sheet.frozenCols = (sheet.frozenCols || 0) > 0 ? 0 : 1;
      next[activeSheetIdx] = sheet;
      return next;
    });
  }, [activeSheet, activeSheetIdx, pushHistory]);

  // ─── Render ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="xlsx-editor" style={{ color: OFFICE_UI.text, background: OFFICE_UI.bg }}>
        <div className="xe-loading">{'Loading XLSX file...'}</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="xlsx-editor" style={{ color: OFFICE_UI.text, background: OFFICE_UI.bg }}>
        <div className="xe-load-error">
          <div className="xe-load-error-title">{L('파일을 열 수 없습니다', 'Cannot open file')}</div>
          <div className="xe-load-error-msg">{L('이 워크북을 읽지 못했습니다. 원본 손상을 막기 위해 저장이 비활성화되었습니다.', 'This workbook could not be read. Saving is disabled to protect the original from corruption.')}</div>
          <div className="xe-load-error-detail">{loadError}</div>
          <div className="xe-load-error-hint">{filePath}</div>
        </div>
      </div>
    );
  }

  if (!activeSheet) {
    return (
      <div className="xlsx-editor" style={{ color: OFFICE_UI.text, background: OFFICE_UI.bg }}>
        <div className="xe-loading">{'No sheet found.'}</div>
      </div>
    );
  }

  const colCount = activeSheet.maxCol + 1;
  const rowCount = activeSheet.maxRow + 1;

  // ─── Row windowing (visible-slot space) ─────────────────────────────
  // Visible rows = source rows the filter did not hide. All math below runs on
  // these indices with a prefix-sum of real row heights, so windowing survives
  // both an active filter (hiddenRows) and custom row heights.
  const visibleRowIndices: number[] = [];
  for (let r = 0; r < rowCount; r++) {
    if (!hiddenRows.has(r)) visibleRowIndices.push(r);
  }
  const visibleRowCount = visibleRowIndices.length;
  const rowLayout = computeRowLayout(visibleRowIndices, activeSheet.rowHeights, DEFAULT_ROW_HEIGHT);
  const virtualizeRows = visibleRowCount > VIRTUAL_ROW_THRESHOLD;
  const rowRange = virtualizeRows
    ? rangeForScroll(scrollTop, Math.max(0, viewportHeight - COL_HEADER_HEIGHT), rowLayout.offsets, ROW_OVERSCAN)
    : { startIdx: 0, endIdx: visibleRowCount - 1 };
  // Frozen rows are the leading visible indices (row index < frozenRows). They
  // are position:sticky at the top, so keep them mounted regardless of scroll.
  let frozenRowVisibleCount = 0;
  while (frozenRowVisibleCount < visibleRowCount && visibleRowIndices[frozenRowVisibleCount] < frozenRows) {
    frozenRowVisibleCount++;
  }
  const frozenRowRenderCount = virtualizeRows ? frozenRowVisibleCount : 0;
  const winStartIdx = virtualizeRows ? Math.max(rowRange.startIdx, frozenRowRenderCount) : 0;
  const winEndIdx = virtualizeRows ? rowRange.endIdx : visibleRowCount - 1;
  const topSpacerPx = virtualizeRows ? rowLayout.offsets[winStartIdx] - rowLayout.offsets[frozenRowRenderCount] : 0;
  const bottomSpacerPx = virtualizeRows && winEndIdx >= 0 ? rowLayout.total - rowLayout.offsets[winEndIdx + 1] : 0;

  // ─── Column windowing (mirror of rows on the horizontal axis) ───────
  // Merges no longer disable windowing: computeColRenderPlan keeps every merge
  // anchor that crosses the window mounted and folds the collapsed columns into
  // spacer slots, so colSpans stay aligned instead of leaving holes.
  const colLayout = computeColLayout(colCount, activeSheet.colWidths, DEFAULT_COL_WIDTH);
  const virtualizeCols = colCount > VIRTUAL_COL_THRESHOLD;
  const colRange = virtualizeCols
    ? rangeForScroll(scrollLeft, viewportWidth, colLayout.offsets, COL_OVERSCAN)
    : { startIdx: 0, endIdx: colCount - 1 };
  // Frozen columns are sticky on the left and always render.
  const frozenColRenderCount = virtualizeCols ? Math.min(frozenCols, colCount) : 0;
  const winColStart = virtualizeCols ? Math.max(colRange.startIdx, frozenColRenderCount) : 0;
  const winColEnd = virtualizeCols ? colRange.endIdx : colCount - 1;
  const colPlan = computeColRenderPlan({
    colCount,
    frozenCols: frozenColRenderCount,
    winColStart,
    winColEnd,
    merges,
    offsets: colLayout.offsets,
    virtualize: virtualizeCols,
  });
  const colSlots = colPlan.slots;
  // Logical column count in every <tr>: row header + one grid column per slot.
  // Vertical spacer rows span all of them.
  const gridColSpan = 1 + colSlots.length;

  const numFmtOptions: { value: string; label: string; icon: React.ReactNode }[] = [
    { value: 'general', label: 'General', icon: <Type size={12} /> },
    { value: 'text', label: L('텍스트', 'Text'), icon: <Type size={12} /> },
    { value: 'integer', label: L('숫자 (0)', 'Number (0)'), icon: <Hash size={12} /> },
    { value: 'number', label: 'Number', icon: <Hash size={12} /> },
    { value: 'decimal1', label: L('숫자 (0.0)', 'Number (0.0)'), icon: <Hash size={12} /> },
    { value: 'decimal2', label: L('숫자 (0.00)', 'Number (0.00)'), icon: <Hash size={12} /> },
    { value: 'currency', label: 'Currency', icon: <DollarSign size={12} /> },
    { value: 'accounting', label: L('회계', 'Accounting'), icon: <DollarSign size={12} /> },
    { value: 'percent', label: 'Percent', icon: <Percent size={12} /> },
    { value: 'date', label: 'Date', icon: <Calendar size={12} /> },
    { value: 'datetime', label: L('날짜 시간', 'Date Time'), icon: <Calendar size={12} /> },
    { value: 'time', label: L('시간', 'Time'), icon: <Calendar size={12} /> },
    { value: 'scientific', label: L('공학용', 'Scientific'), icon: <Hash size={12} /> },
  ];

  const currentNumFmt = numFmtOptions.find(o => o.value === fmtNumberFormat) || numFmtOptions[0];
  const formulaSearch = formulaQuery.trim().toLowerCase();
  const formulaHelpers = XLSX_FORMULA_LIBRARY.filter((helper) => {
    if (!formulaSearch) return true;
    return (
      helper.name.toLowerCase().includes(formulaSearch) ||
      helper.category.toLowerCase().includes(formulaSearch) ||
      helper.description.toLowerCase().includes(formulaSearch)
    );
  });
  const formulaReferenceHint = getSelectionReference();

  return (
    <div
      className="xlsx-editor"
      ref={editorRootRef}
      style={{
        color: OFFICE_UI.text,
        background: OFFICE_UI.bg,
        ['--xe-bg' as string]: OFFICE_UI.bg,
        ['--xe-text' as string]: OFFICE_UI.text,
        ['--xe-accent' as string]: OFFICE_UI.accent,
      } as React.CSSProperties}
    >
      <div className="xe-ribbon">
        <div className="xe-ribbon-tabs">
          {XLSX_RIBBON_TABS.map((tab) => (
            <button
              key={tab}
              className={`xe-ribbon-tab ${activeRibbonTab === tab ? 'active' : ''}`}
              onClick={() => setActiveRibbonTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div
          className="xe-toolbar"
          // 실제 마우스 클릭에서 mousedown이 셀 편집 input을 blur시키면 커밋 리렌더로
          // click 이벤트가 유실돼 "볼드가 안 먹는" 것처럼 보인다 — 버튼류는 포커스를
          // 뺏지 않게 해서 선택/편집 상태를 유지한 채 click이 도달하게 한다.
          onMouseDown={(e) => {
            const target = e.target as HTMLElement;
            // Skip interactive form controls that need native behavior (color pickers, select, etc.)
            if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
            // Labels that wrap a form control (e.g. color picker, select) need
            // their native click-to-focus behavior — do not prevent default.
            const labelEl = target.closest('label') as HTMLLabelElement | null;
            if (labelEl && labelEl.querySelector('input, select, textarea')) return;
            if (target.closest('button, label')) e.preventDefault();
          }}
        >
          {activeRibbonTab === 'File' && (
            <div className="xe-toolbar-group" data-group={L('저장', 'Save')}>
              <button className="xe-btn xe-btn-primary" onClick={() => void handleSave()} disabled={!modified} title={'Save (Cmd+S)'}>
                <Save size={13} /> {L('저장', 'Save')}
              </button>
              <button className="xe-btn" onClick={() => void handleSave(true)} title={'Save As (Cmd+Shift+S)'}>
                <SaveAll size={13} /> {L('다른 이름으로 저장', 'Save As')}
              </button>
            </div>
          )}

          {activeRibbonTab === 'Home' && (
            <>
              <div className="xe-toolbar-group" data-group={L('클립보드', 'Clipboard')}>
                <button className="xe-btn" onClick={handleUndo} disabled={!canUndo} title={'Undo (Cmd+Z)'}><Undo2 size={13} /></button>
                <button className="xe-btn" onClick={handleRedo} disabled={!canRedo} title={'Redo (Cmd+Shift+Z)'}><Redo2 size={13} /></button>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('글꼴', 'Font')}>
                <select
                  className="xe-fmt-select"
                  value={fmtFontSize}
                  onChange={e => handleSetFontSize(parseInt(e.target.value, 10))}
                  title={'Font size'}
                >
                  {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button className={`xe-btn ${fmtBold ? 'active' : ''}`} onClick={handleToggleBold} title={'Bold (Cmd+B)'}><Bold size={13} /></button>
                <button className={`xe-btn ${fmtItalic ? 'active' : ''}`} onClick={handleToggleItalic} title={'Italic (Cmd+I)'}><Italic size={13} /></button>
                <button className={`xe-btn ${fmtUnderline ? 'active' : ''}`} onClick={handleToggleUnderline} title="Underline"><Underline size={13} /></button>
                <button className={`xe-btn ${fmtStrike ? 'active' : ''}`} onClick={handleToggleStrike} title="Strikethrough"><Strikethrough size={13} /></button>
                <button className={`xe-btn ${fmtWrap ? 'active' : ''}`} onClick={handleToggleWrap} title="Wrap Text"><WrapText size={13} /></button>
                <button className="xe-btn" onClick={clearSelectionFormat} title={L('셀 서식 지우기', 'Clear cell formatting')}><Eraser size={13} /></button>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('스타일', 'Styles')}>
                <label className="xe-color-btn" title={'Text color'}>
                  <Type size={14} />
                  <span className="xe-color-bar" style={{ background: fmtColor }} />
                  <input type="color" value={fmtColor} onChange={e => handleSetColor(e.target.value)} />
                </label>
                <label className="xe-color-btn" title={'Background color'}>
                  <PaintBucket size={14} />
                  <span className="xe-color-bar" style={{ background: fmtBgColor === 'transparent' ? 'transparent' : fmtBgColor }} />
                  <input type="color" value={fmtBgColor === 'transparent' ? '#000000' : fmtBgColor} onChange={e => handleSetBgColor(e.target.value)} />
                </label>
                <div style={{ position: 'relative' }}>
                  <button
                    className={`xe-btn ${activeSheet?.conditionalRules?.length ? 'active' : ''}`}
                    onClick={() => { setShowCfDropdown(v => !v); setCfPending(null); }}
                    title="Conditional Formatting"
                  >
                    <Paintbrush size={13} /> <ChevronDown size={10} />
                  </button>
                  {showCfDropdown && (
                    <div className="xe-border-dropdown xe-cf-dropdown">
                      {cfPending ? (
                        <div className="xe-cf-form">
                          <div className="xe-cf-form-title">
                            {cfPending === 'gt' ? 'Greater Than' : cfPending === 'lt' ? 'Less Than'
                              : cfPending === 'between' ? 'Between' : cfPending === 'eq' ? 'Equal To'
                              : cfPending === 'contains' ? 'Text Contains' : 'Top N Items'}
                            {' — '}{getSelectionReference()}
                          </div>
                          <input
                            className="xe-cf-input"
                            autoFocus
                            placeholder={cfPending === 'contains' ? 'text' : cfPending === 'top10' ? '10' : 'value'}
                            value={cfValue1}
                            onChange={e => setCfValue1(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && cfPending !== 'between') addConditionalRule(cfPending, cfValue1); }}
                          />
                          {cfPending === 'between' && (
                            <input
                              className="xe-cf-input"
                              placeholder="and"
                              value={cfValue2}
                              onChange={e => setCfValue2(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') addConditionalRule('between', cfValue1, cfValue2); }}
                            />
                          )}
                          <div className="xe-cf-form-actions">
                            <button className="xe-btn xe-btn-primary" onClick={() => addConditionalRule(cfPending, cfValue1, cfPending === 'between' ? cfValue2 : undefined)}>Apply</button>
                            <button className="xe-btn" onClick={() => setCfPending(null)}>Back</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button className="xe-border-item" onClick={() => setCfPending('gt')}>Greater Than…</button>
                          <button className="xe-border-item" onClick={() => setCfPending('lt')}>Less Than…</button>
                          <button className="xe-border-item" onClick={() => setCfPending('between')}>Between…</button>
                          <button className="xe-border-item" onClick={() => setCfPending('eq')}>Equal To…</button>
                          <button className="xe-border-item" onClick={() => setCfPending('contains')}>Text Contains…</button>
                          <button className="xe-border-item" onClick={() => addConditionalRule('duplicate')}>Duplicate Values</button>
                          <button className="xe-border-item" onClick={() => setCfPending('top10')}>Top 10 Items…</button>
                          <button className="xe-border-item" onClick={() => addConditionalRule('colorScale')}>Color Scale (G-Y-R)</button>
                          <button className="xe-border-item" onClick={() => addConditionalRule('dataBar')}>Data Bars</button>
                          <button className="xe-border-item" onClick={clearConditionalRules}>Clear Rules (Sheet)</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('맞춤', 'Alignment')}>
                <button className={`xe-btn ${fmtAlign === 'left' ? 'active' : ''}`} onClick={() => handleSetAlign('left')} title={'Align left'}><AlignLeft size={13} /></button>
                <button className={`xe-btn ${fmtAlign === 'center' ? 'active' : ''}`} onClick={() => handleSetAlign('center')} title={'Align center'}><AlignCenter size={13} /></button>
                <button className={`xe-btn ${fmtAlign === 'right' ? 'active' : ''}`} onClick={() => handleSetAlign('right')} title={'Align right'}><AlignRight size={13} /></button>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('테두리', 'Borders')} style={{ position: 'relative' }}>
                <button className="xe-btn xe-border-btn" onClick={() => setShowBorderDropdown(v => !v)} title={L('테두리', 'Borders')}>
                  <Grid3x3 size={13} /> <ChevronDown size={10} />
                </button>
                {showBorderDropdown && (
                  <div className="xe-border-dropdown">
                    <button className="xe-border-item" onClick={() => applyBorderPreset('all')}>{L('모든 테두리', 'All borders')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('outline')}>{L('바깥쪽 테두리', 'Outside borders')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('bottom')}>{L('아래쪽 테두리', 'Bottom border')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('top')}>{L('위쪽 테두리', 'Top border')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('left')}>{L('왼쪽 테두리', 'Left border')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('right')}>{L('오른쪽 테두리', 'Right border')}</button>
                    <button className="xe-border-item" onClick={() => applyBorderPreset('none')}>{L('테두리 없음', 'No border')}</button>
                  </div>
                )}
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('표시 형식', 'Number')} style={{ position: 'relative' }}>
                <button className="xe-btn xe-numfmt-btn" onClick={() => setShowNumFmtDropdown(!showNumFmtDropdown)} title={'Number format'}>
                  {currentNumFmt.icon} {currentNumFmt.label} <ChevronDown size={10} />
                </button>
                {showNumFmtDropdown && (
                  <div className="xe-numfmt-dropdown">
                    {numFmtOptions.map(opt => (
                      <button key={opt.value} className={`xe-numfmt-item ${fmtNumberFormat === opt.value ? 'active' : ''}`} onClick={() => handleSetNumberFormat(opt.value)}>
                        {opt.icon} {opt.label}
                      </button>
                    ))}
                  </div>
                )}
                <button className="xe-btn" onClick={handleDecreaseDecimals} title={L('소수 자릿수 줄임', 'Decrease decimals')}>.0-</button>
                <button className="xe-btn" onClick={handleIncreaseDecimals} title={L('소수 자릿수 늘림', 'Increase decimals')}>.0+</button>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('셀', 'Cells')}>
                <button className="xe-btn" onClick={handleMerge} disabled={!selectionRange} title={'Merge cells'}><Merge size={13} /></button>
                <button className="xe-btn" onClick={handleUnmerge} title={'Unmerge cells'}><SplitSquareHorizontal size={13} /></button>
                <button className="xe-btn" onClick={() => { const p = parseCellRef(selectedCell); if (p) insertRow(p.row); }} title={'Insert row'}><ArrowDownToLine size={13} /></button>
                <button className="xe-btn" onClick={() => { const p = parseCellRef(selectedCell); if (p) insertCol(p.col); }} title={'Insert column'}><ArrowRightToLine size={13} /></button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Insert' && (
            <div className="xe-toolbar-group" data-group={L('표, 차트, 추가 기능', 'Tables, Charts, Add-ins')}>
              <button className="xe-btn" onClick={formatSelectionAsSmartTable} title={L('선택 범위를 스마트 표로 서식 지정', 'Format the selected range as a smart table')}><Table2 size={13} /> {L('표', 'Table')}</button>
              <button className="xe-btn" onClick={createSummarySheet} title={L('선택 범위에서 요약 시트 생성', 'Create a summary sheet from the selected range')}><Calculator size={13} /> {L('요약', 'Summary')}</button>
              <button className="xe-btn" onClick={createPivotSheet} title={L('선택 범위에서 피벗 요약 시트 생성', 'Create a pivot summary sheet from the selected range')}>{L('피벗', 'Pivot')}</button>
              <button className="xe-btn" onClick={createDashboardSheet} title={L('선택 범위에서 대시보드 시트 생성', 'Create a dashboard sheet from the selected range')}><BarChart3 size={13} /> {L('대시보드', 'Dashboard')}</button>
              <button className="xe-btn" onClick={createInsightSheet} title={L('데이터 프로파일링·품질 점검이 포함된 인사이트 시트 생성', 'Create an insight sheet with data profiling and quality checks')}><Sparkles size={13} /> {L('인사이트', 'Insight')}</button>
            </div>
          )}

          {activeRibbonTab === 'Draw' && (
            <>
              <div className="xe-toolbar-group" data-group={L('그리기 도구', 'Drawing Tools')}>
                <button className="xe-btn" onClick={clearSelectionFormat} title={L('셀 서식 지우기', 'Clear cell formatting')}><Eraser size={13} /> {L('지우개', 'Eraser')}</button>
                <button className="xe-btn" onClick={applySelectionHeatmap} title={L('숫자 셀에 조건부 히트맵 적용', 'Apply conditional heatmap to numeric cells')}><Flame size={13} /> {L('형광펜', 'Highlighter')}</button>
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('펜', 'Pens')}>
                <label className="xe-color-btn" title={'Text color'}>
                  <Type size={14} />
                  <span className="xe-color-bar" style={{ background: fmtColor }} />
                  <input type="color" value={fmtColor} onChange={e => handleSetColor(e.target.value)} />
                </label>
                <label className="xe-color-btn" title={'Background color'}>
                  <PaintBucket size={14} />
                  <span className="xe-color-bar" style={{ background: fmtBgColor === 'transparent' ? 'transparent' : fmtBgColor }} />
                  <input type="color" value={fmtBgColor === 'transparent' ? '#000000' : fmtBgColor} onChange={e => handleSetBgColor(e.target.value)} />
                </label>
              </div>
            </>
          )}

          {activeRibbonTab === 'Page Layout' && (
            <div className="xe-toolbar-group" data-group={L('페이지 설정', 'Page Setup')}>
              <button className="xe-btn" onClick={autoFitSelectedColumns} title={L('선택 열 자동 맞춤', 'Auto-fit selected columns')}><ChevronsLeftRight size={13} /> {L('자동 맞춤', 'AutoFit')}</button>
              <button className={`xe-btn ${frozenRows > 0 ? 'active' : ''}`} onClick={toggleFreezeRow} title={'Freeze first row'}>
                {frozenRows > 0 ? <Unlock size={13} /> : <Lock size={13} />} {L('첫 행', 'Top Row')}
              </button>
              <button className={`xe-btn ${frozenCols > 0 ? 'active' : ''}`} onClick={toggleFreezeCol} title={'Freeze first column'}>
                {frozenCols > 0 ? <Unlock size={13} /> : <Lock size={13} />} {L('첫 열', 'First Column')}
              </button>
            </div>
          )}

          {activeRibbonTab === 'Formulas' && (
            <div className="xe-toolbar-group" data-group={L('함수 라이브러리, 수식 분석, 계산', 'Function Library, Formula Auditing, Calculation')}>
              <button className="xe-btn xe-btn-primary" onClick={createFormulaAuditSheet} title={L('참조·위험 플래그가 포함된 수식 감사 시트 생성', 'Create a formula audit sheet with references and risk flags')}><Calculator size={13} /> Formula+</button>
              <button className="xe-btn xe-btn-primary" onClick={createSolverSheet} title={L('예산 배분·의사결정 트레이드오프를 위한 목표 탐색 최적화 시트 생성', 'Create a goal-seeking optimization sheet for budget allocation and decision tradeoffs')}><Target size={13} /> Solver+</button>
              <button className="xe-btn" onClick={createSensitivitySheet} title={L('선택 범위에서 목표 탐색·민감도 모델 생성', 'Create a goal seek and sensitivity model from the selected range')}><Target size={13} /> Sensitivity+</button>
              <button className="xe-btn" onClick={createScenarioSheet} title={L('선택 범위에서 가상 시나리오 모델 생성', 'Create a what-if scenario model from the selected range')}><SlidersHorizontal size={13} /> Scenario+</button>
            </div>
          )}

          {activeRibbonTab === 'Data' && (
            <>
              <div className="xe-toolbar-group" data-group={L('정렬 및 필터', 'Sort & Filter')}>
                <button className="xe-btn" onClick={() => handleSort(true)} title={'Sort ascending'}><ArrowUpDown size={13} /></button>
                <button className="xe-btn" onClick={() => handleSort(false)} title={'Sort descending'}><ArrowDownUp size={13} /></button>
                <button
                  className={`xe-btn ${filterCol !== null ? 'active' : ''}`}
                  onClick={() => {
                    const p = parseCellRef(selectedCell);
                    if (p) handleToggleFilter(p.col);
                  }}
                  title={'Toggle filter'}
                >
                  <Filter size={13} />
                </button>
                {filterCol !== null && <button className="xe-btn" onClick={clearFilter} title={'Clear filter'}><FilterX size={13} /></button>}
              </div>
              <div className="xe-toolbar-sep" />
              <div className="xe-toolbar-group" data-group={L('데이터 도구', 'Data Tools')}>
                <button className="xe-btn xe-btn-primary" onClick={createCleanRoomSheet} title={L('선택 범위에서 정제·타입 지정된 데이터 준비 시트 생성', 'Create a cleaned, typed data prep sheet from the selected range')}><Eraser size={13} /> Clean+</button>
                <button className="xe-btn xe-btn-primary" onClick={createDataDoctorSheet} title={L('공백·중복·이상치·수식 오류를 진단하는 데이터 품질 시트 생성', 'Create a data quality doctor sheet for blanks, duplicates, outliers, and formula errors')}><Search size={13} /> Doctor+</button>
                <button className="xe-btn" onClick={createCorrelationSheet} title={L('숫자 필드로 상관 행렬·동인 관계 시트 생성', 'Create a correlation matrix and driver relationship sheet from numeric fields')}><BarChart3 size={13} /> Correlation+</button>
                <button className="xe-btn" onClick={createWaterfallSheet} title={L('선택 범위의 변동을 설명하는 워터폴 브리지 생성', 'Create a waterfall bridge explaining movement across the selected range')}><BarChart3 size={13} /> Waterfall+</button>
                <button className="xe-btn" onClick={createAnomalySheet} title={L('이상치·급변을 감지하는 이상 모니터 생성', 'Create an anomaly monitor for outliers and sudden changes')}><Search size={13} /> Anomaly+</button>
                <button className="xe-btn" onClick={createForecastSheet} title={L('선택 범위에서 추세 예측 시트 생성', 'Create a trend forecast sheet from the selected range')}><TrendingUp size={13} /> {L('예측', 'Forecast')}</button>
                <button className="xe-btn" onClick={applySelectionHeatmap} title={L('숫자 셀에 조건부 히트맵 적용', 'Apply conditional heatmap to numeric cells')}><Flame size={13} /> {L('히트맵', 'Heatmap')}</button>
              </div>
            </>
          )}

          {activeRibbonTab === 'Review' && (
            <div className="xe-toolbar-group" data-group={L('언어 교정', 'Proofing')}>
              <button className="xe-btn" onClick={() => setShowSearch(!showSearch)} title={'Search (Cmd+F)'}><Search size={13} /> {L('찾기', 'Find')}</button>
              <button className="xe-btn xe-btn-primary" onClick={createDataDoctorSheet} title={L('공백·중복·이상치·수식 오류를 진단하는 데이터 품질 시트 생성', 'Create a data quality doctor sheet for blanks, duplicates, outliers, and formula errors')}><Search size={13} /> Doctor+</button>
            </div>
          )}

          {activeRibbonTab === 'View' && (
            <div className="xe-toolbar-group" data-group={L('통합 문서 보기', 'Workbook Views')}>
              <button className={`xe-btn ${frozenRows > 0 ? 'active' : ''}`} onClick={toggleFreezeRow} title={'Freeze first row'}>
                {frozenRows > 0 ? <Unlock size={13} /> : <Lock size={13} />} {L('행 고정', 'Freeze Row')}
              </button>
              <button className={`xe-btn ${frozenCols > 0 ? 'active' : ''}`} onClick={toggleFreezeCol} title={'Freeze first column'}>
                {frozenCols > 0 ? <Unlock size={13} /> : <Lock size={13} />} {L('열 고정', 'Freeze Col')}
              </button>
              <span className="xe-ribbon-stat">{selectedCell}</span>
              <span className="xe-ribbon-stat">{L('개수', 'Count')} {stats.count}</span>
              <span className="xe-ribbon-stat">{L('합계', 'Sum')} {stats.sum}</span>
            </div>
          )}

          {activeRibbonTab === 'Automate' && (
            <div className="xe-toolbar-group" data-group={L('Office 스크립트', 'Office Scripts')}>
              <button className="xe-btn xe-btn-primary" onClick={createExecutiveWorkbook} title={L('선택 범위에서 경영 분석 통합 문서 생성', 'Create an executive analysis workbook from the selected range')}><BriefcaseBusiness size={13} /> Workbook+</button>
              <button className="xe-btn xe-btn-primary" onClick={createKpiStudioSheet} title={L('선택 범위에서 KPI 의사결정 콕핏 생성', 'Create a KPI decision cockpit from the selected range')}><Target size={13} /> KPI+</button>
              <button className="xe-btn xe-btn-primary" onClick={createVarianceSheet} title={L('선택 범위에서 실적 대 예산 관리 시트 생성', 'Create an actual-vs-budget control sheet from the selected range')}><SlidersHorizontal size={13} /> Variance+</button>
            </div>
          )}

          {activeRibbonTab === 'Help' && (
            <div className="xe-toolbar-group" data-group={L('도움말', 'Help')}>
              <button className="xe-btn" onClick={createInsightSheet} title={L('데이터 프로파일링·품질 점검이 포함된 인사이트 시트 생성', 'Create an insight sheet with data profiling and quality checks')}><Sparkles size={13} /> {L('인사이트', 'Insights')}</button>
            </div>
          )}
        </div>
      </div>

      {/* Search/Replace bar */}
      {showSearch && (
        <div className="xe-search-bar">
          <div className="xe-search-group">
            <Search size={12} />
            <input
              className="xe-search-input"
              value={searchText}
              onChange={e => { setSearchText(e.target.value); doSearch(e.target.value); }}
              placeholder={'Search...'}
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') searchNext();
                if (e.key === 'Escape') setShowSearch(false);
              }}
            />
            <span className="xe-search-count">
              {searchResults.length > 0 ? `${searchIdx + 1}/${searchResults.length}` : '0 results'}
            </span>
            <button className="xe-btn" onClick={searchPrev} title={'Previous'}>&#9650;</button>
            <button className="xe-btn" onClick={searchNext} title={'Next'}>&#9660;</button>
          </div>
          <div className="xe-search-group">
            <Replace size={12} />
            <input
              className="xe-search-input"
              value={replaceText}
              onChange={e => setReplaceText(e.target.value)}
              placeholder={'Replace...'}
              onKeyDown={e => {
                if (e.key === 'Enter') doReplace();
              }}
            />
            <button className="xe-btn" onClick={doReplace} title={'Replace'}>{'Replace'}</button>
            <button className="xe-btn" onClick={doReplaceAll} title={'All'}>{'All'}</button>
          </div>
          <button className="xe-btn" onClick={() => setShowSearch(false)} style={{ marginLeft: 4 }}>&#10005;</button>
        </div>
      )}

      {/* Formula bar */}
      <div className="xe-formula-bar">
        <div className="xe-formula-shell">
          <input
            className="xe-cell-ref"
            value={refDraft ?? selectedCell}
            onChange={(e) => setRefDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setRefDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setRefDraft(null); (e.target as HTMLInputElement).blur(); return; }
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              // Excel name box: "B250" jumps, "A1:C10" selects the range.
              const raw = (refDraft ?? '').trim().toUpperCase();
              if (!raw) return;
              const [a, b] = raw.split(':');
              const pa = parseCellRef(a);
              if (!pa) return;
              const pb = b ? parseCellRef(b) : null;
              if (pb) {
                setSelectionRange({ startCol: pa.col, startRow: pa.row, endCol: pb.col, endRow: pb.row });
              } else {
                setSelectionRange(null);
              }
              setSelectedCell(cellRef(pa.col, pa.row));
              setRefDraft(null);
              focusGrid();
            }}
            title={L('셀 참조 — 입력 후 Enter로 이동 (예: B250, A1:C10)', 'Cell reference — type and press Enter to jump (e.g. B250, A1:C10)')}
          />
          <span className="xe-formula-divider" />
          <button
            type="button"
            className={`xe-formula-fx-btn ${showFormulaPicker ? 'active' : ''}`}
            onClick={() => {
              setShowFormulaPicker((v) => !v);
              setActiveRibbonTab('Formulas');
            }}
            title={L('함수 예시 보기', 'View function examples')}
          >
            fx
          </button>
          <button
            type="button"
            className={`xe-ref-pick-btn ${formulaRefPickActive ? 'active' : ''}`}
            onClick={() => {
              setFormulaRefPickActive((v) => !v);
              window.setTimeout(() => formulaInputRef.current?.focus(), 0);
            }}
            disabled={!formulaBarValue.trim().startsWith('=')}
            title={L('시트에서 셀을 클릭해 수식에 추가', 'Click a cell in the sheet to add it to the formula')}
          >
            <Crosshair size={13} />
          </button>
          <input
            ref={formulaInputRef}
            className="xe-formula-input"
            value={formulaBarValue}
            onChange={e => {
              const nextValue = e.target.value;
              setFormulaBarValue(nextValue);
              if (nextValue.startsWith('=')) setFormulaRefPickActive(true);
            }}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={() => {
              if (formulaBarValue.trim().startsWith('=')) setFormulaRefPickActive(true);
            }}
            placeholder={'Value or formula (=SUM, =IF, =VLOOKUP ...)'}
          />
          <button
            type="button"
            className="xe-apply-formula-btn"
            onClick={() => applyFormulaBarValue()}
            title={L('수식/값 적용', 'Apply formula/value')}
          >
            {L('적용', 'Apply')}
          </button>
        </div>
        {showFormulaPicker && (
          <div className="xe-formula-picker">
            <div className="xe-formula-picker-head">
              <strong>{L('함수 예시', 'Function examples')}</strong>
              <span>{L('현재 참조', 'Current reference')}: {formulaReferenceHint}</span>
            </div>
            <input
              className="xe-formula-search"
              value={formulaQuery}
              onChange={e => setFormulaQuery(e.target.value)}
              placeholder={L('SUM, IF, XLOOKUP 검색', 'Search SUM, IF, XLOOKUP')}
              autoFocus
            />
            <div className="xe-formula-list">
              {formulaHelpers.map((helper) => {
                const preview = buildFormulaFromHelper(helper, formulaReferenceHint, selectedCell);
                return (
                  <button
                    key={helper.name}
                    type="button"
                    className="xe-formula-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertFormulaHelper(helper)}
                  >
                    <span className="xe-formula-item-main">
                      <strong>{helper.name}</strong>
                      <code>{helper.syntax}</code>
                      <em>{preview}</em>
                    </span>
                    <span>{helper.description}</span>
                  </button>
                );
              })}
            </div>
            <div className="xe-formula-picker-foot">
              {L('예시를 고른 뒤 시트에서 셀이나 범위를 클릭하면 좌표가 수식에 삽입됩니다.', 'Pick an example, then click a cell or range in the sheet to insert its coordinates into the formula.')}
            </div>
          </div>
        )}
        {formulaRefPickActive && formulaBarValue.trim().startsWith('=') && (
          <div className="xe-formula-pick-hint">
            {L('수식 참조 모드: 셀/범위를 클릭하면 좌표가 삽입됩니다.', 'Formula reference mode: click a cell/range to insert its coordinates.')}
          </div>
        )}
      </div>

      {/* Grid */}
      <div
        className="xe-grid-wrap"
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onScroll={virtualizeRows || virtualizeCols ? (e => {
          if (virtualizeRows) setScrollTop(e.currentTarget.scrollTop);
          if (virtualizeCols) setScrollLeft(e.currentTarget.scrollLeft);
        }) : undefined}
      >
        <table className="xe-grid">
          <thead>
            <tr>
              <th className="xe-corner" onClick={selectAll} title={'Select all'} />
              {(() => {
              const renderColHeader = (c: number): React.ReactNode => {
                const isColSelected = selectionRange
                  ? c >= Math.min(selectionRange.startCol, selectionRange.endCol) && c <= Math.max(selectionRange.startCol, selectionRange.endCol)
                  : parseCellRef(selectedCell)?.col === c;
                return (
                  <th
                    key={c}
                    className={`xe-col-hdr ${isColSelected ? 'selected' : ''}`}
                    style={{
                      width: activeSheet.colWidths[c] || DEFAULT_COL_WIDTH,
                      ...(frozenCols > 0 && c < frozenCols ? { position: 'sticky', left: 42, zIndex: 5 } : {}),
                    }}
                    onClick={(e) => {
                      if (e.shiftKey && selectionRange) {
                        // Shift+click: extend column selection
                        setSelectionRange(prev => prev ? {
                          ...prev,
                          endCol: c,
                          startRow: 0,
                          endRow: activeSheet.maxRow,
                        } : { startCol: c, startRow: 0, endCol: c, endRow: activeSheet.maxRow });
                      } else {
                        selectColumn(c);
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0 || e.shiftKey) return;
                      e.preventDefault();
                      focusGrid();
                      dragStartRef.current = { col: c, row: -1 };
                      setIsDragging(true);
                    }}
                    onMouseEnter={() => {
                      if (isDragging && dragStartRef.current && dragStartRef.current.row === -1) {
                        const startC = dragStartRef.current.col;
                        setSelectionRange({
                          startCol: Math.min(startC, c),
                          startRow: 0,
                          endCol: Math.max(startC, c),
                          endRow: activeSheet.maxRow,
                        });
                        setSelectedCell(cellRef(Math.min(startC, c), 0));
                      }
                    }}
                    onContextMenu={e => {
                      e.preventDefault();
                      // Select the column being right-clicked — menu actions read
                      // the selection, so a stale A1 selection would otherwise
                      // insert/delete at the wrong column.
                      selectColumn(c);
                      setCtxMenu({ x: e.clientX, y: e.clientY, type: 'col', idx: c });
                    }}
                  >
                    {colToLetter(c)}
                    {filterCol === c && (
                      <span
                        className="xe-filter-icon"
                        onClick={e => { e.stopPropagation(); setFilterDropdownCol(c); }}
                      >
                        <Filter size={10} />
                      </span>
                    )}
                    <div
                      className="xe-col-resize"
                      onMouseDown={e => handleColResizeStart(e, c)}
                    />
                    {/* Filter dropdown */}
                    {filterDropdownCol === c && filterValues && (
                      <FilterDropdown
                        values={filterValues}
                        hiddenRows={hiddenRows}
                        colIdx={c}
                        sheet={activeSheet}
                        onApply={(selected) => applyFilter(c, selected)}
                        onClose={() => setFilterDropdownCol(null)}
                      />
                    )}
                  </th>
                );
              };
              const hdr: React.ReactNode[] = [];
              for (const slot of colSlots) {
                if (slot.kind === 'col') {
                  hdr.push(renderColHeader(slot.startCol));
                } else {
                  hdr.push(<th key={`xe-col-spacer-${slot.startCol}`} className="xe-spacer-col" style={{ width: slot.width, minWidth: slot.width, padding: 0 }} aria-hidden />);
                }
              }
              return hdr;
              })()}
            </tr>
          </thead>
          <tbody>
            {(() => {
              // Only visible (non-filtered) row indices reach renderRow, so no
              // hidden-row guard is needed here anymore.
              const renderRow = (r: number): React.ReactNode => {
              const isRowSelected = selectionRange
                ? r >= Math.min(selectionRange.startRow, selectionRange.endRow) && r <= Math.max(selectionRange.startRow, selectionRange.endRow)
                : parseCellRef(selectedCell)?.row === r;
              return (
                <tr key={r}>
                  <td
                    className={`xe-row-hdr ${isRowSelected ? 'selected' : ''}`}
                    style={{
                      height: activeSheet.rowHeights[r] || DEFAULT_ROW_HEIGHT,
                      position: 'relative',
                      ...(frozenRows > 0 && r < frozenRows ? { position: 'sticky', top: 28, zIndex: 3 } : {}),
                    }}
                    onClick={(e) => {
                      if (e.shiftKey && selectionRange) {
                        setSelectionRange(prev => prev ? {
                          ...prev,
                          endRow: r,
                          startCol: 0,
                          endCol: activeSheet.maxCol,
                        } : { startCol: 0, startRow: r, endCol: activeSheet.maxCol, endRow: r });
                      } else {
                        selectRow(r);
                      }
                    }}
                    onMouseDown={(e) => {
                      if (e.button !== 0 || e.shiftKey) return;
                      e.preventDefault();
                      focusGrid();
                      dragStartRef.current = { col: -1, row: r };
                      setIsDragging(true);
                    }}
                    onMouseEnter={() => {
                      if (isDragging && dragStartRef.current && dragStartRef.current.col === -1) {
                        const startR = dragStartRef.current.row;
                        setSelectionRange({
                          startCol: 0,
                          startRow: Math.min(startR, r),
                          endCol: activeSheet.maxCol,
                          endRow: Math.max(startR, r),
                        });
                        setSelectedCell(cellRef(0, Math.min(startR, r)));
                      }
                    }}
                    onContextMenu={e => {
                      e.preventDefault();
                      selectRow(r);
                      setCtxMenu({ x: e.clientX, y: e.clientY, type: 'row', idx: r });
                    }}
                  >
                    {r + 1}
                    <div
                      className="xe-row-resize"
                      onMouseDown={e => handleRowResizeStart(e, r)}
                    />
                  </td>
                  {(() => {
                  const renderCell = (c: number): React.ReactNode => {
                    // Check merge
                    const hiddenMerge = isCellHiddenByMerge(c, r, merges);
                    if (hiddenMerge) return null;

                    const merge = getMergeForCell(c, r, merges);
                    const ref = cellRef(c, r);
                    const cell = activeSheet.cells[ref];
                    const isSelected = ref === selectedCell;
                    const isEditing = ref === editingCell;
                    const inRange = isInSelection(c, r) && !isSelected;
                    const inAutoFill = autoFillTarget && (() => {
                      const parsed = parseCellRef(selectedCell);
                      if (!parsed) return false;
                      if (autoFillTarget.col === parsed.col) {
                        const minR = Math.min(parsed.row, autoFillTarget.row);
                        const maxR = Math.max(parsed.row, autoFillTarget.row);
                        return c === parsed.col && r >= minR && r <= maxR && r !== parsed.row;
                      }
                      const minC = Math.min(parsed.col, autoFillTarget.col);
                      const maxC = Math.max(parsed.col, autoFillTarget.col);
                      return r === parsed.row && c >= minC && c <= maxC && c !== parsed.col;
                    })();
                    const isSearchHighlight = searchResultSet.has(ref);
                    const displayRaw = getDisplayValue(cell, activeSheet.cells);
                    const displayVal = formatDisplayValue(displayRaw, cell?.format?.numberFormat);
                    const fmt = cell?.format;
                    // Conditional formats beat manual fills (Excel precedence).
                    const cf = cfMap.get(ref);
                    const cfBarPct = cf?.barFraction !== undefined ? Math.round(cf.barFraction * 100) : null;
                    const cellStyle: React.CSSProperties = {
                      width: activeSheet.colWidths[c] || DEFAULT_COL_WIDTH,
                      height: activeSheet.rowHeights[r] || DEFAULT_ROW_HEIGHT,
                      fontWeight: fmt?.bold ? 700 : undefined,
                      fontStyle: fmt?.italic ? 'italic' : undefined,
                      textDecoration: [fmt?.underline ? 'underline' : '', fmt?.strikethrough ? 'line-through' : '']
                        .filter(Boolean).join(' ') || undefined,
                      ...(fmt?.wrapText ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const } : {}),
                      color: cf?.text || fmt?.color || undefined,
                      backgroundColor: cf?.bg || fmt?.bgColor || undefined,
                      ...(cfBarPct !== null ? {
                        backgroundImage: `linear-gradient(to right, ${cf?.barColor || '#638ec6'}59 ${cfBarPct}%, transparent ${cfBarPct}%)`,
                      } : {}),
                      textAlign: fmt?.align || 'left',
                      fontSize: fmt?.fontSize ? `${fmt.fontSize}px` : undefined,
                      ...(fmt?.border?.top ? { borderTop: CELL_BORDER_STYLE } : {}),
                      ...(fmt?.border?.bottom ? { borderBottom: CELL_BORDER_STYLE } : {}),
                      ...(fmt?.border?.left ? { borderLeft: CELL_BORDER_STYLE } : {}),
                      ...(fmt?.border?.right ? { borderRight: CELL_BORDER_STYLE } : {}),
                      ...(frozenRows > 0 && r < frozenRows ? { position: 'sticky' as const, top: 28, zIndex: 2 } : {}),
                      ...(frozenCols > 0 && c < frozenCols ? { position: 'sticky' as const, left: 42, zIndex: 2 } : {}),
                    };

                    return (
                      <td
                        key={c}
                        className={[
                          'xe-cell',
                          isSelected ? 'selected' : '',
                          isEditing ? 'editing' : '',
                          inRange ? 'in-range' : '',
                          inAutoFill ? 'in-autofill' : '',
                          isSearchHighlight ? 'search-highlight' : '',
                        ].filter(Boolean).join(' ')}
                        style={cellStyle}
                        colSpan={merge ? gridColSpanForMerge(colSlots, merge.startCol, merge.endCol) : undefined}
                        rowSpan={merge ? merge.endRow - merge.startRow + 1 : undefined}
                        onClick={(e) => {
                          if (formulaRefPickActiveRef.current && formulaBarValue.trim().startsWith('=')) {
                            e.preventDefault();
                            e.stopPropagation();
                            insertFormulaReference(ref);
                            setSelectedCell(ref);
                            return;
                          }
                          if (editingCell && editingCell !== ref) {
                            // When editing a formula (starts with =), clicking another cell
                            // inserts the reference instead of committing — like Excel's
                            // range-pick during formula input.
                            if (editValue.trim().startsWith('=')) {
                              e.preventDefault();
                              e.stopPropagation();
                              const dragStart = formulaDragRef.current;
                              formulaDragRef.current = null;
                              insertCellRefIntoEdit(ref, dragStart && dragStart !== ref ? dragStart : undefined);
                              return;
                            }
                            commitEdit();
                          }
                          if (e.metaKey || e.ctrlKey) {
                            // Multi-select
                            setMultiSelect(prev => {
                              const next = new Set(prev);
                              if (next.has(ref)) next.delete(ref);
                              else next.add(ref);
                              return next;
                            });
                            setSelectionRange(null);
                          } else if (e.shiftKey) {
                            // Range select
                            const anchor = parseCellRef(selectedCell);
                            const target = parseCellRef(ref);
                            if (anchor && target) {
                              setSelectionRange({
                                startCol: anchor.col, startRow: anchor.row,
                                endCol: target.col, endRow: target.row,
                              });
                            }
                            setMultiSelect(new Set());
                        } else {
                          setSelectedCell(ref);
                          setSelectionRange(null);
                          setMultiSelect(new Set());
                        }
                        focusGrid();
                      }}
                        onMouseDown={(e) => {
                          if (formulaRefPickActiveRef.current && formulaBarValue.trim().startsWith('=')) {
                            e.preventDefault();
                            return;
                          }
                          // Formula editing mode: record mousedown ref for potential
                          // drag-to-range selection.
                          if (editingCell && editValue.trim().startsWith('=')) {
                            formulaDragRef.current = ref;
                            e.preventDefault();
                            return;
                          }
                          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          focusGrid();
                          const parsed = parseCellRef(ref);
                          if (parsed) {
                            dragStartRef.current = parsed;
                            setIsDragging(true);
                            setSelectionRange(null);
                            setMultiSelect(new Set());
                          }
                        }}
                        onMouseEnter={() => {
                          if (isDragging && dragStartRef.current) {
                            // Column drag mode (started from column header)
                            if (dragStartRef.current.row === -1) {
                              const startC = dragStartRef.current.col;
                              setSelectionRange({
                                startCol: Math.min(startC, c),
                                startRow: 0,
                                endCol: Math.max(startC, c),
                                endRow: activeSheet.maxRow,
                              });
                              setSelectedCell(cellRef(Math.min(startC, c), 0));
                            // Row drag mode (started from row header)
                            } else if (dragStartRef.current.col === -1) {
                              const startR = dragStartRef.current.row;
                              setSelectionRange({
                                startCol: 0,
                                startRow: Math.min(startR, r),
                                endCol: activeSheet.maxCol,
                                endRow: Math.max(startR, r),
                              });
                              setSelectedCell(cellRef(0, Math.min(startR, r)));
                            // Normal cell drag
                            } else {
                              const parsed = parseCellRef(ref);
                              if (parsed) {
                                setSelectionRange({
                                  startCol: dragStartRef.current.col,
                                  startRow: dragStartRef.current.row,
                                  endCol: parsed.col,
                                  endRow: parsed.row,
                                });
                              }
                            }
                          }
                          if (autoFillDragging) {
                            setAutoFillTarget({ col: c, row: r });
                          }
                        }}
                        onDoubleClick={() => {
                          setEditingCell(ref);
                          setEditValue(cell?.formula || cell?.value || '');
                          focusGrid();
                        }}
                        onContextMenu={e => handleCellContextMenu(e, ref)}
                        data-cell-ref={ref}
                      >
                        {isEditing ? (
                          <>
                            <input
                              ref={editInputRef}
                              className="xe-cell-input"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onKeyDown={handleEditKeyDown}
                              onBlur={handleEditBlur}
                              style={{
                                fontWeight: fmt?.bold ? 700 : undefined,
                                fontStyle: fmt?.italic ? 'italic' : undefined,
                                fontSize: fmt?.fontSize ? `${fmt.fontSize}px` : undefined,
                              }}
                            />
                            {formulaSuggestions.length > 0 && (
                              <div className="xe-fn-suggest">
                                {formulaSuggestions.map((name, i) => (
                                  <button
                                    key={name}
                                    className={`xe-fn-suggest-item ${i === fnSuggestIdx ? 'active' : ''}`}
                                    // mousedown (not click): the edit input must not blur-commit first
                                    onMouseDown={e => { e.preventDefault(); acceptFormulaSuggestion(name); }}
                                  >
                                    <span className="xe-fn-suggest-name">{name}</span>
                                    <span className="xe-fn-suggest-hint">
                                      {XLSX_FORMULA_LIBRARY.find(h => h.name === name)?.syntax || `${name}(…)`}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {displayVal}
                            {isSelected && !isEditing && (
                              <div
                                className="xe-autofill-handle"
                                onMouseDown={e => {
                                  e.stopPropagation();
                                  setAutoFillDragging(true);
                                  setAutoFillTarget({ col: c, row: r });
                                }}
                              />
                            )}
                          </>
                        )}
                      </td>
                    );
                  };
                  const cells: React.ReactNode[] = [];
                  for (const slot of colSlots) {
                    if (slot.kind === 'col') {
                      cells.push(renderCell(slot.startCol));
                      continue;
                    }
                    // A spacer inside a merge is painted by the anchor's
                    // colSpan/rowSpan on that merge's rows, so drop it there.
                    if (slot.coverRows && slot.coverRows.some(rr => r >= rr.startRow && r <= rr.endRow)) continue;
                    cells.push(<td key={`xe-cell-spacer-${slot.startCol}`} className="xe-spacer-col" style={{ padding: 0 }} aria-hidden />);
                  }
                  return cells;
                  })()}
                </tr>
              );
              };
              const out: React.ReactNode[] = [];
              // Frozen rows stay mounted at the top even when scrolled away.
              for (let i = 0; i < frozenRowRenderCount; i++) out.push(renderRow(visibleRowIndices[i]));
              if (topSpacerPx > 0) {
                out.push(
                  <tr key="xe-top-spacer" className="xe-spacer-row" style={{ height: topSpacerPx }}>
                    <td colSpan={gridColSpan} />
                  </tr>,
                );
              }
              for (let i = winStartIdx; i <= winEndIdx; i++) out.push(renderRow(visibleRowIndices[i]));
              if (bottomSpacerPx > 0) {
                out.push(
                  <tr key="xe-bottom-spacer" className="xe-spacer-row" style={{ height: bottomSpacerPx }}>
                    <td colSpan={gridColSpan} />
                  </tr>,
                );
              }
              return out;
            })()}
          </tbody>
        </table>
      </div>

      {/* Context menu */}
      {ctxMenu && ctxMenu.type === 'sheet' && (
        <div className="xe-ctx-menu" style={{ top: Math.max(0, Math.min(ctxMenu.y, window.innerHeight - 130)), left: Math.max(0, Math.min(ctxMenu.x, window.innerWidth - 200)) }}>
          <button onClick={() => { setRenamingSheet(ctxMenu.idx); setRenameValue(sheets[ctxMenu.idx]?.name || ''); setCtxMenu(null); }}>
            {L('이름 바꾸기', 'Rename')}
          </button>
          <button onClick={() => { duplicateSheet(ctxMenu.idx); setCtxMenu(null); }}>
            <Copy size={13} /> {L('시트 복제', 'Duplicate sheet')}
          </button>
          <div className="xe-ctx-sep" />
          <button disabled={sheets.length <= 1} onClick={() => { deleteSheet(ctxMenu.idx); setCtxMenu(null); }}>
            <Trash2 size={13} /> {L('시트 삭제', 'Delete sheet')}
          </button>
        </div>
      )}
      {ctxMenu && ctxMenu.type !== 'sheet' && (
        <div className="xe-ctx-menu" style={{ top: Math.max(0, Math.min(ctxMenu.y, window.innerHeight - 360)), left: Math.max(0, Math.min(ctxMenu.x, window.innerWidth - 200)) }}>
          {ctxMenu.type === 'cell' && (
            <>
              <button onClick={() => { handleCut(); setCtxMenu(null); }}>{L('잘라내기', 'Cut')}</button>
              <button onClick={() => { handleCopy(); setCtxMenu(null); }}>{'Copy'}</button>
              <button onClick={() => { void handlePaste(); setCtxMenu(null); }}>{'Paste'}</button>
              <div className="xe-ctx-sep" />
            </>
          )}
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) insertRow(p.row); setCtxMenu(null); }}>
            <ArrowDownToLine size={13} /> {'Insert row above'}
          </button>
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) insertRow(p.row + 1); setCtxMenu(null); }}>
            <ArrowDownToLine size={13} /> {'Insert row below'}
          </button>
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) insertCol(p.col); setCtxMenu(null); }}>
            <ArrowRightToLine size={13} /> {'Insert column left'}
          </button>
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) insertCol(p.col + 1); setCtxMenu(null); }}>
            <ArrowRightToLine size={13} /> {'Insert column right'}
          </button>
          <div className="xe-ctx-sep" />
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) deleteRow(p.row); setCtxMenu(null); }}>
            <Trash2 size={13} /> {'Delete row'}
          </button>
          <button onClick={() => { const p = parseCellRef(selectedCell); if (p) deleteCol(p.col); setCtxMenu(null); }}>
            <Trash2 size={13} /> {'Delete column'}
          </button>
          <div className="xe-ctx-sep" />
          {ctxMenu.type === 'cell' && (
            <>
              <button onClick={() => { handleSort(true); setCtxMenu(null); }}>
                <ArrowUpDown size={13} /> {'Sort ascending'}
              </button>
              <button onClick={() => { handleSort(false); setCtxMenu(null); }}>
                <ArrowDownUp size={13} /> {'Sort descending'}
              </button>
              <div className="xe-ctx-sep" />
            </>
          )}
          <button onClick={() => { updateCell(selectedCell, '', undefined); setCtxMenu(null); }}>
            <Trash2 size={13} /> {'Clear cell content'}
          </button>
          <button onClick={() => { clearSelectionFormat(); setCtxMenu(null); }}>
            <Eraser size={13} /> {L('서식 지우기', 'Clear formatting')}
          </button>
          <button onClick={() => { autoFitSelectedColumns(); setCtxMenu(null); }}>
            <ChevronsLeftRight size={13} /> {L('열 자동 맞춤', 'Auto-fit columns')}
          </button>
        </div>
      )}

      {/* Sheet tabs */}
      <div className="xe-sheet-tabs">
        {sheets.map((sheet, idx) => (
          <div
            key={idx}
            className={`xe-sheet-tab ${idx === activeSheetIdx ? 'active' : ''}`}
            onClick={() => setActiveSheetIdx(idx)}
            onDoubleClick={() => { setRenamingSheet(idx); setRenameValue(sheet.name); }}
            onContextMenu={e => {
              // Right-click opens a menu — it must never destroy data directly.
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY, type: 'sheet', idx });
            }}
          >
            {renamingSheet === idx ? (
              <input
                className="xe-sheet-rename"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') renameSheet(idx, renameValue);
                  if (e.key === 'Escape') setRenamingSheet(null);
                }}
                onBlur={() => renameSheet(idx, renameValue)}
                autoFocus
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="xe-sheet-tab-name">{sheet.name}</span>
            )}
            {sheets.length > 1 && (
              <button
                className="xe-sheet-tab-close"
                onClick={(e) => { e.stopPropagation(); deleteSheet(idx); }}
                title={L('시트 닫기', 'Close sheet')}
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <div className="xe-sheet-tab-add" onClick={addSheet} title={'Add sheet'}>
          <Plus size={14} />
        </div>
      </div>

      {/* Status bar */}
      <div className="xe-status-bar">
        <div className="xe-status-left">
          <span className="xe-status-pill filetype">XLSX</span>
          <span className={`xe-status-pill ${modified ? 'dirty' : ''}`}>{modified ? '● Modified' : 'Saved'}</span>
          <span className="xe-status-pill accent">{selectedCell}</span>
          {selectionRange && (
            <span className="xe-status-pill">
              {cellRef(Math.min(selectionRange.startCol, selectionRange.endCol), Math.min(selectionRange.startRow, selectionRange.endRow))}
              :
              {cellRef(Math.max(selectionRange.startCol, selectionRange.endCol), Math.max(selectionRange.startRow, selectionRange.endRow))}
            </span>
          )}
        </div>
        {stats.count > 0 && (
          <div className="xe-status-center">
            <span>{'Count'} {stats.count}</span>
            <span>{'Sum'} {stats.sum}</span>
            <span>{'Avg'} {stats.avg}</span>
            <span>{'Min'} {stats.min}</span>
            <span>{'Max'} {stats.max}</span>
          </div>
        )}
        <div className="xe-status-right">
          <span>{activeSheet.maxRow + 1} × {activeSheet.maxCol + 1}</span>
        </div>
      </div>

      {saveToast && (
        <div className={`xe-save-toast xe-save-toast-${saveToast.kind}`} role="status">
          {saveToast.text}
        </div>
      )}
    </div>
  );
}

// ─── Filter Dropdown Sub-component ───────────────────────────────

function FilterDropdown({ values, colIdx: _colIdx, sheet: _sheet, onApply, onClose: _onClose }: {
  values: Set<string>;
  hiddenRows: Set<number>;
  colIdx: number;
  sheet: SheetData;
  onApply: (selected: Set<string>) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(values));

  const toggle = (val: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      return next;
    });
  };

  const sortedValues = useMemo(() => {
    const arr = Array.from(values);
    arr.sort((a, b) => a.localeCompare(b));
    return arr;
  }, [values]);

  return (
    <div className="xe-filter-dropdown" onClick={e => e.stopPropagation()}>
      <div className="xe-filter-list">
        {sortedValues.map((val, i) => (
          <label key={i} className="xe-filter-item">
            <input
              type="checkbox"
              checked={selected.has(val)}
              onChange={() => toggle(val)}
            />
            <span>{val || '(empty)'}</span>
          </label>
        ))}
      </div>
      <div className="xe-filter-actions">
        <button className="xe-btn" onClick={() => setSelected(new Set(values))}>{'Select all'}</button>
        <button className="xe-btn" onClick={() => setSelected(new Set())}>{'Deselect all'}</button>
        <button className="xe-btn xe-btn-primary" onClick={() => onApply(selected)}>{'Apply'}</button>
      </div>
    </div>
  );
}

export default XlsxEditor;
