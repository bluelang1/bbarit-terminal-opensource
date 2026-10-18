/**
 * Discord mirroring — thin wrapper around remoteMirror.ts
 */

import { invoke } from '@tauri-apps/api/core';
import {
  flushRemoteScreen,
  enqueueRemoteOutput,
  enqueueRemoteCommandFromKeystrokes,
  type RemotePlatformConfig,
} from './remoteMirror';
import { kvGet } from '../hooks/useKV';

export const discordSendBestEffort = (text: string, channelId?: string) => {
  const t = (text || '').trim();
  if (!t) return;
  const channel = (channelId || '').trim();
  if (!channel) return;
  kvGet('octo-discord-bot-token').then(raw => {
    const botToken = (raw || '').trim();
    if (!botToken) return;
    invoke('discord_send_message', { botToken, channelId: channel, text: t }).catch(() => {});
  }).catch(() => {});
};

const discordConfig: RemotePlatformConfig = {
  maxChunkSize: 1950,
  sendFn: discordSendBestEffort,
  stateKey: 'discord',
};

export const flushDiscordScreen = (terminalId: string) =>
  flushRemoteScreen(terminalId, discordConfig);

export const enqueueDiscordOutput = (terminalId: string, chunk: string) =>
  enqueueRemoteOutput(terminalId, chunk, discordConfig);

export const enqueueDiscordCommandFromKeystrokes = (terminalId: string, data: string) =>
  enqueueRemoteCommandFromKeystrokes(terminalId, data, discordConfig);
