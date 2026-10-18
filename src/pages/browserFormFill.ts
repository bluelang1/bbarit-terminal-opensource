// Auto form-fill planner for the browser agent.
//
// The agent can already type into one field at a time (browser_type). Real form
// automation means: given a values dict ({email, name, message, ...}) and the page's
// detected fields, decide WHICH field gets WHICH value, then fill them in one pass.
// The matching heuristic is the hard, error-prone part, so it lives here as a pure,
// exhaustively tested function; the in-page collection and typing stay thin.
//
// D1: Match by field IDENTITY (name/id/label/placeholder/autocomplete/type), never
//     by DOM order. Reason: order is fragile and silently fills the wrong box —
//     the classic auto-fill bug. Cost: a field with no identifying text is skipped
//     rather than guessed. Escape hatch: unmatched values are reported back so the
//     agent can place them explicitly with browser_type.

export interface FormField {
  ref: string;              // @eN ref or CSS selector to target
  name?: string;
  id?: string;
  type?: string;            // text|email|password|tel|number|textarea|select|checkbox...
  label?: string;
  placeholder?: string;
  autocomplete?: string;
}

export interface FillAction { ref: string; value: string; key: string; type: string }
export interface FillPlan { actions: FillAction[]; unmatched: string[]; ambiguous: string[] }

// Canonical keys → the tokens that identify a field for that key. Order matters:
// more specific keys are tested first so "confirm_password" beats "password".
const FIELD_SYNONYMS: Array<{ key: string; tokens: string[]; type?: string }> = [
  { key: 'confirmPassword', tokens: ['confirm', 'retype', 'repeat', 'verifypassword', 'password2', 'passwordconfirm'] },
  { key: 'password', tokens: ['password', 'passwd', 'pwd'], type: 'password' },
  { key: 'email', tokens: ['email', 'e-mail', 'mail'], type: 'email' },
  { key: 'firstName', tokens: ['firstname', 'givenname', 'fname', 'forename'] },
  { key: 'lastName', tokens: ['lastname', 'surname', 'familyname', 'lname'] },
  { key: 'fullName', tokens: ['fullname', 'yourname', 'name'] },
  { key: 'username', tokens: ['username', 'userid', 'login', 'handle', 'nickname'] },
  { key: 'phone', tokens: ['phone', 'tel', 'mobile', 'cell'], type: 'tel' },
  { key: 'company', tokens: ['company', 'organization', 'organisation', 'business'] },
  { key: 'address', tokens: ['address', 'street', 'addr'] },
  { key: 'city', tokens: ['city', 'town'] },
  { key: 'state', tokens: ['state', 'province', 'region'] },
  { key: 'zip', tokens: ['zip', 'postal', 'postcode'] },
  { key: 'country', tokens: ['country', 'nation'] },
  { key: 'subject', tokens: ['subject', 'title', 'topic'] },
  { key: 'message', tokens: ['message', 'comment', 'body', 'inquiry', 'enquiry', 'details', 'description'] },
  { key: 'search', tokens: ['search', 'query', 'q'] },
];

function normalize(text: unknown): string {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The searchable identity string for a field.
function fieldHaystack(f: FormField): string {
  return [f.name, f.id, f.label, f.placeholder, f.autocomplete].map(normalize).join(' ');
}

// Canonicalize a user-supplied value key to one of our known keys (or itself).
// Exact matches win first (so "username" stays username, not fullName via "name");
// only then a substring fallback maps compounds like "zipcode" -> zip.
export function canonicalKey(rawKey: string): string {
  const n = normalize(rawKey);
  if (!n) return rawKey;
  for (const syn of FIELD_SYNONYMS) {
    if (normalize(syn.key) === n) return syn.key;
    if (syn.tokens.some((t) => normalize(t) === n)) return syn.key;
  }
  // Substring fallback: the key CONTAINS a distinctive token (>=3 chars); longest wins.
  let best: string | null = null;
  let bestLen = 0;
  for (const syn of FIELD_SYNONYMS) {
    for (const token of syn.tokens) {
      const t = normalize(token);
      if (t.length >= 3 && n.includes(t) && t.length > bestLen) { best = syn.key; bestLen = t.length; }
    }
  }
  return best || rawKey;
}

// Score how well a field matches a canonical key: higher is better, 0 = no match.
function scoreFieldForKey(field: FormField, key: string): number {
  const syn = FIELD_SYNONYMS.find((s) => s.key === key);
  const hay = fieldHaystack(field);
  const keyTokens = syn ? [normalize(key), ...syn.tokens.map(normalize)] : [normalize(key)];
  let best = 0;
  for (const token of keyTokens) {
    if (!token) continue;
    if (hay.split(' ').includes(token)) best = Math.max(best, 3);   // exact word hit
    else if (hay.includes(token)) best = Math.max(best, 2);          // substring hit
  }
  // A matching input type is itself a match signal (an email-typed box named
  // "contact" should still take the email value), and reinforces a name hit.
  if (syn?.type && normalize(field.type) === normalize(syn.type)) best = best > 0 ? best + 1 : 2;
  return best;
}

// Build a fill plan: assign each value to its best unique field.
export function planFormFill(values: Record<string, unknown>, fields: FormField[]): FillPlan {
  const actions: FillAction[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const usedRefs = new Set<string>();
  const entries = Object.entries(values || {}).filter(([, v]) => v !== undefined && v !== null && String(v).length > 0);

  for (const [rawKey, rawValue] of entries) {
    const key = canonicalKey(rawKey);
    const value = String(rawValue);
    let bestField: FormField | null = null;
    let bestScore = 0;
    let tiedCount = 0;
    for (const field of fields || []) {
      if (usedRefs.has(field.ref)) continue;
      const score = scoreFieldForKey(field, key);
      if (score > bestScore) { bestScore = score; bestField = field; tiedCount = 1; }
      else if (score === bestScore && score > 0) tiedCount++;
    }
    if (!bestField || bestScore === 0) { unmatched.push(rawKey); continue; }
    if (tiedCount > 1 && bestScore <= 2) ambiguous.push(rawKey); // weak + tied: note it, still fill best
    usedRefs.add(bestField.ref);
    actions.push({ ref: bestField.ref, value, key, type: bestField.type || 'text' });
  }
  return { actions, unmatched, ambiguous };
}
