import { describe, expect, it } from 'vitest';
import { decodeOsc52Payload } from './osc52';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('decodeOsc52Payload', () => {
  it('should_decode_selection_prefixed_payload', () => {
    expect(decodeOsc52Payload(`c;${b64('hello world')}`)).toBe('hello world');
  });

  it('should_decode_utf8_multibyte_text', () => {
    expect(decodeOsc52Payload(`c;${b64('복사 테스트 ✓')}`)).toBe('복사 테스트 ✓');
  });

  it('should_reject_clipboard_query', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull();
  });

  it('should_return_null_for_invalid_base64', () => {
    expect(decodeOsc52Payload('c;***not-base64***')).toBeNull();
  });

  it('should_return_null_for_empty_payload', () => {
    expect(decodeOsc52Payload('c;')).toBeNull();
    expect(decodeOsc52Payload('')).toBeNull();
  });
});
