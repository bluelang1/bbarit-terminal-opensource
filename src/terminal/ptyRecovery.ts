// Reattach to terminals that outlived the previous app run in the PTY holder
// (docs/PTY_HOLDER_DAEMON.md 3.5). App.tsx loads the list once before restoring
// projects; XTerminal asks it whether to attach instead of creating a shell.

export interface PtyModes {
  decset: number[];
  kitty_keyboard: number;
}

/** One `pty_list_recovered` entry (holder WELCOME TerminalEntry). */
export interface RecoveredPty {
  handle: number;
  id: string;
  cwd?: string | null;
  pid?: number | null;
  rows?: number;
  cols?: number;
  exited: boolean;
  exit_code?: number | null;
  scope?: string;
  started_at?: number;
  dropped_bytes: number;
  modes?: PtyModes;
}

export type PtyBackendKind = 'holder' | 'in-process';

export interface PtyRecovery {
  kind: PtyBackendKind;
  recovered: RecoveredPty[];
  fallbackReason?: string | null;
  /** Holder only: how the primary holder was started ("launchd" | "systemd" | "setsid"). */
  spawnMethod?: string | null;
  /** Holder only: why launchd/systemd was not used for it. */
  spawnFallbackReason?: string | null;
  /** Host: the holder is used when `terminal.ptyHolder` is unset (build + OS). */
  defaultOn?: boolean;
  /** Host is a debug build (`debug_assertions`; can differ from `import.meta.env.DEV`). */
  debugBuild?: boolean;
}

/** One-line status of the PTY backend for settings / notices. */
export function describePtyBackend(rec: Pick<PtyRecovery, 'kind' | 'fallbackReason' | 'spawnMethod' | 'spawnFallbackReason'>, ko: boolean): string {
  if (rec.kind !== 'holder') {
    const base = ko ? '앱 안 (in-process)' : 'inside the app (in-process)';
    return rec.fallbackReason ? `${base}: ${rec.fallbackReason}` : base;
  }
  const how = rec.spawnMethod ? ` · ${rec.spawnMethod}` : '';
  const why = rec.spawnFallbackReason ? ` (${rec.spawnFallbackReason})` : '';
  return `${ko ? 'PTY 홀더' : 'PTY holder'}${how}${why}`;
}

/** Host debug build when known, else the frontend's own build flag. */
export function hostDebugBuild(rec: Pick<PtyRecovery, 'debugBuild'>, viteDev: boolean): boolean {
  return rec.debugBuild ?? viteDev;
}

/** Holder default for an unset `terminal.ptyHolder`: the host's answer, else release = on. */
export function ptyHolderDefaultOn(rec: Pick<PtyRecovery, 'defaultOn' | 'debugBuild'>, viteDev: boolean): boolean {
  return rec.defaultOn ?? !hostDebugBuild(rec, viteDev);
}

/**
 * The one-time "terminals now run apart from the app" notice: holder in use, release build
 * (dev keeps the holder opt-in), and quitting really keeps terminals (keepRunningOnQuit).
 */
export function holderIntroWanted(rec: Pick<PtyRecovery, 'kind'>, devBuild: boolean, keepRunningOnQuit: boolean): boolean {
  return rec.kind === 'holder' && !devBuild && keepRunningOnQuit;
}

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

// ── registry (one per app run) ──
let current: PtyRecovery = { kind: 'in-process', recovered: [] };
let byId = new Map<string, RecoveredPty>();
const handled = new Set<string>();
let loading: Promise<PtyRecovery> | null = null;

export function setPtyRecovery(next: PtyRecovery): void {
  current = { ...next, recovered: [...next.recovered] };
  byId = new Map(next.recovered.map((e) => [e.id, e]));
  handled.clear();
}

export function getPtyRecovery(): PtyRecovery {
  return current;
}

/** The recovered entry for this id, unless it was already handled (exited + released). */
export function recoveredPtyFor(id: string): RecoveredPty | undefined {
  return handled.has(id) ? undefined : byId.get(id);
}

export function markRecoveredHandled(id: string): void {
  handled.add(id);
}

/**
 * `isRestored` for a tab: with the holder, "it is in the recovered list"; in-process keeps
 * the old heuristic (a saved lastWorkDir). Stable for the whole run (it is an effect dep).
 */
export function isRestoredTerminal(id: string, lastWorkDir?: string | null, recovery: PtyRecovery = current): boolean {
  if (recovery.kind === 'holder') return recovery.recovered.some((e) => e.id === id);
  return !!lastWorkDir;
}

export interface LoadPtyRecoveryOptions {
  /** Upper bound for one attempt (the first `pty_backend_info` may start the holder). */
  timeoutMs?: number;
  /** Waits between failed attempts; the last one repeats. */
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000] as const;

/**
 * Ask the backend once (memoized). A failed or timed-out attempt is retried with backoff
 * and never read as "in-process, nothing recovered": that would make every saved tab call
 * create_shell over a terminal still running in the holder. Callers that await this
 * (App.tsx, before restoring projects) therefore create no shells until it answers.
 */
export function loadPtyRecovery(invokeFn: InvokeLike, opts: LoadPtyRecoveryOptions = {}): Promise<PtyRecovery> {
  if (loading) return loading;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const attempt = async (): Promise<PtyRecovery> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pty recovery list timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    const work = (async () => {
      const info = await invokeFn<{ kind?: string; fallbackReason?: string | null; spawnMethod?: string | null; spawnFallbackReason?: string | null; defaultOn?: boolean; debugBuild?: boolean }>('pty_backend_info');
      const recovered = info?.kind === 'holder' ? await invokeFn<RecoveredPty[]>('pty_list_recovered') : [];
      return {
        kind: (info?.kind === 'holder' ? 'holder' : 'in-process') as PtyBackendKind,
        recovered: Array.isArray(recovered) ? recovered.filter((e) => e && typeof e.id === 'string') : [],
        fallbackReason: info?.fallbackReason ?? null,
        spawnMethod: info?.spawnMethod ?? null,
        spawnFallbackReason: info?.spawnFallbackReason ?? null,
        ...(typeof info?.defaultOn === 'boolean' ? { defaultOn: info.defaultOn } : {}),
        ...(typeof info?.debugBuild === 'boolean' ? { debugBuild: info.debugBuild } : {}),
      };
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  loading = (async () => {
    for (let n = 0; ; n++) {
      try {
        const result = await attempt();
        setPtyRecovery(result);
        return result;
      } catch (err) {
        opts.onRetry?.(n + 1, err);
        await sleep(backoff[Math.min(n, backoff.length - 1)]);
      }
    }
  })();
  return loading;
}

/** Tests only: forget the memoized load and every per-run mark. */
export function resetPtyRecoveryForTests(): void {
  loading = null;
  setPtyRecovery({ kind: 'in-process', recovered: [] });
  awaitingRestart.clear();
}

/** `create_shell` refused because the id still runs in the holder: attach to it instead. */
export function isAliveInHolderError(err: unknown): boolean {
  return String((err as { message?: string })?.message ?? err).includes('PTY alive in holder');
}

// ── exited terminals waiting for Enter (survives remounts of the same tab) ──
const awaitingRestart = new Map<string, string>();

/** The tab shows an exited recovered terminal; `banner` is redrawn by a remount. */
export function markAwaitingRestart(id: string, banner: string): void {
  awaitingRestart.set(id, banner);
}

/** Banner to redraw when this id is still waiting for Enter, else undefined. */
export function awaitingRestartBanner(id: string): string | undefined {
  return awaitingRestart.get(id);
}

export function clearAwaitingRestart(id: string): void {
  awaitingRestart.delete(id);
}

// ── pure helpers ──

/** What XTerminal does at init: attach to a live one, show an exited one, or create a shell. */
export type RecoveredStartPlan = 'attach' | 'exited' | 'create';

export function recoveredStartPlan(entry: RecoveredPty | undefined, ptyAlreadyExists: boolean): RecoveredStartPlan {
  if (ptyAlreadyExists || !entry) return 'create';
  return entry.exited ? 'exited' : 'attach';
}

/**
 * After the liveness probe: an 'attach' whose terminal is no longer alive (it ended between
 * the list and this mount, or the holder lost it) is shown as exited (tail + banner +
 * Enter restarts), never silently replaced by a fresh shell.
 */
export function planAfterProbe(plan: RecoveredStartPlan, alive: boolean): RecoveredStartPlan {
  return plan === 'attach' && !alive ? 'exited' : plan;
}

/** Recovered terminals are already running: never defer them on startup. */
export function withoutRecovered(deferred: Set<string>, recovered: readonly RecoveredPty[]): Set<string> {
  if (recovered.length === 0) return deferred;
  const ids = new Set(recovered.map((e) => e.id));
  return new Set([...deferred].filter((id) => !ids.has(id)));
}

const KNOWN_MODES = new Set([47, 1047, 1049, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004, 25, 1, 7]);

/** DECSET sequences that restore the modes the tail may have been cut after (alt screen first). */
export function decsetPrefix(modes: PtyModes | undefined | null): string {
  if (!modes) return '';
  const set = (modes.decset || []).filter((n) => Number.isInteger(n) && KNOWN_MODES.has(n));
  const alt = set.filter((n) => n === 47 || n === 1047 || n === 1049);
  const rest = set.filter((n) => !(n === 47 || n === 1047 || n === 1049));
  let out = [...alt, ...rest].map((n) => `\x1b[?${n}h`).join('');
  const kitty = Number(modes.kitty_keyboard) || 0;
  if (kitty > 0) out += `\x1b[>${kitty}u`;
  return out;
}

/** Undo `decsetPrefix` (an exited program's screen: banner goes to the main screen). */
export function decsetReset(modes: PtyModes | undefined | null): string {
  if (!modes) return '';
  const set = (modes.decset || []).filter((n) => Number.isInteger(n) && KNOWN_MODES.has(n));
  let out = (Number(modes.kitty_keyboard) || 0) > 0 ? '\x1b[<u' : '';
  out += [...set].reverse().map((n) => `\x1b[?${n}l`).join('');
  return out;
}

export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? String(Math.round(mb)) : String(Math.max(0.1, Math.round(mb * 10) / 10));
}

/** "[앱이 꺼진 동안 N MB 생략]" before the replay, or '' when nothing was dropped. */
export function omittedBytesLine(droppedBytes: number | undefined | null, template = '[앱이 꺼진 동안 {n} MB 생략]'): string {
  const n = Number(droppedBytes) || 0;
  if (n <= 0) return '';
  return `\x1b[2m${template.replace('{n}', formatMegabytes(n))}\x1b[0m\r\n`;
}

/** "종료됨 (code N)" for a terminal that ended while the app was closed, else null. */
export function exitedBannerText(entry: RecoveredPty | undefined, template = '종료됨 (code {code})', noCode = '종료됨'): string | null {
  if (!entry?.exited) return null;
  return typeof entry.exit_code === 'number' ? template.replace('{code}', String(entry.exit_code)) : noCode;
}

export function normalizeDir(path: string | null | undefined): string {
  return String(path || '').trim().replace(/[\\/]+$/, '');
}

type PlaceTerminal = { id: string };
type PlaceProject<T extends PlaceTerminal> = { id: string; workDir: string; terminals: T[] };

/**
 * Holder terminals without a saved tab: attach each to the project whose workDir equals its
 * cwd (a "복구됨" tab), else collect them in one synthetic project. Never drops any.
 */
export function placeUnknownRecovered<T extends PlaceTerminal, P extends PlaceProject<T>>(
  projects: P[],
  recovered: readonly RecoveredPty[],
  make: { terminal: (entry: RecoveredPty) => T; project: (entries: RecoveredPty[], terminals: T[]) => P },
): { projects: P[]; placed: Map<string, string> } {
  const known = new Set(projects.flatMap((p) => p.terminals.map((t) => t.id)));
  const placed = new Map<string, string>();
  const orphans: RecoveredPty[] = [];
  let next = projects;
  for (const entry of recovered) {
    if (known.has(entry.id)) continue;
    known.add(entry.id);
    const cwd = normalizeDir(entry.cwd);
    const idx = cwd ? next.findIndex((p) => normalizeDir(p.workDir) === cwd) : -1;
    if (idx < 0) { orphans.push(entry); continue; }
    if (next === projects) next = projects.slice();
    next[idx] = { ...next[idx], terminals: [...next[idx].terminals, make.terminal(entry)] };
    placed.set(entry.id, next[idx].id);
  }
  if (orphans.length > 0) {
    const project = make.project(orphans, orphans.map((e) => make.terminal(e)));
    next = [...next, project];
    for (const e of orphans) placed.set(e.id, project.id);
  }
  return { projects: next, placed };
}
