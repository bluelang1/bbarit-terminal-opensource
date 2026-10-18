import { describe, expect, it } from 'vitest';
import {
  CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION,
  NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION,
  NATIVE_NETWORK_TIMING_EXPRESSION,
  capturedExchangeToRecordPatch,
  capturedNetworkRecordId,
  headerPairsToMap,
  nativeNetworkMimeType,
  nativeNetworkRecordId,
  nativeNetworkResourceType,
  type NativeCapturedExchange,
} from './browserNativeNetwork';

describe('embedded WebView network timing capture', () => {
  it('collects navigation and resource timing entries and honors clear', () => {
    expect(NATIVE_NETWORK_TIMING_EXPRESSION).toContain("getEntriesByType('navigation')");
    expect(NATIVE_NETWORK_TIMING_EXPRESSION).toContain("getEntriesByType('resource')");
    expect(NATIVE_NETWORK_TIMING_EXPRESSION).toContain('__BBARIT_NETWORK_CLEAR_AT__');
    expect(CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION).toContain('clearResourceTimings');
  });

  it('maps browser initiators to packet resource types', () => {
    expect(nativeNetworkResourceType({ navigation: true, initiatorType: 'navigation' })).toBe('Document');
    expect(nativeNetworkResourceType({ navigation: false, initiatorType: 'fetch' })).toBe('Fetch');
    expect(nativeNetworkResourceType({ navigation: false, initiatorType: 'xmlhttprequest' })).toBe('XHR');
    expect(nativeNetworkResourceType({ navigation: false, initiatorType: 'link' })).toBe('Stylesheet');
  });

  it('infers common MIME types and generates stable tab-scoped ids', () => {
    expect(nativeNetworkMimeType('https://cdn.example.com/app.js?v=1')).toBe('text/javascript');
    expect(nativeNetworkMimeType('https://cdn.example.com/logo.webp')).toBe('image/webp');
    const entry = { key: 'res:10:0:https://example.com/app.js' };
    expect(nativeNetworkRecordId(3, 1000, entry)).toBe(nativeNetworkRecordId(3, 1000, entry));
    expect(nativeNetworkRecordId(4, 1000, entry)).not.toBe(nativeNetworkRecordId(3, 1000, entry));
    expect(nativeNetworkRecordId(3, 1000, entry)).toMatch(/^wv-/);
  });
});

describe('embedded WebView fetch/XHR body capture', () => {
  const exchange = (patch: Partial<NativeCapturedExchange> = {}): NativeCapturedExchange => ({
    seq: 7,
    kind: 'fetch',
    url: 'https://api.example.com/items',
    method: 'POST',
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_000_250,
    status: 200,
    statusText: 'OK',
    requestHeaders: [['Content-Type', 'application/json']],
    responseHeaders: [['content-type', 'application/json; charset=utf-8']],
    postData: '{"name":"octo"}',
    postDataNote: '',
    body: '{"ok":true}',
    bodyNote: '',
    mimeType: 'application/json',
    failed: false,
    errorText: '',
    ...patch,
  });

  it('drains and clears the capture buffer that the clear command also resets', () => {
    expect(NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION).toContain('__BBARIT_NETWORK_CAPTURE__');
    expect(NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION).toContain('splice(0)');
    expect(CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION).toContain('__BBARIT_NETWORK_CAPTURE__');
  });

  it('builds ids outside the wv- timing namespace so richer records replace timing ones', () => {
    expect(capturedNetworkRecordId(3, 'abc-1', 7)).toBe('wf-3-abc-1-7');
    expect(capturedNetworkRecordId(3, '', 7)).toBe('wf-3-boot-7');
    expect(capturedNetworkRecordId(3, 'abc-1', 7).startsWith('wv-')).toBe(false);
  });

  it('folds duplicate header pairs and ignores malformed ones', () => {
    expect(headerPairsToMap([['Accept', 'text/html'], ['accept-language', 'ko'], ['Accept', 'application/json']]))
      .toEqual({ Accept: 'text/html, application/json', 'accept-language': 'ko' });
    expect(headerPairsToMap([['', 'dropped'], ['ok'], 'junk', null])).toEqual({});
    expect(headerPairsToMap(undefined)).toEqual({});
  });

  it('maps a captured exchange onto the packet record shape with bodies present', () => {
    const patch = capturedExchangeToRecordPatch(exchange());
    expect(patch.resourceType).toBe('Fetch');
    expect(patch.method).toBe('POST');
    expect(patch.status).toBe(200);
    expect(patch.postData).toBe('{"name":"octo"}');
    expect(patch.postDataError).toBeUndefined();
    expect(patch.body).toBe('{"ok":true}');
    expect(patch.bodyError).toBeUndefined();
    expect(patch.mimeType).toBe('application/json');
    expect(patch.requestHeaders).toEqual({ 'Content-Type': 'application/json' });
    expect(patch.startedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(patch.finishedAtMs).toBe(1_700_000_000_250);
  });

  it('keeps empty bodies as empty strings so the CDP fallback never fires', () => {
    const patch = capturedExchangeToRecordPatch(exchange({ method: 'GET', postData: '', body: '' }));
    expect(patch.postData).toBe('');
    expect(patch.body).toBe('');
    expect(patch.postDataError).toBeUndefined();
    expect(patch.bodyError).toBeUndefined();
  });

  it('surfaces capture notes as body errors and failures as failed records', () => {
    const patch = capturedExchangeToRecordPatch(exchange({
      kind: 'xhr',
      status: 0,
      failed: true,
      errorText: 'network error or aborted',
      postDataNote: '[binary request body: 128 bytes]',
      bodyNote: '[non-text response body was not captured: image/png]',
      postData: '',
      body: '',
    }));
    expect(patch.resourceType).toBe('XHR');
    expect(patch.status).toBeUndefined();
    expect(patch.failed).toBe(true);
    expect(patch.errorText).toBe('network error or aborted');
    expect(patch.postDataError).toBe('[binary request body: 128 bytes]');
    expect(patch.bodyError).toBe('[non-text response body was not captured: image/png]');
  });

  it('falls back to URL-based MIME and clamps finish times to the start', () => {
    const patch = capturedExchangeToRecordPatch(exchange({ mimeType: '', url: 'https://x.example/app.js', finishedAtMs: 1 }));
    expect(patch.mimeType).toBe('text/javascript');
    expect(patch.finishedAtMs).toBe(1_700_000_000_000);
  });
});
