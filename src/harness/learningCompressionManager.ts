import { runCliPrompt, type CliProvider } from './cliRuntime';
import type { HarnessMessageLike } from './threadState';

export async function summarizeThreadForCompression(params: {
  provider: CliProvider;
  workDir: string;
  threadTitle?: string;
  messages: Array<{ role: 'human' | 'assistant' | 'tool' | 'system'; content: string }>;
  timeoutSecs: number;
}): Promise<string | undefined> {
  const candidates = params.messages
    .filter((message) => message.role === 'human' || message.role === 'assistant')
    .slice(-20);
  if (candidates.length < 10) return undefined;

  const transcript = candidates
    .map((message) => `${message.role === 'human' ? 'User' : 'Assistant'}: ${message.content.slice(0, 1200)}`)
    .join('\n\n');
  const prompt = [
    'Summarize this long-running Coding Secretary thread for future handoff.',
    'Return plain text only.',
    'Include:',
    '- overall goal',
    '- key decisions and constraints',
    '- files/components touched',
    '- unresolved items',
    '- reusable lessons',
    '',
    `Thread: ${params.threadTitle || 'untitled'}`,
    '',
    transcript,
  ].join('\n');

  try {
    const raw = await runCliPrompt(params.provider, prompt, params.workDir, params.timeoutSecs);
    const summary = String(raw || '').trim();
    return summary.length >= 80 ? summary.slice(0, 2400) : undefined;
  } catch {
    return undefined;
  }
}

export function shouldCompressThread(messageCount: number): boolean {
  return messageCount >= 16;
}

function collectReferencedPaths(messages: HarnessMessageLike[], limit = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const patterns = [
    /(?:^|\s)([A-Za-z]:[\\/][^\s'"`]+(?:\.[A-Za-z0-9_-]+)?)/g,
    /`([^`\n]+\/[^`\n]+)`/g,
    /`([^`\n]+\.[A-Za-z0-9_-]+)`/g,
  ];
  for (const message of messages) {
    const text = String(message.content || '');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const candidate = String(match[1] || '').trim();
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        out.push(candidate);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function buildStructuredOlderContext(messages: HarnessMessageLike[]): string {
  if (messages.length === 0) return '';
  const userRequests = messages
    .filter((message) => message.role === 'human')
    .map((message) => String(message.content || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const assistantOutputs = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => String(message.content || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const referencedPaths = collectReferencedPaths(messages);

  const lines: string[] = [];
  if (userRequests.length > 0) {
    lines.push(`Earlier user goals: ${userRequests.slice(0, 2).map((item) => item.slice(0, 180)).join(' | ')}`);
  }
  if (assistantOutputs.length > 0) {
    lines.push(`Earlier assistant outcomes: ${assistantOutputs.slice(-2).map((item) => item.slice(0, 180)).join(' | ')}`);
  }
  if (referencedPaths.length > 0) {
    lines.push(`Referenced files/components: ${referencedPaths.join(', ')}`);
  }
  return lines.join('\n');
}

export function buildCompressedConversationContext(params: {
  messages: HarnessMessageLike[];
  threadSummary?: string;
  recentMessageLimit?: number;
}): string {
  const recentMessageLimit = params.recentMessageLimit ?? 4;
  const relevant = (params.messages || []).filter(
    (message) => message.role === 'human' || message.role === 'assistant',
  );
  if (relevant.length === 0) {
    return params.threadSummary ? `Compressed thread handoff:\n${params.threadSummary}` : '';
  }

  const trimmed = relevant.length > 0 && relevant[relevant.length - 1]?.role === 'human'
    ? relevant.slice(0, -1)
    : relevant;
  const recent = trimmed.slice(-recentMessageLimit);
  const older = trimmed.slice(0, Math.max(0, trimmed.length - recent.length));
  const olderCount = Math.max(0, trimmed.length - recent.length);
  const olderContext = buildStructuredOlderContext(older);
  const recentBlock = recent
    .map((message) => `${message.role === 'human' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');

  if (!params.threadSummary || trimmed.length <= recentMessageLimit + 2) {
    return recentBlock;
  }

  return [
    'Compressed thread handoff:',
    params.threadSummary,
    olderCount > 0 ? `Earlier condensed turns: ${olderCount}` : '',
    olderContext ? `Structured earlier context:\n${olderContext}` : '',
    'Recent live context:',
    recentBlock,
  ].filter(Boolean).join('\n\n');
}
