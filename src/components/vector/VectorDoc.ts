// Vector engine scene graph (design.pen.json version 2, P1: schema + parser).
// Layout is deliberately NOT solved here — vframe row/column maps straight to
// CSS flexbox at render time, so the browser is the layout engine
// (docs/DESIGN-VECTOR-ENGINE.md). The parser is lenient like parsePenDoc:
// agents hand-write nodes, so missing fields get defaults instead of drops.

export type VSizingMode = 'fixed' | 'hug' | 'fill';
export type VLayout = 'free' | 'row' | 'column';

interface VBase {
  id: string;
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
}

export interface VFrameNode extends VBase {
  type: 'vframe';
  layout: VLayout;
  gap: number;
  padding: [number, number, number, number];
  alignMain: 'start' | 'center' | 'end' | 'between';
  alignCross: 'start' | 'center' | 'end' | 'stretch';
  sizing: { w: VSizingMode; h: VSizingMode };
  fill: string;
  stroke?: string;
  strokeW?: number;
  radius: number;
  clip: boolean;
  children: VNode[];
}

export interface VTextNode extends VBase {
  type: 'vtext';
  text: string;
  size: number;
  weight: number;
  color: string;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  font?: string;
  sizing: { w: VSizingMode; h: VSizingMode };
}

export interface VBoxNode extends VBase {
  type: 'vbox';
  fill: string;
  stroke?: string;
  strokeW?: number;
  radius: number;
  sizing: { w: VSizingMode; h: VSizingMode };
}

export interface VImageNode extends VBase {
  type: 'vimage';
  file: string;
  fit: 'cover' | 'contain' | 'fill';
  radius: number;
  sizing: { w: VSizingMode; h: VSizingMode };
}

export interface VPathNode extends VBase {
  type: 'vpath';
  points: number[][];
  stroke: string;
  strokeW: number;
  fill: string;
  closed: boolean;
}

export interface VInstanceNode extends VBase {
  type: 'vinstance';
  of: string;
  overrides: Record<string, Record<string, unknown>>;
}

export type VNode = VFrameNode | VTextNode | VBoxNode | VImageNode | VPathNode | VInstanceNode;

export interface VScene {
  components: Record<string, VNode>;
  roots: VNode[];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T =>
  (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : d);

let vSeq = 0;
export function vId(prefix = 'v'): string {
  vSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${vSeq.toString(36)}`;
}

function parseSizing(v: unknown): { w: VSizingMode; h: VSizingMode } {
  const s = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  return {
    w: oneOf(s.w, ['fixed', 'hug', 'fill'] as const, 'fixed'),
    h: oneOf(s.h, ['fixed', 'hug', 'fill'] as const, 'hug'),
  };
}

function parseBase(n: Record<string, unknown>): VBase {
  const base: VBase = { id: str(n.id, '') || vId() };
  if (typeof n.name === 'string') base.name = n.name;
  if (typeof n.x === 'number') base.x = n.x;
  if (typeof n.y === 'number') base.y = n.y;
  if (typeof n.w === 'number') base.w = n.w;
  if (typeof n.h === 'number') base.h = n.h;
  if (n.visible === false) base.visible = false;
  return base;
}

// depth-capped recursive node parser; malformed nodes return null and are dropped
export function parseVNode(raw: unknown, depth = 0): VNode | null {
  if (!raw || typeof raw !== 'object' || depth > 24) return null;
  const n = raw as Record<string, unknown>;
  const base = parseBase(n);
  switch (n.type) {
    case 'vframe': {
      const pad = Array.isArray(n.padding) ? n.padding : [];
      const children = (Array.isArray(n.children) ? n.children : [])
        .slice(0, 200)
        .map((c) => parseVNode(c, depth + 1))
        .filter((c): c is VNode => c !== null);
      return {
        ...base, type: 'vframe',
        layout: oneOf(n.layout, ['free', 'row', 'column'] as const, 'free'),
        gap: num(n.gap, 0),
        padding: [num(pad[0], 0), num(pad[1], 0), num(pad[2], 0), num(pad[3], 0)],
        alignMain: oneOf(n.alignMain, ['start', 'center', 'end', 'between'] as const, 'start'),
        alignCross: oneOf(n.alignCross, ['start', 'center', 'end', 'stretch'] as const, 'start'),
        sizing: parseSizing(n.sizing),
        fill: str(n.fill, 'transparent'),
        ...(typeof n.stroke === 'string' ? { stroke: n.stroke, strokeW: num(n.strokeW, 1) } : {}),
        radius: num(n.radius, 0),
        clip: n.clip !== false,
        children,
      };
    }
    case 'vtext':
      return {
        ...base, type: 'vtext',
        text: str(n.text, 'Text'),
        size: Math.max(6, num(n.size, 16)),
        weight: num(n.weight, 400),
        color: str(n.color, '#111111'),
        lineHeight: num(n.lineHeight, 1.4),
        align: oneOf(n.align, ['left', 'center', 'right'] as const, 'left'),
        ...(typeof n.font === 'string' ? { font: n.font } : {}),
        sizing: parseSizing(n.sizing),
      };
    case 'vbox':
      return {
        ...base, type: 'vbox',
        fill: str(n.fill, '#E5E7EB'),
        ...(typeof n.stroke === 'string' ? { stroke: n.stroke, strokeW: num(n.strokeW, 1) } : {}),
        radius: num(n.radius, 0),
        sizing: parseSizing(n.sizing),
      };
    case 'vimage':
      if (!str(n.file, '')) return null;
      return {
        ...base, type: 'vimage',
        file: str(n.file, ''),
        fit: oneOf(n.fit, ['cover', 'contain', 'fill'] as const, 'cover'),
        radius: num(n.radius, 0),
        sizing: parseSizing(n.sizing),
      };
    case 'vpath': {
      const points = (Array.isArray(n.points) ? n.points : [])
        .filter((p): p is number[] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map((p) => [p[0], p[1]]);
      if (points.length < 2) return null;
      return {
        ...base, type: 'vpath', points,
        stroke: str(n.stroke, '#111111'),
        strokeW: Math.max(0.5, num(n.strokeW, 2)),
        fill: str(n.fill, 'none'),
        closed: n.closed === true,
      };
    }
    case 'vinstance': {
      if (!str(n.of, '')) return null;
      const rawOv = (n.overrides && typeof n.overrides === 'object') ? n.overrides as Record<string, unknown> : {};
      const overrides: Record<string, Record<string, unknown>> = {};
      for (const [k, v] of Object.entries(rawOv)) {
        if (v && typeof v === 'object') overrides[k] = v as Record<string, unknown>;
      }
      return { ...base, type: 'vinstance', of: str(n.of, ''), overrides };
    }
    default:
      return null;
  }
}

export function parseVScene(raw: unknown): VScene | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const components: Record<string, VNode> = {};
  if (s.components && typeof s.components === 'object') {
    for (const [name, node] of Object.entries(s.components as Record<string, unknown>)) {
      const parsed = parseVNode(node);
      if (parsed) components[name] = parsed;
    }
  }
  const roots = (Array.isArray(s.roots) ? s.roots : [])
    .slice(0, 60)
    .map((r) => parseVNode(r))
    .filter((r): r is VNode => r !== null);
  if (roots.length === 0 && Object.keys(components).length === 0) return undefined;
  return { components, roots };
}

// Materialize an instance: clone the component tree, remap ids (stable,
// derived from the instance id so selection survives re-renders), then apply
// per-source-node overrides. Depth-capped against recursive components.
export function resolveInstance(scene: VScene, inst: VInstanceNode, depth = 0): VNode | null {
  if (depth > 8) return null;
  const source = scene.components[inst.of];
  if (!source) return null;
  const clone = (n: VNode): VNode => {
    const ov = inst.overrides[n.id];
    const mapped = { ...n, ...(ov ?? {}), id: `${inst.id}:${n.id}` } as VNode;
    if (mapped.type === 'vframe') {
      return { ...mapped, children: (n as VFrameNode).children.map(clone) };
    }
    return mapped;
  };
  const resolved = clone(source);
  // The instance node's own geometry wins over the component root's.
  return {
    ...resolved,
    ...(inst.x !== undefined ? { x: inst.x } : {}),
    ...(inst.y !== undefined ? { y: inst.y } : {}),
    ...(inst.w !== undefined ? { w: inst.w } : {}),
    ...(inst.h !== undefined ? { h: inst.h } : {}),
  } as VNode;
}

export function vNodeBBox(n: VNode): { x: number; y: number; w: number; h: number } {
  if (n.type === 'vpath') {
    let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
    for (const [px, py] of n.points) {
      mx = Math.min(mx, px); my = Math.min(my, py);
      Mx = Math.max(Mx, px); My = Math.max(My, py);
    }
    return { x: n.x ?? mx, y: n.y ?? my, w: Mx - mx, h: My - my };
  }
  return { x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 320, h: n.h ?? 240 };
}
