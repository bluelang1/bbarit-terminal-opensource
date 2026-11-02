import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTabState } from './programStatus';
import { MIN_SUBMIT_DELAY_MS, noteHumanInput, queueAutoInput, resetInputGate, setInputGateHost } from './inputGate';
import { queueButtonInput } from './buttonInput';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const T = 'term-1';

function hostTerminal(state?: AgentTabState) {
  const writes: string[] = [];
  setInputGateHost({
    getWriter: (id) => (id === T ? (data: string) => { writes.push(data); } : null),
    getAgentState: () => state,
    isBracketedPaste: () => false,
  });
  return writes;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetInputGate();
  invokeMock.mockReset();
});

afterEach(() => {
  resetInputGate();
  vi.useRealTimers();
});

describe('queueButtonInput', () => {
  it('writes through a blocked agent and without waiting for the quiet window', async () => {
    const writes = hostTerminal('blocked');
    noteHumanInput(T); // the user just typed, then clicked the button
    const done = queueButtonInput(T, '/review', { submit: true, submitDelayMs: MIN_SUBMIT_DELAY_MS });
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(['/review']);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ ok: true, waitedMs: 0 });
    expect(writes).toEqual(['/review', '\r']);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('sends the text raw without Enter when submit is false', async () => {
    const writes = hostTerminal();
    await expect(queueButtonInput(T, "'/tmp/a b.png' ", { submit: false })).resolves.toMatchObject({ ok: true });
    expect(writes).toEqual(["'/tmp/a b.png' "]);
  });

  it('serializes with other queued writes to the same terminal', async () => {
    const writes = hostTerminal();
    const first = queueAutoInput(T, 'first', { source: 'kanban', submit: true, force: true, submitDelayMs: 500 });
    const second = queueButtonInput(T, 'second', { submit: true, submitDelayMs: MIN_SUBMIT_DELAY_MS });
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);
    expect(writes).toEqual(['first', '\r', 'second', '\r']);
  });

  it('falls back to write_to_pty when no writer is mounted in this window', async () => {
    invokeMock.mockResolvedValue(undefined);
    const done = queueButtonInput('popout-1', 'pm2 logs', { submit: true, submitDelayMs: MIN_SUBMIT_DELAY_MS });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toMatchObject({ ok: true });
    expect(invokeMock.mock.calls).toEqual([
      ['write_to_pty', { terminalId: 'popout-1', data: 'pm2 logs' }],
      ['write_to_pty', { terminalId: 'popout-1', data: '\r' }],
    ]);
  });

  it('does not send the separate Enter when the direct body write was rejected', async () => {
    invokeMock.mockRejectedValue('PTY not found');
    const done = queueButtonInput('not-yet-1', 'hello world', { submit: true, submitDelayMs: MIN_SUBMIT_DELAY_MS });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toEqual({ ok: false, reason: 'no-writer' });
    expect(invokeMock.mock.calls).toEqual([
      ['write_to_pty', { terminalId: 'not-yet-1', data: 'hello world' }],
    ]);
  });

  it('reports no-writer when the direct PTY write fails', async () => {
    invokeMock.mockRejectedValue('PTY not found');
    const done = queueButtonInput('gone-1', 'hello', { submit: false });
    await expect(done).resolves.toEqual({ ok: false, reason: 'no-writer' });
  });
});
