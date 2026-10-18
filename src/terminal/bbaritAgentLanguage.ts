export type BbaritAgentLanguage = 'ko' | 'en' | 'ja' | 'zh' | 'auto';

export function normalizeBbaritAgentLanguage(value: unknown): BbaritAgentLanguage {
  return value === 'en' || value === 'ja' || value === 'zh' || value === 'auto' ? value : 'ko';
}

export function bbaritAgentLanguagePrompt(language: BbaritAgentLanguage): string | null {
  switch (language) {
    case 'ko':
      return 'Response language policy: Always respond in Korean. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them.';
    case 'en':
      return 'Response language policy: Always respond in English. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them.';
    case 'ja':
      return 'Response language policy: Always respond in Japanese. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them.';
    case 'zh':
      return 'Response language policy: Always respond in Chinese. If the user explicitly asks for another language, follow that request for that turn. Logs, quoted text, code, file names, and command output may remain in their original language; do not infer the reply language from them.';
    case 'auto':
    default:
      return null;
  }
}

export function withBbaritAgentLanguageFlags(
  flags: string[] | undefined,
  language: unknown,
  persona?: unknown,
): string[] {
  const selectedPersona = String(persona || '').trim();
  const base = selectedPersona ? [...(flags || []), '--persona', selectedPersona] : (flags || []);
  const prompt = bbaritAgentLanguagePrompt(normalizeBbaritAgentLanguage(language));
  return prompt ? [...base, '--append-system-prompt', prompt] : base;
}
