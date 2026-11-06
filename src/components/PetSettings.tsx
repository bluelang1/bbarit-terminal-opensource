// Settings group for the desktop pet (config.json `pet`). Rendered in the terminal tab of
// SettingsPanel. The pet window re-reads these values each time it is shown.

import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useConfig } from '../config/ConfigContext';
import { normalizePetConfig, type PetConfig } from '../config/schema';
import { useTranslation } from '../i18n';
import { characterOptions, type CharacterOption, type UserPackJson } from '../pet/page';

export function PetSettings() {
  const { config, updateConfig } = useConfig();
  const { t } = useTranslation();
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
    </div>
  );
}
