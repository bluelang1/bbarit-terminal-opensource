import { describe, expect, it } from 'vitest';
import {
  dedupeEndpoints,
  formatReverseReport,
  normalizeApiPath,
  type ReverseNetEntry,
  type ReverseSnapshot,
} from './browserReverseEngineer';

describe('normalizeApiPath', () => {
  // 정상 + 매핑: numeric/uuid/hash segments collapse to :id.
  it('collapses id-like path segments', () => {
    expect(normalizeApiPath('/users/123/orders/456')).toBe('/users/:id/orders/:id');
    expect(normalizeApiPath('/api/v1/products')).toBe('/api/v1/products');
    expect(normalizeApiPath('/item/8f14e45f-ceea-467a-9d3b-1a2b3c4d5e6f')).toBe('/item/:id');
    expect(normalizeApiPath('/blob/deadbeefdeadbeef')).toBe('/blob/:id');
  });

  // None: empty path becomes root.
  it('maps empty path to root', () => {
    expect(normalizeApiPath('')).toBe('/');
    expect(normalizeApiPath('/')).toBe('/');
  });
});

describe('dedupeEndpoints', () => {
  const net: ReverseNetEntry[] = [
    { method: 'GET', url: 'https://api.example.com/users/1', type: 'fetch', status: 200 },
    { method: 'GET', url: 'https://api.example.com/users/2', type: 'fetch', status: 200 },
    { method: 'GET', url: 'https://api.example.com/users/3', type: 'xhr', status: 404 },
    { method: 'POST', url: 'https://api.example.com/login', type: 'fetch', status: 200 },
    { method: 'GET', url: 'https://cdn.example.com/logo.png', type: 'image', status: 200 },
    { method: 'GET', url: 'https://example.com/data', type: 'other', mime: 'application/json', status: 200 },
  ];

  // 정상: fetch/xhr/json collapse; assets excluded.
  it('dedupes API-like requests and excludes assets', () => {
    const out = dedupeEndpoints(net);
    const users = out.find((e) => e.path === '/users/:id');
    expect(users?.count).toBe(3);
    expect(users?.statuses.sort()).toEqual([200, 404]);
    expect(out.some((e) => e.method === 'POST' && e.path === '/login')).toBe(true);
    expect(out.some((e) => e.path === '/data')).toBe(true); // json mime counts
    expect(out.some((e) => e.path.includes('logo.png'))).toBe(false); // image excluded
  });

  it('respects the endpoint limit', () => {
    const many: ReverseNetEntry[] = Array.from({ length: 100 }, (_, i) => ({ method: 'GET', url: `https://api.example.com/r${i}`, type: 'fetch', status: 200 }));
    expect(dedupeEndpoints(many, 10)).toHaveLength(10);
  });

  // 변조: malformed URLs and empty input never crash.
  it('tolerates malformed entries', () => {
    expect(dedupeEndpoints([{ method: 'GET', url: 'not a url', type: 'fetch' }])).toEqual([]);
    expect(dedupeEndpoints([])).toEqual([]);
    expect(dedupeEndpoints(undefined as unknown as ReverseNetEntry[])).toEqual([]);
  });
});

describe('formatReverseReport', () => {
  const snapshot: ReverseSnapshot = {
    url: 'https://shop.example.com',
    title: 'Example Shop',
    generator: 'Next.js',
    frameworks: ['React', 'Next.js'],
    colors: { body: { bg: 'rgb(255,255,255)', fg: 'rgb(0,0,0)' } },
    fonts: { body: 'Inter, sans-serif' },
    outline: ['header#top', '  h1: Welcome'],
    scripts: ['/_next/static/chunk.js'],
    counts: { links: 42, images: 10 },
  };

  it('renders a structured markdown spec', () => {
    const md = formatReverseReport(snapshot, dedupeEndpoints([
      { method: 'GET', url: 'https://shop.example.com/api/cart', type: 'fetch', status: 200 },
    ]));
    expect(md).toContain('# Reverse-engineering: Example Shop');
    expect(md).toContain('React, Next.js');
    expect(md).toContain('bg=rgb(255,255,255)');
    expect(md).toContain('font(body): Inter, sans-serif');
    expect(md).toContain('GET https://shop.example.com/api/cart');
    expect(md).toContain('links=42');
  });

  // None: empty snapshot and no endpoints produce graceful placeholders.
  it('handles an empty snapshot without endpoints', () => {
    const md = formatReverseReport({}, []);
    expect(md).toContain('(untitled)');
    expect(md).toContain('no framework fingerprints detected');
    expect(md).toContain('none captured yet');
  });
});
