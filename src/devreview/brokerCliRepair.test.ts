import { describe, expect, it } from 'vitest';
import { BROKER_AGENT_ROLES } from './devReviewPair';
import { buildBrokerCliRepairCommand, buildBrokerCliRepairPayload } from './brokerCliRepair';

describe('broker CLI repair', () => {
  it('can build repair commands for every selectable broker agent role', () => {
    expect(BROKER_AGENT_ROLES).not.toContain('ollama');
    for (const role of BROKER_AGENT_ROLES) {
      expect(buildBrokerCliRepairCommand(role, {}), role).toBeTruthy();
    }
  });

  it('builds Claude repair commands from broker agent settings', () => {
    expect(buildBrokerCliRepairCommand('claude', {
      claudeMode: 'bypass-permissions',
      claudeModel: 'opus',
      claudeFlags: ['--mcp-config', 'mcp.json', 'bad'],
    })).toBe("claude --dangerously-skip-permissions --model 'opus' --mcp-config 'mcp.json'");
  });

  it('keeps one-line flags with values and deduplicates exact duplicates', () => {
    expect(buildBrokerCliRepairCommand('claude', {
      claudeFlags: ['--mcp-config mcp.json', '--mcp-config mcp.json', 'ignored'],
    })).toBe("claude --mcp-config 'mcp.json'");
  });

  it('builds Codex repair commands from broker agent settings', () => {
    expect(buildBrokerCliRepairCommand('codex', {
      codexMode: 'yolo',
      codexModel: 'gpt-5.5 high',
      codexWebSearch: true,
      resumeLastSession: true,
    })).toBe("codex resume --last --dangerously-bypass-approvals-and-sandbox --search --model 'gpt-5.5 high'");
  });

  it('uses PowerShell-safe escaping by default for broker repair commands', () => {
    expect(buildBrokerCliRepairCommand('claude', {
      claudeModel: "Bob's high",
      claudeFlags: ['--mcp-config', "C:\\Bob's Repo\\mcp.json"],
    })).toBe("claude --model 'Bob''s high' --mcp-config 'C:\\Bob''s Repo\\mcp.json'");
  });

  it('can build POSIX-safe repair commands for non-Windows shells', () => {
    expect(buildBrokerCliRepairCommand('claude', {
      shellType: 'gitbash',
      claudeModel: "Bob's high",
    })).toBe("claude --model 'Bob'\\''s high'");
  });

  it('does not inject anything when the buffer already looks like an agent UI', () => {
    expect(buildBrokerCliRepairPayload('codex', 'OpenAI Codex (v0.141.0)\nmodel: gpt-5.5', {})).toBeNull();
  });

  it('injects the CLI command when a broker terminal is still a raw shell prompt', () => {
    expect(buildBrokerCliRepairPayload('claude', 'PS C:\\repo> ', { claudeMode: 'normal' })).toBe('claude\r');
  });

  it('cancels a PowerShell continuation prompt before injecting the CLI command', () => {
    expect(buildBrokerCliRepairPayload('codex', '>>', { codexMode: 'auto-edit' })).toBe('\x03codex --auto-edit\r');
  });
});
