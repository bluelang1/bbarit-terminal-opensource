import { describe, expect, it } from 'vitest';
import { assignHintLabels, HINT_ALPHABET } from './hintLabels';

const isPrefixFree = (labels: string[]) =>
  labels.every((a, i) => labels.every((b, j) => i === j || !b.startsWith(a)));

describe('assignHintLabels', () => {
  it.each([0, 1, 36, 37, 100, 400, 1296])('gives %i targets unique, prefix-free labels', (count) => {
    const labels = assignHintLabels(count);
    expect(labels).toHaveLength(count);
    expect(new Set(labels).size).toBe(count);
    expect(isPrefixFree(labels)).toBe(true);
    for (const label of labels) {
      expect(label.length).toBeGreaterThanOrEqual(1);
      expect(label.length).toBeLessThanOrEqual(2);
      for (const ch of label) expect(HINT_ALPHABET).toContain(ch);
    }
  });

  it('uses one character each up to 36 targets, in alphabet order', () => {
    expect(assignHintLabels(3)).toEqual(['1', '2', '3']);
    expect(assignHintLabels(36).join('')).toBe(HINT_ALPHABET);
  });

  it('keeps single characters for the first targets and reserves trailing characters as prefixes', () => {
    const labels = assignHintLabels(37);
    expect(labels.slice(0, 35)).toEqual(HINT_ALPHABET.slice(0, 35).split(''));
    expect(labels.slice(35)).toEqual(['z1', 'z2']);
    expect(labels).not.toContain('z');
  });

  it('reserves as few prefixes as needed', () => {
    const labels = assignHintLabels(100);
    const singles = labels.filter((l) => l.length === 1);
    // 34 singles + 2 prefixes (y, z) × 36 = 106 ≥ 100; 35 singles + 1 × 36 = 71 < 100.
    expect(singles).toHaveLength(34);
    expect(new Set(labels.filter((l) => l.length === 2).map((l) => l[0]))).toEqual(new Set(['y', 'z']));
  });

  it('caps at alphabet² labels', () => {
    expect(assignHintLabels(2000)).toHaveLength(1296);
  });
});
