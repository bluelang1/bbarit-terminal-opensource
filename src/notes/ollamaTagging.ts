/**
 * ollamaTagging.ts
 *
 * Multi-provider AI chat for notes.
 * Supports: Ollama (local), Claude CLI, Codex CLI, Kimi CLI, GPT CLI.
 *
 * CLI-based providers use `run_cli_oneshot` Tauri command to spawn
 * non-interactive CLI processes and capture their stdout.
 *
 * Provider selection: localStorage 'octo-ai-tag-provider'
 */

import { invoke } from '@tauri-apps/api/core';
import { kvGet, kvSet } from '../hooks/useKV';

// ───────────────────────── Provider Types ─────────────────────────

export type AiTagProvider = 'codex' | 'kimi' | 'deepseek' | 'ollama';

export const AI_TAG_PROVIDERS: { id: AiTagProvider; label: string; description: string }[] = [
  { id: 'codex', label: 'Codex', description: 'codex exec (CLI)' },
  { id: 'kimi', label: 'Kimi', description: 'kimi -p (CLI)' },
  { id: 'deepseek', label: 'DeepSeek', description: 'deepseek -p (CLI)' },
  { id: 'ollama', label: 'Ollama', description: 'Local LLM' },
];

const STORAGE_KEY_PROVIDER = 'octo-ai-tag-provider';

export async function getAiTagProvider(): Promise<AiTagProvider> {
  const saved = ((await kvGet(STORAGE_KEY_PROVIDER)) || '').trim();
  if (['codex', 'kimi', 'deepseek', 'ollama'].includes(saved)) return saved as AiTagProvider;
  return 'codex';
}

export function setAiTagProvider(provider: AiTagProvider): void {
  void kvSet(STORAGE_KEY_PROVIDER, provider);
}

function providerLabel(provider: AiTagProvider): string {
  return AI_TAG_PROVIDERS.find(p => p.id === provider)?.label || provider;
}

// ───────────────────────── CLI Runner ─────────────────────────

/** Run a CLI command and return stdout. Uses Tauri run_cli_oneshot. */
async function runCli(command: string, timeoutSecs?: number): Promise<string> {
  console.log('[AI] Running CLI:', command.slice(0, 100) + '...');
  try {
    const savedTimeout = Number.parseInt(((await kvGet('octo-ai-cli-timeout-secs')) || '').trim(), 10);
    const effectiveTimeout = Number.isFinite(savedTimeout)
      ? Math.max(30, Math.min(900, savedTimeout))
      : (timeoutSecs ?? 900);
    const result = await invoke<string>('run_cli_oneshot', { command, timeoutSecs: effectiveTimeout });
    console.log('[AI] CLI result:', result.slice(0, 200));
    return result;
  } catch (err) {
    console.error('[AI] CLI error:', err);
    throw err;
  }
}

/** Escape single quotes for shell */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// ───────────────────────── Provider Chat Functions ─────────────────────────

async function ollamaChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const url = ((await kvGet('octo-ollama-url')) || '').trim() || 'http://localhost:11434';
  const model = ((await kvGet('octo-ollama-model')) || '').trim();
  const savedTimeoutMs = Number.parseInt(((await kvGet('octo-ollama-timeout-ms')) || '').trim(), 10);
  const timeoutMs = Number.isFinite(savedTimeoutMs)
    ? Math.max(30_000, Math.min(600_000, savedTimeoutMs))
    : 600_000;
  const savedNumPredict = Number.parseInt(((await kvGet('octo-ollama-num-predict')) || '').trim(), 10);
  const numPredict = Number.isFinite(savedNumPredict)
    ? Math.max(256, Math.min(32_768, savedNumPredict))
    : 4096;
  if (!model) throw new Error('No Ollama model configured. Set it in Settings → Ollama.');

  const res = await invoke<{ status: number; body: string }>('http_request', {
    input: {
      method: 'POST',
      url: `${url}/api/chat`,
      timeout_ms: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        options: {
          num_predict: numPredict,
        },
      }),
    },
  });
  if (res.status >= 400) throw new Error(`Ollama error ${res.status}: ${res.body.slice(0, 200)}`);
  const data = JSON.parse(res.body) as { message?: { content?: string } };
  return data.message?.content || '';
}

async function deepseekChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return runCli(`deepseek -p '${shellEscape(combined)}'`);
}

async function codexChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return runCli(`codex exec --skip-git-repo-check '${shellEscape(combined)}'`);
}

async function kimiChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const combined = `${systemPrompt}\n\n${userPrompt}`;
  return runCli(`kimi -p '${shellEscape(combined)}'`);
}


// ───────────────────────── Unified Chat ─────────────────────────

// ───────────────────────── Tag Suggestion ─────────────────────────

/**
 * Suggest 3-5 tags for a note using AI.
 * Lightweight function for auto-tag suggestions after save.
 */
export async function suggestTagsForNote(
  content: string,
  existingTags: string[],
  noteNames: string[],
): Promise<string[]> {
  const systemPrompt = `You are a note tagging assistant. Suggest 3-5 relevant tags for the given markdown note.
Rules:
- Tags: short, lowercase, no spaces (use hyphens). Between 3 and 5 tags.
- Consider the existing tags in the vault for consistency.
- Output ONLY a JSON array of strings: ["tag1","tag2","tag3"]
- No markdown fences, no explanation, no other text.`;

  const uniqueExisting = [...new Set(existingTags)].slice(0, 40);
  const userPrompt = `Note content:\n${content.slice(0, 1500)}\n\nExisting tags in vault: ${uniqueExisting.join(', ')}\nOther note names: ${noteNames.slice(0, 20).join(', ')}`;

  const raw = await aiChat(systemPrompt, userPrompt);

  try {
    // Try to extract JSON array from response
    const arrayMatch = raw.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return [];
    const parsed = JSON.parse(arrayMatch[0]) as unknown[];
    return parsed
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter(t => t.length > 0)
      .slice(0, 5);
  } catch {
    console.warn('[AI] Failed to parse tag suggestions:', raw.slice(0, 200));
    return [];
  }
}

// ───────────────────────── Note Processing ─────────────────────────

/**
 * Process a single note: extract tags and link suggestions using AI.
 */
export async function processNote(
  notePath: string,
  noteIndex: import('./noteState').NoteIndexEntry[],
  _writeBack: boolean,
  log: (msg: string) => void,
): Promise<{ tags: string[]; links: string[] }> {
  const { invoke: inv } = await import('@tauri-apps/api/core');
  const content = await inv<string>('read_file', { path: notePath });
  const fileName = notePath.split('/').pop() || notePath;
  log(`› ${fileName}`);

  const existingTags = noteIndex.flatMap(n => n.tags).filter(Boolean);
  const uniqueTags = [...new Set(existingTags)].slice(0, 50);

  const systemPrompt = `You are a note tagging assistant. Given a markdown note, extract relevant tags and suggest backlinks to other notes.
Rules:
- Tags: short, lowercase, no spaces (use hyphens). Max 5 tags.
- Links: suggest note filenames from the index that are related.
- Output JSON only: {"tags":["tag1","tag2"],"links":["NoteName1"]}
- No markdown fences, no explanation.`;

  const noteNames = noteIndex.map(n => n.name).slice(0, 30);
  const userPrompt = `Note content:\n${content.slice(0, 2000)}\n\nExisting tags in vault: ${uniqueTags.join(', ')}\nOther notes: ${noteNames.join(', ')}`;

  const raw = await aiChat(systemPrompt, userPrompt);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]) as { tags?: string[]; links?: string[] };
    const tags = (parsed.tags || []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
    const links = (parsed.links || []).map(l => String(l).trim()).filter(Boolean);
    log(`  ✓ ${tags.length} tags, ${links.length} links`);
    return { tags, links };
  } catch {
    log(`  ⚠ JSON 파싱 실패, raw 분석 시도`);
    return { tags: [], links: [] };
  }
}

// ───────────────────────── Note Organize ─────────────────────────

export interface OrganizeNoteResult {
  title: string;
  tags: string[];
  links: string[];
  folder: string;
  content: string;
}

/**
 * Organize raw text into a structured markdown note using AI.
 * Returns title, tags, wikilinks, recommended folder, and full markdown content.
 */
export async function organizeNote(
  rawText: string,
  existingTags: string[],
  existingNoteNames: string[],
  folders: string[],
): Promise<OrganizeNoteResult> {
  const uniqueTags = [...new Set(existingTags)].slice(0, 50);
  const noteNames = existingNoteNames.slice(0, 40);
  const folderList = folders.slice(0, 20);

  const systemPrompt = `You are a note organizer. Given raw text, create a structured markdown note.

Rules:
- Title: extract or generate a concise title
- Tags: 3-5 relevant tags using existing tags when possible (lowercase, Korean OK, use hyphens instead of spaces)
- Links: suggest [[wikilinks]] to related existing notes (use exact note names from the list)
- Structure: add ## sections if the content is long enough
- Folder: recommend the best folder from the folder list, or "" for root
- The markdown content MUST include tags as inline #tag format and wikilinks as [[NoteName]] format within the text
- Write in the same language as the input text
- Output ONLY valid JSON (no markdown fences, no explanation):
  {"title":"...","tags":["..."],"links":["..."],"folder":"...","content":"full markdown with #tags and [[links]] embedded"}`;

  const userPrompt = `Raw text:
${rawText.slice(0, 3000)}

Existing tags in vault: ${uniqueTags.join(', ') || '(none)'}
Existing notes: ${noteNames.join(', ') || '(none)'}
Folders: ${folderList.join(', ') || '(root only)'}`;

  const raw = await aiChat(systemPrompt, userPrompt);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in AI response');
    const parsed = JSON.parse(jsonMatch[0]) as Partial<OrganizeNoteResult>;

    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim() : 'Untitled',
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8) : [],
      links: Array.isArray(parsed.links) ? parsed.links.map(l => String(l).trim()).filter(Boolean) : [],
      folder: typeof parsed.folder === 'string' ? parsed.folder.trim() : '',
      content: typeof parsed.content === 'string' ? parsed.content : rawText,
    };
  } catch {
    console.warn('[AI] Failed to parse organize response:', raw.slice(0, 300));
    throw new Error('AI 응답을 파싱할 수 없습니다. 다시 시도해 주세요.');
  }
}

// ───────────────────────── Unified Chat ─────────────────────────

export async function aiChat(systemPrompt: string, userPrompt: string): Promise<string> {
  const preferredProvider = await getAiTagProvider();
  const fallbackOrder: AiTagProvider[] = ['codex', 'kimi', 'deepseek', 'ollama'];
  const providers: AiTagProvider[] = [
    preferredProvider,
    ...fallbackOrder.filter(provider => provider !== preferredProvider),
  ];
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      switch (provider) {
        case 'codex': return await codexChat(systemPrompt, userPrompt);
        case 'kimi': return await kimiChat(systemPrompt, userPrompt);
        case 'deepseek': return await deepseekChat(systemPrompt, userPrompt);
        case 'ollama':
        default: return await ollamaChat(systemPrompt, userPrompt);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${providerLabel(provider)}: ${message}`);
    }
  }

  throw new Error(`노트 AI 정리가 실패했습니다. 시도한 provider: ${errors.join(' | ')}`);
}
