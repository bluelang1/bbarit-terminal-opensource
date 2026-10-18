import { describe, expect, it } from 'vitest';

import { advanceImeAnchor, shouldResyncImeAnchor } from './imeAnchor';

const anchor = { left: 100, top: 40, cellW: 10, cellH: 20 };

describe('ime anchor helpers', () => {
  it('advances the anchor by the committed display width', () => {
    const next = advanceImeAnchor(anchor, '안', 1000);
    expect(next).toEqual({ ...anchor, left: 120 });
  });

  it('holds at the right edge instead of advancing past the wrap width', () => {
    const nearEdge = { ...anchor, left: 980 };
    const next = advanceImeAnchor(nearEdge, '안', 1000);
    expect(next.left).toBe(980); // maxLeft = 1000 - 2*cellW, never past the edge
  });

  it('never moves backwards when already past the edge (e.g. after a resize)', () => {
    const pastEdge = { ...anchor, left: 995 };
    const next = advanceImeAnchor(pastEdge, '안', 1000);
    expect(next.left).toBe(995);
  });

  it('does not resync before the committed echo has painted', () => {
    // render happened before the PTY send → echo still in flight
    expect(shouldResyncImeAnchor(1000, 500, 600, 50)).toBe(false);
  });

  it('does not resync while the terminal is still repainting', () => {
    // render after send, but only 10ms ago (TUI redraw / streaming in progress)
    expect(shouldResyncImeAnchor(1000, 990, 600, 50)).toBe(false);
  });

  it('resyncs once the echo painted and the terminal went quiet', () => {
    expect(shouldResyncImeAnchor(1000, 900, 600, 50)).toBe(true);
  });

  it('allows resync during the first composition before any commit', () => {
    // lastPtySendAt=0: nothing committed yet, any settled paint is trustworthy
    expect(shouldResyncImeAnchor(1000, 900, 0, 50)).toBe(true);
  });
});
