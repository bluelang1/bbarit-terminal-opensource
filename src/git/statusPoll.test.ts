import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStatusPoller, nextStatusPollDelay, STATUS_POLL_BASE_MS, STATUS_POLL_MAX_MS } from './statusPoll';

describe('nextStatusPollDelay', () => {
  it('should_keep_the_5s_cadence_for_a_fast_repo', () => {
    expect(nextStatusPollDelay(0)).toBe(5000);
    expect(nextStatusPollDelay(120)).toBe(5000);
    expect(STATUS_POLL_BASE_MS).toBe(5000);
  });

  it('should_wait_longer_after_a_slow_status', () => {
    expect(nextStatusPollDelay(4000)).toBeGreaterThan(5000);
    expect(nextStatusPollDelay(4000)).toBe(12000);
  });

  it('should_never_exceed_the_cap', () => {
    expect(STATUS_POLL_MAX_MS).toBe(60000);
    expect(nextStatusPollDelay(62000)).toBe(60000);
    expect(nextStatusPollDelay(Number.POSITIVE_INFINITY)).toBe(60000);
  });

  it('should_use_a_configurable_base_delay', () => {
    expect(nextStatusPollDelay(0, 10000)).toBe(10000);
    expect(nextStatusPollDelay(2000, 10000)).toBe(10000);
    expect(nextStatusPollDelay(5000, 10000)).toBe(15000);
    expect(nextStatusPollDelay(62000, 10000)).toBe(60000);
  });

  it('should_treat_invalid_durations_as_fast', () => {
    expect(nextStatusPollDelay(-5)).toBe(5000);
    expect(nextStatusPollDelay(Number.NaN)).toBe(5000);
  });
});

/** A status call that resolves when the test says so. */
function controllableRun() {
  const pending: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const run = vi.fn(() => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<void>(resolve => {
      pending.push(() => { active--; resolve(); });
    });
  });
  return {
    run,
    finishNext: async () => { pending.shift()?.(); await vi.advanceTimersByTimeAsync(0); },
    get calls() { return calls; },
    get maxActive() { return maxActive; },
    get pending() { return pending.length; },
  };
}

describe('createStatusPoller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('should_poll_every_5s_for_a_fast_repo', async () => {
    const run = vi.fn(async () => {});
    const poller = createStatusPoller(run);
    poller.start();
    await vi.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('should_not_start_a_poll_while_a_slow_status_is_running', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run);
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.calls).toBe(1);
    // the status takes 20 s; no further poll may start meanwhile
    await vi.advanceTimersByTimeAsync(20000);
    expect(c.calls).toBe(1);
    await c.finishNext();
    expect(c.maxActive).toBe(1);
    poller.stop();
  });

  it('should_back_off_after_a_slow_status', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run);
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(4000);
    await c.finishNext(); // took 4 s -> next poll in 12 s
    await vi.advanceTimersByTimeAsync(11999);
    expect(c.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls).toBe(2);
    poller.stop();
  });

  it('should_share_the_in_flight_call_with_a_manual_refresh', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run);
    const a = poller.refresh();
    const b = poller.refresh();
    expect(c.calls).toBe(1);
    let bDone = false;
    void b.then(() => { bDone = true; });
    await c.finishNext();
    await a;
    expect(bDone).toBe(true);
    expect(c.maxActive).toBe(1);
  });

  it('should_queue_one_fresh_rerun_after_the_in_flight_call_without_overlap', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run);
    void poller.refresh();
    const f1 = poller.refresh({ fresh: true });
    const f2 = poller.refresh({ fresh: true });
    expect(c.calls).toBe(1);
    await c.finishNext();
    expect(c.calls).toBe(2); // one coalesced rerun, started only after the first finished
    let f1Done = false;
    void f1.then(() => { f1Done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f1Done).toBe(false);
    await c.finishNext();
    await Promise.all([f1, f2]);
    expect(c.calls).toBe(2);
    expect(c.maxActive).toBe(1);
  });

  it('should_run_a_fresh_refresh_immediately_when_idle', async () => {
    const run = vi.fn(async () => {});
    const poller = createStatusPoller(run);
    await poller.refresh({ fresh: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('should_stop_polling_after_stop', async () => {
    const run = vi.fn(async () => {});
    const poller = createStatusPoller(run);
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    poller.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should_not_reschedule_when_stopped_during_a_running_poll', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run);
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    void poller.refresh({ fresh: true }); // queued rerun must be dropped too
    poller.stop();
    await c.finishNext();
    await vi.advanceTimersByTimeAsync(60000);
    expect(c.calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should_ignore_refresh_calls_on_a_stopped_poller', async () => {
    const run = vi.fn(async () => {});
    const poller = createStatusPoller(run);
    poller.stop();
    await poller.refresh();
    await poller.refresh({ fresh: true });
    expect(run).toHaveBeenCalledTimes(0);
  });

  it('should_poll_on_a_configurable_base_with_a_quick_first_run', async () => {
    const run = vi.fn(async () => {});
    const poller = createStatusPoller(run, { baseMs: 10000 });
    poller.start({ firstDelayMs: 250 });
    await vi.advanceTimersByTimeAsync(249);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it('should_back_off_from_a_configurable_base_without_overlap', async () => {
    const c = controllableRun();
    const poller = createStatusPoller(c.run, { baseMs: 10000 });
    poller.start({ firstDelayMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(30000); // status still running: no second call
    expect(c.calls).toBe(1);
    await c.finishNext(); // took 30 s -> next in 60 s (cap)
    await vi.advanceTimersByTimeAsync(59999);
    expect(c.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.calls).toBe(2);
    expect(c.maxActive).toBe(1);
    poller.stop();
  });

  it('should_keep_polling_after_a_failed_status', async () => {
    const run = vi.fn(async () => { throw new Error('git failed'); });
    const poller = createStatusPoller(run);
    poller.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
