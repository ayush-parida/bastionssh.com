import { createHash, randomBytes } from 'node:crypto';

/**
 * Agent tokens look like `bsa_<43 base64url chars>` — 32 random bytes. Only a
 * SHA-256 of the whole token is stored, and a presented token is found by
 * that hash: with this much entropy there is nothing to brute-force, so a
 * slow hash would only tax every reconnect (see auth/token.ts).
 */
export const AGENT_TOKEN_PREFIX = 'bsa_';
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^bsa_[A-Za-z0-9_-]{43}$/;

export function generateAgentToken(): { token: string; tokenHash: string } {
  const token = `${AGENT_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return { token, tokenHash: hashAgentToken(token) };
}

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether `raw` is shaped like an agent token; anything else is not looked up. */
export function isAgentToken(raw: string): boolean {
  return TOKEN_PATTERN.test(raw);
}
