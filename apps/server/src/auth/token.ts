import { createHash, randomBytes, timingSafeEqual } from 'crypto';
// Type-only: middleware imports this module at runtime, so a value import here
// would close the cycle.
import type { Role } from './middleware.js';

/**
 * Tokens look like `smt_<prefix>_<secret>`. The prefix is stored in the clear so
 * a lookup is a single indexed query, and it is what the UI shows to identify a
 * token after creation. Only the secret half is a credential.
 */
export const TOKEN_PREFIX = 'smt';
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

export type TokenScope = 'read' | 'write';

export interface GeneratedToken {
  /** Shown to the caller exactly once. */
  token: string;
  prefix: string;
  hashedToken: string;
}

export function generateApiToken(): GeneratedToken {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex');
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token: `${TOKEN_PREFIX}_${prefix}_${secret}`,
    prefix,
    hashedToken: hashSecret(secret),
  };
}

/**
 * SHA-256 rather than argon2: the secret is 32 random bytes, so there is no
 * dictionary to attack, and this runs on every API request. Argon2's cost is
 * the point when guarding a human-chosen password — here it would only be a
 * per-request tax.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export interface ParsedToken {
  prefix: string;
  secret: string;
}

/**
 * Split a presented token. Returns null for anything not in our format.
 *
 * Only the first two separators are structural — the secret is base64url, whose
 * alphabet includes `_`, so everything after the prefix is rejoined verbatim.
 */
export function parseApiToken(raw: string): ParsedToken | null {
  const parts = raw.trim().split('_');
  if (parts.length < 3) return null;
  const [scheme, prefix, ...rest] = parts;
  const secret = rest.join('_');
  if (scheme !== TOKEN_PREFIX || !prefix || !secret) return null;
  return { prefix, secret };
}

/** Constant-time comparison so a mismatch does not leak where it diverged. */
export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function isExpired(expiresAt: string | null, now = new Date()): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt) <= now;
}

/**
 * A token never grants more than the user who made it, and a read-only token is
 * capped at `viewer` no matter who owns it. Least privilege of the two.
 */
export function effectiveRole(userRole: Role, scopes: TokenScope[]): Role {
  if (!scopes.includes('write')) return 'viewer';
  return userRole;
}

/** Bearer value from an Authorization header, if it carries one. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}
