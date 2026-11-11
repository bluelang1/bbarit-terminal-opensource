import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueButtonInput } from './buttonInput';
import { noteHumanInput, queueAutoInput, resetInputGate, setInputGateHost, writeHumanInput } from './inputGate';
import {
  clearPendingCommand,
  dropLastCommand,
  feedTerminalInput,
  lastCommandOf,
  isEchoedOnRow,
  noteAgentStatus,
  setLastCommandHost,
  setLastCommandMode,
} from './lastCommand';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const T = 't';
afterEach(() => { dropLastCommand(T); setLastCommandHost(null); resetInputGate(); vi.useRealTimers(); });

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

  it('ignores DCS replies that reach the tracker', () => {
    feedTerminalInput(T, 'ls\x1bP1$r0 q\x1b\\\r');
    expect(lastCommandOf(T)).toBe('ls');
  });

  it('caps pending text at 4000 characters, keeping the head', () => {
    feedTerminalInput(T, 'echo ' + 'x'.repeat(5000) + '\r');
    expect(lastCommandOf(T)).toBe('echo ' + 'x'.repeat(3995));
  });

  it('dropLastCommand frees the entry', () => {
    feedTerminalInput(T, 'ls\r');
    dropLastCommand(T);
    expect(lastCommandOf(T)).toBe('');
  });

  it('returns an empty string for unknown terminals', () => {
    expect(lastCommandOf('t-none')).toBe('');
  });
});

describe('last command: shell echo check', () => {
  const screen = (row: string, alt = false) => {
    const st = { row, alt };
    setLastCommandHost({ cursorLineText: () => st.row, isAlternateBuffer: () => st.alt });
    return st;
  };

  it('does not record a line the terminal did not echo (sudo password)', () => {
    const st = screen('');
    st.row = '~ % sudo ls';
    feedTerminalInput(T, 'sudo ls\r');
    expect(lastCommandOf(T)).toBe('sudo ls');
    st.row = 'Password:';
    feedTerminalInput(T, 'hunter2\r');
    expect(lastCommandOf(T)).toBe('sudo ls');
  });

  it('does not record a line typed on a password prompt even if it looks echoed', () => {
    const st = screen('[sudo] password for me: ');
    feedTerminalInput(T, 'me\r');
    expect(lastCommandOf(T)).toBe('');
    st.row = '비밀번호 입력: ';
    feedTerminalInput(T, '입력\r');
    expect(lastCommandOf(T)).toBe('');
  });

  it('tolerates the last few keystrokes not being echoed yet, and wrapped rows', () => {
    const st = screen('~ % npm run d');
    feedTerminalInput(T, 'npm run dev\r');
    expect(lastCommandOf(T)).toBe('npm run dev');
    st.row = '~ % echo   hello';
    feedTerminalInput(T, 'echo   hello\r');
    expect(lastCommandOf(T)).toBe('echo   hello');
  });

  it('echo rule', () => {
    expect(isEchoedOnRow('ls', '~ % ls')).toBe(true);
    expect(isEchoedOnRow('ls', '~ % ')).toBe(false);
    expect(isEchoedOnRow('git status', '~ % git sta')).toBe(true);
    expect(isEchoedOnRow('git status', '~ % git s')).toBe(false);
    expect(isEchoedOnRow('hunter2', 'Password:')).toBe(false);
  });

  it('ignores keystrokes while a full-screen program owns the alternate buffer', () => {
    const st = screen('~ % vim x');
    feedTerminalInput(T, 'vim x\r');
    st.alt = true;
    feedTerminalInput(T, 'iHello\x1b:wq\r');
    expect(lastCommandOf(T)).toBe('vim x');
    st.alt = false;
    st.row = '~ % ls';
    feedTerminalInput(T, 'ls\r');
    expect(lastCommandOf(T)).toBe('ls');
  });

  it('keeps tracking agent tabs in the alternate buffer', () => {
    screen('', true);
    setLastCommandMode(T, 'agent');
    noteAgentStatus(T, 'idle');
    feedTerminalInput(T, 'hello');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('hello');
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

  it('drops uncommitted text on Ctrl+C, Ctrl+U and Esc', () => {
    agent();
    for (const clear of ['\x03', '\x15', '\x1b']) {
      feedTerminalInput(T, 'draft');
      feedTerminalInput(T, clear);
      feedTerminalInput(T, 'real');
      noteAgentStatus(T, 'working');
      expect(lastCommandOf(T)).toBe('real');
      noteAgentStatus(T, 'idle');
    }
  });

  it('keeps text typed ahead while the agent works and commits it on the next turn', () => {
    agent();
    feedTerminalInput(T, 'first');
    noteAgentStatus(T, 'working');
    feedTerminalInput(T, 'typed ahead');
    noteAgentStatus(T, 'idle'); // the draft is still in the agent's input box
    expect(lastCommandOf(T)).toBe('first');
    feedTerminalInput(T, '\r');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('typed ahead');
  });

  it('commits on Enter only for real slash/bang commands, not for a leading path', () => {
    agent();
    feedTerminalInput(T, '/model opus\r');
    expect(lastCommandOf(T)).toBe('/model opus');
    feedTerminalInput(T, '/Users/foo bar\r'); // a path: Enter is a line break
    expect(lastCommandOf(T)).toBe('/model opus');
    feedTerminalInput(T, 'please');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('/Users/foo bar please');
  });

  it('treats Option+Enter (ESC CR) as a line break', () => {
    agent();
    feedTerminalInput(T, 'foo\x1b\rbar');
    expect(lastCommandOf(T)).toBe('');
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('foo bar');
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

  it('does not feed terminal query replies (DECRQSS) into the tracker', () => {
    const writes = host();
    writeHumanInput(T, 'ls', (d) => writes.push(d));
    writeHumanInput(T, '\x1bP1$r0 q\x1b\\', (d) => writes.push(d));
    writeHumanInput(T, '\r', (d) => writes.push(d));
    expect(lastCommandOf(T)).toBe('ls');
    expect(writes.join('')).toBe('ls\x1bP1$r0 q\x1b\\\r');
  });

  it('returns to shell tracking when the agent clears its status (exited to the shell)', () => {
    noteAgentStatus(T, 'idle');
    feedTerminalInput(T, 'draft\r');
    noteAgentStatus(T, 'idle', { cleared: true });
    feedTerminalInput(T, 'git log\r');
    expect(lastCommandOf(T)).toBe('git log');
  });
});
