// The work: filters (state chips mirror the legend, agent, label, search), the grouped board
// (five columns, three when narrow) or a grouped list, and a person's "Add task" form.
// Approve / Reject / Retry never appear on cards (Needs you and the drawer only).
import { useState } from 'react';
import * as Icons from 'lucide-react';
import { ALL_DISPLAY_STATES, boardColumns, formatAge, type DisplayState, type TaskView } from './model';
import { rowKeys } from './NeedsYouList';
import { AttemptPips, StateChip, StateIcon } from './parts';
import type { ActionResult } from './source';
import { stateLabel, type TsT } from './strings';
import { useEscapeLayer } from './escape';

const COLUMN_CAP = 30;

export function TaskCard({ v, now, locale, t, onOpen, compact }: { v: TaskView; now: number; locale: string; t: TsT; onOpen: (seq: number) => void; compact?: boolean }) {
  return (
    <button
      type="button"
      className={`ts-card ts-task${v.waiting ? ' ts-waiting' : ''}`}
      data-state={v.display}
      data-ts-row=""
      onClick={() => onOpen(v.seq)}
      aria-label={`#${v.seq} ${v.title}, ${stateLabel(locale, v.display)}${v.stale ? `, ${stateLabel(locale, 'stale')}` : ''}`}
    >
      <span className="ts-task-title">#{v.seq} {v.title}</span>
      <span className="ts-task-meta">
        {compact && <StateChip state={v.display} locale={locale} />}
        {v.ownerName && <span>{v.ownerName}</span>}
        {v.state === 'claimed' || v.state === 'blocked' || v.state === 'review' ? <span>{formatAge(now - v.updatedAt, locale)}</span> : null}
        {v.state === 'blocked' && !compact && <span data-state="blocked" className="ts-ink"><StateIcon state="blocked" /> {stateLabel(locale, 'blocked')}</span>}
        {v.stale && <span data-state="stale" className="ts-ink"><Icons.Clock size={12} aria-hidden="true" /> {t('task.stale', { age: formatAge(v.ageMs, locale) })}</span>}
        {v.waiting && (
          <span data-state={v.waitingOnFailed ? 'failed' : 'waiting'} className={v.waitingOnFailed ? 'ts-ink' : undefined}>
            <Icons.Hourglass size={12} aria-hidden="true" /> {t(v.waitingOnFailed ? 'task.waitsOnFailed' : 'task.waitsOn', { deps: v.waitingOn.join(', #') })}
          </span>
        )}
        {v.depCancelled && <span title={t('task.depCancelled')}><Icons.CircleSlash size={12} aria-label={t('task.depCancelled')} /></span>}
        {(v.state === 'failed' || (v.attempt > 0 && (v.state === 'open' || v.state === 'claimed' || v.state === 'blocked'))) && <AttemptPips used={v.tries} max={v.maxAttempts} t={t} />}
        {v.priority !== 1 && <span>{t('task.p', { n: v.priority })}</span>}
      </span>
    </button>
  );
}

const colTitle: Record<string, Parameters<TsT>[0]> = {
  todo: 'col.todo', working: 'col.working', review: 'col.review', done: 'col.done', failed: 'col.failed', finished: 'col.finished',
};

export function TaskBoard({ views, columns, showCancelled, now, locale, t, onOpen }: {
  views: TaskView[];
  columns: 3 | 5;
  showCancelled: boolean;
  now: number;
  locale: string;
  t: TsT;
  onOpen: (seq: number) => void;
}) {
  const cols = boardColumns(views, { columns, showCancelled });
  return (
    <div className="ts-board" style={{ ['--ts-cols' as string]: String(columns) }} onKeyDown={rowKeys}>
      {cols.map((c) => (
        <section key={c.key} className="ts-col" aria-label={`${t(colTitle[c.key])} ${c.views.length}`}>
          <h3 className="ts-col-head">{t(colTitle[c.key])} <span className="ts-count">{c.views.length}</span></h3>
          {c.views.slice(0, COLUMN_CAP).map((v) => <TaskCard key={v.seq} v={v} now={now} locale={locale} t={t} onOpen={onOpen} />)}
          {c.views.length > COLUMN_CAP && <span className="ts-col-more ts-muted">{t('col.more', { n: c.views.length - COLUMN_CAP })}</span>}
        </section>
      ))}
    </div>
  );
}

const LIST_ORDER: DisplayState[] = ['review', 'failed', 'blocked', 'claimed', 'open', 'waiting', 'done', 'cancelled'];

export function TaskList({ views, showCancelled, now, locale, t, onOpen }: { views: TaskView[]; showCancelled: boolean; now: number; locale: string; t: TsT; onOpen: (seq: number) => void }) {
  return (
    <div className="ts-tasklist" onKeyDown={rowKeys}>
      {LIST_ORDER.filter((s) => s !== 'cancelled' || showCancelled).map((s) => {
        const group = views.filter((v) => v.display === s).sort((a, b) => b.updatedAt - a.updatedAt);
        if (!group.length) return null;
        return (
          <section key={s} aria-label={`${stateLabel(locale, s)} ${group.length}`}>
            <h3 className="ts-group-head" data-state={s}><StateChip state={s} locale={locale}>{stateLabel(locale, s)} {group.length}</StateChip></h3>
            <div className="ts-list" role="list">
              {group.map((v) => <div role="listitem" key={v.seq}><TaskCard v={v} now={now} locale={locale} t={t} onOpen={onOpen} compact /></div>)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export interface FilterState {
  states: Set<DisplayState>;
  agent: string;
  label: string;
  search: string;
  showCancelled: boolean;
}

export const emptyFilters = (): FilterState => ({ states: new Set(), agent: '', label: '', search: '', showCancelled: false });

export function TaskFilters({ filters, onChange, agents, labels, locale, t }: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  agents: Array<{ id: string; name: string }>;
  labels: string[];
  locale: string;
  t: TsT;
}) {
  const toggle = (s: DisplayState) => {
    const states = new Set(filters.states);
    if (states.has(s)) states.delete(s); else states.add(s);
    onChange({ ...filters, states });
  };
  const any = filters.states.size || filters.agent || filters.label || filters.search;
  return (
    <div className="ts-filters">
      {ALL_DISPLAY_STATES.filter((s) => s !== 'cancelled').map((s) => (
        <button key={s} type="button" className={`ts-chip${s === 'waiting' ? ' ts-waiting' : ''}`} data-state={s} aria-pressed={filters.states.has(s)} onClick={() => toggle(s)}>
          <StateIcon state={s} /> {stateLabel(locale, s)}
        </button>
      ))}
      <select value={filters.agent} onChange={(e) => onChange({ ...filters, agent: e.target.value })} aria-label={t('filter.agent')}>
        <option value="">{t('filter.agent')}</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {labels.length > 0 && (
        <select value={filters.label} onChange={(e) => onChange({ ...filters, label: e.target.value })} aria-label={t('filter.label')}>
          <option value="">{t('filter.label')}</option>
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
      <input type="search" value={filters.search} placeholder={t('filter.search')} aria-label={t('filter.search')} onChange={(e) => onChange({ ...filters, search: e.target.value })} />
      <label className="ts-muted" style={{ fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <input type="checkbox" checked={filters.showCancelled} onChange={(e) => onChange({ ...filters, showCancelled: e.target.checked })} />
        {t('filter.cancelled')}
      </label>
      {any ? <button type="button" className="ts-link" onClick={() => onChange({ ...emptyFilters(), showCancelled: filters.showCancelled })}>{t('filter.clear')}</button> : null}
    </div>
  );
}

/** A person adds a task (author "user"); title required, optional body, priority, review. */
export function AddTaskForm({ t, onAdd, onDone }: { t: TsT; onAdd: (req: Record<string, unknown>) => Promise<ActionResult>; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState(1);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEscapeLayer(true, onDone);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const r = await onAdd({ title, body: body || undefined, priority, review });
    setBusy(false);
    if (r.ok) onDone(); else setError(t('error.action', { error: r.error }));
  };
  return (
    <form className="ts-card ts-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input type="text" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('form.title')} aria-label={t('form.title')} maxLength={200} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('form.body')} aria-label={t('form.body')} maxLength={8000} />
      <div className="ts-actions">
        <label className="ts-muted">{t('form.priority')}{' '}
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="ts-muted"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> {t('form.review')}</label>
        <button type="submit" className="ts-btn ts-primary" disabled={busy || !title.trim()}>{busy ? t('act.busy') : t('act.addTask')}</button>
        <button type="button" className="ts-btn" onClick={onDone}>{t('act.keep')}</button>
      </div>
      {error && <div className="ts-error" role="alert">{error}</div>}
    </form>
  );
}
