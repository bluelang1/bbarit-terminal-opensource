// Where the Team status view gets its data and sends a person's actions. App.tsx builds the
// real source over the Tauri commands (agent_board_teams / agent_task_list /
// agent_board_team_events / agent_board_read / agent_relay_log_refusals) and its internal
// viewer helpers (humanTaskAction, author "user"); tests pass a fake. A person's actions are
// not reachable through `agent.*` UI commands. That is not a security boundary: `bbarit-ctl js`
// / the mcp-bridge already has full control of the main window.
import { useEffect, useRef, useState } from 'react';
import { onAgentBoardChange } from '../terminal/agentBoard';
import type { BoardTask } from '../terminal/agentTasks';
import { createStatusPoller } from '../git/statusPoll';
import type { FeedEvent, FeedPost, Refusal } from './model';

export interface BoardTeam {
  team: string;
  teamName?: string;
  updatedTs?: number;
  liveTasks?: number;
  homeHost?: string;
}

export interface BoardInfo {
  host?: string;
  backend?: string;
  mode?: string;
}

/** A person's task action (viewer spec): never claim, block, release or finish. */
export type HumanTaskSub = 'add' | 'edit' | 'cancel' | 'reopen' | 'retry' | 'approve' | 'reject';

export type ActionResult = { ok: true } | { ok: false; error: string };

export interface TeamBoardSource {
  info(): Promise<BoardInfo>;
  teams(): Promise<BoardTeam[]>;
  /** Every task of the team (done and cancelled too), with dependencies. */
  tasks(team: string): Promise<{ tasks: BoardTask[]; teamName?: string }>;
  /** The newest task events of the whole team, oldest first. */
  events(team: string): Promise<FeedEvent[]>;
  /** The newest notes of the team. */
  posts(team: string): Promise<FeedPost[]>;
  /** One task's full event history, oldest first (agent_task_show --history). */
  history(team: string, seq: number): Promise<FeedEvent[]>;
  /** Recent `agent run` limit refusals (relay log; never message text). */
  refusals(): Promise<Refusal[]>;
  act(team: string, sub: HumanTaskSub, request: Record<string, unknown>): Promise<ActionResult>;
  postNote(team: string, text: string): Promise<ActionResult>;
}

export interface TeamSnapshot {
  team: string;
  teamName?: string;
  tasks: BoardTask[];
  events: FeedEvent[];
  posts: FeedPost[];
  /** When it was read (ms). */
  at: number;
}

export interface TeamBoardState {
  teams: BoardTeam[];
  info: BoardInfo | null;
  snapshot: TeamSnapshot | null;
  refusals: Refusal[];
  /** "team board unavailable: …" from the last read; the last snapshot stays (greyed). */
  error: string | null;
  /** True until the first read of this team finished. */
  loading: boolean;
}

/** Board error text as the banner shows it (without the "team board unavailable:" prefix). */
export function boardReason(e: unknown): string {
  const text = String(e instanceof Error ? e.message : e ?? '').trim() || 'unknown error';
  return text.replace(/^team board unavailable:\s*/i, '');
}

/** One read of everything the view needs. Team-list and refusal errors do not hide the team. */
export async function loadTeamBoard(source: TeamBoardSource, team: string, now: () => number): Promise<{ teams: BoardTeam[]; info: BoardInfo | null; refusals: Refusal[]; snapshot: TeamSnapshot | null; error: string | null }> {
  const [teamsR, infoR, refR] = await Promise.allSettled([source.teams(), source.info(), source.refusals()]);
  const teams = teamsR.status === 'fulfilled' && Array.isArray(teamsR.value) ? teamsR.value : [];
  const info = infoR.status === 'fulfilled' ? infoR.value : null;
  const refusals = refR.status === 'fulfilled' && Array.isArray(refR.value) ? refR.value : [];
  let error: string | null = teamsR.status === 'rejected' ? boardReason(teamsR.reason) : null;
  // Read a team only once the board lists it (a remembered team id must not make the store
  // open, and so create, a board file that does not exist yet).
  if (!team || (teamsR.status === 'fulfilled' && !teams.some((x) => x.team === team))) return { teams, info, refusals, snapshot: null, error };
  try {
    const [tasks, events, posts] = await Promise.all([source.tasks(team), source.events(team), source.posts(team)]);
    return {
      teams,
      info,
      refusals,
      snapshot: { team, teamName: tasks.teamName, tasks: tasks.tasks || [], events: events || [], posts: posts || [], at: now() },
      error,
    };
  } catch (e) {
    error = boardReason(e);
    return { teams, info, refusals, snapshot: null, error };
  }
}

/**
 * Live board data for one team: read on open and on team change, again on every
 * `octo-agent-board` event for that team (local writes), and by a slow poll for writes from
 * other machines (createStatusPoller: never overlapping, backs off on a slow board).
 * The effect is keyed on the team id string; the source lives in a ref.
 */
export function useTeamBoard(source: TeamBoardSource, team: string, opts: { pollMs?: number; now?: () => number } = {}): TeamBoardState & { refresh: () => void } {
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const nowRef = useRef(opts.now ?? Date.now);
  nowRef.current = opts.now ?? Date.now;
  const [state, setState] = useState<TeamBoardState>({ teams: [], info: null, snapshot: null, refusals: [], error: null, loading: true });
  const pollerRef = useRef<{ refresh: (o?: { fresh?: boolean }) => Promise<void> } | null>(null);
  const pollMs = opts.pollMs ?? 10_000;

  useEffect(() => {
    let alive = true;
    // A new team starts from scratch: no snapshot of another team is ever shown.
    setState((s) => ({ ...s, snapshot: s.snapshot?.team === team ? s.snapshot : null, loading: true, error: null }));
    const run = async () => {
      const r = await loadTeamBoard(sourceRef.current, team, () => nowRef.current());
      if (!alive) return;
      setState((s) => ({
        teams: r.teams.length || !r.error ? r.teams : s.teams,
        info: r.info ?? s.info,
        refusals: r.refusals,
        // Keep the last snapshot of this team when the board is unavailable.
        snapshot: r.snapshot ?? (s.snapshot?.team === team ? s.snapshot : null),
        error: r.error,
        loading: false,
      }));
    };
    const poller = createStatusPoller(run, { baseMs: pollMs });
    pollerRef.current = poller;
    void poller.refresh();
    poller.start();
    const off = onAgentBoardChange((d) => {
      if (!team || d.team === team) void poller.refresh({ fresh: true });
    });
    return () => {
      alive = false;
      off();
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [team, pollMs]);

  return { ...state, refresh: () => { void pollerRef.current?.refresh({ fresh: true }); } };
}
