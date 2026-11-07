// Main-window side of the guide: owns progress (kv `bbarit-guide-progress`),
// answers the guide window's events, shows the spotlight and decides the
// one-time startup opening. App.tsx only feeds it counts and renders <Spotlight>.
// Never writes into a PTY: it highlights controls and opens UI only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { kvGet, kvGetJSON, kvSet, kvSetJSON } from '../hooks/useKV';
import { parseChangelog, sectionsToShow } from './changelog';
import { decideStartup } from './decide';
import { openGuideWindow, type GuideOpenOptions } from './openGuide';
import {
  GUIDE_FIRSTRUN_KEY,
  GUIDE_PROGRESS_KEY,
  GUIDE_STEPS,
  GUIDE_WINDOW_LABEL,
  LAST_SEEN_VERSION_KEY,
  isGuideStepId,
  markDone,
  normalizeProgress,
  type GuideProgress,
  type GuideStep,
  type GuideStepId,
} from './steps';

export interface GuideHostInput {
  /** Main window only (/harness loads the same App). */
  enabled: boolean;
  debugBuild: () => boolean;
  t: (key: string) => string;
  openSettingsTerminal: () => void;
  /** State the auto-ticks watch; an increase marks the step. */
  projectCount: number;
  agentTabCount: number;
  statusTabCount: number;
  gitPanelOpen: boolean;
}

export interface GuideHost {
  spotlight: { step: GuideStep; nonce: number } | null;
  closeSpotlight: () => void;
  open: (opts: Omit<GuideOpenOptions, 'title'>) => void;
  mark: (id: GuideStepId) => void;
  /** Call once project restore has settled. */
  runStartup: (projectCount: number) => void;
}

const MODAL_WAIT_MS = 4000;

function waitForSelector(selector: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (document.querySelector(selector) || Date.now() - started > timeoutMs) resolve();
      else window.setTimeout(tick, 150);
    };
    tick();
  });
}

/** An increase of `value` (from its previous value, starting at 0) calls `onIncrease`. */
function useIncrease(value: number, onIncrease: () => void) {
  const prev = useRef(0);
  useEffect(() => {
    if (value > prev.current) onIncrease();
    prev.current = value;
  }, [value]);
}

export function useGuideHost(input: GuideHostInput): GuideHost {
  const { enabled } = input;
  const latest = useRef(input);
  latest.current = input;

  const progressRef = useRef<GuideProgress>({});
  const loadedRef = useRef(false);
  const pendingRef = useRef<GuideStepId[]>([]);
  const startupRanRef = useRef(false);
  const [spotlight, setSpotlight] = useState<GuideHost['spotlight']>(null);

  const publish = useCallback((p: GuideProgress) => {
    progressRef.current = p;
    void kvSetJSON(GUIDE_PROGRESS_KEY, p);
    if (isTauri()) void emitTo(GUIDE_WINDOW_LABEL, 'guide-progress', { progress: p }).catch(() => {});
  }, []);

  const mark = useCallback((id: GuideStepId) => {
    if (!latest.current.enabled) return;
    if (!loadedRef.current) { pendingRef.current.push(id); return; }
    const next = markDone(progressRef.current, id, Date.now());
    if (next !== progressRef.current) publish(next);
  }, [publish]);

  // Load stored progress, then apply marks that happened before it arrived.
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void kvGetJSON<unknown>(GUIDE_PROGRESS_KEY, {}).then((raw) => {
      if (!alive) return;
      const stored = normalizeProgress(raw);
      let next = stored;
      const now = Date.now();
      for (const id of pendingRef.current) next = markDone(next, id, now);
      pendingRef.current = [];
      loadedRef.current = true;
      if (next !== stored) publish(next);
      else progressRef.current = stored;
    });
    return () => { alive = false; };
  }, [enabled, publish]);

  const open = useCallback((opts: Omit<GuideOpenOptions, 'title'>) => {
    if (!isTauri()) return;
    const title = opts.mode === 'whatsnew' ? latest.current.t('guide.menu.whatsnew') : latest.current.t('guide.title');
    void openGuideWindow({ ...opts, title }).catch((e) => console.warn('[guide] open failed:', e));
  }, []);

  const closeSpotlight = useCallback(() => setSpotlight(null), []);

  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const stepOf = (payload: { stepId?: unknown } | undefined) => {
      const id = payload?.stepId;
      return isGuideStepId(id) ? GUIDE_STEPS.find(s => s.id === id) ?? null : null;
    };
    const offs = [
      listen<{ stepId?: string }>('guide-spotlight', (e) => {
        const step = stepOf(e.payload);
        if (step?.target) setSpotlight({ step, nonce: Date.now() });
      }),
      listen<{ stepId?: string }>('guide-action', (e) => {
        const step = stepOf(e.payload);
        if (!step?.action) return;
        if (step.action === 'pet-tour') {
          void invoke('pet_start_tour').catch((err) => console.warn('[guide] pet tour failed:', err));
          mark('pet');
        } else if (step.action === 'open-settings-terminal') {
          latest.current.openSettingsTerminal();
          mark('keep-running');
        }
      }),
      listen<{ stepId?: string }>('guide-next', (e) => {
        const step = stepOf(e.payload);
        if (step) mark(step.id);
      }),
      listen('guide-reset', () => {
        pendingRef.current = [];
        if (loadedRef.current) publish({});
      }),
      listen('menu-guide-open', () => open({ mode: 'start' })),
      listen('menu-whatsnew-open', () => open({ mode: 'whatsnew' })),
      // The pet window reports when it shows (pet.rs → pet-visibility); seeing it once counts.
      listen<{ visible?: boolean }>('pet-visibility', (e) => { if (e.payload?.visible) mark('pet'); }),
    ];
    return () => { offs.forEach(p => { void p.then(off => off()).catch(() => {}); }); };
  }, [enabled, mark, open, publish]);

  // Auto-ticks from real use.
  useIncrease(enabled ? input.projectCount : 0, () => mark('project'));
  useIncrease(enabled ? input.agentTabCount : 0, () => mark('ai-terminal'));
  useIncrease(enabled ? input.statusTabCount : 0, () => mark('status'));
  useIncrease(enabled && input.gitPanelOpen ? 1 : 0, () => mark('git-keys'));

  const runStartup = useCallback((projectCount: number) => {
    if (!latest.current.enabled || !isTauri() || startupRanRef.current) return;
    startupRanRef.current = true;
    const debugBuild = latest.current.debugBuild();
    if (debugBuild) return; // decideStartup would open and write nothing anyway
    void (async () => {
      try {
        const [firstRun, lastSeen, current, md] = await Promise.all([
          kvGet(GUIDE_FIRSTRUN_KEY),
          kvGet(LAST_SEEN_VERSION_KEY),
          getVersion(),
          import('../../CHANGELOG.md?raw').then(m => m.default as string),
        ]);
        const whatsNewCount = sectionsToShow(parseChangelog(md), lastSeen, current).length;
        const d = decideStartup({ debugBuild, projectCount, firstRunDone: firstRun === '1', lastSeen, current, whatsNewCount });
        if (d.writeFirstRun) await kvSet(GUIDE_FIRSTRUN_KEY, '1');
        if (d.writeLastSeen) await kvSet(LAST_SEEN_VERSION_KEY, d.writeLastSeen);
        if (d.openGuide) {
          // Fresh install: let the new-project modal come up first; step 1 points at its folder field.
          await waitForSelector('[data-guide="new-project-folder"]', MODAL_WAIT_MS);
          open({ mode: 'start', step: 'project' });
        } else if (d.openWhatsNew) {
          open({ mode: 'whatsnew', from: lastSeen });
        }
      } catch (err) {
        console.warn('[guide] startup check failed:', err);
      }
    })();
  }, [open]);

  return { spotlight, closeSpotlight, open, mark, runStartup };
}
