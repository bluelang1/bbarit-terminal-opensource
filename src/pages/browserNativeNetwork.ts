// Cross-platform packet source for the embedded WKWebView/WebView2 browser.
// Resource Timing covers the document plus scripts, styles, images, fetch/XHR,
// fonts, and other resources without an external Chrome/CDP endpoint.

export interface NativeNetworkTimingEntry {
  key: string;
  url: string;
  initiatorType: string;
  startTime: number;
  responseEnd: number;
  duration: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  nextHopProtocol: string;
  responseStatus: number;
  navigation: boolean;
}

export interface NativeNetworkTimingSnapshot {
  timeOrigin: number;
  entries: NativeNetworkTimingEntry[];
}

export const NATIVE_NETWORK_TIMING_EXPRESSION = `(() => {
  const clearAt = Number(window.__BBARIT_NETWORK_CLEAR_AT__ || 0);
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const serialize = (entry, navigation, index) => ({
    key: [navigation ? 'nav' : 'res', Math.round(number(entry.startTime) * 1000), index, String(entry.name || location.href)].join(':'),
    url: String(entry.name || location.href || ''),
    initiatorType: navigation ? 'navigation' : String(entry.initiatorType || 'other'),
    startTime: number(entry.startTime),
    responseEnd: number(entry.responseEnd),
    duration: number(entry.duration),
    transferSize: number(entry.transferSize),
    encodedBodySize: number(entry.encodedBodySize),
    decodedBodySize: number(entry.decodedBodySize),
    nextHopProtocol: String(entry.nextHopProtocol || ''),
    responseStatus: number(entry.responseStatus),
    navigation,
  });
  const entries = [];
  if (clearAt <= 0) {
    const navigation = performance.getEntriesByType('navigation')[0];
    if (navigation) entries.push(serialize(navigation, true, 0));
  }
  performance.getEntriesByType('resource').forEach((entry, index) => {
    if (number(entry.startTime) >= clearAt) entries.push(serialize(entry, false, index));
  });
  return {
    timeOrigin: number(performance.timeOrigin) || (Date.now() - performance.now()),
    entries: entries.slice(-500),
  };
})()`;

export const CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION = `(() => {
  performance.clearResourceTimings();
  window.__BBARIT_NETWORK_CLEAR_AT__ = performance.now();
  if (window.__BBARIT_NETWORK_CAPTURE__) window.__BBARIT_NETWORK_CAPTURE__.entries.length = 0;
  return true;
})()`;

// Body/header capture drained from the fetch/XHR hook that the Rust side
// installs at document start (webview_browser.rs network_capture_script).
// Resource Timing alone never exposes headers or bodies.
export interface NativeCapturedExchange {
  seq: number;
  kind: 'fetch' | 'xhr';
  url: string;
  method: string;
  startedAtMs: number;
  finishedAtMs: number;
  status: number;
  statusText: string;
  requestHeaders: [string, string][];
  responseHeaders: [string, string][];
  postData: string;
  postDataNote: string;
  body: string;
  bodyNote: string;
  mimeType: string;
  failed: boolean;
  errorText: string;
}

export interface NativeCaptureSnapshot {
  token: string;
  entries: NativeCapturedExchange[];
}

export const NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION = `(() => {
  const store = window.__BBARIT_NETWORK_CAPTURE__;
  if (!store) return { token: '', entries: [] };
  return { token: store.token, entries: store.entries.splice(0) };
})()`;

export function capturedNetworkRecordId(tabId: number, token: string, seq: number): string {
  return `wf-${tabId}-${token || 'boot'}-${seq}`;
}

export function headerPairsToMap(pairs: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(pairs)) return map;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const name = String(pair[0] || '').trim();
    if (!name) continue;
    const value = String(pair[1] ?? '');
    map[name] = map[name] ? `${map[name]}, ${value}` : value;
  }
  return map;
}

export interface CapturedRecordPatch {
  url: string;
  method: string;
  status?: number;
  statusText: string;
  resourceType: string;
  mimeType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  postData?: string;
  postDataError?: string;
  body?: string;
  bodyBase64Encoded: boolean;
  bodyError?: string;
  failed: boolean;
  errorText: string;
  initiator: string;
  startedAt: string;
  startedAtMs: number;
  finishedAt: string;
  finishedAtMs: number;
}

export function capturedExchangeToRecordPatch(entry: NativeCapturedExchange): CapturedRecordPatch {
  const startedAtMs = Number(entry.startedAtMs) || Date.now();
  const finishedAtMs = Math.max(startedAtMs, Number(entry.finishedAtMs) || startedAtMs);
  const status = Number(entry.status) > 0 ? Number(entry.status) : undefined;
  const postData = String(entry.postData || '');
  const body = String(entry.body || '');
  return {
    url: String(entry.url || ''),
    method: String(entry.method || 'GET').toUpperCase(),
    status,
    statusText: String(entry.statusText || ''),
    resourceType: entry.kind === 'xhr' ? 'XHR' : 'Fetch',
    mimeType: String(entry.mimeType || '') || nativeNetworkMimeType(entry.url),
    requestHeaders: headerPairsToMap(entry.requestHeaders),
    responseHeaders: headerPairsToMap(entry.responseHeaders),
    // Empty strings (not undefined) keep the on-demand CDP body fetch from
    // firing on macOS, where it can only fail. The panel renders its own
    // "no body" placeholder for empty values.
    postData,
    postDataError: String(entry.postDataNote || '') || undefined,
    body,
    bodyBase64Encoded: false,
    bodyError: String(entry.bodyNote || '') || undefined,
    failed: !!entry.failed,
    errorText: String(entry.errorText || ''),
    initiator: entry.kind === 'xhr' ? 'xmlhttprequest' : 'fetch',
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    finishedAt: new Date(finishedAtMs).toISOString(),
    finishedAtMs,
  };
}

export function nativeNetworkResourceType(entry: Pick<NativeNetworkTimingEntry, 'navigation' | 'initiatorType'>): string {
  if (entry.navigation) return 'Document';
  const type = String(entry.initiatorType || '').toLowerCase();
  if (type === 'script') return 'Script';
  if (type === 'link' || type === 'css') return 'Stylesheet';
  if (type === 'img' || type === 'image' || type === 'svg' || type === 'video' || type === 'audio') return 'Image';
  if (type === 'fetch') return 'Fetch';
  if (type === 'xmlhttprequest' || type === 'xhr') return 'XHR';
  if (type === 'font') return 'Font';
  return type ? type[0].toUpperCase() + type.slice(1) : 'Other';
}

export function nativeNetworkMimeType(url: string): string {
  let path = String(url || '');
  try { path = new URL(path).pathname; } catch { /* keep the raw value */ }
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mime: Record<string, string> = {
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', xml: 'application/xml',
  };
  return mime[ext] || '';
}

export function nativeNetworkRecordId(tabId: number, timeOrigin: number, entry: Pick<NativeNetworkTimingEntry, 'key'>): string {
  let hash = 2166136261;
  const source = `${tabId}:${Math.round(timeOrigin)}:${entry.key}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `wv-${tabId}-${(hash >>> 0).toString(36)}`;
}
