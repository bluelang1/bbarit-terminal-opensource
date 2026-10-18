import { describe, expect, it } from 'vitest';
import { routeKeyDuringComposition } from './imeEscape';

describe('routeKeyDuringComposition', () => {
  it('should_deliver_escape_to_terminal_while_composing', () => {
    // 한글 조합이 열린 상태에서도 Esc는 IME로 미루지 않고 터미널로 보낸다
    // (조합 중 Esc가 삼켜져 에이전트 턴 취소가 불가능해지는 회귀 방지).
    expect(routeKeyDuringComposition('Escape', true)).toBe('esc');
  });

  it('should_deliver_escape_to_terminal_when_idle', () => {
    expect(routeKeyDuringComposition('Escape', false)).toBe('esc');
  });

  it('should_defer_other_keys_to_ime_while_composing', () => {
    expect(routeKeyDuringComposition('a', true)).toBe('ime');
    expect(routeKeyDuringComposition('Backspace', true)).toBe('ime');
    expect(routeKeyDuringComposition('Tab', true)).toBe('ime');
  });

  it('should_route_other_keys_normally_when_not_composing', () => {
    expect(routeKeyDuringComposition('a', false)).toBe('normal');
    expect(routeKeyDuringComposition('Enter', false)).toBe('normal');
  });
});
