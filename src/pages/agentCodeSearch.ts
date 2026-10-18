export const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage', 'target', '.tauri', '.octo-tmp']);
export const SEARCH_SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', '.env', '.env.local']);
export const SEARCH_TEXT_EXT = new Set([
  '.astro', '.css', '.go', '.html', '.js', '.json', '.jsx', '.md', '.mdx', '.mjs', '.py', '.rs', '.scss', '.svelte',
  '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
]);

export function extOf(path: string): string {
  const m = path.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : '';
}

export function joinPath(base: string, name: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${name}`.replace(/\\/g, '/');
}

export function relPath(root: string, path: string): string {
  const a = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const b = path.replace(/\\/g, '/');
  return b.startsWith(a + '/') ? b.slice(a.length + 1) : b;
}

export function globToRegex(glob: string): RegExp | null {
  const raw = glob.trim().replace(/\\/g, '/');
  if (!raw) return null;
  let out = '^';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '*') {
      if (raw[i + 1] === '*') {
        if (raw[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(out + '$', 'i');
}

export function globMatches(globRe: RegExp | null, glob: string, relative: string, name: string): boolean {
  if (!globRe) return true;
  const raw = glob.trim().replace(/\\/g, '/');
  const rel = relative.replace(/\\/g, '/');
  if (!raw.includes('/')) return globRe.test(name);
  return globRe.test(rel);
}

export function compileSearch(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'), 'i');
  }
}
