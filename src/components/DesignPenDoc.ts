import { parseVScene, type VScene } from './vector/VectorDoc';

// The .pen design document (pencil.dev-style): an open JSON file that lives in
// the session folder next to the design HTML, so canvas state (frame layout,
// shapes, freehand strokes, images, text, sticky notes) is versionable and the
// design agent can read and write it directly — the app watches the file and
// reflects edits on canvas.

export const PEN_DOC_NAME = 'design.pen.json';
export const FRAME_W = 1280;
export const FRAME_H = 800;
export const FRAME_GAP = 90;

export interface PenFrameNode { id: string; type: 'frame'; file: string; x: number; y: number }
export interface PenShapeNode { id: string; type: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; stroke: string; fill: string }
export interface PenArrowNode { id: string; type: 'arrow'; x: number; y: number; x2: number; y2: number; stroke: string }
export interface PenTextNode { id: string; type: 'text'; x: number; y: number; w: number; text: string; color: string; size: number; weight: number }
export interface PenPathNode { id: string; type: 'path'; points: number[][]; stroke: string }
export interface PenImageNode { id: string; type: 'image'; file: string; x: number; y: number; w: number; h: number }
export interface PenNoteNode { id: string; type: 'note'; x: number; y: number; text: string }
export type PenNode = PenFrameNode | PenShapeNode | PenArrowNode | PenTextNode | PenPathNode | PenImageNode | PenNoteNode;

// Everything drawable/selectable on the canvas besides frames and notes.
export type PenAnnotation = PenShapeNode | PenArrowNode | PenTextNode | PenPathNode | PenImageNode;

export interface PenDocMeta { designSystem?: string }
export interface PenDoc { version: 1 | 2; meta?: PenDocMeta; nodes: PenNode[]; scene?: VScene }

// Flat geometry/style patch — the discriminants ('id'/'type') stay fixed, so a
// plain intersection of the node types would collapse to never.
export type PenNodePatch = Partial<{
  x: number; y: number; w: number; h: number; x2: number; y2: number;
  stroke: string; fill: string; text: string; color: string; size: number; weight: number;
  points: number[][];
}>;

export function penDocPath(sessionDir: string): string {
  return `${sessionDir.replace(/\/$/, '')}/${PEN_DOC_NAME}`;
}

export function emptyPenDoc(): PenDoc {
  return { version: 1, nodes: [] };
}

let idSeq = 0;
export function penId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq.toString(36)}`;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

function parsePoints(v: unknown): number[][] {
  if (!Array.isArray(v)) return [];
  const pts: number[][] = [];
  for (const p of v.slice(0, 2000)) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
      && Number.isFinite(p[0]) && Number.isFinite(p[1])) pts.push([p[0], p[1]]);
  }
  return pts;
}

// Lenient by design: the agent hand-writes nodes into this file, so missing
// style fields get defaults instead of dropping the node.
export function parsePenDoc(raw: string): PenDoc {
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const nodes: PenNode[] = [];
    for (const n of list) {
      if (!n || typeof n !== 'object') continue;
      const id = str(n.id) || penId('n');
      switch (n.type) {
        case 'frame':
          if (str(n.file)) nodes.push({ id, type: 'frame', file: str(n.file), x: num(n.x), y: num(n.y) });
          break;
        case 'rect':
        case 'ellipse':
          nodes.push({ id, type: n.type, x: num(n.x), y: num(n.y), w: Math.max(24, num(n.w, 240)), h: Math.max(24, num(n.h, 160)),
            stroke: str(n.stroke, '#DE2A44'), fill: str(n.fill, 'transparent') });
          break;
        case 'arrow':
          nodes.push({ id, type: 'arrow', x: num(n.x), y: num(n.y), x2: num(n.x2, num(n.x) + 200), y2: num(n.y2, num(n.y)), stroke: str(n.stroke, '#DE2A44') });
          break;
        case 'text':
          nodes.push({ id, type: 'text', x: num(n.x), y: num(n.y), w: Math.max(60, num(n.w, 360)),
            text: str(n.text, 'Text'), color: str(n.color, '#111111'), size: Math.max(10, num(n.size, 36)),
            weight: num(n.weight, 700) });
          break;
        case 'path': {
          const points = parsePoints(n.points);
          if (points.length >= 2) nodes.push({ id, type: 'path', points, stroke: str(n.stroke, '#DE2A44') });
          break;
        }
        case 'image':
          if (str(n.file)) nodes.push({ id, type: 'image', file: str(n.file), x: num(n.x), y: num(n.y),
            w: Math.max(24, num(n.w, 480)), h: Math.max(24, num(n.h, 360)) });
          break;
        case 'note':
          nodes.push({ id, type: 'note', x: num(n.x), y: num(n.y), text: str(n.text) });
          break;
      }
    }
    const designSystem = str(parsed?.meta?.designSystem).trim();
    const scene = parseVScene(parsed?.scene);
    return {
      version: scene ? 2 : 1,
      ...(designSystem ? { meta: { designSystem } } : {}),
      nodes: nodes.slice(0, 400),
      ...(scene ? { scene } : {}),
    };
  } catch {
    return emptyPenDoc();
  }
}

export function serializePenDoc(doc: PenDoc): string {
  const meta = doc.meta?.designSystem?.trim() ? { meta: { designSystem: doc.meta.designSystem.trim() } } : {};
  const scene = doc.scene ? { scene: doc.scene } : {};
  return JSON.stringify({ version: doc.scene ? 2 : 1, ...meta, nodes: doc.nodes, ...scene }, null, 2) + '\n';
}

// Keep one frame node per session file: drop frames whose file vanished, lay
// new files out to the right of the current content. Returns the same object
// when nothing changed so callers can use identity to skip re-saves.
export function syncFrames(doc: PenDoc, fileNames: string[]): PenDoc {
  const known = new Set(fileNames);
  let nodes = doc.nodes.filter((n) => n.type !== 'frame' || known.has(n.file));
  let changed = nodes.length !== doc.nodes.length;
  const have = new Set(nodes.filter((n): n is PenFrameNode => n.type === 'frame').map((n) => n.file));
  let nextX = nodes.reduce((m, n) => (n.type === 'frame' ? Math.max(m, n.x + FRAME_W + FRAME_GAP) : m), 0);
  for (const name of fileNames) {
    if (have.has(name)) continue;
    nodes = [...nodes, { id: penId('f'), type: 'frame', file: name, x: nextX, y: 0 }];
    nextX += FRAME_W + FRAME_GAP;
    changed = true;
  }
  return changed ? { ...doc, nodes } : doc;
}

export function frameOf(doc: PenDoc | null, fileName: string, fallbackIndex: number): { x: number; y: number } {
  const f = doc?.nodes.find((n): n is PenFrameNode => n.type === 'frame' && n.file === fileName);
  return f ? { x: f.x, y: f.y } : { x: fallbackIndex * (FRAME_W + FRAME_GAP), y: 0 };
}

export function penNodeBBox(n: PenNode): { x: number; y: number; w: number; h: number } {
  switch (n.type) {
    case 'frame': return { x: n.x, y: n.y, w: FRAME_W, h: FRAME_H };
    case 'rect':
    case 'ellipse':
    case 'image': return { x: n.x, y: n.y, w: n.w, h: n.h };
    case 'arrow': return { x: Math.min(n.x, n.x2), y: Math.min(n.y, n.y2), w: Math.abs(n.x2 - n.x), h: Math.abs(n.y2 - n.y) };
    case 'text': return { x: n.x, y: n.y, w: n.w, h: n.size * 1.5 };
    case 'note': return { x: n.x, y: n.y, w: 300, h: 140 };
    case 'path': {
      let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
      for (const [px, py] of n.points) {
        mx = Math.min(mx, px); my = Math.min(my, py);
        Mx = Math.max(Mx, px); My = Math.max(My, py);
      }
      return { x: mx, y: my, w: Mx - mx, h: My - my };
    }
  }
}

export function translatePenNode<T extends PenNode>(n: T, dx: number, dy: number): T {
  if (n.type === 'arrow') return { ...n, x: n.x + dx, y: n.y + dy, x2: n.x2 + dx, y2: n.y2 + dy };
  if (n.type === 'path') return { ...n, points: n.points.map(([a, b]) => [a + dx, b + dy]) };
  return { ...n, x: n.x + dx, y: n.y + dy };
}

// Catmull-Rom → cubic bezier path string for smooth freehand strokes.
export function pathD(pts: number[][]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}
