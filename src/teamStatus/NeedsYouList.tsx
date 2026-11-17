// "Needs you": the only alert-styled section. One focusable element per row (the row
// itself), actions reachable with Tab, j/k between rows. Reject asks for a reason inline.
import { useState, type KeyboardEvent } from 'react';
import * as Icons from 'lucide-react';
import { formatAge, type NeedsYouItem } from './model';
import { StateIcon, type ChipState } from './parts';
import type { HumanTaskSub } from './source';
import type { TsT } from './strings';
import { useEscapeLayer } from './escape';

const VISIBLE = 5;

/** The limit's short name (`maxChildren` → "children"); unknown names as they are. */
export const limitName = (t: TsT, limit?: string) =>
  limit === 'maxChildren' || limit === 'maxDepth' || limit === 'maxTotal' ? t(`limits.${limit}`) : limit || '';

export const needsState = (kind: NeedsYouItem['kind']): ChipState =>
  kind === 'blockedAgent' ? 'blocked' : kind === 'refusal' ? 'open' : kind;

/** Move focus to the previous / next row of a list with j/k (rows carry data-ts-row). */
export function rowKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'j' && e.key !== 'k') return;
  const target = e.target as HTMLElement;
  if (!target.matches('[data-ts-row]')) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-ts-row]'));
  const i = rows.indexOf(target);
  const next = rows[i + (e.key === 'j' ? 1 : -1)];
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

export function NeedsYouList({ items, fresh, now, locale, t, readOnly, onAct, onOpen, onJump }: {
  items: NeedsYouItem[];
  fresh: ReadonlySet<string>;
  now: number;
  locale: string;
  t: TsT;
  readOnly: boolean;
  onAct: (seq: number, sub: HumanTaskSub, request?: Record<string, unknown>) => Promise<boolean>;
  onOpen: (seq: number) => void;
  onJump: (tabId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEscapeLayer(rejecting !== null, () => setRejecting(null));
  const shown = all ? items : items.slice(0, VISIBLE);
  const hidden = items.length - shown.length;

  const act = async (key: string, seq: number, sub: HumanTaskSub, request?: Record<string, unknown>) => {
    setBusy(key);
    const ok = await onAct(seq, sub, request);
    setBusy(null);
    if (ok && sub === 'reject') { setRejecting(null); setReason(''); }
  };

  const title = (it: NeedsYouItem) => {
    switch (it.kind) {
      case 'failed': return `${t('needs.failed', { seq: it.seq, attempt: it.attempt, max: it.maxAttempts })} · ${it.title}`;
      case 'blockedAgent': return t('needs.blockedAgent', { name: it.title });
      case 'blocked': return `${t('needs.blocked', { seq: it.seq })} · ${it.title}`;
      case 'review': return `${t('needs.review', { seq: it.seq })} · ${it.title}`;
      case 'stale': return `${t('needs.stale', { seq: it.seq, age: formatAge(it.ageMs, locale) })} · ${it.title}`;
      default: return t('needs.refusal', { limit: limitName(t, it.limit) });
    }
  };

  if (!items.length) {
    return <div className="ts-nothing"><Icons.CircleCheck size={14} aria-hidden="true" />{t('needs.nothing')}</div>;
  }
  return (
    <>
      <ul className="ts-list" role="list" onKeyDown={rowKeys}>
        {shown.map((it) => {
          const state = needsState(it.kind);
          const canAct = it.actionable && !readOnly;
          const seq = it.seq ?? 0;
          const working = busy === it.key;
          const who = it.ownerName || it.ownerId;
          return (
            <li key={it.key} className={`ts-need${it.actionable ? '' : ' ts-info'}${fresh.has(it.key) ? ' ts-flash' : ''}`} data-state={state}>
              <div className="ts-need-head" tabIndex={0} data-ts-row="" aria-label={title(it)}>
                {it.kind === 'stale' || it.stale ? <Icons.Clock size={14} aria-hidden="true" /> : <StateIcon state={state} size={14} />}
                <span className="ts-need-title">{title(it)}</span>
              </div>
              <div className="ts-need-meta">
                {who ? `${t('needs.by', { name: who })} · ` : ''}{formatAge(now - it.since, locale)}
              </div>
              {it.detail && <div className="ts-need-detail">{it.detail}</div>}
              <div className="ts-actions">
                {canAct && it.kind === 'review' && rejecting !== seq && (
                  <>
                    <button type="button" className="ts-btn ts-primary" disabled={working} onClick={() => void act(it.key, seq, 'approve')}>{t('act.approve')}</button>
                    <button type="button" className="ts-btn" disabled={working} onClick={() => { setRejecting(seq); setReason(''); }}>{t('act.reject')}</button>
                  </>
                )}
                {canAct && it.kind === 'review' && rejecting === seq && (
                  <form className="ts-actions" style={{ flex: 1 }} onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void act(it.key, seq, 'reject', { reason }); }}>
                    <input type="text" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('act.rejectReason')} aria-label={t('act.rejectReason')} maxLength={2000} />
                    <button type="submit" className="ts-btn ts-danger" disabled={working || !reason.trim()}>{t('act.rejectSend')}</button>
                    <button type="button" className="ts-btn" onClick={() => setRejecting(null)}>{t('act.keep')}</button>
                  </form>
                )}
                {canAct && it.kind === 'failed' && (
                  <button type="button" className="ts-btn ts-primary" disabled={working} onClick={() => void act(it.key, seq, 'retry')}>{t('act.retry')}</button>
                )}
                {(it.kind === 'blockedAgent' || it.kind === 'refusal') && it.tabId && (
                  <button type="button" className="ts-btn" onClick={() => onJump(it.tabId!)}>{t('act.goTab')}</button>
                )}
                {(it.kind === 'blocked' || it.kind === 'stale') && it.ownerId && (
                  <button type="button" className="ts-btn" onClick={() => onJump(it.ownerId!)}>{t('act.goTab')}</button>
                )}
                {it.seq !== undefined && <button type="button" className="ts-btn" onClick={() => onOpen(it.seq!)}>{t('act.open')}</button>}
                {working && <span className="ts-muted">{t('act.busy')}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {(hidden > 0 || all) && items.length > VISIBLE && (
        <button type="button" className="ts-link" onClick={() => setAll((v) => !v)}>{all ? t('needs.less') : t('needs.more', { n: hidden })}</button>
      )}
    </>
  );
}
