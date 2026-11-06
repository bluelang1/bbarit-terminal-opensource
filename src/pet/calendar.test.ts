import { describe, expect, it } from 'vitest';
import { calendarFor, petDate, treatFor, type PetCalendar } from './calendar';

/** Local date (the Mac's timezone), noon so DST shifts never move the day. */
function day(m: number, d: number, y = 2026, h = 12): Date {
  return new Date(y, m - 1, d, h, 0, 0);
}

function cal(m: number, d: number, y = 2026): PetCalendar {
  return calendarFor(day(m, d, y));
}

describe('calendarFor seasons', () => {
  it.each([
    [2, 28, 'winter'],
    [3, 1, 'spring'],
    [5, 31, 'spring'],
    [6, 1, 'summer'],
    [8, 31, 'summer'],
    [9, 1, 'autumn'],
    [11, 30, 'autumn'],
    [12, 1, 'winter'],
    [12, 31, 'winter'],
    [1, 1, 'winter'],
  ] as const)('%i/%i is %s', (m, d, season) => {
    expect(cal(m, d).season).toBe(season);
  });

  it('leap day is still winter', () => {
    expect(cal(2, 29, 2028).season).toBe('winter');
  });

  it('uses the local day at the edges of the day', () => {
    expect(calendarFor(day(3, 1, 2026, 0)).season).toBe('spring');
    expect(calendarFor(new Date(2026, 1, 28, 23, 59, 59)).season).toBe('winter');
  });
});

describe('calendarFor special days', () => {
  it.each([
    [11, 11, 'pepero', 'autumn'],
    [2, 14, 'valentine', 'winter'],
    [3, 14, 'white', 'spring'],
    [10, 31, 'halloween', 'autumn'],
    [12, 24, 'christmas', 'winter'],
    [12, 25, 'christmas', 'winter'],
  ] as const)('%i/%i is %s in %s', (m, d, special, season) => {
    expect(cal(m, d)).toEqual({ season, special });
  });

  it.each([
    [11, 10],
    [11, 12],
    [2, 13],
    [2, 15],
    [3, 13],
    [3, 15],
    [10, 30],
    [11, 1],
    [12, 23],
    [12, 26],
    [12, 31],
    [1, 1],
  ] as const)('%i/%i is an ordinary day', (m, d) => {
    expect(cal(m, d).special).toBeNull();
  });

  it('special days are all day long', () => {
    expect(calendarFor(day(11, 11, 2026, 0)).special).toBe('pepero');
    expect(calendarFor(new Date(2026, 10, 11, 23, 59, 59)).special).toBe('pepero');
    expect(calendarFor(new Date(2026, 10, 12, 0, 0, 0)).special).toBeNull();
  });

  it('ignores the year', () => {
    expect(cal(12, 25, 2031).special).toBe('christmas');
    expect(cal(2, 14, 2027).special).toBe('valentine');
  });
});

describe('treatFor', () => {
  it('maps eating days to their treat and the rest to none', () => {
    expect(treatFor('pepero')).toBe('pepero');
    expect(treatFor('valentine')).toBe('chocolate');
    expect(treatFor('white')).toBe('candy');
    expect(treatFor('halloween')).toBeNull();
    expect(treatFor('christmas')).toBeNull();
    expect(treatFor(null)).toBeNull();
  });
});

describe('petDate', () => {
  const now = new Date(2026, 10, 7, 15, 30, 0);

  it('returns now without a debug date', () => {
    expect(petDate(now, null, true)).toBe(now);
  });

  it('uses the debug date (local day, current time of day) in dev builds', () => {
    const d = petDate(now, '2026-12-25', true);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 12, 25]);
    expect([d.getHours(), d.getMinutes()]).toEqual([15, 30]);
    expect(calendarFor(d).special).toBe('christmas');
  });

  it('ignores the debug date in release builds', () => {
    expect(petDate(now, '2026-12-25', false)).toBe(now);
  });

  it.each(['', 'garbage', '2026-12', '2026-13-01', '2026-00-10', '2026-02-30', '2026-12-25x', ' 2026-12-25', '26-12-25', '2026/12/25'])(
    'ignores malformed debug date %j',
    (raw) => {
      expect(petDate(now, raw, true)).toBe(now);
    },
  );

  it('accepts a real leap day', () => {
    const d = petDate(now, '2028-02-29', true);
    expect([d.getMonth() + 1, d.getDate()]).toEqual([2, 29]);
  });
});
