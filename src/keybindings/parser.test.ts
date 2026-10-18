import { describe, expect, it } from 'vitest';
import { detectConflicts, matchesEvent, parseKeybindings, parseKeybinding } from './parser';

const keyboardEvent = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('keybinding parser', () => {
  it('parses modifiers and bracket keys', () => {
    expect(parseKeybinding('ctrl+shift+[')).toEqual({
      key: '[',
      meta: false,
      ctrl: true,
      alt: false,
      shift: true,
    });
  });

  it('matches physical bracket keys when IME changes event.key', () => {
    const binding = parseKeybinding('ctrl+shift+[');

    expect(matchesEvent(binding, keyboardEvent({
      key: 'ㅁ',
      code: 'BracketLeft',
      ctrlKey: true,
      shiftKey: true,
    }))).toBe(true);
  });

  it('detects exact shortcut conflicts', () => {
    const entries = parseKeybindings([
      { id: 'a', keys: 'cmd+shift+p' },
      { id: 'b', keys: 'cmd+shift+p' },
      { id: 'c', keys: 'cmd+p' },
    ]);

    expect(detectConflicts(entries).map(([a, b]) => [a.id, b.id])).toEqual([['a', 'b']]);
  });
});
