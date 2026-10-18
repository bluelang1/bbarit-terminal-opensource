export interface HarnessToolDefinition {
  name: string;
  args: string;
  description: string;
  tags?: string[];
}

export const HARNESS_TOOL_REGISTRY: HarnessToolDefinition[] = [
  { name: 'tool_search', args: 'query', description: 'Search available harness tools by name, args, tag, or description', tags: ['tools', 'discovery'] },
  { name: 'project_context', args: '', description: 'Show auto-loaded project map, instruction files, package scripts, and key config excerpts' },
  { name: 'read_file', args: 'path', description: 'Read file contents' },
  { name: 'write_file', args: 'path, content', description: 'Write or create a file' },
  { name: 'ls', args: 'path', description: 'List directory contents' },
  { name: 'search_files', args: 'path, query', description: 'Search for files matching a pattern' },
  { name: 'grep', args: 'path, pattern', description: 'Search text in files' },
  { name: 'code_search', args: 'path, query', description: 'Hybrid BM25 + semantic code search via semble (auto-downloads potion-code-16M)' },
  { name: 'bash', args: 'command', description: 'Execute a shell command' },
  { name: 'atlas_model_check', args: '', description: 'Check the latest available Atlas models for Kimi, DeepSeek 4, and Qwen Code before starting work', tags: ['atlas', 'models', 'latest'] },
  { name: 'web_test', args: 'command?', description: 'Run beginner-safe web checks. With no command, runs available build/test/lint scripts and summarizes failures in plain language', tags: ['web', 'test', 'browser'] },
  { name: 'web_screenshot', args: 'url?, output_path?', description: 'Capture a web/app screenshot for visual checking. Uses the project dev:screen script when available, otherwise tries Playwright screenshot for a URL', tags: ['web', 'screenshot', 'image'] },
  { name: 'web_search', args: 'query', description: 'Search the web' },
  { name: 'web_fetch', args: 'url', description: 'Fetch a webpage' },
  { name: 'learning_search', args: 'query', description: 'Search memories, sessions, trajectories, and learned skills together' },
  { name: 'memory_search', args: 'query', description: 'Search durable learned memories and pinned recall items' },
  { name: 'session_search', args: 'query', description: 'Search past harness sessions and recall related work' },
  { name: 'trajectory_search', args: 'query', description: 'Search past learning trajectories and successful execution patterns' },
  { name: 'skill_search', args: 'query', description: 'Search learned self-improving skills and procedures' },
  { name: 'skill_manager', args: 'json', description: 'Hermes-style unified skill manager for create/edit/patch/delete/write_file/remove_file' },
  { name: 'skill_create', args: 'name, description\\nprocedure', description: 'Create or replace a file-backed self-improving skill' },
  { name: 'skill_patch', args: 'name, find, replace', description: 'Patch a file-backed self-improving skill by text replacement' },
  { name: 'skill_write_file', args: 'name, relative_path\\ncontent', description: 'Write a supporting file inside a file-backed skill directory' },
  { name: 'skill_remove_file', args: 'name, relative_path', description: 'Remove a supporting file from a file-backed skill directory' },
  { name: 'skill_delete', args: 'name', description: 'Delete a file-backed self-improving skill directory' },
  { name: 'learning_export', args: '', description: 'Export the local self-improving learning bundle to a JSON file in the workdir' },
  { name: 'learning_eval_export', args: '', description: 'Export replay/eval cases derived from sessions and trajectories to a JSON file in the workdir' },
  { name: 'learning_eval_run', args: 'provider?, limit?', description: 'Replay stored eval cases with Atlas Cloud API and write an eval report JSON file' },
  { name: 'learning_datagen_export', args: '', description: 'Export SFT/datagen cases derived from sessions, trajectories, and learned skills to a JSON file in the workdir' },
  { name: 'ask_user', args: 'question', description: 'Ask the user for clarification before proceeding' },
];

export function searchHarnessTools(query: string, limit = 8): HarnessToolDefinition[] {
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return HARNESS_TOOL_REGISTRY.slice(0, limit);
  const terms = raw.split(/\s+/).filter(Boolean);
  return HARNESS_TOOL_REGISTRY
    .map(tool => {
      const haystack = [
        tool.name,
        tool.args,
        tool.description,
        ...(tool.tags || []),
      ].join(' ').toLowerCase();
      const score = terms.reduce((sum, term) => {
        if (tool.name.toLowerCase() === term) return sum + 8;
        if (tool.name.toLowerCase().includes(term)) return sum + 5;
        if ((tool.tags || []).some(tag => tag.toLowerCase().includes(term))) return sum + 3;
        if (haystack.includes(term)) return sum + 1;
        return sum;
      }, 0);
      return { tool, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map(entry => entry.tool);
}

export function buildToolsDefinition(registry: HarnessToolDefinition[] = HARNESS_TOOL_REGISTRY): string {
  const lines = registry.map(tool => `- @tool(${tool.name}, ${tool.args}) - ${tool.description}`);
  return [
    '## Available Tools',
    'You can use these tools by writing @tool(name, args) on a separate line. The system will execute them and show results.',
    '',
    ...lines,
    '',
    'Example: @tool(read_file, src/main.ts)',
    'Example: @tool(bash, npm test)',
    'Example: @tool(atlas_model_check, )',
    'Example: @tool(web_test, npm run build)',
    'Example: @tool(web_screenshot, http://127.0.0.1:5173, .bbarit/korini/web-check.png)',
    'Example: @tool(web_search, React best practices 2025)',
  ].join('\n');
}
