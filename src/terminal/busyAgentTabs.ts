export type BusyAgentState = 'working' | 'blocked';
export interface BusyAgentTab {
  projectName: string;
  terminalName: string;
  state: BusyAgentState;
}

const MAX_LINES = 5;

/** Agent tabs (not plain shells) that are working or waiting for input. */
export function collectBusyAgentTabs(
  projects: Array<{ id: string; name: string; terminals: Array<{ id: string; name: string; cliType?: string }> }>,
  stateOf: (terminalId: string) => 'working' | 'blocked' | 'done' | 'idle',
): BusyAgentTab[] {
  const out: BusyAgentTab[] = [];
  for (const p of projects) {
    for (const t of p.terminals || []) {
      if (t.cliType === 'shell') continue;
      const s = stateOf(t.id);
      if (s === 'working' || s === 'blocked') {
        out.push({ projectName: p.name, terminalName: t.name, state: s });
      }
    }
  }
  return out;
}

export function formatBusyAgentWarning(items: BusyAgentTab[], lang: 'ko' | 'en'): { title: string; message: string } {
  const ko = lang === 'ko';
  const title = ko ? `작업 중인 에이전트 탭 ${items.length}개` : `${items.length} agent tab${items.length === 1 ? '' : 's'} still active`;
  const lines = items.slice(0, MAX_LINES).map((i) => {
    const st = i.state === 'working' ? (ko ? '작업 중' : 'working') : (ko ? '입력 대기' : 'waiting for input');
    return `• ${i.projectName} · ${i.terminalName} — ${st}`;
  });
  const rest = items.length - MAX_LINES;
  if (rest > 0) lines.push(ko ? `…외 ${rest}개` : `+${rest} more`);
  const tail = ko
    ? '지금 업데이트하면 이 작업들이 중단됩니다. 계속할까요?'
    : 'Updating now will interrupt these tasks. Continue?';
  return { title, message: `${lines.join('\n')}\n\n${tail}` };
}
