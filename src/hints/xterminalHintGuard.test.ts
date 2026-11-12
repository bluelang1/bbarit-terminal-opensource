import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// XTerminal has window capture keydown handlers (Esc → \x1b, Enter → \r, Ctrl+C, …)
// that may run before hint mode's own listener. Each must bail out while hint mode
// is open so no key reaches a PTY, even if a terminal regains focus.
const src = readFileSync(join(process.cwd(), 'src/XTerminal.tsx'), 'utf8');
const handlers = [...src.matchAll(/window\.addEventListener\('keydown', (\w+), true\)/g)]
  .map((m) => m[1])
  // `sync` only tracks whether Cmd/Ctrl is held; it never writes to a PTY.
  .filter((name) => name !== 'sync');

describe('XTerminal window keydown handlers', () => {
  it('finds the capture handlers', () => {
    expect(handlers.length).toBeGreaterThanOrEqual(6);
  });

  it.each(handlers.map((h, i) => [`${h} #${i + 1}`, h]))('%s returns early while hint mode is open', (_label, name) => {
    const defs = [...src.matchAll(new RegExp(`const ${name} = \\(e: KeyboardEvent\\) => \\{\\n(.*)\\n`, 'g'))];
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) expect(def[1]).toMatch(/^\s*if \(isHintModeActive\(\)\) return;/);
  });
});
