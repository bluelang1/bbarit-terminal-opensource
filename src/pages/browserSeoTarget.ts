export const DEFAULT_BROWSER_URL = 'https://www.naver.com';

export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return DEFAULT_BROWSER_URL;
  if (/^(https?:|file:|data:|about:)/i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(raw)) return `http://${raw}`;
  if (raw.includes('.') && !raw.includes(' ')) return `https://${raw}`;
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

export function normalizeSeoTarget(input: string): { url?: string; error?: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Enter a URL or domain to crawl.' };
  if (/\s/.test(raw)) return { error: 'SEO target must be a URL or domain, not a search query.' };
  if (!/^(https?:\/\/|localhost(?::\d+)?(?:\/.*)?$|127\.0\.0\.1(?::\d+)?(?:\/.*)?$|\[::1\](?::\d+)?(?:\/.*)?$|[^/?#]+\.[^/?#]+(?:[/?#].*)?$)/i.test(raw)) {
    return { error: 'Enter a crawlable URL, domain, or localhost address.' };
  }
  const url = normalizeUrl(raw);
  if (!/^https?:\/\//i.test(url)) return { error: 'SEO target must start with http:// or https://.' };
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return { error: 'Enter a valid SEO target URL.' };
    return { url: parsed.href };
  } catch {
    return { error: 'Enter a valid SEO target URL.' };
  }
}

export function requestName(url: string): string {
  try {
    const parsed = new URL(url);
    const host = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname) ? parsed.host : parsed.hostname;
    return `${host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url || '(unknown)';
  }
}
