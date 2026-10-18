import { describe, expect, it } from 'vitest';
import { applyWheelToScrollPin, type ScrollPin } from './scrollPin';

const atBottom: ScrollPin = { userScrolledUp: false, scrollOffsetFromBottom: 0 };
const pinnedAt = (offset: number): ScrollPin => ({ userScrolledUp: true, scrollOffsetFromBottom: offset });

describe('applyWheelToScrollPin', () => {
  it('should_pin_above_bottom_on_wheel_up_from_bottom', () => {
    expect(applyWheelToScrollPin(atBottom, -100, 0, 3)).toEqual(pinnedAt(3));
  });

  it('should_ratchet_pin_upward_on_repeated_wheel_up', () => {
    expect(applyWheelToScrollPin(pinnedAt(5), -100, 5, 2)).toEqual(pinnedAt(7));
  });

  it('should_keep_pin_at_least_one_line_on_wheel_up', () => {
    expect(applyWheelToScrollPin(atBottom, -1, 0, 0)).toEqual(pinnedAt(1));
  });

  it('should_walk_pin_down_on_wheel_down_while_scrolled_up', () => {
    expect(applyWheelToScrollPin(pinnedAt(7), 100, 7, 3)).toEqual(pinnedAt(4));
  });

  it('should_release_pin_when_wheel_down_reaches_bottom', () => {
    expect(applyWheelToScrollPin(pinnedAt(2), 100, 2, 3)).toEqual(atBottom);
  });

  it('should_release_pin_when_wheel_down_lands_exactly_on_bottom', () => {
    expect(applyWheelToScrollPin(pinnedAt(3), 100, 3, 3)).toEqual(atBottom);
  });

  it('should_ignore_wheel_down_when_already_at_bottom', () => {
    expect(applyWheelToScrollPin(atBottom, 100, 0, 3)).toEqual(atBottom);
  });

  it('should_track_actual_distance_not_stale_pin_on_wheel_down', () => {
    // 위로 스크롤이 핀보다 앞서 있을 때(onScroll 갱신 전) 실제 위치 기준으로 감소
    expect(applyWheelToScrollPin(pinnedAt(3), 100, 10, 2)).toEqual(pinnedAt(8));
  });

  it('should_treat_zero_wheel_lines_as_one_line_on_wheel_down', () => {
    expect(applyWheelToScrollPin(pinnedAt(5), 100, 5, 0)).toEqual(pinnedAt(4));
  });

  it('should_not_change_pin_on_horizontal_wheel', () => {
    expect(applyWheelToScrollPin(pinnedAt(5), 0, 5, 3)).toEqual(pinnedAt(5));
  });
});
