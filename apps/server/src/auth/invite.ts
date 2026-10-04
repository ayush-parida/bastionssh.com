import { randomBytes } from 'crypto';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function inviteExpiry(now = new Date()): string {
  return new Date(now.getTime() + INVITE_TTL_MS).toISOString();
}

export type InviteState = 'valid' | 'expired' | 'accepted';

/**
 * Enough of the address for the right person to recognise it, not enough for a
 * stranger holding the link to type it back. The accept form requires the full
 * address, so this hint is the only thing standing between a forwarded link and
 * a redeemed invite — keep it stingy.
 *
 *   dev@example.com → de•@ex•••••.com
 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const name = dot === -1 ? domain : domain.slice(0, dot);
  const tld = dot === -1 ? '' : domain.slice(dot);

  return `${mask(local)}@${mask(name)}${tld}`;
}

function mask(value: string): string {
  if (value.length <= 1) return '•';
  const shown = value.slice(0, Math.min(2, value.length - 1));
  return shown + '•'.repeat(value.length - shown.length);
}

/** Addresses differing only by case or padding are the same address. */
export function emailsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function inviteState(
  invite: { expiresAt: string; acceptedAt: string | null },
  now = new Date(),
): InviteState {
  if (invite.acceptedAt) return 'accepted';
  if (new Date(invite.expiresAt) <= now) return 'expired';
  return 'valid';
}
