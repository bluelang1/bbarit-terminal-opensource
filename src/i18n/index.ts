import { useCallback } from 'react';
import { en, type TranslationKey } from './en';
import { ko } from './ko';
import { ja } from './ja';
import { zh } from './zh';
import { fr } from './fr';
import { de } from './de';
import { it } from './it';
import { es } from './es';
import { useConfig } from '../config/ConfigContext';

export type Locale = 'en' | 'ko' | 'ja' | 'zh' | 'fr' | 'de' | 'it' | 'es';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  ko: '한국어',
  ja: '日本語',
  zh: '中文',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  es: 'Español',
};

const translations: Record<Locale, Record<TranslationKey, string>> = {
  en, ko, ja, zh, fr, de, it, es,
};

/** React hook for translations — reads language from OctoConfig */
export function useTranslation() {
  const { config } = useConfig();
  const locale: Locale = (config.language as Locale) || 'en';

  const t = useCallback((key: TranslationKey, fallback?: string): string => {
    return translations[locale]?.[key] ?? translations.en[key] ?? fallback ?? key;
  }, [locale]);

  return { t, locale };
}

/** Non-hook getter for use outside React components */
export function getTranslation(locale: Locale, key: TranslationKey, fallback?: string): string {
  return translations[locale]?.[key] ?? translations.en[key] ?? fallback ?? key;
}

export type { TranslationKey };
