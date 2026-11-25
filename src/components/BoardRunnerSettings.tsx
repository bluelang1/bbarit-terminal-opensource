// Settings → Agent team board → Board server → Runner: the runner for a board server, a separate
// program the person installs and signs in with in a terminal. Here: its path (checked by the
// host before it is saved as `agents.board.server.runnerPath`), its state (read with
// `createStatusPoller` only while this block is on screen: no overlap, backoff when slow),
// and Start / Stop / Refresh. The host commands are src-tauri/src/agent_board/runner.rs
// (`board_runner_*`); the ones that run the program take nothing from here: they read the
// saved path and the board server address themselves. Every text from the program is shown
// as plain text.

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useTranslation, type TranslationKey } from '../i18n';
import { fillText } from '../terminal/agentBoardStorage';
import { createStatusPoller, type StatusPoller } from '../git/statusPoll';
import {
  RUNNER_POLL_BASE_MS,
  formatRunnerTime,
  isKnownRunnerError,
  normalizeRunnerError,
  normalizeRunnerStatus,
  runnerSupported,
  runnerText,
  type RunnerError,
  type RunnerStatus,
} from '../terminal/boardRunner';

const DANGER = 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)';
const WARN = 'color-mix(in srgb, #f59e0b 75%, var(--settings-text) 25%)';
const ID = 'agent-board-runner';
const P = 'settings.agentBoard.server.runner';
/** A saved change reaches config.json 300 ms later (ConfigContext): read after that. */
const READ_AFTER_SAVE_MS = 800;

const box: CSSProperties = {
  marginTop: 6,
  padding: '8px 10px',
  borderRadius: 'var(--brutal-radius)',
  border: '1px solid color-mix(in srgb, var(--settings-text) 12%, transparent)',
  background: 'color-mix(in srgb, var(--settings-bg) 80%, #000 20%)',
  color: 'var(--settings-text)',
  fontSize: 12,
};

const MODES = ['starting', 'stream', 'polling'] as const;
const STATES = ['idle', 'claiming', 'preparing', 'working', 'submitting', 'stopping'] as const;

interface Props {
  /** `agents.board.server.runnerPath` as saved (empty: the block only explains and asks for it). */
  savedPath: string;
  /** Saves `agents.board.server.runnerPath` (a path the host accepted, or empty). */
  onSavePath: (path: string) => void;
  /** The saved board server address: a change reads the state again. */
  savedServerUrl: string;
}

type Busy = 'save' | 'pick' | 'start' | 'stop' | 'refresh';

/** On screen: the page is visible and (where the browser can tell) the block is in view. */
function useOnScreen(ref: RefObject<HTMLElement | null>): boolean {
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const onChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return pageVisible && inView;
}

export function BoardRunnerSettings({ savedPath, onSavePath, savedServerUrl }: Props) {
  const { t } = useTranslation();
  const supported = runnerSupported();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onScreen = useOnScreen(rootRef);

  const [pathDraft, setPathDraft] = useState(savedPath);
  const lastSaved = useRef(savedPath);
  useEffect(() => {
    if (lastSaved.current === savedPath) return;
    const prev = lastSaved.current;
    lastSaved.current = savedPath;
    setPathDraft((d) => (d.trim() === prev.trim() ? savedPath : d));
  }, [savedPath]);
  const [pathError, setPathError] = useState<RunnerError | null>(null);

  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [statusError, setStatusError] = useState<RunnerError | null>(null);
  const [version, setVersion] = useState<{ text: string } | { error: RunnerError } | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // One action at a time (a second click while one runs does nothing).
  const busyRef = useRef<Busy | null>(null);
  const begin = (b: Busy) => {
    if (busyRef.current !== null) return false;
    busyRef.current = b;
    setBusy(b);
    return true;
  };
  const end = () => {
    busyRef.current = null;
    if (alive.current) setBusy(null);
  };

  const errorText = (e: RunnerError): string => {
    const key = (isKnownRunnerError(e.kind) ? `${P}.error.${e.kind}` : `${P}.error.other`) as TranslationKey;
    return fillText(t(key), { detail: e.detail || '-' }).trim();
  };

  // ── State reads ──
  // Newest wins: a read started before a newer one (or before Start/Stop answered) is dropped.
  const seq = useRef(0);
  const poller = useRef<StatusPoller | null>(null);
  const readOnce = async () => {
    // Start and Stop read the state themselves: no second run of the program meanwhile.
    if (busyRef.current === 'start' || busyRef.current === 'stop') return;
    const mine = ++seq.current;
    try {
      const raw = await invoke('board_runner_status');
      if (mine !== seq.current || !alive.current) return;
      const s = normalizeRunnerStatus(raw);
      if (!s) {
        setStatus(null);
        setStatusError({ kind: 'bad_output', detail: '' });
        return;
      }
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      if (mine !== seq.current || !alive.current) return;
      setStatus(null);
      setStatusError(normalizeRunnerError(e));
    }
  };

  const active = supported && isTauri() && savedPath !== '';
  const readKey = `${savedPath}|${savedServerUrl}`;
  const firstRead = useRef(true);
  useEffect(() => {
    if (!active) {
      seq.current++;
      setStatus(null);
      setStatusError(null);
      return;
    }
    if (!onScreen) return;
    const p = createStatusPoller(readOnce, { baseMs: RUNNER_POLL_BASE_MS });
    poller.current = p;
    // Read now (or once a saved change reached config.json); the timer starts after that answer,
    // so its first wait already reflects how long the program took.
    const begin = () => void p.refresh().then(() => p.start());
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (firstRead.current) begin();
    else timer = setTimeout(begin, READ_AFTER_SAVE_MS);
    firstRead.current = false;
    return () => {
      if (timer) clearTimeout(timer);
      p.stop();
      if (poller.current === p) poller.current = null;
      seq.current++;
    };
  }, [active, onScreen, readKey]);

  // The program's version line: once per saved path.
  const firstVersion = useRef(true);
  useEffect(() => {
    setVersion(null);
    if (!active) return;
    let stale = false;
    const read = () => {
      invoke('board_runner_version')
        .then((raw) => {
          if (stale) return;
          const text = runnerText((raw as { version?: unknown } | null)?.version, 200);
          setVersion(text ? { text } : null);
        })
        .catch((e) => {
          if (!stale) setVersion({ error: normalizeRunnerError(e) });
        });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (firstVersion.current) read();
    else timer = setTimeout(read, READ_AFTER_SAVE_MS);
    firstVersion.current = false;
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, savedPath]);

  const refresh = async () => {
    if (!begin('refresh')) return;
    try {
      if (poller.current) await poller.current.refresh({ fresh: true });
      else await readOnce();
    } finally {
      end();
    }
  };

  // ── Start / Stop ──
  const act = async (which: 'start' | 'stop') => {
    if (!begin(which)) return;
    setMessage(null);
    try {
      const raw = await invoke(which === 'start' ? 'board_runner_start' : 'board_runner_stop');
      if (!alive.current) return;
      const s = normalizeRunnerStatus(raw);
      if (s) {
        seq.current++;
        setStatus(s);
        setStatusError(null);
      }
      setMessage({ ok: true, text: t(`${P}.${which === 'start' ? 'started' : 'stopped'}` as TranslationKey) });
    } catch (e) {
      if (!alive.current) return;
      setMessage({ ok: false, text: errorText(normalizeRunnerError(e)) });
    } finally {
      end();
      // Whatever happened, show the state as the program sees it now.
      if (alive.current) void poller.current?.refresh({ fresh: true });
    }
  };

  // ── The path ──
  const savePath = async (raw: string) => {
    if (!begin('save')) return;
    setPathError(null);
    setMessage(null);
    try {
      const r = (await invoke('board_runner_check_path', { path: raw })) as { path?: unknown } | null;
      if (!alive.current) return;
      const path = typeof r?.path === 'string' ? r.path : '';
      onSavePath(path);
      setPathDraft(path);
      setMessage({ ok: true, text: path ? fillText(t(`${P}.path.saved`), { path }) : t(`${P}.path.cleared`) });
    } catch (e) {
      if (alive.current) setPathError(normalizeRunnerError(e));
    } finally {
      end();
    }
  };

  const pick = async () => {
    if (busyRef.current !== null) return;
    let picked: string | string[] | null = null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      picked = await open({ multiple: false, directory: false, title: t(`${P}.path`) });
    } catch (e) {
      setPathError(normalizeRunnerError(e));
      return;
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path || !alive.current) return;
    setPathDraft(path);
    await savePath(path);
  };

  const pathDirty = pathDraft.trim() !== savedPath.trim();
  const disabled = busy !== null;

  const modeText = (m: string) => ((MODES as readonly string[]).includes(m) ? t(`${P}.mode.${m}` as TranslationKey) : m || '-');
  const stateText = (s: string) => ((STATES as readonly string[]).includes(s) ? t(`${P}.state.${s}` as TranslationKey) : s || '-');
  const count = (n: number | null) => (n === null ? '-' : String(n));

  const row = (label: TranslationKey, value: string, testId?: string) => (
    <>
      <dt className="setting-description" style={{ margin: 0 }}>{t(label)}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }} data-testid={testId}>{value}</dd>
    </>
  );

  if (!supported) {
    return (
      <div data-testid="agent-board-runner" style={{ marginTop: 8 }}>
        <h4 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t(`${P}.title`)}</h4>
        <span className="setting-description" role="note" data-testid="agent-board-runner-unsupported">{t(`${P}.unsupported`)}</span>
      </div>
    );
  }

  const stateArea = (() => {
    if (!savedPath) return null;
    if (statusError) {
      return (
        <span className="setting-description" role="alert" style={{ color: DANGER, whiteSpace: 'pre-wrap' }} data-testid="agent-board-runner-error">
          {errorText(statusError)}
        </span>
      );
    }
    if (status === null) return <span className="setting-description" data-testid="agent-board-runner-reading">{t(`${P}.reading`)}</span>;
    if (!status.running) return <span data-testid="agent-board-runner-stopped">{t(`${P}.notRunning`)}</span>;
    const pool = status.pool;
    return (
      <>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0, fontSize: 12 }} data-testid="agent-board-runner-running">
          {row(`${P}.name` as TranslationKey, status.runner || '-')}
          {row(`${P}.account` as TranslationKey, status.account || '-')}
          {row(`${P}.mode` as TranslationKey, modeText(status.mode))}
          {row(`${P}.since` as TranslationKey, formatRunnerTime(status.startedAt))}
        </dl>
        <span className="setting-description" data-testid="agent-board-runner-pool">
          {pool
            ? fillText(t(`${P}.pool.line`), { idle: count(pool.idle), busy: count(pool.busy), max: count(pool.max), suggested: count(pool.suggestedMax) })
            : t(`${P}.pool.off`)}
        </span>
        {pool?.limited.map((l, i) => (
          <span key={`${l.product}-${i}`} className="setting-description" role="note" style={{ color: WARN }} data-testid="agent-board-runner-limited">
            {fillText(t(`${P}.pool.limited`), { product: l.product || '-', until: formatRunnerTime(l.until ?? l.untilUnix) })}
          </span>
        ))}
        {pool?.suggestion && <span className="setting-description">{pool.suggestion}</span>}
        {status.workers.length > 0 ? (
          <table style={{ fontSize: 12, borderCollapse: 'collapse' }} data-testid="agent-board-runner-workers">
            <caption style={{ textAlign: 'left', fontWeight: 600 }}>{t(`${P}.workers`)}</caption>
            <thead>
              <tr>
                {(['state', 'task', 'product', 'since'] as const).map((c) => (
                  <th key={c} scope="col" className="setting-description" style={{ textAlign: 'left', paddingRight: 10, fontWeight: 'normal' }}>
                    {t(`${P}.workers.${c}` as TranslationKey)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.workers.map((w, i) => (
                <tr key={`${w.id}-${i}`}>
                  <td style={{ paddingRight: 10 }}>{stateText(w.state)}</td>
                  <td style={{ paddingRight: 10, wordBreak: 'break-all' }}>{w.task ?? '-'}</td>
                  <td style={{ paddingRight: 10 }}>{w.product || '-'}</td>
                  <td>{formatRunnerTime(w.since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : pool ? (
          <span className="setting-description">{t(`${P}.workers.none`)}</span>
        ) : null}
      </>
    );
  })();

  return (
    <div ref={rootRef} data-testid="agent-board-runner" style={{ marginTop: 8 }}>
      <h4 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t(`${P}.title`)}</h4>
      {!savedPath && (
        <span className="setting-description" role="note" style={{ display: 'block' }} data-testid="agent-board-runner-about">
          {t(`${P}.about`)}
        </span>
      )}

      <div className="setting-item">
        <label htmlFor={`${ID}-path`}>{t(`${P}.path`)}</label>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            id={`${ID}-path`}
            type="text"
            value={pathDraft}
            maxLength={4096}
            placeholder="/usr/local/bin/…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!pathError}
            aria-describedby={`${ID}-path-error ${ID}-path-desc`}
            onChange={(e) => {
              setPathDraft(e.target.value);
              setPathError(null);
            }}
          />
          <button type="button" className="btn-secondary" disabled={disabled} onClick={() => void pick()}>
            {t(`${P}.path.choose`)}
          </button>
          <button type="button" className="btn-secondary" disabled={disabled || !pathDirty} onClick={() => void savePath(pathDraft)}>
            {busy === 'save' ? t('settings.agentBoard.working') : t(`${P}.path.save`)}
          </button>
          {savedPath && (
            <button type="button" className="btn-secondary" disabled={disabled} onClick={() => void savePath('')}>
              {t(`${P}.path.clear`)}
            </button>
          )}
        </span>
        <span id={`${ID}-path-error`} className="setting-description" data-testid="agent-board-runner-path-error" style={{ color: DANGER, minHeight: '1.2em' }}>
          {pathError ? errorText(pathError) : ''}
        </span>
        <span id={`${ID}-path-desc`} className="setting-description">
          {t(`${P}.path.desc`)}
          {version && 'text' in version && <> {fillText(t(`${P}.version`), { version: version.text })}</>}
        </span>
        {version && 'error' in version && (
          <span className="setting-description" style={{ color: DANGER, whiteSpace: 'pre-wrap' }} data-testid="agent-board-runner-version-error">
            {errorText(version.error)}
          </span>
        )}
      </div>

      {savedPath && (
        <div className="setting-item" style={{ alignItems: 'flex-start' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{t(`${P}.state`)}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} aria-busy={busy === 'start' || busy === 'stop'}>
            {stateArea}
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {status && !status.running && !statusError && (
                <button type="button" className="btn-secondary" disabled={disabled} onClick={() => void act('start')}>
                  {busy === 'start' ? t(`${P}.starting`) : t(`${P}.start`)}
                </button>
              )}
              {status?.running && !statusError && (
                <button type="button" className="btn-secondary" disabled={disabled} onClick={() => void act('stop')}>
                  {busy === 'stop' ? t(`${P}.stopping`) : t(`${P}.stop`)}
                </button>
              )}
              <button type="button" className="btn-secondary" disabled={disabled} onClick={() => void refresh()}>
                {t('settings.agentBoard.status.refresh')}
              </button>
            </span>
          </div>
        </div>
      )}

      {message && (
        <div style={{ ...box, whiteSpace: 'pre-wrap', color: message.ok ? 'var(--settings-text)' : DANGER }} role="status" data-testid="agent-board-runner-message">
          {message.text}
        </div>
      )}
    </div>
  );
}
