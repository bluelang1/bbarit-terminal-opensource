import { memo, useEffect, useReducer, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from '../i18n';
import {
  DiskUsageStore,
  formatDiskAgo,
  formatDiskSize,
  isMeasurableDiskPath,
  type DiskUsageResult,
} from './statusDiskUsage';

// One store for the session: per-folder cache and at most one walk per folder.
const diskStore = new DiskUsageStore(
  (path) => invoke<DiskUsageResult>('project_disk_usage', { path }),
  (path) => {
    invoke('project_disk_usage_cancel', { path }).catch(() => {});
  },
);

// Self-contained CPU/MEM/DISK status readout. Owns its own polling and state so the
// per-second update re-renders ONLY this tiny component — when the stats lived
// in App-level state, CPU% changed every tick and the entire App tree was
// re-rendered once per second for the life of the window.
//
// DISK is the active project's folder size. It is NEVER polled (walking a large
// repo touches every file): measured once per folder per session, re-measured on click.
const StatusBarStats = memo(function StatusBarStats({ workDir }: { workDir: string | null }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<{ memory_mb: number; cpu_percent: number } | null>(null);
  const [, bumpDisk] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const poll = () => {
      invoke<{ memory_mb: number; cpu_percent: number }>('get_process_stats')
        .then((next) => {
          if (!disposed) setStats(next);
        })
        .catch(() => {});
    };

    const onVisibility = () => {
      const visible = !document.hidden;
      if (visible && !timer) {
        poll();
        timer = setInterval(poll, 1000);
      } else if (!visible && timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    poll();
    // "Realtime" enough for humans without being too noisy.
    timer = setInterval(poll, 1000);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => diskStore.subscribe(bumpDisk), []);

  // Measure once when the project folder changes (cached per folder); leaving a
  // folder mid-walk cancels that walk so it stops reading the disk.
  useEffect(() => {
    if (!isMeasurableDiskPath(workDir)) return;
    diskStore.request(workDir);
    return () => diskStore.cancel(workDir);
  }, [workDir]);

  const diskPath = isMeasurableDiskPath(workDir) ? workDir : null;
  const disk = diskPath ? diskStore.view(diskPath) : null;

  let diskText = '';
  let diskTitle = '';
  if (diskPath && disk) {
    const fill = (key: Parameters<typeof t>[0], vars: Record<string, string | number>) =>
      Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));
    const lines: string[] = [diskPath];
    if (disk.entry) {
      const e = disk.entry;
      diskText = formatDiskSize(e.bytes);
      lines.push(fill('statusBar.disk.size', { size: diskText, bytes: e.bytes.toLocaleString() }));
      lines.push(fill('statusBar.disk.files', { n: e.files.toLocaleString() }));
      if (e.skipped > 0) lines.push(fill('statusBar.disk.skipped', { n: e.skipped.toLocaleString() }));
      const ago = formatDiskAgo(Date.now() - e.measuredAt);
      const secs = (e.elapsedMs / 1000).toFixed(1);
      const agoKey = ago.unit === 'now' ? 'statusBar.disk.measuredNow' : ago.unit === 'min' ? 'statusBar.disk.measuredMin' : 'statusBar.disk.measuredHour';
      lines.push(fill(agoKey, { n: ago.n, secs }));
    } else if (disk.measuring) {
      diskText = '…';
    } else if (disk.error) {
      diskText = '?';
    }
    if (disk.measuring) lines.push(t('statusBar.disk.measuring'));
    if (disk.error && !disk.measuring) lines.push(fill('statusBar.disk.error', { error: disk.error }));
    lines.push(t('statusBar.disk.clickToRemeasure'));
    diskTitle = lines.join('\n');
  }

  const remeasure = () => {
    if (diskPath) diskStore.request(diskPath, { force: true });
  };

  return (
    <>
      {stats && (
        <>
          <span>CPU {stats.cpu_percent.toFixed(1)}%</span>
          <span style={{ marginLeft: 8 }}>MEM {stats.memory_mb.toFixed(0)} MB</span>
        </>
      )}
      {diskPath && diskText && (
        <span
          role="button"
          tabIndex={0}
          title={diskTitle}
          aria-label={diskTitle}
          aria-busy={disk?.measuring || undefined}
          onClick={remeasure}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              remeasure();
            }
          }}
          style={{
            marginLeft: 8,
            cursor: 'pointer',
            fontVariantNumeric: 'tabular-nums',
            display: 'inline-block',
            minWidth: '9ch',
            opacity: disk?.measuring && disk.entry ? 0.55 : undefined,
          }}
        >
          DISK {diskText}
        </span>
      )}
    </>
  );
});

export default StatusBarStats;
