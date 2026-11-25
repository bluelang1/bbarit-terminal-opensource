import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { de } from '../i18n/de';
import { formatRunnerTime, normalizeRunnerError, normalizeRunnerStatus, runnerSupported, runnerText } from '../terminal/boardRunner';

const SERVER = 'https://board.example.invalid';
const PROG = '/opt/runner/bin/runner-prog';

const h = vi.hoisted(() => ({
  board: {} as Record<string, unknown>,
  invoke: vi.fn(),
  update: vi.fn(),
  pick: vi.fn(),
}));

vi.mock('../config/ConfigContext', () => ({
  useConfig: () => ({
    config: { ...DEFAULT_CONFIG, language: 'en', agents: { ...DEFAULT_CONFIG.agents, board: { ...DEFAULT_CONFIG.agents.board, ...h.board } } },
    updateConfig: h.update,
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (opts: unknown) => h.pick(opts) }));

import { AgentBoardSettings } from './AgentBoardSettings';

const signedIn = { mode: 'server', server: SERVER, serverError: null, signedIn: true, signedInServer: SERVER, serverMatches: true, nickname: 'river', computer: 'studio', tokenPrefix: 'bbt_demo', role: 'member', suspended: false, heldTasks: 0, signInPending: false };
const stopped = { running: false, server: SERVER };
const running = (over: Record<string, unknown> = {}) => ({
  running: true, pid: 4242, server: SERVER, runner: 'studio-runner', account: 'river', startedAt: '2026-11-25T09:00:00Z', mode: 'stream',
  cursor: 10, teams: ['alpha'], wouldTake: ['alpha#3'], lastChangeAt: null, presenceAt: null,
  pool: { min: 1, max: 4, idle: 1, busy: 2, suggestedMax: 3, suggestion: '', limited: [{ product: 'agent-a', until: '2026-11-25T12:00:00Z', untilUnix: 1_795_000_000 }] },
  workers: [
    { id: 'w1', state: 'working', task: 'alpha#2', since: '2026-11-25T09:01:00Z', product: 'agent-a' },
    { id: 'w2', state: 'idle', task: null, since: '2026-11-25T09:00:00Z', product: 'agent-b' },
  ],
  ...over,
});

type Answer = (args: unknown) => unknown;
function answer(map: Record<string, Answer>) {
  h.invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const f = map[cmd] ?? (cmd === 'board_server_status' ? () => signedIn : cmd === 'board_runner_version' ? () => ({ version: 'runner 1.2.3' }) : undefined);
    if (!f) return {};
    return f(args);
  });
}
const calls = (cmd: string) => h.invoke.mock.calls.filter((c) => c[0] === cmd);
const settle = async (ms = 0) => {
  await act(async () => {
    if (ms) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};
const block = () => within(screen.getByTestId('agent-board-runner'));
// Buttons of the runner block (the board server section has its own Save and Refresh).
const button = (name: string) => block().getByRole('button', { name }) as HTMLButtonElement;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const applyUpdate = (prev: Record<string, unknown>) => h.update.mock.calls[h.update.mock.calls.length - 1][0]({ agents: { board: prev } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.board = { mode: 'server', server: { url: SERVER, runnerPath: PROG } };
  h.invoke.mockReset();
  h.update.mockReset();
  h.pick.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runner block in Board server settings', () => {
  it('off when no program is set: explains what a runner is and never runs anything', async () => {
    h.board = { mode: 'server', server: { url: SERVER } };
    answer({});
    render(<AgentBoardSettings />);
    await settle(30_000);
    expect(screen.getByTestId('agent-board-runner-about').textContent).toBe(en['settings.agentBoard.server.runner.about']);
    expect((screen.getByLabelText('Runner program') as HTMLInputElement).value).toBe('');
    expect(calls('board_runner_status').length).toBe(0);
    expect(calls('board_runner_version').length).toBe(0);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('not shown outside Board server mode', async () => {
    h.board = { mode: 'sqlite', server: { url: SERVER, runnerPath: PROG } };
    answer({});
    render(<AgentBoardSettings />);
    await settle(10_000);
    expect(screen.queryByTestId('agent-board-runner')).toBeNull();
    expect(calls('board_runner_status').length).toBe(0);
  });

  it('not running: says so, offers Start (no Stop) and shows the version line', async () => {
    answer({ board_runner_status: () => stopped });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-stopped').textContent).toBe('No runner is running for this board server.');
    expect(button('Start').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByText(/Program: runner 1\.2\.3/)).toBeTruthy();
    // The commands that run the program get no arguments from here.
    expect(calls('board_runner_status')[0][1]).toBeUndefined();
    expect(calls('board_runner_version')[0][1]).toBeUndefined();
  });

  it('running: name, account, mode, since, the pool line, a usage-limited product and the workers', async () => {
    answer({ board_runner_status: () => running() });
    render(<AgentBoardSettings />);
    await settle();
    const info = screen.getByTestId('agent-board-runner-running').textContent ?? '';
    for (const part of ['Runner name', 'studio-runner', 'Account', 'river', 'Connection', 'live', 'Running since', new Date('2026-11-25T09:00:00Z').toLocaleString()]) expect(info).toContain(part);
    expect(screen.getByTestId('agent-board-runner-pool').textContent).toBe('Workers: 1 idle, 2 busy, at most 4 (suggested at most 3).');
    expect(screen.getByTestId('agent-board-runner-limited').textContent).toBe(`agent-a is usage-limited until ${new Date('2026-11-25T12:00:00Z').toLocaleString()}.`);
    const rows = screen.getByTestId('agent-board-runner-workers').querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('working');
    expect(rows[0].textContent).toContain('alpha#2');
    expect(rows[0].textContent).toContain('agent-a');
    expect(rows[1].textContent).toContain('idle');
    expect(rows[1].textContent).toContain('-');
    // Start is not offered while one runs.
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(button('Stop').disabled).toBe(false);
  });

  it('workers off: the pool line says so', async () => {
    answer({ board_runner_status: () => running({ pool: null, workers: [], mode: 'polling' }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-pool').textContent).toBe('Workers are off.');
    expect(screen.getByTestId('agent-board-runner-running').textContent).toContain('checking periodically');
    expect(screen.queryByTestId('agent-board-runner-workers')).toBeNull();
  });

  it('text from the program is rendered as text, never as HTML', async () => {
    answer({ board_runner_status: () => running({ runner: '<img src=x onerror="alert(1)">', workers: [{ id: 'w', state: '<b>odd</b>', task: '<script>x</script>', product: 'p' }] }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-running').textContent).toContain('<img src=x onerror="alert(1)">');
    expect(screen.getByTestId('agent-board-runner-workers').textContent).toContain('<b>odd</b>');
    expect(document.querySelector('[data-testid="agent-board-runner"] img')).toBeNull();
    expect(document.querySelector('[data-testid="agent-board-runner"] script')).toBeNull();
    expect(document.querySelector('[data-testid="agent-board-runner"] b')).toBeNull();
  });

  it.each([
    ['not found', { kind: 'not_found', detail: PROG }, `The program was not found: ${PROG}`],
    ['not executable', { kind: 'not_executable', detail: PROG }, `The program cannot be run (not executable): ${PROG}`],
    ['not signed in', { kind: 'failed', detail: 'not signed in: run the login command first' }, 'The runner program reported an error (if it says it is not signed in, sign in with the program in a terminal): not signed in: run the login command first'],
    ['not the expected JSON', { kind: 'bad_output', detail: 'not one JSON object: hello' }, "The program's answer was not the expected state: not one JSON object: hello"],
    ['a timeout', { kind: 'timeout', detail: 'no answer within 5 s' }, 'The program did not answer in time (no answer within 5 s).'],
    ['an unknown kind', { kind: 'weird', detail: 'x' }, 'The runner command failed: x'],
    ['a plain string', 'boom', 'The runner program reported an error (if it says it is not signed in, sign in with the program in a terminal): boom'],
  ])('a status error (%s) is shown plainly, with only Refresh offered', async (_name, err, text) => {
    answer({
      board_runner_status: () => {
        throw err;
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-error').textContent).toBe(text);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(button('Refresh').disabled).toBe(false);
  });

  it('an answer that is not a status is shown as unexpected output', async () => {
    answer({ board_runner_status: () => ({ hello: 1 }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-error').textContent).toBe("The program's answer was not the expected state: -");
  });

  it('a version error (program missing) is shown under the path', async () => {
    answer({
      board_runner_status: () => {
        throw { kind: 'not_found', detail: PROG };
      },
      board_runner_version: () => {
        throw { kind: 'not_found', detail: PROG };
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-runner-version-error').textContent).toBe(`The program was not found: ${PROG}`);
  });

  it('Start: every button is disabled while it runs, a double click starts once, then the state shows', async () => {
    const started = deferred<unknown>();
    let isRunning = false;
    answer({
      board_runner_status: () => (isRunning ? running() : stopped),
      board_runner_start: () => started.promise,
    });
    render(<AgentBoardSettings />);
    await settle();
    const start = button('Start');
    fireEvent.click(start);
    fireEvent.click(start);
    await settle();
    expect(calls('board_runner_start').length).toBe(1);
    expect(calls('board_runner_start')[0][1]).toBeUndefined();
    expect(button('Starting… (up to 10 seconds)').disabled).toBe(true);
    for (const name of ['Refresh', 'Choose…']) expect(button(name).disabled).toBe(true);
    // No status read runs the program while Start does.
    const reads = calls('board_runner_status').length;
    await settle(20_000);
    expect(calls('board_runner_status').length).toBe(reads);
    isRunning = true;
    started.resolve(running());
    await settle();
    expect(screen.getByTestId('agent-board-runner-message').textContent).toBe('The runner is running.');
    expect(screen.getByTestId('agent-board-runner-running')).toBeTruthy();
    expect(button('Stop').disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('a failed Start shows why and keeps Start offered', async () => {
    answer({
      board_runner_status: () => stopped,
      board_runner_start: () => {
        throw { kind: 'start_failed', detail: 'the runner ended with exit code 2\nnot signed in' };
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Start'));
    await settle();
    expect(screen.getByTestId('agent-board-runner-message').textContent).toBe('The runner stopped right after starting: the runner ended with exit code 2\nnot signed in');
    expect(button('Start').disabled).toBe(false);
  });

  it('Stop: confirms and shows not running', async () => {
    let isRunning = true;
    answer({
      board_runner_status: () => (isRunning ? running() : stopped),
      board_runner_stop: () => {
        isRunning = false;
        return stopped;
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Stop'));
    await settle();
    expect(calls('board_runner_stop').length).toBe(1);
    expect(screen.getByTestId('agent-board-runner-message').textContent).toBe('The runner stopped.');
    expect(screen.getByTestId('agent-board-runner-stopped')).toBeTruthy();
    expect(button('Start')).toBeTruthy();
  });

  it('polls without overlap and backs off after a slow answer', async () => {
    const slow = deferred<unknown>();
    let n = 0;
    answer({ board_runner_status: () => (++n === 1 ? slow.promise : stopped) });
    render(<AgentBoardSettings />);
    await settle();
    expect(calls('board_runner_status').length).toBe(1);
    // Still waiting for the first answer: no second call.
    await settle(4000);
    expect(calls('board_runner_status').length).toBe(1);
    slow.resolve(stopped);
    await settle();
    // It took ~4 s: the next read waits 3 x that (~12 s), not the 5 s base.
    await settle(10_000);
    expect(calls('board_runner_status').length).toBe(1);
    await settle(3_000);
    expect(calls('board_runner_status').length).toBe(2);
    // A quick answer: back to the 5 s base.
    await settle(5_200);
    expect(calls('board_runner_status').length).toBe(3);
  });

  it('a manual Refresh while a read is in flight shares it', async () => {
    const slow = deferred<unknown>();
    answer({ board_runner_status: () => slow.promise });
    render(<AgentBoardSettings />);
    await settle();
    const refresh = button('Refresh');
    fireEvent.click(refresh);
    await settle();
    expect(refresh.disabled).toBe(true);
    // `fresh` queues one rerun after the current call, never a parallel one.
    expect(calls('board_runner_status').length).toBe(1);
    slow.resolve(stopped);
    await settle();
    expect(calls('board_runner_status').length).toBe(2);
  });

  it('stops polling while the window is hidden and after the screen closes', async () => {
    answer({ board_runner_status: () => stopped });
    const view = render(<AgentBoardSettings />);
    await settle();
    expect(calls('board_runner_status').length).toBe(1);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(30_000);
    expect(calls('board_runner_status').length).toBe(1);
    vis.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle(1000);
    expect(calls('board_runner_status').length).toBe(2);
    view.unmount();
    await settle(60_000);
    expect(calls('board_runner_status').length).toBe(2);
  });

  it('Save checks the path on the host first and stores it next to the server address', async () => {
    h.board = { mode: 'server', server: { url: SERVER } };
    answer({
      board_runner_check_path: (args) => {
        const p = (args as { path: string }).path;
        if (p === 'runner') throw { kind: 'not_absolute', detail: 'runner' };
        return { path: p.trim() };
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    const input = screen.getByLabelText('Runner program') as HTMLInputElement;
    expect(button('Save path').disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'runner' } });
    fireEvent.click(button('Save path'));
    await settle();
    expect(screen.getByTestId('agent-board-runner-path-error').textContent).toBe('Enter the full path (starting with /): runner');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(h.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: ` ${PROG} ` } });
    fireEvent.click(button('Save path'));
    await settle();
    expect(calls('board_runner_check_path').at(-1)?.[1]).toEqual({ path: ` ${PROG} ` });
    expect(h.update).toHaveBeenCalledTimes(1);
    const next = applyUpdate({ mode: 'server', server: { url: SERVER } });
    expect(next.agents.board.server).toEqual({ url: SERVER, runnerPath: PROG });
    expect(screen.getByTestId('agent-board-runner-message').textContent).toBe(`Saved the runner program ${PROG}.`);
  });

  it('Choose… picks a file and saves it the same way; Clear turns the block off', async () => {
    h.pick.mockResolvedValue('/usr/local/bin/picked-runner');
    answer({ board_runner_status: () => stopped, board_runner_check_path: (args) => ({ path: (args as { path: string }).path }) });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Choose…'));
    await settle();
    expect(h.pick).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }));
    expect(calls('board_runner_check_path')[0][1]).toEqual({ path: '/usr/local/bin/picked-runner' });
    expect(applyUpdate({ server: { url: SERVER, runnerPath: PROG } }).agents.board.server).toEqual({ url: SERVER, runnerPath: '/usr/local/bin/picked-runner' });
    fireEvent.click(button('Clear'));
    await settle();
    expect(calls('board_runner_check_path')[1][1]).toEqual({ path: '' });
    expect(applyUpdate({ server: { url: SERVER, runnerPath: PROG } }).agents.board.server).toEqual({ url: SERVER, runnerPath: '' });
  });

  it('Windows: says the runner is not supported yet and runs nothing', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    answer({ board_runner_status: () => stopped });
    render(<AgentBoardSettings />);
    await settle(10_000);
    expect(screen.getByTestId('agent-board-runner-unsupported').textContent).toBe('The runner is not supported on Windows yet.');
    expect(calls('board_runner_status').length).toBe(0);
    expect(calls('board_runner_version').length).toBe(0);
  });
});

describe('runner data from the host', () => {
  it('normalizes a status defensively', () => {
    expect(normalizeRunnerStatus({ running: false, server: SERVER, pid: 1 })).toEqual({ running: false, server: SERVER });
    expect(normalizeRunnerStatus(null)).toBeNull();
    expect(normalizeRunnerStatus({ running: 'yes' })).toBeNull();
    const s = normalizeRunnerStatus(running({ runner: `a\u0007b‮${'x'.repeat(500)}`, workers: Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, state: 'idle' })), pool: { max: 'many', limited: 'no' } }));
    if (!s || !s.running) throw new Error('expected running');
    expect(s.runner.startsWith('a b x')).toBe(true);
    expect(s.runner.length).toBe(120);
    expect(s.workers.length).toBe(64);
    expect(s.pool).toEqual({ min: null, max: null, idle: null, busy: null, suggestedMax: null, suggestion: '', limited: [] });
  });

  it('normalizes errors and times', () => {
    expect(normalizeRunnerError({ kind: 'failed', detail: 'line one\nline two\u0007' })).toEqual({ kind: 'failed', detail: 'line one\nline two' });
    expect(normalizeRunnerError(new Error('x'))).toEqual({ kind: 'failed', detail: 'x' });
    expect(normalizeRunnerError({ kind: 'failed', detail: 'e'.repeat(5000) }).detail.length).toBe(2000);
    expect(formatRunnerTime(null)).toBe('-');
    expect(formatRunnerTime('soon')).toBe('soon');
    expect(formatRunnerTime(1_795_000_000)).toBe(new Date(1_795_000_000_000).toLocaleString());
    expect(formatRunnerTime(1_795_000_000_000)).toBe(new Date(1_795_000_000_000).toLocaleString());
    expect(runnerText(5)).toBe('');
    expect(runnerSupported('MacIntel')).toBe(true);
    expect(runnerSupported('Linux x86_64')).toBe(true);
    expect(runnerSupported('Win32')).toBe(false);
  });

  it('every runner text exists in English and Korean (written in Korean); other locales have it too', () => {
    const keys = (Object.keys(en) as Array<keyof typeof en>).filter((k) => k.startsWith('settings.agentBoard.server.runner.'));
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) {
      expect(en[k], k).toBeTruthy();
      expect(/[가-힣]/.test(ko[k]), `${k}: ${ko[k]}`).toBe(true);
      expect(de[k], k).toBeTruthy();
    }
  });
});
