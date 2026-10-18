export interface GuardrailDecision {
  allow: boolean;
  code: string;
  reason?: string;
}

export type HarnessShellPermission = 'standard' | 'trusted';

const KNOWN_TOOLS = new Set([
  'tool_search',
  'project_context',
  'read_file',
  'write_file',
  'ls',
  'search_files',
  'grep',
  'bash',
  'atlas_model_check',
  'web_test',
  'web_screenshot',
  'web_search',
  'web_fetch',
  'learning_search',
  'memory_search',
  'session_search',
  'trajectory_search',
  'skill_search',
  'skill_manager',
  'skill_create',
  'skill_patch',
  'skill_write_file',
  'skill_remove_file',
  'skill_delete',
  'learning_export',
  'learning_eval_export',
  'learning_eval_run',
  'learning_datagen_export',
  'ask_user',
]);

const STANDARD_BLOCKED_BASH_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(?!null\b)/i,
  /\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b/i,
];

const TRUSTED_BLOCKED_BASH_PATTERNS = [
  /\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/(?!null\b)/i,
  /\bcurl\b[\s\S]*\|\s*(?:sh|bash)\b/i,
  /\b(?:tee|cp|mv)\b[\s\S]*(?:\/etc\/|\/System\/|\/private\/etc\/|\/\.ssh\/|\/\.gnupg\/)/i,
  />\s*(?:\/etc\/|\/System\/|\/private\/etc\/|\/\.ssh\/|\/\.gnupg\/)/i,
];

const BLOCKED_WRITE_PATH_PATTERNS = [
  /^\/etc\//,
  /^\/System\//,
  /^\/private\/etc\//,
  /\/\.ssh\//,
  /\/\.gnupg\//,
];

export function authorizeHarnessToolCall(
  name: string,
  args: string,
  workDir: string,
  options: { shellPermission?: HarnessShellPermission } = {},
): GuardrailDecision {
  const toolName = String(name || '').trim();
  const rawArgs = String(args || '').trim();

  if (!KNOWN_TOOLS.has(toolName)) {
    return { allow: false, code: 'tool.unknown', reason: `Unknown tool: ${toolName}` };
  }

  if (toolName === 'bash') {
    const patterns = options.shellPermission === 'trusted'
      ? TRUSTED_BLOCKED_BASH_PATTERNS
      : STANDARD_BLOCKED_BASH_PATTERNS;
    const blocked = patterns.find(pattern => pattern.test(rawArgs));
    if (blocked) {
      return { allow: false, code: 'bash.blocked_pattern', reason: 'Guardrail denied: dangerous shell pattern blocked.' };
    }
  }

  if (toolName === 'write_file') {
    const firstNewline = rawArgs.indexOf('\n');
    const rawPath = (firstNewline > 0 ? rawArgs.slice(0, firstNewline) : rawArgs.split(',')[0]).trim();
    const fullPath = rawPath.startsWith('/') ? rawPath : `${workDir}/${rawPath}`;
    const blocked = BLOCKED_WRITE_PATH_PATTERNS.find(pattern => pattern.test(fullPath));
    if (blocked) {
      return { allow: false, code: 'write.protected_path', reason: `Guardrail denied: protected path blocked (${rawPath}).` };
    }
  }

  if (toolName === 'web_fetch') {
    if (!/^https?:\/\//i.test(rawArgs)) {
      return { allow: false, code: 'web.invalid_url', reason: 'Guardrail denied: web_fetch only supports http/https URLs.' };
    }
  }

  return { allow: true, code: 'tool.allowed' };
}
