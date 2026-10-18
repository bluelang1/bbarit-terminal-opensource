// D7 회귀 테스트: 콜드부팅에 SurrealDB가 늦게 뜨면 kvGet이 localStorage 폴백으로
// 빈 값을 돌려주는데, 그 상태로 kvSet이 DB를 덮어쓰면 사용자의 실제 설정이 통째로
// 날아간다("설치하면 설정 소실"). 폴백으로 읽힌(degraded) 키는 DB가 다시 응답할
// 때까지 DB 쓰기/삭제가 차단되고 localStorage에만 기록되어야 한다.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => true,
}));

import { kvGet, kvSet, kvSetMany, kvDelete, kvMigrateFromLocalStorage, _kvDegradedKeysForTest } from './useKV';

const KEY = 'octo-terminal-projects';

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  _kvDegradedKeysForTest().clear();
});

describe('useKV degraded-key write guard (D7)', () => {
  it('kvGet DB 실패 → localStorage 폴백 + degraded 마킹', async () => {
    invokeMock.mockRejectedValueOnce(new Error('SurrealDB not ready'));
    localStorage.setItem(KEY, 'local-copy');
    const val = await kvGet(KEY);
    expect(val).toBe('local-copy');
    expect(_kvDegradedKeysForTest().has(KEY)).toBe(true);
  });

  it('degraded 키의 kvSet은 DB invoke 없이 localStorage에만 기록', async () => {
    _kvDegradedKeysForTest().add(KEY);
    await kvSet(KEY, 'blank-boot-state');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe('blank-boot-state');
  });

  it('degraded 키의 kvDelete는 DB invoke 없이 localStorage만 삭제', async () => {
    _kvDegradedKeysForTest().add(KEY);
    localStorage.setItem(KEY, 'x');
    await kvDelete(KEY);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('kvSetMany는 degraded 키만 걸러내고 나머지는 DB에 쓴다', async () => {
    _kvDegradedKeysForTest().add(KEY);
    invokeMock.mockResolvedValueOnce(undefined);
    await kvSetMany({ [KEY]: 'blocked', 'other-key': 'written' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('kv_set_many', {
      entries: { 'other-key': 'written' },
    });
    expect(localStorage.getItem(KEY)).toBe('blocked');
  });

  it('DB가 응답한 kvGet은 degraded를 해제하고 이후 kvSet은 DB로 간다', async () => {
    _kvDegradedKeysForTest().add(KEY);
    invokeMock.mockResolvedValueOnce('db-copy'); // kv_get 성공
    const val = await kvGet(KEY);
    expect(val).toBe('db-copy');
    expect(_kvDegradedKeysForTest().has(KEY)).toBe(false);

    invokeMock.mockResolvedValueOnce(undefined); // kv_set 성공
    await kvSet(KEY, 'new-value');
    expect(invokeMock).toHaveBeenLastCalledWith('kv_set', { key: KEY, value: 'new-value' });
  });

  it('DB에 값이 없어도(null) 응답 자체가 오면 degraded 해제', async () => {
    _kvDegradedKeysForTest().add(KEY);
    invokeMock.mockResolvedValueOnce(null); // kv_get: DB 정상, 값 없음
    await kvGet(KEY);
    expect(_kvDegradedKeysForTest().has(KEY)).toBe(false);
  });
});

// raw localStorage를 직접 쓰는 패널(Marketing 세션/hidden 등)의 상태를
// 마이그레이션이 localStorage에서 지워 훔쳐가면, 패널은 상태를 잃고
// FS 재스캔으로 삭제된 세션이 부활한다. 마이그레이션은 복사만 해야 한다.
describe('useKV migration keeps localStorage copies', () => {
  it('kvMigrateFromLocalStorage는 복사만 하고 localStorage 키를 지우지 않는다', async () => {
    localStorage.setItem('bbarit-marketing-hidden:/p', '["dir"]');
    localStorage.setItem('bbarit-marketing-sessions:/p', '[]');
    invokeMock.mockResolvedValueOnce(2); // kv_migrate_from_localstorage
    const count = await kvMigrateFromLocalStorage();
    expect(count).toBe(2);
    expect(localStorage.getItem('bbarit-marketing-hidden:/p')).toBe('["dir"]');
    expect(localStorage.getItem('bbarit-marketing-sessions:/p')).toBe('[]');
  });

  it('kvGet 자동 마이그레이션도 localStorage 복사본을 유지한다', async () => {
    localStorage.setItem(KEY, 'local-copy');
    invokeMock.mockResolvedValueOnce(null); // kv_get: DB에 없음
    invokeMock.mockResolvedValueOnce(undefined); // background kv_set
    const val = await kvGet(KEY);
    expect(val).toBe('local-copy');
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem(KEY)).toBe('local-copy');
  });

  it('kvDelete는 localStorage 복사본까지 지운다 (좀비 키 방지)', async () => {
    localStorage.setItem(KEY, 'stale');
    invokeMock.mockResolvedValueOnce(undefined); // kv_delete
    await kvDelete(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
