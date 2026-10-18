import { isTauri } from '@tauri-apps/api/core';
import { kvSet } from '../hooks/useKV';

const SKILLS_SYNC_TAURI_EVENT = 'octo://skills-changed';
const SKILLS_SYNC_LOCAL_EVENT = 'octo-skills-changed';
const SKILLS_SYNC_TS_KEY = 'octo-skills-sync-ts';

function notifyLocal(): void {
  try {
    void kvSet(SKILLS_SYNC_TS_KEY, String(Date.now()));
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new Event(SKILLS_SYNC_LOCAL_EVENT));
  } catch {
    // ignore
  }
}

export async function emitSkillsChanged(): Promise<void> {
  if (isTauri()) {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit(SKILLS_SYNC_TAURI_EVENT);
    } catch {
      // ignore
    }
  }
  notifyLocal();
}

export async function subscribeSkillsChanged(handler: () => void): Promise<() => void> {
  const onLocal = () => handler();
  const onStorage = (e: StorageEvent) => {
    if (e.key === SKILLS_SYNC_TS_KEY) handler();
  };

  window.addEventListener(SKILLS_SYNC_LOCAL_EVENT, onLocal);
  window.addEventListener('storage', onStorage);

  let unlisten: (() => void) | null = null;
  if (isTauri()) {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen(SKILLS_SYNC_TAURI_EVENT, () => handler());
    } catch {
      // ignore
    }
  }

  return () => {
    window.removeEventListener(SKILLS_SYNC_LOCAL_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
    if (unlisten) {
      try {
        unlisten();
      } catch {
        // ignore
      }
    }
  };
}
