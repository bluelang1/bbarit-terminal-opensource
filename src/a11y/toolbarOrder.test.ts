// The top toolbar's keyboard Tab order is its DOM order, so the buttons are written
// in App.tsx in the order they appear on screen and App.css must not reorder them
// with flex `order` (that once made "Hide toolbar" the first Tab stop).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tsx = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

const toolbarJsx = (() => {
  const start = tsx.indexOf('<div className={`top-utils');
  const end = tsx.indexOf('빠릿 하네스 실행 버튼은', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return tsx.slice(start, end).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
})();

/** Top-level toolbar items in DOM order; nested buttons (Office, Menu) are skipped. */
const domOrder = (): string[] => {
  const out: string[] = [];
  const re = /toolbar-collapse-toggle|toolbar-group-divider|editors-launcher-wrap|tool-dropdown-wrap|toolbar-tool tool-([a-z0-9-]+)/g;
  for (const m of toolbarJsx.matchAll(re)) {
    if (m[1] === 'editors' || m[1] === 'menu') continue;
    out.push(m[1] ?? m[0].replace('editors-launcher-wrap', 'editors').replace('toolbar-group-divider', '|'));
  }
  return out;
};

describe('top toolbar order', () => {
  it('lists the buttons in on-screen order', () => {
    expect(domOrder()).toEqual([
      'thread', 'secretary', '|',
      'git', 'quick-open', 'editors', 'browser', 'browser' /* disabled duplicate */, '|',
      'graph', 'planner', 'kanban', '|',
      'design', 'cowork', 'marketing', 'motion', 'image', '|',
      'pm2', 'hub', 'dashboard', 'skills', 'mcp', 'collab', 'broker', '|',
      'settings',
      // display: none in App.css, kept for the visibility settings
      'mic', 'github', 'tool-dropdown-wrap',
      'toolbar-collapse-toggle',
    ]);
  });

  it('does not reorder toolbar items with CSS order', () => {
    expect(toolbarJsx).not.toMatch(/\border\s*:/);
    const rules = [...css.matchAll(/([^{}]*\.top-utils[^{}]*)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(10);
    const reordered = rules
      .filter(([, selector, body]) => /(^|;|\s)order\s*:/.test(body) && !/::?(before|after)/.test(selector))
      .map(([, selector]) => selector.trim());
    expect(reordered).toEqual([]);
  });

  it('keeps the guide and hint targets on the same buttons', () => {
    expect(toolbarJsx).toMatch(/data-hint="tool" className="btn-top-small toolbar-tool tool-git" data-guide="git"/);
    expect(toolbarJsx).toMatch(/data-hint="nav" className="btn-top-small toolbar-collapse-toggle"/);
  });
});
