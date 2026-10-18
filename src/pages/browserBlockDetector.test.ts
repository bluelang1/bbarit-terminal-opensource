import { describe, expect, it } from 'vitest';
import { detectBlock } from './browserBlockDetector';

describe('detectBlock', () => {
  // None: a normal page is not blocked.
  it('reports no block for a normal page', () => {
    const v = detectBlock({ title: 'Example Domain', text: 'This domain is for use in examples.', statuses: [200] });
    expect(v.blocked).toBe(false);
    expect(v.kind).toBe('none');
  });

  // 정상: Cloudflare interstitial by text.
  it('detects a Cloudflare challenge', () => {
    const v = detectBlock({ title: 'Just a moment...', text: 'Checking your browser before accessing. Ray ID: 12ab', statuses: [200] });
    expect(v.blocked).toBe(true);
    expect(v.kind).toBe('cloudflare');
    expect(v.advice).toMatch(/challenge|visible/i);
  });

  it('detects a captcha', () => {
    const v = detectBlock({ title: 'Verify', text: "Please confirm you're not a robot. hCaptcha", statuses: [200] });
    expect(v.kind).toBe('captcha');
  });

  // 매핑: text + matching status → high confidence.
  it('raises confidence when status corroborates the text', () => {
    const v = detectBlock({ title: 'Access Denied', text: '403 Forbidden: you don\'t have permission', statuses: [403] });
    expect(v.kind).toBe('forbidden');
    expect(v.confidence).toBe('high');
  });

  // 매핑: status-only detection when text is unhelpful.
  it('detects by HTTP status alone', () => {
    expect(detectBlock({ text: '', statuses: [429] }).kind).toBe('ratelimit');
    expect(detectBlock({ text: '', statuses: [503] }).kind).toBe('unavailable');
    expect(detectBlock({ text: '', statuses: [451] }).kind).toBe('geo');
  });

  it('detects geo and login walls by text', () => {
    expect(detectBlock({ text: 'This content is unavailable in your region.' }).kind).toBe('geo');
    expect(detectBlock({ text: 'Please log in to continue reading. Members only.' }).kind).toBe('login');
  });

  it('flags a blank JS-required interstitial at low confidence', () => {
    const v = detectBlock({ title: '', text: '   ', statuses: [200] });
    expect(v.blocked).toBe(false); // no "enable javascript" text → not a block
    const v2 = detectBlock({ title: '', text: 'Please enable JavaScript', statuses: [200] });
    expect(v2.blocked).toBe(true);
    expect(v2.confidence).toBe('low');
  });

  // 변조: empty / malformed signals never throw.
  it('tolerates empty and malformed signals', () => {
    expect(detectBlock({}).blocked).toBe(false);
    expect(detectBlock({ statuses: [NaN as unknown as number] }).blocked).toBe(false);
    expect(detectBlock({ text: undefined, title: undefined }).kind).toBe('none');
  });

  // Korean-language block pages are recognized too.
  it('recognizes Korean-language block text', () => {
    expect(detectBlock({ text: '로그인이 필요합니다.' }).kind).toBe('login');
    expect(detectBlock({ text: '이 지역에서는 콘텐츠를 사용할 수 없습니다.' }).kind).toBe('geo');
  });

  // Real case from Naver Shopping: Korean security-check captcha must be caught.
  it('recognizes Korean captcha / security-check walls (Naver)', () => {
    expect(detectBlock({ title: '', text: 'NAVER 보안 확인을 완료해 주세요. 이 절차는 귀하가 실제 사용자임을 확인하여...' }).kind).toBe('captcha');
    expect(detectBlock({ text: '로봇이 아닙니다를 확인해 주세요' }).kind).toBe('captcha');
    expect(detectBlock({ text: '자동 입력 방지 문자를 입력하세요' }).kind).toBe('captcha');
  });

  // Widget/form signals: user must handle these directly (captcha widget, login form).
  it('flags a captcha widget as high-confidence captcha', () => {
    const v = detectBlock({ title: 'Anything', text: 'normal-looking content', hasCaptchaWidget: true });
    expect(v.kind).toBe('captcha');
    expect(v.confidence).toBe('high');
    expect(v.advice).toMatch(/directly|browser view/i);
  });

  it('flags a login page (password field + login title/url) as a login wall', () => {
    expect(detectBlock({ title: '네이버 : 로그인', url: 'https://nid.naver.com/nidlogin.login', hasPasswordField: true }).kind).toBe('login');
    expect(detectBlock({ title: 'Sign in', url: 'https://accounts.google.com', hasPasswordField: true }).kind).toBe('login');
  });

  it('does NOT flag a password field on a non-login page (no false positive)', () => {
    // A settings/signup page with a password field but no login signals is not a wall.
    expect(detectBlock({ title: 'Account settings', url: 'https://x.test/settings', text: 'Change your password', hasPasswordField: true }).blocked).toBe(false);
  });
});
