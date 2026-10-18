/**
 * SlideElements.tsx — Element rendering for all shape types
 */

import React from 'react';
import type { SlideElement, PreservedPart } from './types';
import { SHAPE_CLIPS } from './types';
import { RESIZE_DIRS, type ResizeDir } from './pptxEditorGeometry';

// ─── Common style computation ─────────────────────────────────

function computeCommonStyle(
  el: SlideElement,
  isPresentation: boolean,
  fontScale = 1,
  pxPerPt?: number,
): React.CSSProperties {
  // Tables get a readable default — without one the cells inherit the app's
  // small UI font and end up ~8px on the canvas.
  const effectiveFontSize = el.fontSize ?? (el.type === 'table' ? 16 : undefined);
  const s: React.CSSProperties = {
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    height: `${el.h}%`,
    // pxPerPt = true slide geometry (canvas px ÷ slide pt): text wraps where
    // PowerPoint wraps it. Legacy callers keep the tuned approximation.
    fontSize: effectiveFontSize
      ? `${pxPerPt != null
        ? effectiveFontSize * pxPerPt
        : effectiveFontSize * (isPresentation ? 1.5 : 0.8) * fontScale}px`
      : undefined,
    color: el.fontColor || '#000000',
    fontWeight: el.bold ? 'bold' : undefined,
    fontStyle: el.italic ? 'italic' : undefined,
    textDecoration: [
      el.underline ? 'underline' : '',
      el.strikethrough ? 'line-through' : '',
    ].filter(Boolean).join(' ') || undefined,
    textAlign: el.textAlign || undefined,
    fontFamily: el.fontFamily || undefined,
  };
  if (el.rotation) {
    s.transform = `rotate(${el.rotation}deg)`;
  }
  if (el.opacity != null && el.opacity < 1) {
    s.opacity = el.opacity;
  }
  if (el.borderWidth && el.type !== 'line') {
    s.border = `${el.borderWidth}px solid ${el.borderColor || '#000000'}`;
  }
  if (el.shadow) {
    s.boxShadow = '2px 2px 6px rgba(0,0,0,0.35)';
  }
  return s;
}

// ─── Selection + Resize helpers ───────────────────────────────

function SelectionOutline({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return (
    <>
      {children}
      {selected && (
        <div style={{
          position: 'absolute', inset: -1,
          outline: '2px solid var(--px-accent, rgba(100,180,255,0.7))',
          borderRadius: 2,
          pointerEvents: 'none',
        }} />
      )}
    </>
  );
}

interface RenderOptions {
  isPresentation: boolean;
  /** Canvas width ÷ reference width — fonts must shrink with the canvas or
      text overlaps when the editor pane is short. Defaults to 1. */
  fontScale?: number;
  /** CSS px per PowerPoint point (canvas width ÷ slide width in pt). Set for
      decks parsed from real PPTX files so fonts/insets match MS geometry. */
  pxPerPt?: number;
  presentationEditable?: boolean;
  selectedElementId: string | null;
  selectedIds?: string[];
  editingTextId: string | null;
  onMouseDown: (e: React.MouseEvent, elId: string) => void;
  onResizeMouseDown: (e: React.MouseEvent, elId: string, dir: ResizeDir) => void;
  onRotateMouseDown?: (e: React.MouseEvent, elId: string) => void;
  onDoubleClick: (elId: string) => void;
  onTextChange: (elId: string, text: string) => void;
  onTextBlur: (elId: string, text: string) => void;
  editingTableCell?: { elId: string; row: number; col: number } | null;
  onTableCellDoubleClick?: (elId: string, row: number, col: number) => void;
  onTableCellChange?: (elId: string, row: number, col: number, value: string) => void;
  onTableCellBlur?: () => void;
}

// ─── Main render function ─────────────────────────────────────

/**
 * Text body honoring listStyle: each line becomes a bullet / numbered row
 * (PowerPoint paragraph lists). Plain text renders unchanged.
 */
/** bodyPr anchor → flex alignment (shapes default to middle, like PowerPoint) */
function anchorAlignItems(v?: 'top' | 'middle' | 'bottom'): React.CSSProperties['alignItems'] {
  return v === 'top' ? 'flex-start' : v === 'bottom' ? 'flex-end' : 'center';
}

function renderTextContent(el: SlideElement): React.ReactNode {
  const text = el.text || '';
  if (el.listStyle !== 'bullet' && el.listStyle !== 'number') return text;
  const lines = text.split('\n');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18em' }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: 'flex', gap: '0.45em' }}>
          <span style={{ flexShrink: 0, minWidth: el.listStyle === 'number' ? '1.3em' : undefined, textAlign: 'right' }}>
            {el.listStyle === 'bullet' ? '•' : `${i + 1}.`}
          </span>
          <span style={{ whiteSpace: 'pre-wrap' }}>{line}</span>
        </div>
      ))}
    </div>
  );
}

export function renderSlideElement(el: SlideElement, opts: RenderOptions): React.ReactNode {
  const {
    isPresentation, presentationEditable, selectedElementId, selectedIds, editingTextId,
    onMouseDown, onResizeMouseDown, onRotateMouseDown, onDoubleClick,
    onTextChange, onTextBlur,
    editingTableCell, onTableCellDoubleClick, onTableCellChange, onTableCellBlur,
  } = opts;

  const isEditable = !isPresentation || !!presentationEditable;
  // Selection outline shows on every element in a multi-selection; resize/rotate
  // handles only when a single element is the active target.
  const inSelection = isEditable && (selectedIds ? selectedIds.includes(el.id) : selectedElementId === el.id);
  const selected = inSelection;
  const showHandles = isEditable && selectedElementId === el.id && (!selectedIds || selectedIds.length <= 1);
  const baseStyle = computeCommonStyle(el, isPresentation, opts.fontScale ?? 1, opts.pxPerPt);
  // Text-box padding from the file's bodyPr insets (scaled to canvas px);
  // in-app decks without insetPt keep the old 2px look.
  const insetScale = opts.pxPerPt ?? ((isPresentation ? 1.5 : 0.8) * (opts.fontScale ?? 1));
  const insetPadding = el.insetPt
    ? `${el.insetPt.t * insetScale}px ${el.insetPt.r * insetScale}px ${el.insetPt.b * insetScale}px ${el.insetPt.l * insetScale}px`
    : undefined;

  const resizeHandle = showHandles ? (
    <>
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          className={`px-element-resize ${dir}`}
          onMouseDown={(e) => onResizeMouseDown(e, el.id, dir)}
        />
      ))}
      {onRotateMouseDown && (
        <div
          className="px-element-rotate"
          onMouseDown={(e) => onRotateMouseDown(e, el.id)}
          title="Drag to rotate (Shift = 15° steps)"
        />
      )}
    </>
  ) : null;

  const mouseHandler = isEditable ? (e: React.MouseEvent) => onMouseDown(e, el.id) : undefined;

  // ── Text ──
  if (el.type === 'text') {
    const isEditing = editingTextId === el.id && isEditable;
    return (
      <div
        key={el.id}
        className="px-element"
        style={baseStyle}
        onMouseDown={mouseHandler}
        onDoubleClick={isEditable ? () => onDoubleClick(el.id) : undefined}
      >
        <SelectionOutline selected={selected}>
          {isEditing ? (
            <textarea
              className="px-text-edit"
              value={el.text || ''}
              onChange={(e) => onTextChange(el.id, e.target.value)}
              onBlur={(e) => onTextBlur(el.id, e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onTextBlur(el.id, (e.currentTarget as HTMLTextAreaElement).value); }}
              autoFocus
              style={{
                fontSize: 'inherit', color: 'inherit', fontWeight: 'inherit',
                fontStyle: 'inherit', textDecoration: 'inherit',
                textAlign: el.textAlign || 'left', fontFamily: 'inherit',
              }}
            />
          ) : (
            <div style={{
              padding: insetPadding ?? 2, whiteSpace: 'pre-wrap', width: '100%', height: '100%',
              // PowerPoint spills overflowing text past the box instead of clipping
              overflow: el.insetPt ? 'visible' : 'hidden',
              // bodyPr anchor: text boxes default to top, unlike shapes
              display: 'flex', flexDirection: 'column',
              justifyContent: el.verticalAlign === 'middle' ? 'center'
                : el.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start',
            }}>
              {el.text
                ? renderTextContent(el)
                : (isEditable && !isPresentation ? (
                // Ghost placeholder like PowerPoint: display-only, never part of
                // the content, gone from presentation mode and exports.
                <span style={{ color: 'rgba(15,23,32,0.35)', fontStyle: 'italic', pointerEvents: 'none' }}>
                  Click to add text
                </span>
              ) : '')}
            </div>
          )}
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Rect ──
  if (el.type === 'rect') {
    return (
      <div
        key={el.id}
        className="px-element"
        style={{
          ...baseStyle,
          background: el.fillColor || '#4a90d9',
          borderRadius: 2,
          display: 'flex', alignItems: anchorAlignItems(el.verticalAlign), justifyContent: 'center',
        }}
        onMouseDown={mouseHandler}
        onDoubleClick={isPresentation ? undefined : () => onDoubleClick(el.id)}
      >
        <SelectionOutline selected={selected}>
          {editingTextId === el.id && isEditable ? (
            <textarea
              className="px-text-edit"
              value={el.text || ''}
              onChange={(e) => onTextChange(el.id, e.target.value)}
              onBlur={(e) => onTextBlur(el.id, e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onTextBlur(el.id, (e.currentTarget as HTMLTextAreaElement).value); }}
              autoFocus
              style={{ fontSize: 'inherit', color: 'inherit', textAlign: el.textAlign || 'center', fontFamily: 'inherit' }}
            />
          ) : (
            el.text && (
              <span style={{
                width: '100%', padding: insetPadding ?? '2px 6px', whiteSpace: 'pre-wrap',
                textAlign: el.textAlign || 'center',
              }}>{el.text}</span>
            )
          )}
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Circle ──
  if (el.type === 'circle') {
    return (
      <div
        key={el.id}
        className="px-element"
        style={{
          ...baseStyle,
          background: el.fillColor || '#4a90d9',
          borderRadius: '50%',
          display: 'flex', alignItems: anchorAlignItems(el.verticalAlign), justifyContent: 'center',
        }}
        onMouseDown={mouseHandler}
        onDoubleClick={isEditable ? () => onDoubleClick(el.id) : undefined}
      >
        <SelectionOutline selected={selected}>
          {editingTextId === el.id && isEditable ? (
            <textarea
              className="px-text-edit"
              value={el.text || ''}
              onChange={(e) => onTextChange(el.id, e.target.value)}
              onBlur={(e) => onTextBlur(el.id, e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') onTextBlur(el.id, (e.currentTarget as HTMLTextAreaElement).value); }}
              autoFocus
              style={{ fontSize: 'inherit', color: 'inherit', textAlign: el.textAlign || 'center', fontFamily: 'inherit' }}
            />
          ) : (
            el.text && <span style={{ textAlign: el.textAlign || 'center' }}>{el.text}</span>
          )}
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Triangle / Star / Arrow (clip-path shapes) ──
  if (el.type === 'triangle' || el.type === 'star' || el.type === 'arrow') {
    const clipPath = SHAPE_CLIPS[el.type];
    return (
      <div
        key={el.id}
        className="px-element"
        style={{
          ...baseStyle,
          background: el.fillColor || '#4a90d9',
          clipPath,
          WebkitClipPath: clipPath,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseDown={mouseHandler}
      >
        <SelectionOutline selected={selected}>
          {el.text && <span style={{ textAlign: el.textAlign || 'center', fontSize: '0.8em' }}>{el.text}</span>}
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Line ──
  if (el.type === 'line') {
    return (
      <div
        key={el.id}
        className="px-element"
        style={{
          ...baseStyle,
          display: 'flex',
          alignItems: 'center',
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
        }}
        onMouseDown={mouseHandler}
      >
        <SelectionOutline selected={selected}>
          <div style={{
            width: '100%',
            height: Math.max(el.borderWidth || 2, 2),
            background: el.borderColor || '#000000',
            borderRadius: 1,
          }} />
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Table ──
  if (el.type === 'table' && el.table) {
    const t = el.table;
    const colWidths = t.colWidths && t.colWidths.length === t.cols
      ? t.colWidths
      : Array.from({ length: t.cols }, () => 1 / t.cols);
    return (
      <div
        key={el.id}
        className="px-element"
        style={{ ...baseStyle, background: 'transparent' }}
        onMouseDown={mouseHandler}
      >
        <SelectionOutline selected={selected}>
          <table className="px-table" style={{ borderColor: t.borderColor || '#cbd5e1' }}>
            <colgroup>
              {colWidths.map((cw, ci) => <col key={ci} style={{ width: `${cw * 100}%` }} />)}
            </colgroup>
            <tbody>
              {t.cells.map((row, ri) => {
                const isHeader = !!t.headerRow && ri === 0;
                return (
                  <tr key={ri}>
                    {row.map((cell, ci) => {
                      const cd = t.cellData?.[ri]?.[ci];
                      // Continuation cells are covered by a merge origin — skip them.
                      if (cd?.hMerge || cd?.vMerge) return null;
                      const editingCell = editingTableCell
                        && editingTableCell.elId === el.id
                        && editingTableCell.row === ri
                        && editingTableCell.col === ci
                        && isEditable;
                      const cellStyle: React.CSSProperties = {
                        background: cd?.fillColor || (isHeader ? (t.headerFill || '#2563eb') : (t.bodyFill || '#ffffff')),
                        color: cd?.color || (isHeader ? (t.headerColor || '#ffffff') : (t.bodyColor || '#111827')),
                        borderColor: t.borderColor || '#cbd5e1',
                        fontWeight: isHeader ? 700 : undefined,
                        textAlign: cd?.align,
                      };
                      return (
                        <td
                          key={ci}
                          className="px-table-cell"
                          colSpan={cd?.colSpan && cd.colSpan > 1 ? cd.colSpan : undefined}
                          rowSpan={cd?.rowSpan && cd.rowSpan > 1 ? cd.rowSpan : undefined}
                          style={cellStyle}
                          onDoubleClick={isEditable ? (e) => { e.stopPropagation(); onTableCellDoubleClick?.(el.id, ri, ci); } : undefined}
                        >
                          {editingCell ? (
                            <textarea
                              className="px-table-cell-edit"
                              value={cell}
                              onChange={(e) => onTableCellChange?.(el.id, ri, ci, e.target.value)}
                              onBlur={onTableCellBlur}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') { onTableCellBlur?.(); return; }
                                // 스프레드시트처럼 이동: Enter는 아래 셀, Tab은 다음 셀
                                // (Shift+Enter는 셀 안 줄바꿈으로 남긴다).
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault();
                                  if (ri + 1 < t.rows) onTableCellDoubleClick?.(el.id, ri + 1, ci);
                                  else onTableCellBlur?.();
                                } else if (e.key === 'Tab') {
                                  e.preventDefault();
                                  const flat = ri * t.cols + ci + (e.shiftKey ? -1 : 1);
                                  if (flat >= 0 && flat < t.rows * t.cols) {
                                    onTableCellDoubleClick?.(el.id, Math.floor(flat / t.cols), flat % t.cols);
                                  } else {
                                    onTableCellBlur?.();
                                  }
                                }
                              }}
                              onMouseDown={(e) => e.stopPropagation()}
                              autoFocus
                            />
                          ) : cell}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  // ── Image ──
  if (el.type === 'image') {
    return (
      <div
        key={el.id}
        className="px-element"
        style={baseStyle}
        onMouseDown={mouseHandler}
      >
        <SelectionOutline selected={selected}>
          {el.imageSrc ? (
            <img
              src={el.imageSrc}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
              draggable={false}
            />
          ) : (
            <div style={{
              width: '100%', height: '100%', background: 'rgba(128,128,128,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
            }}>
              No Image
            </div>
          )}
        </SelectionOutline>
        {resizeHandle}
      </div>
    );
  }

  return null;
}

// ─── Preserved graphicFrame placeholder ───────────────────────

const PRESERVED_LABEL: Record<PreservedPart['kind'], string> = {
  chart: 'Chart (preserved)',
  diagram: 'Diagram (preserved)',
  graphicFrame: 'Object (preserved)',
};

/**
 * Placeholder for a chart / SmartArt-diagram the editor can't render natively.
 * It marks the original position/size so the user sees the content still exists
 * and will be written back verbatim on export.
 */
export function renderPreservedPart(part: PreservedPart, key?: React.Key): React.ReactNode {
  return (
    <div
      key={key}
      className="px-element px-preserved"
      style={{
        left: `${part.x}%`,
        top: `${part.y}%`,
        width: `${part.w}%`,
        height: `${part.h}%`,
        border: '1px dashed rgba(100,120,150,0.7)',
        background: 'rgba(120,140,170,0.08)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(70,90,120,0.85)',
        fontSize: 12,
        textAlign: 'center',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {PRESERVED_LABEL[part.kind]}
    </div>
  );
}

// ─── Thumbnail rendering (simplified) ─────────────────────────

export function renderThumbElement(el: SlideElement): React.ReactNode {
  const s: React.CSSProperties = {
    position: 'absolute',
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    height: `${el.h}%`,
    fontSize: '4px',
    overflow: 'hidden',
    color: el.fontColor || '#000',
  };

  if (el.rotation) s.transform = `rotate(${el.rotation}deg)`;
  if (el.opacity != null) s.opacity = el.opacity;

  if (el.type === 'rect') {
    return <div key={el.id} style={{ ...s, background: el.fillColor || '#4a90d9', borderRadius: 1 }} />;
  }
  if (el.type === 'circle') {
    return <div key={el.id} style={{ ...s, background: el.fillColor || '#4a90d9', borderRadius: '50%' }} />;
  }
  if (el.type === 'triangle' || el.type === 'star' || el.type === 'arrow') {
    return (
      <div key={el.id} style={{
        ...s,
        background: el.fillColor || '#4a90d9',
        clipPath: SHAPE_CLIPS[el.type],
      }} />
    );
  }
  if (el.type === 'line') {
    return (
      <div key={el.id} style={{ ...s, display: 'flex', alignItems: 'center' }}>
        <div style={{ width: '100%', height: 1, background: el.borderColor || '#000' }} />
      </div>
    );
  }
  if (el.type === 'image') {
    return (
      <div key={el.id} style={{ ...s, background: 'rgba(128,128,128,0.2)' }}>
        {el.imageSrc && <img src={el.imageSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
      </div>
    );
  }
  if (el.type === 'table' && el.table) {
    const t = el.table;
    return (
      <div key={el.id} style={{ ...s, display: 'grid', gridTemplateColumns: `repeat(${t.cols}, 1fr)`, gridTemplateRows: `repeat(${t.rows}, 1fr)`, gap: 0.5, background: t.borderColor || '#cbd5e1' }}>
        {Array.from({ length: t.rows * t.cols }, (_, i) => {
          const ri = Math.floor(i / t.cols);
          const ci = i % t.cols;
          const cd = t.cellData?.[ri]?.[ci];
          const isHeader = !!t.headerRow && ri === 0;
          const bg = cd?.fillColor || (isHeader ? (t.headerFill || '#2563eb') : (t.bodyFill || '#fff'));
          return <div key={i} style={{ background: bg }} />;
        })}
      </div>
    );
  }
  // text
  return <div key={el.id} style={s}>{(el.text || '').slice(0, 10)}</div>;
}
