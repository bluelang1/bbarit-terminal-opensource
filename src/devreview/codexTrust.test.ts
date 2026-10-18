import { describe, it, expect } from 'vitest';
import { codexTrustKey, existingCodexTrustKeys, codexConfigWithTrust } from './codexTrust';

describe('codexTrustKey — path → codex config key', () => {
  it('정상: lowercases and uses backslash separators', () => {
    expect(codexTrustKey('C:/Users/test-user/Documents/projects/Foo'))
      .toBe('c:\\users\\test-user\\documents\\projects\\foo');
  });
  it('매핑: collapses mixed/duplicate separators and strips a trailing one', () => {
    expect(codexTrustKey('C:\\Users//test-user\\\\proj\\')).toBe('c:\\users\\test-user\\proj');
    expect(codexTrustKey('  C:/a/b/  ')).toBe('c:\\a\\b');
  });
  it('None: empty / whitespace → empty key', () => {
    expect(codexTrustKey('')).toBe('');
    expect(codexTrustKey('   ')).toBe('');
    expect(codexTrustKey(undefined as unknown as string)).toBe('');
  });
});

describe('existingCodexTrustKeys', () => {
  it('정상: extracts single- and double-quoted project keys, lowercased', () => {
    const cfg = `model = "gpt-5.5"\n[projects.'c:\\users\\a']\ntrust_level = "trusted"\n[projects."C:\\Users\\B"]\ntrust_level = "trusted"\n`;
    const keys = existingCodexTrustKeys(cfg);
    expect(keys.has('c:\\users\\a')).toBe(true);
    expect(keys.has('c:\\users\\b')).toBe(true);
    expect(keys.size).toBe(2);
  });
  it('None: no projects → empty set', () => {
    expect(existingCodexTrustKeys('model = "x"\n').size).toBe(0);
    expect(existingCodexTrustKeys('').size).toBe(0);
  });
});

describe('codexConfigWithTrust — idempotent trust seeding', () => {
  it('정상: appends a well-formed trusted entry for a new dir', () => {
    const out = codexConfigWithTrust('model = "x"\n', ['C:/Users/test-user/proj']);
    expect(out).toContain("[projects.'c:\\users\\test-user\\proj']");
    expect(out).toContain('trust_level = "trusted"');
    // existing content preserved
    expect(out.startsWith('model = "x"\n')).toBe(true);
  });
  it('매핑: a dir already trusted (any case/separator) is NOT re-added', () => {
    const existing = `[projects.'c:\\users\\test-user\\proj']\ntrust_level = "trusted"\n`;
    const out = codexConfigWithTrust(existing, ['C:\\Users\\test-user\\proj\\']);
    expect(out).toBe(existing); // unchanged — no duplicate section
    expect((out.match(/\[projects\./g) || []).length).toBe(1);
  });
  it('매핑: dedupes repeated inputs and only adds the missing ones', () => {
    const existing = `[projects.'c:\\a']\ntrust_level = "trusted"\n`;
    const out = codexConfigWithTrust(existing, ['C:/a', 'C:/b', 'C:\\B\\']);
    expect((out.match(/\[projects\./g) || []).length).toBe(2); // a (kept) + b (added once)
    expect(out).toContain("[projects.'c:\\b']");
  });
  it('None: empty/blank dirs and empty list leave config untouched', () => {
    expect(codexConfigWithTrust('model = "x"\n', [])).toBe('model = "x"\n');
    expect(codexConfigWithTrust('model = "x"\n', ['', '   '])).toBe('model = "x"\n');
  });
  it('None: missing config file (empty string) yields just the new entry', () => {
    const out = codexConfigWithTrust('', ['C:/a']);
    expect(out).toContain("[projects.'c:\\a']");
    expect(out).toContain('trust_level = "trusted"');
  });
  it('변조: a config not ending in newline still gets a clean separator before the new section', () => {
    const out = codexConfigWithTrust('model = "x"', ['C:/a']); // no trailing newline
    expect(out).toContain('model = "x"\n\n[projects.');
    expect(out).not.toContain('model = "x"[projects'); // never glued onto the prior line
  });
  it('변조: non-array dirs argument is tolerated (treated as empty)', () => {
    expect(codexConfigWithTrust('model = "x"\n', null as unknown as string[])).toBe('model = "x"\n');
  });
});
