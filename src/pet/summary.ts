// Claude state summary for the desktop pet (phase 2). Pure.
//
// The main window turns its per-tab agent status into rows, builds a compact summary
// with buildPetSummary and emits it to the pet window (`pet-summary`) when it changes.
// The pet page turns the summary into a mood for the behavior engine with moodFor.
// Design: docs/superpowers/specs/2026-11-06-desktop-pet-design.md ("Claude state feed").

export type PetTab = { terminalId: string; projectId: string; project: string; tab: string; since: number };

export type PetDoneEvent = { terminalId: string; turn: number; project: string; tab: string };

export type PetSummary = {
  /** Tabs waiting for the owner (approval / input), oldest first. */
  blocked: PetTab[];
  working: PetTab[];
  /** Finished turns nobody has looked at yet (badge only). */
  unseenDone: number;
  /** Set only on the emit for the moment a tab's turn finished (once per turn). */
  doneEvent?: PetDoneEvent;
};

export type PetSummaryRow = {
  terminalId: string;
  projectId: string;
  project: string;
  tab: string;
  state: 'working' | 'blocked' | 'done' | 'idle';
  turn: number;
  seenTurn: number;
  /** When the tab entered `state` (ms); orders blocked tabs. */
  since: number;
  /** Claude/Codex (any non-shell CLI) tab launched by BBARIT. */
  agentTab: boolean;
  /** The tab has an OSC 7501 status entry. */
  reported7501: boolean;
  /** Popped out into its own window (`term-detach-*`): not in the pet feed. */
  detached: boolean;
};

export type ClaudeMood = 'blocked' | 'happy' | 'busy' | 'none';

/** How long a finished turn keeps the pet happy. */
export const HAPPY_MS = 10_000;

function tabOf(r: PetSummaryRow): PetTab {
  return { terminalId: r.terminalId, projectId: r.projectId, project: r.project, tab: r.tab, since: r.since };
}

/**
 * Only tabs that reported OSC 7501 or are agent tabs count, so plain shell output (dev
 * servers, `tail -f`) never makes the pet busy. Popped-out tabs are left out.
 */
export function buildPetSummary(rows: PetSummaryRow[]): Omit<PetSummary, 'doneEvent'> {
  const blocked: PetTab[] = [];
  const working: PetTab[] = [];
  let unseenDone = 0;
  for (const r of rows) {
    if (r.detached || !(r.reported7501 || r.agentTab)) continue;
    if (r.state === 'blocked') blocked.push(tabOf(r));
    else if (r.state === 'working') working.push(tabOf(r));
    else if (r.state === 'done' && r.seenTurn < r.turn) unseenDone++;
  }
  const bySince = (a: PetTab, b: PetTab) => a.since - b.since;
  blocked.sort(bySince);
  working.sort(bySince);
  return { blocked, working, unseenDone };
}

function tabEquals(a: PetTab, b: PetTab): boolean {
  return (
    a.terminalId === b.terminalId &&
    a.projectId === b.projectId &&
    a.project === b.project &&
    a.tab === b.tab &&
    a.since === b.since
  );
}

function tabsEqual(a: PetTab[], b: PetTab[]): boolean {
  return a.length === b.length && a.every((t, i) => tabEquals(t, b[i]));
}

function doneEquals(a: PetDoneEvent | undefined, b: PetDoneEvent | undefined): boolean {
  if (!a || !b) return a === b;
  return a.terminalId === b.terminalId && a.turn === b.turn && a.project === b.project && a.tab === b.tab;
}

export function summaryEquals(a: PetSummary, b: PetSummary): boolean {
  return (
    a.unseenDone === b.unseenDone &&
    tabsEqual(a.blocked, b.blocked) &&
    tabsEqual(a.working, b.working) &&
    doneEquals(a.doneEvent, b.doneEvent)
  );
}

/** blocked > happy (HAPPY_MS after the last done) > busy (any working) > none. */
export function moodFor(summary: PetSummary, nowMs: number, lastDoneAtMs: number | null): ClaudeMood {
  if (summary.blocked.length > 0) return 'blocked';
  if (lastDoneAtMs !== null) {
    const age = nowMs - lastDoneAtMs;
    if (age >= 0 && age < HAPPY_MS) return 'happy';
  }
  if (summary.working.length > 0) return 'busy';
  return 'none';
}
