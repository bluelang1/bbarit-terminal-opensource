// The toolbar gauge overlay: tabs [Team status | Dashboard] in the app's modal shell (2px
// line + hard shadow), the last tab remembered. A dialog: focus moves in on open, Tab stays
// inside, Esc closes the innermost open part first, then the overlay (capture phase, so it
// never reaches the terminal as \x1b). The Dashboard iframe stays mounted (hidden) once
// opened, so switching tabs does not reload it. Team status can open in its own window
// (pop-out); while it is open there, this tab shows that with [Bring to front]. With the agent
// team turned off (Settings → "Agent team in tabs", `teamEnabled` false) only Dashboard is shown.
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useDialogFocus } from '../a11y/dialogFocus';
import { DashboardContent } from '../dashboard/DashboardPanel';
import { EscapeContext, createEscapeStack } from './escape';
import { TabBar } from './parts';
import { makeT } from './strings';
import { TeamStatusView, type TeamStatusViewProps } from './TeamStatusView';
import './teamStatus.css';

export type GaugeTab = 'team' | 'dashboard';

const TAB_KEY = 'octo.gauge.tab';

export function readGaugeTab(): GaugeTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'dashboard' ? 'dashboard' : 'team';
  } catch {
    return 'team';
  }
}

export function TeamStatusOverlay({ teamEnabled = true, initialTab, onClose, onOpenExternal, onTabChange, restoreFocus, poppedOut, onPopOut, onBringToFront, view }: {
  /** Agent team on (config agents.enabled). False: no Team status tab; opens on Dashboard. */
  teamEnabled?: boolean;
  /** Opened from a team entry point: the Team status tab; otherwise the last tab used. */
  initialTab?: GaugeTab;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  /** The tab shown (the App reads the team board only for Team status). */
  onTabChange?: (tab: GaugeTab) => void;
  /** False when the overlay closes because focus moved on purpose (jump to a tab). */
  restoreFocus?: () => boolean;
  /** Team status is open in its own window. */
  poppedOut?: boolean;
  /** Open Team status in its own window. */
  onPopOut?: () => void;
  onBringToFront?: () => void;
  view: TeamStatusViewProps;
}) {
  const t = useMemo(() => makeT(view.locale), [view.locale]);
  const [chosenTab, setTabState] = useState<GaugeTab>(() => (teamEnabled ? initialTab || readGaugeTab() : 'dashboard'));
  // Turned off while open: Dashboard; the remembered tab is left as it was.
  const tab: GaugeTab = teamEnabled ? chosenTab : 'dashboard';
  const openedOnDashboard = useRef(tab === 'dashboard').current;
  const [dashboardMounted, setDashboardMounted] = useState(tab === 'dashboard');
  if (tab === 'dashboard' && !dashboardMounted) setDashboardMounted(true);
  const setTab = (next: GaugeTab) => {
    setTabState(next);
    if (next === 'dashboard') setDashboardMounted(true);
    try { localStorage.setItem(TAB_KEY, next); } catch { /* per-viewer convenience only */ }
  };
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;
  useEffect(() => { onTabChangeRef.current?.(tab); }, [tab]);

  const escapes = useMemo(() => createEscapeStack(), []);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useDialogFocus(boxRef, true, {
    initialFocus: () => (tab === 'dashboard' ? null : boxRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null),
    onEscape: () => { if (!escapes.run()) onClose(); },
    restoreFocus,
  });

  return (
    <EscapeContext.Provider value={escapes}>
      <div className="panel-modal-overlay ts-overlay" data-kbd-region="panel" onMouseDown={onClose}>
        <div
          ref={boxRef}
          className="panel-modal-container ts-shell"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ts-shell-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="ts-shell-bar">
            <span id="ts-shell-title" className="ts-sr">{t('shell.label')}</span>
            <TabBar
              tabs={teamEnabled
                ? [{ key: 'team', label: t('tab.team') }, { key: 'dashboard', label: t('tab.dashboard') }]
                : [{ key: 'dashboard', label: t('tab.dashboard') }]}
              value={tab}
              onChange={setTab}
              label={t('shell.label')}
              idBase="ts-shell"
            />
            <span style={{ flex: 1 }} />
            {tab === 'team' && onPopOut && !poppedOut && (
              <button type="button" className="ts-btn" onClick={onPopOut} title={t('popout.open')}>
                <Icons.ExternalLink size={12} aria-hidden="true" />{t('popout.open')}
              </button>
            )}
            <button type="button" className="ts-btn ts-icon" onClick={onClose} aria-label={t('close')} title={t('close')}><Icons.X size={14} /></button>
          </div>
          <div className="ts-shell-body" id="ts-shell-panel" role="tabpanel" aria-labelledby={`ts-shell-tab-${tab}`}>
            {tab === 'team' && (poppedOut ? (
              <div className="team-status" data-surface={view.surface}>
                <div className="ts-popped">
                  <Icons.ExternalLink size={24} aria-hidden="true" />
                  <span>{t('popout.isOpen')}</span>
                  <button type="button" className="ts-btn ts-primary" onClick={onBringToFront}>{t('popout.front')}</button>
                </div>
              </div>
            ) : <TeamStatusView {...view} />)}
            {dashboardMounted && (
              <div className="ts-dashboard" hidden={tab !== 'dashboard'}>
                <DashboardContent onClose={onClose} onOpenExternal={onOpenExternal} autoFocus={openedOnDashboard} />
              </div>
            )}
          </div>
        </div>
      </div>
    </EscapeContext.Provider>
  );
}
