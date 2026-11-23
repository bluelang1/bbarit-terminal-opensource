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

/**
 * Every usage type config.json may hold: the three above plus `server` (a board server over
 * HTTPS, src-tauri/src/agent_board/remote.rs; Settings → src/components/BoardServerSettings.tsx).
 */
export type BoardModeSetting = BoardMode | 'server';

/** `readBoardMode`, but `server` stays `server` (as in Rust `parse_mode`). */
export function readBoardModeSetting(board: unknown): BoardModeSetting {
  const b = (board && typeof board === 'object' ? board : {}) as Record<string, unknown>;
  const mode = typeof b.mode === 'string' ? b.mode.trim().toLowerCase() : '';
  return mode === 'server' ? 'server' : readBoardMode(board);
}

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

/**
 * Config paths agents may neither read nor change through `config.get` / `config.patch`.
 * `agents.enabled` / `agents.leadPhrase` are Settings → Agent team (src/terminal/agentTeamSwitch.ts).
 */
export const PROTECTED_CONFIG_PATHS = ['agents.enabled', 'agents.leadPhrase', 'agents.board.mode', 'agents.board.backend', 'agents.board.postgres', 'agents.board.server', 'agents.board.hostName', 'agents.board.adoptAfterHours'] as const;

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

/** `config.patch`'s refusal for a protected path (only Settings changes these). */
export function protectedConfigRefusal(path: string): string {
  const p = splitPath(path);
  return isPrefix(['agents', 'enabled'], p) || isPrefix(['agents', 'leadPhrase'], p)
    ? 'the agent team switch and the lead agent phrase can only be changed in Settings → Agent team'
    : 'the team board storage settings can only be changed in Settings → Agent team board';
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

// ── Sync status (usage type "Both (sync)", stage 3b) ─────────────────────

/** `agent_board_sync_status` (also the result of `agent_board_sync_now`, plus `ok`). */
export interface SyncStatus {
  mode: BoardMode;
  /** This machine's name as teams record it. */
  host: string;
  /** Where the name comes from: BBARIT_BOARD_HOST, the Settings field, or the system. */
  hostSource: 'env' | 'setting' | 'system';
  state: 'off' | 'starting' | 'on' | 'paused' | 'offline' | 'busy';
  /** Why sync stopped: name_taken, name_changed, no_tables, server_newer, server_older, local, settings, offline, busy. */
  lastErrorCode?: string | null;
  lastPushAt?: number | null;
  lastPullAt?: number | null;
  lastError?: string | null;
  lastErrorAt?: number | null;
  /** Local changes not on the server yet. */
  waiting: number;
  /** Rows from the server that failed the checks and were not written. */
  skipped: number;
  /** Rows of this computer the server refused (a clash, or it holds a newer version), with the first reason. */
  refused: number;
  refusedReason?: string | null;
  fullPush: boolean;
  /** Other machines whose teams this file holds (read-only), with how many. */
  machines: Array<{ host: string; teams: number; syncedAt?: number }>;
  /** Stage 3c: notes this computer sent to other computers' teams, not delivered yet / refused. */
  outboxWaiting: number;
  outboxRefused: number;
  /** Board table version on the server (last round) and the one this app knows. */
  serverSchema: number | null;
  codeSchema: number | null;
  /** Every registered computer and when it last synced (ms). */
  /** `ageMs` is by the server's clock when the last round ran (never this computer's clock). */
  hosts: Array<{ host: string; lastSeen: number; ageMs: number }>;
  /** Changes a takeover left unsent, kept in a file (count, path of the newest file). */
  keptRows: number;
  keptFile: string | null;
  /** The server at this address turned out to be another one (`server_replaced`) or restored
   * from a backup (`server_restored`): the pull started over and this computer's teams were sent again. */
  serverEvent: 'server_replaced' | 'server_restored' | null;
  serverEventAt: number | null;
  /** How long a team's home must be silent before "Take over this team" is offered (ms). */
  adoptAfterMs: number;
  ok?: boolean;
}

/** A status from the host, with wrong types dropped (the UI never trusts shapes). */
export function normalizeSyncStatus(raw: unknown): SyncStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const states = ['off', 'starting', 'on', 'paused', 'offline', 'busy'] as const;
  const state = states.find((s) => s === r.state) ?? 'off';
  const machines = Array.isArray(r.machines)
    ? r.machines
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as Record<string, unknown>).host === 'string')
        .map((m) => ({ host: String(m.host), teams: num(m.teams) ?? 0, syncedAt: num(m.syncedAt) ?? undefined }))
    : [];
  return {
    mode: readBoardMode({ mode: r.mode }),
    host: typeof r.host === 'string' ? r.host : '',
    hostSource: r.hostSource === 'env' || r.hostSource === 'setting' ? r.hostSource : 'system',
    state,
    lastPushAt: num(r.lastPushAt),
    lastPullAt: num(r.lastPullAt),
    lastError: typeof r.lastError === 'string' && r.lastError ? r.lastError : null,
    lastErrorCode: typeof r.lastErrorCode === 'string' && r.lastErrorCode ? r.lastErrorCode : null,
    lastErrorAt: num(r.lastErrorAt),
    waiting: num(r.waiting) ?? 0,
    skipped: num(r.skipped) ?? 0,
    refused: num(r.refused) ?? 0,
    refusedReason: typeof r.refusedReason === 'string' && r.refusedReason ? r.refusedReason : null,
    fullPush: r.fullPush === true,
    machines,
    outboxWaiting: num(r.outboxWaiting) ?? 0,
    outboxRefused: num(r.outboxRefused) ?? 0,
    serverSchema: num(r.serverSchema),
    codeSchema: num(r.codeSchema),
    hosts: Array.isArray(r.hosts)
      ? r.hosts
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object' && typeof (h as Record<string, unknown>).host === 'string')
          .map((h) => ({ host: String(h.host), lastSeen: num(h.lastSeen) ?? 0, ageMs: num(h.ageMs) ?? 0 }))
      : [],
    keptRows: num(r.keptRows) ?? 0,
    keptFile: typeof r.keptFile === 'string' && r.keptFile ? r.keptFile : null,
    serverEvent: r.serverEvent === 'server_replaced' || r.serverEvent === 'server_restored' ? r.serverEvent : null,
    serverEventAt: num(r.serverEventAt),
    adoptAfterMs: num(r.adoptAfterMs) ?? 24 * 3_600_000,
    ok: typeof r.ok === 'boolean' ? r.ok : undefined,
  };
}

/** Remote notes and takeovers need board tables version 4 on the server (3b sync works on 3). */
export function needsTableUpgrade(s: SyncStatus | null): boolean {
  return !!s && s.serverSchema !== null && s.codeSchema !== null && s.serverSchema < s.codeSchema;
}

/** May a person be offered "Take over this team" for a copy homed on `home`? Only when the home
 * has been silent for the threshold (the host checks again before it changes anything). */
export function canOfferTakeover(s: SyncStatus | null, home: string | undefined): boolean {
  if (!s || !home || s.mode !== 'sync' || needsTableUpgrade(s)) return false;
  const h = s.hosts.find((x) => x.host === home);
  if (!h) return false;
  // Ages come from the server's clock; computers' clocks are never compared.
  return h.ageMs >= s.adoptAfterMs;
}

/** `agent_board_restore_preview`. */
export interface RestorePreview {
  host: string;
  teams: number;
  tasks: number;
  notes: number;
  unsent: number;
  /** Another installation holds this computer's name. */
  takeover: { lastSeen: number; ageMs: number; minAgeMs: number; allowed: boolean } | null;
}

export function normalizeRestorePreview(raw: unknown): RestorePreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const t = r.takeover && typeof r.takeover === 'object' ? (r.takeover as Record<string, unknown>) : null;
  return {
    host: typeof r.host === 'string' ? r.host : '',
    teams: n(r.teams),
    tasks: n(r.tasks),
    notes: n(r.notes),
    unsent: n(r.unsent),
    takeover: t ? { lastSeen: n(t.lastSeen), ageMs: n(t.ageMs), minAgeMs: n(t.minAgeMs), allowed: t.allowed === true } : null,
  };
}

/** `agent_board_adopt_preview`. */
export interface AdoptPreview {
  team: string;
  teamName?: string;
  uid: string;
  home: string;
  version: number;
  lastSeen: number | null;
  ageMs: number | null;
  adoptAfterMs: number;
  allowed: boolean;
}

export function normalizeAdoptPreview(raw: unknown): AdoptPreview | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (typeof r.uid !== 'string' || typeof r.home !== 'string' || num(r.version) === null) return null;
  return {
    team: typeof r.team === 'string' ? r.team : '',
    teamName: typeof r.teamName === 'string' ? r.teamName : undefined,
    uid: r.uid,
    home: r.home,
    version: num(r.version) ?? 0,
    lastSeen: num(r.lastSeen),
    ageMs: num(r.ageMs),
    adoptAfterMs: num(r.adoptAfterMs) ?? 24 * 3_600_000,
    allowed: r.allowed === true,
  };
}

/** Whole hours (at least 0) for "last seen N hours ago". */
export function hoursAgo(ms: number | null | undefined): number {
  return ms && ms > 0 ? Math.floor(ms / 3_600_000) : 0;
}

/** Unicode format characters the Rust board strips (`model::is_format_char`). */
const FORMAT_CHARS = /[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/gu;

/**
 * Computer name as typed, cleaned like Rust `clean_label`: format characters dropped, control
 * characters and runs of whitespace become one space, trimmed; at most 120 characters (empty:
 * use the system name). A name with a line break is refused rather than joined.
 */
export function checkMachineName(raw: string): { ok: true; value: string } | { ok: false } {
  if (/[\r\n]/.test(raw.trim())) return { ok: false };
  // eslint-disable-next-line no-control-regex
  const v = raw.replace(FORMAT_CHARS, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  if ([...v].length > 120) return { ok: false };
  return { ok: true, value: v };
}

/** A host refusal from the Settings sync commands: `{ code, vars, message }` (JSON), else plain text. */
export function parseBoardRefusal(e: unknown): { code: string; vars: Record<string, string | number>; message: string } {
  const text = String(e instanceof Error ? e.message : e ?? '');
  try {
    const v = JSON.parse(text) as { code?: unknown; vars?: unknown; message?: unknown };
    if (v && typeof v.code === 'string') {
      const vars = v.vars && typeof v.vars === 'object' ? (v.vars as Record<string, string | number>) : {};
      return { code: v.code, vars, message: typeof v.message === 'string' ? v.message : text };
    }
  } catch { /* plain text */ }
  return { code: '', vars: {}, message: text };
}

/** Teams split for the team selector: this machine's, then other machines' (read-only). */
export function groupTeamsByHome<T extends { mirror?: boolean; homeHost?: string }>(teams: readonly T[]): { mine: T[]; others: T[] } {
  const mine: T[] = [];
  const others: T[] = [];
  for (const t of teams) (t.mirror ? others : mine).push(t);
  return { mine, others };
}

// ── Board server (usage type `server`, src-tauri/src/agent_board/server_login.rs) ──

/** Why a board server address is refused (the same rules as Rust `check_server_url`). */
export type ServerUrlError = 'empty' | 'invalid' | 'https' | 'userinfo' | 'path';

function loopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The board server's origin (`https://host[:port]`) from an address as typed: https, or http
 * only to this computer; no user name, password, path, query or fragment.
 */
export function checkServerUrl(raw: string): { ok: true; origin: string } | { ok: false; error: ServerUrlError } {
  const text = raw.trim();
  if (!text) return { ok: false, error: 'empty' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol === 'http:') {
    if (!loopbackHost(url.hostname)) return { ok: false, error: 'https' };
  } else if (url.protocol !== 'https:') {
    return { ok: false, error: 'invalid' };
  }
  if (!url.hostname) return { ok: false, error: 'invalid' };
  if (url.username || url.password) return { ok: false, error: 'userinfo' };
  const afterHost = text.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');
  if (!(url.pathname === '/' || url.pathname === '') || url.search || url.hash || /[?#]/.test(afterHost)) return { ok: false, error: 'path' };
  return { ok: true, origin: url.origin };
}

/** Whether the approval page may be opened in a browser: http(s) on exactly the server's origin. */
export function sameOriginLink(link: string, serverOrigin: string): boolean {
  try {
    const u = new URL(link);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === serverOrigin;
  } catch {
    return false;
  }
}

/** `board_server_status` (never the token; only its first characters). */
export interface BoardServerStatus {
  mode: string;
  /** The configured address (its origin when it is valid). */
  server: string;
  /** Why the configured address cannot be used (host text). */
  serverError: string | null;
  signedIn: boolean;
  /** The server this computer is signed in to. */
  signedInServer: string | null;
  /** False when the configured address is not the server this computer is signed in to. */
  serverMatches: boolean;
  nickname: string;
  computer: string;
  tokenPrefix: string | null;
  role: string | null;
  suspended: boolean;
  suspendedUntil: string | null;
  /** Tasks this computer holds on that server (lease book). */
  heldTasks: number;
  error: string | null;
  signInPending: boolean;
}

export function normalizeBoardServerStatus(raw: unknown): BoardServerStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const opt = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    mode: text(r.mode),
    server: text(r.server),
    serverError: opt(r.serverError),
    signedIn: r.signedIn === true,
    signedInServer: opt(r.signedInServer),
    serverMatches: r.serverMatches !== false,
    nickname: text(r.nickname),
    computer: text(r.computer),
    tokenPrefix: opt(r.tokenPrefix),
    role: opt(r.role),
    suspended: r.suspended === true,
    suspendedUntil: opt(r.suspendedUntil),
    heldTasks: typeof r.heldTasks === 'number' && Number.isFinite(r.heldTasks) ? r.heldTasks : 0,
    error: opt(r.error),
    signInPending: r.signInPending === true,
  };
}

/** `board_server_sign_in_start`: what to show while the browser approval is waited for. */
export interface ServerSignInStart {
  server: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
  opened: boolean;
}

export function normalizeSignInStart(raw: unknown): ServerSignInStart | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  if (typeof r.userCode !== 'string' || !r.userCode || typeof r.verificationUri !== 'string' || !r.verificationUri) return null;
  return {
    server: typeof r.server === 'string' ? r.server : '',
    userCode: r.userCode,
    verificationUri: r.verificationUri,
    verificationUriComplete: typeof r.verificationUriComplete === 'string' && r.verificationUriComplete ? r.verificationUriComplete : null,
    expiresIn: n(r.expiresIn, 600),
    interval: n(r.interval, 5),
    opened: r.opened === true,
  };
}

/** `board_server_sign_in_poll`. */
export type ServerSignInPoll =
  | { state: 'pending'; retryInMs: number }
  | { state: 'signed_in'; nickname: string; computer: string; server: string; replaced: { server: string; revoked: boolean } | null }
  | { state: 'denied' | 'expired' | 'error' | 'cancelled' | 'idle'; message: string };

/** Shortest and longest wait between two sign-in polls, whatever the host says. */
export const SIGN_IN_POLL_MIN_MS = 500;
export const SIGN_IN_POLL_MAX_MS = 60_000;

export function normalizeSignInPoll(raw: unknown): ServerSignInPoll {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (r.state) {
    case 'pending': {
      const ms = typeof r.retryInMs === 'number' && Number.isFinite(r.retryInMs) ? r.retryInMs : 5000;
      return { state: 'pending', retryInMs: Math.min(SIGN_IN_POLL_MAX_MS, Math.max(SIGN_IN_POLL_MIN_MS, ms)) };
    }
    case 'signed_in': {
      const rep = r.replaced && typeof r.replaced === 'object' ? (r.replaced as Record<string, unknown>) : null;
      return {
        state: 'signed_in',
        nickname: text(r.nickname),
        computer: text(r.computer),
        server: text(r.server),
        replaced: rep && typeof rep.server === 'string' ? { server: rep.server, revoked: rep.revoked === true } : null,
      };
    }
    case 'denied':
    case 'expired':
    case 'cancelled':
    case 'idle':
      return { state: r.state, message: text(r.message) };
    default:
      return { state: 'error', message: text(r.message) || 'unexpected answer' };
  }
}

/** `m:ss` for a countdown (never negative). */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
