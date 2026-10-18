import { describe, expect, it } from 'vitest';
import { buildLinkMap, classifyLink, findLink, formatLinkMap, type RawLink } from './browserLinks';

const PAGE = 'https://shop.example.com/home';

describe('classifyLink', () => {
  // 매핑: each URL shape → the right kind.
  it('classifies internal / external / anchor / download / social / mail', () => {
    expect(classifyLink('/pricing', 'Pricing', PAGE)?.kind).toBe('internal');
    expect(classifyLink('https://other.com/x', 'Out', PAGE)?.kind).toBe('external');
    expect(classifyLink('#section', 'Jump', PAGE)?.kind).toBeUndefined; // pure '#' rejected
    expect(classifyLink('/home#reviews', 'Reviews', PAGE)?.kind).toBe('anchor');
    expect(classifyLink('/files/guide.pdf', 'Guide', PAGE)?.kind).toBe('download');
    expect(classifyLink('https://twitter.com/acme', 'Twitter', PAGE)?.kind).toBe('social');
    expect(classifyLink('mailto:hi@x.com', 'Email', PAGE)?.kind).toBe('mail');
  });

  it('resolves relative and protocol-relative URLs', () => {
    expect(classifyLink('about', 'About', PAGE)?.href).toBe('https://shop.example.com/about');
    expect(classifyLink('//cdn.example.com/a', 'CDN', PAGE)?.href).toBe('https://cdn.example.com/a');
  });

  // 변조/None: junk hrefs are rejected.
  it('rejects javascript: and empty hrefs', () => {
    expect(classifyLink('javascript:void(0)', 'x', PAGE)).toBeNull();
    expect(classifyLink('#', 'x', PAGE)).toBeNull();
    expect(classifyLink('', 'x', PAGE)).toBeNull();
  });
});

describe('buildLinkMap', () => {
  const raw: RawLink[] = [
    { href: '/pricing', text: 'Pricing' },
    { href: '/pricing', text: 'Pricing' },      // dup
    { href: 'https://github.com/acme', text: 'GitHub' },
    { href: '/docs/guide.pdf', text: 'Guide PDF' },
    { href: 'javascript:void(0)', text: 'noop' }, // dropped
  ];
  it('dedupes and counts by kind', () => {
    const map = buildLinkMap(raw, PAGE);
    expect(map.links).toHaveLength(3);           // dup + js dropped
    expect(map.counts.internal).toBe(1);
    expect(map.counts.social).toBe(1);
    expect(map.counts.download).toBe(1);
  });
  // None: empty input.
  it('handles empty input', () => {
    expect(buildLinkMap([], PAGE).links).toEqual([]);
    expect(buildLinkMap(undefined as unknown as RawLink[], PAGE).links).toEqual([]);
  });
});

describe('findLink', () => {
  const map = buildLinkMap([
    { href: '/pricing', text: 'Pricing & Plans' },
    { href: '/docs', text: 'Documentation' },
    { href: '/about', text: 'About us' },
  ], PAGE);
  it('finds the best link for a description', () => {
    expect(findLink(map, 'pricing')?.href).toBe('https://shop.example.com/pricing');
    expect(findLink(map, 'docs')?.href).toBe('https://shop.example.com/docs');
  });
  it('returns null when nothing matches', () => {
    expect(findLink(map, 'nonexistent zzz')).toBeNull();
    expect(findLink(map, '')).toBeNull();
  });
});

describe('formatLinkMap', () => {
  it('renders a summary with counts', () => {
    const md = formatLinkMap(buildLinkMap([{ href: '/a', text: 'A' }, { href: 'https://x.com/y', text: 'Y' }], PAGE));
    expect(md).toContain('# Links — 2 unique');
    expect(md).toContain('internal:1');
    expect(md).toContain('[internal] A →');
  });
});
