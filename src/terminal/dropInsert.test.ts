import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Drops must insert paths without pressing Enter (agent TUIs submitted some
// drops and not others when the path arrived as `path\r`). Paste keeps its
// own submit behaviour. Guarded on the source because XTerminal is a 6K-line
// component without a test harness.
const source = readFileSync(path.join(process.cwd(), 'src', 'XTerminal.tsx'), 'utf8');

describe('terminal drop insertion', () => {
  it('formats dropped paths with a trailing space and no carriage return', () => {
    expect(source).toContain("const insertDroppedPaths = (paths: string[]) => `${paths.map(shellQuotePath).join(' ')} `;");
  });

  it('uses the insert-only formatter for every drop route', () => {
    const osDrop = source.slice(source.indexOf('const onOsDrop = '), source.indexOf("window.addEventListener('octo-terminal-os-drop'"));
    expect(osDrop).toContain('insertDroppedPaths(paths)');
    expect(osDrop).not.toContain('submitDroppedPaths');
    const domDrop = source.slice(source.indexOf("const octoData = e.dataTransfer.getData('application/x-octo-filetree');"));
    const domDropBlock = domDrop.slice(0, domDrop.indexOf('onDragLeave') > 0 ? domDrop.indexOf('onDragLeave') : 6000);
    expect(domDropBlock).not.toContain('submitDroppedPaths');
    expect(domDropBlock).not.toMatch(/sendToPty\(`[^`]*\\r`\)/);
    expect(domDropBlock.match(/insertDroppedPaths\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
