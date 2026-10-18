import { invoke } from '@tauri-apps/api/core';
import { kvGet, kvSet, kvDelete } from '../hooks/useKV';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const LINEAR_OAUTH_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';

export const LINEAR_STORAGE_KEYS = {
  apiToken: 'octo-linear-api-token',
  teamId: 'octo-linear-team-id',
  projectId: 'octo-linear-project-id',
  oauthClientId: 'octo-linear-oauth-client-id',
  oauthClientSecret: 'octo-linear-oauth-client-secret',
  oauthRedirectUri: 'octo-linear-oauth-redirect-uri',
} as const;

export interface LinearSettings {
  apiToken: string;
  teamId: string;
  projectId: string;
}

export interface LinearOAuthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface HttpResponseOutput {
  status: number;
  body: string;
}

interface LinearErrorItem {
  message?: string;
}

interface LinearEnvelope<T> {
  data?: T;
  errors?: LinearErrorItem[];
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
}

export async function getLinearSettings(): Promise<LinearSettings> {
  try {
    return {
      apiToken: String((await kvGet(LINEAR_STORAGE_KEYS.apiToken)) || '').trim(),
      teamId: String((await kvGet(LINEAR_STORAGE_KEYS.teamId)) || '').trim(),
      projectId: String((await kvGet(LINEAR_STORAGE_KEYS.projectId)) || '').trim(),
    };
  } catch {
    return { apiToken: '', teamId: '', projectId: '' };
  }
}

export async function getLinearOAuthSettings(): Promise<LinearOAuthSettings> {
  try {
    return {
      clientId: String((await kvGet(LINEAR_STORAGE_KEYS.oauthClientId)) || '').trim(),
      clientSecret: String((await kvGet(LINEAR_STORAGE_KEYS.oauthClientSecret)) || '').trim(),
      redirectUri: String((await kvGet(LINEAR_STORAGE_KEYS.oauthRedirectUri)) || '').trim(),
    };
  } catch {
    return { clientId: '', clientSecret: '', redirectUri: '' };
  }
}

export async function saveLinearOAuthSettings(next: Partial<LinearOAuthSettings>): Promise<LinearOAuthSettings> {
  const prev = await getLinearOAuthSettings();
  const merged: LinearOAuthSettings = {
    clientId: typeof next.clientId === 'string' ? next.clientId.trim() : prev.clientId,
    clientSecret: typeof next.clientSecret === 'string' ? next.clientSecret.trim() : prev.clientSecret,
    redirectUri: typeof next.redirectUri === 'string' ? next.redirectUri.trim() : prev.redirectUri,
  };
  try {
    void kvSet(LINEAR_STORAGE_KEYS.oauthClientId, merged.clientId);
    void kvSet(LINEAR_STORAGE_KEYS.oauthClientSecret, merged.clientSecret);
    void kvSet(LINEAR_STORAGE_KEYS.oauthRedirectUri, merged.redirectUri);
  } catch {
    // ignore storage errors
  }
  return merged;
}

export async function saveLinearSettings(next: Partial<LinearSettings>): Promise<LinearSettings> {
  const prev = await getLinearSettings();
  const merged: LinearSettings = {
    apiToken: typeof next.apiToken === 'string' ? next.apiToken.trim() : prev.apiToken,
    teamId: typeof next.teamId === 'string' ? next.teamId.trim() : prev.teamId,
    projectId: typeof next.projectId === 'string' ? next.projectId.trim() : prev.projectId,
  };
  try {
    void kvSet(LINEAR_STORAGE_KEYS.apiToken, merged.apiToken);
    void kvSet(LINEAR_STORAGE_KEYS.teamId, merged.teamId);
    void kvSet(LINEAR_STORAGE_KEYS.projectId, merged.projectId);
  } catch {
    // ignore storage errors
  }
  return merged;
}

export async function clearLinearToken(): Promise<LinearSettings> {
  const prev = await getLinearSettings();
  const next = { ...prev, apiToken: '' };
  try {
    void kvDelete(LINEAR_STORAGE_KEYS.apiToken);
  } catch {
    // ignore storage errors
  }
  return next;
}

export function buildLinearOAuthAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
}): string {
  const params = new URLSearchParams();
  params.set('response_type', 'code');
  params.set('client_id', String(input.clientId || '').trim());
  params.set('redirect_uri', String(input.redirectUri || '').trim());
  params.set('scope', String(input.scope || 'read,write').trim());
  if (String(input.state || '').trim()) params.set('state', String(input.state).trim());
  return `${LINEAR_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export async function getLinearSettingsForProject(project: { linearTeamId?: string; linearProjectId?: string }): Promise<LinearSettings> {
  const global = await getLinearSettings();
  return {
    apiToken: global.apiToken,
    teamId: (project.linearTeamId || '').trim() || global.teamId,
    projectId: (project.linearProjectId || '').trim() || global.projectId,
  };
}

export function isLinearConfigured(settings: LinearSettings): boolean {
  return settings.apiToken.length > 0 && settings.teamId.length > 0;
}

async function linearGraphql<T>(
  apiToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = String(apiToken || '').trim();
  if (!token) {
    throw new Error('Linear API token is missing.');
  }

  const response = await invoke<HttpResponseOutput>('http_request', {
    input: {
      method: 'POST',
      url: LINEAR_GRAPHQL_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    },
  });

  if (!response || response.status >= 400) {
    const bodyPreview = String(response?.body || '').slice(0, 240);
    throw new Error(`Linear request failed (${response?.status || 0}): ${bodyPreview}`);
  }

  let payload: LinearEnvelope<T>;
  try {
    payload = JSON.parse(response.body) as LinearEnvelope<T>;
  } catch {
    throw new Error('Linear response parsing failed.');
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((row) => String(row?.message || '').trim())
      .filter(Boolean)
      .join(' | ');
    throw new Error(message || 'Linear returned an error.');
  }

  if (!payload.data) {
    throw new Error('Linear response did not include data.');
  }
  return payload.data;
}

export async function exchangeLinearOAuthCode(input: {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
}): Promise<string> {
  const clientId = String(input.clientId || '').trim();
  const redirectUri = String(input.redirectUri || '').trim();
  const code = String(input.code || '').trim();
  if (!clientId || !redirectUri || !code) {
    throw new Error('Linear OAuth 교환에 필요한 값(clientId, redirectUri, code)이 비어 있습니다.');
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', clientId);
  body.set('redirect_uri', redirectUri);
  body.set('code', code);
  const secret = String(input.clientSecret || '').trim();
  if (secret) body.set('client_secret', secret);

  const response = await invoke<HttpResponseOutput>('http_request', {
    input: {
      method: 'POST',
      url: LINEAR_OAUTH_TOKEN_URL,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    },
  });

  if (!response || response.status >= 400) {
    const bodyPreview = String(response?.body || '').slice(0, 280);
    throw new Error(`Linear OAuth token 교환 실패 (${response?.status || 0}): ${bodyPreview}`);
  }

  let parsed: { access_token?: string; token_type?: string };
  try {
    parsed = JSON.parse(response.body) as { access_token?: string; token_type?: string };
  } catch {
    throw new Error('Linear OAuth token 응답 파싱 실패');
  }
  const accessToken = String(parsed.access_token || '').trim();
  if (!accessToken) {
    throw new Error('Linear OAuth token 응답에 access_token이 없습니다.');
  }
  return accessToken;
}

export async function fetchLinearTeams(apiToken: string): Promise<LinearTeam[]> {
  const query = `
    query Teams {
      teams(first: 50) {
        nodes {
          id
          key
          name
        }
      }
    }
  `;
  const data = await linearGraphql<{ teams?: { nodes?: LinearTeam[] } }>(apiToken, query);
  return Array.isArray(data.teams?.nodes) ? data.teams?.nodes : [];
}

export async function createLinearIssue(input: {
  apiToken: string;
  teamId: string;
  title: string;
  description: string;
  projectId?: string;
}): Promise<LinearIssueRef> {
  const mutation = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }
  `;

  const issueInput: Record<string, unknown> = {
    teamId: String(input.teamId || '').trim(),
    title: String(input.title || '').trim(),
    description: String(input.description || '').slice(0, 15000),
  };
  const projectId = String(input.projectId || '').trim();
  if (projectId) issueInput.projectId = projectId;

  const data = await linearGraphql<{ issueCreate?: { success?: boolean; issue?: LinearIssueRef | null } }>(
    input.apiToken,
    mutation,
    { input: issueInput },
  );
  const issue = data.issueCreate?.issue || null;
  if (!data.issueCreate?.success || !issue?.id) {
    throw new Error('Linear issueCreate failed.');
  }
  return issue;
}

export async function createLinearComment(input: {
  apiToken: string;
  issueId: string;
  body: string;
}): Promise<void> {
  const mutation = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;
  const data = await linearGraphql<{ commentCreate?: { success?: boolean } }>(
    input.apiToken,
    mutation,
    {
      input: {
        issueId: String(input.issueId || '').trim(),
        body: String(input.body || '').slice(0, 12000),
      },
    },
  );
  if (!data.commentCreate?.success) {
    throw new Error('Linear commentCreate failed.');
  }
}
