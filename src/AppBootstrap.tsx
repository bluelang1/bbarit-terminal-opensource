/**
 * AppBootstrap — DB 초기화 + localStorage → DB 마이그레이션을 수행한 뒤 앱을 렌더링.
 *
 * 1. SurrealDB 준비를 짧게 대기 (kv_ping). 빠르게 뜨면 마이그레이션 후 렌더.
 * 2. DB가 느리거나 사용 불가하면 앱을 막지 않고 localStorage fallback으로 바로 진입.
 *    (kvGet/kvSet은 자체 localStorage fallback이 있어 DB 없이도 동작한다.)
 * 3. 백그라운드에서 DB가 복구되면 조용히 마이그레이션한다.
 */

import { useState, useEffect, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { kvMigrateFromLocalStorage } from './hooks/useKV';

interface Props {
  children: ReactNode;
}

type BootState = 'loading' | 'migrating' | 'ready';

export function AppBootstrap({ children }: Props) {
  const [state, setState] = useState<BootState>('loading');
  const [message, setMessage] = useState('Initializing database...');
  const [detail, setDetail] = useState('Preparing local workspace data.');

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setState('ready');
      return () => { cancelled = true; };
    }
    // Safety net: a broken/hung DB must never keep the app on the loading screen.
    const bootDeadline = window.setTimeout(() => {
      if (cancelled) return;
      console.warn('[Bootstrap] DB startup deadline hit, entering app on localStorage fallback');
      setState('ready');
    }, 8000);

    const invokeWithTimeout = async (command: string, timeoutMs = 700) => {
      let timeoutId: number | null = null;
      try {
        return await Promise.race([
          invoke(command),
          new Promise((_, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error(`${command} timed out`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
      }
    };

    const pingOnce = async () => {
      try {
        await invokeWithTimeout('kv_ping');
        return true;
      } catch {
        return false;
      }
    };

    const migrateIfNeeded = async () => {
      if (localStorage.length === 0) return;
      try {
        const count = await kvMigrateFromLocalStorage();
        if (count > 0) console.log(`[Bootstrap] Migrated ${count} keys to DB`);
      } catch (err) {
        console.warn('[Bootstrap] Migration failed (non-fatal):', err);
      }
    };

    // Keep polling the DB after we've already entered the app, so a slow or
    // self-healing DB still gets its localStorage data migrated once it recovers.
    async function recoverInBackground() {
      for (let i = 0; i < 40; i++) {
        if (cancelled) return;
        if (await pingOnce()) {
          console.log('[Bootstrap] DB recovered in background');
          await migrateIfNeeded();
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    async function boot() {
      // Give the DB a short window to come up so the common fast path migrates
      // before the app reads settings. kv_ping returns immediately when the DB is
      // missing, so an unavailable DB falls through this loop in ~3s, not 10s.
      const fastPathRetries = 2;
      let dbReady = false;
      for (let i = 0; i < fastPathRetries; i++) {
        if (await pingOnce()) {
          dbReady = true;
          break;
        }
        if (cancelled) return;
        if (i === 2) {
          setMessage('Still starting database...');
          setDetail('Local settings are available if startup takes too long.');
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (cancelled) return;
      window.clearTimeout(bootDeadline);

      if (dbReady) {
        console.log('[Bootstrap] DB ready');
        if (localStorage.length > 0) {
          setState('migrating');
          setMessage('Migrating settings to database...');
          await migrateIfNeeded();
        }
        if (!cancelled) setState('ready');
        return;
      }

      // DB not ready — never block. Enter the app on the localStorage fallback and
      // let it migrate in the background if/when the DB recovers.
      console.warn('[Bootstrap] DB not ready, continuing on localStorage fallback');
      if (!cancelled) setState('ready');
      void recoverInBackground();
    }

    boot();
    return () => {
      cancelled = true;
      window.clearTimeout(bootDeadline);
    };
  }, []);

  if (state === 'ready') {
    return <>{children}</>;
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0f0f14',
      color: '#a9b1d6',
      fontFamily: 'monospace',
      gap: '16px',
      userSelect: 'none',
    }}>
        <>
          {/* Swimming octopus scene */}
          <div style={{ position: 'relative', width: '280px', height: '120px', overflow: 'hidden' }}>
            {/* Bubbles */}
            <div className="octo-bubble" style={{ left: '20%', animationDelay: '0s' }} />
            <div className="octo-bubble" style={{ left: '50%', animationDelay: '0.7s' }} />
            <div className="octo-bubble" style={{ left: '75%', animationDelay: '1.4s' }} />
            <div className="octo-bubble" style={{ left: '35%', animationDelay: '2.1s' }} />
            {/* BBARIT logo swimming across */}
            <img
              src="/icons/bbarit-logo.png"
              alt="BBARIT"
              style={{
                position: 'absolute',
                width: '48px',
                height: '48px',
                top: '30px',
                animation: 'octo-swim 3s ease-in-out infinite, octo-bob 1.2s ease-in-out infinite',
                filter: 'drop-shadow(0 0 12px rgba(122, 162, 247, 0.4))',
              }}
            />
            {/* Tentacle trail particles */}
            <div className="octo-particle" style={{ animationDelay: '0.15s' }} />
            <div className="octo-particle" style={{ animationDelay: '0.3s' }} />
            <div className="octo-particle" style={{ animationDelay: '0.45s' }} />
          </div>
          <div
            role="status"
            aria-live="polite"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              maxWidth: '360px',
              padding: '0 20px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '13px', opacity: 0.9, animation: 'octo-text-fade 2s ease-in-out infinite' }}>{message}</div>
            <div style={{ fontSize: '12px', lineHeight: 1.5, opacity: 0.68 }}>{detail}</div>
          </div>
          <div style={{
            width: '160px',
            height: '4px',
            background: '#1a1b2e',
            borderRadius: 'var(--brutal-radius)',
            overflow: 'hidden',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              width: '100%',
              height: '100%',
              background: 'linear-gradient(90deg, transparent, #7aa2f7, #bb9af7, #7aa2f7, transparent)',
              backgroundSize: '200% 100%',
              borderRadius: 'var(--brutal-radius)',
              animation: 'octo-wave 1.5s linear infinite',
            }} />
          </div>
          <style>{`
            @keyframes octo-swim {
              0% { left: -40px; }
              50% { left: 230px; }
              50.01% { left: 230px; transform: scaleX(-1); }
              100% { left: -40px; transform: scaleX(-1); }
            }
            @keyframes octo-bob {
              0%, 100% { transform: translateY(0) rotate(-5deg); }
              50% { transform: translateY(-8px) rotate(5deg); }
            }
            @keyframes octo-wave {
              0% { background-position: 200% 0; }
              100% { background-position: -200% 0; }
            }
            @keyframes octo-text-fade {
              0%, 100% { opacity: 0.6; }
              50% { opacity: 1; }
            }
            .octo-bubble {
              position: absolute;
              bottom: 0;
              width: 6px;
              height: 6px;
              border-radius: 50%;
              background: rgba(122, 162, 247, 0.3);
              animation: octo-bubble-rise 2.8s ease-in infinite;
            }
            @keyframes octo-bubble-rise {
              0% { transform: translateY(0) scale(0.4); opacity: 0; }
              20% { opacity: 0.6; }
              100% { transform: translateY(-110px) scale(1); opacity: 0; }
            }
            .octo-particle {
              position: absolute;
              width: 4px;
              height: 4px;
              border-radius: 50%;
              background: rgba(187, 154, 247, 0.5);
              top: 52px;
              animation: octo-swim 3s ease-in-out infinite, octo-particle-fade 0.8s ease-out infinite;
            }
            @keyframes octo-particle-fade {
              0% { opacity: 0.6; transform: scale(1); }
              100% { opacity: 0; transform: scale(0.2); }
            }
          `}</style>
        </>
    </div>
  );
}
