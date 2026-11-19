import { describe, expect, it } from 'vitest';
import type { AgentTabState } from './programStatus';
import {
  LIMIT_DEDUPE_MS,
  MIN_SWITCH_GAP_MS,
  ModelLimitController,
  REHIT_RETRY_MS,
  UNCONFIRMED_BACKOFF_MS,
  chooseResetAt,
  decideLaunchModel,
  fallbackSettingsFrom,
  isPrimaryLimitMessage,
  modelDisplayName,
  parseLimitMessage,
  parseResetText,
  parseUsageFile,
  personChoseModel,
  sanitizeModelFallbackMark,
  usageEntryFor,
  type ControllerDeps,
  type DefaultChange,
  type FallbackNotice,
  type ModelFallbackMark,
  type UsageEntry,
} from './modelLimitFallback';

// Measured with Claude Code 2.1.325 (OSC 7501 error msg and StopFailure last_assistant_message).
const REAL = "You've hit your Fable limit · resets Nov 21 at 12pm (Asia/Seoul)";
const NOW = Date.parse('2026-11-19T04:30:00Z'); // 13:30 in Seoul
const RESET_SEOUL_NOON = Date.parse('2026-11-21T03:00:00Z');
const USAGE_RAW = '[{"name":"Fable","pct":100,"resets_at":"2026-11-21T02:59:59.825496+00:00"}]';

describe('modelDisplayName', () => {
  it('should_derive_the_name_claude_code_prints', () => {
    expect(modelDisplayName('claude-fable-5-2')).toBe('Fable');
    expect(modelDisplayName('opus')).toBe('Opus');
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus');
    expect(modelDisplayName('sonnet[1m]')).toBe('Sonnet');
  });
});

describe('parseLimitMessage', () => {
  it('should_parse_the_real_message', () => {
    expect(parseLimitMessage(REAL)).toEqual({ model: 'Fable', resetText: 'Nov 21 at 12pm (Asia/Seoul)' });
  });

  it('should_tolerate_separators_quotes_and_spacing', () => {
    for (const msg of [
      'You’ve hit your Fable limit · resets 3pm (Asia/Seoul)',
      "You've hit your Fable limit - resets Nov 21 at 12pm",
      "You've hit your Fable limit • resets 9:30am (America/New_York)",
      "You've hit your Fable limit | resets Nov 21, 12pm (Asia/Seoul)",
      "  You've  hit your   Fable limit   ·   resets Nov 21 at 12pm (Asia/Seoul) ",
      "You've hit your Fable 5.2 limit · resets Nov 21 at 12pm (Asia/Seoul)",
    ]) {
      expect(isPrimaryLimitMessage(msg, 'claude-fable-5-2'), msg).not.toBeNull();
    }
    expect(parseLimitMessage("You've hit your Fable limit")).toEqual({ model: 'Fable', resetText: undefined });
  });

  it('should_reject_other_models_and_unnamed_limits', () => {
    expect(isPrimaryLimitMessage("You've hit your Opus limit · resets Nov 21 at 12pm (Asia/Seoul)", 'claude-fable-5-2')).toBeNull();
    expect(parseLimitMessage("You've hit your limit · resets 3pm (Asia/Seoul)")).toBeNull();
    expect(parseLimitMessage("You've hit your weekly limit · resets Nov 21")).toBeNull();
    expect(parseLimitMessage("You've used 86% of your weekly limit · resets Nov 21 at 12pm (Asia/Seoul)")).toBeNull();
    expect(parseLimitMessage('API Error: 500')).toBeNull();
    expect(parseLimitMessage(undefined)).toBeNull();
  });
});

describe('parseResetText', () => {
  it('should_read_month_day_and_zone', () => {
    expect(parseResetText('Nov 21 at 12pm (Asia/Seoul)', NOW)).toBe(RESET_SEOUL_NOON);
    expect(parseResetText('Nov 21, 12:30pm (Asia/Seoul)', NOW)).toBe(RESET_SEOUL_NOON + 30 * 60_000);
    expect(parseResetText('Nov 21, 2026 at 12am (UTC)', NOW)).toBe(Date.parse('2026-11-21T00:00:00Z'));
  });

  it('should_take_the_next_time_of_day_when_no_date', () => {
    // 13:30 Seoul now: 3pm is today, 9am is tomorrow.
    expect(parseResetText('3pm (Asia/Seoul)', NOW)).toBe(Date.parse('2026-11-19T06:00:00Z'));
    expect(parseResetText('9am (Asia/Seoul)', NOW)).toBe(Date.parse('2026-11-20T00:00:00Z'));
    expect(parseResetText('14:00 (UTC)', NOW)).toBe(Date.parse('2026-11-19T14:00:00Z'));
  });

  it('should_roll_a_past_date_into_next_year', () => {
    expect(parseResetText('Jan 2 at 1am (UTC)', NOW)).toBe(Date.parse('2027-01-02T01:00:00Z'));
  });

  it('should_not_push_a_stale_date_a_year_ahead', () => {
    expect(parseResetText('Nov 17 at 1am (UTC)', NOW)).toBeNull();
    expect(parseResetText('Nov 19 at 1am (UTC)', NOW)).toBe(Date.parse('2026-11-19T01:00:00Z'));
  });

  it('should_reject_unreadable_text', () => {
    expect(parseResetText('soon', NOW)).toBeNull();
    expect(parseResetText('Nov 21 at 12 (Asia/Seoul)', NOW)).toBeNull();
    expect(parseResetText('13pm', NOW)).toBeNull();
    expect(parseResetText('3pm (Not/AZone)', NOW)).toBeNull();
  });
});

describe('usage file and reset choice', () => {
  it('should_parse_the_status_line_file', () => {
    const entries = parseUsageFile(USAGE_RAW);
    expect(entries).toEqual([{ name: 'Fable', pct: 100, resetsAt: Date.parse('2026-11-21T02:59:59.825Z') }]);
    expect(usageEntryFor(entries, 'claude-fable-5-2')?.pct).toBe(100);
    expect(usageEntryFor(entries, 'opus')).toBeNull();
    expect(parseUsageFile('not json')).toEqual([]);
    expect(parseUsageFile('')).toEqual([]);
  });

  it('should_prefer_the_usage_file_then_the_message', () => {
    const usage = usageEntryFor(parseUsageFile(USAGE_RAW), 'claude-fable-5-2');
    expect(chooseResetAt({ usage, resetText: 'Nov 22 at 1am (UTC)', now: NOW })).toEqual({ resetAt: usage!.resetsAt, source: 'usage' });
    expect(chooseResetAt({ usage: null, resetText: 'Nov 21 at 12pm (Asia/Seoul)', now: NOW })).toEqual({ resetAt: RESET_SEOUL_NOON, source: 'message' });
    // A stale file entry (reset already past) is ignored.
    const stale: UsageEntry = { name: 'Fable', pct: 100, resetsAt: NOW - 1000 };
    expect(chooseResetAt({ usage: stale, resetText: 'Nov 21 at 12pm (Asia/Seoul)', now: NOW }).source).toBe('message');
    expect(chooseResetAt({ usage: null, resetText: undefined, now: NOW })).toEqual({ resetAt: null, source: null });
  });

  it('should_not_reuse_the_reset_a_tab_just_returned_on', () => {
    const r = chooseResetAt({ usage: null, resetText: 'Nov 21 at 12pm (Asia/Seoul)', now: NOW, previousResetAt: RESET_SEOUL_NOON });
    expect(r).toEqual({ resetAt: NOW + REHIT_RETRY_MS, source: 'retry' });
    const later = chooseResetAt({ usage: null, resetText: 'Nov 28 at 12pm (Asia/Seoul)', now: NOW, previousResetAt: RESET_SEOUL_NOON });
    expect(later.source).toBe('message');
  });
});

describe('settings, marks and launch decision', () => {
  const settings = fallbackSettingsFrom({ claudeLimitFallback: true });
  const limited = parseUsageFile(USAGE_RAW);

  it('should_default_to_fable_and_opus', () => {
    expect(fallbackSettingsFrom(undefined)).toEqual({ enabled: false, primaryModel: 'claude-fable-5-2', fallbackModel: 'opus', usageFile: '~/.claude/logs/model-usage.json' });
    expect(fallbackSettingsFrom({ claudeLimitUsageFile: '' }).usageFile).toBe('');
  });

  it('should_see_a_person_chosen_model', () => {
    expect(personChoseModel('opus', [])).toBe(true);
    expect(personChoseModel('', ['--model', 'sonnet'])).toBe(true);
    expect(personChoseModel(undefined, ['--model=sonnet'])).toBe(true);
    expect(personChoseModel('', ['--verbose'])).toBe(false);
  });

  it('should_start_on_the_fallback_only_when_the_file_says_limited', () => {
    expect(decideLaunchModel({ settings, personModel: false, mark: undefined, usage: limited, now: NOW })).toEqual({
      model: 'opus',
      mark: { model: 'opus', primary: 'claude-fable-5-2', resetAt: limited[0].resetsAt, switchedAt: NOW },
    });
    expect(decideLaunchModel({ settings, personModel: false, mark: undefined, usage: [], now: NOW })).toEqual({});
    expect(decideLaunchModel({ settings, personModel: false, mark: undefined, usage: [{ name: 'Fable', pct: 99, resetsAt: NOW + 1 }], now: NOW })).toEqual({});
    expect(decideLaunchModel({ settings, personModel: true, mark: undefined, usage: limited, now: NOW })).toEqual({});
    expect(decideLaunchModel({ settings: { ...settings, enabled: false }, personModel: false, mark: undefined, usage: limited, now: NOW })).toEqual({});
  });

  it('should_keep_or_drop_a_mark_at_launch', () => {
    const mark: ModelFallbackMark = { model: 'opus', primary: 'claude-fable-5-2', resetAt: RESET_SEOUL_NOON, switchedAt: NOW - 1000 };
    expect(decideLaunchModel({ settings, personModel: false, mark, usage: [], now: NOW })).toEqual({ model: 'opus' });
    expect(decideLaunchModel({ settings, personModel: false, mark, usage: [], now: RESET_SEOUL_NOON + 1 })).toEqual({ model: 'claude-fable-5-2', mark: null });
  });

  it('should_sanitize_a_stored_mark', () => {
    expect(sanitizeModelFallbackMark({ model: 'opus', primary: 'claude-fable-5-2', resetAt: 5, switchedAt: 1 })).toEqual({ model: 'opus', primary: 'claude-fable-5-2', resetAt: 5, switchedAt: 1 });
    expect(sanitizeModelFallbackMark({ model: 'opus; rm -rf', primary: 'x', resetAt: null, switchedAt: 1 })).toBeUndefined();
    expect(sanitizeModelFallbackMark({ model: 'opus', primary: 'x', resetAt: null, switchedAt: 0 })).toBeUndefined();
    expect(sanitizeModelFallbackMark(null)).toBeUndefined();
  });
});

// ── State machine ────────────────────────────────────────────────

interface Harness {
  ctl: ModelLimitController;
  sent: Array<{ text: string; submit: boolean; closeLimitDialog?: boolean; at: number }>;
  notices: FallbackNotice[];
  marks: Map<string, ModelFallbackMark>;
  state: { agent: AgentTabState | undefined; replaying: boolean; screen: string; now: number; usage: UsageEntry[]; tab: { isClaude: boolean; personModel: boolean; sessionId?: () => string | undefined }; pending: boolean; humanAt: number; defaultChange: DefaultChange | null; onSend?: (text: string) => void };
}

function harness(opts: { dialog?: boolean; confirm?: boolean; enabled?: boolean } = {}): Harness {
  const dialog = opts.dialog !== false;
  const confirm = opts.confirm !== false;
  const sent: Harness['sent'] = [];
  const notices: FallbackNotice[] = [];
  const marks = new Map<string, ModelFallbackMark>();
  const state: Harness['state'] = { agent: 'done', replaying: false, screen: '', now: NOW, usage: [], tab: { isClaude: true, personModel: false }, pending: false, humanAt: 0, defaultChange: null };
  const deps: ControllerDeps = {
    now: () => state.now,
    sleep: async (ms) => { state.now += ms; },
    settings: () => fallbackSettingsFrom({ claudeLimitFallback: opts.enabled !== false }),
    tab: () => state.tab,
    tabIds: () => ['t1', 't2'],
    hasPendingInput: () => state.pending,
    lastHumanInputAt: () => state.humanAt,
    getDefaultChange: () => state.defaultChange,
    setDefaultChange: (c) => { state.defaultChange = c; },
    agentState: () => state.agent,
    isReplaying: () => state.replaying,
    send: async (_id, text, o) => {
      sent.push({ text, submit: o.submit, closeLimitDialog: o.closeLimitDialog, at: state.now });
      state.onSend?.(text);
      if (state.agent === 'blocked' && !o.closeLimitDialog) return { ok: false, reason: 'blocked' };
      if (text === '\x1b' && state.agent === 'blocked') state.agent = 'idle';
      const m = /^\/model (\S+)$/.exec(text);
      if (m && confirm) state.screen += `\n⎿ Set model to ${modelDisplayName(m[1])} 5.x and saved as your default`;
      if (text === 'Continue' || text === '이어서 진행해줘') state.agent = 'working';
      return { ok: true };
    },
    screenText: () => state.screen,
    readUsage: async () => state.usage,
    getMark: (id) => marks.get(id),
    setMark: (id, mark) => { if (mark) marks.set(id, mark); else marks.delete(id); },
    notify: (n) => notices.push(n),
    locale: () => 'en',
  };
  const ctl = new ModelLimitController(deps);
  // The real order: error report, then the dialog opens (blocked).
  if (dialog) {
    const orig = ctl.onStatusReport.bind(ctl);
    ctl.onStatusReport = (id, report, replaying) => {
      const p = orig(id, report, replaying);
      if (report.state === 'error' && !replaying) state.agent = 'blocked';
      return p;
    };
  }
  return { ctl, sent, notices, marks, state };
}

const errorReport = { state: 'error', app: 'claude-code', msg: REAL };

describe('ModelLimitController: switch', () => {
  it('should_close_the_dialog_switch_confirm_mark_and_continue', async () => {
    const h = harness();
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((s) => s.text)).toEqual(['\x1b', '/model opus', 'Continue']);
    expect(h.sent[0]).toMatchObject({ submit: false, closeLimitDialog: true });
    expect(h.sent[1]).toMatchObject({ submit: true });
    expect(h.sent[1].closeLimitDialog).toBeUndefined();
    expect(h.marks.get('t1')).toMatchObject({ model: 'opus', primary: 'claude-fable-5-2', resetAt: RESET_SEOUL_NOON });
    expect(h.notices).toEqual([{ kind: 'switched', terminalId: 't1', primary: 'claude-fable-5-2', fallback: 'opus', resetAt: RESET_SEOUL_NOON }]);
  });

  it('should_use_the_usage_file_reset_time_when_present', async () => {
    const h = harness();
    h.state.usage = parseUsageFile(USAGE_RAW);
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.marks.get('t1')?.resetAt).toBe(Date.parse('2026-11-21T02:59:59.825Z'));
  });

  it('should_switch_without_esc_when_no_dialog_opens', async () => {
    const h = harness({ dialog: false });
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((s) => s.text)).toEqual(['/model opus', 'Continue']);
  });

  it('should_react_to_the_stop_failure_hook', async () => {
    const h = harness({ dialog: false });
    await h.ctl.onHookReport('t1', { error: 'rate_limit', message: REAL });
    expect(h.sent.map((s) => s.text)).toEqual(['/model opus', 'Continue']);
    const other = harness({ dialog: false });
    await other.ctl.onHookReport('t1', { error: 'rate_limit', message: "You've hit your Opus limit · resets 3pm" });
    await other.ctl.onHookReport('t1', { error: 'server_error', message: REAL });
    // Session and weekly limits apply to the fallback too: never switch on them.
    await other.ctl.onHookReport('t1', { error: 'rate_limit', message: "You've hit your limit · resets 3pm (Asia/Seoul)" });
    await other.ctl.onHookReport('t1', { error: 'rate_limit', message: "You've hit your weekly limit · resets Nov 21 at 12pm (Asia/Seoul)" });
    await other.ctl.onHookReport('t1', { error: 'rate_limit', message: 'Rate limited, try again later' });
    expect(other.sent).toEqual([]);
    // An empty message takes the nameless path.
    await other.ctl.onHookReport('t1', { error: 'rate_limit', message: '' });
    expect(other.sent.map((x) => x.text)).toEqual(['/model opus', 'Continue']);
  });

  it('should_ignore_a_hook_report_for_another_session', async () => {
    const h = harness({ dialog: false });
    h.state.tab = { isClaude: true, personModel: false, sessionId: () => '0f4b2c1e-7d3a-4c5b-9e8f-1a2b3c4d5e6f' };
    await h.ctl.onHookReport('t1', { error: 'rate_limit', message: REAL, sessionId: '264af8d3-db3b-4f8e-818f-7414907e0c7b' });
    expect(h.sent).toEqual([]);
    await h.ctl.onHookReport('t1', { error: 'rate_limit', message: REAL, sessionId: '0F4B2C1E-7d3a-4c5b-9e8f-1a2b3c4d5e6f' });
    expect(h.sent.map((x) => x.text)).toEqual(['/model opus', 'Continue']);
  });

  it('should_handle_duplicate_events_once', async () => {
    const h = harness();
    const a = h.ctl.onStatusReport('t1', errorReport, false);
    const b = h.ctl.onHookReport('t1', { error: 'rate_limit', message: REAL });
    await Promise.all([a, b]);
    // Claude Code repeats the error report after Esc; the hook follows too.
    await h.ctl.onStatusReport('t1', errorReport, false);
    await h.ctl.onHookReport('t1', { error: 'rate_limit', message: REAL });
    expect(h.sent.filter((s) => s.text === '/model opus')).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
  });

  it('should_ignore_replayed_output_plain_screen_text_and_other_tabs', async () => {
    const h = harness();
    await h.ctl.onStatusReport('t1', errorReport, true);
    h.state.screen = REAL; // a pasted copy on screen is never read as an event
    await h.ctl.onStatusReport('t1', { state: 'working', app: 'claude-code', msg: REAL }, false);
    await h.ctl.onStatusReport('t1', { ...errorReport, app: 'codex' }, false);
    h.state.tab = { isClaude: false, personModel: false };
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent).toEqual([]);
  });

  it('should_leave_tabs_where_a_person_chose_the_model', async () => {
    const flagged = harness();
    flagged.state.tab = { isClaude: true, personModel: true };
    await flagged.ctl.onStatusReport('t1', errorReport, false);
    expect(flagged.sent).toEqual([]);

    const human = harness();
    human.ctl.onHumanCommand('t1', '/model sonnet');
    await human.ctl.onStatusReport('t1', errorReport, false);
    expect(human.sent).toEqual([]);

    const off = harness({ enabled: false });
    await off.ctl.onStatusReport('t1', errorReport, false);
    expect(off.sent).toEqual([]);
  });

  it('should_switch_again_after_the_person_releases_a_typed_choice', async () => {
    const h = harness();
    h.ctl.onHumanCommand('t1', '/model sonnet');
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent).toEqual([]);
    expect(h.ctl.releaseHumanChoice('t1')).toBe(true);
    expect(h.sent).toEqual([]); // releasing types nothing
    h.state.agent = 'done';
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((x) => x.text)).toEqual(['\x1b', '/model opus', 'Continue']);
    expect(h.ctl.releaseHumanChoice('t1')).toBe(false);
  });

  it('should_drop_the_mark_when_a_person_runs_model', async () => {
    const h = harness();
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.marks.has('t1')).toBe(true);
    h.ctl.onHumanCommand('t1', 'hello /model');
    expect(h.marks.has('t1')).toBe(true);
    h.ctl.onHumanCommand('t1', '/model');
    expect(h.marks.has('t1')).toBe(false);
  });

  it('should_mark_an_unconfirmed_switch_without_continue_and_back_off', async () => {
    const h = harness({ confirm: false });
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((s) => s.text)).toEqual(['\x1b', '/model opus']);
    expect(h.marks.get('t1')).toMatchObject({ model: 'opus', unconfirmed: true });
    expect(h.notices[0]).toMatchObject({ kind: 'failed', reason: 'not-confirmed' });
    expect(h.state.defaultChange).toMatchObject({ primary: 'claude-fable-5-2', fallback: 'opus' });
    // A new limit 5 minutes later does not re-type /model.
    h.sent.length = 0;
    h.state.now += 5 * 60_000;
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent).toEqual([]);
    // After the back-off it tries again, and gives up after 3 tries.
    for (let i = 0; i < 4; i++) {
      h.state.now += UNCONFIRMED_BACKOFF_MS + 1000;
      await h.ctl.onStatusReport('t1', errorReport, false);
    }
    expect(h.sent.filter((x) => x.text === '/model opus')).toHaveLength(2);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'gave-up' });
  });

  it('should_wait_for_a_half_typed_prompt_and_give_up_if_it_stays', async () => {
    const h = harness();
    h.state.pending = true;
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((x) => x.text)).toEqual(['\x1b']);
    expect(h.notices[0]).toMatchObject({ kind: 'failed', reason: 'typing' });
    expect(h.marks.size).toBe(0);
  });

  it('should_stop_when_the_person_types_or_closes_the_dialog_after_the_limit', async () => {
    const typed = harness();
    typed.state.onSend = (text) => { if (text === '\x1b') typed.state.humanAt = typed.state.now + 1; };
    await typed.ctl.onStatusReport('t1', errorReport, false);
    expect(typed.sent.map((x) => x.text)).toEqual(['\x1b']);
    expect(typed.notices[0]).toMatchObject({ kind: 'failed', reason: 'human' });

    const closed = harness();
    (closed.ctl as any).deps.send = async (_id: string, text: string) => {
      closed.sent.push({ text, submit: false, at: 0 });
      return text === '\x1b' ? { ok: false, reason: 'not-blocked' } : { ok: true };
    };
    await closed.ctl.onStatusReport('t1', errorReport, false);
    expect(closed.sent.map((x) => x.text)).toEqual(['\x1b']);
    expect(closed.notices[0]).toMatchObject({ kind: 'failed', reason: 'dialog' });
  });

  it('should_abort_before_continue_when_the_person_runs_a_model_command', async () => {
    const h = harness();
    h.state.onSend = (text) => { if (text === '/model opus') h.ctl.onHumanCommand('t1', '/mo'); };
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((x) => x.text)).toEqual(['\x1b', '/model opus']);
    expect(h.marks.has('t1')).toBe(false);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'human' });
  });

  it('should_continue_in_korean_for_the_korean_ui', async () => {
    const h = harness();
    (h.ctl as any).deps.locale = () => 'ko';
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.at(-1)?.text).toBe('이어서 진행해줘');
  });
});

describe('ModelLimitController: return', () => {
  async function switched() {
    const h = harness();
    await h.ctl.onStatusReport('t1', errorReport, false);
    h.state.agent = 'done';
    h.sent.length = 0;
    h.notices.length = 0;
    return h;
  }

  it('should_wait_for_the_reset_then_return_when_idle', async () => {
    const h = await switched();
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
    h.state.now = RESET_SEOUL_NOON + 1000;
    h.state.agent = 'working';
    await h.ctl.maybeReturn('t1');
    h.state.agent = 'blocked';
    await h.ctl.maybeReturn('t1');
    h.state.agent = 'done';
    h.state.replaying = true;
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
    h.state.replaying = false;
    await h.ctl.maybeReturn('t1');
    expect(h.sent.map((s) => s.text)).toEqual(['/model claude-fable-5-2']);
    expect(h.marks.has('t1')).toBe(false);
    expect(h.notices).toEqual([{ kind: 'returned', terminalId: 't1', primary: 'claude-fable-5-2', fallback: 'opus' }]);
  });

  it('should_wait_when_the_usage_file_shows_a_later_reset', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    const later = RESET_SEOUL_NOON + 5 * 3600_000;
    h.state.usage = [{ name: 'Fable', pct: 100, resetsAt: later }];
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
    expect(h.marks.get('t1')?.resetAt).toBe(later);
  });

  it('should_keep_a_minimum_gap_after_the_switch', async () => {
    const h = harness();
    h.state.usage = [{ name: 'Fable', pct: 100, resetsAt: NOW + 60_000 }];
    await h.ctl.onStatusReport('t1', errorReport, false);
    h.state.agent = 'done';
    h.state.usage = [];
    h.sent.length = 0;
    h.state.now = NOW + 2 * 60_000; // reset passed, gap not
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
    h.state.now = h.marks.get('t1')!.switchedAt + MIN_SWITCH_GAP_MS;
    await h.ctl.maybeReturn('t1');
    expect(h.sent.map((s) => s.text)).toEqual(['/model claude-fable-5-2']);
  });

  it('should_switch_again_on_a_re_hit_with_a_new_reset_not_the_old_one', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    await h.ctl.maybeReturn('t1');
    expect(h.marks.has('t1')).toBe(false);
    h.sent.length = 0;
    // The first answer after returning hits the limit again with the same reset text.
    h.state.now += 5000;
    const reHitAt = h.state.now;
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.map((s) => s.text)).toEqual(['\x1b', '/model opus', 'Continue']);
    const mark = h.marks.get('t1')!;
    expect(mark.resetAt).toBeGreaterThanOrEqual(reHitAt + REHIT_RETRY_MS);
    // Not flipped back on the old reset time.
    h.state.agent = 'done';
    h.sent.length = 0;
    h.state.now = reHitAt + MIN_SWITCH_GAP_MS + 1000;
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
  });

  it('should_retry_detection_later_within_the_dedupe_window_only_once', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    await h.ctl.maybeReturn('t1');
    h.sent.length = 0;
    await h.ctl.onStatusReport('t1', errorReport, false);
    h.state.agent = 'done';
    await h.ctl.onStatusReport('t1', errorReport, false);
    expect(h.sent.filter((s) => s.text === '/model opus')).toHaveLength(1);
    expect(LIMIT_DEDUPE_MS).toBeLessThan(MIN_SWITCH_GAP_MS);
  });

  it('should_not_return_while_a_prompt_is_half_typed', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    h.state.pending = true;
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
    h.state.pending = false;
    await h.ctl.maybeReturn('t1');
    expect(h.sent.map((x) => x.text)).toEqual(['/model claude-fable-5-2']);
    expect(h.state.defaultChange).toBeNull();
  });

  it('should_restore_the_default_model_in_an_idle_tab_after_the_reset_or_tell_the_person', async () => {
    const h = await switched();
    h.marks.clear(); // e.g. the marked tab was closed
    expect(h.state.defaultChange).not.toBeNull();
    await h.ctl.maybeRestoreDefault([]);
    expect(h.sent).toEqual([]); // reset not reached
    h.state.now = RESET_SEOUL_NOON + 1000;
    await h.ctl.maybeRestoreDefault(['t1']);
    expect(h.sent).toEqual([]); // a tab is still marked: its own return restores it
    h.state.agent = 'working';
    await h.ctl.maybeRestoreDefault([]);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'default-left' });
    await h.ctl.maybeRestoreDefault([]);
    expect(h.notices.filter((n) => n.kind === 'default-left')).toHaveLength(1);
    h.state.agent = 'idle';
    await h.ctl.maybeRestoreDefault([]);
    expect(h.sent.map((x) => x.text)).toEqual(['/model claude-fable-5-2']);
    expect(h.state.defaultChange).toBeNull();
    expect(h.notices.at(-1)).toMatchObject({ kind: 'default-restored' });
  });

  it('should_give_up_returning_after_three_unconfirmed_tries', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    (h.ctl as any).deps.screenText = () => '';
    for (let i = 0; i < 3; i++) {
      await h.ctl.maybeReturn('t1');
      h.state.now += UNCONFIRMED_BACKOFF_MS;
    }
    expect(h.sent.filter((x) => x.text === '/model claude-fable-5-2')).toHaveLength(3);
    expect(h.marks.has('t1')).toBe(false);
    expect(h.notices.at(-1)).toMatchObject({ kind: 'failed', reason: 'return-gave-up' });
  });

  it('should_back_off_when_the_return_is_not_confirmed', async () => {
    const h = await switched();
    h.state.now = RESET_SEOUL_NOON + 1000;
    (h.ctl as any).deps.screenText = () => '';
    await h.ctl.maybeReturn('t1');
    expect(h.marks.has('t1')).toBe(true);
    h.sent.length = 0;
    h.state.now += 60_000;
    await h.ctl.maybeReturn('t1');
    expect(h.sent).toEqual([]);
  });
});
