/**
 * AgentChatPanel: Codex-app-style chat UI for the embedded BBARIT agent.
 *
 * Instead of a PTY terminal, this spawns the agent in JSON-RPC mode
 * (`--mode rpc`, see bbarit-agent/src/rpc.rs) via the `agent_rpc_*` Tauri
 * commands and renders the structured event stream: streaming text deltas,
 * finalized messages, and tool executions as collapsible cards.
 *
 * Layout: a left sidebar lists this project's agent sessions (작업 목록) —
 * click to open one (transcript reloads via get_messages), pencil to rename
 * the active one. The header menu exposes the agent's FULL command set
 * (built-ins + prompts + skills + extensions via get_commands).
 *
 * Modes wrap the outgoing prompt in the agent's own slash commands:
 *  - 일반    → plain prompt
 *  - 하네스  → /harness <task>   (plan → develop → review pipeline)
 *  - 멀티    → /orchestrate a | b (each line becomes a parallel sub-agent task)
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import * as LucideIcons from 'lucide-react';
import MarkdownIt from 'markdown-it';
import { useTranslation } from '../i18n';
import { useConfig } from '../config/ConfigContext';
import { normalizeBbaritAgentLanguage } from '../terminal/bbaritAgentLanguage';
import { personaIconUrl, type BbaritPersonaEntry } from '../terminal/bbaritAgentPersonaProfile';
import { isImagePath, looksLikeFilePath, insertTextAtSelection } from './filePathInsert';
import { BbaritPersonaPickerModal } from './BbaritPersonaPickerModal';
import './AgentChatPanel.css';

interface Entry {
  kind: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  toolName?: string;
  isError?: boolean;
}

interface SessionItem {
  id: string;
  name: string;
  messages: string;
  createdAt: string;
  path: string;
}

interface CommandItem {
  name: string;
  description: string;
  source: string;
  needsArg?: boolean;
}

interface TodoItem {
  status: 'done' | 'doing' | 'pending';
  text: string;
}

/// 사이드바의 1차 작업 단위: 사용자가 보낸 명령 하나 = 작업 하나.
/// 이름은 명령의 첫 줄, 위치(entryIndex)는 그 명령의 트랜스크립트 인덱스.
interface CommandTask {
  text: string;
  status: 'doing' | 'done' | 'failed' | 'cancelled';
  entryIndex: number;
  /// 이 작업을 실행한 페르소나 (주입돼 있었다면) — 목록에 뱃지로 표시.
  persona?: string;
}

/// 명령에서 작업명 뽑기: 멀티라인 배치 래퍼는 첫 불릿, 아니면 첫 줄.
function taskLabel(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const bullet = lines.find((l) => l.startsWith('- '));
  const base = (lines[0]?.endsWith(':') && bullet ? bullet.slice(2) : lines[0]) || message;
  const extra = lines.filter((l) => l.startsWith('- ')).length;
  const suffix = extra > 1 ? ` 외 ${extra - 1}` : '';
  return base.slice(0, 60) + suffix;
}

/// The agent's `todo` tool prints its list with ✓ / ▶ / ○ markers — parse it
/// into the sidebar's 작업 목록.
function parseTodoItems(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([✓▶○])\s*(.+)$/);
    if (!m) continue;
    items.push({
      status: m[1] === '✓' ? 'done' : m[1] === '▶' ? 'doing' : 'pending',
      text: m[2],
    });
  }
  return items;
}

/// 미니 구문강조기 — 문자열/주석/숫자/키워드/함수호출을 언어 불문 공통
/// 규칙으로 토큰화. (TUI의 syntect에 대응하는 패널 쪽 경량판)
const HL_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'pub', 'use', 'impl', 'struct', 'enum', 'match', 'if', 'else', 'for',
  'while', 'loop', 'return', 'const', 'static', 'async', 'await', 'function', 'var', 'class',
  'import', 'export', 'from', 'def', 'type', 'interface', 'extends', 'new', 'try', 'catch',
  'throw', 'switch', 'case', 'break', 'continue', 'true', 'false', 'null', 'None', 'self',
  'this', 'in', 'of', 'and', 'or', 'not', 'do', 'end', 'void', 'string', 'number', 'boolean',
]);

type HlToken = { cls: string | null; text: string };

function tokenizeCodeLine(line: string): HlToken[] {
  const tokens: HlToken[] = [];
  let i = 0;
  let plain = '';
  const flush = () => {
    if (plain) {
      tokens.push({ cls: null, text: plain });
      plain = '';
    }
  };
  while (i < line.length) {
    const c = line[i];
    const two = line.slice(i, i + 2);
    if (two === '//' || two === '--' || c === '#') {
      flush();
      tokens.push({ cls: 'hl-comment', text: line.slice(i) });
      return tokens;
    }
    if (c === '"' || c === "'" || c === '`') {
      flush();
      let s = c;
      i += 1;
      while (i < line.length) {
        s += line[i];
        if (line[i] === '\\' && i + 1 < line.length) {
          s += line[i + 1];
          i += 2;
          continue;
        }
        if (line[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ cls: 'hl-str', text: s });
      continue;
    }
    if (/[0-9]/.test(c) && (!plain || !/[A-Za-z0-9_]/.test(plain[plain.length - 1]))) {
      flush();
      let n = '';
      while (i < line.length && /[0-9a-fA-Fx_.]/.test(line[i])) {
        n += line[i];
        i += 1;
      }
      tokens.push({ cls: 'hl-num', text: n });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let w = '';
      while (i < line.length && /[A-Za-z0-9_]/.test(line[i])) {
        w += line[i];
        i += 1;
      }
      if (HL_KEYWORDS.has(w)) {
        flush();
        tokens.push({ cls: 'hl-kw', text: w });
      } else if (line[i] === '(') {
        flush();
        tokens.push({ cls: 'hl-fn', text: w });
      } else {
        plain += w;
      }
      continue;
    }
    plain += c;
    i += 1;
  }
  flush();
  return tokens;
}

function highlightCodeSpans(line: string, keyPrefix: string) {
  return tokenizeCodeLine(line).map((token, i) =>
    token.cls ? (
      <span key={`${keyPrefix}-${i}`} className={token.cls}>{token.text}</span>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{token.text}</span>
    ),
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/// markdown-it 코드펜스용: 토큰을 HTML 스팬으로.
function highlightToHtml(code: string): string {
  return code
    .split('\n')
    .map((line) =>
      tokenizeCodeLine(line)
        .map((token) =>
          token.cls
            ? `<span class="${token.cls}">${escapeHtml(token.text)}</span>`
            : escapeHtml(token.text),
        )
        .join(''),
    )
    .join('\n');
}

/// 단어단위 반전: 인접한 `- old` / `+ new` 쌍에서 공통 접두/접미를 뺀
/// 바뀐 가운데만 반전(배경색) 표시. (old행, new행) 스팬을 돌려준다.
function intraLineDiff(oldBody: string, newBody: string) {
  let prefix = 0;
  while (prefix < oldBody.length && prefix < newBody.length && oldBody[prefix] === newBody[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldBody.length - prefix &&
    suffix < newBody.length - prefix &&
    oldBody[oldBody.length - 1 - suffix] === newBody[newBody.length - 1 - suffix]
  )
    suffix += 1;
  const seg = (body: string, invCls: string, key: string) => (
    <>
      <span key={`${key}-h`}>{body.slice(0, prefix)}</span>
      <span key={`${key}-m`} className={invCls}>{body.slice(prefix, body.length - suffix)}</span>
      <span key={`${key}-t`}>{body.slice(body.length - suffix)}</span>
    </>
  );
  return {
    oldSpans: seg(oldBody, 'tl-inv-del', 'o'),
    newSpans: seg(newBody, 'tl-inv-add', 'n'),
  };
}

/// 어시스턴트 답변용 마크다운 렌더러 — 제목/굵게/코드블록/리스트/표가
/// 생 텍스트 대신 서식으로 보인다. html:false라 원문 HTML은 이스케이프되고,
/// 링크는 창 내비게이션 사고를 막기 위해 스팬으로 렌더한다.
const assistantMd = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
  highlight: (code) => highlightToHtml(code),
});
assistantMd.renderer.rules.link_open = () => '<span class="md-link">';
assistantMd.renderer.rules.link_close = () => '</span>';

/// 스트리밍/답변에 섞여 오는 툴 진행 라인(⚙/✓/✗, 투두 ✓▶○, 앵커 거터).
function isToolishLine(line: string): boolean {
  const t = line.trimStart();
  return /^[⚙✓✗▶○]/.test(t) || t.startsWith('Tool error:') || /^\d+\|[a-z]{2} /.test(line);
}

function AssistantMarkdown({ text }: { text: string }) {
  // 라이브 스트림에는 툴 진행 라인이 마크다운 프로즈와 섞여 온다 — 툴 블록은
  // 툴 컬러라이저로, 나머지는 마크다운으로 분리 렌더. 코드펜스 내부는 제외.
  const segments: { tool: boolean; lines: string[] }[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    const tool = !inFence && isToolishLine(line);
    const last = segments[segments.length - 1];
    if (last && last.tool === tool) last.lines.push(line);
    else segments.push({ tool, lines: [line] });
  }
  return (
    <div className="agent-chat-md">
      {segments.map((seg, i) =>
        seg.tool ? (
          <pre key={i} className="tl md-toolseg">
            {renderToolText(seg.lines.join('\n'))}
          </pre>
        ) : (
          <div
            key={i}
            dangerouslySetInnerHTML={{ __html: assistantMd.render(seg.lines.join('\n')) }}
          />
        ),
      )}
    </div>
  );
}

/// 툴 출력 한 줄의 분류 — TUI(style_tool_line)와 동일한 2단 강조 규칙.
/// 상태(⚙/✓/✗)·diff(+/-/@@)·todo(✓▶○)·메타([note:], ⚠, …)를 개별 색으로.
function toolLineClass(line: string): string {
  const t = line.trimStart();
  if (
    t.startsWith('Tool error:') ||
    t.startsWith('Command exited with code') ||
    t.startsWith('Command timed out') ||
    t.startsWith('Blocked:')
  )
    return 'tl-fail';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git'))
    return 'tl-diff-head';
  if (line.startsWith('@@')) return 'tl-hunk';
  if (t.startsWith('+ ') || (line.startsWith('+') && !line.startsWith('++'))) return 'tl-add';
  if (t.startsWith('- ') || (line.startsWith('-') && !line.startsWith('--'))) return 'tl-del';
  if (t.startsWith('✓')) return 'tl-todo-done';
  if (t.startsWith('▶')) return 'tl-todo-doing';
  if (t.startsWith('○')) return 'tl-todo-pending';
  if (t.startsWith('•')) return 'tl-bullet';
  if (t.startsWith('[') || t.startsWith('…') || t.startsWith('⚠')) return 'tl-note';
  return 'tl-out';
}

/// 툴 카드 본문을 줄 단위 컬러 스팬으로 렌더 — 상태 글리프와 앵커 거터
/// (`12|ab `)는 스팬을 분리해 글리프/거터만 강조·디밍한다.
function renderToolText(text: string) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lead = line.trimStart();
    // 인접 -/+ 쌍(edit 프리뷰): 바뀐 가운데만 반전 표시.
    if (lead.startsWith('- ') && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextLead = next.trimStart();
      if (nextLead.startsWith('+ ')) {
        const { oldSpans, newSpans } = intraLineDiff(lead.slice(2), nextLead.slice(2));
        out.push(
          <div key={i} className="tl-line tl-del">
            {line.slice(0, line.length - lead.length)}- {oldSpans}
          </div>,
          <div key={`${i}plus`} className="tl-line tl-add">
            {next.slice(0, next.length - nextLead.length)}+ {newSpans}
          </div>,
        );
        i += 1;
        continue;
      }
    }
    out.push(renderSingleToolLine(line, i));
  }
  return out;
}

function renderSingleToolLine(line: string, i: number) {
  {
    if (line.startsWith('⚙ ')) {
      return (
        <div key={i} className="tl-line tl-run">{line}</div>
      );
    }
    if (line.startsWith('✓ ')) {
      return (
        <div key={i} className="tl-line">
          <span className="tl-glyph-ok">✓ </span>
          <span className="tl-ok">{line.slice(2)}</span>
        </div>
      );
    }
    if (line.startsWith('✗ ')) {
      return <div key={i} className="tl-line tl-fail">{line}</div>;
    }
    const gutter = line.match(/^(\d+\|[a-z]{2} )(.*)$/);
    if (gutter) {
      return (
        <div key={i} className="tl-line">
          <span className="tl-gutter">{gutter[1]}</span>
          <span className="tl-code">{highlightCodeSpans(gutter[2], String(i))}</span>
        </div>
      );
    }
    return (
      <div key={i} className={`tl-line ${toolLineClass(line)}`}>
        {line.length > 0 ? line : ' '}
      </div>
    );
  }
}

/// 툴 카드 요약에 보일 "무슨 작업인지" 한 줄. 첫 줄에서 상태 글리프·툴명·
/// 앵커 거터를 벗겨 실제 인자(파일명/명령/검색어)만 남긴다.
function toolActionPreview(text: string, toolName?: string): string {
  const first = (text.split('\n').find((l) => l.trim()) || '').trim();
  let s = first.replace(/^[⚙✓✗▶○]\s*/, '');
  if (toolName && s.toLowerCase().startsWith(toolName.toLowerCase())) {
    s = s.slice(toolName.length).trim();
  }
  s = s.replace(/^\d+\|[a-z]{2}\s*/, ''); // 앵커 거터 제거
  if (s.length > 72) s = s.slice(0, 72) + '…';
  return s;
}

/// 툴 이름 → 색상 카테고리 + 아이콘. 읽기(파랑)/쓰기·편집(주황)/실행(초록)/
/// 검색(보라)/기타(회색)로 색을 분리해 무슨 종류의 작업인지 한눈에 보이게.
function toolKind(name?: string): { key: string; icon: typeof LucideIcons.Wrench } {
  const n = (name || '').toLowerCase();
  if (/(^|_)read|read_many|cat|view/.test(n)) return { key: 'read', icon: LucideIcons.FileText };
  if (/write|edit|patch|append|create/.test(n)) return { key: 'write', icon: LucideIcons.PenLine };
  if (/bash|shell|exec|run|job|cmd/.test(n)) return { key: 'exec', icon: LucideIcons.Terminal };
  if (/grep|search|find|glob|code_search/.test(n)) return { key: 'search', icon: LucideIcons.Search };
  if (/wiki|note|memory/.test(n)) return { key: 'note', icon: LucideIcons.BookOpen };
  if (/todo|plan|task/.test(n)) return { key: 'plan', icon: LucideIcons.ListChecks };
  if (/browser|web|fetch|navigate/.test(n)) return { key: 'web', icon: LucideIcons.Globe };
  return { key: 'other', icon: LucideIcons.Wrench };
}

/// 트랜스크립트 엔트리 하나 — memo로 감싸 스트리밍 토큰마다 전체 히스토리가
/// 리렌더(마크다운 파스+토크나이저 전량 재실행)되던 버벅임을 차단한다.
/// entry 객체 참조가 같으면 절대 다시 그리지 않는다.
const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  index,
  ko,
}: {
  entry: Entry;
  index: number;
  ko: boolean;
}) {
  if (entry.kind === 'tool') {
    const kind = toolKind(entry.toolName);
    const Icon = kind.icon;
    // 요약줄에 "무슨 작업인지" 미리보기 한 줄을 항상 보여준다 — 카드를 펼치지
    // 않아도 단계별로 무엇을 했는지 흐름이 읽힌다. 상태 글리프(⚙/✓/✗)·툴명·
    // 앵커 거터를 벗겨 실제 인자만 남긴다.
    const preview = toolActionPreview(entry.text, entry.toolName);
    const lineCount = entry.text.split('\n').filter((l) => l.trim()).length;
    return (
      <details data-entry={index} className={`agent-chat-tool tool-${kind.key} ${entry.isError ? 'error' : ''}`}>
        <summary>
          <span className={`agent-chat-tool-dot ${entry.isError ? 'err' : ''}`} data-kind={kind.key} />
          <Icon size={12} className="agent-chat-tool-icon" />
          <span className="agent-chat-tool-name">{entry.toolName}</span>
          {preview && <span className="agent-chat-tool-preview">{preview}</span>}
          <span className="agent-chat-tool-lines">{lineCount}줄</span>
          {entry.isError && <span className="agent-chat-tool-err">{ko ? '오류' : 'error'}</span>}
        </summary>
        <pre className="tl">{renderToolText(entry.text)}</pre>
      </details>
    );
  }
  return (
    <div data-entry={index} className={`agent-chat-msg ${entry.kind} ${entry.isError ? 'error' : ''}`}>
      <div className="agent-chat-msg-head">
        {entry.kind === 'assistant' ? (
          <>
            <img src="/icons/bbarit-logo.png" alt="" className="agent-chat-avatar" />
            <span>BBARIT</span>
          </>
        ) : entry.kind === 'user' ? (
          <span>{ko ? '나' : 'You'}</span>
        ) : null}
      </div>
      {entry.kind === 'assistant' ? (
        <AssistantMarkdown text={entry.text} />
      ) : (
        <pre>{entry.text}</pre>
      )}
    </div>
  );
});

interface PersonaItem {
  id: string;
  division: string;
  name: string;
  description: string;
  emoji: string;
}

interface AgentModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
}

// 하니스 역할별 추천 페르소나 — 설계는 아키텍트, 개발은 시니어 개발자,
// 리뷰는 코드 리뷰어 계열. 라이브러리에 없는 id는 자동으로 걸러진다.
const HARNESS_PERSONA_RECS: Record<string, string[]> = {
  planner: ['software-architect', 'backend-architect', 'multi-agent-systems-architect', 'sprint-prioritizer', 'autonomous-optimization-architect'],
  developer: ['senior-developer', 'frontend-developer', 'rapid-prototyper', 'minimal-change-engineer', 'devops-automator'],
  reviewer: ['code-reviewer', 'appsec-engineer', 'sre', 'penetration-tester', 'git-workflow-master'],
};

interface Props {
  workDir: string;
  /** 전환 가능한 프로젝트 목록 — 선택 시 에이전트가 그 폴더로 재기동된다. */
  projects?: { id: string; name: string; workDir: string }[];
  label?: string;
  onClose?: () => void;
  /** 호스트(예: BBARIT Browser)가 외부에서 주입하는 작업 — nonce가 바뀔 때마다 한 번 자동 전송. */
  initialPrompt?: string;
  initialPromptNonce?: number;
  /** 좁은 도크용: 세션/태스크 사이드바는 접힌 채 시작, 입력창은 크게. */
  compact?: boolean;
  /** 이 에이전트가 제어할 BBARIT Browser 창 label. 브라우저 창이 자기 label을
   *  넘기면 에이전트의 browser 도구가 (별도 창이 아니라) 그 창을 직접 제어한다. */
  browserWindowLabel?: string;
  /** 사이드바 컨텍스트 접합(D15): 전송 직전 호출되어 non-empty를 반환하면
   *  RPC로 가는 메시지 앞에만 붙는다 — 화면 transcript에는 입력 그대로 남아
   *  "무엇이 들어갔는지"는 칩(호스트 UI)이 보여준다. RPC 프로토콜 무변경. */
  promptPrefix?: () => string;
  /** 사이드바 감사 로그(설계 D17 표시 계층): 라이브 턴에서 툴 호출이 끝날 때마다
   *  호스트에 알린다 — 히스토리 재구성(entriesFromMessages)에서는 호출하지 않는다. */
  onToolEvent?: (toolName: string, preview: string) => void;
  /** 전체화면 fixed 모달(페르소나 피커 등) 열림/닫힘 통지 — CEF 호스트는 이걸 받아
   *  네이티브 브라우저 뷰를 잠시 숨긴다(NSView가 DOM 모달을 덮는 문제). */
  onModalOpenChange?: (open: boolean) => void;
  /** Keep the RPC child alive while this React surface is temporarily hidden. */
  persistOnUnmount?: boolean;
  /** Stable identity used to reattach to the same child after a remount. */
  persistenceKey?: string;
}

let panelSeq = 0;

function stablePanelHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export function AgentChatPanel({ workDir, projects, label, onClose, initialPrompt, initialPromptNonce, compact: compactDock, browserWindowLabel, promptPrefix, onToolEvent, onModalOpenChange, persistOnUnmount = false, persistenceKey }: Props) {
  const { locale } = useTranslation();
  const { config } = useConfig();
  const bbaritLanguage = normalizeBbaritAgentLanguage(config.agent.bbaritLanguage);
  const ko = locale === 'ko';
  const panelId = useMemo(
    () => persistenceKey
      ? `panel-persist-${stablePanelHash(`${persistenceKey}:${workDir}`)}`
      : `panel-${Date.now().toString(36)}-${panelSeq++}`,
    [persistenceKey, workDir],
  );
  // 진단용: dev:screen 등 외부 검증 도구가 이 패널의 RPC 채널을 확인할 수 있게.
  useEffect(() => { (window as any).__agentPanelId = panelId; }, [panelId]);
  // 프레임 핸들러는 장수 클로저라 최신 콜백을 ref로 본다.
  const onToolEventRef = useRef(onToolEvent);
  onToolEventRef.current = onToolEvent;
  // 프로젝트 전환: workDir이 바뀌면 아래 스폰 effect가 재실행되어
  // 에이전트가 그 프로젝트 폴더로 새로 뜬다.
  const [activeWorkDir, setActiveWorkDir] = useState(workDir);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState('');
  // 모델 추론(thinking) 스트림은 본문과 분리해 딤 처리로 보여준다 — 본문에 섞이면
  // 추론이 답변처럼 보인다.
  const [thinkingStream, setThinkingStream] = useState('');
  const [working, setWorking] = useState(false);
  const [input, setInput] = useState('');
  const [modelName, setModelName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [commands, setCommands] = useState<CommandItem[]>([]);
  const [personas, setPersonas] = useState<PersonaItem[]>([]);
  const [personaActive, setPersonaActive] = useState<{ id: string; name: string; emoji: string } | null>(null);
  // 페르소나 즐겨찾기(id 목록) — 목록 맨 위 ★ 그룹으로 뜬다. localStorage에 유지.
  const [personaFavs, setPersonaFavs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('bbarit-persona-favs') || '[]'); } catch { return []; }
  });
  const togglePersonaFav = useCallback((id: string) => {
    setPersonaFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((k) => k !== id) : [id, ...prev];
      try { localStorage.setItem('bbarit-persona-favs', JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, []);
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  // RPC 목록에는 md 경로가 없어서 (원본 .md 보기용) Tauri 목록의 path를 id로 합친다.
  const [personaPaths, setPersonaPaths] = useState<Record<string, string>>({});
  const personaPickerEntries = useMemo<BbaritPersonaEntry[]>(
    () => personas.map((p) => ({ ...p, path: personaPaths[p.id] })),
    [personas, personaPaths],
  );
  // 설정 드로어 — 모델 전체 목록·thinking·하니스 역할 모델/페르소나를 GUI로 제어.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<AgentModelInfo[]>([]);
  const [readyProviders, setReadyProviders] = useState<string[]>([]);
  const [harnessRoles, setHarnessRoles] = useState<{ role: string; model: string; persona?: string }[]>([]);
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [currentModel, setCurrentModel] = useState<AgentModelInfo | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  // 프로바이더별 그룹 — 로그인/키 등록된 프로바이더가 맨 위.
  const groupedModels = useMemo(() => {
    const readySet = new Set(readyProviders);
    const q = modelFilter.trim().toLowerCase();
    const groups = new Map<string, AgentModelInfo[]>();
    for (const m of availableModels) {
      if (providerFilter && m.provider !== providerFilter) continue;
      if (q && !`${m.provider}/${m.id} ${m.name || ''}`.toLowerCase().includes(q)) continue;
      const list = groups.get(m.provider);
      if (list) list.push(m); else groups.set(m.provider, [m]);
    }
    return [...groups.entries()].sort((a, b) => {
      const readyDiff = Number(readySet.has(b[0])) - Number(readySet.has(a[0]));
      return readyDiff !== 0 ? readyDiff : a[0].localeCompare(b[0]);
    });
  }, [availableModels, readyProviders, modelFilter, providerFilter]);
  const providerOptions = useMemo(() => {
    const readySet = new Set(readyProviders);
    const seen = new Map<string, number>();
    for (const m of availableModels) seen.set(m.provider, (seen.get(m.provider) || 0) + 1);
    return [...seen.entries()].sort((a, b) => {
      const readyDiff = Number(readySet.has(b[0])) - Number(readySet.has(a[0]));
      return readyDiff !== 0 ? readyDiff : a[0].localeCompare(b[0]);
    });
  }, [availableModels, readyProviders]);
  // 하니스 스테이지별 프로바이더 선택 (UI 상태) — 프로바이더를 먼저 고르고
  // 그 안의 모델만 고르는 2단계. 설정된 모델이 있으면 그 프로바이더로 시작.
  const [stageProviders, setStageProviders] = useState<Record<string, string>>({});
  // 하니스 역할용 이미지 페르소나 피커 — 어느 역할이 열었는지.
  const [stagePersonaRole, setStagePersonaRole] = useState<string | null>(null);
  const stageProviderOf = useCallback((role: string, modelRef: string) => {
    if (stageProviders[role] !== undefined) return stageProviders[role];
    const slash = modelRef.indexOf('/');
    return slash > 0 ? modelRef.slice(0, slash) : '';
  }, [stageProviders]);
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [commandTasks, setCommandTasks] = useState<CommandTask[]>([]);
  // 태스크 전용 화면: 한 태스크 = 한 화면. null이면 전체 대화.
  const [taskView, setTaskView] = useState<{ start: number; end: number; label: string } | null>(null);
  const [alive, setAlive] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !compactDock);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskValue, setNewTaskValue] = useState('');
  // 터미널과 동일한 큐잉: 작업 중 입력한 메시지는 큐에 쌓였다가 턴이 끝나면
  // 한 턴으로 합쳐져 이어서 실행된다. labels = 왼쪽 작업 목록에 뜰 태스크명들.
  const [queued, setQueued] = useState<{ message: string; labels: string[] }[]>([]);
  const [elapsed, setElapsed] = useState(0);
  // 이 에이전트가 띄운 외부(백그라운드) 프로세스 목록 — 툴 출력에서
  // 'job #N (pid P)' 시작줄과 'Killed job #N'/'finished'를 스캔해 하단에 표시.
  const procList = useMemo(() => {
    const map = new Map<string, { job: string; pid: string; ended: boolean; detail: string }>();
    for (const e of entries) {
      if (e.kind !== 'tool') continue;
      for (const m of e.text.matchAll(/job #(\d+) \(pid (\d+)\)/g)) {
        const job = m[1];
        if (!map.has(job)) {
          const auto = e.text.includes('[auto-background]');
          map.set(job, { job, pid: m[2], ended: false, detail: auto ? 'auto' : 'bg' });
        }
      }
      for (const m of e.text.matchAll(/(?:Killed job|job) #(\d+)[^\n]*(?:finished|Killed|not running)/gi)) {
        const p = map.get(m[1]);
        if (p) p.ended = true;
      }
    }
    return [...map.values()];
  }, [entries]);
  const nextRpcId = useRef(1);
  const activeRunIdRef = useRef<string | null>(null);
  const abortingRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);

  const send = useCallback((frame: Record<string, unknown>, onFailure?: (error: unknown) => void) => {
    const id = nextRpcId.current++;
    const line = JSON.stringify({ id, ...frame });
    void invoke('agent_rpc_write', { panelId, line }).catch((e) => {
      setEntries((prev) => [...prev, { kind: 'system', text: `${ko ? '전송 실패' : 'Send failed'}: ${e}`, isError: true }]);
      onFailure?.(e);
    });
    return id;
  }, [panelId, ko]);

  const openSettings = useCallback(() => {
    send({ type: 'get_state' });
    send({ type: 'get_available_models' });
    send({ type: 'get_harness_roles' });
    send({ type: 'get_personas' });
    setSettingsOpen(true);
  }, [send]);

  const loadPersonaResources = useCallback(() => {
    send({ type: 'get_personas' });
    if (!Object.keys(personaPaths).length) {
      invoke<BbaritPersonaEntry[]>('agent_personas_list')
        .then((list) => {
          const map: Record<string, string> = {};
          for (const p of list) if (p.path) map[p.id] = p.path;
          setPersonaPaths(map);
        })
        .catch(() => { /* md 보기만 빠질 뿐 피커는 동작 */ });
    }
  }, [send, personaPaths]);

  const openPersonaPicker = useCallback(() => {
    loadPersonaResources();
    setPersonaPickerOpen(true);
  }, [loadPersonaResources]);

  // 전체화면 모달 열림을 호스트에 통지 — CEF 브라우저 창은 이걸로 네이티브 뷰를 숨긴다.
  const personaModalOpen = personaPickerOpen || stagePersonaRole != null;
  useEffect(() => {
    onModalOpenChange?.(personaModalOpen);
    return () => { onModalOpenChange?.(false); };
  }, [personaModalOpen, onModalOpenChange]);

  const refreshMeta = useCallback(() => {
    send({ type: 'get_state' });
    send({ type: 'get_sessions' });
  }, [send]);

  const entriesFromMessages = useCallback((messages: any[]): Entry[] => {
    const rebuilt: Entry[] = [];
    let lastTodo: string | null = null;
    for (const m of messages || []) {
      const role = String(m.role || '');
      const text = String(m.content || '');
      if (role === 'user' && text.trim()) rebuilt.push({ kind: 'user', text: text.trim() });
      else if (role === 'assistant' && text.trim()) rebuilt.push({ kind: 'assistant', text: text.trim() });
      else if (role === 'tool') {
        const toolName = m.tool_name || m.toolName || 'tool';
        if (toolName === 'todo') lastTodo = text;
        rebuilt.push({
          kind: 'tool',
          text,
          toolName,
          isError: Boolean(m.is_error ?? m.isError),
        });
      }
    }
    setTodoItems(lastTodo ? parseTodoItems(lastTodo) : []);
    // 과거 세션의 작업 목록: 사용자 명령마다 하나, 배치(불릿) 명령은 줄마다
    // 하나 (전부 완료 상태로 복원).
    const commands: CommandTask[] = [];
    rebuilt.forEach((entry, index) => {
      if (entry.kind !== 'user') return;
      const bullets = entry.text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
      if (bullets.length > 1) {
        for (const bullet of bullets) {
          commands.push({ text: bullet.slice(2, 62), status: 'done', entryIndex: index });
        }
      } else {
        commands.push({ text: taskLabel(entry.text), status: 'done', entryIndex: index });
      }
    });
    setCommandTasks(commands);
    return rebuilt;
  }, []);

  const handleFrame = useCallback((raw: string) => {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case 'session':
        setAlive(true);
        setSessionId(String(frame.id || ''));
        send({ type: 'get_state' });
        send({ type: 'get_commands' });
        send({ type: 'get_personas' });
        send({ type: 'get_sessions' });
        // 패널을 다시 열어도 이어서 보이도록 현재 세션의 대화·작업을 복원.
        send({ type: 'get_messages' });
        break;
      case 'response': {
        if (frame.command === 'get_state' && frame.data) {
          setModelName(frame.data.model?.name || frame.data.model?.id || '');
          setPersonaActive(frame.data.persona || null);
          if (frame.data.model) setCurrentModel(frame.data.model);
          if (frame.data.thinkingLevel) setThinkingLevel(String(frame.data.thinkingLevel));
          if (frame.data.sessionId) setSessionId(String(frame.data.sessionId));
        }
        if (frame.command === 'get_available_models' && Array.isArray(frame.data?.models)) {
          setAvailableModels(frame.data.models);
          if (Array.isArray(frame.data.readyProviders)) setReadyProviders(frame.data.readyProviders);
        }
        if ((frame.command === 'get_harness_roles' || frame.command === 'set_harness_role' || frame.command === 'set_harness_persona') && Array.isArray(frame.data?.roles)) {
          setHarnessRoles(frame.data.roles);
        }
        if (frame.command === 'set_model' && frame.data?.id) {
          setCurrentModel(frame.data);
          setModelName(frame.data.name || frame.data.id || '');
          send({ type: 'get_state' });
        }
        if (frame.command === 'set_thinking_level') {
          send({ type: 'get_state' });
        }
        if (frame.command === 'get_commands' && Array.isArray(frame.data?.commands)) {
          setCommands(frame.data.commands);
        }
        if (frame.command === 'get_personas' && Array.isArray(frame.data?.personas)) {
          setPersonas(frame.data.personas);
        }
        if (frame.command === 'get_sessions' && Array.isArray(frame.data?.sessions)) {
          setSessions(frame.data.sessions);
        }
        if (frame.command === 'get_messages' && Array.isArray(frame.data?.messages)) {
          setEntries(entriesFromMessages(frame.data.messages));
          stickToBottom.current = true;
        }
        // The RPC backend reports success as `success`, not `ok`. Accept both so
        // switching a session actually reloads its transcript (get_messages).
        const frameOk = frame.success ?? frame.ok;
        if ((frame.command === 'switch_session' || frame.command === 'new_session' || frame.command === 'set_session_name') && frameOk) {
          send({ type: 'get_state' });
          send({ type: 'get_sessions' });
          if (frame.command === 'switch_session') send({ type: 'get_messages' });
        }
        if (frame.command === 'cycle_model' && frame.data?.model) {
          setModelName(frame.data.model.name || frame.data.model.id || '');
        }
        if (frameOk === false && frame.error) {
          setEntries((prev) => [...prev, { kind: 'system', text: String(frame.error), isError: true }]);
        }
        break;
      }
      case 'agent_start':
        activeRunIdRef.current = frame.runId == null ? activeRunIdRef.current : String(frame.runId);
        abortingRef.current = false;
        setWorking(true);
        break;
      case 'message_update': {
        const delta = frame.delta?.text;
        if (typeof delta === 'string') {
          if (frame.delta?.type === 'thinking_delta') {
            setThinkingStream((prev) => prev + delta);
          } else {
            setStreaming((prev) => prev + delta);
          }
        }
        break;
      }
      case 'message_end': {
        const m = frame.message || {};
        const role = String(m.role || '');
        if (role === 'assistant') {
          const text = String(m.content || '').trim();
          if (text) setEntries((prev) => [...prev, { kind: 'assistant', text }]);
        } else if (role === 'tool') {
          const text = String(m.content || '');
          const toolName = m.tool_name || m.toolName || 'tool';
          if (toolName === 'todo') setTodoItems(parseTodoItems(text));
          onToolEventRef.current?.(String(toolName), text.slice(0, 160));
          setEntries((prev) => [...prev, {
            kind: 'tool',
            text,
            toolName,
            isError: Boolean(m.is_error ?? m.isError),
          }]);
        }
        break;
      }
      case 'turn_end':
        // 턴이 에러로 끝나면 반드시 화면에 보여준다 (조용한 실패 금지).
        if (frame.errorMessage) {
          setEntries((prev) => [...prev, { kind: 'system', text: String(frame.errorMessage), isError: true }]);
        }
        break;
      case 'agent_end':
        if (frame.runId != null
          && activeRunIdRef.current != null
          && String(frame.runId) !== activeRunIdRef.current) break;
        setWorking(false);
        setStreaming(''); setThinkingStream('');
        if (frame.errorMessage) {
          setEntries((prev) => [...prev, { kind: 'system', text: String(frame.errorMessage), isError: true }]);
        }
        // 오류/취소를 성공 완료로 위장하지 않는다.
        setCommandTasks((tasks) => tasks.map((t) => {
          if (t.status !== 'doing') return t;
          if (frame.cancelled || abortingRef.current) return { ...t, status: 'cancelled' as const };
          if (frame.errorMessage || frame.incomplete) return { ...t, status: 'failed' as const };
          return { ...t, status: 'done' as const };
        }));
        activeRunIdRef.current = null;
        abortingRef.current = false;
        send({ type: 'get_sessions' });
        // 페르소나/모델이 턴 중 바뀌었을 수 있으니 상태 칩 갱신.
        send({ type: 'get_state' });
        break;
      default:
        break;
    }
  }, [send, entriesFromMessages]);

  // Spawn the RPC agent for this panel and subscribe to its event stream.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      const un = await listen<{ kind: string; line?: string; reason?: string; code?: number | null }>(`agent-rpc-${panelId}`, (event) => {
        const { kind, line, reason, code } = event.payload || ({} as any);
        if (kind === 'line' && line) handleFrame(line);
        else if (kind === 'stderr' && line && !line.startsWith('persona:')) {
          // 에이전트 프로세스의 stderr(에러/경고)를 삼키지 않고 보여준다.
          setEntries((prev) => [...prev, { kind: 'system', text: `[agent] ${line}`, isError: true }]);
        }
        else if (kind === 'exit') {
          setAlive(false);
          setWorking(false);
          setStreaming('');
          setThinkingStream('');
          setEntries((prev) => [...prev, {
            kind: 'system',
            text: ko
              ? `에이전트 연결이 종료되었습니다${reason ? ` (${reason}${code == null ? '' : `, code ${code}`})` : ''}. 재시작 후 다시 보내주세요.`
              : `Agent connection ended${reason ? ` (${reason}${code == null ? '' : `, code ${code}`})` : ''}. Restart the agent and send again.`,
            isError: true,
          }]);
          setCommandTasks((tasks) => tasks.map((task) => task.status === 'doing' ? { ...task, status: 'failed' as const } : task));
          activeRunIdRef.current = null;
        }
      });
      // StrictMode mounts effects twice: if cleanup already ran while `listen`
      // was in flight, release THIS registration immediately — otherwise the
      // leaked listener double-appends every message.
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      try {
        await invoke('agent_rpc_start', { panelId, workDir: activeWorkDir, browserLabel: browserWindowLabel, bbaritLanguage });
      } catch (e) {
        setEntries((prev) => [...prev, { kind: 'system', text: `${ko ? '에이전트 시작 실패' : 'Agent start failed'}: ${e}`, isError: true }]);
      }
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
      if (!persistOnUnmount) void invoke('agent_rpc_stop', { panelId }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, activeWorkDir, persistOnUnmount]);

  // 프로젝트 전환: 상태를 비우고 새 폴더로 재기동 (위 effect가 재실행).
  const switchProject = useCallback((nextWorkDir: string) => {
    if (!nextWorkDir || nextWorkDir === activeWorkDir || working) return;
    setEntries([]);
    setStreaming(''); setThinkingStream('');
    setTodoItems([]);
    setCommandTasks([]);
    setTaskView(null);
    setQueued([]);
    setSessions([]);
    setPersonaActive(null);
    setAlive(false);
    setActiveWorkDir(nextWorkDir);
  }, [activeWorkDir, working]);

  // Follow the stream unless the user scrolled up (same rule as the TUI).
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [entries, streaming]);

  // Working timer (terminal parity: "N s" while a turn runs).
  useEffect(() => {
    if (!working) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [working]);

  // Drain the queue when the turn ends: everything queued so far becomes ONE
  // follow-up turn (terminal parity), but every queued item keeps its own
  // task entry in the sidebar.
  useEffect(() => {
    if (working || queued.length === 0 || !alive) return;
    const batch = queued.map((q) => q.message).join('\n\n');
    const labels = queued.flatMap((q) => q.labels);
    setQueued([]);
    sendPromptRef.current(batch, labels);
  }, [working, queued, alive]);

  const onTranscriptScroll = useCallback(() => {
    const el = transcriptRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  const entriesCountRef = useRef(0);
  useEffect(() => { entriesCountRef.current = entries.length; }, [entries]);

  const sendPrompt = useCallback((message: string, labels?: string[]) => {
    if (!alive) {
      setEntries((prev) => [...prev, {
        kind: 'system',
        text: ko ? '에이전트가 아직 연결되지 않았습니다. 연결된 뒤 다시 보내주세요.' : 'Agent is not connected yet. Send again after it connects.',
        isError: true,
      }]);
      return;
    }
    // 새 명령은 전체 화면에서 진행 상황이 보이게 태스크 화면을 닫는다.
    setTaskView(null);
    // 멀티태스크: 줄(라벨)마다 별도 태스크로 왼쪽 목록에 얹는다. 위치는 이
    // user 항목 인덱스(한 턴에 함께 실행되므로 같은 지점).
    const entryIndex = entriesCountRef.current;
    const names = labels && labels.length > 0 ? labels : [taskLabel(message)];
    const stamp = personaActive ? `${personaActive.emoji} ${personaActive.name}`.trim() : undefined;
    setCommandTasks((tasks) => [
      ...tasks,
      ...names.map((text) => ({
        text: text.slice(0, 60),
        status: 'doing' as const,
        entryIndex,
        persona: stamp,
      })),
    ]);
    setEntries((prev) => [...prev, { kind: 'user', text: message }]);
    stickToBottom.current = true;
    setWorking(true);
    // 사이드바 페이지 컨텍스트는 RPC 메시지에만 접합 — transcript는 입력 그대로.
    const prefix = promptPrefix?.() ?? '';
    const runId = send(
      { type: 'prompt', message: prefix ? `${prefix}${message}` : message },
      () => {
        setWorking(false);
        setStreaming(''); setThinkingStream('');
        setCommandTasks((tasks) => tasks.map((task) => task.status === 'doing' ? { ...task, status: 'failed' as const } : task));
        activeRunIdRef.current = null;
      },
    );
    activeRunIdRef.current = String(runId);
  }, [alive, ko, send, personaActive, promptPrefix]);
  const sendPromptRef = useRef(sendPrompt);
  useEffect(() => { sendPromptRef.current = sendPrompt; }, [sendPrompt]);

  // 호스트가 주입한 초기 작업: 입력창에 "채우기만" 하고 절대 자동 전송하지 않는다.
  // (자동 전송하면 브라우저를 열 때 사용자 확인 없이 에이전트가 작업을 시작해
  // 예기치 못한 실행이 일어난다 — 실측 사고. 사용자가 검토 후 Enter로만 실행.)
  const lastInitialPromptNonce = useRef(0);
  useEffect(() => {
    if (!initialPrompt || !initialPromptNonce) return;
    if (initialPromptNonce === lastInitialPromptNonce.current) return;
    lastInitialPromptNonce.current = initialPromptNonce;
    setInput(initialPrompt);
    composerRef.current?.focus();
  }, [initialPrompt, initialPromptNonce]);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    let message = text;
    // 멀티 = 한 세션: 여러 줄이면 같은 세션에서 전부 완료하도록 지시(독립 작업은
    // agent_team으로 병렬). /orchestrate(세션 격리)는 쓰지 않는다.
    const lines = text.split('\n').map((t) => t.trim()).filter(Boolean);
    if (!text.startsWith('/') && lines.length > 1) {
      message = `${ko
        ? '다음 작업을 전부 완료하라. todo로 계획하고, 서로 독립적인 작업은 agent_team으로 병렬 실행하라. 작업에 맞는 전문가가 있으면 task/agent_team의 persona 인자로 그 페르소나를 주입하라 (/persona 목록 참고):'
        : 'Complete ALL of these tasks. Plan with todo; run independent ones in parallel via agent_team. If a task fits a specialist, inject that persona via the task/agent_team `persona` argument (see /persona):'}\n${lines.map((l) => `- ${l}`).join('\n')}`;
    }
    // 각 줄이 왼쪽 목록의 태스크가 된다 (한 턴·한 세션에서 함께 실행).
    const labels = !text.startsWith('/') && lines.length > 1 ? lines : [text];
    // 작업 중이면 터미널처럼 큐에 쌓는다 — 턴이 끝나면 자동으로 이어서 실행.
    // 조용히 쌓이면 "질문했는데 대답이 없다"로 보이므로 반드시 화면에 알린다.
    if (working) {
      setQueued((prev) => {
        const next = [...prev, { message, labels }];
        setEntries((entries) => [...entries, {
          kind: 'system',
          text: ko
            ? `⏳ 큐에 추가됨 (${next.length}번째) — 현재 작업이 끝나면 자동으로 이어서 답합니다. 즉시 답이 필요하면 ⏹ 중지 후 다시 보내세요.`
            : `⏳ Queued (#${next.length}) — runs automatically after the current turn. Stop (⏹) first if you need an answer now.`,
        }]);
        return next;
      });
      return;
    }
    sendPrompt(message, labels);
  }, [input, working, ko, sendPrompt]);

  // 에이전트 프로세스 재시작: 세션은 디스크에 있으므로 대화는 보존되고,
  // 프로세스만 새로 뜬다 (멈췄거나 죽었을 때의 복구 버튼).
  const restartAgent = useCallback(async () => {
    setMenuOpen(false);
    setWorking(false);
    setStreaming(''); setThinkingStream('');
    setAlive(false);
    setEntries((prev) => [...prev, { kind: 'system', text: ko ? '에이전트 재시작 중…' : 'Restarting agent…' }]);
    try {
      await invoke('agent_rpc_stop', { panelId });
      await invoke('agent_rpc_start', { panelId, workDir: activeWorkDir, browserLabel: browserWindowLabel, bbaritLanguage });
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'system', text: `${ko ? '재시작 실패' : 'Restart failed'}: ${e}`, isError: true }]);
    }
  }, [panelId, activeWorkDir, ko, bbaritLanguage]);

  // 태스크 전용 화면 열기: 그 태스크의 명령부터 다음 명령 직전까지만 보인다.
  const openTaskView = useCallback((task: CommandTask) => {
    const starts = [...new Set(commandTasks.map((t) => t.entryIndex))].sort((a, b) => a - b);
    const next = starts.find((s) => s > task.entryIndex);
    setTaskView({
      start: task.entryIndex,
      end: next ?? Number.MAX_SAFE_INTEGER,
      label: task.text,
    });
    stickToBottom.current = task.status === 'doing';
    // 완료된 작업은 처음부터 읽도록 맨 위로.
    if (task.status !== 'doing') {
      requestAnimationFrame(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = 0; });
    }
  }, [commandTasks]);

  // 트랜스크립트의 특정 항목으로 점프 + 플래시 하이라이트.
  const revealEntry = useCallback((index: number) => {
    stickToBottom.current = false;
    const node = transcriptRef.current?.querySelector(`[data-entry="${index}"]`);
    if (!node) return;
    if (node instanceof HTMLDetailsElement) node.open = true;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('agent-chat-flash');
    void (node as HTMLElement).offsetWidth; // restart the animation
    node.classList.add('agent-chat-flash');
  }, []);

  // 세부(todo) 타스크 클릭: 그 작업이 진행된 지점으로 점프. todo 카드(모든
  // 작업명이 다 들어있음)는 제외하고, 작업명 단어와 가장 많이 겹치는 항목을
  // 고른다 — 같은 점수면 가장 이른(작업이 시작된) 항목.
  const revealTask = useCallback((task: TodoItem) => {
    const words = task.text.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    if (words.length === 0) return false;
    let best = -1;
    let bestScore = 0;
    entries.forEach((entry, index) => {
      if (entry.kind === 'tool' && entry.toolName === 'todo') return;
      const text = entry.text.toLowerCase();
      const score = words.reduce((sum, w) => sum + (text.includes(w) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best < 0 || bestScore < Math.max(1, Math.ceil(words.length * 0.4))) {
      // 본문 매칭 실패 → 그 작업명이 처음 등장한 todo 카드로라도 이동.
      best = entries.findIndex((e) => e.kind === 'tool' && e.toolName === 'todo' && e.text.toLowerCase().includes(words[0]));
      if (best < 0) return false;
    }
    revealEntry(best);
    return true;
  }, [entries, revealEntry]);

  const openSession = useCallback((s: SessionItem) => {
    if (working || s.id === sessionId) return;
    setEntries([]);
    setStreaming(''); setThinkingStream('');
    setTodoItems([]);
    setCommandTasks([]);
    setTaskView(null);
    send({ type: 'switch_session', sessionPath: s.path || s.id });
  }, [send, working, sessionId]);

  const newSession = useCallback(() => {
    if (working) return;
    send({ type: 'new_session' });
    setEntries([]);
    setStreaming(''); setThinkingStream('');
    setTodoItems([]);
    setCommandTasks([]);
    setTaskView(null);
    setMenuOpen(false);
  }, [send, working]);

  const runCommand = useCallback((cmd: CommandItem) => {
    setMenuOpen(false);
    const name = cmd.name.startsWith('/') || cmd.source !== 'builtin' ? cmd.name : `/${cmd.name}`;
    // TUI에서 대화형 메뉴를 여는 명령은 RPC prompt로는 어색하다 — 패널
    // 네이티브 동작으로 매핑한다.
    switch (name) {
      case '/model':
        send({ type: 'cycle_model' });
        setEntries((prev) => [...prev, { kind: 'system', text: ko ? '모델을 전환했습니다 (상단 표시 확인).' : 'Cycled model (see header).' }]);
        return;
      case '/thinking':
        send({ type: 'cycle_thinking_level' });
        setEntries((prev) => [...prev, { kind: 'system', text: ko ? '싱킹 레벨을 전환했습니다.' : 'Cycled thinking level.' }]);
        return;
      case '/new':
        newSession();
        return;
      case '/sessions':
      case '/resume':
        setSidebarOpen(true);
        setEntries((prev) => [...prev, { kind: 'system', text: ko ? '왼쪽 상단의 세션 선택에서 이어갈 세션을 고르세요.' : 'Pick a session from the sidebar dropdown.' }]);
        return;
      case '/login':
        setEntries((prev) => [...prev, { kind: 'system', text: ko ? '로그인은 빠릿 터미널에서 /login 으로 진행하세요 (브라우저/디바이스 코드 흐름 필요).' : 'Run /login in the BBARIT terminal (needs the browser/device-code flow).' }]);
        return;
      default:
        break;
    }
    if (cmd.needsArg) {
      // 인자가 필요한 명령: 입력창에 채워 넣고 포커스 — 내용을 붙여 Enter.
      setInput(`${name} `);
      composerRef.current?.focus();
      setEntries((prev) => [...prev, { kind: 'system', text: ko ? `${name} 명령이 입력창에 준비됐습니다 — 내용을 붙여 Enter.` : `${name} is ready in the composer — add details and press Enter.` }]);
      return;
    }
    sendPrompt(name.startsWith('/') ? name : `/${name}`);
  }, [sendPrompt, send, newSession, ko]);

  const commitRename = useCallback(() => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name) send({ type: 'set_session_name', name });
  }, [renameValue, send]);

  // 사이드바에서 태스크 추가: 낙관적으로 목록에 먼저 얹고, 에이전트에게
  // "todo에 추가하고 순서가 되면 진행"을 지시한다 (작업 중이면 큐잉).
  const commitAddTask = useCallback(() => {
    const text = newTaskValue.trim();
    setAddingTask(false);
    setNewTaskValue('');
    if (!text) return;
    const message = ko
      ? `새 작업 추가: "${text}" — todo 목록에 추가하고, 진행 중인 작업이 끝나는 대로 이어서 처리하라.`
      : `Add a new task: "${text}" — put it on the todo list and work on it after the current tasks.`;
    if (working) {
      setQueued((prev) => [...prev, { message, labels: [text] }]);
    } else {
      sendPrompt(message, [text]);
    }
  }, [newTaskValue, ko, working, sendPrompt]);

  // 이미지 첨부: @'경로' 토큰을 입력에 붙이면 에이전트가 비전 입력으로 붙인다
  // (handle_input의 extract_image_attachments — 터미널과 동일 경로).
  const appendImageToken = useCallback((path: string) => {
    setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@'${path}' `);
    composerRef.current?.focus();
  }, []);

  // 📷 = OS 실시간 화면 캡처(맥: 영역선택, 윈도우: 스니핑 오버레이) → 캡처
  // 즉시 첨부. 실패/취소 시 클립보드 이미지 첨부로 폴백.
  const attachClipboardImage = useCallback(async () => {
    try {
      const path = await invoke<string>('capture_screenshot');
      if (path) {
        appendImageToken(path);
        return;
      }
    } catch { /* 취소 또는 캡처 불가 → 클립보드 폴백 */ }
    try {
      const path = await invoke<string>('save_clipboard_image_from_system_clipboard');
      if (path) appendImageToken(path);
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'system', text: `${ko ? '이미지 첨부 실패(캡처 취소됨)' : 'Image attach failed (capture cancelled)'}: ${e}`, isError: true }]);
    }
  }, [appendImageToken, ko]);

  const onComposerPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1] || '';
      const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      try {
        const path = await invoke<string>('save_clipboard_image', { base64Data: base64, extension });
        appendImageToken(path);
      } catch (err) {
        setEntries((prev) => [...prev, { kind: 'system', text: `${ko ? '이미지 첨부 실패' : 'Image attach failed'}: ${err}`, isError: true }]);
      }
    };
    reader.readAsDataURL(file);
  }, [appendImageToken, ko]);

  // Insert a dropped file path into the composer. Image paths use the same
  // @'path' vision token as attachments; other files insert at the caret with
  // single-space separation.
  const insertDroppedPath = useCallback((rawPath: string) => {
    const path = rawPath.trim();
    if (!path) return;
    if (isImagePath(path)) { appendImageToken(path); return; }
    const el = composerRef.current;
    if (!el) {
      setInput((prev) => insertTextAtSelection(prev, prev.length, prev.length, path).text);
      return;
    }
    const { text, cursor } = insertTextAtSelection(el.value, el.selectionStart, el.selectionEnd, path);
    setInput(text);
    requestAnimationFrame(() => {
      const node = composerRef.current;
      if (node) { node.focus(); node.setSelectionRange(cursor, cursor); }
    });
  }, [appendImageToken]);

  // File tree uses a custom mouse drag (not HTML5 DnD), so App.tsx dispatches
  // this event to insert a path into the focused chat composer.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (path) insertDroppedPath(path);
    };
    window.addEventListener('octo-chat-insert-path', handler as EventListener);
    return () => window.removeEventListener('octo-chat-insert-path', handler as EventListener);
  }, [insertDroppedPath]);

  const onComposerDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    const text = e.dataTransfer.getData('text/plain');
    const fromFiles = (e.dataTransfer.files?.[0] as { path?: string } | undefined)?.path || '';
    const path = looksLikeFilePath(text) ? text : (looksLikeFilePath(fromFiles) ? fromFiles : '');
    if (!path) return; // ordinary text drop keeps the browser's default behavior
    e.preventDefault();
    insertDroppedPath(path);
  }, [insertDroppedPath]);

  const onComposerDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  const abort = useCallback(() => {
    abortingRef.current = true;
    setQueued([]);
    send({ type: 'abort' });
  }, [send]);
  const cycleModel = useCallback(() => { send({ type: 'cycle_model' }); setMenuOpen(false); }, [send]);
  const compact = useCallback(() => { send({ type: 'compact' }); setMenuOpen(false); }, [send]);

  // 전용 하네스 패널에는 필요한 명령만: 세션/모델/로그인은 사이드바·빠른
  // 동작이 담당하므로 메뉴에서 숨기고, 실제 작업 명령만 노출한다.
  const PANEL_MENU_COMMANDS = useMemo(() => new Set([
    '/persona', '/plan', '/harness', '/bugfix', '/review', '/loop', '/batch',
    '/improve', '/autoimprove', '/worktree', '/lens', '/restore', '/land',
    '/wiki', '/goal', '/files', '/links',
  ]), []);
  const builtinCommands = commands.filter((c) => c.source === 'builtin' && PANEL_MENU_COMMANDS.has(c.name));
  const resourceCommands = commands.filter((c) => c.source !== 'builtin');

  return (
    <div className={'agent-chat-panel' + (compactDock ? ' compact' : '')}>
      <div className="agent-chat-header" data-tauri-drag-region>
        <button
          className="agent-chat-icon-btn"
          title={ko ? '작업 목록' : 'Sessions'}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <LucideIcons.PanelLeft size={14} />
        </button>
        <span className="agent-chat-title">{label || 'BBARIT Agent'}</span>
        {projects && projects.length > 0 && (
          <select
            className="agent-chat-project-select"
            value={activeWorkDir}
            title={ko ? '프로젝트 전환 — 에이전트가 그 폴더로 재기동됩니다 (작업 중엔 비활성)' : 'Switch project — the agent restarts in that folder'}
            disabled={working}
            onChange={(e) => switchProject(e.target.value)}
          >
            {!projects.some((p) => p.workDir === activeWorkDir) && activeWorkDir && (
              <option value={activeWorkDir}>{activeWorkDir}</option>
            )}
            {projects.map((p) => (
              <option key={p.id} value={p.workDir}>📁 {p.name}</option>
            ))}
          </select>
        )}
        <span className={`agent-chat-status ${alive ? 'on' : 'off'}`}>
          {alive ? (modelName || (ko ? '연결됨' : 'connected')) : (ko ? '연결 안 됨' : 'disconnected')}
        </span>
        <button
          className={`agent-chat-persona-open ${personaActive ? 'has-persona' : ''}`}
          title={personaActive ? 'This agent\'s persona — click to change' : 'Inject a persona — the agent becomes that specialist'}
          onClick={openPersonaPicker}
        >
          {personaActive ? (
            <>
              {personaIconUrl(personaActive.id)
                ? <img className="agent-chat-persona-open-icon" src={personaIconUrl(personaActive.id)} alt="" width={18} height={18} draggable={false} />
                : <span>{personaActive.emoji}</span>}
              <span className="agent-chat-persona-open-name">{personaActive.name}</span>
            </>
          ) : (
            <span>{ko ? '페르소나' : 'Persona'}</span>
          )}
        </button>
        {personaActive && (
          <button
            className="agent-chat-persona-fav"
            title="Toggle favorite for the current persona (favorites sort to the top)"
            onClick={() => togglePersonaFav(personaActive.id)}
          >
            {personaFavs.includes(personaActive.id) ? '★' : '☆'}
          </button>
        )}
        {personaPickerOpen && (
          <BbaritPersonaPickerModal
            personas={personaPickerEntries}
            selectedId={personaActive?.id || ''}
            favorites={personaFavs}
            onToggleFavorite={togglePersonaFav}
            onSelect={(id) => {
              sendPrompt(id ? `/persona ${id}` : '/persona off');
              setPersonaPickerOpen(false);
            }}
            onClose={() => setPersonaPickerOpen(false)}
            title={ko ? '페르소나 선택' : 'Choose a persona'}
          />
        )}
        {stagePersonaRole && (
          <BbaritPersonaPickerModal
            personas={personaPickerEntries}
            selectedId={harnessRoles.find((r) => r.role === stagePersonaRole)?.persona || ''}
            favorites={personaFavs}
            onToggleFavorite={togglePersonaFav}
            recommendedIds={HARNESS_PERSONA_RECS[stagePersonaRole] || []}
            onSelect={(id) => {
              send({ type: 'set_harness_persona', role: stagePersonaRole, persona: id });
              setStagePersonaRole(null);
            }}
            onClose={() => setStagePersonaRole(null)}
            title={ko
              ? `하니스 ${stagePersonaRole === 'planner' ? '설계' : stagePersonaRole === 'developer' ? '개발' : '리뷰'} 페르소나`
              : `Harness ${stagePersonaRole} persona`}
          />
        )}
        {working && (
          <span className="agent-chat-workingbar" title={ko ? '작업 중' : 'Working'}>
            <span className="agent-chat-workingbar-track"><span className="agent-chat-workingbar-dot" /></span>
            {elapsed}s
          </span>
        )}
        <div className="agent-chat-header-actions">
          <button
            className={`agent-chat-icon-btn ${settingsOpen ? 'active' : ''}`}
            title={ko ? '설정 — 모델·thinking·하니스 워크플로우' : 'Settings — model · thinking · harness workflow'}
            onClick={() => { if (settingsOpen) setSettingsOpen(false); else openSettings(); }}
          >
            <LucideIcons.Settings2 size={13} />
          </button>
          <button
            className="agent-chat-icon-btn"
            title={ko ? '에이전트 재시작 (대화는 유지)' : 'Restart agent (conversation kept)'}
            onClick={() => { void restartAgent(); }}
          >
            <LucideIcons.RotateCcw size={13} />
          </button>
          <div className="agent-chat-menu-wrap">
            <button className="agent-chat-menu-btn" title={ko ? '빠릿 메뉴 — 전체 명령' : 'BBARIT menu — all commands'} onClick={() => setMenuOpen((v) => !v)}>
              <LucideIcons.Menu size={13} />
              <span>{ko ? '메뉴' : 'Menu'}</span>
            </button>
            {menuOpen && (
              <div className="agent-chat-menu">
                <div className="agent-chat-menu-group">{ko ? '빠른 동작' : 'Quick actions'}</div>
                <button onClick={newSession}><LucideIcons.Plus size={12} /> {ko ? '새 작업(세션)' : 'New session'}</button>
                <button onClick={cycleModel}><LucideIcons.RefreshCw size={12} /> {ko ? '모델 전환' : 'Cycle model'}</button>
                <button onClick={compact}><LucideIcons.FoldVertical size={12} /> {ko ? '컨텍스트 압축' : 'Compact context'}</button>
                {builtinCommands.length > 0 && (
                  <div className="agent-chat-menu-group">{ko ? '빠릿 명령' : 'Commands'}</div>
                )}
                {builtinCommands.map((cmd) => (
                  <button key={cmd.name} onClick={() => runCommand(cmd)} title={cmd.description}>
                    <span className="agent-chat-menu-cmd">{cmd.name}</span>
                    <span className="agent-chat-menu-desc">{cmd.description}</span>
                  </button>
                ))}
                {resourceCommands.length > 0 && (
                  <div className="agent-chat-menu-group">{ko ? '스킬·프롬프트·확장' : 'Skills · prompts · extensions'}</div>
                )}
                {resourceCommands.map((cmd) => (
                  <button key={`${cmd.source}-${cmd.name}`} onClick={() => runCommand(cmd)} title={cmd.description}>
                    <span className="agent-chat-menu-cmd">{cmd.name}</span>
                    <span className="agent-chat-menu-desc">{cmd.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {onClose && (
            <button className="agent-chat-icon-btn" title={ko ? '닫기' : 'Close'} onClick={onClose}>
              <LucideIcons.X size={14} />
            </button>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div className="agent-chat-settings" role="dialog" aria-label={ko ? '에이전트 설정' : 'Agent settings'}>
          <div className="agent-chat-settings-head">
            <LucideIcons.Settings2 size={13} />
            <span>{ko ? '에이전트 설정' : 'Agent settings'}</span>
            <button className="agent-chat-icon-btn" title={ko ? '닫기' : 'Close'} onClick={() => setSettingsOpen(false)}>
              <LucideIcons.X size={13} />
            </button>
          </div>

          {/* 모델 — 전체 카탈로그를 한눈에 (현재 모델 강조) */}
          <div className="agent-chat-settings-section">
            <div className="agent-chat-settings-title">
              {ko ? '모델' : 'Model'}
              <span className="agent-chat-settings-current" title={currentModel ? `${currentModel.provider}/${currentModel.id}` : ''}>
                {modelName || (ko ? '(기본)' : '(default)')}
              </span>
            </div>
            <div className="agent-chat-settings-row">
              <select
                className="agent-chat-settings-provider"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.currentTarget.value)}
                title={ko ? '프로바이더로 좁히기 (✓ = 로그인/키 등록됨)' : 'Filter by provider (✓ = logged in / key stored)'}
              >
                <option value="">{ko ? `전체 프로바이더 (${providerOptions.length})` : `All providers (${providerOptions.length})`}</option>
                {providerOptions.map(([provider, count]) => (
                  <option key={provider} value={provider}>
                    {readyProviders.includes(provider) ? '✓ ' : ''}{provider} ({count})
                  </option>
                ))}
              </select>
              <input
                className="agent-chat-settings-filter"
                placeholder={ko ? `모델 검색 — 전체 ${availableModels.length}개` : `Search models — ${availableModels.length} total`}
                value={modelFilter}
                onChange={(e) => setModelFilter(e.currentTarget.value)}
              />
            </div>
            <div className="agent-chat-settings-models">
              {groupedModels.map(([provider, models]) => (
                <React.Fragment key={provider}>
                  <div className={`agent-chat-settings-provider-head ${readyProviders.includes(provider) ? 'ready' : ''}`}>
                    {readyProviders.includes(provider) ? '✓ ' : ''}{provider}
                    <span>{readyProviders.includes(provider) ? (ko ? '로그인됨' : 'signed in') : ''}</span>
                  </div>
                  {models.map((m) => {
                    const isCurrent = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
                    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '';
                    return (
                      <button
                        key={`${m.provider}/${m.id}`}
                        className={`agent-chat-settings-model ${isCurrent ? 'current' : ''}`}
                        onClick={() => send({ type: 'set_model', provider: m.provider, modelId: m.id })}
                        title={`${m.provider}/${m.id}`}
                      >
                        <span className="agent-chat-settings-model-name">{m.name || m.id}</span>
                        <span className="agent-chat-settings-model-meta">
                          {ctx}{m.reasoning ? (ctx ? ' · 🧠' : '🧠') : ''}
                        </span>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
              {availableModels.length === 0 && (
                <div className="agent-chat-settings-empty">{ko ? '모델 목록을 불러오는 중…' : 'Loading models…'}</div>
              )}
              {availableModels.length > 0 && groupedModels.length === 0 && (
                <div className="agent-chat-settings-empty">{ko ? '검색과 일치하는 모델이 없습니다.' : 'No models match.'}</div>
              )}
            </div>
          </div>

          {/* Thinking 레벨 */}
          <div className="agent-chat-settings-section">
            <div className="agent-chat-settings-title">
              {ko ? '추론 강도 (thinking)' : 'Thinking level'}
              <span className="agent-chat-settings-current">{thinkingLevel || '-'}</span>
            </div>
            <div className="agent-chat-settings-pills">
              {(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const).map((level) => (
                <button
                  key={level}
                  className={`agent-chat-settings-pill ${thinkingLevel === level ? 'current' : ''}`}
                  onClick={() => send({ type: 'set_thinking_level', level })}
                >
                  {level === 'xhigh' ? 'max' : level}
                </button>
              ))}
            </div>
          </div>

          {/* 하니스 워크플로우 — Planner → Developer ⇄ Reviewer 파이프라인 설계 */}
          <div className="agent-chat-settings-section">
            <div className="agent-chat-settings-title">{ko ? '하니스 워크플로우' : 'Harness workflow'}</div>
            <div className="agent-chat-flow">
              {harnessRoles.map((r, i) => (
                <React.Fragment key={r.role}>
                  {i > 0 && (
                    <span className="agent-chat-flow-arrow">{i === 2 ? '⇄' : '→'}</span>
                  )}
                  <div className="agent-chat-flow-stage">
                    <span className="agent-chat-flow-role">
                      {r.role === 'planner' ? (ko ? '설계' : 'Planner') : r.role === 'developer' ? (ko ? '개발' : 'Developer') : (ko ? '리뷰' : 'Reviewer')}
                    </span>
                    {(() => {
                      const stageProvider = stageProviderOf(r.role, r.model);
                      const stageModels = availableModels.filter((m) => m.provider === stageProvider);
                      return (
                        <>
                          <select
                            value={stageProvider}
                            onChange={(e) => {
                              const provider = e.currentTarget.value;
                              setStageProviders((prev) => ({ ...prev, [r.role]: provider }));
                              // 프로바이더 없음 = 현재 채팅 모델 사용으로 즉시 초기화.
                              if (!provider) send({ type: 'set_harness_role', role: r.role, model: '' });
                            }}
                            title={ko ? '1단계: 프로바이더 (✓ = 로그인/키 등록됨)' : 'Step 1: provider (✓ = signed in)'}
                          >
                            <option value="">{ko ? '(현재 모델)' : '(current model)'}</option>
                            {providerOptions.map(([provider, count]) => (
                              <option key={provider} value={provider}>
                                {readyProviders.includes(provider) ? '✓ ' : ''}{provider} ({count})
                              </option>
                            ))}
                          </select>
                          {stageProvider && (
                            <select
                              value={r.model}
                              onChange={(e) => send({ type: 'set_harness_role', role: r.role, model: e.currentTarget.value })}
                              title={ko ? '2단계: 모델' : 'Step 2: model'}
                            >
                              {!r.model.startsWith(`${stageProvider}/`) && (
                                <option value="">{ko ? '모델 선택…' : 'Pick a model…'}</option>
                              )}
                              {stageModels.map((m) => (
                                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                                  {m.name || m.id}{m.reasoning ? ' 🧠' : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </>
                      );
                    })()}
                    {(() => {
                      const active = personas.find((p) => p.id === (r.persona || ''));
                      return (
                        <button
                          className={`agent-chat-flow-persona ${active ? 'has-persona' : ''}`}
                          title={ko ? '이 단계가 채택할 페르소나 — 클릭해서 이미지 피커에서 선택' : 'Persona this stage adopts — pick from the image picker'}
                          onClick={() => { loadPersonaResources(); setStagePersonaRole(r.role); }}
                        >
                          {active ? (
                            <>
                              {personaIconUrl(active.id)
                                ? <img src={personaIconUrl(active.id)} alt="" width={16} height={16} draggable={false} />
                                : <span>{active.emoji}</span>}
                              <span className="agent-chat-flow-persona-name">{active.name}</span>
                            </>
                          ) : (
                            <span>{ko ? '페르소나 선택…' : 'Pick persona…'}</span>
                          )}
                        </button>
                      );
                    })()}
                  </div>
                </React.Fragment>
              ))}
              {harnessRoles.length === 0 && (
                <div className="agent-chat-settings-empty">{ko ? '하니스 역할을 불러오는 중…' : 'Loading harness roles…'}</div>
              )}
            </div>
            <div className="agent-chat-settings-row">
              <button
                className="agent-chat-settings-minor"
                title={ko ? '설계=아키텍트 · 개발=시니어 개발자 · 리뷰=코드 리뷰어' : 'Planner=architect · Developer=senior dev · Reviewer=code reviewer'}
                onClick={() => {
                  for (const [role, recs] of Object.entries(HARNESS_PERSONA_RECS)) {
                    const pick = recs.find((id) => personas.some((p) => p.id === id));
                    if (pick) send({ type: 'set_harness_persona', role, persona: pick });
                  }
                }}
              >
                {ko ? '★ 추천 페르소나 일괄 적용' : '★ Apply recommended personas'}
              </button>
              <button className="agent-chat-settings-minor" onClick={() => send({ type: 'set_harness_role', role: 'all', model: '' })}>
                {ko ? '모두 현재 모델로' : 'All roles → current model'}
              </button>
              <button
                className="agent-chat-settings-minor"
                onClick={() => {
                  for (const role of ['planner', 'developer', 'reviewer']) {
                    send({ type: 'set_harness_persona', role, persona: '' });
                  }
                }}
              >
                {ko ? '페르소나 모두 해제' : 'Clear all personas'}
              </button>
            </div>
            <div className="agent-chat-settings-hint">
              {ko
                ? '/harness에 여러 줄을 입력하면 줄마다 한 작업이 큐로 들어가 순차 실행됩니다 — 한 작업이 끝나면 다음 작업이 같은 세션에서 이어집니다.'
                : 'Multiple lines in /harness queue up: each line is one task, run through the pipeline in order in the same session.'}
            </div>
          </div>

          {/* 페르소나 */}
          <div className="agent-chat-settings-section">
            <div className="agent-chat-settings-title">
              {ko ? '페르소나' : 'Persona'}
              <span className="agent-chat-settings-current">{personaActive ? `${personaActive.emoji} ${personaActive.name}` : (ko ? '없음' : 'none')}</span>
            </div>
            <div className="agent-chat-settings-row">
              <button className="agent-chat-settings-minor" onClick={openPersonaPicker}>
                {ko ? '페르소나 선택…' : 'Choose persona…'}
              </button>
              {personaActive && (
                <button className="agent-chat-settings-minor" onClick={() => sendPrompt('/persona off')}>
                  {ko ? '해제' : 'Clear'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="agent-chat-body">
        {sidebarOpen && (
          <div className="agent-chat-sidebar">
            {/* 세션 선택: 세션 밑에 작업들이 있다 — 목록의 본체는 아래 작업명. */}
            <div className="agent-chat-sidebar-head">
              <span>{ko ? '세션' : 'Session'}</span>
              <div className="agent-chat-sidebar-head-actions">
                {!renaming && (
                  <button
                    className="agent-chat-icon-btn"
                    title={ko ? '세션 이름 수정' : 'Rename session'}
                    onClick={() => {
                      const current = sessions.find((s) => s.id === sessionId);
                      setRenaming(true);
                      setRenameValue(current && current.name !== '-' ? current.name : '');
                    }}
                  >
                    <LucideIcons.Pencil size={12} />
                  </button>
                )}
                <button className="agent-chat-icon-btn" title={ko ? '새 세션' : 'New session'} onClick={newSession}>
                  <LucideIcons.Plus size={13} />
                </button>
              </div>
            </div>
            {renaming ? (
              <input
                className="agent-chat-session-rename"
                autoFocus
                value={renameValue}
                placeholder={ko ? '세션 이름' : 'Session name'}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
              />
            ) : (
              <select
                className="agent-chat-session-select"
                value={sessionId}
                onChange={(e) => {
                  const s = sessions.find((x) => x.id === e.target.value);
                  if (s) openSession(s);
                }}
              >
                {!sessions.some((s) => s.id === sessionId) && sessionId && (
                  <option value={sessionId}>{ko ? '(현재 세션)' : '(current)'}</option>
                )}
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {(s.name && s.name !== '-' ? s.name : s.id.slice(0, 8))} · {s.messages}
                  </option>
                ))}
              </select>
            )}

            <div className="agent-chat-sidebar-head agent-chat-tasks-head">
              <span>{ko ? '작업 목록' : 'Tasks'}</span>
              <div className="agent-chat-sidebar-head-actions">
                <span className="agent-chat-session-meta">
                  {commandTasks.length > 0 && `${commandTasks.filter((t) => t.status === 'done').length}/${commandTasks.length + queued.length}`}
                </span>
                <button
                  className="agent-chat-icon-btn"
                  title={ko ? '태스크 추가' : 'Add task'}
                  onClick={() => { setAddingTask((v) => !v); setNewTaskValue(''); }}
                >
                  <LucideIcons.Plus size={13} />
                </button>
              </div>
            </div>
            {addingTask && (
              <textarea
                className="agent-chat-task-add"
                autoFocus
                rows={4}
                value={newTaskValue}
                placeholder={ko ? '새 태스크 내용을 자세히 적어주세요 — Enter로 추가, Shift+Enter 줄바꿈' : 'Describe the new task — Enter to add, Shift+Enter for newline'}
                onChange={(e) => setNewTaskValue(e.target.value)}
                onBlur={commitAddTask}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commitAddTask();
                  }
                  if (e.key === 'Escape') { setAddingTask(false); setNewTaskValue(''); }
                }}
              />
            )}
            {(commandTasks.length > 0 || queued.length > 0) && (
              <div className="agent-chat-progress" title={ko ? '진행률' : 'Progress'}>
                <div
                  className="agent-chat-progress-fill"
                  style={{ width: `${Math.round((commandTasks.filter((t) => t.status === 'done').length / Math.max(1, commandTasks.length + queued.length)) * 100)}%` }}
                />
              </div>
            )}
            <div className="agent-chat-sidebar-list">
              {commandTasks.length === 0 && queued.length === 0 && (
                <div className="agent-chat-sidebar-empty">
                  {ko ? '명령을 보내면 그 명령이 작업으로 표시됩니다. +로 직접 추가할 수도 있습니다.' : 'Each command you send appears here as a task. Use + to add one directly.'}
                </div>
              )}
              {commandTasks.map((task, index) => {
                const isActiveDoing = task.status === 'doing';
                return (
                  <div key={index}>
                    <div
                      className={`agent-chat-task-item ${task.status} ${taskView && taskView.start === task.entryIndex && taskView.label === task.text ? 'selected' : ''}`}
                      title={task.text}
                      onClick={() => openTaskView(task)}
                    >
                      <span className="agent-chat-task-status">
                        {task.status === 'done' ? '✓' : task.status === 'failed' ? '!' : task.status === 'cancelled' ? '×' : '▶'}
                      </span>
                      <span className="agent-chat-task-name">
                        {task.text}
                        {task.persona && (
                          <span className="agent-chat-task-persona-line" title="Persona for this task">
                            {task.persona}
                          </span>
                        )}
                      </span>
                      <span className={`agent-chat-task-badge ${task.status}`}>
                        {task.status === 'done'
                          ? (ko ? '완료' : 'done')
                          : task.status === 'failed'
                            ? (ko ? '실패' : 'failed')
                            : task.status === 'cancelled'
                              ? (ko ? '취소' : 'cancelled')
                              : (ko ? '진행중' : 'doing')}
                      </span>
                    </div>
                    {/* 진행 중인 명령 밑에 에이전트의 세부 todo를 하위 목록으로. */}
                    {isActiveDoing && todoItems.length > 0 && todoItems.map((sub, subIndex) => (
                      <div
                        key={subIndex}
                        className={`agent-chat-task-item agent-chat-subtask ${sub.status}`}
                        title={sub.text}
                        onClick={() => revealTask(sub)}
                      >
                        <span className="agent-chat-task-status">
                          {sub.status === 'done' ? '✓' : sub.status === 'doing' ? '▶' : '○'}
                        </span>
                        <span className="agent-chat-task-name">{sub.text}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
              {queued.flatMap((q, qi) => q.labels.map((label, li) => (
                <div key={`queued-${qi}-${li}`} className="agent-chat-task-item pending" title={label}>
                  <span className="agent-chat-task-status">○</span>
                  <span className="agent-chat-task-name">{label}</span>
                  <span className="agent-chat-task-badge pending">{ko ? '대기' : 'queued'}</span>
                </div>
              )))}
            </div>
          </div>
        )}

        <div className="agent-chat-main">
          {taskView && (
            <div className="agent-chat-taskview-bar">
              <button onClick={() => { setTaskView(null); stickToBottom.current = true; }} title={ko ? '전체 대화로' : 'Back to full conversation'}>
                <LucideIcons.ArrowLeft size={12} /> {ko ? '전체 대화' : 'All'}
              </button>
              <span className="agent-chat-taskview-label">{taskView.label}</span>
            </div>
          )}
          <div className="agent-chat-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
            {entries.length === 0 && !streaming && (
              <div className="agent-chat-empty">
                <strong>{ko ? '빠릿 에이전트' : 'BBARIT Agent'}</strong>
                <p>
                  {ko
                    ? '작업을 입력하세요 — 여러 줄을 적으면 이 한 세션에서 전부 처리합니다. 계획→개발→검토는 메뉴의 /harness, 전체 명령은 우상단 메뉴에 있습니다.'
                    : 'Type your tasks — multiple lines are all handled in this one session. Use /harness (menu) for plan → build → review; the menu lists every command.'}
                </p>
              </div>
            )}
            {entries.map((entry, index) => {
              // 태스크 전용 화면: 그 태스크 범위 밖의 항목은 숨긴다.
              if (taskView && (index < taskView.start || index >= taskView.end)) return null;
              // 작업(턴) 분리: 사용자 메시지마다 그 앞에 "작업 N" 구분선을 넣어
              // 하나의 지시 → 그에 따른 도구/응답을 시각적으로 한 덩어리로 묶는다.
              const userSoFar = entries.slice(0, index + 1).filter((e) => e.kind === 'user').length;
              const showDivider = entry.kind === 'user' && !(taskView && index === taskView.start);
              return (
                <React.Fragment key={index}>
                  {showDivider && (
                    <div className="agent-chat-turn-divider">
                      <span className="agent-chat-turn-badge">
                        {ko ? `작업 ${userSoFar}` : `Task ${userSoFar}`}
                      </span>
                    </div>
                  )}
                  <TranscriptEntry entry={entry} index={index} ko={ko} />
                </React.Fragment>
              );
            })}
            {thinkingStream && !streaming && working && (!taskView || taskView.end > entries.length) && (
              <div className="agent-chat-msg assistant streaming" style={{ opacity: 0.55 }}>
                <div className="agent-chat-msg-head">
                  <img src="/icons/bbarit-logo.png" alt="" className="agent-chat-avatar" />
                  <span>BBARIT</span>
                  <span className="agent-chat-live">{ko ? '생각 중' : 'thinking'}</span>
                </div>
                <div style={{ fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
                  {thinkingStream.length > 600 ? `…${thinkingStream.slice(-600)}` : thinkingStream}
                </div>
              </div>
            )}
            {streaming && (!taskView || taskView.end > entries.length) && (
              <div className="agent-chat-msg assistant streaming">
                <div className="agent-chat-msg-head">
                  <img src="/icons/bbarit-logo.png" alt="" className="agent-chat-avatar" />
                  <span>BBARIT</span>
                  <span className="agent-chat-live">{ko ? '실시간' : 'live'}</span>
                </div>
                <AssistantMarkdown text={streaming} />
              </div>
            )}
            {working && !streaming && (
              <div className="agent-chat-working">
                <span className="agent-chat-working-orbs"><i /><i /><i /></span>
                {ko ? '작업 중' : 'Working'} · {elapsed}s
              </div>
            )}
          </div>

          {procList.length > 0 && (
            <div className="agent-chat-procs" title={ko ? '이 에이전트가 띄운 외부 프로세스' : 'External processes this agent launched'}>
              <span className="agent-chat-procs-label">
                <LucideIcons.Cpu size={11} /> {ko ? '외부 프로세스' : 'Processes'} {procList.filter((p) => !p.ended).length}
              </span>
              {procList.map((p) => (
                <span key={p.job} className={`agent-chat-proc-chip ${p.ended ? 'ended' : ''}`} title={p.detail}>
                  <span className="agent-chat-proc-dot" />
                  #{p.job} · pid {p.pid}{p.detail ? ` · ${p.detail}` : ''}
                </span>
              ))}
            </div>
          )}

          {queued.length > 0 && (
            <div className="agent-chat-queue">
              <span className="agent-chat-queue-label">{ko ? `대기 ${queued.length}` : `Queued ${queued.length}`}</span>
              {queued.map((q, i) => (
                <span key={i} className="agent-chat-queue-chip" title={q.message}>
                  {q.labels[0]?.slice(0, 28)}{q.labels.length > 1 ? ` 외 ${q.labels.length - 1}` : ''}
                  <button
                    onClick={() => setQueued((prev) => prev.filter((_, j) => j !== i))}
                    title={ko ? '큐에서 제거' : 'Remove from queue'}
                  >
                    <LucideIcons.X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="agent-chat-composer">
            <button
              className="agent-chat-send attach"
              onClick={() => { void attachClipboardImage(); }}
              title={ko ? '실시간 화면 캡처 후 첨부 (취소 시 클립보드 이미지, 붙여넣기도 가능)' : 'Live screen capture and attach (falls back to clipboard image; paste also works)'}
            >
              <LucideIcons.ImagePlus size={14} />
            </button>
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onComposerPaste}
              onDrop={onComposerDrop}
              onDragOver={onComposerDragOver}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={working
                ? (ko ? '작업 중 — 지금 입력하면 큐에 쌓였다가 이어서 실행됩니다 (Enter)' : 'Working — messages typed now queue and run next (Enter)')
                : !alive
                  ? (ko ? '에이전트 연결 중…' : 'Connecting agent…')
                : (ko
                  ? '작업 입력 — 여러 줄이면 한 세션에서 전부 처리합니다 (Shift+Enter 줄바꿈, /로 명령)'
                  : 'Type tasks — multiple lines all run in this one session (Shift+Enter newline, / for commands)')}
              rows={3}
            />
            {working ? (
              <>
                <button className="agent-chat-send queue" onClick={submit} disabled={!input.trim()} title={ko ? '큐에 추가 (턴이 끝나면 실행)' : 'Queue (runs after this turn)'}>
                  <LucideIcons.ListPlus size={14} />
                </button>
                <button className="agent-chat-send stop" onClick={abort} title={ko ? '작업 취소' : 'Cancel'}>
                  <LucideIcons.Square size={14} />
                </button>
              </>
            ) : (
              <button className="agent-chat-send" onClick={submit} disabled={!input.trim() || !alive} title={!alive ? (ko ? '에이전트 연결 대기 중' : 'Waiting for agent connection') : (ko ? '보내기' : 'Send')}>
                <LucideIcons.SendHorizonal size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentChatPanel;
