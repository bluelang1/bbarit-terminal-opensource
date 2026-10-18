import { describe, expect, it } from 'vitest';
import {
  extractStructured,
  formatExtract,
  looksNumeric,
  normalizeHeaders,
  toCsv,
  type ExtractInput,
} from './browserExtract';

describe('normalizeHeaders', () => {
  // 정상 + 매핑: blanks get colN, duplicates get suffixed.
  it('makes headers non-empty and unique', () => {
    expect(normalizeHeaders(['Name', '', 'Name'])).toEqual(['Name', 'col2', 'Name_2']);
    expect(normalizeHeaders([' Price ', 'Qty'])).toEqual(['Price', 'Qty']);
  });
});

describe('looksNumeric', () => {
  it('detects numbers, prices and percents', () => {
    expect(looksNumeric('1,299')).toBe(true);
    expect(looksNumeric('$19.99')).toBe(true);
    expect(looksNumeric('₩12,000')).toBe(true);
    expect(looksNumeric('-5%')).toBe(true);
    expect(looksNumeric('sold out')).toBe(false);
    expect(looksNumeric('')).toBe(false);
  });
});

describe('extractStructured', () => {
  const input: ExtractInput = {
    tables: [{
      headers: ['Product', 'Price', 'Stock'],
      rows: [['Widget', '$9.99', '12'], ['Gadget', '$19.99', '0'], ['', '', '']],
    }],
    lists: [{
      items: [{ title: 'Item A', price: '1,000' }, { title: 'Item B', price: '2,000' }],
    }],
  };

  // 정상: table + list normalize into records; empty row dropped.
  it('extracts tables and lists into clean records', () => {
    const r = extractStructured(input);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0].rowCount).toBe(2); // empty row dropped
    expect(r.tables[0].rows[0]).toEqual({ Product: 'Widget', Price: '$9.99', Stock: '12' });
    expect(r.lists).toHaveLength(1);
    expect(r.lists[0]).toHaveLength(2);
    expect(r.totalRecords).toBe(4);
  });

  // 매핑: ragged rows and missing headers are padded/filled.
  it('handles ragged rows and missing headers', () => {
    const r = extractStructured({ tables: [{ rows: [['a', 'b', 'c'], ['d', 'e'], ['f', 'g', 'h']] }] });
    expect(r.tables[0].headers).toEqual(['col1', 'col2', 'col3']);
    expect(r.tables[0].rows[1]).toEqual({ col1: 'd', col2: 'e', col3: '' });
  });

  // None: a table/list below MIN_ROWS is dropped (no fake structure).
  it('drops structures below the minimum row count', () => {
    expect(extractStructured({ tables: [{ headers: ['a'], rows: [['1']] }] }).tables).toEqual([]);
    expect(extractStructured({ lists: [{ items: [{ x: '1' }] }] }).lists).toEqual([]);
  });

  // 변조: empty/malformed input never throws.
  it('tolerates empty and malformed input', () => {
    expect(extractStructured({})).toEqual({ tables: [], lists: [], totalRecords: 0 });
    expect(extractStructured(undefined as unknown as ExtractInput).totalRecords).toBe(0);
    expect(extractStructured({ tables: [{ rows: [[], []] }] }).tables).toEqual([]); // no width
  });
});

describe('toCsv', () => {
  it('renders CSV with escaping', () => {
    const table = { headers: ['Name', 'Note'], rows: [{ Name: 'A, B', Note: 'has "quote"' }, { Name: 'C', Note: '' }], rowCount: 2 };
    const csv = toCsv(table);
    expect(csv.split('\n')[0]).toBe('Name,Note');
    expect(csv).toContain('"A, B"');
    expect(csv).toContain('"has ""quote"""');
  });
});

describe('formatExtract', () => {
  it('renders a summary with tables and lists', () => {
    const md = formatExtract(extractStructured({ tables: [{ headers: ['A', 'B'], rows: [['1', '2'], ['3', '4']] }] }));
    expect(md).toContain('Extracted 2 record(s)');
    expect(md).toContain('## Table 1');
  });
  it('reports nothing found gracefully', () => {
    expect(formatExtract(extractStructured({}))).toContain('no structured tables');
  });
  it('truncates long tables with a +more note', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`${i}`, `v${i}`]);
    const md = formatExtract(extractStructured({ tables: [{ headers: ['i', 'v'], rows }] }), { limit: 5 });
    expect(md).toContain('+25 more rows');
  });
});
