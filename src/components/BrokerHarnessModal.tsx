import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FolderOpen, Loader2, X } from 'lucide-react';
import { isHarnessInReviewLoop } from '../devreview/devReviewPair';
import type { BrokerStatusSnapshot, DevReviewRole } from '../devreview/devReviewPair';
import type { BrokerHarnessLifecycle } from '../devreview/brokerSessionStore';
import { HARNESS_SOURCE_MAP } from '../devreview/harnessSourceMap';
import { OctoAntler, OctoPencil, OctoPlus, OctoX } from '../octoIcons';
import { BrokerStatusPanel } from './BrokerStatusPanel';

export interface BrokerHarness {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  developer: DevReviewRole;
  reviewer: DevReviewRole;
  developerId: string;
  reviewerId: string;
  branch?: string;
  worktreeDir?: string;
  status?: BrokerStatusSnapshot;
  log?: { kind: string; message: string }[];
  manualName?: boolean;
  lastPrompt?: string;
  createdAt: number;
  lifecycle?: BrokerHarnessLifecycle;
  lastHeartbeatAt?: number;
  lastAttachedAt?: number;
  restoreFailureCount?: number;
}

const STAGE_ACCENT: Record<string, string> = {
  developing: '#2ea043',
  dev_done: '#3fb950',
  reviewing: '#a371f7',
  review_done: '#bc8cff',
  addressing: '#d29922',
  approved: '#1f6feb',
  merging: '#1f6feb',
  merged: '#2ea043',
  merge_failed: '#f85149',
};
const SUSPENDED_ACCENT = '#8b949e';

const REVIEW_FEED_REL = 'docs/wiki/decisions/broker-review-feed.md';

type SummaryTone = 'idle' | 'work' | 'review' | 'warn' | 'done';

const TWO_STATE = (cycle: string | undefined, lang: 'en' | 'ko') => {
  if (cycle === 'merged') return lang === 'ko' ? '완료' : 'Done';
  if (cycle === 'merge_failed') return lang === 'ko' ? '차단' : 'Blocked';
  if (cycle === 'approved' || cycle === 'merging') return lang === 'ko' ? '병합' : 'Merge';
  if (cycle === 'reviewing' || cycle === 'dev_done' || cycle === 'review_done') return lang === 'ko' ? '리뷰' : 'Review';
  if (cycle === 'addressing') return lang === 'ko' ? '재작업' : 'Rework';
  return lang === 'ko' ? '개발' : 'Build';
};

function isRunningHarness(harness: BrokerHarness): boolean {
  if (
    harness.lifecycle === 'complete'
    || harness.lifecycle === 'blocked'
    || harness.lifecycle === 'suspended'
    || harness.lifecycle === 'resume_pending'
    || harness.lifecycle === 'reattaching'
  ) return false;
  const cycle = harness.status?.cycle;
  return cycle !== 'merged' && cycle !== 'merge_failed';
}

function harnessAccent(harness: Pick<BrokerHarness, 'status' | 'lifecycle'>): string {
  if (harness.lifecycle === 'suspended') return SUSPENDED_ACCENT;
  const cycle = harness.status?.cycle;
  return (cycle && STAGE_ACCENT[cycle]) || '#a371f7';
}

function lifecycleLabel(lifecycle: BrokerHarnessLifecycle | undefined, lang: 'en' | 'ko'): string {
  const ko = lang === 'ko';
  if (lifecycle === 'resume_pending') return ko ? '복구 대기' : 'Resume pending';
  if (lifecycle === 'reattaching') return ko ? '재연결 중' : 'Reattaching';
  if (lifecycle === 'blocked') return ko ? '차단' : 'Blocked';
  if (lifecycle === 'complete') return ko ? '완료' : 'Complete';
  if (lifecycle === 'suspended') return ko ? '중지됨' : 'Suspended';
  return ko ? '작업 중' : 'Active';
}

function harnessStageLabel(harness: Pick<BrokerHarness, 'status' | 'lifecycle'>, lang: 'en' | 'ko'): string {
  if (harness.lifecycle === 'suspended') return lang === 'ko' ? '중지됨' : 'Suspended';
  if (harness.status?.cycle) return TWO_STATE(harness.status.cycle, lang);
  if (harness.lifecycle === 'resume_pending') return lang === 'ko' ? '기록 복구' : 'Restored';
  if (harness.lifecycle === 'reattaching') return lang === 'ko' ? '재연결 중' : 'Reattaching';
  if (harness.lifecycle === 'complete') return lang === 'ko' ? '완료' : 'Done';
  if (harness.lifecycle === 'blocked') return lang === 'ko' ? '차단' : 'Blocked';
  return lang === 'ko' ? '시작 대기' : 'Pending';
}

function heartbeatLabel(lastHeartbeatAt: number | undefined, lang: 'en' | 'ko'): string | null {
  if (!lastHeartbeatAt) return null;
  const elapsed = Math.max(0, Date.now() - lastHeartbeatAt);
  const ko = lang === 'ko';
  if (elapsed < 60_000) return ko ? '방금 갱신' : 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return ko ? `${minutes}분 전` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return ko ? `${hours}시간 전` : `${hours}h ago`;
}

function classifyLog(kind: string, message: string, ko: boolean): { actor: string; tone: SummaryTone; text: string } {
  const lower = message.toLowerCase();
  let actor = ko ? '브로커' : 'Broker';
  let tone: SummaryTone = kind === 'error' ? 'warn' : 'idle';
  if (lower.includes('merge failed')) {
    tone = 'warn';
  } else if (lower.includes('auto merge complete') || lower.includes('merged')) {
    tone = 'done';
  } else if (lower.includes('rework') || lower.includes('approved') || lower.includes(REVIEW_FEED_REL.toLowerCase())) {
    actor = ko ? '검토 에이전트' : 'Review agent';
    tone = lower.includes('approved') ? 'done' : lower.includes('rework') ? 'warn' : 'review';
  } else if (lower.includes('done') || lower.includes('developer')) {
    actor = ko ? '개발 에이전트' : 'Dev agent';
    tone = 'work';
  } else if (kind === 'relay') {
    tone = 'review';
  }
  return { actor, tone, text: message.replace(/^\[BROKER\]\s*/, '').replace(/\s+/g, ' ').trim() };
}

function reviewerWaitMessage(cycle: string | undefined, ko: boolean): string | null {
  if (cycle === 'developing') {
    return ko
      ? '검토 에이전트는 대기 중입니다. 개발 에이전트가 DONE을 남기고 diff가 생기면 브로커가 자동으로 검토를 요청합니다.'
      : 'Review agent is intentionally idle. The broker will request review after the dev agent writes DONE and there is a diff.';
  }
  if (cycle === 'dev_done' || cycle === 'reviewing') {
    return ko
      ? '검토 에이전트에게 검토 요청이 전달되었습니다. 리뷰 피드의 APPROVED 또는 REWORK를 기다리는 중입니다.'
      : 'Review has been requested. Waiting for APPROVED or REWORK in the review feed.';
  }
  if (cycle === 'addressing') {
    return ko
      ? '검토 에이전트가 REWORK를 냈습니다. 개발 에이전트가 수정 후 다시 DONE을 남겨야 합니다.'
      : 'Review agent requested REWORK. Waiting for the dev agent to fix it and write DONE again.';
  }
  return null;
}

export function BrokerHarnessModal({
  open,
  harnesses,
  projects,
  selectedId,
  terminalArea,
  lang,
  closeOnBackdrop = true,
  onSelect,
  onClose,
  onStopHarness,
  onCreateHarness,
  creating = false,
  onRollback,
  onRequestRework,
  onResetReviewFeed,
  onRestartAgents,
  onCleanupProjectDevProcesses,
  onRename,
}: {
  open: boolean;
  harnesses: BrokerHarness[];
  projects: { id: string; name: string; workDir?: string; isGitRepo?: boolean }[];
  selectedId: string | null;
  terminalArea: ReactNode;
  lang: 'en' | 'ko';
  closeOnBackdrop?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  onStopHarness: (id: string) => void;
  onCreateHarness: (projectId: string) => void;
  creating?: boolean;
  onRollback?: (id: string) => Promise<boolean>;
  onRequestRework?: (id: string) => Promise<boolean>;
  onResetReviewFeed?: (id: string) => Promise<boolean>;
  onRestartAgents?: (id: string) => Promise<boolean>;
  onCleanupProjectDevProcesses?: (id: string) => Promise<number>;
  onRename: (id: string, name: string) => void;
}) {
  const ko = lang === 'ko';
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [treeHidden, setTreeHidden] = useState(false);
  const [compact, setCompact] = useState(false);
  const [sourceMapOpen, setSourceMapOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cleaningHarnessId, setCleaningHarnessId] = useState<string | null>(null);
  const selected = harnesses.find((harness) => harness.id === selectedId) || null;
  const runningCount = harnesses.filter(isRunningHarness).length;
  const labels = {
    close: ko ? '닫기' : 'Close',
    newHarness: ko ? '이 프로젝트에서 새 하네스 시작' : 'New harness on this project',
    starting: ko ? '시작 중…' : 'Starting…',
    openRename: ko ? '클릭해서 열기 · 두 번 클릭해서 이름 변경' : 'Click to open · double-click to rename',
    rename: ko ? '이름 변경' : 'Rename',
    stop: ko ? '하네스 중지' : 'Stop harness',
    hideTree: ko ? '하네스 목록 숨기기' : 'Hide harness list',
    showTree: ko ? '하네스 목록 보기' : 'Show harness list',
    compact: ko ? '화면 줄이기' : 'Compact view',
    expand: ko ? '전체 화면' : 'Full view',
    sources: ko ? '하네스 소스 보기' : 'Show harness sources',
    hideSources: ko ? '하네스 소스 숨기기' : 'Hide harness sources',
    gitRequired: ko ? '브로커 하네스는 Git 저장소 프로젝트에서만 시작할 수 있습니다.' : 'Broker Harness requires a Git repository project.',
  };
  const firstProject = projects[0] || null;
  const isStartableProject = (project: { isGitRepo?: boolean }) => project.isGitRepo !== false;
  const firstStartableProject = projects.find(isStartableProject) || null;
  const allProjectsCheckedNonGit = projects.length > 0 && projects.every((project) => project.isGitRepo === false);
  const byProject = (projectId: string) => harnesses
    .filter((harness) => harness.projectId === projectId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const selectedSuspended = selected?.lifecycle === 'suspended';
  const selAccent = selected ? harnessAccent(selected) : '#a371f7';
  const timeline = selected?.log?.slice(-16).map((entry) => classifyLog(entry.kind, entry.message, ko)) || [];
  const selectedResting = selectedSuspended || selected?.lifecycle === 'complete' || selected?.lifecycle === 'blocked';
  const reviewerHint = selectedResting ? null : reviewerWaitMessage(selected?.status?.cycle, ko);
  const selectedHeartbeat = heartbeatLabel(selected?.lastHeartbeatAt, lang);
  const selectedComplete = selected?.lifecycle === 'complete' || selected?.status?.cycle === 'merged';
  const selectedBlocked = selected?.lifecycle === 'blocked' || selected?.status?.cycle === 'merge_failed';
  // The manual rework/reset/restart controls cover ONLY the dev↔review loop. Hide them once a
  // review is approved/merging (the broker has queued the merge — a one-way door) or the harness
  // is resting. Shares the pure isHarnessInReviewLoop predicate with the App-side Restart guard
  // and the relay-loop no-op guards, so all four agree.
  const showReviewLoopControls = !!selected && isHarnessInReviewLoop(selected.status?.cycle, selected.lifecycle);
  const showSelectedStatusPanel = !!selected?.status && !selectedSuspended;
  const brokerLogRef = useRef<HTMLDivElement | null>(null);

  // Manual injection was removed: live verification confirmed the broker auto-briefs
  // and auto-relays once the agent CLIs are up (idle-debounce readiness + CR submit),
  // so hand-typing briefings into terminals is no longer needed.

  useEffect(() => {
    if (!open) return;
    const el = brokerLogRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedId, selected?.log?.length, selected?.status?.reason, selected?.status?.cycle]);

  if (!open) return null;

  return (
    <div className="bhm-overlay" onClick={closeOnBackdrop ? onClose : undefined}>
      <div className={`bhm-modal${compact ? ' bhm-compact' : ''}`} onClick={(event) => event.stopPropagation()}>
        <div className="bhm-header">
          <span className="bhm-title"><OctoAntler size={18} /> {ko ? '브로커 하네스' : 'Broker Harnesses'} <span className="beta-badge">BETA</span></span>
          <span className="bhm-count">{runningCount} {ko ? '실행 중' : 'running'} / {harnesses.length} {ko ? '전체' : 'total'}</span>
          {firstProject && (
            <button
              type="button"
              className={`bhm-header-new ui-button ui-button-primary${creating ? ' creating' : ''}${firstStartableProject ? '' : ' no-git'}`}
              title={creating ? labels.starting : (firstStartableProject ? labels.newHarness : labels.gitRequired)}
              disabled={creating || !firstStartableProject}
              onClick={() => { if (firstStartableProject) onCreateHarness(firstStartableProject.id); }}
            >
              {creating ? <Loader2 size={15} className="bhm-spin" /> : <OctoPlus size={15} />}
              <span>{creating ? (ko ? '시작 중' : 'Starting') : (ko ? '새 하네스' : 'New Harness')}</span>
            </button>
          )}
          <button
            type="button"
            className="bhm-lang"
            aria-pressed={sourceMapOpen}
            title={sourceMapOpen ? labels.hideSources : labels.sources}
            onClick={() => setSourceMapOpen((value) => !value)}
          >
            Sources
          </button>
          <button
            type="button"
            className="bhm-lang"
            aria-pressed={compact}
            title={compact ? labels.expand : labels.compact}
            onClick={() => setCompact((value) => !value)}
          >
            {compact ? (ko ? '전체' : 'Full') : (ko ? '축소' : 'Compact')}
          </button>
          <button
            type="button"
            className="bhm-lang"
            aria-pressed={treeHidden}
            title={treeHidden ? labels.showTree : labels.hideTree}
            onClick={() => setTreeHidden((value) => !value)}
          >
            {treeHidden ? (ko ? '목록 보기' : 'Show list') : (ko ? '목록 숨김' : 'Hide list')}
          </button>
          <button type="button" className="modal-close-btn" onClick={onClose} title={labels.close} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="bhm-body">
          {!treeHidden && (
            <div className="bhm-tree">
              {projects.map((project) => {
                const items = byProject(project.id);
                const isCollapsed = collapsed[project.id];
                const canStart = isStartableProject(project);
                const projectStartTitle = creating
                  ? labels.starting
                  : canStart
                    ? labels.newHarness
                    : labels.gitRequired;
                return (
                  <div key={project.id} className={`bhm-proj${canStart ? '' : ' no-git'}`}>
                    <div className="bhm-proj-row">
                      <button type="button" className="bhm-proj-main" onClick={() => setCollapsed((state) => ({ ...state, [project.id]: !state[project.id] }))}>
                        <span className="bhm-caret">{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                        <FolderOpen size={14} className="bhm-proj-icon" />
                        <span>{project.name}</span>
                        {!canStart && <span className="bhm-proj-git-note">{ko ? 'Git 필요' : 'Git required'}</span>}
                        <span className="bhm-proj-count">{items.length}</span>
                      </button>
                      <button type="button" className={`bhm-proj-new ui-button ui-button-primary${creating ? ' creating' : ''}${canStart ? '' : ' no-git'}`} title={projectStartTitle} disabled={creating || !canStart} onClick={() => { if (canStart) onCreateHarness(project.id); }}>
                        {creating ? <Loader2 size={15} className="bhm-spin" /> : <OctoPlus size={15} />}
                        <span>{creating ? (ko ? '시작' : 'Start') : (ko ? '시작' : 'Start')}</span>
                      </button>
                    </div>
                    {!canStart && !isCollapsed && (
                      <div className="bhm-proj-git-required">
                        <strong>{ko ? 'Git 저장소가 아닙니다' : 'Not a Git repository'}</strong>
                        <span>{ko ? '브로커 하네스는 브랜치, worktree, merge를 사용하므로 이 프로젝트에서는 시작할 수 없습니다.' : 'Harnesses use branches, worktrees, and merges, so this project cannot start one.'}</span>
                      </div>
                    )}
                    {!isCollapsed && items.map((harness, index) => {
                      const accent = harnessAccent(harness);
                      const num = items.length > 1 ? ` #${index + 1}` : '';
                      const label = harness.name || `${project.name}${num}`;
                      const selectedRow = selectedId === harness.id;
                      const rowLive = selectedRow && isRunningHarness(harness);
                      return (
                        <div key={harness.id} className={`bhm-harness ${selectedRow ? 'sel' : ''}${rowLive ? ' live' : ''}`} style={{ borderLeft: `3px solid ${accent}` }}>
                          {editingId === harness.id ? (
                            <input
                              className="bhm-harness-edit"
                              autoFocus
                              defaultValue={label}
                              onClick={(event) => event.stopPropagation()}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  onRename(harness.id, (event.target as HTMLInputElement).value);
                                  setEditingId(null);
                                } else if (event.key === 'Escape') {
                                  setEditingId(null);
                                }
                              }}
                              onBlur={(event) => {
                                onRename(harness.id, event.target.value);
                                setEditingId(null);
                              }}
                            />
                          ) : (
                            <button type="button" className="bhm-harness-main" onClick={() => onSelect(harness.id)} onDoubleClick={() => setEditingId(harness.id)} title={labels.openRename}>
                              <span className="bhm-harness-deer"><OctoAntler size={13} /></span>
                              <span className="bhm-harness-name">{label}</span>
                              <span className="bhm-harness-stage" style={{ color: accent }}>{harnessStageLabel(harness, lang)}</span>
                            </button>
                          )}
                          <button type="button" className="bhm-harness-rename" title={labels.rename} onClick={() => setEditingId(harness.id)}><OctoPencil size={13} /></button>
                          <button type="button" className="bhm-harness-stop" title={labels.stop} onClick={() => onStopHarness(harness.id)}><OctoX size={13} /></button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
          <div className="bhm-detail">
            {sourceMapOpen && (
              <div className="bhm-source-map">
                <div className="bhm-source-map-head">
                  <strong>Harness source map</strong>
                  <span>Other harness sources inside this project</span>
                </div>
                <div className="bhm-source-map-grid">
                  {HARNESS_SOURCE_MAP.map((group) => (
                    <div key={group.id} className={`bhm-source-card ${group.kind}`}>
                      <div className="bhm-source-card-title">
                        <strong>{group.title}</strong>
                        <span>{group.kind}</span>
                      </div>
                      <p>{group.summary}</p>
                      <ul>
                        {group.entryFiles.map((file) => (
                          <li key={file}><code>{file}</code></li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {selected ? (
              <>
                {showSelectedStatusPanel && <BrokerStatusPanel status={selected.status!} lang={lang} />}
                <div className="bhm-broker" style={{ borderTopColor: selAccent }}>
                  <div className="bhm-broker-bar">
                    <span className="bhm-broker-dot" style={{ background: selAccent }} />
                    <span className="bhm-broker-name">{ko ? '브로커' : 'Broker'} · {selected.developer}→{selected.reviewer}</span>
                    {selected.branch && <span className="bhm-broker-branch" title={selected.worktreeDir || selected.branch}>{selected.branch}</span>}
                    <span className={`bhm-broker-lifecycle ${selected.lifecycle || 'active'}`}>{lifecycleLabel(selected.lifecycle, lang)}</span>
                    {selectedHeartbeat && <span className="bhm-broker-heartbeat">{selectedHeartbeat}</span>}
                    <span className="bhm-broker-cycle" style={{ color: selAccent }}>{harnessStageLabel(selected, lang)}</span>
                    {reviewerHint && <span className="bhm-broker-reviewer-hint">{ko ? '검토 대기' : 'review waiting'}</span>}
                    {!selectedSuspended && typeof selected.status?.grownLoc === 'number' && <span className="bhm-broker-loc">+{selected.status.grownLoc} LOC</span>}
                    {!selectedSuspended && selected.status?.directionOk === false && <span className="bhm-broker-warn">{ko ? '방향 이탈' : 'off-track'}</span>}
                    {showReviewLoopControls && onRequestRework && (
                      <button
                        type="button"
                        className="bhm-broker-rework"
                        title={ko ? '최신 리뷰 피드백(REWORK)을 개발 에이전트에게 다시 보냅니다' : 'Re-send the latest review feedback (REWORK) to the dev agent'}
                        onClick={() => { void onRequestRework(selected.id); }}
                      >⟳ {ko ? '재작업 요청' : 'Re-request rework'}</button>
                    )}
                    {showReviewLoopControls && onResetReviewFeed && (
                      <button
                        type="button"
                        className="bhm-broker-resetfeed"
                        title={ko ? '리뷰 피드백을 비우고 리뷰 사이클을 초기화합니다 (코드/diff는 그대로)' : 'Clear the review feed and reset the review cycle (code/diff untouched)'}
                        onClick={() => { void onResetReviewFeed(selected.id); }}
                      >⌫ {ko ? '리뷰 초기화' : 'Reset review'}</button>
                    )}
                    {showReviewLoopControls && onRestartAgents && (
                      <button
                        type="button"
                        className="bhm-broker-restart"
                        title={ko ? '두 에이전트 CLI를 같은 워크트리에서 다시 띄웁니다 (작업·진행 유지, 재브리핑)' : 'Restart both agent CLIs in the same worktree (work/progress kept, re-briefed)'}
                        onClick={() => { void onRestartAgents(selected.id); }}
                      >↻ {ko ? '에이전트 재기동' : 'Restart agents'}</button>
                    )}
                    {onCleanupProjectDevProcesses && (
                      <button
                        type="button"
                        className="bhm-broker-cleanup"
                        disabled={cleaningHarnessId === selected.id}
                        title="Stop orphan project dev servers started by this harness"
                        onClick={() => {
                          setCleaningHarnessId(selected.id);
                          void onCleanupProjectDevProcesses(selected.id).finally(() => setCleaningHarnessId(null));
                        }}
                      >{cleaningHarnessId === selected.id ? 'Cleaning...' : 'Clean servers'}</button>
                    )}
                    {!selectedResting && onRollback && (
                      <button
                        type="button"
                        className="bhm-broker-rollback"
                        title={ko ? '개발 워크트리를 마지막 체크포인트로 되돌립니다 (드리프트 폐기, 비가역)' : 'Reset the dev worktree to the last checkpoint (discards drift, irreversible)'}
                        onClick={() => { void onRollback(selected.id); }}
                      >↩ {ko ? '롤백' : 'Rollback'}</button>
                    )}
                  </div>
                  <div className="bhm-broker-log" ref={brokerLogRef}>
                    {timeline.length > 0
                      ? timeline.map((entry, index) => <div key={index} className={`bhm-log-row ${entry.tone}`}><span>{entry.actor}</span><p>{entry.text}</p></div>)
                      : <div className="bhm-log info">{ko ? '이 하네스에 브로커가 연결되어 개발-검토 흐름을 감시 중입니다.' : 'Broker bound to this harness and watching the dev-review thread.'}</div>}
                    {reviewerHint && <div className="bhm-log-row review"><span>{ko ? '검토 에이전트' : 'Review agent'}</span><p>{reviewerHint}</p></div>}
                    {!selectedSuspended && selected.status?.reason && <div className="bhm-log reason">- {selected.status.reason}</div>}
                  </div>
                </div>
                {(selectedComplete || selectedBlocked) && (
                  <div className={`bhm-followup-banner ${selectedBlocked ? 'failed' : 'done'}`}>
                    <strong>{selectedBlocked ? (ko ? '확인 필요' : 'Needs attention') : (ko ? '완료됨' : 'Complete')}</strong>
                    <span>
                      {selectedBlocked
                        ? (ko ? '브로커 작업이 차단되었습니다. 위 로그를 확인한 뒤 새 하네스에서 수정 작업을 시작하세요.' : 'Broker work is blocked. Check the log above, then start a new harness for the fix.')
                        : (ko ? '작업은 병합됐습니다. 하네스 터미널은 닫혔습니다. 다음 작업은 + 버튼으로 새 하네스를 시작하세요.' : 'The work has been merged. Harness terminals were closed. Start the next task with the + button.')}
                    </span>
                  </div>
                )}
                <div className="bhm-terminals">{terminalArea}</div>
              </>
            ) : (
              <div className="bhm-empty bhm-empty-action ui-empty-state ui-panel">
                <strong>
                  {allProjectsCheckedNonGit
                    ? (ko ? 'Git 프로젝트가 필요합니다.' : 'A Git project is required.')
                    : (ko ? '하네스를 선택하거나 새로 시작하세요.' : 'Select a harness or start a new one.')}
                </strong>
                <span>
                  {allProjectsCheckedNonGit
                    ? (ko ? '브로커 하네스는 별도 worktree를 만들고 검토 후 merge하므로 Git 저장소가 아닌 폴더에서는 실행하지 않습니다.' : 'Broker Harness creates separate worktrees and merges reviewed changes, so it only runs inside Git repositories.')
                    : firstProject
                    ? (ko ? '왼쪽 목록에서 기존 하네스를 열거나, 아래 버튼으로 첫 프로젝트에서 바로 시작할 수 있습니다.' : 'Open an existing harness from the left list, or start one on your first project now.')
                    : (ko ? '먼저 프로젝트를 열면 브로커 하네스를 만들 수 있습니다.' : 'Open a project first to create a broker harness.')}
                </span>
                {firstProject && (
                  <button
                    type="button"
                    className={`bhm-empty-new ui-button ui-button-primary${creating ? ' creating' : ''}${firstStartableProject ? '' : ' no-git'}`}
                    disabled={creating || !firstStartableProject}
                    title={firstStartableProject ? labels.newHarness : labels.gitRequired}
                    onClick={() => { if (firstStartableProject) onCreateHarness(firstStartableProject.id); }}
                  >
                    {creating ? <Loader2 size={15} className="bhm-spin" /> : <OctoPlus size={15} />}
                    {creating ? (ko ? '시작 중...' : 'Starting...') : (ko ? '새 하네스 시작' : 'Start new harness')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
