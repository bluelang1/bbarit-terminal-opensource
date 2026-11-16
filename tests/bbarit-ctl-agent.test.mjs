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
} from '../scripts/bbarit-ctl.mjs';
import fs from 'node:fs';
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
