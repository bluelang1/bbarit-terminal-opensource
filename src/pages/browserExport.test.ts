import { describe, expect, it } from 'vitest';
import {
  collectRecords,
  exportExtract,
  recordsToCsv,
  safeFileStem,
  unionKeys,
} from './browserExport';
import type { ExtractResult } from './browserExtract';

const result: ExtractResult = {
  tables: [{ headers: ['Name', 'Price'], rows: [{ Name: 'A', Price: '10' }, { Name: 'B', Price: '20' }], rowCount: 2 }],
  lists: [[{ title: 'Item X', price: '1,000' }, { title: 'Item Y', href: '/y' }]],
  totalRecords: 4,
};

describe('collectRecords', () => {
  it('flattens tables and lists into one record array', () => {
    const recs = collectRecords(result);
    expect(recs).toHaveLength(4);
    expect(recs[0]).toEqual({ Name: 'A', Price: '10' });
    expect(recs[2]).toEqual({ title: 'Item X', price: '1,000' });
  });
  it('handles empty result', () => {
    expect(collectRecords({ tables: [], lists: [], totalRecords: 0 })).toEqual([]);
  });
});

describe('unionKeys', () => {
  // 매핑: union in first-seen order across heterogeneous records.
  it('unions keys across records preserving order', () => {
    expect(unionKeys([{ a: '1', b: '2' }, { b: '3', c: '4' }])).toEqual(['a', 'b', 'c']);
  });
  it('returns empty for no records', () => {
    expect(unionKeys([])).toEqual([]);
  });
});

describe('recordsToCsv', () => {
  // 정상: header row + escaped cells.
  it('serializes records to CSV with escaping', () => {
    const csv = recordsToCsv([{ name: 'A, B', note: 'has "q"' }, { name: 'C', extra: 'x' }]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('name,note,extra');       // union of keys
    expect(lines[1]).toBe('"A, B","has ""q""",');   // escaped, sparse extra empty
    expect(lines[2]).toBe('C,,x');
  });
  // None: no records → empty string.
  it('returns empty string for no records', () => {
    expect(recordsToCsv([])).toBe('');
  });
});

describe('exportExtract', () => {
  it('exports CSV by default', () => {
    const out = exportExtract(result);
    expect(out.format).toBe('csv');
    expect(out.ext).toBe('csv');
    expect(out.recordCount).toBe(4);
    expect(out.content.split('\n')[0]).toBe('Name,Price,title,price,href');
  });
  it('exports JSON when requested', () => {
    const out = exportExtract(result, 'json');
    expect(out.ext).toBe('json');
    const parsed = JSON.parse(out.content);
    expect(parsed).toHaveLength(4);
    expect(parsed[2]).toEqual({ title: 'Item X', price: '1,000' });
  });
  // 변조: empty result exports cleanly.
  it('handles an empty result', () => {
    const out = exportExtract({ tables: [], lists: [], totalRecords: 0 });
    expect(out.recordCount).toBe(0);
    expect(out.content).toBe('');
  });
});

describe('safeFileStem', () => {
  it('sanitizes host/url into a filename stem', () => {
    expect(safeFileStem('https://www.example.com/products')).toBe('www.example.com-products');
    expect(safeFileStem('a/b\\c:d')).toBe('a-b-c-d');
    expect(safeFileStem('')).toBe('export');
    expect(safeFileStem('   ', 'fallback')).toBe('fallback');
  });
});
