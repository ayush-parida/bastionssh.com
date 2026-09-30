import type { DockerProblem } from '@smt/shared';

/**
 * Every Docker failure a route can surface, with the HTTP status to answer
 * with. The app's error handler sends anything under 500 as `{ error }`; the
 * routes send 502/504 themselves so the message (not "Internal Server Error")
 * reaches the UI.
 */
export class DockerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    /** Detection failures carry the diagnosis and what to do about it. */
    readonly problem?: DockerProblem,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DockerError';
  }

  toJSON() {
    return {
      error: this.message,
      ...(this.problem && { code: `DOCKER_${this.problem.toUpperCase()}`, problem: this.problem }),
      ...(this.hint && { hint: this.hint }),
    };
  }
}

/** Docker is switched off for the server. */
export function dockerOff(): DockerError {
  return new DockerError('Docker is turned off for this server', 400, 'disabled');
}

/** The daemon's `{ message }` body, or the raw text when it is not JSON. */
export function daemonMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500);
}

/**
 * Map a daemon HTTP error onto ours: its client errors keep their meaning
 * (404 no such container, 409 conflict, 400 bad parameter), 304 "already in
 * that state" reads as a conflict, and a daemon-side failure is a bad gateway.
 */
export function fromDaemonStatus(status: number, body: string): DockerError {
  const message = daemonMessage(body) || `Docker answered ${status}`;
  switch (status) {
    case 304:
      return new DockerError(message || 'Nothing to change', 409);
    case 400:
    case 404:
    case 409:
      return new DockerError(message, status);
    case 401:
    case 403:
      return new DockerError(message, 403);
    default:
      return new DockerError(`Docker daemon error: ${message}`, 502);
  }
}

/** SSH channel-open failure reasons (RFC 4254 §5.1). */
export const CHANNEL_OPEN = { ADMINISTRATIVELY_PROHIBITED: 1, CONNECT_FAILED: 2, UNKNOWN_CHANNEL_TYPE: 3 } as const;

/**
 * sshd said outright that it will not forward sockets (not OpenSSH, or an
 * explicit refusal). OpenSSH refusing because of `AllowTcpForwarding no` or
 * `AllowStreamLocalForwarding no` usually looks like a plain "open failed"
 * instead — see {@link isChannelOpenFailure}.
 */
export function isForwardingRefused(err: unknown): boolean {
  const reason = (err as { reason?: unknown } | undefined)?.reason;
  if (reason === CHANNEL_OPEN.ADMINISTRATIVELY_PROHIBITED || reason === CHANNEL_OPEN.UNKNOWN_CHANNEL_TYPE) return true;
  const message = err instanceof Error ? err.message : '';
  return /prohibited|unknown channel type|strictVendor/i.test(message);
}

/** sshd could not or would not open the channel (as opposed to the daemon answering badly). */
export function isChannelOpenFailure(err: unknown): boolean {
  if (typeof (err as { reason?: unknown } | undefined)?.reason === 'number') return true;
  return err instanceof Error && err.message.includes('Channel open failure');
}

/**
 * A transport failure (SSH channel, dropped connection, timeout) as a
 * DockerError; errors that already carry a status are returned as they are.
 */
export function fromTransportError(err: unknown, fallback = 'Could not reach the Docker daemon'): Error {
  if (err instanceof DockerError) return err;
  // Anything with its own status (host key mismatch, missing credentials) passes through untouched
  if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number') return err;
  const message = err instanceof Error ? err.message : String(err);
  const mapped =
    (err as { code?: string } | undefined)?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)
      ? new DockerError(`${fallback}: timed out`, 504)
      : new DockerError(`${fallback}: ${message}`, 502);
  // Kept for detection, which tells a refused channel from a daemon that answered badly
  return Object.assign(mapped, { cause: err });
}
