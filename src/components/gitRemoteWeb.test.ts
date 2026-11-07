import { describe, it, expect } from 'vitest';
import { remoteWebUrl } from './gitRemoteWeb';

const v = (url: string, name = 'origin') => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;

describe('remoteWebUrl', () => {
  it('scp-style github ssh', () => {
    expect(remoteWebUrl(v('git@github.com:owner/repo.git'))).toBe('https://github.com/owner/repo');
  });
  it('ssh:// url', () => {
    expect(remoteWebUrl(v('ssh://git@github.com/owner/repo.git'))).toBe('https://github.com/owner/repo');
    expect(remoteWebUrl(v('ssh://git@github.com:22/owner/repo.git'))).toBe('https://github.com/owner/repo');
  });
  it('https with and without .git', () => {
    expect(remoteWebUrl(v('https://github.com/owner/repo.git'))).toBe('https://github.com/owner/repo');
    expect(remoteWebUrl(v('https://github.com/owner/repo'))).toBe('https://github.com/owner/repo');
    expect(remoteWebUrl(v('https://github.com/owner/repo/'))).toBe('https://github.com/owner/repo');
  });
  it('strips credentials', () => {
    const r = remoteWebUrl(v('https://user:ghp_SECRET123@github.com/owner/repo.git'));
    expect(r).toBe('https://github.com/owner/repo');
    expect(r).not.toContain('ghp_SECRET123');
    expect(r).not.toContain('user');
    const t = remoteWebUrl(v('https://ghp_ONLYTOKEN@github.com/owner/repo'));
    expect(t).toBe('https://github.com/owner/repo');
    expect(t).not.toContain('ONLYTOKEN');
  });
  it('gitlab, bitbucket, other hosts', () => {
    expect(remoteWebUrl(v('git@gitlab.com:grp/sub/repo.git'))).toBe('https://gitlab.com/grp/sub/repo');
    expect(remoteWebUrl(v('git@bitbucket.org:team/repo.git'))).toBe('https://bitbucket.org/team/repo');
    expect(remoteWebUrl(v('https://git.example.com/a/b.git'))).toBe('https://git.example.com/a/b');
  });
  it('ssh host alias github.com-work', () => {
    expect(remoteWebUrl(v('git@github.com-work:owner/repo.git'))).toBe('https://github.com/owner/repo');
  });
  it('prefers origin fetch, else first remote', () => {
    const raw = v('https://github.com/a/up.git', 'upstream') + v('https://github.com/b/mine.git', 'origin');
    expect(remoteWebUrl(raw)).toBe('https://github.com/b/mine');
    expect(remoteWebUrl(v('https://github.com/a/up.git', 'upstream') + v('https://github.com/c/x.git', 'zzz')))
      .toBe('https://github.com/a/up');
  });
  it('null for local/file/unparsable/empty', () => {
    expect(remoteWebUrl(v('/Users/me/repo.git'))).toBeNull();
    expect(remoteWebUrl(v('../repo'))).toBeNull();
    expect(remoteWebUrl(v('file:///tmp/repo.git'))).toBeNull();
    expect(remoteWebUrl(v('garbage'))).toBeNull();
    expect(remoteWebUrl('')).toBeNull();
  });
});
