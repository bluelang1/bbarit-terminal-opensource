import { describe, expect, it } from 'vitest';
import { hintCharFromCode, hintKeyStep, isModifierOnlyKey } from './hintMatch';

const key = (code: string, key = '', extra: Partial<KeyboardEventInit> = {}) => ({ code, key, ...extra });
const labels = ['1', '2', 'a', 'z1', 'z2', 'zz'];

describe('hintCharFromCode', () => {
  it('maps digit, numpad and letter codes', () => {
    expect(hintCharFromCode('Digit1')).toBe('1');
    expect(hintCharFromCode('Numpad0')).toBe('0');
    expect(hintCharFromCode('KeyA')).toBe('a');
    expect(hintCharFromCode('Semicolon')).toBeNull();
    expect(hintCharFromCode('Enter')).toBeNull();
  });
});

describe('isModifierOnlyKey', () => {
  it('recognises modifier keys by key or code', () => {
    expect(isModifierOnlyKey(key('ShiftLeft', 'Shift'))).toBe(true);
    expect(isModifierOnlyKey(key('MetaRight', 'Meta'))).toBe(true);
    expect(isModifierOnlyKey(key('CapsLock', 'CapsLock'))).toBe(true);
    expect(isModifierOnlyKey(key('KeyA', 'a'))).toBe(false);
  });
});

describe('hintKeyStep', () => {
  it('activates a one-character label', () => {
    expect(hintKeyStep(labels, '', key('Digit2', '2'))).toEqual({ type: 'activate', label: '2' });
  });

  it('matches by code while a Korean IME reports Hangul in key', () => {
    expect(hintKeyStep(labels, '', key('KeyA', 'ㅁ'))).toEqual({ type: 'activate', label: 'a' });
    expect(hintKeyStep(labels, '', key('KeyZ', 'ㅋ'))).toEqual({ type: 'narrow', buffer: 'z' });
  });

  it('matches case-insensitively (Shift / CapsLock)', () => {
    expect(hintKeyStep(labels, '', key('KeyA', 'A', { shiftKey: true }))).toEqual({ type: 'activate', label: 'a' });
  });

  it('narrows on a prefix and activates on the second character', () => {
    expect(hintKeyStep(labels, '', key('KeyZ', 'z'))).toEqual({ type: 'narrow', buffer: 'z' });
    expect(hintKeyStep(labels, 'z', key('Digit2', '2'))).toEqual({ type: 'activate', label: 'z2' });
    expect(hintKeyStep(labels, 'z', key('KeyZ', 'z'))).toEqual({ type: 'activate', label: 'zz' });
  });

  it('backspace removes one typed character and is ignored when nothing is typed', () => {
    expect(hintKeyStep(labels, 'z', key('Backspace', 'Backspace'))).toEqual({ type: 'narrow', buffer: '' });
    expect(hintKeyStep(labels, '', key('Backspace', 'Backspace'))).toEqual({ type: 'ignore' });
  });

  it('cancels on Escape, unmatched keys, non-hint keys and any Cmd/Ctrl/Alt chord', () => {
    expect(hintKeyStep(labels, '', key('Escape', 'Escape'))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, 'z', key('Escape', 'Escape'))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, '', key('KeyQ', 'q'))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, 'z', key('KeyQ', 'q'))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, '', key('Enter', 'Enter'))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, '', key('Space', ' '))).toEqual({ type: 'cancel' });
    // The hint shortcut itself (Cmd+J) closes hint mode even though "j" could be a label.
    expect(hintKeyStep([...labels, 'j'], '', key('KeyJ', 'j', { metaKey: true }))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, '', key('KeyA', 'a', { ctrlKey: true }))).toEqual({ type: 'cancel' });
    expect(hintKeyStep(labels, '', key('KeyA', 'å', { altKey: true }))).toEqual({ type: 'cancel' });
  });

  it('ignores modifier-only keys and keys reported mid composition', () => {
    expect(hintKeyStep(labels, 'z', key('ShiftLeft', 'Shift', { shiftKey: true }))).toEqual({ type: 'ignore' });
    expect(hintKeyStep(labels, 'z', key('MetaLeft', 'Meta', { metaKey: true }))).toEqual({ type: 'ignore' });
    expect(hintKeyStep(labels, '', key('KeyA', 'Process', { isComposing: true }))).toEqual({ type: 'ignore' });
  });
});
