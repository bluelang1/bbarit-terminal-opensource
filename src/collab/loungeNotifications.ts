import { getVersion } from '@tauri-apps/api/app';
import { emit as tauriEmit } from '@tauri-apps/api/event';
import { isPermissionGranted as notifIsPermissionGranted, requestPermission as notifRequestPermission, sendNotification as notifSend } from '@tauri-apps/plugin-notification';
import { getConfigSnapshot } from '../config/ConfigContext';
import {
  LOUNGE_BLOCKED_KEY,
  LOUNGE_GENERAL_ROOM,
  LOUNGE_ICON_KEY,
  LOUNGE_NICK_KEY,
  LOUNGE_NOTICE_KEY,
  LoungeClient,
  decryptIncoming,
  filterBlocked,
  lastSeqKey,
  loadBlockedTags,
  markLoungeMessagesSelf,
  mergeMessages,
} from './loungeClient';
import type { LoungeMessage } from './loungeClient';
import { loadIdentity } from './loungeIdentity';

export const LOUNGE_UNREAD_KEY = 'bbarit-lounge-unread-v1';
export const LOUNGE_NOTIFIED_ROOMS_KEY = 'bbarit-lounge-notified-rooms-v1';
export const LOUNGE_UNREAD_EVENT = 'bbarit-lounge-unread-changed';

export type LoungeUnreadCounts = Record<string, number>;

interface LoungeRoomSpec {
  name: string;
  pass?: string;
  key?: string;
}

const LOUNGE_ROOMS_KEY = 'bbarit-lounge-rooms';
const LOUNGE_MSG_CACHE_PREFIX = 'bbarit-lounge-msgs:';
const LOUNGE_MSG_CACHE_LIMIT = 50;

export function sanitizeUnreadCounts(value: unknown): LoungeUnreadCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: LoungeUnreadCounts = {};
  for (const [room, count] of Object.entries(value as Record<string, unknown>)) {
    const normalized = Math.max(0, Math.floor(Number(count) || 0));
    if (room && normalized > 0) next[room] = normalized;
  }
  return next;
}

export function loadLoungeUnreadCounts(): LoungeUnreadCounts {
  try {
    return sanitizeUnreadCounts(JSON.parse(localStorage.getItem(LOUNGE_UNREAD_KEY) || '{}'));
  } catch {
    return {};
  }
}

export function saveLoungeUnreadCounts(counts: LoungeUnreadCounts): LoungeUnreadCounts {
  const normalized = sanitizeUnreadCounts(counts);
  try { localStorage.setItem(LOUNGE_UNREAD_KEY, JSON.stringify(normalized)); } catch { /* ignore */ }
  return normalized;
}

export function totalLoungeUnread(counts: LoungeUnreadCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

// Opt-in by room: an absent key or a newly joined room is silent by default.
export function loadNotifiedLoungeRooms(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(LOUNGE_NOTIFIED_ROOMS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter((room): room is string => typeof room === 'string' && !!room) : []);
  } catch {
    return new Set();
  }
}

export function saveNotifiedLoungeRooms(rooms: Set<string>): void {
  try { localStorage.setItem(LOUNGE_NOTIFIED_ROOMS_KEY, JSON.stringify([...rooms])); } catch { /* ignore */ }
}

function loadRoomSpecs(): LoungeRoomSpec[] {
  try {
    const value = JSON.parse(localStorage.getItem(LOUNGE_ROOMS_KEY) || '[]');
    const privateRooms = Array.isArray(value)
      ? value.filter((room): room is LoungeRoomSpec => !!room && typeof room.name === 'string' && !!room.name && room.name !== LOUNGE_GENERAL_ROOM)
      : [];
    return [{ name: LOUNGE_GENERAL_ROOM }, ...privateRooms];
  } catch {
    return [{ name: LOUNGE_GENERAL_ROOM }];
  }
}

function loadMessageCache(room: string): LoungeMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(LOUNGE_MSG_CACHE_PREFIX + room) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveMessageCache(room: string, messages: LoungeMessage[]): void {
  try {
    localStorage.setItem(LOUNGE_MSG_CACHE_PREFIX + room, JSON.stringify(messages.slice(-LOUNGE_MSG_CACHE_LIMIT)));
  } catch { /* ignore */ }
}

async function sendRoomNotification(room: string, message: LoungeMessage): Promise<void> {
  if (!loadNotifiedLoungeRooms().has(room)) return;
  try {
    let granted = await notifIsPermissionGranted();
    if (!granted) granted = (await notifRequestPermission()) === 'granted';
    if (!granted) return;
    const settings = getConfigSnapshot().agent;
    const opts: { title: string; body: string; sound?: string; silent?: boolean } = {
      title: `${message.from.name} · #${room}`,
      body: message.text.length > 180 ? `${message.text.slice(0, 180)}…` : message.text,
    };
    const isWindows = navigator.platform.toLowerCase().includes('win');
    if (settings.playOsNotifySound !== false) {
      if (!isWindows) opts.sound = settings.osNotifySoundName || 'Glass';
    } else if (isWindows) {
      opts.silent = true;
    }
    notifSend(opts);
  } catch { /* notifications unavailable */ }
}

/**
 * Keeps unread counts and opted-in OS alerts alive while the standalone chat
 * window is closed. The caller must stop this monitor before opening ChatPage,
 * which owns the same room connections while it is visible.
 */
export async function startLoungeUnreadMonitor(): Promise<() => void> {
  if (localStorage.getItem(LOUNGE_NOTICE_KEY) !== '1') return () => {};
  const identity = await loadIdentity().catch(() => null);
  if (!identity) return () => {};
  const appVersion = await getVersion().catch(() => '0.0.0');
  const name = (localStorage.getItem(LOUNGE_NICK_KEY) || identity.defaultNick).trim() || identity.defaultNick;
  const clients: LoungeClient[] = [];
  let stopped = false;

  for (const spec of loadRoomSpecs()) {
    if (stopped) break;
    const client = new LoungeClient({
      url: identity.url,
      deviceId: identity.deviceId,
      name,
      appVersion,
      afterSeq: Number(localStorage.getItem(lastSeqKey(spec.name))) || 0,
      icon: localStorage.getItem(LOUNGE_ICON_KEY) || undefined,
      room: spec.name,
      roomPass: spec.pass,
    });
    let selfTag = '';
    client.on('welcome', (me, _count, history, room) => {
      if (room.name !== spec.name) { client.close(); return; }
      selfTag = me.tag;
      void decryptIncoming(spec.key, history).then((decrypted) => {
        const withSelf = markLoungeMessagesSelf(decrypted, selfTag);
        const cached = markLoungeMessagesSelf(loadMessageCache(spec.name), selfTag);
        saveMessageCache(spec.name, mergeMessages(cached, withSelf));
      });
      if (history.length) localStorage.setItem(lastSeqKey(spec.name), String(client.afterSeq));
    });
    client.on('chat', (message) => {
      void decryptIncoming(spec.key, [message]).then(([decrypted]) => {
        const [normalized] = markLoungeMessagesSelf([decrypted], selfTag);
        saveMessageCache(spec.name, mergeMessages(loadMessageCache(spec.name), [normalized]));
        const blocked = loadBlockedTags(localStorage.getItem(LOUNGE_BLOCKED_KEY));
        if (normalized.self || filterBlocked([normalized], blocked).length === 0) return;
        const counts = loadLoungeUnreadCounts();
        const next = saveLoungeUnreadCounts({ ...counts, [spec.name]: (counts[spec.name] || 0) + 1 });
        void tauriEmit(LOUNGE_UNREAD_EVENT, { counts: next });
        void sendRoomNotification(spec.name, normalized);
      });
      localStorage.setItem(lastSeqKey(spec.name), String(message.seq));
    });
    client.connect();
    clients.push(client);
  }

  return () => {
    stopped = true;
    for (const client of clients) client.close();
  };
}
