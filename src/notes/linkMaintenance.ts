/**
 * linkMaintenance.ts
 *
 * Vault-wide wikilink maintenance: when a note is renamed, rewrite every
 * [[oldName]] / [[oldName|alias]] / [[oldName#heading]] / ![[oldName]]
 * reference in other notes to point at the new name.
 */

import { invoke } from '@tauri-apps/api/core';
import type { NoteIndexEntry } from './noteState.ts';

const WIKILINK_REGEX = /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Rewrite all wikilinks in a single document that target `oldName`
 * so they target `newName` instead. Matching is case-insensitive on the
 * note-name part; heading, alias, and embed prefix are preserved.
 */
export function rewriteWikiLinks(
  content: string,
  oldName: string,
  newName: string,
): { content: string; count: number } {
  const oldLower = oldName.trim().toLowerCase();
  let count = 0;

  const next = content.replace(
    new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags),
    (whole, bang: string, rawTarget: string, alias: string | undefined) => {
      const hashIdx = rawTarget.indexOf('#');
      const namePart = (hashIdx === -1 ? rawTarget : rawTarget.slice(0, hashIdx)).trim();
      if (namePart.toLowerCase() !== oldLower) return whole;

      const headingPart = hashIdx === -1 ? '' : rawTarget.slice(hashIdx);
      const aliasPart = alias !== undefined ? `|${alias}` : '';
      count++;
      return `${bang}[[${newName}${headingPart}${aliasPart}]]`;
    },
  );

  return { content: next, count };
}

/**
 * After a note is renamed, rewrite links in every note that referenced the
 * old name. Reads and writes files via the Tauri backend.
 * Returns the paths of the notes whose content was updated.
 */
export async function updateVaultLinksAfterRename(
  noteIndex: NoteIndexEntry[],
  renamedPath: string,
  oldName: string,
  newName: string,
): Promise<string[]> {
  const oldLower = oldName.trim().toLowerCase();
  if (!oldLower || oldLower === newName.trim().toLowerCase()) return [];

  const candidates = noteIndex.filter(
    (e) =>
      e.path !== renamedPath &&
      e.outgoingLinks.some((l) => l.toLowerCase() === oldLower),
  );

  const updated: string[] = [];
  for (const entry of candidates) {
    try {
      const content = await invoke<string>('read_file', { path: entry.path });
      const { content: next, count } = rewriteWikiLinks(content, oldName, newName);
      if (count > 0 && next !== content) {
        await invoke('write_file', { path: entry.path, content: next });
        updated.push(entry.path);
      }
    } catch (err) {
      console.warn('[linkMaintenance] Failed to update links in', entry.path, err);
    }
  }
  return updated;
}
