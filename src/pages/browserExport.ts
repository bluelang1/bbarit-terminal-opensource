// Export extracted page data to CSV or JSON.
//
// browser_extract turns a page into records; this serializes those records for saving
// (CSV for spreadsheets, JSON for code). Completes the extract → export pipeline.
// Pure so the serialization (escaping, header union, format choice) is tested.
//
// D1: For CSV, the column set is the UNION of every record's keys, in first-seen order.
//     Reason: records from different list items can have different fields; a fixed union
//     keeps rows aligned and loses no data. Cost: sparse cells are empty. Escape hatch:
//     JSON export preserves the exact per-record shape.

import type { ExtractResult } from './browserExtract';

export type ExportFormat = 'csv' | 'json';

export interface ExportOutput { format: ExportFormat; ext: string; content: string; recordCount: number }

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Collect all records from an ExtractResult into a single flat list (tables + lists).
export function collectRecords(result: ExtractResult): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const t of result?.tables || []) for (const row of t.rows) out.push(row);
  for (const l of result?.lists || []) for (const item of l) out.push(item);
  return out;
}

// Union of keys across records, in first-seen order.
export function unionKeys(records: Array<Record<string, string>>): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const k of Object.keys(rec || {})) {
      if (!seen.has(k)) { seen.add(k); keys.push(k); }
    }
  }
  return keys;
}

export function recordsToCsv(records: Array<Record<string, string>>): string {
  const keys = unionKeys(records);
  if (!keys.length) return '';
  const lines = [keys.map(csvEscape).join(',')];
  for (const rec of records) lines.push(keys.map((k) => csvEscape(rec[k])).join(','));
  return lines.join('\n');
}

export function exportExtract(result: ExtractResult, format: ExportFormat = 'csv'): ExportOutput {
  const records = collectRecords(result);
  if (format === 'json') {
    return { format, ext: 'json', content: JSON.stringify(records, null, 2), recordCount: records.length };
  }
  return { format: 'csv', ext: 'csv', content: recordsToCsv(records), recordCount: records.length };
}

// Sanitize a user/host-derived string into a safe filename stem.
export function safeFileStem(input: string, fallback = 'export'): string {
  const stem = String(input || '')
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return stem || fallback;
}
