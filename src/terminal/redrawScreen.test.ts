import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueButtonInput } from './buttonInput';
import { resetInputGate, setInputGateHost } from './inputGate';
import { dropLastCommand, feedTerminalInput, lastCommandOf, noteAgentStatus, setLastCommandMode } from './lastCommand';
import { CLAUDE_REDRAW_KEY, redrawScreenKeyFor } from './redrawScreen';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

const T = 'redraw-t';
afterEach(() => { dropLastCommand(T); resetInputGate(); });

describe('redrawScreenKeyFor', () => {
  it('gives Claude tabs Ctrl+L', () => {
    expect(CLAUDE_REDRAW_KEY).toBe('\x0c');
    expect(redrawScreenKeyFor('claude')).toBe('\x0c');
  });

  it('gives no button to Codex, plain shells, other CLIs and unknown tabs', () => {
    for (const cliType of ['codex', 'shell', undefined, '', 'cursor', 'opencode', 'kimi', 'gemini', 'ollama', 'qwen', 'pi', 'reasonix', 'bbarit', 'bbarit-oss', 'gajae']) {
      expect(redrawScreenKeyFor(cliType)).toBeNull();
    }
  });
});

describe('redraw button input', () => {
  it('writes the raw key without Enter and leaves the typed prompt and last command alone', async () => {
    const writes: string[] = [];
    setInputGateHost({ getWriter: () => (d: string) => { writes.push(d); }, getAgentState: () => undefined, isBracketedPaste: () => true });
    setLastCommandMode(T, 'agent');
    noteAgentStatus(T, 'idle');
    feedTerminalInput(T, 'half typed');

    const result = await queueButtonInput(T, CLAUDE_REDRAW_KEY, { submit: false });
    expect(result.ok).toBe(true);
    expect(writes).toEqual(['\x0c']);
    expect(lastCommandOf(T)).toBe('');

    // The typed text is still pending: submitting it later records it unchanged.
    noteAgentStatus(T, 'working');
    expect(lastCommandOf(T)).toBe('half typed');
  });
});
