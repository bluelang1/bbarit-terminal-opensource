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
  /** The most recently finished unseen tab (double-click opens it when nothing is blocked). */
  latestDone?: PetTab;
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
  let latestDone: PetTab | undefined;
  for (const r of rows) {
    if (!counts(r)) continue;
    if (r.state === 'blocked') blocked.push(tabOf(r));
    else if (r.state === 'working') working.push(tabOf(r));
    else if (r.state === 'done' && r.seenTurn < r.turn) {
      unseenDone++;
      if (!latestDone || r.since > latestDone.since) latestDone = tabOf(r);
    }
  }
  // Ties broken by id so the order (and summaryEquals) does not depend on row order.
  const bySince = (a: PetTab, b: PetTab) => a.since - b.since || (a.terminalId < b.terminalId ? -1 : a.terminalId > b.terminalId ? 1 : 0);
  blocked.sort(bySince);
  working.sort(bySince);
  return latestDone ? { blocked, working, unseenDone, latestDone } : { blocked, working, unseenDone };
}

function counts(r: Pick<PetSummaryRow, 'detached' | 'reported7501' | 'agentTab'>): boolean {
  return !r.detached && (r.reported7501 || r.agentTab);
}

/** A BBARIT-launched agent CLI tab (Claude, Codex, ...): any cliType but a plain shell. */
export function isAgentCli(cliType: string | undefined): boolean {
  return !!cliType && cliType !== 'shell';
}

/** What the main window remembers between summary builds. */
export type PetFeedMemory = {
  /** Per tab: the state it is in and since when (ms). */
  since: Map<string, { state: PetSummaryRow['state']; since: number }>;
  /** Per reporting tab: the last turn a done reaction was sent (or seeded) for; -1 none. */
  doneTurn: Map<string, number>;
};

export type PetFeedRow = Omit<PetSummaryRow, 'since'>;

export function newPetFeedMemory(): PetFeedMemory {
  return { since: new Map(), doneTurn: new Map() };
}

/**
 * One summary build: stamps `since` per tab, forgets closed tabs, and returns a
 * doneEvent the first time a 7501-reporting tab's turn shows up done and unseen. A tab
 * first seen already done (output replay at startup) seeds the memory without one.
 */
export function petFeedTick(
  mem: PetFeedMemory,
  rows: PetFeedRow[],
  nowMs: number,
): { summary: Omit<PetSummary, 'doneEvent'>; doneEvent?: PetDoneEvent } {
  const alive = new Set<string>();
  const full: PetSummaryRow[] = [];
  let doneEvent: PetDoneEvent | undefined;
  for (const r of rows) {
    alive.add(r.terminalId);
    const prev = mem.since.get(r.terminalId);
    const since = prev && prev.state === r.state ? prev.since : nowMs;
    if (!prev || prev.state !== r.state) mem.since.set(r.terminalId, { state: r.state, since });
    full.push({ ...r, since });

    if (!r.reported7501) continue;
    const unseenDone = r.state === 'done' && r.seenTurn < r.turn;
    const last = mem.doneTurn.get(r.terminalId);
    if (last === undefined) {
      mem.doneTurn.set(r.terminalId, unseenDone ? r.turn : -1);
    } else if (unseenDone && r.turn > last) {
      mem.doneTurn.set(r.terminalId, r.turn);
      if (!doneEvent && counts(r)) doneEvent = { terminalId: r.terminalId, turn: r.turn, project: r.project, tab: r.tab };
    }
  }
  for (const id of [...mem.since.keys()]) if (!alive.has(id)) mem.since.delete(id);
  for (const id of [...mem.doneTurn.keys()]) if (!alive.has(id)) mem.doneTurn.delete(id);
  const summary = buildPetSummary(full);
  return doneEvent ? { summary, doneEvent } : { summary };
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

function optTabEquals(a: PetTab | undefined, b: PetTab | undefined): boolean {
  return a && b ? tabEquals(a, b) : a === b;
}

export function summaryEquals(a: PetSummary, b: PetSummary): boolean {
  return (
    a.unseenDone === b.unseenDone &&
    optTabEquals(a.latestDone, b.latestDone) &&
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
