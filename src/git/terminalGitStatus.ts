/**
 * Terminal footer git status: one `git status` per distinct repo, shared by
 * every terminal tab in it. Before this, 24 tabs on one huge repo ran 24
 * concurrent `git status` calls on it every refresh.
 */

export interface TerminalWorkDir {
  terminalId: string;
  workDir: string;
}

/**
 * Fetch each distinct (trimmed) workDir once and fan the result out to every
 * terminal in it, in input order. Empty or skipped dirs (e.g. SSH paths) get
 * null without a fetch. `fetchStatus` handles its own errors.
 */
export async function fetchStatusesByRepo<S>(
  items: TerminalWorkDir[],
  fetchStatus: (repoDir: string) => Promise<S>,
  skip: (repoDir: string) => boolean = () => false,
): Promise<Array<[string, S | null]>> {
  const dirOf = (item: TerminalWorkDir) => {
    const dir = (item.workDir || '').trim();
    return dir && !skip(dir) ? dir : '';
  };
  const repoDirs = [...new Set(items.map(dirOf).filter(Boolean))];
  const results = new Map(
    await Promise.all(repoDirs.map(async dir => [dir, await fetchStatus(dir)] as const)),
  );
  return items.map(item => {
    const dir = dirOf(item);
    return [item.terminalId, dir ? (results.get(dir) as S) : null];
  });
}

/**
 * Wrap `fn` so a call for a key that is still running shares that call
 * instead of starting another one (e.g. across a footer refresh restart).
 */
export function shareInFlight<V>(fn: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const inFlight = new Map<string, Promise<V>>();
  return (key: string) => {
    const running = inFlight.get(key);
    if (running) return running;
    const p = fn(key).finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
  };
}
