import { invoke } from '@tauri-apps/api/core';
import { checkAtlasCloudKoriniModels, formatKoriniModelCheck } from './atlasCloudRuntime';
import { authorizeHarnessToolCall } from './guardrails';
import { searchHarnessTools } from './toolRegistry';
import { getWorkflowExecutionProfile, type WorkflowExecutionProfile } from './workflow';
import { buildLearningContext, searchAllLearning, searchDurableMemories, searchRelevantSkills, searchSessionRecall, searchTrajectoryRecall } from './learningRuntime';
import { gatherDefaultLearningContext } from './learningProviders';
import type { CliProvider } from './cliRuntime';
import {
  createOrReplaceFileBackedSkill,
  deleteFileBackedSkill,
  patchFileBackedSkill,
  removeFileBackedSkillAsset,
  writeFileBackedSkillAsset,
} from './learningSkillFilesystem';
import { exportLearningBundle, exportLearningDatagenBundle, exportLearningEvalBundle, runLearningEvalBundle } from './learningSessionStore';
import { loadHarnessProjectDocsContext } from './projectDocs';

function parseSkillManagerArgs(args: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new Error('skill_manager requires a JSON object argument.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('skill_manager requires a JSON object argument.');
  }
  return parsed as Record<string, unknown>;
}

function requireStringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`skill_manager requires a non-empty string field: ${key}`);
  }
  return value.trim();
}

function quoteShellArg(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function hasTrailingBackgroundAmp(command: string): boolean {
  const trimmed = command.trimEnd();
  return trimmed.endsWith('&') && !trimmed.endsWith('&&') && !trimmed.endsWith('\\&');
}

function looksLikeAsyncShellCommand(command: string): boolean {
  const trimmed = command.trim();
  const lower = trimmed.toLowerCase();
  return (
    /(?:^|[\s;])(?:nohup|start|start-process)\b/.test(lower)
    || /(?:^|[\s;])(?:pm2|forever)\s+start\b/.test(lower)
    || hasTrailingBackgroundAmp(trimmed)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/.test(lower)
    || /\b(?:vite|next\s+dev|astro\s+dev|webpack-dev-server)\b/.test(lower)
    || /\b(?:flask|uvicorn|fastapi|streamlit)\s+/.test(lower)
    || /\b(?:python|python3|py)\s+\S+\.(?:py|pyw)\b/.test(lower)
  );
}

function stripTrailingBackgroundAmp(command: string): string {
  const trimmed = command.trimEnd();
  return hasTrailingBackgroundAmp(trimmed) ? trimmed.slice(0, -1).trimEnd() : command.trim();
}

function backgroundShellCommand(command: string): { command: string; logPath: string } {
  const logPath = `.bbarit/background/bash-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
  const logDir = logPath.slice(0, logPath.lastIndexOf('/'));
  const body = stripTrailingBackgroundAmp(command);
  return {
    logPath,
    command: [
      `mkdir -p ${quoteShellArg(logDir)}`,
      `(${body}) > ${quoteShellArg(logPath)} 2>&1 < /dev/null & echo "Started background command pid=$! log=${logPath}"`,
    ].join('; '),
  };
}

function splitCommaArgs(args: string): string[] {
  return String(args || '')
    .split(',')
    .map(part => cleanToolArg(part))
    .filter(Boolean);
}

function cleanToolArg(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^path\s*[:=]\s*/i, '')
    .replace(/^file\s*[:=]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[\s\-*•]+/, '')
    .replace(/[;,，。]+$/g, '')
    .trim();
}

function resolveWorkDirPath(workDir: string, rawPath: string): string {
  const trimmed = cleanToolArg(rawPath);
  if (!trimmed || trimmed === '.') return workDir;
  return trimmed.startsWith('/') ? trimmed : `${workDir}/${trimmed}`;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function formatSearchResults(results: Array<{
  path: string;
  matches?: Array<{ line_number: number; line_text: string }>;
}>): string {
  return results.slice(0, 80).map((entry) => {
    const matches = entry.matches || [];
    if (matches.length === 0) return entry.path;
    return matches.map(match => `${entry.path}:${match.line_number}: ${match.line_text}`).join('\n');
  }).join('\n');
}

function parseEvalRunArgs(args: string): { provider?: CliProvider; limit?: number } {
  const raw = String(args || '').trim();
  if (!raw) return {};
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const out: { provider?: CliProvider; limit?: number } = {};
  for (const part of parts) {
    const [rawKey, rawValue] = part.includes('=') ? part.split('=', 2) : ['', part];
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (!key && ['atlascloud', 'claude-cli', 'codex-cli', 'kimi-cli', 'gemini-cli', 'qwen-cli'].includes(value)) {
      out.provider = 'atlascloud';
      continue;
    }
    if ((!key || key === 'limit') && /^\d+$/.test(value)) {
      out.limit = Math.max(1, Math.min(20, Number(value)));
      continue;
    }
    if (key === 'provider' && ['atlascloud', 'claude-cli', 'codex-cli', 'kimi-cli', 'gemini-cli', 'qwen-cli'].includes(value)) {
      out.provider = 'atlascloud';
    }
  }
  return out;
}

export async function executeHarnessTool(
  name: string,
  args: string,
  workDir: string,
  profile: WorkflowExecutionProfile = getWorkflowExecutionProfile(),
): Promise<{ result: string; error?: string }> {
  try {
    const decision = authorizeHarnessToolCall(name, args, workDir, {
      shellPermission: profile.shellPermission || 'standard',
    });
    if (!decision.allow) {
      return { result: '', error: decision.reason || `Guardrail denied (${decision.code})` };
    }

    switch (name) {
      case 'tool_search': {
        const tools = searchHarnessTools(args, 12);
        return {
          result: tools.length
            ? tools.map(tool => `@tool(${tool.name}, ${tool.args}) - ${tool.description}`).join('\n')
            : 'No matching tools found.',
        };
      }
      case 'project_context': {
        const context = await loadHarnessProjectDocsContext(workDir);
        return { result: context || 'No project default docs or project map were found.' };
      }
      case 'read_file': {
        const requestedPath = cleanToolArg(args);
        const path = resolveWorkDirPath(workDir, requestedPath);
        try {
          const content = await invoke<string>('read_file', { path });
          return { result: content.slice(0, 3000) + (content.length > 3000 ? '\n...(truncated)' : '') };
        } catch (error) {
          const name = basename(requestedPath);
          if (!name) throw error;
          const candidates = await invoke<Array<{ path: string; name: string; matches: unknown[]; is_name_match: boolean }>>('search_files', {
            root: workDir,
            query: name,
            searchContent: false,
            limit: 12,
          }).catch(() => []);
          const exactMatches = candidates.filter(candidate => (
            candidate.name === name
            && (!requestedPath.includes('/') || candidate.path.endsWith(`/${requestedPath}`))
          ));
          if (exactMatches.length === 1) {
            const resolvedPath = exactMatches[0].path;
            const content = await invoke<string>('read_file', { path: resolvedPath });
            return { result: `Resolved ${requestedPath} -> ${resolvedPath}\n\n${content.slice(0, 3000)}${content.length > 3000 ? '\n...(truncated)' : ''}` };
          }
          if (exactMatches.length > 1) {
            return { result: `Multiple files named ${name}. Use one full path:\n${exactMatches.map(candidate => candidate.path).join('\n')}` };
          }
          throw error;
        }
      }
      case 'write_file': {
        const firstNewline = args.indexOf('\n');
        const path = cleanToolArg(firstNewline > 0 ? args.slice(0, firstNewline) : args.split(',')[0]);
        const content = firstNewline > 0 ? args.slice(firstNewline + 1) : args.split(',').slice(1).join(',').trim();
        const fullPath = path.startsWith('/') ? path : `${workDir}/${path}`;
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (dir) await invoke('create_directory', { path: dir }).catch(() => {});
        await invoke('write_file', { path: fullPath, content });
        return { result: `File written: ${path} (${content.length} bytes)` };
      }
      case 'ls': {
        const requestedPath = cleanToolArg(args);
        const path = resolveWorkDirPath(workDir, requestedPath);
        try {
          const entries = await invoke<{ name: string; is_dir: boolean }[]>('read_directory', { path });
          return { result: entries.map(entry => `${entry.is_dir ? '📁' : '📄'} ${entry.name}`).join('\n') };
        } catch (error) {
          if (!requestedPath || requestedPath.includes('/')) throw error;
          const command = `find ${quoteShellArg(workDir)} -type d -name ${quoteShellArg(requestedPath)} -not -path '*/node_modules/*' -not -path '*/build_dist/*' -not -path '*/.git/*' 2>/dev/null | head -12`;
          const found = await invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs: 15 }).catch(() => '');
          const matches = found.split('\n').map(line => line.trim()).filter(Boolean);
          if (matches.length === 1) {
            const entries = await invoke<{ name: string; is_dir: boolean }[]>('read_directory', { path: matches[0] });
            return { result: `Resolved ${requestedPath} -> ${matches[0]}\n\n${entries.map(entry => `${entry.is_dir ? '📁' : '📄'} ${entry.name}`).join('\n')}` };
          }
          if (matches.length > 1) return { result: `Multiple directories named ${requestedPath}. Use one full path:\n${matches.join('\n')}` };
          throw error;
        }
      }
      case 'search_files': {
        const parts = args.split(',').map(part => cleanToolArg(part)).filter(Boolean);
        const root = parts.length >= 2 ? resolveWorkDirPath(workDir, parts[0]) : workDir;
        const query = parts.length >= 2 ? parts.slice(1).join(', ') : (parts[0] || '');
        if (!query) return { result: 'search_files requires a query. Example: @tool(search_files, hyperframes.json)' };
        const results = await invoke<Array<{ path: string; name: string; matches: Array<{ line_number: number; line_text: string }>; is_name_match: boolean }>>('search_files', {
          root,
          query,
          searchContent: true,
          limit: 80,
        });
        return { result: formatSearchResults(results || []) || 'No files found' };
      }
      case 'grep': {
        const [path, pattern] = args.split(',').map(part => part.trim());
        const grepPath = (path || workDir).startsWith('/') ? path || workDir : `${workDir}/${path}`;
        if (!pattern) return { result: 'grep requires a search pattern.' };
        const quotedPattern = quoteShellArg(pattern);
        const quotedPath = quoteShellArg(grepPath);
        const resultLimit = 80;
        const timeoutSecs = Math.max(20, Math.min(profile.toolBashTimeoutSecs, 60));
        const command = [
          'if command -v rg >/dev/null 2>&1; then',
          `rg -n --hidden --no-ignore-vcs --glob '!node_modules/**' --glob '!build_dist/**' --glob '!dist/**' --glob '!coverage/**' --glob '!.git/**' --glob '!*.map' -e ${quotedPattern} ${quotedPath} 2>/dev/null | head -${resultLimit};`,
          'else',
          `grep -RIn --exclude-dir=node_modules --exclude-dir=build_dist --exclude-dir=dist --exclude-dir=coverage --exclude-dir=.git --include='*.ts' --include='*.tsx' --include='*.rs' --include='*.js' --include='*.jsx' --include='*.json' --include='*.md' -- ${quotedPattern} ${quotedPath} 2>/dev/null | head -${resultLimit};`,
          'fi',
        ].join(' ');
        const result = await invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs });
        return { result: result || 'No matches' };
      }
      case 'code_search': {
        const firstComma = args.indexOf(',');
        const rawPath = firstComma >= 0 ? args.slice(0, firstComma).trim() : '';
        const query = (firstComma >= 0 ? args.slice(firstComma + 1) : args).trim();
        if (!query) return { result: 'code_search requires a query.' };
        const searchPath = (rawPath || workDir).startsWith('/') ? rawPath || workDir : `${workDir}/${rawPath}`;
        const quotedQuery = quoteShellArg(query);
        const quotedPath = quoteShellArg(searchPath);
        const resultLimit = 80;
        const timeoutSecs = Math.max(20, Math.min(profile.toolBashTimeoutSecs, 60));
        // 코딩비서 코드 검색: semble(하이브리드 BM25+시맨틱) 우선, 없으면 rg/grep fallback.
        // semble은 minishlab/potion-code-16M 임베딩 모델을 최초 1회 자동 다운로드한다.
        const command = [
          'if command -v semble_rs >/dev/null 2>&1; then',
          `semble_rs search ${quotedQuery} ${quotedPath} --compact 2>/dev/null | head -${resultLimit};`,
          'elif command -v rg >/dev/null 2>&1; then',
          `rg -n --hidden --no-ignore-vcs --glob '!node_modules/**' --glob '!.git/**' -e ${quotedQuery} ${quotedPath} 2>/dev/null | head -${resultLimit};`,
          'else',
          `grep -RIn --exclude-dir=node_modules --exclude-dir=.git -- ${quotedQuery} ${quotedPath} 2>/dev/null | head -${resultLimit};`,
          'fi',
        ].join(' ');
        const result = await invoke<string>('run_cli_oneshot', { command, workDir, timeoutSecs });
        return { result: result || 'No matches' };
      }
      case 'bash': {
        const command = args.trim();
        if (!command) return { result: 'bash requires a command.' };
        if (looksLikeAsyncShellCommand(command)) {
          const background = backgroundShellCommand(command);
          const result = await invoke<string>('run_cli_oneshot', {
            command: background.command,
            workDir,
            timeoutSecs: 0,
            login: false,
          });
          return {
            result: [
              (result || '').trim() || `Started background command log=${background.logPath}`,
              'The command is running asynchronously; it is not bound to the bash tool timeout.',
              `Read the log with: @tool(read_file, ${background.logPath})`,
            ].join('\n'),
          };
        }
        const result = await invoke<string>('run_cli_oneshot', {
          command,
          workDir,
          timeoutSecs: Math.max(profile.toolBashTimeoutSecs, 120),
        });
        return { result: (result || '').slice(0, 3000) };
      }
      case 'atlas_model_check': {
        const check = await checkAtlasCloudKoriniModels();
        return { result: formatKoriniModelCheck(check) };
      }
      case 'web_test': {
        const requested = args.trim();
        const command = requested || [
          'node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(\'package.json\',\'utf8\'));const s=p.scripts||{};console.log([s.build&&\'npm run build\',s.test&&\'npm test\',s.lint&&\'npm run lint\'].filter(Boolean).join(\' && \')||\'echo No package web test scripts found\')"',
          '| sh',
        ].join(' ');
        const result = await invoke<string>('run_cli_oneshot', {
          command,
          workDir,
          timeoutSecs: Math.max(profile.toolBashTimeoutSecs, 120),
        });
        return { result: (result || '').slice(0, 4000) || 'web_test finished with no output.' };
      }
      case 'web_screenshot': {
        const [rawUrl, rawOutput] = splitCommaArgs(args);
        const outputPath = rawOutput || '.bbarit/korini/web-check.png';
        const fullOutputPath = outputPath.startsWith('/') ? outputPath : `${workDir}/${outputPath}`;
        const quotedOut = quoteShellArg(fullOutputPath);
        const quotedUrl = quoteShellArg(rawUrl || '');
        const command = [
          `mkdir -p ${quoteShellArg(fullOutputPath.substring(0, fullOutputPath.lastIndexOf('/')) || workDir)};`,
          'if node -e "const p=require(\'./package.json\');process.exit(p.scripts&&p.scripts[\'dev:screen\']?0:1)" >/dev/null 2>&1; then',
          `npm run dev:screen -- screenshot --file ${quotedOut};`,
          `elif [ -n ${quotedUrl} ]; then`,
          `npx --yes playwright screenshot --full-page ${quotedUrl} ${quotedOut};`,
          'else',
          'echo "No dev:screen script found. Provide a URL, for example: @tool(web_screenshot, http://127.0.0.1:5173, .bbarit/korini/web-check.png)";',
          'fi',
        ].join(' ');
        const result = await invoke<string>('run_cli_oneshot', {
          command,
          workDir,
          timeoutSecs: Math.max(profile.toolBashTimeoutSecs, 120),
        });
        return { result: `${(result || '').slice(0, 3000)}\nScreenshot path: ${fullOutputPath}`.trim() };
      }
      case 'web_search': {
        const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.trim())}&format=json&no_html=1`;
        const res = await invoke<{ status: number; body: string }>('http_request', {
          input: { method: 'GET', url: searchUrl, headers: {}, timeout_ms: 10000 },
        });
        try {
          const data = JSON.parse(res.body);
          const results = (data.RelatedTopics || []).slice(0, 5).map((topic: any) => topic.Text || '').filter(Boolean);
          return { result: results.join('\n\n') || data.AbstractText || 'No results found' };
        } catch {
          return { result: res.body.slice(0, 1000) };
        }
      }
      case 'web_fetch': {
        const res = await invoke<{ status: number; body: string }>('http_request', {
          input: { method: 'GET', url: args.trim(), headers: {}, timeout_ms: 15000 },
        });
        return { result: res.body.slice(0, 3000) };
      }
      case 'learning_search': {
        const providerContext = await gatherDefaultLearningContext({
          workDir,
          query: args.trim(),
        }).catch(() => null);
        if (providerContext && (providerContext.memories.length > 0 || providerContext.skills.length > 0)) {
          const memoryBlock = providerContext.memories.slice(0, 8).map((entry, index) => (
            `[Memory ${index + 1}] ${entry.content}`
          )).join('\n\n');
          const skillBlock = providerContext.skills.slice(0, 4).map((entry, index) => (
            `[Skill ${index + 1}] ${entry.name}\nDescription: ${entry.description}\nProcedure: ${entry.command}`
          )).join('\n\n');
          return {
            result: [
              providerContext.sources.length ? `Sources: ${providerContext.sources.join(', ')}` : '',
              memoryBlock ? `Relevant memories:\n${memoryBlock}` : '',
              skillBlock ? `Relevant skills:\n${skillBlock}` : '',
            ].filter(Boolean).join('\n\n---\n\n').slice(0, 4000),
          };
        }

        const backendBundle = await searchAllLearning({ workDir, query: args.trim() });
        if (backendBundle) {
          const blocks = [
            backendBundle.memories.length
              ? `Durable memories:\n${backendBundle.memories.slice(0, 6).map((entry, index) => (
                `[Memory ${index + 1}] ${entry.source || 'memory'}\nPinned: ${entry.pinned ? 'yes' : 'no'}\n${entry.content}`
              )).join('\n\n')}`
              : '',
            backendBundle.sessions.length
              ? `Past sessions:\n${backendBundle.sessions.slice(0, 4).map((entry, index) => (
                `[Session ${index + 1}] ${entry.title || 'Untitled'}\nUser: ${entry.userMessage}\nRecall: ${entry.assistantSummary}`
              )).join('\n\n')}`
              : '',
            backendBundle.trajectories.length
              ? `Trajectories:\n${backendBundle.trajectories.slice(0, 3).map((entry, index) => (
                `[Trajectory ${index + 1}] ${entry.title || 'Untitled'}\nMode: ${entry.mode} | Provider: ${entry.provider}\nReview: ${(entry.reviewJson || 'No stored review').slice(0, 400)}`
              )).join('\n\n')}`
              : '',
            backendBundle.skills.length
              ? `Learned skills:\n${backendBundle.skills.slice(0, 4).map((entry, index) => (
                `[Skill ${index + 1}] ${entry.name}\nDescription: ${entry.description}\nProcedure: ${entry.command}`
              )).join('\n\n')}`
              : '',
          ].filter(Boolean);
          if (blocks.length === 0) {
            return { result: 'No relevant learned context found.' };
          }
          return {
            result: [
              backendBundle.sources.length ? `Sources: ${backendBundle.sources.join(', ')}` : '',
              ...blocks,
            ].filter(Boolean).join('\n\n---\n\n').slice(0, 4000),
          };
        }

        const context = await buildLearningContext({ workDir, query: args.trim() });
        if (context.memories.length === 0 && context.skills.length === 0) {
          return { result: 'No relevant learned context found.' };
        }
        const memoryBlock = context.memories.slice(0, 8).map((entry, index) => (
          `[Memory ${index + 1}] ${entry.content}`
        )).join('\n\n');
        const skillBlock = context.skills.slice(0, 4).map((entry, index) => (
          `[Skill ${index + 1}] ${entry.name}\nDescription: ${entry.description}\nProcedure: ${entry.command}`
        )).join('\n\n');
        return {
          result: [
            context.sources.length ? `Sources: ${context.sources.join(', ')}` : '',
            memoryBlock ? `Relevant memories:\n${memoryBlock}` : '',
            skillBlock ? `Relevant skills:\n${skillBlock}` : '',
          ].filter(Boolean).join('\n\n---\n\n').slice(0, 4000),
        };
      }
      case 'memory_search': {
        const results = await searchDurableMemories(workDir, args.trim(), 6);
        if (results.length === 0) {
          return { result: 'No relevant durable memories found.' };
        }
        return {
          result: results.map((entry, index) => (
            `[${index + 1}] ${entry.source || 'memory'}\n` +
            `Pinned: ${entry.pinned ? 'yes' : 'no'}\n` +
            `Memory: ${entry.content}`
          )).join('\n\n---\n\n').slice(0, 4000),
        };
      }
      case 'session_search': {
        const results = await searchSessionRecall(workDir, args.trim());
        if (results.length === 0) {
          return { result: 'No relevant past sessions found.' };
        }
        return {
          result: results.map((entry, index) => (
            `[${index + 1}] ${entry.title || 'Untitled'}\n` +
            `User: ${entry.userMessage}\n` +
            `Recall: ${entry.assistantSummary}\n` +
            `${entry.savedFiles.length ? `Files: ${entry.savedFiles.join(', ')}\n` : ''}` +
            `${entry.toolNames.length ? `Tools: ${entry.toolNames.join(', ')}` : ''}`
          )).join('\n\n---\n\n').slice(0, 4000),
        };
      }
      case 'trajectory_search': {
        const results = await searchTrajectoryRecall(workDir, args.trim());
        if (results.length === 0) {
          return { result: 'No relevant learning trajectories found.' };
        }
        return {
          result: results.map((entry, index) => (
            `[${index + 1}] ${entry.title || 'Untitled'}\n` +
            `Mode: ${entry.mode} | Provider: ${entry.provider}\n` +
            `Review: ${(entry.reviewJson || 'No stored review').slice(0, 700)}\n` +
            `Messages: ${entry.messagesJson.slice(0, 900)}`
          )).join('\n\n---\n\n').slice(0, 4000),
        };
      }
      case 'skill_search': {
        const results = await searchRelevantSkills(workDir, args.trim());
        if (results.length === 0) {
          return { result: 'No relevant learned skills found.' };
        }
        return {
          result: results.map((entry, index) => (
            `[${index + 1}] ${entry.name}\n` +
            `Description: ${entry.description}\n` +
            `Procedure: ${entry.command}\n` +
            `Provider: ${entry.cliType}`
          )).join('\n\n---\n\n').slice(0, 4000),
        };
      }
      case 'learning_eval_run': {
        const parsed = parseEvalRunArgs(args);
        const provider = parsed.provider || 'atlascloud';
        const { path, report } = await runLearningEvalBundle({
          workDir,
          provider,
          limit: parsed.limit ?? 5,
          timeoutSecs: Math.max(30, profile.summaryTimeoutSecs),
        });
        return {
          result: [
            `Eval report saved: ${path}`,
            `Provider: ${provider}`,
            `Cases: ${report.caseCount}`,
            `Passed: ${report.passedCount}/${report.caseCount}`,
            `Average score: ${report.averageScore.toFixed(2)}`,
            '',
            ...report.results.slice(0, 5).map((item, index) => (
              `[Case ${index + 1}] ${item.title}\nKind: ${item.kind}\nScore: ${item.score.toFixed(2)}\nPassed: ${item.passed ? 'yes' : 'no'}`
            )),
          ].join('\n'),
        };
      }
      case 'skill_manager': {
        const input = parseSkillManagerArgs(args);
        const action = String(input.action || '').trim().toLowerCase();
        switch (action) {
          case 'create':
          case 'edit': {
            const name = requireStringField(input, 'name');
            const description = requireStringField(input, 'description');
            const procedure = requireStringField(input, 'procedure');
            const cliType = typeof input.cliType === 'string' ? input.cliType.trim() : undefined;
            const path = await createOrReplaceFileBackedSkill({ workDir, name, description, procedure, cliType });
            return { result: `Skill ${action === 'create' ? 'saved' : 'updated'}: ${name}\nPath: ${path}` };
          }
          case 'patch': {
            const name = requireStringField(input, 'name');
            const find = requireStringField(input, 'find');
            const replace = typeof input.replace === 'string' ? input.replace : '';
            const path = await patchFileBackedSkill({ workDir, name, find, replace });
            return { result: `Skill patched: ${name}\nPath: ${path}` };
          }
          case 'write_file': {
            const name = requireStringField(input, 'name');
            const relativePath = requireStringField(input, 'relativePath');
            const content = typeof input.content === 'string' ? input.content : '';
            const path = await writeFileBackedSkillAsset({ workDir, name, relativePath, content });
            return { result: `Skill file written: ${path}` };
          }
          case 'remove_file': {
            const name = requireStringField(input, 'name');
            const relativePath = requireStringField(input, 'relativePath');
            const path = await removeFileBackedSkillAsset({ workDir, name, relativePath });
            return { result: `Skill file removed: ${path}` };
          }
          case 'delete': {
            const name = requireStringField(input, 'name');
            const path = await deleteFileBackedSkill(workDir, name);
            return { result: `Skill deleted: ${name}\nPath: ${path}` };
          }
          default:
            return {
              result: '',
              error:
                'skill_manager action must be one of: create, edit, patch, write_file, remove_file, delete.',
            };
        }
      }
      case 'skill_create': {
        const firstNewline = args.indexOf('\n');
        const header = (firstNewline >= 0 ? args.slice(0, firstNewline) : args).split(',').map((part) => part.trim());
        const procedure = firstNewline >= 0 ? args.slice(firstNewline + 1).trim() : '';
        const [name, description] = header;
        if (!name || !description || !procedure) {
          return { result: '', error: 'skill_create requires name, description, and procedure body.' };
        }
        const path = await createOrReplaceFileBackedSkill({ workDir, name, description, procedure });
        return { result: `Skill saved: ${name}\nPath: ${path}` };
      }
      case 'skill_patch': {
        const [name, find, replace] = args.split(',').map((part) => part.trim());
        if (!name || !find) {
          return { result: '', error: 'skill_patch requires name, find, replace.' };
        }
        const path = await patchFileBackedSkill({ workDir, name, find, replace: replace || '' });
        return { result: `Skill patched: ${name}\nPath: ${path}` };
      }
      case 'skill_write_file': {
        const firstNewline = args.indexOf('\n');
        const header = (firstNewline >= 0 ? args.slice(0, firstNewline) : args).split(',').map((part) => part.trim());
        const content = firstNewline >= 0 ? args.slice(firstNewline + 1) : '';
        const [name, relativePath] = header;
        if (!name || !relativePath) {
          return { result: '', error: 'skill_write_file requires name and relative_path.' };
        }
        const path = await writeFileBackedSkillAsset({ workDir, name, relativePath, content });
        return { result: `Skill file written: ${path}` };
      }
      case 'skill_remove_file': {
        const [name, relativePath] = args.split(',').map((part) => part.trim());
        if (!name || !relativePath) {
          return { result: '', error: 'skill_remove_file requires name and relative_path.' };
        }
        const path = await removeFileBackedSkillAsset({ workDir, name, relativePath });
        return { result: `Skill file removed: ${path}` };
      }
      case 'skill_delete': {
        const name = args.trim();
        if (!name) {
          return { result: '', error: 'skill_delete requires a skill name.' };
        }
        const path = await deleteFileBackedSkill(workDir, name);
        return { result: `Skill deleted: ${name}\nPath: ${path}` };
      }
      case 'learning_export': {
        const result = await exportLearningBundle(workDir);
        return {
          result:
            `Learning bundle exported.\n` +
            `Path: ${result.path}\n` +
            `Memories: ${result.bundle.memories.length}\n` +
            `Skills: ${result.bundle.skills.length}\n` +
            `Sessions: ${result.bundle.sessions.length}\n` +
            `Trajectories: ${result.bundle.trajectories.length}`,
        };
      }
      case 'learning_eval_export': {
        const result = await exportLearningEvalBundle(workDir);
        return {
          result:
            `Learning eval bundle exported.\n` +
            `Path: ${result.path}\n` +
            `Cases: ${result.bundle.cases.length}\n` +
            `Kinds: session-replay, trajectory-replay`,
        };
      }
      case 'learning_datagen_export': {
        const result = await exportLearningDatagenBundle(workDir);
        const kinds = Array.from(new Set(result.bundle.cases.map((item) => item.kind)));
        return {
          result:
            `Learning datagen bundle exported.\n` +
            `Path: ${result.path}\n` +
            `Cases: ${result.bundle.cases.length}\n` +
            `Kinds: ${kinds.join(', ')}`,
        };
      }
      case 'ask_user': {
        return { result: `[CLARIFICATION NEEDED] ${args.trim()}` };
      }
      default:
        return { result: '', error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { result: '', error: String(err) };
  }
}
