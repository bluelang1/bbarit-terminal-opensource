// Structured data extraction from a page.
//
// A world-class AI browser can turn a page into DATA: pull the HTML tables and the
// repeated item lists (product cards, search results, rows) into clean records the
// agent can reason over, filter, or export. The in-page script collects the raw
// candidates; this module normalizes them — trims, dedupes headers, infers price/
// number fields, drops empty rows — as pure, tested logic.
//
// D1: Extract only STRUCTURE that is genuinely tabular/repeated (>= MIN_ROWS similar
//     items). Reason: forcing structure onto free-form content produces garbage;
//     better to return nothing than a fake table. Escape hatch: the agent can fall
//     back to browser_text for prose.

export interface RawTable { headers?: string[]; rows?: string[][] }
export interface RawList { items?: Array<Record<string, string>> }
export interface ExtractInput { tables?: RawTable[]; lists?: RawList[] }

export interface ExtractedTable { headers: string[]; rows: Array<Record<string, string>>; rowCount: number }
export interface ExtractResult { tables: ExtractedTable[]; lists: Array<Record<string, string>[]>; totalRecords: number }

export const MIN_ROWS = 2;

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// Make header names unique and non-empty (col1, col2… for blanks).
export function normalizeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    let name = clean(h) || `col${i + 1}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n > 1 ? `${name}_${n}` : name;
  });
}

// A cell that is purely a number/price → keep it, but flag numeric-looking values.
export function looksNumeric(value: string): boolean {
  const v = clean(value).replace(/[,$€£¥₩\s]/g, '');
  return v.length > 0 && /^-?\d+(\.\d+)?%?$/.test(v);
}

function normalizeTable(t: RawTable): ExtractedTable | null {
  const rawRows = (t.rows || []).map((r) => (r || []).map(clean));
  const width = Math.max(t.headers?.length || 0, ...rawRows.map((r) => r.length), 0);
  if (width === 0) return null;
  const headers = normalizeHeaders(
    (t.headers && t.headers.length ? t.headers : Array.from({ length: width }, (_, i) => `col${i + 1}`)).slice(0, width),
  );
  while (headers.length < width) headers.push(`col${headers.length + 1}`);
  const rows = rawRows
    .map((cells) => {
      const rec: Record<string, string> = {};
      headers.forEach((h, i) => { rec[h] = cells[i] ?? ''; });
      return rec;
    })
    .filter((rec) => Object.values(rec).some((v) => v.length > 0)); // drop fully-empty rows
  if (rows.length < MIN_ROWS) return null;
  return { headers, rows, rowCount: rows.length };
}

function normalizeList(l: RawList): Array<Record<string, string>> | null {
  const items = (l.items || [])
    .map((it) => {
      const rec: Record<string, string> = {};
      for (const [k, v] of Object.entries(it || {})) {
        const key = clean(k);
        const val = clean(v);
        if (key && val) rec[key] = val;
      }
      return rec;
    })
    .filter((rec) => Object.keys(rec).length > 0);
  return items.length >= MIN_ROWS ? items : null;
}

export function extractStructured(input: ExtractInput): ExtractResult {
  const tables = (input?.tables || []).map(normalizeTable).filter((t): t is ExtractedTable => !!t);
  const lists = (input?.lists || []).map(normalizeList).filter((l): l is Array<Record<string, string>> => !!l);
  const totalRecords = tables.reduce((sum, t) => sum + t.rowCount, 0) + lists.reduce((sum, l) => sum + l.length, 0);
  return { tables, lists, totalRecords };
}

// Render extracted tables as CSV (first table) — handy for the agent to hand back.
export function toCsv(table: ExtractedTable): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [table.headers.map(esc).join(',')];
  for (const row of table.rows) lines.push(table.headers.map((h) => esc(row[h] ?? '')).join(','));
  return lines.join('\n');
}

export function formatExtract(result: ExtractResult, opts: { limit?: number } = {}): string {
  const limit = Math.max(1, opts.limit ?? 20);
  if (!result.totalRecords) return '(no structured tables or repeated lists found on this page — use browser_text for prose)';
  const lines = [`# Extracted ${result.totalRecords} record(s): ${result.tables.length} table(s), ${result.lists.length} list(s)`];
  result.tables.forEach((t, i) => {
    lines.push('', `## Table ${i + 1} (${t.rowCount} rows) — ${t.headers.join(' | ')}`);
    for (const row of t.rows.slice(0, limit)) lines.push('- ' + t.headers.map((h) => `${h}: ${row[h]}`).join(' · '));
    if (t.rowCount > limit) lines.push(`  … +${t.rowCount - limit} more rows`);
  });
  result.lists.forEach((l, i) => {
    lines.push('', `## List ${i + 1} (${l.length} items)`);
    for (const it of l.slice(0, limit)) lines.push('- ' + Object.entries(it).map(([k, v]) => `${k}: ${v}`).join(' · '));
    if (l.length > limit) lines.push(`  … +${l.length - limit} more items`);
  });
  return lines.join('\n');
}
