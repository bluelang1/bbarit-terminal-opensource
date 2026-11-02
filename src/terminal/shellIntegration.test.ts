import { describe, expect, it } from 'vitest';
import { parseOsc133 } from './shellIntegration';

describe('parseOsc133', () => {
  it('should_parse_prompt_and_command_marks', () => {
    expect(parseOsc133('A')).toEqual({ mark: 'A' });
    expect(parseOsc133('B')).toEqual({ mark: 'B' });
    expect(parseOsc133('C')).toEqual({ mark: 'C' });
  });

  it('should_parse_exit_codes_on_D', () => {
    expect(parseOsc133('D;0')).toEqual({ mark: 'D', exitCode: 0 });
    expect(parseOsc133('D;130')).toEqual({ mark: 'D', exitCode: 130 });
    expect(parseOsc133('D;255')).toEqual({ mark: 'D', exitCode: 255 });
    expect(parseOsc133('D')).toEqual({ mark: 'D' });
  });

  it('should_reject_bad_exit_codes_and_empty_payloads', () => {
    expect(parseOsc133('D;abc')).toBeNull();
    expect(parseOsc133('D;256')).toBeNull();
    expect(parseOsc133('D;-1')).toBeNull();
    expect(parseOsc133('')).toBeNull();
    expect(parseOsc133('Z')).toBeNull();
    expect(parseOsc133('a')).toBeNull();
  });

  it('should_ignore_shell_integration_options', () => {
    expect(parseOsc133('A;cl=m;aid=123')).toEqual({ mark: 'A' });
    expect(parseOsc133('D;1;aid=123')).toEqual({ mark: 'D', exitCode: 1 });
  });
});
