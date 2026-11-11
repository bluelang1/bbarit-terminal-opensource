// Set on <html> while hint mode is open. KeybindingManager skips every shortcut
// while it is present, so hint keys (and the toggle key, which closes hint mode
// itself) never reach other handlers whatever the listener order is.
export const HINT_MODE_ATTR = 'data-hint-mode';

export function isHintModeActive(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  return !!doc?.documentElement?.hasAttribute(HINT_MODE_ATTR);
}
