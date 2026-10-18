import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emitTo, listen } from '@tauri-apps/api/event';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { Activity, ArrowLeft, ArrowRight, Bot, ChevronDown, ChevronRight, ChevronUp, Circle, Clock, Code2, Download, File, FileSearch, FlaskConical, Folder, FolderOpen, Globe2, Home, Loader2, PanelBottom, PanelLeft, Plus, RefreshCw, Search, Square, Star, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useTranslation, type Locale } from '../i18n';
import { kvGet, kvSet } from '../hooks/useKV';
import { recordVisit, searchHistory, setBookmark, type HistoryEntry } from './browserHistoryStore';
import { captureSession, restoreSession, sessionAgeLabel, serializeSession, SESSION_KV_KEY, type SessionSnapshot } from './browserSessionRecovery';
import { capabilitiesByGroup, GROUP_LABEL } from './browserAiCapabilities';
import { markOnboardingSeen, parseOnboardingState, serializeOnboardingState, shouldShowOnboarding } from './browserOnboarding';
import { detectBlock, type BlockVerdict } from './browserBlockDetector';
import { defaultProjectRootFromStorage, projectRootLabel, saveProjectRoot, savedProjectUrl, saveProjectUrl } from './browserProjectStorage';
import { classifyOmniboxInput } from './browserOmnibox';
import { DEFAULT_BROWSER_URL, normalizeUrl, requestName } from './browserSeoTarget';
// SEO/GEO skill methodologies imported as raw text so the report generator can use them directly (the report
// injects the skills matching the issues into its prompt). Vendored under src/seo-skills/ so the
// build is self-contained - .claude/skills is gitignored and would break a clean checkout.
import skillOnPage from '../seo-skills/on-page-seo-auditor.md?raw';
import skillTechnical from '../seo-skills/technical-seo-checker.md?raw';
import skillMeta from '../seo-skills/meta-tags-optimizer.md?raw';
import skillSchema from '../seo-skills/schema-markup-generator.md?raw';
import skillGeo from '../seo-skills/geo-content-optimizer.md?raw';
import skillInternalLinks from '../seo-skills/internal-linking-optimizer.md?raw';
import skillContentQuality from '../seo-skills/content-quality-auditor.md?raw';
import skillContentWriter from '../seo-skills/seo-content-writer.md?raw';
import { BrowserAside, ASIDE_MIN_W, asideMaxW, type AsidePane } from './browser/BrowserAside';
import { AsideAgentPane, type AsideAuditEntry, type AsideRecentTask } from './browser/AsideAgentPane';
import { AsideSkillsPane } from './browser/AsideSkillsPane';
import { AsideLoginsPane, type SiteLogin } from './browser/AsideLoginsPane';
import { ChromeImportModal } from './browser/ChromeImportModal';
import { importableCookies, injectCookies, mergeBookmarks, mergeHistory, passwordsToLogins, summarizeImport, type ChromeProfile, type ImportItem, type ImportPayload } from './browser/chromeImport';
import BrowserNetworkPanel from './BrowserNetworkPanel';
import {
  CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION,
  NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION,
  NATIVE_NETWORK_TIMING_EXPRESSION,
  capturedExchangeToRecordPatch,
  capturedNetworkRecordId,
  nativeNetworkMimeType,
  nativeNetworkRecordId,
  nativeNetworkResourceType,
  type NativeCaptureSnapshot,
  type NativeNetworkTimingSnapshot,
} from './browserNativeNetwork';
import './BrowserPage.css';

const MAC_NATIVE_WEBVIEW_TOP_INSET_PX = 36;

// ── 사이드바 확장(Aside 브라우저 문법 이식) ──
// 웹 클리핑(Notes & Clips 패널): 제목·URL·선택 텍스트를 kv로 영속.
interface WebClip { id: string; title: string; url: string; selection: string; at: number }
// 승인 게이트(D17 표시 계층): 결제/게시/전송류 태스크는 사람 승인 후 주입.
const SENSITIVE_TASK_RE = /(pay|purchase|checkout|order|transfer|remit|publish|upload|delete|remove|send|submit|password|sign[ -]?in|log[ -]?in|card|결제|구매|주문|송금|이체|게시|업로드|삭제|전송|제출|비밀번호|로그인|카드)/i;

const nativeWebviewEngineLabel = () => {
  if (typeof navigator === 'undefined') return 'tauri-webview';
  const platform = `${navigator.platform || ''} ${navigator.userAgent || ''}`;
  if (/Windows/i.test(platform)) return 'webview2';
  if (/Mac|iPhone|iPad/i.test(platform)) return 'wkwebview';
  if (/Linux|X11|Wayland/i.test(platform)) return 'webkitgtk';
  return 'tauri-webview';
};

// Map a skill key to its raw SKILL.md and the issue codes it addresses, so the report can pick
// the right methodologies based on what the crawl actually found.
const SEO_SKILLS: { key: string; name: string; md: string; codes: RegExp }[] = [
  { key: 'meta', name: 'meta-tags-optimizer', md: skillMeta, codes: /^(title|meta)/ },
  { key: 'onpage', name: 'on-page-seo-auditor', md: skillOnPage, codes: /^(h1|h2|low-content|img-alt|title-eq-h1)/ },
  { key: 'technical', name: 'technical-seo-checker', md: skillTechnical, codes: /^(status|redirect|canonical|noindex|nofollow|x-robots|broken|crawl-failed|orphan)/ },
  { key: 'schema', name: 'schema-markup-generator', md: skillSchema, codes: /^(no-structured-data)/ },
  { key: 'links', name: 'internal-linking-optimizer', md: skillInternalLinks, codes: /^(orphan)/ },
  { key: 'geo', name: 'geo-content-optimizer', md: skillGeo, codes: /^(no-structured-data|low-content|meta)/ },
  { key: 'quality', name: 'content-quality-auditor', md: skillContentQuality, codes: /^(low-content|title|meta)/ },
];

// skill name -> raw SKILL.md, so the fix prompt can INLINE the actual skill instructions and be
// self-contained - the executing agent runs them directly without locating .claude/skills.
const SKILL_MD_BY_NAME: Record<string, string> = {
  'on-page-seo-auditor': skillOnPage,
  'technical-seo-checker': skillTechnical,
  'meta-tags-optimizer': skillMeta,
  'schema-markup-generator': skillSchema,
  'geo-content-optimizer': skillGeo,
  'internal-linking-optimizer': skillInternalLinks,
  'content-quality-auditor': skillContentQuality,
  'seo-content-writer': skillContentWriter,
};

// Build a self-contained "inlined skills" appendix: the full SKILL.md (bounded) of every skill
// named in `skillNames`, so the fix prompt does not depend on the agent finding skill files.
function seoInlineSkills(skillNames: string[], ko: boolean): string {
  const uniq = Array.from(new Set(skillNames)).filter((n) => SKILL_MD_BY_NAME[n]);
  if (!uniq.length) return '';
  const PER = 3500;
  const head = ko ? '\n\n---\n\n## Inlined skill instructions (self-contained - no need to locate .claude/skills)\nBelow are the full instructions for the skills referenced above. Do not look for files; apply these directly.\n' : '\n\n---\n\n## Inlined skill instructions (self-contained - no need to locate .claude/skills)\nBelow are the full instructions for the skills referenced above. Do not look for files; apply these directly.\n';
  const body = uniq.map((n) => `\n### SKILL: ${n}\n\n${String(SKILL_MD_BY_NAME[n] || '').slice(0, PER)}`).join('\n');
  return head + body;
}

type NavState = { canGoBack: boolean; canGoForward: boolean };
type BrowserTargetPatch = { url?: string; targetId?: string; webSocketDebuggerUrl?: string };
type BrowserConsoleEntry = {
  type: string;
  text: string;
  timestamp: string;
  url?: string;
  line?: number;
  column?: number;
};
type BrowserNetworkEntry = {
  type: 'request' | 'response' | 'failed';
  requestId: string;
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  errorText?: string;
  timestamp: string;
};
type HeaderMap = Record<string, string>;
type BrowserNetworkRecord = {
  id: string;
  requestId: string;
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: string;
  mimeType?: string;
  protocol?: string;
  remoteIPAddress?: string;
  fromDiskCache?: boolean;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: HeaderMap;
  responseHeaders?: HeaderMap;
  postData?: string;
  postDataError?: string;
  startedAt: string;
  startedAtMs: number;
  finishedAt?: string;
  finishedAtMs?: number;
  durationMs?: number;
  encodedDataLength?: number;
  transferSize?: number;
  initiator?: string;
  body?: string;
  bodyBase64Encoded?: boolean;
  bodyError?: string;
};
type BrowserAutoResponderRule = {
  id: string;
  enabled: boolean;
  name?: string;
  urlPattern: string;
  isRegex?: boolean;
  status?: number;
  statusText?: string;
  headers?: HeaderMap;
  body?: string;
  delayMs?: number;
};
type BrowserBreakpointRule = {
  id: string;
  enabled: boolean;
  name?: string;
  urlPattern: string;
  isRegex?: boolean;
  phase?: 'request' | 'response' | 'both';
};
type BrowserPausedBreakpoint = {
  requestId: string;
  networkRequestId?: string;
  url: string;
  method: string;
  stage: 'request' | 'response';
  responseStatusCode?: number;
  responseStatusText?: string;
  resourceType?: string;
  rule: BrowserBreakpointRule;
  pausedAt: string;
};
type BrowserDownloadRecord = {
  guid: string;
  url: string;
  suggestedFilename?: string;
  filePath?: string;
  state: 'started' | 'inProgress' | 'completed' | 'canceled' | 'failed';
  totalBytes?: number;
  receivedBytes?: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
};
type BrowserNetworkConditions = {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
  connectionType: string;
};
// SEO crawl/audit (Screaming Frog-style). Crawls within the same host using the live BBARIT
// Browser engine - every page is fully rendered, so JS-built content is seen.
type SeoIssueLevel = 'error' | 'warning' | 'notice';
type SeoIssue = { level: SeoIssueLevel; code: string; message: string };
// Screaming Frog "Internal" tab groups every internal URL by content type, not just HTML.
type SeoUrlType = 'HTML' | 'CSS' | 'JavaScript' | 'Image' | 'PDF' | 'Other';
type SeoPageAudit = {
  url: string;
  finalUrl: string;
  urlType: SeoUrlType;
  // Crawl depth from the start URL (0 = start). Resource rows inherit the depth of the page
  // that referenced them.
  depth: number;
  status?: number;
  statusText: string;
  contentType: string;
  sizeBytes?: number;
  responseMs?: number;
  // Screaming Frog-style indexability verdict, reflecting status + canonical + robots/x-robots.
  indexabilityStatus: string;
  title: string;
  titleLength: number;
  metaDescription: string;
  metaDescriptionLength: number;
  h1Count: number;
  h1: string;
  h2Count: number;
  canonical: string;
  canonicalType: 'self' | 'other' | 'none';
  robots: string;
  xRobotsTag: string;
  noindex: boolean;
  nofollow: boolean;
  indexable: boolean;
  metaKeywords: string;
  hreflangCount: number;
  hasPagination: boolean;
  structuredDataTypes: string[];
  structuredDataErrors: string[];
  wordCount: number;
  // Link graph metrics (Screaming Frog Inlinks/Outlinks). Outlinks = internal links OUT of this
  // page; Inlinks = internal pages that link TO this page. Unique = distinct source/target URLs.
  outlinks: number;
  uniqueOutlinks: number;
  externalOutlinks: number;
  inlinks: number;
  uniqueInlinks: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  issues: SeoIssue[];
};
type SeoRobotsInfo = {
  fetched: boolean;
  status?: number;
  sitemaps: string[];
  disallowCount: number;
  startAllowed: boolean;
};
type SeoSitemapInfo = {
  url: string; status?: number; urlCount: number; ok: boolean;
  // Deep validation against the crawl: sitemap URLs that are non-indexable / canonicalised, and
  // indexable crawled pages that are MISSING from the sitemap.
  nonIndexableInSitemap: number;
  canonicalisedInSitemap: number;
  missingFromSitemap: number;
};
type SeoReport = {
  generatedAt: string;
  startUrl: string;
  host: string;
  pagesCrawled: number;
  pages: SeoPageAudit[];
  robots?: SeoRobotsInfo;
  sitemaps: SeoSitemapInfo[];
  brokenCount: number;
  summary: { error: number; warning: number; notice: number };
};

// Screaming Frog-style filter tabs: each is a filtered view over the same crawl. `test`
// returns true when a page belongs to that tab; `all` shows everything.
// Classify a URL into a Screaming Frog content bucket from its content-type then extension.
function seoResourceType(url: string, contentType = ''): SeoUrlType {
  const ct = contentType.toLowerCase();
  if (/text\/html|application\/xhtml/.test(ct)) return 'HTML';
  if (/text\/css/.test(ct)) return 'CSS';
  if (/javascript|ecmascript/.test(ct)) return 'JavaScript';
  if (/^image\//.test(ct)) return 'Image';
  if (/application\/pdf/.test(ct)) return 'PDF';
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); } })();
  if (/\.css(\?|$)/.test(path)) return 'CSS';
  if (/\.(m?js|cjs)(\?|$)/.test(path)) return 'JavaScript';
  if (/\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|$)/.test(path)) return 'Image';
  if (/\.pdf(\?|$)/.test(path)) return 'PDF';
  if (/\.html?(\?|$)/.test(path) || !/\.[a-z0-9]{2,5}(\?|$)/.test(path)) return 'HTML';
  return 'Other';
}

// Screaming Frog "Indexability Status": the single reason a URL is (not) indexable, in priority
// order - HTTP status first, then content type, then robots directives, then canonical.
function seoIndexabilityStatus(opts: {
  status?: number; urlType: SeoUrlType; noindex: boolean; xRobots: string; canonicalType: 'self' | 'other' | 'none';
}): string {
  const { status, urlType, noindex, xRobots, canonicalType } = opts;
  if (typeof status === 'number') {
    if (status >= 500) return 'Non-Indexable: Server Error';
    if (status >= 400) return 'Non-Indexable: Client Error';
    if (status >= 300) return 'Non-Indexable: Redirected';
  }
  if (urlType !== 'HTML') return 'Non-Indexable: Non-HTML';
  if (noindex || /noindex/i.test(xRobots)) return 'Non-Indexable: Noindex';
  if (canonicalType === 'other') return 'Non-Indexable: Canonicalised';
  return 'Indexable';
}

// Normalize a URL for self-canonical comparison: lowercase scheme/host, drop default port,
// sort query params, decode where safe, collapse trailing slash, drop hash. So `/a`, `/a/`,
// `HTTP://Host:80/a?b=1&a=2` and `https://host/a?a=2&b=1` compare equal.
function seoCanonUrl(u: string): string {
  try {
    const x = new URL(u);
    const proto = x.protocol.toLowerCase();
    const host = x.hostname.toLowerCase();
    const port = ((proto === 'http:' && x.port === '80') || (proto === 'https:' && x.port === '443')) ? '' : x.port;
    let path = x.pathname || '/';
    try { path = decodeURI(path); } catch { /* keep */ }
    if (path.length > 1) path = path.replace(/\/+$/, '');
    const params = Array.from(x.searchParams.entries()).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const sp = new URLSearchParams();
    params.forEach(([k, v]) => sp.append(k, v));
    const q = sp.toString();
    return `${proto}//${host}${port ? ':' + port : ''}${path}${q ? '?' + q : ''}`;
  } catch { return u; }
}

// robots.txt matcher with Allow/Disallow, `*` wildcard, `$` end-anchor, and PER user-agent groups.
// allows(path, ua) selects the most-specific user-agent group that applies to `ua` (longest agent
// token that is a substring of ua; else the `*` group), then within it longest-pattern-wins with
// Allow beating Disallow on ties (Google's rule). Default ua '*' follows the wildcard group.
type RobotsRule = { allow: boolean; pattern: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
function buildRobotsMatcher(body: string): { allows: (path: string, ua?: string) => boolean; sitemaps: string[]; ruleCount: number } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let cur: RobotsGroup | null = null;
  let expectingAgents = true;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sm = line.match(/^sitemap:\s*(\S+)/i);
    if (sm) { sitemaps.push(sm[1]); continue; }
    const ua = line.match(/^user-agent:\s*(.+)$/i);
    if (ua) {
      if (!cur || !expectingAgents) { cur = { agents: [], rules: [] }; groups.push(cur); expectingAgents = true; }
      cur.agents.push(ua[1].trim().toLowerCase());
      continue;
    }
    const rule = line.match(/^(allow|disallow):\s*(.*)$/i);
    if (rule && cur) { expectingAgents = false; cur.rules.push({ allow: /^allow$/i.test(rule[1]), pattern: rule[2].trim() }); }
  }
  const toRegex = (pattern: string): { re: RegExp; len: number } | null => {
    if (!pattern) return null;
    let p = pattern;
    let anchored = false;
    if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
    const esc = p.split('*').map((seg) => seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('.*');
    return { re: new RegExp('^' + esc + (anchored ? '$' : '')), len: pattern.replace(/\*/g, '').length };
  };
  const compiled = groups.map((g) => ({ agents: g.agents, rules: g.rules.map((r) => ({ ...r, c: toRegex(r.pattern) })).filter((r) => r.c) }));
  const ruleCount = compiled.reduce((n, g) => n + g.rules.length, 0);
  const pickGroup = (ua: string) => {
    const lc = ua.toLowerCase();
    // Most specific: the group with the longest agent token that is a substring of `ua`.
    let best: typeof compiled[number] | null = null; let bestLen = -1;
    let star: typeof compiled[number] | null = null;
    for (const g of compiled) {
      for (const a of g.agents) {
        if (a === '*') { star = star || g; continue; }
        if (lc.includes(a) && a.length > bestLen) { best = g; bestLen = a.length; }
      }
    }
    return best || star;
  };
  const allows = (path: string, ua = '*'): boolean => {
    const g = pickGroup(ua);
    if (!g) return true;
    let best: { allow: boolean; len: number } | null = null;
    for (const r of g.rules) {
      if (!r.c!.re.test(path)) continue;
      if (!best || r.c!.len > best.len || (r.c!.len === best.len && r.allow && !best.allow)) best = { allow: r.allow, len: r.c!.len };
    }
    return best ? best.allow : true;
  };
  return { allows, sitemaps: Array.from(new Set(sitemaps)), ruleCount };
}

const isHtml = (p: SeoPageAudit) => p.urlType === 'HTML';
const SEO_FILTERS: { id: string; label: string; test: (p: SeoPageAudit) => boolean }[] = [
  { id: 'all', label: 'Internal', test: () => true },
  { id: 'html', label: 'HTML', test: isHtml },
  { id: 'css', label: 'CSS', test: (p) => p.urlType === 'CSS' },
  { id: 'js', label: 'JavaScript', test: (p) => p.urlType === 'JavaScript' },
  { id: 'images-all', label: 'Images', test: (p) => p.urlType === 'Image' },
  { id: 'pdf', label: 'PDF', test: (p) => p.urlType === 'PDF' },
  { id: 'response', label: 'Response Codes', test: (p) => typeof p.status === 'number' && p.status >= 300 },
  { id: 'broken', label: 'Broken (4xx/5xx)', test: (p) => typeof p.status === 'number' && p.status >= 400 },
  { id: 'titles', label: 'Page Titles', test: (p) => isHtml(p) && p.issues.some((i) => i.code.startsWith('title')) },
  { id: 'meta', label: 'Meta Desc', test: (p) => isHtml(p) && p.issues.some((i) => i.code.startsWith('meta')) },
  { id: 'h1', label: 'H1', test: (p) => isHtml(p) && p.h1Count !== 1 },
  { id: 'h2', label: 'H2', test: (p) => isHtml(p) && p.h2Count === 0 },
  { id: 'content', label: 'Content', test: (p) => isHtml(p) && p.wordCount > 0 && p.wordCount < 200 },
  { id: 'img-alt', label: 'Missing Alt', test: (p) => p.imagesMissingAlt > 0 },
  { id: 'canonicals', label: 'Canonicals', test: (p) => isHtml(p) && p.canonicalType !== 'self' },
  { id: 'directives', label: 'Directives', test: (p) => p.noindex || p.nofollow || /x-robots/i.test(p.xRobotsTag) },
  { id: 'hreflang', label: 'Hreflang', test: (p) => p.hreflangCount > 0 },
  { id: 'pagination', label: 'Pagination', test: (p) => p.hasPagination },
  { id: 'structured', label: 'Structured Data', test: (p) => p.structuredDataTypes.length > 0 },
  { id: 'sd-invalid', label: 'SD Errors', test: (p) => p.structuredDataErrors.length > 0 },
  { id: 'near-dup', label: 'Near Duplicates', test: (p) => p.issues.some((i) => i.code === 'near-duplicate') },
  { id: 'indexable', label: 'Non-Indexable', test: (p) => p.indexabilityStatus !== 'Indexable' },
];

// Per-issue fix guidance + the matching .claude skill - used to build the OFFLINE (local)
// report and fix prompt deterministically from the crawl data.
const SEO_FIX_GUIDE: Record<string, { ko: string; en: string; skill: string }> = {
  status: { ko: 'Fix 4xx/5xx responses', en: 'Fix 4xx/5xx responses', skill: 'technical-seo-checker' },
  redirect: { ko: 'Remove needless redirects and link to final URLs', en: 'Remove needless redirects; link directly to the final URL', skill: 'technical-seo-checker' },
  'title-missing': { ko: 'Add a unique title', en: 'Add a unique title', skill: 'meta-tags-optimizer' },
  'title-long': { ko: 'Shorten long titles', en: 'Shorten long titles', skill: 'meta-tags-optimizer' },
  'title-short': { ko: 'Make short titles more descriptive', en: 'Make short titles more descriptive', skill: 'meta-tags-optimizer' },
  'title-eq-h1': { ko: 'Differentiate title from H1', en: 'Differentiate title from H1', skill: 'meta-tags-optimizer' },
  'title-duplicate': { ko: 'Make duplicate titles unique per page', en: 'Make duplicate titles unique per page', skill: 'meta-tags-optimizer' },
  'meta-missing': { ko: 'Add a meta description', en: 'Add a meta description', skill: 'meta-tags-optimizer' },
  'meta-long': { ko: 'Trim long meta descriptions', en: 'Trim long meta descriptions', skill: 'meta-tags-optimizer' },
  'meta-short': { ko: 'Expand short meta descriptions', en: 'Expand short meta descriptions', skill: 'meta-tags-optimizer' },
  'h1-missing': { ko: 'Add exactly one H1', en: 'Add exactly one H1', skill: 'on-page-seo-auditor' },
  'h1-multiple': { ko: 'Reduce to a single H1', en: 'Reduce to a single H1', skill: 'on-page-seo-auditor' },
  'h2-missing': { ko: 'Add H2 subheadings for structure', en: 'Add H2 subheadings for structure', skill: 'on-page-seo-auditor' },
  noindex: { ko: 'Remove unintended meta robots noindex', en: 'Remove unintended meta robots noindex', skill: 'technical-seo-checker' },
  'x-robots-noindex': { ko: 'Remove unintended X-Robots-Tag noindex', en: 'Remove unintended X-Robots-Tag noindex', skill: 'technical-seo-checker' },
  nofollow: { ko: 'Review unintended meta robots nofollow', en: 'Review unintended meta robots nofollow', skill: 'technical-seo-checker' },
  'robots-blocked': { ko: 'Review robots.txt blocks', en: 'Review robots.txt blocks', skill: 'technical-seo-checker' },
  'canonical-missing': { ko: 'Add a self-referencing canonical', en: 'Add a self-referencing canonical', skill: 'technical-seo-checker' },
  'canonical-other': { ko: 'Verify the canonical target is intended', en: 'Verify the canonical target is intended', skill: 'technical-seo-checker' },
  'img-alt': { ko: 'Add descriptive alt text to images', en: 'Add descriptive alt text to images', skill: 'on-page-seo-auditor' },
  'low-content': { ko: 'Expand thin content', en: 'Expand thin content', skill: 'seo-content-writer' },
  'no-structured-data-home': { ko: 'Add JSON-LD structured data to the homepage', en: 'Add JSON-LD structured data to the homepage', skill: 'schema-markup-generator' },
  orphan: { ko: 'Link orphan pages from relevant internal pages', en: 'Link orphan pages from relevant internal pages', skill: 'internal-linking-optimizer' },
  'broken-resource': { ko: 'Fix broken internal resource URLs', en: 'Fix broken internal resource URLs', skill: 'technical-seo-checker' },
  'broken-external': { ko: 'Replace or remove broken external links', en: 'Replace or remove broken external links', skill: 'technical-seo-checker' },
  'structured-data-invalid': { ko: 'Fix structured data schema errors', en: 'Fix structured data schema errors', skill: 'schema-markup-generator' },
  'near-duplicate': { ko: 'Consolidate or differentiate near-duplicate pages', en: 'Consolidate or differentiate near-duplicate pages', skill: 'content-quality-auditor' },
};

// Build an OFFLINE SEO report + agent fix prompt straight from the crawl - no API, no key needed.
function seoLocalReportFrom(report: SeoReport, ko: boolean): { report: string; fixPrompt: string } {
  const html = report.pages.filter((p) => p.urlType === 'HTML');
  const issueCounts: Record<string, number> = {};
  const issueLevel: Record<string, SeoIssueLevel> = {};
  for (const page of report.pages) { for (const issue of page.issues) { issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1; issueLevel[issue.code] = issue.level; } }
  const sortedCodes = Object.keys(issueCounts).sort((a, b) => issueCounts[b] - issueCounts[a]);
  const broken = report.pages.filter((p) => typeof p.status === 'number' && p.status >= 400);
  const structured = html.filter((p) => p.structuredDataTypes.length > 0).length;
  const reportLines: string[] = ['# SEO and Agent Fix Report', '', '> Generated: ' + report.generatedAt + ' | Host: ' + report.host + ' | HTML pages: ' + report.pagesCrawled, '', '## Summary', '- Errors: ' + report.summary.error, '- Warnings: ' + report.summary.warning, '- Notices: ' + report.summary.notice, '- Broken URLs: ' + broken.length, '- Structured data coverage: ' + structured + '/' + html.length + ' HTML pages', '', '## Top Issues'];
  if (sortedCodes.length) { for (const code of sortedCodes.slice(0, 20)) { const guide = SEO_FIX_GUIDE[code]; reportLines.push('- ' + code + ': ' + issueCounts[code] + ' (' + (issueLevel[code] || 'notice') + ')' + (guide ? ' - ' + guide.en : '')); } } else { reportLines.push('- No SEO issues were found in the crawl sample.'); }
  reportLines.push('', '## Affected Pages');
  for (const page of [...html].sort((a, b) => b.issues.length - a.issues.length).slice(0, 30)) { reportLines.push('- ' + page.finalUrl + ' | ' + page.indexabilityStatus + ' | ' + (page.issues.map((i) => i.code).join(', ') || 'ok')); }
  const usedSkills = Array.from(new Set(sortedCodes.map((code) => SEO_FIX_GUIDE[code]?.skill).filter(Boolean))) as string[];
  const fixLines: string[] = ['You are an SEO/GEO coding agent. Fix the issues below in the project code/templates.', 'Use the inlined skill instructions when present. Verify by rerunning the SEO report after edits.', '', 'Target host: ' + report.host, 'Start URL: ' + report.startUrl, '', 'Issues to fix:'];
  if (sortedCodes.length) { for (const code of sortedCodes) { const guide = SEO_FIX_GUIDE[code]; const examples = html.filter((p) => p.issues.some((i) => i.code === code)).slice(0, 3).map((p) => p.finalUrl); fixLines.push('- ' + code + ' x' + issueCounts[code] + (guide ? ' | skill: ' + guide.skill + ' | action: ' + guide.en : '')); if (examples.length) fixLines.push('  examples: ' + examples.join(', ')); } } else { fixLines.push('- No issues found. Review the generated report and keep the current implementation stable.'); }
  return { report: reportLines.join('\n'), fixPrompt: fixLines.join('\n') + seoInlineSkills(usedSkills, ko) };
}
const DEFAULT_URL = DEFAULT_BROWSER_URL;

// BBARIT's own ports must not be picked as "the dev server": Vite 5175, bridge 19980,
// mcp-bridge 9323-9422. Everything else is discovered from the OS, not hardcoded.
function isBbaritOwnPort(p: number): boolean {
  return p === 5175 || p === 19980 || (p >= 9323 && p <= 9422);
}
// Discover the project's local dev server by asking the OS which TCP ports are actually
// LISTENing (netstat/lsof - no hardcoded port list), then HTTP-probing them.
async function findLocalDevServer(): Promise<string | null> {
  const isWin = /Windows/i.test(navigator.userAgent);
  const cmd = isWin
    ? 'netstat -ano -p TCP'
    : 'lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || netstat -anv -p tcp 2>/dev/null';
  const seen = new Set<number>();
  try {
    const out = await invoke<string>('run_cli_oneshot', { command: cmd, timeoutSecs: 8 });
    for (const line of String(out || '').split('\n')) {
      if (isWin && !/LISTENING/i.test(line)) continue;
      const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\*):(\d{2,5})\b/);
      if (!m) continue;
      const p = Number(m[1]);
      if (p > 1024 && p < 65536 && !isBbaritOwnPort(p)) seen.add(p);
    }
  } catch { /* OS query failed */ }
  const candidates = [...seen].sort((a, b) => a - b).slice(0, 50);
  // Score each live port by how much its response looks like a web dev server
  // (HMR/bundler markers > HTML page > any HTTP). Content-based, so we pick the
  // real dev server among many running services instead of guessing a port.
  const scored = await Promise.all(candidates.map(async (port) => {
    try {
      const res = await invoke<{ status?: number; body?: string }>('http_request', { input: { method: 'GET', url: `http://localhost:${port}/`, timeout_ms: 700 } });
      const s = Number(res?.status ?? 0);
      if (!(s > 0 && s < 500)) return null;
      const body = String(res?.body || '').slice(0, 4000).toLowerCase();
      let score = 1;
      if (/<!doctype html|<html/.test(body)) score += 2;
      if (/@vite\/client|@react-refresh|__vite|webpack|sockjs-node|hot-update|hmr|_next\/|astro|nuxt|svelte|"vite"/.test(body)) score += 5;
      return { port, score };
    } catch { return null; }
  }));
  const live = scored.filter((x): x is { port: number; score: number } => x != null);
  if (!live.length) return null;
  live.sort((a, b) => b.score - a.score || a.port - b.port); // best dev-server signal, tie - lowest port
  return `http://localhost:${live[0].port}`;
}

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function normalizeHeaders(input: unknown): HeaderMap {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

const REDACTED_VALUE = '[redacted]';
const SENSITIVE_KEY_RE = /(password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|session|sid|cookie|authorization|csrf|xsrf|credential|private[_-]?key|client[_-]?secret|jwt)/i;
const TOKEN_LIKE_RE = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function headerValue(headers: HeaderMap | undefined, name: string): string {
  const wanted = name.toLowerCase();
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted)?.[1] || '';
}

function redactText(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(TOKEN_LIKE_RE, REDACTED_VALUE);
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_KEY_RE.test(key)) url.searchParams.set(key, REDACTED_VALUE);
    }
    return url.toString();
  } catch {
    return redactText(rawUrl);
  }
}

function redactNetworkEntry(entry: BrowserNetworkEntry): BrowserNetworkEntry {
  return { ...entry, url: redactUrl(entry.url) };
}

function redactHeaderMap(headers: HeaderMap | undefined, includeSecrets = false): HeaderMap {
  if (includeSecrets) return { ...(headers || {}) };
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [
    key,
    SENSITIVE_KEY_RE.test(key) ? REDACTED_VALUE : redactText(value),
  ]));
}

function redactNetworkRecord(record: BrowserNetworkRecord, includeSecrets = false): BrowserNetworkRecord {
  return {
    ...record,
    url: includeSecrets ? record.url : redactUrl(record.url),
    requestHeaders: redactHeaderMap(record.requestHeaders, includeSecrets),
    responseHeaders: redactHeaderMap(record.responseHeaders, includeSecrets),
    postData: includeSecrets ? record.postData : redactText(record.postData),
    body: includeSecrets ? record.body : redactText(record.body),
  };
}

function headerMapToPairs(headers: HeaderMap | undefined) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value }));
}

function browserRuleMatches(rule: { urlPattern?: string; isRegex?: boolean }, url: string): boolean {
  const pattern = String(rule.urlPattern || '').trim();
  if (!pattern) return false;
  try {
    if (rule.isRegex) return new RegExp(pattern).test(url);
    const escaped = pattern
      .split('*')
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${escaped}$`).test(url);
  } catch {
    return false;
  }
}

function formatBytes(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function targetIdFromWebSocketUrl(url: string): string | undefined {
  const match = url.match(/\/(?:page|devtools\/page)\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

const LOCALE_LANG_NAME: Record<Locale, string> = {
  en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese',
  fr: 'French', de: 'German', it: 'Italian', es: 'Spanish',
};

// 브라우저 창의 프로젝트 코드베이스 파일트리 노드(재귀). read_directory로 지연 로드.
interface CefFsEntry { name: string; path: string; is_dir: boolean }
function CefFileNode({ entry, depth, defaultOpen, onOpenFile, activePath }: { entry: CefFsEntry; depth: number; defaultOpen?: boolean; onOpenFile?: (path: string) => void; activePath?: string | null }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [children, setChildren] = useState<CefFsEntry[] | null>(null);
  const load = useCallback(async () => {
    if (children === null) {
      const c = await invoke<CefFsEntry[]>('read_directory', { path: entry.path }).catch(() => [] as CefFsEntry[]);
      // 폴더 먼저, 이름순.
      c.sort((a, b) => (Number(b.is_dir) - Number(a.is_dir)) || a.name.localeCompare(b.name));
      setChildren(c);
    }
  }, [children, entry.path]);
  useEffect(() => { if (defaultOpen) void load(); }, [defaultOpen, load]);
  const onRow = () => {
    if (entry.is_dir) {
      if (!open) void load();
      setOpen((v) => !v);
    } else {
      onOpenFile?.(entry.path);
    }
  };
  return (
    <div className="browser-fs-node">
      <div className={'browser-fs-row ' + (entry.is_dir ? 'dir' : 'file') + (!entry.is_dir && activePath === entry.path ? ' active' : '')} style={{ paddingLeft: 6 + depth * 12 }} onClick={onRow} title={entry.path}>
        <span className="browser-fs-chevron">{entry.is_dir ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}</span>
        <span className="browser-fs-icon">{entry.is_dir ? (open ? <FolderOpen size={15} /> : <Folder size={15} />) : <File size={14} />}</span>
        <span className="browser-fs-name">{entry.name}</span>
      </div>
      {entry.is_dir && open && children && children.map((c) => (
        <CefFileNode key={c.path} entry={c} depth={depth + 1} onOpenFile={onOpenFile} activePath={activePath} />
      ))}
    </div>
  );
}

export interface BrowserPageProps {
  /** When true, the page is embedded inside the main app (editor area) instead of a standalone window. */
  embedded?: boolean;
  /** Project working directory to scope the browser to (overrides the ?project= URL param). */
  embeddedProject?: string;
  /** Initial URL (overrides the ?url= URL param). */
  embeddedUrl?: string;
}

export default function BrowserPage({ embedded = false, embeddedProject, embeddedUrl }: BrowserPageProps = {}) {
  const { locale } = useTranslation();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialProjectRoot = embeddedProject || params.get('project') || defaultProjectRootFromStorage();
  // Explicit URLs win. Otherwise resume the last target for this project before falling back.
  const initialUrl = normalizeUrl(embeddedUrl || params.get('url') || savedProjectUrl(initialProjectRoot) || DEFAULT_URL);
  const initialSessionId = params.get('session') || undefined;
  const [projectRoot, setProjectRoot] = useState(initialProjectRoot);
  const [address, setAddress] = useState(initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const addressRef = useRef(initialUrl);
  const currentUrlRef = useRef(initialUrl);
  useEffect(() => { addressRef.current = address; }, [address]);
  useEffect(() => { currentUrlRef.current = currentUrl; }, [currentUrl]);
  const setBrowserLocation = useCallback((url: string) => {
    addressRef.current = url;
    currentUrlRef.current = url;
    setAddress(url);
    setCurrentUrl(url);
  }, []);
  // Cross-session smart history (frecency-ranked, categorized). Persisted to KV;
  // the live ref lets the global browser API expose search without a re-render.
  const historyRef = useRef<HistoryEntry[]>([]);
  const historyLoadedRef = useRef(false);
  // Last-session snapshot offered for one-click restore after a restart.
  const sessionRef = useRef<SessionSnapshot | null>(null);
  const [restorable, setRestorable] = useState<SessionSnapshot | null>(null);
  // First-run onboarding overlay (introduces AI capabilities; version-gated).
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Chrome/Chromium 데이터 가져오기 마법사.
  const [showImport, setShowImport] = useState(false);
  // History & bookmarks panel (data lives in historyRef; frecency-ranked, categorized).
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyTab, setHistoryTab] = useState<'all' | 'bookmarks'>('all');
  const [historyTick, setHistoryTick] = useState(0);   // bump to re-render the list
  const currentBookmarked = historyRef.current.some((e) => e.url === currentUrl && e.bookmarked);
  const historyRows = showHistoryPanel
    ? searchHistory(historyRef.current, historyQuery, Date.now(), { limit: 60, bookmarkedOnly: historyTab === 'bookmarks' })
    : [];
  const toggleBookmark = useCallback((url: string, on: boolean) => {
    historyRef.current = setBookmark(historyRef.current, url, on);
    if (on && !historyRef.current.some((e) => e.url === url)) {
      historyRef.current = recordVisit(historyRef.current, { url, title: url }, Date.now());
      historyRef.current = setBookmark(historyRef.current, url, true);
    }
    void kvSet('bbarit-browser-history', JSON.stringify(historyRef.current));
    setHistoryTick((t) => t + 1);
  }, []);
  // ── 사이드바 확장 상태(Aside 문법): 클립/최근 태스크/감사 로그/승인 게이트 ──
  const [webClips, setWebClips] = useState<WebClip[]>([]);
  const [asideRecentTasks, setAsideRecentTasks] = useState<AsideRecentTask[]>([]);
  const [asideAudit, setAsideAudit] = useState<AsideAuditEntry[]>([]);
  const [pendingAgentTask, setPendingAgentTask] = useState<string | null>(null);
  const [asideHistoryQuery, setAsideHistoryQuery] = useState('');
  const [asideHistoryTab, setAsideHistoryTab] = useState<'all' | 'bookmarks'>('all');
  // 사이트 로그인(아이디/패스워드) — kv 로컬 저장. 채우기/에이전트 로그인에 사용.
  const [siteLogins, setSiteLogins] = useState<SiteLogin[]>([]);
  const siteLoginsLoadedRef = useRef(false);
  useEffect(() => {
    void kvGet('browser-aside-logins').then((raw) => {
      if (raw) { try { setSiteLogins(JSON.parse(raw)); } catch { /* 손상값 무시 */ } }
      siteLoginsLoadedRef.current = true;
    });
  }, []);
  const persistLogins = useCallback((next: SiteLogin[]) => {
    setSiteLogins(next);
    void kvSet('browser-aside-logins', JSON.stringify(next));
  }, []);

  // Chrome 가져오기 결과를 브라우저의 기존 저장소로 접어 넣는다.
  const applyChromeImport = useCallback(async (payload: ImportPayload, items: ImportItem[], profile: ChromeProfile) => {
    const now = Date.now();
    // 방문기록 → 북마크 순으로 접어 넣어야 bookmarked 플래그가 유지된다.
    if (items.includes('history') && payload.history.length) {
      historyRef.current = mergeHistory(historyRef.current, payload.history, now);
    }
    if (items.includes('bookmarks') && payload.bookmarks.length) {
      historyRef.current = mergeBookmarks(historyRef.current, payload.bookmarks, now);
    }
    if (items.includes('history') || items.includes('bookmarks')) {
      void kvSet('bbarit-browser-history', JSON.stringify(historyRef.current));
      setHistoryTick((t) => t + 1);
    }
    if (items.includes('passwords') && payload.passwords.length) {
      persistLogins(passwordsToLogins(siteLogins, payload.passwords, now));
    }
    if (items.includes('autofill') && payload.autofill.length) {
      void kvSet('bbarit-browser-autofill', JSON.stringify(payload.autofill));
    }
    if (items.includes('search_engines') && payload.search_engines.length) {
      void kvSet('bbarit-browser-search-engines', JSON.stringify(payload.search_engines));
    }
    // 쿠키는 열린 탭의 네이티브 쿠키 스토어에 넣어야 로그인 세션이 넘어온다.
    let cookieNote = '';
    if (items.includes('cookies') && payload.cookies.length) {
      const id = cefActiveIdRef.current;
      if (id != null) {
        const [ok, failed] = await injectCookies(id, importableCookies(payload.cookies, now)).catch(() => [0, 0] as [number, number]);
        cookieNote = failed > 0 ? ` (쿠키 ${ok}개 적용, ${failed}개 실패)` : '';
      } else {
        cookieNote = ' (쿠키는 탭을 연 뒤 다시 시도하세요)';
      }
    }
    setShowImport(false);
    const summary = summarizeImport(payload, items);
    const warn = payload.warnings.length ? ` — ${payload.warnings[0]}` : '';
    setCefNotice(`${profile.browser_name}에서 ${summary}${cookieNote}${warn}`);
    window.setTimeout(() => setCefNotice(''), 9000);
  }, [persistLogins, siteLogins]);
  // agentLogin이 runAsideTask보다 위에서 정의되므로 ref로 늦게 연결한다.
  const runAsideTaskRef = useRef<(text: string) => void>(() => {});
  const recordAsideAudit = useCallback((kind: string, text: string) => {
    setAsideAudit((prev) => {
      const next = [...prev, { at: Date.now(), kind, text }].slice(-200);
      void kvSet('bbarit-browser-audit', JSON.stringify(next));
      return next;
    });
  }, []);
  // Anti-bot wall notice: when a page is a Cloudflare/captcha/login wall, surface a
  // clear banner telling the user what to do (solve it in the visible window, etc.).
  const [blockNotice, setBlockNotice] = useState<BlockVerdict | null>(null);
  const [blockNoticeDismissed, setBlockNoticeDismissed] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detectingLocalTarget, setDetectingLocalTarget] = useState(false);
  const [navState, setNavState] = useState<NavState>({ canGoBack: false, canGoForward: false });
  // BBARIT Browser is an SEO + Agent workbench first. Open the Agent split by
  // default on PC; ?agent=0 is the escape hatch for a report-only surface.
  const [showDeepSeekAgent, setShowDeepSeekAgent] = useState(() => params.get('agent') !== '0');
  // 크롬식 리디자인: SEO 워크벤치는 ⋮ 메뉴에서 여는 오버레이로, 좌측은 실제 페이지 화면.
  const [showSeoPanel, setShowSeoPanel] = useState(false);
  // 피들러 스타일 패킷 분석 오버레이 (Network/Composer/AutoResponder/Breakpoints).
  const [showNetworkPanel, setShowNetworkPanel] = useState(false);

  // Internal WebView browser mode (Tauri child WebView / WebView2 on Windows).
  // 사용 가능하면 기본 활성화. WebView NSView가 좌측 패널 위에 떠 있으므로
  // 오버레이(메뉴/찾기/SEO/히스토리)가 열리면 잠시 숨긴다.
  // null = 런타임 확인 중(아직 모름). false가 확정되면 명시적 안내 화면을 띄운다.
  interface CefTab {
    id: number;
    title: string;
    url: string;
    loading: boolean;
    canBack: boolean;
    canFwd: boolean;
    history: string[];
    historyIndex: number;
    sessionId?: string;
  }
  const [cefAvailable, setCefAvailable] = useState<boolean | null>(null);
  const [cefTabs, setCefTabs] = useState<CefTab[]>([]);
  const [cefActiveId, setCefActiveId] = useState<number | null>(null);
  const cefActiveIdRef = useRef<number | null>(null);
  useEffect(() => { cefActiveIdRef.current = cefActiveId; }, [cefActiveId]);
  const cefSurfaceRef = useRef<HTMLDivElement | null>(null);
  // CDP attach 함수는 connectExactPageTarget 정의 이후에 만들어지므로 ref로 배선.
  const cefAttachRef = useRef<(hint?: string) => Promise<boolean>>(() => Promise.resolve(false));
  const cefTabsRef = useRef<CefTab[]>([]);
  useEffect(() => { cefTabsRef.current = cefTabs; }, [cefTabs]);
  const pendingCefHistoryNavRef = useRef(new Map<number, { url: string; index: number; expiresAt: number }>());
  const nativeEvalSeqRef = useRef(0);
  const nativeEvalPendingRef = useRef(new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    chunks: string[];
    total: number;
    timer: number;
  }>());
  const shouldUseCefMainUrl = useCallback((url: string, currentUrl = '') => {
    if (!/^(https?:|file:|data:|about:)/i.test(url)) return false;
    if (/[?#&](frameId|origin)=/i.test(url)) return false;
    if (/\/\/siape\.veta\.naver\.com\//i.test(url)) return false;
    const currentHost = (() => { try { return new URL(currentUrl || '').host; } catch { return ''; } })();
    const eventHost = (() => { try { return new URL(url).host; } catch { return ''; } })();
    if (currentHost === 'www.naver.com' && /(^|\.)shopsquare\.naver\.com$/i.test(eventHost)) return false;
    return true;
  }, []);
  const sameCefHistoryUrl = useCallback((a: string, b: string) => {
    const normalize = (value: string) => String(value || '').replace(/\/+$/, '');
    return normalize(a) === normalize(b);
  }, []);
  const withCefHistory = useCallback((tab: CefTab, url: string, mode: 'push' | 'replace' | 'index' = 'push', index?: number): CefTab => {
    const fallbackHistory = tab.history?.length ? tab.history : [tab.url || url].filter(Boolean);
    let history = fallbackHistory.slice();
    let historyIndex = Number.isFinite(tab.historyIndex) ? tab.historyIndex : history.length - 1;
    historyIndex = Math.max(0, Math.min(historyIndex, Math.max(0, history.length - 1)));
    if (mode === 'index' && typeof index === 'number') {
      historyIndex = Math.max(0, Math.min(index, Math.max(0, history.length - 1)));
    } else if (mode === 'replace') {
      if (history.length === 0) history = [url];
      history[historyIndex] = url;
    } else if (url && sameCefHistoryUrl(history[historyIndex] || '', url)) {
      history[historyIndex] = url;
    } else if (url) {
      history = history.slice(0, historyIndex + 1);
      history.push(url);
      historyIndex = history.length - 1;
    }
    const nextUrl = history[historyIndex] || url || tab.url;
    return {
      ...tab,
      url: nextUrl,
      history,
      historyIndex,
      canBack: historyIndex > 0,
      canFwd: historyIndex >= 0 && historyIndex < history.length - 1,
    };
  }, [sameCefHistoryUrl]);
  const updateCefTabLocation = useCallback((id: number, url: string, mode: 'push' | 'replace' = 'push', loading?: boolean) => {
    if (!url) return null;
    let activeUrl: string | null = null;
    setCefTabs((prev) => {
      const next = prev.map((t) => {
        if (t.id !== id) return t;
        const patched = withCefHistory(t, url, mode);
        activeUrl = patched.url;
        return { ...patched, loading: typeof loading === 'boolean' ? loading : patched.loading };
      });
      cefTabsRef.current = next;
      return next;
    });
    if (id === cefActiveIdRef.current && activeUrl) {
      setBrowserLocation(activeUrl);
    }
    return activeUrl;
  }, [setBrowserLocation, withCefHistory]);
  // 창이 닫힐 때 이 창 소속 WebView 브라우저를 전부 정리한다. 안 하면(Windows 실측,
  // 재열림 백지의 근본원인): 부모 HWND만 파괴되고 WebView 브라우저·CDP 타깃은
  // 살아남는다 → 같은 라벨로 창을 다시 열면 유령 브라우저의 cef-event가
  // 브로드캐스트로 흘러들어 탭 UI만 복원되고, auto-open은 "탭 있음"으로 스킵
  // → 본문이 영원히 검은 화면. HMR/리로드(beforeunload)도 같은 경로로 정리.
  useEffect(() => {
    const closeAll = () => {
      for (const t of cefTabsRef.current) {
        void invoke('cef_close', { id: t.id }).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', closeAll);
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(() => { closeAll(); }).then((fn) => { unlisten = fn; });
    return () => {
      window.removeEventListener('beforeunload', closeAll);
      unlisten?.();
    };
  }, []);
  const [cefNotice, setCefNotice] = useState('');
  useEffect(() => {
    invoke<boolean>('cef_available').then((ok) => setCefAvailable(ok && params.get('cef') !== '0')).catch(() => {});
  }, [params]);
  const cefMode = cefAvailable === true;

  const [cefDevtoolsOpen, setCefDevtoolsOpen] = useState(false);
  const cefDevtoolsOpenRef = useRef(false);
  useEffect(() => { cefDevtoolsOpenRef.current = cefDevtoolsOpen; }, [cefDevtoolsOpen]);
  // 브라우저 창 좌측 프로젝트 코드베이스 파일트리 표시 여부.
  // browser:open 이 넘기는 ?tree=1 을 존중해 코드베이스 파일트리를 처음부터 연다.
  const [showFileTree, setShowFileTree] = useState(() => {
    const t = params.get('tree');
    return t === '1' || t === 'true';
  });
  // 파일트리에서 파일 클릭 시 여는 인라인 에디터(별도 공간, 토글).
  const [showEditor, setShowEditor] = useState(false);
  const [editorFile, setEditorFile] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const openFileInEditor = useCallback(async (path: string) => {
    setShowEditor(true);
    setEditorFile(path);
    setEditorError(null);
    setEditorDirty(false);
    setEditorContent('');
    try {
      const content = await invoke<string>('read_file', { path });
      setEditorContent(content);
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const saveEditorFile = useCallback(async () => {
    if (!editorFile) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      await invoke('write_file', { path: editorFile, content: editorContent });
      setEditorDirty(false);
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditorSaving(false);
    }
  }, [editorFile, editorContent]);

  const cefBounds = useCallback(() => {
    const el = cefSurfaceRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // The CSS surface reserves browser chrome. On macOS, child NSView bounds are
    // offset from the decorated window, so add only that native inset and shrink
    // height by clamping the bottom edge.
    const viewportW = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportH = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const nativeTopInset = /Mac/i.test(navigator.platform || '') ? MAC_NATIVE_WEBVIEW_TOP_INSET_PX : 0;
    const x = Math.max(0, Math.min(Math.round(r.x), viewportW - 1));
    const y = Math.max(0, Math.min(Math.round(r.y + nativeTopInset), viewportH - 1));
    const right = Math.max(x + 1, Math.min(Math.round(r.right), viewportW));
    const bottom = Math.max(y + 1, Math.min(Math.round(r.bottom), viewportH));
    return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
  }, []);

  // DevTools는 별도 창으로 연다(부모 뷰 임베드는 WebView 크래시, 실측). 토글.
  const cefToggleDevtools = useCallback(() => {
    const id = cefActiveIdRef.current;
    if (id == null) return;
    const next = !cefDevtoolsOpenRef.current;
    cefDevtoolsOpenRef.current = next;
    setCefDevtoolsOpen(next);
    const wl = getCurrentWindow().label;
    void invoke('cef_devtools', { windowLabel: wl, id, show: next, x: 0, y: 0, w: 0, h: 0 }).catch(() => {});
  }, []);

  const cefSyncBounds = useCallback((id?: number | null) => {
    const target = id ?? cefActiveIdRef.current;
    const b = cefBounds();
    if (target == null || !b) return;
    void invoke('cef_set_bounds', { windowLabel: getCurrentWindow().label, id: target, ...b }).catch(() => {});
  }, [cefBounds, setBrowserLocation]);

  const pendingCefOpenRef = useRef<Array<{ url: string; sessionId?: string; createdAt: number }>>([]);
  const claimPendingCefOpen = useCallback((url: string) => {
    const now = Date.now();
    const normalized = normalizeUrl(url || DEFAULT_BROWSER_URL);
    pendingCefOpenRef.current = pendingCefOpenRef.current.filter((entry) => now - entry.createdAt < 30000);
    const index = pendingCefOpenRef.current.findIndex((entry) => normalizeUrl(entry.url) === normalized);
    if (index < 0) return null;
    const [entry] = pendingCefOpenRef.current.splice(index, 1);
    return entry;
  }, []);

  const cefOpeningRef = useRef(false);
  const cefOpenTab = useCallback(async (url: string, sessionId?: string) => {
    // 동시/중복 생성 방지: auto-open·ensureLiveSession·StrictMode 이중 실행 등이
    // 겹치면 WebView 탭이 여러 개 쌓여 뷰가 겹친다(실측 3개 생성). 한 번에 하나만.
    if (cefOpeningRef.current) return null;
    cefOpeningRef.current = true;
    const normalizedUrl = normalizeUrl(url || DEFAULT_BROWSER_URL);
    try {
      // 콜드스타트: 창이 막 열리면 surface div가 아직 마운트/레이아웃 전이라
      // cefBounds가 null(=서피스 없음)이거나 0 크기다. 레이아웃될 때까지 잠깐
      // 재시도한다(에이전트/CLI가 열자마자 탭을 여는 경로의 실패 방지).
      let b = cefBounds();
      for (let i = 0; i < 40 && (!b || b.w < 1 || b.h < 1); i++) {
        await new Promise((r) => window.setTimeout(r, 50));
        b = cefBounds();
      }
      if (!b || b.w < 1 || b.h < 1) return null;
      const prev = cefActiveIdRef.current;
      if (prev != null) {
        await invoke('cef_set_visible', { id: prev, visible: false }).catch(() => {});
      }
      if (sessionId) {
        pendingCefOpenRef.current.push({ url: normalizedUrl, sessionId: String(sessionId), createdAt: Date.now() });
      }
      const id = await Promise.race([
        invoke<number>('cef_open', { windowLabel: getCurrentWindow().label, url: normalizedUrl, ...b }),
        new Promise<number>((_, reject) => window.setTimeout(() => reject(new Error('cef_open timed out')), 12000)),
      ]);
      const tab = { id, title: '', url: normalizedUrl, loading: true, canBack: false, canFwd: false, history: [normalizedUrl], historyIndex: 0, sessionId: sessionId ? String(sessionId) : undefined };
      setCefTabs((tabsPrev) => {
        const next = tabsPrev.some((t) => t.id === id)
          ? tabsPrev.map((t) => t.id === id ? { ...t, ...tab, title: t.title || tab.title, loading: t.loading || tab.loading } : t)
          : [...tabsPrev, tab];
        cefTabsRef.current = next;
        return next;
      });
      cefActiveIdRef.current = id;
      setCefActiveId(id);
      // CDP 타깃이 등록될 시간을 준 뒤 에이전트/CLI용 CDP 세션을 붙인다.
      window.setTimeout(() => { void cefAttachRef.current(normalizedUrl); }, 800);
      return id;
    } catch (err) {
      let recovered = [...cefTabsRef.current].reverse().find((t) => normalizeUrl(t.url) === normalizedUrl);
      for (let i = 0; !recovered && i < 20; i += 1) {
        await new Promise((r) => window.setTimeout(r, 100));
        recovered = [...cefTabsRef.current].reverse().find((t) => normalizeUrl(t.url) === normalizedUrl);
      }
      if (recovered) {
        if (sessionId && !recovered.sessionId) {
          cefTabsRef.current = cefTabsRef.current.map((t) => t.id === recovered.id ? { ...t, sessionId: String(sessionId) } : t);
          setCefTabs(cefTabsRef.current);
        }
        cefActiveIdRef.current = recovered.id;
        setCefActiveId(recovered.id);
        setBrowserLocation(recovered.url);
        setError(null);
        window.setTimeout(() => { void cefAttachRef.current(recovered.url); }, 500);
        return recovered.id;
      }
      const prev = cefActiveIdRef.current;
      if (prev != null) void invoke('cef_set_visible', { id: prev, visible: true }).catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      // 짧은 쿨다운: 연속 중복 호출(같은 tick의 재실행)을 흡수하되, 사용자가
      // 새 탭 버튼으로 의도적으로 여는 것은 막지 않는다.
      window.setTimeout(() => { cefOpeningRef.current = false; }, 500);
    }
  }, [cefBounds]);

  const cefSwitchTab = useCallback((id: number) => {
    const prev = cefActiveIdRef.current;
    if (prev === id) return;
    if (prev != null) void invoke('cef_set_visible', { id: prev, visible: false }).catch(() => {});
    void invoke('cef_set_visible', { id, visible: true }).catch(() => {});
    cefActiveIdRef.current = id;
    setCefActiveId(id);
    window.setTimeout(() => cefSyncBounds(id), 30);
    const url = cefTabsRef.current.find((t) => t.id === id)?.url;
    window.setTimeout(() => { void cefAttachRef.current(url); }, 200);
  }, [cefSyncBounds]);

  const cefCloseTab = useCallback((id: number) => {
    void invoke('cef_close', { id }).catch(() => {});
  }, []);

  // cef-event: title/url/loading/created/closed
  useEffect(() => {
    if (!cefMode) return;
    // StrictMode 이중 마운트 가드(아래 RPC 리스너와 동일한 누수 패턴 방지).
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<any>('cef-event', (event) => {
      const p = event.payload || {};
      const id = Number(p.id);
      if (p.type === 'eval-result') {
        const token = String(p.title || '');
        const pending = nativeEvalPendingRef.current.get(token);
        if (!pending) return;
        try {
          const chunkInfo = JSON.parse(String(p.message || '{}'));
          const index = Math.max(0, Number(chunkInfo.index || 0));
          const total = Math.max(1, Number(chunkInfo.total || 1));
          pending.total = total;
          pending.chunks[index] = String(chunkInfo.payload || '');
          const received = pending.chunks.filter((chunk) => typeof chunk === 'string').length;
          if (received >= total) {
            nativeEvalPendingRef.current.delete(token);
            window.clearTimeout(pending.timer);
            const payload = JSON.parse(pending.chunks.slice(0, total).join(''));
            if (payload?.ok) pending.resolve(payload.value);
            else pending.reject(new Error(String(payload?.error || 'Native WebView eval failed.')));
          }
        } catch (error) {
          nativeEvalPendingRef.current.delete(token);
          window.clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      // 팝업(window.open/target=_blank/Cmd+클릭)은 새 탭으로.
      if (p.type === 'popup' && p.url) {
        const activeSessionId = cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current)?.sessionId;
        void cefOpenTab(String(p.url), activeSessionId || undefined);
        return;
      }
      if (p.type === 'download-start') {
        const filePath = String(p.url || '');
        const name = String(p.title || '') || filePath.split('/').pop() || 'download';
        upsertDownloadRecord(name, { guid: name, state: 'started', suggestedFilename: name, url: String(p.message || filePath), filePath, startedAt: new Date().toISOString() });
        setDownloadsOpen(true);
        setCefNotice((locale === 'ko' ? '다운로드 시작: ' : 'Download started: ') + name);
        return;
      }
      if (p.type === 'download-done') {
        const filePath = String(p.url || '');
        const name = String(p.title || '') || filePath.split('/').pop() || 'download';
        const failed = String(p.message || '') === 'failed';
        upsertDownloadRecord(name, { guid: name, state: failed ? 'failed' : 'completed', suggestedFilename: name, filePath });
        setDownloadsOpen(true);
        setCefNotice(failed
          ? (locale === 'ko' ? '다운로드 실패: ' : 'Download failed: ') + name
          : (locale === 'ko' ? '다운로드 완료: ' : 'Download finished: ') + filePath);
        window.setTimeout(() => setCefNotice(''), 8000);
        return;
      }
      if (p.type === 'closed') {
        setCefTabs((prev) => {
          const next = prev.filter((t) => t.id !== id);
          if (cefActiveIdRef.current === id && next.length > 0) cefSwitchTab(next[next.length - 1].id);
          return next;
        });
        return;
      }
      if (p.type === 'created' && p.url) {
        const url = String(p.url);
        const pendingOpen = claimPendingCefOpen(url);
        const prevActive = cefActiveIdRef.current;
        const inheritedSessionId = prevActive == null
          ? undefined
          : cefTabsRef.current.find((t) => t.id === prevActive)?.sessionId;
        const pendingSessionId = pendingOpen?.sessionId
          ? String(pendingOpen.sessionId)
          : inheritedSessionId ? String(inheritedSessionId) : undefined;
        if (prevActive != null && prevActive !== id) void invoke('cef_set_visible', { id: prevActive, visible: false }).catch(() => {});
        setCefTabs((prev) => {
          if (prev.some((t) => t.id === id)) {
            const next = pendingSessionId
              ? prev.map((t) => t.id === id && !t.sessionId ? { ...t, sessionId: pendingSessionId } : t)
              : prev;
            cefTabsRef.current = next;
            return next;
          }
          const next = [
            ...prev.map((t) => ({ ...t, loading: false })),
            { id, title: '', url, loading: !!p.loading, canBack: false, canFwd: false, history: [url], historyIndex: 0, sessionId: pendingSessionId },
          ];
          cefTabsRef.current = next;
          return next;
        });
        cefActiveIdRef.current = id;
        setCefActiveId(id);
        setBrowserLocation(url);
        window.setTimeout(() => cefSyncBounds(id), 30);
        return;
      }
      setCefTabs((prev) => {
        const next = prev.map((t) => {
          if (t.id !== id) return t;
          const eventUrl = String(p.url || '');
          const useEventUrl = (p.type === 'url' || p.type === 'loading')
            && eventUrl
            && shouldUseCefMainUrl(eventUrl, t.url);
          const pendingHistoryNav = pendingCefHistoryNavRef.current.get(id);
          const isPendingHistoryNav = !!pendingHistoryNav
            && Date.now() < pendingHistoryNav.expiresAt
            && sameCefHistoryUrl(pendingHistoryNav.url, eventUrl);
          if (isPendingHistoryNav && p.type === 'loading' && !p.loading) {
            pendingCefHistoryNavRef.current.delete(id);
          }
          const located = useEventUrl
            ? isPendingHistoryNav
              ? withCefHistory(t, eventUrl, 'index', pendingHistoryNav.index)
              : withCefHistory(t, eventUrl, 'push')
            : t;
          return {
            ...located,
            title: p.type === 'title' ? String(p.title || '') : t.title,
            loading: p.type === 'loading' ? !!p.loading : t.loading,
          };
        });
        cefTabsRef.current = next;
        return next;
      });
      // 로딩이 끝나면 활성 탭을 뷰포트 폭에 맞춰 자동 축소(반응형 fit-to-width).
      if (p.type === 'loading' && id === cefActiveIdRef.current) {
        setIsLoading(!!p.loading);
      }
      if (p.type === 'loading' && !p.loading && id === cefActiveIdRef.current) {
        window.setTimeout(() => { void fitRef.current(); }, 350);
      }
      if ((p.type === 'url' || p.type === 'loading') && id === cefActiveIdRef.current && p.url && shouldUseCefMainUrl(String(p.url), cefTabsRef.current.find((t) => t.id === id)?.url || '')) {
        setAddress(String(p.url));
        setCurrentUrl(String(p.url));
        historyRef.current = recordVisit(historyRef.current, { url: String(p.url), title: '' }, Date.now());
      }
    }).then((fn) => {
      if (disposed) { fn(); return; }
      unlisten = fn;
    });
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [cefMode, cefSwitchTab, cefOpenTab, cefSyncBounds, claimPendingCefOpen, locale, setBrowserLocation, shouldUseCefMainUrl, withCefHistory]);

  // 패널 지오메트리 추적: ResizeObserver + 창 리사이즈.
  useEffect(() => {
    if (!cefMode) return;
    const el = cefSurfaceRef.current;
    if (!el) return;
    const sync = () => cefSyncBounds();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener('resize', sync);
    return () => { ro.disconnect(); window.removeEventListener('resize', sync); };
  }, [cefMode, cefSyncBounds]);

  // Tauri 네이티브 창 리사이즈는 DOM resize 이벤트로 항상 넘어오지 않는다(실측:
  // WebView가 창 크기를 안 따라감). 네이티브 onResized/onMoved를 직접 구독해 매
  // 이벤트마다 bounds를 갱신한다.
  useEffect(() => {
    if (!cefMode) return;
    const win = getCurrentWindow();
    const uns: Array<() => void> = [];
    let raf = 0;
    const onResize = () => {
      cefSyncBounds();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => cefSyncBounds());
    };
    void win.onResized(onResize).then((f) => uns.push(f));
    void win.onMoved(() => cefSyncBounds()).then((f) => uns.push(f));
    return () => { cancelAnimationFrame(raf); uns.forEach((f) => f()); };
  }, [cefMode, cefSyncBounds]);

  // 이벤트 독립 폴링 보장: onResized/DOM resize가 발동하지 않는 케이스(실측:
  // 프로그래매틱 리사이즈, 일부 드래그 경로)에도 WebView가 창 크기를 반드시 따라가게
  // surface 크기를 250ms마다 확인해 변하면 sync한다. WebView NSView는 웹 콘텐츠 위에
  // 뜬 네이티브 뷰라 명시 sync 외에는 크기가 갱신되지 않는다. rect가 안 변하면
  // invoke도 안 하므로 유휴 비용은 rect 측정뿐이다.
  useEffect(() => {
    if (!cefMode) return;
    let lastW = 0;
    let lastH = 0;
    let lastT = 0;
    const iv = window.setInterval(() => {
      const el = cefSurfaceRef.current;
      if (!el || cefActiveIdRef.current == null) return;
      // getBoundingClientRect forces a synchronous reflow — this is a
      // fallback net behind ResizeObserver/onResized, so keep it slow (the
      // old 80ms tick meant 12.5 forced reflows/sec for the whole life of
      // the window) and skip it entirely while the window is hidden.
      if (document.hidden) return;
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      const t = Math.round(r.top);
      if (w !== lastW || h !== lastH || t !== lastT) {
        lastW = w; lastH = h; lastT = t;
        cefSyncBounds();
      }
    }, 250);
    return () => window.clearInterval(iv);
  }, [cefMode, cefSyncBounds]);

  // 탭바는 첫 탭이 생길 때 나타나며 그만큼 툴바를 아래로 민다. surface div는
  // fixed라 크기가 안 변해 ResizeObserver가 발동하지 않으므로, 탭 개수가 바뀌면
  // 명시적으로 bounds를 재계산한다. 초기 1회는 레이아웃이 확정되기 전이라 자주
  // 틀리므로(전체화면 리사이즈하면 고쳐지는 증상), rAF + 여러 지연으로 반복 sync해
  // 레이아웃이 안정된 시점의 정확한 bounds를 WebView에 전달한다.
  useEffect(() => {
    if (!cefMode) return;
    const timers: number[] = [];
    const raf = requestAnimationFrame(() => cefSyncBounds());
    for (const delay of [60, 180, 400, 800]) {
      timers.push(window.setTimeout(() => cefSyncBounds(), delay));
    }
    return () => { cancelAnimationFrame(raf); timers.forEach((t) => window.clearTimeout(t)); };
  }, [cefMode, cefTabs.length, cefSyncBounds]);

  // 브라우저 버튼으로 창을 열면 바로 내장 Chromium 탭이 뜬다 (시작 버튼 불필요).
  // surface가 레이아웃되기 전이면 bounds가 없어 실패하므로 잠깐 재시도한다.
  const cefAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (!cefMode || cefAutoOpenedRef.current) return;
    cefAutoOpenedRef.current = true;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (cefTabsRef.current.length > 0 || attempts > 12) { window.clearInterval(timer); return; }
      const el = cefSurfaceRef.current;
      if (!el || el.getBoundingClientRect().width < 10) return;
      window.clearInterval(timer);
      void cefOpenTab(normalizeUrl(currentUrl || address || DEFAULT_BROWSER_URL), initialSessionId);
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cefMode, cefOpenTab]);


  // 기본 브라우저 기능: 페이지 내 찾기 바, 줌 레벨, 옴니박스 포커스(Cmd+L).
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [zoomPercent, setZoomPercent] = useState(100);

  // 크롬 레이아웃을 바꾸는 토글(파일트리 좌측폭·에디터 하단드로어·찾기 바·에이전트
  // 우측폭)이 변하면 surface div의 rect가 달라지므로 WebView bounds를 즉시 재계산한다.
  // 특히 찾기 바는 WebView를 숨기지 않고 그 아래로 WebView를 줄여야 페이지와 함께 보인다.
  useEffect(() => {
    if (!cefMode) return;
    const raf = requestAnimationFrame(() => cefSyncBounds());
    const t = window.setTimeout(() => cefSyncBounds(), 80);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [cefMode, showFileTree, showEditor, findOpen, showDeepSeekAgent, cefSyncBounds]);
  const zoomPercentRef = useRef(100);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [deepSeekInitialTask, setDeepSeekInitialTask] = useState('');
  const [deepSeekInitialTaskNonce, setDeepSeekInitialTaskNonce] = useState(0);
  const [deepSeekInitialTaskRequiresProject, setDeepSeekInitialTaskRequiresProject] = useState(false);

  // ── 사이드바 (rail+패널, 설계 docs/BROWSER-ASIDE-DESIGN-2026-07-06.md) ──
  // showDeepSeekAgent가 열림 상태를 겸한다(기존 열기 경로 호환). 활성 패널·폭은
  // kv_store 'browser-aside-state'로 영속(D16 — localStorage 금지).
  const [asidePane, setAsidePane] = useState<AsidePane>('agent');
  const [asideWidth, setAsideWidth] = useState(340);
  // 사이드바 에이전트 패널의 전체화면 모달(페르소나 피커) 열림 — CEF 숨김 조건에 포함.
  const [asideModalOpen, setAsideModalOpen] = useState(false);
  const asideKvLoadedRef = useRef(false);
  useEffect(() => {
    void invoke<string | null>('kv_get', { key: 'browser-aside-state' })
      .then((raw) => {
        if (raw) {
          try {
            const s = JSON.parse(raw) as { open?: boolean; pane?: AsidePane; width?: number };
            if (typeof s.open === 'boolean' && params.get('agent') !== '0') setShowDeepSeekAgent(s.open);
            if (s.pane) setAsidePane(s.pane);
            if (typeof s.width === 'number') setAsideWidth(Math.max(ASIDE_MIN_W, Math.min(asideMaxW(), s.width)));
          } catch { /* 손상 값은 무시 — 기본값 사용 */ }
        }
      })
      .catch(() => {})
      .finally(() => { asideKvLoadedRef.current = true; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!asideKvLoadedRef.current) return;
    const t = window.setTimeout(() => {
      void invoke('kv_set', {
        key: 'browser-aside-state',
        value: JSON.stringify({ open: showDeepSeekAgent, pane: asidePane, width: asideWidth }),
      }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [showDeepSeekAgent, asidePane, asideWidth]);
  // Ctrl+. — 사이드바 토글(열면 챗 패널). 벤치마크 표준 문법(§3).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '.') {
        e.preventDefault();
        setShowDeepSeekAgent((prev) => {
          if (!prev) setAsidePane('agent');
          return !prev;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 폭 드래그 동안 WebView 탭 숨김(네이티브 뷰가 mousemove를 가로채는 것 방지 — 기존 독 관례).
  const asideDragStart = useCallback(() => {
    const id = cefActiveIdRef.current;
    if (id != null) void invoke('cef_set_visible', { id, visible: false }).catch(() => {});
  }, []);
  const asideDragEnd = useCallback(() => {
    const id = cefActiveIdRef.current;
    if (id != null) {
      void invoke('cef_set_visible', { id, visible: true }).catch(() => {});
      window.setTimeout(() => cefSyncBounds(id), 30);
    }
  }, [cefSyncBounds]);
  const [seoReport, setSeoReport] = useState<SeoReport | null>(null);
  const [seoRunning, setSeoRunning] = useState(false);
  const [seoMaxPages, setSeoMaxPages] = useState(30);
  const [seoProgress, setSeoProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [seoFilter, setSeoFilter] = useState<string>('all');
  const [seoReportBusy, setSeoReportBusy] = useState(false);
  const [seoReportStatus, setSeoReportStatus] = useState('');
  const [seoReportMarkdown, setSeoReportMarkdown] = useState('');
  const [seoFixPromptMarkdown, setSeoFixPromptMarkdown] = useState('');
  // 빠릿에이전트에 주입할 초기 작업 — 현재 URL 컨텍스트와 browser 도구 사용 지시 포함.
  const agentBrowserPrompt = useMemo(() => deepSeekInitialTask
    ? `${deepSeekInitialTask}\n\n[브라우저 컨텍스트] 현재 BBARIT Browser URL: ${currentUrl || '(빈 탭)'} — 페이지 확인·조작은 browser 도구로 내장 BBARIT Browser를 제어해서 수행해.`
    : '', [deepSeekInitialTask, currentUrl]);
  // 사이드바가 --dsa-width를 소유한다: 열림=패널폭+rail(36), 접힘=rail만.
  // 기존 오프셋 CSS(.agent-open right/margin-right: var(--dsa-width))를 그대로
  // 재사용하기 위해 같은 변수명을 쓴다. (구 localStorage 폭 복원은 kv로 대체됨)
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--dsa-width',
      `${showDeepSeekAgent ? asideWidth + 36 : 36}px`,
    );
  }, [showDeepSeekAgent, asideWidth]);
  const [projectNudge, setProjectNudge] = useState(false);
  const seoStopRef = useRef(false);
  const projectNudgeTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const exactWsRef = useRef<WebSocket | null>(null);
  const exactBrowserWsRef = useRef<WebSocket | null>(null);
  const cdpIdRef = useRef(0);
  const cdpBrowserIdRef = useRef(0);
  const cdpPendingRef = useRef(new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>());
  const cdpBrowserPendingRef = useRef(new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>());
  const consoleEntriesRef = useRef<BrowserConsoleEntry[]>([]);
  const networkEntriesRef = useRef<BrowserNetworkEntry[]>([]);
  const networkRecordsRef = useRef<Map<string, BrowserNetworkRecord>>(new Map());
  const networkConditionsRef = useRef<BrowserNetworkConditions | null>(null);
  const defaultUserAgentRef = useRef<string | null>(null);
  const userAgentOverrideRef = useRef<string | null>(null);
  const timezoneOverrideRef = useRef<string | null>(null);
  const downloadRecordsRef = useRef<Map<string, BrowserDownloadRecord>>(new Map());
  // Visible downloads shelf: mirrors downloadRecordsRef (which agent APIs read)
  // into render state, newest first. Auto-opens whenever a download starts.
  const [downloads, setDownloads] = useState<BrowserDownloadRecord[]>([]);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const autoResponderRulesRef = useRef<BrowserAutoResponderRule[]>([]);
  const autoResponderActiveRef = useRef(false);
  const breakpointRulesRef = useRef<BrowserBreakpointRule[]>([]);
  const breakpointActiveRef = useRef(false);
  const pausedBreakpointRef = useRef<BrowserPausedBreakpoint | null>(null);
  const breakpointBypassRef = useRef<Set<string>>(new Set());
  const fetchInterceptionEnabledRef = useRef(false);
  const lastDialogRef = useRef<{
    type: string;
    message: string;
    defaultPrompt?: string;
    url?: string;
    openedAt: string;
    handled?: boolean;
    handledAt?: string;
    accept?: boolean;
  } | null>(null);
  const activeChromeTargetIdRef = useRef<string | null>(null);
  // Remember this project's last page so reopening the browser for the codebase resumes there.
  useEffect(() => {
    const root = projectRoot || initialProjectRoot;
    saveProjectUrl(root, currentUrl);
  }, [currentUrl, projectRoot, initialProjectRoot]);

  const cdpSend = useCallback((method: string, params?: Record<string, unknown>): Promise<any> => {
    const ws = exactWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Exact Chrome renderer is not connected.'));
    }
    const id = ++cdpIdRef.current;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cdpPendingRef.current.delete(id);
        reject(new Error(`Chrome protocol timeout: ${method}`));
      }, 7000);
      cdpPendingRef.current.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }, []);

  const cdpFire = useCallback((method: string, params?: Record<string, unknown>) => {
    const ws = exactWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Exact Chrome renderer is not connected.');
    }
    const id = ++cdpIdRef.current;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return { sent: true, id, method };
  }, []);

  const cdpBrowserSend = useCallback((method: string, params?: Record<string, unknown>): Promise<any> => {
    const ws = exactBrowserWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Exact Chrome browser controller is not connected.'));
    }
    const id = ++cdpBrowserIdRef.current;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cdpBrowserPendingRef.current.delete(id);
        reject(new Error(`Chrome browser protocol timeout: ${method}`));
      }, 7000);
      cdpBrowserPendingRef.current.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }, []);

  const cdpBrowserSessionSend = useCallback((sessionId: string, method: string, params?: Record<string, unknown>): Promise<any> => {
    const ws = exactBrowserWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Exact Chrome browser controller is not connected.'));
    }
    const id = ++cdpBrowserIdRef.current;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cdpBrowserPendingRef.current.delete(id);
        reject(new Error(`Chrome browser protocol timeout: ${method}`));
      }, 7000);
      cdpBrowserPendingRef.current.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, sessionId, method, params: params || {} }));
    });
  }, []);

  const configureFetchInterception = useCallback(async () => {
    const wantsRequestInterception = (autoResponderActiveRef.current && autoResponderRulesRef.current.some((rule) => rule.enabled && rule.urlPattern))
      || (breakpointActiveRef.current && breakpointRulesRef.current.some((rule) => rule.enabled && rule.urlPattern && (rule.phase || 'request') !== 'response'));
    const wantsResponseInterception = breakpointActiveRef.current
      && breakpointRulesRef.current.some((rule) => rule.enabled && rule.urlPattern && ((rule.phase || 'request') === 'response' || rule.phase === 'both'));
    const wantsInterception = wantsRequestInterception || wantsResponseInterception;
    if (wantsInterception && !fetchInterceptionEnabledRef.current) {
      const patterns = [
        ...(wantsRequestInterception ? [{ urlPattern: '*', requestStage: 'Request' }] : []),
        ...(wantsResponseInterception ? [{ urlPattern: '*', requestStage: 'Response' }] : []),
      ];
      await cdpSend('Fetch.enable', {
        patterns,
        handleAuthRequests: false,
      });
      fetchInterceptionEnabledRef.current = true;
      return;
    }
    if (wantsInterception && fetchInterceptionEnabledRef.current) {
      await cdpSend('Fetch.disable').catch(() => {});
      fetchInterceptionEnabledRef.current = false;
      pausedBreakpointRef.current = null;
      breakpointBypassRef.current.clear();
      await cdpSend('Fetch.enable', {
        patterns: [
          ...(wantsRequestInterception ? [{ urlPattern: '*', requestStage: 'Request' }] : []),
          ...(wantsResponseInterception ? [{ urlPattern: '*', requestStage: 'Response' }] : []),
        ],
        handleAuthRequests: false,
      });
      fetchInterceptionEnabledRef.current = true;
      return;
    }
    if (!wantsInterception && fetchInterceptionEnabledRef.current) {
      await cdpSend('Fetch.disable').catch(() => {});
      fetchInterceptionEnabledRef.current = false;
      pausedBreakpointRef.current = null;
      breakpointBypassRef.current.clear();
    }
  }, [cdpSend]);

  const closeExactPageSocket = useCallback(() => {
    const ws = exactWsRef.current;
    exactWsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    for (const pending of cdpPendingRef.current.values()) {
      pending.reject(new Error('Chrome page target closed.'));
    }
    cdpPendingRef.current.clear();
  }, []);

  const refreshActiveTabTitle = useCallback(async () => {
    if (!exactWsRef.current || exactWsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      await cdpSend('Runtime.evaluate', {
        expression: 'document.title || location.href',
        returnByValue: true,
      });
    } catch {
      // Title is best-effort during early navigation.
    }
  }, [cdpSend]);

  const pushConsoleEntry = useCallback((entry: BrowserConsoleEntry) => {
    consoleEntriesRef.current = [...consoleEntriesRef.current.slice(-199), entry];
  }, []);

  const pushNetworkEntry = useCallback((entry: BrowserNetworkEntry) => {
    networkEntriesRef.current = [...networkEntriesRef.current.slice(-299), entry];
  }, []);

  const syncDownloadsState = useCallback(() => {
    setDownloads(
      Array.from(downloadRecordsRef.current.values())
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')),
    );
  }, []);

  const upsertDownloadRecord = useCallback((guid: string, patch: Partial<BrowserDownloadRecord>) => {
    if (!guid) return;
    const now = new Date().toISOString();
    const existing = downloadRecordsRef.current.get(guid);
    const state = patch.state || existing?.state || 'started';
    const finished = state === 'completed' || state === 'canceled' || state === 'failed';
    const next: BrowserDownloadRecord = {
      guid,
      url: '',
      startedAt: existing?.startedAt || patch.startedAt || now,
      updatedAt: now,
      ...existing,
      ...patch,
      state,
      finishedAt: finished ? (patch.finishedAt || existing?.finishedAt || now) : patch.finishedAt || existing?.finishedAt,
    };
    downloadRecordsRef.current.set(guid, next);
    while (downloadRecordsRef.current.size > 200) {
      const oldest = downloadRecordsRef.current.keys().next().value;
      if (!oldest) break;
      downloadRecordsRef.current.delete(oldest);
    }
    syncDownloadsState();
  }, [syncDownloadsState]);

  const removeDownloadRecord = useCallback((guid: string) => {
    downloadRecordsRef.current.delete(guid);
    syncDownloadsState();
  }, [syncDownloadsState]);

  const clearDownloadRecords = useCallback(() => {
    downloadRecordsRef.current.clear();
    syncDownloadsState();
  }, [syncDownloadsState]);

  const handleFetchPaused = useCallback(async (params: any) => {
    const requestId = String(params?.requestId || '');
    if (!requestId) return;
    const request = params?.request || {};
    const url = String(request.url || '');
    const method = String(request.method || 'GET');
    const resourceType = typeof params?.resourceType === 'string' ? params.resourceType : undefined;
    const networkRequestId = typeof params?.networkId === 'string' ? params.networkId : undefined;
    const stage: BrowserPausedBreakpoint['stage'] = typeof params?.responseStatusCode === 'number' ? 'response' : 'request';
    const breakpointKey = `${stage}:${method} ${url}`;

    const responder = stage === 'request' && autoResponderActiveRef.current
      ? autoResponderRulesRef.current.find((rule) => rule.enabled && browserRuleMatches(rule, url))
      : undefined;
    if (responder) {
      const delayMs = Math.max(0, Math.min(30000, Number(responder.delayMs || 0)));
      if (delayMs > 0) await delay(delayMs);
      const body = String(responder.body ?? '');
      const headers = headerMapToPairs(responder.headers || {}).map(({ name, value }) => ({ name, value }));
      const status = Math.max(100, Math.min(599, Number(responder.status || 200)));
      await cdpSend('Fetch.fulfillRequest', {
        requestId,
        responseCode: status,
        responsePhrase: String(responder.statusText || responder.status || 'OK'),
        responseHeaders: headers.length ? headers : [{ name: 'Content-Type', value: 'application/json' }],
        body: btoa(unescape(encodeURIComponent(body))),
      });
      pushNetworkEntry({
        type: 'response',
        requestId: networkRequestId || requestId,
        url,
        status,
        statusText: String(responder.statusText || 'AutoResponder'),
        resourceType,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const breakpoint = breakpointActiveRef.current
      ? breakpointRulesRef.current.find((rule) => {
        if (!rule.enabled || !browserRuleMatches(rule, url)) return false;
        const phase = rule.phase || 'request';
        return phase === 'both' || phase === stage;
      })
      : undefined;
    if (breakpoint) {
      if (stage === 'request' && breakpointBypassRef.current.has(breakpointKey)) {
        breakpointBypassRef.current.delete(breakpointKey);
        await cdpSend('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }
      pausedBreakpointRef.current = {
        requestId,
        networkRequestId,
        url,
        method,
        stage,
        responseStatusCode: typeof params?.responseStatusCode === 'number' ? params.responseStatusCode : undefined,
        responseStatusText: typeof params?.responseStatusText === 'string' ? params.responseStatusText : undefined,
        resourceType,
        rule: breakpoint,
        pausedAt: new Date().toISOString(),
      };
      return;
    }

    await cdpSend('Fetch.continueRequest', { requestId }).catch(() => {});
  }, [cdpSend, pushNetworkEntry]);

  const upsertNetworkRecord = useCallback((requestId: string, patch: Partial<BrowserNetworkRecord>) => {
    if (!requestId) return;
    const now = Date.now();
    const existing = networkRecordsRef.current.get(requestId);
    const startedAtMs = patch.startedAtMs ?? existing?.startedAtMs ?? now;
    const next: BrowserNetworkRecord = {
      id: requestId,
      requestId,
      url: '',
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      ...existing,
      ...patch,
      requestHeaders: patch.requestHeaders ?? existing?.requestHeaders ?? {},
      responseHeaders: patch.responseHeaders ?? existing?.responseHeaders ?? {},
    };
    if (next.finishedAtMs && next.startedAtMs) {
      next.durationMs = Math.max(0, Math.round(next.finishedAtMs - next.startedAtMs));
    }
    networkRecordsRef.current.set(requestId, next);
    while (networkRecordsRef.current.size > 500) {
      const oldest = networkRecordsRef.current.keys().next().value;
      if (!oldest) break;
      networkRecordsRef.current.delete(oldest);
    }
  }, []);

  const runtimeArgText = useCallback((arg: any): string => {
    if (Object.prototype.hasOwnProperty.call(arg || {}, 'value')) {
      const value = arg.value;
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(arg?.description || arg?.unserializableValue || arg?.type || '');
  }, []);

  const refreshNavigationState = useCallback(async () => {
    if (!exactWsRef.current || exactWsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      const history = await cdpSend('Page.getNavigationHistory');
      const entries = Array.isArray(history?.entries) ? history.entries : [];
      const currentIndex = Number(history?.currentIndex ?? -1);
      setNavState({
        canGoBack: currentIndex > 0,
        canGoForward: currentIndex >= 0 && currentIndex < entries.length - 1,
      });
      const current = entries[currentIndex];
      if (typeof current?.url === 'string' && /^(https?:|file:|data:|about:)/i.test(current.url)) {
        setBrowserLocation(current.url);
      }
    } catch {
      // Navigation history is best-effort while the target is changing.
    }
  }, [cdpSend, setBrowserLocation]);

  const connectExactPageTarget = useCallback((webSocketDebuggerUrl: string, generation: number, targetPatch: BrowserTargetPatch = {}) => new Promise<void>((resolve, reject) => {
    closeExactPageSocket();
    const targetId = targetPatch.targetId || targetIdFromWebSocketUrl(webSocketDebuggerUrl);
    activeChromeTargetIdRef.current = targetId || null;
    const ws = new WebSocket(webSocketDebuggerUrl);
    exactWsRef.current = ws;
    let settled = false;
    const settle = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    };

    ws.onmessage = async (event) => {
      let msg: any = null;
      try {
        const raw = event.data instanceof Blob ? await event.data.text() : String(event.data);
        msg = JSON.parse(raw);
      } catch { return; }
      if (typeof msg.id === 'number') {
        const pending = cdpPendingRef.current.get(msg.id);
        if (!pending) return;
        cdpPendingRef.current.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message || 'Chrome protocol error'));
        else pending.resolve(msg.result);
        return;
      }
      if (msg.method === 'Fetch.requestPaused') {
        void handleFetchPaused(msg.params).catch(() => {
          void cdpSend('Fetch.continueRequest', { requestId: String(msg.params?.requestId || '') }).catch(() => {});
        });
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const params = msg.params || {};
        const frames = params.stackTrace?.callFrames;
        const frame = Array.isArray(frames) ? frames[0] : null;
        const args = Array.isArray(params.args) ? params.args : [];
        pushConsoleEntry({
          type: String(params.type || 'log'),
          text: args.map(runtimeArgText).filter(Boolean).join(' '),
          timestamp: new Date(Number(params.timestamp) || Date.now()).toISOString(),
          url: typeof frame?.url === 'string' ? frame.url : undefined,
          line: typeof frame?.lineNumber === 'number' ? frame.lineNumber + 1 : undefined,
          column: typeof frame?.columnNumber === 'number' ? frame.columnNumber + 1 : undefined,
        });
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails || {};
        const exception = details.exception || {};
        pushConsoleEntry({
          type: 'exception',
          text: String(exception.description || exception.value || details.text || 'Uncaught exception'),
          timestamp: new Date(Number(msg.params?.timestamp) || Date.now()).toISOString(),
          url: typeof details.url === 'string' ? details.url : undefined,
          line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : undefined,
          column: typeof details.columnNumber === 'number' ? details.columnNumber + 1 : undefined,
        });
        return;
      }
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params?.entry || {};
        pushConsoleEntry({
          type: String(entry.level || 'log'),
          text: String(entry.text || ''),
          timestamp: new Date(Number(entry.timestamp) || Date.now()).toISOString(),
          url: typeof entry.url === 'string' ? entry.url : undefined,
          line: typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined,
        });
        return;
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        const params = msg.params || {};
        lastDialogRef.current = {
          type: String(params.type || ''),
          message: String(params.message || ''),
          defaultPrompt: typeof params.defaultPrompt === 'string' ? params.defaultPrompt : undefined,
          url: typeof params.url === 'string' ? params.url : undefined,
          openedAt: new Date().toISOString(),
          handled: false,
        };
        return;
      }
      if (msg.method === 'Page.javascriptDialogClosed') {
        if (lastDialogRef.current) {
          lastDialogRef.current = {
            ...lastDialogRef.current,
            handled: true,
            handledAt: new Date().toISOString(),
            accept: typeof msg.params?.result === 'boolean' ? Boolean(msg.params.result) : lastDialogRef.current.accept,
          };
        }
        return;
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const requestId = String(msg.params?.requestId || '');
        const request = msg.params?.request || {};
        const wallTime = typeof msg.params?.wallTime === 'number' ? msg.params.wallTime * 1000 : Date.now();
        upsertNetworkRecord(requestId, {
          url: String(request.url || ''),
          method: typeof request.method === 'string' ? request.method : undefined,
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          requestHeaders: normalizeHeaders(request.headers),
          postData: typeof request.postData === 'string' ? request.postData : undefined,
          initiator: typeof msg.params?.initiator?.type === 'string' ? msg.params.initiator.type : undefined,
          startedAt: new Date(wallTime).toISOString(),
          startedAtMs: wallTime,
        });
        pushNetworkEntry({
          type: 'request',
          requestId,
          url: String(request.url || ''),
          method: typeof request.method === 'string' ? request.method : undefined,
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (msg.method === 'Network.requestWillBeSentExtraInfo') {
        const requestId = String(msg.params?.requestId || '');
        upsertNetworkRecord(requestId, {
          requestHeaders: normalizeHeaders(msg.params?.headers),
        });
        return;
      }
      if (msg.method === 'Network.responseReceived') {
        const requestId = String(msg.params?.requestId || '');
        const response = msg.params?.response || {};
        upsertNetworkRecord(requestId, {
          url: String(response.url || ''),
          status: typeof response.status === 'number' ? response.status : undefined,
          statusText: typeof response.statusText === 'string' ? response.statusText : undefined,
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          responseHeaders: normalizeHeaders(response.headers),
          mimeType: typeof response.mimeType === 'string' ? response.mimeType : undefined,
          protocol: typeof response.protocol === 'string' ? response.protocol : undefined,
          remoteIPAddress: typeof response.remoteIPAddress === 'string' ? response.remoteIPAddress : undefined,
          fromDiskCache: Boolean(response.fromDiskCache),
        });
        pushNetworkEntry({
          type: 'response',
          requestId,
          url: String(response.url || ''),
          status: typeof response.status === 'number' ? response.status : undefined,
          statusText: typeof response.statusText === 'string' ? response.statusText : undefined,
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (msg.method === 'Network.responseReceivedExtraInfo') {
        const requestId = String(msg.params?.requestId || '');
        upsertNetworkRecord(requestId, {
          status: typeof msg.params?.statusCode === 'number' ? msg.params.statusCode : undefined,
          responseHeaders: normalizeHeaders(msg.params?.headers),
        });
        return;
      }
      if (msg.method === 'Network.requestServedFromCache') {
        upsertNetworkRecord(String(msg.params?.requestId || ''), { fromDiskCache: true });
        return;
      }
      if (msg.method === 'Network.loadingFinished') {
        const finishedAtMs = Date.now();
        upsertNetworkRecord(String(msg.params?.requestId || ''), {
          finishedAt: new Date(finishedAtMs).toISOString(),
          finishedAtMs,
          encodedDataLength: typeof msg.params?.encodedDataLength === 'number' ? msg.params.encodedDataLength : undefined,
          transferSize: typeof msg.params?.encodedDataLength === 'number' ? msg.params.encodedDataLength : undefined,
        });
        return;
      }
      if (msg.method === 'Network.loadingFailed') {
        const requestId = String(msg.params?.requestId || '');
        const finishedAtMs = Date.now();
        upsertNetworkRecord(requestId, {
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          failed: true,
          errorText: typeof msg.params?.errorText === 'string' ? msg.params.errorText : undefined,
          finishedAt: new Date(finishedAtMs).toISOString(),
          finishedAtMs,
        });
        pushNetworkEntry({
          type: 'failed',
          requestId,
          url: '',
          resourceType: typeof msg.params?.type === 'string' ? msg.params.type : undefined,
          errorText: typeof msg.params?.errorText === 'string' ? msg.params.errorText : undefined,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.domContentEventFired' || msg.method === 'Page.frameStoppedLoading') {
        setIsLoading(false);
        void refreshNavigationState();
        void refreshActiveTabTitle();
      }
      if (msg.method === 'Page.frameNavigated') {
        const nextUrl = msg.params?.frame?.url;
        if (typeof nextUrl === 'string' && /^(https?:|file:|data:|about:)/i.test(nextUrl)) {
          setBrowserLocation(nextUrl);
        }
        void refreshNavigationState();
      }
    };

    ws.onopen = () => {
      void (async () => {
        if (generationRef.current !== generation) return;
        setError(null);
        await cdpSend('Page.enable');
        await cdpSend('Runtime.enable').catch(() => {});
        await cdpSend('Log.enable').catch(() => {});
        await cdpSend('Network.enable', { maxResourceBufferSize: 10485760, maxTotalBufferSize: 52428800 }).catch(() => {});
        // Fetch interception stays OFF by default. It is enabled only while explicit
        // CLI breakpoint/autoresponder rules are active; unmatched requests continue
        // immediately, avoiding the old catch-all freeze mode.
        await configureFetchInterception().catch(() => {});
        // Stealth: headless Chrome leaks "HeadlessChrome" in the UA/sec-ch-ua and navigator.webdriver=true,
        // which real sites use to block bots. Strip those so analysis works on bot-detecting sites.
        await (async () => {
          try {
            const uaRes = await cdpSend('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
            const rawUa: string = uaRes?.result?.value || '';
            // Only override the UA in headless mode (UA carries "HeadlessChrome"). In headed
            // mode the native UA + client hints are already a perfect, self-consistent set;
            // a manual override risks a sec-ch-ua/UA mismatch that bot-managers (Akamai) flag.
            if (/Headless/i.test(rawUa)) {
              const ua = rawUa.replace(/HeadlessChrome/g, 'Chrome');
              const mver = (ua.match(/Chrome\/(\d+)/) || [])[1] || '147';
              await cdpSend('Network.setUserAgentOverride', {
                userAgent: ua,
                userAgentMetadata: {
                  // GREASE brand first, matching real Chrome's client-hint ordering.
                  brands: [{ brand: 'Not?A_Brand', version: '24' }, { brand: 'Chromium', version: mver }, { brand: 'Google Chrome', version: mver }],
                  fullVersion: `${mver}.0.0.0`, platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false,
                },
              }).catch(() => {});
            }
            // Comprehensive stealth (JS-injection only - NO Fetch header rewriting, which
            // previously stalled requests -> zombie Chrome -> freeze). Spoofs are CONDITIONAL:
            // each activates only when the underlying value betrays headless/automation, so
            // real headed Chrome keeps its genuine, self-consistent fingerprint - which is
            // exactly what bot-managers like Akamai trust. Clobbering real plugins/WebGL with
            // hardcoded fakes (the old behaviour) was itself a bot tell in headed mode.
            await cdpSend('Page.addScriptToEvaluateOnNewDocument', {
              source:
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});" +
                "if(!window.chrome){window.chrome={runtime:{},loadTimes:function(){},csi:function(){},app:{isInstalled:false}};}" +
                "try{if(!navigator.languages||!navigator.languages.length){Object.defineProperty(navigator,'languages',{get:()=>['ko-KR','ko','en-US','en']});}}catch(e){}" +
                "try{if(!navigator.plugins||navigator.plugins.length===0){var _pp=['PDF Viewer','Chrome PDF Viewer','Chromium PDF Viewer','Microsoft Edge PDF Viewer','WebKit built-in PDF'].map(function(n){return{name:n,filename:'internal-pdf-viewer',description:'Portable Document Format'};});Object.defineProperty(navigator,'plugins',{get:()=>_pp});}}catch(e){}" +
                "try{var _q=navigator.permissions&&navigator.permissions.query;if(_q){navigator.permissions.query=function(p){return p&&p.name==='notifications'?Promise.resolve({state:(typeof Notification!=='undefined'?Notification.permission:'default')}):_q.call(navigator.permissions,p);};}}catch(e){}" +
                "try{var _spoofGl=function(proto){if(!proto||!proto.prototype)return;var _g=proto.prototype.getParameter;proto.prototype.getParameter=function(p){if(p===37445)return'Google Inc. (Intel)';if(p===37446)return'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';return _g.call(this,p);};};var _cv=document.createElement('canvas');var _gl=_cv.getContext('webgl')||_cv.getContext('experimental-webgl');var _rn='';try{var _ex=_gl&&_gl.getExtension('WEBGL_debug_renderer_info');if(_ex)_rn=String(_gl.getParameter(_ex.UNMASKED_RENDERER_WEBGL)||'');}catch(_e){}if(!_gl||/SwiftShader|Software|Google|llvmpipe/i.test(_rn)){_spoofGl(window.WebGLRenderingContext);_spoofGl(window.WebGL2RenderingContext);}}catch(e){}",
            }).catch(() => {});
            const defaultUaRes = await cdpSend('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }).catch(() => null);
            defaultUserAgentRef.current = String(defaultUaRes?.result?.value || uaRes?.result?.value || '');
            userAgentOverrideRef.current = null;
            timezoneOverrideRef.current = null;
          } catch { /* best-effort stealth */ }
        })();
        await cdpSend('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
        void refreshNavigationState();
        setIsLoading(false);
        settle();
      })().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
        settle(err);
      });
    };

    ws.onerror = () => {
      if (generationRef.current !== generation || exactWsRef.current !== ws) return;
      const err = new Error('Exact Chrome renderer WebSocket failed.');
      setError(err.message);
      setIsLoading(false);
      settle(err);
    };
  }), [cdpSend, closeExactPageSocket, configureFetchInterception, handleFetchPaused, pushConsoleEntry, pushNetworkEntry, refreshActiveTabTitle, refreshNavigationState, runtimeArgText, setBrowserLocation, upsertNetworkRecord]);

  // ── WebView 브라우저 레벨 CDP 소켓 ──
  // /json/version의 webSocketDebuggerUrl(브라우저 타깃)에 붙는다. cdpBrowserSend/
  // cdpBrowserSessionSend(권한·다운로드·타깃 명령)와 Browser.downloadWillBegin/
  // downloadProgress 이벤트 수집이 이 소켓으로 동작한다.
  const connectCefBrowserSocket = useCallback(async () => {
    if (exactBrowserWsRef.current?.readyState === WebSocket.OPEN) return true;
    try {
      const res = await invoke<{ status: number; body?: string }>('http_request', {
        input: { method: 'GET', url: 'http://127.0.0.1:9666/json/version', headers: {}, body: null, timeout_ms: 4000 },
      });
      const info = JSON.parse(String(res?.body || '{}'));
      const wsUrl = String(info?.webSocketDebuggerUrl || '');
      if (!wsUrl) return false;
      const prev = exactBrowserWsRef.current;
      exactBrowserWsRef.current = null;
      if (prev && prev.readyState <= WebSocket.OPEN) prev.close();
      for (const pending of cdpBrowserPendingRef.current.values()) {
        pending.reject(new Error('Chrome browser session closed.'));
      }
      cdpBrowserPendingRef.current.clear();
      const browserWs = new WebSocket(wsUrl);
      exactBrowserWsRef.current = browserWs;
      browserWs.onmessage = async (event) => {
        let msg: any = null;
        try {
          const raw = event.data instanceof Blob ? await event.data.text() : String(event.data);
          msg = JSON.parse(raw);
        } catch { return; }
        if (typeof msg.id === 'number') {
          const pending = cdpBrowserPendingRef.current.get(msg.id);
          if (!pending) return;
          cdpBrowserPendingRef.current.delete(msg.id);
          if (msg.error) pending.reject(new Error(msg.error.message || 'Chrome browser protocol error'));
          else pending.resolve(msg.result);
          return;
        }
        if (msg.method === 'Browser.downloadWillBegin') {
          const params = msg.params || {};
          const guid = String(params.guid || '');
          upsertDownloadRecord(guid, {
            guid,
            url: String(params.url || ''),
            suggestedFilename: typeof params.suggestedFilename === 'string' ? params.suggestedFilename : undefined,
            state: 'started',
            startedAt: new Date().toISOString(),
          });
          return;
        }
        if (msg.method === 'Browser.downloadProgress') {
          const params = msg.params || {};
          const guid = String(params.guid || '');
          const state = params.state === 'completed' || params.state === 'canceled' || params.state === 'inProgress'
            ? params.state
            : 'inProgress';
          upsertDownloadRecord(guid, {
            guid,
            state,
            totalBytes: typeof params.totalBytes === 'number' ? params.totalBytes : undefined,
            receivedBytes: typeof params.receivedBytes === 'number' ? params.receivedBytes : undefined,
            filePath: typeof params.filePath === 'string' ? params.filePath : undefined,
          });
        }
      };
      await new Promise<void>((resolve, reject) => {
        browserWs.onopen = () => resolve();
        browserWs.onerror = () => reject(new Error('Exact Chrome browser controller WebSocket failed.'));
      });
      return true;
    } catch {
      return false;
    }
  }, [upsertDownloadRecord]);

  // ── WebView CDP attach ──
  // 내장 Chromium의 DevTools 엔드포인트(127.0.0.1:9666)에 기존 CDP 세션 플러밍
  // (connectExactPageTarget)을 그대로 붙인다. 덕분에 eval/screenshot/packets/
  // console/cdp 등 __BBARIT_BROWSER__ 전체와 agent-browser-cli가 WebView 위에서
  // 무수정 동작한다. /json 조회는 CORS가 없는 http_request 프록시 사용.
  // 페이지 타깃과 함께 브라우저 레벨 소켓도 붙여 권한/다운로드 명령이 동작한다.
  const cefAttachCdp = useCallback(async (urlHint?: string) => {
    try {
      const res = await invoke<{ status: number; body?: string }>('http_request', {
        input: { method: 'GET', url: 'http://127.0.0.1:9666/json', headers: {}, body: null, timeout_ms: 4000 },
      });
      const targets = JSON.parse(String(res?.body || '[]'));
      const pages = (Array.isArray(targets) ? targets : []).filter((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!pages.length) return false;
      const hint = (urlHint || '').replace(/\/$/, '');
      const hintHost = (() => { try { return hint ? new URL(hint).host : ''; } catch { return ''; } })();
      const target = (hint && pages.find((t: any) => String(t.url || '').replace(/\/$/, '') === hint))
        || (hintHost && pages.find((t: any) => {
          try { return new URL(String(t.url || '')).host === hintHost; } catch { return false; }
        }))
        || pages.find((t: any) => /^https?:/i.test(String(t.url || '')))
        || pages[0];
      generationRef.current += 1;
      await connectExactPageTarget(String(target.webSocketDebuggerUrl), generationRef.current, { targetId: String(target.id || '') });
      // 브라우저 소켓은 best-effort: 실패해도 페이지 세션(eval/screenshot 등)은 동작.
      await connectCefBrowserSocket().catch(() => false);
      return true;
    } catch {
      return false;
    }
  }, [connectCefBrowserSocket, connectExactPageTarget]);
  useEffect(() => { cefAttachRef.current = cefAttachCdp; }, [cefAttachCdp]);

  const exactSessionUsable = useCallback(async () => {
    if (exactWsRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      await Promise.race([
        cdpSend('Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        }),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('CDP health check timeout')), 1500)),
      ]);
      return true;
    } catch {
      try { exactWsRef.current?.close(); } catch {}
      exactWsRef.current = null;
      return false;
    }
  }, [cdpSend]);

  const ensureLiveSession = useCallback(async (startUrl?: string) => {
    if (await exactSessionUsable()) return true;
    if (!cefMode) return false;
    // WebView 모드: 숨김 크롬을 절대 콜드스타트하지 않는다 — 내장 탭에 attach.
    if (cefTabsRef.current.length === 0) {
      const id = await cefOpenTab(normalizeUrl(startUrl || currentUrl || address || DEFAULT_URL));
      if (id == null) return false;
      await new Promise((r) => window.setTimeout(r, 900));
    }
    const active = cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current);
    const activeUrl = String(active?.url || '');
    const attachHint = startUrl
      || (/^https?:/i.test(activeUrl) ? activeUrl : '')
      || currentUrlRef.current
      || addressRef.current
      || currentUrl
      || address;
    if (!(await cefAttachCdp(attachHint))) return false;
    return exactSessionUsable();
  }, [address, cefAttachCdp, cefMode, cefOpenTab, currentUrl, exactSessionUsable]);

  const loadUrl = useCallback(async (url: string) => {
    const target = normalizeUrl(url);
    setBrowserLocation(target);
    setIsLoading(true);
    if (!(await ensureLiveSession(target))) {
      // CDP 미가용(macOS WKWebView): 네이티브 네비게이션 폴백 — 히스토리/클립/
      // SEO 크롤의 페이지 이동이 CDP 없이도 동작해야 한다.
      if (cefActiveIdRef.current != null) {
        updateCefTabLocation(cefActiveIdRef.current, target, 'push', true);
        await invoke('cef_navigate', { id: cefActiveIdRef.current, url: target }).catch(() => {});
      } else {
        await cefOpenTab(target);
      }
      setIsLoading(false);
      return;
    }
    // 붙어 있는 CDP 세션에서 직접 네비게이션한다(cef_navigate는 타깃을 갈아치워
    // 로드 중 Network/console/packet 이벤트를 놓친다 — Page.navigate로 캡처 유지).
    await cdpSend('Page.navigate', { url: target });
    await refreshNavigationState();
  }, [cdpSend, cefOpenTab, ensureLiveSession, refreshNavigationState, setBrowserLocation, updateCefTabLocation]);

  const goCefHistory = useCallback(async (delta: -1 | 1) => {
    const id = cefActiveIdRef.current;
    if (id == null) return { ok: false, reason: 'no-active-tab' };
    const tab = cefTabsRef.current.find((t) => t.id === id);
    if (!tab) return { ok: false, reason: 'tab-missing' };
    const history = tab.history?.length ? tab.history : [tab.url].filter(Boolean);
    const currentIndex = Number.isFinite(tab.historyIndex) ? tab.historyIndex : history.length - 1;
    const nextIndex = currentIndex + delta;
    if (nextIndex < 0 || nextIndex >= history.length) {
      await invoke('cef_nav_action', { id, action: delta < 0 ? 'back' : 'forward' }).catch(() => {});
      return { ok: true, nativeFallback: true, reason: delta < 0 ? 'local-history-at-start' : 'local-history-at-end', status: (window as any).__BBARIT_BROWSER__?.status?.() };
    }
    const target = history[nextIndex];
    cefTabsRef.current = cefTabsRef.current.map((t) => (
      t.id === id ? { ...withCefHistory(t, target, 'index', nextIndex), loading: true } : t
    ));
    setCefTabs(cefTabsRef.current);
    setBrowserLocation(target);
    setIsLoading(true);
    pendingCefHistoryNavRef.current.set(id, { url: target, index: nextIndex, expiresAt: Date.now() + 10000 });
    await invoke('cef_navigate', { id, url: target }).catch(() => invoke('cef_nav_action', { id, action: delta < 0 ? 'back' : 'forward' }).catch(() => {}));
    window.setTimeout(() => { void cefAttachRef.current(target); }, 500);
    return { ok: true, url: target, historyIndex: nextIndex, historyLength: history.length };
  }, [setBrowserLocation, withCefHistory]);

  // 언마운트 시 WebView CDP 소켓(페이지 + 브라우저 레벨)을 정리한다.
  useEffect(() => {
    return () => {
      closeExactPageSocket();
      const browserWs = exactBrowserWsRef.current;
      exactBrowserWsRef.current = null;
      if (browserWs && browserWs.readyState <= WebSocket.OPEN) browserWs.close();
      for (const pending of cdpBrowserPendingRef.current.values()) {
        pending.reject(new Error('Chrome browser session closed.'));
      }
      cdpBrowserPendingRef.current.clear();
    };
  }, [closeExactPageSocket]);

  // Windows CJK IME: the Enter that CONFIRMS an IME composition is consumed by the IME, so the
  // address form's implicit submit never fired and the URL never navigated. Track composition
  // and a pending-Enter so we navigate right after the text commits.
  const addrComposingRef = useRef(false);
  const addrEnterPendingRef = useRef(false);
  const clearSeoResultsForTargetChange = useCallback((target: string) => {
    if (normalizeUrl(target) === normalizeUrl(currentUrl)) return;
    setSeoReport(null);
    setSeoProgress(null);
    setSeoFilter('all');
    setSeoReportMarkdown('');
    setSeoFixPromptMarkdown('');
  }, [currentUrl]);
  // 사이드바 태스크 실행 경로(Aside 문법): 최근 태스크 기록 → 민감 태스크는 승인
  // 게이트로 보류 → 감사 로그 → 기존 주입 경로(initialPrompt+nonce)로 전송.
  const injectAgentTask = useCallback((text: string) => {
    setDeepSeekInitialTask(text);
    setDeepSeekInitialTaskRequiresProject(false);
    setDeepSeekInitialTaskNonce((value) => value + 1);
  }, []);
  const runAsideTask = useCallback((text: string) => {
    const task = text.trim();
    if (!task) return;
    setAsideRecentTasks((prev) => {
      const next = [{ id: Date.now().toString(36), text: task, at: Date.now() }, ...prev.filter((t) => t.text !== task)].slice(0, 20);
      void kvSet('bbarit-browser-recent-tasks', JSON.stringify(next));
      return next;
    });
    setAsidePane('agent');
    setShowDeepSeekAgent(true);
    if (SENSITIVE_TASK_RE.test(task)) {
      setPendingAgentTask(task);
      recordAsideAudit('gate', task);
      return;
    }
    recordAsideAudit('task', task);
    injectAgentTask(task);
  }, [injectAgentTask, recordAsideAudit]);
  runAsideTaskRef.current = runAsideTask;
  // 스킬 실행: 스킬 프롬프트를 어사이드 태스크로 — 페이지 컨텍스트 접합·승인 게이트 통과.
  const runAsideSkill = useCallback((skill: { name: string; command: string }) => {
    recordAsideAudit('skill', skill.name);
    runAsideTask(skill.command);
  }, [recordAsideAudit, runAsideTask]);
  // AI omnibox: URLs navigate, keyword queries search, natural-language questions
  // ("이 페이지 요약해줘", "@ ...", "summarize this page") open the agent with the
  // question preloaded. The question is a task, not an address, so the bar is
  // restored to the current URL and the user confirms the run in the agent panel.
  const submitAddress = useCallback((raw: string = address) => {
    const intent = classifyOmniboxInput(raw);
    if (intent.kind === 'ask') {
      runAsideTask(intent.question);
      setAddress(currentUrl);
      return;
    }
    const target = intent.url;
    if (!seoRunning && !seoReportBusy) clearSeoResultsForTargetChange(target);
    void loadUrl(target);
  }, [address, clearSeoResultsForTargetChange, currentUrl, loadUrl, runAsideTask, seoReportBusy, seoRunning]);

  const useDetectedLocalTarget = useCallback(async () => {
    if (detectingLocalTarget) return;
    if (!isTauri()) {
      setSeoReportStatus('Open this workspace in the BBARIT desktop app to scan local dev servers.');
      return;
    }
    setDetectingLocalTarget(true);
    setSeoReportStatus('Scanning localhost ports for the project app...');
    try {
      const localUrl = await findLocalDevServer();
      if (!localUrl) {
        setSeoReportStatus('No local dev server found. Start your app, then try again.');
        return;
      }
      if (!seoRunning && !seoReportBusy) clearSeoResultsForTargetChange(localUrl);
      setBrowserLocation(localUrl);
      setSeoReportStatus('SEO target set to ' + localUrl + '.');
      await loadUrl(localUrl);
    } catch (error) {
      setSeoReportStatus(('Local app detection failed: ' + (error instanceof Error ? error.message : String(error))).slice(0, 220));
    } finally {
      setDetectingLocalTarget(false);
    }
  }, [clearSeoResultsForTargetChange, detectingLocalTarget, loadUrl, seoReportBusy, seoRunning, setBrowserLocation]);

  const pickProjectRoot = useCallback(async () => {
    if (!isTauri()) {
      setSeoReportStatus('Open this workspace in the BBARIT desktop app to choose a project folder.');
      return;
    }
    try {
      const selected = await invoke<string | null>('open_folder_dialog');
      const root = String(selected || '').trim();
      if (!root) return;
      setProjectRoot(root);
      saveProjectRoot(root);
      setSeoReportStatus('Project folder set: ' + projectRootLabel(root) + '.');
    } catch (error) {
      setSeoReportStatus(('Project folder selection failed: ' + (error instanceof Error ? error.message : String(error))).slice(0, 220));
    }
  }, []);

  useEffect(() => {
    const onProjectRequired = () => {
      setProjectNudge(true);
      setSeoReportStatus(isTauri()
        ? 'Set Project in the toolbar first so Agent can edit files.'
        : 'Open this workspace in the BBARIT desktop app to choose a project folder for Agent edits.');
      if (projectNudgeTimerRef.current !== null) window.clearTimeout(projectNudgeTimerRef.current);
      projectNudgeTimerRef.current = window.setTimeout(() => {
        setProjectNudge(false);
        projectNudgeTimerRef.current = null;
      }, 1400);
    };
    window.addEventListener('bbarit-browser-project-required', onProjectRequired);
    return () => {
      window.removeEventListener('bbarit-browser-project-required', onProjectRequired);
      if (projectNudgeTimerRef.current !== null) window.clearTimeout(projectNudgeTimerRef.current);
    };
  }, []);

  // ── 기본 브라우저 동작: 정지·홈·페이지 내 찾기·줌 ──
  const stopLoading = useCallback(async () => {
    if (cefActiveIdRef.current != null) {
      await invoke('cef_nav_action', { id: cefActiveIdRef.current, action: 'stop' }).catch(() => {});
    }
    setIsLoading(false);
    return { stopped: true, engine: 'webview' };
  }, []);

  const goHome = useCallback(async (url = DEFAULT_BROWSER_URL) => {
    const target = normalizeUrl(url);
    await loadUrl(target);
    return { url: target };
  }, [loadUrl]);

  // 페이지 내 찾기 — WebView 네이티브 find(매치 하이라이트 UI 포함) 사용.
  const findInPage = useCallback(async (query: string, backwards = false, findNext = true) => {
    const q = query.trim();
    if (!q) return { query: q, found: false, forward: !backwards, findNext, reason: 'empty-query' };
    if (cefActiveIdRef.current != null) {
      await invoke('cef_find', { id: cefActiveIdRef.current, query: q, forward: !backwards, findNext }).catch(() => {});
    }
    return { query: q, found: true, forward: !backwards, findNext, engine: 'webview' };
  }, []);

  // WebView: 진짜 브라우저 줌(레이아웃 줌). 크롬 스텝(1.2^level)과 동일.
  const applyZoom = useCallback(async (percent: number) => {
    const clamped = Math.max(25, Math.min(500, Math.round(percent)));
    if (cefActiveIdRef.current != null) {
      const action = clamped === 100 ? 'reset' : clamped > zoomPercentRef.current ? 'in' : 'out';
      const level = await invoke<number>('cef_zoom', { id: cefActiveIdRef.current, action }).catch(() => 0);
      const actualPercent = Math.round(Math.pow(1.2, Number(level) || 0) * 100);
      setZoomPercent(actualPercent);
      zoomPercentRef.current = actualPercent;
      return { percent: actualPercent, requestedPercent: clamped, level, engine: 'webview' };
    }
    return { percent: zoomPercentRef.current, requestedPercent: clamped, engine: 'webview', reason: 'no-active-tab' };
  }, [zoomPercent]);

  const zoomInPage = useCallback(async (action: string | number = 'reset') => {
    const raw = String(action || 'reset').toLowerCase();
    const numeric = typeof action === 'number' || /^-?\d+(\.\d+)?$/.test(raw);
    const target = numeric
      ? Number(action)
      : raw === 'in' || raw === 'plus' || raw === '+'
        ? zoomPercent + 10
        : raw === 'out' || raw === 'minus' || raw === '-'
          ? zoomPercent - 10
          : 100;
    return applyZoom(target);
  }, [applyZoom, zoomPercent]);

  // WebView: 찾기 바를 닫으면 매치 하이라이트도 해제.
  useEffect(() => {
    if (!cefMode || findOpen) return;
    if (cefActiveIdRef.current != null) {
      void invoke('cef_find', { id: cefActiveIdRef.current, query: '', forward: true, findNext: false }).catch(() => {});
    }
  }, [cefMode, findOpen]);

  // 내장 WebView 공통 eval 왕복. 외부 디버깅 포트 없이 WKWebView/WebView2 안에서
  // 실행하며, 아래의 evalInNativeWebViewWithResult를 ref로 연결한다.
  const nativeEvalWithResultRef = useRef<(expression: string, timeoutMs?: number, targetId?: number) => Promise<unknown>>(
    async () => { throw new Error('Native WebView eval is not ready.'); },
  );
  const evaluateInChrome = useCallback(async (expression: string) => {
    if (exactWsRef.current?.readyState === WebSocket.OPEN) {
      return cdpSend('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
    }
    // CDP 세션이 없으면 네이티브 eval로 실행하고 CDP 응답 모양({result:{value}})으로
    // 감싼다 — remoteValue() 등 기존 소비자가 그대로 동작한다.
    const value = await nativeEvalWithResultRef.current(expression, 10000);
    return { result: { value } };
  }, [cdpSend]);

  // 웹 클리핑(Notes & Clips): 제목·URL·(있으면) 페이지 선택 텍스트를 저장.
  const clipCurrentPage = useCallback(async () => {
    if (!/^https?:/i.test(currentUrl)) return;
    let selection = '';
    try {
      const res = await evaluateInChrome('window.getSelection().toString()');
      selection = String(res?.result?.value || '').slice(0, 2000);
    } catch { /* 엔진 꺼짐 — 선택 없이 클립 */ }
    const title = cefTabs.find((t) => t.id === cefActiveId)?.title || requestName(currentUrl) || currentUrl;
    setWebClips((prev) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const next = [{ id, title, url: currentUrl, selection, at: Date.now() }, ...prev].slice(0, 100);
      void kvSet('bbarit-browser-clips', JSON.stringify(next));
      return next;
    });
    recordAsideAudit('clip', `${title} — ${currentUrl}`);
  }, [currentUrl, cefTabs, cefActiveId, evaluateInChrome, recordAsideAudit]);
  const deleteClip = useCallback((id: string) => {
    setWebClips((prev) => {
      const next = prev.filter((c) => c.id !== id);
      void kvSet('bbarit-browser-clips', JSON.stringify(next));
      return next;
    });
  }, []);

  // 사이트 로그인 자동 채우기: 현재 페이지의 username/password 필드에 값만 넣는다
  // (제출은 사람이 — 자동 제출 금지). CDP/네이티브 eval 공통 경로(evaluateInChrome).
  const autofillLogin = useCallback(async (login: SiteLogin) => {
    if (!/^https?:/i.test(currentUrl)) return;
    const u = JSON.stringify(login.username);
    const p = JSON.stringify(login.password);
    // 페이지 안에서 로그인 필드를 최선 추정으로 찾아 값 주입 + input/change 이벤트 발화.
    const script = `(() => {
      const setVal = (el, v) => {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, v) : (el.value = v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const visible = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
      const pass = [...document.querySelectorAll('input[type=password]')].find(visible);
      const scope = pass ? (pass.closest('form') || document) : document;
      const userSel = 'input[autocomplete=username],input[type=email],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i],input[name*=login i],input[id*=login i],input[type=text]:not([type=hidden])';
      const user = [...scope.querySelectorAll(userSel)].find(visible) || [...document.querySelectorAll(userSel)].find(visible);
      let filled = 0;
      if (user && setVal(user, ${u})) filled++;
      if (pass && setVal(pass, ${p})) filled++;
      return filled;
    })()`;
    try {
      const res = await evaluateInChrome(script);
      const filled = Number(res?.result?.value || 0);
      recordAsideAudit('autofill', `${login.site} (${login.username}) — ${filled} field(s)`);
      setCefNotice(filled > 0
        ? (locale === 'ko' ? `로그인 정보 채움: ${login.site} — 제출은 직접 누르세요` : `Filled login for ${login.site} — press the sign-in button yourself`)
        : (locale === 'ko' ? '로그인 폼을 못 찾음 — 페이지에서 로그인 화면을 여세요' : 'No login form found — open the sign-in form on the page'));
      window.setTimeout(() => setCefNotice(''), 7000);
    } catch {
      setCefNotice(locale === 'ko' ? '자동 채우기 실패 (엔진 꺼짐?)' : 'Autofill failed (engine off?)');
      window.setTimeout(() => setCefNotice(''), 6000);
    }
  }, [currentUrl, evaluateInChrome, recordAsideAudit, locale]);

  // 에이전트 로그인: 비밀번호를 프롬프트에 넣지 않는다 — 저장된 자격증명으로 채운 뒤
  // 빠릿에게 "제출/2단계 처리"만 위임한다(승인 게이트 경유). 업계 표준(비밀은
  // 모델·로그에 안 보냄; 사람 승인 후 필드 주입).
  const agentLogin = useCallback((login: SiteLogin) => {
    void autofillLogin(login);
    const task = `Complete the sign-in on the current page for ${login.site}. The username and password fields have already been filled with my saved credentials — do NOT ask for or print the password. Click the sign-in/submit button, handle any "keep me signed in" or obvious next step, and if a CAPTCHA or 2FA appears, stop and tell me to finish it myself.`;
    runAsideTaskRef.current(task);
  }, [autofillLogin]);
  // Aside 메모리 문법: frecency 상위 히스토리를 에이전트 컨텍스트 라인으로 제공.
  const asideMemoryLines = useCallback(
    () => searchHistory(historyRef.current, '', Date.now(), { limit: 8 }).map((e) => `${e.title || requestName(e.url)} — ${e.url}`),
    [],
  );

  const readTextInChrome = useCallback((selector = 'body') => {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector || 'body')};
      const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
      return node ? (node.innerText || node.textContent || '') : '';
    })()`;
    return evaluateInChrome(expression);
  }, [evaluateInChrome]);

  const readHtmlInChrome = useCallback((selector = 'html') => {
    const expression = `(() => {
      const selector = ${JSON.stringify(selector || 'html')};
      const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
      return node ? node.outerHTML : '';
    })()`;
    return evaluateInChrome(expression);
  }, [evaluateInChrome]);

  const remoteValue = useCallback((result: any) => {
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'Chrome runtime evaluation failed.');
    }
    const remote = result?.result ?? result;
    if (remote && Object.prototype.hasOwnProperty.call(remote, 'value')) return remote.value;
    return remote?.description ?? remote?.unserializableValue ?? remote;
  }, []);

  // 반응형(fit-to-width): 고정폭 사이트가 좁은 WebView 뷰포트를 넘칠 때 줌을 낮춰 맞춘다.
  // 다만 매 로드마다 줌을 만지면 예측이 어려워 기본은 끈다(수동 줌/메뉴에서 켤 수 있음).
  const autoFitRef = useRef(false);
  const fitActiveTabToWidth = useCallback(async () => {
    const id = cefActiveIdRef.current;
    if (!cefMode || id == null || !autoFitRef.current) return;
    try {
      await invoke('cef_zoom', { id, action: 'reset' }).catch(() => {});
      await new Promise((r) => window.setTimeout(r, 40));
      const m = remoteValue(await evaluateInChrome('({cw: Math.max(document.documentElement.scrollWidth||0, (document.body&&document.body.scrollWidth)||0), vw: window.innerWidth})'));
      const cw = Number(m?.cw || 0);
      const vw = Number(m?.vw || 0);
      if (!cw || !vw || cw <= vw * 1.02) { setZoomPercent(100); return; }
      const steps = Math.min(8, Math.ceil(Math.log(cw / vw) / (0.5 * Math.log(1.2))));
      let level = 0;
      for (let i = 0; i < steps; i++) {
        const r = await invoke<number>('cef_zoom', { id, action: 'out' }).catch(() => null);
        if (r != null) level = Number(r);
      }
      setZoomPercent(Math.round(Math.pow(1.2, level) * 100));
    } catch { /* best-effort fit */ }
  }, [cefMode, evaluateInChrome, remoteValue]);
  const fitRef = useRef(fitActiveTabToWidth);
  useEffect(() => { fitRef.current = fitActiveTabToWidth; }, [fitActiveTabToWidth]);

  const captureBrowserScreenshot = useCallback(async () => {
    // WebView는 항상 화면에 보이는 진짜 렌더러라 직접 캡처가 기본 경로다.
    const capture = cdpSend('Page.captureScreenshot', { format: 'png', fromSurface: true });
    capture.catch(() => {});
    try {
      const result = await Promise.race([
        capture,
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('Chrome protocol timeout: Page.captureScreenshot')), 1200)),
      ]);
      if (result?.data) return `data:image/png;base64,${result.data}`;
    } catch {
      // 캡처가 내비게이션과 경합해 걸릴 수 있다 — DOM 래스터 폴백으로 넘어간다.
    }

    try {
      const domRaster = await evaluateInChrome(`(() => new Promise((resolve) => {
        const w = Math.max(1, window.innerWidth || 1280);
        const h = Math.max(1, window.innerHeight || 720);
        const html = new XMLSerializer().serializeToString(document.documentElement);
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%">' + html + '</foreignObject></svg>';
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve({ ok: false, error: 'canvas-context' });
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0);
            resolve({ ok: true, data: canvas.toDataURL('image/png') });
          } catch (error) {
            resolve({ ok: false, error: String(error && error.message || error) });
          }
        };
        img.onerror = () => resolve({ ok: false, error: 'svg-image-load' });
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }))()`);
      const value = remoteValue(domRaster);
      if (value?.ok && typeof value.data === 'string' && value.data.startsWith('data:image/png;base64,')) {
        return value.data;
      }
    } catch {
      // Some pages cannot be serialized into a foreignObject canvas.
    }
    throw new Error('Browser screenshot failed: CDP capture and DOM raster were both unavailable.');
  }, [cdpSend, evaluateInChrome, remoteValue]);

  // ---- Screen recording: screenshot frame loop -> canvas stream -> MediaRecorder.
  // Works on both engines because it rides the same captureBrowserScreenshot path
  // (CDP capture with DOM-raster fallback); output container follows what the
  // WebView's MediaRecorder supports (mp4 on WKWebView, webm on WebView2).
  const recordingRef = useRef<{
    recorder: MediaRecorder;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    timer: number;
    chunks: Blob[];
    frames: number;
    startedAt: number;
    fps: number;
    mime: string;
    capturing: boolean;
    lastError: string;
  } | null>(null);
  const [recordingActive, setRecordingActive] = useState(false);

  const decodeFrame = useCallback((dataUrl: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('recording frame decode failed'));
    img.src = dataUrl;
  }), []);

  const recordStart = useCallback(async (options?: { fps?: number }) => {
    if (recordingRef.current) throw new Error('Recording is already active. Stop it first with recordStop().');
    if (typeof MediaRecorder === 'undefined' || !('captureStream' in HTMLCanvasElement.prototype)) {
      throw new Error('This WebView does not support MediaRecorder/canvas.captureStream.');
    }
    const fps = Math.max(1, Math.min(8, Number(options?.fps) || 2));
    const first = await decodeFrame(await captureBrowserScreenshot());
    const canvas = document.createElement('canvas');
    canvas.width = first.naturalWidth || 1280;
    canvas.height = first.naturalHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('recording canvas context unavailable');
    ctx.drawImage(first, 0, 0, canvas.width, canvas.height);
    const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('No supported recording container (mp4/webm) in this WebView.');
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data && event.data.size > 0) chunks.push(event.data); };
    recorder.start(1000);
    const session = { recorder, canvas, ctx, timer: 0, chunks, frames: 1, startedAt: Date.now(), fps, mime, capturing: false, lastError: '' };
    session.timer = window.setInterval(() => {
      if (session.capturing) return;
      session.capturing = true;
      captureBrowserScreenshot()
        .then(decodeFrame)
        .then((img) => {
          session.ctx.drawImage(img, 0, 0, session.canvas.width, session.canvas.height);
          session.frames += 1;
        })
        .catch((error) => { session.lastError = String((error as Error)?.message || error); })
        .finally(() => { session.capturing = false; });
    }, Math.round(1000 / fps));
    recordingRef.current = session;
    setRecordingActive(true);
    return { ok: true, recording: true, fps, mime, width: canvas.width, height: canvas.height, startedAt: session.startedAt };
  }, [captureBrowserScreenshot, decodeFrame]);

  const recordStatus = useCallback(() => {
    const session = recordingRef.current;
    if (!session) return { recording: false };
    return {
      recording: true,
      frames: session.frames,
      durationMs: Date.now() - session.startedAt,
      fps: session.fps,
      mime: session.mime,
      width: session.canvas.width,
      height: session.canvas.height,
      ...(session.lastError ? { lastFrameError: session.lastError } : {}),
    };
  }, []);

  const recordStop = useCallback(async () => {
    const session = recordingRef.current;
    if (!session) throw new Error('Recording is not active. Start one first with recordStart().');
    recordingRef.current = null;
    setRecordingActive(false);
    window.clearInterval(session.timer);
    const durationMs = Date.now() - session.startedAt;
    await new Promise<void>((resolve) => {
      session.recorder.onstop = () => resolve();
      try { session.recorder.stop(); } catch { resolve(); }
      // Recorder stop can hang if the stream died — never wedge the control surface.
      window.setTimeout(resolve, 5000);
    });
    session.recorder.stream.getTracks().forEach((track) => { try { track.stop(); } catch { /* already dead */ } });
    const blob = new Blob(session.chunks, { type: session.mime });
    if (!blob.size) throw new Error('Recording produced no data' + (session.lastError ? ` (last frame error: ${session.lastError})` : '.'));
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('recording blob read failed'));
      reader.readAsDataURL(blob);
    });
    const ext = session.mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    return {
      ok: true,
      mime: session.mime,
      ext,
      frames: session.frames,
      durationMs,
      width: session.canvas.width,
      height: session.canvas.height,
      sizeBytes: blob.size,
      dataUrl,
    };
  }, []);

  const [recordSavedInfo, setRecordSavedInfo] = useState<{ path: string; sizeBytes: number; durationMs: number } | null>(null);

  const recordSave = useCallback(async (path?: string) => {
    const root = (projectRoot || initialProjectRoot || '').replace(/[\\/]+$/, '');
    const explicit = String(path || '').trim();
    // Resolve the destination BEFORE stopping — throwing after recordStop would
    // destroy the recording; this way the session keeps running and the user
    // can set a project folder (or pass a path) and stop again.
    if (!explicit && !root) throw new Error('recordSave needs a file path (no project folder is set). Recording is still running.');
    const result = await recordStop();
    const target = explicit || `${root}/.octo-tmp/browser-recordings/browser-rec-${Date.now().toString(36)}.${result.ext}`;
    await invoke('write_file_base64', { path: target, base64Data: result.dataUrl.split(',')[1] || '' });
    // Always tell the user where the video landed, no matter who stopped it
    // (toolbar button, CLI, or an agent driving recordSave).
    setRecordSavedInfo({ path: target, sizeBytes: result.sizeBytes, durationMs: result.durationMs });
    const { dataUrl: _omit, ...meta } = result;
    return { ...meta, path: target };
  }, [recordStop, projectRoot, initialProjectRoot]);

  const waitForChrome = useCallback(async (selector = 'body', timeoutMs = 10000) => {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    let lastReadyState = '';
    while (Date.now() < deadline) {
      const result = await evaluateInChrome(`(() => {
        const selector = ${JSON.stringify(selector || 'body')};
        const readyState = document.readyState;
        const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
        if (!node) return { ready: false, readyState, reason: 'selector-missing' };
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        return { ready: readyState !== 'loading' && visible, readyState, visible };
      })()`);
      const value = remoteValue(result);
      lastReadyState = String(value?.readyState || '');
      if (value?.ready) return value;
      await delay(150);
    }
    throw new Error(`Timed out waiting for ${selector || 'body'} in Chrome (readyState=${lastReadyState || 'unknown'}).`);
  }, [evaluateInChrome, remoteValue]);

  const evalInNativeWebView = useCallback(async (script: string) => {
    const id = cefActiveIdRef.current;
    if (id == null) throw new Error('BBARIT WebView tab is not open.');
    await invoke('cef_eval', { id, script });
    return { engine: 'webview-native-eval', targetId: String(id) };
  }, []);

  const evalInNativeWebViewWithResult = useCallback(async (expression: string, timeoutMs = 8000, targetId?: number) => {
    const id = targetId ?? cefActiveIdRef.current;
    if (id == null) throw new Error('BBARIT WebView tab is not open.');
    const token = `native-${Date.now().toString(36)}-${nativeEvalSeqRef.current++}`;
    const script = `(() => {
      const token = ${JSON.stringify(token)};
      const expression = ${JSON.stringify(expression)};
      const post = (payload) => {
        let json;
        try {
          json = JSON.stringify(payload);
        } catch (error) {
          json = JSON.stringify({ ok: false, error: 'Result is not JSON serializable: ' + String(error && (error.message || error)) });
        }
        const chunkSize = 24000;
        const total = Math.max(1, Math.ceil(json.length / chunkSize));
        let index = 0;
        const send = () => {
          const chunk = json.slice(index * chunkSize, (index + 1) * chunkSize);
          window.location.href = 'bbarit-eval-result://result?token=' + encodeURIComponent(token)
            + '&index=' + index
            + '&total=' + total
            + '&payload=' + encodeURIComponent(chunk);
          index += 1;
          if (index < total) window.setTimeout(send, 0);
        };
        send();
      };
      Promise.resolve()
        .then(() => (0, eval)(expression))
        .then((value) => post({ ok: true, value }))
        .catch((error) => post({ ok: false, error: String(error && (error.stack || error.message) || error) }));
    })()`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        nativeEvalPendingRef.current.delete(token);
        reject(new Error(`Native WebView eval timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      nativeEvalPendingRef.current.set(token, { resolve, reject, chunks: [], total: 1, timer });
      invoke('cef_eval', { id, script }).catch((error) => {
        nativeEvalPendingRef.current.delete(token);
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }, []);
  useEffect(() => { nativeEvalWithResultRef.current = evalInNativeWebViewWithResult; }, [evalInNativeWebViewWithResult]);

  // The embedded WKWebView/WebView2 is the packet source. Mirror its standard
  // Navigation/Resource Timing into the records consumed by the packet panel,
  // CLI, HAR, and security view. If a platform also supplies richer records,
  // those replace matching timing-only records instead of creating duplicates.
  useEffect(() => {
    if (!cefMode) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (disposed || polling) return;
      const tabId = cefActiveIdRef.current;
      if (tabId == null) return;
      polling = true;
      try {
        // Drain the fetch/XHR body capture first so its richer records exist
        // before the timing pass runs its duplicate check below.
        const capture = await evalInNativeWebViewWithResult(
          NATIVE_NETWORK_CAPTURE_DRAIN_EXPRESSION,
          6000,
          tabId,
        ) as NativeCaptureSnapshot;
        if (disposed || tabId !== cefActiveIdRef.current) return;
        if (Array.isArray(capture?.entries)) {
          for (const entry of capture.entries) {
            if (!entry?.url) continue;
            const requestId = capturedNetworkRecordId(tabId, String(capture.token || ''), Number(entry.seq) || 0);
            const patch = capturedExchangeToRecordPatch(entry);
            // Windows exposes real CDP records (with bodies) for the same
            // requests. Yield to those so the hook stays a macOS-only fallback
            // instead of adding a duplicate row. CDP ids are neither wv- nor wf-.
            const cdpRecord = Array.from(networkRecordsRef.current.values()).find((record) => (
              !record.id.startsWith('wv-')
              && !record.id.startsWith('wf-')
              && record.url === patch.url
              && Math.abs(record.startedAtMs - patch.startedAtMs) < 2000
            ));
            if (cdpRecord) continue;
            const isNew = !networkRecordsRef.current.has(requestId);
            upsertNetworkRecord(requestId, patch);
            if (isNew) {
              pushNetworkEntry({
                type: patch.failed ? 'failed' : (patch.status ? 'response' : 'request'),
                requestId,
                url: patch.url,
                method: patch.method,
                status: patch.status,
                statusText: patch.statusText,
                resourceType: patch.resourceType,
                errorText: patch.errorText || undefined,
                timestamp: patch.startedAt,
              });
            }
          }
        }
        const snapshot = await evalInNativeWebViewWithResult(
          NATIVE_NETWORK_TIMING_EXPRESSION,
          6000,
          tabId,
        ) as NativeNetworkTimingSnapshot;
        if (disposed || tabId !== cefActiveIdRef.current || !Array.isArray(snapshot?.entries)) return;
        const timeOrigin = Number(snapshot.timeOrigin) || Date.now();
        for (const entry of snapshot.entries) {
          if (!entry?.url) continue;
          const requestId = nativeNetworkRecordId(tabId, timeOrigin, entry);
          const isNew = !networkRecordsRef.current.has(requestId);
          const startTime = Math.max(0, Number(entry.startTime) || 0);
          const responseEnd = Math.max(startTime, Number(entry.responseEnd) || (startTime + Math.max(0, Number(entry.duration) || 0)));
          const startedAtMs = timeOrigin + startTime;
          const finishedAtMs = timeOrigin + responseEnd;
          const status = Number(entry.responseStatus) > 0 ? Number(entry.responseStatus) : undefined;
          const resourceType = nativeNetworkResourceType(entry);
          const richerRecord = Array.from(networkRecordsRef.current.values()).find((record) => (
            !record.id.startsWith('wv-')
            && record.url === String(entry.url)
            && Math.abs(record.startedAtMs - startedAtMs) < 2000
          ));
          if (richerRecord) {
            if (networkRecordsRef.current.delete(requestId)) {
              networkEntriesRef.current = networkEntriesRef.current.filter((record) => record.requestId !== requestId);
            }
            continue;
          }
          upsertNetworkRecord(requestId, {
            url: String(entry.url),
            method: 'GET',
            status,
            statusText: '',
            resourceType,
            mimeType: nativeNetworkMimeType(entry.url),
            protocol: String(entry.nextHopProtocol || ''),
            fromDiskCache: Number(entry.transferSize) === 0 && Number(entry.decodedBodySize) > 0,
            startedAt: new Date(startedAtMs).toISOString(),
            startedAtMs,
            finishedAt: new Date(finishedAtMs).toISOString(),
            finishedAtMs,
            encodedDataLength: Math.max(0, Number(entry.encodedBodySize) || 0),
            transferSize: Math.max(0, Number(entry.transferSize) || 0),
            initiator: String(entry.initiatorType || ''),
            requestHeaders: {},
            responseHeaders: {},
            postDataError: 'Request body is captured for fetch/XHR only; Resource Timing does not expose it for this resource.',
            bodyError: 'Response body is captured for fetch/XHR only; Resource Timing does not expose it for this resource.',
          });
          if (isNew) {
            pushNetworkEntry({
              type: status ? 'response' : 'request',
              requestId,
              url: String(entry.url),
              method: 'GET',
              status,
              statusText: '',
              resourceType,
              timestamp: new Date(startedAtMs).toISOString(),
            });
          }
        }
      } catch {
        // The child WebView may be navigating or closing; the next poll retries.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [cefMode, evalInNativeWebViewWithResult, pushNetworkEntry, upsertNetworkRecord]);

  const selectorBoxInChrome = useCallback(async (selector: string) => {
    const result = await evaluateInChrome(`(() => {
      const selector = ${JSON.stringify(selector)};
      const node = document.querySelector(selector);
      if (!node) return null;
      node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return null;
      return {
        x: Math.max(0, Math.min(window.innerWidth, rect.left + rect.width / 2)),
        y: Math.max(0, Math.min(window.innerHeight, rect.top + rect.height / 2)),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        tagName: node.tagName,
        text: node.innerText || node.textContent || '',
      };
    })()`);
    const box = remoteValue(result);
    if (!box) throw new Error(`Selector not found or not visible: ${selector}`);
    return box;
  }, [evaluateInChrome, remoteValue]);

  const clickSelectorInChrome = useCallback(async (selector: string, button = 'left') => {
    const box = await selectorBoxInChrome(selector);
    cdpFire('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button,
      clickCount: 1,
    });
    cdpFire('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.x,
      y: box.y,
      button,
      clickCount: 1,
    });
    await delay(80);
    return box;
  }, [cdpFire, selectorBoxInChrome]);

  const typeSelectorInChrome = useCallback(async (selector: string, text: string, clear = false) => {
    const box = await clickSelectorInChrome(selector);
    const readValue = async () => remoteValue(await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { found: false, value: '', textContent: '' };
      return {
        found: true,
        tagName: node.tagName,
        value: 'value' in node ? String(node.value || '') : '',
        textContent: node.isContentEditable ? String(node.textContent || '') : '',
        activeElementId: document.activeElement ? document.activeElement.id : '',
      };
    })()`));
    const observedText = (value: any) => String(value?.value || value?.textContent || '');
    const forceSetValue = async () => remoteValue(await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const next = ${JSON.stringify(text)};
      if (!node) return { repaired: false, reason: 'selector-missing' };
      const setNativeValue = (el, value) => {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
        else el.value = value;
      };
      node.focus({ preventScroll: true });
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        setNativeValue(node, next);
        try { node.setSelectionRange(next.length, next.length); } catch {}
      } else if (node.isContentEditable) {
        node.textContent = next;
      } else {
        return { repaired: false, reason: 'unsupported-control', tagName: node.tagName };
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: next }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        repaired: true,
        value: 'value' in node ? String(node.value || '') : '',
        textContent: node.isContentEditable ? String(node.textContent || '') : '',
      };
    })()`));
    if (clear) {
      await evaluateInChrome(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return false;
        node.focus();
        if (node.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else if ('select' in node && typeof node.select === 'function') {
          node.select();
        }
        return true;
      })()`);
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      }).catch(() => {});
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      }).catch(() => {});
      await delay(80);
    }
    await cdpSend('Input.insertText', { text });
    await delay(160);
    let value = await readValue();
    let current = observedText(value);
    let repaired = false;
    for (let attempt = 0; attempt < 3 && clear && text.startsWith(current) && current.length < text.length; attempt += 1) {
      const remainder = text.slice(current.length);
      if (!remainder) break;
      await cdpSend('Input.insertText', { text: remainder }).catch(() => {});
      await delay(140);
      value = await readValue();
      current = observedText(value);
      repaired = true;
    }
    const ok = clear ? current === text : current.includes(text);
    let forced: any = null;
    if (!ok) {
      forced = await forceSetValue();
      await delay(80);
      value = await readValue();
      current = observedText(value);
    }
    return { ...box, typedText: text, value: current, inputOk: clear ? current === text : current.includes(text), repaired, forced };
  }, [cdpSend, clickSelectorInChrome, evaluateInChrome, remoteValue]);

  const focusSelectorInChrome = useCallback(async (selector: string) => {
    const box = await selectorBoxInChrome(selector);
    const result = await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { focused: false, reason: 'selector-missing' };
      if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return { focused: false, reason: 'not-focusable' };
      if (!node.hasAttribute('tabindex') && !(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLSelectElement) && !(node instanceof HTMLButtonElement) && !(node instanceof HTMLAnchorElement) && !node.isContentEditable) {
        node.setAttribute('tabindex', '-1');
      }
      node.focus({ preventScroll: true });
      return {
        focused: document.activeElement === node,
        activeElementId: document.activeElement ? document.activeElement.id : '',
        tagName: node.tagName,
        role: node.getAttribute('role') || '',
      };
    })()`);
    await delay(60);
    return { box, result: remoteValue(result) };
  }, [evaluateInChrome, remoteValue, selectorBoxInChrome]);

  const pasteSelectorInChrome = useCallback(async (selector: string, text: string) => {
    const focus = await focusSelectorInChrome(selector);
    const result = await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const text = ${JSON.stringify(text)};
      if (!node) return { pasted: false, reason: 'selector-missing' };
      if (!(node instanceof HTMLElement)) return { pasted: false, reason: 'not-html-element' };
      node.focus({ preventScroll: true });
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      const accepted = node.dispatchEvent(event);
      let inserted = false;
      if (accepted) {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          const start = typeof node.selectionStart === 'number' ? node.selectionStart : node.value.length;
          const end = typeof node.selectionEnd === 'number' ? node.selectionEnd : start;
          node.value = node.value.slice(0, start) + text + node.value.slice(end);
          const pos = start + text.length;
          try { node.setSelectionRange(pos, pos); } catch {}
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
          inserted = true;
        } else if (node.isContentEditable) {
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            selection.deleteFromDocument();
          }
          document.execCommand('insertText', false, text);
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
          inserted = true;
        }
      }
      return {
        pasted: true,
        accepted,
        defaultPrevented: event.defaultPrevented,
        inserted,
        value: node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : undefined,
        textContent: node.isContentEditable ? node.textContent : undefined,
        activeElementId: document.activeElement ? document.activeElement.id : '',
      };
    })()`);
    await delay(80);
    return { box: focus.box, focus: focus.result, result: remoteValue(result) };
  }, [evaluateInChrome, focusSelectorInChrome, remoteValue]);

  const setValueSelectorInChrome = useCallback(async (selector: string, value: string) => {
    const focus = await focusSelectorInChrome(selector);
    const result = await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      const value = ${JSON.stringify(value)};
      if (!node) return { set: false, reason: 'selector-missing' };
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const setNativeValue = (el, next) => {
        const proto = Object.getPrototypeOf(el);
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, next);
        else el.value = next;
      };
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
        setNativeValue(node, value);
      } else if (node.isContentEditable) {
        node.textContent = value;
      } else if (role === 'slider' || role === 'spinbutton') {
        node.setAttribute('aria-valuenow', value);
        node.setAttribute('aria-valuetext', value);
      } else {
        return { set: false, reason: 'unsupported-control', tagName: node.tagName, role };
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        set: true,
        tagName: node.tagName,
        type: node.getAttribute('type') || '',
        role,
        value: 'value' in node ? node.value : undefined,
        textContent: node.isContentEditable ? node.textContent : undefined,
        ariaValueNow: node.getAttribute('aria-valuenow'),
        activeElementId: document.activeElement ? document.activeElement.id : '',
      };
    })()`);
    await delay(80);
    return { box: focus.box, focus: focus.result, result: remoteValue(result) };
  }, [evaluateInChrome, focusSelectorInChrome, remoteValue]);

  const dragDropSelectorInChrome = useCallback(async (fromSelector: string, toSelector: string, text = '') => {
    const fromBox = await selectorBoxInChrome(fromSelector);
    const toBox = await selectorBoxInChrome(toSelector);
    const result = await evaluateInChrome(`(() => {
      const source = document.querySelector(${JSON.stringify(fromSelector)});
      const target = document.querySelector(${JSON.stringify(toSelector)});
      const text = ${JSON.stringify(text)};
      if (!source || !target) return { dropped: false, reason: 'selector-missing' };
      const data = new DataTransfer();
      const payload = text || source.getAttribute('data-drag-payload') || source.id || source.textContent || '';
      data.setData('text/plain', payload);
      data.effectAllowed = 'all';
      data.dropEffect = 'move';
      const make = (type, node) => new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: data,
        clientX: Math.round(node.getBoundingClientRect().left + node.getBoundingClientRect().width / 2),
        clientY: Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2),
      });
      const events = [];
      for (const [type, node] of [
        ['dragstart', source],
        ['dragenter', target],
        ['dragover', target],
        ['drop', target],
        ['dragend', source],
      ]) {
        const event = make(type, node);
        const accepted = node.dispatchEvent(event);
        events.push({ type, accepted, defaultPrevented: event.defaultPrevented });
      }
      return {
        dropped: true,
        payload,
        types: data.types,
        events,
        sourceId: source.id || '',
        targetId: target.id || '',
      };
    })()`);
    await delay(80);
    return { fromBox, toBox, result: remoteValue(result) };
  }, [evaluateInChrome, remoteValue, selectorBoxInChrome]);

  const emulateViewportInChrome = useCallback(async (options: {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    mobile?: boolean;
    touch?: boolean;
    colorScheme?: 'light' | 'dark' | '';
    reset?: boolean;
  }) => {
    if (options.reset) {
      await cdpSend('Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
      await cdpSend('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      await cdpSend('Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {});
    } else {
      const width = Math.max(1, Math.floor(Number(options.width) || 1280));
      const height = Math.max(1, Math.floor(Number(options.height) || 860));
      const deviceScaleFactor = Math.max(0, Number(options.deviceScaleFactor) || 1);
      const mobile = !!options.mobile;
      const touch = !!options.touch;
      const colorScheme = options.colorScheme === 'dark' || options.colorScheme === 'light' ? options.colorScheme : '';
      await cdpSend('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
        screenWidth: width,
        screenHeight: height,
      });
      await cdpSend('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 }).catch(() => {});
      await cdpSend('Emulation.setEmulatedMedia', {
        media: '',
        features: colorScheme ? [{ name: 'prefers-color-scheme', value: colorScheme }] : [],
      }).catch(() => {});
    }
    await delay(120);
    const metrics = remoteValue(await evaluateInChrome(`(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      touchEvent: 'ontouchstart' in window,
      dark: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
      light: window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches,
      pointerCoarse: window.matchMedia && window.matchMedia('(pointer: coarse)').matches,
    }))()`));
    return { applied: !options.reset, reset: !!options.reset, options, metrics };
  }, [cdpSend, evaluateInChrome, remoteValue]);

  const selectSelectorInChrome = useCallback(async (selector: string, value: string) => {
    const box = await clickSelectorInChrome(selector);
    const result = await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { selected: false, reason: 'selector-missing' };
      if (!(node instanceof HTMLSelectElement)) {
        return { selected: false, reason: 'not-select', tagName: node.tagName };
      }
      const wanted = ${JSON.stringify(value)};
      const options = Array.from(node.options);
      const option = options.find((item) => item.value === wanted)
        || options.find((item) => item.textContent === wanted)
        || options.find((item) => item.label === wanted);
      if (!option) {
        return { selected: false, reason: 'option-missing', value: wanted, options: options.map((item) => ({ value: item.value, text: item.textContent, label: item.label })) };
      }
      node.value = option.value;
      option.selected = true;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: true, value: node.value, text: option.textContent || '', selectedIndex: node.selectedIndex };
    })()`);
    await delay(80);
    return { box, result: remoteValue(result) };
  }, [clickSelectorInChrome, evaluateInChrome, remoteValue]);

  const checkSelectorInChrome = useCallback(async (selector: string, checked = true) => {
    const desired = !!checked;
    const readState = () => evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { supported: false, reason: 'selector-missing' };
      const tagName = String(node.tagName || '').toLowerCase();
      const type = String(node.getAttribute('type') || '').toLowerCase();
      const role = String(node.getAttribute('role') || '').toLowerCase();
      const ariaChecked = node.getAttribute('aria-checked');
      const input = node instanceof HTMLInputElement ? node : null;
      const native = !!input && (type === 'checkbox' || type === 'radio');
      const aria = role === 'checkbox' || role === 'switch' || role === 'radio' || ariaChecked != null;
      const disabled = !!(input && input.disabled) || node.getAttribute('aria-disabled') === 'true';
      return {
        supported: native || aria,
        tagName,
        type,
        role,
        disabled,
        checked: native ? !!input.checked : ariaChecked === 'true',
        ariaChecked,
      };
    })()`);
    const before = remoteValue(await readState());
    if (!before?.supported) {
      throw new Error(`Selector is not a checkable control: ${selector}`);
    }
    if (before?.disabled) {
      throw new Error(`Selector is disabled and cannot be checked: ${selector}`);
    }
    const box = await selectorBoxInChrome(selector);
    let clicked = false;
    let forced = false;
    if (!!before.checked !== desired) {
      await clickSelectorInChrome(selector);
      clicked = true;
    }
    let after = remoteValue(await readState());
    if (after?.supported && !!after.checked !== desired) {
      forced = true;
      after = remoteValue(await evaluateInChrome(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return { supported: false, reason: 'selector-missing' };
        const desired = ${desired ? 'true' : 'false'};
        const tagName = String(node.tagName || '').toLowerCase();
        const type = String(node.getAttribute('type') || '').toLowerCase();
        const role = String(node.getAttribute('role') || '').toLowerCase();
        if (node instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio')) {
          node.checked = desired;
        } else {
          node.setAttribute('aria-checked', desired ? 'true' : 'false');
        }
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          supported: true,
          tagName,
          type,
          role,
          checked: node instanceof HTMLInputElement ? !!node.checked : node.getAttribute('aria-checked') === 'true',
          ariaChecked: node.getAttribute('aria-checked'),
        };
      })()`));
    }
    await delay(80);
    return { box, desired, before, after, clicked, forced, checked: !!after?.checked };
  }, [clickSelectorInChrome, evaluateInChrome, remoteValue, selectorBoxInChrome]);

  const uploadSelectorInChrome = useCallback(async (selector: string, files: string[]) => {
    const normalizedFiles = files.map((file) => String(file || '').trim()).filter(Boolean);
    if (normalizedFiles.length === 0) throw new Error('No files were provided for upload.');
    const box = await selectorBoxInChrome(selector);
    const documentResult = await cdpSend('DOM.getDocument', { pierce: true });
    const rootNodeId = Number(documentResult?.root?.nodeId || 0);
    if (!rootNodeId) throw new Error('Could not read Chrome DOM document for file upload.');
    const queryResult = await cdpSend('DOM.querySelector', { nodeId: rootNodeId, selector });
    const nodeId = Number(queryResult?.nodeId || 0);
    if (!nodeId) throw new Error(`Selector not found for file upload: ${selector}`);
    const kind = await evaluateInChrome(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return node ? { tagName: node.tagName, type: node.getAttribute('type') || '', multiple: !!node.multiple } : null;
    })()`);
    const nodeInfo = remoteValue(kind);
    if (!nodeInfo || String(nodeInfo.tagName || '').toLowerCase() !== 'input' || String(nodeInfo.type || '').toLowerCase() !== 'file') {
      throw new Error(`Selector is not an input[type=file]: ${selector}`);
    }
    await cdpSend('DOM.setFileInputFiles', { nodeId, files: normalizedFiles });
    await delay(80);
    return { box, files: normalizedFiles, node: nodeInfo };
  }, [cdpSend, evaluateInChrome, remoteValue, selectorBoxInChrome]);

  // Chrome-fidelity audit (ported back after the SEO-workbench redesign dropped it —
  // the browser CLI's `fidelity`/`assert` commands depend on this report shape:
  // verdict/parityScore/failedChecks/version/runtime/session).
  const collectChromeFidelity = useCallback(async () => {
    if (!(await ensureLiveSession())) {
      throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
    }
    const targetId = activeChromeTargetIdRef.current || '';
    const version = await cdpBrowserSend('Browser.getVersion').catch(() => cdpSend('Browser.getVersion').catch(() => null));
    const runtimeExpression = `(async () => {
      const gl = (() => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (!ctx) return { available: false };
          const ext = ctx.getExtension('WEBGL_debug_renderer_info');
          return {
            available: true,
            vendor: ctx.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : ctx.VENDOR),
            renderer: ctx.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : ctx.RENDERER),
          };
        } catch (error) {
          return { available: false, error: String(error && error.message || error) };
        }
      })();
      let userAgentData = null;
      try {
        if (navigator.userAgentData) {
          userAgentData = {
            brands: navigator.userAgentData.brands || [],
            mobile: navigator.userAgentData.mobile,
            platform: navigator.userAgentData.platform,
            highEntropy: await navigator.userAgentData.getHighEntropyValues([
              'architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'uaFullVersion', 'wow64',
            ]).catch((error) => ({ error: String(error && error.message || error) })),
          };
        }
      } catch (error) {
        userAgentData = { error: String(error && error.message || error) };
      }
      const permissionStates = {};
      for (const name of ['geolocation', 'camera', 'microphone', 'clipboard-read', 'clipboard-write']) {
        try {
          permissionStates[name] = await navigator.permissions?.query({ name }).then((permission) => permission.state);
        } catch (error) {
          permissionStates[name] = 'error:' + String(error && error.message || error);
        }
      }
      let storageEstimate = null;
      try { storageEstimate = await navigator.storage?.estimate?.(); } catch (error) { storageEstimate = { error: String(error && error.message || error) }; }
      let mediaDecoding = null;
      try {
        mediaDecoding = await navigator.mediaCapabilities?.decodingInfo?.({
          type: 'file',
          video: { contentType: 'video/mp4; codecs="avc1.42E01E"', width: 640, height: 360, bitrate: 800000, framerate: 30 },
        });
      } catch (error) {
        mediaDecoding = { error: String(error && error.message || error) };
      }
      const automationGlobals = [
        'webdriver', '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
        '__webdriver_script_func', '__webdriver_script_fn', '__fxdriver_evaluate', '__driver_unwrapped',
        '__webdriver_unwrapped', '__driver_evaluate', '__selenium_unwrapped', '__fxdriver_unwrapped',
        '_Selenium_IDE_Recorder', '_selenium', 'calledSelenium', '_WEBDRIVER_ELEM_CACHE', 'ChromeDriverw',
        'domAutomation', 'domAutomationController',
      ].filter((name) => name in window);
      return {
        title: document.title,
        url: location.href,
        userAgent: navigator.userAgent,
        appVersion: navigator.appVersion,
        platform: navigator.platform,
        languages: navigator.languages,
        language: navigator.language,
        webdriver: navigator.webdriver,
        cookieEnabled: navigator.cookieEnabled,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || null,
        maxTouchPoints: navigator.maxTouchPoints,
        plugins: Array.from(navigator.plugins || []).map((plugin) => plugin.name),
        mimeTypes: Array.from(navigator.mimeTypes || []).map((mime) => mime.type),
        chromeObjectPresent: typeof window.chrome === 'object' && !!window.chrome,
        chromeObjectKeys: typeof window.chrome === 'object' && window.chrome ? Object.keys(window.chrome).sort() : [],
        userAgentData,
        permissionStates,
        storageEstimate,
        mediaDecoding,
        automationGlobals,
        hasPermissionsApi: typeof navigator.permissions === 'object' && !!navigator.permissions,
        hasMediaCapabilitiesApi: typeof navigator.mediaCapabilities === 'object' && !!navigator.mediaCapabilities,
        hasStorageApi: typeof navigator.storage === 'object' && !!navigator.storage,
        cssSupportsHas: typeof CSS === 'object' && typeof CSS.supports === 'function' ? CSS.supports('selector(:has(*))') : null,
        intl: {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: Intl.DateTimeFormat().resolvedOptions().locale,
        },
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        outer: { width: window.outerWidth, height: window.outerHeight },
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          pixelDepth: screen.pixelDepth,
        },
        webgl: gl,
      };
    })()`;
    let browserSessionId: string | null = null;
    let runtimeResult: any;
    try {
      if (targetId && exactBrowserWsRef.current?.readyState === WebSocket.OPEN) {
        const attached = await cdpBrowserSend('Target.attachToTarget', { targetId, flatten: true });
        browserSessionId = typeof attached?.sessionId === 'string' ? attached.sessionId : null;
      }
      runtimeResult = browserSessionId
        ? await cdpBrowserSessionSend(browserSessionId, 'Runtime.evaluate', {
          expression: runtimeExpression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        })
        : await evaluateInChrome(runtimeExpression);
    } finally {
      if (browserSessionId) {
        void cdpBrowserSend('Target.detachFromTarget', { sessionId: browserSessionId }).catch(() => {});
      }
    }
    const runtime = remoteValue(runtimeResult);
    const product = String(version?.product || '');
    const ua = String(runtime?.userAgent || version?.userAgent || '');
    const appVersion = String(runtime?.appVersion || '');
    const plugins = Array.isArray(runtime?.plugins) ? runtime.plugins : [];
    const mimeTypes = Array.isArray(runtime?.mimeTypes) ? runtime.mimeTypes : [];
    const chromeObjectKeys = Array.isArray(runtime?.chromeObjectKeys) ? runtime.chromeObjectKeys : [];
    const fullVersionBrands = Array.isArray(runtime?.userAgentData?.highEntropy?.fullVersionList)
      ? runtime.userAgentData.highEntropy.fullVersionList.map((item: any) => String(item?.brand || ''))
      : [];
    const lowEntropyBrands = Array.isArray(runtime?.userAgentData?.brands)
      ? runtime.userAgentData.brands.map((item: any) => String(item?.brand || ''))
      : [];
    const allBrands = [...fullVersionBrands, ...lowEntropyBrands];
    const chromeMajor = product.match(/^Chrome\/(\d+)/)?.[1] || '';
    // WebView 내장 렌더러: 판정은 UA가 Headless가 아님 + webdriver=false + CDP 도달
    // (pageTargetAttached)로 내린다. 세션/런치 플래그 감사는 CDP 미러 시절 개념이라 제거.
    const requiredChecks = {
      productIsChrome: /^Chrome\//.test(product),
      productIsNotHeadless: !/HeadlessChrome/i.test(product),
      userAgentIsNotHeadless: !/HeadlessChrome/i.test(ua),
      appVersionIsNotHeadless: !/HeadlessChrome/i.test(appVersion),
      webdriverIsNotTrue: runtime?.webdriver !== true,
      automationGlobalsAbsent: Array.isArray(runtime?.automationGlobals) && runtime.automationGlobals.length === 0,
      chromeObjectPresent: runtime?.chromeObjectPresent === true,
      chromeBrandPresent: allBrands.some((brand: string) => /Google Chrome|Chromium/i.test(brand)) || /Chrome/i.test(ua),
      pageTargetAttached: Boolean(targetId),
      webglAvailable: runtime?.webgl?.available === true,
      screenMetricsSane: Number(runtime?.screen?.width || 0) > 0 && Number(runtime?.screen?.height || 0) > 0,
      viewportMetricsSane: Number(runtime?.viewport?.width || 0) > 0 && Number(runtime?.viewport?.height || 0) > 0,
    };
    const advisoryChecks = {
      userAgentDataPresent: Boolean(runtime?.userAgentData),
      userAgentDataDesktop: runtime?.userAgentData ? runtime.userAgentData.mobile === false : false,
      chromeMajorMatchesUaFullVersion: !chromeMajor || !runtime?.userAgentData?.highEntropy?.uaFullVersion
        ? true
        : String(runtime.userAgentData.highEntropy.uaFullVersion).startsWith(`${chromeMajor}.`),
      pluginsPresent: plugins.length > 0,
      pdfPluginPresent: plugins.some((name: string) => /PDF/i.test(name)),
      pdfMimeTypePresent: mimeTypes.some((type: string) => /pdf/i.test(type)),
      pdfViewerEnabled: runtime?.pdfViewerEnabled !== false,
      permissionsApiPresent: runtime?.hasPermissionsApi === true,
      storageApiPresent: runtime?.hasStorageApi === true,
      mediaCapabilitiesApiPresent: runtime?.hasMediaCapabilitiesApi === true,
      h264DecodeInfoAvailable: runtime?.mediaDecoding?.supported === true || runtime?.mediaDecoding?.smooth === true || runtime?.mediaDecoding?.powerEfficient === true,
      cssHasSelectorSupported: runtime?.cssSupportsHas === true,
      chromeObjectHasExpectedKeys: chromeObjectKeys.some((key: string) => ['app', 'csi', 'loadTimes', 'runtime'].includes(key)),
      cookieEnabled: runtime?.cookieEnabled === true,
      languagePresent: typeof runtime?.language === 'string' && runtime.language.length > 0,
      timezonePresent: typeof runtime?.intl?.timeZone === 'string' && runtime.intl.timeZone.length > 0,
    };
    const requiredFailures = Object.entries(requiredChecks).filter(([, ok]) => !ok).map(([name]) => name);
    const advisoryFailures = Object.entries(advisoryChecks).filter(([, ok]) => !ok).map(([name]) => name);
    const allCheckValues = [...Object.values(requiredChecks), ...Object.values(advisoryChecks)];
    const parityScore = allCheckValues.length
      ? Math.round((allCheckValues.filter(Boolean).length / allCheckValues.length) * 100)
      : 0;
    return {
      generatedAt: new Date().toISOString(),
      verdict: requiredFailures.length === 0 ? 'chrome-runtime' : 'review',
      checks: requiredChecks,
      requiredChecks,
      advisoryChecks,
      failedChecks: requiredFailures,
      failedAdvisoryChecks: advisoryFailures,
      parityScore,
      version,
      runtime,
      // CLI report shape(session 키) 유지: WebView 내장 엔진은 별도 세션 프로세스가
      // 없으므로 DevTools 포트와 엔진 이름만 보고한다.
      session: {
        sessionId: null,
        port: 9666,
        renderMode: 'webview',
        targetId,
      },
    };
  }, [cdpBrowserSend, cdpBrowserSessionSend, cdpSend, ensureLiveSession, evaluateInChrome, remoteValue]);

  useEffect(() => {
    (window as any).__BBARIT_BROWSER__ = {
      // ── WebView 내장 브라우저가 유일한 엔진 ──
      // 탭/네비는 WebView 네이티브 명령으로, eval/screenshot/packets/cdp 등은 CDP
      // 기반 구현을 그대로 쓴다 (ensureLiveSession이 WebView CDP에 attach).
      // CLI(agent-browser-cli)와 빠릿에이전트는 이 표면 하나로 WebView를 제어한다.
      status: () => {
        const active = cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current);
        const activeNavState = active ? { canGoBack: active.canBack, canGoForward: active.canFwd } : navState;
        return {
        address: active?.url || addressRef.current || address,
        currentUrl: active?.url || currentUrlRef.current || currentUrl,
        isLoading,
        error: error === 'Exact Chrome renderer WebSocket failed.' ? null : error,
        engineMode: 'webview',
        browserEngine: nativeWebviewEngineLabel(),
        webviewAvailable: cefMode,
        chromeAvailable: cefMode,
        liveSession: exactWsRef.current?.readyState === WebSocket.OPEN,
        // 'unavailable' = WebView 엔진 자체가 없음(CLI는 즉시 실패). CDP만 아직 안
        // 붙은 상태는 'idle' — CLI가 navigateExisting으로 attach를 유도한다.
        browserState: cefAvailable === false
          ? 'unavailable'
          : exactWsRef.current?.readyState === WebSocket.OPEN ? 'ready' : 'idle',
        navState: activeNavState,
        consoleCount: consoleEntriesRef.current.length,
        lastConsole: consoleEntriesRef.current.at(-1) || null,
        networkCount: networkEntriesRef.current.length,
        lastNetwork: (() => {
          const entry = networkEntriesRef.current.at(-1);
          return entry ? redactNetworkEntry(entry) : null;
        })(),
        cefTabs: cefTabsRef.current.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.id === cefActiveIdRef.current, canBack: t.canBack, canFwd: t.canFwd, historyIndex: t.historyIndex, historyLength: t.history.length, sessionId: t.sessionId || '' })),
      };
      },
      navigateExisting: async (url: string) => {
        const target = normalizeUrl(url);
        setError(null);
        setBrowserLocation(target);
        // 세션이 없으면 탭을 열고 CDP를 붙인다(콜드스타트).
        if (cefActiveIdRef.current != null) {
          const activeId = cefActiveIdRef.current;
          cefTabsRef.current = cefTabsRef.current.map((t) => t.id === activeId ? { ...withCefHistory(t, target, 'push'), loading: true } : t);
          setCefTabs(cefTabsRef.current);
          await invoke('cef_navigate', { id: cefActiveIdRef.current, url: target });
        } else {
          const id = await cefOpenTab(target);
          if (id == null) throw new Error('BBARIT WebView tab open failed.');
        }
        // 이미 붙어 있는 CDP 세션에서 직접 네비게이션한다. cef_navigate는 CDP
        // 타깃을 갈아치워 로드 중 Network/console/packet 이벤트를 통째로 놓치므로
        // 쓰지 않는다(Page.navigate는 같은 타깃을 유지해 전부 캡처한다).
        window.setTimeout(() => { void cefAttachRef.current(target); }, 500);
        await refreshNavigationState().catch(() => {});
        return { url: target, currentUrl: target };
      },
      eval: async (expression: string) => {
        if (cefMode) return evalInNativeWebViewWithResult(String(expression || 'undefined'));
        if (await ensureLiveSession()) return evaluateInChrome(expression);
        return evalInNativeWebViewWithResult(String(expression || 'undefined'));
      },
      html: async (selector?: string) => {
        const targetSelector = selector || 'html';
        if (!cefMode && await ensureLiveSession()) return readHtmlInChrome(selector);
        return evalInNativeWebViewWithResult(`(() => {
          const selector = ${JSON.stringify(targetSelector)};
          const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
          return node ? node.outerHTML : '';
        })()`, 12000);
      },
      clickSelector: async (selector: string, button?: string) => {
        if (!cefMode && await ensureLiveSession()) return clickSelectorInChrome(selector, button);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) throw new Error('Selector not found: ' + ${JSON.stringify(selector)});
          node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const target = node.closest('a[href],button,input,textarea,select,summary,[role="button"],[onclick]') || node;
          const link = target instanceof HTMLAnchorElement
            ? target
            : (node.closest?.('a[href]') || node.querySelector?.('a[href]'));
          if (link instanceof HTMLAnchorElement && link.href) {
            const linkTarget = String(link.target || '').toLowerCase();
            if (linkTarget && linkTarget !== '_self') {
              window.open(link.href, link.target);
            } else {
              window.location.href = link.href;
            }
            return;
          }
          const Ptr = window.PointerEvent || MouseEvent;
          target.dispatchEvent(new Ptr('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
          target.dispatchEvent(new Ptr('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
          if (target instanceof HTMLAnchorElement && target.href && !target.target) {
            window.location.href = target.href;
          } else if (typeof target.click === 'function') {
            target.click();
          } else {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
          }
        })()`);
      },
      typeSelector: async (selector: string, text: string, clear?: boolean) => {
        if (!cefMode && await ensureLiveSession()) return typeSelectorInChrome(selector, text, clear);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return;
          node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          node.focus();
          const text = ${JSON.stringify(text)};
          const clear = ${clear ? 'true' : 'false'};
          if (node.isContentEditable) {
            node.textContent = clear ? text : ((node.textContent || '') + text);
          } else if ('value' in node) {
            node.value = clear ? text : (String(node.value || '') + text);
          }
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      focusSelector: async (selector: string) => {
        if (!cefMode && await ensureLiveSession()) return focusSelectorInChrome(selector);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return;
          node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          node.focus();
        })()`);
      },
      pasteSelector: async (selector: string, text: string) => {
        if (!cefMode && await ensureLiveSession()) return pasteSelectorInChrome(selector, text);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return;
          node.focus();
          const text = ${JSON.stringify(text)};
          if (node.isContentEditable) node.textContent = (node.textContent || '') + text;
          else if ('value' in node) node.value = String(node.value || '') + text;
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      setValueSelector: async (selector: string, value: string) => {
        if (!cefMode && await ensureLiveSession()) return setValueSelectorInChrome(selector, value);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return;
          if (node.isContentEditable) node.textContent = ${JSON.stringify(value)};
          else if ('value' in node) node.value = ${JSON.stringify(value)};
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      dragDropSelector: async (fromSelector: string, toSelector: string, text?: string) => { await ensureLiveSession(); return dragDropSelectorInChrome(fromSelector, toSelector, text); },
      emulateViewport: async (options: Record<string, unknown>) => { await ensureLiveSession(); return emulateViewportInChrome(options as any); },
      devtools: async () => { cefToggleDevtools(); return true; },
      environmentState: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const runtime = remoteValue(await evaluateInChrome(`(() => ({
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          languages: Array.from(navigator.languages || []),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }))()`));
        return {
          userAgentOverride: userAgentOverrideRef.current,
          defaultUserAgent: defaultUserAgentRef.current,
          timezoneOverride: timezoneOverrideRef.current,
          runtime,
        };
      },
      setUserAgent: async (userAgent: string) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const value = String(userAgent || '').trim();
        if (!value) throw new Error('setUserAgent requires a non-empty user agent.');
        if (!defaultUserAgentRef.current) {
          const current = remoteValue(await evaluateInChrome('navigator.userAgent'));
          defaultUserAgentRef.current = String(current || '');
        }
        await cdpSend('Network.setUserAgentOverride', { userAgent: value });
        userAgentOverrideRef.current = value;
        return (window as any).__BBARIT_BROWSER__.environmentState();
      },
      clearUserAgent: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const fallback = remoteValue(await evaluateInChrome('navigator.userAgent'));
        const userAgent = defaultUserAgentRef.current || String(fallback || '');
        if (userAgent) await cdpSend('Network.setUserAgentOverride', { userAgent });
        userAgentOverrideRef.current = null;
        return (window as any).__BBARIT_BROWSER__.environmentState();
      },
      setTimezone: async (timezoneId: string) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const value = String(timezoneId || '').trim();
        if (!value) throw new Error('setTimezone requires a timezone id.');
        await cdpSend('Emulation.setTimezoneOverride', { timezoneId: value });
        timezoneOverrideRef.current = value;
        return (window as any).__BBARIT_BROWSER__.environmentState();
      },
      clearTimezone: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        await cdpSend('Emulation.setTimezoneOverride', { timezoneId: '' });
        timezoneOverrideRef.current = null;
        return (window as any).__BBARIT_BROWSER__.environmentState();
      },
      stop: () => stopLoading(),
      home: async (url = DEFAULT_BROWSER_URL) => {
        const target = normalizeUrl(String(url || DEFAULT_BROWSER_URL));
        await (window as any).__BBARIT_BROWSER__.navigateExisting(target);
        return { url: target, status: (window as any).__BBARIT_BROWSER__.status() };
      },
      find: async (query: string, forward = true, findNext = false) => {
        if (!(await ensureLiveSession())) throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        const q = String(query || '');
        // WebView 네이티브 하이라이트도 켜되, 결과 판정(found/selection)은 CDP window.find 로.
        if (cefActiveIdRef.current != null) void invoke('cef_find', { id: cefActiveIdRef.current, query: q, forward, findNext: !!findNext }).catch(() => {});
        return remoteValue(await evaluateInChrome(`(() => { try { window.getSelection && window.getSelection().removeAllRanges && window.getSelection().removeAllRanges(); const found = window.find(${JSON.stringify(q)}, false, ${!forward}, true, false, false, false); return { query: ${JSON.stringify(q)}, found: !!found, forward: ${!!forward}, findNext: ${!!findNext}, selection: found ? String(window.getSelection() || '') : '' }; } catch (e) { return { query: ${JSON.stringify(q)}, found: false, selection: '', error: String(e && e.message || e) }; } })()`));
      },
      zoom: async (action: string | number = 'reset') => {
        if (!(await ensureLiveSession())) throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        const raw = String(action ?? 'reset').toLowerCase();
        const numeric = typeof action === 'number' || /^-?\d+(\.\d+)?$/.test(raw);
        let percent = numeric ? Number(action) : (raw === 'in' || raw === '+' ? zoomPercent + 10 : raw === 'out' || raw === '-' ? zoomPercent - 10 : 100);
        percent = Math.max(25, Math.min(500, Math.round(percent)));
        // 에이전트 줌은 CSS 줌(documentElement)으로 정확히 설정 — 정확한 % + DOM 검증 가능.
        await evaluateInChrome(`document.documentElement.style.zoom = ${JSON.stringify(percent === 100 ? '' : percent + '%')}`);
        setZoomPercent(percent);
        return { percent, requestedPercent: percent, engine: 'css-zoom' };
      },
      selectSelector: async (selector: string, value: string) => {
        if (!cefMode && await ensureLiveSession()) return selectSelectorInChrome(selector, value);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!(node instanceof HTMLSelectElement)) return;
          const wanted = ${JSON.stringify(value)};
          const option = Array.from(node.options).find((item) => item.value === wanted || item.textContent === wanted || item.label === wanted);
          if (option) {
            node.value = option.value;
            option.selected = true;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
      },
      checkSelector: async (selector: string, checked?: boolean) => {
        if (!cefMode && await ensureLiveSession()) return checkSelectorInChrome(selector, checked !== false);
        return evalInNativeWebView(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return;
          const desired = ${checked !== false ? 'true' : 'false'};
          if (node instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(node.type)) node.checked = desired;
          else node.setAttribute('aria-checked', desired ? 'true' : 'false');
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      },
      uploadSelector: async (selector: string, files: string[]) => {
        if (!(await ensureLiveSession())) throw new Error('File upload requires CDP.');
        return uploadSelectorInChrome(selector, Array.isArray(files) ? files : [String(files || '')]);
      },
      console: () => consoleEntriesRef.current.slice(),
      network: () => networkEntriesRef.current.slice().map(redactNetworkEntry),
      lastDialog: () => lastDialogRef.current,
      handleDialog: async (accept = true, promptText?: string) => {
        await ensureLiveSession();
        await cdpSend('Page.handleJavaScriptDialog', {
          accept: !!accept,
          ...(typeof promptText === 'string' ? { promptText } : {}),
        });
        if (lastDialogRef.current) {
          lastDialogRef.current = {
            ...lastDialogRef.current,
            handled: true,
            handledAt: new Date().toISOString(),
            accept: !!accept,
          };
        }
        return lastDialogRef.current;
      },
      // On-demand PNG of the visible page for the vision agent — drives CDP
      // directly against the WebView renderer. Returns a base64 data URL.
      screenshot: async (): Promise<string> => {
        if (!(await ensureLiveSession())) {
          const b64 = await invoke<string>('capture_screen_png_base64');
          return `data:image/png;base64,${b64}`;
        }
        return captureBrowserScreenshot();
      },
      // Screen recording of the browsed page (screenshot frame loop -> video).
      // recordStop returns the encoded video as a data URL; recordSave writes it
      // to disk (defaults into <project>/.octo-tmp/browser-recordings/).
      recordStart: async (options?: { fps?: number }) => recordStart(options),
      recordStop: async () => recordStop(),
      recordStatus: () => recordStatus(),
      recordSave: async (path?: string) => recordSave(path),
      // ---- CLI core control surface (agent screen-first loop) ----
      // Ensure the renderer connection is live before helper calls —
      // navigate/screenshot already reconnect; without this, wait/text/cdp
      // raced a still-attaching renderer right after open and failed.
      waitFor: async (selector = 'body', timeoutMs = 10000) => {
        if (!(await ensureLiveSession())) {
          if (cefActiveIdRef.current != null) return { ready: true, selector, timeoutMs, engine: 'webview-native-eval' };
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        return waitForChrome(selector, timeoutMs);
      },
      text: async (selector = 'body') => {
        if (!(await ensureLiveSession())) return evalInNativeWebViewWithResult(`(() => {
          const selector = ${JSON.stringify(selector || 'body')};
          const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
          return node ? (node.innerText || node.textContent || '') : '';
        })()`, 12000);
        return readTextInChrome(selector);
      },
      cdp: async (method: string, params?: Record<string, unknown>) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        return cdpSend(method, (params ?? {}) as any);
      },
      cdpFire: async (method: string, params?: Record<string, unknown>) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        return cdpFire(method, (params ?? {}) as any);
      },
      fidelity: () => collectChromeFidelity(),
      navigate: async (url: string) => (window as any).__BBARIT_BROWSER__.navigateExisting(url),
      info: () => {
        const active = cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current);
        return { url: active?.url || currentUrlRef.current || currentUrl, address: active?.url || addressRef.current || address, isLoading, navState: active ? { canGoBack: active.canBack, canGoForward: active.canFwd } : navState, engine: 'webview', browserEngine: nativeWebviewEngineLabel(), tabs: cefTabsRef.current.length };
      },
      nativeEval: async (script: string, targetId?: string | number) => {
        const id = targetId == null ? cefActiveIdRef.current : Number(targetId);
        if (id == null || !Number.isFinite(id)) throw new Error('No BBARIT WebView tab is selected.');
        await invoke('cef_eval', { id, script: String(script || '') });
        return { targetId: String(id), engine: 'webview-native' };
      },
      nativeEvalResult: async (expression: string, targetId?: string | number, timeoutMs?: number) => {
        const id = targetId == null ? cefActiveIdRef.current : Number(targetId);
        if (id == null || !Number.isFinite(id)) throw new Error('No BBARIT WebView tab is selected.');
        return evalInNativeWebViewWithResult(String(expression || 'undefined'), Number(timeoutMs) || 8000, id);
      },
      reload: async () => { if (cefActiveIdRef.current != null) await invoke('cef_nav_action', { id: cefActiveIdRef.current, action: 'reload' }); return true; },
      back: async () => goCefHistory(-1),
      forward: async () => goCefHistory(1),
      tabs: async () => cefTabsRef.current.map((t) => ({ targetId: String(t.id), type: 'page', title: t.title, url: t.url, attached: t.id === cefActiveIdRef.current, canBack: t.canBack, canFwd: t.canFwd, historyIndex: t.historyIndex, historyLength: t.history.length, sessionId: t.sessionId || '' })),
      newTab: async (url = DEFAULT_BROWSER_URL, sessionId?: string) => {
        const target = normalizeUrl(String(url));
        const beforeIds = new Set(cefTabsRef.current.map((t) => t.id));
        const activeSessionId = sessionId || cefTabsRef.current.find((t) => t.id === cefActiveIdRef.current)?.sessionId;
        let id = await cefOpenTab(target, activeSessionId || undefined);
        for (let i = 0; id == null && i < 25; i += 1) {
          await delay(100);
          const recovered = [...cefTabsRef.current]
            .reverse()
            .find((t) => normalizeUrl(t.url) === target && (!beforeIds.has(t.id) || t.id === cefActiveIdRef.current));
          if (recovered) id = recovered.id;
        }
        if (id == null) throw new Error('BBARIT WebView tab open failed');
        for (let i = 0; !cefTabsRef.current.some((t) => t.id === id) && i < 25; i += 1) {
          await delay(100);
        }
        return { targetId: String(id), sessionId: activeSessionId || '' };
      },
      useSessionTab: async (sessionId = 'default', url = DEFAULT_BROWSER_URL) => {
        const sid = String(sessionId || 'default');
        const rawTarget = String(url || '').trim();
        const target = rawTarget ? normalizeUrl(rawTarget) : '';
        let existing = cefTabsRef.current.find((t) => t.sessionId === sid && t.id === cefActiveIdRef.current)
          || [...cefTabsRef.current].reverse().find((t) => t.sessionId === sid);
        if (!existing && target) {
          existing = cefTabsRef.current.find((t) => !t.sessionId && normalizeUrl(t.url) === target);
          if (existing) {
            cefTabsRef.current = cefTabsRef.current.map((t) => t.id === existing!.id ? { ...t, sessionId: sid } : t);
            setCefTabs(cefTabsRef.current);
          }
        }
        if (!existing && !target) {
          existing = cefTabsRef.current.find((t) => !t.sessionId && t.id === cefActiveIdRef.current)
            || cefTabsRef.current.find((t) => !t.sessionId);
          if (existing) {
            cefTabsRef.current = cefTabsRef.current.map((t) => t.id === existing!.id ? { ...t, sessionId: sid } : t);
            setCefTabs(cefTabsRef.current);
          }
        }
        if (existing) {
          cefSwitchTab(existing.id);
          setBrowserLocation(existing.url);
          if (target && normalizeUrl(existing.url) !== target) {
            cefTabsRef.current = cefTabsRef.current.map((t) => t.id === existing!.id ? { ...withCefHistory(t, target, 'push'), loading: true } : t);
            setCefTabs(cefTabsRef.current);
            setBrowserLocation(target);
            await invoke('cef_navigate', { id: existing.id, url: target }).catch(() => {});
          }
          return { targetId: String(existing.id), reused: true, sessionId: sid };
        }
        const initialUrl = target || normalizeUrl(currentUrlRef.current || addressRef.current || DEFAULT_BROWSER_URL);
        const beforeIds = new Set(cefTabsRef.current.map((t) => t.id));
        let id = await cefOpenTab(initialUrl, sid);
        for (let i = 0; id == null && i < 25; i += 1) {
          await delay(100);
          const recovered = [...cefTabsRef.current]
            .reverse()
            .find((t) => normalizeUrl(t.url) === initialUrl && (!beforeIds.has(t.id) || t.id === cefActiveIdRef.current));
          if (recovered) {
            id = recovered.id;
            if (!recovered.sessionId) {
              cefTabsRef.current = cefTabsRef.current.map((t) => t.id === recovered.id ? { ...t, sessionId: sid } : t);
              setCefTabs(cefTabsRef.current);
            }
          }
        }
        if (id == null) throw new Error('BBARIT WebView tab open failed');
        for (let i = 0; !cefTabsRef.current.some((t) => t.id === id) && i < 25; i += 1) {
          await delay(100);
        }
        return { targetId: String(id), reused: false, sessionId: sid };
      },
      switchTab: async (targetId: string) => { cefSwitchTab(Number(targetId)); return true; },
      closeTab: async (targetId: string) => { cefCloseTab(Number(targetId)); return true; },
      selectorBox: (selector: string) => evaluateInChrome(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`
      ),
      clearConsole: () => { consoleEntriesRef.current = []; return true; },
      clearNetwork: () => {
        networkEntriesRef.current = [];
        networkRecordsRef.current.clear();
        if (cefActiveIdRef.current != null) {
          void nativeEvalWithResultRef.current(
            CLEAR_NATIVE_NETWORK_TIMINGS_EXPRESSION,
            4000,
            cefActiveIdRef.current,
          ).catch(() => {});
        }
        return true;
      },
      networkConditions: () => ({
        active: !!networkConditionsRef.current,
        conditions: networkConditionsRef.current,
      }),
      setNetworkConditions: async (options?: { offline?: boolean; latency?: number; downloadThroughput?: number; uploadThroughput?: number; connectionType?: string }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const conditions: BrowserNetworkConditions = {
          offline: !!options?.offline,
          latency: Math.max(0, Math.min(300000, Number(options?.latency ?? 0) || 0)),
          downloadThroughput: Number.isFinite(Number(options?.downloadThroughput)) ? Number(options?.downloadThroughput) : -1,
          uploadThroughput: Number.isFinite(Number(options?.uploadThroughput)) ? Number(options?.uploadThroughput) : -1,
          connectionType: String(options?.connectionType || (options?.offline ? 'none' : 'other')),
        };
        await cdpSend('Network.emulateNetworkConditions', conditions);
        networkConditionsRef.current = conditions.offline || conditions.latency > 0 || conditions.downloadThroughput >= 0 || conditions.uploadThroughput >= 0
          ? conditions
          : null;
        return { active: !!networkConditionsRef.current, conditions };
      },
      clearNetworkConditions: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const conditions: BrowserNetworkConditions = {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
          connectionType: 'other',
        };
        await cdpSend('Network.emulateNetworkConditions', conditions);
        networkConditionsRef.current = null;
        return { active: false, conditions };
      },
      // Smart cross-session history: frecency-ranked, categorized, fuzzy-searchable.
      searchHistory: (query = '', opts?: { limit?: number; bookmarkedOnly?: boolean; category?: string }) =>
        searchHistory(historyRef.current, query, Date.now(), opts),
      bookmark: (url: string, on = true) => {
        // Bookmarking a page that was never recorded (e.g. the current page) should
        // still work: record it first, then set the flag.
        const target = url || currentUrl;
        let next = historyRef.current;
        if (on && !next.some((e) => e.url === target)) next = recordVisit(next, { url: target, title: target }, Date.now());
        next = setBookmark(next, target, on);
        historyRef.current = next;
        void kvSet('bbarit-browser-history', JSON.stringify(next));
        return true;
      },
      setProjectRoot: (root: string) => { setProjectRoot(String(root || '').trim() || projectRoot); return true; },
      // Return BEFORE closing: awaiting our own window's close() means the eval
      // response can never be delivered (the evaluating context dies with the
      // window) and the caller sees a script timeout instead of success.
      close: () => { window.setTimeout(() => { void getCurrentWindow().close(); }, 80); return true; },
      storageState: async (options?: { includeSecrets?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const includeSecrets = !!options?.includeSecrets;
        const url = currentUrlRef.current || currentUrl;
        const runtime = remoteValue(await evaluateInChrome(`(() => {
          const dumpStorage = (storage) => {
            try {
              return Array.from({ length: storage.length }, (_, index) => {
                const key = storage.key(index) || '';
                const value = storage.getItem(key) || '';
                return { key, value, valueLength: value.length };
              });
            } catch (error) {
              return { error: String(error && error.message || error) };
            }
          };
          return {
            url: location.href,
            origin: location.origin,
            localStorage: dumpStorage(window.localStorage),
            sessionStorage: dumpStorage(window.sessionStorage)
          };
        })()`)) || {};
        const maskEntries = (entries: unknown) => Array.isArray(entries)
          ? entries.map((entry: any) => ({
            key: String(entry?.key || ''),
            value: includeSecrets ? String(entry?.value || '') : REDACTED_VALUE,
            valueLength: Number(entry?.valueLength || String(entry?.value || '').length || 0),
          }))
          : entries;
        const cookieResult = await cdpSend('Network.getCookies', { urls: url ? [url] : [] }).catch(() => ({ cookies: [] }));
        const cookies = (Array.isArray(cookieResult?.cookies) ? cookieResult.cookies : []).map((cookie: any) => ({
          name: String(cookie?.name || ''),
          value: includeSecrets ? String(cookie?.value || '') : REDACTED_VALUE,
          valueLength: String(cookie?.value || '').length,
          domain: String(cookie?.domain || ''),
          path: String(cookie?.path || ''),
          expires: typeof cookie?.expires === 'number' ? cookie.expires : undefined,
          httpOnly: !!cookie?.httpOnly,
          secure: !!cookie?.secure,
          sameSite: typeof cookie?.sameSite === 'string' ? cookie.sameSite : undefined,
          session: !!cookie?.session,
        }));
        return {
          url: includeSecrets ? url : redactUrl(url),
          origin: runtime.origin || '',
          cookies,
          localStorage: maskEntries(runtime.localStorage),
          sessionStorage: maskEntries(runtime.sessionStorage),
        };
      },
      cookies: async (options?: { includeSecrets?: boolean }) => {
        const state = await (window as any).__BBARIT_BROWSER__.storageState(options);
        return { url: state.url, origin: state.origin, cookies: state.cookies };
      },
      setCookie: async (options?: {
        name?: string;
        value?: string;
        url?: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: string;
        includeSecrets?: boolean;
      }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const name = String(options?.name || '').trim();
        if (!name) throw new Error('setCookie requires a cookie name.');
        const url = String(options?.url || currentUrlRef.current || currentUrl || '').trim();
        const sameSite = String(options?.sameSite || '').trim();
        const params: Record<string, unknown> = {
          name,
          value: String(options?.value ?? ''),
          path: String(options?.path || '/'),
        };
        if (url) params.url = url;
        if (options?.domain) params.domain = String(options.domain);
        if (typeof options?.expires === 'number' && Number.isFinite(options.expires)) params.expires = options.expires;
        if (typeof options?.httpOnly === 'boolean') params.httpOnly = options.httpOnly;
        if (typeof options?.secure === 'boolean') params.secure = options.secure;
        if (/^(Strict|Lax|None)$/i.test(sameSite)) {
          params.sameSite = sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
        }
        const result = await cdpSend('Network.setCookie', params);
        if (result?.success === false) throw new Error(`Chrome rejected cookie ${name}.`);
        const state = await (window as any).__BBARIT_BROWSER__.cookies({ includeSecrets: !!options?.includeSecrets });
        const cookie = Array.isArray(state.cookies) ? state.cookies.find((entry: any) => entry?.name === name) || null : null;
        return { ok: true, cookie, state };
      },
      deleteCookie: async (options?: { name?: string; url?: string; domain?: string; path?: string; includeSecrets?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const name = String(options?.name || '').trim();
        if (!name) throw new Error('deleteCookie requires a cookie name.');
        const url = String(options?.url || currentUrlRef.current || currentUrl || '').trim();
        const params: Record<string, unknown> = { name };
        if (options?.domain) params.domain = String(options.domain);
        if (options?.path) params.path = String(options.path);
        if (url && !params.domain) params.url = url;
        await cdpSend('Network.deleteCookies', params);
        const state = await (window as any).__BBARIT_BROWSER__.cookies({ includeSecrets: !!options?.includeSecrets });
        const remaining = Array.isArray(state.cookies) ? state.cookies.filter((entry: any) => entry?.name === name) : [];
        return { deleted: remaining.length === 0, remaining, state };
      },
      clearStorage: async (options?: { cookies?: boolean; localStorage?: boolean; sessionStorage?: boolean; cache?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const url = currentUrlRef.current || currentUrl;
        const parsed = (() => { try { return new URL(url); } catch { return null; } })();
        const origin = parsed?.origin && parsed.origin !== 'null' ? parsed.origin : '';
        const clearCookies = options?.cookies !== false;
        const clearLocal = options?.localStorage !== false;
        const clearSession = options?.sessionStorage !== false;
        const clearCache = !!options?.cache;
        const cleared: string[] = [];
        if (origin) {
          const storageTypes = [
            ...(clearCookies ? ['cookies'] : []),
            ...(clearLocal ? ['local_storage', 'indexeddb', 'websql'] : []),
            ...(clearSession ? ['session_storage'] : []),
            ...(clearCache ? ['cache_storage', 'service_workers'] : []),
          ];
          if (storageTypes.length) {
            await cdpSend('Storage.clearDataForOrigin', { origin, storageTypes: storageTypes.join(',') }).catch(() => {});
          }
        }
        if (clearCookies) {
          const cookieResult = await cdpSend('Network.getCookies', { urls: url ? [url] : [] }).catch(() => ({ cookies: [] }));
          for (const cookie of Array.isArray(cookieResult?.cookies) ? cookieResult.cookies : []) {
            await cdpSend('Network.deleteCookies', {
              name: String(cookie?.name || ''),
              domain: String(cookie?.domain || ''),
              path: String(cookie?.path || '/'),
            }).catch(() => {});
          }
          cleared.push('cookies');
        }
        if (clearLocal || clearSession) {
          await evaluateInChrome(`(() => {
            if (${clearLocal ? 'true' : 'false'}) localStorage.clear();
            if (${clearSession ? 'true' : 'false'}) sessionStorage.clear();
            return true;
          })()`).catch(() => {});
          if (clearLocal) cleared.push('localStorage');
          if (clearSession) cleared.push('sessionStorage');
        }
        if (clearCache) {
          await cdpSend('Network.clearBrowserCache', {}).catch(() => {});
          cleared.push('cache');
        }
        return { cleared, origin, state: await (window as any).__BBARIT_BROWSER__.storageState(options as any) };
      },
      permissionsState: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const url = currentUrlRef.current || currentUrl;
        const runtime = remoteValue(await evaluateInChrome(`(async () => {
          const names = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read', 'clipboard-write'];
          const states = {};
          for (const name of names) {
            try {
              states[name] = await navigator.permissions?.query({ name }).then((permission) => permission.state);
            } catch (error) {
              states[name] = 'error:' + String(error && error.message || error);
            }
          }
          return { url: location.href, origin: location.origin, states };
        })()`)) || {};
        return {
          url: redactUrl(url),
          origin: runtime.origin || '',
          states: runtime.states || {},
        };
      },
      grantPermissions: async (permissions: string[] | string, options?: { origin?: string }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const url = currentUrlRef.current || currentUrl;
        const parsed = (() => { try { return new URL(String(options?.origin || url)); } catch { return null; } })();
        const origin = parsed?.origin && parsed.origin !== 'null' ? parsed.origin : undefined;
        const aliases: Record<string, string> = {
          camera: 'videoCapture',
          video: 'videoCapture',
          microphone: 'audioCapture',
          mic: 'audioCapture',
          audio: 'audioCapture',
          notification: 'notifications',
          notifications: 'notifications',
          clipboard: 'clipboardReadWrite',
          'clipboard-read': 'clipboardReadWrite',
          'clipboard-write': 'clipboardSanitizedWrite',
          'clipboard-read-write': 'clipboardReadWrite',
          geolocation: 'geolocation',
          location: 'geolocation',
          midi: 'midi',
          sensors: 'sensors',
          'display-capture': 'displayCapture',
          'window-management': 'windowManagement',
        };
        const raw = Array.isArray(permissions) ? permissions : String(permissions || '').split(',');
        const mapped = Array.from(new Set(raw
          .map((permission) => String(permission || '').trim())
          .filter(Boolean)
          .map((permission) => aliases[permission] || permission)));
        if (!mapped.length) throw new Error('Missing permissions to grant.');
        await cdpBrowserSend('Browser.grantPermissions', { permissions: mapped, ...(origin ? { origin } : {}) });
        return { granted: mapped, origin: origin || '', state: await (window as any).__BBARIT_BROWSER__.permissionsState() };
      },
      resetPermissions: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        await cdpBrowserSend('Browser.resetPermissions', {});
        await cdpSend('Emulation.clearGeolocationOverride', {}).catch(() => {});
        return { reset: true, state: await (window as any).__BBARIT_BROWSER__.permissionsState() };
      },
      setGeolocation: async (options?: { latitude?: number; longitude?: number; accuracy?: number; grant?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const latitude = Number(options?.latitude);
        const longitude = Number(options?.longitude);
        const accuracy = Number.isFinite(Number(options?.accuracy)) ? Math.max(0, Number(options?.accuracy)) : 20;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          throw new Error('setGeolocation requires finite latitude and longitude.');
        }
        if (options?.grant !== false) {
          await (window as any).__BBARIT_BROWSER__.grantPermissions(['geolocation']);
        }
        await cdpSend('Emulation.setGeolocationOverride', { latitude, longitude, accuracy });
        return { latitude, longitude, accuracy, state: await (window as any).__BBARIT_BROWSER__.permissionsState() };
      },
      clearGeolocation: async () => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        await cdpSend('Emulation.clearGeolocationOverride', {});
        return { cleared: true, state: await (window as any).__BBARIT_BROWSER__.permissionsState() };
      },
      setDownloadBehavior: async (options?: { path?: string; behavior?: 'allow' | 'allowAndName' | 'deny' | 'default' }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const behavior = options?.behavior || 'allow';
        const downloadPath = String(options?.path || '').trim();
        if ((behavior === 'allow' || behavior === 'allowAndName') && !downloadPath) {
          throw new Error('setDownloadBehavior requires a download path when behavior is allow/allowAndName.');
        }
        // WebView는 자체 다운로드 핸들러가 CDP setDownloadBehavior보다 먼저 가로채므로,
        // 네이티브 다운로드 폴더를 직접 지정한다(그리고 CDP도 best-effort로 유지).
        await invoke('cef_set_download_dir', { dir: (behavior === 'deny' ? '' : downloadPath) }).catch(() => {});
        await cdpBrowserSend('Browser.setDownloadBehavior', {
          behavior,
          ...(downloadPath ? { downloadPath } : {}),
          eventsEnabled: true,
        }).catch(() => {});
        return { behavior, downloadPath, eventsEnabled: true };
      },
      downloads: () => Array.from(downloadRecordsRef.current.values())
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))),
      clearDownloads: () => {
        clearDownloadRecords();
        return { cleared: true };
      },
      waitForDownload: async (options?: { guid?: string; timeoutMs?: number; state?: string }) => {
        const guid = String(options?.guid || '');
        const timeoutMs = Math.max(250, Math.min(120000, Number(options?.timeoutMs || 30000)));
        const wantedState = String(options?.state || 'completed');
        const started = Date.now();
        let last: BrowserDownloadRecord | null = null;
        while (Date.now() - started <= timeoutMs) {
          const records = Array.from(downloadRecordsRef.current.values())
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
          last = guid ? records.find((record) => record.guid === guid) || last : records[0] || last;
          if (last && (wantedState === 'any' || last.state === wantedState || (wantedState === 'terminal' && (last.state === 'completed' || last.state === 'canceled' || last.state === 'failed')))) {
            return { ok: true, download: last, downloads: records };
          }
          await delay(150);
        }
        return { ok: false, timeoutMs, download: last, downloads: Array.from(downloadRecordsRef.current.values()) };
      },
      cancelDownload: async (guid: string) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const id = String(guid || '');
        if (!id) throw new Error('Missing download guid.');
        await cdpBrowserSend('Browser.cancelDownload', { guid: id }).catch((error: unknown) => {
          throw new Error(`Failed to cancel download ${id}: ${error instanceof Error ? error.message : String(error)}`);
        });
        return { canceled: id };
      },
      clipboardWrite: async (text: string, options?: { grant?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const value = String(text ?? '');
        const attempts: Array<{ method: string; ok: boolean; error?: string }> = [];
        if (options?.grant !== false) {
          await (window as any).__BBARIT_BROWSER__.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
        }
        const pageWrite = await evaluateInChrome(`(async () => {
          try {
            if (!navigator.clipboard?.writeText) return { ok: false, error: 'navigator.clipboard.writeText unavailable' };
            await navigator.clipboard.writeText(${JSON.stringify(value)});
            return { ok: true };
          } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
          }
        })()`).then(remoteValue).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        attempts.push({ method: 'navigator.clipboard.writeText', ok: !!pageWrite?.ok, ...(pageWrite?.error ? { error: String(pageWrite.error) } : {}) });
        if (pageWrite?.ok) return { ok: true, method: 'navigator.clipboard.writeText', valueLength: value.length, attempts };
        await invoke('copy_to_clipboard', { text: value });
        attempts.push({ method: 'tauri.copy_to_clipboard', ok: true });
        return { ok: true, method: 'tauri.copy_to_clipboard', valueLength: value.length, attempts };
      },
      clipboardRead: async (options?: { grant?: boolean; includeSecrets?: boolean }) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const includeSecrets = !!options?.includeSecrets;
        const attempts: Array<{ method: string; ok: boolean; error?: string }> = [];
        if (options?.grant !== false) {
          await (window as any).__BBARIT_BROWSER__.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
        }
        const pageRead = await evaluateInChrome(`(async () => {
          try {
            if (!navigator.clipboard?.readText) return { ok: false, error: 'navigator.clipboard.readText unavailable' };
            const text = await navigator.clipboard.readText();
            return { ok: true, text };
          } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
          }
        })()`).then(remoteValue).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        attempts.push({ method: 'navigator.clipboard.readText', ok: !!pageRead?.ok, ...(pageRead?.error ? { error: String(pageRead.error) } : {}) });
        if (pageRead?.ok) {
          const text = String(pageRead.text || '');
          return { ok: true, method: 'navigator.clipboard.readText', text: includeSecrets ? text : REDACTED_VALUE, valueLength: text.length, attempts };
        }
        const text = String(await invoke('read_clipboard_text'));
        attempts.push({ method: 'tauri.read_clipboard_text', ok: true });
        return { ok: true, method: 'tauri.read_clipboard_text', text: includeSecrets ? text : REDACTED_VALUE, valueLength: text.length, attempts };
      },
      pasteClipboardSelector: async (selector: string) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const clip = await (window as any).__BBARIT_BROWSER__.clipboardRead({ includeSecrets: true });
        const result = await pasteSelectorInChrome(String(selector || ''), String(clip.text || ''));
        return { clipboard: { method: clip.method, valueLength: clip.valueLength }, result };
      },
      copySelector: async (selector: string) => {
        if (!(await ensureLiveSession())) {
          throw new Error('Browser control connection is detached; reconnect the BBARIT Browser first.');
        }
        const extracted = remoteValue(await evaluateInChrome(`(() => {
          const node = document.querySelector(${JSON.stringify(String(selector || ''))});
          if (!node) return { ok: false, reason: 'selector-missing', text: '' };
          let text = '';
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) text = node.value;
          else text = node.textContent || '';
          return { ok: true, text, tagName: node.tagName, valueLength: text.length };
        })()`)) || {};
        if (!extracted.ok) return extracted;
        const write = await (window as any).__BBARIT_BROWSER__.clipboardWrite(String(extracted.text || ''));
        return { ok: true, selector, tagName: extracted.tagName || '', valueLength: Number(extracted.valueLength || 0), write };
      },
      // Packet inspection over the embedded WebView records. The CLI's
      // packets/packet/HAR commands and the network audit use this one surface.
      packets: () => Array.from(networkRecordsRef.current.values())
        .sort((a, b) => a.startedAtMs - b.startedAtMs)
        .map((r) => ({
          id: r.id,
          requestId: r.requestId,
          url: redactUrl(r.url),
          method: r.method || '',
          status: r.status ?? null,
          statusText: r.statusText || '',
          resourceType: r.resourceType || '',
          mimeType: r.mimeType || '',
          failed: !!r.failed,
          errorText: r.errorText || '',
          fromDiskCache: !!r.fromDiskCache,
          startedAt: r.startedAt,
          durationMs: r.durationMs ?? null,
          encodedDataLength: r.encodedDataLength ?? null,
        })),
      packet: (id: string, options?: { includeSecrets?: boolean }) => {
        const record = Array.from(networkRecordsRef.current.values()).find((r) => r.id === id || r.requestId === id);
        if (!record) throw new Error(`packet not found: ${id}`);
        return redactNetworkRecord(record, !!options?.includeSecrets);
      },
      packetBody: async (id: string, options?: { includeSecrets?: boolean }) => {
        const record = Array.from(networkRecordsRef.current.values()).find((r) => r.id === id || r.requestId === id);
        if (!record) throw new Error(`packet not found: ${id}`);
        if (record.body == null && !record.bodyError && !record.failed) {
          try {
            const result = await cdpSend('Network.getResponseBody', { requestId: record.requestId });
            record.body = typeof result?.body === 'string' ? result.body : '';
            record.bodyBase64Encoded = !!result?.base64Encoded;
          } catch (error) {
            record.bodyError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          body: options?.includeSecrets ? (record.body ?? null) : redactText(record.body),
          base64: !!record.bodyBase64Encoded,
          error: record.bodyError || null,
        };
      },
      requestBody: async (id: string, options?: { includeSecrets?: boolean }) => {
        const record = Array.from(networkRecordsRef.current.values()).find((r) => r.id === id || r.requestId === id);
        if (!record) throw new Error(`packet not found: ${id}`);
        if (record.postData == null && !record.postDataError) {
          try {
            const result = await cdpSend('Network.getRequestPostData', { requestId: record.requestId });
            if (typeof result?.postData === 'string') record.postData = result.postData;
          } catch (error) {
            record.postDataError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          postData: options?.includeSecrets ? (record.postData ?? null) : redactText(record.postData),
          error: record.postDataError || null,
        };
      },
      exchange: async (id: string, options?: { includeSecrets?: boolean }) => {
        const includeSecrets = !!options?.includeSecrets;
        const record = Array.from(networkRecordsRef.current.values()).find((r) => r.id === id || r.requestId === id);
        if (!record) throw new Error(`packet not found: ${id}`);
        const responseBody = await (window as any).__BBARIT_BROWSER__.packetBody(id, { includeSecrets });
        const requestBody = await (window as any).__BBARIT_BROWSER__.requestBody(id, { includeSecrets });
        const packet = redactNetworkRecord(record, includeSecrets);
        const requestHeaders = redactHeaderMap(record.requestHeaders, includeSecrets);
        const responseHeaders = redactHeaderMap(record.responseHeaders, includeSecrets);
        const method = packet.method || 'GET';
        const fetchInit: Record<string, unknown> = { method, credentials: 'include', cache: 'no-store' };
        if (Object.keys(requestHeaders).length) fetchInit.headers = requestHeaders;
        if (!/^(GET|HEAD)$/i.test(method) && requestBody.postData) fetchInit.body = requestBody.postData;
        const fetchSnippet = `await fetch(${JSON.stringify(packet.url)}, ${JSON.stringify(fetchInit, null, 2)});`;
        const shellQuote = (value: unknown) => `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
        const curlParts = ['curl', '-i', '-X', shellQuote(method)];
        for (const [name, value] of Object.entries(requestHeaders)) curlParts.push('-H', shellQuote(`${name}: ${value}`));
        if (!/^(GET|HEAD)$/i.test(method) && requestBody.postData) curlParts.push('--data-raw', shellQuote(requestBody.postData));
        curlParts.push(shellQuote(packet.url));
        return {
          id: packet.id,
          requestId: packet.requestId,
          url: packet.url,
          request: {
            method,
            headers: requestHeaders,
            postData: requestBody.postData,
            postDataError: requestBody.error,
            initiator: packet.initiator || '',
            startedAt: packet.startedAt,
          },
          response: {
            status: packet.status ?? null,
            statusText: packet.statusText || '',
            headers: responseHeaders,
            mimeType: packet.mimeType || '',
            protocol: packet.protocol || '',
            remoteIPAddress: packet.remoteIPAddress || '',
            fromDiskCache: !!packet.fromDiskCache,
            body: responseBody.body,
            bodyBase64Encoded: !!responseBody.base64,
            bodyError: responseBody.error,
            durationMs: packet.durationMs ?? null,
            encodedDataLength: packet.encodedDataLength ?? null,
          },
          failed: !!packet.failed,
          errorText: packet.errorText || '',
          replay: { fetch: fetchSnippet, curl: curlParts.join(' ') },
          secretsIncluded: includeSecrets,
        };
      },
      composer: async (input: { method?: string; url?: string; headers?: string | HeaderMap; body?: string }) => {
        const method = String(input?.method || 'GET').toUpperCase();
        const url = normalizeUrl(String(input?.url || ''));
        if (!url) throw new Error('Missing composer URL.');
        const parseHeaders = (value: unknown): HeaderMap => {
          if (!value) return {};
          if (typeof value === 'object') return normalizeHeaders(value);
          const raw = String(value).trim();
          if (!raw) return {};
          try { return normalizeHeaders(JSON.parse(raw)); } catch { /* fall through */ }
          return Object.fromEntries(raw.split(/\r?\n/).map((line) => {
            const index = line.indexOf(':');
            return index > 0 ? [line.slice(0, index).trim(), line.slice(index + 1).trim()] : ['', ''];
          }).filter(([name]) => name));
        };
        const headers = parseHeaders(input?.headers);
        const started = performance.now();
        try {
          const response = await invoke<any>('http_request', {
            input: {
              method,
              url,
              headers,
              body: /^(GET|HEAD)$/i.test(method) ? null : String(input?.body ?? ''),
              timeout_ms: 30000,
            },
          });
          const responseHeaders = Array.isArray(response?.headers)
            ? Object.fromEntries((response.headers.map((pair: unknown): [string, string] => Array.isArray(pair) ? [String(pair[0] || ''), String(pair[1] || '')] : ['', ''])).filter(([name]: [string, string]) => name))
            : normalizeHeaders(response?.headers);
          const body = String(response?.body || '');
          const status = Number(response?.status || 0);
          return {
            ok: status >= 200 && status < 400,
            status,
            statusText: String(response?.status_text || response?.statusText || ''),
            url,
            durationMs: Math.round(performance.now() - started),
            contentType: headerValue(responseHeaders, 'content-type'),
            headers: responseHeaders,
            body: body.slice(0, 20000),
            bodyLength: body.length,
            truncated: !!response?.truncated,
          };
        } catch (error) {
          return { ok: false, url, durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
        }
      },
      har: (options?: { includeSecrets?: boolean }) => {
        const includeSecrets = !!options?.includeSecrets;
        const entries = Array.from(networkRecordsRef.current.values())
          .sort((a, b) => a.startedAtMs - b.startedAtMs)
          .map((record) => {
            const r = redactNetworkRecord(record, includeSecrets);
            const requestHeaders = redactHeaderMap(record.requestHeaders, includeSecrets);
            const responseHeaders = redactHeaderMap(record.responseHeaders, includeSecrets);
            const bodySize = typeof r.encodedDataLength === 'number' ? r.encodedDataLength : (r.body ? r.body.length : -1);
            const wait = Math.max(0, Math.round(r.durationMs ?? ((r.finishedAtMs || r.startedAtMs) - r.startedAtMs)));
            return {
              startedDateTime: r.startedAt,
              time: wait,
              request: {
                method: r.method || 'GET',
                url: r.url,
                httpVersion: r.protocol || 'HTTP/2',
                headers: headerMapToPairs(requestHeaders),
                queryString: (() => { try { return Array.from(new URL(r.url).searchParams.entries()).map(([name, value]) => ({ name, value })); } catch { return []; } })(),
                cookies: [],
                headersSize: -1,
                bodySize: r.postData ? r.postData.length : 0,
                ...(r.postData ? { postData: { mimeType: headerValue(requestHeaders, 'content-type'), text: r.postData } } : {}),
              },
              response: {
                status: r.status ?? 0,
                statusText: r.statusText || '',
                httpVersion: r.protocol || 'HTTP/2',
                headers: headerMapToPairs(responseHeaders),
                cookies: [],
                content: {
                  size: bodySize,
                  mimeType: r.mimeType || headerValue(responseHeaders, 'content-type') || '',
                  ...(r.body ? { text: r.body, encoding: r.bodyBase64Encoded ? 'base64' : undefined } : {}),
                },
                redirectURL: headerValue(responseHeaders, 'location'),
                headersSize: -1,
                bodySize,
              },
              cache: {},
              timings: { blocked: 0, dns: -1, connect: -1, send: 0, wait, receive: 0, ssl: -1 },
              serverIPAddress: r.remoteIPAddress || '',
              _resourceType: r.resourceType || '',
              _requestId: r.requestId,
              _failed: !!r.failed,
              _errorText: r.errorText || '',
            };
          });
        return {
          log: {
            version: '1.2',
            creator: { name: 'BBARIT Browser', version: '1.0' },
            pages: [{ startedDateTime: entries[0]?.startedDateTime || new Date().toISOString(), id: 'page_1', title: document.title || currentUrl, pageTimings: {} }],
            entries,
          },
        };
      },
      security: async (options?: { includeSecrets?: boolean }) => {
        const includeSecrets = !!options?.includeSecrets;
        const url = currentUrlRef.current || currentUrl;
        const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
        const records = Array.from(networkRecordsRef.current.values()).sort((a, b) => a.startedAtMs - b.startedAtMs);
        const documentRecord = records.find((record) => record.resourceType === 'Document')
          || records.find((record) => origin && record.url.startsWith(origin) && Number(record.status || 0) >= 200);
        const headers = redactHeaderMap(documentRecord?.responseHeaders, includeSecrets);
        const consoleErrors = consoleEntriesRef.current.filter((entry) => /error|exception/i.test(entry.type));
        const mixedContent = /^https:/i.test(url)
          ? records.filter((record) => /^http:/i.test(record.url)).map((record) => redactUrl(record.url)).slice(0, 20)
          : [];
        const failedNetwork = records.filter((record) => record.failed || Number(record.status || 0) >= 400).slice(-20).map((record) => ({
          url: includeSecrets ? record.url : redactUrl(record.url),
          status: record.status ?? null,
          errorText: record.errorText || '',
        }));
        const findings: Array<{ level: 'pass' | 'warning' | 'error'; code: string; message: string }> = [];
        const hasHeader = (name: string) => !!headerValue(headers, name);
        if (/^https:/i.test(url) && !hasHeader('strict-transport-security')) findings.push({ level: 'warning', code: 'missing-hsts', message: 'HTTPS page has no Strict-Transport-Security header.' });
        if (!hasHeader('content-security-policy')) findings.push({ level: 'warning', code: 'missing-csp', message: 'No Content-Security-Policy header was observed.' });
        if (!/nosniff/i.test(headerValue(headers, 'x-content-type-options'))) findings.push({ level: 'warning', code: 'missing-nosniff', message: 'X-Content-Type-Options: nosniff was not observed.' });
        if (!hasHeader('x-frame-options') && !/frame-ancestors/i.test(headerValue(headers, 'content-security-policy'))) findings.push({ level: 'warning', code: 'missing-frame-protection', message: 'No X-Frame-Options or CSP frame-ancestors protection was observed.' });
        if (!hasHeader('referrer-policy')) findings.push({ level: 'warning', code: 'missing-referrer-policy', message: 'No Referrer-Policy header was observed.' });
        if (!hasHeader('permissions-policy')) findings.push({ level: 'warning', code: 'missing-permissions-policy', message: 'No Permissions-Policy header was observed.' });
        if (mixedContent.length) findings.push({ level: 'error', code: 'mixed-content', message: `${mixedContent.length} HTTP resources were requested from an HTTPS page.` });
        if (consoleErrors.length) findings.push({ level: 'warning', code: 'console-errors', message: `${consoleErrors.length} console errors/exceptions were captured.` });
        if (failedNetwork.length) findings.push({ level: 'warning', code: 'network-failures', message: `${failedNetwork.length} failed or 4xx/5xx network records were captured.` });
        try {
          const parsed = new URL(url);
          for (const key of parsed.searchParams.keys()) {
            if (SENSITIVE_KEY_RE.test(key)) findings.push({ level: 'warning', code: 'sensitive-query', message: `Sensitive-looking query parameter detected: ${key}.` });
          }
        } catch { /* ignore invalid URL */ }
        const warningCount = findings.filter((finding) => finding.level === 'warning').length;
        const errorCount = findings.filter((finding) => finding.level === 'error').length;
        return {
          ok: errorCount === 0,
          url: includeSecrets ? url : redactUrl(url),
          document: documentRecord ? {
            requestId: documentRecord.requestId,
            status: documentRecord.status ?? null,
            mimeType: documentRecord.mimeType || '',
            headers,
          } : null,
          summary: {
            findings: findings.length,
            warnings: warningCount,
            errors: errorCount,
            consoleErrors: consoleErrors.length,
            failedNetwork: failedNetwork.length,
            mixedContent: mixedContent.length,
          },
          findings: findings.length ? findings : [{ level: 'pass', code: 'baseline', message: 'No baseline security errors were detected from captured browser evidence.' }],
          evidence: { mixedContent, failedNetwork },
        };
      },
      autoResponderStatus: () => ({
        active: autoResponderActiveRef.current,
        rules: autoResponderRulesRef.current,
        enabledRules: autoResponderRulesRef.current.filter((rule) => rule.enabled).length,
        fetchInterceptionEnabled: fetchInterceptionEnabledRef.current,
      }),
      autoResponderRules: () => autoResponderRulesRef.current.slice(),
      autoResponderActive: () => autoResponderActiveRef.current,
      setAutoResponderActive: async (active: boolean) => {
        autoResponderActiveRef.current = !!active;
        await configureFetchInterception();
        return (window as any).__BBARIT_BROWSER__.autoResponderStatus();
      },
      setAutoResponderRules: async (rules: BrowserAutoResponderRule[]) => {
        autoResponderRulesRef.current = (Array.isArray(rules) ? rules : []).map((rule) => ({
          ...rule,
          id: String(rule.id || `ar-${Date.now().toString(36)}`),
          enabled: rule.enabled !== false,
          urlPattern: String(rule.urlPattern || ''),
          isRegex: !!rule.isRegex,
          status: Math.max(100, Math.min(599, Number(rule.status || 200))),
          statusText: String(rule.statusText || rule.status || 'OK'),
          headers: normalizeHeaders(rule.headers || {}),
          body: String(rule.body ?? ''),
          delayMs: Math.max(0, Math.min(30000, Number(rule.delayMs || 0))),
        })).filter((rule) => rule.urlPattern);
        await configureFetchInterception();
        return (window as any).__BBARIT_BROWSER__.autoResponderStatus();
      },
      breakpointStatus: () => ({
        active: breakpointActiveRef.current,
        rules: breakpointRulesRef.current,
        enabledRules: breakpointRulesRef.current.filter((rule) => rule.enabled).length,
        paused: pausedBreakpointRef.current,
        fetchInterceptionEnabled: fetchInterceptionEnabledRef.current,
      }),
      breakpointRules: () => breakpointRulesRef.current.slice(),
      breakpointActive: () => breakpointActiveRef.current,
      setBreakpointActive: async (active: boolean) => {
        breakpointActiveRef.current = !!active;
        if (!breakpointActiveRef.current && pausedBreakpointRef.current) {
          await cdpSend('Fetch.continueRequest', { requestId: pausedBreakpointRef.current.requestId }).catch(() => {});
          pausedBreakpointRef.current = null;
        }
        if (!breakpointActiveRef.current) breakpointBypassRef.current.clear();
        await configureFetchInterception();
        return (window as any).__BBARIT_BROWSER__.breakpointStatus();
      },
      setBreakpointRules: async (rules: BrowserBreakpointRule[]) => {
        breakpointRulesRef.current = (Array.isArray(rules) ? rules : []).map((rule): BrowserBreakpointRule => {
          const phase: BrowserBreakpointRule['phase'] = rule.phase === 'response' || rule.phase === 'both' ? rule.phase : 'request';
          return {
            ...rule,
            id: String(rule.id || `bp-${Date.now().toString(36)}`),
            enabled: rule.enabled !== false,
            urlPattern: String(rule.urlPattern || ''),
            isRegex: !!rule.isRegex,
            phase,
          };
        }).filter((rule) => rule.urlPattern);
        await configureFetchInterception();
        return (window as any).__BBARIT_BROWSER__.breakpointStatus();
      },
      resumeBreakpoint: async () => {
        const paused = pausedBreakpointRef.current;
        if (!paused) return { resumed: false, reason: 'no-paused-request' };
        pausedBreakpointRef.current = null;
        if (paused.stage === 'request') {
          breakpointBypassRef.current.add(`request:${paused.method} ${paused.url}`);
        }
        await cdpSend('Fetch.continueRequest', { requestId: paused.requestId });
        return { resumed: true, request: paused };
      },
      abortBreakpoint: async (reason = 'Aborted') => {
        const paused = pausedBreakpointRef.current;
        if (!paused) return { aborted: false, reason: 'no-paused-request' };
        pausedBreakpointRef.current = null;
        await cdpSend('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'Aborted' });
        pushNetworkEntry({
          type: 'failed',
          requestId: paused.networkRequestId || paused.requestId,
          url: paused.url,
          resourceType: paused.resourceType,
          errorText: String(reason || 'Aborted'),
          timestamp: new Date().toISOString(),
        });
        return { aborted: true, request: paused, reason };
      },
      // Guide/UI-only helpers are still intentionally absent from the API surface.
      ...Object.fromEntries([
        'guide', 'example',
        'showGuide', 'showTerminal', 'showTree',
      ].map((name) => [name, () => {
        throw new Error(`'${name}' was removed in the SEO-workbench redesign of the BBARIT Browser. Use navigate/text/screenshot/network/packets/cdp instead, or ask to restore the tooling.`);
      }])),
    };
    return () => {
      delete (window as any).__BBARIT_BROWSER__;
    };
  }, [address, captureBrowserScreenshot, cdpBrowserSend, cdpFire, cdpSend, cefActiveId, cefAttachCdp, cefAvailable, cefCloseTab, cefMode, cefOpenTab, cefSwitchTab, cefTabs, cefToggleDevtools, checkSelectorInChrome, clickSelectorInChrome, collectChromeFidelity, configureFetchInterception, currentUrl, dragDropSelectorInChrome, emulateViewportInChrome, ensureLiveSession, error, evalInNativeWebView, evalInNativeWebViewWithResult, evaluateInChrome, findInPage, focusSelectorInChrome, goCefHistory, isLoading, navState, pasteSelectorInChrome, projectRoot, readHtmlInChrome, readTextInChrome, recordSave, recordStart, recordStatus, recordStop, selectSelectorInChrome, setBrowserLocation, setValueSelectorInChrome, stopLoading, typeSelectorInChrome, uploadSelectorInChrome, waitForChrome, withCefHistory, zoomInPage]);

  useEffect(() => {
    // StrictMode 이중 마운트 가드: cleanup이 listen() 프라미스 해제 전에 돌면
    // unlisten이 undefined라 리스너가 살아남고, 재마운트가 두 번째 리스너를
    // 추가해 모든 RPC body가 2번 실행되던 버그(클릭 2번 → 토글 원위치).
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 같은 id의 중복 배달(리스너 누수/재전송)에도 body가 한 번만 실행되게 방어.
    const seenRpcIds = new Set<string>();
    void listen<any>('bbarit-browser-rpc', async (event) => {
      const payload = event.payload || {};
      const id = String(payload.id || '');
      if (!id || seenRpcIds.has(id)) return;
      seenRpcIds.add(id);
      if (seenRpcIds.size > 500) seenRpcIds.clear();
      const resultEvent = `bbarit-browser-rpc-result-${id}`;
      try {
        const api = (window as any).__BBARIT_BROWSER__;
        if (!api) throw new Error('BBARIT browser API is not ready in this window.');
        if (payload.sessionId && typeof api.useSessionTab === 'function') {
          (window as any).__BBARIT_SESSION_TAB__ = await api.useSessionTab(String(payload.sessionId), String(payload.sessionUrl || ''));
        } else {
          (window as any).__BBARIT_SESSION_TAB__ = null;
        }
        const body = String(payload.body || '');
        const result = await new Function('api', `return (async () => { ${body} })();`)(api);
        await emitTo('main', resultEvent, { ok: true, result });
      } catch (err) {
        await emitTo('main', resultEvent, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }).then((fn) => {
      if (disposed) { fn(); return; }
      unlisten = fn;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // Load persisted history once, then record every distinct page the user lands on.
  useEffect(() => {
    void kvGet('bbarit-browser-history').then((raw) => {
      try { const parsed = JSON.parse(raw || '[]'); if (Array.isArray(parsed)) historyRef.current = parsed as HistoryEntry[]; } catch { /* ignore corrupt store */ }
      historyLoadedRef.current = true;
    });
    // 로드는 병합으로: 로드가 끝나기 전에 이미 기록된 항목이 있으면(로드/기록 경합)
    // 대체가 아니라 합친다 — 대체하면 그 사이 kvSet이 과거 기록을 지운 상태로 남는다.
    void kvGet('bbarit-browser-clips').then((raw) => {
      try {
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return;
        setWebClips((prev) => {
          const seen = new Set<string>();
          const merged = [...prev, ...(parsed as WebClip[])].filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))).slice(0, 100);
          if (prev.length) void kvSet('bbarit-browser-clips', JSON.stringify(merged));
          return merged;
        });
      } catch { /* ignore corrupt store */ }
    });
    void kvGet('bbarit-browser-recent-tasks').then((raw) => {
      try {
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return;
        setAsideRecentTasks((prev) => {
          const seen = new Set<string>();
          const merged = [...prev, ...(parsed as AsideRecentTask[])].filter((t) => (seen.has(t.text) ? false : (seen.add(t.text), true))).slice(0, 20);
          if (prev.length) void kvSet('bbarit-browser-recent-tasks', JSON.stringify(merged));
          return merged;
        });
      } catch { /* ignore corrupt store */ }
    });
    void kvGet('bbarit-browser-audit').then((raw) => {
      try {
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return;
        setAsideAudit((prev) => {
          const loaded = parsed as AsideAuditEntry[];
          const merged = [...loaded, ...prev.filter((e) => !loaded.some((p) => p.at === e.at && p.text === e.text))].slice(-200);
          if (prev.length) void kvSet('bbarit-browser-audit', JSON.stringify(merged));
          return merged;
        });
      } catch { /* ignore corrupt store */ }
    });
  }, []);
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    if (!/^https?:/i.test(currentUrl)) return; // only real web pages
    const now = Date.now();
    const next = recordVisit(historyRef.current, { url: currentUrl, title: currentUrl }, now);
    if (next !== historyRef.current) {
      historyRef.current = next;
      void kvSet('bbarit-browser-history', JSON.stringify(next));
    }
    // Persist the session snapshot on every real navigation.
    const snap = captureSession(sessionRef.current, { url: currentUrl, title: currentUrl }, now);
    if (snap && snap !== sessionRef.current) {
      sessionRef.current = snap;
      void kvSet(SESSION_KV_KEY, serializeSession(snap));
    }
  }, [currentUrl]);
  // On mount, offer to restore the last session (validated + fresh only).
  useEffect(() => {
    void kvGet(SESSION_KV_KEY).then((raw) => {
      const snap = restoreSession(raw, Date.now());
      if (snap) { sessionRef.current = snap; setRestorable(snap); }
    });
  }, []);
  // First-run onboarding: show once per capability version.
  useEffect(() => {
    void kvGet('bbarit-browser-onboarding').then((raw) => {
      if (shouldShowOnboarding(parseOnboardingState(raw))) setShowOnboarding(true);
    });
  }, []);
  const dismissOnboarding = useCallback(() => {
    setShowOnboarding(false);
    void kvSet('bbarit-browser-onboarding', serializeOnboardingState(markOnboardingSeen(Date.now())));
  }, []);
  // After a page settles, check ONCE whether it is an anti-bot wall and surface a
  // user-facing notice. One eval per navigation (not a timer) keeps it cheap.
  useEffect(() => {
    if (!/^https?:/i.test(currentUrl) || isLoading) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled || exactWsRef.current?.readyState !== WebSocket.OPEN) return;
      try {
        // One eval gathers text + login/captcha widget signals so the notice can tell
        // the user to solve a captcha or log in DIRECTLY in the browser view.
        const probe = `(() => {
          const title = document.title || '';
          const text = (document.body ? document.body.innerText : '').slice(0, 3000);
          const pw = !!document.querySelector('input[type=password]');
          const cap = !!document.querySelector('.g-recaptcha,iframe[src*=recaptcha],iframe[title*=recaptcha],.h-captcha,iframe[src*=hcaptcha],iframe[src*=turnstile],#captcha,[class*=captcha]');
          return JSON.stringify({ title, text, pw, cap });
        })()`;
        const raw = await evaluateInChrome(probe);
        const parsed = JSON.parse(String(raw?.result?.value || '{}'));
        const failedStatus = networkEntriesRef.current.filter((n) => n.url === currentUrl && typeof n.status === 'number' && n.status >= 400).map((n) => n.status as number);
        const verdict = detectBlock({ url: currentUrl, title: parsed.title, text: parsed.text, statuses: failedStatus, hasPasswordField: !!parsed.pw, hasCaptchaWidget: !!parsed.cap });
        if (cancelled) return;
        setBlockNotice(verdict.blocked ? verdict : null);
      } catch { /* eval can race navigation; ignore */ }
    }, 1500);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUrl, isLoading]);
  // Keyboard a11y: Escape dismisses the onboarding overlay (and it traps focus on its CTA).
  const onboardingCtaRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!showOnboarding) return;
    onboardingCtaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); dismissOnboarding(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showOnboarding, dismissOnboarding]);
  // Keyboard a11y: Escape closes the History & Bookmarks panel.
  useEffect(() => {
    if (!showHistoryPanel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setShowHistoryPanel(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showHistoryPanel]);


  // Crawl the current host with the live browser engine and audit it like Screaming Frog's
  // Internal tab: BFS HTML pages (depth-tracked, per-page response attributed from the network
  // network records), build a link graph (inlinks/outlinks), then validate robots.txt + sitemap and
  // run a capped status pass over internal resources + external links (broken-link checker).
  const runSeoCrawl = useCallback(async (): Promise<SeoReport | null> => {
    const ko = locale === 'ko';
    const startUrl = normalizeUrl(currentUrl);
    let host = '';
    let origin = '';
    try {
      const u = new URL(startUrl);
      host = u.hostname;
      origin = u.origin;
    } catch {
      setSeoReportStatus(ko ? 'Cannot start SEO crawl: the address is not a valid URL.' : 'Cannot start SEO crawl: the address is not a valid URL.');
      return null;
    }
    if (!isTauri()) {
      setSeoReportStatus(ko ? 'Open this workspace in the BBARIT desktop app to run SEO reports.' : 'Open this workspace in the BBARIT desktop app to run SEO reports.');
      return null;
    }
    if (!(await ensureLiveSession(startUrl))) {
      // CDP 미가용(macOS WKWebView): 탭 + 네이티브 eval만으로 크롤 가능 — 탭만 확보한다.
      // 페이지 이동은 loadUrl의 네이티브 폴백, DOM 추출은 evaluateInChrome의 네이티브
      // 폴백, 문서 응답 메타는 아래 httpStatus 프로브가 대신한다.
      const hasTab = cefTabsRef.current.length > 0 || (await cefOpenTab(startUrl)) != null;
      if (!hasTab) {
        setSeoReportStatus(ko ? 'Could not start the browser session.' : 'Could not start the browser session.');
        return null;
      }
    }
    setSeoReportStatus('');
    const cap = Math.max(1, Math.min(500, Math.floor(seoMaxPages) || 30));
    seoStopRef.current = false;
    setSeoRunning(true);
    setSeoReport(null);
    setSeoProgress({ done: 0, total: cap, current: startUrl });

    const normKey = (u: string) => { try { const x = new URL(u); x.hash = ''; return x.toString(); } catch { return u; } };
    const sameHost = (u: string) => { try { return new URL(u).hostname === host; } catch { return false; } };
    const httpReq = async (url: string, method: 'GET' | 'HEAD'): Promise<{ status?: number; statusText: string; contentType: string; size?: number }> => {
      try {
        const res = await invoke<any>('http_request', { input: { method, url, timeout_ms: 6000 } });
        const headers = (res?.headers || {}) as Record<string, string>;
        const ct = headerValue(headers, 'content-type') || '';
        const len = Number(headerValue(headers, 'content-length') || '') || undefined;
        return { status: Number(res?.status) || undefined, statusText: String(res?.statusText || res?.status_text || ''), contentType: ct, size: len };
      } catch (e) {
        return { status: undefined, statusText: e instanceof Error ? e.message.slice(0, 60) : 'request failed', contentType: '', size: undefined };
      }
    };
    // HEAD first (cheap), but many servers/CDNs block HEAD (405/403) or don't answer - fall back to
    // GET so a HEAD-hostile-but-healthy resource isn't reported broken.
    const httpStatus = async (url: string): Promise<{ status?: number; statusText: string; contentType: string; size?: number }> => {
      const head = await httpReq(url, 'HEAD');
      if (head.status && head.status !== 405 && head.status !== 403 && head.status !== 501) return head;
      const get = await httpReq(url, 'GET');
      return get.status ? get : head;
    };

    // Phase 0 - robots.txt: parse with Allow/wildcard/$/multi-UA support. The matcher both reports
    // and ACTUALLY gates the crawl (disallowed internal URLs are not enqueued / are marked blocked).
    let robotsInfo: SeoRobotsInfo = { fetched: false, sitemaps: [], disallowCount: 0, startAllowed: true };
    let robotsAllows: (path: string) => boolean = () => true;
    const robotsPath = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return '/'; } };
    try {
      const res = await invoke<any>('http_request', { input: { method: 'GET', url: `${origin}/robots.txt`, timeout_ms: 9000 } });
      const status = Number(res?.status) || undefined;
      const body = typeof res?.body === 'string' ? res.body : '';
      const matcher = buildRobotsMatcher(body);
      if (status === 200 && matcher.ruleCount >= 0) robotsAllows = matcher.allows;
      robotsInfo = {
        fetched: status === 200, status,
        sitemaps: matcher.sitemaps,
        disallowCount: matcher.ruleCount,
        startAllowed: status === 200 ? matcher.allows(robotsPath(startUrl)) : true,
      };
    } catch { /* robots.txt missing is fine */ }

    const queue: { url: string; depth: number }[] = [{ url: normKey(startUrl), depth: 0 }];
    const queued = new Set<string>([normKey(startUrl)]);
    const visited = new Set<string>();
    const pages: SeoPageAudit[] = [];
    // Link graph: source page -> set of internal target keys it links to. Inlinks derived after.
    const outTargets = new Map<string, Set<string>>();
    // Internal resources and external links, each -> { min depth, set of referrer page keys } so
    // resource/external rows get real inlinks (which pages reference them), not a hardcoded 0.
    const resources = new Map<string, { depth: number; refs: Set<string> }>();
    const externalRefs = new Map<string, { depth: number; refs: Set<string> }>();
    // Internal links disallowed by robots.txt - surfaced as rows instead of silently dropped.
    const blockedLinks = new Map<string, { depth: number; refs: Set<string> }>();
    // page key -> content signature (MinHash-lite), for post-crawl near-duplicate detection.
    const contentSigs = new Map<string, number[]>();

    // One DOM round-trip per page: on-page SEO + outbound links + internal resource URLs.
    const extractExpr = `(() => {
      const abs = (h) => { try { return new URL(h, location.href).toString(); } catch { return ''; } };
      const meta = (sel) => { const n = document.querySelector(sel); return n ? (n.getAttribute('content') || '') : ''; };
      const canonicalEl = document.querySelector('link[rel="canonical"]');
      const canonical = canonicalEl ? abs(canonicalEl.getAttribute('href') || '') : '';
      const h1s = Array.from(document.querySelectorAll('h1')).map((n) => (n.textContent || '').trim()).filter(Boolean);
      const h2s = Array.from(document.querySelectorAll('h2')).map((n) => (n.textContent || '').trim()).filter(Boolean);
      const imgs = Array.from(document.images || []);
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map((a) => abs(a.getAttribute('href') || ''))
        .filter((h) => /^https?:\\/\\//i.test(h));
      const res = [];
      Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).forEach((n) => res.push(abs(n.getAttribute('href'))));
      Array.from(document.querySelectorAll('script[src]')).forEach((n) => res.push(abs(n.getAttribute('src'))));
      imgs.forEach((im) => { const s = im.getAttribute('src'); if (s) res.push(abs(s)); });
      Array.from(document.querySelectorAll('a[href$=".pdf"]')).forEach((n) => res.push(abs(n.getAttribute('href'))));
      const bodyText = (document.body && (document.body.innerText || document.body.textContent || '')) || '';
      const sdTypes = [];
      const sdErrors = [];
      // Required-property checks for common schema.org types (Rich Results essentials).
      const REQ = { Article: ['headline'], NewsArticle: ['headline'], BlogPosting: ['headline'], Product: ['name'], Recipe: ['name','image'], Event: ['name','startDate'], FAQPage: ['mainEntity'], Organization: ['name'], LocalBusiness: ['name'], BreadcrumbList: ['itemListElement'], VideoObject: ['name','thumbnailUrl'], JobPosting: ['title','datePosted'] };
      Array.from(document.querySelectorAll('script[type="application/ld+json"]')).forEach((s) => {
        var j;
        try { j = JSON.parse(s.textContent || 'null'); }
        catch (e) { sdErrors.push('malformed JSON-LD'); return; }
        const arr = Array.isArray(j) ? j : (j && Array.isArray(j['@graph']) ? j['@graph'] : [j]);
        arr.forEach((o) => {
          if (!o || typeof o !== 'object') return;
          const t = o['@type'] ? String(Array.isArray(o['@type']) ? o['@type'][0] : o['@type']) : '';
          if (!t) { sdErrors.push('JSON-LD object missing @type'); return; }
          sdTypes.push(t);
          const req = REQ[t];
          if (req) { const miss = req.filter((p) => o[p] === undefined || o[p] === null || o[p] === ''); if (miss.length) sdErrors.push(t + ' missing: ' + miss.join('/')); }
        });
      });
      if (document.querySelector('[itemscope][itemtype]')) sdTypes.push('Microdata');
      // MinHash-lite content signature for near-duplicate detection: hash 3-word shingles (djb2),
      // keep the 24 smallest. Jaccard overlap of signatures. Compact (24 ints) + order-stable.
      const words = bodyText.toLowerCase().replace(/[^\\p{L}\\p{N}\\s]/gu, ' ').split(/\\s+/).filter(Boolean);
      const seen = {}; const hashes = [];
      for (let i = 0; i + 2 < words.length; i++) {
        const sh = words[i] + ' ' + words[i+1] + ' ' + words[i+2];
        if (seen[sh]) continue; seen[sh] = 1;
        let h = 5381; for (let c = 0; c < sh.length; c++) h = ((h << 5) + h + sh.charCodeAt(c)) >>> 0;
        hashes.push(h);
      }
      const sig = Array.from(new Set(hashes)).sort((a, b) => a - b).slice(0, 24);
      return {
        contentSig: sig,
        structuredDataErrors: Array.from(new Set(sdErrors)).slice(0, 8),
        finalUrl: location.href,
        readyState: document.readyState,
        title: (document.title || '').trim(),
        metaDescription: meta('meta[name="description"]').trim(),
        metaKeywords: meta('meta[name="keywords"]').trim(),
        h1Count: h1s.length, h1: h1s[0] || '',
        h2Count: h2s.length, h2: h2s[0] || '',
        canonical,
        canonicalType: !canonical ? 'none' : (canonical.split('#')[0] === location.href.split('#')[0] ? 'self' : 'other'),
        robots: meta('meta[name="robots"]').trim(),
        hreflangCount: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
        hasPagination: !!document.querySelector('link[rel="next"], link[rel="prev"]'),
        structuredDataTypes: Array.from(new Set(sdTypes)).slice(0, 12),
        wordCount: bodyText.trim().split(/\\s+/).filter(Boolean).length,
        imagesTotal: imgs.length,
        imagesMissingAlt: imgs.filter((im) => !((im.getAttribute('alt') || '').trim())).length,
        links: Array.from(new Set(links)),
        resources: Array.from(new Set(res.filter((u) => /^https?:\\/\\//i.test(u)))),
      };
    })()`;

    // Wait for the page to actually settle (load complete + a short quiet window) so SPA/hydration
    // sites don't get read mid-render. Bounded so a never-complete page can't hang the crawl.
    const waitSettled = async () => {
      await waitForChrome('body', 9000).catch(() => {});
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        try {
          const rs = remoteValue(await evaluateInChrome(`document.readyState`));
          if (rs === 'complete') break;
        } catch { break; }
        await delay(200);
      }
      await delay(250);
    };

    try {
      while (queue.length && visited.size < cap && !seoStopRef.current) {
        const item = queue.shift()!;
        const target = item.url;
        if (visited.has(target)) continue;
        visited.add(target);
        setSeoProgress({ done: visited.size, total: cap, current: target });
        try {
          const navStartMs = Date.now() - 100;
          await loadUrl(target);
          await waitSettled();
          const raw = remoteValue(await evaluateInChrome(extractExpr)) || {};
          const finalUrl = String(raw.finalUrl || target);

          // Per-page response attribution: the freshest Document network record for THIS navigation
          // (started after navStart, matching final/target URL) - not a stale global match.
          const records = Array.from(networkRecordsRef.current.values())
            .filter((p) => p.startedAtMs >= navStartMs)
            .sort((a, b) => b.startedAtMs - a.startedAtMs);
          const documentRecord = records.find((p) => p.resourceType === 'Document' && (p.url === finalUrl || p.url === target))
            || records.find((p) => p.url === finalUrl || p.url === target)
            || records.find((p) => p.resourceType === 'Document')
            || null;
          // CDP 네트워크 캡처가 없을 때(macOS 네이티브 모드)는 HTTP 프로브로 문서
          // 응답 메타(status/content-type/size)를 대신 채운다.
          const probed = documentRecord ? null : await httpStatus(finalUrl);
          const status = documentRecord?.status ?? probed?.status;
          const statusText = String(documentRecord?.statusText || probed?.statusText || '');
          const contentType = documentRecord ? (headerValue(documentRecord.responseHeaders, 'content-type') || documentRecord.mimeType || '') : (probed?.contentType || '');
          const sizeBytes = documentRecord ? (documentRecord.encodedDataLength ?? documentRecord.transferSize) : probed?.size;
          const responseMs = documentRecord?.durationMs;
          const xRobotsTag = documentRecord ? headerValue(documentRecord.responseHeaders, 'x-robots-tag') : '';
          const urlType = seoResourceType(finalUrl, contentType);

          const pageKey = normKey(finalUrl);
          // Link graph + enqueue internal links at depth+1 (skip robots-disallowed URLs) +
          // record external links with their referrers for the external broken-link pass.
          const outSet = new Set<string>();
          let externalOutlinks = 0;
          for (const link of (raw.links as string[]) || []) {
            if (sameHost(link)) {
              const key = normKey(link);
              outSet.add(key);
              if (!queued.has(key) && !visited.has(key)) {
                if (!robotsAllows(robotsPath(key))) {
                  const bl = blockedLinks.get(key) || { depth: item.depth + 1, refs: new Set<string>() };
                  bl.refs.add(pageKey); blockedLinks.set(key, bl);
                } else if (queued.size < cap * 6) {
                  queued.add(key); queue.push({ url: key, depth: item.depth + 1 });
                }
              }
            } else {
              externalOutlinks += 1;
              const k = normKey(link);
              const e = externalRefs.get(k) || { depth: item.depth + 1, refs: new Set<string>() };
              e.refs.add(pageKey); externalRefs.set(k, e);
            }
          }
          outTargets.set(pageKey, outSet);
          if (Array.isArray(raw.contentSig) && raw.contentSig.length) contentSigs.set(pageKey, (raw.contentSig as number[]).map(Number));

          // Stash internal resource URLs (with referrers) for the status pass.
          for (const r of (raw.resources as string[]) || []) {
            if (sameHost(r)) {
              const k = normKey(r);
              const rr = resources.get(k) || { depth: item.depth, refs: new Set<string>() };
              rr.refs.add(pageKey); resources.set(k, rr);
            }
          }

          const robots = String(raw.robots || '');
          const noindex = /noindex/i.test(robots);
          const nofollow = /nofollow/i.test(robots);
          const title = String(raw.title || '');
          const metaDescription = String(raw.metaDescription || '');
          const h1Count = Number(raw.h1Count || 0);
          const h2Count = Number(raw.h2Count || 0);
          const canonical = String(raw.canonical || '');
          // Precise self/other canonical via URL normalization (trailing slash, query order,
          // percent-encoding, default port, host case) - not a raw string compare.
          const canonicalType: 'self' | 'other' | 'none' = !canonical
            ? 'none' : (seoCanonUrl(canonical) === seoCanonUrl(finalUrl) ? 'self' : 'other');
          const structuredDataTypes = Array.isArray(raw.structuredDataTypes) ? raw.structuredDataTypes.map(String) : [];
          const structuredDataErrors = Array.isArray(raw.structuredDataErrors) ? raw.structuredDataErrors.map(String) : [];
          const imagesMissingAlt = Number(raw.imagesMissingAlt || 0);
          const wordCount = Number(raw.wordCount || 0);
          const blockedByRobots = !robotsAllows(robotsPath(finalUrl));
          const indexabilityStatus = blockedByRobots
            ? 'Non-Indexable: Blocked by robots.txt'
            : seoIndexabilityStatus({ status, urlType, noindex, xRobots: xRobotsTag, canonicalType });

          const issues: SeoIssue[] = [];
          if (typeof status === 'number' && status >= 400) issues.push({ level: 'error', code: 'status', message: `HTTP ${status}` });
          else if (typeof status === 'number' && status >= 300) issues.push({ level: 'notice', code: 'redirect', message: `Redirect ${status}` });
          if (!title) issues.push({ level: 'error', code: 'title-missing', message: 'Missing <title>' });
          else if (title.length > 60) issues.push({ level: 'warning', code: 'title-long', message: `Title ${title.length} chars (>60)` });
          else if (title.length < 10) issues.push({ level: 'notice', code: 'title-short', message: `Title only ${title.length} chars` });
          if (title && h1Count > 0 && title.trim().toLowerCase() === String(raw.h1 || '').trim().toLowerCase()) issues.push({ level: 'notice', code: 'title-eq-h1', message: 'Title same as H1' });
          if (!metaDescription) issues.push({ level: 'warning', code: 'meta-missing', message: 'Missing meta description' });
          else if (metaDescription.length > 160) issues.push({ level: 'warning', code: 'meta-long', message: `Meta description ${metaDescription.length} chars (>160)` });
          else if (metaDescription.length < 70) issues.push({ level: 'notice', code: 'meta-short', message: `Meta description only ${metaDescription.length} chars` });
          if (h1Count === 0) issues.push({ level: 'warning', code: 'h1-missing', message: 'No H1' });
          else if (h1Count > 1) issues.push({ level: 'notice', code: 'h1-multiple', message: `${h1Count} H1 tags` });
          if (h2Count === 0) issues.push({ level: 'notice', code: 'h2-missing', message: 'No H2' });
          if (noindex) issues.push({ level: 'notice', code: 'noindex', message: 'meta robots noindex' });
          if (/noindex/i.test(xRobotsTag)) issues.push({ level: 'notice', code: 'x-robots-noindex', message: 'X-Robots-Tag noindex' });
          if (nofollow) issues.push({ level: 'notice', code: 'nofollow', message: 'meta robots nofollow' });
          if (canonicalType === 'none') issues.push({ level: 'notice', code: 'canonical-missing', message: 'No canonical' });
          else if (canonicalType === 'other') issues.push({ level: 'notice', code: 'canonical-other', message: 'Canonicalised to another URL' });
          if (imagesMissingAlt > 0) issues.push({ level: 'notice', code: 'img-alt', message: `${imagesMissingAlt} image(s) missing alt` });
          if (wordCount > 0 && wordCount < 200) issues.push({ level: 'notice', code: 'low-content', message: `Low content (${wordCount} words)` });
          if (blockedByRobots) issues.push({ level: 'warning', code: 'robots-blocked', message: 'Blocked by robots.txt' });
          // no-structured-data is noisy on every internal page; only flag the homepage (depth 0),
          // where missing structured data most affects rich results / AI citation. Site-wide
          // structured-data coverage is reported as a summary stat instead.
          if (!structuredDataTypes.length && item.depth === 0) issues.push({ level: 'notice', code: 'no-structured-data-home', message: 'Homepage has no structured data' });
          if (structuredDataErrors.length) issues.push({ level: 'warning', code: 'structured-data-invalid', message: `Structured data: ${structuredDataErrors.join('; ')}` });

          pages.push({
            url: target, finalUrl, urlType, depth: item.depth,
            status, statusText, contentType, sizeBytes, responseMs, indexabilityStatus,
            title, titleLength: title.length,
            metaDescription, metaDescriptionLength: metaDescription.length,
            h1Count, h1: String(raw.h1 || ''), h2Count,
            canonical, canonicalType, robots, xRobotsTag, noindex, nofollow,
            indexable: indexabilityStatus === 'Indexable',
            metaKeywords: String(raw.metaKeywords || ''),
            hreflangCount: Number(raw.hreflangCount || 0),
            hasPagination: !!raw.hasPagination,
            structuredDataTypes, structuredDataErrors, wordCount,
            outlinks: outSet.size, uniqueOutlinks: outSet.size, externalOutlinks,
            inlinks: 0, uniqueInlinks: 0,
            imagesTotal: Number(raw.imagesTotal || 0), imagesMissingAlt,
            issues,
          });
        } catch (err) {
          pages.push({
            url: target, finalUrl: target, urlType: 'HTML', depth: item.depth,
            status: undefined, statusText: '', contentType: '', indexabilityStatus: 'Non-Indexable: Crawl Error',
            title: '', titleLength: 0, metaDescription: '', metaDescriptionLength: 0,
            h1Count: 0, h1: '', h2Count: 0,
            canonical: '', canonicalType: 'none', robots: '', xRobotsTag: '', noindex: false, nofollow: false, indexable: false,
            metaKeywords: '', hreflangCount: 0, hasPagination: false, structuredDataTypes: [], structuredDataErrors: [],
            wordCount: 0, outlinks: 0, uniqueOutlinks: 0, externalOutlinks: 0, inlinks: 0, uniqueInlinks: 0,
            imagesTotal: 0, imagesMissingAlt: 0,
            issues: [{ level: 'error', code: 'crawl-failed', message: err instanceof Error ? err.message : String(err) }],
          });
        }
      }

      // Inlinks from the link graph: how many crawled pages link TO each URL.
      const inlinkSources = new Map<string, Set<string>>();
      for (const [src, targets] of outTargets) {
        for (const t of targets) {
          if (!inlinkSources.has(t)) inlinkSources.set(t, new Set());
          inlinkSources.get(t)!.add(src);
        }
      }
      for (const p of pages) {
        const sources = inlinkSources.get(normKey(p.finalUrl)) || inlinkSources.get(normKey(p.url));
        p.inlinks = sources ? sources.size : 0;
        p.uniqueInlinks = p.inlinks;
        if (p.urlType === 'HTML' && p.depth > 0 && p.inlinks === 0) p.issues.push({ level: 'warning', code: 'orphan', message: 'Orphan page (0 inlinks)' });
      }

      // Duplicate-title detection across crawled HTML pages.
      const titleGroups = new Map<string, number>();
      for (const p of pages) { if (p.urlType !== 'HTML') continue; const t = p.title.trim().toLowerCase(); if (t) titleGroups.set(t, (titleGroups.get(t) || 0) + 1); }
      for (const p of pages) {
        if (p.urlType !== 'HTML') continue;
        const t = p.title.trim().toLowerCase();
        if (t && (titleGroups.get(t) || 0) > 1) p.issues.push({ level: 'warning', code: 'title-duplicate', message: 'Duplicate title' });
      }

      // Near-duplicate content: estimate Jaccard from the MinHash-lite signatures (intersection
      // over union of the kept hash sets). Pairs >= 0.80 are flagged near-duplicate on both pages.
      const sigPages = pages.filter((p) => p.urlType === 'HTML' && contentSigs.get(normKey(p.finalUrl))?.length);
      const jaccard = (a: number[], b: number[]) => {
        const sb = new Set(b); let inter = 0;
        for (const x of a) if (sb.has(x)) inter += 1;
        const uni = a.length + b.length - inter;
        return uni > 0 ? inter / uni : 0;
      };
      for (let i = 0; i < sigPages.length; i++) {
        const sa = contentSigs.get(normKey(sigPages[i].finalUrl))!;
        for (let j = i + 1; j < sigPages.length; j++) {
          const sb = contentSigs.get(normKey(sigPages[j].finalUrl))!;
          if (jaccard(sa, sb) >= 0.80) {
            if (!sigPages[i].issues.some((x) => x.code === 'near-duplicate')) sigPages[i].issues.push({ level: 'warning', code: 'near-duplicate', message: `Near-duplicate of ${sigPages[j].finalUrl}` });
            if (!sigPages[j].issues.some((x) => x.code === 'near-duplicate')) sigPages[j].issues.push({ level: 'warning', code: 'near-duplicate', message: `Near-duplicate of ${sigPages[i].finalUrl}` });
          }
        }
      }

      // Phase 2: capped status pass over BOTH internal resources and external links.
      // httpStatus handles HEAD with GET fallback. Each row's
      // inlinks = how many crawled pages reference it (from the referrer sets), not a hardcoded 0.
      const RES_CAP = 80;
      const EXT_CAP = 60;
      const resourceList = Array.from(resources.entries()).filter(([u]) => !visited.has(u)).slice(0, RES_CAP);
      const externalList = Array.from(externalRefs.entries()).slice(0, EXT_CAP);
      const totalChecks = resourceList.length + externalList.length;
      let checked = 0;
      const statusRow = (url: string, info: { depth: number; refs: Set<string> }): SeoPageAudit => {
        return {
          url, finalUrl: url, urlType: 'Other', depth: info.depth,
          status: undefined, statusText: '', contentType: '', indexabilityStatus: '',
          title: '', titleLength: 0, metaDescription: '', metaDescriptionLength: 0,
          h1Count: 0, h1: '', h2Count: 0, canonical: '', canonicalType: 'none', robots: '', xRobotsTag: '',
          noindex: false, nofollow: false, indexable: false, metaKeywords: '', hreflangCount: 0,
          hasPagination: false, structuredDataTypes: [], structuredDataErrors: [], wordCount: 0,
          outlinks: 0, uniqueOutlinks: 0, externalOutlinks: 0, inlinks: info.refs.size, uniqueInlinks: info.refs.size,
          imagesTotal: 0, imagesMissingAlt: 0, issues: [],
        };
      };
      // Run the status checks with bounded CONCURRENCY (not serially) so 140 checks at a few
      // seconds each finish in ~tens of seconds, not 20 minutes. Stop is honoured between picks.
      const STATUS_CONCURRENCY = 8;
      const runStatus = async (entries: [string, { depth: number; refs: Set<string> }][], external: boolean) => {
        let idx = 0;
        const worker = async () => {
          while (idx < entries.length && !seoStopRef.current) {
            const [url, info] = entries[idx++];
            checked += 1;
            setSeoProgress({ done: visited.size + checked, total: visited.size + totalChecks, current: url });
            const r = await httpStatus(url);
            const st = r.status;
            const urlType = seoResourceType(url, r.contentType);
            const row = statusRow(url, info);
            row.urlType = external && urlType === 'HTML' ? 'Other' : urlType;
            row.status = st; row.statusText = r.statusText; row.contentType = r.contentType; row.sizeBytes = r.size;
            row.indexabilityStatus = external ? 'External' : seoIndexabilityStatus({ status: st, urlType: row.urlType, noindex: false, xRobots: '', canonicalType: 'none' });
            if (typeof st === 'number' && st >= 400) row.issues.push({ level: 'error', code: external ? 'broken-external' : 'broken-resource', message: `${external ? 'Broken external link' : 'Broken resource'} HTTP ${st}` });
            else if (typeof st === 'number' && st >= 300) row.issues.push({ level: 'notice', code: 'redirect', message: `Redirect ${st}` });
            else if (st === undefined) row.issues.push({ level: 'notice', code: 'no-response', message: 'No HTTP response' });
            pages.push(row);
          }
        };
        await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, entries.length) }, () => worker()));
      };
      await runStatus(resourceList, false);
      await runStatus(externalList, true);
      if (resources.size > RES_CAP || externalRefs.size > EXT_CAP) {
        // No silent caps - surface what was not status-checked.
        const note: string[] = [];
        if (resources.size > RES_CAP) note.push(`${resources.size - RES_CAP} resources`);
        if (externalRefs.size > EXT_CAP) note.push(`${externalRefs.size - EXT_CAP} external links`);
        pages.push({
          url: `(+${note.join(' + ')} not status-checked)`, finalUrl: '', urlType: 'Other', depth: 0,
          statusText: '', contentType: '', indexabilityStatus: '', title: '', titleLength: 0, metaDescription: '', metaDescriptionLength: 0,
          h1Count: 0, h1: '', h2Count: 0, canonical: '', canonicalType: 'none', robots: '', xRobotsTag: '',
          noindex: false, nofollow: false, indexable: false, metaKeywords: '', hreflangCount: 0, hasPagination: false,
          structuredDataTypes: [], structuredDataErrors: [], wordCount: 0, outlinks: 0, uniqueOutlinks: 0, externalOutlinks: 0, inlinks: 0, uniqueInlinks: 0,
          imagesTotal: 0, imagesMissingAlt: 0, issues: [{ level: 'notice', code: 'check-cap', message: `Status check capped (resources ${RES_CAP}, external ${EXT_CAP})` }],
        });
      }

      // Surface robots-blocked internal links as rows (not crawled, but visible/filterable).
      for (const [url, info] of Array.from(blockedLinks.entries()).filter(([u]) => !visited.has(u)).slice(0, 100)) {
        pages.push({
          ...statusRow(url, info),
          urlType: 'HTML',
          indexabilityStatus: 'Non-Indexable: Blocked by robots.txt',
          issues: [{ level: 'warning', code: 'robots-blocked', message: 'Blocked by robots.txt (not crawled)' }],
        });
      }

      // Phase 3 - sitemap DEEP validation: fetch sitemap(s), then compare the <loc> set against
      // the crawl - sitemap URLs that are non-indexable or canonicalised, and indexable crawled
      // pages MISSING from the sitemap. (Mere existence isn't useful on its own.)
      const sitemaps: SeoSitemapInfo[] = [];
      const sitemapUrls = robotsInfo.sitemaps.length ? robotsInfo.sitemaps.slice(0, 5) : [`${origin}/sitemap.xml`];
      const crawledByCanon = new Map<string, SeoPageAudit>();
      for (const p of pages) { if (p.urlType === 'HTML' && p.finalUrl) crawledByCanon.set(seoCanonUrl(p.finalUrl), p); }
      const fetchSitemap = async (sm: string) => {
        const res = await invoke<any>('http_request', { input: { method: 'GET', url: sm, timeout_ms: 9000 } });
        const st = Number(res?.status) || undefined;
        const body = typeof res?.body === 'string' ? res.body : '';
        const locMatches = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)] as RegExpMatchArray[];
        const locs = locMatches.map((m) => m[1]);
        const isIndex = /<sitemapindex/i.test(body);
        const ok = st === 200 && /<(urlset|sitemapindex)/i.test(body);
        return { st, locs, isIndex, ok };
      };
      const allSitemapLocs = new Set<string>(); // PAGE URLs only (sitemapindex children expanded)
      let sawIndex = false;
      for (const sm of sitemapUrls) {
        if (seoStopRef.current) break;
        try {
          const top = await fetchSitemap(sm);
          // A <sitemapindex>'s <loc>s are CHILD SITEMAPS, not pages - expand them (bounded) to get
          // real page URLs instead of mis-counting child-sitemap URLs as missing pages.
          let pageLocs: string[] = [];
          if (top.isIndex) {
            sawIndex = true;
            for (const child of top.locs.slice(0, 10)) {
              if (seoStopRef.current) break;
              try { const c = await fetchSitemap(child); pageLocs.push(...c.locs); } catch { /* skip child */ }
            }
          } else {
            pageLocs = top.locs;
          }
          let nonIndexableInSitemap = 0;
          let canonicalisedInSitemap = 0;
          for (const loc of pageLocs) {
            const key = seoCanonUrl(loc);
            allSitemapLocs.add(key);
            const page = crawledByCanon.get(key);
            if (page) {
              if (page.indexabilityStatus !== 'Indexable') nonIndexableInSitemap += 1;
              if (page.canonicalType === 'other') canonicalisedInSitemap += 1;
            }
          }
          sitemaps.push({ url: sm + (top.isIndex ? ' (index)' : ''), status: top.st, urlCount: pageLocs.length, ok: top.ok, nonIndexableInSitemap, canonicalisedInSitemap, missingFromSitemap: 0 });
        } catch {
          sitemaps.push({ url: sm, status: undefined, urlCount: 0, ok: false, nonIndexableInSitemap: 0, canonicalisedInSitemap: 0, missingFromSitemap: 0 });
        }
      }
      // Indexable crawled pages absent from every sitemap. Only meaningful when we actually have a
      // page-URL set (skip if an index gave us no expanded children, to avoid bogus "missing").
      if (allSitemapLocs.size > 0 && sitemaps.length && !(sawIndex && allSitemapLocs.size === 0)) {
        let missing = 0;
        for (const p of pages) {
          if (p.urlType === 'HTML' && p.indexabilityStatus === 'Indexable' && !allSitemapLocs.has(seoCanonUrl(p.finalUrl))) missing += 1;
        }
        sitemaps[0].missingFromSitemap = missing;
      }

      const brokenCount = pages.filter((p) => typeof p.status === 'number' && p.status >= 400).length;
      const summary = { error: 0, warning: 0, notice: 0 };
      for (const p of pages) for (const i of p.issues) summary[i.level] += 1;
      const report: SeoReport = {
        generatedAt: new Date().toISOString(),
        startUrl, host,
        pagesCrawled: pages.filter((p) => p.urlType === 'HTML').length,
        pages, robots: robotsInfo, sitemaps, brokenCount, summary,
      };
      setSeoReport(report);
      return report;
    } finally {
      setSeoRunning(false);
      setSeoProgress(null);
    }
  }, [currentUrl, ensureLiveSession, seoMaxPages, loadUrl, waitForChrome, remoteValue, evaluateInChrome, locale]);

  // Compact the crawl into a bounded JSON payload for the model: issue tallies + the worst pages.
  const seoBuildDataset = useCallback((report: SeoReport) => {
    const issueCounts: Record<string, number> = {};
    for (const p of report.pages) for (const i of p.issues) issueCounts[i.code] = (issueCounts[i.code] || 0) + 1;
    const html = report.pages.filter((p) => p.urlType === 'HTML');
    const worst = [...html].sort((a, b) => b.issues.length - a.issues.length).slice(0, 40).map((p) => ({
      url: p.finalUrl, type: p.urlType, status: p.status, indexability: p.indexabilityStatus, depth: p.depth,
      inlinks: p.inlinks, outlinks: p.outlinks, titleLen: p.titleLength, title: p.title.slice(0, 120),
      metaLen: p.metaDescriptionLength, h1: p.h1Count, h2: p.h2Count, words: p.wordCount,
      imgNoAlt: p.imagesMissingAlt, canonical: p.canonicalType, structured: p.structuredDataTypes,
      issues: p.issues.map((i) => i.code),
    }));
    const broken = report.pages.filter((p) => typeof p.status === 'number' && p.status >= 400)
      .slice(0, 30).map((p) => ({ url: p.finalUrl, type: p.urlType, status: p.status }));
    const htmlWithSd = html.filter((p) => p.structuredDataTypes.length > 0).length;
    return JSON.stringify({
      // The model sees a SAMPLE, not the full crawl - it must say so. sample.pages/broken are the
      // worst-N and broken-N actually included below.
      sample: { basis: 'worst-issue pages + broken URLs + summary stats (truncated)', pagesIncluded: worst.length, brokenIncluded: broken.length, htmlPagesTotal: html.length },
      host: report.host, startUrl: report.startUrl, pagesCrawled: report.pagesCrawled,
      summary: report.summary, brokenCount: report.brokenCount, issueCounts,
      robots: report.robots, sitemaps: report.sitemaps,
      structuredDataCoverage: { htmlWithStructuredData: htmlWithSd, htmlTotal: html.length },
      contentTypeCounts: report.pages.reduce((acc: Record<string, number>, p) => { acc[p.urlType] = (acc[p.urlType] || 0) + 1; return acc; }, {}),
      orphanPages: html.filter((p) => p.depth > 0 && p.inlinks === 0).length,
      pages: worst, broken,
    });
  }, []);

  const seoProjectRoot = (projectRoot || initialProjectRoot || '').replace(/[\\/]+$/, '');

  const seoLocalReport = useCallback(async (reportOverride?: SeoReport) => {
    const rep = reportOverride ?? seoReport;
    if (!rep) return;
    const docs = seoLocalReportFrom(rep, locale === 'ko');
    setSeoReportMarkdown(docs.report);
    setSeoFixPromptMarkdown(docs.fixPrompt);
    if (seoProjectRoot) {
      const safeHost = rep.host.replace(/[^a-z0-9.-]/gi, '_');
      await invoke('write_file', { path: seoProjectRoot + '/seo-report-' + safeHost + '.md', content: docs.report });
      await invoke('write_file', { path: seoProjectRoot + '/seo-fix-prompt-' + safeHost + '.md', content: docs.fixPrompt });
      setSeoReportStatus('Report and fix prompt saved.');
    } else {
      await navigator.clipboard.writeText(docs.report).catch(() => {});
      setSeoReportStatus('Report copied to clipboard.');
    }
  }, [seoReport, seoProjectRoot, locale]);

  const seoCopyReport = useCallback(async () => {
    const report = seoReportMarkdown.trim();
    if (!report) { setSeoReportStatus('Create the report first. No report is available yet.'); return; }
    await navigator.clipboard.writeText(report).then(() => setSeoReportStatus('Report copied.'), () => setSeoReportStatus('Clipboard copy failed.'));
  }, [seoReportMarkdown]);

  const seoCopyFixPrompt = useCallback(async () => {
    const prompt = seoFixPromptMarkdown.trim();
    if (!prompt) { setSeoReportStatus('Generate the report first. No fix prompt is available yet.'); return; }
    await navigator.clipboard.writeText(prompt).then(() => setSeoReportStatus('Fix prompt copied.'), () => setSeoReportStatus('Clipboard copy failed.'));
  }, [seoFixPromptMarkdown]);

  const seoSendFixPromptToAgent = useCallback(() => {
    const prompt = seoFixPromptMarkdown.trim();
    if (!prompt) { setSeoReportStatus('Generate the SEO report first. There is no fix prompt to send to Agent.'); return; }
    setDeepSeekInitialTask(prompt);
    setDeepSeekInitialTaskRequiresProject(true);
    setDeepSeekInitialTaskNonce((value) => value + 1);
    setShowDeepSeekAgent(true);
    setSeoReportStatus('Fix prompt loaded into Agent. Review it, then run.');
  }, [seoFixPromptMarkdown]);

  // "브라우저 옆에 테스트" — 에이전트가 이 빠릿브라우저로 직접 자체 점검을 수행하도록
  // 점검 프롬프트를 로드하고 에이전트 패널을 연다(빠릿에이전트=빠릿브라우저로 검증 구조).
  const runBrowserSelfTest = useCallback(() => {
    const prompt = [
      '빠릿브라우저 자체 점검을 실행해줘. 아래 각 단계를 이 브라우저(빠릿브라우저)로 직접 수행하고 단계별 성공/실패를 보고해:',
      '1) status 로 현재 탭·엔진 상태 확인',
      '2) https://example.com 으로 이동 후 페이지 제목과 본문 텍스트 확인',
      '3) 페이지 스크린샷 캡처',
      '4) 뒤로가기 후 원래 페이지로 복귀 확인',
      '실패한 단계가 있으면 원인과 함께 알려줘.',
    ].join('\n');
    setDeepSeekInitialTask(prompt);
    setDeepSeekInitialTaskRequiresProject(false);
    setDeepSeekInitialTaskNonce((value) => value + 1);
    setShowDeepSeekAgent(true);
  }, []);

  const seoAutoRunLocal = useCallback(async () => {
    if (seoRunning || seoReportBusy) return;
    const report = await runSeoCrawl();
    if (report) await seoLocalReport(report);
  }, [seoRunning, seoReportBusy, runSeoCrawl, seoLocalReport]);

  const seoSummary = seoReport?.summary || { error: 0, warning: 0, notice: 0 };
  const seoActiveFilter = SEO_FILTERS.find((f) => f.id === seoFilter) || SEO_FILTERS[0];
  const seoVisiblePages = seoReport ? seoReport.pages.filter(seoActiveFilter.test) : [];
  const canStartSeoReport = isTauri();
  const canDetectLocalTarget = isTauri();
  const canPickSeoProject = isTauri();
  const detectLocalTargetTitle = canDetectLocalTarget
    ? 'Find a running localhost app and set it as the SEO target'
    : 'Open this workspace in the BBARIT desktop app to scan local ports';
  const projectPickerTitle = canPickSeoProject
    ? (seoProjectRoot ? 'Change the project folder used for report files and Agent edits' : 'Choose the project folder used for report files and Agent edits')
    : 'Open this workspace in the BBARIT desktop app to choose a project folder';
  const seoCreateReportTitle = canStartSeoReport
    ? 'Crawl the target with the embedded browser and create the Agent fix prompt'
    : 'Open this workspace in the BBARIT desktop app to run SEO reports';
  const seoProjectState = seoProjectRoot ? projectRootLabel(seoProjectRoot) : 'Project required';
  const canSendFixPromptToAgent = !!seoFixPromptMarkdown.trim();
  const agentHandoffTitle = canSendFixPromptToAgent ? 'Load the fix prompt into SEO Agent' : 'Create a report first to generate an Agent fix prompt';

  const renderSeoSection = () => (
    <section className="browser-seo-panel">
      <div className="browser-seo-body">
        <div className="browser-seo-workflow">
          <div className="browser-seo-controls">
            <label className="browser-seo-cap" title="Max pages to crawl">
              <span>Max</span>
              <input type="number" min={1} max={500} value={seoMaxPages} disabled={seoRunning} onChange={(event) => setSeoMaxPages(Math.max(1, Math.min(500, Number(event.target.value) || 30)))} />
            </label>
            {seoRunning ? (
              <button type="button" onClick={() => { seoStopRef.current = true; }}>Stop</button>
            ) : seoReportBusy ? (
              <button type="button" className="browser-seo-primary" disabled>Working...</button>
            ) : (
              <>
                <button type="button" className="browser-seo-secondary" onClick={() => { void useDetectedLocalTarget(); }} disabled={detectingLocalTarget} data-unavailable={!canDetectLocalTarget ? 'true' : undefined} title={detectLocalTargetTitle}><Globe2 size={12} /> {detectingLocalTarget ? 'Scanning...' : 'Local app'}</button>
                <button type="button" className="browser-seo-primary" onClick={() => { void seoAutoRunLocal(); }} data-unavailable={!canStartSeoReport ? 'true' : undefined} title={seoCreateReportTitle}>Report</button>
              </>
            )}
          </div>
        </div>
        {seoProgress && (
          <div className="browser-seo-progress">
            <div className="browser-seo-progress-bar"><span style={{ width: Math.min(100, Math.round((seoProgress.done / Math.max(1, seoProgress.total)) * 100)) + '%' }} /></div>
            <small>{seoProgress.done}/{seoProgress.total} | {requestName(seoProgress.current)}</small>
          </div>
        )}
        {seoReportStatus && <div className="browser-seo-status">{seoReportStatus}</div>}
        {(seoReportMarkdown || seoFixPromptMarkdown) && (
          <div className="browser-seo-result-actions" aria-label="SEO result actions">
            <div>
              <strong>Result ready</strong>
              <span>{seoFixPromptMarkdown.trim() ? 'Report and Agent fix prompt are available.' : 'Report is available. Generate a fix prompt for Agent handoff.'}</span>
            </div>
            <button type="button" onClick={() => { void seoCopyReport(); }} disabled={!seoReportMarkdown.trim()}>Copy report</button>
            <button type="button" onClick={() => { void seoCopyFixPrompt(); }} disabled={!seoFixPromptMarkdown.trim()}>Copy fix prompt</button>
            <button type="button" className="primary" onClick={seoSendFixPromptToAgent} disabled={!canSendFixPromptToAgent} title={agentHandoffTitle}><Bot size={12} /> Agent</button>
          </div>
        )}
        {seoReportMarkdown && (
          <details className="browser-seo-reportbox" open>
            <summary><span>Report</span></summary>
            <pre>{seoReportMarkdown}</pre>
          </details>
        )}
        {seoFixPromptMarkdown && (
          <details className="browser-seo-reportbox browser-seo-fixbox" open>
            <summary><span>Fix prompt for Agent</span></summary>
            <pre>{seoFixPromptMarkdown}</pre>
          </details>
        )}
        {seoReport ? <div className="browser-seo-summary"><span className="error">{seoSummary.error} error</span><span className="warning">{seoSummary.warning} warn</span><span className="notice">{seoSummary.notice} notice</span></div> : null}
        {seoReport?.pages?.length ? (
          <div className="browser-seo-filterbar" role="tablist" aria-label="SEO filter tabs">
            {SEO_FILTERS.map((filter) => {
              const count = seoReport.pages.filter(filter.test).length;
              return <button key={filter.id} type="button" role="tab" aria-selected={seoFilter === filter.id} className={'browser-seo-filter ' + (seoFilter === filter.id ? 'active' : '')} onClick={() => setSeoFilter(filter.id)}>{filter.label} <em>{count}</em></button>;
            })}
          </div>
        ) : null}
        {seoReport?.pages?.length ? (
          <div className="browser-seo-table">
            <div className="browser-seo-tablescroll">
              <div className="browser-seo-row browser-seo-head"><span className="c-url">URL</span><span className="c-type">Type</span><span className="c-st">St</span><span className="c-idx">Indexability</span><span className="c-n">D</span><span className="c-n">In</span><span className="c-n">Out</span><span className="c-title">Title</span><span className="c-n">T</span><span className="c-n">M</span><span className="c-n">H1</span><span className="c-n">H2</span><span className="c-n">Words</span><span className="c-issues">Issues</span></div>
              {seoVisiblePages.map((page, index) => (
                <div key={page.url + '-' + index} className="browser-seo-row" title={page.finalUrl + '\n' + page.indexabilityStatus + (page.contentType ? ' | ' + page.contentType : '') + '\n' + page.title + '\n' + page.issues.map((issue) => '[' + issue.level + '] ' + issue.message).join('\n')}>
                  <span className="c-url">{requestName(page.finalUrl || page.url)}</span><span className={'c-type t-' + page.urlType.toLowerCase()}>{page.urlType}</span><span className={'c-st ' + (typeof page.status === 'number' && page.status >= 400 ? 'bad' : typeof page.status === 'number' && page.status >= 300 ? 'redir' : 'ok')}>{page.status ?? '-'}</span><span className={'c-idx ' + (page.indexabilityStatus && page.indexabilityStatus !== 'Indexable' ? 'noidx' : '')}>{page.indexabilityStatus.replace('Non-Indexable: ', 'No: ') || '-'}</span><span className="c-n">{page.urlType === 'HTML' ? page.depth : ''}</span><span className="c-n">{page.urlType === 'HTML' ? page.inlinks : ''}</span><span className="c-n">{page.urlType === 'HTML' ? page.outlinks : ''}</span><span className="c-title">{page.urlType === 'HTML' ? (page.title || <em>(no title)</em>) : ''}</span><span className={'c-n ' + (page.titleLength > 60 || (page.titleLength > 0 && page.titleLength < 10) ? 'warn' : '')}>{page.urlType === 'HTML' ? page.titleLength : ''}</span><span className={'c-n ' + (page.metaDescriptionLength === 0 || page.metaDescriptionLength > 160 ? 'warn' : '')}>{page.urlType === 'HTML' ? page.metaDescriptionLength : ''}</span><span className={'c-n ' + (page.h1Count !== 1 ? 'warn' : '')}>{page.urlType === 'HTML' ? page.h1Count : ''}</span><span className="c-n">{page.urlType === 'HTML' ? page.h2Count : ''}</span><span className="c-n">{page.urlType === 'HTML' ? page.wordCount : ''}</span><span className="c-issues">{page.issues.length ? page.issues.map((issue, itemIndex) => <em key={itemIndex} className={'browser-seo-chip ' + issue.level} title={issue.message}>{issue.code}</em>) : <em className="browser-seo-chip ok">ok</em>}</span>
                </div>
              ))}
            </div>
          </div>
        ) : <div className="browser-console-empty">{seoRunning ? 'Crawling...' : 'No SEO report yet. Create one from the workflow above.'}</div>}
      </div>
    </section>
  );

  const toggleAgent = () => {
    setShowDeepSeekAgent((visible) => !visible);
  };
  // 크롬 표준 단축키: Cmd/Ctrl+L 주소창, +R 새로고침, +D 즐겨찾기, +F 찾기,
  // +=/-/0 줌, Esc는 찾기 닫기/로딩 정지.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (meta && event.key.toLowerCase() === 'r') { event.preventDefault(); void loadUrl(currentUrl); return; }
      if (meta && event.key.toLowerCase() === 'd') { event.preventDefault(); if (/^https?:/i.test(currentUrl)) toggleBookmark(currentUrl, !currentBookmarked); return; }
      if (meta && event.key.toLowerCase() === 'f') { event.preventDefault(); setFindOpen(true); window.setTimeout(() => findInputRef.current?.focus(), 30); return; }
      if (meta && (event.key === '=' || event.key === '+')) { event.preventDefault(); void applyZoom(zoomPercent + 10); return; }
      if (meta && event.key === '-') { event.preventDefault(); void applyZoom(zoomPercent - 10); return; }
      if (meta && event.key === '0') { event.preventDefault(); void applyZoom(100); return; }
      if (event.key === 'Escape') {
        if (findOpen) { setFindOpen(false); return; }
        if (isLoading) { void stopLoading(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentUrl, currentBookmarked, toggleBookmark, loadUrl, applyZoom, zoomPercent, findOpen, isLoading, stopLoading]);

  const activeCefTab = cefTabs.find((t) => t.id === cefActiveId) || null;
  // Only large overlay panels need to hide the WebView surface (it sits on top of all
  // DOM elements). Small popovers (⋮ menu, find bar) sit above WebView via z-index.
  // 에디터는 WebView를 숨기지 않는다 — 하단 드로어로 붙고 WebView 는 위쪽으로 줄어든다
  // (브라우저 내용이 사라지지 않고 파일과 함께 보인다).
  const anyOverlayOpen = showSeoPanel || showNetworkPanel || showHistoryPanel || showOnboarding || showImport || asideModalOpen;
  // WebView NSView는 웹뷰 위에 떠 있으므로, DOM 오버레이가 열리면 잠시 숨긴다.
  useEffect(() => {
    if (!cefMode || cefActiveId == null) return;
    void invoke('cef_set_visible', { id: cefActiveId, visible: !anyOverlayOpen }).catch(() => {});
    if (!anyOverlayOpen) window.setTimeout(() => cefSyncBounds(), 30);
  }, [cefMode, cefActiveId, anyOverlayOpen, cefSyncBounds]);

  // WebView 모드 옴니박스 제출: URL/검색어는 WebView로, @질문은 기존 에이전트 경로로.
  const cefSubmit = useCallback((raw: string) => {
    const text = (raw || '').trim();
    if (!text) return;
    if (text.startsWith('@')) { submitAddress(text); return; }
    const looksUrl = /^(https?:\/\/|[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]|$))/i.test(text);
    const url = looksUrl ? (text.startsWith('http') ? text : 'https://' + text) : 'https://www.google.com/search?q=' + encodeURIComponent(text);
    if (cefActiveIdRef.current != null) {
      const activeId = cefActiveIdRef.current;
      updateCefTabLocation(activeId, url, 'push', true);
      void invoke('cef_navigate', { id: activeId, url });
    } else {
      void cefOpenTab(url);
    }
    setBrowserLocation(url);
  }, [submitAddress, cefOpenTab, setBrowserLocation, updateCefTabLocation]);

  // 크롬 새 탭처럼 자주 가는 사이트를 바로가기 타일로 — frecency 상위 8개.
  const startShortcuts = searchHistory(historyRef.current, '', Date.now(), { limit: 8 });
  // 크롬 즐겨찾기 바 — 북마크된 항목을 툴바 아래 칩으로 (frecency 순 상위 12개).
  const bookmarkBarItems = searchHistory(historyRef.current, '', Date.now(), { limit: 12, bookmarkedOnly: true });

  // 크롬 새 탭 스타일 시작 화면 — 실제 페이지(라이브 미러)가 없을 때 좌측에 표시.
  const renderStartPage = () => (
    <div className="browser-start-page">
      <div className="browser-start-logo">
        <img src="/icons/bbarit-logo.png" alt="BBARIT" draggable={false} />
      </div>
      <form className="browser-start-search" onSubmit={(event) => { event.preventDefault(); cefSubmit(address); }}>
        <Search size={17} />
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={locale === 'ko' ? 'URL을 입력하거나 검색 · @로 AI 질문' : 'Type a URL or search · @ to ask AI'}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>
      {startShortcuts.length > 0 && (
        <div className="browser-start-shortcuts">
          {startShortcuts.map((entry) => (
            <button key={entry.url} type="button" title={entry.url} onClick={() => { void loadUrl(entry.url); }}>
              <span className="browser-shortcut-icon">{(entry.title || requestName(entry.url)).trim().charAt(0).toUpperCase() || '•'}</span>
              <span className="browser-shortcut-label">{entry.title || requestName(entry.url)}</span>
            </button>
          ))}
        </div>
      )}
      {cefMode && (
        <button type="button" className="browser-start-launch" onClick={() => { void cefOpenTab(currentUrl || DEFAULT_BROWSER_URL); }} title="Open embedded Chromium">
          <Globe2 size={14} /> {locale === 'ko' ? '브라우저 열기' : 'Open Browser'}
        </button>
      )}
      {seoReportStatus && <div className="browser-start-status">{seoReportStatus}</div>}
    </div>
  );

  // ── 사이드바 패널: Notes & Clips (설계 §5.2 — 클리핑, 위키 전달은 에이전트 경유) ──
  const renderNotesPane = () => (
    <div className="aside-notes-pane">
      <button type="button" className="aside-clip-add" onClick={() => { void clipCurrentPage(); }} disabled={!/^https?:/i.test(currentUrl)} title="Save the current page (and selected text) as a clip">
        <Plus size={13} /> Clip current page
      </button>
      <div className="aside-pane-list">
        {webClips.length === 0 && <div className="aside-pane-empty">No clips yet. Select text on a page and clip it to keep the quote with the link.</div>}
        {webClips.map((clip) => (
          <div key={clip.id} className="aside-clip-row">
            <button type="button" className="aside-row-open" title={clip.url} onClick={() => { void loadUrl(clip.url); }}>
              <span className="aside-row-title">{clip.title}</span>
              <span className="aside-row-url">{clip.url}</span>
            </button>
            {clip.selection && <blockquote className="aside-clip-quote">{clip.selection.slice(0, 280)}</blockquote>}
            <div className="aside-clip-actions">
              <button type="button" title="Ask the agent to save this clip into the project wiki" onClick={() => runAsideTask(`Save this web clipping to the project wiki as a note:\nTitle: ${clip.title}\nURL: ${clip.url}${clip.selection ? `\nQuote: "${clip.selection.slice(0, 500)}"` : ''}`)}>To wiki</button>
              <button type="button" title="Copy as markdown" onClick={() => { void navigator.clipboard?.writeText(`[${clip.title}](${clip.url})${clip.selection ? `\n> ${clip.selection}` : ''}`).catch(() => {}); }}>Copy MD</button>
              <button type="button" title="Delete clip" onClick={() => deleteClip(clip.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── 사이드바 패널: History & Bookmarks (frecency 랭킹 재사용, 클릭 = 이동) ──
  const renderAsideHistoryPane = () => {
    const rows = searchHistory(historyRef.current, asideHistoryQuery, Date.now(), { limit: 60, bookmarkedOnly: asideHistoryTab === 'bookmarks' });
    return (
      <div className="aside-history-pane">
        <input className="aside-history-search" value={asideHistoryQuery} onChange={(e) => setAsideHistoryQuery(e.target.value)} placeholder="Search history" spellCheck={false} />
        <div className="aside-history-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={asideHistoryTab === 'all'} className={asideHistoryTab === 'all' ? 'active' : ''} onClick={() => setAsideHistoryTab('all')}>All</button>
          <button type="button" role="tab" aria-selected={asideHistoryTab === 'bookmarks'} className={asideHistoryTab === 'bookmarks' ? 'active' : ''} onClick={() => setAsideHistoryTab('bookmarks')}>Bookmarks</button>
        </div>
        <div className="aside-pane-list">
          {rows.length === 0 && <div className="aside-pane-empty">{asideHistoryTab === 'bookmarks' ? 'No bookmarks yet.' : 'No history yet.'}</div>}
          {rows.map((entry) => (
            <div key={entry.url} className="aside-history-row">
              <button type="button" className="aside-row-open" title={entry.url} onClick={() => { void loadUrl(entry.url); }}>
                <span className="aside-row-title">{entry.title || requestName(entry.url)}</span>
                <span className="aside-row-url">{entry.url}</span>
              </button>
              <button type="button" className={'aside-history-star' + (entry.bookmarked ? ' on' : '')} title={entry.bookmarked ? 'Remove bookmark' : 'Add bookmark'} onClick={() => toggleBookmark(entry.url, !entry.bookmarked)}>
                <Star size={12} fill={entry.bookmarked ? 'currentColor' : 'none'} />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── 사이드바 패널: Quick Access (Aside 퀵 액세스 문법 — 북마크 + 자주 가는 곳) ──
  const renderQuickAccessPane = () => {
    const bookmarks = searchHistory(historyRef.current, '', Date.now(), { limit: 24, bookmarkedOnly: true });
    const topSites = searchHistory(historyRef.current, '', Date.now(), { limit: 12 }).filter((e) => !e.bookmarked);
    const quickTile = (entry: HistoryEntry) => (
      <button key={entry.url} type="button" className="aside-quick-tile" title={entry.url} onClick={() => { void cefOpenTab(entry.url); }}>
        <span className="aside-quick-glyph">{(entry.title || requestName(entry.url)).trim().charAt(0).toUpperCase() || '•'}</span>
        <span className="aside-quick-label">{entry.title || requestName(entry.url)}</span>
      </button>
    );
    return (
      <div className="aside-quick-pane">
        <div className="aside-quick-section">Bookmarks</div>
        {bookmarks.length === 0
          ? <div className="aside-pane-empty">No bookmarks yet. Star a page in the address bar to pin it here.</div>
          : <div className="aside-quick-grid">{bookmarks.map(quickTile)}</div>}
        <div className="aside-quick-section">Frequently visited</div>
        {topSites.length === 0
          ? <div className="aside-pane-empty">No visits yet.</div>
          : <div className="aside-quick-grid">{topSites.map(quickTile)}</div>}
      </div>
    );
  };

  return (
    <div className={'browser-page mode-seo aside-mode ' + (cefMode ? 'webview-mode ' : '') + (embedded ? 'embedded ' : '') + (showEditor ? 'editor-open ' : '') + (findOpen ? 'find-open ' : '') + (recordSavedInfo ? 'record-saved ' : '') + (downloadsOpen ? 'downloads-open ' : '') + (showDeepSeekAgent ? 'agent-open' : '')}>
      {cefMode && cefTabs.length > 0 && (
        <div className="browser-tab-strip" role="tablist">
          {cefTabs.map((tab) => (
            <div key={tab.id} role="tab" aria-selected={tab.id === cefActiveId} className={'browser-tab ' + (tab.id === cefActiveId ? 'active' : '')} title={tab.url} onClick={() => cefSwitchTab(tab.id)}>
              {(() => {
                let host = '';
                try { host = new URL(tab.url).hostname; } catch { /* about:blank 등 */ }
                return host
                  ? <img className="browser-tab-favicon" style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0 }} src={`https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  : null;
              })()}
              <span className="browser-tab-title">{tab.title || requestName(tab.url) || (locale === 'ko' ? '새 탭' : 'New tab')}</span>
              <button type="button" className="browser-tab-close" title={locale === 'ko' ? '탭 닫기' : 'Close tab'} onClick={(event) => { event.stopPropagation(); cefCloseTab(tab.id); }}><X size={12} /></button>
            </div>
          ))}
          <button type="button" className="browser-tab-new" title={locale === 'ko' ? '새 탭' : 'New tab'} onClick={() => { void cefOpenTab(DEFAULT_BROWSER_URL); }}><Plus size={15} /></button>
        </div>
      )}
      <div className="browser-toolbar">
        <div className="browser-nav-row chrome-like">
          <img className="browser-toolbar-logo" src="/icons/bbarit-logo.png" alt="BBARIT" title="BBARIT Browser" draggable={false} />
          <button className="browser-icon-btn" type="button" title="Back" onClick={() => { void goCefHistory(-1); }} disabled={!activeCefTab?.canBack}><ArrowLeft size={16} /></button>
          <button className="browser-icon-btn" type="button" title="Forward" onClick={() => { void goCefHistory(1); }} disabled={!activeCefTab?.canFwd}><ArrowRight size={16} /></button>
          {activeCefTab?.loading ? (
            <button className="browser-icon-btn" type="button" title={locale === 'ko' ? '로딩 중지' : 'Stop loading'} onClick={() => { void stopLoading(); }}><X size={16} /></button>
          ) : (
            <button className="browser-icon-btn" type="button" title="Reload" onClick={() => { if (cefActiveId != null) void invoke('cef_nav_action', { id: cefActiveId, action: 'reload' }); }}><RefreshCw size={15} /></button>
          )}
          <button className="browser-icon-btn" type="button" title={locale === 'ko' ? '홈' : 'Home'} onClick={() => { void goHome(); }}><Home size={16} /></button>
          <form className="browser-address-form" onSubmit={(event) => { event.preventDefault(); cefSubmit(address); }}>
            <Search size={14} />
            <input
              ref={addressInputRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onCompositionStart={() => { addrComposingRef.current = true; }}
              onCompositionEnd={(event) => {
                addrComposingRef.current = false;
                if (addrEnterPendingRef.current) {
                  addrEnterPendingRef.current = false;
                  // Same omnibox routing as the form submit; read the committed
                  // IME text from the input because state can lag composition.
                  const committed = (event.target as HTMLInputElement).value;
                  cefSubmit(committed);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const ne = event.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
                if (addrComposingRef.current || ne.isComposing || ne.keyCode === 229) addrEnterPendingRef.current = true;
                else { event.preventDefault(); cefSubmit(address); }
              }}
              placeholder={locale === 'ko' ? 'URL · 검색어 · AI 질문 (@로 시작하면 에이전트)' : 'URL · search · ask AI (@ prefix for agent)'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {address && <button type="button" className="browser-address-clear" title="Clear" onClick={() => setAddress('')}><X size={13} /></button>}
            <button type="button" className={'browser-omni-star ' + (currentBookmarked ? 'active' : '')} title={locale === 'ko' ? (currentBookmarked ? '즐겨찾기 해제' : '즐겨찾기 추가') : (currentBookmarked ? 'Remove bookmark' : 'Bookmark this page')} onClick={() => toggleBookmark(currentUrl, !currentBookmarked)} disabled={!/^https?:/i.test(currentUrl)}><Star size={14} fill={currentBookmarked ? 'currentColor' : 'none'} /></button>
          </form>

          {/* 자주 쓰는 메뉴 항목을 ⋮ 안이 아니라 툴바 바깥 버튼으로 노출한다. */}
          <button className={'browser-icon-btn ' + (showSeoPanel ? 'active' : '')} type="button" title={locale === 'ko' ? 'SEO 워크벤치' : 'SEO Workbench'} onClick={() => setShowSeoPanel((v) => !v)}><FileSearch size={16} /></button>
          <button className={'browser-icon-btn ' + (showNetworkPanel ? 'active' : '')} type="button" title={locale === 'ko' ? '패킷 분석 (Network · Composer · AutoResponder · Breakpoints)' : 'Packet analysis (Network · Composer · AutoResponder · Breakpoints)'} onClick={() => setShowNetworkPanel((v) => !v)}><Activity size={16} /></button>
          <button className={'browser-icon-btn ' + (showHistoryPanel ? 'active' : '')} type="button" title={locale === 'ko' ? '히스토리 · 즐겨찾기' : 'History & bookmarks'} onClick={() => setShowHistoryPanel((v) => !v)}><Clock size={16} /></button>
          <button className={'browser-icon-btn ' + (showImport ? 'active' : '')} type="button" title={locale === 'ko' ? 'Chrome에서 가져오기 (비밀번호 · 북마크 · 기록 · 로그인)' : 'Import from Chrome (passwords · bookmarks · history · logins)'} onClick={() => setShowImport(true)}><Download size={16} /></button>
          <button className={'browser-icon-btn ' + (findOpen ? 'active' : '')} type="button" title={locale === 'ko' ? '페이지에서 찾기 (⌘F)' : 'Find in page (⌘F)'} onClick={() => { setFindOpen(true); window.setTimeout(() => findInputRef.current?.focus(), 30); }}><Search size={16} /></button>
          <button
            className={'browser-icon-btn browser-record-btn' + (recordingActive ? ' recording' : '')}
            type="button"
            title={recordingActive ? 'Stop recording (saves the video)' : 'Record the page as a video'}
            onClick={() => {
              if (recordingActive) {
                // recordSave surfaces the saved-file banner (path + Show in folder).
                recordSave()
                  .catch((error) => { setCefNotice(`Recording failed: ${String((error as Error)?.message || error)}`); window.setTimeout(() => setCefNotice(''), 8000); });
              } else {
                setRecordSavedInfo(null);
                recordStart()
                  .then(() => { setCefNotice('Recording… click the stop button to save.'); window.setTimeout(() => setCefNotice(''), 5000); })
                  .catch((error) => { setCefNotice(`Recording failed: ${String((error as Error)?.message || error)}`); window.setTimeout(() => setCefNotice(''), 8000); });
              }
            }}
          >{recordingActive ? <Square size={14} fill="currentColor" /> : <Circle size={14} fill="currentColor" />}</button>
          {cefMode && (
            <button className={'browser-icon-btn ' + (cefDevtoolsOpen ? 'active' : '')} type="button" title={locale === 'ko' ? '개발자 도구' : 'Developer tools'} onClick={cefToggleDevtools}><Code2 size={16} /></button>
          )}
          {/* 흩어져 있던 패널 토글을 한 그룹으로 모은다: 파일트리(좌)·에디터(하단)·
              에이전트(우)·브라우저 자체 테스트. */}
          <div className="browser-view-toggles" role="group" aria-label={locale === 'ko' ? '패널 토글' : 'Panel toggles'}>
            <button className={'browser-icon-btn browser-downloads-btn ' + (downloadsOpen ? 'active' : '')} type="button" title="Downloads" onClick={() => setDownloadsOpen((v) => !v)}>
              <Download size={16} />
              {downloads.some((d) => d.state === 'started' || d.state === 'inProgress') && (
                <span className="browser-downloads-badge">{downloads.filter((d) => d.state === 'started' || d.state === 'inProgress').length}</span>
              )}
            </button>
            <button className={'browser-icon-btn ' + (showFileTree ? 'active' : '')} type="button" title={projectRoot ? (locale === 'ko' ? '파일트리 (좌측)' : 'File tree (left)') + ' — ' + projectRootLabel(projectRoot) : (locale === 'ko' ? '프로젝트 폴더 선택' : 'Pick project folder')} onClick={() => { if (projectRoot) setShowFileTree((v) => !v); else void pickProjectRoot(); }} disabled={seoRunning}><PanelLeft size={16} /></button>
            <button className={'browser-icon-btn ' + (showEditor ? 'active' : '')} type="button" title={editorFile ? (locale === 'ko' ? '에디터 (하단)' : 'Editor (bottom)') : (locale === 'ko' ? '파일을 선택하면 에디터가 열립니다' : 'Open a file to view')} onClick={() => setShowEditor((v) => !v)} disabled={!editorFile}><PanelBottom size={16} /></button>
            <button className={'browser-icon-btn ' + (showDeepSeekAgent ? 'active' : '')} type="button" title={showDeepSeekAgent ? (locale === 'ko' ? '에이전트 숨기기 (우측)' : 'Hide Agent') : (locale === 'ko' ? '에이전트 (우측)' : 'Open Agent')} onClick={toggleAgent}><Bot size={16} /></button>
            <button className="browser-icon-btn browser-test-btn" type="button" title={locale === 'ko' ? '브라우저 자체 점검을 에이전트로 실행' : 'Run browser self-test via agent'} onClick={runBrowserSelfTest}><FlaskConical size={16} /></button>
          </div>
        </div>
      </div>

      {cefMode && cefNotice && (
        <div className="browser-start-status" role="status" style={{ padding: '4px 12px' }}>{cefNotice}</div>
      )}
      {cefMode && showFileTree && projectRoot && (
        <div className="browser-cef-sidebar">
          <div className="browser-cef-sidebar-head">
            <span className="browser-cef-sidebar-title" title={projectRoot}>{projectRootLabel(projectRoot)}</span>
            <button type="button" title={locale === 'ko' ? '폴더 변경' : 'Change folder'} onClick={() => void pickProjectRoot()}><FolderOpen size={13} /></button>
            <button type="button" title={locale === 'ko' ? '닫기' : 'Close'} onClick={() => setShowFileTree(false)}><X size={13} /></button>
          </div>
          <div className="browser-cef-sidebar-body">
            <CefFileNode entry={{ name: projectRootLabel(projectRoot), path: projectRoot, is_dir: true }} depth={0} defaultOpen onOpenFile={openFileInEditor} activePath={editorFile} />
          </div>
        </div>
      )}
      {cefMode && (
        <div ref={cefSurfaceRef} className={'browser-exact-surface browser-cef-surface' + (showFileTree && projectRoot ? ' with-filetree' : '')}>
          {cefTabs.length === 0 && (
            <div className="browser-headed-dashboard"><div className="browser-dash-content">{renderStartPage()}</div></div>
          )}
        </div>
      )}

      {/* Downloads shelf: fixed bar under the punch-out webview (the surface's
          bottom offset shrinks while it is open, so the native view never
          covers it). Auto-opens on any download. */}
      {downloadsOpen && (
        <div className="browser-downloads-shelf" role="region" aria-label="Downloads">
          <div className="browser-downloads-head">
            <Download size={13} />
            <strong>Downloads</strong>
            <span className="browser-downloads-count">{downloads.length}</span>
            <span className="browser-downloads-spacer" />
            {downloads.length > 0 && (
              <button type="button" className="browser-downloads-clear" onClick={clearDownloadRecords}>Clear all</button>
            )}
            <button type="button" className="browser-downloads-close" title="Close" onClick={() => setDownloadsOpen(false)}><X size={13} /></button>
          </div>
          <div className="browser-downloads-list">
            {downloads.length === 0 && <div className="browser-downloads-empty">No downloads yet — files you download will appear here.</div>}
            {downloads.map((d) => {
              const busy = d.state === 'started' || d.state === 'inProgress';
              const pct = d.totalBytes && d.receivedBytes ? Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100)) : null;
              const status = busy
                ? `Downloading…${pct != null ? ` ${pct}%` : ''}`
                : d.state === 'completed' ? 'Done'
                : d.state === 'failed' ? 'Failed'
                : 'Canceled';
              const name = d.suggestedFilename || d.filePath?.split('/').pop() || d.guid;
              return (
                <div key={d.guid} className={'browser-download-item ' + d.state}>
                  {busy ? <Loader2 size={14} className="browser-dl-spin" /> : <File size={14} />}
                  <button
                    type="button"
                    className="browser-download-name"
                    title={d.filePath || d.url}
                    disabled={!d.filePath || d.state !== 'completed'}
                    onClick={() => { if (d.filePath) void openPath(d.filePath).catch(() => {}); }}
                  >{name}</button>
                  <span className="browser-download-status">{status}</span>
                  {d.filePath && d.state === 'completed' && (
                    <button type="button" className="browser-download-action" title="Show in folder" onClick={() => { if (d.filePath) void revealItemInDir(d.filePath).catch(() => {}); }}><FolderOpen size={13} /></button>
                  )}
                  <button type="button" className="browser-download-action" title="Remove from list" onClick={() => removeDownloadRecord(d.guid)}><X size={13} /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {cefAvailable === false && (
        // WebView 미탑재 빌드: 예전에는 CDP 미러로 조용히 폴백했지만 이제 유일한
        // 엔진이 WebView이므로 명시적으로 안내한다. status()도 'unavailable'을 보고해
        // CLI가 즉시 실패할 수 있다.
        <div className="browser-exact-surface browser-cef-surface">
          <div className="browser-headed-dashboard">
            <div className="browser-dash-content">
              <div className="browser-cef-unavailable">
                <Globe2 size={22} />
                <strong>{'브라우저 엔진(WebView)을 사용할 수 없습니다'}</strong>
                <span>{'`npm run tauri:dev`로 실행하세요. (Windows는 아직 미지원)'}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOnboarding && (
        <div className="browser-onboarding-overlay" role="dialog" aria-modal="true" aria-label={locale === 'ko' ? 'AI 브라우저 소개' : 'AI browser intro'}>
          <div className="browser-onboarding-card">
            <div className="browser-onboarding-head">
              <strong>{locale === 'ko' ? '빠릿 AI 브라우저에 오신 것을 환영합니다' : 'Welcome to the BBARIT AI Browser'}</strong>
              <button type="button" onClick={dismissOnboarding} title={locale === 'ko' ? '닫기' : 'Close'}><X size={16} /></button>
            </div>
            <p className="browser-onboarding-lead">{locale === 'ko' ? '주소창에 URL·검색어·질문을 입력하세요. 질문은 AI 에이전트가 처리합니다. 할 수 있는 것:' : 'Type a URL, a search, or a question in the address bar — questions go to the AI agent. What it can do:'}</p>
            <div className="browser-onboarding-groups">
              {capabilitiesByGroup().map(({ group, items }) => (
                <div key={group} className="browser-onboarding-group">
                  <h4>{locale === 'ko' ? GROUP_LABEL[group].ko : GROUP_LABEL[group].en}</h4>
                  <ul>
                    {items.map((c) => (
                      <li key={c.id}><strong>{locale === 'ko' ? c.titleKo : c.title}</strong> — {locale === 'ko' ? c.summaryKo : c.summary}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="browser-onboarding-ctas">
              <button type="button" className="browser-onboarding-import" onClick={() => { dismissOnboarding(); setShowImport(true); }}>
                <Download size={14} /> {locale === 'ko' ? 'Chrome에서 가져오기' : 'Import from Chrome'}
              </button>
              <button type="button" ref={onboardingCtaRef} className="browser-onboarding-cta" onClick={dismissOnboarding}>{locale === 'ko' ? '시작하기 (Esc)' : 'Get started (Esc)'}</button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <ChromeImportModal
          locale={locale}
          onClose={() => setShowImport(false)}
          onImported={(payload, items, profile) => { void applyChromeImport(payload, items, profile); }}
        />
      )}

      {showEditor && (
        <div className={'browser-editor-panel' + (showFileTree && projectRoot ? ' with-filetree' : '')} role="dialog" aria-label={locale === 'ko' ? '파일 편집기' : 'File editor'}>
          <div className="browser-editor-head">
            <span className="browser-editor-path" title={editorFile || ''}>{editorFile ? editorFile.split('/').pop() : (locale === 'ko' ? '파일 없음' : 'No file')}{editorDirty ? ' •' : ''}</span>
            <div className="browser-editor-actions">
              <button type="button" disabled={!editorDirty || editorSaving} onClick={() => void saveEditorFile()}>{editorSaving ? (locale === 'ko' ? '저장 중…' : 'Saving…') : (locale === 'ko' ? '저장 (⌘S)' : 'Save (⌘S)')}</button>
              <button type="button" title={locale === 'ko' ? '닫기' : 'Close'} onClick={() => setShowEditor(false)}><X size={14} /></button>
            </div>
          </div>
          {editorError && <div className="browser-editor-error">{editorError}</div>}
          <textarea
            className="browser-editor-textarea"
            value={editorContent}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => { setEditorContent(event.target.value); setEditorDirty(true); }}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void saveEditorFile(); } }}
          />
        </div>
      )}
      {showHistoryPanel && (
        <div className="browser-history-panel" role="dialog" aria-label={locale === 'ko' ? '히스토리 및 즐겨찾기' : 'History and bookmarks'}>
          <div className="browser-history-head">
            <div className="browser-history-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={historyTab === 'all'} className={historyTab === 'all' ? 'active' : ''} onClick={() => setHistoryTab('all')}>{locale === 'ko' ? '히스토리' : 'History'}</button>
              <button type="button" role="tab" aria-selected={historyTab === 'bookmarks'} className={historyTab === 'bookmarks' ? 'active' : ''} onClick={() => setHistoryTab('bookmarks')}><Star size={12} /> {locale === 'ko' ? '즐겨찾기' : 'Bookmarks'}</button>
            </div>
            <button type="button" className="browser-history-close" onClick={() => setShowHistoryPanel(false)} title={locale === 'ko' ? '닫기' : 'Close'}><X size={14} /></button>
          </div>
          <input className="browser-history-search" placeholder={locale === 'ko' ? '검색…' : 'Search…'} value={historyQuery} onChange={(e) => setHistoryQuery(e.target.value)} spellCheck={false} data-history-tick={historyTick} />
          <div className="browser-history-list">
            {historyRows.length === 0 && <div className="browser-history-empty">{historyTab === 'bookmarks' ? (locale === 'ko' ? '즐겨찾기가 없습니다.' : 'No bookmarks yet.') : (locale === 'ko' ? '방문 기록이 없습니다.' : 'No history yet.')}</div>}
            {historyRows.map((entry) => (
              <div key={entry.url} className="browser-history-row">
                <button type="button" className="browser-history-open" onClick={() => { setShowHistoryPanel(false); void loadUrl(entry.url); }} title={entry.url}>
                  <span className={'browser-history-cat cat-' + entry.category}>{entry.category}</span>
                  <span className="browser-history-title">{entry.title && entry.title !== entry.url ? entry.title : requestName(entry.url)}</span>
                  <span className="browser-history-url">{requestName(entry.url)}</span>
                </button>
                <button type="button" className={'browser-history-star ' + (entry.bookmarked ? 'on' : '')} onClick={() => toggleBookmark(entry.url, !entry.bookmarked)} title={entry.bookmarked ? (locale === 'ko' ? '즐겨찾기 해제' : 'Remove bookmark') : (locale === 'ko' ? '즐겨찾기 추가' : 'Add bookmark')}><Star size={13} fill={entry.bookmarked ? 'currentColor' : 'none'} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {blockNotice && blockNoticeDismissed !== currentUrl && (
        <div className={'browser-block-banner ' + blockNotice.kind} role="alert">
          <span>
            <strong>{locale === 'ko' ? '접속 차단 감지' : 'Access wall detected'}: {blockNotice.kind}</strong>
            {' — '}{blockNotice.advice}
          </span>
          <button type="button" className="browser-restore-dismiss" onClick={() => setBlockNoticeDismissed(currentUrl)} title={locale === 'ko' ? '닫기' : 'Dismiss'}><X size={13} /></button>
        </div>
      )}

      {restorable && restorable.url !== currentUrl && !blockNotice && (
        <div className="browser-restore-banner" role="status">
          <span>{locale === 'ko' ? '지난 세션 복원' : 'Restore last session'}: <strong>{requestName(restorable.url)}</strong> <em>({sessionAgeLabel(restorable, Date.now())})</em></span>
          <button type="button" onClick={() => { const u = restorable.url; setRestorable(null); void loadUrl(u); }}>{locale === 'ko' ? '복원' : 'Restore'}</button>
          <button type="button" className="browser-restore-dismiss" onClick={() => setRestorable(null)} title={locale === 'ko' ? '닫기' : 'Dismiss'}><X size={13} /></button>
        </div>
      )}

      {recordSavedInfo && (
        <div className="browser-restore-banner browser-record-saved-banner" role="status">
          <span>Recording saved: <strong title={recordSavedInfo.path}>{recordSavedInfo.path}</strong> <em>({(recordSavedInfo.sizeBytes / (1024 * 1024)).toFixed(1)} MB · {Math.max(1, Math.round(recordSavedInfo.durationMs / 1000))}s)</em></span>
          <button type="button" onClick={() => { void invoke('reveal_in_explorer', { path: recordSavedInfo.path }); }}>Show in folder</button>
          <button type="button" className="browser-restore-dismiss" onClick={() => setRecordSavedInfo(null)} title="Dismiss"><X size={13} /></button>
        </div>
      )}

      {bookmarkBarItems.length > 0 && (
        <div className="browser-bookmark-bar" role="toolbar" aria-label={locale === 'ko' ? '즐겨찾기 바' : 'Bookmarks bar'}>
          {bookmarkBarItems.map((entry) => (
            <button key={entry.url} type="button" title={entry.url} onClick={() => { void loadUrl(entry.url); }}>
              <span className="browser-bookmark-dot">{(entry.title || requestName(entry.url)).trim().charAt(0).toUpperCase() || '•'}</span>
              <span>{entry.title || requestName(entry.url)}</span>
            </button>
          ))}
        </div>
      )}

      {findOpen && (
        <div className="browser-find-bar" role="search">
          <Search size={13} />
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => { setFindQuery(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); void findInPage(findQuery, event.shiftKey); }
              if (event.key === 'Escape') setFindOpen(false);
            }}
            placeholder={locale === 'ko' ? '페이지에서 찾기' : 'Find in page'}
            spellCheck={false}
          />
          <button type="button" title={locale === 'ko' ? '이전' : 'Previous'} onClick={() => { void findInPage(findQuery, true); }}><ChevronUp size={14} /></button>
          <button type="button" title={locale === 'ko' ? '다음' : 'Next'} onClick={() => { void findInPage(findQuery, false); }}><ChevronDown size={14} /></button>
          <button type="button" title={locale === 'ko' ? '닫기' : 'Close'} onClick={() => setFindOpen(false)}><X size={14} /></button>
        </div>
      )}

      {showSeoPanel && (
        <div className="browser-seo-overlay" role="dialog" aria-label="SEO Workbench">
          <div className="browser-seo-overlay-head">
            <strong><FileSearch size={14} /> SEO Workbench</strong>
            <button type="button" title={locale === 'ko' ? '닫기' : 'Close'} onClick={() => setShowSeoPanel(false)}><X size={15} /></button>
          </div>
          <div className="browser-seo-overlay-body">{renderSeoSection()}</div>
        </div>
      )}

      {showNetworkPanel && (
        <div className="browser-seo-overlay browser-network-overlay" role="dialog" aria-label={locale === 'ko' ? '패킷 분석' : 'Packet analysis'}>
          <div className="browser-seo-overlay-head">
            <strong><Activity size={14} /> {locale === 'ko' ? '패킷 분석' : 'Packet Analysis'}</strong>
            <button type="button" title={locale === 'ko' ? '닫기' : 'Close'} onClick={() => setShowNetworkPanel(false)}><X size={15} /></button>
          </div>
          <div className="browser-seo-overlay-body browser-network-overlay-body">
            <BrowserNetworkPanel locale={locale} />
          </div>
        </div>
      )}

      {/* 사이드바(rail+패널): 구 에이전트 독을 흡수. rail은 항상, 패널은 열림 시.
          설계 docs/BROWSER-ASIDE-DESIGN-2026-07-06.md — D13(오버레이 금지)/D14(bounds
          자동 전파)/D15(AgentChatPanel 재사용+promptPrefix 접합). */}
      <BrowserAside
        open={showDeepSeekAgent}
        pane={asidePane}
        width={asideWidth}
        onToggle={setShowDeepSeekAgent}
        onPaneChange={setAsidePane}
        onWidthChange={setAsideWidth}
        onDragStart={asideDragStart}
        onDragEnd={asideDragEnd}
        titles={{ agent: '🤖 BBARIT', skills: 'Skills & Plugins', logins: 'Site Logins', tools: 'Page Tools', notes: 'Notes & Clips', history: 'History & Bookmarks', webpanel: 'Quick Access' }}
        panes={{
          agent: (
            <AsideAgentPane
              workDir={projectRoot || initialProjectRoot || ''}
              browserWindowLabel={getCurrentWindow().label}
              pageUrl={currentUrl || null}
              pageTitle={cefTabs.find((t) => t.id === cefActiveId)?.title || null}
              tabs={cefTabs.map((t) => ({ id: t.id, title: t.title, url: t.url }))}
              activeTabId={cefActiveId}
              memoryProvider={asideMemoryLines}
              recentTasks={asideRecentTasks}
              onRunTask={runAsideTask}
              pendingTask={pendingAgentTask}
              onConfirmTask={() => {
                if (pendingAgentTask) {
                  recordAsideAudit('task', pendingAgentTask);
                  injectAgentTask(pendingAgentTask);
                }
                setPendingAgentTask(null);
              }}
              onCancelTask={() => {
                if (pendingAgentTask) recordAsideAudit('cancel', pendingAgentTask);
                setPendingAgentTask(null);
              }}
              auditLog={asideAudit}
              onToolEvent={(name, preview) => recordAsideAudit('tool', `${name}: ${preview}`)}
              onModalOpenChange={setAsideModalOpen}
              initialPrompt={agentBrowserPrompt}
              initialPromptNonce={deepSeekInitialTaskNonce}
            />
          ),
          skills: <AsideSkillsPane onRunSkill={runAsideSkill} />,
          logins: (
            <AsideLoginsPane
              logins={siteLogins}
              currentHost={(() => { try { return currentUrl ? new URL(currentUrl).hostname : null; } catch { return null; } })()}
              pageAvailable={!!/^https?:/i.test(currentUrl)}
              onSave={(login) => {
                const next = siteLogins.some((l) => l.id === login.id)
                  ? siteLogins.map((l) => (l.id === login.id ? login : l))
                  : [...siteLogins, login];
                persistLogins(next);
                recordAsideAudit('login-save', `${login.site} (${login.username})`);
              }}
              onDelete={(id) => { persistLogins(siteLogins.filter((l) => l.id !== id)); }}
              onAutofill={(login) => { void autofillLogin(login); }}
              onAgentLogin={agentLogin}
            />
          ),
          tools: <div className="aside-tools-pane">{renderSeoSection()}</div>,
          notes: renderNotesPane(),
          history: renderAsideHistoryPane(),
          webpanel: renderQuickAccessPane(),
        }}
      />

      {(isLoading || error) && (
        <div className="browser-status-layer">
          {isLoading && <div className="browser-status-pill"><Loader2 size={15} className="browser-spin" /><span>Rendering with BBARIT Browser</span></div>}
          {error && <div className="browser-error"><strong>Browser error</strong><span>{error}</span></div>}
        </div>
      )}
    </div>
  );
}
