/**
 * Slack mirroring — thin wrapper around remoteMirror.ts
 */

import { invoke } from '@tauri-apps/api/core';
import {
  flushRemoteScreen,
  enqueueRemoteOutput,
  enqueueRemoteCommandFromKeystrokes,
  type RemotePlatformConfig,
} from './remoteMirror';
import { kvGet } from '../hooks/useKV';

export const slackSendBestEffort = (text: string, channelId?: string) => {
  const t = (text || '').trim();
  if (!t) return;
  const channel = (channelId || '').trim();
  if (!channel) return;
  kvGet('octo-slack-bot-token').then(raw => {
    const botToken = (raw || '').trim();
    if (!botToken) return;
    invoke('slack_send_message', { botToken, channel, text: t }).catch(() => {});
  }).catch(() => {});
};

const slackConfig: RemotePlatformConfig = {
  maxChunkSize: 3900,
  sendFn: slackSendBestEffort,
  stateKey: 'slack',
};

export const flushSlackScreen = (terminalId: string) =>
  flushRemoteScreen(terminalId, slackConfig);

export const enqueueSlackOutput = (terminalId: string, chunk: string) =>
  enqueueRemoteOutput(terminalId, chunk, slackConfig);

export const enqueueSlackCommandFromKeystrokes = (terminalId: string, data: string) =>
  enqueueRemoteCommandFromKeystrokes(terminalId, data, slackConfig);
