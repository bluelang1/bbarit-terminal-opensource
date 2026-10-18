import { describe, expect, it } from 'vitest';
import { diffSnapshots, formatWatchDiff, parseNumeric, type PageSnapshot } from './browserWatch';

const snap = (values: Record<string, string>): PageSnapshot => ({ url: 'https://x.test', values, takenAt: 1 });

describe('parseNumeric', () => {
  it('parses prices, percents, currencies', () => {
    expect(parseNumeric('₩89,000')).toBe(89000);
    expect(parseNumeric('$19.99')).toBe(19.99);
    expect(parseNumeric('12,000원')).toBe(12000);
    expect(parseNumeric('-5%')).toBe(-5);
  });
  it('returns null for non-numeric', () => {
    expect(parseNumeric('sold out')).toBeNull();
    expect(parseNumeric('')).toBeNull();
    expect(parseNumeric(undefined as unknown as string)).toBeNull();
  });
});

describe('diffSnapshots', () => {
  // None: identical snapshots → no changes.
  it('reports no change for identical snapshots', () => {
    const d = diffSnapshots(snap({ price: '₩89,000', title: 'A' }), snap({ price: '₩89,000', title: 'A' }));
    expect(d.changed).toBe(false);
    expect(d.summary).toMatch(/no changes/i);
  });

  // 정상: a price drop yields a numeric delta and percent.
  it('detects a numeric change with delta and percent', () => {
    const d = diffSnapshots(snap({ price: '₩100,000' }), snap({ price: '₩80,000' }));
    expect(d.changed).toBe(true);
    const c = d.changes[0];
    expect(c.kind).toBe('changed');
    expect(c.numericDelta).toBe(-20000);
    expect(c.percentDelta).toBe(-20);
  });

  // 매핑: added and removed keys.
  it('detects added and removed fields', () => {
    const d = diffSnapshots(snap({ a: '1' }), snap({ b: '2' }));
    const kinds = Object.fromEntries(d.changes.map((c) => [c.key, c.kind]));
    expect(kinds).toEqual({ a: 'removed', b: 'added' });
  });

  // 매핑: non-numeric text change (no delta).
  it('detects a text change without a numeric delta', () => {
    const d = diffSnapshots(snap({ status: 'In stock' }), snap({ status: 'Sold out' }));
    expect(d.changes[0]).toMatchObject({ key: 'status', kind: 'changed', before: 'In stock', after: 'Sold out' });
    expect(d.changes[0].numericDelta).toBeUndefined();
  });

  // 매핑: biggest % change sorts first.
  it('sorts the most impactful numeric change first', () => {
    const d = diffSnapshots(
      snap({ a: '100', b: '100' }),
      snap({ a: '90', b: '10' }), // a: -10%, b: -90%
    );
    expect(d.changes[0].key).toBe('b');
  });

  // 변조/None: null snapshots don't throw.
  it('tolerates null snapshots', () => {
    expect(diffSnapshots(null, snap({ a: '1' })).changes[0].kind).toBe('added');
    expect(diffSnapshots(snap({ a: '1' }), null).changes[0].kind).toBe('removed');
    expect(diffSnapshots(null, null).changed).toBe(false);
  });
});

describe('formatWatchDiff', () => {
  it('renders a change table', () => {
    const md = formatWatchDiff(diffSnapshots(snap({ price: '100' }), snap({ price: '80' })));
    expect(md).toContain('# Page changes');
    expect(md).toContain('| Field | Change | Before | After | Δ |');
    expect(md).toContain('-20 (-20%)');
  });
  it('renders no-change summary plainly', () => {
    expect(formatWatchDiff(diffSnapshots(snap({ a: '1' }), snap({ a: '1' })))).toMatch(/no changes/i);
  });
});
