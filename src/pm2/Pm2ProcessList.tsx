import React, { useState, useEffect, useCallback, useRef } from 'react';
import { pm2List, pm2Action } from './pm2Commands';
import { useTranslation } from '../i18n';
import { parsePm2List, formatBytes, formatUptime } from './types';
import type { Pm2Process } from './types';

interface Props {
  workDir: string;
  selectedApp: string | null;
  onSelectApp: (name: string) => void;
  theme: { bg: string; text: string; border: string; accent: string };
}


export const Pm2ProcessList: React.FC<Props> = ({ workDir, selectedApp, onSelectApp, theme }) => {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<Pm2Process[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const raw = await pm2List(workDir);
      setProcesses(parsePm2List(raw));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(refresh, 5000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [autoRefresh, refresh]);

  const handleAction = async (action: string, appName: string) => {
    try {
      await pm2Action(workDir, action, appName);
      setTimeout(refresh, 1000);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  return (
    <div className="pm2-process-list" style={{ borderRight: `1px solid ${theme.border}` }}>
      <div className="pm2-process-header">
        <span style={{ fontWeight: 600, fontSize: 12 }}>{t('pm2.processes')}</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            className="pm2-btn"
            onClick={refresh}
            disabled={loading}
            title={t('settings.common.refresh')}
            style={{ color: theme.text }}
          >
            ↻
          </button>
          <button
            className={`pm2-btn ${autoRefresh ? 'active' : ''}`}
            onClick={() => setAutoRefresh(p => !p)}
            title={autoRefresh ? t('pm2.autoRefreshOn') : t('pm2.autoRefreshOff')}
            style={{ color: autoRefresh ? theme.accent : theme.text, fontSize: 10 }}
          >
            {autoRefresh ? '⏱' : '⏸'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '6px 8px', fontSize: 11, color: '#f44336', wordBreak: 'break-all' }}>
          {error}
        </div>
      )}

      <div className="pm2-process-items">
        {processes.length === 0 && !loading && !error && (
          <div style={{ padding: '16px 8px', fontSize: 11, opacity: 0.5, textAlign: 'center' }}>
            {t('pm2.noProcesses')}
          </div>
        )}
        {processes.map(p => (
          <div
            key={p.pm_id}
            className={`pm2-process-item ${selectedApp === p.name ? 'selected' : ''}`}
            onClick={() => onSelectApp(p.name)}
            style={{
              background: selectedApp === p.name ? `${theme.accent}22` : 'transparent',
              borderLeft: selectedApp === p.name ? `2px solid ${theme.accent}` : '2px solid transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span className={`pm2-status-dot ${p.status}`} />
              <span style={{ fontWeight: 500, fontSize: 12, flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 10, opacity: 0.6 }}>#{p.pm_id}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 10, opacity: 0.7, paddingLeft: 14 }}>
              <span>{p.cpu.toFixed(1)}%</span>
              <span>{formatBytes(p.memory)}</span>
              <span>{p.status}</span>
              {p.restarts > 0 && <span style={{ color: '#ff9800' }}>↺{p.restarts}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, fontSize: 10, opacity: 0.5, paddingLeft: 14 }}>
              <span>pid:{p.pid}</span>
              <span>up:{formatUptime(p.uptime)}</span>
            </div>
            <div className="pm2-process-actions" onClick={e => e.stopPropagation()}>
              {p.status === 'online' ? (
                <>
                  <button className="pm2-action-btn" onClick={() => handleAction('restart', p.name)} title={t('pm2.restart')}>↻</button>
                  <button className="pm2-action-btn" onClick={() => handleAction('stop', p.name)} title={t('pm2.stop')}>■</button>
                </>
              ) : (
                <button className="pm2-action-btn" onClick={() => handleAction('start', p.name)} title={t('pm2.start')}>▶</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
