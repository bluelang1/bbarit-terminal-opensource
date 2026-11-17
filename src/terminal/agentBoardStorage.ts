/**
 * Team board storage settings (config.json `agents.board`): the usage type and the PostgreSQL
 * connection fields shown in Settings → "Agent team board". The Rust host reads the same keys
 * (src-tauri/src/agent_board/config.rs); the password is never in config.json (write-only
 * command, 0600 file). Agents must not switch the board or read its connection settings, so
 * `config.get` / `config.patch` (bbarit-ctl `config get|set`) leave these keys out.
 * Design: docs/superpowers/specs/2026-11-16-agent-team-board-v2-design.md
 */

export type BoardMode = 'sqlite' | 'sync' | 'postgres';

export const BOARD_MODES: readonly BoardMode[] = ['sqlite', 'sync', 'postgres'];

export const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface BoardPgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  schema: string;
}

export const DEFAULT_BOARD_PG: BoardPgSettings = {
  host: '',
  port: 5432,
  database: '',
  user: '',
  sslMode: 'prefer',
  schema: 'bbarit_board',
};

/**
 * The usage type: `mode` when set, else the older `backend` key (`sqlite` | `postgres`) read
 * as the same-named mode, else SQLite. Unknown values are SQLite (never a silent switch to a
 * server), as in Rust `parse_mode`.
 */
export function readBoardMode(board: unknown): BoardMode {
  const b = (board && typeof board === 'object' ? board : {}) as Record<string, unknown>;
  const read = (key: string) => (typeof b[key] === 'string' ? (b[key] as string).trim().toLowerCase() : '');
  const mode = read('mode');
  if (mode) {
    if (mode === 'postgresql') return 'postgres';
    return (BOARD_MODES as readonly string[]).includes(mode) ? (mode as BoardMode) : 'sqlite';
  }
  const backend = read('backend');
  if (backend === 'postgres' || backend === 'postgresql') return 'postgres';
  return 'sqlite';
}

/** PostgreSQL schema names the board accepts (Rust `valid_schema_name`). */
export function isValidSchemaName(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name) && !name.startsWith('pg_') && name !== 'information_schema';
}

/** `agents.board.postgres` → fields with defaults (wrong types fall back, text trimmed). */
export function normalizeBoardPg(raw: unknown): BoardPgSettings {
  const v = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const text = (key: keyof BoardPgSettings) => (typeof v[key] === 'string' ? (v[key] as string).trim() : '');
  const portRaw = typeof v.port === 'number' ? v.port : typeof v.port === 'string' ? Number(v.port.trim()) : NaN;
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : DEFAULT_BOARD_PG.port;
  const ssl = text('sslMode').toLowerCase();
  return {
    host: text('host'),
    port,
    database: text('database'),
    user: text('user'),
    sslMode: (SSL_MODES as readonly string[]).includes(ssl) ? (ssl as SslMode) : DEFAULT_BOARD_PG.sslMode,
    schema: text('schema') || DEFAULT_BOARD_PG.schema,
  };
}

/** Which connection fields are still missing (empty when a test can be tried). */
export function missingPgFields(pg: BoardPgSettings): Array<'host' | 'database' | 'user'> {
  const out: Array<'host' | 'database' | 'user'> = [];
  if (!pg.host) out.push('host');
  if (!pg.database) out.push('database');
  if (!pg.user) out.push('user');
  return out;
}

// ── Keeping agents away from the storage settings ───────────────────────

/** Config paths agents may neither read nor change through `config.get` / `config.patch`. */
export const PROTECTED_CONFIG_PATHS = ['agents.board.mode', 'agents.board.backend', 'agents.board.postgres'] as const;

function splitPath(path: string): string[] {
  return path.split('.').map((k) => k.trim()).filter((k) => k.length > 0);
}

function isPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((k, i) => k === b[i]);
}

/** Is `path` a protected key or inside one (`config.patch` refuses it)? */
export function isProtectedConfigPath(path: string): boolean {
  const p = splitPath(path);
  return PROTECTED_CONFIG_PATHS.some((prot) => isPrefix(prot.split('.'), p));
}

/**
 * After a `config.patch` of a parent path (`agents`, `agents.board`, the root): put the
 * protected values back as they were before, so a patch of a parent never changes them.
 */
export function keepProtectedConfig<T>(prev: T, next: T): T {
  let out: unknown = next;
  for (const prot of PROTECTED_CONFIG_PATHS) {
    const keys = prot.split('.');
    out = setAt(out, keys, getAt(prev, keys));
  }
  return out as T;
}

function getAt(value: unknown, keys: string[]): unknown {
  let cur = value;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setAt(value: unknown, keys: string[], v: unknown): unknown {
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const [head, ...rest] = keys;
  const copy: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    if (v === undefined) delete copy[head];
    else copy[head] = v;
  } else {
    const child = setAt(obj[head], rest, v);
    if (child && typeof child === 'object' && Object.keys(child).length === 0 && obj[head] === undefined) delete copy[head];
    else copy[head] = child;
  }
  return copy;
}

/**
 * The value `config.get <path>` may show: protected keys under it are removed (copies only;
 * the input is not changed); a path inside a protected key reads as undefined.
 */
export function redactProtectedConfig(value: unknown, path: string): unknown {
  const p = splitPath(path);
  let out = value;
  for (const prot of PROTECTED_CONFIG_PATHS) {
    const q = prot.split('.');
    if (isPrefix(q, p)) return undefined;
    if (!isPrefix(p, q)) continue;
    const rest = q.slice(p.length);
    out = removeAt(out, rest);
  }
  return out;
}

function removeAt(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.length === 0) return value;
  const obj = value as Record<string, unknown>;
  const [head, ...rest] = keys;
  if (!(head in obj)) return value;
  const copy: Record<string, unknown> = { ...obj };
  if (rest.length === 0) delete copy[head];
  else copy[head] = removeAt(obj[head], rest);
  return copy;
}

// ── Settings results (shapes returned by the agent_board_* Settings commands) ──

/** `agent_board_pg_test`. */
export interface PgTestResult {
  reachable: boolean;
  target?: string;
  schema?: string;
  serverVersion?: string;
  tls?: boolean;
  user?: string;
  database?: string;
  schemaExists?: boolean;
  schemaVersion?: number | null;
  codeVersion?: number;
  canCreate?: boolean;
  canReadWrite?: boolean | null;
  envOverride?: boolean;
  passwordSaved?: boolean;
  /** Plain text to a server on another machine. */
  tlsWarning?: boolean;
  /** Board table names already in a schema the board did not set up. */
  foreignTables?: string[];
  error?: string;
}

export type NextStep = 'checkConnection' | 'updateApp' | 'emptySchema' | 'createTables' | 'askOwner' | 'upgradeTables' | 'askPrivileges' | 'ready';

/** What to do after a connection test (the same order as the host's `next` text). */
export function nextStep(r: PgTestResult): NextStep {
  if (!r.reachable || r.error) return 'checkConnection';
  const code = r.codeVersion ?? 0;
  const v = r.schemaVersion;
  if (typeof v === 'number' && v > code) return 'updateApp';
  if (v === null || v === undefined) {
    if (r.foreignTables && r.foreignTables.length > 0) return 'emptySchema';
    return r.canCreate ? 'createTables' : 'askOwner';
  }
  if (v < code) return 'upgradeTables';
  if (r.canReadWrite === false) return 'askPrivileges';
  return 'ready';
}

// ── Connection fields as typed (a draft until Apply) ────────────────────

/** The PostgreSQL fields as the person types them; nothing is saved until Apply. */
export interface PgDraft {
  host: string;
  port: string;
  database: string;
  user: string;
  sslMode: SslMode;
  schema: string;
}

export function draftFromPg(pg: BoardPgSettings): PgDraft {
  return { ...pg, port: String(pg.port) };
}

export type DraftError = 'port' | 'schema';

/** A draft → settings, or what is wrong with it (empty host/database/user are allowed here; see missingPgFields). */
export function parsePgDraft(d: PgDraft): { ok: true; value: BoardPgSettings } | { ok: false; errors: DraftError[] } {
  const errors: DraftError[] = [];
  const portText = d.port.trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port');
  const schema = d.schema.trim();
  if (!isValidSchemaName(schema)) errors.push('schema');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { host: d.host.trim(), port, database: d.database.trim(), user: d.user.trim(), sslMode: d.sslMode, schema } };
}

export function sameDraft(a: PgDraft, b: PgDraft): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database && a.user === b.user && a.sslMode === b.sslMode && a.schema === b.schema;
}

/** `user@host:port/database`, as the host labels a saved password. */
export function pgLabel(pg: BoardPgSettings): string {
  return `${pg.user}@${pg.host}:${pg.port}/${pg.database}`;
}

/** Which way "Copy data" goes for a usage type: into the store that type uses. */
export function copySource(mode: BoardMode): 'sqlite' | 'postgres' {
  return mode === 'postgres' ? 'sqlite' : 'postgres';
}

/** `{name}` placeholders in a translated string. */
export function fillText(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
