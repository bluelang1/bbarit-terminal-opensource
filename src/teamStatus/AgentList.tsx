// Agents of the team (root tab + relay children): 7501 state, the task each holds, a mini
// stacked bar of tasks held (same 3-task scale on every row) and an activity sparkline.
// A row jumps to its tab (focus only; nothing is typed into it).
import { formatAge } from './model';
import { rowKeys } from './NeedsYouList';
import { Sparkline } from './parts';
import type { TsT } from './strings';

export interface AgentRow {
  id: string;
  name: string;
  cli?: string;
  status: 'working' | 'blocked' | 'done' | 'idle' | 'exited';
  open: boolean;
  held: { claimed: number; blocked: number; review: number; seqs: number[] };
  activity: number[];
  lastAt?: number;
}

/** 7501 status → token state (section 5.2: working = claimed blue, idle = open gray, exited = cancelled). */
export const agentTokenState = (s: AgentRow['status']) =>
  s === 'working' ? 'claimed' : s === 'blocked' ? 'blocked' : s === 'done' ? 'done' : s === 'exited' ? 'cancelled' : 'open';

const LOAD_SCALE = 3;

export function AgentList({ rows, now, locale, t, onJump }: { rows: AgentRow[]; now: number; locale: string; t: TsT; onJump: (id: string) => void }) {
  if (!rows.length) return <div className="ts-hint">{t('agents.none')}</div>;
  return (
    <ul className="ts-list" role="list" onKeyDown={rowKeys} style={{ gap: 2 }}>
      {rows.map((r) => {
        const total = r.held.claimed + r.held.blocked + r.held.review;
        const pct = (n: number) => `${(Math.min(n, LOAD_SCALE) / LOAD_SCALE) * 100}%`;
        return (
          <li key={r.id}>
            <button
              type="button"
              className="ts-row"
              data-ts-row=""
              disabled={!r.open}
              onClick={() => onJump(r.id)}
              title={r.open ? t('agents.jump', { name: r.name }) : undefined}
              aria-label={`${r.name}, ${t(`status.${r.status}`)}${r.held.seqs.length ? `, #${r.held.seqs.join(' #')}` : ''}`}
            >
              <span className="ts-dot" data-state={agentTokenState(r.status)} aria-hidden="true" />
              <span className="ts-row-name">{r.name}{r.cli ? <span className="ts-muted"> · {r.cli}</span> : null}</span>
              <span>{t(`status.${r.status}`)}{r.held.seqs.length ? ` #${r.held.seqs[0]}` : ''}</span>
              <span className="ts-row-sub">
                <span className="ts-load" aria-hidden="true">
                  {r.held.review > 0 && <span data-state="review" style={{ width: pct(r.held.review) }} />}
                  {r.held.blocked > 0 && <span data-state="blocked" style={{ width: pct(r.held.blocked) }} />}
                  {r.held.claimed > 0 && <span data-state="claimed" style={{ width: pct(r.held.claimed) }} />}
                </span>
                <span>{t('agents.held', { n: total })}</span>
                <Sparkline values={r.activity} width={48} height={14} label={t('agents.activity')} />
                <span>{r.lastAt !== undefined ? formatAge(now - r.lastAt, locale) : ''}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
