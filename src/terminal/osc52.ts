// OSC 52 clipboard write: "\x1b]52;<selection>;<base64>\x07". xterm의
// registerOscHandler(52)는 "52;" 이후의 페이로드를 넘겨준다. 질의('?')는
// 클립보드 유출 통로라 지원하지 않는다.
export function decodeOsc52Payload(data: string): string | null {
  const payload = data.includes(';') ? data.slice(data.indexOf(';') + 1) : data;
  if (!payload || payload === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text || null;
  } catch {
    return null;
  }
}
