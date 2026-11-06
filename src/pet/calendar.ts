// Calendar for the desktop pet: season by month and the special days it dresses up for.
// Pure; everything is the local date (the Mac's timezone) and a special day lasts all day.
//
// Seasons: spring 3-5, summer 6-8, autumn 9-11, winter 12-2.
// Special days: 11/11 Pepero, 2/14 Valentine's (chocolate), 3/14 White Day (candy),
// 10/31 Halloween, 12/24-12/25 Christmas. Treat days make the pet eat its treat.

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type SpecialDay = 'pepero' | 'valentine' | 'white' | 'halloween' | 'christmas';
export type PetCalendar = { season: Season; special: SpecialDay | null };
export type Treat = 'pepero' | 'chocolate' | 'candy';

/** localStorage key for the dev-only date override ('YYYY-MM-DD'). */
export const DEBUG_DATE_KEY = 'bbarit.pet.debugDate';

const SPECIAL_DAYS: Array<{ m: number; d: number; day: SpecialDay }> = [
  { m: 11, d: 11, day: 'pepero' },
  { m: 2, d: 14, day: 'valentine' },
  { m: 3, d: 14, day: 'white' },
  { m: 10, d: 31, day: 'halloween' },
  { m: 12, d: 24, day: 'christmas' },
  { m: 12, d: 25, day: 'christmas' },
];

function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

export function calendarFor(date: Date): PetCalendar {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const special = SPECIAL_DAYS.find((s) => s.m === m && s.d === d)?.day ?? null;
  return { season: seasonOf(m), special };
}

/** The treat the pet eats on `special`, null on days without one. */
export function treatFor(special: SpecialDay | null): Treat | null {
  if (special === 'pepero') return 'pepero';
  if (special === 'valentine') return 'chocolate';
  if (special === 'white') return 'candy';
  return null;
}

/**
 * The date the pet lives on: `now`, or in dev builds the valid local day `debugDate`
 * ('YYYY-MM-DD') at now's time of day. Malformed or impossible dates are ignored.
 */
export function petDate(now: Date, debugDate: string | null, isDev: boolean): Date {
  if (!isDev || !debugDate) return now;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(debugDate);
  if (!m) return now;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const out = new Date(y, mo - 1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) return now;
  return out;
}
