import { describe, expect, it, vi } from 'vitest';
import { fetchStatusesByRepo, shareInFlight } from './terminalGitStatus';

describe('fetchStatusesByRepo', () => {
  it('should_fetch_once_per_distinct_repo_and_fan_out_to_every_terminal', async () => {
    const fetchStatus = vi.fn(async (dir: string) => `status of ${dir}`);
    const entries = await fetchStatusesByRepo(
      [
        { terminalId: 't1', workDir: '/big/repo' },
        { terminalId: 't2', workDir: '/big/repo' },
        { terminalId: 't3', workDir: ' /big/repo ' },
        { terminalId: 't4', workDir: '/other' },
      ],
      fetchStatus,
    );
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(fetchStatus.mock.calls.map(c => c[0]).sort()).toEqual(['/big/repo', '/other']);
    expect(entries).toEqual([
      ['t1', 'status of /big/repo'],
      ['t2', 'status of /big/repo'],
      ['t3', 'status of /big/repo'],
      ['t4', 'status of /other'],
    ]);
  });

  it('should_give_null_for_empty_or_skipped_dirs_without_fetching', async () => {
    const fetchStatus = vi.fn(async (dir: string) => dir);
    const entries = await fetchStatusesByRepo(
      [
        { terminalId: 'a', workDir: '' },
        { terminalId: 'b', workDir: '   ' },
        { terminalId: 'c', workDir: 'ssh://host/dir' },
      ],
      fetchStatus,
      dir => dir.startsWith('ssh://'),
    );
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(entries).toEqual([['a', null], ['b', null], ['c', null]]);
  });

  it('should_keep_terminal_order', async () => {
    const entries = await fetchStatusesByRepo(
      [
        { terminalId: 'x', workDir: '/b' },
        { terminalId: 'y', workDir: '/a' },
        { terminalId: 'z', workDir: '/b' },
      ],
      async dir => dir,
    );
    expect(entries.map(e => e[0])).toEqual(['x', 'y', 'z']);
  });
});

describe('shareInFlight', () => {
  it('should_share_a_running_call_for_the_same_key', async () => {
    let resolve!: (v: string) => void;
    const fn = vi.fn((_key: string) => new Promise<string>(r => { resolve = r; }));
    const shared = shareInFlight(fn);
    const a = shared('/repo');
    const b = shared('/repo');
    expect(fn).toHaveBeenCalledTimes(1);
    resolve('done');
    await expect(Promise.all([a, b])).resolves.toEqual(['done', 'done']);
  });

  it('should_call_again_after_the_previous_call_finished', async () => {
    const fn = vi.fn(async (key: string) => key);
    const shared = shareInFlight(fn);
    await shared('/repo');
    await shared('/repo');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should_not_share_between_different_keys', async () => {
    const fn = vi.fn(async (key: string) => key);
    const shared = shareInFlight(fn);
    await Promise.all([shared('/a'), shared('/b')]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should_forget_a_failed_call', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    const shared = shareInFlight(fn as (key: string) => Promise<string>);
    await expect(shared('/repo')).rejects.toThrow('boom');
    await expect(shared('/repo')).resolves.toBe('ok');
  });
});
