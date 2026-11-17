// Task detail drawer (right, 420px; full width when narrow): body, result, dependencies as
// text, event history and a person's actions for the task's state — approve / reject (inline
// reason), retry, reopen, edit, cancel (asks first). Never claim, block, release or finish.
import { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { formatBoardTime } from '../terminal/agentBoard';
import type { FeedEvent, TaskView } from './model';
import { StateChip, AttemptPips } from './parts';
import type { HumanTaskSub, TeamBoardSource } from './source';
import { eventVerb, stateLabel, type TsT } from './strings';
import { useEscapeLayer } from './escape';
import { timeInState } from './timeline';
import { TaskLane } from './TimelineView';

export function TaskDrawer({ view, all, team, refreshKey, source, now, locale, t, readOnly, onAct, onClose, onJump }: {
  view: TaskView;
  all: TaskView[];
  team: string;
  /** Changes when the board was read again (the history is re-read then). */
  refreshKey: string;
  source: TeamBoardSource;
  now: number;
  locale: string;
  t: TsT;
  readOnly: boolean;
  onAct: (seq: number, sub: HumanTaskSub, request?: Record<string, unknown>) => Promise<boolean>;
  onClose: () => void;
  onJump: (tabId: string) => void;
}) {
  const task = view.task;
  const seq = view.seq;
  const [history, setHistory] = useState<FeedEvent[] | null>(null);
  const [mode, setMode] = useState<'' | 'reject' | 'cancel' | 'edit'>('');
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState(view.title);
  const [body, setBody] = useState(task.body || '');
  const [priority, setPriority] = useState(view.priority);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEscapeLayer(true, onClose);
  useEscapeLayer(mode !== '', () => setMode(''));

  useEffect(() => { closeRef.current?.focus(); }, [seq]);
  useEffect(() => { setMode(''); setReason(''); }, [seq]);
  useEffect(() => {
    let alive = true;
    sourceRef.current.history(team, seq).then((ev) => { if (alive) setHistory(ev); }, () => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [team, seq, refreshKey]);

  const act = async (sub: HumanTaskSub, request?: Record<string, unknown>) => {
    setBusy(true);
    const ok = await onAct(seq, sub, request);
    setBusy(false);
    if (ok) setMode('');
  };
  const dependents = all.filter((o) => o.deps.includes(seq));
  const brief = (n: number) => {
    const o = all.find((x) => x.seq === n);
    return o ? `#${n} ${o.title} (${stateLabel(locale, o.display)}${o.ownerName ? `, ${o.ownerName}` : ''})` : `#${n}`;
  };
  const r = task.result;
  const s = view.state;
  // The time-in-state strip from this task's full history (the events carry no task #).
  const lane = history ? timeInState(history.map((e) => ({ ...e, task: seq })), now, [task])[0] : undefined;

  return (
    <>
      <div className="ts-drawer-backdrop" onMouseDown={onClose} />
      <aside className="ts-drawer" role="complementary" aria-labelledby="ts-drawer-title">
        <div className="ts-drawer-head">
          <StateChip state={view.display} locale={locale} />
          <h3 id="ts-drawer-title">#{seq} {view.title}</h3>
          <button ref={closeRef} type="button" className="ts-btn ts-icon" onClick={onClose} aria-label={t('close')} title={t('close')}><Icons.X size={14} /></button>
        </div>
        <div className="ts-drawer-body">
          <dl className="ts-kv">
            {view.ownerId && <><dt>{t('drawer.owner')}</dt><dd><button type="button" className="ts-link" onClick={() => onJump(view.ownerId!)}>{view.ownerName}</button></dd></>}
            <dt>{t('drawer.addedBy')}</dt><dd>{task.createdBy?.name || task.createdBy?.id || '?'}{task.createdAt ? ` · ${formatBoardTime(task.createdAt, now)}` : ''}</dd>
            <dt>{t('drawer.priority')}</dt><dd>{view.priority}</dd>
            {view.labels.length > 0 && <><dt>{t('drawer.labels')}</dt><dd>{view.labels.join(', ')}</dd></>}
            {(view.attempt > 0 || view.state === 'failed') && <><dt>{t('drawer.attempts')}</dt><dd><AttemptPips used={view.tries} max={view.maxAttempts} t={t} /></dd></>}
            {s === 'blocked' && task.blockedReason && <><dt>{t('drawer.blockedReason')}</dt><dd>{task.blockedReason}</dd></>}
            {task.lastError && <><dt>{t('drawer.lastError')}</dt><dd className="ts-pre">{task.lastError}</dd></>}
          </dl>

          {!readOnly && (
            <section aria-label={t('drawer.actions')}>
              <h4>{t('drawer.actions')}</h4>
              {mode === '' && (
                <div className="ts-actions">
                  {s === 'review' && <button type="button" className="ts-btn ts-primary" disabled={busy} onClick={() => void act('approve')}>{t('act.approve')}</button>}
                  {s === 'review' && <button type="button" className="ts-btn" disabled={busy} onClick={() => setMode('reject')}>{t('act.reject')}</button>}
                  {s === 'failed' && <button type="button" className="ts-btn ts-primary" disabled={busy} onClick={() => void act('retry')}>{t('act.retry')}</button>}
                  {s === 'done' && <button type="button" className="ts-btn" disabled={busy} onClick={() => void act('reopen')}>{t('act.reopen')}</button>}
                  {s !== 'cancelled' && <button type="button" className="ts-btn" disabled={busy} onClick={() => { setTitle(view.title); setBody(task.body || ''); setPriority(view.priority); setMode('edit'); }}>{t('act.edit')}</button>}
                  {s !== 'done' && s !== 'cancelled' && <button type="button" className="ts-btn ts-danger" disabled={busy} onClick={() => setMode('cancel')}>{t('act.cancel')}</button>}
                </div>
              )}
              {mode === 'reject' && (
                <form className="ts-actions" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void act('reject', { reason }); }}>
                  <input type="text" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('act.rejectReason')} aria-label={t('act.rejectReason')} maxLength={2000} />
                  <button type="submit" className="ts-btn ts-danger" disabled={busy || !reason.trim()}>{t('act.rejectSend')}</button>
                  <button type="button" className="ts-btn" onClick={() => setMode('')}>{t('act.keep')}</button>
                </form>
              )}
              {mode === 'cancel' && (
                <div className="ts-actions" role="alertdialog" aria-label={t('act.cancelConfirm', { seq })}>
                  <span>{t('act.cancelConfirm', { seq })}</span>
                  <button type="button" className="ts-btn" autoFocus onClick={() => setMode('')}>{t('act.keep')}</button>
                  <button type="button" className="ts-btn ts-danger" disabled={busy} onClick={() => void act('cancel')}>{t('act.cancelYes')}</button>
                </div>
              )}
              {mode === 'edit' && (
                <form
                  className="ts-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!title.trim()) return;
                    void act('edit', { title, body, priority, expectedVersion: task.version });
                  }}
                >
                  <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('form.title')} maxLength={200} />
                  <textarea value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('form.body')} maxLength={8000} />
                  <div className="ts-actions">
                    <label className="ts-muted">{t('form.priority')}{' '}
                      <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                        {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                    <button type="submit" className="ts-btn ts-primary" disabled={busy || !title.trim()}>{t('act.save')}</button>
                    <button type="button" className="ts-btn" onClick={() => setMode('')}>{t('act.keep')}</button>
                  </div>
                </form>
              )}
            </section>
          )}
          {readOnly && <div className="ts-muted">{t('drawer.readOnly')}</div>}

          <section>
            <h4>{t('drawer.body')}</h4>
            <p className="ts-pre">{task.body || t('drawer.none')}</p>
          </section>

          {r?.summary && (
            <section>
              <h4>{t('drawer.result')}</h4>
              <p className="ts-pre">{r.summary}</p>
              <dl className="ts-kv">
                {r.branch && <><dt>{t('drawer.branch')}</dt><dd>{r.branch}</dd></>}
                {r.commit && <><dt>{t('drawer.commit')}</dt><dd>{r.commit}</dd></>}
                {r.checks && <><dt>{t('drawer.checks')}</dt><dd>{r.checks}</dd></>}
                {r.worktree && <><dt>{t('drawer.worktree')}</dt><dd>{r.worktree}</dd></>}
                {Object.entries(r.artifacts || {}).map(([k, val]) => <span key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{val}</dd></span>)}
              </dl>
              {r.body && <p className="ts-pre">{r.body}</p>}
            </section>
          )}

          <section>
            <h4>{t('drawer.deps')}</h4>
            {view.deps.length === 0 && dependents.length === 0 && <div className="ts-muted">{t('drawer.none')}</div>}
            {view.deps.length > 0 && <div>{t('drawer.dependsOn')}: {view.deps.map(brief).join('; ')}</div>}
            {view.depCancelled && <div className="ts-muted">{t('task.depCancelled')}</div>}
            {dependents.length > 0 && <div>{t('drawer.neededBy')}: {dependents.map((d) => brief(d.seq)).join('; ')}</div>}
          </section>

          {lane && lane.segments.length > 0 && (
            <section>
              <h4>{t('timeline.laneTitle')}</h4>
              <TaskLane lane={lane} now={now} locale={locale} t={t} />
            </section>
          )}

          <section>
            <h4>{t('drawer.history')}</h4>
            {history === null ? (
              <div className="ts-muted">{t('loading')}</div>
            ) : (
              <ol className="ts-history">
                {history.map((e, i) => (
                  <li key={e.id ?? i}>
                    <span className="ts-muted">{formatBoardTime(e.ts, now)}</span>{' '}
                    {e.actor?.name || e.actor?.id || '?'} {eventVerb(locale, e.action || '')}
                    {e.from && e.to && e.from !== e.to ? ` (${e.from} → ${e.to})` : ''}
                    {e.note ? <span className="ts-muted"> "{e.note.split('\n')[0].slice(0, 200)}"</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
