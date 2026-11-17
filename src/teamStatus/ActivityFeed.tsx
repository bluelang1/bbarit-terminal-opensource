// Activity: task events and notes merged by time (a text list, not a chart), plus a note
// box for a person (posted as author "user").
import { useState } from 'react';
import { formatBoardTime } from '../terminal/agentBoard';
import { rowKeys } from './NeedsYouList';
import type { FeedEntry } from './model';
import type { ActionResult, OutboxEntry } from './source';
import { eventVerb, postKindLabel, type TsT } from './strings';

/** Unsent note text per team: kept when the overlay closes (Esc never loses typed text). */
const noteDrafts = new Map<string, string>();

/** A refused remote note's reason code in the person's language. */
function reasonText(t: TsT, code: string | null | undefined): string {
  switch (code) {
    case 'invalid': return t('outbox.reason.invalid');
    case 'team_gone': return t('outbox.reason.team_gone');
    case 'team_full': return t('outbox.reason.team_full');
    case 'computer_full': return t('outbox.reason.computer_full');
    case 'expired': return t('outbox.reason.expired');
    case 'unknown_sender': return t('outbox.reason.unknown_sender');
    case 'rate_limited': return t('outbox.reason.rate_limited');
    default: return t('outbox.reason.other', { code: code || '?' });
  }
}

export function ActivityFeed({ entries, now, locale, t, readOnly, onOpen, onPost, draftKey = '', pending = [], onDismiss, homeHost, hint }: {
  entries: FeedEntry[];
  now: number;
  locale: string;
  t: TsT;
  /** No note box (the board is unavailable, or a copy whose home cannot take notes yet). */
  readOnly: boolean;
  onOpen: (seq: number) => void;
  onPost: (text: string) => Promise<ActionResult>;
  draftKey?: string;
  /** Stage 3c: this computer's notes for this team that the home has not numbered yet. */
  pending?: OutboxEntry[];
  onDismiss?: (id: string) => void;
  /** The team's home computer: a post written on another computer says where it came from. */
  homeHost?: string;
  /** A line under the note box (a copy: where the note goes, or why it cannot go yet). */
  hint?: string;
}) {
  const [note, setNoteState] = useState(() => noteDrafts.get(draftKey) || '');
  const setNote = (v: string) => { setNoteState(v); if (v) noteDrafts.set(draftKey, v); else noteDrafts.delete(draftKey); };
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (!note.trim()) return;
    setBusy(true);
    const r = await onPost(note);
    setBusy(false);
    if (r.ok) { setNote(''); setError(''); } else setError(t('error.action', { error: r.error }));
  };
  return (
    <div className="ts-activity">
      {pending.length > 0 && (
        <ul className="ts-feed ts-outbox" role="list" data-testid="ts-outbox">
          {pending.map((n) => (
            <li key={`o:${n.id}`} data-state={n.state}>
              <time dateTime={new Date(n.ts).toISOString()}>{formatBoardTime(n.ts, now).slice(0, 5)}</time>
              <span className="ts-feed-text">
                <strong>{n.author?.name || n.author?.id || '?'}</strong>{' '}
                {n.state === 'refused'
                  ? <span className="ts-chip ts-outbox-refused">{t('outbox.refused', { reason: reasonText(t, n.reason) })}</span>
                  : <span className="ts-chip ts-outbox-waiting">{t('outbox.waiting', { home: n.home })}</span>}{' '}
                {(n.text || '').split('\n')[0].slice(0, 240)}
                {n.state === 'refused' && onDismiss && <>{' '}<button type="button" className="ts-link" onClick={() => onDismiss(n.id)}>{t('outbox.dismiss')}</button></>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {entries.length === 0 ? (
        <div className="ts-hint">{t('activity.none')}</div>
      ) : (
        <ul className="ts-feed" role="list" onKeyDown={rowKeys}>
          {entries.map((e) => (
            <li key={e.key}>
              <time dateTime={new Date(e.ts).toISOString()}>{formatBoardTime(e.ts, now).slice(0, 5)}</time>
              <span className="ts-feed-text" tabIndex={0} data-ts-row="">
                <strong>{e.actorName || '?'}</strong>{' '}
                {e.kind === 'event' ? (
                  <>
                    {eventVerb(locale, e.action || '')}{' '}
                    {e.task !== undefined && <button type="button" className="ts-link" onClick={() => onOpen(e.task!)}>#{e.task}</button>}
                    {e.note ? <span className="ts-muted"> "{e.note.split('\n')[0].slice(0, 160)}"</span> : null}
                  </>
                ) : (
                  <>
                    {e.actorHost && homeHost && e.actorHost !== homeHost && <span className="ts-muted">({t('post.from', { host: e.actorHost })}) </span>}
                    <span className="ts-muted">[{postKindLabel(locale, e.postKind || '')}]</span> {(e.text || '').split('\n')[0].slice(0, 240)}
                    {e.task !== undefined && <> (<button type="button" className="ts-link" onClick={() => onOpen(e.task!)}>#{e.task}</button>)</>}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form className="ts-form" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('form.note')} aria-label={t('form.note')} maxLength={2000} rows={2} style={{ minHeight: 40 }} />
          <div className="ts-actions">
            <button type="submit" className="ts-btn" disabled={busy || !note.trim()}>{busy ? t('act.busy') : t('act.postNote')}</button>
            {error && <span className="ts-error" role="alert">{error}</span>}
          </div>
        </form>
      )}
      {hint && <div className="ts-hint" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}
