// Multi-page batch workflow for the browser agent.
//
// "Compare these 5 competitor pages", "audit every URL in the sitemap" — the agent
// needs to run the SAME analysis across many pages and aggregate the results, not
// drive them one ad-hoc navigation at a time (which the loop guard rightly blocks).
//
// The embedded browser is a single Chrome target, so pages are visited SEQUENTIALLY
// (navigate -> analyze -> record -> next). This module owns the pure parts: building
// a validated, de-duplicated, bounded plan from a raw URL list, and folding the
// per-page results into a comparison report. The tool layer only does navigate+eval.
//
// D1: A hard cap (MAX_BATCH) on pages per run.
//     Reason: an unbounded list would hammer sites and blow the step budget; this is
//     the same passive-safety stance as the nav loop guard. Cost: huge lists are
//     truncated (reported, never silent). Escape hatch: the agent re-runs for the rest.

import { normalizeUrl } from './browserSeoTarget';

export const MAX_BATCH = 12;

export interface BatchTarget { url: string; index: number }
export interface BatchPlan { targets: BatchTarget[]; skipped: string[]; truncated: number }

// A raw entry only counts as a page if it looks like a URL/domain to begin with —
// otherwise normalizeUrl would turn a search phrase ("best pizza") into a Google
// search URL and silently add it as a target. Reject those up front.
function isUrlLikeRaw(s: string): boolean {
  if (/^https?:\/\//i.test(s)) return true;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(s)) return true;
  return s.includes('.') && !/\s/.test(s);
}

// Build a clean plan from a raw list: normalize, keep only http(s), de-dupe by
// normalized URL, cap at MAX_BATCH. Non-URL junk is reported in `skipped`.
export function buildBatchPlan(rawUrls: unknown, max = MAX_BATCH): BatchPlan {
  const list = Array.isArray(rawUrls) ? rawUrls : [];
  const seen = new Set<string>();
  const targets: BatchTarget[] = [];
  const skipped: string[] = [];
  let truncated = 0;
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (!isUrlLikeRaw(s)) { skipped.push(s); continue; }   // search phrase / junk → not a page
    const url = normalizeUrl(s);
    if (!/^https?:\/\//i.test(url)) { skipped.push(s); continue; }   // safety net
    let key: string;
    try { const u = new URL(url); u.hash = ''; key = u.href; } catch { skipped.push(s); continue; }
    if (seen.has(key)) continue;
    if (targets.length >= max) { truncated++; continue; }
    seen.add(key);
    targets.push({ url: key, index: targets.length });
  }
  return { targets, skipped, truncated };
}

export interface BatchResult {
  url: string;
  ok: boolean;
  summary?: string;
  metrics?: Record<string, number | string>;
  error?: string;
}

// Fold per-page results into a compact markdown comparison the agent can present.
export function formatBatchReport(results: BatchResult[], opts: { title?: string } = {}): string {
  const rows = Array.isArray(results) ? results : [];
  const ok = rows.filter((r) => r?.ok);
  const failed = rows.filter((r) => r && !r.ok);
  const lines: string[] = [];
  lines.push(`# ${opts.title || 'Batch workflow'} — ${rows.length} page(s), ${ok.length} ok, ${failed.length} failed`);

  // Union of metric keys across successful pages → a comparison table.
  const metricKeys = Array.from(new Set(ok.flatMap((r) => Object.keys(r.metrics || {})))).slice(0, 8);
  if (ok.length && metricKeys.length) {
    lines.push('', `| # | URL | ${metricKeys.join(' | ')} |`, `| --- | --- | ${metricKeys.map(() => '---').join(' | ')} |`);
    ok.forEach((r, i) => {
      const cells = metricKeys.map((k) => String(r.metrics?.[k] ?? '-'));
      lines.push(`| ${i + 1} | ${shortUrl(r.url)} | ${cells.join(' | ')} |`);
    });
  }

  const withSummary = ok.filter((r) => r.summary);
  if (withSummary.length) {
    lines.push('', '## Per-page notes');
    for (const r of withSummary) lines.push(`- **${shortUrl(r.url)}**: ${String(r.summary).replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  if (failed.length) {
    lines.push('', '## Failed');
    for (const r of failed) lines.push(`- ${shortUrl(r.url)}: ${String(r.error || 'unknown error').slice(0, 160)}`);
  }
  return lines.join('\n');
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`.slice(0, 60);
  } catch {
    return String(url || '').slice(0, 60);
  }
}
