// Fork identity: every server/repository the frontend talks to lives here so a
// fork can repoint the app through `VITE_*` env vars (see .env.example) without
// touching feature code. With no env set, the values below reproduce the
// upstream behavior except the release repositories, which default to this fork.
//
// `import.meta.env` is baked in at build time by Vite; the Tauri updater
// endpoint is configured in src-tauri (not here) and is intentionally left off.

export const DEFAULT_BBARIT_API_BASE_URL = 'https://bbarit.com';
export const DEFAULT_RELEASE_REPO_MAC = 'bluelang1/bbarit-terminal-opensource';
// This fork publishes macOS and Windows builds from the same repository.
export const DEFAULT_RELEASE_REPO_WIN = 'bluelang1/bbarit-terminal-opensource';

export interface EndpointEnv {
  readonly VITE_BBARIT_API_BASE_URL?: string;
  readonly VITE_BBARIT_NOTICES_URL?: string;
  readonly VITE_BBARIT_LOUNGE_WS_URL?: string;
  readonly VITE_BBARIT_AGENT_INSTALL_URL?: string;
  readonly VITE_BBARIT_RELEASE_REPO_MAC?: string;
  readonly VITE_BBARIT_RELEASE_REPO_WIN?: string;
}

export interface Endpoints {
  /** API origin, no trailing slash. */
  apiBaseUrl: string;
  /** Product notice feed; `null` means notices are disabled (no network call). */
  productNoticesUrl: string | null;
  /** Lounge websocket (wss:// for https base, ws:// for http base). */
  loungeWsUrl: string;
  /** `bbarit-oss` agent install script URL. */
  agentInstallUrl: string;
  /** POSIX one-liner shown when `bbarit-oss` is missing. */
  agentInstallCommand: string;
  /** GitHub `owner/repo` hosting macOS releases. */
  releaseRepoMac: string;
  /** GitHub `owner/repo` hosting Windows releases. */
  releaseRepoWin: string;
}

const NOTICES_OFF_VALUES = new Set(['off', 'false', '0', 'none', 'disabled']);

function pick(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function toWebSocketOrigin(httpOrigin: string): string {
  return stripTrailingSlash(httpOrigin).replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

export function resolveEndpoints(env: EndpointEnv = {}): Endpoints {
  const apiBaseUrl = stripTrailingSlash(pick(env.VITE_BBARIT_API_BASE_URL) ?? DEFAULT_BBARIT_API_BASE_URL);

  // Notices: unset → derived from the base URL; empty string or an "off" word →
  // disabled so the gate renders as if the feed returned nothing.
  let productNoticesUrl: string | null;
  const rawNotices = env.VITE_BBARIT_NOTICES_URL;
  if (rawNotices === undefined) {
    productNoticesUrl = `${apiBaseUrl}/api/products/notices`;
  } else {
    const trimmed = rawNotices.trim();
    productNoticesUrl = trimmed && !NOTICES_OFF_VALUES.has(trimmed.toLowerCase()) ? trimmed : null;
  }

  const loungeWsUrl = pick(env.VITE_BBARIT_LOUNGE_WS_URL) ?? `${toWebSocketOrigin(apiBaseUrl)}/api/lounge/ws`;
  const agentInstallUrl = pick(env.VITE_BBARIT_AGENT_INSTALL_URL) ?? `${apiBaseUrl}/agent/install.sh`;

  return {
    apiBaseUrl,
    productNoticesUrl,
    loungeWsUrl,
    agentInstallUrl,
    agentInstallCommand: `curl -fsSL ${agentInstallUrl} | sh`,
    releaseRepoMac: pick(env.VITE_BBARIT_RELEASE_REPO_MAC) ?? DEFAULT_RELEASE_REPO_MAC,
    releaseRepoWin: pick(env.VITE_BBARIT_RELEASE_REPO_WIN) ?? DEFAULT_RELEASE_REPO_WIN,
  };
}

const endpoints = resolveEndpoints(import.meta.env);

export const BBARIT_API_BASE_URL = endpoints.apiBaseUrl;
export const PRODUCT_NOTICES_URL = endpoints.productNoticesUrl;
export const PRODUCT_NOTICES_ENABLED = endpoints.productNoticesUrl !== null;
export const LOUNGE_WS_URL = endpoints.loungeWsUrl;
export const AGENT_INSTALL_URL = endpoints.agentInstallUrl;
export const AGENT_INSTALL_COMMAND = endpoints.agentInstallCommand;
export const RELEASE_REPO_MAC = endpoints.releaseRepoMac;
export const RELEASE_REPO_WIN = endpoints.releaseRepoWin;
/** Public read-only Thread feed on the website (same origin as the API). */
export const THREAD_WEB_URL = `${endpoints.apiBaseUrl}/thread`;
