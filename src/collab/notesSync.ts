/**
 * Collaborative note sync helpers.
 * - broadcastNoteChange: call after a local note is written/deleted to sync with peers
 * - listenRemoteNoteChanges: hook in App to receive remote changes (write_file / delete_path)
 */

import { invoke } from '@tauri-apps/api/core';
import { getCollabHandle } from './CollabPanel';

export interface NoteChangePayload {
  path: string;
  content?: string;   // present for create/update
  deleted?: boolean;  // true for deletion
}

let applyingRemote = false;

export function isApplyingRemoteNote(): boolean {
  return applyingRemote;
}

export function broadcastNoteChange(payload: NoteChangePayload): void {
  if (applyingRemote) return;
  const handle = getCollabHandle();
  if (!handle?.isConnected()) return;
  handle.sendChange('notes', payload);
}

/**
 * Subscribe to remote note changes. On change, write the file locally without re-broadcasting.
 * Returns an unsubscribe function. Also accepts an onAfterApply callback for UI refresh.
 */
export function listenRemoteNoteChanges(onAfterApply?: (payload: NoteChangePayload) => void): () => void {
  const handle = getCollabHandle();
  if (!handle) return () => {};
  return handle.subscribe(async (change) => {
    if (change.kind !== 'notes' || !change.payload) return;
    const payload = change.payload as NoteChangePayload;
    if (!payload.path) return;
    applyingRemote = true;
    try {
      if (payload.deleted) {
        await invoke('delete_path', { path: payload.path }).catch(() => {});
      } else if (typeof payload.content === 'string') {
        await invoke('write_file', { path: payload.path, content: payload.content }).catch(() => {});
      }
      onAfterApply?.(payload);
    } finally {
      applyingRemote = false;
    }
  });
}
