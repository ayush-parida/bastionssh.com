/** A lookup failure that already knows which HTTP status it maps to. */
export class DnsError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'DnsError';
  }
}

/** What each libuv/c-ares code means in words a user can act on. */
const MESSAGES: Record<string, string> = {
  ENOTFOUND: 'No such domain (NXDOMAIN)',
  ENODATA: 'No records of this type',
  ESERVFAIL: 'The nameserver failed to answer (SERVFAIL)',
  EREFUSED: 'The nameserver refused the query',
  ETIMEOUT: 'The nameserver did not answer in time',
  ECONNREFUSED: 'The nameserver refused the connection',
  EBADNAME: 'That is not a valid domain name',
  EBADRESP: 'The nameserver sent a malformed response',
  ECANCELLED: 'The query was cancelled',
  ENOTIMP: 'The nameserver does not implement this query',
};

/** Human text for whatever `node:dns` threw; the raw code is kept as a fallback. */
export function describeDnsError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/** Shown for every record type once the name itself turns out not to exist. */
export const NXDOMAIN_MESSAGE = MESSAGES['ENOTFOUND']!;

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/**
 * The name exists but has no records of this type. Not a failure: the resolver
 * answered, the answer was empty. Distinct from the name not existing at all,
 * which every type reports as ENOTFOUND and which the user needs to be told.
 */
export function isEmptyAnswer(err: unknown): boolean {
  return codeOf(err) === 'ENODATA';
}

/** The name does not exist (NXDOMAIN). */
export function isNotFound(err: unknown): boolean {
  return codeOf(err) === 'ENOTFOUND';
}
