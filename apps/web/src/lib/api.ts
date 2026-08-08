import { useAuthStore } from '@/store/auth.js';

const BASE = '/api';

/** These answer 401 for bad credentials, which is not a lapsed session. */
const CREDENTIAL_PATHS = ['/auth/login', '/auth/register'];

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Convert a failed response into an ApiError. A 401 from anything but the sign-in
 * form means the server-side session is gone, so drop the persisted user —
 * `RequireAuth` then renders the app back at the login screen.
 */
async function fail(res: Response, path: string): Promise<never> {
  if (res.status === 401 && !CREDENTIAL_PATHS.some((p) => path.startsWith(p))) {
    useAuthStore.getState().expireSession();
  }
  const text = await res.text().catch(() => '');
  let message = text || res.statusText;
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    message = body.message ?? body.error ?? message;
  } catch {
    // Not JSON — the raw body is the best message we have.
  }
  throw new ApiError(message, res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) await fail(res, path);

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * POST that hands back the raw Response so the caller can read a stream (SSE),
 * with the same session-expiry handling as the JSON helpers.
 */
async function stream(path: string, body: unknown, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, path);
  return res;
}

/** Stream a raw file body to the server (used for SFTP uploads). */
async function upload(path: string, file: Blob): Promise<{ path: string; size: number }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'include',
  });
  if (!res.ok) await fail(res, path);
  return res.json();
}

/** Fetch a binary response and trigger a browser download. */
async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) await fail(res, path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  stream,
  upload,
  download,
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', ...(body != null && { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', ...(body != null && { body: JSON.stringify(body) }) }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
};
