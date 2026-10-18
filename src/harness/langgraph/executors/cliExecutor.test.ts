import { describe, it, expect, vi } from 'vitest';
import { makeCliTextExecutor } from './cliExecutor';

describe('cliExecutor', () => {
  it('writes prompt to tmp and invokes run_cli_oneshot for claude', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const invokes: Array<{ cmd: string; args: any }> = [];
    const run = makeCliTextExecutor({
      backend: 'claude',
      workDir: '/Users/foo',
      fileWriter: async (path, content) => { writes.push({ path, content }); },
      invoker: async (cmd, args) => {
        invokes.push({ cmd, args });
        if (String(args.command || '').startsWith('cat ')) return 'claude-output';
        return '';
      },
    });
    const out = await run('hello');
    expect(out).toBe('claude-output');
    expect(writes[0].content).toBe('hello');
    expect(invokes[0].args.command).toContain("claude -p --output-format text");
    expect(invokes[0].args.command).toContain(writes[0].path);
    // cleanup rm -f invocation is fired after
    expect(invokes[1]?.args.command).toMatch(/^rm -f /);
  });

  it('builds codex command correctly', async () => {
    const invoker = vi.fn(async (_cmd: string, args: any) => {
      if (String(args.command || '').startsWith('cat ')) return 'codex-output';
      return '';
    });
    const run = makeCliTextExecutor({
      backend: 'codex',
      fileWriter: async () => {},
      invoker,
    });
    await run('plan this');
    expect(invoker.mock.calls[0][1].command).toContain('codex exec --skip-git-repo-check');
  });

  it('builds kimi command correctly', async () => {
    const invoker = vi.fn(async (_cmd: string, args: any) => {
      return String(args.command || '').includes('kimi') ? 'kimi-out' : '';
    });
    const run = makeCliTextExecutor({
      backend: 'kimi',
      fileWriter: async () => {},
      invoker,
    });
    const out = await run('hi');
    expect(out).toBe('kimi-out');
    expect(invoker.mock.calls[0][1].command).toContain('kimi --quiet -p');
  });

  it('prepends systemPrompt when provided', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const run = makeCliTextExecutor({
      backend: 'claude',
      systemPrompt: 'SYS',
      fileWriter: async (p, c) => { writes.push({ path: p, content: c }); },
      invoker: async () => 'ok',
    });
    await run('USER');
    expect(writes[0].content).toBe('SYS\n\nUSER');
  });
});
