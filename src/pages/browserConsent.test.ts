import { describe, expect, it } from 'vitest';
import { classifyConsentButton, decideConsent, type ConsentSignals } from './browserConsent';

describe('classifyConsentButton', () => {
  // 정상 + 매핑: EN and KO button texts classify correctly.
  it('classifies reject/accept/settings', () => {
    expect(classifyConsentButton('Reject all')).toBe('reject');
    expect(classifyConsentButton('Necessary only')).toBe('reject');
    expect(classifyConsentButton('모두 거부')).toBe('reject');
    expect(classifyConsentButton('Accept all')).toBe('accept');
    expect(classifyConsentButton('동의')).toBe('accept');
    expect(classifyConsentButton('Manage preferences')).toBe('settings');
    expect(classifyConsentButton('설정')).toBe('settings');
  });
  // 변조/None: empty and ambiguous text.
  it('returns unknown for empty or unrelated text', () => {
    expect(classifyConsentButton('')).toBe('unknown');
    expect(classifyConsentButton('Search')).toBe('unknown');
  });
  // "동의 안 함" must not be mis-read as accept ("동의").
  it('does not misclassify a Korean decline as accept', () => {
    expect(classifyConsentButton('동의 안 함')).toBe('reject');
  });
});

describe('decideConsent', () => {
  // None: no banner → not consent.
  it('returns not-consent when no banner is present', () => {
    const d = decideConsent({ buttons: [{ ref: '@e1', text: 'Login' }] });
    expect(d.isConsent).toBe(false);
    expect(d.target).toBeNull();
  });

  // 정상: prefers reject over accept.
  it('prefers reject-all over accept-all', () => {
    const d = decideConsent({
      hasConsentBanner: true,
      buttons: [{ ref: '@e1', text: 'Accept all' }, { ref: '@e2', text: 'Reject all' }, { ref: '@e3', text: 'Manage' }],
    });
    expect(d.isConsent).toBe(true);
    expect(d.action).toBe('reject');
    expect(d.target?.ref).toBe('@e2');
  });

  // 매핑: falls back to accept when no reject exists.
  it('falls back to accept when only accept is offered', () => {
    const d = decideConsent({ bannerText: 'We use cookies for a better experience', buttons: [{ ref: '@e1', text: 'Got it' }, { ref: '@e2', text: 'Cookie settings' }] });
    expect(d.action).toBe('accept');
    expect(d.target?.ref).toBe('@e1');
  });

  // 매핑: settings-only banner cannot be auto-dismissed.
  it('reports settings-only when no dismiss button exists', () => {
    const d = decideConsent({ hasConsentBanner: true, buttons: [{ ref: '@e1', text: 'Manage choices' }] });
    expect(d.action).toBe('settings');
    expect(d.target).toBeNull();
  });

  // Banner detected via a button's own cookie text (no explicit banner flag).
  it('detects a banner from cookie button text', () => {
    const d = decideConsent({ buttons: [{ ref: '@e1', text: 'Accept cookies' }] });
    expect(d.isConsent).toBe(true);
    expect(d.action).toBe('accept');
  });

  // 변조: empty/malformed signals never throw.
  it('tolerates empty and malformed signals', () => {
    expect(decideConsent({}).isConsent).toBe(false);
    expect(decideConsent(undefined as unknown as ConsentSignals).isConsent).toBe(false);
    expect(decideConsent({ hasConsentBanner: true, buttons: [{ ref: '@e1', text: '' }] }).target).toBeNull();
  });
});
