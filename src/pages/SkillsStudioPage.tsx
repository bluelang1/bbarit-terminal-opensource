import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  CloudDownload,
  Code2,
  Database,
  Download,
  ExternalLink,
  RefreshCcw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useSkills } from '../skills/useSkills';
import {
  loadRemoteSkillManifest,
  loadRemoteSkillPack,
  isGithubRepoUrl,
  parseGithubRepoUrl,
  filterPacksByRepo,
  crawlGithubRepoSkills,
  type RemoteSkillPackEntry,
} from '../skills/skillPackHub';
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
  type PackSortMode,
} from '../skills/skillHubBrowse';
import type { Skill } from '../skills/types';

import { useTranslation } from '../i18n';
import './SkillsStudioPage.css';

const OFFICIAL_MANIFEST_URL = '/skills-hub/famous-skills-manifest.json';
const COMPANY_MANIFEST_PLACEHOLDER = 'https://raw.githubusercontent.com/<org>/<repo>/main/skills-hub/famous-skills-manifest.json';

type ManifestPresetId = string;

const MANIFEST_PRESETS: Array<{ id: ManifestPresetId; label: string; description: string; url?: string; stars?: string }> = [
  { id: 'official', label: 'Octo Official', description: 'Built-in list of popular skill JSONs' },
  { id: 'anthropics', label: '⭐ Anthropic Official', description: 'anthropics/skills — official Agent Skills (79k+ stars)', url: 'https://github.com/anthropics/skills', stars: '79.3k' },
  { id: 'superpowers', label: '⭐ Superpowers', description: 'obra/superpowers — 20+ skills incl. TDD, debugging, brainstorming (65k+ stars)', url: 'https://github.com/obra/superpowers', stars: '65.6k' },
  { id: 'everything', label: '⭐ Everything Claude', description: 'affaan-m/everything-claude-code — 56+ domain skills + 13 subagents (54k+ stars)', url: 'https://github.com/affaan-m/everything-claude-code', stars: '54.5k' },
  { id: 'mengto', label: '🎨 Meng To Design', description: 'MengTo/Skills — 121 design & build skills: shadows, glass UI, landing pages, motion, Three.js (3.6k+ stars)', url: 'https://github.com/MengTo/Skills', stars: '3.6k' },
  { id: 'composio', label: 'Composio Skills', description: 'ComposioHQ/awesome-claude-skills — 78+ workflow skills, Slack/GitHub/Notion integrations (38k+ stars)', url: 'https://github.com/ComposioHQ/awesome-claude-skills', stars: '38.7k' },
  { id: 'voltagent', label: 'VoltAgent Skills', description: 'VoltAgent/awesome-agent-skills — 380+ official skills incl. Vercel, Cloudflare, Stripe, Sentry (8.6k+ stars)', url: 'https://github.com/VoltAgent/awesome-agent-skills', stars: '8.6k' },
  { id: 'scientific', label: 'Scientific Skills', description: 'K-Dense-AI/claude-scientific-skills — 148+ science skills incl. biology, chemistry, medicine (9.7k+ stars)', url: 'https://github.com/K-Dense-AI/claude-scientific-skills', stars: '9.7k' },
  { id: 'antfu', label: 'Anthony Fu Skills', description: 'antfu/skills — Vue, Nuxt, Vite, Vitest, UnoCSS ecosystem skills (3.7k+ stars)', url: 'https://github.com/antfu/skills', stars: '3.7k' },
  { id: 'trailofbits', label: 'Trail of Bits', description: 'trailofbits/skills — 40+ skills incl. security audit, smart contracts, reverse engineering (3k+ stars)', url: 'https://github.com/trailofbits/skills', stars: '3k' },
  { id: 'microsoft', label: 'Microsoft Skills', description: 'microsoft/skills — 131 skills for Azure SDK, Python/Java/.NET/TypeScript (1.5k+ stars)', url: 'https://github.com/microsoft/skills', stars: '1.5k' },
  { id: 'vercel' as ManifestPresetId, label: 'Vercel Skills', description: 'vercel/skills — official Next.js and Vercel Platform skills', url: 'https://github.com/vercel/skills', stars: '2k+' },
  { id: 'cloudflare' as ManifestPresetId, label: 'Cloudflare Skills', description: 'cloudflare/skills — official Cloudflare skills incl. Workers, R2, D1, KV', url: 'https://github.com/cloudflare/skills', stars: '1k+' },
  { id: 'supabase' as ManifestPresetId, label: 'Supabase Skills', description: 'supabase/skills — official Supabase Auth, DB, Storage skills', url: 'https://github.com/supabase/skills', stars: '1k+' },
  { id: 'stripe' as ManifestPresetId, label: 'Stripe Skills', description: 'stripe/skills — official Stripe API, payments, subscriptions skills', url: 'https://github.com/stripe/skills', stars: '800+' },
  { id: 'expo' as ManifestPresetId, label: 'Expo Skills', description: 'expo/skills — official React Native + Expo SDK skills', url: 'https://github.com/expo/skills', stars: '700+' },
  { id: 'sentry' as ManifestPresetId, label: 'Sentry Skills', description: 'getsentry/skills — official Sentry skills for error tracking and performance monitoring', url: 'https://github.com/getsentry/skills', stars: '500+' },
  { id: 'huggingface' as ManifestPresetId, label: 'Hugging Face', description: 'huggingface/skills — AI/ML, Transformers, Datasets skills', url: 'https://github.com/huggingface/skills', stars: '600+' },
  { id: 'antigravity' as ManifestPresetId, label: 'Antigravity 954+', description: 'sickn33/antigravity-awesome-skills — 954+ large-scale skill collection (17k+ stars)', url: 'https://github.com/sickn33/antigravity-awesome-skills', stars: '17k' },
  { id: 'wshobson' as ManifestPresetId, label: 'Agents 146+', description: 'wshobson/agents — 112 agents + 146 skills for multi-agent orchestration (29k+ stars)', url: 'https://github.com/wshobson/agents', stars: '29.7k' },
  { id: 'openclaw' as ManifestPresetId, label: 'OpenClaw 5400+', description: 'VoltAgent/awesome-openclaw-skills — 5400+ skills from the OpenClaw registry (22k+ stars)', url: 'https://github.com/VoltAgent/awesome-openclaw-skills', stars: '22.7k' },
  { id: 'company', label: 'Company Private', description: 'Private company/team repository' },
  { id: 'custom', label: 'Custom URL', description: 'Enter any URL directly' },
];

const SKILLS_STUDIO_THEME = {
  bg: '#0b1220',
  text: '#f4f8ff',
  accent: '#39b8ff',
  muted: '#c8d8ef',
};

type SkillPackMeta = {
  packName: string;
  packVersion: string;
  installedSkillCount: number;
};

function packKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function externalPackUrl(entry: RemoteSkillPackEntry): string | null {
  const candidate = entry.sourceUrl || entry.url || '';
  return /^https?:\/\//i.test(candidate) ? candidate : null;
}

function safetyBadgeClass(level: Skill['safetyLevel']): string {
  if (level === 'dangerous') return 'safety-dangerous';
  if (level === 'caution') return 'safety-caution';
  return '';
}

export default function SkillsStudioPage() {
  const { t } = useTranslation();
  const { skills, batchUpdate, exportSkills, importSkills } = useSkills();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [manifestPreset, setManifestPreset] = useState<ManifestPresetId>('official');
  const [manifestUrl, setManifestUrl] = useState(OFFICIAL_MANIFEST_URL);
  const [manifestSchemaVersion, setManifestSchemaVersion] = useState('');
  const [remotePacks, setRemotePacks] = useState<RemoteSkillPackEntry[]>([]);
  const [packError, setPackError] = useState('');
  const [packStatus, setPackStatus] = useState('');
  const [manifestLoading, setManifestLoading] = useState(false);
  const [installingPack, setInstallingPack] = useState<string | null>(null);
  const [removingPack, setRemovingPack] = useState<string | null>(null);

  // Browse controls
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<PackSortMode>('name');
  const [installedOnly, setInstalledOnly] = useState(false);

  // Pack preview modal
  const [previewPack, setPreviewPack] = useState<RemoteSkillPackEntry | null>(null);
  const [previewSkills, setPreviewSkills] = useState<Skill[] | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [selectedSkillIdx, setSelectedSkillIdx] = useState<Set<number>>(new Set());

  // Install metadata (installedAt / sourceUrl), persisted in localStorage
  const [installMeta, setInstallMeta] = useState(() => loadPackInstallMeta());

  const installedPacks = useMemo(() => {
    const grouped = new Map<string, SkillPackMeta>();
    for (const skill of skills) {
      const sourcePack = String(skill.sourcePack || '').trim();
      if (!sourcePack) continue;
      const idx = sourcePack.lastIndexOf('@');
      if (idx <= 0) continue;
      const packName = sourcePack.slice(0, idx);
      const packVersion = sourcePack.slice(idx + 1);
      if (!packName || !packVersion) continue;
      const key = packKey(packName, packVersion);
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, { packName, packVersion, installedSkillCount: 1 });
      } else {
        existing.installedSkillCount += 1;
        grouped.set(key, existing);
      }
    }
    return Array.from(grouped.values()).sort((a, b) => a.packName.localeCompare(b.packName));
  }, [skills]);

  const installedKeySet = useMemo(() => new Set(installedPacks.map((p) => packKey(p.packName, p.packVersion))), [installedPacks]);
  const installedNameSet = useMemo(() => new Set(installedPacks.map((p) => p.packName)), [installedPacks]);

  // Manifest packs offering a different version than the installed one
  const packUpdates = useMemo(
    () => findPackUpdates(installedPacks, remotePacks),
    [installedPacks, remotePacks],
  );

  const visiblePacks = useMemo(() => {
    let list = remotePacks.filter((entry) => packMatchesQuery(entry, searchQuery));
    if (installedOnly) list = list.filter((entry) => installedNameSet.has(entry.name));
    return sortPacks(list, sortMode, installedNameSet);
  }, [remotePacks, searchQuery, installedOnly, sortMode, installedNameSet]);

  useEffect(() => {
    const preset = MANIFEST_PRESETS.find((p) => p.id === manifestPreset);
    if (preset?.url) {
      setManifestUrl(preset.url);
    } else if (manifestPreset === 'official') {
      setManifestUrl(OFFICIAL_MANIFEST_URL);
    } else if (manifestPreset === 'company') {
      setManifestUrl(COMPANY_MANIFEST_PLACEHOLDER);
    } else if (manifestPreset === 'custom' && (manifestUrl === OFFICIAL_MANIFEST_URL || manifestUrl === COMPANY_MANIFEST_PLACEHOLDER)) {
      setManifestUrl('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestPreset]);

  const handleManifestPresetChange = (nextPreset: ManifestPresetId) => {
    setManifestPreset(nextPreset);
    const preset = MANIFEST_PRESETS.find((p) => p.id === nextPreset);
    if (preset?.url) {
      setManifestUrl(preset.url);
    } else if (nextPreset === 'official') {
      setManifestUrl(OFFICIAL_MANIFEST_URL);
    } else if (nextPreset === 'company') {
      setManifestUrl(COMPANY_MANIFEST_PLACEHOLDER);
    } else if (manifestUrl === OFFICIAL_MANIFEST_URL || manifestUrl === COMPANY_MANIFEST_PLACEHOLDER) {
      setManifestUrl('');
    }
  };

  const handleManifestUrlChange = (value: string) => {
    setManifestUrl(value);
  };

  const closeWindow = () => {
    getCurrentWindow().close().catch(() => {
      window.close();
    });
  };

  const handleExport = () => {
    const json = exportSkills();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'octo-skills-user.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importSkills(String(reader.result || '[]'));
      } catch (err) {
        console.error('[skills-studio] import failed:', err);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleLoadManifest = async (urlOverride?: string) => {
    const url = (urlOverride ?? manifestUrl).trim();
    if (!url) {
      setPackError(t('skills.studio.urlRequired'));
      return;
    }
    setManifestLoading(true);
    setPackError('');
    setPackStatus('');
    try {
      // GitHub 저장소 URL인 경우 (JSON 매니페스트가 아닌 경우)
      if (isGithubRepoUrl(url)) {
        const repo = parseGithubRepoUrl(url);
        const label = repo ? `${repo.owner}/${repo.repo}` : url;

        // 1단계: 로컬 매니페스트에서 해당 저장소 팩 검색
        setPackStatus(t('skills.studio.searchingLocal').replace('{label}', label));
        try {
          const localManifest = await loadRemoteSkillManifest(OFFICIAL_MANIFEST_URL);
          const filtered = filterPacksByRepo(localManifest.packs, url);
          if (filtered.length > 0) {
            const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
            setRemotePacks(sorted);
            setManifestSchemaVersion(localManifest.schemaVersion || '');
            setPackStatus(t('skills.studio.packsFromLocal').replace('{label}', label).replace('{count}', String(sorted.length)));
            return;
          }
        } catch { /* local manifest failed, try remote crawl */ }

        // 2단계: GitHub API로 SKILL.md 크롤링
        setPackStatus(t('skills.studio.scanningGithub').replace('{label}', label));
        const manifest = await crawlGithubRepoSkills(url, (done, total) => {
          setPackStatus(t('skills.studio.loadingSkillMd').replace('{label}', label).replace('{done}', String(done)).replace('{total}', String(total)));
        });
        if (manifest.packs.length > 0) {
          const allSkills = manifest.packs.reduce((n, p) => n + (p.skillCount || 0), 0);
          setRemotePacks(manifest.packs);
          setManifestSchemaVersion('github-crawl');
          setPackStatus(t('skills.studio.skillsFromGithub').replace('{label}', label).replace('{count}', String(allSkills)));
        } else {
          setPackError(t('skills.studio.noSkillMdFound').replace('{label}', label));
        }
        return;
      }

      // 기본: JSON 매니페스트로 로드
      const manifest = await loadRemoteSkillManifest(url);
      const sorted = [...manifest.packs].sort((a, b) => a.name.localeCompare(b.name));
      setRemotePacks(sorted);
      setManifestSchemaVersion(manifest.schemaVersion || '');
      setPackStatus(t('skills.studio.manifestLoaded').replace('{count}', String(sorted.length)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPackError(message);
    } finally {
      setManifestLoading(false);
    }
  };

  // Load the official manifest right away so the hub is never empty
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    void handleLoadManifest(OFFICIAL_MANIFEST_URL);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstallPack = async (entry: RemoteSkillPackEntry, onlySkills?: Skill[]) => {
    const key = packKey(entry.name, entry.version);
    setInstallingPack(key);
    setPackError('');
    setPackStatus(t('skills.studio.downloadingPack').replace('{pack}', `${entry.name}@${entry.version}`));
    try {
      const skillsFromPack = onlySkills ?? await loadRemoteSkillPack(entry);
      const sourcePack = `${entry.name}@${entry.version}`;
      const packPrefix = `${entry.name}@`;

      const dedupKey = (skill: { name: string; command: string; cliType: string }) =>
        `${skill.name}::${skill.cliType}::${skill.command}`;

      // Counts for the status message, computed against the current snapshot —
      // the batchUpdate updater runs later (React defers it), so counting
      // inside it would always report 0 here.
      let inserted = 0;
      let skipped = 0;
      {
        const base = skills.filter((s) => !String(s.sourcePack || '').startsWith(packPrefix));
        const seen = new Set(base.map((s) => dedupKey(s)));
        for (const skill of skillsFromPack) {
          const keyOfSkill = dedupKey(skill);
          if (seen.has(keyOfSkill)) {
            skipped += 1;
          } else {
            seen.add(keyOfSkill);
            inserted += 1;
          }
        }
      }

      batchUpdate((prev) => {
        // Remove every previously installed version of this pack (update semantics)
        const next = prev.filter((s) => !String(s.sourcePack || '').startsWith(packPrefix));
        const existing = new Set(next.map((s) => dedupKey(s)));
        const usedIds = new Set(next.map((s) => s.id));

        for (const skill of skillsFromPack) {
          const keyOfSkill = dedupKey(skill);
          if (existing.has(keyOfSkill)) {
            continue;
          }
          existing.add(keyOfSkill);

          let baseId = skill.name.trim().toLowerCase()
            .replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, '-')
            .replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || `skill-${Date.now()}`;
          while (usedIds.has(baseId)) baseId = `${baseId}-${Math.random().toString(36).slice(2, 6)}`;
          usedIds.add(baseId);

          next.push({
            id: baseId,
            name: skill.name,
            description: skill.description,
            emoji: skill.emoji,
            command: skill.command,
            cliType: skill.cliType,
            category: skill.category,
            tags: skill.tags || [],
            builtIn: false,
            model: skill.model,
            sourcePack,
            sourceUrl: skill.sourceUrl,
            originalName: skill.originalName,
            originalCommand: skill.originalCommand,
            originalDescription: skill.originalDescription,
            allowedTools: skill.allowedTools,
            whenToUse: skill.whenToUse,
            disableModelInvocation: skill.disableModelInvocation,
            paths: skill.paths,
            priority: skill.priority,
            safetyLevel: skill.safetyLevel,
            safetyReasons: skill.safetyReasons,
            trustLevel: skill.trustLevel,
          });
        }
        return next;
      });

      recordPackInstall(entry.name, entry.version, externalPackUrl(entry) || undefined);
      setInstallMeta(loadPackInstallMeta());
      setPackStatus(t('skills.studio.installDone').replace('{pack}', `${entry.name}@${entry.version}`).replace('{inserted}', String(inserted)).replace('{skipped}', String(skipped)));
    } catch (err) {
      setPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingPack(null);
    }
  };

  const handleRemovePack = (packName: string, packVersion: string) => {
    const sourcePack = `${packName}@${packVersion}`;
    setRemovingPack(sourcePack);
    setPackError('');
    try {
      // Counted from the current snapshot — the updater below runs deferred
      const removedCount = skills.filter((s) => s.sourcePack === sourcePack).length;
      batchUpdate((prev) => prev.filter((s) => s.sourcePack !== sourcePack));
      removePackInstallMeta(packName, packVersion);
      setInstallMeta(loadPackInstallMeta());
      setPackStatus(t('skills.studio.removeDone').replace('{pack}', sourcePack).replace('{count}', String(removedCount)));
    } catch (err) {
      setPackError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingPack(null);
    }
  };

  // ── Pack preview ──
  const openPreview = (entry: RemoteSkillPackEntry) => {
    setPreviewPack(entry);
    setPreviewError('');
    if (Array.isArray(entry.skills) && entry.skills.length > 0) {
      setPreviewSkills(entry.skills);
      setSelectedSkillIdx(new Set(entry.skills.map((_, i) => i)));
      return;
    }
    setPreviewSkills(null);
    void loadRemoteSkillPack(entry)
      .then((loaded) => {
        setPreviewSkills(loaded);
        setSelectedSkillIdx(new Set(loaded.map((_, i) => i)));
      })
      .catch((err) => {
        setPreviewError(err instanceof Error ? err.message : String(err));
        setPreviewSkills([]);
      });
  };

  const closePreview = () => {
    setPreviewPack(null);
    setPreviewSkills(null);
    setPreviewError('');
    setSelectedSkillIdx(new Set());
  };

  useEffect(() => {
    if (!previewPack) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [previewPack]);

  const toggleSkillIdx = (idx: number) => {
    setSelectedSkillIdx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!previewSkills) return;
    setSelectedSkillIdx((prev) =>
      prev.size === previewSkills.length ? new Set() : new Set(previewSkills.map((_, i) => i)));
  };

  const handleInstallSelected = async () => {
    if (!previewPack || !previewSkills) return;
    const chosen = previewSkills.filter((_, i) => selectedSkillIdx.has(i));
    if (chosen.length === 0) return;
    await handleInstallPack(previewPack, chosen);
    closePreview();
  };

  const previewSafety = useMemo(() => aggregateSafety(previewSkills || undefined), [previewSkills]);

  const renderPackActionButton = (entry: RemoteSkillPackEntry) => {
    const key = packKey(entry.name, entry.version);
    const isInstalling = installingPack === key;
    const sameVersion = installedKeySet.has(key);
    const hasUpdate = packUpdates.get(entry.name)?.version === entry.version;
    const label = isInstalling ? '...'
      : hasUpdate ? 'Update'
        : sameVersion ? t('skills.studio.reinstall')
          : t('skills.studio.install');
    return (
      <button
        type="button"
        className={hasUpdate ? 'update' : undefined}
        onClick={(e) => { e.stopPropagation(); void handleInstallPack(entry); }}
        disabled={isInstalling}
      >
        <Download size={11} /> {label}
      </button>
    );
  };

  return (
    <div
      className="skills-studio-page"
      style={{
        '--ss-bg': SKILLS_STUDIO_THEME.bg,
        '--ss-text': SKILLS_STUDIO_THEME.text,
        '--ss-accent': SKILLS_STUDIO_THEME.accent,
        '--ss-muted': SKILLS_STUDIO_THEME.muted,
      } as React.CSSProperties}
    >
      <header className="skills-studio-header">
        <div className="skills-studio-title">
          <Code2 size={16} />
          <h1>{t('skills.studio.title')}</h1>
          <span className="skills-studio-badge">{t('skills.studio.subtitle')}</span>
        </div>
        <div className="skills-studio-actions">
          <button type="button" onClick={() => fileInputRef.current?.click()} title={t('skills.studio.importTitle')}>
            <Upload size={14} /> {t('skills.studio.import')}
          </button>
          <button type="button" onClick={handleExport} title={t('skills.studio.exportTitle')}>
            <Download size={14} /> {t('skills.export')}
          </button>
          <button type="button" className="danger" onClick={closeWindow} title={t('skills.studio.closeWindow')}>
            <X size={14} />
          </button>
        </div>
      </header>

      <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />

      <main className="skills-studio-main">
        <section className="skills-pack-hub">
          <div className="skills-pack-hub-head">
            <div className="skills-pack-hub-title">
              <Database size={15} />
              <h2>{t('skills.studio.subtitle')}</h2>
              {manifestSchemaVersion && <span>schema {manifestSchemaVersion}</span>}
            </div>
            <div className="skills-pack-hub-actions">
              <button type="button" className="ghost" onClick={() => void handleLoadManifest()} disabled={manifestLoading}>
                <RefreshCcw size={13} /> {t('settings.common.refresh')}
              </button>
            </div>
          </div>

          <div className="skills-pack-manifest-form">
            <select
              value={manifestPreset}
              onChange={(e) => handleManifestPresetChange(e.target.value as ManifestPresetId)}
            >
              {MANIFEST_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}{preset.stars ? ` (${preset.stars})` : ''}
                </option>
              ))}
            </select>
            <input
              value={manifestUrl}
              onChange={(e) => handleManifestUrlChange(e.target.value)}
              placeholder={t('skills.studio.manifestUrlPlaceholder')}
            />
            <button type="button" onClick={() => void handleLoadManifest()} disabled={manifestLoading}>
              <CloudDownload size={13} /> {manifestLoading ? t('settings.common.loading') : t('skills.studio.loadManifest')}
            </button>
          </div>
          <p className="skills-pack-note">
            {MANIFEST_PRESETS.find((preset) => preset.id === manifestPreset)?.description}
          </p>

          {packStatus && <p className="skills-pack-status">{packStatus}</p>}
          {packError && <p className="skills-pack-error">{packError}</p>}
          <p className="skills-pack-note">
            {t('skills.studio.manifestNote')}
          </p>

          {/* ── Browse toolbar: search / sort / installed filter ── */}
          {remotePacks.length > 0 && (
            <div className="skills-pack-toolbar">
              <div className="skills-pack-search">
                <Search size={12} />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search packs & skills..."
                />
                {searchQuery && (
                  <button type="button" onClick={() => setSearchQuery('')} title="Clear search">
                    <X size={11} />
                  </button>
                )}
              </div>
              <select value={sortMode} onChange={(e) => setSortMode(e.target.value as PackSortMode)} title="Sort packs">
                <option value="name">Sort: Name</option>
                <option value="skills">Sort: Most skills</option>
                <option value="installed">Sort: Installed first</option>
              </select>
              <button
                type="button"
                className={`skills-pack-filter-toggle ${installedOnly ? 'active' : ''}`}
                onClick={() => setInstalledOnly((v) => !v)}
              >
                Installed only
              </button>
              {packUpdates.size > 0 && (
                <span className="skills-pack-update-count">{packUpdates.size} update{packUpdates.size > 1 ? 's' : ''} available</span>
              )}
            </div>
          )}

          {/* ── 매니페스트 팩: 정사각형 그리드 ── */}
          {visiblePacks.length > 0 && (
            <>
              <div className="skills-pack-list-head">
                <h3>{t('skills.studio.manifestPacks')}</h3>
                <span>{visiblePacks.length}{visiblePacks.length !== remotePacks.length ? ` / ${remotePacks.length}` : ''}</span>
              </div>
              <div className="skills-pack-card-grid">
                {visiblePacks.map((entry) => {
                  const key = packKey(entry.name, entry.version);
                  const sameVersion = installedKeySet.has(key);
                  const hasUpdate = packUpdates.get(entry.name)?.version === entry.version;
                  const matchCount = searchQuery ? matchingSkillCount(entry, searchQuery) : 0;
                  const sourceLink = externalPackUrl(entry);
                  return (
                    <div
                      key={`${entry.name}@${entry.version}`}
                      className={`skills-pack-card clickable ${sameVersion ? 'installed' : ''} ${hasUpdate ? 'has-update' : ''}`}
                      onClick={() => openPreview(entry)}
                      title="Preview skills in this pack"
                    >
                      <div className="skills-pack-card-top">
                        <strong>{entry.name}</strong>
                        <em>{entry.version}</em>
                      </div>
                      {entry.description && <p className="skills-pack-card-desc">{entry.description}</p>}
                      <div className="skills-pack-card-bottom">
                        <code>{t('skills.studio.skillCount').replace('{count}', String(entry.skillCount ?? entry.skills?.length ?? '-'))}</code>
                        {matchCount > 0 && <code className="match-badge">{matchCount} match</code>}
                        {sameVersion && <code className="installed-badge">{t('skills.installed')}</code>}
                        {hasUpdate && <code className="update-badge">new</code>}
                        {sourceLink && (
                          <button
                            type="button"
                            className="link-btn"
                            title={sourceLink}
                            onClick={(e) => { e.stopPropagation(); window.open(sourceLink, '_blank'); }}
                          >
                            <ExternalLink size={10} />
                          </button>
                        )}
                        {renderPackActionButton(entry)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {remotePacks.length > 0 && visiblePacks.length === 0 && (
            <p className="skills-pack-empty">No packs match the current search/filter.</p>
          )}
          {!remotePacks.length && <p className="skills-pack-empty">{t('skills.studio.emptyHint')}</p>}

          {/* ── 설치된 팩 ── */}
          {installedPacks.length > 0 && (
            <>
              <div className="skills-pack-list-head" style={{ marginTop: 8 }}>
                <h3>{t('skills.studio.installedPacks')}</h3>
                <span>{installedPacks.length}</span>
              </div>
              <div className="skills-pack-card-grid">
                {installedPacks.map((pack) => {
                  const key = packKey(pack.packName, pack.packVersion);
                  const isRemoving = removingPack === key;
                  const meta = installMeta[packMetaKey(pack.packName, pack.packVersion)];
                  const installedDate = formatInstalledAt(meta?.installedAt);
                  const update = packUpdates.get(pack.packName);
                  const isUpdating = update ? installingPack === packKey(update.name, update.version) : false;
                  return (
                    <div key={key} className={`skills-pack-card installed ${update ? 'has-update' : ''}`}>
                      <div className="skills-pack-card-top">
                        <strong>{pack.packName}</strong>
                        <em>{pack.packVersion}</em>
                      </div>
                      {update && (
                        <p className="skills-pack-card-desc update-hint">
                          Update available: {update.version}
                        </p>
                      )}
                      <div className="skills-pack-card-bottom">
                        <code>{t('skills.studio.skillCount').replace('{count}', String(pack.installedSkillCount))}</code>
                        {installedDate && <code title={meta?.installedAt}>{installedDate}</code>}
                        {meta?.sourceUrl && (
                          <button
                            type="button"
                            className="link-btn"
                            title={meta.sourceUrl}
                            onClick={() => window.open(meta.sourceUrl, '_blank')}
                          >
                            <ExternalLink size={10} />
                          </button>
                        )}
                        {update && (
                          <button
                            type="button"
                            className="update"
                            onClick={() => void handleInstallPack(update)}
                            disabled={isUpdating}
                          >
                            <Download size={11} /> {isUpdating ? '...' : 'Update'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="danger"
                          onClick={() => handleRemovePack(pack.packName, pack.packVersion)}
                          disabled={isRemoving}
                        >
                          <Trash2 size={11} /> {isRemoving ? '...' : t('skills.studio.remove')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
        <section className="skills-studio-note-card">
          <h3>{t('skills.studio.usageTitle')}</h3>
          <p>{t('skills.studio.usageLine1')}</p>
          <p>{t('skills.studio.usageLine2')}</p>
          <div className="skills-studio-note-chips">
            <span>{t('skills.studio.installedPacksCount').replace('{count}', String(installedPacks.length))}</span>
            <span>{t('skills.studio.currentSkillsCount').replace('{count}', String(skills.length))}</span>
          </div>
        </section>
      </main>

      {/* ── Pack preview modal: inspect + selective install ── */}
      {previewPack && (
        <div className="skills-pack-preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
          <div className="skills-pack-preview">
            <div className="skills-pack-preview-head">
              <strong>{previewPack.name}</strong>
              <em>{previewPack.version}</em>
              {previewSkills && <code>{previewSkills.length} skills</code>}
              {previewSafety.caution > 0 && <code className="safety-caution">{previewSafety.caution} caution</code>}
              {previewSafety.dangerous > 0 && <code className="safety-dangerous">{previewSafety.dangerous} dangerous</code>}
              {externalPackUrl(previewPack) && (
                <button
                  type="button"
                  className="link-btn"
                  title={externalPackUrl(previewPack) || ''}
                  onClick={() => window.open(externalPackUrl(previewPack) || '', '_blank')}
                >
                  <ExternalLink size={12} />
                </button>
              )}
              <button type="button" className="skills-pack-preview-close" onClick={closePreview} title="Close">
                <X size={14} />
              </button>
            </div>
            {previewPack.description && <p className="skills-pack-preview-desc">{previewPack.description}</p>}

            <div className="skills-pack-preview-body">
              {previewSkills === null && <p className="skills-pack-empty">Loading skills...</p>}
              {previewError && <p className="skills-pack-error">{previewError}</p>}
              {previewSkills && previewSkills.length === 0 && !previewError && (
                <p className="skills-pack-empty">This pack contains no skills.</p>
              )}
              {previewSkills && previewSkills.map((skill, idx) => (
                <label key={`${skill.id || skill.name}-${idx}`} className="skills-pack-preview-skill">
                  <input
                    type="checkbox"
                    checked={selectedSkillIdx.has(idx)}
                    onChange={() => toggleSkillIdx(idx)}
                  />
                  <span className="skill-emoji">{skill.emoji || '⚡'}</span>
                  <span className="skill-body">
                    <span className="skill-name-row">
                      <strong>{skill.name}</strong>
                      <code>{skill.cliType}</code>
                      <code>{skill.category}</code>
                      {skill.safetyLevel && skill.safetyLevel !== 'safe' && (
                        <code className={safetyBadgeClass(skill.safetyLevel)} title={(skill.safetyReasons || []).join(', ')}>
                          {skill.safetyLevel}
                        </code>
                      )}
                    </span>
                    {skill.description && <span className="skill-desc">{skill.description}</span>}
                  </span>
                </label>
              ))}
            </div>

            <div className="skills-pack-preview-foot">
              <button type="button" className="ghost" onClick={toggleSelectAll} disabled={!previewSkills?.length}>
                {previewSkills && selectedSkillIdx.size === previewSkills.length ? 'Select none' : 'Select all'}
              </button>
              <span className="skills-pack-preview-count">
                {selectedSkillIdx.size} / {previewSkills?.length ?? 0} selected
              </span>
              <button
                type="button"
                className="primary"
                onClick={() => void handleInstallSelected()}
                disabled={!previewSkills || selectedSkillIdx.size === 0 || installingPack !== null}
              >
                <Download size={12} /> {installingPack ? '...' : `Install selected (${selectedSkillIdx.size})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
