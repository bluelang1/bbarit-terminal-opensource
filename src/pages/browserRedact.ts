// Secret redaction for agent context (security hardening).
//
// The agent feeds page text, tool results and network entries into the LLM. Those can
// contain secrets — credit-card numbers, API keys, JWTs, bearer tokens, passwords in
// URLs. Sending them to the model (and storing them in the conversation) is a leak.
// This masks them BEFORE they enter the context. Pure so the patterns are tested.
//
// D1: Redact by well-known secret SHAPES, not by field name — a page can label a token
//     anything. Replace with a typed placeholder ("[REDACTED:card]") so the agent still
//     knows a value was there without seeing it. Cost: an occasional false positive on a
//     long digit run; acceptable for a security default. Escape hatch: it is a pure fn
//     the caller can skip for a specific read.

export interface RedactionRule { name: string; re: RegExp }

// Order matters: more specific patterns first.
export const REDACTION_RULES: RedactionRule[] = [
  // JWT: three base64url segments separated by dots.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Bearer / Authorization tokens.
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}/g },
  // Common API-key prefixes (OpenAI/Anthropic/Stripe/GitHub/Google/Slack).
  { name: 'apikey', re: /\b(sk-[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  // password / token / secret / api_key given a value in query strings or "key=value".
  { name: 'credential', re: /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|auth)\s*[=:]\s*("?)[^\s"&,}]{4,}\2/gi },
  // Credit-card-like: 13-16 digits, optionally grouped by spaces/dashes. Starts and
  // ENDS on a digit so a trailing separator/word is not swallowed.
  { name: 'card', re: /\b\d(?:[ -]?\d){12,15}\b/g },
];

export interface RedactResult { text: string; counts: Record<string, number> }

export function redactSecrets(input: unknown): RedactResult {
  let text = String(input ?? '');
  const counts: Record<string, number> = {};
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.re, (match) => {
      // For credential key=value, keep the key so the model sees WHAT was redacted.
      if (rule.name === 'credential') {
        const key = match.split(/[=:]/)[0].trim();
        counts[rule.name] = (counts[rule.name] || 0) + 1;
        return `${key}=[REDACTED:credential]`;
      }
      counts[rule.name] = (counts[rule.name] || 0) + 1;
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text, counts };
}

// Convenience: just the redacted string (for hot paths that don't need counts).
export function redact(input: unknown): string {
  return redactSecrets(input).text;
}

export function totalRedactions(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}
