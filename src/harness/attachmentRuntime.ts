import { invoke } from '@tauri-apps/api/core';

export interface RuntimeAttachment {
  id: string;
  name: string;
  type: 'image' | 'text';
  mimeType: string;
  dataUrl: string;
  size: number;
}

// Share the persistent reference folder used by BBARIT Motion. Unlike
// `.octo-tmp`, this survives packaging/release workflows and remains visible as
// part of the user's project assets.
const ATTACHMENT_DIRECTORY = 'bbarit-motion/refs';

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

export function sanitizeWorkspaceAttachmentName(name: string): string {
  const basename = name.split(/[\\/]/).pop() || 'attachment';
  const sanitized = basename
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return sanitized || 'attachment';
}

function attachmentRelativePath(attachment: RuntimeAttachment): string {
  const safeId = attachment.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'file';
  return `${ATTACHMENT_DIRECTORY}/${safeId}-${sanitizeWorkspaceAttachmentName(attachment.name)}`;
}

async function writeWorkspaceAttachment(
  attachment: RuntimeAttachment,
  workspace: string,
): Promise<string> {
  const relativePath = attachmentRelativePath(attachment);
  const fullPath = `${workspace}/${relativePath}`;
  if (attachment.type === 'image') {
    const base64Data = attachment.dataUrl.replace(/^data:[^;]+;base64,/, '');
    if (!base64Data) throw new Error(`Image attachment is empty: ${attachment.name}`);
    await invoke('write_file_base64', { path: fullPath, base64Data });
  } else {
    await invoke('write_file', { path: fullPath, content: attachment.dataUrl });
  }
  const exists = await invoke<boolean>('path_exists', { path: fullPath });
  if (!exists) throw new Error(`Attachment copy was not created: ${fullPath}`);
  return relativePath;
}

export async function persistWorkspaceAttachment(
  attachment: RuntimeAttachment,
  workDir: string,
): Promise<string> {
  const workspace = trimTrailingSeparators(workDir.trim()) || '.';
  if (/^(?:ssh|sftp):\/\//i.test(workspace)) {
    throw new Error('Cannot copy a local attachment into a remote workspace yet.');
  }
  await invoke('create_directory', { path: `${workspace}/${ATTACHMENT_DIRECTORY}` });
  return writeWorkspaceAttachment(attachment, workspace);
}

export async function copyImagePathToMotionRefs(
  sourcePath: string,
  workDir: string,
): Promise<string> {
  const workspace = trimTrailingSeparators(workDir.trim()) || '.';
  const normalizedSource = sourcePath.replace(/\\/g, '/');
  const refsDir = `${workspace}/${ATTACHMENT_DIRECTORY}`;
  if (normalizedSource.startsWith(`${refsDir}/`)) return normalizedSource;

  const name = sanitizeWorkspaceAttachmentName(normalizedSource);
  const path = `${refsDir}/${Date.now().toString(36)}-${name}`;
  const base64Data = await invoke<string>('read_file_base64', { path: sourcePath });
  if (!base64Data) throw new Error(`Image attachment is empty: ${sourcePath}`);
  await invoke('create_directory', { path: refsDir });
  await invoke('write_file_base64', { path, base64Data });
  const exists = await invoke<boolean>('path_exists', { path });
  if (!exists) throw new Error(`Attachment copy was not created: ${path}`);
  return path;
}

/**
 * Materialize every chat attachment inside the active project before an agent
 * turn starts. The agent receives workspace-relative paths, so CLI providers
 * and workspace-constrained tools can all read the same files.
 */
export async function buildWorkspaceAttachmentContext(
  attachments: RuntimeAttachment[],
  workDir: string,
): Promise<string> {
  if (attachments.length === 0) return '';

  const workspace = trimTrailingSeparators(workDir.trim()) || '.';
  if (/^(?:ssh|sftp):\/\//i.test(workspace)) {
    throw new Error('Cannot copy a local attachment into a remote workspace yet.');
  }

  await invoke('create_directory', { path: `${workspace}/${ATTACHMENT_DIRECTORY}` });

  const parts: string[] = [];
  for (const attachment of attachments) {
    const relativePath = await writeWorkspaceAttachment(attachment, workspace);
    if (attachment.type === 'image') {
      parts.push(`[Image: ${attachment.name}] copied into the workspace at ${relativePath}`);
    } else {
      parts.push(`[File: ${attachment.name}] copied into the workspace at ${relativePath}`);
    }
  }

  return parts.join('\n');
}
