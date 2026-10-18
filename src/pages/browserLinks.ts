// Link intelligence: classify a page's links so the agent can understand site
// structure and find navigation targets ("the pricing page", "the docs link").
//
// Collection (href + anchor text) is a thin in-page read; this module resolves
// relative URLs against the page, classifies each link, de-dupes, and can find the
// best link for a described destination. Pure so classification/ranking is tested.
//
// D1: Classify by URL shape + anchor text, resolved against the CURRENT origin, so
//     "same-site" is reliable even for relative/protocol-relative hrefs.

export interface RawLink { href?: string; text?: string }
export type LinkKind = 'internal' | 'external' | 'anchor' | 'download' | 'social' | 'mail' | 'other';

export interface ClassifiedLink {
  href: string;      // absolute
  text: string;
  kind: LinkKind;
  host: string;
}

const SOCIAL_RE = /(facebook|twitter|x\.com|instagram|linkedin|youtube|tiktok|reddit|threads|pinterest|github)\.com/i;
const DOWNLOAD_RE = /\.(pdf|zip|dmg|exe|csv|xlsx?|docx?|pptx?|tar|gz|apk|mp4|mp3)(\?|#|$)/i;

function resolve(href: string, base: string): string | null {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('javascript:') || raw === '#') return null;
  try { return new URL(raw, base || 'https://example.com').href; } catch { return null; }
}

export function classifyLink(href: string, text: string, pageUrl: string): ClassifiedLink | null {
  const abs = resolve(href, pageUrl);
  if (!abs) return null;
  let url: URL; let pageHost = '';
  try { url = new URL(abs); } catch { return null; }
  try { pageHost = new URL(pageUrl).host; } catch { /* no page host */ }
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);

  let kind: LinkKind;
  if (url.protocol === 'mailto:') kind = 'mail';
  else if (DOWNLOAD_RE.test(url.pathname)) kind = 'download';
  else if (SOCIAL_RE.test(url.host)) kind = 'social';
  else if (pageHost && url.host === pageHost) {
    // Same host: a pure fragment (same path + hash) is an in-page anchor.
    let samePath = false;
    try { const p = new URL(pageUrl); samePath = p.pathname === url.pathname && !!url.hash; } catch { /* ignore */ }
    kind = samePath ? 'anchor' : 'internal';
  } else if (/^https?:$/.test(url.protocol)) kind = 'external';
  else kind = 'other';

  return { href: abs, text: t, kind, host: url.host };
}

export interface LinkMap {
  links: ClassifiedLink[];
  counts: Record<LinkKind, number>;
}

export function buildLinkMap(rawLinks: RawLink[], pageUrl: string): LinkMap {
  const seen = new Set<string>();
  const links: ClassifiedLink[] = [];
  const counts = { internal: 0, external: 0, anchor: 0, download: 0, social: 0, mail: 0, other: 0 } as Record<LinkKind, number>;
  for (const raw of rawLinks || []) {
    const c = classifyLink(String(raw?.href || ''), String(raw?.text || ''), pageUrl);
    if (!c) continue;
    const key = `${c.href}\n${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(c);
    counts[c.kind]++;
  }
  return { links, counts };
}

// Find the link that best matches a described destination ("pricing", "docs").
export function findLink(map: LinkMap, description: string): ClassifiedLink | null {
  const q = String(description || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!q.length) return null;
  let best: ClassifiedLink | null = null;
  let bestScore = 0;
  for (const link of map.links) {
    const hay = `${link.text} ${link.href}`.toLowerCase();
    let score = 0;
    for (const t of q) if (hay.includes(t)) score += hay.split(/\s+/).includes(t) ? 3 : 1;
    if (score > bestScore) { bestScore = score; best = link; }
  }
  return bestScore > 0 ? best : null;
}

export function formatLinkMap(map: LinkMap, opts: { limit?: number } = {}): string {
  const limit = Math.max(1, opts.limit ?? 30);
  const lines = [`# Links — ${map.links.length} unique`, Object.entries(map.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' · ')];
  for (const l of map.links.slice(0, limit)) lines.push(`- [${l.kind}] ${l.text || '(no text)'} → ${l.href}`);
  if (map.links.length > limit) lines.push(`  … +${map.links.length - limit} more`);
  return lines.join('\n');
}
