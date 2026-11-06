import { describe, expect, it } from 'vitest';
import {
  HEAVY_PRECIP_MM,
  WEATHER_CACHE_KEY,
  WEATHER_STALE_MS,
  loadWeatherCache,
  rainy,
  saveWeatherCache,
  seasonGate,
  weatherFromNow,
  weatherFromWmo,
  type PetWeather,
  type WeatherCache,
} from './weather';

const w = (kind: PetWeather['kind'], heavy = false, night = false): PetWeather => ({ kind, heavy, night });

function memStorage(init: Record<string, string> = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('weatherFromWmo', () => {
  it('maps every WMO group', () => {
    const table: Array<[number, PetWeather['kind']]> = [
      [0, 'clear'], [1, 'clear'], [2, 'cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'],
      [51, 'drizzle'], [53, 'drizzle'], [55, 'drizzle'], [56, 'drizzle'], [57, 'drizzle'],
      [61, 'rain'], [63, 'rain'], [65, 'rain'], [66, 'rain'], [67, 'rain'], [80, 'rain'], [81, 'rain'], [82, 'rain'],
      [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'],
      [95, 'thunder'], [96, 'thunder'], [99, 'thunder'],
    ];
    for (const [code, kind] of table) expect(weatherFromWmo(code, 0, true)?.kind, `code ${code}`).toBe(kind);
  });

  it('heavy from the code or from the precipitation', () => {
    for (const code of [55, 57, 65, 67, 75, 82, 86, 99]) expect(weatherFromWmo(code, 0, true)?.heavy, `code ${code}`).toBe(true);
    for (const code of [51, 61, 63, 71, 73, 80, 95]) expect(weatherFromWmo(code, 0, true)?.heavy, `code ${code}`).toBe(false);
    expect(weatherFromWmo(63, HEAVY_PRECIP_MM, true)?.heavy).toBe(true);
    expect(weatherFromWmo(63, HEAVY_PRECIP_MM - 0.1, true)?.heavy).toBe(false);
    // Clear / cloudy / fog are never heavy, whatever the gauge says.
    expect(weatherFromWmo(3, 10, true)?.heavy).toBe(false);
  });

  it('night from is_day, unknown codes give no weather', () => {
    expect(weatherFromWmo(0, 0, false)).toEqual(w('clear', false, true));
    expect(weatherFromWmo(4, 0, true)).toBeNull();
    expect(weatherFromWmo(-1, 0, true)).toBeNull();
    expect(weatherFromWmo(Number.NaN, 0, true)).toBeNull();
    expect(weatherFromWmo(61, Number.NaN, true)).toEqual(w('rain'));
  });

  it('weatherFromNow reads the host payload', () => {
    expect(weatherFromNow({ code: 95, precipitation: 0.4, isDay: false, temperature: 18 })).toEqual(w('thunder', false, true));
  });
});

describe('rainy / seasonGate', () => {
  it('rainy: drizzle, rain and thunder only', () => {
    expect(['drizzle', 'rain', 'thunder'].every((k) => rainy(w(k as PetWeather['kind'])))).toBe(true);
    expect(['clear', 'cloudy', 'fog', 'snow'].some((k) => rainy(w(k as PetWeather['kind'])))).toBe(false);
    expect(rainy(null)).toBe(false);
  });

  it('real weather wins when weather is on and known', () => {
    // Off or unknown (offline, no city): the season as before.
    expect(seasonGate(false, w('snow'))).toEqual({ seasonSnow: true, seasonFalling: true });
    expect(seasonGate(true, null)).toEqual({ seasonSnow: true, seasonFalling: true });
    // Known: never seasonal snow (snow weather draws its own; clear winter has none).
    expect(seasonGate(true, w('clear'))).toEqual({ seasonSnow: false, seasonFalling: true });
    expect(seasonGate(true, w('fog'))).toEqual({ seasonSnow: false, seasonFalling: true });
    for (const k of ['drizzle', 'rain', 'thunder', 'snow'] as const) {
      expect(seasonGate(true, w(k)), k).toEqual({ seasonSnow: false, seasonFalling: false });
    }
  });
});

describe('weather cache', () => {
  const entry: WeatherCache = { at: 1_000_000, lat: 37.6, lon: 127, now: { code: 61, precipitation: 0.3, isDay: true, temperature: 9 } };

  it('round trips and drops stale or broken entries', () => {
    const s = memStorage();
    saveWeatherCache(s, entry);
    expect(JSON.parse(s.data[WEATHER_CACHE_KEY])).toEqual(entry);
    expect(loadWeatherCache(s, entry.at + 1000)).toEqual(entry);
    expect(loadWeatherCache(s, entry.at + WEATHER_STALE_MS + 1)).toBeNull();
    expect(loadWeatherCache(memStorage({ [WEATHER_CACHE_KEY]: '{' }), entry.at)).toBeNull();
    expect(loadWeatherCache(memStorage({ [WEATHER_CACHE_KEY]: JSON.stringify({ ...entry, now: { code: 'x' } }) }), entry.at)).toBeNull();
    expect(loadWeatherCache(undefined, entry.at)).toBeNull();
  });

  it('a throwing storage is ignored', () => {
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadWeatherCache(bad, 0)).toBeNull();
    expect(() => saveWeatherCache(bad, entry)).not.toThrow();
  });
});
