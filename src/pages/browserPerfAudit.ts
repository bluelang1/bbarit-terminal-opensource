// Page performance auditor.
//
// The AI browser can audit SEO and accessibility; performance is the third axis.
// This takes performance SIGNALS collected in-page (Navigation Timing + Resource
// Timing + paint metrics) and produces a scored report with the load milestones,
// the heaviest/slowest resources, and concrete recommendations. Collection is a thin
// in-page script; the scoring/thresholds live here as pure, tested functions.
//
// D1: Thresholds follow the well-known Core-Web-Vitals-style "good/needs-improvement/
//     poor" bands where they map cleanly (FCP, TTFB, load). Reason: familiar, defensible
//     numbers rather than invented ones. Cost: DOMContentLoaded/load are lab timings,
//     not field CWV. Escape hatch: the raw numbers are always returned.

export interface ResourceEntry {
  url?: string;
  type?: string;       // script | css | img | fetch | font | ...
  sizeBytes?: number;  // transferSize or encodedBodySize
  durationMs?: number;
}

export interface PerfSignals {
  ttfbMs?: number;      // responseStart - requestStart
  fcpMs?: number;       // first-contentful-paint
  domContentLoadedMs?: number;
  loadMs?: number;      // load event end
  resources?: ResourceEntry[];
}

export type PerfBand = 'good' | 'needs-improvement' | 'poor';

export interface PerfFinding { severity: 'critical' | 'warning' | 'info'; issue: string; fix: string }

export interface PerfReport {
  score: number;         // 0-100
  band: PerfBand;
  metrics: Record<string, number>;
  findings: PerfFinding[];
  heaviest: ResourceEntry[];
  slowest: ResourceEntry[];
  totalBytes: number;
  requestCount: number;
  summary: string;
}

// Band a metric against good/poor thresholds (ms).
export function bandFor(valueMs: number, goodMax: number, poorMin: number): PerfBand {
  if (!Number.isFinite(valueMs) || valueMs <= 0) return 'good';
  if (valueMs <= goodMax) return 'good';
  if (valueMs >= poorMin) return 'poor';
  return 'needs-improvement';
}

const BAND_PENALTY: Record<PerfBand, number> = { good: 0, 'needs-improvement': 10, poor: 22 };

export function auditPerf(signals: PerfSignals): PerfReport {
  const s = signals || {};
  const resources = (s.resources || []).filter((r) => r && (Number(r.sizeBytes) > 0 || Number(r.durationMs) > 0));
  const totalBytes = resources.reduce((sum, r) => sum + (Number(r.sizeBytes) || 0), 0);
  const requestCount = resources.length;

  const findings: PerfFinding[] = [];
  const ttfbBand = bandFor(s.ttfbMs ?? 0, 800, 1800);
  const fcpBand = bandFor(s.fcpMs ?? 0, 1800, 3000);
  const loadBand = bandFor(s.loadMs ?? 0, 2500, 5000);

  if (ttfbBand !== 'good') findings.push({ severity: ttfbBand === 'poor' ? 'critical' : 'warning', issue: `Slow server response (TTFB ${Math.round(s.ttfbMs || 0)}ms)`, fix: 'Improve server/CDN response time; cache HTML, use edge/SSR caching.' });
  if (fcpBand !== 'good') findings.push({ severity: fcpBand === 'poor' ? 'critical' : 'warning', issue: `Slow First Contentful Paint (${Math.round(s.fcpMs || 0)}ms)`, fix: 'Reduce render-blocking CSS/JS, inline critical CSS, defer non-critical scripts.' });
  if (loadBand !== 'good') findings.push({ severity: loadBand === 'poor' ? 'critical' : 'warning', issue: `Slow full load (${Math.round(s.loadMs || 0)}ms)`, fix: 'Lazy-load below-the-fold assets and split large bundles.' });

  // Heavy total payload / too many requests.
  if (totalBytes > 3_000_000) findings.push({ severity: 'warning', issue: `Large total payload (${(totalBytes / 1e6).toFixed(1)}MB)`, fix: 'Compress images (WebP/AVIF), tree-shake JS, enable gzip/brotli.' });
  if (requestCount > 100) findings.push({ severity: 'info', issue: `${requestCount} network requests`, fix: 'Bundle/merge assets and remove unused third-party scripts.' });

  // Big individual resources.
  const heaviest = resources.slice().sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0)).slice(0, 5);
  const slowest = resources.slice().sort((a, b) => (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0)).slice(0, 5);
  if (heaviest[0] && (Number(heaviest[0].sizeBytes) || 0) > 1_000_000) {
    findings.push({ severity: 'warning', issue: `A single resource is ${((heaviest[0].sizeBytes || 0) / 1e6).toFixed(1)}MB`, fix: `Optimize/split the largest asset (${shortRes(heaviest[0].url)}).` });
  }

  const penalty = BAND_PENALTY[ttfbBand] + BAND_PENALTY[fcpBand] + BAND_PENALTY[loadBand]
    + (totalBytes > 3_000_000 ? 8 : 0) + (requestCount > 100 ? 5 : 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const band: PerfBand = score >= 90 ? 'good' : score >= 60 ? 'needs-improvement' : 'poor';

  return {
    score, band,
    metrics: {
      ttfbMs: Math.round(s.ttfbMs || 0), fcpMs: Math.round(s.fcpMs || 0),
      domContentLoadedMs: Math.round(s.domContentLoadedMs || 0), loadMs: Math.round(s.loadMs || 0),
    },
    findings, heaviest, slowest, totalBytes, requestCount,
    summary: findings.length
      ? `Perf ${score}/100 (${band}) — ${requestCount} requests, ${(totalBytes / 1e6).toFixed(1)}MB; top: ${findings[0].issue}.`
      : `Perf ${score}/100 (${band}) — ${requestCount} requests, ${(totalBytes / 1e6).toFixed(1)}MB; no major issues.`,
  };
}

export function shortRes(url?: string): string {
  try { const u = new URL(String(url)); return `${u.host}${u.pathname}`.slice(-50); } catch { return String(url || '').slice(-50); }
}

export function formatPerfReport(r: PerfReport): string {
  const lines = [`# Performance audit — score ${r.score}/100 (${r.band})`, '', r.summary, '',
    `TTFB ${r.metrics.ttfbMs}ms · FCP ${r.metrics.fcpMs}ms · DCL ${r.metrics.domContentLoadedMs}ms · Load ${r.metrics.loadMs}ms`,
    `${r.requestCount} requests · ${(r.totalBytes / 1e6).toFixed(2)}MB total`];
  if (r.findings.length) { lines.push('', '## Issues', '| Severity | Issue | Fix |', '| --- | --- | --- |'); for (const f of r.findings) lines.push(`| ${f.severity} | ${f.issue} | ${f.fix} |`); }
  if (r.heaviest.length) { lines.push('', '## Heaviest resources'); for (const h of r.heaviest) lines.push(`- ${((h.sizeBytes || 0) / 1e3).toFixed(0)}KB ${h.type || ''} ${shortRes(h.url)}`); }
  return lines.join('\n');
}
