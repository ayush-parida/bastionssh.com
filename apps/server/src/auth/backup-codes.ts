import { createHmac, hkdfSync, randomInt } from 'crypto';
import { and, count, eq, gt, isNull, max } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { BackupCodeStatus } from '@smt/shared';
import { getDb } from '../db/index.js';
import { backupCodes, webauthnChallenges } from '../db/schema.js';
import { config } from '../config/index.js';
import { hashTicket, passkeyCount } from './passkey.js';

export const BACKUP_CODE_COUNT = 10;

/** Characters per code, shown as two groups of five. */
const CODE_LENGTH = 10;

/** Crockford base32: no I, L, O or U, so nothing reads as something else. 32 symbols, 50 bits a code. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Wrong codes one pending sign-in may try before it has to start over from the password. */
export const MAX_BACKUP_CODE_ATTEMPTS = 5;

/**
 * The HMAC key, derived from the session secret under its own label so it is
 * never the same bytes as anything else keyed from that secret. Codes carry 50
 * bits of randomness, so a fast keyed hash is enough — the key keeps a leaked
 * table from being checked offline without the secret too.
 */
let key: Buffer | null = null;
function hmacKey(): Buffer {
  key ??= Buffer.from(hkdfSync('sha256', config.sessionSecret, '', 'smt/backup-codes/v1', 32));
  return key;
}

/**
 * The code as it is hashed: separators and spaces dropped, upper-cased, and
 * the letters Crockford reads as digits (O → 0, I and L → 1) mapped back.
 */
export function normalizeBackupCode(input: string): string {
  return input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function hashBackupCode(input: string): string {
  return createHmac('sha256', hmacKey()).update(normalizeBackupCode(input)).digest('hex');
}

/** randomInt draws without modulo bias. */
function newCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Replace the user's codes with a fresh set, in one transaction so no moment
 * exists with both sets or neither. Returns the plaintext codes — the only
 * time they exist outside the user's hands — or null when the user has no
 * passkey for them to stand in for.
 */
export function generateBackupCodes(
  userId: string,
): { codes: string[]; createdAt: string; replaced: number } | null {
  const db = getDb();
  const createdAt = new Date().toISOString();
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, newCode);
  return db.transaction(() => {
    if (passkeyCount(userId) === 0) return null;
    const replaced = db.delete(backupCodes).where(eq(backupCodes.userId, userId)).run().changes;
    db.insert(backupCodes)
      .values(codes.map((code) => ({ id: nanoid(), userId, codeHash: hashBackupCode(code), createdAt })))
      .run();
    return { codes, createdAt, replaced };
  });
}

export function backupCodeStatus(userId: string): BackupCodeStatus {
  const row = getDb()
    .select({ total: count(), createdAt: max(backupCodes.createdAt) })
    .from(backupCodes)
    .where(eq(backupCodes.userId, userId))
    .get();
  return { total: row?.total ?? 0, remaining: remainingBackupCodes(userId), createdAt: row?.createdAt ?? null };
}

export function remainingBackupCodes(userId: string): number {
  return (
    getDb()
      .select({ n: count() })
      .from(backupCodes)
      .where(and(eq(backupCodes.userId, userId), isNull(backupCodes.usedAt)))
      .get()?.n ?? 0
  );
}

export function deleteBackupCodes(userId: string): number {
  return getDb().delete(backupCodes).where(eq(backupCodes.userId, userId)).run().changes;
}

export type BackupCodeRedemption =
  /** No live ticket: unknown, expired, already used, or out of attempts. */
  | { status: 'expired' }
  | { status: 'wrong'; attemptsLeft: number }
  /** `admit` turned the account away (every membership suspended); nothing was spent or counted. */
  | { status: 'refused' }
  | { status: 'ok'; userId: string };

/**
 * Spend a backup code against a pending password sign-in. All in one
 * synchronous transaction: the code is marked used only while still unused
 * (so two requests racing with the same code cannot both win), and the
 * ticket is consumed with it. A wrong code only counts against the ticket,
 * which is dropped once it runs out of attempts.
 *
 * `admit` is asked, inside the same transaction and before the code is
 * looked at, whether this account may sign in at all. A refusal ends the
 * pending sign-in without spending a code or counting an attempt, so a
 * suspension that landed while the ticket was out does not burn a code.
 */
export function redeemBackupCode(
  ticket: string,
  code: string,
  admit: (userId: string) => boolean = () => true,
): BackupCodeRedemption {
  const db = getDb();
  return db.transaction(() => {
    const pending = db
      .select()
      .from(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.purpose, 'second_factor'),
          eq(webauthnChallenges.ticketHash, hashTicket(ticket)),
          gt(webauthnChallenges.expiresAt, new Date().toISOString()),
        ),
      )
      .get();
    if (!pending?.userId || pending.attempts >= MAX_BACKUP_CODE_ATTEMPTS) return { status: 'expired' };

    if (!admit(pending.userId)) {
      db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, pending.id)).run();
      return { status: 'refused' };
    }

    const spent = db
      .update(backupCodes)
      .set({ usedAt: new Date().toISOString() })
      .where(
        and(
          eq(backupCodes.userId, pending.userId),
          eq(backupCodes.codeHash, hashBackupCode(code)),
          isNull(backupCodes.usedAt),
        ),
      )
      .run().changes;

    if (spent !== 1) {
      const attempts = pending.attempts + 1;
      if (attempts >= MAX_BACKUP_CODE_ATTEMPTS) {
        db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, pending.id)).run();
      } else {
        db.update(webauthnChallenges).set({ attempts }).where(eq(webauthnChallenges.id, pending.id)).run();
      }
      return { status: 'wrong', attemptsLeft: MAX_BACKUP_CODE_ATTEMPTS - attempts };
    }

    db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, pending.id)).run();
    return { status: 'ok', userId: pending.userId };
  });
}
