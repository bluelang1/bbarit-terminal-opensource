/** PM2 process info from `pm2 jlist` output */
export interface Pm2Process {
  pm_id: number;
  name: string;
  status: 'online' | 'stopped' | 'errored' | 'launching' | string;
  cpu: number;
  memory: number; // bytes
  pid: number;
  restarts: number;
  uptime: number; // ms
}

/** Notification from Slack / GitHub / Linear */
export interface Pm2Notification {
  id: string;
  source: 'slack' | 'github' | 'linear';
  title: string;
  body: string;
  url?: string;
  timestamp: number;
  read: boolean;
  /** Extra metadata for reply actions */
  meta?: Record<string, string>;
}

/** Parse pm2 jlist JSON array into typed Pm2Process[] */
export function parsePm2List(raw: string): Pm2Process[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((p: any) => ({
      pm_id: p.pm_id ?? 0,
      name: p.name ?? 'unknown',
      status: p.pm2_env?.status ?? 'stopped',
      cpu: p.monit?.cpu ?? 0,
      memory: p.monit?.memory ?? 0,
      pid: p.pid ?? 0,
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
  } catch {
    return [];
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatUptime(ms: number): string {
  if (ms <= 0) return '-';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}
