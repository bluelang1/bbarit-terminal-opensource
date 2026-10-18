import React, { useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  MousePointer2, Pencil, Square, Circle, MoveUpRight, Type, StickyNote as StickyNoteIcon,
  Trash2, Copy, Undo2, Redo2, BringToFront, SendToBack, Blocks, HelpCircle,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from 'lucide-react';
import type { BbaritLook } from './bbaritLook';
import { pathD, penNodeBBox, type PenAnnotation, type PenNode, type PenNodePatch, type PenShapeNode } from './DesignPenDoc';

// Canvas drawing tools for BBARIT Design (pencil.dev-style): a floating tool
// palette with undo/redo, draggable/resizable annotation shapes (rect,
// ellipse, arrow, freehand path, text, image) rendered inside the pan/zoom
// layer, and a style bar that turns into an align bar for multi-selections.
// All nodes live in the session's design.pen.json so the agent sees the same
// canvas the user draws on.

export type PenTool = 'select' | 'draw' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'note';
export type PenAlign = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export const PEN_PALETTE = ['#111111', '#DE2A44', '#2B6EF2', '#16A34A', '#F59E0B', '#FFFFFF'];

const TOOLS: Array<{ key: PenTool; icon: typeof Square; title: string }> = [
  { key: 'select', icon: MousePointer2, title: 'Select · move (V) — ⇧click multi, ⇧drag marquee' },
  { key: 'draw', icon: Pencil, title: 'Pencil (D)' },
  { key: 'rect', icon: Square, title: 'Rectangle (R)' },
  { key: 'ellipse', icon: Circle, title: 'Ellipse (O)' },
  { key: 'arrow', icon: MoveUpRight, title: 'Arrow (A)' },
  { key: 'text', icon: Type, title: 'Text (T)' },
  { key: 'note', icon: StickyNoteIcon, title: 'Prompt note (N)' },
];

const HELP_ROWS: Array<[string, string]> = [
  ['Type a prompt', 'The AI designs — several options spread across the canvas'],
  ['Double-click a design', 'Edit it directly: drag elements, double-click text to rewrite'],
  ['Draw marks + Apply Marks', 'Arrows, boxes and notes become AI instructions'],
  ['Enhance · Remix · Auto Pilot', 'One click: polish, restyle, or explore-pick-polish'],
  ['V D R O A T N', 'Tools: select, pencil, rect, ellipse, arrow, text, note'],
  ['⇧click · ⇧drag', 'Multi-select · marquee select'],
  ['⌘Z · ⌘D · [ ] · ⌫', 'Undo · duplicate · z-order · delete'],
  ['Drag canvas · ⌘scroll', 'Pan · zoom · double-click empty area exits edit'],
];

export function PenToolbar({ tool, onTool, onUndo, onRedo, L }: {
  tool: PenTool; onTool: (t: PenTool) => void; onUndo: () => void; onRedo: () => void; L: BbaritLook;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const btn: React.CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center', cursor: 'pointer' };
  return (
    <div onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}
      style={{ position: 'absolute', top: 12, left: 12, zIndex: 20, display: 'flex', gap: 2, padding: 4,
        background: L.card, border: `1px solid ${L.border}`, borderRadius: 12, boxShadow: '0 2px 10px rgba(0,0,0,.12)' }}>
      {TOOLS.map(({ key, icon: Icon, title }) => (
        <button key={key} type="button" title={title} onClick={() => onTool(key)}
          style={{ ...btn, background: tool === key ? L.accent : 'transparent', color: tool === key ? '#fff' : L.soft }}>
          <Icon size={15} />
        </button>
      ))}
      <span style={{ width: 1, alignSelf: 'stretch', margin: '3px 2px', background: L.borderSoft }} />
      <button type="button" title="Undo (⌘Z)" onClick={onUndo} style={{ ...btn, background: 'transparent', color: L.soft }}>
        <Undo2 size={14} />
      </button>
      <button type="button" title="Redo (⇧⌘Z)" onClick={onRedo} style={{ ...btn, background: 'transparent', color: L.soft }}>
        <Redo2 size={14} />
      </button>
      <button type="button" title="How this canvas works" onClick={() => setHelpOpen((v) => !v)}
        style={{ ...btn, background: helpOpen ? L.bubble : 'transparent', color: helpOpen ? L.ink : L.soft }}>
        <HelpCircle size={14} />
      </button>
      {helpOpen && (
        <div style={{ position: 'absolute', top: '115%', left: 0, zIndex: 30, width: 320, padding: '10px 12px',
          background: L.card, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
          border: `1px solid ${L.border}`, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,.28)' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: L.ink, marginBottom: 8 }}>
            The AI designs — you direct it.
          </div>
          {HELP_ROWS.map(([k, v]) => (
            <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: L.accentDeep, flexShrink: 0, width: 118 }}>{k}</span>
              <span style={{ fontSize: 10.5, color: L.soft, lineHeight: 1.45 }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ALIGNS: Array<{ key: PenAlign; icon: typeof Square; title: string }> = [
  { key: 'left', icon: AlignStartVertical, title: 'Align left' },
  { key: 'hcenter', icon: AlignCenterVertical, title: 'Align horizontal centers' },
  { key: 'right', icon: AlignEndVertical, title: 'Align right' },
  { key: 'top', icon: AlignStartHorizontal, title: 'Align top' },
  { key: 'vcenter', icon: AlignCenterHorizontal, title: 'Align vertical centers' },
  { key: 'bottom', icon: AlignEndHorizontal, title: 'Align bottom' },
];

// Style bar for the selection: single node → color/fill/text controls;
// multiple nodes → align + duplicate + delete.
export function PenStyleBar({ nodes, L, onChange, onAlign, onOrder, onDuplicate, onComponentize, onDelete }: {
  nodes: PenNode[]; L: BbaritLook;
  onChange: (patch: PenNodePatch) => void;
  onAlign: (kind: PenAlign) => void;
  onOrder: (where: 'front' | 'back') => void;
  onDuplicate: () => void;
  onComponentize?: () => void;
  onDelete: () => void;
}) {
  const bar: React.CSSProperties = { position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
    background: L.card, border: `1px solid ${L.border}`, borderRadius: 999, boxShadow: '0 2px 10px rgba(0,0,0,.12)' };
  const iconBtn: React.CSSProperties = { width: 24, height: 24, borderRadius: 7, border: 0, display: 'flex',
    alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: 'transparent', color: L.soft };
  const stop = { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onWheel: (e: React.WheelEvent) => e.stopPropagation() };

  if (nodes.length === 0) return null;

  if (nodes.length > 1) {
    return (
      <div {...stop} style={bar}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: L.muted, padding: '0 2px' }}>{nodes.length} selected</span>
        {ALIGNS.map(({ key, icon: Icon, title }) => (
          <button key={key} type="button" title={title} onClick={() => onAlign(key)} style={iconBtn}>
            <Icon size={13} />
          </button>
        ))}
        <span style={{ width: 1, height: 16, background: L.borderSoft }} />
        <button type="button" title="Bring to front (])" onClick={() => onOrder('front')} style={iconBtn}><BringToFront size={13} /></button>
        <button type="button" title="Send to back ([)" onClick={() => onOrder('back')} style={iconBtn}><SendToBack size={13} /></button>
        <button type="button" title="Duplicate (⌘D)" onClick={onDuplicate} style={iconBtn}><Copy size={13} /></button>
        <button type="button" title="Delete (⌫)" onClick={onDelete} style={{ ...iconBtn, color: L.accentDeep }}><Trash2 size={13} /></button>
      </div>
    );
  }

  const node = nodes[0];
  if (node.type === 'frame' || node.type === 'note') return null;
  const hasStroke = node.type !== 'image';
  const color = node.type === 'text' ? node.color : node.type === 'image' ? '' : node.stroke;
  const swatch = (c: string) => (
    <button key={c} type="button" title={c}
      onClick={() => onChange(node.type === 'text' ? { color: c }
        : node.type === 'rect' || node.type === 'ellipse'
          ? { stroke: c, fill: (node as PenShapeNode).fill === 'transparent' ? 'transparent' : `${c}26` }
          : { stroke: c })}
      style={{ width: 18, height: 18, borderRadius: 999, cursor: 'pointer', background: c, padding: 0,
        border: c === '#FFFFFF' ? `1px solid ${L.border}` : '1px solid transparent',
        outline: color === c ? `2px solid ${L.accent}` : 'none', outlineOffset: 1 }} />
  );
  return (
    <div {...stop} style={bar}>
      {hasStroke && PEN_PALETTE.map(swatch)}
      {(node.type === 'rect' || node.type === 'ellipse') && (
        <button type="button" title="Toggle fill"
          onClick={() => onChange({ fill: node.fill === 'transparent' ? `${node.stroke}26` : 'transparent' })}
          style={{ border: `1px solid ${L.border}`, borderRadius: 999, background: node.fill === 'transparent' ? 'transparent' : L.bubble,
            color: L.soft, fontSize: 10.5, fontWeight: 600, padding: '3px 8px', cursor: 'pointer' }}>
          Fill
        </button>
      )}
      {node.type === 'text' && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button type="button" title="Smaller" onClick={() => onChange({ size: Math.max(12, node.size - 6) })}
            style={{ border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>A−</button>
          <button type="button" title="Larger" onClick={() => onChange({ size: Math.min(160, node.size + 6) })}
            style={{ border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>A+</button>
          <button type="button" title="Bold" onClick={() => onChange({ weight: node.weight >= 700 ? 400 : 700 })}
            style={{ width: 22, height: 22, borderRadius: 6, border: `1px solid ${L.border}`, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800,
              background: node.weight >= 700 ? L.bubble : 'transparent', color: node.weight >= 700 ? L.ink : L.muted }}>B</button>
        </span>
      )}
      <button type="button" title="Bring to front (])" onClick={() => onOrder('front')} style={iconBtn}><BringToFront size={13} /></button>
      <button type="button" title="Send to back ([)" onClick={() => onOrder('back')} style={iconBtn}><SendToBack size={13} /></button>
      <button type="button" title="Duplicate (⌘D)" onClick={onDuplicate} style={iconBtn}><Copy size={13} /></button>
      {node.type === 'rect' && onComponentize && (
        <button type="button" title="Componentize — extract the covered section as a reusable component"
          onClick={onComponentize} style={iconBtn}><Blocks size={13} /></button>
      )}
      <button type="button" title="Delete (⌫)" onClick={onDelete} style={{ ...iconBtn, color: L.accentDeep }}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function useDragXY(zoom: number, onMove: (dx: number, dy: number) => void) {
  const ref = useRef<{ sx: number; sy: number } | null>(null);
  return {
    down: (e: React.PointerEvent) => {
      e.stopPropagation();
      ref.current = { sx: e.clientX, sy: e.clientY };
      try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    },
    move: (e: React.PointerEvent) => {
      const d = ref.current;
      if (!d) return;
      onMove((e.clientX - d.sx) / zoom, (e.clientY - d.sy) / zoom);
    },
    up: () => { ref.current = null; },
  };
}

// One annotation on the canvas. Movable/selectable with the select tool;
// under a drawing tool pointer events pass through so drawing works on top.
// Body drags go through onDragStart/onMoveBy so the panel can move the whole
// multi-selection together; resize and endpoint drags stay single-node.
export function PenShapeView({ node, zoom, tool, selected, editing, assetBase, L, onDragStart, onMoveBy, onPatch, onEditText, onEditDone }: {
  node: PenAnnotation;
  zoom: number;
  tool: PenTool;
  selected: boolean;
  editing: boolean;
  assetBase: string;
  L: BbaritLook;
  onDragStart: (additive: boolean) => void;
  onMoveBy: (dx: number, dy: number) => void;
  onPatch: (patch: PenNodePatch) => void;
  onEditText: () => void;
  onEditDone: (text: string) => void;
}) {
  const start = useRef(node);
  const sw = Math.max(2.5, 3 / Math.max(zoom, 0.05));
  const selW = Math.max(1.5, 2 / Math.max(zoom, 0.05));
  const interactive = tool === 'select';

  const moveDrag = useDragXY(zoom, (dx, dy) => onMoveBy(dx, dy));
  const grabMove = (e: React.PointerEvent) => { onDragStart(e.shiftKey); moveDrag.down(e); };
  const resizeDrag = useDragXY(zoom, (dx, dy) => {
    const s = start.current;
    if (s.type === 'image') {
      // Images keep their aspect ratio while resizing.
      const w = Math.max(24, s.w + dx);
      onPatch({ w, h: Math.max(24, Math.round(w * (s.h / Math.max(s.w, 1)))) });
    } else if (s.type === 'rect' || s.type === 'ellipse') {
      onPatch({ w: Math.max(24, s.w + dx), h: Math.max(24, s.h + dy) });
    } else if (s.type === 'text') {
      onPatch({ w: Math.max(60, s.w + dx) });
    }
  });
  const grabResize = (e: React.PointerEvent) => { start.current = node; onDragStart(false); resizeDrag.down(e); };

  const handleStyle: React.CSSProperties = {
    position: 'absolute', width: 12 / zoom, height: 12 / zoom, borderRadius: 999,
    background: '#fff', border: `${selW}px solid #2B6EF2`, boxSizing: 'border-box', cursor: 'nwse-resize',
  };

  if (node.type === 'arrow') {
    const pad = 24;
    const minX = Math.min(node.x, node.x2) - pad;
    const minY = Math.min(node.y, node.y2) - pad;
    const w = Math.abs(node.x2 - node.x) + pad * 2;
    const h = Math.abs(node.y2 - node.y) + pad * 2;
    const p1 = { x: node.x - minX, y: node.y - minY };
    const p2 = { x: node.x2 - minX, y: node.y2 - minY };
    const dragEnd = (key: 'start' | 'end') => {
      const ref = { sx: 0, sy: 0, on: false };
      return {
        down: (e: React.PointerEvent) => { e.stopPropagation(); start.current = node; onDragStart(false);
          ref.sx = e.clientX; ref.sy = e.clientY; ref.on = true;
          try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ } },
        move: (e: React.PointerEvent) => {
          if (!ref.on || start.current.type !== 'arrow') return;
          const s = start.current;
          const dx = (e.clientX - ref.sx) / zoom;
          const dy = (e.clientY - ref.sy) / zoom;
          onPatch(key === 'start' ? { x: s.x + dx, y: s.y + dy } : { x2: s.x2 + dx, y2: s.y2 + dy });
        },
        up: () => { ref.on = false; },
      };
    };
    const dStart = dragEnd('start');
    const dEnd = dragEnd('end');
    return (
      <svg style={{ position: 'absolute', left: minX, top: minY, width: w, height: h, overflow: 'visible',
        pointerEvents: 'none', zIndex: 4 }}>
        <defs>
          <marker id={`ah-${node.id}`} markerWidth="10" markerHeight="10" refX="7.5" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,3 L0,6 Z" fill={node.stroke} />
          </marker>
        </defs>
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={Math.max(14, 16 / zoom)}
          style={{ pointerEvents: interactive ? 'stroke' : 'none', cursor: 'move' }}
          onPointerDown={grabMove} onPointerMove={moveDrag.move} onPointerUp={moveDrag.up} />
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={node.stroke} strokeWidth={sw}
          strokeLinecap="round" markerEnd={`url(#ah-${node.id})`} />
        {selected && interactive && ([[p1, dStart], [p2, dEnd]] as const).map(([p, d], i) => (
          <circle key={i} cx={p.x} cy={p.y} r={7 / zoom} fill="#fff" stroke="#2B6EF2" strokeWidth={selW}
            style={{ pointerEvents: 'all', cursor: 'crosshair' }}
            onPointerDown={d.down} onPointerMove={d.move} onPointerUp={d.up} />
        ))}
      </svg>
    );
  }

  if (node.type === 'path') {
    const b = penNodeBBox(node);
    const pad = 24;
    const rel = node.points.map(([px, py]) => [px - b.x + pad, py - b.y + pad]);
    return (
      <svg style={{ position: 'absolute', left: b.x - pad, top: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2,
        overflow: 'visible', pointerEvents: 'none', zIndex: 4 }}>
        <path d={pathD(rel)} fill="none" stroke="transparent" strokeWidth={Math.max(14, 16 / zoom)}
          style={{ pointerEvents: interactive ? 'stroke' : 'none', cursor: 'move' }}
          onPointerDown={grabMove} onPointerMove={moveDrag.move} onPointerUp={moveDrag.up} />
        <path d={pathD(rel)} fill="none" stroke={node.stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        {selected && (
          <rect x={pad / 2} y={pad / 2} width={b.w + pad} height={b.h + pad} fill="none"
            stroke="#2B6EF2" strokeWidth={selW} strokeDasharray={`${6 / zoom} ${5 / zoom}`} />
        )}
      </svg>
    );
  }

  if (node.type === 'image') {
    return (
      <div
        onPointerDown={(e) => { if (!interactive) return; grabMove(e); }}
        onPointerMove={moveDrag.move} onPointerUp={moveDrag.up}
        style={{ position: 'absolute', left: node.x, top: node.y, width: node.w, height: node.h, zIndex: 4,
          pointerEvents: interactive ? 'auto' : 'none', cursor: 'move',
          outline: selected ? `${selW}px solid #2B6EF2` : 'none', outlineOffset: 4 }}>
        <img src={convertFileSrc(`${assetBase}/${node.file}`)} alt={node.file} draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'fill', display: 'block', pointerEvents: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,.18)', borderRadius: 4 }} />
        {selected && (
          <div onPointerDown={grabResize} onPointerMove={resizeDrag.move} onPointerUp={resizeDrag.up}
            style={{ ...handleStyle, right: -7 / zoom, bottom: -7 / zoom }} />
        )}
      </div>
    );
  }

  if (node.type === 'text') {
    return (
      <div
        onPointerDown={(e) => { if (!interactive || editing) return; grabMove(e); }}
        onPointerMove={moveDrag.move} onPointerUp={moveDrag.up}
        onDoubleClick={(e) => { e.stopPropagation(); onEditText(); }}
        style={{ position: 'absolute', left: node.x, top: node.y, width: node.w, zIndex: 4,
          pointerEvents: interactive ? 'auto' : 'none', cursor: editing ? 'text' : 'move',
          outline: selected ? `${selW}px solid #2B6EF2` : 'none', outlineOffset: 4 }}>
        {editing ? (
          <textarea autoFocus defaultValue={node.text} rows={Math.max(1, node.text.split('\n').length)}
            onBlur={(e) => onEditDone(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: '100%', border: 0, outline: 'none', resize: 'none', background: 'transparent', padding: 0,
              fontSize: node.size, fontWeight: node.weight, lineHeight: 1.25, color: node.color, fontFamily: L.sans,
              wordBreak: 'keep-all', overflow: 'hidden', boxSizing: 'border-box' }} />
        ) : (
          <div style={{ fontSize: node.size, fontWeight: node.weight, lineHeight: 1.25, color: node.color, fontFamily: L.sans,
            whiteSpace: 'pre-wrap', wordBreak: 'keep-all', userSelect: 'none' }}>
            {node.text}
          </div>
        )}
        {selected && !editing && (
          <div onPointerDown={grabResize} onPointerMove={resizeDrag.move} onPointerUp={resizeDrag.up}
            style={{ ...handleStyle, right: -8 / zoom, bottom: -8 / zoom, cursor: 'ew-resize' }} />
        )}
      </div>
    );
  }

  // rect / ellipse
  return (
    <div
      onPointerDown={(e) => { if (!interactive) return; grabMove(e); }}
      onPointerMove={moveDrag.move} onPointerUp={moveDrag.up}
      style={{ position: 'absolute', left: node.x, top: node.y, width: node.w, height: node.h, zIndex: 4,
        pointerEvents: interactive ? 'auto' : 'none', cursor: 'move', boxSizing: 'border-box',
        border: `${sw}px solid ${node.stroke}`, background: node.fill,
        borderRadius: node.type === 'ellipse' ? '50%' : 10,
        outline: selected ? `${selW}px solid #2B6EF2` : 'none', outlineOffset: 4 }}>
      {selected && (
        <div onPointerDown={grabResize} onPointerMove={resizeDrag.move} onPointerUp={resizeDrag.up}
          style={{ ...handleStyle, right: -7 / zoom, bottom: -7 / zoom }} />
      )}
    </div>
  );
}

// Dashed preview of the shape being dragged out (also used for the marquee).
export function PenDraftView({ tool, x, y, x2, y2 }: { tool: PenTool | 'marquee'; x: number; y: number; x2: number; y2: number }) {
  if (tool === 'arrow') {
    const pad = 24;
    const minX = Math.min(x, x2) - pad;
    const minY = Math.min(y, y2) - pad;
    return (
      <svg style={{ position: 'absolute', left: minX, top: minY, width: Math.abs(x2 - x) + pad * 2, height: Math.abs(y2 - y) + pad * 2,
        overflow: 'visible', pointerEvents: 'none', zIndex: 6 }}>
        <line x1={x - minX} y1={y - minY} x2={x2 - minX} y2={y2 - minY} stroke="#2B6EF2" strokeWidth={3} strokeDasharray="8 6" strokeLinecap="round" />
      </svg>
    );
  }
  const left = Math.min(x, x2);
  const top = Math.min(y, y2);
  return (
    <div style={{ position: 'absolute', left, top, width: Math.abs(x2 - x), height: Math.abs(y2 - y), zIndex: 6,
      border: tool === 'marquee' ? '1.5px dashed #2B6EF2' : '3px dashed #2B6EF2',
      background: tool === 'marquee' ? '#2B6EF215' : 'transparent',
      borderRadius: tool === 'ellipse' ? '50%' : tool === 'marquee' ? 4 : 10, pointerEvents: 'none', boxSizing: 'border-box' }} />
  );
}

// Live preview of the freehand stroke while drawing.
export function PenDraftPath({ points }: { points: number[][] }) {
  if (points.length < 2) return null;
  let minX = Infinity, minY = Infinity;
  for (const [px, py] of points) { minX = Math.min(minX, px); minY = Math.min(minY, py); }
  const pad = 24;
  const rel = points.map(([px, py]) => [px - minX + pad, py - minY + pad]);
  return (
    <svg style={{ position: 'absolute', left: minX - pad, top: minY - pad, overflow: 'visible', pointerEvents: 'none', zIndex: 6 }}>
      <path d={pathD(rel)} fill="none" stroke="#DE2A44" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
