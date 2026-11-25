// The runner for a board server (Settings → Agent team board → Board server → Runner): what the
// host commands `board_runner_*` (src-tauri/src/agent_board/runner.rs) answer, read defensively.
// Everything here came from a program the person installed: it is shown as plain text only,
// with lengths capped again on this side.

/** `agents.board.server.<RUNNER_PATH_KEY>` in config.json (Rust `runner::PATH_KEY`). */
export const RUNNER_PATH_KEY = 'runnerPath';
/** Shortest wait between two status reads while the block is visible. */
export const RUNNER_POLL_BASE_MS = 5000;

export type RunnerWorkerState = 'idle' | 'claiming' | 'preparing' | 'working' | 'submitting' | 'stopping';

export interface RunnerWorker {
  id: string;
  /** One of `RunnerWorkerState`, or the program's own word for a state this app does not know. */
  state: string;
  task: string | null;
  since: string | number | null;
  product: string;
}

export interface RunnerLimited {
  product: string;
  until: string | number | null;
  untilUnix: number | null;
}

export interface RunnerPool {
  min: number | null;
  max: number | null;
  idle: number | null;
  busy: number | null;
  suggestedMax: number | null;
  suggestion: string;
  limited: RunnerLimited[];
}

export type RunnerStatus =
  | { running: false; server: string }
  | {
      running: true;
      pid: number | null;
      server: string;
      runner: string;
      account: string;
      startedAt: string | number | null;
      mode: string;
      teams: string[];
      pool: RunnerPool | null;
      workers: RunnerWorker[];
    };

/** A failed command: Rust `RunnerError` `{kind, detail}`. */
export interface RunnerError {
  kind: string;
  detail: string;
}

/** Kinds Settings has its own words for (Rust `RunnerError::new` callers). */
export const RUNNER_ERROR_KINDS = [
  'unsupported', 'no_path', 'bad_path', 'not_absolute', 'not_found', 'not_file', 'not_executable', 'io',
  'not_server_mode', 'bad_server', 'spawn', 'timeout', 'failed', 'bad_output', 'too_large',
  'already_running', 'start_failed', 'start_timeout', 'stop_timeout',
] as const;
export type RunnerErrorKind = (typeof RUNNER_ERROR_KINDS)[number];

const LIMIT = { text: 120, long: 300, detail: 2000, items: 64, limited: 16 } as const;

/** One line of plain text: control and bidi/format characters removed, capped. */
export function runnerText(v: unknown, max: number = LIMIT.text): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const time = (v: unknown): string | number | null => (typeof v === 'string' ? runnerText(v, 64) || null : num(v));
const opt = (v: unknown, max?: number): string | null => runnerText(v, max) || null;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown, cap: number): unknown[] => (Array.isArray(v) ? v.slice(0, cap) : []);

function normalizePool(raw: unknown): RunnerPool | null {
  const p = obj(raw);
  if (!p) return null;
  return {
    min: num(p.min),
    max: num(p.max),
    idle: num(p.idle),
    busy: num(p.busy),
    suggestedMax: num(p.suggestedMax),
    suggestion: runnerText(p.suggestion, LIMIT.long),
    limited: list(p.limited, LIMIT.limited)
      .map(obj)
      .filter((l): l is Record<string, unknown> => !!l)
      .map((l) => ({ product: runnerText(l.product, 80), until: time(l.until), untilUnix: num(l.untilUnix) })),
  };
}

/** `board_runner_status` (and the answers of start and stop) → RunnerStatus; null when unreadable. */
export function normalizeRunnerStatus(raw: unknown): RunnerStatus | null {
  const r = obj(raw);
  if (!r || typeof r.running !== 'boolean') return null;
  if (!r.running) return { running: false, server: runnerText(r.server, LIMIT.long) };
  return {
    running: true,
    pid: num(r.pid),
    server: runnerText(r.server, LIMIT.long),
    runner: runnerText(r.runner),
    account: runnerText(r.account),
    startedAt: time(r.startedAt),
    mode: runnerText(r.mode, 32),
    teams: list(r.teams, LIMIT.items).map((t) => runnerText(t)).filter(Boolean),
    pool: normalizePool(r.pool),
    workers: list(r.workers, LIMIT.items)
      .map(obj)
      .filter((w): w is Record<string, unknown> => !!w)
      .map((w) => ({ id: runnerText(w.id, 80), state: runnerText(w.state, 32), task: opt(w.task), since: time(w.since), product: runnerText(w.product, 80) })),
  };
}

/** A rejected `board_runner_*` call → `{kind, detail}` (an unknown shape is `failed` with its text). */
export function normalizeRunnerError(e: unknown): RunnerError {
  const o = obj(e);
  if (o && typeof o.kind === 'string') {
    const detail = typeof o.detail === 'string' ? o.detail : '';
    // The detail may be several lines (a program's error output): keep lines, drop other controls.
    // eslint-disable-next-line no-control-regex
    const clean = detail.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁯﻿]/g, '').trim();
    return { kind: runnerText(o.kind, 32), detail: clean.length > LIMIT.detail ? `${clean.slice(0, LIMIT.detail - 1)}…` : clean };
  }
  const text = e instanceof Error ? e.message : String(e);
  return { kind: 'failed', detail: runnerText(text, LIMIT.detail) };
}

export function isKnownRunnerError(kind: string): kind is RunnerErrorKind {
  return (RUNNER_ERROR_KINDS as readonly string[]).includes(kind);
}

/** A time from the program as local text: ISO text or Unix seconds/milliseconds; else as given. */
export function formatRunnerTime(v: string | number | null): string {
  if (v === null || v === '') return '-';
  let d: Date | null = null;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) d = new Date(v);
  if (d && !Number.isNaN(d.getTime())) return d.toLocaleString();
  return String(v);
}

/** `agents.board.server.runnerPath` as saved (trimmed; empty = the block is off). */
export function readRunnerPath(serverCfg: Record<string, unknown>): string {
  const v = serverCfg[RUNNER_PATH_KEY];
  return typeof v === 'string' ? v.trim() : '';
}

/** Windows has no runner support yet (the host answers `unsupported` there too). */
export function runnerSupported(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): boolean {
  return !/win/i.test(platform);
}
