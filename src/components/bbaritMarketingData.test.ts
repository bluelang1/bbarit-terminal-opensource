import { describe, expect, it } from 'vitest';

import {
  EMPTY_BRAND_KIT, MARKETING_SUGGESTIONS, MAX_IMAGE_JOBS, SUGGESTION_CATEGORIES,
  brandKitContext, brandKitFilled, filterSessions, formatMarketingContext,
  parseBrandKit, parseImageJobs, parseMarketingSuite,
} from './bbaritMarketingData';

describe('parseBrandKit', () => {
  it('returns empty kit for missing or corrupted storage', () => {
    expect(parseBrandKit(null)).toEqual(EMPTY_BRAND_KIT);
    expect(parseBrandKit('not json')).toEqual(EMPTY_BRAND_KIT);
    expect(parseBrandKit('42')).toEqual(EMPTY_BRAND_KIT);
  });

  it('keeps known string fields and ignores junk', () => {
    const kit = parseBrandKit('{"name":"Acme","tone":42,"junk":true,"keywords":"seo, growth"}');
    expect(kit.name).toBe('Acme');
    expect(kit.keywords).toBe('seo, growth');
    expect(kit.tone).toBe('');
    expect('junk' in kit).toBe(false);
  });
});

describe('brandKitFilled', () => {
  it('is false for empty or whitespace-only kits', () => {
    expect(brandKitFilled(EMPTY_BRAND_KIT)).toBe(false);
    expect(brandKitFilled({ ...EMPTY_BRAND_KIT, name: '   ' })).toBe(false);
  });

  it('is true once any field has content', () => {
    expect(brandKitFilled({ ...EMPTY_BRAND_KIT, audience: 'founders' })).toBe(true);
  });
});

describe('brandKitContext', () => {
  it('returns empty string for an empty kit', () => {
    expect(brandKitContext(EMPTY_BRAND_KIT)).toBe('');
  });

  it('formats filled fields and skips empty ones', () => {
    const ctx = brandKitContext({
      ...EMPTY_BRAND_KIT, name: 'Acme', website: 'https://acme.io', tone: 'Bold', keywords: 'seo',
    });
    expect(ctx).toContain('[Brand Kit — apply to all marketing work]');
    expect(ctx).toContain('- Brand: Acme (https://acme.io)');
    expect(ctx).toContain('- Tone of voice: Bold');
    expect(ctx).toContain('- Core keywords: seo');
    expect(ctx).not.toContain('- Industry:');
  });

  it('falls back to a website line when the name is empty', () => {
    const ctx = brandKitContext({ ...EMPTY_BRAND_KIT, website: 'https://acme.io' });
    expect(ctx).toContain('- Website: https://acme.io');
    expect(ctx).not.toContain('- Brand:');
  });
});

describe('filterSessions', () => {
  const sessions = [
    { title: 'SEO audit for landing page' },
    { title: 'Email welcome flow' },
    { title: 'seo keyword research' },
  ];

  it('returns all sessions for an empty query', () => {
    expect(filterSessions(sessions, '')).toBe(sessions);
    expect(filterSessions(sessions, '   ')).toBe(sessions);
  });

  it('matches case-insensitive substrings', () => {
    expect(filterSessions(sessions, 'SEO').map((s) => s.title))
      .toEqual(['SEO audit for landing page', 'seo keyword research']);
    expect(filterSessions(sessions, 'nothing')).toEqual([]);
  });
});

describe('parseMarketingSuite', () => {
  const sample = JSON.stringify({
    subscribers: [
      { status: 'subscribed', tags: ['vip'] },
      { status: 'pending', tags: ['vip', 'trial'] },
    ],
    campaigns: [
      { status: 'sent', opens: 10, clicks: 3, revenue: 100 },
      { status: 'sent', opens: 5, clicks: 2, revenue: 50 },
      { status: 'draft', opens: 999, clicks: 999, revenue: 999 },
    ],
    automations: [{ enabled: true }, { enabled: false }],
  });

  it('returns null when there is no usable data', () => {
    expect(parseMarketingSuite(null)).toBeNull();
    expect(parseMarketingSuite('garbage')).toBeNull();
    expect(parseMarketingSuite('{"subscribers":[],"campaigns":[]}')).toBeNull();
  });

  it('aggregates only sent campaigns and dedupes segments', () => {
    const stats = parseMarketingSuite(sample);
    expect(stats).toEqual({
      subscribers: 2, active: 1, segments: 'vip, trial',
      campaignsSent: 2, opens: 15, clicks: 5, revenue: 150,
      automationsOn: 1, automationsTotal: 2,
    });
  });
});

describe('formatMarketingContext', () => {
  it('returns empty string without data', () => {
    expect(formatMarketingContext(null)).toBe('');
  });

  it('renders the read-only context block', () => {
    const ctx = formatMarketingContext(JSON.stringify({
      subscribers: [{ status: 'subscribed' }, { status: 'pending' }],
      campaigns: [{ status: 'sent', opens: 4, clicks: 1, revenue: 20 }],
      automations: [],
    }));
    expect(ctx).toContain('[Email Marketing Data — read-only context]');
    expect(ctx).toContain('- Total subscribers: 2 (1 active, 1 pending/cleaned)');
    expect(ctx).toContain('- Campaigns sent: 1 | Total opens: 4 | Total clicks: 1 | Attributed revenue: $20');
  });
});

describe('parseImageJobs', () => {
  const DIR = '/ws/session';

  it('returns no jobs for corrupted or empty input', () => {
    expect(parseImageJobs('garbage', DIR)).toEqual([]);
    expect(parseImageJobs('{"jobs":[]}', DIR)).toEqual([]);
    expect(parseImageJobs('{"jobs":[{"file":"x.png"}]}', DIR)).toEqual([]);
  });

  it('parses a valid batch with sizes and defaults', () => {
    const jobs = parseImageJobs(JSON.stringify({ jobs: [
      { file: 'hero.png', prompt: 'a hero image', size: '1080x1350' },
      { prompt: 'no file or size given' },
    ] }), DIR);
    expect(jobs).toEqual([
      { file: 'hero.png', outPath: '/ws/session/hero.png', prompt: 'a hero image', w: 1080, h: 1350, refPath: undefined },
      { file: 'image-2.png', outPath: '/ws/session/image-2.png', prompt: 'no file or size given', w: 1024, h: 1024, refPath: undefined },
    ]);
  });

  it('sanitizes file names to safe png basenames', () => {
    const jobs = parseImageJobs(JSON.stringify({ jobs: [
      { file: '../../etc/passwd', prompt: 'p' },
      { file: 'banner.jpg', prompt: 'p' },
      { file: 'sub/dir/logo', prompt: 'p' },
    ] }), DIR);
    expect(jobs.map((j) => j.file)).toEqual(['passwd.png', 'banner.png', 'logo.png']);
    for (const j of jobs) expect(j.outPath).toBe(`${DIR}/${j.file}`);
  });

  it('dedupes duplicate names and rejects out-of-range sizes', () => {
    const jobs = parseImageJobs(JSON.stringify({ jobs: [
      { file: 'ad.png', prompt: 'p', size: '9999x10' },
      { file: 'ad.png', prompt: 'p' },
    ] }), DIR);
    expect(jobs.map((j) => j.file)).toEqual(['ad.png', 'ad-2.png']);
    expect(jobs[0]).toMatchObject({ w: 1024, h: 1024 });
  });

  it('only accepts refs inside the workspace', () => {
    const jobs = parseImageJobs(JSON.stringify({ jobs: [
      { file: 'a.png', prompt: 'p', ref: 'existing.png' },
      { file: 'b.png', prompt: 'p', ref: '../outside.png' },
      { file: 'c.png', prompt: 'p', ref: '/abs/path.png' },
    ] }), DIR);
    expect(jobs.map((j) => j.refPath)).toEqual(['/ws/session/existing.png', undefined, undefined]);
  });

  it('caps the batch at MAX_IMAGE_JOBS', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ file: `img-${i}.png`, prompt: 'p' }));
    expect(parseImageJobs(JSON.stringify({ jobs: many }), DIR)).toHaveLength(MAX_IMAGE_JOBS);
  });
});

describe('MARKETING_SUGGESTIONS', () => {
  it('only uses known categories and covers every category', () => {
    for (const s of MARKETING_SUGGESTIONS) {
      expect(SUGGESTION_CATEGORIES).toContain(s.category);
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.prompt.trim().length).toBeGreaterThan(40);
    }
    for (const c of SUGGESTION_CATEGORIES) {
      expect(MARKETING_SUGGESTIONS.some((s) => s.category === c)).toBe(true);
    }
  });

  it('has unique titles', () => {
    const titles = MARKETING_SUGGESTIONS.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
