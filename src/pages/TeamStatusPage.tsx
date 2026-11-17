// Team status in its own window (label `tool-team-status`, route /team-status?team=&projectId=).
// Reads and a person's actions go through the main window (src/teamStatus/popout.ts), which
// also pushes the agent tabs, limits and the theme of the project that owns the team, and
// forwards board change hints. The header has a pin toggle (always on top, windowPin.ts).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as Icons from 'lucide-react';
import { emitAgentBoardEvent, type AgentBoardEventDetail } from '../terminal/agentBoard';
import { MAIN_WINDOW_LABEL, applyWindowPin, currentPlatform, nativePinFor } from '../window/windowPin';
import { EscapeContext, createEscapeStack } from '../teamStatus/escape';
import { POPOUT_EVENT, isPopoutContext, popoutOnTop, readPopoutQuery, remoteSource, type PopoutContext, type PopoutResponse } from '../teamStatus/popout';
import type { TeamBoardSource } from '../teamStatus/source';
import { makeT } from '../teamStatus/strings';
import { TeamStatusView } from '../teamStatus/TeamStatusView';
import '../teamStatus/teamStatus.css';

const PIN_KEY = 'octo.teamStatus.popoutPinned';
const readPin = () => { try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; } };
const writePin = (on: boolean) => { try { localStorage.setItem(PIN_KEY, on ? '1' : '0'); } catch { /* per-viewer convenience only */ } };

/** Listen to an event sent to this window; the cleanup works even before `listen` resolved. */
function listenHere<T>(event: string, cb: (payload: T) => void): () => void {
  let un: (() => void) | null = null;
  let dead = false;
  getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload)).then((u) => { if (dead) u(); else un = u; }).catch(() => {});
  return () => { dead = true; un?.(); };
}

const toMain = (event: string, payload: Record<string, unknown>) => { void emitTo(MAIN_WINDOW_LABEL, event, payload).catch(() => {}); };

export default function TeamStatusPage() {
  const initial = useMemo(() => readPopoutQuery(window.location.search), []);
  /** Every message to the main window carries the per-open token from the URL. */
  const send = (event: string, payload: Record<string, unknown> = {}) => toMain(event, { ...payload, token: initial.token });
  const [ctx, setCtx] = useState<PopoutContext | null>(null);
  const [source, setSource] = useState<TeamBoardSource | null>(null);
  const [silent, setSilent] = useState(false);
  const [pinned, setPinned] = useState(readPin);
  const escapes = useMemo(() => createEscapeStack(), []);
  /** The team the view shows now (sent with every hello). */
  const teamRef = useRef(initial.team);
  const locale = ctx?.locale || (typeof navigator !== 'undefined' && navigator.language?.startsWith('ko') ? 'ko' : 'en');
  const t = useMemo(() => makeT(locale), [locale]);

  // The source asks the main window (created in the effect so StrictMode's re-run gets a live one).
  useEffect(() => {
    if (!isTauri()) return;
    const s = remoteSource((req) => toMain(POPOUT_EVENT.req, { ...req }), (onRes) => listenHere<PopoutResponse>(POPOUT_EVENT.res, onRes), { token: initial.token });
    setSource(s);
    return () => s.dispose();
  }, []);

  // Context and board hints from the main window. Hello every 2 s until the first context
  // arrives, then every 15 s (a reloaded main window learns this window is still open).
  useEffect(() => {
    if (!isTauri()) return;
    let got = false;
    let timer = 0;
    const offCtx = listenHere<unknown>(POPOUT_EVENT.ctx, (c) => {
      if (!isPopoutContext(c)) return; // malformed: ignored
      got = true;
      setSilent(false);
      setCtx(c);
    });
    const offBoard = listenHere<AgentBoardEventDetail>(POPOUT_EVENT.board, (d) => {
      if (d && typeof d.team === 'string') emitAgentBoardEvent(d);
    });
    let tries = 0;
    const hello = () => {
      send(POPOUT_EVENT.hello, { team: teamRef.current, projectId: initial.projectId });
      tries += 1;
      if (!got && tries === 6) setSilent(true);
      timer = window.setTimeout(hello, got ? 15_000 : 2000);
    };
    hello();
    return () => { offCtx(); offBoard(); window.clearTimeout(timer); };
  }, []);

  // On top = its own pin or the main window's (this window does not follow main's pin through
  // windowPin.ts; it applies both itself, so the two never fight).
  const mainPinned = !!ctx?.mainPinned;
  const top = popoutOnTop(pinned, mainPinned);
  useEffect(() => {
    if (!isTauri()) return;
    void applyWindowPin(getCurrentWebviewWindow(), { alwaysOnTop: top.onTop, followDesktops: false }, nativePinFor(currentPlatform(), (cmd, args) => invoke(cmd, args)));
  }, [top.onTop]);

  // Esc closes the innermost open part (drawer, forms); it never closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escapes.run()) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [escapes]);

  useEffect(() => {
    document.title = t('tab.team');
  }, [t]);

  const theme = ctx?.theme;
  const style = theme
    ? ({ '--bg-color': theme.bg, '--text-color': theme.text, '--accent-color': theme.accent, '--font-family': theme.font } as CSSProperties)
    : undefined;
  const togglePin = () => setPinned((on) => { writePin(!on); return !on; });
  const pin = (
    <>
      {top.fromMain && <span className="ts-muted ts-pin-hint">{t('popout.pinFromMain')}</span>}
      <button type="button" className="ts-btn ts-icon" aria-pressed={pinned} onClick={togglePin} aria-label={pinned ? t('popout.unpin') : t('popout.pin')} title={pinned ? t('popout.unpin') : t('popout.pin')}>
        {pinned ? <Icons.PinOff size={14} aria-hidden="true" /> : <Icons.Pin size={14} aria-hidden="true" />}
      </button>
    </>
  );

  return (
    <EscapeContext.Provider value={escapes}>
      <div className={`ts-popout${theme?.light ? ' light-theme' : ''}`} style={style}>
        <div className="ts-shell">
          {ctx && source ? (
            <TeamStatusView
              source={source}
              locale={locale}
              surface={ctx.surface}
              requested={ctx.team ? { team: ctx.team, nonce: ctx.nonce } : undefined}
              projectId={ctx.projectId}
              projectTeamIds={ctx.projectTeamIds}
              membersOf={(team) => (team === ctx.team ? ctx.members : [])}
              limits={ctx.limits}
              staleMs={ctx.staleMs}
              onJump={(tabId) => send(POPOUT_EVENT.jump, { tabId })}
              onOpenSettings={() => send(POPOUT_EVENT.settings)}
              onCopy={(text) => { void navigator.clipboard?.writeText(text).catch(() => {}); }}
              onTeamChange={(team) => { teamRef.current = team; send(POPOUT_EVENT.team, { team }); }}
              headerActions={pin}
            />
          ) : (
            <div className="ts-popout-wait" role="status">
              {silent ? t('popout.closed') : t('popout.waiting')}
              <div style={{ marginTop: 8 }}>{pin}</div>
            </div>
          )}
        </div>
      </div>
    </EscapeContext.Provider>
  );
}
