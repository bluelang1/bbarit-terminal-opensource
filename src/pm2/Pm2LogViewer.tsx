import React, { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from 'xterm';
import { kvGet } from '../hooks/useKV';
import { useTranslation } from '../i18n';
// 구형 xterm(5.3) 코어와 짝 맞는 구형 애드온 사용 (XTerminal.tsx 주석 참조)
import { WebglAddon } from 'xterm-addon-webgl';
import { FitAddon } from '@xterm/addon-fit';

interface HttpResponseOutput {
  status: number;
  body: string;
}

interface ParsedSsh {
  username: string;
  host: string;
  port: number;
  identityFile?: string;
  basePath: string;
}

function parseSshWorkDir(value: string): ParsedSsh | null {
  const raw = String(value || '').trim();
  if (!raw.startsWith('ssh://')) return null;
  const body = raw.slice('ssh://'.length);
  const sep = body.indexOf('::');
  if (sep < 0) return null;

  const meta = body.slice(0, sep).trim();
  const basePathRaw = body.slice(sep + 2).trim();
  const keyIndex = meta.indexOf(';key=');
  const main = keyIndex >= 0 ? meta.slice(0, keyIndex) : meta;
  const keyToken = keyIndex >= 0 ? meta.slice(keyIndex + ';key='.length) : '';

  const at = main.lastIndexOf('@');
  if (at < 1) return null;
  const username = main.slice(0, at).trim();
  const hostPort = main.slice(at + 1).trim();
  if (!username || !hostPort) return null;

  const colon = hostPort.lastIndexOf(':');
  let host = hostPort;
  let port = 22;
  if (colon > 0) {
    const maybePort = parseInt(hostPort.slice(colon + 1), 10);
    if (Number.isFinite(maybePort) && maybePort > 0) {
      host = hostPort.slice(0, colon).trim();
      port = maybePort;
    }
  }
  if (!host) return null;

  let basePath = basePathRaw || '~';
  if (!basePath.startsWith('/') && !basePath.startsWith('~')) basePath = `/${basePath}`;
  if (basePath.length > 1 && basePath.endsWith('/')) basePath = basePath.replace(/\/+$/g, '');

  // Decode identity file from base64url
  let identityFile: string | undefined;
  if (keyToken) {
    try {
      const normalized = keyToken.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (normalized.length % 4)) % 4;
      const padded = normalized + '='.repeat(padLen);
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      identityFile = new TextDecoder().decode(bytes).trim() || undefined;
    } catch {}
  }
  return { username, host, port, identityFile, basePath };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build SSH command to run pm2 logs on remote server */
function buildSshLogCommand(workDir: string, appName: string | null): string | null {
  const info = parseSshWorkDir(workDir);
  if (!info) return null;

  const appPart = appName ? ` ${shellQuote(appName)}` : '';
  const remoteScript = `cd ${shellQuote(info.basePath)} 2>/dev/null; pm2 logs${appPart} --lines 200 --raw`;

  const sshOptions = [
    '-t',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-p', String(info.port),
    ...(info.identityFile ? ['-i', info.identityFile] : []),
  ];

  return [
    'ssh',
    ...sshOptions.map(a => shellQuote(a)),
    shellQuote(`${info.username}@${info.host}`),
    shellQuote(remoteScript),
  ].join(' ');
}

interface AnomalyAlert {
  id: number;
  level: 'warning' | 'critical';
  message: string;
  timestamp: number;
  logSnippet: string;
}

interface Props {
  workDir: string;
  appName: string | null;
  theme: { bg: string; text: string; border: string; accent: string };
  fontFamily: string;
  fontSize: number;
}

/** Strip ANSI escape codes from terminal output */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Ask Ollama to analyze log chunk for anomalies */
async function analyzeWithOllama(
  logChunk: string,
  model: string,
  ollamaUrl: string,
): Promise<{ hasAnomaly: boolean; level: 'warning' | 'critical'; message: string } | null> {
  try {
    const prompt = `You are a server log anomaly detector. Analyze the following PM2 process logs and determine if there are any anomalies, errors, or concerning patterns.

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no explanation):
{"anomaly": false}
or
{"anomaly": true, "level": "warning", "message": "brief description in Korean"}
or
{"anomaly": true, "level": "critical", "message": "brief description in Korean"}

Rules:
- "critical": crashes, OOM, unhandled exceptions, connection refused, data corruption
- "warning": high latency, deprecated APIs, retry storms, unusual patterns
- Normal info/debug logs = no anomaly
- Keep message under 80 chars, in Korean

Logs:
${logChunk.slice(-2000)}`;

    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'POST',
        url: `${ollamaUrl}/api/generate`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 150 },
        }),
        timeout_ms: 15000,
      },
    });

    if (!resp || resp.status >= 400) return null;
    const data = JSON.parse(resp.body);
    const text = (data.response || '').trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.anomaly) {
      return {
        hasAnomaly: true,
        level: parsed.level === 'critical' ? 'critical' : 'warning',
        message: parsed.message || '이상 감지됨',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const Pm2LogViewer: React.FC<Props> = ({ workDir, appName, theme, fontFamily, fontSize }) => {
  const { t } = useTranslation();
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const ptyIdRef = useRef<string | null>(null);
  const readLoopRef = useRef<boolean>(false);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'streaming'>('idle');
  const [viewAll, setViewAll] = useState(false);

  // Use refs to avoid re-creating startLogStream on every render
  const themeRef = useRef(theme);
  const fontFamilyRef = useRef(fontFamily);
  const fontSizeRef = useRef(fontSize);
  themeRef.current = theme;
  fontFamilyRef.current = fontFamily;
  fontSizeRef.current = fontSize;

  // Ollama anomaly detection
  const [aiWatch, setAiWatch] = useState(false);
  const [alerts, setAlerts] = useState<AnomalyAlert[]>([]);
  const logBufferRef = useRef<string>('');
  const alertIdRef = useRef(0);
  const analyzeTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const analyzingRef = useRef(false);

  const [ollamaUrl, setOllamaUrl] = useState('http://localhost:11434');
  const [ollamaModel, setOllamaModel] = useState('llama3.2');
  useEffect(() => {
    kvGet('octo-ollama-url').then(v => { if (v) setOllamaUrl(v); }).catch(() => {});
    kvGet('octo-ollama-model').then(v => { if (v) setOllamaModel(v); }).catch(() => {});
  }, []);

  // Periodically analyze log buffer with Ollama
  useEffect(() => {
    if (!aiWatch || status !== 'streaming') {
      if (analyzeTimerRef.current) clearInterval(analyzeTimerRef.current);
      return;
    }

    analyzeTimerRef.current = setInterval(async () => {
      const chunk = logBufferRef.current;
      if (!chunk.trim() || analyzingRef.current) return;

      analyzingRef.current = true;
      logBufferRef.current = ''; // Reset buffer

      const result = await analyzeWithOllama(stripAnsi(chunk), ollamaModel, ollamaUrl);
      analyzingRef.current = false;

      if (result) {
        const alert: AnomalyAlert = {
          id: ++alertIdRef.current,
          level: result.level,
          message: result.message,
          timestamp: Date.now(),
          logSnippet: stripAnsi(chunk).slice(-200),
        };
        setAlerts(prev => [alert, ...prev].slice(0, 20));

        // Write alert to terminal
        const color = result.level === 'critical' ? '31' : '33';
        const icon = result.level === 'critical' ? '🚨' : '⚠️';
        xtermRef.current?.write(
          `\r\n\x1b[${color};1m${icon} [${t('pm2.aiDetected')}] ${result.message}\x1b[0m\r\n`
        );
      }
    }, 15000); // Analyze every 15 seconds

    return () => { if (analyzeTimerRef.current) clearInterval(analyzeTimerRef.current); };
  }, [aiWatch, status, ollamaModel, ollamaUrl]);

  const destroyPty = useCallback(async () => {
    readLoopRef.current = false;
    if (ptyIdRef.current) {
      try { await invoke('destroy_pty', { terminalId: ptyIdRef.current }); } catch {}
      ptyIdRef.current = null;
    }
  }, []);

  const viewAllRef = useRef(viewAll);
  viewAllRef.current = viewAll;

  const startLogStream = useCallback(async (name: string | null) => {
    await destroyPty();
    if (!termRef.current) return;

    if (xtermRef.current) {
      xtermRef.current.dispose();
    }

    const th = themeRef.current;
    const ff = fontFamilyRef.current;
    const fs = fontSizeRef.current;

    const term = new Terminal({
      fontFamily: ff,
      fontSize: fs,
      theme: {
        background: th.bg,
        foreground: th.text,
        cursor: th.accent,
      },
      scrollback: 5000,
      convertEol: true,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
    } catch {}

    fitAddon.fit();
    xtermRef.current = term;
    logBufferRef.current = '';

    const terminalId = `pm2-log-${Date.now()}`;
    ptyIdRef.current = terminalId;

    setStatus('connecting');

    try {
      // For SSH projects, create a local shell and run SSH command.
      // For local projects, create a local shell and run pm2 directly.
      const isSsh = workDir.startsWith('ssh://');
      const shellWorkDir = isSsh ? '/tmp' : workDir;

      await invoke('create_shell', {
        terminalId,
        workDir: shellWorkDir,
        rows: term.rows,
        cols: term.cols,
      });

      // Wait for shell to be ready before sending command
      await new Promise(r => setTimeout(r, 300));

      const effectiveName = viewAllRef.current ? null : name;
      let cmd: string;
      if (isSsh) {
        const sshCmd = buildSshLogCommand(workDir, effectiveName);
        if (!sshCmd) throw new Error(t('pm2.sshParseFailed'));
        cmd = sshCmd + '\n';
      } else {
        const appPart = effectiveName ? ` ${effectiveName}` : '';
        cmd = `pm2 logs${appPart} --lines 200 --raw\n`;
      }

      await invoke('write_to_pty', { terminalId, data: cmd });
      setStatus('streaming');

      // Read loop
      readLoopRef.current = true;
      const readLoop = async () => {
        while (readLoopRef.current && ptyIdRef.current === terminalId) {
          let hadData = false;
          try {
            const data = await invoke<string>('read_from_pty', { terminalId });
            if (data && data.length > 0) {
              hadData = true;
              term.write(data);
              // Accumulate to buffer for AI analysis
              logBufferRef.current += data;
              // Cap buffer at 10KB to prevent memory bloat
              if (logBufferRef.current.length > 10000) {
                logBufferRef.current = logBufferRef.current.slice(-8000);
              }
            }
          } catch {
            break;
          }
          // 데이터가 흐를 때만 ~30fps; 유휴/백그라운드에선 늦춰 CPU를 아낀다
          // (고정 30fps 무한 폴링이 설치본 웹뷰 상시 점유의 한 축이었음).
          const hidden = document.visibilityState === 'hidden';
          await new Promise(r => setTimeout(r, hidden ? 500 : hadData ? 33 : 200));
        }
      };
      readLoop();

      // Resize observer
      const ro = new ResizeObserver(() => {
        fitAddon.fit();
        invoke('resize_pty', { terminalId, rows: term.rows, cols: term.cols }).catch(() => {});
      });
      ro.observe(termRef.current);

    } catch (e: any) {
      term.write(`\r\n\x1b[31m[Error] ${e?.message || e}\x1b[0m\r\n`);
      setStatus('idle');
    }
  }, [workDir, destroyPty]);

  useEffect(() => {
    if (viewAll || appName) {
      startLogStream(appName);
      setAlerts([]);
    } else {
      destroyPty();
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      setStatus('idle');
    }
    return () => { destroyPty(); };
  }, [appName, viewAll, startLogStream, destroyPty]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      readLoopRef.current = false;
      if (ptyIdRef.current) {
        invoke('destroy_pty', { terminalId: ptyIdRef.current }).catch(() => {});
      }
      if (xtermRef.current) {
        xtermRef.current.dispose();
      }
    };
  }, []);

  const handleClear = () => {
    xtermRef.current?.clear();
    logBufferRef.current = '';
  };

  const handleRestart = async () => {
    if (!appName) return;
    try {
      await invoke('pm2_action', { workDir, action: 'restart', appName });
      xtermRef.current?.write(`\r\n\x1b[33m[${t('pm2.restarting')}]\x1b[0m\r\n`);
    } catch {}
  };

  const dismissAlert = (id: number) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  return (
    <div className="pm2-log-viewer" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div className="pm2-log-header" style={{ borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>
          {viewAll ? `📋 ${t('pm2.allLogs')}` : appName ? `📋 ${appName}` : t('pm2.selectProcess')}
        </span>
        {/* 전체/선택 토글 */}
        <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
          <button
            className="pm2-btn"
            onClick={() => setViewAll(false)}
            style={{
              fontSize: 10,
              padding: '1px 6px',
              color: !viewAll ? theme.accent : theme.text,
              borderColor: !viewAll ? theme.accent : undefined,
              fontWeight: !viewAll ? 600 : 400,
            }}
            title={t('pm2.selectedProcessOnly')}
          >
            {t('pm2.selectedOnly')}
          </button>
          <button
            className="pm2-btn"
            onClick={() => setViewAll(true)}
            style={{
              fontSize: 10,
              padding: '1px 6px',
              color: viewAll ? theme.accent : theme.text,
              borderColor: viewAll ? theme.accent : undefined,
              fontWeight: viewAll ? 600 : 400,
            }}
            title={t('pm2.allProcessLogs')}
          >
            {t('settings.common.all')}
          </button>
        </div>
        {status !== 'idle' && (
          <span className={`pm2-log-status ${status === 'streaming' ? 'live' : 'connecting'}`}>
            {status === 'streaming' ? 'LIVE' : t('settings.common.connecting')}
          </span>
        )}
        {(appName || viewAll) && (
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
            {/* AI Watch Toggle */}
            <button
              className={`pm2-btn ${aiWatch ? 'active' : ''}`}
              onClick={() => setAiWatch(p => !p)}
              title={aiWatch ? t('pm2.aiWatchOn').replace('{model}', ollamaModel) : t('pm2.aiWatchOff')}
              style={{
                color: aiWatch ? '#ff9800' : theme.text,
                borderColor: aiWatch ? '#ff9800' : undefined,
                fontSize: 11,
              }}
            >
              {aiWatch ? '🤖 AI ON' : '🤖 AI'}
            </button>
            {alerts.length > 0 && (
              <span style={{
                fontSize: 10,
                background: alerts.some(a => a.level === 'critical') ? '#f44336' : '#ff9800',
                color: '#fff',
                borderRadius: 'var(--brutal-radius)',
                padding: '1px 6px',
                fontWeight: 600,
              }}>
                {alerts.length}
              </span>
            )}
            <button className="pm2-btn" onClick={handleClear} title={t('pm2.clear')}>{t('pm2.clear')}</button>
            <button className="pm2-btn" onClick={handleRestart} title={t('pm2.restart')}>{t('pm2.restart')}</button>
          </div>
        )}
      </div>

      {/* Alert banner */}
      {alerts.length > 0 && (
        <div className="pm2-alerts" style={{ maxHeight: 120, overflowY: 'auto', borderBottom: `1px solid ${theme.border}` }}>
          {alerts.slice(0, 5).map(alert => (
            <div
              key={alert.id}
              className="pm2-alert-item"
              style={{
                background: alert.level === 'critical' ? 'rgba(244,67,54,0.12)' : 'rgba(255,152,0,0.10)',
                borderLeft: `3px solid ${alert.level === 'critical' ? '#f44336' : '#ff9800'}`,
                padding: '4px 8px',
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>{alert.level === 'critical' ? '🚨' : '⚠️'}</span>
              <span style={{ flex: 1 }}>{alert.message}</span>
              <span style={{ fontSize: 9, opacity: 0.5 }}>
                {new Date(alert.timestamp).toLocaleTimeString()}
              </span>
              <button
                onClick={() => dismissAlert(alert.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: theme.text,
                  cursor: 'pointer',
                  opacity: 0.4,
                  fontSize: 12,
                  padding: '0 2px',
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        ref={termRef}
        style={{
          flex: 1,
          background: theme.bg,
          minHeight: 0,
          overflow: 'hidden',
        }}
      />
      {!appName && !viewAll && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          opacity: 0.3,
          pointerEvents: 'none',
        }}>
          {t('pm2.selectProcessHint')}
        </div>
      )}
    </div>
  );
};
