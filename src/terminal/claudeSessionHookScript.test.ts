// Runs the bundled Claude SessionStart hook with a fake `curl` first on PATH and
// checks the exit status and the request it would send. docs/CLAUDE_SESSION_HOOK.md
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../src-tauri/resources/claude-hooks/session-start.sh');
const SETTINGS = path.resolve(__dirname, '../../src-tauri/resources/claude-hooks/bbarit-session.json');
const SID = '0f4b2c1e-7d3a-4c5b-9e8f-1a2b3c4d5e6f';

describe.skipIf(process.platform === 'win32')('session-start.sh', () => {
  let dir = '';
  let log = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bbarit-hook-'));
    log = path.join(dir, 'curl.log');
    const fakeCurl = path.join(dir, 'curl');
    // One argument per line so the test can read back exactly what was passed.
    writeFileSync(fakeCurl, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\necho should-not-reach-stdout\nexit 7\n`);
    chmodSync(fakeCurl, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (input: string, env: Record<string, string | undefined> = {}) => spawnSync('/bin/sh', [SCRIPT], {
    input,
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      BBARIT_BRIDGE_PORT: '1',
      BBARIT_TERMINAL_ID: 't',
      ...env,
    },
  });

  it('should_post_session_to_the_bridge_and_exit_0', () => {
    const res = run(JSON.stringify({ session_id: SID, transcript_path: '/x/y z.jsonl', source: 'startup', cwd: '/p' }));
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
    const args = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(args).toContain('http://127.0.0.1:1/api/claude-session');
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', '2']);
    const body = JSON.parse(args[args.indexOf('-d') + 1]);
    expect(body).toEqual({ terminalId: 't', sessionId: SID, transcriptPath: '/x/y z.jsonl', source: 'startup' });
  });

  it('should_handle_pretty_printed_json', () => {
    const res = run(JSON.stringify({ session_id: SID, transcript_path: '/t.jsonl', source: 'clear' }, null, 2));
    expect(res.status).toBe(0);
    const args = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(args[args.indexOf('-d') + 1])).toMatchObject({ sessionId: SID, source: 'clear' });
  });

  it('should_skip_subagent_sessions', () => {
    const res = run(JSON.stringify({ session_id: SID, transcript_path: '/t.jsonl', source: 'startup', agent_id: 'a1' }));
    expect(res.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it('should_exit_0_silently_without_bridge_env_or_session_id', () => {
    for (const res of [
      run(JSON.stringify({ session_id: SID }), { BBARIT_BRIDGE_PORT: undefined }),
      run(JSON.stringify({ session_id: SID }), { BBARIT_TERMINAL_ID: '' }),
      run(JSON.stringify({ source: 'startup' })),
      run(''),
      run('not json'),
    ]) {
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).toBe('');
    }
    expect(existsSync(log)).toBe(false);
  });

  it('should_exit_0_when_curl_is_missing', () => {
    // PATH holds only sed, so `curl` is not found.
    const onlySed = path.join(dir, 'only-sed');
    mkdirSync(onlySed);
    symlinkSync(spawnSync('/bin/sh', ['-c', 'command -v sed'], { encoding: 'utf8' }).stdout.trim(), path.join(onlySed, 'sed'));
    const res = spawnSync('/bin/sh', [SCRIPT], {
      input: JSON.stringify({ session_id: SID, source: 'startup' }),
      encoding: 'utf8',
      env: { PATH: onlySed, BBARIT_BRIDGE_PORT: '1', BBARIT_TERMINAL_ID: 't' },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('should_ship_settings_that_run_the_hook_for_every_session_source', () => {
    const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    const entry = settings.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|resume|clear|compact');
    expect(entry.hooks[0]).toMatchObject({ type: 'command' });
    expect(entry.hooks[0].command).toContain('sh "$BBARIT_CLAUDE_HOOK"');
    // An unset BBARIT_CLAUDE_HOOK must not fail the hook.
    const res = spawnSync('/bin/sh', ['-c', entry.hooks[0].command], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(res.status).toBe(0);
  });
});
