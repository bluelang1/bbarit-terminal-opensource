import { describe, expect, it } from 'vitest';
import {
  buildDesignTokens,
  formatDesignSummary,
  rankColors,
  renderDesignCss,
  toHex,
  type DesignSignals,
} from './browserDesignExtract';

describe('toHex', () => {
  // 정상 + 매핑: rgb/rgba → hex, passthrough hex/named.
  it('converts rgb/rgba to hex and passes through hex', () => {
    expect(toHex('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(toHex('rgba(37, 99, 235, 0.5)')).toBe('#2563eb');
    expect(toHex('#ABCDEF')).toBe('#abcdef');
    expect(toHex('white')).toBe('white');
  });
});

describe('rankColors', () => {
  // 정상: ranks by usage, most-used first.
  it('ranks colors by usage count', () => {
    const r = rankColors([
      { value: 'rgb(0,0,0)', count: 5 },
      { value: 'rgb(255,0,0)', count: 50 },
      { value: 'rgb(0,0,255)', count: 20 },
    ]);
    expect(r[0]).toBe('#ff0000');
    expect(r[1]).toBe('#0000ff');
  });

  // 매핑: near-duplicate colors merge (counts combine).
  it('merges near-duplicate swatches', () => {
    const r = rankColors([
      { value: '#ffffff', count: 10 },
      { value: '#fefefe', count: 40 },   // ≈ white
      { value: '#2563eb', count: 20 },
    ]);
    // white variants merged → combined count 50 outranks the blue.
    expect(r[0]).toMatch(/#f[ef]f[ef]f[ef]/);
    expect(r).toContain('#2563eb');
    expect(r.length).toBe(2);
  });

  // 변조/None: transparent/empty dropped, empty input safe.
  it('drops transparent and empty', () => {
    expect(rankColors([{ value: 'transparent', count: 9 }, { value: 'rgba(0,0,0,0)', count: 9 }])).toEqual([]);
    expect(rankColors(undefined)).toEqual([]);
  });
});

describe('buildDesignTokens', () => {
  const signals: DesignSignals = {
    colors: [{ value: 'rgb(17,17,17)', count: 100 }, { value: 'rgb(37,99,235)', count: 30 }],
    backgrounds: [{ value: 'rgb(255,255,255)', count: 200 }],
    fontFamilies: [{ value: 'Inter, sans-serif', count: 80 }, { value: 'Inter, sans-serif', count: 5 }],
    fontSizes: [16, 14, 24, 16, 32, 14],
    fontWeights: [400, 700, 400, 600],
    radii: [8, 4, 8, 12],
    shadows: ['0 1px 2px rgba(0,0,0,0.1)', 'none', '0 1px 2px rgba(0,0,0,0.1)'],
    spacings: [8, 16, 24, 8, 4],
  };
  it('builds a deduped, sorted token set', () => {
    const t = buildDesignTokens(signals);
    expect(t.palette[0]).toBe('#111111');
    expect(t.backgrounds).toEqual(['#ffffff']);
    expect(t.fontFamilies).toEqual(['Inter, sans-serif']);   // deduped
    expect(t.typeScale).toEqual([14, 16, 24, 32]);           // sorted unique
    expect(t.fontWeights).toEqual([400, 600, 700]);
    expect(t.radii).toEqual([4, 8, 12]);
    expect(t.shadows).toEqual(['0 1px 2px rgba(0,0,0,0.1)']); // 'none' dropped, deduped
    expect(t.spacing).toEqual([4, 8, 16, 24]);
  });
  // None/변조: empty signals give empty tokens, no throw.
  it('handles empty signals', () => {
    const t = buildDesignTokens({});
    expect(t.palette).toEqual([]);
    expect(t.typeScale).toEqual([]);
    expect(buildDesignTokens(undefined as unknown as DesignSignals).palette).toEqual([]);
  });
});

describe('renderDesignCss', () => {
  it('renders a :root token stylesheet', () => {
    const css = renderDesignCss(buildDesignTokens({
      colors: [{ value: 'rgb(17,17,17)', count: 10 }],
      backgrounds: [{ value: 'rgb(255,255,255)', count: 10 }],
      fontFamilies: [{ value: 'Inter', count: 10 }],
      fontSizes: [16, 24], radii: [8], spacings: [16], shadows: ['0 1px 2px #0002'],
    }), { name: 'example.com' });
    expect(css).toContain('/* Design tokens — example.com');
    expect(css).toContain(':root {');
    expect(css).toContain('--color-1: #111111;');
    expect(css).toContain('--bg-1: #ffffff;');
    expect(css).toContain('--font-body: Inter;');
    expect(css).toContain('--text-1: 16px;');
    expect(css).toContain('--radius-1: 8px;');
    expect(css).toContain('--space-1: 16px;');
    expect(css).toContain('--shadow-1: 0 1px 2px #0002;');
    expect(css.trim().endsWith('}')).toBe(true);
  });
});

describe('formatDesignSummary', () => {
  it('summarizes the token set', () => {
    const md = formatDesignSummary(buildDesignTokens({ colors: [{ value: '#111', count: 1 }], fontSizes: [16] }));
    expect(md).toContain('Palette');
    expect(md).toContain('Type scale: 16px');
  });
});
