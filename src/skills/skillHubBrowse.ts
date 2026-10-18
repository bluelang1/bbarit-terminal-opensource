/**
 * skillHubBrowse.ts
 *
 * Pure browse/search/sort/update-detection logic for the Skill Pack Hub,
 * plus localStorage-backed install metadata (installedAt, sourceUrl).
 * Kept free of React so it stays unit-testable.
 */

import type { Skill } from './types';
import type { RemoteSkillPackEntry } from './skillPackHub';

// ───────────────────────── Search ─────────────────────────

/** All searchable text of a single skill, lowercased. */
function skillHaystack(skill: Skill): string {
  return [
    skill.name,
    skill.description,
    skill.category,
    skill.cliType,
    ...(skill.tags || []),
  ].join(' ').toLowerCase();
}

function packHaystack(entry: RemoteSkillPackEntry): string {
  return [entry.name, entry.description || '', entry.version].join(' ').toLowerCase();
}

/**
 * AND-match every whitespace token against the pack itself or any of its
 * inline skills. Empty query matches everything.
 */
export function packMatchesQuery(entry: RemoteSkillPackEntry, query: string): boolean {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const packText = packHaystack(entry);
  const skillTexts = (entry.skills || []).map(skillHaystack);
  return tokens.every(token =>
    packText.includes(token) || skillTexts.some(text => text.includes(token)),
  );
}

/** Count skills inside a pack that match the query (for a "n matches" badge). */
export function matchingSkillCount(entry: RemoteSkillPackEntry, query: string): number {
  const tokens = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !entry.skills?.length) return 0;
  return entry.skills.filter(skill => {
    const text = skillHaystack(skill);
    return tokens.every(token => text.includes(token));
  }).length;
}

// ───────────────────────── Sort ─────────────────────────

export type PackSortMode = 'name' | 'skills' | 'installed';

export function sortPacks(
  packs: RemoteSkillPackEntry[],
  mode: PackSortMode,
  installedNames: Set<string>,
): RemoteSkillPackEntry[] {
  const sorted = [...packs];
  switch (mode) {
    case 'skills':
      sorted.sort((a, b) => (b.skillCount ?? b.skills?.length ?? 0) - (a.skillCount ?? a.skills?.length ?? 0));
      break;
    case 'installed':
      sorted.sort((a, b) => {
        const ai = installedNames.has(a.name) ? 0 : 1;
        const bi = installedNames.has(b.name) ? 0 : 1;
        return ai - bi || a.name.localeCompare(b.name);
      });
      break;
    case 'name':
    default:
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return sorted;
}

// ───────────────────────── Update detection ─────────────────────────

export interface InstalledPackRef {
  packName: string;
  packVersion: string;
}

/**
 * Map of installed pack name → manifest entry with a different version.
 * Any version difference counts as an available update (manifest wins).
 */
export function findPackUpdates(
  installed: InstalledPackRef[],
  packs: RemoteSkillPackEntry[],
): Map<string, RemoteSkillPackEntry> {
  const byName = new Map<string, RemoteSkillPackEntry>();
  for (const pack of packs) {
    if (!byName.has(pack.name)) byName.set(pack.name, pack);
  }
  const updates = new Map<string, RemoteSkillPackEntry>();
  for (const ref of installed) {
    const candidate = byName.get(ref.packName);
    if (candidate && candidate.version !== ref.packVersion) {
      updates.set(ref.packName, candidate);
    }
  }
  return updates;
}

// ───────────────────────── Safety aggregation ─────────────────────────

export interface SafetySummary {
  caution: number;
  dangerous: number;
}

export function aggregateSafety(skills?: Skill[]): SafetySummary {
  const summary: SafetySummary = { caution: 0, dangerous: 0 };
  for (const skill of skills || []) {
    if (skill.safetyLevel === 'caution') summary.caution += 1;
    else if (skill.safetyLevel === 'dangerous') summary.dangerous += 1;
  }
  return summary;
}

// ───────────────────────── Install metadata ─────────────────────────

export interface PackInstallMeta {
  installedAt: string;
  sourceUrl?: string;
}

const META_STORAGE_KEY = 'octo-skillpack-meta';

type MetaMap = Record<string, PackInstallMeta>;

export function packMetaKey(name: string, version: string): string {
  return `${name}@${version}`;
}

export function loadPackInstallMeta(): MetaMap {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: MetaMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === 'object' && typeof (value as PackInstallMeta).installedAt === 'string') {
        out[key] = value as PackInstallMeta;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveMeta(meta: MetaMap): void {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // storage unavailable — metadata stays session-only
  }
}

export function recordPackInstall(name: string, version: string, sourceUrl?: string): void {
  const meta = loadPackInstallMeta();
  // A newly installed version supersedes older versions of the same pack
  for (const key of Object.keys(meta)) {
    if (key.startsWith(`${name}@`)) delete meta[key];
  }
  meta[packMetaKey(name, version)] = {
    installedAt: new Date().toISOString(),
    sourceUrl: sourceUrl || undefined,
  };
  saveMeta(meta);
}

export function removePackInstallMeta(name: string, version: string): void {
  const meta = loadPackInstallMeta();
  delete meta[packMetaKey(name, version)];
  saveMeta(meta);
}

/** Short local-time YYYY-MM-DD for display; empty string if invalid. */
export function formatInstalledAt(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
