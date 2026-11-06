// Weather model for the desktop pet. Pure.
//
// The host (src-tauri/src/pet/weather.rs) reports Open-Meteo's `current` block
// (PetWeatherNow) and the Mac's location (PetLocation, already rounded to 0.1 degree).
// Here: WMO code -> what the pet shows, how real weather overrides the season particles,
// and the last result cached in localStorage. The feed that polls lives in weatherFeed.ts.

/** What the pet shows. Drizzle / rain / thunder bring the umbrella; snow its own flakes. */
export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'thunder' | 'snow';
export type PetWeather = { kind: WeatherKind; heavy: boolean; night: boolean };

/** `pet_weather_now` result (pet/weather.rs PetWeatherNow). */
export type PetWeatherNow = { code: number; precipitation: number; isDay: boolean; temperature: number | null };

/** `pet_location` status (pet/weather.rs LocationStatus). Anything but ok uses the city. */
export type LocationStatus = 'ok' | 'pending' | 'denied' | 'unavailable' | 'notAsked' | 'off';
export type PetLocation = { status: LocationStatus; lat: number | null; lon: number | null };

/** Precipitation (mm) from which rain / snow counts as heavy whatever the code says. */
export const HEAVY_PRECIP_MM = 2.5;
export const WEATHER_POLL_MS = 30 * 60_000;
/** A result older than this (offline) shows no weather at all. */
export const WEATHER_STALE_MS = 2 * 60 * 60_000;
export const WEATHER_CACHE_KEY = 'bbarit.pet.weather';

const KIND_BY_CODE: Record<number, WeatherKind> = {
  0: 'clear', 1: 'clear', 2: 'cloudy', 3: 'cloudy', 45: 'fog', 48: 'fog',
  51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
  61: 'rain', 63: 'rain', 65: 'rain', 66: 'rain', 67: 'rain', 80: 'rain', 81: 'rain', 82: 'rain',
  71: 'snow', 73: 'snow', 75: 'snow', 77: 'snow', 85: 'snow', 86: 'snow',
  95: 'thunder', 96: 'thunder', 99: 'thunder',
};
/** Dense / violent codes. */
const HEAVY_CODES = new Set([55, 57, 65, 67, 75, 82, 86, 99]);

/** WMO weather code -> what the pet shows; null for codes it does not know. */
export function weatherFromWmo(code: number, precipitation: number, isDay: boolean): PetWeather | null {
  const kind = Number.isInteger(code) ? KIND_BY_CODE[code] : undefined;
  if (!kind) return null;
  const wet = kind === 'drizzle' || kind === 'rain' || kind === 'thunder' || kind === 'snow';
  const heavy = wet && (HEAVY_CODES.has(code) || (Number.isFinite(precipitation) && precipitation >= HEAVY_PRECIP_MM));
  return { kind, heavy, night: isDay === false };
}

export function weatherFromNow(now: PetWeatherNow): PetWeather | null {
  return weatherFromWmo(now.code, now.precipitation, now.isDay);
}

/** Rain of any kind: drops, the umbrella, ripples and a puddle. */
export function rainy(w: PetWeather | null): boolean {
  return w !== null && (w.kind === 'drizzle' || w.kind === 'rain' || w.kind === 'thunder');
}

/**
 * Which season particles still fall (particles.ts spawnFor). Real weather wins when weather
 * is on and known: no seasonal snow at all (snow weather draws its own heavier flakes, a
 * clear winter day has none), and rain / snow also stop petals, leaves and heat shimmer.
 * Off or unknown (offline, no city): the season as before.
 */
export function seasonGate(weatherOn: boolean, w: PetWeather | null): { seasonSnow: boolean; seasonFalling: boolean } {
  if (!weatherOn || !w) return { seasonSnow: true, seasonFalling: true };
  return { seasonSnow: false, seasonFalling: !(rainy(w) || w.kind === 'snow') };
}

/** Last result, for the place it was fetched for (lat / lon as sent, rounded). */
export type WeatherCache = { at: number; lat: number; lon: number; now: PetWeatherNow };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function validNow(v: unknown): v is PetWeatherNow {
  const n = v as PetWeatherNow;
  return (
    !!n &&
    typeof n === 'object' &&
    Number.isFinite(n.code) &&
    Number.isFinite(n.precipitation) &&
    typeof n.isDay === 'boolean' &&
    (n.temperature === null || Number.isFinite(n.temperature))
  );
}

/** The cached result unless it is missing, broken or older than WEATHER_STALE_MS. */
export function loadWeatherCache(storage: Store | undefined, nowMs: number): WeatherCache | null {
  try {
    const raw = storage?.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as WeatherCache;
    if (!c || !Number.isFinite(c.at) || !Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !validNow(c.now)) return null;
    if (nowMs - c.at > WEATHER_STALE_MS || c.at - nowMs > WEATHER_STALE_MS) return null;
    return { at: c.at, lat: c.lat, lon: c.lon, now: c.now };
  } catch {
    return null;
  }
}

export function saveWeatherCache(storage: Store | undefined, c: WeatherCache): void {
  try {
    storage?.setItem(WEATHER_CACHE_KEY, JSON.stringify(c));
  } catch {
    // best effort
  }
}
