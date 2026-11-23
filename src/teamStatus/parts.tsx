// Small shared pieces of the Team status view: state chips and icons, attempt pips, the
// sparkline, the state bar, segmented meters and the chart frame with its table toggle.
// Charts are hand-written inline SVG colored from the --ts-* tokens (no chart library).
import React, { useId, useState, type ReactNode } from 'react';
import * as Icons from 'lucide-react';
import { BAR_ORDER, stateBarSegments, type DisplayState, type StateSummary } from './model';
import { stateLabel, type TsT } from './strings';

export type ChipState = DisplayState | 'stale';

export function StateIcon({ state, size = 12 }: { state: ChipState; size?: number }) {
  const p = { size, strokeWidth: 2.25, 'aria-hidden': true as const };
  switch (state) {
    case 'done': return <Icons.CircleCheck {...p} />;
    case 'review': return <Icons.Eye {...p} />;
    case 'blocked': return <Icons.CirclePause {...p} />;
    case 'claimed': return <Icons.LoaderCircle {...p} />;
    case 'failed': return <Icons.CircleX {...p} />;
    case 'waiting': return <Icons.Hourglass {...p} />;
    case 'cancelled': return <Icons.CircleSlash {...p} />;
    case 'stale': return <Icons.Clock {...p} />;
    default: return <Icons.Circle {...p} />;
  }
}

/** Icon + word, colored left edge; the word stays in the text color. */
export function StateChip({ state, locale, children }: { state: ChipState; locale: string; children?: ReactNode }) {
  return (
    <span className={`ts-chip${state === 'waiting' ? ' ts-waiting' : ''}`} data-state={state}>
      <StateIcon state={state} />
      {children ?? stateLabel(locale, state)}
    </span>
  );
}

/** Filled dot per attempt used, hollow up to the maximum, plus "try n/m" text. */
export function AttemptPips({ used, max, t }: { used: number; max: number; t: TsT }) {
  const m = Math.max(1, Math.min(10, max));
  const u = Math.max(0, Math.min(m, used));
  return (
    <span className="ts-pips" data-state="failed">
      {Array.from({ length: m }, (_, i) => <span key={i} className={`ts-pip${i < u ? ' ts-used' : ''}`} aria-hidden="true" />)}
      <span className="ts-ink">{t('task.try', { attempt: used, max })}</span>
    </span>
  );
}

/** Word-sized line: no axes, 2px stroke, the last value marked with a dot. */
export function Sparkline({ values, width = 64, height = 18, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const titleId = useId();
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i: number) => (n <= 1 ? width / 2 : 1 + (i * (width - 2)) / (n - 1));
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="ts-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
      <title id={titleId}>{label}</title>
      {n > 0 && <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="miter" />}
      {n > 0 && <rect x={x(n - 1) - 1.5} y={y(values[n - 1]) - 1.5} width={3} height={3} fill="currentColor" />}
    </svg>
  );
}

/** Chart card body with a Chart/Table toggle (section 10: the table is the text alternative). */
export function ChartFrame({ t, table, children }: { t: TsT; table: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="ts-chart">
      <div className="ts-chart-body">{asTable ? table : children}</div>
      <button type="button" className="ts-link" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
        {asTable ? t('chart.chart') : t('chart.table')}
      </button>
    </div>
  );
}

const BAR_W = 1000;

/**
 * The 100% stacked state bar. The SVG is the picture (`role="img"` with a sentence); the
 * segments are also real buttons laid over it that toggle the state filter.
 */
export function StateBar({ summary, sentence, active, onToggle, locale, t }: {
  summary: StateSummary;
  sentence: string;
  active: ReadonlySet<DisplayState>;
  onToggle: (s: DisplayState) => void;
  locale: string;
  t: TsT;
}) {
  const titleId = useId();
  const segs = stateBarSegments(summary.counts, BAR_W, 4);
  const pct = (n: number) => (summary.total ? Math.round((n / summary.total) * 100) : 0);
  const table = (
    <table className="ts-table">
      <thead><tr><th>{t('chart.state')}</th><th>{t('chart.count')}</th><th>{t('chart.share')}</th></tr></thead>
      <tbody>
        {BAR_ORDER.map((s) => <tr key={s}><td>{stateLabel(locale, s)}</td><td>{summary.counts[s]}</td><td>{pct(summary.counts[s])}%</td></tr>)}
      </tbody>
    </table>
  );
  return (
    <ChartFrame t={t} table={table}>
      <div className="ts-bar-wrap">
        <svg className="ts-bar" viewBox={`0 0 ${BAR_W} 10`} preserveAspectRatio="none" role="img" aria-labelledby={titleId}>
          <title id={titleId}>{sentence}</title>
          {segs.length === 0 && <rect x={0} y={0} width={BAR_W} height={10} style={{ fill: 'var(--ts-ink-faint)' }} />}
          {segs.map((s) => (
            <g key={s.state} data-state={s.state}>
              {s.state === 'waiting' ? (
                <>
                  <rect x={s.x + 1} y={1} width={Math.max(0, s.w - 2)} height={8} style={{ fill: 'none', stroke: 'var(--ts-chip)', strokeWidth: 2 }} />
                  <rect x={s.x} y={0} width={s.w} height={10} style={{ fill: 'url(#ts-hatch)' }} />
                </>
              ) : (
                <rect x={s.x} y={0} width={s.w} height={10} style={{ fill: 'var(--ts-chip)' }} />
              )}
            </g>
          ))}
          <defs>
            <pattern id="ts-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="6" style={{ fill: 'var(--ts-open)' }} />
            </pattern>
          </defs>
        </svg>
        <div className="ts-bar-buttons">
          {segs.map((s) => (
            <button
              key={s.state}
              type="button"
              className="ts-seg"
              style={{ left: `${(s.x / BAR_W) * 100}%`, width: `${(s.w / BAR_W) * 100}%` }}
              aria-pressed={active.has(s.state)}
              aria-label={`${stateLabel(locale, s.state)} · ${s.count} · ${pct(s.count)}%`}
              title={`${stateLabel(locale, s.state)} · ${s.count} · ${pct(s.count)}%`}
              onClick={() => onToggle(s.state)}
            />
          ))}
        </div>
      </div>
      <div className="ts-legend">
        {BAR_ORDER.filter((s) => summary.counts[s] > 0).map((s) => (
          <button key={s} type="button" className="ts-chip" data-state={s} aria-pressed={active.has(s)} onClick={() => onToggle(s)}>
            <StateIcon state={s} /> {stateLabel(locale, s)} {summary.counts[s]}
          </button>
        ))}
        <span className="ts-spacer" />
        {summary.cancelled > 0 && <span className="ts-muted">{t('summary.cancelled', { n: summary.cancelled })}</span>}
        <span>{t('summary.doneOf', { done: summary.counts.done, total: summary.total })}</span>
      </div>
    </ChartFrame>
  );
}

/** One cell per unit; full = lock icon + "full" in the blocked hue. */
export function SegmentedMeter({ used, max, label, title, t }: { used: number; max: number; label: string; title?: string; t: TsT }) {
  const cells = Math.max(1, Math.min(64, max));
  const full = used >= max;
  return (
    <div className="ts-meter-row" title={title}>
      <span>{label}</span>
      <span className={`ts-meter${full ? ' ts-full' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={`${label} ${used}/${max}`}>
        {Array.from({ length: cells }, (_, i) => <span key={i} className={`ts-cell${i < used ? ' ts-used' : ''}`} />)}
      </span>
      <span>
        {used}/{max}
        {full && <span className="ts-full-label"> <Icons.Lock size={11} aria-hidden="true" />{t('limits.full')}</span>}
      </span>
    </div>
  );
}

export function NeedsCount({ n }: { n: number }) {
  return <span className="ts-count">{n}</span>;
}

/**
 * `role="tablist"` with arrow keys (Left/Right, Home/End) moving focus and selection; each tab
 * controls `${idBase}-panel`. Tabs carry `data-hint` so hint mode can reach them.
 */
export function TabBar<K extends string>({ tabs, value, onChange, label, idBase, className = 'ts-tabs' }: {
  tabs: ReadonlyArray<{ key: K; label: ReactNode }>;
  value: K;
  onChange: (k: K) => void;
  label: string;
  idBase: string;
  className?: string;
}) {
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].key);
    const el = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))[next];
    el?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.key}
          id={`${idBase}-tab-${t.key}`}
          type="button"
          role="tab"
          className="ts-tab"
          data-hint="tab"
          aria-selected={t.key === value}
          aria-controls={`${idBase}-panel`}
          tabIndex={t.key === value ? 0 : -1}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
