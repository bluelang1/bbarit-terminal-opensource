import { invoke } from '@tauri-apps/api/core';

interface KoriniDeliverableParams {
  userRequest?: string;
  workflowName?: string;
  changedFiles?: string[];
  finalSummary?: string;
  reviewApproved?: boolean;
}

const KORINI_BASE_SEGMENT = '/BBARIT Projects/';

function normalizePath(path: string): string {
  return String(path || '').replace(/\\/g, '/').replace(/\/+$/g, '').trim();
}

export function isKoriniManagedWorkDir(workDir: string): boolean {
  const normalized = normalizePath(workDir);
  return normalized.includes(KORINI_BASE_SEGMENT) && normalized.split(KORINI_BASE_SEGMENT)[1]?.length > 0;
}

async function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path }).catch(() => '');
}

async function writeFile(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) await invoke('create_directory', { path: dir }).catch(() => {});
  await invoke('write_file', { path, content });
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  const existing = await readFile(path);
  if (existing.trim()) return false;
  await writeFile(path, content);
  return true;
}

async function writeManagedFile(path: string, content: string, marker: string): Promise<boolean> {
  const existing = await readFile(path);
  if (existing.trim() && !existing.includes(marker)) return false;
  if (existing === content) return false;
  await writeFile(path, content);
  return true;
}

async function ensureDirs(workDir: string): Promise<void> {
  const dirs = [
    `${workDir}/.bbarit`,
    `${workDir}/.bbarit/korini`,
    `${workDir}/.github`,
    `${workDir}/.github/workflows`,
    `${workDir}/docs`,
  ];
  for (const dir of dirs) {
    await invoke('create_directory', { path: dir }).catch(() => {});
  }
}

async function appendGitignoreRules(workDir: string): Promise<boolean> {
  const path = `${workDir}/.gitignore`;
  const required = [
    '',
    '# Korini Mode safety',
    '.env.local',
    '.env*.local',
    '.vercel/',
    '.next/',
    'node_modules/',
    '.bbarit/korini/*.tmp',
  ];
  const existing = await readFile(path);
  const lines = new Set(existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const missing = required.filter(line => !line.trim() || !lines.has(line.trim()));
  if (missing.length === 0) return false;
  const next = `${existing.trimEnd()}${existing.trim() ? '\n' : ''}${missing.join('\n')}\n`;
  await writeFile(path, next);
  return true;
}

function buildEnvExample(): string {
  return [
    '# .env.local.example',
    '# 이 파일은 예시입니다. 실제 비밀키는 .env.local에만 넣고 Git에는 올리지 않습니다.',
    '',
    '# Neon Postgres',
    'DATABASE_URL="postgresql://USER:PASSWORD@HOST/neondb?sslmode=require"',
    '',
    '# Supabase Auth',
    'NEXT_PUBLIC_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"',
    'SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVER_ONLY_SERVICE_ROLE_KEY"',
    '',
    '# Vercel Blob',
    'BLOB_READ_WRITE_TOKEN="YOUR_VERCEL_BLOB_TOKEN"',
    '',
    '# Korean payments: Toss Payments or PortOne/Iamport',
    'TOSS_PAYMENTS_SECRET_KEY="YOUR_TOSS_SECRET_KEY"',
    'PORTONE_API_SECRET="YOUR_PORTONE_SECRET"',
    'PAYMENT_WEBHOOK_SECRET="YOUR_PAYMENT_WEBHOOK_SECRET"',
    '',
    '# AI / API',
    'AI_PROVIDER_API_KEY="YOUR_AI_PROVIDER_KEY"',
    'ATLAS_CLOUD_API_KEY="YOUR_ATLAS_CLOUD_KEY"',
    '',
  ].join('\n');
}

function buildStarterPackageJson(appName: string): string {
  return `${JSON.stringify({
    private: true,
    name: appName || 'korini-web-app',
    version: '0.1.0',
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      typecheck: 'tsc --noEmit',
      test: 'playwright test',
    },
    dependencies: {
      '@neondatabase/serverless': 'latest',
      '@vercel/blob': 'latest',
      '@supabase/supabase-js': 'latest',
      ai: 'latest',
      next: 'latest',
      react: 'latest',
      'react-dom': 'latest',
      zod: 'latest',
    },
    devDependencies: {
      '@playwright/test': 'latest',
      '@types/node': 'latest',
      '@types/react': 'latest',
      '@types/react-dom': 'latest',
      typescript: 'latest',
    },
  }, null, 2)}\n`;
}

function buildStarterLayout(): string {
  return [
    'import type { Metadata } from "next";',
    'import type { ReactNode } from "react";',
    'import "./globals.css";',
    '',
    'export const metadata: Metadata = {',
    '  title: "Korini Web App",',
    '  description: "코린이모드가 대화로 만들어가는 웹 서비스",',
    '};',
    '',
    'export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {',
    '  return (',
    '    <html lang="ko">',
    '      <body>{children}</body>',
    '    </html>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildStarterPage(userRequest?: string): string {
  const safeRequest = String(userRequest || '무엇을 만들지 대화로 알려주세요.')
    .replace(/[{}<>]/g, '')
    .slice(0, 120);
  return [
    'const productSteps = [',
    '  "고객이 처음 보는 랜딩 페이지",',
    '  "가입 뒤 바로 보는 대시보드",',
    '  "요금제와 결제 연결 자리",',
    '  "데이터, 로그인, 파일, AI 연결 점검",',
    '];',
    '',
    'const stackItems = [',
    '  { label: "웹앱", value: "Next.js" },',
    '  { label: "배포", value: "Vercel" },',
    '  { label: "DB", value: "Neon Postgres" },',
    '  { label: "로그인", value: "Supabase Auth" },',
    '  { label: "결제", value: "Toss Payments 또는 PortOne" },',
    '  { label: "파일", value: "Vercel Blob" },',
    '  { label: "AI", value: "Vercel AI SDK" },',
    '];',
    '',
    'export default function Home() {',
    '  return (',
    '    <main className="page-shell">',
    '      <section className="hero">',
    '        <p className="eyebrow">코린이모드 SaaS 스타터</p>',
    '        <h1>아이디어를 말하면, 가입부터 결제까지 자라는 웹 서비스</h1>',
    `        <p className="lead">처음 요청: ${safeRequest}</p>`,
    '        <div className="actions" aria-label="다음 단계">',
    '          <a href="/dashboard">대시보드 보기</a>',
    '          <a className="secondary" href="/pricing">요금제 보기</a>',
    '        </div>',
    '      </section>',
    '      <section className="stack-grid" aria-label="기본 SaaS 조합">',
    '        {stackItems.map((item) => (',
    '          <article key={item.label} className="mini-card">',
    '            <span>{item.label}</span>',
    '            <strong>{item.value}</strong>',
    '          </article>',
    '        ))}',
    '      </section>',
    '      <section id="next" className="panel" aria-labelledby="next-title">',
    '        <h2 id="next-title">처음부터 들어있는 SaaS 뼈대</h2>',
    '        <ul>',
    '          {productSteps.map((item) => (',
    '            <li key={item}>{item}</li>',
    '          ))}',
    '        </ul>',
    '      </section>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildStarterCss(): string {
  return [
    ':root {',
    '  color-scheme: light;',
    '  --bg: #effdf7;',
    '  --text: #0f2a26;',
    '  --muted: #4b6963;',
    '  --accent: #00b894;',
    '  --accent-2: #2563eb;',
    '  --panel: #ffffff;',
    '  --line: rgba(15, 42, 38, 0.12);',
    '}',
    '',
    '* { box-sizing: border-box; }',
    'body {',
    '  margin: 0;',
    '  background: var(--bg);',
    '  color: var(--text);',
    '  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '}',
    'a { color: inherit; }',
    '.page-shell, .dashboard-shell, .pricing-shell {',
    '  min-height: 100vh;',
    '  display: grid;',
    '  gap: 24px;',
    '  padding: clamp(24px, 5vw, 72px);',
    '}',
    '.page-shell { align-content: center; }',
    '.hero, .panel, .stack-grid, .dashboard-grid, .pricing-grid {',
    '  width: min(1080px, 100%);',
    '}',
    '.eyebrow {',
    '  margin: 0 0 12px;',
    '  color: var(--accent);',
    '  font-weight: 800;',
    '}',
    'h1 {',
    '  margin: 0;',
    '  max-width: 760px;',
    '  font-size: clamp(36px, 7vw, 72px);',
    '  line-height: 1.04;',
    '  letter-spacing: 0;',
    '}',
    '.lead {',
    '  max-width: 720px;',
    '  margin: 20px 0 0;',
    '  color: var(--muted);',
    '  font-size: 20px;',
    '  line-height: 1.7;',
    '}',
    '.actions { margin-top: 28px; }',
    '.actions a {',
      '  display: inline-flex;',
    '  align-items: center;',
    '  min-height: 48px;',
    '  padding: 0 20px;',
    '  border-radius: 8px;',
    '  background: var(--accent);',
    '  color: #05231f;',
    '  font-weight: 800;',
    '  text-decoration: none;',
    '  margin-right: 10px;',
    '}',
    '.actions .secondary {',
    '  background: #ffffff;',
    '  color: var(--text);',
    '  border: 1px solid var(--line);',
    '}',
    '.stack-grid, .dashboard-grid, .pricing-grid {',
    '  display: grid;',
    '  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));',
    '  gap: 14px;',
    '}',
    '.mini-card, .metric-card, .price-card {',
    '  background: var(--panel);',
    '  border: 1px solid var(--line);',
    '  border-radius: 8px;',
    '  padding: 20px;',
    '}',
    '.mini-card span, .metric-card span, .price-card span {',
    '  display: block;',
    '  color: var(--muted);',
    '  font-size: 14px;',
    '  margin-bottom: 8px;',
    '}',
    '.mini-card strong, .metric-card strong, .price-card strong {',
    '  font-size: 22px;',
    '}',
    '.panel {',
    '  background: var(--panel);',
    '  border: 1px solid var(--line);',
    '  border-radius: 8px;',
    '  padding: 24px;',
    '}',
    '.panel h2 { margin: 0 0 16px; font-size: 24px; }',
    '.panel ul { margin: 0; padding-left: 22px; color: var(--muted); line-height: 1.8; }',
    '.top-nav { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }',
    '.top-nav a { font-weight: 800; text-decoration: none; color: var(--text); }',
    '.status-list { display: grid; gap: 10px; padding: 0; list-style: none; }',
    '.status-list li { background: #f7fffb; border: 1px solid var(--line); border-radius: 8px; padding: 14px; }',
    '.price-card.featured { border-color: var(--accent); box-shadow: 0 10px 30px rgba(0, 184, 148, 0.12); }',
    '',
  ].join('\n');
}

function buildEnvLib(): string {
  return [
    'import { z } from "zod";',
    '',
    'const envSchema = z.object({',
    '  DATABASE_URL: z.string().optional(),',
    '  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),',
    '  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),',
    '  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),',
    '  BLOB_READ_WRITE_TOKEN: z.string().optional(),',
    '  TOSS_PAYMENTS_SECRET_KEY: z.string().optional(),',
    '  PORTONE_API_SECRET: z.string().optional(),',
    '  PAYMENT_WEBHOOK_SECRET: z.string().optional(),',
    '  AI_PROVIDER_API_KEY: z.string().optional(),',
    '  ATLAS_CLOUD_API_KEY: z.string().optional(),',
    '});',
    '',
    'export const env = envSchema.parse(process.env);',
    '',
    'export function getMissingServiceKeys() {',
    '  return {',
    '    neon: !env.DATABASE_URL,',
    '    supabase: !env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY,',
    '    payments: !env.TOSS_PAYMENTS_SECRET_KEY && !env.PORTONE_API_SECRET,',
    '    blob: !env.BLOB_READ_WRITE_TOKEN,',
    '    ai: !env.AI_PROVIDER_API_KEY && !env.ATLAS_CLOUD_API_KEY,',
    '  };',
    '}',
    '',
  ].join('\n');
}

function buildSupabaseLib(): string {
  return [
    'import { createClient } from "@supabase/supabase-js";',
    'import { env } from "./env";',
    '',
    'export function createSupabaseClient() {',
    '  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return null;',
    '  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);',
    '}',
    '',
    'export function getKoreanLoginProviders() {',
    '  return ["kakao", "naver", "google"] as const;',
    '}',
    '',
  ].join('\n');
}

function buildDbLib(): string {
  return [
    'import { neon } from "@neondatabase/serverless";',
    'import { env } from "./env";',
    '',
    'export function getSql() {',
    '  if (!env.DATABASE_URL) {',
    '    throw new Error("DATABASE_URL이 없습니다. Neon에서 받은 주소를 .env.local과 Vercel 환경변수에 넣어주세요.");',
    '  }',
    '  return neon(env.DATABASE_URL);',
    '}',
    '',
    'export const starterSchemaSql = `',
    'create table if not exists korini_workspaces (',
    '  id uuid primary key default gen_random_uuid(),',
    '  owner_id text,',
    '  name text not null,',
    "  plan text not null default 'free',",
    '  created_at timestamptz not null default now()',
    ');',
    '`;',
    '',
  ].join('\n');
}

function buildPaymentsLib(): string {
  return [
    'import { env } from "./env";',
    '',
    'export type BillingPlan = "free" | "starter" | "pro";',
    '',
    'export const billingPlans: Array<{ id: BillingPlan; name: string; price: string; description: string }> = [',
    '  { id: "free", name: "무료", price: "0원", description: "아이디어 검증용 기본 기능" },',
    '  { id: "starter", name: "스타터", price: "월 19,000원", description: "작은 팀과 개인 서비스 운영" },',
    '  { id: "pro", name: "프로", price: "월 49,000원", description: "자동화, AI, 운영 리포트 강화" },',
    '];',
    '',
    'export function getPaymentProviderStatus() {',
    '  if (env.TOSS_PAYMENTS_SECRET_KEY) return "Toss Payments 준비됨";',
    '  if (env.PORTONE_API_SECRET) return "PortOne/Iamport 준비됨";',
    '  return "결제 키가 아직 없습니다";',
    '}',
    '',
  ].join('\n');
}

function buildStorageLib(): string {
  return [
    'import { put } from "@vercel/blob";',
    'import { env } from "./env";',
    '',
    'export async function uploadPrivateAsset(name: string, data: Blob) {',
    '  if (!env.BLOB_READ_WRITE_TOKEN) {',
    '    throw new Error("BLOB_READ_WRITE_TOKEN이 없습니다. Vercel Blob 키를 .env.local에 넣어주세요.");',
    '  }',
    '  return put(name, data, { access: "public", token: env.BLOB_READ_WRITE_TOKEN });',
    '}',
    '',
  ].join('\n');
}

function buildDashboardPage(): string {
  return [
    'import { getMissingServiceKeys } from "../../lib/env";',
    'import { getPaymentProviderStatus } from "../../lib/payments";',
    '',
    'const metrics = [',
    '  { label: "오늘 할 일", value: "3개" },',
    '  { label: "연결 상태", value: "점검 중" },',
    '  { label: "배포 준비", value: "Vercel" },',
    '];',
    '',
    'export default function DashboardPage() {',
    '  const missing = getMissingServiceKeys();',
    '  const checks = [',
    '    `Neon DB: ${missing.neon ? "키 필요" : "준비됨"}`,',
    '    `Supabase 로그인: ${missing.supabase ? "키 필요" : "준비됨"}`,',
    '    `한국 결제: ${getPaymentProviderStatus()}`,',
    '    `Vercel Blob: ${missing.blob ? "키 필요" : "준비됨"}`,',
    '    `AI/API: ${missing.ai ? "키 필요" : "준비됨"}`,',
    '  ];',
    '',
    '  return (',
    '    <main className="dashboard-shell">',
    '      <nav className="top-nav" aria-label="주요 화면">',
    '        <a href="/">처음</a>',
    '        <a href="/pricing">요금제</a>',
    '      </nav>',
    '      <section className="hero">',
    '        <p className="eyebrow">운영 대시보드</p>',
    '        <h1>서비스 상태를 한눈에 보고, 다음 일을 바로 정합니다.</h1>',
    '        <p className="lead">코린이모드가 로그인, DB, 결제, 파일, AI 연결을 쉬운 말로 점검합니다.</p>',
    '      </section>',
    '      <section className="dashboard-grid" aria-label="주요 지표">',
    '        {metrics.map((metric) => (',
    '          <article className="metric-card" key={metric.label}>',
    '            <span>{metric.label}</span>',
    '            <strong>{metric.value}</strong>',
    '          </article>',
    '        ))}',
    '      </section>',
    '      <section className="panel">',
    '        <h2>연결해야 할 서비스</h2>',
    '        <ul className="status-list">',
    '          {checks.map((item) => <li key={item}>{item}</li>)}',
    '        </ul>',
    '      </section>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildPricingPage(): string {
  return [
    'import { billingPlans } from "../../lib/payments";',
    '',
    'export default function PricingPage() {',
    '  return (',
    '    <main className="pricing-shell">',
    '      <nav className="top-nav" aria-label="주요 화면">',
    '        <a href="/">처음</a>',
    '        <a href="/dashboard">대시보드</a>',
    '      </nav>',
    '      <section className="hero">',
    '        <p className="eyebrow">한국형 SaaS 요금제</p>',
    '        <h1>무료로 시작하고, 결제가 필요해지면 바로 연결합니다.</h1>',
    '      </section>',
    '      <section className="pricing-grid" aria-label="요금제 목록">',
    '        {billingPlans.map((plan) => (',
    '          <article className={`price-card ${plan.id === "starter" ? "featured" : ""}`} key={plan.id}>',
    '            <span>{plan.name}</span>',
    '            <strong>{plan.price}</strong>',
    '            <p>{plan.description}</p>',
    '          </article>',
    '        ))}',
    '      </section>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function buildHealthRoute(): string {
  return [
    'import { NextResponse } from "next/server";',
    'import { getMissingServiceKeys } from "../../../lib/env";',
    '',
    'export async function GET() {',
    '  return NextResponse.json({',
    '    ok: true,',
    '    app: "korini-saas",',
    '    serviceKeys: getMissingServiceKeys(),',
    '  });',
    '}',
    '',
  ].join('\n');
}

function buildAiRoute(): string {
  return [
    'import { NextResponse } from "next/server";',
    'import { env } from "../../../lib/env";',
    '',
    'export async function POST() {',
    '  if (!env.AI_PROVIDER_API_KEY && !env.ATLAS_CLOUD_API_KEY) {',
    '    return NextResponse.json({ error: "AI 키가 아직 없습니다. .env.local에 AI_PROVIDER_API_KEY 또는 ATLAS_CLOUD_API_KEY를 넣어주세요." }, { status: 400 });',
    '  }',
    '  return NextResponse.json({ message: "AI 연결 자리가 준비되어 있습니다. 코린이모드에게 원하는 AI 기능을 말해주세요." });',
    '}',
    '',
  ].join('\n');
}

function buildSaasPlanDoc(): string {
  return [
    '# 코린이 SaaS 운영 설계',
    '',
    '이 폴더는 처음부터 SaaS로 키울 수 있게 준비되어 있습니다.',
    '',
    '## 들어있는 화면',
    '- `/` 고객에게 보여주는 첫 화면',
    '- `/dashboard` 로그인 뒤 운영자가 보는 화면',
    '- `/pricing` 한국 결제 기준 요금제 화면',
    '- `/api/health` 배포/연결 상태 확인 API',
    '- `/api/ai` AI 기능을 붙일 서버 API 자리',
    '',
    '## 연결 순서',
    '1. Supabase에서 로그인 프로젝트를 만들고 URL/anon key를 넣습니다.',
    '2. Neon에서 Postgres DATABASE_URL을 받아 넣습니다.',
    '3. Toss Payments 또는 PortOne 키를 넣습니다.',
    '4. Vercel Blob 토큰을 넣습니다.',
    '5. AI 제공자 키 또는 Atlas Cloud 키를 넣습니다.',
    '',
    '## 테스트',
    '- `npm run test`는 Playwright로 첫 화면, 대시보드, 요금제, health API를 확인합니다.',
    '- `npm run build`는 Vercel 배포 전에 반드시 통과해야 합니다.',
    '',
  ].join('\n');
}

function buildTsConfig(): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: 'ES2017',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  }, null, 2)}\n`;
}

function buildNextEnvDts(): string {
  return [
    '/// <reference types="next" />',
    '/// <reference types="next/image-types/global" />',
    '',
    '// This file is auto-generated by Next.js and kept here so typecheck works from the first run.',
    '',
  ].join('\n');
}

function buildNextConfig(): string {
  return [
    'import type { NextConfig } from "next";',
    '',
    'const nextConfig: NextConfig = {',
    '  poweredByHeader: false,',
    '};',
    '',
    'export default nextConfig;',
    '',
  ].join('\n');
}

function buildPlaywrightConfig(): string {
  return [
    'import { defineConfig, devices } from "@playwright/test";',
    '',
    'export default defineConfig({',
    '  testDir: "./tests",',
    '  timeout: 30_000,',
    '  expect: { timeout: 5_000 },',
    '  webServer: {',
    '    command: "npm run dev",',
    '    url: "http://127.0.0.1:3000",',
    '    reuseExistingServer: !process.env.CI,',
    '    timeout: 120_000,',
    '  },',
    '  use: {',
    '    baseURL: "http://127.0.0.1:3000",',
    '    trace: "retain-on-failure",',
    '    screenshot: "only-on-failure",',
    '  },',
    '  projects: [',
    '    { name: "chromium", use: { ...devices["Desktop Chrome"] } },',
    '  ],',
    '});',
    '',
  ].join('\n');
}

function buildSmokeTest(): string {
  return [
    'import { expect, test } from "@playwright/test";',
    '',
    'test("첫 화면이 열립니다", async ({ page }) => {',
    '  await page.goto("/");',
    '  await expect(page.getByRole("heading", { level: 1 })).toContainText("아이디어를 말하면");',
    '  await expect(page.getByRole("link", { name: "대시보드 보기" })).toBeVisible();',
    '});',
    '',
    'test("SaaS 기본 화면과 상태 API가 준비됩니다", async ({ page, request }) => {',
    '  await page.goto("/dashboard");',
    '  await expect(page.getByRole("heading", { level: 1 })).toContainText("서비스 상태");',
    '  await page.goto("/pricing");',
    '  await expect(page.getByRole("heading", { level: 1 })).toContainText("무료로 시작");',
    '  const health = await request.get("/api/health");',
    '  expect(health.ok()).toBeTruthy();',
    '  await expect(health).toBeOK();',
    '});',
    '',
  ].join('\n');
}

function buildCiWorkflow(): string {
  return [
    'name: Korini CI',
    '# Managed by Korini Mode. Safe to regenerate.',
    '',
    'on:',
    '  push:',
    '  pull_request:',
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v4',
    '',
    '      - name: Setup Node',
    '        uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    '',
    '      - name: Install',
    '        run: |',
    '          set -euo pipefail',
    '          if [ -f pnpm-lock.yaml ]; then',
    '            corepack enable',
    '            pnpm install --frozen-lockfile',
    '          elif [ -f yarn.lock ]; then',
    '            corepack enable',
    '            yarn install --immutable || yarn install --frozen-lockfile',
    '          elif [ -f package-lock.json ]; then',
    '            npm ci',
    '          else',
    '            npm install',
    '          fi',
    '',
    '      - name: Secret safety check',
    '        run: |',
    '          set -euo pipefail',
    '          if git ls-files | grep -E "(^|/)\\.env(\\.local)?$"; then',
    '            echo "::error::.env 또는 .env.local이 Git에 들어가면 비밀키가 노출됩니다."',
    '            exit 1',
    '          fi',
    '          if grep -R --line-number \\',
    '            --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=.github \\',
    '            --exclude="*.example" --exclude=".env.local.example" \\',
    '            -E "(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,})" .; then',
    '            echo "::error::비밀키처럼 보이는 값이 코드에 있습니다."',
    '            exit 1',
    '          fi',
    '',
    '      - name: Lint, typecheck, unit test, build',
    '        run: |',
    '          set -euo pipefail',
    '          run_script() {',
    '            local name="$1"',
    '            if node -e "const s=require(\'./package.json\').scripts||{}; process.exit(s[process.argv[1]]?0:1)" "$name"; then',
    '              echo "실행: $name"',
    '              npm run "$name"',
    '            else',
    '              echo "$name 스크립트 없음 - 건너뜀"',
    '            fi',
    '          }',
    '          run_required_script() {',
    '            local name="$1"',
    '            if node -e "const s=require(\'./package.json\').scripts||{}; process.exit(s[process.argv[1]]?0:1)" "$name"; then',
    '              echo "필수 실행: $name"',
    '              npm run "$name"',
    '            else',
    '              echo "::error::$name 스크립트가 없습니다. 코린이 웹앱은 배포 전 build가 반드시 필요합니다."',
    '              exit 1',
    '            fi',
    '          }',
    '          run_script lint',
    '          run_script typecheck',
    '          run_script test',
    '          run_required_script build',
    '',
    '      - name: Playwright browser flow',
    '        run: |',
    '          set -euo pipefail',
    '          if [ -f playwright.config.ts ] || [ -f playwright.config.js ]; then',
    '            npx playwright install --with-deps',
    '            npx playwright test',
    '          else',
    '            echo "Playwright 설정 파일이 아직 없습니다. 코린이모드가 화면 테스트를 추가하면 여기서 자동 실행됩니다."',
    '          fi',
    '',
  ].join('\n');
}

export async function ensureKoriniNextStarter(workDir: string, userRequest = ''): Promise<string[]> {
  const normalized = normalizePath(workDir);
  if (!isKoriniManagedWorkDir(normalized)) return [];

  const packageJson = await readFile(`${normalized}/package.json`);
  if (packageJson.trim()) return [];

  await invoke('create_directory', { path: normalized }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app/dashboard` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app/pricing` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app/api` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app/api/health` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/app/api/ai` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/lib` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/tests` }).catch(() => {});
  await invoke('create_directory', { path: `${normalized}/docs` }).catch(() => {});

  const appName = normalized.split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'korini-web-app';
  const written: string[] = [];
  const files: Array<[string, string]> = [
    ['package.json', buildStarterPackageJson(appName)],
    ['app/layout.tsx', buildStarterLayout()],
    ['app/page.tsx', buildStarterPage(userRequest)],
    ['app/dashboard/page.tsx', buildDashboardPage()],
    ['app/pricing/page.tsx', buildPricingPage()],
    ['app/api/health/route.ts', buildHealthRoute()],
    ['app/api/ai/route.ts', buildAiRoute()],
    ['app/globals.css', buildStarterCss()],
    ['lib/env.ts', buildEnvLib()],
    ['lib/supabase.ts', buildSupabaseLib()],
    ['lib/db.ts', buildDbLib()],
    ['lib/payments.ts', buildPaymentsLib()],
    ['lib/storage.ts', buildStorageLib()],
    ['next-env.d.ts', buildNextEnvDts()],
    ['next.config.ts', buildNextConfig()],
    ['tsconfig.json', buildTsConfig()],
    ['playwright.config.ts', buildPlaywrightConfig()],
    ['tests/korini-smoke.spec.ts', buildSmokeTest()],
    ['docs/saas-plan.md', buildSaasPlanDoc()],
  ];

  for (const [relativePath, content] of files) {
    if (await writeIfMissing(`${normalized}/${relativePath}`, content)) {
      written.push(relativePath);
    }
  }

  return written;
}

function buildStartGuide(): string {
  return [
    '# 코린이모드 시작 안내',
    '',
    '이 앱은 코딩을 잘 모르는 사람도 대화로 만들고 고칠 수 있게 코린이모드가 관리하는 Next.js 웹 프로젝트입니다.',
    '',
    '## 우리가 쓰는 기본 조합',
    '- 웹앱: Next.js',
    '- 배포: Vercel',
    '- 데이터베이스: Neon Postgres',
    '- 로그인: Supabase Auth',
    '- 한국 결제: Toss Payments 또는 PortOne/Iamport',
    '- 이미지/파일: Vercel Blob',
    '- AI/API: Vercel AI SDK와 서버 전용 API 키',
    '- 화면 테스트: Playwright MCP',
    '',
    '## 비밀키 넣는 곳',
    '`.env.local`은 내 컴퓨터에만 저장되는 비밀 메모장입니다. 실제 키값은 여기에만 넣고 Git에는 올리지 않습니다.',
    '',
    '1. `.env.local.example`을 보고 필요한 이름을 확인합니다.',
    '2. 같은 이름으로 `.env.local`을 만듭니다.',
    '3. Vercel에도 같은 이름으로 Environment Variables를 넣습니다.',
    '',
    '## 막혔을 때',
    '1. `.bbarit/korini/STATUS.md`에서 어디까지 했는지 봅니다.',
    '2. `.bbarit/korini/RESULT.md`에서 실행/테스트/배포 방법을 봅니다.',
    '3. 에러 문장을 그대로 코린이모드 대화창에 붙여넣습니다.',
    '',
  ].join('\n');
}

function summarizeChangedFiles(files: string[] = []): string {
  if (files.length === 0) return '- 아직 자동 저장된 변경 파일이 없습니다.';
  return files.slice(0, 40).map(file => `- ${file}`).join('\n');
}

function buildStatus(params: KoriniDeliverableParams): string {
  return [
    '# 코린이모드 진행 상태',
    '',
    `- 마지막 업데이트: ${new Date().toLocaleString()}`,
    `- 사용자 요청: ${params.userRequest?.trim() || '대화 내용을 바탕으로 코린이모드가 판단'}`,
    `- 작업 흐름: ${params.workflowName || '코린이 기본 흐름'}`,
    `- 보안 상태: ${params.reviewApproved === false ? '검토 보류' : '보안 점검 완료 또는 변경분 점검 필요'}`,
    '',
    '## 지금까지 한 일',
    summarizeChangedFiles(params.changedFiles),
    '',
    '## 지금 단계',
    '- 코린이모드가 파일 저장, 실행 안내, 보안/배포/CI 점검 문서를 준비했습니다.',
    '',
    '## 다음 한 가지 행동',
    '- 대화창에 "실행해서 화면 확인해줘" 또는 "배포 준비해줘"라고 말하면 됩니다.',
    '',
    '## 이미 확인했거나 확인해야 할 것',
    '- npm run build',
    '- Playwright MCP 화면 확인',
    '- GitHub Actions Korini CI',
    '- Vercel 환경변수',
    '- Neon DATABASE_URL',
    '- Supabase 로그인 키',
    '',
    '## 되돌리기',
    '- 문제가 생기면 변경 파일 목록을 기준으로 Git에서 이전 상태를 확인하거나, 코린이모드에 "방금 변경 되돌려줘"라고 말합니다.',
    '',
  ].join('\n');
}

function buildResult(params: KoriniDeliverableParams): string {
  const summary = params.finalSummary?.trim()
    ? params.finalSummary.trim().slice(0, 3000)
    : '이번 작업의 자세한 내용은 코린이모드 대화 기록과 변경 파일 목록을 기준으로 확인합니다.';
  return [
    '# 코린이모드 결과 보고서',
    '',
    '## 무엇을 했나요?',
    summary,
    '',
    '## 바뀐 파일',
    summarizeChangedFiles(params.changedFiles),
    '',
    '## 내 컴퓨터에서 실행',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    '## 브라우저에서 확인',
    '- 코린이모드는 Playwright MCP로 실제 화면을 열고 클릭하며 확인하는 것을 기본으로 합니다.',
    '- 실행 중 에러가 보이면 에러 문장을 그대로 대화창에 붙여넣으면 됩니다.',
    '',
    '## CI/CD',
    '- `.github/workflows/korini-ci.yml`이 설치되어 있으면 GitHub에 올릴 때 자동 확인합니다.',
    '- 확인 항목: 설치, 비밀키 노출 검사, lint/typecheck/test 가능 시 실행, build, Playwright 테스트 가능 시 실행.',
    '',
    '## 배포',
    '- Vercel 프로젝트에 연결합니다.',
    '- Vercel Environment Variables에 `.env.local.example`과 같은 이름의 키를 넣습니다.',
    '- Neon, Supabase, 결제, Blob, AI 키는 서버에서만 안전하게 쓰도록 확인합니다.',
    '',
    '## 보안 메모',
    '- `.env.local`은 Git에 올리면 안 됩니다.',
    '- Supabase service role, 결제 secret, Blob token, AI provider key는 브라우저에 노출하면 안 됩니다.',
    '- 보안 점검 완료 후에는 바뀐 파일만 다시 점검합니다.',
    '',
    '## 다시 시작하는 법',
    '- `.bbarit/korini/STATUS.md`의 "다음 한 가지 행동"부터 이어가면 됩니다.',
    '',
  ].join('\n');
}

export async function ensureKoriniProjectDeliverables(
  workDir: string,
  params: KoriniDeliverableParams = {},
): Promise<string[]> {
  const normalized = normalizePath(workDir);
  if (!isKoriniManagedWorkDir(normalized)) return [];

  const written: string[] = [];
  await ensureDirs(normalized);

  if (await appendGitignoreRules(normalized)) written.push('.gitignore');
  if (await writeIfMissing(`${normalized}/.env.local.example`, buildEnvExample())) written.push('.env.local.example');
  if (await writeManagedFile(
    `${normalized}/.github/workflows/korini-ci.yml`,
    buildCiWorkflow(),
    'Managed by Korini Mode',
  )) written.push('.github/workflows/korini-ci.yml');
  if (await writeIfMissing(`${normalized}/docs/korini-start.md`, buildStartGuide())) written.push('docs/korini-start.md');

  await writeFile(`${normalized}/.bbarit/korini/STATUS.md`, buildStatus(params));
  written.push('.bbarit/korini/STATUS.md');

  await writeFile(`${normalized}/.bbarit/korini/RESULT.md`, buildResult(params));
  written.push('.bbarit/korini/RESULT.md');

  return Array.from(new Set(written));
}
