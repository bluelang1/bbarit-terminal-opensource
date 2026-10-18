import { describe, expect, it } from 'vitest';
import {
  MAX_BATCH,
  buildBatchPlan,
  formatBatchReport,
  shortUrl,
  type BatchResult,
} from './browserBatchWorkflow';

describe('buildBatchPlan', () => {
  // 정상: valid URLs are normalized and indexed.
  it('normalizes and indexes valid URLs', () => {
    const plan = buildBatchPlan(['example.com', 'https://a.test/x', 'http://b.test']);
    expect(plan.targets.map((t) => t.url)).toEqual(['https://example.com/', 'https://a.test/x', 'http://b.test/']);
    expect(plan.targets.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(plan.skipped).toEqual([]);
    expect(plan.truncated).toBe(0);
  });

  // 매핑: dedupe by normalized URL, ignoring hash.
  it('dedupes by normalized URL ignoring hash', () => {
    const plan = buildBatchPlan(['https://a.test/p', 'https://a.test/p#top', 'a.test/p']);
    expect(plan.targets).toHaveLength(1);
  });

  // 매핑: non-URL queries land in skipped, not targets.
  it('skips search-like and malformed entries', () => {
    const plan = buildBatchPlan(['best pizza recipe', 'https://ok.test', '   ']);
    expect(plan.targets.map((t) => t.url)).toEqual(['https://ok.test/']);
    expect(plan.skipped).toEqual(['best pizza recipe']);
  });

  it('caps at MAX_BATCH and reports the truncated count', () => {
    const urls = Array.from({ length: MAX_BATCH + 5 }, (_, i) => `https://site${i}.test`);
    const plan = buildBatchPlan(urls);
    expect(plan.targets).toHaveLength(MAX_BATCH);
    expect(plan.truncated).toBe(5);
  });

  it('honors a custom max', () => {
    expect(buildBatchPlan(['https://a.test', 'https://b.test', 'https://c.test'], 2).targets).toHaveLength(2);
  });

  // None/변조: non-array and empty inputs yield an empty plan, no throw.
  it('tolerates non-array and empty inputs', () => {
    expect(buildBatchPlan(undefined)).toEqual({ targets: [], skipped: [], truncated: 0 });
    expect(buildBatchPlan('https://a.test' as unknown)).toEqual({ targets: [], skipped: [], truncated: 0 });
    // null/'' are ignored; 42 is not URL-like → skipped, never a target.
    const plan = buildBatchPlan([null, '', 42]);
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual(['42']);
  });
});

describe('shortUrl', () => {
  it('shortens to host + path', () => {
    expect(shortUrl('https://www.example.com/pricing?x=1')).toBe('www.example.com/pricing');
    expect(shortUrl('https://a.test/')).toBe('a.test');
    expect(shortUrl('garbage')).toBe('garbage');
  });
});

describe('formatBatchReport', () => {
  const results: BatchResult[] = [
    { url: 'https://a.test/1', ok: true, summary: 'Fast page', metrics: { score: 92, h1: 1 } },
    { url: 'https://b.test/2', ok: true, summary: 'Missing meta', metrics: { score: 70, h1: 0 } },
    { url: 'https://c.test/3', ok: false, error: 'navigation timeout' },
  ];

  // 정상: a comparison table + notes + failures.
  it('builds a comparison report', () => {
    const md = formatBatchReport(results, { title: 'Competitor audit' });
    expect(md).toContain('Competitor audit — 3 page(s), 2 ok, 1 failed');
    expect(md).toContain('| # | URL | score | h1 |');
    expect(md).toContain('a.test/1');
    expect(md).toContain('Fast page');
    expect(md).toContain('## Failed');
    expect(md).toContain('navigation timeout');
  });

  // None: empty results and metric-less pages degrade gracefully.
  it('handles empty and metric-less results', () => {
    expect(formatBatchReport([])).toContain('0 page(s), 0 ok, 0 failed');
    const md = formatBatchReport([{ url: 'https://x.test', ok: true }]);
    expect(md).toContain('1 page(s), 1 ok, 0 failed');
    expect(md).not.toContain('| # | URL |'); // no metric table when no metrics
  });

  // 변조: malformed rows do not throw.
  it('tolerates malformed rows', () => {
    const md = formatBatchReport([null as unknown as BatchResult, { url: 'https://y.test', ok: true, metrics: { a: 1 } }]);
    expect(md).toContain('ok');
  });
});
