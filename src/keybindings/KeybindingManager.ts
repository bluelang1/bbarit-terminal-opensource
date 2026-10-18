/**
 * Phase 4.2: Keybinding Manager
 *
 * Manages global keyboard shortcuts by mapping keybindings to command IDs.
 * Handles registration, matching, and executing commands.
 */

import { parseKeybinding, matchesEvent, normalizeEventKeyForShortcut, type KeyBindingEntry } from './parser';

export interface KeybindingHandler {
  id: string;
  handler: () => boolean | void;
}

export class KeybindingManager {
  private bindings: KeyBindingEntry[] = [];
  private handlers: Map<string, () => boolean | void> = new Map();
  private listener: ((e: KeyboardEvent) => void) | null = null;

  /** Default keybindings for the app. */
  static defaultBindings(): Array<{ id: string; keys: string }> {
    const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const mod = isMac ? 'cmd' : 'ctrl';
    const fileShortcuts: Array<{ id: string; keys: string }> = [
      { id: 'file.copy', keys: `${mod}+c` },
      { id: 'file.cut', keys: `${mod}+x` },
      { id: 'file.paste', keys: `${mod}+v` },
      { id: 'file.undo', keys: `${mod}+z` },
      // macOS: explicitly support Ctrl+C/X/V as requested, in addition to Cmd+C/X/V.
      ...(isMac
        ? [
            { id: 'file.copy', keys: 'ctrl+c' },
            { id: 'file.cut', keys: 'ctrl+x' },
            { id: 'file.paste', keys: 'ctrl+v' },
          ]
        : []),
    ];

    return [
      { id: 'terminal.new', keys: `${mod}+t` },
      { id: 'terminal.close', keys: `${mod}+w` },
      { id: 'terminal.close-all', keys: `${mod}+shift+w` },
      { id: 'terminal.next', keys: `${mod}+]` },
      { id: 'terminal.previous', keys: `${mod}+[` },
      { id: 'project.next', keys: `${mod}+shift+]` },
      { id: 'project.previous', keys: `${mod}+shift+[` },
      ...(isMac
        ? [
            { id: 'project.next', keys: 'ctrl+shift+]' },
            { id: 'project.previous', keys: 'ctrl+shift+[' },
          ]
        : []),
      { id: 'task.open-last-completed', keys: `${mod}+shift+j` },
      { id: 'project.new', keys: `${mod}+n` },
      { id: 'settings.open', keys: `${mod}+,` },
      { id: 'view.toggle-terminal-mode', keys: `${mod}+shift+f` },
      { id: 'command-palette.toggle', keys: `${mod}+shift+p` },
      { id: 'file.save', keys: `${mod}+s` },
      { id: 'file.open-document', keys: `${mod}+p` },
      { id: 'file.open-selected', keys: `${mod}+o` },
      { id: 'editor.close-all', keys: `${mod}+alt+w` },
      { id: 'editor.goto-line', keys: `${mod}+g` },
      { id: 'file.rename', keys: 'f2' },
      { id: 'terminal.font.increase', keys: `${mod}+=` },
      { id: 'terminal.font.decrease', keys: `${mod}+-` },
      // Split pane shortcuts
      { id: 'split.horizontal', keys: `${mod}+d` },
      { id: 'split.vertical', keys: `${mod}+shift+d` },
      { id: 'split.focus-left', keys: `${mod}+alt+left` },
      { id: 'split.focus-right', keys: `${mod}+alt+right` },
      { id: 'split.focus-up', keys: `${mod}+alt+up` },
      { id: 'split.focus-down', keys: `${mod}+alt+down` },
      // Note system shortcuts
      { id: 'note.search', keys: `${mod}+alt+p` },
      { id: 'note.daily', keys: `${mod}+alt+d` },
      { id: 'note.new', keys: `${mod}+shift+n` },
      { id: 'sidebar.files', keys: `${mod}+shift+e` },
      { id: 'note.togglePreview', keys: `${mod}+shift+v` },
      // File tree shortcuts (active only when sidebar has focus)
      ...fileShortcuts,
      { id: 'file.delete', keys: 'delete' },
      { id: 'file.delete', keys: 'backspace' },
      // Project switch shortcuts (Ctrl on Mac, Alt on Windows/Linux)
      ...(Array.from({ length: 9 }, (_, i) => ({
        id: `project.tab-${i + 1}`,
        keys: `${isMac ? 'ctrl' : 'alt'}+${i + 1}`,
      }))),
      // Terminal tab shortcuts
      { id: 'terminal.tab-1', keys: `${mod}+1` },
      { id: 'terminal.tab-2', keys: `${mod}+2` },
      { id: 'terminal.tab-3', keys: `${mod}+3` },
      { id: 'terminal.tab-4', keys: `${mod}+4` },
      { id: 'terminal.tab-5', keys: `${mod}+5` },
      { id: 'terminal.tab-6', keys: `${mod}+6` },
      { id: 'terminal.tab-7', keys: `${mod}+7` },
      { id: 'terminal.tab-8', keys: `${mod}+8` },
      { id: 'terminal.tab-9', keys: `${mod}+9` },
    ];
  }

  /**
   * Initialize with default bindings, optionally merged with user overrides.
   */
  init(userOverrides?: Array<{ id: string; keys: string }>) {
    const defaults = KeybindingManager.defaultBindings();

    if (userOverrides && userOverrides.length > 0) {
      // User overrides replace ALL default bindings for that ID
      const overriddenIds = new Set(userOverrides.map(o => o.id));
      const kept = defaults.filter(d => !overriddenIds.has(d.id));
      const all = [...kept, ...userOverrides];
      this.bindings = all.map(({ id, keys }) => ({
        id,
        binding: parseKeybinding(keys),
        raw: keys,
      }));
    } else {
      // No overrides: keep all defaults (including multiple bindings per ID)
      this.bindings = defaults.map(({ id, keys }) => ({
        id,
        binding: parseKeybinding(keys),
        raw: keys,
      }));
    }
  }

  /**
   * Register a handler for a command ID.
   */
  register(id: string, handler: () => boolean | void) {
    this.handlers.set(id, handler);
  }

  /**
   * Register multiple handlers at once.
   */
  registerAll(entries: KeybindingHandler[]) {
    for (const entry of entries) {
      this.handlers.set(entry.id, entry.handler);
    }
  }

  /**
   * Unregister a handler.
   */
  unregister(id: string) {
    this.handlers.delete(id);
  }

  /**
   * Start listening for keydown events on the window.
   */
  attach() {
    if (this.listener) return;

    this.listener = (e: KeyboardEvent) => {
      // Always allow Ctrl+C in terminal to send SIGINT - check this first before any other logic
      const k = normalizeEventKeyForShortcut(e);
      const target = e.target as HTMLElement;
      const inTerminal =
        !!target?.closest?.('.xterm') ||
        !!target?.closest?.('[data-terminal-wrap]') ||
        !!target?.closest?.('[data-terminal-scope]');
      
      // Debug logging for Ctrl+C
      if (k === 'c' && (e.ctrlKey || e.metaKey)) {
        console.log('[KeybindingManager Debug] Ctrl/Cmd+C detected:', { 
          inTerminal, 
          ctrl: e.ctrlKey, 
          meta: e.metaKey, 
          target: target?.tagName,
          targetClass: target?.className
        });
      }
      
      // In terminal: Ctrl+C should always send SIGINT (unless text is selected for copy)
      // Don't intercept it at all - let terminal handle it
      if (inTerminal && e.ctrlKey && !e.metaKey && k === 'c') {
        console.log('[KeybindingManager Debug] Letting Ctrl+C through to terminal');
        return; // Let terminal handle Ctrl+C
      }
      
      // In terminal: Cmd+C (macOS) for copy when text is selected
      // Don't intercept - let terminal's own handler manage it
      if (inTerminal && e.metaKey && !e.ctrlKey && k === 'c') {
        console.log('[KeybindingManager Debug] Letting Cmd+C through to terminal');
        return; // Let terminal handle Cmd+C
      }
      
      // In terminal: Ctrl+X, Cmd+X, Ctrl+V, Cmd+V - let terminal handle these
      if (inTerminal && (e.ctrlKey || e.metaKey) && (k === 'x' || k === 'v')) {
        console.log('[KeybindingManager Debug] Letting', k, 'through to terminal');
        return; // Let terminal handle cut/paste
      }

      // Don't intercept if user is typing in an input/textarea
      const tagName = target?.tagName?.toLowerCase();
      const isTyping = tagName === 'input' || tagName === 'textarea' || target?.isContentEditable;
      // xterm, Monaco, and IME bridge textareas inside terminal wrap should allow shortcuts.
      const inEditor = !!target?.closest?.('.monaco-editor') || !!target?.closest?.('.cm-editor');

      // In editor (Monaco/CodeMirror): let standard editing shortcuts pass through
      // so that Ctrl/Cmd+C/V/X/Z/A/Y/S/D/F etc. work natively in the editor.
      if (inEditor && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const editorPassthroughKeys = new Set(['c', 'v', 'x', 'z', 'a', 'y', 'd', 'f', 'h', '/']);
        if (editorPassthroughKeys.has(k)) {
          // Exception: Cmd+S should still trigger app file.save
          if (k !== 's') return;
        }
      }
      const allowInInputs = inTerminal || inEditor;

      if (isTyping && !allowInInputs) {
        // Still allow certain global shortcuts even in inputs
        const globalShortcuts = ['command-palette.toggle', 'settings.open', 'file.open-document', 'view.toggle-terminal-mode', 'view.toggle-editor', 'view.toggle-sidebar', 'task.open-last-completed'];
        for (const binding of this.bindings) {
          if (globalShortcuts.includes(binding.id) && matchesEvent(binding.binding, e)) {
            e.preventDefault();
            const handler = this.handlers.get(binding.id);
            if (handler) handler();
            return;
          }
        }
        return;
      }

      for (const binding of this.bindings) {
        if (matchesEvent(binding.binding, e)) {
          const handler = this.handlers.get(binding.id);
          if (handler) {
            const result = handler();
            // If handler returns false, don't preventDefault (pass through to default behavior)
            if (result !== false) {
              if (binding.id === 'file.copy' || binding.id === 'file.paste' || binding.id === 'file.cut') {
                console.log('[ClipDebug] KeybindingManager BLOCKING', binding.id, '(handler returned', result, ')');
              }
              e.preventDefault();
              e.stopPropagation();
            } else {
              if (binding.id === 'file.copy' || binding.id === 'file.paste' || binding.id === 'file.cut') {
                console.log('[ClipDebug] KeybindingManager passing through', binding.id, '(handler returned false)');
              }
            }
          } else {
            console.log('[ClipDebug] KeybindingManager BLOCKING', binding.id, '(NO handler registered!)');
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', this.listener, true);
  }

  /**
   * Stop listening.
   */
  detach() {
    if (this.listener) {
      window.removeEventListener('keydown', this.listener, true);
      this.listener = null;
    }
  }

  /**
   * Get all registered bindings (for display in settings/command palette).
   */
  getBindings(): KeyBindingEntry[] {
    return [...this.bindings];
  }

  /**
   * Destroy the manager.
   */
  destroy() {
    this.detach();
    this.handlers.clear();
    this.bindings = [];
  }
}
