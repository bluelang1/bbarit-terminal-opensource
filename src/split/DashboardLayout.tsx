/**
 * Dashboard Layout — drag & drop grid (no external dependencies).
 *
 * Each terminal panel can be:
 *   - Pinned (locked in place)
 *   - Unpinned (freely draggable; other panels reflow around it)
 *
 * Pure CSS Grid + native drag events.
 * Drag is initiated ONLY from the header (not terminal area).
 */

import React, { useMemo, useCallback, useRef, useState } from 'react';

export interface DashboardItem {
  id: string;
  pinned: boolean;
  /** Grid column span (1-12 scale mapped to actual cols) */
  colSpan: number;
  /** Grid row span */
  rowSpan: number;
}

export interface DashboardLayoutData {
  items: DashboardItem[];
  cols: number;
}

export function createDefaultDashboardLayout(terminalIds: string[]): DashboardLayoutData {
  const cols = Math.min(terminalIds.length, 4) || 1;
  const items: DashboardItem[] = terminalIds.map((id) => ({
    id,
    pinned: false,
    colSpan: 1,
    rowSpan: 1,
  }));
  return { items, cols };
}

export function normalizeDashboardLayout(
  data: DashboardLayoutData | undefined,
  terminalIds: string[],
): DashboardLayoutData {
  if (!data) return createDefaultDashboardLayout(terminalIds);

  const existing = new Set(data.items.map((it) => it.id));
  const desired = new Set(terminalIds);

  const items = data.items.filter((it) => desired.has(it.id));
  for (const id of terminalIds) {
    if (!existing.has(id)) {
      items.push({ id, pinned: false, colSpan: 1, rowSpan: 1 });
    }
  }

  // Preserve terminal order
  const order = new Map(terminalIds.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { items, cols: data.cols || Math.min(terminalIds.length, 4) || 1 };
}

interface DashboardLayoutProps {
  terminalIds: string[];
  activeTerminalId: string | undefined;
  layoutData: DashboardLayoutData | undefined;
  onLayoutChange: (data: DashboardLayoutData) => void;
  onTogglePin: (terminalId: string) => void;
  onActivate: (terminalId: string) => void;
  renderTerminal: (terminalId: string) => React.ReactNode;
  renderHeader: (terminalId: string, pinned: boolean, onTogglePin: () => void) => React.ReactNode;
  accentColor?: string;
  bgColor?: string;
}

export function DashboardLayout({
  terminalIds,
  activeTerminalId,
  layoutData: rawData,
  onLayoutChange,
  onTogglePin,
  onActivate,
  renderTerminal,
  renderHeader,
  accentColor = '#7aa2f7',
  bgColor = '#1a1b26',
}: DashboardLayoutProps) {
  const data = useMemo(
    () => normalizeDashboardLayout(rawData, terminalIds),
    [rawData, terminalIds],
  );

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const pinnedMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const it of data.items) m.set(it.id, it.pinned);
    return m;
  }, [data.items]);

  // Drag handlers — attached to the HEADER only
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    if (pinnedMap.get(id)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDragId(id);
  }, [pinnedMap]);

  // Drop zone handlers — on the whole panel
  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragId) setDropTarget(id);
  }, [dragId]);

  const handleDragLeave = useCallback(() => {
    setDropTarget(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDropTarget(null);
    setDragId(null);

    const sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) return;

    // Reorder: move source to target's position
    const items = [...data.items];
    const srcIdx = items.findIndex((it) => it.id === sourceId);
    const tgtIdx = items.findIndex((it) => it.id === targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;

    const [removed] = items.splice(srcIdx, 1);
    items.splice(tgtIdx, 0, removed);

    onLayoutChange({ ...data, items });
  }, [data, onLayoutChange]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDropTarget(null);
  }, []);

  // Resize handler (col/row span)
  const handleResizeStart = useCallback((e: React.MouseEvent, id: string, edge: 'col' | 'row') => {
    e.preventDefault();
    e.stopPropagation();
    const item = data.items.find((it) => it.id === id);
    if (!item) return;

    const startSpan = edge === 'col' ? item.colSpan : item.rowSpan;

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const cellW = rect.width / data.cols;
      const cellH = 160;

      const delta = edge === 'col'
        ? Math.round((ev.clientX - e.clientX) / cellW)
        : Math.round((ev.clientY - e.clientY) / cellH);

      const newSpan = Math.max(1, Math.min(edge === 'col' ? data.cols : 4, startSpan + delta));

      const items = data.items.map((it) =>
        it.id === id
          ? { ...it, [edge === 'col' ? 'colSpan' : 'rowSpan']: newSpan }
          : it
      );
      onLayoutChange({ ...data, items });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = edge === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [data, onLayoutChange]);

  return (
    <div
      ref={containerRef}
      className="dashboard-layout-root"
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        display: 'grid',
        gridTemplateColumns: `repeat(${data.cols}, 1fr)`,
        gridAutoRows: 'minmax(160px, 1fr)',
        gap: '4px',
        padding: '4px',
        boxSizing: 'border-box',
      }}
    >
      {data.items.map((item) => {
        const isPinned = pinnedMap.get(item.id) ?? false;
        const isActive = item.id === activeTerminalId;
        const isDragging = item.id === dragId;
        const isDropTarget = item.id === dropTarget;
        const isHovered = item.id === hoverId;

        return (
          <div
            key={item.id}
            className={`dashboard-terminal-card terminal-wrapper ${isActive ? 'active' : ''}`}
            onDragOver={(e) => handleDragOver(e, item.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, item.id)}
            onDragEnd={handleDragEnd}
            onClickCapture={() => onActivate(item.id)}
            onMouseEnter={() => setHoverId(item.id)}
            onMouseLeave={() => setHoverId(null)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gridColumn: `span ${Math.min(item.colSpan, data.cols)}`,
              gridRow: `span ${item.rowSpan}`,
              border: isDropTarget
                ? `2px dashed ${accentColor}`
                : isActive
                  ? `1.5px solid ${accentColor}`
                  : `1px solid color-mix(in srgb, ${accentColor} 25%, transparent)`,
              borderRadius: 'var(--brutal-radius)',
              overflow: 'hidden',
              boxSizing: 'border-box',
              background: bgColor,
              opacity: isDragging ? 0.4 : 1,
              transition: 'border 0.04s, opacity 0.03s',
              position: 'relative',
              minHeight: 0,
            }}
          >
            {/* Header — this is the DRAG HANDLE */}
            <div
              draggable={!isPinned}
              onDragStart={(e) => handleDragStart(e, item.id)}
              style={{ cursor: isPinned ? 'default' : 'grab' }}
            >
              {renderHeader(item.id, isPinned, () => onTogglePin(item.id))}
            </div>
            {/* Terminal content */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
              {renderTerminal(item.id)}
            </div>
            {/* Resize handles — only visible on hover */}
            {isHovered && (
              <>
                {/* Right edge (col span) */}
                <div
                  onMouseDown={(e) => handleResizeStart(e, item.id, 'col')}
                  style={{
                    position: 'absolute',
                    top: 0,
                    right: 0,
                    width: '5px',
                    height: '100%',
                    cursor: 'col-resize',
                    zIndex: 10,
                    background: `linear-gradient(to left, ${accentColor}33, transparent)`,
                  }}
                />
                {/* Bottom edge (row span) */}
                <div
                  onMouseDown={(e) => handleResizeStart(e, item.id, 'row')}
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: '5px',
                    cursor: 'row-resize',
                    zIndex: 10,
                    background: `linear-gradient(to top, ${accentColor}33, transparent)`,
                  }}
                />
                {/* Corner */}
                <div
                  onMouseDown={(e) => { handleResizeStart(e, item.id, 'col'); }}
                  style={{
                    position: 'absolute',
                    bottom: 0,
                    right: 0,
                    width: '10px',
                    height: '10px',
                    cursor: 'nwse-resize',
                    zIndex: 11,
                    background: `${accentColor}44`,
                    borderRadius: '2px 0 2px 0',
                  }}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
