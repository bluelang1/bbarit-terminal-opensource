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
  BRIDGE_UNREACHABLE,
} from '../scripts/bbarit-ctl.mjs';

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
