// Runtime wiring for the model limit fallback (logic: ./modelLimitFallback.ts).
// XTerminal registers Claude tabs and feeds OSC 7501 reports; App feeds StopFailure hook
// reports, keeps the persisted marks in sync and shows the notices. One module-level timer
// checks marked tabs for the return (no per-render intervals). docs/MODEL_LIMIT_FALLBACK.md
import { invoke } from '@tauri-apps/api/core';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { getConfigSnapshot } from '../config/ConfigContext';
import { getTranslation, type Locale } from '../i18n';
import { lastHumanInputAt, queueAutoInput } from './inputGate';
import { hasPendingInput, subscribeCommittedCommands } from './lastCommand';
import {
  ModelLimitController,
  decideLaunchModel,
  fallbackSettingsFrom,
  modelDisplayName,
  parseUsageFile,
  type DefaultChange,
  type FailReason,
  type FallbackNotice,
  type LaunchDecision,
  type FallbackSettings,
  type ModelFallbackMark,
  type TabInfo,
  type UsageEntry,
} from './modelLimitFallback';
import { parseProgramStatus, type AgentTabState } from './programStatus';

export const MODEL_FALLBACK_EVENT = 'octo-model-fallback';
export const CLAUDE_LIMIT_REPORTED_EVENT = 'claude-limit-reported';
/** Tauri event (all windows): a tab's mark changed; the main window stores it on the terminal. */
export const MODEL_FALLBACK_MARK_EVENT = 'model-fallback-mark';
const DEFAULT_CHANGE_KEY = 'bbarit.modelFallback.defaultChange';
const TICK_MS = 30_000;
const USAGE_CACHE_MS = 20_000;

/** Event detail: a mark change (persist it) and/or a notice (show it). */
export interface ModelFallbackEventDetail {
  terminalId: string;
  /** Present when the mark changed: the new mark, or null when cleared. */
  mark?: ModelFallbackMark | null;
  notice?: FallbackNotice;
  /** Localized notice text. */
  text?: string;
}

/** StopFailure hook report re-emitted by the bridge (POST /api/claude-limit). */
export interface ClaudeLimitReport {
  terminalId: string;
  sessionId?: string;
  error: string;
  message?: string;
}

export interface ModelLimitHost {
  getAgentState(terminalId: string): AgentTabState | undefined;
  isReplaying(terminalId: string): boolean;
  /** Last rows of the terminal buffer as text. */
  screenText(terminalId: string): string;
}

let host: ModelLimitHost | null = null;
const tabs = new Map<string, TabInfo>();
const marks = new Map<string, ModelFallbackMark>();
/** Tabs whose mark this window changed: a projects sync never overrides them. */
const touched = new Set<string>();
let usageCache: { at: number; path: string; entries: UsageEntry[] } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function setModelLimitHost(next: ModelLimitHost | null): void { host = next; }

export function fallbackSettings(): FallbackSettings {
  return fallbackSettingsFrom(getConfigSnapshot()?.agent as any);
}

function uiLocale(): Locale {
  const lang = getConfigSnapshot()?.language as Locale | undefined;
  return lang || 'en';
}

/** `{a}` placeholders. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function formatResetTime(resetAt: number | null, locale: string): string {
  if (resetAt === null) return getTranslation(locale as Locale, 'modelFallback.resetUnknown');
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(resetAt));
  } catch {
    return new Date(resetAt).toLocaleString();
  }
}

export function noticeText(notice: FallbackNotice, locale: Locale): string {
  const vars = { primary: modelDisplayName(notice.primary), fallback: modelDisplayName(notice.fallback), primaryId: notice.primary };
  switch (notice.kind) {
    case 'switched':
      return fillTemplate(getTranslation(locale, 'modelFallback.toast.switched'), { ...vars, reset: formatResetTime(notice.resetAt, locale) });
    case 'returned':
      return fillTemplate(getTranslation(locale, 'modelFallback.toast.returned'), vars);
    case 'default-restored':
      return fillTemplate(getTranslation(locale, 'modelFallback.toast.defaultRestored'), vars);
    case 'default-left':
      return fillTemplate(getTranslation(locale, 'modelFallback.toast.defaultLeft'), vars);
    case 'released':
      return getTranslation(locale, 'modelFallback.toast.released' as any);
    default:
      return fillTemplate(getTranslation(locale, 'modelFallback.toast.failed'), { ...vars, reason: fillTemplate(failReasonText(notice.reason, locale), vars) });
  }
}

const REASON_KEYS: Record<FailReason, string> = {
  typing: 'modelFallback.reason.typing',
  human: 'modelFallback.reason.human',
  dialog: 'modelFallback.reason.dialog',
  'not-confirmed': 'modelFallback.reason.notConfirmed',
  'gave-up': 'modelFallback.reason.gaveUp',
  'return-gave-up': 'modelFallback.reason.returnGaveUp',
  blocked: 'modelFallback.reason.dialog',
  other: 'modelFallback.reason.other',
};

export function failReasonText(reason: FailReason, locale: Locale): string {
  return getTranslation(locale, (REASON_KEYS[reason] || REASON_KEYS.other) as any);
}

function emit(detail: ModelFallbackEventDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MODEL_FALLBACK_EVENT, { detail }));
}

/** The user's usage file (written by their status line; the app only reads it). */
export async function readUsageEntries(): Promise<UsageEntry[]> {
  const path = fallbackSettings().usageFile;
  if (!path) return [];
  const now = Date.now();
  if (usageCache && usageCache.path === path && now - usageCache.at < USAGE_CACHE_MS) return usageCache.entries;
  let entries: UsageEntry[] = [];
  try {
    entries = parseUsageFile(await invoke<string>('read_usage_file', { path }));
  } catch { entries = []; }
  usageCache = { at: now, path, entries };
  return entries;
}

function setMark(terminalId: string, mark: ModelFallbackMark | null): void {
  if (mark) marks.set(terminalId, mark); else marks.delete(terminalId);
  touched.add(terminalId);
  // Every window gets it; only the main window (which persists tabs) stores it.
  void Promise.resolve().then(() => tauriEmit(MODEL_FALLBACK_MARK_EVENT, { terminalId, mark })).catch(() => emit({ terminalId, mark }));
  syncTimer();
}

let defaultChange: DefaultChange | null = (() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DEFAULT_CHANGE_KEY) : null;
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.primary === 'string' && typeof v.fallback === 'string' ? v as DefaultChange : null;
  } catch { return null; }
})();

function setDefaultChange(next: DefaultChange | null): void {
  defaultChange = next;
  try {
    if (next) localStorage.setItem(DEFAULT_CHANGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(DEFAULT_CHANGE_KEY);
  } catch { /* per-window convenience only */ }
  syncTimer();
}

const controller = new ModelLimitController({
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  settings: fallbackSettings,
  tab: (id) => tabs.get(id),
  tabIds: () => [...tabs.keys()],
  hasPendingInput: (id) => hasPendingInput(id),
  lastHumanInputAt: (id) => lastHumanInputAt(id),
  getDefaultChange: () => defaultChange,
  setDefaultChange,
  agentState: (id) => host?.getAgentState(id),
  isReplaying: (id) => !!host?.isReplaying(id),
  send: async (id, text, opts) => {
    const res = await queueAutoInput(id, text, { source: 'model-fallback', submit: opts.submit, closeLimitDialog: opts.closeLimitDialog });
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  },
  screenText: (id) => host?.screenText(id) ?? '',
  readUsage: readUsageEntries,
  getMark: (id) => marks.get(id),
  setMark,
  notify: (notice) => emit({ terminalId: notice.terminalId, notice, text: noticeText(notice, uiLocale()) }),
  locale: () => (uiLocale() === 'ko' ? 'ko' : 'en'),
});

const tabListeners = new Set<() => void>();
let tabVersion = 0;
function notifyTabs(): void { tabVersion++; tabListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

/** App: re-render tab icons when a tab registers or a person takes a tab's model over. */
export function subscribeModelLimitTabs(fn: () => void): () => void {
  tabListeners.add(fn);
  return () => { tabListeners.delete(fn); };
}
export function modelLimitTabsVersion(): number { return tabVersion; }

subscribeCommittedCommands((id, cmd) => {
  if (!tabs.has(id)) return;
  const before = controller.isHumanChosen(id);
  controller.onHumanCommand(id, cmd);
  if (controller.isHumanChosen(id) !== before) notifyTabs();
});

function syncTimer(): void {
  const need = (marks.size > 0 || defaultChange !== null) && tabs.size > 0;
  if (need && !timer) {
    timer = setInterval(() => {
      for (const id of marks.keys()) if (tabs.has(id)) void controller.maybeReturn(id).catch(() => {});
      void controller.maybeRestoreDefault([...marks.keys()].filter((id) => tabs.has(id))).catch(() => {});
    }, TICK_MS);
  } else if (!need && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** XTerminal: a mounted tab and whether the person set its model (modelId / --model flag). */
export function registerModelLimitTab(terminalId: string, info: TabInfo): () => void {
  tabs.set(terminalId, info);
  syncTimer();
  notifyTabs();
  return () => {
    if (tabs.get(terminalId) === info) tabs.delete(terminalId);
    controller.forget(terminalId);
    syncTimer();
    notifyTabs();
  };
}

/**
 * App: persisted marks of every terminal (restored with the tab after a restart). Tabs whose mark
 * this window changed keep the in-memory value, so a projects snapshot that has not caught up
 * (or a harness window's own copy) never clears or revives a mark.
 */
export function syncModelFallbackMarks(entries: Iterable<[string, ModelFallbackMark]>): void {
  const persisted = new Map(entries);
  for (const id of [...marks.keys()]) if (!touched.has(id) && !persisted.has(id)) marks.delete(id);
  for (const [id, mark] of persisted) if (!touched.has(id)) marks.set(id, mark);
  syncTimer();
}

export function modelFallbackMarkOf(terminalId: string): ModelFallbackMark | undefined {
  return marks.get(terminalId);
}

/** XTerminal OSC 7501 handler: the raw payload after `7501;`. */
export function noteModelLimitStatus(terminalId: string, data: string, replaying: boolean): void {
  if (!tabs.has(terminalId) || !data.startsWith('state=error')) return;
  const report = parseProgramStatus(data);
  if (!report || 'query' in report) return;
  void Promise.resolve(controller.onStatusReport(terminalId, report, replaying)).catch(() => {});
}

/** App: StopFailure hook report from the bridge. */
export function noteModelLimitHook(report: Partial<ClaudeLimitReport> | null | undefined): void {
  if (!report || typeof report.terminalId !== 'string' || !tabs.has(report.terminalId)) return;
  void Promise.resolve(controller.onHookReport(report.terminalId, { error: report.error, message: report.message, sessionId: report.sessionId })).catch(() => {});
}

/**
 * XTerminal launch: what a new startup command would use for a Claude tab the person gave no
 * model. Pure: nothing changes until applyLaunchDecision, which XTerminal calls only in the
 * branch that actually types the startup command (never on remount or PTY reattach).
 */
export async function claudeLaunchDecision(terminalId: string, personModel: boolean): Promise<LaunchDecision> {
  const settings = fallbackSettings();
  if (!settings.enabled || personModel) return {};
  const usage = await readUsageEntries().catch(() => [] as UsageEntry[]);
  return decideLaunchModel({ settings, personModel, mark: marks.get(terminalId), usage, now: Date.now() });
}

export function applyLaunchDecision(terminalId: string, decision: LaunchDecision): void {
  if (decision.mark !== undefined) setMark(terminalId, decision.mark);
  // A launch with --model does not change Claude Code's saved default; only /model does.
}

/** `human`: a typed `/mo…` (click releases it); `preset`: settings model or `--model` flag (change it there). */
export type ModelSwitchState = 'off' | 'on' | 'switched' | 'unconfirmed' | 'human' | 'preset';

export interface ModelSwitchIndicator { state: ModelSwitchState; tooltip: string }

/**
 * Tab icon state for a Claude tab: off (setting off), human (a person chose the model by settings,
 * flags or /model), switched / unconfirmed (marked by the app), on (watching for the limit).
 */
export function describeModelSwitch(input: {
  settings: FallbackSettings;
  personModel: boolean;
  humanChose: boolean;
  mark: ModelFallbackMark | null | undefined;
}, locale: Locale): ModelSwitchIndicator {
  const { settings, mark } = input;
  const vars = { primary: modelDisplayName(settings.primaryModel), fallback: modelDisplayName(settings.fallbackModel) };
  const tr = (key: string, extra: Record<string, string> = {}) => fillTemplate(getTranslation(locale, key as any), { ...vars, ...extra });
  if (!settings.enabled) return { state: 'off', tooltip: tr('modelSwitch.off') };
  if (input.personModel) return { state: 'preset', tooltip: tr('modelSwitch.preset') };
  if (input.humanChose) return { state: 'human', tooltip: tr('modelSwitch.human') };
  if (mark) {
    const reset = mark.resetAt === null ? getTranslation(locale, 'modelSwitch.resetUnknown' as any) : formatResetTime(mark.resetAt, locale);
    const markVars = { primary: modelDisplayName(mark.primary), fallback: modelDisplayName(mark.model), reset };
    return mark.unconfirmed
      ? { state: 'unconfirmed', tooltip: tr('modelSwitch.switchedUnconfirmed', markVars) }
      : { state: 'switched', tooltip: tr('modelSwitch.switched', markVars) };
  }
  return { state: 'on', tooltip: tr('modelSwitch.on') };
}

/**
 * Icon click on a `human` tab: hand it back to the app (no input, model unchanged) and toast.
 * Returns false when the tab is not in that state (settings/flag models are changed elsewhere).
 */
export function releaseHumanModelChoice(terminalId: string): boolean {
  if (!controller.releaseHumanChoice(terminalId)) return false;
  notifyTabs();
  const s = fallbackSettings();
  const notice: FallbackNotice = { kind: 'released', terminalId, primary: s.primaryModel, fallback: s.fallbackModel };
  emit({ terminalId, notice, text: noticeText(notice, uiLocale()) });
  return true;
}

/** The icon state for a terminal: the tab registered by XTerminal plus its persisted mark. */
export function modelSwitchIndicator(terminalId: string, mark: ModelFallbackMark | null | undefined, locale: Locale): ModelSwitchIndicator {
  const tab = tabs.get(terminalId);
  return describeModelSwitch({
    settings: fallbackSettings(),
    personModel: !!tab?.personModel,
    humanChose: controller.isHumanChosen(terminalId),
    mark: mark ?? marks.get(terminalId),
  }, locale);
}
