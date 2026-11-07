// When the main window opens the guide or What's new on startup. Pure.

export interface StartupInput {
  debugBuild: boolean;
  projectCount: number;
  firstRunDone: boolean;
  lastSeen: string | null;
  current: string;
  /** sectionsToShow(...).length, computed by the caller. */
  whatsNewCount: number;
}

export interface StartupDecision {
  openGuide: boolean;
  openWhatsNew: boolean;
  writeFirstRun: boolean;
  /** Version to store as last seen; '' means write nothing. */
  writeLastSeen: string;
}

export function decideStartup(i: StartupInput): StartupDecision {
  // Dev builds never open anything on their own (the Help menu still works),
  // and leave the stored keys alone so the installed app's state is untouched.
  if (i.debugBuild) return { openGuide: false, openWhatsNew: false, writeFirstRun: false, writeLastSeen: '' };

  // Fresh install: teach first; What's new would only be noise.
  if (i.projectCount === 0 && !i.firstRunDone) {
    return { openGuide: true, openWhatsNew: false, writeFirstRun: true, writeLastSeen: i.current };
  }

  return { openGuide: false, openWhatsNew: i.whatsNewCount > 0, writeFirstRun: false, writeLastSeen: i.current };
}
