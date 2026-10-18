import { describe, expect, it } from 'vitest';
import { matchOption, type SelectOption } from './browserSelect';

const opts: SelectOption[] = [
  { value: '', label: 'Select a size', index: 0 },
  { value: 's', label: 'Small', index: 1 },
  { value: 'm', label: 'Medium', index: 2 },
  { value: 'l', label: 'Large', index: 3 },
  { value: 'kr', label: '대한민국', index: 4 },
];

describe('matchOption', () => {
  // 정상: exact label (case-insensitive).
  it('matches an exact label', () => {
    expect(matchOption('Large', opts)).toMatchObject({ value: 'l', index: 3, ambiguous: false });
    expect(matchOption('large', opts).value).toBe('l');
    expect(matchOption('대한민국', opts).value).toBe('kr');
  });

  // 매핑: exact value.
  it('matches by value when label does not match', () => {
    expect(matchOption('m', opts).value).toBe('m');
  });

  // 매핑: unique substring.
  it('matches a unique label substring', () => {
    expect(matchOption('med', opts).value).toBe('m');
  });

  // 변조: ambiguous substring returns null + flag.
  it('flags an ambiguous substring match', () => {
    const many: SelectOption[] = [{ value: 'a', label: 'Red apple' }, { value: 'b', label: 'Green apple' }];
    const r = matchOption('apple', many);
    expect(r.value).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  // None: no match.
  it('returns null when nothing matches', () => {
    expect(matchOption('XXL', opts).value).toBeNull();
    expect(matchOption('', opts).value).toBeNull();
    expect(matchOption('anything', []).value).toBeNull();
  });

  // 변조: malformed options tolerated.
  it('tolerates malformed options', () => {
    expect(matchOption('a', undefined as unknown as SelectOption[]).value).toBeNull();
    expect(matchOption('Small', [{ value: 's', label: '' }, { value: '', label: 'Small' }]).value).toBe('');
  });
});
