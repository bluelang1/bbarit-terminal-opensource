import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import { judge, type SourceBaseline } from './brokerMechanic';

beforeEach(() => {
  invokeMock.mockReset();
});

const baseline: SourceBaseline = { sha: 'abc123', files: 1, loc: 0 };

describe('brokerMechanic', () => {
  it('keeps whitespace-only changes skippable using HEAD diff checks', async () => {
    const commands: string[] = [];
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'run_cli_oneshot') return '';
      const shellCommand = String(args?.command || '');
      commands.push(shellCommand);
      if (shellCommand.includes('git diff -w HEAD')) return '';
      if (shellCommand.includes('git diff --shortstat HEAD')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
      if (shellCommand.includes('git diff --shortstat abc123')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
      return '';
    });

    const result = await judge(
      '/repo',
      {
        baseline,
        diff: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-export const x=1;\n+export const x = 1;',
        goal: 'format only',
        firstReview: false,
      },
      '2026-01-01T00:00:00.000Z',
    );

    expect(result.action).toBe('skip');
    expect(result.reason).toBe('whitespace/format-only change');
    expect(result.metrics.changeIns).toBe(1);
    expect(result.metrics.changeDel).toBe(1);
    expect(commands.some((cmd) => cmd.includes('git diff -w HEAD'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('git diff --shortstat HEAD'))).toBe(true);
  });

  it('counts staged-only changes through HEAD shortstat and still requests review on first substantive change', async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command !== 'run_cli_oneshot') return '';
      const shellCommand = String(args?.command || '');
      if (shellCommand.includes('git diff -w HEAD')) {
        return 'diff --git a/src/feature.ts b/src/feature.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;';
      }
      if (shellCommand.includes('git diff --shortstat HEAD')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
      if (shellCommand.includes('git diff --shortstat abc123')) return ' 1 file changed, 1 insertion(+), 1 deletion(-)';
      return '';
    });

    const result = await judge(
      '/repo',
      {
        baseline,
        diff: 'diff --git a/src/feature.ts b/src/feature.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;',
        goal: 'staged change',
        firstReview: true,
      },
      '2026-01-01T00:00:00.000Z',
    );

    expect(result.action).toBe('review');
    expect(result.reason).toBe('first substantive change - confirm the direction now');
    expect(result.metrics.changeIns).toBe(1);
    expect(result.metrics.changeDel).toBe(1);
    expect(result.metrics.grownLoc).toBe(0);
    expect(result.statusMarkdown).toContain('This change: +1/-1');
  });
});
