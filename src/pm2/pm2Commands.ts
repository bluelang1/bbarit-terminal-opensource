import { invoke } from '@tauri-apps/api/core';

interface HttpResponseOutput {
  status: number;
  body: string;
}

/**
 * Run `pm2 jlist` on remote SSH server via existing `run_ssh_command` pattern.
 * Uses the generic `http_request` for local, or creates a shell + reads output for SSH.
 * Since we use the existing PTY/SSH infrastructure, we use `run_cli_oneshot`.
 */
export async function pm2List(workDir: string): Promise<string> {
  const result = await invoke<string>('pm2_list', { workDir });
  return result;
}

export async function pm2Action(workDir: string, action: string, appName: string): Promise<string> {
  const result = await invoke<string>('pm2_action', { workDir, action, appName });
  return result;
}

/** Fetch Slack channel history */
export async function fetchSlackMessages(token: string, channel: string, limit = 20): Promise<any[]> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'GET',
        url: `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    });
    if (!resp || resp.status >= 400) return [];
    const data = JSON.parse(resp.body);
    return data.ok ? (data.messages || []) : [];
  } catch {
    return [];
  }
}

/** Send Slack message */
export async function sendSlackMessage(token: string, channel: string, text: string): Promise<boolean> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'POST',
        url: 'https://slack.com/api/chat.postMessage',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text }),
      },
    });
    if (!resp) return false;
    const data = JSON.parse(resp.body);
    return data.ok === true;
  } catch {
    return false;
  }
}

/** Fetch GitHub issues */
export async function fetchGithubIssues(token: string, repo: string, limit = 20): Promise<any[]> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'GET',
        url: `https://api.github.com/repos/${repo}/issues?state=open&sort=updated&per_page=${limit}`,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'OctoTerminal',
        },
      },
    });
    if (!resp || resp.status >= 400) return [];
    return JSON.parse(resp.body);
  } catch {
    return [];
  }
}

/** Fetch GitHub Actions workflow runs */
export async function fetchGithubWorkflowRuns(token: string, repo: string, limit = 5): Promise<any[]> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'GET',
        url: `https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'OctoTerminal',
        },
      },
    });
    if (!resp || resp.status >= 400) return [];
    const data = JSON.parse(resp.body);
    return data.workflow_runs || [];
  } catch {
    return [];
  }
}

/** Post GitHub comment */
export async function postGithubComment(token: string, repo: string, issueNumber: number, body: string): Promise<boolean> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'POST',
        url: `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'OctoTerminal',
        },
        body: JSON.stringify({ body }),
      },
    });
    return !!resp && resp.status < 400;
  } catch {
    return false;
  }
}

/** Fetch Linear issues using GraphQL */
export async function fetchLinearIssues(token: string, limit = 20): Promise<any[]> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query { issues(first: ${limit}, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { id identifier title description state { name color } updatedAt url team { name } } } }`,
        }),
      },
    });
    if (!resp || resp.status >= 400) return [];
    const data = JSON.parse(resp.body);
    return data?.data?.issues?.nodes || [];
  } catch {
    return [];
  }
}

/** Fetch GitHub issue comments */
export async function fetchGithubIssueComments(token: string, repo: string, issueNumber: number, limit = 10): Promise<any[]> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'GET',
        url: `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=${limit}`,
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'OctoTerminal',
        },
      },
    });
    if (!resp || resp.status >= 400) return [];
    return JSON.parse(resp.body);
  } catch {
    return [];
  }
}

/** Post Linear comment */
export async function postLinearComment(token: string, issueId: string, body: string): Promise<boolean> {
  try {
    const resp = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'POST',
        url: 'https://api.linear.app/graphql',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation { commentCreate(input: { issueId: "${issueId}", body: "${body.replace(/"/g, '\\"')}" }) { success } }`,
        }),
      },
    });
    if (!resp) return false;
    const data = JSON.parse(resp.body);
    return data?.data?.commentCreate?.success === true;
  } catch {
    return false;
  }
}
