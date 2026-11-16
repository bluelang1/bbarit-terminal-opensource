import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentExitCode,
  agentRow,
  bridgePortCandidates,
  evaluateAgentWait,
  mcpPortFromEnv,
  waitForAgents,
  isAppUnreachable,
  unreachableWaitPolicy,
  BRIDGE_UNREACHABLE,
  takeWorktreeFlag,
  agentTableColumns,
  parseStopArgs,
  stopExitCode,
  awaitAgentRunJob,
  parseLogArgs,
  tailRelayLogText,
  readRelayLogFile,
  relayLogPath,
  formatRelayLogLine,
  readFileTail,
  agentCallerFields,
  parseBoardArgs,
  boardTeamRows,
  parseTaskArgs,
  taskExitCode,
  taskNumber,
  TASK_SUBS,
} from '../scripts/bbarit-ctl.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const done = { terminalId: 'a', state: 'done', settled: true };
const working = { terminalId: 'b', state: 'working', settled: false };
const blocked = { terminalId: 'c', state: 'blocked', kind: 'question', settled: true };

test('evaluateAgentWait any/all', () => {
  assert.equal(evaluateAgentWait([done, working], 'any'), true);
  assert.equal(evaluateAgentWait([done, working], 'all'), false);
  assert.equal(evaluateAgentWait([done, blocked], 'all'), true);
  assert.equal(evaluateAgentWait([working], 'any'), false);
  assert.equal(evaluateAgentWait([], 'any'), false);
  assert.equal(evaluateAgentWait([], 'all'), false);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitForAgents returns once the condition holds', async () => {
  const clock = fakeClock();
  const frames = [[working], [working], [{ ...working, state: 'done', settled: true }]];
  let calls = 0;
  const res = await waitForAgents({ fetchAgents: async () => frames[Math.min(calls++, frames.length - 1)], timeoutMs: 60000, ...clock });
  assert.equal(res.timedOut, false);
  assert.equal(calls, 3);
  assert.equal(clock.now(), 4000);
});

test('waitForAgents times out with the last snapshot', async () => {
  const clock = fakeClock();
  let calls = 0;
  const res = await waitForAgents({ fetchAgents: async () => { calls++; return [working]; }, timeoutMs: 5000, ...clock });
  assert.equal(res.timedOut, true);
  assert.deepEqual(res.agents, [working]);
  assert.equal(calls, 4); // t = 0, 2000, 4000, 6000
});

test('waitForAgents retries transient failures, then gives up', async () => {
  const clock = fakeClock();
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw new Error('reload'); return [done]; };
  assert.equal((await waitForAgents({ fetchAgents: flaky, timeoutMs: 60000, ...clock })).timedOut, false);
  const broken = async () => { throw new Error('gone'); };
  await assert.rejects(waitForAgents({ fetchAgents: broken, timeoutMs: 60000, ...fakeClock() }), /gone/);
});

test('waitForAgents keeps waiting while the app is unreachable, bounded by the timeout', async () => {
  const clock = fakeClock();
  const closed = () => Object.assign(new Error('Cannot reach BBARIT Terminal'), { code: BRIDGE_UNREACHABLE });
  let calls = 0;
  let warned = 0;
  // App closed for 10 polls (20 s, far past 3 strikes), then back with the child done.
  const fetchAgents = async () => { calls++; if (calls <= 10) throw closed(); return [done]; };
  const res = await waitForAgents({ fetchAgents, timeoutMs: 60000, onUnreachable: () => { warned++; }, ...clock });
  assert.equal(res.timedOut, false);
  assert.equal(calls, 11);
  assert.equal(warned, 1, 'one "app not reachable" line');
  const never = await waitForAgents({ fetchAgents: async () => { throw closed(); }, timeoutMs: 6000, ...fakeClock() });
  assert.equal(never.timedOut, true);
  assert.equal(isAppUnreachable(new Error('__BBARIT_CTL__ not ready (app too old or still loading)')), true);
  assert.equal(isAppUnreachable(new Error('agent.status failed')), false);
});

test('an explicit --port fails fast instead of waiting for the app', async () => {
  const closed = () => Object.assign(new Error('Cannot connect to port 9999'), { code: BRIDGE_UNREACHABLE });
  assert.equal(unreachableWaitPolicy(0), isAppUnreachable);
  assert.equal(unreachableWaitPolicy(9999)(closed()), false);
  let calls = 0;
  await assert.rejects(
    waitForAgents({
      fetchAgents: async () => { calls++; throw closed(); },
      timeoutMs: 600000,
      isUnreachable: unreachableWaitPolicy(9999),
      ...fakeClock(),
    }),
    /Cannot connect to port 9999/,
  );
  assert.equal(calls, 3, 'three strikes, as before the holder change');
});

test('agentExitCode', () => {
  assert.equal(agentExitCode({ timedOut: true, agents: [done] }), 3);
  assert.equal(agentExitCode({ timedOut: false, agents: [done] }), 0);
  assert.equal(agentExitCode({ timedOut: false, agents: [done, blocked] }), 2);
  assert.equal(agentExitCode({ timedOut: false, agents: [{ ...done, error: 'refused' }] }), 1);
  assert.equal(agentExitCode({ timedOut: false, agents: [{ ...blocked, exited: true }] }), 0);
});

test('BBARIT_BRIDGE_PORT maps to the mcp-bridge port and is tried first', () => {
  assert.equal(mcpPortFromEnv({ BBARIT_BRIDGE_PORT: '19980' }), 9223);
  assert.equal(mcpPortFromEnv({ BBARIT_BRIDGE_PORT: '19981' }), 9323);
  assert.equal(mcpPortFromEnv({ BBARIT_BRIDGE_PORT: '1234' }), 0);
  assert.equal(mcpPortFromEnv({}), 0);
  const order = bridgePortCandidates(9223, 0);
  assert.equal(order[0], 9223);
  assert.equal(order.filter((p) => p === 9223).length, 1);
  assert.equal(order[1], 9323);
  assert.deepEqual(bridgePortCandidates(9323, 9330).slice(0, 2), [9330, 9323]);
  assert.equal(bridgePortCandidates().length, 101);
});

test('agentRow marks quiet-heuristic settles', () => {
  assert.equal(agentRow({ ...done }).settled, 'yes');
  assert.equal(agentRow({ ...done, state: 'idle', settledBy: 'quiet' }).settled, 'yes (quiet-heuristic)');
  assert.equal(agentRow(working).settled, '-');
  assert.equal(agentRow(blocked).state, 'blocked:question');
});

test('takeWorktreeFlag: bare flag, a name before the prompt, --worktree=<name>', () => {
  const take = (list) => { const copy = [...list]; return { worktree: takeWorktreeFlag(copy), rest: copy }; };
  assert.deepEqual(take(['claude', 'review it']), { worktree: undefined, rest: ['claude', 'review it'] });
  assert.deepEqual(take(['claude', 'review it', '--worktree']), { worktree: true, rest: ['claude', 'review it'] });
  assert.deepEqual(take(['--worktree', 'claude', 'review it']), { worktree: true, rest: ['claude', 'review it'] });
  assert.deepEqual(take(['claude', '--worktree', 'fix-login', 'review it']), { worktree: 'fix-login', rest: ['claude', 'review it'] });
  assert.deepEqual(take(['claude', 'review it', '--worktree', 'fix-login']), { worktree: 'fix-login', rest: ['claude', 'review it'] });
  assert.deepEqual(take(['claude', '--worktree=fix', 'review', 'it']), { worktree: 'fix', rest: ['claude', 'review', 'it'] });
  assert.deepEqual(take(['claude', 'review', '--worktree=']), { worktree: true, rest: ['claude', 'review'] });
  // A following flag-like word is never taken as the name.
  assert.deepEqual(take(['claude', 'x', '--worktree', '--y']), { worktree: true, rest: ['claude', 'x', '--y'] });
});

test('agent table shows a branch column only when a child has a worktree', () => {
  assert.deepEqual(agentTableColumns([done]), ['terminalId', 'name', 'cliType', 'state', 'settled', 'exited']);
  assert.deepEqual(agentTableColumns([done, { ...working, branch: 'agent/rev' }]), ['terminalId', 'name', 'cliType', 'state', 'settled', 'exited', 'branch']);
  assert.equal(agentRow({ ...done, branch: 'agent/rev' }).branch, 'agent/rev');
  assert.equal(agentRow(done).branch, '-');
});

test('parseStopArgs: one id or --children, optional --close', () => {
  assert.deepEqual(parseStopArgs([]), { children: true, close: false });
  assert.deepEqual(parseStopArgs(['--children']), { children: true, close: false });
  assert.deepEqual(parseStopArgs(['t7']), { terminalId: 't7', children: false, close: false });
  assert.deepEqual(parseStopArgs(['t7', '--close']), { terminalId: 't7', children: false, close: true });
  assert.deepEqual(parseStopArgs(['--close', '--children']), { children: true, close: true });
  assert.throws(() => parseStopArgs(['t7', '--children']), /usage: agent stop/);
  assert.throws(() => parseStopArgs(['t7', 't8']), /usage: agent stop/);
  assert.throws(() => parseStopArgs(['--all']), /usage: agent stop/);
});

test('stopExitCode: 0 only when every target was interrupted', () => {
  assert.equal(stopExitCode({ ok: true, stopped: [{ terminalId: 'a', ok: true }] }), 0);
  assert.equal(stopExitCode({ ok: true, stopped: [] }), 0);
  assert.equal(stopExitCode({ ok: true, stopped: [{ terminalId: 'a', ok: true }, { terminalId: 'b', ok: false }] }), 1);
  assert.equal(stopExitCode({ ok: false, error: 'x' }), 1);
});

test('awaitAgentRunJob polls agent.run.result until the worktree run is done', async () => {
  const clock = fakeClock();
  const plain = { ok: true, terminalId: 't1' };
  assert.equal(await awaitAgentRunJob({ first: plain, fetchResult: async () => { throw new Error('no poll'); } }), plain);
  let calls = 0;
  const done = await awaitAgentRunJob({
    first: { ok: true, pending: true, jobId: 'j1' },
    fetchResult: async (id) => { calls += 1; assert.equal(id, 'j1'); return calls < 3 ? { ok: true, pending: true } : { ok: true, terminalId: 't2', branch: 'agent/x' }; },
    now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(done, { ok: true, terminalId: 't2', branch: 'agent/x' });
  const failed = await awaitAgentRunJob({ first: { ok: true, pending: true, jobId: 'j2' }, fetchResult: async () => ({ ok: false, error: 'worktree: not a git repository: /x' }), now: clock.now, sleep: clock.sleep });
  assert.equal(failed.error, 'worktree: not a git repository: /x');
  const slow = await awaitAgentRunJob({ first: { ok: true, pending: true, jobId: 'j3' }, fetchResult: async () => ({ ok: true, pending: true }), timeoutMs: 2000, now: clock.now, sleep: clock.sleep });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
});

test('awaitAgentRunJob retries thrown fetches and treats null as pending', async () => {
  const clock = fakeClock();
  let calls = 0;
  const res = await awaitAgentRunJob({
    first: { ok: true, pending: true, jobId: 'j' },
    fetchResult: async () => {
      calls += 1;
      if (calls === 1) throw new Error('BRIDGE_UNREACHABLE');
      if (calls === 2) return null;
      return { ok: true, terminalId: 't9' };
    },
    now: clock.now, sleep: clock.sleep,
  });
  assert.deepEqual(res, { ok: true, terminalId: 't9' });
  assert.equal(calls, 3);
  const never = await awaitAgentRunJob({ first: { ok: true, pending: true, jobId: 'k' }, fetchResult: async () => { throw new Error('down'); }, timeoutMs: 1500, now: clock.now, sleep: clock.sleep });
  assert.equal(never.timedOut, true);
});

test('agent table shows a depth column once the app reports depth', () => {
  assert.deepEqual(agentTableColumns([{ ...done, depth: 1 }]), ['terminalId', 'name', 'cliType', 'depth', 'state', 'settled', 'exited']);
  assert.deepEqual(agentTableColumns([{ ...done, depth: 2, branch: 'agent/x' }]), ['terminalId', 'name', 'cliType', 'depth', 'state', 'settled', 'exited', 'branch']);
});

test('parseLogArgs: --tail N defaults to 20 and caps at 500', () => {
  assert.deepEqual(parseLogArgs([]), { tail: 20 });
  assert.deepEqual(parseLogArgs(['--tail', '5']), { tail: 5 });
  assert.deepEqual(parseLogArgs(['--tail', '9999']), { tail: 500 });
  assert.deepEqual(parseLogArgs(['--tail', '7.9']), { tail: 7 });
  assert.throws(() => parseLogArgs(['--tail', '0']), /usage: agent log/);
  assert.throws(() => parseLogArgs(['--tail', 'x']), /usage: agent log/);
  assert.throws(() => parseLogArgs(['extra']), /usage: agent log/);
  assert.throws(() => parseLogArgs(['--tail']), /usage: agent log/);
  assert.throws(() => parseLogArgs(['--tail', '--json']), /usage: agent log/);
  assert.throws(() => parseLogArgs(['--tail=']), /usage: agent log/);
  assert.deepEqual(parseLogArgs(['--tail=5']), { tail: 5 });
  assert.deepEqual(parseLogArgs(['--tail=900']), { tail: 500 });
});

test('readFileTail reads only the last bytes, drops the cut line, tolerates bad UTF-8', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbarit-relay-tail-'));
  const file = path.join(dir, 'agent-relay.log');
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from('{"event":"first-long-line-that-gets-cut"}\n'),
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from('{"event":"run"}\n{"event":"exit"}\n'),
  ]));
  assert.equal(readFileTail(file, 34), '{"event":"run"}\n{"event":"exit"}\n');
  const all = readFileTail(file, 1 << 20);
  assert.ok(all.includes('\ufffd'), 'invalid bytes become U+FFFD');
  assert.ok(all.startsWith('{"event":"first-long-line'));
  assert.deepEqual(readRelayLogFile(5, file, 34), ['{"event":"run"}', '{"event":"exit"}']);
  assert.equal(readFileTail(path.join(dir, 'missing.log')), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailRelayLogText reaches into the rotated file only when needed', () => {
  assert.deepEqual(tailRelayLogText('a\nb\nc\n', 'old1\nold2\n', 2), ['b', 'c']);
  assert.deepEqual(tailRelayLogText('a\n\nb\n', 'old1\nold2\n', 3), ['old2', 'a', 'b']);
  assert.deepEqual(tailRelayLogText('', '', 5), []);
});

test('readRelayLogFile reads the log and its .1 from disk; missing files are empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbarit-relay-log-'));
  const file = path.join(dir, 'agent-relay.log');
  assert.deepEqual(readRelayLogFile(5, file), []);
  fs.writeFileSync(`${file}.1`, '{"event":"run"}\n');
  fs.writeFileSync(file, '{"event":"send"}\n{"event":"exit"}\n');
  assert.deepEqual(readRelayLogFile(5, file), ['{"event":"run"}', '{"event":"send"}', '{"event":"exit"}']);
  assert.deepEqual(readRelayLogFile(1, file), ['{"event":"exit"}']);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(relayLogPath('/home/u'), path.join('/home/u', '.config', 'octo', 'agent-relay.log'));
});

test('formatRelayLogLine prints one readable line per event', () => {
  const run = formatRelayLogLine(JSON.stringify({
    ts: '2026-11-16T01:02:03.004Z', event: 'run', caller: { id: 't1', name: 'Claude' },
    target: { id: 't5', name: 'reviewer', cliType: 'claude' }, depth: 1, branch: 'agent/reviewer',
    textLen: 300, textHead: 'Review the diff',
  }));
  assert.equal(run, '2026-11-16T01:02:03.004Z  run          t1 Claude → t5 reviewer (claude)  depth=1  branch=agent/reviewer  "Review the diff…" (300 chars)');
  const refused = formatRelayLogLine(JSON.stringify({
    ts: 'T', event: 'run_refused', caller: { id: 't1' }, target: { cliType: 'codex' }, depth: 3,
    reason: 'maxDepth', count: 2, max: 2, textLen: 2, textHead: 'go',
  }));
  assert.equal(refused, 'T  run_refused  t1 → (codex)  depth=3  reason=maxDepth  count=2  max=2  "go" (2 chars)');
  const stop = formatRelayLogLine(JSON.stringify({ ts: 'T', event: 'stop', target: { id: 't2' }, by: 'button', ok: false, keys: '', closed: true }));
  assert.equal(stop, 'T  stop         - → t2  by=button  ok=no  closed=yes');
  assert.equal(formatRelayLogLine('not json'), 'not json');
});

test('agentCallerFields: a real tab sends its id with its token', () => {
  const tab = { BBARIT_TERMINAL_ID: 't1', BBARIT_TERM_TOKEN: 'tok-of-t1' };
  const list = ['claude', 'review it'];
  assert.deepEqual(agentCallerFields(list, tab), { caller: 't1', callerToken: 'tok-of-t1' });
  assert.deepEqual(list, ['claude', 'review it'], 'nothing else is taken from the arguments');
});

test('agentCallerFields: --caller alone carries this tab\'s token (the app refuses it for another tab)', () => {
  const tab = { BBARIT_TERMINAL_ID: 't1', BBARIT_TERM_TOKEN: 'tok-of-t1' };
  const list = ['--caller', 't9', 'x'];
  // The env token belongs to t1, so the app sees a wrong token for t9 (caller not verified).
  assert.deepEqual(agentCallerFields(list, tab), { caller: 't9', callerToken: 'tok-of-t1' });
  assert.deepEqual(list, ['x']);
  const withToken = ['--caller', 't9', '--caller-token', 'tok-of-t9', 'x'];
  assert.deepEqual(agentCallerFields(withToken, tab), { caller: 't9', callerToken: 'tok-of-t9' });
  assert.deepEqual(withToken, ['x']);
});

test('agentCallerFields: missing token, and no caller at all', () => {
  // An old tab (no BBARIT_TERM_TOKEN) or --caller outside a tab: sent without a token; the app
  // accepts it only for a tab recovered from the PTY holder.
  assert.deepEqual(agentCallerFields([], { BBARIT_TERMINAL_ID: 't1' }), { caller: 't1' });
  assert.deepEqual(agentCallerFields(['--caller', 't2'], {}), { caller: 't2' });
  assert.deepEqual(agentCallerFields(['--caller-token', 'tok'], {}), {}, 'a token without a caller is not sent');
  assert.deepEqual(agentCallerFields([], {}), {});
  assert.deepEqual(agentCallerFields([], { BBARIT_TERMINAL_ID: '  ', BBARIT_TERM_TOKEN: 'tok' }), {});
});

test('formatRelayLogLine shows caller verification and refusals (never a token)', () => {
  const refused = formatRelayLogLine(JSON.stringify({ ts: 'T', event: 'caller_refused', caller: { id: 't9' }, reason: 'wrong_token', cmd: 'agent.run' }));
  assert.equal(refused, 'T  caller_refused  t9 → -  reason=wrong_token  cmd=agent.run');
  const legacy = formatRelayLogLine(JSON.stringify({ ts: 'T', event: 'send', caller: { id: 't1' }, target: { id: 't2' }, callerVerified: 'legacy', ok: true }));
  assert.equal(legacy, 'T  send         t1 → t2  ok=yes  callerVerified=legacy');
  const verified = formatRelayLogLine(JSON.stringify({ ts: 'T', event: 'stop', caller: { id: 't1' }, target: { id: 't2' }, callerVerified: true }));
  assert.equal(verified, 'T  stop         t1 → t2  callerVerified=yes');
});

test('parseBoardArgs post: text words and --kind', () => {
  assert.deepEqual(parseBoardArgs('post', ['found', 'the', 'bug']), { text: 'found the bug' });
  assert.deepEqual(parseBoardArgs('post', ['--kind', 'Finding', 'auth.ts:40']), { text: 'auth.ts:40', kind: 'finding' });
  assert.deepEqual(parseBoardArgs('post', ['all done', '--kind=done']), { text: 'all done', kind: 'done' });
  assert.deepEqual(parseBoardArgs('post', ['- item one\n- item two']), { text: '- item one\n- item two' });
  assert.throws(() => parseBoardArgs('post', []), /usage: agent board post/);
  assert.throws(() => parseBoardArgs('post', ['--kind']), /usage/);
  assert.throws(() => parseBoardArgs('post', ['x', '--kind', 'loud']), /invalid kind: loud/);
  // Unknown options are an error, not text; `--` ends options.
  assert.throws(() => parseBoardArgs('post', ['use', '--verbose']), /unknown option for agent board post: --verbose/);
  assert.deepEqual(parseBoardArgs('post', ['--kind', 'note', '--', 'run', 'with', '--json', '--kind', 'x']), { text: 'run with --json --kind x', kind: 'note' });
  assert.deepEqual(parseBoardArgs('post', ['--', '--port', '9223', 'is', 'dev']), { text: '--port 9223 is dev' });
  assert.throws(() => parseBoardArgs('post', ['--']), /usage/);
  // Announcements and task links.
  assert.deepEqual(parseBoardArgs('post', ['--kind', 'announce', 'plan']), { text: 'plan', kind: 'announce' });
  assert.deepEqual(parseBoardArgs('post', ['--task', '#3', 'found it']), { text: 'found it', task: 3 });
  assert.throws(() => parseBoardArgs('post', ['--task', 'x', 'y']), /invalid task number/);
});

test('parseTaskArgs add: title words, options before --, repeatable labels and deps', () => {
  assert.deepEqual(parseTaskArgs('add', ['Fix', 'the', 'login', 'test']), { title: 'Fix the login test' });
  assert.deepEqual(
    parseTaskArgs('add', ['--priority', '2', '--after', '1,#2', '--after=3', '--label', 'ui', '--label', 'auth', '--review', '--parent', '#5', '--body', 'steps', '--max-attempts', '5', 'Ship', 'it']),
    { title: 'Ship it', priority: 2, after: [1, 2, 3], labels: ['ui', 'auth'], review: true, parent: 5, body: 'steps', maxAttempts: 5 },
  );
  assert.deepEqual(parseTaskArgs('add', ['--', '--json', 'is', 'a', 'flag']), { title: '--json is a flag' });
  assert.deepEqual(parseTaskArgs('add', ['--body', '-', 'title']), { title: 'title', body: '-' });
  assert.throws(() => parseTaskArgs('add', []), /usage: agent task add/);
  assert.throws(() => parseTaskArgs('add', ['x', '--priority', '9']), /priority must be 0-3/);
  assert.throws(() => parseTaskArgs('add', ['x', '--after', 'a']), /invalid task number/);
  assert.throws(() => parseTaskArgs('add', ['x', '--verbose']), /unknown option for agent task add: --verbose/);
});

test('parseTaskArgs list / show / claim', () => {
  assert.deepEqual(parseTaskArgs('list', []), {});
  assert.deepEqual(
    parseTaskArgs('list', ['--state', 'claimed,Waiting', '--state', 'review', '--mine', '--ready', '--tree', '--all', '--search', 'login', '--team', 'r1', '--limit', '10']),
    { states: ['claimed', 'waiting', 'review'], mine: true, ready: true, tree: true, all: true, search: 'login', team: 'r1', limit: 10 },
  );
  assert.throws(() => parseTaskArgs('list', ['extra']), /usage: agent task list/);
  assert.deepEqual(parseTaskArgs('show', ['#4', '--history']), { task: 4, history: true });
  assert.deepEqual(parseTaskArgs('show', ['4', '--team', 'r1']), { task: 4, team: 'r1' });
  assert.throws(() => parseTaskArgs('show', []), /usage: agent task show/);
  assert.deepEqual(parseTaskArgs('claim', ['--next']), { next: true });
  assert.deepEqual(parseTaskArgs('claim', ['#7']), { task: 7 });
  assert.throws(() => parseTaskArgs('claim', ['--next', '7']), /usage: agent task claim/);
  assert.throws(() => parseTaskArgs('claim', ['1', '2']), /usage/);
});

test('parseTaskArgs transitions need their reason / error / summary', () => {
  assert.deepEqual(parseTaskArgs('block', ['3', '--reason', 'needs a key']), { task: 3, reason: 'needs a key' });
  assert.throws(() => parseTaskArgs('block', ['3']), /usage: agent task block/);
  assert.throws(() => parseTaskArgs('reject', ['3']), /usage: agent task reject/);
  assert.deepEqual(parseTaskArgs('fail', ['3', '--error=tests fail']), { task: 3, error: 'tests fail' });
  assert.throws(() => parseTaskArgs('fail', ['3']), /usage/);
  for (const sub of ['unblock', 'release', 'retry']) assert.deepEqual(parseTaskArgs(sub, ['#2']), { task: 2 });
  assert.deepEqual(parseTaskArgs('cancel', ['2', '--reason', 'dup']), { task: 2, reason: 'dup' });
  assert.deepEqual(parseTaskArgs('approve', ['2']), { task: 2 });
  assert.deepEqual(
    parseTaskArgs('done', ['5', '--summary', 'parser done', '--branch', 'agent/p', '--commit', 'abc1234', '--checks', 'PASSED', '--artifact', 'pr=https://example.invalid/pr/1', '--artifact', 'log=out.txt', '--body', '-']),
    { task: 5, summary: 'parser done', branch: 'agent/p', commit: 'abc1234', checks: 'passed', artifacts: { pr: 'https://example.invalid/pr/1', log: 'out.txt' }, resultBody: '-' },
  );
  assert.throws(() => parseTaskArgs('done', ['5']), /usage: agent task done/);
  assert.throws(() => parseTaskArgs('done', ['5', '--summary', 's', '--checks', 'maybe']), /invalid --checks/);
  assert.throws(() => parseTaskArgs('submit', ['5', '--summary', 's', '--artifact', 'novalue']), /invalid --artifact/);
});

test('parseTaskArgs edit / dep / unknown', () => {
  assert.deepEqual(parseTaskArgs('edit', ['2', '--title', 'new', '--priority', '0', '--label', 'x', '--no-review']), { task: 2, title: 'new', priority: 0, labels: ['x'], review: false });
  assert.throws(() => parseTaskArgs('edit', ['2']), /nothing to edit/);
  assert.deepEqual(parseTaskArgs('dep', ['add', '#3', '1']), { action: 'add', task: 3, on: 1 });
  assert.deepEqual(parseTaskArgs('dep', ['rm', '3', '#1']), { action: 'rm', task: 3, on: 1 });
  assert.throws(() => parseTaskArgs('dep', ['move', '3', '1']), /usage: agent task dep/);
  assert.throws(() => parseTaskArgs('dep', ['add', '3']), /usage/);
  assert.throws(() => parseTaskArgs('bogus', []), /usage: agent task add\|list/);
  assert.throws(() => parseTaskArgs(undefined, []), /usage/);
  assert.equal(TASK_SUBS.length, 17);
  assert.equal(taskNumber('#12', 'u'), 12);
  assert.throws(() => taskNumber('0', 'u'), /invalid task number/);
});

test('a flag value may start with -- ; an artifact key may be given once', () => {
  assert.deepEqual(parseTaskArgs('block', ['3', '--reason', '--force broke it']), { task: 3, reason: '--force broke it' });
  assert.deepEqual(parseTaskArgs('fail', ['3', '--error', '--json']), { task: 3, error: '--json' });
  assert.throws(() => parseTaskArgs('done', ['3', '--summary', 's', '--artifact', 'pr=a', '--artifact', 'pr=b']), /--artifact pr given twice/);
  assert.throws(() => parseTaskArgs('block', ['3', '--reason']), /usage: agent task block/);
});

test('taskExitCode: 0 ok, 1 error, 4 when claim found nothing ready', () => {
  assert.equal(taskExitCode('claim', { ok: true, task: { seq: 1 } }), 0);
  assert.equal(taskExitCode('claim', { ok: true, task: null }), 4);
  assert.equal(taskExitCode('list', { ok: true }), 0);
  assert.equal(taskExitCode('done', { ok: false, error: 'x' }), 1);
});

test('formatRelayLogLine shows task events with the state change', () => {
  const line = formatRelayLogLine(JSON.stringify({ ts: 't', event: 'task_claim', caller: { id: 'c1' }, team: 'r1', task: 3, from: 'open', to: 'claimed', textLen: 4, textHead: 'demo' }));
  assert.match(line, /task_claim/);
  assert.match(line, /team=r1  task=3  from=open  to=claimed/);
});

test('parseBoardArgs read / teams / clear', () => {
  assert.deepEqual(parseBoardArgs('read', []), {});
  assert.deepEqual(
    parseBoardArgs('read', ['--new', '--since', '4', '--tail=500', '--kind', 'done', '--author', 't2', '--search', '100%', '--team', 'root1']),
    { new: true, since: 4, tail: 200, kind: 'done', author: 't2', search: '100%', team: 'root1' },
  );
  assert.deepEqual(parseBoardArgs('read', ['--since', '0']), { since: 0 });
  assert.throws(() => parseBoardArgs('read', ['--tail', '0']), /usage/);
  assert.throws(() => parseBoardArgs('read', ['--tail']), /usage/);
  assert.throws(() => parseBoardArgs('read', ['--bogus']), /usage/);
  assert.throws(() => parseBoardArgs('read', ['extra']), /usage/);
  assert.throws(() => parseBoardArgs('read', ['--kind', 'x']), /invalid kind/);
  assert.deepEqual(parseBoardArgs('teams', []), {});
  assert.throws(() => parseBoardArgs('teams', ['x']), /usage/);
  assert.deepEqual(parseBoardArgs('clear', []), {});
  // No caller-less clear of another team: --team is not an option of clear.
  assert.throws(() => parseBoardArgs('clear', ['--team', 'root1']), /usage: agent board clear/);
  assert.throws(() => parseBoardArgs('clear', ['root1']), /usage/);
  assert.throws(() => parseBoardArgs(undefined, []), /post\|read\|teams\|clear/);
});

test('boardTeamRows marks this tab\'s team and closed roots', () => {
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  const rows = boardTeamRows([
    { team: 'r1', teamName: 'lead', posts: 3, members: 2, lastTs: new Date(2026, 10, 16, 14, 5).getTime(), open: true, mine: true },
    { team: 'r2', posts: 0, members: 0, lastTs: null, open: false },
  ], now);
  assert.deepEqual(rows, [
    { team: 'r1 *', name: 'lead', posts: 3, members: 2, last: '14:05', root: 'open' },
    { team: 'r2', name: '-', posts: 0, members: 0, last: '-', root: 'closed' },
  ]);
});

test('formatRelayLogLine shows board events without the full text', () => {
  const line = formatRelayLogLine(JSON.stringify({ ts: 't', event: 'board_post', caller: { id: 't2' }, team: 'r1', kind: 'finding', seq: 4, textLen: 300, textHead: 'bug in auth' }));
  assert.match(line, /board_post/);
  assert.match(line, /team=r1  kind=finding  seq=4/);
  assert.match(line, /"bug in auth…" \(300 chars\)/);
  assert.match(formatRelayLogLine(JSON.stringify({ ts: 't', event: 'board_clear', team: 'r1', removed: 2 })), /team=r1  removed=2/);
});

test('global options stop at -- (words after it reach the subcommand verbatim)', () => {
  const ctl = new URL('../scripts/bbarit-ctl.mjs', import.meta.url).pathname;
  // `agent board post` with no app reachable fails, but parsing happens first: an unknown
  // option before -- is refused locally, and -- keeps --json out of the global flags.
  const bad = spawnSync(process.execPath, [ctl, 'agent', 'board', 'post', 'x', '--verbose'], { encoding: 'utf8', env: { ...process.env, BBARIT_TERMINAL_ID: '' } });
  assert.match(bad.stderr + bad.stdout, /unknown option for agent board post: --verbose/);
  const help = spawnSync(process.execPath, [ctl, 'agent', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /agent board post \[--kind <kind>\] \[--task <#>\] \[--\] <text…>/);
  assert.match(help.stdout, /claim <#> \| --next/);
  const badTask = spawnSync(process.execPath, [ctl, 'agent', 'task', 'claim', '3', '--verbose'], { encoding: 'utf8', env: { ...process.env, BBARIT_TERMINAL_ID: '' } });
  assert.match(badTask.stderr + badTask.stdout, /unknown option for agent task claim: --verbose/);
  assert.doesNotMatch(help.stdout, /agent board clear \[--team/);
});

