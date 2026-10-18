// Block / anti-bot challenge detector for BBARIT Browser.
//
// The browser already runs real headed Chrome with a persistent profile and a stealth
// layer (UA/webdriver/plugin/WebGL masking) so most bot-managers are bypassed. But
// when a site DOES block — Cloudflare "checking your browser", a captcha, HTTP 403,
// a geo/region wall, or a rate limit — nothing recognized it, so the agent kept
// "analyzing" an interstitial. This module classifies the block from page signals
// (title, visible text, status codes) and suggests the concrete next move.
//
// D1: Detection is READ-ONLY signal analysis, not an evasion technique.
//     Reason: the goal is to TELL the user/agent a wall was hit and how to get past
//     it legitimately (wait out the JS challenge, solve the captcha in the visible
//     Chrome, sign in, retry), not to defeat protections silently. Cost: no auto-
//     bypass. Escape hatch: the real visible Chrome lets the user act directly.

export type BlockKind =
  | 'none'
  | 'cloudflare'
  | 'captcha'
  | 'forbidden'
  | 'ratelimit'
  | 'geo'
  | 'login'
  | 'unavailable';

export interface BlockSignal {
  url?: string;
  title?: string;
  text?: string;            // visible page text (first ~4KB)
  statuses?: number[];      // recent main-document HTTP statuses
  hasPasswordField?: boolean; // a visible password input is present (login form)
  hasCaptchaWidget?: boolean; // a reCAPTCHA/hCaptcha/Turnstile widget is present
}

export interface BlockVerdict {
  blocked: boolean;
  kind: BlockKind;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  advice: string;
}

const NOT_BLOCKED: BlockVerdict = { blocked: false, kind: 'none', confidence: 'high', reason: 'no block signals', advice: '' };

// Ordered rules: first strong match wins. Each rule tests title+text (lowercased).
const RULES: Array<{ kind: BlockKind; re: RegExp; reason: string; advice: string }> = [
  { kind: 'cloudflare', re: /(checking your browser|cloudflare|cf-challenge|just a moment|attention required|ray id|ддos protection|enable javascript and cookies)/i,
    reason: 'Cloudflare / JS interstitial', advice: 'Wait a few seconds for the JS challenge to clear; if it persists, solve it in the visible BBARIT Browser window, then retry.' },
  { kind: 'captcha', re: /(recaptcha|hcaptcha|are you a robot|i'?m not a robot|verify you are human|complete the captcha|press and hold|slide to verify|人机验证|自动程序|보안\s*확인|실제\s*사용자|로봇이\s*아닙니다|사람인지\s*확인|자동\s*입력\s*방지|캡차)/i,
    reason: 'CAPTCHA / human-verification challenge', advice: 'Solve the captcha directly in the visible Chrome window, then re-run the task on the same page. The persistent profile keeps you verified for next time.' },
  { kind: 'ratelimit', re: /(rate limit|too many requests|429|slow down|unusual traffic|자동화된 요청|请求过于频繁)/i,
    reason: 'Rate limited / too many requests', advice: 'Stop rapid navigation; wait before retrying and avoid batch-visiting this host.' },
  { kind: 'geo', re: /(not available in your (country|region)|geo-?blocked|access from your location|이 지역에서|region is not supported|content is unavailable in your)/i,
    reason: 'Geo / region restriction', advice: 'The site blocks this region; a different network/VPN outside the app would be needed.' },
  { kind: 'login', re: /(sign in to continue|please log in|login required|members only|create an account to|log in or sign up to view|로그인이 필요)/i,
    reason: 'Login / paywall required', advice: 'Sign in to the site in the visible Chrome window; the persistent profile keeps the session for next time.' },
  { kind: 'forbidden', re: /(403 forbidden|access denied|you don'?t have permission|not authorized|forbidden)/i,
    reason: 'HTTP 403 / access denied', advice: 'The server refused access; verify the URL and that you are permitted to view it.' },
  { kind: 'unavailable', re: /(service unavailable|503|temporarily unavailable|maintenance)/i,
    reason: 'Service unavailable / maintenance', advice: 'The site is temporarily down; retry later.' },
];

function statusKind(statuses: number[]): { kind: BlockKind; reason: string; advice: string } | null {
  const s = statuses[statuses.length - 1];
  if (s === 403) return { kind: 'forbidden', reason: 'HTTP 403 on the main document', advice: 'Access was refused; confirm the URL and your permission to view it.' };
  if (s === 429) return { kind: 'ratelimit', reason: 'HTTP 429 rate limit', advice: 'Wait before retrying; do not batch-hit this host.' };
  if (s === 503) return { kind: 'unavailable', reason: 'HTTP 503 service unavailable', advice: 'The site is down or shielding; retry later.' };
  if (s === 451) return { kind: 'geo', reason: 'HTTP 451 (legal/region block)', advice: 'Blocked for legal/region reasons; a different network would be needed.' };
  return null;
}

export function detectBlock(signal: BlockSignal): BlockVerdict {
  const hay = `${signal?.title || ''}\n${signal?.text || ''}`.slice(0, 6000);
  const statuses = (signal?.statuses || []).filter((n) => Number.isFinite(n));

  // Explicit widgets/forms are the strongest, earliest signals — the user must act.
  if (signal?.hasCaptchaWidget) {
    return { blocked: true, kind: 'captcha', confidence: 'high', reason: 'CAPTCHA widget detected on the page',
      advice: 'Solve the captcha directly in the browser view below; the agent will not touch it. Your persistent profile keeps you verified next time.' };
  }
  // A login form counts as a login wall only when the page clearly IS a login page
  // (title/URL says so) — a password field alone (e.g. a signup or settings page) is not.
  if (signal?.hasPasswordField && /log\s?in|sign\s?in|로그인|nidlogin|auth|accounts?\.|signin/i.test(`${signal?.title || ''} ${signal?.url || ''}`)) {
    return { blocked: true, kind: 'login', confidence: 'high', reason: 'Login page / sign-in wall',
      advice: 'Log in directly in the browser view below; the agent will wait. Your persistent profile keeps the session for next time.' };
  }

  // A strong HTTP status is high-confidence on its own.
  const byStatus = statusKind(statuses);

  for (const rule of RULES) {
    if (rule.re.test(hay)) {
      // Text match + corroborating status → high; text alone → medium.
      const corroborated = byStatus?.kind === rule.kind;
      return { blocked: true, kind: rule.kind, confidence: corroborated ? 'high' : 'medium', reason: rule.reason, advice: rule.advice };
    }
  }
  if (byStatus) return { blocked: true, kind: byStatus.kind, confidence: 'high', reason: byStatus.reason, advice: byStatus.advice };

  // A near-empty body on a 200 that mentions javascript can be a silent interstitial.
  if ((signal?.text || '').trim().length < 40 && /enable javascript|turn on javascript/i.test(hay)) {
    return { blocked: true, kind: 'cloudflare', confidence: 'low', reason: 'blank page requiring JavaScript', advice: 'Likely a JS interstitial; wait and retry, or interact in the visible browser.' };
  }
  return NOT_BLOCKED;
}
