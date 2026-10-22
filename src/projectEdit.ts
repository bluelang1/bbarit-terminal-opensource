// Pure helpers for the project modal's edit mode (App.tsx renderNewProjectModal).

/** Project.githubAccount value meaning "inject nothing; use gh's active account". */
export const GITHUB_ACCOUNT_NONE = '__none__';

export interface ProjectEditTarget {
  workDir: string;
  name: string;
  displayName: string;
}

export interface ProjectEditForm {
  /** Normalized project location (local path or ssh:// virtual path). */
  path: string;
  displayName: string;
  styleIndex: number;
  fontIndex: number;
  /** '' = auto-detect, a gh login, or GITHUB_ACCOUNT_NONE. */
  githubAccount: string;
}

export interface ProjectEditUpdates {
  workDir?: string;
  name?: string;
  displayName?: string;
  styleIndex: number;
  fontIndex: number;
  githubAccount: string | undefined;
}

/** Project.githubAccount to store: SSH projects run gh remotely, '' means auto. */
export function projectGithubAccountFor(path: string, choice: string): string | undefined {
  if (String(path || '').trim().startsWith('ssh://')) return undefined;
  return choice.trim() || undefined;
}

/**
 * In-place updates for saving an edited project. Only changed location/name
 * fields are included; id, terminals and the active terminal are never touched.
 */
export function projectEditUpdates(
  project: ProjectEditTarget,
  form: ProjectEditForm,
  normalizePath: (path: string) => string = (p) => p,
): { updates: ProjectEditUpdates; displayName: string; workDirChanged: boolean } {
  const workDirChanged = normalizePath(project.workDir) !== form.path;
  const currentName = project.displayName || project.name;
  const displayName = form.displayName.trim() || currentName;
  const renamed = displayName !== currentName;
  return {
    updates: {
      ...(workDirChanged ? { workDir: form.path } : {}),
      ...(renamed ? { name: displayName, displayName } : {}),
      styleIndex: form.styleIndex,
      fontIndex: form.fontIndex,
      githubAccount: projectGithubAccountFor(form.path, form.githubAccount),
    },
    displayName,
    workDirChanged,
  };
}
