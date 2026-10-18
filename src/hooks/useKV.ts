/**
 * KV Store — SurrealDB-backed replacement for localStorage.
 *
 * Usage:
 *   import { kvGet, kvSet, kvDelete } from '../hooks/useKV';
 *   const val = await kvGet('octo-terminal-projects');
 *   await kvSet('octo-terminal-projects', JSON.stringify(data));
 *
 * Migration:
 *   On first load, call `kvMigrateFromLocalStorage()` to copy
 *   all existing localStorage entries into the DB.
 *
 *   Migration COPIES, it never deletes: several panels (Marketing, Motion,
 *   Lounge caches, …) still read/write raw localStorage, and every window
 *   boots AppBootstrap against the same shared localStorage. Deleting keys
 *   after migrating used to steal those panels' live state into the DB where
 *   raw readers can't see it (e.g. deleted marketing sessions resurrecting
 *   because the hidden-list vanished). Only kvDelete removes a key, and it
 *   removes it from both stores.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';

// D7(2026-07-04): these were 900/1500ms, but at cold boot SurrealDB is still
// opening (18MB RocksDB ≈ seconds) — reads timed out, fell back to the
// localStorage the migration had already emptied, and the app booted blank,
// then autosaved the blank state over the real DB ("설치하면 설정 소실").
// The Rust side now waits for DB init (kv_ensure_schema → wait_db 15s); these
// timeouts must sit ABOVE that wait so the backend, not the frontend, decides.
const KV_INVOKE_TIMEOUT_MS = 20000;
const KV_WRITE_TIMEOUT_MS = 20000;
const KV_MIGRATE_TIMEOUT_MS = 30000;

// Keys whose last read came from the error-fallback path (DB unreachable). A
// value read from fallback may be empty/stale, so writing it back once the DB
// recovers would clobber the real data — block DB writes for such keys until a
// read against the DB succeeds again. (Fallback writes still go to localStorage
// so nothing typed during a degraded session is silently dropped.)
const degradedKeys = new Set<string>();

/** Test hook: inspect/clear the degraded-key guard. */
export function _kvDegradedKeysForTest(): Set<string> {
  return degradedKeys;
}

async function invokeWithTimeout<T>(
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = KV_INVOKE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      invoke<T>(command, args),
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(`${command} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

/**
 * Get a single value by key.
 * If not in DB but exists in localStorage, auto-migrate it to DB and remove from localStorage.
 */
export async function kvGet(key: string): Promise<string | null> {
  if (!isTauri()) return localStorage.getItem(key);
  try {
    const result = await invokeWithTimeout<string | null>('kv_get', { key });
    degradedKeys.delete(key); // DB answered — writes for this key are safe again
    if (result != null) return result;

    // Not in DB — check localStorage fallback and migrate if found
    const localVal = localStorage.getItem(key);
    if (localVal !== null) {
      // Copy to DB in background; keep the localStorage copy (see header note)
      invokeWithTimeout('kv_set', { key, value: localVal }, KV_WRITE_TIMEOUT_MS).then(() => {
        console.log(`[KV] Auto-migrated "${key}" from localStorage to DB`);
      }).catch(() => { /* keep in localStorage if DB write fails */ });
      return localVal;
    }
    return null;
  } catch (err) {
    console.warn('[KV] get failed, falling back to localStorage:', key, err);
    degradedKeys.add(key); // value may be empty/stale — protect the DB copy
    return localStorage.getItem(key);
  }
}

/** Set a single key-value pair. */
export async function kvSet(key: string, value: string): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem(key, value);
    return;
  }
  if (degradedKeys.has(key)) {
    // Last read for this key never reached the DB, so the in-memory state may
    // be the blank fallback — persisting it would overwrite the user's real
    // data. Keep it in localStorage; the guard clears on the next healthy read.
    console.warn('[KV] set blocked (degraded key, DB copy protected):', key);
    localStorage.setItem(key, value);
    return;
  }
  try {
    await invokeWithTimeout('kv_set', { key, value }, KV_WRITE_TIMEOUT_MS);
  } catch (err) {
    console.warn('[KV] set failed, falling back to localStorage:', key, err);
    localStorage.setItem(key, value);
  }
}

/** Delete a key. */
export async function kvDelete(key: string): Promise<void> {
  if (!isTauri()) {
    localStorage.removeItem(key);
    return;
  }
  if (degradedKeys.has(key)) {
    console.warn('[KV] delete blocked (degraded key, DB copy protected):', key);
    localStorage.removeItem(key);
    return;
  }
  try {
    await invokeWithTimeout('kv_delete', { key }, KV_WRITE_TIMEOUT_MS);
    // Also clear any localStorage copy, or a later DB-miss kvGet would
    // auto-migrate the stale value back ("zombie key").
    localStorage.removeItem(key);
  } catch (err) {
    console.warn('[KV] delete failed:', key, err);
  }
}

/** Get multiple values at once. */
export async function kvGetMany(keys: string[]): Promise<Record<string, string>> {
  if (!isTauri()) {
    const result: Record<string, string> = {};
    for (const key of keys) {
      const val = localStorage.getItem(key);
      if (val !== null) result[key] = val;
    }
    return result;
  }
  try {
    const result = await invokeWithTimeout<Record<string, string>>('kv_get_many', { keys });
    for (const key of keys) degradedKeys.delete(key);
    return result;
  } catch (err) {
    console.warn('[KV] getMany failed, falling back to localStorage:', err);
    const result: Record<string, string> = {};
    for (const key of keys) {
      degradedKeys.add(key);
      const val = localStorage.getItem(key);
      if (val !== null) result[key] = val;
    }
    return result;
  }
}

/** Set multiple key-value pairs at once. */
export async function kvSetMany(entries: Record<string, string>): Promise<void> {
  if (!isTauri()) {
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, value);
    }
    return;
  }
  const degraded: Record<string, string> = {};
  const writable: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (degradedKeys.has(key)) degraded[key] = value;
    else writable[key] = value;
  }
  for (const [key, value] of Object.entries(degraded)) {
    console.warn('[KV] setMany blocked (degraded key, DB copy protected):', key);
    localStorage.setItem(key, value);
  }
  if (Object.keys(writable).length === 0) return;
  try {
    await invokeWithTimeout('kv_set_many', { entries: writable }, KV_WRITE_TIMEOUT_MS);
  } catch (err) {
    console.warn('[KV] setMany failed, falling back to localStorage:', err);
    for (const [key, value] of Object.entries(writable)) {
      localStorage.setItem(key, value);
    }
  }
}

/**
 * Migrate all localStorage entries into the KV store (DB).
 * Only inserts keys that don't already exist in DB (safe to call multiple times).
 * localStorage keys are kept: panels that still read raw localStorage own their
 * live state there, and this runs on every window boot (see header note).
 */
export async function kvMigrateFromLocalStorage(): Promise<number> {
  if (!isTauri()) return 0;
  const entries: Record<string, string> = {};

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    // Skip Vite/HMR internal keys
    if (key.startsWith('vite-') || key.startsWith('__vite')) continue;
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }

  if (Object.keys(entries).length === 0) return 0;

  try {
    const count = await invokeWithTimeout<number>('kv_migrate_from_localstorage', { entries }, KV_MIGRATE_TIMEOUT_MS);
    if (count > 0) console.log(`[KV] Migrated ${count} keys from localStorage to DB`);
    return count;
  } catch (err) {
    console.warn('[KV] Migration failed (localStorage kept):', err);
    return 0;
  }
}

/**
 * Helper: get a JSON-parsed value, with fallback.
 */
export async function kvGetJSON<T>(key: string, fallback: T): Promise<T> {
  const raw = await kvGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Helper: set a JSON-stringified value.
 */
export async function kvSetJSON(key: string, value: unknown): Promise<void> {
  await kvSet(key, JSON.stringify(value));
}
