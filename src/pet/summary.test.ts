import { describe, expect, it } from 'vitest';
import { buildPetSummary, moodFor, summaryEquals, type PetSummary, type PetSummaryRow } from './summary';

function row(over: Partial<PetSummaryRow> = {}): PetSummaryRow {
  return {
    terminalId: 't1',
    projectId: 'p1',
    project: 'Proj',
    tab: 'Claude',
    state: 'working',
    turn: 1,
    seenTurn: 0,
    since: 1000,
    agentTab: true,
    reported7501: true,
    detached: false,
    ...over,
  };
}

const EMPTY: PetSummary = { blocked: [], working: [], unseenDone: 0 };

describe('buildPetSummary', () => {
  it('excludes a plain shell tab busy with output (no 7501, not an agent tab)', () => {
    const s = buildPetSummary([row({ state: 'working', agentTab: false, reported7501: false })]);
    expect(s).toEqual(EMPTY);
  });

  it('counts a shell tab that reported 7501, and an agent tab without 7501', () => {
    const s = buildPetSummary([
      row({ terminalId: 'a', agentTab: false, reported7501: true }),
      row({ terminalId: 'b', agentTab: true, reported7501: false }),
    ]);
    expect(s.working.map((t) => t.terminalId)).toEqual(['a', 'b']);
  });

  it('excludes popped-out (detached) tabs', () => {
    const s = buildPetSummary([row({ state: 'blocked', detached: true }), row({ terminalId: 't2', detached: true })]);
    expect(s).toEqual(EMPTY);
  });

  it('sorts blocked tabs oldest first and keeps the tab fields', () => {
    const s = buildPetSummary([
      row({ terminalId: 'late', state: 'blocked', since: 5000, tab: 'B' }),
      row({ terminalId: 'early', state: 'blocked', since: 2000, tab: 'A' }),
    ]);
    expect(s.blocked).toEqual([
      { terminalId: 'early', projectId: 'p1', project: 'Proj', tab: 'A', since: 2000 },
      { terminalId: 'late', projectId: 'p1', project: 'Proj', tab: 'B', since: 5000 },
    ]);
    expect(s.working).toEqual([]);
  });

  it('counts done tabs whose turn is unseen; seen done and idle tabs count for nothing', () => {
    const s = buildPetSummary([
      row({ terminalId: 'u1', state: 'done', turn: 3, seenTurn: 2 }),
      row({ terminalId: 'u2', state: 'done', turn: 1, seenTurn: -1 }),
      row({ terminalId: 'seen', state: 'done', turn: 3, seenTurn: 3 }),
      row({ terminalId: 'idle', state: 'idle' }),
      row({ terminalId: 'shell', state: 'done', turn: 3, seenTurn: 0, agentTab: false, reported7501: false }),
    ]);
    expect(s).toEqual({ blocked: [], working: [], unseenDone: 2 });
  });
});

describe('moodFor', () => {
  const tab = { terminalId: 'x', projectId: 'p', project: 'P', tab: 'T', since: 0 };
  const busy: PetSummary = { blocked: [], working: [tab], unseenDone: 0 };
  const blocked: PetSummary = { blocked: [tab], working: [tab], unseenDone: 1 };

  it('blocked wins over everything', () => {
    expect(moodFor(blocked, 1000, 999)).toBe('blocked');
  });

  it('happy for 10 s after a done, then busy / none', () => {
    expect(moodFor(busy, 10_999, 1000)).toBe('happy');
    expect(moodFor(busy, 11_001, 1000)).toBe('busy');
    expect(moodFor(EMPTY, 10_999, 1000)).toBe('happy');
    expect(moodFor(EMPTY, 11_001, 1000)).toBe('none');
  });

  it('busy when any tab works, none otherwise; unseen done alone is not a mood', () => {
    expect(moodFor(busy, 5000, null)).toBe('busy');
    expect(moodFor({ ...EMPTY, unseenDone: 4 }, 5000, null)).toBe('none');
  });

  it('a done time in the future (clock skew) is not happy forever', () => {
    expect(moodFor(EMPTY, 1000, 50_000)).toBe('none');
  });
});

describe('summaryEquals', () => {
  const make = (): PetSummary => ({
    blocked: [{ terminalId: 'a', projectId: 'p', project: 'P', tab: 'T', since: 1 }],
    working: [{ terminalId: 'b', projectId: 'p', project: 'P', tab: 'U', since: 2 }],
    unseenDone: 1,
  });

  it('is true for equal content in new objects', () => {
    expect(summaryEquals(make(), make())).toBe(true);
    expect(summaryEquals(EMPTY, { blocked: [], working: [], unseenDone: 0 })).toBe(true);
  });

  it('is false when any field differs', () => {
    const b = make();
    b.blocked[0].tab = 'renamed';
    expect(summaryEquals(make(), b)).toBe(false);
    expect(summaryEquals(make(), { ...make(), unseenDone: 2 })).toBe(false);
    expect(summaryEquals(make(), { ...make(), working: [] })).toBe(false);
    expect(summaryEquals(make(), { ...make(), doneEvent: { terminalId: 'b', turn: 1, project: 'P', tab: 'U' } })).toBe(false);
  });
});
