/**
 * Every Kubernetes failure a route can surface, with the HTTP status to
 * answer with. Like docker/errors.ts: client errors keep their meaning, the
 * API server failing or being unreachable is a bad gateway, and the message
 * is always safe to show (it never carries a credential).
 */
export class KubeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    /** The API server's own `reason` (NotFound, Forbidden, Expired…), when it gave one. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'KubeError';
  }

  toJSON() {
    return { error: this.message, ...(this.reason && { code: `KUBE_${this.reason.toUpperCase()}` }) };
  }
}

/** The `Status` object the API server answers errors with. */
interface KubeStatus {
  kind?: unknown;
  message?: unknown;
  reason?: unknown;
  code?: unknown;
}

/** The API server's message and reason, or the raw text when the body is not a Status. */
export function statusMessage(body: string): { message: string; reason?: string } {
  try {
    const parsed = JSON.parse(body) as KubeStatus;
    if (typeof parsed.message === 'string' && parsed.message) {
      return { message: parsed.message, ...(typeof parsed.reason === 'string' && { reason: parsed.reason }) };
    }
  } catch {
    // not JSON
  }
  return { message: body.trim().slice(0, 500) };
}

/**
 * Map an API server error status onto ours. 401 means the credential itself
 * was refused (expired token, unknown certificate) — reported as a bad
 * gateway with a clear message, since our own session is fine; 403 is RBAC
 * saying no to the credential; 410 is an expired watch resource version (the
 * cache relists, it never reaches a browser).
 */
export function fromApiStatus(status: number, body: string): KubeError {
  const { message, reason } = statusMessage(body);
  const text = message || `The Kubernetes API answered ${status}`;
  switch (status) {
    case 400:
    case 404:
    case 409:
    case 410:
    case 422:
      return new KubeError(text, status, reason);
    case 401:
      return new KubeError(`The cluster refused the stored credential: ${text}`, 502, reason ?? 'Unauthorized');
    case 403:
      return new KubeError(`The cluster credential is not allowed to do this: ${text}`, 403, reason ?? 'Forbidden');
    case 429:
      return new KubeError(`The Kubernetes API is busy: ${text}`, 503, reason);
    default:
      return new KubeError(`Kubernetes API error: ${text}`, 502, reason);
  }
}

/** TLS failures worth explaining in plain words. */
const TLS_CODES: Record<string, string> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the certificate is not signed by the cluster CA',
  SELF_SIGNED_CERT_IN_CHAIN: 'the certificate is not signed by the cluster CA',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the certificate is self-signed and not the cluster CA',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the certificate is not signed by a trusted CA — add the cluster CA',
  CERT_HAS_EXPIRED: 'the API server certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate does not cover the API server name',
};

/**
 * A transport failure (TCP, SSH channel, agent tunnel, TLS, timeout) as a
 * KubeError; errors that already carry a status are returned as they are.
 */
export function fromTransportError(err: unknown, fallback = 'Could not reach the Kubernetes API'): Error {
  if (err instanceof KubeError) return err;
  // Host key mismatches, jump host failures, missing credentials keep their own status and message
  if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number') return err;
  const code = (err as { code?: unknown } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === 'string' && TLS_CODES[code]) {
    return Object.assign(new KubeError(`TLS verification failed: ${TLS_CODES[code]} (${message})`, 502, 'TLSVerify'), { cause: err });
  }
  const mapped =
    code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)
      ? new KubeError(`${fallback}: timed out`, 504)
      : new KubeError(`${fallback}: ${message}`, 502);
  return Object.assign(mapped, { cause: err });
}
