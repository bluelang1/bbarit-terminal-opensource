import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureKoriniNextStarter, ensureKoriniProjectDeliverables, isKoriniManagedWorkDir } from './koriniDeliverables';

const mockFs = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: { path?: string; content?: string }) => {
    if (command === 'read_file') {
      return mockFs.files.get(args?.path || '') || '';
    }
    if (command === 'write_file') {
      if (!args?.path) throw new Error('write_file requires path');
      mockFs.files.set(args.path, args.content || '');
      return null;
    }
    if (command === 'create_directory') {
      if (args?.path) mockFs.dirs.add(args.path);
      return null;
    }
    throw new Error(`Unexpected invoke command: ${command}`);
  }),
}));

const managedWorkDir = '/Users/test/Documents/BBARIT Projects/my-app';
const outsideWorkDir = '/Users/test/Documents/other/my-app';

describe('koriniDeliverables', () => {
  beforeEach(() => {
    mockFs.files.clear();
    mockFs.dirs.clear();
  });

  it('detects only apps under the fixed Korini base folder', () => {
    expect(isKoriniManagedWorkDir(managedWorkDir)).toBe(true);
    expect(isKoriniManagedWorkDir('/Users/test/Documents/BBARIT Projects')).toBe(false);
    expect(isKoriniManagedWorkDir(outsideWorkDir)).toBe(false);
  });

  it('creates a runnable Next.js starter with Playwright for an empty Korini app', async () => {
    const written = await ensureKoriniNextStarter(managedWorkDir, '예약 웹사이트 만들어줘');

    expect(written).toEqual([
      'package.json',
      'app/layout.tsx',
      'app/page.tsx',
      'app/dashboard/page.tsx',
      'app/pricing/page.tsx',
      'app/api/health/route.ts',
      'app/api/ai/route.ts',
      'app/globals.css',
      'lib/env.ts',
      'lib/supabase.ts',
      'lib/db.ts',
      'lib/payments.ts',
      'lib/storage.ts',
      'next-env.d.ts',
      'next.config.ts',
      'tsconfig.json',
      'playwright.config.ts',
      'tests/korini-smoke.spec.ts',
      'docs/saas-plan.md',
    ]);
    expect(mockFs.dirs).toContain(managedWorkDir);
    expect(mockFs.dirs).toContain(`${managedWorkDir}/app`);
    expect(mockFs.dirs).toContain(`${managedWorkDir}/app/dashboard`);
    expect(mockFs.dirs).toContain(`${managedWorkDir}/app/api/health`);
    expect(mockFs.dirs).toContain(`${managedWorkDir}/lib`);
    expect(mockFs.dirs).toContain(`${managedWorkDir}/tests`);

    const pkg = JSON.parse(mockFs.files.get(`${managedWorkDir}/package.json`) || '{}');
    expect(pkg.scripts).toMatchObject({
      dev: 'next dev',
      build: 'next build',
      typecheck: 'tsc --noEmit',
      test: 'playwright test',
    });
    expect(pkg.dependencies).toMatchObject({
      next: 'latest',
      react: 'latest',
      'react-dom': 'latest',
      '@supabase/supabase-js': 'latest',
      '@neondatabase/serverless': 'latest',
      '@vercel/blob': 'latest',
      ai: 'latest',
      zod: 'latest',
    });
    expect(pkg.dependencies).not.toHaveProperty('@vercel/ai');
    expect(mockFs.files.get(`${managedWorkDir}/app/layout.tsx`)).toContain('lang="ko"');
    expect(mockFs.files.get(`${managedWorkDir}/app/page.tsx`)).toContain('예약 웹사이트 만들어줘');
    expect(mockFs.files.get(`${managedWorkDir}/app/dashboard/page.tsx`)).toContain('운영 대시보드');
    expect(mockFs.files.get(`${managedWorkDir}/app/pricing/page.tsx`)).toContain('한국형 SaaS 요금제');
    expect(mockFs.files.get(`${managedWorkDir}/app/api/health/route.ts`)).toContain('korini-saas');
    expect(mockFs.files.get(`${managedWorkDir}/lib/env.ts`)).toContain('getMissingServiceKeys');
		expect(mockFs.files.get(`${managedWorkDir}/lib/payments.ts`)).toContain('Toss Payments');
    expect(mockFs.files.get(`${managedWorkDir}/playwright.config.ts`)).toContain('webServer');
    expect(mockFs.files.get(`${managedWorkDir}/playwright.config.ts`)).toContain('baseURL: "http://127.0.0.1:3000"');
    expect(mockFs.files.get(`${managedWorkDir}/tests/korini-smoke.spec.ts`)).toContain('첫 화면이 열립니다');
    expect(mockFs.files.get(`${managedWorkDir}/docs/saas-plan.md`)).toContain('SaaS');
  });

  it('does not overwrite an existing Korini app starter', async () => {
    mockFs.files.set(`${managedWorkDir}/package.json`, '{"name":"existing"}\n');

    const written = await ensureKoriniNextStarter(managedWorkDir, '새로 만들어줘');

    expect(written).toEqual([]);
    expect(mockFs.files.get(`${managedWorkDir}/package.json`)).toBe('{"name":"existing"}\n');
    expect(mockFs.files.has(`${managedWorkDir}/app/page.tsx`)).toBe(false);
  });

  it('skips starter generation outside Korini-managed folders', async () => {
    const written = await ensureKoriniNextStarter(outsideWorkDir, '웹앱 만들어줘');

    expect(written).toEqual([]);
    expect(mockFs.files.size).toBe(0);
  });

  it('writes beginner recovery docs, env guide, gitignore safety, and strict CI/CD', async () => {
    const written = await ensureKoriniProjectDeliverables(managedWorkDir, {
      userRequest: '로그인 웹앱 만들어줘',
      workflowName: 'Kimi -> DeepSeek 4 -> Qwen',
      changedFiles: ['app/page.tsx'],
      finalSummary: '첫 화면과 로그인 준비를 만들었습니다.',
      reviewApproved: true,
    });

    expect(written).toEqual(expect.arrayContaining([
      '.gitignore',
      '.env.local.example',
      '.github/workflows/korini-ci.yml',
      'docs/korini-start.md',
      '.bbarit/korini/STATUS.md',
      '.bbarit/korini/RESULT.md',
    ]));
    expect(mockFs.files.get(`${managedWorkDir}/.gitignore`)).toContain('.env.local');
    expect(mockFs.files.get(`${managedWorkDir}/.gitignore`)).toContain('node_modules/');
    expect(mockFs.files.get(`${managedWorkDir}/.env.local.example`)).toContain('DATABASE_URL=');
    expect(mockFs.files.get(`${managedWorkDir}/.env.local.example`)).toContain('NEXT_PUBLIC_SUPABASE_URL=');
    expect(mockFs.files.get(`${managedWorkDir}/.env.local.example`)).toContain('TOSS_PAYMENTS_SECRET_KEY=');
    expect(mockFs.files.has(`${managedWorkDir}/.env.local`)).toBe(false);

    const ci = mockFs.files.get(`${managedWorkDir}/.github/workflows/korini-ci.yml`) || '';
    expect(ci).toContain('Managed by Korini Mode');
    expect(ci).toContain('Secret safety check');
    expect(ci).toContain('run_required_script build');
    expect(ci).toContain('npx playwright install --with-deps');
    expect(ci).toContain('npx playwright test');

    expect(mockFs.files.get(`${managedWorkDir}/docs/korini-start.md`)).toContain('Next.js');
    expect(mockFs.files.get(`${managedWorkDir}/docs/korini-start.md`)).toContain('Vercel');
    expect(mockFs.files.get(`${managedWorkDir}/.bbarit/korini/STATUS.md`)).toContain('로그인 웹앱 만들어줘');
    expect(mockFs.files.get(`${managedWorkDir}/.bbarit/korini/RESULT.md`)).toContain('첫 화면과 로그인 준비');
  });

  it('preserves user-owned CI but regenerates Korini-managed CI', async () => {
    const ciPath = `${managedWorkDir}/.github/workflows/korini-ci.yml`;
    mockFs.files.set(ciPath, 'name: User CI\n');

    let written = await ensureKoriniProjectDeliverables(managedWorkDir);

    expect(written).not.toContain('.github/workflows/korini-ci.yml');
    expect(mockFs.files.get(ciPath)).toBe('name: User CI\n');

    mockFs.files.set(ciPath, 'name: Old Korini CI\n# Managed by Korini Mode. Safe to regenerate.\n');
    written = await ensureKoriniProjectDeliverables(managedWorkDir);

    expect(written).toContain('.github/workflows/korini-ci.yml');
    expect(mockFs.files.get(ciPath)).toContain('name: Korini CI');
    expect(mockFs.files.get(ciPath)).toContain('run_required_script build');
  });
});
