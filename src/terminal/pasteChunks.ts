// 붙여넣기 쓰기 공통 규칙. 사람 붙여넣기(XTerminal writePasteChunked)와 자동 입력 게이트
// (inputGate.queueAutoInput)가 같이 쓴다. 설계: docs/AGENT_INPUT_GATE.md

// Bracketed paste mode: wrap pasted text with escape sequences so shells (bash, zsh, fish)
// handle multi-line paste correctly instead of executing each line immediately.
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

// Write large paste data in chunks to avoid shell buffer overflow.
// Most terminal PTY buffers handle ~4KB at a time reliably.
export const PASTE_CHUNK_SIZE = 4096;
export const PASTE_CHUNK_DELAY_MS = 5;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 텍스트를 size 글자 단위로 자른다. 서로게이트 페어(이모지 등) 한가운데서 자르면 IPC
 * 직렬화에서 U+FFFD 로 깨지므로, 경계가 high surrogate 뒤면 한 글자 앞에서 자른다.
 */
export function splitPasteChunks(text: string, size: number = PASTE_CHUNK_SIZE): string[] {
  if (!text) return [];
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; ) {
    let end = Math.min(i + size, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff && end - 1 > i) end -= 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/** 붙여넣기 본문 안의 종료 마커를 지운다 — 남아 있으면 붙여넣기가 중간에 끝난다. */
export function stripBracketedPasteEnd(text: string): string {
  return text.split(BRACKETED_PASTE_END).join('');
}

export async function writePasteChunked(
  writeFn: (data: string) => void,
  text: string,
  useBracketedPaste = true,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  if (!text) return;
  if (useBracketedPaste) {
    writeFn(BRACKETED_PASTE_START);
    await sleep(PASTE_CHUNK_DELAY_MS);
  }

  const chunks = splitPasteChunks(text);
  if (chunks.length === 1) {
    writeFn(chunks[0]);
  } else {
    for (const chunk of chunks) {
      writeFn(chunk);
      await sleep(PASTE_CHUNK_DELAY_MS);
    }
  }

  // Do not append the bracketed-paste terminator in the same event-loop turn as
  // the final payload chunk. Some PTY/WebView backends coalesce fast writes and
  // interactive terminal apps can consume the end marker before the last bytes,
  // which made the tail of pasted Korean/long text disappear.
  await sleep(PASTE_CHUNK_DELAY_MS);

  if (useBracketedPaste) writeFn(BRACKETED_PASTE_END);
}
