import type { CloudInstance } from '@smt/shared';

/** What a provider adapter needs to authenticate. Stored vault-encrypted as JSON. */
export type CloudCredentials =
  | { kind: 'aws'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'token'; token: string }
  | { kind: 'gcp'; projectId: string; clientEmail: string; privateKey: string; tokenUri: string }
  | {
      kind: 'azure';
      tenantId: string;
      clientId: string;
      clientSecret: string;
      subscriptionId: string;
    };

/** A provider failure that already knows which HTTP status it maps to. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export interface ListOptions {
  /** AWS only; empty = discover every enabled region. */
  regions: string[];
  timeoutMs: number;
}

export interface CloudProviderAdapter {
  listInstances(creds: CloudCredentials, opts: ListOptions): Promise<CloudInstance[]>;
}

export function requireToken(creds: CloudCredentials): string {
  if (creds.kind !== 'token') throw new CloudError('This provider needs an API token', 400);
  return creds.token;
}

/** SSH goes to the public address when there is one, else the private one. */
export function pickHost(i: { publicIp: string | null; privateIp: string | null }): string | null {
  return i.publicIp ?? i.privateIp ?? null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Message for a 401/403; the provider's own text is appended when available. */
  unauthorized?: string;
}

/**
 * One JSON request with provider-agnostic error mapping. 401/403 become a 403
 * CloudError (bad credentials or missing permission); other failures are
 * 502/504 with the provider's own message so the user sees the real reason.
 */
export async function requestJson<T>(url: string, opts: RequestOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: { Accept: 'application/json', ...opts.headers },
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CloudError(`Provider request timed out after ${opts.timeoutMs} ms`, 504);
    }
    throw new CloudError(`Could not reach provider: ${message}`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    const detail = await providerMessage(res);
    const base = opts.unauthorized ?? 'The provider rejected the credentials';
    throw new CloudError(detail ? `${base}: ${detail}` : base, 403);
  }
  if (!res.ok) {
    const detail = await providerMessage(res);
    throw new CloudError(`Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }
  return (await res.json()) as T;
}

/** Bearer-token GET. */
export function httpJson<T>(
  url: string,
  token: string,
  timeoutMs: number,
  unauthorized?: string,
): Promise<T> {
  return requestJson<T>(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs,
    unauthorized,
  });
}

/** Bearer-token JSON POST. */
export function postJson<T>(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number,
  unauthorized?: string,
): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
    unauthorized,
  });
}

/** Form-encoded POST, as OAuth token endpoints want. */
export function postForm<T>(
  url: string,
  form: Record<string, string>,
  timeoutMs: number,
  unauthorized?: string,
): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    timeoutMs,
    unauthorized,
  });
}

async function providerMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: string | { message?: string };
      error_description?: string;
    };
    if (typeof body.error === 'object' && body.error?.message) return body.error.message;
    return body.message ?? body.error_description ?? (typeof body.error === 'string' ? body.error : '');
  } catch {
    return '';
  }
}

/**
 * Short-lived bearer tokens (GCP, Azure) cached per identity and refreshed a
 * few minutes before they expire, so a sync never sends an expired one.
 */
export class TokenCache {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly earlyMs = 5 * 60_000) {}

  async get(key: string, mint: () => Promise<{ token: string; expiresInSec: number }>): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.earlyMs > Date.now()) return cached.token;
    const fresh = await mint();
    this.tokens.set(key, { token: fresh.token, expiresAt: Date.now() + fresh.expiresInSec * 1000 });
    return fresh.token;
  }

  clear(): void {
    this.tokens.clear();
  }
}
