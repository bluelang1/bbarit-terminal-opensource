// Schema-driven structured extraction.
//
// Adapted from a capability that leading open-source AI browsers (browser-use,
// Firecrawl) highlight: "structured data extraction with schema validation". Instead
// of returning whatever keys a page happens to have (browserExtract), the user names
// the fields they want ("title, price, rating") and this maps each raw record onto
// that schema — matching keys fuzzily, coercing types (numbers/prices), and reporting
// which fields were found. Pure so the mapping/coercion is deterministic and tested.
//
// D1: A schema field matches a record key by name/alias (case+separator-insensitive),
//     then by substring. Reason: pages label the same concept many ways ("price",
//     "Price", "가격", "amount"); the user should not have to know the page's key.

export type FieldType = 'string' | 'number' | 'price';
export interface SchemaField { name: string; type?: FieldType; aliases?: string[]; required?: boolean }

export interface SchemaResult {
  records: Array<Record<string, string | number | null>>;
  coverage: Record<string, number>;   // field name → how many records had it
  missingRequired: string[];          // required fields not found in ANY record
}

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '');
}

// Parse a schema from either SchemaField[] or a simple ["title","price:number"] list.
export function parseSchema(input: unknown): SchemaField[] {
  if (Array.isArray(input)) {
    return input.map((f) => {
      if (f && typeof f === 'object') {
        const o = f as Record<string, unknown>;
        return { name: String(o.name || '').trim(), type: (o.type as FieldType) || 'string', aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [], required: !!o.required };
      }
      const s = String(f || '').trim();
      const [name, type] = s.split(':');
      return { name: name.trim(), type: (['string', 'number', 'price'].includes((type || '').trim()) ? (type.trim() as FieldType) : 'string'), aliases: [], required: false };
    }).filter((f) => f.name);
  }
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map((s) => ({ name: s.trim(), type: 'string' as FieldType, aliases: [], required: false })).filter((f) => f.name);
  }
  return [];
}

// Extract a numeric value from a price/number string ("₩1,299" -> 1299).
export function coerceNumber(value: unknown): number | null {
  const v = String(value ?? '').replace(/[,$€£¥₩%\s]/g, '').replace(/원|won/gi, '');
  const m = v.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Find the record key that best matches a schema field.
export function matchKey(field: SchemaField, keys: string[]): string | null {
  const wanted = [field.name, ...(field.aliases || [])].map(norm).filter(Boolean);
  // Exact (normalized) match first.
  for (const k of keys) if (wanted.includes(norm(k))) return k;
  // Substring either direction.
  for (const k of keys) {
    const nk = norm(k);
    if (wanted.some((w) => w && (nk.includes(w) || w.includes(nk)))) return k;
  }
  return null;
}

export function applySchema(schema: SchemaField[], rawRecords: Array<Record<string, string>>): SchemaResult {
  const fields = schema || [];
  const records: SchemaResult['records'] = [];
  const coverage: Record<string, number> = {};
  for (const f of fields) coverage[f.name] = 0;

  for (const raw of rawRecords || []) {
    const keys = Object.keys(raw || {});
    const rec: Record<string, string | number | null> = {};
    for (const f of fields) {
      const key = matchKey(f, keys);
      const rawVal = key ? raw[key] : undefined;
      if (rawVal === undefined || rawVal === '') { rec[f.name] = null; continue; }
      coverage[f.name] = (coverage[f.name] || 0) + 1;
      rec[f.name] = (f.type === 'number' || f.type === 'price') ? coerceNumber(rawVal) : String(rawVal);
    }
    // Keep a record only if at least one requested field was found.
    if (Object.values(rec).some((v) => v !== null)) records.push(rec);
  }

  const missingRequired = fields.filter((f) => f.required && (coverage[f.name] || 0) === 0).map((f) => f.name);
  return { records, coverage, missingRequired };
}

export function formatSchemaResult(schema: SchemaField[], result: SchemaResult, opts: { limit?: number } = {}): string {
  const limit = Math.max(1, opts.limit ?? 25);
  const fieldNames = schema.map((f) => f.name);
  const lines = [`# Schema extract — ${result.records.length} record(s), fields: ${fieldNames.join(', ')}`];
  const cov = fieldNames.map((n) => `${n}:${result.coverage[n] || 0}`).join(' · ');
  lines.push(`coverage → ${cov}`);
  if (result.missingRequired.length) lines.push(`⚠ required fields not found: ${result.missingRequired.join(', ')}`);
  for (const rec of result.records.slice(0, limit)) {
    lines.push('- ' + fieldNames.map((n) => `${n}: ${rec[n] ?? '—'}`).join(' · '));
  }
  if (result.records.length > limit) lines.push(`  … +${result.records.length - limit} more`);
  return lines.join('\n');
}
