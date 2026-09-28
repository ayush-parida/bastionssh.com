import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { FtpHostKey, HostKeyStatus } from '@smt/shared';
import { getDb } from '../db/index.js';
import { ftpConnections } from '../db/schema.js';
import { notifyAlertsChanged } from '../notifications/index.js';
import type { ServerRef } from '../notifications/format.js';
import type { HostKeyStore, HostKeySubject } from '../ssh/host-keys.js';

/**
 * Pinned SSH host keys for SFTP file connections. The verifier itself lives in
 * ssh/host-keys.ts and is shared with managed servers; this is only where the
 * key is kept.
 *
 * server_alerts rows belong to servers, so a file connection's mismatch does
 * not open one. The mismatch columns on the connection row are the open alert
 * (the card shows it until an admin acts), and the notification channels hear
 * about it directly: a critical `host_key_mismatch` event when a new key is
 * first refused, and a resolution once an admin pins, accepts or forgets.
 */

type FtpConnectionRow = typeof ftpConnections.$inferSelect;

/** How a file connection is named in a notification. */
export function ftpAlertSubject(row: Pick<HostKeySubject, 'id' | 'name' | 'host'>): ServerRef {
  return { id: row.id, name: `${row.name} (SFTP file connection)`, host: row.host };
}

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
  alert(subject, message) {
    notifyAlertsChanged([
      {
        kind: 'opened',
        orgId: subject.orgId,
        serverId: subject.id,
        type: 'host_key_mismatch',
        severity: 'critical',
        message,
        subject: ftpAlertSubject(subject),
      },
    ]);
  },
};

/** Tell the channels a recorded mismatch has been dealt with (a no-op when there was none). */
export function resolveFtpHostKeyAlert(row: FtpConnectionRow) {
  if (!row.hostKeyMismatchFingerprint) return;
  notifyAlertsChanged([
    {
      kind: 'resolved',
      orgId: row.orgId,
      serverId: row.id,
      type: 'host_key_mismatch',
      severity: 'critical',
      message: `SSH host key mismatch (${row.hostKeyMismatchFingerprint}) reviewed by an admin`,
      ...(row.hostKeyMismatchAt && { openedAt: row.hostKeyMismatchAt }),
      subject: ftpAlertSubject(row),
    },
  ]);
}

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

/** Pin `fingerprint`, clearing any recorded mismatch (and resolving its alert). */
export function pinFtpHostKey(row: FtpConnectionRow, fingerprint: string, type: string | null) {
  getDb()
    .update(ftpConnections)
    .set({
      ...clearedFtpHostKeyColumns(),
      hostKeyFingerprint: fingerprint,
      hostKeyType: type,
      hostKeyTrustedAt: new Date().toISOString(),
    })
    .where(eq(ftpConnections.id, row.id))
    .run();
  resolveFtpHostKeyAlert(row);
}

export function forgetFtpHostKey(row: FtpConnectionRow) {
  getDb().update(ftpConnections).set(clearedFtpHostKeyColumns()).where(eq(ftpConnections.id, row.id)).run();
  resolveFtpHostKeyAlert(row);
}
