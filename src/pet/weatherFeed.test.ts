import { describe, expect, it, vi } from 'vitest';
import { FAIL_RETRY_MS, PENDING_RETRY_MS, createWeatherFeed, type FeedDeps } from './weatherFeed';
import { WEATHER_CACHE_KEY, WEATHER_POLL_MS, WEATHER_STALE_MS, type PetLocation, type PetWeatherNow } from './weather';
import type { PetWeatherConfig } from '../config/schema';

const RAIN: PetWeatherNow = { code: 63, precipitation: 0.8, isDay: true, temperature: 12 };
const SNOW: PetWeatherNow = { code: 73, precipitation: 0.2, isDay: false, temperature: -2 };
const SEOUL = { name: 'Seoul', lat: 37.566, lon: 126.978 };
const ON: PetWeatherConfig = { enabled: true, city: SEOUL };
const OFF: PetWeatherConfig = { enabled: false, city: SEOUL };

const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(loc: PetLocation | (() => PetLocation), now: PetWeatherNow | (() => Promise<PetWeatherNow>) = RAIN) {
  const data: Record<string, string> = {};
  const d = {
    locate: vi.fn(async () => (typeof loc === 'function' ? loc() : loc)),
    fetchNow: vi.fn(typeof now === 'function' ? now : async () => now),
    storage: {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    },
  } satisfies FeedDeps;
  return { d, data };
}

const LOC_OK: PetLocation = { status: 'ok', lat: 35.2, lon: 129.1 };
const DENIED: PetLocation = { status: 'denied', lat: null, lon: null };

describe('weather feed', () => {
  it('weather off: never asks for the location or the weather', async () => {
    const { d } = deps(LOC_OK);
    const feed = createWeatherFeed(d);
    for (let t = 0; t < 5 * WEATHER_POLL_MS; t += 60_000) feed.tick(t, OFF);
    await flush();
    expect(d.locate).not.toHaveBeenCalled();
    expect(d.fetchNow).not.toHaveBeenCalled();
    expect(feed.current(0, OFF)).toBeNull();
  });

  it('uses the location when it is available', async () => {
    const { d } = deps(LOC_OK);
    const feed = createWeatherFeed(d);
    feed.tick(1000, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledWith(35.2, 129.1);
    expect(feed.current(1000, ON)).toEqual({ kind: 'rain', heavy: false, night: false });
    expect(feed.location()?.status).toBe('ok');
  });

  it('denied / unavailable location: the city; no city: no weather and no fetch', async () => {
    const a = deps(DENIED);
    const feed = createWeatherFeed(a.d);
    feed.tick(0, ON);
    await flush();
    expect(a.d.fetchNow).toHaveBeenCalledWith(SEOUL.lat, SEOUL.lon);

    const b = deps({ status: 'unavailable', lat: null, lon: null });
    const none = createWeatherFeed(b.d);
    none.tick(0, { enabled: true, city: null });
    await flush();
    expect(b.d.fetchNow).not.toHaveBeenCalled();
    expect(none.current(0, { enabled: true, city: null })).toBeNull();
  });

  it('polls once per 30 min, one request at a time', async () => {
    const { d } = deps(LOC_OK);
    const feed = createWeatherFeed(d);
    feed.tick(0, ON);
    feed.tick(10, ON); // in flight: ignored
    await flush();
    for (let t = 1000; t < WEATHER_POLL_MS; t += 60_000) feed.tick(t, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledTimes(1);
    expect(d.locate).toHaveBeenCalledTimes(1);
    feed.tick(WEATHER_POLL_MS, ON);
    await flush();
    expect(d.locate).toHaveBeenCalledTimes(2);
    expect(d.fetchNow).toHaveBeenCalledTimes(2);
  });

  it('a pending location uses the city now and asks again soon', async () => {
    let loc: PetLocation = { status: 'pending', lat: null, lon: null };
    const { d } = deps(() => loc);
    const feed = createWeatherFeed(d);
    feed.tick(0, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenLastCalledWith(SEOUL.lat, SEOUL.lon);
    loc = LOC_OK;
    feed.tick(PENDING_RETRY_MS - 1, ON);
    await flush();
    expect(d.locate).toHaveBeenCalledTimes(1);
    feed.tick(PENDING_RETRY_MS, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenLastCalledWith(35.2, 129.1);
  });

  it('a failed fetch keeps the last result until it is 2 h old, and retries sooner', async () => {
    let fail = false;
    const { d } = deps(LOC_OK, async () => {
      if (fail) throw new Error('offline');
      return SNOW;
    });
    const feed = createWeatherFeed(d);
    feed.tick(0, ON);
    await flush();
    fail = true;
    feed.tick(WEATHER_POLL_MS, ON);
    await flush();
    expect(feed.current(WEATHER_POLL_MS, ON)?.kind).toBe('snow');
    feed.tick(WEATHER_POLL_MS + FAIL_RETRY_MS - 1, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledTimes(2);
    feed.tick(WEATHER_POLL_MS + FAIL_RETRY_MS, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledTimes(3);
    expect(feed.current(WEATHER_STALE_MS + 1, ON)).toBeNull();
  });

  it('starts from a fresh cached result without fetching; a changed city refetches', async () => {
    const { d, data } = deps(DENIED);
    data[WEATHER_CACHE_KEY] = JSON.stringify({ at: 0, lat: 37.6, lon: 127, now: SNOW });
    const feed = createWeatherFeed(d);
    expect(feed.current(1000, ON)?.kind).toBe('snow');
    feed.tick(1000, ON);
    await flush();
    expect(d.fetchNow).not.toHaveBeenCalled();
    const busan = { enabled: true, city: { name: 'Busan', lat: 35.18, lon: 129.08 } };
    feed.tick(2000, busan);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledWith(35.18, 129.08);
    expect(JSON.parse(data[WEATHER_CACHE_KEY]).now).toEqual(RAIN);
  });

  it('turning weather off and on again fetches right away', async () => {
    const { d } = deps(LOC_OK);
    const feed = createWeatherFeed(d);
    feed.tick(0, ON);
    await flush();
    feed.tick(1000, OFF);
    feed.tick(2000, ON);
    await flush();
    expect(d.fetchNow).toHaveBeenCalledTimes(2);
  });
});
