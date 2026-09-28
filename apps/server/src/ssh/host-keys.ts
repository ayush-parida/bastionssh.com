import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';
import type { Duplex } from 'node:stream';
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
import { openAgentTunnel } from '../agents/hub.js';
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
 *
 * The same checks guard SFTP file connections (ftp/host-keys.ts); a
 * {@link HostKeyStore} says which table holds the pinned key.
 *
 * A server assigned to a connectivity agent is reached through that agent's
 * tunnel instead of a TCP connection to its host ({@link sshConnectConfig}
 * supplies the `sock`). The agent is untrusted transport: the handshake, and
 * this verification, still run end to end with the server's sshd.
 */

/** Why a connection was opened — recorded with TOFU and mismatch audit rows. */
export type HostKeyPurpose = 'terminal' | 'exec' | 'sftp' | 'health_check' | 'diagnostics' | 'host_key_scan';

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

/** What kind of row a pinned key belongs to; also the audit resource type. */
export type HostKeySubjectKind = 'server' | 'ftp_connection';

/** The host presented a different key than the pinned one; the handshake was refused. */
export class HostKeyMismatchError extends Error {
  readonly statusCode = 409;
  readonly code = 'HOST_KEY_MISMATCH';

  constructor(
    /** The row id — a server, or an FTP connection when `subject` says so. */
    readonly serverId: string,
    readonly expected: string,
    readonly presented: string,
    readonly presentedType: string | null,
    serverLabel = 'this server',
    readonly subject: HostKeySubjectKind = 'server',
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
      ...(this.subject === 'server'
        ? { serverId: this.serverId }
        : { ftpConnectionId: this.serverId }),
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

/** The columns the verifier reads, whichever table they come from. */
export interface HostKeySubject {
  id: string;
  orgId: string;
  name: string;
  host: string;
  port: number;
  hostKeyFingerprint: string | null;
  hostKeyType: string | null;
  /** Servers only: the connectivity agent the connection goes through, if any. */
  agentId?: string | null;
}

/**
 * Where pinned keys are kept. The decision logic is shared; each kind of SSH
 * endpoint supplies its own table. Every write is conditional so concurrent
 * handshakes cannot overwrite each other.
 */
export interface HostKeyStore {
  kind: HostKeySubjectKind;
  load(id: string): HostKeySubject | undefined;
  /** Pin a first-use key only while nothing is pinned. False when another connection won. */
  trustOnFirstUse(id: string, fingerprint: string, type: string | null, at: string): boolean;
  /** Record the key type of a pinned fingerprint that was entered without one. */
  fillType(id: string, fingerprint: string, type: string): void;
  /** Record a presented key unless it is the mismatch already on file. False when unchanged. */
  recordMismatch(id: string, fingerprint: string, type: string | null, at: string): boolean;
  /**
   * Raise an alert for a newly recorded mismatch, where this kind of endpoint
   * has alerts. `notify` is false while the same presented key was already
   * notified for this endpoint within {@link MISMATCH_NOTIFY_COOLDOWN_MS}: the
   * alert is still recorded, but the channels do not hear about it again.
   */
  alert?(subject: HostKeySubject, message: string, notify: boolean): void;
}

function loadServer(serverId: string): ServerRow | undefined {
  return getDb().select().from(servers).where(eq(servers.id, serverId)).get();
}

/** Pinned keys of managed servers, on the servers table. */
export const serverHostKeyStore: HostKeyStore = {
  kind: 'server',
  load: loadServer,
  trustOnFirstUse(id, fingerprint, type, at) {
    const result = getDb()
      .update(servers)
      .set({
        hostKeyFingerprint: fingerprint,
        hostKeyType: type,
        hostKeyTrustedAt: at,
        hostKeyTrustedBy: null,
      })
      .where(and(eq(servers.id, id), isNull(servers.hostKeyFingerprint)))
      .run();
    return result.changes > 0;
  },
  fillType(id, fingerprint, type) {
    getDb()
      .update(servers)
      .set({ hostKeyType: type })
      .where(and(eq(servers.id, id), eq(servers.hostKeyFingerprint, fingerprint)))
      .run();
  },
  recordMismatch(id, fingerprint, type, at) {
    const result = getDb()
      .update(servers)
      .set({
        hostKeyMismatchFingerprint: fingerprint,
        hostKeyMismatchType: type,
        hostKeyMismatchAt: at,
      })
      .where(
        and(
          eq(servers.id, id),
          or(
            isNull(servers.hostKeyMismatchFingerprint),
            ne(servers.hostKeyMismatchFingerprint, fingerprint),
          ),
        ),
      )
      .run();
    return result.changes > 0;
  },
  alert(subject, message, notify) {
    openHostKeyAlert(subject.orgId, subject.id, message, { notify });
  },
};

function mismatchMessage(expected: string, presented: string) {
  return `SSH host key changed: expected ${expected}, host presented ${presented}. Connections are refused until an admin reviews it.`;
}

/**
 * A host that alternates between keys (A, B, A, …) records each one as new
 * evidence, since it differs from the mismatch on file. Audit rows for the
 * same pinned key and presented key are capped at one per window; the ones
 * held back are counted and reported on the next row that is written.
 */
export const MISMATCH_AUDIT_WINDOW_MS = 10 * 60 * 1000;

/** A bound on the limiter's memory; old entries go first once it is reached. */
const MAX_TRACKED_MISMATCHES = 1000;

const mismatchAudits = new Map<string, { at: number; suppressed: number }>();

/**
 * Whether a mismatch audit row may be written now. Returns how many rows were
 * held back since the last one for this key, or null to hold this one back.
 * Per process: the API server and the worker each keep their own window.
 */
export function mismatchAuditAllowance(
  kind: HostKeySubjectKind,
  id: string,
  expected: string,
  presented: string,
  now = Date.now(),
): { suppressed: number } | null {
  const key = `${kind}:${id}:${expected}:${presented}`;
  const seen = mismatchAudits.get(key);
  if (seen && now - seen.at < MISMATCH_AUDIT_WINDOW_MS) {
    seen.suppressed++;
    return null;
  }

  if (!seen && mismatchAudits.size >= MAX_TRACKED_MISMATCHES) {
    for (const [k, v] of mismatchAudits) {
      if (now - v.at >= MISMATCH_AUDIT_WINDOW_MS) mismatchAudits.delete(k);
    }
    // Still full of live entries: drop the oldest-inserted
    if (mismatchAudits.size >= MAX_TRACKED_MISMATCHES) {
      mismatchAudits.delete(mismatchAudits.keys().next().value!);
    }
  }
  mismatchAudits.delete(key);
  mismatchAudits.set(key, { at: now, suppressed: 0 });
  return { suppressed: seen?.suppressed ?? 0 };
}

/**
 * Notifications for a host flapping between keys: at most one per endpoint and
 * presented key per hour, whatever the pinned key. Like the audit cap, per
 * process and bounded; the alert row and the mismatch on file are always kept
 * current — only the message to the channels is held back.
 */
export const MISMATCH_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

const mismatchNotifications = new Map<string, number>();

/** Whether a mismatch notification for this endpoint and presented key may go out now. */
export function mismatchNotifyAllowed(
  kind: HostKeySubjectKind,
  id: string,
  presented: string,
  now = Date.now(),
): boolean {
  const key = `${kind}:${id}:${presented}`;
  const last = mismatchNotifications.get(key);
  if (last !== undefined && now - last < MISMATCH_NOTIFY_COOLDOWN_MS) return false;

  if (last === undefined && mismatchNotifications.size >= MAX_TRACKED_MISMATCHES) {
    for (const [k, at] of mismatchNotifications) {
      if (now - at >= MISMATCH_NOTIFY_COOLDOWN_MS) mismatchNotifications.delete(k);
    }
    if (mismatchNotifications.size >= MAX_TRACKED_MISMATCHES) {
      mismatchNotifications.delete(mismatchNotifications.keys().next().value!);
    }
  }
  mismatchNotifications.delete(key);
  mismatchNotifications.set(key, now);
  return true;
}

export type HostKeyCheck = { ok: true } | { ok: false; error: Error };

/** The address a connection was actually opened to. */
export interface HostKeyEndpoint {
  host: string;
  port: number;
  /** The agent it went through (null = direct); omitted where agents do not apply. */
  agentId?: string | null;
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
  store: HostKeyStore = serverHostKeyStore,
): HostKeyCheck {
  const presented = hostKeyFingerprint(blob);
  const type = hostKeyType(blob);
  const kind = store.kind;

  // Two attempts: the second only runs when a concurrent connection pinned a
  // key between our read and our TOFU write.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = store.load(serverId);
    if (!row) {
      return {
        ok: false,
        error: new Error(`Host key could not be verified: ${kind === 'server' ? 'server' : 'connection'} not found`),
      };
    }
    if (
      endpoint &&
      (row.host !== endpoint.host ||
        row.port !== endpoint.port ||
        (endpoint.agentId !== undefined && (row.agentId ?? null) !== endpoint.agentId))
    ) {
      logger.warn(
        { serverId, kind, connectedTo: endpoint, current: { host: row.host, port: row.port }, purpose },
        'Server address changed while connecting — host key not checked, connection refused',
      );
      return {
        ok: false,
        error: new Error('Host key could not be verified: the server address changed while connecting. Retry.'),
      };
    }

    if (!row.hostKeyFingerprint) {
      if (!store.trustOnFirstUse(serverId, presented, type, new Date().toISOString())) continue;

      logger.info({ serverId, kind, fingerprint: presented, type, purpose }, 'Trusted SSH host key on first use');
      auditSystem(row.orgId, `${kind}.host_key_trusted`, kind, row.id, row.name, {
        method: 'tofu',
        fingerprint: presented,
        type,
        via: purpose,
      });
      return { ok: true };
    }

    if (row.hostKeyFingerprint === presented) {
      // A pre-pinned fingerprint carries no type; fill it in from the real key
      if (!row.hostKeyType && type) store.fillType(serverId, presented, type);
      return { ok: true };
    }

    const expected = row.hostKeyFingerprint;
    logger.warn(
      { serverId, kind, host: row.host, port: row.port, expected, presented, type, purpose },
      'SSH host key mismatch — connection refused',
    );

    // Only a new distinct key is recorded, audited and alerted; a host that
    // keeps presenting the same wrong key does not flood the log, and one that
    // alternates between keys is capped per key (see mismatchAuditAllowance).
    if (store.recordMismatch(serverId, presented, type, new Date().toISOString())) {
      const allowance = mismatchAuditAllowance(kind, row.id, expected, presented);
      if (allowance) {
        auditSystem(row.orgId, `${kind}.host_key_mismatch`, kind, row.id, row.name, {
          expected,
          presented,
          type,
          via: purpose,
          ...(allowance.suppressed > 0 && { suppressed: allowance.suppressed }),
        });
      }
      try {
        store.alert?.(row, mismatchMessage(expected, presented), mismatchNotifyAllowed(kind, row.id, presented));
      } catch (err) {
        logger.error({ err, serverId }, 'Failed to raise host key alert');
      }
    }

    return {
      ok: false,
      error: new HostKeyMismatchError(
        row.id,
        expected,
        presented,
        type,
        `${row.name} (${row.host}:${row.port})`,
        kind,
      ),
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
  store: HostKeyStore = serverHostKeyStore,
): HostKeyGuard {
  let refusal: Error | undefined;
  return {
    hostVerifier: (key: Buffer) => {
      let check: HostKeyCheck;
      try {
        check = checkHostKey(serverId, key, purpose, endpoint, store);
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
function preferPinnedKeyType(row: HostKeySubject | undefined): ConnectConfig['algorithms'] | undefined {
  try {
    if (!row?.hostKeyFingerprint) return undefined;
    return preferKeyType(row.hostKeyType);
  } catch {
    return undefined;
  }
}

/** ssh2 `algorithms` that ask for a host key of `type` first; undefined when it cannot be preferred. */
export function preferKeyType(type: string | null | undefined): ConnectConfig['algorithms'] | undefined {
  // Only types ssh2 can negotiate; anything else would make connect() throw
  if (!type || !PREFERABLE_KEY_TYPES.has(type)) return undefined;
  const algorithms = algorithmsForKeyType(type);
  // Remove, then prepend: ssh2 skips a prepend already present in the list
  return { serverHostKey: { remove: algorithms, prepend: algorithms } } as ConnectConfig['algorithms'];
}

/**
 * The socket for a server reached through a connectivity agent: a tunnel to
 * `port` on the agent's own loopback. Undefined for a direct connection.
 */
export function agentSocketFor(
  row: { orgId: string; agentId?: string | null } | undefined,
  port: number,
): Duplex | undefined {
  return row?.agentId ? openAgentTunnel({ orgId: row.orgId, agentId: row.agentId }, port) : undefined;
}

/**
 * The one way to build ssh2 connect options for a managed server: target,
 * credentials and a host key verifier bound to that server. Callers wire
 * `guard.error` into their `'error'` handler so a refused key surfaces as a
 * {@link HostKeyMismatchError} rather than ssh2's generic handshake error, and
 * connect with `connectSsh` (ssh/jump.ts), which routes through the server's
 * jump hosts when it has any.
 *
 * A server assigned to an agent gets the agent tunnel as `sock`, whatever the
 * caller passed: which route a connection takes is the server row's decision.
 * (A server has an agent or a jump host, never both; a jump host reached over
 * an agent is the first hop, so its agent tunnel carries the whole chain.)
 */
export function sshConnectConfig(
  target: SshTarget,
  auth: SshAuth,
  purpose: HostKeyPurpose,
  extra: Omit<ConnectConfig, 'host' | 'port' | 'username' | 'hostVerifier' | 'hostHash'> = {},
  store: HostKeyStore = serverHostKeyStore,
): { config: ConnectConfig; guard: HostKeyGuard } {
  // Not caught: without the row we cannot tell whether this server must go
  // through an agent, and connecting straight to its host could be wrong.
  const row = store.load(target.id);
  const agentId = store.kind === 'server' ? (row?.agentId ?? null) : undefined;
  const guard = hostKeyGuard(target.id, purpose, { host: target.host, port: target.port, agentId }, store);
  // The verifier must see the raw key blob: a caller-supplied hostHash would
  // make ssh2 hand it a hex digest instead, which never equals a fingerprint.
  const { hostHash: _ignored, sock: callerSock, ...rest } = extra as ConnectConfig;
  const algorithms = rest.algorithms ?? preferPinnedKeyType(row);
  const sock = agentId && row ? agentSocketFor(row, target.port) : callerSock;
  return {
    guard,
    config: {
      ...rest,
      ...(algorithms && { algorithms }),
      ...(sock && { sock }),
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
 * Nothing is stored. `sock` is a channel already opened to host:port through a
 * jump host (see `scanServerHostKey` in ssh/jump.ts) or an agent tunnel.
 */
export function scanHostKey(
  host: string,
  port: number,
  timeoutMs = SCAN_TIMEOUT_MS,
  /** Ask for this key type first, as a real connection to a pinned host does. */
  preferType?: string | null,
  /** A jump host channel or agent tunnel to scan through instead of connecting to host:port. */
  sock?: Duplex,
): Promise<HostKeyScanResult> {
  const algorithms = preferKeyType(preferType);
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
      ...(sock && { sock: sock as NonNullable<ConnectConfig['sock']> }),
      // Never used: the handshake is abandoned before user authentication
      username: 'smt-host-key-scan',
      readyTimeout: timeoutMs,
      ...(algorithms && { algorithms }),
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
