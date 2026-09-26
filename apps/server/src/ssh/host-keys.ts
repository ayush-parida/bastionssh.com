import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import {
  HOST_KEY_FINGERPRINT_PATTERN,
  type HostKeyScanResult,
  type HostKeyStatus,
  type ServerHostKey,
} from '@smt/shared';
import { getDb } from '../db/index.js';
import { servers } from '../db/schema.js';
import { auditSystem } from '../audit/index.js';
import { openHostKeyAlert, resolveHostKeyAlert } from '../monitoring/alerts.js';
import logger from '../logger.js';

/**
 * SSH host key verification. Every ssh2 connection to a managed server builds
 * its options through {@link sshConnectConfig}, which attaches a `hostVerifier`
 * bound to that server's row:
 *
 * - nothing pinned → accept and record the key (trust on first use);
 * - pinned and equal → accept;
 * - pinned and different → refuse the handshake before any credential is
 *   sent, record what was presented, audit it and raise an alert.
 *
 * Fingerprints use the OpenSSH format, `SHA256:<base64 without padding>` of the
 * raw key blob, so they compare directly with `ssh-keygen -lf`.
 */

/** Why a connection was opened — recorded with TOFU and mismatch audit rows. */
export type HostKeyPurpose = 'terminal' | 'exec' | 'sftp' | 'health_check';

export interface SshTarget {
  /** The servers row id — the pinned key is looked up by it. */
  id: string;
  host: string;
  port: number;
  username: string;
}

export interface SshAuth {
  privateKey?: string;
  password?: string;
}

/** OpenSSH-style fingerprint of a public key blob, as `ssh-keygen -lf` prints it. */
export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Key algorithm named at the start of the blob (an SSH `string`: uint32 length
 * then bytes), e.g. `ssh-ed25519`. Null when the blob is too short to hold one.
 */
export function hostKeyType(blob: Buffer): string | null {
  if (blob.length < 4) return null;
  const len = blob.readUInt32BE(0);
  if (len === 0 || len > 64 || blob.length < 4 + len) return null;
  return blob.subarray(4, 4 + len).toString('ascii');
}

export function isValidFingerprint(value: string): boolean {
  return HOST_KEY_FINGERPRINT_PATTERN.test(value);
}

/** The host presented a different key than the pinned one; the handshake was refused. */
export class HostKeyMismatchError extends Error {
  readonly statusCode = 409;
  readonly code = 'HOST_KEY_MISMATCH';

  constructor(
    readonly serverId: string,
    readonly expected: string,
    readonly presented: string,
    readonly presentedType: string | null,
    serverLabel = 'this server',
  ) {
    super(
      `SSH host key for ${serverLabel} has changed: expected ${expected}, but the host presented ${presented}. ` +
        'The connection was refused. An admin must review the new key before anyone can connect.',
    );
    this.name = 'HostKeyMismatchError';
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      serverId: this.serverId,
      expected: this.expected,
      presented: this.presented,
    };
  }
}

type ServerRow = typeof servers.$inferSelect;

export function hostKeyStatus(
  row: Pick<ServerRow, 'hostKeyFingerprint' | 'hostKeyMismatchFingerprint'>,
): HostKeyStatus {
  if (row.hostKeyMismatchFingerprint) return 'mismatch';
  return row.hostKeyFingerprint ? 'trusted' : 'unknown';
}

export function hostKeyView(row: ServerRow): ServerHostKey {
  return {
    fingerprint: row.hostKeyFingerprint,
    type: row.hostKeyType,
    trustedAt: row.hostKeyTrustedAt,
    trustedBy: row.hostKeyTrustedBy,
    ...(row.hostKeyMismatchFingerprint && {
      mismatch: {
        fingerprint: row.hostKeyMismatchFingerprint,
        type: row.hostKeyMismatchType,
        seenAt: row.hostKeyMismatchAt ?? '',
      },
    }),
  };
}

function loadServer(serverId: string): ServerRow | undefined {
  return getDb().select().from(servers).where(eq(servers.id, serverId)).get();
}

function mismatchMessage(expected: string, presented: string) {
  return `SSH host key changed: expected ${expected}, host presented ${presented}. Connections are refused until an admin reviews it.`;
}

export type HostKeyCheck = { ok: true } | { ok: false; error: Error };

/** The address a connection was actually opened to. */
export interface HostKeyEndpoint {
  host: string;
  port: number;
}

/**
 * Decide whether `blob` is an acceptable host key for the server, recording a
 * first-use key or a mismatch as a side effect. Synchronous so it can run
 * inside ssh2's key exchange.
 *
 * `endpoint` is where the connection was opened. The row is keyed by server id,
 * so a connection that started before an admin changed the host or port (or a
 * long-lived session re-keying afterwards) would otherwise be judged against —
 * and could trust on first use for — an endpoint it never talked to. Such a
 * connection is refused without recording anything.
 */
export function checkHostKey(
  serverId: string,
  blob: Buffer,
  purpose: HostKeyPurpose,
  endpoint?: HostKeyEndpoint,
): HostKeyCheck {
  const presented = hostKeyFingerprint(blob);
  const type = hostKeyType(blob);
  const db = getDb();

  // Two attempts: the second only runs when a concurrent connection pinned a
  // key between our read and our TOFU write.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = loadServer(serverId);
    if (!row) return { ok: false, error: new Error('Host key could not be verified: server not found') };
    if (endpoint && (row.host !== endpoint.host || row.port !== endpoint.port)) {
      logger.warn(
        { serverId, connectedTo: endpoint, current: { host: row.host, port: row.port }, purpose },
        'Server address changed while connecting — host key not checked, connection refused',
      );
      return {
        ok: false,
        error: new Error('Host key could not be verified: the server address changed while connecting. Retry.'),
      };
    }

    if (!row.hostKeyFingerprint) {
      const now = new Date().toISOString();
      const result = db
        .update(servers)
        .set({
          hostKeyFingerprint: presented,
          hostKeyType: type,
          hostKeyTrustedAt: now,
          hostKeyTrustedBy: null,
        })
        .where(and(eq(servers.id, serverId), isNull(servers.hostKeyFingerprint)))
        .run();
      if (result.changes === 0) continue;

      logger.info({ serverId, fingerprint: presented, type, purpose }, 'Trusted SSH host key on first use');
      auditSystem(row.orgId, 'server.host_key_trusted', 'server', row.id, row.name, {
        method: 'tofu',
        fingerprint: presented,
        type,
        via: purpose,
      });
      return { ok: true };
    }

    if (row.hostKeyFingerprint === presented) {
      // A pre-pinned fingerprint carries no type; fill it in from the real key
      if (!row.hostKeyType && type) {
        db.update(servers)
          .set({ hostKeyType: type })
          .where(and(eq(servers.id, serverId), eq(servers.hostKeyFingerprint, presented)))
          .run();
      }
      return { ok: true };
    }

    const expected = row.hostKeyFingerprint;
    logger.warn(
      { serverId, host: row.host, port: row.port, expected, presented, type, purpose },
      'SSH host key mismatch — connection refused',
    );

    // Only a new distinct key is recorded, audited and alerted; a host that
    // keeps presenting the same wrong key does not flood the log.
    const recorded = db
      .update(servers)
      .set({
        hostKeyMismatchFingerprint: presented,
        hostKeyMismatchType: type,
        hostKeyMismatchAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(servers.id, serverId),
          or(
            isNull(servers.hostKeyMismatchFingerprint),
            ne(servers.hostKeyMismatchFingerprint, presented),
          ),
        ),
      )
      .run();
    if (recorded.changes > 0) {
      auditSystem(row.orgId, 'server.host_key_mismatch', 'server', row.id, row.name, {
        expected,
        presented,
        type,
        via: purpose,
      });
      try {
        openHostKeyAlert(row.orgId, row.id, mismatchMessage(expected, presented));
      } catch (err) {
        logger.error({ err, serverId }, 'Failed to raise host key alert');
      }
    }

    return {
      ok: false,
      error: new HostKeyMismatchError(row.id, expected, presented, type, `${row.name} (${row.host}:${row.port})`),
    };
  }

  return { ok: false, error: new Error('Host key could not be verified') };
}

export interface HostKeyGuard {
  /** ssh2 `hostVerifier`: called with the raw host key blob during key exchange. */
  hostVerifier: (key: Buffer) => boolean;
  /**
   * Map the error ssh2 emits after a refused key ("Host denied (verification
   * failed)") to the reason it was refused. Other errors pass through.
   */
  error: (err: Error) => Error;
}

export function hostKeyGuard(
  serverId: string,
  purpose: HostKeyPurpose,
  endpoint?: HostKeyEndpoint,
): HostKeyGuard {
  let refusal: Error | undefined;
  return {
    hostVerifier: (key: Buffer) => {
      let check: HostKeyCheck;
      try {
        check = checkHostKey(serverId, key, purpose, endpoint);
      } catch (err) {
        // Fail closed: a key we could not check is a key we do not trust
        logger.error({ err, serverId }, 'Host key verification failed unexpectedly');
        check = { ok: false, error: new Error('Host key could not be verified') };
      }
      if (!check.ok) refusal = check.error;
      return check.ok;
    },
    error: (err: Error) => refusal ?? err,
  };
}

const PREFERABLE_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
]);

/** ssh2 host key algorithms that yield a key of the given blob type. */
function algorithmsForKeyType(type: string): string[] {
  return type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type];
}

/**
 * Ask for the pinned key's type first, as OpenSSH does for known hosts. Without
 * this, a host that later gains a key type ssh2 ranks higher (e.g. ed25519 next
 * to a pinned rsa key) would present that one instead and every connection
 * would be refused as a "changed" key. Other types stay offered afterwards, so
 * an impostor with a different key still shows up as a mismatch.
 */
function preferPinnedKeyType(serverId: string): ConnectConfig['algorithms'] | undefined {
  try {
    const row = getDb()
      .select({ fingerprint: servers.hostKeyFingerprint, type: servers.hostKeyType })
      .from(servers)
      .where(eq(servers.id, serverId))
      .get();
    // Only types ssh2 can negotiate; anything else would make connect() throw
    if (!row?.fingerprint || !row.type || !PREFERABLE_KEY_TYPES.has(row.type)) return undefined;
    const algorithms = algorithmsForKeyType(row.type);
    // Remove, then prepend: ssh2 skips a prepend already present in the list
    return { serverHostKey: { remove: algorithms, prepend: algorithms } } as ConnectConfig['algorithms'];
  } catch {
    return undefined;
  }
}

/**
 * The one way to build ssh2 connect options for a managed server: target,
 * credentials and a host key verifier bound to that server. Callers wire
 * `guard.error` into their `'error'` handler so a refused key surfaces as a
 * {@link HostKeyMismatchError} rather than ssh2's generic handshake error.
 */
export function sshConnectConfig(
  target: SshTarget,
  auth: SshAuth,
  purpose: HostKeyPurpose,
  extra: Omit<ConnectConfig, 'host' | 'port' | 'username' | 'hostVerifier' | 'hostHash'> = {},
): { config: ConnectConfig; guard: HostKeyGuard } {
  const guard = hostKeyGuard(target.id, purpose, { host: target.host, port: target.port });
  // The verifier must see the raw key blob: a caller-supplied hostHash would
  // make ssh2 hand it a hex digest instead, which never equals a fingerprint.
  const { hostHash: _ignored, ...rest } = extra as ConnectConfig;
  const algorithms = rest.algorithms ?? preferPinnedKeyType(target.id);
  return {
    guard,
    config: {
      ...rest,
      ...(algorithms && { algorithms }),
      host: target.host,
      port: target.port,
      username: target.username,
      ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
      ...(!auth.privateKey && auth.password ? { password: auth.password } : {}),
      hostVerifier: guard.hostVerifier,
    },
  };
}

export const SCAN_TIMEOUT_MS = 10_000;

/**
 * Read the key a host presents without authenticating: the verifier captures
 * it and refuses, which ends the connection before any credential is sent.
 * Nothing is stored.
 */
export function scanHostKey(
  host: string,
  port: number,
  timeoutMs = SCAN_TIMEOUT_MS,
): Promise<HostKeyScanResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let captured: Buffer | undefined;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        // already torn down
      }
      fn();
    };

    const done = () => {
      if (!captured) return false;
      const key = captured;
      finish(() => resolve({ fingerprint: hostKeyFingerprint(key), type: hostKeyType(key) ?? 'unknown' }));
      return true;
    };

    const timer = setTimeout(() => {
      finish(() => reject(new HostKeyScanError(`No host key received from ${host}:${port} within ${timeoutMs}ms`)));
    }, timeoutMs);

    client
      .on('error', (err: Error) => {
        if (done()) return;
        finish(() => reject(new HostKeyScanError(`Could not read the host key: ${err.message}`)));
      })
      .on('close', () => {
        if (done()) return;
        finish(() => reject(new HostKeyScanError('Connection closed before a host key was received')));
      });

    client.connect({
      host,
      port,
      // Never used: the handshake is abandoned before user authentication
      username: 'smt-host-key-scan',
      readyTimeout: timeoutMs,
      hostVerifier: (key: Buffer) => {
        captured = key;
        return false;
      },
    });
  });
}

export class HostKeyScanError extends Error {
  readonly statusCode = 502;
  constructor(message: string) {
    super(message);
    this.name = 'HostKeyScanError';
  }
}

// ── Admin operations ─────────────────────────────────────────────────────────

const CLEARED = {
  hostKeyFingerprint: null,
  hostKeyType: null,
  hostKeyTrustedAt: null,
  hostKeyTrustedBy: null,
  hostKeyMismatchFingerprint: null,
  hostKeyMismatchType: null,
  hostKeyMismatchAt: null,
} satisfies Partial<typeof servers.$inferInsert>;

/** Column values that pin `fingerprint`, attributed to `userId`, with no mismatch. */
export function pinnedColumns(fingerprint: string, type: string | null, userId: string) {
  return {
    ...CLEARED,
    hostKeyFingerprint: fingerprint,
    hostKeyType: type,
    hostKeyTrustedAt: new Date().toISOString(),
    hostKeyTrustedBy: userId,
  } satisfies Partial<typeof servers.$inferInsert>;
}

/** Column values that forget the key, so the next connection trusts on first use. */
export function clearedColumns() {
  return { ...CLEARED };
}

/** Pin a fingerprint (clearing any mismatch) and close the host key alert. */
export function pinHostKey(row: ServerRow, fingerprint: string, type: string | null, userId: string) {
  getDb()
    .update(servers)
    .set(pinnedColumns(fingerprint, type, userId))
    .where(eq(servers.id, row.id))
    .run();
  resolveHostKeyAlert(row.orgId, row.id);
}

/** Forget the pinned key and any mismatch; the next connection is TOFU. */
export function forgetHostKey(row: ServerRow) {
  getDb().update(servers).set(clearedColumns()).where(eq(servers.id, row.id)).run();
  resolveHostKeyAlert(row.orgId, row.id);
}
