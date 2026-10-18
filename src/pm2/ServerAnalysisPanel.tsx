import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import {
  Activity,
  Boxes,
  Cpu,
  Database,
  FileText,
  HardDrive,
  Network,
  RadioTower,
  RefreshCw,
  ServerCog,
  ShieldAlert,
} from 'lucide-react';

interface Props {
  workDir: string;
  theme: { bg: string; text: string; border: string; accent: string };
  fontFamily: string;
  fontSize: number;
}

type ToolId =
  | 'overview'
  | 'health'
  | 'processes'
  | 'ports'
  | 'disk'
  | 'services'
  | 'docker'
  | 'logs'
  | 'security'
  | 'network';

const TOOLS: Array<{ id: ToolId; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'overview', label: 'Overview', icon: ServerCog },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'processes', label: 'Process', icon: Cpu },
  { id: 'ports', label: 'Ports', icon: RadioTower },
  { id: 'disk', label: 'Disk', icon: HardDrive },
  { id: 'services', label: 'Services', icon: Database },
  { id: 'docker', label: 'Docker', icon: Boxes },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'security', label: 'Security', icon: ShieldAlert },
  { id: 'network', label: 'Network', icon: Network },
];

function classifyLine(line: string): string {
  const lower = line.toLowerCase();
  if (line.startsWith('==')) return 'section';
  if (lower.includes('failed') || lower.includes('error') || lower.includes('critical') || lower.includes('denied')) return 'danger';
  if (lower.includes('warn') || lower.includes('unavailable') || lower.includes('refused')) return 'warn';
  if (/^\w+=/.test(line)) return 'kv';
  return '';
}

export const ServerAnalysisPanel: React.FC<Props> = ({ workDir, theme, fontFamily, fontSize }) => {
  const { t } = useTranslation();
  const [tool, setTool] = useState<ToolId>('health');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  const activeTool = useMemo(() => TOOLS.find((item) => item.id === tool) || TOOLS[0], [tool]);
  const ActiveIcon = activeTool.icon;

  const runTool = useCallback(async (nextTool = tool) => {
    setLoading(true);
    setError('');
    try {
      const result = await invoke<string>('server_analysis', { workDir, tool: nextTool });
      setOutput(String(result || '').trimEnd());
      setLastRunAt(Date.now());
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [tool, workDir]);

  useEffect(() => {
    void runTool(tool);
  }, [runTool, tool]);

  return (
    <div className="server-analysis" style={{ borderLeft: `1px solid ${theme.border}` }}>
      <div className="server-analysis-header">
        <div className="server-analysis-title">
          <ActiveIcon size={14} />
          <span>{activeTool.label}</span>
        </div>
        <button
          type="button"
          className="pm2-btn server-analysis-refresh"
          onClick={() => { void runTool(tool); }}
          disabled={loading}
          title={t('settings.common.refresh')}
          style={{ color: loading ? theme.accent : theme.text }}
        >
          <RefreshCw size={13} className={loading ? 'server-analysis-spin' : ''} />
        </button>
      </div>

      <div className="server-analysis-tools">
        {TOOLS.map((item) => {
          const Icon = item.icon;
          const selected = item.id === tool;
          return (
            <button
              key={item.id}
              type="button"
              className={`server-analysis-tool ${selected ? 'active' : ''}`}
              onClick={() => setTool(item.id)}
              title={item.label}
              style={{
                color: selected ? theme.accent : theme.text,
                borderColor: selected ? `${theme.accent}80` : undefined,
                background: selected ? `${theme.accent}18` : undefined,
              }}
            >
              <Icon size={13} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="server-analysis-error">{error}</div>
      )}

      <div
        className="server-analysis-output"
        style={{ fontFamily, fontSize: Math.max(10, fontSize - 2) }}
      >
        {!output && !error && (
          <div className="server-analysis-empty">{loading ? t('pm2.running') : t('pm2.noOutput')}</div>
        )}
        {output.split('\n').map((line, index) => (
          <div key={`${index}-${line.slice(0, 10)}`} className={`server-analysis-line ${classifyLine(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>

      <div className="server-analysis-footer">
        <span>{workDir.startsWith('ssh://') ? 'SSH' : 'LOCAL'}</span>
        <span>{lastRunAt ? new Date(lastRunAt).toLocaleTimeString() : '-'}</span>
      </div>
    </div>
  );
};
