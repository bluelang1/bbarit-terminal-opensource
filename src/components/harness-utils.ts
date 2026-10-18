/**
 * harness-utils.ts — Pure utility functions for Agent Harness (testable)
 */

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function renderMarkdown(text: string): string {
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="lang-${lang}">${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`);
    return `__CODE_BLOCK_${idx}__`;
  });

  processed = processed.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  processed = processed
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n/g, '<br/>');

  processed = processed.replace(/(<li>.*?<\/li>(?:<br\/>)?)+/g, (match) => `<ul>${match.replace(/<br\/>/g, '')}</ul>`);
  codeBlocks.forEach((block, i) => { processed = processed.replace(`__CODE_BLOCK_${i}__`, block); });

  return processed;
}

export interface Artifact {
  id: string;
  filename: string;
  language: string;
  content: string;
}

export function extractArtifacts(content: string): Artifact[] {
  const artifacts: Artifact[] = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const lang = match[1] || 'text';
    const code = match[2].trim();
    if (['bash', 'sh', 'shell', 'zsh'].includes(lang.toLowerCase())) continue;
    if (code.length > 50) {
      const ext = { typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs', html: 'html', css: 'css', json: 'json', bash: 'sh', sql: 'sql' }[lang] || lang;
      artifacts.push({ id: genId(), filename: `artifact.${ext}`, language: lang, content: code });
    }
  }
  return artifacts;
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SelectionOption {
  id: string;
  title: string;
  summary: string;
  spec: string;
}

export function extractTodos(content: string): TodoItem[] {
  const todos: TodoItem[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const todoMatch = line.match(/^(?:\d+\.\s+|-\s+)(?:\[([x ])\]\s+)?(.+)/i);
    if (todoMatch) {
      const checked = todoMatch[1] === 'x';
      const text = todoMatch[2].trim();
      if (text.length > 5 && text.length < 200) {
        todos.push({ id: genId(), text, status: checked ? 'completed' : 'pending' });
      }
    }
  }
  return todos.length >= 2 ? todos : [];
}

export function parseToolCalls(content: string): { name: string; args: string; line: string }[] {
  const calls: { name: string; args: string; line: string }[] = [];
  const regex = /@tool\((\w+)(?:,\s*([\s\S]*?))?\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    calls.push({ name: match[1], args: (match[2] || '').trim(), line: match[0] });
  }
  return calls;
}

export function extractFilePaths(content: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const fileRegex = /```([^\n]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = fileRegex.exec(content)) !== null) {
    const filePath = match[1].trim();
    const fileContent = match[2];
    if ((filePath.includes('.') && filePath.includes('/')) || filePath.endsWith('.md') || filePath.endsWith('.txt')) {
      files.push({ path: filePath, content: fileContent });
    }
  }
  return files;
}

export function extractFileBlocks(content: string): { path: string; content: string }[] {
  const fileBlocks: { path: string; content: string }[] = [];
  const fileRegex = /```([^\n]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = fileRegex.exec(content || '')) !== null) {
    const filePath = match[1].trim();
    const fileContent = match[2];
    if (filePath.includes('.') || filePath.includes('/')) {
      fileBlocks.push({ path: filePath, content: fileContent });
    }
  }
  return fileBlocks;
}

export function parseSelectionOptions(
  content: string,
  marker = 'SPEC_OPTIONS_JSON',
  fallbackTitle = 'Recommended option',
  fallbackSummary = 'Use the generated result as the default direction.',
): SelectionOption[] {
  const match = content.match(new RegExp(`${marker}:\\s*(\\[[\\s\\S]*?\\])(?:\\n|$)`));
  if (match) {
    try {
      const parsed = JSON.parse(match[1]) as Array<{ title?: string; summary?: string; spec?: string }>;
      const normalized = parsed
        .filter(Boolean)
        .map((option) => ({
          id: genId(),
          title: (option.title || 'Option').trim(),
          summary: (option.summary || '').trim(),
          spec: (option.spec || '').trim(),
        }))
        .filter(option => option.title.length > 0 && option.spec.length > 0);
      if (normalized.length > 0) return normalized;
    } catch {
      /* ignore malformed JSON */
    }
  }

  const trimmed = (content || '').trim();
  return [{
    id: genId(),
    title: fallbackTitle,
    summary: fallbackSummary,
    spec: trimmed,
  }];
}

export function compactAgentHandoff(text: string, maxChars = 12000): string {
  const trimmed = (text || '').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[truncated]`;
}

export function isSuspiciousAgentResponse(text: string): boolean {
  const normalized = (text || '').trim().toLowerCase();
  if (!normalized) return true;

  const exactBadResponses = new Set([
    'hello! how can i help you today?',
    'hello, how can i help you today?',
    'how can i help you today?',
    'i can help with that',
    '안녕하세요! 무엇을 도와드릴까요?',
    '무엇을 도와드릴까요?',
  ]);
  if (exactBadResponses.has(normalized)) return true;

  if (normalized.length < 40) {
    if (normalized.includes('how can i help')) return true;
    if (normalized.includes('what can i help')) return true;
    if (normalized.includes('무엇을 도와')) return true;
    if (normalized.includes('도와드릴까요')) return true;
  }

  return false;
}

export function sanitizeCliOutput(text: string): string {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const traceBlockStart = /^(TurnBegin|StepBegin|ToolCall|ToolResult|ToolCallPart|StatusUpdate)\(/;
  const traceSingleLine = /^\s*(Research\s*→\s*Plan\s*→\s*Implement\s*→\s*Review|Research -> Plan -> Implement -> Review)\s*$/;
  const lines = raw.split('\n');
  const kept: string[] = [];
  let droppingTraceBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (droppingTraceBlock) {
      if (trimmed === ')') droppingTraceBlock = false;
      continue;
    }
    if (traceBlockStart.test(trimmed)) {
      droppingTraceBlock = true;
      continue;
    }
    if (traceSingleLine.test(trimmed)) continue;
    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripSelectionPayload(text: string): string {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const withoutFencedPayload = raw
    .replace(/\n?SPEC_OPTIONS_JSON:\s*```json[\s\S]*?```\s*/gi, '\n')
    .replace(/\n?PLAN_OPTIONS_JSON:\s*```json[\s\S]*?```\s*/gi, '\n')
    .replace(/\n?SPEC_OPTIONS_JSON:\s*\[[\s\S]*?\](?:\n|$)/gi, '\n')
    .replace(/\n?PLAN_OPTIONS_JSON:\s*\[[\s\S]*?\](?:\n|$)/gi, '\n');

  const markerIndex = withoutFencedPayload.search(/\n?(SPEC_OPTIONS_JSON|PLAN_OPTIONS_JSON):/i);
  const visibleOnly = markerIndex >= 0
    ? withoutFencedPayload.slice(0, Math.max(0, markerIndex))
    : withoutFencedPayload;

  return visibleOnly
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shouldBypassWorkflowForRequest(text: string): boolean {
  const normalized = (text || '').trim().toLowerCase();
  if (!normalized) return false;

  const workflowVerbs = [
    '만들',
    '구현',
    '개발',
    '수정',
    '고쳐',
    '바꿔',
    '추가',
    '리팩토링',
    '재개발',
    '작성해',
    '생성',
    '설치',
    '연결',
    'fix',
    'implement',
    'build',
    'create',
    'change',
    'update',
    'rewrite',
    'refactor',
    'add ',
    'set up',
  ];
  if (workflowVerbs.some(keyword => normalized.includes(keyword))) {
    return false;
  }

  const casualGreetings = new Set([
    '안녕',
    '안녕하세요',
    '안뇽',
    'ㅎㅇ',
    '하이',
    'hello',
    'hi',
    'hey',
    'yo',
  ]);
  if (casualGreetings.has(normalized)) {
    return true;
  }

  const directAnswerKeywords = [
    '아키텍처',
    '구조',
    '설명',
    '분석해줘',
    '요약',
    '무슨 프로젝트',
    '어떻게 동작',
    'what is',
    'how does',
    'explain',
    'describe',
    'architecture',
    'structure',
    'overview',
    'summary',
  ];

  if (directAnswerKeywords.some(keyword => normalized.includes(keyword))) {
    return true;
  }

  return normalized.endsWith('?');
}

export function shouldStartWorkflowForRequest(text: string, priorMessages: string[] = []): boolean {
  const normalized = (text || '').trim().toLowerCase();
  if (!normalized) return false;
  if (shouldBypassWorkflowForRequest(text)) return false;

  const explicitImplementationSignals = [
    '구현해',
    '구현해줘',
    '만들어',
    '만들어줘',
    '개발해',
    '개발해줘',
    '수정해',
    '수정해줘',
    '고쳐',
    '고쳐줘',
    '바꿔줘',
    '추가해',
    '추가해줘',
    '작성해',
    '작성해줘',
    '리팩토링',
    '업그레이드',
    '전면개편',
    '대대적',
    '고도화',
    'fix ',
    'implement',
    'build ',
    'create ',
    'update ',
    'rewrite',
    'refactor',
    'add ',
    'set up',
  ];
  if (explicitImplementationSignals.some(keyword => normalized.includes(keyword))) {
    return true;
  }

  const followUpStartSignals = [
    '진행해',
    '진행해줘',
    '바로 해',
    '해줘',
    '계속해',
    '계속 진행해',
    'start',
    'go ahead',
    'do it',
    'continue',
  ];
  const priorContextLength = priorMessages.map(msg => msg.trim()).filter(Boolean).join('\n').length;
  if (priorContextLength >= 80 && followUpStartSignals.some(keyword => normalized.includes(keyword))) {
    return true;
  }

  return false;
}
