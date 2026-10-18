// Codex directory-trust seeding for broker harnesses.
//
// Why this exists: the OpenAI Codex interactive TUI shows a one-time "Do you trust the contents
// of this directory?" prompt the first time it launches in a directory it has not seen. Broker
// harnesses launch codex (as dev and/or reviewer) inside a FRESH git worktree under
// `<project>/.octo-tmp/broker-{wt,rev}-*`, which codex resolves to the project's repo root. If
// that root is not yet trusted, codex blocks on the trust prompt; the broker (which can't see the
// prompt) then throws the role briefing into it, codex quits back to a raw shell, and the briefing
// runs as shell commands ("리뷰어 대기 메시지가 안 뜸"). claude has no such prompt, so only the
// codex side broke. Seeding the trust entry up front = exactly what codex writes when the user
// clicks "Yes, continue", so codex launches straight into its input box.
//
// Codex persists trust in ~/.codex/config.toml as `[projects.'<key>'] trust_level = "trusted"`,
// where the key is the directory path LOWERCASED with backslash separators (Windows). The pure
// functions here compute that key and the idempotent config update; the IO lives in the caller.

/** Normalize a filesystem path to codex's config-key form: backslash separators, no trailing
 *  separator, lowercased — matching how codex stores `[projects.'c:\\path']` on Windows. */
export function codexTrustKey(dir: string): string {
  return String(dir || '')
    .trim()
    .replace(/[/\\]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** Already-trusted project keys present in a codex config.toml body (lowercased). */
export function existingCodexTrustKeys(config: string): Set<string> {
  const have = new Set<string>();
  const re = /\[projects\.(?:'([^']*)'|"([^"]*)")\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(config || '')))) {
    const key = (m[1] ?? m[2] ?? '').toLowerCase();
    if (key) have.add(key);
  }
  return have;
}

/** Idempotently ensure each dir has a `trust_level = "trusted"` project entry. Returns the
 *  (possibly unchanged) config body — never duplicates an existing entry, skips blank/dup inputs,
 *  and appends well-formed TOML sections for the missing ones. Pure: no IO. */
export function codexConfigWithTrust(existing: string, dirs: string[]): string {
  const base = typeof existing === 'string' ? existing : '';
  const have = existingCodexTrustKeys(base);
  const seen = new Set<string>();
  const additions: string[] = [];
  for (const d of Array.isArray(dirs) ? dirs : []) {
    const key = codexTrustKey(d);
    if (!key || have.has(key) || seen.has(key)) continue;
    seen.add(key);
    additions.push(`\n[projects.'${key}']\ntrust_level = "trusted"\n`);
  }
  if (!additions.length) return base;
  const sep = base.length && !base.endsWith('\n') ? '\n' : '';
  return base + sep + additions.join('');
}
