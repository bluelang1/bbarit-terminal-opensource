import { useEffect, useRef, useState } from 'react';
import {
  createAgentStreamModel,
  createAtlasStreamModel,
  DEFAULT_USD_KRW,
  fetchAgentModels,
  fetchAtlasModels,
  fetchUsdToKrw,
  formatRoundtableTranscript,
  runRoundtable,
  saveRoundtableToDocs,
  saveRoundtableToLearning,
  type AtlasPricing,
  type RoundtableAttachment,
  type RoundtableMode,
  type RoundtableParticipant,
  type RoundtableTurn,
  type UsageEntry,
} from './modelRoundtable';

function readFile(file: File): Promise<RoundtableAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isImage = file.type.startsWith('image/');
    reader.onerror = () => reject(reader.error);
    reader.onload = () =>
      resolve({ kind: isImage ? 'image' : 'data', name: file.name, value: String(reader.result || '') });
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

// Atlas Cloud의 최신 대표 모델들(프런티어 + 오픈웨이트). 토론은 이 중에서 다수 선택해
// 진행한다. ID는 Atlas Cloud 모델 페이지 기준이며, 열릴 때 실제 사용 가능한 것만 추린다.
const ATLAS_MODELS: Array<{ model: string; label: string }> = [
  { model: 'anthropic/claude-opus-4.7', label: 'Claude Opus 4.7' },
  { model: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { model: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { model: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
  { model: 'deepseek-ai/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { model: 'qwen/qwen3.6-plus', label: 'Qwen3.6 Plus' },
  { model: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { model: 'zai-org/glm-5.1', label: 'GLM 5.1' },
];

const allSelected = () => Object.fromEntries(ATLAS_MODELS.map((m) => [m.model, true]));

// 빠릿에이전트 엔진: 로그인된 프로바이더의 모델 중 프로바이더당 대표 하나를
// 기본 선택한다 (선호 id 우선, 없으면 첫 모델). 나머지는 드롭다운으로 추가.
const AGENT_PREFERRED_IDS = [
  'claude-fable-5', 'claude-opus-4-8', 'claude-haiku-4-5',
  'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner',
  'gpt-5.6-sol', 'gpt-5.4', 'gemini-3.1-pro', 'glm-5.2', 'kimi-k2.6',
];

function pickAgentDefaults(
  models: Array<{ id: string; name?: string; provider: string }>,
  readyProviders: string[],
): Array<{ model: string; label: string }> {
  const picks: Array<{ model: string; label: string }> = [];
  for (const provider of readyProviders) {
    const mine = models.filter((m) => m.provider === provider);
    if (!mine.length) continue;
    const preferred = AGENT_PREFERRED_IDS
      .map((id) => mine.find((m) => m.id === id || m.id.startsWith(id)))
      .find(Boolean);
    const chosen = preferred || mine[0];
    picks.push({ model: `${chosen.provider}/${chosen.id}`, label: `${chosen.name || chosen.id} (${chosen.provider})` });
    if (picks.length >= 6) break;
  }
  return picks;
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)', zIndex: 2147483646,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const modal: React.CSSProperties = {
  width: 'min(720px, 92vw)', maxHeight: '86vh', background: 'var(--bg-color, #101014)', color: 'var(--text-color, #e5e5e5)',
  borderRadius: 'var(--brutal-radius)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden',
  boxShadow: '0 10px 40px rgba(0,0,0,0.5)', fontSize: 13, border: '1px solid color-mix(in srgb, var(--accent-color, #6d8bff) 45%, transparent)',
};

export function ModelRoundtableModal({ open, onClose, workDir }: { open: boolean; onClose: () => void; workDir?: string }) {
  // 기본 엔진은 내장 빠릿에이전트 — Atlas 키 없이 로그인된 프로바이더로 토론한다.
  const [engine, setEngine] = useState<'bbarit' | 'atlas'>('bbarit');
  const [models, setModels] = useState(ATLAS_MODELS);
  const [agentCatalog, setAgentCatalog] = useState<Array<{ id: string; name?: string; provider: string }>>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>(allSelected);
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<RoundtableMode>('opinion');
  const [rounds, setRounds] = useState(2);
  const [turns, setTurns] = useState<RoundtableTurn[]>([]);
  const [attachments, setAttachments] = useState<RoundtableAttachment[]>([]);
  const [pricing, setPricing] = useState<Record<string, AtlasPricing>>({});
  const [usages, setUsages] = useState<UsageEntry[]>([]);
  const [krwRate, setKrwRate] = useState(DEFAULT_USD_KRW);
  const [savedPath, setSavedPath] = useState('');
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [interRound, setInterRound] = useState<number | null>(null);
  const [interOpinion, setInterOpinion] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const interResolveRef = useRef<((op: string) => void) | null>(null);

  // 열릴 때마다 선택한 엔진의 모델 목록을 가져온다.
  // bbarit: 내장 에이전트의 카탈로그(로그인 프로바이더 우선) / atlas: 모델+가격+환율.
  useEffect(() => {
    if (!open) return;
    if (engine === 'bbarit') {
      fetchAgentModels()
        .then(({ models: catalog, readyProviders }) => {
          const ready = catalog.filter((m) => readyProviders.includes(m.provider));
          setAgentCatalog(ready.length ? ready : catalog);
          const defaults = pickAgentDefaults(catalog, readyProviders);
          setModels(defaults);
          setSelected(Object.fromEntries(defaults.map((m) => [m.model, true])));
          setPricing({});
        })
        .catch(() => {
          setAgentCatalog([]);
          setModels([]);
          setSelected({});
        });
      return;
    }
    fetchUsdToKrw().then(setKrwRate).catch(() => setKrwRate(DEFAULT_USD_KRW));
    fetchAtlasModels()
      .then((infos) => {
        const byId = new Map(infos.map((i) => [i.id, i.pricing]));
        const available = ATLAS_MODELS.filter((m) => byId.has(m.model));
        const next = available.length ? available : ATLAS_MODELS;
        setModels(next);
        setSelected(Object.fromEntries(next.map((m) => [m.model, true])));
        setPricing(Object.fromEntries(next.map((m) => [m.model, byId.get(m.model) ?? { prompt: 0, completion: 0 }])));
      })
      .catch(() => {
        setModels(ATLAS_MODELS);
        setSelected(allSelected());
        setPricing({});
      });
  }, [open, engine]);

  if (!open) return null;

  const candidates: RoundtableParticipant[] = models.map((m) => ({ id: m.model, model: m.model, label: m.label }));
  const participants = candidates.filter((c) => selected[c.id]);
  const canRun = !running && participants.length >= 2 && question.trim().length > 0;
  const totalCost = usages.reduce((s, u) => s + u.costUsd, 0);
  const totalTokens = usages.reduce((s, u) => s + u.promptTokens + u.completionTokens, 0);
  const won = (usd: number) => `₩${Math.round(usd * krwRate).toLocaleString('ko-KR')}`;
  const maxRound = usages.length ? Math.max(...usages.map((u) => u.round)) : -1;

  const upsertTurn = (t: RoundtableTurn) =>
    setTurns((prev) => {
      const idx = prev.findIndex((x) => x.participantId === t.participantId && x.round === t.round);
      if (idx === -1) return [...prev, t];
      const next = prev.slice();
      next[idx] = t;
      return next;
    });

  const addFiles = async (files: FileList | File[]) => {
    const read = await Promise.all(Array.from(files).map((f) => readFile(f).catch(() => null)));
    const valid = read.filter((a): a is RoundtableAttachment => !!a);
    if (valid.length) setAttachments((prev) => [...prev, ...valid]);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };

  // 라운드 사이 사용자 의견 입력: '다음 라운드'를 누를 때까지 토론을 멈춘다.
  const onRoundEnd = (round: number) =>
    new Promise<string>((resolve) => {
      setInterRound(round);
      setInterOpinion('');
      interResolveRef.current = resolve;
    });
  const continueNext = () => {
    const op = interOpinion;
    setInterRound(null);
    setInterOpinion('');
    const resolve = interResolveRef.current;
    interResolveRef.current = null;
    resolve?.(op);
  };

  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setTurns([]);
    setUsages([]);
    setSavedPath('');
    setInterRound(null);
    let finalUsages: UsageEntry[] = [];
    try {
      const all = await runRoundtable(
        {
          question,
          mode,
          participants,
          rounds,
          attachments,
          pricing,
          onTurn: upsertTurn,
          onTurnChunk: upsertTurn,
          onUsage: (u) => { finalUsages = u; setUsages(u); },
          onRoundEnd: interactive ? onRoundEnd : undefined,
        },
        engine === 'bbarit' ? createAgentStreamModel(180) : createAtlasStreamModel(180),
      );
      // 모든 결과는 중앙 문서 폴더에 저장 + 셀프임프로빙(메모리/스킬 추출)
      const path = await saveRoundtableToDocs({ question, turns: all, usages: finalUsages, krwRate });
      if (path) setSavedPath(path);
      if (workDir) void saveRoundtableToLearning({ workDir, question, turns: all });
    } finally {
      setRunning(false);
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(formatRoundtableTranscript(question, turns));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>🗣️ Model Roundtable</strong>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
            Engine
            <select value={engine} onChange={(e) => setEngine(e.target.value as 'bbarit' | 'atlas')}>
              <option value="bbarit">BBARIT Agent</option>
              <option value="atlas">Atlas Cloud</option>
            </select>
          </label>
          {candidates.map((c) => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 4, border: selected[c.id] ? '1px solid color-mix(in srgb, var(--accent-color, #6d8bff) 65%, transparent)' : '1px solid color-mix(in srgb, var(--text-color, #e5e5e5) 25%, transparent)', background: selected[c.id] ? 'color-mix(in srgb, var(--accent-color, #6d8bff) 14%, transparent)' : 'transparent', borderRadius: 'var(--brutal-radius)', padding: '3px 8px', cursor: 'pointer', opacity: selected[c.id] ? 1 : 0.7 }}>
              <input type="checkbox" checked={!!selected[c.id]} onChange={() => setSelected((s) => ({ ...s, [c.id]: !s[c.id] }))} />
              {c.label}
            </label>
          ))}
          {engine === 'bbarit' && agentCatalog.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const ref = e.target.value;
                if (!ref) return;
                const m = agentCatalog.find((x) => `${x.provider}/${x.id}` === ref);
                if (!m) return;
                setModels((prev) => prev.some((p) => p.model === ref)
                  ? prev
                  : [...prev, { model: ref, label: `${m.name || m.id} (${m.provider})` }]);
                setSelected((s) => ({ ...s, [ref]: true }));
              }}
              title="Add another signed-in model to the table"
            >
              <option value="">+ Add model…</option>
              {agentCatalog.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name || m.id} — {m.provider}
                </option>
              ))}
            </select>
          )}
        </div>

        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onPaste={onPaste}
          placeholder="Enter a question or plan topic… (paste or attach images/data)"
          style={{ width: '100%', minHeight: 56, resize: 'vertical', borderRadius: 'var(--brutal-radius)', padding: 8, fontSize: 13, background: 'color-mix(in srgb, var(--text-color, #e5e5e5) 6%, transparent)', color: 'inherit', border: '1px solid color-mix(in srgb, var(--text-color, #e5e5e5) 22%, transparent)', outline: 'none' }}
        />

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => fileInputRef.current?.click()} style={{ padding: '4px 12px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--text-color, #8a8f9a) 30%, transparent)', background: 'color-mix(in srgb, var(--text-color, #e5e5e5) 8%, transparent)', color: 'inherit' }}>📎 Attach</button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.csv,.log,.ts,.tsx,.js,.py,.rs"
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
          />
          {attachments.map((a, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid color-mix(in srgb, var(--text-color, #e5e5e5) 25%, transparent)', borderRadius: 'var(--brutal-radius)', padding: '2px 8px' }}>
              {a.kind === 'image' ? '🖼️' : '📄'} {a.name}
              <button onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>✕</button>
            </span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as RoundtableMode)}>
              <option value="opinion">Ask for opinions</option>
              <option value="plan">Ask for a plan</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            Rounds
            <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
              <option value={1}>1 round</option>
              <option value={2}>2 rounds (debate)</option>
              <option value={3}>3 rounds</option>
              <option value={4}>4 rounds</option>
              <option value={5}>5 rounds</option>
              <option value={6}>6 rounds</option>
              <option value={7}>7 rounds</option>
              <option value={8}>8 rounds</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="Pauses after each round and inserts your opinion into the next round's debate">
            <input type="checkbox" checked={interactive} onChange={() => setInteractive((v) => !v)} />
            My opinion between rounds
          </label>
          <button onClick={run} disabled={!canRun} style={{ padding: '6px 18px', borderRadius: 'var(--brutal-radius)', cursor: canRun ? 'pointer' : 'not-allowed', border: 'none', background: canRun ? 'linear-gradient(135deg, var(--accent-color, #6d8bff), color-mix(in srgb, var(--accent-color, #6d8bff) 60%, #8a6dff))' : 'color-mix(in srgb, var(--text-color, #9aa0ad) 30%, transparent)', color: '#fff', fontWeight: 700 }}>
            {running ? 'Debating…' : `🗣️ Start debate (${participants.length})`}
          </button>
          {turns.length > 0 && (
            <button onClick={copy} style={{ padding: '6px 14px', borderRadius: 'var(--brutal-radius)', cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--text-color, #8a8f9a) 30%, transparent)', background: 'color-mix(in srgb, var(--text-color, #e5e5e5) 8%, transparent)', color: 'inherit' }}>{copied ? 'Copied ✓' : 'Copy result'}</button>
          )}
          {participants.length < 2 && <span style={{ opacity: 0.6 }}>Select at least 2 models</span>}
        </div>

        {interRound !== null && (
          <div style={{ border: '2px solid color-mix(in srgb, var(--accent-color, #6d8bff) 70%, transparent)', borderRadius: 'var(--brutal-radius)', padding: 10, background: 'color-mix(in srgb, var(--accent-color, #6d8bff) 12%, transparent)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              ✋ Round {interRound + 1} finished — add an opinion to feed it into the next round's debate (leave empty to just continue)
            </div>
            <textarea
              value={interOpinion}
              onChange={(e) => setInterOpinion(e.target.value)}
              placeholder="My opinion (optional)…"
              autoFocus
              style={{ width: '100%', minHeight: 48, resize: 'vertical', borderRadius: 'var(--brutal-radius)', padding: 8, fontSize: 13, background: 'color-mix(in srgb, var(--text-color, #e5e5e5) 6%, transparent)', color: 'inherit', border: '1px solid color-mix(in srgb, var(--text-color, #e5e5e5) 22%, transparent)', outline: 'none' }}
            />
            <button onClick={continueNext} style={{ marginTop: 6, padding: '6px 16px', borderRadius: 'var(--brutal-radius)', border: 'none', background: 'linear-gradient(135deg, var(--accent-color, #6d8bff), color-mix(in srgb, var(--accent-color, #6d8bff) 60%, #8a6dff))', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              {interOpinion.trim() ? 'Add opinion and next round ▶' : 'Next round ▶'}
            </button>
          </div>
        )}

        {usages.length > 0 && totalTokens > 0 && (
          <div style={{ border: '1px solid color-mix(in srgb, var(--text-color, #8a8f9a) 30%, transparent)', borderRadius: 'var(--brutal-radius)', padding: 8, fontSize: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              💰 Total {totalTokens.toLocaleString()} tokens · {won(totalCost)}
              <span style={{ opacity: 0.6, fontWeight: 400 }}> (≈ ${totalCost.toFixed(4)} · 1$=₩{Math.round(krwRate).toLocaleString('ko-KR')})</span>
            </div>
            {Array.from({ length: maxRound + 1 }, (_, r) => {
              const rs = usages.filter((u) => u.round === r);
              if (!rs.length) return null;
              const rCost = rs.reduce((s, u) => s + u.costUsd, 0);
              const rTok = rs.reduce((s, u) => s + u.promptTokens + u.completionTokens, 0);
              return (
                <div key={r} style={{ marginTop: 6 }}>
                  <div style={{ fontWeight: 600, opacity: 0.95 }}>
                    Round {r + 1} — {rTok.toLocaleString()} tokens · {won(rCost)}
                  </div>
                  {rs.map((u) => (
                    <div key={u.participantId} style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.8, paddingLeft: 10 }}>
                      <span>{u.label}</span>
                      <span>In {u.promptTokens.toLocaleString()} · Out {u.completionTokens.toLocaleString()} · {won(u.costUsd)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {savedPath && <div style={{ fontSize: 12, opacity: 0.7 }}>💾 Saved: {savedPath}</div>}

        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
          {turns.map((t) => (
            <div key={`${t.participantId}#${t.round}`} style={{ border: '1px solid color-mix(in srgb, var(--text-color, #e5e5e5) 18%, transparent)', background: 'color-mix(in srgb, var(--text-color, #e5e5e5) 4%, transparent)', borderRadius: 'var(--brutal-radius)', padding: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, opacity: 0.8 }}>R{t.round + 1} · {t.label}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{t.content || '…'}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
