import { useMemo, useSyncExternalStore } from 'react';
import { useConfig } from '../config/ConfigContext';
import { normalizeBbaritAgentLanguage } from '../terminal/bbaritAgentLanguage';
import {
  acquireCoworkAgent,
  type CoworkAgentHandle,
  type CoworkEntry,
  type CoworkRunResult,
  type CoworkSnapshot,
} from './coworkAgentManager';

export type { CoworkEntry, CoworkRunResult };

// Subscribe a component to one cowork session's agent. The agent process
// lives in coworkAgentManager, NOT in this hook — unmounting the panel (tab
// switch, preview toggle, HMR) never touches the child, so in-flight turns
// keep running and their deliverables keep landing. Remounting re-attaches
// to the live state, including the current streaming text.

export interface UseCoworkAgent extends CoworkSnapshot {
  busy: boolean;
  run: CoworkAgentHandle['run'];
  abort: CoworkAgentHandle['abort'];
  cycleModel: CoworkAgentHandle['cycleModel'];
  note: CoworkAgentHandle['note'];
}

export function useCoworkAgent(workDir: string): UseCoworkAgent {
  const { config } = useConfig();
  const bbaritLanguage = normalizeBbaritAgentLanguage(config.agent.bbaritLanguage);
  const handle = useMemo(() => acquireCoworkAgent(workDir, bbaritLanguage), [workDir, bbaritLanguage]);
  const snap = useSyncExternalStore(handle.subscribe, handle.getSnapshot);
  return {
    ...snap,
    busy: snap.status === 'running',
    run: handle.run,
    abort: handle.abort,
    cycleModel: handle.cycleModel,
    note: handle.note,
  };
}
