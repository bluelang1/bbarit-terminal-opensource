import { describe, expect, it } from 'vitest';
import {
  PROJECT_PANEL_DEFAULT_WIDTH,
  PROJECT_PANEL_MAX_WIDTH,
  PROJECT_PANEL_MIN_WIDTH,
  clampProjectPanelWidth,
  parseProjectPanelWidth,
} from './projectPanelWidth';

const WIDE = 2400; // half = 1200, so only the absolute max applies

describe('project panel width', () => {
  it('uses 260 px / 180 px / 520 px for default, min and max', () => {
    expect(PROJECT_PANEL_DEFAULT_WIDTH).toBe(260);
    expect(PROJECT_PANEL_MIN_WIDTH).toBe(180);
    expect(PROJECT_PANEL_MAX_WIDTH).toBe(520);
  });

  it('keeps widths inside the range and rounds them', () => {
    expect(clampProjectPanelWidth(300, WIDE)).toBe(300);
    expect(clampProjectPanelWidth(300.6, WIDE)).toBe(301);
  });

  it('clamps to the minimum', () => {
    expect(clampProjectPanelWidth(120, WIDE)).toBe(180);
    expect(clampProjectPanelWidth(-50, WIDE)).toBe(180);
  });

  it('clamps to the maximum', () => {
    expect(clampProjectPanelWidth(900, WIDE)).toBe(520);
  });

  it('never exceeds half the window width', () => {
    expect(clampProjectPanelWidth(500, 800)).toBe(400);
    expect(clampProjectPanelWidth(260, 500)).toBe(250);
  });

  it('lets the minimum win when half the window is smaller than it', () => {
    expect(clampProjectPanelWidth(260, 300)).toBe(180);
  });

  it('ignores a missing or broken window width', () => {
    expect(clampProjectPanelWidth(900)).toBe(520);
    expect(clampProjectPanelWidth(900, Number.NaN)).toBe(520);
    expect(clampProjectPanelWidth(900, 0)).toBe(520);
  });

  it('falls back to the default for a non-finite width', () => {
    expect(clampProjectPanelWidth(Number.NaN, WIDE)).toBe(260);
    expect(clampProjectPanelWidth(Number.POSITIVE_INFINITY, WIDE)).toBe(260);
  });

  it('restores a saved value and clamps it to the absolute limits', () => {
    expect(parseProjectPanelWidth('340')).toBe(340);
    expect(parseProjectPanelWidth(' 340 ')).toBe(340);
    expect(parseProjectPanelWidth('9999')).toBe(520);
    expect(parseProjectPanelWidth('20')).toBe(180);
  });

  it('does not shrink a saved width to fit a small window at startup', () => {
    // The half-window cap is display-only (CSS max-width: 50vw) and applies
    // while dragging; restoring must keep the user's width for a wider window.
    expect(parseProjectPanelWidth('500')).toBe(500);
    expect(parseProjectPanelWidth.length).toBe(1);
  });

  it('uses the default for nothing saved or garbage', () => {
    for (const raw of [undefined, null, '', '   ', 'NaN', 'abc', '260px', '{}', 'Infinity']) {
      expect(parseProjectPanelWidth(raw)).toBe(260);
    }
  });
});
