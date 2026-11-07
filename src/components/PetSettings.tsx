// Settings group for the desktop pet (config.json `pet`). Rendered in the terminal tab of
// SettingsPanel. The pet window re-reads these values each time it is shown.
// Weather (pet.weather, off by default): turning it on asks for location permission
// (pet_location { ask: true }, after the 300 ms config save so the host sees it on); the
// status is polled while it is still settling. The city (Open-Meteo geocoding) is used when
// the location is not available.

import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useConfig } from '../config/ConfigContext';
import { normalizePetConfig, type PetConfig, type PetWeatherCity, type PetWeatherConfig } from '../config/schema';
import { useTranslation, type TranslationKey } from '../i18n';
import { characterOptions, type CharacterOption, type UserPackJson } from '../pet/page';
import type { LocationStatus, PetLocation } from '../pet/weather';

/** Wait for ConfigContext's debounced save before asking the host (it checks the config). */
const ASK_AFTER_SAVE_MS = 700;
const STATUS_POLL_MS = 2500;
const SETTLED: ReadonlySet<LocationStatus> = new Set<LocationStatus>(['ok', 'denied', 'unavailable']);

const STATUS_KEYS: Record<LocationStatus, TranslationKey> = {
  ok: 'settings.pet.weather.status.ok',
  pending: 'settings.pet.weather.status.pending',
  denied: 'settings.pet.weather.status.denied',
  unavailable: 'settings.pet.weather.status.unavailable',
  notAsked: 'settings.pet.weather.status.notAsked',
  off: 'settings.pet.weather.status.off',
};

function cityLabel(c: PetWeatherCity): string {
  return [c.name, c.admin1 && c.admin1 !== c.name ? c.admin1 : null, c.country].filter(Boolean).join(', ');
}

export function PetSettings() {
  const { config, updateConfig } = useConfig();
  const { t, locale } = useTranslation();
  const pet = normalizePetConfig(config.pet);
  const [options, setOptions] = useState<CharacterOption[]>(() => characterOptions([]));

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<UserPackJson[]>('pet_list_characters')
      .then((packs) => {
        if (!cancelled) setOptions(characterOptions(Array.isArray(packs) ? packs : []));
      })
      .catch((e) => console.warn('[pet] pet_list_characters failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  const update = <K extends keyof PetConfig>(key: K, value: PetConfig[K]) => {
    updateConfig((prev) => ({ ...prev, pet: { ...normalizePetConfig(prev.pet), [key]: value } }));
  };
  const updateWeather = (patch: Partial<PetWeatherConfig>) => {
    updateConfig((prev) => {
      const cur = normalizePetConfig(prev.pet);
      return { ...prev, pet: { ...cur, weather: { ...cur.weather, ...patch } } };
    });
  };

  // Location status, only while weather is on. The first check after turning it on asks.
  const [status, setStatus] = useState<LocationStatus | null>(null);
  const askRef = useRef(false);
  const weatherOn = pet.weather.enabled;
  useEffect(() => {
    if (!isTauri() || !weatherOn) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const check = () => {
      const ask = askRef.current;
      invoke<PetLocation>('pet_location', { ask })
        .then((loc) => {
          if (cancelled) return;
          // 'off': the config save has not landed yet; ask again on the next check.
          if (ask && loc.status !== 'off') askRef.current = false;
          setStatus(loc.status);
          if (!SETTLED.has(loc.status)) timer = window.setTimeout(check, STATUS_POLL_MS);
        })
        .catch((e) => console.warn('[pet] pet_location failed:', e));
    };
    timer = window.setTimeout(check, ASK_AFTER_SAVE_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [weatherOn]);

  const setWeatherOn = (on: boolean) => {
    // Turning weather on is when the owner is asked for location permission.
    askRef.current = on;
    updateWeather({ enabled: on });
  };
  const askAgain = () => {
    if (!isTauri()) return;
    invoke<PetLocation>('pet_location', { ask: true })
      .then((loc) => setStatus(loc.status))
      .catch((e) => console.warn('[pet] pet_location failed:', e));
  };

  // City search (an explicit owner action).
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PetWeatherCity[] | null>(null);
  const [searching, setSearching] = useState(false);
  const search = () => {
    if (!isTauri() || !query.trim()) return;
    setSearching(true);
    invoke<PetWeatherCity[]>('pet_weather_city_search', { query, language: locale })
      .then((cities) => setResults(Array.isArray(cities) ? cities : []))
      .catch((e) => {
        console.warn('[pet] city search failed:', e);
        setResults([]);
      })
      .finally(() => setSearching(false));
  };
  const chooseCity = (c: PetWeatherCity) => {
    updateWeather({ city: normalizePetConfig({ weather: { city: c } }).weather.city });
    setResults(null);
    setQuery('');
  };

  // Keep a configured pack that is missing or broken visible instead of silently switching.
  const selectOptions = options.some((o) => o.id === pet.character)
    ? options
    : [...options, { id: pet.character, name: pet.character, user: true }];

  return (
    <div className="settings-group">
      <h3>{t('settings.pet.title')}</h3>
      <div className="setting-item toggle">
        <label>{t('settings.pet.enabled')}</label>
        <input type="checkbox" checked={pet.enabled} onChange={(e) => update('enabled', e.target.checked)} />
        <span className="setting-description">{t('settings.pet.enabled.desc')}</span>
      </div>
      <div className="setting-item">
        <label>{t('settings.pet.character')}</label>
        <select value={pet.character} onChange={(e) => update('character', e.target.value)} disabled={!pet.enabled}>
          {selectOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.user ? `${o.name} ${t('settings.pet.character.user')}` : o.name}
            </option>
          ))}
        </select>
        <span className="setting-description">{t('settings.pet.character.desc')}</span>
      </div>
      <div className="setting-item">
        <label>{t('settings.pet.mode')}</label>
        <select
          value={pet.mode}
          onChange={(e) => update('mode', e.target.value === 'stay' ? 'stay' : 'walk')}
          disabled={!pet.enabled}
        >
          <option value="walk">{t('settings.pet.mode.walk')}</option>
          <option value="stay">{t('settings.pet.mode.stay')}</option>
        </select>
        <span className="setting-description">{t('settings.pet.mode.desc')}</span>
      </div>
      <div className="setting-item toggle">
        <label>{t('settings.pet.weather')}</label>
        <input
          type="checkbox"
          checked={pet.weather.enabled}
          onChange={(e) => setWeatherOn(e.target.checked)}
          disabled={!pet.enabled}
        />
        <span className="setting-description">{t('settings.pet.weather.desc')}</span>
      </div>
      {pet.weather.enabled && (
        <>
          <div className="setting-item">
            <label>{t('settings.pet.weather.status')}</label>
            <span>
              {t(STATUS_KEYS[status ?? 'pending'])}
              {(status === 'notAsked' || status === 'unavailable') && (
                <button type="button" className="btn-secondary" style={{ marginLeft: 8 }} onClick={askAgain}>
                  {t('settings.pet.weather.retry')}
                </button>
              )}
            </span>
          </div>
          <div className="setting-item">
            <label>{t('settings.pet.weather.city')}</label>
            <span>
              {pet.weather.city ? cityLabel(pet.weather.city) : t('settings.pet.weather.city.none')}
              {pet.weather.city && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ marginLeft: 8 }}
                  onClick={() => updateWeather({ city: null })}
                >
                  {t('settings.pet.weather.city.clear')}
                </button>
              )}
            </span>
            <span className="setting-description">{t('settings.pet.weather.city.desc')}</span>
            <form
              style={{ display: 'flex', gap: 6, marginTop: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                search();
              }}
            >
              <input
                type="text"
                value={query}
                maxLength={100}
                placeholder={t('settings.pet.weather.city.placeholder')}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="submit" className="btn-secondary" disabled={searching || !query.trim()}>
                {t('settings.pet.weather.city.search')}
              </button>
            </form>
            {results && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                {results.length === 0 && (
                  <span className="setting-description">{t('settings.pet.weather.city.noResults')}</span>
                )}
                {results.map((c) => (
                  <button
                    key={`${c.lat},${c.lon},${c.name}`}
                    type="button"
                    className="btn-secondary"
                    style={{ textAlign: 'left' }}
                    onClick={() => chooseCity(c)}
                  >
                    {cityLabel(c)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="setting-description">{t('settings.pet.weather.credit')}</span>
        </>
      )}
    </div>
  );
}
