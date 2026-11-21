// Runs the bundled Claude UserPromptSubmit hook (lead mode) with a fake `curl` first on PATH
// standing in for GET /api/agent-lead. docs/AGENT_RELAY.md "Lead mode".
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname, '../../src-tauri/resources/claude-hooks');
const SCRIPT = path.join(DIR, 'user-prompt-submit.sh');
const SETTINGS = path.join(DIR, 'bbarit-session.json');
// What the bridge answers with the default settings (lead_hook_phrases in agent_board/mod.rs).
const DEFAULT_PHRASES = '리드 에이전트로 진행해줘\nproceed as the lead agent';

describe.skipIf(process.platform === 'win32')('user-prompt-submit.sh (lead mode)', () => {
  let dir = '';
  let log = '';
  const fakeCurl = (body: string | null) => {
    // null = app not running (curl fails); one argument per line goes to the log.
    const out = body === null ? 'exit 7' : `printf '%s' '${body.replace(/'/g, "'\\''")}'\nexit 0`;
    writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n${out}\n`);
    chmodSync(path.join(dir, 'curl'), 0o755);
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bbarit-lead-hook-'));
    log = path.join(dir, 'curl.log');
    fakeCurl(DEFAULT_PHRASES);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (prompt: unknown, env: Record<string, string | undefined> = {}, extra: Record<string, unknown> = {}) => spawnSync('/bin/sh', [SCRIPT], {
    input: typeof prompt === 'string' && prompt.startsWith('RAW:') ? prompt.slice(4) : JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'UserPromptSubmit', prompt, ...extra }),
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, BBARIT_BRIDGE_PORT: '1', ...env },
  });
  const context = (res: ReturnType<typeof run>) => {
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    if (!res.stdout) return null;
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    return out.hookSpecificOutput.additionalContext as string;
  };

  it('adds lead-mode context when the prompt contains the Korean phrase', () => {
    const ctx = context(run('로그인 버그 고쳐줘. 리드 에이전트로 진행해줘'));
    expect(ctx).toMatch(/lead of a BBARIT tab team/);
    expect(ctx).toMatch(/pull model: .*claim --next --label <role>/);
    expect(ctx).toMatch(/bbarit-agents skill and follow its "Lead mode" section/);
    expect(ctx).toMatch(/agents_disabled \(agent team is turned off\), do the work in this tab/);
    // Safety rules travel with the context itself (an old installed skill may lack them).
    expect(ctx).toMatch(/never push, open pull requests or merge to main unless the user asked for it in this request/);
    expect(ctx).toMatch(/permission or a login, ask the user instead of approving it yourself/);
    expect(ctx).toMatch(/Stay within the agent limits of the app/);
    expect(ctx).toMatch(/Do not ask the user for further direction unless something is truly ambiguous or needs approval from the user/);
    const args = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(args).toContain('http://127.0.0.1:1/api/agent-lead');
    // The prompt never leaves the hook.
    expect(args.join(' ')).not.toMatch(/로그인/);
  });

  it('matches across whitespace variants and English case', () => {
    expect(context(run('리드   에이전트로\n진행해줘 please'))).toBeTruthy();
    expect(context(run('  리드 에이전트로\t진행해줘'))).toBeTruthy();
    expect(context(run('Fix it. PROCEED as  the\nLead Agent.'))).toBeTruthy();
    expect(context(run('RAW:{\n  "session_id": "s",\n  "prompt": "proceed as the lead agent"\n}'))).toBeTruthy();
  });

  it('treats NBSP, U+3000 and escaped backslashes correctly', () => {
    expect(context(run('리드\u00a0에이전트로\u3000진행해줘'))).toBeTruthy();
    // A literal backslash before "n" is not a newline: "lead\\nagent" must not become "lead agent".
    fakeCurl('a b');
    expect(context(run('a\\nb'))).toBeNull();
    expect(context(run('a\nb'))).toBeTruthy();
    fakeCurl('x \\\\ y');
    expect(context(run('x \\ y'))).toBeTruthy();
  });

  it('never fires on text the relay types into a tab', () => {
    // Child brief, done note, agent send from another tab — all start with <bbarit.
    expect(context(run('<bbarit from="t1" reach="node \\"$BBARIT_CTL\\" agent send t1 \\"<message>\\"">\nYou were started…\n</bbarit>\n리드 에이전트로 진행해줘'))).toBeNull();
    expect(context(run('<bbarit from="t3 reviewer" state="done" turn="2">리드 에이전트로 진행해줘</bbarit>'))).toBeNull();
    expect(context(run('  \n<bbarit from="t2">proceed as the lead agent</bbarit>'))).toBeNull();
    // The same phrase typed by a person, mentioning the tag later, still counts.
    expect(context(run('리드 에이전트로 진행해줘 (see <bbarit> notes)'))).toBeTruthy();
  });

  it('adds nothing when the phrase is absent or only outside the prompt', () => {
    expect(context(run('리드 에이전트 얘기만 했어'))).toBeNull();
    expect(context(run('fix the login bug'))).toBeNull();
    expect(context(run('hello', {}, { cwd: '/proceed as the lead agent' }))).toBeNull();
    expect(context(run(''))).toBeNull();
    expect(context(run('RAW:not json'))).toBeNull();
  });

  it('adds nothing while the agent team is off (the bridge answers no phrases)', () => {
    fakeCurl('');
    expect(context(run('리드 에이전트로 진행해줘'))).toBeNull();
  });

  it('adds nothing when the app is not running or outside an app tab', () => {
    fakeCurl(null);
    expect(context(run('리드 에이전트로 진행해줘'))).toBeNull();
    fakeCurl(DEFAULT_PHRASES);
    expect(context(run('리드 에이전트로 진행해줘', { BBARIT_BRIDGE_PORT: undefined }))).toBeNull();
  });

  it('uses the phrase the bridge sends (edited in Settings, JSON-escaped quotes)', () => {
    fakeCurl('팀장 \\"모드\\"로 해줘');
    expect(context(run('팀장 "모드"로 해줘'))).toBeTruthy();
    expect(context(run('리드 에이전트로 진행해줘'))).toBeNull();
  });

  it('ships a quick UserPromptSubmit hook that runs the script beside session-start.sh', () => {
    const entry = JSON.parse(readFileSync(SETTINGS, 'utf8')).hooks.UserPromptSubmit[0];
    expect(entry.matcher).toBeUndefined();
    expect(entry.hooks[0]).toMatchObject({ type: 'command', timeout: 1 });
    const cmd = entry.hooks[0].command as string;
    const sh = (env: Record<string, string>) => spawnSync('/bin/sh', ['-c', cmd], {
      input: JSON.stringify({ prompt: '리드 에이전트로 진행해줘' }), encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, BBARIT_BRIDGE_PORT: '1', ...env },
    });
    expect(sh({}).status).toBe(0);
    expect(sh({}).stdout).toBe('');
    const res = sh({ BBARIT_CLAUDE_HOOK: path.join(DIR, 'session-start.sh') });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    // An older bundle without the script: still exit 0, nothing added.
    const old = sh({ BBARIT_CLAUDE_HOOK: path.join(dir, 'session-start.sh') });
    expect(old.status).toBe(0);
    expect(old.stdout).toBe('');
  });
});
