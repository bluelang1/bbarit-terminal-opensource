import type { DevReviewRole } from './devReviewPair';
import { looksLikePlainShellPrompt } from '../terminal/agentReadiness';
import { normalizeCliFlagLines, shellQuoteArg, type CliArgShell } from '../terminal/cliCommandArgs';

export interface BrokerAgentCliRepairSettings {
  claudeMode?: string;
  claudeModel?: string;
  claudeFlags?: unknown;
  codexMode?: string;
  codexModel?: string;
  codexFlags?: unknown;
  codexWebSearch?: boolean;
  resumeLastSession?: boolean;
  shellType?: CliArgShell;
}

export function buildBrokerCliRepairCommand(
  role: DevReviewRole,
  settings: BrokerAgentCliRepairSettings,
): string | null {
  const shellType = settings.shellType || 'powershell';
  const quote = (value: string) => shellQuoteArg(value, shellType);
  const addModel = (parts: string[], model: unknown) => {
    const modelId = String(model || '').trim();
    if (modelId && !parts.includes('--model')) parts.push('--model', quote(modelId));
  };
  if (role === 'claude') {
    const parts = ['claude'];
    if ((settings.claudeMode || 'normal') !== 'normal') parts.push('--dangerously-skip-permissions');
    addModel(parts, settings.claudeModel);
    parts.push(...normalizeCliFlagLines(settings.claudeFlags, shellType));
    return parts.join(' ');
  }
  if (role === 'codex') {
    const flags: string[] = [];
    const mode = settings.codexMode || 'normal';
    if (mode === 'yolo') flags.push('--dangerously-bypass-approvals-and-sandbox');
    else if (mode === 'full-auto') flags.push('--full-auto');
    else if (mode === 'auto-edit') flags.push('--auto-edit');
    if (settings.codexWebSearch) flags.push('--search');
    addModel(flags, settings.codexModel);
    flags.push(...normalizeCliFlagLines(settings.codexFlags, shellType));
    return `${settings.resumeLastSession ? 'codex resume --last' : 'codex'}${flags.length ? ` ${flags.join(' ')}` : ''}`;
  }
  if (role === 'cursor') return 'cursor-agent';
  if (role === 'opencode') return 'opencode';
  if (role === 'kimi') return 'kimi';
  if (role === 'gemini') return 'gemini';
  if (role === 'qwen') return 'qwen';
  if (role === 'pi') return 'pi';
  if (role === 'reasonix') return 'reasonix code';
  if (role === 'gajae') return 'gjc';
  return null;
}

export function buildBrokerCliRepairPayload(
  role: DevReviewRole,
  buffer: string,
  settings: BrokerAgentCliRepairSettings,
): string | null {
  if (!buffer || !looksLikePlainShellPrompt(buffer)) return null;
  const cmd = buildBrokerCliRepairCommand(role, settings);
  if (!cmd) return null;
  const visible = buffer.trimEnd();
  const tail = visible.split(/\r?\n/).slice(-2).join('\n');
  return /(?:^|\n)\s*>>\s*$/.test(tail) ? `\x03${cmd}\r` : `${cmd}\r`;
}
