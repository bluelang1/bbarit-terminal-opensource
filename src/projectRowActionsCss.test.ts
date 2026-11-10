import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The left project list's favorite/edit/close group must show only while the
// row is hovered or has keyboard focus. :focus / :focus-within also match after
// a mouse click (WebKit focuses the clicked button or the tabIndex=0 row), which
// left the group stuck on screen after the pointer moved away.
const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (selectorPart: string) =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sel]) => sel.includes(selectorPart))
    .map(([, sel, body]) => ({ sel: sel.trim(), body }));

describe('project row action group visibility', () => {
  it('never reveals the group through mouse-matching focus pseudo-classes', () => {
    for (const { sel } of rules('.project-selector-actions')) {
      expect(sel).not.toMatch(/:focus-within|:focus(?![-\w])/);
    }
    for (const { sel } of rules('.project-selector-item')) {
      expect(sel).not.toMatch(/\.project-selector-item(\.[\w-]+)*:focus(-within)?(?![-\w])[^,]*\.project-selector-actions/);
    }
  });

  it('reveals the group on hover and on keyboard focus only', () => {
    const reveal = rules('.project-selector-actions').find(({ body }) => /opacity:\s*1;/.test(body) && /pointer-events:\s*auto/.test(body));
    expect(reveal).toBeDefined();
    const selectors = reveal!.sel.split(',').map((s) => s.trim());
    expect(selectors).toEqual([
      '.project-selector-item:hover .project-selector-actions',
      '.project-selector-item:focus-visible .project-selector-actions',
      '.project-selector-actions:has(:focus-visible)',
    ]);
  });

  it('does not show the group just because a row is selected', () => {
    for (const { sel, body } of rules('.project-selector-actions')) {
      if (/(\.active|\.context-active)[^,]*\.project-selector-actions/.test(sel)) {
        expect(body).not.toMatch(/opacity:\s*1|pointer-events:\s*auto/);
      }
    }
  });
});
