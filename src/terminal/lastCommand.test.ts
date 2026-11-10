import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueButtonInput } from './buttonInput';
import { noteHumanInput, queueAutoInput, resetInputGate, setInputGateHost, writeHumanInput } from './inputGate';
import {
  clearPendingCommand,
  dropLastCommand,
  feedTerminalInput,
  lastCommandOf,
  noteAgentStatus,
  setLastCommandMode,
} from './lastCommand';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const T = 't';
afterEach(() => { dropLastCommand(T); resetInputGate(); vi.useRealTimers(); });

const SHIFT_ENTER = '\x1b[13;2u';
const CMD_ENTER = '\x1b[13;9u';

describe('last command: shell tabs', () => {
  it('commits the typed line on Enter, across chunks', () => {
    feedTerminalInput(T, 'npm');
    feedTerminalInput(T, ' run dev');
    feedTerminalInput(T, '\r');
    expect(lastCommandOf(T)).toBe('npm run dev');
  });

  it('applies backspace, Ctrl+C and Ctrl+U', () => {
    feedTerminalInput(T, 'lsa\x7f\r');
    expect(lastCommandOf(T)).toBe('ls');
    feedTerminalInput(T, 'rm -rf /tmp/x\x03echo ok\r');
    expect(lastCommandOf(T)).toBe('echo ok');
    feedTerminalInput(T, 'oops\x15pwd\r');
    expect(lastCommandOf(T)).toBe('pwd');
  });

  it('deletes words with Ctrl+W and Alt+Backspace', () => {
    feedTerminalInput(T, 'git commit -m wip\x17\x17\r');
    expect(lastCommandOf(T)).toBe('git commit');
    feedTerminalInput(T, 'echo hello world\x1b\x7f\r');
    expect(lastCommandOf(T)).toBe('echo hello');
  });

  it('follows cursor moves before typing', () => {
    // "ls" -> Left Left -> type "x" -> "xls"; Home/End and Ctrl+A/E too.
    feedTerminalInput(T, 'ls\x1b[D\x1b[Dx\r');
    expect(lastCommandOf(T)).toBe('xls');
    feedTerminalInput(T, 'cho hi\x01e\x05!\r');
    expect(lastCommandOf(T)).toBe('echo hi!');
    feedTerminalInput(T, 'ab\x1b[H\x1b[3~\r');
    expect(lastCommandOf(T)).toBe('b');
  });

  it('does not submit on CSI-u Enter variants', () => {
    feedTerminalInput(T, 'make' + SHIFT_ENTER + CMD_ENTER);
    expect(lastCommandOf(T)).toBe('');
    feedTerminalInput(T, ' test\r');
    expect(lastCommandOf(T)).toBe('make test');
  });

  it('records nothing for a line recalled from history or completed with Tab', () => {
    feedTerminalInput(T, 'ls\r');
    feedTerminalInput(T, '\x1b[A\r');
    expect(lastCommandOf(T)).toBe('');
    feedTerminalInput(T, 'cd sr\t\r');
    expect(lastCommandOf(T)).toBe('');
    feedTerminalInput(T, 'pwd\r');
    expect(lastCommandOf(T)).toBe('pwd');
  });

  it('shows a bracketed multi-line paste as its first line + …', () => {
    feedTerminalInput(T, '\x1b[200~npm ci\rnpm test\r\x1b[201~\r');
    expect(lastCommandOf(T)).toBe('npm ci …');
    feedTerminalInput(T, '\x1b[200~npm test\x1b[201~\r');
    expect(lastCommandOf(T)).toBe('npm test');
  });

  it('commits Korean IME text as the bridge delivers it (one NFC chunk per committed syllable)', () => {
    // XTerminal's IME bridge sends nothing while composing and one sendToPty per compositionend.
    for (const syllable of ['깃', ' ', '상', '태']) feedTerminalInput(T, syllable);
    feedTerminalInput(T, '\r');
    expect(lastCommandOf(T)).toBe('깃 상태');
    // Backspace removes one whole syllable (one code point after NFC).
    feedTerminalInput(T, '한글\x7f\r');
    expect(lastCommandOf(T)).toBe('한');
  });

  it('skips escape sequences, OSC replies and mouse reports', () => {
    feedTerminalInput(T, '\x1b]7501;?:states=idle\x1b\\ls\x1b]0;title\x07 -la\x1b[<0;10;5M\x1b[M !!\x1b[I\r');
    expect(lastCommandOf(T)).toBe('ls -la');
  });

  it('keeps the last command when only empty Enters follow, and clears pending input on demand', () => {
    feedTerminalInput(T, 'ls\r\r  \r');
    expect(lastCommandOf(T)).toBe('ls');
    feedTerminalInput(T, 'half typed');
    clearPendingCommand(T);
    feedTerminalInput(T, 'pwd\r');
    expect(lastCommandOf(T)).toBe('pwd');
  });

  it('returns an empty string for unknown terminals', () => {
    expect(lastCommandOf('t-none')).toBe('');
  });
});

describe('last command: agent tabs', () => {
  const agent = () => { setLastCommandMode(T, 'agent'); noteAgentStatus(T, 'idle'); };

  it('treats every Enter variant as a line break and commits when the agent starts working', () => {
    agent();
    feedTerminalInput(T, 'fix the\r');
    feedTerminalInput(T, 'build' + SHIFT_ENTER + 'please');
    expect(lastCommandOf(T)).toBe('');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('fix the build please');
    // Buffer was cleared: the next prompt stands alone.
    noteAgentStatus(T, 'done');
    feedTerminalInput(T, 'next' + CMD_ENTER);
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('next');
  });

  it('commits slash and bang commands on any Enter variant', () => {
    agent();
    feedTerminalInput(T, '/clear' + CMD_ENTER);
    expect(lastCommandOf(T)).toBe('/clear');
    feedTerminalInput(T, '!ls -la\r');
    expect(lastCommandOf(T)).toBe('!ls -la');
    noteAgentStatus(T, 'working'); // nothing pending: keeps the bang command
    expect(lastCommandOf(T)).toBe('!ls -la');
  });

  it('drops uncommitted text on Ctrl+C, Ctrl+U, Esc and when the turn ends', () => {
    agent();
    for (const clear of ['\x03', '\x15', '\x1b']) {
      feedTerminalInput(T, 'draft');
      feedTerminalInput(T, clear);
      feedTerminalInput(T, 'real');
      noteAgentStatus(T, 'working');
      expect(lastCommandOf(T)).toBe('real');
      noteAgentStatus(T, 'idle');
    }
    noteAgentStatus(T, 'working');
    feedTerminalInput(T, 'typed while working'); // turn ends without a new working transition
    noteAgentStatus(T, 'done');
    feedTerminalInput(T, 'second');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('second');
  });

  it('never records answers to a permission prompt', () => {
    agent();
    feedTerminalInput(T, 'deploy it');
    noteAgentStatus(T, 'working');
    noteAgentStatus(T, 'blocked');
    feedTerminalInput(T, '1\r');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('deploy it');
  });

  it('becomes an agent tab once OSC 7501 is reported, even if it started as a shell', () => {
    feedTerminalInput(T, 'claude\r');
    expect(lastCommandOf(T)).toBe('claude');
    noteAgentStatus(T, 'idle');
    feedTerminalInput(T, 'line one\rline two');
    expect(lastCommandOf(T)).toBe('claude');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('line one line two');
  });

  it('before any OSC 7501 report, an agent tab commits on plain Enter only', () => {
    setLastCommandMode(T, 'agent');
    feedTerminalInput(T, 'explain' + SHIFT_ENTER + 'this\r');
    expect(lastCommandOf(T)).toBe('explain this');
  });
});

describe('last command: which writes count', () => {
  const host = () => {
    const writes: string[] = [];
    setInputGateHost({ getWriter: () => (d: string) => { writes.push(d); }, getAgentState: () => undefined, isBracketedPaste: () => false });
    return writes;
  };

  it('counts human input and user-clicked buttons, not relay notes or scheduler input', async () => {
    vi.useFakeTimers();
    const writes = host();
    writeHumanInput(T, 'ls\r', (d) => writes.push(d));
    expect(lastCommandOf(T)).toBe('ls');

    const button = queueButtonInput(T, 'npm run build', { submit: true, submitDelayMs: 0 });
    await vi.runAllTimersAsync();
    await button;
    expect(lastCommandOf(T)).toBe('npm run build');

    const relay = queueAutoInput(T, '<bbarit from=child state=done>', { source: 'agent', submit: true, quietMs: 0, submitDelayMs: 0 });
    const sched = queueAutoInput(T, 'make nightly', { source: 'scheduler', submit: true, quietMs: 0, submitDelayMs: 0 });
    await vi.runAllTimersAsync();
    await Promise.all([relay, sched]);
    expect(writes.join('')).toContain('make nightly');
    expect(lastCommandOf(T)).toBe('npm run build');
  });

  it('tracks held human keys when they are flushed after an automated write', async () => {
    vi.useFakeTimers();
    const writes = host();
    noteHumanInput(T);
    const auto = queueAutoInput(T, 'note', { source: 'agent', submit: true, quietMs: 0, submitDelayMs: 50 });
    await vi.advanceTimersByTimeAsync(0);
    writeHumanInput(T, 'pwd\r', (d) => writes.push(d)); // held while the note is being written
    await vi.runAllTimersAsync();
    await auto;
    expect(lastCommandOf(T)).toBe('pwd');
  });

  it('returns to shell tracking when the agent clears its status (exited to the shell)', () => {
    noteAgentStatus(T, 'idle');
    feedTerminalInput(T, 'draft\r');
    noteAgentStatus(T, 'idle', { cleared: true });
    feedTerminalInput(T, 'git log\r');
    expect(lastCommandOf(T)).toBe('git log');
  });
});
