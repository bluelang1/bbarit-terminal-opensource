import { describe, expect, it } from 'vitest';
import { buildFileTreeMenu, type FileTreeMenuContext, type FileTreeMenuItem } from './fileTreeMenuModel';
import { buildChildPath } from './FileTreeItem';

const flat = (sections: FileTreeMenuItem[][]) => sections.flat();
const ids = (sections: FileTreeMenuItem[][]) => flat(sections).map((i) => i.id);
const find = (sections: FileTreeMenuItem[][], id: string) => flat(sections).find((i) => i.id === id);

const projectFile = (over: Partial<FileTreeMenuContext> = {}): FileTreeMenuContext => ({
  entry: { name: 'main.rs', is_dir: false },
  treeType: 'project',
  canOpenInSystem: true,
  hasCutOrCopyFile: false,
  ...over,
});

describe('buildFileTreeMenu', () => {
  it('orders sections: create → open → clipboard → path → danger', () => {
    const sections = buildFileTreeMenu(projectFile());
    expect(sections.map((s) => s.map((i) => i.id))).toEqual([
      ['newFile', 'newFolder'],
      ['openInSystem'],
      ['copy', 'cut', 'paste'],
      ['copyPath'],
      ['rename', 'delete'],
    ]);
  });

  it('includes optional items only when their handlers exist', () => {
    const sections = buildFileTreeMenu(projectFile({
      hasImportFiles: true, hasRunSkill: true, hasDuplicate: true, hasCopyRelativePath: true,
    }));
    expect(ids(sections)).toEqual([
      'newFile', 'newFolder', 'importFiles',
      'openInSystem', 'runSkill',
      'copy', 'cut', 'paste', 'duplicate',
      'copyPath', 'copyRelativePath',
      'rename', 'delete',
    ]);
  });

  it('disables entry-targeting items on root, keeps creation enabled', () => {
    const sections = buildFileTreeMenu(projectFile({ isRoot: true }));
    expect(find(sections, 'newFile')?.disabled).toBeFalsy();
    for (const id of ['copy', 'cut', 'rename', 'delete']) {
      expect(find(sections, id)?.disabled, id).toBe(true);
    }
  });

  it('disables copyPath and entry actions when clicking empty area (no entry)', () => {
    const sections = buildFileTreeMenu(projectFile({ entry: null }));
    expect(find(sections, 'copyPath')?.disabled).toBe(true);
    expect(find(sections, 'copy')?.disabled).toBe(true);
    expect(ids(sections)).not.toContain('copyToNotes');
  });

  it('enables paste only when the clipboard holds a cut/copied file', () => {
    expect(find(buildFileTreeMenu(projectFile()), 'paste')?.disabled).toBe(true);
    expect(find(buildFileTreeMenu(projectFile({ hasCutOrCopyFile: true })), 'paste')?.disabled).toBe(false);
  });

  it('disables openInSystem when not available', () => {
    const sections = buildFileTreeMenu(projectFile({ canOpenInSystem: false }));
    expect(find(sections, 'openInSystem')?.disabled).toBe(true);
  });

  it('offers copyToNotes for markdown files in the project tree', () => {
    const md = projectFile({ entry: { name: 'README.md', is_dir: false }, hasCopyToNotes: true });
    expect(find(buildFileTreeMenu(md), 'copyToNotes')?.disabled).toBe(false);
    expect(ids(buildFileTreeMenu(projectFile({ hasCopyToNotes: true })))).not.toContain('copyToNotes');
  });

  it('offers copyToNotes for multi-selection regardless of extension', () => {
    const sections = buildFileTreeMenu(projectFile({ multiSelectCount: 3, hasCopyToNotes: true }));
    expect(ids(sections)).toContain('copyToNotes');
  });

  it('replaces delete with deleteMultiple when multiple items are selected', () => {
    const sections = buildFileTreeMenu(projectFile({ multiSelectCount: 2, hasDeleteMultiple: true }));
    expect(ids(sections)).toContain('deleteMultiple');
    expect(ids(sections)).not.toContain('delete');
    // 핸들러가 없으면 단일 삭제로 폴백
    const fallback = buildFileTreeMenu(projectFile({ multiSelectCount: 2 }));
    expect(ids(fallback)).toContain('delete');
  });

  it('marks delete items as danger', () => {
    expect(find(buildFileTreeMenu(projectFile()), 'delete')?.danger).toBe(true);
    const multi = buildFileTreeMenu(projectFile({ multiSelectCount: 2, hasDeleteMultiple: true }));
    expect(find(multi, 'deleteMultiple')?.danger).toBe(true);
  });

  it('shows organizeNote in the notes tree, disabled for directories', () => {
    const note = projectFile({ treeType: 'notes', hasOrganizeNote: true });
    expect(find(buildFileTreeMenu(note), 'organizeNote')?.disabled).toBe(false);
    const dir = buildFileTreeMenu({ ...note, entry: { name: 'ideas', is_dir: true } });
    expect(find(dir, 'organizeNote')?.disabled).toBe(true);
  });

  it('lists note copy destinations instead of copyToProject when provided', () => {
    const sections = buildFileTreeMenu(projectFile({
      treeType: 'notes', noteCopyDestinationCount: 2, hasCopyToProject: true,
    }));
    const dests = flat(sections).filter((i) => i.id === 'noteDest');
    expect(dests.map((d) => d.destIndex)).toEqual([0, 1]);
    expect(ids(sections)).not.toContain('copyToProject');
  });

  it('falls back to copyToProject when destinations prop is absent', () => {
    const sections = buildFileTreeMenu(projectFile({ treeType: 'notes', hasCopyToProject: true }));
    expect(ids(sections)).toContain('copyToProject');
  });

  it('shows neither destinations nor copyToProject for an empty destination list', () => {
    const sections = buildFileTreeMenu(projectFile({
      treeType: 'notes', noteCopyDestinationCount: 0, hasCopyToProject: true,
    }));
    expect(ids(sections)).not.toContain('noteDest');
    expect(ids(sections)).not.toContain('copyToProject');
  });
});

describe('buildChildPath', () => {
  it('joins unix paths with a forward slash', () => {
    expect(buildChildPath('/Users/a/project', 'src')).toBe('/Users/a/project/src');
  });

  it('normalizes trailing separators on the parent', () => {
    expect(buildChildPath('/Users/a/project/', 'src')).toBe('/Users/a/project/src');
    expect(buildChildPath('/Users/a/project///', 'src')).toBe('/Users/a/project/src');
  });

  it('handles the filesystem root', () => {
    expect(buildChildPath('/', 'tmp')).toBe('/tmp');
  });

  it('uses backslash for windows paths and bare drive letters', () => {
    expect(buildChildPath('C:\\work\\repo', 'src')).toBe('C:\\work\\repo\\src');
    expect(buildChildPath('C:', 'work')).toBe('C:\\work');
  });

  it('appends to the remote part of ssh:// paths', () => {
    expect(buildChildPath('ssh://user@host::/srv/app', 'logs')).toBe('ssh://user@host::/srv/app/logs');
    expect(buildChildPath('ssh://user@host::/', 'srv')).toBe('ssh://user@host::/srv');
    expect(buildChildPath('ssh://user@host::', 'srv')).toBe('ssh://user@host::/srv');
  });

  it('strips leading separators from the child name', () => {
    expect(buildChildPath('/srv', '/app')).toBe('/srv/app');
  });

  it('returns the parent when the child name is empty', () => {
    expect(buildChildPath('/srv/app', '')).toBe('/srv/app');
  });
});
