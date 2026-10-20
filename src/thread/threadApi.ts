import { invoke } from '@tauri-apps/api/core';
import { loadIdentity } from '../collab/loungeIdentity';
import { BBARIT_API_BASE_URL } from '../config/endpoints';

const API_BASE = BBARIT_API_BASE_URL;
const TOKEN_KEY = 'bbarit-thread-token-v1';
const DEVICE_HASH_KEY = 'bbarit-thread-device-hash-v1';

export type ThreadUser = { id: number; name: string; github_login: string; avatar_url: string | null };
export type ThreadImage = { id: string; url: string; mimeType: string; sizeBytes: number };
export type ThreadProfile = {
  author: { id: number; name: string; handle: string; avatarUrl: string | null };
  postCount: number;
  replyCount: number;
  joinedAt: string;
};
export type ThreadPost = {
  id: number;
  parentId: number | null;
  rootId: number | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
  replyCount: number;
  likeCount: number;
  likedByViewer: boolean;
  author: { id: number; name: string; handle: string; avatarUrl: string | null };
  images: ThreadImage[];
};

type ApiResult<T> = { ok: boolean; data?: T; error?: string; nextCursor?: number | null };

export class ThreadApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function authSnapshot() {
  return {
    token: localStorage.getItem(TOKEN_KEY) || '',
    deviceHash: localStorage.getItem(DEVICE_HASH_KEY) || '',
  };
}

async function request<T>(path: string, init: RequestInit = {}, authenticated: boolean | 'optional' = false): Promise<ApiResult<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (authenticated) {
    const { token, deviceHash } = authSnapshot();
    if (token && deviceHash) {
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('x-device-hash', deviceHash);
    } else if (authenticated === true) {
      throw new ThreadApiError('Sign in required.', 401);
    }
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => ({ ok: false, error: 'Could not read the server response.' })) as ApiResult<T>;
  if (!response.ok || !payload.ok) {
    if (response.status === 401 && authenticated) localStorage.removeItem(TOKEN_KEY);
    throw new ThreadApiError(payload.error || `Request failed (${response.status})`, response.status);
  }
  return payload;
}

async function deviceHash(): Promise<string> {
  const saved = localStorage.getItem(DEVICE_HASH_KEY);
  if (saved) return saved;
  const identity = await loadIdentity();
  const bytes = new TextEncoder().encode(identity.deviceId);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(DEVICE_HASH_KEY, hash);
  return hash;
}

async function openExternal(url: string) {
  try { await invoke('plugin:shell|open', { path: url }); return; } catch (error) {
    console.warn('[BBARIT Thread] system browser open failed', error);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 2_000);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function beginThreadLogin(signal: AbortSignal, onPending?: () => void): Promise<ThreadUser> {
  const hash = await deviceHash();
  const start = await request<{ nonce: string; browser_url: string; expires_in_seconds: number }>(
    `/api/auth/desktop/start?${new URLSearchParams({
      product_code: 'terminal',
      app_name: 'BBARIT Thread',
      device_hash: hash,
      device_label: navigator.platform || 'BBARIT Terminal',
    })}`,
  );
  if (!start.data) throw new ThreadApiError('Could not start sign-in.', 500);
  await openExternal(start.data.browser_url);
  onPending?.();

  const deadline = Date.now() + start.data.expires_in_seconds * 1_000;
  while (!signal.aborted && Date.now() < deadline) {
    await waitForPoll(signal);
    const poll = await request<{
      status: 'pending' | 'completed' | 'failed' | 'expired';
      token?: string;
    }>(`/api/auth/desktop/poll?nonce=${encodeURIComponent(start.data.nonce)}`);
    if (poll.data?.status === 'pending') continue;
    if (poll.data?.status !== 'completed' || !poll.data.token) {
      throw new ThreadApiError('Sign-in was not completed. Please try again.', 401);
    }
    localStorage.setItem(TOKEN_KEY, poll.data.token);
    return getThreadUser();
  }
  throw new ThreadApiError('The sign-in request expired.', 408);
}

export async function getThreadUser(): Promise<ThreadUser> {
  const result = await request<ThreadUser>('/api/auth/me', {}, true);
  if (!result.data) throw new ThreadApiError('Could not load your profile.', 500);
  return result.data;
}

export function hasThreadSession(): boolean {
  return Boolean(authSnapshot().token && authSnapshot().deviceHash);
}

export function logoutThread() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function listThreadPosts(cursor?: number): Promise<{ posts: ThreadPost[]; nextCursor: number | null }> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', String(cursor));
  const result = await request<ThreadPost[]>(`/api/thread/posts?${params}`, {}, 'optional');
  return { posts: result.data || [], nextCursor: result.nextCursor || null };
}

export async function listThreadReplies(postId: number): Promise<ThreadPost[]> {
  const result = await request<ThreadPost[]>(`/api/thread/posts/${postId}/replies`, {}, 'optional');
  return result.data || [];
}

export async function getThreadProfile(handle: string): Promise<ThreadProfile> {
  const result = await request<ThreadProfile>(`/api/thread/profiles/${encodeURIComponent(handle)}`);
  if (!result.data) throw new ThreadApiError('Could not load the profile.', 500);
  return result.data;
}

export async function listThreadProfilePosts(handle: string, cursor?: number): Promise<{ posts: ThreadPost[]; nextCursor: number | null }> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', String(cursor));
  const result = await request<ThreadPost[]>(`/api/thread/profiles/${encodeURIComponent(handle)}/posts?${params}`, {}, 'optional');
  return { posts: result.data || [], nextCursor: result.nextCursor || null };
}

export async function uploadThreadImage(file: File): Promise<ThreadImage> {
  const form = new FormData();
  form.append('image', file, file.name);
  const result = await request<ThreadImage>('/api/thread/uploads', { method: 'POST', body: form }, true);
  if (!result.data) throw new ThreadApiError('Could not upload the image.', 500);
  return result.data;
}

export async function createThreadPost(input: { body: string; imageIds: string[]; parentId?: number }): Promise<ThreadPost> {
  const result = await request<ThreadPost>('/api/thread/posts', { method: 'POST', body: JSON.stringify(input) }, true);
  if (!result.data) throw new ThreadApiError('Could not create the post.', 500);
  return result.data;
}

export async function updateThreadPost(postId: number, input: { body: string; imageIds: string[] }): Promise<ThreadPost> {
  const result = await request<ThreadPost>(`/api/thread/posts/${postId}`, { method: 'PATCH', body: JSON.stringify(input) }, true);
  if (!result.data) throw new ThreadApiError('Could not update the post.', 500);
  return result.data;
}

export async function toggleThreadLike(postId: number): Promise<{ liked: boolean; likeCount: number }> {
  const result = await request<{ liked: boolean; likeCount: number }>(`/api/thread/posts/${postId}/like`, { method: 'POST' }, true);
  if (!result.data) throw new ThreadApiError('Could not update the like.', 500);
  return result.data;
}

export async function deleteThreadPost(postId: number): Promise<void> {
  await request(`/api/thread/posts/${postId}`, { method: 'DELETE' }, true);
}

export function threadAssetUrl(path: string): string {
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}
