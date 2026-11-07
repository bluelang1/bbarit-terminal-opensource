// Convert `git remote -v` output into the repository's web page URL (no credentials).

function normalize(host: string, path: string): string | null {
  let h = host.toLowerCase();
  if (h.startsWith('github.com') && h !== 'github.com') h = 'github.com'; // ssh alias, e.g. github.com-work
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes('.')) return null;
  const p = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!p || !p.includes('/')) return null;
  return `https://${h}/${p}`;
}

function parseOne(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/i);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git'].includes(proto)) return null;
    const hostPort = scheme[2].slice(scheme[2].lastIndexOf('@') + 1); // drop user:token@
    const host = hostPort.replace(/:\d+$/, '');
    return normalize(host, scheme[3] || '');
  }
  const scp = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp) return normalize(scp[1], scp[2]);
  return null;
}

export function remoteWebUrl(remoteV: string): string | null {
  const entries: { name: string; url: string; type: string }[] = [];
  for (const line of (remoteV || '').split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (m) entries.push({ name: m[1], url: m[2], type: m[3] });
  }
  if (!entries.length) return null;
  const pick =
    entries.find(e => e.name === 'origin' && e.type === 'fetch') ||
    entries.find(e => e.name === 'origin') ||
    entries.find(e => e.type === 'fetch') ||
    entries[0];
  return parseOne(pick.url);
}
