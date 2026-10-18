import { describe, expect, it, vi } from 'vitest';
import { probeRestoredPty } from './restoredPty';

describe('probeRestoredPty', () => {
  it('reattaches a live restored PTY and reads its buffered output', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'check_pty_alive') return true;
      if (command === 'read_pty_output_buffer') return 'OpenAI Codex (v0.141.0)\nmodel: gpt-5.5 high\ndirectory: C:/repo';
      throw new Error(`unexpected command ${command}`);
    });
    const invokeFn = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

    await expect(probeRestoredPty({
      invokeFn,
      terminalId: 'term-1',
      cliType: 'codex',
      isRestored: true,
      ptyAlreadyExists: false,
    })).resolves.toEqual({
      ptyAlreadyExists: true,
      bufferedOutput: 'OpenAI Codex (v0.141.0)\nmodel: gpt-5.5 high\ndirectory: C:/repo',
      markCliAutoStarted: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'check_pty_alive', { terminalId: 'term-1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'read_pty_output_buffer', { terminalId: 'term-1' });
  });

  it('does not mark a live restored raw shell as an already-started agent', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'check_pty_alive') return true;
      if (command === 'read_pty_output_buffer') return 'PS C:\\Users\\test-user\\Documents\\projects\\gudae> ';
      throw new Error(`unexpected command ${command}`);
    });
    const invokeFn = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

    await expect(probeRestoredPty({
      invokeFn,
      terminalId: 'term-raw-shell',
      cliType: 'claude',
      isRestored: true,
      ptyAlreadyExists: false,
    })).resolves.toEqual({
      ptyAlreadyExists: true,
      bufferedOutput: 'PS C:\\Users\\test-user\\Documents\\projects\\gudae> ',
      markCliAutoStarted: false,
    });
  });

  it('falls back to normal shell creation when the restored PTY is gone', async () => {
    const invokeMock = vi.fn(async (command: string) => {
      if (command === 'check_pty_alive') return false;
      throw new Error(`unexpected command ${command}`);
    });
    const invokeFn = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

    await expect(probeRestoredPty({
      invokeFn,
      terminalId: 'term-2',
      cliType: 'claude',
      isRestored: true,
      ptyAlreadyExists: false,
    })).resolves.toEqual({
      ptyAlreadyExists: false,
      bufferedOutput: '',
      markCliAutoStarted: false,
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('does not probe when the terminal is not restored or is already attached', async () => {
    const invokeMock = vi.fn();
    const invokeFn = invokeMock as unknown as <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

    await expect(probeRestoredPty({
      invokeFn,
      terminalId: 'term-3',
      cliType: 'shell',
      isRestored: false,
      ptyAlreadyExists: false,
    })).resolves.toEqual({
      ptyAlreadyExists: false,
      bufferedOutput: '',
      markCliAutoStarted: false,
    });
    await expect(probeRestoredPty({
      invokeFn,
      terminalId: 'term-3',
      cliType: 'shell',
      isRestored: true,
      ptyAlreadyExists: true,
    })).resolves.toEqual({
      ptyAlreadyExists: true,
      bufferedOutput: '',
      markCliAutoStarted: false,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
