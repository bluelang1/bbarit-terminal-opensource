// Team status: the dependency graph as pure functions (no React). `depSubgraph` picks the
// tasks the Dependencies tab shows, `layoutDag` lays them out left to right (longest-path
// layering, dummy nodes for long edges, barycenter sweeps keeping the fewest crossings) or
// says why it cannot (too many, too deep, a cycle), and `depTree` is the indented fallback.
// Design: docs/superpowers/specs/2026-11-16-team-status-view-design.md section 4.1.
import type { TaskView } from './model';

// ── Which tasks ──────────────────────────────────────────────────────────

const closed = (v: TaskView) => v.state === 'done' || v.state === 'cancelled';

export interface DepSubgraph {
  /** Tasks in the graph: open ones with a dependency or a dependent, plus done/cancelled direct deps of those (dimmed). */
  views: TaskView[];
  /** `[dependency, dependent]`: the dependency must finish first. */
  edges: Array<[number, number]>;
  /** Not-done tasks with no dependency and no dependent (left out of the graph). */
  isolated: number;
}

/**
 * The dependency subgraph of `visible` tasks (the filtered list): every edge ends at a task
 * that is not done or cancelled; a done/cancelled task appears only as a direct dependency of
 * one. `all` resolves dependencies that the filters hide (they are left out, not invented).
 */
export function depSubgraph(visible: readonly TaskView[], all: readonly TaskView[] = visible): DepSubgraph {
  const shown = new Map(visible.map((v) => [v.seq, v]));
  const known = new Map(all.map((v) => [v.seq, v]));
  const edges: Array<[number, number]> = [];
  const inGraph = new Map<number, TaskView>();
  const open = visible.filter((v) => !closed(v));
  for (const v of open) {
    for (const d of [...new Set(v.deps)].sort((a, b) => a - b)) {
      const dep = shown.get(d) ?? (known.get(d) && closed(known.get(d)!) ? known.get(d) : undefined);
      if (!dep || dep.seq === v.seq) continue;
      edges.push([dep.seq, v.seq]);
      inGraph.set(dep.seq, dep);
      inGraph.set(v.seq, v);
    }
  }
  const views = [...inGraph.values()].sort((a, b) => a.seq - b.seq);
  return { views, edges, isolated: open.filter((v) => !inGraph.has(v.seq)).length };
}

// ── Layered layout ───────────────────────────────────────────────────────

export const DAG_NODE_W = 168;
export const DAG_NODE_H = 40;
export const DAG_GAP_X = 56;
export const DAG_GAP_Y = 12;
/** Walks stop here ("graph too deep" → tree), whatever maxLayers says. */
export const DAG_WALK_CAP = 64;

export interface DagNode {
  seq: number;
  layer: number;
  order: number;
  x: number;
  y: number;
}

export interface DagPath {
  from: number;
  to: number;
  /** SVG path: cubic segments through the dummy points of a long edge. */
  d: string;
  /** End point (left middle of the dependent), for markers. */
  end: { x: number; y: number };
}

export type DagLayout =
  | {
      mode: 'graph';
      /** Ids per layer in their final order; dummy nodes are `d:<from>-<to>:<k>`. */
      layers: string[][];
      nodes: DagNode[];
      paths: DagPath[];
      crossings: number;
      width: number;
      height: number;
    }
  | { mode: 'tree'; reason: 'tooMany' | 'tooDeep' | 'cycle' | 'empty' };


/** Edge crossings between two adjacent layers. */
function crossingsBetween(edges: Array<[string, string]>, posA: Map<string, number>, posB: Map<string, number>): number {
  let n = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a1, b1] = edges[i];
      const [a2, b2] = edges[j];
      const da = posA.get(a1)! - posA.get(a2)!;
      const db = posB.get(b1)! - posB.get(b2)!;
      if (da * db < 0) n += 1;
    }
  }
  return n;
}

/**
 * Lays the graph out left to right (dependencies left of their dependents). Deterministic:
 * the same nodes and edges always give the same layout, whatever their input order.
 * `{ mode: 'tree', reason }` when there are more than `maxNodes` tasks, more than `maxLayers`
 * layers (or the walk passes DAG_WALK_CAP), or a cycle.
 */
export function layoutDag(
  nodeIds: readonly number[],
  edgeList: ReadonlyArray<readonly [number, number]>,
  opts: { maxNodes?: number; maxLayers?: number; sweeps?: number } = {},
): DagLayout {
  const maxNodes = opts.maxNodes ?? 40;
  const maxLayers = Math.min(opts.maxLayers ?? 8, DAG_WALK_CAP);
  const ids = [...new Set(nodeIds)].sort((a, b) => a - b);
  if (!ids.length) return { mode: 'tree', reason: 'empty' };
  if (ids.length > maxNodes) return { mode: 'tree', reason: 'tooMany' };
  const idSet = new Set(ids);
  const edgeKeys = new Set<string>();
  const edges: Array<[number, number]> = [];
  for (const [a, b] of edgeList) {
    if (!idSet.has(a) || !idSet.has(b) || a === b) {
      if (a === b && idSet.has(a)) return { mode: 'tree', reason: 'cycle' };
      continue;
    }
    const k = `${a}>${b}`;
    if (edgeKeys.has(k)) continue;
    edgeKeys.add(k);
    edges.push([a, b]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // Longest-path layering (Kahn): a node sits one layer right of its deepest dependency.
  const preds = new Map<number, number[]>(ids.map((i) => [i, []]));
  const succs = new Map<number, number[]>(ids.map((i) => [i, []]));
  for (const [a, b] of edges) { succs.get(a)!.push(b); preds.get(b)!.push(a); }
  const indeg = new Map(ids.map((i) => [i, preds.get(i)!.length]));
  const layer = new Map<number, number>();
  const queue = ids.filter((i) => indeg.get(i) === 0);
  for (const i of queue) layer.set(i, 0);
  let done = 0;
  while (queue.length) {
    queue.sort((a, b) => a - b);
    const v = queue.shift()!;
    done += 1;
    const lv = layer.get(v)!;
    if (lv + 1 >= DAG_WALK_CAP) return { mode: 'tree', reason: 'tooDeep' };
    for (const w of succs.get(v)!) {
      layer.set(w, Math.max(layer.get(w) ?? 0, lv + 1));
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  if (done < ids.length) return { mode: 'tree', reason: 'cycle' };
  const layerCount = Math.max(...ids.map((i) => layer.get(i)!)) + 1;
  if (layerCount > maxLayers) return { mode: 'tree', reason: 'tooDeep' };

  // Dummy nodes: an edge spanning k layers becomes k hops.
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const i of ids) layers[layer.get(i)!].push(String(i));
  const hops: Array<[string, string]> = [];
  const chains = new Map<string, string[]>();
  for (const [a, b] of edges) {
    const la = layer.get(a)!;
    const lb = layer.get(b)!;
    const chain = [String(a)];
    for (let l = la + 1; l < lb; l++) {
      const d = `d:${a}-${b}:${l}`;
      layers[l].push(d);
      chain.push(d);
    }
    chain.push(String(b));
    for (let k = 0; k + 1 < chain.length; k++) hops.push([chain[k], chain[k + 1]]);
    chains.set(`${a}>${b}`, chain);
  }
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  // Hops grouped by the layer they leave (built once; crossing counts read it per sweep).
  const layerOfId = new Map<string, number>();
  layers.forEach((row, l) => row.forEach((id) => layerOfId.set(id, l)));
  const hopsByLayer: Array<Array<[string, string]>> = layers.map(() => []);
  for (const [a, b] of hops) {
    (down.get(a) ?? down.set(a, []).get(a)!).push(b);
    (up.get(b) ?? up.set(b, []).get(b)!).push(a);
    hopsByLayer[layerOfId.get(a)!].push([a, b]);
  }

  const positions = (ls: string[][]) => ls.map((row) => new Map(row.map((id, i) => [id, i])));
  const countAll = (ls: string[][]) => {
    const pos = positions(ls);
    let n = 0;
    for (let l = 0; l + 1 < ls.length; l++) n += crossingsBetween(hopsByLayer[l], pos[l], pos[l + 1]);
    return n;
  };

  // Barycenter sweeps: down (by dependencies) then up (by dependents), ties by the previous
  // position; keep the ordering with the fewest crossings (the first one on a tie).
  let order = layers.map((row) => [...row]);
  let best = order.map((row) => [...row]);
  let bestCross = countAll(order);
  const sweeps = opts.sweeps ?? 4;
  for (let s = 0; s < sweeps && bestCross > 0; s++) {
    const downward = s % 2 === 0;
    const range = downward ? [...Array(layerCount).keys()].slice(1) : [...Array(layerCount).keys()].reverse().slice(1);
    for (const l of range) {
      const ref = new Map((order[downward ? l - 1 : l + 1] || []).map((id, i) => [id, i]));
      const prev = new Map(order[l].map((id, i) => [id, i]));
      const bary = (id: string) => {
        const ns = (downward ? up.get(id) : down.get(id)) || [];
        const ps = ns.map((n) => ref.get(n)).filter((p): p is number => p !== undefined);
        return ps.length ? ps.reduce((x, y) => x + y, 0) / ps.length : prev.get(id)!;
      };
      order[l] = [...order[l]].sort((a, b) => bary(a) - bary(b) || prev.get(a)! - prev.get(b)!);
    }
    const c = countAll(order);
    if (c < bestCross) { bestCross = c; best = order.map((row) => [...row]); }
    order = order.map((row) => [...row]);
  }

  // Coordinates: x by layer, y by order, each layer centred on the tallest.
  const tallest = Math.max(...best.map((row) => row.length));
  const stepY = DAG_NODE_H + DAG_GAP_Y;
  const stepX = DAG_NODE_W + DAG_GAP_X;
  const at = new Map<string, { x: number; y: number }>();
  best.forEach((row, l) => {
    const offset = ((tallest - row.length) * stepY) / 2;
    row.forEach((id, i) => at.set(id, { x: l * stepX, y: offset + i * stepY }));
  });
  const nodes: DagNode[] = ids.map((seq) => {
    const p = at.get(String(seq))!;
    const l = layer.get(seq)!;
    return { seq, layer: l, order: best[l].indexOf(String(seq)), x: p.x, y: p.y };
  });
  const paths: DagPath[] = edges.map(([a, b]) => {
    const chain = chains.get(`${a}>${b}`)!;
    const pts = chain.map((id, k) => {
      const p = at.get(id)!;
      const cy = p.y + DAG_NODE_H / 2;
      if (k === 0) return { x: p.x + DAG_NODE_W, y: cy };
      if (k === chain.length - 1) return { x: p.x, y: cy };
      return { x: p.x + DAG_NODE_W / 2, y: cy };
    });
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let k = 1; k < pts.length; k++) {
      const p0 = pts[k - 1];
      const p1 = pts[k];
      const mx = (p0.x + p1.x) / 2;
      d += ` C${mx},${p0.y} ${mx},${p1.y} ${p1.x},${p1.y}`;
    }
    return { from: a, to: b, d, end: pts[pts.length - 1] };
  });
  return {
    mode: 'graph',
    layers: best,
    nodes,
    paths,
    crossings: bestCross,
    width: (layerCount - 1) * stepX + DAG_NODE_W,
    height: tallest * stepY - DAG_GAP_Y,
  };
}

/** Every task upstream (dependencies, transitively) and downstream (dependents) of `seq`, itself included. */
export function dagChain(seq: number, edges: ReadonlyArray<readonly [number, number]>): Set<number> {
  const out = new Set<number>([seq]);
  const walk = (start: number, dir: 0 | 1) => {
    const stack = [start];
    const seen = new Set<number>([start]);
    while (stack.length) {
      const v = stack.pop()!;
      for (const e of edges) {
        const [from, to] = dir === 0 ? [e[1], e[0]] : [e[0], e[1]];
        if (from !== v || seen.has(to)) continue;
        seen.add(to);
        out.add(to);
        stack.push(to);
      }
    }
  };
  walk(seq, 0);
  walk(seq, 1);
  return out;
}

/** Arrow-key target in the graph: left = a dependency, right = a dependent, up/down = same layer. */
export function dagNeighbor(layout: Extract<DagLayout, { mode: 'graph' }>, seq: number, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', edges: ReadonlyArray<readonly [number, number]>): number | null {
  const node = layout.nodes.find((n) => n.seq === seq);
  if (!node) return null;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const row = layout.nodes.filter((n) => n.layer === node.layer).sort((a, b) => a.order - b.order);
    const i = row.findIndex((n) => n.seq === seq);
    return row[i + (key === 'ArrowDown' ? 1 : -1)]?.seq ?? null;
  }
  const others = key === 'ArrowLeft' ? edges.filter((e) => e[1] === seq).map((e) => e[0]) : edges.filter((e) => e[0] === seq).map((e) => e[1]);
  const cand = layout.nodes.filter((n) => others.includes(n.seq));
  if (!cand.length) return null;
  // The nearest one vertically, then the lower #.
  cand.sort((a, b) => Math.abs(a.y - node.y) - Math.abs(b.y - node.y) || a.seq - b.seq);
  return cand[0].seq;
}

// ── Tree fallback ────────────────────────────────────────────────────────

export interface DepTreeNode {
  /** Unique per position in the tree (a task can appear under several parents). */
  key: string;
  seq: number;
  view: TaskView;
  /** What this task waits on. */
  children: DepTreeNode[];
  /** Already shown higher up this branch (a cycle): not expanded again. */
  cycle?: boolean;
  /** Already expanded elsewhere in the tree: shown, not expanded again. */
  repeated?: boolean;
}

/**
 * Indented tree for the Dependencies tab: roots are tasks nothing in the graph depends on
 * (most recent work last), children are what each one waits on. Cycles and repeats are
 * marked and not expanded again, so the tree is finite on any input.
 */
export function depTree(visible: readonly TaskView[], all: readonly TaskView[] = visible): DepTreeNode[] {
  const g = depSubgraph(visible, all);
  const byId = new Map(g.views.map((v) => [v.seq, v]));
  const depsOf = new Map<number, number[]>();
  const hasDependent = new Set<number>();
  for (const [a, b] of g.edges) {
    depsOf.set(b, [...(depsOf.get(b) || []), a]);
    hasDependent.add(a);
  }
  const roots = g.views.filter((v) => !hasDependent.has(v.seq));
  const expanded = new Set<number>();
  const build = (seq: number, path: string, onPath: ReadonlySet<number>): DepTreeNode => {
    const view = byId.get(seq)!;
    const key = `${path}/${seq}`;
    if (onPath.has(seq)) return { key, seq, view, children: [], cycle: true };
    if (expanded.has(seq) && (depsOf.get(seq) || []).length) return { key, seq, view, children: [], repeated: true };
    expanded.add(seq);
    const next = new Set(onPath).add(seq);
    const children = [...(depsOf.get(seq) || [])].sort((a, b) => a - b).map((d) => build(d, key, next));
    return { key, seq, view, children };
  };
  const out: DepTreeNode[] = [];
  for (const r of roots) out.push(build(r.seq, '', new Set()));
  // Nodes only reachable through a cycle (every node of a pure cycle has a dependent): start
  // from the lowest # not shown yet.
  for (const v of g.views) {
    if (!expanded.has(v.seq)) out.push(build(v.seq, '', new Set()));
  }
  return out;
}
