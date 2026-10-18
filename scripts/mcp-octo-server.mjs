#!/usr/bin/env node
/**
 * mcp-octo-server.mjs
 *
 * MCP (Model Context Protocol) stdio server for Octo Terminal.
 * Exposes ALL Octo Terminal features as MCP tools, callable by AI agents
 * (Claude Code, Codex CLI, Kimi CLI, etc.)
 *
 * Architecture:
 *   AI Agent → MCP stdio → this server → HTTP POST localhost:19980/api/invoke → Tauri backend
 *
 * Usage:
 *   node scripts/mcp-octo-server.mjs
 *
 * Register in Claude Code (.mcp.json):
 *   { "mcpServers": { "octo-terminal": { "command": "node", "args": ["scripts/mcp-octo-server.mjs"] } } }
 */

import { createInterface } from 'readline';

const BRIDGE_URL = process.env.OCTO_BRIDGE_URL || 'http://127.0.0.1:19980';

// ── MCP Protocol helpers ──

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

// ── HTTP invoke helper ──

async function invokeOcto(command, args = {}) {
  const resp = await fetch(`${BRIDGE_URL}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  const json = await resp.json();
  if (!json.success) throw new Error(json.error || 'Unknown error');
  return json.data;
}

// ── Tool Definitions ──

const TOOLS = [
  // ─── File Operations ───
  {
    name: 'octo_read_directory',
    description: 'List files and directories in a path. Returns name, type (file/dir), size, modified timestamp.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path to list' } },
      required: ['path'],
    },
  },
  {
    name: 'octo_read_file',
    description: 'Read a file as text.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path to read' } },
      required: ['path'],
    },
  },
  {
    name: 'octo_write_file',
    description: 'Write text content to a file. Creates or overwrites.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Text content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'octo_create_directory',
    description: 'Create a directory (with parents).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: ['path'],
    },
  },
  {
    name: 'octo_delete_path',
    description: 'Delete a file or directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to delete' } },
      required: ['path'],
    },
  },
  {
    name: 'octo_rename_path',
    description: 'Rename or move a file/directory.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to: { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'octo_copy_path',
    description: 'Copy a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to: { type: 'string', description: 'Destination path' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'octo_search_files',
    description: 'Search files by name or content within a directory tree.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Root directory to search' },
        query: { type: 'string', description: 'Search query' },
        search_content: { type: 'boolean', description: 'Search inside file content (default: false)' },
        limit: { type: 'number', description: 'Max results (default: 100)' },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'octo_read_file_base64',
    description: 'Read a binary file as base64 string.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path' } },
      required: ['path'],
    },
  },

  // ─── Terminal / PTY ───
  {
    name: 'octo_create_shell',
    description: 'Create a new PTY terminal session. Returns nothing on success.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'Unique terminal ID' },
        work_dir: { type: 'string', description: 'Working directory' },
        rows: { type: 'number', description: 'Terminal rows (default: 24)' },
        cols: { type: 'number', description: 'Terminal columns (default: 80)' },
        shell_type: { type: 'string', description: 'Shell type: bash, zsh, fish, cmd, powershell' },
      },
      required: ['terminal_id', 'work_dir'],
    },
  },
  {
    name: 'octo_write_to_pty',
    description: 'Write text/commands to a PTY terminal. Use \\n for Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'Terminal ID' },
        data: { type: 'string', description: 'Text to write (\\n for Enter, \\x03 for Ctrl+C)' },
      },
      required: ['terminal_id', 'data'],
    },
  },
  {
    name: 'octo_read_from_pty',
    description: 'Read pending output from a PTY terminal.',
    inputSchema: {
      type: 'object',
      properties: { terminal_id: { type: 'string', description: 'Terminal ID' } },
      required: ['terminal_id'],
    },
  },
  {
    name: 'octo_resize_pty',
    description: 'Resize a PTY terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'Terminal ID' },
        rows: { type: 'number', description: 'New rows' },
        cols: { type: 'number', description: 'New columns' },
      },
      required: ['terminal_id', 'rows', 'cols'],
    },
  },
  {
    name: 'octo_close_pty',
    description: 'Close a PTY terminal session.',
    inputSchema: {
      type: 'object',
      properties: { terminal_id: { type: 'string', description: 'Terminal ID' } },
      required: ['terminal_id'],
    },
  },
  {
    name: 'octo_check_pty_alive',
    description: 'Check if a PTY terminal is still alive.',
    inputSchema: {
      type: 'object',
      properties: { terminal_id: { type: 'string', description: 'Terminal ID' } },
      required: ['terminal_id'],
    },
  },
  {
    name: 'octo_read_pty_output_buffer',
    description: 'Read the full accumulated output buffer of a PTY terminal.',
    inputSchema: {
      type: 'object',
      properties: { terminal_id: { type: 'string', description: 'Terminal ID' } },
      required: ['terminal_id'],
    },
  },
  {
    name: 'octo_run_command',
    description: 'Run a shell command and return its output (one-shot, blocking).',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        work_dir: { type: 'string', description: 'Working directory (optional)' },
        timeout_secs: { type: 'number', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['command'],
    },
  },

  // ─── KV Store ───
  {
    name: 'octo_kv_get',
    description: 'Get a value from the KV store.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name' } },
      required: ['key'],
    },
  },
  {
    name: 'octo_kv_set',
    description: 'Set a value in the KV store.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name' },
        value: { type: 'string', description: 'Value to store' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'octo_kv_delete',
    description: 'Delete a key from the KV store.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name' } },
      required: ['key'],
    },
  },

  // ─── Git ───
  {
    name: 'octo_git_status',
    description: 'Get git status: is_repo, current_branch, has_uncommitted.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Repository directory' } },
      required: ['dir'],
    },
  },
  {
    name: 'octo_git_init',
    description: 'Initialize a new git repository.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Directory to init' } },
      required: ['dir'],
    },
  },
  {
    name: 'octo_git_stash',
    description: 'Git stash save or pop.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_dir: { type: 'string', description: 'Repository directory' },
        action: { type: 'string', enum: ['save', 'pop'], description: 'Stash action' },
        message: { type: 'string', description: 'Stash message (for save)' },
      },
      required: ['repo_dir', 'action'],
    },
  },
  {
    name: 'octo_git_branch',
    description: 'Git branch operations: merge, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_dir: { type: 'string', description: 'Repository directory' },
        action: { type: 'string', enum: ['merge', 'delete'], description: 'Branch action' },
        branch_name: { type: 'string', description: 'Branch name' },
      },
      required: ['repo_dir', 'action', 'branch_name'],
    },
  },
  {
    name: 'octo_git_worktree',
    description: 'Add a git worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_dir: { type: 'string', description: 'Repository directory' },
        worktree_dir: { type: 'string', description: 'Worktree directory' },
        branch_name: { type: 'string', description: 'Branch name' },
      },
      required: ['repo_dir', 'worktree_dir', 'branch_name'],
    },
  },

  // ─── Config ───
  {
    name: 'octo_read_config',
    description: 'Read the Octo Terminal configuration.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octo_write_config',
    description: 'Write Octo Terminal configuration.',
    inputSchema: {
      type: 'object',
      properties: { json: { type: 'string', description: 'JSON config string' } },
      required: ['json'],
    },
  },

  // ─── HTTP Proxy ───
  {
    name: 'octo_http_request',
    description: 'Make an HTTP request via Octo Terminal proxy (bypasses CORS).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Request URL' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'string', description: 'Request body' },
      },
      required: ['url'],
    },
  },

  // ─── Messaging ───
  {
    name: 'octo_telegram_send',
    description: 'Send a Telegram message via configured bot.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message text' } },
      required: ['text'],
    },
  },
  {
    name: 'octo_telegram_updates',
    description: 'Get Telegram bot updates.',
    inputSchema: {
      type: 'object',
      properties: { offset: { type: 'number', description: 'Update offset' } },
    },
  },
  {
    name: 'octo_discord_send',
    description: 'Send a Discord message.',
    inputSchema: {
      type: 'object',
      properties: {
        bot_token: { type: 'string', description: 'Bot token' },
        channel_id: { type: 'string', description: 'Channel ID' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['bot_token', 'channel_id', 'text'],
    },
  },
  {
    name: 'octo_slack_send',
    description: 'Send a Slack message.',
    inputSchema: {
      type: 'object',
      properties: {
        bot_token: { type: 'string', description: 'Bot token' },
        channel: { type: 'string', description: 'Channel' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['bot_token', 'channel', 'text'],
    },
  },

  // ─── Process / PM2 ───
  {
    name: 'octo_process_stats',
    description: 'Get system process stats (CPU, memory).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octo_pm2_list',
    description: 'List PM2 processes.',
    inputSchema: {
      type: 'object',
      properties: { work_dir: { type: 'string', description: 'Working directory' } },
      required: ['work_dir'],
    },
  },
  {
    name: 'octo_pm2_action',
    description: 'PM2 process action (start/stop/restart/delete).',
    inputSchema: {
      type: 'object',
      properties: {
        work_dir: { type: 'string', description: 'Working directory' },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'delete'], description: 'Action' },
        app_name: { type: 'string', description: 'App name' },
      },
      required: ['work_dir', 'action', 'app_name'],
    },
  },

  // ─── Paths ───
  {
    name: 'octo_get_paths',
    description: 'Get important Octo Terminal paths (home, config, documents).',
    inputSchema: { type: 'object', properties: {} },
  },

  // ─── SSH ───
  {
    name: 'octo_read_ssh_config',
    description: 'Read SSH config (~/.ssh/config).',
    inputSchema: { type: 'object', properties: {} },
  },

  // ─── Health ───
  {
    name: 'octo_health',
    description: 'Check if Octo Terminal is running and accessible.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool name → invoke command mapping ──

const TOOL_MAP = {
  octo_read_directory: (a) => invokeOcto('read_directory', a),
  octo_read_file: (a) => invokeOcto('read_file', a),
  octo_write_file: (a) => invokeOcto('write_file', a),
  octo_create_directory: (a) => invokeOcto('create_directory', a),
  octo_delete_path: (a) => invokeOcto('delete_path', a),
  octo_rename_path: (a) => invokeOcto('rename_path', a),
  octo_copy_path: (a) => invokeOcto('copy_path', a),
  octo_search_files: (a) => invokeOcto('search_files', a),
  octo_read_file_base64: (a) => invokeOcto('read_file_base64', a),
  octo_create_shell: (a) => invokeOcto('create_shell', a),
  octo_write_to_pty: (a) => invokeOcto('write_to_pty', a),
  octo_read_from_pty: (a) => invokeOcto('read_from_pty', a),
  octo_resize_pty: (a) => invokeOcto('resize_pty', a),
  octo_close_pty: (a) => invokeOcto('close_pty', a),
  octo_check_pty_alive: (a) => invokeOcto('check_pty_alive', a),
  octo_read_pty_output_buffer: (a) => invokeOcto('read_pty_output_buffer', a),
  octo_run_command: (a) => invokeOcto('run_cli_oneshot', a),
  octo_kv_get: (a) => invokeOcto('kv_get', a),
  octo_kv_set: (a) => invokeOcto('kv_set', a),
  octo_kv_delete: (a) => invokeOcto('kv_delete', a),
  octo_read_config: () => invokeOcto('read_config'),
  octo_write_config: (a) => invokeOcto('write_config', a),
  octo_http_request: (a) => invokeOcto('http_request', a),
  octo_telegram_send: (a) => invokeOcto('telegram_send_message', { text: a.text }),
  octo_telegram_updates: (a) => invokeOcto('telegram_get_updates', a),
  octo_discord_send: (a) => invokeOcto('discord_send_message', a),
  octo_slack_send: (a) => invokeOcto('slack_send_message', a),
  octo_process_stats: () => invokeOcto('get_process_stats'),
  octo_pm2_list: (a) => invokeOcto('pm2_list', a),
  octo_pm2_action: (a) => invokeOcto('pm2_action', a),
  octo_read_ssh_config: () => invokeOcto('read_ssh_config'),
  octo_git_status: async (a) => {
    const is_repo = await invokeOcto('git_is_repo', { dir: a.dir });
    if (!is_repo?.is_repo) return { is_repo: false };
    const branch = await invokeOcto('git_current_branch', { repo_dir: a.dir }).catch(() => null);
    const uncommitted = await invokeOcto('git_has_uncommitted', { repo_dir: a.dir }).catch(() => null);
    return { is_repo: true, branch, ...uncommitted };
  },
  octo_git_init: (a) => invokeOcto('git_init_repo', a),
  octo_git_stash: (a) =>
    a.action === 'save'
      ? invokeOcto('git_stash_save', { repo_dir: a.repo_dir, message: a.message || 'auto stash' })
      : invokeOcto('git_stash_pop', { repo_dir: a.repo_dir }),
  octo_git_branch: (a) =>
    a.action === 'merge'
      ? invokeOcto('git_merge_branch', { repo_dir: a.repo_dir, branch_name: a.branch_name })
      : invokeOcto('git_delete_branch', { repo_dir: a.repo_dir, branch_name: a.branch_name }),
  octo_git_worktree: (a) => invokeOcto('git_worktree_add', a),
  octo_get_paths: async () => {
    const [home, config, docs] = await Promise.all([
      invokeOcto('get_home_dir').catch(() => '?'),
      invokeOcto('get_config_path').catch(() => '?'),
      invokeOcto('get_documents_dir').catch(() => '?'),
    ]);
    return { home, config, documents: docs };
  },
  octo_health: async () => {
    try {
      const resp = await fetch(`${BRIDGE_URL}/health`);
      return { status: resp.ok ? 'ok' : 'error', code: resp.status };
    } catch (e) {
      return { status: 'unreachable', error: e.message };
    }
  },
};

// ── MCP message handler ──

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'octo-terminal', version: '0.1.0' },
      });

    case 'notifications/initialized':
      return; // no response needed

    case 'tools/list':
      return sendResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: toolArgs } = params;
      const handler = TOOL_MAP[name];
      if (!handler) {
        return sendResponse(id, {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        });
      }
      try {
        const result = await handler(toolArgs || {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return sendResponse(id, {
          content: [{ type: 'text', text }],
        });
      } catch (e) {
        return sendResponse(id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return sendResponse(id, {});

    default:
      if (id != null) {
        return sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ── Stdio transport ──

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const len = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) break;

    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);

    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch((e) => {
        process.stderr.write(`[mcp-octo] Error: ${e.message}\n`);
        if (msg.id != null) sendError(msg.id, -32603, e.message);
      });
    } catch (e) {
      process.stderr.write(`[mcp-octo] Parse error: ${e.message}\n`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.stderr.write('[mcp-octo] Octo Terminal MCP server started\n');
