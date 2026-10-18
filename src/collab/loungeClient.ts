// BBARIT Lounge client — pure protocol/state logic for the global community chat.
// Wire protocol: docs/BBARIT_LOUNGE_DESIGN.md §5 (JSON tagged union, v:1).

export const LOUNGE_DEFAULT_URL = 'wss://bbarit.com/api/lounge/ws';
// Transport-level cap (code units), larger than the 1,000-char UI cap because
// E2E ciphertext expands: 1,000 emoji (4B each) → ~5,380 chars of base64
// payload. The server enforces the same 6,000 limit.
export const LOUNGE_MAX_TEXT = 6000;
export const LOUNGE_LAST_SEQ_KEY = 'bbarit-lounge-last-seq';
export const LOUNGE_BLOCKED_KEY = 'bbarit-lounge-blocked';
export const LOUNGE_NICK_KEY = 'bbarit-lounge-nick';
export const LOUNGE_NOTICE_KEY = 'bbarit-lounge-notice-agreed';
export const LOUNGE_ICON_KEY = 'bbarit-lounge-icon';
export const LOUNGE_ROOM_KEY = 'bbarit-lounge-room';
export const LOUNGE_GENERAL_ROOM = 'general';

// Per-room afterSeq persistence; #general keeps the original key for continuity.
export function lastSeqKey(room: string): string {
  return room === LOUNGE_GENERAL_ROOM ? LOUNGE_LAST_SEQ_KEY : `${LOUNGE_LAST_SEQ_KEY}:${room}`;
}

// Mirrors the server's room-name rule: ^[a-z0-9-]{1,24}$
export function normalizeRoomName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24);
}

// Room credential: the plaintext password never leaves the input — we send and
// persist a slow-KDF credential. It MUST be as expensive as the E2E key
// derivation: the server receives this string on every hello, so a fast hash
// here would hand the server a cheap brute-force oracle for the password (and
// therefore the E2E key), gutting the "server can't read" guarantee.
export async function hashRoomPass(room: string, password: string): Promise<string> {
  return pbkdf2Hex(password, `bbarit-lounge-auth:${room}`);
}

// ── E2E encryption (private rooms) ──
// The room password also derives an AES-256-GCM key via PBKDF2 with a DIFFERENT
// domain ('bbarit-lounge-e2e') than the auth credential above, so the server —
// which only ever sees the auth-domain credential — cannot derive the message key.
// #general has no shared secret (anyone can join), so it stays plaintext.

export const E2E_PREFIX = 'e2e:v1:';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) || []) as Uint8Array<ArrayBuffer>;
}

function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...atob(b64)].map((c) => c.charCodeAt(0))) as Uint8Array<ArrayBuffer>;
}

// 600k iterations = OWASP 2023 recommendation for PBKDF2-HMAC-SHA256.
// Runs once per room join, so the cost is invisible in the UI.
async function pbkdf2Hex(password: string, salt: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 600000, hash: 'SHA-256' },
    material,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export async function deriveRoomKeyHex(room: string, password: string): Promise<string> {
  return pbkdf2Hex(password, `bbarit-lounge-e2e:${room}`);
}

async function importAesKey(keyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromHex(keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function isE2ePayload(text: string): boolean {
  return text.startsWith(E2E_PREFIX);
}

export async function encryptText(keyHex: string, text: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return `${E2E_PREFIX}${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

export const DECRYPT_FAIL_TEXT = '🔒 Unable to decrypt (different password?)';

// Ingestion filter for a room's incoming messages. In an E2E room every
// authentic message is ciphertext — plaintext can only have been injected
// server-side, so it is flagged `unverified` instead of rendered as authentic.
export async function decryptIncoming(keyHex: string | undefined, msgs: LoungeMessage[]): Promise<LoungeMessage[]> {
  if (!keyHex || msgs.length === 0) return msgs;
  return Promise.all(msgs.map(async (m) => {
    if (!isE2ePayload(m.text)) return { ...m, unverified: true };
    const dec = await decryptText(keyHex, m.text);
    return { ...m, text: dec ?? DECRYPT_FAIL_TEXT };
  }));
}

// null = not decryptable with this key (wrong key, corrupt payload, tampering).
export async function decryptText(keyHex: string, payload: string): Promise<string | null> {
  if (!isE2ePayload(payload)) return payload;
  const parts = payload.slice(E2E_PREFIX.length).split(':');
  if (parts.length !== 2) return null;
  try {
    const key = await importAesKey(keyHex);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[0]) }, key, fromB64(parts[1]));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export interface LoungeUser {
  name: string;
  tag: string;
  icon?: string;
}

export interface LoungeRoomInfo {
  name: string;
  private: boolean;
}

export interface LoungeMessage {
  seq: number;
  id: string;
  from: LoungeUser;
  text: string;
  ts: number;
  self?: boolean;
  // Set in E2E rooms for messages that arrived as plaintext — a compromised
  // server could inject those, so the UI must not render them as authentic.
  unverified?: boolean;
}

export function markLoungeMessagesSelf(messages: LoungeMessage[], selfTag: string | undefined): LoungeMessage[] {
  if (!selfTag) return messages;
  return messages.map((message) => message.from.tag === selfTag ? { ...message, self: true } : message);
}

// Defensive caps against a malicious/compromised server flooding the client.
export const LOUNGE_MAX_HISTORY = 200;

export type LoungeServerMsg =
  | { type: 'welcome'; you: LoungeUser; online: number; motd?: string; history: LoungeMessage[]; room: LoungeRoomInfo }
  | { type: 'chat'; seq: number; id: string; from: LoungeUser; text: string; ts: number }
  | { type: 'online'; count: number }
  | { type: 'deleted'; seq: number }
  | { type: 'error'; code: string; message?: string; retryAfterMs?: number }
  | { type: 'pong' };

export function parseServerMessage(raw: unknown): LoungeServerMsg | null {
  let msg: any;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!msg || msg.v !== 1 || typeof msg.type !== 'string') return null;
  switch (msg.type) {
    case 'welcome':
      if (!msg.you || typeof msg.you.name !== 'string') return null;
      return {
        type: 'welcome',
        you: toUser(msg.you),
        online: Number(msg.online) || 0,
        motd: typeof msg.motd === 'string' ? sanitizeDisplay(msg.motd).slice(0, 500) : undefined,
        history: Array.isArray(msg.history) ? msg.history.filter(isWireChat).slice(-LOUNGE_MAX_HISTORY).map(toMessage) : [],
        room: msg.room && typeof msg.room.name === 'string'
          ? { name: msg.room.name, private: msg.room.private === true }
          : { name: LOUNGE_GENERAL_ROOM, private: false },
      };
    case 'chat':
      return isWireChat(msg) ? { type: 'chat', ...toMessage(msg) } : null;
    case 'online':
      return { type: 'online', count: Number(msg.count) || 0 };
    case 'deleted':
      return Number.isFinite(Number(msg.seq)) ? { type: 'deleted', seq: Number(msg.seq) } : null;
    case 'error':
      return {
        type: 'error',
        code: String(msg.code || 'unknown'),
        message: typeof msg.message === 'string' ? msg.message : undefined,
        retryAfterMs: Number.isFinite(Number(msg.retryAfterMs)) ? Number(msg.retryAfterMs) : undefined,
      };
    case 'pong':
      return { type: 'pong' };
    default:
      return null;
  }
}

function isWireChat(m: any): boolean {
  return !!m && Number.isFinite(Number(m.seq)) && typeof m.text === 'string' && !!m.from && typeof m.from.name === 'string';
}

// Strip control chars and bidi/zero-width overrides that could spoof names
// ("admin" + RTL override) or hide content. Keeps tab/newline, text and emoji.
export function sanitizeDisplay(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
}

// Identity fields additionally drop tab/newline — a multi-line "name" only
// serves layout spoofing.
function sanitizeIdentity(raw: string): string {
  return sanitizeDisplay(raw).replace(/[\t\n\r]/g, ' ').trim();
}

function toUser(u: any): LoungeUser {
  const user: LoungeUser = { name: sanitizeIdentity(String(u.name)).slice(0, 32), tag: sanitizeIdentity(String(u.tag || '')).slice(0, 16) };
  if (typeof u.icon === 'string' && u.icon) user.icon = sanitizeIdentity(u.icon).slice(0, 16);
  return user;
}

function toMessage(m: any): LoungeMessage {
  return {
    seq: Number(m.seq),
    id: String(m.id || m.seq),
    from: toUser(m.from),
    text: sanitizeDisplay(m.text).slice(0, LOUNGE_MAX_TEXT),
    ts: Number(m.ts) || 0,
  };
}

export interface LoungeHelloExtras {
  icon?: string;
  room?: string;
  roomPass?: string;
}

export function encodeHello(deviceId: string, name: string, appVersion: string, afterSeq: number, extras: LoungeHelloExtras = {}): string {
  const hello: any = { v: 1, type: 'hello', deviceId, name, appVersion, afterSeq };
  if (extras.icon) hello.icon = extras.icon;
  if (extras.room && extras.room !== LOUNGE_GENERAL_ROOM) {
    hello.room = extras.room;
    if (extras.roomPass) hello.roomPass = extras.roomPass;
  }
  return JSON.stringify(hello);
}

export function encodeChat(clientId: string, text: string): string {
  return JSON.stringify({ v: 1, type: 'chat', clientId, text });
}

export function encodePing(): string {
  return JSON.stringify({ v: 1, type: 'ping' });
}

// Exponential backoff 1s → 30s cap, plus up to 30% jitter (rand in [0,1)).
export function nextBackoffMs(attempt: number, rand: number): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt), 30000);
  return Math.round(base + base * 0.3 * rand);
}

export function makeClientId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Merge incoming into existing, dropping duplicate seqs, keeping seq order.
export function mergeMessages(existing: LoungeMessage[], incoming: LoungeMessage[]): LoungeMessage[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((m) => m.seq));
  const fresh = incoming.filter((m) => !seen.has(m.seq));
  if (fresh.length === 0) return existing;
  return [...existing, ...fresh].sort((a, b) => a.seq - b.seq);
}

export function lastSeq(messages: LoungeMessage[]): number {
  return messages.length ? messages[messages.length - 1].seq : 0;
}

export function loadBlockedTags(raw: string | null): Set<string> {
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : []);
  } catch {
    return new Set();
  }
}

export function filterBlocked(messages: LoungeMessage[], blocked: Set<string>): LoungeMessage[] {
  if (blocked.size === 0) return messages;
  return messages.filter((m) => m.self || !blocked.has(m.from.tag));
}

export type LoungeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface LoungeEvents {
  welcome: (you: LoungeUser, online: number, history: LoungeMessage[], room: LoungeRoomInfo, motd?: string) => void;
  chat: (msg: LoungeMessage) => void;
  online: (count: number) => void;
  deleted: (seq: number) => void;
  error: (code: string, message?: string, retryAfterMs?: number) => void;
  status: (status: LoungeStatus) => void;
}

export interface LoungeClientOptions {
  url: string;
  deviceId: string;
  name: string;
  appVersion: string;
  afterSeq?: number;
  icon?: string;
  room?: string;
  roomPass?: string;
  webSocketCtor?: typeof WebSocket;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  randomFn?: () => number;
}

// Reconnecting lounge connection. Emits parsed events; owns nothing about rendering.
export class LoungeClient {
  private opts: LoungeClientOptions;
  private ws: WebSocket | null = null;
  private listeners: { [K in keyof LoungeEvents]?: Set<LoungeEvents[K]> } = {};
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private pendingClientIds = new Set<string>();
  status: LoungeStatus = 'idle';
  afterSeq: number;
  you: LoungeUser | null = null;
  room: LoungeRoomInfo | null = null;

  constructor(opts: LoungeClientOptions) {
    this.opts = opts;
    this.afterSeq = opts.afterSeq || 0;
  }

  on<K extends keyof LoungeEvents>(event: K, cb: LoungeEvents[K]): () => void {
    const set = (this.listeners[event] ||= new Set() as any);
    set.add(cb);
    return () => set.delete(cb);
  }

  private emit<K extends keyof LoungeEvents>(event: K, ...args: Parameters<LoungeEvents[K]>) {
    for (const cb of this.listeners[event] || []) {
      try {
        (cb as any)(...args);
      } catch {}
    }
  }

  private setStatus(status: LoungeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  setName(name: string) {
    this.opts.name = name;
  }

  connect() {
    this.closedByUser = false;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {}
    const Ctor = this.opts.webSocketCtor || WebSocket;
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new Ctor(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      ws.send(encodeHello(this.opts.deviceId, this.opts.name, this.opts.appVersion, this.afterSeq, {
        icon: this.opts.icon,
        room: this.opts.room,
        roomPass: this.opts.roomPass,
      }));
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.ws = null;
      this.clearTimers();
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private handleMessage(raw: unknown) {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'welcome': {
        this.attempt = 0;
        this.you = msg.you;
        this.room = msg.room;
        this.setStatus('connected');
        if (msg.history.length) this.afterSeq = Math.max(this.afterSeq, lastSeq(msg.history));
        this.emit('welcome', msg.you, msg.online, msg.history, msg.room, msg.motd);
        this.startPing();
        break;
      }
      case 'chat': {
        const { type: _type, ...m } = msg;
        this.afterSeq = Math.max(this.afterSeq, m.seq);
        if (this.pendingClientIds.delete(m.id)) (m as LoungeMessage).self = true;
        this.emit('chat', m);
        break;
      }
      case 'online':
        this.emit('online', msg.count);
        break;
      case 'deleted':
        this.emit('deleted', msg.seq);
        break;
      case 'error':
        // Auth-style rejections are permanent for this connection config —
        // retrying the same hello would loop forever, so stop reconnecting.
        if (msg.code === 'wrong_password' || msg.code === 'password_required' || msg.code === 'banned' || msg.code === 'version_gate') {
          this.closedByUser = true;
        }
        this.emit('error', msg.code, msg.message, msg.retryAfterMs);
        break;
      case 'pong':
        break;
    }
  }

  send(text: string): { ok: boolean; error?: string } {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: 'empty' };
    if (trimmed.length > LOUNGE_MAX_TEXT) return { ok: false, error: 'too_long' };
    if (!this.ws || this.ws.readyState !== 1 || this.status !== 'connected') return { ok: false, error: 'not_connected' };
    const clientId = makeClientId();
    this.pendingClientIds.add(clientId);
    try {
      this.ws.send(encodeChat(clientId, trimmed));
      return { ok: true };
    } catch {
      this.pendingClientIds.delete(clientId);
      return { ok: false, error: 'send_failed' };
    }
  }

  // Immediate retry (app focus / navigator.onLine) — skips the pending backoff wait.
  retryNow() {
    if (this.closedByUser || this.status === 'connected' || this.status === 'connecting') return;
    this.connect();
  }

  close() {
    this.closedByUser = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    this.setStatus('closed');
  }

  private scheduleReconnect() {
    if (this.closedByUser) return;
    this.setStatus('reconnecting');
    const setT = this.opts.setTimeoutFn || setTimeout;
    const rand = this.opts.randomFn || Math.random;
    const delay = nextBackoffMs(this.attempt, rand());
    this.attempt += 1;
    this.reconnectTimer = setT(() => this.connect(), delay);
  }

  private startPing() {
    const setT = this.opts.setTimeoutFn || setTimeout;
    const tick = () => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(encodePing());
      } catch {}
      this.pingTimer = setT(tick, 25000);
    };
    this.pingTimer = setT(tick, 25000);
  }

  private clearTimers() {
    const clearT = this.opts.clearTimeoutFn || clearTimeout;
    if (this.reconnectTimer) {
      clearT(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearT(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// Singleton handle so App gateway commands (lounge.send) can reach the live client.
export interface LoungeHandle {
  isConnected: () => boolean;
  send: (text: string) => { ok: boolean; error?: string };
}

let loungeHandle: LoungeHandle | null = null;
export function setLoungeHandle(handle: LoungeHandle | null) {
  loungeHandle = handle;
}
export function getLoungeHandle(): LoungeHandle | null {
  return loungeHandle;
}
