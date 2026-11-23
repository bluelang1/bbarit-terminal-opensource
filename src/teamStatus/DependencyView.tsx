// Dependencies tab: what waits on what. A layered graph (hand-written SVG edges, nodes are
// real buttons laid over it) when it fits — at most 40 tasks, 8 steps, no cycle, a wide
// enough view — otherwise an indented tree (`role="tree"`). Hover or focus on a node lights
// its whole upstream + downstream chain; arrow keys walk the graph (left = what it waits on,
// right = what waits on it, up/down = same step). Design: section 4.1.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as Icons from 'lucide-react';
import { dagChain, dagNeighbor, depSubgraph, depTree, layoutDag, DAG_NODE_H, DAG_NODE_W, type DagLayout, type DepTreeNode } from './graph';
import type { TaskView } from './model';
import { ChartFrame, StateIcon } from './parts';
import { stateLabel, type TsT } from './strings';

const PAD = 6;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const closedState = (v: TaskView) => v.state === 'done' || v.state === 'cancelled';

/** Which tasks the description counts: waiting ones, and those waiting on a failed task. */
function counts(views: readonly TaskView[]) {
  return { n: views.length, waiting: views.filter((v) => v.waiting).length, failed: views.filter((v) => v.waitingOnFailed).length };
}

export function DependencyView({ visible, all, narrow, locale, t, onOpen }: {
  /** The filtered tasks. */
  visible: TaskView[];
  /** Every task (resolves done dependencies the filters hide). */
  all: TaskView[];
  narrow: boolean;
  locale: string;
  t: TsT;
  onOpen: (seq: number) => void;
}) {
  // Only the shape (which tasks, which links) is cached, keyed on what it depends on (the arrays
  // are new on every render). Titles, owners and waiting flags are read from the current lists.
  const key = structureKey(visible, all);
  const g = useMemo(() => {
    const sub = depSubgraph(visible, all);
    return { ids: sub.views.map((v) => v.seq), edges: sub.edges, isolated: sub.isolated };
  }, [key]);
  const layout = useMemo(() => layoutDag(g.ids, g.edges, { maxNodes: 40, maxLayers: 8 }), [g]);
  const [prefer, setPrefer] = useState<'graph' | 'tree'>('graph');
  const current = currentViews(visible, all);
  const views = g.ids.map((id) => current.get(id)).filter((v): v is TaskView => !!v);

  if (!views.length) {
    return (
      <div className="ts-hint">
        {t('deps.none')}
        {g.isolated > 0 && <div className="ts-muted">{t('deps.isolated', { n: g.isolated })}</div>}
      </div>
    );
  }
  const canGraph = layout.mode === 'graph' && !narrow;
  const graph = canGraph && prefer === 'graph';
  const reason = layout.mode === 'tree' ? layout.reason : narrow ? 'narrow' : null;
  const c = counts(views);
  return (
    <div className="ts-deps">
      <div className="ts-deps-bar">
        {canGraph ? (
          <div className="ts-seg-toggle" role="group" aria-label={t('deps.label')}>
            <button type="button" className="ts-btn" aria-pressed={graph} onClick={() => setPrefer('graph')}>{t('deps.graph')}</button>
            <button type="button" className="ts-btn" aria-pressed={!graph} onClick={() => setPrefer('tree')}>{t('deps.tree')}</button>
          </div>
        ) : reason && reason !== 'empty' ? (
          <span className="ts-muted">{t(`deps.why.${reason}` as 'deps.why.narrow')}</span>
        ) : null}
        {g.isolated > 0 && <span className="ts-muted">{t('deps.isolated', { n: g.isolated })}</span>}
      </div>
      {graph && layout.mode === 'graph' ? (
        <DependencyGraph layout={layout} views={views} edges={g.edges} sentence={t('deps.sentence', { n: c.n, layers: layout.layers.length, waiting: c.waiting, failed: c.failed })} locale={locale} t={t} onOpen={onOpen} />
      ) : (
        <DependencyTree visible={visible} all={all} structure={key} label={t('deps.treeSentence', c)} locale={locale} t={t} onOpen={onOpen} />
      )}
    </div>
  );
}

/** What the dependency shape depends on: tasks shown, their state and dependencies, every task's state. */
export function structureKey(visible: readonly TaskView[], all: readonly TaskView[]): string {
  return visible.map((v) => `${v.seq}:${v.display}:${v.deps.join('.')}`).join('|') + '/' + all.map((v) => `${v.seq}:${v.state}`).join('|');
}

/** The freshest view of every task by # (the filtered list wins over the full one). */
function currentViews(visible: readonly TaskView[], all: readonly TaskView[]): Map<number, TaskView> {
  const m = new Map(all.map((v) => [v.seq, v]));
  for (const v of visible) m.set(v.seq, v);
  return m;
}

function nodeLabel(v: TaskView, locale: string, t: TsT): string {
  const parts = [`#${v.seq} ${v.title}`, stateLabel(locale, v.display)];
  if (v.ownerName) parts.push(v.ownerName);
  if (v.waitingOn.length) parts.push(`${t('deps.waitsOn')} #${v.waitingOn.join(', #')}`);
  if (v.waitingOnFailed) parts.push(t('deps.failedDep'));
  if (v.depCancelled) parts.push(t('task.depCancelled'));
  return parts.join(', ');
}

export function DependencyGraph({ layout, views, edges, sentence, locale, t, onOpen }: {
  layout: Extract<DagLayout, { mode: 'graph' }>;
  views: TaskView[];
  edges: Array<[number, number]>;
  sentence: string;
  locale: string;
  t: TsT;
  onOpen: (seq: number) => void;
}) {
  const titleId = useId();
  const byId = useMemo(() => new Map(views.map((v) => [v.seq, v])), [views]);
  const [hi, setHi] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const chain = useMemo(() => (hi === null ? null : dagChain(hi, edges)), [hi, edges]);
  const tabStop = cursor !== null && byId.has(cursor) ? cursor : layout.nodes[0]?.seq;
  /** The node holding keyboard focus (the mouse leaving another node goes back to it). */
  const focusedSeq = (): number | null => {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    for (const [seq, node] of refs.current) if (node === el) return seq;
    return null;
  };
  const W = layout.width + PAD * 2;
  const H = layout.height + PAD * 2;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, seq: number) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const next = dagNeighbor(layout, seq, e.key, edges);
      e.preventDefault();
      if (next === null) return;
      setCursor(next);
      refs.current.get(next)?.focus();
    }
  };

  const table = (
    <table className="ts-table">
      <thead><tr><th>{t('timeline.task')}</th><th>{t('chart.state')}</th><th>{t('drawer.dependsOn')}</th><th>{t('drawer.neededBy')}</th></tr></thead>
      <tbody>
        {views.map((v) => (
          <tr key={v.seq}>
            <td>#{v.seq} {v.title}</td>
            <td>{stateLabel(locale, v.display)}</td>
            <td>{edges.filter((e) => e[1] === v.seq).map((e) => `#${e[0]}`).join(', ') || '-'}</td>
            <td>{edges.filter((e) => e[0] === v.seq).map((e) => `#${e[1]}`).join(', ') || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame t={t} table={table}>
      <div className="ts-dag-scroll">
        <div className={`ts-dag${chain ? ' ts-dag-lit' : ''}`} style={{ width: W, height: H }} role="group" aria-label={sentence}>
          <svg className="ts-dag-edges" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={titleId}>
            <title id={titleId}>{sentence}</title>
            <g transform={`translate(${PAD},${PAD})`}>
              {layout.paths.map((p) => {
                const to = byId.get(p.to);
                const from = byId.get(p.from);
                const lit = !chain || (chain.has(p.from) && chain.has(p.to));
                const failed = from?.state === 'failed';
                return (
                  <g key={`${p.from}>${p.to}`} className={`ts-dag-edge${lit ? '' : ' ts-dim'}${failed ? ' ts-failed-edge' : ''}`} data-from={p.from} data-to={p.to}>
                    <path d={p.d} fill="none" strokeDasharray={to?.waiting ? '5 4' : undefined} />
                    {failed && (
                      <g className="ts-dag-x" transform={`translate(${p.end.x - 9},${p.end.y})`}>
                        <line x1={-3} y1={-3} x2={3} y2={3} />
                        <line x1={-3} y1={3} x2={3} y2={-3} />
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          {layout.nodes.map((n) => {
            const v = byId.get(n.seq);
            if (!v) return null;
            const lit = !chain || chain.has(n.seq);
            return (
              <button
                key={n.seq}
                ref={(el) => { if (el) refs.current.set(n.seq, el); else refs.current.delete(n.seq); }}
                type="button"
                className={`ts-dag-node${v.waiting ? ' ts-waiting' : ''}${closedState(v) ? ' ts-closed' : ''}${lit ? '' : ' ts-dim'}${hi === n.seq ? ' ts-hi' : ''}`}
                data-state={v.display}
                style={{ left: n.x + PAD, top: n.y + PAD, width: DAG_NODE_W, height: DAG_NODE_H }}
                tabIndex={n.seq === tabStop ? 0 : -1}
                aria-label={nodeLabel(v, locale, t)}
                title={nodeLabel(v, locale, t)}
                onMouseEnter={() => setHi(n.seq)}
                onMouseLeave={() => setHi(focusedSeq())}
                onFocus={() => { setHi(n.seq); setCursor(n.seq); }}
                onBlur={() => setHi(null)}
                onKeyDown={(e) => onKey(e, n.seq)}
                onClick={() => onOpen(n.seq)}
              >
                <span className="ts-dag-l1">#{n.seq} {cut(v.title, 22)}</span>
                <span className="ts-dag-l2">
                  <StateIcon state={v.display} />
                  <span>{stateLabel(locale, v.display)}</span>
                  {v.ownerName && <span className="ts-dag-owner">· {v.ownerName}</span>}
                  {v.waitingOnFailed && <Icons.CircleX size={12} aria-hidden="true" className="ts-dag-failmark" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </ChartFrame>
  );
}

interface FlatItem { node: DepTreeNode; level: number; parent: string | null }

function flatten(nodes: DepTreeNode[], collapsed: ReadonlySet<string>, level = 1, parent: string | null = null, out: FlatItem[] = []): FlatItem[] {
  for (const n of nodes) {
    out.push({ node: n, level, parent });
    if (n.children.length && !collapsed.has(n.key)) flatten(n.children, collapsed, level + 1, n.key, out);
  }
  return out;
}

/**
 * The tree fallback: roots are tasks nothing depends on; each child line reads
 * "waits on #11 title (working, t3)". Up/Down move, Right opens or goes to the first child,
 * Left closes or goes to the parent, Home/End, Enter opens the task.
 */
export function DependencyTree({ visible, all, structure, label, locale, t, onOpen }: {
  visible: TaskView[];
  all: TaskView[];
  /** Cache key of the shape (structureKey); defaults to computing it here. */
  structure?: string;
  label: string;
  locale: string;
  t: TsT;
  onOpen: (seq: number) => void;
}) {
  // The tree's shape is cached; each row reads its task from the current lists.
  const key = structure ?? structureKey(visible, all);
  const roots = useMemo(() => depTree(visible, all), [key]);
  const current = currentViews(visible, all);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const flat = flatten(roots, collapsed);
  const tabStop = cursor && flat.some((f) => f.node.key === cursor) ? cursor : flat[0]?.node.key;

  const focusKey = (k: string | undefined | null) => {
    if (!k) return;
    setCursor(k);
    refs.current.get(k)?.focus();
  };
  const toggle = (k: string, open?: boolean) => setCollapsed((prev) => {
    const next = new Set(prev);
    const isOpen = !next.has(k);
    if ((open ?? !isOpen) === true) next.delete(k); else next.add(k);
    return next;
  });

  const onKey = (e: KeyboardEvent<HTMLLIElement>, item: FlatItem) => {
    if (e.target !== e.currentTarget) return;
    const i = flat.findIndex((f) => f.node.key === item.node.key);
    const hasKids = item.node.children.length > 0;
    const open = hasKids && !collapsed.has(item.node.key);
    let handled = true;
    if (e.key === 'ArrowDown') focusKey(flat[i + 1]?.node.key);
    else if (e.key === 'ArrowUp') focusKey(flat[i - 1]?.node.key);
    else if (e.key === 'Home') focusKey(flat[0]?.node.key);
    else if (e.key === 'End') focusKey(flat[flat.length - 1]?.node.key);
    else if (e.key === 'ArrowRight') { if (hasKids && !open) toggle(item.node.key, true); else if (open) focusKey(item.node.children[0].key); }
    else if (e.key === 'ArrowLeft') { if (open) toggle(item.node.key, false); else focusKey(item.parent); }
    else if (e.key === 'Enter' || e.key === ' ') onOpen(item.node.seq);
    else handled = false;
    if (handled) e.preventDefault();
  };

  const render = (nodes: DepTreeNode[], level: number, parent: string | null) => nodes.map((n, idx) => {
    const v = current.get(n.seq) ?? n.view;
    const hasKids = n.children.length > 0;
    const open = hasKids && !collapsed.has(n.key);
    const item: FlatItem = { node: n, level, parent };
    return (
      <li
        key={n.key}
        ref={(el) => { if (el) refs.current.set(n.key, el); else refs.current.delete(n.key); }}
        role="treeitem"
        aria-level={level}
        aria-setsize={nodes.length}
        aria-posinset={idx + 1}
        aria-expanded={hasKids ? open : undefined}
        aria-label={`${level > 1 ? `${t('deps.waitsOn')} ` : ''}${nodeLabel(v, locale, t)}${n.cycle ? `, ${t('deps.cycle')}` : ''}${n.repeated ? `, ${t('deps.repeated')}` : ''}`}
        tabIndex={n.key === tabStop ? 0 : -1}
        className="ts-tree-item"
        onKeyDown={(e) => onKey(e, item)}
        onFocus={(e) => { if (e.target === e.currentTarget) setCursor(n.key); }}
      >
        <div className={`ts-tree-row${closedState(v) ? ' ts-closed' : ''}`} data-state={v.display} style={{ paddingLeft: (level - 1) * 16 }}>
          {hasKids ? (
            <button type="button" className="ts-tree-toggle" tabIndex={-1} aria-label={open ? t('deps.collapse') : t('deps.expand')} onClick={() => toggle(n.key)}>
              {open ? <Icons.ChevronDown size={12} aria-hidden="true" /> : <Icons.ChevronRight size={12} aria-hidden="true" />}
            </button>
          ) : <span className="ts-tree-toggle" aria-hidden="true" />}
          <span className="ts-ink ts-tree-icon"><StateIcon state={v.display} /></span>
          <span className="ts-tree-text" onClick={() => onOpen(n.seq)}>
            {level > 1 && <span className="ts-muted">{t('deps.waitsOn')} </span>}
            #{v.seq} {v.title}{' '}
            <span className="ts-muted">({[stateLabel(locale, v.display), v.ownerName].filter(Boolean).join(', ')})</span>
            {v.waitingOnFailed && <span className="ts-ink" data-state="failed"> · {t('deps.failedDep')}</span>}
            {v.depCancelled && <span className="ts-muted"> · {t('task.depCancelled')}</span>}
            {n.cycle && <span className="ts-ink" data-state="blocked"> · {t('deps.cycle')}</span>}
            {n.repeated && <span className="ts-muted"> · {t('deps.repeated')}</span>}
          </span>
        </div>
        {open && <ul role="group" className="ts-tree-group">{render(n.children, level + 1, n.key)}</ul>}
      </li>
    );
  });

  return <ul className="ts-tree" role="tree" aria-label={label}>{render(roots, 1, null)}</ul>;
}
