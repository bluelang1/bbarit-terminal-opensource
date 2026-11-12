// The POSIX launch line for agent CLI tabs: built as a string, then run for real
// under /bin/sh with a PATH that holds only fake binaries.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliNotFoundMessage, wrapPosixCliCheck } from './cliLaunchCommand';
import { detectCliLaunchFailure } from './cliInstallGuard';

describe('wrapPosixCliCheck (string)', () => {
  it('uses if/then/else so the not-found echo depends only on command -v', () => {
    expect(wrapPosixCliCheck('claude --continue', 'claude', 'npm i -g @anthropic-ai/claude-code')).toBe(
      'if command -v claude >/dev/null 2>&1; then claude --continue; else echo "claude CLI not found. Install: npm i -g @anthropic-ai/claude-code"; fi',
    );
    expect(wrapPosixCliCheck('pi', 'pi')).toBe('if command -v pi >/dev/null 2>&1; then pi; else echo "pi CLI not found."; fi');
  });

  it('adds an elif branch for a fallback runner', () => {
    expect(wrapPosixCliCheck('reasonix code', 'reasonix', 'npm i -g reasonix', { binName: 'npx', cmd: 'npx -y reasonix@latest code' })).toBe(
      'if command -v reasonix >/dev/null 2>&1; then reasonix code; elif command -v npx >/dev/null 2>&1; then npx -y reasonix@latest code; else echo "reasonix CLI not found. Install: npm i -g reasonix"; fi',
    );
  });

  it('is not mistaken for a launch failure when the shell echoes it', () => {
    const line = wrapPosixCliCheck('gjc', 'gjc', 'npm i -g bun gajae-code');
    expect(detectCliLaunchFailure('gajae', `user@mac dir % ${line}`)).toBeNull();
    expect(detectCliLaunchFailure('gajae', `user@mac dir % ${line}\n${cliNotFoundMessage('gjc', 'npm i -g bun gajae-code')}`)).toBe('not-found');
  });
});

describe('wrapPosixCliCheck (run under /bin/sh)', () => {
  let bin: string;
  beforeEach(() => { bin = mkdtempSync(path.join(tmpdir(), 'bbarit-cli-')); });
  afterEach(() => { rmSync(bin, { recursive: true, force: true }); });

  const fake = (name: string, body: string) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  const run = (line: string) => {
    const r = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8', env: { PATH: bin } });
    return { status: r.status, out: r.stdout + r.stderr };
  };

  it('prints the not-found line only when the binary is missing', () => {
    expect(run(wrapPosixCliCheck('fakecli', 'fakecli', 'npm i -g fakecli'))).toEqual({
      status: 0,
      out: 'fakecli CLI not found. Install: npm i -g fakecli\n',
    });
  });

  it('leaves an installed CLI that fails alone (its output and exit status)', () => {
    fake('fakecli', 'echo "Can\'t read the current directory (EPERM)" >&2; exit 3');
    expect(run(wrapPosixCliCheck('fakecli --x', 'fakecli', 'npm i -g fakecli'))).toEqual({
      status: 3,
      out: "Can't read the current directory (EPERM)\n",
    });
  });

  it('does not run the fallback after the main CLI fails, and uses it only when the CLI is missing', () => {
    const line = wrapPosixCliCheck('reasonix code', 'reasonix', 'npm i -g reasonix', { binName: 'npx', cmd: 'npx -y reasonix@latest code' });
    fake('npx', 'echo "npx $*"');
    expect(run(line)).toEqual({ status: 0, out: 'npx -y reasonix@latest code\n' });
    fake('reasonix', 'echo boom; exit 1');
    expect(run(line)).toEqual({ status: 1, out: 'boom\n' });
  });
});
