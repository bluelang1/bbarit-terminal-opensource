export type CliArgShell = 'powershell' | 'cmd' | 'gitbash' | 'wsl' | 'posix' | undefined;

function stripOuterQuotes(value: string): string {
  const trimmed = String(value || '').trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== "'" && first !== '"') || first !== last) return trimmed;
  const inner = trimmed.slice(1, -1);
  if (first === "'") return inner.replace(/'\\''/g, "'").replace(/''/g, "'");
  return inner.replace(/\\"/g, '"').replace(/""/g, '"');
}

export function shellQuoteArg(value: string, shell: CliArgShell = 'posix'): string {
  const raw = stripOuterQuotes(String(value || ''));
  if (shell === 'powershell') return `'${raw.replace(/'/g, "''")}'`;
  if (shell === 'cmd') return `"${raw.replace(/"/g, '\\"')}"`;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function quoteFlagLine(line: string, shell: CliArgShell): string {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.startsWith('-')) return '';
  const eqIndex = trimmed.indexOf('=');
  const spaceIndex = trimmed.search(/\s/);
  if (eqIndex > 0 && (spaceIndex < 0 || eqIndex < spaceIndex)) {
    const flag = trimmed.slice(0, eqIndex);
    const value = trimmed.slice(eqIndex + 1).trim();
    return value ? `${flag}=${shellQuoteArg(value, shell)}` : flag;
  }
  if (spaceIndex > 0) {
    const flag = trimmed.slice(0, spaceIndex);
    const value = trimmed.slice(spaceIndex).trim();
    return value ? `${flag} ${shellQuoteArg(value, shell)}` : flag;
  }
  return trimmed;
}

export function normalizeCliFlagLines(value: unknown, shell: CliArgShell = 'posix'): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const line = String(value[i] || '').trim();
    if (!line || !line.startsWith('-')) continue;
    let item = quoteFlagLine(line, shell);
    const next = String(value[i + 1] || '').trim();
    if (!line.includes(' ') && !line.includes('=') && next && !next.startsWith('-')) {
      item = `${line} ${shellQuoteArg(next, shell)}`;
      i += 1;
    }
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
