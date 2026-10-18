import { describe, expect, it, vi } from 'vitest';
import {
  buildDebatePrompt,
  buildOpeningPrompt,
  formatAttachmentContext,
  formatRoundtableTranscript,
  formatUsageSummary,
  runRoundtable,
  type StreamModel,
} from './modelRoundtable';

describe('buildOpeningPrompt', () => {
  it('asks for an opinion concisely', () => {
    const p = buildOpeningPrompt('탭 UI 설계', 'opinion');
    expect(p).toContain('의견');
    expect(p).toContain('탭 UI 설계');
    expect(p).toContain('6줄 이내');
  });
  it('asks for a plan in plan mode', () => {
    expect(buildOpeningPrompt('배포', 'plan')).toContain('플랜');
  });
  it('forbids markdown so plain-text rendering stays clean', () => {
    expect(buildOpeningPrompt('주제', 'opinion')).toContain('마크다운');
  });
});

describe('buildDebatePrompt', () => {
  it('includes other participants opinions and asks to agree/disagree', () => {
    const p = buildDebatePrompt('주제', [{ label: 'A', content: 'A의견' }, { label: 'B', content: 'B의견' }], 'opinion');
    expect(p).toContain('동의/반대/보완');
    expect(p).toContain('### A');
    expect(p).toContain('A의견');
    expect(p).toContain('### B');
  });
  it('handles no prior opinions', () => {
    expect(buildDebatePrompt('주제', [{ label: 'A', content: '' }], 'opinion')).toContain('아직 다른 의견 없음');
  });
});

describe('runRoundtable', () => {
  it('streams accumulated chunks and feeds prior opinions into the debate round', async () => {
    const prompts: string[] = [];
    const streamModel: StreamModel = async ({ prompt, onChunk }) => {
      prompts.push(prompt);
      onChunk('부분');
      onChunk('답');
      return { text: '부분답', promptTokens: 10, completionTokens: 5 };
    };
    const chunks: string[] = [];
    const turns = await runRoundtable(
      {
        question: '주제',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 2,
        onTurnChunk: (t) => chunks.push(t.content),
      },
      streamModel,
    );
    expect(chunks).toContain('부분');
    expect(chunks).toContain('부분답');
    expect(turns).toHaveLength(4);
    expect(prompts[0]).toContain('의견');
    const debatePrompts = prompts.slice(2);
    expect(debatePrompts.some((p) => p.includes('동의/반대/보완'))).toBe(true);
    expect(debatePrompts.some((p) => p.includes('부분답'))).toBe(true);
  });

  it('keeps the debate going when one model errors', async () => {
    const streamModel: StreamModel = vi
      .fn<StreamModel>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ text: '정상', promptTokens: 1, completionTokens: 1 });
    const turns = await runRoundtable(
      {
        question: '주제',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 1,
      },
      streamModel,
    );
    expect(turns).toHaveLength(2);
    expect(turns.some((t) => t.content.includes('오류'))).toBe(true);
    expect(turns.some((t) => t.content === '정상')).toBe(true);
  });

  it('passes images through to the stream function', async () => {
    let receivedImages: string[] = [];
    const streamModel: StreamModel = async ({ images }) => {
      receivedImages = images;
      return { text: 'ok', promptTokens: 0, completionTokens: 0 };
    };
    await runRoundtable(
      {
        question: '이 이미지 분석',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 1,
        attachments: [{ kind: 'image', name: 'x.png', value: 'data:image/png;base64,AAA' }],
      },
      streamModel,
    );
    expect(receivedImages).toEqual(['data:image/png;base64,AAA']);
  });

  it('emits per-round usage entries with cost computed from pricing', async () => {
    const streamModel: StreamModel = async () => ({ text: 'x', promptTokens: 100, completionTokens: 50 });
    let last: Array<{ model: string; round: number; promptTokens: number; completionTokens: number; costUsd: number }> = [];
    await runRoundtable(
      {
        question: '주제',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 2,
        // a: 입력 $0.00001/토큰, 출력 $0.00002/토큰
        pricing: { a: { prompt: 0.00001, completion: 0.00002 } },
        onUsage: (u) => { last = u; },
      },
      streamModel,
    );
    // 참가자 2 × 라운드 2 = 4개 엔트리 (라운드별로 분리)
    expect(last).toHaveLength(4);
    const aRound0 = last.find((u) => u.model === 'a' && u.round === 0)!;
    expect(aRound0.promptTokens).toBe(100);
    expect(aRound0.completionTokens).toBe(50);
    // 한 라운드 비용 = 100*0.00001 + 50*0.00002 = 0.001 + 0.001 = 0.002
    expect(aRound0.costUsd).toBeCloseTo(0.002, 6);
    expect(last.filter((u) => u.model === 'a')).toHaveLength(2); // 라운드 0,1
    // 가격 미정 모델은 비용 0
    expect(last.find((u) => u.model === 'b')!.costUsd).toBe(0);
  });

  it('injects the user opinion from onRoundEnd into the next round and records it as a turn', async () => {
    const prompts: string[] = [];
    const streamModel: StreamModel = async ({ prompt }) => {
      prompts.push(prompt);
      return { text: 'ok', promptTokens: 1, completionTokens: 1 };
    };
    const turns = await runRoundtable(
      {
        question: '주제',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 2,
        onRoundEnd: async (round) => (round === 0 ? '나는 B에 동의' : null),
      },
      streamModel,
    );
    const debatePrompts = prompts.slice(2); // round 1 프롬프트들
    expect(debatePrompts.some((p) => p.includes('사용자(나)'))).toBe(true);
    expect(debatePrompts.some((p) => p.includes('나는 B에 동의'))).toBe(true);
    expect(turns.some((t) => t.participantId === 'user' && t.content === '나는 B에 동의')).toBe(true);
  });

  it('does not pause after the final round', async () => {
    const calls: number[] = [];
    const streamModel: StreamModel = async () => ({ text: 'ok', promptTokens: 0, completionTokens: 0 });
    await runRoundtable(
      {
        question: 'q',
        mode: 'opinion',
        participants: [
          { id: 'a', model: 'a', label: 'A' },
          { id: 'b', model: 'b', label: 'B' },
        ],
        rounds: 2,
        onRoundEnd: async (round) => { calls.push(round); return null; },
      },
      streamModel,
    );
    expect(calls).toEqual([0]); // 라운드 0 뒤에만, 마지막(1) 뒤엔 안 함
  });
});

describe('formatUsageSummary', () => {
  it('breaks usage down per round and shows cost in KRW', () => {
    const md = formatUsageSummary(
      [
        { participantId: 'a', label: 'Claude', model: 'a', round: 0, promptTokens: 100, completionTokens: 50, costUsd: 0.004 },
        { participantId: 'b', label: 'GPT', model: 'b', round: 0, promptTokens: 200, completionTokens: 80, costUsd: 0.01 },
        { participantId: 'a', label: 'Claude', model: 'a', round: 1, promptTokens: 120, completionTokens: 60, costUsd: 0.005 },
      ],
      1380,
    );
    expect(md).toContain('토큰 사용량 / 비용');
    expect(md).toContain('Round 1');
    expect(md).toContain('Round 2');
    expect(md).toContain('Claude');
    // 0.004 USD × 1380 = 5.52 → ₩6 (반올림)
    expect(md).toContain('₩6');
    expect(md).toContain('환율');
    expect(md).toContain('총 합계');
  });
});

describe('formatAttachmentContext', () => {
  it('appends only data attachments as a reference block', () => {
    const block = formatAttachmentContext([
      { kind: 'data', name: 'log.txt', value: '에러 로그' },
      { kind: 'image', name: 'shot.png', value: 'data:image/png;base64,xxx' },
      { kind: 'data', name: 'blank.txt', value: '   ' },
    ]);
    expect(block).toContain('## 참고 자료');
    expect(block).toContain('### log.txt');
    expect(block).toContain('에러 로그');
    expect(block).not.toContain('shot.png');
    expect(block).not.toContain('blank.txt');
  });
  it('returns empty when there is no data attachment', () => {
    expect(formatAttachmentContext([{ kind: 'image', name: 'a.png', value: 'data:...' }])).toBe('');
  });
});

describe('formatRoundtableTranscript', () => {
  it('renders rounds and participants as markdown', () => {
    const md = formatRoundtableTranscript('주제', [
      { participantId: '1', label: 'Claude', round: 0, content: '의견1' },
      { participantId: '2', label: 'GPT', round: 0, content: '의견2' },
      { participantId: '1', label: 'Claude', round: 1, content: '반박1' },
      { participantId: '2', label: 'GPT', round: 1, content: '반박2' },
    ]);
    expect(md).toContain('# 토론: 주제');
    expect(md).toContain('## Round 1');
    expect(md).toContain('## Round 2');
    expect(md).toContain('### Claude');
    expect(md).toContain('반박2');
  });
});
