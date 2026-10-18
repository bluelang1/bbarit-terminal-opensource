import { describe, expect, it } from 'vitest';
import { MAX_BLOCK_ATTEMPTS, isAutoRecoverable, planBlockRecovery } from './browserBlockRecovery';
import type { BlockVerdict } from './browserBlockDetector';

function verdict(kind: BlockVerdict['kind'], blocked = true): BlockVerdict {
  return { blocked, kind, confidence: 'high', reason: kind, advice: `advice for ${kind}` };
}

describe('planBlockRecovery', () => {
  // None: a non-block verdict is a no-op give_up.
  it('does nothing when not blocked', () => {
    const p = planBlockRecovery(verdict('none', false), 0);
    expect(p.action).toBe('give_up');
    expect(p.message).toBe('not blocked');
  });

  // 정상: Cloudflare/JS interstitial → wait then reload, escalating.
  it('auto-waits and reloads for a Cloudflare wall, escalating the backoff', () => {
    const a0 = planBlockRecovery(verdict('cloudflare'), 0);
    expect(a0.action).toBe('reload');
    expect(a0.waitMs).toBe(4_000);
    const a1 = planBlockRecovery(verdict('cloudflare'), 1);
    expect(a1.waitMs).toBe(8_000);
    const a2 = planBlockRecovery(verdict('cloudflare'), 2);
    expect(a2.waitMs).toBe(15_000);
  });

  // 매핑: rate limit waits then retries (not reload).
  it('waits then retries for a rate limit', () => {
    const p = planBlockRecovery(verdict('ratelimit'), 0);
    expect(p.action).toBe('retry');
    expect(p.waitMs).toBe(4_000);
  });

  // 매핑: exhaustion after the schedule runs out.
  it('gives up as exhausted after max attempts', () => {
    const p = planBlockRecovery(verdict('cloudflare'), MAX_BLOCK_ATTEMPTS);
    expect(p.action).toBe('give_up');
    expect(p.exhausted).toBe(true);
    expect(p.message).toMatch(/exhausted/i);
  });

  // 매핑: human-required walls short-circuit, no auto-retry.
  it('routes captcha and login to human action', () => {
    expect(planBlockRecovery(verdict('captcha'), 0).action).toBe('wait_human');
    expect(planBlockRecovery(verdict('login'), 0).action).toBe('wait_human');
    expect(planBlockRecovery(verdict('captcha'), 0).waitMs).toBe(0);
  });

  // 매핑: hard walls give up immediately with a clear reason.
  it('gives up on geo and forbidden walls', () => {
    expect(planBlockRecovery(verdict('geo'), 0).action).toBe('give_up');
    expect(planBlockRecovery(verdict('forbidden'), 0).message).toMatch(/403|forbidden/i);
  });

  // 변조: malformed verdicts do not throw.
  it('tolerates malformed verdicts', () => {
    expect(planBlockRecovery(null as unknown as BlockVerdict, 0).action).toBe('give_up');
    expect(planBlockRecovery({ blocked: true } as BlockVerdict, -5).action).toBe('give_up');
  });
});

describe('isAutoRecoverable', () => {
  it('is true only for wait-and-retry walls', () => {
    expect(isAutoRecoverable(verdict('cloudflare'))).toBe(true);
    expect(isAutoRecoverable(verdict('ratelimit'))).toBe(true);
    expect(isAutoRecoverable(verdict('captcha'))).toBe(false);
    expect(isAutoRecoverable(verdict('geo'))).toBe(false);
    expect(isAutoRecoverable(verdict('none', false))).toBe(false);
  });
});
