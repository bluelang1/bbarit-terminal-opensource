import { invoke } from '@tauri-apps/api/core';
import { LOUNGE_DEFAULT_URL } from './loungeClient';

// Shared by the Chat window and the (fallback) Community modal tab.

export const AVATAR_ICONS = [
  '🙂', '😎', '🤓', '🥳', '🤠', '👻', '🤖', '👾',
  '🦊', '🐸', '🐙', '🐧', '🦁', '🐯', '🐼', '🐨',
  '🐰', '🦄', '🐲', '🦉', '🐳', '🦀', '🍀', '⚡',
];

export const EMOJI_SET = [
  '😀', '😂', '🤣', '😊', '😍', '🤔', '😅', '😭',
  '😡', '🥹', '😴', '🤯', '🫡', '🙏', '👍', '👎',
  '👏', '🙌', '💪', '🔥', '✨', '🎉', '❤️', '💯',
  '✅', '❌', '❓', '💡', '🚀', '🐛', '☕', '💻',
];

function parseEnvLine(content: string, key: string): string {
  const m = content.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'));
  if (!m) return '';
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

export interface LoungeIdentity {
  deviceId: string;
  url: string;
  defaultNick: string;
}

export async function loadIdentity(): Promise<LoungeIdentity> {
  const home = await invoke<string>('get_home_dir');
  const path = `${home}/.config/octo/.env`;
  const content = await invoke<string>('read_file', { path }).catch(() => '');
  let deviceId = parseEnvLine(String(content || ''), 'BBARIT_DEVICE_ID');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await invoke('create_directory', { path: `${home}/.config/octo` }).catch(() => {});
    const base = String(content || '');
    const next = `${base}${base && !base.endsWith('\n') ? '\n' : ''}BBARIT_DEVICE_ID=${deviceId}\n`;
    await invoke('write_file', { path, content: next }).catch(() => {});
  }
  const url = parseEnvLine(String(content || ''), 'BBARIT_LOUNGE_URL') || LOUNGE_DEFAULT_URL;
  const defaultNick = home.split('/').filter(Boolean).pop() || 'bbarit-user';
  return { deviceId, url, defaultNick };
}
