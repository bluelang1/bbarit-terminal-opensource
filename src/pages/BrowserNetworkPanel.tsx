import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, Plus, Send, Trash2, Download, Pencil, RefreshCw } from 'lucide-react';
import {
  filterAndSortPackets,
  packetFacetValues,
  type PacketCacheFilter,
  type PacketSort,
  type PacketStatusFilter,
} from './browserPacketFilter';

// 피들러 스타일 패킷 분석 대시보드 (2026-07 SEO-workbench 리디자인 때 UI가 제거됐던
// 것을 복원). 데이터/제어는 BrowserPage가 window.__BBARIT_BROWSER__에 노출하는
// packets/packet/exchange/composer/autoResponder*/breakpoint* API를 그대로 사용한다 —
// CLI(agent-browser-cli)와 동일한 소스라 UI/CLI가 항상 같은 것을 본다.

type PanelTab = 'network' | 'composer' | 'autoresponder' | 'breakpoints';
type DetailTab = 'overview' | 'headers' | 'body' | 'replay';

type PacketSummary = {
  id: string;
  requestId: string;
  url: string;
  method: string;
  status: number | null;
  statusText: string;
  resourceType: string;
  mimeType: string;
  failed: boolean;
  errorText: string;
  fromDiskCache: boolean;
  startedAt: string;
  durationMs: number | null;
  encodedDataLength: number | null;
};

type ExchangeDetail = {
  url: string;
  request: { method: string; headers: Record<string, string>; postData: string | null; postDataError: string | null; initiator: string; startedAt: string };
  response: { status: number | null; statusText: string; headers: Record<string, string>; mimeType: string; protocol: string; remoteIPAddress: string; fromDiskCache: boolean; body: string | null; bodyBase64Encoded: boolean; bodyError: string | null; durationMs: number | null; encodedDataLength: number | null };
  failed: boolean;
  errorText: string;
  replay: { fetch: string; curl: string };
};

type ComposerResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  url: string;
  durationMs: number;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
};

type ComposerHistoryEntry = {
  id: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  result: ComposerResult;
};

type ResponderRule = {
  id: string;
  enabled: boolean;
  name: string;
  urlPattern: string;
  isRegex: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  delayMs: number;
};

type BreakpointRule = {
  id: string;
  enabled: boolean;
  name: string;
  urlPattern: string;
  isRegex: boolean;
  phase: 'request' | 'response' | 'both';
};

type PausedRequest = {
  requestId: string;
  url: string;
  method: string;
  stage: 'request' | 'response';
} | null;

const AR_STORE = 'bbarit-browser-autoresponder-rules';
const BP_STORE = 'bbarit-browser-breakpoint-rules';

function api(): any {
  return (window as any).__BBARIT_BROWSER__ || null;
}

function loadRules<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveRules(key: string, rules: unknown[]) {
  try { localStorage.setItem(key, JSON.stringify(rules)); } catch { /* ignore */ }
}

function formatBytes(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '-';
  if (value < 1024) return `${Math.max(0, Math.round(value))}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(2)}MB`;
}

function shortName(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const last = url.pathname.split('/').filter(Boolean).pop();
    return (last || url.hostname) + (url.search ? url.search.slice(0, 24) : '');
  } catch { return rawUrl.slice(0, 80); }
}

function statusClass(packet: { failed: boolean; status: number | null }): string {
  if (packet.failed) return 'failed';
  if (packet.status && packet.status >= 400) return 'warn';
  if (packet.status) return 'ok';
  return '';
}

export default function BrowserNetworkPanel({ locale }: { locale: string }) {
  const ko = locale === 'ko';
  const [tab, setTab] = useState<PanelTab>('network');
  const [packets, setPackets] = useState<PacketSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<ExchangeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState('all');
  const [domainFilter, setDomainFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<PacketStatusFilter>('all');
  const [resourceTypeFilters, setResourceTypeFilters] = useState<string[]>([]);
  const [cacheFilter, setCacheFilter] = useState<PacketCacheFilter>('all');
  const [minDurationMs, setMinDurationMs] = useState('');
  const [minSizeKb, setMinSizeKb] = useState('');
  const [packetSort, setPacketSort] = useState<PacketSort>('newest');
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef<number | null>(null);

  const flash = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 4000);
  }, []);

  // 패킷 목록 폴링: 캡처는 BrowserPage가 내장 WKWebView/WebView2의 네트워크
  // 타이밍을 계속 쌓으므로 여기서는 1초 간격으로 스냅샷만 읽는다.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      const bridge = api();
      if (!bridge?.packets) return;
      try {
        const next: PacketSummary[] = bridge.packets();
        if (alive) setPackets(next.slice().reverse());
      } catch { /* session not attached yet */ }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const facets = useMemo(() => packetFacetValues(packets), [packets]);
  const filteredPackets = useMemo(() => filterAndSortPackets(packets, {
    query: filter,
    method: methodFilter,
    domain: domainFilter,
    status: statusFilter,
    resourceTypes: resourceTypeFilters,
    cache: cacheFilter,
    minDurationMs: Math.max(0, Number(minDurationMs) || 0),
    minSizeBytes: Math.max(0, Number(minSizeKb) || 0) * 1024,
    sort: packetSort,
  }), [packets, filter, methodFilter, domainFilter, statusFilter, resourceTypeFilters, cacheFilter, minDurationMs, minSizeKb, packetSort]);

  const hasActiveFilters = !!filter.trim()
    || methodFilter !== 'all'
    || domainFilter !== 'all'
    || statusFilter !== 'all'
    || resourceTypeFilters.length > 0
    || cacheFilter !== 'all'
    || Number(minDurationMs) > 0
    || Number(minSizeKb) > 0;

  const resetFilters = useCallback(() => {
    setFilter('');
    setMethodFilter('all');
    setDomainFilter('all');
    setStatusFilter('all');
    setResourceTypeFilters([]);
    setCacheFilter('all');
    setMinDurationMs('');
    setMinSizeKb('');
    setPacketSort('newest');
  }, []);

  const toggleResourceType = useCallback((resourceType: string) => {
    setResourceTypeFilters((current) => current.includes(resourceType)
      ? current.filter((type) => type !== resourceType)
      : [...current, resourceType]);
  }, []);

  const selected = useMemo(
    () => filteredPackets.find((p) => p.id === selectedId) || null,
    [filteredPackets, selectedId],
  );

  // 선택 시 exchange(요청+응답 헤더/바디 전체)를 로드.
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let alive = true;
    setDetailLoading(true);
    (async () => {
      try {
        const exchange = await api()?.exchange?.(selected.id);
        if (alive) setDetail(exchange || null);
      } catch {
        if (alive) setDetail(null);
      } finally {
        if (alive) setDetailLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearPackets = useCallback(() => {
    api()?.clearNetwork?.();
    setPackets([]);
    setSelectedId(null);
    setDetail(null);
  }, []);

  const exportHar = useCallback(() => {
    try {
      const har = api()?.har?.();
      if (!har) return;
      const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bbarit-session-${Date.now()}.har`;
      a.click();
      URL.revokeObjectURL(url);
      flash(ko ? 'HAR 파일을 내려받았습니다.' : 'HAR exported.');
    } catch (error) {
      flash(String((error as Error)?.message || error));
    }
  }, [flash, ko]);

  // ── Composer ──────────────────────────────────────────────────────────
  const [composerMethod, setComposerMethod] = useState('GET');
  const [composerUrl, setComposerUrl] = useState('');
  const [composerHeaders, setComposerHeaders] = useState('');
  const [composerBody, setComposerBody] = useState('');
  const [composerResult, setComposerResult] = useState<ComposerResult | null>(null);
  const [composerLoading, setComposerLoading] = useState(false);
  const [composerHistory, setComposerHistory] = useState<ComposerHistoryEntry[]>([]);

  const sendComposer = useCallback(async () => {
    const url = composerUrl.trim();
    if (!url) { flash(ko ? 'URL을 입력하세요.' : 'Enter a URL.'); return; }
    setComposerLoading(true);
    try {
      const result: ComposerResult = await api()?.composer?.({ method: composerMethod, url, headers: composerHeaders, body: composerBody });
      setComposerResult(result);
      setComposerHistory((prev) => [...prev.slice(-19), {
        id: `ch-${Date.now().toString(36)}`,
        method: composerMethod, url, headers: composerHeaders, body: composerBody,
        result,
      }]);
    } catch (error) {
      setComposerResult({ ok: false, url, durationMs: 0, error: String((error as Error)?.message || error) });
    } finally {
      setComposerLoading(false);
    }
  }, [composerBody, composerHeaders, composerMethod, composerUrl, flash, ko]);

  const openInComposer = useCallback((exchange: ExchangeDetail | null, packet: PacketSummary | null) => {
    if (!packet) return;
    setComposerMethod((exchange?.request.method || packet.method || 'GET').toUpperCase());
    setComposerUrl(exchange?.url || packet.url);
    setComposerHeaders(exchange ? Object.entries(exchange.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '');
    setComposerBody(exchange?.request.postData || '');
    setComposerResult(null);
    setTab('composer');
  }, []);

  // Replay: 선택 패킷을 즉시 재전송 (Composer 경로 재사용).
  const [replayRunning, setReplayRunning] = useState(false);
  const [replayResults, setReplayResults] = useState<ComposerResult[]>([]);
  const [replayRepeat, setReplayRepeat] = useState(1);
  const [replayDelayMs, setReplayDelayMs] = useState(150);

  const runReplay = useCallback(async () => {
    if (!detail || !selected) return;
    setReplayRunning(true);
    setReplayResults([]);
    const headers = Object.entries(detail.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    const repeat = Math.max(1, Math.min(50, Math.floor(replayRepeat) || 1));
    const delay = Math.max(0, Math.min(10000, Math.floor(replayDelayMs) || 0));
    try {
      for (let index = 0; index < repeat; index += 1) {
        const result: ComposerResult = await api()?.composer?.({
          method: detail.request.method,
          url: detail.url,
          headers,
          body: detail.request.postData || '',
        });
        setReplayResults((prev) => [...prev, result]);
        if (index < repeat - 1 && delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      setReplayResults((prev) => [...prev, { ok: false, url: detail.url, durationMs: 0, error: String((error as Error)?.message || error) }]);
    } finally {
      setReplayRunning(false);
    }
  }, [detail, replayDelayMs, replayRepeat, selected]);

  // ── AutoResponder ─────────────────────────────────────────────────────
  const [arRules, setArRules] = useState<ResponderRule[]>(() => loadRules<ResponderRule>(AR_STORE));
  const [arActive, setArActive] = useState(false);
  const [editingAr, setEditingAr] = useState<ResponderRule | null>(null);

  // 마운트 시 브릿지의 현재 활성 상태와 동기화 (CLI로 켰을 수도 있다).
  useEffect(() => {
    try {
      const status = api()?.autoResponderStatus?.();
      if (status) {
        setArActive(!!status.active);
        if (Array.isArray(status.rules) && status.rules.length) setArRules(status.rules);
        else if (arRules.length) void api()?.setAutoResponderRules?.(arRules);
      }
    } catch { /* ignore */ }
    try {
      const status = api()?.breakpointStatus?.();
      if (status) {
        setBpActive(!!status.active);
        if (Array.isArray(status.rules) && status.rules.length) setBpRules(status.rules);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyArRules = useCallback((rules: ResponderRule[]) => {
    setArRules(rules);
    saveRules(AR_STORE, rules);
    void api()?.setAutoResponderRules?.(rules);
  }, []);

  const toggleArActive = useCallback((active: boolean) => {
    setArActive(active);
    void api()?.setAutoResponderActive?.(active);
  }, []);

  // ── Breakpoints ───────────────────────────────────────────────────────
  const [bpRules, setBpRules] = useState<BreakpointRule[]>(() => loadRules<BreakpointRule>(BP_STORE));
  const [bpActive, setBpActive] = useState(false);
  const [editingBp, setEditingBp] = useState<BreakpointRule | null>(null);
  const [paused, setPaused] = useState<PausedRequest>(null);

  // Paused 요청 폴링 (breakpoints 탭이 아닐 때도 배지로 보여야 한다).
  useEffect(() => {
    const timer = window.setInterval(() => {
      try {
        const status = api()?.breakpointStatus?.();
        setPaused(status?.paused ? { requestId: status.paused.requestId, url: status.paused.url, method: status.paused.method, stage: status.paused.stage } : null);
      } catch { /* ignore */ }
    }, 800);
    return () => window.clearInterval(timer);
  }, []);

  const applyBpRules = useCallback((rules: BreakpointRule[]) => {
    setBpRules(rules);
    saveRules(BP_STORE, rules);
    void api()?.setBreakpointRules?.(rules);
  }, []);

  const toggleBpActive = useCallback((active: boolean) => {
    setBpActive(active);
    void api()?.setBreakpointActive?.(active);
  }, []);

  // ── 렌더 ─────────────────────────────────────────────────────────────
  const renderNetwork = () => (
    <div className="bnp-network">
      <div className="bnp-list">
        <div className="bnp-list-toolbar">
          <input
            className="bnp-filter-search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={ko ? '검색 · domain:naver.com · status:5xx · -ads' : 'Search · domain:naver.com · status:5xx · -ads'}
            title={ko ? '공백은 AND, -단어는 제외. method:, type:, domain:, status:, mime:, is:cached 지원' : 'Spaces are AND; -term excludes. Supports method:, type:, domain:, status:, mime:, is:cached'}
            spellCheck={false}
          />
          <button type="button" title={ko ? 'HAR 내보내기' : 'Export HAR'} onClick={exportHar}><Download size={13} /></button>
          <button type="button" title={ko ? '패킷 지우기' : 'Clear packets'} onClick={clearPackets}><Trash2 size={13} /></button>
        </div>
        <div className="bnp-filter-controls">
          <select aria-label={ko ? '메서드 필터' : 'Method filter'} value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
            <option value="all">{ko ? '모든 메서드' : 'All methods'}</option>
            {facets.methods.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
          <select aria-label={ko ? '도메인 필터' : 'Domain filter'} value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}>
            <option value="all">{ko ? '모든 도메인' : 'All domains'}</option>
            {facets.domains.map((domain) => <option key={domain} value={domain}>{domain}</option>)}
          </select>
          <select aria-label={ko ? '상태 필터' : 'Status filter'} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PacketStatusFilter)}>
            <option value="all">{ko ? '모든 상태' : 'All statuses'}</option>
            <option value="success">2xx</option>
            <option value="redirect">3xx</option>
            <option value="client-error">4xx</option>
            <option value="server-error">5xx</option>
            <option value="failed">{ko ? '오류 전체' : 'All errors'}</option>
            <option value="unknown">{ko ? '상태 없음' : 'No status'}</option>
          </select>
          <select aria-label={ko ? '캐시 필터' : 'Cache filter'} value={cacheFilter} onChange={(e) => setCacheFilter(e.target.value as PacketCacheFilter)}>
            <option value="all">{ko ? '캐시 전체' : 'Any cache'}</option>
            <option value="cached">{ko ? '캐시됨' : 'Cached'}</option>
            <option value="network">{ko ? '네트워크' : 'Network'}</option>
          </select>
          <label className="bnp-filter-number"><span>≥ ms</span><input aria-label={ko ? '최소 응답 시간' : 'Minimum duration'} type="number" min={0} value={minDurationMs} onChange={(e) => setMinDurationMs(e.target.value)} placeholder="0" /></label>
          <label className="bnp-filter-number"><span>≥ KB</span><input aria-label={ko ? '최소 크기' : 'Minimum size'} type="number" min={0} value={minSizeKb} onChange={(e) => setMinSizeKb(e.target.value)} placeholder="0" /></label>
          <select aria-label={ko ? '정렬' : 'Sort'} value={packetSort} onChange={(e) => setPacketSort(e.target.value as PacketSort)}>
            <option value="newest">{ko ? '최신순' : 'Newest'}</option>
            <option value="oldest">{ko ? '오래된순' : 'Oldest'}</option>
            <option value="slowest">{ko ? '느린순' : 'Slowest'}</option>
            <option value="largest">{ko ? '큰순' : 'Largest'}</option>
            <option value="status">{ko ? '상태순' : 'Status'}</option>
          </select>
        </div>
        <div className="bnp-filter-chips">
          {facets.resourceTypes.map((resourceType) => (
            <button
              key={resourceType}
              type="button"
              className={resourceTypeFilters.includes(resourceType) ? 'active' : ''}
              aria-pressed={resourceTypeFilters.includes(resourceType)}
              onClick={() => toggleResourceType(resourceType)}
            >{resourceType}</button>
          ))}
          <span className="bnp-filter-count">{filteredPackets.length}/{packets.length}</span>
          <button type="button" className="bnp-filter-reset" disabled={!hasActiveFilters && packetSort === 'newest'} onClick={resetFilters}>{ko ? '필터 초기화' : 'Reset'}</button>
        </div>
        <div className="bnp-rows">
          {filteredPackets.length === 0 && <div className="bnp-empty">{packets.length > 0
            ? (ko ? '현재 필터와 일치하는 패킷이 없습니다.' : 'No packets match the current filters.')
            : (ko ? '캡처된 패킷이 없습니다 — 페이지를 이동하면 여기 쌓입니다.' : 'No packets captured yet — navigate to collect traffic.')}</div>}
          {filteredPackets.map((packet) => (
            <button
              key={packet.id}
              type="button"
              className={'bnp-row' + (selectedId === packet.id ? ' selected' : '')}
              onClick={() => { setSelectedId(packet.id); setDetailTab('overview'); }}
              title={packet.url}
            >
              <span className={'bnp-status ' + statusClass(packet)}>{packet.failed ? 'ERR' : packet.status || '…'}</span>
              <span className="bnp-method">{packet.method || 'GET'}</span>
              <span className="bnp-name">{shortName(packet.url)}</span>
              <span className="bnp-meta">{packet.resourceType || '-'}</span>
              <span className="bnp-meta">{packet.durationMs != null ? `${packet.durationMs}ms` : '-'}</span>
              <span className="bnp-meta">{formatBytes(packet.encodedDataLength)}</span>
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <div className="bnp-detail">
          <div className="bnp-detail-head">
            <strong title={selected.url}>{selected.method || 'GET'} {shortName(selected.url)}</strong>
            <button type="button" onClick={() => openInComposer(detail, selected)} title="Composer"><Send size={12} /> Composer</button>
          </div>
          <div className="bnp-detail-tabs" role="tablist">
            {(['overview', 'headers', 'body', 'replay'] as DetailTab[]).map((t) => (
              <button key={t} type="button" className={detailTab === t ? 'active' : ''} onClick={() => setDetailTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
          {detailLoading && <div className="bnp-empty"><Loader2 size={14} className="bnp-spin" /> {ko ? '불러오는 중…' : 'Loading…'}</div>}
          {!detailLoading && detailTab === 'overview' && (
            <dl className="bnp-dl">
              <dt>URL</dt><dd>{detail?.url || selected.url}</dd>
              <dt>Status</dt><dd>{selected.failed ? (selected.errorText || 'Failed') : `${selected.status ?? '-'} ${selected.statusText || ''}`}</dd>
              <dt>Type</dt><dd>{selected.resourceType || '-'}{selected.mimeType ? ` (${selected.mimeType})` : ''}</dd>
              <dt>Remote</dt><dd>{detail?.response.remoteIPAddress || '-'}{detail?.response.protocol ? ` · ${detail.response.protocol}` : ''}</dd>
              <dt>Timing</dt><dd>{selected.durationMs != null ? `${selected.durationMs}ms` : '-'} · {formatBytes(selected.encodedDataLength)}{selected.fromDiskCache ? (ko ? ' · 캐시' : ' · cache') : ''}</dd>
              <dt>Started</dt><dd>{selected.startedAt}</dd>
            </dl>
          )}
          {!detailLoading && detailTab === 'headers' && (
            <>
              <div className="bnp-section"><span>Request Headers</span><pre>{JSON.stringify(detail?.request.headers || {}, null, 2)}</pre></div>
              <div className="bnp-section"><span>Response Headers</span><pre>{JSON.stringify(detail?.response.headers || {}, null, 2)}</pre></div>
            </>
          )}
          {!detailLoading && detailTab === 'body' && (
            <>
              <div className="bnp-section"><span>Request Body</span><pre>{detail?.request.postDataError || detail?.request.postData || (ko ? '요청 바디 없음' : 'No request body')}</pre></div>
              <div className="bnp-section"><span>Response Body {detail?.response.bodyBase64Encoded ? '(base64)' : ''}</span><pre>{detail?.response.bodyError || detail?.response.body || (ko ? '응답 바디 없음/로드 불가' : 'No body or unavailable')}</pre></div>
            </>
          )}
          {!detailLoading && detailTab === 'replay' && (
            <div className="bnp-replay">
              <div className="bnp-replay-controls">
                <label><span>Repeat</span><input type="number" min={1} max={50} value={replayRepeat} onChange={(e) => setReplayRepeat(Number(e.target.value))} /></label>
                <label><span>Delay ms</span><input type="number" min={0} max={10000} value={replayDelayMs} onChange={(e) => setReplayDelayMs(Number(e.target.value))} /></label>
                <button type="button" className="primary" disabled={replayRunning || !detail} onClick={() => { void runReplay(); }}>
                  {replayRunning ? <Loader2 size={13} className="bnp-spin" /> : <Play size={13} />} Run
                </button>
              </div>
              {detail?.replay?.curl && <div className="bnp-section"><span>curl</span><pre>{detail.replay.curl}</pre></div>}
              {replayResults.map((result, index) => (
                <div key={index} className={'bnp-replay-result ' + (result.ok ? 'ok' : 'failed')}>
                  <strong>#{index + 1} {result.status || 'ERR'} {result.statusText || result.error || ''}</strong>
                  <span>{result.durationMs}ms {result.contentType || ''}</span>
                  {result.body && <pre>{result.body.slice(0, 4000)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderComposer = () => (
    <div className="bnp-composer">
      <div className="bnp-composer-form">
        <div className="bnp-composer-row">
          <label className="bnp-field bnp-field-method">
            <span>Method</span>
            <select value={composerMethod} onChange={(e) => setComposerMethod(e.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="bnp-field bnp-field-grow">
            <span>URL</span>
            <input value={composerUrl} onChange={(e) => setComposerUrl(e.target.value)} placeholder="https://api.example.com/items" spellCheck={false} />
          </label>
        </div>
        <label className="bnp-field">
          <span>Headers (JSON {ko ? '또는' : 'or'} Name: value)</span>
          <textarea value={composerHeaders} onChange={(e) => setComposerHeaders(e.target.value)} spellCheck={false} placeholder={'Content-Type: application/json\nAuthorization: Bearer token'} />
        </label>
        <label className="bnp-field">
          <span>Body</span>
          <textarea value={composerBody} onChange={(e) => setComposerBody(e.target.value)} spellCheck={false} placeholder='{"key":"value"}' />
        </label>
        <div className="bnp-actions">
          <button type="button" onClick={() => { setComposerMethod('GET'); setComposerUrl(''); setComposerHeaders(''); setComposerBody(''); setComposerResult(null); }}>Reset</button>
          <button type="button" className="primary" disabled={composerLoading} onClick={() => { void sendComposer(); }}>
            {composerLoading ? <Loader2 size={13} className="bnp-spin" /> : <Send size={13} />} Send
          </button>
        </div>
      </div>
      <div className="bnp-composer-result">
        {composerResult ? (
          <>
            <div className="bnp-detail-head">
              <span className={'bnp-status ' + (composerResult.ok ? 'ok' : (composerResult.status || 0) >= 400 ? 'warn' : 'failed')}>{composerResult.status || 'ERR'}</span>
              <strong>{composerResult.statusText || composerResult.error || ''}</strong>
              <em>{composerResult.durationMs}ms</em>
            </div>
            <div className="bnp-section"><span>Response Headers</span><pre>{JSON.stringify(composerResult.headers || {}, null, 2)}</pre></div>
            <div className="bnp-section"><span>Response Body</span><pre>{composerResult.body || composerResult.error || '(empty)'}</pre></div>
          </>
        ) : <div className="bnp-empty">{ko ? '요청을 구성하고 Send를 누르세요.' : 'Build a request and click Send.'}</div>}
        {composerHistory.length > 0 && (
          <div className="bnp-history">
            <div className="bnp-subheader"><span>History ({composerHistory.length})</span><button type="button" onClick={() => setComposerHistory([])}>Clear</button></div>
            {composerHistory.slice().reverse().map((entry) => (
              <button key={entry.id} type="button" className="bnp-row" title={entry.url}
                onClick={() => { setComposerMethod(entry.method); setComposerUrl(entry.url); setComposerHeaders(entry.headers); setComposerBody(entry.body); setComposerResult(entry.result); }}>
                <span className={'bnp-status ' + (entry.result.ok ? 'ok' : (entry.result.status || 0) >= 400 ? 'warn' : 'failed')}>{entry.result.status || 'ERR'}</span>
                <span className="bnp-method">{entry.method}</span>
                <span className="bnp-name">{shortName(entry.url)}</span>
                <span className="bnp-meta">{entry.result.durationMs}ms</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderAutoResponder = () => (
    <div className="bnp-rules">
      <div className="bnp-rules-toolbar">
        <label className="bnp-check">
          <input type="checkbox" checked={arActive} onChange={(e) => toggleArActive(e.target.checked)} />
          <span>Active</span>
        </label>
        <button type="button" onClick={() => setEditingAr({ id: `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, enabled: true, name: '', urlPattern: 'https://api.example.com/*', isRegex: false, status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, body: '{"mock":true}', delayMs: 0 })}>
          <Plus size={13} /> {ko ? '규칙 추가' : 'Add rule'}
        </button>
      </div>
      {editingAr && (
        <div className="bnp-rule-editor">
          <div className="bnp-composer-row">
            <label className="bnp-field bnp-field-grow"><span>Name</span><input value={editingAr.name} onChange={(e) => setEditingAr({ ...editingAr, name: e.target.value })} placeholder="Mock API" /></label>
            <label className="bnp-field bnp-field-narrow"><span>Status</span><input type="number" value={editingAr.status} onChange={(e) => setEditingAr({ ...editingAr, status: Math.max(100, Math.min(599, Number(e.target.value) || 200)) })} /></label>
            <label className="bnp-field bnp-field-narrow"><span>Delay ms</span><input type="number" min={0} max={30000} value={editingAr.delayMs} onChange={(e) => setEditingAr({ ...editingAr, delayMs: Math.max(0, Math.min(30000, Number(e.target.value) || 0)) })} /></label>
          </div>
          <label className="bnp-field"><span>URL Pattern (* = any, ? = one char)</span><input value={editingAr.urlPattern} onChange={(e) => setEditingAr({ ...editingAr, urlPattern: e.target.value })} spellCheck={false} /></label>
          <div className="bnp-composer-row">
            <label className="bnp-check"><input type="checkbox" checked={editingAr.isRegex} onChange={(e) => setEditingAr({ ...editingAr, isRegex: e.target.checked })} /><span>Regex</span></label>
            <label className="bnp-check"><input type="checkbox" checked={editingAr.enabled} onChange={(e) => setEditingAr({ ...editingAr, enabled: e.target.checked })} /><span>Enabled</span></label>
          </div>
          <label className="bnp-field"><span>Content-Type</span><input value={editingAr.headers['Content-Type'] || editingAr.headers['content-type'] || ''} onChange={(e) => setEditingAr({ ...editingAr, headers: { ...editingAr.headers, 'Content-Type': e.target.value } })} /></label>
          <label className="bnp-field"><span>Body</span><textarea value={editingAr.body} onChange={(e) => setEditingAr({ ...editingAr, body: e.target.value })} spellCheck={false} /></label>
          <div className="bnp-actions">
            <button type="button" onClick={() => setEditingAr(null)}>Cancel</button>
            <button type="button" className="primary" onClick={() => {
              if (!editingAr.urlPattern.trim()) return;
              const exists = arRules.some((r) => r.id === editingAr.id);
              applyArRules(exists ? arRules.map((r) => (r.id === editingAr.id ? editingAr : r)) : [...arRules, editingAr]);
              setEditingAr(null);
            }}>{ko ? '저장' : 'Save rule'}</button>
          </div>
        </div>
      )}
      <div className="bnp-rows">
        {arRules.length === 0 && <div className="bnp-empty">{ko ? '규칙이 없습니다. 규칙을 추가하면 응답을 목킹합니다.' : 'No rules. Add a rule to mock responses.'}</div>}
        {arRules.map((rule) => (
          <div key={rule.id} className="bnp-rule-row">
            <input type="checkbox" checked={rule.enabled} onChange={(e) => applyArRules(arRules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))} />
            <span className={'bnp-status ' + (rule.enabled ? 'ok' : '')}>{rule.status}</span>
            <span className="bnp-method">{rule.isRegex ? 'regex' : 'wildcard'}</span>
            <span className="bnp-name">{rule.name || rule.urlPattern}</span>
            <button type="button" title={ko ? '수정' : 'Edit'} onClick={() => setEditingAr(rule)}><Pencil size={13} /></button>
            <button type="button" title={ko ? '삭제' : 'Delete'} onClick={() => applyArRules(arRules.filter((r) => r.id !== rule.id))}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );

  const renderBreakpoints = () => (
    <div className="bnp-rules">
      <div className="bnp-rules-toolbar">
        <label className="bnp-check">
          <input type="checkbox" checked={bpActive} onChange={(e) => toggleBpActive(e.target.checked)} />
          <span>Active</span>
        </label>
        <button type="button" onClick={() => setEditingBp({ id: `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, enabled: true, name: '', urlPattern: '', isRegex: false, phase: 'request' })}>
          <Plus size={13} /> {ko ? '규칙 추가' : 'Add rule'}
        </button>
      </div>
      {paused && (
        <div className="bnp-paused">
          <div className="bnp-paused-head">
            <strong>{ko ? '일시정지된 요청' : 'Paused request'} ({paused.stage})</strong>
            <span className="bnp-method">{paused.method}</span>
          </div>
          <div className="bnp-paused-url">{paused.url}</div>
          <div className="bnp-actions">
            <button type="button" className="primary" onClick={() => { void api()?.resumeBreakpoint?.(); }}>Resume</button>
            <button type="button" onClick={() => { void api()?.abortBreakpoint?.(); }}>Abort</button>
          </div>
        </div>
      )}
      {editingBp && (
        <div className="bnp-rule-editor">
          <label className="bnp-field"><span>Name</span><input value={editingBp.name} onChange={(e) => setEditingBp({ ...editingBp, name: e.target.value })} /></label>
          <label className="bnp-field"><span>URL Pattern (e.g. *api.example.com/*)</span><input value={editingBp.urlPattern} onChange={(e) => setEditingBp({ ...editingBp, urlPattern: e.target.value })} spellCheck={false} /></label>
          <div className="bnp-composer-row">
            <label className="bnp-check"><input type="checkbox" checked={editingBp.isRegex} onChange={(e) => setEditingBp({ ...editingBp, isRegex: e.target.checked })} /><span>Regex</span></label>
            <label className="bnp-field bnp-field-narrow">
              <span>Phase</span>
              <select value={editingBp.phase} onChange={(e) => setEditingBp({ ...editingBp, phase: e.target.value as BreakpointRule['phase'] })}>
                <option value="request">Before request</option>
                <option value="response">After response</option>
                <option value="both">Both</option>
              </select>
            </label>
          </div>
          <div className="bnp-actions">
            <button type="button" onClick={() => setEditingBp(null)}>Cancel</button>
            <button type="button" className="primary" onClick={() => {
              if (!editingBp.urlPattern.trim()) return;
              const exists = bpRules.some((r) => r.id === editingBp.id);
              applyBpRules(exists ? bpRules.map((r) => (r.id === editingBp.id ? editingBp : r)) : [...bpRules, editingBp]);
              setEditingBp(null);
            }}>{ko ? '저장' : 'Save'}</button>
          </div>
        </div>
      )}
      <div className="bnp-rows">
        {bpRules.length === 0 && <div className="bnp-empty">{ko ? '규칙이 없습니다. 규칙을 추가하면 매칭 요청이 일시정지됩니다.' : 'No rules. Add a rule to pause matching requests.'}</div>}
        {bpRules.map((rule) => (
          <div key={rule.id} className="bnp-rule-row">
            <input type="checkbox" checked={rule.enabled} onChange={(e) => applyBpRules(bpRules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r)))} />
            <span className={'bnp-status ' + (rule.enabled ? 'ok' : '')}>{rule.phase}</span>
            <span className="bnp-method">{rule.isRegex ? 'regex' : 'wildcard'}</span>
            <span className="bnp-name">{rule.name || rule.urlPattern}</span>
            <button type="button" title={ko ? '수정' : 'Edit'} onClick={() => setEditingBp(rule)}><Pencil size={13} /></button>
            <button type="button" title={ko ? '삭제' : 'Delete'} onClick={() => applyBpRules(bpRules.filter((r) => r.id !== rule.id))}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="bnp-root">
      <div className="bnp-tabs" role="tablist" aria-label={ko ? '패킷 분석 탭' : 'Packet analysis tabs'}>
        {([
          ['network', `Network (${packets.length})`],
          ['composer', 'Composer'],
          ['autoresponder', `AutoResponder${arActive ? ' ●' : ''}`],
          ['breakpoints', `Breakpoints${paused ? ' ⏸' : bpActive ? ' ●' : ''}`],
        ] as [PanelTab, string][]).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span className="bnp-tabs-spacer" />
        {notice && <span className="bnp-notice">{notice}</span>}
        <button type="button" className="bnp-refresh" title={ko ? '새로고침' : 'Refresh'} onClick={() => setPackets((api()?.packets?.() || []).slice().reverse())}><RefreshCw size={13} /></button>
      </div>
      <div className="bnp-body">
        {tab === 'network' && renderNetwork()}
        {tab === 'composer' && renderComposer()}
        {tab === 'autoresponder' && renderAutoResponder()}
        {tab === 'breakpoints' && renderBreakpoints()}
      </div>
    </div>
  );
}
