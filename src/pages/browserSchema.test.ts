import { describe, expect, it } from 'vitest';
import {
  applySchema,
  coerceNumber,
  formatSchemaResult,
  matchKey,
  parseSchema,
  type SchemaField,
} from './browserSchema';

describe('parseSchema', () => {
  // 정상 + 매핑: object list, "name:type" strings, and comma string.
  it('parses object, typed-string, and comma forms', () => {
    expect(parseSchema([{ name: 'title' }, { name: 'price', type: 'price', required: true }]))
      .toEqual([{ name: 'title', type: 'string', aliases: [], required: false }, { name: 'price', type: 'price', aliases: [], required: true }]);
    expect(parseSchema(['title', 'price:number'])).toEqual([
      { name: 'title', type: 'string', aliases: [], required: false },
      { name: 'price', type: 'number', aliases: [], required: false },
    ]);
    expect(parseSchema('title, price, rating')).toHaveLength(3);
  });
  // None/변조: junk → empty.
  it('returns empty for junk', () => {
    expect(parseSchema(null)).toEqual([]);
    expect(parseSchema('')).toEqual([]);
    expect(parseSchema([{ name: '' }])).toEqual([]);
  });
});

describe('coerceNumber', () => {
  it('extracts numbers from prices/percents', () => {
    expect(coerceNumber('₩1,299')).toBe(1299);
    expect(coerceNumber('$19.99')).toBe(19.99);
    expect(coerceNumber('4.5 stars')).toBe(4.5);
    expect(coerceNumber('sold out')).toBeNull();
  });
});

describe('matchKey', () => {
  const keys = ['Product Name', 'price', '평점'];
  // 매핑: exact/alias/substring/locale.
  it('matches by name, alias, substring and Korean', () => {
    expect(matchKey({ name: 'name' }, keys)).toBe('Product Name');       // substring
    expect(matchKey({ name: 'title', aliases: ['name'] }, keys)).toBe('Product Name');
    expect(matchKey({ name: 'price' }, keys)).toBe('price');
    expect(matchKey({ name: 'rating', aliases: ['평점'] }, keys)).toBe('평점');
    expect(matchKey({ name: 'nonexistent' }, keys)).toBeNull();
  });
});

describe('applySchema', () => {
  const raw: Array<Record<string, string>> = [
    { 'Product Name': 'Wireless Buds', price: '₩89,000', 평점: '4.5' },
    { 'Product Name': 'Mouse', price: '₩45,900' },   // no rating
    { unrelated: 'x' },                               // no schema fields
  ];
  const schema: SchemaField[] = [
    { name: 'title', type: 'string', aliases: ['name'] },
    { name: 'price', type: 'price' },
    { name: 'rating', type: 'number', aliases: ['평점'], required: true },
  ];

  // 정상: maps + coerces; records with no fields dropped.
  it('maps records onto the schema and coerces types', () => {
    const r = applySchema(schema, raw);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toEqual({ title: 'Wireless Buds', price: 89000, rating: 4.5 });
    expect(r.records[1]).toEqual({ title: 'Mouse', price: 45900, rating: null });
    expect(r.coverage).toEqual({ title: 2, price: 2, rating: 1 });
    expect(r.missingRequired).toEqual([]);   // rating found in ≥1 record
  });

  // 매핑: a required field absent everywhere is reported.
  it('reports a required field missing from all records', () => {
    const r = applySchema([{ name: 'A', type: 'string' }, { name: 'stock', type: 'number', required: true }] as SchemaField[], raw);
    expect(r.missingRequired).toContain('stock');
  });

  // None/변조: empty inputs never throw.
  it('tolerates empty inputs', () => {
    expect(applySchema([], raw).records).toEqual([]);
    expect(applySchema(schema, []).records).toEqual([]);
    expect(applySchema(schema, undefined as unknown as Array<Record<string, string>>).records).toEqual([]);
  });
});

describe('formatSchemaResult', () => {
  it('renders coverage and records', () => {
    const schema = parseSchema(['title', 'price:price']);
    const md = formatSchemaResult(schema, applySchema(schema, [{ title: 'A', price: '10' }, { title: 'B', price: '20' }]));
    expect(md).toContain('# Schema extract — 2 record(s)');
    expect(md).toContain('coverage →');
    expect(md).toContain('title: A · price: 10');
  });
});
