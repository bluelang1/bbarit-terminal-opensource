import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';

// Robust clipboard with fallbacks
async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Tauri plugin
  try { await clipboardWriteText(text); return true; } catch {}
  // 2. Tauri core invoke
  try { await invoke('plugin:clipboard-manager|write_text', { text }); return true; } catch {}
  // 3. Browser navigator clipboard
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {}
  // 4. execCommand fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {}
  return false;
}
import { Users, Wifi, WifiOff, Copy, Play, Square, LogIn, LogOut, Cloud, Send, MessageSquare, Globe } from 'lucide-react';
import { LoungeTab } from './LoungeTab';

interface ServerInfo {
  port: number;
  room_code: string;
}

interface Peer {
  id: string;
  name: string;
}

type ChangeKind = 'kanban' | 'notes' | string;

export interface CollabChange {
  kind: ChangeKind;
  payload: any;
  ts: number;
  from: string;
}

export interface CollabHandle {
  isConnected: () => boolean;
  sendChange: (kind: ChangeKind, payload: any) => void;
  subscribe: (listener: (change: CollabChange) => void) => () => void;
}

let singletonHandle: CollabHandle | null = null;
export function getCollabHandle(): CollabHandle | null {
  return singletonHandle;
}

interface Props {
  style: { bg: string; text: string; accent: string };
  locale: 'ko' | 'en' | string;
  userName?: string;
}

interface ChatMessage {
  id: string;
  from: string;
  name: string;
  text: string;
  ts: number;
  self?: boolean;
}

export function CollabPanel({ style, locale, userName = '' }: Props) {
  const isKo = locale === 'ko';
  const [tab, setTab] = useState<'lounge' | 'host' | 'client' | 'chat'>('lounge');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const [hostRunning, setHostRunning] = useState(false);
  const [hostInfo, setHostInfo] = useState<ServerInfo | null>(null);
  const [hostPort, setHostPort] = useState<string>('19990');
  const [tunnelUrl, setTunnelUrl] = useState<string>('');

  // Client-side
  const [clientUrl, setClientUrl] = useState<string>('ws://127.0.0.1:19990/ws');
  const [clientRoom, setClientRoom] = useState<string>('');
  const [clientName, setClientName] = useState<string>(userName || '');
  const [clientConnected, setClientConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [status, setStatus] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<(change: CollabChange) => void>>(new Set());
  const myPeerIdRef = useRef<string>('');

  // Restore saved host info
  useEffect(() => {
    void invoke<ServerInfo | null>('collab_get_status').then((info) => {
      if (info) {
        setHostRunning(true);
        setHostInfo(info);
        setHostPort(String(info.port));
      }
    }).catch(() => {});
    void invoke<string | null>('collab_get_tunnel_url').then((url) => {
      if (url) setTunnelUrl(url);
    }).catch(() => {});
  }, []);

  // Listen for tunnel URL events
  useEffect(() => {
    const unlistenP = tauriListen<{ url: string }>('collab-tunnel-url', (ev) => {
      if (ev.payload?.url) setTunnelUrl(ev.payload.url);
    });
    return () => { unlistenP.then((fn) => fn()); };
  }, []);

  const startTunnel = useCallback(async () => {
    if (!hostInfo) return;
    try {
      await invoke('collab_start_tunnel', { port: hostInfo.port });
      setStatus(isKo ? 'Cloudflare Tunnel 시작 중... URL 생성 대기' : 'Starting Cloudflare Tunnel... waiting for URL');
    } catch (err) {
      setStatus(String(err));
    }
  }, [hostInfo, isKo]);

  const stopTunnel = useCallback(async () => {
    try {
      await invoke('collab_stop_tunnel');
      setTunnelUrl('');
      setStatus(isKo ? 'Tunnel 중지됨' : 'Tunnel stopped');
    } catch (err) {
      setStatus(String(err));
    }
  }, [isKo]);

  const startHost = useCallback(async () => {
    try {
      const port = Number(hostPort) || undefined;
      const info = await invoke<ServerInfo>('collab_start_host', { port });
      setHostRunning(true);
      setHostInfo(info);
      // Auto-join own server as a WebSocket client so host also participates in chat/sync
      const localUrl = `ws://127.0.0.1:${info.port}/ws`;
      setClientUrl(localUrl);
      setClientRoom(info.room_code);
      const name = (clientName.trim() || 'host') as string;
      // Small delay to let the server bind before connecting
      window.setTimeout(() => {
        try {
          const ws = new WebSocket(localUrl);
          wsRef.current = ws;
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'join', room: info.room_code, name }));
            setStatus(isKo ? `호스트 시작됨 (방 ${info.room_code}) — 자동 연결됨` : `Host started (room ${info.room_code}) — auto-joined`);
          };
          ws.onmessage = (ev) => {
            let msg: any;
            try { msg = JSON.parse(String(ev.data)); } catch { return; }
            if (!msg || !msg.type) return;
            switch (msg.type) {
              case 'joined':
                myPeerIdRef.current = String(msg.you || '');
                setClientConnected(true);
                setPeers((msg.peers || []) as Peer[]);
                break;
              case 'peer_joined':
                if (msg.peer) setPeers((prev) => [...prev, msg.peer]);
                break;
              case 'peer_left':
                if (msg.peer_id) setPeers((prev) => prev.filter((p) => p.id !== msg.peer_id));
                break;
              case 'change':
                for (const l of listenersRef.current) {
                  try { l({ kind: msg.kind, payload: msg.payload, ts: msg.ts, from: msg.from }); } catch {}
                }
                break;
              case 'error':
                setStatus(isKo ? `서버 에러: ${msg.message}` : `Server error: ${msg.message}`);
                break;
            }
          };
          ws.onclose = () => {
            setClientConnected(false);
            setPeers([]);
            wsRef.current = null;
          };
          ws.onerror = () => {
            setStatus(isKo ? '호스트 자동 연결 실패' : 'Host auto-join failed');
          };
        } catch (err) {
          setStatus(String(err));
        }
      }, 300);
    } catch (err) {
      setStatus(String(err));
    }
  }, [hostPort, isKo, clientName]);

  const stopHost = useCallback(async () => {
    try {
      await invoke('collab_stop_host');
      setHostRunning(false);
      setHostInfo(null);
      setStatus(isKo ? '호스트 중지됨' : 'Host stopped');
    } catch (err) {
      setStatus(String(err));
    }
  }, [isKo]);

  const disconnect = useCallback(() => {
    try { wsRef.current?.close(); } catch {}
    wsRef.current = null;
    setClientConnected(false);
    setPeers([]);
  }, []);

  const connect = useCallback(() => {
    disconnect();
    const url = clientUrl.trim();
    const room = clientRoom.trim().toUpperCase();
    const name = clientName.trim() || `peer-${Math.random().toString(36).slice(2, 6)}`;
    if (!url || !room) {
      setStatus(isKo ? 'URL과 방 코드를 입력하세요.' : 'Enter URL and room code.');
      return;
    }
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus(isKo ? '연결 중, 방 참여 요청...' : 'Connected, joining room...');
        ws.send(JSON.stringify({ type: 'join', room, name }));
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        if (!msg || !msg.type) return;
        switch (msg.type) {
          case 'joined':
            myPeerIdRef.current = String(msg.you || '');
            setClientConnected(true);
            setPeers((msg.peers || []) as Peer[]);
            setStatus(isKo ? `방 참여됨: ${msg.room}` : `Joined room: ${msg.room}`);
            break;
          case 'peer_joined':
            if (msg.peer) setPeers((prev) => [...prev, msg.peer]);
            break;
          case 'peer_left':
            if (msg.peer_id) setPeers((prev) => prev.filter((p) => p.id !== msg.peer_id));
            break;
          case 'change':
            for (const l of listenersRef.current) {
              try { l({ kind: msg.kind, payload: msg.payload, ts: msg.ts, from: msg.from }); } catch {}
            }
            break;
          case 'error':
            setStatus(isKo ? `서버 에러: ${msg.message}` : `Server error: ${msg.message}`);
            break;
          case 'pong':
            break;
        }
      };
      ws.onclose = () => {
        setClientConnected(false);
        setPeers([]);
        wsRef.current = null;
      };
      ws.onerror = () => {
        setStatus(isKo ? 'WS 에러 — URL/네트워크 확인' : 'WS error — check URL/network');
      };
    } catch (err) {
      setStatus(String(err));
    }
  }, [clientUrl, clientRoom, clientName, disconnect, isKo]);

  // Subscribe to chat messages
  useEffect(() => {
    if (!clientConnected) return;
    const listener = (change: CollabChange) => {
      if (change.kind !== 'chat' || !change.payload) return;
      const p = change.payload as { name?: string; text?: string };
      const text = p.text;
      if (!text) return;
      const peer = peers.find((pp) => pp.id === change.from);
      setMessages((prev) => [...prev, {
        id: `${change.from}-${change.ts}`,
        from: change.from,
        name: p.name || peer?.name || 'peer',
        text,
        ts: change.ts,
      }]);
    };
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, [clientConnected, peers]);

  // Auto-scroll chat to bottom on new message
  useEffect(() => {
    if (tab === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, tab]);

  const sendChat = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setStatus(isKo ? '연결되지 않음' : 'Not connected');
      return;
    }
    const name = clientName.trim() || 'me';
    try {
      ws.send(JSON.stringify({ type: 'change', kind: 'chat', payload: { name, text }, ts: Date.now() }));
      setMessages((prev) => [...prev, {
        id: `${myPeerIdRef.current || 'me'}-${Date.now()}`,
        from: myPeerIdRef.current || 'me',
        name,
        text,
        ts: Date.now(),
        self: true,
      }]);
      setChatInput('');
    } catch {}
  }, [chatInput, clientName, isKo]);

  // Expose singleton handle for other modules (Kanban, Notes) to use
  useEffect(() => {
    singletonHandle = {
      isConnected: () => !!wsRef.current && wsRef.current.readyState === WebSocket.OPEN && clientConnected,
      sendChange: (kind, payload) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: 'change', kind, payload, ts: Date.now() }));
        } catch {}
      },
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => { listenersRef.current.delete(listener); };
      },
    };
    return () => { singletonHandle = null; };
  }, [clientConnected]);

  const copyRoomCode = useCallback(async () => {
    if (!hostInfo) return;
    const ok = await copyToClipboard(hostInfo.room_code);
    setStatus(ok ? (isKo ? `방 코드 ${hostInfo.room_code} 복사됨` : `Room code ${hostInfo.room_code} copied`) : (isKo ? '복사 실패 — 직접 선택/복사해주세요' : 'Copy failed — please select manually'));
  }, [hostInfo, isKo]);

  const copyTunnelCommand = useCallback(async () => {
    if (!hostInfo) return;
    const cmd = `cloudflared tunnel --url http://localhost:${hostInfo.port}`;
    const ok = await copyToClipboard(cmd);
    setStatus(ok ? (isKo ? 'cloudflared 명령어 복사됨' : 'cloudflared command copied') : (isKo ? '복사 실패' : 'Copy failed'));
  }, [hostInfo, isKo]);

  const panelBg = `${style.text}08`;
  const border = `1px solid ${style.text}22`;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      padding: 14,
      color: style.text,
      fontSize: 12,
      overflow: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Users size={16} />
        <span style={{ fontWeight: 700, fontSize: 14 }}>Chat</span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, background: panelBg, borderRadius: 'var(--brutal-radius)', padding: 2, width: 'fit-content' }}>
        {(['lounge', 'host', 'client', 'chat'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '5px 14px',
              borderRadius: 'var(--brutal-radius)',
              border: 'none',
              background: tab === t ? style.accent : 'transparent',
              color: tab === t ? '#fff' : style.text,
              fontWeight: 600,
              fontSize: 11,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {t === 'lounge' ? (<><Globe size={11} />Lounge</>)
              : t === 'host' ? (isKo ? '호스트' : 'Host')
              : t === 'client' ? (isKo ? '참여' : 'Join')
              : (<><MessageSquare size={11} />{isKo ? '팀' : 'Team'}{messages.length > 0 && <span style={{ fontSize: 9, opacity: 0.8 }}>({messages.length})</span>}</>)}
          </button>
        ))}
      </div>

      {tab === 'lounge' && <LoungeTab style={style} />}

      {tab === 'host' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10, border, borderRadius: 'var(--brutal-radius)', background: panelBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ opacity: 0.7 }}>{isKo ? '포트:' : 'Port:'}</span>
            <input
              value={hostPort}
              onChange={(e) => setHostPort(e.target.value)}
              disabled={hostRunning}
              style={{ width: 80, padding: '4px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text }}
            />
            {!hostRunning ? (
              <button onClick={startHost} style={btnStyle(style.accent)}>
                <Play size={12} /> {isKo ? '시작' : 'Start'}
              </button>
            ) : (
              <button onClick={stopHost} style={btnStyle('#e74c3c')}>
                <Square size={12} /> {isKo ? '중지' : 'Stop'}
              </button>
            )}
          </div>

          {hostInfo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border, borderRadius: 'var(--brutal-radius)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ opacity: 0.7 }}>{isKo ? '방 코드:' : 'Room code:'}</span>
                <code style={{ fontSize: 14, fontWeight: 700, letterSpacing: 2, color: style.accent }}>{hostInfo.room_code}</code>
                <button onClick={copyRoomCode} style={btnStyle(style.accent, true)}>
                  <Copy size={11} />
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <span style={{ opacity: 0.75 }}>{isKo ? '로컬 URL:' : 'Local URL:'}</span>
                <code style={{ flex: 1, padding: '3px 6px', background: `${style.text}11`, borderRadius: 'var(--brutal-radius)' }}>
                  ws://127.0.0.1:{hostInfo.port}/ws
                </code>
                <button
                  onClick={async () => {
                    const url = `ws://127.0.0.1:${hostInfo.port}/ws`;
                    const ok = await copyToClipboard(url);
                    setStatus(ok ? (isKo ? '로컬 URL 복사됨' : 'Local URL copied') : (isKo ? '복사 실패' : 'Copy failed'));
                  }}
                  style={btnStyle(style.accent, true)}
                  title={isKo ? '복사' : 'Copy'}
                >
                  <Copy size={11} />
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>
                {isKo ? '외부 팀원 초대: Cloudflare Tunnel 실행 후 생성된 URL 공유' : 'To invite remote teammates, run Cloudflare Tunnel and share the URL.'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {!tunnelUrl ? (
                  <button onClick={startTunnel} style={btnStyle(style.accent)}>
                    <Cloud size={12} /> {isKo ? 'Cloudflare Tunnel 시작' : 'Start Cloudflare Tunnel'}
                  </button>
                ) : (
                  <button onClick={stopTunnel} style={btnStyle('#e74c3c')}>
                    <Cloud size={12} /> {isKo ? 'Tunnel 중지' : 'Stop Tunnel'}
                  </button>
                )}
                <span style={{ fontSize: 10, opacity: 0.6 }}>{isKo ? '(cloudflared 설치 필요)' : '(cloudflared required)'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <code style={{ fontSize: 10, padding: '3px 6px', background: `${style.text}11`, borderRadius: 'var(--brutal-radius)' }}>
                  {isKo ? '수동 실행: ' : 'Manual: '}cloudflared tunnel --url http://localhost:{hostInfo.port}
                </code>
                <button onClick={copyTunnelCommand} style={btnStyle(style.accent, true)}>
                  <Copy size={11} />
                </button>
              </div>
              <input
                value={tunnelUrl}
                onChange={(e) => setTunnelUrl(e.target.value)}
                placeholder={isKo ? '또는 직접 URL 입력' : 'Or enter URL manually'}
                style={{ padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
              />
              {tunnelUrl && (() => {
                const wsUrl = `${tunnelUrl.replace(/^https?:\/\//, 'wss://').replace(/\/$/, '')}/ws`;
                const inviteLink = `${wsUrl}?room=${hostInfo.room_code}`;
                return (
                  <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ opacity: 0.75 }}>{isKo ? '초대 링크 (한 번에 복사):' : 'Invite link (single copy):'}</span>
                    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                      <code style={{ flex: 1, padding: '6px 8px', background: `${style.text}11`, borderRadius: 'var(--brutal-radius)', fontSize: 10, wordBreak: 'break-all' }}>
                        {inviteLink}
                      </code>
                      <button
                        onClick={async () => {
                          const ok = await copyToClipboard(inviteLink);
                          setStatus(ok ? (isKo ? '초대 링크 복사됨 — 팀원에게 붙여넣기만 하면 됨' : 'Invite link copied') : (isKo ? '복사 실패 — 링크 박스 텍스트를 직접 선택해서 복사해주세요' : 'Copy failed — select the link text manually'));
                        }}
                        style={{ ...btnStyle(style.accent), padding: '4px 10px' }}
                      >
                        <Copy size={12} /> {isKo ? '복사' : 'Copy'}
                      </button>
                    </div>
                    <span style={{ fontSize: 10, opacity: 0.6 }}>
                      {isKo ? '팀원은 Join 탭의 "초대 링크 붙여넣기"에 한 번만 붙여넣으면 자동 입력됨' : 'Teammate just pastes into Join tab\'s "Paste invite link" — auto-fills both fields'}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {tab === 'client' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border, borderRadius: 'var(--brutal-radius)', background: panelBg }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ opacity: 0.85, fontSize: 11, fontWeight: 600 }}>{isKo ? '초대 링크 붙여넣기 (한 번에 자동 입력)' : 'Paste invite link (auto-fills fields)'}</span>
            <input
              disabled={clientConnected}
              placeholder={isKo ? 'wss://xxx.trycloudflare.com/ws?room=ABC123' : 'wss://xxx.trycloudflare.com/ws?room=ABC123'}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text').trim();
                if (!text) return;
                // Accept either single URL (wss://host/ws?room=CODE) or multi-line "URL: xxx\nRoom: yyy"
                let url = '';
                let room = '';
                const urlMatch = text.match(/(wss?:\/\/[^\s?#]+)/i);
                if (urlMatch) url = urlMatch[1];
                const roomQuery = text.match(/[?&]room=([A-Za-z0-9]+)/);
                const roomLine = text.match(/Room:\s*([A-Za-z0-9]+)/i);
                room = (roomQuery?.[1] || roomLine?.[1] || '').toUpperCase();
                if (url) {
                  // If URL has ?room=..., keep URL without the query for WS connection
                  setClientUrl(url);
                  if (room) setClientRoom(room);
                  setStatus(isKo ? `자동 입력됨: ${url}${room ? ` · ${room}` : ''}` : `Auto-filled: ${url}${room ? ` · ${room}` : ''}`);
                  e.preventDefault();
                  (e.target as HTMLInputElement).value = '';
                }
              }}
              onChange={(e) => {
                // Also try parsing on typed input
                const text = e.target.value.trim();
                if (!text) return;
                const urlMatch = text.match(/(wss?:\/\/[^\s?#]+)/i);
                const roomQuery = text.match(/[?&]room=([A-Za-z0-9]+)/);
                if (urlMatch && roomQuery) {
                  setClientUrl(urlMatch[1]);
                  setClientRoom(roomQuery[1].toUpperCase());
                  e.target.value = '';
                }
              }}
              style={{ padding: '6px 8px', border: `2px solid ${style.accent}55`, borderRadius: 'var(--brutal-radius)', background: `${style.accent}08`, color: style.text, fontSize: 11, fontWeight: 500 }}
            />
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, opacity: 0.55, margin: '2px 0' }}>
            <span style={{ flex: 1, borderTop: `1px solid ${style.text}22` }} />
            <span>{isKo ? '또는 수동 입력' : 'Or enter manually'}</span>
            <span style={{ flex: 1, borderTop: `1px solid ${style.text}22` }} />
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ opacity: 0.7, fontSize: 11 }}>{isKo ? 'WS URL' : 'WS URL'}</span>
            <input
              value={clientUrl}
              onChange={(e) => setClientUrl(e.target.value)}
              disabled={clientConnected}
              placeholder="ws://127.0.0.1:19990/ws"
              style={{ padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ opacity: 0.7, fontSize: 11 }}>{isKo ? '방 코드' : 'Room code'}</span>
            <input
              value={clientRoom}
              onChange={(e) => setClientRoom(e.target.value.toUpperCase())}
              disabled={clientConnected}
              maxLength={6}
              placeholder="ABC123"
              style={{ padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 13, fontWeight: 700, letterSpacing: 2 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ opacity: 0.7, fontSize: 11 }}>{isKo ? '내 이름' : 'Your name'}</span>
            <input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              disabled={clientConnected}
              placeholder={isKo ? '홍길동' : 'Your name'}
              style={{ padding: '5px 8px', border, borderRadius: 'var(--brutal-radius)', background: 'transparent', color: style.text, fontSize: 11 }}
            />
          </label>
          {!clientConnected ? (
            <button onClick={connect} style={btnStyle(style.accent)}>
              <LogIn size={12} /> {isKo ? '연결' : 'Connect'}
            </button>
          ) : (
            <button onClick={disconnect} style={btnStyle('#e74c3c')}>
              <LogOut size={12} /> {isKo ? '연결 해제' : 'Disconnect'}
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            {clientConnected ? <Wifi size={12} color={style.accent} /> : <WifiOff size={12} color="#999" />}
            <span>{clientConnected ? (isKo ? '연결됨' : 'Connected') : (isKo ? '연결 안됨' : 'Disconnected')}</span>
            {clientConnected && <span style={{ opacity: 0.6 }}>— {peers.length} {isKo ? '참여자' : 'peers'}</span>}
          </div>

          {peers.length > 0 && (
            <div style={{ padding: 6, border, borderRadius: 'var(--brutal-radius)', maxHeight: 140, overflow: 'auto' }}>
              {peers.map((p) => (
                <div key={p.id} style={{ padding: '3px 0', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 'var(--brutal-radius)', background: p.id === myPeerIdRef.current ? style.accent : '#4caf50' }} />
                  <span>{p.name}{p.id === myPeerIdRef.current ? (isKo ? ' (나)' : ' (me)') : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'chat' && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: 10,
          border,
          borderRadius: 'var(--brutal-radius)',
          background: panelBg,
          flex: 1,
          minHeight: 360,
          maxHeight: 'calc(70vh - 140px)',
          overflow: 'hidden',
        }}>
          {!clientConnected ? (
            <div style={{ fontSize: 11, opacity: 0.7, textAlign: 'center', padding: 20 }}>
              {isKo ? '먼저 방에 연결하세요 (Host → Start 또는 Join)' : 'Connect to a room first (Host → Start or Join)'}
            </div>
          ) : (
            <>
              {/* Messages — flex-grow, scroll, newest at bottom */}
              <div style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: 8,
                border,
                borderRadius: 'var(--brutal-radius)',
                background: style.bg,
              }}>
                {messages.length === 0 ? (
                  <div style={{ opacity: 0.4, fontSize: 11, textAlign: 'center', margin: 'auto' }}>
                    {isKo ? '메시지를 입력해 대화를 시작하세요' : 'Start typing to chat'}
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        alignSelf: m.self ? 'flex-end' : 'flex-start',
                        maxWidth: '80%',
                        padding: '6px 10px',
                        borderRadius: 'var(--brutal-radius)',
                        background: m.self ? style.accent : `${style.text}18`,
                        color: m.self ? '#fff' : style.text,
                        fontSize: 11,
                        wordBreak: 'break-word',
                      }}
                    >
                      {!m.self && <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.8, marginBottom: 2 }}>{m.name}</div>}
                      <div>{m.text}</div>
                      <div style={{ fontSize: 9, opacity: 0.55, marginTop: 2, textAlign: 'right' }}>
                        {new Date(m.ts).toLocaleTimeString()}
                      </div>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>
              {/* Input — fixed at bottom */}
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                  placeholder={isKo ? '메시지 입력 (Enter 전송)' : 'Type a message (Enter to send)'}
                  autoFocus
                  style={{
                    flex: 1,
                    padding: '8px 12px',
                    border: `2px solid ${style.accent}44`,
                    borderRadius: 'var(--brutal-radius)',
                    background: style.bg,
                    color: style.text,
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={sendChat}
                  disabled={!chatInput.trim()}
                  style={{
                    ...btnStyle(style.accent),
                    padding: '8px 14px',
                    opacity: chatInput.trim() ? 1 : 0.5,
                  }}
                >
                  <Send size={13} />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {status && (
        <div style={{ padding: 8, background: `${style.accent}18`, border: `1px solid ${style.accent}55`, borderRadius: 'var(--brutal-radius)', fontSize: 11 }}>
          {status}
        </div>
      )}
    </div>
  );
}

function btnStyle(accent: string, small = false): React.CSSProperties {
  return {
    padding: small ? '3px 6px' : '5px 12px',
    background: accent,
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--brutal-radius)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  };
}
