/**
 * Utility for sub-windows (orchestra, scrum, debate) to read project/theme
 * data from URL search params and localStorage.
 */
import { FONTS, STYLES } from '../theme';
import type { StyleTheme, FontOption } from '../theme';
import { kvGet } from '../hooks/useKV';

const STORAGE_KEY = 'octo-terminal-projects';

export interface SubWindowProject {
  id: string;
  name: string;
  workDir: string;
  styleIndex: number;
  fontIndex: number;
}

/** Read project ID from URL search params (?projectId=xxx) */
export function getProjectIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('projectId');
}

/** Load all projects from KV store (shared with main window) */
export async function loadProjectsFromStorage(): Promise<SubWindowProject[]> {
  try {
    const raw = await kvGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (parsed.projects || []).map((p: any) => ({
      id: p.id || '',
      name: p.displayName || p.name || '',
      workDir: p.workDir || '',
      styleIndex: typeof p.styleIndex === 'number' ? p.styleIndex : 0,
      fontIndex: typeof p.fontIndex === 'number' ? p.fontIndex : 0,
    }));
  } catch {
    return [];
  }
}

/** Get project + style/font for the sub-window */
export async function getSubWindowContext(): Promise<{
  project: SubWindowProject | null;
  projects: SubWindowProject[];
  style: StyleTheme;
  font: FontOption;
}> {
  const projects = await loadProjectsFromStorage();
  const projectId = getProjectIdFromUrl();
  const project = projects.find(p => p.id === projectId) || projects[0] || null;
  const style = project ? (STYLES[project.styleIndex] || STYLES[0]) : STYLES[0];
  const font = project ? (FONTS[project.fontIndex] || FONTS[0]) : FONTS[0];
  return { project, projects, style, font };
}
