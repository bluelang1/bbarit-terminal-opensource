import { describe, expect, it } from 'vitest';
import {
  buildScaffold,
  escapeHtml,
  sanitizeCssValue,
  slugForSnapshot,
} from './browserScaffold';
import type { ReverseSnapshot, ApiEndpoint } from './browserReverseEngineer';

const snapshot: ReverseSnapshot = {
  url: 'https://www.example.com/pricing',
  title: 'Example Pricing',
  frameworks: ['React', 'Next.js'],
  generator: 'Next.js',
  colors: { body: { bg: 'rgb(255,255,255)', fg: 'rgb(17,17,17)' }, button: { bg: '#2563eb', fg: '#fff' } },
  fonts: { body: 'Inter, sans-serif' },
  outline: ['header#top', '  h1: Simple pricing', '  h2: Plans', 'section.grid'],
};
const endpoints: ApiEndpoint[] = [
  { method: 'GET', path: '/api/plans', origin: 'https://api.example.com', count: 2, statuses: [200] },
];

describe('escapeHtml', () => {
  // 변조: HTML metacharacters and script payloads are neutralized.
  it('escapes HTML-significant characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`a & "b" 'c'`)).toBe('a &amp; &quot;b&quot; &#39;c&#39;');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('sanitizeCssValue', () => {
  // 정상: plain color/font values pass through.
  it('keeps safe values', () => {
    expect(sanitizeCssValue('rgb(255,0,0)')).toBe('rgb(255,0,0)');
    expect(sanitizeCssValue('Inter, sans-serif')).toBe('Inter, sans-serif');
  });

  // 변조: CSS breakout / injection payloads fall back.
  it('rejects injection attempts', () => {
    expect(sanitizeCssValue('red; } body { display:none')).toBe('inherit');
    expect(sanitizeCssValue('url(javascript:alert(1))')).toBe('inherit');
    expect(sanitizeCssValue('expression(alert(1))')).toBe('inherit');
    expect(sanitizeCssValue('', '#000')).toBe('#000');
  });
});

describe('slugForSnapshot', () => {
  // 정상 + 매핑: host → slug, www stripped.
  it('derives a filesystem-safe slug from the host', () => {
    expect(slugForSnapshot(snapshot)).toBe('example-com');
    expect(slugForSnapshot({ url: 'https://shop.My-Site.io/x' })).toBe('shop-my-site-io');
  });

  // None/변조: missing or malformed URL falls back.
  it('falls back for missing or bad URLs', () => {
    expect(slugForSnapshot({})).toBe('site');
    expect(slugForSnapshot({ url: 'not a url' })).toBe('site');
  });
});

describe('buildScaffold', () => {
  it('produces the five expected files under a clone dir', () => {
    const files = buildScaffold(snapshot, endpoints);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'clone-example-com/README.md',
      'clone-example-com/api.md',
      'clone-example-com/app.js',
      'clone-example-com/index.html',
      'clone-example-com/styles.css',
    ]);
  });

  it('embeds sanitized headings and design tokens', () => {
    const files = buildScaffold(snapshot, endpoints);
    const html = files.find((f) => f.path.endsWith('index.html'))!.content;
    const css = files.find((f) => f.path.endsWith('styles.css'))!.content;
    const api = files.find((f) => f.path.endsWith('api.md'))!.content;
    expect(html).toContain('<title>Example Pricing</title>');
    expect(html).toContain('<h1>Simple pricing</h1>');
    expect(html).toContain('<h2>Plans</h2>');
    expect(css).toContain('--bg: rgb(255,255,255)');
    expect(css).toContain('--font: Inter, sans-serif');
    expect(api).toContain('GET');
    expect(api).toContain('/api/plans');
  });

  // 변조: a hostile title cannot inject markup into the generated HTML.
  it('escapes a hostile page title', () => {
    const files = buildScaffold({ url: 'https://x.com', title: '</title><script>evil()</script>' }, []);
    const html = files.find((f) => f.path.endsWith('index.html'))!.content;
    expect(html).not.toContain('<script>evil()');
    expect(html).toContain('&lt;script&gt;evil()');
  });

  it('honors a custom base directory and empty endpoints', () => {
    const files = buildScaffold(snapshot, [], 'my-clone');
    expect(files.every((f) => f.path.startsWith('my-clone/'))).toBe(true);
    const api = files.find((f) => f.path.endsWith('api.md'))!.content;
    expect(api).toContain('None observed');
  });

  // None: an empty snapshot still yields a valid, openable scaffold.
  it('builds a usable scaffold from an empty snapshot', () => {
    const files = buildScaffold({}, []);
    expect(files).toHaveLength(5);
    const html = files.find((f) => f.path.endsWith('index.html'))!.content;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Cloned Site');
  });
});
