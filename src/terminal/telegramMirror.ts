/**
 * Telegram mirroring — thin wrapper around remoteMirror.ts
 *
 * Existing exports are preserved for backward compatibility.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  setTerminalStatesGetter as setStatesGetter,
  filterMirrorNoise,
  redactSecrets,
  readTerminalScreen as readScreen,
  flushRemoteScreen,
  enqueueRemoteOutput,
  enqueueRemoteCommandFromKeystrokes,
  type RemotePlatformConfig,
} from './remoteMirror';

// Re-export shared getter initializer (called once from XTerminal.tsx)
export const setTerminalStatesGetter = setStatesGetter;

// Backward-compat aliases
export const filterTelegramNoise = filterMirrorNoise;
export const redactTelegramSecrets = redactSecrets;
export const readTerminalScreen = readScreen;

export const telegramSendBestEffort = (text: string, chatId?: string) => {
  const t = (text || '').trim();
  if (!t) return;
  const chat = (chatId || '').trim();
  if (!chat) return;
  invoke('telegram_send_message_with_token', { botToken: '', chatId: chat, text: t }).catch(() => {});
};

const telegramConfig: RemotePlatformConfig = {
  maxChunkSize: 3900,
  sendFn: telegramSendBestEffort,
  stateKey: 'telegram',
};

export const flushTelegramScreen = (terminalId: string) =>
  flushRemoteScreen(terminalId, telegramConfig);

export const enqueueTelegramOutput = (terminalId: string, chunk: string) =>
  enqueueRemoteOutput(terminalId, chunk, telegramConfig);

export const enqueueTelegramCommandFromKeystrokes = (terminalId: string, data: string) =>
  enqueueRemoteCommandFromKeystrokes(terminalId, data, telegramConfig);
