export const BROWSER_PROJECT_ROOT_KEY = 'bbarit-browser-project-root';
export const APP_PROJECTS_KEY = 'octo-terminal-projects';

type BrowserStorage = {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
};

function currentStorage(): BrowserStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function projectRootFromStoredProjects(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { projects?: any[]; activeProjectId?: string };
    const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
    const active = projects.find((project) => project?.id === parsed.activeProjectId) || projects[0];
    return typeof active?.workDir === 'string' ? active.workDir.trim() : '';
  } catch {
    return '';
  }
}

export function defaultProjectRootFromStorage(storage: BrowserStorage | null = currentStorage()): string {
  if (!storage) return '';
  try {
    const appRoot = projectRootFromStoredProjects(storage.getItem(APP_PROJECTS_KEY));
    if (appRoot) return appRoot;
    return (storage.getItem(BROWSER_PROJECT_ROOT_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function browserProjectUrlKey(projectRoot: string): string {
  return `bbarit-browser-url:${projectRoot.trim()}`;
}

export function savedProjectUrl(projectRoot: string, storage: BrowserStorage | null = currentStorage()): string {
  const root = projectRoot.trim();
  if (!root || !storage) return '';
  try {
    const saved = storage.getItem(browserProjectUrlKey(root)) || '';
    return /^https?:\/\//i.test(saved) ? saved : '';
  } catch {
    return '';
  }
}

export function saveProjectRoot(projectRoot: string, storage: BrowserStorage | null = currentStorage()): boolean {
  const root = projectRoot.trim();
  if (!root || !storage?.setItem) return false;
  try {
    storage.setItem(BROWSER_PROJECT_ROOT_KEY, root);
    return true;
  } catch {
    return false;
  }
}

export function saveProjectUrl(projectRoot: string, url: string, storage: BrowserStorage | null = currentStorage()): boolean {
  const root = projectRoot.trim();
  if (!root || !/^https?:\/\//i.test(url) || !storage?.setItem) return false;
  try {
    storage.setItem(browserProjectUrlKey(root), url);
    return true;
  } catch {
    return false;
  }
}

export function projectRootLabel(projectRoot: string): string {
  return projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || projectRoot;
}
