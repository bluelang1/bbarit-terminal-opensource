export interface HarnessMessageLike {
  role: 'human' | 'assistant' | 'tool' | 'system';
  content: string;
}

export function getRecentConversationContext(
  messages: HarnessMessageLike[],
  maxMessages = 6,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const list = [...(messages || [])];
  const trimmed = list.length > 0 && list[list.length - 1]?.role === 'human'
    ? list.slice(0, -1)
    : list;
  return trimmed
    .slice(-maxMessages)
    .filter(message => message.role === 'human' || message.role === 'assistant')
    .map(message => ({
      role: message.role === 'human' ? 'user' : 'assistant',
      content: message.content,
    }));
}

export function formatRecentConversationContext(
  messages: HarnessMessageLike[],
  maxMessages = 6,
): string {
  const recent = getRecentConversationContext(messages, maxMessages);
  if (recent.length === 0) return '';
  return recent
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n');
}

export function shouldContinueCliSession(messageCount: number, isDirectConversation: boolean): boolean {
  if (isDirectConversation) return false;
  return messageCount > 1;
}
