import { createHash, randomBytes } from 'crypto';
import { config } from '../config/index.js';

export const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type PasswordResetState = 'valid' | 'expired' | 'used';

/** The secret half: goes in the link, never in the database. */
export function generateResetToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only the hash is stored, so a leaked database backup holds no usable links.
 * A fast hash is fine here — the token is 256 random bits, not a password.
 */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function resetExpiry(now = new Date()): string {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString();
}

export function resetState(
  reset: { expiresAt: string; usedAt: string | null },
  now = new Date(),
): PasswordResetState {
  if (reset.usedAt) return 'used';
  if (new Date(reset.expiresAt) <= now) return 'expired';
  return 'valid';
}

export function resetLink(token: string): string {
  return `${config.baseUrl.replace(/\/$/, '')}/reset-password/${token}`;
}
