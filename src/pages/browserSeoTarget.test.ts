import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_URL, normalizeSeoTarget, normalizeUrl, requestName } from './browserSeoTarget';

describe('browser SEO target helpers', () => {
  it('keeps normal browser search behavior outside SEO target entry', () => {
    expect(normalizeUrl('')).toBe(DEFAULT_BROWSER_URL);
    expect(normalizeUrl('naver.com')).toBe('https://naver.com');
    expect(normalizeUrl('best seo keyword')).toBe('https://www.google.com/search?q=best%20seo%20keyword');
  });

  it('accepts crawlable domains and localhost targets without losing ports', () => {
    expect(normalizeSeoTarget('example.com/docs')).toEqual({ url: 'https://example.com/docs' });
    expect(normalizeSeoTarget('localhost:4321/demo')).toEqual({ url: 'http://localhost:4321/demo' });
    expect(normalizeSeoTarget('127.0.0.1:3000')).toEqual({ url: 'http://127.0.0.1:3000/' });
  });

  it('rejects SEO target search queries instead of turning them into Google URLs', () => {
    expect(normalizeSeoTarget('best seo keyword').error).toContain('not a search query');
    expect(normalizeSeoTarget('my-local-app').error).toContain('crawlable URL');
  });

  it('uses host plus port for local request names', () => {
    expect(requestName('http://localhost:4321/demo')).toBe('localhost:4321/demo');
    expect(requestName('https://example.com/')).toBe('example.com');
  });
});
