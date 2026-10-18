// Cookie / consent banner detection.
//
// Many sites gate content behind a GDPR/cookie consent overlay. To reach the actual
// page (and for the agent to act), that banner needs dismissing. This module scores
// candidate buttons collected in-page and picks the best DISMISS target — preferring
// "reject / necessary-only" (privacy-friendly) over "accept all", and never a
// "settings / manage" button (which opens more UI instead of closing the banner).
//
// D1: Prefer reject-all, then accept-all, never open "manage settings".
//     Reason: dismissing with the least data-sharing is the respectful default; the
//     goal is to get past the wall, and "manage" does the opposite. Cost: a site that
//     only offers "manage" won't be auto-dismissed. Escape hatch: returns null → the
//     agent can act manually.

export interface ConsentButton {
  ref: string;         // @eN ref or selector to click
  text: string;
  role?: string;
}

export interface ConsentSignals {
  hasConsentBanner?: boolean;  // an element whose text/class signals a cookie/consent banner
  bannerText?: string;
  buttons?: ConsentButton[];
}

export type ConsentAction = 'reject' | 'accept' | 'settings' | 'unknown';

export interface ConsentDecision {
  isConsent: boolean;
  target: ConsentButton | null;   // the button to click to dismiss
  action: ConsentAction;
  reason: string;
}

// Text patterns (EN + KO) for each button class. Order within classify matters.
const REJECT_RE = /(reject all|reject|decline|deny|necessary only|only necessary|essential only|refuse|모두\s*거부|거부|필수\s*만|필요한\s*쿠키만|동의\s*안)/i;
const ACCEPT_RE = /(accept all|accept|agree|allow all|allow|got it|i agree|ok|okay|continue|모두\s*수락|수락|동의(?!\s*안)|허용|확인)/i;
const SETTINGS_RE = /(manage|settings|preferences|customi[sz]e|options|choices|more info|설정|관리|맞춤|자세히)/i;

// Signals that an overlay IS a cookie/consent banner (not some other modal).
const BANNER_RE = /(cookie|consent|gdpr|privacy|개인정보|쿠키|동의|tracking|추적)/i;

export function classifyConsentButton(text: string): ConsentAction {
  const t = String(text || '').trim();
  if (!t) return 'unknown';
  // Settings must be checked BEFORE accept ("manage preferences" contains no accept word,
  // but "customize" etc. should never be treated as a dismiss).
  if (SETTINGS_RE.test(t) && !REJECT_RE.test(t)) return 'settings';
  if (REJECT_RE.test(t)) return 'reject';
  if (ACCEPT_RE.test(t)) return 'accept';
  return 'unknown';
}

export function decideConsent(signals: ConsentSignals): ConsentDecision {
  const buttons = (signals?.buttons || []).filter((b) => b && String(b.text || '').trim());
  const bannerLikely = !!signals?.hasConsentBanner || BANNER_RE.test(String(signals?.bannerText || ''));
  if (!bannerLikely && !buttons.some((b) => BANNER_RE.test(b.text))) {
    return { isConsent: false, target: null, action: 'unknown', reason: 'no cookie/consent banner detected' };
  }

  let reject: ConsentButton | null = null;
  let accept: ConsentButton | null = null;
  for (const b of buttons) {
    const kind = classifyConsentButton(b.text);
    if (kind === 'reject' && !reject) reject = b;
    else if (kind === 'accept' && !accept) accept = b;
  }

  if (reject) return { isConsent: true, target: reject, action: 'reject', reason: 'dismiss with reject/necessary-only (least data sharing)' };
  if (accept) return { isConsent: true, target: accept, action: 'accept', reason: 'no reject option; accept to get past the banner' };
  return { isConsent: true, target: null, action: 'settings', reason: 'only a settings/manage control found; cannot auto-dismiss — act manually' };
}
