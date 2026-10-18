// Reverse-engineering of the current page for the browser agent.
//
// One tool call gives the agent everything needed to write a "rebuild this site"
// spec: tech stack, design tokens (colors/fonts), layout outline, and the API
// surface observed in the network log. Collection runs in-page (read-only) and
// the shaping/dedup logic lives here as pure, tested functions.
//
// D1: API endpoints come from the ALREADY-CAPTURED network log, not new probing.
//     Reason: passive observation cannot break or spam the target site.
//     Cost: endpoints only appear after the user has interacted with the page.

// In-page collector. Read-only: computed styles and DOM reads only, no mutation.
export const REVERSE_SNAPSHOT_SCRIPT = `(() => {
  const t=(s)=>(s||'').replace(/\\s+/g,' ').trim();
  const fw=[]; if(window.React||document.querySelector('[data-reactroot],#root'))fw.push('React'); if(window.__NEXT_DATA__)fw.push('Next.js'); if(window.Vue||document.querySelector('[data-v-app],#app'))fw.push('Vue'); if(document.querySelector('[ng-version]'))fw.push('Angular'); if(window.Shopify)fw.push('Shopify'); if(window.wp||document.querySelector('link[href*="wp-content"]'))fw.push('WordPress'); if(window.jQuery)fw.push('jQuery');
  const gen=(document.querySelector('meta[name=generator]')||{}).content||'';
  const colorOf=(el,prop)=>{ if(!el)return ''; const v=getComputedStyle(el)[prop]; return (v&&v!=='rgba(0, 0, 0, 0)')?v:''; };
  const pick=(sel)=>document.querySelector(sel);
  const colors={}; const fonts={};
  [['body','body'],['header','header,[role=banner]'],['nav','nav'],['main','main,[role=main]'],['footer','footer'],['button','button,.btn,[role=button]'],['link','a']].forEach(([k,sel])=>{
    const el=pick(sel); if(!el)return;
    const bg=colorOf(el,'backgroundColor'), fg=colorOf(el,'color');
    if(bg||fg) colors[k]={bg,fg};
    const f=getComputedStyle(el).fontFamily; if(f) fonts[k]=t(f).slice(0,80);
  });
  const outline=[];
  document.querySelectorAll('header,nav,main,section,article,aside,footer,h1,h2').forEach(el=>{
    if(outline.length>=40)return;
    const tag=el.tagName.toLowerCase();
    if(tag==='h1'||tag==='h2'){ outline.push('  '+tag+': '+t(el.innerText).slice(0,70)); }
    else { const r=el.getBoundingClientRect(); if(r.width>0&&r.height>0) outline.push(tag+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.split(/\\s+/).slice(0,2).join('.'):'')); }
  });
  const scripts=[...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')).filter(Boolean).slice(0,20);
  return JSON.stringify({ url:location.href, title:document.title, generator:gen, frameworks:fw, colors, fonts, outline, scripts,
    counts:{ links:document.querySelectorAll('a').length, images:document.querySelectorAll('img').length, forms:document.querySelectorAll('form').length, iframes:document.querySelectorAll('iframe').length } });
})()`;

export interface ReverseNetEntry { method?: string; url?: string; status?: number; type?: string; mime?: string }
export interface ApiEndpoint { method: string; path: string; origin: string; count: number; statuses: number[] }

// Requests that represent an API surface (not assets): fetch/xhr or JSON responses.
function isApiLike(entry: ReverseNetEntry): boolean {
  const type = String(entry.type || '').toLowerCase();
  if (type === 'fetch' || type === 'xhr') return true;
  return /json|graphql/i.test(String(entry.mime || ''));
}

// Normalize /users/123/orders/456 -> /users/:id/orders/:id so endpoints dedupe.
export function normalizeApiPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) ? ':id' : seg))
    .join('/') || '/';
}

export function dedupeEndpoints(network: ReverseNetEntry[], limit = 40): ApiEndpoint[] {
  const map = new Map<string, ApiEndpoint>();
  for (const entry of network || []) {
    if (!entry || !isApiLike(entry)) continue;
    let parsed: URL;
    try { parsed = new URL(String(entry.url || '')); } catch { continue; }
    const method = String(entry.method || 'GET').toUpperCase();
    const path = normalizeApiPath(parsed.pathname);
    const key = `${method} ${parsed.origin}${path}`;
    const found = map.get(key);
    const status = Number(entry.status || 0);
    if (found) {
      found.count++;
      if (status && !found.statuses.includes(status)) found.statuses.push(status);
    } else if (map.size < limit) {
      map.set(key, { method, path, origin: parsed.origin, count: 1, statuses: status ? [status] : [] });
    }
  }
  return [...map.values()];
}

export interface ReverseSnapshot {
  url?: string; title?: string; generator?: string;
  frameworks?: string[]; colors?: Record<string, { bg?: string; fg?: string }>;
  fonts?: Record<string, string>; outline?: string[]; scripts?: string[];
  counts?: Record<string, number>;
}

// Render the collected data as compact markdown — this is the tool output the
// agent reads, so it must be dense and structured, not raw JSON noise.
export function formatReverseReport(snapshot: ReverseSnapshot, endpoints: ApiEndpoint[]): string {
  const s = snapshot || {};
  const lines: string[] = [];
  lines.push(`# Reverse-engineering: ${s.title || '(untitled)'}`);
  lines.push(`URL: ${s.url || '(unknown)'}`);
  const stack = [...(s.frameworks || [])];
  if (s.generator) stack.push(`generator: ${s.generator}`);
  lines.push(`## Tech stack`, stack.length ? stack.join(', ') : '(no framework fingerprints detected)');
  const colorEntries = Object.entries(s.colors || {});
  const fontEntries = Object.entries(s.fonts || {});
  lines.push('## Design tokens');
  for (const [k, v] of colorEntries) lines.push(`- ${k}: bg=${v?.bg || '-'} fg=${v?.fg || '-'}`);
  for (const [k, v] of fontEntries.slice(0, 4)) lines.push(`- font(${k}): ${v}`);
  if (!colorEntries.length && !fontEntries.length) lines.push('(no styles sampled)');
  lines.push('## Layout outline');
  lines.push(...(s.outline?.length ? s.outline : ['(no landmarks found)']));
  lines.push('## API endpoints (observed)');
  if (endpoints.length) {
    for (const e of endpoints) lines.push(`- ${e.method} ${e.origin}${e.path} ×${e.count}${e.statuses.length ? ` [${e.statuses.join(',')}]` : ''}`);
  } else {
    lines.push('(none captured yet — interact with the page to record its API calls)');
  }
  if (s.scripts?.length) lines.push('## External scripts', ...s.scripts.map((x) => `- ${x}`));
  if (s.counts) lines.push('## Element counts', Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' '));
  return lines.join('\n');
}
