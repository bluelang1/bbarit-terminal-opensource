import { memo, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Self-contained MEM/CPU status readout. Owns its own polling and state so the
// per-second update re-renders ONLY this tiny component — when the stats lived
// in App-level state, CPU% changed every tick and the entire App tree was
// re-rendered once per second for the life of the window.
const StatusBarStats = memo(function StatusBarStats() {
  const [stats, setStats] = useState<{ memory_mb: number; cpu_percent: number } | null>(null);

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

  if (!stats) return null;
  return (
    <>
      <span>MEM {stats.memory_mb.toFixed(0)} MB</span>
      <span style={{ marginLeft: 8 }}>CPU {stats.cpu_percent.toFixed(1)}%</span>
    </>
  );
});

export default StatusBarStats;
