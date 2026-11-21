// Tab layout guard for the model-switch icon (docs/MODEL_LIMIT_FALLBACK.md). An inactive Claude tab
// must show "Claude 12" fully next to the switched icon: the hidden capture/pop-out buttons (and the
// icon in its quiet states) leave the layout there, and the tab keeps the 190 px cap.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../App.css'), 'utf8');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Value of `prop` (px) in the LAST rule whose selector list is exactly `selector`. */
function lastPx(selector: string, prop: string): number {
  let value: number | null = null;
  for (const m of css.matchAll(new RegExp(`(?:^|\\n)${esc(selector)}\\s*\\{([^}]*)\\}`, 'g'))) {
    const v = new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+)px`).exec(m[1]);
    if (v) value = Number(v[1]);
  }
  if (value === null) throw new Error(`${selector} { ${prop} } not found`);
  return value;
}

describe('Claude tab layout with the model-switch icon', () => {
  it('should_keep_the_190px_cap_and_a_fixed_claude_tab_width', () => {
    expect(lastPx('.terminal-tab', 'max-width')).toBe(190);
    expect(lastPx('.terminal-tab.has-model-switch', 'width')).toBe(190);
    expect(css).not.toMatch(/\.terminal-tab\.has-model-switch\s*\{[^}]*max-width:\s*217px/);
  });

  it('should_take_hidden_buttons_out_of_the_layout_on_inactive_claude_tabs', () => {
    expect(css).toMatch(/\.terminal-tab\.has-model-switch:not\(:hover\):not\(\.active\) \.terminal-telegram-badge:not\(\.is-switched\):not\(\.is-unconfirmed\)\s*\{\s*display:\s*none !important;/);
    // Non-Claude tabs keep the opacity rule.
    expect(css).toMatch(/\.terminal-tab \.terminal-telegram-badge \{[^}]*opacity: 0;/);
  });

  it('should_leave_room_for_claude_12_on_an_inactive_switched_tab', () => {
    const tab = 190;
    const padding = 8 + 6; // .terminal-tab padding: 0 6px 0 8px
    const close = lastPx('.terminal-tab .tab-close', 'width');
    const gap = lastPx('.terminal-tab-label', 'gap');
    const dot = lastPx('.terminal-tab .pty-status-dot', 'width');
    const cliIcon = 14;
    const icon = lastPx('.terminal-tab .terminal-telegram-badge', 'width') + lastPx('.terminal-tab .terminal-telegram-badge', 'margin-left');
    const name = tab - padding - close - dot - cliIcon - icon - 3 * gap;
    expect(name).toBe(97);
    expect(name).toBeGreaterThanOrEqual(70); // "Claude 12" at 12-13 px bold is about 65 px
  });

  it('should_grow_active_and_hovered_claude_tabs_by_the_revealed_buttons', () => {
    const button = lastPx('.terminal-tab .terminal-telegram-badge', 'width')
      + lastPx('.terminal-tab .terminal-telegram-badge', 'margin-left')
      + lastPx('.terminal-tab-label', 'gap');
    expect(button).toBe(27);
    const grown = (sel: string) => new RegExp(`${esc(sel)}\\s*\\{\\s*width:\\s*(\\d+)px;\\s*max-width:\\s*(\\d+)px !important;`).exec(css);
    const quiet = grown('.terminal-tab.has-model-switch:hover,\n.terminal-tab.has-model-switch.active');
    const shown = grown('.terminal-tab.has-model-switch.model-switch-shown:hover,\n.terminal-tab.has-model-switch.model-switch-shown.active');
    expect(quiet && Number(quiet[1])).toBe(190 + 3 * button);
    expect(shown && Number(shown[1])).toBe(190 + 2 * button);
  });

  it('should_keep_the_switched_icon_visible_on_inactive_tabs', () => {
    expect(css).toMatch(/\.terminal-tab \.terminal-model-switch\.is-switched,\s*\.terminal-tab \.terminal-model-switch\.is-unconfirmed\s*\{\s*opacity:\s*0\.9;/);
  });
});
