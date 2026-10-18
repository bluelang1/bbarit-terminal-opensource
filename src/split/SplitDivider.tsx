/**
 * Phase 2.3: Split Divider
 *
 * Thin visible divider (1px) with larger hit area (6px).
 * Double-click equalizes the parent split ratio.
 */

import React, { useCallback, useRef } from 'react';

interface SplitDividerProps {
  direction: 'horizontal' | 'vertical';
  onDrag: (delta: number) => void;
  onDoubleClick: () => void;
  accentColor?: string;
}

export function SplitDivider({ direction, onDrag, onDoubleClick, accentColor }: SplitDividerProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragging.current) return;
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = current - lastPos.current;
      lastPos.current = current;
      if (delta !== 0) onDrag(delta);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [direction, onDrag]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className="split-divider"
      style={{
        position: 'relative',
        flexShrink: 0,
        width: isHorizontal ? '1px' : '100%',
        height: isHorizontal ? '100%' : '1px',
        background: accentColor ? `${accentColor}44` : 'color-mix(in srgb, var(--text-color, #a9b1d6) 20%, transparent)',
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        zIndex: 10,
      }}
      onMouseDown={handleMouseDown}
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); onDoubleClick(); }}
    >
      {/* Invisible hit area */}
      <div style={{
        position: 'absolute',
        top: isHorizontal ? 0 : '-3px',
        left: isHorizontal ? '-3px' : 0,
        width: isHorizontal ? '7px' : '100%',
        height: isHorizontal ? '100%' : '7px',
      }} />
    </div>
  );
}
