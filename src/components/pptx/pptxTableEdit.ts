import type { TableData, TableCell } from './types';

// Pure row/column insert & delete transforms for TableData that keep the
// parallel cellData (merge + fill metadata) aligned with the text grid.
// Insertions/deletions that cut across an existing colSpan/rowSpan merge
// decompose (unmerge) that merge so cells and cellData never disagree.

interface MergeRect {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
}

function cloneCellData(cd: TableCell[][]): TableCell[][] {
  return cd.map((row) => row.map((cell) => ({ ...cell })));
}

function emptyCell(): TableCell {
  return {};
}

// Strip span/merge fields, preserving visual props (fill/color/align).
function clearSpan(cell: TableCell): TableCell {
  const out: TableCell = { ...cell };
  delete out.colSpan;
  delete out.rowSpan;
  delete out.hMerge;
  delete out.vMerge;
  return out;
}

function forEachMergeOrigin(cd: TableCell[][], fn: (rect: MergeRect) => void): void {
  for (let r = 0; r < cd.length; r++) {
    const row = cd[r];
    for (let c = 0; c < row.length; c++) {
      const rowSpan = row[c].rowSpan ?? 1;
      const colSpan = row[c].colSpan ?? 1;
      if (rowSpan > 1 || colSpan > 1) fn({ r, c, rowSpan, colSpan });
    }
  }
}

function decomposeRect(cd: TableCell[][], rect: MergeRect): void {
  for (let r = rect.r; r < rect.r + rect.rowSpan && r < cd.length; r++) {
    for (let c = rect.c; c < rect.c + rect.colSpan && c < cd[r].length; c++) {
      cd[r][c] = clearSpan(cd[r][c]);
    }
  }
}

// index is the position the new row lands at (0..rows). Merges spanning across
// the boundary above `index` are decomposed before the row is inserted.
export function insertTableRow(t: TableData, index: number): TableData {
  const at = Math.max(0, Math.min(index, t.rows));
  const cells = t.cells.map((r) => r.slice());
  cells.splice(at, 0, Array.from({ length: t.cols }, () => ''));

  let cellData = t.cellData;
  if (cellData) {
    const next = cloneCellData(cellData);
    forEachMergeOrigin(next, (rect) => {
      if (rect.r < at && rect.r + rect.rowSpan - 1 >= at) decomposeRect(next, rect);
    });
    next.splice(at, 0, Array.from({ length: t.cols }, () => emptyCell()));
    cellData = next;
  }

  return { ...t, rows: t.rows + 1, cells, ...(cellData ? { cellData } : {}) };
}

export function removeTableRow(t: TableData, index: number): TableData {
  if (t.rows <= 1) return t;
  const at = Math.max(0, Math.min(index, t.rows - 1));
  const cells = t.cells.map((r) => r.slice());
  cells.splice(at, 1);

  let cellData = t.cellData;
  if (cellData) {
    const next = cloneCellData(cellData);
    forEachMergeOrigin(next, (rect) => {
      if (rect.r <= at && rect.r + rect.rowSpan - 1 >= at) decomposeRect(next, rect);
    });
    next.splice(at, 1);
    cellData = next;
  }

  return { ...t, rows: t.rows - 1, cells, ...(cellData ? { cellData } : {}) };
}

// index is the position the new column lands at (0..cols).
export function insertTableCol(t: TableData, index: number): TableData {
  const at = Math.max(0, Math.min(index, t.cols));
  const cols = t.cols + 1;
  const cells = t.cells.map((r) => {
    const row = r.slice();
    row.splice(at, 0, '');
    return row;
  });

  let cellData = t.cellData;
  if (cellData) {
    const next = cloneCellData(cellData);
    forEachMergeOrigin(next, (rect) => {
      if (rect.c < at && rect.c + rect.colSpan - 1 >= at) decomposeRect(next, rect);
    });
    for (const row of next) row.splice(at, 0, emptyCell());
    cellData = next;
  }

  return {
    ...t,
    cols,
    cells,
    colWidths: Array.from({ length: cols }, () => 1 / cols),
    ...(cellData ? { cellData } : {}),
  };
}

export function removeTableCol(t: TableData, index: number): TableData {
  if (t.cols <= 1) return t;
  const at = Math.max(0, Math.min(index, t.cols - 1));
  const cols = t.cols - 1;
  const cells = t.cells.map((r) => {
    const row = r.slice();
    row.splice(at, 1);
    return row;
  });

  let cellData = t.cellData;
  if (cellData) {
    const next = cloneCellData(cellData);
    forEachMergeOrigin(next, (rect) => {
      if (rect.c <= at && rect.c + rect.colSpan - 1 >= at) decomposeRect(next, rect);
    });
    for (const row of next) row.splice(at, 1);
    cellData = next;
  }

  return {
    ...t,
    cols,
    cells,
    colWidths: Array.from({ length: cols }, () => 1 / cols),
    ...(cellData ? { cellData } : {}),
  };
}
