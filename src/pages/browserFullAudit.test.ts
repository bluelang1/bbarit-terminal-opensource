import { describe, expect, it } from 'vitest';
import { combineAudits, formatFullAudit, letterGrade } from './browserFullAudit';
import type { A11yReport } from './browserA11yAudit';
import type { PerfReport } from './browserPerfAudit';

function a11y(score: number, findings: A11yReport['findings'] = []): A11yReport {
  return { score, findings, summary: `a11y ${score}` };
}
function perf(score: number, findings: PerfReport['findings'] = []): PerfReport {
  return { score, band: 'good', metrics: {}, findings, heaviest: [], slowest: [], totalBytes: 0, requestCount: 0, summary: `perf ${score}` };
}

describe('letterGrade', () => {
  it('maps scores to letters', () => {
    expect(letterGrade(95)).toBe('A');
    expect(letterGrade(85)).toBe('B');
    expect(letterGrade(75)).toBe('C');
    expect(letterGrade(65)).toBe('D');
    expect(letterGrade(40)).toBe('F');
    expect(letterGrade(-10)).toBe('F');
    expect(letterGrade(200)).toBe('A');
  });
});

describe('combineAudits', () => {
  // 정상: weighted average across three axes.
  it('averages the axis scores with equal weight', () => {
    const r = combineAudits({ a11y: a11y(90), perf: perf(60), seoScore: 90 });
    expect(r.overall).toBe(80); // (90+60+90)/3
    expect(r.grade).toBe('B');
    expect(r.axes.map((a) => a.axis)).toEqual(['accessibility', 'performance', 'seo']);
  });

  // 매핑: missing axes are dropped from the average (not counted as 0).
  it('drops missing axes fairly', () => {
    const r = combineAudits({ a11y: a11y(80), perf: null, seoScore: null });
    expect(r.overall).toBe(80); // only accessibility counted
    expect(r.axes).toHaveLength(1);
  });

  // 매핑: findings from all axes are merged and sorted worst-first.
  it('merges and ranks issues across axes', () => {
    const r = combineAudits({
      a11y: a11y(50, [{ id: 'img-alt', severity: 'critical', wcag: '1.1.1', message: 'missing alts', fix: 'add alt' }]),
      perf: perf(70, [{ severity: 'info', issue: 'many requests', fix: 'bundle' }, { severity: 'warning', issue: 'slow TTFB', fix: 'cache' }]),
    });
    expect(r.topIssues[0].severity).toBe('critical'); // a11y critical first
    expect(r.topIssues[0].axis).toBe('accessibility');
    // warning outranks info within perf
    const perfIssues = r.topIssues.filter((t) => t.axis === 'performance');
    expect(perfIssues[0].severity).toBe('warning');
  });

  // None/변조: no inputs → overall 0, no crash.
  it('handles empty and malformed input', () => {
    const r = combineAudits({});
    expect(r.overall).toBe(0);
    expect(r.axes).toEqual([]);
    expect(r.topIssues).toEqual([]);
    expect(combineAudits({ a11y: null, perf: null, seoScore: NaN }).overall).toBe(0);
  });

  it('caps the top-issues list at 8', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, severity: 'moderate' as const, wcag: '1.3.1', message: `issue ${i}`, fix: 'fix' }));
    const r = combineAudits({ a11y: a11y(30, findings) });
    expect(r.topIssues).toHaveLength(8);
  });
});

describe('formatFullAudit', () => {
  it('renders a combined health card', () => {
    const md = formatFullAudit(combineAudits({ a11y: a11y(90), perf: perf(60, [{ severity: 'warning', issue: 'slow', fix: 'cache' }]) }));
    expect(md).toContain('# Page health —');
    expect(md).toContain('## By axis');
    expect(md).toContain('accessibility: 90/100');
    expect(md).toContain('## Top issues');
    expect(md).toContain('[performance/warning]');
  });
});
