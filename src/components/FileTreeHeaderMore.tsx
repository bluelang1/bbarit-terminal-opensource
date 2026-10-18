/**
 * 파일 트리 헤더의 ⋯(더보기) 버튼 — 자주 쓰지 않는 액션을 드롭다운으로 숨겨
 * 헤더를 간결하게 유지한다. 편집 액션은 우클릭 컨텍스트 메뉴에도 그대로 있다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface FileTreeHeaderMoreItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 대기 상태 강조 (예: 잘라내기 대기, Undo 가능) */
  active?: boolean;
}

export function FileTreeHeaderMore({ items, title }: { items: (FileTreeHeaderMoreItem | 'sep')[]; title: string }) {
  // 헤더 액션 바는 스크롤 컨테이너라 absolute 드롭다운이 잘린다 —
  // 컨텍스트 메뉴처럼 fixed로 버튼 좌표에 붙인다.
  const [open, setOpen] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClose = () => setOpen(null);
    window.addEventListener('octo:close-filetree-menus', onClose);
    return () => window.removeEventListener('octo:close-filetree-menus', onClose);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="btn-filetree"
        onClick={(e) => {
          window.dispatchEvent(new Event('octo:close-app-floating-menus'));
          window.dispatchEvent(new Event('octo:close-filetree-menus'));
          const rect = e.currentTarget.getBoundingClientRect();
          setOpen((v) => v ? null : { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
        }}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!open}
        style={open ? { color: 'var(--accent-color)' } : undefined}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          className="ftree-ctx-menu"
          role="menu"
          aria-label={title}
          style={{ top: open.top, right: open.right, left: 'auto' }}
        >
          {items.map((item, i) => item === 'sep' ? (
            <div key={i} className="ftree-ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={item.danger ? 'ftree-ctx-danger' : undefined}
              onClick={() => { if (!item.disabled) item.onClick(); setOpen(null); }}
              disabled={item.disabled}
              aria-disabled={item.disabled}
              style={item.active ? { color: 'var(--accent-color)' } : undefined}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
