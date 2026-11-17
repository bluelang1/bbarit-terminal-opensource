import { describe, expect, it } from 'vitest';
import { createSelectionCopyState } from './selectionCopy';

describe('selection copy state', () => {
  it('copies a new selection once, not again on later mouse releases', () => {
    const s = createSelectionCopyState();
    s.selectionChanged(true);
    expect(s.takeForAutoCopy('first')).toBe('first');
    // The selection is still on screen; clicks elsewhere must not re-copy it.
    expect(s.takeForAutoCopy('first')).toBeNull();
    expect(s.takeForAutoCopy('first')).toBeNull();
  });

  it('copies again after the selection changes', () => {
    const s = createSelectionCopyState();
    s.selectionChanged(true);
    s.takeForAutoCopy('first');
    s.selectionChanged(true);
    expect(s.takeForAutoCopy('second')).toBe('second');
  });

  it('forgets the last selection once it is cleared', () => {
    const s = createSelectionCopyState();
    s.selectionChanged(true);
    s.takeForAutoCopy('old');
    expect(s.last()).toBe('old');
    s.selectionChanged(false);
    expect(s.last()).toBe('');
    expect(s.takeForAutoCopy('')).toBeNull();
  });

  it('a program copy replaces the fallback and survives clearing the old selection', () => {
    const s = createSelectionCopyState();
    s.selectionChanged(true);
    s.takeForAutoCopy('old');
    s.programCopied('fresh', true);
    s.selectionChanged(false); // our own clearSelection()
    expect(s.last()).toBe('fresh');
    expect(s.takeForAutoCopy('old')).toBeNull();
  });

  it('a program copy with nothing selected does not keep a stale guard', () => {
    const s = createSelectionCopyState();
    s.programCopied('fresh', false);
    s.selectionChanged(true);
    s.takeForAutoCopy('mine');
    s.selectionChanged(false);
    expect(s.last()).toBe('');
  });
});
