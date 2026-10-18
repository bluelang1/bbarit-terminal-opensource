import { describe, expect, it } from 'vitest';
import {
  APP_PROJECTS_KEY,
  BROWSER_PROJECT_ROOT_KEY,
  browserProjectUrlKey,
  defaultProjectRootFromStorage,
  projectRootFromStoredProjects,
  projectRootLabel,
  savedProjectUrl,
  saveProjectRoot,
  saveProjectUrl,
} from './browserProjectStorage';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe('browser project storage', () => {
  it('uses the active app project root before any browser fallback root', () => {
    const raw = JSON.stringify({
      activeProjectId: 'b',
      projects: [
        { id: 'a', workDir: 'C:/repo/a' },
        { id: 'b', workDir: 'C:/repo/b' },
      ],
    });
    expect(projectRootFromStoredProjects(raw)).toBe('C:/repo/b');
    expect(defaultProjectRootFromStorage(memoryStorage({
      [APP_PROJECTS_KEY]: raw,
      [BROWSER_PROJECT_ROOT_KEY]: 'C:/fallback',
    }))).toBe('C:/repo/b');
  });

  it('falls back to the browser-specific project root when app projects are missing or invalid', () => {
    expect(defaultProjectRootFromStorage(memoryStorage({
      [APP_PROJECTS_KEY]: '{broken',
      [BROWSER_PROJECT_ROOT_KEY]: 'C:/picked/site',
    }))).toBe('C:/picked/site');
  });

  it('persists project roots and only restores http URLs for a project', () => {
    const storage = memoryStorage();
    expect(saveProjectRoot(' C:/site ', storage)).toBe(true);
    expect(storage.getItem(BROWSER_PROJECT_ROOT_KEY)).toBe('C:/site');

    expect(saveProjectUrl('C:/site', 'http://localhost:4321/demo', storage)).toBe(true);
    expect(storage.getItem(browserProjectUrlKey('C:/site'))).toBe('http://localhost:4321/demo');
    expect(savedProjectUrl('C:/site', storage)).toBe('http://localhost:4321/demo');

    storage.setItem(browserProjectUrlKey('C:/site'), 'file:///C:/site/index.html');
    expect(savedProjectUrl('C:/site', storage)).toBe('');
  });

  it('formats compact project labels for the Agent panel', () => {
    expect(projectRootLabel('C:\\Users\\me\\site')).toBe('me/site');
    expect(projectRootLabel('/Users/me/site/')).toBe('me/site');
  });
});
