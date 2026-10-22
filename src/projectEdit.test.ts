import { describe, expect, it } from 'vitest';
import { GITHUB_ACCOUNT_NONE, projectEditUpdates, projectGithubAccountFor } from './projectEdit';

const project = { workDir: '/work/repo', name: 'repo', displayName: 'Repo' };
const form = { path: '/work/repo', displayName: 'Repo', styleIndex: 2, fontIndex: 1, githubAccount: '' };

describe('projectEditUpdates', () => {
  it('keeps location and name when unchanged, always writes theme, font and account', () => {
    const { updates, displayName, workDirChanged } = projectEditUpdates(project, form);
    expect(workDirChanged).toBe(false);
    expect(displayName).toBe('Repo');
    expect(updates).toEqual({ styleIndex: 2, fontIndex: 1, githubAccount: undefined });
    expect('workDir' in updates).toBe(false);
    expect('name' in updates).toBe(false);
  });

  it('moves the project and renames it in place', () => {
    const { updates, workDirChanged } = projectEditUpdates(project, {
      ...form,
      path: '/work/other',
      displayName: '  Other  ',
      githubAccount: 'me-work',
    });
    expect(workDirChanged).toBe(true);
    expect(updates).toEqual({
      workDir: '/work/other',
      name: 'Other',
      displayName: 'Other',
      styleIndex: 2,
      fontIndex: 1,
      githubAccount: 'me-work',
    });
  });

  it('falls back to the current name when the field is cleared', () => {
    const { updates, displayName } = projectEditUpdates(project, { ...form, displayName: '   ' });
    expect(displayName).toBe('Repo');
    expect('displayName' in updates).toBe(false);
  });

  it('compares locations after normalization', () => {
    const { workDirChanged } = projectEditUpdates(
      { ...project, workDir: '/work/repo/' },
      form,
      (p) => p.replace(/\/+$/, ''),
    );
    expect(workDirChanged).toBe(false);
  });
});

describe('projectGithubAccountFor', () => {
  it('stores logins and "none", drops auto and SSH projects', () => {
    expect(projectGithubAccountFor('/work/repo', 'me')).toBe('me');
    expect(projectGithubAccountFor('/work/repo', GITHUB_ACCOUNT_NONE)).toBe('__none__');
    expect(projectGithubAccountFor('/work/repo', '')).toBeUndefined();
    expect(projectGithubAccountFor('ssh://u@h:22::/srv', 'me')).toBeUndefined();
  });
});
