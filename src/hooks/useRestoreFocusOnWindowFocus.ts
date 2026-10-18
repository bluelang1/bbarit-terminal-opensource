import { useEffect } from 'react';

// 다른 창/앱으로 포커스가 갔다 돌아올 때 입력 포커스 복원. WebKit은 창이
// 블러되면 activeElement를 body로 떨어뜨릴 수 있어(특히 같은 앱의 다른
// 웹뷰 창과 오갈 때), 돌아와도 터미널/에디터에 타이핑이 안 들어간다 —
// 블러 직전 포커스 요소를 기억해 두었다가 복귀 시 아무도 포커스를 갖고
// 있지 않으면 그 자리로 되돌린다.
export function useRestoreFocusOnWindowFocus() {
  useEffect(() => {
    let lastFocused: HTMLElement | null = null;
    const onWindowBlur = () => {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && ae.tagName !== 'HTML') lastFocused = ae;
    };
    const onWindowFocus = () => {
      window.setTimeout(() => {
        const ae = document.activeElement;
        if (ae && ae !== document.body && ae.tagName !== 'HTML') return;
        const el = lastFocused;
        if (!el || !document.contains(el) || el.offsetParent === null) return;
        try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
      }, 0);
    };
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);
}
