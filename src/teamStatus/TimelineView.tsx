// Timeline tab: "are we converging?" (burn-up: all tasks as a gray step line vs done, plus a
// dotted done + review line) and "how long did things sit?" (one lane per task, segments in
// the state's color on a shared time axis up to now, 30 lanes then "show more"). Each chart
// is an image with a generated sentence and a Table toggle. Design: section 4.
import { useId, useMemo, useState } from 'react';
import { formatBoardTime } from '../terminal/agentBoard';
import type { BoardTask } from '../terminal/agentTasks';
import { formatAge, type StoredState } from './model';
import { ChartFrame } from './parts';
import { stateLabel, type TsT } from './strings';
import { burnUp, laneTotals, medianTimeIn, timeInState, type BurnPoint, type StateLane, type TimelineEvent } from './timeline';

const LANES = 30;
const BW = 600;
const BH = 140;

/** A duration as people read it: "<1m", "4m", "2h", "3d". */
export function formatSpan(ms: number | null, locale: string, t: TsT): string {
  if (ms === null) return '-';
  if (ms < 60_000) return t('timeline.lessThanMinute');
  return formatAge(ms, locale);
}

export function TimelineView({ team, events, tasks, now, locale, t }: {
  /** The team shown (part of the cache key: two teams can have the same counts). */
  team: string;
  events: TimelineEvent[];
  tasks: BoardTask[];
  now: number;
  locale: string;
  t: TsT;
}) {
  // Recomputed when the data or the minute changes (the arrays are new on every render).
  const minute = Math.floor(now / 60_000);
  const key = `${team}:${events.length}:${events[events.length - 1]?.ts ?? 0}:${tasks.map((x) => `${x.seq}.${x.state}.${x.updatedAt ?? 0}`).join(',')}:${minute}`;
  const burnId = useId();
  const lanesId = useId();
  const points = useMemo(() => burnUp(events, tasks, now), [key]);
  const lanes = useMemo(() => timeInState(events, now, tasks), [key]);
  if (!points.length && !lanes.length) return <div className="ts-hint">{t('timeline.none')}</div>;
  return (
    <div className="ts-timeline">
      <section aria-labelledby={burnId}>
        <h3 className="ts-card-title" id={burnId}>{t('timeline.burnTitle')}</h3>
        <BurnUp points={points} now={now} t={t} />
      </section>
      <section aria-labelledby={lanesId}>
        <h3 className="ts-card-title" id={lanesId}>{t('timeline.laneTitle')}</h3>
        <TimeInState lanes={lanes} now={now} locale={locale} t={t} />
      </section>
    </div>
  );
}

const time = (ts: number, now: number) => formatBoardTime(ts, now);

export function BurnUp({ points, now, t }: { points: BurnPoint[]; now: number; t: TsT }) {
  const titleId = useId();
  if (points.length < 1) return <div className="ts-hint">{t('timeline.none')}</div>;
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 1);
  const max = Math.max(1, ...points.map((p) => p.total));
  const x = (ts: number) => ((ts - t0) / (t1 - t0)) * BW;
  const y = (v: number) => BH - 2 - (v / max) * (BH - 6);
  const step = (pick: (p: BurnPoint) => number) =>
    points.map((p, i) => (i === 0 ? `M${x(p.t).toFixed(1)},${y(pick(p)).toFixed(1)}` : `H${x(p.t).toFixed(1)} V${y(pick(p)).toFixed(1)}`)).join(' ');
  const last = points[points.length - 1];
  const sentence = t('timeline.burnSentence', { start: time(t0, now), end: time(t1, now), total: last.total, done: last.done, review: last.doneReview - last.done });
  const table = (
    <div className="ts-table-scroll">
      <table className="ts-table">
        <thead><tr><th>{t('timeline.time')}</th><th>{t('timeline.total')}</th><th>{t('timeline.done')}</th><th>{t('timeline.doneReview')}</th></tr></thead>
        <tbody>{points.map((p, i) => <tr key={`${p.t}:${i}`}><td>{time(p.t, now)}</td><td>{p.total}</td><td>{p.done}</td><td>{p.doneReview}</td></tr>)}</tbody>
      </table>
    </div>
  );
  return (
    <ChartFrame t={t} table={table}>
      <div className="ts-burn">
        <span className="ts-axis-max ts-muted">{max}</span>
        <svg className="ts-burn-svg" viewBox={`0 0 ${BW} ${BH}`} preserveAspectRatio="none" role="img" aria-labelledby={titleId}>
          <title id={titleId}>{sentence}</title>
          <line x1={0} y1={BH - 1} x2={BW} y2={BH - 1} className="ts-axis-line" vectorEffect="non-scaling-stroke" />
          <path d={step((p) => p.total)} className="ts-burn-total" fill="none" vectorEffect="non-scaling-stroke" />
          <path d={step((p) => p.doneReview)} className="ts-burn-review" fill="none" vectorEffect="non-scaling-stroke" />
          <path d={step((p) => p.done)} className="ts-burn-done" fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="ts-axis ts-muted"><span>{time(t0, now)}</span><span>{time(t1, now)}</span></div>
        <div className="ts-legend">
          <span className="ts-key ts-key-total">{t('timeline.total')} {last.total}</span>
          <span className="ts-key ts-key-done">{t('timeline.done')} {last.done}</span>
          <span className="ts-key ts-key-review">{t('timeline.doneReview')} {last.doneReview}</span>
        </div>
      </div>
    </ChartFrame>
  );
}

const TABLE_STATES: StoredState[] = ['open', 'claimed', 'blocked', 'review', 'failed'];

export function TimeInState({ lanes, now, locale, t }: { lanes: StateLane[]; now: number; locale: string; t: TsT }) {
  const [limit, setLimit] = useState(LANES);
  if (!lanes.length) return <div className="ts-hint">{t('timeline.none')}</div>;
  const shown = lanes.slice(0, limit);
  const t0 = Math.min(...lanes.map((l) => l.start));
  const t1 = Math.max(now, t0 + 1);
  const pct = (ts: number) => ((ts - t0) / (t1 - t0)) * 100;
  const review = formatSpan(medianTimeIn(lanes, 'review'), locale, t);
  const blocked = formatSpan(medianTimeIn(lanes, 'blocked'), locale, t);
  const finished = lanes.filter((l) => l.last === 'done' || l.last === 'cancelled').length;
  const sentence = t('timeline.laneSentence', { n: lanes.length, start: time(t0, now), review, blocked, finished });
  const table = (
    <div className="ts-table-scroll">
      <table className="ts-table">
        <thead><tr><th>{t('timeline.task')}</th>{TABLE_STATES.map((s) => <th key={s}>{stateLabel(locale, s)}</th>)}<th>{t('timeline.endState')}</th></tr></thead>
        <tbody>
          {lanes.map((l) => {
            const tot = laneTotals(l);
            return <tr key={l.seq}><td>#{l.seq}</td>{TABLE_STATES.map((s) => <td key={s}>{tot[s] ? formatSpan(tot[s]!, locale, t) : '-'}</td>)}<td>{stateLabel(locale, l.last)}</td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartFrame t={t} table={table}>
      <div className="ts-muted ts-median">{t('timeline.median', { review, blocked })}{finished > 0 && <> · {t('timeline.finishedNote')}</>}</div>
      <div className="ts-lanes" role="img" aria-label={sentence}>
        <div className="ts-lane ts-lane-axis" aria-hidden="true">
          <span className="ts-lane-label" />
          <span className="ts-lane-track ts-axis ts-muted"><span>{time(t0, now)}</span><span>{time(t0 + (t1 - t0) / 2, now)}</span><span>{t('timeline.now')}</span></span>
        </div>
        {shown.map((l) => (
          <div className="ts-lane" key={l.seq}>
            <span className="ts-lane-label">#{l.seq}</span>
            <span className="ts-lane-track">
              {l.segments.map((s, i) => (
                <span
                  key={i}
                  className={`ts-seg-span${s.after ? ' ts-after' : ''}`}
                  data-state={s.state}
                  style={{ left: `${pct(s.from)}%`, width: `${Math.max(0, pct(s.to) - pct(s.from))}%` }}
                  title={`#${l.seq} · ${stateLabel(locale, s.state)} · ${formatSpan(s.to - s.from, locale, t)}`}
                />
              ))}
              <span className="ts-now-rule" />
            </span>
          </div>
        ))}
      </div>
      {lanes.length > limit && (
        <button type="button" className="ts-link" onClick={() => setLimit((n) => n + LANES)}>{t('timeline.more', { n: Math.min(LANES, lanes.length - limit) })}</button>
      )}
    </ChartFrame>
  );
}

/** One task's strip (task drawer): segments over the task's own life, totals as text. */
export function TaskLane({ lane, now, locale, t }: { lane: StateLane; now: number; locale: string; t: TsT }) {
  const t0 = lane.start;
  const t1 = Math.max(lane.end, lane.segments[lane.segments.length - 1]?.to ?? lane.end, t0 + 1);
  const pct = (ts: number) => ((ts - t0) / (t1 - t0)) * 100;
  const tot = laneTotals(lane);
  const text = (Object.keys(tot) as StoredState[]).map((s) => `${stateLabel(locale, s)} ${formatSpan(tot[s]!, locale, t)}`).join(' · ');
  return (
    <div className="ts-task-lane">
      <div className="ts-lane-track" role="img" aria-label={`${time(t0, now)} - ${lane.end >= now ? t('timeline.now') : time(lane.end, now)}: ${text}`}>
        {lane.segments.map((s, i) => (
          <span key={i} className={`ts-seg-span${s.after ? ' ts-after' : ''}`} data-state={s.state} style={{ left: `${pct(s.from)}%`, width: `${Math.max(0, pct(s.to) - pct(s.from))}%` }} title={`${stateLabel(locale, s.state)} · ${formatSpan(s.to - s.from, locale, t)}`} />
        ))}
      </div>
      <div className="ts-muted">{text}</div>
    </div>
  );
}
