export interface ProjectUsageCandidate {
  id: string;
  hidden?: boolean;
}

export const cleanProjectUsageHistory = (
  history: string[],
  projects: ProjectUsageCandidate[],
  limit = 50,
): string[] => {
  const visibleIds = new Set(projects.filter((project) => !project.hidden).map((project) => project.id));
  const next: string[] = [];
  for (const projectId of history) {
    if (!visibleIds.has(projectId) || next.includes(projectId)) continue;
    next.push(projectId);
    if (next.length >= limit) break;
  }
  return next;
};

export const recordProjectUsage = (
  history: string[],
  activeProjectId: string,
  projects: ProjectUsageCandidate[],
  limit = 50,
): string[] => {
  const visibleIds = new Set(projects.filter((project) => !project.hidden).map((project) => project.id));
  if (!visibleIds.has(activeProjectId)) return cleanProjectUsageHistory(history, projects, limit);
  return cleanProjectUsageHistory(
    [activeProjectId, ...history.filter((projectId) => projectId !== activeProjectId)],
    projects,
    limit,
  );
};

export const orderProjectsByUsage = (
  history: string[],
  projects: ProjectUsageCandidate[],
): string[] => {
  const visibleProjects = projects.filter((project) => !project.hidden);
  const visibleIds = new Set(visibleProjects.map((project) => project.id));
  const recentIds = cleanProjectUsageHistory(history, visibleProjects).filter((projectId) => visibleIds.has(projectId));
  return [
    ...recentIds,
    ...visibleProjects.map((project) => project.id).filter((projectId) => !recentIds.includes(projectId)),
  ];
};

export const getProjectIdByUsageDelta = (
  history: string[],
  projects: ProjectUsageCandidate[],
  activeProjectId: string | null,
  delta: number,
): string | null => {
  const orderedIds = orderProjectsByUsage(history, projects);
  if (orderedIds.length <= 1) return null;

  const currentIndex = activeProjectId ? orderedIds.indexOf(activeProjectId) : -1;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + delta + orderedIds.length) % orderedIds.length;
  return orderedIds[nextIndex] || null;
};
