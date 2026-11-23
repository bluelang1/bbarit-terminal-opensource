import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../config/schema';
import { en } from '../i18n/en';
import { ko } from '../i18n/ko';
import { checkServerUrl, normalizeSignInPoll, formatRemaining } from '../terminal/agentBoardStorage';

const SERVER = 'https://board.example.invalid';
// Never shown: the host only ever sends the prefix. A leaked value must not reach the DOM.
const FAKE_TOKEN = 'bbt_demo-FULL-TOKEN-NEVER-SHOWN';

const h = vi.hoisted(() => ({
  board: {} as Record<string, unknown>,
  invoke: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../config/ConfigContext', () => ({
  useConfig: () => ({
    config: { ...DEFAULT_CONFIG, language: 'en', agents: { ...DEFAULT_CONFIG.agents, board: { ...DEFAULT_CONFIG.agents.board, ...h.board } } },
    updateConfig: h.update,
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: (cmd: string, args?: unknown) => h.invoke(cmd, args) }));

import { AgentBoardSettings } from './AgentBoardSettings';

const signedOut = (over: Record<string, unknown> = {}) => ({ mode: 'server', server: SERVER, serverError: null, signedIn: false, signInPending: false, ...over });
const signedIn = (over: Record<string, unknown> = {}) => ({
  mode: 'server', server: SERVER, serverError: null, signedIn: true, signedInServer: SERVER, serverMatches: true,
  nickname: 'river', accountUid: 'acct-1', computer: 'studio', tokenPrefix: 'bbt_demo', role: 'member',
  suspended: false, suspendedUntil: null, heldTasks: 2, signInPending: false, token: FAKE_TOKEN, ...over,
});
const started = (over: Record<string, unknown> = {}) => ({
  server: SERVER, userCode: 'WDJB-MJHT', verificationUri: `${SERVER}/device`, verificationUriComplete: `${SERVER}/device?code=WDJB-MJHT`,
  expiresIn: 600, interval: 2, opened: true, ...over,
});

type Answer = (args: unknown) => unknown;
function answer(map: Record<string, Answer>) {
  h.invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const f = map[cmd];
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

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const radio = (m: string) => document.getElementById(`agent-board-mode-${m}`) as HTMLInputElement;
const applyUpdate = (prev: Record<string, unknown>) => h.update.mock.calls[h.update.mock.calls.length - 1][0]({ agents: { board: prev } });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.board = { mode: 'server', server: { url: SERVER } };
  h.invoke.mockReset();
  h.update.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('board server address check (as Rust check_server_url)', () => {
  it('accepts https and http to this computer only, returns the origin', () => {
    expect(checkServerUrl(' https://Board.Example.invalid/ ')).toEqual({ ok: true, origin: 'https://board.example.invalid' });
    expect(checkServerUrl('https://board.example.invalid:443')).toEqual({ ok: true, origin: 'https://board.example.invalid' });
    expect(checkServerUrl('http://127.0.0.1:8787')).toEqual({ ok: true, origin: 'http://127.0.0.1:8787' });
    expect(checkServerUrl('http://localhost:8787')).toEqual({ ok: true, origin: 'http://localhost:8787' });
    expect(checkServerUrl('http://[::1]:8787')).toEqual({ ok: true, origin: 'http://[::1]:8787' });
    expect(checkServerUrl('')).toEqual({ ok: false, error: 'empty' });
    expect(checkServerUrl('board.example.invalid')).toEqual({ ok: false, error: 'invalid' });
    expect(checkServerUrl('ftp://board.example.invalid')).toEqual({ ok: false, error: 'invalid' });
    expect(checkServerUrl('http://board.example.invalid')).toEqual({ ok: false, error: 'https' });
    expect(checkServerUrl('https://me:pw@board.example.invalid')).toEqual({ ok: false, error: 'userinfo' });
    expect(checkServerUrl('https://board.example.invalid/api')).toEqual({ ok: false, error: 'path' });
    expect(checkServerUrl('https://board.example.invalid/?')).toEqual({ ok: false, error: 'path' });
    expect(checkServerUrl('https://board.example.invalid#x')).toEqual({ ok: false, error: 'path' });
    // A name that only starts like a loopback address is another computer.
    expect(checkServerUrl('http://127.0.0.1.evil.example')).toEqual({ ok: false, error: 'https' });
    expect(checkServerUrl('HTTP://LOCALHOST')).toEqual({ ok: true, origin: 'http://localhost' });
  });

  it('clamps the poll wait the host asks for and formats the countdown', () => {
    expect(normalizeSignInPoll({ state: 'pending', retryInMs: 3000 })).toEqual({ state: 'pending', retryInMs: 3000 });
    expect(normalizeSignInPoll({ state: 'pending', retryInMs: 1 })).toEqual({ state: 'pending', retryInMs: 500 });
    expect(normalizeSignInPoll({ state: 'pending', retryInMs: 10 ** 9 })).toEqual({ state: 'pending', retryInMs: 60_000 });
    expect(normalizeSignInPoll({ state: 'weird' })).toEqual({ state: 'error', message: 'unexpected answer' });
    expect(formatRemaining(600_000)).toBe('10:00');
    expect(formatRemaining(59_001)).toBe('1:00');
    expect(formatRemaining(-5)).toBe('0:00');
  });
});

describe('Agent team board settings: board server mode', () => {
  it('signed out: the fourth usage type is selected and the other types\' server-only controls are hidden', async () => {
    answer({ board_server_status: () => signedOut() });
    render(<AgentBoardSettings />);
    await settle();
    expect(document.querySelectorAll('input[type=radio][name="agent-board-mode"]').length).toBe(4);
    expect(radio('server').checked).toBe(true);
    expect(radio('sqlite').checked).toBe(false);
    expect(screen.getByTestId('agent-board-server-signed-out').textContent).toBe('This computer is not signed in.');
    expect(button('Sign in').disabled).toBe(false);
    expect(screen.getByText(/these are not available: clearing a board/)).toBeTruthy();
    // Refused by the host in this mode: machine name, sync, Copy data, Clean up.
    expect(document.getElementById('agent-board-host-name')).toBeNull();
    expect(screen.queryByTestId('agent-board-sync')).toBeNull();
    expect(screen.queryByText('Copy data')).toBeNull();
    expect(screen.queryByRole('button', { name: en['settings.agentBoard.cleanup.run'] })).toBeNull();
    // The address field is labelled and holds the saved address.
    expect((screen.getByLabelText('Server address') as HTMLInputElement).value).toBe(SERVER);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('Sign in shows the code, the approval page and a countdown; polls at the pace the host gives', async () => {
    const polls: Array<Record<string, unknown>> = [{ state: 'pending', retryInMs: 3000 }, { state: 'pending', retryInMs: 4000 }, { state: 'signed_in', server: SERVER, nickname: 'river', computer: 'studio', tokenPrefix: 'bbt_demo', token: FAKE_TOKEN }];
    let signed = false;
    answer({
      board_server_status: () => (signed ? signedIn() : signedOut()),
      board_server_sign_in_start: () => started({ opened: false }),
      board_server_sign_in_poll: () => {
        const r = polls.shift() ?? { state: 'idle' };
        if (r.state === 'signed_in') signed = true;
        return r;
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.change(screen.getByLabelText('Computer name'), { target: { value: 'studio' } });
    fireEvent.click(button('Sign in'));
    await settle();
    expect(calls('board_server_sign_in_start')[0][1]).toEqual({ server: SERVER, computerName: 'studio' });
    const panel = screen.getByTestId('agent-board-server-code');
    expect(panel.textContent).toContain('WDJB-MJHT');
    expect(screen.getByLabelText('Sign-in code W D J B - M J H T')).toBeTruthy();
    expect(panel.textContent).toContain(`Approval page: ${SERVER}/device?code=WDJB-MJHT`);
    expect(button('Open approval page')).toBeTruthy();
    expect(panel.textContent).toContain('The browser was not opened: open the approval page yourself.');
    expect(screen.getByTestId('agent-board-server-waiting').textContent).toBe('Waiting for approval… 10:00 left');
    expect(document.activeElement).toBe(button('Copy code'));

    // First poll after `interval` (2 s), then after each retryInMs (3 s, 4 s): never earlier.
    await settle(1900);
    expect(calls('board_server_sign_in_poll').length).toBe(0);
    await settle(200);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    await settle(2700);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    await settle(400);
    expect(calls('board_server_sign_in_poll').length).toBe(2);
    await settle(3600);
    expect(calls('board_server_sign_in_poll').length).toBe(2);
    await settle(400);
    expect(calls('board_server_sign_in_poll').length).toBe(3);
    await settle();
    expect(screen.queryByTestId('agent-board-server-code')).toBeNull();
    expect(screen.getByTestId('agent-board-server-message').textContent).toBe('Signed in as river on studio.');
    expect(screen.getByTestId('agent-board-server-account').textContent).toContain('river');
    // Done: no more polls.
    await settle(60_000);
    expect(calls('board_server_sign_in_poll').length).toBe(3);
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
  });

  it('the countdown runs down while waiting', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => started({ expiresIn: 90, interval: 60 }),
      board_server_sign_in_poll: () => ({ state: 'pending', retryInMs: 60_000 }),
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle();
    expect(screen.getByTestId('agent-board-server-waiting').textContent).toBe('Waiting for approval… 1:30 left');
    expect(screen.queryByText('The browser was not opened: open the approval page yourself.')).toBeNull();
    for (let i = 0; i < 31; i++) await settle(1000);
    expect(screen.getByTestId('agent-board-server-waiting').textContent).toMatch(/Waiting for approval… 0:(59|58) left/);
  });

  it('Cancel stops polling and cancels on the host', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => started(),
      board_server_sign_in_poll: () => ({ state: 'pending', retryInMs: 1000 }),
      board_server_sign_in_cancel: () => ({ cancelled: true }),
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle(2100);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    fireEvent.click(button('Cancel'));
    await settle();
    expect(calls('board_server_sign_in_cancel').length).toBe(1);
    expect(screen.queryByTestId('agent-board-server-code')).toBeNull();
    await settle(30_000);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    expect(button('Sign in')).toBeTruthy();
  });

  it('closing the screen while waiting stops polling and cancels on the host', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => started(),
      board_server_sign_in_poll: () => ({ state: 'pending', retryInMs: 1000 }),
    });
    const view = render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle(2100);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    view.unmount();
    await settle(30_000);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    expect(calls('board_server_sign_in_cancel').length).toBe(1);
  });

  it.each([
    ['denied', { state: 'denied', message: 'the sign-in was denied in the browser' }, 'The sign-in was denied on the approval page.'],
    ['expired', { state: 'expired', message: 'x' }, 'The code expired before it was approved.'],
    ['error', { state: 'error', message: 'cannot reach the board server: refused' }, 'The sign-in failed: cannot reach the board server: refused'],
  ])('%s: says so and offers to try again', async (_name, poll, text) => {
    let starts = 0;
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => {
        starts++;
        return started();
      },
      board_server_sign_in_poll: () => poll,
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle(2100);
    expect(screen.getByRole('alert').textContent).toBe(text);
    const retry = button('Try again');
    expect(document.activeElement).toBe(retry);
    await settle(30_000);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    fireEvent.click(retry);
    await settle();
    expect(starts).toBe(2);
    expect(screen.getByTestId('agent-board-server-code')).toBeTruthy();
  });

  it('a start the host refuses is shown as an error', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => {
        throw new Error('the board server did not start a sign-in: cannot reach the board server');
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('The sign-in failed: the board server did not start a sign-in: cannot reach the board server');
    expect(calls('board_server_sign_in_poll').length).toBe(0);
  });

  it('signed in: account, role, computer, token prefix (never the token), server and held tasks', async () => {
    answer({ board_server_status: () => signedIn() });
    render(<AgentBoardSettings />);
    await settle();
    const acct = screen.getByTestId('agent-board-server-account').textContent ?? '';
    for (const part of ['Account', 'river', 'Role', 'member', 'Computer', 'studio', "This computer's token", 'Server', SERVER, 'Tasks this computer holds', '2']) expect(acct).toContain(part);
    expect(screen.getByTestId('agent-board-server-token').textContent).toBe('starts with bbt_demo (the full token is never shown)');
    expect(screen.queryByTestId('agent-board-server-mismatch')).toBeNull();
    expect(screen.queryByTestId('agent-board-server-suspended')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(FAKE_TOKEN);
  });

  it('warns when the address differs from the signed-in server and offers to sign in to it', async () => {
    answer({ board_server_status: () => signedIn({ signedInServer: 'https://old.example.invalid', serverMatches: false }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-mismatch').textContent).toBe(
      `This computer is signed in to https://old.example.invalid, but the address above is ${SERVER}. Board commands stop until you sign in to the address above or change it back.`,
    );
    expect(button(`Sign in to ${SERVER}`).disabled).toBe(false);
  });

  it('shows a suspension with its date', async () => {
    const until = '2026-12-01T09:00:00Z';
    answer({ board_server_status: () => signedIn({ suspended: true, suspendedUntil: until }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-suspended').textContent).toBe(`Your account on the board server is suspended until ${new Date(until).toLocaleString()}.`);
  });

  it('Sign out asks first (tasks are released), then signs out; "this computer only" sends localOnly', async () => {
    let signed = true;
    answer({
      board_server_status: () => (signed ? signedIn() : signedOut()),
      board_server_sign_out: () => {
        signed = false;
        return { server: SERVER, revoked: true, removed: true };
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign out'));
    const ask = screen.getByRole('alertdialog');
    expect(ask.textContent).toContain(`Sign this computer out of ${SERVER}? The server stops accepting this computer's token, and the tasks it holds (2) are released so others can take them.`);
    expect(calls('board_server_sign_out').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(button('Sign out'));
    const yes = screen.getAllByRole('button', { name: 'Sign out' }).find((b) => screen.getByRole('alertdialog').contains(b)) as HTMLButtonElement;
    expect(document.activeElement).toBe(yes);
    fireEvent.click(yes);
    await settle();
    expect(calls('board_server_sign_out')[0][1]).toEqual({ localOnly: false });
    expect(screen.getByTestId('agent-board-server-message').textContent).toBe('Signed out.');
    expect(screen.getByTestId('agent-board-server-signed-out')).toBeTruthy();

    signed = true;
    cleanup();
    h.invoke.mockClear();
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign out on this computer only'));
    expect(screen.getByRole('alertdialog').textContent).toContain('Forget the sign-in on this computer without asking the server?');
    const local = screen.getAllByRole('button', { name: 'Sign out on this computer only' }).find((b) => screen.getByRole('alertdialog').contains(b)) as HTMLButtonElement;
    fireEvent.click(local);
    await settle();
    expect(calls('board_server_sign_out')[0][1]).toEqual({ localOnly: true });
    expect(screen.getByTestId('agent-board-server-message').textContent).toBe('Forgot the sign-in on this computer.');
  });

  it('a failed sign-out keeps the sign-in and shows the host text', async () => {
    answer({
      board_server_status: () => signedIn(),
      board_server_sign_out: () => {
        throw new Error('team board unavailable: cannot reach the board server (nothing removed; sign out on this computer only to forget the sign-in anyway)');
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign out'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' }).find((b) => screen.getByRole('alertdialog').contains(b)) as HTMLButtonElement);
    await settle();
    expect(screen.getByTestId('agent-board-server-message').textContent).toContain('nothing removed');
    expect(screen.getByTestId('agent-board-server-account')).toBeTruthy();
  });

  it('validates the address as typed and saves only on Save', async () => {
    answer({ board_server_status: () => signedOut() });
    render(<AgentBoardSettings />);
    await settle();
    const input = screen.getByLabelText('Server address') as HTMLInputElement;
    const err = () => screen.getByTestId('agent-board-server-url-error').textContent;
    fireEvent.change(input, { target: { value: 'http://board.example.com' } });
    expect(err()).toBe('Use https:// (http:// only for this computer).');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(button('Save').disabled).toBe(true);
    // Sign-in waits for the address to be saved.
    expect(button('Sign in').disabled).toBe(true);
    expect(screen.getByText('Save the address first.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'https://board.example.com/api' } });
    expect(err()).toBe('Only the server: nothing after it (no path, ? or #).');
    fireEvent.change(input, { target: { value: '' } });
    expect(err()).toBe("Enter the board server's address.");
    expect(h.update).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'https://Board.Example.com/' } });
    expect(err()).toBe('');
    fireEvent.click(button('Save'));
    expect(h.update).toHaveBeenCalledTimes(1);
    const next = applyUpdate({ mode: 'server', server: { url: SERVER } });
    expect(next.agents.board.server).toEqual({ url: 'https://board.example.com' });
    expect(next.agents.board.mode).toBe('server');
  });

  it("shows the host's words when the saved address is not usable", async () => {
    h.board = { mode: 'server' };
    answer({ board_server_status: () => signedOut({ server: '', serverError: 'the board server address is not set (Settings → Agent team board)' }) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-url-error').textContent).toBe("Enter the board server's address.");
    expect(button('Sign in').disabled).toBe(true);
  });

  it('entering board server mode asks first and says nothing is copied', async () => {
    h.board = { mode: 'sqlite', server: { url: SERVER } };
    answer({});
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AgentBoardSettings />);
    await settle();
    expect(radio('sqlite').checked).toBe(true);
    expect(screen.queryByTestId('agent-board-server')).toBeNull();
    expect(calls('board_server_status').length).toBe(0);
    fireEvent.click(radio('server'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain('nothing is copied to the server');
    expect(h.update).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(radio('server'));
    expect(h.update).toHaveBeenCalledTimes(1);
    const next = applyUpdate({ mode: 'sqlite', server: { url: SERVER } });
    expect(next.agents.board.mode).toBe('server');
    expect(next.agents.board.server).toEqual({ url: SERVER });
  });

  it('leaving while signed in offers to sign out; never switches without an answer', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    answer({
      board_server_status: () => signedIn(),
      board_server_sign_out: () => ({ server: SERVER, revoked: true, removed: true }),
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(radio('sqlite'));
    const ask = screen.getByTestId('agent-board-server-leave');
    expect(ask.textContent).toContain("Switch this computer's team board away from the board server?");
    expect(ask.textContent).toContain(`still signed in to ${SERVER}`);
    expect(ask.textContent).toContain('(2)');
    expect(h.update).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Sign out and switch'));
    // Cancel: nothing changes.
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).find((b) => ask.contains(b)) as HTMLButtonElement);
    expect(screen.queryByTestId('agent-board-server-leave')).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
    // Sign out and switch: the sign-out runs first, then the usage type changes (address kept).
    fireEvent.click(radio('sqlite'));
    fireEvent.click(button('Sign out and switch'));
    await settle();
    expect(calls('board_server_sign_out')[0][1]).toEqual({ localOnly: false });
    expect(h.update).toHaveBeenCalledTimes(1);
    const next = applyUpdate({ mode: 'server', server: { url: SERVER } });
    expect(next.agents.board.mode).toBe('sqlite');
    expect(next.agents.board.server).toEqual({ url: SERVER });
  });

  it('leaving: "stay signed in" switches without signing out; a failed sign-out does not switch', async () => {
    answer({
      board_server_status: () => signedIn(),
      board_server_sign_out: () => {
        throw new Error('team board unavailable: cannot reach the board server');
      },
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(radio('sync'));
    fireEvent.click(button('Sign out and switch'));
    await settle();
    expect(h.update).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot reach the board server/)).toBeTruthy();
    fireEvent.click(radio('sync'));
    fireEvent.click(button('Switch, stay signed in'));
    await settle();
    expect(calls('board_server_sign_out').length).toBe(1);
    expect(applyUpdate({ mode: 'server' }).agents.board.mode).toBe('sync');
  });

  it('leaving while signed out asks with a plain Switch', async () => {
    answer({ board_server_status: () => signedOut() });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(radio('sqlite'));
    expect(screen.getByTestId('agent-board-server-leave').textContent).not.toContain('still signed in');
    expect(screen.queryByRole('button', { name: 'Sign out and switch' })).toBeNull();
    fireEvent.click(button('Switch'));
    await settle();
    expect(calls('board_server_sign_out').length).toBe(0);
    expect(applyUpdate({ mode: 'server' }).agents.board.mode).toBe('sqlite');
  });
});

describe('board server texts', () => {
  const keys = (Object.keys(en) as Array<keyof typeof en>).filter((k) => k.startsWith('settings.agentBoard.server.') || k.startsWith('settings.agentBoard.mode.server') || k === 'settings.agentBoard.status.server');
  it('every new key has English and Korean text (Korean written in Korean)', () => {
    expect(keys.length).toBeGreaterThan(50);
    for (const k of keys) {
      expect(en[k], k).toBeTruthy();
      expect(ko[k], k).toBeTruthy();
      expect(/[가-힣]/.test(ko[k]), `${k}: ${ko[k]}`).toBe(true);
    }
  });
  it('Korean says "보드 서버", never "게시판 서버"', () => {
    for (const k of keys) expect(ko[k]).not.toContain('게시판 서버');
    expect(ko['settings.agentBoard.server.title']).toBe('보드 서버');
    expect(ko['settings.agentBoard.server.token']).toBe('이 컴퓨터의 토큰');
  });
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('Agent team board settings: board server edge cases', () => {
  it('an in-flight poll that answers after Cancel changes nothing and polls no more', async () => {
    const late = deferred<unknown>();
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => started(),
      board_server_sign_in_poll: () => late.promise,
      board_server_sign_in_cancel: () => ({ cancelled: true }),
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle(2100);
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    fireEvent.click(button('Cancel'));
    await settle();
    // Focus goes back to Sign in.
    expect(document.activeElement).toBe(button('Sign in'));
    const statusReads = calls('board_server_status').length;
    late.resolve({ state: 'signed_in', server: SERVER, nickname: 'river', computer: 'studio' });
    await settle(30_000);
    expect(screen.queryByTestId('agent-board-server-message')).toBeNull();
    expect(screen.queryByTestId('agent-board-server-code')).toBeNull();
    expect(calls('board_server_sign_in_poll').length).toBe(1);
    expect(calls('board_server_status').length).toBe(statusReads);
  });

  it('an older status answer arriving after a newer one is dropped', async () => {
    const first = deferred<unknown>();
    let n = 0;
    answer({ board_server_status: () => (++n === 1 ? first.promise : signedOut()) });
    render(<AgentBoardSettings />);
    await settle();
    expect(screen.getByTestId('agent-board-server-unread').textContent).toBe('Reading the sign-in state…');
    fireEvent.click(screen.getAllByRole('button', { name: en['settings.agentBoard.status.refresh'] })[0]);
    await settle();
    expect(screen.getByTestId('agent-board-server-signed-out')).toBeTruthy();
    first.resolve(signedIn());
    await settle();
    expect(screen.getByTestId('agent-board-server-signed-out')).toBeTruthy();
    expect(screen.queryByTestId('agent-board-server-account')).toBeNull();
  });

  it('closing the screen while a sign-in is starting cancels it on the host and never polls', async () => {
    const start = deferred<unknown>();
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => start.promise,
    });
    const view = render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle();
    view.unmount();
    start.resolve(started());
    await settle(30_000);
    expect(calls('board_server_sign_in_cancel').length).toBe(1);
    expect(calls('board_server_sign_in_poll').length).toBe(0);
  });

  it('an answer that cannot be read is cancelled on the host before it is shown as an error', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => ({ server: SERVER }),
    });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign in'));
    await settle();
    expect(calls('board_server_sign_in_cancel').length).toBe(1);
    expect(screen.getByRole('alert').textContent).toBe("The sign-in failed: the board server's answer could not be read");
  });

  it('a double click starts one sign-in; Save stays locked while it waits', async () => {
    answer({
      board_server_status: () => signedOut(),
      board_server_sign_in_start: () => started(),
      board_server_sign_in_poll: () => ({ state: 'pending', retryInMs: 60_000 }),
    });
    render(<AgentBoardSettings />);
    await settle();
    const b = button('Sign in');
    fireEvent.click(b);
    fireEvent.click(b);
    await settle();
    expect(calls('board_server_sign_in_start').length).toBe(1);
    fireEvent.change(screen.getByLabelText('Server address'), { target: { value: 'https://other.example.com' } });
    expect(button('Save').disabled).toBe(true);
    // The countdown is a timer, not a live region.
    const timer = screen.getByTestId('agent-board-server-waiting');
    expect(timer.getAttribute('role')).toBe('timer');
    expect(timer.getAttribute('aria-live')).toBe('off');
    // "Open approval page" asks the host (no URL is sent from here).
    fireEvent.click(button('Open approval page'));
    await settle();
    expect(calls('board_server_open_sign_in_link')).toEqual([['board_server_open_sign_in_link', undefined]]);
    // The host answered {} (opened not false): no notice yet; {opened:false}: the notice.
    expect(screen.queryByText('The browser was not opened: open the approval page yourself.')).toBeNull();
    h.invoke.mockImplementation(async (cmd: string) => (cmd === 'board_server_open_sign_in_link' ? { opened: false } : cmd === 'board_server_sign_in_poll' ? { state: 'pending', retryInMs: 60_000 } : signedOut()));
    fireEvent.click(button('Open approval page'));
    await settle();
    expect(screen.getByText('The browser was not opened: open the approval page yourself.')).toBeTruthy();
  });

  it('after a saved address the status is read again once config.json has it', async () => {
    answer({ board_server_status: () => signedOut() });
    const view = render(<AgentBoardSettings />);
    await settle();
    expect(calls('board_server_status').length).toBe(1);
    h.board = { mode: 'server', server: { url: 'https://other.example.com' } };
    view.rerender(<AgentBoardSettings />);
    await settle(500);
    expect(calls('board_server_status').length).toBe(1);
    await settle(400);
    expect(calls('board_server_status').length).toBe(2);
  });

  it('switching SQLite → Board server reads the status line again', async () => {
    h.board = { mode: 'sqlite', server: { url: SERVER } };
    answer({ agent_board_settings_status: () => ({ mode: 'sqlite', backend: 'sqlite' }), board_server_status: () => signedOut() });
    const view = render(<AgentBoardSettings />);
    await settle(900);
    const before = calls('agent_board_settings_status').length;
    h.board = { mode: 'server', server: { url: SERVER } };
    answer({ agent_board_settings_status: () => ({ mode: 'server', backend: 'server', server: { server: SERVER } }), board_server_status: () => signedOut() });
    view.rerender(<AgentBoardSettings />);
    await settle(900);
    expect(calls('agent_board_settings_status').length).toBe(before + 1);
    expect(screen.getByText(`Board server ${SERVER}`)).toBeTruthy();
  });

  it('Escape closes the sign-out and leave confirmations', async () => {
    answer({ board_server_status: () => signedIn() });
    render(<AgentBoardSettings />);
    await settle();
    fireEvent.click(button('Sign out'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(radio('sqlite'));
    fireEvent.keyDown(screen.getByTestId('agent-board-server-leave'), { key: 'Escape' });
    expect(screen.queryByTestId('agent-board-server-leave')).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
    expect(calls('board_server_sign_out').length).toBe(0);
  });
});
