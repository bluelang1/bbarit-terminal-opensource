/**
 * graphLayout.ts
 *
 * Force-directed graph layout engine for the Note Graph view.
 * Pure TypeScript, no external dependencies.
 *
 * Uses a force simulation:
 *   - Charge repulsion: pairwise O(n²) for small graphs,
 *     Barnes-Hut quadtree O(n log n) for large graphs
 *   - Spring attraction along edges
 *   - Gravity toward center
 *   - Velocity damping
 */

import type { NoteIndexEntry, TagEntry } from './noteState';

// ───────────────────────── Types ─────────────────────────

export type GraphNodeKind = 'note' | 'tag';

export interface GraphNode {
  /** Note path, or `tag:<name>` for tag nodes */
  id: string;
  label: string;
  tags: string[];
  linkCount: number;
  kind: GraphNodeKind;
  x: number;
  y: number;
  /** Depth axis, used only by the 3D view (graphLayout3d.ts) */
  z: number;
  vx: number;
  vy: number;
  vz: number;
  pinned: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** wikilink: note→note, tag: shared-tag dotted edge, tagnode: note→tag node */
  type: 'wikilink' | 'tag' | 'tagnode';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeMap: Map<string, GraphNode>;
}

export interface SimulationConfig {
  repulsion: number;
  attraction: number;
  gravity: number;
  damping: number;
  maxVelocity: number;
  linkDistance: number;
}

export const DEFAULT_CONFIG: SimulationConfig = {
  repulsion: 800,
  attraction: 0.02,
  gravity: 0.03,
  damping: 0.85,
  maxVelocity: 10,
  linkDistance: 120,
};

export const TAG_NODE_PREFIX = 'tag:';

// ───────────────────────── Search Query ─────────────────────────

/**
 * Obsidian-style search tokens: `tag:foo`, `path:bar`, `file:baz`,
 * `-negated`, plain text matches title/name. All tokens must match (AND).
 */
export interface QueryToken {
  field: 'any' | 'tag' | 'path' | 'file';
  value: string;
  negate: boolean;
}

export interface QueryableNote {
  path: string;
  name: string;
  title: string;
  tags: string[];
}

export function parseQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  for (const raw of String(query || '').trim().split(/\s+/)) {
    if (!raw || raw === '-') continue;
    let text = raw;
    let negate = false;
    if (text.startsWith('-') && text.length > 1) {
      negate = true;
      text = text.slice(1);
    }
    let field: QueryToken['field'] = 'any';
    const match = text.match(/^(tag|path|file):(.*)$/i);
    if (match) {
      field = match[1].toLowerCase() as QueryToken['field'];
      text = match[2];
    }
    const value = text.replace(/^#/, '').toLowerCase();
    if (!value) continue;
    tokens.push({ field, value, negate });
  }
  return tokens;
}

export function noteMatchesQuery(note: QueryableNote, tokens: QueryToken[]): boolean {
  for (const token of tokens) {
    let hit: boolean;
    switch (token.field) {
      case 'tag':
        hit = note.tags.some(t => t.toLowerCase().includes(token.value));
        break;
      case 'path':
        hit = note.path.toLowerCase().includes(token.value);
        break;
      case 'file':
        hit = note.name.toLowerCase().includes(token.value);
        break;
      default:
        hit =
          note.title.toLowerCase().includes(token.value) ||
          note.name.toLowerCase().includes(token.value);
        break;
    }
    if (token.negate ? hit : !hit) return false;
  }
  return true;
}

// ───────────────────────── Build Graph Data ─────────────────────────

export interface BuildGraphOptions {
  /** Notes must have at least one of these tags */
  filterTags?: string[];
  /** Obsidian-style query (tag:, path:, file:, -negation, plain text) */
  filterQuery?: string;
  /** Keep notes with no resolved wikilink edges (default true) */
  showOrphans?: boolean;
  /** Add tag nodes connected to their notes (default false) */
  showTagNodes?: boolean;
}

/**
 * Build graph data from the note index and backlink index.
 */
export function buildGraphData(
  noteIndex: NoteIndexEntry[],
  backlinkIndex: Record<string, string[]>,
  options: BuildGraphOptions = {},
): GraphData {
  const { filterTags, filterQuery, showOrphans = true, showTagNodes = false } = options;

  // Filter notes
  let filtered = noteIndex;

  const tokens = filterQuery ? parseQuery(filterQuery) : [];
  if (tokens.length > 0) {
    filtered = filtered.filter(n => noteMatchesQuery(n, tokens));
  }

  if (filterTags && filterTags.length > 0) {
    filtered = filtered.filter(n =>
      filterTags.some(t => n.tags.includes(t))
    );
  }

  const pathSet = new Set(filtered.map(n => n.path));
  const nodeMap = new Map<string, GraphNode>();

  // Create nodes
  let nodes: GraphNode[] = filtered.map(note => {
    const incoming = backlinkIndex[note.path]?.length ?? 0;
    const outgoing = note.outgoingLinks.length;
    const node: GraphNode = {
      id: note.path,
      label: note.title || note.name,
      tags: note.tags,
      linkCount: incoming + outgoing,
      kind: 'note',
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      pinned: false,
    };
    nodeMap.set(note.path, node);
    return node;
  });

  // Resolve link names to paths (case-insensitive match on name or title)
  const aliasToPath = new Map<string, string>();
  for (const note of filtered) {
    const name = note.name.trim().toLowerCase();
    const title = note.title.trim().toLowerCase();
    if (name && !aliasToPath.has(name)) aliasToPath.set(name, note.path);
    if (title && !aliasToPath.has(title)) aliasToPath.set(title, note.path);
  }

  // Build wikilink edges (only between filtered nodes)
  const edgeSet = new Set<string>();
  let edges: GraphEdge[] = [];

  for (const note of filtered) {
    // Outgoing links
    for (const linkName of note.outgoingLinks) {
      const targetPath = aliasToPath.get(String(linkName || '').trim().toLowerCase());
      if (targetPath && targetPath !== note.path) {
        const key = [note.path, targetPath].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: note.path, target: targetPath, type: 'wikilink' });
        }
      }
    }

    // Incoming links from backlink index
    const incomingPaths = backlinkIndex[note.path] || [];
    for (const srcPath of incomingPaths) {
      if (pathSet.has(srcPath) && srcPath !== note.path) {
        const key = [srcPath, note.path].sort().join('|');
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ source: srcPath, target: note.path, type: 'wikilink' });
        }
      }
    }
  }

  // Drop orphans (notes with no resolved wikilink edges)
  if (!showOrphans) {
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    nodes = nodes.filter(node => {
      if (connected.has(node.id)) return true;
      nodeMap.delete(node.id);
      return false;
    });
    edges = edges.filter(e => nodeMap.has(e.source) && nodeMap.has(e.target));
  }

  // Tag nodes: one node per tag, connected to every note carrying it
  if (showTagNodes) {
    const tagToPaths = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.kind !== 'note') continue;
      for (const tag of node.tags) {
        const list = tagToPaths.get(tag);
        if (list) list.push(node.id);
        else tagToPaths.set(tag, [node.id]);
      }
    }
    for (const [tag, paths] of tagToPaths) {
      const id = TAG_NODE_PREFIX + tag;
      if (nodeMap.has(id)) continue;
      const tagNode: GraphNode = {
        id,
        label: '#' + tag,
        tags: [tag],
        linkCount: paths.length,
        kind: 'tag',
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        pinned: false,
      };
      nodes.push(tagNode);
      nodeMap.set(id, tagNode);
      for (const path of paths) {
        edges.push({ source: path, target: id, type: 'tagnode' });
      }
    }
  }

  return { nodes, edges, nodeMap };
}

// ───────────────────────── Build Tag Edges ─────────────────────────

/**
 * Build dotted edges between notes sharing the same tag.
 * For each tag, connect all note pairs that share it.
 * Deduplicates with existing edges.
 */
export function buildTagEdges(
  tagIndex: TagEntry[],
  existingEdges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
): GraphEdge[] {
  const existingSet = new Set(existingEdges.map(e => [e.source, e.target].sort().join('|')));
  const tagEdges: GraphEdge[] = [];

  for (const tagEntry of tagIndex) {
    const paths = tagEntry.notePaths.filter(p => nodeMap.has(p));
    // Connect pairs (limit to avoid explosion)
    const maxPairs = Math.min(paths.length, 20);
    for (let i = 0; i < maxPairs; i++) {
      for (let j = i + 1; j < maxPairs; j++) {
        const key = [paths[i], paths[j]].sort().join('|');
        if (!existingSet.has(key)) {
          existingSet.add(key);
          tagEdges.push({ source: paths[i], target: paths[j], type: 'tag' });
        }
      }
    }
  }

  return tagEdges;
}

// ───────────────────────── Local Graph ─────────────────────────

/**
 * Extract the depth-limited subgraph around a center node (Obsidian local graph).
 * Node objects are shared with the input so positions carry over.
 */
export function buildLocalGraph(data: GraphData, centerId: string, depth: number): GraphData {
  if (!data.nodeMap.has(centerId)) return data;

  const adjacency = new Map<string, string[]>();
  const addAdj = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const edge of data.edges) {
    addAdj(edge.source, edge.target);
    addAdj(edge.target, edge.source);
  }

  const keep = new Set<string>([centerId]);
  let frontier = [centerId];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) || []) {
        if (!keep.has(neighbor)) {
          keep.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  const nodes = data.nodes.filter(n => keep.has(n.id));
  const edges = data.edges.filter(e => keep.has(e.source) && keep.has(e.target));
  const nodeMap = new Map(nodes.map(n => [n.id, n] as const));
  return { nodes, edges, nodeMap };
}

// ───────────────────────── Layout Types ─────────────────────────

export type LayoutType = 'force' | 'circle' | 'grid' | 'hierarchical';

// ───────────────────────── Initialize Positions ─────────────────────────

/**
 * Place nodes using the specified layout algorithm.
 */
export function initializePositions(
  nodes: GraphNode[],
  cx: number,
  cy: number,
  radius: number,
  layout: LayoutType = 'force',
): void {
  switch (layout) {
    case 'circle': return layoutCircle(nodes, cx, cy, radius);
    case 'grid': return layoutGrid(nodes, cx, cy, radius);
    case 'hierarchical': return layoutHierarchical(nodes, cx, cy, radius);
    case 'force':
    default: return layoutCircle(nodes, cx, cy, radius * 0.8);
  }
}

/** Circle layout: nodes arranged in a circle */
function layoutCircle(nodes: GraphNode[], cx: number, cy: number, radius: number): void {
  const n = nodes.length;
  if (n === 0) return;
  if (n === 1) { nodes[0].x = cx; nodes[0].y = cy; return; }
  const angleStep = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const angle = angleStep * i - Math.PI / 2;
    nodes[i].x = cx + radius * Math.cos(angle);
    nodes[i].y = cy + radius * Math.sin(angle);
    nodes[i].vx = 0;
    nodes[i].vy = 0;
  }
}

/** Grid layout: nodes in a regular grid */
function layoutGrid(nodes: GraphNode[], cx: number, cy: number, radius: number): void {
  const n = nodes.length;
  if (n === 0) return;
  if (n === 1) { nodes[0].x = cx; nodes[0].y = cy; return; }
  const cols = Math.ceil(Math.sqrt(n));
  const spacing = (radius * 2) / Math.max(cols - 1, 1);
  const startX = cx - (cols - 1) * spacing / 2;
  const rows = Math.ceil(n / cols);
  const startY = cy - (rows - 1) * spacing / 2;
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodes[i].x = startX + col * spacing;
    nodes[i].y = startY + row * spacing;
    nodes[i].vx = 0;
    nodes[i].vy = 0;
  }
}

/** Hierarchical layout: group by tag, layered top-to-bottom */
function layoutHierarchical(nodes: GraphNode[], cx: number, cy: number, radius: number): void {
  const n = nodes.length;
  if (n === 0) return;
  if (n === 1) { nodes[0].x = cx; nodes[0].y = cy; return; }

  // Group by first tag (or 'untagged')
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const group = node.tags[0] || '_untagged';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(node);
  }

  const groupKeys = [...groups.keys()].sort();
  const layerHeight = (radius * 2) / Math.max(groupKeys.length - 1, 1);
  const startY = cy - (groupKeys.length - 1) * layerHeight / 2;

  for (let gi = 0; gi < groupKeys.length; gi++) {
    const members = groups.get(groupKeys[gi])!;
    const spacing = (radius * 2) / Math.max(members.length, 1);
    const startX = cx - (members.length - 1) * spacing / 2;
    for (let mi = 0; mi < members.length; mi++) {
      members[mi].x = startX + mi * spacing;
      members[mi].y = startY + gi * layerHeight;
      members[mi].vx = 0;
      members[mi].vy = 0;
    }
  }
}

// ───────────────────────── Barnes-Hut Quadtree ─────────────────────────

const BARNES_HUT_THRESHOLD = 150;
const BH_THETA_SQ = 0.85 * 0.85;
const BH_MAX_DEPTH = 24;

interface QuadTree {
  x: number;
  y: number;
  half: number;
  mass: number;
  comX: number;
  comY: number;
  node: GraphNode | null;
  children: (QuadTree | null)[] | null;
}

function makeQuad(x: number, y: number, half: number): QuadTree {
  return { x, y, half, mass: 0, comX: 0, comY: 0, node: null, children: null };
}

function qtInsert(quad: QuadTree, node: GraphNode, depth: number): void {
  quad.mass += 1;
  quad.comX += (node.x - quad.comX) / quad.mass;
  quad.comY += (node.y - quad.comY) / quad.mass;

  if (quad.mass === 1) {
    quad.node = node;
    return;
  }
  if (depth >= BH_MAX_DEPTH) return; // aggregate only, avoid infinite split on coincident points

  if (!quad.children) {
    quad.children = [null, null, null, null];
    const prev = quad.node;
    quad.node = null;
    if (prev) qtInsertChild(quad, prev, depth);
  }
  qtInsertChild(quad, node, depth);
}

function qtInsertChild(quad: QuadTree, node: GraphNode, depth: number): void {
  const qx = node.x >= quad.x ? 1 : 0;
  const qy = node.y >= quad.y ? 1 : 0;
  const qi = qy * 2 + qx;
  let child = quad.children![qi];
  if (!child) {
    const h = quad.half / 2;
    child = makeQuad(quad.x + (qx ? h : -h), quad.y + (qy ? h : -h), h);
    quad.children![qi] = child;
  }
  qtInsert(child, node, depth + 1);
}

function buildQuadTree(nodes: GraphNode[]): QuadTree {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.x > maxX) maxX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.y > maxY) maxY = node.y;
  }
  const half = Math.max(maxX - minX, maxY - minY) / 2 + 1;
  const root = makeQuad((minX + maxX) / 2, (minY + maxY) / 2, half);
  for (const node of nodes) qtInsert(root, node, 0);
  return root;
}

/** Accumulate repulsion force on `node` from the tree. Returns {fx, fy} via out param. */
function qtForce(quad: QuadTree, node: GraphNode, repulsion: number, out: { fx: number; fy: number }): void {
  if (quad.mass === 0 || quad.node === node) return;

  const dx = node.x - quad.comX;
  const dy = node.y - quad.comY;
  let distSq = dx * dx + dy * dy;

  const size = quad.half * 2;
  if (quad.children && size * size > BH_THETA_SQ * distSq) {
    for (const child of quad.children) {
      if (child) qtForce(child, node, repulsion, out);
    }
    return;
  }

  if (distSq < 1) distSq = 1;
  const dist = Math.sqrt(distSq);
  const force = (repulsion * quad.mass) / distSq;
  out.fx += (dx / dist) * force;
  out.fy += (dy / dist) * force;
}

// ───────────────────────── Simulation Tick ─────────────────────────

/**
 * Run one tick of force simulation.
 * Returns total kinetic energy for convergence detection.
 */
export function simulateTick(
  data: GraphData,
  config: SimulationConfig,
  cx: number,
  cy: number,
): number {
  const { nodes, edges, nodeMap } = data;
  const n = nodes.length;
  if (n === 0) return 0;

  // Reset forces
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);

  // Charge repulsion
  if (n >= BARNES_HUT_THRESHOLD) {
    const root = buildQuadTree(nodes);
    const out = { fx: 0, fy: 0 };
    for (let i = 0; i < n; i++) {
      out.fx = 0;
      out.fy = 0;
      qtForce(root, nodes[i], config.repulsion, out);
      fx[i] += out.fx;
      fy[i] += out.fy;
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = config.repulsion / distSq;
        const fdx = (dx / dist) * force;
        const fdy = (dy / dist) * force;
        fx[i] -= fdx;
        fy[i] -= fdy;
        fx[j] += fdx;
        fy[j] += fdy;
      }
    }
  }

  // Edge spring attraction
  const indexOfNode = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOfNode.set(nodes[i].id, i);

  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (!srcNode || !tgtNode) continue;
    const si = indexOfNode.get(edge.source);
    const ti = indexOfNode.get(edge.target);
    if (si === undefined || ti === undefined) continue;

    const dx = tgtNode.x - srcNode.x;
    const dy = tgtNode.y - srcNode.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    // Weaker attraction for tag edges
    const strength = edge.type === 'tag' ? config.attraction * 0.3 : config.attraction;
    const idealLen = edge.type === 'tag'
      ? config.linkDistance * 1.65
      : edge.type === 'tagnode'
        ? config.linkDistance * 0.75
        : config.linkDistance;
    const displacement = dist - idealLen;
    const fdx = (dx / dist) * displacement * strength;
    const fdy = (dy / dist) * displacement * strength;
    fx[si] += fdx;
    fy[si] += fdy;
    fx[ti] -= fdx;
    fy[ti] -= fdy;
  }

  // Gravity toward center
  for (let i = 0; i < n; i++) {
    const dx = cx - nodes[i].x;
    const dy = cy - nodes[i].y;
    fx[i] += dx * config.gravity;
    fy[i] += dy * config.gravity;
  }

  // Apply forces with damping
  let kineticEnergy = 0;
  for (let i = 0; i < n; i++) {
    if (nodes[i].pinned) continue;

    nodes[i].vx = (nodes[i].vx + fx[i]) * config.damping;
    nodes[i].vy = (nodes[i].vy + fy[i]) * config.damping;

    // Clamp velocity
    const speed = Math.sqrt(nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy);
    if (speed > config.maxVelocity) {
      nodes[i].vx = (nodes[i].vx / speed) * config.maxVelocity;
      nodes[i].vy = (nodes[i].vy / speed) * config.maxVelocity;
    }

    nodes[i].x += nodes[i].vx;
    nodes[i].y += nodes[i].vy;

    kineticEnergy += nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy;
  }

  return kineticEnergy;
}
