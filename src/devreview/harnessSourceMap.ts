export type HarnessSourceKind = 'primary' | 'other' | 'support';

export interface HarnessSourceGroup {
  id: string;
  kind: HarnessSourceKind;
  title: string;
  summary: string;
  entryFiles: string[];
}

export const HARNESS_SOURCE_MAP: readonly HarnessSourceGroup[] = [
  {
    id: 'broker-harness',
    kind: 'primary',
    title: 'Broker Harness',
    summary: 'Current dev-review pair harness: opens two agent terminals, coordinates git/wiki review, and manages worktree merge state.',
    entryFiles: [
      'src/devreview/devReviewPair.ts',
      'src/devreview/brokerMechanic.ts',
      'src/devreview/brokerSessionStore.ts',
      'src/components/BrokerHarnessModal.tsx',
      'docs/broker-harness.md',
    ],
  },
  {
    id: 'agent-harness',
    kind: 'other',
    title: 'Agent Harness',
    summary: 'Older standalone/chat harness source with runtime factories, workflow execution, learning review, tools, memory, and thread state.',
    entryFiles: [
      'src/harness/',
      'src/components/AgentHarnessPanel.tsx',
      'src/pages/HarnessPage.tsx',
      'docs/BBARIT-AGENT-SELF-IMPROVING.md',
    ],
  },
  {
    id: 'browser-agent-support',
    kind: 'support',
    title: 'Browser Agent Support',
    summary: 'Browser control CLI and remote review worker used by agents and reviewers for UI evidence and background review channels.',
    entryFiles: [
      'agent-browser-cli/bin/bbarit-browser-control.mjs',
      'agent-browser-cli/CLI.md',
      'cloudflare/bbarit-agent-review-worker.js',
    ],
  },
];

export function searchHarnessSourceMap(query: string): HarnessSourceGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...HARNESS_SOURCE_MAP];
  return HARNESS_SOURCE_MAP.filter((group) => (
    group.title.toLowerCase().includes(needle)
    || group.summary.toLowerCase().includes(needle)
    || group.kind.includes(needle)
    || group.entryFiles.some((file) => file.toLowerCase().includes(needle))
  ));
}
