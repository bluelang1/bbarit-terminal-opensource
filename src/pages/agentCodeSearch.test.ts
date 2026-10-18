import { describe, expect, it } from 'vitest';
import { compileSearch, extOf, globMatches, globToRegex, joinPath, relPath } from './agentCodeSearch';

describe('agent code search helpers', () => {
  it('matches basename globs anywhere in the project', () => {
    const re = globToRegex('*.tsx');
    expect(globMatches(re, '*.tsx', 'src/pages/BrowserPage.tsx', 'BrowserPage.tsx')).toBe(true);
    expect(globMatches(re, '*.tsx', 'src/pages/BrowserPage.css', 'BrowserPage.css')).toBe(false);
  });

  it('matches slash globs against relative paths including immediate children', () => {
    const re = globToRegex('src/**/*.tsx');
    expect(globMatches(re, 'src/**/*.tsx', 'src/AppBootstrap.tsx', 'AppBootstrap.tsx')).toBe(true);
    expect(globMatches(re, 'src/**/*.tsx', 'src/pages/BrowserPage.tsx', 'BrowserPage.tsx')).toBe(true);
    expect(globMatches(re, 'src/**/*.tsx', 'tests/BrowserPage.tsx', 'BrowserPage.tsx')).toBe(false);
  });

  it('falls back to literal matching for invalid regex search patterns', () => {
    const re = compileSearch('[seo');
    expect(re.test('route [seo marker]')).toBe(true);
  });

  it('normalizes Windows paths for Tauri file search output', () => {
    expect(joinPath('C:\\repo\\src\\', 'App.tsx')).toBe('C:/repo/src/App.tsx');
    expect(relPath('C:\\repo', 'C:\\repo\\src\\App.tsx')).toBe('src/App.tsx');
    expect(extOf('Component.TSX')).toBe('.tsx');
  });
});
