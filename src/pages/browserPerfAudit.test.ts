import { describe, expect, it } from 'vitest';
import { auditPerf, bandFor, formatPerfReport, shortRes, type PerfSignals } from './browserPerfAudit';

describe('bandFor', () => {
  // 정상 + 매핑: good/needs-improvement/poor bands.
  it('bands values against thresholds', () => {
    expect(bandFor(500, 800, 1800)).toBe('good');
    expect(bandFor(1200, 800, 1800)).toBe('needs-improvement');
    expect(bandFor(2000, 800, 1800)).toBe('poor');
  });
  // None/변조: zero/negative/NaN are treated as good (unmeasured, no false alarm).
  it('treats unmeasured values as good', () => {
    expect(bandFor(0, 800, 1800)).toBe('good');
    expect(bandFor(-5, 800, 1800)).toBe('good');
    expect(bandFor(NaN, 800, 1800)).toBe('good');
  });
});

describe('auditPerf', () => {
  const fast: PerfSignals = {
    ttfbMs: 200, fcpMs: 900, domContentLoadedMs: 1100, loadMs: 1500,
    resources: [{ url: 'https://a.test/app.js', type: 'script', sizeBytes: 120_000, durationMs: 80 }],
  };

  // 정상: a fast page scores high with no findings.
  it('scores a fast page as good', () => {
    const r = auditPerf(fast);
    expect(r.band).toBe('good');
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.findings).toEqual([]);
    expect(r.requestCount).toBe(1);
  });

  // 매핑: slow metrics produce the right findings and lower score.
  it('flags slow TTFB/FCP/load with severities', () => {
    const r = auditPerf({ ttfbMs: 2000, fcpMs: 3500, loadMs: 6000, resources: [] });
    const issues = r.findings.map((f) => f.issue).join(' ');
    expect(issues).toMatch(/TTFB/);
    expect(issues).toMatch(/First Contentful Paint/);
    expect(issues).toMatch(/full load/);
    expect(r.findings.some((f) => f.severity === 'critical')).toBe(true);
    expect(r.score).toBeLessThan(60);
    expect(r.band).toBe('poor');
  });

  // 매핑: heavy payload + many requests + a huge single resource.
  it('flags large payloads and heavy resources', () => {
    const resources = Array.from({ length: 110 }, (_, i) => ({ url: `https://a.test/r${i}.js`, type: 'script', sizeBytes: 30_000, durationMs: 20 }));
    resources.push({ url: 'https://a.test/huge.jpg', type: 'img', sizeBytes: 2_500_000, durationMs: 500 });
    const r = auditPerf({ ttfbMs: 100, fcpMs: 500, loadMs: 1000, resources });
    expect(r.requestCount).toBe(111);
    expect(r.findings.some((f) => /Large total payload/.test(f.issue))).toBe(true);
    expect(r.findings.some((f) => /network requests/.test(f.issue))).toBe(true);
    expect(r.findings.some((f) => /single resource/.test(f.issue))).toBe(true);
    expect(r.heaviest[0].url).toBe('https://a.test/huge.jpg');
    expect(r.slowest[0].url).toBe('https://a.test/huge.jpg');
  });

  // None/변조: empty and malformed signals never throw.
  it('tolerates empty and malformed signals', () => {
    expect(auditPerf({}).band).toBe('good');
    expect(auditPerf(undefined as unknown as PerfSignals).requestCount).toBe(0);
    const r = auditPerf({ resources: [{ sizeBytes: -1 as number }, {}] as never });
    expect(r.totalBytes).toBe(0);
    expect(r.requestCount).toBe(0); // entries with no size/duration are dropped
  });
});

describe('shortRes / formatPerfReport', () => {
  it('shortens a resource url', () => {
    expect(shortRes('https://cdn.example.com/assets/app.js')).toContain('example.com');
    expect(shortRes('garbage')).toBe('garbage');
  });
  it('renders a markdown report', () => {
    const md = formatPerfReport(auditPerf({ ttfbMs: 2000, fcpMs: 500, loadMs: 1000, resources: [{ url: 'https://a.test/x.js', sizeBytes: 50_000 }] }));
    expect(md).toContain('# Performance audit — score');
    expect(md).toContain('TTFB 2000ms');
    expect(md).toContain('## Issues');
  });
});
