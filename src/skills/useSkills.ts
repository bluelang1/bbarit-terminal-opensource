import { useState, useCallback, useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { Skill, SkillCliType, SkillCategory } from './types';
import { createSkill, exportSkills, importSkills } from './skillStore';
import { DEFAULT_SKILLS } from './defaultSkills';
import { dbBootstrapSkills, dbListMySkills, dbSetMySkills } from './skillDbClient';
import { emitSkillsChanged, subscribeSkillsChanged } from './skillSync';

async function loadMergedGalleryFromManifest(): Promise<Skill[]> {
  const { GALLERY_SKILLS } = await import('./gallerySkills');
  let merged = GALLERY_SKILLS;
  try {
    const res = await fetch('/skills-hub/famous-skills-manifest.json');
    if (res.ok) {
      const manifest = await res.json() as { packs?: Array<{ skills?: Skill[] }> };
      const webSkills = (manifest.packs || []).flatMap((p) => p.skills || []);
      const byId = new Map<string, Skill>();
      for (const s of GALLERY_SKILLS) byId.set(s.id, s);
      for (const s of webSkills) {
        if (!s?.id) continue;
        byId.set(s.id, s);
      }
      merged = Array.from(byId.values());
    }
  } catch {
    // ignore remote gallery merge failures
  }
  return merged;
}

export function useSkills() {
  const [skills, setSkills] = useState<Skill[]>(() => [...DEFAULT_SKILLS]);
  const [gallerySkills, setGallerySkills] = useState<Skill[]>([]);
  const [galleryLoaded, setGalleryLoaded] = useState(false);

  useEffect(() => {
    let disposed = false;
    const init = async () => {
      try {
        if (isTauri()) {
          const [{ GALLERY_SKILLS }, versions] = await Promise.all([
            import('./gallerySkills'),
            import('./catalogVersion'),
          ]);
          const gallerySeed = [
            versions.SKILLS_DB_SCHEMA_VERSION,
            versions.DEFAULT_SKILLS_VERSION,
            versions.GALLERY_SKILLS_VERSION,
          ].join(':');
          await dbBootstrapSkills(DEFAULT_SKILLS, GALLERY_SKILLS, gallerySeed);
          const loaded = await dbListMySkills();
          if (!disposed) {
            setSkills(loaded.length ? loaded : [...DEFAULT_SKILLS]);
          }
          return;
        }
        if (!disposed) setSkills([...DEFAULT_SKILLS]);
      } catch (err) {
        console.warn('[skills] failed to load db-backed skills, fallback to defaults:', err);
        if (!disposed) setSkills([...DEFAULT_SKILLS]);
      }
    };
    void init();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;

    const refresh = async () => {
      if (disposed) return;
      try {
        if (isTauri()) {
          const latest = await dbListMySkills();
          setSkills(latest.length ? latest : [...DEFAULT_SKILLS]);
        } else {
          setSkills([...DEFAULT_SKILLS]);
        }
      } catch {
        setSkills([...DEFAULT_SKILLS]);
      }
      if (!galleryLoaded) return;
      try {
        const merged = await loadMergedGalleryFromManifest();
        if (!disposed) setGallerySkills(merged);
      } catch (err) {
        console.warn('[skills] failed to refresh gallery:', err);
      }
    };

    void subscribeSkillsChanged(() => {
      void refresh();
    }).then((unsub) => {
      cleanup = unsub;
    }).catch((err) => {
      console.warn('[skills] failed to subscribe sync event:', err);
    });

    return () => {
      disposed = true;
      if (cleanup) cleanup();
    };
  }, [galleryLoaded]);

  const ensureGalleryLoaded = useCallback(async () => {
    if (galleryLoaded) return;
    try {
      const merged = await loadMergedGalleryFromManifest();
      setGallerySkills(merged);
      setGalleryLoaded(true);
    } catch (err) {
      console.error('[skills] failed to load gallery skills:', err);
    }
  }, [galleryLoaded]);

  const persistAndEmit = useCallback((next: Skill[]) => {
    if (!isTauri()) return;
    void dbSetMySkills(next)
      .then(() => emitSkillsChanged())
      .catch((err) => {
        console.error('[skills] failed to write skills db:', err);
      });
  }, []);

  const persistBulk = useCallback((next: Skill[]) => {
    setSkills(next);
    persistAndEmit(next);
  }, [persistAndEmit]);

  const addSkill = useCallback((partial: {
    name: string;
    description: string;
    emoji: string;
    command: string;
    cliType: SkillCliType;
    category: SkillCategory;
    tags?: string[];
    model?: string;
    allowedTools?: string[];
    whenToUse?: string;
    disableModelInvocation?: boolean;
    paths?: string[];
    priority?: number;
    sourcePack?: string;
    sourceUrl?: string;
    originalName?: string;
    originalCommand?: string;
    originalDescription?: string;
    safetyLevel?: Skill['safetyLevel'];
    safetyReasons?: string[];
    trustLevel?: Skill['trustLevel'];
  }) => {
    const baseSkill = createSkill(partial);
    let createdSkill = baseSkill;
    setSkills((prev) => {
      let skill = baseSkill;
      const idTaken = prev.some((s) => s.id === skill.id);
      if (idTaken) {
        const sameSkill = prev.find((s) =>
          s.id === skill.id
          && s.command === skill.command
          && s.cliType === skill.cliType
          && s.category === skill.category
          && s.name === skill.name
        );
        if (sameSkill) return prev;

        let suffix = 2;
        let candidate = `${skill.id}-${suffix}`;
        while (prev.some((s) => s.id === candidate)) {
          suffix += 1;
          candidate = `${skill.id}-${suffix}`;
        }
        skill = { ...skill, id: candidate };
      }

      createdSkill = skill;
      const next = [...prev, skill];
      persistAndEmit(next);
      return next;
    });
    return createdSkill;
  }, [persistAndEmit]);

  const updateSkill = useCallback((id: string, updates: Partial<Omit<Skill, 'id' | 'builtIn'>>) => {
    setSkills((prev) => {
      const target = prev.find((s) => s.id === id);
      if (!target) return prev;
      const updated: Skill = { ...target, ...updates };
      const next = prev.map((s) => (s.id === id ? updated : s));
      persistAndEmit(next);
      return next;
    });
  }, [persistAndEmit]);

  const removeSkill = useCallback((id: string) => {
    setSkills((prev) => {
      const skill = prev.find((s) => s.id === id);
      if (skill?.builtIn) return prev;
      const next = prev.filter((s) => s.id !== id);
      persistAndEmit(next);
      return next;
    });
  }, [persistAndEmit]);

  const findSkill = useCallback((nameOrId: string): Skill | undefined => {
    const lower = nameOrId.toLowerCase();
    const norm = lower.replace(/\s+/g, '-');
    return skills.find((s) =>
      s.id === lower || s.id === norm ||
      s.id === nameOrId ||
      s.name.toLowerCase() === lower ||
      s.name.toLowerCase().replace(/\s+/g, '-') === norm
    );
  }, [skills]);

  const doExport = useCallback((): string => {
    return exportSkills(skills);
  }, [skills]);

  const doImport = useCallback((json: string) => {
    const imported = importSkills(json);
    const dedup = new Map<string, Skill>();
    for (const skill of skills) dedup.set(skill.id, skill);
    for (const skill of imported) {
      if (!dedup.has(skill.id)) dedup.set(skill.id, skill);
    }
    persistBulk(Array.from(dedup.values()));
  }, [persistBulk, skills]);

  const resetToDefaults = useCallback(() => {
    const userSkills = skills.filter((s) => !s.builtIn);
    void import('./defaultSkills')
      .then(({ DEFAULT_SKILLS: defaults }) => {
        persistBulk([...defaults, ...userSkills]);
      })
      .catch(() => {
        persistBulk([...DEFAULT_SKILLS, ...userSkills]);
      });
  }, [persistBulk, skills]);

  const batchUpdate = useCallback((transformer: (prev: Skill[]) => Skill[]) => {
    setSkills((prev) => {
      const next = transformer(prev);
      persistAndEmit(next);
      return next;
    });
  }, [persistAndEmit]);

  return {
    skills,
    gallerySkills,
    ensureGalleryLoaded,
    addSkill,
    updateSkill,
    removeSkill,
    findSkill,
    batchUpdate,
    exportSkills: doExport,
    importSkills: doImport,
    resetToDefaults,
  };
}
