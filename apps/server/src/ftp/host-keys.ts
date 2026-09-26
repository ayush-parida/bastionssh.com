import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { FtpHostKey, HostKeyStatus } from '@smt/shared';
import { getDb } from '../db/index.js';
import { ftpConnections } from '../db/schema.js';
import type { HostKeyStore } from '../ssh/host-keys.js';

/**
 * Pinned SSH host keys for SFTP file connections. The verifier itself lives in
 * ssh/host-keys.ts and is shared with managed servers; this is only where the
 * key is kept. FTP connections have no alert table of their own, so a mismatch
 * is recorded and audited, and the connection is refused, but no alert opens.
 */

type FtpConnectionRow = typeof ftpConnections.$inferSelect;

export const ftpHostKeyStore: HostKeyStore = {
  kind: 'ftp_connection',
  load(id) {
    return getDb().select().from(ftpConnections).where(eq(ftpConnections.id, id)).get();
  },
  trustOnFirstUse(id, fingerprint, type, at) {
    const result = getDb()
      .update(ftpConnections)
      .set({ hostKeyFingerprint: fingerprint, hostKeyType: type, hostKeyTrustedAt: at })
      .where(and(eq(ftpConnections.id, id), isNull(ftpConnections.hostKeyFingerprint)))
      .run();
    return result.changes > 0;
  },
  fillType(id, fingerprint, type) {
    getDb()
      .update(ftpConnections)
      .set({ hostKeyType: type })
      .where(and(eq(ftpConnections.id, id), eq(ftpConnections.hostKeyFingerprint, fingerprint)))
      .run();
  },
  recordMismatch(id, fingerprint, _type, at) {
    const result = getDb()
      .update(ftpConnections)
      .set({ hostKeyMismatchFingerprint: fingerprint, hostKeyMismatchAt: at })
      .where(
        and(
          eq(ftpConnections.id, id),
          or(
            isNull(ftpConnections.hostKeyMismatchFingerprint),
            ne(ftpConnections.hostKeyMismatchFingerprint, fingerprint),
          ),
        ),
      )
      .run();
    return result.changes > 0;
  },
};

export function ftpHostKeyStatus(
  row: Pick<FtpConnectionRow, 'hostKeyFingerprint' | 'hostKeyMismatchFingerprint'>,
): HostKeyStatus {
  if (row.hostKeyMismatchFingerprint) return 'mismatch';
  return row.hostKeyFingerprint ? 'trusted' : 'unknown';
}

export function ftpHostKeyView(row: FtpConnectionRow): FtpHostKey {
  return {
    fingerprint: row.hostKeyFingerprint,
    type: row.hostKeyType,
    trustedAt: row.hostKeyTrustedAt,
    ...(row.hostKeyMismatchFingerprint && {
      mismatch: {
        fingerprint: row.hostKeyMismatchFingerprint,
        // Only the fingerprint of a rejected key is kept
        type: null,
        seenAt: row.hostKeyMismatchAt ?? '',
      },
    }),
  };
}

/** Column values that forget the key, so the next connection trusts on first use. */
export function clearedFtpHostKeyColumns() {
  return {
    hostKeyFingerprint: null,
    hostKeyType: null,
    hostKeyTrustedAt: null,
    hostKeyMismatchFingerprint: null,
    hostKeyMismatchAt: null,
  } satisfies Partial<typeof ftpConnections.$inferInsert>;
}

/** Pin `fingerprint`, clearing any recorded mismatch. */
export function pinFtpHostKey(id: string, fingerprint: string, type: string | null) {
  getDb()
    .update(ftpConnections)
    .set({
      ...clearedFtpHostKeyColumns(),
      hostKeyFingerprint: fingerprint,
      hostKeyType: type,
      hostKeyTrustedAt: new Date().toISOString(),
    })
    .where(eq(ftpConnections.id, id))
    .run();
}

export function forgetFtpHostKey(id: string) {
  getDb().update(ftpConnections).set(clearedFtpHostKeyColumns()).where(eq(ftpConnections.id, id)).run();
}
