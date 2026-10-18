import { describe, expect, it } from 'vitest';
import { evaluateWait, parseWaitSpec, type WaitProbe } from './browserWaitFor';

describe('evaluateWait', () => {
  const probe: WaitProbe = { text: 'Products loaded. 24 items in stock.', elementCount: 24, url: 'https://x.test/results?q=a' };

  // 정상: containsText satisfied.
  it('is satisfied when text is present', () => {
    expect(evaluateWait({ containsText: 'in stock' }, probe)).toEqual({ satisfied: true, reason: 'all conditions met' });
  });

  // 매핑: not satisfied when text absent, with a reason.
  it('is unsatisfied when text is absent', () => {
    const r = evaluateWait({ containsText: 'sold out' }, probe);
    expect(r.satisfied).toBe(false);
    expect(r.reason).toContain('sold out');
  });

  // 매핑: missingText (e.g. wait until "loading" gone).
  it('waits for text to disappear', () => {
    expect(evaluateWait({ missingText: 'loading' }, probe).satisfied).toBe(true);
    expect(evaluateWait({ missingText: 'products' }, { text: 'products loading' }).satisfied).toBe(false);
  });

  // 매핑: minCount and urlIncludes.
  it('checks count and url', () => {
    expect(evaluateWait({ minCount: 20 }, probe).satisfied).toBe(true);
    expect(evaluateWait({ minCount: 50 }, probe).satisfied).toBe(false);
    expect(evaluateWait({ urlIncludes: '/results' }, probe).satisfied).toBe(true);
    expect(evaluateWait({ urlIncludes: '/checkout' }, probe).satisfied).toBe(false);
  });

  // 매핑: multiple conditions must ALL hold.
  it('requires all conditions to hold', () => {
    expect(evaluateWait({ containsText: 'products', minCount: 20 }, probe).satisfied).toBe(true);
    expect(evaluateWait({ containsText: 'products', minCount: 50 }, probe).satisfied).toBe(false);
  });

  // None/변조: empty condition satisfied; malformed probe safe.
  it('treats an empty condition as satisfied and tolerates bad probes', () => {
    expect(evaluateWait({}, probe).satisfied).toBe(true);
    expect(evaluateWait({ containsText: 'x' }, {} as WaitProbe).satisfied).toBe(false);
    expect(evaluateWait({ minCount: 1 }, undefined as unknown as WaitProbe).satisfied).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(evaluateWait({ containsText: 'PRODUCTS' }, probe).satisfied).toBe(true);
  });
});

describe('parseWaitSpec', () => {
  // 정상 + 매핑: object and bare-string forms.
  it('parses an object spec', () => {
    expect(parseWaitSpec({ containsText: 'done', minCount: 5, urlIncludes: '/x' })).toEqual({ containsText: 'done', minCount: 5, urlIncludes: '/x' });
  });
  it('treats a bare string as containsText', () => {
    expect(parseWaitSpec('Checkout complete')).toEqual({ containsText: 'Checkout complete' });
  });
  // None/변조: empty / junk → empty condition.
  it('returns an empty condition for junk', () => {
    expect(parseWaitSpec('')).toEqual({});
    expect(parseWaitSpec(null)).toEqual({});
    expect(parseWaitSpec({ minCount: -3 })).toEqual({});
  });
});
