import { describe, expect, it } from 'vitest';
import { redact, redactSecrets, totalRedactions } from './browserRedact';

describe('redactSecrets', () => {
  // 정상: each secret shape is masked.
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36';
    const r = redactSecrets(`token is ${jwt} ok`);
    expect(r.text).toBe('token is [REDACTED:jwt] ok');
    expect(r.counts.jwt).toBe(1);
  });

  it('redacts bearer tokens and API keys', () => {
    expect(redact('Authorization: Bearer abcdef1234567890XYZ')).toContain('[REDACTED:bearer]');
    expect(redact('key sk-abcdefghijklmnop1234 here')).toContain('[REDACTED:apikey]');
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain('[REDACTED:apikey]');
  });

  // 매핑: credential key=value keeps the key.
  it('redacts credential key=value but keeps the key name', () => {
    expect(redact('password=hunter2secret')).toBe('password=[REDACTED:credential]');
    expect(redact('api_key: myLongSecretValue123')).toBe('api_key=[REDACTED:credential]');
    expect(redact('?token=abcd1234&x=1')).toContain('token=[REDACTED:credential]');
  });

  it('redacts credit-card-like numbers', () => {
    expect(redact('card 4111 1111 1111 1111 charged')).toBe('card [REDACTED:card] charged');
    expect(redact('4111-1111-1111-1111')).toBe('[REDACTED:card]');
  });

  // None/변조: clean text and non-strings are untouched / safe.
  it('leaves clean text alone and tolerates non-strings', () => {
    expect(redact('just a normal sentence with numbers 42 and 2026')).toBe('just a normal sentence with numbers 42 and 2026');
    expect(redact(undefined)).toBe('');
    expect(redact(12345)).toBe('12345');
  });

  it('counts multiple redactions', () => {
    const r = redactSecrets('password=abcd1234 and card 4111111111111111');
    expect(totalRedactions(r.counts)).toBe(2);
  });

  it('does not redact short number runs (phone-ish is out of range, prices safe)', () => {
    expect(redact('call 010 1234 5678')).toBe('call 010 1234 5678'); // 11 digits < 13, not a card
    expect(redact('price 1,299')).toBe('price 1,299');
  });
});
