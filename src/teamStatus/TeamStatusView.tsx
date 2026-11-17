// Team status: one team at a glance — what needs a person, whether the team is moving, who
// does what, the work, and context (activity, limits, machines). Layout follows the view's
// own width (container queries: wide >= 1200, medium 760-1199, narrow < 760).
// Design: docs/superpowers/specs/2026-11-16-team-status-view-design.md
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import * as Icons from 'lucide-react';
import { formatBoardTime } from '../terminal/agentBoard';
import {
  agentActivity,
  agentLoad,
  bucketCounts,
  buildFeed,
  deriveTaskViews,
  filterViews,
  isDoneEvent,
  needsYou,
  pickDefaultTeam,
  stateBarSentence,
  summarize,
  type DisplayState,
  type LimitUsage,
  type NeedsYouItem,
} from './model';
import { ActivityFeed } from './ActivityFeed';
import { AgentList, type AgentRow } from './AgentList';
import { LimitsCard, MachinesCard } from './LimitsCard';
import { NeedsYouList } from './NeedsYouList';
import { Sparkline, StateBar, StateIcon, TabBar } from './parts';
import { useTeamBoard, type HumanTaskSub, type TeamBoardSource } from './source';
import { AddTaskForm, TaskBoard, TaskFilters, TaskList, emptyFilters, type FilterState } from './TaskArea';
import { TaskDrawer } from './TaskDrawer';
import { DependencyView } from './DependencyView';
import { TimelineView } from './TimelineView';
import { makeT, stateLabel } from './strings';

export interface TeamMember {
  id: string;
  name: string;
  cli?: string;
  status: AgentRow['status'];
  /** The tab is open (jump works). */
  open: boolean;
  since?: number;
  message?: string;
}

export interface TeamStatusViewProps {
  source: TeamBoardSource;
  locale: string;
  surface: 'tinted' | 'neutral';
  /** An entry point asked for this team (nonce changes per request). */
  requested?: { team: string; nonce: number };
  /** Remembers the chosen team per project. */
  projectId: string;
  projectTeamIds: string[];
  membersOf: (team: string) => TeamMember[];
  limits: LimitUsage;
  staleMs: number;
  onJump: (tabId: string) => void;
  onOpenSettings: () => void;
  onCopy: (text: string) => void;
  /** The team shown changed (the overlay remembers it for the pop-out; the pop-out tells the main window). */
  onTeamChange?: (team: string) => void;
  /** Extra controls at the end of the header (the pop-out's pin toggle). */
  headerActions?: ReactNode;
}

type Layout = 'wide' | 'medium' | 'narrow';
type MainTab = 'board' | 'list' | 'deps' | 'timeline' | 'activity' | 'agents' | 'tasks' | 'limits';

const layoutOf = (w: number): Layout => (w >= 1200 ? 'wide' : w >= 760 ? 'medium' : 'narrow');

/** The view's own width bucket and board columns (ResizeObserver; wide where it is missing, e.g. tests). */
function useLayout(ref: RefObject<HTMLElement | null>): { layout: Layout; columns: 3 | 5 } {
  const [layout, setLayout] = useState<Layout>('wide');
  const [columns, setColumns] = useState<3 | 5>(5);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = (w: number) => {
      if (w <= 0) return;
      setLayout(layoutOf(w));
      setColumns(w < 900 ? 3 : 5);
    };
    const ro = new ResizeObserver((entries) => apply(entries[0]?.contentRect.width ?? el.clientWidth));
    ro.observe(el);
    apply(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { layout, columns };
}

const TEAM_KEY = (projectId: string) => `octo.teamStatus.team:${projectId}`;
const readStore = (k: string) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const writeStore = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } };

export const ONBOARD_COMMAND = 'node "$BBARIT_CTL" agent run claude --name reviewer "Review the last commit and report back"';

export function TeamStatusView(props: TeamStatusViewProps) {
  const { source, locale, projectId, membersOf, onJump } = props;
  const t = useMemo(() => makeT(locale), [locale]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { layout, columns } = useLayout(rootRef);
  const [team, setTeam] = useState(() => props.requested?.team || readStore(TEAM_KEY(projectId)));
  const board = useTeamBoard(source, team);
  const now = Date.now();

  // An entry point (badge, stop-team-side button) asked for a team.
  const requestNonce = props.requested?.nonce ?? 0;
  useEffect(() => {
    if (props.requested?.team) setTeam(props.requested.team);
  }, [requestNonce]);

  // Settle on a team once the list is known (never while the board is unavailable).
  const teamIdsKey = board.teams.map((x) => x.team).join(',');
  useEffect(() => {
    if (board.error || board.loading && !board.teams.length) return;
    if (team && board.teams.some((x) => x.team === team)) return;
    const next = pickDefaultTeam(board.teams, props.projectTeamIds, readStore(TEAM_KEY(projectId)));
    if (next !== team) setTeam(next);
  }, [teamIdsKey, board.error, board.loading]);

  useEffect(() => { if (team) writeStore(TEAM_KEY(projectId), team); }, [team, projectId]);
  const onTeamChangeRef = useRef(props.onTeamChange);
  onTeamChangeRef.current = props.onTeamChange;
  useEffect(() => { if (team) onTeamChangeRef.current?.(team); }, [team]);

  // Filters reset when the team changes.
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [drawer, setDrawer] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => { setFilters(emptyFilters()); setDrawer(null); setAdding(false); setActionError(''); }, [team]);

  const info = board.info;
  const teamRow = board.teams.find((x) => x.team === team);
  const mirror = info?.mode === 'sync' && !!teamRow?.homeHost && !!info?.host && teamRow.homeHost !== info.host;
  const snap = board.snapshot?.team === team ? board.snapshot : null;
  const nowBucket = Math.floor(now / 30_000);
  const views = useMemo(() => (snap ? deriveTaskViews(snap.tasks, now, props.staleMs, { mirror }) : []), [snap, props.staleMs, mirror, nowBucket]);
  const summary = useMemo(() => summarize(views), [views]);
  const members = team ? membersOf(team) : [];
  const agentStates = members.map((m) => ({ id: m.id, name: m.name, status: m.status, since: m.since, message: m.message }));
  // Limit refusals of this team only: the refused caller is one of its tabs.
  const memberIds = new Set(members.map((m) => m.id));
  const items: NeedsYouItem[] = needsYou(views, agentStates, board.refusals, now, { mirror, members: memberIds });
  const load = agentLoad(views, members.map((m) => m.id));
  const rows: AgentRow[] = members.map((m) => {
    const act = agentActivity(m.id, snap?.events || [], snap?.posts || [], now);
    return { ...m, held: load[m.id], activity: act.series, lastAt: act.lastAt };
  });
  const feed = useMemo(() => buildFeed(snap?.events || [], snap?.posts || [], 50), [snap]);
  const doneSeries = bucketCounts(snap?.events || [], isDoneEvent, now, 10 * 60_000, 12);
  /** This team's live agents, root tab left out (the limits card shows the app-wide total/max). */
  const live = members.filter((m) => m.id !== team && m.open && m.status !== 'exited').length;

  // Needs-you changes: one tint fade for new items (not on first load) and a polite
  // announcement at most once per 10 s.
  const itemsKey = items.map((i) => i.key).join('|');
  const prevKeysRef = useRef<Set<string> | null>(null);
  const lastAnnounceRef = useRef(0);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [liveText, setLiveText] = useState('');
  useEffect(() => {
    const keys = new Set(items.map((i) => i.key));
    const prev = prevKeysRef.current;
    prevKeysRef.current = keys;
    if (!prev || !snap) return;
    const added = items.filter((i) => !prev.has(i.key));
    if (!added.length) return;
    setFresh(new Set(added.map((i) => i.key)));
    const timer = window.setTimeout(() => setFresh(new Set()), 700);
    if (Date.now() - lastAnnounceRef.current >= 10_000) {
      lastAnnounceRef.current = Date.now();
      const first = added[0];
      setLiveText(t('needs.live', { what: first.seq !== undefined ? `${stateLabel(locale, first.kind === 'refusal' ? 'open' : first.kind === 'blockedAgent' ? 'blocked' : first.kind)} #${first.seq}` : first.title }));
    }
    return () => window.clearTimeout(timer);
  }, [itemsKey]);
  useEffect(() => { prevKeysRef.current = null; }, [team]);

  // "Loading team board..." only after 300 ms.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!board.loading) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), 300);
    return () => window.clearTimeout(timer);
  }, [board.loading]);

  const [mainTab, setMainTab] = useState<MainTab>('board');
  const depsTab = { key: 'deps' as const, label: t('view.deps') };
  const timelineTab = { key: 'timeline' as const, label: t('view.timeline') };
  const mainTabs: Array<{ key: MainTab; label: string }> = layout === 'narrow'
    ? [{ key: 'agents', label: t('view.agents') }, { key: 'tasks', label: t('view.tasks') }, { key: 'activity', label: t('view.activity') }, depsTab, timelineTab, { key: 'limits', label: t('view.limits') }]
    : layout === 'medium'
      ? [{ key: 'board', label: t('view.board') }, { key: 'list', label: t('view.list') }, depsTab, timelineTab, { key: 'activity', label: t('view.activity') }]
      : [{ key: 'board', label: t('view.board') }, { key: 'list', label: t('view.list') }, depsTab, timelineTab];
  const tab: MainTab = mainTabs.some((x) => x.key === mainTab) ? mainTab : mainTabs[0].key;

  const act = async (seq: number | undefined, sub: HumanTaskSub, request: Record<string, unknown> = {}): Promise<boolean> => {
    const r = await source.act(team, sub, seq === undefined ? request : { ...request, task: seq });
    if (!r.ok) { setActionError(t('error.action', { error: r.error })); return false; }
    setActionError('');
    board.refresh();
    return true;
  };
  const jump = (id: string) => onJump(id);
  const toggleState = (s: DisplayState) => {
    const states = new Set(filters.states);
    if (states.has(s)) states.delete(s); else states.add(s);
    setFilters({ ...filters, states });
  };
  const shown = filterViews(views, filters);
  const labels = [...new Set(views.flatMap((v) => v.labels))].sort();
  const owners = [...new Map(views.filter((v) => v.ownerId).map((v) => [v.ownerId!, { id: v.ownerId!, name: v.ownerName || v.ownerId! }])).values()];
  const drawerView = drawer !== null ? views.find((v) => v.seq === drawer) : undefined;
  const readOnly = mirror || !!board.error;
  const greyed = !!board.error && !!snap;
  const sentence = stateBarSentence(summary, (s) => stateLabel(locale, s), (n) => t('summary.tasks', { n }));

  // ── States of the view (section 7) ──
  const noTeam = !board.loading && !board.error && !team && board.teams.length === 0;

  const banner = board.error ? (
    <div className="ts-banner" role="alert">
      <Icons.CircleX size={14} aria-hidden="true" style={{ color: 'var(--ts-failed)' }} />
      <span className="ts-banner-text">{t('unavailable', { reason: board.error })}</span>
      <button type="button" className="ts-btn" onClick={board.refresh}>{t('retry')}</button>
      <button type="button" className="ts-btn" onClick={props.onOpenSettings}>{t('openSettings')}</button>
    </div>
  ) : null;

  const header = (
    <div className="ts-header">
      <span className="ts-title">{t('team')}</span>
      <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label={t('team.select')} disabled={!board.teams.length}>
        {!board.teams.some((x) => x.team === team) && <option value={team}>{team || '-'}</option>}
        {board.teams.map((x) => <option key={x.team} value={x.team}>{x.teamName ? `${x.teamName} (${x.team.slice(0, 10)})` : x.team}</option>)}
      </select>
      {team && <span className="ts-machine">{t('team.root', { id: team.slice(0, 10) })}</span>}
      <span className="ts-machine ts-wide-only">· {info?.mode === 'postgres' ? t('machine.postgres') : info?.mode === 'sync' ? t('machine.sync') : t('machine.local')}</span>
      <span className="ts-spacer" />
      {greyed && snap && <span className="ts-asof">{t('asof', { time: formatBoardTime(snap.at, now) })}</span>}
      {props.headerActions}
    </div>
  );

  const summaryStrip = (
    <section className="ts-card ts-summary" aria-label={t('summary.label')}>
      <div className="ts-tiles">
        <div className="ts-tile"><span className="ts-tile-label">{t('summary.agents')}</span><span className="ts-tile-value">{live}</span></div>
        {(['claimed', 'waiting', 'review', 'failed'] as const).filter((s) => summary.counts[s] > 0).map((s) => (
          <div className="ts-tile" key={s} data-state={s}><span className="ts-tile-label"><StateIcon state={s} />{stateLabel(locale, s)}</span><span className="ts-tile-value">{summary.counts[s]}</span></div>
        ))}
        <div className="ts-tile" data-state="done">
          <span className="ts-tile-label"><StateIcon state="done" />{stateLabel(locale, 'done')}</span>
          <span className="ts-tile-value">{summary.counts.done}<span style={{ color: 'var(--ts-done)' }}><Sparkline values={doneSeries} label={`${t('summary.doneSpark')}: ${doneSeries.join(', ')}`} /></span></span>
        </div>
      </div>
      <div className="ts-sentence">
        {t('summary.sentence', { live, parts: (['claimed', 'waiting', 'review', 'failed', 'done'] as const).map((s) => `${summary.counts[s]} ${stateLabel(locale, s)}`).join(' · ') })}
      </div>
      <StateBar summary={summary} sentence={sentence} active={filters.states} onToggle={toggleState} locale={locale} t={t} />
    </section>
  );

  const needs = (
    <section className="ts-card" aria-labelledby="ts-needs-title">
      <h2 className="ts-card-title" id="ts-needs-title">{t('needs.title')} <span className="ts-count">{items.filter((i) => i.actionable).length}</span></h2>
      <NeedsYouList items={items} fresh={fresh} now={now} locale={locale} t={t} readOnly={readOnly} onAct={(seq, sub, req) => act(seq, sub, req)} onOpen={setDrawer} onJump={jump} />
    </section>
  );

  const agentsCard = (
    <section className="ts-card" aria-labelledby="ts-agents-title">
      <h2 className="ts-card-title" id="ts-agents-title">{t('agents.title')} <span className="ts-count">{rows.length}</span></h2>
      <AgentList rows={rows} now={now} locale={locale} t={t} onJump={jump} />
    </section>
  );

  const activity = <ActivityFeed entries={feed} now={now} locale={locale} t={t} readOnly={readOnly} onOpen={setDrawer} onPost={(text) => source.postNote(team, text)} draftKey={team} />;
  const limitsCard = <LimitsCard usage={props.limits} refusals={board.refusals} now={now} locale={locale} t={t} />;

  const taskBody = (narrow: boolean) => {
    if (!snap) {
      return board.loading ? <div className="ts-board" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="ts-card ts-skeleton" />)}</div> : null;
    }
    if (!views.length) return <div className="ts-hint">{t('noTasks')}</div>;
    if (tab === 'deps') return <DependencyView visible={shown} all={views} narrow={layout === 'narrow'} locale={locale} t={t} onOpen={setDrawer} />;
    if (narrow || tab === 'list') return <TaskList views={shown} showCancelled={filters.showCancelled} now={now} locale={locale} t={t} onOpen={setDrawer} />;
    return <TaskBoard views={shown} columns={columns} showCancelled={filters.showCancelled} now={now} locale={locale} t={t} onOpen={setDrawer} />;
  };

  const taskArea = (narrow: boolean) => (
    <div className={`ts-task-area${greyed ? ' ts-greyed' : ''}`}>
      <div className="ts-filters">
        <TaskFilters filters={filters} onChange={setFilters} agents={owners} labels={labels} locale={locale} t={t} />
        <span className="ts-spacer" style={{ flex: 1 }} />
        {!readOnly && team && <button type="button" className="ts-btn" onClick={() => setAdding((v) => !v)}><Icons.Plus size={12} aria-hidden="true" />{t('act.addTask')}</button>}
      </div>
      {adding && <AddTaskForm t={t} onAdd={async (req) => { const r = await source.act(team, 'add', req); if (r.ok) board.refresh(); return r; }} onDone={() => setAdding(false)} />}
      {taskBody(narrow)}
    </div>
  );

  let main: ReactNode;
  if (tab === 'activity') main = <section className="ts-card">{activity}</section>;
  else if (tab === 'agents') main = agentsCard;
  else if (tab === 'limits') main = <>{limitsCard}<MachinesCard mode={info?.mode} t={t} onOpenSettings={props.onOpenSettings} /></>;
  else if (tab === 'timeline') main = snap ? <TimelineView team={team} events={snap.events} tasks={snap.tasks} now={now} locale={locale} t={t} /> : null;
  else main = taskArea(tab === 'tasks');

  return (
    <div ref={rootRef} className="team-status" data-surface={props.surface} data-layout={layout}>
      <div className="ts-sr" aria-live="polite">{liveText}</div>
      <div className="ts-view">
        {header}
        {banner}
        {noTeam ? (
          <div className="ts-empty ui-empty-state">
            <Icons.Users size={28} aria-hidden="true" />
            <strong>{t('empty.title')}</strong>
            <span className="ts-muted">{t('empty.body')}</span>
            <code>{ONBOARD_COMMAND}</code>
            <button type="button" className="ts-btn" onClick={() => props.onCopy(ONBOARD_COMMAND)}><Icons.Copy size={12} aria-hidden="true" />{t('empty.copy')}</button>
          </div>
        ) : (
          <>
            {!snap && board.loading && slow && <div className="ts-muted">{t('loading')}</div>}
            {actionError && <div className="ts-error" role="alert">{actionError}</div>}
            <div className={greyed ? 'ts-greyed' : undefined}>{summaryStrip}</div>
            <div className="ts-grid">
              <div className="ts-area-needs">{needs}</div>
              {layout !== 'narrow' && <div className="ts-area-agents">{agentsCard}</div>}
              <div className="ts-area-main">
                <div className="ts-card">
                  <TabBar tabs={mainTabs} value={tab} onChange={setMainTab} label={t('tab.team')} idBase="ts-main" className="ts-subtabs" />
                  <div id="ts-main-panel" role="tabpanel" aria-labelledby={`ts-main-tab-${tab}`} style={{ marginTop: 8 }}>{main}</div>
                </div>
              </div>
              {/* Cards hidden in this layout are not rendered (no hidden tab stops, no duplicate ids). */}
              {layout !== 'narrow' && (
                <div className="ts-area-band">
                  {layout === 'wide' && (
                    <section className="ts-card ts-activity-card" aria-labelledby="ts-activity-title">
                      <h2 className="ts-card-title" id="ts-activity-title">{t('activity.title')} <span className="ts-muted">{t('activity.latest', { n: 50 })}</span></h2>
                      {activity}
                    </section>
                  )}
                  {limitsCard}
                  <MachinesCard mode={info?.mode} t={t} onOpenSettings={props.onOpenSettings} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {drawerView && (
        <TaskDrawer
          view={drawerView}
          all={views}
          team={team}
          refreshKey={String(snap?.at ?? 0)}
          source={source}
          now={now}
          locale={locale}
          t={t}
          readOnly={readOnly}
          onAct={(seq, sub, req) => act(seq, sub, req)}
          onClose={() => setDrawer(null)}
          onJump={jump}
        />
      )}
    </div>
  );
}
