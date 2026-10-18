// IME 조합 중 프리에딧 오버레이 앵커 관리 헬퍼.
//
// 조합 중에는 커서 추적이 얼려지고(mid-frame TUI 커서/에코 왕복 오염 방지),
// 음절 커밋 시 앵커를 커밋 폭만큼 로컬 전진시킨다. 로컬 전진은 줄바꿈이나
// TUI(빠릿에이전트) 컴포저 재배치를 모를 수밖에 없으므로, 커밋 에코가
// 화면에 반영되고 터미널이 잠잠해진 뒤 실제 커서로 재동기화해 드리프트를
// 바로잡는다 — 실제 커서는 어떤 레이아웃에서든 다음 프리에딧이 그려질 자리다.

import { imeTextCells } from '../imeTextCells';

export interface ImeAnchor {
  left: number;
  top: number;
  cellW: number;
  cellH: number;
}

// 커밋 직후 앵커를 커밋 폭만큼 전진. 오른쪽 끝에서는 터미널이 줄바꿈하지만
// TUI의 랩 컬럼(테두리/패딩)은 알 수 없으므로 끝에서 멈추고, 이후
// 실제 커서 재동기화가 올바른 줄/칸으로 옮긴다.
export const advanceImeAnchor = (
  prev: ImeAnchor,
  committedText: string,
  wrapWidth: number,
): ImeAnchor => {
  const advanced = prev.left + imeTextCells(committedText) * prev.cellW;
  const maxLeft = wrapWidth - prev.cellW * 2;
  return { ...prev, left: Math.min(advanced, Math.max(prev.left, maxLeft)) };
};

// 조합 중 앵커 재동기화 가능 시점 판정:
// 커밋을 PTY로 보낸 뒤 렌더가 한 번 이상 일어났고(에코가 화면에 반영됨),
// 마지막 렌더로부터 quietMs 이상 지나 리드로우가 끝났을 때만 true.
// 에코가 아직 안 왔거나 TUI가 계속 그리는 중(스트리밍)이면 얼린 채 둔다.
export const shouldResyncImeAnchor = (
  now: number,
  lastRenderAt: number,
  lastPtySendAt: number,
  quietMs: number,
): boolean => {
  if (lastRenderAt <= lastPtySendAt) return false;
  return now - lastRenderAt >= quietMs;
};
