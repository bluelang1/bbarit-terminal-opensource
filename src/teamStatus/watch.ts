// Background read for the badges (toolbar gauge, project tabs): the board's teams and the
// task-based "needs you" items of each, while `enabled` (relay children exist or the Team
// status tab is open). Refreshes by createStatusPoller (no overlap, backs off on a slow
// board) and on `octo-agent-board` (debounced). The App re-renders only when a badge-relevant
// key (teams + item keys) changes; disabling clears the badges.
import { useEffect, useRef, useState } from 'react';
import { createStatusPoller } from '../git/statusPoll';
import { onAgentBoardChange } from '../terminal/agentBoard';
import { deriveTaskViews, needsYou, type NeedsYouItem } from './model';
import type { TeamBoardSource } from './source';

/** At most this many teams (most recently active first) are read for badges. */
export const WATCH_MAX_TEAMS = 12;
export const WATCH_EVENT_DEBOUNCE_MS = 500;

export interface TeamWatch {
  teams: string[];
  /** Task-based needs-you items per team (agent states are added by the caller). */
  needs: ReadonlyMap<string, NeedsYouItem[]>;
}

export const EMPTY_WATCH: TeamWatch = { teams: [], needs: new Map() };

export async function readTeamWatch(source: Pick<TeamBoardSource, 'teams' | 'tasks'>, now: number, staleMs: number): Promise<TeamWatch> {
  const rows = await source.teams();
  const teams = [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => (b.updatedTs || 0) - (a.updatedTs || 0))
    .slice(0, WATCH_MAX_TEAMS)
    .map((r) => r.team);
  const needs = new Map<string, NeedsYouItem[]>();
  const lists = await Promise.allSettled(teams.map((tm) => source.tasks(tm)));
  lists.forEach((r, i) => {
    if (r.status === 'fulfilled') needs.set(teams[i], needsYou(deriveTaskViews(r.value.tasks || [], now, staleMs), [], [], now));
  });
  return { teams, needs };
}

/** What a badge can show: the teams and each team's item keys. Equal keys → no re-render. */
export function watchKey(w: TeamWatch): string {
  return w.teams.map((tm) => `${tm}:${(w.needs.get(tm) || []).map((i) => i.key).join(',')}`).join('|');
}

export function useTeamWatch(source: TeamBoardSource, enabled: boolean, staleMs: number, pollMs = 15_000): TeamWatch {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const staleRef = useRef(staleMs);
  staleRef.current = staleMs;
  const [watch, setWatch] = useState<TeamWatch>(EMPTY_WATCH);
  const keyRef = useRef(watchKey(EMPTY_WATCH));
  useEffect(() => {
    if (!enabled) {
      // Turned off: drop the badges instead of freezing the last ones.
      if (keyRef.current !== watchKey(EMPTY_WATCH)) {
        keyRef.current = watchKey(EMPTY_WATCH);
        setWatch(EMPTY_WATCH);
      }
      return;
    }
    let alive = true;
    const poller = createStatusPoller(async () => {
      try {
        const w = await readTeamWatch(sourceRef.current, Date.now(), staleRef.current);
        const key = watchKey(w);
        if (alive && key !== keyRef.current) {
          keyRef.current = key;
          setWatch(w);
        }
      } catch { /* board unavailable: keep the last badges */ }
    }, { baseMs: pollMs });
    void poller.refresh();
    poller.start();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onAgentBoardChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void poller.refresh({ fresh: true }); }, WATCH_EVENT_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
      poller.stop();
    };
  }, [enabled, pollMs]);
  return watch;
}
