import { describe, expect, it } from 'vitest';
import { checkMachineName, groupTeamsByHome, isProtectedConfigPath, normalizeSyncStatus } from './agentBoardStorage';

describe('board sync helpers', () => {
  it('normalizes the host sync status and drops wrong types', () => {
    const s = normalizeSyncStatus({
      mode: 'sync', host: 'mac-a', hostSource: 'setting', state: 'offline', lastPushAt: 5, lastPullAt: 'x',
      lastError: 'cannot reach the PostgreSQL server', waiting: 3, skipped: 1, fullPush: true,
      machines: [{ host: 'mac-b', teams: 2, syncedAt: 9 }, { teams: 1 }, null],
    })!;
    expect(s.mode).toBe('sync');
    expect(s.state).toBe('offline');
    expect(s.lastPushAt).toBe(5);
    expect(s.lastPullAt).toBeNull();
    expect(s.waiting).toBe(3);
    expect(s.machines).toEqual([{ host: 'mac-b', teams: 2, syncedAt: 9 }]);
    expect(normalizeSyncStatus({ state: 'weird' })!.state).toBe('off');
    expect(normalizeSyncStatus(null)).toBeNull();
  });

  it('checks a machine name as typed', () => {
    expect(checkMachineName('  studio-mac ')).toEqual({ ok: true, value: 'studio-mac' });
    expect(checkMachineName('')).toEqual({ ok: true, value: '' });
    expect(checkMachineName('a\nb').ok).toBe(false);
    expect(checkMachineName('x'.repeat(121)).ok).toBe(false);
  });

  it("groups this machine's teams before other machines' teams", () => {
    const g = groupTeamsByHome([{ team: 'a' }, { team: 'b', mirror: true, homeHost: 'mac-b' }, { team: 'c', homeHost: 'mac-a' }]);
    expect(g.mine.map((t) => t.team)).toEqual(['a', 'c']);
    expect(g.others.map((t) => t.team)).toEqual(['b']);
  });

  it('keeps the machine name away from agents', () => {
    expect(isProtectedConfigPath('agents.board.hostName')).toBe(true);
  });
});
