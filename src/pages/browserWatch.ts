// Page-change detection: diff two snapshots of the same page and report what changed.
//
// Pairs with browser_extract — snapshot a page's key text/values now, snapshot again
// later, and get a human-readable diff (price dropped, item appeared/vanished, text
// edited). This is the engine behind "watch this page / tell me what changed". Pure so
// the diff and the numeric-delta detection are deterministic and tested.
//
// D1: Diff by KEY, not by position. A snapshot is a flat {key: value} map (e.g.
//     {"price": "₩89,000", "title": "…"}); changes are added / removed / changed keys.
//     Reason: positional diffs are noisy when a list reorders; keyed diffs are stable.

export interface PageSnapshot {
  url?: string;
  values: Record<string, string>;   // labelled key → value
  takenAt?: number;                  // epoch ms (informational)
}

export interface FieldChange {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  numericDelta?: number;   // after - before when both parse as numbers
  percentDelta?: number;   // rounded % change
}

export interface WatchDiff {
  changed: boolean;
  changes: FieldChange[];
  summary: string;
}

// Parse a price/number-ish string to a number (strips currency, commas, %, spaces).
export function parseNumeric(value: string): number | null {
  const v = String(value ?? '').replace(/[,$€£¥₩%\s]/g, '').replace(/원|won/gi, '');
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

export function diffSnapshots(before: PageSnapshot | null, after: PageSnapshot | null): WatchDiff {
  const a = before?.values || {};
  const b = after?.values || {};
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  const changes: FieldChange[] = [];

  for (const key of keys) {
    const hadBefore = key in a;
    const hadAfter = key in b;
    const bv = normalize(a[key]);
    const av = normalize(b[key]);
    if (hadBefore && !hadAfter) { changes.push({ key, kind: 'removed', before: bv }); continue; }
    if (!hadBefore && hadAfter) { changes.push({ key, kind: 'added', after: av }); continue; }
    if (bv === av) continue;
    const change: FieldChange = { key, kind: 'changed', before: bv, after: av };
    const bn = parseNumeric(bv);
    const an = parseNumeric(av);
    if (bn !== null && an !== null) {
      change.numericDelta = Math.round((an - bn) * 100) / 100;
      change.percentDelta = bn !== 0 ? Math.round(((an - bn) / Math.abs(bn)) * 100) : 0;
    }
    changes.push(change);
  }

  // Most impactful first: numeric changes by absolute % delta, then adds/removes.
  changes.sort((x, y) => Math.abs(y.percentDelta ?? 0) - Math.abs(x.percentDelta ?? 0));
  return { changed: changes.length > 0, changes, summary: summarize(changes) };
}

function summarize(changes: FieldChange[]): string {
  if (!changes.length) return 'No changes since the last snapshot.';
  const parts = changes.slice(0, 4).map((c) => {
    if (c.kind === 'added') return `${c.key} appeared (${c.after})`;
    if (c.kind === 'removed') return `${c.key} gone`;
    if (c.numericDelta !== undefined) {
      const dir = c.numericDelta < 0 ? 'down' : 'up';
      return `${c.key} ${dir} ${c.before}→${c.after} (${c.percentDelta! > 0 ? '+' : ''}${c.percentDelta}%)`;
    }
    return `${c.key} "${c.before}"→"${c.after}"`;
  });
  return `${changes.length} change(s): ${parts.join('; ')}${changes.length > 4 ? '; …' : ''}.`;
}

export function formatWatchDiff(diff: WatchDiff): string {
  if (!diff.changed) return diff.summary;
  const lines = [`# Page changes — ${diff.changes.length}`, '', diff.summary, '', '| Field | Change | Before | After | Δ |', '| --- | --- | --- | --- | --- |'];
  for (const c of diff.changes) {
    const delta = c.numericDelta !== undefined ? `${c.numericDelta > 0 ? '+' : ''}${c.numericDelta} (${c.percentDelta! > 0 ? '+' : ''}${c.percentDelta}%)` : '';
    lines.push(`| ${c.key} | ${c.kind} | ${c.before ?? ''} | ${c.after ?? ''} | ${delta} |`);
  }
  return lines.join('\n');
}
