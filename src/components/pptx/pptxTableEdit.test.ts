import { describe, expect, it } from 'vitest';
import type { TableData, TableCell } from './types';
import { insertTableRow, removeTableRow, insertTableCol, removeTableCol } from './pptxTableEdit';

// A 3×3 table carrying a vertical merge (0,0 spans two rows) and a
// horizontal merge (0,1 spans two cols). Fill colors let us assert that
// decomposition keeps visual props while stripping span metadata.
function mergedTable(): TableData {
  const empty = (): TableCell => ({});
  const cellData: TableCell[][] = [
    [empty(), empty(), empty()],
    [empty(), empty(), empty()],
    [empty(), empty(), empty()],
  ];
  cellData[0][0] = { rowSpan: 2, fillColor: '#ff0000' };
  cellData[1][0] = { vMerge: true };
  cellData[0][1] = { colSpan: 2, fillColor: '#00ff00' };
  cellData[0][2] = { hMerge: true };
  return {
    rows: 3,
    cols: 3,
    cells: [
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
      ['g', 'h', 'i'],
    ],
    cellData,
    colWidths: [1 / 3, 1 / 3, 1 / 3],
  };
}

function plainTable(): TableData {
  return {
    rows: 2,
    cols: 2,
    cells: [
      ['a', 'b'],
      ['c', 'd'],
    ],
    colWidths: [0.5, 0.5],
  };
}

describe('pptxTableEdit — row insert', () => {
  it('appends a row and grows cellData in lockstep without touching merges', () => {
    const t = mergedTable();
    const out = insertTableRow(t, t.rows);
    expect(out.rows).toBe(4);
    expect(out.cells).toHaveLength(4);
    expect(out.cells[3]).toEqual(['', '', '']);
    expect(out.cellData).toHaveLength(4);
    expect(out.cellData![3]).toEqual([{}, {}, {}]);
    // Merge at the top is untouched by an end-append.
    expect(out.cellData![0][0].rowSpan).toBe(2);
  });

  it('decomposes a vertical merge the inserted row cuts through', () => {
    const t = mergedTable();
    const out = insertTableRow(t, 1);
    expect(out.rows).toBe(4);
    // Origin loses its span but keeps the fill.
    expect(out.cellData![0][0].rowSpan).toBeUndefined();
    expect(out.cellData![0][0].fillColor).toBe('#ff0000');
    // Absorbed cell shifted down and lost vMerge.
    expect(out.cellData![2][0].vMerge).toBeUndefined();
    expect(out.cellData![1][0]).toEqual({});
  });

  it('leaves the source table unmutated', () => {
    const t = mergedTable();
    insertTableRow(t, 1);
    expect(t.rows).toBe(3);
    expect(t.cellData![0][0].rowSpan).toBe(2);
  });

  it('inserts into a plain table without inventing cellData', () => {
    const out = insertTableRow(plainTable(), 2);
    expect(out.rows).toBe(3);
    expect(out.cells[2]).toEqual(['', '']);
    expect(out.cellData).toBeUndefined();
  });
});

describe('pptxTableEdit — row remove', () => {
  it('removes a row and shrinks cellData in lockstep', () => {
    const out = removeTableRow(mergedTable(), 2);
    expect(out.rows).toBe(2);
    expect(out.cells).toHaveLength(2);
    expect(out.cellData).toHaveLength(2);
  });

  it('decomposes a vertical merge that covers the removed row', () => {
    const out = removeTableRow(mergedTable(), 1);
    expect(out.rows).toBe(2);
    // Merge origin lost its span before its partner row was deleted.
    expect(out.cellData![0][0].rowSpan).toBeUndefined();
    expect(out.cellData![0][0].fillColor).toBe('#ff0000');
  });

  it('never drops below a single row', () => {
    const single: TableData = { rows: 1, cols: 2, cells: [['a', 'b']], cellData: [[{}, {}]] };
    expect(removeTableRow(single, 0)).toBe(single);
  });

  it('removes from a plain table without inventing cellData', () => {
    const out = removeTableRow(plainTable(), 0);
    expect(out.rows).toBe(1);
    expect(out.cells).toEqual([['c', 'd']]);
    expect(out.cellData).toBeUndefined();
  });
});

describe('pptxTableEdit — col insert', () => {
  it('appends a column, resets widths, and grows every cellData row', () => {
    const out = insertTableCol(mergedTable(), mergedTable().cols);
    expect(out.cols).toBe(4);
    expect(out.cells.every((r) => r.length === 4)).toBe(true);
    expect(out.cellData!.every((r) => r.length === 4)).toBe(true);
    expect(out.colWidths).toHaveLength(4);
    expect(out.colWidths!.every((w) => w === 1 / 4)).toBe(true);
  });

  it('keeps a merge intact when inserting at its left edge', () => {
    const out = insertTableCol(mergedTable(), 1);
    expect(out.cellData![0][2].colSpan).toBe(2);
  });

  it('decomposes a horizontal merge the inserted column cuts through', () => {
    const out = insertTableCol(mergedTable(), 2);
    expect(out.cols).toBe(4);
    expect(out.cellData![0][1].colSpan).toBeUndefined();
    expect(out.cellData![0][1].fillColor).toBe('#00ff00');
  });

  it('inserts into a plain table without inventing cellData', () => {
    const out = insertTableCol(plainTable(), 1);
    expect(out.cols).toBe(3);
    expect(out.cells[0]).toEqual(['a', '', 'b']);
    expect(out.cellData).toBeUndefined();
  });
});

describe('pptxTableEdit — col remove', () => {
  it('removes a column and shrinks every cellData row', () => {
    const out = removeTableCol(mergedTable(), 2);
    expect(out.cols).toBe(2);
    expect(out.cells.every((r) => r.length === 2)).toBe(true);
    expect(out.cellData!.every((r) => r.length === 2)).toBe(true);
    expect(out.colWidths).toHaveLength(2);
  });

  it('decomposes a horizontal merge that covers the removed column', () => {
    const out = removeTableCol(mergedTable(), 2);
    expect(out.cellData![0][1].colSpan).toBeUndefined();
    expect(out.cellData![0][1].fillColor).toBe('#00ff00');
  });

  it('never drops below a single column', () => {
    const single: TableData = { rows: 1, cols: 1, cells: [['a']], cellData: [[{}]] };
    expect(removeTableCol(single, 0)).toBe(single);
  });

  it('removes from a plain table without inventing cellData', () => {
    const out = removeTableCol(plainTable(), 0);
    expect(out.cols).toBe(1);
    expect(out.cells).toEqual([['b'], ['d']]);
    expect(out.cellData).toBeUndefined();
  });
});
