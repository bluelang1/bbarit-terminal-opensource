import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isHiddenStackedPane, isStackedTerminalMode } from './stackedPanes';

describe('stacked terminal panes', () => {
  it('hides only non-active panes of stacked modes', () => {
    for (const mode of ['tabs', 'tiled', 'tiled_tb', 'tree']) {
      expect(isStackedTerminalMode(mode)).toBe(true);
      expect(isHiddenStackedPane(mode, false)).toBe(true);
      expect(isHiddenStackedPane(mode, true)).toBe(false);
    }
    for (const mode of ['horizontal', 'vertical', 'grid', 'mix', 'dashboard', 'monitor']) {
      expect(isStackedTerminalMode(mode)).toBe(false);
      expect(isHiddenStackedPane(mode, false)).toBe(false);
      expect(isHiddenStackedPane(mode, true)).toBe(false);
    }
  });

  it('React writes the inert attribute when true and drops it when false', () => {
    const Pane = ({ hidden }: { hidden: boolean }) => (
      <div data-testid="pane" inert={hidden}><textarea /></div>
    );
    const { getByTestId, rerender } = render(<Pane hidden />);
    expect(getByTestId('pane').hasAttribute('inert')).toBe(true);
    // Becoming the active tab: the attribute is gone in the same commit, before any
    // effect (XTerminal focuses itself ~200 ms after activation).
    rerender(<Pane hidden={false} />);
    expect(getByTestId('pane').hasAttribute('inert')).toBe(false);
  });

  it('App marks hidden stacked terminal wrappers inert', () => {
    const src = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(src).toMatch(/className=\{`terminal-wrapper [^\n]*\n[^\n]*\n[^\n]*\n\s*inert=\{isHiddenStackedPane\(terminalSplitMode, isActiveTerminal\)\}/);
    // The opacity-0 hiding in calculateTerminalPosition is keyed on the same helper.
    expect(src).toMatch(/if \(isStackedTerminalMode\(mode\)\) \{\n\s*return \{\n\s*\.\.\.base,[\s\S]{0,200}opacity: isActive \? 1 : 0,/);
  });
});
