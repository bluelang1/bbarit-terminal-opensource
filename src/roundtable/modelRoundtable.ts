import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getAtlasCloudConfig } from '../harness/atlasCloudRuntime';
import { recordSessionEntry } from '../harness/learningSessionStore';
import { spawnBackgroundLearningReview } from '../harness/learningRuntime';
import { genId } from '../components/harness-utils';
import type { CliProvider } from '../harness/cliRuntime';

// 멀티 모델 토론(roundtable). Atlas Cloud의 대표 모델들을 다수 선택해 같은 질문/플랜을
// 묻고, 다음 라운드에서 서로의 의견을 보고 토론한다. 하네스 코드와 독립이라 동시 편집과
// 충돌하지 않는다.

export type RoundtableMode = 'opinion' | 'plan';

export interface RoundtableParticipant {
  id: string;
  model: string;
  label: string;
}

// 의견/플랜을 물을 때 함께 붙이는 첨부물. image는 data URL, data는 텍스트.
export interface RoundtableAttachment {
  kind: 'image' | 'data';
  name: string;
  value: string;
}

export interface RoundtableTurn {
  participantId: string;
  label: string;
  round: number;
  content: string;
}

const MODE_INTRO: Record<RoundtableMode, string> = {
  opinion: '아래 주제에 대한 당신의 의견을 핵심만 간결하게 제시하세요.',
  plan: '아래 작업에 대한 실행 플랜을 단계별로 간결하게 제시하세요.',
};

// 모달은 답변을 일반 텍스트로 보여주므로 마크다운 기호가 그대로 노출된다. 쓰지 않게 지시한다.
const PLAIN_TEXT_RULE = '굵게(**)·머리글(#)·코드블록(```) 같은 마크다운 기호를 쓰지 말고 일반 텍스트로만 답하세요.';

export function buildOpeningPrompt(question: string, mode: RoundtableMode): string {
  return [MODE_INTRO[mode], '', `주제: ${question}`, '', '6줄 이내로 답하세요.', PLAIN_TEXT_RULE].join('\n');
}

export function buildDebatePrompt(
  question: string,
  others: Array<{ label: string; content: string }>,
  mode: RoundtableMode,
): string {
  const opinions = others
    .filter((o) => o.content.trim())
    .map((o) => `### ${o.label}\n${o.content.trim()}`)
    .join('\n\n');
  return [
    `다른 참가자들의 ${mode === 'plan' ? '플랜' : '의견'}을 읽고, 동의/반대/보완을 분명히 밝히며 토론하세요.`,
    '의견이 같으면 같다고, 다르면 근거를 들어 반박하세요. 6줄 이내.',
    PLAIN_TEXT_RULE,
    '',
    `주제: ${question}`,
    '',
    opinions || '(아직 다른 의견 없음)',
  ].join('\n');
}

// 데이터(텍스트) 첨부는 프롬프트 끝에 참고 자료로 붙인다. 모든 모델이 그대로 읽는다.
export function formatAttachmentContext(attachments: RoundtableAttachment[]): string {
  const data = attachments.filter((a) => a.kind === 'data' && a.value.trim());
  if (!data.length) return '';
  return ['## 참고 자료', ...data.map((d) => `### ${d.name}\n${d.value.trim()}`)].join('\n');
}

// 한 모델 호출 결과 — 답변 텍스트 + 정확한 토큰 사용량(usage). 전송 계층이 채운다.
export interface StreamResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

// 한 모델에 프롬프트(+이미지)를 보내고 누적 텍스트/사용량을 받는 전송 함수. UI가 주입한다.
export type StreamModel = (args: {
  model: string;
  prompt: string;
  images: string[];
  onChunk: (text: string) => void;
}) => Promise<StreamResult>;

export interface AtlasPricing {
  prompt: number; // USD per token (입력)
  completion: number; // USD per token (출력)
}

export interface AtlasModelInfo {
  id: string;
  pricing: AtlasPricing;
}

// 참가자 × 라운드 단위 사용량/비용. 라운드별·모델별로 쪼개서 집계할 수 있다.
export interface UsageEntry {
  participantId: string;
  label: string;
  model: string;
  round: number; // 0-based
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export const DEFAULT_USD_KRW = 1380; // 환율 조회 실패 시 근사값

// 실시간 USD→KRW 환율(무료 API). Rust http_request 프록시로 CORS 우회. 실패 시 근사값.
export async function fetchUsdToKrw(): Promise<number> {
  try {
    const res = await invoke<{ status: number; body: string }>('http_request', {
      input: { method: 'GET', url: 'https://open.er-api.com/v6/latest/USD', timeout_ms: 8000 },
    });
    if (res.status >= 200 && res.status < 300) {
      const krw = JSON.parse(res.body)?.rates?.KRW;
      if (typeof krw === 'number' && krw > 0) return krw;
    }
  } catch {
    // 네트워크/파싱 실패 시 근사값 사용.
  }
  return DEFAULT_USD_KRW;
}

// ── BBARIT Agent 엔진 ────────────────────────────────────────────────────
// 내장 빠릿에이전트로 토론을 돌린다: 참가자마다 `agent_oneshot`(프린트 모드,
// 도구/세션 없음) 한 번씩. Atlas 키 없이 로그인된 프로바이더(anthropic 등)의
// 모델을 그대로 쓴다. 스트리밍은 없고 응답이 한 번에 도착한다.

export interface AgentEngineModelInfo {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
}

export async function fetchAgentModels(): Promise<{ models: AgentEngineModelInfo[]; readyProviders: string[] }> {
  const data = await invoke<{ models?: AgentEngineModelInfo[]; readyProviders?: string[] }>('agent_models_list');
  return { models: data?.models ?? [], readyProviders: data?.readyProviders ?? [] };
}

export function createAgentStreamModel(timeoutSecs = 180): StreamModel {
  return async ({ model, prompt, onChunk }) => {
    const text = await invoke<string>('agent_oneshot', { model, prompt, timeoutSecs });
    if (text) onChunk(text);
    // 원샷 모드는 토큰 사용량을 노출하지 않는다 — 비용 집계는 0으로 둔다.
    return { text: text.trim(), promptTokens: 0, completionTokens: 0 };
  };
}

// Atlas /models에서 모델 id와 토큰당 가격을 함께 가져온다(가격은 응답의 pricing 필드 기준).
export async function fetchAtlasModels(): Promise<AtlasModelInfo[]> {
  const config = await getAtlasCloudConfig();
  if (!config.apiKey) return [];
  const res = await invoke<{ status: number; body: string }>('http_request', {
    input: {
      method: 'GET',
      url: `${config.baseUrl}/models`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout_ms: 15000,
    },
  });
  if (res.status < 200 || res.status >= 300) return [];
  const json = JSON.parse(res.body) as { data?: unknown[]; models?: unknown[] };
  const data = (json.data ?? json.models ?? []) as Array<{
    id?: string;
    pricing?: { prompt?: string; completion?: string };
  }>;
  return data
    .filter((m): m is { id: string; pricing?: { prompt?: string; completion?: string } } => !!m.id)
    .map((m) => ({
      id: m.id,
      pricing: { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) },
    }));
}

// 실제 Atlas 스트리밍 전송 함수. 토큰 usage까지 파싱한다(stream_options.include_usage).
// 공유 normalize가 멀티모달 content를 문자열화하므로 인증/주소만 재사용하고 요청은 로컬에서 만든다.
export function createAtlasStreamModel(timeoutSecs = 180): StreamModel {
  return ({ model, prompt, images, onChunk }) =>
    new Promise<StreamResult>((resolve, reject) => {
      void (async () => {
        const config = await getAtlasCloudConfig();
        if (!config.apiKey) {
          reject(new Error('Atlas Cloud API key 미설정'));
          return;
        }
        const content = images.length
          ? [{ type: 'text', text: prompt }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          : prompt;
        const body = JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 4096,
        });
        const streamId = genId();
        let text = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let unlisten: (() => void) | null = null;
        listen<{ type: string; data?: string; error?: string }>(`ai-stream-${streamId}`, (event) => {
          const p = event.payload;
          if (p.type === 'chunk' && p.data) {
            for (const line of p.data.split('\n')) {
              const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
              if (!s || s === '[DONE]') continue;
              try {
                const obj = JSON.parse(s);
                const c = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content;
                if (c) {
                  text += String(c);
                  onChunk(String(c));
                }
                if (obj.usage) {
                  promptTokens = obj.usage.prompt_tokens ?? promptTokens;
                  completionTokens = obj.usage.completion_tokens ?? completionTokens;
                }
              } catch {
                // 부분 청크는 다음 청크와 합쳐져 도착.
              }
            }
          } else if (p.type === 'done') {
            unlisten?.();
            resolve({ text: text.trim(), promptTokens, completionTokens });
          } else if (p.type === 'error') {
            unlisten?.();
            reject(new Error(p.error || 'Atlas Cloud stream error'));
          }
        })
          .then((fn) => {
            unlisten = fn;
            invoke('http_stream_request', {
              streamId,
              input: {
                method: 'POST',
                url: `${config.baseUrl}/chat/completions`,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                body,
                timeout_ms: Math.max(5000, Math.min(timeoutSecs * 1000, 600000)),
              },
            }).catch((error) => {
              unlisten?.();
              reject(error);
            });
          })
          .catch(reject);
      })().catch(reject);
    });
}

// 라운드별로 모든 참가자를 병렬 호출. 한 참가자가 실패해도 토론은 계속된다. 전송은 streamModel 주입.
// onTurnChunk는 토큰이 도착할 때마다 누적 내용으로, onUsage는 라운드마다 누적 사용량/비용으로 호출된다.
export async function runRoundtable(
  params: {
    question: string;
    mode: RoundtableMode;
    participants: RoundtableParticipant[];
    rounds: number;
    attachments?: RoundtableAttachment[];
    pricing?: Record<string, AtlasPricing>;
    onTurn?: (turn: RoundtableTurn) => void;
    onTurnChunk?: (turn: RoundtableTurn) => void;
    onUsage?: (usages: UsageEntry[]) => void;
    // 라운드가 끝날 때마다(마지막 제외) 호출. 사용자가 의견을 반환하면 다음 라운드 토론에 끼어든다.
    onRoundEnd?: (round: number, turns: RoundtableTurn[]) => Promise<string | null | void>;
  },
  streamModel: StreamModel,
): Promise<RoundtableTurn[]> {
  const rounds = Math.max(1, Math.min(params.rounds, 8));
  const turns: RoundtableTurn[] = [];
  const latest = new Map<string, string>();
  const attachments = params.attachments ?? [];
  const dataBlock = formatAttachmentContext(attachments);
  const images = attachments.filter((a) => a.kind === 'image' && a.value).map((a) => a.value);
  const pricing = params.pricing ?? {};
  const entries: UsageEntry[] = []; // 참가자 × 라운드 단위로 쌓는다
  let userOpinion = ''; // 라운드 사이 사용자가 끼워넣은 의견(최신)

  for (let round = 0; round < rounds; round += 1) {
    const prompts = params.participants.map((p) => {
      if (round === 0) {
        const opening = buildOpeningPrompt(params.question, params.mode);
        return dataBlock ? `${opening}\n\n${dataBlock}` : opening;
      }
      const others = params.participants
        .filter((o) => o.id !== p.id)
        .map((o) => ({ label: o.label, content: latest.get(o.id) || '' }));
      if (userOpinion.trim()) others.push({ label: '사용자(나)', content: userOpinion });
      const debate = buildDebatePrompt(params.question, others, params.mode);
      return dataBlock ? `${debate}\n\n${dataBlock}` : debate;
    });
    const results = await Promise.all(
      params.participants.map((p, i) => {
        let acc = '';
        return streamModel({
          model: p.model,
          prompt: prompts[i],
          images,
          onChunk: (text) => {
            acc += text;
            params.onTurnChunk?.({ participantId: p.id, label: p.label, round, content: acc });
          },
        }).catch(
          (error: unknown): StreamResult => ({
            text: `(오류: ${error instanceof Error ? error.message : String(error)})`,
            promptTokens: 0,
            completionTokens: 0,
          }),
        );
      }),
    );
    params.participants.forEach((p, i) => {
      const r = results[i];
      const turn: RoundtableTurn = { participantId: p.id, label: p.label, round, content: r.text };
      turns.push(turn);
      latest.set(p.id, r.text);
      const price = pricing[p.model] ?? { prompt: 0, completion: 0 };
      entries.push({
        participantId: p.id,
        label: p.label,
        model: p.model,
        round,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        costUsd: r.promptTokens * price.prompt + r.completionTokens * price.completion,
      });
      params.onTurn?.(turn);
    });
    params.onUsage?.(entries.slice());

    // 라운드 사이 사용자 의견(옵션). 마지막 라운드 뒤엔 묻지 않는다.
    if (params.onRoundEnd && round < rounds - 1) {
      const op = (await params.onRoundEnd(round, turns.slice())) || '';
      if (op.trim()) {
        userOpinion = op.trim();
        const userTurn: RoundtableTurn = { participantId: 'user', label: '사용자(나)', round, content: userOpinion };
        turns.push(userTurn);
        params.onTurn?.(userTurn);
      }
    }
  }
  return turns;
}

// 토론 결과를 하네스 셀프임프로빙 엔진으로 가져온다(import만, 하네스 코드 수정 X).
// 세션으로 저장 + 백그라운드 리뷰로 메모리/스킬 추출.
export async function saveRoundtableToLearning(params: {
  workDir: string;
  question: string;
  turns: RoundtableTurn[];
  reviewProvider?: CliProvider;
}): Promise<void> {
  if (!params.workDir || !params.turns.length) return;
  const transcript = formatRoundtableTranscript(params.question, params.turns);
  const id = `rt-${Date.now().toString(36)}`;
  const title = `토론: ${params.question.slice(0, 60)}`;
  await recordSessionEntry(params.workDir, {
    id,
    threadId: id,
    title,
    workDir: params.workDir,
    mode: 'roundtable',
    provider: 'multi',
    userMessage: params.question,
    assistantSummary: transcript.slice(0, 2400),
    toolNames: [],
    savedFiles: [],
    artifactNames: [],
    createdAt: Date.now(),
  }).catch(() => {});
  spawnBackgroundLearningReview({
    provider: params.reviewProvider || 'atlascloud',
    workDir: params.workDir,
    threadTitle: title,
    userMessage: params.question,
    assistantContent: transcript,
    threadMessages: [
      { role: 'human', content: params.question },
      { role: 'assistant', content: transcript },
    ],
    timeoutSecs: 180,
  });
}

// 복사용 마크다운 트랜스크립트.
export function formatRoundtableTranscript(question: string, turns: RoundtableTurn[]): string {
  const rounds = Math.max(0, ...turns.map((t) => t.round)) + 1;
  const lines = [`# 토론: ${question}`, ''];
  for (let round = 0; round < rounds; round += 1) {
    lines.push(`## Round ${round + 1}`);
    for (const turn of turns.filter((t) => t.round === round)) {
      lines.push(`### ${turn.label}`, turn.content.trim(), '');
    }
  }
  return lines.join('\n').trim();
}

// 토큰 사용량/비용 요약(마크다운). 라운드별로 모델 행 + 라운드 합계, 비용은 한화(KRW).
export function formatUsageSummary(entries: UsageEntry[], krwRate: number): string {
  const won = (usd: number) => `₩${Math.round(usd * krwRate).toLocaleString('ko-KR')}`;
  const rounds = Math.max(0, ...entries.map((e) => e.round)) + 1;
  const lines = ['## 토큰 사용량 / 비용', '', `환율 1 USD = ${Math.round(krwRate).toLocaleString('ko-KR')}원`, ''];
  let gIn = 0;
  let gOut = 0;
  let gCost = 0;
  for (let r = 0; r < rounds; r += 1) {
    const rs = entries.filter((e) => e.round === r);
    if (!rs.length) continue;
    let rIn = 0;
    let rOut = 0;
    let rCost = 0;
    lines.push(`### Round ${r + 1}`, '', '| 모델 | 입력 | 출력 | 비용 |', '| --- | ---: | ---: | ---: |');
    for (const e of rs) {
      rIn += e.promptTokens;
      rOut += e.completionTokens;
      rCost += e.costUsd;
      lines.push(`| ${e.label} | ${e.promptTokens.toLocaleString()} | ${e.completionTokens.toLocaleString()} | ${won(e.costUsd)} |`);
    }
    lines.push(`| **R${r + 1} 합계** | **${rIn.toLocaleString()}** | **${rOut.toLocaleString()}** | **${won(rCost)}** |`, '');
    gIn += rIn;
    gOut += rOut;
    gCost += rCost;
  }
  lines.push(`**총 합계: ${(gIn + gOut).toLocaleString()} 토큰 · ${won(gCost)}** (≈ $${gCost.toFixed(4)})`);
  return lines.join('\n');
}

// 모든 토론 결과를 중앙 문서 폴더(~/Documents/BBARIT/roundtable)에 마크다운으로 저장. 경로 반환.
export async function saveRoundtableToDocs(params: {
  question: string;
  turns: RoundtableTurn[];
  usages?: UsageEntry[];
  krwRate?: number;
}): Promise<string | null> {
  if (!params.turns.length) return null;
  try {
    const homeDir = await invoke<string>('get_home_dir');
    const folder = `${homeDir}/Documents/BBARIT/roundtable`;
    await invoke('create_directory', { path: folder });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const slug = params.question.slice(0, 30).replace(/[\\/:*?"<>|\n\r]+/g, '_').trim();
    const path = `${folder}/${stamp}_${slug || 'debate'}.md`;
    const transcript = formatRoundtableTranscript(params.question, params.turns);
    const usageBlock = params.usages?.length ? `\n\n${formatUsageSummary(params.usages, params.krwRate ?? DEFAULT_USD_KRW)}` : '';
    await invoke('write_file', { path, content: `${transcript}${usageBlock}\n` });
    return path;
  } catch {
    return null;
  }
}
