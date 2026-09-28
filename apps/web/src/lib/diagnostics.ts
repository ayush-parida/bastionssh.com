import type { DiagnosticTargetKind } from '@smt/shared';

/** What the diagnostics dialog needs to know about the thing it probes. */
export interface DiagnoseTarget {
  kind: DiagnosticTargetKind;
  id: string;
  name: string;
}

const ROUTE: Record<DiagnosticTargetKind, string> = {
  server: 'servers',
  ftp_connection: 'ftp',
  storage_connection: 'storage',
};

export function diagnosticsPath(target: Pick<DiagnoseTarget, 'kind' | 'id'>): string {
  return `/diagnostics/${ROUTE[target.kind]}/${target.id}`;
}

/**
 * Errors a step-by-step check can explain better than the message itself:
 * timeouts, refusals, unreachable hosts and names that do not resolve.
 * Authentication and permission failures are left alone.
 */
const CONNECTIVITY =
  /timed? ?out|timeout|ETIMEDOUT|ECONNREFUSED|connection refused|refused|EHOSTUNREACH|ENETUNREACH|unreachable|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|socket hang up|closed before|no route/i;

export function isConnectivityFailure(message: string | null | undefined): boolean {
  return !!message && CONNECTIVITY.test(message);
}
