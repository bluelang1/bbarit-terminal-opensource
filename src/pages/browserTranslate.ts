// Multi-language content translation helpers for the browser agent.
//
// The agent can read page text (browser_text); translating it is a natural, high-value
// extension for a world-facing browser. The LLM does the actual translation, so this
// module owns the pure, testable parts: resolving a target-language name, chunking
// long page text within a token budget, and building the translate instruction.
//
// D1: Chunk on paragraph/sentence boundaries, never mid-word.
//     Reason: splitting mid-sentence produces mistranslations at the seams. Cost: a
//     chunk may slightly exceed the soft limit to avoid breaking a huge sentence.

// BCP-47-ish code → English language name the model understands.
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', 'zh-cn': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', hi: 'Hindi', vi: 'Vietnamese', th: 'Thai',
  id: 'Indonesian', tr: 'Turkish', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
};

// Resolve a user-provided language (code or name) to a canonical English name.
export function resolveLanguageName(input: unknown): string | null {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (LANGUAGE_NAMES[raw]) return LANGUAGE_NAMES[raw];
  const byName = Object.values(LANGUAGE_NAMES).find((n) => n.toLowerCase() === raw);
  if (byName) return byName;
  // Common endonyms / aliases.
  const alias: Record<string, string> = {
    '한국어': 'Korean', '国语': 'Chinese', '中文': 'Chinese', '日本語': 'Japanese',
    english: 'English', korean: 'Korean', japanese: 'Japanese', chinese: 'Chinese',
    spanish: 'Spanish', french: 'French', german: 'German',
  };
  return alias[raw] || null;
}

export const DEFAULT_CHUNK_CHARS = 3_500;

// Split text into translation chunks on paragraph then sentence boundaries.
export function chunkForTranslation(text: string, maxChars = DEFAULT_CHUNK_CHARS): string[] {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const paras = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };
  for (const para of paras) {
    if ((buf + '\n\n' + para).length <= maxChars) { buf = buf ? `${buf}\n\n${para}` : para; continue; }
    flush();
    if (para.length <= maxChars) { buf = para; continue; }
    // A single oversized paragraph: split on sentence boundaries.
    const sentences = para.split(/(?<=[.!?。！？])\s+/);
    for (const s of sentences) {
      if ((buf + ' ' + s).length <= maxChars) { buf = buf ? `${buf} ${s}` : s; }
      else { flush(); buf = s; }
    }
  }
  flush();
  return chunks;
}

export function buildTranslatePrompt(languageName: string, chunk: string): string {
  return `Translate the following text into ${languageName}. Preserve meaning, tone and any list/heading structure. Output ONLY the translation, no notes.\n\n${chunk}`;
}
