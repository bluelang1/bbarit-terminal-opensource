// Settings → Agent team board, usage type "Board server" (`agents.board.mode: "server"`): the
// server address (a draft until Save, checked like Rust `check_server_url`), sign-in by device
// login (code + approval page, polled at the pace the host gives in `retryInMs`), the signed-in
// account and computer, and sign-out. The host commands are src-tauri/src/agent_board/
// server_login.rs (`board_server_*`); the token never reaches the webview, only its prefix.
// Below it, the runner for a board server (BoardRunnerSettings.tsx).

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useTranslation, type TranslationKey } from '../i18n';
import { BoardRunnerSettings } from './BoardRunnerSettings';
import {
  SIGN_IN_POLL_MIN_MS,
  checkServerUrl,
  fillText,
  formatRemaining,
  normalizeBoardServerStatus,
  normalizeSignInPoll,
  normalizeSignInStart,
  sameOriginLink,
  type BoardServerStatus,
  type ServerSignInPoll,
  type ServerSignInStart,
} from '../terminal/agentBoardStorage';

// The settings panel's own color pattern (reads in light and dark themes).
const DANGER = 'color-mix(in srgb, #ef4444 75%, var(--settings-text) 25%)';
const WARN = 'color-mix(in srgb, #f59e0b 75%, var(--settings-text) 25%)';
const ID = 'agent-board-server';

const box: CSSProperties = {
  marginTop: 6,
  padding: '8px 10px',
  borderRadius: 'var(--brutal-radius)',
  border: '1px solid color-mix(in srgb, var(--settings-text) 12%, transparent)',
  background: 'color-mix(in srgb, var(--settings-bg) 80%, #000 20%)',
  color: 'var(--settings-text)',
  fontSize: 12,
};

const codeStyle: CSSProperties = {
  fontFamily: "'SF Mono', 'Fira Code', monospace",
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: '0.12em',
  userSelect: 'all',
};

export interface BoardServerState {
  status: BoardServerStatus | null;
  statusError: string | null;
  reload: () => void;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long after a saved change the status is read again: config.json is written 300 ms after a
 * change (ConfigContext), so a read right away would still see the old address. */
export const STATUS_AFTER_SAVE_MS = 800;

/**
 * `board_server_status` while `active` (the usage type is `server`): read on open, after the
 * saved address changes (once config.json has it) and on `reload` (after a sign-in or sign-out).
 * Never polled: each read asks the server who this computer is. A sequence guard drops an
 * answer older than the newest.
 */
export function useBoardServer(active: boolean, savedUrl: string): BoardServerState {
  const [status, setStatus] = useState<BoardServerStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const seq = useRef(0);
  const shownUrl = useRef<string | null>(null);
  const reload = useCallback(() => {
    if (!isTauri()) return;
    const mine = ++seq.current;
    invoke('board_server_status')
      .then((raw) => {
        if (mine !== seq.current) return;
        setStatus(normalizeBoardServerStatus(raw));
        setStatusError(null);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setStatusError(errText(e));
      });
  }, []);
  useEffect(() => {
    if (!active) {
      seq.current++;
      shownUrl.current = null;
      setStatus(null);
      setStatusError(null);
      return;
    }
    // First read at once; after a saved address change wait for the config write to land.
    const first = shownUrl.current === null;
    shownUrl.current = savedUrl;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (first) reload();
    else timer = setTimeout(reload, STATUS_AFTER_SAVE_MS);
    return () => {
      if (timer) clearTimeout(timer);
      seq.current++;
    };
  }, [active, savedUrl, reload]);
  return { status, statusError, reload };
}

type Phase = 'idle' | 'starting' | 'waiting' | 'denied' | 'expired' | 'error';

interface Props {
  server: BoardServerState;
  /** `agents.board.server.url` as saved. */
  savedUrl: string;
  /** Saves `agents.board.server.url` (an origin `checkServerUrl` accepted). */
  onSaveUrl: (origin: string) => void;
  /** The name the host uses when the computer name is left empty. */
  defaultComputer: string;
  /** `agents.board.server.runnerPath` as saved. */
  runnerPath: string;
  /** Saves `agents.board.server.runnerPath` (checked by the host first, or empty). */
  onSaveRunnerPath: (path: string) => void;
}

export function BoardServerSettings({ server, savedUrl, onSaveUrl, defaultComputer, runnerPath, onSaveRunnerPath }: Props) {
  const { t } = useTranslation();
  const { status, statusError, reload } = server;

  // ── Address (a draft until Save) ──
  const [urlDraft, setUrlDraft] = useState(savedUrl);
  const lastSaved = useRef(savedUrl);
  useEffect(() => {
    if (lastSaved.current === savedUrl) return;
    const prev = lastSaved.current;
    lastSaved.current = savedUrl;
    // A saved change elsewhere replaces an untouched draft.
    setUrlDraft((d) => (d.trim() === prev.trim() ? savedUrl : d));
  }, [savedUrl]);
  const check = checkServerUrl(urlDraft);
  const urlDirty = urlDraft.trim() !== savedUrl.trim();
  const savedCheck = checkServerUrl(savedUrl);

  // ── Sign-in ──
  const [computer, setComputer] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, setPending] = useState<(ServerSignInStart & { expiresAt: number }) | null>(null);
  const [failText, setFailText] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [signOutAsk, setSignOutAsk] = useState<'server' | 'local' | null>(null);
  const [copied, setCopied] = useState(false);

  // One action at a time (a second click while one runs does nothing), as AgentBoardSettings.run.
  const busyRef = useRef<string | null>(null);
  const begin = (label: string): boolean => {
    if (busyRef.current !== null) return false;
    busyRef.current = label;
    setBusy(label);
    return true;
  };
  const end = () => {
    busyRef.current = null;
    if (alive.current) setBusy(null);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A cancel, a new start or unmounting makes every older poll answer stale.
  const gen = useRef(0);
  const waiting = useRef(false);
  const alive = useRef(true);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const tRef = useRef(t);
  tRef.current = t;

  const stopPolling = () => {
    gen.current++;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Leaving the screen (or the usage type) while waiting cancels the sign-in on the host too.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const was = waiting.current;
      waiting.current = false;
      gen.current++;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (was) void invoke('board_server_sign_in_cancel').catch(() => {});
    };
  }, []);

  const finish = (r: Exclude<ServerSignInPoll, { state: 'pending' }>) => {
    waiting.current = false;
    setPending(null);
    const tt = tRef.current;
    if (r.state === 'signed_in') {
      setPhase('idle');
      focusAfter.current = 'message';
      const lines = [fillText(tt('settings.agentBoard.server.signedInNow'), { nickname: r.nickname || '-', computer: r.computer || '-' })];
      if (r.replaced) lines.push(fillText(tt('settings.agentBoard.server.replaced'), { server: r.replaced.server }));
      setMessage({ ok: true, text: lines.join('\n') });
      reloadRef.current();
      return;
    }
    if (r.state === 'cancelled' || r.state === 'idle') {
      setPhase('idle');
      focusAfter.current = 'signin';
      return;
    }
    setPhase(r.state);
    setFailText(r.message);
  };

  // One poll, then the next one after the wait the host asked for (never a fixed interval).
  const pollOnce = async (mine: number) => {
    let r: ServerSignInPoll;
    try {
      r = normalizeSignInPoll(await invoke('board_server_sign_in_poll'));
    } catch (e) {
      r = { state: 'error', message: errText(e) };
    }
    if (mine !== gen.current || !alive.current) return;
    if (r.state === 'pending') {
      schedule(mine, r.retryInMs);
      return;
    }
    finish(r);
  };

  const schedule = (mine: number, ms: number) => {
    timer.current = setTimeout(() => {
      timer.current = null;
      void pollOnce(mine);
    }, ms);
  };

  const signIn = async () => {
    if (!begin('signin')) return;
    stopPolling();
    setMessage(null);
    setFailText('');
    setCopied(false);
    setPhase('starting');
    try {
      const raw = await invoke('board_server_sign_in_start', { server: savedCheck.ok ? savedCheck.origin : savedUrl, computerName: computer.trim() || null });
      const s = normalizeSignInStart(raw);
      if (!s || !alive.current) {
        // The host is waiting on a sign-in nobody will finish: cancel it there first.
        await invoke('board_server_sign_in_cancel').catch(() => {});
        if (!s) throw new Error(t('settings.agentBoard.server.startBad'));
        return;
      }
      const mine = ++gen.current;
      waiting.current = true;
      const at = Date.now();
      setPending({ ...s, expiresAt: at + s.expiresIn * 1000 });
      setNow(at);
      setPhase('waiting');
      schedule(mine, Math.max(SIGN_IN_POLL_MIN_MS, s.interval * 1000));
    } catch (e) {
      if (!alive.current) return;
      setPhase('error');
      setFailText(errText(e));
    } finally {
      end();
    }
  };

  const cancelSignIn = async () => {
    if (!begin('cancel')) return;
    stopPolling();
    waiting.current = false;
    setPending(null);
    setPhase('idle');
    focusAfter.current = 'signin';
    try {
      await invoke('board_server_sign_in_cancel');
    } catch {
      /* nothing was waiting */
    } finally {
      end();
    }
  };

  // The countdown (display only; the host decides when the code expired).
  useEffect(() => {
    if (phase !== 'waiting') return;
    const id = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(id);
  }, [phase, now]);

  // Focus follows the step: the code panel, then the retry button after a failure.
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const askRef = useRef<HTMLButtonElement | null>(null);
  const signInRef = useRef<HTMLButtonElement | null>(null);
  const messageRef = useRef<HTMLDivElement | null>(null);
  // After Cancel: the Sign in button; after signing in or out: the result line.
  const focusAfter = useRef<'signin' | 'message' | null>(null);
  useEffect(() => {
    if (phase === 'waiting') copyRef.current?.focus();
    else if (phase === 'denied' || phase === 'expired' || phase === 'error') retryRef.current?.focus();
  }, [phase]);
  useEffect(() => {
    const want = focusAfter.current;
    if (!want) return;
    const el = want === 'signin' ? signInRef.current : messageRef.current;
    // A button still disabled (the request ends a moment later) is tried on the next render.
    if (el && !(el instanceof HTMLButtonElement && el.disabled)) {
      focusAfter.current = null;
      el.focus();
    }
  });
  useEffect(() => {
    if (signOutAsk) askRef.current?.focus();
  }, [signOutAsk]);

  const copyCode = () => {
    if (!pending) return;
    const done = () => setCopied(true);
    try {
      void navigator.clipboard?.writeText(pending.userCode).then(done, () => {});
    } catch {
      /* no clipboard: the code stays selectable */
    }
  };

  // The host opens the waiting sign-in's own link after its same-origin check; no URL goes from here.
  const openApproval = () => {
    invoke('board_server_open_sign_in_link')
      .then((r) => {
        // The browser could not be started: show the "open it yourself" line.
        if (r && typeof r === 'object' && (r as { opened?: unknown }).opened === false) setPending((p) => (p ? { ...p, opened: false } : p));
      })
      .catch((e) => setMessage({ ok: false, text: errText(e) }));
  };

  const signOut = async (localOnly: boolean) => {
    if (!begin('signout')) return;
    setMessage(null);
    try {
      await invoke('board_server_sign_out', { localOnly });
      if (!alive.current) return;
      setMessage({ ok: true, text: t(localOnly ? 'settings.agentBoard.server.signedOutLocalNow' : 'settings.agentBoard.server.signedOutNow') });
      focusAfter.current = 'message';
    } catch (e) {
      if (!alive.current) return;
      setMessage({ ok: false, text: errText(e) });
    } finally {
      if (alive.current) {
        setSignOutAsk(null);
        reload();
      }
      end();
    }
  };

  // Save is locked while a sign-in starts or waits (it belongs to the saved address).
  const signInRunning = phase === 'starting' || phase === 'waiting';
  const saveUrl = () => {
    if (!check.ok || signInRunning) return;
    onSaveUrl(check.origin);
    setUrlDraft(check.origin);
    setMessage({ ok: true, text: fillText(t('settings.agentBoard.server.url.saved'), { server: check.origin }) });
  };

  const urlError: { text: string; color: string } | null = (() => {
    if (!check.ok) {
      const text = t(`settings.agentBoard.server.url.error.${check.error}` as TranslationKey);
      return { text, color: check.error === 'empty' ? WARN : DANGER };
    }
    // The host's own words for the saved address (the same rules, so rarely seen).
    if (!urlDirty && status?.serverError) return { text: status.serverError, color: DANGER };
    return null;
  })();

  const disabled = busy !== null;
  const canStart = savedCheck.ok && !urlDirty && busy === null;
  const link = pending ? pending.verificationUriComplete ?? pending.verificationUri : '';
  const linkOpenable = !!pending && sameOriginLink(link, pending.server || (savedCheck.ok ? savedCheck.origin : ''));
  const spaced = pending ? pending.userCode.split('').join(' ') : '';
  const suspendedUntil = status?.suspendedUntil ? new Date(status.suspendedUntil) : null;
  const suspendedText = suspendedUntil && !Number.isNaN(suspendedUntil.getTime()) ? suspendedUntil.toLocaleString() : status?.suspendedUntil ?? null;

  const signInButton = (label: string) => (
    <button ref={signInRef} type="button" className="btn-secondary" disabled={!canStart} onClick={() => void signIn()}>
      {busy === 'signin' ? t('settings.agentBoard.working') : label}
    </button>
  );

  const signInArea = (
    <>
      {(phase === 'idle' || phase === 'starting') && (
        <>
          <label htmlFor={`${ID}-computer`} style={{ fontWeight: 'normal' }}>
            {t('settings.agentBoard.server.computer')}
          </label>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              id={`${ID}-computer`}
              type="text"
              value={computer}
              maxLength={64}
              placeholder={defaultComputer}
              autoComplete="off"
              aria-describedby={`${ID}-computer-desc`}
              onChange={(e) => setComputer(e.target.value)}
            />
            {signInButton(status?.signedIn && !status.serverMatches ? fillText(t('settings.agentBoard.server.signInTo'), { server: savedCheck.ok ? savedCheck.origin : savedUrl }) : t('settings.agentBoard.server.signIn'))}
          </span>
          <span id={`${ID}-computer-desc`} className="setting-description">
            {fillText(t('settings.agentBoard.server.computer.desc'), { name: defaultComputer || '-' })}
          </span>
          {urlDirty && <span className="setting-description" style={{ color: WARN }}>{t('settings.agentBoard.server.saveFirst')}</span>}
          {phase === 'starting' && <span className="setting-description" role="status">{t('settings.agentBoard.server.starting')}</span>}
        </>
      )}
      {phase === 'waiting' && pending && (
        <div style={box} role="group" aria-labelledby={`${ID}-code-label`} data-testid="agent-board-server-code">
          <div id={`${ID}-code-label`}>{t('settings.agentBoard.server.code.label')}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' }}>
            <output style={codeStyle} aria-label={fillText(t('settings.agentBoard.server.code.spoken'), { code: spaced })}>
              {pending.userCode}
            </output>
            <button ref={copyRef} type="button" className="btn-secondary" onClick={copyCode}>
              {copied ? t('settings.agentBoard.server.code.copied') : t('settings.agentBoard.server.code.copy')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', wordBreak: 'break-all' }}>
            <span>{fillText(t('settings.agentBoard.server.code.address'), { link })}</span>
            {linkOpenable && (
              <button type="button" className="btn-secondary" onClick={openApproval}>
                {t('settings.agentBoard.server.code.open')}
              </button>
            )}
          </div>
          {!pending.opened && (
            <div className="setting-description" style={{ color: WARN, marginTop: 4 }}>
              {t('settings.agentBoard.server.code.notOpened')}
            </div>
          )}
          {/* A timer, not a live region: only step changes are announced. */}
          <div role="timer" aria-live="off" style={{ marginTop: 6 }} data-testid="agent-board-server-waiting">
            {fillText(t('settings.agentBoard.server.code.waiting'), { time: formatRemaining(pending.expiresAt - now) })}
          </div>
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn-secondary" disabled={busy === 'cancel'} onClick={() => void cancelSignIn()}>
              {t('settings.agentBoard.cancel')}
            </button>
          </div>
        </div>
      )}
      {(phase === 'denied' || phase === 'expired' || phase === 'error') && (
        <div style={box} data-testid="agent-board-server-failed">
          <div role="alert" style={{ color: DANGER }}>
            {phase === 'denied'
              ? t('settings.agentBoard.server.denied')
              : phase === 'expired'
                ? t('settings.agentBoard.server.expired')
                : fillText(t('settings.agentBoard.server.failed'), { e: failText || '?' })}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button ref={retryRef} type="button" className="btn-secondary" disabled={!canStart} onClick={() => void signIn()}>
              {t('settings.agentBoard.server.retry')}
            </button>
            <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setPhase('idle')}>
              {t('settings.agentBoard.cancel')}
            </button>
          </div>
          {urlDirty && <div className="setting-description" style={{ color: WARN, marginTop: 4 }}>{t('settings.agentBoard.server.saveFirst')}</div>}
        </div>
      )}
    </>
  );

  const row = (label: TranslationKey, value: string, testId?: string) => (
    <>
      <dt className="setting-description" style={{ margin: 0 }}>{t(label)}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }} data-testid={testId}>{value}</dd>
    </>
  );

  return (
    <div data-testid="agent-board-server" style={{ marginTop: 8 }}>
      <h4 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t('settings.agentBoard.server.title')}</h4>

      <div className="setting-item">
        <label htmlFor={`${ID}-url`}>{t('settings.agentBoard.server.url')}</label>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            id={`${ID}-url`}
            type="url"
            value={urlDraft}
            maxLength={2048}
            placeholder="https://board.example.com"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!urlError && urlError.color === DANGER}
            aria-describedby={`${ID}-url-error ${ID}-url-desc`}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <button type="button" className="btn-secondary" disabled={!urlDirty || !check.ok || signInRunning} onClick={saveUrl}>
            {t('settings.agentBoard.server.url.save')}
          </button>
          <button type="button" className="btn-secondary" disabled={!urlDirty} onClick={() => setUrlDraft(savedUrl)}>
            {t('settings.agentBoard.pg.revert')}
          </button>
        </span>
        <span id={`${ID}-url-error`} className="setting-description" data-testid="agent-board-server-url-error" style={{ color: urlError?.color, minHeight: '1.2em' }}>
          {urlError?.text ?? ''}
        </span>
        <span id={`${ID}-url-desc`} className="setting-description">{t('settings.agentBoard.server.url.desc')}</span>
      </div>

      <div className="setting-item" style={{ alignItems: 'flex-start' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('settings.agentBoard.server.account')}</span>
        {/* A steady minimum height so the switch between steps does not move the page. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 150 }}>
          {status === null ? (
            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="setting-description" style={statusError ? { color: DANGER } : undefined} data-testid="agent-board-server-unread">
                {statusError ? fillText(t('settings.agentBoard.server.checkFailed'), { e: statusError }) : t('settings.agentBoard.server.reading')}
              </span>
              <button type="button" className="btn-secondary" onClick={reload}>
                {t('settings.agentBoard.status.refresh')}
              </button>
            </span>
          ) : status.signedIn ? (
            <>
              <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0, fontSize: 12 }} data-testid="agent-board-server-account">
                {row('settings.agentBoard.server.nickname', status.nickname || '-')}
                {row('settings.agentBoard.server.role', status.role ?? '-')}
                {row('settings.agentBoard.server.computerName', status.computer || '-')}
                {row('settings.agentBoard.server.token', status.tokenPrefix ? fillText(t('settings.agentBoard.server.tokenValue'), { prefix: status.tokenPrefix }) : '-', 'agent-board-server-token')}
                {row('settings.agentBoard.server.signedInServer', status.signedInServer ?? '-')}
                {row('settings.agentBoard.server.held', String(status.heldTasks))}
              </dl>
              {!status.serverMatches && (
                <span className="setting-description" role="note" style={{ color: WARN }} data-testid="agent-board-server-mismatch">
                  {fillText(t('settings.agentBoard.server.mismatch'), { signedIn: status.signedInServer ?? '-', configured: status.server || '-' })}
                </span>
              )}
              {status.suspended && (
                <span className="setting-description" role="note" style={{ color: WARN }} data-testid="agent-board-server-suspended">
                  {suspendedText ? fillText(t('settings.agentBoard.server.suspended'), { until: suspendedText }) : t('settings.agentBoard.server.suspendedNoDate')}
                </span>
              )}
              {status.error && (
                <span className="setting-description" style={{ color: DANGER }}>
                  {fillText(t('settings.agentBoard.server.checkFailed'), { e: status.error })}
                </span>
              )}
              {!status.serverMatches && signInArea}
              {signOutAsk === null ? (
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setSignOutAsk('server')}>
                    {t('settings.agentBoard.server.signOut')}
                  </button>
                  <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setSignOutAsk('local')}>
                    {t('settings.agentBoard.server.signOutLocal')}
                  </button>
                </span>
              ) : (
                <div
                  style={box}
                  role="alertdialog"
                  aria-label={t(signOutAsk === 'server' ? 'settings.agentBoard.server.signOut' : 'settings.agentBoard.server.signOutLocal')}
                  aria-describedby={`${ID}-signout-text`}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && busyRef.current === null) {
                      e.stopPropagation();
                      setSignOutAsk(null);
                    }
                  }}
                >
                  <div id={`${ID}-signout-text`} style={{ color: WARN }}>
                    {fillText(t(signOutAsk === 'server' ? 'settings.agentBoard.server.signOutConfirm' : 'settings.agentBoard.server.signOutLocalConfirm'), {
                      server: status.signedInServer ?? '-',
                      n: status.heldTasks,
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button ref={askRef} type="button" className="btn-secondary" disabled={disabled} onClick={() => void signOut(signOutAsk === 'local')}>
                      {busy === 'signout' ? t('settings.agentBoard.working') : t(signOutAsk === 'server' ? 'settings.agentBoard.server.signOutYes' : 'settings.agentBoard.server.signOutLocal')}
                    </button>
                    <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setSignOutAsk(null)}>
                      {t('settings.agentBoard.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <span data-testid="agent-board-server-signed-out">{t('settings.agentBoard.server.signedOut')}</span>
              {status.error && (
                <span className="setting-description" style={{ color: DANGER }}>
                  {status.error}
                </span>
              )}
              {signInArea}
            </>
          )}
        </div>
      </div>

      {message && (
        <div ref={messageRef} tabIndex={-1} style={{ ...box, whiteSpace: 'pre-wrap', color: message.ok ? 'var(--settings-text)' : DANGER }} role="status" data-testid="agent-board-server-message">
          {message.text}
        </div>
      )}

      <span className="setting-description" role="note" style={{ display: 'block', marginTop: 6 }}>
        {t('settings.agentBoard.server.different')}
      </span>

      <BoardRunnerSettings savedPath={runnerPath} onSavePath={onSaveRunnerPath} savedServerUrl={savedUrl} />
    </div>
  );
}
