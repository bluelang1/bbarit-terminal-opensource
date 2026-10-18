/**
 * AsideAgentPane — 사이드바 빠릿 챗 패널 (설계 §5.1 + Aside 브라우저 문법 이식).
 *
 * AgentChatPanel(D15 재사용) 위에 Aside 문법을 얹는다:
 * - 컨텍스트 칩: 현재 탭이 자동 1개, ×로 그 턴부터 완전 제외(Brave 문법).
 * - @탭 멘션(P2): 다른 열린 탭을 칩으로 추가해 멀티탭 컨텍스트로 전송.
 * - 브라우징 메모리 칩(Aside 문법): 켜면 frecency 상위 히스토리를 컨텍스트로 접합.
 * - 프리셋 칩: 요약/번역/추출/감사/역설계/수집/감지 — 호스트의 기존 주입 경로로 실행.
 * - 최근 태스크(Aside 문법): 이 패널에서 보낸 태스크를 칩으로 저장, 클릭 재실행.
 * - 승인 게이트(D17 표시 계층): 민감 태스크는 [Run/Cancel] 배너로 사람 승인 후 실행.
 * - 감사 로그(Aside 문법): 태스크 전송과 에이전트 툴 호출을 시간순으로 기록.
 * - 접합(D15): promptPrefix로 RPC 메시지에만 컨텍스트 블록을 붙인다.
 */
import { useMemo, useRef, useState } from 'react';
import { X, Globe, Plus, Brain, ShieldAlert, ScrollText, SearchCheck, MousePointerClick, FileText } from 'lucide-react';
import { AgentChatPanel } from '../../components/AgentChatPanel';
import { buildAsideAgentPromptPrefix, hostPath } from './asideAgentPrompt';

export interface AsideTabInfo { id: number; title: string; url: string }
export interface AsideRecentTask { id: string; text: string; at: number }
export interface AsideAuditEntry { at: number; kind: string; text: string }

interface Props {
  workDir: string;
  browserWindowLabel: string;
  /** 활성 CEF 탭 정보 — 없으면(엔진 꺼짐/탭 없음) 칩 자리에 안내를 띄운다. */
  pageUrl: string | null;
  pageTitle: string | null;
  /** 선택 텍스트(P2에서 CDP 버블로 채워짐) — 있으면 컨텍스트 블록에 포함. */
  selectionText?: string | null;
  /** 열린 탭 전체(@멘션 후보). 활성 탭은 자동 칩이므로 목록에서 제외해 보여준다. */
  tabs: AsideTabInfo[];
  activeTabId: number | null;
  /** Aside 메모리 문법: 켜져 있을 때 접합할 최근 브라우징 요약 라인들. */
  memoryProvider: () => string[];
  /** 최근 태스크(칩 클릭 = 재실행)와 태스크 실행 경로(승인 게이트 포함). */
  recentTasks: AsideRecentTask[];
  onRunTask: (text: string) => void;
  /** 민감 태스크 승인 게이트 — 호스트가 보류 중인 태스크를 내려주면 배너로 묻는다. */
  pendingTask: string | null;
  onConfirmTask: () => void;
  onCancelTask: () => void;
  /** 감사 로그(태스크 전송/툴 호출) — 호스트가 kv로 영속한다. */
  auditLog: AsideAuditEntry[];
  onToolEvent: (toolName: string, preview: string) => void;
  /** 패널 내 전체화면 모달(페르소나 피커) 열림 통지 — 호스트가 CEF 뷰를 숨긴다. */
  onModalOpenChange?: (open: boolean) => void;
  initialPrompt?: string;
  initialPromptNonce?: number;
}

const PRESETS: { label: string; prompt: string }[] = [
  { label: 'Summarize', prompt: 'Summarize the key points of the current page in 5 lines or fewer.' },
  { label: 'Explain', prompt: 'Explain the core concept of the current page in simple terms, with one analogy and one example.' },
  { label: 'Translate', prompt: 'Translate the main content of the current page into Korean, focusing on the key sections.' },
  { label: 'Key points', prompt: 'Extract a structured outline of the current page: main sections with 2-3 bullets each.' },
  { label: 'Ask page', prompt: 'Answer my questions about the current page using only page context first. Cite the section or visible evidence you used, and say what is uncertain.' },
  { label: 'Fact-check', prompt: 'Identify the main claims on the current page and verify each against reliable web sources with verdicts and links.' },
  { label: 'Compare tabs', prompt: 'Compare the current page with any mentioned tabs. Summarize differences in purpose, pricing, UX, claims, and missing opportunities.' },
  { label: 'Research brief', prompt: 'Create a research brief from the current page and mentioned tabs: thesis, supporting evidence, contradictions, open questions, and next actions.' },
  { label: 'Action plan', prompt: 'Turn the current page goal into a step-by-step browser action plan. Identify likely buttons, fields, risks, and checkpoints before taking any action.' },
  { label: 'Link map', prompt: 'Map the current page links by type (internal, external, download, social), identify the most useful navigation targets, and recommend what to open next.' },
  { label: 'Extract', prompt: 'Extract the table/list data from the current page and organize it into a table.' },
  { label: 'Load all', prompt: 'Load all visible list results on the current page using safe pagination, load-more, or scrolling. Stop when the list no longer grows, then summarize what was loaded.' },
  { label: 'Export CSV', prompt: 'Extract the useful table or repeated-list data from the current page and prepare a CSV export. If saving to the project is needed, confirm the filename first.' },
  { label: 'Watch changes', prompt: 'Create or compare a change snapshot for this page. Report price, availability, count, or key text changes since the previous snapshot if one exists.' },
  { label: 'Dismiss cookies', prompt: 'Detect any cookie or consent banner on the current page and dismiss it using the least data-sharing option, preferring reject or necessary-only when available.' },
  { label: 'Form helper', prompt: 'Inspect the current form or checkout page. Explain required fields, likely validation issues, privacy risks, and draft safe field values without submitting.' },
  { label: 'Reply', prompt: 'Read the visible thread/message on the current page and draft a contextual reply in my voice — one formal, one casual.' },
  { label: 'Audit', prompt: 'Audit the SEO of the current page and list improvements by priority.' },
  { label: 'Shop check', prompt: 'Evaluate the product or offer on the current page: price sanity, review signals, red flags, alternatives, and whether to buy now or wait.' },
  { label: 'Reverse', prompt: 'Reverse-engineer the UI/feature structure of the current page and explain it from an implementation perspective.' },
];

const WORKFLOWS: { label: string; intent: string; icon: typeof SearchCheck; prompt: string }[] = [
  {
    label: 'Understand',
    intent: 'read, cite, compare',
    icon: SearchCheck,
    prompt: 'Run an AI browser understanding pass on the current page: summarize it, answer the most likely user questions, cite visible evidence, compare any mentioned tabs, and list what remains uncertain.',
  },
  {
    label: 'Act safely',
    intent: 'plan before clicks',
    icon: MousePointerClick,
    prompt: 'Prepare a safe browser action plan for the current page. Identify the exact controls to use, data needed, validation risks, privacy/security risks, and checkpoints. Do not click, type, submit, purchase, or sign in until I approve.',
  },
  {
    label: 'Create output',
    intent: 'brief, table, draft',
    icon: FileText,
    prompt: 'Turn the current page and mentioned tabs into useful output: a concise brief, a structured table of key facts, recommended next actions, and any draft message or document that would naturally follow.',
  },
  {
    label: 'Collect data',
    intent: 'load, extract, export',
    icon: FileText,
    prompt: 'Run a data-collection pass on the current page: dismiss consent if needed, load the full list safely, map important links, extract repeated records, and prepare CSV/JSON output with a clear save recommendation.',
  },
];

export function AsideAgentPane({
  workDir, browserWindowLabel, pageUrl, pageTitle, selectionText,
  tabs, activeTabId, memoryProvider,
  recentTasks, onRunTask, pendingTask, onConfirmTask, onCancelTask,
  auditLog, onToolEvent, onModalOpenChange, initialPrompt, initialPromptNonce,
}: Props) {
  // 칩 제외 = 그 시점부터 컨텍스트 완전 미전송. 탭이 바뀌면 다시 켜진다(새 문맥).
  const [includeCtx, setIncludeCtx] = useState(true);
  const [memoryOn, setMemoryOn] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionedIds, setMentionedIds] = useState<number[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const lastUrlRef = useRef<string | null>(null);
  if (pageUrl !== lastUrlRef.current) {
    lastUrlRef.current = pageUrl;
    if (!includeCtx) setIncludeCtx(true);
  }

  // 닫힌 탭 멘션은 렌더/접합 시점에 자연 소거.
  const mentionedTabs = tabs.filter((t) => mentionedIds.includes(t.id) && t.id !== activeTabId);
  const mentionCandidates = tabs.filter((t) => t.id !== activeTabId && !mentionedIds.includes(t.id));

  // promptPrefix는 전송 "시점"에 호출되므로 최신 값을 ref로 본다.
  const ctxRef = useRef({ includeCtx, pageUrl, pageTitle, selectionText, mentionedTabs, memoryOn });
  ctxRef.current = { includeCtx, pageUrl, pageTitle, selectionText, mentionedTabs, memoryOn };
  const memoryProviderRef = useRef(memoryProvider);
  memoryProviderRef.current = memoryProvider;
  const promptPrefix = useMemo(() => () => {
    const snapshot = ctxRef.current;
    return buildAsideAgentPromptPrefix({
      includeCtx: snapshot.includeCtx,
      pageUrl: snapshot.pageUrl,
      pageTitle: snapshot.pageTitle,
      selectionText: snapshot.selectionText,
      mentionedTabs: snapshot.mentionedTabs,
      memoryOn: snapshot.memoryOn,
      memoryLines: snapshot.memoryOn ? memoryProviderRef.current() : [],
    });
  }, []);

  const chipLabel = useMemo(() => (pageUrl ? hostPath(pageUrl).slice(0, 42) : null), [pageUrl]);

  return (
    <div className="aside-agent-pane">
      <div className="aside-agent-ctx">
        {chipLabel ? (
          includeCtx ? (
            <span className="aside-ctx-chip" title={`${pageTitle ?? ''}\n${pageUrl}\nThis page is sent to BBARIT — click × to exclude`}>
              <Globe size={11} />
              <span className="aside-ctx-chip-label">{chipLabel}</span>
              <button type="button" aria-label="Exclude context" onClick={() => setIncludeCtx(false)}><X size={11} /></button>
            </span>
          ) : (
            <button type="button" className="aside-ctx-chip off" title="Click to include the current page as context again" onClick={() => setIncludeCtx(true)}>
              <Globe size={11} /> Context off
            </button>
          )
        ) : (
          <span className="aside-ctx-chip off" title="Browser engine is off or no tab is open">
            <Globe size={11} /> No page
          </span>
        )}
        {mentionedTabs.map((t) => (
          <span key={t.id} className="aside-ctx-chip mention" title={`${t.title}\n${t.url}\nMentioned tab — sent as extra context`}>
            @<span className="aside-ctx-chip-label">{hostPath(t.url).slice(0, 30)}</span>
            <button type="button" aria-label="Remove mention" onClick={() => setMentionedIds((ids) => ids.filter((id) => id !== t.id))}><X size={11} /></button>
          </span>
        ))}
        {mentionCandidates.length > 0 && (
          <button type="button" className={`aside-ctx-chip add${mentionOpen ? ' open' : ''}`} title="Mention another open tab as context" onClick={() => setMentionOpen((v) => !v)}>
            <Plus size={11} /> Tab
          </button>
        )}
        <button
          type="button"
          className={`aside-ctx-chip memory${memoryOn ? ' on' : ' off'}`}
          title={memoryOn ? 'Browsing memory is included as context — click to turn off' : 'Include recent browsing memory as context'}
          onClick={() => setMemoryOn((v) => !v)}
        >
          <Brain size={11} /> Memory
        </button>
      </div>
      {mentionOpen && mentionCandidates.length > 0 && (
        <div className="aside-mention-list">
          {mentionCandidates.slice(0, 8).map((t) => (
            <button key={t.id} type="button" title={t.url} onClick={() => { setMentionedIds((ids) => [...ids, t.id]); setMentionOpen(false); }}>
              {t.title || hostPath(t.url)}
            </button>
          ))}
        </div>
      )}
      {pendingTask && (
        <div className="aside-approve-banner" role="alertdialog" aria-label="Sensitive task approval">
          <ShieldAlert size={13} />
          <span className="aside-approve-text" title={pendingTask}>Sensitive task — run it?</span>
          <button type="button" className="aside-approve-run" onClick={onConfirmTask}>Run</button>
          <button type="button" className="aside-approve-cancel" onClick={onCancelTask}>Cancel</button>
        </div>
      )}
      <div className="aside-agent-workflows" aria-label="AI browser workflows">
        {WORKFLOWS.map((w) => {
          const Icon = w.icon;
          return (
            <button key={w.label} type="button" disabled={!pageUrl} title={w.prompt} onClick={() => onRunTask(w.prompt)}>
              <Icon size={13} />
              <span className="aside-workflow-copy">
                <span className="aside-workflow-label">{w.label}</span>
                <span className="aside-workflow-intent">{w.intent}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="aside-agent-presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" disabled={!pageUrl} onClick={() => onRunTask(p.prompt)}>{p.label}</button>
        ))}
      </div>
      {recentTasks.length > 0 && (
        <div className="aside-recent-tasks">
          <span className="aside-recent-label">Recent</span>
          {recentTasks.slice(0, 5).map((t) => (
            <button key={t.id} type="button" title={t.text} onClick={() => onRunTask(t.text)}>
              {t.text.replace(/\s+/g, ' ').slice(0, 34)}
            </button>
          ))}
        </div>
      )}
      <div className="aside-agent-chat">
        <AgentChatPanel
          workDir={workDir}
          label="BBARIT Agent"
          browserWindowLabel={browserWindowLabel}
          initialPrompt={initialPrompt}
          initialPromptNonce={initialPromptNonce}
          compact
          promptPrefix={promptPrefix}
          onToolEvent={onToolEvent}
          onModalOpenChange={onModalOpenChange}
          persistOnUnmount
          persistenceKey={`browser-aside:${browserWindowLabel}`}
        />
      </div>
      <div className={`aside-audit${auditOpen ? ' open' : ''}`}>
        <button type="button" className="aside-audit-toggle" title="Every task and agent tool action, newest first" onClick={() => setAuditOpen((v) => !v)}>
          <ScrollText size={12} /> Audit log{auditLog.length > 0 ? ` (${auditLog.length})` : ''}
        </button>
        {auditOpen && (
          <div className="aside-audit-list">
            {auditLog.length === 0 && <div className="aside-audit-empty">No activity yet.</div>}
            {auditLog.slice(-40).reverse().map((e, i) => (
              <div key={`${e.at}-${i}`} className="aside-audit-row" title={e.text}>
                <span className="aside-audit-time">{new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}</span>
                <span className={`aside-audit-kind k-${e.kind}`}>{e.kind}</span>
                <span className="aside-audit-text">{e.text.replace(/\s+/g, ' ').slice(0, 80)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
