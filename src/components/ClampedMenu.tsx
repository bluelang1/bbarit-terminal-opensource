import { useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

// position:fixed 컨텍스트 메뉴가 뷰포트 밖으로 나가지 않게 마운트 직후 실측으로
// 위치를 보정한다 (FileTreeContextMenu와 동일한 규칙). 메뉴가 뷰포트보다 크면
// max-height + 스크롤로 모든 항목이 접근 가능해야 한다.
export function ClampedMenu({ x, y, style, children, ...rest }: HTMLAttributes<HTMLDivElement> & {
  x: number;
  y: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    let top = y;
    let left = x;
    if (el) {
      const rect = el.getBoundingClientRect();
      if (top + rect.height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - rect.height - 8);
      }
      if (left + rect.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - rect.width - 8);
      }
    }
    setPos({ top, left });
  }, [x, y]);

  return (
    <div
      ref={ref}
      {...rest}
      style={{
        ...style,
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        maxHeight: 'calc(100vh - 16px)',
        overflowY: 'auto',
      }}
    >
      {children}
    </div>
  );
}
