import type { HostKeyMismatchErrorBody } from '@smt/shared';
import { ApiError } from '@/lib/api.js';

/** WebSocket close code the terminal broker uses when the host key changed. */
export const WS_CLOSE_HOST_KEY_MISMATCH = 4409;

/** Where the host key panel lives for a server. */
export function hostKeyPanelPath(serverId: string) {
  return `/servers/${serverId}/health#host-key`;
}

/** The expected/presented fingerprints when an API call was refused over a changed host key. */
export function hostKeyMismatchOf(err: unknown): HostKeyMismatchErrorBody | null {
  if (!(err instanceof ApiError) || err.code !== 'HOST_KEY_MISMATCH') return null;
  const d = err.details ?? {};
  return {
    error: err.message,
    code: 'HOST_KEY_MISMATCH',
    expected: String(d.expected ?? ''),
    presented: String(d.presented ?? ''),
  };
}
