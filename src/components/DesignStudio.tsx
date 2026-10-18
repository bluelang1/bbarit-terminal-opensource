import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Sparkles, Loader2, Layers, Eye, MessageSquarePlus, Wand2, History, Save,
  ExternalLink, RefreshCw, Trash2, Send, CheckCircle2, X, Palette,
} from 'lucide-react';
import { useDesignAgent, type DesignLogEntry } from './useDesignAgent';

// Claude-Design-style studio: left = conversational design agent, right = live
// canvas of the generated HTML with click-to-comment pins, variation tabs, and
// version history. Drives bbarit-agent (bbarit-design skill) through the RPC
// hook; every deliverable is a self-contained HTML file the agent writes.

export interface DesignStudioProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent: string };
  onOpenFile?: (path: string) => void;
}

interface DesignDoc {
  id: string;
  prompt: string;
  variations: string[];
  createdAt: number;
}

interface CommentItem {
  n: number;
  selector: string;
  tag: string;
  snippet: string;
  note: string;
}

const KINDS = ['Auto', 'Landing page', 'Promo banner', 'Poster', 'Social card', 'Slide', 'Email', 'Dashboard'];
const RATIOS = ['16:9', '1:1', '9:16', '4:3', 'A4'];
const STYLES = ['Auto', 'Minimal', 'Maximalist', 'Editorial', 'Luxury', 'Playful', 'Brutalist', 'Retro-futuristic'];
const CANVAS: Record<string, string> = {
  '16:9': '1920x1080px', '1:1': '1080x1080px', '9:16': '1080x1920px',
  '4:3': '1600x1200px', 'A4': '1240x1754px (A4)',
};
const MAX_HISTORY = 40;

function historyKey(root: string) {
  return `octo-design-studio-history:${(root || 'global').replace(/\/$/, '')}`;
}
function loadHistory(root: string): DesignDoc[] {
  try {
    const raw = localStorage.getItem(historyKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is DesignDoc =>
      typeof d?.id === 'string' && Array.isArray(d?.variations) && typeof d?.createdAt === 'number'
    ).slice(0, MAX_HISTORY);
  } catch { return []; }
}
function saveHistory(root: string, items: DesignDoc[]) {
  try { localStorage.setItem(historyKey(root), JSON.stringify(items.slice(0, MAX_HISTORY))); } catch { /* quota */ }
}

// Injected into every preview so clicking an element in comment mode reports a
// stable-ish selector back to the parent and drops a numbered pin in place.
const COMMENT_SCRIPT = `<script>(function(){
  var enabled=false,n=0;
  function sel(el){
    if(el.id) return '#'+el.id;
    var parts=[],cur=el,depth=0;
    while(cur&&cur.nodeType===1&&cur.tagName!=='BODY'&&depth<4){
      var t=cur.tagName.toLowerCase();
      var cls=(cur.className&&typeof cur.className==='string')?('.'+cur.className.trim().split(/\\s+/).slice(0,2).join('.')):'';
      var p=cur.parentNode,i=1;
      if(p){var sibs=Array.prototype.filter.call(p.children,function(c){return c.tagName===cur.tagName;});if(sibs.length>1)i=sibs.indexOf(cur)+1;}
      parts.unshift(t+cls+(i>1?(':nth-of-type('+i+')'):''));
      cur=cur.parentNode;depth++;
    }
    return parts.join(' > ');
  }
  window.addEventListener('message',function(e){
    var d=e.data||{};
    if(d.__bd==='enable'){enabled=!!d.on;document.body.style.cursor=enabled?'crosshair':'';}
    if(d.__bd==='clear'){
      Array.prototype.forEach.call(document.querySelectorAll('[data-bd-badge]'),function(b){b.remove();});
      Array.prototype.forEach.call(document.querySelectorAll('[data-bd-comment]'),function(x){x.removeAttribute('data-bd-comment');x.style.outline='';});
      n=0;
    }
  });
  document.addEventListener('click',function(e){
    if(!enabled)return;
    e.preventDefault();e.stopPropagation();
    var el=e.target;if(!el||el===document.documentElement||el===document.body)return;
    n++;
    el.setAttribute('data-bd-comment',n);
    el.style.outline='2px solid #ff3b6b';
    var r=el.getBoundingClientRect();
    var b=document.createElement('div');
    b.setAttribute('data-bd-badge',n);b.textContent=n;
    b.style.cssText='position:absolute;z-index:2147483647;background:#ff3b6b;color:#fff;font:700 11px/18px sans-serif;min-width:18px;height:18px;text-align:center;border-radius:9px;padding:0 3px;transform:translate(-4px,-4px);pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.4)';
    b.style.left=(r.left+window.scrollX)+'px';b.style.top=(r.top+window.scrollY)+'px';
    document.body.appendChild(b);
    var txt=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60);
    parent.postMessage({__bd:'picked',n:n,selector:sel(el),tag:el.tagName.toLowerCase(),text:txt},'*');
  },true);
}());</script>`;

function buildSrcDoc(html: string): string {
  if (!html) return '';
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${COMMENT_SCRIPT}</body>`);
  return html + COMMENT_SCRIPT;
}

export function DesignStudio({ projectRoot, theme, onOpenFile }: DesignStudioProps) {
  const agent = useDesignAgent(projectRoot, 'design-studio');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState(KINDS[0]);
  const [ratio, setRatio] = useState(RATIOS[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [variationCount, setVariationCount] = useState(1);

  const [history, setHistory] = useState<DesignDoc[]>(() => loadHistory(projectRoot));
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => loadHistory(projectRoot)[0]?.id ?? null);
  const [activePath, setActivePath] = useState<string | null>(() => loadHistory(projectRoot)[0]?.variations[0] ?? null);

  const [previewHtml, setPreviewHtml] = useState('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [commentMode, setCommentMode] = useState(false);
  const [comments, setComments] = useState<Record<string, CommentItem[]>>({});
  const [error, setError] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const selectedDoc = history.find((d) => d.id === selectedDocId) || history[0] || null;
  const pathComments = activePath ? (comments[activePath] || []) : [];

  useEffect(() => {
    const items = loadHistory(projectRoot);
    setHistory(items);
    setSelectedDocId(items[0]?.id ?? null);
    setActivePath(items[0]?.variations[0] ?? null);
  }, [projectRoot]);

  useEffect(() => { saveHistory(projectRoot, history); }, [projectRoot, history]);

  // Load the active file into the preview whenever it changes or is regenerated.
  useEffect(() => {
    let cancelled = false;
    if (!activePath) { setPreviewHtml(''); return; }
    (async () => {
      try {
        const html = await invoke<string>('read_file', { path: activePath });
        if (!cancelled) setPreviewHtml(html);
      } catch {
        if (!cancelled) setPreviewHtml('');
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, previewNonce]);

  // Auto-scroll the agent log.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [agent.log.length, agent.activity]);

  // Receive element picks from the preview iframe.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data || {};
      if (d.__bd !== 'picked' || !activePath) return;
      setComments((prev) => {
        const list = prev[activePath] || [];
        if (list.some((c) => c.n === d.n)) return prev;
        return { ...prev, [activePath]: [...list, { n: d.n, selector: String(d.selector || ''), tag: String(d.tag || ''), snippet: String(d.text || ''), note: '' }] };
      });
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [activePath]);

  const postToPreview = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  useEffect(() => { postToPreview({ __bd: 'enable', on: commentMode }); }, [commentMode, previewHtml, postToPreview]);

  const setActive = useCallback((path: string) => {
    setActivePath(path);
    setCommentMode(false);
  }, []);

  const clearComments = useCallback(() => {
    if (activePath) setComments((prev) => ({ ...prev, [activePath]: [] }));
    postToPreview({ __bd: 'clear' });
  }, [activePath, postToPreview]);

  const updateComment = useCallback((n: number, note: string) => {
    if (!activePath) return;
    setComments((prev) => ({
      ...prev,
      [activePath]: (prev[activePath] || []).map((c) => (c.n === n ? { ...c, note } : c)),
    }));
  }, [activePath]);

  const openProduced = useCallback(async (paths: string[]): Promise<string[]> => {
    const landed: string[] = [];
    for (const p of paths) {
      try { await invoke<string>('read_file', { path: p }); landed.push(p); } catch { /* skipped */ }
    }
    return landed;
  }, []);

  const generate = useCallback(async () => {
    if (!prompt.trim()) { setError('Enter your design request.'); return; }
    if (!projectRoot) { setError('Open a project first — the studio writes into the project folder.'); return; }
    if (agent.busy) return;
    setError(null);
    const root = projectRoot.replace(/\/$/, '');
    const dir = `${root}/makeke/design`;
    await invoke('create_directory', { path: dir }).catch(() => {});
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const count = Math.max(1, Math.min(4, variationCount));
    const paths = Array.from({ length: count }, (_, i) =>
      count === 1 ? `${dir}/design-${ts}.html` : `${dir}/design-${ts}-v${i + 1}.html`);
    const variationLine = count === 1
      ? `- 파일 1개를 생성: ${paths[0]}`
      : `- 서로 뚜렷이 다른 ${count}개의 시안(레이아웃/톤/색 강조가 다르게)을 각 경로에 저장:\n${paths.map((p, i) => `  시안 ${i + 1} → ${p}`).join('\n')}`;
    agent.note('you', prompt.trim());
    agent.note('sys', `Generating ${count} design${count > 1 ? ' variations' : ''}…`);
    const message = `당신은 빠릿디자인 스킬로 작업하는 시니어 프로덕트/비주얼 디자이너입니다. 먼저 스킬 파일을 read 도구로 읽어 방법론을 적용하세요.

[작업]
1. 완전한 자기완결형 마케팅 디자인 HTML을 만드세요.
${variationLine}
2. write 도구로 각 파일을 저장(외부 리소스 없이, CSS/JS 인라인).
3. browser 도구로 각 file:// 경로를 navigate → screenshot → console 확인하여 실제 렌더 검증, 깨지면 수정.
4. 끝나면 저장한 경로만 짧게 보고.

[규칙]
- <!DOCTYPE html>로 시작, </html>로 끝나는 완전한 HTML.
- 한글: word-break: keep-all; overflow-wrap: break-word; line-height >= 1.08. 잘림 없이 여백 안에.

[요청] ${prompt.trim()}
[형식] ${kind}   [캔버스] ${CANVAS[ratio] || CANVAS['16:9']}   [스타일] ${style}`;
    const result = await agent.run(message);
    if (!result.ok) { setError(result.error || 'The design agent did not finish.'); agent.note('sys', `⚠ ${result.error || 'no result'}`); return; }
    const landed = await openProduced(paths);
    if (landed.length === 0) { setError('The agent finished but wrote no design file.'); agent.note('sys', '⚠ no file produced'); return; }
    const doc: DesignDoc = { id: `d-${Date.now()}`, prompt: prompt.trim(), variations: landed, createdAt: Date.now() };
    setHistory((prev) => [doc, ...prev].slice(0, MAX_HISTORY));
    setSelectedDocId(doc.id);
    setActive(landed[0]);
    setPreviewNonce((v) => v + 1);
    agent.note('sys', `✓ ${landed.length} design${landed.length > 1 ? 's' : ''} ready`);
  }, [prompt, projectRoot, agent, variationCount, kind, ratio, style, openProduced, setActive]);

  const applyComments = useCallback(async () => {
    if (!activePath || agent.busy) return;
    const list = pathComments.filter((c) => c.note.trim());
    if (list.length === 0) { setError('Add a note to at least one pin first.'); return; }
    setError(null);
    const items = list.map((c) => `- 요소 #${c.n} (${c.selector}${c.snippet ? `, 현재 텍스트: "${c.snippet}"` : ''}) → ${c.note.trim()}`).join('\n');
    agent.note('you', `${list.length}개 요소에 코멘트 반영`);
    const message = `빠릿디자인 스킬로 작업하는 디자이너입니다. 필요하면 스킬 파일을 read 하세요.

[작업]
1. 파일 ${activePath} 을(를) read 하세요.
2. 아래 각 코멘트를 해당 요소에만 반영하세요. 지목되지 않은 레이아웃/색/폰트/간격은 그대로 두고, edit/patch로 최소 변경만.
3. browser로 file://${activePath} 를 navigate → screenshot 하여 렌더 확인 후 종료.

[요소별 코멘트]
${items}`;
    const result = await agent.run(message);
    if (!result.ok) { setError(result.error || 'The edit did not finish.'); return; }
    clearComments();
    setPreviewNonce((v) => v + 1);
    agent.note('sys', '✓ comments applied');
  }, [activePath, agent, pathComments, clearComments]);

  const saveVersion = useCallback(async () => {
    if (!activePath || !selectedDoc) return;
    try {
      const html = await invoke<string>('read_file', { path: activePath });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const versioned = activePath.replace(/\.html$/i, `-v${ts}.html`);
      await invoke('write_file', { path: versioned, content: html });
      setHistory((prev) => prev.map((d) => d.id === selectedDoc.id ? { ...d, variations: [...d.variations, versioned] } : d));
      setActive(versioned);
      agent.note('sys', `✓ saved version ${versioned.split('/').pop()}`);
    } catch (e) {
      setError(`Could not save a version: ${e}`);
    }
  }, [activePath, selectedDoc, setActive, agent]);

  const srcDoc = useMemo(() => buildSrcDoc(previewHtml), [previewHtml]);

  const busy = agent.busy;
  const t = theme;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: t.bg, color: t.text }}>
      {/* ── Left rail: conversational design agent ── */}
      <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${t.text}18`, minHeight: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${t.text}14`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Palette size={16} color={t.accent} />
          <span style={{ fontSize: 13, fontWeight: 800 }}>빠릿디자인 Studio</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.55, display: 'flex', alignItems: 'center', gap: 4 }}>
            {agent.status === 'starting' ? <><Loader2 size={11} className="spin" /> starting</> : agent.status === 'running' ? <><Loader2 size={11} className="spin" /> working</> : <><CheckCircle2 size={11} /> ready</>}
          </span>
        </div>

        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, borderBottom: `1px solid ${t.text}12` }}>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
            placeholder="Describe the design — e.g. a premium promo banner for a coffee roastery launch"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate(); }}
            style={{ width: '100%', resize: 'vertical', background: `${t.text}08`, color: t.text, border: `1px solid ${t.text}20`, borderRadius: 8, padding: 9, fontSize: 12.5, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <StudioSelect value={kind} onChange={setKind} opts={KINDS} t={t} />
            <StudioSelect value={ratio} onChange={setRatio} opts={RATIOS} t={t} />
            <StudioSelect value={style} onChange={setStyle} opts={STYLES} t={t} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.65, display: 'flex', alignItems: 'center', gap: 4 }}><Layers size={12} /> Variations</span>
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" onClick={() => setVariationCount(n)}
                style={{ width: 28, height: 26, borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                  border: `1px solid ${variationCount === n ? t.accent : `${t.text}22`}`,
                  background: variationCount === n ? t.accent : 'transparent', color: variationCount === n ? '#fff' : t.text }}>{n}</button>
            ))}
          </div>
          <button type="button" onClick={() => void generate()} disabled={!prompt.trim() || busy}
            style={{ padding: '10px 14px', borderRadius: 9, border: 0, cursor: !prompt.trim() || busy ? 'not-allowed' : 'pointer',
              background: !prompt.trim() || busy ? `${t.text}18` : t.accent, color: !prompt.trim() || busy ? `${t.text}55` : '#fff',
              fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {busy ? 'Designing…' : `Generate${variationCount > 1 ? ` ×${variationCount}` : ''}`}
          </button>
          {error && <div style={{ fontSize: 11, color: '#ff6b6b', display: 'flex', alignItems: 'center', gap: 4 }}><X size={12} /> {error}</div>}
        </div>

        {/* Agent conversation / activity */}
        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 7, minHeight: 0 }}>
          {agent.log.length === 0 && <div style={{ fontSize: 11, opacity: 0.4, textAlign: 'center', marginTop: 20 }}>The design conversation appears here.</div>}
          {agent.log.map((l) => <LogRow key={l.id} entry={l} t={t} />)}
          {busy && agent.activity && <div style={{ fontSize: 11, opacity: 0.6, display: 'flex', alignItems: 'center', gap: 5 }}><Loader2 size={11} className="spin" /> {agent.activity}</div>}
        </div>

        {/* History */}
        {history.length > 0 && (
          <div style={{ borderTop: `1px solid ${t.text}12`, padding: 10, maxHeight: 150, overflowY: 'auto' }}>
            <div style={{ fontSize: 10, fontWeight: 700, opacity: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}><History size={11} /> History</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {history.map((d) => (
                <button key={d.id} type="button" title={d.prompt}
                  onClick={() => { setSelectedDocId(d.id); setActive(d.variations[0]); setPreviewNonce((v) => v + 1); }}
                  style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5,
                    border: `1px solid ${selectedDocId === d.id ? t.accent : `${t.text}18`}`,
                    background: selectedDocId === d.id ? `${t.accent}18` : 'transparent', color: t.text,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.prompt.slice(0, 40) || 'design'}{d.variations.length > 1 ? `  ·${d.variations.length}` : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Right: live canvas ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderBottom: `1px solid ${t.text}14`, flexWrap: 'wrap' }}>
          {selectedDoc && selectedDoc.variations.map((p, i) => (
            <button key={p} type="button" onClick={() => setActive(p)}
              style={{ padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                border: `1px solid ${activePath === p ? t.accent : `${t.text}20`}`,
                background: activePath === p ? t.accent : 'transparent', color: activePath === p ? '#fff' : t.text }}>
              {selectedDoc.variations.length > 1 ? `v${i + 1}` : 'Design'}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <ToolBtn onClick={() => setCommentMode((v) => !v)} active={commentMode} t={t} disabled={!activePath} icon={<MessageSquarePlus size={14} />} label={commentMode ? 'Commenting' : 'Comment'} />
          <ToolBtn onClick={() => void applyComments()} t={t} disabled={!activePath || busy || pathComments.filter((c) => c.note.trim()).length === 0} icon={busy ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} label="Apply" />
          <ToolBtn onClick={() => void saveVersion()} t={t} disabled={!activePath || busy} icon={<Save size={14} />} label="Version" />
          <ToolBtn onClick={() => setPreviewNonce((v) => v + 1)} t={t} disabled={!activePath} icon={<RefreshCw size={14} />} label="Refresh" />
          <ToolBtn onClick={() => activePath && onOpenFile?.(activePath)} t={t} disabled={!activePath} icon={<ExternalLink size={14} />} label="Editor" />
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', background: '#f4f4f5', minWidth: 0 }}>
            {activePath ? (
              <iframe ref={iframeRef} title="design-canvas" srcDoc={srcDoc}
                sandbox="allow-scripts allow-same-origin"
                onLoad={() => postToPreview({ __bd: 'enable', on: commentMode })}
                style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#71717a', fontSize: 13, gap: 8, flexDirection: 'column' }}>
                <Eye size={28} opacity={0.4} />
                Generate a design to see it live here.
              </div>
            )}
            {commentMode && (
              <div style={{ position: 'absolute', top: 8, left: 8, background: '#ff3b6b', color: '#fff', fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 6, pointerEvents: 'none' }}>
                Click any element to pin a comment
              </div>
            )}
          </div>

          {/* Comment panel */}
          {(commentMode || pathComments.length > 0) && activePath && (
            <div style={{ width: 250, flexShrink: 0, borderLeft: `1px solid ${t.text}18`, background: t.bg, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '9px 11px', borderBottom: `1px solid ${t.text}12`, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
                <MessageSquarePlus size={13} /> Comments ({pathComments.length})
                {pathComments.length > 0 && (
                  <button type="button" onClick={clearComments} title="Clear all"
                    style={{ marginLeft: 'auto', background: 'transparent', border: 0, cursor: 'pointer', color: `${t.text}88`, display: 'flex' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 0 }}>
                {pathComments.length === 0 && <div style={{ fontSize: 11, opacity: 0.45 }}>Click elements in the canvas to add pinned comments, write what to change, then Apply.</div>}
                {pathComments.map((c) => (
                  <div key={c.n} style={{ border: `1px solid ${t.text}18`, borderRadius: 7, padding: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ width: 18, height: 18, borderRadius: 9, background: '#ff3b6b', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{c.n}</span>
                      <span style={{ fontSize: 10.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.selector}>{c.tag}{c.snippet ? ` · ${c.snippet}` : ''}</span>
                    </div>
                    <input type="text" value={c.note} onChange={(e) => updateComment(c.n, e.target.value)}
                      placeholder="What to change…"
                      onKeyDown={(e) => { if (e.key === 'Enter') void applyComments(); }}
                      style={{ width: '100%', background: `${t.text}08`, color: t.text, border: `1px solid ${t.text}20`, borderRadius: 5, padding: '5px 7px', fontSize: 11.5, boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => void applyComments()} disabled={busy || pathComments.filter((c) => c.note.trim()).length === 0}
                style={{ margin: 10, padding: '9px', borderRadius: 8, border: 0, cursor: busy ? 'not-allowed' : 'pointer',
                  background: busy || pathComments.filter((c) => c.note.trim()).length === 0 ? `${t.text}18` : t.accent,
                  color: busy || pathComments.filter((c) => c.note.trim()).length === 0 ? `${t.text}55` : '#fff',
                  fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Apply {pathComments.filter((c) => c.note.trim()).length || ''} comment{pathComments.filter((c) => c.note.trim()).length === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StudioSelect({ value, onChange, opts, t }: { value: string; onChange: (v: string) => void; opts: string[]; t: { text: string; bg: string } }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ background: `${t.text}08`, color: t.text, border: `1px solid ${t.text}20`, borderRadius: 6, padding: '5px 4px', fontSize: 11, fontFamily: 'inherit' }}>
      {opts.map((o) => <option key={o} value={o} style={{ background: t.bg, color: t.text }}>{o}</option>)}
    </select>
  );
}

function ToolBtn({ onClick, icon, label, t, active, disabled }: { onClick: () => void; icon: React.ReactNode; label: string; t: { text: string; accent: string }; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 9px', borderRadius: 7, fontSize: 11.5, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${active ? t.accent : `${t.text}20`}`,
        background: active ? t.accent : 'transparent', color: active ? '#fff' : disabled ? `${t.text}45` : t.text }}>
      {icon} {label}
    </button>
  );
}

function LogRow({ entry, t }: { entry: DesignLogEntry; t: { text: string; accent: string } }) {
  if (entry.role === 'you') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '90%', background: t.accent, color: '#fff', borderRadius: '10px 10px 2px 10px', padding: '6px 10px', fontSize: 12 }}>{entry.text}</div>
    );
  }
  if (entry.role === 'sys') {
    return <div style={{ fontSize: 10.5, opacity: 0.55, textAlign: 'center' }}>{entry.text}</div>;
  }
  if (entry.role === 'tool') {
    return <div style={{ fontSize: 10.5, opacity: 0.5, fontFamily: 'monospace' }}>▸ {entry.text}</div>;
  }
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '92%', background: `${t.text}0d`, color: t.text, borderRadius: '10px 10px 10px 2px', padding: '6px 10px', fontSize: 12, whiteSpace: 'pre-wrap' }}>{entry.text}</div>
  );
}
