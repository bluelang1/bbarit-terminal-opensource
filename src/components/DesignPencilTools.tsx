import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Trash2, X, ChevronRight, ChevronDown, Loader2,
  AlignLeft, AlignCenter, AlignRight, Layers, RefreshCw,
} from 'lucide-react';
import type { BbaritLook } from './bbaritLook';

// Pencil-style canvas tooling for BBARIT Design: an element inspector with a
// DOM layers tree and live property editing, plus sticky-note prompt blocks
// that live on the variations canvas and run the design agent. Live edits are
// applied in the preview instantly and persisted through the agent (pencil.dev
// itself is one-way too: canvas edits are handed to the AI to land in code).

export interface InspectedElement {
  selector: string;
  tag: string;
  text: string;
  direct: boolean;
  styles: Record<string, string | number>;
}

export interface DomTreeNode {
  tag: string;
  sel: string;
  id: string;
  cls: string;
  text: string;
  kids: DomTreeNode[];
}

export interface PendingEdit {
  id: string;
  selector: string;
  tag: string;
  kind: 'style' | 'text' | 'move';
  prop?: string;
  value: string;
}

export interface StickyNoteItem {
  id: string;
  x: number;
  y: number;
  text: string;
}

export const CSS_TO_KEY: Record<string, string> = {
  color: 'color',
  'background-color': 'background',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'text-align': 'textAlign',
  padding: 'padding',
  margin: 'margin',
  'border-radius': 'borderRadius',
  'line-height': 'lineHeight',
};

export function loadNotes(sessionId: string): StickyNoteItem[] {
  try {
    const raw = localStorage.getItem(`bbarit-design-notes:${sessionId}`);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is StickyNoteItem =>
      typeof n?.id === 'string' && typeof n?.x === 'number' && typeof n?.y === 'number' && typeof n?.text === 'string');
  } catch { return []; }
}

export function saveNotes(sessionId: string, notes: StickyNoteItem[]) {
  try { localStorage.setItem(`bbarit-design-notes:${sessionId}`, JSON.stringify(notes.slice(0, 40))); } catch { /* quota */ }
}

export function rgbToHex(v: string): string {
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v || '');
  if (!m) return /^#/.test(v || '') ? v : '#000000';
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

// Injected into the single-file preview. Extends the original comment-pin
// script with: inspect mode (click → selector + computed styles), select /
// set-style / set-text messages for live edits, and a get-tree DOM snapshot
// for the layers panel. Selectors are full structural paths from <body> so
// querySelector resolves them back to the exact element.
export const CANVAS_SCRIPT = `<script>(function(){
  var enabled=false,n=0,inspectOn=false,selEl=null,selPrev='';
  function sel(el){
    var parts=[],cur=el;
    while(cur&&cur.nodeType===1&&cur.tagName!=='BODY'&&cur.tagName!=='HTML'){
      var t=cur.tagName.toLowerCase();
      var p=cur.parentNode,i=1;
      if(p){var sibs=Array.prototype.filter.call(p.children,function(c){return c.tagName===cur.tagName;});if(sibs.length>1)i=sibs.indexOf(cur)+1;}
      parts.unshift(t+(i>1?(':nth-of-type('+i+')'):''));
      cur=p;
    }
    return parts.join(' > ')||el.tagName.toLowerCase();
  }
  function textOf(el){return (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();}
  function styleOf(el){
    var cs=getComputedStyle(el);var r=el.getBoundingClientRect();
    return {color:cs.color,background:cs.backgroundColor,fontSize:cs.fontSize,fontWeight:cs.fontWeight,
      fontFamily:(cs.fontFamily||'').split(',')[0].replace(/["']/g,''),textAlign:cs.textAlign,lineHeight:cs.lineHeight,
      padding:cs.padding,margin:cs.margin,borderRadius:cs.borderRadius,display:cs.display,
      w:Math.round(r.width),h:Math.round(r.height)};
  }
  function report(el){
    parent.postMessage({__cd:'inspected',selector:sel(el),tag:el.tagName.toLowerCase(),
      text:textOf(el).slice(0,160),direct:el.children.length===0,styles:styleOf(el)},'*');
  }
  function pick(el){
    if(selEl){selEl.style.outline=selPrev;}
    selEl=el;selPrev=el.style.outline||'';
    el.style.outline='2px solid #2B6EF2';el.style.outlineOffset='1px';
  }
  function tree(el,depth){
    if(!el||el.nodeType!==1)return null;
    var tag=el.tagName.toLowerCase();
    if(tag==='script'||tag==='style'||el.hasAttribute('data-cd-badge'))return null;
    var kids=[];
    if(depth<8){for(var i=0;i<el.children.length&&kids.length<30;i++){var k=tree(el.children[i],depth+1);if(k)kids.push(k);}}
    return {tag:tag,sel:sel(el),id:el.id||'',
      cls:(typeof el.className==='string'&&el.className?el.className.trim().split(/\\s+/)[0]:''),
      text:kids.length===0?textOf(el).slice(0,26):'',kids:kids};
  }
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.__cd==='enable'){enabled=!!d.on;document.body.style.cursor=enabled?'crosshair':'';}
    if(d.__cd==='inspect-enable'){
      inspectOn=!!d.on;
      if(!inspectOn&&selEl){selEl.style.outline=selPrev;selEl=null;}
    }
    if(d.__cd==='get-tree'){parent.postMessage({__cd:'tree',root:tree(document.body,0)},'*');}
    if(d.__cd==='select'){
      try{var s=document.querySelector(d.selector);if(s){pick(s);report(s);s.scrollIntoView({block:'center'});}}catch(x){}
    }
    if(d.__cd==='set-style'){
      try{var s2=document.querySelector(d.selector);if(s2){s2.style.setProperty(d.prop,d.value);}}catch(x){}
    }
    if(d.__cd==='set-text'){
      try{var s3=document.querySelector(d.selector);if(s3){s3.textContent=d.text;}}catch(x){}
    }
    if(d.__cd==='clear'){
      Array.prototype.forEach.call(document.querySelectorAll('[data-cd-badge]'),function(b){b.remove();});
      Array.prototype.forEach.call(document.querySelectorAll('[data-cd-comment]'),function(x){x.removeAttribute('data-cd-comment');x.style.outline='';});
      n=0;
    }
  });
  // Direct manipulation (pencil-style): drag the selected element to move it
  // (live transform preview; the agent lands it in real layout code), and
  // double-click a leaf element to edit its text inline.
  var dragEl=null,dragSX=0,dragSY=0,baseTX=0,baseTY=0,dragMoved=false,swallowClick=false;
  document.addEventListener('pointerdown',function(e){
    if(!inspectOn||!selEl)return;
    if(e.target!==selEl&&!selEl.contains(e.target))return;
    if(selEl.getAttribute('contenteditable')==='true')return;
    dragEl=selEl;dragSX=e.clientX;dragSY=e.clientY;dragMoved=false;
    var m=/translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(dragEl.style.transform||'');
    baseTX=m?parseFloat(m[1]):0;baseTY=m?parseFloat(m[2]):0;
  },true);
  document.addEventListener('pointermove',function(e){
    if(!dragEl)return;
    var dx=e.clientX-dragSX,dy=e.clientY-dragSY;
    if(!dragMoved&&Math.abs(dx)+Math.abs(dy)<4)return;
    dragMoved=true;
    dragEl.style.transform='translate('+(baseTX+dx)+'px,'+(baseTY+dy)+'px)';
  },true);
  document.addEventListener('pointerup',function(e){
    if(!dragEl)return;
    if(dragMoved){
      swallowClick=true;
      parent.postMessage({__cd:'moved',selector:sel(dragEl),tag:dragEl.tagName.toLowerCase(),
        dx:Math.round(baseTX+(e.clientX-dragSX)),dy:Math.round(baseTY+(e.clientY-dragSY))},'*');
    }
    dragEl=null;
  },true);
  document.addEventListener('dblclick',function(e){
    if(!inspectOn)return;
    var t=e.target;
    if(!t||t.nodeType!==1||t.children.length>0||t===document.body)return;
    e.preventDefault();e.stopPropagation();
    pick(t);
    t.setAttribute('contenteditable','true');
    t.focus();
    var done=function(){
      t.removeAttribute('contenteditable');
      t.removeEventListener('blur',done);
      parent.postMessage({__cd:'text-inline',selector:sel(t),tag:t.tagName.toLowerCase(),
        text:(t.innerText||'').replace(/\\s+/g,' ').trim()},'*');
    };
    t.addEventListener('blur',done);
  },true);
  document.addEventListener('click',function(e){
    if(swallowClick){swallowClick=false;e.preventDefault();e.stopPropagation();return;}
    if(inspectOn){
      if(e.target&&e.target.getAttribute&&e.target.getAttribute('contenteditable')==='true')return;
      e.preventDefault();e.stopPropagation();
      var t=e.target;if(!t||t===document.documentElement||t===document.body)return;
      pick(t);report(t);
      return;
    }
    if(!enabled)return;
    e.preventDefault();e.stopPropagation();
    var el=e.target;if(!el||el===document.documentElement||el===document.body)return;
    n++;
    el.setAttribute('data-cd-comment',n);
    el.style.outline='2px solid #DE2A44';
    var r=el.getBoundingClientRect();
    var b=document.createElement('div');
    b.setAttribute('data-cd-badge',n);b.textContent=n;
    b.style.cssText='position:absolute;z-index:2147483647;background:#DE2A44;color:#fff;font:700 11px/18px sans-serif;min-width:18px;height:18px;text-align:center;border-radius:9px;padding:0 3px;transform:translate(-4px,-4px);pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.35)';
    b.style.left=(r.left+window.scrollX)+'px';b.style.top=(r.top+window.scrollY)+'px';
    document.body.appendChild(b);
    var txt=textOf(el).slice(0,60);
    parent.postMessage({__cd:'picked',n:n,selector:sel(el),tag:el.tagName.toLowerCase(),text:txt},'*');
  },true);
}());</script>`;

// ── Layers tree (pencil.dev left panel) ──

function TreeRow({ node, depth, selected, onSelect, L }: {
  node: DomTreeNode; depth: number; selected: string | null;
  onSelect: (sel: string) => void; L: BbaritLook;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isSel = selected === node.sel;
  const label = node.id ? `#${node.id}` : node.cls ? `.${node.cls}` : node.text ? `“${node.text}”` : '';
  return (
    <div>
      <div
        onClick={() => onSelect(node.sel)}
        style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 6px', paddingLeft: 6 + depth * 12,
          borderRadius: 6, cursor: 'pointer', fontSize: 11,
          background: isSel ? L.bubble : 'transparent', color: isSel ? L.ink : L.soft }}>
        {node.kids.length > 0 ? (
          <span onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            style={{ display: 'flex', color: L.faint, cursor: 'pointer', flexShrink: 0 }}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        ) : <span style={{ width: 11, flexShrink: 0 }} />}
        <span style={{ fontWeight: 600, flexShrink: 0 }}>{node.tag}</span>
        {label && (
          <span style={{ color: L.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5 }}>
            {label}
          </span>
        )}
      </div>
      {open && node.kids.map((k, i) => (
        <TreeRow key={`${k.sel}-${i}`} node={k} depth={depth + 1} selected={selected} onSelect={onSelect} L={L} />
      ))}
    </div>
  );
}

// ── Inspector side panel: layers tree + selected element properties ──

export function InspectorPanel({ L, tree, selected, busy, pendingEdits, onSelect, onEdit, onRefreshTree, onApply, onDiscard, onClose }: {
  L: BbaritLook;
  tree: DomTreeNode | null;
  selected: InspectedElement | null;
  busy: boolean;
  pendingEdits: PendingEdit[];
  onSelect: (sel: string) => void;
  onEdit: (kind: 'style' | 'text', prop: string | undefined, value: string) => void;
  onRefreshTree: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const s = selected?.styles || {};
  const editCount = pendingEdits.length;
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 };
  const lab: React.CSSProperties = { fontSize: 10, color: L.muted, width: 52, flexShrink: 0 };
  const inp: React.CSSProperties = { flex: 1, minWidth: 0, background: L.bg, color: L.ink, border: `1px solid ${L.border}`,
    borderRadius: 6, padding: '4px 7px', fontSize: 11, outline: 'none', boxSizing: 'border-box' };
  return (
    <div style={{ width: 268, flexShrink: 0, borderLeft: `1px solid ${L.border}`, background: L.bg,
      display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${L.borderSoft}`, display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 700, color: L.soft }}>
        <Layers size={13} color={L.accent} /> Inspector
        <button type="button" title="Refresh layers" onClick={onRefreshTree}
          style={{ marginLeft: 'auto', background: 'transparent', border: 0, cursor: 'pointer', color: L.faint, display: 'flex' }}>
          <RefreshCw size={12} />
        </button>
        <button type="button" title="Close" onClick={onClose}
          style={{ background: 'transparent', border: 0, cursor: 'pointer', color: L.faint, display: 'flex' }}>
          <X size={13} />
        </button>
      </div>

      {/* Layers */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 60 }}>
        {tree ? <TreeRow node={tree} depth={0} selected={selected?.selector ?? null} onSelect={onSelect} L={L} />
          : <div style={{ fontSize: 11, color: L.muted, padding: 6 }}>Click any element in the preview, or refresh.</div>}
      </div>

      {/* Properties */}
      {selected && (
        <div style={{ borderTop: `1px solid ${L.borderSoft}`, padding: 12, maxHeight: '52%', overflowY: 'auto' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: L.ink, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            {'<'}{selected.tag}{'>'}
            <span style={{ fontSize: 9.5, color: L.faint, fontWeight: 500 }}>{s.w}×{s.h}</span>
          </div>
          {selected.direct && (
            <div style={row}>
              <span style={lab}>Text</span>
              <input type="text" defaultValue={selected.text} key={`${selected.selector}-t`}
                onBlur={(e) => { if (e.target.value !== selected.text) onEdit('text', undefined, e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={inp} />
            </div>
          )}
          <div style={row}>
            <span style={lab}>Color</span>
            <input type="color" value={rgbToHex(String(s.color || ''))}
              onChange={(e) => onEdit('style', 'color', e.target.value)}
              style={{ width: 30, height: 24, border: `1px solid ${L.border}`, borderRadius: 6, padding: 1, background: L.bg, cursor: 'pointer' }} />
            <input type="color" title="Background" value={rgbToHex(String(s.background || ''))}
              onChange={(e) => onEdit('style', 'background-color', e.target.value)}
              style={{ width: 30, height: 24, border: `1px solid ${L.border}`, borderRadius: 6, padding: 1, background: L.bg, cursor: 'pointer' }} />
            <span style={{ fontSize: 9.5, color: L.faint }}>text · bg</span>
          </div>
          <div style={row}>
            <span style={lab}>Font</span>
            <input type="text" defaultValue={String(s.fontSize || '')} key={`${selected.selector}-fs`}
              onBlur={(e) => onEdit('style', 'font-size', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={{ ...inp, flex: '0 0 58px' }} />
            <select value={String(s.fontWeight || '400')} onChange={(e) => onEdit('style', 'font-weight', e.target.value)}
              style={{ ...inp, flex: 1 }}>
              {['300', '400', '500', '600', '700', '800', '900'].map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>
          <div style={row}>
            <span style={lab}>Align</span>
            {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([v, Icon]) => (
              <button key={v} type="button" onClick={() => onEdit('style', 'text-align', v)}
                style={{ width: 26, height: 24, borderRadius: 6, border: `1px solid ${L.border}`, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: s.textAlign === v ? L.bubble : 'transparent', color: s.textAlign === v ? L.ink : L.muted }}>
                <Icon size={12} />
              </button>
            ))}
          </div>
          <div style={row}>
            <span style={lab}>Padding</span>
            <input type="text" defaultValue={String(s.padding || '')} key={`${selected.selector}-p`}
              onBlur={(e) => onEdit('style', 'padding', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={inp} />
          </div>
          <div style={row}>
            <span style={lab}>Radius</span>
            <input type="text" defaultValue={String(s.borderRadius || '')} key={`${selected.selector}-r`}
              onBlur={(e) => onEdit('style', 'border-radius', e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              style={inp} />
          </div>
        </div>
      )}

      {/* Pending edits → hand to the agent to land in the file */}
      <div style={{ borderTop: `1px solid ${L.borderSoft}`, padding: 10 }}>
        <div style={{ fontSize: 10, color: editCount > 0 ? L.soft : L.faint, marginBottom: editCount > 0 ? 8 : 0, lineHeight: 1.5 }}>
          {editCount > 0
            ? `${editCount} live edit${editCount > 1 ? 's' : ''} in preview — apply to save into the file.`
            : 'Live edits preview instantly; Apply lands them in code.'}
        </div>
        {editCount > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={onApply} disabled={busy}
              style={{ flex: 1, padding: 8, borderRadius: 8, border: 0, cursor: busy ? 'not-allowed' : 'pointer',
                background: busy ? L.borderSoft : L.accent, color: busy ? L.faint : '#fff', fontSize: 11.5, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              {busy ? <Loader2 size={12} className="spin" /> : null} Apply {editCount} edit{editCount > 1 ? 's' : ''}
            </button>
            <button type="button" onClick={onDiscard} disabled={busy} title="Discard live edits"
              style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${L.border}`, cursor: 'pointer',
                background: 'transparent', color: L.muted, fontSize: 11.5, fontWeight: 600 }}>
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sticky-note prompt blocks (pencil.dev "prompt blocks" on the canvas) ──
// A note is a draggable card on the variations canvas; ▶ runs its prompt
// through the design agent, so prompts become reusable design artifacts.

export function StickyNote({ note, zoom, busy, L, onChange, onRun, onDelete, onMove }: {
  note: StickyNoteItem;
  zoom: number;
  busy: boolean;
  L: BbaritLook;
  onChange: (text: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const canRun = !busy && note.text.trim().length > 0;
  return (
    <div
      style={{ position: 'absolute', left: note.x, top: note.y, width: 300, zIndex: 5,
        background: '#FEF3C7', border: '1px solid #F59E0B55', borderRadius: 10,
        boxShadow: dragging ? '0 8px 24px rgba(0,0,0,.25)' : '0 3px 12px rgba(0,0,0,.14)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}>
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: note.x, oy: note.y };
          setDragging(true);
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          onMove(d.ox + (e.clientX - d.sx) / zoom, d.oy + (e.clientY - d.sy) / zoom);
        }}
        onPointerUp={() => { dragRef.current = null; setDragging(false); }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
          cursor: dragging ? 'grabbing' : 'grab', background: '#FDE68A', userSelect: 'none' }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: '#92400E', flex: 1 }}>Prompt</span>
        <button type="button" title="Run this prompt" disabled={!canRun}
          onClick={onRun}
          style={{ width: 22, height: 22, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: canRun ? 'pointer' : 'not-allowed',
            background: canRun ? L.accent : '#F59E0B33', color: canRun ? '#fff' : '#92400E' }}>
          {busy ? <Loader2 size={11} className="spin" /> : <Play size={11} />}
        </button>
        <button type="button" title="Delete note" onClick={onDelete}
          style={{ width: 22, height: 22, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', background: 'transparent', color: '#92400E' }}>
          <Trash2 size={11} />
        </button>
      </div>
      <textarea
        value={note.text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write a design prompt… ▶ runs it on this canvas"
        rows={4}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) { e.preventDefault(); onRun(); }
        }}
        style={{ border: 0, outline: 'none', resize: 'vertical', background: 'transparent', padding: '8px 10px',
          fontSize: 12, lineHeight: 1.5, color: '#78350F', fontFamily: 'inherit', minHeight: 64 }} />
    </div>
  );
}

// Debounced note persistence hook: keeps sticky notes per design session.
export function useStickyNotes(sessionId: string | null) {
  const [notes, setNotes] = useState<StickyNoteItem[]>([]);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) { setNotes([]); loadedFor.current = null; return; }
    setNotes(loadNotes(sessionId));
    loadedFor.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || loadedFor.current !== sessionId) return;
    const t = setTimeout(() => saveNotes(sessionId, notes), 350);
    return () => clearTimeout(t);
  }, [sessionId, notes]);

  return useMemo(() => ({ notes, setNotes }), [notes]);
}
