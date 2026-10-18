import { describe, expect, it } from 'vitest';
import { normalizeCliFlagLines, shellQuoteArg } from './cliCommandArgs';

describe('cli command argument helpers', () => {
  it('quotes shell arguments with spaces and apostrophes', () => {
    expect(shellQuoteArg('gpt-5.5 high')).toBe("'gpt-5.5 high'");
    expect(shellQuoteArg("Bob's model")).toBe("'Bob'\\''s model'");
    expect(shellQuoteArg("Bob's model", 'powershell')).toBe("'Bob''s model'");
    expect(shellQuoteArg('gpt-5.5 high', 'cmd')).toBe('"gpt-5.5 high"');
  });

  it('normalizes already quoted values before applying the target shell quoting', () => {
    expect(shellQuoteArg("'gpt-5.5 high'", 'powershell')).toBe("'gpt-5.5 high'");
    expect(shellQuoteArg('"gpt-5.5 high"', 'cmd')).toBe('"gpt-5.5 high"');
    expect(shellQuoteArg("'Bob''s high'", 'powershell')).toBe("'Bob''s high'");
  });

  it('keeps split legacy flag values instead of dropping them', () => {
    expect(normalizeCliFlagLines(['--mcp-config', 'C:\\My Repo\\mcp.json'])).toEqual([
      "--mcp-config 'C:\\My Repo\\mcp.json'",
    ]);
  });

  it('quotes one-line flag values and deduplicates exact duplicates', () => {
    expect(normalizeCliFlagLines(['--model gpt-5.5 high', '--model gpt-5.5 high', 'ignored'])).toEqual([
      "--model 'gpt-5.5 high'",
    ]);
  });

  it('quotes equals-style flag values', () => {
    expect(normalizeCliFlagLines(['--profile=work high'])).toEqual([
      "--profile='work high'",
    ]);
  });

  it('does not double-quote user-provided quoted flag values', () => {
    expect(normalizeCliFlagLines(["--model 'gpt-5.5 high'"], 'powershell')).toEqual([
      "--model 'gpt-5.5 high'",
    ]);
    expect(normalizeCliFlagLines(['--profile="work high"'], 'cmd')).toEqual([
      '--profile="work high"',
    ]);
  });

  it('uses PowerShell-safe quoting when requested', () => {
    expect(normalizeCliFlagLines(['--model', "Bob's high"], 'powershell')).toEqual([
      "--model 'Bob''s high'",
    ]);
  });
});
