// CHANGELOG.md → What's new sections. Pure: no React, no Tauri.
// Format: Keep a Changelog with Korean group headings (### 추가/변경/제거/수정/보안),
// see CHANGELOG.md and scripts/bump-version.mjs.

export type ChangeKind = '추가' | '변경' | '제거' | '수정' | '보안';

export const CHANGE_KINDS: readonly ChangeKind[] = ['추가', '변경', '제거', '수정', '보안'];

export interface ChangelogGroup {
  kind: ChangeKind;
  items: string[];
}

export interface ChangelogSection {
  version: string;
  date: string;
  groups: ChangelogGroup[];
}

const SECTION_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/;
const GROUP_RE = /^###\s+(.+?)\s*$/;
const LINK_REF_RE = /^\[[^\]]+\]:\s*\S+/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function isKind(s: string): s is ChangeKind {
  return (CHANGE_KINDS as readonly string[]).includes(s);
}

/** Parse released sections in file order. `[Unreleased]`, link references and
 *  unknown group headings are skipped; wrapped bullet lines are joined. */
export function parseChangelog(md: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let section: ChangelogSection | null = null;
  let group: ChangelogGroup | null = null;

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const sec = SECTION_RE.exec(line);
    if (sec) {
      group = null;
      const version = sec[1].trim();
      if (VERSION_RE.test(version)) {
        section = { version, date: sec[2] ?? '', groups: [] };
        out.push(section);
      } else {
        section = null; // [Unreleased] or anything that is not a release
      }
      continue;
    }
    if (LINK_REF_RE.test(line)) { group = null; continue; }
    if (!section) continue;

    const grp = GROUP_RE.exec(line);
    if (grp) {
      const kind = grp[1];
      if (isKind(kind)) {
        group = section.groups.find(g => g.kind === kind) ?? null;
        if (!group) { group = { kind, items: [] }; section.groups.push(group); }
      } else {
        group = null;
      }
      continue;
    }
    if (!group) continue;

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      group.items.push(bullet[1].trim());
    } else if (/^\s+\S/.test(line) && group.items.length > 0) {
      group.items[group.items.length - 1] += ' ' + line.trim();
    }
  }

  for (const s of out) s.groups = s.groups.filter(g => g.items.length > 0);
  return out;
}

/** Numeric x.y.z comparison; missing or non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Sections a user coming from `lastSeen` should see on `current`, newest first.
 *  lastSeen null → current version only. Sections without items are dropped. */
export function sectionsToShow(all: ChangelogSection[], lastSeen: string | null, current: string): ChangelogSection[] {
  const hasItems = (s: ChangelogSection) => s.groups.some(g => g.items.length > 0);
  const picked = all.filter(s => {
    if (!hasItems(s)) return false;
    if (lastSeen == null) return compareVersions(s.version, current) === 0;
    return compareVersions(s.version, lastSeen) > 0 && compareVersions(s.version, current) <= 0;
  });
  return picked.sort((a, b) => compareVersions(b.version, a.version));
}
