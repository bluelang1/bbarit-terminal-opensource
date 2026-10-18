import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';

interface Props {
  workDir: string;
  theme: { bg: string; text: string; border: string; accent: string };
}

interface ServerStats {
  cpuCores: number;
  load: [number, number, number];
  memTotal: number;
  memUsed: number;
  memFree: number;
  memAvailable: number;
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  diskPercent: string;
  uptime: number;
}

function parseStats(raw: string): ServerStats | null {
  try {
    const lines = raw.trim().split('\n');
    const map: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1);
    }
    const cores = parseInt(map['CPU_CORES'] || '1') || 1;
    const loadParts = (map['LOAD'] || '0 0 0').split(/\s+/).map(Number);
    const memParts = (map['MEM'] || '0 0 0 0').split(/\s+/).map(Number);
    const diskParts = (map['DISK'] || '0 0 0 0%').split(/\s+/);
    return {
      cpuCores: cores,
      load: [loadParts[0] || 0, loadParts[1] || 0, loadParts[2] || 0],
      memTotal: memParts[0] || 0,
      memUsed: memParts[1] || 0,
      memFree: memParts[2] || 0,
      memAvailable: memParts[3] || memParts[2] || 0,
      diskTotal: Number(diskParts[0]) || 0,
      diskUsed: Number(diskParts[1]) || 0,
      diskFree: Number(diskParts[2]) || 0,
      diskPercent: diskParts[3] || '0%',
      uptime: parseFloat(map['UPTIME'] || '0') || 0,
    };
  } catch {
    return null;
  }
}

function formatBytes(b: number): string {
  if (b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(secs: number): string {
  if (secs <= 0) return '-';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const HISTORY_LEN = 40;

const SparkChart: React.FC<{
  data: number[];
  max: number;
  color: string;
  height: number;
  glowColor: string;
}> = ({ data, max, color, height, glowColor }) => {
  const w = 200;
  const safeMax = max || 1;
  const points = data.map((v, i) => {
    const x = (i / (HISTORY_LEN - 1)) * w;
    const y = height - 2 - (Math.min(v, safeMax) / safeMax) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const fillPoints = [`0,${height}`, ...points, `${w},${height}`].join(' ');
  const linePoints = points.join(' ');
  const gradId = `g-${color.replace(/[^a-z0-9]/gi, '')}`;
  const glowId = `glow-${color.replace(/[^a-z0-9]/gi, '')}`;
  const lastVal = data[data.length - 1] || 0;
  const lastX = w;
  const lastY = height - 2 - (Math.min(lastVal, safeMax) / safeMax) * (height - 6);

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {/* grid */}
      {[0.25, 0.5, 0.75].map(r => (
        <line key={r} x1="0" y1={height * (1 - r)} x2={w} y2={height * (1 - r)} stroke="white" strokeOpacity="0.04" strokeWidth="0.5" strokeDasharray="4 4" />
      ))}
      <polygon points={fillPoints} fill={`url(#${gradId})`} />
      <polyline points={linePoints} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" filter={`url(#${glowId})`} />
      {/* live dot */}
      <circle cx={lastX} cy={lastY} r="3" fill={color} opacity="0.9">
        <animate attributeName="r" values="3;5;3" dur="1.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.9;0.4;0.9" dur="1.5s" repeatCount="indefinite" />
      </circle>
      <circle cx={lastX} cy={lastY} r="8" fill={glowColor} opacity="0.15">
        <animate attributeName="r" values="8;14;8" dur="1.5s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="0.15;0.05;0.15" dur="1.5s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
};

const GaugeRing3D: React.FC<{
  percent: number;
  color: string;
  size: number;
  label: string;
  value: string;
  sub: string;
}> = ({ percent, color, size, label, value, sub }) => {
  const r = (size - 10) / 2;
  const c = Math.PI * 2 * r;
  const offset = c - (Math.min(percent, 100) / 100) * c;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
      perspective: '200px',
    }}>
      <div style={{
        position: 'relative', width: size, height: size,
        transform: 'rotateX(12deg)',
        transition: 'transform 0.3s',
      }}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', filter: `drop-shadow(0 0 8px ${color}40)` }}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="white" strokeOpacity="0.06" strokeWidth="6" />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
          {/* glow ring */}
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={color} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={offset}
            opacity="0.15"
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
        </svg>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{
            fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
            background: `linear-gradient(135deg, ${color}, white)`,
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
            {value}
          </span>
        </div>
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.6, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 9, opacity: 0.3 }}>{sub}</span>
    </div>
  );
};

export const ServerDashboard: React.FC<Props> = ({ workDir, theme }) => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [error, setError] = useState('');
  const [cpuHistory, setCpuHistory] = useState<number[]>(() => new Array(HISTORY_LEN).fill(0));
  const [memHistory, setMemHistory] = useState<number[]>(() => new Array(HISTORY_LEN).fill(0));
  const [tick, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const fetchStats = useCallback(async () => {
    try {
      const raw = await invoke<string>('server_stats', { workDir });
      const parsed = parseStats(raw);
      if (parsed) {
        setStats(parsed);
        setError('');
        const cpuPct = Math.min((parsed.load[0] / parsed.cpuCores) * 100, 100);
        const memPct = parsed.memTotal > 0 ? (parsed.memUsed / parsed.memTotal) * 100 : 0;
        setCpuHistory(prev => [...prev.slice(1), cpuPct]);
        setMemHistory(prev => [...prev.slice(1), memPct]);
        setTick(t => t + 1);
      }
    } catch (e: any) {
      setError(e?.message || t('pm2.failed'));
    }
  }, [workDir]);

  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(fetchStats, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchStats]);

  const s = stats;
  const cpuPct = s ? Math.min((s.load[0] / s.cpuCores) * 100, 100) : 0;
  const memPct = s && s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0;
  const diskPct = s && s.diskTotal > 0 ? (s.diskUsed / s.diskTotal) * 100 : 0;

  const cpuColor = cpuPct > 80 ? '#ef4444' : cpuPct > 50 ? '#f59e0b' : '#22c55e';
  const memColor = memPct > 85 ? '#ef4444' : memPct > 60 ? '#f59e0b' : '#3b82f6';
  const diskColor = diskPct > 90 ? '#ef4444' : diskPct > 70 ? '#f59e0b' : '#8b5cf6';

  return (
    <div style={{
      borderTop: `1px solid ${theme.border}20`, flexShrink: 0,
      background: `linear-gradient(180deg, ${theme.bg} 0%, ${theme.text}05 100%)`,
      position: 'relative', overflow: 'hidden',
    }}>
      <style>{`
        @keyframes scan-line {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(200%); }
        }
        @keyframes grid-pulse {
          0%, 100% { opacity: 0.03; }
          50% { opacity: 0.06; }
        }
      `}</style>

      {/* Scan line effect */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', left: 0, right: 0, height: '30%',
          background: `linear-gradient(transparent, ${theme.accent}08, transparent)`,
          animation: 'scan-line 4s linear infinite',
        }} />
      </div>

      {/* Grid background */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: `
          linear-gradient(${theme.text}06 1px, transparent 1px),
          linear-gradient(90deg, ${theme.text}06 1px, transparent 1px)
        `,
        backgroundSize: '20px 20px',
        animation: 'grid-pulse 3s ease-in-out infinite',
      }} />

      {!s && !error && (
        <div style={{ padding: 20, textAlign: 'center', opacity: 0.3, fontSize: 11 }}>
          {t('pm2.connectingServer')}
        </div>
      )}
      {error && !s && (
        <div style={{ padding: 12, fontSize: 11, color: '#ef4444', opacity: 0.6 }}>{error}</div>
      )}

      {s && (
        <div style={{ display: 'flex', position: 'relative', zIndex: 1 }}>
          {/* Gauges */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 16, padding: '16px 24px',
            borderRight: `1px solid ${theme.border}12`,
          }}>
            <GaugeRing3D percent={cpuPct} color={cpuColor} size={80} label={t('pm2.cpu')} value={`${Math.round(cpuPct)}%`} sub={t('pm2.coresCount').replace('{count}', String(s.cpuCores))} />
            <GaugeRing3D percent={memPct} color={memColor} size={80} label={t('pm2.memory')} value={`${Math.round(memPct)}%`} sub={formatBytes(s.memUsed)} />
            <GaugeRing3D percent={diskPct} color={diskColor} size={80} label={t('pm2.disk')} value={`${Math.round(diskPct)}%`} sub={formatBytes(s.diskUsed)} />
          </div>

          {/* Charts */}
          <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
            <div style={{ flex: 1, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2, borderRight: `1px solid ${theme.border}08` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase' }}>{t('pm2.cpuLoad')}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  color: cpuColor, textShadow: `0 0 8px ${cpuColor}60`,
                }}>
                  {s.load[0].toFixed(2)}
                </span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <SparkChart data={cpuHistory} max={100} color={cpuColor} height={80} glowColor={cpuColor} />
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                {(['1m', '5m', '15m'] as const).map((lbl, i) => (
                  <span key={lbl} style={{ fontSize: 9, opacity: 0.3, fontVariantNumeric: 'tabular-nums' }}>
                    {lbl}: {s.load[i].toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 700, opacity: 0.4, letterSpacing: 1, textTransform: 'uppercase' }}>{t('pm2.memory')}</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  color: memColor, textShadow: `0 0 8px ${memColor}60`,
                }}>
                  {t('pm2.memFreeValue').replace('{value}', formatBytes(s.memAvailable))}
                </span>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <SparkChart data={memHistory} max={100} color={memColor} height={80} glowColor={memColor} />
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                <span style={{ fontSize: 9, opacity: 0.3 }}>{t('pm2.total')}: {formatBytes(s.memTotal)}</span>
                <span style={{ fontSize: 9, opacity: 0.3 }}>{t('pm2.used')}: {formatBytes(s.memUsed)}</span>
                <span style={{ fontSize: 9, opacity: 0.3 }}>{t('pm2.free')}: {formatBytes(s.memFree)}</span>
              </div>
            </div>
          </div>

          {/* Info strip */}
          <div style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10,
            padding: '12px 20px', borderLeft: `1px solid ${theme.border}08`, minWidth: 120,
          }}>
            {[
              { label: t('pm2.uptime'), value: formatUptime(s.uptime), color: '#22c55e' },
              { label: t('pm2.diskFree'), value: formatBytes(s.diskFree), color: diskColor },
              { label: t('pm2.cores'), value: String(s.cpuCores), color: theme.accent },
            ].map(item => (
              <div key={item.label}>
                <div style={{ fontSize: 8, opacity: 0.25, letterSpacing: 1.5, textTransform: 'uppercase', fontWeight: 700 }}>{item.label}</div>
                <div style={{
                  fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                  color: item.color, textShadow: `0 0 10px ${item.color}30`,
                }}>
                  {item.value}
                </div>
              </div>
            ))}
            {/* Live indicator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%', background: '#22c55e',
                boxShadow: '0 0 6px #22c55e80',
                animation: 'pm2-pulse 1.5s ease-in-out infinite',
              }} />
              <span style={{ fontSize: 9, opacity: 0.3, fontWeight: 600, letterSpacing: 0.5 }}>LIVE #{tick}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
