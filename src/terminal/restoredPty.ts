import { looksLikeAgentUiReady, type AgentCliKind } from './agentReadiness';

type InvokeLike = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface RestoredPtyProbe {
  ptyAlreadyExists: boolean;
  bufferedOutput: string;
  markCliAutoStarted: boolean;
}

export async function probeRestoredPty({
  invokeFn,
  terminalId,
  cliType,
  isRestored,
  ptyAlreadyExists,
}: {
  invokeFn: InvokeLike;
  terminalId: string;
  cliType: string;
  isRestored: boolean;
  ptyAlreadyExists: boolean;
}): Promise<RestoredPtyProbe> {
  if (ptyAlreadyExists || !isRestored) {
    return { ptyAlreadyExists, bufferedOutput: '', markCliAutoStarted: false };
  }

  const alive = await invokeFn<boolean>('check_pty_alive', { terminalId }).catch(() => false);
  if (!alive) {
    return { ptyAlreadyExists: false, bufferedOutput: '', markCliAutoStarted: false };
  }

  const bufferedOutput = await invokeFn<string>('read_pty_output_buffer', { terminalId }).catch(() => '');
  const hasAgentUi = cliType !== 'shell' && looksLikeAgentUiReady(cliType as AgentCliKind, bufferedOutput || '');
  return {
    ptyAlreadyExists: true,
    bufferedOutput: bufferedOutput || '',
    markCliAutoStarted: hasAgentUi,
  };
}
