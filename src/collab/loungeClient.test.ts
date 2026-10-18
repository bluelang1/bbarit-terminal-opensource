import { describe, expect, it, vi } from 'vitest';
import {
  LOUNGE_LAST_SEQ_KEY,
  LoungeClient,
  encodeChat,
  encodeHello,
  filterBlocked,
  lastSeq,
  lastSeqKey,
  loadBlockedTags,
  mergeMessages,
  nextBackoffMs,
  normalizeRoomName,
  parseServerMessage,
} from './loungeClient';
import type { LoungeMessage } from './loungeClient';

function chat(seq: number, text = `m${seq}`, tag = 'aaaa', self = false): LoungeMessage {
  const m: LoungeMessage = { seq, id: `id${seq}`, from: { name: 'user', tag }, text, ts: seq * 1000 };
  if (self) m.self = true;
  return m;
}

describe('parseServerMessage', () => {
  it('parses a welcome with history and drops malformed entries', () => {
    const raw = JSON.stringify({
      v: 1,
      type: 'welcome',
      you: { name: 'jojo', tag: 'a3f2' },
      online: 41,
      motd: 'hi',
      history: [
        { seq: 1, id: 'x', from: { name: 'a', tag: '1111' }, text: 'one', ts: 10 },
        { seq: 'bad', text: 'nope' },
      ],
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({ type: 'welcome', you: { name: 'jojo', tag: 'a3f2' }, online: 41, motd: 'hi' });
    expect((msg as any).history).toHaveLength(1);
    expect((msg as any).history[0].text).toBe('one');
    expect((msg as any).room).toEqual({ name: 'general', private: false });
  });

  it('parses v1.1 icons and room info', () => {
    const msg = parseServerMessage(JSON.stringify({
      v: 1,
      type: 'welcome',
      you: { name: 'jojo', tag: 'a3f2', icon: '🦊' },
      online: 2,
      room: { name: 'my-team', private: true },
      history: [{ seq: 1, id: 'x', from: { name: 'a', tag: '1111', icon: '🐸' }, text: 'one', ts: 10 }],
    }));
    expect((msg as any).you.icon).toBe('🦊');
    expect((msg as any).room).toEqual({ name: 'my-team', private: true });
    expect((msg as any).history[0].from.icon).toBe('🐸');
  });

  it('parses chat / online / deleted / error / pong', () => {
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'chat', seq: 5, id: 'u', from: { name: 'b', tag: '2222' }, text: 'yo', ts: 99 })))
      .toMatchObject({ type: 'chat', seq: 5, text: 'yo' });
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'online', count: 7 }))).toEqual({ type: 'online', count: 7 });
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'deleted', seq: 3 }))).toEqual({ type: 'deleted', seq: 3 });
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'error', code: 'rate_limited', retryAfterMs: 3000 })))
      .toMatchObject({ type: 'error', code: 'rate_limited', retryAfterMs: 3000 });
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'pong' }))).toEqual({ type: 'pong' });
  });

  it('rejects wrong version, unknown types, and non-JSON', () => {
    expect(parseServerMessage(JSON.stringify({ v: 2, type: 'pong' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'nope' }))).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
  });

  it('rejects malformed chat/welcome and coerces garbage fields', () => {
    // chat without a sender or seq is dropped, not crashed on
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'chat', seq: 1, text: 'x' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'chat', from: { name: 'a' }, text: 'x' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'welcome', online: 3, history: [] }))).toBeNull();
    // missing ts/id fall back instead of NaN/undefined
    const m = parseServerMessage(JSON.stringify({ v: 1, type: 'chat', seq: 9, from: { name: 'a', tag: 't' }, text: 'x' }));
    expect(m).toMatchObject({ type: 'chat', seq: 9, ts: 0, id: '9' });
    // garbage counts coerce to 0
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'online', count: 'many' }))).toEqual({ type: 'online', count: 0 });
    expect(parseServerMessage(JSON.stringify({ v: 1, type: 'deleted', seq: 'nope' }))).toBeNull();
  });
});

describe('encoders', () => {
  it('encodes hello with afterSeq and chat with clientId', () => {
    expect(JSON.parse(encodeHello('dev-1', 'jojo', '0.1.69', 42)))
      .toEqual({ v: 1, type: 'hello', deviceId: 'dev-1', name: 'jojo', appVersion: '0.1.69', afterSeq: 42 });
    expect(JSON.parse(encodeChat('cid', 'hello'))).toEqual({ v: 1, type: 'chat', clientId: 'cid', text: 'hello' });
  });

  it('encodes v1.1 extras: icon always, room+pass only for non-general rooms', () => {
    const full = JSON.parse(encodeHello('d', 'n', 'v', 0, { icon: '🦊', room: 'my-team', roomPass: 'pw' }));
    expect(full).toMatchObject({ icon: '🦊', room: 'my-team', roomPass: 'pw' });
    const general = JSON.parse(encodeHello('d', 'n', 'v', 0, { icon: '🦊', room: 'general', roomPass: 'pw' }));
    expect(general.icon).toBe('🦊');
    expect(general.room).toBeUndefined();
    expect(general.roomPass).toBeUndefined();
  });
});

describe('hashRoomPass', () => {
  it('derives a stable slow-KDF hex credential bound to the room name', async () => {
    const { hashRoomPass } = await import('./loungeClient');
    const a = await hashRoomPass('my-team', 'secret');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashRoomPass('my-team', 'secret')).toBe(a);
    expect(await hashRoomPass('other-room', 'secret')).not.toBe(a);
    expect(await hashRoomPass('my-team', 'different')).not.toBe(a);
  }, 15000);
});

describe('E2E encryption', () => {
  it('round-trips text and marks payloads', async () => {
    const { deriveRoomKeyHex, encryptText, decryptText, isE2ePayload } = await import('./loungeClient');
    const key = await deriveRoomKeyHex('my-team', 'secret');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const payload = await encryptText(key, '안녕 🚀 secret message');
    expect(isE2ePayload(payload)).toBe(true);
    expect(payload).not.toContain('secret message');
    expect(await decryptText(key, payload)).toBe('안녕 🚀 secret message');
  });

  it('produces a fresh ciphertext per message (random IV)', async () => {
    const { deriveRoomKeyHex, encryptText } = await import('./loungeClient');
    const key = await deriveRoomKeyHex('my-team', 'secret');
    expect(await encryptText(key, 'same')).not.toBe(await encryptText(key, 'same'));
  });

  it('fails closed on the wrong key and passes plaintext through', async () => {
    const { deriveRoomKeyHex, encryptText, decryptText } = await import('./loungeClient');
    const good = await deriveRoomKeyHex('my-team', 'secret');
    const bad = await deriveRoomKeyHex('my-team', 'wrong');
    const payload = await encryptText(good, 'hidden');
    expect(await decryptText(bad, payload)).toBeNull();
    expect(await decryptText(bad, 'plain old text')).toBe('plain old text');
  });

  it('round-trips 1,000 chars of multibyte text within the transport cap', async () => {
    const { deriveRoomKeyHex, encryptText, decryptText, LOUNGE_MAX_TEXT } = await import('./loungeClient');
    const key = await deriveRoomKeyHex('my-team', 'secret');
    for (const text of ['가나다라😀'.repeat(200), '😀'.repeat(1000)]) { // worst case: 1,000 four-byte code points
      const payload = await encryptText(key, text);
      expect(payload.length).toBeLessThanOrEqual(LOUNGE_MAX_TEXT);
      expect(await decryptText(key, payload)).toBe(text);
    }
  });

  it('rejects tampered and malformed payloads instead of throwing', async () => {
    const { deriveRoomKeyHex, encryptText, decryptText } = await import('./loungeClient');
    const key = await deriveRoomKeyHex('my-team', 'secret');
    const payload = await encryptText(key, 'authentic');
    const tampered = payload.slice(0, -4) + (payload.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(await decryptText(key, tampered)).toBeNull(); // GCM integrity check
    expect(await decryptText(key, 'e2e:v1:')).toBeNull();
    expect(await decryptText(key, 'e2e:v1:onlyonepart')).toBeNull();
    expect(await decryptText(key, 'e2e:v1:!!!:???')).toBeNull();
    expect(await decryptText(key, 'e2e:v1:a:b:c')).toBeNull();
  });

  it('derives the encryption key on a different domain than the auth credential', async () => {
    const { deriveRoomKeyHex, hashRoomPass } = await import('./loungeClient');
    expect(await deriveRoomKeyHex('my-team', 'secret')).not.toBe(await hashRoomPass('my-team', 'secret'));
  });

  it('flags plaintext arriving in an E2E room as unverified (audit M2)', async () => {
    const { decryptIncoming, deriveRoomKeyHex, encryptText, DECRYPT_FAIL_TEXT } = await import('./loungeClient');
    const key = await deriveRoomKeyHex('my-team', 'secret');
    const authentic = { ...chat(1), text: await encryptText(key, 'real') };
    const injected = chat(2, 'server-injected plaintext');
    const wrongKey = { ...chat(3), text: await encryptText(await deriveRoomKeyHex('my-team', 'other'), 'x') };
    const [a, b, c] = await decryptIncoming(key, [authentic, injected, wrongKey]);
    expect(a.text).toBe('real');
    expect(a.unverified).toBeUndefined();
    expect(b.unverified).toBe(true);
    expect(c.text).toBe(DECRYPT_FAIL_TEXT);
    // no key (public room): untouched
    const passthrough = await decryptIncoming(undefined, [injected]);
    expect(passthrough[0].unverified).toBeUndefined();
  });
});

describe('room helpers', () => {
  it('normalizes room names to the server rule', () => {
    expect(normalizeRoomName('  My Team  ')).toBe('my-team');
    expect(normalizeRoomName('한글!!room_9')).toBe('room9');
    expect(normalizeRoomName('x'.repeat(40))).toHaveLength(24);
    expect(normalizeRoomName('한글만!!!')).toBe(''); // nothing valid left → join is rejected upstream
    expect(normalizeRoomName('A_B C')).toBe('ab-c');
  });

  it('keeps the legacy lastSeq key for general and suffixes other rooms', () => {
    expect(lastSeqKey('general')).toBe(LOUNGE_LAST_SEQ_KEY);
    expect(lastSeqKey('my-team')).toBe(`${LOUNGE_LAST_SEQ_KEY}:my-team`);
  });
});

describe('nextBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(nextBackoffMs(0, 0)).toBe(1000);
    expect(nextBackoffMs(1, 0)).toBe(2000);
    expect(nextBackoffMs(4, 0)).toBe(16000);
    expect(nextBackoffMs(10, 0)).toBe(30000);
  });

  it('adds up to 30% jitter', () => {
    expect(nextBackoffMs(0, 1)).toBe(1300);
    expect(nextBackoffMs(10, 0.5)).toBe(34500);
  });
});

describe('mergeMessages', () => {
  it('dedupes by seq and keeps seq order', () => {
    const merged = mergeMessages([chat(1), chat(3)], [chat(3, 'dup'), chat(2), chat(4)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(merged.find((m) => m.seq === 3)?.text).toBe('m3');
  });

  it('returns existing array untouched when nothing new', () => {
    const existing = [chat(1)];
    expect(mergeMessages(existing, [chat(1)])).toBe(existing);
  });

  it('reports last seq for afterSeq resume', () => {
    expect(lastSeq([])).toBe(0);
    expect(lastSeq([chat(1), chat(9)])).toBe(9);
  });

  it('sorts unsorted incoming batches and keeps the first copy of a seq', () => {
    const mine = { ...chat(2), self: true };
    const merged = mergeMessages([mine], [chat(5), chat(1), chat(2, 'imposter'), chat(3)]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3, 5]);
    // the self-marked original survives the duplicate from history replay
    expect(merged.find((m) => m.seq === 2)?.self).toBe(true);
  });

  it('starts from an empty list', () => {
    expect(mergeMessages([], [chat(3), chat(1)]).map((m) => m.seq)).toEqual([1, 3]);
  });
});

describe('flood defense (audit L1)', () => {
  it('caps welcome history at 200 entries and truncates oversized text', async () => {
    const { parseServerMessage: parse, LOUNGE_MAX_HISTORY, LOUNGE_MAX_TEXT } = await import('./loungeClient');
    const history = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, id: `${i}`, from: { name: 'a', tag: 't' }, text: 'x'.repeat(10000), ts: i }));
    const msg = parse(JSON.stringify({ v: 1, type: 'welcome', you: { name: 'me', tag: 'aa' }, online: 1, history, motd: 'm'.repeat(2000) })) as any;
    expect(msg.history).toHaveLength(LOUNGE_MAX_HISTORY);
    expect(msg.history[0].seq).toBe(301); // keeps the most recent entries
    expect(msg.history[0].text).toHaveLength(LOUNGE_MAX_TEXT);
    expect(msg.motd).toHaveLength(500);
  });
});

describe('sanitizeDisplay (spoofing defense)', () => {
  it('strips bidi overrides, zero-width chars, and control chars from names and text', async () => {
    const { parseServerMessage: parse } = await import('./loungeClient');
    const msg = parse(JSON.stringify({
      v: 1,
      type: 'chat',
      seq: 1,
      from: { name: 'admin‮​', tag: 'aa aa', icon: '🦊‪' },
      text: 'hi‮desrever but\nnewlines\tstay',
      ts: 1,
    })) as any;
    expect(msg.from.name).toBe('admin');
    expect(msg.from.tag).toBe('aaaa');
    expect(msg.from.icon).toBe('🦊');
    expect(msg.text).toBe('hidesrever but\nnewlines\tstay');
  });
});

describe('blocklist', () => {
  it('loads tags from JSON and survives garbage', () => {
    expect([...loadBlockedTags('["abcd","ef01"]')]).toEqual(['abcd', 'ef01']);
    expect(loadBlockedTags(null).size).toBe(0);
    expect(loadBlockedTags('{bad').size).toBe(0);
  });

  it('hides blocked tags but never own messages', () => {
    const msgs = [chat(1, 'a', 'aaaa'), chat(2, 'b', 'bbbb'), chat(3, 'c', 'bbbb', true)];
    const visible = filterBlocked(msgs, new Set(['bbbb']));
    expect(visible.map((m) => m.seq)).toEqual([1, 3]);
  });
});

// Minimal scriptable WebSocket double for the client state machine.
class FakeWs {
  static instances: FakeWs[] = [];
  static failConstruct = false;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    if (FakeWs.failConstruct) throw new Error('boom');
    this.url = url;
    FakeWs.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  serverOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  serverSend(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeClient(overrides: Partial<ConstructorParameters<typeof LoungeClient>[0]> = {}) {
  FakeWs.instances = [];
  FakeWs.failConstruct = false;
  const timers: Array<{ fn: () => void; delay: number }> = [];
  const client = new LoungeClient({
    url: 'ws://test/ws',
    deviceId: 'dev-1',
    name: 'jojo',
    appVersion: '0.1.69',
    webSocketCtor: FakeWs as unknown as typeof WebSocket,
    setTimeoutFn: ((fn: () => void, delay: number) => {
      timers.push({ fn, delay });
      return timers.length as any;
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
    randomFn: () => 0,
    ...overrides,
  });
  return { client, timers };
}

function welcomePayload(history: LoungeMessage[] = []) {
  return { v: 1, type: 'welcome', you: { name: 'jojo', tag: 'a3f2' }, online: 2, history };
}

describe('LoungeClient state machine', () => {
  it('sends hello on open and becomes connected on welcome', () => {
    const { client } = makeClient();
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'hello', deviceId: 'dev-1', afterSeq: 0 });
    ws.serverSend(welcomePayload([chat(7)]));
    expect(client.status).toBe('connected');
    expect(client.afterSeq).toBe(7);
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('marks own echo via clientId and tracks afterSeq', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload());
    const received: LoungeMessage[] = [];
    client.on('chat', (m) => received.push(m));
    expect(client.send('hello all').ok).toBe(true);
    const sentChat = JSON.parse(ws.sent[1]);
    ws.serverSend({ v: 1, type: 'chat', seq: 10, id: sentChat.clientId, from: { name: 'jojo', tag: 'a3f2' }, text: 'hello all', ts: 1 });
    ws.serverSend({ v: 1, type: 'chat', seq: 11, id: 'other', from: { name: 'x', tag: 'bbbb' }, text: 'yo', ts: 2 });
    expect(received[0].self).toBe(true);
    expect(received[1].self).toBeUndefined();
    expect(client.afterSeq).toBe(11);
  });

  it('rejects send when empty, too long, or not connected', () => {
    const { client } = makeClient();
    expect(client.send('hi')).toEqual({ ok: false, error: 'not_connected' });
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload());
    expect(client.send('  ')).toEqual({ ok: false, error: 'empty' });
    expect(client.send('x'.repeat(6001))).toEqual({ ok: false, error: 'too_long' });
  });

  it('reconnects with growing backoff and resumes with afterSeq', () => {
    const { client, timers } = makeClient();
    client.connect();
    const ws1 = FakeWs.instances[0];
    ws1.serverOpen();
    ws1.serverSend(welcomePayload([chat(5)]));
    ws1.close();
    expect(client.status).toBe('reconnecting');
    const reconnect1 = timers.find((t) => t.delay === 1000);
    expect(reconnect1).toBeDefined();
    reconnect1!.fn();
    const ws2 = FakeWs.instances[1];
    ws2.serverOpen();
    expect(JSON.parse(ws2.sent[0]).afterSeq).toBe(5);
    // second drop before welcome → attempt grows, delay doubles
    ws2.close();
    expect(timers.some((t) => t.delay === 2000)).toBe(true);
  });

  it('does not reconnect after user close', () => {
    const { client, timers } = makeClient();
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload());
    const before = timers.length;
    client.close();
    expect(client.status).toBe('closed');
    expect(timers.length).toBe(before);
    expect(FakeWs.instances).toHaveLength(1);
  });

  it('emits error events (rate_limited)', () => {
    const { client } = makeClient();
    const errors: string[] = [];
    client.on('error', (code) => errors.push(code));
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend({ v: 1, type: 'error', code: 'rate_limited', message: 'slow down', retryAfterMs: 3000 });
    expect(errors).toEqual(['rate_limited']);
  });

  it('sends room/pass/icon in hello and stops reconnecting on wrong_password', () => {
    const { client, timers } = makeClient({ room: 'my-team', roomPass: 'pw', icon: '🦊' });
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ room: 'my-team', roomPass: 'pw', icon: '🦊' });
    const errors: string[] = [];
    client.on('error', (code) => errors.push(code));
    const before = timers.length;
    ws.serverSend({ v: 1, type: 'error', code: 'wrong_password' });
    ws.close();
    expect(errors).toEqual(['wrong_password']);
    expect(timers.length).toBe(before);
    expect(client.status).toBe('closed');
  });

  it('rejects send while reconnecting', () => {
    const { client } = makeClient();
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload());
    ws.close();
    expect(client.status).toBe('reconnecting');
    expect(client.send('hi')).toEqual({ ok: false, error: 'not_connected' });
  });

  it('keeps reconnecting after rate_limited (unlike auth errors)', () => {
    const { client, timers } = makeClient();
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload());
    ws.serverSend({ v: 1, type: 'error', code: 'rate_limited', retryAfterMs: 3000 });
    const before = timers.length;
    ws.close();
    expect(timers.length).toBe(before + 1); // reconnect still scheduled
    expect(client.status).toBe('reconnecting');
  });

  it('resets the backoff schedule after a successful welcome', () => {
    const { client, timers } = makeClient();
    client.connect();
    const ws1 = FakeWs.instances[0];
    // two failed dials → attempts grow to delay 2000
    ws1.close();
    timers.shift()!.fn();
    FakeWs.instances[1].close();
    expect(timers.some((t) => t.delay === 2000)).toBe(true);
    timers.shift()!.fn();
    const ws3 = FakeWs.instances[2];
    ws3.serverOpen();
    ws3.serverSend(welcomePayload());
    expect(client.status).toBe('connected');
    // next drop starts over at 1s, not 4s
    ws3.close();
    expect(timers[timers.length - 1].delay).toBe(1000);
  });

  it('handles a duplicate welcome without duplicating history', () => {
    const { client } = makeClient();
    const welcomes: number[] = [];
    client.on('welcome', (_you, _online, history) => welcomes.push(history.length));
    client.connect();
    const ws = FakeWs.instances[0];
    ws.serverOpen();
    ws.serverSend(welcomePayload([chat(1), chat(2)]));
    ws.serverSend(welcomePayload([chat(1), chat(2)]));
    expect(welcomes).toEqual([2, 2]);
    expect(client.afterSeq).toBe(2); // idempotent, view-side mergeMessages dedups
    expect(client.status).toBe('connected');
  });

  it('generates unique client ids under burst', async () => {
    const { makeClientId } = await import('./loungeClient');
    const ids = new Set(Array.from({ length: 1000 }, () => makeClientId()));
    expect(ids.size).toBe(1000);
  });

  it('schedules a retry even when the socket constructor throws', () => {
    const { client, timers } = makeClient();
    FakeWs.failConstruct = true;
    client.connect();
    expect(client.status).toBe('reconnecting');
    expect(timers).toHaveLength(1);
  });
});
