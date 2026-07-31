const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? body.error ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Stream a raw file body to the server (used for SFTP uploads). */
async function upload(path: string, file: Blob): Promise<{ path: string; size: number }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? body.error ?? res.statusText);
  }
  return res.json();
}

/** Fetch a binary response and trigger a browser download. */
async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? body.error ?? res.statusText);
  }
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
  upload,
  download,
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', ...(body != null && { body: JSON.stringify(body) }) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', ...(body != null && { body: JSON.stringify(body) }) }),
  delete: <T = void>(path: string) => request<T>(path, { method: 'DELETE' }),
};
