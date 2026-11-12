// Hint labels: short keys typed to pick a hinted element (see useHintMode.ts).

export const HINT_ALPHABET = '1234567890abcdefghijklmnopqrstuvwxyz';

/**
 * Labels for `count` targets, in target order. Up to alphabet.length targets get
 * one character each. Beyond that the last `p` alphabet characters become
 * prefixes of two-character labels and are never used alone, so no label is a
 * prefix of another: the first targets keep single characters, the rest get two.
 * At most alphabet.length² targets can be labelled; extra targets get none.
 */
export function assignHintLabels(count: number, alphabet: string = HINT_ALPHABET): string[] {
  const n = alphabet.length;
  if (count <= 0 || n === 0) return [];
  if (count <= n) return alphabet.slice(0, count).split('');

  const capacity = n * n;
  const total = Math.min(count, capacity);
  // Smallest p with (n - p) singles + p * n doubles >= total.
  let prefixes = Math.ceil((total - n) / (n - 1));
  if (prefixes > n) prefixes = n;
  const singles = n - prefixes;

  const labels: string[] = [];
  for (let i = 0; i < singles && labels.length < total; i += 1) labels.push(alphabet[i]);
  for (let p = singles; p < n && labels.length < total; p += 1) {
    for (let c = 0; c < n && labels.length < total; c += 1) labels.push(alphabet[p] + alphabet[c]);
  }
  return labels;
}
