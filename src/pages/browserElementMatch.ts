// Natural-language element matching.
//
// The agent reads the page as a list of interactive elements (@eN ref, role, name).
// This lets it click by DESCRIPTION ("the login button", "검색 입력창") instead of a
// brittle CSS selector: score each candidate against the description and return the
// best @eN ref. Pure so the scoring is deterministic and tested.
//
// D1: Score = token overlap on the accessible name (weighted) + role hint + exact/
//     prefix bonuses. A clear winner must beat the runner-up by a margin, else the
//     match is AMBIGUOUS (the caller should ask rather than click the wrong thing).

export interface PageElement {
  ref: string;
  role?: string;
  name?: string;
}

export interface MatchResult {
  ref: string | null;
  name?: string;
  score: number;
  ambiguous: boolean;
  candidates: Array<{ ref: string; name: string; score: number }>;
}

// Role words the user might say, mapped to ARIA-ish roles. Plain keywords (not \b
// regex) so Korean words — which have no ASCII word boundary — match too.
const ROLE_HINTS: Array<{ keywords: string[]; roles: string[] }> = [
  { keywords: ['button', 'btn', '버튼'], roles: ['button'] },
  { keywords: ['link', '링크'], roles: ['link'] },
  { keywords: ['input', 'field', 'box', '입력', '칸'], roles: ['textbox', 'searchbox', 'combobox'] },
  { keywords: ['search', '검색'], roles: ['searchbox', 'textbox'] },
  { keywords: ['checkbox', '체크박스'], roles: ['checkbox'] },
  { keywords: ['tab', '탭'], roles: ['tab'] },
];

function rolesFor(description: string): string[] {
  const lower = String(description || '').toLowerCase();
  const toks = tokens(description);
  return ROLE_HINTS
    .filter((h) => h.keywords.some((k) => toks.includes(k) || lower.includes(k)))
    .flatMap((h) => h.roles);
}

function tokens(s: unknown): string[] {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

// Stopwords that should not drive a match ("the login button" → "login").
const STOP = new Set(['the', 'a', 'an', 'click', 'press', 'on', 'button', 'link', 'to', 'my', 'this', '그', '이', '저', '버튼', '링크', '을', '를', '클릭']);

export function scoreElement(queryTokens: string[], desiredRoles: string[], el: PageElement): number {
  const nameToks = tokens(el.name);
  if (!nameToks.length && !el.role) return 0;
  const nameSet = new Set(nameToks);
  const nameStr = nameToks.join(' ');
  const nameConcat = nameToks.join('');             // "log in" -> "login"
  let score = 0;

  const content = queryTokens.filter((t) => !STOP.has(t));
  for (const t of content) {
    if (nameSet.has(t)) score += 3;                        // exact word
    else if (nameStr.includes(t)) score += 1.5;            // substring within a word
    else if (t.length >= 3 && nameConcat.includes(t)) score += 2; // space-insensitive ("login" ~ "log in")
  }
  // Whole-phrase exact/prefix bonus.
  const phrase = content.join(' ');
  if (phrase && nameStr === phrase) score += 4;
  else if (phrase && nameStr.startsWith(phrase)) score += 2;

  // Role hint: reward a matching role, mild penalty for a clearly wrong one.
  if (desiredRoles.length) {
    if (el.role && desiredRoles.includes(el.role)) score += 2;
  }
  return score;
}

export function matchElement(description: string, elements: PageElement[], opts: { margin?: number } = {}): MatchResult {
  const margin = opts.margin ?? 2;
  const qTokens = tokens(description);
  const desiredRoles = rolesFor(description);

  const scored = (elements || [])
    .filter((e) => e && e.ref)
    .map((e) => ({ ref: e.ref, name: String(e.name || ''), score: scoreElement(qTokens, desiredRoles, e) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { ref: null, score: 0, ambiguous: false, candidates: [] };
  const top = scored[0];
  const runnerUp = scored[1];
  const ambiguous = !!runnerUp && top.score - runnerUp.score < margin;
  return {
    ref: ambiguous ? null : top.ref,
    name: top.name,
    score: top.score,
    ambiguous,
    candidates: scored.slice(0, 5),
  };
}
