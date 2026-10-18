import { describe, it, expect } from 'vitest';
import {
  renderMarkdown,
  extractArtifacts,
  extractTodos,
  parseToolCalls,
  extractFileBlocks,
  extractFilePaths,
  parseSelectionOptions,
  compactAgentHandoff,
  isSuspiciousAgentResponse,
  sanitizeCliOutput,
  stripSelectionPayload,
  shouldStartWorkflowForRequest,
  shouldBypassWorkflowForRequest,
  genId,
} from './harness-utils';

// ── genId ──

describe('genId', () => {
  it('should generate unique IDs', () => {
    const a = genId();
    const b = genId();
    expect(a).not.toBe(b);
  });

  it('should return a string', () => {
    expect(typeof genId()).toBe('string');
  });

  it('should be non-empty', () => {
    expect(genId().length).toBeGreaterThan(5);
  });
});

// ── renderMarkdown ──

describe('renderMarkdown', () => {
  it('should render bold text', () => {
    expect(renderMarkdown('**hello**')).toContain('<strong>hello</strong>');
  });

  it('should render italic text', () => {
    expect(renderMarkdown('*hello*')).toContain('<em>hello</em>');
  });

  it('should render inline code', () => {
    expect(renderMarkdown('use `console.log`')).toContain('<code>console.log</code>');
  });

  it('should render headings', () => {
    expect(renderMarkdown('# Title')).toContain('<h1>Title</h1>');
    expect(renderMarkdown('## Subtitle')).toContain('<h2>Subtitle</h2>');
    expect(renderMarkdown('### Section')).toContain('<h3>Section</h3>');
  });

  it('should render list items in ul', () => {
    const result = renderMarkdown('- item1\n- item2');
    expect(result).toContain('<li>item1</li>');
    expect(result).toContain('<ul>');
  });

  it('should render code blocks with language', () => {
    const result = renderMarkdown('```typescript\nconst x = 1;\n```');
    expect(result).toContain('<pre><code class="lang-typescript">');
    expect(result).toContain('const x = 1;');
  });

  it('should escape HTML in regular text', () => {
    const result = renderMarkdown('use <div> tag');
    expect(result).toContain('&lt;div&gt;');
    expect(result).not.toContain('<div>');
  });

  it('should preserve code block content without double-escaping', () => {
    const result = renderMarkdown('```html\n<div>hello</div>\n```');
    expect(result).toContain('&lt;div&gt;hello&lt;/div&gt;');
  });

  it('should render blockquotes', () => {
    const result = renderMarkdown('> important note');
    expect(result).toContain('<blockquote>important note</blockquote>');
  });

  it('should convert newlines to br', () => {
    const result = renderMarkdown('line1\nline2');
    expect(result).toContain('<br/>');
  });

  it('should handle empty string', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('should handle mixed markdown', () => {
    const input = '# Title\n\n**bold** and *italic*\n\n- item1\n- item2\n\n`code`';
    const result = renderMarkdown(input);
    expect(result).toContain('<h1>');
    expect(result).toContain('<strong>');
    expect(result).toContain('<em>');
    expect(result).toContain('<li>');
    expect(result).toContain('<code>');
  });
});

// ── extractArtifacts ──

describe('extractArtifacts', () => {
  it('should extract code blocks with sufficient length', () => {
    const content = '```typescript\n' + 'const x = 1;\n'.repeat(10) + '```';
    const artifacts = extractArtifacts(content);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].language).toBe('typescript');
    expect(artifacts[0].filename).toBe('artifact.ts');
  });

  it('should skip short code blocks', () => {
    const content = '```js\nshort\n```';
    expect(extractArtifacts(content).length).toBe(0);
  });

  it('should not turn executable shell blocks into downloadable artifacts', () => {
    const content = '```bash\n' + 'find . -maxdepth 2 -type f\n'.repeat(3) + '```';
    expect(extractArtifacts(content)).toEqual([]);
  });

  it('should extract multiple artifacts', () => {
    const long = 'x'.repeat(60);
    const content = `\`\`\`python\n${long}\n\`\`\`\n\n\`\`\`rust\n${long}\n\`\`\``;
    const artifacts = extractArtifacts(content);
    expect(artifacts.length).toBe(2);
    expect(artifacts[0].language).toBe('python');
    expect(artifacts[1].language).toBe('rust');
  });

  it('should map language extensions correctly', () => {
    const long = 'x'.repeat(60);
    const content = `\`\`\`javascript\n${long}\n\`\`\``;
    expect(extractArtifacts(content)[0].filename).toBe('artifact.js');
  });

  it('should handle no code blocks', () => {
    expect(extractArtifacts('just plain text')).toEqual([]);
  });

  it('should default to text for unknown language', () => {
    const long = 'x'.repeat(60);
    const content = `\`\`\`\n${long}\n\`\`\``;
    expect(extractArtifacts(content)[0].language).toBe('text');
  });
});

// ── extractTodos ──

describe('extractTodos', () => {
  it('should extract numbered list as todos', () => {
    const content = '1. First task to complete\n2. Second task to complete';
    const todos = extractTodos(content);
    expect(todos.length).toBe(2);
    expect(todos[0].text).toBe('First task to complete');
    expect(todos[0].status).toBe('pending');
  });

  it('should extract checkbox todos', () => {
    const content = '- [x] Completed task here\n- [ ] Pending task here';
    const todos = extractTodos(content);
    expect(todos.length).toBe(2);
    expect(todos[0].status).toBe('completed');
    expect(todos[1].status).toBe('pending');
  });

  it('should require at least 2 items', () => {
    const content = '1. Only one task';
    expect(extractTodos(content).length).toBe(0);
  });

  it('should skip very short items', () => {
    const content = '1. ab\n2. cd';
    expect(extractTodos(content).length).toBe(0);
  });

  it('should handle bullet list', () => {
    const content = '- Do something important\n- Do another thing here';
    const todos = extractTodos(content);
    expect(todos.length).toBe(2);
  });

  it('should handle no todos', () => {
    expect(extractTodos('plain text no list')).toEqual([]);
  });
});

// ── parseToolCalls ──

describe('parseToolCalls', () => {
  it('should parse single tool call', () => {
    const content = '@tool(read_file, src/main.ts)';
    const calls = parseToolCalls(content);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].args).toBe('src/main.ts');
  });

  it('should parse tool calls without arguments', () => {
    const calls = parseToolCalls('@tool(ls)');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('ls');
    expect(calls[0].args).toBe('');
  });

  it('should parse multiple tool calls', () => {
    const content = '@tool(read_file, a.ts)\n@tool(bash, npm test)';
    const calls = parseToolCalls(content);
    expect(calls.length).toBe(2);
    expect(calls[0].name).toBe('read_file');
    expect(calls[1].name).toBe('bash');
    expect(calls[1].args).toBe('npm test');
  });

  it('should handle no tool calls', () => {
    expect(parseToolCalls('no tools here')).toEqual([]);
  });

  it('should parse web_search', () => {
    const content = '@tool(web_search, React best practices)';
    const calls = parseToolCalls(content);
    expect(calls[0].name).toBe('web_search');
    expect(calls[0].args).toBe('React best practices');
  });

  it('should parse tool with multiline args', () => {
    const content = '@tool(write_file, src/hello.ts\nconsole.log("hi"))';
    const calls = parseToolCalls(content);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('write_file');
  });

  it('should preserve the full matched line', () => {
    const content = '@tool(ls, src)';
    const calls = parseToolCalls(content);
    expect(calls[0].line).toBe('@tool(ls, src)');
  });
});

// ── extractFilePaths ──

describe('extractFilePaths', () => {
  it('should extract file paths from code blocks', () => {
    const content = '```src/index.html\n<html></html>\n```';
    const files = extractFilePaths(content);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('src/index.html');
    expect(files[0].content).toBe('<html></html>\n');
  });

  it('should skip non-file language tags', () => {
    const content = '```typescript\nconst x = 1;\n```';
    expect(extractFilePaths(content).length).toBe(0);
  });

  it('should extract .md files', () => {
    const content = '```README.md\n# Hello\n```';
    const files = extractFilePaths(content);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe('README.md');
  });

  it('should extract multiple files', () => {
    const content = '```src/a.ts\ncode1\n```\n```src/b.ts\ncode2\n```';
    const files = extractFilePaths(content);
    expect(files.length).toBe(2);
  });

  it('should handle no files', () => {
    expect(extractFilePaths('no code blocks')).toEqual([]);
  });

  it('should extract .txt files', () => {
    const content = '```notes.txt\nsome notes\n```';
    expect(extractFilePaths(content).length).toBe(1);
  });
});

describe('extractFileBlocks', () => {
  it('should extract broad file blocks for implementation drafts', () => {
    const blocks = extractFileBlocks('```src/app.ts\nconsole.log(1)\n```');
    expect(blocks).toEqual([{ path: 'src/app.ts', content: 'console.log(1)\n' }]);
  });
});

// ── parseSelectionOptions ──

describe('parseSelectionOptions', () => {
  it('should parse spec options json', () => {
    const content = [
      'Summary',
      'SPEC_OPTIONS_JSON: [{"title":"A","summary":"fast","spec":"use route a"},{"title":"B","summary":"safe","spec":"use route b"}]',
    ].join('\n');
    const options = parseSelectionOptions(content);
    expect(options).toHaveLength(2);
    expect(options[0].title).toBe('A');
    expect(options[1].spec).toBe('use route b');
  });

  it('should support custom markers', () => {
    const content = 'PLAN_OPTIONS_JSON: [{"title":"Polish","summary":"ui","spec":"ship ui polish"}]';
    const options = parseSelectionOptions(content, 'PLAN_OPTIONS_JSON');
    expect(options).toHaveLength(1);
    expect(options[0].title).toBe('Polish');
  });

  it('should fall back to a default option when json is missing', () => {
    const content = 'Plain text result without JSON';
    const options = parseSelectionOptions(content, 'SPEC_OPTIONS_JSON', 'Default choice', 'fallback summary');
    expect(options).toHaveLength(1);
    expect(options[0].title).toBe('Default choice');
    expect(options[0].summary).toBe('fallback summary');
    expect(options[0].spec).toBe('Plain text result without JSON');
  });
});

// ── compactAgentHandoff ──

describe('compactAgentHandoff', () => {
  it('should keep short text unchanged', () => {
    expect(compactAgentHandoff('hello', 20)).toBe('hello');
  });

  it('should truncate long text', () => {
    const longText = 'x'.repeat(50);
    expect(compactAgentHandoff(longText, 10)).toContain('[truncated]');
  });
});

// ── isSuspiciousAgentResponse ──

describe('isSuspiciousAgentResponse', () => {
  it('should flag generic english greetings', () => {
    expect(isSuspiciousAgentResponse('Hello! How can I help you today?')).toBe(true);
  });

  it('should flag generic korean greetings', () => {
    expect(isSuspiciousAgentResponse('안녕하세요! 무엇을 도와드릴까요?')).toBe(true);
  });

  it('should allow structured content', () => {
    expect(isSuspiciousAgentResponse('Summary\n- Investigated file A\n- Proposed option B')).toBe(false);
  });
});

// ── sanitizeCliOutput ──

describe('sanitizeCliOutput', () => {
  it('should strip traced kimi blocks from output', () => {
    const content = [
      'TurnBegin(',
      "  user_input='hello'",
      ')',
      'StepBegin(n=1)',
      ')',
      'Summary',
      '- useful answer',
    ].join('\n');
    expect(sanitizeCliOutput(content)).toBe('Summary\n- useful answer');
  });

  it('should strip workflow summary trace lines', () => {
    expect(sanitizeCliOutput('Research → Plan → Implement → Review\nHello')).toBe('Hello');
  });
});

describe('stripSelectionPayload', () => {
  it('should remove inline spec option payloads', () => {
    const content = [
      'Summary',
      'Readable explanation',
      'SPEC_OPTIONS_JSON: [{"title":"A","summary":"fast","spec":"route a"}]',
    ].join('\n');
    expect(stripSelectionPayload(content)).toBe('Summary\nReadable explanation');
  });

  it('should remove fenced plan option payloads', () => {
    const content = [
      'Plan overview',
      'PLAN_OPTIONS_JSON:',
      '```json',
      '[{"title":"Bundle","summary":"ship it","spec":"do it"}]',
      '```',
    ].join('\n');
    expect(stripSelectionPayload(content)).toBe('Plan overview');
  });
});

// ── shouldBypassWorkflowForRequest ──

describe('shouldBypassWorkflowForRequest', () => {
  it('should bypass workflow for greetings', () => {
    expect(shouldBypassWorkflowForRequest('안녕')).toBe(true);
    expect(shouldBypassWorkflowForRequest('hello')).toBe(true);
  });

  it('should bypass workflow for architecture questions', () => {
    expect(shouldBypassWorkflowForRequest('이 프로젝트의 아키텍처를 설명해줘')).toBe(true);
  });

  it('should bypass workflow for structure questions', () => {
    expect(shouldBypassWorkflowForRequest('What is the structure of this project?')).toBe(true);
  });

  it('should keep workflow for implementation requests', () => {
    expect(shouldBypassWorkflowForRequest('대대적인 영상편집 기능을 구현해줘')).toBe(false);
  });
});

describe('shouldStartWorkflowForRequest', () => {
  it('should start workflow for explicit implementation requests', () => {
    expect(shouldStartWorkflowForRequest('대대적인 영상편집 기능을 구현해줘')).toBe(true);
  });

  it('should not start workflow for casual greetings', () => {
    expect(shouldStartWorkflowForRequest('안녕')).toBe(false);
  });

  it('should start workflow for short follow-up when prior context exists', () => {
    expect(shouldStartWorkflowForRequest('그럼 진행해줘', [
      '우리는 코딩비서가 설명 질문에는 바로 답하고 구현 요청일 때만 작업 흐름을 시작하게 만들고 싶다.',
      '또 Kimi 내부 추적 로그가 사용자에게 그대로 보이지 않도록 막아야 한다.',
    ])).toBe(true);
  });
});
