import { useEffect, useState } from 'react';
import type { BrokerStatusSnapshot } from '../devreview/devReviewPair';
import { CYCLE_LABELS, CYCLE_ORDER } from '../devreview/brokerMechanic';
import { OctoAntler, OctoX } from '../octoIcons';

/** "In this state for Xm" label. Empty under a minute (noise), minutes under an hour,
 *  h+m above — so a user can tell a quietly-working harness from a stuck one at a glance. */
export function formatCycleElapsed(elapsedMs: number, lang: 'en' | 'ko'): string {
  const mins = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (mins < 1) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 1) return lang === 'ko' ? `${m}분` : `${m}m`;
  return lang === 'ko' ? `${h}시간 ${m}분` : `${h}h ${m}m`;
}

const ACCENT: Record<string, string> = {
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

const CYCLE_LABELS_KO: typeof CYCLE_LABELS = {
  developing: '개발 중',
  dev_done: '개발 완료',
  reviewing: '리뷰 중',
  review_done: '리뷰 완료',
  addressing: '재작업 중',
  approved: '승인됨',
  merging: '자동 병합 중',
  merged: '병합 완료',
  merge_failed: '병합 실패',
};

export function BrokerStatusPanel({
  status,
  lang = 'en',
  onClose,
}: {
  status: BrokerStatusSnapshot;
  lang?: 'en' | 'ko';
  onClose?: () => void;
}) {
  const visibleCycles = status.cycle === 'merge_failed'
    ? CYCLE_ORDER
    : CYCLE_ORDER.filter((cycle) => cycle !== 'merge_failed');
  const curIdx = visibleCycles.indexOf(status.cycle);
  const accent = ACCENT[status.cycle] || '#a371f7';
  const labels = lang === 'ko' ? CYCLE_LABELS_KO : CYCLE_LABELS;
  // Re-render every 30s only while an elapsed chip can be shown, so it stays current
  // without the parent having to push new snapshots.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!status.at) return;
    const timer = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [status.at]);
  const elapsedLabel = status.at ? formatCycleElapsed(nowTs - status.at, lang) : '';
  return (
    <div className="broker-status-panel" style={{ borderBottom: `2px solid ${accent}` }}>
      <div className="broker-status-steps">
        <span className="broker-status-deer"><OctoAntler size={14} /></span>
        {visibleCycles.map((cycle, index) => {
          const state = index < curIdx ? 'done' : index === curIdx ? 'current' : 'pending';
          const label = cycle === status.cycle ? status.cycleLabel || labels[cycle] : labels[cycle];
          return (
            <span
              key={cycle}
              className={`broker-step ${state}`}
              style={index === curIdx ? { background: accent, color: '#fff', borderColor: accent } : undefined}
            >
              {index + 1}. {label}
            </span>
          );
        })}
      </div>
      <div className="broker-status-summary">
        {elapsedLabel && (
          <span
            className="broker-status-chip"
            title={lang === 'ko' ? '현재 단계에 머문 시간' : 'Time in the current step'}
          >
            ⏱ {elapsedLabel}
          </span>
        )}
        {typeof status.grownLoc === 'number' && (
          <span className="broker-status-chip">+{status.grownLoc} LOC</span>
        )}
        {status.directionOk === false && (
          <span className="broker-status-chip warn">{lang === 'ko' ? '방향 이탈' : 'off-track'}</span>
        )}
        {status.action && <span className="broker-status-chip">{status.action}</span>}
        <span className="broker-status-reason" title={status.reason}>{status.reason}</span>
        {onClose && (
          <button
            type="button"
            className="broker-status-close"
            title={lang === 'ko' ? '숨기기' : 'Hide'}
            onClick={onClose}
          >
            <OctoX size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
