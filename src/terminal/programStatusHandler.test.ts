import { describe, expect, it, vi } from 'vitest';
import { decideAgentAlert, type AgentAlert } from './agentAlert';
import { createProgramStatusStore, PROGRAM_STATUS_QUERY_REPLY } from './programStatus';
import {
  STALE_PROGRAM_STATUS_MS,
  answerProgramStatusProbe,
  handleProgramStatusOsc,
  isProgramStatusStale,
  type ProgramStatusChange,
  type ProgramStatusHost,
} from './programStatusHandler';

// XTerminal 과 같은 배선: onChange 에서 decideAgentAlert 로 알림을 정한다.
function harness(looking = false) {
  const writes: string[] = [];
  const host: ProgramStatusHost = { writeToPty: (d) => writes.push(d) };
  const alerts: AgentAlert[] = [];
  const changes: ProgramStatusChange[] = [];
  const onReset = vi.fn();
  const feed = (data: string) => handleProgramStatusOsc(host, data, {
    onChange: (c) => {
      changes.push(c);
      alerts.push(decideAgentAlert(c.prev, c.next, looking, c.firstReport));
    },
    onReset,
  });
  return { host, writes, alerts, changes, onReset, feed };
}

describe('handleProgramStatusOsc', () => {
  it('should_reply_to_probe_with_exact_bytes', () => {
    const h = harness();
    expect(h.feed('?')).toBe(true);
    expect(h.writes).toEqual(['\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\']);
    expect(h.writes[0]).toBe(`${PROGRAM_STATUS_QUERY_REPLY}\x1b\\`);
  });

  it('should_defer_probe_reply_until_writer_is_registered', () => {
    const h = harness();
    h.host.writeToPty = null;
    h.feed('?');
    expect(h.host.pendingStatusProbe).toBe(true);
    h.host.writeToPty = (d) => h.writes.push(d);
    expect(answerProgramStatusProbe(h.host)).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.host.pendingStatusProbe).toBe(false);
  });

  it('should_neither_reply_nor_alert_while_replaying_saved_output', () => {
    const h = harness();
    h.host.replayingOutput = true;
    h.feed('?');
    h.feed('state=idle');
    h.feed('state=working');
    h.feed('state=blocked:kind=permission');
    h.feed('state=done');
    h.host.replayingOutput = false;
    expect(h.writes).toEqual([]);
    expect(h.host.pendingStatusProbe).toBeFalsy();
    expect(h.alerts).toEqual([null, null, null, null]);
    expect(h.changes.every((c) => c.firstReport)).toBe(true);
    // 상태는 반영된다
    expect(h.changes.at(-1)?.next).toBe('done');
    expect(h.host.programStatus?.reported).toBe(true);
  });

  it('should_alert_on_live_blocked_after_first_report', () => {
    const h = harness(true);
    h.feed('state=idle'); // 시작 후 첫 보고 — 알림 없음
    h.feed('state=working');
    h.feed('state=blocked:kind=question');
    expect(h.alerts).toEqual([null, null, 'blocked']);
  });

  it('should_not_repeat_alerts_within_a_turn', () => {
    const h = harness(false);
    const turn = () => h.host.programStatus?.turn;
    h.feed('state=idle');
    h.feed('state=working');
    expect(turn()).toBe(0);
    h.feed('state=blocked:kind=permission');
    expect(turn()).toBe(1);
    h.feed('state=blocked:kind=permission'); // 같은 턴 반복 보고
    h.feed('state=blocked:kind=permission:progress=10');
    expect(turn()).toBe(1);
    h.feed('state=working');
    h.feed('state=working:progress=50');
    h.feed('state=done');
    expect(turn()).toBe(2);
    h.feed('state=done'); // 같은 턴 반복
    h.feed('state=idle');
    expect(turn()).toBe(2);
    expect(h.alerts).toEqual([null, null, 'blocked', null, null, null, null, 'done', null, null]);
  });

  it('should_reset_reported_on_new_probe_so_old_working_cannot_raise_done', () => {
    const h = harness(false);
    h.feed('state=idle');
    h.feed('state=working');
    expect(h.host.programStatus?.reported).toBe(true);
    // 같은 탭에서 새 세션이 시작됐다(이전 세션은 working 인 채로 끝남)
    h.feed('?');
    expect(h.onReset).toHaveBeenCalledTimes(1);
    expect(h.host.programStatus?.reported).toBe(false);
    expect(h.writes).toHaveLength(1);
    h.feed('state=idle');
    expect(h.alerts.at(-1)).toBeNull();
    expect(h.changes.at(-1)).toMatchObject({ prev: 'idle', next: 'idle', firstReport: true });
  });

  it('should_ignore_malformed_payloads', () => {
    const h = harness();
    expect(h.feed('state=nope')).toBe(true);
    expect(h.changes).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });
});

describe('isProgramStatusStale', () => {
  const T = STALE_PROGRAM_STATUS_MS;
  const storeIn = (data: string, at: number) => {
    const host: ProgramStatusHost = { writeToPty: null, programStatus: createProgramStatusStore() };
    handleProgramStatusOsc(host, data, { onChange: () => {} }, at);
    return host.programStatus;
  };

  it('should_flag_working_or_blocked_when_reports_and_output_are_both_old', () => {
    expect(isProgramStatusStale(storeIn('state=working', 0), T, T)).toBe(true);
    expect(isProgramStatusStale(storeIn('state=blocked', 0), T + 1, T + 1)).toBe(true);
  });

  it('should_keep_state_when_either_report_or_output_is_recent', () => {
    expect(isProgramStatusStale(storeIn('state=working', 0), T - 1, T)).toBe(false);
    expect(isProgramStatusStale(storeIn('state=working', 0), T, T - 1)).toBe(false);
  });

  it('should_never_flag_done_idle_or_unreported', () => {
    expect(isProgramStatusStale(storeIn('state=done', 0), T, T)).toBe(false);
    expect(isProgramStatusStale(storeIn('state=idle', 0), T, T)).toBe(false);
    expect(isProgramStatusStale(createProgramStatusStore(), T, T)).toBe(false);
    expect(isProgramStatusStale(undefined, T, T)).toBe(false);
  });
});
