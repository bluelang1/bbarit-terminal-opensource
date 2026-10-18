/**
 * BrowserAside — BBARIT Browser 우측 사이드바 (rail + 패널 2단).
 *
 * 설계: docs/BROWSER-ASIDE-DESIGN-2026-07-06.md
 * - D13: 이 컴포넌트는 CEF 영역 **밖**(우측 flex 형제)이라 React로 안전.
 *   페이지 위 UI(선택 버블 등)는 여기 두지 말 것 — Windows에서 CEF HWND가
 *   항상 위라 절대 보이지 않는다(CDP 주입만 가능).
 * - D14: 열림/폭 변화는 부모 flex 리플로우 → 기존 cefBounds ResizeObserver가
 *   cef_set_bounds를 자동 전파한다. 여기서 bounds를 직접 만지지 않는다.
 * - 상태(열림/활성 패널/폭)는 부모(BrowserPage)가 소유하고 kv로 영속(D16).
 */
import React from 'react';
import { Bot, NotebookPen, FileSearch, History, Globe, KeyRound, Puzzle, X } from 'lucide-react';

export type AsidePane = 'agent' | 'skills' | 'logins' | 'tools' | 'notes' | 'history' | 'webpanel';

interface RailItem {
  id: AsidePane;
  icon: React.ReactNode;
  label: string;
  /** P2+ 예정 패널은 rail에 자리만 잡고 비활성. */
  disabled?: boolean;
}

interface Props {
  open: boolean;
  pane: AsidePane;
  width: number;
  /** 에이전트 작업 중 rail 배지(● 펄스). */
  agentWorking?: boolean;
  onToggle: (open: boolean) => void;
  onPaneChange: (pane: AsidePane) => void;
  onWidthChange: (width: number) => void;
  /** 폭 드래그 동안 CEF 탭을 숨겨 mousemove를 React가 받게 한다(기존 독 관례). */
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** 패널 본문 — 활성 pane에 해당하는 것만 렌더된다. */
  panes: Partial<Record<AsidePane, React.ReactNode>>;
  titles: Partial<Record<AsidePane, string>>;
}

export const ASIDE_MIN_W = 280;
// 고정 480 상한은 넓은 화면에서 "폭 조절이 안 된다"로 느껴진다 — 창 폭에 비례해 완화.
export const asideMaxW = () => Math.max(480, Math.min(900, Math.round(window.innerWidth * 0.6)));

export function BrowserAside({ open, pane, width, agentWorking, onToggle, onPaneChange, onWidthChange, onDragStart, onDragEnd, panes, titles }: Props) {
  const rail: RailItem[] = [
    { id: 'agent', icon: <Bot size={16} />, label: 'BBARIT Chat (Ctrl+.)' },
    { id: 'skills', icon: <Puzzle size={16} />, label: 'Skills & Plugins' },
    { id: 'logins', icon: <KeyRound size={16} />, label: 'Site Logins' },
    { id: 'tools', icon: <FileSearch size={16} />, label: 'Page Tools' },
    { id: 'notes', icon: <NotebookPen size={16} />, label: 'Notes & Clips' },
    { id: 'history', icon: <History size={16} />, label: 'History & Bookmarks' },
    { id: 'webpanel', icon: <Globe size={16} />, label: 'Quick Access' },
  ];

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    onDragStart?.();
    const move = (ev: MouseEvent) => {
      const w = Math.max(ASIDE_MIN_W, Math.min(asideMaxW(), Math.round(window.innerWidth - ev.clientX - 36)));
      onWidthChange(w);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onDragEnd?.();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="browser-aside-root">
        <div
          className="browser-aside-panel"
          style={{ width, display: open ? undefined : 'none' }}
          aria-hidden={!open}
        >
          <div className="browser-aside-resize" onMouseDown={startDrag} title="Drag to resize" />
          <div className="browser-aside-head">
            <strong>{titles[pane] ?? ''}</strong>
            <button type="button" title="Collapse (Ctrl+.)" onClick={() => onToggle(false)}><X size={14} /></button>
          </div>
          <div className="browser-aside-body">
            {/* Keep the agent surface mounted while the rail is collapsed or a
                sibling pane is selected. Unmounting it used to kill an active
                RPC child and discard the local queue/transcript state. */}
            <div style={{ display: pane === 'agent' ? 'contents' : 'none' }}>{panes.agent}</div>
            {pane === 'agent' ? null : panes[pane]}
          </div>
        </div>
      <div className="browser-aside-rail" role="toolbar" aria-label="Browser aside">
        <img className="browser-aside-logo" src="/icons/bbarit-logo.png" alt="BBARIT" title="BBARIT Browser" draggable={false} />
        {rail.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`browser-aside-rail-btn${open && pane === item.id ? ' active' : ''}${item.disabled ? ' disabled' : ''}`}
            title={item.label}
            disabled={item.disabled}
            onClick={() => {
              if (open && pane === item.id) onToggle(false);
              else { onPaneChange(item.id); onToggle(true); }
            }}
          >
            {item.icon}
            {item.id === 'agent' && agentWorking && <span className="browser-aside-badge" />}
          </button>
        ))}
      </div>
    </div>
  );
}
