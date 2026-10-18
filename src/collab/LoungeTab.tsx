import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Globe, Lock, LogOut, Send, Smile, Wifi, WifiOff, X } from 'lucide-react';
import { AVATAR_ICONS, EMOJI_SET, loadIdentity } from './loungeIdentity';
import { AVATAR_IMAGE_COUNT, LoungeAvatar, avatarSrc } from './LoungeAvatar';
import {
  LOUNGE_BLOCKED_KEY,
  decryptIncoming,
  LOUNGE_GENERAL_ROOM,
  LOUNGE_ICON_KEY,
  LOUNGE_NICK_KEY,
  LOUNGE_NOTICE_KEY,
  LOUNGE_ROOM_KEY,
  LoungeClient,
  deriveRoomKeyHex,
  encryptText,
  filterBlocked,
  hashRoomPass,
  lastSeqKey,
  loadBlockedTags,
  markLoungeMessagesSelf,
  mergeMessages,
  normalizeRoomName,
  setLoungeHandle,
} from './loungeClient';
import type { LoungeMessage, LoungeRoomInfo, LoungeStatus, LoungeUser } from './loungeClient';

interface Props {
  style: { bg: string; text: string; accent: string };
}

interface RoomSpec {
  name: string;
  pass?: string; // hashed credential (hashRoomPass) — never the raw password
  key?: string; // E2E AES key hex (deriveRoomKeyHex) — never sent anywhere
}

function loadSavedRoom(): RoomSpec {
  try {
    const raw = JSON.parse(localStorage.getItem(LOUNGE_ROOM_KEY) || 'null');
    if (raw && typeof raw.name === 'string' && raw.name && raw.name !== LOUNGE_GENERAL_ROOM) {
      return {
        name: raw.name,
        pass: typeof raw.pass === 'string' ? raw.pass : undefined,
        key: typeof raw.key === 'string' ? raw.key : undefined,
      };
    }
  } catch {}
  return { name: LOUNGE_GENERAL_ROOM };
}

function saveRoom(spec: RoomSpec) {
  if (spec.name === LOUNGE_GENERAL_ROOM) localStorage.removeItem(LOUNGE_ROOM_KEY);
  else localStorage.setItem(LOUNGE_ROOM_KEY, JSON.stringify(spec));
}

export function LoungeTab({ style }: Props) {
  const [agreed, setAgreed] = useState(() => localStorage.getItem(LOUNGE_NOTICE_KEY) === '1');
  const [nick, setNick] = useState(() => localStorage.getItem(LOUNGE_NICK_KEY) || '');
  const [icon, setIcon] = useState(() => localStorage.getItem(LOUNGE_ICON_KEY) || '🙂');
  const [roomSpec, setRoomSpec] = useState<RoomSpec>(loadSavedRoom);
  const [roomInfo, setRoomInfo] = useState<LoungeRoomInfo | null>(null);
  const [status, setStatus] = useState<LoungeStatus>('idle');
  const [online, setOnline] = useState(0);
  const [motd, setMotd] = useState('');
  const [you, setYou] = useState<LoungeUser | null>(null);
  const [messages, setMessages] = useState<LoungeMessage[]>([]);
  const [blocked, setBlocked] = useState<Set<string>>(() => loadBlockedTags(localStorage.getItem(LOUNGE_BLOCKED_KEY)));
  const [input, setInput] = useState('');
  const [notice, setNotice] = useState('');
  const [picker, setPicker] = useState<'avatar' | 'emoji' | null>(null);
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [roomNameInput, setRoomNameInput] = useState('');
  const [roomPassInput, setRoomPassInput] = useState('');
  const clientRef = useRef<LoungeClient | null>(null);
  const youRef = useRef<LoungeUser | null>(you);
  const endRef = useRef<HTMLDivElement | null>(null);
  const sendTextRef = useRef<(text: string) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: false, error: 'not_connected' }));
  youRef.current = you;

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
      if (room.name !== spec.name) {
        client.close();
        setNotice(`Server put us in #${room.name} instead of #${spec.name} — private rooms need a server update`);
        saveRoom({ name: LOUNGE_GENERAL_ROOM });
        setRoomSpec({ name: LOUNGE_GENERAL_ROOM });
        setMessages([]);
        void connect({ name: LOUNGE_GENERAL_ROOM });
        return;
      }
      youRef.current = me;
      setYou(me);
      setOnline(count);
      setRoomInfo(room);
      setMotd(serverMotd || '');
      void decryptIncoming(spec.key, history).then((decrypted) => {
        const withSelf = markLoungeMessagesSelf(decrypted, me.tag);
        setMessages((prev) => mergeMessages(
          markLoungeMessagesSelf(prev, me.tag),
          withSelf,
        ));
      });
      saveRoom(spec);
      if (history.length) localStorage.setItem(lastSeqKey(room.name), String(client.afterSeq));
    });
    client.on('chat', (m) => {
      void decryptIncoming(spec.key, [m]).then(([decrypted]) => {
        const [normalized] = markLoungeMessagesSelf([decrypted], youRef.current?.tag);
        setMessages((prev) => mergeMessages(prev, [normalized]));
      });
      localStorage.setItem(lastSeqKey(spec.name), String(m.seq));
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
        // Fall back to the public lounge; reopen the form so the user can retry.
        saveRoom({ name: LOUNGE_GENERAL_ROOM });
        setRoomSpec({ name: LOUNGE_GENERAL_ROOM });
        setRoomNameInput(spec.name);
        setShowRoomForm(true);
        setMessages([]);
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

  useEffect(() => {
    if (!agreed) return;
    void connect(roomSpec);
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
    // Reconnection on room change goes through joinRoom/leaveRoom, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agreed, connect]);

  // Immediate retry on focus / network recovery
  useEffect(() => {
    const retry = () => clientRef.current?.retryNow();
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
    };
  }, []);

  // Expose handle for gateway lounge.send. Fire-and-forget: encryption is async
  // but the gateway only needs a best-effort accepted/failed answer here.
  useEffect(() => {
    setLoungeHandle({
      isConnected: () => clientRef.current?.status === 'connected',
      send: (text) => {
        if (clientRef.current?.status !== 'connected') return { ok: false, error: 'not_connected' };
        void sendTextRef.current(text);
        return { ok: true };
      },
    });
    return () => setLoungeHandle(null);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

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
    void connect(roomSpec);
  }, [nick, connect, roomSpec]);

  const applyIcon = useCallback((next: string) => {
    setIcon(next);
    setYou((prev) => prev ? { ...prev, icon: next } : prev);
    setMessages((prev) => prev.map((message) => message.self
      ? { ...message, from: { ...message.from, icon: next } }
      : message));
    localStorage.setItem(LOUNGE_ICON_KEY, next);
    setPicker(null);
    void connect(roomSpec);
  }, [connect, roomSpec]);

  const joinRoom = useCallback(() => {
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
      localStorage.removeItem(lastSeqKey(name));
      setRoomSpec(spec);
      setShowRoomForm(false);
      setRoomPassInput('');
      setMessages([]);
      setOnline(0);
      void connect(spec);
    })();
  }, [roomNameInput, roomPassInput, connect]);

  const leaveRoom = useCallback(() => {
    // Drop the afterSeq cursor so a later rejoin replays recent history.
    localStorage.removeItem(lastSeqKey(roomSpec.name));
    const spec = { name: LOUNGE_GENERAL_ROOM };
    saveRoom(spec);
    setRoomSpec(spec);
    setMessages([]);
    setOnline(0);
    void connect(spec);
  }, [connect, roomSpec.name]);

  const toggleBlock = useCallback((tag: string) => {
    setBlocked((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      localStorage.setItem(LOUNGE_BLOCKED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const border = `1px solid ${style.text}22`;
  const panelBg = `${style.text}08`;
  const inPrivateRoom = roomSpec.name !== LOUNGE_GENERAL_ROOM;

  if (!agreed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 16, border, borderRadius: 'var(--brutal-radius)', background: panelBg, fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13 }}>
          <Globe size={15} /> BBARIT Lounge
        </div>
        <div style={{ opacity: 0.85, lineHeight: 1.6 }}>
          Public room. Messages are visible to all BBARIT Terminal users and retained for 7 days.
        </div>
        <button
          onClick={() => { localStorage.setItem(LOUNGE_NOTICE_KEY, '1'); setAgreed(true); }}
          style={{ alignSelf: 'flex-start', padding: '6px 16px', background: style.accent, color: '#fff', border: 'none', borderRadius: 'var(--brutal-radius)', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
        >
          Agree & Join
        </button>
      </div>
    );
  }

  const visible = filterBlocked(messages, blocked);
  const pickerPanelStyle: React.CSSProperties = {
    position: 'absolute',
    zIndex: 10,
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 30px)',
    gap: 2,
    padding: 8,
    background: style.bg,
    border: `1px solid ${style.text}33`,
    borderRadius: 'var(--brutal-radius)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
  };
  const pickerBtnStyle: React.CSSProperties = {
    width: 30,
    height: 30,
    border: 'none',
    background: 'transparent',
    borderRadius: 'var(--brutal-radius)',
    fontSize: 17,
    cursor: 'pointer',
    lineHeight: 1,
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border, borderRadius: 'var(--brutal-radius)', background: panelBg, flex: 1, minHeight: 360, maxHeight: 'calc(70vh - 140px)', overflow: 'hidden' }}>
      {/* Header: status / room / online / avatar / nickname */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, fontSize: 11 }}>
        {status === 'connected' ? <Wifi size={12} color={style.accent} /> : <WifiOff size={12} color="#999" />}
        <span style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {inPrivateRoom && <Lock size={10} />}#{roomInfo?.name || roomSpec.name}
        </span>
        <span style={{ fontWeight: 700 }}>
          {status === 'connected' ? `Online ${online}` : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Offline'}
        </span>
        {you && (
          <span style={{ opacity: 0.6, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            you: <LoungeAvatar icon={you.icon} size={13} /> {you.name}#{you.tag}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {inPrivateRoom ? (
          <button onClick={leaveRoom} title="Back to #general"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 10, cursor: 'pointer' }}>
            <LogOut size={10} /> Leave
          </button>
        ) : (
          <button onClick={() => { setShowRoomForm((v) => !v); setPicker(null); }} title="Join or create a private room"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', border, borderRadius: 'var(--brutal-radius)', background: showRoomForm ? `${style.accent}22` : 'transparent', color: style.text, fontSize: 10, cursor: 'pointer' }}>
            <Lock size={10} /> Private room…
          </button>
        )}
        <button
          onClick={() => setPicker(picker === 'avatar' ? null : 'avatar')}
          title="Pick your avatar"
          style={{ width: 26, height: 26, border, borderRadius: 'var(--brutal-radius)', background: picker === 'avatar' ? `${style.accent}22` : 'transparent', cursor: 'pointer', lineHeight: 1, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <LoungeAvatar icon={icon} size={17} />
        </button>
        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyNick(); }}
          onBlur={applyNick}
          placeholder="Set nickname…"
          maxLength={24}
          style={{ width: 110, padding: '4px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
        />
      </div>

      {picker === 'avatar' && (
        <div style={{ ...pickerPanelStyle, top: 40, right: 10, gridTemplateColumns: 'repeat(10, 26px)', maxHeight: 280, overflowY: 'auto' }}>
          {Array.from({ length: AVATAR_IMAGE_COUNT }, (_, i) => `av:${i}`).map((a) => (
            <button key={a} onClick={() => applyIcon(a)} title={a}
              style={{ ...pickerBtnStyle, width: 26, height: 26, padding: 2, background: a === icon ? `${style.accent}33` : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src={avatarSrc(a)} alt="" width={22} height={22} style={{ borderRadius: '30%', display: 'block' }} draggable={false} loading="lazy" />
            </button>
          ))}
          {AVATAR_ICONS.map((a) => (
            <button key={a} onClick={() => applyIcon(a)} style={{ ...pickerBtnStyle, width: 26, height: 26, fontSize: 14, background: a === icon ? `${style.accent}33` : 'transparent' }}>{a}</button>
          ))}
        </div>
      )}

      {showRoomForm && !inPrivateRoom && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <input
            value={roomNameInput}
            onChange={(e) => setRoomNameInput(e.target.value)}
            placeholder="room-name"
            maxLength={24}
            style={{ flex: 1, padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
          />
          <input
            value={roomPassInput}
            onChange={(e) => setRoomPassInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') joinRoom(); }}
            type="password"
            placeholder="password"
            maxLength={64}
            style={{ flex: 1, padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
          />
          <button onClick={joinRoom}
            style={{ padding: '5px 12px', background: style.accent, color: '#fff', border: 'none', borderRadius: 'var(--brutal-radius)', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
            Join
          </button>
          <span style={{ fontSize: 9, opacity: 0.55 }}>New name + password creates the room</span>
        </div>
      )}

      {motd && (
        <div style={{ padding: '5px 8px', background: `${style.accent}14`, border: `1px solid ${style.accent}44`, borderRadius: 'var(--brutal-radius)', fontSize: 11, flexShrink: 0 }}>
          {motd}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, padding: 8, border, borderRadius: 'var(--brutal-radius)', background: style.bg }}>
        {visible.length === 0 ? (
          <div style={{ opacity: 0.4, fontSize: 11, textAlign: 'center', margin: 'auto' }}>
            {status === 'connected'
              ? (inPrivateRoom ? `#${roomSpec.name} is quiet — say something` : 'Say hello to everyone using BBARIT Terminal')
              : 'Waiting for connection…'}
          </div>
        ) : (
          visible.map((m) => (
            <div
              key={m.seq}
              style={{
                alignSelf: m.self ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                padding: '6px 10px',
                borderRadius: 'var(--brutal-radius)',
                background: m.unverified ? '#2a2313' : m.self ? style.accent : `${style.text}18`,
                border: m.unverified ? '1px solid #d2992288' : 'none',
                color: m.self && !m.unverified ? '#fff' : style.text,
                fontSize: 11,
                wordBreak: 'break-word',
              }}
            >
              {m.unverified && (
                <div style={{ fontSize: 8, fontWeight: 800, color: '#d29922', marginBottom: 2 }}>⚠ NOT ENCRYPTED — UNVERIFIED SENDER</div>
              )}
              {!m.self && (
                <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.8, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <LoungeAvatar icon={m.from.icon} size={13} />
                  <span>{m.from.name}<span style={{ opacity: 0.6 }}>#{m.from.tag}</span></span>
                  <button
                    onClick={() => toggleBlock(m.from.tag)}
                    title="Hide this user"
                    style={{ border: 0, background: 'transparent', color: 'inherit', opacity: 0.45, cursor: 'pointer', padding: 0, display: 'flex' }}
                  >
                    <X size={9} />
                  </button>
                </div>
              )}
              <div>{m.text}</div>
              <div style={{ fontSize: 9, opacity: 0.55, marginTop: 2, textAlign: 'right' }}>
                {new Date(m.ts).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {blocked.size > 0 && (
        <div style={{ fontSize: 10, opacity: 0.65, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>Blocked {blocked.size} user{blocked.size > 1 ? 's' : ''}</span>
          <button
            onClick={() => { setBlocked(new Set()); localStorage.setItem(LOUNGE_BLOCKED_KEY, '[]'); }}
            style={{ border: 0, background: 'transparent', color: style.accent, cursor: 'pointer', fontSize: 10, padding: 0 }}
          >
            Unblock all
          </button>
        </div>
      )}

      {notice && (
        <div style={{ padding: '5px 8px', background: `${style.accent}18`, border: `1px solid ${style.accent}55`, borderRadius: 'var(--brutal-radius)', fontSize: 11, flexShrink: 0 }}>
          {notice}
        </div>
      )}

      {picker === 'emoji' && (
        <div style={{ ...pickerPanelStyle, bottom: 52, left: 10 }}>
          {EMOJI_SET.map((e) => (
            <button key={e} onClick={() => { setInput((v) => v + e); setPicker(null); }} style={pickerBtnStyle}>{e}</button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}
          title="Insert emoji"
          style={{ padding: '0 10px', border, borderRadius: 'var(--brutal-radius)', background: picker === 'emoji' ? `${style.accent}22` : 'transparent', color: style.text, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        >
          <Smile size={14} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); } }}
          placeholder={inPrivateRoom ? `Message #${roomSpec.name} (Enter to send)` : 'Message all BBARIT users (Enter to send)'}
          maxLength={1000}
          style={{ flex: 1, padding: '8px 12px', border: `2px solid ${style.accent}44`, borderRadius: 'var(--brutal-radius)', background: style.bg, color: style.text, fontSize: 12, outline: 'none' }}
        />
        <button
          onClick={sendNow}
          disabled={!input.trim() || status !== 'connected'}
          style={{ padding: '8px 14px', background: style.accent, color: '#fff', border: 'none', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', opacity: input.trim() && status === 'connected' ? 1 : 0.5, display: 'inline-flex', alignItems: 'center' }}
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
}
