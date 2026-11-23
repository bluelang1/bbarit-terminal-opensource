import { describe, expect, it } from 'vitest';
import { burnUp, eventTarget, laneTotals, medianTimeIn, timeInState, type TimelineEvent } from './timeline';

const M = 60_000;
const T0 = 1_800_000_000_000;
let n = 0;
const ev = (task: number, min: number, action: string, from: string | null, to: string | null): TimelineEvent => ({ task, ts: T0 + min * M, seq: ++n, action, from, to });

describe('timeInState', () => {
  it('splits repeated claims, reject back to open and retry into segments', () => {
    const events = [
      ev(1, 0, 'add', null, 'open'),
      ev(1, 2, 'claim', 'open', 'claimed'),
      ev(1, 5, 'lease_expired', 'claimed', 'open'),
      ev(1, 6, 'claim', 'open', 'claimed'),
      ev(1, 8, 'edit', null, null), // no state change: no split
      ev(1, 10, 'submit', 'claimed', 'review'),
      ev(1, 14, 'reject', 'review', 'open'),
      ev(1, 15, 'claim', 'open', 'claimed'),
      ev(1, 16, 'fail', 'claimed', 'failed'),
      ev(1, 20, 'retry', 'failed', 'open'),
    ];
    const [lane] = timeInState(events, T0 + 30 * M);
    expect(lane.segments.map((s) => [s.state, (s.from - T0) / M, (s.to - T0) / M])).toEqual([
      ['open', 0, 2], ['claimed', 2, 5], ['open', 5, 6], ['claimed', 6, 10], ['review', 10, 14], ['open', 14, 15], ['claimed', 15, 16], ['failed', 16, 20], ['open', 20, 30],
    ]);
    expect(lane.claims).toBe(3);
    expect(lane.last).toBe('open');
    expect(lane.end).toBe(T0 + 30 * M);
    expect(laneTotals(lane)).toEqual({ open: 14 * M, claimed: 8 * M, review: 4 * M, failed: 4 * M });
  });

  it('ends a lane when the task is done, starts from createdAt when the add fell out of the window', () => {
    const events = [ev(2, 10, 'claim', 'open', 'claimed'), ev(2, 12, 'done', 'claimed', 'done'), ev(3, 1, 'add', null, 'open')];
    const lanes = timeInState(events, T0 + 60 * M, [{ seq: 2, createdAt: T0 + 4 * M, state: 'done' }]);
    expect(lanes.map((l) => l.seq)).toEqual([3, 2]); // sorted by start
    const two = lanes[1];
    expect(two.start).toBe(T0 + 4 * M);
    expect(two.end).toBe(T0 + 12 * M);
    // Done at 12 min: the lane carries a faded done segment up to now.
    expect(two.segments.map((s) => [s.state, !!s.after])).toEqual([['open', false], ['claimed', false], ['done', true]]);
    expect(two.segments[2].to).toBe(T0 + 60 * M);
    expect(laneTotals(two)).toEqual({ open: 6 * M, claimed: 2 * M });
  });

  it('clamps events later than now (clock difference on a shared board)', () => {
    const [lane] = timeInState([ev(6, 0, 'add', null, 'open'), ev(6, 15, 'claim', 'open', 'claimed')], T0 + 10 * M);
    expect(lane.segments.map((s) => [s.state, (s.from - T0) / M, (s.to - T0) / M])).toEqual([['open', 0, 10]]);
    expect(lane.last).toBe('claimed');
  });

  it('reads the state from the action when an event has no `to`', () => {
    expect(eventTarget({ ts: 0, action: 'submit' })).toBe('review');
    expect(eventTarget({ ts: 0, action: 'dep_add' })).toBeNull();
  });

  it('medians per visit', () => {
    const events = [
      ev(4, 0, 'add', null, 'open'), ev(4, 1, 'submit', 'open', 'review'), ev(4, 3, 'approve', 'review', 'done'),
      ev(5, 0, 'add', null, 'open'), ev(5, 1, 'submit', 'open', 'review'), ev(5, 7, 'approve', 'review', 'done'),
    ];
    const lanes = timeInState(events, T0 + 10 * M);
    expect(medianTimeIn(lanes, 'review')).toBe(4 * M);
    expect(medianTimeIn(lanes, 'blocked')).toBeNull();
  });
});

describe('burnUp', () => {
  it('tracks scope and done, cancelled tasks leave the scope, review counts in done+review', () => {
    const events = [
      ev(1, 0, 'add', null, 'open'),
      ev(2, 1, 'add', null, 'open'),
      ev(3, 2, 'add', null, 'open'),
      ev(1, 3, 'submit', 'open', 'review'),
      ev(1, 4, 'approve', 'review', 'done'),
      ev(3, 5, 'cancel', 'open', 'cancelled'),
      ev(2, 6, 'done', 'claimed', 'done'),
    ];
    const p = burnUp(events, [], T0 + 10 * M);
    expect(p.map((x) => [(x.t - T0) / M, x.total, x.done, x.doneReview])).toEqual([
      [0, 1, 0, 0], [1, 2, 0, 0], [2, 3, 0, 0], [3, 3, 0, 1], [4, 3, 1, 1], [5, 2, 1, 1], [6, 2, 2, 2], [10, 2, 2, 2],
    ]);
  });

  it('draws a task with no events open from createdAt and in its current state from updatedAt', () => {
    const p = burnUp([], [{ seq: 9, createdAt: T0, updatedAt: T0 + 5 * M, state: 'done' }, { seq: 8, createdAt: T0 + M, state: 'open' }]);
    expect(p.map((x) => [(x.t - T0) / M, x.total, x.done])).toEqual([[0, 1, 0], [1, 2, 0], [5, 2, 1]]);
  });
});
