import { useAuthStore } from '@/store/auth.js';

const BASE = '/api';

/** These answer 401 for bad credentials, which is not a lapsed session. */
const CREDENTIAL_PATHS = ['/auth/login', '/auth/register', '/auth/passkey/'];

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason, when the server gives one (e.g. PASSKEY_REQUIRED). */
  readonly code?: string;
  /** The parsed JSON error body, for codes that carry more (e.g. HOST_KEY_MISMATCH). */
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Convert a failed response into an ApiError. A 401 from anything but the sign-in
 * form means the server-side session is gone, so drop the persisted user —
 * `RequireAuth` then renders the app back at the login screen. A 403
 * PASSKEY_REQUIRED means the org wants a passkey sign-in this session has not
 * done; `RequireAuth` then sends the user to set one up or verify. A 403
 * RECOVERY_ONLY means a backup-code sign-in must add a passkey and verify with
 * it first; `RequireAuth` then holds the user at Settings → Passkeys.
 */
async function fail(res: Response, path: string): Promise<never> {
  if (res.status === 401 && !CREDENTIAL_PATHS.some((p) => path.startsWith(p))) {
    useAuthStore.getState().expireSession();
  }
  const text = await res.text().catch(() => '');
  let message = text || res.statusText;
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const body = JSON.parse(text) as { message?: string; error?: string; code?: string };
    message = body.message ?? body.error ?? message;
    code = body.code;
    details = body as Record<string, unknown>;
  } catch {
    // Not JSON — the raw body is the best message we have.
  }
  if (res.status === 403 && code === 'PASSKEY_REQUIRED') {
    useAuthStore.getState().setPasskeyGate(true);
  }
  if (res.status === 403 && code === 'RECOVERY_ONLY') {
    useAuthStore.getState().setRecoveryGate(true);
  }
  throw new ApiError(message, res.status, code, details);
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

/** Stream a raw file body to the server (SFTP and object-storage uploads). */
async function upload<T = { path: string; size: number }>(path: string, file: Blob): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'include',
  });
  if (!res.ok) await fail(res, path);
  return res.json() as Promise<T>;
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
  /** Absolute URL for a path, for links the browser should open itself. */
  url: (path: string) => `${BASE}${path}`,
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  stream,
  upload,
  download,
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', ...(body != null && { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', ...(body != null && { body: JSON.stringify(body) }) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', ...(body != null && { body: JSON.stringify(body) }) }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
};
