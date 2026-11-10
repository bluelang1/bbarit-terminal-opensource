// State and formatting for the status bar's DISK readout (project folder size).
//
// Measuring walks every file in the folder, so it must never poll: it runs once
// when a folder is first shown and again only when the user clicks. Values are
// cached per folder for the session, one walk per folder runs at a time, and a
// cancelled walk's late result is dropped.

export type DiskUsageResult = {
  bytes: number;
  files: number;
  cancelled?: boolean;
  skipped?: number;
  elapsedMs?: number;
};

export type DiskEntry = {
  bytes: number;
  files: number;
  skipped: number;
  elapsedMs: number;
  measuredAt: number;
};

export type DiskView = {
  entry: DiskEntry | null;
  measuring: boolean;
  error: string | null;
};

const UNITS = ['B', 'K', 'M', 'G', 'T'];

/** `2.1G` style: one decimal below 10, none at 10 and above. */
export function formatDiskSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  let value = bytes;
  let unit = 0;
  while (unit < UNITS.length - 1 && value >= 1024) {
    value /= 1024;
    unit += 1;
  }
  // 1023.7M would print as 1024M; show it as the next unit instead.
  if (unit < UNITS.length - 1 && Math.round(value) >= 1024) {
    value /= 1024;
    unit += 1;
  }
  const oneDecimal = Math.round(value * 10) / 10;
  if (oneDecimal < 10) return `${oneDecimal.toFixed(1)}${UNITS[unit]}`;
  return `${Math.round(value)}${UNITS[unit]}`;
}

export function formatDiskAgo(elapsedMs: number): { unit: 'now' | 'min' | 'hour'; n: number } {
  const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (minutes < 1) return { unit: 'now', n: 0 };
  if (minutes < 60) return { unit: 'min', n: minutes };
  return { unit: 'hour', n: Math.floor(minutes / 60) };
}

export function isMeasurableDiskPath(path: string | null | undefined): path is string {
  const p = String(path || '').trim();
  return p.length > 0 && !p.startsWith('ssh://');
}

const errorText = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err ?? 'unknown error');
};

export class DiskUsageStore {
  private cache = new Map<string, DiskEntry>();
  private errors = new Map<string, string>();
  private inflight = new Map<string, Promise<unknown>>();
  private listeners = new Set<() => void>();

  private readonly measureFn: (path: string) => Promise<DiskUsageResult>;
  private readonly cancelFn: (path: string) => void;
  private readonly now: () => number;

  constructor(
    measureFn: (path: string) => Promise<DiskUsageResult>,
    cancelFn: (path: string) => void,
    now: () => number = Date.now,
  ) {
    this.measureFn = measureFn;
    this.cancelFn = cancelFn;
    this.now = now;
  }

  view(path: string): DiskView {
    return {
      entry: this.cache.get(path) ?? null,
      measuring: this.inflight.has(path),
      error: this.errors.get(path) ?? null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Measure `path` unless it is cached (pass force to re-measure). A request
   * while the same folder is already being measured does nothing.
   */
  request(path: string, opts: { force?: boolean } = {}): void {
    if (!isMeasurableDiskPath(path)) return;
    if (this.inflight.has(path)) return;
    if (!opts.force && this.cache.has(path)) return;

    const run: Promise<unknown> = this.measureFn(path).then(
      (res) => {
        if (this.inflight.get(path) !== run) return; // cancelled or superseded
        this.inflight.delete(path);
        if (!res.cancelled) {
          this.cache.set(path, {
            bytes: res.bytes,
            files: res.files,
            skipped: res.skipped ?? 0,
            elapsedMs: res.elapsedMs ?? 0,
            measuredAt: this.now(),
          });
          this.errors.delete(path);
        }
        this.emit();
      },
      (err) => {
        if (this.inflight.get(path) !== run) return;
        this.inflight.delete(path);
        this.errors.set(path, errorText(err));
        this.emit();
      },
    );
    this.inflight.set(path, run);
    this.emit();
  }

  /** Stop measuring `path`; a result that still arrives is ignored. */
  cancel(path: string): void {
    if (!this.inflight.has(path)) return;
    this.inflight.delete(path);
    this.cancelFn(path);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
