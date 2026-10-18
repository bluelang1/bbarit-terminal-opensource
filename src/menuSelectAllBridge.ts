// macOS Edit 메뉴의 Select All(Cmd+A)이 보내는 menu-select-all 이벤트를 받아
// 포커스된 표면에 합성 Cmd+A keydown을 재전송한다. WKWebView에서는 메뉴 key
// equivalent가 네이티브 단계에서 Cmd+A를 가로채 DOM keydown이 오지 않으므로,
// predefined selectAll: 액션은 Monaco/xterm처럼 숨은 textarea로 입력받는
// 에디터의 보이는 선택을 바꾸지 못한다. 합성 keydown은 각 에디터의 기존
// Cmd+A 핸들러(Monaco 키바인딩, xterm window 핸들러, ProseMirror, Xlsx/Pptx)를
// 그대로 태우고, 아무도 소비하지 않으면 input/execCommand 폴백으로 네이티브
// 동작을 재현한다.
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export function performSelectAll() {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const ev = new KeyboardEvent('keydown', {
    key: 'a',
    code: 'KeyA',
    // WebKit은 KeyboardEventInit의 keyCode를 지원한다 — Monaco 키바인딩 매칭에 필요.
    keyCode: 65,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  } as KeyboardEventInit);
  const unhandled = target.dispatchEvent(ev);
  if (!unhandled) return; // 에디터가 preventDefault로 자체 전체 선택을 수행함
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return;
  }
  try {
    document.execCommand('selectAll');
  } catch {
    // ignore
  }
}

export function installMenuSelectAllBridge() {
  if (!isTauri()) return;
  void listen('menu-select-all', () => {
    // 이벤트는 앱 전역 브로드캐스트 — 포커스된 창만 반응한다.
    if (!document.hasFocus()) return;
    performSelectAll();
  });
}
