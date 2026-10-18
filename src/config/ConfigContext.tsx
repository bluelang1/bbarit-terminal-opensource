/**
 * Phase 1.3: ConfigContext
 *
 * React Context for OctoConfig. Provides file-based settings
 * and hot-reloads on external edits via Tauri events.
 */

/* eslint-disable react-refresh/only-export-components */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  type OctoConfig,
  DEFAULT_CONFIG,
  validateConfig,
  migrateFromLocalStorage,
} from './schema';

interface ConfigContextValue {
  config: OctoConfig;
  updateConfig: (updater: (prev: OctoConfig) => OctoConfig) => void;
  /** Partial update: merge into config */
  patchConfig: (patch: Partial<OctoConfig>) => void;
  /** Config file path for display */
  configPath: string;
  /** Whether config has been loaded from disk */
  ready: boolean;
}

const ConfigContext = createContext<ConfigContextValue>({
  config: DEFAULT_CONFIG,
  updateConfig: () => {},
  patchConfig: () => {},
  configPath: '',
  ready: false,
});

export const useConfig = () => useContext(ConfigContext);

/**
 * Module-level config snapshot, kept in sync by ConfigProvider.
 * Allows non-hook code (getter functions, callbacks) to read config.
 */
let _configSnapshot: OctoConfig = DEFAULT_CONFIG;
export function getConfigSnapshot(): OctoConfig { return _configSnapshot; }

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<OctoConfig>(DEFAULT_CONFIG);
  const [configPath, setConfigPath] = useState('');
  const [ready, setReady] = useState(false);
  const skipNextWatchRef = useRef(false);

  // Keep module-level snapshot in sync (synchronous during render so
  // children can read it via getConfigSnapshot() in useState initializers)
  _configSnapshot = config;

  // Load config on mount
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!isTauri()) {
        if (!cancelled) {
          setConfig(DEFAULT_CONFIG);
          setReady(true);
        }
        return;
      }
      try {
        // Get config file path
        const path = await invoke<string>('get_config_path');
        if (!cancelled) setConfigPath(path);

        // Read config from file
        const json = await invoke<string>('read_config');
        const parsed = JSON.parse(json);

        if (!cancelled) {
          if (parsed && Object.keys(parsed).length > 0) {
            // Config file exists, validate and use it
            setConfig(validateConfig(parsed));
          } else {
            // No config file yet, migrate from localStorage
            const migrated = await migrateFromLocalStorage();
            setConfig(migrated);
            // Save migrated config to file
            skipNextWatchRef.current = true;
            await invoke('write_config', { json: JSON.stringify(migrated) });
          }
          setReady(true);
        }
      } catch (err) {
        console.error('[Config] Failed to load config:', err);
        // Fallback: try localStorage migration
        if (!cancelled) {
          setConfig(await migrateFromLocalStorage());
          setReady(true);
        }
      }
    };

    init();
    return () => { cancelled = true; };
  }, []);

  // Listen for external config changes (file watcher)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    if (!isTauri()) return undefined;

    listen<string>('config-changed', (event) => {
      if (skipNextWatchRef.current) {
        skipNextWatchRef.current = false;
        return;
      }
      try {
        const parsed = JSON.parse(event.payload);
        setConfig(validateConfig(parsed));
      } catch {
        // Invalid JSON in config file, ignore
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  // Save config to file with debouncing to avoid rapid successive writes
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConfigRef = useRef<OctoConfig | null>(null);

  const saveConfig = useCallback((newConfig: OctoConfig) => {
    if (!isTauri()) return;
    pendingConfigRef.current = newConfig;
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(async () => {
      saveDebounceRef.current = null;
      const toSave = pendingConfigRef.current;
      pendingConfigRef.current = null;
      if (!toSave) return;
      try {
        skipNextWatchRef.current = true;
        await invoke('write_config', { json: JSON.stringify(toSave) });
      } catch (err) {
        console.error('[Config] Failed to save config:', err);
      }
    }, 300);
  }, []);

  // Flush pending config write on unmount
  useEffect(() => {
    return () => {
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
      const toSave = pendingConfigRef.current;
      if (toSave && isTauri()) {
        pendingConfigRef.current = null;
        skipNextWatchRef.current = true;
        invoke('write_config', { json: JSON.stringify(toSave) }).catch(() => {});
      }
    };
  }, []);

  const updateConfig = useCallback((updater: (prev: OctoConfig) => OctoConfig) => {
    setConfig((prev) => {
      const next = updater(prev);
      saveConfig(next);
      return next;
    });
  }, [saveConfig]);

  const patchConfig = useCallback((patch: Partial<OctoConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
  }, [saveConfig]);

  return (
    <ConfigContext.Provider value={{ config, updateConfig, patchConfig, configPath, ready }}>
      {ready ? children : null}
    </ConfigContext.Provider>
  );
}
