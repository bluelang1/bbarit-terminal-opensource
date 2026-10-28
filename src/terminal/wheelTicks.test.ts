import { describe, expect, it } from 'vitest';
import { wheelToTicks } from './wheelTicks';

const px = (deltaY: number) => ({ deltaY, deltaMode: 0, wheelDeltaY: -deltaY * 3 });

describe('wheelToTicks', () => {
  it('should_not_emit_a_tick_for_each_tiny_trackpad_delta', () => {
    let remainder = 0;
    let total = 0;
    for (let i = 0; i < 30; i++) {
      const r = wheelToTicks(px(-3), remainder, 18, 40);
      remainder = r.remainder;
      total += r.ticks;
    }
    // 90px of swipe ≈ 5 rows, not 30 ticks
    expect(total).toBe(-5);
  });

  it('should_carry_remainder_between_events', () => {
    const a = wheelToTicks(px(10), 0, 18, 40);
    expect(a).toEqual({ ticks: 0, remainder: 10 });
    expect(wheelToTicks(px(10), a.remainder, 18, 40)).toEqual({ ticks: 1, remainder: 2 });
  });

  it('should_drop_carry_on_direction_change', () => {
    expect(wheelToTicks(px(-10), 15, 18, 40)).toEqual({ ticks: 0, remainder: -10 });
  });

  it('should_accumulate_trackpad_delta_whose_legacy_value_hits_a_notch_multiple', () => {
    expect(wheelToTicks(px(40), 0, 18, 40)).toEqual({ ticks: 2, remainder: 4 });
  });

  it('should_ignore_zero_vertical_delta', () => {
    expect(wheelToTicks({ deltaY: 0, deltaMode: 0, wheelDeltaY: 0 }, 5, 18, 40)).toEqual({ ticks: 0, remainder: 5 });
  });

  it('should_emit_one_tick_per_mouse_notch_in_pixel_mode', () => {
    expect(wheelToTicks({ deltaY: 4, deltaMode: 0, wheelDeltaY: -120 }, 7, 18, 40)).toEqual({ ticks: 1, remainder: 0 });
    expect(wheelToTicks({ deltaY: -8, deltaMode: 0, wheelDeltaY: 240 }, 0, 18, 40)).toEqual({ ticks: -2, remainder: 0 });
  });

  it('should_map_line_mode_notch_to_one_tick', () => {
    expect(wheelToTicks({ deltaY: 3, deltaMode: 1 }, 0, 18, 40)).toEqual({ ticks: 1, remainder: 0 });
    expect(wheelToTicks({ deltaY: -1, deltaMode: 1 }, 0, 18, 40)).toEqual({ ticks: -1, remainder: 0 });
  });

  it('should_scroll_a_page_in_page_mode', () => {
    expect(wheelToTicks({ deltaY: 1, deltaMode: 2 }, 0, 18, 40)).toEqual({ ticks: 40, remainder: 0 });
  });
});
