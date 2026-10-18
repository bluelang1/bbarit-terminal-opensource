import { describe, expect, it } from 'vitest';
import { matchElement, scoreElement, type PageElement } from './browserElementMatch';

const page: PageElement[] = [
  { ref: '@e1', role: 'link', name: 'Home' },
  { ref: '@e2', role: 'button', name: 'Log in' },
  { ref: '@e3', role: 'searchbox', name: 'Search products' },
  { ref: '@e4', role: 'button', name: 'Sign up' },
  { ref: '@e5', role: 'button', name: 'Add to cart' },
];

describe('scoreElement', () => {
  it('rewards exact name-word matches and role hints', () => {
    const login = page[1];
    const withRole = scoreElement(['log', 'in'], ['button'], login);
    const noRole = scoreElement(['log', 'in'], [], login);
    expect(withRole).toBeGreaterThan(noRole);
  });
  it('returns 0 for an element with no name and no role', () => {
    expect(scoreElement(['x'], [], { ref: '@e9' })).toBe(0);
  });
});

describe('matchElement', () => {
  // 정상: a clear description picks the right element.
  it('matches by description', () => {
    expect(matchElement('the login button', page).ref).toBe('@e2');
    expect(matchElement('search products', page).ref).toBe('@e3');
    expect(matchElement('add to cart', page).ref).toBe('@e5');
  });

  // 매핑: Korean description works.
  it('matches Korean descriptions', () => {
    expect(matchElement('검색 입력창', page).ref).toBe('@e3');
  });

  // 매핑: role hint disambiguates when names alone are weak.
  it('uses the role hint from the description', () => {
    const r = matchElement('search box', page);
    expect(r.ref).toBe('@e3');
  });

  // 변조: an ambiguous description (two equally-good buttons) returns null + flag.
  it('flags ambiguity when two candidates tie', () => {
    const twins: PageElement[] = [
      { ref: '@e1', role: 'button', name: 'Download' },
      { ref: '@e2', role: 'button', name: 'Download' },
    ];
    const r = matchElement('download', twins);
    expect(r.ambiguous).toBe(true);
    expect(r.ref).toBeNull();
    expect(r.candidates.length).toBe(2);
  });

  // None: no match → null, not ambiguous.
  it('returns null when nothing matches', () => {
    const r = matchElement('nonexistent widget xyz', page);
    expect(r.ref).toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.candidates).toEqual([]);
  });

  // 변조: empty/malformed inputs never throw.
  it('tolerates empty inputs', () => {
    expect(matchElement('', page).ref).toBeNull();
    expect(matchElement('login', []).ref).toBeNull();
    expect(matchElement('login', undefined as unknown as PageElement[]).ref).toBeNull();
  });

  it('exposes ranked candidates', () => {
    const r = matchElement('sign', page);
    expect(r.candidates[0].name).toBe('Sign up');
  });
});
