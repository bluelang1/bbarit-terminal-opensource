import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTranslation, type Locale } from './i18n';

function sourceSection(file: string, startMarker: string, endMarker: string): string {
  const source = readFileSync(join(process.cwd(), file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const appSection = (start: string, end: string) => sourceSection('src/App.tsx', start, end);

describe('project GitHub account', () => {
  it('persists and restores Project.githubAccount', () => {
    const save = appSection('function saveProjects(', 'async function loadProjects(');
    expect(save).toContain('githubAccount: p.githubAccount || undefined');
    const load = appSection('async function loadProjects(', '\n}\n');
    expect(load).toContain("githubAccount: typeof p.githubAccount === 'string'");
  });

  it('passes the project account to create_shell as githubAccount', () => {
    const invoke = sourceSection('src/XTerminal.tsx', "await invoke('create_shell', {", '});');
    expect(invoke).toContain('githubAccount: githubAccountRef.current || undefined');
    const app = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app.match(/githubAccount=\{(activeProject|proj)\.githubAccount\}/g)?.length).toBe(6);
    expect(app).toContain('githubAccount={selProj?.githubAccount}');
  });

  it('edits an existing project in place instead of adding a new one', () => {
    const edit = appSection('if (editingProject) {', "const projectCategory: ProjectCategory = 'coding';");
    expect(edit).toContain('projectEditUpdates(editingProject, {');
    expect(edit).toContain('updateProject(editingProject.id, updates);');
    expect(edit).toContain('githubAccount: newProjectGithubAccount');
    expect(edit).toContain('styleIndex: newStyleIndex');
    expect(edit).toContain('fontIndex: newFontIndex');
    expect(edit).not.toContain('[...prev, newProject]');
    expect(edit).toContain('setShowNewProjectModal(false);');
  });

  it('opens the shared project modal from the sidebar pencil and the context menu', () => {
    const leftItem = appSection('const renderLeftProjectItem = ', 'const renderProjectThemePicker = ');
    expect(leftItem).toContain('className="project-selector-edit"');
    expect(leftItem).toContain('openEditProjectModal(project.id)');
    expect(leftItem).not.toContain('renderProjectThemePicker(project)');

    const menu = appSection('data-project-menu-action="edit"', '</div>');
    expect(menu).toContain('openEditProjectModal(pid)');

    const open = appSection('const openEditProjectModal = useCallback', '}, []);');
    expect(open).toContain('setNewStyleIndex(');
    expect(open).toContain('setNewFontIndex(');
    expect(open).toContain('setNewProjectGithubAccount(project.githubAccount || \'\')');
    expect(open).toContain('setEditingProjectId(project.id)');
    expect(open).toContain('setShowNewProjectModal(true)');
  });

  it('offers auto, every logged-in account and "none" in the modal', () => {
    const modal = appSection('const renderNewProjectModal = () => {', '{/* Bottom fixed buttons */}');
    expect(modal).toContain("newProjectMode === 'local' && (");
    expect(modal).toContain('<option value="">');
    expect(modal).toContain('githubAccountOptions.map((login) =>');
    expect(modal).toContain('<option value={GITHUB_ACCOUNT_NONE}>');
    expect(readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8')).toContain("import { GITHUB_ACCOUNT_NONE, projectEditUpdates, projectGithubAccountFor } from './projectEdit';");
  });

  it('restores the new-project theme and font after leaving edit mode', () => {
    const open = appSection('const openEditProjectModal = useCallback', '}, [newStyleIndex, newFontIndex]);');
    expect(open).toContain('preEditStyleFontRef.current = { styleIndex: newStyleIndex, fontIndex: newFontIndex };');
    const reset = appSection('if (showNewProjectModal || !editingProjectId) return;', '}, [showNewProjectModal, editingProjectId]);');
    expect(reset).toContain('setNewStyleIndex(saved.styleIndex);');
    expect(reset).toContain('setNewFontIndex(saved.fontIndex);');
  });

  it('localizes the new strings in every locale with placeholders intact', () => {
    const locales: Locale[] = ['en', 'ko', 'ja', 'zh', 'fr', 'de', 'it', 'es'];
    const keys = [
      'app.context.editProject',
      'app.project.editTitle',
      'app.project.editTooltip',
      'app.project.editPathNote',
      'app.project.githubAccount',
      'app.project.githubAuto',
      'app.project.githubAutoActive',
      'app.project.githubNone',
      'app.project.githubHint',
    ];
    for (const locale of locales) {
      for (const key of keys) {
        expect(getTranslation(locale, key as any)).not.toBe(key);
      }
      expect(getTranslation(locale, 'app.project.githubAutoDetected' as any)).toContain('{login}');
      expect(getTranslation(locale, 'app.project.githubNotLoggedIn' as any)).toContain('{login}');
      expect(getTranslation(locale, 'app.project.editDuplicatePath' as any)).toContain('{path}');
      expect(getTranslation(locale, 'app.project.githubHint' as any)).toContain('gh auth login');
    }
    expect(getTranslation('ko', 'app.context.editProject' as any)).toBe('프로젝트 수정');
    expect(getTranslation('ko', 'app.project.githubAccount' as any)).toBe('GitHub 계정');
  });
});
