/**
 * PakePanel.tsx
 *
 * Modal form for packaging a URL into a native desktop app using pake-cli.
 * Builds a `npx pake` command and sends it to the active terminal PTY.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Package, Play } from 'lucide-react';
import { kvGet, kvSet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
import './PakePanel.css';

const STORAGE_KEY = 'octo-pake-last-config';

export interface PakeConfig {
  url: string;
  name: string;
  icon: string;
  width: number;
  height: number;
  fullscreen: boolean;
  hideTitleBar: boolean;
  multiArch: boolean;
  debug: boolean;
}

const defaultConfig: PakeConfig = {
  url: '',
  name: '',
  icon: '',
  width: 1200,
  height: 780,
  fullscreen: false,
  hideTitleBar: false,
  multiArch: false,
  debug: false,
};

async function loadSavedConfig(): Promise<Partial<PakeConfig>> {
  try {
    const raw = await kvGet(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveConfig(cfg: PakeConfig) {
  void kvSet(STORAGE_KEY, JSON.stringify(cfg));
}

export function buildPakeCommand(cfg: PakeConfig): string {
  const parts = ['npx pake'];
  parts.push(`"${cfg.url}"`);
  if (cfg.name) parts.push(`--name "${cfg.name}"`);
  if (cfg.icon) parts.push(`--icon "${cfg.icon}"`);
  if (cfg.width !== 1200) parts.push(`--width ${cfg.width}`);
  if (cfg.height !== 780) parts.push(`--height ${cfg.height}`);
  if (cfg.fullscreen) parts.push('--fullscreen');
  if (cfg.hideTitleBar) parts.push('--hide-title-bar');
  if (cfg.multiArch) parts.push('--multi-arch');
  if (cfg.debug) parts.push('--debug');
  return parts.join(' ');
}

interface PakePanelProps {
  initialUrl?: string;
  style: { bg: string; text: string; accent: string };
  onBuild: (command: string) => void;
  onClose: () => void;
}

export function PakePanel({ initialUrl, style, onBuild, onClose }: PakePanelProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<PakeConfig>(() => ({
    ...defaultConfig,
    url: initialUrl || '',
  }));

  // Load saved config from KV on mount
  useEffect(() => {
    loadSavedConfig().then(saved => {
      setConfig(prev => ({
        ...defaultConfig,
        ...saved,
        url: initialUrl || saved.url || prev.url || '',
      }));
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialUrl) setConfig(prev => ({ ...prev, url: initialUrl }));
  }, [initialUrl]);

  const update = useCallback(<K extends keyof PakeConfig>(key: K, value: PakeConfig[K]) => {
    setConfig(prev => {
      const next = { ...prev, [key]: value };
      saveConfig(next);
      return next;
    });
  }, []);

  const command = useMemo(() => buildPakeCommand(config), [config]);

  const handleBuild = useCallback(() => {
    if (!config.url) return;
    saveConfig(config);
    onBuild(command);
    onClose();
  }, [config, command, onBuild, onClose]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const cssVars = {
    '--cp-bg': style.bg,
    '--cp-text': style.text,
    '--cp-accent': style.accent,
  } as React.CSSProperties;

  return (
    <div className="pake-overlay" onClick={handleOverlayClick} style={cssVars}>
      <div className="pake-panel">
        <div className="pake-header">
          <span className="pake-header-title">
            <Package size={16} />
            {t('pake.title')}
          </span>
          <button className="modal-close-btn" onClick={onClose} title="Close" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="pake-form">
          <div className="pake-field">
            <label>{t('pake.url')}</label>
            <input
              type="text"
              value={config.url}
              onChange={e => update('url', e.target.value)}
              placeholder="https://example.com"
              autoFocus
            />
          </div>

          <div className="pake-row">
            <div className="pake-field">
              <label>{t('pake.appName')}</label>
              <input
                type="text"
                value={config.name}
                onChange={e => update('name', e.target.value)}
                placeholder="MyApp"
              />
            </div>
            <div className="pake-field">
              <label>{t('pake.iconPath')}</label>
              <input
                type="text"
                value={config.icon}
                onChange={e => update('icon', e.target.value)}
                placeholder="/path/to/icon.icns"
              />
            </div>
          </div>

          <div className="pake-row">
            <div className="pake-field">
              <label>{t('pake.width')}</label>
              <input
                type="number"
                value={config.width}
                onChange={e => update('width', Number(e.target.value) || 1200)}
                min={400}
              />
            </div>
            <div className="pake-field">
              <label>{t('pake.height')}</label>
              <input
                type="number"
                value={config.height}
                onChange={e => update('height', Number(e.target.value) || 780)}
                min={300}
              />
            </div>
          </div>

          <div className="pake-checks">
            <label className="pake-check">
              <input type="checkbox" checked={config.fullscreen} onChange={e => update('fullscreen', e.target.checked)} />
              {t('pake.fullscreen')}
            </label>
            <label className="pake-check">
              <input type="checkbox" checked={config.hideTitleBar} onChange={e => update('hideTitleBar', e.target.checked)} />
              {t('pake.hideTitleBar')}
            </label>
            <label className="pake-check">
              <input type="checkbox" checked={config.multiArch} onChange={e => update('multiArch', e.target.checked)} />
              {t('pake.multiArch')}
            </label>
            <label className="pake-check">
              <input type="checkbox" checked={config.debug} onChange={e => update('debug', e.target.checked)} />
              {t('pake.debug')}
            </label>
          </div>

          <div className="pake-preview">
            <label>{t('pake.commandPreview')}</label>
            <div className="pake-preview-cmd">{command}</div>
          </div>
        </div>

        <div className="pake-footer">
          <button className="pake-cancel-btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="pake-build-btn" onClick={handleBuild} disabled={!config.url}>
            <Play size={14} />
            {t('pake.build')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PakePanel;
