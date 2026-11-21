// Launch decision of the model limit fallback runtime: the decision is pure, and the mark only
// changes when XTerminal applies it in the branch that types a new startup command.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, emitMock, config } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  emitMock: vi.fn(async () => {}),
  config: { agent: { claudeLimitFallback: true } as Record<string, unknown>, language: 'en' },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ emit: emitMock }));
vi.mock('../config/ConfigContext', () => ({ getConfigSnapshot: () => config }));

import { MODEL_FALLBACK_EVENT, applyLaunchDecision, claudeLaunchDecision, describeModelSwitch, modelFallbackMarkOf, modelSwitchIndicator, noticeText, registerModelLimitTab, releaseHumanModelChoice, syncModelFallbackMarks } from './modelLimitRuntime';
import { feedTerminalInput, setLastCommandMode } from './lastCommand';
import * as inputGate from './inputGate';
import { fallbackSettingsFrom } from './modelLimitFallback';

const LIMITED = JSON.stringify([{ name: 'Fable', pct: 100, resets_at: new Date(Date.now() + 3600_000).toISOString() }]);

describe('model limit runtime: launch decision', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'read_usage_file' ? LIMITED : null));
    emitMock.mockClear();
  });

  it('should_not_mark_a_tab_until_the_startup_command_is_typed', async () => {
    const decision = await claudeLaunchDecision('fresh-tab', false);
    expect(decision.model).toBe('opus');
    expect(modelFallbackMarkOf('fresh-tab')).toBeUndefined(); // remount / reattach: nothing changes
    expect(invokeMock).toHaveBeenCalledWith('read_usage_file', { path: '~/.claude/logs/model-usage.json' });
    applyLaunchDecision('fresh-tab', decision); // the branch that types the command
    expect(modelFallbackMarkOf('fresh-tab')).toMatchObject({ model: 'opus', primary: 'claude-fable-5-2' });
    await Promise.resolve();
    await Promise.resolve();
    expect(emitMock).toHaveBeenCalledWith('model-fallback-mark', expect.objectContaining({ terminalId: 'fresh-tab' }));
  });

  it('should_leave_person_chosen_tabs_alone', async () => {
    expect(await claudeLaunchDecision('chosen-tab', true)).toEqual({});
  });

  it('should_keep_a_mark_this_window_set_when_the_projects_snapshot_lags', async () => {
    applyLaunchDecision('lag-tab', await claudeLaunchDecision('lag-tab', false));
    syncModelFallbackMarks([]);
    expect(modelFallbackMarkOf('lag-tab')).toBeDefined();
    syncModelFallbackMarks([['restored-tab', { model: 'opus', primary: 'claude-fable-5-2', resetAt: null, switchedAt: 1 }]]);
    expect(modelFallbackMarkOf('restored-tab')).toBeDefined();
  });

  it('should_fill_model_names_into_translated_failure_reasons', () => {
    expect(noticeText({ kind: 'failed', terminalId: 't', primary: 'claude-fable-5-2', fallback: 'opus', reason: 'return-gave-up' }, 'en'))
      .toBe('Could not switch to Opus (could not switch back to Fable; run /model claude-fable-5-2 yourself)');
  });
});

describe('model limit runtime: tab icon state', () => {
  const on = fallbackSettingsFrom({ claudeLimitFallback: true });
  const mark = { model: 'opus', primary: 'claude-fable-5-2', resetAt: Date.UTC(2026, 10, 21, 3), switchedAt: 1 };
  const base = { settings: on, personModel: false, humanChose: false, mark: undefined };

  it('should_map_each_state_to_its_tooltip_in_english', () => {
    expect(describeModelSwitch({ ...base, settings: fallbackSettingsFrom({}) }, 'en'))
      .toEqual({ state: 'off', tooltip: 'Auto model switch is off (Settings > Agent)' });
    expect(describeModelSwitch(base, 'en'))
      .toEqual({ state: 'on', tooltip: 'Auto switch on: switches to Opus when the Fable limit is hit' });
    expect(describeModelSwitch({ ...base, humanChose: true }, 'en'))
      .toEqual({ state: 'human', tooltip: 'Model chosen by you (/model): not switched automatically · click to return to auto' });
    expect(describeModelSwitch({ ...base, humanChose: true, mark }, 'en').state).toBe('human');
    // Settings model or --model flag: not releasable from the tab, the tooltip says where to change it.
    expect(describeModelSwitch({ ...base, personModel: true, humanChose: true }, 'en'))
      .toEqual({ state: 'preset', tooltip: 'Model set in Settings > Agent or a --model flag: not switched automatically (change it there)' });
    expect(describeModelSwitch({ ...base, humanChose: true }, 'ko').tooltip).toBe('직접 고른 모델(/model): 자동으로 바꾸지 않음 · 누르면 자동으로 되돌림');
    const switched = describeModelSwitch({ ...base, mark }, 'en');
    expect(switched.state).toBe('switched');
    expect(switched.tooltip).toMatch(/^Fable limit → switched to Opus · back after Nov 21/);
    expect(describeModelSwitch({ ...base, mark: { ...mark, resetAt: null } }, 'en').tooltip)
      .toBe('Fable limit → switched to Opus · back after reset time unknown');
    expect(describeModelSwitch({ ...base, mark: { ...mark, unconfirmed: true } }, 'en'))
      .toMatchObject({ state: 'unconfirmed', tooltip: expect.stringContaining('(unconfirmed)') });
  });

  it('should_use_configured_model_names_and_korean_strings', () => {
    const custom = fallbackSettingsFrom({ claudeLimitFallback: true, claudeLimitPrimaryModel: 'claude-opus-5-5', claudeLimitFallbackModel: 'sonnet' });
    expect(describeModelSwitch({ ...base, settings: custom }, 'en').tooltip).toBe('Auto switch on: switches to Sonnet when the Opus limit is hit');
    expect(describeModelSwitch({ ...base, settings: fallbackSettingsFrom({}) }, 'ko').tooltip).toBe('모델 자동 전환 꺼짐 (설정 > 에이전트)');
    expect(describeModelSwitch(base, 'ko').tooltip).toBe('자동 전환 켜짐: Fable 한도에 걸리면 Opus 로 전환');
  });
});

describe('model limit runtime: releasing a typed model choice', () => {
  it('should_release_only_the_typed_choice_without_typing_and_toast', () => {
    const id = 'release-tab';
    const off = registerModelLimitTab(id, { isClaude: true, personModel: false });
    setLastCommandMode(id, 'agent');
    feedTerminalInput(id, '/model sonnet\x1b[13;2u');
    expect(modelSwitchIndicator(id, undefined, 'en').state).toBe('human');
    const queue = vi.spyOn(inputGate, 'queueAutoInput');
    const toasts: any[] = [];
    const onEv = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener(MODEL_FALLBACK_EVENT, onEv);
    expect(releaseHumanModelChoice(id)).toBe(true);
    window.removeEventListener(MODEL_FALLBACK_EVENT, onEv);
    expect(modelSwitchIndicator(id, undefined, 'en').state).toBe('on');
    expect(queue).not.toHaveBeenCalled();
    expect(toasts).toEqual([expect.objectContaining({ terminalId: id, text: 'This tab is managed by auto model switch again', notice: expect.objectContaining({ kind: 'released' }) })]);
    expect(modelFallbackMarkOf(id)).toBeUndefined();
    // Nothing to release now, and a settings/flag model tab is never released here.
    expect(releaseHumanModelChoice(id)).toBe(false);
    off();
    const preset = registerModelLimitTab('preset-tab', { isClaude: true, personModel: true });
    expect(releaseHumanModelChoice('preset-tab')).toBe(false);
    expect(modelSwitchIndicator('preset-tab', undefined, 'en').state).toBe('preset');
    preset();
    queue.mockRestore();
  });
});
