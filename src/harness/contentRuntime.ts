import { invoke } from '@tauri-apps/api/core';
import { extractFilePaths } from '../components/harness-utils';
import { runCliPrompt, type CliProvider } from './cliRuntime';
import { ensureKoriniProjectDeliverables } from './koriniDeliverables';

export async function autoSaveFiles(content: string, workDir: string): Promise<string[]> {
  const saved: string[] = [];
  const files = extractFilePaths(content);
  for (const file of files) {
    try {
      const fullPath = file.path.startsWith('/') ? file.path : `${workDir}/${file.path}`;
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      if (dir) await invoke('create_directory', { path: dir }).catch(() => {});
      await invoke('write_file', { path: fullPath, content: file.content });
      saved.push(file.path);
    } catch (err) {
      console.warn('[HarnessContent] autosave failed:', file.path, err);
    }
  }
  if (saved.length > 0) {
    const generated = await ensureKoriniProjectDeliverables(workDir, {
      changedFiles: saved,
      finalSummary: content,
      workflowName: '코린이 직접 저장',
    });
    return Array.from(new Set([...saved, ...generated]));
  }
  return saved;
}

export async function generateFollowupsAi(
  userMsg: string,
  aiResponse: string,
  provider: CliProvider,
  workDir: string,
): Promise<string[]> {
  const prompt = `Based on this conversation, suggest exactly 3 short follow-up questions the user might ask next. Reply with ONLY a JSON array of 3 strings, no explanation.\n\nUser: ${userMsg.slice(0, 200)}\nAssistant: ${aiResponse.slice(0, 500)}`;

  try {
    const result = await runCliPrompt(provider, prompt, workDir, 60);
    const match = result.match(/\[[\s\S]*?\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]) as string[];
        return arr.filter(item => typeof item === 'string' && item.length > 3).slice(0, 3);
      } catch {
        // fall through
      }
    }
    const lines = result
      .split(/\n/)
      .map(line => line.replace(/^\s*[\d*•-]+[.)]?\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(line => line.length > 5 && line.length < 100);
    if (lines.length > 0) return lines.slice(0, 3);
  } catch {
    // ignore
  }

  return [];
}
