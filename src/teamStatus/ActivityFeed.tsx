// Activity: task events and notes merged by time (a text list, not a chart), plus a note
// box for a person (posted as author "user").
import { useState } from 'react';
import { formatBoardTime } from '../terminal/agentBoard';
import { rowKeys } from './NeedsYouList';
import type { FeedEntry } from './model';
import type { ActionResult } from './source';
import { eventVerb, postKindLabel, type TsT } from './strings';

/** Unsent note text per team: kept when the overlay closes (Esc never loses typed text). */
const noteDrafts = new Map<string, string>();

export function ActivityFeed({ entries, now, locale, t, readOnly, onOpen, onPost, draftKey = '' }: {
  entries: FeedEntry[];
  now: number;
  locale: string;
  t: TsT;
  readOnly: boolean;
  onOpen: (seq: number) => void;
  onPost: (text: string) => Promise<ActionResult>;
  draftKey?: string;
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
    </div>
  );
}
