import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTabState } from './programStatus';
import {
  MAX_WAIT_MS,
  MIN_SUBMIT_DELAY_MS,
  QUIET_MS,
  WRITER_WAIT_MS,
  isHumanTyping,
  isNonTypingInput,
  isWriting,
  noteHumanInput,
  queueAutoInput,
  resetInputGate,
  setInputGateFallbackWriter,
  setInputGateHost,
  writeHumanInput,
} from './inputGate';
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from './pasteChunks';

const T = 'term-1';

interface Write { data: string; at: number }

function fakeTerminal(opts: { bracketed?: boolean; state?: AgentTabState } = {}) {
  const writes: Write[] = [];
  const env = { bracketed: !!opts.bracketed, state: opts.state as AgentTabState | undefined, attached: true };
  const write = (data: string) => { writes.push({ data, at: Date.now() }); };
  setInputGateHost({
    getWriter: (id) => (id === T && env.attached ? write : null),
    getAgentState: () => env.state,
    isBracketedPaste: () => env.bracketed,
  });
  return { writes, env, write, text: () => writes.map((w) => w.data).join('') };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetInputGate();
});

afterEach(() => {
  resetInputGate();
  vi.useRealTimers();
});

describe('human input tracking', () => {
  it('treats input within the quiet window as typing', () => {
    noteHumanInput(T, 10_000);
    expect(isHumanTyping(T, QUIET_MS, 12_999)).toBe(true);
    expect(isHumanTyping(T, QUIET_MS, 13_000)).toBe(false);
    expect(isHumanTyping('other', QUIET_MS, 10_000)).toBe(false);
  });

  it('does not count mouse, focus or terminal query replies as typing', () => {
    expect(isNonTypingInput('\x1b[<64;10;5M')).toBe(true);
    expect(isNonTypingInput('\x1b[<0;1;1M\x1b[<0;1;1m')).toBe(true);
    expect(isNonTypingInput('\x1b[I')).toBe(true);
    expect(isNonTypingInput('\x1b[12;40R')).toBe(true);
    expect(isNonTypingInput('\x1b[?1;2c')).toBe(true);
    expect(isNonTypingInput('\x1b]11;rgb:0000/0000/0000\x1b\\')).toBe(true);
    expect(isNonTypingInput('a')).toBe(false);
    expect(isNonTypingInput('\x1b[A')).toBe(false);
    expect(isNonTypingInput('\r')).toBe(false);
    // Shift+F3 이 CPR 과 같은 바이트라 비입력으로 취급된다(알려진 한계).
    expect(isNonTypingInput('\x1b[1;2R')).toBe(true);

    const t = fakeTerminal();
    writeHumanInput(T, '\x1b[<64;10;5M', t.write);
    expect(isHumanTyping(T)).toBe(false);
    writeHumanInput(T, 'x', t.write);
    expect(isHumanTyping(T)).toBe(true);
    expect(t.text()).toBe('\x1b[<64;10;5Mx');
  });
});

describe('queueAutoInput', () => {
  it('waits while the human typed 1 s ago and writes once 3 s of quiet have passed', async () => {
    const t = fakeTerminal();
    noteHumanInput(T, Date.now() - 1000);
    const start = Date.now();
    const p = queueAutoInput(T, 'ls', { source: 'ctl', submit: false });

    await vi.advanceTimersByTimeAsync(1500);
    expect(t.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(t.text()).toBe('ls');
    expect(t.writes[0].at - start).toBeGreaterThanOrEqual(QUIET_MS - 1000);
    expect(t.writes[0].at - start).toBeLessThan(QUIET_MS - 1000 + 200);
    if (res.ok) expect(res.waitedMs).toBeGreaterThanOrEqual(QUIET_MS - 1000);
  });

  it('gives up with "typing" after maxWaitMs of continuous typing and writes nothing', async () => {
    const t = fakeTerminal();
    noteHumanInput(T);
    const keepTyping = setInterval(() => noteHumanInput(T), 500);
    const p = queueAutoInput(T, 'echo hi', { source: 'telegram' });
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 500);
    expect(await p).toEqual({ ok: false, reason: 'typing' });
    clearInterval(keepTyping);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.writes).toHaveLength(0);
  });

  it('refuses a blocked agent unless forced', async () => {
    const t = fakeTerminal({ state: 'blocked' });
    expect(await queueAutoInput(T, 'go on', { source: 'scheduler' })).toEqual({ ok: false, reason: 'blocked' });
    expect(t.writes).toHaveLength(0);

    const forced = queueAutoInput(T, 'go on', { source: 'hub', force: true, submit: false });
    await vi.advanceTimersByTimeAsync(100);
    expect((await forced).ok).toBe(true);
    expect(t.text()).toBe('go on');
  });

  it('re-checks blocked after waiting for quiet', async () => {
    const t = fakeTerminal({ state: 'working' });
    noteHumanInput(T);
    const p = queueAutoInput(T, 'next', { source: 'devreview' });
    await vi.advanceTimersByTimeAsync(1000);
    t.env.state = 'blocked';
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(await p).toEqual({ ok: false, reason: 'blocked' });
    expect(t.writes).toHaveLength(0);
  });

  it('wraps the body in bracketed paste and strips an inner end marker', async () => {
    const t = fakeTerminal({ bracketed: true });
    const p = queueAutoInput(T, `line1\nevil${BRACKETED_PASTE_END}rm -rf`, { source: 'telegram', submitDelayMs: 200 });
    await vi.advanceTimersByTimeAsync(500);
    expect((await p).ok).toBe(true);
    expect(t.writes.pop()?.data).toBe('\r');
    const out = t.text();
    expect(out.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(out.endsWith(BRACKETED_PASTE_END)).toBe(true);
    expect(out.split(BRACKETED_PASTE_END)).toHaveLength(2); // only the closing marker
    expect(out).toBe(`${BRACKETED_PASTE_START}line1\revilrm -rf${BRACKETED_PASTE_END}`);
  });

  it('sends control-key text raw even in bracketed mode', async () => {
    const t = fakeTerminal({ bracketed: true });
    const p = queueAutoInput(T, '\x03', { source: 'telegram', submit: false, force: true });
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).ok).toBe(true);
    expect(t.writes.map((w) => w.data)).toEqual(['\x03']);
  });

  it('sends Enter as a separate write at least 200 ms after the body', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'git status', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(6000);
    expect((await p).ok).toBe(true);
    expect(t.writes.map((w) => w.data)).toEqual(['git status', '\r']);
    const gap = t.writes[1].at - t.writes[0].at;
    expect(gap).toBeGreaterThanOrEqual(MIN_SUBMIT_DELAY_MS);
    expect(gap).toBeGreaterThanOrEqual(1200); // terminalSubmitDelayMs floor
  });

  it('serializes two concurrent requests on the same terminal', async () => {
    const t = fakeTerminal({ bracketed: true });
    const a = queueAutoInput(T, 'first request', { source: 'ctl' });
    const b = queueAutoInput(T, 'second request', { source: 'scheduler' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(t.writes.map((w) => w.data)).toEqual([
      BRACKETED_PASTE_START, 'first request', BRACKETED_PASTE_END, '\r',
      BRACKETED_PASTE_START, 'second request', BRACKETED_PASTE_END, '\r',
    ]);
  });

  it('a refused request does not stall the next one', async () => {
    const t = fakeTerminal({ state: 'blocked' });
    const a = queueAutoInput(T, 'nope', { source: 'scheduler' });
    const b = queueAutoInput(T, 'yes', { source: 'hub', force: true, submit: false });
    await vi.advanceTimersByTimeAsync(100);
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(true);
    expect(t.text()).toBe('yes');
  });

  it('holds human keys during the write and flushes them in order afterwards', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'auto text', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(10);
    expect(isWriting(T)).toBe(true);
    writeHumanInput(T, 'a', t.write);
    writeHumanInput(T, 'b', t.write);
    expect(t.writes.map((w) => w.data)).toEqual(['auto text']);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await p).ok).toBe(true);
    expect(isWriting(T)).toBe(false);
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', '\r', 'a', 'b']);
  });

  it('Ctrl-C during the write passes at once, drops held keys and cancels the pending Enter', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'auto text', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(10);
    writeHumanInput(T, '\x03', t.write);
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', '\x03']);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', '\x03']);
    expect(isWriting(T)).toBe(false);
  });

  it('Ctrl-C after keys were already held discards them', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'auto text', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(10);
    writeHumanInput(T, 'a', t.write);
    writeHumanInput(T, 'b', t.write);
    writeHumanInput(T, '\x03', t.write);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', '\x03']);
    // 다음 자동 쓰기는 다시 Enter 를 보낸다(취소 플래그가 남지 않는다).
    const q = queueAutoInput(T, 'next one', { source: 'ctl', quietMs: 0 });
    await vi.advanceTimersByTimeAsync(6000);
    expect((await q).ok).toBe(true);
    expect(t.writes.map((w) => w.data).slice(-2)).toEqual(['next one', '\r']);
  });

  it('does not hold mouse or other non-typing sequences while writing', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'auto text', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(10);
    writeHumanInput(T, '\x1b[<64;10;5M', t.write);
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', '\x1b[<64;10;5M']);
    await vi.advanceTimersByTimeAsync(6000);
    expect((await p).ok).toBe(true);
  });

  it('still flushes held keys when the writer throws', async () => {
    const t = fakeTerminal();
    let calls = 0;
    setInputGateHost({
      getWriter: () => (data: string) => {
        calls += 1;
        if (data === '\r') throw new Error('pty gone');
        t.write(data);
      },
    });
    const p = queueAutoInput(T, 'auto text', { source: 'ctl' });
    await vi.advanceTimersByTimeAsync(10);
    writeHumanInput(T, 'k', t.write);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ ok: false, reason: 'disposed' });
    expect(calls).toBe(2);
    expect(t.writes.map((w) => w.data)).toEqual(['auto text', 'k']);
    expect(isWriting(T)).toBe(false);
  });

  it('writes a gated body over 4096 chars as bracketed chunks', async () => {
    const t = fakeTerminal({ bracketed: true });
    const body = 'x'.repeat(4096 + 100);
    const p = queueAutoInput(T, body, { source: 'telegram' });
    await vi.advanceTimersByTimeAsync(6000);
    expect((await p).ok).toBe(true);
    expect(t.writes.pop()?.data).toBe('\r');
    expect(t.writes.map((w) => w.data.length)).toEqual([BRACKETED_PASTE_START.length, 4096, 100, BRACKETED_PASTE_END.length]);
    expect(t.text()).toBe(BRACKETED_PASTE_START + body + BRACKETED_PASTE_END);
  });

  it('submit:false sends raw bytes without bracketed paste', async () => {
    const t = fakeTerminal({ bracketed: true });
    const p = queueAutoInput(T, 'ls -la\r', { source: 'ctl', submit: false });
    await vi.advanceTimersByTimeAsync(10);
    expect((await p).ok).toBe(true);
    expect(t.writes.map((w) => w.data)).toEqual(['ls -la\r']);
  });

  it('honours submitDelayMs for plain shells', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'git status', { source: 'ctl', submitDelayMs: MIN_SUBMIT_DELAY_MS });
    await vi.advanceTimersByTimeAsync(MIN_SUBMIT_DELAY_MS + 50);
    expect((await p).ok).toBe(true);
    const gap = t.writes[1].at - t.writes[0].at;
    expect(gap).toBeGreaterThanOrEqual(MIN_SUBMIT_DELAY_MS);
    expect(gap).toBeLessThan(MIN_SUBMIT_DELAY_MS + 50); // not the 1.2 s agent delay
  });

  it('waits for a writer and gives up with "no-writer"', async () => {
    const t = fakeTerminal();
    t.env.attached = false;
    const p = queueAutoInput(T, 'x y', { source: 'telegram' });
    await vi.advanceTimersByTimeAsync(WRITER_WAIT_MS + 200);
    expect(await p).toEqual({ ok: false, reason: 'no-writer' });
  });

  it('uses a writer that appears while waiting, and the App fallback resolver', async () => {
    const t = fakeTerminal();
    t.env.attached = false;
    const p = queueAutoInput(T, 'hello there', { source: 'telegram', submit: false });
    await vi.advanceTimersByTimeAsync(1000);
    t.env.attached = true;
    await vi.advanceTimersByTimeAsync(200);
    expect((await p).ok).toBe(true);
    expect(t.text()).toBe('hello there');

    setInputGateHost(null);
    const viaApp: string[] = [];
    setInputGateFallbackWriter((id) => (id === 'popped' ? (d: string) => { viaApp.push(d); } : null));
    const q = queueAutoInput('popped', 'cmd one', { source: 'ctl', submit: false });
    await vi.advanceTimersByTimeAsync(100);
    expect((await q).ok).toBe(true);
    expect(viaApp).toEqual(['cmd one']);
  });

  it('reports "disposed" when the terminal goes away before Enter', async () => {
    const t = fakeTerminal();
    const p = queueAutoInput(T, 'some prompt', { source: 'editor', force: true });
    await vi.advanceTimersByTimeAsync(50);
    t.env.attached = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toEqual({ ok: false, reason: 'disposed' });
    expect(isWriting(T)).toBe(false);
  });
});
