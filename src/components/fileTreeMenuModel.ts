/**
 * 파일 트리 컨텍스트 메뉴 모델 — 어떤 항목이 어떤 구역·순서로 보이고 언제
 * 비활성화되는지를 한 곳에서 결정한다. 아이콘·라벨·핸들러 매핑(렌더링)은
 * FileTreeContextMenu가 id 기준으로 담당한다.
 */

export type FileTreeMenuItemId =
  | 'newFile' | 'newFolder' | 'importFiles'
  | 'openInSystem' | 'runSkill'
  | 'copy' | 'cut' | 'paste' | 'duplicate'
  | 'copyPath' | 'copyRelativePath'
  | 'copyToNotes' | 'organizeNote' | 'noteDest' | 'copyToProject'
  | 'rename' | 'delete' | 'deleteMultiple';

export interface FileTreeMenuItem {
  id: FileTreeMenuItemId;
  disabled?: boolean;
  danger?: boolean;
  /** id === 'noteDest'일 때 noteCopyDestinations 인덱스 */
  destIndex?: number;
}

export interface FileTreeMenuContext {
  entry: { name: string; is_dir: boolean } | null;
  isRoot?: boolean;
  treeType?: 'project' | 'notes';
  hasCutOrCopyFile?: boolean;
  canOpenInSystem?: boolean;
  multiSelectCount?: number;
  /** undefined면 noteCopyDestinations prop 자체가 없는 것 — copyToProject로 폴백 */
  noteCopyDestinationCount?: number;
  hasImportFiles?: boolean;
  hasRunSkill?: boolean;
  hasDuplicate?: boolean;
  hasCopyRelativePath?: boolean;
  hasCopyToNotes?: boolean;
  hasOrganizeNote?: boolean;
  hasCopyToProject?: boolean;
  hasDeleteMultiple?: boolean;
}

/** 구역(section) 배열을 반환 — 구역 사이에 구분선을 그린다. */
export function buildFileTreeMenu(ctx: FileTreeMenuContext): FileTreeMenuItem[][] {
  const { entry, isRoot = false, treeType = 'project', multiSelectCount = 0 } = ctx;
  const canTargetEntry = !!entry && !isRoot;
  const sections: FileTreeMenuItem[][] = [];

  // 생성
  const create: FileTreeMenuItem[] = [{ id: 'newFile' }, { id: 'newFolder' }];
  if (ctx.hasImportFiles) create.push({ id: 'importFiles' });
  sections.push(create);

  // 열기/실행
  const open: FileTreeMenuItem[] = [{ id: 'openInSystem', disabled: !ctx.canOpenInSystem }];
  if (ctx.hasRunSkill) open.push({ id: 'runSkill' });
  sections.push(open);

  // 클립보드
  const clipboard: FileTreeMenuItem[] = [
    { id: 'copy', disabled: !canTargetEntry },
    { id: 'cut', disabled: !canTargetEntry },
    { id: 'paste', disabled: !ctx.hasCutOrCopyFile },
  ];
  if (ctx.hasDuplicate) clipboard.push({ id: 'duplicate', disabled: !canTargetEntry });
  sections.push(clipboard);

  // 경로 복사
  const path: FileTreeMenuItem[] = [{ id: 'copyPath', disabled: !entry }];
  if (ctx.hasCopyRelativePath) path.push({ id: 'copyRelativePath', disabled: !entry });
  sections.push(path);

  // 노트 ↔ 프로젝트 이동
  const transfer: FileTreeMenuItem[] = [];
  if (treeType === 'project' && (entry?.name.endsWith('.md') || multiSelectCount > 1)) {
    transfer.push({ id: 'copyToNotes', disabled: !ctx.hasCopyToNotes });
  }
  if (treeType === 'notes' && entry) {
    if (ctx.hasOrganizeNote) transfer.push({ id: 'organizeNote', disabled: entry.is_dir });
    const destCount = ctx.noteCopyDestinationCount;
    if (destCount !== undefined) {
      for (let i = 0; i < destCount; i += 1) transfer.push({ id: 'noteDest', destIndex: i });
    } else if (ctx.hasCopyToProject) {
      transfer.push({ id: 'copyToProject' });
    }
  }
  if (transfer.length) sections.push(transfer);

  // 이름 변경/삭제
  const danger: FileTreeMenuItem[] = [{ id: 'rename', disabled: !canTargetEntry }];
  danger.push(multiSelectCount > 1 && ctx.hasDeleteMultiple
    ? { id: 'deleteMultiple', danger: true }
    : { id: 'delete', danger: true, disabled: !canTargetEntry });
  sections.push(danger);

  return sections;
}
