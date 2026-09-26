/**
 * `unknown` — nothing pinned yet; the next connection trusts what it sees.
 * `trusted` — a fingerprint is pinned and no different key has been seen.
 * `mismatch` — the host presented another key; connections are refused until an admin decides.
 */
export type HostKeyStatus = 'unknown' | 'trusted' | 'mismatch';

export interface HostKeyMismatch {
  fingerprint: string;
  type: string | null;
  seenAt: string;
}

/** GET /api/servers/:id/host-key */
export interface ServerHostKey {
  fingerprint: string | null;
  type: string | null;
  trustedAt: string | null;
  /** User who pinned or accepted the key; null when it was trusted on first use. */
  trustedBy: string | null;
  mismatch?: HostKeyMismatch;
}

/** POST /api/servers/:id/host-key/scan — what the host presents right now; nothing is stored. */
export interface HostKeyScanResult {
  fingerprint: string;
  type: string;
}

/** Body of a 409 when a connection was refused because the host key changed. */
export interface HostKeyMismatchErrorBody {
  error: string;
  code: 'HOST_KEY_MISMATCH';
  serverId?: string;
  expected: string;
  presented: string;
}

/** `SHA256:` followed by 43 unpadded base64 characters. */
export const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
