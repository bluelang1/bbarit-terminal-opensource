/**
 * AgentHarnessPanel.tsx
 *
 * AgentHarnessPanel.tsx — chat-based agent UI with streaming,
 * mode selection, tool visualization, threads, long-term memory, artifacts,
 * TODO tracking, and follow-up suggestions.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Send, Square, Plus, Trash2, X, MessageSquare, ChevronLeft, ChevronRight,
  Brain, Sparkles, Crown, FileCode, Globe, Terminal as TerminalIcon,
  Search, Copy, Check, BookOpen,
  CheckCircle2, Circle, Loader2, Pin, PinOff, Download, Eye,
  ChevronUp, ChevronDown, Settings2, RotateCcw
} from 'lucide-react';
import mcpOctoServerSource from '../../scripts/mcp-octo-server.mjs?raw';
import { useTranslation } from '../i18n';
import type { CliProvider } from '../harness/cliRuntime';
import { createHarnessLearningRuntime } from '../harness/runtimeFactoryLearning';
import { createHarnessRuntime } from '../harness/runtimeFactory';
import { formatHarnessDoctorReport, runHarnessDoctor } from '../harness/harnessDoctor';
import {
  type LearnedSkillEntry,
} from '../harness/learningRuntime';
import { mergeRuntimeSkills } from '../harness/learningSkillManager';
import {
  type AgentMode,
  type AiProvider,
  type Artifact,
  type Attachment,
  type ChatMessage,
  type ChatThread,
  type MemoryEntry,
  type PendingWorkflowStart,
  type SkillInfo,
  type SubTask,
} from '../harness/panelTypes';
import { useHarnessPersistence } from '../harness/useHarnessPersistence';
import { useHarnessThreadActions } from '../harness/useHarnessThreadActions';
import { useHarnessTurnController } from '../harness/useHarnessTurnController';
import { useHarnessWorkflowActions } from '../harness/useHarnessWorkflowActions';
import { useAgentHarnessAttachments } from './useAgentHarnessAttachments';
import { useAgentHarnessMemory } from './useAgentHarnessMemory';
import { useAgentHarnessPanelEffects } from './useAgentHarnessPanelEffects';
import type { PendingPlanReview, PendingSpecReview } from '../harness/workflowExecutor';
import {
  type WorkflowConfig,
  type WorkflowEffort,
  type WorkflowStage,
} from '../harness/workflow';
import {
  ATLASCLOUD_DEFAULT_BASE_URL,
  ATLASCLOUD_DEFAULT_MODEL,
  ATLASCLOUD_KV_KEYS,
  ATLASCLOUD_PROVIDER,
  normalizeAtlasCloudModelPreference,
  runAtlasCloudCodingSmokeTest,
} from '../harness/atlasCloudRuntime';
import {
  OLLAMA_PROVIDER,
  OLLAMA_DEFAULT_URL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_URL_KV_KEY,
  OLLAMA_MODEL_KV_KEY,
  listOllamaModels,
} from '../harness/ollamaRuntime';
import { HARNESS_PROVIDER_OPTIONS } from '../harness/modelProviders';
import { formatTokenUsage } from '../harness/tokenUsage';
import type { HarnessResponseLanguage } from '../harness/prompting';
import { listHarnessBackendJobs, type HarnessBackendJob } from '../harness/backendJobs';
import { clearHarnessProjectState, persistHarnessProjectState } from '../harness/projectStateFiles';
import {
  renderMarkdown,
} from './harness-utils';
import { HARNESS_TOOL_REGISTRY, searchHarnessTools, type HarnessToolDefinition } from '../harness/toolRegistry';
import './AgentHarnessPanel.css';

interface AgentHarnessPanelProps {
  onClose: () => void;
  style: { bg: string; text: string; accent: string };
  workDir: string;
  isVisible?: boolean;
  projectName?: string;
  skills?: SkillInfo[];
  projectTargets?: HarnessProjectTarget[];
  activeProjectId?: string;
  onSelectProject?: (projectId: string, target?: HarnessProjectTarget) => void | string | Promise<void | string>;
  storageScopeKey?: string;
  onSendToConsole?: (cmd: string, projectId?: string) => void | Promise<void>;
}

interface HarnessProjectTarget {
  id: string;
  displayName: string;
  name: string;
  workDir: string;
  icon: string;
  source?: 'open' | 'suggested';
  reason?: string;
}

// ── KV helpers ──

async function kvGet(key: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('kv_get', { key });
    if (value != null) {
      try { localStorage.setItem(key, value); } catch { /* ignore storage fallback failures */ }
      return value;
    }
  } catch {
    /* fall back to webview localStorage below */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
async function kvSet(key: string, value: string): Promise<void> {
  try { localStorage.setItem(key, value); } catch { /* ignore storage fallback failures */ }
  await invoke('kv_set', { key, value }).catch(() => {});
}
async function harnessDbGet(key: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('harness_db_get', { key });
    if (value != null) return value;
  } catch {
    /* fall back to legacy KV for migration */
  }
  const legacy = await kvGet(key);
  if (legacy != null) {
    void invoke('harness_db_set', { key, value: legacy }).catch(() => {});
  }
  return legacy;
}
async function harnessDbSet(key: string, value: string): Promise<void> {
  try { localStorage.setItem(key, value); } catch { /* ignore storage fallback failures */ }
  try {
    await invoke('harness_db_set', { key, value });
    return;
  } catch {
    /* fall through to legacy KV fallback */
  }
  await kvSet(key, value);
}

// ── Constants ──

const STORAGE_KEY_PREFIX = 'bbarit-coding-secretary';
const LANGUAGE_STORAGE_KEY = 'octo-agent-harness-response-language';
const SHELL_PERMISSION_STORAGE_KEY = 'octo-agent-harness-shell-permission';
const KORINI_BASE_FOLDER_STORAGE_KEY = 'bbarit-korini-base-folder';
const KORINI_AUTO_OPEN_ON_START = false;
const KORINI_SETTINGS_STORAGE_PREFIX = 'bbarit-korini-settings';
const PROVIDER_OPTIONS: { id: AiProvider; label: string }[] = HARNESS_PROVIDER_OPTIONS;

function getParentDir(path: string): string {
  const cleaned = path.trim().replace(/\/+$/, '');
  if (!cleaned || cleaned === '/') return cleaned || '/';
  const slash = cleaned.lastIndexOf('/');
  return slash <= 0 ? '/' : cleaned.slice(0, slash);
}

function sanitizeProjectFolderName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/[^0-9A-Za-z가-힣._-]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasProjectNameText(value: string): boolean {
  return /[0-9A-Za-z가-힣]/.test(value);
}

function inferProjectNameFromPrompt(prompt: string): string {
  const text = prompt.trim();
  const koreanMatch = text.match(/[0-9A-Za-z가-힣]{2,}/);
  const seed = koreanMatch?.[0] || '새앱';
  return sanitizeProjectFolderName(`${seed}-app`) || `korini-app-${Date.now().toString(36)}`;
}

async function getDefaultKoriniBaseFolder(): Promise<string> {
  try {
    const home = await invoke<string>('get_home_dir');
    if (home?.trim()) return `${home.trim().replace(/\/+$/, '')}/Documents/BBARIT Projects`;
  } catch {
    /* fall back below */
  }
  return 'BBARIT Projects';
}

const ATLAS_AGENT_MODEL_OPTIONS = [
  { value: 'deepseek-ai/deepseek-v4-flash', label: 'Recommended default · DeepSeek V4 Flash' },
  { value: 'qwen/qwen3-coder-next', label: 'Latest Qwen coder · Qwen3 Coder Next' },
  { value: 'moonshotai/kimi-k2.6', label: 'Kimi mode · Kimi K2.6' },
] as const;

type AtlasCodingTestState = {
  status: 'idle' | 'running' | 'passed' | 'failed';
  message: string;
  preview: string;
};

type HarnessMcpConnectState = {
  status: 'idle' | 'checking' | 'ready' | 'failed';
  message: string;
  detail: string;
  projectConfigPath?: string;
};

type HarnessProjectContextState = {
  status: 'checking' | 'ready' | 'empty' | 'failed';
  count: number;
  detail: string;
};

type GitCareState = {
  status: 'idle' | 'checking' | 'ready' | 'needs-setup' | 'fixed' | 'failed';
  message: string;
  detail: string;
};

interface AtlasModelOption {
  value: string;
  label: string;
}

type KoriniCloudProvider = 'vercel' | 'aws' | 'google-cloud' | 'oracle-cloud' | 'netlify';
type KoriniDbProvider = 'neon' | 'supabase-postgres' | 'vercel-postgres' | 'planetscale' | 'turso';
type KoriniLoginProvider = 'supabase-kakao' | 'supabase-naver' | 'supabase-google' | 'supabase-email' | 'clerk';
type KoriniPaymentProvider = 'toss-payments' | 'portone' | 'naver-pay' | 'kakao-pay' | 'stripe';
type KoriniFileProvider = 'vercel-blob' | 's3' | 'cloudflare-r2' | 'supabase-storage' | 'google-cloud-storage';
type KoriniAiProvider = 'atlas-deepseek4' | 'qwen-code' | 'kimi' | 'vercel-ai-sdk' | 'openai-compatible';

interface KoriniSettings {
  model: string;
  cloud: KoriniCloudProvider;
  db: KoriniDbProvider;
  login: KoriniLoginProvider;
  payment: KoriniPaymentProvider;
  file: KoriniFileProvider;
  ai: KoriniAiProvider;
}

const DEFAULT_KORINI_SETTINGS: KoriniSettings = {
  model: ATLASCLOUD_DEFAULT_MODEL,
  cloud: 'vercel',
  db: 'neon',
  login: 'supabase-kakao',
  payment: 'toss-payments',
  file: 'vercel-blob',
  ai: 'atlas-deepseek4',
};

const KORINI_SETTING_OPTIONS = {
  cloud: [
    { value: 'vercel', label: 'Vercel · Easiest default' },
    { value: 'aws', label: 'AWS · For large services' },
    { value: 'google-cloud', label: 'Google Cloud · Google ecosystem' },
    { value: 'oracle-cloud', label: 'Oracle Cloud · DB/server option' },
    { value: 'netlify', label: 'Netlify · Frontend hosting' },
  ],
  db: [
    { value: 'neon', label: 'Neon Postgres · Recommended default' },
    { value: 'supabase-postgres', label: 'Supabase Postgres · With auth' },
    { value: 'vercel-postgres', label: 'Vercel Postgres · Vercel-centric' },
    { value: 'planetscale', label: 'PlanetScale · MySQL family' },
    { value: 'turso', label: 'Turso · Lightweight SQLite' },
  ],
  login: [
    { value: 'supabase-kakao', label: 'Supabase + Kakao' },
    { value: 'supabase-naver', label: 'Supabase + Naver' },
    { value: 'supabase-google', label: 'Supabase + Google' },
    { value: 'supabase-email', label: 'Supabase + Email' },
    { value: 'clerk', label: 'Clerk · Fast login UI' },
  ],
  payment: [
    { value: 'toss-payments', label: 'Toss Payments · Korean default' },
    { value: 'portone', label: 'PortOne/Iamport · Multiple PGs' },
    { value: 'naver-pay', label: 'Naver Pay' },
    { value: 'kakao-pay', label: 'Kakao Pay' },
    { value: 'stripe', label: 'Stripe · Global payments' },
  ],
  file: [
    { value: 'vercel-blob', label: 'Vercel Blob · Recommended default' },
    { value: 's3', label: 'AWS S3' },
    { value: 'cloudflare-r2', label: 'Cloudflare R2' },
    { value: 'supabase-storage', label: 'Supabase Storage' },
    { value: 'google-cloud-storage', label: 'Google Cloud Storage' },
  ],
  ai: [
    { value: 'atlas-deepseek4', label: 'Atlas DeepSeek 4 · Default' },
    { value: 'qwen-code', label: 'Qwen coder' },
    { value: 'kimi', label: 'Kimi research' },
    { value: 'vercel-ai-sdk', label: 'Vercel AI SDK' },
    { value: 'openai-compatible', label: 'OpenAI-compatible API' },
  ],
} as const;

function StageModelDropdown({
  value,
  fallbackModel,
  options,
  onChange,
}: {
  value?: string;
  fallbackModel: string;
  options: AtlasModelOption[];
  onChange: (model: string | undefined) => void;
}) {
  const activeLabel = value
    ? (options.find(option => option.value === value)?.label || value)
    : `Default: ${fallbackModel}`;

  return (
    <details className="ah-stage-model-menu">
      <summary title="Stage model override">
        <span>{activeLabel}</span>
      </summary>
      <div className="ah-stage-model-options">
        <button
          type="button"
          className={!value ? 'active' : ''}
          onClick={(event) => {
            onChange(undefined);
            event.currentTarget.closest('details')?.removeAttribute('open');
          }}
        >
          {`Default: ${fallbackModel}`}
        </button>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            onClick={(event) => {
              onChange(option.value);
              event.currentTarget.closest('details')?.removeAttribute('open');
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </details>
  );
}

function ensureCliProvider(provider: AiProvider): CliProvider {
  // responseExecutor/cliRuntime가 직접 처리하는 provider는 그대로 전달한다.
  if (
    provider === ATLASCLOUD_PROVIDER ||
    provider === OLLAMA_PROVIDER ||
    provider === 'openai' ||
    provider === 'claude-api' ||
    provider === 'claude-cli' ||
    provider === 'codex-cli' ||
    provider === 'kimi-cli' ||
    provider === 'gemini-cli' ||
    provider === 'qwen-cli'
  ) {
    return provider;
  }
  return ATLASCLOUD_PROVIDER;
}

function resolveStateAction<T>(action: SetStateAction<T>, previous: T): T {
  return typeof action === 'function'
    ? (action as (value: T) => T)(previous)
    : action;
}

const SUGGESTION_KEYS = [
  'harness.suggest.architecture',
  'harness.suggest.bugs',
  'harness.suggest.tests',
  'harness.suggest.gitChanges',
] as const;

const BEGINNER_CODING_PROMPTS = [
  '아무것도 모르는 사람 기준으로, 지금 무엇부터 하면 되는지 한 단계씩 알려줘.',
  '새 서비스를 만들고 싶어. 쉬운 질문 3개만 하고, 답을 받으면 바로 시작해줘.',
  '지금 프로젝트에서 안 되는 부분을 찾아서 쉽게 설명하고 고쳐줘.',
  '이 서비스를 사람들이 쓰기 편하게 화면과 흐름을 고쳐줘.',
  '내 프로젝트를 실행해보고 깨지는 부분을 찾아서 고쳐줘.',
  '배포 전에 위험한 부분을 초보자 눈높이로 점검해줘.',
];

const KORINI_MODEL_IDS = new Set([
  'deepseek-ai/deepseek-v4-flash',
  'qwen/qwen3-coder-next',
  'moonshotai/kimi-k2.6',
]);

const KORINI_STARTER_CARDS = [
  {
    title: 'Create a new web project',
    desc: 'Next.js + Vercel + Neon',
    prompt: '나는 코딩을 잘 몰라. Next.js 웹 프로젝트를 만들고 싶어. 배포는 Vercel, 데이터베이스는 Neon 기준으로 해줘. 먼저 어떤 웹사이트나 웹앱인지 정리할 수 있게 쉬운 질문 3개만 해줘. 내가 답하면 프로젝트 폴더 만들기, 필요한 화면과 기능 만들기, Neon 연결 준비, Vercel 배포 준비, 웹 실행 확인과 화면 캡처까지 한 단계씩 떠먹여줘.',
  },
  {
    title: 'Fix an existing web project',
    desc: 'No need to know what is broken',
    prompt: '나는 코딩을 잘 몰라. 지금 Next.js 웹 프로젝트에서 안 되는 화면이나 불편한 부분을 같이 찾아줘. 배포는 Vercel, 데이터베이스는 Neon 기준으로 보고, 먼저 현재 웹 프로젝트를 쉬운 말로 살펴본 다음 작은 수정부터 진행하고 웹 화면으로 확인해줘.',
  },
  {
    title: 'Start from setup',
    desc: 'Prepare folder, run, and Git',
    prompt: '나는 개발 환경을 잘 몰라. 이 컴퓨터에서 Next.js 웹 프로젝트를 만들 수 있게 작업 폴더, 실행 방법, 웹 화면 확인, Vercel 배포 준비, Neon 데이터베이스 연결키 확인, 저장/복구 준비를 아주 쉽게 하나씩 점검하고 준비해줘.',
  },
  {
    title: 'Worried about security',
    desc: 'Check passwords, keys, risky settings',
    prompt: '나는 보안이 불안해. 초보자도 이해할 수 있게 이 프로젝트에서 비밀번호나 연결키가 새는지, 위험한 설정이 있는지, Git에 올리면 안 되는 파일이 있는지 먼저 점검해줘. 위험한 변경은 하지 말고, 안전하게 고칠 수 있는 것부터 알려주고 고쳐줘.',
  },
  {
    title: 'I got an error',
    desc: 'No need to understand what it means',
    prompt: '나는 코딩을 잘 몰라서 에러가 나면 어떻게 해야 할지 모르겠어. 지금 프로젝트 상태를 보고 에러를 쉬운 한국어로 번역해줘. 원인 후보, 바로 해볼 안전한 해결 순서, 다시 확인하는 방법, 그래도 안 되면 되돌리는 방법까지 아주 쉽게 안내하고 필요한 파일을 고쳐줘.',
  },
  {
    title: 'Just recommend something',
    desc: "Decide what to build together",
    prompt: '나는 뭘 해야 할지 아직 잘 몰라. 이 웹 프로젝트나 주변 웹 프로젝트를 보고, 초보자가 바로 만들 수 있는 작은 웹 기능 3개를 추천해줘. 내가 고르면 구현과 웹 화면 확인까지 이어가줘.',
  },
];

const KORINI_DESIGN_CARDS = [
  {
    title: 'Clean business service',
    desc: 'SaaS, booking, CRM, dashboard',
    prompt: '디자인은 깔끔한 회사 서비스 느낌으로 해줘. Next.js 웹앱에 맞게 디자인 시스템, 반응형, 접근성 스킬을 적용하고, 너무 장식적이지 않게 사용자가 반복해서 쓰기 편한 화면으로 만들어줘.',
  },
  {
    title: 'Beautiful intro page',
    desc: 'Landing, portfolio, brand',
    prompt: '디자인은 예쁜 소개 페이지 느낌으로 해줘. Next.js 랜딩 페이지에 맞게 첫 화면에서 무엇을 하는 서비스인지 바로 보이게 하고, 반응형/접근성/시각 디자인 스킬을 적용해줘.',
  },
  {
    title: 'Online store style',
    desc: 'Products, checkout, list/detail',
    prompt: '디자인은 쇼핑몰 느낌으로 해줘. Next.js와 Neon 데이터 구조를 고려해서 상품 목록, 상세, CTA, 신뢰 요소가 잘 보이게 하고 반응형/접근성 스킬을 적용해줘.',
  },
  {
    title: 'Community style',
    desc: 'Board, profiles, comments',
    prompt: '디자인은 커뮤니티 느낌으로 해줘. Next.js와 Neon 기준으로 게시글, 프로필, 댓글 흐름이 이해하기 쉽고 모바일에서도 편한 화면으로 만들어줘.',
  },
  {
    title: 'Admin dashboard',
    desc: 'Tables, filters, ops tools',
    prompt: '디자인은 관리자 화면 느낌으로 해줘. Next.js 대시보드에 맞게 표, 필터, 상태 표시, 반복 작업이 편한 UI로 만들고 디자인 시스템/접근성 스킬을 적용해줘.',
  },
  {
    title: 'Warm, personal app',
    desc: 'Journal, hobby, education, light service',
    prompt: '디자인은 감성적인 앱 느낌으로 해줘. Next.js 웹앱이지만 너무 복잡하지 않게, 부드럽고 친근한 화면으로 만들고 반응형/접근성 스킬을 적용해줘.',
  },
];

const KORINI_START_GUIDE = [
  {
    title: 'The stack we use',
    lines: ['Next.js web app', 'Vercel deploy', 'Neon Postgres DB', 'Supabase login', 'Korean payments', 'Vercel Blob images', 'Vercel AI SDK/API', 'Playwright MCP tests', 'Korean explanations'],
  },
  {
    title: 'How to sign up',
    lines: ['Create a Vercel account', 'Create a Neon account', 'Sign up for Atlas Cloud / make a key', 'GitHub connection is optional'],
  },
  {
    title: 'Atlas Cloud, step by step',
    lines: ['Create an API Key after signing up', 'Paste the key into Settings', 'Use the DeepSeek 4 default', 'If it fails, check key/balance/model name'],
  },
  {
    title: 'CLI, step by step',
    lines: ['Install Node.js', 'npx create-next-app@latest', 'npx vercel login', 'Check the site with npm run dev'],
  },
  {
    title: 'Login, step by step',
    lines: ['Use Supabase Auth', 'Prefer Kakao/Naver/Google', 'Register SUPABASE keys on Vercel', 'Verify permissions on the server'],
  },
  {
    title: 'Payments, step by step',
    lines: ['For Korea, prefer Toss Payments/PortOne', 'Consider card/easy pay', 'Register payment keys on Vercel', 'Save payment results via webhooks'],
  },
  {
    title: 'Images, step by step',
    lines: ['Store in Vercel Blob', 'Optimize with Next.js Image', 'Store only image URLs in Neon', 'Validate upload size/format'],
  },
  {
    title: 'AI/API, step by step',
    lines: ['Next.js Route Handler', 'Vercel AI SDK', 'API keys in Vercel env vars', 'Use secret keys only on the server'],
  },
  {
    title: 'Testing, step by step',
    lines: ['Playwright MCP by default', 'Real clicks in the browser', 'Confirm with screenshots', 'Translate errors into plain language'],
  },
  {
    title: 'Wrapping up, step by step',
    lines: ['Confirm deploy readiness', 'Confirm service connections', 'Run security once, then only check changes', 'Document how to roll back'],
  },
  {
    title: 'What Korini Mode does for you',
    lines: ['Create folders', 'Env var templates', 'Deploy/test/security/connection checks', 'Docs and recovery steps'],
  },
];

const HARNESS_PRESETS: Array<{
  id: 'clarify' | 'plan' | 'finish' | 'team' | 'check';
  labelKo: string;
  labelEn: string;
  forceWorkflow?: boolean;
  promptKo: string;
  promptEn: string;
}> = [
  {
    id: 'clarify',
    labelKo: 'Clarify first',
    labelEn: 'Clarify first',
    promptKo: '바로 구현하지 말고 먼저 요구사항을 정리해줘. 빠진 정보, 위험한 가정, 바꾸면 안 되는 범위, 확인 질문을 짧고 정확하게 정리해줘.',
    promptEn: 'Do not implement yet. Clarify the request first: missing information, risky assumptions, boundaries, and the few highest-value questions to ask.',
  },
  {
    id: 'plan',
    labelKo: 'Make a plan',
    labelEn: 'Make a plan',
    promptKo: '구현 전에 승인 가능한 계획을 만들어줘. 바꿀 파일, 작업 순서, 위험 요소, 테스트 방법, 예상 결과를 우리 프로젝트 기준으로 정리해줘.',
    promptEn: 'Create an approval-ready implementation plan for this project: files to change, order of work, risks, tests, and expected outcome.',
  },
  {
    id: 'finish',
    labelKo: 'Build it',
    labelEn: 'Build it',
    forceWorkflow: true,
    promptKo: '이 작업을 끝까지 진행해줘. 구현, 검증, 실패 수정, 변경 파일 요약까지 하고, 진짜 막힌 이유가 있을 때만 멈춰줘.',
    promptEn: 'Carry this task to completion. Implement, verify, fix failures, summarize changed files, and stop only if there is a concrete blocker.',
  },
  {
    id: 'team',
    labelKo: 'Split work',
    labelEn: 'Split work',
    forceWorkflow: true,
    promptKo: '이 작업을 병렬 작업으로 나눠서 진행해줘. 역할을 나누고, 구현과 검증을 합쳐서 하나의 결과로 정리해줘.',
    promptEn: 'Break this into coordinated workstreams, assign responsibilities, run implementation and verification, and merge the result into one coherent outcome.',
  },
  {
    id: 'check',
    labelKo: 'Check setup',
    labelEn: 'Check setup',
    promptKo: '이 프로젝트와 코린이모드 실행 준비 상태를 점검해줘. 연결키, 로컬 CLI, Ollama, 프로젝트 경로, 실패 가능성, 작은 실행 테스트를 초보자 눈높이로 확인해줘.',
    promptEn: 'Diagnose this project and coding assistant readiness: API keys, local CLI tools, Ollama, project path, likely failure points, and a small smoke test.',
  },
];

function formatCliName(provider: AiProvider): string {
  return String(provider || '').replace('-cli', '').replace(/^\w/, (char) => char.toUpperCase());
}

function buildHarnessPresetPrompt(
  preset: (typeof HARNESS_PRESETS)[number],
  request: string,
  responseLanguage: HarnessResponseLanguage,
): string {
  const prompt = responseLanguage === 'ko' ? preset.promptKo : preset.promptEn;
  return `${prompt}${request ? `\n\n사용자 요청:\n${request}` : ''}`;
}

function formatKoriniSettingLabel<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): string {
  return options.find(option => option.value === value)?.label || value;
}

function buildKoriniIntakeMessage(request: string, settings: KoriniSettings): string {
  return [
    '좋아요. 바로 개발하지 않고 먼저 꼼꼼히 정리할게요.',
    '',
    '## 지금 이해한 내용',
    request ? `- 만들거나 고치고 싶은 것: ${request}` : '- 아직 구체적인 내용이 없습니다.',
    '',
    '## 현재 선택된 기본 설정',
    `- 모델: ${settings.model}`,
    `- 배포: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.cloud, settings.cloud)}`,
    `- DB: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.db, settings.db)}`,
    `- 로그인: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.login, settings.login)}`,
    `- 결제: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.payment, settings.payment)}`,
    `- 파일 저장: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.file, settings.file)}`,
    `- AI: ${formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.ai, settings.ai)}`,
    '',
    '## 먼저 골라주세요',
    '1. 새 SaaS를 만들까요, 기존 앱을 고칠까요?',
    '2. 사용자는 누구인가요? 예: 사장님, 고객, 학생, 관리자, 쇼핑몰 운영자',
    '3. 가장 먼저 필요한 화면은 무엇인가요? 예: 랜딩, 로그인, 대시보드, 예약, 결제, 관리자',
    '4. 돈 받는 기능이 지금 필요한가요, 나중에 붙일까요?',
    '5. 원하면 Kimi / DeepSeek 4 / Qwen 코드에게 각각 계획을 물어보고 비교표로 고른 뒤 시작할 수 있어요.',
    '',
    '## 다음에 이렇게 말하면 됩니다',
    '- "1번 새 SaaS, 고객은 학원 원장, 예약과 결제부터. 다른 모델 계획도 비교해줘"',
    '- "기존 앱 고치기, 로그인부터 고쳐줘. 비교 없이 시작 계획만 세워줘"',
    '- "설정은 Vercel, Neon, 카카오 로그인, 토스 결제로 하고 개발 시작"',
    '',
    '확정 전에는 파일을 바꾸지 않습니다.',
  ].join('\n');
}

function shouldStartAfterPlanning(text: string): boolean {
  return /(개발\s*시작|바로\s*시작|진행해|만들어줘|고쳐줘|구현해|작업\s*시작|시작해)/i.test(text);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Splash Logo SVG ──

function DeerOctoLogo({ size = 120, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M38 32L30 14M30 14L22 4M30 14L36 6M22 4L18 8M36 6L40 4" stroke={color} strokeWidth="3" strokeLinecap="round" />
      <path d="M82 32L90 14M90 14L98 4M90 14L84 6M98 4L102 8M84 6L80 4" stroke={color} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="60" cy="52" rx="30" ry="26" stroke={color} strokeWidth="3.5" fill="none" />
      <circle cx="48" cy="48" r="4.5" fill={color} /><circle cx="49.5" cy="46.5" r="1.5" fill="white" />
      <circle cx="72" cy="48" r="4.5" fill={color} /><circle cx="73.5" cy="46.5" r="1.5" fill="white" />
      <path d="M50 60a12 12 0 0 0 20 0" stroke={color} strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M34 72c-6 10-8 22-2 26" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M44 76c-2 10-1 22 4 24" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M56 78c0 10 1 20 4 22" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M68 78c0 10-1 20-4 22" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M76 76c2 10 1 22-4 24" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M86 72c6 10 8 22 2 26" stroke={color} strokeWidth="3.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

// ── Stream Timer ──

function StreamTimer() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);
  if (elapsed < 2) return null;
  return <span className="ah-stream-timer">{elapsed}s</span>;
}

function RunElapsed() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);
  return <span className="ah-run-elapsed">{elapsed}s</span>;
}

// ── Component ──

export function AgentHarnessPanel({
  onClose,
  style,
  workDir,
  isVisible = true,
  projectName,
  skills,
  projectTargets,
  activeProjectId,
  onSelectProject,
  storageScopeKey,
  onSendToConsole,
}: AgentHarnessPanelProps) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<AgentMode>('coding');
  const [providerGroup, setProviderGroup] = useState<'atlascloud' | 'cli' | 'ollama'>('atlascloud');
  const [cliKind, setCliKind] = useState<AiProvider>('claude-cli');
  // provider는 providerGroup에서 파생한다 (단일 소스). state로 두면 상태 복원 hook이
  // 저장된 옛 provider로 덮어써 UI 선택과 어긋난다.
  const provider = useMemo<AiProvider>(
    () => (providerGroup === 'cli' ? cliKind : providerGroup),
    [providerGroup, cliKind],
  );
  const [backgroundProvider, setBackgroundProvider] = useState<AiProvider>(ATLASCLOUD_PROVIDER);
  const [responseLanguage, setResponseLanguageState] = useState<HarnessResponseLanguage>('ko');
  const setResponseLanguage = useCallback<Dispatch<SetStateAction<HarnessResponseLanguage>>>(() => {
    setResponseLanguageState('ko');
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ko'); } catch { /* ignore storage failures */ }
  }, []);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingThreadIdRef = useRef<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [showThreads, setShowThreads] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [artifactView, setArtifactView] = useState<'code' | 'preview'>('code');
  const [followups, setFollowups] = useState<string[]>([]);
  const [subTasks, setSubTasks] = useState<SubTask[]>([]);
  const [pendingDecompose, setPendingDecompose] = useState<{ description: string; provider: AiProvider; prompt: string }[] | null>(null);
  const [pendingWorkflowStart, setPendingWorkflowStart] = useState<PendingWorkflowStart | null>(null);
  const [pendingSpecReview, setPendingSpecReview] = useState<PendingSpecReview | null>(null);
  const [pendingPlanReview, setPendingPlanReview] = useState<PendingPlanReview | null>(null);
  const pendingMsgRef = useRef<string>('');
  const [learnedSkills, setLearnedSkills] = useState<LearnedSkillEntry[]>([]);
  const [ultraProviders] = useState<Set<AiProvider>>(new Set([ATLASCLOUD_PROVIDER]));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showNewChatProjectPicker, setShowNewChatProjectPicker] = useState(false);
  const [pendingStarterPrompt, setPendingStarterPrompt] = useState('');
  const [projectStartKind, setProjectStartKind] = useState<'new' | 'existing'>('new');
  const [selectedKoriniProjectId, setSelectedKoriniProjectId] = useState<string | null>(null);
  const [koriniBaseFolder, setKoriniBaseFolder] = useState(() => {
    try {
      return localStorage.getItem(KORINI_BASE_FOLDER_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [projectNameInput, setProjectNameInput] = useState('');
  const [backendJobs, setBackendJobs] = useState<HarnessBackendJob[]>([]);
  const [showAtlasSettings, setShowAtlasSettings] = useState(false);
  const [showKoriniSettings, setShowKoriniSettings] = useState(false);
  const [showMcpConnect, setShowMcpConnect] = useState(false);
  const [showToolSearch, setShowToolSearch] = useState(false);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [trustedShellPermission, setTrustedShellPermission] = useState(() => {
    try {
      return localStorage.getItem(SHELL_PERMISSION_STORAGE_KEY) === 'trusted';
    } catch {
      return false;
    }
  });
  const [atlasApiKey, setAtlasApiKey] = useState('');
  const [atlasBaseUrl, setAtlasBaseUrl] = useState(ATLASCLOUD_DEFAULT_BASE_URL);
  const [atlasModel, setAtlasModel] = useState(ATLASCLOUD_DEFAULT_MODEL);
  const [ollamaUrl, setOllamaUrl] = useState(OLLAMA_DEFAULT_URL);
  const [ollamaModel, setOllamaModel] = useState(OLLAMA_DEFAULT_MODEL);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [atlasSavedAt, setAtlasSavedAt] = useState<number | null>(null);
  const [atlasCodingTest, setAtlasCodingTest] = useState<AtlasCodingTestState>({
    status: 'idle',
    message: '',
    preview: '',
  });
  const [koriniSettings, setKoriniSettings] = useState<KoriniSettings>(DEFAULT_KORINI_SETTINGS);
  const [mcpConnectState, setMcpConnectState] = useState<HarnessMcpConnectState>({
    status: 'idle',
    message: 'External tool connection has not been checked yet.',
    detail: '',
  });
  const [, setProjectContextState] = useState<HarnessProjectContextState>({
    status: 'checking',
    count: 0,
    detail: '',
  });
  const [, setGitCareState] = useState<GitCareState>({
    status: 'idle',
    message: '',
    detail: '',
  });
  const atlasModelOptions = useMemo(() => {
    const options = ATLAS_AGENT_MODEL_OPTIONS.filter(option => KORINI_MODEL_IDS.has(option.value));
    if (atlasModel && !options.some(option => option.value === atlasModel)) {
      return [{ value: atlasModel, label: `Current selection · ${atlasModel}` }, ...options];
    }
    return options;
  }, [atlasModel]);
  const ollamaModelOptions = useMemo<AtlasModelOption[]>(() => (
    Array.from(new Set([ollamaModel, ...ollamaModels]))
      .filter(Boolean)
      .map(name => ({ value: name, label: name }))
  ), [ollamaModel, ollamaModels]);
  const getModelForProvider = useCallback((nextProvider: AiProvider): string => {
    if (nextProvider === OLLAMA_PROVIDER) return ollamaModel;
    if (nextProvider === ATLASCLOUD_PROVIDER) return atlasModel;
    return '';
  }, [atlasModel, ollamaModel]);
  const getModelOptionsForProvider = useCallback((nextProvider: AiProvider): AtlasModelOption[] => {
    if (nextProvider === OLLAMA_PROVIDER) return ollamaModelOptions;
    if (nextProvider === ATLASCLOUD_PROVIDER) return atlasModelOptions;
    return [];
  }, [atlasModelOptions, ollamaModelOptions]);
  const learningAssembly = useMemo(() => createHarnessLearningRuntime(), [workDir]);
  const harnessRuntime = useMemo(() => createHarnessRuntime({
    mode,
    provider,
    backgroundProvider,
    responseLanguage,
    ensureCliProvider,
    learningAssembly,
  }), [backgroundProvider, learningAssembly, mode, provider, responseLanguage]);
  const [workflow, setWorkflow] = useState<WorkflowConfig>(() => harnessRuntime.workflow.cloneWorkflowConfig(harnessRuntime.workflow.DEFAULT_WORKFLOW));
  const [showWorkflowEditor, setShowWorkflowEditor] = useState(false);
  useEffect(() => {
    void (async () => {
      const [apiKey, baseUrl, model] = await Promise.all([
        kvGet(ATLASCLOUD_KV_KEYS.apiKey),
        kvGet(ATLASCLOUD_KV_KEYS.baseUrl),
        kvGet(ATLASCLOUD_KV_KEYS.model),
      ]);
      const normalizedModel = normalizeAtlasCloudModelPreference(model);
      setAtlasApiKey((apiKey || '').trim());
      setAtlasBaseUrl((baseUrl || '').trim() || ATLASCLOUD_DEFAULT_BASE_URL);
      setAtlasModel(normalizedModel);
      if ((model || '').trim() !== normalizedModel) {
        void kvSet(ATLASCLOUD_KV_KEYS.model, normalizedModel);
      }
    })();
  }, []);
  const persistAtlasSetting = useCallback((key: string, value: string) => {
    void kvSet(key, value);
    setAtlasSavedAt(Date.now());
  }, []);
  const updateAtlasApiKey = useCallback((next: string) => {
    setAtlasApiKey(next);
    persistAtlasSetting(ATLASCLOUD_KV_KEYS.apiKey, next.trim());
  }, [persistAtlasSetting]);
  const updateAtlasModel = useCallback((next: string) => {
    setAtlasModel(next);
    persistAtlasSetting(ATLASCLOUD_KV_KEYS.model, next.trim());
  }, [persistAtlasSetting]);
  const updateAtlasBaseUrl = useCallback((next: string) => {
    setAtlasBaseUrl(next);
    persistAtlasSetting(ATLASCLOUD_KV_KEYS.baseUrl, next.trim());
  }, [persistAtlasSetting]);
  useEffect(() => {
    void (async () => {
      const [url, model] = await Promise.all([kvGet(OLLAMA_URL_KV_KEY), kvGet(OLLAMA_MODEL_KV_KEY)]);
      setOllamaUrl((url || '').trim() || OLLAMA_DEFAULT_URL);
      setOllamaModel((model || '').trim() || OLLAMA_DEFAULT_MODEL);
    })();
  }, []);
  // Ollama 모델 목록은 Ollama를 쓰거나 설정을 열 때만 /api/tags로 가져온다.
  useEffect(() => {
    if (provider !== OLLAMA_PROVIDER && !showAtlasSettings) return;
    let cancelled = false;
    void (async () => {
      const models = await listOllamaModels(ollamaUrl);
      if (!cancelled) setOllamaModels(models);
    })();
    return () => { cancelled = true; };
  }, [provider, showAtlasSettings, ollamaUrl]);
  const updateOllamaUrl = useCallback((next: string) => {
    setOllamaUrl(next);
    void kvSet(OLLAMA_URL_KV_KEY, next.trim());
  }, []);
  const updateOllamaModel = useCallback((next: string) => {
    setOllamaModel(next);
    void kvSet(OLLAMA_MODEL_KV_KEY, next.trim());
  }, []);
  const applyProviderAndModelToWorkflow = useCallback((nextProvider: AiProvider, nextModel?: string) => {
    setWorkflow(prev => harnessRuntime.workflow.applyProviderToWorkflow(
      prev,
      nextProvider,
      (nextModel ?? getModelForProvider(nextProvider)).trim() || undefined,
    ));
  }, [getModelForProvider, harnessRuntime.workflow]);
  const handleBackgroundProviderChange = useCallback((nextProvider: AiProvider) => {
    setBackgroundProvider(nextProvider);
    if (nextProvider === ATLASCLOUD_PROVIDER || nextProvider === OLLAMA_PROVIDER) {
      setProviderGroup(nextProvider);
    }
    applyProviderAndModelToWorkflow(nextProvider);
  }, [applyProviderAndModelToWorkflow]);
  const updateBackgroundModel = useCallback((nextModel: string) => {
    if (backgroundProvider === OLLAMA_PROVIDER) {
      updateOllamaModel(nextModel);
    } else if (backgroundProvider === ATLASCLOUD_PROVIDER) {
      updateAtlasModel(nextModel);
    }
    applyProviderAndModelToWorkflow(backgroundProvider, nextModel);
  }, [applyProviderAndModelToWorkflow, backgroundProvider, updateAtlasModel, updateOllamaModel]);
  useEffect(() => {
    if (backgroundProvider === ATLASCLOUD_PROVIDER || backgroundProvider === OLLAMA_PROVIDER) {
      applyProviderAndModelToWorkflow(backgroundProvider);
    }
  }, [applyProviderAndModelToWorkflow, backgroundProvider]);
  // 마지막 provider 선택을 복원 (앱 재시작 후에도 유지).
  useEffect(() => {
    void (async () => {
      const [g, c] = await Promise.all([kvGet('octo-harness-provider-group'), kvGet('octo-harness-cli-kind')]);
      if (g === 'atlascloud' || g === 'cli' || g === 'ollama') setProviderGroup(g);
      if (c && c.trim()) setCliKind(c.trim() as AiProvider);
    })();
  }, []);
  // provider 그룹(Atlas/CLI/Ollama) → 실제 provider 동기화 + 저장.
  // 백그라운드(followup/요약 등)도 같은 provider를 쓰게 해, Atlas 키 없이
  // Ollama만으로도 Atlas 호출 없이 동작하게 한다.
  useEffect(() => {
    const next = providerGroup === 'cli' ? cliKind : providerGroup;
    setBackgroundProvider(next);
    if (next === ATLASCLOUD_PROVIDER || next === OLLAMA_PROVIDER) {
      applyProviderAndModelToWorkflow(next);
    }
    void kvSet('octo-harness-provider-group', providerGroup);
    void kvSet('octo-harness-cli-kind', cliKind);
  }, [applyProviderAndModelToWorkflow, providerGroup, cliKind]);
  const runAtlasCodingTest = useCallback(async () => {
    setAtlasCodingTest({
      status: 'running',
      message: 'Sending a mock code-edit test to the Atlas API...',
      preview: '',
    });
    try {
      await Promise.all([
        kvSet(ATLASCLOUD_KV_KEYS.apiKey, atlasApiKey.trim()),
        kvSet(ATLASCLOUD_KV_KEYS.model, atlasModel.trim()),
        kvSet(ATLASCLOUD_KV_KEYS.baseUrl, atlasBaseUrl.trim()),
      ]);
      let preview = '';
      const result = await runAtlasCloudCodingSmokeTest((chunk) => {
        preview = `${preview}${chunk}`.slice(-1800);
        setAtlasCodingTest({
          status: 'running',
          message: 'Receiving response... checking the patch format.',
          preview,
        });
      });
      setAtlasCodingTest({
        status: result.ok ? 'passed' : 'failed',
        message: result.ok
          ? `Passed: ${result.model} produced a code patch in ${Math.round(result.elapsedMs / 100) / 10}s.`
          : `Response received but check failed: ${result.issues.join(', ')}`,
        preview: result.output.slice(-1800),
      });
    } catch (err) {
      setAtlasCodingTest({
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        preview: '',
      });
    }
  }, [atlasApiKey, atlasBaseUrl, atlasModel]);
  const runtimeSkills = useMemo<SkillInfo[]>(() => {
    return mergeRuntimeSkills(learnedSkills, skills || []) as SkillInfo[];
  }, [skills, learnedSkills]);
  const skillMetadataStats = useMemo(() => ({
    prioritized: runtimeSkills.filter(skill => (skill.priority || 0) !== 0).length,
    conditional: runtimeSkills.filter(skill => skill.paths?.length).length,
    toolScoped: runtimeSkills.filter(skill => skill.allowedTools?.length).length,
  }), [runtimeSkills]);
  const baseExecutionProfile = harnessRuntime.workflow.getWorkflowExecutionProfile(workflow);
  const executionProfile = useMemo(() => ({
    ...baseExecutionProfile,
    shellPermission: trustedShellPermission ? 'trusted' as const : 'standard' as const,
  }), [baseExecutionProfile, trustedShellPermission]);
  const updateTrustedShellPermission = useCallback((next: boolean) => {
    setTrustedShellPermission(next);
    try {
      localStorage.setItem(SHELL_PERMISSION_STORAGE_KEY, next ? 'trusted' : 'standard');
    } catch {
      /* ignore storage failures */
    }
  }, []);
  const modeFeatures = harnessRuntime.featureProfile;
  const uiText = useMemo(() => {
      const english = responseLanguage !== 'ko';
      return {
        title: english ? 'Korini Mode' : 'Korini Mode',
      welcomeSubtitle: english ? 'Korini Mode builds Next.js web projects for Vercel, Neon, Supabase Auth, Korean payments, Vercel Blob, Vercel AI SDK, and Playwright MCP tests.' : 'Korini Mode only helps with Next.js web projects. Deploy/API/AI use Vercel, DB is Neon, login is Supabase Auth, payments use Korean services, images use Vercel Blob, and tests use Playwright MCP.',
      newChat: english ? 'Build for me' : 'Build it for me',
      noThreads: english ? 'No tasks yet' : 'No tasks yet',
      codingStatus: english ? 'Working…' : 'Building…',
      saved: english ? 'Saved' : String(t('harness.coding.saved' as any)),
      files: english ? 'files' : String(t('harness.coding.files' as any)),
      steps: english ? 'steps' : String(t('harness.steps' as any)),
      reasoning: english ? 'reasoning' : String(t('harness.reasoning' as any)),
      subagents: english ? 'Helpers' : 'Helper tasks',
      decomposeTitle: english ? 'Split this task between helpers' : 'Split into helper tasks',
      decomposeRun: english ? 'Run' : String(t('harness.decompose.run' as any)),
      decomposeCancel: english ? 'Cancel' : String(t('harness.decompose.cancel' as any)),
      placeholder: english ? 'Say what you want to build, fix, test, deploy, or operate.' : 'Just say what to build, fix, test, deploy, or operate.',
      artifacts: english ? 'Created files' : 'Created files',
      memory: english ? 'Remembered notes' : 'Remembered notes',
      addMemory: english ? 'Add memory…' : String(t('harness.memory.add' as any)),
      emptyMemory: english ? 'No memories yet' : String(t('harness.memory.empty' as any)),
      preflightTitle: english ? 'Check before starting' : 'Quick check before starting',
      preflightNote: english
        ? 'This looks like a larger task, so Korini Mode paused before changing files. Check the simple steps below, then start.'
        : 'This looks like a larger task, so Korini Mode paused before changing files. Review the simple steps below, then start.',
      defaultProvider: english ? 'How to run' : 'Who builds it',
      model: english ? 'Detail option' : 'Detail option',
      applyAllStages: english ? 'Use for every step' : 'Use for every step',
      language: english ? 'Answer language' : 'Answer language',
      startReadyTitle: english ? 'Korini Mode will decide the next step' : 'Korini Mode will start on its own',
      startReadyNote: english
        ? 'No coding knowledge needed. Choose a starter below or type one sentence. Error help and docs are created automatically.'
        : 'Just press one button below. It handles building, Playwright MCP screen tests, deploy prep, security checks, Atlas Cloud/Vercel/Neon connection checks, and usage docs.',
      startChat: english ? 'Build for me' : 'Build it for me',
      developmentIntensity: english ? 'Depth' : 'Work depth',
      effortExtremeStart: english
        ? 'Spend more time checking and reviewing before finishing.'
        : 'Take more time to check carefully and finish thoroughly.',
      effortNormalStart: english
        ? 'Use the normal balance of speed and care.'
        : 'Balance speed and care.',
      effortExtremeEditor: english
        ? 'More careful planning, coding, and review.'
        : 'Plan, implement, and review more carefully.',
      effortNormalEditor: english
        ? 'Default task depth.'
        : 'Default work depth.',
      stageCount: (count: number, effort: WorkflowEffort | undefined) => english
        ? `${count} steps · ${effort === 'extreme' ? 'Careful' : 'Normal'}`
        : `${count} steps · Split across Kimi + DeepSeek 4 + Qwen coder`,
      startWithSettings: english ? 'Start this task' : 'Start as is',
      cancel: english ? 'Cancel' : 'Cancel',
      workflowSettings: english ? 'Careful mode' : 'Build slowly',
      currentProject: english ? 'Where to work' : 'Where to work',
      chooseProjectForNewChat: english ? 'Choose where to work first' : 'Choose where to work first',
      chooseProject: english ? 'Choose where to work' : 'Choose where to work',
      harnessPresets: english ? 'Quick requests' : 'Quick requests',
      running: english ? 'Working' : 'Working',
      waitingForCli: english ? 'Korini Mode is working' : 'Korini Mode is building',
      lastRun: english ? 'Latest task' : 'Latest task',
      runCompleted: english ? 'Done' : 'Done',
      runFailed: english ? 'Failed' : 'Failed',
      runStopped: english ? 'Stopped' : 'Stopped',
      backendJobs: english ? 'Queued work' : 'Queued work',
      noBackendJobs: english ? 'No queued work' : 'No queued work',
    };
  }, [responseLanguage, t]);

  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef(false);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  // 이번 세션에서 상태 파일을 저장한 프로젝트 경로들. 작업이 모두 삭제된 경로의 파일을 정리하는 데 쓴다.
  const persistedWorkDirsRef = useRef<Set<string>>(new Set());
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const setTrackedSubTasks = useCallback<Dispatch<SetStateAction<SubTask[]>>>((nextValue) => {
    setSubTasks((prev) => {
      const next = typeof nextValue === 'function'
        ? (nextValue as (value: SubTask[]) => SubTask[])(prev)
        : nextValue;
      const threadId = activeThreadIdRef.current;
      if (threadId) {
        setThreads((current) => current.map(thread => (
          thread.id === threadId ? { ...thread, subTasks: next } : thread
        )));
      }
      return next;
    });
  }, []);

  const {
    activeThread,
    allArtifacts,
    selectedPlanOptionChips,
  } = harnessRuntime.panel.buildViewModel({
    threads,
    activeThreadId,
    pendingSpecReview,
    pendingPlanReview,
    followups,
    isStreaming,
  });

  const scrollMessagesToBottom = useCallback(() => {
    const scroller = messagesScrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);

  const defaultProjectTarget = useMemo(() => {
    void activeProjectId;
    void projectTargets;
    return null;
  }, [activeProjectId, projectTargets]);
  const activeThreadProjectTarget = useMemo(() => {
    if (!activeThread) return defaultProjectTarget;
    return (projectTargets || []).find(target => target.id === activeThread.targetProjectId)
      || (activeThread.targetWorkDir
        ? {
            id: activeThread.targetProjectId || activeThread.id,
            displayName: activeThread.targetProjectName || activeThread.targetWorkDir,
            name: activeThread.targetProjectName || activeThread.targetWorkDir,
            workDir: activeThread.targetWorkDir,
            icon: '',
          }
        : defaultProjectTarget);
  }, [activeThread, defaultProjectTarget, projectTargets]);
  const effectiveWorkDir = activeThread?.targetWorkDir || activeThreadProjectTarget?.workDir || workDir;
  const visibleSubTasks = subTasks.length > 0 ? subTasks : (activeThread?.subTasks || []);
  const subAgentProgress = useMemo(() => {
    const total = visibleSubTasks.length;
    const completed = visibleSubTasks.filter(task => task.status === 'completed').length;
    const failed = visibleSubTasks.filter(task => task.status === 'failed').length;
    const running = visibleSubTasks.find(task => task.status === 'running');
    return { total, completed, failed, running };
  }, [visibleSubTasks]);
  const toolSearchResults = useMemo(() => {
    return toolSearchQuery.trim()
      ? searchHarnessTools(toolSearchQuery, 12)
      : HARNESS_TOOL_REGISTRY.slice(0, 12);
  }, [toolSearchQuery]);
  const insertToolCall = useCallback((tool: HarnessToolDefinition) => {
    const snippet = `@tool(${tool.name}, ${tool.args || ''})`;
    setInput((prev) => {
      const prefix = prev.trim() ? `${prev.replace(/\s+$/g, '')}\n` : '';
      return `${prefix}${snippet}`;
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);
  const currentThreadTarget = {
    projectId: activeThreadProjectTarget?.id,
    projectName: activeThreadProjectTarget?.displayName || activeThreadProjectTarget?.name,
    workDir: activeThreadProjectTarget?.workDir || workDir,
  };
  const koriniProjectTargets = useMemo(() => {
    const base = koriniBaseFolder.trim().replace(/\/+$/, '');
    if (!base) return [];
    return (projectTargets || []).filter(target => target.workDir.replace(/\/+$/, '').startsWith(`${base}/`));
  }, [koriniBaseFolder, projectTargets]);
  useEffect(() => {
    if (koriniProjectTargets.length === 0) {
      setSelectedKoriniProjectId(null);
      return;
    }
    setSelectedKoriniProjectId(prev => (
      prev && koriniProjectTargets.some(target => target.id === prev)
        ? prev
        : koriniProjectTargets[0].id
    ));
  }, [koriniProjectTargets]);
  const selectedKoriniProject = useMemo(() => (
    koriniProjectTargets.find(target => target.id === selectedKoriniProjectId)
    || activeThreadProjectTarget
    || koriniProjectTargets[0]
    || null
  ), [activeThreadProjectTarget, koriniProjectTargets, selectedKoriniProjectId]);
  const selectedKoriniProjectThreads = useMemo(() => {
    if (!selectedKoriniProject) return [];
    return threads.filter(thread =>
      thread.targetProjectId === selectedKoriniProject.id
      || thread.targetWorkDir === selectedKoriniProject.workDir,
    );
  }, [selectedKoriniProject, threads]);
  const koriniSettingsKey = useMemo(() => {
    const scope = selectedKoriniProject?.workDir || effectiveWorkDir || koriniBaseFolder || 'global';
    return `${KORINI_SETTINGS_STORAGE_PREFIX}:${scope}`;
  }, [effectiveWorkDir, koriniBaseFolder, selectedKoriniProject?.workDir]);
  useEffect(() => {
    let cancelled = false;
    void harnessDbGet(koriniSettingsKey).then((saved) => {
      if (cancelled || !saved) return;
      try {
        setKoriniSettings({ ...DEFAULT_KORINI_SETTINGS, ...JSON.parse(saved) });
      } catch {
        setKoriniSettings(DEFAULT_KORINI_SETTINGS);
      }
    });
    return () => { cancelled = true; };
  }, [koriniSettingsKey]);
  useEffect(() => {
    void harnessDbSet(koriniSettingsKey, JSON.stringify(koriniSettings));
  }, [koriniSettings, koriniSettingsKey]);
  const updateKoriniSetting = useCallback(<K extends keyof KoriniSettings>(key: K, value: KoriniSettings[K]) => {
    setKoriniSettings(prev => ({ ...prev, [key]: value }));
    if (key === 'model' && typeof value === 'string') {
      updateAtlasModel(value);
    }
  }, [updateAtlasModel]);
  const engineChoiceLabel = responseLanguage === 'ko'
    ? providerGroup === 'ollama'
      ? '내 컴퓨터 Ollama'
      : providerGroup === 'cli'
        ? `내 컴퓨터 도구 · ${formatCliName(cliKind)}`
        : '클라우드 자동 작업'
    : providerGroup === 'ollama'
      ? 'Local Ollama'
      : providerGroup === 'cli'
        ? `Local tool · ${formatCliName(cliKind)}`
        : 'Cloud coding';
  const engineDetailLabel = responseLanguage === 'ko'
    ? providerGroup === 'ollama'
      ? ollamaModel
      : providerGroup === 'cli'
        ? `${formatCliName(cliKind)} 직접 실행`
        : atlasModel
    : providerGroup === 'ollama'
      ? ollamaModel
      : providerGroup === 'cli'
        ? `${formatCliName(cliKind)} direct run`
        : atlasModel;
  const needsCloudKey = providerGroup === 'atlascloud' && !atlasApiKey.trim();
  const visibleBackendJobs = useMemo(() => {
    const knownWorkDirs = new Set((projectTargets || []).map(target => target.workDir).filter(Boolean));
    if (effectiveWorkDir) knownWorkDirs.add(effectiveWorkDir);
    return backendJobs
      .filter(job => !job.workDir || knownWorkDirs.size === 0 || knownWorkDirs.has(job.workDir))
      .slice(0, 4);
  }, [backendJobs, effectiveWorkDir, projectTargets]);

  useEffect(() => {
    setProjectContextState({
      status: 'empty',
      count: 0,
      detail: responseLanguage === 'ko'
        ? '코린이모드 기본 시작에서는 예전 코드베이스를 자동으로 읽지 않습니다.'
        : 'Korini Mode does not auto-read old codebases on default start.',
    });
  }, [responseLanguage]);

  const formatBackendJobStatus = useCallback((status: HarnessBackendJob['status']) => {
    if (responseLanguage !== 'ko') {
      if (status === 'running') return 'Running';
      if (status === 'completed') return 'Completed';
      if (status === 'cancelled') return 'Cancelled';
      return 'Failed';
    }
    if (status === 'running') return '진행 중';
    if (status === 'completed') return '완료';
    if (status === 'cancelled') return '취소됨';
    return '실패';
  }, [responseLanguage]);

  const prepareGitForCoding = useCallback(async (repair = false) => {
    const korean = responseLanguage === 'ko';
    const targetDir = activeThreadProjectTarget?.workDir || effectiveWorkDir;
    if (!targetDir || targetDir.startsWith('ssh://')) {
      setGitCareState({
        status: 'needs-setup',
        message: korean ? '로컬 작업공간이 필요합니다' : 'Local workspace needed',
        detail: targetDir || '',
      });
      return;
    }

    setGitCareState({
      status: 'checking',
      message: repair
        ? (korean ? 'Git 저장과 복구 준비 중...' : 'Preparing Git save and recovery...')
        : (korean ? 'Git 안전장치 확인 중...' : 'Checking Git safety...'),
      detail: targetDir,
    });

    const command = repair
      ? [
          'if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
          '  git init >/dev/null 2>&1 && echo "__BBARIT_GIT_CREATED__";',
          'fi',
          'echo "__BBARIT_GIT_BRANCH__ $(git branch --show-current 2>/dev/null || true)";',
          'if git remote | grep -q .; then',
          '  echo "__BBARIT_GIT_REMOTE__ $(git remote -v | head -1)";',
          '  git fetch --prune --all >/dev/null 2>&1 || echo "__BBARIT_GIT_FETCH_FAILED__";',
          'else',
          '  echo "__BBARIT_GIT_NO_REMOTE__";',
          'fi',
          'git status --porcelain=v2 --branch',
        ].join('\n')
      : [
          'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
          '  echo "__BBARIT_GIT_REPO__";',
          '  echo "__BBARIT_GIT_BRANCH__ $(git branch --show-current 2>/dev/null || true)";',
          '  if git remote | grep -q .; then echo "__BBARIT_GIT_REMOTE__ $(git remote -v | head -1)"; else echo "__BBARIT_GIT_NO_REMOTE__"; fi',
          '  git status --porcelain=v2 --branch',
          'else',
          '  echo "__BBARIT_GIT_NOT_REPO__";',
          'fi',
        ].join('\n');

    try {
      const raw = await invoke<string>('run_cli_oneshot', {
        command,
        workDir: targetDir,
        timeoutSecs: repair ? 20 : 8,
      });
      const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
      const created = lines.some(line => line.includes('__BBARIT_GIT_CREATED__'));
      const notRepo = lines.some(line => line.includes('__BBARIT_GIT_NOT_REPO__'));
      const noRemote = lines.some(line => line.includes('__BBARIT_GIT_NO_REMOTE__'));
      const fetchFailed = lines.some(line => line.includes('__BBARIT_GIT_FETCH_FAILED__'));
      const changed = lines.filter(line => /^(1|2|u|\?)/.test(line)).length;
      const branch = (lines.find(line => line.startsWith('__BBARIT_GIT_BRANCH__')) || '').replace('__BBARIT_GIT_BRANCH__', '').trim();
      const remote = (lines.find(line => line.startsWith('__BBARIT_GIT_REMOTE__')) || '').replace('__BBARIT_GIT_REMOTE__', '').trim();

      if (notRepo && !repair) {
        setGitCareState({
          status: 'needs-setup',
          message: korean ? '아직 저장소가 아닙니다' : 'Git is not ready yet',
          detail: korean ? 'Git 준비/복구를 누르면 안전하게 git init만 합니다.' : 'Use Git repair to safely run git init.',
        });
        return;
      }

      setGitCareState({
        status: created || repair ? 'fixed' : 'ready',
        message: created
          ? (korean ? 'Git 저장소를 만들었습니다' : 'Git repository created')
          : noRemote
            ? (korean ? 'Git 저장 준비됨 · 원격 없음' : 'Git ready · no remote')
            : fetchFailed
              ? (korean ? 'Git 저장 준비됨 · 원격 확인 실패' : 'Git ready · remote check failed')
              : (korean ? 'Git 저장/복구 준비됨' : 'Git save/recovery ready'),
        detail: [
          branch ? (korean ? `가지: ${branch}` : `branch: ${branch}`) : '',
          remote ? (korean ? `연결: ${remote}` : `remote: ${remote}`) : '',
          changed ? (korean ? `바뀐 파일 ${changed}개` : `${changed} changed files`) : (korean ? '바뀐 파일 없음' : 'no changed files'),
        ].filter(Boolean).join(' · '),
      });
    } catch (error) {
      setGitCareState({
        status: 'failed',
        message: korean ? 'Git 확인에 실패했습니다' : 'Git check failed',
        detail: String(error),
      });
    }
  }, [activeThreadProjectTarget?.workDir, effectiveWorkDir, responseLanguage]);

  useEffect(() => {
    if (!isVisible) return;
    void prepareGitForCoding(false);
  }, [isVisible, prepareGitForCoding]);

  const checkHarnessMcpBridge = useCallback(async () => {
    const korean = responseLanguage === 'ko';
    setMcpConnectState({
      status: 'checking',
      message: korean ? '외부 도구 연결을 확인하는 중...' : 'Checking external tool connection...',
      detail: '',
    });
    try {
      const health = await invoke<{ status: number; body: string }>('http_request', {
        input: {
          method: 'GET',
          url: 'http://127.0.0.1:19980/health',
          headers: {},
          body: null,
          timeout_ms: 2500,
        },
      });
      const commands = await invoke<{ status: number; body: string }>('http_request', {
        input: {
          method: 'GET',
          url: 'http://127.0.0.1:19980/api/commands',
          headers: {},
          body: null,
          timeout_ms: 2500,
        },
      });
      let commandCount = 0;
      try {
        const parsed = JSON.parse(commands.body || '{}') as { commands?: unknown[] };
        commandCount = Array.isArray(parsed.commands) ? parsed.commands.length : 0;
      } catch {
        commandCount = 0;
      }
      const ready = health.status >= 200 && health.status < 300 && (health.body || '').trim() === 'ok';
      setMcpConnectState({
        status: ready ? 'ready' : 'failed',
        message: ready
          ? (korean ? '외부 도구 연결이 준비되었습니다.' : 'External tools are ready.')
          : (korean ? '외부 도구 연결 응답이 예상과 다릅니다.' : 'External tool connection responded unexpectedly.'),
        detail: ready
          ? (korean ? `${commandCount}개 BBARIT 명령을 사용할 수 있습니다.` : `${commandCount} BBARIT commands are available.`)
          : `${health.status}: ${health.body}`,
      });
      return ready;
    } catch (error) {
      setMcpConnectState({
        status: 'failed',
        message: korean ? '외부 도구 연결을 확인할 수 없습니다.' : 'Could not reach external tool connection.',
        detail: korean
          ? `BBARIT Terminal을 실행한 상태에서 다시 확인하세요. ${String(error)}`
          : `Make sure BBARIT Terminal is running, then check again. ${String(error)}`,
      });
      return false;
    }
  }, [responseLanguage]);

  const connectHarnessMcp = useCallback(async () => {
    const korean = responseLanguage === 'ko';
    const targetDir = activeThreadProjectTarget?.workDir || effectiveWorkDir;
    if (!targetDir || targetDir.startsWith('ssh://')) {
      setMcpConnectState({
        status: 'failed',
        message: korean ? '내 컴퓨터에 있는 작업공간에서만 도구 연결을 만들 수 있습니다.' : 'Tool setup can only be written for a local project.',
        detail: targetDir || '',
      });
      return;
    }

    setMcpConnectState({
      status: 'checking',
      message: korean ? '코린이모드가 쓸 도구 연결 파일을 만드는 중...' : 'Writing Korini Mode tool connection files...',
      detail: targetDir,
    });

    try {
      const homeDir = await invoke<string>('get_home_dir');
      const octoConfigDir = `${homeDir}/.config/octo`;
      const octoTerminalServerPath = `${octoConfigDir}/mcp-octo-server.mjs`;
      const projectConfigPath = `${targetDir}/.mcp.json`;

      await invoke('create_directory', { path: octoConfigDir });
      await invoke('write_file', { path: octoTerminalServerPath, content: mcpOctoServerSource });

      let projectConfig: { mcpServers?: Record<string, unknown> } = {};
      try {
        const raw = await invoke<string>('read_file', { path: projectConfigPath });
        const parsed = JSON.parse(raw || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          projectConfig = parsed as { mcpServers?: Record<string, unknown> };
        }
      } catch {
        projectConfig = {};
      }
      projectConfig.mcpServers = {
        ...(projectConfig.mcpServers || {}),
        'octo-terminal': {
          command: 'node',
          args: [octoTerminalServerPath],
          env: { OCTO_BRIDGE_URL: 'http://127.0.0.1:19980' },
        },
      };

      await invoke('write_file', {
        path: projectConfigPath,
        content: `${JSON.stringify(projectConfig, null, 2)}\n`,
      });

      const bridgeReady = await checkHarnessMcpBridge();
      setMcpConnectState({
        status: bridgeReady ? 'ready' : 'failed',
        message: bridgeReady
          ? (korean ? '외부 도구 연결 설정 완료' : 'External tool connection is configured')
          : (korean ? '설정은 만들었지만 연결 확인이 실패했습니다.' : 'Config was written, but connection check failed.'),
        detail: korean
          ? 'Claude/Codex를 다시 열고 도구 목록에서 octo-terminal을 확인하세요.'
          : 'Restart Claude/Codex, then run /mcp and check for octo-terminal.',
        projectConfigPath,
      });
    } catch (error) {
      setMcpConnectState({
        status: 'failed',
        message: korean ? '도구 연결 설정 실패' : 'Failed to configure external tools',
        detail: String(error),
      });
    }
  }, [activeThreadProjectTarget?.workDir, checkHarnessMcpBridge, effectiveWorkDir, responseLanguage]);

  const updateThreadRunState = useCallback((threadId: string | null | undefined, patch: NonNullable<ChatThread['runState']> | Partial<NonNullable<ChatThread['runState']>> | null) => {
    if (!threadId) return;
    setThreads((prev) => {
      let changed = false;
      const next = prev.map((thread) => {
        if (thread.id !== threadId) return thread;
        changed = true;
        const runState = patch === null ? undefined : {
          ...(thread.runState || {
            status: 'running' as const,
            provider,
            model: getModelForProvider(provider),
            mode,
            startedAt: Date.now(),
            updatedAt: Date.now(),
            targetProjectName: activeThreadProjectTarget?.displayName || activeThreadProjectTarget?.name || projectName,
            targetWorkDir: effectiveWorkDir,
          }),
          ...patch,
          updatedAt: Date.now(),
        };
        return { ...thread, runState };
      });
      if (!changed) return prev;
      threadsRef.current = next;
      return next;
    });
  }, [activeThreadProjectTarget?.displayName, activeThreadProjectTarget?.name, effectiveWorkDir, getModelForProvider, mode, projectName, provider]);

  const markCurrentRunState = useCallback((patch: Partial<NonNullable<ChatThread['runState']>>) => {
    updateThreadRunState(streamingThreadIdRef.current || activeThreadId, patch);
  }, [activeThreadId, updateThreadRunState]);

  const setIsStreamingTracked: Dispatch<SetStateAction<boolean>> = useCallback((action) => {
    setIsStreaming((previous) => {
      const next = resolveStateAction(action, previous);
      const threadId = streamingThreadIdRef.current || activeThreadId;
      if (threadId) {
        queueMicrotask(() => {
          if (next) {
            updateThreadRunState(threadId, {
              status: 'running',
              provider,
              model: getModelForProvider(provider) || undefined,
              mode,
              startedAt: threadsRef.current.find(thread => thread.id === threadId)?.runState?.startedAt || Date.now(),
              targetProjectName: activeThreadProjectTarget?.displayName || activeThreadProjectTarget?.name || projectName,
              targetWorkDir: effectiveWorkDir,
            });
          } else if (previous) {
            const existing = threadsRef.current.find(thread => thread.id === threadId)?.runState;
            if (!existing || existing.status === 'running') {
              updateThreadRunState(threadId, {
                status: 'completed',
                completedAt: Date.now(),
              });
            }
          }
        });
      }
      return next;
    });
  }, [activeThreadId, activeThreadProjectTarget?.displayName, activeThreadProjectTarget?.name, effectiveWorkDir, getModelForProvider, mode, projectName, provider, updateThreadRunState]);

  const setStreamingContentTracked: Dispatch<SetStateAction<string>> = useCallback((action) => {
    setStreamingContent((previous) => {
      const next = resolveStateAction(action, previous);
      if (next) markCurrentRunState({ progressText: next });
      return next;
    });
  }, [markCurrentRunState]);

  const setStreamingThinkingTracked: Dispatch<SetStateAction<string>> = useCallback((action) => {
    setStreamingThinking((previous) => {
      const next = resolveStateAction(action, previous);
      if (next) markCurrentRunState({ thinkingText: next });
      return next;
    });
  }, [markCurrentRunState]);

  const setErrorTracked: Dispatch<SetStateAction<string | null>> = useCallback((action) => {
    setError((previous) => {
      const next = resolveStateAction(action, previous);
      if (next) {
        markCurrentRunState({
          status: 'failed',
          error: next,
          completedAt: Date.now(),
        });
      }
      return next;
    });
  }, [markCurrentRunState]);

  const harnessStorageScope = storageScopeKey || workDir;
  const { stateKey: storageKey, memoryKey, workflowKey } = harnessRuntime.storage.buildHarnessStorageKeys(STORAGE_KEY_PREFIX, harnessStorageScope);
  const harnessProjectStateWorkDirs = useMemo(() => (
    (projectTargets && projectTargets.length > 0)
      ? projectTargets.map(target => target.workDir).filter(Boolean)
      : [workDir].filter(Boolean)
  ), [projectTargets, workDir]);

  useEffect(() => {
    let cancelled = false;
    void harnessDbGet(KORINI_BASE_FOLDER_STORAGE_KEY).then(async () => {
      if (cancelled) return;
      const next = await getDefaultKoriniBaseFolder();
      if (cancelled || !next.trim()) return;
      setKoriniBaseFolder(next.trim());
      try { localStorage.setItem(KORINI_BASE_FOLDER_STORAGE_KEY, next.trim()); } catch { /* ignore storage fallback failures */ }
      void harnessDbSet(KORINI_BASE_FOLDER_STORAGE_KEY, next.trim());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const value = koriniBaseFolder.trim();
    if (!value) return;
    try { localStorage.setItem(KORINI_BASE_FOLDER_STORAGE_KEY, value); } catch { /* ignore storage fallback failures */ }
    void harnessDbSet(KORINI_BASE_FOLDER_STORAGE_KEY, value);
  }, [koriniBaseFolder]);

  useEffect(() => {
    if (!effectiveWorkDir) return;
    const timer = window.setTimeout(() => {
      const groups = new Map<string, ChatThread[]>();
      for (const thread of threads) {
        const target = thread.targetWorkDir || thread.runState?.targetWorkDir || effectiveWorkDir;
        groups.set(target, [...(groups.get(target) || []), thread]);
      }
      // 삭제·모두 비우기로 비워진 프로젝트의 상태 파일은 정리한다.
      // (이걸 안 하면 재로드 시 loadHarnessProjectState가 삭제한 작업을 되살린다)
      const currentDirs = new Set(groups.keys());
      const orphanedDirs = [...persistedWorkDirsRef.current].filter((dir) => !currentDirs.has(dir));
      persistedWorkDirsRef.current = currentDirs;
      void Promise.all([
        ...[...groups.entries()].map(([targetWorkDir, targetThreads]) => (
          persistHarnessProjectState(targetWorkDir, targetThreads)
        )),
        ...orphanedDirs.map((dir) => clearHarnessProjectState(dir)),
      ]).catch((err) => {
        console.warn('[Harness] failed to persist project state:', err);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [effectiveWorkDir, threads]);

  // 멈춘 "동작중" 자동 복구 (실행 상태 배지 + 단계별 sub-task 스피너 모두).
  // 모든 실행 경로가 begin→finish로 isStreaming을 감싸므로, isStreaming=false는 진행 중인 실행이 없다는 뜻이다.
  // 그런데도 'running'으로 남은 작업/단계는 세션 도중 비정상 종료(스트림 끊김·스레드 전환)로 종료 처리가 누락된 것이다.
  // 1.5초 디바운스로 실행 시작 시의 짧은 레이스는 피하면서 멈춘 것만 정리한다.
  useEffect(() => {
    if (isStreaming) return;
    const interrupted = responseLanguage === 'ko' ? '실행이 중단되었습니다.' : 'Run was interrupted.';
    const threadStuck = threads.some((thread) => (
      thread.runState?.status === 'running'
      || (thread.subTasks || []).some((task) => task.status === 'running')
    ));
    const stateStuck = subTasks.some((task) => task.status === 'running');
    if (!threadStuck && !stateStuck) return;
    const timer = window.setTimeout(() => {
      if (threadStuck) {
        setThreads((prev) => {
          let changed = false;
          const next = prev.map((thread) => {
            const runStuck = thread.runState?.status === 'running';
            const subStuck = (thread.subTasks || []).some((task) => task.status === 'running');
            if (!runStuck && !subStuck) return thread;
            changed = true;
            return {
              ...thread,
              runState: runStuck && thread.runState
                ? { ...thread.runState, status: 'stopped' as const, completedAt: thread.runState.completedAt || Date.now(), error: thread.runState.error || interrupted }
                : thread.runState,
              subTasks: subStuck
                ? (thread.subTasks || []).map((task) => (task.status === 'running' ? { ...task, status: 'failed' as const } : task))
                : thread.subTasks,
            };
          });
          if (!changed) return prev;
          threadsRef.current = next;
          return next;
        });
      }
      if (stateStuck) {
        setSubTasks((prev) => prev.map((task) => (task.status === 'running' ? { ...task, status: 'failed' as const } : task)));
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [isStreaming, threads, subTasks, responseLanguage, setThreads]);

  useEffect(() => {
    let cancelled = false;
    listHarnessBackendJobs()
      .then(jobs => {
        if (!cancelled) setBackendJobs(jobs);
      })
      .catch(() => {
        if (!cancelled) setBackendJobs([]);
      });

    let unlisten: (() => void) | null = null;
    listen<HarnessBackendJob>('harness-job-updated', (event) => {
      setBackendJobs(prev => {
        const next = [event.payload, ...prev.filter(job => job.id !== event.payload.id)];
        next.sort((a, b) => b.updatedAt - a.updatedAt);
        return next.slice(0, 20);
      });
    }).then(fn => {
      unlisten = fn;
    }).catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useHarnessPersistence({
    storageKey,
    memoryKey,
    workflowKey,
    languageKey: LANGUAGE_STORAGE_KEY,
    workDir: harnessStorageScope,
    projectStateWorkDirs: harnessProjectStateWorkDirs,
    threads,
    activeThreadId,
    mode,
    provider,
    backgroundProvider,
    responseLanguage,
    memories,
    workflow,
    harnessRuntime,
    kvGet: harnessDbGet,
    kvSet: harnessDbSet,
    setThreads,
    setActiveThreadId,
    setMode,
    setBackgroundProvider,
    setResponseLanguage,
    setMemories,
    setWorkflow,
  });

  const {
    splash,
    splashFade,
  } = useAgentHarnessPanelEffects({
    selfImproving: harnessRuntime.selfImproving,
    workDir: effectiveWorkDir,
    activeMessageCount: activeThread?.messages.length || 0,
    streamingContent,
    input,
    messagesEndRef,
    textareaRef,
    setLearnedSkills,
  });

  useEffect(() => {
    if (!isVisible || splash) return;

    scrollMessagesToBottom();
    const frame = window.requestAnimationFrame(() => {
      scrollMessagesToBottom();
      window.requestAnimationFrame(scrollMessagesToBottom);
    });
    const timers = [80, 240, 600].map((delay) => window.setTimeout(scrollMessagesToBottom, delay));
    return () => {
      window.cancelAnimationFrame(frame);
      timers.forEach(window.clearTimeout);
    };
  }, [
    activeThreadId,
    activeThread?.messages.length,
    isVisible,
    pendingWorkflowStart,
    scrollMessagesToBottom,
    showWorkflowEditor,
    splash,
    threads.length,
  ]);

  const {
    memoryInput,
    setMemoryInput,
    sortedMemories,
    addMemory,
    deleteMemory,
    togglePinMemory,
    submitMemoryInput,
  } = useAgentHarnessMemory({
    memories,
    setMemories,
    genId,
  });

  const {
    handlePasteAttachment,
    handleDropAttachment,
    removeAttachment,
  } = useAgentHarnessAttachments({
    setAttachments,
    genId,
    workDir,
    onAttachmentAdded: () => textareaRef.current?.focus(),
    onAttachmentError: setError,
  });

  const {
    moveStage,
    addWorkflowStage,
    removeWorkflowStage,
    updateWorkflowStage,
    applyWorkflowPreset,
    applyBackgroundProviderToWorkflow,
    updateWorkflowEffort,
  } = useHarnessWorkflowActions({
    harnessRuntime,
    backgroundProvider,
    backgroundModel: getModelForProvider(backgroundProvider),
    setWorkflow,
    genId,
  });

  const {
    createThread,
    deleteThread,
    updateThread,
  } = useHarnessThreadActions({
    harnessRuntime,
    provider,
    newChatLabel: uiText.newChat,
    threadsRef,
    textareaRef,
    setThreads,
    setActiveThreadId,
    setError: setErrorTracked,
    setFollowups,
    setSubTasks: setTrackedSubTasks,
    setPendingWorkflowStart,
    setPendingSpecReview,
    setPendingPlanReview,
    setStreamingContent: setStreamingContentTracked,
    setStreamingThinking: setStreamingThinkingTracked,
    setIsStreaming: setIsStreamingTracked,
    setSelectedArtifact,
    genId,
  });

  const createThreadForTarget = useCallback(async (
    target: HarnessProjectTarget | null,
    options?: { clearInput?: boolean; clearAttachments?: boolean },
  ) => {
    const resolved = target || defaultProjectTarget;
    let selectedProjectId = resolved?.id;
    if (resolved) {
      const nextId = await onSelectProject?.(resolved.id, resolved);
      if (typeof nextId === 'string' && nextId.trim()) selectedProjectId = nextId.trim();
    }
    if (options?.clearInput !== false) setInput('');
    if (options?.clearAttachments !== false) setAttachments([]);
    createThread(resolved ? {
      projectId: selectedProjectId || resolved.id,
      projectName: resolved.displayName || resolved.name,
      workDir: resolved.workDir,
    } : undefined);
    setShowNewChatProjectPicker(false);
    setProjectNameInput('');
  }, [createThread, defaultProjectTarget, onSelectProject]);

  const suggestedKoriniBaseFolder = useMemo(() => getParentDir(workDir), [workDir]);
  const effectiveKoriniBaseFolder = koriniBaseFolder.trim();

  const customProjectTarget = useMemo<HarnessProjectTarget | null>(() => {
    const baseFolder = koriniBaseFolder.trim().replace(/\/+$/, '');
    const folderName = sanitizeProjectFolderName(projectNameInput);
    if (!baseFolder || !folderName || !hasProjectNameText(projectNameInput)) return null;
    const path = `${baseFolder}/${folderName}`;
    return {
      id: `custom:${path}`,
      name: folderName,
      displayName: projectStartKind === 'new' ? `New project: ${folderName}` : `Project: ${folderName}`,
      workDir: path,
      icon: projectStartKind === 'new' ? '+' : '>',
      source: 'suggested',
      reason: projectStartKind === 'new' ? 'Under the Korini base folder' : 'Under the Korini base folder',
    };
  }, [koriniBaseFolder, projectNameInput, projectStartKind]);

  const {
    handleSubmit,
    executePendingWorkflowStart,
    executeSelectedSpecReview,
    executeSelectedPlanReview,
    executeDecomposed,
  } = useHarnessTurnController({
    activeThreadId,
    input,
    attachments,
    isStreaming,
    memories,
    mode,
    provider,
    responseLanguage,
    workflow,
    runtimeSkills,
    workDir: effectiveWorkDir,
    threadTarget: currentThreadTarget,
    executionProfile,
    supportsWorkflowTimeoutFallback: modeFeatures.supportsWorkflowTimeoutFallback,
    uiText,
    harnessRuntime,
    ultraProviders,
    threadsRef,
    streamingThreadIdRef,
    pendingMsgRef,
    abortRef,
    pendingWorkflowStart,
    pendingSpecReview,
    pendingPlanReview,
    setThreads,
    setActiveThreadId,
    setInput,
    setAttachments,
    setShowWorkflowEditor,
    setError: setErrorTracked,
    setFollowups,
    setPendingWorkflowStart,
    setPendingSpecReview,
    setPendingPlanReview,
    setPendingDecompose,
    setSubTasks: setTrackedSubTasks,
    setIsStreaming: setIsStreamingTracked,
    setStreamingContent: setStreamingContentTracked,
    setStreamingThinking: setStreamingThinkingTracked,
    setShowArtifacts,
    setSelectedArtifact,
    setLearnedSkills,
    addMemory,
    updateThread,
    ensureCliProvider,
    genId,
  });

  const handleStop = useCallback(() => {
    abortRef.current = true;
    markCurrentRunState({ status: 'stopped', completedAt: Date.now() });
    setIsStreamingTracked(false);
    streamingThreadIdRef.current = null;
    setStreamingContentTracked('');
    setStreamingThinkingTracked('');
  }, [markCurrentRunState, setIsStreamingTracked, setStreamingContentTracked, setStreamingThinkingTracked]);

  const resetCodingSecretary = useCallback(() => {
    const ok = window.confirm(
      responseLanguage === 'ko'
        ? '코린이모드를 초기화할까요?\n대화, 기억, 진행 중 표시를 비우고 처음 상태로 돌아갑니다. 연결키와 프로젝트 목록은 유지합니다.'
        : 'Reset Korini Mode?\nThis clears chats, memories, and stuck run state. Keys and projects are kept.',
    );
    if (!ok) return;

    abortRef.current = true;
    setIsStreamingTracked(false);
    streamingThreadIdRef.current = null;
    pendingMsgRef.current = '';
    setThreads([]);
    setActiveThreadId(null);
    setInput('');
    setAttachments([]);
    setStreamingContentTracked('');
    setStreamingThinkingTracked('');
    setFollowups([]);
    setTrackedSubTasks([]);
    setPendingWorkflowStart(null);
    setPendingSpecReview(null);
    setPendingPlanReview(null);
    setPendingDecompose(null);
    setSelectedArtifact(null);
    setError(null);
    setMemories([]);
    setWorkflow(harnessRuntime.workflow.cloneWorkflowConfig(harnessRuntime.workflow.DEFAULT_WORKFLOW));
    void harnessDbSet(storageKey, JSON.stringify({ threads: [], activeThreadId: null, mode: 'coding', provider, backgroundProvider, responseLanguage }));
    void harnessDbSet(memoryKey, JSON.stringify([]));
    void harnessDbSet(workflowKey, JSON.stringify(harnessRuntime.workflow.cloneWorkflowConfig(harnessRuntime.workflow.DEFAULT_WORKFLOW)));
    void Promise.all(harnessProjectStateWorkDirs.map(workDir => clearHarnessProjectState(workDir))).catch(() => {});
  }, [
    backgroundProvider,
    harnessProjectStateWorkDirs,
    harnessRuntime.workflow,
    memoryKey,
    provider,
    responseLanguage,
    setIsStreamingTracked,
    setStreamingContentTracked,
    setStreamingThinkingTracked,
    setTrackedSubTasks,
    storageKey,
    workflowKey,
  ]);

  const submitHarnessInput = useCallback((text?: string, options?: { forceWorkflow?: boolean }) => {
    const raw = (text || input).trim();
    if (!raw) return;
    void handleSubmit(raw, options);
  }, [handleSubmit, input]);

  const openNewChatProjectPicker = useCallback((starterPrompt = '', kind: 'new' | 'existing' = 'new', autoRun = false) => {
    void (async () => {
      const baseFolder = koriniBaseFolder.trim() || await getDefaultKoriniBaseFolder();
      setKoriniBaseFolder(baseFolder);
      const prompt = starterPrompt.trim() || (
        kind === 'existing'
          ? '코린이모드가 만든 앱 중에서 무엇을 고치면 좋을지 먼저 살펴봐줘. 최근 앱과 만든 내용을 쉬운 말로 정리하고, 내가 답하기 쉽게 "이걸 고칠까요?"라고 물어봐줘.'
          : '내가 뭘 만들지 아직 잘 몰라. 코린이모드가 만들 만한 앱 이름과 기능을 먼저 제안하고, 마음에 들면 바로 만들어줘.'
      );
      const autoName = inferProjectNameFromPrompt(prompt);
      const autoTarget: HarnessProjectTarget = {
        id: `korini:${baseFolder.replace(/\/+$/, '')}/${autoName}`,
        name: autoName,
        displayName: autoName,
        workDir: `${baseFolder.replace(/\/+$/, '')}/${autoName}`,
        icon: '+',
        source: 'suggested',
        reason: 'Auto app space',
      };
      const existingTarget = kind === 'existing'
        ? activeThreadProjectTarget || koriniProjectTargets[0] || null
        : null;
      await createThreadForTarget(existingTarget || autoTarget, {
        clearInput: true,
        clearAttachments: !autoRun,
      });
      if (autoRun) {
        window.setTimeout(() => submitHarnessInput(prompt, { forceWorkflow: kind === 'new' }), 160);
      } else {
        setInput(responseLanguage === 'ko'
          ? '코린이모드가 이전 대화와 만든 앱을 보고, 새로 만들지 고칠지 알아서 판단해서 시작해줘.'
          : 'Use Korini Mode to decide what to build or fix based on previous conversations.');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    })();
  }, [activeThreadProjectTarget, createThreadForTarget, koriniBaseFolder, koriniProjectTargets, responseLanguage, submitHarnessInput]);

  const beginKoriniPlanningOnly = useCallback((rawRequest: string) => {
    void (async () => {
      const baseFolder = koriniBaseFolder.trim() || await getDefaultKoriniBaseFolder();
      setKoriniBaseFolder(baseFolder);
      const prompt = rawRequest.trim() || '무엇을 만들지 아직 잘 모르겠어.';
      const target = selectedKoriniProject || {
        id: `korini:${baseFolder.replace(/\/+$/, '')}/${inferProjectNameFromPrompt(prompt)}`,
        name: inferProjectNameFromPrompt(prompt),
        displayName: inferProjectNameFromPrompt(prompt),
        workDir: `${baseFolder.replace(/\/+$/, '')}/${inferProjectNameFromPrompt(prompt)}`,
        icon: '+',
        source: 'suggested' as const,
        reason: 'App to build after questions',
      };
      let selectedProjectId = target.id;
      const nextId = await onSelectProject?.(target.id, target);
      if (typeof nextId === 'string' && nextId.trim()) selectedProjectId = nextId.trim();
      const now = Date.now();
      const thread: ChatThread = {
        id: genId(),
        title: `Prep · ${target.displayName || target.name}`,
        createdAt: now,
        mode: 'coding',
        provider,
        todos: [],
        targetProjectId: selectedProjectId,
        targetProjectName: target.displayName || target.name,
        targetWorkDir: target.workDir,
        messages: [
          { id: genId(), role: 'human', content: prompt, timestamp: now },
          { id: genId(), role: 'assistant', content: buildKoriniIntakeMessage(prompt, koriniSettings), timestamp: now + 1 },
        ],
      };
      setThreads((prev) => {
        const next = harnessRuntime.panel.insertThreadAtTop(prev, thread);
        threadsRef.current = next;
        return next;
      });
      setActiveThreadId(thread.id);
      setSelectedKoriniProjectId(target.id);
      setInput('');
      setAttachments([]);
      setSubTasks([]);
      setFollowups([]);
      setPendingSpecReview(null);
      setPendingPlanReview(null);
      setStreamingContent('');
      setStreamingThinking('');
      requestAnimationFrame(() => textareaRef.current?.focus());
    })();
  }, [harnessRuntime.panel, koriniBaseFolder, koriniSettings, onSelectProject, provider, selectedKoriniProject]);

  const submitKoriniChatInput = useCallback(() => {
    const raw = input.trim();
    if (!raw && attachments.length === 0) return;
    if (!activeThread) {
      const prompt = raw || '붙여넣은 이미지나 파일을 보고, 코린이모드가 새 앱을 만들지 고칠지 알아서 판단해서 진행해줘.';
      beginKoriniPlanningOnly(prompt);
      return;
    }
    const isInitialPlanningThread = activeThread.messages.length <= 2
      && activeThread.messages.some(message => message.role === 'assistant' && message.content.includes('바로 개발하지 않고 먼저'));
    if (isInitialPlanningThread && !shouldStartAfterPlanning(raw)) {
      const now = Date.now();
      setThreads((prev) => {
        const next = prev.map(thread => thread.id === activeThread.id
          ? {
            ...thread,
            messages: [
              ...thread.messages,
              { id: genId(), role: 'human' as const, content: raw, timestamp: now },
              {
                id: genId(),
                role: 'assistant' as const,
                content: [
                  '좋아요. 아직 개발은 시작하지 않았고, 답변을 바탕으로 선택지를 더 좁혔어요.',
                  '',
                  '## 이제 선택하면 됩니다',
                  '1. 이대로 개발 시작',
                  '2. Kimi / DeepSeek 4 / Qwen 코드에게 계획을 각각 물어보고 비교',
                  '3. 설정부터 바꾸기',
                  '4. 질문 더 하기',
                  '',
                  '개발하려면 "이대로 개발 시작"이라고 말해주세요.',
                ].join('\n'),
                timestamp: now + 1,
              },
            ],
          }
          : thread);
        threadsRef.current = next;
        return next;
      });
      setInput('');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    submitHarnessInput(undefined, { forceWorkflow: true });
  }, [activeThread, attachments.length, beginKoriniPlanningOnly, input, submitHarnessInput]);

  const startThreadAtTarget = useCallback((target: HarnessProjectTarget | null) => {
    void (async () => {
      await createThreadForTarget(target);
      const prompt = pendingStarterPrompt.trim();
      setPendingStarterPrompt('');
      if (prompt) {
        window.setTimeout(() => submitHarnessInput(prompt, { forceWorkflow: true }), 120);
      }
    })();
  }, [createThreadForTarget, pendingStarterPrompt, submitHarnessInput]);

  const selectKoriniProject = useCallback((target: HarnessProjectTarget) => {
    setSelectedKoriniProjectId(target.id);
    void onSelectProject?.(target.id, target);
    const matchingThreads = threadsRef.current.filter(thread =>
      thread.targetProjectId === target.id
      || thread.targetWorkDir === target.workDir,
    );
    const latestThread = matchingThreads
      .slice()
      .sort((a, b) => {
        const aTime = a.messages[a.messages.length - 1]?.timestamp || a.createdAt || 0;
        const bTime = b.messages[b.messages.length - 1]?.timestamp || b.createdAt || 0;
        return bTime - aTime;
      })[0];
    if (latestThread) {
      setActiveThreadId(latestThread.id);
      setSubTasks(latestThread.subTasks || []);
      setErrorTracked(null);
      setFollowups([]);
      setPendingSpecReview(null);
      setPendingPlanReview(null);
      setStreamingContent('');
      setStreamingThinking('');
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onSelectProject]);

  const clearInput = useCallback(() => {
    setInput('');
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const applyHarnessPreset = useCallback((preset: (typeof HARNESS_PRESETS)[number]) => {
    if (preset.id === 'check') {
      if (!activeThread) {
        const expanded = buildHarnessPresetPrompt(preset, input.trim(), responseLanguage);
        void handleSubmit(expanded, { forceWorkflow: preset.forceWorkflow });
        return;
      }
      void (async () => {
        setIsStreamingTracked(true);
        streamingThreadIdRef.current = activeThread.id;
        setStreamingContentTracked('Checking harness status...');
        try {
          const checks = await runHarnessDoctor(effectiveWorkDir);
          const content = formatHarnessDoctorReport(checks);
          updateThread(activeThread.id, (thread) => ({
            ...thread,
            messages: [...thread.messages, {
              id: genId(),
              role: 'assistant',
              content,
              timestamp: Date.now(),
            }],
          }));
          markCurrentRunState({
            status: checks.some(check => check.status === 'fail') ? 'failed' : 'completed',
            progressText: content,
            completedAt: Date.now(),
          });
        } catch (error) {
          setErrorTracked(String(error));
        } finally {
          setIsStreamingTracked(false);
          setStreamingContentTracked('');
        }
      })();
      return;
    }
    const raw = input.trim();
    const expanded = buildHarnessPresetPrompt(preset, raw, responseLanguage);
    void handleSubmit(expanded, { forceWorkflow: preset.forceWorkflow });
  }, [activeThread, effectiveWorkDir, handleSubmit, input, markCurrentRunState, responseLanguage, setErrorTracked, setIsStreamingTracked, setStreamingContentTracked, updateThread]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitKoriniChatInput(); }
  }, [submitKoriniChatInput]);

  const copyMessage = useCallback((msg: ChatMessage) => {
    void navigator.clipboard.writeText(msg.content);
    setCopiedId(msg.id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const renderKoriniSettingsPanel = () => (
    <div className="ah-korini-settings-panel">
      <div className="ah-korini-settings-head">
        <strong>Korini settings</strong>
        <span>Remembered separately per project.</span>
      </div>
      <label>
        <span>Model</span>
        <select value={koriniSettings.model} onChange={(event) => updateKoriniSetting('model', event.target.value)}>
          {atlasModelOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Deploy cloud</span>
        <select value={koriniSettings.cloud} onChange={(event) => updateKoriniSetting('cloud', event.target.value as KoriniCloudProvider)}>
          {KORINI_SETTING_OPTIONS.cloud.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>DB</span>
        <select value={koriniSettings.db} onChange={(event) => updateKoriniSetting('db', event.target.value as KoriniDbProvider)}>
          {KORINI_SETTING_OPTIONS.db.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Login</span>
        <select value={koriniSettings.login} onChange={(event) => updateKoriniSetting('login', event.target.value as KoriniLoginProvider)}>
          {KORINI_SETTING_OPTIONS.login.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Payments</span>
        <select value={koriniSettings.payment} onChange={(event) => updateKoriniSetting('payment', event.target.value as KoriniPaymentProvider)}>
          {KORINI_SETTING_OPTIONS.payment.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>File storage</span>
        <select value={koriniSettings.file} onChange={(event) => updateKoriniSetting('file', event.target.value as KoriniFileProvider)}>
          {KORINI_SETTING_OPTIONS.file.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label>
        <span>AI/API</span>
        <select value={koriniSettings.ai} onChange={(event) => updateKoriniSetting('ai', event.target.value as KoriniAiProvider)}>
          {KORINI_SETTING_OPTIONS.ai.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <div className="ah-korini-settings-note">
        If you want, say "compare plans from other models" in the chat. It will compare plans from Kimi, DeepSeek 4, and Qwen coder so you can choose.
      </div>
    </div>
  );

  const renderChatComposer = () => {
    const isThisThreadStreaming = isStreaming && streamingThreadIdRef.current === activeThreadId;
    const disabled = !input.trim() && attachments.length === 0;
    return (
      <div
        className="ah-input-area ah-chat-only-input"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => { void handleDropAttachment(e).then(() => requestAnimationFrame(() => textareaRef.current?.focus())); }}
      >
        {attachments.length > 0 && (
          <div className="ah-attachments-preview">
            {attachments.map(att => (
              <div key={att.id} className="ah-attachment-item">
                {att.type === 'image' ? (
                  <img src={att.dataUrl} alt={att.name} className="ah-attachment-thumb" />
                ) : (
                  <FileCode size={16} style={{ flexShrink: 0 }} />
                )}
                <span className="ah-attachment-name">{att.name}</span>
                <button className="ah-attachment-remove" onClick={() => removeAttachment(att.id)}><X size={10} /></button>
              </div>
            ))}
          </div>
        )}
        <div className="ah-input-row ah-input-row-simple">
          <textarea
            ref={textareaRef}
            className="ah-input-textarea"
            placeholder={uiText.placeholder}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isThisThreadStreaming}
            rows={1}
          />
          {input.length > 0 && (
            <button
              className="ah-clear-input-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearInput}
              disabled={isThisThreadStreaming}
              title="Clear input"
            >
              <X size={13} />
            </button>
          )}
          {isThisThreadStreaming ? (
            <button className="ah-send-btn ah-stop-btn" onClick={handleStop} title={responseLanguage === 'ko' ? '멈추기' : 'Stop'}><Square size={14} /></button>
          ) : (
            <button
              className="ah-send-btn"
              onClick={submitKoriniChatInput}
              disabled={disabled}
              title={responseLanguage === 'ko' ? '보내기' : 'Send'}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };

  // CSS custom properties
  const cssVars = {
    '--ah-bg': style.bg,
    '--ah-text': style.text,
    '--ah-accent': style.accent,
    '--ah-border': `${style.text}18`,
    '--ah-hover': `${style.text}0a`,
    '--ah-active': `${style.text}15`,
  } as CSSProperties;

  // Splash screen
  if (splash) {
    return (
      <div className="agent-harness" style={{ ...cssVars, background: style.bg, color: style.text }}>
        <div className={`ah-splash${splashFade ? ' fade-out' : ''}`}>
          <div className="ah-splash-logo-wrap">
            {/* <span className="ah-beta-badge ah-beta-badge-splash">BETA</span> */}
            <div className="ah-splash-logo"><DeerOctoLogo size={100} color={style.accent} /></div>
          </div>
          <div className="ah-splash-title">Korini Mode</div>
          <div className="ah-splash-subtitle">BEGINNER MODE</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="agent-harness korini-chat-only"
      style={{ ...cssVars, background: style.bg, color: style.text }}
      onPaste={(e) => {
        handlePasteAttachment(e);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }}
    >
      <datalist id="ah-atlas-model-options">
        {atlasModelOptions.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </datalist>
      <div className="ah-korini-topbar">
        <div className="ah-korini-topbar-main">
          <strong>Korini Mode</strong>
          <span>Asks first, then starts after you choose.</span>
        </div>
        <div className="ah-korini-topbar-actions">
          <button type="button" onClick={() => setShowKoriniSettings(v => !v)}>
            <Settings2 size={16} />
            <span>Settings</span>
          </button>
          <button type="button" onClick={onClose} className="ah-korini-exit-btn">
            <X size={16} />
            <span>Exit Korini Mode</span>
          </button>
        </div>
      </div>
      {showKoriniSettings && renderKoriniSettingsPanel()}
      <div className="ah-korini-project-board">
        <aside className="ah-korini-project-list" aria-label="Korini project list">
          <div className="ah-korini-board-title">My projects</div>
          {koriniProjectTargets.map(target => (
            <button
              key={target.id}
              type="button"
              className={`ah-korini-project-row${selectedKoriniProject?.id === target.id ? ' active' : ''}`}
              onClick={() => selectKoriniProject(target)}
              title={target.workDir}
            >
              <span className="ah-korini-project-icon">{target.icon || 'App'}</span>
              <span>
                <strong>{target.displayName || target.name}</strong>
                <em>{target.reason || target.workDir}</em>
              </span>
            </button>
          ))}
          {koriniProjectTargets.length === 0 && (
            <div className="ah-korini-project-empty">No projects created yet.</div>
          )}
        </aside>
        <section className="ah-korini-project-detail" aria-label="Korini project details">
          {selectedKoriniProject ? (
            <>
              <div className="ah-korini-board-title">Details</div>
              <h2>{selectedKoriniProject.displayName || selectedKoriniProject.name}</h2>
              <p>{selectedKoriniProject.workDir}</p>
              <div className="ah-korini-detail-grid">
                <span>{selectedKoriniProjectThreads.length} chats/memories</span>
                <span>{formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.cloud, koriniSettings.cloud)}</span>
                <span>{formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.db, koriniSettings.db)}</span>
                <span>{formatKoriniSettingLabel(KORINI_SETTING_OPTIONS.login, koriniSettings.login)}</span>
              </div>
              <div className="ah-korini-detail-actions">
                <button type="button" onClick={() => startThreadAtTarget(selectedKoriniProject)}>
                  Open this project chat
                </button>
                <button
                  type="button"
                  onClick={() => setInput('이 프로젝트에서 바꿀 것과 위험한 점을 먼저 물어보고, 선택지를 보여준 뒤 시작해줘.')}
                >
                  Ask carefully
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ah-korini-board-title">Details</div>
              <h2>Set up a new project</h2>
              <p>Tell it what to build, and it asks first, shows options, then starts.</p>
            </>
          )}
        </section>
      </div>
      {/* Header */}
      <div className="agent-harness-header">
        <div className="agent-harness-header-left">
          <button className="btn-top-small" onClick={() => setShowThreads(v => !v)} title={responseLanguage === 'ko' ? '맡긴 작업 목록' : 'Task list'}>
            {showThreads ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
          </button>
          <span className="ah-header-logo-wrap">
            {/* <span className="ah-beta-badge ah-beta-badge-header">BETA</span> */}
            <MessageSquare size={14} />
          </span>
          <span>Korini Mode</span>
          {projectName && !projectTargets?.length && <span style={{ opacity: 0.4, fontSize: 11 }}>[{projectName}]</span>}
          {activeThread && <span style={{ opacity: 0.5, fontSize: 11 }}>— {activeThread.title}</span>}
        </div>
        <div className="agent-harness-header-right">
          <button className="ah-header-new-chat" onClick={() => openNewChatProjectPicker()} title={uiText.newChat}>
            <Plus size={13} />
            <span>{uiText.newChat}</span>
          </button>
          <button
            className={`btn-top-small ah-header-btn${showAtlasSettings ? ' active' : ''}`}
            onClick={() => setShowAtlasSettings(v => !v)}
            title={responseLanguage === 'ko' ? '작업 처리 방식 설정' : 'Coding engine settings'}
          >
            <Settings2 size={13} />
          </button>
          <button
            className={`btn-top-small ah-header-btn${showMcpConnect ? ' active' : ''}`}
            onClick={() => setShowMcpConnect(v => !v)}
            title={responseLanguage === 'ko' ? '외부 도구 연결' : 'External tools'}
          >
            <Globe size={13} />
          </button>
          <button
            className={`btn-top-small ah-header-btn${showToolSearch ? ' active' : ''}`}
            onClick={() => setShowToolSearch(v => !v)}
            title={responseLanguage === 'ko' ? '도구 찾기' : 'Find tools'}
          >
            <Search size={13} />
          </button>
          <button className="btn-top-small ah-header-btn ah-header-btn-close" onClick={onClose} title={responseLanguage === 'ko' ? '닫기' : 'Close'}><X size={13} /></button>
        </div>
      </div>

      {showAtlasSettings && (
        <div className="ah-atlas-settings-panel">
          <div className="ah-helper-settings-intro">
            <strong>{responseLanguage === 'ko' ? '코린이모드 실행 방식' : 'Korini Mode engine'}</strong>
            <span>
              {responseLanguage === 'ko'
                ? '초보자는 클라우드 자동 작업을 권장합니다. CLI와 Ollama는 로컬 도구가 이미 로그인되어 있을 때 사용하세요.'
                : 'Cloud coding is recommended for beginners. Use CLI or Ollama only when those local tools are installed and signed in.'}
            </span>
          </div>
          <label>
            <span>{responseLanguage === 'ko' ? '작업 처리 방식' : 'How to run'}</span>
            <select value={providerGroup} onChange={(event) => setProviderGroup(event.target.value as 'atlascloud' | 'cli' | 'ollama')}>
              <option value="atlascloud">{responseLanguage === 'ko' ? '클라우드 자동 작업 (권장)' : 'Cloud coding (recommended)'}</option>
              <option value="cli">{responseLanguage === 'ko' ? '내 컴퓨터 도구 사용' : 'Use local coding tool'}</option>
              <option value="ollama">{responseLanguage === 'ko' ? '내 컴퓨터 Ollama 사용' : 'Use local Ollama'}</option>
            </select>
          </label>

          {providerGroup === 'atlascloud' && (
            <>
              <label>
                <span>{responseLanguage === 'ko' ? 'Atlas 연결키' : 'Atlas API key'}</span>
                <input
                  type="password"
                  value={atlasApiKey}
                  placeholder="apikey-..."
                  onChange={(event) => updateAtlasApiKey(event.target.value)}
                />
              </label>
              <label>
                <span>{responseLanguage === 'ko' ? '작업 엔진' : 'Coding model'}</span>
                <select value={atlasModel} onChange={(event) => updateAtlasModel(event.target.value)}>
                  {atlasModelOptions.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {providerGroup === 'cli' && (
            <label>
              <span>{responseLanguage === 'ko' ? '내 컴퓨터 도구' : 'Local coding tool'}</span>
              <select value={cliKind} onChange={(event) => setCliKind(event.target.value as AiProvider)}>
                <option value="claude-cli">Claude CLI</option>
                <option value="codex-cli">Codex CLI</option>
                <option value="kimi-cli">Kimi CLI</option>
                <option value="gemini-cli">Gemini CLI</option>
                <option value="qwen-cli">Qwen CLI</option>
              </select>
            </label>
          )}

          {providerGroup === 'ollama' && (
            <>
              <label>
                <span>{responseLanguage === 'ko' ? 'Ollama 주소' : 'Ollama URL'}</span>
                <input
                  value={ollamaUrl}
                  placeholder={OLLAMA_DEFAULT_URL}
                  onChange={(event) => updateOllamaUrl(event.target.value)}
                />
              </label>
              <label>
                <span>{responseLanguage === 'ko' ? '로컬 모델' : 'Local model'}</span>
                <select value={ollamaModel} onChange={(event) => updateOllamaModel(event.target.value)}>
                  {Array.from(new Set([ollamaModel, ...ollamaModels])).filter(Boolean).map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          <div className="ah-atlas-settings-actions">
            <button
              className="ah-atlas-test-btn"
              onClick={resetCodingSecretary}
              title={responseLanguage === 'ko' ? '대화와 멈춘 상태를 비우고 새로 시작' : 'Clear chats and stuck state'}
            >
              <RotateCcw size={13} />
              <span>{responseLanguage === 'ko' ? '코린이모드 초기화' : 'Reset Korini Mode'}</span>
            </button>
            {providerGroup === 'atlascloud' && (
              <button
                className="ah-atlas-test-btn"
                onClick={runAtlasCodingTest}
                disabled={atlasCodingTest.status === 'running'}
                title={responseLanguage === 'ko' ? '클라우드 작업이 실제 코드 응답을 만드는지 확인' : 'Check whether cloud coding can produce a code response'}
              >
                {atlasCodingTest.status === 'running' ? <Loader2 size={13} className="ah-spin" /> : <Sparkles size={13} />}
                <span>{responseLanguage === 'ko' ? '연결 테스트' : 'Test connection'}</span>
              </button>
            )}
            {providerGroup === 'ollama' && (
              <button
                className="ah-atlas-test-btn"
                onClick={() => { void (async () => { setOllamaModels(await listOllamaModels(ollamaUrl)); })(); }}
                title={responseLanguage === 'ko' ? '설치된 Ollama 모델 목록 새로고침' : 'Refresh installed Ollama models'}
              >
                <Sparkles size={13} />
                <span>{responseLanguage === 'ko' ? '모델 새로고침' : 'Refresh models'}</span>
              </button>
            )}
            <div className={`ah-atlas-settings-status ${providerGroup === 'atlascloud' && atlasCodingTest.status !== 'idle' ? atlasCodingTest.status : ''}`}>
              {providerGroup === 'ollama'
                ? (ollamaModels.length ? `${ollamaModels.length} models` : (responseLanguage === 'ko' ? 'Ollama 꺼짐 또는 모델 없음' : 'Ollama off or no models'))
                : providerGroup === 'cli'
                  ? (responseLanguage === 'ko' ? '내 컴퓨터 도구로 실행' : 'Local coding tool')
                  : atlasCodingTest.status === 'passed' ? (responseLanguage === 'ko' ? '연결 확인됨' : 'Connected') : atlasCodingTest.status === 'failed' ? (responseLanguage === 'ko' ? '확인 필요' : 'Check needed') : atlasSavedAt ? (responseLanguage === 'ko' ? '저장됨' : 'Saved') : (responseLanguage === 'ko' ? '클라우드 자동 작업' : 'Cloud coding')}
            </div>
          </div>

          <label className="ah-shell-permission-toggle">
            <input
              type="checkbox"
              checked={trustedShellPermission}
              onChange={(event) => updateTrustedShellPermission(event.target.checked)}
            />
            <span>{responseLanguage === 'ko' ? '파일/명령 자동 실행 허용' : 'Allow automatic file and command actions'}</span>
            <em>{trustedShellPermission ? (responseLanguage === 'ko' ? '자동 허용' : 'Auto') : (responseLanguage === 'ko' ? '확인 필요' : 'Ask')}</em>
          </label>

          {providerGroup === 'atlascloud' && atlasCodingTest.status !== 'idle' && (
            <div className={`ah-atlas-test-result ${atlasCodingTest.status}`}>
              <strong>{atlasCodingTest.message}</strong>
              {atlasCodingTest.preview && <pre>{atlasCodingTest.preview}</pre>}
            </div>
          )}
        </div>
      )}

      {showMcpConnect && (
        <div className="ah-mcp-connect-panel">
          <div className="ah-mcp-connect-main">
            <div className={`ah-mcp-connect-status ${mcpConnectState.status}`}>
              {mcpConnectState.status === 'checking' ? <Loader2 size={13} className="ah-spin" /> : mcpConnectState.status === 'ready' ? <CheckCircle2 size={13} /> : <Globe size={13} />}
              <strong>{responseLanguage === 'ko' ? '외부 도구 연결' : 'External Tools'}</strong>
              <span>{mcpConnectState.message}</span>
            </div>
            {mcpConnectState.detail && <div className="ah-mcp-connect-detail">{mcpConnectState.detail}</div>}
            {mcpConnectState.projectConfigPath && <code className="ah-mcp-connect-path">{mcpConnectState.projectConfigPath}</code>}
          </div>
          <div className="ah-mcp-connect-actions">
            <button onClick={() => void connectHarnessMcp()} disabled={mcpConnectState.status === 'checking'}>
              {mcpConnectState.status === 'checking' ? <Loader2 size={13} className="ah-spin" /> : <Check size={13} />}
              <span>{responseLanguage === 'ko' ? '작업공간에 연결' : 'Connect workspace'}</span>
            </button>
            <button onClick={() => void checkHarnessMcpBridge()} disabled={mcpConnectState.status === 'checking'}>
              <Search size={13} />
              <span>{responseLanguage === 'ko' ? '상태 확인' : 'Check'}</span>
            </button>
          </div>
        </div>
      )}

      {showToolSearch && (
        <div className="ah-tool-search-panel">
          <div className="ah-tool-search-head">
            <div>
              <strong>{responseLanguage === 'ko' ? '도구 찾기' : 'Find tools'}</strong>
              <span>{responseLanguage === 'ko' ? '파일 읽기, 검색, 명령 실행 같은 도구를 찾아 요청에 붙입니다.' : 'Find helper tools such as file reading, search, and command execution.'}</span>
            </div>
            <div className="ah-tool-search-count">{toolSearchResults.length}/{HARNESS_TOOL_REGISTRY.length}</div>
          </div>
          <div className="ah-tool-search-box">
            <Search size={13} />
            <input
              value={toolSearchQuery}
              onChange={(event) => setToolSearchQuery(event.target.value)}
              placeholder={responseLanguage === 'ko' ? '파일 읽기, 검색, 명령 실행...' : 'read files, search, run command...'}
            />
          </div>
          <div className="ah-tool-search-results">
            {toolSearchResults.map(tool => (
              <button
                key={tool.name}
                type="button"
                className="ah-tool-search-item"
                onClick={() => insertToolCall(tool)}
                title={`@tool(${tool.name}, ${tool.args})`}
              >
                <span className="ah-tool-search-icon">
                  {tool.name.includes('web') ? <Globe size={13} /> :
                   tool.name.includes('file') ? <FileCode size={13} /> :
                   tool.name === 'bash' ? <TerminalIcon size={13} /> :
                   <Search size={13} />}
                </span>
                <span className="ah-tool-search-main">
                  <strong>{tool.name}</strong>
                  <span>{tool.description}</span>
                </span>
                <code>{tool.args || 'no args'}</code>
              </button>
            ))}
          </div>
        </div>
      )}

      {activeThread && (projectTargets || []).length > 0 && (
        <div className="ah-project-command-bar">
          <div className="ah-project-select-wrap" title={activeThreadProjectTarget?.workDir || ''}>
            <span>{uiText.currentProject}</span>
            <select
              className="ah-project-header-select"
              value={activeThreadProjectTarget?.id || '__current__'}
              onChange={(event) => {
                const picked = (projectTargets || []).find((p) => p.id === event.target.value);
                if (picked) startThreadAtTarget(picked);
              }}
            >
              {!activeThreadProjectTarget && (
                <option value="__current__">
                  {activeThread?.targetProjectName || projectName || uiText.chooseProjectForNewChat}
                </option>
              )}
              {(projectTargets || []).map((p) => (
                <option key={p.id} value={p.id}>{`${p.icon || ''} ${p.displayName || p.name}`}</option>
              ))}
            </select>
            {(activeThreadProjectTarget?.workDir || effectiveWorkDir) && <em>{activeThreadProjectTarget?.workDir || effectiveWorkDir}</em>}
          </div>
          <div className="ah-harness-presets" aria-label={uiText.harnessPresets}>
            {HARNESS_PRESETS.filter(preset => preset.id === 'finish').map(preset => (
              <button
                key={preset.id}
                className="ah-harness-preset primary"
                onClick={() => applyHarnessPreset(preset)}
                disabled={Boolean(activeThreadId) && isStreaming && streamingThreadIdRef.current === activeThreadId}
                title={responseLanguage === 'ko' ? preset.promptKo : preset.promptEn}
              >
                {responseLanguage === 'ko' ? preset.labelKo : preset.labelEn}
              </button>
            ))}
            {/*
              코린이모드 기본 화면에서는 복잡한 진단/계획/분기 버튼을 숨깁니다.
              필요하면 설정 패널이나 입력 프리셋에서 다시 노출할 수 있도록 로직은 보존합니다.
            */}
          </div>
        </div>
      )}

      <div className="ah-backend-jobs">
        <div className="ah-backend-jobs-title">
          <TerminalIcon size={12} />
          <span>{uiText.backendJobs}</span>
        </div>
        <div className="ah-backend-jobs-list">
          {visibleBackendJobs.length === 0 ? (
            <span className="ah-backend-job-empty">{uiText.noBackendJobs}</span>
          ) : visibleBackendJobs.map(job => (
            <div key={job.id} className={`ah-backend-job ah-backend-job-${job.status}`} title={job.workDir || ''}>
              {job.status === 'running' ? <Loader2 size={11} className="ah-spin" /> : job.status === 'completed' ? <CheckCircle2 size={11} /> : <X size={11} />}
              <strong>{job.label}</strong>
              <span>{formatBackendJobStatus(job.status)}</span>
              {job.workDir && <code>{job.workDir.split('/').filter(Boolean).slice(-1)[0] || job.workDir}</code>}
            </div>
          ))}
        </div>
      </div>

      {showNewChatProjectPicker && (
        <div className="ah-project-picker-backdrop" onClick={() => setShowNewChatProjectPicker(false)}>
          <div className="ah-project-picker" onClick={e => e.stopPropagation()}>
            <div className="ah-project-picker-header">
              <span>{uiText.startReadyTitle}</span>
              <button className="btn-top-small" onClick={() => setShowNewChatProjectPicker(false)} title={responseLanguage === 'ko' ? '닫기' : 'Close'}><X size={12} /></button>
            </div>
            <div className="ah-project-picker-note">
              {responseLanguage === 'ko'
                ? '앱 이름만 쓰면 시작합니다. 처음 한 번만 앱을 모아둘 곳을 정하면 돼요.'
                : 'You do not need to know how to code. Korini Mode checks open and nearby projects, then starts with easy questions.'}
            </div>
            {!effectiveKoriniBaseFolder ? (
              <div className="ah-korini-base-folder">
                <label className="ah-project-picker-field ah-project-path-field">
                  <span>Where to keep my apps</span>
                  <input
                    value={koriniBaseFolder}
                    onChange={(event) => setKoriniBaseFolder(event.target.value)}
                    placeholder={suggestedKoriniBaseFolder}
                  />
                </label>
                <button
                  className="ah-project-picker-primary"
                  onClick={() => setKoriniBaseFolder(koriniBaseFolder.trim() || suggestedKoriniBaseFolder)}
                >
                  Use this folder
                </button>
                <p className="ah-project-picker-help">If unsure, just press `Use this folder`.</p>
              </div>
            ) : (
              <>
                <div className="ah-korini-base-summary">
                  <span>App folder</span>
                  <strong>{effectiveKoriniBaseFolder}</strong>
                </div>
                <label className="ah-project-picker-field ah-project-path-field">
                  <span>App name</span>
                  <input
                    value={projectNameInput}
                    onChange={(event) => setProjectNameInput(event.target.value)}
                    placeholder="e.g. neighborhood-booking"
                  />
                </label>
                <div className="ah-name-examples">
                  {['booking-app', 'online-store', 'academy-site'].map(name => (
                    <button key={name} onClick={() => setProjectNameInput(name)}>{name}</button>
                  ))}
                </div>
                <button
                  className="ah-project-picker-primary"
                  onClick={() => customProjectTarget && startThreadAtTarget(customProjectTarget)}
                  disabled={!customProjectTarget}
                >
                  Start
                </button>
                {projectNameInput.trim() && !customProjectTarget && (
                  <p className="ah-project-picker-help">The app name must contain at least one letter or number.</p>
                )}
                <details className="ah-advanced-setup ah-project-picker-advanced">
                  <summary>Change app folder</summary>
                  <label className="ah-project-picker-field">
                    <span>Where to keep my apps</span>
                    <input
                      value={koriniBaseFolder}
                      onChange={(event) => setKoriniBaseFolder(event.target.value)}
                      placeholder={suggestedKoriniBaseFolder}
                    />
                  </label>
                </details>
              </>
            )}
            <details className="ah-advanced-setup ah-project-picker-advanced">
              <summary>Advanced settings (optional)</summary>
              <div className="ah-project-picker-models">
                <label className="ah-project-picker-field">
                  <span>{uiText.defaultProvider}</span>
                  <select value={providerGroup} onChange={(event) => setProviderGroup(event.target.value as 'atlascloud' | 'cli' | 'ollama')}>
                    <option value="atlascloud">{responseLanguage === 'ko' ? '클라우드 자동 작업 (권장)' : 'Cloud coding (recommended)'}</option>
                    <option value="cli">{responseLanguage === 'ko' ? '내 컴퓨터 도구 사용' : 'Use local coding tool'}</option>
                    <option value="ollama">{responseLanguage === 'ko' ? '내 컴퓨터 Ollama 사용' : 'Use local Ollama'}</option>
                  </select>
                </label>
                {providerGroup === 'atlascloud' && (
                  <label className="ah-project-picker-field">
                    <span>{responseLanguage === 'ko' ? '작업 엔진' : 'Coding model'}</span>
                    <select value={atlasModel} onChange={(event) => updateAtlasModel(event.target.value)}>
                      {atlasModelOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
                {providerGroup === 'cli' && (
                  <label className="ah-project-picker-field">
                    <span>{responseLanguage === 'ko' ? '내 컴퓨터 도구' : 'Local coding tool'}</span>
                    <select value={cliKind} onChange={(event) => setCliKind(event.target.value as AiProvider)}>
                      <option value="claude-cli">Claude CLI</option>
                      <option value="codex-cli">Codex CLI</option>
                      <option value="kimi-cli">Kimi CLI</option>
                      <option value="gemini-cli">Gemini CLI</option>
                      <option value="qwen-cli">Qwen CLI</option>
                    </select>
                  </label>
                )}
                {providerGroup === 'ollama' && (
                  <label className="ah-project-picker-field">
                    <span>{responseLanguage === 'ko' ? '로컬 모델' : 'Local model'}</span>
                    <select value={ollamaModel} onChange={(event) => updateOllamaModel(event.target.value)}>
                      {Array.from(new Set([ollamaModel, ...ollamaModels])).filter(Boolean).map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </details>
            <details className="ah-advanced-setup ah-project-picker-advanced">
              <summary>Open an existing app</summary>
              <div className="ah-project-picker-list">
                {koriniProjectTargets.map(target => (
                  <button
                    key={target.id}
                    className="ah-project-picker-item"
                    onClick={() => startThreadAtTarget(target)}
                    title={target.workDir}
                  >
                    <span className="ah-project-picker-icon">{target.icon}</span>
                    <span className="ah-project-picker-main">
                      <strong>{target.displayName || target.name}</strong>
                      <span>{target.workDir}</span>
                      {target.source === 'suggested' && (
                        <em className="ah-project-picker-badge">
                          {responseLanguage === 'ko' ? (target.reason || '찾은 프로젝트') : (target.reason || 'Found nearby')}
                        </em>
                      )}
                    </span>
                  </button>
                ))}
                {koriniProjectTargets.length === 0 && (
                  <div className="ah-project-picker-empty">
                    <TerminalIcon size={16} />
                    <span className="ah-project-picker-main">
                      <strong>No apps built with Korini Mode yet</strong>
                      <span>If this is your first time, start by creating a new one.</span>
                    </span>
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>
      )}

      <div className="agent-harness-body">
        {/* Thread list */}
        <div className={`agent-harness-threads${showThreads ? '' : ' collapsed'}`}>
          {threads.map(t => (
            <div key={t.id} className={`ah-thread-item${t.id === activeThreadId ? ' active' : ''}`}
              onClick={() => { setSubTasks(t.subTasks || []); setActiveThreadId(t.id); setErrorTracked(null); setFollowups([]); setPendingSpecReview(null); setPendingPlanReview(null); setStreamingContent(''); setStreamingThinking(''); }}>
              <MessageSquare size={11} style={{ marginRight: 6, flexShrink: 0, opacity: 0.5 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
              <span className="ah-thread-delete" onClick={(e) => { e.stopPropagation(); deleteThread(t.id, activeThreadId); }}>
                <Trash2 size={11} />
              </span>
            </div>
          ))}
          <button className="ah-new-thread-btn" onClick={() => openNewChatProjectPicker()}>
            <Plus size={11} /> {uiText.newChat}
          </button>
          {threads.length === 0 && <div style={{ padding: 12, opacity: 0.3, fontSize: 11, textAlign: 'center' }}>{uiText.noThreads}</div>}
          {threads.length > 0 && (
            <button className="ah-clear-all-btn" onClick={() => { setThreads([]); setActiveThreadId(null); setSubTasks([]); setPendingSpecReview(null); setPendingPlanReview(null); setFollowups([]); void Promise.all(harnessProjectStateWorkDirs.map(workDir => clearHarnessProjectState(workDir))).catch(() => {}); }}>
              <Trash2 size={10} /> {responseLanguage === 'ko' ? '모두 비우기' : 'Clear All'}
            </button>
          )}
        </div>

        {/* Main chat */}
        <div className="agent-harness-main">
          {!activeThread ? (
            <>
              <div className="ah-messages ah-empty-chat">
                <div className="ah-empty-chat-center">
                  <MessageSquare size={26} />
                  <span>Just say what you want to build or fix.</span>
                </div>
              </div>
              {renderChatComposer()}
            </>
          ) : (
            <>
              {/* Messages */}
              <div className="ah-messages" ref={messagesScrollRef}>
                {activeThread.messages.map((msg, idx) => {
                  const prevMsg = idx > 0 ? activeThread.messages[idx - 1] : null;
                  const isGrouped = prevMsg && prevMsg.role === msg.role;
                  return (
                  <div key={msg.id} className={`ah-msg ${msg.role === 'human' ? 'human' : 'ai'}${isGrouped ? ' grouped' : ''}`}>
                    {!isGrouped && (
                      <div className={`ah-msg-avatar ${msg.role === 'human' ? 'human' : 'ai'}`}>
                        {msg.role === 'human' ? '👤' : <DeerOctoLogo size={20} color={style.accent} />}
                      </div>
                    )}
                    {isGrouped && <div className="ah-msg-avatar-spacer" />}
                    <div className="ah-msg-body">
                      {/* Chain of Thought */}
                      {(msg.thinking || (msg.toolCalls && msg.toolCalls.length > 0)) && (
                        <div className="ah-cot">
                          <div className="ah-cot-toggle" onClick={() => setShowThinking(v => !v)}>
                            <span className="ah-cot-chevron">{showThinking ? '∧' : '∨'}</span>
                            <span>{msg.toolCalls?.length || 0} {uiText.steps}{msg.thinking ? ` + ${uiText.reasoning}` : ''}</span>
                          </div>
                          {showThinking && (
                            <div className="ah-cot-content">
                              {msg.thinking && (
                                <div className="ah-cot-step">
                                  <Brain size={12} className="ah-cot-icon" />
                                  <div className="ah-cot-step-text">{msg.thinking}</div>
                                </div>
                              )}
                              {msg.toolCalls?.map(tc => (
                                <div key={tc.id} className={`ah-cot-step ${tc.status}`}>
                                  <span className="ah-cot-icon">
                                    {tc.status === 'done' ? <CheckCircle2 size={12} style={{ color: '#4caf50' }} /> :
                                     tc.status === 'error' ? <X size={12} style={{ color: '#e53935' }} /> :
                                     <Loader2 size={12} className="ah-spin" />}
                                  </span>
                                  <div className="ah-cot-step-body">
                                    <div className="ah-cot-step-header">
                                      <span className="ah-cot-tool-icon">
                                        {tc.name === 'web_search' ? <Globe size={11} /> :
                                         tc.name === 'web_fetch' ? <Globe size={11} /> :
                                         tc.name === 'read_file' ? <FileCode size={11} /> :
                                         tc.name === 'write_file' ? <FileCode size={11} /> :
                                         tc.name === 'bash' ? <TerminalIcon size={11} /> :
                                         tc.name === 'ls' ? <Search size={11} /> :
                                         tc.name === 'grep' ? <Search size={11} /> :
                                         tc.name === 'ask_user' ? <MessageSquare size={11} /> :
                                         <Sparkles size={11} />}
                                      </span>
                                      <strong>{tc.name}</strong>
                                      <span className="ah-cot-tool-args">{tc.args.slice(0, 60)}</span>
                                    </div>
                                    {tc.result && (
                                      <div className="ah-cot-step-result">{tc.result.slice(0, 200)}</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {/* Generated images */}
                      {msg.images && msg.images.length > 0 && (
                        <div className="ah-generated-images">
                          {msg.images.map((img, idx) => (
                            <img key={idx} src={img} alt={`Generated ${idx + 1}`} className="ah-gen-img"
                              onClick={() => window.open(img, '_blank')} />
                          ))}
                        </div>
                      )}
                      {/* Artifact file cards */}
                      {msg.artifacts && msg.artifacts.length > 0 && (
                        <div className="ah-file-cards">
                          {msg.artifacts.map(a => (
                            <div key={a.id} className="ah-file-card"
                              onClick={() => { setSelectedArtifact(a); setShowArtifacts(true); }}>
                              <div className="ah-file-card-icon">
                                <FileCode size={20} />
                              </div>
                              <div className="ah-file-card-info">
                                <div className="ah-file-card-name">{a.filename}</div>
                                <div className="ah-file-card-type">{a.language} file</div>
                              </div>
                              <button className="ah-file-card-dl" title="Download"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const blob = new Blob([a.content], { type: 'text/plain' });
                                  const url = URL.createObjectURL(blob);
                                  const el = document.createElement('a'); el.href = url; el.download = a.filename;
                                  el.click(); URL.revokeObjectURL(url);
                                }}>
                                <Download size={14} /> Download
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Content */}
                      <div className="ah-msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                      {/* Meta + actions */}
                      <div className="ah-msg-meta">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                        {msg.durationMs != null && ` · ${(msg.durationMs / 1000).toFixed(1)}s`}
                        {msg.tokenUsage && ` · ${formatTokenUsage(msg.tokenUsage)}`}
                        {msg.role === 'assistant' && (
                          <>
                            <span style={{ marginLeft: 8, cursor: 'pointer', opacity: 0.6 }}
                              onClick={() => copyMessage(msg)} title="Copy">
                              {copiedId === msg.id ? <Check size={10} /> : <Copy size={10} />}
                            </span>
                            <span style={{ marginLeft: 4, cursor: 'pointer', opacity: 0.6 }}
                              onClick={() => addMemory(msg.content.slice(0, 300), activeThread.title)}
                              title="Save to memory">
                              <BookOpen size={10} />
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}

                {/* Sub-task cards (Ultra mode) */}
                {visibleSubTasks.length > 0 && (
                  <div className="ah-subtasks">
                    <div className="ah-subtasks-header">
                      <Crown size={12} />
                      <span>{uiText.subagents} ({subAgentProgress.completed}/{subAgentProgress.total})</span>
                      {subAgentProgress.failed > 0 && <em>{subAgentProgress.failed} failed</em>}
                      {subAgentProgress.running && <strong>{subAgentProgress.running.provider.replace('-cli', '')} running</strong>}
                    </div>
                    {visibleSubTasks.map((st, index) => (
                      <div key={st.id} className={`ah-subtask-card ${st.status}`}>
                        <div className="ah-subtask-header">
                          <span className="ah-subtask-status-icon">
                            {st.status === 'completed' ? <CheckCircle2 size={12} /> :
                             st.status === 'failed' ? <X size={12} /> :
                             st.status === 'running' ? <Loader2 size={12} className="ah-spin" /> :
                             <Circle size={12} />}
                          </span>
                          <span className="ah-subtask-index">{index + 1}</span>
                          <span className="ah-subtask-desc">{st.description}</span>
                          <span className="ah-subtask-provider">{st.provider.replace('-cli', '')}</span>
                          {st.durationMs != null && (
                            <span className="ah-subtask-time">{(st.durationMs / 1000).toFixed(1)}s</span>
                          )}
                        </div>
                        {st.status === 'completed' && st.result && (
                          <details className="ah-subtask-result">
                            <summary>View result</summary>
                            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(st.result) }} />
                          </details>
                        )}
                        {st.status === 'failed' && st.error && (
                          <div className="ah-subtask-error">{st.error}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {pendingSpecReview && (
                  <div className="ah-spec-review">
                    <div className="ah-decompose-header">
                      <Crown size={14} />
                      <span>{responseLanguage === 'ko' ? '추천 방향을 골라뒀어요' : 'Recommended direction is ready'}</span>
                    </div>
                    <div className="ah-spec-review-note">
                      {responseLanguage === 'ko'
                        ? '옵션은 자주 보여드릴게요. 잘 모르겠으면 추천 표시가 붙은 걸 그대로 누르면 됩니다.'
                        : 'Options are shown often. If unsure, choose the recommended one.'}
                    </div>
                    <div className="ah-option-card-grid">
                    {pendingSpecReview.options.map((option, optionIndex) => {
                      const selected = pendingSpecReview.selectedIds.includes(option.id);
                      return (
                        <label key={option.id} className={`ah-spec-option${selected ? ' selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {
                              setPendingSpecReview(prev => {
                                if (!prev) return prev;
                                return { ...prev, selectedIds: harnessRuntime.selection.toggleSelectionId(prev.selectedIds, option.id) };
                              });
                            }}
                          />
                          <div className="ah-spec-option-body">
                            <div className="ah-spec-option-title">
                              {optionIndex === 0 && <em>Recommended</em>}
                              {option.title}
                            </div>
                            {option.summary && <div className="ah-spec-option-summary">{option.summary}</div>}
                            {option.spec && <details className="ah-option-detail"><summary>Details</summary><div>{option.spec}</div></details>}
                          </div>
                        </label>
                      );
                    })}
                    </div>
                    <div className="ah-decompose-actions">
                      <button
                        className="ah-decompose-run"
                        onClick={() => void executeSelectedSpecReview()}
                        disabled={pendingSpecReview.selectedIds.length === 0}
                      >
                        {responseLanguage === 'ko' ? '추천대로 계속' : 'Continue with recommendation'}
                      </button>
                      <button className="ah-decompose-cancel" onClick={() => setPendingSpecReview(null)}>
                        {uiText.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {pendingPlanReview && (
                  <div className="ah-spec-review">
                    <div className="ah-decompose-header">
                      <Crown size={14} />
                      <span>{responseLanguage === 'ko' ? '이 순서로 만들게요' : 'Build order is ready'}</span>
                    </div>
                    <div className="ah-spec-review-note">
                      {responseLanguage === 'ko'
                        ? '만드는 방법도 옵션으로 자주 보여드릴게요. 추천 표시가 붙은 계획이 기본입니다.'
                        : 'Build plans are shown as options. The recommended one is the default.'}
                    </div>
                    {selectedPlanOptionChips.length > 0 && (
                      <div className="ah-followups" style={{ marginBottom: 12 }}>
                        {selectedPlanOptionChips.map((option) => (
                          <span key={option.id} className="ah-suggestion-chip" style={{ cursor: 'default' }}>
                            {option.title}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="ah-option-card-grid">
                    {pendingPlanReview.options.map((option, optionIndex) => {
                      const selected = pendingPlanReview.selectedIds.includes(option.id);
                      return (
                        <label key={option.id} className={`ah-spec-option${selected ? ' selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {
                              setPendingPlanReview(prev => {
                                if (!prev) return prev;
                                return { ...prev, selectedIds: harnessRuntime.selection.toggleSelectionId(prev.selectedIds, option.id) };
                              });
                            }}
                          />
                          <div className="ah-spec-option-body">
                            <div className="ah-spec-option-title">
                              {optionIndex === 0 && <em>Recommended</em>}
                              {option.title}
                            </div>
                            {option.summary && <div className="ah-spec-option-summary">{option.summary}</div>}
                            {option.spec && <details className="ah-option-detail"><summary>Details</summary><div>{option.spec}</div></details>}
                          </div>
                        </label>
                      );
                    })}
                    </div>
                    <div className="ah-decompose-actions">
                      <button
                        className="ah-decompose-run"
                        onClick={() => void executeSelectedPlanReview()}
                        disabled={pendingPlanReview.selectedIds.length === 0}
                      >
                        {responseLanguage === 'ko' ? '이대로 만들기' : 'Build this'}
                      </button>
                      <button className="ah-decompose-cancel" onClick={() => setPendingPlanReview(null)}>
                        {uiText.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {activeThread?.runState?.status === 'running' && !(isStreaming && streamingThreadIdRef.current === activeThreadId) && (
                  <div className={`ah-run-status ah-run-status-${activeThread.runState.status}`}>
                    <div className="ah-run-status-main">
                      {activeThread.runState.status === 'running' ? (
                        <Loader2 size={13} className="ah-spin" />
                      ) : activeThread.runState.status === 'completed' ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <X size={13} />
                      )}
                      <span>{uiText.lastRun}</span>
                      <strong>
                        {activeThread.runState.status === 'running'
                          ? uiText.running
                          : activeThread.runState.status === 'completed'
                            ? uiText.runCompleted
                            : activeThread.runState.status === 'stopped'
                              ? uiText.runStopped
                              : uiText.runFailed}
                      </strong>
                      {activeThread.runState.completedAt && (
                        <span className="ah-run-elapsed">
                          {Math.max(0, Math.round((activeThread.runState.completedAt - activeThread.runState.startedAt) / 1000))}s
                        </span>
                      )}
                    </div>
                    <div className="ah-run-status-sub">
                      <span>{activeThread.runState.targetProjectName || activeThread.targetProjectName || projectName || 'Project'}</span>
                      <code>{responseLanguage === 'ko' ? '처리 방식' : 'engine'}: {activeThread.runState.model || engineDetailLabel}</code>
                      {(activeThread.runState.targetWorkDir || activeThread.targetWorkDir) && (
                        <code>{activeThread.runState.targetWorkDir || activeThread.targetWorkDir}</code>
                      )}
                    </div>
                    {(activeThread.runState.error || activeThread.runState.progressText) && (
                      <div className="ah-run-status-progress">
                        {activeThread.runState.error || activeThread.runState.progressText}
                      </div>
                    )}
                  </div>
                )}

                {/* Streaming with timer */}
                {isStreaming && streamingThreadIdRef.current === activeThreadId && (
                  <>
                    <div className="ah-run-status">
                      <div className="ah-run-status-main">
                        <Loader2 size={13} className="ah-spin" />
                        <span>{uiText.running}</span>
                        <strong>{engineChoiceLabel}</strong>
                        <RunElapsed />
                        <button className="ah-run-pause-btn" onClick={handleStop}>
                          {responseLanguage === 'ko' ? '잠깐 멈추기' : 'Pause'}
                        </button>
                      </div>
                      <div className="ah-run-status-sub">
                        <span>{activeThreadProjectTarget?.displayName || activeThreadProjectTarget?.name || projectName || 'Project'}</span>
                        <code>{responseLanguage === 'ko' ? '처리 방식' : 'engine'}: {activeThread?.runState?.model || engineDetailLabel}</code>
                        {effectiveWorkDir && <code>{effectiveWorkDir}</code>}
                      </div>
                      <div className="ah-run-status-progress">
                        {responseLanguage === 'ko'
                          ? '멈춰도 지금까지 한 내용은 남습니다. 나중에 여기서 이어하기로 계속할 수 있어요.'
                          : 'You can pause and resume from this point later.'}
                      </div>
                    </div>
                    <div className="ah-msg ai">
                      <div className="ah-msg-avatar ai"><DeerOctoLogo size={20} color={style.accent} /></div>
                      <div className="ah-msg-body">
                        {streamingThinking && <div className="ah-thinking">{streamingThinking}</div>}
                        {streamingContent ? (
                          <div className="ah-msg-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }} />
                        ) : (
                          <div className="ah-streaming">
                            <span className="ah-streaming-label">{uiText.waitingForCli}</span>
                            <div className="ah-streaming-dot" /><div className="ah-streaming-dot" /><div className="ah-streaming-dot" />
                            <StreamTimer />
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

                {/* Error */}
                {error && <div className="ah-error">{error}</div>}

                <div ref={messagesEndRef} />
              </div>

              {/* Pending decompose — user assigns providers */}

              {pendingDecompose && (
                  <div className="ah-decompose-review">
                  <div className="ah-decompose-header">
                    <Crown size={14} />
                    <span>{uiText.decomposeTitle}</span>
                  </div>
                  {pendingDecompose.map((task, i) => (
                    <div key={i} className="ah-decompose-task">
                      <div className="ah-decompose-desc">{task.description}</div>
                      <select className="ah-decompose-provider"
                        value={task.provider}
                        onChange={e => {
                          const updated = [...pendingDecompose];
                          updated[i] = { ...updated[i], provider: e.target.value as AiProvider };
                          setPendingDecompose(updated);
                        }}>
                        {PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </div>
                  ))}
                  <div className="ah-decompose-actions">
                    <button className="ah-decompose-run" onClick={() => void executeDecomposed(pendingDecompose)}>
                      {uiText.decomposeRun}
                    </button>
                    <button className="ah-decompose-cancel" onClick={() => setPendingDecompose(null)}>
                      {uiText.decomposeCancel}
                    </button>
                  </div>
                  </div>
                )}

              {pendingWorkflowStart && (
                <div className="ah-spec-review">
                  <div className="ah-decompose-header">
                    <Settings2 size={14} />
                    <span>{uiText.preflightTitle}</span>
                  </div>
                  <div className="ah-spec-review-note">
                    {uiText.preflightNote}
                  </div>
                  <div className="ah-workflow-start-card">
                    <div className="ah-orchestration-explain ah-orchestration-explain-compact">
                      <span><strong>Kimi</strong> understands</span>
                      <span><strong>DeepSeek 4</strong> plans/security check</span>
                      <span><strong>Qwen coder</strong> implements</span>
                    </div>
                    <div className="ah-korini-simple-flow">
                      <div className="ah-korini-simple-head">
                        <strong>Here is how it will proceed</strong>
                        <span>No need to know complex settings. If something breaks, it explains in plain language and leaves recovery steps.</span>
                      </div>
                      <div className="ah-korini-step-list">
                        <span><strong>1</strong> Summarize the desired result in plain language</span>
                        <span><strong>2</strong> Pick design principles and patterns, set a safe order</span>
                        <span><strong>3</strong> Write and refactor Next.js code</span>
                        <span><strong>4</strong> Security checks and error fixes at each step</span>
                        <span><strong>5</strong> Leave the web screen, Vercel/Neon docs, and rollback steps</span>
                      </div>
                    </div>
                    <details className="ah-advanced-setup ah-workflow-advanced">
                      <summary>Show advanced settings (optional)</summary>
                      <div className="ah-workflow-presets">
                        {harnessRuntime.workflow.WORKFLOW_PRESETS.map(preset => (
                          <button
                            key={preset.id}
                            className={`ah-workflow-preset${workflow.id === preset.id ? ' active' : ''}`}
                            onClick={() => applyWorkflowPreset(preset)}
                          >
                            {preset.name}
                          </button>
                        ))}
                      </div>
                      <div className="ah-workflow-default-provider">
                        <span>{uiText.defaultProvider}</span>
                        <select
                          value={backgroundProvider}
                          onChange={e => handleBackgroundProviderChange(e.target.value as AiProvider)}
                        >
                          {PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                        </select>
                        <button className="ah-workflow-apply-default" onClick={applyBackgroundProviderToWorkflow}>
                          {uiText.applyAllStages}
                        </button>
                      </div>
                      <div className="ah-workflow-default-provider ah-workflow-model-row">
                        <span>{uiText.model}</span>
                        {backgroundProvider === OLLAMA_PROVIDER ? (
                          <select
                            value={ollamaModel}
                            onChange={e => updateBackgroundModel(e.target.value)}
                          >
                            {ollamaModelOptions.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        ) : (
                          <select
                            value={atlasModel}
                            onChange={e => updateBackgroundModel(e.target.value)}
                          >
                            {atlasModelOptions.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="ah-workflow-default-provider">
                        <span>{uiText.developmentIntensity}</span>
                        <select
                          value={workflow.effort || 'normal'}
                          onChange={e => updateWorkflowEffort(e.target.value as WorkflowEffort)}
                        >
                          <option value="normal">Normal</option>
                          <option value="extreme">More careful</option>
                        </select>
                        <div className="ah-workflow-effort-note">
                          {workflow.effort === 'extreme'
                            ? uiText.effortExtremeStart
                            : uiText.effortNormalStart}
                        </div>
                      </div>
                      <div className="ah-spec-option selected">
                        <div className="ah-spec-option-body">
                          <div className="ah-spec-option-title">{workflow.name}</div>
                          <div className="ah-spec-option-summary">
                            {uiText.stageCount(workflow.stages.filter(stage => stage.enabled).length, workflow.effort)}
                          </div>
                        </div>
                      </div>
                      <div className="ah-workflow-start-list">
                        {workflow.stages.map((stage, i) => (
                          <div key={stage.id} className={`ah-workflow-stage${stage.enabled ? ' active' : ''}`}>
                            <input
                              type="checkbox"
                              checked={stage.enabled}
                              onChange={() => updateWorkflowStage(i, { enabled: !stage.enabled })}
                            />
                            <input
                              className="ah-workflow-stage-name"
                              value={stage.name}
                              onChange={e => updateWorkflowStage(i, { name: e.target.value })}
                            />
                            <select
                              value={stage.provider}
                              onChange={e => {
                                const nextProvider = e.target.value as AiProvider;
                                updateWorkflowStage(i, {
                                  provider: nextProvider,
                                  model: getModelForProvider(nextProvider) || undefined,
                                });
                              }}
                            >
                              {PROVIDER_OPTIONS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                            <select
                              value={stage.promptTemplate}
                              onChange={e => updateWorkflowStage(i, { promptTemplate: e.target.value as WorkflowStage['promptTemplate'] })}
                            >
                              <option value="research">Understand</option>
                              <option value="plan">Plan</option>
                              <option value="implement">Implement</option>
                              <option value="review">Review</option>
                              <option value="custom">Custom</option>
                            </select>
                            <button className="ah-wf-btn" onClick={() => moveStage(i, -1)} disabled={i === 0}><ChevronUp size={10} /></button>
                            <button className="ah-wf-btn" onClick={() => moveStage(i, 1)} disabled={i === workflow.stages.length - 1}><ChevronDown size={10} /></button>
                            <div className="ah-stage-model-row">
                              <span>Model</span>
                              <StageModelDropdown
                                value={stage.model}
                                fallbackModel={getModelForProvider(stage.provider) || 'Default'}
                                options={getModelOptionsForProvider(stage.provider)}
                                onChange={model => updateWorkflowStage(i, { model })}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                      <button className="ah-workflow-add" onClick={addWorkflowStage}><Plus size={10} /> Add step</button>
                    </details>
                  </div>
                  <div className="ah-decompose-actions">
                    <button
                      className="ah-decompose-run"
                      onClick={() => void executePendingWorkflowStart()}
                      disabled={workflow.stages.filter(stage => stage.enabled).length === 0}
                    >
                      {uiText.startWithSettings}
                    </button>
                    <button className="ah-decompose-cancel" onClick={() => { setPendingWorkflowStart(null); setShowWorkflowEditor(false); }}>
                      {uiText.cancel}
                    </button>
                  </div>
                </div>
              )}

              {renderChatComposer()}
            </>
          )}
        </div>

        {/* Resize handle */}
        {showArtifacts && allArtifacts.length > 0 && (
          <div className="ah-resize-handle" onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const panel = (e.target as HTMLElement).nextElementSibling as HTMLElement;
            const startW = panel?.offsetWidth || 300;
            const onMove = (ev: MouseEvent) => {
              const diff = startX - ev.clientX;
              panel.style.width = `${Math.max(200, Math.min(600, startW + diff))}px`;
            };
            const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }} />
        )}

        {/* Artifacts panel */}
        {showArtifacts && allArtifacts.length > 0 && (
          <div className="ah-artifacts">
            <div className="ah-artifacts-header">
              <span>{uiText.artifacts} ({allArtifacts.length})</span>
              <button className="btn-top-small" onClick={() => setShowArtifacts(false)}><X size={11} /></button>
            </div>
            <div className="ah-artifacts-list">
              {allArtifacts.map(a => (
                <div key={a.id} className={`ah-artifact-item${selectedArtifact?.id === a.id ? ' active' : ''}`}
                  onClick={() => setSelectedArtifact(a)}>
                  <FileCode size={12} />
                  <span>{a.filename}</span>
                  <span style={{ opacity: 0.4, fontSize: 10, marginLeft: 'auto' }}>{a.language}</span>
                </div>
              ))}
            </div>
            {selectedArtifact && (
              <div className="ah-artifact-preview-area">
                <div className="ah-artifact-preview-header">
                  <span>{selectedArtifact.filename}</span>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    {/* Code / Preview toggle */}
                    {['html', 'markdown', 'md'].includes(selectedArtifact.language) && (
                      <div className="ah-view-toggle">
                        <button className={`ah-view-btn${artifactView === 'code' ? ' active' : ''}`}
                          onClick={() => setArtifactView('code')} title="Code">{'</>'}</button>
                        <button className={`ah-view-btn${artifactView === 'preview' ? ' active' : ''}`}
                          onClick={() => setArtifactView('preview')} title="Preview"><Eye size={11} /></button>
                      </div>
                    )}
                    <button className="btn-top-small" title="Copy"
                      onClick={() => void navigator.clipboard.writeText(selectedArtifact.content)}>
                      <Copy size={11} />
                    </button>
                    <button className="btn-top-small" title="Download"
                      onClick={() => {
                        const blob = new Blob([selectedArtifact.content], { type: 'text/plain' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); a.href = url; a.download = selectedArtifact.filename;
                        a.click(); URL.revokeObjectURL(url);
                      }}>
                      <Download size={11} />
                    </button>
                    <button className="btn-top-small" title={responseLanguage === 'ko' ? '닫기' : 'Close'} onClick={() => setSelectedArtifact(null)}>
                      <X size={11} />
                    </button>
                  </div>
                </div>
                {artifactView === 'preview' && ['html', 'markdown', 'md'].includes(selectedArtifact.language) ? (
                  selectedArtifact.language === 'html' ? (
                    <iframe className="ah-artifact-iframe" srcDoc={selectedArtifact.content} sandbox="allow-scripts" />
                  ) : (
                    <div className="ah-artifact-md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedArtifact.content) }} />
                  )
                ) : (
                  <pre className="ah-artifact-preview">{selectedArtifact.content}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {/* Memory panel */}
        {showMemory && (
          <div className="ah-memory-panel">
            <div className="ah-memory-header">
              <span>{uiText.memory} ({memories.length})</span>
              <button className="btn-top-small" onClick={() => setShowMemory(false)}><X size={11} /></button>
            </div>
            <div className="ah-memory-input-row">
              <input className="ah-memory-input" placeholder={uiText.addMemory}
                value={memoryInput} onChange={e => setMemoryInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    submitMemoryInput();
                  }
                }} />
              <button className="btn-top-small" onClick={submitMemoryInput}><Plus size={11} /></button>
            </div>
            <div className="ah-memory-list">
              {memories.length === 0 && <div style={{ padding: 12, opacity: 0.3, fontSize: 11, textAlign: 'center' }}>{uiText.emptyMemory}</div>}
              {sortedMemories.map(m => (
                <div key={m.id} className={`ah-memory-item${m.pinned ? ' pinned' : ''}`}>
                  <div className="ah-memory-content">{m.content}</div>
                  <div className="ah-memory-meta">
                    <span>{m.source}</span>
                    <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                    <span className="ah-memory-actions">
                      <button onClick={() => togglePinMemory(m.id)} title={m.pinned ? 'Unpin' : 'Pin'}>
                        {m.pinned ? <PinOff size={10} /> : <Pin size={10} />}
                      </button>
                      <button onClick={() => deleteMemory(m.id)} title="Delete"><Trash2 size={10} /></button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
