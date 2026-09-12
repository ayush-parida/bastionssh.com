import type { CloudInstance } from '@smt/shared';

/** What a provider adapter needs to authenticate. Stored vault-encrypted as JSON. */
export type CloudCredentials =
  | { kind: 'aws'; accessKeyId: string; secretAccessKey: string }
  | { kind: 'token'; token: string };

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

/**
 * Bearer-token GET returning parsed JSON. 401/403 from the provider become a
 * 403 CloudError (bad credentials); other failures are 502/504 with the
 * provider's own message so the user sees the real reason.
 */
export async function httpJson<T>(url: string, token: string, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CloudError(`Provider request timed out after ${timeoutMs} ms`, 504);
    }
    throw new CloudError(`Could not reach provider: ${message}`, 502);
  }

  if (res.status === 401 || res.status === 403) {
    throw new CloudError('The provider rejected the credentials', 403);
  }
  if (!res.ok) {
    const detail = await providerMessage(res);
    throw new CloudError(`Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }
  return (await res.json()) as T;
}

async function providerMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: { message?: string } };
    return body.message ?? body.error?.message ?? '';
  } catch {
    return '';
  }
}
