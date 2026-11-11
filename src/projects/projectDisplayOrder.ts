// The order projects appear in on screen. The project list renderers (top
// project tabs, left project panel, the project-terminal selector) and the
// project shortcuts (project.next / project.previous / project.tab-1..9) all
// go through these functions, so the keyboard always walks the visible list.

export interface DisplayProject {
  id: string;
  hidden?: boolean;
  favorite?: boolean;
  groupId?: string;
}

export interface DisplayGroup {
  id: string;
  collapsed?: boolean;
}

/**
 * Where the project list is drawn.
 * - 'top-tabs': the tab strip above the terminals. Ungrouped projects first, then each group.
 * - 'left-panel': the resizable left panel. Each group first, then the ungrouped projects.
 * - 'flat': the old project-terminal selector. No groups, just the visible list.
 */
export type ProjectListLayout = 'top-tabs' | 'left-panel' | 'flat';

export interface ProjectDisplaySection<P, G> {
  group: G | null;
  projects: P[];
}

/** Hidden projects are dropped; favorites float to the top, otherwise the stored order is kept. */
export function visibleProjectsInOrder<P extends DisplayProject>(projects: readonly P[]): P[] {
  return projects
    .filter((project) => !project.hidden)
    .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
}

/** A project whose groupId names no existing group is drawn with the ungrouped ones. */
export function isUngroupedProject(project: DisplayProject, groups: readonly DisplayGroup[]): boolean {
  return !project.groupId || !groups.some((group) => group.id === project.groupId);
}

/**
 * The sections a layout draws, in screen order. `visibleProjects` must already be
 * the output of visibleProjectsInOrder. Empty groups are kept (they still draw a header).
 */
export function projectDisplaySections<P extends DisplayProject, G extends DisplayGroup>(
  visibleProjects: readonly P[],
  groups: readonly G[],
  layout: ProjectListLayout,
): Array<ProjectDisplaySection<P, G>> {
  if (layout === 'flat') return [{ group: null, projects: [...visibleProjects] }];
  const ungrouped: ProjectDisplaySection<P, G> = {
    group: null,
    projects: visibleProjects.filter((project) => isUngroupedProject(project, groups)),
  };
  const grouped = groups.map((group) => ({
    group,
    projects: visibleProjects.filter((project) => project.groupId === group.id),
  }));
  return layout === 'left-panel' ? [...grouped, ungrouped] : [ungrouped, ...grouped];
}

/**
 * Project ids in screen order. Projects inside a collapsed group are not on screen
 * and are left out unless `includeCollapsed` is set.
 */
export function projectDisplayOrderIds<P extends DisplayProject, G extends DisplayGroup>(
  sections: ReadonlyArray<ProjectDisplaySection<P, G>>,
  options: { includeCollapsed?: boolean } = {},
): string[] {
  const ids: string[] = [];
  for (const section of sections) {
    if (section.group?.collapsed && !options.includeCollapsed) continue;
    for (const project of section.projects) ids.push(project.id);
  }
  return ids;
}

/**
 * The project `delta` steps away from the active one in screen order, wrapping
 * around (+1 = the next one down / to the right). Projects in collapsed groups
 * are skipped. When the active project is itself inside a collapsed group the
 * walk starts from its place in the full order, so it still moves to the
 * neighbouring visible project. Returns null when there is nowhere to go.
 */
export function projectIdByDisplayDelta<P extends DisplayProject, G extends DisplayGroup>(
  sections: ReadonlyArray<ProjectDisplaySection<P, G>>,
  activeProjectId: string | null,
  delta: number,
): string | null {
  const shown = projectDisplayOrderIds(sections);
  if (shown.length === 0 || delta === 0) return null;
  const step = delta > 0 ? 1 : -1;
  const steps = Math.abs(delta);

  const shownIndex = activeProjectId ? shown.indexOf(activeProjectId) : -1;
  if (shownIndex >= 0) {
    if (shown.length === 1) return null;
    const next = ((shownIndex + delta) % shown.length + shown.length) % shown.length;
    return shown[next] ?? null;
  }

  // Active project is not on screen (collapsed group or unknown id).
  const all = projectDisplayOrderIds(sections, { includeCollapsed: true });
  const allIndex = activeProjectId ? all.indexOf(activeProjectId) : -1;
  // No active project: next starts at the top, previous at the bottom.
  if (allIndex < 0) return step > 0 ? shown[0] : shown[shown.length - 1];
  const shownSet = new Set(shown);
  let index = allIndex;
  let remaining = steps;
  let target: string | null = null;
  for (let guard = 0; guard < all.length * steps + all.length && remaining > 0; guard += 1) {
    index = (index + step + all.length) % all.length;
    if (shownSet.has(all[index])) {
      target = all[index];
      remaining -= 1;
    }
  }
  return target;
}

/** The project shown at `index` (0-based) in screen order, for project.tab-1..9. */
export function projectIdAtDisplayIndex<P extends DisplayProject, G extends DisplayGroup>(
  sections: ReadonlyArray<ProjectDisplaySection<P, G>>,
  index: number,
): string | null {
  return projectDisplayOrderIds(sections)[index] ?? null;
}
