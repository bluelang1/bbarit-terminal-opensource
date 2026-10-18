import { describe, expect, it } from 'vitest';
import { describeCombo, keyDispatchJs, parseKeyCombo } from './browserKeys';

describe('parseKeyCombo', () => {
  // 정상: named keys.
  it('parses named keys', () => {
    expect(parseKeyCombo('Enter')).toMatchObject({ key: 'Enter', valid: true });
    expect(parseKeyCombo('esc')).toMatchObject({ key: 'Escape' });
    expect(parseKeyCombo('tab')).toMatchObject({ key: 'Tab' });
    expect(parseKeyCombo('up')).toMatchObject({ key: 'ArrowUp' });
    expect(parseKeyCombo('space')).toMatchObject({ key: ' ' });
  });

  // 매핑: modifier combos.
  it('parses modifier combinations', () => {
    expect(parseKeyCombo('Ctrl+A')).toMatchObject({ key: 'A', ctrl: true });
    expect(parseKeyCombo('control+a')).toMatchObject({ key: 'a', ctrl: true });
    expect(parseKeyCombo('cmd+shift+p')).toMatchObject({ key: 'p', meta: true, shift: true });
    expect(parseKeyCombo('alt+Enter')).toMatchObject({ key: 'Enter', alt: true });
  });

  // 매핑: single character keys.
  it('passes through single characters', () => {
    expect(parseKeyCombo('a').key).toBe('a');
    expect(parseKeyCombo('/').key).toBe('/');
  });

  // None/변조: empty / junk.
  it('marks empty specs invalid', () => {
    expect(parseKeyCombo('').valid).toBe(false);
    expect(parseKeyCombo('   ').valid).toBe(false);
    expect(parseKeyCombo(undefined as unknown as string).valid).toBe(false);
  });

  it('handles a lone modifier without a key as invalid', () => {
    expect(parseKeyCombo('ctrl').valid).toBe(false);
  });
});

describe('describeCombo', () => {
  it('renders a readable combo', () => {
    expect(describeCombo(parseKeyCombo('ctrl+a'))).toBe('Ctrl+a');
    expect(describeCombo(parseKeyCombo('space'))).toBe('Space');
    expect(describeCombo(parseKeyCombo('cmd+shift+p'))).toBe('Shift+Meta+p');
  });
});

describe('keyDispatchJs', () => {
  it('builds a keydown+keyup dispatch expression', () => {
    const js = keyDispatchJs(parseKeyCombo('Enter'));
    expect(js).toContain('keydown');
    expect(js).toContain('keyup');
    expect(js).toContain('"key":"Enter"');
    expect(js).toContain('activeElement');
  });
  it('encodes modifiers', () => {
    const js = keyDispatchJs(parseKeyCombo('ctrl+a'));
    expect(js).toContain('"ctrlKey":true');
  });
});
