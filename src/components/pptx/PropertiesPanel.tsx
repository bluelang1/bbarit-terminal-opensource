/**
 * PropertiesPanel.tsx — Right-side properties panel for slide/element editing
 */

import {
  List, ListOrdered,
  Trash2, Copy, ArrowUp, ArrowDown,
  ChevronsUp, ChevronsDown,
  AlignLeft, AlignCenter, AlignRight,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignHorizontalSpaceBetween, AlignVerticalSpaceBetween,
  Plus, Minus,
} from 'lucide-react';
import type { ElementAnimationEffect, Slide, SlideElement } from './types';
import { ANIMATION_EFFECTS, DEFAULT_ANIMATION_MS, nextAnimationOrder } from './pptxAnimations';
import { FONT_FAMILIES } from './types';

type AlignAxis = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

interface PropertiesPanelProps {
  currentSlide: Slide;
  selectedEl: SlideElement | null;
  width?: number;
  onSlideBgChange: (color: string) => void;
  onSlideBgImageChange: (imageSrc?: string) => void | Promise<void>;
  onReplaceSelectedImage?: () => void | Promise<void>;
  onClearSelectedImage?: () => void;
  onUpdateElement: (elId: string, updates: Partial<SlideElement>) => void;
  onDeleteElement: () => void;
  onDuplicateElement: () => void;
  onZOrder: (action: 'front' | 'back' | 'forward' | 'backward') => void;
  onAlign: (axis: AlignAxis) => void;
  selectedCount?: number;
  onAlignSelection?: (axis: AlignAxis) => void;
  onDistribute?: (dir: 'h' | 'v') => void;
  onGroup?: () => void;
  onUngroup?: () => void;
  selectionHasGroup?: boolean;
  onTableAddRow?: (elId: string) => void;
  onTableRemoveRow?: (elId: string) => void;
  onTableAddCol?: (elId: string) => void;
  onTableRemoveCol?: (elId: string) => void;
  onTableToggleHeader?: (elId: string) => void;
}

export function PropertiesPanel({
  currentSlide, selectedEl,
  width,
  onSlideBgChange, onSlideBgImageChange, onReplaceSelectedImage, onClearSelectedImage, onUpdateElement,
  onDeleteElement, onDuplicateElement,
  onZOrder, onAlign,
  selectedCount = selectedEl ? 1 : 0,
  onAlignSelection, onDistribute,
  onGroup, onUngroup, selectionHasGroup,
  onTableAddRow, onTableRemoveRow, onTableAddCol, onTableRemoveCol, onTableToggleHeader,
}: PropertiesPanelProps) {
  // UI copy is standardized to English across all three editors.
  const L = (_ko: string, en: string) => en;
  const el = selectedEl;

  // Multi-selection: no single element to detail — offer group actions only.
  if (selectedCount > 1) {
    return (
      <div className="px-props-panel" style={width ? { width } : undefined}>
        <h4>{L(`${selectedCount}개 선택됨`, `${selectedCount} selected`)}</h4>
        <div className="px-prop-hint">{L('Shift+클릭 또는 마퀴 드래그로 선택. 화살표로 그룹 이동.', 'Shift+click or marquee-drag to select. Move the group with arrow keys.')}</div>

        <h4>{L('맞춤 (선택 요소 기준)', 'Align (to selection)')}</h4>
        <div className="px-prop-row" style={{ gap: 2 }}>
          <button className="px-btn" onClick={() => onAlignSelection?.('left')} title={L('왼쪽 가장자리 맞춤', 'Align left edges')}><AlignStartVertical size={12} /></button>
          <button className="px-btn" onClick={() => onAlignSelection?.('center')} title={L('가로 가운데 맞춤', 'Align horizontal centers')}><AlignCenterVertical size={12} /></button>
          <button className="px-btn" onClick={() => onAlignSelection?.('right')} title={L('오른쪽 가장자리 맞춤', 'Align right edges')}><AlignEndVertical size={12} /></button>
          <button className="px-btn" onClick={() => onAlignSelection?.('top')} title={L('위쪽 가장자리 맞춤', 'Align top edges')}><AlignStartVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
          <button className="px-btn" onClick={() => onAlignSelection?.('middle')} title={L('세로 가운데 맞춤', 'Align vertical centers')}><AlignCenterVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
          <button className="px-btn" onClick={() => onAlignSelection?.('bottom')} title={L('아래쪽 가장자리 맞춤', 'Align bottom edges')}><AlignEndVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
        </div>

        <h4>{L('배분', 'Distribute')}</h4>
        <div className="px-prop-row" style={{ gap: 2 }}>
          <button className="px-btn" onClick={() => onDistribute?.('h')} disabled={selectedCount < 3} title={L('가로로 배분 (3개 이상)', 'Distribute horizontally (3+)')}><AlignHorizontalSpaceBetween size={12} /></button>
          <button className="px-btn" onClick={() => onDistribute?.('v')} disabled={selectedCount < 3} title={L('세로로 배분 (3개 이상)', 'Distribute vertically (3+)')}><AlignVerticalSpaceBetween size={12} /></button>
          {onGroup && (
            <button className="px-btn" onClick={onGroup} title={L('그룹 (Cmd+G)', 'Group (Cmd+G)')}>
              {L('그룹', 'Group')}
            </button>
          )}
          {onUngroup && selectionHasGroup && (
            <button className="px-btn" onClick={onUngroup} title={L('그룹 해제 (Cmd+Shift+G)', 'Ungroup (Cmd+Shift+G)')}>
              {L('그룹 해제', 'Ungroup')}
            </button>
          )}
        </div>

        <div className="px-prop-row" style={{ marginTop: 6, gap: 4 }}>
          <button className="px-btn" onClick={onDuplicateElement} title={L('그룹 복제 (Cmd+D)', 'Duplicate group (Cmd+D)')}><Copy size={12} /> {L('복제', 'Dup')}</button>
          <button className="px-btn px-btn-danger" onClick={onDeleteElement} title={L('그룹 삭제', 'Delete group')}><Trash2 size={12} /> {L('삭제', 'Del')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-props-panel" style={width ? { width } : undefined}>
      {/* ── Slide background ── */}
      <h4>{L('슬라이드', 'Slide')}</h4>
      <div className="px-prop-row">
        <label>{L('배경', 'BG')}</label>
        <input
          type="color"
          value={currentSlide.bgColor}
          onChange={(e) => onSlideBgChange(e.target.value)}
          title={L('슬라이드 배경색', 'Slide background color')}
        />
      </div>
      <div className="px-prop-row">
        <label>{L('이미지', 'Image')}</label>
        <button className="px-btn" onClick={() => { void onSlideBgImageChange(); }}>{L('업로드', 'Upload')}</button>
        {currentSlide.bgImage && (
          <button className="px-btn" onClick={() => onSlideBgImageChange(undefined)}>{L('지우기', 'Clear')}</button>
        )}
      </div>
      {/* 발표자 노트는 캔버스 아래 노트 바로, 전환 설정은 리본 Present 탭으로 이동. */}

      {el?.type === 'image' && (
        <>
          <h4>{L('이미지', 'Image')}</h4>
          <div className="px-prop-row">
            <label>{L('원본', 'Source')}</label>
            <button className="px-btn" onClick={() => { void onReplaceSelectedImage?.(); }}>{L('교체', 'Replace')}</button>
            {el.imageSrc && (
              <button className="px-btn" onClick={() => onClearSelectedImage?.()}>{L('지우기', 'Clear')}</button>
            )}
          </div>
        </>
      )}

      {el?.type === 'table' && el.table && (
        <>
          <h4>{L('표', 'Table')}</h4>
          <div className="px-prop-row">
            <span style={{ fontSize: 11 }}>{el.table.rows} × {el.table.cols}</span>
          </div>
          <div className="px-prop-row" style={{ gap: 2 }}>
            <label style={{ minWidth: 30 }}>{L('행', 'Rows')}</label>
            <button className="px-btn" onClick={() => onTableAddRow?.(el.id)} title={L('행 추가', 'Add row')}><Plus size={12} /></button>
            <button className="px-btn" onClick={() => onTableRemoveRow?.(el.id)} title={L('행 삭제', 'Remove row')}><Minus size={12} /></button>
          </div>
          <div className="px-prop-row" style={{ gap: 2 }}>
            <label style={{ minWidth: 30 }}>{L('열', 'Cols')}</label>
            <button className="px-btn" onClick={() => onTableAddCol?.(el.id)} title={L('열 추가', 'Add column')}><Plus size={12} /></button>
            <button className="px-btn" onClick={() => onTableRemoveCol?.(el.id)} title={L('열 삭제', 'Remove column')}><Minus size={12} /></button>
          </div>
          <div className="px-prop-row">
            <label>{L('머리글', 'Header')}</label>
            <input
              type="checkbox"
              checked={!!el.table.headerRow}
              onChange={() => onTableToggleHeader?.(el.id)}
            />
          </div>
          <div className="px-prop-row">
            <label>{L('머리글 채우기', 'Header Fill')}</label>
            <input
              type="color"
              value={el.table.headerFill || '#2563eb'}
              onChange={(e) => onUpdateElement(el.id, { table: { ...el.table!, headerFill: e.target.value } })}
            />
          </div>
          <div className="px-prop-row">
            <label>{L('테두리', 'Border')}</label>
            <input
              type="color"
              value={el.table.borderColor || '#cbd5e1'}
              onChange={(e) => onUpdateElement(el.id, { table: { ...el.table!, borderColor: e.target.value } })}
            />
          </div>
          <div className="px-prop-hint">{L('셀을 더블클릭하면 텍스트를 편집합니다.', 'Double-click a cell to edit its text.')}</div>
        </>
      )}

      {el && (
        <>
          {/* ── Text formatting (for text, rect, circle) ── */}
          {(el.type === 'text' || el.type === 'rect' || el.type === 'circle') && (
            <>
              <h4>{L('텍스트', 'Text')}</h4>
              <div className="px-prop-row">
                <label>{L('글꼴', 'Font')}</label>
                <select
                  value={el.fontFamily || 'Sans-serif'}
                  onChange={(e) => onUpdateElement(el.id, { fontFamily: e.target.value })}
                >
                  {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className="px-prop-row">
                <label>{L('크기', 'Size')}</label>
                <input
                  type="number" value={el.fontSize || 18} min={6} max={120}
                  onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onUpdateElement(el.id, { fontSize: n }); }}
                />
              </div>
              <div className="px-prop-row">
                <label>{L('색상', 'Color')}</label>
                <input
                  type="color"
                  value={el.fontColor || '#000000'}
                  onChange={(e) => onUpdateElement(el.id, { fontColor: e.target.value })}
                />
              </div>
              <div className="px-prop-row" style={{ gap: 2 }}>
                <button
                  className={`px-btn ${el.bold ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { bold: !el.bold })}
                  title={L('굵게', 'Bold')}
                  style={{ fontWeight: 'bold', minWidth: 24 }}
                >B</button>
                <button
                  className={`px-btn ${el.italic ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { italic: !el.italic })}
                  title={L('기울임', 'Italic')}
                  style={{ fontStyle: 'italic', minWidth: 24 }}
                >I</button>
                <button
                  className={`px-btn ${el.underline ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { underline: !el.underline })}
                  title={L('밑줄', 'Underline')}
                  style={{ textDecoration: 'underline', minWidth: 24 }}
                >U</button>
                <button
                  className={`px-btn ${el.strikethrough ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { strikethrough: !el.strikethrough })}
                  title={L('취소선', 'Strikethrough')}
                  style={{ textDecoration: 'line-through', minWidth: 24 }}
                >S</button>
              </div>
              <div className="px-prop-row" style={{ gap: 2 }}>
                <button
                  className={`px-btn ${el.textAlign === 'left' || !el.textAlign ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { textAlign: 'left' })}
                  title={L('왼쪽 맞춤', 'Align Left')}
                ><AlignLeft size={12} /></button>
                <button
                  className={`px-btn ${el.textAlign === 'center' ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { textAlign: 'center' })}
                  title={L('가운데 맞춤', 'Align Center')}
                ><AlignCenter size={12} /></button>
                <button
                  className={`px-btn ${el.textAlign === 'right' ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { textAlign: 'right' })}
                  title={L('오른쪽 맞춤', 'Align Right')}
                ><AlignRight size={12} /></button>
                <button
                  className={`px-btn ${el.listStyle === 'bullet' ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { listStyle: el.listStyle === 'bullet' ? 'none' : 'bullet' })}
                  title={L('글머리 기호', 'Bulleted list')}
                ><List size={12} /></button>
                <button
                  className={`px-btn ${el.listStyle === 'number' ? 'active' : ''}`}
                  onClick={() => onUpdateElement(el.id, { listStyle: el.listStyle === 'number' ? 'none' : 'number' })}
                  title={L('번호 매기기', 'Numbered list')}
                ><ListOrdered size={12} /></button>
              </div>
            </>
          )}

          {/* ── Fill (shapes) ── */}
          {(el.type === 'rect' || el.type === 'circle' || el.type === 'triangle' || el.type === 'star' || el.type === 'arrow') && (
            <>
              <h4>{L('채우기', 'Fill')}</h4>
              <div className="px-prop-row">
                <label>{L('색상', 'Color')}</label>
                <input
                  type="color"
                  value={el.fillColor || '#4a90d9'}
                  onChange={(e) => onUpdateElement(el.id, { fillColor: e.target.value })}
                />
              </div>
            </>
          )}

          {/* ── Line color/width ── */}
          {el.type === 'line' && (
            <>
              <h4>{L('선', 'Line')}</h4>
              <div className="px-prop-row">
                <label>{L('색상', 'Color')}</label>
                <input
                  type="color"
                  value={el.borderColor || '#000000'}
                  onChange={(e) => onUpdateElement(el.id, { borderColor: e.target.value })}
                />
              </div>
              <div className="px-prop-row">
                <label>{L('두께', 'Width')}</label>
                <input
                  type="number" value={el.borderWidth || 2} min={1} max={20}
                  onChange={(e) => onUpdateElement(el.id, { borderWidth: +e.target.value })}
                />
              </div>
            </>
          )}

          {/* ── Border (non-line) ── */}
          {el.type !== 'line' && (
            <>
              <h4>{L('테두리', 'Border')}</h4>
              <div className="px-prop-row">
                <label>{L('색상', 'Color')}</label>
                <input
                  type="color"
                  value={el.borderColor || '#000000'}
                  onChange={(e) => onUpdateElement(el.id, { borderColor: e.target.value })}
                />
              </div>
              <div className="px-prop-row">
                <label>{L('두께', 'Width')}</label>
                <input
                  type="number" value={el.borderWidth || 0} min={0} max={20}
                  onChange={(e) => onUpdateElement(el.id, { borderWidth: +e.target.value })}
                />
              </div>
            </>
          )}

          {/* ── Shadow ── */}
          <div className="px-prop-row" style={{ marginTop: 4 }}>
            <label>{L('그림자', 'Shadow')}</label>
            <input
              type="checkbox"
              checked={el.shadow || false}
              onChange={(e) => onUpdateElement(el.id, { shadow: e.target.checked })}
            />
          </div>

          {/* ── Position ── */}
          <h4>{L('위치', 'Position')}</h4>
          <div className="px-prop-row">
            <label>X</label>
            <input type="number" value={Math.round(el.x)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onUpdateElement(el.id, { x: n }); }} />
            <label>Y</label>
            <input type="number" value={Math.round(el.y)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onUpdateElement(el.id, { y: n }); }} />
          </div>
          <div className="px-prop-row">
            <label>W</label>
            <input type="number" value={Math.round(el.w)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onUpdateElement(el.id, { w: n }); }} />
            <label>H</label>
            <input type="number" value={Math.round(el.h)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) onUpdateElement(el.id, { h: n }); }} />
          </div>

          {/* ── Transform ── */}
          <h4>{L('변형', 'Transform')}</h4>
          <div className="px-prop-row">
            <label>{L('회전', 'Rot')}</label>
            <input
              type="range" min={0} max={360} step={1}
              value={el.rotation || 0}
              onChange={(e) => onUpdateElement(el.id, { rotation: +e.target.value })}
            />
            <span style={{ fontSize: 10, minWidth: 28, textAlign: 'right' }}>{el.rotation || 0}°</span>
          </div>
          <div className="px-prop-row">
            <label>{L('불투명도', 'Opacity')}</label>
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round((el.opacity ?? 1) * 100)}
              onChange={(e) => onUpdateElement(el.id, { opacity: +e.target.value / 100 })}
            />
            <span style={{ fontSize: 10, minWidth: 28, textAlign: 'right' }}>{Math.round((el.opacity ?? 1) * 100)}%</span>
          </div>

          {/* ── Entrance animation (presentation click-steps) ── */}
          <h4>{L('애니메이션', 'Animation')}</h4>
          <div className="px-prop-row">
            <label>{L('효과', 'Effect')}</label>
            <select
              value={el.animation?.effect ?? 'none'}
              onChange={(e) => {
                const effect = e.target.value as ElementAnimationEffect | 'none';
                if (effect === 'none') { onUpdateElement(el.id, { animation: undefined }); return; }
                onUpdateElement(el.id, {
                  animation: {
                    effect,
                    order: el.animation?.order ?? nextAnimationOrder(currentSlide.elements),
                    durationMs: el.animation?.durationMs ?? DEFAULT_ANIMATION_MS,
                  },
                });
              }}
            >
              {ANIMATION_EFFECTS.map((fx) => <option key={fx.value} value={fx.value}>{fx.label}</option>)}
            </select>
          </div>
          {el.animation && (
            <>
              <div className="px-prop-row">
                <label>{L('순서', 'Step')}</label>
                <input
                  type="number" min={1} max={99}
                  value={el.animation.order}
                  onChange={(e) => onUpdateElement(el.id, { animation: { ...el.animation!, order: Math.max(1, +e.target.value || 1) } })}
                />
              </div>
              <div className="px-prop-row">
                <label>{L('시간(ms)', 'Duration')}</label>
                <input
                  type="number" min={100} max={5000} step={100}
                  value={el.animation.durationMs ?? DEFAULT_ANIMATION_MS}
                  onChange={(e) => onUpdateElement(el.id, { animation: { ...el.animation!, durationMs: Math.max(100, +e.target.value || DEFAULT_ANIMATION_MS) } })}
                />
              </div>
            </>
          )}

          {/* ── Z-Order ── */}
          <h4>{L('정렬 순서', 'Z-Order')}</h4>
          <div className="px-prop-row" style={{ gap: 2 }}>
            <button className="px-btn" onClick={() => onZOrder('front')} title={L('맨 앞으로', 'Bring to front')}><ChevronsUp size={12} /></button>
            <button className="px-btn" onClick={() => onZOrder('forward')} title={L('앞으로', 'Bring forward')}><ArrowUp size={12} /></button>
            <button className="px-btn" onClick={() => onZOrder('backward')} title={L('뒤로', 'Send backward')}><ArrowDown size={12} /></button>
            <button className="px-btn" onClick={() => onZOrder('back')} title={L('맨 뒤로', 'Send to back')}><ChevronsDown size={12} /></button>
          </div>

          {/* ── Align ── */}
          <h4>{L('맞춤', 'Align')}</h4>
          <div className="px-prop-row" style={{ gap: 2 }}>
            <button className="px-btn" onClick={() => onAlign('left')} title={L('왼쪽 맞춤', 'Align left')}><AlignStartVertical size={12} /></button>
            <button className="px-btn" onClick={() => onAlign('center')} title={L('가로 가운데 맞춤', 'Align center H')}><AlignCenterVertical size={12} /></button>
            <button className="px-btn" onClick={() => onAlign('right')} title={L('오른쪽 맞춤', 'Align right')}><AlignEndVertical size={12} /></button>
            <button className="px-btn" onClick={() => onAlign('top')} title={L('위쪽 맞춤', 'Align top')}><AlignStartVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
            <button className="px-btn" onClick={() => onAlign('middle')} title={L('세로 가운데 맞춤', 'Align middle V')}><AlignCenterVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
            <button className="px-btn" onClick={() => onAlign('bottom')} title={L('아래쪽 맞춤', 'Align bottom')}><AlignEndVertical size={12} style={{ transform: 'rotate(90deg)' }} /></button>
          </div>

          {/* ── Actions ── */}
          <div className="px-prop-row" style={{ marginTop: 6, gap: 4 }}>
            <button className="px-btn" onClick={onDuplicateElement} title={L('복제 (Cmd+D)', 'Duplicate (Cmd+D)')}>
              <Copy size={12} /> {L('복제', 'Dup')}
            </button>
            <button className="px-btn px-btn-danger" onClick={onDeleteElement} title={L('삭제', 'Delete')}>
              <Trash2 size={12} /> {L('삭제', 'Del')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
