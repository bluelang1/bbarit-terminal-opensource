import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Palette, Sparkles, Send, FileText, Newspaper, MessageSquare, ChevronRight, AlertCircle, BookOpen, Film, ShoppingBag, TrendingUp, UserCircle2, Save, Plus, FolderOpen, RefreshCw, FileUp, Trash2, Link2, Youtube, ClipboardList, ImagePlus, Wand2, History, Eye, Download, CheckCircle2, Box, Loader2, Layers } from 'lucide-react';
import { useDesignAgent } from './useDesignAgent';

export interface DesignPanelProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent: string };
  /** Send one complete prompt directly to the active project terminal. */
  onTerminalPrompt?: (prompt: string) => void;
  /** Register/open a prompt markdown file in BBARIT's normal file tabs. */
  onOpenFile?: (path: string) => void;
  /** Current file-tree/editor context for importing source material into design prompts. */
  activeFilePath?: string | null;
  selectedFilePaths?: string[];
  openFilePaths?: string[];
}

type TabId = 'design' | 'image' | 'model3d' | 'blog' | 'cardnews' | 'sns' | 'comic' | 'detail' | 'video' | 'trend' | 'brand' | 'prompts';

const TABS: { id: TabId; label: string; emoji: string; icon: React.ReactNode }[] = [
  { id: 'design',   label: 'Design',   emoji: '🪄', icon: <Palette size={12} /> },
  { id: 'image',    label: 'Image',   emoji: '🖼️', icon: <ImagePlus size={12} /> },
  { id: 'model3d',  label: '3D',       emoji: '🧊', icon: <Box size={12} /> },
  { id: 'blog',     label: 'Blog',   emoji: '📝', icon: <FileText size={12} /> },
  { id: 'cardnews', label: 'Card News', emoji: '🗞️', icon: <Newspaper size={12} /> },
  { id: 'sns',      label: 'SNS',     emoji: '💬', icon: <MessageSquare size={12} /> },
  { id: 'comic',    label: 'Comic',     emoji: '📚', icon: <BookOpen size={12} /> },
  { id: 'detail',   label: 'Detail Page', emoji: '🛍️', icon: <ShoppingBag size={12} /> },
  { id: 'video',    label: 'Ad Video', emoji: '🎬', icon: <Film size={12} /> },
  { id: 'trend',    label: 'All-in-One',     emoji: '📈', icon: <TrendingUp size={12} /> },
  { id: 'brand',    label: 'Brand',   emoji: '🎯', icon: <UserCircle2 size={12} /> },
  { id: 'prompts',  label: 'Prompts', emoji: '📁', icon: <FolderOpen size={12} /> },
];

interface BrandProfile {
  name: string;
  colors: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  neutralColor: string;
  businessType: string;
  businessDesc: string;
  audience: string;
  positioning: string;
  personality: string;
  visualKeywords: string;
  contentPillars: string;
  cta: string;
  rules: string;
  tone: string;
}
const emptyBrand: BrandProfile = {
  name: '',
  colors: '',
  primaryColor: '',
  secondaryColor: '',
  accentColor: '',
  backgroundColor: '',
  textColor: '',
  neutralColor: '',
  businessType: '',
  businessDesc: '',
  audience: '',
  positioning: '',
  personality: '',
  visualKeywords: '',
  contentPillars: '',
  cta: '',
  rules: '',
  tone: '',
};

interface PromptFileEntry {
  name: string;
  path: string;
  is_dir?: boolean;
}

type ImageCodexMode = 'generate' | 'edit';

interface ImageCodexHistoryItem {
  id: string;
  prompt: string;
  mode: ImageCodexMode;
  dataUrl?: string;
  imagePath: string;
  promptPath: string;
  createdAt: number;
}

interface ImageCodexReference {
  id: string;
  name: string;
  dataUrl: string;
  path?: string;
}

interface QuickPromptTemplate {
  id: string;
  label: string;
  fileName: string;
  content: string;
}

type BrandColorRole = 'primaryColor' | 'secondaryColor' | 'accentColor' | 'backgroundColor' | 'textColor' | 'neutralColor';

const BRAND_COLOR_ROLES: { key: BrandColorRole; label: string; fallback: string }[] = [
  { key: 'primaryColor', label: 'Primary', fallback: '#2563eb' },
  { key: 'secondaryColor', label: 'Secondary', fallback: '#14b8a6' },
  { key: 'accentColor', label: 'Accent', fallback: '#f97316' },
  { key: 'backgroundColor', label: 'Background', fallback: '#f8fafc' },
  { key: 'textColor', label: 'Text', fallback: '#111827' },
  { key: 'neutralColor', label: 'Neutral', fallback: '#94a3b8' },
];

function brandSection(b: BrandProfile, profilePath = ''): string {
  const parts: string[] = [];
  if (profilePath.trim()) parts.push(`- 브랜드 MD 파일 절대경로: ${profilePath.trim()}`);
  if (b.name.trim()) parts.push(`- 브랜드명: ${b.name.trim()}`);
  const palette = formatBrandColorPalette(b.colors, b);
  if (palette.trim()) parts.push(`- 브랜드 색상표:\n${palette}`);
  if (b.businessType.trim()) parts.push(`- 업종: ${b.businessType.trim()}`);
  if (b.businessDesc.trim()) parts.push(`- 비즈니스 설명: ${b.businessDesc.trim()}`);
  if (b.audience.trim()) parts.push(`- 핵심 고객: ${b.audience.trim()}`);
  if (b.positioning.trim()) parts.push(`- 포지셔닝: ${b.positioning.trim()}`);
  if (b.personality.trim()) parts.push(`- 브랜드 성격: ${b.personality.trim()}`);
  if (b.visualKeywords.trim()) parts.push(`- 비주얼 키워드: ${b.visualKeywords.trim()}`);
  if (b.contentPillars.trim()) parts.push(`- 콘텐츠 축:\n${b.contentPillars.trim()}`);
  if (b.cta.trim()) parts.push(`- 기본 CTA: ${b.cta.trim()}`);
  if (b.tone.trim()) parts.push(`- 기본 톤: ${b.tone.trim()}`);
  if (b.rules.trim()) parts.push(`- 브랜드 규칙:\n${b.rules.trim()}`);
  return parts.length === 0 ? '' : `\n[브랜드 프로필]\n${parts.join('\n')}\n`;
}

const KINDS = [
  ['general', 'Freeform'], ['landing', 'Landing'], ['cardnews', 'Card News'],
  ['ad-creative', 'Ad'], ['product-detail', 'Detail'], ['app-dashboard', 'Dashboard'],
  ['mobile-app', 'Mobile'], ['desktop-app', 'Desktop'], ['mckinsey-pptx', 'PPTX'],
];
const ASPECT_RATIOS = [['16:9','Landscape'],['9:16','Portrait'],['1:1','Square'],['4:3','Document'],['A4','A4']];
const STYLES = [['','auto'],['editorial','Editorial'],['premium-minimal','Premium'],['bold-retail','Bold'],['magazine','Magazine'],['neon-tech','Neon'],['data-clean','Data']];
const MODEL3D_PROVIDERS = [
  ['auto', 'Auto'],
  ['local-glb', 'Local GLB'],
  ['hyper3d', 'Hyper3D'],
  ['tripo', 'Tripo'],
  ['fal', 'Fal.ai'],
  ['hunyuan', 'Hunyuan3D'],
  ['js-depth', 'JS Depth'],
];
const MODEL3D_STYLES = [
  ['product-studio', 'Product Studio'],
  ['cell-forge', '3DCellForge'],
  ['cinematic', 'Cinematic'],
  ['education', 'Educational'],
  ['web-demo', 'Web Demo'],
];
const TEXT_MATERIAL_EXTS = /\.(md|markdown|txt|text|html?|css|jsx?|tsx?|jsonl?|csv|tsv|ya?ml|xml|svg|log|py|rs|go|java|kt|c|cc|cpp|h|hpp|toml|ini|env)$/i;
const MAX_MATERIAL_CHARS_PER_FILE = 12000;
const MAX_MATERIAL_CHARS_TOTAL = 36000;
const MAX_CRAWLED_TEXT_CHARS = 18000;
const MAX_IMAGE_CODEX_HISTORY = 18;
const MAX_IMAGE_CODEX_REFERENCES = 6;

interface HttpResponseOutput {
  status: number;
  status_text?: string;
  headers?: [string, string][];
  body: string;
  truncated?: boolean;
}

function normalizePromptFileName(name: string): string {
  const cleaned = name.trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const base = cleaned || 'design-prompt';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

function uniqStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((v) => (v || '').trim()).filter(Boolean)));
}

function normalizeHexColor(value: string): string | null {
  const raw = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.split('').map((ch) => `${ch}${ch}`).join('').toLowerCase()}`;
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    return `#${raw.toLowerCase()}`;
  }
  return null;
}

function parseColorPalette(value: string): string[] {
  return uniqStrings(
    value
      .split(/[,\n]/)
      .map((part) => normalizeHexColor(part))
      .filter(Boolean),
  ).slice(0, 16);
}

function serializeColorPalette(colors: string[]): string {
  return uniqStrings(colors.map((color) => normalizeHexColor(color))).join(', ');
}

function formatBrandColorPalette(colors: string, profile?: Partial<BrandProfile>): string {
  const roleLines = profile
    ? BRAND_COLOR_ROLES
      .map(({ key, label }) => {
        const color = normalizeHexColor(profile[key] || '');
        return color ? `  - ${label}: ${color}` : '';
      })
      .filter(Boolean)
    : [];
  const freeColors = parseColorPalette(colors);
  const extra = freeColors.length ? [`  - 추가 색상: ${freeColors.join(', ')}`] : [];
  return [...roleLines, ...extra].join('\n');
}

function colorSummaryFromProfile(profile: Partial<BrandProfile>): string {
  return serializeColorPalette([
    profile.primaryColor || '',
    profile.secondaryColor || '',
    profile.accentColor || '',
    profile.backgroundColor || '',
    profile.textColor || '',
    profile.neutralColor || '',
    ...(profile.colors || '').split(/[,\n]/),
  ]);
}

function brandProfileToMarkdown(profile: Partial<BrandProfile>): string {
  const complete = { ...emptyBrand, ...profile, updatedAt: new Date().toISOString() };
  const palette = formatBrandColorPalette(complete.colors, complete);
  return `# ${complete.name || 'Brand Profile'}

## Brand JSON

\`\`\`json
${JSON.stringify(complete, null, 2)}
\`\`\`

## Summary

- Brand: ${complete.name || ''}
- Business type: ${complete.businessType || ''}
- CTA: ${complete.cta || ''}
- Tone: ${complete.tone || ''}

## Color Palette

${palette || '-'}

## Business

${complete.businessDesc || ''}

## Audience

${complete.audience || ''}

## Positioning

${complete.positioning || ''}

## Personality

${complete.personality || ''}

## Visual Keywords

${complete.visualKeywords || ''}

## Content Pillars

${complete.contentPillars || ''}

## Rules

${complete.rules || ''}
`;
}

function parseBrandProfileContent(raw: string): Partial<BrandProfile> {
  const text = raw.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Partial<BrandProfile>;
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/i);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]) as Partial<BrandProfile>;
      } catch {
        return {};
      }
    }
  }
  return {};
}

function buildIndustryBrandPreset(industryInput: string, brandName: string): Partial<BrandProfile> {
  const industry = industryInput.trim();
  const lower = industry.toLowerCase();
  const name = brandName.trim() || '브랜드';
  const baseRules = [
    '- 모든 디자인은 한 화면에서 핵심 제안이 3초 안에 읽히게 구성',
    '- 주색은 신뢰를 만드는 큰 면과 CTA에 사용하고, 강조색은 클릭/예약/구매 행동에만 제한적으로 사용',
    '- 사진/이미지는 실제 제품, 공간, 사람, 결과물을 먼저 보여주고 추상 장식은 최소화',
    '- 과장된 최상급 표현보다 구체적 혜택, 근거, 고객 상황을 우선',
  ];
  const baseContentPillars = [
    '- 문제 인식: 고객이 지금 겪는 불편을 짧게 언어화',
    '- 해결 제안: 브랜드가 제공하는 핵심 변화와 절차',
    '- 신뢰 근거: 후기, 수치, 사례, 프로세스, 보증',
    '- 행동 유도: 다음 단계가 명확한 CTA',
  ];

  if (/피부|병원|의료|클리닉|치과|성형|헬스케어|웰니스/.test(lower)) {
    return {
      primaryColor: '#0f766e',
      secondaryColor: '#99f6e4',
      accentColor: '#2563eb',
      backgroundColor: '#f8fafc',
      textColor: '#111827',
      neutralColor: '#cbd5e1',
      colors: '#0f766e, #99f6e4, #2563eb, #f8fafc, #111827, #cbd5e1',
      cta: '상담 예약하기',
      tone: '전문적이고 차분하며, 과장 없이 신뢰감을 주는 톤',
      audience: '안전성, 전문성, 실제 개선 사례를 확인하고 싶은 20-50대 고객',
      positioning: `${name}는 과장 광고보다 진단, 절차, 결과의 투명성을 앞세우는 전문 서비스 브랜드`,
      personality: '정돈됨, 청결함, 근거 중심, 섬세함, 안심',
      visualKeywords: '깨끗한 여백, 의료적 신뢰감, 선명한 전후 정보, 부드러운 조명, 안정적인 그리드',
      contentPillars: [...baseContentPillars, '- 전문성: 의료진/장비/프로세스/사후관리'].join('\n'),
      businessDesc: `${industry} 업종의 신뢰 기반 브랜드. 고객이 불안 없이 상담하고 예약할 수 있도록 전문성, 안전성, 사후관리, 실제 사례를 중심으로 설득합니다.`,
      rules: [...baseRules, '- 의료/뷰티 결과는 개인차가 있음을 자연스럽게 반영', '- 공포 조장, 무조건 보장, 과도한 전후 비교 표현 금지'].join('\n'),
    };
  }

  if (/카페|식당|음식|베이커리|디저트|레스토랑|푸드|요식/.test(lower)) {
    return {
      primaryColor: '#7c2d12',
      secondaryColor: '#fed7aa',
      accentColor: '#e11d48',
      backgroundColor: '#fff7ed',
      textColor: '#1f2937',
      neutralColor: '#d6d3d1',
      colors: '#7c2d12, #fed7aa, #e11d48, #fff7ed, #1f2937, #d6d3d1',
      cta: '메뉴 보기',
      tone: '따뜻하고 감각적이며, 맛과 분위기를 생생하게 떠올리게 하는 톤',
      audience: '맛, 공간 분위기, 사진 찍기 좋은 경험을 중시하는 지역 고객과 방문객',
      positioning: `${name}는 메뉴의 매력과 머무는 경험을 함께 파는 라이프스타일 푸드 브랜드`,
      personality: '따뜻함, 생동감, 장인정신, 환대, 감각적',
      visualKeywords: '질감 있는 음식 사진, 따뜻한 조명, 메뉴 클로즈업, 손글씨 느낌의 포인트, 지역성',
      contentPillars: [...baseContentPillars, '- 경험: 맛/향/공간/방문 장면을 구체적으로 묘사'].join('\n'),
      businessDesc: `${industry} 업종의 경험 중심 브랜드. 메뉴의 맛, 재료, 공간 분위기, 방문 이유를 시각적으로 강하게 전달합니다.`,
      rules: [...baseRules, '- 실제 메뉴 사진과 가격/혜택의 가독성 우선', '- 지나친 고급화보다 먹고 싶다는 직관적 욕구를 먼저 설계'].join('\n'),
    };
  }

  if (/saas|소프트웨어|앱|플랫폼|it|ai|테크|개발|툴|솔루션/.test(lower)) {
    return {
      primaryColor: '#2563eb',
      secondaryColor: '#22c55e',
      accentColor: '#f59e0b',
      backgroundColor: '#f8fafc',
      textColor: '#0f172a',
      neutralColor: '#94a3b8',
      colors: '#2563eb, #22c55e, #f59e0b, #f8fafc, #0f172a, #94a3b8',
      cta: '무료로 시작하기',
      tone: '명확하고 자신감 있으며, 생산성 향상을 숫자와 사용 장면으로 설명하는 톤',
      audience: '업무 시간을 줄이고 반복 작업을 자동화하려는 창업자, 마케터, 개발자, 운영팀',
      positioning: `${name}는 복잡한 업무를 빠르게 실행 가능한 결과물로 바꾸는 생산성 플랫폼`,
      personality: '빠름, 똑똑함, 안정적, 실용적, 현대적',
      visualKeywords: '깨끗한 대시보드, 실제 UI 화면, 상태 배지, 성과 수치, 선명한 CTA',
      contentPillars: [...baseContentPillars, '- 제품 증명: 기능 화면, 워크플로우, 시간 절감 수치'].join('\n'),
      businessDesc: `${industry} 업종의 B2B/B2C 디지털 제품 브랜드. 기능보다 사용자가 얻는 시간 절감, 자동화, 결과 품질을 중심으로 설득합니다.`,
      rules: [...baseRules, '- 추상적인 AI 표현보다 실제 화면과 완료 결과를 보여주기', '- 기능 나열은 3개 이하로 줄이고 사용 전후 차이를 강조'].join('\n'),
    };
  }

  if (/교육|학원|강의|코칭|클래스|스쿨|러닝/.test(lower)) {
    return {
      primaryColor: '#4f46e5',
      secondaryColor: '#bae6fd',
      accentColor: '#f97316',
      backgroundColor: '#f8fafc',
      textColor: '#111827',
      neutralColor: '#cbd5e1',
      colors: '#4f46e5, #bae6fd, #f97316, #f8fafc, #111827, #cbd5e1',
      cta: '수강 상담하기',
      tone: '격려하되 체계적이고, 성장 가능성을 구체적 로드맵으로 보여주는 톤',
      audience: '실력 향상, 진로, 성과, 습관 형성을 원하는 학습자와 보호자',
      positioning: `${name}는 막연한 공부를 단계별 성취로 바꾸는 성장 파트너`,
      personality: '친절함, 체계성, 동기부여, 신뢰, 성취감',
      visualKeywords: '단계형 로드맵, 체크리스트, 전후 성장 그래프, 밝은 표정, 명확한 커리큘럼',
      contentPillars: [...baseContentPillars, '- 성장 경로: 커리큘럼, 진단, 피드백, 결과'].join('\n'),
      businessDesc: `${industry} 업종의 학습/성장 브랜드. 고객이 무엇을 배우고 어떻게 달라지는지 구체적인 단계와 결과로 설득합니다.`,
      rules: [...baseRules, '- 막연한 성공보다 커리큘럼/피드백/성과 사례를 제시', '- 부담을 키우는 표현보다 지속 가능한 성장을 강조'].join('\n'),
    };
  }

  return {
    primaryColor: '#111827',
    secondaryColor: '#38bdf8',
    accentColor: '#f97316',
    backgroundColor: '#f8fafc',
    textColor: '#111827',
    neutralColor: '#94a3b8',
    colors: '#111827, #38bdf8, #f97316, #f8fafc, #111827, #94a3b8',
    cta: '문의하기',
    tone: '명확하고 신뢰감 있으며, 고객의 문제를 빠르게 해결해주는 톤',
    audience: `${industry || '해당 업종'}의 구매를 고민하며 신뢰할 수 있는 선택 기준을 찾는 고객`,
    positioning: `${name}는 ${industry || '해당 업종'}에서 복잡한 선택을 쉽게 만들고 실행 가능한 결과를 제공하는 브랜드`,
    personality: '신뢰감, 실용성, 선명함, 전문성, 빠른 실행',
    visualKeywords: '명확한 타이포그래피, 실제 결과물, 비교 가능한 혜택, 정돈된 여백, 강한 CTA',
    contentPillars: baseContentPillars.join('\n'),
    businessDesc: `${industry || '해당 업종'} 브랜드. 고객의 불편, 선택 기준, 구매 이유, 행동 유도를 한 흐름으로 설계합니다.`,
    rules: baseRules.join('\n'),
  };
}

export interface DesignHistoryItem {
  id: string;
  prompt: string;
  paths: string[];
  createdAt: number;
}
const MAX_DESIGN_HISTORY = 30;

function loadDesignHistory(key: string): DesignHistoryItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is DesignHistoryItem => (
        typeof item?.id === 'string' &&
        typeof item?.prompt === 'string' &&
        Array.isArray(item?.paths) &&
        typeof item?.createdAt === 'number'
      ))
      .slice(0, MAX_DESIGN_HISTORY);
  } catch {
    return [];
  }
}

function saveDesignHistory(key: string, items: DesignHistoryItem[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(0, MAX_DESIGN_HISTORY)));
  } catch {
    /* ignore quota errors */
  }
}

function loadImageCodexHistory(key: string): ImageCodexHistoryItem[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ImageCodexHistoryItem => (
        typeof item?.id === 'string' &&
        typeof item?.prompt === 'string' &&
        typeof item?.imagePath === 'string' &&
        typeof item?.promptPath === 'string' &&
        typeof item?.createdAt === 'number'
      ))
      .slice(0, MAX_IMAGE_CODEX_HISTORY);
  } catch {
    return [];
  }
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function truncateMaterial(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n...[${content.length - max}자 생략]`;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  return uniqStrings(matches.map((url) => url.replace(/[),.;]+$/g, '')));
}

function slugifyMaterialName(text: string): string {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9가-힣]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42);
  return cleaned || 'material';
}

function extractReadableTextFromHtml(html: string): { title: string; description: string; text: string } {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript, svg, canvas, iframe').forEach((node) => node.remove());
    const title = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || doc.querySelector('title')?.textContent
      || '').trim();
    const description = (doc.querySelector('meta[name="description"]')?.getAttribute('content')
      || doc.querySelector('meta[property="og:description"]')?.getAttribute('content')
      || '').trim();
    const text = (doc.body?.innerText || doc.documentElement?.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return { title, description, text };
  } catch {
    return { title: '', description: '', text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
  }
}

function parseYoutubeId(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace(/^\//, '').split('/')[0] || '';
    if (parsed.searchParams.get('v')) return parsed.searchParams.get('v') || '';
    const shorts = parsed.pathname.match(/\/shorts\/([^/?#]+)/);
    if (shorts?.[1]) return shorts[1];
    const embed = parsed.pathname.match(/\/embed\/([^/?#]+)/);
    if (embed?.[1]) return embed[1];
  } catch { /* ignore */ }
  return '';
}

function dataUrlToBase64(dataUrl: string): { base64: string; ext: string; mime: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  const mime = match?.[1] || 'image/png';
  const base64 = match?.[2] || dataUrl.replace(/^data:[^;]+;base64,/, '');
  const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  return { base64, ext, mime };
}

function imageMimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(path);
}

function readBrowserImageFile(file: File): Promise<ImageCodexReference | null> {
  if (!file.type.startsWith('image/')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      resolve(dataUrl ? {
        id: `image-ref-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        dataUrl,
      } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function collectMediaStrings(value: unknown, kind: 'image' | 'video', keyHint = ''): string[] {
  const out: string[] = [];
  const key = keyHint.toLowerCase();
  if (typeof value === 'string') {
    const text = value.trim();
    if (kind === 'image' && /^data:image\//i.test(text)) out.push(text);
    else if (kind === 'video' && /^data:video\//i.test(text)) out.push(text);
    else if (/^https?:\/\//i.test(text) && (
      kind === 'image'
        ? /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(text)
        : /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(text)
    )) out.push(text);
    else if (
      text.length > 400 &&
      /^[a-z0-9+/=\s]+$/i.test(text) &&
      (kind === 'image' ? /image|png|jpg|jpeg|webp|base64|asset/.test(key) : /video|mp4|mov|webm|base64|asset/.test(key))
    ) {
      out.push(`${kind === 'image' ? 'data:image/png' : 'data:video/mp4'};base64,${text.replace(/\s+/g, '')}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => out.push(...collectMediaStrings(item, kind, keyHint)));
  } else if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => {
      out.push(...collectMediaStrings(child, kind, childKey));
    });
  }
  return uniqStrings(out);
}

export function DesignPanel({ projectRoot, theme, onTerminalPrompt, onOpenFile, activeFilePath, selectedFilePaths = [], openFilePaths = [] }: DesignPanelProps) {
  const [tab, setTab] = useState<TabId>('design');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // ─── Design ───
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState('general');
  const [aspect, setAspect] = useState('16:9');
  const [style, setStyle] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandColors, setBrandColors] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [editInstruction, setEditInstruction] = useState('');
  const [targetFile, setTargetFile] = useState('');

  // ─── 3D model workflow (3DCellForge-inspired, MD-first) ───
  const [model3dPrompt, setModel3dPrompt] = useState('');
  const [model3dProvider, setModel3dProvider] = useState('auto');
  const [model3dStyle, setModel3dStyle] = useState('product-studio');
  const [model3dReferencePath, setModel3dReferencePath] = useState('');
  const [model3dOutputName, setModel3dOutputName] = useState('');

  // ─── Blog/Cardnews/SNS ───
  const [blogTopic, setBlogTopic] = useState('');
  const [blogTone, setBlogTone] = useState('전문가, 신뢰감 있는 톤');
  const [cnTopic, setCnTopic] = useState('');
  const [cnSlides, setCnSlides] = useState(5);
  const [snsTopic, setSnsTopic] = useState('');
  const [snsPlatform, setSnsPlatform] = useState('instagram');

  // ─── Comic/Detail/Video/Trend ───
  const [comicTopic, setComicTopic] = useState('');
  const [comicPanels, setComicPanels] = useState(4);
  const [detailProduct, setDetailProduct] = useState('');
  const [detailHighlights, setDetailHighlights] = useState('');
  const [videoTopic, setVideoTopic] = useState('');
  const [videoSeconds, setVideoSeconds] = useState(30);
  const [trendKeyword, setTrendKeyword] = useState('');
  const [trendBody, setTrendBody] = useState('');
  const [sharedMaterial, setSharedMaterial] = useState('');
  const [materialPaths, setMaterialPaths] = useState<string[]>([]);
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialSource, setMaterialSource] = useState('');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [mediaApiUrl, setMediaApiUrl] = useState('');
  const [mediaApiKeyEnv, setMediaApiKeyEnv] = useState('MAKEKE_MEDIA_API_KEY');
  const [mediaBusy, setMediaBusy] = useState(false);

  // ─── Brand profile (project-shared, auto-injected into every prompt) ───
  const [brand, setBrand] = useState<BrandProfile>(emptyBrand);
  const [brandDirty, setBrandDirty] = useState(false);
  const [brandFiles, setBrandFiles] = useState<PromptFileEntry[]>([]);
  const [activeBrandPath, setActiveBrandPath] = useState('');
  const [newBrandName, setNewBrandName] = useState('');
  const brandProfilePath = useMemo(() => {
    const root = projectRoot.replace(/\/$/, '');
    return root ? `${root}/makeke/brand-profile.md` : '';
  }, [projectRoot]);
  const brandDir = useMemo(() => {
    const root = projectRoot.replace(/\/$/, '');
    return root ? `${root}/makeke/brands` : '';
  }, [projectRoot]);
  const promptDir = useMemo(() => {
    const root = projectRoot.replace(/\/$/, '');
    return root ? `${root}/makeke/prompts` : '';
  }, [projectRoot]);
  const imageCodexHistoryKey = useMemo(() => {
    const root = projectRoot.replace(/\/$/, '') || 'global';
    return `octo-makeke-image-codex-history:${root}`;
  }, [projectRoot]);
  const [promptFiles, setPromptFiles] = useState<PromptFileEntry[]>([]);
  const [activePromptPath, setActivePromptPath] = useState('');
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [newPromptName, setNewPromptName] = useState('design-prompt');
  const [imageCodexMode, setImageCodexMode] = useState<ImageCodexMode>('generate');
  const [imageCodexPrompt, setImageCodexPrompt] = useState('');
  const [imageCodexFileName, setImageCodexFileName] = useState('');
  const [imageCodexBusy, setImageCodexBusy] = useState(false);
  const [imageCodexHistory, setImageCodexHistory] = useState<ImageCodexHistoryItem[]>(() => loadImageCodexHistory(imageCodexHistoryKey));
  const [selectedImageCodexId, setSelectedImageCodexId] = useState<string | null>(() => loadImageCodexHistory(imageCodexHistoryKey)[0]?.id ?? null);
  const [lastSavedImageCodexId, setLastSavedImageCodexId] = useState<string | null>(null);
  const [imageCodexRefs, setImageCodexRefs] = useState<ImageCodexReference[]>([]);
  const imageCodexFileInputRef = useRef<HTMLInputElement>(null);

  // Send a multi-line prompt directly to the active terminal. The CLI inside it
  // (claude / codex / gemini / kimi / ollama) processes it and writes the result file.
  const sendPrompt = useCallback((p: string) => {
    onTerminalPrompt?.(p.replace(/\r?\n/g, '\n'));
  }, [onTerminalPrompt]);

  // ── Design Studio: agent-driven generate → live preview → iterate loop ──
  const designAgent = useDesignAgent(projectRoot, 'design-panel');
  const [variationCount, setVariationCount] = useState(1);
  const designHistoryKey = useMemo(() => {
    const root = projectRoot.replace(/\/$/, '') || 'global';
    return `octo-makeke-design-history:${root}`;
  }, [projectRoot]);
  const [designHistory, setDesignHistory] = useState<DesignHistoryItem[]>(() => loadDesignHistory(designHistoryKey));
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(() => loadDesignHistory(designHistoryKey)[0]?.id ?? null);
  const [previewNonce, setPreviewNonce] = useState(0);
  useEffect(() => {
    const items = loadDesignHistory(designHistoryKey);
    setDesignHistory(items);
    setSelectedDesignId(items[0]?.id ?? null);
  }, [designHistoryKey]);
  const pushDesignHistory = useCallback((item: DesignHistoryItem) => {
    setDesignHistory((prev) => {
      const next = [item, ...prev].slice(0, MAX_DESIGN_HISTORY);
      saveDesignHistory(designHistoryKey, next);
      return next;
    });
    setSelectedDesignId(item.id);
  }, [designHistoryKey]);
  const selectedDesign = designHistory.find((d) => d.id === selectedDesignId) || designHistory[0] || null;

  const selectedImageCodexItem = imageCodexHistory.find((item) => item.id === selectedImageCodexId) || imageCodexHistory[0] || null;
  const selectedImageCodexSrc = selectedImageCodexItem?.dataUrl || (selectedImageCodexItem?.imagePath ? convertFileSrc(selectedImageCodexItem.imagePath) : '');

  useEffect(() => {
    const history = loadImageCodexHistory(imageCodexHistoryKey);
    setImageCodexHistory(history);
    setSelectedImageCodexId(history[0]?.id ?? null);
    setImageCodexMode(history.length > 0 ? 'edit' : 'generate');
    setImageCodexRefs([]);
  }, [imageCodexHistoryKey]);

  useEffect(() => {
    try {
      localStorage.setItem(imageCodexHistoryKey, JSON.stringify(imageCodexHistory.slice(0, MAX_IMAGE_CODEX_HISTORY)));
    } catch {
      // Large data URLs can exceed localStorage. The current session still keeps the in-memory history.
    }
  }, [imageCodexHistory, imageCodexHistoryKey]);

  const applyBrandProfile = useCallback((next: Partial<BrandProfile>, path = '') => {
    const profile = { ...emptyBrand, ...next };
    setBrand(profile);
    setBrandName(profile.name);
    setBrandColors(colorSummaryFromProfile(profile));
    setCtaText(profile.cta);
    setActiveBrandPath(path);
    setBrandDirty(false);
  }, []);

  const updateBrand = useCallback((patch: Partial<BrandProfile>) => {
    setBrand((prev) => ({ ...prev, ...patch }));
    setBrandDirty(true);
  }, []);

  const refreshBrandFiles = useCallback(async () => {
    if (!brandDir) return;
    try {
      await invoke('create_directory', { path: brandDir });
      const entries = await invoke<PromptFileEntry[]>('read_directory', { path: brandDir });
      setBrandFiles(entries
        .filter((entry) => !entry.is_dir && /\.(md|json)$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      setError(`Failed to load brand list: ${err}`);
    }
  }, [brandDir]);

  const fillBrandFromIndustry = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    if (!brandProfilePath || !brandDir) { setError('Could not create a brand save path.'); return; }
    if (!onTerminalPrompt) { setError('Cannot send to the active terminal. Please open a Codex terminal first.'); return; }
    const displayName = brand.name.trim() || newBrandName.trim() || brand.businessType.trim() || 'brand-profile';
    if (!brand.name.trim() && !newBrandName.trim() && !brand.businessType.trim() && !brand.businessDesc.trim()) {
      setError('Enter at least one of: brand name, industry, or description.');
      return;
    }
    try {
      await invoke('create_directory', { path: brandDir });
      await invoke('create_directory', { path: brandProfilePath.replace(/\/[^/]+$/, '') });
      const brandPath = activeBrandPath && activeBrandPath !== brandProfilePath
        ? activeBrandPath
        : `${brandDir}/${slugifyMaterialName(displayName)}.md`;
      const seedBrand: BrandProfile = {
        ...emptyBrand,
        ...brand,
        name: brand.name.trim() || displayName,
        businessType: brand.businessType.trim(),
        colors: brand.colors.trim() || colorSummaryFromProfile(brand),
      };
      const seedPayload = brandProfileToMarkdown(seedBrand);
      const promptPath = `${brandDir}/${slugifyMaterialName(displayName)}-ai-autofill.prompt.md`;
      const terminalPrompt = `[역할]
당신은 브랜드 전략가이자 시니어 크리에이티브 디렉터입니다. 아래 브랜드 MD 초안을 바탕으로 디자인/이미지/블로그/영상 제작에 바로 쓸 수 있는 상세 브랜드 프로필 Markdown을 완성하세요.

[중요]
- Gemini, Gemini API, NanoBanana를 절대 사용하지 마세요.
- Codex가 터미널에서 직접 파일을 읽고 수정합니다.
- 기존에 사용자가 채운 값은 의미를 보존하고, 비어 있거나 약한 항목을 풍부하게 보강하세요.
- 모든 색상은 실제 디자인에 쓰기 좋은 HEX로 작성하세요.
- 업종 특성에 맞춰 고객, 포지셔닝, 성격, 비주얼 키워드, 콘텐츠 축, 금지/권장 규칙을 자세히 작성하세요.
- MD 안의 "Brand JSON" 코드블록은 반드시 유효한 JSON으로 유지하세요.

[입력 MD 파일 절대경로]
${brandPath}

[동시에 적용할 공동 브랜드 MD 파일 절대경로]
${brandProfilePath}

[필수 JSON 필드]
name, colors, primaryColor, secondaryColor, accentColor, backgroundColor, textColor, neutralColor,
businessType, businessDesc, audience, positioning, personality, visualKeywords, contentPillars,
cta, tone, rules, updatedAt

[작업 절차]
1. ${brandPath} 파일을 읽으세요.
2. 브랜드명/업종/설명을 근거로 위 필드를 모두 채운 완성 Markdown을 만드세요.
3. 같은 Markdown 내용을 ${brandPath}와 ${brandProfilePath} 두 파일에 덮어쓰세요.
4. 저장 후 파일 경로 두 줄만 출력하세요.

[브랜드 초안]
\`\`\`json
${JSON.stringify(seedBrand, null, 2)}
\`\`\``;
      await invoke('write_file', { path: brandPath, content: seedPayload });
      await invoke('write_file', { path: brandProfilePath, content: seedPayload });
      await invoke('write_file', { path: promptPath, content: terminalPrompt });
      await refreshBrandFiles();
      setActiveBrandPath(brandPath);
      setNewBrandName(displayName);
      setBrandDirty(false);
      setError(null);
      sendPrompt(terminalPrompt);
      onOpenFile?.(promptPath);
      setStatus(`Sent the brand auto-fill job to the Codex terminal. When it finishes, refresh the brand list or reload the currently applied brand: ${brandPath}`);
    } catch (err) {
      setError(`Failed to prepare AI brand auto-fill: ${err}`);
    }
  }, [activeBrandPath, brand, brandDir, brandProfilePath, newBrandName, onOpenFile, onTerminalPrompt, projectRoot, refreshBrandFiles, sendPrompt]);

  const loadBrandFile = useCallback(async (path: string) => {
    try {
      const raw = await invoke<string>('read_file', { path });
      const parsed = parseBrandProfileContent(raw || '{}');
      applyBrandProfile(parsed, path);
      setNewBrandName(parsed.name || fileNameFromPath(path).replace(/\.(md|json)$/i, ''));
      setStatus(`Selected brand profile: ${path}`);
    } catch (err) {
      setError(`Failed to read brand profile: ${err}`);
    }
  }, [applyBrandProfile]);

  useEffect(() => {
    void (async () => {
      if (!brandProfilePath) return;
      try {
        const raw = await invoke<string>('read_file', { path: brandProfilePath });
        if (raw) {
          const parsed = parseBrandProfileContent(raw);
          applyBrandProfile(parsed, brandProfilePath);
          setNewBrandName(parsed.name || 'brand-profile');
        }
      } catch {
        try {
          const legacyPath = brandProfilePath.replace(/\.md$/i, '.json');
          const raw = await invoke<string>('read_file', { path: legacyPath });
          const parsed = parseBrandProfileContent(raw);
          const md = brandProfileToMarkdown(parsed);
          await invoke('write_file', { path: brandProfilePath, content: md });
          applyBrandProfile(parsed, brandProfilePath);
          setNewBrandName(parsed.name || 'brand-profile');
        } catch {
          applyBrandProfile(emptyBrand, '');
        }
      }
    })();
  }, [applyBrandProfile, brandProfilePath]);

  useEffect(() => {
    void refreshBrandFiles();
  }, [refreshBrandFiles]);

  const startNewBrand = useCallback(() => {
    applyBrandProfile({ name: newBrandName.trim() }, '');
    setBrandDirty(true);
    setStatus('Create a new brand profile. It will be added to the brand list when saved.');
  }, [applyBrandProfile, newBrandName]);

  const saveBrand = useCallback(async () => {
    try {
      if (!brandProfilePath) throw new Error('No project is open.');
      if (!brandDir) throw new Error('Could not create a brand save folder.');
      await invoke('create_directory', { path: brandDir });
      await invoke('create_directory', { path: brandProfilePath.replace(/\/[^/]+$/, '') });
      const baseName = slugifyMaterialName(newBrandName.trim() || brand.name || 'brand-profile');
      const brandPath = activeBrandPath && activeBrandPath !== brandProfilePath ? activeBrandPath : `${brandDir}/${baseName}.md`;
      const payload = brandProfileToMarkdown(brand);
      await invoke('write_file', { path: brandPath, content: payload });
      await invoke('write_file', { path: brandProfilePath, content: payload });
      await refreshBrandFiles();
      setActiveBrandPath(brandPath);
      setBrandDirty(false);
      setStatus(`The selected brand is saved and will be applied to all design prompts: ${brandPath}`);
    } catch (err) {
      setError(`Failed to save profile: ${err}`);
    }
  }, [activeBrandPath, brand, brandDir, brandProfilePath, newBrandName, refreshBrandFiles]);

  const saveBrandAs = useCallback(async () => {
    try {
      if (!brandProfilePath) throw new Error('No project is open.');
      if (!brandDir) throw new Error('Could not create a brand save folder.');
      await invoke('create_directory', { path: brandDir });
      await invoke('create_directory', { path: brandProfilePath.replace(/\/[^/]+$/, '') });
      const displayName = newBrandName.trim() || brand.name.trim() || 'brand-profile';
      const brandPath = `${brandDir}/${slugifyMaterialName(displayName)}.md`;
      const nextBrand = { ...brand, name: brand.name.trim() || displayName };
      const payload = brandProfileToMarkdown(nextBrand);
      await invoke('write_file', { path: brandPath, content: payload });
      await invoke('write_file', { path: brandProfilePath, content: payload });
      await refreshBrandFiles();
      applyBrandProfile(nextBrand, brandPath);
      setNewBrandName(displayName);
      setStatus(`Saved the brand as a new entry: ${brandPath}`);
    } catch (err) {
      setError(`Failed to save brand as a new entry: ${err}`);
    }
  }, [applyBrandProfile, brand, brandDir, brandProfilePath, newBrandName, refreshBrandFiles]);

  const deleteBrandFile = useCallback(async (path: string) => {
    if (!path || path === brandProfilePath) return;
    const name = fileNameFromPath(path).replace(/\.(md|json)$/i, '');
    const ok = window.confirm(`Delete brand "${name}"? This will remove it from the saved brand list.`);
    if (!ok) return;
    try {
      await invoke('delete_path', { path });
      if (activeBrandPath === path) {
        const payload = brandProfileToMarkdown(emptyBrand);
        if (brandProfilePath) {
          await invoke('write_file', { path: brandProfilePath, content: payload });
        }
        applyBrandProfile(emptyBrand, '');
        setNewBrandName('');
      }
      await refreshBrandFiles();
      setStatus(`Deleted brand: ${path}`);
    } catch (err) {
      setError(`Failed to delete brand: ${err}`);
    }
  }, [activeBrandPath, applyBrandProfile, brandProfilePath, refreshBrandFiles]);

  // ─── Prompt markdown library ───
  const activeBrandMdPath = activeBrandPath || brandProfilePath;
  const buildPromptTemplate = useCallback((title: string) => `# ${title.replace(/\.md$/i, '')}

## 목적
이 프롬프트가 해결할 작업을 적어주세요.

## 입력값
- 브랜드 프로필 MD 절대경로: ${activeBrandMdPath || './makeke/brand-profile.md'}
- 산출물 위치: ./makeke/
- 참고 파일:

## 프롬프트
[역할]
당신은 디자인 콘텐츠/영상 제작 전문가입니다.

[작업]
아래 요청을 프로젝트 파일로 완성하고, 결과 파일 경로를 마지막에 출력하세요.

[요청]


[브랜드 규칙]
공동 브랜드 프로필이 있으면 반드시 반영하세요.
${brandSection(brand, activeBrandMdPath)}
`, [activeBrandMdPath, brand]);

  const refreshPromptFiles = useCallback(async () => {
    if (!promptDir) return;
    try {
      await invoke('create_directory', { path: promptDir });
      const entries = await invoke<PromptFileEntry[]>('read_directory', { path: promptDir });
      const mdFiles = entries
        .filter((entry) => !entry.is_dir && entry.name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name));
      setPromptFiles(mdFiles);
    } catch (err) {
      setError(`Failed to load prompt list: ${err}`);
    }
  }, [promptDir]);

  useEffect(() => {
    void refreshPromptFiles();
  }, [refreshPromptFiles]);

  const loadPromptFile = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>('read_file', { path });
      setActivePromptPath(path);
      setPromptDraft(content);
      setPromptDirty(false);
      setStatus(`Loaded prompt: ${path}`);
    } catch (err) {
      setError(`Failed to read prompt: ${err}`);
    }
  }, []);

  const createPromptFile = useCallback(async (initialContent?: string) => {
    try {
      if (!promptDir) throw new Error('No project is open.');
      await invoke('create_directory', { path: promptDir });
      const fileName = normalizePromptFileName(newPromptName);
      const base = fileName.replace(/\.md$/i, '');
      let nextPath = `${promptDir}/${fileName}`;
      let n = 2;
      while (true) {
        try {
          await invoke<string>('read_file', { path: nextPath });
          nextPath = `${promptDir}/${base}-${n}.md`;
          n += 1;
        } catch {
          break;
        }
      }
      const content = initialContent ?? buildPromptTemplate(fileName);
      await invoke('write_file', { path: nextPath, content });
      await refreshPromptFiles();
      await loadPromptFile(nextPath);
      onOpenFile?.(nextPath);
      return nextPath;
    } catch (err) {
      setError(`Failed to create prompt: ${err}`);
      return undefined;
    }
  }, [buildPromptTemplate, loadPromptFile, newPromptName, onOpenFile, promptDir, refreshPromptFiles]);

  const savePromptFile = useCallback(async () => {
    try {
      if (!activePromptPath) {
        await createPromptFile(promptDraft);
        return;
      }
      await invoke('write_file', { path: activePromptPath, content: promptDraft });
      setPromptDirty(false);
      setStatus(`Prompt saved: ${activePromptPath}`);
      onOpenFile?.(activePromptPath);
      await refreshPromptFiles();
    } catch (err) {
      setError(`Failed to save prompt: ${err}`);
    }
  }, [activePromptPath, createPromptFile, onOpenFile, promptDraft, refreshPromptFiles]);

  const sendMarkdownJob = useCallback(async (label: string, fileHint: string, content: string, outputPathForStatus?: string) => {
    if (!projectRoot) throw new Error('No project is open.');
    const root = projectRoot.replace(/\/$/, '');
    const jobDir = `${root}/makeke/prompts/jobs`;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jobPath = `${jobDir}/${slugifyMaterialName(fileHint || label)}-${ts}.md`;
    const wrapped = `# ${label}

생성일: ${new Date().toLocaleString()}

## 실행 규칙

- 이 작업은 Markdown 파일을 기준으로 진행합니다.
- Codex는 아래 내용을 읽고 필요한 파일을 생성/수정합니다.
- 브랜드가 필요한 경우 브랜드 MD 파일의 절대경로를 먼저 읽고 반영합니다.
- 작업 완료 후 생성/수정한 파일의 절대경로만 출력합니다.

## 브랜드 MD 파일 절대경로

${activeBrandMdPath || '(없음)'}

---

${content}`;
    await invoke('create_directory', { path: jobDir });
    await invoke('write_file', { path: jobPath, content: wrapped });
    onOpenFile?.(jobPath);
    sendPrompt(`다음 Markdown 작업 파일을 읽고 그대로 실행해줘.

[작업 MD 파일 절대경로]
${jobPath}

[규칙]
- 이 대화창에 붙은 내용이 아니라 위 MD 파일을 source of truth로 사용해.
- 브랜드 MD 절대경로가 있으면 먼저 읽고 모든 결과물에 반영해.
- 결과 파일을 저장한 뒤 절대경로만 출력해.`);
    setStatus(`Saved the ${label} job MD and sent it to the Codex terminal: ${jobPath}${outputPathForStatus ? ` → ${outputPathForStatus}` : ''}`);
    return jobPath;
  }, [activeBrandMdPath, onOpenFile, projectRoot, sendPrompt]);

  const sendPromptDraft = useCallback(async () => {
    if (!promptDraft.trim()) {
      setError('The prompt content to send is empty.');
      return;
    }
    setError(null);
    let path = activePromptPath;
    if (path) {
      if (promptDirty) await savePromptFile();
    } else {
      path = await createPromptFile(promptDraft) || '';
    }
    if (!path) return;
    sendPrompt(`다음 Markdown 프롬프트 파일을 읽고 실행해줘.

[프롬프트 MD 파일 절대경로]
${path}

[브랜드 MD 파일 절대경로]
${activeBrandMdPath || '(없음)'}

규칙:
- 위 MD 파일을 source of truth로 사용해.
- 브랜드 MD가 있으면 먼저 읽고 반영해.
- 결과 파일을 저장한 뒤 절대경로만 출력해.`);
    setStatus(`Sent the prompt MD file path to the active terminal: ${path}`);
  }, [activeBrandMdPath, activePromptPath, createPromptFile, promptDirty, promptDraft, savePromptFile, sendPrompt]);

  const openPromptInEditorTab = useCallback(async () => {
    if (!activePromptPath) {
      setError('Create or select a prompt file first.');
      return;
    }
    if (promptDirty) await savePromptFile();
    onOpenFile?.(activePromptPath);
    setStatus(`Also opened it in a regular file tab: ${activePromptPath}`);
  }, [activePromptPath, onOpenFile, promptDirty, savePromptFile]);

  const quickPromptTemplates = useMemo<QuickPromptTemplate[]>(() => {
    const root = projectRoot.replace(/\/$/, '') || '.';
    return [
      {
        id: 'video-ad',
        label: 'Ad Video',
        fileName: 'video-ad-prompt.md',
        content: `# 광고 영상 생성 프롬프트

## 목적
제품/서비스 광고 영상을 바로 만들기 위한 디자인/Higgsfield 스타일 프롬프트입니다.

## 프롬프트
[역할]
당신은 SNS 광고 영상 감독이자 HyperFrames 영상 제작자입니다.

[작업]
1. 아래 주제로 30초 광고 영상 기획안을 만드세요.
2. 장면별 화면 묘사, 카메라 무빙, 자막, 내레이션, BGM/효과음을 표로 작성하세요.
3. 필요하면 HyperFrames 프로젝트 파일까지 생성하세요.
4. 결과를 ${root}/makeke/video/video-ad-result.md 에 저장하고 파일 경로를 출력하세요.

[주제]

[영상 옵션]
- 비율: 9:16
- 길이: 30초
- 장면 수: 6
- 스타일: cinematic product orbit, fast social ad, bold subtitle
- 모델/무빙 참고: Higgsfield 스타일, Kling/Veo/Vidu/Wan 계열 이미지-투-비디오 호환

[품질 규칙]
- 첫 3초에 강한 후킹
- 모바일에서 잘 읽히는 짧은 자막
- 마지막 5초 CTA 고정
${brandSection(brand, activeBrandMdPath)}`,
      },
      {
        id: 'design-html',
        label: 'Design HTML',
        fileName: 'design-html-prompt.md',
        content: `# 디자인 HTML 생성 프롬프트

## 프롬프트
[역할]
당신은 Canva급 마케팅 디자인을 HTML 한 파일로 구현하는 시니어 프론트엔드 디자이너입니다.

[작업]
아래 요청을 완전한 HTML로 만들고 ${root}/makeke/design/design-result.html 에 저장하세요.

[요청]

[규칙]
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나는 완전한 HTML
- CSS/JS는 파일 안에 포함
- 한글은 잘리지 않게 word-break: keep-all
- 16:9 캔버스 기준, 모든 요소가 여백 안에 보이게
${brandSection(brand, activeBrandMdPath)}`,
      },
      {
        id: 'cardnews',
        label: 'Card News',
        fileName: 'cardnews-prompt.md',
        content: `# 카드뉴스 프롬프트

## 프롬프트
[역할]
당신은 한국어 SNS 카드뉴스 기획자입니다.

[작업]
주제를 5장 카드뉴스로 구성하고 ${root}/makeke/cardnews/cardnews-result.md 에 저장하세요.

[주제]

[출력]
- 각 장은 ## Slide N 으로 시작
- 후킹 → 문제 → 해결 → 증거 → CTA 구조
- 각 슬라이드 헤드라인 20자 이내
${brandSection(brand, activeBrandMdPath)}`,
      },
      {
        id: 'brand-aware',
        label: 'Brand-Aware',
        fileName: 'brand-aware-content-prompt.md',
        content: `# 공동 브랜드 프로필 반영 프롬프트

## 프롬프트
[역할]
당신은 공동 브랜드 프로필을 기준으로 모든 산출물의 톤앤매너를 맞추는 콘텐츠 디렉터입니다.

[작업]
1. ${activeBrandMdPath || brandProfilePath || `${root}/makeke/brand-profile.md`} 을 먼저 확인하세요.
2. 아래 요청을 브랜드 색상/톤/금지어/CTA 규칙에 맞춰 작성하세요.
3. 결과를 적절한 makeke 하위 폴더에 저장하고 파일 경로를 출력하세요.

[요청]

${brandSection(brand, activeBrandMdPath)}`,
      },
    ];
  }, [activeBrandMdPath, brand, brandProfilePath, projectRoot]);

  const useQuickPromptTemplate = useCallback(async (template: QuickPromptTemplate, sendNow = false) => {
    setError(null);
    setActivePromptPath('');
    setNewPromptName(template.fileName);
    setPromptDraft(template.content);
    setPromptDirty(true);
    if (sendNow) {
      await sendMarkdownJob(template.label, template.fileName, template.content);
    } else {
      setStatus(`Loaded a ready-to-use template: ${template.label}`);
    }
  }, [sendMarkdownJob]);

  const outputPath = useCallback((type: TabId, ext: string): string => {
    const root = projectRoot.replace(/\/$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${root}/makeke/${type}/${type}-${ts}.${ext}`;
  }, [projectRoot]);

  const materialOutputPath = useCallback((prefix: string, hint = 'material'): string => {
    const root = projectRoot.replace(/\/$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${root}/makeke/materials/${prefix}-${slugifyMaterialName(hint)}-${ts}.md`;
  }, [projectRoot]);

  const mediaOutputPath = useCallback((kind: 'image' | 'video' | 'api', ext: string): string => {
    const root = projectRoot.replace(/\/$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${root}/makeke/${kind}/${kind}-${ts}.${ext}`;
  }, [projectRoot]);

  const relativeProjectPath = useCallback((path: string) => {
    const root = projectRoot.replace(/\/$/, '');
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }, [projectRoot]);

  const materialSection = useCallback((extra?: string): string => {
    const chunks: string[] = [];
    const trimmed = sharedMaterial.trim();
    if (trimmed) chunks.push(`[참고 소재]\n${trimmed}`);
    if (extra?.trim()) chunks.push(`[추가 참고 소재]\n${extra.trim()}`);
    return chunks.length ? `\n${chunks.join('\n\n')}\n` : '';
  }, [sharedMaterial]);

  const importMaterialPaths = useCallback(async (paths: string[], label: string) => {
    const candidates = uniqStrings(paths).filter((path) => !/\/$/.test(path));
    if (candidates.length === 0) {
      setError(`${label}: no files found. Select files in the file tree or open files in the editor.`);
      return;
    }

    setError(null);
    setMaterialBusy(true);
    try {
      const blocks: string[] = [];
      let totalChars = 0;
      for (const path of candidates.slice(0, 12)) {
        const displayPath = relativeProjectPath(path);
        const name = fileNameFromPath(path);
        if (TEXT_MATERIAL_EXTS.test(path)) {
          try {
            const raw = await invoke<string>('read_file', { path });
            const remaining = Math.max(0, MAX_MATERIAL_CHARS_TOTAL - totalChars);
            const body = truncateMaterial(raw.trim(), Math.min(MAX_MATERIAL_CHARS_PER_FILE, remaining));
            if (body) {
              blocks.push(`### ${displayPath}\n\n${body}`);
              totalChars += body.length;
            } else {
              blocks.push(`### ${displayPath}\n\n(빈 텍스트 파일)`);
            }
          } catch {
            blocks.push(`### ${displayPath}\n\n파일 경로: ${path}\n내용을 읽지 못했습니다. 가능한 경우 이 파일을 직접 확인하고 반영하세요.`);
          }
        } else {
          blocks.push(`### ${displayPath}\n\n파일 경로: ${path}\n파일명: ${name}\n이 파일은 이미지/영상/문서 등 비텍스트 소재입니다. 생성 시 경로와 파일명을 참고하세요.`);
        }
        if (totalChars >= MAX_MATERIAL_CHARS_TOTAL) break;
      }

      setSharedMaterial((prev) => [prev.trim(), blocks.join('\n\n')].filter(Boolean).join('\n\n'));
      setMaterialPaths((prev) => uniqStrings([...prev, ...candidates]));
      setStatus(`${label} complete: applied ${blocks.length} material(s) to the prompt.`);
    } catch (err) {
      setError(`${label} failed: ${err}`);
    } finally {
      setMaterialBusy(false);
    }
  }, [relativeProjectPath]);

  const importSelectedMaterial = useCallback(() => {
    const paths = selectedFilePaths.length > 0 ? selectedFilePaths : (activeFilePath ? [activeFilePath] : []);
    void importMaterialPaths(paths, 'Import selected material');
  }, [activeFilePath, importMaterialPaths, selectedFilePaths]);

  const importOpenMaterials = useCallback(() => {
    const paths = openFilePaths.length > 0 ? openFilePaths : (activeFilePath ? [activeFilePath] : []);
    void importMaterialPaths(paths, 'Import open file material');
  }, [activeFilePath, importMaterialPaths, openFilePaths]);

  const saveMaterialDocument = useCallback(async (path: string, content: string) => {
    await invoke('create_directory', { path: path.replace(/\/[^/]+$/, '') });
    await invoke('write_file', { path, content });
    setMaterialPaths((prev) => uniqStrings([...prev, path]));
    setSharedMaterial((prev) => [
      prev.trim(),
      `### ${relativeProjectPath(path)}\n\n소재 파일 경로: ${path}\n이 소재 파일을 우선 참고하세요.`,
    ].filter(Boolean).join('\n\n'));
    onOpenFile?.(path);
  }, [onOpenFile, relativeProjectPath]);

  const crawlUrlsToMaterial = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const urls = extractUrls(materialSource);
    if (urls.length === 0) { setError('Enter a URL to crawl.'); return; }
    setError(null);
    setMaterialBusy(true);
    try {
      const blocks: string[] = [];
      for (const url of urls.slice(0, 8)) {
        try {
          const res = await invoke<HttpResponseOutput>('http_request', {
            input: {
              method: 'GET',
              url,
              headers: {
                'User-Agent': 'Mozilla/5.0 BBARIT-Design-MaterialBot/1.0',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
              },
              body: null,
              timeout_ms: 30000,
            },
          });
          const readable = extractReadableTextFromHtml(res.body || '');
          blocks.push(`## ${readable.title || url}

- URL: ${url}
- HTTP: ${res.status} ${res.status_text || ''}
${readable.description ? `- 설명: ${readable.description}` : ''}
${res.truncated ? '- 참고: 응답이 길어 일부만 가져왔습니다.' : ''}

### 본문 추출
${truncateMaterial(readable.text || res.body || '', MAX_CRAWLED_TEXT_CHARS)}`);
        } catch (err) {
          blocks.push(`## ${url}

- URL: ${url}
- 상태: 가져오기 실패
- 오류: ${String(err)}`);
        }
      }
      const firstHint = urls[0] || 'url';
      const savePath = materialOutputPath('url', firstHint);
      const content = `# URL 크롤링 소재

생성일: ${new Date().toLocaleString()}

${blocks.join('\n\n---\n\n')}

## 콘텐츠화 포인트
- 핵심 주장:
- 고객 문제:
- 증거/수치:
- 후킹 문장:
- CTA 후보:
`;
      await saveMaterialDocument(savePath, content);
      setStatus(`Created URL material: ${savePath}`);
    } catch (err) {
      setError(`Failed to create URL material: ${err}`);
    } finally {
      setMaterialBusy(false);
    }
  }, [materialOutputPath, materialSource, projectRoot, saveMaterialDocument]);

  const makeYoutubeMaterial = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const urls = extractUrls(materialSource).filter((url) => /youtu\.be|youtube\.com/i.test(url));
    if (urls.length === 0) { setError('Enter a YouTube URL.'); return; }
    setError(null);
    setMaterialBusy(true);
    try {
      const blocks: string[] = [];
      for (const url of urls.slice(0, 6)) {
        const videoId = parseYoutubeId(url);
        let title = '';
        let author = '';
        try {
          const res = await invoke<HttpResponseOutput>('http_request', {
            input: {
              method: 'GET',
              url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
              headers: { Accept: 'application/json' },
              body: null,
              timeout_ms: 15000,
            },
          });
          const parsed = JSON.parse(res.body || '{}') as { title?: string; author_name?: string };
          title = parsed.title || '';
          author = parsed.author_name || '';
        } catch { /* metadata is optional */ }
        blocks.push(`## ${title || 'YouTube 영상'}

- URL: ${url}
${videoId ? `- Video ID: ${videoId}` : ''}
${author ? `- 채널: ${author}` : ''}

### 크롤링/분석 체크리스트
- 영상 제목/썸네일 후킹:
- 영상 설명란 핵심 링크/CTA:
- 자막/스크립트 핵심 메시지:
- 댓글에서 반복되는 고객 언어:
- 쇼츠/릴스용 3초 후킹:
- 블로그/SNS로 재가공할 핵심 소재:
`);
      }

      const savePath = materialOutputPath('youtube', urls[0] || 'youtube');
      const content = `# 유튜브 크롤링 소재

생성일: ${new Date().toLocaleString()}

${blocks.join('\n\n---\n\n')}

## 보강 지시
AI 터미널에서 이 파일을 열고 각 영상의 설명란, 공개 자막/스크립트, 댓글 분위기, 썸네일/제목 후킹을 추가 조사해 아래 섹션을 채우세요.

## 콘텐츠화 포인트
- 핵심 메시지:
- 타겟 고객:
- 고객 언어:
- 카드뉴스 각도:
- 블로그 각도:
- SNS 캡션 각도:
`;
      await saveMaterialDocument(savePath, content);
      await sendMarkdownJob('YouTube material enrichment', 'youtube-material', `[역할] 유튜브 콘텐츠 리서처이자 디자인 소재 편집자입니다.

[작업]
1. 다음 유튜브 URL을 조사하세요.
${urls.slice(0, 6).map((url, i) => `${i + 1}. ${url}`).join('\n')}
2. 가능하면 공개 자막/스크립트, 영상 설명란, 제목/썸네일 후킹, 댓글의 반복 표현을 수집하세요.
3. 수집 내용을 콘텐츠 소재로 정리해 다음 파일을 보강 저장하세요: ${savePath}

[출력 구조]
- 영상별 요약
- 핵심 인사이트
- 고객 언어/댓글 표현
- 블로그 제목 후보 5개
- SNS 캡션 후보 5개
- 카드뉴스 흐름 5장

[저장 경로] ${savePath}`, savePath);
    } catch (err) {
      setError(`Failed to create YouTube material: ${err}`);
    } finally {
      setMaterialBusy(false);
    }
  }, [materialOutputPath, materialSource, projectRoot, saveMaterialDocument, sendMarkdownJob]);

  const makeTextMaterial = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const body = materialSource.trim();
    if (!body) { setError('Enter text to organize into material.'); return; }
    setError(null);
    setMaterialBusy(true);
    try {
      const firstLine = splitLines(body)[0] || 'text';
      const savePath = materialOutputPath('text', firstLine);
      const content = `# 텍스트 정리 소재

생성일: ${new Date().toLocaleString()}

## 원문
${truncateMaterial(body, MAX_CRAWLED_TEXT_CHARS)}

## 콘텐츠화 포인트
- 핵심 주장:
- 고객 문제:
- 증거/사례:
- 후킹 문장:
- 금지/주의 표현:
- CTA 후보:
`;
      await saveMaterialDocument(savePath, content);
      setStatus(`Created text material: ${savePath}`);
    } catch (err) {
      setError(`Failed to create text material: ${err}`);
    } finally {
      setMaterialBusy(false);
    }
  }, [materialOutputPath, materialSource, projectRoot, saveMaterialDocument]);

  const makeCreativeMaterial = useCallback(async (kind: 'cardnews' | 'image' | 'video') => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const source = [materialSource.trim(), sharedMaterial.trim()].filter(Boolean).join('\n\n');
    if (!source) {
      setError('Add or import URL/YouTube/text/file material first.');
      return;
    }

    const spec = {
      cardnews: {
        label: 'Card News',
        role: '한국어 카드뉴스 기획자이자 SNS 카피라이터',
        sections: `## 카드뉴스 소재
- 타겟:
- 핵심 메시지:
- 후킹 문장 5개:
- 5장 구성:
  1. Hook:
  2. Problem:
  3. Insight:
  4. Proof:
  5. CTA:
- 각 장 이미지 프롬프트:
- 캡션/해시태그:`,
      },
      image: {
        label: 'Image',
        role: '광고 이미지 아트디렉터이자 프롬프트 엔지니어',
        sections: `## 이미지 소재
- 이미지 목표:
- 메인 오브젝트:
- 타겟 감정:
- 비주얼 콘셉트 5개:
- 정방형 이미지 프롬프트:
- 세로형 이미지 프롬프트:
- 배너형 이미지 프롬프트:
- 금지 요소:
- 후처리/카피 배치 가이드:`,
      },
      video: {
        label: 'Video',
        role: '숏폼 광고 영상 감독이자 콘텐츠 전략가',
        sections: `## 영상 소재
- 영상 목표:
- 타겟:
- 3초 후킹 5개:
- 15초 구성:
- 30초 구성:
- 장면별 이미지 프롬프트:
- 장면별 영상/카메라 프롬프트:
- 자막:
- 내레이션:
- BGM/효과음:
- CTA:`,
      },
    }[kind];

    setError(null);
    setMaterialBusy(true);
    try {
      const firstLine = splitLines(source)[0] || kind;
      const savePath = materialOutputPath(kind, firstLine);
      const content = `# ${spec.label} 제작 소재

생성일: ${new Date().toLocaleString()}

## 원천 소재
${truncateMaterial(source, MAX_CRAWLED_TEXT_CHARS)}

${spec.sections}
`;
      await saveMaterialDocument(savePath, content);
      await sendMarkdownJob(`${spec.label} 제작 소재 보강`, `${kind}-material`, `[역할] ${spec.role}입니다.

[작업]
1. 아래 원천 소재를 읽고 ${spec.label} 제작용 소재로 재정리하세요.
2. 결과를 다음 파일에 보강 저장하세요: ${savePath}
3. 복사해서 바로 쓸 수 있는 프롬프트/카피/구성만 남기세요.

[원천 소재]
${truncateMaterial(source, MAX_CRAWLED_TEXT_CHARS)}

[필수 출력 구조]
${spec.sections}

${brandSection(brand, activeBrandMdPath)}
[저장 경로] ${savePath}`, savePath);
    } catch (err) {
      setError(`Failed to create ${spec.label} production material: ${err}`);
    } finally {
      setMaterialBusy(false);
    }
  }, [activeBrandMdPath, brand, materialOutputPath, materialSource, projectRoot, saveMaterialDocument, sendMarkdownJob, sharedMaterial]);

  const makeSelectedFilesMaterial = useCallback(async () => {
    const paths = selectedFilePaths.length > 0 ? selectedFilePaths : (openFilePaths.length > 0 ? openFilePaths : (activeFilePath ? [activeFilePath] : []));
    await importMaterialPaths(paths, 'Convert files to material');
  }, [activeFilePath, importMaterialPaths, openFilePaths, selectedFilePaths]);

  const readOctoEnvValue = useCallback(async (envName: string): Promise<string> => {
    const key = envName.trim();
    if (!key) return '';
    try {
      const home = await invoke<string>('get_home_dir');
      const raw = await invoke<string>('read_file', { path: `${home}/.config/octo/.env` });
      const line = raw.split(/\r?\n/).find((entry) => {
        const trimmed = entry.trim();
        return trimmed && !trimmed.startsWith('#') && trimmed.startsWith(`${key}=`);
      });
      if (!line) return '';
      let value = line.slice(line.indexOf('=') + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return value;
    } catch {
      return '';
    }
  }, []);

  const buildMediaPrompt = useCallback((kind: 'image' | 'video') => {
    const base = mediaPrompt.trim() || prompt.trim() || videoTopic.trim() || detailProduct.trim() || trendKeyword.trim() || snsTopic.trim() || cnTopic.trim() || blogTopic.trim();
    const source = [sharedMaterial.trim(), trendBody.trim()].filter(Boolean).join('\n\n');
    return `[제작 목표]
${base || '브랜드/소재를 바탕으로 마케팅 산출물을 제작'}

[산출 유형]
${kind === 'image' ? '마케팅 이미지 / 광고 비주얼 / 카드뉴스 커버' : '마케팅 영상 / 숏폼 광고 / 이미지-투-비디오'}

${brandSection(brand, activeBrandMdPath)}
${source ? `[참고 소재]\n${truncateMaterial(source, MAX_CRAWLED_TEXT_CHARS)}` : ''}

[품질 기준]
- 한국어 텍스트가 필요하면 짧고 또렷하게
- 브랜드 톤과 색상을 반영
- 모바일에서 바로 쓰기 좋은 구도
- 후킹, 메시지, CTA가 분명해야 함`;
  }, [activeBrandMdPath, blogTopic, brand, cnTopic, detailProduct, mediaPrompt, prompt, sharedMaterial, snsTopic, trendBody, trendKeyword, videoTopic]);

  const buildImageCodexPrompt = useCallback((mode: ImageCodexMode) => {
    const base = imageCodexPrompt.trim() || mediaPrompt.trim() || prompt.trim() || detailProduct.trim() || trendKeyword.trim() || snsTopic.trim() || cnTopic.trim() || blogTopic.trim();
    const source = [sharedMaterial.trim(), trendBody.trim()].filter(Boolean).join('\n\n');
    const continuity = mode === 'edit' && selectedImageCodexItem
      ? `\n[수정 대상]\n- 이전 이미지: ${selectedImageCodexItem.imagePath}\n- 이전 프롬프트: ${selectedImageCodexItem.prompt}\n`
      : '';
    const referenceSection = imageCodexRefs.length
      ? `\n[참조 이미지]\n${imageCodexRefs.map((ref, index) => `- Ref ${index + 1}: ${ref.path || ref.name}`).join('\n')}\n`
      : '';
    return `[이미지 코덱스 요청]
${mode === 'edit' ? '선택한 이미지를 유지·개선하면서 아래 지시에 맞게 수정하세요.' : '아래 요구사항에 맞는 새 이미지를 생성하세요.'}

[요청]
${base || '브랜드와 참고 소재를 바탕으로 바로 사용할 수 있는 마케팅 이미지를 생성'}
${continuity}
${referenceSection}
${brandSection(brand, activeBrandMdPath)}
${source ? `[참고 소재]\n${truncateMaterial(source, MAX_CRAWLED_TEXT_CHARS)}\n` : ''}
[품질 기준]
- 한국어 텍스트는 짧고 또렷하게, 글자 깨짐이 보이면 텍스트 없는 버전으로 대체
- 브랜드 색상/톤/CTA를 반영
- 카드뉴스 커버, 광고 배너, 상세페이지 비주얼로 바로 쓸 수 있는 구도
- 피사체와 핵심 메시지가 모바일 화면에서 명확하게 보이도록 구성`;
  }, [activeBrandMdPath, blogTopic, brand, cnTopic, detailProduct, imageCodexPrompt, imageCodexRefs, mediaPrompt, prompt, selectedImageCodexItem, sharedMaterial, snsTopic, trendBody, trendKeyword]);

  const imageCodexOutputPath = useCallback((ext: string): string => {
    const root = projectRoot.replace(/\/$/, '');
    const name = imageCodexFileName.trim();
    if (!name) return mediaOutputPath('image', ext);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = slugifyMaterialName(name.replace(/\.[^.]+$/, ''));
    return `${root}/makeke/image/${base}-${ts}.${ext}`;
  }, [imageCodexFileName, mediaOutputPath, projectRoot]);

  const persistImageCodexReferences = useCallback(async (refs: ImageCodexReference[]): Promise<ImageCodexReference[]> => {
    if (!refs.length) return [];
    if (!projectRoot) return refs;
    const root = projectRoot.replace(/\/$/, '');
    const refDir = `${root}/makeke/image/references`;
    await invoke('create_directory', { path: refDir });
    const stamp = Date.now();
    const persisted: ImageCodexReference[] = [];
    for (const [index, ref] of refs.entries()) {
      if (ref.path) {
        persisted.push(ref);
        continue;
      }
      const decoded = dataUrlToBase64(ref.dataUrl);
      const base = slugifyMaterialName(ref.name.replace(/\.[^.]+$/, '') || `reference-${index + 1}`);
      const refPath = `${refDir}/${base}-${stamp}-${index + 1}.${decoded.ext}`;
      await invoke('write_file_base64', { path: refPath, base64Data: decoded.base64 });
      persisted.push({ ...ref, path: refPath });
    }
    return persisted;
  }, [projectRoot]);

  const createImageCodexJob = useCallback(async (
    finalPrompt: string,
    mode: ImageCodexMode,
    refs: ImageCodexReference[] = [],
    targetImagePath?: string,
  ): Promise<ImageCodexHistoryItem> => {
    const imagePath = targetImagePath || imageCodexOutputPath('png');
    const promptPath = imagePath.replace(/\.[^.]+$/, '.prompt.md');
    await invoke('create_directory', { path: imagePath.replace(/\/[^/]+$/, '') });
    await invoke('write_file', {
      path: promptPath,
      content: `# Design Image Codex Prompt

## Job
- Mode: ${mode}
- Created: ${new Date().toISOString()}
- Target image path: ${imagePath}
- Prompt file: ${promptPath}
${refs.length ? `- Reference images:\n${refs.map((ref, index) => `  - Ref ${index + 1}: ${ref.path || ref.name}`).join('\n')}\n` : ''}

## Hard Rules
- Use Codex for this image generation/editing task.
- Do not use Gemini, Gemini API keys, or NanoBanana.
- If an external image API is needed, use only an API explicitly configured by the user/project.
- Save the final image exactly to the target image path above.
- When reference images are listed, read them from the file paths above.
- After finishing, report the saved image path and any API/tool used.

## User Prompt

${finalPrompt}
`,
    });
    return {
      id: `image-codex-${Date.now()}`,
      prompt: finalPrompt,
      mode,
      imagePath,
      promptPath,
      createdAt: Date.now(),
    };
  }, [imageCodexOutputPath]);

  const sendImageCodexJobToTerminal = useCallback((item: ImageCodexHistoryItem) => {
    sendPrompt(`디자인 이미지 작업을 Codex로 실행해줘.

프롬프트 파일: ${item.promptPath}
결과 이미지 저장 경로: ${item.imagePath}

규칙:
1. 프롬프트 파일을 먼저 읽고 그대로 수행해.
2. Gemini, Gemini API 키, NanoBanana는 절대 사용하지 마.
3. Codex의 이미지 생성/편집 기능을 우선 사용하고, 필요하면 사용자가 설정한 이미지 API만 사용해.
4. 결과 이미지를 정확히 위 저장 경로에 저장해.
5. 완료 후 저장된 이미지 경로와 사용한 도구/API만 짧게 알려줘.`);
  }, [sendPrompt]);

  const runImageCodex = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    if (imageCodexMode === 'edit' && !selectedImageCodexItem) {
      setError('Select an image to edit from the history first.');
      return;
    }
    const finalPrompt = buildImageCodexPrompt(imageCodexMode);
    setError(null);
    setImageCodexBusy(true);
    try {
      const persistedRefs = await persistImageCodexReferences(imageCodexRefs);
      const item = await createImageCodexJob(finalPrompt, imageCodexMode, persistedRefs);
      setImageCodexHistory((prev) => [item, ...prev].slice(0, MAX_IMAGE_CODEX_HISTORY));
      setSelectedImageCodexId(item.id);
      setImageCodexMode('edit');
      setImageCodexRefs(persistedRefs);
      setLastSavedImageCodexId(item.id);
      setImageCodexPrompt('');
      setSharedMaterial((prev) => [prev.trim(), `### Codex 이미지 작업\n\n결과 이미지: ${item.imagePath}\n프롬프트: ${item.promptPath}`].filter(Boolean).join('\n\n'));
      setMaterialPaths((prev) => uniqStrings([...prev, item.imagePath, item.promptPath, ...persistedRefs.map((ref) => ref.path)]));
      sendImageCodexJobToTerminal(item);
      onOpenFile?.(item.promptPath);
      setStatus(`Sent the image job to the Codex terminal. Result path: ${item.imagePath}`);
      setTimeout(() => setLastSavedImageCodexId((current) => current === item.id ? null : current), 1800);
    } catch (err) {
      setError(`Image Codex failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImageCodexBusy(false);
    }
  }, [buildImageCodexPrompt, createImageCodexJob, imageCodexMode, imageCodexRefs, onOpenFile, persistImageCodexReferences, projectRoot, selectedImageCodexItem, sendImageCodexJobToTerminal]);

  const resendSelectedImageCodex = useCallback(() => {
    if (!selectedImageCodexItem) return;
    sendImageCodexJobToTerminal(selectedImageCodexItem);
    setStatus(`Resent the selected image job to the Codex terminal: ${selectedImageCodexItem.promptPath}`);
  }, [selectedImageCodexItem, sendImageCodexJobToTerminal]);

  const clearImageCodexHistory = useCallback(() => {
    setImageCodexHistory([]);
    setSelectedImageCodexId(null);
    setImageCodexMode('generate');
    try {
      localStorage.removeItem(imageCodexHistoryKey);
    } catch {
      // ignore
    }
    setStatus('Cleared the Image Codex history.');
  }, [imageCodexHistoryKey]);

  const addImageCodexReferences = useCallback((refs: ImageCodexReference[]) => {
    if (refs.length === 0) return;
    setImageCodexRefs((prev) => {
      const seen = new Set(prev.map((ref) => ref.path || ref.name));
      const next = [...prev];
      for (const ref of refs) {
        const key = ref.path || ref.name;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(ref);
      }
      return next.slice(0, MAX_IMAGE_CODEX_REFERENCES);
    });
  }, []);

  const handleImageCodexFileUpload = useCallback(async (files: FileList | null) => {
    const list = Array.from(files || []).slice(0, MAX_IMAGE_CODEX_REFERENCES);
    if (list.length === 0) return;
    const refs = (await Promise.all(list.map(readBrowserImageFile))).filter((ref): ref is ImageCodexReference => !!ref);
    addImageCodexReferences(refs);
    setStatus(`Added ${refs.length} reference image(s).`);
    if (imageCodexFileInputRef.current) imageCodexFileInputRef.current.value = '';
  }, [addImageCodexReferences]);

  const importSelectedImageReferences = useCallback(async () => {
    const paths = uniqStrings(selectedFilePaths.length > 0 ? selectedFilePaths : (openFilePaths.length > 0 ? openFilePaths : (activeFilePath ? [activeFilePath] : [])))
      .filter(isImagePath)
      .slice(0, MAX_IMAGE_CODEX_REFERENCES);
    if (paths.length === 0) {
      setError('Select an image file to add as a reference from the file tree or open files first.');
      return;
    }
    setError(null);
    try {
      const refs: ImageCodexReference[] = [];
      for (const path of paths) {
        const base64 = await invoke<string>('read_file_base64', { path });
        const name = fileNameFromPath(path);
        const mime = imageMimeFromName(name);
        refs.push({
          id: `image-ref-${Date.now()}-${refs.length}`,
          name,
          path,
          dataUrl: `data:${mime};base64,${base64}`,
        });
      }
      addImageCodexReferences(refs);
      setStatus(`Added ${refs.length} selected image(s) as references.`);
    } catch (err) {
      setError(`Failed to read reference image: ${err}`);
    }
  }, [activeFilePath, addImageCodexReferences, openFilePaths, selectedFilePaths]);

  const removeImageCodexReference = useCallback((id: string) => {
    setImageCodexRefs((prev) => prev.filter((ref) => ref.id !== id));
  }, []);

  const generateImageDirect = useCallback(async () => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const finalPrompt = buildMediaPrompt('image');
    setError(null);
    setMediaBusy(true);
    try {
      const item = await createImageCodexJob(finalPrompt, 'generate', [], mediaOutputPath('image', 'png'));
      setImageCodexHistory((prev) => [item, ...prev].slice(0, MAX_IMAGE_CODEX_HISTORY));
      setSelectedImageCodexId(item.id);
      setImageCodexMode('edit');
      setSharedMaterial((prev) => [prev.trim(), `### Codex 이미지 작업\n\n결과 이미지: ${item.imagePath}\n프롬프트: ${item.promptPath}`].filter(Boolean).join('\n\n'));
      setMaterialPaths((prev) => uniqStrings([...prev, item.imagePath, item.promptPath]));
      sendImageCodexJobToTerminal(item);
      onOpenFile?.(item.promptPath);
      setStatus(`Sent the image job to the Codex terminal: ${item.imagePath}`);
    } catch (err) {
      setError(`Failed to generate image: ${err}`);
    } finally {
      setMediaBusy(false);
    }
  }, [buildMediaPrompt, createImageCodexJob, mediaOutputPath, onOpenFile, projectRoot, sendImageCodexJobToTerminal]);

  const callMediaApi = useCallback(async (kind: 'image' | 'video') => {
    if (!projectRoot) { setError('No project is open.'); return; }
    const endpoint = mediaApiUrl.trim();
    if (!endpoint) { setError('Enter the image/video generation API URL.'); return; }
    const finalPrompt = buildMediaPrompt(kind);
    const responsePath = mediaOutputPath('api', `${kind}-response.json`);
    const payloadPath = responsePath.replace(/-response\.json$/, '-payload.json');
    const payload = {
      method: kind === 'image' ? 'makeke.image.generate' : 'makeke.video.generate',
      api_version: '2026-05-16',
      requested_outputs: {
        generate_images: kind === 'image',
        generate_videos: kind === 'video',
        save_assets: true,
      },
      output_dir: `${projectRoot.replace(/\/$/, '')}/makeke/${kind}`,
      prompt: finalPrompt,
      brand,
      material_paths: materialPaths,
      source_text: materialSource.trim(),
    };
    setError(null);
    setMediaBusy(true);
    try {
      await invoke('create_directory', { path: responsePath.replace(/\/[^/]+$/, '') });
      await invoke('write_file', { path: payloadPath, content: JSON.stringify(payload, null, 2) });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const apiKey = await readOctoEnvValue(mediaApiKeyEnv);
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await invoke<HttpResponseOutput>('http_request', {
        input: {
          method: 'POST',
          url: endpoint,
          headers,
          body: JSON.stringify(payload),
          timeout_ms: 600000,
        },
      });
      const parsedBody = (() => {
        try { return JSON.parse(response.body || '{}'); } catch { return response.body || ''; }
      })();
      const returnedMedia = collectMediaStrings(parsedBody, kind);
      const savedAssets: string[] = [];
      for (const [index, item] of returnedMedia.entries()) {
        if (/^data:/i.test(item)) {
          const decoded = dataUrlToBase64(item);
          const assetPath = `${projectRoot.replace(/\/$/, '')}/makeke/${kind}/${kind}-api-${Date.now()}-${index + 1}.${decoded.ext}`;
          await invoke('create_directory', { path: assetPath.replace(/\/[^/]+$/, '') });
          await invoke('write_file_base64', { path: assetPath, base64Data: decoded.base64 });
          savedAssets.push(assetPath);
        } else {
          savedAssets.push(item);
        }
      }
      await invoke('write_file', {
        path: responsePath,
        content: JSON.stringify({
          status: response.status,
          status_text: response.status_text || '',
          headers: response.headers || [],
          body: parsedBody,
          saved_assets: savedAssets,
          payload_path: payloadPath,
          saved_at: new Date().toISOString(),
        }, null, 2),
      });
      const assetLines = savedAssets.length ? `\nAssets:\n${savedAssets.map((path) => `- ${path}`).join('\n')}` : '';
      setSharedMaterial((prev) => [prev.trim(), `### ${kind === 'image' ? '이미지' : '영상'} API 응답\n\nPayload: ${payloadPath}\nResponse: ${responsePath}${assetLines}`].filter(Boolean).join('\n\n'));
      setMaterialPaths((prev) => uniqStrings([...prev, payloadPath, responsePath, ...savedAssets]));
      onOpenFile?.(savedAssets.find((path) => !/^https?:\/\//i.test(path)) || responsePath);
      setStatus(`Called the ${kind === 'image' ? 'image' : 'video'} generation API: ${responsePath}${savedAssets.length ? `, saved/linked ${savedAssets.length} asset(s)` : ''}`);
    } catch (err) {
      setError(`${kind === 'image' ? 'Image' : 'Video'} API call failed: ${err}`);
    } finally {
      setMediaBusy(false);
    }
  }, [brand, buildMediaPrompt, materialPaths, materialSource, mediaApiKeyEnv, mediaApiUrl, mediaOutputPath, onOpenFile, projectRoot, readOctoEnvValue]);

  // ─── Handlers ───
  const handleGenerate3DModel = useCallback(async () => {
    const request = model3dPrompt.trim();
    if (!request) { setError('Enter a 3D model request.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const baseName = slugifyMaterialName(model3dOutputName.trim() || request);
    const root = projectRoot.replace(/\/$/, '');
    const glbPath = `${root}/makeke/model3d/${baseName}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.glb`;
    const viewerPath = glbPath.replace(/\.glb$/i, '.viewer.html');
    const reportPath = glbPath.replace(/\.glb$/i, '.md');
    await sendMarkdownJob('Generate/import 3D model', '3d-model', `[역할]
당신은 3DCellForge 스타일의 3D 모델 워크벤치 엔지니어이자 Three.js 디자이너입니다.

[목표]
아래 요청을 바탕으로 GLB 모델을 생성하거나 기존 GLB/GLTF를 가져와 BBARIT 프로젝트 안에서 확인 가능한 3D 산출물로 정리하세요.

[요청]
${request}

[3D 워크플로우]
- Provider mode: ${model3dProvider}
- Presentation style: ${model3dStyle}
- Reference asset absolute path: ${model3dReferencePath.trim() || '(none)'}
- Output GLB absolute path: ${glbPath}
- Viewer HTML absolute path: ${viewerPath}
- Report MD absolute path: ${reportPath}

[적용할 3DCellForge 핵심 방식]
- WebGL orbit controls로 회전/줌/검사가 가능한 3D 뷰어를 만드세요.
- GLB/GLTF가 제공되면 그 파일을 우선 가져오고, 없으면 선택한 provider mode에 맞춰 생성 계획을 실행하세요.
- Hyper3D, Tripo, Fal.ai, Hunyuan3D, JS Depth, Local GLB 흐름을 지원하는 구조로 작성하세요.
- API 키는 프론트엔드 HTML/JS에 절대 하드코딩하지 말고 서버/환경변수/터미널 환경에서만 읽으세요.
- provider 호출이 불가능하면 placeholder가 아니라 로컬에서 확인 가능한 procedural Three.js 모델 또는 JS Depth fallback을 작성하세요.
- 결과 뷰어는 외부 placeholder 이미지 없이 실행 가능해야 하고, 모델명/태그/품질 메모/사용 provider를 화면 또는 보고서에 남기세요.

${brandSection(brand, activeBrandMdPath)}
${materialSection()}

[필수 산출물]
1. 최종 GLB 또는 가져온 GLB 사본: ${glbPath}
2. 모델을 확인할 HTML 뷰어: ${viewerPath}
3. 생성/가져오기/검증 기록 MD: ${reportPath}

[완료 출력]
저장한 세 파일의 절대경로만 출력하세요.`, viewerPath);
    setMaterialPaths((prev) => uniqStrings([...prev, glbPath, viewerPath, reportPath, model3dReferencePath]));
    onOpenFile?.(viewerPath);
  }, [activeBrandMdPath, brand, materialSection, model3dOutputName, model3dPrompt, model3dProvider, model3dReferencePath, model3dStyle, onOpenFile, projectRoot, sendMarkdownJob]);

  const handleGenerateDesign = useCallback(async () => {
    if (!prompt.trim()) { setError('Enter your request.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('design', 'html');
    const canvas: Record<string, string> = {
      '9:16': '1080x1920px', '1:1': '1080x1080px', '4:3': '1600x1200px',
      'A4': '1240x1754px (A4)', '16:9': '1920x1080px',
    };
    const colors = brandColors.trim()
      ? parseColorPalette(brandColors).join(', ')
      : formatBrandColorPalette(brand.colors, brand) || '없음';
    const finalBrandName = brandName.trim() || brand.name.trim() || '없음';
    const finalCta = ctaText.trim() || brand.cta.trim() || '없음';
    await sendMarkdownJob('Generate design HTML', 'design-html', `[역할] Canva급 마케팅 디자인을 HTML 하나로 만드는 시니어 프론트엔드 디자이너입니다.

[작업 절차]
1. 아래 조건의 완전한 HTML을 만드세요.
2. 결과 HTML 전체를 다음 파일에 저장(create)하세요: ${savePath}
3. 저장 후 파일 경로 한 줄만 출력하세요.

[절대 출력 규칙]
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나는 완전한 HTML.
- CSS/JS는 HTML 안에 포함. 외부 placeholder(unsplash 등) 금지.
- 한글은 word-break: keep-all; overflow-wrap: break-word; line-height >= 1.08.
- 모든 콘텐츠는 캔버스 64px 여백 안에 보이고 잘리지 않게.

[요청] ${prompt.trim()}

[산출물]
- 형식: ${kind}
- 캔버스: ${canvas[aspect] || canvas['16:9']}
- 브랜드: ${finalBrandName}
- 브랜드 색상: ${colors}
- CTA: ${finalCta}
- 스타일: ${style || 'auto'}
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로] ${savePath}`, savePath);
    setTargetFile(savePath);
  }, [activeBrandMdPath, prompt, projectRoot, outputPath, kind, aspect, style, brandName, brandColors, ctaText, brand, materialSection, sendMarkdownJob]);

  const handleEditDesign = useCallback(async () => {
    const instruction = editInstruction.trim(); if (!instruction) return;
    if (!targetFile.trim()) { setError('The file path to edit is empty. Open a file from the left file tree or enter the path directly.'); return; }
    setError(null);
    await sendMarkdownJob('Edit design HTML', 'design-edit', `[역할] HTML 디자인 편집자입니다.

[작업 절차]
1. 파일 ${targetFile}을(를) 읽으세요.
2. 아래 [수정 지시]에 따라 편집한 완전한 HTML을 만드세요.
3. 결과를 같은 경로 ${targetFile}에 덮어쓰세요.
4. 저장 후 파일 경로 한 줄만 출력하세요.

[수정 지시]
${instruction}

[규칙]
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나는 완전한 HTML.
- 기존 의도/구조 유지, 수정 지시 반영.
- 한글 텍스트 안전성 유지.`, targetFile);
    setEditInstruction('');
  }, [editInstruction, targetFile, sendMarkdownJob]);

  // Open every produced file that actually landed on disk, refresh previews.
  const openProducedFiles = useCallback(async (paths: string[]): Promise<string[]> => {
    const landed: string[] = [];
    for (const p of paths) {
      try {
        await invoke<string>('read_file', { path: p });
        landed.push(p);
      } catch { /* agent skipped this variation */ }
    }
    for (const p of landed) onOpenFile?.(p);
    setPreviewNonce((n) => n + 1);
    return landed;
  }, [onOpenFile]);

  // Design Studio generate: drive bbarit-agent (bbarit-design skill) to write
  // N variation files, then open each in the live HTML preview.
  const runDesignStudio = useCallback(async () => {
    if (!prompt.trim()) { setError('Enter your request.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    if (designAgent.busy) return;
    setError(null);
    const root = projectRoot.replace(/\/$/, '');
    const dir = `${root}/makeke/design`;
    await invoke('create_directory', { path: dir }).catch(() => {});
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const count = Math.max(1, Math.min(4, variationCount));
    const paths = Array.from({ length: count }, (_, i) =>
      count === 1 ? `${dir}/design-${ts}.html` : `${dir}/design-${ts}-v${i + 1}.html`);
    const canvas: Record<string, string> = {
      '9:16': '1080x1920px', '1:1': '1080x1080px', '4:3': '1600x1200px',
      'A4': '1240x1754px (A4)', '16:9': '1920x1080px',
    };
    const colors = brandColors.trim()
      ? parseColorPalette(brandColors).join(', ')
      : formatBrandColorPalette(brand.colors, brand) || '없음';
    const finalBrandName = brandName.trim() || brand.name.trim() || '없음';
    const finalCta = ctaText.trim() || brand.cta.trim() || '없음';
    const variationLine = count === 1
      ? `- 파일 1개를 생성하세요: ${paths[0]}`
      : `- 서로 뚜렷이 다른 ${count}개의 시안(레이아웃/톤/색 강조가 다르게)을 각각 아래 경로에 저장하세요:\n${paths.map((p, i) => `  시안 ${i + 1} → ${p}`).join('\n')}`;
    setStatus(`Generating ${count} design${count > 1 ? ' variations' : ''} with 빠릿디자인…`);
    const message = `당신은 빠릿디자인 스킬로 작업하는 시니어 프로덕트/비주얼 디자이너입니다.
먼저 스킬 파일을 read 도구로 읽어 방법론을 적용하세요.

[작업 절차]
1. 아래 조건의 완전한 마케팅 디자인 HTML을 만드세요.
${variationLine}
2. 각 파일은 write 도구로 저장하세요(외부 리소스 없이 자기완결형).
3. 저장 후 browser 도구로 각 파일의 file:// 경로를 navigate → screenshot → console 확인하여 실제로 렌더되는지 검증하고, 깨지면 고치세요.
4. 끝나면 저장한 파일 경로만 짧게 보고하세요.

[절대 규칙]
- 반드시 <!DOCTYPE html>로 시작하고 </html>로 끝나는 완전한 HTML. CSS/JS는 인라인.
- 한글은 word-break: keep-all; overflow-wrap: break-word; line-height >= 1.08.
- 모든 콘텐츠는 캔버스 여백 안에 잘리지 않게.

[요청] ${prompt.trim()}

[산출물]
- 형식: ${kind}
- 캔버스: ${canvas[aspect] || canvas['16:9']}
- 브랜드: ${finalBrandName}
- 브랜드 색상: ${colors}
- CTA: ${finalCta}
- 스타일: ${style || 'auto'}
${brandSection(brand, activeBrandMdPath)}
${materialSection()}`;
    const result = await designAgent.run(message);
    if (!result.ok) { setError(result.error || 'The design agent did not finish.'); return; }
    const landed = await openProducedFiles(paths);
    if (landed.length === 0) { setError('The agent finished but produced no design file.'); return; }
    pushDesignHistory({ id: `d-${Date.now()}`, prompt: prompt.trim(), paths: landed, createdAt: Date.now() });
    setTargetFile(landed[0]);
    setStatus(`Done — ${landed.length} design${landed.length > 1 ? 's' : ''} ready. Click a thumbnail to open it.`);
  }, [activeBrandMdPath, prompt, projectRoot, variationCount, kind, aspect, style, brandName, brandColors, ctaText, brand, materialSection, designAgent, openProducedFiles, pushDesignHistory]);

  // Design Studio iterate: agent edits the target file in place; the file
  // watcher refreshes the already-open live preview automatically.
  const runDesignEditAgent = useCallback(async () => {
    const instruction = editInstruction.trim(); if (!instruction) return;
    if (!targetFile.trim()) { setError('No file selected to edit. Generate a design or pick one from history first.'); return; }
    if (designAgent.busy) return;
    setError(null);
    setStatus('Applying your change with 빠릿디자인…');
    const message = `빠릿디자인 스킬로 작업하는 디자이너입니다. 필요하면 스킬 파일을 read로 읽으세요.

[작업 절차]
1. 파일 ${targetFile}을(를) read로 읽으세요.
2. 아래 [수정 지시]만 반영하고, 요청하지 않은 레이아웃/색/폰트/간격은 그대로 두세요(작은 요청은 그 부분만 수정).
3. edit/patch 도구로 같은 경로에 반영하세요(전체 재작성 금지, 최소 변경).
4. browser로 file://${targetFile} 를 navigate → screenshot 해서 렌더 확인 후 끝내세요.

[수정 지시]
${instruction}`;
    const result = await designAgent.run(message);
    if (!result.ok) { setError(result.error || 'The edit did not finish.'); return; }
    setEditInstruction('');
    setPreviewNonce((n) => n + 1);
    setStatus('Change applied. The preview refreshes automatically.');
  }, [editInstruction, targetFile, designAgent]);

  const handleBlog = useCallback(async () => {
    if (!blogTopic.trim()) { setError('Enter a blog topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('blog', 'md');
    const textPath = savePath.replace(/\.md$/i, '.txt');
    await sendMarkdownJob('Write blog', 'blog', `[역할] 한국어 마케팅 블로그 작가입니다.

[작업 절차]
1. 다음 조건의 블로그 본문(마크다운)을 작성하세요.
2. 결과 전체를 ${savePath}에 저장하세요.
3. 복사/붙여넣기 쉬운 일반 텍스트 버전도 ${textPath}에 저장하세요.
4. 저장 후 두 파일 경로만 출력하세요.

[톤] ${blogTone || brand.tone || '전문가, 신뢰감 있는 톤'}
[주제] ${blogTopic.trim()}

[출력 규칙]
- 마크다운, 제목(#), 부제목(##)
- 한 단락 2-3문장
- 도입 → 본론 3-4단락 → 결론
- 핵심 키워드 **볼드**
- 마지막에 CTA 한 줄
- 1000-1500자
- TXT 버전은 #, ##, ** 같은 마크다운 기호 없이 제목/소제목/본문만 자연스럽게 정리
- TXT 버전은 블로그 에디터에 그대로 붙여넣어도 어색하지 않게 빈 줄과 문단을 정돈
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로]
- Markdown: ${savePath}
- Text: ${textPath}`, savePath);
  }, [activeBrandMdPath, blogTopic, blogTone, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleCardnews = useCallback(async () => {
    if (!cnTopic.trim()) { setError('Enter a card news topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('cardnews', 'md');
    await sendMarkdownJob('Write card news', 'cardnews', `[역할] 한국어 SNS 카드뉴스 카피라이터입니다.

[작업 절차]
1. 다음 조건의 카드뉴스 ${cnSlides}장 텍스트를 마크다운으로 작성하세요.
2. 결과 전체를 ${savePath}에 저장하세요.
3. 저장 후 파일 경로 한 줄만 출력하세요.

[주제] ${cnTopic.trim()}
[슬라이드 수] ${cnSlides}장

[출력 규칙]
- 각 슬라이드 "## Slide N: 헤드라인" 시작
- 헤드라인 10-20자, 짧고 강력하게
- 본문 2-3문장, 50-80자
- 첫 슬라이드 후킹, 마지막 CTA
- 슬라이드 사이 빈 줄
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로] ${savePath}`, savePath);
  }, [activeBrandMdPath, cnTopic, cnSlides, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleComic = useCallback(async () => {
    if (!comicTopic.trim()) { setError('Enter a comic topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('comic', 'md');
    await sendMarkdownJob('Write comic script', 'comic', `[역할] 한국어 카툰/웹툰 스토리텔러입니다.

[작업 절차]
1. 다음 조건의 ${comicPanels}컷 만화 시나리오 + 컷별 설명을 마크다운으로 작성.
2. 결과 전체를 ${savePath}에 저장.
3. 저장 후 파일 경로 한 줄만 출력.

[주제] ${comicTopic.trim()}
[컷 수] ${comicPanels}컷

[출력 규칙]
- 각 컷: "## Panel N — 장면 제목"
- 그 밑에 [설명](배경/구도), [캐릭터], [대사], [효과음/내레이션] 항목
- 첫 컷은 후킹, 마지막 컷은 메시지/CTA
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로] ${savePath}`, savePath);
  }, [activeBrandMdPath, comicTopic, comicPanels, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleDetail = useCallback(async () => {
    if (!detailProduct.trim()) { setError('Enter a product/service name.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('detail', 'html');
    await sendMarkdownJob('Generate detail page HTML', 'detail-page', `[역할] 한국어 커머스 상세페이지(랜딩) 디자이너이자 카피라이터입니다.

[작업 절차]
1. 다음 제품의 완전한 상세페이지 HTML(한 파일)을 만드세요.
2. 결과 HTML 전체를 ${savePath}에 저장.
3. 저장 후 파일 경로 한 줄만 출력.

[제품/서비스] ${detailProduct.trim()}
[핵심 셀링포인트] ${detailHighlights.trim() || '(자유 추론)'}

[페이지 구조 — 세로 스크롤]
1. Hero: 큰 헤드라인 + 서브 + 핵심 비주얼 placeholder
2. 핵심 가치 3-4개 (아이콘 카드 그리드)
3. 사용 시나리오 / Before-After
4. 디테일 스펙(표)
5. 후기/사회적 증거
6. FAQ 3-5개
7. CTA 섹션

[규칙]
- 반드시 <!DOCTYPE html>로 시작, </html>로 끝나는 완전한 HTML
- CSS는 <style>에 포함, 외부 placeholder 금지
- 한글 word-break: keep-all
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로] ${savePath}`, savePath);
  }, [activeBrandMdPath, detailProduct, detailHighlights, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleVideo = useCallback(async () => {
    if (!videoTopic.trim()) { setError('Enter a video topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('video', 'md');
    await sendMarkdownJob('Write ad video script', 'video-ad', `[역할] 한국어 SNS 광고 영상 시나리오 작가/감독입니다.

[작업 절차]
1. 다음 조건의 ${videoSeconds}초 광고 영상 시나리오(장면 분할표 + 자막 + BGM 가이드)를 마크다운으로 작성.
2. 결과 전체를 ${savePath}에 저장.
3. 저장 후 파일 경로 한 줄만 출력.

[주제] ${videoTopic.trim()}
[길이] 약 ${videoSeconds}초 (장면당 3-5초 권장)

[출력 형식]
| Scene | 시간 | 화면 묘사 | 자막 | 내레이션 | BGM/효과 |
|-------|------|-----------|------|----------|----------|

- 첫 3초 후킹 필수
- 마지막 5초 CTA
- 자막은 짧고 강력하게 (모바일 가독성)
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로] ${savePath}`, savePath);
  }, [activeBrandMdPath, videoTopic, videoSeconds, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleTrend = useCallback(async () => {
    if (!trendKeyword.trim()) { setError('Enter a keyword/topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('trend', 'md');
    await sendMarkdownJob('Write all-in-one content', 'trend-content', `[역할] 한국어 콘텐츠 마케터입니다.

[작업 절차]
1. 다음 키워드/소재를 바탕으로 멀티 채널 콘텐츠 세트(블로그 요약 + SNS 캡션 + 카드뉴스 5장 헤드라인)를 한 번에 작성.
2. 결과 전체를 ${savePath}에 저장.
3. 저장 후 파일 경로 한 줄만 출력.

[키워드/주제] ${trendKeyword.trim()}
${materialSection(trendBody)}

[출력 구조 — 마크다운]
## 블로그 요약 (300자)
...

## Instagram 캡션
...

## Threads 포스트 (2-3 단락)
...

## 카드뉴스 5장 헤드라인
1. ...
2. ...

## 핵심 해시태그
#... #... #...
${brandSection(brand, activeBrandMdPath)}
[저장 경로] ${savePath}`, savePath);
  }, [activeBrandMdPath, trendKeyword, trendBody, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const handleSns = useCallback(async () => {
    if (!snsTopic.trim()) { setError('Enter an SNS topic.'); return; }
    if (!projectRoot) { setError('No project is open.'); return; }
    setError(null);
    const savePath = outputPath('sns', 'md');
    const textPath = savePath.replace(/\.md$/i, '.txt');
    const platformRule: Record<string, string> = {
      instagram: '인스타그램 캡션: 150-200자 + 해시태그 10-15개',
      threads: '쓰레드: 짧은 단락 2-3개 (각 100자 이내), 해시태그 5개',
      x: 'X(트위터): 280자 이내 1포스트, 해시태그 2-3개',
      facebook: '페이스북: 200-300자 본문, 해시태그 3-5개',
    };
    await sendMarkdownJob(`Write SNS post (${snsPlatform})`, 'sns-post', `[역할] 한국어 SNS 마케터입니다.

[작업 절차]
1. 다음 조건의 SNS 게시글을 작성하세요.
2. 결과 전체를 ${savePath}에 저장하세요.
3. 복사/붙여넣기 쉬운 일반 텍스트 버전도 ${textPath}에 저장하세요.
4. 저장 후 두 파일 경로만 출력하세요.

[플랫폼] ${snsPlatform}
[주제] ${snsTopic.trim()}

[출력 규칙]
- ${platformRule[snsPlatform] || ''}
- 친근하고 공감되는 톤
- 마지막에 가벼운 CTA
- 이모지 적절히
- TXT 버전은 플랫폼에 바로 붙여넣을 최종 게시글만 포함
- TXT 버전에는 설명, 섹션 제목, 마크다운 기호 없이 캡션/본문/해시태그만 정리
${brandSection(brand, activeBrandMdPath)}
${materialSection()}
[저장 경로]
- Markdown: ${savePath}
- Text: ${textPath}`, savePath);
  }, [activeBrandMdPath, snsTopic, snsPlatform, brand, projectRoot, outputPath, materialSection, sendMarkdownJob]);

  const activeTabMeta = TABS.find((t) => t.id === tab) || TABS[0];

  // ─── UI ───
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: theme.bg, color: theme.text }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: `1px solid ${theme.text}14`,
        display: 'grid',
        gridTemplateColumns: 'minmax(188px, 236px) minmax(0, 1fr) auto',
        alignItems: 'center',
        gap: 12,
        background: `linear-gradient(180deg, ${theme.text}08 0%, ${theme.bg} 100%)`,
        boxShadow: `inset 0 -1px 0 ${theme.text}06`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{
            width: 34,
            height: 34,
            borderRadius: 'var(--brutal-radius)',
            display: 'grid',
            placeItems: 'center',
            color: theme.accent,
            background: `${theme.accent}18`,
            border: `1px solid ${theme.accent}38`,
            boxShadow: `0 8px 22px ${theme.accent}18`,
            flex: '0 0 auto',
          }}>
            <Palette size={17} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.1, whiteSpace: 'nowrap' }}>Design Content</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: `${theme.text}72`, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Brand · Prompts · Production output
            </div>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Design content tabs"
          style={{
            display: 'flex',
            gap: 6,
            minWidth: 0,
            overflowX: 'auto',
            padding: '2px',
            scrollbarWidth: 'none',
          }}
        >
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={t.label}
                onClick={() => setTab(t.id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  minHeight: 34,
                  padding: '0 12px',
                  borderRadius: 'var(--brutal-radius)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 800,
                  whiteSpace: 'nowrap',
                  flex: '0 0 auto',
                  background: active ? theme.accent : `${theme.text}08`,
                  color: active ? '#ffffff' : `${theme.text}86`,
                  border: `1px solid ${active ? theme.accent : `${theme.text}14`}`,
                  boxShadow: active ? `0 8px 22px ${theme.accent}30` : 'none',
                  transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
                }}
              >
                <span style={{ display: 'inline-flex', color: active ? '#ffffff' : theme.accent }}>{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          minHeight: 32,
          padding: '0 10px',
          borderRadius: 'var(--brutal-radius)',
          fontSize: 10,
          fontWeight: 800,
          color: `${theme.text}76`,
          background: `${theme.text}07`,
          border: `1px solid ${theme.text}12`,
          whiteSpace: 'nowrap',
        }}>
          <span style={{ display: 'inline-flex', color: theme.accent }}>{activeTabMeta.icon}</span>
          <span>design/{tab}/</span>
        </div>
      </div>

      {/* Body: only inputs — no preview iframe (uses BBARIT's native viewer). */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {tab !== 'brand' && tab !== 'prompts' && tab !== 'image' && (
          <div style={{ maxWidth: 720, marginBottom: 14, padding: 12, border: `1px solid ${theme.text}16`, borderRadius: 'var(--brutal-radius)', background: `${theme.text}05` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <FileUp size={14} style={{ color: theme.accent }} />
              <div style={{ fontSize: 12, fontWeight: 800, marginRight: 'auto' }}>Shared reference material</div>
              <button type="button" onClick={importSelectedMaterial} disabled={materialBusy || (!selectedFilePaths.length && !activeFilePath)}
                style={miniBtn(theme, materialBusy || (!selectedFilePaths.length && !activeFilePath))}>
                <FileUp size={12} /> Selected files
              </button>
              <button type="button" onClick={importOpenMaterials} disabled={materialBusy || (!openFilePaths.length && !activeFilePath)}
                style={miniBtn(theme, materialBusy || (!openFilePaths.length && !activeFilePath))}>
                <FolderOpen size={12} /> Open files
              </button>
              <button type="button" onClick={() => { setSharedMaterial(''); setMaterialPaths([]); setStatus('Cleared reference material.'); }} disabled={materialBusy || (!sharedMaterial.trim() && materialPaths.length === 0)}
                style={miniBtn(theme, materialBusy || (!sharedMaterial.trim() && materialPaths.length === 0))}>
                <Trash2 size={12} /> Clear
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, marginBottom: 10 }}>
              <textarea
                value={materialSource}
                onChange={(e) => setMaterialSource(e.target.value)}
                rows={3}
                placeholder="Paste multiple URLs, YouTube links, product descriptions, customer reviews, competitor copy, etc., then create a material file with the buttons below."
                style={{ ...ta(theme), minHeight: 74 }}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => void crawlUrlsToMaterial()} disabled={materialBusy || extractUrls(materialSource).length === 0}
                  style={miniBtn(theme, materialBusy || extractUrls(materialSource).length === 0)}>
                  <Link2 size={12} /> Crawl URLs
                </button>
                <button type="button" onClick={() => void makeYoutubeMaterial()} disabled={materialBusy || !/youtu\.be|youtube\.com/i.test(materialSource)}
                  style={miniBtn(theme, materialBusy || !/youtu\.be|youtube\.com/i.test(materialSource))}>
                  <Youtube size={12} /> YouTube material
                </button>
                <button type="button" onClick={() => void makeTextMaterial()} disabled={materialBusy || !materialSource.trim()}
                  style={miniBtn(theme, materialBusy || !materialSource.trim())}>
                  <ClipboardList size={12} /> Text material
                </button>
                <button type="button" onClick={() => void makeSelectedFilesMaterial()} disabled={materialBusy || (!selectedFilePaths.length && !openFilePaths.length && !activeFilePath)}
                  style={miniBtn(theme, materialBusy || (!selectedFilePaths.length && !openFilePaths.length && !activeFilePath))}>
                  <FileText size={12} /> Files to material
                </button>
                <button type="button" onClick={() => void makeCreativeMaterial('cardnews')} disabled={materialBusy || (!materialSource.trim() && !sharedMaterial.trim())}
                  style={miniBtn(theme, materialBusy || (!materialSource.trim() && !sharedMaterial.trim()))}>
                  <Newspaper size={12} /> Card news material
                </button>
                <button type="button" onClick={() => void makeCreativeMaterial('image')} disabled={materialBusy || (!materialSource.trim() && !sharedMaterial.trim())}
                  style={miniBtn(theme, materialBusy || (!materialSource.trim() && !sharedMaterial.trim()))}>
                  <Palette size={12} /> Image material
                </button>
                <button type="button" onClick={() => void makeCreativeMaterial('video')} disabled={materialBusy || (!materialSource.trim() && !sharedMaterial.trim())}
                  style={miniBtn(theme, materialBusy || (!materialSource.trim() && !sharedMaterial.trim()))}>
                  <Film size={12} /> Video material
                </button>
              </div>
            </div>
            <textarea
              value={sharedMaterial}
              onChange={(e) => setSharedMaterial(e.target.value)}
              rows={4}
              placeholder="Select a material file in the file tree and click 'Selected files', or paste reference articles / product info / customer reviews / image paths. This content is automatically applied to all generation prompts."
              style={{ ...ta(theme), minHeight: 96 }}
            />
            <div style={{ marginTop: 6, fontSize: 10, opacity: 0.55, lineHeight: 1.6 }}>
              {materialPaths.length > 0
                ? `${materialPaths.length} imported file(s): ${materialPaths.slice(0, 3).map(relativeProjectPath).join(', ')}${materialPaths.length > 3 ? ` and ${materialPaths.length - 3} more` : ''}`
                : 'Selected files use the file tree selection first, falling back to the current editor file.'}
            </div>

            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${theme.text}12`, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <Sparkles size={13} style={{ color: theme.accent }} />
                <div style={{ fontSize: 12, fontWeight: 800, marginRight: 'auto' }}>Image · Video API generation</div>
                <button type="button" onClick={() => void generateImageDirect()} disabled={mediaBusy}
                  style={miniBtn(theme, mediaBusy)}>
                  <Palette size={12} /> Codex image
                </button>
                <button type="button" onClick={() => void callMediaApi('image')} disabled={mediaBusy || !mediaApiUrl.trim()}
                  style={miniBtn(theme, mediaBusy || !mediaApiUrl.trim())}>
                  <Link2 size={12} /> Image API
                </button>
                <button type="button" onClick={() => void callMediaApi('video')} disabled={mediaBusy || !mediaApiUrl.trim()}
                  style={miniBtn(theme, mediaBusy || !mediaApiUrl.trim())}>
                  <Film size={12} /> Video API
                </button>
              </div>
              <textarea
                value={mediaPrompt}
                onChange={(e) => setMediaPrompt(e.target.value)}
                rows={2}
                placeholder="Enter image/video generation instructions. If left empty, the current tab's topic and shared reference material are used automatically."
                style={{ ...ta(theme), minHeight: 62 }}
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 190px', gap: 8 }}>
                <input
                  type="text"
                  value={mediaApiUrl}
                  onChange={(e) => setMediaApiUrl(e.target.value)}
                  placeholder="Image/video generation API URL (e.g. https://api.example.com/generate)"
                  style={inp(theme)}
                />
                <input
                  type="text"
                  value={mediaApiKeyEnv}
                  onChange={(e) => setMediaApiKeyEnv(e.target.value)}
                  placeholder="KEY env"
                  style={inp(theme)}
                />
              </div>
              <div style={{ fontSize: 10, opacity: 0.55, lineHeight: 1.6 }}>
                Codex image generation creates the result image location and prompt file, then sends them to the active terminal. The API buttons leave payload/response in <code>makeke/api</code>, and read the key by the env variable name from <code>~/.config/octo/.env</code>.
              </div>
            </div>
          </div>
        )}

        {tab === 'design' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Request">
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4}
                placeholder="e.g. A premium, trustworthy promo for a new dermatology clinic event"
                style={ta(theme)} />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <Select label="Type" value={kind} onChange={setKind} opts={KINDS} theme={theme} />
              <Select label="Ratio" value={aspect} onChange={setAspect} opts={ASPECT_RATIOS} theme={theme} />
              <Select label="Style" value={style} onChange={setStyle} opts={STYLES} theme={theme} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <Input label="Brand name" value={brandName} onChange={setBrandName} theme={theme} />
              <Input label="CTA" value={ctaText} onChange={setCtaText} placeholder="Book now" theme={theme} />
            </div>
            <ColorPaletteField label="Brand color palette" value={brandColors} onChange={setBrandColors} theme={theme} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 4 }}><Layers size={12} /> Variations</span>
              {[1, 2, 3, 4].map((n) => (
                <button key={n} type="button" onClick={() => setVariationCount(n)}
                  style={{
                    width: 30, height: 28, borderRadius: 'var(--brutal-radius)', cursor: 'pointer',
                    border: `1px solid ${variationCount === n ? theme.accent : `${theme.text}22`}`,
                    background: variationCount === n ? theme.accent : 'transparent',
                    color: variationCount === n ? '#fff' : theme.text, fontSize: 12, fontWeight: 700,
                  }}>{n}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => void runDesignStudio()} disabled={!prompt.trim() || designAgent.busy}
                style={{
                  flex: 1, minWidth: 220, padding: '10px 14px', borderRadius: 'var(--brutal-radius)', border: 0,
                  cursor: !prompt.trim() || designAgent.busy ? 'not-allowed' : 'pointer',
                  background: !prompt.trim() || designAgent.busy ? `${theme.text}18` : theme.accent,
                  color: !prompt.trim() || designAgent.busy ? `${theme.text}60` : '#fff',
                  fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}>
                {designAgent.busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                {designAgent.busy ? 'Designing…' : `Generate with 빠릿디자인${variationCount > 1 ? ` ×${variationCount}` : ''}`}
              </button>
              <button type="button" onClick={handleGenerateDesign} disabled={!prompt.trim()}
                title="Send a job to the active terminal instead of the built-in design agent"
                style={{
                  padding: '10px 12px', borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}22`,
                  cursor: !prompt.trim() ? 'not-allowed' : 'pointer', background: 'transparent',
                  color: `${theme.text}${!prompt.trim() ? '55' : 'cc'}`, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
                }}>
                Send to terminal
              </button>
            </div>
            {(designAgent.busy || designAgent.status === 'starting') && (
              <div style={{ fontSize: 11, opacity: 0.7, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={12} className="spin" />
                {designAgent.status === 'starting' ? 'Starting the design agent…' : (designAgent.activity || 'Working…')}
              </div>
            )}

            {selectedDesign && selectedDesign.paths.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Eye size={12} /> Live preview{selectedDesign.paths.length > 1 ? ` · ${selectedDesign.paths.length} variations` : ''}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: selectedDesign.paths.length > 1 ? 'repeat(2, 1fr)' : '1fr', gap: 8 }}>
                  {selectedDesign.paths.map((p, i) => (
                    <div key={p} style={{ border: `1px solid ${targetFile === p ? theme.accent : `${theme.text}18`}`, borderRadius: 'var(--brutal-radius)', overflow: 'hidden', background: '#fff' }}>
                      <iframe title={`design-${i}`} src={`${convertFileSrc(p)}?t=${previewNonce}`}
                        style={{ width: '100%', height: 200, border: 0, display: 'block', pointerEvents: 'none' }} />
                      <div style={{ display: 'flex', gap: 4, padding: 6, background: `${theme.text}08` }}>
                        <button type="button" onClick={() => { setTargetFile(p); onOpenFile?.(p); }}
                          style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: 0, cursor: 'pointer', background: targetFile === p ? theme.accent : `${theme.text}18`, color: targetFile === p ? '#fff' : theme.text, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                          <Wand2 size={11} /> {selectedDesign.paths.length > 1 ? `Edit v${i + 1}` : 'Open & edit'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {designHistory.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.6, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}><History size={11} /> History</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {designHistory.map((d) => (
                    <button key={d.id} type="button" onClick={() => setSelectedDesignId(d.id)}
                      title={d.prompt}
                      style={{
                        maxWidth: 180, padding: '5px 9px', borderRadius: 999, cursor: 'pointer',
                        border: `1px solid ${selectedDesignId === d.id ? theme.accent : `${theme.text}22`}`,
                        background: selectedDesignId === d.id ? `${theme.accent}22` : 'transparent',
                        color: theme.text, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>
                      {d.prompt.slice(0, 22) || 'design'}{d.paths.length > 1 ? ` ·${d.paths.length}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 18, padding: 12, background: `${theme.text}06`, border: `1px solid ${theme.text}18`, borderRadius: 'var(--brutal-radius)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.75, marginBottom: 8 }}>✎ Edit selected design</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <input type="text" value={targetFile} onChange={(e) => setTargetFile(e.target.value)}
                  placeholder="File path to edit (copy from the left file tree or auto-filled)"
                  style={{ ...inp(theme), flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="text" value={editInstruction} onChange={(e) => setEditInstruction(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void runDesignEditAgent(); }}
                  placeholder="e.g. Make the headline bigger, emphasize blue"
                  style={{ ...inp(theme), flex: 1 }} />
                <button type="button" onClick={() => void runDesignEditAgent()} disabled={!editInstruction.trim() || !targetFile.trim() || designAgent.busy}
                  style={{
                    padding: '7px 12px', borderRadius: 'var(--brutal-radius)', border: 0,
                    cursor: !editInstruction.trim() || !targetFile.trim() || designAgent.busy ? 'not-allowed' : 'pointer',
                    background: !editInstruction.trim() || !targetFile.trim() || designAgent.busy ? `${theme.text}15` : theme.accent,
                    color: !editInstruction.trim() || !targetFile.trim() || designAgent.busy ? `${theme.text}60` : '#fff',
                    fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
                  }}>
                  {designAgent.busy ? <Loader2 size={12} className="spin" /> : <Send size={12} />} Edit
                </button>
              </div>
              <div style={{ fontSize: 10, opacity: 0.5, marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                <ChevronRight size={9} /> Edits go through 빠릿디자인 and only change what you ask; the preview refreshes on its own. The path auto-fills after generating or picking from history.
              </div>
            </div>
          </div>
        )}

        {tab === 'image' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) minmax(0, 1fr)', gap: 14, maxWidth: 1120, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start', padding: 3, borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}18`, background: `${theme.text}06` }}>
                <button
                  type="button"
                  onClick={() => setImageCodexMode('generate')}
                  style={segmentBtn(theme, imageCodexMode === 'generate')}
                >
                  <ImagePlus size={12} /> New image
                </button>
                <button
                  type="button"
                  onClick={() => setImageCodexMode('edit')}
                  disabled={!selectedImageCodexItem}
                  style={segmentBtn(theme, imageCodexMode === 'edit', !selectedImageCodexItem)}
                >
                  <Wand2 size={12} /> Edit selected image
                </button>
              </div>

              <Field label="Prompt">
                <textarea
                  value={imageCodexPrompt}
                  onChange={(e) => setImageCodexPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void runImageCodex();
                  }}
                  rows={7}
                  placeholder={imageCodexMode === 'edit' ? 'e.g. Keep the background, make the product larger, reduce whitespace, premium lighting' : 'e.g. A 16:9 banner announcing a new BBARIT Terminal feature, dark IDE screen with a sharp CTA'}
                  style={{ ...ta(theme), minHeight: 150 }}
                />
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 132px', gap: 8 }}>
                <Input label="File name (optional)" value={imageCodexFileName} onChange={setImageCodexFileName} placeholder="hero-banner" theme={theme} />
                <div>
                  <label style={lbl}>Save location</label>
                  <div style={{ ...readonlyPill(theme), minHeight: 32 }}>makeke/image</div>
                </div>
              </div>

              <div style={{ border: `1px solid ${theme.text}16`, borderRadius: 'var(--brutal-radius)', padding: 10, background: `${theme.text}05`, display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <ImagePlus size={13} style={{ color: theme.accent }} />
                  <div style={{ fontSize: 12, fontWeight: 800, marginRight: 'auto' }}>Reference images</div>
                  <input
                    ref={imageCodexFileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => void handleImageCodexFileUpload(e.target.files)}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    onClick={() => imageCodexFileInputRef.current?.click()}
                    disabled={imageCodexBusy || imageCodexRefs.length >= MAX_IMAGE_CODEX_REFERENCES}
                    style={miniBtn(theme, imageCodexBusy || imageCodexRefs.length >= MAX_IMAGE_CODEX_REFERENCES)}
                  >
                    <Plus size={12} /> Upload
                  </button>
                  <button
                    type="button"
                    onClick={() => void importSelectedImageReferences()}
                    disabled={imageCodexBusy}
                    style={miniBtn(theme, imageCodexBusy)}
                  >
                    <FileUp size={12} /> Selected images
                  </button>
                  <button
                    type="button"
                    onClick={() => setImageCodexRefs([])}
                    disabled={imageCodexBusy || imageCodexRefs.length === 0}
                    style={miniBtn(theme, imageCodexBusy || imageCodexRefs.length === 0)}
                  >
                    <Trash2 size={12} /> Clear
                  </button>
                </div>
                {imageCodexRefs.length === 0 ? (
                  <div style={{ fontSize: 10, color: `${theme.text}58`, lineHeight: 1.5 }}>
                    Add product photos, logos, style examples, or previous results as references. Up to {MAX_IMAGE_CODEX_REFERENCES} are sent together.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 7 }}>
                    {imageCodexRefs.map((ref) => (
                      <div key={ref.id} title={ref.path || ref.name} style={{ position: 'relative', minWidth: 0 }}>
                        <img src={ref.dataUrl} alt="" style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}16`, display: 'block', background: theme.bg }} />
                        <button
                          type="button"
                          onClick={() => removeImageCodexReference(ref.id)}
                          disabled={imageCodexBusy}
                          title="Remove reference"
                          style={{ position: 'absolute', right: 4, top: 4, width: 20, height: 20, borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}18`, background: `${theme.bg}e6`, color: theme.text, display: 'grid', placeItems: 'center', cursor: imageCodexBusy ? 'not-allowed' : 'pointer' }}
                        >
                          <Trash2 size={11} />
                        </button>
                        <div style={{ marginTop: 4, fontSize: 9, fontWeight: 800, color: `${theme.text}68`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Field label="Reference material">
                <textarea
                  value={sharedMaterial}
                  onChange={(e) => setSharedMaterial(e.target.value)}
                  rows={5}
                  placeholder="Paste brand description, image direction, product info, reference URLs, existing image paths, etc."
                  style={{ ...ta(theme), minHeight: 110 }}
                />
              </Field>

              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <button type="button" onClick={importSelectedMaterial} disabled={imageCodexBusy || materialBusy || (!selectedFilePaths.length && !activeFilePath)}
                  style={miniBtn(theme, imageCodexBusy || materialBusy || (!selectedFilePaths.length && !activeFilePath))}>
                  <FileUp size={12} /> Selected files
                </button>
                <button type="button" onClick={importOpenMaterials} disabled={imageCodexBusy || materialBusy || (!openFilePaths.length && !activeFilePath)}
                  style={miniBtn(theme, imageCodexBusy || materialBusy || (!openFilePaths.length && !activeFilePath))}>
                  <FolderOpen size={12} /> Open files
                </button>
                <button type="button" onClick={() => { setSharedMaterial(''); setMaterialPaths([]); setStatus('Cleared reference material.'); }} disabled={imageCodexBusy || materialBusy || (!sharedMaterial.trim() && materialPaths.length === 0)}
                  style={miniBtn(theme, imageCodexBusy || materialBusy || (!sharedMaterial.trim() && materialPaths.length === 0))}>
                  <Trash2 size={12} /> Clear
                </button>
              </div>

              <ActionBtn onClick={() => void runImageCodex()} disabled={imageCodexBusy || (imageCodexMode === 'edit' && !selectedImageCodexItem)} icon={imageCodexBusy ? <RefreshCw size={14} /> : <Sparkles size={14} />} theme={theme}>
                {imageCodexBusy ? 'Preparing image job...' : imageCodexMode === 'edit' ? 'Request edit using selected image path' : 'Create image path and send to Codex'}
              </ActionBtn>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10, minWidth: 0 }}>
              <div style={{ border: `1px solid ${theme.text}18`, borderRadius: 'var(--brutal-radius)', overflow: 'hidden', background: `${theme.text}05`, minHeight: 340 }}>
                <div style={{ padding: 10, borderBottom: `1px solid ${theme.text}14`, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Eye size={13} style={{ color: theme.accent }} />
                  <span style={{ fontSize: 12, fontWeight: 800, marginRight: 'auto' }}>{selectedImageCodexItem ? fileNameFromPath(selectedImageCodexItem.imagePath) : 'Preview'}</span>
                  {selectedImageCodexItem && (
                    <>
                      <button type="button" onClick={() => onOpenFile?.(selectedImageCodexItem.imagePath)} style={miniBtn(theme)}>
                        <Eye size={12} /> Open
                      </button>
                      <button type="button" onClick={() => onOpenFile?.(selectedImageCodexItem.promptPath)} style={miniBtn(theme)}>
                        <FileText size={12} /> Prompt
                      </button>
                      <button type="button" onClick={resendSelectedImageCodex} style={miniBtn(theme)}>
                        <Send size={12} /> Resend
                      </button>
                    </>
                  )}
                </div>
                <div style={{ minHeight: 300, display: 'grid', placeItems: 'center', padding: 12, background: `${theme.text}03` }}>
                  {selectedImageCodexItem ? (
                    selectedImageCodexSrc ? (
                      <img
                        src={selectedImageCodexSrc}
                        alt=""
                        style={{ maxWidth: '100%', maxHeight: 460, objectFit: 'contain', borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}14`, background: theme.bg }}
                      />
                    ) : (
                      <div style={{ width: '100%', maxWidth: 420, aspectRatio: '16 / 10', borderRadius: 'var(--brutal-radius)', border: `1px dashed ${theme.text}24`, display: 'grid', placeItems: 'center', color: `${theme.text}55`, fontSize: 12, fontWeight: 800 }}>
                        Waiting for Codex job
                      </div>
                    )
                  ) : (
                    <div style={{ width: '100%', maxWidth: 420, aspectRatio: '16 / 10', borderRadius: 'var(--brutal-radius)', border: `1px dashed ${theme.text}24`, display: 'grid', placeItems: 'center', color: `${theme.text}55`, fontSize: 12, fontWeight: 800 }}>
                      No image
                    </div>
                  )}
                </div>
                {selectedImageCodexItem && (
                  <div style={{ padding: 10, borderTop: `1px solid ${theme.text}12`, display: 'grid', gap: 4, fontSize: 10, color: `${theme.text}68`, lineHeight: 1.55 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Image: {selectedImageCodexItem.imagePath}</div>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Prompt: {selectedImageCodexItem.promptPath}</div>
                  </div>
                )}
              </div>

              <div style={{ border: `1px solid ${theme.text}18`, borderRadius: 'var(--brutal-radius)', overflow: 'hidden', background: `${theme.text}05` }}>
                <div style={{ padding: 10, borderBottom: `1px solid ${theme.text}14`, display: 'flex', alignItems: 'center', gap: 7 }}>
                  <History size={13} style={{ color: theme.accent }} />
                  <span style={{ fontSize: 12, fontWeight: 800, marginRight: 'auto' }}>History</span>
                  {imageCodexHistory.length > 0 && (
                    <button type="button" onClick={clearImageCodexHistory} style={miniBtn(theme)}>
                      <Trash2 size={12} /> Clear
                    </button>
                  )}
                </div>
                {imageCodexHistory.length === 0 ? (
                  <div style={{ padding: 16, fontSize: 11, color: `${theme.text}58` }}>No images generated yet.</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, padding: 10, maxHeight: 310, overflowY: 'auto' }}>
                    {imageCodexHistory.map((item) => {
                      const active = item.id === selectedImageCodexId;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => { setSelectedImageCodexId(item.id); setImageCodexMode('edit'); }}
                          title={item.imagePath}
                          style={{
                            border: `1px solid ${active ? theme.accent : `${theme.text}16`}`,
                            background: active ? `${theme.accent}14` : `${theme.text}04`,
                            color: theme.text,
                            borderRadius: 'var(--brutal-radius)',
                            padding: 6,
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'grid',
                            gap: 6,
                          }}
                        >
                          <span style={{ position: 'relative', display: 'block', aspectRatio: '1 / 1', overflow: 'hidden', borderRadius: 'var(--brutal-radius)', background: theme.bg }}>
                            <img src={item.dataUrl || convertFileSrc(item.imagePath)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                            <span style={{ position: 'absolute', right: 5, top: 5, width: 20, height: 20, borderRadius: 'var(--brutal-radius)', display: 'grid', placeItems: 'center', background: `${theme.bg}dd`, color: theme.accent }}>
                              {lastSavedImageCodexId === item.id ? <CheckCircle2 size={12} /> : item.mode === 'edit' ? <Wand2 size={12} /> : <ImagePlus size={12} />}
                            </span>
                          </span>
                          <span style={{ fontSize: 10, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {fileNameFromPath(item.imagePath)}
                          </span>
                          <span style={{ fontSize: 9, opacity: 0.55 }}>
                            {new Date(item.createdAt).toLocaleString()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'model3d' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }}>
            <Field label="3D model request">
              <textarea
                value={model3dPrompt}
                onChange={(e) => setModel3dPrompt(e.target.value)}
                rows={5}
                placeholder="e.g. Make a GLB and HTML viewer so I can spin our new product in a 3DCellForge-style WebGL workbench"
                style={ta(theme)}
              />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <Select label="Provider" value={model3dProvider} onChange={setModel3dProvider} opts={MODEL3D_PROVIDERS} theme={theme} />
              <Select label="Style" value={model3dStyle} onChange={setModel3dStyle} opts={MODEL3D_STYLES} theme={theme} />
            </div>
            <Input label="File name (optional)" value={model3dOutputName} onChange={setModel3dOutputName} placeholder="product-or-cell-model" theme={theme} />
            <div>
              <label style={lbl}>Reference image/GLB/GLTF absolute path</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <input
                  type="text"
                  value={model3dReferencePath}
                  onChange={(e) => setModel3dReferencePath(e.target.value)}
                  placeholder="Enter an image, .glb, or .gltf path selected in the file tree"
                  style={inp(theme)}
                />
                <button
                  type="button"
                  onClick={() => setModel3dReferencePath((selectedFilePaths[0] || activeFilePath || model3dReferencePath || '').trim())}
                  disabled={!selectedFilePaths[0] && !activeFilePath}
                  style={{ ...miniBtn(theme, !selectedFilePaths[0] && !activeFilePath), height: 32 }}
                >
                  <FileUp size={12} /> Selected file
                </button>
              </div>
            </div>
            <ActionBtn onClick={handleGenerate3DModel} disabled={!model3dPrompt.trim()} icon={<Box size={14} />} theme={theme}>Create 3D job MD and send</ActionBtn>
            <div style={{ fontSize: 10, color: `${theme.text}62`, lineHeight: 1.6 }}>
              Applies the 3DCellForge workbench approach as a BBARIT MD job. The job file is saved to <code>makeke/prompts/jobs</code>, and Codex is instructed to generate the GLB/viewer/report in <code>makeke/model3d</code>.
            </div>
          </div>
        )}

        {tab === 'blog' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Topic">
              <textarea value={blogTopic} onChange={(e) => setBlogTopic(e.target.value)} rows={4}
                placeholder="e.g. Attracting new dermatology patients, spring marketing, targeting women in their 30s" style={ta(theme)} />
            </Field>
            <Input label="Tone" value={blogTone} onChange={setBlogTone} theme={theme} />
            <ActionBtn onClick={handleBlog} disabled={!blogTopic.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'cardnews' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Topic">
              <textarea value={cnTopic} onChange={(e) => setCnTopic(e.target.value)} rows={4}
                placeholder="e.g. Announcing the company's new product launch" style={ta(theme)} />
            </Field>
            <div style={{ maxWidth: 160 }}>
              <label style={lbl}>Slide count</label>
              <input type="number" min={3} max={15} value={cnSlides}
                onChange={(e) => setCnSlides(Math.max(3, Math.min(15, Number(e.target.value) || 5)))} style={inp(theme)} />
            </div>
            <ActionBtn onClick={handleCardnews} disabled={!cnTopic.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'sns' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Topic">
              <textarea value={snsTopic} onChange={(e) => setSnsTopic(e.target.value)} rows={4}
                placeholder="e.g. New menu launch / event announcement" style={ta(theme)} />
            </Field>
            <div style={{ maxWidth: 220 }}>
              <label style={lbl}>Platform</label>
              <select value={snsPlatform} onChange={(e) => setSnsPlatform(e.target.value)} style={inp(theme)}>
                <option value="instagram">Instagram</option>
                <option value="threads">Threads</option>
                <option value="x">X (Twitter)</option>
                <option value="facebook">Facebook</option>
              </select>
            </div>
            <ActionBtn onClick={handleSns} disabled={!snsTopic.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'comic' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Topic/Story">
              <textarea value={comicTopic} onChange={(e) => setComicTopic(e.target.value)} rows={4}
                placeholder="e.g. A day where an office worker halved their design time with BBARIT" style={ta(theme)} />
            </Field>
            <div style={{ maxWidth: 160 }}>
              <label style={lbl}>Panel count</label>
              <input type="number" min={3} max={12} value={comicPanels}
                onChange={(e) => setComicPanels(Math.max(3, Math.min(12, Number(e.target.value) || 4)))} style={inp(theme)} />
            </div>
            <ActionBtn onClick={handleComic} disabled={!comicTopic.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'detail' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Input label="Product/Service name" value={detailProduct} onChange={setDetailProduct} placeholder="e.g. Design service" theme={theme} />
            <Field label="Key selling points (optional)">
              <textarea value={detailHighlights} onChange={(e) => setDetailHighlights(e.target.value)} rows={4}
                placeholder="Advantages, differentiators, social proof, etc." style={ta(theme)} />
            </Field>
            <ActionBtn onClick={handleDetail} disabled={!detailProduct.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'video' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Field label="Topic">
              <textarea value={videoTopic} onChange={(e) => setVideoTopic(e.target.value)} rows={4}
                placeholder="e.g. 50% off event for new members" style={ta(theme)} />
            </Field>
            <div style={{ maxWidth: 160 }}>
              <label style={lbl}>Video length (seconds)</label>
              <input type="number" min={10} max={90} step={5} value={videoSeconds}
                onChange={(e) => setVideoSeconds(Math.max(10, Math.min(90, Number(e.target.value) || 30)))} style={inp(theme)} />
            </div>
            <ActionBtn onClick={handleVideo} disabled={!videoTopic.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'trend' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
            <Input label="Keyword/Topic" value={trendKeyword} onChange={setTrendKeyword} placeholder="e.g. Spring marketing trends" theme={theme} />
            <Field label="Reference material (optional)">
              <textarea value={trendBody} onChange={(e) => setTrendBody(e.target.value)} rows={6}
                placeholder="Paste articles/research/internal docs and a multi-channel content set reflecting them is generated at once" style={ta(theme)} />
            </Field>
            <ActionBtn onClick={handleTrend} disabled={!trendKeyword.trim()} icon={<Sparkles size={14} />} theme={theme}>Create job MD and send</ActionBtn>
          </div>
        )}

        {tab === 'brand' && (
          <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 12, maxWidth: 1040, alignItems: 'start' }}>
            <div style={{ border: `1px solid ${theme.text}18`, borderRadius: 'var(--brutal-radius)', overflow: 'hidden', background: `${theme.text}05` }}>
              <div style={{ padding: 10, borderBottom: `1px solid ${theme.text}14`, display: 'flex', alignItems: 'center', gap: 6 }}>
                <UserCircle2 size={13} style={{ color: theme.accent }} />
                <span style={{ fontSize: 12, fontWeight: 800 }}>Select brand</span>
                <button type="button" onClick={() => void refreshBrandFiles()} title="Refresh" style={{ ...miniBtn(theme), marginLeft: 'auto' }}>
                  <RefreshCw size={12} />
                </button>
              </div>
              <div style={{ padding: 8, display: 'flex', gap: 6, borderBottom: `1px solid ${theme.text}14` }}>
                <input
                  type="text"
                  value={newBrandName}
                  onChange={(e) => setNewBrandName(e.target.value)}
                  placeholder="New brand name"
                  style={{ ...inp(theme), flex: 1, minWidth: 0 }}
                />
                <button type="button" onClick={startNewBrand} title="New brand" style={{ width: 32, borderRadius: 'var(--brutal-radius)', border: 0, background: theme.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <Plus size={14} />
                </button>
              </div>
              <div style={{ padding: 6, display: 'grid', gap: 4, maxHeight: 460, overflowY: 'auto' }}>
                <button
                  type="button"
                  onClick={() => brandProfilePath && void loadBrandFile(brandProfilePath)}
                  style={{
                    ...miniBtn(theme),
                    justifyContent: 'flex-start',
                    borderColor: activeBrandPath === brandProfilePath ? theme.accent : `${theme.text}18`,
                    background: activeBrandPath === brandProfilePath ? `${theme.accent}18` : 'transparent',
                  }}
                >
                  <UserCircle2 size={12} /> Currently applied brand
                </button>
                {brandFiles.length === 0 ? (
                  <div style={{ padding: 9, fontSize: 10, color: `${theme.text}58`, lineHeight: 1.55 }}>No saved brands. Save one on the right to add it to the list.</div>
                ) : brandFiles.map((file) => (
                  <div key={file.path} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 30px', gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => void loadBrandFile(file.path)}
                      title={file.path}
                      style={{
                        ...miniBtn(theme),
                        justifyContent: 'flex-start',
                        minWidth: 0,
                        borderColor: activeBrandPath === file.path ? theme.accent : `${theme.text}18`,
                        background: activeBrandPath === file.path ? `${theme.accent}18` : 'transparent',
                      }}
                    >
                      <FileText size={12} /> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name.replace(/\.(md|json)$/i, '')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteBrandFile(file.path)}
                      title="Delete brand"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 'var(--brutal-radius)',
                        border: `1px solid ${theme.text}18`,
                        background: activeBrandPath === file.path ? `${theme.accent}12` : 'transparent',
                        color: theme.text,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4, lineHeight: 1.6 }}>
                Selecting a brand attaches its name, colors, CTA, tone, industry, description, and forbidden/recommended rules in full to all design/image/blog/video prompts.
              </div>
              <Input label="Brand name" value={brand.name} onChange={(v) => updateBrand({ name: v })} placeholder="e.g. Design brand" theme={theme} />
              <BrandColorRolesEditor brand={brand} onChange={updateBrand} theme={theme} />
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'end' }}>
                <Input label="Industry" value={brand.businessType} onChange={(v) => updateBrand({ businessType: v })} placeholder="e.g. Dermatology, cafe, SaaS" theme={theme} />
                <button
                  type="button"
                  onClick={fillBrandFromIndustry}
                  disabled={!brand.name.trim() && !brand.businessType.trim() && !brand.businessDesc.trim() && !newBrandName.trim()}
                  style={{ ...miniBtn(theme, !brand.name.trim() && !brand.businessType.trim() && !brand.businessDesc.trim() && !newBrandName.trim()), height: 32, justifyContent: 'center' }}
                >
                  <Sparkles size={12} /> AI auto-fill
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Input label="Default CTA" value={brand.cta} onChange={(v) => updateBrand({ cta: v })} placeholder="Book now" theme={theme} />
                <Input label="Core audience" value={brand.audience} onChange={(v) => updateBrand({ audience: v })} placeholder="e.g. Office workers in their 30s, local customers" theme={theme} />
              </div>
              <Input label="Default tone" value={brand.tone} onChange={(v) => updateBrand({ tone: v })} placeholder="e.g. Friendly and trustworthy" theme={theme} />
              <Input label="Positioning" value={brand.positioning} onChange={(v) => updateBrand({ positioning: v })} placeholder="What kind of choice the brand is for customers" theme={theme} />
              <Input label="Brand personality" value={brand.personality} onChange={(v) => updateBrand({ personality: v })} placeholder="e.g. Fast, meticulous, professional, hospitable" theme={theme} />
              <Input label="Visual keywords" value={brand.visualKeywords} onChange={(v) => updateBrand({ visualKeywords: v })} placeholder="e.g. Clean whitespace, real screens, premium lighting" theme={theme} />
              <Field label="Business description">
                <textarea value={brand.businessDesc} onChange={(e) => updateBrand({ businessDesc: e.target.value })} rows={3}
                  placeholder="Customers / core value / our unique strengths" style={ta(theme)} />
              </Field>
              <Field label="Content pillars">
                <textarea value={brand.contentPillars} onChange={(e) => updateBrand({ contentPillars: e.target.value })} rows={4}
                  placeholder={'e.g.\n- Problem awareness\n- Solution proposal\n- Proof of trust\n- Call to action'} style={ta(theme)} />
              </Field>
              <Field label="Brand rules">
                <textarea value={brand.rules} onChange={(e) => updateBrand({ rules: e.target.value })} rows={6}
                  placeholder={'e.g.\n- Friendly but not flippant\n- Words to never use: "best", "most"\n- CTAs are always in imperative form'} style={ta(theme)} />
              </Field>
              <div style={{ fontSize: 10, color: `${theme.text}58`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Save path: {activeBrandPath || `${brandDir || './makeke/brands'}/${slugifyMaterialName(newBrandName || brand.name || 'brand-profile')}.json`}
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" onClick={() => void saveBrand()} disabled={!brandDirty}
                  style={{
                    marginTop: 4, padding: '10px 16px', borderRadius: 'var(--brutal-radius)', border: 0,
                    cursor: brandDirty ? 'pointer' : 'not-allowed',
                    background: brandDirty ? `linear-gradient(135deg, ${theme.accent}, ${theme.accent}dd)` : `${theme.text}15`,
                    color: brandDirty ? '#fff' : `${theme.text}60`,
                    fontSize: 13, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}>
                  <Save size={14} /> {brandDirty ? 'Save changes' : 'Saved'}
                </button>
                <button type="button" onClick={() => void saveBrandAs()} style={{ ...miniBtn(theme), height: 36 }}>
                  <Plus size={12} /> Save as
                </button>
                <button
                  type="button"
                  onClick={() => activeBrandPath && void deleteBrandFile(activeBrandPath)}
                  disabled={!activeBrandPath || activeBrandPath === brandProfilePath}
                  style={{ ...miniBtn(theme, !activeBrandPath || activeBrandPath === brandProfilePath), height: 36 }}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'prompts' && (
          <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 12, maxWidth: 1040, minHeight: 520 }}>
            <div style={{ border: `1px solid ${theme.text}18`, borderRadius: 'var(--brutal-radius)', overflow: 'hidden', background: `${theme.text}05`, minHeight: 0 }}>
              <div style={{ padding: 10, borderBottom: `1px solid ${theme.text}14`, display: 'flex', alignItems: 'center', gap: 6 }}>
                <FolderOpen size={13} style={{ color: theme.accent }} />
                <span style={{ fontSize: 12, fontWeight: 800 }}>makeke/prompts</span>
                <button
                  type="button"
                  onClick={() => void refreshPromptFiles()}
                  title="Refresh"
                  style={{ marginLeft: 'auto', width: 24, height: 24, borderRadius: 'var(--brutal-radius)', border: `1px solid ${theme.text}18`, background: 'transparent', color: theme.text, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              <div style={{ padding: 8, display: 'flex', gap: 6, borderBottom: `1px solid ${theme.text}14` }}>
                <input
                  type="text"
                  value={newPromptName}
                  onChange={(e) => setNewPromptName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createPromptFile(); }}
                  placeholder="New prompt name"
                  style={{ ...inp(theme), flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  onClick={() => void createPromptFile()}
                  title="Create new prompt"
                  style={{ width: 32, borderRadius: 'var(--brutal-radius)', border: 0, background: theme.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                >
                  <Plus size={14} />
                </button>
              </div>
              <div style={{ padding: 6, overflowY: 'auto', maxHeight: 420 }}>
                {promptFiles.length === 0 ? (
                  <div style={{ padding: 10, fontSize: 11, opacity: 0.55, lineHeight: 1.6 }}>
                    No saved prompts yet. Create a `.md` file above to get started.
                  </div>
                ) : promptFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => void loadPromptFile(file.path)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '8px 9px',
                      borderRadius: 'var(--brutal-radius)',
                      border: `1px solid ${activePromptPath === file.path ? `${theme.accent}55` : 'transparent'}`,
                      background: activePromptPath === file.path ? `${theme.accent}18` : 'transparent',
                      color: activePromptPath === file.path ? theme.accent : theme.text,
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: activePromptPath === file.path ? 800 : 600,
                      textAlign: 'left',
                    }}
                    title={file.path}
                  >
                    <FileText size={13} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                {quickPromptTemplates.map((template) => (
                  <div key={template.id} style={{ border: `1px solid ${theme.text}16`, borderRadius: 'var(--brutal-radius)', padding: 9, background: `${theme.text}05`, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <Sparkles size={12} style={{ color: theme.accent, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{template.label}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => void useQuickPromptTemplate(template, false)}
                        style={{ ...miniBtn(theme), flex: 1, justifyContent: 'center' }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void useQuickPromptTemplate(template, true)}
                        style={{ ...miniBtn(theme), flex: 1, justifyContent: 'center' }}
                      >
                        Send now
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 800 }}>
                    {activePromptPath ? activePromptPath.split('/').pop() : 'Select a prompt file'}
                    {promptDirty ? <span style={{ color: theme.accent }}> *</span> : null}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 560 }}>
                    {activePromptPath || `${promptDir || './makeke/prompts'}/*.md`}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => void savePromptFile()} disabled={!activePromptPath && !promptDraft.trim()}
                    style={miniBtn(theme, !activePromptPath && !promptDraft.trim())}>
                    <Save size={12} /> Save
                  </button>
                  <button type="button" onClick={() => void sendPromptDraft()} disabled={!promptDraft.trim()}
                    style={miniBtn(theme, !promptDraft.trim())}>
                    <Send size={12} /> Send to terminal
                  </button>
                  <button type="button" onClick={() => void openPromptInEditorTab()} disabled={!activePromptPath}
                    style={miniBtn(theme, !activePromptPath)}>
                    <FolderOpen size={12} /> Open file tab
                  </button>
                </div>
              </div>
              <textarea
                value={promptDraft}
                onChange={(e) => { setPromptDraft(e.target.value); setPromptDirty(true); }}
                rows={22}
                spellCheck={false}
                placeholder={'# Design Prompt\n\n## Purpose\n\n## Prompt\n'}
                style={{ ...ta(theme), flex: 1, minHeight: 430, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.65 }}
              />
              <div style={{ fontSize: 10, opacity: 0.55, lineHeight: 1.6 }}>
                Prompts are saved as `.md` in the project's shared folder <code>makeke/prompts</code>. Saved files can be managed together via Git/shared folders, and sent straight to the active AI terminal with the buttons.
              </div>
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 6, padding: 10, background: '#ef444418', border: '1px solid #ef444450', borderRadius: 'var(--brutal-radius)', fontSize: 11, color: '#fca5a5', maxWidth: 720 }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }} /><div>{error}</div>
          </div>
        )}
        {status && !error && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-start', gap: 6, padding: 10, background: `${theme.accent}14`, border: `1px solid ${theme.accent}45`, borderRadius: 'var(--brutal-radius)', fontSize: 11, color: theme.text, maxWidth: 720 }}>
            <ChevronRight size={14} style={{ flexShrink: 0, marginTop: 1, color: theme.accent }} /><div>{status}</div>
          </div>
        )}

        <div style={{ marginTop: 24, padding: 12, background: `${theme.text}05`, border: `1px dashed ${theme.text}20`, borderRadius: 'var(--brutal-radius)', fontSize: 11, color: `${theme.text}80`, maxWidth: 720, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>💡 How to use</div>
          1. Open a terminal in an AI CLI mode like <b>claude / codex / gemini / kimi</b>.<br/>
          2. When you write a request above, a job MD file is saved first, and the active terminal's CLI reads its absolute path to generate the result file.<br/>
          3. Click the result file in the left file tree (<code>makeke/</code>) to view it in BBARIT's built-in viewer.<br/>
          4. If you need multiple jobs, open several terminal windows to process them in parallel.
        </div>
      </div>
    </div>
  );
}

// ─── tiny helpers ───
const lbl: React.CSSProperties = { fontSize: 10, opacity: 0.6, fontWeight: 700, display: 'block', marginBottom: 4 };
const ta = (theme: { bg: string; text: string }): React.CSSProperties => ({
  width: '100%', padding: 10, background: theme.bg, border: `1px solid ${theme.text}25`,
  borderRadius: 'var(--brutal-radius)', color: theme.text, fontSize: 12, lineHeight: 1.5, resize: 'vertical',
});
const inp = (theme: { bg: string; text: string }): React.CSSProperties => ({
  width: '100%', padding: '7px 10px', background: theme.bg, border: `1px solid ${theme.text}25`,
  borderRadius: 'var(--brutal-radius)', color: theme.text, fontSize: 12,
});

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div><label style={lbl}>{label}</label>{children}</div>
);
const Select = ({ label, value, onChange, opts, theme }: { label: string; value: string; onChange: (v: string) => void; opts: string[][]; theme: { bg: string; text: string } }) => (
  <div>
    <label style={lbl}>{label}</label>
    <select value={value} onChange={(e) => onChange(e.target.value)} style={inp(theme)}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </div>
);
const ColorPaletteField = ({ label, value, onChange, theme }: { label: string; value: string; onChange: (v: string) => void; theme: { bg: string; text: string; accent: string } }) => {
  const colors = parseColorPalette(value);
  const pickerValue = colors[0] || normalizeHexColor(theme.accent) || '#2563eb';
  const addColor = (raw: string) => {
    const normalized = normalizeHexColor(raw);
    if (!normalized) return;
    onChange(serializeColorPalette([...colors, normalized]));
  };
  const removeColor = (color: string) => {
    onChange(serializeColorPalette(colors.filter((item) => item !== color)));
  };

  return (
    <div>
      <label style={lbl}>{label}</label>
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '40px minmax(120px, 1fr) auto', gap: 8, alignItems: 'center' }}>
          <input
            type="color"
            value={pickerValue}
            onChange={(e) => addColor(e.target.value)}
            title="Pick color"
            style={{ width: 40, height: 32, padding: 2, border: `1px solid ${theme.text}25`, borderRadius: 'var(--brutal-radius)', background: theme.bg, cursor: 'pointer' }}
          />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#2563eb, #14b8a6, #f97316"
            style={inp(theme)}
          />
          <button type="button" onClick={() => addColor(pickerValue)} style={{ ...miniBtn(theme), height: 32 }}>
            <Plus size={12} /> Add
          </button>
        </div>
        {colors.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => removeColor(color)}
                title={`Remove ${color}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  padding: '4px 7px',
                  borderRadius: 'var(--brutal-radius)',
                  border: `1px solid ${theme.text}18`,
                  background: `${theme.text}06`,
                  color: theme.text,
                  cursor: 'pointer',
                  fontSize: 10,
                  fontWeight: 800,
                }}
              >
                <span style={{ width: 16, height: 16, borderRadius: 'var(--brutal-radius)', background: color, border: `1px solid ${theme.text}22`, flexShrink: 0 }} />
                <span>{color}</span>
                <Trash2 size={10} style={{ opacity: 0.65 }} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const BrandColorRolesEditor = ({ brand, onChange, theme }: { brand: BrandProfile; onChange: (patch: Partial<BrandProfile>) => void; theme: { bg: string; text: string; accent: string } }) => (
  <div style={{ display: 'grid', gap: 8 }}>
    <div>
      <label style={lbl}>Brand color roles</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(146px, 1fr))', gap: 8 }}>
        {BRAND_COLOR_ROLES.map(({ key, label, fallback }) => {
          const colorValue = normalizeHexColor(brand[key] || '') || fallback;
          return (
            <div key={key} style={{ display: 'grid', gap: 5 }}>
              <div style={{ fontSize: 10, color: `${theme.text}70`, fontWeight: 800 }}>{label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '34px minmax(0, 1fr)', gap: 6, alignItems: 'center' }}>
                <input
                  type="color"
                  value={colorValue}
                  onChange={(e) => onChange({ [key]: e.target.value })}
                  title={`Pick ${label}`}
                  style={{ width: 34, height: 32, padding: 2, border: `1px solid ${theme.text}25`, borderRadius: 'var(--brutal-radius)', background: theme.bg, cursor: 'pointer' }}
                />
                <input
                  type="text"
                  value={brand[key] || ''}
                  onChange={(e) => onChange({ [key]: e.target.value })}
                  placeholder={fallback}
                  style={inp(theme)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
    <ColorPaletteField label="Additional color palette" value={brand.colors} onChange={(v) => onChange({ colors: v })} theme={theme} />
  </div>
);

const Input = ({ label, value, onChange, placeholder, theme }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; theme: { bg: string; text: string } }) => (
  <div>
    <label style={lbl}>{label}</label>
    <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inp(theme)} />
  </div>
);
const ActionBtn = ({ onClick, disabled, icon, theme, children }: { onClick: () => void | Promise<void>; disabled: boolean; icon: React.ReactNode; theme: { text: string; accent: string }; children: React.ReactNode }) => (
  <button type="button" onClick={() => void onClick()} disabled={disabled}
    style={{
      marginTop: 4, padding: '10px 16px', borderRadius: 'var(--brutal-radius)', border: 0,
      cursor: disabled ? 'not-allowed' : 'pointer',
      background: disabled ? `${theme.text}15` : `linear-gradient(135deg, ${theme.accent}, ${theme.accent}dd)`,
      color: disabled ? `${theme.text}60` : '#fff',
      fontSize: 13, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, alignSelf: 'flex-start',
    }}>
    {icon} {children}
  </button>
);

const miniBtn = (theme: { text: string; accent: string }, disabled = false): React.CSSProperties => ({
  padding: '6px 9px',
  borderRadius: 'var(--brutal-radius)',
  border: `1px solid ${disabled ? `${theme.text}14` : `${theme.accent}45`}`,
  background: disabled ? `${theme.text}08` : `${theme.accent}16`,
  color: disabled ? `${theme.text}45` : theme.text,
  fontSize: 11,
  fontWeight: 800,
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
});

const segmentBtn = (theme: { text: string; accent: string }, active: boolean, disabled = false): React.CSSProperties => ({
  padding: '7px 10px',
  borderRadius: 'var(--brutal-radius)',
  border: 0,
  background: active ? theme.accent : 'transparent',
  color: disabled ? `${theme.text}45` : active ? '#fff' : theme.text,
  fontSize: 11,
  fontWeight: 800,
  cursor: disabled ? 'not-allowed' : 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
});

const readonlyPill = (theme: { bg: string; text: string }): React.CSSProperties => ({
  padding: '7px 10px',
  borderRadius: 'var(--brutal-radius)',
  border: `1px solid ${theme.text}18`,
  background: `${theme.text}07`,
  color: `${theme.text}68`,
  fontSize: 11,
  fontWeight: 800,
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export default DesignPanel;
