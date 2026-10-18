import { describe, expect, it } from 'vitest';
import { canonicalKey, planFormFill, type FormField } from './browserFormFill';

const contactForm: FormField[] = [
  { ref: '@e1', name: 'your-name', type: 'text', label: 'Your name' },
  { ref: '@e2', name: 'email', type: 'email', placeholder: 'you@example.com' },
  { ref: '@e3', name: 'subject', type: 'text' },
  { ref: '@e4', name: 'message', type: 'textarea', label: 'Message' },
];

describe('canonicalKey', () => {
  // 정상 + 매핑: synonyms collapse to canonical keys.
  it('maps synonyms to canonical keys', () => {
    expect(canonicalKey('e-mail')).toBe('email');
    expect(canonicalKey('fname')).toBe('firstName');
    expect(canonicalKey('tel')).toBe('phone');
    expect(canonicalKey('zipcode')).toBe('zip');
  });

  // None/변조: unknown keys pass through unchanged.
  it('passes through unknown keys', () => {
    expect(canonicalKey('coupon')).toBe('coupon');
    expect(canonicalKey('')).toBe('');
  });
});

describe('planFormFill', () => {
  // 정상: each value lands on its identity-matched field.
  it('matches values to fields by identity, not order', () => {
    const plan = planFormFill(
      { message: 'Hello there', email: 'a@b.com', name: 'Ada', subject: 'Hi' },
      contactForm,
    );
    const byRef = Object.fromEntries(plan.actions.map((a) => [a.ref, a.value]));
    expect(byRef['@e1']).toBe('Ada');       // your-name
    expect(byRef['@e2']).toBe('a@b.com');   // email
    expect(byRef['@e3']).toBe('Hi');        // subject
    expect(byRef['@e4']).toBe('Hello there'); // message
    expect(plan.unmatched).toEqual([]);
  });

  // 매핑: input type breaks ties (email value → email input).
  it('uses input type as a tie-breaker', () => {
    const fields: FormField[] = [
      { ref: '@e1', name: 'field_a', type: 'text' },
      { ref: '@e2', name: 'contact', type: 'email' },
    ];
    const plan = planFormFill({ email: 'x@y.com' }, fields);
    expect(plan.actions[0]?.ref).toBe('@e2');
  });

  it('does not reuse a field for two values', () => {
    const fields: FormField[] = [{ ref: '@e1', name: 'name', type: 'text' }];
    const plan = planFormFill({ firstName: 'Ada', fullName: 'Ada Lovelace' }, fields);
    // Only one field exists; exactly one value is placed, the other is unmatched.
    expect(plan.actions).toHaveLength(1);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('distinguishes password from confirm-password', () => {
    const fields: FormField[] = [
      { ref: '@e1', name: 'password', type: 'password' },
      { ref: '@e2', name: 'confirm_password', type: 'password' },
    ];
    const plan = planFormFill({ password: 'secret', confirmPassword: 'secret' }, fields);
    const byRef = Object.fromEntries(plan.actions.map((a) => [a.ref, a.key]));
    expect(byRef['@e1']).toBe('password');
    expect(byRef['@e2']).toBe('confirmPassword');
  });

  // None: no fields, or values with no matching field → all unmatched, no crash.
  it('reports unmatched values when no field fits', () => {
    expect(planFormFill({ email: 'a@b.com' }, [])).toEqual({ actions: [], unmatched: ['email'], ambiguous: [] });
    const plan = planFormFill({ favoriteColor: 'blue' }, contactForm);
    expect(plan.actions).toEqual([]);
    expect(plan.unmatched).toEqual(['favoriteColor']);
  });

  // 변조: empty/nullish values are dropped; malformed inputs do not throw.
  it('drops empty values and tolerates malformed input', () => {
    const plan = planFormFill({ email: '', name: null as unknown as string, subject: 'ok' }, contactForm);
    expect(plan.actions.map((a) => a.key)).toEqual(['subject']);
    expect(planFormFill({}, contactForm)).toEqual({ actions: [], unmatched: [], ambiguous: [] });
    expect(planFormFill(undefined as unknown as Record<string, unknown>, contactForm).actions).toEqual([]);
  });
});
