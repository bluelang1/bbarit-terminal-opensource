// Relay limits as segmented meters (children of the busiest parent, depth, total) with a
// tick strip of refusals in the last 60 min and the last five refusals; the Machines card shows
// the usage type and, when syncing, this machine's sync status (stage 3b).
import { useId } from 'react';
import * as Icons from 'lucide-react';
import { formatBoardTime } from '../terminal/agentBoard';
import { formatAge, REFUSAL_WINDOW_MS, type LimitUsage, type Refusal } from './model';
import { limitName } from './NeedsYouList';
import { ChartFrame, SegmentedMeter } from './parts';
import type { TsT } from './strings';
import type { SyncStatus } from '../terminal/agentBoardStorage';

function RefusalTicks({ refusals, now, t }: { refusals: Refusal[]; now: number; t: TsT }) {
  const titleId = useId();
  const W = 300;
  const recent = refusals.filter((r) => now - r.ts <= REFUSAL_WINDOW_MS && r.ts <= now);
  const x = (ts: number) => W - ((now - ts) / REFUSAL_WINDOW_MS) * W;
  return (
    <svg className="ts-ticks" viewBox={`0 0 ${W} 12`} preserveAspectRatio="none" role="img" aria-labelledby={titleId}>
      <title id={titleId}>{`${t('limits.refusalTicks')}: ${recent.length}`}</title>
      <line x1={0} y1={11} x2={W} y2={11} style={{ stroke: 'var(--ts-ink-faint)', strokeWidth: 1 }} />
      {recent.map((r, i) => <rect key={`${r.ts}-${i}`} x={Math.max(0, x(r.ts) - 1)} y={1} width={2} height={10} style={{ fill: 'var(--ts-blocked)' }} />)}
    </svg>
  );
}

export function LimitsCard({ usage, refusals, now, locale, t }: { usage: LimitUsage; refusals: Refusal[]; now: number; locale: string; t: TsT }) {
  const others = usage.children.perParent.map((p) => t('limits.childrenOf', { id: p.id, n: p.n, max: usage.children.max })).join('\n');
  const recent = refusals.filter((r) => now - r.ts <= REFUSAL_WINDOW_MS && r.ts <= now);
  const last = [...refusals].reverse().slice(0, 5);
  const table = (
    <table className="ts-table">
      <tbody>
        {last.map((r, i) => (
          <tr key={`${r.ts}-${i}`}><td>{formatBoardTime(r.ts, now)}</td><td>{limitName(t, r.limit)}</td><td>{r.caller?.name || r.caller?.id || '-'}</td></tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className="ts-card" aria-labelledby="ts-limits-title">
      <h2 className="ts-card-title" id="ts-limits-title">{t('limits.title')}</h2>
      <SegmentedMeter
        used={usage.children.used}
        max={usage.children.max}
        label={`${t('limits.children')}${usage.children.parent ? ` (${usage.children.parent.slice(0, 8)})` : ''}`}
        title={others || undefined}
        t={t}
      />
      <SegmentedMeter used={usage.depth.used} max={usage.depth.max} label={t('limits.depth')} t={t} />
      <SegmentedMeter used={usage.total.used} max={usage.total.max} label={t('limits.total')} t={t} />
      <div className="ts-muted" style={{ fontSize: 12 }}>
        {recent.length ? t('limits.refusals', { n: recent.length }) + (recent.length ? ` (${formatAge(now - recent[recent.length - 1].ts, locale)})` : '') : t('limits.refusalsNone')}
      </div>
      <ChartFrame t={t} table={table}>
        <RefusalTicks refusals={refusals} now={now} t={t} />
        {last.length > 0 && (
          <ul className="ts-feed" role="list">
            {last.map((r, i) => (
              <li key={`${r.ts}-${i}`}>
                <time dateTime={new Date(r.ts).toISOString()}>{formatBoardTime(r.ts, now).slice(0, 5)}</time>
                <span>{limitName(t, r.limit)}{r.caller ? ` · ${r.caller.name || r.caller.id}` : ''}{r.count !== undefined && r.max !== undefined ? ` · ${r.count}/${r.max}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </ChartFrame>
    </section>
  );
}

const STATE_KEY = { off: 'machines.state.off', starting: 'machines.state.starting', on: 'machines.state.on', paused: 'machines.state.paused', offline: 'machines.state.offline', busy: 'machines.state.busy' } as const;

/**
 * Machines: the usage type, this machine's name and — when syncing — the sync state, last
 * send/receive times, rows waiting, rows skipped, the last error and the other machines whose
 * teams are shown here read-only.
 */
export function MachinesCard({ mode, sync, now, locale, t, onOpenSettings }: { mode?: string; sync?: SyncStatus | null; now?: number; locale?: string; t: TsT; onOpenSettings: () => void }) {
  const m = sync?.mode ?? mode;
  const label = m === 'postgres' ? t('machine.postgres') : m === 'sync' ? t('machine.sync') : t('machine.local');
  const at = now ?? Date.now();
  const age = (ms?: number | null) => (!ms ? t('machines.never') : at - ms < 60_000 ? t('machines.justNow') : t('machines.ago', { age: formatAge(at - ms, locale ?? 'en') }));
  const others = sync?.machines ?? [];
  return (
    <section className="ts-card ts-machines" aria-labelledby="ts-machines-title" data-sync-state={m === 'sync' ? sync?.state ?? 'starting' : 'off'}>
      <h2 className="ts-card-title" id="ts-machines-title"><Icons.Server size={12} aria-hidden="true" />{t('machines.title')}</h2>
      <div style={{ fontSize: 12 }}>{label}</div>
      {sync?.host && <div className="ts-muted" style={{ fontSize: 12 }}>{t('machines.name', { name: sync.host })}</div>}
      {m === 'sync' && sync && (
        <dl className="ts-kv" style={{ fontSize: 12, margin: '4px 0' }}>
          <dt>{t('machines.state')}</dt><dd>{t(STATE_KEY[sync.state])}</dd>
          <dt>{t('machines.lastPush')}</dt><dd>{age(sync.lastPushAt)}</dd>
          <dt>{t('machines.lastPull')}</dt><dd>{age(sync.lastPullAt)}</dd>
          <dt>{t('machines.waiting')}</dt><dd>{sync.waiting}</dd>
          {sync.skipped > 0 && <><dt>{t('machines.skipped')}</dt><dd>{sync.skipped}</dd></>}
          {sync.refused > 0 && <><dt>{t('machines.refused')}</dt><dd>{sync.refused}{sync.refusedReason ? ` · ${sync.refusedReason}` : ''}</dd></>}
          {sync.lastError && <><dt>{t('machines.lastError')}</dt><dd role="status">{sync.lastErrorCode === 'name_changed' ? t('machines.nameChanged') : sync.lastError}</dd></>}
        </dl>
      )}
      {m !== 'postgres' && others.length > 0 && (
        <div style={{ fontSize: 12, margin: '4px 0' }}>
          <div className="ts-muted">{t('machines.others')}</div>
          <ul className="ts-feed" role="list">
            {others.map((o) => <li key={o.host}><span>{t('machines.otherTeams', { host: o.host, n: o.teams })}</span></li>)}
          </ul>
        </div>
      )}
      {m === 'sqlite' && others.length === 0 && <div className="ts-muted" style={{ fontSize: 12, margin: '4px 0' }}>{t('machines.placeholder')}</div>}
      <button type="button" className="ts-link" onClick={onOpenSettings}>{t('openSettings')}</button>
    </section>
  );
}
