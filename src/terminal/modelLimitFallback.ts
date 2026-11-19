// Claude model limit fallback: when a Claude tab hits the usage limit of the primary model
// (Fable), switch that tab to the fallback model (Opus) with `/model`, resume the refused
// prompt, and switch back after the limit resets. Pure logic + a controller with injected
// dependencies; XTerminal/App wire it up in src/terminal/modelLimitRuntime.ts.
// Design: docs/MODEL_LIMIT_FALLBACK.md
import type { AgentTabState } from './programStatus';

export interface FallbackSettings {
  enabled: boolean;
  /** Model id the tab normally runs (claude-fable-5-2). */
  primaryModel: string;
  /** Model id used while the primary is limited (opus). */
  fallbackModel: string;
  /** JSON usage file written by the user's status line; '' = not used. */
  usageFile: string;
}

export const DEFAULT_PRIMARY_MODEL = 'claude-fable-5-2';
export const DEFAULT_FALLBACK_MODEL = 'opus';
export const DEFAULT_USAGE_FILE = '~/.claude/logs/model-usage.json';

/** Persisted on the terminal (TerminalInstance.modelFallback): this tab was switched by the app. */
export interface ModelFallbackMark {
  /** Model the tab runs now (the fallback). */
  model: string;
  /** Model to return to after the reset. */
  primary: string;
  /** Epoch ms of the limit reset; null = unknown (re-read the usage file later). */
  resetAt: number | null;
  /** Epoch ms of the switch. */
  switchedAt: number;
  /** `/model` was sent but "Set model to …" was not seen: the tab may still be on the primary. */
  unconfirmed?: boolean;
}

/** Shortest time a tab stays on the fallback, whatever the reset time says. */
export const MIN_SWITCH_GAP_MS = 15 * 60 * 1000;
/** A re-hit right after returning on an old reset time waits this long before trying again. */
export const REHIT_RETRY_MS = 30 * 60 * 1000;
/** Limit events for one tab within this window are one event (OSC error, error again after Esc, hook). */
export const LIMIT_DEDUPE_MS = 2 * 60 * 1000;
export const DIALOG_WAIT_MS = 5000;
export const DIALOG_CLOSE_WAIT_MS = 3000;
export const VERIFY_WAIT_MS = 8000;
export const POLL_MS = 100;

export function fallbackSettingsFrom(agent: Partial<{
  claudeLimitFallback: boolean;
  claudeLimitPrimaryModel: string;
  claudeLimitFallbackModel: string;
  claudeLimitUsageFile: string;
}> | null | undefined): FallbackSettings {
  // Model ids are typed into Claude Code (`/model <id>`) and the launch command: one token only.
  const str = (v: unknown, d: string) => (typeof v === 'string' && /^[\w.:[\]-]{1,128}$/.test(v.trim()) ? v.trim() : d);
  return {
    enabled: agent?.claudeLimitFallback === true,
    primaryModel: str(agent?.claudeLimitPrimaryModel, DEFAULT_PRIMARY_MODEL),
    fallbackModel: str(agent?.claudeLimitFallbackModel, DEFAULT_FALLBACK_MODEL),
    usageFile: typeof agent?.claudeLimitUsageFile === 'string' ? agent.claudeLimitUsageFile.trim() : DEFAULT_USAGE_FILE,
  };
}

/**
 * Name Claude Code uses for a model in messages: `claude-fable-5-2` → `Fable`, `opus` → `Opus`,
 * `sonnet[1m]` → `Sonnet`. First alphabetic segment after an optional `claude-` prefix.
 */
export function modelDisplayName(modelId: string): string {
  const id = String(modelId || '').trim().replace(/\[[^\]]*\]$/, '').toLowerCase().replace(/^claude-/, '');
  const seg = id.split(/[-_.\s]+/).find((s) => /^[a-z]+$/.test(s)) || id;
  return seg ? seg[0].toUpperCase() + seg.slice(1) : '';
}

export interface LimitMessage {
  /** Model name in the message (`Fable`). */
  model: string;
  /** Text after `resets` (`Nov 21 at 12pm (Asia/Seoul)`), if any. */
  resetText?: string;
}

// "You've hit your Fable limit · resets Nov 21 at 12pm (Asia/Seoul)". The name is required:
// "You've hit your limit" (session limit) names no model and is not a model limit.
const LIMIT_RE = /You(?:'|’|&#39;)?ve hit your\s+(.+?)\s+limit\b\s*(?:[·•|,:;–—-]\s*)?(?:resets?\s+(.+?))?\s*\.?\s*$/i;

/** Parse a limit message (OSC 7501 error msg or StopFailure last_assistant_message). */
export function parseLimitMessage(msg: string | null | undefined): LimitMessage | null {
  if (typeof msg !== 'string' || msg.length > 512) return null;
  const m = LIMIT_RE.exec(msg.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const model = m[1].trim();
  if (!model || /^(usage|session|weekly|daily|monthly|rate|5-hour|five-hour)$/i.test(model)) return null;
  return { model, resetText: m[2]?.trim() || undefined };
}

/** Is this message the primary model's limit (name compared case-insensitively, `Fable 5.2` = `Fable`)? */
export function isPrimaryLimitMessage(msg: string | null | undefined, primaryModel: string): LimitMessage | null {
  const parsed = parseLimitMessage(msg);
  if (!parsed) return null;
  const want = modelDisplayName(primaryModel).toLowerCase();
  const got = parsed.model.toLowerCase();
  if (!want || !(got === want || got.startsWith(`${want} `))) return null;
  return parsed;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`; null for an unknown zone. */
export function timeZoneOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/** Wall time in a zone → epoch ms (two passes cover DST edges). No zone = the local zone. */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, timeZone?: string): number | null {
  if (!timeZone) return new Date(y, mo, d, h, mi).getTime();
  const guess = Date.UTC(y, mo, d, h, mi);
  const off1 = timeZoneOffsetMs(guess, timeZone);
  if (off1 === null) return null;
  const off2 = timeZoneOffsetMs(guess - off1, timeZone) ?? off1;
  return guess - off2;
}

function zonedYmd(utcMs: number, timeZone?: string): { y: number; mo: number; d: number } {
  if (!timeZone) { const t = new Date(utcMs); return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() }; }
  const off = timeZoneOffsetMs(utcMs, timeZone) ?? 0;
  const t = new Date(utcMs + off);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth(), d: t.getUTCDate() };
}

const RESET_RE = /^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?$/i;

/**
 * `Nov 21 at 12pm (Asia/Seoul)`, `3pm (Asia/Seoul)`, `Nov 21, 2026 at 9:30am`, `14:00` → epoch ms
 * of the next such time (a date without a year is this year, or next year when already
 * more than a day past). Without a zone, the local zone. null when it cannot be read.
 */
export function parseResetText(text: string | null | undefined, now: number): number | null {
  if (typeof text !== 'string') return null;
  const m = RESET_RE.exec(text.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const [, monName, dayStr, yearStr, hStr, miStr, ap, tzRaw] = m;
  let h = Number(hStr);
  const mi = miStr ? Number(miStr) : 0;
  if (mi > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
  } else if (!miStr || h > 23) {
    return null; // a bare "12" is not a time
  }
  const tz = tzRaw?.trim() || undefined;
  if (tz && timeZoneOffsetMs(now, tz) === null) return null;
  if (monName) {
    const mo = MONTHS.indexOf(monName.slice(0, 3).toLowerCase());
    const d = Number(dayStr);
    if (mo < 0 || d < 1 || d > 31) return null;
    if (yearStr) return zonedToEpoch(Number(yearStr), mo, d, h, mi, tz);
    const { y } = zonedYmd(now, tz);
    const at = zonedToEpoch(y, mo, d, h, mi, tz);
    if (at === null) return null;
    // Up to a day old: keep it (a stale message; the caller ignores past times). A date far
    // behind (the year wrapped, "Jan 2" read in November) is next year. Anything in between is
    // a stale message, not a reset a year away.
    if (at >= now - 24 * 3600 * 1000) return at;
    return at < now - 180 * 24 * 3600 * 1000 ? zonedToEpoch(y + 1, mo, d, h, mi, tz) : null;
  }
  const { y, mo, d } = zonedYmd(now, tz);
  const today = zonedToEpoch(y, mo, d, h, mi, tz);
  if (today === null) return null;
  return today > now ? today : zonedToEpoch(y, mo, d + 1, h, mi, tz);
}

export interface UsageEntry { name: string; pct: number; resetsAt: number | null }

/** The usage file (`[{"name":"Fable","pct":100,"resets_at":"…"}]`) → entries; [] when unreadable. */
export function parseUsageFile(raw: string | null | undefined): UsageEntry[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const list = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as any).models) ? (data as any).models : []);
  const out: UsageEntry[] = [];
  for (const e of list as any[]) {
    if (!e || typeof e.name !== 'string') continue;
    const pct = Number(e.pct);
    const t = typeof e.resets_at === 'string' ? Date.parse(e.resets_at) : NaN;
    out.push({ name: e.name, pct: Number.isFinite(pct) ? pct : 0, resetsAt: Number.isFinite(t) ? t : null });
  }
  return out;
}

export function usageEntryFor(entries: UsageEntry[], modelId: string): UsageEntry | null {
  const want = modelDisplayName(modelId).toLowerCase();
  return entries.find((e) => {
    const n = e.name.trim().toLowerCase();
    return n === want || n.startsWith(`${want} `);
  }) || null;
}

/** The primary is at its limit per the usage file: 100 % and a reset still ahead. */
export function usageSaysLimited(entry: UsageEntry | null, now: number): entry is UsageEntry & { resetsAt: number } {
  return !!entry && entry.pct >= 100 && entry.resetsAt !== null && entry.resetsAt > now;
}

export type ResetSource = 'usage' | 'message' | 'retry' | null;

/**
 * Reset time for a switch: the usage file's `resets_at` for the model (if ahead), else the
 * message's time, else null. `previousResetAt` is the reset a tab just returned on: a re-hit
 * that names the same (or an earlier) reset is stale, so the tab retries after REHIT_RETRY_MS.
 */
export function chooseResetAt(input: {
  usage: UsageEntry | null;
  resetText?: string;
  now: number;
  previousResetAt?: number | null;
}): { resetAt: number | null; source: ResetSource } {
  const { usage, resetText, now, previousResetAt } = input;
  let resetAt: number | null = null;
  let source: ResetSource = null;
  if (usage?.resetsAt && usage.resetsAt > now) { resetAt = usage.resetsAt; source = 'usage'; }
  else {
    const fromMsg = parseResetText(resetText, now);
    if (fromMsg !== null && fromMsg > now) { resetAt = fromMsg; source = 'message'; }
  }
  if (previousResetAt != null && (resetAt === null || resetAt <= previousResetAt + 60_000)) {
    return { resetAt: now + REHIT_RETRY_MS, source: 'retry' };
  }
  return { resetAt, source };
}

/** Is `extraFlags` / modelId a model the person chose? (then the app never touches the tab) */
export function personChoseModel(modelId: string | null | undefined, flags: readonly string[] | null | undefined): boolean {
  if (typeof modelId === 'string' && modelId.trim()) return true;
  return (flags || []).some((f) => f === '--model' || f.startsWith('--model='));
}

export interface LaunchDecision {
  /** Add `--model <model>` to the launch command. */
  model?: string;
  /** Mark to store (null = clear); undefined = unchanged. */
  mark?: ModelFallbackMark | null;
}

/**
 * Launch-time choice for a Claude tab the person did not give a model. A marked tab keeps
 * the fallback until the reset, then starts on the primary and drops the mark. An unmarked
 * tab starts on the fallback only when the usage file says the primary is at 100 % with a
 * future reset; otherwise the command is left unchanged (no `--model` is added).
 */
export function decideLaunchModel(input: {
  settings: FallbackSettings;
  personModel: boolean;
  mark: ModelFallbackMark | null | undefined;
  usage: UsageEntry[];
  now: number;
}): LaunchDecision {
  const { settings, personModel, mark, usage, now } = input;
  if (!settings.enabled || personModel) return {};
  const primaryUsage = usageEntryFor(usage, settings.primaryModel);
  if (mark) {
    if (usageSaysLimited(primaryUsage, now)) {
      return primaryUsage.resetsAt !== mark.resetAt ? { model: mark.model, mark: { ...mark, resetAt: primaryUsage.resetsAt } } : { model: mark.model };
    }
    const due = mark.resetAt !== null ? now >= mark.resetAt : (primaryUsage !== null && primaryUsage.pct < 100);
    if (due) return { model: mark.primary, mark: null };
    return { model: mark.model };
  }
  if (usageSaysLimited(primaryUsage, now)) {
    return {
      model: settings.fallbackModel,
      mark: { model: settings.fallbackModel, primary: settings.primaryModel, resetAt: primaryUsage.resetsAt, switchedAt: now },
    };
  }
  return {};
}

export function sanitizeModelFallbackMark(raw: unknown): ModelFallbackMark | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const ok = (s: unknown) => typeof s === 'string' && s.trim().length > 0 && s.length <= 128 && !/[\s"'`$\\;|&<>]/.test(s);
  if (!ok(r.model) || !ok(r.primary)) return undefined;
  const switchedAt = Number(r.switchedAt);
  if (!Number.isFinite(switchedAt) || switchedAt <= 0) return undefined;
  const resetAt = r.resetAt === null || r.resetAt === undefined ? null : Number(r.resetAt);
  if (resetAt !== null && !Number.isFinite(resetAt)) return undefined;
  const mark: ModelFallbackMark = { model: r.model as string, primary: r.primary as string, resetAt, switchedAt };
  if (r.unconfirmed === true) mark.unconfirmed = true;
  return mark;
}

// ── Controller ─────────────────────────────────────────────────────

/** After a `/model` that was not confirmed, wait this long before trying again. */
export const UNCONFIRMED_BACKOFF_MS = 30 * 60 * 1000;
/** Switch or return attempts per tab before giving up. */
export const MAX_ATTEMPTS = 3;
/** How long the switch waits for a half-typed human prompt to be sent or cleared. */
export const PENDING_INPUT_WAIT_MS = 30_000;

export type FallbackLocale = 'ko' | 'en';

export function continueMessage(locale: FallbackLocale): string {
  return locale === 'ko' ? '이어서 진행해줘' : 'Continue';
}

export interface TabInfo {
  isClaude: boolean;
  /** The person/project/flags set a model: the app never switches this tab. */
  personModel: boolean;
  /** The tab's known Claude session id (hook reports for another session are ignored). */
  sessionId?: () => string | undefined;
}

export interface SendResult { ok: boolean; reason?: string }

export type FailReason = 'typing' | 'human' | 'dialog' | 'not-confirmed' | 'gave-up' | 'return-gave-up' | 'blocked' | 'other';

export type FallbackNotice =
  | { kind: 'switched'; terminalId: string; primary: string; fallback: string; resetAt: number | null }
  | { kind: 'returned'; terminalId: string; primary: string; fallback: string }
  | { kind: 'default-restored'; terminalId: string; primary: string; fallback: string }
  | { kind: 'default-left'; terminalId: string; primary: string; fallback: string }
  | { kind: 'released'; terminalId: string; primary: string; fallback: string }
  | { kind: 'failed'; terminalId: string; primary: string; fallback: string; reason: FailReason };

/** App-wide: our `/model <fallback>` also saved the fallback as Claude Code's default model. */
export interface DefaultChange { primary: string; fallback: string; resetAt: number | null; at: number; toldPerson?: boolean }

export interface ControllerDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  settings(): FallbackSettings;
  tab(terminalId: string): TabInfo | undefined;
  /** Mounted Claude tabs (for restoring the default model). */
  tabIds(): string[];
  agentState(terminalId: string): AgentTabState | undefined;
  isReplaying(terminalId: string): boolean;
  /** lastCommand holds uncommitted human text for the tab (a half-typed prompt). */
  hasPendingInput(terminalId: string): boolean;
  /** Epoch ms of the last human key in the tab (input gate), 0 when none. */
  lastHumanInputAt(terminalId: string): number;
  /**
   * Write through the input gate. `closeLimitDialog` is the gate's narrow exception: a lone Esc
   * may pass while the tab is (still) blocked on the rate-limit dialog.
   */
  send(terminalId: string, text: string, opts: { submit: boolean; closeLimitDialog?: boolean }): Promise<SendResult>;
  /** Recent screen text (last rows of the buffer) for the `/model` confirmation. */
  screenText(terminalId: string): string;
  readUsage(): Promise<UsageEntry[]>;
  getMark(terminalId: string): ModelFallbackMark | undefined;
  setMark(terminalId: string, mark: ModelFallbackMark | null): void;
  getDefaultChange(): DefaultChange | null;
  setDefaultChange(change: DefaultChange | null): void;
  notify(notice: FallbackNotice): void;
  locale(): FallbackLocale;
}

interface TabRuntime {
  busy: boolean;
  humanChose: boolean;
  lastLimitAt: number;
  /** Reset time the tab last returned on (re-hit guard). */
  lastReturnFromResetAt?: number | null;
  nextReturnTryAt: number;
  switchAttempts: number;
  lastSwitchAttemptAt: number;
  returnAttempts: number;
}

export type LimitSource = 'osc' | 'hook';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function countMatches(text: string, re: RegExp): number {
  return (text.match(new RegExp(re.source, 'gi')) || []).length;
}

class Abort extends Error {
  reason: FailReason;
  constructor(reason: FailReason) { super(reason); this.reason = reason; }
}

export class ModelLimitController {
  private tabs = new Map<string, TabRuntime>();
  private deps: ControllerDeps;
  private restoringDefault = false;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  private rt(terminalId: string): TabRuntime {
    let r = this.tabs.get(terminalId);
    if (!r) {
      r = { busy: false, humanChose: false, lastLimitAt: 0, nextReturnTryAt: 0, switchAttempts: 0, lastSwitchAttemptAt: 0, returnAttempts: 0 };
      this.tabs.set(terminalId, r);
    }
    return r;
  }

  forget(terminalId: string): void { this.tabs.delete(terminalId); }

  isBusy(terminalId: string): boolean { return !!this.tabs.get(terminalId)?.busy; }

  /** A person ran `/mo…` in this tab during this app run. */
  isHumanChosen(terminalId: string): boolean { return !!this.tabs.get(terminalId)?.humanChose; }

  /**
   * The person hands a tab they took over with `/mo…` back to the app. Clears only that flag:
   * nothing is typed and the current model stays; the next primary limit switches as usual.
   */
  releaseHumanChoice(terminalId: string): boolean {
    const r = this.tabs.get(terminalId);
    if (!r?.humanChose) return false;
    r.humanChose = false;
    r.lastLimitAt = 0;
    r.switchAttempts = 0;
    return true;
  }

  /**
   * Committed human command (lastCommand). A human `/model` (or any slash command starting with
   * `/mo`: an autocomplete pick may commit as a prefix) hands the tab to the person.
   */
  onHumanCommand(terminalId: string, cmd: string): void {
    if (!/^\/mo/i.test(cmd.trim())) return;
    const r = this.rt(terminalId);
    r.humanChose = true;
    if (this.deps.getMark(terminalId)) this.deps.setMark(terminalId, null);
  }

  /** OSC 7501 report. Only `state=error` with the primary model's limit text counts. */
  onStatusReport(terminalId: string, report: { state: string; msg?: string; app?: string }, replaying: boolean): Promise<void> | void {
    if (replaying || report.state !== 'error') return;
    if (report.app && report.app !== 'claude-code') return;
    const settings = this.deps.settings();
    const limit = isPrimaryLimitMessage(report.msg, settings.primaryModel);
    if (!limit) return;
    return this.onLimit(terminalId, 'osc', limit);
  }

  /**
   * StopFailure hook report (`error: "rate_limit"`) for this tab's session. With a message, it
   * must be the primary model's limit (a session or weekly limit applies to the fallback too);
   * only an empty message takes the nameless path.
   */
  onHookReport(terminalId: string, report: { error?: string; message?: string; sessionId?: string }): Promise<void> | void {
    if (report.error !== 'rate_limit') return;
    const known = this.deps.tab(terminalId)?.sessionId?.();
    if (report.sessionId && known && report.sessionId.toLowerCase() !== known.toLowerCase()) return;
    const settings = this.deps.settings();
    const text = (report.message || '').trim();
    if (text) {
      const limit = isPrimaryLimitMessage(text, settings.primaryModel);
      if (!limit) return;
      return this.onLimit(terminalId, 'hook', limit);
    }
    return this.onLimit(terminalId, 'hook', { model: modelDisplayName(settings.primaryModel) });
  }

  private eligible(terminalId: string): boolean {
    const settings = this.deps.settings();
    const tab = this.deps.tab(terminalId);
    if (!settings.enabled || !tab?.isClaude || tab.personModel) return false;
    if (this.rt(terminalId).humanChose) return false;
    return true;
  }

  private async waitFor(pred: () => boolean, ms: number): Promise<boolean> {
    const start = this.deps.now();
    while (!pred()) {
      if (this.deps.now() - start >= ms) return false;
      await this.deps.sleep(POLL_MS);
    }
    return true;
  }

  /** Send `/model <model>` and wait for "Set model to <Name>" to appear once more on screen. */
  private async switchModel(terminalId: string, model: string): Promise<SendResult> {
    const confirm = new RegExp(`Set model to\\s+${escapeRe(modelDisplayName(model))}`, 'i');
    const before = countMatches(this.deps.screenText(terminalId), confirm);
    const sent = await this.deps.send(terminalId, `/model ${model}`, { submit: true });
    if (!sent.ok) return sent;
    const seen = await this.waitFor(() => countMatches(this.deps.screenText(terminalId), confirm) > before, VERIFY_WAIT_MS);
    return seen ? { ok: true } : { ok: false, reason: 'not-confirmed' };
  }

  async onLimit(terminalId: string, _source: LimitSource, limit: LimitMessage): Promise<void> {
    if (!this.eligible(terminalId)) return;
    if (this.deps.isReplaying(terminalId)) return;
    const r = this.rt(terminalId);
    const now = this.deps.now();
    if (r.busy || now - r.lastLimitAt < LIMIT_DEDUPE_MS) return;
    const existing = this.deps.getMark(terminalId);
    if (existing && !existing.unconfirmed) return; // already on the fallback
    if (r.switchAttempts > 0 && now - r.lastSwitchAttemptAt < UNCONFIRMED_BACKOFF_MS) return;
    const settings = this.deps.settings();
    const { primaryModel: primary, fallbackModel: fallback } = settings;
    if (r.switchAttempts >= MAX_ATTEMPTS) return;
    r.busy = true;
    r.lastLimitAt = now;
    const humanAtStart = this.deps.lastHumanInputAt(terminalId);
    // Stop if the person took over: typed, chose a dialog option, or ran /model.
    const check = () => {
      if (r.humanChose || !this.eligible(terminalId)) throw new Abort('human');
      if (this.deps.lastHumanInputAt(terminalId) > humanAtStart) throw new Abort('human');
    };
    const fail = (reason: FailReason) => this.deps.notify({ kind: 'failed', terminalId, primary, fallback, reason });
    try {
      // 1. Close the rate-limit dialog (/rate-limit-options) with Esc. It opens right after the
      //    error report; a Claude Code without the dialog simply never reports blocked.
      const opened = await this.waitFor(() => this.deps.agentState(terminalId) === 'blocked', DIALOG_WAIT_MS);
      check();
      if (opened) {
        const esc = await this.deps.send(terminalId, '\x1b', { submit: false, closeLimitDialog: true });
        check();
        if (!esc.ok) throw new Abort(esc.reason === 'typing' ? 'typing' : 'dialog');
        const closed = await this.waitFor(() => this.deps.agentState(terminalId) !== 'blocked', DIALOG_CLOSE_WAIT_MS);
        check();
        if (!closed) throw new Abort('dialog');
      }
      // 2. Never type into a half-typed prompt.
      const clear = await this.waitFor(() => !this.deps.hasPendingInput(terminalId), PENDING_INPUT_WAIT_MS);
      check();
      if (!clear) throw new Abort('typing');
      // 3. Switch and confirm on screen.
      r.switchAttempts += 1;
      r.lastSwitchAttemptAt = this.deps.now();
      const switched = await this.switchModel(terminalId, fallback);
      if (switched.ok || switched.reason === 'not-confirmed') {
        // Sent: Claude Code may have saved the fallback as its default model.
        if (!this.deps.getDefaultChange()) this.deps.setDefaultChange({ primary, fallback, resetAt: null, at: this.deps.now() });
      }
      // 4. Mark with the reset time (usage file first, then the message).
      let usage: UsageEntry[] = [];
      try { usage = await this.deps.readUsage(); } catch { usage = []; }
      const { resetAt } = chooseResetAt({
        usage: usageEntryFor(usage, primary),
        resetText: limit.resetText,
        now: this.deps.now(),
        previousResetAt: r.lastReturnFromResetAt,
      });
      const dc = this.deps.getDefaultChange();
      if (dc && resetAt !== null && (dc.resetAt === null || resetAt > dc.resetAt)) this.deps.setDefaultChange({ ...dc, resetAt });
      if (!switched.ok) {
        if (switched.reason === 'not-confirmed') {
          // Possibly switched: mark it so it can return, with a note; no continue message.
          this.deps.setMark(terminalId, { model: fallback, primary, resetAt, switchedAt: this.deps.now(), unconfirmed: true });
        }
        throw new Abort(r.switchAttempts >= MAX_ATTEMPTS ? 'gave-up' : switched.reason === 'not-confirmed' ? 'not-confirmed' : switched.reason === 'typing' ? 'typing' : 'other');
      }
      check(); // a human /model during the switch keeps the tab theirs: no mark, no continue
      r.lastReturnFromResetAt = undefined;
      r.switchAttempts = 0;
      this.deps.setMark(terminalId, { model: fallback, primary, resetAt, switchedAt: this.deps.now() });
      this.deps.notify({ kind: 'switched', terminalId, primary, fallback, resetAt });
      // 5. Resume the refused prompt (it stays in the transcript with the rate-limit error).
      check();
      if (this.deps.hasPendingInput(terminalId)) return;
      await this.deps.send(terminalId, continueMessage(this.deps.locale()), { submit: true });
    } catch (e) {
      if (e instanceof Abort) fail(e.reason);
      else throw e;
    } finally {
      r.busy = false;
    }
  }

  /**
   * Periodic check for one marked tab: after the reset (and at least MIN_SWITCH_GAP_MS after the
   * switch), when the tab is idle/done, not replaying and has no half-typed prompt, send
   * `/model <primary>` and clear the mark.
   */
  async maybeReturn(terminalId: string): Promise<void> {
    const mark = this.deps.getMark(terminalId);
    if (!mark) return;
    const settings = this.deps.settings();
    const tab = this.deps.tab(terminalId);
    if (!settings.enabled || !tab?.isClaude) return;
    const r = this.rt(terminalId);
    const now = this.deps.now();
    if (r.busy || now < r.nextReturnTryAt || now - mark.switchedAt < MIN_SWITCH_GAP_MS) return;
    if (!this.idleForInput(terminalId)) return;
    let usage: UsageEntry[] = [];
    try { usage = await this.deps.readUsage(); } catch { usage = []; }
    const entry = usageEntryFor(usage, mark.primary);
    if (usageSaysLimited(entry, now)) {
      // The file knows a later reset (or the reset was unknown): wait for it.
      if (entry.resetsAt !== mark.resetAt) this.deps.setMark(terminalId, { ...mark, resetAt: entry.resetsAt });
      return;
    }
    const due = mark.resetAt !== null ? now >= mark.resetAt : (entry !== null && entry.pct < 100);
    if (!due) return;
    r.busy = true;
    try {
      if (!this.idleForInput(terminalId)) return;
      const res = await this.switchModel(terminalId, mark.primary);
      if (!res.ok) {
        r.returnAttempts += 1;
        r.nextReturnTryAt = this.deps.now() + UNCONFIRMED_BACKOFF_MS;
        if (r.returnAttempts >= MAX_ATTEMPTS) {
          r.returnAttempts = 0;
          this.deps.setMark(terminalId, null);
          this.deps.notify({ kind: 'failed', terminalId, primary: mark.primary, fallback: mark.model, reason: 'return-gave-up' });
        }
        return;
      }
      r.returnAttempts = 0;
      r.lastReturnFromResetAt = mark.resetAt;
      r.lastLimitAt = 0;
      this.deps.setMark(terminalId, null);
      this.deps.setDefaultChange(null); // `/model <primary>` saved the primary as the default again
      this.deps.notify({ kind: 'returned', terminalId, primary: mark.primary, fallback: mark.model });
    } finally {
      r.busy = false;
    }
  }

  private idleForInput(terminalId: string): boolean {
    if (this.deps.isReplaying(terminalId) || this.deps.hasPendingInput(terminalId)) return false;
    const state = this.deps.agentState(terminalId);
    return state === 'idle' || state === 'done';
  }

  /**
   * Our `/model <fallback>` left Claude Code's default on the fallback. After the reset, when no
   * tab is still marked, type `/model <primary>` once in an idle Claude tab nobody chose a model
   * for; with no such tab, tell the person once.
   */
  async maybeRestoreDefault(markedIds: string[]): Promise<void> {
    const dc = this.deps.getDefaultChange();
    if (!dc || this.restoringDefault || markedIds.length > 0) return;
    const now = this.deps.now();
    if (dc.resetAt !== null && now < dc.resetAt) return;
    if (dc.resetAt === null) {
      let usage: UsageEntry[] = [];
      try { usage = await this.deps.readUsage(); } catch { usage = []; }
      const entry = usageEntryFor(usage, dc.primary);
      if (!entry || entry.pct >= 100) return;
    }
    const settings = this.deps.settings();
    const target = this.deps.tabIds().find((id) => {
      const tab = this.deps.tab(id);
      const r = this.tabs.get(id);
      return settings.enabled && !!tab?.isClaude && !tab.personModel && !r?.humanChose && !r?.busy && this.idleForInput(id);
    });
    if (!target) {
      if (!dc.toldPerson) {
        this.deps.setDefaultChange({ ...dc, toldPerson: true });
        this.deps.notify({ kind: 'default-left', terminalId: '', primary: dc.primary, fallback: dc.fallback });
      }
      return;
    }
    this.restoringDefault = true;
    try {
      const res = await this.switchModel(target, dc.primary);
      if (res.ok) {
        this.deps.setDefaultChange(null);
        this.deps.notify({ kind: 'default-restored', terminalId: target, primary: dc.primary, fallback: dc.fallback });
      }
    } finally {
      this.restoringDefault = false;
    }
  }
}
