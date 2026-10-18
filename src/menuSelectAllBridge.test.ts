import { describe, it, expect, afterEach, vi } from 'vitest';
import { performSelectAll } from './menuSelectAllBridge';

describe('performSelectAll', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('should_dispatch_synthetic_cmd_a_keydown_to_active_element', () => {
    const div = document.createElement('div');
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    let seen: KeyboardEvent | null = null;
    div.addEventListener('keydown', (e) => { seen = e; });

    performSelectAll();

    expect(seen).not.toBeNull();
    expect(seen!.key).toBe('a');
    expect(seen!.metaKey).toBe(true);
  });

  it('should_skip_fallback_when_editor_consumes_the_keydown', () => {
    const div = document.createElement('div');
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    div.addEventListener('keydown', (e) => e.preventDefault());
    const execCommand = vi.fn();
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    performSelectAll();

    expect(execCommand).not.toHaveBeenCalled();
  });

  it('should_select_input_value_when_nothing_consumes_the_keydown', () => {
    const input = document.createElement('input');
    input.value = 'hello select all';
    document.body.appendChild(input);
    input.focus();

    performSelectAll();

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('should_fall_back_to_execCommand_for_non_input_focus', () => {
    const execCommand = vi.fn();
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    performSelectAll();

    expect(execCommand).toHaveBeenCalledWith('selectAll');
  });
});
