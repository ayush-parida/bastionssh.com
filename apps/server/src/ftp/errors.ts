/** An FTP failure that already knows which HTTP status it maps to. */
export class FtpError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'FtpError';
  }
}

interface ErrorLike {
  name?: string;
  code?: unknown;
  message?: string;
}

/** True for basic-ftp's FTPError: the server answered, it just said no. */
export function isReplyError(err: unknown): boolean {
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  return e.name === 'FTPError' && typeof e.code === 'number';
}

const UNREACHABLE = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'EPROTO',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/**
 * Map an FTP reply code onto an HTTP status. 550 is overloaded in the protocol
 * ("file unavailable" covers both a missing file and a permission problem), so
 * the server's own wording decides between 404 and 403.
 */
function statusForReply(code: number, message: string): number {
  switch (code) {
    case 550:
      return /permission|denied|not allowed|forbidden|access/i.test(message) ? 403 : 404;
    case 530: // not logged in / login incorrect
    case 532: // need account for storing files
      return 403;
    case 421: // service not available, closing control connection
    case 425: // can't open data connection
    case 426: // connection closed, transfer aborted
    case 451: // requested action aborted: local error
      return 502;
    case 450: // file busy
      return 409;
    case 452: // insufficient storage space
    case 552: // exceeded storage allocation
      return 507;
    case 553: // file name not allowed
      return 400;
    default:
      // 5xx are permanent negative replies to what we sent; 4xx are transient
      return code >= 500 ? 400 : 502;
  }
}

/**
 * Turn whatever basic-ftp threw into an FtpError with an HTTP status a route
 * can send as-is. The server's own message is kept so the user sees the real
 * reason; only the status is ours.
 */
export function toFtpError(err: unknown, fallback = 'FTP request failed'): FtpError {
  if (err instanceof FtpError) return err;
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const message = e.message?.trim() || fallback;

  if (isReplyError(err)) return new FtpError(message, statusForReply(e.code as number, message));

  if (typeof e.code === 'string') {
    if (e.code === 'ETIMEDOUT') return new FtpError(`FTP request timed out: ${message}`, 504);
    if (UNREACHABLE.has(e.code)) {
      return new FtpError(`Could not reach FTP server: ${message}`, 502);
    }
  }
  // basic-ftp's own socket watchdog throws a plain Error("Timeout (control socket)")
  if (/timeout/i.test(message)) return new FtpError(`FTP request timed out: ${message}`, 504);
  if (/closed|disconnected|socket/i.test(message)) {
    return new FtpError(`FTP connection lost: ${message}`, 502);
  }
  return new FtpError(message, 502);
}
