// Weather feed for the pet page: where the pet is (the Mac's location, else the owner's
// city) and the current weather there, polled every 30 min.
//
// The page calls tick() from its animation loop, which only runs while the pet is visible,
// so a hidden pet never polls and showing it again fetches once the last result is due.
// While pet.weather is off nothing is called at all (spec anti-goal). Location results
// arrive already rounded to 0.1 degree, and the host rounds whatever it sends again.

import type { PetWeatherConfig } from '../config/schema';
import {
  WEATHER_POLL_MS,
  WEATHER_STALE_MS,
  loadWeatherCache,
  saveWeatherCache,
  weatherFromNow,
  type PetLocation,
  type PetWeather,
  type PetWeatherNow,
  type WeatherCache,
} from './weather';

/** The location answer is not in yet (permission prompt, first fix): ask again this soon. */
export const PENDING_RETRY_MS = 20_000;
/** A failed weather request (offline) is retried this soon; the last result stays for 2 h. */
export const FAIL_RETRY_MS = 5 * 60_000;

export type FeedDeps = {
  /** pet_location { ask: false } (never shows the permission prompt). */
  locate: () => Promise<PetLocation>;
  /** pet_weather_now. */
  fetchNow: (lat: number, lon: number) => Promise<PetWeatherNow>;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
};

export type WeatherFeed = {
  /** Start a request when one is due (fire and forget; at most one in flight). */
  tick: (nowMs: number, cfg: PetWeatherConfig) => void;
  /** What to show now; null when off, unknown or older than 2 h. */
  current: (nowMs: number, cfg: PetWeatherConfig) => PetWeather | null;
  /** The last location answer (null before the first request). */
  location: () => PetLocation | null;
};

const UNAVAILABLE: PetLocation = { status: 'unavailable', lat: null, lon: null };

function cityKey(cfg: PetWeatherConfig): string {
  return cfg.city ? `${cfg.city.lat},${cfg.city.lon}` : '';
}

export function createWeatherFeed(deps: FeedDeps): WeatherFeed {
  let loaded = false;
  let cache: WeatherCache | null = null;
  let nextAt = 0;
  let busy = false;
  /** City the last tick used; a change refetches right away. Null after weather was off. */
  let key: string | null = null;
  /** Bumped when weather turns off, so a request still in flight does not reschedule. */
  let gen = 0;
  let loc: PetLocation | null = null;

  const load = (nowMs: number) => {
    if (loaded) return;
    loaded = true;
    cache = loadWeatherCache(deps.storage, nowMs);
    // Fresh enough from the last run (page reload): no request until it is due.
    if (cache) nextAt = cache.at + WEATHER_POLL_MS;
  };

  const run = async (nowMs: number, cfg: PetWeatherConfig, myGen: number) => {
    let l: PetLocation;
    try {
      l = (await deps.locate()) ?? UNAVAILABLE;
    } catch {
      l = UNAVAILABLE;
    }
    if (myGen !== gen) return;
    loc = l;
    const fromLocation = l.status === 'ok' && Number.isFinite(l.lat) && Number.isFinite(l.lon);
    const place = fromLocation ? { lat: l.lat as number, lon: l.lon as number } : cfg.city;
    const due = l.status === 'pending' ? PENDING_RETRY_MS : WEATHER_POLL_MS;
    if (!place) {
      // Nowhere to look (no location, no city): no weather layer.
      cache = null;
      nextAt = nowMs + due;
      return;
    }
    try {
      const now = await deps.fetchNow(place.lat, place.lon);
      if (myGen !== gen) return;
      cache = { at: nowMs, lat: place.lat, lon: place.lon, now };
      saveWeatherCache(deps.storage, cache);
      nextAt = nowMs + due;
    } catch {
      if (myGen === gen) nextAt = nowMs + FAIL_RETRY_MS;
    }
  };

  return {
    tick(nowMs, cfg) {
      load(nowMs);
      if (!cfg.enabled) {
        if (key !== null) gen++;
        key = null;
        nextAt = 0;
        return;
      }
      const k = cityKey(cfg);
      if (key !== null && key !== k) nextAt = 0;
      key = k;
      if (busy || nowMs < nextAt) return;
      busy = true;
      const myGen = gen;
      void run(nowMs, cfg, myGen).finally(() => {
        busy = false;
      });
    },
    current(nowMs, cfg) {
      if (!cfg.enabled) return null;
      load(nowMs);
      if (!cache || nowMs - cache.at > WEATHER_STALE_MS) return null;
      return weatherFromNow(cache.now);
    },
    location: () => loc,
  };
}
