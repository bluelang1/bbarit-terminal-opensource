import { describe, it, expect, beforeEach } from 'vitest';
import {
  packMatchesQuery,
  matchingSkillCount,
  sortPacks,
  findPackUpdates,
  aggregateSafety,
  loadPackInstallMeta,
  recordPackInstall,
  removePackInstallMeta,
  formatInstalledAt,
  packMetaKey,
} from './skillHubBrowse';
import type { RemoteSkillPackEntry } from './skillPackHub';
import type { Skill } from './types';

function makeSkill(partial: Partial<Skill> & { name: string }): Skill {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, '-'),
    description: '',
    emoji: '⚡',
    command: 'do something',
    cliType: 'claude',
    category: 'dev',
    ...partial,
  };
}

function makePack(partial: Partial<RemoteSkillPackEntry> & { name: string }): RemoteSkillPackEntry {
  return {
    version: '1.0.0',
    url: `octo://official/packs/${partial.name}`,
    ...partial,
  };
}

describe('packMatchesQuery', () => {
  const pack = makePack({
    name: 'react-patterns',
    description: 'React patterns and hooks',
    skills: [
      makeSkill({ name: 'Error Boundary', tags: ['resilience'] }),
      makeSkill({ name: 'Virtualized List', description: 'large datasets', category: 'react' }),
    ],
  });

  it('should_match_everything_on_empty_query', () => {
    expect(packMatchesQuery(pack, '')).toBe(true);
    expect(packMatchesQuery(pack, '   ')).toBe(true);
  });

  it('should_match_pack_name_and_description', () => {
    expect(packMatchesQuery(pack, 'react')).toBe(true);
    expect(packMatchesQuery(pack, 'HOOKS')).toBe(true);
  });

  it('should_match_inside_skill_fields', () => {
    expect(packMatchesQuery(pack, 'boundary')).toBe(true);
    expect(packMatchesQuery(pack, 'resilience')).toBe(true);
    expect(packMatchesQuery(pack, 'datasets')).toBe(true);
  });

  it('should_require_all_tokens', () => {
    expect(packMatchesQuery(pack, 'react boundary')).toBe(true);
    expect(packMatchesQuery(pack, 'react kubernetes')).toBe(false);
  });

  it('should_not_match_unrelated_query', () => {
    expect(packMatchesQuery(pack, 'terraform')).toBe(false);
  });
});

describe('matchingSkillCount', () => {
  const pack = makePack({
    name: 'mixed',
    skills: [
      makeSkill({ name: 'Docker Build', tags: ['docker'] }),
      makeSkill({ name: 'Docker Compose', tags: ['docker'] }),
      makeSkill({ name: 'K8s Deploy', tags: ['k8s'] }),
    ],
  });

  it('should_count_only_matching_skills', () => {
    expect(matchingSkillCount(pack, 'docker')).toBe(2);
    expect(matchingSkillCount(pack, 'k8s')).toBe(1);
  });

  it('should_return_zero_for_empty_query_or_no_skills', () => {
    expect(matchingSkillCount(pack, '')).toBe(0);
    expect(matchingSkillCount(makePack({ name: 'empty' }), 'docker')).toBe(0);
  });
});

describe('sortPacks', () => {
  const packs = [
    makePack({ name: 'zeta', skillCount: 3 }),
    makePack({ name: 'alpha', skillCount: 10 }),
    makePack({ name: 'mid', skillCount: 5 }),
  ];

  it('should_sort_by_name', () => {
    expect(sortPacks(packs, 'name', new Set()).map(p => p.name)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('should_sort_by_skill_count_desc', () => {
    expect(sortPacks(packs, 'skills', new Set()).map(p => p.name)).toEqual(['alpha', 'mid', 'zeta']);
    const withInline = [
      makePack({ name: 'a', skills: [makeSkill({ name: 's1' }), makeSkill({ name: 's2' })] }),
      makePack({ name: 'b', skillCount: 1 }),
    ];
    expect(sortPacks(withInline, 'skills', new Set()).map(p => p.name)).toEqual(['a', 'b']);
  });

  it('should_put_installed_first_then_alphabetical', () => {
    const result = sortPacks(packs, 'installed', new Set(['zeta']));
    expect(result.map(p => p.name)).toEqual(['zeta', 'alpha', 'mid']);
  });

  it('should_not_mutate_input', () => {
    const before = packs.map(p => p.name);
    sortPacks(packs, 'name', new Set());
    expect(packs.map(p => p.name)).toEqual(before);
  });
});

describe('findPackUpdates', () => {
  const manifest = [
    makePack({ name: 'react-patterns', version: '1.2.0' }),
    makePack({ name: 'docker-k8s', version: '1.0.0' }),
  ];

  it('should_detect_version_difference_as_update', () => {
    const updates = findPackUpdates(
      [{ packName: 'react-patterns', packVersion: '1.0.0' }],
      manifest,
    );
    expect(updates.get('react-patterns')?.version).toBe('1.2.0');
  });

  it('should_ignore_same_version_and_unknown_packs', () => {
    const updates = findPackUpdates(
      [
        { packName: 'docker-k8s', packVersion: '1.0.0' },
        { packName: 'not-in-manifest', packVersion: '9.9.9' },
      ],
      manifest,
    );
    expect(updates.size).toBe(0);
  });
});

describe('aggregateSafety', () => {
  it('should_count_caution_and_dangerous', () => {
    const skills = [
      makeSkill({ name: 'a', safetyLevel: 'safe' }),
      makeSkill({ name: 'b', safetyLevel: 'caution' }),
      makeSkill({ name: 'c', safetyLevel: 'caution' }),
      makeSkill({ name: 'd', safetyLevel: 'dangerous' }),
      makeSkill({ name: 'e' }),
    ];
    expect(aggregateSafety(skills)).toEqual({ caution: 2, dangerous: 1 });
  });

  it('should_return_zeros_for_undefined', () => {
    expect(aggregateSafety(undefined)).toEqual({ caution: 0, dangerous: 0 });
  });
});

describe('install metadata', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should_roundtrip_install_meta', () => {
    recordPackInstall('react-patterns', '1.0.0', 'https://github.com/x/y');
    const meta = loadPackInstallMeta();
    const entry = meta[packMetaKey('react-patterns', '1.0.0')];
    expect(entry).toBeDefined();
    expect(entry.sourceUrl).toBe('https://github.com/x/y');
    expect(formatInstalledAt(entry.installedAt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should_supersede_older_versions_of_same_pack', () => {
    recordPackInstall('react-patterns', '1.0.0');
    recordPackInstall('react-patterns', '1.2.0');
    const meta = loadPackInstallMeta();
    expect(meta[packMetaKey('react-patterns', '1.0.0')]).toBeUndefined();
    expect(meta[packMetaKey('react-patterns', '1.2.0')]).toBeDefined();
  });

  it('should_remove_meta_on_uninstall', () => {
    recordPackInstall('docker-k8s', '1.0.0');
    removePackInstallMeta('docker-k8s', '1.0.0');
    expect(loadPackInstallMeta()[packMetaKey('docker-k8s', '1.0.0')]).toBeUndefined();
  });

  it('should_survive_corrupt_storage', () => {
    localStorage.setItem('octo-skillpack-meta', '{not json');
    expect(loadPackInstallMeta()).toEqual({});
  });

  it('should_format_invalid_dates_as_empty', () => {
    expect(formatInstalledAt('garbage')).toBe('');
    expect(formatInstalledAt(undefined)).toBe('');
  });
});
