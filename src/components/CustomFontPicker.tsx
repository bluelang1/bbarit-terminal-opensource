import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import { cssFontFamilyName, rankSystemFonts } from '../theme';

// Session cache: font enumeration walks every installed family (font_kit).
let systemFontsCache: Promise<string[]> | null = null;
function loadSystemFonts(): Promise<string[]> {
  if (!systemFontsCache) {
    systemFontsCache = invoke<string[]>('list_system_fonts').catch(() => {
      systemFontsCache = null;
      return [];
    });
  }
  return systemFontsCache;
}

interface CustomFontPickerProps {
  value: string;
  onChange: (family: string) => void;
}

/**
 * Installed-font picker for the "Custom" font option. The text field doubles as
 * a search box and a free-form family name, so fonts the list misses still work.
 */
export function CustomFontPicker({ value, onChange }: CustomFontPickerProps) {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    void loadSystemFonts().then((list) => { if (alive) setFonts(list); });
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => rankSystemFonts(fonts || [], query).slice(0, 300), [fonts, query]);
  const family = value.trim();

  return (
    <div className="custom-font-picker">
      <input
        type="text"
        className="custom-font-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            onChange(shown.find((f) => f.toLowerCase() === query.trim().toLowerCase()) || query.trim());
            setQuery('');
          }
        }}
        placeholder={t('settings.common.searchFonts')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div className="custom-font-list" role="listbox">
        {fonts === null && <div className="custom-font-empty">{t('settings.common.loadingFonts')}</div>}
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={name === family}
            className={`custom-font-item ${name === family ? 'active' : ''}`}
            style={{ fontFamily: `${cssFontFamilyName(name)}, monospace` }}
            onClick={() => { onChange(name); setQuery(''); }}
          >
            {name}
          </button>
        ))}
        {fonts !== null && shown.length === 0 && query.trim() && (
          <button
            type="button"
            className="custom-font-item"
            onClick={() => { onChange(query.trim()); setQuery(''); }}
          >
            {`"${query.trim()}" ↵`}
          </button>
        )}
      </div>
      {family && (
        <div className="custom-font-preview" style={{ fontFamily: `${cssFontFamilyName(family)}, monospace` }}>
          {family} — 가나다 ABC 0O 1lI {'->'} {'  '}
        </div>
      )}
    </div>
  );
}
