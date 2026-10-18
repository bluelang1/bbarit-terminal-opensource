import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Terminal } from 'xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { enqueueTelegramOutput } from './telegramMirror';
import { enqueueDiscordOutput } from './discordMirror';
import { enqueueSlackOutput } from './slackMirror';

// Generic disposable addon reference
interface DisposableAddon { dispose: () => void }

// Global terminal state management - persists PTY and xterm across component remounts
export interface TerminalState {
  ptyCreated: boolean;
  term: Terminal | null;
  fitAddon: FitAddon | null;
  webglAddon: DisposableAddon | null;
  unicode11Addon: DisposableAddon | null;
  webLinksAddon: DisposableAddon | null;
  searchAddon: DisposableAddon | null;
  terminalElement: HTMLDivElement | null;
  writeToPty: ((data: string) => void) | null;
  ptyUnlisten: (() => void) | null;
  inputMode?: 'direct' | 'ime';
  inputDisposable?: { dispose: () => void } | null;
  telegram?: {
    enabled: boolean;
    mirrorCommands: boolean;
    mirrorOutput: boolean;
    label?: string;
    chatId?: string;
  };
  telegramCmdBuffer?: string;
  telegramOutBuffer?: string;
  telegramOutFlushTimer?: number | null;
  telegramOutFirstAt?: number | null;
  telegramLastSent?: string;
  telegramScreenSnapshot?: string;
  telegramScreenTimer?: number | null;
  telegramScreenDirty?: boolean;
  telegramScreenFirstDirtyAt?: number | null;
  discord?: {
    enabled: boolean;
    mirrorCommands: boolean;
    mirrorOutput: boolean;
    label?: string;
    channelId?: string;
  };
  discordCmdBuffer?: string;
  discordScreenSnapshot?: string;
  discordScreenTimer?: number | null;
  discordScreenDirty?: boolean;
  discordScreenFirstDirtyAt?: number | null;
  discordLastSent?: string;
  slack?: {
    enabled: boolean;
    mirrorCommands: boolean;
    mirrorOutput: boolean;
    label?: string;
    channelId?: string;
  };
  slackCmdBuffer?: string;
  slackScreenSnapshot?: string;
  slackScreenTimer?: number | null;
  slackScreenDirty?: boolean;
  slackScreenFirstDirtyAt?: number | null;
  slackLastSent?: string;
  // RAF write batch: buffer PTY data and flush once per animation frame
  ptyWriteBuffer?: string;
  ptyRafId?: number | null;
  // I/O activity tracking
  lastActivityAt?: number;
}

export const terminalStates = new Map<string, TerminalState>();

/** Check if a terminal had I/O activity within the given threshold (ms). */
export function isTerminalActive(terminalId: string, thresholdMs = 3000): boolean {
  const state = terminalStates.get(terminalId);
  if (!state?.lastActivityAt) return false;
  return Date.now() - state.lastActivityAt < thresholdMs;
}

// Start PTY event listener (uses Tauri events instead of polling)
export const startPtyListener = async (terminalId: string) => {
  const state = terminalStates.get(terminalId);
  if (!state) return;
  if (state.ptyUnlisten) return; // already listening

  const eventName = `pty-data-${terminalId}`;
  const unlisten = await listen<string>(eventName, (event) => {
    const st = terminalStates.get(terminalId);
    if (!st?.term) return;

    const data = event.payload;
    if (!data) return;

    st.lastActivityAt = Date.now();

    // DSR response handling (must be immediate - cannot defer)
    if (data.includes('\x1b[6n') && st.writeToPty) {
      const cursorY = st.term.buffer.active.cursorY + 1;
      const cursorX = st.term.buffer.active.cursorX + 1;
      invoke('write_to_pty', { terminalId, data: `\x1b[${cursorY};${cursorX}R` }).catch(() => {});
    }
    if (data.includes('\x1b[5n') && st.writeToPty) {
      invoke('write_to_pty', { terminalId, data: '\x1b[0n' }).catch(() => {});
    }

    // RAF batch: accumulate in buffer and write all at once on the next frame
    st.ptyWriteBuffer = (st.ptyWriteBuffer || '') + data;
    enqueueTelegramOutput(terminalId, data);
    enqueueDiscordOutput(terminalId, data);
    enqueueSlackOutput(terminalId, data);

    if (!st.ptyRafId) {
      st.ptyRafId = requestAnimationFrame(() => {
        const s = terminalStates.get(terminalId);
        if (s?.term && s.ptyWriteBuffer) {
          s.term.write(s.ptyWriteBuffer);
          s.ptyWriteBuffer = '';
        }
        if (s) s.ptyRafId = null;
      });
    }
  });

  // Store listener in state (for cleanup)
  const currentState = terminalStates.get(terminalId);
  if (currentState) {
    currentState.ptyUnlisten = unlisten;
  }
};

// Stop PTY event listener
export const stopPtyListener = (terminalId: string) => {
  const state = terminalStates.get(terminalId);
  if (state?.ptyUnlisten) {
    state.ptyUnlisten();
    state.ptyUnlisten = null;
  }
};

// Fully dispose terminal (free memory)
export const disposeTerminal = (terminalId: string) => {
  // Immediately clear buffers to free memory before async cleanup
  const stateEarly = terminalStates.get(terminalId);
  if (stateEarly) {
    if (stateEarly.ptyRafId) {
      cancelAnimationFrame(stateEarly.ptyRafId);
      stateEarly.ptyRafId = null;
    }
    stateEarly.ptyWriteBuffer = '';
    stateEarly.telegramScreenSnapshot = undefined;
    stateEarly.discordScreenSnapshot = undefined;
    stateEarly.slackScreenSnapshot = undefined;
  }

  // Process asynchronously to avoid conflicts with React rendering
  setTimeout(() => {
    stopPtyListener(terminalId);

    const state = terminalStates.get(terminalId);
    if (state) {
      if (state.telegramOutFlushTimer) {
        clearTimeout(state.telegramOutFlushTimer);
        state.telegramOutFlushTimer = null;
      }
      if (state.telegramScreenTimer) {
        clearTimeout(state.telegramScreenTimer);
        state.telegramScreenTimer = null;
      }
      if (state.discordScreenTimer) {
        clearTimeout(state.discordScreenTimer);
        state.discordScreenTimer = null;
      }
      if (state.slackScreenTimer) {
        clearTimeout(state.slackScreenTimer);
        state.slackScreenTimer = null;
      }
      if (state.inputDisposable) {
        try { state.inputDisposable.dispose(); } catch { /* ignore */ }
        state.inputDisposable = null;
      }
      // Dispose all addons before xterm instance
      const addonsToDispose: (DisposableAddon | null | undefined)[] = [
        state.webglAddon, state.unicode11Addon, state.webLinksAddon,
        state.searchAddon, state.fitAddon,
      ];
      for (const addon of addonsToDispose) {
        if (addon) {
          try { addon.dispose(); } catch { /* ignore */ }
        }
      }
      state.webglAddon = null;
      state.unicode11Addon = null;
      state.webLinksAddon = null;
      state.searchAddon = null;
      state.fitAddon = null;
      // xterm instance dispose
      if (state.term) {
        try { state.term.dispose(); } catch { /* ignore */ }
      }
      // Remove from Map
      terminalStates.delete(terminalId);
    }

    // Clean up PTY as well
    invoke('close_pty', { terminalId }).catch(() => {
      invoke('destroy_pty', { terminalId }).catch(() => {});
    });
  }, 0);
};
