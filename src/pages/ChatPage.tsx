import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen as tauriListen, emit as tauriEmit } from '@tauri-apps/api/event';
import { isPermissionGranted as notifIsPermissionGranted, requestPermission as notifRequestPermission, sendNotification as notifSend } from '@tauri-apps/plugin-notification';
import { Bell, BellOff, Globe, Lock, LogOut, Plus, Send, ShieldCheck, Smile, Wifi, WifiOff, X } from 'lucide-react';
import {
  LOUNGE_BLOCKED_KEY,
  LOUNGE_GENERAL_ROOM,
  LOUNGE_ICON_KEY,
  LOUNGE_NICK_KEY,
  LOUNGE_NOTICE_KEY,
  LoungeClient,
  decryptIncoming,
  deriveRoomKeyHex,
  encryptText,
  filterBlocked,
  hashRoomPass,
  lastSeqKey,
  loadBlockedTags,
  markLoungeMessagesSelf,
  mergeMessages,
  normalizeRoomName,
} from '../collab/loungeClient';
import type { LoungeMessage, LoungeRoomInfo, LoungeStatus, LoungeUser } from '../collab/loungeClient';
import { AVATAR_ICONS, EMOJI_SET, loadIdentity } from '../collab/loungeIdentity';
import { AVATAR_IMAGE_COUNT, LoungeAvatar, avatarSrc } from '../collab/LoungeAvatar';
import { getConfigSnapshot } from '../config/ConfigContext';
import {
  LOUNGE_UNREAD_EVENT,
  loadLoungeUnreadCounts,
  loadNotifiedLoungeRooms,
  saveLoungeUnreadCounts,
  saveNotifiedLoungeRooms,
  type LoungeUnreadCounts,
} from '../collab/loungeNotifications';

// KakaoTalk-style standalone messenger window (/chat tool window).

const ROOMS_KEY = 'bbarit-lounge-rooms';
const ACTIVE_ROOM_KEY = 'bbarit-lounge-active-room';
const MSG_CACHE_PREFIX = 'bbarit-lounge-msgs:';
const MSG_CACHE_LIMIT = 50;

const C = {
  bg: '#0f1115',
  sidebar: '#151922',
  pane: '#0b0d12',
  line: '#252b38',
  text: '#e6edf3',
  dim: '#8b95a5',
  accent: '#DE2A44',
  bubble: '#222836',
};

interface RoomSpec {
  name: string;
  pass?: string; // hashed credential (hashRoomPass) — never the raw password
  key?: string; // E2E AES key hex (deriveRoomKeyHex) — never sent anywhere
}

function loadRooms(): RoomSpec[] {
  try {
    const arr = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]');
    if (Array.isArray(arr)) {
      return arr.filter((r) => r && typeof r.name === 'string' && r.name && r.name !== LOUNGE_GENERAL_ROOM);
    }
  } catch {}
  return [];
}


function saveRooms(rooms: RoomSpec[]) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}

function loadMsgCache(room: string): LoungeMessage[] {
  try {
    const arr = JSON.parse(localStorage.getItem(MSG_CACHE_PREFIX + room) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveMsgCache(room: string, messages: LoungeMessage[]) {
  try {
    localStorage.setItem(MSG_CACHE_PREFIX + room, JSON.stringify(messages.slice(-MSG_CACHE_LIMIT)));
  } catch {}
}

function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function ChatPage() {
  const [agreed, setAgreed] = useState(() => localStorage.getItem(LOUNGE_NOTICE_KEY) === '1');
  const [nick, setNick] = useState(() => localStorage.getItem(LOUNGE_NICK_KEY) || '');
  const [icon, setIcon] = useState(() => localStorage.getItem(LOUNGE_ICON_KEY) || '🙂');
  const [rooms, setRooms] = useState<RoomSpec[]>(loadRooms);
  const [activeRoom, setActiveRoom] = useState(() => localStorage.getItem(ACTIVE_ROOM_KEY) || LOUNGE_GENERAL_ROOM);
  const [roomInfo, setRoomInfo] = useState<LoungeRoomInfo | null>(null);
  const [status, setStatus] = useState<LoungeStatus>('idle');
  const [online, setOnline] = useState(0);
  const [motd, setMotd] = useState('');
  const [you, setYou] = useState<LoungeUser | null>(null);
  const [messages, setMessages] = useState<LoungeMessage[]>(() => loadMsgCache(localStorage.getItem(ACTIVE_ROOM_KEY) || LOUNGE_GENERAL_ROOM));
  const [blocked, setBlocked] = useState<Set<string>>(() => loadBlockedTags(localStorage.getItem(LOUNGE_BLOCKED_KEY)));
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [picker, setPicker] = useState<'avatar' | 'emoji' | null>(null);
  const [addForm, setAddForm] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [roomPassInput, setRoomPassInput] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<LoungeUnreadCounts>(loadLoungeUnreadCounts);
  const [notifiedRooms, setNotifiedRooms] = useState<Set<string>>(loadNotifiedLoungeRooms);
  const clientRef = useRef<LoungeClient | null>(null);
  const backgroundClientsRef = useRef<Map<string, LoungeClient>>(new Map());
  const activeRoomRef = useRef(activeRoom);
  const youRef = useRef<LoungeUser | null>(you);
  const focusedRef = useRef(document.hasFocus());
  const blockedRef = useRef(blocked);
  const notifiedRoomsRef = useRef(notifiedRooms);
  const endRef = useRef<HTMLDivElement | null>(null);
  // Encrypt-then-send bound to the current room spec; shared by the input bar
  // and the gateway event bridge so both paths get E2E in private rooms.
  const sendTextRef = useRef<(text: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: false, error: 'not_connected' }));
  activeRoomRef.current = activeRoom;
  youRef.current = you;
  blockedRef.current = blocked;
  notifiedRoomsRef.current = notifiedRooms;

  const publishUnread = useCallback((next: LoungeUnreadCounts) => {
    const saved = saveLoungeUnreadCounts(next);
    void tauriEmit(LOUNGE_UNREAD_EVENT, { counts: saved });
    return saved;
  }, []);

  const markRoomRead = useCallback((room: string) => {
    setUnreadCounts((prev) => {
      if (!prev[room]) return prev;
      const next = { ...prev };
      delete next[room];
      return publishUnread(next);
    });
  }, [publishUnread]);

  const showRoomNotification = useCallback(async (room: string, message: LoungeMessage) => {
    if (message.self || blockedRef.current.has(message.from.tag) || !notifiedRoomsRef.current.has(room)) return;
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
  }, []);

  const handleIncoming = useCallback((room: string, message: LoungeMessage, roomKey?: string) => {
    void decryptIncoming(roomKey, [message]).then(([decrypted]) => {
      const [normalized] = markLoungeMessagesSelf([decrypted], youRef.current?.tag);
      const cache = mergeMessages(loadMsgCache(room), [normalized]);
      saveMsgCache(room, cache);
      if (room === activeRoomRef.current) setMessages((prev) => mergeMessages(prev, [normalized]));
      if (normalized.self || blockedRef.current.has(normalized.from.tag)) return;
      const visibleNow = focusedRef.current && room === activeRoomRef.current;
      if (visibleNow) {
        markRoomRead(room);
        return;
      }
      setUnreadCounts((prev) => publishUnread({ ...prev, [room]: (prev[room] || 0) + 1 }));
      void showRoomNotification(room, normalized);
    });
    localStorage.setItem(lastSeqKey(room), String(message.seq));
  }, [markRoomRead, publishUnread, showRoomNotification]);

  const handleIncomingRef = useRef(handleIncoming);
  handleIncomingRef.current = handleIncoming;

  const specFor = useCallback((name: string): RoomSpec => {
    if (name === LOUNGE_GENERAL_ROOM) return { name: LOUNGE_GENERAL_ROOM };
    return rooms.find((r) => r.name === name) || { name: LOUNGE_GENERAL_ROOM };
  }, [rooms]);

  const connect = useCallback(async (spec: RoomSpec) => {
    clientRef.current?.close();
    clientRef.current = null;
    setNotice('');
    let identity;
    try {
      identity = await loadIdentity();
    } catch (e) {
      setNotice(`Failed to load identity: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const appVersion = await getVersion().catch(() => '0.0.0');
    const name = (localStorage.getItem(LOUNGE_NICK_KEY) || identity.defaultNick).trim() || identity.defaultNick;
    if (!localStorage.getItem(LOUNGE_NICK_KEY)) {
      localStorage.setItem(LOUNGE_NICK_KEY, name);
      setNick(name);
    }
    const afterSeq = Number(localStorage.getItem(lastSeqKey(spec.name))) || 0;
    const client = new LoungeClient({
      url: identity.url,
      deviceId: identity.deviceId,
      name,
      appVersion,
      afterSeq,
      icon: localStorage.getItem(LOUNGE_ICON_KEY) || undefined,
      room: spec.name,
      roomPass: spec.pass,
    });
    clientRef.current = client;
    client.on('status', setStatus);
    client.on('welcome', (me, count, history, room, serverMotd) => {
      // An M1 server silently ignores the room field — never let a private-room
      // join land in #general without the user knowing.
      if (room.name !== spec.name) {
        client.close();
        setNotice(`Server put us in #${room.name} instead of #${spec.name} — private rooms need a server update`);
        setActiveRoom(LOUNGE_GENERAL_ROOM);
        localStorage.setItem(ACTIVE_ROOM_KEY, LOUNGE_GENERAL_ROOM);
        setMessages(loadMsgCache(LOUNGE_GENERAL_ROOM));
        void connect({ name: LOUNGE_GENERAL_ROOM });
        return;
      }
      youRef.current = me;
      setYou(me);
      setOnline(count);
      setRoomInfo(room);
      setMotd(serverMotd || '');
      void decryptIncoming(spec.key, history).then((decrypted) => {
        setMessages((prev) => {
          const withSelf = markLoungeMessagesSelf(decrypted, me.tag);
          const normalizedPrev = markLoungeMessagesSelf(prev, me.tag);
          const next = mergeMessages(normalizedPrev, withSelf);
          saveMsgCache(room.name, next);
          return next;
        });
      });
      if (history.length) localStorage.setItem(lastSeqKey(room.name), String(client.afterSeq));
    });
    client.on('chat', (m) => {
      handleIncomingRef.current(spec.name, m, spec.key);
    });
    client.on('online', setOnline);
    client.on('deleted', (seq) => setMessages((prev) => prev.filter((m) => m.seq !== seq)));
    client.on('error', (code, message, retryAfterMs) => {
      if (code === 'rate_limited') {
        setNotice(`Slow down — retry in ${Math.ceil((retryAfterMs || 3000) / 1000)}s`);
        return;
      }
      if (code === 'wrong_password' || code === 'password_required') {
        setNotice(code === 'wrong_password' ? `Wrong password for #${spec.name}` : `#${spec.name} needs a password`);
        setRooms((prev) => {
          const next = prev.filter((r) => r.name !== spec.name);
          saveRooms(next);
          return next;
        });
        setActiveRoom(LOUNGE_GENERAL_ROOM);
        localStorage.setItem(ACTIVE_ROOM_KEY, LOUNGE_GENERAL_ROOM);
        setMessages(loadMsgCache(LOUNGE_GENERAL_ROOM));
        setRoomNameInput(spec.name);
        setAddForm(true);
        void connect({ name: LOUNGE_GENERAL_ROOM });
        return;
      }
      setNotice(message || code);
    });
    sendTextRef.current = async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'empty' };
      if (trimmed.length > 1000) return { ok: false, error: 'too_long' };
      const payload = spec.key ? await encryptText(spec.key, trimmed) : trimmed;
      return client.send(payload);
    };
    client.connect();
  }, []);

  // Keep one lightweight connection per inactive room. This lets a private room
  // receive its own unread badge and OS alert while the user is reading another room.
  useEffect(() => {
    if (!agreed) return;
    let disposed = false;
    const desired = new Map(
      [{ name: LOUNGE_GENERAL_ROOM } as RoomSpec, ...rooms]
        .filter((spec) => spec.name !== activeRoom)
        .map((spec) => [spec.name, spec]),
    );

    for (const [name, client] of backgroundClientsRef.current) {
      if (!desired.has(name)) {
        client.close();
        backgroundClientsRef.current.delete(name);
      }
    }

    void (async () => {
      const identity = await loadIdentity().catch(() => null);
      if (!identity || disposed) return;
      const appVersion = await getVersion().catch(() => '0.0.0');
      const name = (localStorage.getItem(LOUNGE_NICK_KEY) || identity.defaultNick).trim() || identity.defaultNick;
      for (const spec of desired.values()) {
        if (disposed || backgroundClientsRef.current.has(spec.name)) continue;
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
        client.on('welcome', (_me, _count, history, room) => {
          if (room.name !== spec.name) { client.close(); return; }
          void decryptIncoming(spec.key, history).then((decrypted) => {
            const withSelf = markLoungeMessagesSelf(decrypted, _me.tag);
            const cached = markLoungeMessagesSelf(loadMsgCache(spec.name), _me.tag);
            saveMsgCache(spec.name, mergeMessages(cached, withSelf));
          });
          if (history.length) localStorage.setItem(lastSeqKey(spec.name), String(client.afterSeq));
        });
        client.on('chat', (message) => handleIncomingRef.current(spec.name, message, spec.key));
        client.connect();
        backgroundClientsRef.current.set(spec.name, client);
      }
    })();

    return () => { disposed = true; };
  }, [activeRoom, agreed, rooms]);

  useEffect(() => () => {
    for (const client of backgroundClientsRef.current.values()) client.close();
    backgroundClientsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!agreed) return;
    void connect(specFor(activeRoom));
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
    // Room switches reconnect via switchRoom(); this effect only bootstraps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agreed, connect]);

  // Immediate retry on focus / network recovery
  useEffect(() => {
    const retry = () => clientRef.current?.retryNow();
    const onFocus = () => {
      focusedRef.current = true;
      retry();
      markRoomRead(activeRoomRef.current);
    };
    const onBlur = () => { focusedRef.current = false; };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('online', retry);
    };
  }, [markRoomRead]);

  // Gateway bridge: the main window forwards `lounge.send` here via Tauri events.
  useEffect(() => {
    const handled = new Set<string>();
    const un = tauriListen<{ requestId?: string; text?: string }>('bbarit-lounge-send', (ev) => {
      const requestId = String(ev.payload?.requestId || '');
      // StrictMode double-mount can deliver the same event to a stale listener — dedupe by id.
      if (!requestId || handled.has(requestId)) return;
      handled.add(requestId);
      void sendTextRef.current(String(ev.payload?.text || '')).then((res) => {
        void tauriEmit('bbarit-lounge-send-result', { requestId, ...res });
      });
    });
    return () => {
      un.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  useEffect(() => {
    if (document.hasFocus()) markRoomRead(activeRoom);
  }, [activeRoom, markRoomRead]);

  const switchRoom = useCallback((name: string) => {
    markRoomRead(name);
    if (name === activeRoomRef.current) return;
    setActiveRoom(name);
    localStorage.setItem(ACTIVE_ROOM_KEY, name);
    setMessages(loadMsgCache(name));
    setOnline(0);
    setRoomInfo(null);
    setPicker(null);
    void connect(name === LOUNGE_GENERAL_ROOM ? { name } : specFor(name));
  }, [connect, markRoomRead, specFor]);

  const toggleRoomNotifications = useCallback((room: string) => {
    setNotifiedRooms((prev) => {
      const next = new Set(prev);
      if (next.has(room)) next.delete(room);
      else next.add(room);
      saveNotifiedLoungeRooms(next);
      return next;
    });
  }, []);

  const addRoom = useCallback(() => {
    const name = normalizeRoomName(roomNameInput);
    const pass = roomPassInput;
    if (!name || name === LOUNGE_GENERAL_ROOM) {
      setNotice('Enter a room name (a-z, 0-9, dash)');
      return;
    }
    if (!pass) {
      setNotice('Private rooms need a password');
      return;
    }
    void (async () => {
      const spec: RoomSpec = {
        name,
        pass: await hashRoomPass(name, pass),
        key: await deriveRoomKeyHex(name, pass),
      };
      // Joining through the form is always a fresh (re)join — reset the seq
      // cursor so the server replays its recent history instead of "nothing new".
      localStorage.removeItem(lastSeqKey(name));
      setRooms((prev) => {
        const next = [...prev.filter((r) => r.name !== name), spec];
        saveRooms(next);
        return next;
      });
      setAddForm(false);
      setRoomNameInput('');
      setRoomPassInput('');
      setActiveRoom(name);
      localStorage.setItem(ACTIVE_ROOM_KEY, name);
      setMessages(loadMsgCache(name));
      setOnline(0);
      void connect(spec);
    })();
  }, [roomNameInput, roomPassInput, connect]);

  const removeRoom = useCallback((name: string) => {
    markRoomRead(name);
    setRooms((prev) => {
      const next = prev.filter((r) => r.name !== name);
      saveRooms(next);
      return next;
    });
    localStorage.removeItem(MSG_CACHE_PREFIX + name);
    // Drop the afterSeq cursor too — otherwise a later rejoin asks the server
    // only for "messages after the last one I saw" and the room looks empty.
    localStorage.removeItem(lastSeqKey(name));
    if (activeRoomRef.current === name) switchRoom(LOUNGE_GENERAL_ROOM);
  }, [markRoomRead, switchRoom]);

  const sendNow = useCallback(() => {
    void sendTextRef.current(input).then((res) => {
      if (res.ok) {
        setInput('');
        setNotice('');
      } else if (res.error === 'too_long') {
        setNotice('Message too long (max 1,000 chars)');
      } else if (res.error === 'not_connected') {
        setNotice('Not connected yet');
      }
    });
  }, [input]);

  const applyNick = useCallback(() => {
    const name = nick.trim();
    if (!name || name === localStorage.getItem(LOUNGE_NICK_KEY)) return;
    localStorage.setItem(LOUNGE_NICK_KEY, name);
    void connect(specFor(activeRoomRef.current));
  }, [nick, connect, specFor]);

  const applyIcon = useCallback((next: string) => {
    setIcon(next);
    setYou((prev) => prev ? { ...prev, icon: next } : prev);
    setMessages((prev) => prev.map((message) => message.self
      ? { ...message, from: { ...message.from, icon: next } }
      : message));
    localStorage.setItem(LOUNGE_ICON_KEY, next);
    setPicker(null);
    void connect(specFor(activeRoomRef.current));
  }, [connect, specFor]);

  const toggleBlock = useCallback((tag: string) => {
    setBlocked((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      localStorage.setItem(LOUNGE_BLOCKED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  if (!agreed) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, color: C.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
        <div style={{ width: 400, padding: 24, background: C.sidebar, border: `1px solid ${C.line}`, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 16 }}>
            <Globe size={17} color={C.accent} /> BBARIT Chat
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6, color: C.dim }}>
            #general is public: messages are visible to all BBARIT Terminal users and retained for 7 days.
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.6, color: '#7ce38b', display: 'flex', gap: 7 }}>
            <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>Private rooms are <b>end-to-end encrypted</b> — only people who know the room password can read them. Not even the BBARIT server can.</span>
          </div>
          <button
            onClick={() => { localStorage.setItem(LOUNGE_NOTICE_KEY, '1'); setAgreed(true); }}
            style={{ padding: '9px 16px', background: C.accent, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}
          >
            Agree & Join
          </button>
        </div>
      </div>
    );
  }

  const visible = filterBlocked(messages, blocked);
  const sidebarRooms: Array<{ name: string; private: boolean }> = [
    { name: LOUNGE_GENERAL_ROOM, private: false },
    ...rooms.map((r) => ({ name: r.name, private: true })),
  ];
  const inPrivateRoom = activeRoom !== LOUNGE_GENERAL_ROOM;

  const pickerPanelStyle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 20,
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 32px)',
    gap: 2,
    padding: 8,
    background: C.sidebar,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
  };
  const pickerBtnStyle: React.CSSProperties = {
    width: 32,
    height: 32,
    border: 'none',
    background: 'transparent',
    borderRadius: 6,
    fontSize: 18,
    cursor: 'pointer',
    lineHeight: 1,
  };

  return (
    <div style={{ height: '100vh', display: 'flex', background: C.bg, color: C.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif', overflow: 'hidden' }}>
      {/* ── Sidebar: room list ── */}
      <div style={{ width: 240, flexShrink: 0, background: C.sidebar, borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 14px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 15, flex: 1 }}>Chats</span>
          <button
            onClick={() => { setAddForm((v) => !v); setPicker(null); }}
            title="Join or create a private room"
            style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.line}`, borderRadius: 8, background: addForm ? `${C.accent}22` : 'transparent', color: C.text, cursor: 'pointer' }}
          >
            <Plus size={13} />
          </button>
        </div>

        {addForm && (
          <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              value={roomNameInput}
              onChange={(e) => setRoomNameInput(e.target.value)}
              placeholder="room-name"
              maxLength={24}
              style={{ padding: '6px 8px', border: `1px solid ${C.line}`, borderRadius: 8, background: C.bg, color: C.text, fontSize: 12 }}
            />
            <input
              value={roomPassInput}
              onChange={(e) => setRoomPassInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addRoom(); }}
              type="password"
              placeholder="password"
              maxLength={64}
              style={{ padding: '6px 8px', border: `1px solid ${C.line}`, borderRadius: 8, background: C.bg, color: C.text, fontSize: 12 }}
            />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={addRoom} style={{ padding: '5px 14px', background: C.accent, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
                Join
              </button>
              <span style={{ fontSize: 10, color: '#3fb950' }}>🔒 End-to-end encrypted · new name + password creates it</span>
            </div>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {sidebarRooms.map((r) => {
            const cache = r.name === activeRoom ? messages : loadMsgCache(r.name);
            const last = cache.length ? cache[cache.length - 1] : null;
            const active = r.name === activeRoom;
            return (
              <div
                key={r.name}
                onClick={() => switchRoom(r.name)}
                style={{
                  padding: '10px 14px',
                  cursor: 'pointer',
                  background: active ? `${C.accent}1a` : 'transparent',
                  borderLeft: `3px solid ${active ? C.accent : 'transparent'}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                  {r.private ? <Lock size={11} color={C.dim} /> : <Globe size={11} color={C.dim} />}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{r.name}</span>
                  {(unreadCounts[r.name] || 0) > 0 && (
                    <span aria-label={`${unreadCounts[r.name]} unread messages`} style={{ minWidth: 17, height: 17, padding: '0 5px', borderRadius: 999, background: C.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 900 }}>
                      {unreadCounts[r.name] > 99 ? '99+' : unreadCounts[r.name]}
                    </span>
                  )}
                  {last && <span style={{ fontSize: 9, color: C.dim, fontWeight: 400 }}>{timeLabel(last.ts)}</span>}
                  {r.private && (
                    <button
                      onClick={(e) => { e.stopPropagation(); removeRoom(r.name); }}
                      title="Leave room"
                      style={{ border: 0, background: 'transparent', color: C.dim, cursor: 'pointer', padding: 0, display: 'flex' }}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {last ? `${last.self ? 'me' : last.from.name}: ${last.text}` : r.private ? 'Private room' : 'All BBARIT Terminal users'}
                </div>
              </div>
            );
          })}
        </div>

        {/* Profile footer */}
        <div style={{ position: 'relative', padding: 10, borderTop: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setPicker(picker === 'avatar' ? null : 'avatar')}
            title="Pick your avatar"
            style={{ width: 32, height: 32, border: `1px solid ${C.line}`, borderRadius: 10, background: picker === 'avatar' ? `${C.accent}22` : C.bg, cursor: 'pointer', lineHeight: 1, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <LoungeAvatar icon={icon} size={22} />
          </button>
          <input
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyNick(); }}
            onBlur={applyNick}
            placeholder="Set nickname…"
            maxLength={24}
            style={{ flex: 1, minWidth: 0, padding: '6px 8px', border: `1px solid ${C.line}`, borderRadius: 8, background: 'transparent', color: C.text, fontSize: 12 }}
          />
          {you && <span style={{ fontSize: 10, color: C.dim }}>#{you.tag}</span>}
          {picker === 'avatar' && (
            <div style={{ ...pickerPanelStyle, bottom: 52, left: 10, gridTemplateColumns: 'repeat(10, 28px)', maxHeight: 320, overflowY: 'auto' }}>
              {Array.from({ length: AVATAR_IMAGE_COUNT }, (_, i) => `av:${i}`).map((a) => (
                <button key={a} onClick={() => applyIcon(a)} title={a}
                  style={{ ...pickerBtnStyle, width: 28, height: 28, padding: 2, background: a === icon ? `${C.accent}33` : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                  <img src={avatarSrc(a)} alt="" width={24} height={24} style={{ borderRadius: '30%', display: 'block' }} draggable={false} loading="lazy" />
                </button>
              ))}
              {AVATAR_ICONS.map((a) => (
                <button key={a} onClick={() => applyIcon(a)} style={{ ...pickerBtnStyle, width: 28, height: 28, fontSize: 16, background: a === icon ? `${C.accent}33` : 'transparent' }}>{a}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Chat pane ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.pane, position: 'relative' }}>
        {/* Header */}
        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {inPrivateRoom ? <Lock size={13} color={C.accent} /> : <Globe size={13} color={C.accent} />}
            #{roomInfo?.name || activeRoom}
          </span>
          {status === 'connected' ? <Wifi size={13} color="#3fb950" /> : <WifiOff size={13} color={C.dim} />}
          <span style={{ fontSize: 12, color: C.dim }}>
            {status === 'connected' ? `Online ${online}` : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline'}
          </span>
          {inPrivateRoom && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', background: '#17251b', border: '1px solid #2ea04355', borderRadius: 999, color: '#3fb950', fontSize: 10, fontWeight: 800 }}>
              <ShieldCheck size={11} /> End-to-end encrypted
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            onClick={() => toggleRoomNotifications(activeRoom)}
            title={notifiedRooms.has(activeRoom) ? 'Mute notifications for this room' : 'Enable notifications for this room'}
            aria-label={notifiedRooms.has(activeRoom) ? 'Mute room notifications' : 'Enable room notifications'}
            style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.line}`, borderRadius: 8, background: notifiedRooms.has(activeRoom) ? `${C.accent}1a` : 'transparent', color: notifiedRooms.has(activeRoom) ? C.accent : C.dim, cursor: 'pointer' }}
          >
            {notifiedRooms.has(activeRoom) ? <Bell size={13} /> : <BellOff size={13} />}
          </button>
          {inPrivateRoom && (
            <button onClick={() => removeRoom(activeRoom)} title="Leave this room"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', border: `1px solid ${C.line}`, borderRadius: 8, background: 'transparent', color: C.dim, fontSize: 11, cursor: 'pointer' }}>
              <LogOut size={11} /> Leave
            </button>
          )}
        </div>

        {inPrivateRoom && (
          <div style={{ margin: '8px 16px 0', padding: '7px 11px', background: '#14211815', backgroundColor: '#151f18', border: '1px solid #2ea04333', borderRadius: 8, fontSize: 11.5, color: '#7ce38b', display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0, lineHeight: 1.45 }}>
            <ShieldCheck size={13} style={{ flexShrink: 0 }} />
            <span>Messages in this room are <b>end-to-end encrypted</b> with the room password. The BBARIT server only stores ciphertext — nobody but room members can read them.</span>
          </div>
        )}

        {motd && (
          <div style={{ margin: '8px 16px 0', padding: '6px 10px', background: `${C.accent}14`, border: `1px solid ${C.accent}44`, borderRadius: 8, fontSize: 12, flexShrink: 0 }}>
            {motd}
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {visible.length === 0 ? (
            <div style={{ color: C.dim, fontSize: 12, textAlign: 'center', margin: 'auto' }}>
              {status === 'connected'
                ? (inPrivateRoom ? `#${activeRoom} is quiet — say something` : 'Say hello to everyone using BBARIT Terminal')
                : 'Waiting for connection…'}
            </div>
          ) : (
            visible.map((m, i) => {
              const prev = visible[i - 1];
              const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString();
              const sameAuthor = !newDay && prev && !prev.self === !m.self && prev.from.tag === m.from.tag;
              return (
                <React.Fragment key={m.seq}>
                  {newDay && (
                    <div style={{ alignSelf: 'center', margin: '10px 0 6px', padding: '3px 12px', background: C.bubble, borderRadius: 999, fontSize: 10, color: C.dim }}>
                      {dayLabel(m.ts)}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: m.self ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 6, marginTop: sameAuthor ? 1 : 8 }}>
                    {!m.self && (
                      <span style={{ width: 30, display: 'inline-flex', justifyContent: 'center', visibility: sameAuthor ? 'hidden' : 'visible' }}>
                        <LoungeAvatar icon={m.from.icon} size={22} />
                      </span>
                    )}
                    <div style={{ maxWidth: '68%', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {!m.self && !sameAuthor && (
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.dim, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {m.from.name}<span style={{ opacity: 0.6 }}>#{m.from.tag}</span>
                          <button
                            onClick={() => toggleBlock(m.from.tag)}
                            title="Hide this user"
                            style={{ border: 0, background: 'transparent', color: 'inherit', opacity: 0.5, cursor: 'pointer', padding: 0, display: 'flex' }}
                          >
                            <X size={9} />
                          </button>
                        </div>
                      )}
                      <div style={{
                        padding: '7px 11px',
                        borderRadius: 12,
                        borderTopLeftRadius: m.self ? 12 : 4,
                        borderTopRightRadius: m.self ? 4 : 12,
                        background: m.unverified ? '#2a2313' : m.self ? C.accent : C.bubble,
                        border: m.unverified ? '1px solid #d2992288' : 'none',
                        color: m.self && !m.unverified ? '#fff' : C.text,
                        fontSize: 13,
                        lineHeight: 1.45,
                        wordBreak: 'break-word',
                        whiteSpace: 'pre-wrap',
                      }}>
                        {m.unverified && (
                          <div style={{ fontSize: 9, fontWeight: 800, color: '#d29922', marginBottom: 3, letterSpacing: 0.3 }}>
                            ⚠ NOT ENCRYPTED — UNVERIFIED SENDER
                          </div>
                        )}
                        {m.text}
                      </div>
                    </div>
                    <span style={{ fontSize: 9, color: C.dim, flexShrink: 0, paddingBottom: 2 }}>{timeLabel(m.ts)}</span>
                  </div>
                </React.Fragment>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        {blocked.size > 0 && (
          <div style={{ padding: '0 16px 4px', fontSize: 10, color: C.dim, display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span>Blocked {blocked.size} user{blocked.size > 1 ? 's' : ''}</span>
            <button
              onClick={() => { setBlocked(new Set()); localStorage.setItem(LOUNGE_BLOCKED_KEY, '[]'); }}
              style={{ border: 0, background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 10, padding: 0 }}
            >
              Unblock all
            </button>
          </div>
        )}

        {notice && (
          <div style={{ margin: '0 16px 6px', padding: '6px 10px', background: `${C.accent}18`, border: `1px solid ${C.accent}55`, borderRadius: 8, fontSize: 12, flexShrink: 0 }}>
            {notice}
          </div>
        )}

        {picker === 'emoji' && (
          <div style={{ ...pickerPanelStyle, bottom: 62, left: 16 }}>
            {EMOJI_SET.map((e) => (
              <button key={e} onClick={() => { setInput((v) => v + e); setPicker(null); }} style={pickerBtnStyle}>{e}</button>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{ padding: '10px 16px 14px', display: 'flex', gap: 6, flexShrink: 0, borderTop: `1px solid ${C.line}` }}>
          <button
            onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}
            title="Insert emoji"
            style={{ padding: '0 12px', border: `1px solid ${C.line}`, borderRadius: 10, background: picker === 'emoji' ? `${C.accent}22` : 'transparent', color: C.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
          >
            <Smile size={15} />
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); } }}
            placeholder={inPrivateRoom ? `Message #${activeRoom}` : 'Message all BBARIT users'}
            maxLength={1000}
            autoFocus
            style={{ flex: 1, padding: '10px 14px', border: `1px solid ${C.line}`, borderRadius: 10, background: C.bg, color: C.text, fontSize: 13, outline: 'none' }}
          />
          <button
            onClick={sendNow}
            disabled={!input.trim() || status !== 'connected'}
            style={{ padding: '0 16px', background: C.accent, color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', opacity: input.trim() && status === 'connected' ? 1 : 0.45, display: 'inline-flex', alignItems: 'center' }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
