// CHANGELOG.md / CHANGELOG.en.md → What's new sections. Pure: no React, no Tauri.
// Format: Keep a Changelog with Korean (### 추가/변경/제거/수정/보안) or English
// (### Added/Changed/Removed/Fixed/Security) group headings; see scripts/bump-version.mjs.

/** Normalized group id; display labels come from t('guide.kind.<id>'). */
export type ChangeKind = 'added' | 'changed' | 'removed' | 'fixed' | 'security';

export const CHANGE_KINDS: readonly ChangeKind[] = ['added', 'changed', 'removed', 'fixed', 'security'];

const HEADING_KIND: Record<string, ChangeKind> = {
  추가: 'added', 변경: 'changed', 제거: 'removed', 수정: 'fixed', 보안: 'security',
  added: 'added', changed: 'changed', removed: 'removed', fixed: 'fixed', security: 'security',
};

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

function headingKind(s: string): ChangeKind | null {
  return HEADING_KIND[s.trim().toLowerCase()] ?? null;
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
      const kind = headingKind(grp[1]);
      if (kind) {
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

/** Released sections older than everything in `shown` (or at/below `current`
 *  when nothing is shown), newest first, at most `limit`. For the collapsed
 *  "earlier versions" list. */
export function olderSections(all: ChangelogSection[], shown: ChangelogSection[], limit: number, current?: string): ChangelogSection[] {
  const hasItems = (s: ChangelogSection) => s.groups.some(g => g.items.length > 0);
  const oldestShown = shown.reduce<string | null>((min, s) => (min == null || compareVersions(s.version, min) < 0 ? s.version : min), null);
  return all
    .filter(s => {
      if (!hasItems(s)) return false;
      if (oldestShown != null) return compareVersions(s.version, oldestShown) < 0;
      return current == null || compareVersions(s.version, current) <= 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, Math.max(0, limit));
}

export interface InlineToken {
  kind: 'text' | 'bold' | 'code';
  text: string;
}

/** Split a CHANGELOG item into plain text, **bold** and `code` runs. The page
 *  renders these as React nodes, so nothing in the text is ever parsed as HTML. */
export function inlineTokens(src: string): InlineToken[] {
  const out: InlineToken[] = [];
  const push = (kind: InlineToken['kind'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (kind === 'text' && last?.kind === 'text') last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < src.length) {
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) { push('code', src.slice(i + 1, end)); i = end + 1; continue; }
    } else if (src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) { push('bold', src.slice(i + 2, end)); i = end + 2; continue; }
    }
    // plain run up to the next marker candidate
    let j = i + 1;
    while (j < src.length && src[j] !== '`' && !src.startsWith('**', j)) j++;
    push('text', src.slice(i, j));
    i = j;
  }
  return out;
}

/** Sections in the reader's language: every version of `fallback` (the Korean
 *  CHANGELOG.md, the source of truth), taking the translated section when it
 *  exists and has items, else the fallback section. */
export function localizedSections(translated: ChangelogSection[], fallback: ChangelogSection[]): ChangelogSection[] {
  const byVersion = new Map(translated.map(s => [s.version, s]));
  return fallback.map((s) => {
    const t = byVersion.get(s.version);
    return t && t.groups.some(g => g.items.length > 0) ? t : s;
  });
}
