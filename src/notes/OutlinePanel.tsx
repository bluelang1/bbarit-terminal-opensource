/**
 * OutlinePanel.tsx
 *
 * Obsidian-style outline (table of contents) panel for the active markdown note.
 * Lists all headings with indentation; clicking scrolls the editor to the heading.
 */

import { useMemo } from 'react';
import { List } from 'lucide-react';
import { parseOutline } from './outline';
import './OutlinePanel.css';

export interface OutlinePanelProps {
  /** Current markdown content */
  content: string;
  /** Called with the 1-based line number and text of the clicked heading */
  onHeadingClick: (line: number, text: string) => void;
  /** Theme colors */
  style: { bg: string; text: string; accent: string };
}

export function OutlinePanel({ content, onHeadingClick, style }: OutlinePanelProps) {
  const headings = useMemo(() => parseOutline(content), [content]);

  return (
    <div
      className="outline-panel"
      style={{
        '--op-bg': style.bg,
        '--op-text': style.text,
        '--op-accent': style.accent,
      } as React.CSSProperties}
    >
      <div className="outline-panel-header">
        <List size={14} />
        <span className="outline-panel-title">Outline</span>
        {headings.length > 0 && <span className="outline-panel-count">{headings.length}</span>}
      </div>
      <div className="outline-panel-list">
        {headings.length === 0 ? (
          <div className="outline-panel-empty">No headings</div>
        ) : (
          headings.map((h, idx) => (
            <div
              key={`${h.line}-${idx}`}
              className={`outline-panel-item level-${h.level}`}
              style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
              onClick={() => onHeadingClick(h.line, h.text)}
              title={h.text}
            >
              {h.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
